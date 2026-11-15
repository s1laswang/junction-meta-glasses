import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WebSocket } from "ws";
import type { Gs1Code, LabelRead, Med, Profile, ServerMsg } from "../../shared/types.ts";
import { env } from "../src/env.ts";
import { speechFidelity, strengthsIn, wordsToNumber, type Expected } from "../src/fidelity.ts";
import { ai } from "../src/gemini.ts";
import { Hub } from "../src/hub.ts";
import { leadFor, LiveProxy, VERDICT_LEAD } from "../src/live.ts";
import {
  allergyLabel,
  applyQuestion,
  checkLabel,
  isPerVolume,
  lastDoseWithin,
  productIngredientClash,
  unmappedAllergies,
} from "../src/safety.ts";

const originalLedgerPath = env.ledgerPath;
const originalConnect = (ai.live as any).connect;
const originalGenerate = (ai.models as any).generateContent;
const originalQuiet = process.env.HOLDUP_QUIET;
const tempDirs: string[] = [];

after(async () => {
  (ai.live as any).connect = originalConnect;
  (ai.models as any).generateContent = originalGenerate;
  env.ledgerPath = originalLedgerPath;
  if (originalQuiet === undefined) delete process.env.HOLDUP_QUIET;
  else process.env.HOLDUP_QUIET = originalQuiet;
  await new Promise((r) => setTimeout(r, 40));
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

const F = <T>(value: T | null, confidence = 0.95) => ({ value, confidence });
const N = { value: null, confidence: 0 };

function makeRead(overrides: Partial<LabelRead> = {}): LabelRead {
  return {
    kind: "medication",
    product: F("Amlodipin Orion"),
    ingredient: F("amlodipine besilate"),
    strength: F("5 mg"),
    dosing: N,
    expiry: F("2027-08"),
    allergens: F<string[]>(null, 0),
    barcode: N,
    readability: 0.92,
    ...overrides,
  };
}

const BASE_MED: Med = {
  id: "aml",
  name: "Amlodipin Orion",
  ingredient: "amlodipine besilate",
  strength: "5 mg",
  schedule: ["evening"],
  gtin: "06414100000001",
};

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    meds: [BASE_MED],
    allergies: [],
    avoid: [],
    doseLog: [],
    lang: "en",
    ...overrides,
  };
}

const NOW = new Date(2026, 10, 15, 20, 0, 0);
const wordCount = (s: string) => s.trim().split(/\s+/).length;
const sentenceCount = (s: string) => s.trim().split(/(?<=[.!?])\s+/).length;

test("fidelity: wordsToNumber and strengthsIn parse decimals, decimal commas, combo doses, and canonical units", () => {
  assert.equal(wordsToNumber(["zero", "point", "one", "eight"]), 0.18);
  assert.equal(wordsToNumber(["one", "point", "eight"]), 1.8);
  assert.equal(wordsToNumber(["two", "point", "five"]), 2.5);
  assert.equal(wordsToNumber(["twenty", "five"]), 25);
  assert.equal(wordsToNumber(["a", "hundred"]), 100);
  assert.equal(wordsToNumber(["one", "hundred", "and", "twenty", "five"]), 125);
  assert.equal(wordsToNumber([]), undefined);
  assert.equal(wordsToNumber(["point", "five"]), undefined);
  assert.equal(wordsToNumber(["two", "point"]), undefined);
  assert.equal(wordsToNumber(["zero", "point", "ten"]), undefined);

  assert.deepEqual([...strengthsIn("Pramipexole 0.18 mg")], ["0.18 mg"]);
  assert.deepEqual([...strengthsIn("Pramipexole 0,18 mg")], ["0.18 mg"]);
  assert.deepEqual([...strengthsIn("Pramipexole zero point one eight milligrams")], ["0.18 mg"]);
  assert.deepEqual([...strengthsIn("Losartan/Hydrochlorothiazide 100 mg / 25 mg")].sort(), ["100 mg", "25 mg"]);
  assert.deepEqual([...strengthsIn("Levothyroxine 100 mcg")], ["100 mcg"]);
  assert.deepEqual([...strengthsIn("Levothyroxine one hundred micrograms")], ["100 mcg"]);
  assert.deepEqual([...strengthsIn("Levothyroxine 100 ug")], ["100 mcg"]);
  assert.deepEqual([...strengthsIn("Insulin glargine 100 units and 3 ml")].sort(), ["100 iu", "3 ml"]);
  assert.deepEqual([...strengthsIn(" Cream two percent ")], ["2 %"]);
});

