import fs from "node:fs";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import type { WebSocket as WsType } from "ws";
import type { LabelRead, Profile, ServerMsg } from "../../shared/types.ts";

process.env.HOLDUP_QUIET = "1";

type HubMod = typeof import("../src/hub.ts");
type EnvMod = typeof import("../src/env.ts");
type GeminiMod = typeof import("../src/gemini.ts");
type VerifyMod = typeof import("../src/verify.ts");
type FindMod = typeof import("../src/find.ts");
type LiveMod = typeof import("../src/live.ts");
type ElevenMod = typeof import("../src/elevenlabs.ts");
type IndexMod = typeof import("../src/index.ts");

type LiveConnectArg = {
  model: string;
  config: {
    systemInstruction?: string;
    sessionResumption?: { handle?: string };
    tools?: unknown[];
  };
  callbacks: {
    onmessage: (m: any) => void;
    onerror: (e: any) => void;
    onclose: (e: { code: number; reason?: string }) => void;
  };
};

type GenerateContentArg = {
  model: string;
  contents: Array<{ role?: string; parts?: Array<Record<string, unknown>> }>;
  config?: {
    systemInstruction?: string;
    responseMimeType?: string;
    responseJsonSchema?: unknown;
  };
};

let hubMod!: HubMod;
let envMod!: EnvMod;
let geminiMod!: GeminiMod;
let verifyMod!: VerifyMod;
let findMod!: FindMod;
let liveMod!: LiveMod;
let elevenMod!: ElevenMod;
let indexMod!: IndexMod;
let hubGcTick: (() => void) | undefined;

let origConnect: unknown;
let origGenerate: unknown;
let origFetch: typeof globalThis.fetch;
let origLedgerPath = "";
let origApiKey = "";
let origHoldupKey: string | undefined;
let origElevenLiveEnv: string | undefined;
let origElevenKey = "";
let origElevenLive = false;
let origFeatures: ReturnType<() => EnvMod["env"]["features"]> = [];
let origLiveModels: string[] = [];
let origVerifyModels: string[] = [];
let tempDir = "";

const SLASH = "\x2f";
const httpBase = (port: number) => ["http:", "", `127.0.0.1:${port}`].join(SLASH);
const wsBase = (port: number) => ["ws:", "", `127.0.0.1:${port}`].join(SLASH);

const f = <T>(value: T | null, confidence = 0.96) => ({ value, confidence });

function sampleRead(): LabelRead {
  return {
    kind: "medication",
    product: f("Norvasc"),
    ingredient: f("amlodipine"),
    strength: f("5 mg"),
    dosing: f("1 tablet daily", 0.91),
    expiry: f("2028-04", 0.93),
    allergens: f(null, 0),
    barcode: f(null, 0),
    readability: 0.94,
  };
}

function sensitiveProfile(): Profile {
  return {
    lang: "en",
    meds: [
      {
        id: "med-aml",
        name: "Norvasc",
        ingredient: "amlodipine",
        strength: "7.35 mg",
        schedule: ["evening", "21:30"],
        barcode: "6416542009911",
        gtin: "06416542009911",
        notes: "PRIVATE-CARDIO-NOTE-DR-VIRTANEN-ROOM-402",
      },
      {
        id: "med-met",
        name: "Glucophage",
        ingredient: "metformin",
        strength: "850 mg",
        schedule: ["morning"],
        barcode: "6416542008822",
        gtin: "06416542008822",
        notes: "CONFIDENTIAL-RENAL-EGFR-52-CHECK",
      },
      {
        id: "med-atr",
        name: "atorvastatin",
        ingredient: "atorvastatin",
        strength: "37.5 mg",
        schedule: [],
        barcode: "6416542007733",
        gtin: "06416542007733",
        notes: "SECRET-STATIN-MYALGIA-HISTORY",
      },
    ],
    allergies: ["peanut", "hazelnut", "penicillin"],
    avoid: ["NSAIDs", "grapefruit"],
    doseLog: [
      { medId: "med-aml", ts: 1763191872345 },
      { medId: "med-met", ts: 1763188211987 },
    ],
  };
}

