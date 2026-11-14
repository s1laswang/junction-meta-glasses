import type { LabelRead, Med, Profile, Verdict } from "../../shared/types.ts";

export const STRENGTH_MIN_CONF = 0.8;
const NAME_MIN_CONF = 0.6;
const ALLERGEN_MIN_CONF = 0.6;

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
  marevan: "warfarin", waran: "warfarin", varfariini: "warfarin",
  simvastatiini: "simvastatin", zocor: "simvastatin", atorvastatiini: "atorvastatin", lipitor: "atorvastatin",
  levothyroxine: "levothyroxine", thyroxin: "levothyroxine", levotyroksiini: "levothyroxine",
  bisoprololi: "bisoprolol", emconcor: "bisoprolol", ramipriili: "ramipril", cardace: "ramipril",
  losec: "omeprazole", omeprazol: "omeprazole", omepratsoli: "omeprazole",
  somac: "pantoprazole", pantoprazol: "pantoprazole", pantopratsoli: "pantoprazole",
  nexium: "esomeprazole", esomeprazol: "esomeprazole", esomepratsoli: "esomeprazole",
  zolt: "lansoprazole", lansoprazol: "lansoprazole", lansopratsoli: "lansoprazole",
  heinix: "cetirizine", zyrtec: "cetirizine", setiritsiini: "cetirizine",
  clarityn: "loratadine", tuulix: "loratadine", loratadiini: "loratadine",
  aerius: "desloratadine", desloratadiini: "desloratadine",
  telfast: "fexofenadine", allegra: "fexofenadine", feksofenadiini: "fexofenadine",
  kestine: "ebastine", ebastiini: "ebastine",
  ventoline: "salbutamol", buventol: "salbutamol", albuterol: "salbutamol", salbutamoli: "salbutamol",
  prednisolon: "prednisolone", prednisoloni: "prednisolone",
  plavix: "clopidogrel", klopidogreeli: "clopidogrel",
  eliquis: "apixaban", apiksabaani: "apixaban",
  xarelto: "rivaroxaban", rivaroksabaani: "rivaroxaban",
  pradaxa: "dabigatran", dabigatraani: "dabigatran",
  lixiana: "edoxaban", edoksabaani: "edoxaban",
  klexane: "enoxaparin", enoksapariini: "enoxaparin",
  furesis: "furosemide", lasix: "furosemide", furosemidi: "furosemide",
  atacand: "candesartan", kandesartaani: "candesartan",
  cozaar: "losartan", losartaani: "losartan",
  diovan: "valsartan", valsartaani: "valsartan",
  zoloft: "sertraline", sertraliini: "sertraline",
  cipralex: "escitalopram", essitalopraami: "escitalopram",
  melatoniini: "melatonin", circadin: "melatonin",
  amorion: "amoxicillin", amoxin: "amoxicillin", amoksisilliini: "amoxicillin",
  doximycin: "doxycycline", doksisykliini: "doxycycline",
  seloken: "metoprolol", spesicor: "metoprolol", metoprololi: "metoprolol",
  tenormin: "atenolol", atenololi: "atenolol",
  propranololi: "propranolol", inderal: "propranolol",
  karvediloli: "carvedilol",
  nebivololi: "nebivolol", hypoloc: "nebivolol",
  renitec: "enalapril", enalapriili: "enalapril",
  lisinopriili: "lisinopril",
  coversyl: "perindopril", perindopriili: "perindopril",
};

