// Deterministic safety check: LabelRead x Profile -> Verdict. No network, no model. Unit-tested.
import type { CrossCheck, Gs1Code, LabelRead, Med, Profile, Verdict } from "../../shared/types.ts";
import { gtin14 } from "./gs1.ts";

export const STRENGTH_MIN_CONF = 0.8;
const NAME_MIN_CONF = 0.6;
/** A "yes, this is your medicine" needs a confident identity and a readable label, not just a confident strength. */
export const MATCH_NAME_MIN_CONF = 0.8;
export const MATCH_MIN_READABILITY = 0.5;
const ALLERGEN_MIN_CONF = 0.6;

// ---------- normalisation ----------
export function norm(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[®™©]/g, "")
    .replace(/[^a-z0-9.,%/+ -]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
const words = (s: string) => norm(s).split(/[\s,/+()-]+/).filter((w) => w.length > 1);

// Brand / local name -> INN ingredient. Small, demo-relevant, extendable.
const BRANDS: Record<string, string> = {
  norvasc: "amlodipine", amlodipin: "amlodipine", amlodipiini: "amlodipine", amlodipinbesilat: "amlodipine",
  burana: "ibuprofen", advil: "ibuprofen", nurofen: "ibuprofen", ibumax: "ibuprofen", ibuprofeeni: "ibuprofen", brufen: "ibuprofen",
  panadol: "paracetamol", pamol: "paracetamol", "para-tabs": "paracetamol", paratabs: "paracetamol", tylenol: "paracetamol",
  acetaminophen: "paracetamol", parasetamoli: "paracetamol", tylenol500: "paracetamol",
  aleve: "naproxen", pronaxen: "naproxen", naprosyn: "naproxen", naprokseeni: "naproxen",
  voltaren: "diclofenac", diklofenaakki: "diclofenac",
  disperin: "aspirin", primaspan: "aspirin", aspirin: "aspirin", "acetylsalicylic acid": "aspirin", asa: "aspirin",
  asetyylisalisyylihappo: "aspirin",
  glucophage: "metformin", metformiini: "metformin",
  zopinox: "zopiclone", imovane: "zopiclone", tsopikloni: "zopiclone",
  marevan: "warfarin", varfariini: "warfarin",
  simvastatiini: "simvastatin", zocor: "simvastatin", atorvastatiini: "atorvastatin", lipitor: "atorvastatin",
  levothyroxine: "levothyroxine", thyroxin: "levothyroxine", levotyroksiini: "levothyroxine",
  bisoprololi: "bisoprolol", emconcor: "bisoprolol", ramipriili: "ramipril", cardace: "ramipril",
};

// Drug classes for the avoid list / drug allergies.
const CLASSES: Record<string, string[]> = {
  nsaid: ["ibuprofen", "naproxen", "diclofenac", "aspirin", "ketoprofen", "etoricoxib", "celecoxib", "meloxicam", "dexketoprofen"],
  penicillin: ["penicillin", "amoxicillin", "ampicillin", "phenoxymethylpenicillin", "flucloxacillin", "dicloxacillin", "pivmecillinam"],
  benzodiazepine: ["diazepam", "oxazepam", "temazepam", "alprazolam", "lorazepam"],
  opioid: ["codeine", "tramadol", "oxycodone", "morphine", "buprenorphine", "fentanyl"],
  statin: ["simvastatin", "atorvastatin", "rosuvastatin"],
};
const CLASS_ALIASES: Record<string, string> = {
  nsaid: "nsaid", nsaids: "nsaid", "anti-inflammatory": "nsaid", "anti-inflammatories": "nsaid", "anti inflammatories": "nsaid",
  "tulehduskipulaake": "nsaid", "tulehduskipulaakkeet": "nsaid", "painkillers nsaid": "nsaid",
  penicillin: "penicillin", penicillins: "penicillin", penisilliini: "penicillin",
  benzodiazepine: "benzodiazepine", benzodiazepines: "benzodiazepine", opioid: "opioid", opioids: "opioid",
  statin: "statin", statins: "statin",
};

// Allergen synonyms (base allergen -> label terms). Matching is substring on normalised words.
const ALLERGENS: Record<string, string[]> = {
  peanut: ["peanut", "peanuts", "arachis", "groundnut", "groundnuts", "maapahkina", "jordnot"],
  "tree nut": ["tree nut", "tree nuts", "hazelnut", "hazelnuts", "almond", "almonds", "cashew", "cashews", "walnut", "walnuts",
    "pecan", "pistachio", "brazil nut", "macadamia", "hasselpahkina", "manteli", "cashewpahkina", "saksanpahkina",
    "pekaanipahkina", "hasselnot", "mandel", "valnot", "nuts", "pahkina", "pahkinoita"],
  milk: ["milk", "lactose", "whey", "casein", "caseinate", "butter", "cream", "maito", "laktoosi", "hera", "mjolk", "dairy"],
  gluten: ["gluten", "wheat", "barley", "rye", "spelt", "vehna", "ohra", "ruis", "gluteeni", "vete", "wheat starch"],
  egg: ["egg", "eggs", "albumin", "kananmuna", "muna", "agg"],
  soy: ["soy", "soya", "soja", "soybean", "soya oil", "soijaoljy", "soija"],
  sesame: ["sesame", "tahini", "seesami", "sesam"],
  fish: ["fish", "kala", "fisk", "anchovy", "cod", "salmon"],
  crustacean: ["shellfish", "crustacean", "crustaceans", "shrimp", "prawn", "crab", "lobster", "ayriaiset", "katkarapu"],
  mustard: ["mustard", "sinappi", "senap"],
  celery: ["celery", "selleri"],
  lupin: ["lupin", "lupiini"],
  sulphite: ["sulphite", "sulphites", "sulfite", "sulfites", "sulphur dioxide", "sulfur dioxide", "rikkidioksidi"],
};
// Profile allergy wording -> base allergens.
function allergyBases(allergy: string): string[] {
  const a = norm(allergy).replace(/\s*allerg(y|ic|ies)\s*/g, " ").trim();
  if (/^(nut|nuts|pahkina|pahkinat)$/.test(a)) return ["peanut", "tree nut"]; // "nut allergy": be conservative
  if (/^peanuts?$/.test(a)) return ["peanut"];
  if (/^tree ?nuts?$/.test(a)) return ["tree nut"];
  if (/^(lactose|dairy|milk|maito)$/.test(a)) return ["milk"];
  if (/^(wheat|gluten|celiac|coeliac)$/.test(a)) return ["gluten"];
  if (/^(shellfish|crustaceans?)$/.test(a)) return ["crustacean"];
  for (const [base, syns] of Object.entries(ALLERGENS)) if (base === a || syns.includes(a)) return [base];
  return [];
}

export type Strength = { amount: number; unit: string };
const UNIT: Record<string, { unit: string; f: number }> = {
  mg: { unit: "mg", f: 1 }, g: { unit: "mg", f: 1000 }, mcg: { unit: "mg", f: 0.001 }, ug: { unit: "mg", f: 0.001 },
  "µg": { unit: "mg", f: 0.001 }, mikrog: { unit: "mg", f: 0.001 }, microgram: { unit: "mg", f: 0.001 },
  ml: { unit: "ml", f: 1 }, iu: { unit: "iu", f: 1 }, ky: { unit: "iu", f: 1 }, "%": { unit: "%", f: 1 },
};
/** "5mg" / "5 MG" / "2,5 mg" / "0.5 g" / "500 mg/5 ml" -> list of normalised amounts (mass in mg). */
export function parseStrength(s: string | null | undefined): Strength[] {
  if (!s) return [];
  const t = s.toLowerCase().replace(/(\d),(\d)/g, "$1.$2").replace(/µ/g, "u");
  const out: Strength[] = [];
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(mg|mcg|ug|g|ml|iu|ky|%|mikrog|microgram)s?\b|(\d+(?:\.\d+)?)\s*(%)/g)) {
    const num = Number(m[1] ?? m[3]);
    const u = UNIT[m[2] ?? m[4]];
    if (!u || !Number.isFinite(num)) continue;
    out.push({ amount: +(num * u.f).toFixed(6), unit: u.unit });
  }
  return out;
}
export function sameStrength(a: string | null | undefined, b: string | null | undefined): boolean {
  const pa = parseStrength(a), pb = parseStrength(b);
  if (!pa.length || !pb.length) return false;
  // compare the primary (first) amount; for combos require all of the shorter list to be present
  const [short, long] = pa.length <= pb.length ? [pa, pb] : [pb, pa];
  return short.every((x) => long.some((y) => y.unit === x.unit && Math.abs(y.amount - x.amount) < 1e-6));
}
export const fmtStrength = (s: string) => s.replace(/(\d)\s*(mg|g|mcg|ml|iu)\b/gi, "$1 $2");

