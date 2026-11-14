export type SpeakFallbackOptions = {
  lang?: string;
  preferServerTts?: boolean;
  fetchImpl?: typeof fetch;
};

type AudioContextCtor = new () => AudioContext;
type AudioElementCtor = new (src?: string) => HTMLAudioElement;
type UtteranceCtor = new (text?: string) => SpeechSynthesisUtterance;

type SpeechGlobals = {
  Audio?: AudioElementCtor;
  AudioContext?: AudioContextCtor;
  webkitAudioContext?: AudioContextCtor;
  speechSynthesis?: SpeechSynthesis;
  SpeechSynthesisUtterance?: UtteranceCtor;
  navigator?: { onLine?: boolean };
  window?: {
    Audio?: AudioElementCtor;
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
    speechSynthesis?: SpeechSynthesis;
    SpeechSynthesisUtterance?: UtteranceCtor;
    navigator?: { onLine?: boolean };
  };
};

const LANG_MAP: Record<string, string> = {
  en: "en-US",
  fi: "fi-FI",
  sv: "sv-SE",
  de: "de-DE",
  fr: "fr-FR",
  es: "es-ES",
  nb: "nb-NO",
  no: "nb-NO",
  da: "da-DK",
  et: "et-EE"
};

export function resolveLangTag(lang?: string): string {
  const raw = lang?.trim();
  if (!raw) {
    return "en-US";
  }
  const normalized = raw.replace(/_/g, "-");
  if (normalized.includes("-")) {
    const [primary, region, ...rest] = normalized.split("-");
    const formatted = [
      primary.toLowerCase(),
      region ? (region.length === 2 ? region.toUpperCase() : region) : "",
      ...rest
    ].filter(Boolean);
    return formatted.join("-");
  }
  const lower = normalized.toLowerCase();
  return LANG_MAP[lower] ?? lower;
}

let activeGeneration = 0;
let activeAbort: AbortController | null = null;
let activeStopPlayback: (() => void) | null = null;
let ttsAudioCtx: AudioContext | null = null;
let ttsAudioCtor: AudioContextCtor | null = null;

function isOnline(): boolean {
  const g = globalThis as unknown as SpeechGlobals;
  if (typeof g.window?.navigator?.onLine === "boolean") {
    return g.window.navigator.onLine;
  }
  if (typeof g.navigator?.onLine === "boolean") {
    return g.navigator.onLine;
  }
  return true;
}

function getSpeechSynthesis(): SpeechSynthesis | null {
  const g = globalThis as unknown as SpeechGlobals;
  const synth = g.window?.speechSynthesis ?? g.speechSynthesis;
  if (!synth) {
    return null;
  }
  return synth;
}

export function cancelSpeech(): void {
  activeGeneration += 1;

  if (activeAbort) {
    try {
      activeAbort.abort();
    } catch {
      activeAbort = null;
    }
    activeAbort = null;
  }

  if (activeStopPlayback) {
    const stop = activeStopPlayback;
    activeStopPlayback = null;
    try {
      stop();
    } catch {
      activeStopPlayback = null;
    }
  }

  const g = globalThis as unknown as SpeechGlobals;
  const synths = new Set<SpeechSynthesis>();
  if (g.window?.speechSynthesis) {
    synths.add(g.window.speechSynthesis);
  }
  if (g.speechSynthesis) {
    synths.add(g.speechSynthesis);
  }
  for (const synth of synths) {
    if (typeof synth.cancel === "function") {
      try {
        synth.cancel();
      } catch {
        continue;
      }
    }
  }
}

async function playViaAudioElement(bytes: ArrayBuffer, gen: number): Promise<boolean> {
  const g = globalThis as unknown as SpeechGlobals;
  const AudioCtor = g.window?.Audio ?? g.Audio;
  if (
    typeof AudioCtor !== "function" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function" ||
    typeof Blob === "undefined"
  ) {
    return false;
  }

  const blob = new Blob([bytes], { type: "audio/wav" });
  const objectUrl = URL.createObjectURL(blob);
  let revoked = false;
  const revoke = () => {
    if (!revoked && typeof URL.revokeObjectURL === "function") {
      revoked = true;
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {
        return;
      }
    }
  };

  try {
    const audio = new AudioCtor(objectUrl);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        if (activeStopPlayback === stopPlayback) {
          activeStopPlayback = null;
        }
        audio.onended = null;
        audio.onerror = null;
        revoke();
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      };

      const stopPlayback = () => {
        try {
          audio.pause();
        } catch {
          finish();
          return;
        }
        finish();
      };

      if (gen !== activeGeneration) {
        finish();
        return;
      }

      activeStopPlayback = stopPlayback;
      audio.onended = () => finish();
      audio.onerror = () => finish(new Error("audio playback error"));

      try {
        const maybePromise = audio.play();
        if (maybePromise && typeof maybePromise.then === "function") {
          maybePromise.then(
            () => {
              if (audio.ended) {
                finish();
              }
            },
            (err: unknown) => {
              finish(err instanceof Error ? err : new Error("audio play rejected"));
            }
          );
        } else if (audio.ended) {
          finish();
        }
      } catch (err) {
        finish(err instanceof Error ? err : new Error("audio play threw"));
      }
    });
    return true;
  } catch {
    revoke();
    return false;
  }
}

