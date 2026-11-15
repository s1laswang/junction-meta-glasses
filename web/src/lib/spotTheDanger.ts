import type { LabelRead, Profile, Verdict, VerdictLevel } from "../../../shared/types.ts";
import { checkLabel } from "../../../server/src/safety.ts";

export type JudgeChoice = "match" | "warning" | "unsure";

export interface SpotCard {
  id: string;
  round: number;
  imageUrl: string;
  evalSourceId: string;
  degradation: string;
  title: Record<"en" | "fi" | "sv", string>;
  scenarioPrompt: Record<"en" | "fi" | "sv", string>;
  read: LabelRead;
  expectedLevel: VerdictLevel;
  phraseClipId: string;
  dangerSummary: Record<"en" | "fi" | "sv", string>;
}

export function spotDemoProfile(): Profile {
  return {
    lang: "en",
    meds: [
      {
        id: "amlodipine",
        name: "Amlodipine",
        ingredient: "amlodipine",
        strength: "5 mg",
        schedule: ["evening"],
        barcode: "6416542002149",
        gtin: "06416542002149",
        notes: "Blood pressure",
      },
      {
        id: "metformin",
        name: "Metformin",
        ingredient: "metformin",
        strength: "500 mg",
        schedule: ["morning", "evening"],
        barcode: "6416542003375",
        gtin: "06416542003375",
        notes: "Diabetes, with food",
      },
      {
        id: "atorvastatin",
        name: "Atorvastatin",
        ingredient: "atorvastatin",
        strength: "20 mg",
        schedule: ["evening"],
        barcode: "6416542004860",
        gtin: "06416542004860",
        notes: "Cholesterol",
      },
    ],
    allergies: ["tree nuts", "peanut"],
    avoid: ["NSAIDs"],
    doseLog: [],
  };
}

