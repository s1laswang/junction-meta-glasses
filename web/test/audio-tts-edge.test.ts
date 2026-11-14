import {
  earconSpec,
  playEarcon,
  startCheckingPulse,
  type EarconKind
} from "../src/audio/earcons.ts";
import { cancelSpeech, resolveLangTag, speakFallback } from "../src/audio/tts.ts";
import { SUPPORTED_LANGUAGES } from "../src/i18n/translations.ts";

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
  notEqual<T>(actual: T, expected: T, message?: string): void;
  deepEqual<T>(actual: T, expected: T, message?: string): void;
  doesNotThrow(block: () => unknown, message?: string): void;
  doesNotReject(block: () => Promise<unknown>, message?: string): Promise<void>;
};

const nodeTestSpec: string = "node:test";
const nodeAssertSpec: string = "node:assert/strict";

const { test } = (await import(nodeTestSpec)) as { test: TestFn };
const assert = (await import(nodeAssertSpec)) as AssertStrict;

const BCP47_PATTERN = /^[a-z]{2,3}(?:-[A-Z]{2}|-[a-zA-Z0-9]{2,8})*$/;

const ALL_EARCON_KINDS: EarconKind[] = [
  "camera_on",
  "camera_off",
  "checking",
  "match",
  "warning",
  "unsure",
  "info",
  "cue"
];

class MockSpeechUtterance {
  text: string;
  lang = "";
  voice: unknown = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(text = "") {
    this.text = text;
  }
}

test("speakFallback maps all supported multilingual codes and unknown ja to valid BCP-47 tags without throwing", async () => {
  const g = globalThis as Record<string, unknown>;
  const prevWindow = g.window;

  const recorded: Array<{ text: string; lang: string }> = [];

  g.window = {
    navigator: { onLine: true },
    SpeechSynthesisUtterance: MockSpeechUtterance,
    speechSynthesis: {
      speaking: false,
      cancel() {},
      getVoices() {
        return [];
      },
      speak(u: MockSpeechUtterance) {
        recorded.push({ text: u.text, lang: u.lang });
        u.onend?.();
      }
    }
  };

  const expectedByCode: Array<{ input: string | undefined; expected: string }> = [
    { input: "fi", expected: "fi-FI" },
    { input: "sv", expected: "sv-SE" },
    { input: "de", expected: "de-DE" },
    { input: "es", expected: "es-ES" },
    { input: "fr", expected: "fr-FR" },
    { input: "et", expected: "et-EE" },
    { input: "ru", expected: "ru" },
    { input: "en", expected: "en-US" },
    { input: "ja", expected: "ja" },
    { input: "  FI_fi ", expected: "fi-FI" },
    { input: "SV_fi", expected: "sv-FI" },
    { input: "RU_ru", expected: "ru-RU" },
    { input: "JA-jp", expected: "ja-JP" },
    { input: "", expected: "en-US" },
    { input: undefined, expected: "en-US" }
  ];

  try {
    const supportedCodes = SUPPORTED_LANGUAGES.map((entry) => entry.code);
    assert.deepEqual(supportedCodes, ["en", "fi", "sv", "de", "es", "fr", "et", "ru"]);

    for (const { input, expected } of expectedByCode) {
      assert.equal(resolveLangTag(input), expected);
      const phrase = `Dose check ${input ?? "default"}`;
      await assert.doesNotReject(() =>
        speakFallback(phrase, { lang: input, preferServerTts: false })
      );
      const latest = recorded[recorded.length - 1];
      assert.equal(latest.text, phrase.trim());
      assert.equal(latest.lang, expected);
      assert.ok(BCP47_PATTERN.test(latest.lang), `Invalid BCP-47 format: ${latest.lang}`);
      const canonical = Intl.getCanonicalLocales(latest.lang);
      assert.equal(canonical.length, 1);
    }

    assert.equal(recorded.length, expectedByCode.length);
  } finally {
    delete g.window;
    if (prevWindow !== undefined) g.window = prevWindow;
  }
});

