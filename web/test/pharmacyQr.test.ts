import {
  SAMPLE_FINNISH_PHARMACY_QR,
  encodePharmacyQrUri,
  mergePharmacyPayload,
  parsePharmacyQrUri,
  type PharmacyRxPayload
} from "../src/pairing/pharmacyQr.ts";
import { DEMO_PROFILE, createMemoryStorage, loadProfile, saveProfile } from "../src/storage/profileStore.ts";
import type { Profile } from "../src/types.ts";

type TestFn = (name: string, fn: () => void | Promise<void>) => Promise<void>;

interface StrictAssert {
  ok(value: unknown, message?: string): void;
  equal<T>(actual: T, expected: T, message?: string): void;
  deepEqual<T>(actual: T, expected: T, message?: string): void;
  match(value: string, regExp: RegExp, message?: string): void;
  doesNotThrow(fn: () => unknown, message?: string): void;
}

const testModuleId = String("node:test");
const assertModuleId = String("node:assert/strict");
const testMod = (await import(testModuleId)) as { test: TestFn };
const assertMod = (await import(assertModuleId)) as { default: StrictAssert };
const test: TestFn = testMod.test;
const assert: StrictAssert = assertMod.default;

test("UTF-8 roundtrip preserves Nordic characters ä/ö/å across holdup URI, https URL, and raw JSON", () => {
  const nordicPayload: PharmacyRxPayload = {
    v: 1,
    pharmacy: "Töölön Yliopiston Apteekki, Åbo & Äänekoski",
    meds: [
      {
        id: "ram",
        name: "Ramipril Krka",
        ingredient: "ramipril",
        strength: "2.5 mg",
        schedule: ["morning"],
        barcode: "6412345678901",
        notes: "Ota 1 tabletti aamulla tyhjään vatsaan tai ruokailun yhteydessä"
      },
      {
        id: "meto",
        name: "Spesicor Dos",
        ingredient: "metoprolol",
        strength: "47.5 mg",
        schedule: ["morning", "evening"],
        notes: "Sväljes hel med ett glas vatten på morgonen och kvällen"
      }
    ],
    allergies: ["maapähkinä", "äyriäiset", "hasselnöt"],
    avoid: ["tulehduskipulääkkeet"]
  };

  const uri = encodePharmacyQrUri(nordicPayload);
  assert.match(uri, /^holdup:\/\/rx\?v=1&data=[A-Za-z0-9_-]+$/);

  const fromUri = parsePharmacyQrUri(uri);
  assert.deepEqual(fromUri, nordicPayload);

  const dataToken = uri.split("data=")[1];
  const httpsUrl = `https://holdup.example.fi/app/rx?v=1&data=${dataToken}`;
  const fromHttps = parsePharmacyQrUri(httpsUrl);
  assert.deepEqual(fromHttps, nordicPayload);

  const fromRawJson = parsePharmacyQrUri(JSON.stringify(nordicPayload, null, 2));
  assert.deepEqual(fromRawJson, nordicPayload);
});

test("parsePharmacyQrUri normalizes comma decimals, strips barcode non-digits, caps lengths, and enforces Med rules", () => {
  const longNotes = `Säilytä huoneenlämmössä ${"x".repeat(400)}`;
  const rawJson = JSON.stringify({
    v: 1,
    pharmacy: "  Tapiolan   Apteekki  ",
    meds: [
      {
        id: " bis ",
        name: "  Emconcor  ",
        ingredient: " bisoprolol ",
        strength: " 2,5 mg ",
        schedule: [" morning ", "", "   "],
        barcode: "EAN: 64-3210 002468-0 (FI)",
        notes: longNotes
      },
      {
        name: " Thyroxin ",
        ingredient: "",
        strength: "0,125mg",
        schedule: ["morning"],
        barcode: "---"
      },
      {
        name: "",
        ingredient: "colecalciferol",
        strength: "20 µg"
      }
    ]
  });

  const parsed = parsePharmacyQrUri(rawJson);
  assert.ok(parsed !== null);
  if (!parsed) throw new Error("Expected parsed payload");
  assert.equal(parsed.pharmacy, "Tapiolan Apteekki");
  assert.equal(parsed.meds.length, 3);

  assert.equal(parsed.meds[0].id, "bis");
  assert.equal(parsed.meds[0].name, "Emconcor");
  assert.equal(parsed.meds[0].ingredient, "bisoprolol");
  assert.equal(parsed.meds[0].strength, "2.5 mg");
  assert.deepEqual(parsed.meds[0].schedule, ["morning"]);
  assert.equal(parsed.meds[0].barcode, "6432100024680");
  assert.ok(typeof parsed.meds[0].notes === "string" && parsed.meds[0].notes.length <= 240);

  assert.equal(parsed.meds[1].name, "Thyroxin");
  assert.equal(parsed.meds[1].ingredient, "");
  assert.equal(parsed.meds[1].strength, "0.125 mg");
  assert.equal("barcode" in parsed.meds[1], false);
  assert.ok(parsed.meds[1].id.length > 0);

  assert.equal(parsed.meds[2].name, "");
  assert.equal(parsed.meds[2].ingredient, "colecalciferol");
  assert.equal(parsed.meds[2].strength, "20 µg");
  assert.deepEqual(parsed.meds[2].schedule, []);
});

