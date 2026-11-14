import { type CSSProperties } from "react";
import { normalizeLang, t, type UiLocale } from "../i18n/translations.ts";
import type { Med, Profile } from "../types.ts";

export const STRENGTH_MIN_CONF = 0.8;

export type ActiveGuardrailSummary = {
  id: string;
  title: string;
  badge: string;
  detail: string;
  activeCount: number;
};

export type SafetyRuleExplainerCardProps = {
  profile: Profile;
  lang: string;
};

type GuardrailId =
  | "strength_gate"
  | "rx_match"
  | "drug_avoid"
  | "allergens"
  | "expiry_guard"
  | "double_dose";

type CardCopy = {
  eyebrow: string;
  heading: string;
  subtitle: string;
  onDevicePill: string;
  armedBadge: (armedLayers: number, totalLayers: number) => string;
  listAriaLabel: string;
  mdrHeading: string;
  mdrBody: string;
  titles: Record<GuardrailId, string>;
  strengthBadge: string;
  strengthDetail: string;
  rxBadge: (count: number) => string;
  rxDetailPopulated: (count: number, preview: string) => string;
  rxDetailEmpty: string;
  avoidBadge: (count: number) => string;
  avoidDetailPopulated: (count: number, preview: string) => string;
  avoidDetailEmpty: string;
  allergensBadge: (count: number) => string;
  allergensDetailPopulated: (count: number, preview: string, examples: string) => string;
  allergensDetailEmpty: string;
  expiryBadge: string;
  expiryDetail: string;
  doubleDoseBadge: (count: number) => string;
  doubleDoseDetail: (loggedCount: number, scheduledSlots: number) => string;
  moreSuffix: (extra: number) => string;
};

const AVOID_CLASS_EXAMPLES: Record<string, string> = {
  nsaid: "NSAIDs -> ibuprofen / Burana",
  nsaids: "NSAIDs -> ibuprofen / Burana",
  "anti-inflammatory": "NSAIDs -> ibuprofen / Burana",
  "anti-inflammatories": "NSAIDs -> ibuprofen / Burana",
  tulehduskipulaake: "NSAIDs -> ibuprofen / Burana",
  tulehduskipulaakkeet: "NSAIDs -> ibuprofen / Burana",
  penicillin: "penicillins -> amoxicillin / Amorion",
  penicillins: "penicillins -> amoxicillin / Amorion",
  penisilliini: "penicillins -> amoxicillin / Amorion",
  statin: "statins -> simvastatin / atorvastatin",
  statins: "statins -> simvastatin / atorvastatin",
  anticoagulant: "anticoagulants -> warfarin / Marevan",
  anticoagulants: "anticoagulants -> warfarin / Marevan",
  "blood thinner": "anticoagulants -> warfarin / Marevan",
  "blood thinners": "anticoagulants -> warfarin / Marevan",
  verenohennuslaake: "anticoagulants -> warfarin / Marevan",
  blodfortunnande: "anticoagulants -> warfarin / Marevan",
  beta_blocker: "beta blockers -> bisoprolol / metoprolol",
  "beta blocker": "beta blockers -> bisoprolol / metoprolol",
  "beta blockers": "beta blockers -> bisoprolol / metoprolol",
  beetasalpaaja: "beta blockers -> bisoprolol / metoprolol",
  betablockerare: "beta blockers -> bisoprolol / metoprolol",
  ace_inhibitor: "ACE inhibitors -> ramipril / enalapril",
  "ace inhibitor": "ACE inhibitors -> ramipril / enalapril",
  "ace inhibitors": "ACE inhibitors -> ramipril / enalapril",
  ppi: "PPIs -> omeprazole / Somac",
  ppis: "PPIs -> omeprazole / Somac",
  opioid: "opioids -> codeine / tramadol",
  opioids: "opioids -> codeine / tramadol",
  benzodiazepine: "benzodiazepines -> diazepam / oxazepam",
  benzodiazepines: "benzodiazepines -> diazepam / oxazepam",
  antihistamine: "antihistamines -> cetirizine / Heinix",
  antihistamines: "antihistamines -> cetirizine / Heinix"
};