test("speakFallback binds exact or prefix-matched SpeechSynthesisVoice and recovers when getVoices throws", async () => {
  const g = globalThis as Record<string, unknown>;
  const prevWindow = g.window;

  const chosenVoices: Array<{ lang: string; voiceName: string | null }> = [];
  let throwOnVoices = false;

  const voices = [
    { name: "Suomi Voice", lang: "fi-FI" },
    { name: "Svenska Sverige", lang: "sv-SE" },
    { name: "Svenska Finland", lang: "sv-FI" },
    { name: "Russkiy Voice", lang: "ru-RU" },
    { name: "Nihongo Voice", lang: "ja-JP" }
  ];

  g.window = {
    navigator: { onLine: true },
    SpeechSynthesisUtterance: MockSpeechUtterance,
    speechSynthesis: {
      speaking: false,
      cancel() {},
      getVoices() {
        if (throwOnVoices) {
          throw new Error("voices unavailable");
        }
        return voices;
      },
      speak(u: MockSpeechUtterance) {
        const v = u.voice as { name?: string } | null;
        chosenVoices.push({ lang: u.lang, voiceName: v?.name ?? null });
        u.onend?.();
      }
    }
  };

  try {
    await speakFallback("Svenska i Finland", { lang: "sv-FI" });
    await speakFallback("Russkiy tekst", { lang: "ru" });
    await speakFallback("Nihongo tekisuto", { lang: "ja" });
    await speakFallback("Eesti tekst", { lang: "et" });

    throwOnVoices = true;
    await assert.doesNotReject(() => speakFallback("Turvallinen varapolku", { lang: "fi" }));

    assert.deepEqual(chosenVoices, [
      { lang: "sv-FI", voiceName: "Svenska Finland" },
      { lang: "ru", voiceName: "Russkiy Voice" },
      { lang: "ja", voiceName: "Nihongo Voice" },
      { lang: "et-EE", voiceName: null },
      { lang: "fi-FI", voiceName: null }
    ]);
  } finally {
    delete g.window;
    if (prevWindow !== undefined) g.window = prevWindow;
  }
});

test("speakFallback treats empty and whitespace-only strings as clean no-ops without fetching or speaking", async () => {
  const g = globalThis as Record<string, unknown>;
  const prevWindow = g.window;

  let fetchCount = 0;
  let speakCount = 0;
  let cancelCount = 0;

  g.window = {
    navigator: { onLine: true },
    SpeechSynthesisUtterance: MockSpeechUtterance,
    speechSynthesis: {
      speaking: false,
      cancel() {
        cancelCount += 1;
      },
      speak() {
        speakCount += 1;
      }
    }
  };

  const countingFetch: typeof fetch = async () => {
    fetchCount += 1;
    return new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 200,
      headers: { "Content-Type": "audio/wav" }
    });
  };

  try {
    await speakFallback("   ", {
      lang: "en",
      preferServerTts: true,
      fetchImpl: countingFetch
    });
    await speakFallback("", {
      lang: "fi",
      preferServerTts: true,
      fetchImpl: countingFetch
    });
    await speakFallback("\t\n\r  ", {
      lang: "sv",
      preferServerTts: false,
      fetchImpl: countingFetch
    });

    assert.equal(fetchCount, 0);
    assert.equal(speakCount, 0);
    assert.equal(cancelCount, 3);
  } finally {
    delete g.window;
    if (prevWindow !== undefined) g.window = prevWindow;
  }
});

