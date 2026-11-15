// ElevenLabs voice for HoldUp (optional). Gemini Live stays the live conversation, coaching and tool-calling
// layer (verify_label etc. are untouched). ElevenLabs adds:
//   1. build-time, fixed safety/offline phrases in EN/FI/SV (scripts/prerender-phrases.ts): no user data;
//   2. opt-in streaming TTS for snapshot-mode verdicts (POST /api/tts/eleven), only when ELEVENLABS_LIVE=1,
//      because verdict text names the user's medicine (disclose in consent/PRIVACY.md before enabling);
//   3. a single-use token for Scribe realtime STT in the browser (GET /api/stt/token), so the API key never
//      leaves the server.
// Key: ELEVENLABS_API_KEY (env only, never logged). API: https://elevenlabs.io/docs/api-reference
import { ledger } from "./ledger.ts";

export const eleven = {
  key: process.env.ELEVENLABS_API_KEY ?? "",
  base: process.env.ELEVENLABS_BASE ?? "https://api.elevenlabs.io",
  // eleven_flash_v2_5: vendor-claimed ~100 ms median model latency (excl. network), 32 languages incl. fi, sv.
  model: process.env.ELEVENLABS_MODEL ?? "eleven_flash_v2_5",
  // One voice per language; override after a listening test. Defaults are ElevenLabs premade voices.
  voices: {
    en: process.env.ELEVENLABS_VOICE_EN ?? "EXAVITQu4vr4xnSDxMaL", // Sarah: soft, clear
    fi: process.env.ELEVENLABS_VOICE_FI ?? "XB0fDUnXU5powFXDhCwa", // Charlotte: multilingual premade; check Finnish prosody
    sv: process.env.ELEVENLABS_VOICE_SV ?? "XB0fDUnXU5powFXDhCwa",
  } as Record<string, string>,
  live: process.env.ELEVENLABS_LIVE === "1",
  format: process.env.ELEVENLABS_FORMAT ?? "mp3_44100_64",
};

export const elevenEnabled = () => !!eleven.key;

const elevenTimeout = () => AbortSignal.timeout(Math.max(100, Number(process.env.ELEVENLABS_TIMEOUT_MS) || 8000));

function readFirstChunk(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal): ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("elevenlabs tts timeout"));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      void reader.cancel().catch(() => {});
      reject(signal.reason ?? new Error("elevenlabs tts timeout"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e) => { signal.removeEventListener("abort", onAbort); reject(e); },
    );
  });
}

/** Streaming TTS. Resolves once the first audio byte has arrived (time-to-first-byte is ledgered as first_audio_s). */
export async function elevenStream(text: string, lang = "en", feature = "tts_eleven"): Promise<{ body: ReadableStream<Uint8Array>; ttfbS: number }> {
  const voice = eleven.voices[lang] || eleven.voices.en;
  const t = Date.now();
  const signal = elevenTimeout();
  const r = await fetch(`${eleven.base}/v1/text-to-speech/${encodeURIComponent(voice)}/stream?output_format=${encodeURIComponent(eleven.format)}`, {
    method: "POST",
    headers: { "xi-api-key": eleven.key, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({
      text, model_id: eleven.model, language_code: lang,
      apply_text_normalization: "on", // Flash v2.5 doesn't normalise numbers by default ("5 mg")
      voice_settings: { stability: 0.7, similarity_boost: 0.75, style: 0, speed: 0.95, use_speaker_boost: true },
    }),
    signal,
  }).catch((e) => {
    ledger({ feature, model: eleven.model, latency_s: (Date.now() - t) / 1000, ok: false });
    throw e;
  });
  if (!r.ok || !r.body) {
    ledger({ feature, model: eleven.model, latency_s: (Date.now() - t) / 1000, ok: false });
    throw new Error(`elevenlabs tts HTTP ${r.status}`);
  }
  const reader = r.body.getReader();
  const first = await readFirstChunk(reader, signal).catch(async (e) => {
    ledger({ feature, model: eleven.model, latency_s: (Date.now() - t) / 1000, ok: false });
    await reader.cancel().catch(() => {});
    throw e;
  });
  if (first.done || !first.value?.byteLength) {
    ledger({ feature, model: eleven.model, latency_s: (Date.now() - t) / 1000, ok: false });
    await reader.cancel().catch(() => {});
    throw new Error("elevenlabs tts empty stream");
  }
  const ttfbS = (Date.now() - t) / 1000;
  ledger({ feature, model: eleven.model, latency_s: ttfbS, ok: true, first_audio_s: ttfbS } as any);
  const body = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(first.value); },
    async pull(c) { const n = await reader.read(); if (n.done) c.close(); else c.enqueue(n.value); },
    cancel() { void reader.cancel().catch(() => {}); },
  });
  return { body, ttfbS };
}

/** Single-use token (15 min, consumed on use) for the browser's Scribe realtime WebSocket. */
export async function scribeToken(): Promise<string> {
  const r = await fetch(`${eleven.base}/v1/single-use-token/realtime_scribe`, {
    method: "POST",
    headers: { "xi-api-key": eleven.key },
    signal: elevenTimeout(),
  });
  if (!r.ok) throw new Error(`elevenlabs token HTTP ${r.status}`);
  const data = (await r.json()) as { token?: unknown };
  if (typeof data?.token !== "string" || !data.token.trim()) throw new Error("elevenlabs empty scribe token");
  return data.token.trim();
}
