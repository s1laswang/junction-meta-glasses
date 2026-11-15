import { test } from "node:test";
import assert from "node:assert/strict";
import { speechFidelity, strengthsIn, wordsToNumber } from "../src/fidelity.ts";

const match = { speech: "Yes, Amlodipine 5 mg, your evening pill. You haven't taken it today.", level: "match" as const, names: ["Amlodipine"] };
const warn = { speech: "This is Ibuprofen 400 mg. It isn't on your medication list and your list says to avoid NSAIDs.", level: "warning" as const, names: ["Ibuprofen"] };
const unsure = { speech: "It looks like Amlodipine, but I can't read the strength confidently. Turn the box so the side panel faces you, or ask a pharmacist.", level: "unsure" as const, names: ["Amlodipine"] };

test("number words and strengths are parsed the way speech transcription writes them", () => {
  assert.equal(wordsToNumber(["five"]), 5);
  assert.equal(wordsToNumber(["twenty", "five"]), 25);
  assert.equal(wordsToNumber(["two", "point", "five"]), 2.5);
  assert.equal(wordsToNumber(["five", "hundred"]), 500);
  assert.equal(wordsToNumber(["one", "thousand"]), 1000);
  assert.equal(wordsToNumber(["evening"]), undefined);
  assert.deepEqual([...strengthsIn("Amlodipine five milligrams")], ["5 mg"]);
  assert.deepEqual([...strengthsIn("2,5 mg and 400 milligrams")].sort(), ["2.5 mg", "400 mg"]);
  assert.deepEqual([...strengthsIn("you took it at 19:00 on 3 December")], []);
});

test("word-for-word and harmless paraphrase pass", () => {
  assert.equal(speechFidelity(match, match.speech).ok, true);
  assert.equal(speechFidelity(match, "Let me look. Yes, amlodipine five milligrams, your evening pill. You haven't taken it today.").ok, true);
  assert.equal(speechFidelity(warn, "This is ibuprofen 400 milligrams. It is not on your medication list, and your list says to avoid NSAIDs.").ok, true);
  assert.equal(speechFidelity(unsure, unsure.speech).ok, true);
});

test("a changed or invented strength is caught", () => {
  assert.deepEqual(speechFidelity(match, "Yes, Amlodipine 10 mg, your evening pill.").reasons.sort(), ["strength_invented", "strength_missing"]);
  assert.ok(speechFidelity(unsure, "It looks like Amlodipine 5 mg, but I can't read the strength confidently.").reasons.includes("strength_invented"));
  assert.ok(speechFidelity(match, "Yes, Amlodipine, your evening pill.").reasons.includes("strength_missing"));
});

test("a warning turned into a yes, or with its caution dropped, is caught", () => {
  assert.ok(speechFidelity(warn, "Yes, this is Ibuprofen 400 mg.").reasons.includes("affirmative_on_caution"));
  assert.ok(speechFidelity(warn, "This is Ibuprofen 400 mg, a common painkiller.").reasons.includes("caution_dropped"));
  assert.ok(speechFidelity(unsure, "Yes, it's Amlodipine.").reasons.includes("affirmative_on_caution"));
});

test("a missing medicine name and silence are caught", () => {
  assert.ok(speechFidelity(match, "Yes, that's your 5 mg evening pill.").reasons.includes("name_missing"));
  assert.deepEqual(speechFidelity(match, "   ").reasons, ["not_spoken"]);
});

test("Finnish and Swedish: fixed opener required, digits checked, translation otherwise allowed", () => {
  const fi = { ...match, lead: "Oikea pakkaus." };
  assert.equal(speechFidelity(fi, "Oikea pakkaus. Amlodipine 5 mg, iltalääkkeesi. Et ole ottanut sitä tänään.", "fi").ok, true);
  assert.ok(speechFidelity(fi, "Kyllä, Amlodipine 5 mg, iltalääkkeesi.", "fi").reasons.includes("lead_missing"));
  assert.ok(speechFidelity(fi, "Oikea pakkaus. Amlodipine 10 mg.", "fi-FI").reasons.includes("strength_invented"));
  const svWarn = { ...warn, lead: "Varning." };
  assert.equal(speechFidelity(svWarn, "Varning. Det här är Ibuprofen 400 mg. Det finns inte på din läkemedelslista.", "sv").ok, true);
});
