export type Med = {
  id: string; name: string; ingredient: string; strength: string;
  schedule: string[]; barcode?: string; notes?: string;
};
export type Profile = {
  meds: Med[]; allergies: string[]; avoid: string[];
  doseLog: { medId: string; ts: number }[]; lang: string;
};
export type Field<T> = { value: T | null; confidence: number };
export type LabelRead = {
  kind: "medication" | "food" | "other" | "unreadable";
  product: Field<string>; ingredient: Field<string>; strength: Field<string>;
  dosing: Field<string>; expiry: Field<string>; allergens: Field<string[]>;
  barcode: Field<string>; readability: number; guidance?: string;
};
export type VerdictLevel = "match" | "warning" | "unsure" | "info";
export type Verdict = {
  level: VerdictLevel;
  headline: string;
  speech: string;
  read: LabelRead; matchedMedId?: string; reasons: string[]; takenToday?: boolean;
};
export type CoachCue = "rotate_left" | "rotate_right" | "closer" | "farther" | "more_light" | "hold_still" | "other_side" | "ok";
export type LiveState = "connecting" | "open" | "reconnecting" | "degraded" | "closed";
export type DeviceState = { connected: boolean; worn: boolean; battery: number | null; streaming: boolean; source: "phone" | "glasses" };

export type ClientMsg =
  | { type: "start"; profile: Profile; lang: string; voice: boolean; source: "phone" | "glasses" }
  | { type: "audio"; data: string }
  | { type: "frame"; data: string; w: number; h: number; sharpness: number; ts: number }
  | { type: "text"; text: string }
  | { type: "event"; name: "log_dose" | "repeat" | "stop" }
  | { type: "ping"; t: number };

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
  | { type: "interrupted" }
  | { type: "checking"; phase: "start" | "end" }
  | { type: "hud"; connected: boolean };
