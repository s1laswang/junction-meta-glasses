import type { DemoScenarioId, Profile } from "../src/types.ts";
import {
  detectBarcodeFromElement,
  isBarcodeDetectorSupported,
  normalizeBarcode,
  offlineBarcodeVerdict
} from "../src/camera/barcode.ts";
import { DEMO_SCENARIOS, getDemoScenario } from "../src/camera/demoScenarios.ts";

type TestFn = (name: string, fn: () => void | Promise<void>) => unknown;
type AssertStrict = {
  ok(value: unknown, message?: string): void;
  equal<T>(actual: T, expected: T, message?: string): void;
  deepEqual<T>(actual: T, expected: T, message?: string): void;
  match(value: string, regexp: RegExp, message?: string): void;
};

const getBuiltin = (globalThis as any).process.getBuiltinModule as (id: string) => any;
const { test } = getBuiltin("node:test") as { test: TestFn };
const assert = getBuiltin("node:assert/strict") as AssertStrict;

const NOW = new Date(2026, 10, 14, 20, 0, 0);

const baseProfile: Profile = {
  meds: [
    {
      id: "aml",
      name: "Norvasc",
      ingredient: "amlodipine",
      strength: "5mg",
      schedule: ["evening"],
      barcode: "6432100012345"
    },
    {
      id: "met",
      name: "Metformin",
      ingredient: "metformin",
      strength: "500 mg",
      schedule: ["08:00", "20:00"],
      barcode: "6432100054321"
    },
    {
      id: "vitd",
      name: "Vitamin D",
      ingredient: "colecalciferol",
      strength: "20 mcg",
      schedule: ["morning"]
    }
  ],
  allergies: ["peanut", "tree nuts"],
  avoid: ["NSAIDs"],
  doseLog: [],
  lang: "en"
};

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function sentenceCount(text: string): number {
  return text.trim().split(/(?<=[.!?])\s+/).filter(Boolean).length;
}

test("normalizeBarcode strips formatting and normalizes UPC-A vs EAN-13", () => {
  assert.equal(normalizeBarcode(null), "");
  assert.equal(normalizeBarcode(undefined), "");
  assert.equal(normalizeBarcode("   "), "");
  assert.equal(normalizeBarcode("6432 1000-12345"), "6432100012345");
  assert.equal(normalizeBarcode("6412-3456"), "64123456");
  assert.equal(normalizeBarcode("123456789012"), normalizeBarcode("0123456789012"));
  assert.equal(normalizeBarcode("036000-291452"), normalizeBarcode("0036000291452"));
});

test("BarcodeDetector wrapper handles unsupported, detected, empty, and throwing states", async () => {
  const original = (globalThis as any).BarcodeDetector;
  const fakeVideo = {} as HTMLVideoElement;

  try {
    delete (globalThis as any).BarcodeDetector;
    assert.equal(isBarcodeDetectorSupported(), false);
    assert.equal(await detectBarcodeFromElement(fakeVideo), null);

    let passedFormats: string[] = [];
    (globalThis as any).BarcodeDetector = class {
      constructor(opts?: { formats?: string[] }) {
        passedFormats = opts?.formats ?? [];
      }
      async detect() {
        return [{ rawValue: " 6432-1000 12345 " }];
      }
    };

    assert.equal(isBarcodeDetectorSupported(), true);
    assert.equal(await detectBarcodeFromElement(fakeVideo), "6432100012345");
    assert.deepEqual(passedFormats, ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "qr_code"]);

    (globalThis as any).BarcodeDetector = class {
      async detect() {
        return [];
      }
    };
    assert.equal(await detectBarcodeFromElement(fakeVideo), null);

    (globalThis as any).BarcodeDetector = class {
      async detect() {
        throw new Error("Video frame unavailable");
      }
    };
    assert.equal(await detectBarcodeFromElement(fakeVideo), null);
  } finally {
    if (original === undefined) {
      delete (globalThis as any).BarcodeDetector;
    } else {
      (globalThis as any).BarcodeDetector = original;
    }
  }
});

