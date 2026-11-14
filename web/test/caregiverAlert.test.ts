import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LabelRead, Profile, Verdict } from "../src/types.ts";
import { DEMO_PROFILE, appendDoseLog, createMemoryStorage, wipeAllLocalData } from "../src/storage/profileStore.ts";
import {
  CAREGIVER_CONTACT_KEY,
  buildFamilyAlertLinks,
  computeDailySchedule,
  loadCaregiverContact,
  saveCaregiverContact,
  type MedScheduleItem
} from "../src/storage/caregiverSchedule.ts";
import { CaregiverAlertCard } from "../src/components/CaregiverAlertCard.tsx";

type TestFn = (name: string, fn: () => void | Promise<void>) => Promise<void>;

interface StrictAssert {
  ok(value: unknown, message?: string): void;
  equal<T>(actual: T, expected: T, message?: string): void;
  deepEqual<T>(actual: T, expected: T, message?: string): void;
  match(value: string, regExp: RegExp, message?: string): void;
  doesNotMatch(value: string, regExp: RegExp, message?: string): void;
}

const testModuleId = String("node:test");
const assertModuleId = String("node:assert/strict");
const { test } = (await import(testModuleId)) as { test: TestFn };
const { default: assert } = (await import(assertModuleId)) as { default: StrictAssert };

function findItem(items: MedScheduleItem[], medId: string, slot: string): MedScheduleItem {
  const found = items.find((item) => item.med.id === medId && item.slot === slot);
  assert.ok(found, `Expected schedule item for ${medId} (${slot})`);
  return found!;
}

function makeIbuprofenWarningVerdict(): Verdict {
  const read: LabelRead = {
    kind: "medication",
    product: { value: "Ibuprofen 400 mg", confidence: 0.96 },
    ingredient: { value: "ibuprofen", confidence: 0.96 },
    strength: { value: "400 mg", confidence: 0.95 },
    dosing: { value: "1 tablet up to 3 times daily", confidence: 0.88 },
    expiry: { value: "2027-08", confidence: 0.92 },
    allergens: { value: [], confidence: 0.85 },
    barcode: { value: "6432100077777", confidence: 0.99 },
    readability: 0.95
  };

  return {
    level: "warning",
    headline: "Ibuprofen 400 mg: not on your list",
    speech: "This is Ibuprofen 400 mg. It isn't on your medication list and your list says to avoid NSAIDs.",
    read,
    reasons: ["ibuprofen is an NSAID, on your avoid list", "not on your medication list"]
  };
}

test("computeDailySchedule at 09:00 marks morning due_now, evening upcoming, and as needed as_needed", () => {
  const morning9 = new Date(2026, 10, 14, 9, 0, 0);
  const items = computeDailySchedule(DEMO_PROFILE, morning9);

  assert.equal(items.length, 4);

  const metMorning = findItem(items, "met", "morning");
  assert.equal(metMorning.status, "due_now");
  assert.equal(metMorning.takenCountToday, 0);
  assert.equal(metMorning.requiredCountToday, 2);

  const metEvening = findItem(items, "met", "evening");
  assert.equal(metEvening.status, "upcoming");
  assert.equal(metEvening.takenCountToday, 0);
  assert.equal(metEvening.requiredCountToday, 2);

  const amlEvening = findItem(items, "aml", "evening");
  assert.equal(amlEvening.status, "upcoming");
  assert.equal(amlEvening.takenCountToday, 0);
  assert.equal(amlEvening.requiredCountToday, 1);

  const panadol = findItem(items, "par", "as needed");
  assert.equal(panadol.status, "as_needed");
  assert.equal(panadol.takenCountToday, 0);
  assert.equal(panadol.requiredCountToday, 0);
});

test("computeDailySchedule at 14:00 with 0 morning doses marks morning overdue and ignores yesterday", () => {
  const yesterdayMorningTs = new Date(2026, 10, 13, 8, 30, 0).getTime();
  const profileWithYesterdayOnly: Profile = {
    ...DEMO_PROFILE,
    doseLog: [{ medId: "met", ts: yesterdayMorningTs }]
  };

  const afternoon14 = new Date(2026, 10, 14, 14, 0, 0);
  const items = computeDailySchedule(profileWithYesterdayOnly, afternoon14);

  const metMorning = findItem(items, "met", "morning");
  assert.equal(metMorning.status, "overdue");
  assert.equal(metMorning.takenCountToday, 0);

  const metEvening = findItem(items, "met", "evening");
  assert.equal(metEvening.status, "upcoming");

  const amlEvening = findItem(items, "aml", "evening");
  assert.equal(amlEvening.status, "upcoming");
});