/** Resolve free text (product or ingredient) to a set of INN ingredient tokens. */
export function ingredientsOf(...texts: (string | null | undefined)[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts) {
    const n = norm(t);
    if (!n) continue;
    for (const [brand, inn] of Object.entries(BRANDS)) if (hasWord(n, brand)) out.add(inn);
    for (const w of words(n)) {
      if (/^\d/.test(w) || w.length < 4 || STOP.has(w)) continue;
      out.add(BRANDS[w] ?? w);
    }
  }
  return out;
}
// Pack words, forms and manufacturers that must never count as an ingredient match.
const STOP = new Set(("tablet tablets tabletti tabletit tablettia capsule capsules kapseli kapselit film-coated filmdragerade " +
  "kalvopaallysteinen kalvopaallysteiset oral solution liuos pill pills strong forte retard depot mite " +
  "orion teva ratiopharm sandoz mylan krka actavis accord zentiva stada vitabalans hexal pfizer bayer " +
  "acid with from your this that each contains sisaltaa daily once twice").split(" "));
function hasWord(hay: string, needle: string): boolean {
  return new RegExp(`(^|[^a-z])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`).test(hay);
}
function lev(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 1) return 99;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
const INN_STEM = /(dipine|zepam|zolam|prazole|statin|sartan|olol|pril|oxacin|cillin|cycline|mycin|conazole|nidazole|ciclovir|caine|fentanil|setron|triptan|gliptin|gliflozin|tidine|rubicin|platin|lukast|profen|methasone|olone|sone|barbital|citalopram|zopiclone)$/;
const CHEM_SWAP = new Set(["ol:al", "al:ol", "ate:ite", "ite:ate", "one:ine", "ine:one"]);
export function fuzzyEq(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 7 || b.length < 7 || a.slice(0, 4) !== b.slice(0, 4) || lev(a, b) !== 1) return false;
  for (const s of ["ol", "al", "ate", "ite", "one", "ine"])
    for (const t of ["ol", "al", "ate", "ite", "one", "ine"])
      if (CHEM_SWAP.has(`${s}:${t}`) && a.endsWith(s) && b.endsWith(t)) return false;
  const sa = INN_STEM.exec(a)?.[0], sb = INN_STEM.exec(b)?.[0];
  if (sa && sb) return sa === sb && a.length - sa.length >= 5 && b.length - sb.length >= 5;
  return true;
}

