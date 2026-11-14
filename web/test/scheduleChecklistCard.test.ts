import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ScheduleChecklistCard,
  buildDailyScheduleChecklist,
  formatLocalHhMm,
  normalizeScheduleSlot,
  resolveSlotForLocalHour,
  type MedAdherenceItem,
  type ScheduleChecklistCardProps,
  type ScheduleSlot
} from "../src/components/ScheduleChecklistCard.tsx";
import { DEMO_PROFILE, appendDoseLog, createMemoryStorage } from "../src/storage/profileStore.ts";
import type { Med, Profile } from "../src/types.ts";

type TestFn = (name: string, fn: () => void | Promise<void>) => Promise<void>;

type AssertStrict = {
  ok(value: unknown, message?: string): asserts value;
  equal<T>(actual: T, expected: T, message?: string): void;
  notEqual<T>(actual: T, expected: T, message?: string): void;
  deepEqual<T>(actual: T, expected: T, message?: string): void;
  match(value: string, regExp: RegExp, message?: string): void;
  doesNotMatch(value: string, regExp: RegExp, message?: string): void;
};

type FsModule = {
  readFileSync(path: URL | string, encoding: "utf8"): string;
};

const nodeTestSpec: string = "node:test";
const nodeAssertSpec: string = "node:assert/strict";
const nodeFsSpec: string = "node:fs";

const { test } = (await import(nodeTestSpec)) as { test: TestFn };
const assert: AssertStrict = (await import(nodeAssertSpec)) as AssertStrict;
const { readFileSync } = (await import(nodeFsSpec)) as FsModule;

const EM_DASH = "\u2014";
const EN_DASH = "\u2013";
const LINE_COMMENT = "\x2f\x2f";
const BLOCK_COMMENT_OPEN = "\x2f*";
const BLOCK_COMMENT_CLOSE = "*\x2f";
const noopVerify = (_med: Med): void => {};
const noopLog = (_medId: string): void => {};

function findMedItem(items: MedAdherenceItem[], medId: string): MedAdherenceItem {
  const found = items.find((entry) => entry.med.id === medId);
  assert.ok(found, `Expected adherence item for medId=${medId}`);
  return found;
}

function extractOpeningTagByClass(html: string, classToken: string): string {
  const escaped = classToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<([a-z0-9]+)\\b[^>]*class="[^"]*\\b${escaped}\\b[^"]*"[^>]*>`, "i");
  const match = pattern.exec(html);
  assert.ok(match, `Expected element with class "${classToken}"`);
  return match[0];
}

function extractOpeningTagsByClass(html: string, classToken: string): string[] {
  const escaped = classToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<([a-z0-9]+)\\b[^>]*class="[^"]*\\b${escaped}\\b[^"]*"[^>]*>`, "gi");
  const out: string[] = [];
  let match: RegExpExecArray | null = pattern.exec(html);
  while (match !== null) {
    out.push(match[0]);
    match = pattern.exec(html);
  }
  return out;
}

function extractIconSvg(html: string, iconKind: "check" | "clock" | "optional"): string {
  const marker = `data-schedule-icon="${iconKind}"`;
  const markerIdx = html.indexOf(marker);
  assert.ok(markerIdx >= 0, `Expected icon marker ${marker}`);
  const svgStart = html.lastIndexOf("<svg", markerIdx);
  const closeToken = "<" + "\x2fsvg>";
  const svgEnd = html.indexOf(closeToken, markerIdx);
  assert.ok(svgStart >= 0 && svgEnd > svgStart, `Expected full svg for ${iconKind}`);
  return html.slice(svgStart, svgEnd + closeToken.length);
}