const CLASSES: Record<string, string[]> = {
  nsaid: ["ibuprofen", "naproxen", "diclofenac", "aspirin", "ketoprofen", "etoricoxib", "celecoxib", "meloxicam", "dexketoprofen"],
  penicillin: ["penicillin", "amoxicillin", "ampicillin", "phenoxymethylpenicillin", "flucloxacillin", "dicloxacillin", "pivmecillinam"],
  benzodiazepine: ["diazepam", "oxazepam", "temazepam", "alprazolam", "lorazepam"],
  opioid: ["codeine", "tramadol", "oxycodone", "morphine", "buprenorphine", "fentanyl"],
  statin: ["simvastatin", "atorvastatin", "rosuvastatin"],
  anticoagulant: ["warfarin", "apixaban", "rivaroxaban", "dabigatran", "edoxaban", "enoxaparin"],
  beta_blocker: ["bisoprolol", "metoprolol", "atenolol", "propranolol", "carvedilol", "nebivolol"],
  ace_inhibitor: ["ramipril", "enalapril", "lisinopril", "perindopril"],
  ppi: ["omeprazole", "pantoprazole", "esomeprazole", "lansoprazole"],
  antihistamine: ["cetirizine", "loratadine", "desloratadine", "fexofenadine", "ebastine"],
};
const CLASS_ALIASES: Record<string, string> = {
  nsaid: "nsaid", nsaids: "nsaid", "anti-inflammatory": "nsaid", "anti-inflammatories": "nsaid", "anti inflammatories": "nsaid",
  "tulehduskipulaake": "nsaid", "tulehduskipulaakkeet": "nsaid", "painkillers nsaid": "nsaid",
  penicillin: "penicillin", penicillins: "penicillin", penisilliini: "penicillin",
  benzodiazepine: "benzodiazepine", benzodiazepines: "benzodiazepine", opioid: "opioid", opioids: "opioid",
  statin: "statin", statins: "statin",
  anticoagulant: "anticoagulant", anticoagulants: "anticoagulant",
  "blood thinner": "anticoagulant", "blood thinners": "anticoagulant", "blood-thinner": "anticoagulant", "blood-thinners": "anticoagulant",
  verenohennuslaake: "anticoagulant", verenohennuslaakkeet: "anticoagulant", antikoagulantti: "anticoagulant", blodfortunnande: "anticoagulant",
  beta_blocker: "beta_blocker", "beta blocker": "beta_blocker", "beta blockers": "beta_blocker",
  "beta-blocker": "beta_blocker", "beta-blockers": "beta_blocker", betablocker: "beta_blocker", betablockers: "beta_blocker",
  beetasalpaaja: "beta_blocker", beetasalpaajat: "beta_blocker", betablockerare: "beta_blocker",
  ace_inhibitor: "ace_inhibitor", "ace inhibitor": "ace_inhibitor", "ace inhibitors": "ace_inhibitor",
  "ace-inhibitor": "ace_inhibitor", "ace-inhibitors": "ace_inhibitor",
  "ace-estäjä": "ace_inhibitor", "ace-estaja": "ace_inhibitor", "ace-estajat": "ace_inhibitor",
  "ace estaja": "ace_inhibitor", "ace estajat": "ace_inhibitor", "ace-hammare": "ace_inhibitor", "ace hammare": "ace_inhibitor",
  ppi: "ppi", ppis: "ppi", "proton pump inhibitor": "ppi", "proton pump inhibitors": "ppi", "protonipumpun estaja": "ppi",
  antihistamine: "antihistamine", antihistamines: "antihistamine", antihistamiini: "antihistamine", antihistamiinit: "antihistamine", antihistamin: "antihistamine",
};
const CLASS_LABELS: Record<string, string> = {
  nsaid: "an NSAID", penicillin: "a penicillin", benzodiazepine: "a benzodiazepine", opioid: "an opioid",
  statin: "a statin", anticoagulant: "an anticoagulant", beta_blocker: "a beta blocker",
  ace_inhibitor: "an ACE inhibitor", ppi: "a PPI", antihistamine: "an antihistamine",
};

