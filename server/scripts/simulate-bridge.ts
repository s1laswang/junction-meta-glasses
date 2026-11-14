import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Session } from "@google/genai";
import WebSocket from "ws";
import type { DeviceState, ServerMsg } from "../../shared/types.ts";
import { env, REPO_ROOT, SERVER_DIR } from "../src/env.ts";
import { ai } from "../src/gemini.ts";
import { getHub, latestHub, resetHubsForTest } from "../src/hub.ts";
import { startServer } from "../src/index.ts";
import { emptyProfile } from "../src/verify.ts";

type BridgeStatePayload = {
  connected: boolean;
  worn: boolean;
  battery: number | null;
  streaming: boolean;
};

function buildIngestUrl(baseUrl: string, endpoint: "/ingest/frame" | "/ingest/state", session?: string): string {
  const cleanBase = baseUrl.trim().replace(/\/+$/, "");
  if (!session) return `${cleanBase}${endpoint}`;
  return `${cleanBase}${endpoint}?session=${encodeURIComponent(session)}`;
}

async function postBridgeState(baseUrl: string, state: BridgeStatePayload, session?: string): Promise<number> {
  const res = await fetch(buildIngestUrl(baseUrl, "/ingest/state", session), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(state),
  });
  return res.status;
}

async function postBridgeFrame(baseUrl: string, jpeg: Buffer, session?: string): Promise<number> {
  const res = await fetch(buildIngestUrl(baseUrl, "/ingest/frame", session), {
    method: "POST",
    headers: { "content-type": "image/jpeg" },
    body: new Uint8Array(jpeg),
  });
  return res.status;
}