test("buildDailyScheduleChecklist evaluates DEMO_PROFILE with 0 doses and ignores non-local-day entries", () => {
  const morningNow = new Date(2026, 10, 14, 8, 30, 0).getTime();
  const yesterdayEvening = new Date(2026, 10, 13, 20, 15, 0).getTime();
  const tomorrowMorning = new Date(2026, 10, 15, 7, 45, 0).getTime();

  const profileWithOtherDays: Profile = {
    ...DEMO_PROFILE,
    doseLog: [
      { medId: "aml", ts: yesterdayEvening },
      { medId: "met", ts: yesterdayEvening },
      { medId: "par", ts: tomorrowMorning }
    ]
  };

  const result = buildDailyScheduleChecklist(profileWithOtherDays, morningNow);

  assert.equal(result.currentSlot, "morning");
  assert.equal(result.completedRequired, 0);
  assert.equal(result.totalRequired, 3);
  assert.equal(result.items.length, 3);

  const aml = findMedItem(result.items, "aml");
  assert.equal(aml.slot, "evening");
  assert.equal(aml.requiredToday, 1);
  assert.equal(aml.takenToday, 0);
  assert.equal(aml.lastTakenTs, null);
  assert.equal(aml.status, "due");

  const met = findMedItem(result.items, "met");
  assert.equal(met.slot, "morning");
  assert.equal(met.requiredToday, 2);
  assert.equal(met.takenToday, 0);
  assert.equal(met.lastTakenTs, null);
  assert.equal(met.status, "due");

  const par = findMedItem(result.items, "par");
  assert.equal(par.slot, "as_needed");
  assert.equal(par.requiredToday, 0);
  assert.equal(par.takenToday, 0);
  assert.equal(par.lastTakenTs, null);
  assert.equal(par.status, "optional");
});

test("buildDailyScheduleChecklist tracks partial Metformin 1/2 doses, completed Amlodipin 5 mg, and PRN Panadol 500 mg", () => {
  const storage = createMemoryStorage();
  const metMorningTs = new Date(2026, 10, 14, 8, 15, 0).getTime();
  const amlEveningTs = new Date(2026, 10, 14, 19, 45, 0).getTime();
  const eveningCheckMs = new Date(2026, 10, 14, 20, 0, 0).getTime();

  const afterMorningMet = appendDoseLog(DEMO_PROFILE, "met", metMorningTs, storage);
  const partialResult = buildDailyScheduleChecklist(afterMorningMet, eveningCheckMs);

  assert.equal(partialResult.currentSlot, "evening");
  assert.equal(partialResult.completedRequired, 1);
  assert.equal(partialResult.totalRequired, 3);

  const partialMet = findMedItem(partialResult.items, "met");
  assert.equal(partialMet.requiredToday, 2);
  assert.equal(partialMet.takenToday, 1);
  assert.equal(partialMet.lastTakenTs, metMorningTs);
  assert.equal(partialMet.status, "due");
  assert.equal(partialMet.slot, "evening");

  const afterAml = appendDoseLog(afterMorningMet, "aml", amlEveningTs, storage);
  const withCompletedAml = buildDailyScheduleChecklist(afterAml, eveningCheckMs);

  assert.equal(withCompletedAml.completedRequired, 2);
  assert.equal(withCompletedAml.totalRequired, 3);

  const completedAml = findMedItem(withCompletedAml.items, "aml");
  assert.equal(completedAml.med.name, "Amlodipin");
  assert.equal(completedAml.med.strength, "5 mg");
  assert.equal(completedAml.requiredToday, 1);
  assert.equal(completedAml.takenToday, 1);
  assert.equal(completedAml.lastTakenTs, amlEveningTs);
  assert.equal(completedAml.status, "complete");
  assert.equal(completedAml.slot, "evening");

  const parUntaken = findMedItem(withCompletedAml.items, "par");
  assert.equal(parUntaken.med.name, "Panadol");
  assert.equal(parUntaken.med.strength, "500 mg");
  assert.equal(parUntaken.requiredToday, 0);
  assert.equal(parUntaken.takenToday, 0);
  assert.equal(parUntaken.lastTakenTs, null);
  assert.equal(parUntaken.status, "optional");
  assert.equal(parUntaken.slot, "as_needed");

  const panadolTs = new Date(2026, 10, 14, 20, 5, 0).getTime();
  const afterPanadol = appendDoseLog(afterAml, "par", panadolTs, storage);
  const withTakenPrn = buildDailyScheduleChecklist(afterPanadol, eveningCheckMs);

  assert.equal(withTakenPrn.completedRequired, 2);
  assert.equal(withTakenPrn.totalRequired, 3);

  const parTaken = findMedItem(withTakenPrn.items, "par");
  assert.equal(parTaken.requiredToday, 0);
  assert.equal(parTaken.takenToday, 1);
  assert.equal(parTaken.lastTakenTs, panadolTs);
  assert.equal(parTaken.status, "complete");
  assert.equal(parTaken.slot, "as_needed");

  const metEveningTs = new Date(2026, 10, 14, 20, 20, 0).getTime();
  const afterSecondMet = appendDoseLog(afterPanadol, "met", metEveningTs, storage);
  const allComplete = buildDailyScheduleChecklist(afterSecondMet, eveningCheckMs);

  assert.equal(allComplete.completedRequired, 3);
  assert.equal(allComplete.totalRequired, 3);

  const completedMet = findMedItem(allComplete.items, "met");
  assert.equal(completedMet.takenToday, 2);
  assert.equal(completedMet.requiredToday, 2);
  assert.equal(completedMet.lastTakenTs, metEveningTs);
  assert.equal(completedMet.status, "complete");
});