test("rapid consecutive speakFallback calls abort earlier in-flight /api/tts signals and only speak latest verdict", async () => {
  const g = globalThis as Record<string, unknown>;
  const prevWindow = g.window;

  const events: string[] = [];
  const spoken: Array<{ text: string; lang: string }> = [];
  const signals: AbortSignal[] = [];
  const resolvers: Array<(res: Response) => void> = [];

  g.window = {
    navigator: { onLine: true },
    SpeechSynthesisUtterance: MockSpeechUtterance,
    speechSynthesis: {
      speaking: false,
      cancel() {
        events.push("synth:cancel");
      },
      getVoices() {
        return [];
      },
      speak(u: MockSpeechUtterance) {
        events.push(`synth:speak:${u.text}`);
        spoken.push({ text: u.text, lang: u.lang });
        u.onend?.();
      }
    }
  };

  const controlledFetch: typeof fetch = (_input, init) => {
    const idx = signals.length + 1;
    const sig = init?.signal as AbortSignal;
    signals.push(sig);
    events.push(`fetch:start:${idx}`);
    sig.addEventListener("abort", () => {
      events.push(`fetch:abort:${idx}`);
    });
    return new Promise<Response>((resolve) => {
      resolvers.push(resolve);
    });
  };

  try {
    const first = speakFallback("First stale verdict", {
      lang: "en",
      preferServerTts: true,
      fetchImpl: controlledFetch
    });
    assert.equal(signals.length, 1);
    assert.equal(signals[0].aborted, false);

    const second = speakFallback("Second superseded verdict", {
      lang: "de",
      preferServerTts: true,
      fetchImpl: controlledFetch
    });
    assert.equal(signals.length, 2);
    assert.equal(signals[0].aborted, true);
    assert.equal(signals[1].aborted, false);

    const third = speakFallback("Final confirmed verdict", {
      lang: "fi",
      preferServerTts: true,
      fetchImpl: controlledFetch
    });
    assert.equal(signals.length, 3);
    assert.equal(signals[1].aborted, true);
    assert.equal(signals[2].aborted, false);

    resolvers[0](
      new Response(new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]), {
        status: 200,
        headers: { "Content-Type": "audio/wav" }
      })
    );
    resolvers[1](
      new Response(JSON.stringify({ error: "aborted" }), {
        status: 503,
        headers: { "Content-Type": "application/json" }
      })
    );
    resolvers[2](
      new Response(JSON.stringify({ error: "tts_offline" }), {
        status: 503,
        headers: { "Content-Type": "application/json" }
      })
    );

    await Promise.all([first, second, third]);

    assert.deepEqual(spoken, [{ text: "Final confirmed verdict", lang: "fi-FI" }]);
    const abort2Pos = events.indexOf("fetch:abort:2");
    const finalSpeakPos = events.indexOf("synth:speak:Final confirmed verdict");
    assert.ok(abort2Pos >= 0 && abort2Pos < finalSpeakPos);
  } finally {
    delete g.window;
    if (prevWindow !== undefined) g.window = prevWindow;
  }
});

test("barge-in speakFallback cancels an in-progress speechSynthesis utterance before speaking the latest verdict", async () => {
  const g = globalThis as Record<string, unknown>;
  const prevWindow = g.window;

  const callOrder: string[] = [];
  let activeUtterance: MockSpeechUtterance | null = null;

  const synthMock = {
    speaking: false,
    cancel() {
      callOrder.push("cancel");
      synthMock.speaking = false;
      activeUtterance = null;
    },
    getVoices() {
      return [];
    },
    speak(u: MockSpeechUtterance) {
      callOrder.push(`speak:${u.lang}:${u.text}`);
      activeUtterance = u;
      if (u.text.startsWith("Latest")) {
        synthMock.speaking = false;
        u.onend?.();
      } else {
        synthMock.speaking = true;
      }
    }
  };

  g.window = {
    navigator: { onLine: true },
    SpeechSynthesisUtterance: MockSpeechUtterance,
    speechSynthesis: synthMock
  };

  try {
    let firstResolved = false;
    const p1 = speakFallback("Initial long reading that gets interrupted", {
      lang: "en"
    }).then(() => {
      firstResolved = true;
    });

    await Promise.resolve();
    assert.ok(activeUtterance !== null);
    assert.equal(firstResolved, false);

    const p2 = speakFallback("Latest safety warning", { lang: "es" });
    await Promise.all([p1, p2]);

    assert.equal(firstResolved, true);
    assert.deepEqual(callOrder, [
      "cancel",
      "speak:en-US:Initial long reading that gets interrupted",
      "cancel",
      "speak:es-ES:Latest safety warning"
    ]);
  } finally {
    delete g.window;
    if (prevWindow !== undefined) g.window = prevWindow;
  }
});

