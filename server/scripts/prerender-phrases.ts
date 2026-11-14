import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { env, REPO_ROOT } from "../src/env.ts";
import { eleven, elevenStream } from "../src/elevenlabs.ts";

export const PHRASES: Record<string, Record<string, string>> = {
  offline: {
    en: "You're offline. I can still recognise your saved medicines by barcode, but I can't read new labels.",
    fi: "Olet offline-tilassa. Tunnistan yhä tallennetut lääkkeesi viivakoodista, mutta en pysty lukemaan uusia etikettejä.",
    sv: "Du är offline. Jag känner fortfarande igen dina sparade läkemedel via streckkoden, men jag kan inte läsa nya etiketter.",
  },
  back_online: {
    en: "Back online. The live assistant is reconnecting.",
    fi: "Yhteys palasi. Avustaja yhdistää uudelleen.",
    sv: "Uppkopplad igen. Assistenten ansluter på nytt.",
  },
  not_sure: {
    en: "I'm not sure. I won't guess a dose. Turn the box slowly, or ask a pharmacist.",
    fi: "En ole varma, enkä arvaa annosta. Käännä pakkausta hitaasti tai kysy apteekista.",
    sv: "Jag är inte säker, och jag gissar inte en dos. Vrid förpackningen långsamt, eller fråga på apoteket.",
  },
  unknown_offline: {
    en: "I don't know this box offline. It isn't one of your saved medicines.",
    fi: "En tunnista tätä pakkausta offline-tilassa. Se ei ole tallennettu lääkkeesi.",
    sv: "Jag känner inte igen den här förpackningen offline. Den är inte ett av dina sparade läkemedel.",
  },
  already_taken: {
    en: "You already took this today. Don't take another unless your plan says so.",
    fi: "Olet jo ottanut tämän tänään. Älä ota toista, ellei hoito-ohjeesi niin sano.",
    sv: "Du har redan tagit den här i dag. Ta inte en till om inte din plan säger det.",
  },
  glasses_off: {
    en: "Glasses taken off. Switched to the phone camera.",
    fi: "Lasit otettu pois. Vaihdettu puhelimen kameraan.",
    sv: "Glasögonen är av. Bytte till telefonens kamera.",
  },
  camera_off: {
    en: "Camera off.",
    fi: "Kamera pois päältä.",
    sv: "Kameran är av.",
  },
  cue_closer: {
    en: "A bit closer.",
    fi: "Hieman lähemmäs.",
    sv: "Lite närmare.",
  },
  cue_further: {
    en: "Move it slightly further back.",
    fi: "Siirrä hieman kauemmas.",
    sv: "Flytta den lite längre bort.",
  },
  cue_rotate: {
    en: "Turn the box slowly.",
    fi: "Käännä pakkausta hitaasti.",
    sv: "Vrid förpackningen långsamt.",
  },
  cue_tilt: {
    en: "Turn the box to the other side.",
    fi: "Käännä pakkaus toisin päin.",
    sv: "Vänd förpackningen till andra sidan.",
  },
  cue_more_light: {
    en: "Move into brighter light.",
    fi: "Siirry parempaan valoon.",
    sv: "Håll den i bättre ljus.",
  },
  cue_steady: {
    en: "Hold still.",
    fi: "Pidä paikallaan.",
    sv: "Håll stilla.",
  },
  cue_reading: {
    en: "Got it, reading the label.",
    fi: "Selvä, luen etikettiä.",
    sv: "Jag ser den, läser etiketten.",
  },
};

function trimSilence(samples: Int16Array, rate: number, threshold = 260): Int16Array {
  const pad = Math.round(rate * 0.035);
  let start = 0;
  while (start < samples.length && Math.abs(samples[start]) < threshold) start++;
  let end = samples.length - 1;
  while (end > start && Math.abs(samples[end]) < threshold) end--;
  if (start >= end) return samples;
  const from = Math.max(0, start - pad);
  const to = Math.min(samples.length, end + 1 + pad);
  return samples.subarray(from, to);
}

