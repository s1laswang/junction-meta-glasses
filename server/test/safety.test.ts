import { test } from "node:test";
import assert from "node:assert/strict";
import type { LabelRead, Profile } from "../../shared/types.ts";
import { checkLabel, clampHeadline, clampSpeech, isExpired, parseStrength, sameStrength } from "../src/safety.ts";
import { toLabelRead } from "../src/verify.ts";

const NOW = new Date(2026, 10, 14, 20, 0); // Sat 14 Nov 2026, 20:00
const f = <T>(value: T | null, confidence = 0.95) => ({ value, confidence });
function read(p: Partial<LabelRead>): LabelRead {
  return {
    kind: "medication", product: f(null, 0), ingredient: f(null, 0), strength: f(null, 0), dosing: f(null, 0),
    expiry: f(null, 0), allergens: f<string[]>(null, 0), barcode: f(null, 0), readability: 0.9, ...p,
  };
}
const profile: Profile = {
  meds: [
    { id: "aml", name: "Norvasc", ingredient: "amlodipine", strength: "5mg", schedule: ["evening"] },
    { id: "met", name: "Metformin", ingredient: "metformin", strength: "500 mg", schedule: ["08:00", "20:00"] },
  ],
  allergies: ["peanut", "tree nuts"], avoid: ["NSAIDs"], doseLog: [], lang: "en",
};
const words = (s: string) => s.trim().split(/\s+/).length;
const sentences = (s: string) => s.trim().split(/(?<=[.!?])\s+/).length;

test("strength normalisation", () => {
  assert.ok(sameStrength("5mg", "5 mg"));
  assert.ok(sameStrength("5 MG", "5mg"));
  assert.ok(sameStrength("2,5 mg", "2.5mg"));
  assert.ok(sameStrength("0.5 g", "500 mg"));
  assert.ok(!sameStrength("10 mg", "5 mg"));
  assert.ok(!sameStrength(null, "5 mg"));
  assert.deepEqual(parseStrength("500 mg/5 ml"), [{ amount: 500, unit: "mg" }, { amount: 5, unit: "ml" }]);
});