const ALLERGEN_SYNONYM_EXAMPLES: Record<string, string> = {
  peanut: "arachis -> peanut",
  peanuts: "arachis -> peanut",
  maapahkina: "arachis -> peanut",
  jordnot: "arachis -> peanut",
  "tree nut": "hasselpahkina -> tree nuts",
  "tree nuts": "hasselpahkina -> tree nuts",
  nuts: "hasselpahkina -> tree nuts",
  nut: "hasselpahkina -> tree nuts",
  pahkina: "hasselpahkina -> tree nuts",
  notter: "hasselpahkina -> tree nuts",
  milk: "whey / laktoosi -> milk",
  lactose: "whey / laktoosi -> milk",
  dairy: "whey / laktoosi -> milk",
  maito: "whey / laktoosi -> milk",
  mjolk: "whey / laktoosi -> milk",
  gluten: "vehna / vete -> gluten",
  wheat: "vehna / vete -> gluten",
  gluteeni: "vehna / vete -> gluten",
  egg: "albumin / kananmuna -> egg",
  eggs: "albumin / kananmuna -> egg",
  soy: "soijalesitiini -> soy",
  soya: "soijalesitiini -> soy",
  sesame: "tahini / seesami -> sesame",
  sulphite: "E220 / rikkidioksidi -> sulphite",
  sulfite: "E220 / rikkidioksidi -> sulphite",
  sulphites: "E220 / rikkidioksidi -> sulphite",
  sulfites: "E220 / rikkidioksidi -> sulphite"
};