const ALLERGENS: Record<string, string[]> = {
  peanut: ["peanut", "peanuts", "arachis", "arachis oil", "groundnut", "groundnuts", "maapahkina", "maapahkinaa", "maapahkinat", "maapahkinoita", "maapahkinaoljy", "jordnot", "jordnotter", "jordnotsolja"],
  "tree nut": ["tree nut", "tree nuts", "hazelnut", "hazelnuts", "almond", "almonds", "cashew", "cashews", "walnut", "walnuts",
    "pecan", "pecans", "pistachio", "pistachios", "brazil nut", "brazil nuts", "macadamia", "macadamias",
    "hasselpahkina", "hasselpahkinaa", "hasselpahkinat", "manteli", "mantelia", "mantelit", "cashewpahkina", "cashewpahkinaa", "saksanpahkina", "saksanpahkinaa", "pekaanipahkina", "pekaanipahkinaa",
    "parapahkina", "parapahkinaa", "pistaasi", "pistaasipahkina", "pistaasipahkinaa", "makadamia", "makadamiapahkina", "makadamiapahkinaa",
    "hasselnot", "hasselnotter", "mandel", "mandlar", "valnot", "valnotter", "cashewnot", "cashewnotter",
    "pekannot", "paranot", "pistasch", "pistaschnot", "macadamianot", "tradnot", "tradnotter", "notter",
    "nuts", "pahkina", "pahkinaa", "pahkinat", "pahkinoita"],
  milk: ["milk", "lactose", "whey", "casein", "caseinate", "butter", "buttermilk", "cream", "milk powder", "dairy", "yoghurt", "yogurt", "cheese",
    "maito", "maitoa", "laktoosi", "laktoosia", "hera", "heraa", "heraproteiini", "kaseiini", "kaseinaatti", "voirasva", "voioljy", "kerma", "kermaa", "maitojauhe", "maitoproteiini", "kirnumaito", "juusto", "jogurtti",
    "mjolk", "laktos", "vassle", "kasein", "kaseinat", "smor", "gradde", "mjolkpulver", "mjolkprotein", "karnmjolk", "mejeriprodukter"],
  gluten: ["gluten", "wheat", "barley", "rye", "spelt", "oat", "oats", "kamut", "khorasan", "durum", "triticale", "semolina", "wheat starch", "wheat flour", "malt",
    "gluteeni", "gluteenia", "vehna", "vehnaa", "ohra", "ohraa", "ruis", "ruista", "kaura", "kauraa", "speltti", "spelttia", "vehnajauho", "vehnaproteiini", "ohramallas", "ruisjauho", "kaurahiutale",
    "vete", "korn", "rag", "havre", "dinkel", "vetemjol", "vetestarkelse", "kornmalt", "ragmjol"],
  egg: ["egg", "eggs", "albumin", "albumen", "ovalbumin", "lysozyme", "egg white", "egg yolk", "egg powder",
    "kananmuna", "kananmunaa", "muna", "munaa", "munat", "munavalkuainen", "munankeltuainen", "munajauhe", "albumiini", "lysotsyymi",
    "agg", "aggvita", "aggula", "aggpulver", "lysozym"],
  soy: ["soy", "soya", "soja", "soybean", "soybeans", "soya bean", "soya oil", "soy lecithin", "soya lecithin", "tofu", "edamame",
    "soija", "soijaa", "soijapapu", "soijaoljy", "soijalesitiini", "soijaproteiini",
    "sojabona", "sojabonor", "sojaolja", "sojalecitin", "sojaprotein"],
  sesame: ["sesame", "sesame seed", "sesame seeds", "sesame oil", "tahini",
    "seesami", "seesamia", "seesaminsiemen", "seesaminsiemenia", "seesaminsiemenet", "seesamioljy",
    "sesam", "sesamfro", "sesamfron", "sesamolja"],
  fish: ["fish", "anchovy", "anchovies", "cod", "salmon", "tuna", "herring", "mackerel", "trout", "pollock", "haddock", "sardine", "fish oil",
    "kala", "kalaa", "kalat", "lohi", "lohta", "turska", "tonnikala", "silakka", "silli", "anjovis", "makrilli", "kirjolohi", "kalaoljy",
    "fisk", "lax", "torsk", "tonfisk", "sill", "ansjovis", "makrill", "fiskolja"],
  crustacean: ["shellfish", "crustacean", "crustaceans", "shrimp", "shrimps", "prawn", "prawns", "crab", "lobster", "crayfish", "langoustine", "krill", "scampi",
    "ayriaiset", "ayriaisia", "ayriainen", "katkarapu", "katkarapua", "katkaravut", "rapu", "rapuja", "hummeri", "taskurapu",
    "kraftdjur", "skaldjur", "raka", "rakor", "krabba", "hummer", "krafta", "kraftor", "havskrafta"],
  mollusc: ["mollusc", "molluscs", "mollusk", "mollusks", "mussel", "mussels", "oyster", "oysters", "squid", "octopus", "clam", "clams", "scallop", "scallops", "calamari", "snail", "snails", "escargot", "whelk", "cockle",
    "nilviaiset", "nilviaisia", "nilviainen", "simpukka", "simpukkaa", "simpukat", "sinisimpukka", "osteri", "osterit", "kalmari", "mustekala", "kampasimpukka", "etana",
    "blotdjur", "mussla", "musslor", "blamussla", "ostron", "blackfisk", "kammussla", "snigel", "sniglar"],
  mustard: ["mustard", "mustard seed", "mustard seeds", "mustard flour",
    "sinappi", "sinappia", "sinapinsiemen", "sinapinsiemenia", "sinapinsiemenet", "sinappijauhe",
    "senap", "senapsfro", "senapsfron", "senapspulver"],
  celery: ["celery", "celeriac", "celery seed", "celery salt",
    "selleri", "selleria", "varsiselleri", "juuriselleri", "sellerinsiemen",
    "rotselleri", "stjalkselleri", "blekselleri", "sellerifro"],
  lupin: ["lupin", "lupins", "lupine", "lupines", "lupin flour", "lupin seed",
    "lupiini", "lupiinia", "lupiinit", "lupiinijauho", "lupiininsiemen",
    "lupiner", "lupinmjol", "lupinfro"],
  sulphite: ["sulphite", "sulphites", "sulfite", "sulfites", "sulphur dioxide", "sulfur dioxide", "metabisulphite", "metabisulfite",
    "sodium metabisulphite", "potassium metabisulphite", "e220", "e221", "e222", "e223", "e224", "e226", "e227", "e228",
    "rikkidioksidi", "rikkidioksidia", "sulfiitti", "sulfiitit", "sulfiitteja", "natriumdisulfiitti", "kaliumdisulfiitti",
    "svaveldioxid", "sulfit", "sulfiter", "natriumdisulfit", "kaliumdisulfit"],
};
function allergyBases(allergy: string): string[] {
  const a = norm(allergy).replace(/(?:-|\s)*allerg(?:y|ic|ies|ia|i)\b/g, " ").replace(/\s+/g, " ").trim();
  if (/^(nut|nuts|pahkina|pahkinat|notter)$/.test(a)) return ["peanut", "tree nut"];
  if (/^(peanuts?|maapahkinat?|jordnot(?:ter)?)$/.test(a)) return ["peanut"];
  if (/^(tree ?nuts?|tradnot(?:ter)?)$/.test(a)) return ["tree nut"];
  if (/^(lactose|dairy|milk|maito|laktoosi|laktoosi-intoleranssi|mjolk|laktos)$/.test(a)) return ["milk"];
  if (/^(wheat|gluten|celiacs?|coeliacs?|celiac disease|coeliac disease|keliakia|celiaki|gluteeni)$/.test(a)) return ["gluten"];
  if (/^(shellfish|skaldjur)$/.test(a)) return ["crustacean", "mollusc"];
  if (/^(crustaceans?|ayriaiset|kraftdjur)$/.test(a)) return ["crustacean"];
  if (/^(molluscs?|mollusks?|nilviaiset|blotdjur)$/.test(a)) return ["mollusc"];
  for (const [base, syns] of Object.entries(ALLERGENS)) if (base === a || syns.includes(a)) return [base];
  return [];
}

