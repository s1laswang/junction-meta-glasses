import {
  earconSpec,
  playEarcon,
  startCheckingPulse,
  verdictEarcon,
  type EarconKind
} from "../src/audio/earcons.ts";
import { cancelSpeech, resolveLangTag, speakFallback } from "../src/audio/tts.ts";

type TestContext = {
  mock: {
    timers: {
      enable(opts?: { apis?: string[] }): void;
      tick(ms: number): void;
    };
  };
};

type TestFn = (
  name: string,
  fn: (t: TestContext) => void | Promise<void>
) => Promise<void>;

type AssertStrict = {
  ok(value: unknown, message?: string): void;
  equal<T>(actual: T, expected: T, message?: string): void;
  deepEqual<T>(actual: T, expected: T, message?: string): void;
  doesNotThrow(block: () => unknown, message?: string): void;
  doesNotReject(block: () => Promise<unknown>, message?: string): Promise<void>;
};

const nodeTestSpec: string = "node:test";
const nodeAssertSpec: string = "node:assert/strict";

const { test } = (await import(nodeTestSpec)) as { test: TestFn };
const assert = (await import(nodeAssertSpec)) as AssertStrict;

const ALL_KINDS: EarconKind[] = [
  "camera_on",
  "camera_off",
  "checking",
  "match",
  "warning",
  "unsure",
  "info",
  "cue"
];

test("earconSpec provides distinct acoustic and haptic signatures for all 8 kinds", () => {
  const acousticKeys = new Set<string>();
  const hapticKeys = new Set<string>();

  for (const kind of ALL_KINDS) {
    const spec = earconSpec(kind);
    assert.ok(spec.notesHz.length >= 1, `${kind} must have at least one note`);
    assert.ok(spec.notesHz.every((hz) => Number.isFinite(hz) && hz > 0));
    assert.ok(spec.noteMs > 0);
    assert.ok(spec.gain > 0 && spec.gain <= 1);
    assert.ok(spec.vibratePattern.length >= 1);
    assert.ok(spec.vibratePattern.every((ms) => ms > 0));

    acousticKeys.add(`${spec.wave}:${spec.noteMs}:${spec.notesHz.join(",")}`);
    hapticKeys.add(spec.vibratePattern.join(","));
  }

  assert.equal(acousticKeys.size, ALL_KINDS.length);
  assert.equal(hapticKeys.size, ALL_KINDS.length);

  const matchSpec = earconSpec("match");
  assert.ok(matchSpec.notesHz.length >= 3);
  for (let i = 1; i < matchSpec.notesHz.length; i += 1) {
    assert.ok(matchSpec.notesHz[i] > matchSpec.notesHz[i - 1]);
  }

  const warningSpec = earconSpec("warning");
  assert.equal(warningSpec.notesHz.length, 2);
  assert.ok(warningSpec.notesHz[0] > warningSpec.notesHz[1]);

  const unsureSpec = earconSpec("unsure");
  assert.equal(unsureSpec.notesHz.length, 2);
  assert.equal(unsureSpec.notesHz[0], unsureSpec.notesHz[1]);
  assert.equal(unsureSpec.vibratePattern.length, 3);

  const camOn = earconSpec("camera_on");
  const camOff = earconSpec("camera_off");
  assert.ok(camOn.notesHz[0] < camOn.notesHz[1]);
  assert.ok(camOff.notesHz[0] > camOff.notesHz[1]);

  const checkingSpec = earconSpec("checking");
  assert.ok(checkingSpec.gain < matchSpec.gain);
  assert.ok(checkingSpec.gain < warningSpec.gain);

  const mutated = earconSpec("match");
  mutated.notesHz.push(9999);
  mutated.vibratePattern.push(999);
  assert.deepEqual(earconSpec("match"), matchSpec);
});

test("verdictEarcon maps all VerdictLevel values accurately", () => {
  assert.equal(verdictEarcon("match"), "match");
  assert.equal(verdictEarcon("warning"), "warning");
  assert.equal(verdictEarcon("unsure"), "unsure");
  assert.equal(verdictEarcon("info"), "info");
});

test("safe no-op in headless Node environment without window or AudioContext", async () => {
  const g = globalThis as Record<string, unknown>;
  const prevWindow = g.window;
  const prevAudioCtx = g.AudioContext;
  delete g.window;
  delete g.AudioContext;

  try {
    assert.equal(typeof g.window, "undefined");
    for (const kind of ALL_KINDS) {
      assert.doesNotThrow(() => playEarcon(kind));
    }
    const stop = startCheckingPulse();
    assert.doesNotThrow(() => stop());
    await assert.doesNotReject(() => speakFallback("Amlodipine 5 mg", { lang: "en" }));
    assert.doesNotThrow(() => cancelSpeech());
  } finally {
    if (prevWindow !== undefined) g.window = prevWindow;
    if (prevAudioCtx !== undefined) g.AudioContext = prevAudioCtx;
  }
});