const COPY_BY_LOCALE: Record<UiLocale, CardCopy> = {
  en: {
    eyebrow: "Zero-Hallucination Safety Architecture",
    heading: "6 Deterministic Personal Safety Guardrails",
    subtitle:
      "Gemini never makes the clinical safety decision. After schema-locked extraction, server/src/safety.ts enforces 6 deterministic checks against your on-device profile.",
    onDevicePill: "Profile Stored Only On Device",
    armedBadge: (armed, total) => `${armed}/${total} Active Layers`,
    listAriaLabel: "Active deterministic safety guardrails",
    mdrHeading: "EU MDR Art. 2(1) Assistive Reader & Pharmacist Handoff Boundary",
    mdrBody:
      "HoldUp operates strictly as a non-medical assistive label reader under EU MDR Art. 2(1). Uncertain strengths (< 80% confidence), strength mismatches, unlisted prescriptions, and expired packs always trigger a pharmacist handoff.",
    titles: {
      strength_gate: "80% Never-Guess Dose Gate",
      rx_match: "Prescription Ingredient & Strength Match",
      drug_avoid: "Drug-Class & Avoid Rules",
      allergens: "Allergen & Excipient Synonym Catch",
      expiry_guard: "Expiry Month & Date Guard",
      double_dose: "Same-Day Double-Dose Prevention"
    },
    strengthBadge: "HARD GATE >= 80%",
    strengthDetail:
      "Enforces STRENGTH_MIN_CONF = 0.80 on printed medication strengths. Blocks uncertain, blurry, or occluded strengths instead of guessing a dose.",
    rxBadge: (count) => `${count} SAVED ${count === 1 ? "MED" : "MEDS"}`,
    rxDetailPopulated: (count, preview) =>
      `${count} saved ${count === 1 ? "med" : "meds"} (${preview}). Cross-checks EN/FI/SV brand-to-INN synonyms (Panadol -> paracetamol) and comma-decimal 2,5 mg -> 2.5 mg normalization.`,
    rxDetailEmpty:
      "0 saved meds on this device. Add prescriptions to activate EN/FI/SV brand-to-INN matching (Panadol -> paracetamol) and comma-decimal 2,5 mg -> 2.5 mg normalization.",
    avoidBadge: (count) => `${count} ACTIVE ${count === 1 ? "RULE" : "RULES"}`,
    avoidDetailPopulated: (count, preview) =>
      `${count} active ${count === 1 ? "rule" : "rules"} (${preview}). Expands 10 pharmacological classes and brand names deterministically.`,
    avoidDetailEmpty:
      "0 active rules configured. Supports 10 drug classes and brand expansions (e.g. NSAIDs -> ibuprofen / Burana).",
    allergensBadge: (count) => `${count} ACTIVE ${count === 1 ? "ALLERGY" : "ALLERGIES"}`,
    allergensDetailPopulated: (count, preview, examples) =>
      `${count} active ${count === 1 ? "allergy" : "allergies"} (${preview}). Catches EU-14, Nordic, and scientific excipient synonyms (${examples}).`,
    allergensDetailEmpty:
      "0 active allergies configured. Ready to catch EU-14, Nordic, and scientific excipient synonyms (e.g. arachis -> peanut, hasselpahkina -> tree nuts).",
    expiryBadge: "ALWAYS ON",
    expiryDetail:
      "Parses YYYY-MM end-of-month and YYYY-MM-DD package dates (confidence >= 70%) to flag expired cartons and blister packs before use.",
    doubleDoseBadge: (count) => `${count} LOGGED ${count === 1 ? "EVENT" : "EVENTS"}`,
    doubleDoseDetail: (loggedCount, scheduledSlots) =>
      `${loggedCount} logged ${loggedCount === 1 ? "event" : "events"} checked against ${scheduledSlots} daily scheduled ${scheduledSlots === 1 ? "slot" : "slots"} to warn before repeating a same-day dose.`,
    moreSuffix: (extra) => `+${extra} more`
  },
  fi: {
    eyebrow: "Hallusinaatiovapaa turva-arkkitehtuuri",
    heading: "6 determinististä henkilökohtaista turvasääntöä",
    subtitle:
      "Gemini ei koskaan tee turvallisuuspäätöstä. Kaavalukitun tekstinluvun jälkeen server/src/safety.ts suorittaa 6 determinististä tarkistusta laitteellasi olevaa profiilia vasten.",
    onDevicePill: "Profiili vain tällä laitteella",
    armedBadge: (armed, total) => `${armed}/${total} tasoa käytössä`,
    listAriaLabel: "Aktiiviset deterministiset turvasäännöt",
    mdrHeading: "EU MDR Art. 2(1) avustava lukija ja apteekkivarmistus",
    mdrBody:
      "HoldUp toimii EU MDR Art. 2(1) -rajauksen mukaisena ei-lääkinnällisenä avustavana etiketinlukijana. Epävarmat vahvuudet (< 80 % varmuus), poikkeavat annokset ja vanhentuneet pakkaukset ohjataan aina apteekkiin varmistettavaksi.",
    titles: {
      strength_gate: "80 % ei-arvausta-annosraja",
      rx_match: "Reseptin vaikuttavan aineen ja vahvuuden täsmäys",
      drug_avoid: "Lääkeluokat ja vältettävät aineet",
      allergens: "Allergeenien ja apuaineiden synonyymisuodatin",
      expiry_guard: "Viimeisen käyttökuukauden ja päiväyksen tarkistin",
      double_dose: "Saman päivän kaksoisannoksen esto"
    },
    strengthBadge: "PAKOLLINEN >= 80 %",
    strengthDetail:
      "Pakottaa rajan STRENGTH_MIN_CONF = 0.80 lääkkeen vahvuudelle. Estää epävarmat tai peittyneet vahvuudet eikä koskaan arvaa annosta.",
    rxBadge: (count) => `${count} ${count === 1 ? "TALLENNETTU LÄÄKE" : "TALLENNETTUA LÄÄKETTÄ"}`,
    rxDetailPopulated: (count, preview) =>
      `${count} ${count === 1 ? "tallennettu lääke" : "tallennettua lääkettä"} (${preview}). Tarkistaa EN/FI/SV kauppanimi-INN-vastaavuudet (Panadol -> paracetamol) ja pilkkudesimaalit 2,5 mg -> 2.5 mg.`,
    rxDetailEmpty:
      "0 tallennettua lääkettä laitteella. Lisää reseptilääkkeet aktivoidaksesi EN/FI/SV kauppanimi-INN-täsmäyksen ja 2,5 mg -> 2.5 mg muunnoksen.",
    avoidBadge: (count) => `${count} ${count === 1 ? "ESTOSÄÄNTÖ" : "ESTOSÄÄNTÖÄ"}`,
    avoidDetailPopulated: (count, preview) =>
      `${count} ${count === 1 ? "aktiivinen sääntö" : "aktiivista sääntöä"} (${preview}). Laajentaa 10 lääkeluokkaa ja kauppanimet deterministisesti.`,
    avoidDetailEmpty:
      "0 aktiivista estosääntöä. Tukee 10 lääkeluokkaa ja kauppanimiä (esim. NSAIDs -> ibuprofen / Burana).",
    allergensBadge: (count) => `${count} ${count === 1 ? "ALLERGIA" : "ALLERGIAA"}`,
    allergensDetailPopulated: (count, preview, examples) =>
      `${count} ${count === 1 ? "aktiivinen allergia" : "aktiivista allergiaa"} (${preview}). Tunnistaa EU-14-, pohjoismaiset ja tieteelliset apuainesynonyymit (${examples}).`,
    allergensDetailEmpty:
      "0 aktiivista allergiaa. Valmiina tunnistamaan EU-14-, pohjoismaiset ja tieteelliset synonyymit (esim. arachis -> peanut, hasselpahkina -> tree nuts).",
    expiryBadge: "AINA PÄÄLLÄ",
    expiryDetail:
      "Tulkitaan YYYY-MM- ja YYYY-MM-DD-päiväykset (>= 70 % varmuus) ja varoitetaan vanhentuneista koteloista ja läpipainopakkauksista.",
    doubleDoseBadge: (count) => `${count} ${count === 1 ? "KIRJAUS" : "KIRJAUSTA"}`,
    doubleDoseDetail: (loggedCount, scheduledSlots) =>
      `${loggedCount} ${loggedCount === 1 ? "kirjattu tapahtuma" : "kirjattua tapahtumaa"} tarkistetaan ${scheduledSlots} päivittäistä aikataulupaikkaa vasten kaksoisannoksen estämiseksi.`,
    moreSuffix: (extra) => `+${extra} muuta`
  },
  sv: {
    eyebrow: "Hallucinationsfri säkerhetsarkitektur",
    heading: "6 deterministiska personliga säkerhetsspärrar",
    subtitle:
      "Gemini fattar aldrig det kliniska säkerhetsbeslutet. Efter schemalåst avläsning tillämpar server/src/safety.ts 6 deterministiska kontroller mot din lokala profil.",
    onDevicePill: "Profilen sparas endast lokalt",
    armedBadge: (armed, total) => `${armed}/${total} aktiva lager`,
    listAriaLabel: "Aktiva deterministiska säkerhetsspärrar",
    mdrHeading: "EU MDR Art. 2(1) assisterande läsare och apoteksgräns",
    mdrBody:
      "HoldUp fungerar strikt som ett icke-medicintekniskt läshjälpmedel enligt EU MDR Art. 2(1). Osäkra styrkor (< 80 % säkerhet), avvikande doser och utgångna förpackningar hänvisas alltid till apotekspersonal.",
    titles: {
      strength_gate: "80 % gissa-aldrig-dosgräns",
      rx_match: "Receptmatchning av substans och styrka",
      drug_avoid: "Läkemedelsklasser och undvikanderegler",
      allergens: "Synonymfilter för allergener och hjälpämnen",
      expiry_guard: "Utgångsmånads- och datumvakt",
      double_dose: "Skydd mot dubbeldos samma dag"
    },
    strengthBadge: "HÅRD GRÄNS >= 80 %",
    strengthDetail:
      "Tillämpar STRENGTH_MIN_CONF = 0.80 för tryckt läkemedelsstyrka. Blockerar osäkra eller skymda styrkor i stället för att gissa en dos.",
    rxBadge: (count) => `${count} ${count === 1 ? "SPARAT LÄKEMEDEL" : "SPARADE LÄKEMEDEL"}`,
    rxDetailPopulated: (count, preview) =>
      `${count} ${count === 1 ? "sparat läkemedel" : "sparade läkemedel"} (${preview}). Kontrollerar EN/FI/SV handelsnamn-till-INN (Panadol -> paracetamol) och kommadecimaler 2,5 mg -> 2.5 mg.`,
    rxDetailEmpty:
      "0 sparade läkemedel på enheten. Lägg till recept för att aktivera EN/FI/SV handelsnamn-till-INN och 2,5 mg -> 2.5 mg-normalisering.",
    avoidBadge: (count) => `${count} ${count === 1 ? "AKTIV REGEL" : "AKTIVA REGLER"}`,
    avoidDetailPopulated: (count, preview) =>
      `${count} ${count === 1 ? "aktiv regel" : "aktiva regler"} (${preview}). Expanderar 10 läkemedelsklasser och handelsnamn deterministiskt.`,
    avoidDetailEmpty:
      "0 aktiva regler konfigurerade. Stöder 10 läkemedelsklasser och handelsnamn (t.ex. NSAIDs -> ibuprofen / Burana).",
    allergensBadge: (count) => `${count} ${count === 1 ? "AKTIV ALLERGI" : "AKTIVA ALLERGIER"}`,
    allergensDetailPopulated: (count, preview, examples) =>
      `${count} ${count === 1 ? "aktiv allergi" : "aktiva allergier"} (${preview}). Fångar EU-14-, nordiska och vetenskapliga hjälpämnens synonymer (${examples}).`,
    allergensDetailEmpty:
      "0 aktiva allergier konfigurerade. Redo att fånga EU-14-, nordiska och vetenskapliga synonymer (t.ex. arachis -> peanut, hasselpahkina -> tree nuts).",
    expiryBadge: "ALLTID PÅ",
    expiryDetail:
      "Tolkar YYYY-MM- och YYYY-MM-DD-datum (>= 70 % säkerhet) och flaggar utgångna kartonger och blisterkartor före användning.",
    doubleDoseBadge: (count) => `${count} ${count === 1 ? "LOGGAD HÄNDELSE" : "LOGGADE HÄNDELSER"}`,
    doubleDoseDetail: (loggedCount, scheduledSlots) =>
      `${loggedCount} ${loggedCount === 1 ? "loggad händelse" : "loggade händelser"} kontrolleras mot ${scheduledSlots} dagliga schemaplatser för att förhindra dubbeldos samma dag.`,
    moreSuffix: (extra) => `+${extra} till`
  }
};

