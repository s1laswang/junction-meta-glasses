// Offline/safety phrases pre-rendered with ElevenLabs (server/scripts/prerender-phrases.ts) and precached by
// the service worker. playPhrase() plays the clip for the user's language. It returns false when no clip
// exists (not rendered, or not cached yet), so callers fall back to speechSynthesis with localized text.
type Manifest = { phrases: Record<string, Record<string, { file: string; text: string }>> };
let manifest: Manifest | null | undefined;
let current: HTMLAudioElement | undefined;

export const PHRASE_TEXT: Record<string, Record<string, string>> = {
  en: {
    offline: "You're offline. I can still recognise your saved medicines by barcode, but I can't read new labels.",
    back_online: "Back online. The live assistant is reconnecting.",
    not_sure: "I'm not sure. I won't guess a dose. Turn the box slowly, or ask a pharmacist.",
    unknown_offline: "I don't know this box offline. It isn't one of your saved medicines.",
    already_taken: "You already took this today. Don't take another unless your plan says so.",
    glasses_off: "Glasses taken off. Switched to the phone camera.",
    camera_off: "Camera off.",
  },
  fi: {
    offline: "Ei verkkoyhteyttä. Tunnistan yhä tallennetut lääkkeesi viivakoodista, mutta en voi lukea uusia pakkauksia.",
    back_online: "Verkkoyhteys palasi. Puheavustaja yhdistää uudelleen.",
    not_sure: "En ole varma. En koskaan arvaa vahvuutta tai annosta. Käännä pakkausta hitaasti tai kysy apteekista.",
    unknown_offline: "En tunnista tätä pakkausta ilman verkkoyhteyttä. Se ei ole tallennettujen lääkkeidesi listalla.",
    already_taken: "Olet jo ottanut tämän lääkkeen tänään. Älä ota uutta annosta, ellei annostusohjeessasi lue niin.",
    glasses_off: "Lasit otettiin päästä. Käytetään puhelimen kameraa.",
    camera_off: "Kamera pois päältä.",
  },
  sv: {
    offline: "Ingen nätverksanslutning. Jag känner fortfarande igen dina sparade läkemedel via streckkoden, men jag kan inte läsa nya förpackningar.",
    back_online: "Uppkopplad igen. Röstassistenten ansluter på nytt.",
    not_sure: "Jag är inte säker. Jag gissar aldrig styrka eller dos. Vrid långsamt på förpackningen, eller fråga på apoteket.",
    unknown_offline: "Jag känner inte igen den här förpackningen utan nätverksanslutning. Den finns inte i din sparade läkemedelslista.",
    already_taken: "Du har redan tagit det här läkemedlet i dag. Ta inte en ny dos om det inte står så i din doseringsanvisning.",
    glasses_off: "Glasögonen togs av. Bytte till telefonens kamera.",
    camera_off: "Kameran är avstängd.",
  },
};

const normLang = (lang?: string) => (lang || "en").trim().toLowerCase().slice(0, 2);

export function phraseText(id: string, lang?: string, fallbackText = ""): string {
  const code = normLang(lang);
  if (code === "en" && fallbackText) return fallbackText;
  return manifest?.phrases?.[code]?.[id]?.text ?? PHRASE_TEXT[code]?.[id] ?? fallbackText ?? PHRASE_TEXT.en[id] ?? "";
}

async function load(): Promise<Manifest | null> {
  if (manifest !== undefined) return manifest;
  try { const r = await fetch("/phrases/manifest.json"); manifest = r.ok ? ((await r.json()) as Manifest) : null; }
  catch { manifest = null; }
  return manifest;
}

export async function playPhrase(id: string, lang = "en"): Promise<boolean> {
  const code = normLang(lang);
  const m = await load();
  // Never play an English MP3 when the user selected fi/sv; let sayPhrase speak the localized phrase instead.
  const p = m?.phrases[code]?.[id] ?? (code === "en" ? m?.phrases.en?.[id] : undefined);
  if (!p) return false;
  try {
    current?.pause();
    current = new Audio(p.file);
    await current.play();
    return true;
  } catch {
    return false; // autoplay blocked or not cached: caller speaks the text instead
  }
}

/** Use at call sites that speak a fixed phrase today, e.g. the offline announcement in checker.ts:
 *  `void sayPhrase("offline", profile.lang, text => speak(text), "You're offline. …")` */
export async function sayPhrase(id: string, lang: string | undefined, speak: (t: string) => void, fallbackText: string) {
  if (!(await playPhrase(id, lang || "en"))) speak(phraseText(id, lang, fallbackText));
}
