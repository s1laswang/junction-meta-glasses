import fs from "node:fs";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { LiveConnectParameters, LiveServerMessage, Session } from "@google/genai";
import WebSocket from "ws";
import type { Profile, ServerMsg, Verdict } from "../../shared/types.ts";
import { env, SERVER_DIR } from "../src/env.ts";
import { ai } from "../src/gemini.ts";
import {
  MAX_HUBS,
  addHud,
  getHub,
  getOrCreateHub,
  hubRetentionSnapshot,
  hubStats,
  latestHub,
  markLatest,
  resetHubsForTest,
  safeSend,
  sweepIdleHubs,
} from "../src/hub.ts";
import { startServer } from "../src/index.ts";

process.env.HOLDUP_QUIET = "1";

const SLASH = String.fromCharCode(47);
const DOUBLE_SLASH = SLASH + SLASH;

const INGREDIENTS = [
  "amlodipine",
  "metformin",
  "bisoprolol",
  "ramipril",
  "omeprazole",
  "pantoprazole",
  "cetirizine",
  "loratadine",
  "salbutamol",
  "clopidogrel",
  "furosemide",
  "candesartan",
  "losartan",
  "valsartan",
  "sertraline",
  "escitalopram",
  "melatonin",
  "amoxicillin",
  "doxycycline",
  "atenolol",
] as const;

interface MockLivePeer {
  sessionId: string;
  callbacks: LiveConnectParameters["callbacks"];
  toolResponses: Array<Record<string, unknown>>;
  closedCount: number;
  session: Session;
}

interface ParsedFrameTag {
  session: string;
  frame: number;
  ingredient: string;
  strength: string;
}

const tempLedger = path.join(os.tmpdir(), `holdup-memory-soak-${process.pid}.jsonl`);
const origLiveConnect = ai.live.connect.bind(ai.live);
const origGenerateContent = ai.models.generateContent.bind(ai.models);
const origModelsGet = ai.models.get.bind(ai.models);

let prevApiKey = "";
let prevLedger = "";
let server: http.Server | null = null;
let port = 0;
let baseUrl = "";
let wsBase = "";
let trackedSockets: WebSocket[] = [];
let mockLivePeers = new Map<string, MockLivePeer>();
let seenVerifyFrames: Array<{ frames: ParsedFrameTag[] }> = [];

function makeTaggedJpeg(tag: ParsedFrameTag, extraPaddingBytes = 0): Buffer {
  const header = `TAG|${tag.session}|${tag.frame}|${tag.ingredient}|${tag.strength}|END`;
  const headerBuf = Buffer.from(header, "utf8");
  const rawMin = Math.max(270, 12 + headerBuf.length + extraPaddingBytes);
  const byteLen = rawMin + ((3 - (rawMin % 3)) % 3);
  const buf = Buffer.alloc(byteLen, 0x5a);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  buf[2] = 0xff;
  buf[3] = 0xfe;
  const commentLen = headerBuf.length + 2;
  buf.writeUInt16BE(commentLen, 4);
  headerBuf.copy(buf, 6);
  buf[byteLen - 2] = 0xff;
  buf[byteLen - 1] = 0xd9;
  return buf;
}

function parseTaggedBase64(b64: string): ParsedFrameTag {
  const text = Buffer.from(b64, "base64").toString("utf8");
  const start = text.indexOf("TAG|");
  const end = text.indexOf("|END", start);
  assert.ok(start !== -1 && end !== -1, "Expected synthetic JPEG frame tag");
  const parts = text.slice(start + 4, end).split("|");
  return {
    session: parts[0] ?? "",
    frame: Number(parts[1] ?? -1),
    ingredient: parts[2] ?? "",
    strength: parts[3] ?? "",
  };
}

function makeSessionProfile(idx: number): Profile {
  const ing = INGREDIENTS[idx % INGREDIENTS.length];
  const strength = `${(idx + 1) * 5} mg`;
  return {
    meds: [
      {
        id: `med-${idx}`,
        name: ing,
        ingredient: ing,
        strength,
        schedule: ["evening"],
      },
    ],
    allergies: [],
    avoid: [],
    doseLog: [],
    lang: "en",
  };
}