function normKey(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/(?:-|\s)*allerg(?:y|ic|ies|ia|i)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatMedLabel(med: Med): string {
  const base = (med.name || med.ingredient || "").trim();
  const strength = (med.strength || "").trim();
  if (!base) return strength || "Medication";
  return strength ? `${base} ${strength}` : base;
}

function formatPreviewList(items: string[], maxItems: number, copy: CardCopy): string {
  const cleaned = items.map((x) => x.trim()).filter((x) => x.length > 0);
  if (cleaned.length <= maxItems) {
    return cleaned.join(", ");
  }
  const head = cleaned.slice(0, maxItems).join(", ");
  return `${head}, ${copy.moreSuffix(cleaned.length - maxItems)}`;
}

function buildAvoidPreview(avoid: string[], copy: CardCopy): string {
  const mapped = avoid
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => AVOID_CLASS_EXAMPLES[normKey(entry)] ?? entry);
  return formatPreviewList(mapped, 3, copy);
}

function buildAllergenSynonymExamples(allergies: string[]): string {
  const examples: string[] = [];
  for (const raw of allergies) {
    const key = normKey(raw);
    const ex = ALLERGEN_SYNONYM_EXAMPLES[key];
    if (ex && !examples.includes(ex)) {
      examples.push(ex);
    }
  }
  if (examples.length === 0) {
    return "arachis -> peanut, hasselpahkina -> tree nuts";
  }
  return examples.slice(0, 2).join(", ");
}

