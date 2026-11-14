// Shared contract between server/, web/ and the HUD. Change only via CEO (see docs/TEAM.md).
export type Med = {
  id: string; name: string; ingredient: string; strength: string;
  schedule: string[]; barcode?: string; notes?: string;
};
export type Profile = {
  meds: Med[]; allergies: string[]; avoid: string[];
  doseLog: { medId: string; ts: number }[]; lang: string;
};
export type Field<T> = { value: T | null; confidence: number }; // 0..1; null when not readable
export type LabelRead = {
  kind: "medication" | "food" | "other" | "unreadable";
  product: Field<string>; ingredient: Field<string>; strength: Field<string>;
  dosing: Field<string>; expiry: Field<string>; allergens: Field<string[]>;
  barcode: Field<string>; readability: number; guidance?: string;
};
export type VerdictLevel = "match" | "warning" | "unsure" | "info";
export type Verdict = {
  level: VerdictLevel;
  headline: string; // <= 8 words, HUD
  speech: string;   // <= 2 sentences, spoken
  read: LabelRead; matchedMedId?: string; reasons: string[]; takenToday?: boolean;
};
export type CoachCue = "rotate_left" | "rotate_right" | "closer" | "farther" | "more_light" | "hold_still" | "other_side" | "ok";
export type LiveState = "connecting" | "open" | "reconnecting" | "degraded" | "closed";
export type DeviceState = { connected: boolean; worn: boolean | null; battery: number | null; streaming: boolean; source: "phone" | "glasses" };

export type ClientMsg =
  | { type: "start"; profile: Profile; lang: string; voice: boolean; source: "phone" | "glasses" }
  | { type: "audio"; data: string }
  | { type: "frame"; data: string; w: number; h: number; sharpness: number; ts: number }
  | { type: "text"; text: string }
  | { type: "event"; name: "log_dose" | "repeat" | "stop" }
  | { type: "ping"; t: number }
  // added Sat 18:00 (CEO): mid-session camera switch; server only accepts /ingest frames while source = "glasses"
  | { type: "source"; source: "phone" | "glasses" };

export type ServerMsg =
  | { type: "ready"; model: string; session: string }
  | { type: "audio"; data: string }
  | { type: "transcript"; role: "user" | "assistant"; text: string; final: boolean }
  | { type: "coach"; cue: CoachCue; text: string }
  | { type: "verdict"; verdict: Verdict }
  | { type: "status"; live: LiveState; detail?: string }
  | { type: "device"; device: DeviceState }
  | { type: "error"; code: string; message: string; recoverable: boolean }
  | { type: "pong"; t: number }
  // added Sat 15:40 (CEO): barge-in → client flushes queued playback immediately
  | { type: "interrupted" }
  // added Sat 15:40 (CEO): emitted the instant verify_label starts/ends so the client can play a "checking" earcon
  // and show a spinner; this hides the 2-4 s verify latency
  | { type: "checking"; phase: "start" | "end" }
  // added Sat 15:40 (CEO): HUD connection state, so the phone device panel can show "HUD connected"
  | { type: "hud"; connected: boolean }
  // added Sat 16:40 (CEO): HUD/Neural Band events forwarded to phone sockets (dose log lives on the phone)
  | { type: "hud_event"; name: "log_dose" | "repeat" | "dismiss" };
