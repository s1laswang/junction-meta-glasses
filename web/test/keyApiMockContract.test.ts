import { describe, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { ClientMsg, FeatureFlag, Profile, ServerMsg, Verdict } from "../../shared/types.ts";

type KeyMod = typeof import("../src/lib/key.ts");
type MockMod = typeof import("../src/lib/mock.ts");

type StorageHarness = {
  storage: Storage;
  setThrowOnRead: (v: boolean) => void;
  setThrowOnWrite: (v: boolean) => void;
};

type ReplaceCall = {
  data: unknown;
  unused: string;
  url?: string | URL | null;
};

type BrowserEnvOptions = {
  protocol?: string;
  host?: string;
  pathname?: string;
  search?: string;
  hash?: string;
  historyState?: unknown;
  language?: string;
  throwLocation?: boolean;
};

type BrowserEnvHandles = {
  local: StorageHarness;
  session: StorageHarness;
  replaceCalls: ReplaceCall[];
};

const WS_PROTO = "ws:";
const WSS_PROTO = "wss:";
const HTTP_PROTO = "http:";
const HTTPS_PROTO = "https:";
const HOST = "holdup.example:8787";
const WSS_BASE = [WSS_PROTO, "", HOST].join("/");
const WS_BASE = [WS_PROTO, "", HOST].join("/");

function createStorageHarness(): StorageHarness {
  let throwOnRead = false;
  let throwOnWrite = false;
  const proto = {
    get length(): number {
      return Object.keys(store).length;
    },
    key(index: number): string | null {
      return Object.keys(store)[index] ?? null;
    },
    getItem(key: string): string | null {
      if (throwOnRead) throw new Error("SecurityError");
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
    },
    setItem(key: string, value: string): void {
      if (throwOnWrite) throw new Error("QuotaExceededError");
      store[key] = String(value);
    },
    removeItem(key: string): void {
      if (throwOnWrite) throw new Error("SecurityError");
      delete store[key];
    },
    clear(): void {
      if (throwOnWrite) throw new Error("SecurityError");
      for (const k of Object.keys(store)) delete store[k];
    },
  };
  const store = Object.create(proto) as Record<string, string> & Storage;
  return {
    storage: store,
    setThrowOnRead(v: boolean) {
      throwOnRead = v;
    },
    setThrowOnWrite(v: boolean) {
      throwOnWrite = v;
    },
  };
}

function installBrowserEnv(opts: BrowserEnvOptions = {}): BrowserEnvHandles {
  const local = createStorageHarness();
  const session = createStorageHarness();
  const replaceCalls: ReplaceCall[] = [];
  const protocol = opts.protocol ?? HTTPS_PROTO;
  const host = opts.host ?? HOST;
  const origin = [protocol, "", host].join("/");
  const pathname = opts.pathname ?? "/";
  const search = opts.search ?? "";
  const hash = opts.hash ?? "";

  const historyMock = {
    state: "historyState" in opts ? opts.historyState : { from: "entry" },
    replaceState(data: unknown, unused: string, url?: string | URL | null) {
      replaceCalls.push({ data, unused, url });
    },
  };

  Object.defineProperty(globalThis, "localStorage", {
    value: local.storage,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    value: session.storage,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "history", {
    value: historyMock,
    configurable: true,
    writable: true,
  });

  if (opts.throwLocation) {
    Object.defineProperty(globalThis, "location", {
      get() {
        throw new Error("SecurityError");
      },
      configurable: true,
    });
  } else {
    Object.defineProperty(globalThis, "location", {
      value: { protocol, host, origin, pathname, search, hash },
      configurable: true,
      writable: true,
    });
  }

  Object.defineProperty(globalThis, "navigator", {
    value: { language: opts.language ?? "en-US", onLine: true, vibrate: () => true },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "window", {
    value: {
      isSecureContext: protocol === HTTPS_PROTO,
      addEventListener() {},
      removeEventListener() {},
      speechSynthesis: { cancel() {}, speak() {} },
    },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "document", {
    value: {
      visibilityState: "visible",
      createElement() {
        return { width: 0, height: 0, getContext: () => null };
      },
      addEventListener() {},
      removeEventListener() {},
    },
    configurable: true,
    writable: true,
  });

  return { local, session, replaceCalls };
}

installBrowserEnv({ search: "" });

const keyMod = await import("../src/lib/key.ts");
const apiMod = await import("../src/lib/api.ts");
const mockMod = await import("../src/lib/mock.ts");
const storageMod = await import("../src/lib/storage.ts");
const liveMod = await import("../src/lib/live.ts");
const checkerMod = await import("../src/lib/checker.ts");
const gs1Mod = await import("../src/lib/gs1.ts");
const audioMod = await import("../src/lib/audio.ts");

async function importFreshKey(tag: string): Promise<KeyMod> {
  const href = new URL("../src/lib/key.ts", import.meta.url).href;
  return (await import(`${href}?case=${tag}`)) as KeyMod;
}

async function importFreshMock(tag: string): Promise<MockMod> {
  const href = new URL("../src/lib/mock.ts", import.meta.url).href;
  return (await import(`${href}?case=${tag}`)) as MockMod;
}

function clearMockHudChannel(mod: MockMod = mockMod): void {
  const prevBC = globalThis.BroadcastChannel;
  Object.defineProperty(globalThis, "BroadcastChannel", {
    value: class DisabledChannel {
      constructor() {
        throw new Error("disabled");
      }
    },
    configurable: true,
    writable: true,
  });
  try {
    mod.mockHudChannel();
  } finally {
    Object.defineProperty(globalThis, "BroadcastChannel", {
      value: prevBC,
      configurable: true,
      writable: true,
    });
  }
}

function resetMockState(mod: MockMod = mockMod): void {
  for (const s of Array.from(mod.mockCtl.sockets)) {
    s.close();
  }
  mod.mockCtl.sockets.clear();
  clearMockHudChannel(mod);
  mod.mockCtl.failConnects = 0;
  mod.mockCtl.slow = false;
  mod.mockCtl.offline = false;
  mod.mockCtl.geminiDown = false;
  mod.mockCtl.device = {
    connected: false,
    worn: false,
    battery: null,
    streaming: false,
    source: "phone",
  };
}

function advanceTimers(t: TestContext, totalMs: number, stepMs = 100): void {
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
    t.mock.timers.tick(Math.min(stepMs, totalMs - elapsed));
  }
}

function collectSocketMessages(ws: InstanceType<MockMod["MockSocket"]>): ServerMsg[] {
  const received: ServerMsg[] = [];
  ws.onmessage = (ev: MessageEvent) => {
    received.push(JSON.parse(String(ev.data)) as ServerMsg);
  };
  return received;
}

function sendClient(ws: InstanceType<MockMod["MockSocket"]>, msg: ClientMsg): void {
  ws.send(JSON.stringify(msg));
}

async function waitUntil(predicate: () => boolean, maxTurns = 50): Promise<void> {
  for (let i = 0; i < maxTurns; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (predicate()) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return;
    }
  }
}

function requireVal<T>(val: T | undefined | null, label = "expected value"): T {
  assert.ok(val !== undefined && val !== null, label);
  return val;
}

describe("web/src/lib/key.ts HOLDUP_KEY contract", () => {
  test("AuthError sets standard name and message for 401/403 key prompts", () => {
    const err = new keyMod.AuthError();
    assert.ok(err instanceof Error);
    assert.ok(err instanceof keyMod.AuthError);
    assert.equal(err.name, "AuthError");
    assert.equal(err.message, "Access key needed");
  });

  test("accessKey extracts ?key= once, persists holdup.key, strips key from URL while keeping query/hash/state, and caches value", async () => {
    const { local, replaceCalls } = installBrowserEnv({
      pathname: "/hud/",
      search: "?mock=1&key=s3cr3t%2Bkey%3D9&session=K7P9",
      hash: "#pair",
      historyState: { hudVerdict: 1 },
    });

    const fresh = await importFreshKey("extract-mixed-params");
    const extracted = fresh.accessKey();

    assert.equal(extracted, "s3cr3t+key=9");
    assert.equal(localStorage.getItem("holdup.key"), "s3cr3t+key=9");
    assert.equal(replaceCalls.length, 1);
    assert.deepEqual(replaceCalls[0], {
      data: { hudVerdict: 1 },
      unused: "",
      url: "/hud/?mock=1&session=K7P9#pair",
    });

    local.setThrowOnRead(true);
    assert.equal(fresh.accessKey(), "s3cr3t+key=9");
    assert.equal(replaceCalls.length, 1);
  });

  test("accessKey strips sole ?key= without leaving a trailing question mark, with or without hash", async () => {
    const { replaceCalls } = installBrowserEnv({
      pathname: "/",
      search: "?key=only-token",
      hash: "",
      historyState: null,
    });

    const fresh = await importFreshKey("sole-key-param");
    assert.equal(fresh.accessKey(), "only-token");
    assert.equal(localStorage.getItem("holdup.key"), "only-token");
    assert.deepEqual(replaceCalls, [{ data: null, unused: "", url: "/" }]);

    const withHashEnv = installBrowserEnv({
      pathname: "/live",
      search: "?key=hash-token",
      hash: "#consent",
      historyState: { step: 2 },
    });
    const freshHash = await importFreshKey("sole-key-with-hash");
    assert.equal(freshHash.accessKey(), "hash-token");
    assert.deepEqual(withHashEnv.replaceCalls, [{ data: { step: 2 }, unused: "", url: "/live#consent" }]);
  });

  test("accessKey falls back to stored holdup.key without mutating history and returns null when absent or blocked", async () => {
    const { replaceCalls } = installBrowserEnv({ search: "?mock=1" });
    localStorage.setItem("holdup.key", "persisted-key-42");

    const fromStore = await importFreshKey("from-storage");
    assert.equal(fromStore.accessKey(), "persisted-key-42");
    assert.equal(replaceCalls.length, 0);

    installBrowserEnv({ search: "" });
    const empty = await importFreshKey("empty-key");
    assert.equal(empty.accessKey(), null);
    assert.deepEqual(empty.keyHeaders(), {});
    assert.equal(empty.withKey("/hud-ws"), "/hud-ws");

    installBrowserEnv({ throwLocation: true });
    const blocked = await importFreshKey("blocked-location");
    assert.equal(blocked.accessKey(), null);
    assert.deepEqual(blocked.keyHeaders(), {});
  });

  test("setAccessKey trims whitespace, updates headers and WS URLs, clears blank keys, and tolerates storage errors", async () => {
    const { local } = installBrowserEnv({ protocol: HTTPS_PROTO, host: HOST, search: "" });
    keyMod.setAccessKey("");
    assert.equal(keyMod.accessKey(), null);
    assert.deepEqual(keyMod.keyHeaders(), {});
    assert.equal(keyMod.withKey("/hud-ws"), "/hud-ws");
    assert.equal(keyMod.withKey(`${WSS_BASE}/hud-ws?session=ABCD`), `${WSS_BASE}/hud-ws?session=ABCD`);
    assert.equal(liveMod.liveUrl("AB CD"), `${WSS_BASE}/live?session=AB%20CD`);

    keyMod.setAccessKey("  gate+key/7=ok?yes  ");
    assert.equal(keyMod.accessKey(), "gate+key/7=ok?yes");
    assert.equal(localStorage.getItem("holdup.key"), "gate+key/7=ok?yes");
    assert.deepEqual(keyMod.keyHeaders(), { "x-holdup-key": "gate+key/7=ok?yes" });

    const encoded = encodeURIComponent("gate+key/7=ok?yes");
    assert.equal(keyMod.withKey("/hud-ws"), `/hud-ws?key=${encoded}`);
    assert.equal(keyMod.withKey(`${WSS_BASE}/hud-ws?session=K7P9`), `${WSS_BASE}/hud-ws?session=K7P9&key=${encoded}`);
    assert.equal(liveMod.liveUrl("K7P9"), `${WSS_BASE}/live?session=K7P9&key=${encoded}`);

    Object.defineProperty(globalThis, "location", {
      value: { protocol: HTTP_PROTO, host: HOST, origin: [HTTP_PROTO, "", HOST].join("/"), pathname: "/", search: "", hash: "" },
      configurable: true,
      writable: true,
    });
    assert.equal(liveMod.liveUrl("K7P9"), `${WS_BASE}/live?session=K7P9&key=${encoded}`);

    keyMod.setAccessKey("   ");
    assert.equal(keyMod.accessKey(), null);
    assert.equal(localStorage.getItem("holdup.key"), null);
    assert.deepEqual(keyMod.keyHeaders(), {});

    local.setThrowOnWrite(true);
    assert.doesNotThrow(() => keyMod.setAccessKey("ephemeral-in-ram"));
    assert.equal(keyMod.accessKey(), "ephemeral-in-ram");
    assert.doesNotThrow(() => keyMod.setAccessKey(""));
    assert.equal(keyMod.accessKey(), null);
  });

  test("deleteAllData wipes holdup.key in localStorage and clears sessionStorage", async () => {
    installBrowserEnv({ search: "" });
    keyMod.setAccessKey("secret-link-key");
    sessionStorage.setItem("holdup.temp", "1");
    assert.equal(localStorage.getItem("holdup.key"), "secret-link-key");

    await storageMod.deleteAllData();
    assert.equal(localStorage.getItem("holdup.key"), null);
    assert.equal(sessionStorage.length, 0);
    keyMod.setAccessKey("");
  });
});

describe("web/src/lib/api.ts HOLDUP_KEY probing and HTTP contract", () => {
  test("/api/health stays open while /api/stats detects missing or rejected HOLDUP_KEY with 401 and 403 AuthError", async () => {
    installBrowserEnv({ search: "" });
    keyMod.setAccessKey("");
    const prevFetch = globalThis.fetch;
    const calls: Array<{ url: string; headers: Record<string, string>; cache?: RequestCache; method?: string }> = [];
    const serverKey = "junction-2026-secret";

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, headers, cache: init?.cache, method: init?.method });

      if (url === "/api/health") {
        return new Response(
          JSON.stringify({ ok: true, gemini: "ok", models: { live: "gemini-3.8-live" }, version: "0.1.0" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === "/api/stats") {
        if (!headers["x-holdup-key"]) {
          return new Response(
            JSON.stringify({ type: "error", code: "unauthorized", message: "access key required", recoverable: false }),
            { status: 401, headers: { "content-type": "application/json" } },
          );
        }
        if (headers["x-holdup-key"] !== serverKey) {
          return new Response(
            JSON.stringify({ type: "error", code: "forbidden", message: "wrong key", recoverable: false }),
            { status: 403, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ calls: 12 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404, statusText: "Not Found" });
    }) as typeof fetch;

    try {
      const h = await apiMod.health();
      assert.equal(h.ok, true);
      assert.equal(h.gemini, "ok");
      assert.equal(calls[0].url, "/api/health");
      assert.equal(calls[0].cache, "no-store");
      assert.equal(calls[0].headers["x-holdup-key"], undefined);

      await assert.rejects(() => apiMod.probeAuth(), (err: unknown) => err instanceof keyMod.AuthError && err.message === "Access key needed");
      assert.equal(calls[1].url, "/api/stats");
      assert.equal(calls[1].headers["x-holdup-key"], undefined);

      keyMod.setAccessKey("wrong-key");
      await assert.rejects(() => apiMod.probeAuth(), (err: unknown) => err instanceof keyMod.AuthError);
      assert.equal(calls[2].headers["x-holdup-key"], "wrong-key");

      keyMod.setAccessKey(serverKey);
      await assert.doesNotReject(() => apiMod.probeAuth());
      assert.equal(calls[3].headers["x-holdup-key"], serverKey);
    } finally {
      keyMod.setAccessKey("");
      globalThis.fetch = prevFetch;
    }
  });

  test("probeAuth and verify distinguish transient 503/409 errors and timeouts from AuthError, and merge x-holdup-key on POST /api/verify", async (t: TestContext) => {
    installBrowserEnv({ search: "" });
    keyMod.setAccessKey("valid-key-99");
    const prevFetch = globalThis.fetch;
    const requests: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> | null }> = [];
    let mode: "ok" | "no_frames" | "json_no_msg" | "plain_502" | "hang" = "ok";

    const fakeVerdict: Verdict = {
      level: "match",
      headline: "Amlodipine 5 mg",
      speech: "Yes, Amlodipine 5 mg, your evening pill. You haven't taken it today.",
      read: {
        kind: "medication",
        product: { value: "Amlodipine", confidence: 0.97 },
        ingredient: { value: "amlodipine", confidence: 0.95 },
        strength: { value: "5 mg", confidence: 0.96 },
        dosing: { value: null, confidence: 0 },
        expiry: { value: "2027-08", confidence: 0.9 },
        allergens: { value: null, confidence: 0 },
        barcode: { value: null, confidence: 0 },
        readability: 0.93,
      },
      matchedMedId: "amlodipine",
      reasons: ["Name and strength match your list"],
      takenToday: false,
    };

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      requests.push({ url, headers, body });

      if (mode === "hang") {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const abortErr = new Error("The operation was aborted");
            abortErr.name = "AbortError";
            reject(abortErr);
          });
        });
      }
      if (mode === "no_frames") {
        return new Response(JSON.stringify({ type: "error", code: "no_frames", message: "no recent frames for this session" }), {
          status: 409,
          statusText: "Conflict",
          headers: { "content-type": "application/json" },
        });
      }
      if (mode === "json_no_msg") {
        return new Response(JSON.stringify({ status: "overloaded" }), {
          status: 503,
          statusText: "Service Unavailable",
          headers: { "content-type": "application/json" },
        });
      }
      if (mode === "plain_502") {
        return new Response("upstream gateway error", { status: 502, statusText: "Bad Gateway" });
      }
      return new Response(JSON.stringify(fakeVerdict), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const profile: Profile = storageMod.demoProfile();
      const vWithFrames = await apiMod.verify(["jpegFrameA", "jpegFrameB"], profile, {
        question: "Is this my evening pill?",
        session: "K7P9",
      });
      assert.equal(vWithFrames.level, "match");
      assert.equal(requests[0].url, "/api/verify");
      assert.equal(requests[0].headers["content-type"], "application/json");
      assert.equal(requests[0].headers["x-holdup-key"], "valid-key-99");
      assert.deepEqual(requests[0].body?.frames, ["jpegFrameA", "jpegFrameB"]);
      assert.deepEqual(requests[0].body?.profile, profile);
      assert.equal(requests[0].body?.session, "K7P9");
      assert.equal(requests[0].body?.question, "Is this my evening pill?");

      await apiMod.verify([], profile, { session: "GLASS1" });
      assert.equal("frames" in (requests[1].body ?? {}), false);
      assert.deepEqual(requests[1].body?.profile, profile);
      assert.equal(requests[1].body?.session, "GLASS1");

      mode = "no_frames";
      await assert.rejects(
        () => apiMod.verify([], profile, { session: "GLASS1" }),
        (err: unknown) => err instanceof Error && !(err instanceof keyMod.AuthError) && err.message === "no recent frames for this session",
      );

      mode = "json_no_msg";
      await assert.rejects(
        () => apiMod.probeAuth(),
        (err: unknown) => err instanceof Error && !(err instanceof keyMod.AuthError) && err.message === "503 Service Unavailable",
      );

      mode = "plain_502";
      await assert.rejects(
        () => apiMod.probeAuth(),
        (err: unknown) => err instanceof Error && !(err instanceof keyMod.AuthError) && err.message === "502 Bad Gateway",
      );

      t.mock.timers.enable({ apis: ["setTimeout"] });
      mode = "hang";
      const pending = apiMod.probeAuth();
      t.mock.timers.tick(4000);
      await assert.rejects(pending, (err: unknown) => err instanceof Error && err.name === "AbortError");

      let verifySettled = false;
      const pendingVerify = apiMod.verify(["frame1"], profile, { session: "K7P9" }).finally(() => {
        verifySettled = true;
      });
      t.mock.timers.tick(19900);
      await Promise.resolve();
      assert.equal(verifySettled, false);
      t.mock.timers.tick(200);
      await assert.rejects(pendingVerify, (err: unknown) => err instanceof Error && err.name === "AbortError");
    } finally {
      t.mock.timers.reset();
      keyMod.setAccessKey("");
      globalThis.fetch = prevFetch;
    }
  });
});