function medIngredients(m: Med): Set<string> {
  return ingredientsOf(m.ingredient, m.name);
}
export function matchMed(read: LabelRead, meds: Med[]): Med | undefined {
  const got = ingredientsOf(read.ingredient.value, read.product.value);
  if (!got.size) return undefined;
  let best: { m: Med; score: number } | undefined;
  for (const m of meds) {
    const want = medIngredients(m);
    let score = 0;
    for (const w of want) for (const g of got) if (fuzzyEq(w, g)) score += w === norm(m.ingredient) ? 2 : 1;
    // brand name printed exactly as saved
    if (m.name && read.product.value && hasWord(norm(read.product.value), norm(m.name))) score += 1;
    if (score && (!best || score > best.score || (score === best.score && sameStrength(m.strength, read.strength.value))))
      best = { m, score };
  }
  return best?.m;
}

export function avoidHits(read: LabelRead, avoid: string[]): string[] {
  const got = ingredientsOf(read.ingredient.value, read.product.value);
  const text = norm([read.product.value, read.ingredient.value].filter(Boolean).join(" "));
  const hits: string[] = [];
  for (const a of avoid) {
    const n = norm(a);
    if (!n) continue;
    const cls = CLASS_ALIASES[n] ?? (CLASSES[n] ? n : undefined);
    if (cls) {
      const member = CLASSES[cls].find((d) => [...got].some((g) => fuzzyEq(g, d)));
      if (member) hits.push(`${member} is an ${cls === "nsaid" ? "NSAID" : cls}, on your avoid list`);
      continue;
    }
    const inn = BRANDS[n] ?? n;
    if ([...got].some((g) => fuzzyEq(g, inn)) || hasWord(text, n)) hits.push(`${a} is on your avoid list`);
  }
  return hits;
}