function countScheduledDailySlots(meds: Med[]): number {
  let slots = 0;
  for (const med of meds) {
    const sched = Array.isArray(med.schedule) ? med.schedule : [];
    for (const slot of sched) {
      const trimmed = typeof slot === "string" ? slot.trim() : "";
      if (trimmed.length > 0 && !/^(as needed|when needed|if needed|prn|tarvittaessa)$/i.test(trimmed)) {
        slots += 1;
      }
    }
  }
  return slots;
}

export function summarizeProfileGuardrails(
  profile: Profile,
  lang?: string
): ActiveGuardrailSummary[] {
  const resolvedLang = lang !== undefined ? lang : (profile?.lang ?? "en");
  const locale = normalizeLang(resolvedLang);
  const copy = COPY_BY_LOCALE[locale];

  const meds = Array.isArray(profile?.meds) ? profile.meds : [];
  const avoid = Array.isArray(profile?.avoid)
    ? profile.avoid.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    : [];
  const allergies = Array.isArray(profile?.allergies)
    ? profile.allergies.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    : [];
  const doseLog = Array.isArray(profile?.doseLog) ? profile.doseLog : [];

  const medLabels = meds.map(formatMedLabel);
  const medPreview = formatPreviewList(medLabels, 3, copy);
  const avoidPreview = buildAvoidPreview(avoid, copy);
  const allergyPreview = formatPreviewList(allergies, 3, copy);
  const allergyExamples = buildAllergenSynonymExamples(allergies);
  const scheduledSlots = countScheduledDailySlots(meds);

  return [
    {
      id: "strength_gate",
      title: copy.titles.strength_gate,
      badge: copy.strengthBadge,
      detail: copy.strengthDetail,
      activeCount: 1
    },
    {
      id: "rx_match",
      title: copy.titles.rx_match,
      badge: copy.rxBadge(meds.length),
      detail:
        meds.length > 0
          ? copy.rxDetailPopulated(meds.length, medPreview)
          : copy.rxDetailEmpty,
      activeCount: meds.length
    },
    {
      id: "drug_avoid",
      title: copy.titles.drug_avoid,
      badge: copy.avoidBadge(avoid.length),
      detail:
        avoid.length > 0
          ? copy.avoidDetailPopulated(avoid.length, avoidPreview)
          : copy.avoidDetailEmpty,
      activeCount: avoid.length
    },
    {
      id: "allergens",
      title: copy.titles.allergens,
      badge: copy.allergensBadge(allergies.length),
      detail:
        allergies.length > 0
          ? copy.allergensDetailPopulated(allergies.length, allergyPreview, allergyExamples)
          : copy.allergensDetailEmpty,
      activeCount: allergies.length
    },
    {
      id: "expiry_guard",
      title: copy.titles.expiry_guard,
      badge: copy.expiryBadge,
      detail: copy.expiryDetail,
      activeCount: 1
    },
    {
      id: "double_dose",
      title: copy.titles.double_dose,
      badge: copy.doubleDoseBadge(doseLog.length),
      detail: copy.doubleDoseDetail(doseLog.length, scheduledSlots),
      activeCount: doseLog.length
    }
  ];
}

