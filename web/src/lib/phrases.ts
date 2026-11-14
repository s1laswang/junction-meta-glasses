// Offline/safety phrases pre-rendered with ElevenLabs (server/scripts/prerender-phrases.ts) and precached by
// the service worker. playPhrase() plays the clip for the user's language. It returns false when no clip
// exists (not rendered, or not cached yet), so callers fall back to speechSynthesis with the same text.
type Manifest = { phrases: Record<string, Record<string, { file: string; text: string }>> };
let manifest: Manifest | null | undefined;
let current: HTMLAudioElement | undefined;

async function load(): Promise<Manifest | null> {
  if (manifest !== undefined) return manifest;
  try { const r = await fetch("/phrases/manifest.json"); manifest = r.ok ? ((await r.json()) as Manifest) : null; }
  catch { manifest = null; }
  return manifest;
}

export async function playPhrase(id: string, lang = "en"): Promise<boolean> {
  const m = await load();
  const p = m?.phrases[lang]?.[id] ?? m?.phrases.en?.[id];
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
  if (!(await playPhrase(id, lang || "en"))) speak(fallbackText);
}
