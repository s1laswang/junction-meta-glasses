import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = path.resolve(SERVER_DIR, "..");
loadEnv({ path: path.join(REPO_ROOT, ".env"), quiet: true });

/** X_MODELS="a,b" replaces the whole chain (e.g. LIVE_MODELS=none-live to fail only Live in a demo);
 *  X_MODEL="a" puts one model in front of the default chain. */
const list = (one: string | undefined, all: string | undefined, def: string[]) => {
  const full = all?.split(",").map((s) => s.trim()).filter(Boolean);
  if (full?.length) return full;
  return one ? [one, ...def.filter((m) => m !== one)] : def;
};

export const ALL_FEATURES = ["scene", "datamatrix", "addmed", "sonar"] as const;
export type Feature = (typeof ALL_FEATURES)[number];
const isFeature = (s: string): s is Feature => (ALL_FEATURES as readonly string[]).includes(s);

export const env = {
  /** server-side feature flags (FEATURES env, default all); intersected with start.features per session */
  features: (process.env.FEATURES ?? ALL_FEATURES.join(",")).split(",").map((s) => s.trim()).filter(isFeature),
  port: Number(process.env.PORT ?? 8787),
  apiKey: process.env.GEMINI_API_KEY ?? "",
  liveModels: list(process.env.LIVE_MODEL, process.env.LIVE_MODELS, ["gemini-3.8-live", "gemini-3.1-flash-live-preview", "gemini-2.5-flash-native-audio-latest"]),
  verifyModels: list(process.env.VERIFY_MODEL, process.env.VERIFY_MODELS, ["gemini-3.8-flash", "gemini-3.5-flash", "gemini-3-flash-preview"]),
  ttsModels: list(process.env.TTS_MODEL, undefined, ["gemini-3.8-flash-tts", "gemini-2.5-flash-preview-tts"]),
  verifyTimeoutMs: Number(process.env.VERIFY_TIMEOUT_MS ?? 8000),
  idleStopMs: Number(process.env.IDLE_STOP_MS ?? 45000),
  version: process.env.npm_package_version ?? "0.1.0",
  ledgerPath: process.env.LEDGER_PATH ?? path.join(SERVER_DIR, "logs", "ledger.jsonl"),
};