function resolveFixturePath(spec?: string): string {
  if (!spec) return path.join(SERVER_DIR, "fixtures", "amlodipine.jpg");
  if (fs.existsSync(spec)) return path.resolve(spec);
  const name = spec.endsWith(".jpg") ? spec : `${spec}.jpg`;
  const candidates = [
    path.join(SERVER_DIR, "fixtures", name),
    path.join(REPO_ROOT, "web", "public", "fixtures", name),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Fixture not found: ${spec}`);
}

function openTrackedWs(url: string) {
  const ws = new WebSocket(url);
  const messages: ServerMsg[] = [];
  const listeners = new Set<() => void>();

  ws.on("message", (raw) => {
    const parsed = JSON.parse(raw.toString()) as ServerMsg;
    messages.push(parsed);
    for (const notify of listeners) notify();
  });

  const ready = new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });

  const waitFor = (predicate: (msgs: ServerMsg[]) => boolean, label: string, timeoutMs = 3000): Promise<void> => {
    if (predicate(messages)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(new Error(`Timed out waiting for ${label} on ${url} (received ${messages.length} msgs)`));
      }, timeoutMs);
      const check = () => {
        if (predicate(messages)) {
          clearTimeout(timer);
          listeners.delete(check);
          resolve();
        }
      };
      listeners.add(check);
    });
  };

  const close = () =>
    new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      ws.once("close", () => resolve());
      ws.close();
    });

  return { ws, messages, ready, waitFor, close };
}

async function runSelfTest(): Promise<void> {
  const t0 = Date.now();
  process.env.HOLDUP_QUIET = "1";
  const prevApiKey = env.apiKey;
  const prevLedgerPath = env.ledgerPath;
  const tempLedgerPath = path.join(os.tmpdir(), `holdup-sim-bridge-${process.pid}-${Date.now()}.jsonl`);
  const origLiveConnect = ai.live.connect.bind(ai.live);
  const realtimeVideoFrames: string[] = [];

  env.apiKey = "";
  env.ledgerPath = tempLedgerPath;
  resetHubsForTest();

  (ai.live as { connect: typeof ai.live.connect }).connect = (async () => {
    const mockSession = {
      close() {},
      sendToolResponse() {},
      sendClientContent() {},
      sendRealtimeInput(input: { video?: { data?: string } }) {
        if (input?.video?.data) realtimeVideoFrames.push(input.video.data);
      },
    };
    return mockSession as unknown as Session;
  }) as typeof ai.live.connect;

  const fixturePath = path.join(SERVER_DIR, "fixtures", "amlodipine.jpg");
  const jpegBuf = fs.readFileSync(fixturePath);
  assert.ok(jpegBuf.length >= 100, "amlodipine.jpg must be at least 100 bytes");
  const expectedBase64 = jpegBuf.toString("base64");

  const server = await startServer(0);
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsBase = `ws://127.0.0.1:${port}`;

  const live = openTrackedWs(`${wsBase}/live?session=sim`);
  const hud = openTrackedWs(`${wsBase}/hud-ws`);

  try {
    await Promise.all([live.ready, hud.ready]);
    live.ws.send(
      JSON.stringify({
        type: "start",
        profile: emptyProfile(),
        lang: "en",
        voice: false,
        source: "phone",
      }),
    );

    await Promise.all([
      live.waitFor((msgs) => msgs.some((m) => m.type === "ready"), "live ready message"),
      hud.waitFor((msgs) => msgs.some((m) => m.type === "status" && m.live === "open"), "hud open status"),
    ]);

    const readyMsg = live.messages.find((m): m is Extract<ServerMsg, { type: "ready" }> => m.type === "ready");
    assert.ok(readyMsg, "expected ready message with resolved session id");
    const hub = latestHub();
    assert.ok(hub, "expected latestHub() to be active");
    assert.equal(getHub(readyMsg.session), hub, "ready session id must match latestHub()");

    const glassesDevices = (msgs: ServerMsg[]): DeviceState[] =>
      msgs
        .filter((m): m is Extract<ServerMsg, { type: "device" }> => m.type === "device" && m.device.source === "glasses")
        .map((m) => m.device);

    const expectedDevices: DeviceState[] = [];
    const expectDeviceTransition = async (payload: BridgeStatePayload, label: string) => {
      const status = await postBridgeState(baseUrl, payload);
      assert.equal(status, 204, `expected 204 on /ingest/state (${label})`);
      const expected: DeviceState = { ...payload, source: "glasses" };
      expectedDevices.push(expected);
      const count = expectedDevices.length;
      await Promise.all([
        live.waitFor((msgs) => glassesDevices(msgs).length >= count, `live device #${count} (${label})`),
        hud.waitFor((msgs) => glassesDevices(msgs).length >= count, `hud device #${count} (${label})`),
      ]);
    };

    await expectDeviceTransition(
      { connected: true, worn: true, battery: 84, streaming: true },
      "connected+worn+battery:84+streaming:true",
    );

    for (let i = 0; i < 3; i++) {
      const frameStatus = await postBridgeFrame(baseUrl, jpegBuf);
      assert.equal(frameStatus, 204, `expected 204 on /ingest/frame #${i + 1}`);
    }

    assert.equal(hub.ring.length, 3, "expected 3 frames in hub.ring");
    assert.ok(realtimeVideoFrames.length >= 1, "expected at least 1 throttled video frame forwarded to LiveProxy");
    const storedFrames = hub.ring.pick(3, 60_000);
    assert.equal(storedFrames.length, 3, "expected 3 picked frames from hub.ring");
    for (const frame of storedFrames) {
      assert.equal(frame.source, "glasses", "stored frame must have source === glasses");
      assert.equal(frame.bytes, jpegBuf.length, "stored frame bytes must match fixture");
      assert.equal(frame.data, expectedBase64, "stored frame base64 must match fixture");
      assert.ok(frame.sharpness > 0 && frame.sharpness <= 1, "stored frame sharpness must be in (0, 1]");
    }

    await expectDeviceTransition(
      { connected: true, worn: false, battery: 84, streaming: true },
      "worn:false doff",
    );

    await expectDeviceTransition(
      { connected: true, worn: true, battery: 9, streaming: true },
      "battery:9 low battery",
    );

    await expectDeviceTransition(
      { connected: false, worn: false, battery: 9, streaming: false },
      "streaming:false disconnect",
    );

    assert.deepEqual(glassesDevices(live.messages), expectedDevices, "/live device transitions mismatch");
    assert.deepEqual(glassesDevices(hud.messages), expectedDevices, "/hud-ws device transitions mismatch");
    assert.deepEqual(hub.device, expectedDevices.at(-1), "hub.device final state mismatch");

    await Promise.all([live.close(), hud.close()]);

    for (let i = 0; i < 40 && hub.clients.size > 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(hub.ring.length, 0, "hub.ring must clear on client disconnect");
  } finally {
    await Promise.allSettled([live.close(), hud.close()]);
    resetHubsForTest();
    (ai.live as { connect: typeof ai.live.connect }).connect = origLiveConnect;
    env.apiKey = prevApiKey;
    env.ledgerPath = prevLedgerPath;
    fs.rmSync(tempLedgerPath, { force: true });
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log(`PASS simulate-bridge --self-test: 4 device transitions, 3 glasses frames verified (${Date.now() - t0} ms)`);
}

type CliOptions = {
  selfTest: boolean;
  help: boolean;
  baseUrl: string;
  session?: string;
  fixture?: string;
  fps: number;
  maxFrames: number;
};

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    selfTest: false,
    help: false,
    baseUrl: "http://localhost:8787",
    fps: 1,
    maxFrames: 0,
  };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--self-test") {
      opts.selfTest = true;
    } else if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--fixture" && argv[i + 1]) {
      opts.fixture = argv[++i];
    } else if (arg === "--fps" && argv[i + 1]) {
      opts.fps = Math.max(0.1, Math.min(2, Number(argv[++i]) || 1));
    } else if (arg === "--frames" && argv[i + 1]) {
      opts.maxFrames = Math.max(1, Math.floor(Number(argv[++i]) || 0));
    } else if (!arg.startsWith("-")) {
      positionals.push(arg);
    }
  }
  if (positionals[0]) opts.baseUrl = positionals[0];
  if (positionals[1]) opts.session = positionals[1];
  return opts;
}