describe("feature flags (scene, datamatrix, addmed, sonar) parsing and negotiation", () => {
  test("FEATURES registry, default Settings, partial settings merge, and localFeatures preserve all four flags", () => {
    installBrowserEnv({ search: "" });
    const allFlags: FeatureFlag[] = ["scene", "datamatrix", "addmed", "sonar"];

    assert.deepEqual(
      storageMod.FEATURES.map((f) => f.flag),
      allFlags,
    );
    for (const item of storageMod.FEATURES) {
      assert.ok(item.label.length > 0);
      assert.ok(item.help.length > 10);
    }

    const defaults = storageMod.loadSettings();
    assert.deepEqual(defaults.features, {
      scene: true,
      datamatrix: true,
      addmed: true,
      sonar: true,
    });
    assert.deepEqual(checkerMod.localFeatures(), allFlags);

    localStorage.setItem("holdup.settings", JSON.stringify({ features: { scene: false, sonar: false } }));
    const partial = storageMod.loadSettings();
    assert.deepEqual(partial.features, {
      scene: false,
      datamatrix: true,
      addmed: true,
      sonar: false,
    });
    assert.deepEqual(checkerMod.localFeatures(), ["datamatrix", "addmed"]);

    storageMod.saveSettings({
      ...defaults,
      features: { scene: true, datamatrix: false, addmed: false, sonar: true },
    });
    assert.deepEqual(checkerMod.localFeatures(), ["scene", "sonar"]);

    const checkWithNullServer = { s: { serverFeatures: null as FeatureFlag[] | null } };
    assert.equal(checkerMod.Checker.prototype.feature.call(checkWithNullServer, "scene"), true);
    assert.equal(checkerMod.Checker.prototype.feature.call(checkWithNullServer, "datamatrix"), false);
    assert.equal(checkerMod.Checker.prototype.feature.call(checkWithNullServer, "addmed"), false);
    assert.equal(checkerMod.Checker.prototype.feature.call(checkWithNullServer, "sonar"), true);

    const checkWithSubsetServer = { s: { serverFeatures: ["scene", "datamatrix"] as FeatureFlag[] } };
    assert.equal(checkerMod.Checker.prototype.feature.call(checkWithSubsetServer, "scene"), true);
    assert.equal(checkerMod.Checker.prototype.feature.call(checkWithSubsetServer, "datamatrix"), false);
    assert.equal(checkerMod.Checker.prototype.feature.call(checkWithSubsetServer, "sonar"), false);
  });

  test("URL query parsing controls ?mock=1 IS_MOCK and ?mockaudio=1 synthesised PCM output", async (t: TestContext) => {
    assert.equal(mockMod.IS_MOCK, false);

    installBrowserEnv({ search: "?mock=0" });
    const mockZero = await importFreshMock("mock-zero");
    assert.equal(mockZero.IS_MOCK, false);

    installBrowserEnv({ search: "?mock=1&mockaudio=1" });
    const mockAudio = await importFreshMock("mock-one-audio");
    assert.equal(mockAudio.IS_MOCK, true);

    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const ws = new mockAudio.MockSocket();
    const msgs = collectSocketMessages(ws);
    try {
      t.mock.timers.tick(250);
      sendClient(ws, {
        type: "start",
        profile: storageMod.demoProfile(),
        lang: "en",
        voice: true,
        source: "phone",
      });
      sendClient(ws, { type: "event", name: "log_dose" });
      const audioMsgs = msgs.filter((m): m is Extract<ServerMsg, { type: "audio" }> => m.type === "audio");
      assert.ok(audioMsgs.length >= 1);
      for (const a of audioMsgs) {
        const bytes = audioMod.base64ToBytes(a.data);
        assert.ok(bytes.byteLength > 0 && bytes.byteLength % 2 === 0);
      }
    } finally {
      ws.close();
      t.mock.timers.tick(1);
      resetMockState(mockAudio);
      t.mock.timers.reset();
      installBrowserEnv({ search: "" });
    }
  });

  test("MockSocket gates sonar readiness, scene mode, datamatrix crossCheck, and addmed proposals on start.features", async (t: TestContext) => {
    installBrowserEnv({ search: "" });
    resetMockState();
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });

    const wsRestricted = new mockMod.MockSocket();
    const restrictedMsgs = collectSocketMessages(wsRestricted);
    try {
      t.mock.timers.tick(250);
      sendClient(wsRestricted, {
        type: "start",
        profile: storageMod.demoProfile(),
        lang: "en",
        voice: true,
        source: "phone",
        features: [],
      });

      const readyMsg = requireVal(
        restrictedMsgs.find((m): m is Extract<ServerMsg, { type: "ready" }> => m.type === "ready"),
      );
      assert.deepEqual(readyMsg.features, []);

      const rawCode = gs1Mod.makeGs1({ gtin: "06416542002149", expiry: "270800", batch: "LOT1" });
      sendClient(wsRestricted, { type: "datamatrix", raw: rawCode, ts: Date.now() });
      sendClient(wsRestricted, { type: "text", text: "Which one of the three on the table?" });
      advanceTimers(t, 13000);

      assert.equal(restrictedMsgs.some((m) => m.type === "readiness"), false);
      const restrictedVerdict = requireVal(
        restrictedMsgs.find((m): m is Extract<ServerMsg, { type: "verdict" }> => m.type === "verdict"),
      );
      assert.notEqual(restrictedVerdict.verdict.mode, "scene");
      assert.equal(restrictedVerdict.verdict.crossCheck, undefined);

      restrictedMsgs.length = 0;
      sendClient(wsRestricted, { type: "text", text: "I want to add my medicines" });
      advanceTimers(t, 13000);
      assert.equal(restrictedMsgs.some((m) => m.type === "profile_add"), false);
    } finally {
      wsRestricted.close();
      t.mock.timers.tick(1);
    }

    const wsFull = new mockMod.MockSocket();
    const fullMsgs = collectSocketMessages(wsFull);
    try {
      t.mock.timers.tick(250);
      sendClient(wsFull, {
        type: "start",
        profile: storageMod.demoProfile(),
        lang: "en",
        voice: true,
        source: "phone",
      });

      const readyFull = requireVal(
        fullMsgs.find((m): m is Extract<ServerMsg, { type: "ready" }> => m.type === "ready"),
      );
      assert.deepEqual(readyFull.features, ["scene", "datamatrix", "addmed", "sonar"]);

      const matchingRaw = gs1Mod.makeGs1({ gtin: "06416542002149", expiry: "270800", batch: "FIN1", serial: "SN9" });
      sendClient(wsFull, { type: "datamatrix", raw: matchingRaw, ts: Date.now() });
      sendClient(wsFull, { type: "text", text: "Is this my evening pill?" });
      advanceTimers(t, 13000);

      const readinessMsgs = fullMsgs.filter((m): m is Extract<ServerMsg, { type: "readiness" }> => m.type === "readiness");
      assert.ok(readinessMsgs.length > 10);
      assert.ok(readinessMsgs.every((r) => r.value >= 0 && r.value <= 0.97));
      assert.ok(readinessMsgs[readinessMsgs.length - 1].value > readinessMsgs[0].value);

      const matchWithCode = requireVal(
        fullMsgs.find((m): m is Extract<ServerMsg, { type: "verdict" }> => m.type === "verdict"),
      );
      assert.equal(matchWithCode.verdict.level, "match");
      assert.equal(matchWithCode.verdict.crossCheck?.source, "datamatrix");
      assert.equal(matchWithCode.verdict.crossCheck?.agrees, true);
      assert.equal(matchWithCode.verdict.crossCheck?.code.gtin, "06416542002149");

      fullMsgs.length = 0;
      const conflictingRaw = gs1Mod.makeGs1({ gtin: "06419999999999", expiry: "270800" });
      sendClient(wsFull, { type: "datamatrix", raw: conflictingRaw, ts: Date.now() });
      sendClient(wsFull, { type: "text", text: "Is this my evening pill?" });
      advanceTimers(t, 13000);

      const mismatchWithCode = requireVal(
        fullMsgs.find((m): m is Extract<ServerMsg, { type: "verdict" }> => m.type === "verdict"),
      );
      assert.equal(mismatchWithCode.verdict.crossCheck?.agrees, false);

      fullMsgs.length = 0;
      sendClient(wsFull, { type: "text", text: "I want to add my medicines to my list" });
      advanceTimers(t, 6200);

      const proposal = requireVal(
        fullMsgs.find((m): m is Extract<ServerMsg, { type: "profile_add" }> => m.type === "profile_add"),
      );
      assert.equal(proposal.med.name, "Lisinopril");
      assert.equal(proposal.med.strength, "10 mg");
      assert.deepEqual(proposal.med.schedule, ["morning"]);

      fullMsgs.length = 0;
      sendClient(wsFull, {
        type: "profile_add_result",
        proposalId: proposal.proposalId,
        accepted: true,
        med: proposal.med,
      });
      assert.ok(
        fullMsgs.some(
          (m) => m.type === "transcript" && m.role === "assistant" && m.text.includes("Added Lisinopril to your list."),
        ),
      );

      fullMsgs.length = 0;
      sendClient(wsFull, {
        type: "profile_add_result",
        proposalId: proposal.proposalId,
        accepted: false,
      });
      assert.ok(
        fullMsgs.some((m) => m.type === "transcript" && m.role === "assistant" && m.text === "Okay, I didn't add it."),
      );
    } finally {
      wsFull.close();
      t.mock.timers.tick(1);
      resetMockState();
      t.mock.timers.reset();
    }
  });
});

