// Shared contract between server/, web/ and the HUD. Change only via CEO (see docs/TEAM.md).
export type Med = {
  id: string; name: string; ingredient: string; strength: string;
  schedule: string[]; barcode?: string; notes?: string;
  // added Sat 19:00 (CEO): GS1 GTIN (14 digits) from the pack's EU FMD DataMatrix, saved when the med is added
  gtin?: string;
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

// ---- added Sat 19:00 (CEO): EU FMD DataMatrix (GS1) cross-check ----
/** Parsed GS1 element strings from a pack's DataMatrix: (01) GTIN, (17) expiry YYMMDD, (10) batch, (21) serial. */
export type Gs1Code = { raw: string; gtin?: string; expiry?: string /* ISO YYYY-MM or YYYY-MM-DD */; batch?: string; serial?: string };
export type CrossCheck = {
  source: "datamatrix";
  code: Gs1Code;
  /** true = the machine code and the AI read of the printed text agree; false = they conflict; null = nothing to compare */
  agrees: boolean | null;
  /** which fields were compared and how, e.g. ["expiry: code 2027-08 = print 2027-08", "gtin matches your Amlodipine"] */
  details: string[];
};

// ---- added Sat 19:00 (CEO): "Which one?" scene mode ----
export type ScenePosition = "far_left" | "left" | "center" | "right" | "far_right";
export type SceneItem = {
  position: ScenePosition;
  /** Gemini box_2d, [ymin, xmin, ymax, xmax] normalised 0..1000 */
  box?: [number, number, number, number];
  level: VerdictLevel;
  headline: string;            // <= 6 words, e.g. "Amlodipine 5 mg: evening pill"
  matchedMedId?: string;
  read: LabelRead;
};

export type Verdict = {
  level: VerdictLevel;
  headline: string; // <= 8 words, HUD
  speech: string;   // <= 2 sentences, spoken
  read: LabelRead; matchedMedId?: string; reasons: string[]; takenToday?: boolean;
  /** present when a DataMatrix was decoded for this item */
  crossCheck?: CrossCheck;
  /** present for a scene ("Which one?") verdict: one entry per package seen, left to right */
  items?: SceneItem[];
  /** "item" (held label, default) or "scene" (several packages on a surface) */
  mode?: "item" | "scene";
};
export type CoachCue = "rotate_left" | "rotate_right" | "closer" | "farther" | "more_light" | "hold_still" | "other_side" | "ok";
export type LiveState = "connecting" | "open" | "reconnecting" | "degraded" | "closed";
export type DeviceState = { connected: boolean; worn: boolean | null; battery: number | null; streaming: boolean; source: "phone" | "glasses" };

/** added Sat 19:00 (CEO): feature flags. Server env FEATURES=scene,datamatrix,addmed,sonar (default all on);
 *  the phone may turn any off for itself in settings. */
export type FeatureFlag = "scene" | "datamatrix" | "addmed" | "sonar";

export type ClientMsg =
  | { type: "start"; profile: Profile; lang: string; voice: boolean; source: "phone" | "glasses"; features?: FeatureFlag[] }
  | { type: "audio"; data: string }
  | { type: "frame"; data: string; w: number; h: number; sharpness: number; ts: number }
  | { type: "text"; text: string }
  | { type: "event"; name: "log_dose" | "repeat" | "stop" }
  | { type: "ping"; t: number }
  // added Sat 18:00 (CEO): mid-session camera switch; server only accepts /ingest frames while source = "glasses"
  | { type: "source"; source: "phone" | "glasses" }
  // added Sat 19:00 (CEO): a GS1 DataMatrix the phone decoded itself (BarcodeDetector "data_matrix"); server cross-checks it
  | { type: "datamatrix"; raw: string; ts: number }
  // added Sat 19:00 (CEO): the user's answer to a profile_add proposal (accepted = explicit confirmation on the phone or by voice)
  | { type: "profile_add_result"; proposalId: string; accepted: boolean; med?: Med };

export type ServerMsg =
  | { type: "ready"; model: string; session: string; features?: FeatureFlag[] }
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
  | { type: "hud_event"; name: "log_dose" | "repeat" | "dismiss" }
  // added Sat 18:30 (CEO): a dose logged by voice (Gemini log_dose tool); phone mirrors it into its on-device log
  | { type: "dose_logged"; medId: string; ts: number }
  // added Sat 19:00 (CEO): label readiness 0..1 for the sonar tone (server readability from speculative reads,
  // blended with frame sharpness); at most ~4/s
  | { type: "readiness"; value: number }
  // added Sat 19:00 (CEO): "hold up to add". The server proposes a med from a confident label read + the user's spoken
  // schedule; the phone MUST get explicit confirmation before saving (then replies profile_add_result).
  | { type: "profile_add"; proposalId: string; med: Med; speech: string };