test("mergePharmacyPayload updates refills by barcode or normalized (ingredient, strength) and adds distinct meds", () => {
  const initialProfile: Profile = {
    meds: [
      {
        id: "aml",
        name: "Amlodipin",
        ingredient: "amlodipine",
        strength: "5 mg",
        schedule: ["evening"],
        barcode: "6432100012345",
        notes: "Blood pressure tablet"
      },
      {
        id: "bis",
        name: "Emconcor",
        ingredient: "bisoprolol",
        strength: "2.5mg",
        schedule: ["morning"],
        barcode: "6411111111111",
        notes: "Heart rate control"
      }
    ],
    allergies: ["peanut"],
    avoid: ["NSAIDs"],
    doseLog: [{ medId: "aml", ts: 1763146800000 }],
    lang: "fi"
  };

  const refillAndNewPayload: PharmacyRxPayload = {
    v: 1,
    pharmacy: "Kallion Apteekki",
    meds: [
      {
        id: "rx-aml-refill",
        name: "Norvasc",
        ingredient: "amlodipine",
        strength: "5 mg",
        schedule: ["evening"],
        barcode: "6432-1000-12345"
      },
      {
        id: "rx-bis-generic",
        name: "Bisoprolol Orion",
        ingredient: "Bisoprololi",
        strength: "2,5 mg",
        schedule: ["morning"],
        barcode: "6422222222222",
        notes: "Generic substitution pack"
      },
      {
        id: "bis",
        name: "Bisoprolol Orion",
        ingredient: "bisoprolol",
        strength: "5 mg",
        schedule: ["morning"],
        barcode: "6433333333333"
      },
      {
        id: "ato",
        name: "Atorvastatin",
        ingredient: "atorvastatin",
        strength: "20 mg",
        schedule: ["evening"],
        barcode: "6444444444444"
      }
    ]
  };

  const merged = mergePharmacyPayload(initialProfile, refillAndNewPayload);
  assert.equal(merged.updated, 2);
  assert.equal(merged.added, 2);
  assert.equal(merged.profile.meds.length, 4);

  assert.equal(initialProfile.meds.length, 2);
  assert.equal(initialProfile.meds[0].name, "Amlodipin");

  const aml = merged.profile.meds[0];
  assert.equal(aml.id, "aml");
  assert.equal(aml.name, "Norvasc");
  assert.equal(aml.barcode, "6432100012345");
  assert.equal(aml.notes, "Blood pressure tablet");

  const bis25 = merged.profile.meds[1];
  assert.equal(bis25.id, "bis");
  assert.equal(bis25.name, "Bisoprolol Orion");
  assert.equal(bis25.strength, "2.5 mg");
  assert.equal(bis25.barcode, "6422222222222");
  assert.equal(bis25.notes, "Generic substitution pack");

  const bis5 = merged.profile.meds[2];
  assert.equal(bis5.id, "bis-2");
  assert.equal(bis5.strength, "5 mg");

  const ato = merged.profile.meds[3];
  assert.equal(ato.id, "ato");
  assert.equal(ato.strength, "20 mg");

  assert.deepEqual(merged.profile.doseLog, [{ medId: "aml", ts: 1763146800000 }]);
  assert.equal(merged.profile.lang, "fi");
});

test("mergePharmacyPayload unions allergies and avoid lists case-insensitively while preserving existing casing", () => {
  const baseProfile: Profile = {
    meds: [],
    allergies: ["Peanut", "Tree nuts"],
    avoid: ["NSAIDs", "Grapefruit"],
    doseLog: [],
    lang: "en"
  };

  const payload: PharmacyRxPayload = {
    v: 1,
    meds: [
      {
        id: "bis",
        name: "Bisoprolol",
        ingredient: "bisoprolol",
        strength: "2.5 mg",
        schedule: ["morning"]
      }
    ],
    allergies: ["peanut", "  TREE NUTS ", "Penicillin", "penicillin", "Lactose"],
    avoid: ["nsaids", "St. John's wort", "GRAPEFRUIT"]
  };

  const { profile, added, updated } = mergePharmacyPayload(baseProfile, payload);
  assert.equal(added, 1);
  assert.equal(updated, 0);
  assert.deepEqual(profile.allergies, ["Peanut", "Tree nuts", "Penicillin", "Lactose"]);
  assert.deepEqual(profile.avoid, ["NSAIDs", "Grapefruit", "St. John's wort"]);
});