test("playEarcon synthesizes smooth gain envelopes and respects muted and haptics options", () => {
  const g = globalThis as Record<string, unknown>;
  const prevWindow = g.window;
  const prevAudioCtx = g.AudioContext;

  const createdOscillators: Array<{
    type: string;
    freqs: number[];
    started: number[];
    stopped: number[];
  }> = [];
  const gainRamps: Array<{
    initial: number[];
    linear: number[];
    exponential: number[];
  }> = [];
  const vibrations: number[][] = [];

  class MockAudioContext {
    state = "running";
    currentTime = 1.0;
    destination = {};
    createOscillator() {
      const rec = { type: "sine", freqs: [] as number[], started: [] as number[], stopped: [] as number[] };
      createdOscillators.push(rec);
      return {
        get type() {
          return rec.type;
        },
        set type(v: string) {
          rec.type = v;
        },
        frequency: {
          value: 440,
          setValueAtTime(hz: number) {
            rec.freqs.push(hz);
          }
        },
        connect() {},
        disconnect() {},
        start(t: number) {
          rec.started.push(t);
        },
        stop(t: number) {
          rec.stopped.push(t);
        },
        onended: null as (() => void) | null
      };
    }
    createGain() {
      const ramp = { initial: [] as number[], linear: [] as number[], exponential: [] as number[] };
      gainRamps.push(ramp);
      return {
        gain: {
          setValueAtTime(v: number) {
            ramp.initial.push(v);
          },
          linearRampToValueAtTime(v: number) {
            ramp.linear.push(v);
          },
          exponentialRampToValueAtTime(v: number) {
            ramp.exponential.push(v);
          }
        },
        connect() {},
        disconnect() {}
      };
    }
  }

  g.AudioContext = MockAudioContext;
  g.window = {
    AudioContext: MockAudioContext,
    navigator: {
      vibrate(pattern: number[]) {
        vibrations.push(pattern);
        return true;
      }
    }
  };

  try {
    playEarcon("match");
    assert.equal(createdOscillators.length, 3);
    assert.equal(gainRamps.length, 3);
    assert.ok(gainRamps.every((r) => r.initial.length === 1 && r.linear.length === 1 && r.exponential.length === 1));
    assert.equal(vibrations.length, 1);
    assert.deepEqual(vibrations[0], earconSpec("match").vibratePattern);

    playEarcon("warning", { muted: true });
    assert.equal(createdOscillators.length, 3);
    assert.equal(vibrations.length, 2);

    playEarcon("cue", { haptics: false });
    assert.equal(createdOscillators.length, 4);
    assert.equal(vibrations.length, 2);
  } finally {
    delete g.window;
    delete g.AudioContext;
    if (prevWindow !== undefined) g.window = prevWindow;
    if (prevAudioCtx !== undefined) g.AudioContext = prevAudioCtx;
  }
});

test("startCheckingPulse ticks every 1200ms and stops cleanly on cleanup", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });

  const g = globalThis as Record<string, unknown>;
  const prevWindow = g.window;
  let tickCount = 0;

  g.window = {
    navigator: {
      vibrate(pattern: number[]) {
        assert.deepEqual(pattern, earconSpec("checking").vibratePattern);
        tickCount += 1;
        return true;
      }
    }
  };

  try {
    const stop = startCheckingPulse({ muted: true });
    assert.equal(tickCount, 1);

    t.mock.timers.tick(1200);
    assert.equal(tickCount, 2);

    t.mock.timers.tick(1200);
    assert.equal(tickCount, 3);

    stop();
    stop();

    t.mock.timers.tick(3600);
    assert.equal(tickCount, 3);
  } finally {
    delete g.window;
    if (prevWindow !== undefined) g.window = prevWindow;
  }
});

