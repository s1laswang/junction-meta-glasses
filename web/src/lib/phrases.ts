// Offline/safety phrases pre-rendered with ElevenLabs (server/scripts/prerender-phrases.ts) and precached by
// the service worker. playPhrase() plays the clip for the user's language. It returns false when no clip
// exists (not rendered, or not cached yet), so callers fall back to speechSynthesis with the same text.
type Manifest = { phrases: Record<string, Record<string, { file: string; text: string }>> };
let manifest: Manifest | null | undefined;
let current: HTMLAudioElement | undefined;
let seq = 0;

async function load(): Promise<Manifest | null> {
  if (manifest !== undefined) return manifest;
  try { const r = await fetch("/phrases/manifest.json"); manifest = r.ok ? ((await r.json()) as Manifest) : null; }
  catch { manifest = null; }
  return manifest;
}

export function stopPhrase(): void {
  seq++;
  const audio = current;
  current = undefined;
  if (!audio) return;
  try {
    audio.pause();
  } catch {}
  try {
    audio.currentTime = 0;
  } catch {}
}

export async function playPhrase(id: string, lang = "en"): Promise<boolean> {
  const mySeq = ++seq;
  const m = await load();
  const p = m?.phrases[lang]?.[id] ?? m?.phrases.en?.[id];
  if (!p) return false;
  if (mySeq !== seq) return true;
  let next: HTMLAudioElement | undefined;
  try {
    current?.pause();
    next = new Audio(p.file);
    current = next;
    await next.play();
    if (mySeq !== seq) {
      try {
        next.pause();
      } catch {}
      return true;
    }
    return true;
  } catch {
    if (next && current === next) current = undefined;
    if (mySeq !== seq) return true;
    return false;
  }
}

/** Use at call sites that speak a fixed phrase today, e.g. the offline announcement in checker.ts:
 *  `void sayPhrase("offline", profile.lang, text => speak(text), "You're offline. …")` */
export async function sayPhrase(id: string, lang: string | undefined, speak: (t: string) => void, fallbackText: string) {
  if (!(await playPhrase(id, lang || "en"))) speak(fallbackText);
}
