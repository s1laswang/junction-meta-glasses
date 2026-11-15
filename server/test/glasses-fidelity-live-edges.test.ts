import { test } from "node:test";
import assert from "node:assert/strict";
import { speechFidelity, strengthsIn, wordsToNumber, type Expected } from "../src/fidelity.ts";
import { leadFor } from "../src/live.ts";

test("wordsToNumber parses decimals, multi-digit fractions, hundreds, thousands, and rejects malformed phrases", () => {
  assert.equal(wordsToNumber([]), undefined);
  assert.equal(wordsToNumber(["zero"]), 0);
  assert.equal(wordsToNumber(["nineteen"]), 19);
  assert.equal(wordsToNumber(["twenty", "five"]), 25);
  assert.equal(wordsToNumber(["two", "point", "five"]), 2.5);
  assert.equal(wordsToNumber(["zero", "point", "two", "five"]), 0.25);
  assert.equal(wordsToNumber(["zero", "point", "zero", "five"]), 0.05);
  assert.equal(wordsToNumber(["ten", "point", "five"]), 10.5);
  assert.equal(wordsToNumber(["a", "hundred"]), 100);
  assert.equal(wordsToNumber(["five", "hundred", "and", "twenty", "five"]), 525);
  assert.equal(wordsToNumber(["a", "thousand"]), 1000);
  assert.equal(wordsToNumber(["one", "thousand", "five", "hundred"]), 1500);
  assert.equal(wordsToNumber(["point", "five"]), undefined);
  assert.equal(wordsToNumber(["two", "point"]), undefined);
  assert.equal(wordsToNumber(["two", "point", "ten"]), undefined);
  assert.equal(wordsToNumber(["two", "point", "twenty"]), undefined);
  assert.equal(wordsToNumber(["and"]), undefined);
  assert.equal(wordsToNumber(["twenty", "tablets"]), undefined);
});

test("strengthsIn normalizes Bluetooth HFP ASR/TTS decimal commas, hyphenated words, mcg/ug, IU/units, percent, g, and ml", () => {
  assert.deepEqual([...strengthsIn("Warfarin two point five milligrams")], ["2.5 mg"]);
  assert.deepEqual([...strengthsIn("Warfarin 2,5 mg")], ["2.5 mg"]);
  assert.deepEqual([...strengthsIn("Digoxin zero point two five milligrams")], ["0.25 mg"]);
  assert.deepEqual([...strengthsIn("Hydroxyzine twenty-five mg")], ["25 mg"]);
  assert.deepEqual([...strengthsIn("Metoprolol fifty-five milligrammes")], ["55 mg"]);

  assert.deepEqual([...strengthsIn("Levothyroxine 100 mcg")], ["100 mcg"]);
  assert.deepEqual([...strengthsIn("Levothyroxine one hundred micrograms")], ["100 mcg"]);
  assert.deepEqual([...strengthsIn("Levothyroxine 100 microgram")], ["100 mcg"]);
  assert.deepEqual([...strengthsIn("Levothyroxine 100 ug")], ["100 mcg"]);

  assert.deepEqual([...strengthsIn("Colecalciferol 1000 IU")], ["1000 iu"]);
  assert.deepEqual([...strengthsIn("Colecalciferol one thousand units")], ["1000 iu"]);
  assert.deepEqual([...strengthsIn("Insulin 1 unit")], ["1 iu"]);

  assert.deepEqual([...strengthsIn("Hydrocortisone 1%")], ["1 %"]);
  assert.deepEqual([...strengthsIn("Hydrocortisone 0,5 %")], ["0.5 %"]);
  assert.deepEqual([...strengthsIn("Hydrocortisone zero point five percent")], ["0.5 %"]);

  assert.deepEqual([...strengthsIn("Paracetamol 1 g and 15 millilitres")], ["1 g", "15 ml"]);
  assert.deepEqual([...strengthsIn("Syrup five milliliters, dose two grams")].sort(), ["2 g", "5 ml"]);
});