test("whitespace-only speakFallback aborts prior in-flight /api/tts request without issuing new speech", async () => {
  const g = globalThis as Record<string, unknown>;
  const prevWindow = g.window;

  let fetchCalls = 0;
  let speakCalls = 0;
  let capturedSignal: AbortSignal | undefined;

  g.window = {
    navigator: { onLine: true },
    SpeechSynthesisUtterance: MockSpeechUtterance,
    speechSynthesis: {
      speaking: false,
      cancel() {},
      speak() {
        speakCalls += 1;
      }
    }
  };

  const hangingFetch: typeof fetch = (_input, init) => {
    fetchCalls += 1;
    capturedSignal = init?.signal ?? undefined;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new Error("aborted by whitespace barge-in"));
      });
    });
  };

  try {
    const inflight = speakFallback("Pending verdict", {
      lang: "en",
      preferServerTts: true,
      fetchImpl: hangingFetch
    });
    assert.equal(fetchCalls, 1);
    assert.equal(capturedSignal?.aborted, false);

    await speakFallback("   ", {
      lang: "en",
      preferServerTts: true,
      fetchImpl: hangingFetch
    });
    await inflight;

    assert.equal(capturedSignal?.aborted, true);
    assert.equal(fetchCalls, 1);
    assert.equal(speakCalls, 0);
  } finally {
    delete g.window;
    if (prevWindow !== undefined) g.window = prevWindow;
  }
});

test("barge-in during active HTMLAudioElement WAV playback pauses audio and speaks the new verdict", async () => {
  const g = globalThis as Record<string, unknown>;
  const prevWindow = g.window;
  const prevCreateObjectUrl = URL.createObjectURL;
  const prevRevokeObjectUrl = URL.revokeObjectURL;

  let pausedCount = 0;
  const revokedUrls: string[] = [];
  const spoken: Array<{ text: string; lang: string }> = [];

  class HangingAudioElement {
    src: string;
    ended = false;
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;

    constructor(src = "") {
      this.src = src;
    }

    play(): Promise<void> {
      return Promise.resolve();
    }

    pause(): void {
      pausedCount += 1;
    }
  }

  URL.createObjectURL = () => "blob:holdup-tts-test";
  URL.revokeObjectURL = (url: string) => {
    revokedUrls.push(url);
  };

  g.window = {
    navigator: { onLine: true },
    Audio: HangingAudioElement,
    SpeechSynthesisUtterance: MockSpeechUtterance,
    speechSynthesis: {
      speaking: false,
      cancel() {},
      getVoices() {
        return [];
      },
      speak(u: MockSpeechUtterance) {
        spoken.push({ text: u.text, lang: u.lang });
        u.onend?.();
      }
    }
  };

  const wavFetch: typeof fetch = async () =>
    new Response(new Uint8Array([82, 73, 70, 70, 4, 0, 0, 0, 87, 65, 86, 69]), {
      status: 200,
      headers: { "Content-Type": "audio/wav" }
    });

  try {
    const first = speakFallback("Server audio playing", {
      lang: "en",
      preferServerTts: true,
      fetchImpl: wavFetch
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    assert.equal(pausedCount, 0);

    const second = speakFallback("Replacement French verdict", {
      lang: "fr",
      preferServerTts: false
    });

    await Promise.all([first, second]);

    assert.equal(pausedCount, 1);
    assert.deepEqual(revokedUrls, ["blob:holdup-tts-test"]);
    assert.deepEqual(spoken, [{ text: "Replacement French verdict", lang: "fr-FR" }]);
  } finally {
    URL.createObjectURL = prevCreateObjectUrl;
    URL.revokeObjectURL = prevRevokeObjectUrl;
    delete g.window;
    if (prevWindow !== undefined) g.window = prevWindow;
  }
});

test("playEarcon recovers gracefully when navigator.vibrate throws SecurityError and still synthesizes audio", () => {
  const g = globalThis as Record<string, unknown>;
  const prevWindow = g.window;
  const prevAudioCtx = g.AudioContext;
  const prevNavDesc = Object.getOwnPropertyDescriptor(globalThis, "navigator");

  let vibrateAttempts = 0;
  let startedOscillators = 0;

  class MockRunningAudioContext {
    state = "running";
    currentTime = 0;
    destination = {};
    createOscillator() {
      return {
        type: "sine",
        frequency: { value: 440, setValueAtTime() {} },
        connect() {},
        disconnect() {},
        start() {
          startedOscillators += 1;
        },
        stop() {},
        onended: null as (() => void) | null
      };
    }
    createGain() {
      return {
        gain: {
          setValueAtTime() {},
          linearRampToValueAtTime() {},
          exponentialRampToValueAtTime() {}
        },
        connect() {},
        disconnect() {}
      };
    }
  }

  const throwSecurityError = (): boolean => {
    vibrateAttempts += 1;
    const err = new Error("Blocked call to navigator.vibrate before user gesture");
    err.name = "SecurityError";
    throw err;
  };

  g.AudioContext = MockRunningAudioContext;
  g.window = {
    AudioContext: MockRunningAudioContext,
    navigator: {
      vibrate: throwSecurityError
    }
  };

  try {
    for (const kind of ALL_EARCON_KINDS) {
      assert.doesNotThrow(() => playEarcon(kind));
    }

    const expectedNotes = ALL_EARCON_KINDS.reduce(
      (sum, kind) => sum + earconSpec(kind).notesHz.length,
      0
    );
    assert.equal(vibrateAttempts, ALL_EARCON_KINDS.length);
    assert.equal(startedOscillators, expectedNotes);

    delete g.window;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      writable: true,
      value: { vibrate: throwSecurityError }
    });

    assert.doesNotThrow(() => playEarcon("warning"));
    assert.equal(vibrateAttempts, ALL_EARCON_KINDS.length + 1);
    assert.equal(startedOscillators, expectedNotes + earconSpec("warning").notesHz.length);
  } finally {
    delete g.window;
    delete g.AudioContext;
    if (prevWindow !== undefined) g.window = prevWindow;
    if (prevAudioCtx !== undefined) g.AudioContext = prevAudioCtx;
    if (prevNavDesc) {
      Object.defineProperty(globalThis, "navigator", prevNavDesc);
    } else {
      delete g.navigator;
    }
  }
});

