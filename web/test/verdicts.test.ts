import { test } from "node:test";
import assert from "node:assert/strict";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Field, Gs1Code, LabelRead, Med, Profile, SceneItem, Verdict } from "../../shared/types.ts";
import {
  dosesToday,
  emptyRead,
  findByBarcode,
  findByGtin,
  matchVerdict,
  mockFoodNuts,
  mockScene,
  mockUnsureStrength,
  mockWarningIbuprofen,
  offlineUnknownBarcode,
  offlineUnknownCode,
  withCrossCheck,
} from "../src/lib/verdicts.ts";
import { makeGs1, parseGs1 } from "../src/lib/gs1.ts";
import { demoProfile, loadProfile, logDose, saveProfile, takenToday } from "../src/lib/storage.ts";
import { VerdictCard, sortedItems, targetIndex } from "../src/components/VerdictCard.tsx";

const store = new Map<string, string>();
const localStorageShim = {
  get length() {
    return store.size;
  },
  key(index: number): string | null {
    return Array.from(store.keys())[index] ?? null;
  },
  getItem(key: string): string | null {
    return store.has(key) ? store.get(key)! : null;
  },
  setItem(key: string, value: string): void {
    store.set(key, String(value));
  },
  removeItem(key: string): void {
    store.delete(key);
  },
  clear(): void {
    store.clear();
  },
};
Object.defineProperty(globalThis, "localStorage", {
  value: localStorageShim,
  configurable: true,
  writable: true,
});
Object.defineProperty(globalThis, "React", {
  value: React,
  configurable: true,
  writable: true,
});

const NOW = new Date(2026, 10, 14, 20, 0, 0, 0);

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function sentenceCount(text: string): number {
  return text.trim().split(/(?<=[.!?])\s+/).filter(Boolean).length;
}

function assertReadBounds(read: LabelRead): void {
  assert.ok(
    read.readability >= 0 && read.readability <= 1 && Number.isFinite(read.readability),
    `Expected readability in [0, 1], got ${read.readability}`,
  );
  const fields: Field<unknown>[] = [
    read.product,
    read.ingredient,
    read.strength,
    read.dosing,
    read.expiry,
    read.allergens,
    read.barcode,
  ];
  for (const field of fields) {
    assert.ok(
      field.confidence >= 0 && field.confidence <= 1 && Number.isFinite(field.confidence),
      `Expected field confidence in [0, 1], got ${field.confidence}`,
    );
  }
}

function assertVerdictContract(verdict: Verdict, opts: { maxSentences?: number } = {}): void {
  assert.ok(["match", "warning", "unsure", "info"].includes(verdict.level));
  assert.ok(verdict.headline.trim().length > 0, "Expected non-empty headline");
  assert.ok(wordCount(verdict.headline) <= 8, `Expected headline <= 8 words, got "${verdict.headline}"`);
  assert.ok(verdict.speech.trim().length > 0, "Expected non-empty speech");
  if (opts.maxSentences != null) {
    assert.ok(
      sentenceCount(verdict.speech) <= opts.maxSentences,
      `Expected speech <= ${opts.maxSentences} sentences, got "${verdict.speech}"`,
    );
  }
  assert.ok(Array.isArray(verdict.reasons) && verdict.reasons.length > 0, "Expected non-empty reasons");
  assertReadBounds(verdict.read);
}

function offlineBarcodeVerdict(profile: Profile, rawBarcode: string, now = NOW): Verdict {
  const med = findByBarcode(profile, rawBarcode);
  return med ? matchVerdict(profile, med, { via: "barcode", now }) : offlineUnknownBarcode(rawBarcode);
}

function offlinePackVerdict(profile: Profile, gs1OrRaw: Gs1Code | string, now = NOW): Verdict {
  const code = typeof gs1OrRaw === "string" ? parseGs1(gs1OrRaw) : gs1OrRaw;
  if (!code) assert.fail("Expected valid GS1 pack code");
  const med = code.gtin ? findByGtin(profile, code.gtin) : undefined;
  return med ? matchVerdict(profile, med, { via: "datamatrix", code, now }) : offlineUnknownCode(code);
}

function renderCard(verdict: Verdict, via: string | null = "live"): string {
  const noop = () => {};
  return renderToStaticMarkup(
    createElement(VerdictCard, {
      verdict,
      via,
      onRepeat: noop,
      onLog: noop,
      onDismiss: noop,
    }),
  );
}

