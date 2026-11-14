// Non-visual feedback: earcons (Web Audio), haptics (navigator.vibrate), speech (speechSynthesis),
// and a global announcer that feeds the aria-live regions in <Announcer/>.
import type { CoachCue, VerdictLevel } from "../../../shared/types.ts";
import { loadSettings } from "./storage.ts";

let ctx: AudioContext | null = null;
function ac(): AudioContext | null {
  try {
    if (!ctx) ctx = new (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** Call once from a user gesture so later earcons can play on iOS. */
export function unlockFeedback() {
  ac();
}

type Note = { f: number; d: number; type?: OscillatorType; gap?: number; vol?: number };
function play(notes: Note[]) {
  if (!loadSettings().earcons) return;
  const c = ac();
  if (!c) return;
  let t = c.currentTime + 0.01;
  for (const n of notes) {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = n.type ?? "sine";
    o.frequency.value = n.f;
    const v = n.vol ?? 0.18;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(v, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + n.d);
    o.connect(g).connect(c.destination);
    o.start(t);
    o.stop(t + n.d + 0.02);
    t += n.d + (n.gap ?? 0.03);
  }
}

// Each verdict has a distinct melodic contour, so it is recognisable without seeing the screen.
export const earcon = {
  start: () => play([{ f: 523, d: 0.09 }, { f: 784, d: 0.14 }]),
  stop: () => play([{ f: 784, d: 0.09 }, { f: 523, d: 0.14 }]),
  coach: () => play([{ f: 880, d: 0.05, vol: 0.1 }]),
  checking: () => play([{ f: 659, d: 0.16, type: "sine", vol: 0.07, gap: 0.12 }, { f: 784, d: 0.16, type: "sine", vol: 0.07, gap: 0.12 }, { f: 988, d: 0.28, type: "sine", vol: 0.06 }]), // soft rising shimmer
  ok: () => play([{ f: 988, d: 0.06, vol: 0.12 }, { f: 988, d: 0.06, vol: 0.12 }]),
  match: () => play([{ f: 523, d: 0.11 }, { f: 659, d: 0.11 }, { f: 784, d: 0.22 }]), // rising major arpeggio
  warning: () => play([{ f: 330, d: 0.18, type: "square", vol: 0.1 }, { f: 330, d: 0.18, type: "square", vol: 0.1, gap: 0.08 }, { f: 262, d: 0.3, type: "square", vol: 0.1 }]), // low insistent buzz
  unsure: () => play([{ f: 587, d: 0.14, type: "triangle" }, { f: 523, d: 0.14, type: "triangle" }, { f: 587, d: 0.2, type: "triangle" }]), // questioning wobble
  info: () => play([{ f: 659, d: 0.12, type: "triangle" }]),
  alert: () => play([{ f: 440, d: 0.1, type: "triangle" }, { f: 349, d: 0.16, type: "triangle" }]),
};

export const haptic = {
  pattern(p: number | number[]) {
    if (!loadSettings().haptics) return;
    try {
      navigator.vibrate?.(p);
    } catch {
      /* ignore */
    }
  },
  start: () => haptic.pattern(60),
  stop: () => haptic.pattern([40, 60, 40]),
  verdict: (l: VerdictLevel) => haptic.pattern(l === "match" ? [90, 70, 90] : l === "warning" ? [300, 120, 300, 120, 300] : l === "unsure" ? [160, 120, 60] : 60),
  coach: (cue: CoachCue) =>
    haptic.pattern(
      cue === "rotate_left" ? [30, 40, 30] : cue === "rotate_right" ? [30, 40, 30, 40, 30] : cue === "closer" ? [15, 30, 15, 30, 15, 30, 15] : cue === "farther" ? [120] : cue === "hold_still" ? [200] : cue === "ok" ? [40, 40, 120] : 30,
    ),
};

export function earconForVerdict(l: VerdictLevel) {
  earcon[l]();
}

export function speak(text: string, opts: { interrupt?: boolean; lang?: string } = {}) {
  if (!loadSettings().voice) return;
  const s = window.speechSynthesis;
  if (!s || !text) return;
  try {
    if (opts.interrupt !== false) s.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = opts.lang ?? "en-GB";
    u.rate = 1;
    s.speak(u);
  } catch {
    /* ignore */
  }
}
export function stopSpeaking() {
  try {
    window.speechSynthesis?.cancel();
  } catch {
    /* ignore */
  }
}

// ---- announcer -------------------------------------------------------------
type Politeness = "polite" | "assertive";
type Listener = (msg: string, p: Politeness) => void;
const listeners = new Set<Listener>();
export function announce(msg: string, p: Politeness = "polite") {
  for (const l of listeners) l(msg, p);
}
export function onAnnounce(l: Listener) {
  listeners.add(l);
  return () => void listeners.delete(l);
}