test("speakFallback falls back from /api/tts failure to speechSynthesis with mapped language tags", async () => {
  const g = globalThis as Record<string, unknown>;
  const prevWindow = g.window;

  const spoken: Array<{ text: string; lang: string }> = [];
  let cancelCalls = 0;
  const fetchCalls: Array<{ url: string; body: string }> = [];

  class MockUtterance {
    text: string;
    lang = "";
    voice: unknown = null;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(text = "") {
      this.text = text;
    }
  }

  g.window = {
    navigator: { onLine: true },
    SpeechSynthesisUtterance: MockUtterance,
    speechSynthesis: {
      speaking: false,
      pending: false,
      cancel() {
        cancelCalls += 1;
      },
      getVoices() {
        return [];
      },
      speak(u: MockUtterance) {
        spoken.push({ text: u.text, lang: u.lang });
        u.onend?.();
      }
    }
  };

  const failingFetch: typeof fetch = async (input, init) => {
    fetchCalls.push({
      url: String(input),
      body: typeof init?.body === "string" ? init.body : ""
    });
    return new Response(JSON.stringify({ code: "gemini_unavailable" }), {
      status: 503,
      headers: { "Content-Type": "application/json" }
    });
  };

  const throwingFetch: typeof fetch = async (input, init) => {
    fetchCalls.push({
      url: String(input),
      body: typeof init?.body === "string" ? init.body : ""
    });
    throw new Error("network down");
  };

  try {
    assert.equal(resolveLangTag("fi"), "fi-FI");
    assert.equal(resolveLangTag("sv"), "sv-SE");
    assert.equal(resolveLangTag("en"), "en-US");

    await speakFallback("Ota iltalääke.", {
      lang: "fi",
      preferServerTts: true,
      fetchImpl: failingFetch
    });

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, "/api/tts");
    assert.deepEqual(JSON.parse(fetchCalls[0].body), { text: "Ota iltalääke." });
    assert.equal(spoken.length, 1);
    assert.deepEqual(spoken[0], { text: "Ota iltalääke.", lang: "fi-FI" });
    assert.ok(cancelCalls >= 1);

    await speakFallback("Ta kvällstabletten.", {
      lang: "sv",
      preferServerTts: true,
      fetchImpl: throwingFetch
    });

    assert.equal(fetchCalls.length, 2);
    assert.equal(spoken.length, 2);
    assert.deepEqual(spoken[1], { text: "Ta kvällstabletten.", lang: "sv-SE" });

    await speakFallback("Amlodipine 5 mg.", {
      lang: "en",
      preferServerTts: false,
      fetchImpl: throwingFetch
    });

    assert.equal(fetchCalls.length, 2);
    assert.equal(spoken.length, 3);
    assert.deepEqual(spoken[2], { text: "Amlodipine 5 mg.", lang: "en-US" });
  } finally {
    delete g.window;
    if (prevWindow !== undefined) g.window = prevWindow;
  }
});

test("speakFallback plays 200 audio/wav response without invoking speechSynthesis", async () => {
  const g = globalThis as Record<string, unknown>;
  const prevWindow = g.window;

  let synthSpoken = 0;
  let decodedBytes = 0;
  let sourceStarted = false;

  class MockDecodeAudioContext {
    state = "running";
    destination = {};
    async decodeAudioData(buf: ArrayBuffer) {
      decodedBytes = buf.byteLength;
      return { duration: 0.1 };
    }
    createBufferSource() {
      const node = {
        buffer: null as unknown,
        onended: null as (() => void) | null,
        connect() {},
        disconnect() {},
        stop() {
          node.onended?.();
        },
        start() {
          sourceStarted = true;
          queueMicrotask(() => node.onended?.());
        }
      };
      return node;
    }
  }

  g.window = {
    navigator: { onLine: true },
    AudioContext: MockDecodeAudioContext,
    speechSynthesis: {
      speaking: false,
      cancel() {},
      speak() {
        synthSpoken += 1;
      }
    }
  };

  const wavFetch: typeof fetch = async () => {
    const fakeWav = new Uint8Array([82, 73, 70, 70, 4, 0, 0, 0, 87, 65, 86, 69]);
    return new Response(fakeWav, {
      status: 200,
      headers: { "Content-Type": "audio/wav" }
    });
  };

  try {
    await speakFallback("Yes, evening pill.", {
      lang: "en",
      preferServerTts: true,
      fetchImpl: wavFetch
    });
    assert.equal(decodedBytes, 12);
    assert.equal(sourceStarted, true);
    assert.equal(synthSpoken, 0);
  } finally {
    delete g.window;
    if (prevWindow !== undefined) g.window = prevWindow;
  }
});

test("speakFallback skips /api/tts when offline and cancelSpeech aborts in-flight server TTS without speaking", async () => {
  const g = globalThis as Record<string, unknown>;
  const prevWindow = g.window;

  const spoken: string[] = [];
  let serverHits = 0;
  let aborted = false;

  const mockNav = { onLine: false };
  g.window = {
    navigator: mockNav,
    speechSynthesis: {
      speaking: false,
      cancel() {},
      speak(u: { text: string; onend?: (() => void) | null }) {
        spoken.push(u.text);
        u.onend?.();
      }
    }
  };

  const slowFetch: typeof fetch = (_input, init) => {
    serverHits += 1;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("aborted"));
      });
    });
  };

  try {
    await speakFallback("Offline barcode match.", {
      lang: "en",
      preferServerTts: true,
      fetchImpl: slowFetch
    });
    assert.equal(serverHits, 0);
    assert.deepEqual(spoken, ["Offline barcode match."]);

    mockNav.onLine = true;
    const inflight = speakFallback("Interrupted sentence.", {
      lang: "en",
      preferServerTts: true,
      fetchImpl: slowFetch
    });
    assert.equal(serverHits, 1);
    cancelSpeech();
    await inflight;
    assert.equal(aborted, true);
    assert.deepEqual(spoken, ["Offline barcode match."]);
  } finally {
    delete g.window;
    if (prevWindow !== undefined) g.window = prevWindow;
  }
});