test("fidelity: exact and benign conversational paraphrases pass without false-positive correction", () => {
  const matchAml: Expected = {
    speech: "Yes, Amlodipine 5 mg, your evening pill. You haven't taken it today.",
    level: "match",
    names: ["amlodipine", "Amlodipin Orion"],
  };
  const matchPram: Expected = {
    speech: "Yes, Pramipexole 0.18 mg, your evening pill. You haven't taken it today.",
    level: "match",
    names: ["pramipexole"],
  };
  const matchBiso: Expected = {
    speech: "Yes, Bisoprolol 2.5 mg, your morning pill. You haven't taken it today.",
    level: "match",
    names: ["bisoprolol"],
  };
  const matchLevo: Expected = {
    speech: "Yes, Levothyroxine 100 mcg, your morning pill. You haven't taken it today.",
    level: "match",
    names: ["levothyroxine"],
  };
  const matchCombo: Expected = {
    speech: "Yes, Losartan/Hydrochlorothiazide 100 mg / 25 mg, your morning pill. You haven't taken it today.",
    level: "match",
    names: ["losartan", "hydrochlorothiazide"],
  };
  const warnNsaid: Expected = {
    speech: "This is Ibuprofen 400 mg. It isn't on your medication list and your list says to avoid NSAIDs.",
    level: "warning",
    names: ["ibuprofen"],
  };
  const unsureStrength: Expected = {
    speech: "It looks like Metformin, but I can't read the strength confidently. Turn the box so the side panel faces you, or ask a pharmacist.",
    level: "unsure",
    names: ["metformin"],
  };
  const infoFood: Expected = {
    speech: "Oat bar: no peanut listed.",
    level: "info",
    names: ["Oat bar"],
  };

  assert.deepEqual(speechFidelity(matchAml, matchAml.speech), { ok: true, reasons: [] });
  assert.equal(
    speechFidelity(matchAml, "Okay, I see it clearly. Yes, Amlodipine five milligrams, your evening pill. You have not taken it today.").ok,
    true,
  );
  assert.equal(
    speechFidelity(matchPram, "Yes, Pramipexole zero point one eight milligrams, your evening pill. You haven't taken it today.").ok,
    true,
  );
  assert.equal(
    speechFidelity(matchPram, "Yes, Pramipexole 0,18 mg, your evening pill. You haven't taken it today.").ok,
    true,
  );
  assert.equal(
    speechFidelity(matchBiso, "Hold still... Yes, Bisoprolol two point five milligrams, your morning pill. You haven't taken it today.").ok,
    true,
  );
  assert.equal(
    speechFidelity(matchLevo, "Yes, Levothyroxine one hundred micrograms, your morning pill. You haven't taken it today.").ok,
    true,
  );
  assert.equal(
    speechFidelity(matchCombo, "Yes, Losartan and Hydrochlorothiazide one hundred milligrams and twenty-five milligrams, your morning pill.").ok,
    true,
  );
  assert.equal(
    speechFidelity(warnNsaid, "Careful: this is Ibuprofen 400 milligrams. It is not on your medication list, and your profile says to avoid NSAIDs.").ok,
    true,
  );
  assert.equal(
    speechFidelity(unsureStrength, "It looks like Metformin, but the dose is unclear. Please turn the box or ask a pharmacist.").ok,
    true,
  );
  assert.equal(speechFidelity(infoFood, "Oat bar: no peanut listed.").ok, true);
});

test("fidelity: dangerous dose, decimal, combo, and unit mutations trigger strength mismatch", () => {
  const pram018: Expected = {
    speech: "Yes, Pramipexole 0.18 mg, your evening pill. You haven't taken it today.",
    level: "match",
    names: ["pramipexole"],
  };
  for (const wrong of [
    "Yes, Pramipexole 18 mg, your evening pill. You haven't taken it today.",
    "Yes, Pramipexole eighteen milligrams, your evening pill.",
    "Yes, Pramipexole 1.8 mg, your evening pill. You haven't taken it today.",
    "Yes, Pramipexole one point eight milligrams, your evening pill.",
  ]) {
    const res = speechFidelity(pram018, wrong);
    assert.equal(res.ok, false, wrong);
    assert.deepEqual(res.reasons.sort(), ["strength_invented", "strength_missing"]);
  }

  const biso25: Expected = {
    speech: "Yes, Bisoprolol 2.5 mg, your morning pill. You haven't taken it today.",
    level: "match",
    names: ["bisoprolol"],
  };
  for (const wrong of [
    "Yes, Bisoprolol 25 mg, your morning pill.",
    "Yes, Bisoprolol twenty-five milligrams, your morning pill.",
  ]) {
    const res = speechFidelity(biso25, wrong);
    assert.equal(res.ok, false, wrong);
    assert.deepEqual(res.reasons.sort(), ["strength_invented", "strength_missing"]);
  }

  const aml5: Expected = {
    speech: "Yes, Amlodipine 5 mg, your evening pill. You haven't taken it today.",
    level: "match",
    names: ["amlodipine"],
  };
  for (const wrong of [
    "Yes, Amlodipine 50 mg, your evening pill.",
    "Yes, Amlodipine fifty milligrams, your evening pill.",
  ]) {
    const res = speechFidelity(aml5, wrong);
    assert.equal(res.ok, false, wrong);
    assert.deepEqual(res.reasons.sort(), ["strength_invented", "strength_missing"]);
  }

  const combo100_25: Expected = {
    speech: "Yes, Losartan/Hydrochlorothiazide 100 mg / 25 mg, your morning pill. You haven't taken it today.",
    level: "match",
    names: ["losartan", "hydrochlorothiazide"],
  };
  const missingSecond = speechFidelity(combo100_25, "Yes, Losartan/Hydrochlorothiazide 100 mg, your morning pill.");
  assert.equal(missingSecond.ok, false);
  assert.deepEqual(missingSecond.reasons, ["strength_missing"]);

  const missingFirst = speechFidelity(combo100_25, "Yes, Losartan/Hydrochlorothiazide 25 mg, your morning pill.");
  assert.equal(missingFirst.ok, false);
  assert.deepEqual(missingFirst.reasons, ["strength_missing"]);

  const mutatedSecond = speechFidelity(combo100_25, "Yes, Losartan/Hydrochlorothiazide 100 mg / 12.5 mg, your morning pill.");
  assert.equal(mutatedSecond.ok, false);
  assert.deepEqual(mutatedSecond.reasons.sort(), ["strength_invented", "strength_missing"]);

  const levo100mcg: Expected = {
    speech: "Yes, Levothyroxine 100 mcg, your morning pill. You haven't taken it today.",
    level: "match",
    names: ["levothyroxine"],
  };
  for (const unitFlip of [
    "Yes, Levothyroxine 100 mg, your morning pill.",
    "Yes, Levothyroxine one hundred milligrams, your morning pill.",
  ]) {
    const res = speechFidelity(levo100mcg, unitFlip);
    assert.equal(res.ok, false, unitFlip);
    assert.deepEqual(res.reasons.sort(), ["strength_invented", "strength_missing"]);
  }
  for (const unitFlip of [
    "Yes, Amlodipine 5 mcg, your evening pill.",
    "Yes, Amlodipine five micrograms, your evening pill.",
    "Yes, Amlodipine 5 g, your evening pill.",
  ]) {
    const res = speechFidelity(aml5, unitFlip);
    assert.equal(res.ok, false, unitFlip);
    assert.deepEqual(res.reasons.sort(), ["strength_invented", "strength_missing"]);
  }

  const unsureNoDose: Expected = {
    speech: "It looks like Metformin, but I can't read the strength confidently. Turn the box so the side panel faces you, or ask a pharmacist.",
    level: "unsure",
    names: ["metformin"],
  };
  const guessedOnUnsure = speechFidelity(unsureNoDose, "It looks like Metformin 500 mg, but ask a pharmacist.");
  assert.equal(guessedOnUnsure.ok, false);
  assert.ok(guessedOnUnsure.reasons.includes("strength_invented"));
});