test("playEarcon recovers gracefully when suspended AudioContext.resume rejects or throws synchronously", async () => {
  const g = globalThis as Record<string, unknown>;
  const prevWindow = g.window;
  const prevAudioCtx = g.AudioContext;

  let resumeCalls = 0;
  let oscStarts = 0;

  class RejectingSuspendedAudioContext {
    state = "suspended";
    currentTime = 2.5;
    destination = {};

    resume(): Promise<void> {
      resumeCalls += 1;
      const err = new Error("AudioContext was not allowed to start");
      err.name = "NotAllowedError";
      return Promise.reject(err);
    }

    createOscillator() {
      return {
        type: "sine",
        frequency: { value: 440, setValueAtTime() {} },
        connect() {},
        disconnect() {},
        start() {
          oscStarts += 1;
        },
        stop() {},
        onended: null as (() => void) | null
      };
    }

    createGain() {
      return {
        gain: {
          setValueAtTime() {},
          linearRampToValueAtTime() {},
          exponentialRampToValueAtTime() {}
        },
        connect() {},
        disconnect() {}
      };
    }
  }

  class SyncThrowingResumeAudioContext extends RejectingSuspendedAudioContext {
    override resume(): Promise<void> {
      resumeCalls += 1;
      throw new Error("Synchronous resume failure");
    }
  }

  try {
    g.AudioContext = RejectingSuspendedAudioContext;
    g.window = { AudioContext: RejectingSuspendedAudioContext };

    assert.doesNotThrow(() => playEarcon("match", { haptics: false }));
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    assert.equal(resumeCalls, 1);
    assert.equal(oscStarts, earconSpec("match").notesHz.length);

    g.AudioContext = SyncThrowingResumeAudioContext;
    g.window = { AudioContext: SyncThrowingResumeAudioContext };

    assert.doesNotThrow(() => playEarcon("warning", { haptics: false }));
    assert.equal(resumeCalls, 2);
  } finally {
    delete g.window;
    delete g.AudioContext;
    if (prevWindow !== undefined) g.window = prevWindow;
    if (prevAudioCtx !== undefined) g.AudioContext = prevAudioCtx;
  }
});

