// Spoken-answer check. The deterministic rules write the sentence (`verdict.speech`); Gemini Live is told to say it.
// "Told to" is not "did", so after every verdict we compare what was actually said (output transcription) with the
// rule's sentence. Only unsafe-direction or factual differences count: a missing or invented strength, a dropped
// caution, an affirmative opener on a warning, a missing medicine name, or silence. Harmless paraphrase passes.
// Reasons are category codes only, so they can go in the metadata-only ledger.
import type { VerdictLevel } from "../../shared/types.ts";

export type FidelityReason =
  | "not_spoken" | "strength_missing" | "strength_invented" | "affirmative_on_caution" | "caution_dropped" | "name_missing" | "lead_missing";
export type Fidelity = { ok: boolean; reasons: FidelityReason[] };
export type Expected = { speech: string; level: VerdictLevel; lead?: string; names?: string[] };

const strip = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/(\d),(\d)/g, "$1.$2").replace(/\s+/g, " ").trim();

const UNIT_RE = "(mg|milligrams?|milligrammes?|mcg|micrograms?|ug|g|grams?|ml|millilit(?:er|re)s?|iu|units?|%|percent)";
const UNIT_CANON: Record<string, string> = {
  mg: "mg", milligram: "mg", milligrams: "mg", milligramme: "mg", milligrammes: "mg",
  mcg: "mcg", microgram: "mcg", micrograms: "mcg", ug: "mcg",
  g: "g", gram: "g", grams: "g",
  ml: "ml", milliliter: "ml", milliliters: "ml", millilitre: "ml", millilitres: "ml",
  iu: "iu", unit: "iu", units: "iu", "%": "%", percent: "%",
};
const ONES: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

/** "five hundred" -> 500, "twenty five" -> 25, "two point five" -> 2.5, "one thousand" -> 1000. Undefined if not a number phrase. */
export function wordsToNumber(words: string[]): number | undefined {
  if (!words.length) return undefined;
  const pt = words.indexOf("point");
  if (pt >= 0) {
    const whole = wordsToNumber(words.slice(0, pt));
    const frac = words.slice(pt + 1).map((w) => ONES[w]);
    if (whole === undefined || !frac.length || frac.some((d) => d === undefined || d > 9)) return undefined;
    return Number(`${whole}.${frac.join("")}`);
  }
  let total = 0, cur = 0, seen = false;
  for (const w of words) {
    if (w === "and" || w === "a") { if (w === "a") { cur = cur || 1; seen = true; } continue; }
    if (ONES[w] !== undefined) { cur += ONES[w]; seen = true; }
    else if (TENS[w] !== undefined) { cur += TENS[w]; seen = true; }
    else if (w === "hundred") { cur = (cur || 1) * 100; seen = true; }
    else if (w === "thousand") { total += (cur || 1) * 1000; cur = 0; seen = true; }
    else return undefined;
  }
  return seen ? total + cur : undefined;
}

/** Strengths ("5 mg", "five milligrams", "2.5 mg") as canonical "5 mg" strings. */
export function strengthsIn(text: string): Set<string> {
  const t = strip(text).replace(/-/g, " ");
  const out = new Set<string>();
  const digit = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${UNIT_RE}(?![a-z])`, "g");
  for (const m of t.matchAll(digit)) out.add(`${Number(m[1])} ${UNIT_CANON[m[2]] ?? m[2]}`);
  const word = new RegExp(`((?:[a-z]+ ){1,5})${UNIT_RE}(?![a-z])`, "g");
  for (const m of t.matchAll(word)) {
    const ws = m[1].trim().split(" ");
    for (let k = Math.min(5, ws.length); k >= 1; k--) {
      const n = wordsToNumber(ws.slice(-k));
      if (n !== undefined) { out.add(`${n} ${UNIT_CANON[m[2]] ?? m[2]}`); break; }
    }
  }
  return out;
}

const AFFIRM = /^(yes\b|yep\b|yeah\b|correct\b|that'?s right|right one|kylla\b|oikea pakkaus|ja[,. ]|ratt forpackning)/;
const CAUTION = ["warning", "not ", "n't", "expired", "avoid", " but ", "unsure", "pharmacist", "disagree", "covering", "allerg", "already took"];

export function speechFidelity(exp: Expected, saidRaw: string, lang = "en"): Fidelity {
  const reasons: FidelityReason[] = [];
  const said = strip(saidRaw);
  if (!said) return { ok: false, reasons: ["not_spoken"] };
  const want = strip(exp.speech);
  const code = (lang || "en").toLowerCase().slice(0, 2);
  const english = code === "en";

  // strengths: every strength in the rule's sentence must be said; none may be invented (digits work in any language)
  const ws = strengthsIn(want), gs = strengthsIn(said);
  const digitsOnly = !english && ![...gs].length && !/\d/.test(said);
  if (!digitsOnly) {
    for (const w of ws) if (!gs.has(w)) { reasons.push("strength_missing"); break; }
    for (const g of gs) if (!ws.has(g)) { reasons.push("strength_invented"); break; }
  }

  // a warning or "not sure" must never open like a yes
  if (exp.level === "warning" || exp.level === "unsure") {
    if (AFFIRM.test(said)) reasons.push("affirmative_on_caution");
    if (english && CAUTION.some((c) => want.includes(c)) && !CAUTION.some((c) => said.includes(c))) reasons.push("caution_dropped");
  }

  // the medicine or product named by the rules must be named aloud
  const names = (exp.names ?? []).map((n) => strip(n).split(" ")[0]).filter((n) => n.length >= 4 && want.includes(n));
  if (names.length) {
    const flat = said.replace(/[^a-z0-9]/g, "");
    if (!names.some((n) => flat.includes(n.slice(0, Math.min(6, n.length))))) reasons.push("name_missing");
  }

  // FI/SV: the fixed human-written opener must be there
  if (exp.lead && !english && !said.includes(strip(exp.lead).replace(/[.!]$/, ""))) reasons.push("lead_missing");

  return { ok: reasons.length === 0, reasons };
}