test("resolveSlotForLocalHour and buildDailyScheduleChecklist compute local-hour currentSlot and normalize schedule variants", () => {
  const expectedByHour: ReadonlyArray<[number, ScheduleSlot]> = [
    [0, "bedtime"],
    [4, "bedtime"],
    [5, "morning"],
    [8, "morning"],
    [10, "morning"],
    [11, "noon"],
    [13, "noon"],
    [15, "noon"],
    [16, "evening"],
    [19, "evening"],
    [21, "evening"],
    [22, "bedtime"],
    [23, "bedtime"]
  ];

  for (const [hour, expectedSlot] of expectedByHour) {
    assert.equal(resolveSlotForLocalHour(hour), expectedSlot, `Hour ${hour} should map to ${expectedSlot}`);
    const localMs = new Date(2026, 10, 14, hour, 15, 0).getTime();
    const built = buildDailyScheduleChecklist(DEMO_PROFILE, localMs);
    assert.equal(built.currentSlot, expectedSlot);
  }

  const defaultNowResult = buildDailyScheduleChecklist(DEMO_PROFILE);
  assert.equal(defaultNowResult.totalRequired, 3);
  assert.equal(defaultNowResult.items.length, 3);

  assert.equal(normalizeScheduleSlot("morning"), "morning");
  assert.equal(normalizeScheduleSlot("noon"), "noon");
  assert.equal(normalizeScheduleSlot("midday"), "noon");
  assert.equal(normalizeScheduleSlot("evening"), "evening");
  assert.equal(normalizeScheduleSlot("night"), "bedtime");
  assert.equal(normalizeScheduleSlot("bedtime"), "bedtime");
  assert.equal(normalizeScheduleSlot("as needed"), "as_needed");
  assert.equal(normalizeScheduleSlot("PRN"), "as_needed");

  const customProfile: Profile = {
    meds: [
      { id: "vitd", name: "Vitamin D", ingredient: "colecalciferol", strength: "20 mcg", schedule: ["midday"] },
      { id: "mel", name: "Melatonin", ingredient: "melatonin", strength: "3 mg", schedule: ["night"] },
      { id: "cet", name: "Heinix", ingredient: "cetirizine", strength: "10 mg", schedule: ["prn"] }
    ],
    allergies: [],
    avoid: [],
    doseLog: [],
    lang: "en"
  };

  const customChecklist = buildDailyScheduleChecklist(
    customProfile,
    new Date(2026, 10, 14, 12, 0, 0).getTime()
  );
  assert.equal(customChecklist.currentSlot, "noon");
  assert.equal(customChecklist.totalRequired, 2);
  assert.equal(findMedItem(customChecklist.items, "vitd").slot, "noon");
  assert.equal(findMedItem(customChecklist.items, "mel").slot, "bedtime");
  assert.equal(findMedItem(customChecklist.items, "cet").slot, "as_needed");
  assert.equal(findMedItem(customChecklist.items, "cet").status, "optional");

  const timesAliasMed = {
    id: "lev",
    name: "Thyroxin",
    ingredient: "levothyroxine",
    strength: "50 mcg",
    schedule: [],
    times: ["morning"]
  } as Med;
  const noonNowMs = new Date(2026, 10, 14, 12, 30, 0).getTime();
  const cappedChecklist = buildDailyScheduleChecklist(
    {
      meds: [timesAliasMed],
      allergies: [],
      avoid: [],
      doseLog: [
        { medId: "lev", ts: new Date(2026, 10, 14, 7, 30, 0).getTime() },
        { medId: "lev", ts: new Date(2026, 10, 14, 8, 0, 0).getTime() }
      ],
      lang: "en"
    },
    noonNowMs
  );
  assert.equal(cappedChecklist.totalRequired, 1);
  assert.equal(cappedChecklist.completedRequired, 1);
  assert.equal(findMedItem(cappedChecklist.items, "lev").takenToday, 2);
  assert.equal(findMedItem(cappedChecklist.items, "lev").status, "complete");
});