test("speakFallback handles suspended AudioContext.resume rejection during server WAV playback cleanly", async () => {
  const g = globalThis as Record<string, unknown>;
  const prevWindow = g.window;

  let resumeAttempted = 0;
  let bufferPlayed = false;
  let synthCalled = 0;

  class SuspendedTtsAudioContext {
    state = "suspended";
    destination = {};

    resume(): Promise<void> {
      resumeAttempted += 1;
      return Promise.reject(new Error("Autoplay policy blocked resume"));
    }

    async decodeAudioData(buf: ArrayBuffer) {
      return { byteLength: buf.byteLength };
    }

    createBufferSource() {
      const source = {
        buffer: null as unknown,
        onended: null as (() => void) | null,
        connect() {},
        disconnect() {},
        stop() {
          source.onended?.();
        },
        start() {
          bufferPlayed = true;
          queueMicrotask(() => source.onended?.());
        }
      };
      return source;
    }
  }

  g.window = {
    navigator: { onLine: true },
    AudioContext: SuspendedTtsAudioContext,
    speechSynthesis: {
      speaking: false,
      cancel() {},
      speak() {
        synthCalled += 1;
      }
    }
  };

  const wavFetch: typeof fetch = async () =>
    new Response(new Uint8Array([82, 73, 70, 70, 8, 0, 0, 0, 87, 65, 86, 69]), {
      status: 200,
      headers: { "Content-Type": "audio/x-wav" }
    });

  try {
    await assert.doesNotReject(() =>
      speakFallback("Confirmed morning tablet", {
        lang: "en",
        preferServerTts: true,
        fetchImpl: wavFetch
      })
    );
    assert.equal(resumeAttempted, 1);
    assert.equal(bufferPlayed, true);
    assert.equal(synthCalled, 0);
  } finally {
    delete g.window;
    if (prevWindow !== undefined) g.window = prevWindow;
  }
});

test("multiple startCheckingPulse instances operate independently and remain idempotent across repeated stop calls", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });

  const g = globalThis as Record<string, unknown>;
  const prevWindow = g.window;
  const prevAudioCtx = g.AudioContext;

  let audioPulseCount = 0;
  let hapticPulseCount = 0;

  class PulseMockAudioContext {
    state = "running";
    currentTime = 0;
    destination = {};

    createOscillator() {
      return {
        type: "sine",
        frequency: { value: 523.25, setValueAtTime() {} },
        connect() {},
        disconnect() {},
        start() {
          audioPulseCount += 1;
        },
        stop() {},
        onended: null as (() => void) | null
      };
    }

    createGain() {
      return {
        gain: {
          setValueAtTime() {},
          linearRampToValueAtTime() {},
          exponentialRampToValueAtTime() {}
        },
        connect() {},
        disconnect() {}
      };
    }
  }

  g.AudioContext = PulseMockAudioContext;
  g.window = {
    AudioContext: PulseMockAudioContext,
    navigator: {
      vibrate() {
        hapticPulseCount += 1;
        return true;
      }
    }
  };

  try {
    const stopAudioOnly = startCheckingPulse({ muted: false, haptics: false });
    const stopHapticOnly = startCheckingPulse({ muted: true, haptics: true });

    assert.equal(audioPulseCount, 1);
    assert.equal(hapticPulseCount, 1);

    t.mock.timers.tick(600);
    const stopStaggeredAudio = startCheckingPulse({ muted: false, haptics: false });
    assert.equal(audioPulseCount, 2);
    assert.equal(hapticPulseCount, 1);

    t.mock.timers.tick(600);
    assert.equal(audioPulseCount, 3);
    assert.equal(hapticPulseCount, 2);

    assert.doesNotThrow(() => {
      stopAudioOnly();
      stopAudioOnly();
      stopAudioOnly();
    });

    t.mock.timers.tick(600);
    assert.equal(audioPulseCount, 4);
    assert.equal(hapticPulseCount, 2);

    t.mock.timers.tick(600);
    assert.equal(audioPulseCount, 4);
    assert.equal(hapticPulseCount, 3);

    assert.doesNotThrow(() => {
      stopHapticOnly();
      stopHapticOnly();
    });

    t.mock.timers.tick(1200);
    assert.equal(audioPulseCount, 5);
    assert.equal(hapticPulseCount, 3);

    assert.doesNotThrow(() => {
      stopStaggeredAudio();
      stopStaggeredAudio();
    });

    t.mock.timers.tick(4800);
    assert.equal(audioPulseCount, 5);
    assert.equal(hapticPulseCount, 3);
  } finally {
    delete g.window;
    delete g.AudioContext;
    if (prevWindow !== undefined) g.window = prevWindow;
    if (prevAudioCtx !== undefined) g.AudioContext = prevAudioCtx;
  }
});