function extractSessionIdFromPrompt(sysInstruction: string): string {
  const match = new RegExp('medId "med-(\\d+)"').exec(sysInstruction);
  if (!match) return "";
  const idx = Number(match[1]);
  return `soak-s-${String(idx).padStart(2, "0")}`;
}

function liveMsg(partial: Partial<LiveServerMessage>): LiveServerMessage {
  return { text: undefined, data: undefined, ...partial };
}

function waitFor(predicate: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for: ${label}`));
      }
    }, 5);
  });
}

async function openTrackedWs(url: string) {
  const ws = new WebSocket(url);
  trackedSockets.push(ws);
  const messages: ServerMsg[] = [];
  const pongWaiters = new Map<number, () => void>();

  ws.on("message", (raw) => {
    const parsed = JSON.parse(raw.toString("utf8")) as ServerMsg;
    messages.push(parsed);
    if (parsed.type === "pong") {
      const cb = pongWaiters.get(parsed.t);
      if (cb) {
        pongWaiters.delete(parsed.t);
        cb();
      }
    }
  });
  ws.on("error", () => {});

  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });

  const ping = (token: number) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        pongWaiters.delete(token);
        reject(new Error(`Timed out waiting for pong ${token}`));
      }, 3000);
      pongWaiters.set(token, () => {
        clearTimeout(timer);
        resolve();
      });
      ws.send(JSON.stringify({ type: "ping", t: token }));
    });

  const close = () =>
    new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      const killTimer = setTimeout(() => {
        try {
          ws.terminate();
        } catch {}
        resolve();
      }, 400);
      ws.once("close", () => {
        clearTimeout(killTimer);
        resolve();
      });
      try {
        ws.close();
      } catch {
        clearTimeout(killTimer);
        resolve();
      }
    });

  return { ws, messages, ping, close };
}

async function postIngestFrame(sessionId: string, jpg: Buffer, sharpness: number): Promise<void> {
  const qs = new URLSearchParams({
    session: sessionId,
    sharpness: String(sharpness),
  });
  const res = await fetch(`${baseUrl}${SLASH}ingest${SLASH}frame?${qs.toString()}`, {
    method: "POST",
    headers: { "content-type": `image${SLASH}jpeg` },
    body: new Uint8Array(jpg),
  });
  assert.equal(res.status, 204);
}

before(() => {
  process.env.HOLDUP_QUIET = "1";
  prevApiKey = env.apiKey;
  env.apiKey = "";
  prevLedger = env.ledgerPath;
  env.ledgerPath = tempLedger;
});

beforeEach(async () => {
  resetHubsForTest();
  trackedSockets = [];
  mockLivePeers = new Map();
  seenVerifyFrames = [];

  (ai.models as unknown as { get: unknown }).get = async () => {
    throw new Error("Gemini models.get disabled in memory soak test");
  };

  (ai.live as unknown as { connect: unknown }).connect = async (params: LiveConnectParameters) => {
    const sys = String(params.config?.systemInstruction ?? "");
    const sid = extractSessionIdFromPrompt(sys) || `peer-${mockLivePeers.size}`;
    const peer: MockLivePeer = {
      sessionId: sid,
      callbacks: params.callbacks,
      toolResponses: [],
      closedCount: 0,
      session: null as unknown as Session,
    };
    peer.session = {
      sendRealtimeInput() {},
      sendToolResponse(resp: Record<string, unknown>) {
        peer.toolResponses.push(resp);
      },
      close() {
        peer.closedCount += 1;
      },
    } as unknown as Session;
    mockLivePeers.set(sid, peer);
    return peer.session;
  };

  (ai.models as unknown as { generateContent: unknown }).generateContent = async (params: {
    contents?: Array<{ parts?: Array<{ inlineData?: { data?: string }; text?: string }> }>;
  }) => {
    const parts = params?.contents?.[0]?.parts ?? [];
    const frameTags = parts
      .filter((p) => typeof p.inlineData?.data === "string")
      .map((p) => parseTaggedBase64(String(p.inlineData?.data)));
    seenVerifyFrames.push({ frames: frameTags });
    const top = frameTags[0];
    assert.ok(top, "Expected at least one frame passed to generateContent");
    return {
      text: JSON.stringify({
        kind: "medication",
        product: { value: top.ingredient, confidence: 0.98 },
        ingredient: { value: top.ingredient, confidence: 0.98 },
        strength: { value: top.strength, confidence: 0.97 },
        dosing: { value: "1 tablet each evening", confidence: 0.92 },
        expiry: { value: "2028-09", confidence: 0.95 },
        allergens: { value: [], confidence: 0.94 },
        barcode: { value: null, confidence: 0 },
        readability: 0.96,
      }),
    };
  };

  server = await startServer(0);
  port = (server.address() as AddressInfo).port;
  baseUrl = `http:${DOUBLE_SLASH}127.0.0.1:${port}`;
  wsBase = `ws:${DOUBLE_SLASH}127.0.0.1:${port}`;
});

afterEach(async () => {
  await Promise.all(
    trackedSockets.map(
      (ws) =>
        new Promise<void>((resolve) => {
          if (ws.readyState === WebSocket.CLOSED) {
            resolve();
            return;
          }
          const timer = setTimeout(() => {
            try {
              ws.terminate();
            } catch {}
            resolve();
          }, 300);
          ws.once("close", () => {
            clearTimeout(timer);
            resolve();
          });
          try {
            ws.close();
          } catch {
            clearTimeout(timer);
            resolve();
          }
        }),
    ),
  );
  resetHubsForTest();
  if (server) {
    const active = server;
    server = null;
    active.closeAllConnections();
    await new Promise<void>((resolve) => active.close(() => resolve()));
  }
  (ai.live as unknown as { connect: typeof origLiveConnect }).connect = origLiveConnect;
  (ai.models as unknown as { generateContent: typeof origGenerateContent }).generateContent =
    origGenerateContent;
  (ai.models as unknown as { get: typeof origModelsGet }).get = origModelsGet;
});

after(() => {
  env.apiKey = prevApiKey;
  env.ledgerPath = prevLedger;
  try {
    fs.rmSync(tempLedger, { force: true });
  } catch {}
});

test("500-frame high-throughput soak across 20 concurrent /live + /ingest/frame sessions enforces FrameRing(8) cap, sharpest-wins selection, and zero cross-session frame or verdict leakage", async () => {
  const SESSION_COUNT = 20;
  const FRAMES_PER_SESSION = 25;
  const TOTAL_FRAMES = SESSION_COUNT * FRAMES_PER_SESSION;
  assert.equal(TOTAL_FRAMES, 500);

  const floatingHud = await openTrackedWs(`${wsBase}${SLASH}hud-ws`);
  const sessions = await Promise.all(
    Array.from({ length: SESSION_COUNT }, async (_, s) => {
      const sessionId = `soak-s-${String(s).padStart(2, "0")}`;
      const profile = makeSessionProfile(s);
      const liveWs = await openTrackedWs(`${wsBase}${SLASH}live?session=${sessionId}`);
      const hudWs = await openTrackedWs(`${wsBase}${SLASH}hud-ws?session=${sessionId}`);
      liveWs.ws.send(
        JSON.stringify({
          type: "start",
          profile,
          lang: "en",
          voice: true,
          source: "glasses",
        }),
      );
      return { idx: s, sessionId, profile, liveWs, hudWs };
    }),
  );

  await waitFor(
    () =>
      sessions.every((s) =>
        s.liveWs.messages.some((m) => m.type === "status" && m.live === "open"),
      ) && mockLivePeers.size === SESSION_COUNT,
    "all 20 /live sessions open",
  );

  const preStormSnap = hubRetentionSnapshot();
  assert.deepEqual(
    Object.keys(preStormSnap).sort(),
    [
      "activeClients",
      "activeHuds",
      "bufferedFrameBytes",
      "bufferedFramesTotal",
      "floatingHuds",
      "sessions",
    ],
  );
  assert.deepEqual(preStormSnap, {
    sessions: 20,
    activeClients: 20,
    activeHuds: 20,
    floatingHuds: 1,
    bufferedFramesTotal: 0,
    bufferedFrameBytes: 0,
  });
  assert.equal(JSON.stringify(preStormSnap).includes("soak-s-"), false);

  let ingestedFramesCount = 0;
  let totalSentFrameBytes = 0;
  let expectedRetainedBytes = 0;
  let maxObservedBufferedFrames = 0;

  await Promise.all(
    sessions.map(async ({ idx, sessionId, liveWs }) => {
      const ing = INGREDIENTS[idx];
      const strength = `${(idx + 1) * 5} mg`;

      for (let f = 0; f < FRAMES_PER_SESSION; f++) {
        const buf = makeTaggedJpeg(
          { session: sessionId, frame: f, ingredient: ing, strength },
          idx * 9 + f * 3,
        );
        const sharpness =
          f === 20
            ? 0.98
            : f === 21
              ? 0.93
              : Number((0.18 + ((f * 7 + idx) % 35) * 0.01).toFixed(2));

        const useHttpIngest = f % 2 === 0;
        if (useHttpIngest) {
          await postIngestFrame(sessionId, buf, sharpness);
          totalSentFrameBytes += buf.length;
          if (f >= FRAMES_PER_SESSION - 8) {
            expectedRetainedBytes += buf.length;
          }
        } else {
          const b64 = buf.toString("base64");
          liveWs.ws.send(JSON.stringify({ type: "frame", data: b64, sharpness }));
          await liveWs.ping(idx * 1000 + f);
          const wsBytes = Math.round(b64.length * 0.75);
          totalSentFrameBytes += wsBytes;
          if (f >= FRAMES_PER_SESSION - 8) {
            expectedRetainedBytes += wsBytes;
          }
        }

        ingestedFramesCount += 1;
        const hub = getHub(sessionId);
        assert.ok(hub);
        assert.ok(
          hub.ring.length <= 8,
          `Session ${sessionId} exceeded FrameRing(8): ${hub.ring.length}`,
        );
        const snapMid = hubRetentionSnapshot();
        if (snapMid.bufferedFramesTotal > maxObservedBufferedFrames) {
          maxObservedBufferedFrames = snapMid.bufferedFramesTotal;
        }
        assert.ok(
          snapMid.bufferedFramesTotal <= 160,
          `Total buffered frames exceeded 160 during storm: ${snapMid.bufferedFramesTotal}`,
        );
      }
    }),
  );

  assert.equal(ingestedFramesCount, 500);
  assert.equal(maxObservedBufferedFrames, 160);

  const postStormSnap = hubRetentionSnapshot();
  assert.equal(postStormSnap.sessions, 20);
  assert.equal(postStormSnap.activeClients, 20);
  assert.equal(postStormSnap.activeHuds, 20);
  assert.equal(postStormSnap.floatingHuds, 1);
  assert.equal(postStormSnap.bufferedFramesTotal, 160);
  assert.equal(postStormSnap.bufferedFrameBytes, expectedRetainedBytes);
  assert.ok(postStormSnap.bufferedFrameBytes > 0);
  assert.ok(postStormSnap.bufferedFrameBytes < totalSentFrameBytes * 0.4);
  assert.equal(JSON.stringify(postStormSnap).includes("TAG|"), false);

  for (const { idx, sessionId } of sessions) {
    const hub = getHub(sessionId);
    assert.ok(hub);
    assert.equal(hub.ring.length, 8);

    const allInRing = hub.ring.pick(8, 60_000);
    assert.equal(allInRing.length, 8);
    for (const entry of allInRing) {
      const parsed = parseTaggedBase64(entry.data);
      assert.equal(parsed.session, sessionId);
      assert.equal(parsed.ingredient, INGREDIENTS[idx]);
      assert.ok(parsed.frame >= 17 && parsed.frame <= 24);
    }

    const topTwo = hub.ring.pick(2, 60_000);
    assert.equal(topTwo.length, 2);
    assert.equal(topTwo[0].sharpness, 0.98);
    assert.equal(topTwo[0].source, "glasses");
    assert.equal(parseTaggedBase64(topTwo[0].data).frame, 20);
    assert.equal(topTwo[1].sharpness, 0.93);
    assert.equal(topTwo[1].source, "phone");
    assert.equal(parseTaggedBase64(topTwo[1].data).frame, 21);
  }

  for (const { idx, sessionId } of sessions) {
    const peer = mockLivePeers.get(sessionId);
    assert.ok(peer, `Expected mock live peer for ${sessionId}`);
    peer.callbacks.onmessage?.(
      liveMsg({
        toolCall: {
          functionCalls: [
            {
              id: `vc-${idx}`,
              name: "verify_label",
              args: { question: `Check evening medication ${idx}` },
            },
          ],
        },
      }),
    );
  }

  await waitFor(
    () =>
      sessions.every(
        (s) =>
          s.liveWs.messages.some((m) => m.type === "verdict") &&
          s.hudWs.messages.some((m) => m.type === "verdict"),
      ),
    "all 20 concurrent verify_label verdicts fanned out",
  );

  assert.equal(seenVerifyFrames.length, 20);
  for (const call of seenVerifyFrames) {
    assert.equal(call.frames.length, 2);
    assert.equal(call.frames[0].session, call.frames[1].session);
    assert.equal(call.frames[0].frame, 20);
    assert.equal(call.frames[1].frame, 21);
  }

  for (const { idx, liveWs, hudWs } of sessions) {
    const expectedMedId = `med-${idx}`;
    const expectedIng = INGREDIENTS[idx];
    const liveVerdicts = liveWs.messages.filter(
      (m): m is Extract<ServerMsg, { type: "verdict" }> => m.type === "verdict",
    );
    const hudVerdicts = hudWs.messages.filter(
      (m): m is Extract<ServerMsg, { type: "verdict" }> => m.type === "verdict",
    );
    assert.equal(liveVerdicts.length, 1);
    assert.equal(hudVerdicts.length, 1);
    assert.equal(liveVerdicts[0].verdict.level, "match");
    assert.equal(liveVerdicts[0].verdict.matchedMedId, expectedMedId);
    assert.equal(liveVerdicts[0].verdict.read.ingredient.value, expectedIng);
    assert.equal(hudVerdicts[0].verdict.matchedMedId, expectedMedId);
    assert.equal(hudVerdicts[0].verdict.read.ingredient.value, expectedIng);
  }

  await floatingHud.close();
  await Promise.all(sessions.flatMap((s) => [s.liveWs.close(), s.hudWs.close()]));

  await waitFor(
    () => {
      const snap = hubRetentionSnapshot();
      return snap.activeClients === 0 && snap.activeHuds === 0 && snap.floatingHuds === 0;
    },
    "all 20 soak sessions disconnected",
  );

  const afterCloseSnap = hubRetentionSnapshot();
  assert.equal(afterCloseSnap.bufferedFramesTotal, 0);
  assert.equal(afterCloseSnap.bufferedFrameBytes, 0);
});

test("immediate post-disconnect zero-retention wipe zeroes bufferedFramesTotal and bufferedFrameBytes as soon as the last /live client disconnects", async () => {
  const SESSION_COUNT = 10;
  const fixtureJpg = fs.readFileSync(path.join(SERVER_DIR, "fixtures", "amlodipine.jpg"));
  const fixtureBase64 = fixtureJpg.toString("base64");

  const bundles = await Promise.all(
    Array.from({ length: SESSION_COUNT }, async (_, i) => {
      const sessionId = `wipe-s-${String(i).padStart(2, "0")}`;
      const primary = await openTrackedWs(`${wsBase}${SLASH}live?session=${sessionId}`);
      const secondary =
        i < 4 ? await openTrackedWs(`${wsBase}${SLASH}live?session=${sessionId}`) : null;
      await postIngestFrame(sessionId, fixtureJpg, 0.88);
      primary.ws.send(JSON.stringify({ type: "frame", data: fixtureBase64, sharpness: 0.74 }));
      await primary.ping(500 + i);
      return { sessionId, primary, secondary };
    }),
  );

  const activeSnap = hubRetentionSnapshot();
  assert.equal(activeSnap.sessions, 10);
  assert.equal(activeSnap.activeClients, 14);
  assert.equal(activeSnap.bufferedFramesTotal, 20);
  assert.ok(activeSnap.bufferedFrameBytes >= 20 * (fixtureJpg.length - 4));

  await Promise.all(bundles.slice(0, 4).map((b) => b.primary.close()));
  await waitFor(() => hubRetentionSnapshot().activeClients === 10, "primary sockets on 0..3 closed");

  const partialSnap = hubRetentionSnapshot();
  assert.equal(partialSnap.bufferedFramesTotal, 20);
  assert.ok(partialSnap.bufferedFrameBytes > 0);

  await Promise.all(
    bundles.map((b) => (b.secondary ? b.secondary.close() : b.primary.close())),
  );
  await waitFor(() => hubRetentionSnapshot().activeClients === 0, "all /live sockets closed");

  const wipedSnap = hubRetentionSnapshot();
  assert.equal(wipedSnap.activeClients, 0);
  assert.equal(wipedSnap.bufferedFramesTotal, 0);
  assert.equal(wipedSnap.bufferedFrameBytes, 0);
  assert.equal(wipedSnap.sessions, 10);

  for (const { sessionId } of bundles) {
    const hub = getHub(sessionId);
    assert.ok(hub);
    assert.equal(hub.ring.length, 0);
    assert.deepEqual(hub.ring.pick(8, 60_000), []);
  }

  const statsShape = hubStats();
  assert.deepEqual(Object.keys(statsShape).sort(), ["floatingHuds", "latest", "sessions"]);
});

test("MAX_HUBS flood protection caps 300 sequential ephemeral idle hubs at <= MAX_HUBS while preserving pinned active hubs, and sweepIdleHubs deterministically reaps stale idle hubs", () => {
  assert.equal(MAX_HUBS, 256);

  const makeMockSocket = () => {
    const listeners: Array<() => void> = [];
    const raw = {
      readyState: 1,
      send() {},
      on(ev: string, cb: () => void) {
        if (ev === "close") listeners.push(cb);
        return raw;
      },
    };
    return {
      ws: raw as unknown as WebSocket,
      close() {
        raw.readyState = 3;
        for (const cb of listeners) cb();
      },
    };
  };

  const sampleFrame = (bytes: number) => ({
    data: Buffer.alloc(bytes, 0x61).toString("base64"),
    sharpness: 0.8,
    ts: 1000,
    bytes,
    source: "glasses" as const,
  });

  const pinnedClientHub = getOrCreateHub("pinned-client");
  const mockClient = makeMockSocket();
  pinnedClientHub.clients.add(mockClient.ws);
  pinnedClientHub.ring.push(sampleFrame(512));
  pinnedClientHub.touchedAt = 1_000;

  const pinnedHudHub = getOrCreateHub("pinned-hud");
  const mockHud = makeMockSocket();
  addHud(mockHud.ws, "pinned-hud");
  pinnedHudHub.ring.push(sampleFrame(640));
  pinnedHudHub.touchedAt = 1_001;

  let liveActiveFlag = true;
  const pinnedLiveHub = getOrCreateHub("pinned-live");
  pinnedLiveHub.live = {
    get active() {
      return liveActiveFlag;
    },
    handleEvent() {},
    stop() {
      liveActiveFlag = false;
    },
  };
  pinnedLiveHub.ring.push(sampleFrame(768));
  pinnedLiveHub.touchedAt = 1_002;

  const oldestIdle = getOrCreateHub("ephemeral-oldest");
  markLatest(oldestIdle);
  oldestIdle.ring.push(sampleFrame(1024));
  oldestIdle.touchedAt = 2_000;
  assert.equal(latestHub(), oldestIdle);

  const floodedHubs: Array<{ id: string; ref: ReturnType<typeof getOrCreateHub> }> = [];
  for (let i = 0; i < 300; i++) {
    const id = `flood-idle-${String(i).padStart(3, "0")}`;
    const h = getOrCreateHub(id);
    if (i < 60) {
      h.ring.push(sampleFrame(256));
    }
    h.touchedAt = 10_000 + i;
    floodedHubs.push({ id, ref: h });
    assert.ok(hubStats().sessions <= MAX_HUBS);
    assert.ok(hubRetentionSnapshot().sessions <= MAX_HUBS);
  }

  assert.equal(hubStats().sessions, MAX_HUBS);
  assert.equal(hubRetentionSnapshot().sessions, MAX_HUBS);

  assert.equal(getHub("pinned-client"), pinnedClientHub);
  assert.equal(getHub("pinned-hud"), pinnedHudHub);
  assert.equal(getHub("pinned-live"), pinnedLiveHub);
  assert.equal(pinnedClientHub.ring.length, 1);
  assert.equal(pinnedHudHub.ring.length, 1);
  assert.equal(pinnedLiveHub.ring.length, 1);

  assert.equal(getHub("ephemeral-oldest"), undefined);
  assert.equal(oldestIdle.ring.length, 0);
  assert.equal(latestHub(), undefined);
  assert.equal(hubStats().latest, null);

  for (let i = 0; i < 47; i++) {
    assert.equal(getHub(floodedHubs[i].id), undefined);
    assert.equal(floodedHubs[i].ref.ring.length, 0);
  }
  for (let i = 47; i < 300; i++) {
    assert.equal(getHub(floodedHubs[i].id), floodedHubs[i].ref);
  }

  const snapAfterFlood = hubRetentionSnapshot();
  assert.equal(snapAfterFlood.sessions, 256);
  assert.equal(snapAfterFlood.activeClients, 1);
  assert.equal(snapAfterFlood.activeHuds, 1);
  assert.equal(snapAfterFlood.bufferedFramesTotal, 3 + 13);
  assert.equal(snapAfterFlood.bufferedFrameBytes, 512 + 640 + 768 + 13 * 256);

  for (let i = 200; i < 299; i++) {
    floodedHubs[i].ref.touchedAt = 500_000;
  }
  markLatest(floodedHubs[299].ref);
  floodedHubs[299].ref.ring.push(sampleFrame(300));
  floodedHubs[299].ref.touchedAt = 20_000;
  assert.equal(latestHub(), floodedHubs[299].ref);

  const sweptStale = sweepIdleHubs(600_000, 300_000);
  assert.equal(sweptStale, 154);
  assert.equal(latestHub(), undefined);
  assert.equal(hubStats().latest, null);
  assert.equal(floodedHubs[299].ref.ring.length, 0);

  for (let i = 47; i < 200; i++) {
    assert.equal(getHub(floodedHubs[i].id), undefined);
    assert.equal(floodedHubs[i].ref.ring.length, 0);
  }
  for (let i = 200; i < 299; i++) {
    assert.equal(getHub(floodedHubs[i].id), floodedHubs[i].ref);
  }
  assert.equal(getHub("pinned-client"), pinnedClientHub);
  assert.equal(getHub("pinned-hud"), pinnedHudHub);
  assert.equal(getHub("pinned-live"), pinnedLiveHub);

  const snapAfterPartialSweep = hubRetentionSnapshot();
  assert.equal(snapAfterPartialSweep.sessions, 102);
  assert.equal(snapAfterPartialSweep.bufferedFramesTotal, 3);
  assert.equal(snapAfterPartialSweep.bufferedFrameBytes, 512 + 640 + 768);

  pinnedClientHub.clients.delete(mockClient.ws);
  mockHud.close();
  pinnedLiveHub.live?.stop("done");

  const sweptAll = sweepIdleHubs(Date.now() + 200_000, 100_000);
  assert.equal(sweptAll, 102);
  assert.deepEqual(hubRetentionSnapshot(), {
    sessions: 0,
    activeClients: 0,
    activeHuds: 0,
    floatingHuds: 0,
    bufferedFramesTotal: 0,
    bufferedFrameBytes: 0,
  });
});

test("safeSend drops payloads cleanly without throwing when stalled socket bufferedAmount exceeds 2 MiB while preserving mock and healthy sockets", () => {
  const TWO_MIB = 2 * 1024 * 1024;

  const undefinedBufferedSent: string[] = [];
  const mockUndefinedWs = {
    readyState: 1,
    send(data: string) {
      undefinedBufferedSent.push(data);
    },
  } as unknown as WebSocket;
  safeSend(mockUndefinedWs, '{"type":"pong","t":1}');
  assert.equal(undefinedBufferedSent.length, 1);

  let dynamicBuffered = 0;
  let throwIfCalled = false;
  const stalledCandidateSent: string[] = [];
  const candidateRaw = {
    readyState: 1,
    get bufferedAmount() {
      return dynamicBuffered;
    },
    send(data: string) {
      if (throwIfCalled) {
        throw new Error("stalled socket should not be written to");
      }
      stalledCandidateSent.push(data);
    },
  };
  const candidateWs = candidateRaw as unknown as WebSocket;

  dynamicBuffered = 0;
  safeSend(candidateWs, '{"type":"pong","t":2}');
  assert.equal(stalledCandidateSent.length, 1);

  dynamicBuffered = TWO_MIB;
  safeSend(candidateWs, '{"type":"pong","t":3}');
  assert.equal(stalledCandidateSent.length, 2);

  dynamicBuffered = TWO_MIB + 1;
  throwIfCalled = true;
  assert.doesNotThrow(() => {
    safeSend(candidateWs, '{"type":"pong","t":4}');
  });
  assert.equal(stalledCandidateSent.length, 2);

  dynamicBuffered = 12 * 1024 * 1024;
  const hub = getOrCreateHub("backpressure-hub");
  const healthySent: ServerMsg[] = [];
  const healthyWs = {
    readyState: 1,
    bufferedAmount: 1024,
    send(data: string) {
      healthySent.push(JSON.parse(data) as ServerMsg);
    },
  } as unknown as WebSocket;

  hub.clients.add(candidateWs);
  hub.clients.add(healthyWs);

  for (let i = 0; i < 50; i++) {
    assert.doesNotThrow(() => {
      hub.emit({ type: "coach", cue: "hold_still", text: `Cue ${i}` });
    });
  }
  assert.equal(healthySent.length, 50);
  assert.equal(stalledCandidateSent.length, 2);

  throwIfCalled = false;
  dynamicBuffered = 64 * 1024;
  hub.emit({ type: "coach", cue: "ok", text: "Recovered" });
  assert.equal(healthySent.length, 51);
  assert.equal(stalledCandidateSent.length, 3);

  const throwingHealthyWs = {
    readyState: 1,
    bufferedAmount: 0,
    send() {
      throw new Error("broken pipe");
    },
  } as unknown as WebSocket;
  assert.doesNotThrow(() => {
    safeSend(throwingHealthyWs, '{"type":"pong","t":99}');
  });

  const SampleVerdictCheck: Verdict | undefined = hub.lastVerdict;
  assert.equal(SampleVerdictCheck, undefined);
});

test("server/src/hub.ts and server/test/memory-zero-retention-soak.test.ts contain zero comments, zero em dashes, zero trailers, and zero keys", () => {
  const selfPath = fileURLToPath(import.meta.url);
  const hubPath = path.resolve(path.dirname(selfPath), "..", "src", "hub.ts");
  const star = String.fromCharCode(42);
  const emDash = String.fromCharCode(0x2014);
  const coAuthored = new RegExp(["Co", "Authored", "By"].join("-"), "i");
  const signedOff = new RegExp(["Signed", "off", "by"].join("-"), "i");
  const apiKey = new RegExp("AIza" + "[0-9A-Za-z_-]{20,}");

  for (const targetPath of [hubPath, selfPath]) {
    const src = fs.readFileSync(targetPath, "utf8");
    const label = path.basename(targetPath);
    assert.equal(src.includes(SLASH + SLASH), false, `${label} must not contain double-slash comment`);
    assert.equal(src.includes(SLASH + star), false, `${label} must not contain block comment start`);
    assert.equal(src.includes(star + SLASH), false, `${label} must not contain block comment end`);
    assert.equal(src.includes(emDash), false, `${label} must not contain em dash`);
    assert.equal(coAuthored.test(src), false, `${label} must not contain co-author trailer`);
    assert.equal(signedOff.test(src), false, `${label} must not contain signed-off trailer`);
    assert.equal(apiKey.test(src), false, `${label} must not contain API key`);
  }
});
