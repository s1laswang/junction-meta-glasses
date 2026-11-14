import type { VerdictLevel } from "../types.ts";

export type EarconKind =
  | "camera_on"
  | "camera_off"
  | "checking"
  | "match"
  | "warning"
  | "unsure"
  | "info"
  | "cue";

export type EarconSpec = {
  notesHz: number[];
  noteMs: number;
  wave: OscillatorType;
  gain: number;
  vibratePattern: number[];
};

const SPECS: Record<EarconKind, EarconSpec> = {
  camera_on: {
    notesHz: [440, 659.25],
    noteMs: 70,
    wave: "sine",
    gain: 0.14,
    vibratePattern: [30]
  },
  camera_off: {
    notesHz: [659.25, 440],
    noteMs: 75,
    wave: "sine",
    gain: 0.12,
    vibratePattern: [20, 35, 20]
  },
  checking: {
    notesHz: [523.25],
    noteMs: 45,
    wave: "sine",
    gain: 0.05,
    vibratePattern: [12]
  },
  match: {
    notesHz: [523.25, 659.25, 783.99],
    noteMs: 95,
    wave: "triangle",
    gain: 0.18,
    vibratePattern: [45, 50, 90]
  },
  warning: {
    notesHz: [830.61, 493.88],
    noteMs: 140,
    wave: "square",
    gain: 0.16,
    vibratePattern: [140, 70, 140, 70, 180]
  },
  unsure: {
    notesHz: [392, 392],
    noteMs: 80,
    wave: "triangle",
    gain: 0.13,
    vibratePattern: [40, 60, 40]
  },
  info: {
    notesHz: [587.33, 783.99],
    noteMs: 85,
    wave: "sine",
    gain: 0.14,
    vibratePattern: [50]
  },
  cue: {
    notesHz: [698.46],
    noteMs: 55,
    wave: "triangle",
    gain: 0.1,
    vibratePattern: [22]
  }
};

export function earconSpec(kind: EarconKind): {
  notesHz: number[];
  noteMs: number;
  wave: OscillatorType;
  gain: number;
  vibratePattern: number[];
} {
  const spec = SPECS[kind];
  return {
    notesHz: [...spec.notesHz],
    noteMs: spec.noteMs,
    wave: spec.wave,
    gain: spec.gain,
    vibratePattern: [...spec.vibratePattern]
  };
}

export function verdictEarcon(level: VerdictLevel): EarconKind {
  switch (level) {
    case "match":
      return "match";
    case "warning":
      return "warning";
    case "unsure":
      return "unsure";
    case "info":
      return "info";
  }
}

type AudioContextCtor = new () => AudioContext;

type AudioGlobals = {
  AudioContext?: AudioContextCtor;
  webkitAudioContext?: AudioContextCtor;
  navigator?: { vibrate?: (pattern: number[]) => boolean };
  window?: {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
    navigator?: { vibrate?: (pattern: number[]) => boolean };
  };
};

let sharedCtx: AudioContext | null = null;
let sharedCtor: AudioContextCtor | null = null;

function getAudioContext(): AudioContext | null {
  const g = globalThis as unknown as AudioGlobals;
  const Ctor =
    g.AudioContext ??
    g.webkitAudioContext ??
    g.window?.AudioContext ??
    g.window?.webkitAudioContext;
  if (typeof Ctor !== "function") {
    return null;
  }
  if (!sharedCtx || sharedCtor !== Ctor || sharedCtx.state === "closed") {
    sharedCtx = new Ctor();
    sharedCtor = Ctor;
  }
  if (sharedCtx.state === "suspended" && typeof sharedCtx.resume === "function") {
    void sharedCtx.resume().catch(() => {});
  }
  return sharedCtx;
}

function triggerHaptics(pattern: number[]): void {
  const g = globalThis as unknown as AudioGlobals;
  try {
    if (g.window?.navigator && typeof g.window.navigator.vibrate === "function") {
      g.window.navigator.vibrate(pattern);
      return;
    }
    if (g.navigator && typeof g.navigator.vibrate === "function") {
      g.navigator.vibrate(pattern);
    }
  } catch {
    return;
  }
}

export function playEarcon(
  kind: EarconKind,
  opts?: { muted?: boolean; haptics?: boolean }
): void {
  const spec = earconSpec(kind);

  if (opts?.haptics !== false && spec.vibratePattern.length > 0) {
    triggerHaptics(spec.vibratePattern);
  }

  if (opts?.muted) {
    return;
  }

  try {
    const ctx = getAudioContext();
    if (!ctx) {
      return;
    }
    const baseTime = ctx.currentTime;
    const noteDurSec = spec.noteMs / 1000;
    const stepSec = noteDurSec + 0.012;
    const attackSec = Math.min(0.012, noteDurSec * 0.25);
    const floorGain = 0.0001;

    spec.notesHz.forEach((hz, idx) => {
      const startAt = baseTime + idx * stepSec;
      const stopAt = startAt + noteDurSec;
      const osc = ctx.createOscillator();
      const gainNode = ctx.createGain();

      osc.type = spec.wave;
      if (typeof osc.frequency.setValueAtTime === "function") {
        osc.frequency.setValueAtTime(hz, startAt);
      } else {
        osc.frequency.value = hz;
      }

      gainNode.gain.setValueAtTime(floorGain, startAt);
      gainNode.gain.linearRampToValueAtTime(spec.gain, startAt + attackSec);
      if (typeof gainNode.gain.exponentialRampToValueAtTime === "function") {
        gainNode.gain.exponentialRampToValueAtTime(floorGain, stopAt);
      } else {
        gainNode.gain.linearRampToValueAtTime(floorGain, stopAt);
      }

      osc.connect(gainNode);
      gainNode.connect(ctx.destination);

      osc.onended = () => {
        try {
          osc.disconnect();
          gainNode.disconnect();
        } catch {
          return;
        }
      };

      osc.start(startAt);
      osc.stop(stopAt + 0.002);
    });
  } catch {
    return;
  }
}

const CHECKING_PULSE_MS = 1200;

export function startCheckingPulse(opts?: {
  muted?: boolean;
  haptics?: boolean;
}): () => void {
  let stopped = false;
  playEarcon("checking", { muted: opts?.muted, haptics: opts?.haptics });

  const timer = setInterval(() => {
    if (stopped) {
      return;
    }
    playEarcon("checking", { muted: opts?.muted, haptics: opts?.haptics });
  }, CHECKING_PULSE_MS);

  const maybeNodeTimer = timer as unknown as { unref?: () => void };
  maybeNodeTimer.unref?.();

  return () => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearInterval(timer);
  };
}