export type Strength = { amount: number; unit: string };
const UNIT: Record<string, { unit: string; f: number }> = {
  mg: { unit: "mg", f: 1 }, milligram: { unit: "mg", f: 1 },
  g: { unit: "mg", f: 1000 }, gram: { unit: "mg", f: 1000 },
  mcg: { unit: "mg", f: 0.001 }, ug: { unit: "mg", f: 0.001 }, "µg": { unit: "mg", f: 0.001 },
  mikrog: { unit: "mg", f: 0.001 }, mikrogram: { unit: "mg", f: 0.001 }, mikrogramma: { unit: "mg", f: 0.001 },
  mikrogrammaa: { unit: "mg", f: 0.001 }, microgram: { unit: "mg", f: 0.001 },
  ml: { unit: "ml", f: 1 }, iu: { unit: "iu", f: 1 }, ky: { unit: "iu", f: 1 }, "%": { unit: "%", f: 1 },
};
export function parseStrength(s: string | null | undefined): Strength[] {
  if (!s) return [];
  const t = s.toLowerCase().replace(/(\d),(\d)/g, "$1.$2").replace(/[µμ]/g, "u");
  const out: Strength[] = [];
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(milligram|microgram|mikrogrammaa|mikrogramma|mikrogram|mikrog|mcg|ug|mg|gram|g|ml|iu|ky)s?\b|(\d+(?:\.\d+)?)\s*(%)/g)) {
    const num = Number(m[1] ?? m[3]);
    const u = UNIT[m[2] ?? m[4]];
    if (!u || !Number.isFinite(num)) continue;
    out.push({ amount: +(num * u.f).toFixed(6), unit: u.unit });
  }
  return out;
}
function sameList(xs: Strength[], ys: Strength[]): boolean {
  if (xs.length !== ys.length) return false;
  const used = new Array<boolean>(ys.length).fill(false);
  return xs.every((x) => {
    const idx = ys.findIndex((y, i) => !used[i] && y.unit === x.unit && Math.abs(y.amount - x.amount) < 1e-6);
    if (idx < 0) return false;
    used[idx] = true;
    return true;
  });
}
export function sameStrength(a: string | null | undefined, b: string | null | undefined): boolean {
  const pa = parseStrength(a), pb = parseStrength(b);
  if (!pa.length || !pb.length) return false;
  const actA = pa.filter((x) => x.unit !== "ml"), actB = pb.filter((x) => x.unit !== "ml");
  const volA = pa.filter((x) => x.unit === "ml"), volB = pb.filter((x) => x.unit === "ml");
  if (!volA.length && a && /\/\s*ml\b/i.test(a)) volA.push({ amount: 1, unit: "ml" });
  if (!volB.length && b && /\/\s*ml\b/i.test(b)) volB.push({ amount: 1, unit: "ml" });
  if (!actA.length && !actB.length) return sameList(volA, volB);
  if (!sameList(actA, actB)) return false;
  return !volA.length || !volB.length || sameList(volA, volB);
}
export const fmtStrength = (s: string) => s.replace(/(\d)\s*(mg|g|mcg|ug|µg|mikrog|ml|iu|ky)\b/gi, "$1 $2");

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
const STOP = new Set(("tablet tablets tabletti tabletit tablettia capsule capsules kapseli kapselit film-coated filmdragerade " +
  "kalvopaallysteinen kalvopaallysteiset oral solution liuos pill pills strong forte retard depot mite " +
  "orion teva ratiopharm sandoz mylan krka actavis accord zentiva stada vitabalans hexal pfizer bayer " +
  "acid with from your this that each contains sisaltaa daily once twice").split(" "));
