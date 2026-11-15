import { test } from "node:test";
import assert from "node:assert/strict";
import type { Gs1Code, LabelRead, Profile } from "../../shared/types.ts";
import { parseGs1 } from "../src/gs1.ts";
import { checkLabel, checkLabelText, isExpired, monthYear, sayDate } from "../src/safety.ts";

const f = <T>(value: T | null, confidence = 0.95) => ({ value, confidence });

function makeRead(partial: Partial<LabelRead> = {}): LabelRead {
  return {
    kind: "medication",
    product: f(null, 0),
    ingredient: f(null, 0),
    strength: f(null, 0),
    dosing: f(null, 0),
    expiry: f(null, 0),
    allergens: f<string[]>(null, 0),
    barcode: f(null, 0),
    readability: 0.92,
    ...partial,
  };
}

const AML_GTIN = "09501101530003";

const profile: Profile = {
  meds: [
    { id: "aml", name: "Amlodipine", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"], gtin: AML_GTIN },
  ],
  allergies: [],
  avoid: [],
  doseLog: [],
  lang: "en",
};

const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const sentenceCount = (s: string) => s.trim().split(/(?<=[.!?])\s+/).filter(Boolean).length;

test("checkLabel with GS1 DataMatrix expiry 2026-02-31 warns on 2026-03-01 and never overflows into March", () => {
  const marchFirst = new Date("2026-03-01T10:00:00");
  const explicitCode: Gs1Code = {
    raw: `(01)${AML_GTIN}(17)260231`,
    gtin: AML_GTIN,
    expiry: "2026-02-31",
  };
  const parsedCode = parseGs1(`(01)${AML_GTIN}(17)260231(10)BATCH1`)!;
  assert.equal(parsedCode.expiry, "2026-02-31");

  for (const dm of [explicitCode, parsedCode]) {
    for (const printedExpiry of [f<string>(null, 0.1), f("2026-02", 0.95), f("2026-02-31", 0.95)]) {
      const v = checkLabel(
        makeRead({ ingredient: f("amlodipine"), strength: f("5 mg"), expiry: printedExpiry }),
        profile,
        marchFirst,
        dm,
      );
      assert.equal(v.level, "warning");
      assert.notEqual(v.level, "match");
      assert.equal(v.headline, "Expired February 2026 (pack code)");
      assert.match(v.speech, /expired in February 2026/);
      assert.equal(v.matchedMedId, "aml");
      assert.ok(wordCount(v.headline) <= 8);
      assert.ok(sentenceCount(v.speech) <= 2);
    }
  }

  const stillFeb = checkLabel(
    makeRead({ ingredient: f("amlodipine"), strength: f("5 mg"), expiry: f("2026-02", 0.95) }),
    profile,
    new Date("2026-02-28T20:00:00"),
    explicitCode,
  );
  assert.equal(stillFeb.level, "match");

  const aprilCode = parseGs1(`(01)${AML_GTIN}(17)260431`)!;
  assert.equal(aprilCode.expiry, "2026-04-31");
  const mayFirst = checkLabel(
    makeRead({ ingredient: f("amlodipine"), strength: f("5 mg"), expiry: f<string>(null, 0.1) }),
    profile,
    new Date("2026-05-01T08:00:00"),
    aprilCode,
  );
  assert.equal(mayFirst.level, "warning");
  assert.equal(mayFirst.headline, "Expired April 2026 (pack code)");
});

test("isExpired clamps leap-year, non-leap-year, century, and 30-day month boundaries without rolling over", () => {
  for (const [iso, y] of [["2024-02-31", 2024], ["2028-02-31", 2028]] as const) {
    assert.equal(isExpired(iso, new Date(y, 1, 28, 23, 59, 59, 0)), false, iso);
    assert.equal(isExpired(iso, new Date(y, 1, 29, 23, 59, 59, 0)), false, iso);
    assert.equal(isExpired(iso, new Date(y, 1, 29, 23, 59, 59, 1)), true, iso);
    assert.equal(isExpired(iso, new Date(y, 2, 1, 0, 0, 0, 0)), true, iso);
  }

  for (const [iso, y] of [["2026-02-29", 2026], ["2026-02-31", 2026], ["2100-02-31", 2100]] as const) {
    assert.equal(isExpired(iso, new Date(y, 1, 28, 23, 59, 59, 0)), false, iso);
    assert.equal(isExpired(iso, new Date(y, 1, 28, 23, 59, 59, 1)), true, iso);
    assert.equal(isExpired(iso, new Date(y, 1, 29, 0, 0, 0, 0)), true, iso);
    assert.equal(isExpired(iso, new Date(y, 2, 1, 0, 0, 0, 0)), true, iso);
  }

  for (const [iso, mo] of [["2026-04-31", 4], ["2026-06-31", 6], ["2026-09-31", 9], ["2026-11-31", 11]] as const) {
    assert.equal(isExpired(iso, new Date(2026, mo - 1, 30, 23, 59, 59, 0)), false, iso);
    assert.equal(isExpired(iso, new Date(2026, mo - 1, 30, 23, 59, 59, 1)), true, iso);
    assert.equal(isExpired(iso, new Date(2026, mo, 1, 0, 0, 0, 0)), true, iso);
  }
});

test("sayDate clamps calendar-overflow days to the month's real last day", () => {
  assert.equal(sayDate("2027-02-31"), "28 February 2027");
  assert.equal(sayDate("2026-02-29"), "28 February 2026");
  assert.equal(sayDate("2100-02-31"), "28 February 2100");
  assert.equal(sayDate("2024-02-31"), "29 February 2024");
  assert.equal(sayDate("2028-02-31"), "29 February 2028");
  assert.equal(sayDate("2026-04-31"), "30 April 2026");
  assert.equal(sayDate("2026-06-31"), "30 June 2026");
  assert.equal(sayDate("2026-09-31"), "30 September 2026");
  assert.equal(sayDate("2026-11-31"), "30 November 2026");

  const expiredFood = checkLabelText(
    makeRead({ kind: "food", product: f("Oat drink"), allergens: f(["oats"]), expiry: f("2026-02-31", 0.95) }),
    profile,
    new Date("2026-03-01T10:00:00"),
  );
  assert.equal(expiredFood.level, "warning");
  assert.equal(expiredFood.speech, "Oat drink was best before 28 February 2026.");
});

test("out-of-range months and days return undefined in isExpired and never leak undefined into speech or headline", () => {
  const now = new Date("2026-06-15T12:00:00");
  const invalidDates = [
    "2026-00",
    "2026-13",
    "2026-99",
    "2026-05-00",
    "2026-05-32",
    "2026-05-99",
    "2026-00-15",
    "2026-13-01",
  ];

  for (const bad of invalidDates) {
    assert.equal(isExpired(bad, now), undefined, bad);
    assert.equal(sayDate(bad), bad, bad);
    assert.ok(!sayDate(bad).includes("undefined"), bad);
    assert.ok(!monthYear(bad).includes("undefined"), bad);
  }

  for (const badMonth of ["2026-00", "2026-13", "2026-99", "2026-13-01"]) {
    assert.equal(monthYear(badMonth), badMonth, badMonth);
  }

  for (const bad of ["2026-13", "2026-00", "2026-05-32"]) {
    const medVerdict = checkLabelText(
      makeRead({ ingredient: f("amlodipine"), strength: f("5 mg"), expiry: f(bad, 0.95) }),
      profile,
      now,
    );
    assert.equal(medVerdict.level, "match");
    assert.ok(medVerdict.reasons.includes("expiry not readable"), bad);
    assert.match(medVerdict.speech, /couldn't read the expiry date/);
    assert.ok(!medVerdict.headline.includes("undefined"), bad);
    assert.ok(!medVerdict.speech.includes("undefined"), bad);

    const foodVerdict = checkLabelText(
      makeRead({ kind: "food", product: f("Oat drink"), allergens: f(["oats"]), expiry: f(bad, 0.95) }),
      profile,
      now,
    );
    assert.equal(foodVerdict.level, "info");
    assert.equal(foodVerdict.speech, "This is Oat drink.");
    assert.ok(!foodVerdict.headline.includes("undefined"), bad);
    assert.ok(!foodVerdict.speech.includes("undefined"), bad);
  }
});
