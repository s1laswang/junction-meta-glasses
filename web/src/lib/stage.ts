// /stage projector view: state and message handling, kept pure so it can be unit-tested.
// Fed by /hud-ws?role=stage (server) or, with ?mock=1, by a mock phone tab or a built-in script.
import type { CoachCue, DeviceState, FeatureFlag, LiveState, ServerMsg, Verdict, VerdictLevel } from "../../../shared/types.ts";

/**
 * Stage-only message. Not in shared/types.ts yet (contract proposal in the feat/stage report);
 * mirrors StageMetrics in server/src/hub.ts. Numbers and flags only.
 */
export type StageMetrics = {
  type: "metrics";
  model: string | null;
  firstAudioS: number | null;
  firstAudioP50S: number | null;
  turns: number;
  verify: { ms: number; source: "cache" | "inflight" | "fresh" | "scene"; level: VerdictLevel } | null;
  cache: { hits: number; misses: number };
  features: FeatureFlag[];
  phone: boolean;
  hud: boolean;
  source: "phone" | "glasses";
  fps: number;
  frameKb: number | null;
};

export type StageMsg =
  | Extract<ServerMsg, { type: "verdict" | "coach" | "status" | "device" | "transcript" | "checking" | "readiness" | "ready" | "interrupted" | "hud_event" }>
  | StageMetrics;

export const STAGE_MSG_TYPES = new Set<string>(["verdict", "coach", "status", "device", "transcript", "checking", "readiness", "ready", "interrupted", "hud_event", "metrics"]);

type Line = { text: string; final: boolean; ts: number };
export type StageState = {
  /** what the Display shows (same rules as Hud.tsx: a verdict clears the cue, cues expire after 3 s) */
  hudVerdict: Verdict | null;
  hudCue: { cue: CoachCue; text: string; ts: number } | null;
  /** centre column: the current coach cue (until the verdict, or 6 s) */
  coach: { cue: CoachCue; text: string; ts: number } | null;
  user: Line | null;
  assistant: Line | null;
  readiness: number | null;
  checking: boolean;
  checkingSince: number | null;
  live: LiveState | null;
  device: DeviceState | null;
  model: string | null;
  features: FeatureFlag[] | null;
  metrics: StageMetrics | null;
  /** last verdict regardless of HUD dismiss: drives the double-checked badge */
  lastVerdict: Verdict | null;
};

export const initialStage = (): StageState => ({
  hudVerdict: null,
  hudCue: null,
  coach: null,
  user: null,
  assistant: null,
  readiness: null,
  checking: false,
  checkingSince: null,
  live: null,
  device: null,
  model: null,
  features: null,
  metrics: null,
  lastVerdict: null,
});

export const HUD_CUE_MS = 3000;
export const COACH_MS = 6000;

export function stageReduce(s: StageState, m: StageMsg | { type: "tick" }, now = Date.now()): StageState {
  switch (m.type) {
    case "tick": {
      const hudCue = s.hudCue && now - s.hudCue.ts >= HUD_CUE_MS - 100 ? null : s.hudCue;
      const coach = s.coach && now - s.coach.ts >= COACH_MS ? null : s.coach;
      return hudCue === s.hudCue && coach === s.coach ? s : { ...s, hudCue, coach };
    }
    case "verdict":
      return { ...s, hudVerdict: m.verdict, hudCue: null, coach: null, lastVerdict: m.verdict };
    case "coach":
      return { ...s, hudCue: { cue: m.cue, text: m.text, ts: now }, coach: { cue: m.cue, text: m.text, ts: now } };
    case "status":
      return { ...s, live: m.live };
    case "device":
      return { ...s, device: m.device };
    case "transcript": {
      const line = { text: m.text, final: m.final, ts: now };
      return m.role === "user" ? { ...s, user: line } : { ...s, assistant: line };
    }
    case "checking":
      return m.phase === "start" ? { ...s, checking: true, checkingSince: now } : { ...s, checking: false, checkingSince: null };
    case "readiness":
      return { ...s, readiness: Math.max(0, Math.min(1, m.value)) };
    case "ready":
      return { ...s, model: m.model, features: m.features ?? s.features };
    case "interrupted":
      return s.assistant ? { ...s, assistant: { ...s.assistant, final: true } } : s;
    case "hud_event":
      // the wearer pressed Dismiss on the glasses: the replica clears like the real HUD
      return m.name === "dismiss" ? { ...s, hudVerdict: null, hudCue: null } : s;
    case "metrics":
      return { ...s, metrics: m, model: m.model ?? s.model, features: m.features.length || !s.features ? m.features : s.features };
    default:
      return s;
  }
}

export const FEATURE_LABEL: Record<FeatureFlag, string> = { scene: "Which one?", datamatrix: "Pack code", addmed: "Hold up to add", sonar: "Sonar" };
export const ALL_FEATURES: FeatureFlag[] = ["scene", "datamatrix", "addmed", "sonar"];

export function fmtSeconds(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s)) return "–";
  return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
}

/** Latency: milliseconds below 1 s (a cache hit is ~0), seconds above. */
export function fmtMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "–";
  return ms < 1000 ? `${Math.round(ms)} ms` : fmtSeconds(ms / 1000);
}

export const VERIFY_SOURCE: Record<NonNullable<StageMetrics["verify"]>["source"], string> = {
  cache: "cache hit",
  inflight: "cache hit (in flight)",
  fresh: "fresh read",
  scene: "scene read",
};

/** The DataMatrix badge: what to show for the last verdict. */
export function crossCheckBadge(v: Verdict | null): { tone: "ok" | "bad" | "neutral" | "none"; glyph: string; text: string; detail?: string } {
  const cc = v?.crossCheck;
  if (!v) return { tone: "none", glyph: "–", text: "No check yet" };
  if (!cc) return { tone: "none", glyph: "–", text: v.mode === "scene" ? "Scene: no pack code" : "No pack code this check" };
  if (cc.agrees === true) return { tone: "ok", glyph: "✓", text: "Double-checked with the pack's code", detail: cc.details[0] };
  if (cc.agrees === false) return { tone: "bad", glyph: "!", text: "Pack code and print disagree", detail: cc.details[0] };
  return { tone: "neutral", glyph: "?", text: "Pack code read, nothing to compare", detail: cc.details[0] };
}

export function wornText(d: DeviceState | null): string {
  if (!d || (!d.connected && d.source === "phone")) return "Not connected";
  if (!d.connected) return "Disconnected";
  return d.worn === true ? "Worn" : d.worn === false ? "Taken off" : "Connected";
}