test("offlineBarcodeVerdict returns match for saved evening pill not taken today", () => {
  const yesterday = new Date(2026, 10, 13, 21, 0, 0).getTime();
  const profileWithYesterdayDose: Profile = {
    ...baseProfile,
    doseLog: [{ medId: "aml", ts: yesterday }]
  };

  const verdict = offlineBarcodeVerdict("6432 1000-12345", profileWithYesterdayDose, NOW);

  assert.equal(verdict.level, "match");
  assert.equal(verdict.matchedMedId, "aml");
  assert.equal(verdict.takenToday, false);
  assert.deepEqual(verdict.read.barcode, { value: "6432100012345", confidence: 0.99 });
  assert.equal(verdict.read.product.value, "Norvasc");
  assert.equal(verdict.read.ingredient.value, "amlodipine");
  assert.equal(verdict.read.strength.value, "5 mg");
  assert.match(verdict.speech, /offline barcode match/i);
  assert.match(verdict.speech, /haven't taken it today/i);
  assert.ok(wordCount(verdict.headline) <= 8);
  assert.ok(sentenceCount(verdict.speech) <= 2);
});

test("offlineBarcodeVerdict returns warning when saved pill was already taken today", () => {
  const todayEvening = new Date(2026, 10, 14, 19, 15, 0).getTime();
  const profileTaken: Profile = {
    ...baseProfile,
    doseLog: [{ medId: "aml", ts: todayEvening }]
  };

  const verdict = offlineBarcodeVerdict("6432100012345", profileTaken, NOW);

  assert.equal(verdict.level, "warning");
  assert.equal(verdict.matchedMedId, "aml");
  assert.equal(verdict.takenToday, true);
  assert.match(verdict.speech, /offline barcode match/i);
  assert.match(verdict.speech, /already took/i);
  assert.ok(wordCount(verdict.headline) <= 8);
  assert.ok(sentenceCount(verdict.speech) <= 2);
});

test("offlineBarcodeVerdict handles multi-dose schedule and avoid list warnings", () => {
  const morningDose = new Date(2026, 10, 14, 8, 10, 0).getTime();
  const eveningDose = new Date(2026, 10, 14, 19, 45, 0).getTime();

  const oneOfTwo = offlineBarcodeVerdict(
    "6432100054321",
    { ...baseProfile, doseLog: [{ medId: "met", ts: morningDose }] },
    NOW
  );
  assert.equal(oneOfTwo.level, "match");
  assert.equal(oneOfTwo.takenToday, true);
  assert.match(oneOfTwo.speech, /1 of 2 doses today/i);
  assert.ok(wordCount(oneOfTwo.headline) <= 8);
  assert.ok(sentenceCount(oneOfTwo.speech) <= 2);

  const twoOfTwo = offlineBarcodeVerdict(
    "6432100054321",
    {
      ...baseProfile,
      doseLog: [
        { medId: "met", ts: morningDose },
        { medId: "met", ts: eveningDose }
      ]
    },
    NOW
  );
  assert.equal(twoOfTwo.level, "warning");
  assert.equal(twoOfTwo.takenToday, true);
  assert.ok(wordCount(twoOfTwo.headline) <= 8);
  assert.ok(sentenceCount(twoOfTwo.speech) <= 2);

  const avoidProfile: Profile = {
    ...baseProfile,
    avoid: ["amlodipine"]
  };
  const avoidVerdict = offlineBarcodeVerdict("6432100012345", avoidProfile, NOW);
  assert.equal(avoidVerdict.level, "warning");
  assert.equal(avoidVerdict.matchedMedId, "aml");
  assert.match(avoidVerdict.speech, /avoid list/i);
  assert.ok(wordCount(avoidVerdict.headline) <= 8);
  assert.ok(sentenceCount(avoidVerdict.speech) <= 2);
});

test("offlineBarcodeVerdict returns honest unsure verdict for unknown or empty barcode", () => {
  const unknown = offlineBarcodeVerdict("6412345000400", baseProfile, NOW);
  assert.equal(unknown.level, "unsure");
  assert.equal(unknown.headline, "Offline: unknown barcode");
  assert.equal(
    unknown.speech,
    "You are offline and this barcode is not in your saved medications. Reconnect to read new labels, or ask a pharmacist."
  );
  assert.equal(unknown.matchedMedId, undefined);
  assert.deepEqual(unknown.read.barcode, { value: "6412345000400", confidence: 0.99 });
  assert.ok(wordCount(unknown.headline) <= 8);
  assert.ok(sentenceCount(unknown.speech) <= 2);

  const empty = offlineBarcodeVerdict("", baseProfile, NOW);
  assert.equal(empty.level, "unsure");
  assert.equal(empty.matchedMedId, undefined);
});

test("DEMO_SCENARIOS covers all 7 DemoScenarioId entries with expected fixtures, barcodes, and questions", () => {
  const expected: Array<{
    id: DemoScenarioId;
    fixtureUrl: string;
    barcode: string;
    question: string;
  }> = [
    {
      id: "amlodipine_match",
      fixtureUrl: "/fixtures/amlodipine.jpg",
      barcode: "6432100012345",
      question: "Is this my evening pill?"
    },
    {
      id: "ibuprofen_nsaid",
      fixtureUrl: "/fixtures/ibuprofen.jpg",
      barcode: "6412345000400",
      question: "Can I take this for a headache?"
    },
    {
      id: "blurry_strength",
      fixtureUrl: "/fixtures/blurry_amlodipine.jpg",
      barcode: "6432100012345",
      question: "What strength is this pill?"
    },
    {
      id: "hazelnut_allergy",
      fixtureUrl: "/fixtures/hazelnut_bar.jpg",
      barcode: "7310100555111",
      question: "Does this contain nuts?"
    },
    {
      id: "oat_milk_safe",
      fixtureUrl: "/fixtures/oat_milk.jpg",
      barcode: "7394376616228",
      question: "Is this safe with my allergies?"
    },
    {
      id: "expired_med",
      fixtureUrl: "/fixtures/expired_metformin.jpg",
      barcode: "6432100054321",
      question: "Is this metformin still in date?"
    },
    {
      id: "back_of_box",
      fixtureUrl: "/fixtures/back_of_box.jpg",
      barcode: "6432100012345",
      question: "Is this my evening pill?"
    }
  ];

  assert.equal(DEMO_SCENARIOS.length, 7);
  for (const exp of expected) {
    const scenario = getDemoScenario(exp.id);
    assert.equal(scenario.id, exp.id);
    assert.equal(scenario.fixtureUrl, exp.fixtureUrl);
    assert.equal(scenario.barcode, exp.barcode);
    assert.equal(scenario.question, exp.question);
    assert.ok(scenario.title.length > 0);
    assert.ok(scenario.subtitle.length > 0);
  }
});