test("match: amlodipine 5 mg by brand-agnostic ingredient, not taken today", () => {
  const v = checkLabel(read({ product: f("Amlodipin Orion"), ingredient: f("amlodipine"), strength: f("5 mg", 0.92) }), profile, NOW);
  assert.equal(v.level, "match");
  assert.equal(v.matchedMedId, "aml");
  assert.equal(v.takenToday, false);
  assert.match(v.speech, /Amlodipine 5 mg, your evening pill\. You haven't taken it today\./);
  assert.ok(words(v.headline) <= 8 && sentences(v.speech) <= 2);
});

test("match via brand name in product only (Norvasc)", () => {
  const v = checkLabel(read({ product: f("Norvasc"), strength: f("5mg", 0.9) }), profile, NOW);
  assert.equal(v.level, "match");
  assert.equal(v.matchedMedId, "aml");
});

test("unsure when strength confidence < 0.8 or missing", () => {
  const low = checkLabel(read({ ingredient: f("amlodipine"), strength: f("5 mg", 0.6), guidance: "Turn the box to show the side panel." }), profile, NOW);
  assert.equal(low.level, "unsure");
  assert.match(low.speech, /can't read the strength/);
  assert.ok(sentences(low.speech) <= 2);
  const missing = checkLabel(read({ ingredient: f("amlodipine"), strength: f(null, 0.1) }), profile, NOW);
  assert.equal(missing.level, "unsure");
});

test("blurry label: plausible name at 0.7 + readability 0.4 is unsure, never a match", () => {
  const v = checkLabel(read({ product: f("Amlodipine Orion", 0.7), strength: f("5 mg", 0.85), readability: 0.4, guidance: "Move it closer to your face." }), profile, NOW);
  assert.equal(v.level, "unsure");
  assert.match(v.speech, /might be Amlodipine/);
  assert.match(v.speech, /Move it closer/);
});

test("warning: wrong strength", () => {
  const v = checkLabel(read({ ingredient: f("amlodipine"), strength: f("10 mg") }), profile, NOW);
  assert.equal(v.level, "warning");
  assert.match(v.speech, /your list says 5 mg/);
});

test("warning: ibuprofen not on list + NSAID avoid (brand Burana)", () => {
  const v = checkLabel(read({ product: f("Burana 400 mg"), strength: f("400 mg") }), profile, NOW);
  assert.equal(v.level, "warning");
  assert.match(v.speech, /Ibuprofen 400 mg|Burana 400 mg/);
  assert.match(v.speech, /avoid NSAIDs/);
  assert.ok(v.reasons.some((r) => r.includes("NSAID")));
});

test("aspirin / naproxen / diclofenac are NSAIDs", () => {
  for (const ing of ["acetylsalicylic acid", "naproxen", "diclofenac"]) {
    const v = checkLabel(read({ ingredient: f(ing), strength: f("100 mg") }), profile, NOW);
    assert.equal(v.level, "warning", ing);
    assert.ok(v.reasons.some((r) => r.includes("NSAID")), ing);
  }
});

test("already taken today (dose log)", () => {
  const p = { ...profile, doseLog: [{ medId: "aml", ts: new Date(2026, 10, 14, 19, 0).getTime() }] };
  const v = checkLabel(read({ ingredient: f("amlodipine"), strength: f("5 mg") }), p, NOW);
  assert.equal(v.takenToday, true);
  assert.equal(v.level, "warning");
  assert.match(v.speech, /already took it today/);
  const y = { ...profile, doseLog: [{ medId: "aml", ts: new Date(2026, 10, 13, 19, 0).getTime() }] };
  assert.equal(checkLabel(read({ ingredient: f("amlodipine"), strength: f("5 mg") }), y, NOW).level, "match");
});

test("twice-daily med: 1 of 2 doses is still a match", () => {
  const p = { ...profile, doseLog: [{ medId: "met", ts: new Date(2026, 10, 14, 8, 5).getTime() }] };
  const v = checkLabel(read({ ingredient: f("metformin"), strength: f("500mg") }), p, NOW);
  assert.equal(v.level, "match");
  assert.match(v.speech, /1 of 2 doses/);
});

test("allergens: arachis oil = peanut, hazelnut = tree nuts, may-contain", () => {
  const a = checkLabel(read({ kind: "food", product: f("Chocolate spread"), allergens: f(["arachis oil"]) }), profile, NOW);
  assert.equal(a.level, "warning");
  assert.match(a.speech, /arachis oil/);
  const b = checkLabel(read({ kind: "food", product: f("Oat bar"), allergens: f(["oats", "may contain: hazelnut"]) }), profile, NOW);
  assert.equal(b.level, "warning");
  assert.match(b.headline, /may contain hazelnut/);
  const c = checkLabel(read({ kind: "food", product: f("Oat drink"), allergens: f(["oats"]), expiry: f("2026-12-03") }), profile, NOW);
  assert.equal(c.level, "info");
  assert.match(c.speech, /Best before 3 December 2026/);
});

test("food with unreadable allergen panel is unsure, never 'safe'", () => {
  const v = checkLabel(read({ kind: "food", product: f("Cookies"), allergens: f<string[]>(null, 0.2) }), profile, NOW);
  assert.equal(v.level, "unsure");
});

test("unreadable label -> unsure with guidance", () => {
  const v = checkLabel(read({ kind: "unreadable", readability: 0.1, guidance: "Bring it a bit closer." }), profile, NOW);
  assert.equal(v.level, "unsure");
  assert.match(v.speech, /Bring it a bit closer/);
});

test("expired medicine is a warning", () => {
  assert.equal(isExpired("2026-10", NOW), true);
  assert.equal(isExpired("2026-11", NOW), false);
  const v = checkLabel(read({ ingredient: f("amlodipine"), strength: f("5 mg"), expiry: f("2025-08") }), profile, NOW);
  assert.equal(v.level, "warning");
  assert.match(v.speech, /expired in August 2025/);
});

test("limits: headline <= 8 words, speech <= 2 sentences, decimals don't split", () => {
  assert.equal(words(clampHeadline("one two three four five six seven eight nine ten")), 8);
  assert.equal(clampSpeech("This is 2.5 mg. Second one. Third one."), "This is 2.5 mg. Second one.");
});

test("toLabelRead coerces junk into a safe read", () => {
  const r = toLabelRead({ kind: "medication", strength: { value: "5 mg", confidence: 7 }, product: { value: 3, confidence: 0.9 } });
  assert.equal(r.strength.confidence, 1);
  assert.equal(r.product.value, null);
  assert.ok(r.product.confidence <= 0.3);
  assert.equal(toLabelRead("nonsense").kind, "unreadable");
});