export type AllergenHit = { allergy: string; found: string; mayContain: boolean };
export function allergenHits(read: LabelRead, allergies: string[]): AllergenHit[] {
  const declared = (read.allergens.value ?? []).map((x) => ({ raw: x, n: norm(x), may: /may contain|voi sisaltaa|kan innehalla|traces?/.test(norm(x)) }));
  // medication excipients / drug allergies via ingredient too
  const ingr = ingredientsOf(read.ingredient.value, read.product.value);
  const hits: AllergenHit[] = [];
  for (const allergy of allergies) {
    const bases = allergyBases(allergy);
    const drugCls = CLASS_ALIASES[norm(allergy)] ?? (CLASSES[norm(allergy)] ? norm(allergy) : undefined);
    if (drugCls) {
      const m = CLASSES[drugCls].find((d) => [...ingr].some((g) => fuzzyEq(g, d)));
      if (m) hits.push({ allergy, found: m, mayContain: false });
      continue;
    }
    const terms = bases.length ? bases.flatMap((b) => ALLERGENS[b]) : [norm(allergy)];
    for (const d of declared) {
      const t = terms.find((term) => hasWord(d.n, term) || d.n === term);
      if (t) { hits.push({ allergy, found: d.raw.replace(/^may contain:\s*/i, ""), mayContain: d.may }); break; }
    }
    if (!bases.length && !hits.some((h) => h.allergy === allergy) && [...ingr].some((g) => fuzzyEq(g, norm(allergy))))
      hits.push({ allergy, found: allergy, mayContain: false });
  }
  return hits;
}

/** ISO "YYYY-MM" or "YYYY-MM-DD" -> expired as of `now`? (month precision = end of that month) */
export function isExpired(expiry: string | null | undefined, now = new Date()): boolean | undefined {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(expiry ?? "");
  if (!m) return undefined;
  const y = +m[1], mo = +m[2], d = m[3] ? +m[3] : undefined;
  const end = d ? new Date(y, mo - 1, d, 23, 59, 59) : new Date(y, mo, 0, 23, 59, 59);
  return end.getTime() < now.getTime();
}
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export function sayDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(iso);
  if (!m) return iso;
  return `${m[3] ? +m[3] + " " : ""}${MONTHS[+m[2] - 1]} ${m[1]}`;
}

/** "amlodipine besilate" -> "amlodipine": salt forms are on the box in small print, people say the base name. */
const SALTS = /\s+(besilate|besylate|maleate|mesilate|mesylate|hydrochloride|hcl|sodium|potassium|calcium|magnesium|tartrate|succinate|fumarate|citrate|sulfate|sulphate|phosphate|acetate|bromide|dihydrate|monohydrate|trihydrate)\b/gi;
export function spokenIngredient(s: string | null | undefined): string {
  return (s ?? "").replace(SALTS, "").replace(/\s+/g, " ").trim();
}

/** "2024-11" / "2024-11-30" -> "November 2024" */
export function monthYear(iso: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(iso);
  return m ? `${MONTHS[+m[2] - 1]} ${m[1]}` : iso;
}

export function dosesToday(profile: Profile, medId: string, now = new Date()): number {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  return profile.doseLog.filter((d) => d.medId === medId && d.ts >= start.getTime() && d.ts <= now.getTime()).length;
}

