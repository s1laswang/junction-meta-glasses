import assert from "node:assert/strict";
import { test } from "node:test";
import type { LabelRead, Med, Profile, Verdict } from "../../shared/types.ts";
import { buildSceneVerdict, matchesSlot, schedWord, type RawItem } from "../src/find.ts";

const NOW = new Date(2026, 10, 14, 20, 0, 0);
const f = <T>(value: T | null, confidence = 0.96) => ({ value, confidence });

function mkRead(partial: Partial<LabelRead> = {}): LabelRead {
  return {
    kind: "medication",
    product: f(null, 0),
    ingredient: f(null, 0),
    strength: f(null, 0),
    dosing: f(null, 0),
    expiry: f("2027-08", 0.95),
    allergens: f<string[]>(null, 0),
    barcode: f(null, 0),
    readability: 0.93,
    ...partial,
  };
}

function mkMed(schedule: string[], overrides: Partial<Med> = {}): Med {
  return {
    id: "med-1",
    name: "Norvasc",
    ingredient: "amlodipine besilate",
    strength: "5 mg",
    schedule,
    ...overrides,
  };
}

const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const sentenceCount = (s: string) => s.trim().split(/(?<=[.!?])\s+/).filter(Boolean).length;

function assertSceneBounds(v: Verdict) {
  assert.equal(v.mode, "scene");
  assert.ok(wordCount(v.headline) <= 8, `headline exceeds 8 words: "${v.headline}"`);
  assert.ok(sentenceCount(v.speech) <= 2, `speech exceeds 2 sentences: "${v.speech}"`);
  assert.ok(Array.isArray(v.items));
  for (const item of v.items) {
    assert.ok(wordCount(item.headline) <= 6, `item headline exceeds 6 words: "${item.headline}"`);
  }
}

test("schedWord and matchesSlot support HH:MM, Nordic HH.MM, FI/SV words, multi-slot schedules, and noon/bedtime buckets", () => {
  const singleClockCases: Array<[string, string]> = [
    ["00:00", "morning"],
    ["07.30", "morning"],
    ["8:15", "morning"],
    ["10:59", "morning"],
    ["10.59", "morning"],
    ["11:00", "midday"],
    ["12.00", "midday"],
    ["14:59", "midday"],
    ["14.59", "midday"],
    ["15:00", "evening"],
    ["19.30", "evening"],
    ["20:00", "evening"],
    ["20.59", "evening"],
    ["21:00", "night"],
    ["21.00", "night"],
    ["23:59", "night"],
    ["23.59", "night"],
  ];

  for (const [slot, expected] of singleClockCases) {
    const med = mkMed([slot]);
    assert.equal(schedWord(med), expected, `schedWord failed for [${slot}]`);
    assert.equal(matchesSlot(med, expected), true, `matchesSlot failed for [${slot}] -> ${expected}`);
  }

  for (const invalid of ["24:00", "12:60", "as needed"]) {
    assert.equal(schedWord(mkMed([invalid])), undefined);
  }
  assert.equal(schedWord(mkMed([])), undefined);

  const nordicSingleCases: Array<[string, string]> = [
    ["aamu", "morning"],
    ["aamulla", "morning"],
    ["morgon", "morning"],
    ["keskipäivä", "midday"],
    ["lounas", "midday"],
    ["mitt på dagen", "midday"],
    ["lunch", "midday"],
    ["ilta", "evening"],
    ["illalla", "evening"],
    ["kväll", "evening"],
    ["yö", "night"],
    ["yöllä", "night"],
    ["nukkumaan", "night"],
    ["natt", "night"],
    ["läggdags", "night"],
  ];

  for (const [word, expected] of nordicSingleCases) {
    const med = mkMed([word]);
    assert.equal(schedWord(med), expected, `schedWord failed for Nordic [${word}]`);
    assert.equal(matchesSlot(med, expected), true, `matchesSlot failed for Nordic [${word}]`);
  }

  assert.equal(schedWord(mkMed(["middag"])), undefined);
  assert.equal(matchesSlot(mkMed(["middag"]), "midday"), false);

  for (const multi of [
    ["08:00", "20:00"],
    ["08.00", "20.00"],
    ["07.30", "19.30"],
    ["aamu", "ilta"],
    ["morgon", "kväll"],
  ]) {
    const med = mkMed(multi);
    assert.equal(schedWord(med), undefined, `multi-slot ${JSON.stringify(multi)} should not force single schedWord`);
    assert.equal(matchesSlot(med, "morning"), true, `expected morning match for ${JSON.stringify(multi)}`);
    assert.equal(matchesSlot(med, "evening"), true, `expected evening match for ${JSON.stringify(multi)}`);
    assert.equal(matchesSlot(med, "midday"), false);
    assert.equal(matchesSlot(med, "noon"), false);
    assert.equal(matchesSlot(med, "night"), false);
    assert.equal(matchesSlot(med, "bedtime"), false);
  }

  const middayClock = mkMed(["08:00", "12:30"]);
  assert.equal(matchesSlot(middayClock, "noon"), true);
  assert.equal(matchesSlot(middayClock, "midday"), true);
  assert.equal(matchesSlot(mkMed(["noon"]), "midday"), true);
  assert.equal(matchesSlot(mkMed(["lounas"]), "noon"), true);

  const nightClock = mkMed(["08.00", "22.15"]);
  assert.equal(matchesSlot(nightClock, "night"), true);
  assert.equal(matchesSlot(nightClock, "bedtime"), true);
  assert.equal(matchesSlot(mkMed(["bedtime"]), "night"), true);
  assert.equal(matchesSlot(mkMed(["läggdags"]), "bedtime"), true);
});