describe("?mock=1 scripted coach -> checking -> verdict + scene + HUD sync contract", () => {
  test("MockSocket executes ordered coach -> checking(start) -> checking(end) -> verdict + speech contract and routes scenarios", async (t: TestContext) => {
    installBrowserEnv({ search: "" });
    resetMockState();
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });

    const ws = new mockMod.MockSocket();
    const msgs = collectSocketMessages(ws);
    let opened = false;
    ws.onopen = () => {
      opened = true;
    };

    try {
      assert.equal(ws.readyState, 0);
      t.mock.timers.tick(250);
      assert.equal(opened, true);
      assert.equal(ws.readyState, 1);

      sendClient(ws, {
        type: "start",
        profile: storageMod.demoProfile(),
        lang: "en",
        voice: true,
        source: "phone",
      });

      assert.equal(msgs[0]?.type, "ready");
      assert.deepEqual(msgs[1], { type: "status", live: "open", detail: "Mock server: scripted demo" });

      t.mock.timers.tick(900);
      assert.ok(
        msgs.some(
          (m) => m.type === "transcript" && m.role === "assistant" && m.text === "Hi, I'm watching. Hold the box up in front of you.",
        ),
      );

      msgs.length = 0;
      sendClient(ws, { type: "text", text: "Is this my evening pill?" });
      advanceTimers(t, 12500);

      const sequence = msgs
        .filter((m) => m.type === "coach" || m.type === "checking" || m.type === "verdict")
        .map((m) => {
          if (m.type === "coach") return `coach:${m.cue}`;
          if (m.type === "checking") return `checking:${m.phase}`;
          return `verdict:${m.verdict.level}`;
        });

      assert.deepEqual(sequence, [
        "coach:other_side",
        "coach:rotate_left",
        "coach:closer",
        "coach:hold_still",
        "coach:ok",
        "checking:start",
        "checking:end",
        "verdict:match",
      ]);

      const matchVerdictMsg = requireVal(
        msgs.find((m): m is Extract<ServerMsg, { type: "verdict" }> => m.type === "verdict"),
      );
      assert.equal(matchVerdictMsg.verdict.matchedMedId, "amlodipine");
      assert.equal(matchVerdictMsg.verdict.headline, "Amlodipine 5 mg");

      const lastTranscript = [...msgs]
        .reverse()
        .find((m): m is Extract<ServerMsg, { type: "transcript" }> => m.type === "transcript" && m.role === "assistant");
      assert.equal(lastTranscript?.text, matchVerdictMsg.verdict.speech);

      msgs.length = 0;
      sendClient(ws, { type: "event", name: "repeat" });
      sendClient(ws, { type: "event", name: "log_dose" });
      assert.equal(msgs[0]?.type, "verdict");
      assert.ok(
        msgs.some((m) => m.type === "transcript" && m.role === "assistant" && m.text === "Logged. I'll remember you took it today."),
      );

      const prompts: Array<{ ask: string; expectedLevel: Verdict["level"]; expectedMode?: Verdict["mode"]; expectedText: RegExp }> = [
        { ask: "Can I take this ibuprofen for pain?", expectedLevel: "warning", expectedText: /Ibuprofen/ },
        { ask: "What is the metformin strength?", expectedLevel: "unsure", expectedText: /can't read the strength/ },
        { ask: "Does this food bar have nuts?", expectedLevel: "warning", expectedText: /hazelnut/ },
        { ask: "Which one of the three on the table is mine?", expectedLevel: "match", expectedMode: "scene", expectedText: /on the right/ },
      ];

      for (const p of prompts) {
        msgs.length = 0;
        sendClient(ws, { type: "text", text: p.ask });
        advanceTimers(t, 12500);
        const vMsg = requireVal(
          msgs.find((m): m is Extract<ServerMsg, { type: "verdict" }> => m.type === "verdict"),
          p.ask,
        );
        assert.equal(vMsg.verdict.level, p.expectedLevel, p.ask);
        assert.equal(vMsg.verdict.mode, p.expectedMode, p.ask);
        assert.match(vMsg.verdict.speech, p.expectedText);
        if (p.ask.includes("ibuprofen")) {
          msgs.length = 0;
          sendClient(ws, { type: "event", name: "log_dose" });
          assert.ok(
            msgs.some(
              (m) => m.type === "transcript" && m.role === "assistant" && m.text === "There's no matched medicine to log.",
            ),
          );
        }
      }

      const sceneVerdictMsg = requireVal(
        msgs.find((m): m is Extract<ServerMsg, { type: "verdict" }> => m.type === "verdict"),
      );
      assert.equal(sceneVerdictMsg.verdict.headline, "Your evening pill: on the right");
      assert.deepEqual(
        sceneVerdictMsg.verdict.items?.map((i) => ({ position: i.position, level: i.level, matchedMedId: i.matchedMedId })),
        [
          { position: "left", level: "unsure", matchedMedId: undefined },
          { position: "center", level: "warning", matchedMedId: undefined },
          { position: "right", level: "match", matchedMedId: "amlodipine" },
        ],
      );

      ws.send("{not-json");
      sendClient(ws, { type: "frame", data: "YWJj", w: 640, h: 480, sharpness: 22, ts: Date.now() });
      sendClient(ws, { type: "audio", data: "AAAA" });

      msgs.length = 0;
      sendClient(ws, { type: "text", text: "It looks blurry, what box is this?" });
      advanceTimers(t, 12500);
      assert.ok(msgs.some((m) => m.type === "verdict"));

      const loggedProfile = storageMod.logDose(storageMod.demoProfile(), "amlodipine");
      sendClient(ws, {
        type: "start",
        profile: loggedProfile,
        lang: "en",
        voice: true,
        source: "phone",
      });
      msgs.length = 0;
      sendClient(ws, { type: "text", text: "Is this my evening pill?" });
      advanceTimers(t, 12500);
      const alreadyTakenMsg = requireVal(
        msgs.find((m): m is Extract<ServerMsg, { type: "verdict" }> => m.type === "verdict"),
      );
      assert.equal(alreadyTakenMsg.verdict.level, "warning");
      assert.equal(alreadyTakenMsg.verdict.takenToday, true);
      assert.equal(alreadyTakenMsg.verdict.headline, "Amlodipine 5 mg: already taken today");

      msgs.length = 0;
      sendClient(ws, { type: "text", text: "Can I take ibuprofen?" });
      advanceTimers(t, 2000);
      sendClient(ws, { type: "event", name: "stop" });
      advanceTimers(t, 15000);
      assert.equal(msgs.some((m) => m.type === "verdict"), false);

      const autoWs = new mockMod.MockSocket();
      const autoMsgs = collectSocketMessages(autoWs);
      t.mock.timers.tick(250);
      sendClient(autoWs, {
        type: "start",
        profile: storageMod.demoProfile(),
        lang: "en",
        voice: true,
        source: "phone",
      });
      advanceTimers(t, 14000);
      const autoVerdicts = autoMsgs.filter((m) => m.type === "verdict");
      assert.equal(autoVerdicts.length, 1);
      autoWs.close();
      t.mock.timers.tick(1);
    } finally {
      ws.close();
      t.mock.timers.tick(1);
      resetMockState();
      t.mock.timers.reset();
    }
  });

  test("HUD BroadcastChannel sync mirrors only status, device, coach, and verdict (including scene) and forwards hud_event back", async (t: TestContext) => {
    installBrowserEnv({ search: "" });
    resetMockState();
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });

    const phoneSide = requireVal(mockMod.mockHudChannel());
    const hudSide = new BroadcastChannel(mockMod.MOCK_HUD_CHANNEL);
    const hudReceived: ServerMsg[] = [];
    const phoneHudEvents: Array<{ type?: string; name?: string }> = [];

    hudSide.onmessage = (ev: MessageEvent) => {
      hudReceived.push(ev.data as ServerMsg);
    };
    phoneSide.onmessage = (ev: MessageEvent<{ type?: string; name?: string }>) => {
      phoneHudEvents.push(ev.data);
    };

    const ws = new mockMod.MockSocket();
    const phoneMsgs = collectSocketMessages(ws);
    try {
      t.mock.timers.tick(250);
      mockMod.mockCtl.device = { connected: true, worn: true, battery: 82, streaming: true, source: "glasses" };

      sendClient(ws, {
        type: "start",
        profile: storageMod.demoProfile(),
        lang: "en",
        voice: true,
        source: "glasses",
      });
      sendClient(ws, { type: "ping", t: 12345 });
      sendClient(ws, { type: "text", text: "Which one on the table?" });
      advanceTimers(t, 12500);
      await waitUntil(() => hudReceived.length >= 8);

      assert.ok(phoneMsgs.some((m) => m.type === "ready"));
      assert.ok(phoneMsgs.some((m) => m.type === "transcript"));
      assert.ok(phoneMsgs.some((m) => m.type === "readiness"));
      assert.ok(phoneMsgs.some((m) => m.type === "checking"));
      assert.ok(phoneMsgs.some((m) => m.type === "pong"));

      const allowedTypes = new Set(["status", "device", "coach", "verdict"]);
      assert.ok(hudReceived.length >= 8);
      for (const m of hudReceived) {
        assert.ok(allowedTypes.has(m.type), `unexpected HUD message type: ${m.type}`);
      }

      const hudCues = hudReceived
        .filter((m): m is Extract<ServerMsg, { type: "coach" }> => m.type === "coach")
        .map((m) => m.cue);
      assert.deepEqual(hudCues, ["other_side", "rotate_left", "closer", "hold_still", "ok"]);

      const hudVerdict = requireVal(
        hudReceived.find((m): m is Extract<ServerMsg, { type: "verdict" }> => m.type === "verdict"),
      );
      assert.equal(hudVerdict.verdict.mode, "scene");
      assert.equal(hudVerdict.verdict.items?.length, 3);

      hudSide.postMessage({ type: "hud_event", name: "log_dose" });
      hudSide.postMessage({ type: "hud_event", name: "repeat" });
      await waitUntil(() => phoneHudEvents.length >= 2);
      assert.deepEqual(phoneHudEvents, [
        { type: "hud_event", name: "log_dose" },
        { type: "hud_event", name: "repeat" },
      ]);
    } finally {
      ws.close();
      t.mock.timers.tick(1);
      hudSide.close();
      phoneSide.close();
      resetMockState();
      t.mock.timers.reset();
    }

    const prevBC = globalThis.BroadcastChannel;
    Object.defineProperty(globalThis, "BroadcastChannel", {
      value: class BrokenChannel {
        constructor() {
          throw new Error("BroadcastChannel disabled");
        }
      },
      configurable: true,
      writable: true,
    });
    try {
      assert.equal(mockMod.mockHudChannel(), null);
    } finally {
      Object.defineProperty(globalThis, "BroadcastChannel", {
        value: prevBC,
        configurable: true,
        writable: true,
      });
    }
  });

  test("mockCtl failure, slow RTT, geminiDown, device push, and mockFetch health/verify/offline contracts", async (t: TestContext) => {
    installBrowserEnv({ search: "" });
    resetMockState();
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });

    try {
      mockMod.mockCtl.failConnects = 1;
      const failedWs = new mockMod.MockSocket();
      let errored = false;
      let closeCode = 0;
      failedWs.onerror = () => {
        errored = true;
      };
      failedWs.onclose = (ev: CloseEvent) => {
        closeCode = ev.code;
      };
      t.mock.timers.tick(900);
      assert.equal(errored, true);
      assert.equal(closeCode, 1006);
      assert.equal(failedWs.readyState, 3);
      assert.equal(mockMod.mockCtl.failConnects, 0);
      assert.equal(mockMod.mockCtl.sockets.has(failedWs), false);

      mockMod.mockCtl.offline = true;
      const offlineWs = new mockMod.MockSocket();
      let offlineErrored = false;
      let offlineCloseCode = 0;
      let offlineCloseReason = "";
      offlineWs.onerror = () => {
        offlineErrored = true;
      };
      offlineWs.onclose = (ev: CloseEvent) => {
        offlineCloseCode = ev.code;
        offlineCloseReason = ev.reason;
      };
      t.mock.timers.tick(900);
      assert.equal(offlineErrored, true);
      assert.equal(offlineCloseCode, 1006);
      assert.equal(offlineCloseReason, "Server unreachable (mock)");
      assert.equal(offlineWs.readyState, 3);
      assert.equal(mockMod.mockCtl.sockets.has(offlineWs), false);
      mockMod.mockCtl.offline = false;

      const ws = new mockMod.MockSocket();
      const msgs = collectSocketMessages(ws);
      t.mock.timers.tick(250);
      assert.equal(ws.readyState, 1);

      mockMod.mockCtl.geminiDown = true;
      sendClient(ws, {
        type: "start",
        profile: storageMod.demoProfile(),
        lang: "en",
        voice: true,
        source: "phone",
      });
      assert.ok(msgs.some((m) => m.type === "status" && m.live === "degraded"));
      t.mock.timers.tick(5000);
      assert.equal(msgs.some((m) => m.type === "verdict"), false);

      msgs.length = 0;
      mockMod.mockSetGeminiDown(false);
      assert.deepEqual(msgs, [{ type: "status", live: "open", detail: "Gemini Live is back" }]);

      msgs.length = 0;
      mockMod.mockSetDevice({ connected: true, worn: false, battery: 19, streaming: false, source: "glasses" });
      assert.equal(msgs.length, 1);
      assert.equal(msgs[0].type, "device");
      if (msgs[0].type === "device") {
        assert.equal(msgs[0].device.battery, 19);
        assert.equal(msgs[0].device.worn, false);
      }

      msgs.length = 0;
      mockMod.mockCtl.slow = false;
      sendClient(ws, { type: "ping", t: 555 });
      t.mock.timers.tick(110);
      assert.deepEqual(msgs, [{ type: "pong", t: 555 }]);

      msgs.length = 0;
      mockMod.mockCtl.slow = true;
      sendClient(ws, { type: "ping", t: 777 });
      t.mock.timers.tick(1050);
      assert.equal(msgs.length, 0);
      t.mock.timers.tick(500);
      assert.deepEqual(msgs, [{ type: "pong", t: 777 }]);

      const healthOkP = mockMod.mockFetch("/api/health");
      t.mock.timers.tick(1000);
      const healthOk = (await healthOkP) as { ok: boolean; gemini: string; version: string };
      assert.equal(healthOk.ok, true);
      assert.equal(healthOk.gemini, "ok");
      assert.equal(healthOk.version, "mock");

      msgs.length = 0;
      mockMod.mockSetGeminiDown(true);
      assert.deepEqual(msgs, [{ type: "status", live: "degraded", detail: "Gemini Live is unavailable (simulated)" }]);
      const healthDownP = mockMod.mockFetch("/api/health");
      t.mock.timers.tick(1000);
      const healthDown = (await healthDownP) as { gemini: string };
      assert.equal(healthDown.gemini, "down");

      const seenLevels: Verdict["level"][] = [];
      for (let i = 0; i < 3; i++) {
        const vp = mockMod.mockFetch("/api/verify", { profile: storageMod.demoProfile() });
        t.mock.timers.tick(1000);
        const v = (await vp) as Verdict;
        seenLevels.push(v.level);
      }
      assert.deepEqual([...seenLevels].sort(), ["match", "unsure", "warning"]);

      const unknownP = mockMod.mockFetch("/api/unknown");
      t.mock.timers.tick(1000);
      await assert.rejects(unknownP, /mock: unknown path \/api\/unknown/);

      mockMod.mockCtl.offline = true;
      const offlineP = mockMod.mockFetch("/api/health");
      t.mock.timers.tick(1000);
      await assert.rejects(offlineP, (err: unknown) => err instanceof TypeError);

      ws.close();
      t.mock.timers.tick(1);
    } finally {
      resetMockState();
      t.mock.timers.reset();
    }
  });
});
