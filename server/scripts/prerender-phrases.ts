// Build-time: render HoldUp's fixed safety and offline phrases with ElevenLabs into web/public/phrases/<lang>/<id>.mp3
// plus web/public/phrases/manifest.json. The service worker precaches them, so offline mode speaks with a natural
// voice instead of the browser's speechSynthesis. Only these fixed strings are sent: no user audio, images or names.
// Usage (from server/): ELEVENLABS_API_KEY=… npx tsx scripts/prerender-phrases.ts [--lang en,fi,sv] [--dry]
// FI/SV texts: reviewed and back-translated for Finnish & Finland-Swedish pharmacy/assistive-tech clarity (docs/LANG_QA.md).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_ROOT } from "../src/env.ts";
import { eleven, elevenStream } from "../src/elevenlabs.ts";

export const PHRASES: Record<string, Record<string, string>> = {
  offline: {
    en: "You're offline. I can still recognise your saved medicines by barcode, but I can't read new labels.",
    fi: "Ei verkkoyhteyttä. Tunnistan yhä tallennetut lääkkeesi viivakoodista, mutta en voi lukea uusia pakkauksia.",
    sv: "Ingen nätverksanslutning. Jag känner fortfarande igen dina sparade läkemedel via streckkoden, men jag kan inte läsa nya förpackningar.",
  },
  back_online: {
    en: "Back online. The live assistant is reconnecting.",
    fi: "Verkkoyhteys palasi. Puheavustaja yhdistää uudelleen.",
    sv: "Uppkopplad igen. Röstassistenten ansluter på nytt.",
  },
  not_sure: {
    en: "I'm not sure. I won't guess a dose. Turn the box slowly, or ask a pharmacist.",
    fi: "En ole varma. En koskaan arvaa vahvuutta tai annosta. Käännä pakkausta hitaasti tai kysy apteekista.",
    sv: "Jag är inte säker. Jag gissar aldrig styrka eller dos. Vrid långsamt på förpackningen, eller fråga på apoteket.",
  },
  unknown_offline: {
    en: "I don't know this box offline. It isn't one of your saved medicines.",
    fi: "En tunnista tätä pakkausta ilman verkkoyhteyttä. Se ei ole tallennettujen lääkkeidesi listalla.",
    sv: "Jag känner inte igen den här förpackningen utan nätverksanslutning. Den finns inte i din sparade läkemedelslista.",
  },
  already_taken: {
    en: "You already took this today. Don't take another unless your plan says so.",
    fi: "Olet jo ottanut tämän lääkkeen tänään. Älä ota uutta annosta, ellei annostusohjeessasi lue niin.",
    sv: "Du har redan tagit det här läkemedlet i dag. Ta inte en ny dos om det inte står så i din doseringsanvisning.",
  },
  glasses_off: {
    en: "Glasses taken off. Switched to the phone camera.",
    fi: "Lasit otettiin päästä. Käytetään puhelimen kameraa.",
    sv: "Glasögonen togs av. Bytte till telefonens kamera.",
  },
  camera_off: {
    en: "Camera off.",
    fi: "Kamera pois päältä.",
    sv: "Kameran är avstängd.",
  },
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
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
}
