// Build-time: render HoldUp's fixed safety and offline phrases with ElevenLabs into web/public/phrases/<lang>/<id>.mp3
// plus web/public/phrases/manifest.json. The service worker precaches them, so offline mode speaks with a natural
// voice instead of the browser's speechSynthesis. Only these fixed strings are sent: no user audio, images or names.
// Usage (from server/): ELEVENLABS_API_KEY=… npx tsx scripts/prerender-phrases.ts [--lang en,fi,sv] [--dry]
// FI/SV texts: machine-drafted. Have a native speaker check them before the demo (see the handoff doc).
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../src/env.ts";
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
};

const langs = ((process.argv.includes("--lang") ? process.argv[process.argv.indexOf("--lang") + 1] : "en,fi,sv") ?? "en").split(",");
const dry = process.argv.includes("--dry");
const outDir = path.join(REPO_ROOT, "web", "public", "phrases");
const manifest: Record<string, Record<string, { file: string; text: string }>> = {};
if (!dry && !eleven.key) { console.error("ELEVENLABS_API_KEY not set (use --dry to only write the manifest)"); process.exit(2); }
const ttfb: number[] = [];
for (const [id, byLang] of Object.entries(PHRASES)) {
  for (const lang of langs) {
    const text = byLang[lang]; if (!text) continue;
    const file = `/phrases/${lang}/${id}.mp3`;
    (manifest[lang] ??= {})[id] = { file, text };
    if (dry) continue;
    const { body, ttfbS } = await elevenStream(text, lang, "tts_eleven_prerender");
    ttfb.push(ttfbS);
    const buf = Buffer.from(await new Response(body).arrayBuffer());
    fs.mkdirSync(path.join(outDir, lang), { recursive: true });
    fs.writeFileSync(path.join(outDir, lang, `${id}.mp3`), buf);
    console.log(`${lang}/${id}.mp3 ${buf.length} B, first byte ${ttfbS.toFixed(3)} s`);
  }
}
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify({ model: eleven.model, generated: new Date().toISOString(), phrases: manifest }, null, 2));
if (ttfb.length) {
  const s = [...ttfb].sort((a, b) => a - b), q = (p: number) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  console.log(`measured time-to-first-byte (laptop network, n=${s.length}): p50 ${q(50).toFixed(3)} s, p95 ${q(95).toFixed(3)} s`);
}
console.log(`wrote ${path.relative(REPO_ROOT, path.join(outDir, "manifest.json"))}`);
