import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DoseTimelineCard,
  buildDoseTimeline,
  formatTimelineDate,
  formatTimelineHhMm,
  type DoseTimelineCardProps
} from "../src/components/DoseTimelineCard.tsx";
import {
  DEMO_PROFILE,
  appendDoseLog,
  createMemoryStorage,
  undoLastDose
} from "../src/storage/profileStore.ts";
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
const noopUndo = (): void => {};

function extractOpeningTagByClass(html: string, classToken: string): string {
  const escaped = classToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<([a-z0-9]+)\\b[^>]*class="[^"]*\\b${escaped}\\b[^"]*"[^>]*>`, "i");
  const match = pattern.exec(html);
  assert.ok(match, `Expected element with class "${classToken}"`);
  return match[0];
}

function extractTimelineIconSvg(html: string, iconKind: "logged" | "duplicate" | "empty" | "undo"): string {
  const marker = `data-timeline-icon="${iconKind}"`;
  const markerIdx = html.indexOf(marker);
  assert.ok(markerIdx >= 0, `Expected icon marker ${marker}`);
  const svgStart = html.lastIndexOf("<svg", markerIdx);
  const closeToken = "</svg>";
  const svgEnd = html.indexOf(closeToken, markerIdx);
  assert.ok(svgStart >= 0 && svgEnd > svgStart, `Expected full svg for ${iconKind}`);
  return html.slice(svgStart, svgEnd + closeToken.length);
}

test("buildDoseTimeline returns empty list for empty doseLog and filters outside 7-day local calendar window", () => {
  const nowMs = new Date(2026, 10, 14, 20, 0, 0).getTime();

  assert.deepEqual(buildDoseTimeline(DEMO_PROFILE, nowMs), []);

  const sixDaysAgo = new Date(2026, 10, 8, 9, 15, 0).getTime();
  const sevenDaysAgo = new Date(2026, 10, 7, 23, 50, 0).getTime();
  const tenDaysAgo = new Date(2026, 10, 4, 12, 0, 0).getTime();
  const tomorrowMorning = new Date(2026, 10, 15, 8, 0, 0).getTime();

  const boundaryProfile: Profile = {
    ...DEMO_PROFILE,
    doseLog: [
      { medId: "aml", ts: tenDaysAgo },
      { medId: "met", ts: sevenDaysAgo },
      { medId: "par", ts: sixDaysAgo },
      { medId: "aml", ts: tomorrowMorning },
      { medId: "   ", ts: nowMs }
    ]
  };

  const timeline = buildDoseTimeline(boundaryProfile, nowMs);
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].medId, "par");
  assert.equal(timeline[0].medName, "Panadol");
  assert.equal(timeline[0].strength, "500 mg");
  assert.equal(timeline[0].dayBucket, "earlier");
  assert.equal(timeline[0].dateLabel, "2026-11-08");
  assert.equal(timeline[0].timeLabel, "09:15");
  assert.equal(timeline[0].duplicateWithinDay, false);
});

test("buildDoseTimeline sorts newest-first across today, yesterday, and earlier buckets and honors maxEntries", () => {
  const nowMs = new Date(2026, 10, 14, 21, 30, 0).getTime();
  const earlierFiveDays = new Date(2026, 10, 9, 8, 5, 0).getTime();
  const earlierTwoDays = new Date(2026, 10, 12, 19, 45, 0).getTime();
  const yesterdayMorning = new Date(2026, 10, 13, 7, 30, 0).getTime();
  const todayMorning = new Date(2026, 10, 14, 8, 10, 0).getTime();
  const todayEvening = new Date(2026, 10, 14, 20, 5, 0).getTime();

  const profile: Profile = {
    ...DEMO_PROFILE,
    doseLog: [
      { medId: "aml", ts: earlierTwoDays },
      { medId: "met", ts: todayMorning },
      { medId: "par", ts: earlierFiveDays },
      { medId: "aml", ts: todayEvening },
      { medId: "met", ts: yesterdayMorning }
    ]
  };

  const full = buildDoseTimeline(profile, nowMs);
  assert.equal(full.length, 5);
  assert.deepEqual(
    full.map((e) => e.ts),
    [todayEvening, todayMorning, yesterdayMorning, earlierTwoDays, earlierFiveDays]
  );
  assert.deepEqual(
    full.map((e) => e.dayBucket),
    ["today", "today", "yesterday", "earlier", "earlier"]
  );
  assert.deepEqual(
    full.map((e) => e.timeLabel),
    ["20:05", "08:10", "07:30", "19:45", "08:05"]
  );
  assert.deepEqual(
    full.map((e) => e.dateLabel),
    ["2026-11-14", "2026-11-14", "2026-11-13", "2026-11-12", "2026-11-09"]
  );

  assert.equal(formatTimelineHhMm(todayEvening), "20:05");
  assert.equal(formatTimelineDate(todayEvening), "2026-11-14");

  const cappedTwo = buildDoseTimeline(profile, nowMs, 2);
  assert.equal(cappedTwo.length, 2);
  assert.equal(cappedTwo[0].ts, todayEvening);
  assert.equal(cappedTwo[1].ts, todayMorning);

  const cappedZero = buildDoseTimeline(profile, nowMs, 0);
  assert.deepEqual(cappedZero, []);
});

test("buildDoseTimeline flags duplicateWithinDay when scheduled med exceeds daily times count on the same day", () => {
  const nowMs = new Date(2026, 10, 14, 22, 0, 0).getTime();
  const yesterdayAml = new Date(2026, 10, 13, 19, 15, 0).getTime();
  const todayAmlFirst = new Date(2026, 10, 14, 18, 45, 0).getTime();
  const todayAmlSecond = new Date(2026, 10, 14, 20, 30, 0).getTime();
  const todayMetFirst = new Date(2026, 10, 14, 8, 0, 0).getTime();
  const todayMetSecond = new Date(2026, 10, 14, 19, 0, 0).getTime();
  const todayParFirst = new Date(2026, 10, 14, 11, 0, 0).getTime();
  const todayParSecond = new Date(2026, 10, 14, 15, 30, 0).getTime();

  const profile: Profile = {
    ...DEMO_PROFILE,
    doseLog: [
      { medId: "aml", ts: yesterdayAml },
      { medId: "met", ts: todayMetFirst },
      { medId: "par", ts: todayParFirst },
      { medId: "par", ts: todayParSecond },
      { medId: "aml", ts: todayAmlFirst },
      { medId: "met", ts: todayMetSecond },
      { medId: "aml", ts: todayAmlSecond }
    ]
  };

  const entries = buildDoseTimeline(profile, nowMs);
  assert.equal(entries.length, 7);

  const newestAml = entries.find((e) => e.medId === "aml" && e.ts === todayAmlSecond);
  const firstTodayAml = entries.find((e) => e.medId === "aml" && e.ts === todayAmlFirst);
  const prevDayAml = entries.find((e) => e.medId === "aml" && e.ts === yesterdayAml);

  assert.ok(newestAml);
  assert.ok(firstTodayAml);
  assert.ok(prevDayAml);
  assert.equal(newestAml.duplicateWithinDay, true);
  assert.equal(firstTodayAml.duplicateWithinDay, false);
  assert.equal(prevDayAml.duplicateWithinDay, false);

  for (const metEntry of entries.filter((e) => e.medId === "met")) {
    assert.equal(metEntry.duplicateWithinDay, false);
  }
  for (const parEntry of entries.filter((e) => e.medId === "par")) {
    assert.equal(parEntry.duplicateWithinDay, false);
  }

  const topOne = buildDoseTimeline(profile, nowMs, 1);
  assert.equal(topOne.length, 1);
  assert.equal(topOne[0].medId, "aml");
  assert.equal(topOne[0].duplicateWithinDay, true);

  const legacyTimesMed = {
    id: "thy",
    name: "Thyroxin",
    ingredient: "levothyroxine",
    strength: "50 mcg",
    schedule: [],
    times: ["morning"]
  } as Med;
  const legacyProfile: Profile = {
    meds: [legacyTimesMed],
    allergies: [],
    avoid: [],
    doseLog: [
      { medId: "thy", ts: new Date(2026, 10, 14, 7, 15, 0).getTime() },
      { medId: "thy", ts: new Date(2026, 10, 14, 9, 45, 0).getTime() }
    ],
    lang: "en"
  };
  const legacyTimeline = buildDoseTimeline(legacyProfile, nowMs);
  assert.equal(legacyTimeline.length, 2);
  assert.equal(legacyTimeline[0].duplicateWithinDay, true);
  assert.equal(legacyTimeline[1].duplicateWithinDay, false);
});

test("buildDoseTimeline and DoseTimelineCard fall back cleanly to medId when medication was deleted", () => {
  const nowMs = new Date(2026, 10, 14, 18, 0, 0).getTime();
  const removedFirstTs = new Date(2026, 10, 14, 9, 0, 0).getTime();
  const removedSecondTs = new Date(2026, 10, 14, 14, 20, 0).getTime();

  const profileWithRemovedMed: Profile = {
    ...DEMO_PROFILE,
    doseLog: [
      { medId: "deleted-atorva-20", ts: removedFirstTs },
      { medId: "deleted-atorva-20", ts: removedSecondTs }
    ]
  };

  const timeline = buildDoseTimeline(profileWithRemovedMed, nowMs);
  assert.equal(timeline.length, 2);
  assert.equal(timeline[0].medId, "deleted-atorva-20");
  assert.equal(timeline[0].medName, "deleted-atorva-20");
  assert.equal(timeline[0].strength, "");
  assert.equal(timeline[0].duplicateWithinDay, false);

  const html = renderToStaticMarkup(
    createElement(DoseTimelineCard, {
      profile: profileWithRemovedMed,
      lang: "en",
      nowMs
    })
  );
  assert.ok(html.includes("deleted-atorva-20"));
  assert.ok(html.includes("Removed from saved medications"));
  assert.equal(html.includes("dose-timeline-undo-btn"), false);
});

test("DoseTimelineCard SSR renders empty state, multi-day ordered list, SVG badges, HH:MM times, privacy pill, and >= 48px Undo button", () => {
  const nowMs = new Date(2026, 10, 14, 21, 0, 0).getTime();

  const emptyHtml = renderToStaticMarkup(
    createElement(DoseTimelineCard, {
      profile: DEMO_PROFILE,
      lang: "en",
      nowMs,
      onUndoLastDose: noopUndo
    })
  );

  const emptySectionTag = extractOpeningTagByClass(emptyHtml, "dose-timeline-card");
  assert.ok(emptySectionTag.startsWith("<section"));
  assert.ok(emptySectionTag.includes('aria-labelledby="'));
  assert.ok(emptySectionTag.includes('lang="en"'));
  assert.ok(emptySectionTag.includes('data-today-count="0"'));
  assert.ok(emptySectionTag.includes('data-week-count="0"'));
  assert.ok(emptyHtml.includes("0 doses today, 0 in past 7 days"));
  assert.ok(emptyHtml.includes("No doses logged in the past 7 days on this device."));
  assert.ok(emptyHtml.includes("Stored on device only"));
  assert.equal(emptyHtml.includes("<ol"), false);
  assert.equal(emptyHtml.includes("dose-timeline-undo-btn"), false);

  const storage = createMemoryStorage();
  const earlierTs = new Date(2026, 10, 10, 8, 30, 0).getTime();
  const yesterdayTs = new Date(2026, 10, 13, 19, 10, 0).getTime();
  const todayFirstAmlTs = new Date(2026, 10, 14, 18, 20, 0).getTime();
  const todayDupAmlTs = new Date(2026, 10, 14, 20, 45, 0).getTime();

  let populated = appendDoseLog(DEMO_PROFILE, "met", earlierTs, storage);
  populated = appendDoseLog(populated, "par", yesterdayTs, storage);
  populated = appendDoseLog(populated, "aml", todayFirstAmlTs, storage);
  populated = appendDoseLog(populated, "aml", todayDupAmlTs, storage);

  const populatedHtml = renderToStaticMarkup(
    createElement(DoseTimelineCard, {
      profile: populated,
      lang: "en",
      nowMs,
      onUndoLastDose: noopUndo
    })
  );

  assert.ok(populatedHtml.includes("<ol"));
  assert.ok(populatedHtml.includes("2 doses today, 4 in past 7 days"));
  assert.ok(populatedHtml.includes("Today: 2"));
  assert.ok(populatedHtml.includes("Past 7 days: 4"));
  assert.ok(populatedHtml.includes("1 extra same-day dose flagged above daily schedule."));
  assert.ok(populatedHtml.includes("Amlodipin 5 mg"));
  assert.ok(populatedHtml.includes("Panadol 500 mg"));
  assert.ok(populatedHtml.includes("Metformin 500 mg"));
  assert.ok(populatedHtml.includes("20:45"));
  assert.ok(populatedHtml.includes("18:20"));
  assert.ok(populatedHtml.includes("19:10"));
  assert.ok(populatedHtml.includes("08:30"));
  assert.ok(populatedHtml.includes('data-bucket="today"'));
  assert.ok(populatedHtml.includes('data-bucket="yesterday"'));
  assert.ok(populatedHtml.includes('data-bucket="earlier"'));

  const loggedSvg = extractTimelineIconSvg(populatedHtml, "logged");
  const duplicateSvg = extractTimelineIconSvg(populatedHtml, "duplicate");
  const emptySvg = extractTimelineIconSvg(emptyHtml, "empty");
  const undoSvg = extractTimelineIconSvg(populatedHtml, "undo");
  assert.equal(new Set([loggedSvg, duplicateSvg, emptySvg, undoSvg]).size, 4);

  const undoBtnTag = extractOpeningTagByClass(populatedHtml, "dose-timeline-undo-btn");
  assert.ok(populatedHtml.includes("<span>Undo Last Dose</span>"));
  const minHeightMatch = /min-height:(\d+)px/.exec(undoBtnTag);
  const minWidthMatch = /min-width:(\d+)px/.exec(undoBtnTag);
  assert.ok(minHeightMatch, "Undo button must declare min-height in px");
  assert.ok(minWidthMatch, "Undo button must declare min-width in px");
  assert.ok(Number.parseInt(minHeightMatch[1], 10) >= 48);
  assert.ok(Number.parseInt(minWidthMatch[1], 10) >= 48);

  const afterUndo = undoLastDose(populated, storage);
  const afterUndoEntries = buildDoseTimeline(afterUndo, nowMs);
  assert.equal(afterUndoEntries.length, 3);
  assert.equal(afterUndoEntries.some((e) => e.duplicateWithinDay), false);
});

test("DoseTimelineCard localizes across en, fi, and sv with fallback to en", () => {
  const storage = createMemoryStorage();
  const nowMs = new Date(2026, 10, 14, 20, 30, 0).getTime();
  let profile = appendDoseLog(DEMO_PROFILE, "met", new Date(2026, 10, 11, 8, 0, 0).getTime(), storage);
  profile = appendDoseLog(profile, "par", new Date(2026, 10, 13, 14, 15, 0).getTime(), storage);
  profile = appendDoseLog(profile, "aml", new Date(2026, 10, 14, 19, 0, 0).getTime(), storage);

  const makeProps = (lang: string): DoseTimelineCardProps => ({
    profile,
    lang,
    nowMs,
    onUndoLastDose: noopUndo
  });

  const enHtml = renderToStaticMarkup(createElement(DoseTimelineCard, makeProps("en")));
  const fiHtml = renderToStaticMarkup(createElement(DoseTimelineCard, makeProps("fi")));
  const svHtml = renderToStaticMarkup(createElement(DoseTimelineCard, makeProps("sv")));
  const fiRegionalHtml = renderToStaticMarkup(createElement(DoseTimelineCard, makeProps("fi-FI")));
  const svRegionalHtml = renderToStaticMarkup(createElement(DoseTimelineCard, makeProps("sv-SE")));
  const fallbackHtml = renderToStaticMarkup(createElement(DoseTimelineCard, makeProps("de-DE")));

  assert.notEqual(enHtml, fiHtml);
  assert.notEqual(enHtml, svHtml);
  assert.notEqual(fiHtml, svHtml);
  assert.equal(fiRegionalHtml, fiHtml);
  assert.equal(svRegionalHtml, svHtml);
  assert.equal(fallbackHtml, enHtml);

  assert.ok(enHtml.includes('lang="en"'));
  assert.ok(enHtml.includes("7-Day Dose Timeline"));
  assert.ok(enHtml.includes("1 dose today, 3 in past 7 days"));
  assert.ok(enHtml.includes("Undo Last Dose"));
  assert.ok(enHtml.includes("Stored on device only"));
  assert.ok(enHtml.includes(">Today<"));
  assert.ok(enHtml.includes(">Yesterday<"));
  assert.ok(enHtml.includes(">Earlier<"));

  assert.ok(fiHtml.includes('lang="fi"'));
  assert.ok(fiHtml.includes("7 päivän annoshistoria"));
  assert.ok(fiHtml.includes("1 annos tänään, 3 viimeisen 7 päivän aikana"));
  assert.ok(fiHtml.includes("Kumoa viimeisin annos"));
  assert.ok(fiHtml.includes("Vain tällä laitteella"));
  assert.ok(fiHtml.includes(">Tänään<"));
  assert.ok(fiHtml.includes(">Eilen<"));
  assert.ok(fiHtml.includes(">Aiemmin<"));

  assert.ok(svHtml.includes('lang="sv"'));
  assert.ok(svHtml.includes("7-dagars doshistorik"));
  assert.ok(svHtml.includes("1 dos idag, 3 senaste 7 dagarna"));
  assert.ok(svHtml.includes("Ångra senaste dos"));
  assert.ok(svHtml.includes("Endast på den här enheten"));
  assert.ok(svHtml.includes(">Idag<"));
  assert.ok(svHtml.includes(">Igår<"));
  assert.ok(svHtml.includes(">Tidigare<"));
});

test("DoseTimelineCard and test suite contain zero code comments and zero em or en dashes", () => {
  const componentSource = readFileSync(
    new URL("../src/components/DoseTimelineCard.tsx", import.meta.url),
    "utf8"
  );
  const testSource = readFileSync(
    new URL("./doseTimelineCard.test.ts", import.meta.url),
    "utf8"
  );

  for (const [label, source] of [
    ["DoseTimelineCard.tsx", componentSource],
    ["doseTimelineCard.test.ts", testSource]
  ] as const) {
    assert.equal(source.includes(LINE_COMMENT), false, `${label} must not contain line comments`);
    assert.equal(source.includes(BLOCK_COMMENT_OPEN), false, `${label} must not contain block comments`);
    assert.equal(source.includes(BLOCK_COMMENT_CLOSE), false, `${label} must not contain block comment closures`);
    assert.equal(source.includes(EM_DASH), false, `${label} must not contain em dashes`);
    assert.equal(source.includes(EN_DASH), false, `${label} must not contain en dashes`);
  }

  const nowMs = new Date(2026, 10, 14, 20, 0, 0).getTime();
  const dupProfile: Profile = {
    ...DEMO_PROFILE,
    doseLog: [
      { medId: "aml", ts: new Date(2026, 10, 14, 18, 0, 0).getTime() },
      { medId: "aml", ts: new Date(2026, 10, 14, 19, 30, 0).getTime() },
      { medId: "removed-med", ts: new Date(2026, 10, 13, 9, 0, 0).getTime() }
    ]
  };

  for (const lang of ["en", "fi", "sv", "de", "es"]) {
    for (const profile of [DEMO_PROFILE, dupProfile]) {
      const html = renderToStaticMarkup(
        createElement(DoseTimelineCard, {
          profile,
          lang,
          nowMs,
          onUndoLastDose: noopUndo
        })
      );
      assert.equal(html.includes(EM_DASH), false);
      assert.equal(html.includes(EN_DASH), false);
    }
  }
});