function GuardrailIcon({ id }: { id: string }) {
  const iconStyle: CSSProperties = { width: "16px", height: "16px", flexShrink: 0 };

  if (id === "strength_gate") {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        style={iconStyle}
      >
        <path d="M12 2L4 5.5v6.1c0 5.1 3.4 9.8 8 10.9 4.6-1.1 8-5.8 8-10.9V5.5L12 2z" />
        <path d="M8.5 12.3l2.4 2.4 4.8-5" />
      </svg>
    );
  }

  if (id === "rx_match") {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        style={iconStyle}
      >
        <rect x="4" y="4" width="16" height="16" rx="3" />
        <path d="M9 12h6" />
        <path d="M12 9v6" />
      </svg>
    );
  }

  if (id === "drug_avoid") {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        style={iconStyle}
      >
        <circle cx="12" cy="12" r="9" />
        <line x1="6.3" y1="6.3" x2="17.7" y2="17.7" />
      </svg>
    );
  }

  if (id === "allergens") {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        style={iconStyle}
      >
        <path d="M12 3L22 20H2L12 3z" />
        <line x1="12" y1="9" x2="12" y2="14" />
        <circle cx="12" cy="17" r="0.8" fill="currentColor" stroke="none" />
      </svg>
    );
  }

  if (id === "expiry_guard") {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        style={iconStyle}
      >
        <rect x="3" y="5" width="18" height="16" rx="2" />
        <line x1="8" y1="3" x2="8" y2="7" />
        <line x1="16" y1="3" x2="16" y2="7" />
        <line x1="3" y1="10" x2="21" y2="10" />
      </svg>
    );
  }

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={iconStyle}
    >
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 15.5 14" />
    </svg>
  );
}