export const SPOT_CARDS: readonly SpotCard[] = [
  {
    id: "round1",
    round: 1,
    imageUrl: "/blindfold/labels/round1.jpg",
    evalSourceId: "v1:med000__clean_0",
    degradation: "clean",
    title: {
      en: "Round 1: Evening kitchen carton check",
      fi: "Kierros 1: Iltalaakkeen tarkistus keittiossa",
      sv: "Runda 1: Kontroll av kvallsmedicin i koket",
    },
    scenarioPrompt: {
      en: "It is 19:00. Your profile lists Amlodipine 5 mg (evening, 0 doses logged today), Metformin 500 mg, and Atorvastatin 20 mg; allergies: tree nuts, peanut; avoid: NSAIDs. Is this carton safe to take?",
      fi: "Kello on 19:00. Profiilissasi on Amlodipine 5 mg (ilta, 0 otettua annosta tanaan), Metformin 500 mg ja Atorvastatin 20 mg; allergiat: puupahkinat, maapahkina; valtettavat: tulehduskipulaakkeet (NSAID). Onko pakkaus turvallinen?",
      sv: "Klockan ar 19:00. Din profil har Amlodipine 5 mg (kvall, 0 tagna doser idag), Metformin 500 mg och Atorvastatin 20 mg; allergier: tradnotter, jordnot; undvik: NSAID. Ar forpackningen saker att ta?",
    },
    read: {
      kind: "medication",
      product: { value: "Amlodipine Orion", confidence: 0.98 },
      ingredient: { value: "amlodipine", confidence: 0.98 },
      strength: { value: "5 mg", confidence: 0.98 },
      dosing: { value: "1 tablet once daily in the evening", confidence: 0.95 },
      expiry: { value: "2027-08", confidence: 0.98 },
      allergens: { value: null, confidence: 0 },
      barcode: { value: null, confidence: 0 },
      readability: 0.95,
    },
    expectedLevel: "match",
    phraseClipId: "verdict_speech",
    dangerSummary: {
      en: "Safe match: identity (98%) and strength 5 mg (98% >= 80%) match your prescribed evening Amlodipine, expiry 2027-08 is valid, and 0 doses are logged today.",
      fi: "Turvallinen osuma: vaikuttava aine (98%) ja vahvuus 5 mg (98% >= 80%) vastaavat iltalaakettasi Amlodipine 5 mg, kestoaika 2027-08 on voimassa eika annosta ole otettu tanaan.",
      sv: "Saker traff: substans (98%) och styrka 5 mg (98% >= 80%) matchar din kvallsdos Amlodipine 5 mg, utgangsdatum 2027-08 galler och 0 doser ar loggade idag.",
    },
  },
  {
    id: "round2",
    round: 2,
    imageUrl: "/blindfold/labels/round2.jpg",
    evalSourceId: "v1:med008__clean_0",
    degradation: "low_light",
    title: {
      en: "Round 2: Dim bathroom painkiller box",
      fi: "Kierros 2: Hamaran kylpyhuoneen kipulaake",
      sv: "Runda 2: Varktablett i svagt badrumsljus",
    },
    scenarioPrompt: {
      en: "You reach for a headache tablet in dim bathroom light. Your profile avoids NSAIDs alongside blood pressure therapy. What should HoldUp say?",
      fi: "Otat paansarkytabletin hamarassa kylpyhuoneessa. Profiilissasi valtetaan tulehduskipulaakkeita (NSAID) verenpainelaakityksen rinnalla. Mita HoldUp vastaa?",
      sv: "Du tar fram en huvudvarkstablett i svagt badrumsljus. Din profil undviker NSAID vid blodtrycksbehandling. Vad sager HoldUp?",
    },
    read: {
      kind: "medication",
      product: { value: "Burana", confidence: 0.98 },
      ingredient: { value: "ibuprofen", confidence: 0.97 },
      strength: { value: "400 mg", confidence: 0.98 },
      dosing: { value: "1 tablet as needed for acute pain", confidence: 0.92 },
      expiry: { value: "2027-10", confidence: 0.95 },
      allergens: { value: null, confidence: 0 },
      barcode: { value: null, confidence: 0 },
      readability: 0.85,
    },
    expectedLevel: "warning",
    phraseClipId: "verdict_speech",
    dangerSummary: {
      en: "NSAID class danger: Burana maps to ibuprofen, which is absent from your medication list and flagged under your avoid NSAIDs rule.",
      fi: "NSAID-vaara: Burana tunnistetaan ibuprofeeniksi, joka ei kuulu laakelistallesi ja osuu valtettavien tulehduskipulaakkeiden saantoon.",
      sv: "NSAID-fara: Burana mappas till ibuprofen, som saknas pa din medicinlista och blockeras av din regel att undvika NSAID.",
    },
  },
  {
    id: "round3",
    round: 3,
    imageUrl: "/blindfold/labels/round3.jpg",
    evalSourceId: "polypharmacy_lasa:lasa_06",
    degradation: "lookalike_2x_strength",
    title: {
      en: "Round 3: Same-brand Orion carton on the counter",
      fi: "Kierros 3: Samannakoinen Orion-pakkaus poydalla",
      sv: "Runda 3: Forvaxlingslik Orion-forpackning pa banken",
    },
    scenarioPrompt: {
      en: "A family member shares the kitchen counter. This blue-header Orion box says Amlodipin Orion. Your prescription is Amlodipine 5 mg once in the evening. Safe or danger?",
      fi: "Perheenjasenen pakkaus on keittion poydalla. Sinisessa Orion-rasiassa lukee Amlodipin Orion, ja oma reseptisi on Amlodipine 5 mg iltaisin. Turvallinen vai vaara?",
      sv: "En familjemedlems ask ligger pa koksbanken. Den bla Orion-asken ar markt Amlodipin Orion, och ditt recept ar Amlodipine 5 mg pa kvallen. Saker eller fara?",
    },
    read: {
      kind: "medication",
      product: { value: "AMLODIPIN ORION", confidence: 0.99 },
      ingredient: { value: "amlodipine", confidence: 0.99 },
      strength: { value: "10 mg", confidence: 0.99 },
      dosing: { value: null, confidence: 0 },
      expiry: { value: "2027-10", confidence: 0.95 },
      allergens: { value: null, confidence: 0 },
      barcode: { value: null, confidence: 0 },
      readability: 0.95,
    },
    expectedLevel: "warning",
    phraseClipId: "verdict_speech",
    dangerSummary: {
      en: "Look-alike 2x strength danger: same Orion house dress and active ingredient amlodipine, but 10 mg is double your prescribed 5 mg evening dose.",
      fi: "Kaksoisvahvuuden LASA-vaara: sama Orion-ulkoasu ja vaikuttava aine amlodipiini, mutta 10 mg on kaksinkertainen maarattyyn 5 mg ilta-annokseesi verrattuna.",
      sv: "Forvaxlingsfara med dubbel styrka: samma Orion-design och substans amlodipin, men 10 mg ar dubbelt sa starkt som din ordinerade kvallsdos pa 5 mg.",
    },
  },
  {
    id: "round4",
    round: 4,
    imageUrl: "/blindfold/labels/round4.jpg",
    evalSourceId: "nordic_food_allergen_synonyms:nf_02",
    degradation: "nordic_synonym_clutter",
    title: {
      en: "Round 4: Nordic bilingual dinner sauce pouch",
      fi: "Kierros 4: Pohjoismainen kaksikielinen kastikepussi",
      sv: "Runda 4: Nordisk tvasprakig woksaspase",
    },
    scenarioPrompt: {
      en: "Before cooking dinner, you check the dense Finnish and Swedish ingredient panel on a ginger wok sauce pouch. Your profile lists tree nuts and peanut allergies.",
      fi: "Ennen paivallisen laittoa tarkistat tihean suomi-ruotsi-ainesosaluettelon inkivaari-wokkikastikkeesta. Profiilissasi on puupahkina- ja maapahkina-allergia.",
      sv: "Fore middagen kontrollerar du den tata finsk-svenska ingredienslistan pa en ingefars-woksas. Din profil har allergi mot tradnotter och jordnot.",
    },
    read: {
      kind: "food",
      product: { value: "Inkivaari-wokkikastike / Woksas", confidence: 0.96 },
      ingredient: { value: "Nordic ginger wok sauce", confidence: 0.93 },
      strength: { value: null, confidence: 0 },
      dosing: { value: null, confidence: 0 },
      expiry: { value: "2027-11-10", confidence: 0.96 },
      allergens: { value: ["arachis oil", "hazelnut"], confidence: 0.97 },
      barcode: { value: null, confidence: 0 },
      readability: 0.91,
    },
    expectedLevel: "warning",
    phraseClipId: "verdict_speech",
    dangerSummary: {
      en: "Nordic allergen danger: arachis oil (maapahkinaoljy / jordnotsolja) and hasselpahkina / hasselnot map to peanut and tree nuts at 97% confidence (readability 91%, clearing the >= 95% allergen gate).",
      fi: "Pohjoismainen allergeenivaara: arachis oil (maapahkinaoljy / jordnotsolja) ja hasselpahkina / hasselnot tunnistetaan maapahkinaksi ja puupahkinaksi 97% luottamuksella (luettavuus 91%).",
      sv: "Nordisk allergenfara: arachis oil (maapahkinaoljy / jordnotsolja) och hasselpahkina / hasselnot mappas till jordnot och tradnotter med 97% konfidens (lasbarhet 91%).",
    },
  },
  {
    id: "round5",
    round: 5,
    imageUrl: "/blindfold/labels/round5.jpg",
    evalSourceId: "glasses_thumb_occlusion_grip:tg_07",
    degradation: "thumb_occlusion",
    title: {
      en: "Round 5: Thumb covering the strength box",
      fi: "Kierros 5: Peukalo peittaa vahvuusmerkinnan",
      sv: "Runda 5: Tummen tacker styrkerutan",
    },
    scenarioPrompt: {
      en: "Holding up Amlodipin Orion at arm's length, your right thumbpad sits directly over the mg badge (strength confidence 24%). Should HoldUp confirm, warn, or abstain?",
      fi: "Pidat Amlodipin Orion -pakkausta kaden mitan paassa ja oikea peukalosi peittaa mg-ruudun (vahvuuden luottamus 24%). Pitaako HoldUpin vahvistaa, varoittaa vai pidattaytya?",
      sv: "Nar du haller upp Amlodipin Orion vilar hoger tumme rakt over mg-rutan (styrkekonfidens 24%). Ska HoldUp bekrafta, varna eller avsta?",
    },
    read: {
      kind: "medication",
      product: { value: "Amlodipin Orion", confidence: 0.96 },
      ingredient: { value: "amlodipine", confidence: 0.95 },
      strength: { value: "5 mg", confidence: 0.24 },
      dosing: { value: "1 tablet once daily in the evening", confidence: 0.91 },
      expiry: { value: "2027-11", confidence: 0.94 },
      allergens: { value: null, confidence: 0 },
      barcode: { value: null, confidence: 0 },
      readability: 0.78,
      guidance: "Move your thumb off the strength box, or ask a pharmacist.",
    },
    expectedLevel: "unsure",
    phraseClipId: "not_sure",
    dangerSummary: {
      en: "Zero-guess abstention: strength confidence is 24% (< 80% gate) because the thumb hides whether this box is 5 mg or 10 mg, so HoldUp refuses to guess and plays not_sure.mp3.",
      fi: "Nolla-arvaus-pidattaytyminen: vahvuuden luottamus on 24% (< 80% raja), koska peukalo peittaa onko pakkaus 5 mg vai 10 mg, joten HoldUp ei arvaa vaan toistaa not_sure.mp3-klipin.",
      sv: "Noll-gissnings-avstaende: styrkekonfidensen ar 24% (< 80% grans) eftersom tummen doljer om asken ar 5 mg eller 10 mg, sa HoldUp vagrar gissa och spelar not_sure.mp3.",
    },
  },
];

export function evaluateSpotCard(
  card: SpotCard,
  judgeChoice: JudgeChoice,
  lang?: "en" | "fi" | "sv",
): { correct: boolean; holdupVerdict: Verdict; expectedLevel: VerdictLevel; phraseUrl: string } {
  const safeLang: "en" | "fi" | "sv" = lang === "fi" || lang === "sv" ? lang : "en";
  const profile: Profile = { ...spotDemoProfile(), lang: safeLang };
  const holdupVerdict = checkLabel(card.read, profile, new Date(2026, 10, 15, 19, 0, 0));
  const expectedChoice: JudgeChoice = holdupVerdict.level === "info" ? "match" : holdupVerdict.level;
  const correct = judgeChoice === expectedChoice;
  const phraseUrl =
    card.phraseClipId === "not_sure"
      ? `/phrases/${safeLang}/not_sure.mp3`
      : `/phrases/${safeLang}/cue_reading.wav`;
  return {
    correct,
    holdupVerdict,
    expectedLevel: card.expectedLevel,
    phraseUrl,
  };
}
