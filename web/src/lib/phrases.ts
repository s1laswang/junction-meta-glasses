import type { CoachCue, Verdict } from "../../../shared/types.ts";

type Manifest = { model?: string; generated?: string; phrases: Record<string, Record<string, { file: string; text: string }>> };
type AudioLike = { play(): Promise<void>; pause(): void; currentTime?: number };
type AudioCtor = new (src?: string) => AudioLike;
let manifest: Manifest | null | undefined;
let current: AudioLike | undefined;

async function load(): Promise<Manifest | null> {
  if (manifest !== undefined) return manifest;
  try {
    const r = await fetch("/phrases/manifest.json");
    manifest = r.ok ? ((await r.json()) as Manifest) : null;
  } catch {
    manifest = null;
  }
  return manifest;
}

export function cuePhraseId(cue: CoachCue, text?: string): string | null {
  switch (cue) {
    case "closer":
      return "cue_closer";
    case "farther":
      return "cue_further";
    case "rotate_left":
    case "rotate_right":
      return "cue_rotate";
    case "other_side":
      return "cue_tilt";
    case "more_light":
      return "cue_more_light";
    case "hold_still":
      return text && /\bread/i.test(text) ? "cue_reading" : "cue_steady";
    case "ok":
      return text && /stop/i.test(text) ? "camera_off" : "cue_reading";
    default:
      return null;
  }
}

export function verdictPhraseId(v: Verdict, via?: string | null): string | null {
  if (/already took/i.test(v.speech) || v.headline.includes("already taken today")) return "already_taken";
  if (via === "offline" && (v.headline === "Not one of your saved barcodes" || v.headline === "Pack code not on your list")) return "unknown_offline";
  if (v.level === "unsure") return "not_sure";
  return null;
}

export function stopPhrase(): void {
  if (!current) return;
  try {
    current.pause();
  } catch {}
  try {
    current.currentTime = 0;
  } catch {}
  current = undefined;
}

export async function playPhrase(id: string, lang = "en"): Promise<boolean> {
  const m = await load();
  const p = m?.phrases[lang]?.[id] ?? m?.phrases.en?.[id];
  const Ctor = (globalThis as { Audio?: AudioCtor }).Audio;
  if (!p || !Ctor) return false;
  try {
    stopPhrase();
    current = new Ctor(p.file);
    await current.play();
    return true;
  } catch {
    current = undefined;
    return false;
  }
}

export async function sayPhrase(id: string, lang: string | undefined, speak: (t: string) => void, fallbackText: string) {
  if (!(await playPhrase(id, lang || "en"))) speak(fallbackText);
}