async function runLiveSimulator(opts: CliOptions): Promise<void> {
  const fixturePath = resolveFixturePath(opts.fixture);
  const jpegBuf = fs.readFileSync(fixturePath);
  const intervalMs = Math.round(1000 / opts.fps);
  let battery = 84;
  const worn = true;
  let sent = 0;
  let stopping = false;

  console.log(
    `HoldUp Bridge simulator -> ${opts.baseUrl} (session=${opts.session ?? "latest"}, fixture=${path.basename(fixturePath)}, fps=${opts.fps})`,
  );

  const initialStatus = await postBridgeState(
    opts.baseUrl,
    { connected: true, worn, battery, streaming: true },
    opts.session,
  );
  console.log(`[bridge] state connected=true worn=${worn} battery=${battery}% streaming=true -> HTTP ${initialStatus}`);

  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    try {
      const code = await postBridgeState(
        opts.baseUrl,
        { connected: false, worn: false, battery, streaming: false },
        opts.session,
      );
      console.log(`[bridge] disconnected -> HTTP ${code} (frames sent: ${sent})`);
    } catch (err) {
      console.error(`[bridge] disconnect state failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  process.once("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });

  while (!stopping) {
    const tStart = Date.now();
    const frameStatus = await postBridgeFrame(opts.baseUrl, jpegBuf, opts.session);
    sent++;
    if (sent % 30 === 0 && battery > 20) {
      battery--;
      await postBridgeState(
        opts.baseUrl,
        { connected: true, worn, battery, streaming: true },
        opts.session,
      );
    }
    console.log(`[bridge] frame #${sent} (${jpegBuf.length} B) -> HTTP ${frameStatus} | battery=${battery}% worn=${worn}`);
    if (opts.maxFrames > 0 && sent >= opts.maxFrames) {
      await shutdown();
      return;
    }
    const elapsed = Date.now() - tStart;
    const waitMs = Math.max(0, intervalMs - elapsed);
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log("Usage:");
    console.log("  npx tsx server/scripts/simulate-bridge.ts --self-test");
    console.log("  npx tsx server/scripts/simulate-bridge.ts [http://localhost:8787] [session] [--fixture amlodipine] [--fps 1] [--frames N]");
    return;
  }
  if (opts.selfTest) {
    await runSelfTest();
    return;
  }
  await runLiveSimulator(opts);
}

main().catch((err) => {
  console.error("FAIL simulate-bridge:", err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