before(async () => {
  const realSetInterval = globalThis.setInterval;
  const captured: Array<{ fn: () => void; ms: number }> = [];
  globalThis.setInterval = ((fn: Parameters<typeof setInterval>[0], ms?: number, ...rest: unknown[]) => {
    if (typeof fn === "function") {
      captured.push({ fn: fn as () => void, ms: Number(ms ?? 0) });
    }
    return (realSetInterval as (...args: unknown[]) => ReturnType<typeof setInterval>)(fn, ms, ...rest);
  }) as typeof setInterval;
  try {
    hubMod = await import("../src/hub.ts");
  } finally {
    globalThis.setInterval = realSetInterval;
  }
  hubGcTick = captured.find((entry) => entry.ms === 60_000)?.fn;

  envMod = await import("../src/env.ts");
  geminiMod = await import("../src/gemini.ts");
  verifyMod = await import("../src/verify.ts");
  findMod = await import("../src/find.ts");
  liveMod = await import("../src/live.ts");
  elevenMod = await import("../src/elevenlabs.ts");
  indexMod = await import("../src/index.ts");

  origConnect = (geminiMod.ai.live as any).connect;
  origGenerate = (geminiMod.ai.models as any).generateContent;
  origFetch = globalThis.fetch;
  origLedgerPath = envMod.env.ledgerPath;
  origApiKey = envMod.env.apiKey;
  origHoldupKey = process.env.HOLDUP_KEY;
  origElevenLiveEnv = process.env.ELEVENLABS_LIVE;
  origElevenKey = elevenMod.eleven.key;
  origElevenLive = elevenMod.eleven.live;
  origFeatures = [...envMod.env.features];
  origLiveModels = [...envMod.env.liveModels];
  origVerifyModels = [...envMod.env.verifyModels];

  const shmRoot = fs.existsSync([SLASH, "dev", "shm"].join(SLASH)) ? [SLASH, "dev", "shm"].join(SLASH) : os.tmpdir();
  tempDir = fs.mkdtempSync(path.join(shmRoot, "holdup-consent-bystander-"));
  envMod.env.ledgerPath = path.join(tempDir, "ledger.jsonl");
});

beforeEach(() => {
  delete process.env.HOLDUP_KEY;
  envMod.env.liveModels = ["gemini-3.8-live"];
  envMod.env.verifyModels = ["gemini-3.8-flash"];
  envMod.env.features = ["scene", "datamatrix", "addmed", "sonar"];
  elevenMod.eleven.key = origElevenKey;
  elevenMod.eleven.live = origElevenLive;
});

afterEach(() => {
  (geminiMod.ai.live as any).connect = origConnect;
  (geminiMod.ai.models as any).generateContent = origGenerate;
  globalThis.fetch = origFetch;
  elevenMod.eleven.key = origElevenKey;
  elevenMod.eleven.live = origElevenLive;
  envMod.env.apiKey = origApiKey;
  envMod.env.features = [...origFeatures];
  envMod.env.liveModels = [...origLiveModels];
  envMod.env.verifyModels = [...origVerifyModels];
  if (origHoldupKey === undefined) delete process.env.HOLDUP_KEY;
  else process.env.HOLDUP_KEY = origHoldupKey;
  if (origElevenLiveEnv === undefined) delete process.env.ELEVENLABS_LIVE;
  else process.env.ELEVENLABS_LIVE = origElevenLiveEnv;
});