function resampleLowPass(samples: Int16Array, srcRate: number, dstRate: number): Int16Array {
  if (srcRate === dstRate || samples.length === 0) return samples;
  const ratio = srcRate / dstRate;
  const outLen = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Int16Array(outLen);
  const halfWin = Math.max(1, Math.round(ratio));
  for (let i = 0; i < outLen; i++) {
    const center = i * ratio;
    const lo = Math.max(0, Math.floor(center - halfWin));
    const hi = Math.min(samples.length - 1, Math.ceil(center + halfWin));
    let sum = 0;
    let wsum = 0;
    for (let j = lo; j <= hi; j++) {
      const w = Math.max(0.05, 1 - Math.abs(j - center) / (halfWin + 0.5));
      sum += samples[j] * w;
      wsum += w;
    }
    const v = Math.round(sum / (wsum || 1));
    out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
  }
  return out;
}

function encodeWavPcm16(samples: Int16Array, rate: number): Buffer {
  const pcmBytes = samples.length * 2;
  const buf = Buffer.allocUnsafe(44 + pcmBytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + pcmBytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(pcmBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    buf.writeInt16LE(samples[i], 44 + i * 2);
  }
  return buf;
}

function extractPcm16FromReply(raw: Buffer, mimeType?: string): { samples: Int16Array; rate: number } {
  if (raw.length >= 44 && raw.subarray(0, 4).toString("ascii") === "RIFF" && raw.subarray(8, 12).toString("ascii") === "WAVE") {
    let rate = 24000;
    let channels = 1;
    let dataSlice: Buffer | null = null;
    let offset = 12;
    while (offset + 8 <= raw.length) {
      const id = raw.subarray(offset, offset + 4).toString("ascii");
      const size = raw.readUInt32LE(offset + 4);
      const bodyStart = offset + 8;
      const bodyEnd = Math.min(raw.length, bodyStart + size);
      if (id === "fmt " && bodyEnd - bodyStart >= 16) {
        channels = Math.max(1, raw.readUInt16LE(bodyStart + 2));
        rate = raw.readUInt32LE(bodyStart + 4) || 24000;
      } else if (id === "data") {
        dataSlice = raw.subarray(bodyStart, bodyEnd);
        break;
      }
      offset = bodyStart + size + (size % 2);
    }
    if (dataSlice) {
      const frameBytes = 2 * channels;
      const frames = Math.floor(dataSlice.length / frameBytes);
      const samples = new Int16Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) sum += dataSlice.readInt16LE(i * frameBytes + c * 2);
        samples[i] = Math.round(sum / channels);
      }
      return { samples, rate };
    }
  }
  const rate = Number(/rate=(\d+)/.exec(mimeType ?? "")?.[1] ?? 24000);
  const aligned = raw.byteLength - (raw.byteLength % 2);
  const samples = new Int16Array(aligned / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = raw.readInt16LE(i * 2);
  return { samples, rate };
}