test("fidelity: polarity flips, dropped cautions, wrong drug names, and silence are caught", () => {
  const warn: Expected = {
    speech: "This is Ibuprofen 400 mg. It isn't on your medication list and your list says to avoid NSAIDs.",
    level: "warning",
    names: ["ibuprofen"],
  };
  const unsure: Expected = {
    speech: "It looks like Metformin, but I can't read the strength confidently. Turn the box so the side panel faces you, or ask a pharmacist.",
    level: "unsure",
    names: ["metformin"],
  };
  const match: Expected = {
    speech: "Yes, Amlodipine 5 mg, your evening pill. You haven't taken it today.",
    level: "match",
    names: ["amlodipine", "Amlodipin Orion"],
  };

  const warnFlipped = speechFidelity(warn, "Yes, take it, this is Ibuprofen 400 mg.");
  assert.equal(warnFlipped.ok, false);
  assert.ok(warnFlipped.reasons.includes("affirmative_on_caution"));
  assert.ok(warnFlipped.reasons.includes("caution_dropped"));

  const unsureFlipped = speechFidelity(unsure, "Yes, take it, this is Metformin.");
  assert.equal(unsureFlipped.ok, false);
  assert.ok(unsureFlipped.reasons.includes("affirmative_on_caution"));
  assert.ok(unsureFlipped.reasons.includes("caution_dropped"));

  for (const opener of ["Yep, Ibuprofen 400 mg, avoid NSAIDs.", "Yeah, Ibuprofen 400 mg, avoid it.", "Correct, Ibuprofen 400 mg, avoid it.", "That's right, Ibuprofen 400 mg, avoid it.", "Right one, Ibuprofen 400 mg, avoid it."]) {
    assert.ok(speechFidelity(warn, opener).reasons.includes("affirmative_on_caution"), opener);
  }

  const warnNoHedge = speechFidelity(warn, "This is Ibuprofen 400 mg, an anti-inflammatory tablet.");
  assert.equal(warnNoHedge.ok, false);
  assert.deepEqual(warnNoHedge.reasons, ["caution_dropped"]);

  const unsureNoHedge = speechFidelity(unsure, "It looks like Metformin in your hand, turn the box around.");
  assert.equal(unsureNoHedge.ok, false);
  assert.deepEqual(unsureNoHedge.reasons, ["caution_dropped"]);

  for (const wrongDrug of [
    "Yes, Bisoprolol 5 mg, your evening pill. You haven't taken it today.",
    "Yes, Simvastatin 5 mg, your evening pill. You haven't taken it today.",
    "Yes, Ramipril 5 mg, your evening pill. You haven't taken it today.",
  ]) {
    const res = speechFidelity(match, wrongDrug);
    assert.equal(res.ok, false, wrongDrug);
    assert.deepEqual(res.reasons, ["name_missing"]);
  }

  assert.deepEqual(speechFidelity(match, ""), { ok: false, reasons: ["not_spoken"] });
  assert.deepEqual(speechFidelity(match, "   \n\t "), { ok: false, reasons: ["not_spoken"] });
});