// ---------- output limits ----------
export function clampHeadline(s: string): string {
  const w = s.trim().split(/\s+/);
  return w.length <= 8 ? s.trim() : w.slice(0, 8).join(" ").replace(/[,.;:]$/, "");
}
export function clampSpeech(s: string): string {
  // sentence boundary = .!? followed by whitespace, so "2.5 mg" never splits
  return s.trim().split(/(?<=[.!?])\s+/).slice(0, 2).join(" ").trim();
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const listAnd = (xs: string[]) => xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;

function scheduleWord(m: Med): string | undefined {
  const s = m.schedule.map((x) => x.toLowerCase());
  for (const w of ["morning", "noon", "evening", "night", "bedtime"]) if (s.some((x) => x.includes(w))) return w;
  if (s.length === 1 && /^\d{1,2}:\d{2}$/.test(s[0])) {
    const h = +s[0].split(":")[0];
    return h < 11 ? "morning" : h < 15 ? "midday" : h < 21 ? "evening" : "night";
  }
  return undefined;
}

// ---------- main ----------
/** The text-only check (no machine code). `checkLabel` wraps it with the DataMatrix cross-check. */
export function checkLabelText(read: LabelRead, profile: Profile, now = new Date()): Verdict {
  const reasons: string[] = [];
  const v = (level: Verdict["level"], headline: string, speech: string, extra: Partial<Verdict> = {}): Verdict => ({
    level, headline: clampHeadline(headline), speech: clampSpeech(speech), read, reasons, ...extra,
  });
  const guidance = read.guidance?.trim();
  const nameOk = (read.ingredient.value && read.ingredient.confidence >= NAME_MIN_CONF) || (read.product.value && read.product.confidence >= NAME_MIN_CONF);
  const productName = (read.product.confidence >= NAME_MIN_CONF && read.product.value) || (read.ingredient.confidence >= NAME_MIN_CONF && read.ingredient.value) || "";

  if (read.kind === "unreadable" || (!nameOk && read.readability < 0.5)) {
    reasons.push("label not readable");
    return v("unsure", "Can't read the label yet", `I can't read the label yet. ${guidance ?? "Turn it slowly so the front faces you."}`);
  }

  // Safety signals that apply to every kind.
  const allergyHits = read.allergens.confidence >= 0.3 || read.kind === "medication" ? allergenHits(read, profile.allergies) : [];
  const avoid = avoidHits(read, profile.avoid);
  const expired = read.expiry.value && read.expiry.confidence >= 0.7 ? isExpired(read.expiry.value, now) : undefined;
  for (const h of allergyHits) reasons.push(`${h.mayContain ? "may contain" : "contains"} ${h.found} (allergy: ${h.allergy})`);
  reasons.push(...avoid);
  if (expired) reasons.push(`expired ${read.expiry.value}`);

  if (read.kind === "medication") {
    const med = nameOk ? matchMed(read, profile.meds) : undefined;
    const strengthOk = !!read.strength.value && read.strength.confidence >= STRENGTH_MIN_CONF;
    const readName = read.ingredient.value && read.ingredient.confidence >= NAME_MIN_CONF
      ? read.ingredient.value.split(",")[0].trim()
      : productName.replace(/\d+(?:[.,]\d+)?\s*(mg|g|mcg|µg|ml|iu)\b.*$/i, "").trim();
    const name = cap(med ? spokenIngredient(med.ingredient) || med.name : readName || "this medicine");
    const label = strengthOk ? `${name} ${fmtStrength(read.strength.value!)}` : name;

    if (allergyHits.length) {
      const h = allergyHits[0];
      return v("warning", `Warning: ${h.found}, you're allergic`, `Warning: this is ${label} and it ${h.mayContain ? "may contain" : "contains"} ${h.found}. Your profile lists an allergy to ${h.allergy}.`, { matchedMedId: med?.id });
    }
    if (!med) {
      if (!nameOk) {
        reasons.push("medicine name not confident");
        return v("unsure", "Can't read the medicine name", `I can't read the name confidently. ${guidance ?? "Turn the box so the front faces you, or ask a pharmacist."}`);
      }
      reasons.push("not on your medication list");
      const why = avoid.length ? ` and your list says to avoid ${avoid[0].includes("NSAID") ? "NSAIDs" : avoid[0].replace(/ is .*/, "")}` : "";
      return v("warning", `${label}: not on your list`, `This is ${label}. It isn't on your medication list${why}.`);
    }
    // matched a saved med
    if (avoid.length) return v("warning", `${label}: on your avoid list`, `This is ${label}. Your profile says to avoid it.`, { matchedMedId: med.id });
    const nameConf = Math.max(read.ingredient.value ? read.ingredient.confidence : 0, read.product.value ? read.product.confidence : 0);
    if (nameConf < MATCH_NAME_MIN_CONF || read.readability < MATCH_MIN_READABILITY) {
      reasons.push(`identity not confident (name ${nameConf.toFixed(2)}, readability ${read.readability.toFixed(2)})`);
      return v("unsure", `Might be ${name}, not sure`, `It might be ${name}, but I can't read the label clearly enough to be sure. ${guidance ?? "Bring it a bit closer and hold it still."}`, { matchedMedId: med.id });
    }
    if (!strengthOk) {
      reasons.push(read.strength.value ? `strength confidence ${read.strength.confidence.toFixed(2)} < ${STRENGTH_MIN_CONF}` : "strength not readable");
      return v("unsure", `${name}: strength unclear`, `It looks like ${name}, but I can't read the strength confidently. ${guidance ?? "Turn the box so the side panel faces you, or ask a pharmacist."}`, { matchedMedId: med.id });
    }
    if (!sameStrength(read.strength.value, med.strength)) {
      reasons.push(`strength ${read.strength.value} differs from your ${med.strength}`);
      return v("warning", `${label}: wrong strength`, `This is ${label}, but your list says ${fmtStrength(med.strength)}. Don't take it before checking with a pharmacist.`, { matchedMedId: med.id });
    }
    if (expired) {
      return v("warning", `${label}: expired ${monthYear(read.expiry.value!)}`,
        `This is ${label}, your medicine. This box expired in ${monthYear(read.expiry.value!)}, so ask a pharmacist for a new one.`, { matchedMedId: med.id });
    }
    // expiry unknown (not legible / low confidence): still a match, but say so
    const expiryUnknown = !read.expiry.value || read.expiry.confidence < 0.7;
    if (expiryUnknown) reasons.push("expiry not readable");
    const taken = dosesToday(profile, med.id, now);
    const perDay = Math.max(1, med.schedule.length);
    const sw = scheduleWord(med);
    const yours = sw ? `your ${sw} pill` : "on your list";
    const takenSpeech = (taken === 0 ? "You haven't taken it today" : taken >= perDay ? `You already took it today${taken > 1 ? `, ${taken} times` : ""}` : `You've taken ${taken} of ${perDay} doses today`)
      // speech stays <= 2 sentences: the expiry note joins the second sentence
      + (expiryUnknown ? ", and I couldn't read the expiry date." : ".");
    reasons.push(`matches ${med.id}`, `taken today: ${taken}/${perDay}`);
    return v(taken >= perDay ? "warning" : "match", taken >= perDay ? `${label}: already taken today` : `Yes: ${label}, ${yours}`.replace(", on your list", ""),
      `${taken >= perDay ? "This is" : "Yes,"} ${label}, ${yours}. ${takenSpeech}`, { matchedMedId: med.id, takenToday: taken > 0 });
  }

  // food / other
  const what = productName || (read.kind === "food" ? "this food" : "this item");
  const exp = read.expiry.value && read.expiry.confidence >= 0.7 ? read.expiry.value : undefined;
  if (allergyHits.length) {
    const sure = allergyHits.filter((h) => !h.mayContain);
    const h = sure[0] ?? allergyHits[0];
    const found = listAnd([...new Set((sure.length ? sure : allergyHits).map((x) => x.found))]);
    return v("warning", `Warning: ${h.mayContain ? "may contain" : "contains"} ${h.found}`,
      `Warning: ${what} ${h.mayContain ? "may contain" : "contains"} ${found}. Your profile lists an allergy to ${listAnd([...new Set(allergyHits.map((x) => x.allergy))])}.`);
  }
  if (avoid.length) return v("warning", `${cap(what)}: on your avoid list`, `${cap(what)} is on your avoid list.`);
  if (expired) return v("warning", `${cap(what)}: past its date`, `${cap(what)} was best before ${sayDate(exp!)}.`);
  const expSpeech = exp ? ` Best before ${sayDate(exp)}.` : "";
  if (read.kind === "food" && profile.allergies.length) {
    if (read.allergens.value === null || read.allergens.confidence < ALLERGEN_MIN_CONF) {
      reasons.push("allergen panel not readable");
      return v("unsure", "Can't read the allergens yet", `This is ${what}, but I can't read the allergen list. ${guidance ?? "Turn the pack to show the ingredients panel."}`);
    }
    reasons.push("no listed allergen matches your profile");
    return v("info", `${cap(what)}: none of your allergens`, `${cap(what)}: no ${listAnd(profile.allergies)} listed.${expSpeech}`);
  }
  return v("info", cap(what), `This is ${what}.${expSpeech}`);
}

// ---------- EU FMD DataMatrix cross-check ----------
const PHARMACIST = "The printed label and the pack's code disagree. Please ask a pharmacist.";
const medGtin = (m: Med) => gtin14(m.gtin) ?? gtin14(m.barcode);

/** Insert a short phrase into the first sentence so the speech stays <= 2 sentences. */
function withPhrase(speech: string, phrase: string): string {
  const parts = speech.trim().split(/(?<=[.!?])\s+/);
  if (parts.length < 2) return `${speech.trim()} ${cap(phrase)}.`;
  parts[0] = parts[0].replace(/[.!?]$/, `, ${phrase}.`);
  return parts.join(" ");
}

/**
 * Full check. Without a code (or a code with no usable fields) this is exactly checkLabelText().
 * With a fresh DataMatrix code for the current item:
 *  - printed expiry legible and different from the code, or the code's GTIN belongs to a different saved med than
 *    the text match -> unsure (ask a pharmacist);
 *  - code expiry in the past -> warning (exact, no confidence issue);
 *  - code GTIN = a saved med's GTIN but no legible name -> still unsure (online we want both);
 *  - agreement -> crossCheck.agrees=true and "double-checked with the pack's code" in the speech.
 */
export function checkLabel(read: LabelRead, profile: Profile, now = new Date(), code?: Gs1Code): Verdict {
  if (!code || (!code.gtin && !code.expiry)) return checkLabelText(read, profile, now);
  const details: string[] = [];
  let agree = 0, conflict = false;

  const nameOk = (read.ingredient.value && read.ingredient.confidence >= NAME_MIN_CONF) || (read.product.value && read.product.confidence >= NAME_MIN_CONF);
  const textMed = nameOk ? matchMed(read, profile.meds) : undefined;
  const codeG = gtin14(code.gtin);
  const gtinMed = codeG ? profile.meds.find((m) => medGtin(m) === codeG) : undefined;
  const medName = (m: Med) => cap(spokenIngredient(m.ingredient) || m.name);

  // expiry
  const printedOk = !!read.expiry.value && read.expiry.confidence >= 0.7;
  if (code.expiry) {
    if (printedOk) {
      const a = code.expiry.slice(0, 7), b = read.expiry.value!.slice(0, 7);
      if (a === b) { agree++; details.push(`expiry: code ${code.expiry} = print ${read.expiry.value}`); }
      else { conflict = true; details.push(`expiry: code ${code.expiry} != print ${read.expiry.value}`); }
    } else details.push(`expiry from code ${code.expiry} (print not legible)`);
  }
  // GTIN
  if (codeG) {
    const g = code.gtin;
    if (gtinMed && textMed && gtinMed.id !== textMed.id) { conflict = true; details.push(`GTIN ${g} = your ${gtinMed.name}, but the print reads ${textMed.name}`); }
    else if (gtinMed && !textMed && nameOk) { conflict = true; details.push(`GTIN ${g} = your ${gtinMed.name}, but the print reads a medicine not on your list`); }
    else if (gtinMed && textMed) { agree++; details.push(`GTIN ${g} = your ${gtinMed.name}`); }
    else if (gtinMed) details.push(`GTIN ${g} = your ${gtinMed.name} (print not legible)`);
    else details.push(`GTIN ${g} not saved in your list`);
  }
  const crossCheck: CrossCheck = { source: "datamatrix", code, agrees: conflict ? false : agree > 0 ? true : null, details };
  const mk = (level: Verdict["level"], headline: string, speech: string, extra: Partial<Verdict> = {}): Verdict => ({
    level, headline: clampHeadline(headline), speech: clampSpeech(speech), read, reasons: [...details], crossCheck, ...extra,
  });

  if (conflict) return mk("unsure", "Label and pack code disagree", PHARMACIST, { matchedMedId: textMed?.id });

  // the code's expiry is exact: a past date is a warning regardless of how well the print was read
  if (code.expiry && isExpired(code.expiry, now)) {
    const who = textMed ? `This is ${medName(textMed)}, but the` : "The";
    return mk("warning", `Expired ${monthYear(code.expiry)} (pack code)`,
      `${who} pack's code says it expired in ${monthYear(code.expiry)}. Don't take it, ask a pharmacist for a new one.`, { matchedMedId: textMed?.id });
  }
  if (gtinMed && !textMed) {
    return mk("unsure", `Code says ${medName(gtinMed)}, label unreadable`,
      `The pack's code matches your ${medName(gtinMed)}, but I can't read the label to confirm. ${read.guidance?.trim() ?? "Turn it so the front faces you."}`, { matchedMedId: gtinMed.id });
  }
  // text check, with the exact code expiry standing in for an illegible printed one
  const eff: LabelRead = code.expiry && !printedOk ? { ...read, expiry: { value: code.expiry, confidence: 1 } } : read;
  const v = checkLabelText(eff, profile, now);
  v.read = read;
  v.reasons = [...v.reasons, ...details];
  v.crossCheck = crossCheck;
  if (crossCheck.agrees) v.speech = clampSpeech(withPhrase(v.speech, "double-checked with the pack's code"));
  return v;
}