test("speechFidelity accepts equivalent spoken units and decimal commas while catching 10x decimal shifts and unit swaps", () => {
  const warfarin: Expected = {
    speech: "Yes, Warfarin 2,5 mg, your evening tablet. You haven't taken it today.",
    level: "match",
    names: ["Warfarin"],
  };
  assert.equal(
    speechFidelity(warfarin, "Yes, warfarin two point five milligrams, your evening tablet. You haven't taken it today.").ok,
    true,
  );
  const shiftRes = speechFidelity(warfarin, "Yes, warfarin twenty-five mg, your evening tablet. You haven't taken it today.");
  assert.equal(shiftRes.ok, false);
  assert.deepEqual(shiftRes.reasons.sort(), ["strength_invented", "strength_missing"]);

  const thyroxine: Expected = {
    speech: "Yes, Levothyroxine 50 mcg, your morning tablet.",
    level: "match",
    names: ["Levothyroxine"],
  };
  assert.equal(speechFidelity(thyroxine, "Yes, levothyroxine fifty micrograms, your morning tablet.").ok, true);
  assert.equal(speechFidelity(thyroxine, "Yes, levothyroxine 50 ug, your morning tablet.").ok, true);
  const unitSwap = speechFidelity(thyroxine, "Yes, levothyroxine 50 mg, your morning tablet.");
  assert.equal(unitSwap.ok, false);
  assert.deepEqual(unitSwap.reasons.sort(), ["strength_invented", "strength_missing"]);

  const insulin: Expected = {
    speech: "Yes, Insulin 100 units, your mealtime pen.",
    level: "match",
    names: ["Insulin"],
  };
  assert.equal(speechFidelity(insulin, "Yes, insulin one hundred IU, your mealtime pen.").ok, true);

  const cream: Expected = {
    speech: "Yes, Hydrocortisone 0.5%, topical cream.",
    level: "match",
    names: ["Hydrocortisone"],
  };
  assert.equal(speechFidelity(cream, "Yes, hydrocortisone zero point five percent, topical cream.").ok, true);
});

test("speechFidelity catches affirmative_on_caution across EN, FI, and SV while allowing non-affirmative Jag opener", () => {
  const enWarn: Expected = {
    speech: "This is Ibuprofen 400 mg. It isn't on your medication list and your list says to avoid NSAIDs.",
    level: "warning",
    names: ["Ibuprofen"],
  };
  for (const opener of ["Yes,", "Yep,", "Yeah", "Correct,", "That's right,", "Right one,"]) {
    const r = speechFidelity(enWarn, `${opener} Ibuprofen 400 mg, avoid NSAIDs.`, "en");
    assert.ok(r.reasons.includes("affirmative_on_caution"), opener);
  }

  const fiWarn: Expected = {
    ...enWarn,
    lead: leadFor("fi", "warning").lead,
  };
  assert.ok(speechFidelity(fiWarn, "Kyllä, Ibuprofen 400 mg.", "fi").reasons.includes("affirmative_on_caution"));
  assert.ok(speechFidelity(fiWarn, "Oikea pakkaus. Ibuprofen 400 mg.", "fi").reasons.includes("affirmative_on_caution"));

  const svUnsure: Expected = {
    speech: "It looks like Amlodipine, but I can't read the strength confidently.",
    level: "unsure",
    lead: leadFor("sv", "unsure").lead,
    names: ["Amlodipine"],
  };
  assert.ok(speechFidelity(svUnsure, "Ja, det ser ut som Amlodipine.", "sv").reasons.includes("affirmative_on_caution"));
  assert.ok(speechFidelity(svUnsure, "Ja. Det ser ut som Amlodipine.", "sv").reasons.includes("affirmative_on_caution"));
  assert.ok(speechFidelity(svUnsure, "Rätt förpackning. Det ser ut som Amlodipine.", "sv").reasons.includes("affirmative_on_caution"));
  assert.equal(
    speechFidelity(svUnsure, "Jag är inte säker. Det ser ut som Amlodipine, fråga apoteket.", "sv-SE").ok,
    true,
  );
});

