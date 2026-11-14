import {
  CONSENT_VERSION,
  DEMO_PROFILE,
  STORAGE_KEYS,
  appendDoseLog,
  createMemoryStorage,
  exportCaregiverSummary,
  loadConsent,
  loadOrCreateSessionId,
  loadProfile,
  loadTheme,
  resetToDemoProfile,
  saveConsent,
  saveProfile,
  saveTheme,
  undoLastDose,
  wipeAllLocalData,
  type KeyValueStorage
} from "../src/storage/profileStore.ts";
import type { Profile } from "../src/types.ts";

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

test("loadProfile seeds DEMO_PROFILE when storage is empty and isolates mutations", () => {
  const storage = createMemoryStorage();
  const loaded = loadProfile(storage);
  assert.deepEqual(loaded, DEMO_PROFILE);
  assert.ok(storage.getItem(STORAGE_KEYS.profile) !== null);

  loaded.allergies.push("soy");
  loaded.meds[0].schedule.push("morning");
  assert.deepEqual(DEMO_PROFILE.allergies, ["peanut", "tree nuts"]);
  assert.deepEqual(DEMO_PROFILE.meds[0].schedule, ["evening"]);
  assert.deepEqual(loadProfile(storage), DEMO_PROFILE);
});

test("loadProfile and saveProfile validate against corrupted JSON and malformed fields", () => {
  const storage = createMemoryStorage();

  for (const corrupt of ["{not-valid-json", "", "null", "[]", "42", JSON.stringify({ broken: true })]) {
    storage.setItem(STORAGE_KEYS.profile, corrupt);
    const recovered = loadProfile(storage);
    assert.deepEqual(recovered, DEMO_PROFILE);
  }

  storage.setItem(STORAGE_KEYS.profile, JSON.stringify({ meds: [{ bad: 123 }] }));
  assert.deepEqual(loadProfile(storage), DEMO_PROFILE);

  storage.setItem(
    STORAGE_KEYS.profile,
    JSON.stringify({
      meds: [
        {
          id: " aml ",
          name: " Amlodipin ",
          ingredient: " amlodipine ",
          strength: " 5 mg ",
          schedule: [" evening ", "", 42]
        },
        { id: "", name: "", ingredient: "", strength: "", schedule: [] },
        null
      ],
      allergies: [" peanut ", "", 99],
      avoid: "not-an-array",
      doseLog: [
        { medId: " aml ", ts: 1763146800000 },
        { medId: "", ts: 1763146800000 },
        { medId: "aml", ts: Number.NaN },
        { medId: "aml", ts: -5 }
      ],
      lang: "   "
    })
  );
  const sanitized = loadProfile(storage);
  assert.equal(sanitized.meds.length, 1);
  assert.equal(sanitized.meds[0].id, "aml");
  assert.deepEqual(sanitized.meds[0].schedule, ["evening"]);
  assert.equal("barcode" in sanitized.meds[0], false);
  assert.deepEqual(sanitized.allergies, ["peanut"]);
  assert.deepEqual(sanitized.avoid, []);
  assert.deepEqual(sanitized.doseLog, [{ medId: "aml", ts: 1763146800000 }]);
  assert.equal(sanitized.lang, "en");

  const emptyMedsProfile: Profile = {
    meds: [],
    allergies: ["milk"],
    avoid: [],
    doseLog: [],
    lang: "fi"
  };
  const savedEmpty = saveProfile(emptyMedsProfile, storage);
  assert.deepEqual(savedEmpty, emptyMedsProfile);
  assert.deepEqual(loadProfile(storage), emptyMedsProfile);

  const reset = resetToDemoProfile(storage);
  assert.deepEqual(reset, DEMO_PROFILE);
  assert.deepEqual(loadProfile(storage), DEMO_PROFILE);
});

