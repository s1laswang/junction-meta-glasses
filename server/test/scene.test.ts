import { test } from "node:test";
import assert from "node:assert/strict";
import type { LabelRead, Profile } from "../../shared/types.ts";
import { assignPositions, buildSceneVerdict, type RawItem } from "../src/find.ts";

const NOW = new Date(2026, 10, 14, 20, 0);
const f = <T>(value: T | null, confidence = 0.95) => ({ value, confidence });
const read = (p: Partial<LabelRead>): LabelRead => ({
  kind: "medication", product: f(null, 0), ingredient: f(null, 0), strength: f(null, 0), dosing: f(null, 0),
  expiry: f("2027-08"), allergens: f<string[]>(null, 0), barcode: f(null, 0), readability: 0.9, ...p,
});
const profile: Profile = {
  meds: [
    { id: "aml", name: "Amlodipine", ingredient: "amlodipine besilate", strength: "5 mg", schedule: ["evening"] },
    { id: "par", name: "Panadol", ingredient: "paracetamol", strength: "500 mg", schedule: ["as needed"] },
  ],
  allergies: ["peanut", "tree nuts"], avoid: ["NSAIDs"], doseLog: [], lang: "en",
};
// boxes given out of order on purpose; x centres: amlodipine 800, paracetamol 200, ibuprofen 500
const three: RawItem[] = [
  { box: [300, 700, 700, 900], read: read({ ingredient: f("amlodipine"), strength: f("5 mg") }), answers: true },
  { box: [300, 100, 700, 300], read: read({ ingredient: f("paracetamol"), strength: f("500 mg") }), answers: false },
  { box: [300, 400, 700, 600], read: read({ ingredient: f("ibuprofen"), strength: f("400 mg") }), answers: false },
];
const sentences = (s: string) => s.trim().split(/(?<=[.!?])\s+/).length;

test("positions: left-to-right ranks for 2-5 items, absolute bins otherwise", () => {
  assert.deepEqual(assignPositions(three).map((i) => i.position), ["left", "center", "right"]);
  assert.deepEqual(assignPositions([three[0]]).map((i) => i.position), ["right"].map(() => "far_right")); // x=800 -> bin 4
  assert.deepEqual(assignPositions(three.slice(0, 2)).map((i) => i.position), ["left", "right"]);
});

test("'which one is my evening pill' -> match, right box, warns about the NSAID in the middle", () => {
  const v = buildSceneVerdict(three, profile, "which one is my evening pill?", NOW);
  assert.equal(v.mode, "scene");
  assert.equal(v.level, "match");
  assert.equal(v.matchedMedId, "aml");
  assert.equal(v.speech, "Your evening pill is the box on the right. The middle one is Ibuprofen 400 mg, not on your list.");
  assert.deepEqual(v.items!.map((i) => [i.position, i.level]), [["left", "match"], ["center", "warning"], ["right", "match"]]);
  assert.ok(v.items!.every((i) => i.headline.split(/\s+/).length <= 6));
  assert.ok(sentences(v.speech) <= 2);
});

test("scene never says match when the held-item check would not (strength unclear) -> 'I think'", () => {
  const blurry = three.map((it, i) => (i === 0 ? { ...it, read: read({ ingredient: f("amlodipine"), strength: f("5 mg", 0.5) }) } : it));
  const v = buildSceneVerdict(blurry, profile, "which one is my evening pill", NOW);
  assert.equal(v.level, "unsure");
  assert.equal(v.matchedMedId, undefined);
  assert.equal(v.speech, "I think it's the one on the right. Pick it up so I can check the label.");
  assert.equal(v.items!.find((i) => i.position === "right")!.level, "unsure");
});

test("model hint alone (no confident match) is only a guess", () => {
  const unread: RawItem[] = three.map((it) => ({ ...it, read: read({ kind: "unreadable", readability: 0.1, expiry: f<string>(null, 0) }) }));
  const v = buildSceneVerdict(unread, profile, "my evening pill", NOW);
  assert.equal(v.level, "unsure");
  assert.match(v.speech, /^I think it's the one on the right\./);
});

test("target not present -> says so and lists what it sees", () => {
  const v = buildSceneVerdict([three[1], three[2]], profile, "which is my evening pill", NOW);
  assert.match(v.speech, /^I can't see your evening pill here\. I see Paracetamol 500 mg on the left and Ibuprofen 400 mg on the right\.$/);
  assert.notEqual(v.level, "match");
});

test("no target -> describes the packages", () => {
  const v = buildSceneVerdict(three, profile, undefined, NOW);
  assert.equal(v.level, "info");
  assert.match(v.speech, /^I see 3 packages: Paracetamol 500 mg on the left, Ibuprofen 400 mg in the middle and Amlodipine 5 mg on the right\./);
});

test("food: 'which one has no nuts'", () => {
  const food: RawItem[] = [
    { box: [0, 50, 500, 250], read: read({ kind: "food", product: f("Hazelnut bar"), allergens: f(["hazelnut", "milk"]) }), answers: false },
    { box: [0, 650, 500, 950], read: read({ kind: "food", product: f("Oat biscuits"), allergens: f(["oats", "wheat"]) }), answers: true },
  ];
  const v = buildSceneVerdict(food, profile, "which one has no nuts?", NOW);
  assert.equal(v.level, "info");
  assert.equal(v.speech, "The pack on the right, Oat biscuits, lists none of your allergens. The left one contains hazelnut.");
});