test("emptyRead and dosesToday enforce empty confidence defaults and local-day chronological filtering", () => {
  const def = emptyRead();
  assert.equal(def.kind, "unreadable");
  assert.equal(def.readability, 0);
  assert.deepEqual(def.product, { value: null, confidence: 0 });
  assert.deepEqual(def.ingredient, { value: null, confidence: 0 });
  assert.deepEqual(def.strength, { value: null, confidence: 0 });
  assert.deepEqual(def.dosing, { value: null, confidence: 0 });
  assert.deepEqual(def.expiry, { value: null, confidence: 0 });
  assert.deepEqual(def.allergens, { value: null, confidence: 0 });
  assert.deepEqual(def.barcode, { value: null, confidence: 0 });
  assert.equal(emptyRead("food").kind, "food");

  const midnight = new Date(2026, 10, 14, 0, 0, 0, 0).getTime();
  const yesterdayLate = new Date(2026, 10, 13, 23, 59, 59, 999).getTime();
  const morning = new Date(2026, 10, 14, 8, 30, 0, 0).getTime();
  const future = new Date(2026, 10, 14, 21, 0, 0, 0).getTime();
  const profile: Profile = {
    ...demoProfile(),
    doseLog: [
      { medId: "amlodipine", ts: yesterdayLate },
      { medId: "amlodipine", ts: morning },
      { medId: "amlodipine", ts: midnight },
      { medId: "amlodipine", ts: future },
      { medId: "metformin", ts: morning },
    ],
  };

  const todayDoses = dosesToday(profile, "amlodipine", NOW);
  assert.deepEqual(
    todayDoses.map((d) => d.ts),
    [midnight, morning],
  );
});