test("appendDoseLog and undoLastDose persist immutably and handle empty logs", () => {
  const storage = createMemoryStorage();
  const initial = loadProfile(storage);

  const afterFirst = appendDoseLog(initial, "aml", 1763100000000, storage);
  assert.equal(initial.doseLog.length, 0);
  assert.deepEqual(afterFirst.doseLog, [{ medId: "aml", ts: 1763100000000 }]);

  const afterSecond = appendDoseLog(afterFirst, " met ", 1763140000000, storage);
  assert.deepEqual(afterSecond.doseLog, [
    { medId: "aml", ts: 1763100000000 },
    { medId: "met", ts: 1763140000000 }
  ]);
  assert.deepEqual(loadProfile(storage).doseLog, afterSecond.doseLog);

  const ignoredBlank = appendDoseLog(afterSecond, "   ", 1763150000000, storage);
  assert.equal(ignoredBlank.doseLog.length, 2);

  const undoneOnce = undoLastDose(afterSecond, storage);
  assert.deepEqual(undoneOnce.doseLog, [{ medId: "aml", ts: 1763100000000 }]);
  assert.deepEqual(loadProfile(storage).doseLog, [{ medId: "aml", ts: 1763100000000 }]);

  const undoneAll = undoLastDose(undoneOnce, storage);
  assert.deepEqual(undoneAll.doseLog, []);

  const undoneEmpty = undoLastDose(undoneAll, storage);
  assert.deepEqual(undoneEmpty.doseLog, []);
});

test("loadConsent and saveConsent enforce CONSENT_VERSION and recover from bad data", () => {
  const storage = createMemoryStorage();

  const initial = loadConsent(storage);
  assert.deepEqual(initial, {
    accepted: false,
    acceptedAt: null,
    version: CONSENT_VERSION
  });

  const accepted = saveConsent(true, storage);
  assert.equal(accepted.accepted, true);
  assert.equal(typeof accepted.acceptedAt, "number");
  assert.equal(accepted.version, CONSENT_VERSION);
  assert.deepEqual(loadConsent(storage), accepted);

  storage.setItem(
    STORAGE_KEYS.consent,
    JSON.stringify({
      accepted: true,
      acceptedAt: 1700000000000,
      version: "2025-01-01"
    })
  );
  const outdated = loadConsent(storage);
  assert.deepEqual(outdated, {
    accepted: false,
    acceptedAt: null,
    version: CONSENT_VERSION
  });

  storage.setItem(STORAGE_KEYS.consent, "{broken");
  assert.equal(loadConsent(storage).accepted, false);

  const revoked = saveConsent(false, storage);
  assert.deepEqual(revoked, {
    accepted: false,
    acceptedAt: null,
    version: CONSENT_VERSION
  });
  assert.deepEqual(loadConsent(storage), revoked);
});

test("loadTheme and saveTheme default to dark and validate theme values", () => {
  const storage = createMemoryStorage();
  assert.equal(loadTheme(storage), "dark");

  saveTheme("high-contrast", storage);
  assert.equal(loadTheme(storage), "high-contrast");

  saveTheme("light", storage);
  assert.equal(loadTheme(storage), "light");

  storage.setItem(STORAGE_KEYS.theme, "neon-purple");
  assert.equal(loadTheme(storage), "dark");
});

test("loadOrCreateSessionId creates readable 8-char code and stays stable per device", () => {
  const storage = createMemoryStorage();
  const first = loadOrCreateSessionId(storage);
  assert.equal(first.length, 8);
  assert.match(first, /^hup-[a-z0-9]{4}$/);

  const second = loadOrCreateSessionId(storage);
  assert.equal(second, first);

  storage.setItem(STORAGE_KEYS.sessionId, "bad id!!!");
  const repaired = loadOrCreateSessionId(storage);
  assert.equal(repaired.length, 8);
  assert.match(repaired, /^hup-[a-z0-9]{4}$/);
  assert.equal(loadOrCreateSessionId(storage), repaired);
});

test("wipeAllLocalData removes every holdup.* key while preserving unrelated keys", () => {
  const storage = createMemoryStorage();
  loadProfile(storage);
  saveConsent(true, storage);
  saveTheme("high-contrast", storage);
  const previousSession = loadOrCreateSessionId(storage);
  storage.setItem("holdup.customFlag", "enabled");
  storage.setItem("unrelated.preference", "keep-me");

  wipeAllLocalData(storage);

  assert.equal(storage.getItem(STORAGE_KEYS.profile), null);
  assert.equal(storage.getItem(STORAGE_KEYS.consent), null);
  assert.equal(storage.getItem(STORAGE_KEYS.theme), null);
  assert.equal(storage.getItem(STORAGE_KEYS.sessionId), null);
  assert.equal(storage.getItem("holdup.customFlag"), null);
  assert.equal(storage.getItem("unrelated.preference"), "keep-me");

  assert.equal(loadConsent(storage).accepted, false);
  assert.equal(loadTheme(storage), "dark");
  const nextSession = loadOrCreateSessionId(storage);
  assert.match(nextSession, /^hup-[a-z0-9]{4}$/);
  assert.equal(storage.getItem(STORAGE_KEYS.sessionId), nextSession);
  void previousSession;
});

