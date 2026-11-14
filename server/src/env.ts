import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = path.resolve(SERVER_DIR, "..");
loadEnv({ path: path.join(REPO_ROOT, ".env"), quiet: true });

const list = (v: string | undefined, def: string[]) =>
  v ? [v, ...def.filter((m) => m !== v)] : def;

export const env = {
  port: Number(process.env.PORT ?? 8787),
  apiKey: process.env.GEMINI_API_KEY ?? "",
  liveModels: list(process.env.LIVE_MODEL, ["gemini-3.8-live", "gemini-3.1-flash-live-preview", "gemini-2.5-flash-native-audio-latest"]),
  verifyModels: list(process.env.VERIFY_MODEL, ["gemini-3.8-flash", "gemini-3.5-flash", "gemini-3-flash-preview"]),
  ttsModels: list(process.env.TTS_MODEL, ["gemini-3.8-flash-tts", "gemini-2.5-flash-preview-tts"]),
  verifyTimeoutMs: Number(process.env.VERIFY_TIMEOUT_MS ?? 8000),
  idleStopMs: Number(process.env.IDLE_STOP_MS ?? 45000),
  version: process.env.npm_package_version ?? "0.1.0",
  ledgerPath: process.env.LEDGER_PATH ?? path.join(SERVER_DIR, "logs", "ledger.jsonl"),
};