after(() => {
  envMod.env.ledgerPath = origLedgerPath;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

test("live.ts Gemini Live systemInstruction includes ONLY med names, ingredients, schedule, allergies, and avoid-list, and never leaks strength, barcode, gtin, notes, or doseLog timestamps", async () => {
  const capturedConfigs: LiveConnectArg["config"][] = [];
  (geminiMod.ai.live as any).connect = async (arg: LiveConnectArg) => {
    capturedConfigs.push(arg.config);
    return {
      sendToolResponse() {},
      sendRealtimeInput() {},
      close() {},
    };
  };

  const hub = new hubMod.Hub("sess-minimization-live");
  hub.profile = sensitiveProfile();
  hub.features = new Set(["scene", "addmed"]);
  const proxy = new liveMod.LiveProxy(hub, { lang: "fi", voice: true });
  hub.live = proxy;
  try {
    await proxy.start();
    assert.equal(capturedConfigs.length, 1);
    const sys = String(capturedConfigs[0]?.systemInstruction ?? "");
    assert.ok(sys.length > 100);

    assert.ok(sys.includes("Language: Finnish. Speak Finnish."));
    assert.ok(sys.includes('- medId "med-aml": Norvasc (amlodipine), taken evening, 21:30'));
    assert.ok(sys.includes('- medId "med-met": Glucophage (metformin), taken morning'));
    assert.ok(sys.includes('- medId "med-atr": atorvastatin, taken as needed'));
    assert.equal(sys.includes("atorvastatin (atorvastatin)"), false);
    assert.ok(sys.includes("Allergies: peanut, hazelnut, penicillin"));
    assert.ok(sys.includes("Avoid: NSAIDs, grapefruit"));
    assert.ok(sys.includes("find_item"));
    assert.ok(sys.includes("add_medication"));

    const forbiddenFragments = [
      "7.35 mg",
      "7.35",
      "850 mg",
      "850",
      "37.5 mg",
      "37.5",
      "6416542009911",
      "06416542009911",
      "6416542008822",
      "06416542008822",
      "6416542007733",
      "06416542007733",
      "PRIVATE-CARDIO-NOTE-DR-VIRTANEN-ROOM-402",
      "CONFIDENTIAL-RENAL-EGFR-52-CHECK",
      "SECRET-STATIN-MYALGIA-HISTORY",
      "VIRTANEN",
      "EGFR",
      "MYALGIA",
      "1763191872345",
      "1763188211987",
      new Date(1763191872345).toISOString(),
      new Date(1763188211987).toISOString(),
      "doseLog",
    ];
    for (const secret of forbiddenFragments) {
      assert.equal(sys.includes(secret), false, `systemInstruction leaked forbidden profile datum: ${secret}`);
    }
  } finally {
    proxy.stop("done");
    hub.dropFrames();
  }

  const emptyHub = new hubMod.Hub("sess-minimization-empty");
  emptyHub.profile = verifyMod.emptyProfile();
  const emptyProxy = new liveMod.LiveProxy(emptyHub, { lang: "sv", voice: false });
  emptyHub.live = emptyProxy;
  try {
    await emptyProxy.start();
    const sysEmpty = String(capturedConfigs[1]?.systemInstruction ?? "");
    assert.ok(sysEmpty.includes("Language: Swedish. Speak Swedish."));
    assert.ok(sysEmpty.includes("- none saved"));
    assert.ok(sysEmpty.includes("Allergies: none saved"));
    assert.ok(sysEmpty.includes("Avoid: nothing saved"));
    assert.equal(sysEmpty.includes("find_item"), false);
    assert.equal(sysEmpty.includes("add_medication"), false);
  } finally {
    emptyProxy.stop("done");
    emptyHub.dropFrames();
  }
});

test("verify.ts and find.ts enforce strict zero-profile isolation for Gemini Flash label and scene reader calls", async () => {
  const capturedCalls: GenerateContentArg[] = [];
  let mode: "label" | "scene" = "label";
  (geminiMod.ai.models as any).generateContent = async (req: GenerateContentArg) => {
    capturedCalls.push(req);
    const payload = mode === "label"
      ? sampleRead()
      : { items: [{ box_2d: [100, 120, 620, 460], read: sampleRead(), answers_target: true }] };
    return {
      text: JSON.stringify(payload),
      usageMetadata: { promptTokenCount: 42, candidatesTokenCount: 28 },
    };
  };

  const isolatedProfile: Profile = {
    lang: "en",
    meds: [
      {
        id: "priv-med-id-91",
        name: "CardioPrivateBrandName",
        ingredient: "ramipril",
        strength: "9.25 mg",
        schedule: ["22:15-bedtime-slot"],
        barcode: "6499887766554",
        gtin: "06499887766554",
        notes: "PATIENT-NEPHROLOGY-CONFIDENTIAL-884",
      },
    ],
    allergies: ["macadamia-anaphylaxis", "shellfish-epipen", "cephalosporin-rash"],
    avoid: ["monoamine-oxidase-inhibitors", "potassium-sparing-diuretics"],
    doseLog: [{ medId: "priv-med-id-91", ts: 1763195555111 }],
  };

  const forbiddenProfileTokens = [
    "priv-med-id-91",
    "CardioPrivateBrandName",
    "ramipril",
    "9.25 mg",
    "9.25",
    "22:15-bedtime-slot",
    "6499887766554",
    "06499887766554",
    "PATIENT-NEPHROLOGY-CONFIDENTIAL-884",
    "macadamia-anaphylaxis",
    "shellfish-epipen",
    "cephalosporin-rash",
    "monoamine-oxidase-inhibitors",
    "potassium-sparing-diuretics",
    "1763195555111",
  ];

  const frameA = Buffer.alloc(180, 0x41).toString("base64");
  const frameB = Buffer.alloc(180, 0x42).toString("base64");

  mode = "label";
  assert.ok(verifyMod.readLabel.length <= 3);
  const directRead = await verifyMod.readLabel([frameA], "What medicine is this?");
  assert.equal(directRead.read.ingredient.value, "amlodipine");

  const fullVerify = await verifyMod.verify([frameA, frameB], isolatedProfile, "Is this on my list?");
  assert.equal(fullVerify.verdict.level, "warning");

  mode = "scene";
  const sceneVerify = await findMod.findItems([frameA, frameB], isolatedProfile, "Which box is on the left?");
  assert.equal(sceneVerify.verdict.mode, "scene");

  let liveSessionCallbacks: LiveConnectArg["callbacks"] | undefined;
  (geminiMod.ai.live as any).connect = async (arg: LiveConnectArg) => {
    liveSessionCallbacks = arg.callbacks;
    return {
      sendToolResponse() {},
      sendRealtimeInput() {},
      close() {},
    };
  };

  const hub = new hubMod.Hub("sess-zero-profile-tools");
  hub.profile = isolatedProfile;
  hub.features = new Set(["scene"]);
  hub.ring.push({ data: frameA, sharpness: 0.92, ts: Date.now(), bytes: 180, source: "phone" });
  const emitted: ServerMsg[] = [];
  hub.clients.add({
    readyState: 1,
    send(raw: string) {
      emitted.push(JSON.parse(raw) as ServerMsg);
    },
  } as unknown as WsType);
  const proxy = new liveMod.LiveProxy(hub, { lang: "en", voice: true });
  hub.live = proxy;
  try {
    await proxy.start();
    assert.ok(liveSessionCallbacks);

    mode = "label";
    const beforeLabelIdx = emitted.length;
    liveSessionCallbacks.onmessage({
      toolCall: { functionCalls: [{ id: "tc-label", name: "verify_label", args: { question: "Read the front panel" } }] },
    });
    const deadline1 = Date.now() + 2000;
    while (!emitted.slice(beforeLabelIdx).some((m) => m.type === "checking" && m.phase === "end") && Date.now() < deadline1) {
      await new Promise((r) => setTimeout(r, 10));
    }

    mode = "scene";
    const beforeSceneIdx = emitted.length;
    liveSessionCallbacks.onmessage({
      toolCall: { functionCalls: [{ id: "tc-scene", name: "find_item", args: { target: "the box on the table" } }] },
    });
    const deadline2 = Date.now() + 2000;
    while (!emitted.slice(beforeSceneIdx).some((m) => m.type === "checking" && m.phase === "end") && Date.now() < deadline2) {
      await new Promise((r) => setTimeout(r, 10));
    }
  } finally {
    proxy.stop("done");
    hub.dropFrames();
  }

  assert.equal(capturedCalls.length, 5);
  const snapServer: http.Server = await indexMod.startServer(0);
  try {
    mode = "label";
    const snapPort = (snapServer.address() as AddressInfo).port;
    const snapRes = await fetch(`${httpBase(snapPort)}/api/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ frames: [frameA], profile: isolatedProfile, question: "Check front label" }),
    });
    assert.equal(snapRes.status, 200);
  } finally {
    snapServer.closeAllConnections();
    await new Promise<void>((resolve) => snapServer.close(() => resolve()));
  }

  assert.equal(capturedCalls.length, 6);
  for (let i = 0; i < capturedCalls.length; i++) {
    const serialized = JSON.stringify(capturedCalls[i]);
    for (const secret of forbiddenProfileTokens) {
      assert.equal(serialized.includes(secret), false, `Flash call #${i} leaked profile datum: ${secret}`);
    }
    const parts = capturedCalls[i].contents[0]?.parts ?? [];
    assert.ok(parts.length >= 2);
    const textParts = parts.filter((p) => typeof p.text === "string").map((p) => String(p.text));
    assert.equal(textParts.length, 1);
  }
});

test("live.md, verify_prompt.md, and find_prompt.md enforce bystander person and face non-description rules", () => {
  const repoRoot = envMod.REPO_ROOT;
  const livePrompt = fs.readFileSync(path.join(repoRoot, "server", "src", "prompts", "live.md"), "utf8");
  const verifyPromptFile = fs.readFileSync(path.join(repoRoot, "shared", "verify_prompt.md"), "utf8");
  const findPromptFile = fs.readFileSync(path.join(repoRoot, "shared", "find_prompt.md"), "utf8");

  assert.equal(verifyMod.VERIFY_PROMPT, verifyPromptFile);
  assert.ok(findMod.FIND_PROMPT.includes(findPromptFile));
  assert.ok(findMod.FIND_PROMPT.includes(verifyPromptFile));

  assert.match(livePrompt, /Never describe what the person, their hands or other people look like\./i);
  assert.match(livePrompt, /Ignore people and faces completely/i);
  assert.match(livePrompt, /if asked about a person, say you only help with labels/i);

  assert.match(verifyPromptFile, /Ignore people, faces, hands and the background\./i);
  assert.match(verifyPromptFile, /Never describe a person\./i);

  assert.match(findPromptFile, /Ignore people, hands and faces\./i);

  const labelProps = Object.keys((verifyMod.LABEL_SCHEMA as { properties?: Record<string, unknown> }).properties ?? {});
  for (const bannedKey of ["person", "people", "face", "faces", "bystander", "age", "gender", "identity"]) {
    assert.equal(labelProps.includes(bannedKey), false);
  }
});

test("startServer() WS cross-boundary isolation: /hud-ws and /hud-ws?role=stage never receive frame, audio, or profile while /live streams, and FrameRing drops to 0 on /live close", async () => {
  let liveCallbacks: LiveConnectArg["callbacks"] | undefined;
  const forwardedRealtime: unknown[] = [];
  (geminiMod.ai.live as any).connect = async (arg: LiveConnectArg) => {
    liveCallbacks = arg.callbacks;
    return {
      sendToolResponse() {},
      sendRealtimeInput(chunk: unknown) {
        forwardedRealtime.push(chunk);
      },
      close() {},
    };
  };
  (geminiMod.ai.models as any).generateContent = async () => ({
    text: JSON.stringify(sampleRead()),
    usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 12 },
  });

  const server: http.Server = await indexMod.startServer(0);
  const port = (server.address() as AddressInfo).port;
  const httpOrigin = httpBase(port);
  const wsOrigin = wsBase(port);
  const sessId = "sess-ws-boundary-check";

  const openSocket = (suffix: string) =>
    new Promise<{ ws: WebSocket; rawFrames: string[]; parsed: Array<Record<string, unknown>> }>((resolve, reject) => {
      const ws = new WebSocket(`${wsOrigin}${suffix}`);
      const rawFrames: string[] = [];
      const parsed: Array<Record<string, unknown>> = [];
      ws.on("message", (data) => {
        const s = data.toString();
        rawFrames.push(s);
        parsed.push(JSON.parse(s) as Record<string, unknown>);
      });
      ws.once("open", () => resolve({ ws, rawFrames, parsed }));
      ws.once("error", reject);
    });

  const closeSocket = (ws: WebSocket) =>
    new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      ws.once("close", () => resolve());
      ws.close();
    });

  const [liveClient, pinnedHud, floatingHud, pinnedStage, floatingStage] = await Promise.all([
    openSocket(`/live?session=${sessId}`),
    openSocket(`/hud-ws?session=${sessId}`),
    openSocket("/hud-ws"),
    openSocket(`/hud-ws?session=${sessId}&role=stage`),
    openSocket("/hud-ws?role=stage"),
  ]);

  try {
    const profile = sensitiveProfile();
    const frameMarker = Buffer.from("DISTINCTIVE_JPEG_FRAME_BYTES_".repeat(6)).toString("base64");
    const glassesBuf = Buffer.from("DISTINCTIVE_GLASSES_RAW_JPEG_".repeat(6));
    const glassesMarker = glassesBuf.toString("base64");
    const userAudioMarker = Buffer.from("DISTINCTIVE_USER_MIC_PCM16_AUDIO").toString("base64");
    const botAudioMarker = Buffer.from("DISTINCTIVE_ASSISTANT_PCM24_AUDIO").toString("base64");

    liveClient.ws.send(
      JSON.stringify({
        type: "start",
        profile,
        lang: "en",
        voice: true,
        source: "glasses",
        features: ["sonar", "scene", "datamatrix", "addmed"],
      }),
    );

    const readyDeadline = Date.now() + 2000;
    while (!liveClient.parsed.some((m) => m.type === "ready") && Date.now() < readyDeadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(liveCallbacks);

    for (let i = 0; i < 6; i++) {
      liveClient.ws.send(
        JSON.stringify({
          type: "frame",
          data: frameMarker,
          w: 640,
          h: 480,
          sharpness: 0.72 + i * 0.02,
          ts: Date.now() + i,
        }),
      );
    }
    for (let i = 0; i < 4; i++) {
      const ingRes = await fetch(`${httpOrigin}/ingest/frame?session=${sessId}`, {
        method: "POST",
        headers: { "content-type": "image/jpeg" },
        body: glassesBuf,
      });
      assert.equal(ingRes.status, 204);
    }

    const activeHub = hubMod.getHub(sessId);
    assert.ok(activeHub);
    assert.equal(activeHub.ring.length, 8);

    liveClient.ws.send(JSON.stringify({ type: "audio", data: userAudioMarker }));
    liveClient.ws.send(JSON.stringify({ type: "text", text: "Is this my evening pill?" }));

    liveCallbacks.onmessage({
      serverContent: {
        inputTranscription: { text: "Is this my evening pill?", finished: true },
        modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: botAudioMarker } }] },
        outputTranscription: { text: "Let me look." },
        turnComplete: true,
      },
    });
    liveCallbacks.onmessage({
      toolCall: { functionCalls: [{ id: "hud-cue-1", name: "show_cue", args: { cue: "hold_still", text: "Hold it still" } }] },
    });
    liveCallbacks.onmessage({
      toolCall: { functionCalls: [{ id: "hud-ver-1", name: "verify_label", args: { question: "Is this my evening pill?" } }] },
    });

    const verdictDeadline = Date.now() + 2000;
    while (!pinnedHud.parsed.some((m) => m.type === "verdict") && Date.now() < verdictDeadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await new Promise((r) => setTimeout(r, 30));

    assert.ok(liveClient.parsed.some((m) => m.type === "audio" && m.data === botAudioMarker));
    assert.ok(forwardedRealtime.length >= 2);

    const allowedHudTypes = new Set(["verdict", "coach", "status", "device"]);
    const allowedStageTypes = new Set([
      "verdict",
      "coach",
      "status",
      "device",
      "transcript",
      "checking",
      "readiness",
      "ready",
      "interrupted",
      "metrics",
      "hud_event",
    ]);
    const forbiddenChannelTypes = new Set(["frame", "audio", "profile", "profile_add"]);

    for (const sock of [pinnedHud, floatingHud]) {
      assert.ok(sock.parsed.length >= 3);
      for (const msg of sock.parsed) {
        const msgType = String(msg.type);
        assert.equal(forbiddenChannelTypes.has(msgType), false, `HUD received forbidden message type: ${msgType}`);
        assert.equal(allowedHudTypes.has(msgType), true, `HUD received unexpected message type: ${msgType}`);
      }
    }

    for (const sock of [pinnedStage, floatingStage]) {
      assert.ok(sock.parsed.length >= 4);
      for (const msg of sock.parsed) {
        const msgType = String(msg.type);
        assert.equal(forbiddenChannelTypes.has(msgType), false, `Stage received forbidden message type: ${msgType}`);
        assert.equal(allowedStageTypes.has(msgType), true, `Stage received unexpected message type: ${msgType}`);
      }
    }

    const forbiddenWireSubstrings = [
      frameMarker,
      glassesMarker,
      userAudioMarker,
      botAudioMarker,
      "PRIVATE-CARDIO-NOTE-DR-VIRTANEN-ROOM-402",
      "CONFIDENTIAL-RENAL-EGFR-52-CHECK",
      "SECRET-STATIN-MYALGIA-HISTORY",
      "6416542009911",
      "06416542009911",
      "6416542008822",
      "6416542007733",
      "hazelnut",
      "penicillin",
      "grapefruit",
      "1763191872345",
      "1763188211987",
    ];

    for (const sock of [pinnedHud, floatingHud, pinnedStage, floatingStage]) {
      const joined = sock.rawFrames.join("\n");
      for (const secret of forbiddenWireSubstrings) {
        assert.equal(joined.includes(secret), false, `HUD or stage wire leaked secret payload: ${secret}`);
      }
    }

    await closeSocket(liveClient.ws);
    const dropDeadline = Date.now() + 1000;
    while ((hubMod.getHub(sessId)?.ring.length ?? 0) !== 0 && Date.now() < dropDeadline) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const afterCloseHub = hubMod.getHub(sessId);
    assert.ok(afterCloseHub);
    assert.equal(afterCloseHub.clients.size, 0);
    assert.equal(afterCloseHub.ring.length, 0);
    assert.deepEqual(afterCloseHub.ring.pick(2), []);
    assert.equal(afterCloseHub.lastCode, undefined);
    assert.equal(await afterCloseHub.spec.get(10), undefined);

    const verifyAfterClose = await fetch(`${httpOrigin}/api/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: sessId }),
    });
    assert.equal(verifyAfterClose.status, 409);
    const verifyErr = (await verifyAfterClose.json()) as { code: string };
    assert.equal(verifyErr.code, "no_frames");
  } finally {
    await Promise.all([
      closeSocket(liveClient.ws),
      closeSocket(pinnedHud.ws),
      closeSocket(floatingHud.ws),
      closeSocket(pinnedStage.ws),
      closeSocket(floatingStage.ws),
    ]);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("hub.ts GC evicts disconnected session in-memory profile after the 10-minute TTL while preserving active or within-TTL sessions", () => {
  assert.equal(typeof hubGcTick, "function", "Expected hub.ts 60s GC interval callback to be registered");
  const runGcAt = (fakeNow: number) => {
    const realNow = Date.now;
    Date.now = () => fakeNow;
    try {
      hubGcTick!();
    } finally {
      Date.now = realNow;
    }
  };

  const t0 = Date.now();
  const ttlMs = 10 * 60_000;
  const evictedId = "sess-ttl-evict-target";
  const connectedId = "sess-ttl-still-connected";
  const liveActiveId = "sess-ttl-live-active";

  const targetHub = hubMod.getOrCreateHub(evictedId);
  targetHub.profile = sensitiveProfile();
  targetHub.touchedAt = t0;
  targetHub.ring.push({ data: "frame-before-gc", sharpness: 0.85, ts: t0, bytes: 128, source: "phone" });
  targetHub.setCode({ raw: "0106416542009911", gtin: "06416542009911" });
  targetHub.resume = { handle: "resume-handle-abc", model: "gemini-3.8-live", at: t0 };
  hubMod.markLatest(targetHub);

  const connectedHub = hubMod.getOrCreateHub(connectedId);
  connectedHub.profile = sensitiveProfile();
  connectedHub.touchedAt = t0;
  const dummySocket = { readyState: 1, send() {} } as unknown as WsType;
  connectedHub.clients.add(dummySocket);

  const activeLiveHub = hubMod.getOrCreateHub(liveActiveId);
  activeLiveHub.profile = sensitiveProfile();
  activeLiveHub.touchedAt = t0;
  activeLiveHub.live = { active: true, handleEvent() {}, stop() {} };

  try {
    runGcAt(t0 + ttlMs - 1000);
    assert.equal(hubMod.getHub(evictedId), targetHub);
    assert.equal(hubMod.getHub(evictedId)?.profile.meds.length, 3);
    assert.deepEqual(hubMod.getHub(evictedId)?.profile.allergies, ["peanut", "hazelnut", "penicillin"]);

    runGcAt(t0 + ttlMs);
    assert.equal(hubMod.getHub(evictedId), targetHub);
    assert.equal(hubMod.getHub(evictedId)?.profile.meds[0]?.notes, "PRIVATE-CARDIO-NOTE-DR-VIRTANEN-ROOM-402");

    runGcAt(t0 + ttlMs + 1);
    assert.equal(hubMod.getHub(evictedId), undefined);
    assert.equal(hubMod.resolveHub(evictedId), undefined);
    assert.equal(hubMod.latestHub(), undefined);
    assert.equal(hubMod.hubStats().latest, null);
    assert.equal(targetHub.ring.length, 0);
    assert.equal(targetHub.lastCode, undefined);

    assert.equal(hubMod.getHub(connectedId), connectedHub);
    assert.equal(hubMod.getHub(connectedId)?.profile.meds.length, 3);
    assert.equal(hubMod.getHub(liveActiveId), activeLiveHub);
    assert.equal(hubMod.getHub(liveActiveId)?.profile.meds.length, 3);

    const recreated = hubMod.getOrCreateHub(evictedId);
    assert.notEqual(recreated, targetHub);
    assert.deepEqual(recreated.profile, verifyMod.emptyProfile());

    connectedHub.clients.delete(dummySocket);
    activeLiveHub.live = { active: false, handleEvent() {}, stop() {} };
    recreated.touchedAt = t0;
    runGcAt(t0 + ttlMs + 2);
    assert.equal(hubMod.getHub(connectedId), undefined);
    assert.equal(hubMod.getHub(liveActiveId), undefined);
    assert.equal(hubMod.getHub(evictedId), undefined);
  } finally {
    connectedHub.clients.delete(dummySocket);
    activeLiveHub.live = undefined;
    runGcAt(t0 + ttlMs + 5000);
  }
});

test("POST /api/tts/eleven returns 404 disabled when ELEVENLABS_LIVE is unset and never contacts ElevenLabs", async () => {
  const server: http.Server = await indexMod.startServer(0);
  const port = (server.address() as AddressInfo).port;
  const httpOrigin = httpBase(port);
  let outboundCalls = 0;

  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(httpOrigin)) return origFetch(input, init);
    outboundCalls++;
    throw new Error(`Unexpected outbound fetch to ${url}`);
  }) as typeof fetch;

  try {
    delete process.env.ELEVENLABS_LIVE;
    elevenMod.eleven.key = "";
    elevenMod.eleven.live = process.env.ELEVENLABS_LIVE === "1";

    const resNoKey = await fetch(`${httpOrigin}/api/tts/eleven`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Yes, Amlodipine 5 mg, your evening pill.", lang: "en" }),
    });
    assert.equal(resNoKey.status, 404);
    const bodyNoKey = (await resNoKey.json()) as { type: string; code: string; recoverable: boolean };
    assert.equal(bodyNoKey.type, "error");
    assert.equal(bodyNoKey.code, "disabled");
    assert.equal(bodyNoKey.recoverable, true);

    elevenMod.eleven.key = ["sk_", "presentKeyWithoutLiveOptIn987654"].join("");
    assert.equal(elevenMod.elevenEnabled(), true);
    assert.equal(elevenMod.eleven.live, false);

    const resKeyOnly = await fetch(`${httpOrigin}/api/tts/eleven`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Yes, Amlodipine 5 mg, your evening pill.", lang: "fi" }),
    });
    assert.equal(resKeyOnly.status, 404);
    const bodyKeyOnly = (await resKeyOnly.json()) as { type: string; code: string; message: string; recoverable: boolean };
    assert.equal(bodyKeyOnly.type, "error");
    assert.equal(bodyKeyOnly.code, "disabled");
    assert.match(bodyKeyOnly.message, /disabled/i);
    assert.equal(bodyKeyOnly.recoverable, true);
    assert.equal(outboundCalls, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("consent-bystander-minimization.test.ts contains zero code comments and zero em dashes", () => {
  const selfPath = fileURLToPath(import.meta.url);
  const src = fs.readFileSync(selfPath, "utf8");
  assert.equal(src.includes("\x2f\x2f"), false);
  assert.equal(src.includes("\x2f*"), false);
  assert.equal(src.includes(String.fromCharCode(0x2014)), false);
});