test("in-memory fallback works when localStorage is unavailable or throws in private mode", () => {
  wipeAllLocalData();
  const defaultLoaded = loadProfile();
  assert.deepEqual(defaultLoaded, DEMO_PROFILE);
  saveConsent(true);
  assert.equal(loadConsent().accepted, true);
  wipeAllLocalData();
  assert.equal(loadConsent().accepted, false);

  const privateModeStorage: KeyValueStorage = {
    getItem() {
      return null;
    },
    setItem() {
      throw new Error("QuotaExceededError");
    },
    removeItem() {
      throw new Error("SecurityError");
    }
  };

  const savedInPrivate = appendDoseLog(DEMO_PROFILE, "aml", 1763146800000, privateModeStorage);
  assert.equal(savedInPrivate.doseLog.length, 1);
  assert.deepEqual(loadProfile(privateModeStorage).doseLog, [{ medId: "aml", ts: 1763146800000 }]);

  saveConsent(true, privateModeStorage);
  assert.equal(loadConsent(privateModeStorage).accepted, true);

  const sid = loadOrCreateSessionId(privateModeStorage);
  assert.equal(loadOrCreateSessionId(privateModeStorage), sid);

  wipeAllLocalData(privateModeStorage);
  assert.equal(loadConsent(privateModeStorage).accepted, false);
  assert.equal(loadProfile(privateModeStorage).doseLog.length, 0);
});

test("exportCaregiverSummary reports taken vs pending scheduled doses accurately", () => {
  const now = new Date(2026, 10, 14, 21, 0, 0);
  const emptySummary = exportCaregiverSummary(DEMO_PROFILE, now);
  assert.match(emptySummary, /HoldUp Caregiver Summary \(2026-11-14\)/);
  assert.match(emptySummary, /Scheduled doses: 0 of 3 taken, 3 remaining/);
  assert.match(emptySummary, /Taken today: none/);
  assert.match(emptySummary, /Amlodipin 5 mg: 1 remaining \(evening\)/);
  assert.match(emptySummary, /Metformin 500 mg: 2 remaining \(morning, evening\)/);
  assert.match(emptySummary, /As-needed medications:\n- Panadol 500 mg: not taken today/);

  const yesterdayTs = new Date(2026, 10, 13, 20, 0, 0).getTime();
  const morningTs = new Date(2026, 10, 14, 8, 15, 0).getTime();
  const eveningAmlTs = new Date(2026, 10, 14, 20, 5, 0).getTime();
  const tomorrowTs = new Date(2026, 10, 15, 8, 0, 0).getTime();

  const partialProfile: Profile = {
    ...DEMO_PROFILE,
    doseLog: [
      { medId: "aml", ts: yesterdayTs },
      { medId: "met", ts: morningTs },
      { medId: "aml", ts: eveningAmlTs },
      { medId: "met", ts: tomorrowTs }
    ]
  };
  const partialSummary = exportCaregiverSummary(partialProfile, now);
  assert.match(partialSummary, /Scheduled doses: 2 of 3 taken, 1 remaining/);
  assert.match(partialSummary, /- Amlodipin 5 mg: 1 of 1 taken \(20:05\)/);
  assert.match(partialSummary, /- Metformin 500 mg: 1 of 2 taken \(08:15\)/);
  assert.match(partialSummary, /Pending scheduled doses:\n- Metformin 500 mg: 1 remaining \(evening\)/);
  assert.doesNotMatch(partialSummary, /Amlodipin 5 mg: 1 remaining/);

  const eveningMetTs = new Date(2026, 10, 14, 20, 30, 0).getTime();
  const panadolTs = new Date(2026, 10, 14, 14, 45, 0).getTime();
  const completeProfile: Profile = {
    ...DEMO_PROFILE,
    doseLog: [
      { medId: "met", ts: morningTs },
      { medId: "par", ts: panadolTs },
      { medId: "aml", ts: eveningAmlTs },
      { medId: "met", ts: eveningMetTs }
    ]
  };
  const completeSummary = exportCaregiverSummary(completeProfile, now);
  assert.match(completeSummary, /Scheduled doses: 3 of 3 taken, 0 remaining/);
  assert.match(completeSummary, /- Metformin 500 mg: 2 of 2 taken \(08:15, 20:30\)/);
  assert.match(completeSummary, /- Panadol 500 mg \(as needed\): 1 taken \(14:45\)/);
  assert.match(completeSummary, /Pending scheduled doses: none/);
});
