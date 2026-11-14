import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import express from "express";
import type { LabelRead, Profile } from "../../shared/types.ts";
import {
  buildCaregiverAlertPreview,
  createCaregiverAlertRouter,
  resolveAlertLang,
  sanitizeContactEmail,
  sanitizeContactPhone,
} from "../src/caregiverAlert.ts";
import { hubStats, resetHubsForTest } from "../src/hub.ts";
import { checkLabel } from "../src/safety.ts";

process.env.HOLDUP_QUIET = "1";

const TEST_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(TEST_FILE), "..", "..");
const IMPL_FILE = path.join(REPO_ROOT, "server", "src", "caregiverAlert.ts");

const SLASH = String.fromCharCode(47);
const STAR = String.fromCharCode(42);
const EM_DASH = String.fromCharCode(0x2014);
const CO_AUTHORED = ["Co", "Authored", "By"].join("-");
const HTTP_SCHEME = `http:${SLASH}${SLASH}`;

let server: http.Server;
let baseUrl = "";

before(async () => {
  process.env.HOLDUP_QUIET = "1";
  resetHubsForTest();
  const app = express().use(createCaregiverAlertRouter());
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  baseUrl = `${HTTP_SCHEME}127.0.0.1:${port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function makeBaseProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    meds: [
      {
        id: "met",
        name: "Metformin",
        ingredient: "metformin",
        strength: "500 mg",
        schedule: ["morning", "evening"],
      },
      {
        id: "aml",
        name: "Amlodipin",
        ingredient: "amlodipine",
        strength: "5 mg",
        schedule: ["evening"],
      },
      {
        id: "par",
        name: "Panadol",
        ingredient: "paracetamol",
        strength: "500 mg",
        schedule: ["as needed"],
      },
    ],
    allergies: ["nuts"],
    avoid: ["NSAIDs"],
    doseLog: [],
    lang: "en",
    ...overrides,
  };
}

function makeRead(overrides: Partial<LabelRead> = {}): LabelRead {
  const nf = { value: null, confidence: 0 };
  return {
    kind: "medication",
    product: nf,
    ingredient: nf,
    strength: nf,
    dosing: nf,
    expiry: nf,
    allergens: { value: [], confidence: 0.9 },
    barcode: nf,
    readability: 0.95,
    ...overrides,
  };
}

test("resolveAlertLang and contact sanitizers normalize locales, phones, and emails", () => {
  assert.equal(resolveAlertLang("fi", "en"), "fi");
  assert.equal(resolveAlertLang("fi-FI", "sv"), "fi");
  assert.equal(resolveAlertLang("FI_FI", "en"), "fi");
  assert.equal(resolveAlertLang("sv", "en"), "sv");
  assert.equal(resolveAlertLang("sv-SE", "fi"), "sv");
  assert.equal(resolveAlertLang("en-US", "fi"), "en");
  assert.equal(resolveAlertLang("de", "fi"), "en");
  assert.equal(resolveAlertLang(undefined, "fi-FI"), "fi");
  assert.equal(resolveAlertLang("", "sv-FI"), "sv");
  assert.equal(resolveAlertLang(99, "fi"), "fi");
  assert.equal(resolveAlertLang(null, "es"), "en");

  assert.equal(sanitizeContactPhone("  +358 (40) 123-4567 "), "+358401234567");
  assert.equal(sanitizeContactPhone("040 123 4567"), "0401234567");
  assert.equal(sanitizeContactPhone("+46+70+111+2222"), "+46701112222");
  assert.equal(sanitizeContactPhone("+" + "9".repeat(40)), "+" + "9".repeat(23));
  assert.equal(sanitizeContactPhone("8".repeat(40)), "8".repeat(24));
  assert.equal(sanitizeContactPhone("+"), "");
  assert.equal(sanitizeContactPhone("abc-def"), "");
  assert.equal(sanitizeContactPhone(12345), "");

  assert.equal(
    sanitizeContactEmail("  family@example.com\r\n\t\u0000 "),
    "family@example.com",
  );
  assert.equal(sanitizeContactEmail("a".repeat(150)).length, 120);
  assert.equal(sanitizeContactEmail(null), "");
});

test("daily schedule windows evaluate EN/FI/SV slot keywords, HH:MM +-2h, and exclude as-needed slots", () => {
  const nordicProfile: Profile = {
    meds: [
      { id: "m1", name: "Bisoprolol", ingredient: "bisoprolol", strength: "2.5 mg", schedule: ["aamu"] },
      { id: "m2", name: "Vitamin D", ingredient: "colecalciferol", strength: "20 mcg", schedule: ["päivä"] },
      { id: "m3", name: "Eye Drops", ingredient: "timolol", strength: "5 mg/ml", schedule: ["iltapäivä"] },
      { id: "m4", name: "Simvastatin", ingredient: "simvastatin", strength: "20 mg", schedule: ["kväll"] },
      { id: "m5", name: "Melatonin", ingredient: "melatonin", strength: "3 mg", schedule: ["yö"] },
      { id: "m6", name: "Thyroxin", ingredient: "levothyroxine", strength: "50 mcg", schedule: ["08:00"] },
      { id: "m7", name: "Burana", ingredient: "ibuprofen", strength: "400 mg", schedule: ["tarvittaessa"] },
      { id: "m8", name: "Alvedon", ingredient: "paracetamol", strength: "500 mg", schedule: ["vid behov"] },
    ],
    allergies: [],
    avoid: [],
    doseLog: [
      { medId: "m1", ts: new Date(2026, 10, 13, 8, 0, 0).getTime() },
    ],
    lang: "fi",
  };

  const at09 = buildCaregiverAlertPreview({
    profile: nordicProfile,
    nowIso: new Date(2026, 10, 14, 9, 0, 0).toISOString(),
  });
  assert.equal(at09.lang, "fi");
  assert.equal(at09.status, "in_progress");
  assert.deepEqual(at09.counts, {
    scheduled: 6,
    taken: 0,
    overdue: 0,
    dueNow: 2,
    upcoming: 4,
  });

  const at13 = buildCaregiverAlertPreview({
    profile: nordicProfile,
    nowIso: new Date(2026, 10, 14, 13, 0, 0).toISOString(),
  });
  assert.equal(at13.status, "missed_dose");
  assert.deepEqual(at13.counts, {
    scheduled: 6,
    taken: 0,
    overdue: 2,
    dueNow: 2,
    upcoming: 2,
  });

  const svAfternoon = buildCaregiverAlertPreview({
    profile: {
      meds: [
        { id: "s1", name: "Morgonmed", ingredient: "metformin", strength: "500 mg", schedule: ["morgon"] },
        { id: "s2", name: "Middagsmed", ingredient: "furosemide", strength: "40 mg", schedule: ["middag"] },
        { id: "s3", name: "Eftermiddagsmed", ingredient: "timolol", strength: "5 mg", schedule: ["eftermiddag"] },
        { id: "s4", name: "Nattmed", ingredient: "zopiclone", strength: "5 mg", schedule: ["natt"] },
      ],
      allergies: [],
      avoid: [],
      doseLog: [{ medId: "s1", ts: new Date(2026, 10, 14, 7, 30, 0).getTime() }],
      lang: "sv",
    },
    nowIso: new Date(2026, 10, 14, 16, 0, 0).toISOString(),
  });
  assert.equal(svAfternoon.lang, "sv");
  assert.equal(svAfternoon.status, "missed_dose");
  assert.deepEqual(svAfternoon.counts, {
    scheduled: 4,
    taken: 1,
    overdue: 1,
    dueNow: 1,
    upcoming: 1,
  });
});

test("status transitions across in_progress, missed_dose, all_taken, and safety_warning in EN, FI, and SV", () => {
  const morningNow = new Date(2026, 10, 14, 9, 30, 0);
  const afternoonNow = new Date(2026, 10, 14, 14, 0, 0);
  const eveningNow = new Date(2026, 10, 14, 20, 30, 0);

  for (const lang of ["en", "fi", "sv"] as const) {
    const inProg = buildCaregiverAlertPreview({
      profile: makeBaseProfile(),
      lang,
      nowIso: morningNow.toISOString(),
    });
    assert.equal(inProg.ok, true);
    assert.equal(inProg.lang, lang);
    assert.equal(inProg.status, "in_progress");
    assert.deepEqual(inProg.counts, {
      scheduled: 3,
      taken: 0,
      overdue: 0,
      dueNow: 1,
      upcoming: 2,
    });

    const missed = buildCaregiverAlertPreview({
      profile: makeBaseProfile(),
      lang,
      nowIso: afternoonNow.toISOString(),
    });
    assert.equal(missed.status, "missed_dose");
    assert.equal(missed.counts.overdue, 1);

    const completedProfile = makeBaseProfile({
      doseLog: [
        { medId: "met", ts: new Date(2026, 10, 14, 8, 0, 0).getTime() },
        { medId: "met", ts: new Date(2026, 10, 14, 19, 15, 0).getTime() },
        { medId: "aml", ts: new Date(2026, 10, 14, 19, 20, 0).getTime() },
        { medId: "par", ts: new Date(2026, 10, 14, 15, 0, 0).getTime() },
      ],
    });
    const allTaken = buildCaregiverAlertPreview({
      profile: completedProfile,
      lang,
      nowIso: eveningNow.toISOString(),
    });
    assert.equal(allTaken.status, "all_taken");
    assert.deepEqual(allTaken.counts, {
      scheduled: 3,
      taken: 3,
      overdue: 0,
      dueNow: 0,
      upcoming: 0,
    });
    assert.ok(allTaken.body.includes("Panadol 500 mg"));
    assert.equal(allTaken.headline.includes(EM_DASH), false);
    assert.equal(allTaken.body.includes(EM_DASH), false);
  }

  const fiMissed = buildCaregiverAlertPreview({
    profile: makeBaseProfile(),
    lang: "fi",
    nowIso: afternoonNow.toISOString(),
  });
  assert.match(fiMissed.headline, /HoldUp-annoshälytys/);
  assert.match(fiMissed.body, /Myöhässä: Metformin 500 mg \(aamu\)\./);

  const svAllTaken = buildCaregiverAlertPreview({
    profile: makeBaseProfile({
      doseLog: [
        { medId: "met", ts: new Date(2026, 10, 14, 8, 0, 0).getTime() },
        { medId: "met", ts: new Date(2026, 10, 14, 19, 15, 0).getTime() },
        { medId: "aml", ts: new Date(2026, 10, 14, 19, 20, 0).getTime() },
      ],
    }),
    lang: "sv",
    nowIso: eveningNow.toISOString(),
  });
  assert.match(svAllTaken.headline, /HoldUp dagsöversikt: Alla 3 schemalagda doser tagna idag/);
  assert.match(svAllTaken.body, /Tagna idag:.*Metformin 500 mg \(morgon\)/);
});

test("all 6 safety warning catches localize cleanly across EN, FI, and SV", () => {
  const now = new Date(2026, 10, 14, 20, 0, 0);
  const baseProfile = makeBaseProfile({
    doseLog: [{ medId: "aml", ts: new Date(2026, 10, 14, 19, 0, 0).getTime() }],
  });

  const avoidVerdict = checkLabel(
    makeRead({
      product: { value: "Ibuprofen 400 mg", confidence: 0.96 },
      ingredient: { value: "ibuprofen", confidence: 0.96 },
      strength: { value: "400 mg", confidence: 0.95 },
    }),
    baseProfile,
    now,
  );
  const wrongPillVerdict = checkLabel(
    makeRead({
      product: { value: "Simvastatin 20 mg", confidence: 0.96 },
      ingredient: { value: "simvastatin", confidence: 0.96 },
      strength: { value: "20 mg", confidence: 0.95 },
    }),
    baseProfile,
    now,
  );
  const wrongStrengthVerdict = checkLabel(
    makeRead({
      product: { value: "Amlodipin 10 mg", confidence: 0.97 },
      ingredient: { value: "amlodipine", confidence: 0.97 },
      strength: { value: "10 mg", confidence: 0.96 },
    }),
    baseProfile,
    now,
  );
  const allergenVerdict = checkLabel(
    makeRead({
      kind: "food",
      product: { value: "Alpine Hazelnut Bar", confidence: 0.95 },
      allergens: { value: ["hazelnut"], confidence: 0.95 },
    }),
    baseProfile,
    now,
  );
  const expiredVerdict = checkLabel(
    makeRead({
      product: { value: "Metformin 500 mg", confidence: 0.97 },
      ingredient: { value: "metformin", confidence: 0.97 },
      strength: { value: "500 mg", confidence: 0.96 },
      expiry: { value: "2024-05", confidence: 0.94 },
    }),
    baseProfile,
    now,
  );
  const duplicateVerdict = checkLabel(
    makeRead({
      product: { value: "Amlodipin 5 mg", confidence: 0.97 },
      ingredient: { value: "amlodipine", confidence: 0.97 },
      strength: { value: "5 mg", confidence: 0.96 },
    }),
    baseProfile,
    now,
  );

  const cases = [
    {
      verdict: avoidVerdict,
      enRe: /avoid NSAIDs/,
      fiRe: /tulehduskipulääkkeet \(NSAID\)/,
      svRe: /undvik läkemedelsgrupp: NSAID/,
    },
    {
      verdict: wrongPillVerdict,
      enRe: /wrong pill: not on medication list/,
      fiRe: /väärä lääke: ei lääkelistalla/,
      svRe: /fel läkemedel: finns inte på medicinlistan/,
    },
    {
      verdict: wrongStrengthVerdict,
      enRe: /wrong strength: label 10 mg, prescribed 5 mg/,
      fiRe: /väärä vahvuus: pakkauksessa 10 mg, lääkelistalla 5 mg/,
      svRe: /fel styrka: förpackning 10 mg, ordinerad 5 mg/,
    },
    {
      verdict: allergenVerdict,
      enRe: /allergen warning: contains hazelnut, allergy nuts/,
      fiRe: /allergeenivaroitus: sisältää hazelnut, allergia nuts/,
      svRe: /allergenvarning: innehåller hazelnut, allergi nuts/,
    },
    {
      verdict: expiredVerdict,
      enRe: /expired \(2024-05\)/,
      fiRe: /vanhentunut \(2024-05\)/,
      svRe: /utgånget datum \(2024-05\)/,
    },
    {
      verdict: duplicateVerdict,
      enRe: /duplicate dose: already taken today/,
      fiRe: /kaksoisannosvaara: otettu jo tänään/,
      svRe: /dubbeldosvarning: redan tagen idag/,
    },
  ];

  for (const c of cases) {
    assert.equal(c.verdict.level, "warning");
    const enRes = buildCaregiverAlertPreview({
      profile: baseProfile,
      lastVerdict: c.verdict,
      lang: "en",
      nowIso: now.toISOString(),
    });
    const fiRes = buildCaregiverAlertPreview({
      profile: baseProfile,
      lastVerdict: c.verdict,
      lang: "fi",
      nowIso: now.toISOString(),
    });
    const svRes = buildCaregiverAlertPreview({
      profile: baseProfile,
      lastVerdict: c.verdict,
      lang: "sv",
      nowIso: now.toISOString(),
    });

    assert.equal(enRes.status, "safety_warning");
    assert.equal(fiRes.status, "safety_warning");
    assert.equal(svRes.status, "safety_warning");

    assert.match(enRes.headline, c.enRe);
    assert.match(fiRes.headline, c.fiRe);
    assert.match(svRes.headline, c.svRe);

    assert.match(enRes.body, /Action needed:/);
    assert.match(fiRes.body, /Toimenpide:/);
    assert.match(svRes.body, /Åtgärd:/);

    assert.equal(enRes.body.includes(EM_DASH), false);
    assert.equal(fiRes.body.includes(EM_DASH), false);
    assert.equal(svRes.body.includes(EM_DASH), false);
  }
});

test("sms: and mailto: links are RFC percent-encoded and prevent header injection", () => {
  const now = new Date(2026, 10, 14, 20, 0, 0);
  const res = buildCaregiverAlertPreview({
    profile: makeBaseProfile({
      doseLog: [{ medId: "aml", ts: new Date(2026, 10, 14, 19, 30, 0).getTime() }],
    }),
    contactPhone: " +358 40 123 4567 ",
    contactEmail: " caregiver@example.com ",
    lang: "fi",
    nowIso: now.toISOString(),
  });

  assert.ok(res.smsHref.startsWith("sms:+358401234567?body="));
  const rawSmsQuery = res.smsHref.slice("sms:+358401234567?body=".length);
  assert.equal(rawSmsQuery.includes(" "), false);
  assert.equal(rawSmsQuery.includes("\n"), false);
  assert.equal(rawSmsQuery.includes("("), false);
  assert.equal(rawSmsQuery.includes(")"), false);
  assert.equal(decodeURIComponent(rawSmsQuery), res.body);

  assert.ok(res.mailtoHref.startsWith("mailto:caregiver@example.com?subject="));
  const mailParts = res.mailtoHref.split("?");
  assert.equal(mailParts.length, 2);
  const [subjectPart, bodyPart] = mailParts[1].split("&");
  assert.equal(decodeURIComponent(subjectPart.replace(/^subject=/, "")), res.headline);
  assert.equal(decodeURIComponent(bodyPart.replace(/^body=/, "")), res.body);

  const injected = buildCaregiverAlertPreview({
    profile: makeBaseProfile(),
    contactEmail: "victim@example.com?bcc=spy@attacker.example\r\n&subject=Hijacked",
    nowIso: now.toISOString(),
  });
  assert.equal(injected.mailtoHref.split("?").length, 2);
  assert.ok(injected.mailtoHref.startsWith("mailto:victim@example.com%3Fbcc="));
});

test("HTTP POST /api/caregiver-alert-preview returns 200, Cache-Control: no-store, and rejects non-object or hostile payloads", async () => {
  const okRes = await fetch(`${baseUrl}/api/caregiver-alert-preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      profile: makeBaseProfile({
        doseLog: [{ medId: "met", ts: new Date(2026, 10, 14, 8, 15, 0).getTime() }],
      }),
      contactPhone: "+358 50 987 6543",
      contactEmail: "omaishoitaja@esimerkki.fi",
      lang: "fi-FI",
      nowIso: new Date(2026, 10, 14, 19, 0, 0).toISOString(),
    }),
  });
  assert.equal(okRes.status, 200);
  assert.equal(okRes.headers.get("cache-control"), "no-store");
  assert.equal(okRes.headers.get("x-content-type-options"), "nosniff");
  assert.match(okRes.headers.get("content-type") ?? "", /application\/json/);

  const okJson = (await okRes.json()) as Record<string, any>;
  assert.equal(okJson.ok, true);
  assert.equal(okJson.lang, "fi");
  assert.equal(okJson.status, "in_progress");
  assert.deepEqual(okJson.counts, {
    scheduled: 3,
    taken: 1,
    overdue: 0,
    dueNow: 2,
    upcoming: 0,
  });
  assert.ok(String(okJson.smsHref).startsWith("sms:+358509876543?body="));
  assert.ok(String(okJson.mailtoHref).startsWith("mailto:omaishoitaja@esimerkki.fi?subject="));

  const emptyObjRes = await fetch(`${baseUrl}/api/caregiver-alert-preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(emptyObjRes.status, 200);
  assert.equal(emptyObjRes.headers.get("cache-control"), "no-store");
  const emptyObjJson = (await emptyObjRes.json()) as Record<string, any>;
  assert.equal(emptyObjJson.ok, true);
  assert.equal(emptyObjJson.status, "in_progress");

  const nonObjectPayloads: Array<{ contentType: string; body: string }> = [
    { contentType: "application/json", body: "null" },
    { contentType: "application/json", body: "[]" },
    { contentType: "application/json", body: "[1, 2, 3]" },
    { contentType: "application/json", body: '"plain-string"' },
    { contentType: "application/json", body: "42" },
    { contentType: "application/json", body: "true" },
    { contentType: "application/json", body: "{malformed-json" },
    { contentType: "application/json", body: "" },
    { contentType: "text/plain", body: "not a json object" },
  ];

  for (const item of nonObjectPayloads) {
    const badRes = await fetch(`${baseUrl}/api/caregiver-alert-preview`, {
      method: "POST",
      headers: { "content-type": item.contentType },
      body: item.body,
    });
    assert.equal(badRes.status, 400, `Expected 400 for body=${item.body}`);
    assert.equal(badRes.headers.get("cache-control"), "no-store");
    const rawText = await badRes.text();
    assert.doesNotMatch(rawText, /<!DOCTYPE|SyntaxError|node_modules/i);
    const errBody = JSON.parse(rawText) as Record<string, unknown>;
    assert.deepEqual(errBody, {
      type: "error",
      code: "bad_input",
      message: "JSON object body required",
      recoverable: true,
    });
  }

  const oversizedRes = await fetch(`${baseUrl}/api/caregiver-alert-preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pad: "x".repeat(80_000) }),
  });
  assert.equal(oversizedRes.status, 413);
  assert.equal(oversizedRes.headers.get("cache-control"), "no-store");

  const hostileRes = await fetch(`${baseUrl}/api/caregiver-alert-preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      __proto__: { polluted: "yes" },
      profile: {
        meds: Array.from({ length: 70 }, (_, idx) => ({
          id: `med-${idx}`,
          name: `HostileMed${EM_DASH}Line1\nInjectedLine`,
          ingredient: 12345,
          strength: "500mg",
          schedule: ["morning", null, 999],
        })),
        allergies: "not-an-array",
        avoid: [null, `NSAIDs${EM_DASH}extra`],
        doseLog: [{ medId: "med-0", ts: "bad" }, { medId: "med-0", ts: Number.NaN }],
      },
      lastVerdict: {
        level: "warning",
        headline: `Danger${EM_DASH}Item`,
        reasons: [null, 42, `avoid list${EM_DASH}hit`],
        read: "not-an-object",
      },
      contactPhone: "+358 (00) 999-888-777-666-555-444-333",
      contactEmail: "test\r\n@example.com",
      lang: { bad: true },
      nowIso: "not-a-valid-date",
    }),
  });
  assert.equal(hostileRes.status, 200);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  const hostileBody = (await hostileRes.json()) as Record<string, any>;
  assert.equal(hostileBody.ok, true);
  assert.equal(hostileBody.status, "safety_warning");
  assert.equal(hostileBody.counts.scheduled, 50);
  assert.equal(String(hostileBody.headline).includes(EM_DASH), false);
  assert.equal(String(hostileBody.body).includes(EM_DASH), false);
  assert.equal(String(hostileBody.body).includes("InjectedLine\n"), false);
});

test("zero retained state and zero PII logged on /api/caregiver-alert-preview", async () => {
  const prevQuiet = process.env.HOLDUP_QUIET;
  const origConsoleLog = console.log;
  const loggedLines: string[] = [];

  const canaryMed = "SecretCanaryMedicationX99";
  const canaryAllergy = "SecretCanaryAllergyQ77";
  const canaryPhone = "+3584099112233";
  const canaryEmail = "secret.canary.family@example.org";

  delete process.env.HOLDUP_QUIET;
  console.log = (...args: unknown[]) => {
    loggedLines.push(args.map(String).join(" "));
  };

  try {
    const res = await fetch(`${baseUrl}/api/caregiver-alert-preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        profile: {
          meds: [
            {
              id: "canary-id",
              name: canaryMed,
              ingredient: "amlodipine",
              strength: "5 mg",
              schedule: ["morning"],
            },
          ],
          allergies: [canaryAllergy],
          avoid: ["NSAIDs"],
          doseLog: [],
          lang: "sv",
        },
        contactPhone: canaryPhone,
        contactEmail: canaryEmail,
        nowIso: new Date(2026, 10, 14, 15, 0, 0).toISOString(),
      }),
    });
    assert.equal(res.status, 200);
  } finally {
    console.log = origConsoleLog;
    if (prevQuiet === undefined) delete process.env.HOLDUP_QUIET;
    else process.env.HOLDUP_QUIET = prevQuiet;
  }

  assert.equal(loggedLines.length, 1);
  assert.match(loggedLines[0], /api\.caregiver_preview lang=sv status=missed_dose$/);
  for (const secret of [canaryMed, canaryAllergy, canaryPhone, "3584099112233", canaryEmail]) {
    assert.equal(loggedLines[0].includes(secret), false, `Log must never contain ${secret}`);
  }

  assert.equal(hubStats().sessions, 0);

  const followUpRes = await fetch(`${baseUrl}/api/caregiver-alert-preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const followUpText = await followUpRes.text();
  for (const secret of [canaryMed, canaryAllergy, canaryPhone, "3584099112233", canaryEmail]) {
    assert.equal(followUpText.includes(secret), false, `Subsequent response leaked ${secret}`);
  }
});

test("caregiverAlert.ts and caregiver-alert-preview.test.ts contain zero comments, zero em dashes, zero trailers, and zero keys", () => {
  const doubleSlash = SLASH + SLASH;
  const blockOpen = SLASH + STAR;
  const blockClose = STAR + SLASH;
  const coAuthoredRe = new RegExp(CO_AUTHORED, "i");
  const apiKeyRe = new RegExp("AIza" + "[0-9A-Za-z_-]{20,}");

  for (const filePath of [IMPL_FILE, TEST_FILE]) {
    const src = fs.readFileSync(filePath, "utf8");
    const rel = path.relative(REPO_ROOT, filePath);
    assert.equal(src.includes(doubleSlash), false, `${rel} must not contain double-slash`);
    assert.equal(src.includes(blockOpen), false, `${rel} must not contain block comment open`);
    assert.equal(src.includes(blockClose), false, `${rel} must not contain block comment close`);
    assert.equal(src.includes(EM_DASH), false, `${rel} must not contain em dash`);
    assert.equal(coAuthoredRe.test(src), false, `${rel} must not contain trailer token`);
    assert.equal(apiKeyRe.test(src), false, `${rel} must not contain API key`);
  }
});