test("ScheduleChecklistCard SSR renders summary, active window badge, geometric icons, HH:MM timestamp, and >= 48px action buttons", () => {
  const storage = createMemoryStorage();
  const metMorningTs = new Date(2026, 10, 14, 8, 5, 0).getTime();
  const amlEveningTs = new Date(2026, 10, 14, 19, 45, 0).getTime();
  const eveningNowMs = new Date(2026, 10, 14, 20, 10, 0).getTime();

  let profile = appendDoseLog(DEMO_PROFILE, "met", metMorningTs, storage);
  profile = appendDoseLog(profile, "aml", amlEveningTs, storage);

  assert.equal(formatLocalHhMm(metMorningTs), "08:05");
  assert.equal(formatLocalHhMm(amlEveningTs), "19:45");

  const html = renderToStaticMarkup(
    createElement(ScheduleChecklistCard, {
      profile,
      lang: "en",
      nowMs: eveningNowMs,
      onVerifyMed: noopVerify,
      onLogDose: noopLog
    })
  );

  const sectionTag = extractOpeningTagByClass(html, "schedule-checklist-card");
  assert.ok(sectionTag.startsWith("<section"));
  assert.ok(sectionTag.includes('aria-labelledby="'));
  assert.ok(sectionTag.includes('lang="en"'));
  assert.ok(sectionTag.includes('data-current-slot="evening"'));

  assert.ok(html.includes("2 of 3 scheduled doses logged today"));
  assert.ok(html.includes("Evening window"));
  assert.ok(html.includes("Amlodipin 5 mg"));
  assert.ok(html.includes("Metformin 500 mg"));
  assert.ok(html.includes("Panadol 500 mg"));
  assert.ok(html.includes("1/2 doses today"));
  assert.ok(html.includes("1/1 doses today"));
  assert.ok(html.includes("PRN: 0 logged today"));
  assert.ok(html.includes("Last taken 08:05"));
  assert.ok(html.includes("Last taken 19:45"));
  assert.ok(html.includes("Not taken today"));

  const checkSvg = extractIconSvg(html, "check");
  const clockSvg = extractIconSvg(html, "clock");
  const optionalSvg = extractIconSvg(html, "optional");
  const distinctSvgs = new Set([checkSvg, clockSvg, optionalSvg]);
  assert.equal(distinctSvgs.size, 3, "check, clock, and optional icons must have distinct geometric SVGs");

  const verifyButtons = extractOpeningTagsByClass(html, "schedule-verify-btn");
  const logButtons = extractOpeningTagsByClass(html, "schedule-log-btn");
  assert.equal(verifyButtons.length, 3);
  assert.equal(logButtons.length, 3);
  assert.ok(html.includes("<span>Check Label<" + "\x2fspan>"));
  assert.ok(html.includes("<span>Log Taken<" + "\x2fspan>"));

  for (const btnTag of [...verifyButtons, ...logButtons]) {
    const minHeightMatch = /min-height:(\d+)px/.exec(btnTag);
    const minWidthMatch = /min-width:(\d+)px/.exec(btnTag);
    assert.ok(minHeightMatch, "Action button must declare min-height in px");
    assert.ok(minWidthMatch, "Action button must declare min-width in px");
    assert.ok(Number.parseInt(minHeightMatch[1], 10) >= 48);
    assert.ok(Number.parseInt(minWidthMatch[1], 10) >= 48);
  }

  const readOnlyHtml = renderToStaticMarkup(
    createElement(ScheduleChecklistCard, {
      profile,
      lang: "en",
      nowMs: eveningNowMs
    })
  );
  assert.equal(readOnlyHtml.includes("schedule-verify-btn"), false);
  assert.equal(readOnlyHtml.includes("schedule-log-btn"), false);
});

