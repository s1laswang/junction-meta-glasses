import { ledger } from "./ledger.ts";

export const eleven = {
  key: process.env.ELEVENLABS_API_KEY ?? "",
  base: process.env.ELEVENLABS_BASE ?? "https://api.elevenlabs.io",
  model: process.env.ELEVENLABS_MODEL ?? "eleven_flash_v2_5",
  voices: {
    en: process.env.ELEVENLABS_VOICE_EN ?? "EXAVITQu4vr4xnSDxMaL",
    fi: process.env.ELEVENLABS_VOICE_FI ?? "XB0fDUnXU5powFXDhCwa",
    sv: process.env.ELEVENLABS_VOICE_SV ?? "XB0fDUnXU5powFXDhCwa",
  } as Record<string, string>,
  live: process.env.ELEVENLABS_LIVE === "1",
  format: process.env.ELEVENLABS_FORMAT ?? "mp3_44100_64",
};

export const elevenEnabled = () => !!eleven.key;

export async function elevenStream(text: string, lang = "en", feature = "tts_eleven"): Promise<{ body: ReadableStream<Uint8Array>; ttfbS: number }> {
  const voice = eleven.voices[lang] ?? eleven.voices.en;
  const t = Date.now();
  const r = await fetch(`${eleven.base}/v1/text-to-speech/${voice}/stream?output_format=${eleven.format}`, {
    method: "POST",
    headers: { "xi-api-key": eleven.key, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({
      text,
      model_id: eleven.model,
      language_code: lang,
      apply_text_normalization: "on",
      voice_settings: { stability: 0.7, similarity_boost: 0.75, style: 0, speed: 0.95, use_speaker_boost: true },
    }),
  });
  if (!r.ok || !r.body) {
    ledger({ feature, model: eleven.model, latency_s: (Date.now() - t) / 1000, ok: false });
    throw new Error(`elevenlabs tts HTTP ${r.status}`);
  }
  const reader = r.body.getReader();
  const first = await reader.read();
  const ttfbS = (Date.now() - t) / 1000;
  ledger({ feature, model: eleven.model, latency_s: ttfbS, ok: true, first_audio_s: ttfbS } as any);
  const body = new ReadableStream<Uint8Array>({
    start(c) { if (!first.done && first.value) c.enqueue(first.value); },
    async pull(c) { const n = await reader.read(); if (n.done) c.close(); else c.enqueue(n.value); },
    cancel() { void reader.cancel(); },
  });
  return { body, ttfbS };
}

export async function scribeToken(): Promise<string> {
  const r = await fetch(`${eleven.base}/v1/single-use-token/realtime_scribe`, { method: "POST", headers: { "xi-api-key": eleven.key } });
  if (!r.ok) throw new Error(`elevenlabs token HTTP ${r.status}`);
  return ((await r.json()) as { token: string }).token;
}
