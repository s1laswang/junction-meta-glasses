import { Modality } from "@google/genai";
import { env } from "./env.ts";
import { ai, unaryGate } from "./gemini.ts";
import { ledger } from "./ledger.ts";
import { errSummary, log } from "./log.ts";

export const ALLOWED_TTS_VOICES = [
  "Kore",
  "Aoede",
  "Puck",
  "Charon",
  "Fenrir",
  "Leda",
  "Orus",
  "Zephyr",
] as const;

export type TtsVoice = (typeof ALLOWED_TTS_VOICES)[number];

export const TTS_LANG_NAMES: Record<string, string> = {
  en: "English",
  fi: "Finnish",
  sv: "Swedish",
  de: "German",
  es: "Spanish",
  fr: "French",
  et: "Estonian",
  ru: "Russian",
};

const CTRL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]+/g;

export function sanitizeTtsText(raw: unknown, maxLen = 600): string {
  if (typeof raw !== "string") return "";
  return raw.replace(CTRL_RE, " ").replace(/\s+/g, " ").trim().slice(0, maxLen).trim();
}

export function resolveTtsVoice(raw?: unknown, fallback = process.env.TTS_VOICE ?? "Kore"): TtsVoice {
  const matchVoice = (candidate: unknown): TtsVoice | undefined => {
    if (typeof candidate !== "string") return undefined;
    const norm = candidate.trim().toLowerCase();
    return ALLOWED_TTS_VOICES.find((v) => v.toLowerCase() === norm);
  };
  return matchVoice(raw) ?? matchVoice(fallback) ?? "Kore";
}

export function normalizeTtsLang(raw?: unknown): string {
  if (typeof raw !== "string") return "en";
  const primary = raw.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  return primary && /^[a-z]{2,3}$/.test(primary) ? primary : "en";
}

export function buildTtsPrompt(text: string, lang?: unknown): string {
  const code = normalizeTtsLang(lang);
  if (code === "en") return `Say calmly and clearly: ${text}`;
  const langName = TTS_LANG_NAMES[code];
  return langName ? `Say calmly and clearly in ${langName}: ${text}` : `Say calmly and clearly: ${text}`;
}

export function parsePcmSampleRate(mimeType?: string | null): number {
  if (typeof mimeType !== "string") return 24000;
  const match = /rate=(\d+)/i.exec(mimeType);
  if (!match) return 24000;
  const rate = Number(match[1]);
  return Number.isInteger(rate) && rate >= 8000 && rate <= 48000 ? rate : 24000;
}

export function buildWav(pcm: Buffer, sampleRate = 24000): Buffer {
  const rate = Number.isInteger(sampleRate) && sampleRate >= 8000 && sampleRate <= 48000 ? sampleRate : 24000;
  const alignedLen = pcm.length - (pcm.length % 2);
  const body = alignedLen === pcm.length ? pcm : pcm.subarray(0, alignedLen);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + body.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(body.length, 40);
  return Buffer.concat([h, body]);
}

export type TtsGenerateResult = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        inlineData?: {
          data?: string;
          mimeType?: string;
        };
      }>;
    };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
};

export type TtsSynthesizeOpts = {
  chain?: string[];
  timeoutMs?: number;
  generateFn?: (model: string, prompt: string, voiceName: TtsVoice, signal: AbortSignal) => Promise<TtsGenerateResult>;
};

export type TtsSynthesizeOutcome =
  | {
      ok: true;
      wav: Buffer;
      model: string;
      sampleRate: number;
      voice: TtsVoice;
      latencyMs: number;
    }
  | {
      ok: false;
      status: 400 | 503;
      code: "bad_input" | "gemini_unavailable";
      message: string;
    };

export async function synthesizeTts(
  input: { text?: unknown; lang?: unknown; voice?: unknown },
  opts?: TtsSynthesizeOpts,
): Promise<TtsSynthesizeOutcome> {
  const text = sanitizeTtsText(input?.text);
  if (!text) {
    return { ok: false, status: 400, code: "bad_input", message: "text required" };
  }
  const voice = resolveTtsVoice(input?.voice);
  const prompt = buildTtsPrompt(text, input?.lang);
  const chain = opts?.chain ?? env.ttsModels;
  const timeoutMs = opts?.timeoutMs ?? env.verifyTimeoutMs;
  const generate =
    opts?.generateFn ??
    ((model: string, p: string, voiceName: TtsVoice, signal: AbortSignal) =>
      ai.models.generateContent({
        model,
        contents: [{ role: "user", parts: [{ text: p }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
          abortSignal: signal,
        },
      }) as Promise<TtsGenerateResult>);

  const startedAt = Date.now();
  for (const model of chain) {
    const ta = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await unaryGate.run(() => generate(model, prompt, voice, ctrl.signal));
      const part = r.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
      if (!part?.inlineData?.data) throw new Error("empty reply");
      const pcm = Buffer.from(part.inlineData.data, "base64");
      const alignedLen = pcm.length - (pcm.length % 2);
      if (alignedLen < 2) throw new Error("empty audio frames");
      const sampleRate = parsePcmSampleRate(part.inlineData.mimeType);
      const wavBuf = buildWav(pcm, sampleRate);
      ledger({
        feature: "tts",
        model,
        latency_s: (Date.now() - ta) / 1000,
        ok: true,
        in: r.usageMetadata?.promptTokenCount ?? 0,
        out: r.usageMetadata?.candidatesTokenCount ?? 0,
      });
      return {
        ok: true,
        wav: wavBuf,
        model,
        sampleRate,
        voice,
        latencyMs: Date.now() - startedAt,
      };
    } catch (e) {
      ledger({ feature: "tts", model, latency_s: (Date.now() - ta) / 1000, ok: false });
      log("tts.failed", { model, err: errSummary(e) });
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    ok: false,
    status: 503,
    code: "gemini_unavailable",
    message: "TTS unavailable, use speechSynthesis",
  };
}