test("matchVerdict handles single-schedule fresh match vs already-taken double-dose warning", () => {
  const profile = demoProfile();
  const amlo = profile.meds[0];

  const fresh = matchVerdict(profile, amlo, { now: NOW });
  assertVerdictContract(fresh, { maxSentences: 2 });
  assert.equal(fresh.level, "match");
  assert.equal(fresh.matchedMedId, "amlodipine");
  assert.equal(fresh.takenToday, false);
  assert.equal(fresh.headline, "Amlodipine 5 mg");
  assert.equal(fresh.speech, "Yes, Amlodipine 5 mg, your evening pill. You haven't taken it today.");
  assert.deepEqual(fresh.reasons, ["Name and strength match your list", "Taken today: 0 of 1"]);
  assert.equal(fresh.read.kind, "medication");
  assert.deepEqual(fresh.read.product, { value: "Amlodipine", confidence: 0.97 });
  assert.deepEqual(fresh.read.ingredient, { value: "amlodipine", confidence: 0.93 });
  assert.deepEqual(fresh.read.strength, { value: "5 mg", confidence: 0.95 });
  assert.deepEqual(fresh.read.expiry, { value: null, confidence: 0 });
  assert.deepEqual(fresh.read.barcode, { value: "06416542002149", confidence: 0.99 });
  assert.equal(fresh.read.readability, 0.92);
  assert.equal(fresh.crossCheck, undefined);

  const doseAt = new Date(2026, 10, 14, 18, 15, 0, 0).getTime();
  const loggedProfile: Profile = { ...profile, doseLog: [{ medId: "amlodipine", ts: doseAt }] };
  const taken = matchVerdict(loggedProfile, amlo, { now: NOW });
  assertVerdictContract(taken, { maxSentences: 2 });
  assert.equal(taken.level, "warning");
  assert.equal(taken.matchedMedId, "amlodipine");
  assert.equal(taken.takenToday, true);
  assert.equal(taken.headline, "Amlodipine 5 mg: already taken today");
  assert.match(taken.speech, /^You already took Amlodipine today at .+\. Don't take another unless your plan says so\.$/);
  assert.doesNotMatch(taken.speech, /times/);
  assert.deepEqual(taken.reasons, ["Name and strength match your list", "Taken today: 1 of 1"]);
});

test("matchVerdict handles multi-schedule partial progress as match and full schedule as warning", () => {
  const base = demoProfile();
  const metformin = base.meds[1];
  assert.deepEqual(metformin.schedule, ["morning", "evening"]);

  const zeroTaken = matchVerdict(base, metformin, { now: NOW });
  assertVerdictContract(zeroTaken, { maxSentences: 2 });
  assert.equal(zeroTaken.level, "match");
  assert.equal(zeroTaken.takenToday, false);
  assert.equal(zeroTaken.speech, "Yes, Metformin 500 mg, your morning and evening pill. You haven't taken it today.");
  assert.deepEqual(zeroTaken.reasons, ["Name and strength match your list", "Taken today: 0 of 2"]);

  const oneDoseProfile: Profile = {
    ...base,
    doseLog: [{ medId: "metformin", ts: new Date(2026, 10, 14, 8, 5, 0, 0).getTime() }],
  };
  const oneTaken = matchVerdict(oneDoseProfile, metformin, { now: NOW });
  assertVerdictContract(oneTaken, { maxSentences: 2 });
  assert.equal(oneTaken.level, "match");
  assert.equal(oneTaken.matchedMedId, "metformin");
  assert.equal(oneTaken.takenToday, true);
  assert.match(oneTaken.speech, /^Yes, Metformin 500 mg, your morning and evening pill\. You've taken 1 of 2 doses today, last at .+\.$/);
  assert.deepEqual(oneTaken.reasons, ["Name and strength match your list", "Taken today: 1 of 2"]);

  const twoDoseProfile: Profile = {
    ...base,
    doseLog: [
      { medId: "metformin", ts: new Date(2026, 10, 14, 19, 45, 0, 0).getTime() },
      { medId: "metformin", ts: new Date(2026, 10, 14, 8, 5, 0, 0).getTime() },
    ],
  };
  const twoTaken = matchVerdict(twoDoseProfile, metformin, { now: NOW });
  assertVerdictContract(twoTaken, { maxSentences: 2 });
  assert.equal(twoTaken.level, "warning");
  assert.equal(twoTaken.matchedMedId, "metformin");
  assert.equal(twoTaken.takenToday, true);
  assert.equal(twoTaken.headline, "Metformin 500 mg: already taken today");
  assert.match(twoTaken.speech, /^You already took Metformin today at .+, 2 times\. Don't take another unless your plan says so\.$/);
  assert.deepEqual(twoTaken.reasons, ["Name and strength match your list", "Taken today: 2 of 2"]);
});

test("matchVerdict supports unscheduled medicines without barcode and integrates with storage logDose", () => {
  localStorageShim.clear();
  const prnMed: Med = {
    id: "paracetamol",
    name: "Paracetamol",
    ingredient: "paracetamol",
    strength: "500 mg",
    schedule: [],
  };
  const customProfile: Profile = {
    lang: "en",
    meds: [prnMed],
    allergies: [],
    avoid: [],
    doseLog: [],
  };
  saveProfile(customProfile);

  const initial = matchVerdict(loadProfile(), prnMed);
  assertVerdictContract(initial, { maxSentences: 2 });
  assert.equal(initial.level, "match");
  assert.equal(initial.speech, "Yes, Paracetamol 500 mg. You haven't taken it today.");
  assert.deepEqual(initial.read.barcode, { value: null, confidence: 0 });
  assert.equal(takenToday(loadProfile(), "paracetamol"), false);

  const afterLog = logDose(loadProfile(), "paracetamol");
  assert.equal(takenToday(afterLog, "paracetamol"), true);
  assert.equal(takenToday(loadProfile(), "paracetamol"), true);

  const rechecked = matchVerdict(loadProfile(), prnMed);
  assert.equal(rechecked.level, "warning");
  assert.equal(rechecked.takenToday, true);
  assert.equal(rechecked.headline, "Paracetamol 500 mg: already taken today");
});

test("offline barcode verdict handles exact match, already-taken warning, whitespace or leading zeros, and unknown barcode", () => {
  const profile = demoProfile();

  const fresh = offlineBarcodeVerdict(profile, "6416542002149");
  assertVerdictContract(fresh, { maxSentences: 2 });
  assert.equal(fresh.level, "match");
  assert.equal(fresh.matchedMedId, "amlodipine");
  assert.equal(fresh.takenToday, false);
  assert.equal(fresh.headline, "Amlodipine 5 mg (barcode match)");
  assert.equal(
    fresh.speech,
    "Yes, Amlodipine 5 mg, your evening pill. You haven't taken it today; I matched the barcode offline, so I couldn't check the expiry date.",
  );
  assert.deepEqual(fresh.reasons, [
    "Matched by barcode only (offline): label and expiry not checked",
    "Taken today: 0 of 1",
  ]);
  assert.equal(fresh.read.strength.confidence, 0.99);
  assert.deepEqual(fresh.read.expiry, { value: null, confidence: 0 });
  assert.equal(fresh.crossCheck, undefined);

  assert.equal(findByBarcode(profile, "  06416542002149 \n")?.id, "amlodipine");
  assert.equal(findByBarcode(profile, "0006416542002149")?.id, "amlodipine");
  assert.equal(findByBarcode(profile, "641-6542-002149")?.id, "amlodipine");
  assert.equal(findByBarcode(profile, ""), undefined);
  assert.equal(findByBarcode(profile, "   "), undefined);
  assert.equal(findByBarcode(profile, "0000"), undefined);

  const profileWithDose: Profile = {
    ...profile,
    doseLog: [{ medId: "amlodipine", ts: new Date(2026, 10, 14, 19, 10, 0, 0).getTime() }],
  };
  const duplicate = offlineBarcodeVerdict(profileWithDose, " 06416542002149 ");
  assertVerdictContract(duplicate, { maxSentences: 2 });
  assert.equal(duplicate.level, "warning");
  assert.equal(duplicate.matchedMedId, "amlodipine");
  assert.equal(duplicate.takenToday, true);
  assert.equal(duplicate.headline, "Amlodipine 5 mg: already taken today");
  assert.match(duplicate.speech, /already took Amlodipine today/);
  assert.match(duplicate.speech, /Don't take another unless your plan says so\./);
  assert.ok(duplicate.reasons.includes("Matched by barcode only (offline): label and expiry not checked"));

  const unknown = offlineBarcodeVerdict(profile, "9999999999999");
  assertVerdictContract(unknown, { maxSentences: 3 });
  assert.equal(unknown.level, "unsure");
  assert.equal(unknown.matchedMedId, undefined);
  assert.equal(unknown.headline, "Not one of your saved barcodes");
  assert.match(unknown.speech, /I'm offline, so I can only recognise your own saved medicines by barcode\./);
  assert.match(unknown.speech, /until the connection is back\./);
  assert.equal(unknown.read.kind, "other");
  assert.deepEqual(unknown.read.barcode, { value: "9999999999999", confidence: 0.99 });
  assert.equal(unknown.read.readability, 0.5);
  assert.deepEqual(unknown.reasons, [
    "Offline: only saved barcodes can be checked",
    "Barcode 9999999999999 is not in your profile",
  ]);
});

test("offline pack verdict handles in-date EU FMD GS1 match, expired pack warning, already-taken warning, and unknown GTIN", () => {
  const profile = demoProfile();

  const validRaw = makeGs1({ gtin: "06416542002149", expiry: "270800", batch: "LOT42", serial: "SN1001" });
  const inDate = offlinePackVerdict(profile, validRaw, NOW);
  assertVerdictContract(inDate, { maxSentences: 2 });
  assert.equal(inDate.level, "match");
  assert.equal(inDate.matchedMedId, "amlodipine");
  assert.equal(inDate.takenToday, false);
  assert.equal(inDate.headline, "Amlodipine 5 mg (pack code)");
  assert.equal(
    inDate.speech,
    "Yes, Amlodipine 5 mg, your evening pill. You haven't taken it today; matched exactly by the pack code offline, it expires August 2027.",
  );
  assert.deepEqual(inDate.read.expiry, { value: "2027-08", confidence: 1 });
  assert.deepEqual(inDate.read.barcode, { value: "06416542002149", confidence: 0.99 });
  assert.equal(inDate.read.strength.confidence, 0.99);
  if (!inDate.crossCheck) assert.fail("Expected crossCheck on datamatrix verdict");
  assert.equal(inDate.crossCheck.source, "datamatrix");
  assert.equal(inDate.crossCheck.agrees, null);
  assert.deepEqual(inDate.crossCheck.details, [
    "GTIN 06416542002149 matches your Amlodipine",
    "expiry from the pack code: August 2027",
    "batch LOT42",
  ]);

  const currentMonthRaw = makeGs1({ gtin: "06416542002149", expiry: "261100", batch: "NOV26" });
  const currentMonth = offlinePackVerdict(profile, currentMonthRaw, NOW);
  assert.equal(currentMonth.level, "match");

  const expiredRaw = makeGs1({ gtin: "06416542002149", expiry: "250800", batch: "OLD01" });
  const expired = offlinePackVerdict(profile, expiredRaw, NOW);
  assertVerdictContract(expired, { maxSentences: 2 });
  assert.equal(expired.level, "warning");
  assert.equal(expired.matchedMedId, "amlodipine");
  assert.equal(expired.takenToday, false);
  assert.equal(expired.headline, "Amlodipine 5 mg: expired August 2025");
  assert.equal(
    expired.speech,
    "This is Amlodipine 5 mg, your medicine, but the pack code says it expired in August 2025. Don't take it; ask a pharmacist for a new pack.",
  );
  assert.ok(expired.reasons.includes("Expired 2025-08"));
  assert.equal(expired.crossCheck?.agrees, null);

  const takenProfile: Profile = {
    ...profile,
    doseLog: [{ medId: "amlodipine", ts: new Date(2026, 10, 14, 19, 0, 0, 0).getTime() }],
  };
  const expiredAndTaken = offlinePackVerdict(takenProfile, expiredRaw, NOW);
  assert.equal(expiredAndTaken.level, "warning");
  assert.equal(expiredAndTaken.takenToday, true);
  assert.match(expiredAndTaken.headline, /expired August 2025/);

  const inDateTaken = offlinePackVerdict(takenProfile, validRaw, NOW);
  assertVerdictContract(inDateTaken, { maxSentences: 2 });
  assert.equal(inDateTaken.level, "warning");
  assert.equal(inDateTaken.takenToday, true);
  assert.equal(inDateTaken.headline, "Amlodipine 5 mg: already taken today");
  assert.equal(inDateTaken.crossCheck?.agrees, null);

  const eanOnlyProfile: Profile = {
    ...profile,
    meds: [{ id: "ean-only", name: "Bisoprolol", ingredient: "bisoprolol", strength: "2.5 mg", schedule: ["morning"], barcode: "6416542009995" }],
  };
  assert.equal(findByGtin(eanOnlyProfile, "06416542009995")?.id, "ean-only");

  const unknownRaw = makeGs1({ gtin: "09999999999999", expiry: "280300", batch: "UNK1" });
  const unknownPack = offlinePackVerdict(profile, unknownRaw, NOW);
  assertVerdictContract(unknownPack, { maxSentences: 3 });
  assert.equal(unknownPack.level, "unsure");
  assert.equal(unknownPack.matchedMedId, undefined);
  assert.equal(unknownPack.headline, "Pack code not on your list");
  assert.match(unknownPack.speech, /I'm offline, so I can only recognise your own saved medicines\./);
  assert.match(unknownPack.speech, /it says the pack expires March 2028/);
  assert.match(unknownPack.speech, /until the connection is back\./);
  assert.deepEqual(unknownPack.crossCheck, {
    source: "datamatrix",
    code: parseGs1(unknownRaw)!,
    agrees: null,
    details: ["GTIN not in your profile"],
  });

  const unknownNoExpiry = offlineUnknownCode({ raw: "(10)BATCHONLY", batch: "BATCHONLY" });
  assert.equal(unknownNoExpiry.level, "unsure");
  assert.doesNotMatch(unknownNoExpiry.speech, /expires/);
  assert.ok(unknownNoExpiry.reasons.includes("GTIN unknown is not in your profile"));
});

test("withCrossCheck attaches DataMatrix verification immutably and VerdictCard escalates disagreements visibly", () => {
  const profile = demoProfile();
  const base = matchVerdict(profile, profile.meds[0], { now: NOW });
  const matchingCode = parseGs1(makeGs1({ gtin: "06416542002149", expiry: "270800", batch: "B1" }))!;
  const mismatchCode = parseGs1(makeGs1({ gtin: "06416542004860", expiry: "270800", batch: "B9" }))!;

  const confirmed = withCrossCheck(
    base,
    true,
    ["GTIN 06416542002149 = your Amlodipine", "expiry: code 2027-08 = print 2027-08"],
    matchingCode,
  );
  assert.equal(base.crossCheck, undefined);
  assert.equal(confirmed.level, "match");
  assert.equal(confirmed.matchedMedId, "amlodipine");
  assert.deepEqual(confirmed.crossCheck, {
    source: "datamatrix",
    code: matchingCode,
    agrees: true,
    details: ["GTIN 06416542002149 = your Amlodipine", "expiry: code 2027-08 = print 2027-08"],
  });

  const confirmedHtml = renderCard(confirmed, "live");
  assert.match(confirmedHtml, /class="xcheck ok"/);
  assert.match(confirmedHtml, /Double-checked: printed label = pack code/);
  assert.doesNotMatch(confirmedHtml, /xcheck bad/);

  const conflict = withCrossCheck(
    base,
    false,
    ["pack code GTIN 06416542004860 is not Amlodipine"],
    mismatchCode,
  );
  assert.equal(conflict.crossCheck?.source, "datamatrix");
  assert.equal(conflict.crossCheck?.agrees, false);
  const conflictUnsafeOrDisagreement =
    conflict.level !== "match" || conflict.crossCheck?.agrees === false;
  assert.equal(conflictUnsafeOrDisagreement, true);

  const conflictHtml = renderCard(conflict, "live");
  assert.doesNotMatch(conflictHtml, /xcheck ok/);
  assert.match(conflictHtml, /class="xcheck bad" role="note"/);
  assert.match(conflictHtml, /The printed label and the pack code disagree/);
  assert.match(conflictHtml, /pack code GTIN 06416542004860 is not Amlodipine/);
  assert.match(conflictHtml, /Don&#x27;t rely on this answer; ask a pharmacist\./);

  const conflictEmptyDetailsHtml = renderCard(withCrossCheck(base, false, [], mismatchCode), "live");
  assert.match(conflictEmptyDetailsHtml, /What I read on the box doesn&#x27;t match the code printed on it\./);
  assert.match(conflictEmptyDetailsHtml, /Don&#x27;t rely on this answer; ask a pharmacist\./);

  const infoOnlyHtml = renderCard(withCrossCheck(base, null, ["GTIN matches your Amlodipine"], matchingCode), "offline");
  assert.match(infoOnlyHtml, /class="xcheck info"/);
  assert.match(infoOnlyHtml, /Read from the pack code/);
  assert.match(infoOnlyHtml, /offline pack code/);
});

test("mock fixture builders satisfy Verdict, LabelRead, and SceneItem contracts", () => {
  const ibu = mockWarningIbuprofen();
  assertVerdictContract(ibu, { maxSentences: 2 });
  assert.equal(ibu.level, "warning");
  assert.equal(ibu.matchedMedId, undefined);
  assert.equal(ibu.read.kind, "medication");
  assert.equal(ibu.read.product.value, "Ibuprofen");
  assert.equal(ibu.read.strength.value, "400 mg");
  assert.match(ibu.speech, /avoid NSAIDs/);
  assert.ok(ibu.reasons.some((r) => r.includes("NSAID")));

  const unsure = mockUnsureStrength();
  assertVerdictContract(unsure, { maxSentences: 2 });
  assert.equal(unsure.level, "unsure");
  assert.equal(unsure.matchedMedId, undefined);
  assert.equal(unsure.read.kind, "medication");
  assert.equal(unsure.read.product.value, "Metformin");
  assert.equal(unsure.read.strength.value, null);
  assert.ok(unsure.read.strength.confidence < 0.8);
  assert.ok((unsure.read.guidance ?? "").trim().length > 0);
  assert.ok(unsure.reasons.includes("HoldUp never guesses a dose"));

  const nuts = mockFoodNuts();
  assertVerdictContract(nuts, { maxSentences: 3 });
  assert.equal(nuts.level, "warning");
  assert.equal(nuts.matchedMedId, undefined);
  assert.equal(nuts.read.kind, "food");
  assert.ok(nuts.read.allergens.value?.includes("hazelnut"));
  assert.match(nuts.speech, /hazelnuts/);
  assert.match(nuts.speech, /tree nuts/);

  const profile = demoProfile();
  const scene = mockScene(profile);
  assertVerdictContract(scene, { maxSentences: 2 });
  assert.equal(scene.mode, "scene");
  assert.equal(scene.level, "match");
  assert.equal(scene.matchedMedId, "amlodipine");
  const sceneItems = scene.items;
  if (!sceneItems) assert.fail("Expected scene items");
  assert.equal(sceneItems.length, 3);
  assert.deepEqual(
    sceneItems.map((item) => item.position),
    ["left", "center", "right"],
  );

  let prevCenterX = -1;
  for (const item of sceneItems) {
    assert.ok(item.headline.trim().length > 0);
    assert.ok(wordCount(item.headline) <= 6, `Expected scene item headline <= 6 words, got "${item.headline}"`);
    assertReadBounds(item.read);
    if (!item.box) assert.fail("Expected normalized 2D bounding box on scene item");
    const [ymin, xmin, ymax, xmax] = item.box;
    assert.ok(ymin >= 0 && xmin >= 0 && ymax <= 1000 && xmax <= 1000);
    assert.ok(ymin < ymax && xmin < xmax);
    const centerX = (xmin + xmax) / 2;
    assert.ok(centerX > prevCenterX, "Expected scene boxes ordered strictly left to right");
    prevCenterX = centerX;
  }

  const target = sceneItems[2];
  assert.equal(target.level, "match");
  assert.equal(target.matchedMedId, "amlodipine");
  assert.deepEqual(scene.read, target.read);

  const reversed: SceneItem[] = [...sceneItems].reverse();
  const ordered = sortedItems(reversed);
  assert.deepEqual(
    ordered.map((i) => i.position),
    ["left", "center", "right"],
  );
  assert.equal(targetIndex(ordered, scene.matchedMedId), 2);
  assert.equal(targetIndex(ordered, undefined), 2);

  const sceneHtml = renderCard(scene, "live");
  assert.match(sceneHtml, /3 packages, left to right/);
  assert.match(sceneHtml, /aria-current="true"/);
  assert.match(sceneHtml, /This is the one you asked about\./);

  const noAmloProfile: Profile = { ...profile, meds: profile.meds.filter((m) => m.id !== "amlodipine") };
  const unboundScene = mockScene(noAmloProfile);
  assert.equal(unboundScene.matchedMedId, undefined);
  assert.equal(unboundScene.items?.[2].matchedMedId, undefined);
});

test("findByBarcode and findByGtin handle gtin-only, barcode-only, empty, and non-digit edge cases", () => {
  const gtinOnlyMed: Med = {
    id: "gtin-only",
    name: "Candesartan",
    ingredient: "candesartan",
    strength: "8 mg",
    schedule: ["morning"],
    gtin: "06416542007779",
  };
  const emptyCodeMed: Med = {
    id: "empty-codes",
    name: "Vitamin D",
    ingredient: "colecalciferol",
    strength: "",
    schedule: [],
    barcode: "",
    gtin: "",
  };
  const eanMed: Med = {
    id: "ean-med",
    name: "Ramipril",
    ingredient: "ramipril",
    strength: "5 mg",
    schedule: ["evening"],
    barcode: "006416542008882",
  };
  const profile: Profile = {
    lang: "en",
    meds: [emptyCodeMed, gtinOnlyMed, eanMed],
    allergies: [],
    avoid: [],
    doseLog: [],
  };

  assert.equal(findByBarcode(profile, "6416542007779"), undefined);
  assert.equal(findByBarcode(profile, "06416542007779"), undefined);
  assert.equal(findByBarcode(profile, ""), undefined);
  assert.equal(findByBarcode(profile, "---"), undefined);
  assert.equal(findByBarcode(profile, "abc"), undefined);
  assert.equal(findByBarcode(profile, "0000000000000"), undefined);
  assert.equal(findByBarcode(profile, "6416542008882")?.id, "ean-med");
  assert.equal(findByBarcode(profile, "EAN: 0641-6542-008882")?.id, "ean-med");
  assert.equal(findByBarcode(profile, "(01)06416542008882"), undefined);
  assert.equal(findByGtin(profile, parseGs1("(01)06416542008882")?.gtin ?? "")?.id, "ean-med");

  assert.equal(findByGtin(profile, "06416542007779")?.id, "gtin-only");
  assert.equal(findByGtin(profile, "6416542007779")?.id, "gtin-only");
  assert.equal(findByGtin(profile, "0641 6542 007779")?.id, "gtin-only");
  assert.equal(findByGtin(profile, "06416542008882")?.id, "ean-med");
  assert.equal(findByGtin(profile, ""), undefined);
  assert.equal(findByGtin(profile, "00000000000000"), undefined);
  assert.equal(findByGtin(profile, "abc"), undefined);
  assert.equal(findByGtin(profile, "09999999999999"), undefined);

  const directUnknownBarcode = offlineUnknownBarcode("00-UNKNOWN-42");
  assertVerdictContract(directUnknownBarcode, { maxSentences: 3 });
  assert.deepEqual(directUnknownBarcode.read.barcode, { value: "00-UNKNOWN-42", confidence: 0.99 });
  assert.ok(directUnknownBarcode.reasons.includes("Barcode 00-UNKNOWN-42 is not in your profile"));

  const codeWithoutGtinOrExpiry: Gs1Code = { raw: "(10)LOT99(21)SN9", batch: "LOT99", serial: "SN9" };
  const directUnknownPack = offlineUnknownCode(codeWithoutGtinOrExpiry);
  assertVerdictContract(directUnknownPack, { maxSentences: 3 });
  assert.deepEqual(directUnknownPack.read.barcode, { value: null, confidence: 0.99 });
  assert.deepEqual(directUnknownPack.read.expiry, { value: null, confidence: 0 });
  assert.deepEqual(directUnknownPack.reasons, [
    "Offline: only saved medicines can be checked",
    "GTIN unknown is not in your profile",
  ]);
});

test("matchVerdict covers day-precision GS1 expiry boundaries, minimal pack codes, ignored non-datamatrix codes, and schedule edge cases", () => {
  const base = demoProfile();
  const amlo = base.meds[0];

  const expiresTodayCode = parseGs1(makeGs1({ gtin: "06416542002149", expiry: "261114" }))!;
  const expiresToday = matchVerdict(base, amlo, { via: "datamatrix", code: expiresTodayCode, now: NOW });
  assertVerdictContract(expiresToday, { maxSentences: 2 });
  assert.equal(expiresToday.level, "match");
  assert.deepEqual(expiresToday.read.expiry, { value: "2026-11-14", confidence: 1 });
  assert.match(expiresToday.speech, /it expires 14 November 2026\.$/);
  assert.deepEqual(expiresToday.crossCheck?.details, [
    "GTIN 06416542002149 matches your Amlodipine",
    "expiry from the pack code: 14 November 2026",
  ]);

  const expiredYesterdayCode = parseGs1(makeGs1({ gtin: "06416542002149", expiry: "261113" }))!;
  const expiredYesterday = matchVerdict(base, amlo, { via: "datamatrix", code: expiredYesterdayCode, now: NOW });
  assertVerdictContract(expiredYesterday, { maxSentences: 2 });
  assert.equal(expiredYesterday.level, "warning");
  assert.equal(expiredYesterday.headline, "Amlodipine 5 mg: expired 13 November 2026");
  assert.ok(expiredYesterday.reasons.includes("Expired 2026-11-13"));

  const gtinOnlyCode: Gs1Code = { raw: "0106416542002149", gtin: "06416542002149" };
  const minimalPack = matchVerdict(base, amlo, { via: "datamatrix", code: gtinOnlyCode, now: NOW });
  assertVerdictContract(minimalPack, { maxSentences: 2 });
  assert.equal(minimalPack.level, "match");
  assert.deepEqual(minimalPack.read.expiry, { value: null, confidence: 0 });
  assert.match(minimalPack.speech, /matched exactly by the pack code offline\.$/);
  assert.doesNotMatch(minimalPack.speech, /expires/);
  assert.deepEqual(minimalPack.crossCheck?.details, ["GTIN 06416542002149 matches your Amlodipine"]);

  const ignoredOnLabel = matchVerdict(base, amlo, { via: "label", code: expiredYesterdayCode, now: NOW });
  assert.equal(ignoredOnLabel.level, "match");
  assert.equal(ignoredOnLabel.crossCheck, undefined);
  assert.deepEqual(ignoredOnLabel.read.expiry, { value: null, confidence: 0 });

  const ignoredOnBarcode = matchVerdict(base, amlo, { via: "barcode", code: expiredYesterdayCode, now: NOW });
  assert.equal(ignoredOnBarcode.level, "match");
  assert.equal(ignoredOnBarcode.crossCheck, undefined);
  assert.deepEqual(ignoredOnBarcode.read.expiry, { value: null, confidence: 0 });

  const overLoggedSingle: Profile = {
    ...base,
    doseLog: [
      { medId: "amlodipine", ts: new Date(2026, 10, 14, 9, 0, 0, 0).getTime() },
      { medId: "amlodipine", ts: new Date(2026, 10, 14, 19, 30, 0, 0).getTime() },
    ],
  };
  const overLoggedVerdict = matchVerdict(overLoggedSingle, amlo, { now: NOW });
  assert.equal(overLoggedVerdict.level, "warning");
  assert.match(overLoggedVerdict.speech, /, 2 times\. Don't take another unless your plan says so\.$/);
  assert.deepEqual(overLoggedVerdict.reasons, ["Name and strength match your list", "Taken today: 2 of 1"]);

  const tidMed: Med = {
    id: "tid-vit",
    name: "Vitamin D",
    ingredient: "colecalciferol",
    strength: "",
    schedule: ["morning", "noon", "evening"],
    gtin: "06416542005553",
  };
  const tidProfile: Profile = {
    ...base,
    meds: [tidMed],
    doseLog: [
      { medId: "tid-vit", ts: new Date(2026, 10, 14, 8, 0, 0, 0).getTime() },
      { medId: "tid-vit", ts: new Date(2026, 10, 14, 13, 0, 0, 0).getTime() },
    ],
  };
  const tidVerdict = matchVerdict(tidProfile, tidMed, { now: NOW });
  assertVerdictContract(tidVerdict, { maxSentences: 2 });
  assert.equal(tidVerdict.level, "match");
  assert.equal(tidVerdict.headline, "Vitamin D");
  assert.match(tidVerdict.speech, /^Yes, Vitamin D, your morning and noon and evening pill\. You've taken 2 of 3 doses today, last at .+\.$/);
  assert.deepEqual(tidVerdict.read.barcode, { value: "06416542005553", confidence: 0 });
});