test("SAMPLE_FINNISH_PHARMACY_QR decodes cleanly and supports idempotent 1-click import into DEMO_PROFILE", () => {
  assert.match(SAMPLE_FINNISH_PHARMACY_QR, /^holdup:\/\/rx\?v=1&data=[A-Za-z0-9_-]+$/);

  const parsed = parsePharmacyQrUri(SAMPLE_FINNISH_PHARMACY_QR);
  assert.ok(parsed !== null);
  if (!parsed) throw new Error("Expected SAMPLE_FINNISH_PHARMACY_QR to parse");
  assert.equal(parsed.v, 1);
  assert.equal(parsed.pharmacy, "Yliopiston Apteekki Helsinki");
  assert.equal(parsed.meds.length, 2);

  const [bis, ato] = parsed.meds;
  assert.equal(bis.ingredient, "bisoprolol");
  assert.equal(bis.strength, "2.5 mg");
  assert.deepEqual(bis.schedule, ["morning"]);
  assert.ok(Boolean(bis.barcode && /^\d+$/.test(bis.barcode)));

  assert.equal(ato.ingredient, "atorvastatin");
  assert.equal(ato.strength, "20 mg");
  assert.deepEqual(ato.schedule, ["evening"]);
  assert.ok(Boolean(ato.barcode && /^\d+$/.test(ato.barcode)));

  const firstImport = mergePharmacyPayload(DEMO_PROFILE, parsed);
  assert.equal(firstImport.added, 2);
  assert.equal(firstImport.updated, 0);
  assert.equal(firstImport.profile.meds.length, DEMO_PROFILE.meds.length + 2);

  const secondImport = mergePharmacyPayload(firstImport.profile, parsed);
  assert.equal(secondImport.added, 0);
  assert.equal(secondImport.updated, 2);
  assert.equal(secondImport.profile.meds.length, DEMO_PROFILE.meds.length + 2);

  const storage = createMemoryStorage();
  saveProfile(secondImport.profile, storage);
  assert.deepEqual(loadProfile(storage), secondImport.profile);
});

test("parsePharmacyQrUri rejects hostile, corrupted, and malformed URIs or payloads without throwing", () => {
  const validToken = SAMPLE_FINNISH_PHARMACY_QR.split("data=")[1];

  const hostileInputs: unknown[] = [
    "",
    "   ",
    null,
    undefined,
    42,
    {},
    "javascript:alert(1)",
    `data:application/json;base64,${validToken}`,
    "file:///etc/passwd",
    `http://holdup.fi/rx?v=1&data=${validToken}`,
    `https://user:secret@holdup.fi/rx?v=1&data=${validToken}`,
    `https://evil.example/phishing?v=1&data=${validToken}`,
    `holdup://pairing?v=1&data=${validToken}`,
    `holdup://rx?v=2&data=${validToken}`,
    `holdup://rx?v=1&data=${validToken}&data=${validToken}`,
    "holdup://rx?v=1&data=",
    "holdup://rx?v=1&data=%%%not-base64%%%",
    "holdup://rx?v=1&data=abcde",
    "holdup://rx?v=1&data=//79",
    "{broken-json",
    "[]",
    "null",
    JSON.stringify({ v: 2, meds: [{ id: "a", name: "A", ingredient: "a", strength: "5 mg", schedule: [] }] }),
    JSON.stringify({ v: 1, meds: [] }),
    JSON.stringify({ v: 1, meds: [{ id: "a", name: "", ingredient: "", strength: "5 mg", schedule: [] }] }),
    JSON.stringify({ v: 1, meds: [{ id: "a", name: "Bisoprolol", ingredient: "bisoprolol", strength: "", schedule: [] }] }),
    JSON.stringify({ v: 1, meds: [{ id: "a", name: "Bisoprolol", ingredient: "bisoprolol", strength: "strong", schedule: [] }] }),
    JSON.stringify({ v: 1, meds: [{ id: "a", name: "Bisoprolol", ingredient: "bisoprolol" }] }),
    JSON.stringify({ v: 1, meds: [{ id: "a", name: "Bisoprolol", ingredient: "bisoprolol", strength: "5 mg", schedule: [123] }] }),
    JSON.stringify({ v: 1, meds: [{ id: "a", name: "Bisoprolol", ingredient: "bisoprolol", strength: "5 mg", schedule: [] }], allergies: "peanut" }),
    `holdup://rx?v=1&data=${"A".repeat(20000)}`
  ];

  for (const input of hostileInputs) {
    assert.doesNotThrow(() => {
      const res = parsePharmacyQrUri(input as string);
      assert.equal(res, null);
    });
  }
});