test("ScheduleChecklistCard localizes across en, fi, and sv with fallback to en", () => {
  const storage = createMemoryStorage();
  const doseTs = new Date(2026, 10, 14, 8, 20, 0).getTime();
  const eveningMs = new Date(2026, 10, 14, 18, 30, 0).getTime();
  const profile = appendDoseLog(DEMO_PROFILE, "met", doseTs, storage);

  const makeProps = (lang: string): ScheduleChecklistCardProps => ({
    profile,
    lang,
    nowMs: eveningMs,
    onVerifyMed: noopVerify,
    onLogDose: noopLog
  });

  const enHtml = renderToStaticMarkup(createElement(ScheduleChecklistCard, makeProps("en")));
  const fiHtml = renderToStaticMarkup(createElement(ScheduleChecklistCard, makeProps("fi")));
  const svHtml = renderToStaticMarkup(createElement(ScheduleChecklistCard, makeProps("sv")));
  const fiRegionalHtml = renderToStaticMarkup(createElement(ScheduleChecklistCard, makeProps("fi-FI")));
  const fallbackHtml = renderToStaticMarkup(createElement(ScheduleChecklistCard, makeProps("de-DE")));

  assert.notEqual(enHtml, fiHtml);
  assert.notEqual(enHtml, svHtml);
  assert.notEqual(fiHtml, svHtml);
  assert.equal(fiRegionalHtml, fiHtml);
  assert.equal(fallbackHtml, enHtml);

  assert.ok(enHtml.includes("Did I Take My Pills?"));
  assert.ok(enHtml.includes("1 of 3 scheduled doses logged today"));
  assert.ok(enHtml.includes("Evening window"));
  assert.ok(enHtml.includes("Check Label"));
  assert.ok(enHtml.includes("Log Taken"));

  assert.ok(fiHtml.includes('lang="fi"'));
  assert.ok(fiHtml.includes("Otinko lääkkeeni tänään?"));
  assert.ok(fiHtml.includes("1 / 3 säännöllistä annosta kirjattu tänään"));
  assert.ok(fiHtml.includes("Iltaikkuna"));
  assert.ok(fiHtml.includes("Tarkista etiketti"));
  assert.ok(fiHtml.includes("Kirjaa otetuksi"));

  assert.ok(svHtml.includes('lang="sv"'));
  assert.ok(svHtml.includes("Tog jag mina mediciner idag?"));
  assert.ok(svHtml.includes("1 av 3 schemalagda doser registrerade idag"));
  assert.ok(svHtml.includes("Kvällsfönster"));
  assert.ok(svHtml.includes("Kontrollera etikett"));
  assert.ok(svHtml.includes("Registrera tagen"));
});

test("ScheduleChecklistCard and test suite contain zero code comments and zero em or en dashes", () => {
  const componentSource = readFileSync(
    new URL("../src/components/ScheduleChecklistCard.tsx", import.meta.url),
    "utf8"
  );
  const testSource = readFileSync(
    new URL("./scheduleChecklistCard.test.ts", import.meta.url),
    "utf8"
  );

  for (const [label, source] of [
    ["ScheduleChecklistCard.tsx", componentSource],
    ["scheduleChecklistCard.test.ts", testSource]
  ] as const) {
    assert.equal(source.includes(LINE_COMMENT), false, `${label} must not contain line comments`);
    assert.equal(source.includes(BLOCK_COMMENT_OPEN), false, `${label} must not contain block comments`);
    assert.equal(source.includes(BLOCK_COMMENT_CLOSE), false, `${label} must not contain block comment closures`);
    assert.equal(source.includes(EM_DASH), false, `${label} must not contain em dashes`);
    assert.equal(source.includes(EN_DASH), false, `${label} must not contain en dashes`);
  }

  const storage = createMemoryStorage();
  const sampleTs = new Date(2026, 10, 14, 9, 10, 0).getTime();
  const partialProfile = appendDoseLog(DEMO_PROFILE, "met", sampleTs, storage);
  const fullProfile = appendDoseLog(
    appendDoseLog(partialProfile, "met", sampleTs + 3600000, storage),
    "aml",
    sampleTs + 7200000,
    storage
  );
  const emptyProfile: Profile = { meds: [], allergies: [], avoid: [], doseLog: [], lang: "en" };

  const hours = [2, 8, 13, 19, 23];
  const locales = ["en", "fi", "sv", "de", "es"];

  for (const lang of locales) {
    for (const hour of hours) {
      const nowMs = new Date(2026, 10, 14, hour, 0, 0).getTime();
      for (const profile of [DEMO_PROFILE, partialProfile, fullProfile, emptyProfile]) {
        const html = renderToStaticMarkup(
          createElement(ScheduleChecklistCard, {
            profile,
            lang,
            nowMs,
            onVerifyMed: noopVerify,
            onLogDose: noopLog
          })
        );
        assert.equal(html.includes(EM_DASH), false);
        assert.equal(html.includes(EN_DASH), false);
      }
    }
  }
});