async function playViaAudioContext(bytes: ArrayBuffer, gen: number): Promise<boolean> {
  const g = globalThis as unknown as SpeechGlobals;
  const Ctor =
    g.window?.AudioContext ??
    g.window?.webkitAudioContext ??
    g.AudioContext ??
    g.webkitAudioContext;
  if (typeof Ctor !== "function") {
    return false;
  }

  try {
    if (!ttsAudioCtx || ttsAudioCtor !== Ctor || ttsAudioCtx.state === "closed") {
      ttsAudioCtx = new Ctor();
      ttsAudioCtor = Ctor;
    }
    if (ttsAudioCtx.state === "suspended" && typeof ttsAudioCtx.resume === "function") {
      await ttsAudioCtx.resume().catch(() => {});
    }
    const decoded = await ttsAudioCtx.decodeAudioData(bytes.slice(0));
    if (gen !== activeGeneration) {
      return true;
    }

    const source = ttsAudioCtx.createBufferSource();
    source.buffer = decoded;
    source.connect(ttsAudioCtx.destination);

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        if (activeStopPlayback === stopSource) {
          activeStopPlayback = null;
        }
        source.onended = null;
        try {
          source.disconnect();
        } catch {
          resolve();
          return;
        }
        resolve();
      };

      const stopSource = () => {
        try {
          source.stop();
        } catch {
          finish();
          return;
        }
        finish();
      };

      activeStopPlayback = stopSource;
      source.onended = () => finish();
      source.start(0);
    });
    return true;
  } catch {
    return false;
  }
}

async function tryServerTts(
  text: string,
  fetchFn: typeof fetch,
  gen: number
): Promise<boolean> {
  const controller = new AbortController();
  activeAbort = controller;

  try {
    const res = await fetchFn("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: controller.signal
    });

    if (activeAbort === controller) {
      activeAbort = null;
    }

    if (gen !== activeGeneration) {
      return true;
    }

    const contentType = (res.headers?.get?.("content-type") ?? "").toLowerCase();
    const isWav =
      contentType.includes("audio/wav") ||
      contentType.includes("audio/wave") ||
      contentType.includes("audio/x-wav");

    if (res.status !== 200 || !isWav) {
      return false;
    }

    const bytes = await res.arrayBuffer();
    if (gen !== activeGeneration) {
      return true;
    }
    if (bytes.byteLength === 0) {
      return false;
    }

    if (await playViaAudioElement(bytes, gen)) {
      return true;
    }
    if (gen !== activeGeneration) {
      return true;
    }
    if (await playViaAudioContext(bytes, gen)) {
      return true;
    }
    return false;
  } catch {
    if (activeAbort === controller) {
      activeAbort = null;
    }
    if (gen !== activeGeneration) {
      return true;
    }
    return false;
  }
}

function speakViaBrowserSynthesis(text: string, langTag: string, gen: number): Promise<void> {
  if (gen !== activeGeneration) {
    return Promise.resolve();
  }
  const synth = getSpeechSynthesis();
  if (!synth || typeof synth.speak !== "function") {
    return Promise.resolve();
  }

  const g = globalThis as unknown as SpeechGlobals;
  const Utterance = g.window?.SpeechSynthesisUtterance ?? g.SpeechSynthesisUtterance;
  const utterance: SpeechSynthesisUtterance =
    typeof Utterance === "function"
      ? new Utterance(text)
      : ({
          text,
          lang: langTag,
          voice: null,
          volume: 1,
          rate: 1,
          pitch: 1,
          onstart: null,
          onend: null,
          onerror: null,
          onpause: null,
          onresume: null,
          onmark: null,
          onboundary: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false
        } as unknown as SpeechSynthesisUtterance);

  utterance.lang = langTag;

  if (typeof synth.getVoices === "function") {
    try {
      const voices = synth.getVoices();
      if (Array.isArray(voices) && voices.length > 0) {
        const lowerTag = langTag.toLowerCase();
        const prefix = lowerTag.split("-")[0];
        const exact = voices.find((v) => v.lang?.toLowerCase() === lowerTag);
        const partial = voices.find((v) => v.lang?.toLowerCase().startsWith(prefix));
        const chosen = exact ?? partial;
        if (chosen) {
          utterance.voice = chosen;
        }
      }
    } catch {
      utterance.voice = null;
    }
  }

  return new Promise<void>((resolve) => {
    let settled = false;
    const timeoutMs = typeof synth.speaking === "boolean" ? 15000 : 40;
    const safetyTimer = setTimeout(() => finish(), timeoutMs);
    const maybeNodeTimer = safetyTimer as unknown as { unref?: () => void };
    maybeNodeTimer.unref?.();

    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(safetyTimer);
      if (activeStopPlayback === finish) {
        activeStopPlayback = null;
      }
      utterance.onend = null;
      utterance.onerror = null;
      resolve();
    };

    activeStopPlayback = finish;
    utterance.onend = () => finish();
    utterance.onerror = () => finish();

    try {
      synth.speak(utterance);
    } catch {
      finish();
    }
  });
}

export async function speakFallback(
  text: string,
  opts?: { lang?: string; preferServerTts?: boolean; fetchImpl?: typeof fetch }
): Promise<void> {
  cancelSpeech();
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }

  const gen = activeGeneration;
  const langTag = resolveLangTag(opts?.lang);

  if (opts?.preferServerTts && isOnline()) {
    const fetchFn = opts.fetchImpl ?? (typeof fetch === "function" ? fetch : undefined);
    if (fetchFn) {
      const played = await tryServerTts(trimmed, fetchFn, gen);
      if (played || gen !== activeGeneration) {
        return;
      }
    }
  }

  if (gen !== activeGeneration) {
    return;
  }

  await speakViaBrowserSynthesis(trimmed, langTag, gen);
}