test("fidelity: multilingual FI and SV fixed openers, colon punctuation, and Nordic polarity and dose checks", () => {
  const fiMatch: Expected = {
    speech: "Yes, Amlodipine 5 mg, your evening pill. You haven't taken it today.",
    level: "match",
    lead: leadFor("fi", "match").lead,
    names: ["amlodipine", "Amlodipin Orion"],
  };
  assert.equal(fiMatch.lead, "Oikea pakkaus.");
  assert.equal(speechFidelity(fiMatch, "Oikea pakkaus. Amlodipiini 5 mg, iltalääkkeesi. Et ole ottanut sitä tänään.", "fi").ok, true);
  assert.equal(speechFidelity(fiMatch, "Oikea pakkaus. Amlodipiini viisi milligrammaa, iltalääkkeesi.", "fi-FI").ok, true);
  assert.ok(speechFidelity(fiMatch, "Kyllä, Amlodipiini 5 mg, iltalääkkeesi.", "fi").reasons.includes("lead_missing"));
  assert.deepEqual(
    speechFidelity(fiMatch, "Oikea pakkaus. Amlodipiini 50 mg, iltalääkkeesi.", "fi").reasons.sort(),
    ["strength_invented", "strength_missing"],
  );

  const fiWarn: Expected = {
    speech: "This is Ibuprofen 400 mg. It isn't on your medication list and your list says to avoid NSAIDs.",
    level: "warning",
    lead: leadFor("fi", "warning").lead,
    names: ["ibuprofen"],
  };
  assert.equal(fiWarn.lead, "Varoitus.");
  assert.equal(speechFidelity(fiWarn, "Varoitus. Tämä on Ibuprofeeni 400 mg, eikä se ole lääkelistallasi.", "fi").ok, true);
  assert.equal(speechFidelity(fiWarn, "Varoitus: tämä on Ibuprofeeni 400 mg, vältä tulehduskipulääkkeitä.", "fi").ok, true);
  assert.equal(speechFidelity({ ...fiWarn, lead: "Varoitus:" }, "Varoitus: tämä on Ibuprofeeni 400 mg.", "fi").ok, true);
  const fiWarnAffirm = speechFidelity(fiWarn, "Oikea pakkaus. Ibuprofeeni 400 mg.", "fi");
  assert.equal(fiWarnAffirm.ok, false);
  assert.ok(fiWarnAffirm.reasons.includes("affirmative_on_caution"));
  assert.ok(fiWarnAffirm.reasons.includes("lead_missing"));
  assert.ok(speechFidelity(fiWarn, "Kyllä, Ibuprofeeni 400 mg.", "fi").reasons.includes("affirmative_on_caution"));

  const fiUnsure: Expected = {
    speech: "It looks like Metformin, but I can't read the strength confidently. Turn the box so the side panel faces you, or ask a pharmacist.",
    level: "unsure",
    lead: leadFor("fi", "unsure").lead,
    names: ["metformin"],
  };
  assert.equal(fiUnsure.lead, "En ole varma.");
  assert.equal(speechFidelity(fiUnsure, "En ole varma. Tämä näyttää olevan Metformiini, kysy apteekista.", "fi").ok, true);
  assert.ok(speechFidelity(fiUnsure, "En ole varma. Metformiini 500 mg.", "fi").reasons.includes("strength_invented"));

  const svMatch: Expected = {
    speech: "Yes, Bisoprolol 2.5 mg, your morning pill. You haven't taken it today.",
    level: "match",
    lead: leadFor("sv", "match").lead,
    names: ["bisoprolol"],
  };
  assert.equal(svMatch.lead, "Rätt förpackning.");
  assert.equal(speechFidelity(svMatch, "Rätt förpackning. Bisoprolol 2,5 mg, din morgonmedicin.", "sv").ok, true);
  assert.deepEqual(
    speechFidelity(svMatch, "Rätt förpackning. Bisoprolol 25 mg, din morgonmedicin.", "sv-SE").reasons.sort(),
    ["strength_invented", "strength_missing"],
  );

  const svWarn: Expected = {
    speech: "This is Ibuprofen 400 mg. It isn't on your medication list and your list says to avoid NSAIDs.",
    level: "warning",
    lead: leadFor("sv", "warning").lead,
    names: ["ibuprofen"],
  };
  assert.equal(svWarn.lead, "Varning.");
  assert.equal(speechFidelity(svWarn, "Varning. Det här är Ibuprofen 400 mg. Det finns inte på din lista.", "sv").ok, true);
  assert.equal(speechFidelity(svWarn, "Varning: det här är Ibuprofen 400 mg, undvik NSAID.", "sv").ok, true);
  assert.equal(speechFidelity({ ...svWarn, lead: "Varning:" }, "Varning: det här är Ibuprofen 400 mg.", "sv").ok, true);
  const svWarnAffirm = speechFidelity(svWarn, "Ja, det här är Ibuprofen 400 mg.", "sv");
  assert.equal(svWarnAffirm.ok, false);
  assert.ok(svWarnAffirm.reasons.includes("affirmative_on_caution"));
  assert.ok(svWarnAffirm.reasons.includes("lead_missing"));
  assert.ok(speechFidelity(svWarn, "Rätt förpackning. Ibuprofen 400 mg.", "sv").reasons.includes("affirmative_on_caution"));

  const svUnsureLive: Expected = {
    speech: "It looks like Metformin, but I can't read the strength confidently. Turn the box so the side panel faces you, or ask a pharmacist.",
    level: "unsure",
    lead: VERDICT_LEAD.sv.unsure,
    names: ["metformin"],
  };
  assert.equal(svUnsureLive.lead, "Jag är inte säker.");
  assert.equal(speechFidelity(svUnsureLive, "Jag är inte säker. Det ser ut som Metformin, fråga apoteket.", "sv").ok, true);
  assert.ok(speechFidelity(svUnsureLive, "Jag är osäker. Det ser ut som Metformin.", "sv").reasons.includes("lead_missing"));
  assert.equal(
    speechFidelity({ ...svUnsureLive, lead: "Jag är osäker." }, "Jag är osäker. Det ser ut som Metformin, fråga apoteket.", "sv").ok,
    true,
  );
});