test("computeDailySchedule at 20:00 after logging aml marks aml evening taken", () => {
  const storage = createMemoryStorage();
  const loggedAt = new Date(2026, 10, 14, 19, 50, 0).getTime();
  const updated = appendDoseLog(DEMO_PROFILE, "aml", loggedAt, storage);

  const evening20 = new Date(2026, 10, 14, 20, 0, 0);
  const items = computeDailySchedule(updated, evening20);

  const amlEvening = findItem(items, "aml", "evening");
  assert.equal(amlEvening.status, "taken");
  assert.equal(amlEvening.takenCountToday, 1);
  assert.equal(amlEvening.requiredCountToday, 1);

  const metMorning = findItem(items, "met", "morning");
  assert.equal(metMorning.status, "overdue");

  const metEvening = findItem(items, "met", "evening");
  assert.equal(metEvening.status, "due_now");
});

test("computeDailySchedule handles twice-daily Metformin partial vs full completion and noon/bedtime windows", () => {
  const storage = createMemoryStorage();
  const dose1Ts = new Date(2026, 10, 14, 8, 15, 0).getTime();
  const partialProfile = appendDoseLog(DEMO_PROFILE, "met", dose1Ts, storage);

  const at14 = computeDailySchedule(partialProfile, new Date(2026, 10, 14, 14, 0, 0));
  assert.equal(findItem(at14, "met", "morning").status, "taken");
  assert.equal(findItem(at14, "met", "evening").status, "upcoming");
  assert.equal(findItem(at14, "met", "morning").takenCountToday, 1);
  assert.equal(findItem(at14, "met", "morning").requiredCountToday, 2);

  const at20Partial = computeDailySchedule(partialProfile, new Date(2026, 10, 14, 20, 0, 0));
  assert.equal(findItem(at20Partial, "met", "morning").status, "taken");
  assert.equal(findItem(at20Partial, "met", "evening").status, "due_now");

  const at23Partial = computeDailySchedule(partialProfile, new Date(2026, 10, 14, 23, 15, 0));
  assert.equal(findItem(at23Partial, "met", "morning").status, "taken");
  assert.equal(findItem(at23Partial, "met", "evening").status, "overdue");

  const dose2Ts = new Date(2026, 10, 14, 20, 10, 0).getTime();
  const fullProfile = appendDoseLog(partialProfile, "met", dose2Ts, storage);
  const at20Full = computeDailySchedule(fullProfile, new Date(2026, 10, 14, 20, 30, 0));
  assert.equal(findItem(at20Full, "met", "morning").status, "taken");
  assert.equal(findItem(at20Full, "met", "evening").status, "taken");
  assert.equal(findItem(at20Full, "met", "evening").takenCountToday, 2);

  const noonBedtimeProfile: Profile = {
    meds: [
      { id: "vitd", name: "Vitamin D", ingredient: "colecalciferol", strength: "20 mcg", schedule: ["noon"] },
      { id: "mel", name: "Melatonin", ingredient: "melatonin", strength: "3 mg", schedule: ["bedtime"] }
    ],
    allergies: [],
    avoid: [],
    doseLog: [],
    lang: "en"
  };

  const at10 = computeDailySchedule(noonBedtimeProfile, new Date(2026, 10, 14, 10, 30, 0));
  assert.equal(findItem(at10, "vitd", "noon").status, "upcoming");
  assert.equal(findItem(at10, "mel", "bedtime").status, "upcoming");

  const at13 = computeDailySchedule(noonBedtimeProfile, new Date(2026, 10, 14, 13, 0, 0));
  assert.equal(findItem(at13, "vitd", "noon").status, "due_now");
  assert.equal(findItem(at13, "mel", "bedtime").status, "upcoming");

  const at21 = computeDailySchedule(noonBedtimeProfile, new Date(2026, 10, 14, 21, 0, 0));
  assert.equal(findItem(at21, "vitd", "noon").status, "overdue");
  assert.equal(findItem(at21, "mel", "bedtime").status, "due_now");
});

test("buildFamilyAlertLinks formats Ibuprofen safety catch, overdue/taken summary, and encoded sms/mailto URIs", () => {
  const storage = createMemoryStorage();
  const withAmlTaken = appendDoseLog(
    DEMO_PROFILE,
    "aml",
    new Date(2026, 10, 14, 19, 45, 0).getTime(),
    storage
  );
  const warningVerdict = makeIbuprofenWarningVerdict();
  const now = new Date(2026, 10, 14, 20, 0, 0);

  const links = buildFamilyAlertLinks(withAmlTaken, {
    contactPhone: "+358 40 123 4567",
    contactEmail: "caregiver@example.com",
    lastVerdict: warningVerdict,
    now
  });

  assert.equal(links.headline, "HoldUp Safety Catch: Ibuprofen 400 mg flagged (avoid NSAIDs)");
  assert.match(links.body, /HoldUp Safety Catch: Ibuprofen 400 mg flagged \(avoid NSAIDs\)/);
  assert.match(links.body, /1 of 3 scheduled doses taken/);
  assert.match(links.body, /Overdue: Metformin 500 mg \(morning\)/);
  assert.match(links.body, /Due now: Metformin 500 mg \(evening\)/);
  assert.match(links.body, /Taken today: Amlodipin 5 mg \(evening\)/);
  assert.equal(links.headline.includes("\u2014"), false);
  assert.equal(links.body.includes("\u2014"), false);

  assert.ok(links.smsHref.startsWith("sms:+358401234567?body="));
  const decodedSmsBody = decodeURIComponent(links.smsHref.slice("sms:+358401234567?body=".length));
  assert.equal(decodedSmsBody, links.body);

  assert.ok(links.mailtoHref.startsWith("mailto:caregiver@example.com?subject="));
  const queryPart = links.mailtoHref.split("?")[1] ?? "";
  const [subjectParam, bodyParam] = queryPart.split("&");
  assert.equal(decodeURIComponent(subjectParam.replace(/^subject=/, "")), links.headline);
  assert.equal(decodeURIComponent(bodyParam.replace(/^body=/, "")), links.body);

  const calmLinks = buildFamilyAlertLinks(withAmlTaken, { now });
  assert.doesNotMatch(calmLinks.headline, /Safety Catch/);
  assert.match(calmLinks.headline, /overdue/i);
});