test("buildSceneVerdict matches single and multi-slot HH:MM and HH.MM clock schedules", () => {
  const singleClockProfile: Profile = {
    meds: [
      { id: "aml", name: "Norvasc", ingredient: "amlodipine besilate", strength: "5 mg", schedule: ["20:00"] },
      { id: "levo", name: "Thyroxin", ingredient: "levothyroxine sodium", strength: "100 mcg", schedule: ["07.30"] },
    ],
    allergies: [],
    avoid: ["NSAIDs"],
    doseLog: [],
    lang: "en",
  };

  const sceneThree: RawItem[] = [
    { box: [250, 700, 700, 900], read: mkRead({ ingredient: f("amlodipine"), strength: f("5 mg") }), answers: false },
    { box: [250, 100, 700, 300], read: mkRead({ ingredient: f("levothyroxine"), strength: f("100 mcg") }), answers: false },
    { box: [250, 400, 700, 600], read: mkRead({ ingredient: f("ibuprofen"), strength: f("400 mg") }), answers: false },
  ];

  const vEve = buildSceneVerdict(sceneThree, singleClockProfile, "which one is my evening pill?", NOW);
  assertSceneBounds(vEve);
  assert.equal(vEve.level, "match");
  assert.equal(vEve.matchedMedId, "aml");
  assert.equal(vEve.headline, "Evening pill: box on the right");
  assert.equal(vEve.speech, "Your evening pill is the box on the right. The middle one is Ibuprofen 400 mg, not on your list.");
  assert.equal(vEve.items!.find((i) => i.position === "right")!.headline, "Amlodipine 5 mg: evening pill");
  assert.equal(vEve.items!.find((i) => i.position === "left")!.headline, "Levothyroxine 100 mcg: morning pill");

  const vMorn = buildSceneVerdict(sceneThree, singleClockProfile, "which one is my morning pill?", NOW);
  assertSceneBounds(vMorn);
  assert.equal(vMorn.level, "match");
  assert.equal(vMorn.matchedMedId, "levo");
  assert.equal(vMorn.headline, "Morning pill: box on the left");
  assert.match(vMorn.speech, /^Your morning pill is the box on the left\./);

  const vUntargeted = buildSceneVerdict([sceneThree[0], sceneThree[2]], singleClockProfile, undefined, NOW);
  assertSceneBounds(vUntargeted);
  assert.equal(vUntargeted.level, "info");
  assert.match(vUntargeted.speech, /Your evening pill is the box on the right\.$/);

  for (const multiSched of [["08:00", "20:00"], ["07.30", "19.30"], ["08.00", "20.00"]]) {
    const multiProfile: Profile = {
      meds: [
        { id: "met", name: "Metforem", ingredient: "metformin hydrochloride", strength: "500 mg", schedule: multiSched },
        { id: "zop", name: "Imovane", ingredient: "zopiclone", strength: "7.5 mg", schedule: ["22:30"] },
      ],
      allergies: [],
      avoid: [],
      doseLog: [{ medId: "met", ts: new Date(2026, 10, 14, 8, 5, 0).getTime() }],
      lang: "fi",
    };
    const items: RawItem[] = [
      { box: [200, 120, 700, 320], read: mkRead({ ingredient: f("metformin"), strength: f("500 mg") }), answers: false },
      { box: [200, 680, 700, 880], read: mkRead({ ingredient: f("zopiclone"), strength: f("7.5 mg") }), answers: false },
    ];

    const morningRes = buildSceneVerdict(items, multiProfile, "which one is my morning pill?", NOW);
    assertSceneBounds(morningRes);
    assert.equal(morningRes.level, "match");
    assert.equal(morningRes.matchedMedId, "met");
    assert.equal(morningRes.items![0].headline, "Metformin 500 mg: on list");
    assert.equal(morningRes.speech, "Your morning pill is the box on the left.");

    const eveningRes = buildSceneVerdict(items, multiProfile, "which one is my evening pill?", NOW);
    assertSceneBounds(eveningRes);
    assert.equal(eveningRes.level, "match");
    assert.equal(eveningRes.matchedMedId, "met");
    assert.equal(eveningRes.speech, "Your evening pill is the box on the left.");

    const bedtimeRes = buildSceneVerdict(items, multiProfile, "which one is my bedtime pill?", NOW);
    assertSceneBounds(bedtimeRes);
    assert.equal(bedtimeRes.level, "match");
    assert.equal(bedtimeRes.matchedMedId, "zop");
    assert.equal(bedtimeRes.speech, "Your bedtime pill is the box on the right.");

    const middayMiss = buildSceneVerdict(items, multiProfile, "which one is my noon pill?", NOW);
    assertSceneBounds(middayMiss);
    assert.notEqual(middayMiss.level, "match");
    assert.match(middayMiss.speech, /^I can't see your noon pill here\./);
  }
});

test("buildSceneVerdict resolves Finnish and Swedish schedule targets and rejects Swedish middag as midday", () => {
  const fourSlotProfile: Profile = {
    meds: [
      { id: "morn", name: "Thyroxin", ingredient: "levothyroxine", strength: "100 mcg", schedule: ["07.30"] },
      { id: "mid", name: "Calcichew", ingredient: "calcium", strength: "500 mg", schedule: ["12:30"] },
      { id: "eve", name: "Norvasc", ingredient: "amlodipine", strength: "5 mg", schedule: ["20:00"] },
      { id: "nite", name: "Zopinox", ingredient: "zopiclone", strength: "7.5 mg", schedule: ["22.00"] },
    ],
    allergies: [],
    avoid: [],
    doseLog: [],
    lang: "fi",
  };

  const fourBoxes: RawItem[] = [
    { box: [200, 40, 700, 180], read: mkRead({ ingredient: f("levothyroxine"), strength: f("100 mcg") }), answers: false },
    { box: [200, 280, 700, 420], read: mkRead({ ingredient: f("calcium"), strength: f("500 mg") }), answers: false },
    { box: [200, 560, 700, 700], read: mkRead({ ingredient: f("amlodipine"), strength: f("5 mg") }), answers: false },
    { box: [200, 800, 700, 940], read: mkRead({ ingredient: f("zopiclone"), strength: f("7.5 mg") }), answers: false },
  ];

  const queryCases: Array<{ q: string; expectedId: string; expectedSlot: string; expectedPosPhrase: string }> = [
    { q: "Mikä näistä on iltalääkkeeni?", expectedId: "eve", expectedSlot: "evening", expectedPosPhrase: "on the right" },
    { q: "ilta", expectedId: "eve", expectedSlot: "evening", expectedPosPhrase: "on the right" },
    { q: "mikä otetaan illalla?", expectedId: "eve", expectedSlot: "evening", expectedPosPhrase: "on the right" },
    { q: "iltalääke", expectedId: "eve", expectedSlot: "evening", expectedPosPhrase: "on the right" },
    { q: "iltapilleri", expectedId: "eve", expectedSlot: "evening", expectedPosPhrase: "on the right" },
    { q: "aamupilleri", expectedId: "morn", expectedSlot: "morning", expectedPosPhrase: "on the far left" },
    { q: "aamu", expectedId: "morn", expectedSlot: "morning", expectedPosPhrase: "on the far left" },
    { q: "mikä otetaan aamulla?", expectedId: "morn", expectedSlot: "morning", expectedPosPhrase: "on the far left" },
    { q: "mikä on aamulääkkeeni?", expectedId: "morn", expectedSlot: "morning", expectedPosPhrase: "on the far left" },
    { q: "keskipäivä", expectedId: "mid", expectedSlot: "midday", expectedPosPhrase: "on the left" },
    { q: "mikä on lounaslääkkeeni?", expectedId: "mid", expectedSlot: "midday", expectedPosPhrase: "on the left" },
    { q: "lounas", expectedId: "mid", expectedSlot: "midday", expectedPosPhrase: "on the left" },
    { q: "yö", expectedId: "nite", expectedSlot: "night", expectedPosPhrase: "on the far right" },
    { q: "mikä otetaan yöllä?", expectedId: "nite", expectedSlot: "night", expectedPosPhrase: "on the far right" },
    { q: "yölääke", expectedId: "nite", expectedSlot: "night", expectedPosPhrase: "on the far right" },
    { q: "mikä otetaan nukkumaan mennessä?", expectedId: "nite", expectedSlot: "night", expectedPosPhrase: "on the far right" },
    { q: "vilken är min kvällsmedicin?", expectedId: "eve", expectedSlot: "evening", expectedPosPhrase: "on the right" },
    { q: "kväll", expectedId: "eve", expectedSlot: "evening", expectedPosPhrase: "on the right" },
    { q: "vilken tar jag på kvällen?", expectedId: "eve", expectedSlot: "evening", expectedPosPhrase: "on the right" },
    { q: "kvällspiller", expectedId: "eve", expectedSlot: "evening", expectedPosPhrase: "on the right" },
    { q: "morgonpiller", expectedId: "morn", expectedSlot: "morning", expectedPosPhrase: "on the far left" },
    { q: "morgon", expectedId: "morn", expectedSlot: "morning", expectedPosPhrase: "on the far left" },
    { q: "på morgonen", expectedId: "morn", expectedSlot: "morning", expectedPosPhrase: "on the far left" },
    { q: "morgonmedicin", expectedId: "morn", expectedSlot: "morning", expectedPosPhrase: "on the far left" },
    { q: "mitt på dagen", expectedId: "mid", expectedSlot: "midday", expectedPosPhrase: "on the left" },
    { q: "vilken tar jag till lunch?", expectedId: "mid", expectedSlot: "midday", expectedPosPhrase: "on the left" },
    { q: "på natten", expectedId: "nite", expectedSlot: "night", expectedPosPhrase: "on the far right" },
    { q: "natt", expectedId: "nite", expectedSlot: "night", expectedPosPhrase: "on the far right" },
    { q: "vid läggdags", expectedId: "nite", expectedSlot: "night", expectedPosPhrase: "on the far right" },
  ];

  for (const c of queryCases) {
    const v = buildSceneVerdict(fourBoxes, fourSlotProfile, c.q, NOW);
    assertSceneBounds(v);
    assert.equal(v.level, "match", `failed match for query "${c.q}"`);
    assert.equal(v.matchedMedId, c.expectedId, `wrong med for query "${c.q}"`);
    assert.equal(v.speech, `Your ${c.expectedSlot} pill is the box ${c.expectedPosPhrase}.`);
  }

  const svDinnerCheck = buildSceneVerdict([fourBoxes[0], fourBoxes[1]], fourSlotProfile, "vilken tar jag till middag?", NOW);
  assertSceneBounds(svDinnerCheck);
  assert.equal(svDinnerCheck.speech.includes("midday pill"), false);
  assert.equal(svDinnerCheck.matchedMedId, "morn");

  const nordicMultiProfile: Profile = {
    meds: [
      { id: "fi-bi", name: "Metforem", ingredient: "metformin", strength: "500 mg", schedule: ["aamu", "ilta"] },
      { id: "sv-eve", name: "Simvastatin", ingredient: "simvastatin", strength: "20 mg", schedule: ["kväll"] },
    ],
    allergies: [],
    avoid: [],
    doseLog: [],
    lang: "fi",
  };
  const twoNordicBoxes: RawItem[] = [
    { box: [200, 100, 700, 300], read: mkRead({ ingredient: f("metformin"), strength: f("500 mg") }), answers: false },
    { box: [200, 700, 700, 900], read: mkRead({ ingredient: f("simvastatin"), strength: f("20 mg") }), answers: false },
  ];
  const fiMorning = buildSceneVerdict(twoNordicBoxes, nordicMultiProfile, "aamupilleri", NOW);
  assertSceneBounds(fiMorning);
  assert.equal(fiMorning.level, "match");
  assert.equal(fiMorning.matchedMedId, "fi-bi");
  assert.equal(fiMorning.items![1].headline, "Simvastatin 20 mg: evening pill");
});

test("buildSceneVerdict detects Finnish and Swedish allergen-free food queries while preserving !sw schedule priority", () => {
  const allergyProfile: Profile = {
    meds: [
      { id: "aml", name: "Norvasc", ingredient: "amlodipine", strength: "5 mg", schedule: ["20:00"] },
    ],
    allergies: ["peanut", "tree nuts", "gluten", "milk", "egg", "soy"],
    avoid: [],
    doseLog: [],
    lang: "fi",
  };

  const unsafeBar: RawItem = {
    box: [100, 80, 600, 320],
    read: mkRead({ kind: "food", product: f("Hasselpähkinäpatukka"), allergens: f(["hasselpahkina", "maito"], 0.97), readability: 0.92 }),
    answers: false,
  };
  const safeCrackers: RawItem = {
    box: [100, 660, 600, 900],
    read: mkRead({ kind: "food", product: f("Riisikakut"), allergens: f(["riisi"], 0.98), readability: 0.94 }),
    answers: true,
  };

  const foodQueries = [
    "mikä on ilman pähkinää?",
    "mikä näistä on turvallinen?",
    "pähkinätön",
    "maapähkinätön",
    "gluteeniton",
    "laktoositon",
    "maidoton",
    "munaton",
    "soijaton",
    "vilken är utan nötter?",
    "vilken är säker för mig?",
    "nötfri",
    "nötfritt",
    "nötfria",
    "jordnötsfri",
    "glutenfri",
    "laktosfri",
    "mjölkfri",
    "äggfri",
    "sojafri",
  ];

  for (const q of foodQueries) {
    const v = buildSceneVerdict([unsafeBar, safeCrackers], allergyProfile, q, NOW);
    assertSceneBounds(v);
    assert.equal(v.level, "info", `expected safe food info for "${q}"`);
    assert.equal(v.headline, "Right one: none of your allergens");
    assert.equal(
      v.speech,
      "The pack on the right, Riisikakut, lists none of your allergens. The left one contains hasselpahkina and maito.",
    );
  }

  const vNoneSafe = buildSceneVerdict([unsafeBar], allergyProfile, "mikä on ilman pähkinää?", NOW);
  assertSceneBounds(vNoneSafe);
  assert.equal(vNoneSafe.level, "warning");
  assert.equal(vNoneSafe.headline, "None clearly free of your allergens");

  const lowConfFood: RawItem = {
    box: [100, 660, 600, 900],
    read: mkRead({ kind: "food", product: f("Kaurakeksi"), allergens: f(["kaura"], 0.85), readability: 0.9 }),
    answers: true,
  };
  const vUnsureFood = buildSceneVerdict([lowConfFood], allergyProfile, "vilken är utan nötter?", NOW);
  assertSceneBounds(vUnsureFood);
  assert.equal(vUnsureFood.level, "unsure");
  assert.equal(vUnsureFood.headline, "None clearly free of your allergens");

  const amlBox: RawItem = {
    box: [100, 660, 600, 900],
    read: mkRead({ ingredient: f("amlodipine"), strength: f("5 mg"), allergens: f([], 0.96) }),
    answers: true,
  };
  for (const medPlusFree of ["mikä iltalääke on laktoositon?", "vilken kvällsmedicin är laktosfri?"]) {
    const vMed = buildSceneVerdict([unsafeBar, amlBox], allergyProfile, medPlusFree, NOW);
    assertSceneBounds(vMed);
    assert.equal(vMed.level, "match");
    assert.equal(vMed.matchedMedId, "aml");
    assert.match(vMed.speech, /^Your evening pill is the box on the right\./);
  }

  const svThingsNotSafe = buildSceneVerdict([unsafeBar, amlBox], allergyProfile, "vilka saker finns här?", NOW);
  assertSceneBounds(svThingsNotSafe);
  assert.equal(svThingsNotSafe.level, "match");
  assert.equal(svThingsNotSafe.matchedMedId, "aml");
});