export function SafetyRuleExplainerCard(props: SafetyRuleExplainerCardProps) {
  const { profile, lang } = props;
  const locale = normalizeLang(lang);
  const copy = COPY_BY_LOCALE[locale];
  const disclaimerText = t(locale, "notMedicalDevice");
  const guardrails = summarizeProfileGuardrails(profile, locale);
  const armedLayers = guardrails.filter((item) => item.activeCount > 0).length;

  return (
    <section
      aria-labelledby="safety-rule-explainer-heading"
      lang={locale}
      className="card safety-rule-explainer-card"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-4, 16px)",
        padding: "var(--space-5, 20px)",
        borderRadius: "var(--radius-lg, 18px)",
        backgroundColor: "var(--bg-surface, #121926)",
        color: "var(--text-primary, #f8fafc)",
        border: "var(--border-width, 1.5px) solid var(--border-subtle, #2c3a52)",
        boxShadow: "var(--shadow-sm, 0 2px 8px rgba(0, 0, 0, 0.32))"
      }}
    >
      <header
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: "var(--space-3, 12px)"
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "6px",
            flex: "1 1 320px"
          }}
        >
          <p
            style={{
              margin: 0,
              fontSize: "var(--text-xs, 0.875rem)",
              fontWeight: 700,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              color: "var(--accent, #5cc0ff)"
            }}
          >
            {copy.eyebrow}
          </p>

          <h2
            id="safety-rule-explainer-heading"
            style={{
              margin: 0,
              fontSize: "var(--text-lg, 1.25rem)",
              lineHeight: 1.28,
              fontWeight: 800,
              color: "var(--text-primary, #f8fafc)"
            }}
          >
            {copy.heading}
          </h2>

          <p
            style={{
              margin: 0,
              fontSize: "var(--text-sm, 1rem)",
              lineHeight: 1.45,
              color: "var(--text-secondary, #d8e1ee)"
            }}
          >
            {copy.subtitle}
          </p>
        </div>

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "8px"
          }}
        >
          <span
            role="status"
            className="badge safety-armed-summary-badge"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              padding: "6px 12px",
              borderRadius: "var(--radius-pill, 9999px)",
              backgroundColor: "var(--verdict-match-bg, #06261d)",
              color: "var(--verdict-match-fg, #7ef7c8)",
              border: "var(--border-width, 1.5px) solid var(--verdict-match-border, #2dd4a0)",
              fontSize: "var(--text-xs, 0.875rem)",
              fontWeight: 800,
              fontVariantNumeric: "tabular-nums"
            }}
          >
            {copy.armedBadge(armedLayers, guardrails.length)}
          </span>

          <span
            className="pill safety-on-device-pill"
            style={{
              padding: "6px 12px",
              borderRadius: "var(--radius-pill, 9999px)",
              backgroundColor: "var(--bg-elevated, #1a2333)",
              color: "var(--text-primary, #f8fafc)",
              border: "var(--border-width, 1.5px) solid var(--border-strong, #6980a3)",
              fontSize: "var(--text-xs, 0.875rem)",
              fontWeight: 700
            }}
          >
            {copy.onDevicePill}
          </span>
        </div>
      </header>

      <ul
        aria-label={copy.listAriaLabel}
        className="safety-guardrail-grid"
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))",
          gap: "var(--space-3, 12px)"
        }}
      >
        {guardrails.map((item, idx) => {
          const isArmed = item.activeCount > 0;
          const stepNumber = String(idx + 1).padStart(2, "0");

          return (
            <li
              key={item.id}
              data-guardrail-id={item.id}
              data-active-count={String(item.activeCount)}
              className={`safety-guardrail-item safety-guardrail-${item.id}`}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "8px",
                padding: "var(--space-4, 16px)",
                borderRadius: "var(--radius-md, 12px)",
                backgroundColor: "var(--bg-elevated, #1a2333)",
                border: isArmed
                  ? "1.5px solid var(--verdict-match-border, #2dd4a0)"
                  : "1.5px dashed var(--border-strong, #6980a3)"
              }}
            >
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "8px"
                }}
              >
                <span
                  className="badge safety-guardrail-badge"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                    padding: "4px 10px",
                    borderRadius: "var(--radius-sm, 8px)",
                    fontSize: "0.78rem",
                    fontWeight: 800,
                    letterSpacing: "0.03em",
                    fontVariantNumeric: "tabular-nums",
                    ...(isArmed
                      ? {
                          backgroundColor: "var(--verdict-match-bg, #06261d)",
                          color: "var(--verdict-match-fg, #7ef7c8)",
                          border: "1.5px solid var(--verdict-match-border, #2dd4a0)"
                        }
                      : {
                          backgroundColor: "var(--bg-surface, #121926)",
                          color: "var(--text-primary, #f8fafc)",
                          border: "1.5px solid var(--border-strong, #6980a3)"
                        })
                  }}
                >
                  <GuardrailIcon id={item.id} />
                  <span>{item.badge}</span>
                </span>

                <span
                  aria-hidden="true"
                  style={{
                    fontFamily: "var(--font-mono, monospace)",
                    fontSize: "var(--text-xs, 0.875rem)",
                    fontWeight: 800,
                    color: "var(--text-muted, #b5c2d6)"
                  }}
                >
                  {stepNumber}
                </span>
              </div>

              <h3
                style={{
                  margin: 0,
                  fontSize: "var(--text-base, 1.125rem)",
                  fontWeight: 800,
                  lineHeight: 1.3,
                  color: "var(--text-primary, #f8fafc)"
                }}
              >
                {item.title}
              </h3>

              <p
                style={{
                  margin: 0,
                  fontSize: "var(--text-xs, 0.875rem)",
                  lineHeight: 1.45,
                  color: "var(--text-secondary, #d8e1ee)"
                }}
              >
                {item.detail}
              </p>
            </li>
          );
        })}
      </ul>

      <div
        role="note"
        className="safety-mdr-boundary-note"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "4px",
          padding: "var(--space-4, 16px)",
          borderRadius: "var(--radius-md, 12px)",
          backgroundColor: "var(--verdict-info-bg, #0a1f38)",
          color: "var(--verdict-info-fg, #a6d4ff)",
          border: "var(--border-width, 1.5px) solid var(--verdict-info-border, #4da3ff)"
        }}
      >
        <strong
          style={{
            fontSize: "var(--text-sm, 1rem)",
            fontWeight: 800,
            lineHeight: 1.35
          }}
        >
          {copy.mdrHeading}
        </strong>
        <p
          style={{
            margin: 0,
            fontSize: "var(--text-xs, 0.875rem)",
            lineHeight: 1.45,
            color: "var(--text-primary, #f8fafc)"
          }}
        >
          {copy.mdrBody} {disclaimerText}
        </p>
      </div>
    </section>
  );
}

export default SafetyRuleExplainerCard;