test("CaregiverAlertCard SSR renders status badges, local contact inputs, >=56px share buttons, and warning banner", () => {
  const mixedProfile: Profile = {
    meds: [
      { id: "aml", name: "Amlodipin", ingredient: "amlodipine", strength: "5 mg", schedule: ["morning"] },
      { id: "vitd", name: "Vitamin D", ingredient: "colecalciferol", strength: "20 mcg", schedule: ["noon"] },
      { id: "met", name: "Metformin", ingredient: "metformin", strength: "500 mg", schedule: ["morning", "evening"] },
      { id: "par", name: "Panadol", ingredient: "paracetamol", strength: "500 mg", schedule: ["as needed"] }
    ],
    allergies: ["peanut"],
    avoid: ["NSAIDs"],
    doseLog: [{ medId: "aml", ts: new Date(2026, 10, 14, 8, 10, 0).getTime() }],
    lang: "en"
  };

  const html = renderToStaticMarkup(
    createElement(CaregiverAlertCard, {
      profile: mixedProfile,
      lastVerdict: makeIbuprofenWarningVerdict(),
      lang: "en",
      onQuickLogDose: () => {},
      now: new Date(2026, 10, 14, 14, 0, 0)
    })
  );

  assert.match(html, />Taken</);
  assert.match(html, />Due Now</);
  assert.match(html, />Overdue</);
  assert.match(html, />Upcoming</);
  assert.match(html, />As Needed</);
  assert.match(html, /HoldUp Safety Catch: Ibuprofen 400 mg flagged \(avoid NSAIDs\)/);
  assert.match(html, /type="tel"/);
  assert.match(html, /type="email"/);
  assert.match(html, />Share Update</);
  assert.match(html, />Send SMS Alert</);
  assert.match(html, />Copy Summary</);
  assert.match(html, /href="sms:\?body=/);
  assert.match(html, /href="mailto:\?subject=/);
  assert.match(html, /min-height:56px/);
  assert.equal(html.includes("\u2014"), false);
});

test("ingredient-only warning verdict and local caregiver contact storage work and wipe cleanly", () => {
  const ingredientOnlyVerdict: Verdict = {
    ...makeIbuprofenWarningVerdict(),
    read: {
      ...makeIbuprofenWarningVerdict().read,
      product: { value: null, confidence: 0.2 },
      ingredient: { value: "ibuprofen", confidence: 0.94 },
      strength: { value: "400mg", confidence: 0.92 }
    }
  };

  const links = buildFamilyAlertLinks(DEMO_PROFILE, {
    lastVerdict: ingredientOnlyVerdict,
    now: new Date(2026, 10, 14, 20, 0, 0)
  });
  assert.equal(links.headline, "HoldUp Safety Catch: Ibuprofen 400 mg flagged (avoid NSAIDs)");

  const prevStorage = (globalThis as { localStorage?: unknown }).localStorage;
  const mem = createMemoryStorage();
  try {
    (globalThis as { localStorage?: unknown }).localStorage = mem;
    assert.deepEqual(loadCaregiverContact(), { phone: "", email: "" });

    saveCaregiverContact({ phone: "+358401234567", email: "family@example.com" });
    assert.ok(mem.getItem(CAREGIVER_CONTACT_KEY) !== null);
    assert.deepEqual(loadCaregiverContact(), {
      phone: "+358401234567",
      email: "family@example.com"
    });

    wipeAllLocalData(mem);
    assert.equal(mem.getItem(CAREGIVER_CONTACT_KEY), null);
    assert.deepEqual(loadCaregiverContact(), { phone: "", email: "" });
  } finally {
    if (prevStorage === undefined) {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    } else {
      (globalThis as { localStorage?: unknown }).localStorage = prevStorage;
    }
  }
});