test("speechFidelity enforces FI and SV lead openers across all verdict levels and handles non-English digit vs word strengths", () => {
  const levels = ["match", "warning", "unsure", "info"] as const;
  const sampleSaid: Record<(typeof levels)[number], { fi: string; sv: string; speech: string }> = {
    match: {
      speech: "Yes, Amlodipine 5 mg.",
      fi: "Oikea pakkaus. Amlodipine 5 mg.",
      sv: "Rätt förpackning. Amlodipine 5 mg.",
    },
    warning: {
      speech: "Warning: Ibuprofen 400 mg, avoid NSAIDs.",
      fi: "Varoitus. Ibuprofen 400 mg.",
      sv: "Varning. Ibuprofen 400 mg.",
    },
    unsure: {
      speech: "I'm not sure about Amlodipine.",
      fi: "En ole varma. Amlodipine.",
      sv: "Jag är inte säker. Amlodipine.",
    },
    info: {
      speech: "Oat milk, no listed allergens.",
      fi: "Tiedoksi. Kauramaito.",
      sv: "För kännedom. Havredryck.",
    },
  };

  for (const level of levels) {
    const fiExp: Expected = { speech: sampleSaid[level].speech, level, lead: leadFor("fi", level).lead };
    assert.equal(speechFidelity(fiExp, sampleSaid[level].fi, "fi").ok, true, `fi/${level}`);
    assert.ok(speechFidelity(fiExp, "Tämä pakkaus 5 mg 400 mg.", "fi").reasons.includes("lead_missing"), `fi missing/${level}`);

    const svExp: Expected = { speech: sampleSaid[level].speech, level, lead: leadFor("sv", level).lead };
    assert.equal(speechFidelity(svExp, sampleSaid[level].sv, "sv").ok, true, `sv/${level}`);
    assert.ok(speechFidelity(svExp, "Den här förpackningen 5 mg 400 mg.", "sv").reasons.includes("lead_missing"), `sv missing/${level}`);
  }

  const fiMatch: Expected = {
    speech: "Yes, Amlodipine 5 mg, your evening pill.",
    level: "match",
    lead: leadFor("fi", "match").lead,
    names: ["Amlodipine"],
  };
  assert.equal(
    speechFidelity(fiMatch, "Oikea pakkaus. Amlodipine viisi milligrammaa, iltalääkkeesi.", "fi").ok,
    true,
  );
  assert.ok(
    speechFidelity(fiMatch, "Oikea pakkaus. Amlodipine otettu kello 19.", "fi").reasons.includes("strength_missing"),
  );
});

test("speechFidelity catches caution_dropped, name_missing, and not_spoken on glasses audio transcripts", () => {
  const allergenWarn: Expected = {
    speech: "Warning: Peanut Bar contains peanuts, which matches your allergy list.",
    level: "warning",
    names: ["Peanut"],
  };
  assert.ok(
    speechFidelity(allergenWarn, "Peanut Bar is a snack bar with protein.", "en").reasons.includes("caution_dropped"),
  );
  assert.equal(
    speechFidelity(allergenWarn, "Warning: Peanut Bar contains an allergen on your list.", "en").ok,
    true,
  );

  const expiredWarn: Expected = {
    speech: "This is Metformin 500 mg, but the pack expired in 2024-05.",
    level: "warning",
    names: ["Metformin Hydrochloride"],
  };
  assert.ok(
    speechFidelity(expiredWarn, "This is Metformin 500 mg from 2024.", "en").reasons.includes("caution_dropped"),
  );
  assert.equal(
    speechFidelity(expiredWarn, "This is Metformin 500 mg and it is expired.", "en").ok,
    true,
  );
  assert.ok(
    speechFidelity(expiredWarn, "This is your 500 mg tablet and it is expired.", "en").reasons.includes("name_missing"),
  );
  assert.equal(
    speechFidelity(expiredWarn, "This is metformi 500 mg and it is expired.", "en").ok,
    true,
  );

  assert.deepEqual(speechFidelity(expiredWarn, ""), { ok: false, reasons: ["not_spoken"] });
  assert.deepEqual(speechFidelity(expiredWarn, "   \n\t  "), { ok: false, reasons: ["not_spoken"] });
});