test("applyQuestion and checkLabel: EN, FI, and SV slot queries match scheduled slot and warn on wrong slot", () => {
  const slotQueries: Array<{ slot: "morning" | "midday" | "evening" | "night"; questions: string[] }> = [
    {
      slot: "morning",
      questions: [
        "Is this my morning pill?",
        "Onko tämä minun aamupilleri?",
        "Är det här min morgonmedicin?",
        "Tar jag den här till frukost?",
      ],
    },
    {
      slot: "midday",
      questions: [
        "Is this my lunch pill?",
        "Otanko tämän kun on lounas?",
        "Onko tämä keskipäivän lääke?",
        "Är det här min middagstablett?",
      ],
    },
    {
      slot: "evening",
      questions: [
        "Is this my evening pill?",
        "Onko tämä iltapilleri?",
        "Är det här min kvällsmedicin?",
      ],
    },
    {
      slot: "night",
      questions: [
        "Is this my bedtime pill?",
        "Onko tämä minun yölääke?",
        "Ska jag ta den här vid läggdags?",
      ],
    },
  ];

  const scheduleForSlot: Record<"morning" | "midday" | "evening" | "night", string> = {
    morning: "08:00",
    midday: "12:00",
    evening: "19:00",
    night: "22:00",
  };

  const read = makeRead();
  for (const [medSlot, sched] of Object.entries(scheduleForSlot) as Array<["morning" | "midday" | "evening" | "night", string]>) {
    const profile = makeProfile({ meds: [{ ...BASE_MED, schedule: [sched] }] });
    for (const group of slotQueries) {
      for (const q of group.questions) {
        const v = checkLabel(read, profile, NOW, undefined, q);
        assert.ok(wordCount(v.headline) <= 8, v.headline);
        assert.ok(sentenceCount(v.speech) <= 2, v.speech);
        if (group.slot === medSlot) {
          assert.equal(v.level, "match", `Expected match for schedule=${sched} question=${q}`);
        } else {
          assert.equal(v.level, "warning", `Expected warning for schedule=${sched} question=${q}`);
          assert.equal(v.headline, `Amlodipin Orion: not your ${group.slot} pill`);
          assert.equal(
            v.speech,
            `This is Amlodipin Orion 5 mg, but it's your ${medSlot} medicine, not your ${group.slot} one. Check the other boxes before taking it.`,
          );
          assert.ok(v.reasons.includes(`asked about ${group.slot}, scheduled ${medSlot}`));
        }
      }
    }
  }

  const prnProfile = makeProfile({ meds: [{ ...BASE_MED, schedule: ["as needed"] }] });
  assert.equal(checkLabel(read, prnProfile, NOW, undefined, "Is this my evening pill?").level, "match");
  assert.equal(checkLabel(read, makeProfile(), NOW, undefined, "What medicine is in my hand?").level, "match");

  const blurry = checkLabel(makeRead({ strength: F("5 mg", 0.5) }), makeProfile(), NOW, undefined, "Is this my morning pill?");
  assert.equal(blurry.level, "unsure");
  assert.equal(applyQuestion(blurry, makeProfile(), "Is this my morning pill?").level, "unsure");
});

test("checkLabel: HH:MM schedule slot boundaries and multi-schedule medicines", () => {
  const boundaries: Array<{ time: string; expectedSlot: "morning" | "midday" | "evening" | "night" }> = [
    { time: "10:59", expectedSlot: "morning" },
    { time: "11:00", expectedSlot: "midday" },
    { time: "14:59", expectedSlot: "midday" },
    { time: "15:00", expectedSlot: "evening" },
    { time: "20:59", expectedSlot: "evening" },
    { time: "21:00", expectedSlot: "night" },
  ];

  const probeQuestions: Record<"morning" | "midday" | "evening" | "night", string> = {
    morning: "aamupilleri",
    midday: "lounas",
    evening: "Is this my evening pill?",
    night: "bedtime",
  };

  const read = makeRead();
  for (const { time, expectedSlot } of boundaries) {
    const profile = makeProfile({ meds: [{ ...BASE_MED, schedule: [time] }] });
    for (const [asked, q] of Object.entries(probeQuestions) as Array<["morning" | "midday" | "evening" | "night", string]>) {
      const v = checkLabel(read, profile, NOW, undefined, q);
      if (asked === expectedSlot) {
        assert.equal(v.level, "match", `Boundary ${time} should match ${asked}`);
      } else {
        assert.equal(v.level, "warning", `Boundary ${time} should warn on ${asked}`);
        assert.ok(v.reasons.includes(`asked about ${asked}, scheduled ${expectedSlot}`));
      }
    }
  }

  const multiMed: Med = {
    id: "met",
    name: "Metformin Orion",
    ingredient: "metformin hydrochloride",
    strength: "500 mg",
    schedule: ["08:00", "20:00"],
  };
  const multiRead = makeRead({
    product: F("Metformin Orion"),
    ingredient: F("metformin hydrochloride"),
    strength: F("500 mg"),
  });
  const multiProfile = makeProfile({ meds: [multiMed] });

  for (const okQuestion of [
    "Is this my morning pill?",
    "Onko tämä aamupilleri?",
    "Tar jag denna till frukost?",
    "Is this my evening pill?",
    "Onko tämä iltapilleri?",
    "Är det här min kvällsmedicin?",
  ]) {
    assert.equal(checkLabel(multiRead, multiProfile, NOW, undefined, okQuestion).level, "match", okQuestion);
  }

  for (const middayQuestion of ["Is this my lunch pill?", "lounas", "keskipäivä", "middag"]) {
    const v = checkLabel(multiRead, multiProfile, NOW, undefined, middayQuestion);
    assert.equal(v.level, "warning", middayQuestion);
    assert.equal(v.headline, "Metformin Orion: not your midday pill");
    assert.equal(
      v.speech,
      "This is Metformin Orion 500 mg, but it's your morning and evening medicine, not your midday one. Check the other boxes before taking it.",
    );
    assert.ok(v.reasons.includes("asked about midday, scheduled morning and evening"));
  }

  for (const nightQuestion of ["Is this my bedtime pill?", "yö", "läggdags"]) {
    const v = checkLabel(multiRead, multiProfile, NOW, undefined, nightQuestion);
    assert.equal(v.level, "warning", nightQuestion);
    assert.ok(v.reasons.includes("asked about night, scheduled morning and evening"));
  }
});