async function renderGeminiClip(apiKey: string, models: string[], text: string): Promise<{ samples: Int16Array; rate: number; model: string; latS: number }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const model of models) {
      const t0 = Date.now();
      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
          method: "POST",
          headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text }] }],
            generationConfig: { responseModalities: ["AUDIO"] },
          }),
        });
        if (!res.ok) throw new Error(`gemini tts HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
        const data = (await res.json()) as { candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] } }[] };
        const part = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
        if (!part?.inlineData?.data) throw new Error("empty audio reply");
        const raw = Buffer.from(part.inlineData.data, "base64");
        const { samples, rate } = extractPcm16FromReply(raw, part.inlineData.mimeType);
        return { samples: trimSilence(samples, rate), rate, model, latS: (Date.now() - t0) / 1000 };
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function runCli() {
  if ((!process.env.GEMINI_API_KEY || !process.env.HTTPS_PROXY) && process.env.HOME) {
    const fallbackEnv = path.join(process.env.HOME, "momin", ".env");
    if (fs.existsSync(fallbackEnv)) loadEnv({ path: fallbackEnv, quiet: true });
  }
  const geminiKey = process.env.GEMINI_API_KEY || env.apiKey;
  const langs = ((process.argv.includes("--lang") ? process.argv[process.argv.indexOf("--lang") + 1] : "en,fi,sv") ?? "en").split(",");
  const dry = process.argv.includes("--dry");
  const outDir = path.join(REPO_ROOT, "web", "public", "phrases");
  const manifest: Record<string, Record<string, { file: string; text: string }>> = {};

  if (!dry && !eleven.key && !geminiKey) {
    console.error("Neither ELEVENLABS_API_KEY nor GEMINI_API_KEY is set (use --dry to only write the manifest)");
    process.exit(2);
  }

  const useEleven = !!eleven.key;
  const ext = useEleven ? "mp3" : "wav";
  const jobs: { id: string; lang: string; text: string }[] = [];
  for (const [id, byLang] of Object.entries(PHRASES)) {
    for (const lang of langs) {
      const text = byLang[lang];
      if (!text) continue;
      (manifest[lang] ??= {})[id] = { file: `/phrases/${lang}/${id}.${ext}`, text };
      if (!dry) jobs.push({ id, lang, text });
    }
  }

  const latencies: number[] = [];
  let usedModel = useEleven ? eleven.model : env.ttsModels[0];

  if (!dry && useEleven) {
    for (const job of jobs) {
      const { body, ttfbS } = await elevenStream(job.text, job.lang, "tts_eleven_prerender");
      latencies.push(ttfbS);
      const buf = Buffer.from(await new Response(body).arrayBuffer());
      fs.mkdirSync(path.join(outDir, job.lang), { recursive: true });
      fs.writeFileSync(path.join(outDir, job.lang, `${job.id}.mp3`), buf);
      console.log(`${job.lang}/${job.id}.mp3 ${buf.length} B, first byte ${ttfbS.toFixed(3)} s`);
    }
  } else if (!dry) {
    const rendered = new Array<{ id: string; lang: string; samples: Int16Array; rate: number }>(jobs.length);
    let cursor = 0;
    const concurrency = Math.min(6, jobs.length);
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (cursor < jobs.length) {
          const idx = cursor++;
          const job = jobs[idx];
          const r = await renderGeminiClip(geminiKey, env.ttsModels, job.text);
          usedModel = r.model;
          latencies.push(r.latS);
          rendered[idx] = { id: job.id, lang: job.lang, samples: r.samples, rate: r.rate };
          console.log(`rendered ${job.lang}/${job.id} (${(r.samples.length / r.rate).toFixed(2)} s audio in ${r.latS.toFixed(2)} s)`);
        }
      }),
    );
    const totalSec = rendered.reduce((acc, r) => acc + r.samples.length / r.rate, 0);
    const candidateRates = [12000, 9600, 8000];
    const targetRate = candidateRates.find((rt) => totalSec * rt * 2 + rendered.length * 44 <= 1_880_000) ?? 8000;
    let totalBytes = 0;
    for (const r of rendered) {
      const down = resampleLowPass(r.samples, r.rate, targetRate);
      const wav = encodeWavPcm16(down, targetRate);
      totalBytes += wav.length;
      fs.mkdirSync(path.join(outDir, r.lang), { recursive: true });
      fs.writeFileSync(path.join(outDir, r.lang, `${r.id}.wav`), wav);
    }
    console.log(`wrote ${rendered.length} wav clips at ${targetRate} Hz PCM16 (${(totalBytes / 1024).toFixed(1)} KiB total)`);
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify({ model: usedModel, generated: new Date().toISOString(), phrases: manifest }, null, 2),
  );
  if (latencies.length) {
    const s = [...latencies].sort((a, b) => a - b);
    const q = (p: number) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
    console.log(`measured TTS latency (n=${s.length}): p50 ${q(50).toFixed(3)} s, p95 ${q(95).toFixed(3)} s`);
  }
  console.log(`wrote ${path.relative(REPO_ROOT, path.join(outDir, "manifest.json"))}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runCli();
}