function hasWord(hay: string, needle: string): boolean {
  return new RegExp(`(^|[^a-z])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`).test(hay);
}
function lev(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 99;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
const fuzzyEq = (a: string, b: string) => a === b || (a.length >= 6 && b.length >= 6 && lev(a, b) <= 2);

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
      if (member) hits.push(`${member} is ${CLASS_LABELS[cls] ?? `a ${cls}`}, on your avoid list`);
      continue;
    }
    const inn = BRANDS[n] ?? n;
    if ([...got].some((g) => fuzzyEq(g, inn)) || hasWord(text, n)) hits.push(`${a} is on your avoid list`);
  }
  return hits;
}

export type AllergenHit = { allergy: string; found: string; mayContain: boolean };
export function allergenHits(read: LabelRead, allergies: string[]): AllergenHit[] {
  const declared = (read.allergens.value ?? []).map((x) => ({ raw: x, n: norm(x), may: /may contain|voi sisaltaa|saattaa sisaltaa|kan innehalla|traces?/.test(norm(x)) }));
  const ingr = ingredientsOf(read.ingredient.value, read.product.value);
  const hits: AllergenHit[] = [];
  for (const allergy of allergies) {
    const bases = allergyBases(allergy);
    const cleaned = norm(allergy).replace(/(?:-|\s)*allerg(?:y|ic|ies|ia|i)\b/g, " ").replace(/\s+/g, " ").trim();
    const drugCls = CLASS_ALIASES[norm(allergy)] ?? CLASS_ALIASES[cleaned] ?? (CLASSES[cleaned] ? cleaned : undefined);
    if (drugCls) {
      const m = CLASSES[drugCls].find((d) => [...ingr].some((g) => fuzzyEq(g, d)));
      if (m) hits.push({ allergy, found: m, mayContain: false });
      continue;
    }
    const terms = bases.length ? bases.flatMap((b) => ALLERGENS[b]) : [cleaned || norm(allergy)];
    for (const d of declared) {
      const hay = bases.includes("gluten") ? d.n.replace(/\bgluten[- ]free\b/g, " ") : d.n;
      const t = terms.find((term) => hasWord(hay, term) || hay.trim() === term);
      if (t) {
        hits.push({
          allergy,
          found: d.raw.replace(/^(may contain|voi sisältää|voi sisaltaa|saattaa sisältää|saattaa sisaltaa|kan innehålla|kan innehalla):?\s*/i, ""),
          mayContain: d.may,
        });
        break;
      }
    }
    const drugInn = BRANDS[cleaned] ?? cleaned;
    if (!bases.length && !hits.some((h) => h.allergy === allergy) && drugInn && [...ingr].some((g) => fuzzyEq(g, drugInn)))
      hits.push({ allergy, found: allergy, mayContain: false });
  }
  return hits;
}

