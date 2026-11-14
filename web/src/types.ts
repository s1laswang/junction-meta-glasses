export type {
  ClientMsg,
  CoachCue,
  DeviceState,
  Field,
  LabelRead,
  LiveState,
  Med,
  Profile,
  ServerMsg,
  Verdict,
  VerdictLevel
} from "../../shared/types.ts";

import type { CoachCue, DeviceState, LiveState, Verdict } from "../../shared/types.ts";

export type TransportMode = "live" | "snapshot" | "offline";
export type CameraSource = "phone" | "glasses" | "demo";
export type ThemeMode = "dark" | "light" | "high-contrast";
export type PermissionStatusKind = "prompt" | "granted" | "denied" | "unavailable";

export type PermissionStateSummary = {
  camera: PermissionStatusKind;
  microphone: PermissionStatusKind;
};

export type NetworkMetrics = {
  online: boolean;
  rttMs: number | null;
  targetFps: number;
  jpegQuality: number;
};

export type ChaosConfig = {
  forceWsDrop: boolean;
  forceOffline: boolean;
  simulateGlassesDoffed: boolean;
  simulateLowBattery: boolean;
};

export type ConsentRecord = {
  accepted: boolean;
  acceptedAt: number | null;
  version: string;
};

export type DemoScenarioId =
  | "amlodipine_match"
  | "ibuprofen_nsaid"
  | "blurry_strength"
  | "hazelnut_allergy"
  | "oat_milk_safe"
  | "expired_med"
  | "back_of_box";

export type DemoScenario = {
  id: DemoScenarioId;
  title: string;
  subtitle: string;
  question: string;
  barcode?: string;
  fixtureUrl: string;
};

export type TranscriptEntry = {
  id: string;
  role: "user" | "assistant";
  text: string;
  final: boolean;
  ts: number;
};

export type SessionSnapshot = {
  sessionId: string;
  mode: TransportMode;
  liveState: LiveState;
  activeModel: string | null;
  checking: boolean;
  coach: { cue: CoachCue; text: string } | null;
  verdict: Verdict | null;
  transcripts: TranscriptEntry[];
  device: DeviceState;
  hudConnected: boolean;
  network: NetworkMetrics;
  permissions: PermissionStateSummary;
  cameraActive: boolean;
  autoStopRemainingSec: number | null;
  lastError: { code: string; message: string; recoverable: boolean } | null;
};