test("checkLabel: EU FMD DataMatrix crossCheck agreement still becomes warning when asked about wrong slot", () => {
  const morningMed: Med = {
    ...BASE_MED,
    schedule: ["08:00"],
    gtin: "06414100000001",
  };
  const profile = makeProfile({ meds: [morningMed] });
  const read = makeRead({ expiry: F("2027-08", 0.95) });
  const dmCode: Gs1Code = {
    raw: "01064141000000011727083110LOT4221SER99",
    gtin: "06414100000001",
    expiry: "2027-08-31",
    batch: "LOT42",
    serial: "SER99",
  };

  const rightSlot = checkLabel(read, profile, NOW, dmCode, "Is this my morning pill?");
  assert.equal(rightSlot.level, "match");
  assert.equal(rightSlot.crossCheck?.agrees, true);
  assert.match(rightSlot.speech, /double-checked with the pack's code/);

  for (const eveningQuestion of [
    "Is this my evening pill?",
    "Onko tämä iltapilleri?",
    "Är det här min kvällsmedicin?",
  ]) {
    const wrongSlot = checkLabel(read, profile, NOW, dmCode, eveningQuestion);
    assert.equal(wrongSlot.crossCheck?.agrees, true, eveningQuestion);
    assert.equal(wrongSlot.level, "warning", eveningQuestion);
    assert.equal(wrongSlot.matchedMedId, "aml");
    assert.equal(wrongSlot.headline, "Amlodipin Orion: not your evening pill");
    assert.equal(
      wrongSlot.speech,
      "This is Amlodipin Orion 5 mg, but it's your morning medicine, not your evening one. Check the other boxes before taking it.",
    );
    assert.ok(wrongSlot.reasons.some((r) => r.includes("GTIN 06414100000001 = your Amlodipin Orion")));
    assert.ok(wrongSlot.reasons.some((r) => r.includes("expiry: code 2027-08-31 = print 2027-08")));
    assert.ok(wrongSlot.reasons.includes("asked about evening, scheduled morning"));
  }
});

test("judge-panel guards: unmappedAllergies and allergyLabel with Nordic umlauts", () => {
  assert.deepEqual(
    unmappedAllergies(["kiwi", "strawberry", "buckwheat", "Allergic to kiwi (severe)", "peanuts and buckwheat"]),
    ["kiwi", "strawberry", "buckwheat", "Allergic to kiwi (severe)", "peanuts and buckwheat"],
  );
  assert.deepEqual(
    unmappedAllergies([
      "peanuts",
      "Allergic to peanuts (severe)",
      "sesame seeds",
      "milk protein",
      "maapähkinä",
      "maapähkinää",
      "maapähkinöitä",
      "pähkinäallergia",
      "hasselpähkinöitä",
      "jordnötter",
      "hasselnötter",
      "mjölkprotein",
      "skaldjur",
      "blötdjur",
      "äyriäisiä",
      "kananmunia",
      "penisilliini",
      "tulehduskipulaakkeet",
    ]),
    [],
  );

  const safePanelFood = makeRead({
    kind: "food",
    product: F("Kaurakeksi"),
    ingredient: N,
    strength: N,
    expiry: F("2027-05"),
    allergens: F(["oats", "wheat"], 0.98),
    readability: 0.95,
  });

  for (const unmapped of ["kiwi", "strawberry", "buckwheat"]) {
    const v = checkLabel(safePanelFood, makeProfile({ allergies: ["peanuts", unmapped] }), NOW);
    assert.equal(v.level, "unsure", unmapped);
    assert.equal(v.headline, "Can't check one of your allergies");
    assert.match(v.speech, new RegExp(`"${unmapped}"`));
    assert.ok(v.reasons.includes(`allergy not recognised: ${unmapped}`));
  }

  const explicitKiwiFood = makeRead({
    kind: "food",
    product: F("Smoothie"),
    ingredient: N,
    strength: N,
    allergens: F(["kiwi", "apple"], 0.96),
    readability: 0.95,
  });
  assert.equal(checkLabel(explicitKiwiFood, makeProfile({ allergies: ["kiwi"] }), NOW).level, "warning");

  assert.equal(allergyLabel("maapähkinä"), "maapähkinä");
  assert.equal(allergyLabel("pähkinät"), "pähkinät");
  assert.equal(allergyLabel("jordnötter"), "jordnötter");
  assert.equal(allergyLabel("mjölk"), "mjölk");
  assert.equal(allergyLabel("äyriäiset"), "äyriäiset");
  assert.equal(allergyLabel("blötdjur"), "blötdjur");
  assert.equal(allergyLabel("Allergic to peanuts (severe)"), "peanuts");
  assert.equal(allergyLabel("sesame seeds"), "sesame");
  assert.equal(allergyLabel("milk protein"), "milk");

  const fiAllergyVerdict = checkLabel(
    makeRead({ kind: "food", product: F("Patukka"), ingredient: N, strength: N, allergens: F(["arachis"], 0.95) }),
    makeProfile({ allergies: ["maapähkinä"] }),
    NOW,
  );
  assert.equal(fiAllergyVerdict.level, "warning");
  assert.match(fiAllergyVerdict.speech, /Your profile lists an allergy to maapähkinä\./);

  const svAllergyVerdict = checkLabel(
    makeRead({ kind: "food", product: F("Kaka"), ingredient: N, strength: N, allergens: F(["peanuts"], 0.95) }),
    makeProfile({ allergies: ["jordnötter"] }),
    NOW,
  );
  assert.equal(svAllergyVerdict.level, "warning");
  assert.match(svAllergyVerdict.speech, /Your profile lists an allergy to jordnötter\./);
});

test("judge-panel guards: productIngredientClash, isPerVolume liquid vs tablet, and cross-midnight rolling dose window", () => {
  const profile = makeProfile();

  for (const [prod, expectedDrug] of [
    ["Bisoprolol Orion 5 mg", "bisoprolol"],
    ["Candesartan Krka 8 mg", "candesartan"],
    ["Metformin Teva 500 mg", "metformin"],
  ] as const) {
    const clashRead = makeRead({ product: F(prod, 0.92), ingredient: F("amlodipine", 0.9) });
    assert.deepEqual(productIngredientClash(clashRead, profile), { product: expectedDrug, ingredient: "amlodipine" });
    const v = checkLabel(clashRead, profile, NOW);
    assert.equal(v.level, "unsure");
    assert.equal(v.headline, "Name and ingredient disagree");
    assert.match(v.speech, /ask a pharmacist/);
  }

  assert.equal(productIngredientClash(makeRead({ product: F("Norvasc 5 mg", 0.95), ingredient: F("amlodipine besilate", 0.95) }), profile), undefined);
  assert.equal(productIngredientClash(makeRead({ product: F("Orion Tabletti 5 mg", 0.95), ingredient: F("amlodipine", 0.95) }), profile), undefined);
  assert.equal(productIngredientClash(makeRead({ product: F("Bisoprolol 5 mg", 0.59), ingredient: F("amlodipine", 0.95) }), profile), undefined);

  for (const liquid of ["5 mg/5 ml", "10 mg/ml", "2,5 mg/ml", "5 mg per 5 ml", "5 mg/millilitre", "100 IU/ml"]) {
    assert.equal(isPerVolume(liquid), true, liquid);
  }
  for (const nonLiquid of ["5 mg", "100 mcg", "10 mg/g", "25 mcg/h", "", null, undefined]) {
    assert.equal(isPerVolume(nonLiquid), false, String(nonLiquid));
  }

  for (const liquidStrength of ["5 mg/5 ml", "5 mg/ml", "5 mg per 5 ml"]) {
    const v = checkLabel(makeRead({ strength: F(liquidStrength, 0.95) }), profile, NOW);
    assert.equal(v.level, "warning", liquidStrength);
    assert.equal(v.headline, "Amlodipine: different form");
    assert.match(v.speech, /different form\. Don't take it before checking with a pharmacist\./);
  }

  const liquidMedProfile = makeProfile({ meds: [{ ...BASE_MED, strength: "5 mg/ml" }] });
  const tabletAgainstLiquid = checkLabel(makeRead({ strength: F("5 mg", 0.95) }), liquidMedProfile, NOW);
  assert.equal(tabletAgainstLiquid.level, "warning");
  assert.equal(tabletAgainstLiquid.headline, "Amlodipine: different form");

  const matchingLiquidProfile = makeProfile({ meds: [{ ...BASE_MED, strength: "1 mg/ml" }] });
  assert.equal(checkLabel(makeRead({ strength: F("5 mg/5 ml", 0.95) }), matchingLiquidProfile, NOW).level, "match");

  const lateDoseTs = new Date(2026, 10, 14, 23, 50, 0).getTime();
  const onceDailyLate = makeProfile({
    meds: [{ ...BASE_MED, schedule: ["22:00"] }],
    doseLog: [{ medId: "aml", ts: lateDoseTs }],
  });

  const at0015 = checkLabel(makeRead(), onceDailyLate, new Date(2026, 10, 15, 0, 15, 0));
  assert.equal(at0015.level, "warning");
  assert.equal(at0015.takenToday, true);
  assert.equal(at0015.headline, "Amlodipine 5 mg: taken at 23:50");
  assert.equal(at0015.speech, "This is Amlodipine 5 mg, but you already took it at 23:50. Don't take another unless your plan says so.");
  assert.ok(at0015.reasons.includes("dose logged at 23:50, within the dosing interval"));

  assert.equal(checkLabel(makeRead(), onceDailyLate, new Date(2026, 10, 15, 11, 49, 0)).level, "warning");
  assert.equal(checkLabel(makeRead(), onceDailyLate, new Date(2026, 10, 15, 11, 50, 0)).level, "match");
  assert.equal(checkLabel(makeRead(), onceDailyLate, new Date(2026, 10, 15, 22, 0, 0)).level, "match");

  const twiceDailyLate = makeProfile({
    meds: [{ ...BASE_MED, schedule: ["08:00", "20:00"] }],
    doseLog: [{ medId: "aml", ts: lateDoseTs }],
  });
  assert.equal(checkLabel(makeRead(), twiceDailyLate, new Date(2026, 10, 15, 0, 15, 0)).level, "warning");
  assert.equal(checkLabel(makeRead(), twiceDailyLate, new Date(2026, 10, 15, 5, 49, 0)).level, "warning");
  assert.equal(checkLabel(makeRead(), twiceDailyLate, new Date(2026, 10, 15, 5, 50, 0)).level, "match");

  assert.equal(lastDoseWithin(onceDailyLate, "other-med", new Date(2026, 10, 15, 0, 15, 0), 12 * 3600_000), undefined);
  assert.equal(lastDoseWithin(onceDailyLate, "aml", new Date(2026, 10, 14, 23, 40, 0), 12 * 3600_000), undefined);
  assert.equal(lastDoseWithin(onceDailyLate, "aml", new Date(2026, 10, 15, 0, 15, 0), 12 * 3600_000), lateDoseTs);
});

test("judge-panel probes 14 and 17: low-confidence past expiry is unsure and off-hour checks note current time of day", () => {
  const profile = makeProfile();

  for (const conf of [0.3, 0.5, 0.69]) {
    const lowConfPast = checkLabel(makeRead({ expiry: F("2025-06", conf) }), profile, NOW);
    assert.equal(lowConfPast.level, "unsure", `conf=${conf}`);
    assert.equal(lowConfPast.matchedMedId, "aml");
    assert.equal(lowConfPast.headline, "Amlodipine 5 mg: check the expiry date");
    assert.match(lowConfPast.speech, /expiry date may have passed and I can't read it clearly/);
    assert.ok(lowConfPast.reasons.includes("expiry may have passed (2025-06, low confidence)"));
  }

  const highConfPast = checkLabel(makeRead({ expiry: F("2025-06", 0.7) }), profile, NOW);
  assert.equal(highConfPast.level, "warning");
  assert.equal(highConfPast.headline, "Amlodipine 5 mg: expired June 2025");

  const noiseFloorPast = checkLabel(makeRead({ expiry: F("2025-06", 0.29) }), profile, NOW);
  assert.equal(noiseFloorPast.level, "match");
  assert.ok(noiseFloorPast.reasons.includes("expiry not readable"));

  const lowConfFuture = checkLabel(makeRead({ expiry: F("2028-06", 0.5) }), profile, NOW);
  assert.equal(lowConfFuture.level, "match");
  assert.match(lowConfFuture.speech, /couldn't read the expiry date/);

  const eveningAtMorning = checkLabel(makeRead(), profile, new Date(2026, 10, 15, 8, 30, 0));
  assert.equal(eveningAtMorning.level, "match");
  assert.equal(
    eveningAtMorning.speech,
    "Yes, Amlodipine 5 mg, your evening pill, but it's only morning now. You haven't taken it today.",
  );
  assert.ok(eveningAtMorning.reasons.includes("asked in the morning, scheduled later"));

  const nightProfile = makeProfile({ meds: [{ ...BASE_MED, schedule: ["22:00"] }] });
  const nightAtMidday = checkLabel(makeRead(), nightProfile, new Date(2026, 10, 15, 12, 15, 0));
  assert.equal(nightAtMidday.level, "match");
  assert.equal(
    nightAtMidday.speech,
    "Yes, Amlodipine 5 mg, your night pill, but it's only midday now. You haven't taken it today.",
  );
  assert.ok(nightAtMidday.reasons.includes("asked in the midday, scheduled later"));

  const smallHours = checkLabel(makeRead(), nightProfile, new Date(2026, 10, 15, 4, 30, 0));
  assert.equal(smallHours.level, "match");
  assert.doesNotMatch(smallHours.speech, /only .* now/);

  const adjacentSlot = checkLabel(makeRead(), profile, new Date(2026, 10, 15, 14, 0, 0));
  assert.equal(adjacentSlot.level, "match");
  assert.doesNotMatch(adjacentSlot.speech, /only .* now/);
});

test("LiveProxy: spoken-answer fidelity check emits correction on mutated dose and stays silent on faithful speech", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  process.env.HOLDUP_QUIET = "1";
  const shm = fs.existsSync("/dev/shm") ? "/dev/shm" : os.tmpdir();
  const dir = fs.mkdtempSync(path.join(shm, "holdup-fid-"));
  tempDirs.push(dir);
  env.ledgerPath = path.join(dir, "ledger.jsonl");

  let callbacks: any;
  (ai.live as any).connect = async (arg: any) => {
    callbacks = arg.callbacks;
    return { sendToolResponse() {}, sendRealtimeInput() {}, close() {} };
  };
  (ai.models as any).generateContent = async () => ({
    text: JSON.stringify({
      kind: "medication",
      product: F("Sifrol"),
      ingredient: F("pramipexole", 0.97),
      strength: F("0.18 mg", 0.96),
      dosing: N,
      expiry: F("2028-04", 0.94),
      allergens: N,
      barcode: N,
      readability: 0.94,
    }),
    usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 16 },
  });

  const hub = new Hub("fid-live-1");
  hub.profile = makeProfile({
    meds: [{ id: "pram", name: "Sifrol", ingredient: "pramipexole", strength: "0.18 mg", schedule: ["evening"] }],
  });

  const emitted: ServerMsg[] = [];
  const waiters: Array<{ pred: (m: ServerMsg) => boolean; resolve: (m: ServerMsg) => void }> = [];
  hub.clients.add({
    readyState: 1,
    send(raw: string) {
      const msg = JSON.parse(raw) as ServerMsg;
      emitted.push(msg);
      const idx = waiters.findIndex((w) => w.pred(msg));
      if (idx >= 0) waiters.splice(idx, 1)[0].resolve(msg);
    },
  } as unknown as WebSocket);

  const waitFor = (pred: (m: ServerMsg) => boolean, from: number): Promise<ServerMsg> => {
    const hit = emitted.slice(from).find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for ServerMsg")), 2000);
      waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  };

  const proxy = new LiveProxy(hub, { lang: "en", voice: true });
  hub.live = proxy;
  try {
    await proxy.start();
    hub.ring.push({ data: "jpeg-frame-1", sharpness: 0.92, ts: Date.now(), bytes: 4096, source: "phone" });

    let idx = emitted.length;
    callbacks.onmessage({ toolCall: { functionCalls: [{ id: "tc-1", name: "verify_label", args: { question: "Is this my evening pill?" } }] } });
    await waitFor((m) => m.type === "checking" && m.phase === "end", idx);

    callbacks.onmessage({ serverContent: { outputTranscription: { text: "Yes, Pramipexole 18 mg, your evening pill." } } });
    callbacks.onmessage({ serverContent: { turnComplete: true } });

    const corr = emitted.slice(idx).find((m): m is Extract<ServerMsg, { type: "correction" }> => m.type === "correction");
    assert.ok(corr);
    assert.equal(corr.speech, "Yes, Pramipexole 0.18 mg, your evening pill. You haven't taken it today.");
    assert.deepEqual([...corr.reasons].sort(), ["strength_invented", "strength_missing"]);
    assert.deepEqual(proxy.fidelity, { checked: 1, mismatched: 1 });

    idx = emitted.length;
    callbacks.onmessage({ toolCall: { functionCalls: [{ id: "tc-2", name: "verify_label", args: { question: "Is this my morning pill?" } }] } });
    await waitFor((m) => m.type === "checking" && m.phase === "end", idx);

    callbacks.onmessage({
      serverContent: {
        outputTranscription: {
          text: "This is Sifrol 0.18 mg, but it's your evening medicine, not your morning one. Check the other boxes before taking it.",
        },
      },
    });
    callbacks.onmessage({ serverContent: { turnComplete: true } });

    assert.equal(emitted.slice(idx).some((m) => m.type === "correction"), false);
    assert.deepEqual(proxy.fidelity, { checked: 2, mismatched: 1 });
  } finally {
    proxy.stop("done");
    hub.dropFrames();
    env.ledgerPath = originalLedgerPath;
  }
});