export function isExpired(expiry: string | null | undefined, now = new Date()): boolean | undefined {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(expiry ?? "");
  if (!m) return undefined;
  const y = +m[1], mo = +m[2], d = m[3] ? +m[3] : undefined;
  if (mo < 1 || mo > 12) return undefined;
  if (d !== undefined) {
    const end = new Date(y, mo - 1, d, 23, 59, 59, 999);
    if (end.getFullYear() !== y || end.getMonth() !== mo - 1 || end.getDate() !== d) return undefined;
    return end.getTime() < now.getTime();
  }
  return new Date(y, mo, 0, 23, 59, 59, 999).getTime() < now.getTime();
}
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export function sayDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(iso);
  if (!m || +m[2] < 1 || +m[2] > 12) return iso;
  return `${m[3] ? +m[3] + " " : ""}${MONTHS[+m[2] - 1]} ${m[1]}`;
}

export function dosesToday(profile: Profile, medId: string, now = new Date()): number {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  return profile.doseLog.filter((d) => d.medId === medId && d.ts >= start.getTime() && d.ts <= now.getTime()).length;
}

export function clampHeadline(s: string): string {
  const w = s.trim().split(/\s+/);
  return w.length <= 8 ? s.trim() : w.slice(0, 8).join(" ").replace(/[,.;:]$/, "");
}
export function clampSpeech(s: string): string {
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

export function checkLabel(read: LabelRead, profile: Profile, now = new Date()): Verdict {
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
      : productName.replace(/\d+(?:[.,]\d+)?\s*(mg|g|mcg|ug|µg|mikrog|ml|iu|ky)\b.*$/i, "").trim();
    const name = cap(med ? (med.ingredient || med.name) : readName || "this medicine");
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
    if (avoid.length) return v("warning", `${label}: on your avoid list`, `This is ${label}. Your profile says to avoid it.`, { matchedMedId: med.id });
    if (!strengthOk) {
      reasons.push(read.strength.value ? `strength confidence ${read.strength.confidence.toFixed(2)} < ${STRENGTH_MIN_CONF}` : "strength not readable");
      return v("unsure", `${name}: strength unclear`, `It looks like ${name}, but I can't read the strength confidently. ${guidance ?? "Turn the box so the side panel faces you, or ask a pharmacist."}`, { matchedMedId: med.id });
    }
    if (!sameStrength(read.strength.value, med.strength)) {
      reasons.push(`strength ${read.strength.value} differs from your ${med.strength}`);
      return v("warning", `${label}: wrong strength`, `This is ${label}, but your list says ${fmtStrength(med.strength)}. Don't take it before checking with a pharmacist.`, { matchedMedId: med.id });
    }
    if (expired) return v("warning", `${label}: expired`, `This is ${label}, your medicine, but it expired in ${sayDate(read.expiry.value!)}. Don't take it, ask a pharmacist for a new pack.`, { matchedMedId: med.id });
    const taken = dosesToday(profile, med.id, now);
    const perDay = Math.max(1, med.schedule.length);
    const sw = scheduleWord(med);
    const yours = sw ? `your ${sw} pill` : "on your list";
    const takenSpeech = taken === 0 ? "You haven't taken it today." : taken >= perDay ? `You already took it today${taken > 1 ? `, ${taken} times` : ""}.` : `You've taken ${taken} of ${perDay} doses today.`;
    reasons.push(`matches ${med.id}`, `taken today: ${taken}/${perDay}`);
    return v(taken >= perDay ? "warning" : "match", taken >= perDay ? `${label}: already taken today` : `Yes: ${label}, ${yours}`.replace(", on your list", ""),
      `${taken >= perDay ? "This is" : "Yes,"} ${label}, ${yours}. ${takenSpeech}`, { matchedMedId: med.id, takenToday: taken > 0 });
  }

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
