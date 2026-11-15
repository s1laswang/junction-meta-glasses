import { describe, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LabelRead, ServerMsg, Verdict } from "../../shared/types.ts";
import { checkLabelText } from "../../server/src/safety.ts";
import { demoProfile } from "../src/lib/storage.ts";
import {
  emptyRead,
  matchVerdict,
  mockFoodNuts,
  mockUnsureStrength,
  mockWarningIbuprofen,
} from "../src/lib/verdicts.ts";
import { MockSocket, mockCtl, pickScenario } from "../src/lib/mock.ts";

const TEST_FILE = fileURLToPath(import.meta.url);
const TEST_DIR = path.dirname(TEST_FILE);
const REPO_DIR = path.resolve(TEST_DIR, "..", "..");
const EM_DASH = String.fromCharCode(0x2014);
const LINE_COMMENT = String.fromCharCode(47, 47);
const BLOCK_COMMENT_OPEN = String.fromCharCode(47, 42);
const HTML_COMMENT_OPEN = "<" + "!--";

function readRepoFile(relPath: string): string {
  return fs.readFileSync(path.join(REPO_DIR, relPath), "utf8");
}

function parseTimestampSec(mmss: string): number {
  const match = /^(\d+):(\d{2})$/.exec(mmss.trim());
  assert.ok(match, `Invalid M:SS timestamp: "${mmss}"`);
  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  assert.ok(seconds >= 0 && seconds < 60, `Seconds out of range in "${mmss}"`);
  return minutes * 60 + seconds;
}

function parseMarkdownTableRows(section: string): string[][] {
  const lines = section
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|") && l.endsWith("|"));
  assert.ok(lines.length >= 3, "Expected Markdown table with header, separator, and data rows");
  return lines.slice(2).map((line) =>
    line
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim()),
  );
}

function extractSlideSection(deckHtml: string, slideNum: number): string {
  const idToken = `id="s${slideNum}-h"`;
  const headingIdx = deckHtml.indexOf(idToken);
  assert.ok(headingIdx >= 0, `Expected ${idToken} in deck/index.html`);
  const sectionStart = deckHtml.lastIndexOf("<section", headingIdx);
  const sectionEnd = deckHtml.indexOf("</section>", headingIdx);
  assert.ok(sectionStart >= 0 && sectionEnd > sectionStart, `Expected <section> wrapper for slide ${slideNum}`);
  return deckHtml.slice(sectionStart, sectionEnd + "</section>".length);
}

describe("3-minute stage script (docs/DEMO_SCRIPT.md) & user test kit (docs/USER_TEST_KIT.md) contract", () => {
  const demoScript = readRepoFile("docs/DEMO_SCRIPT.md");
  const userTestKit = readRepoFile("docs/USER_TEST_KIT.md");
  const readme = readRepoFile("README.md");
  const deckHtml = readRepoFile("deck/index.html");
  const selfSource = fs.readFileSync(TEST_FILE, "utf8");

  test("enforces strict test hygiene: zero code comments and zero em dashes", () => {
    assert.equal(selfSource.includes(EM_DASH), false, "Test file must contain zero em dashes");
    assert.equal(selfSource.includes(BLOCK_COMMENT_OPEN), false, "Test file must contain zero block comments");
    assert.equal(selfSource.includes(HTML_COMMENT_OPEN), false, "Test file must contain zero HTML comments");
    for (const rawLine of selfSource.split(/\r?\n/)) {
      assert.equal(
        rawLine.includes(LINE_COMMENT),
        false,
        `Test file line must contain zero line comments: "${rawLine}"`,
      );
    }
  });

  test("defines all 4 stage roles with responsibilities and stage positions", () => {
    const rolesStart = demoScript.indexOf("## Roles");
    const preDemoStart = demoScript.indexOf("## Pre-demo checklist");
    assert.ok(rolesStart >= 0 && preDemoStart > rolesStart, "Expected ## Roles before ## Pre-demo checklist");
    const rolesSection = demoScript.slice(rolesStart, preDemoStart);
    const rows = parseMarkdownTableRows(rolesSection);
    assert.equal(rows.length, 4, "Expected exactly 4 stage roles in docs/DEMO_SCRIPT.md");

    const byHandle = new Map<string, { role: string; where: string }>();
    for (const cells of rows) {
      assert.equal(cells.length, 3, `Expected 3 columns (Who | Role | Where), got ${cells.length}`);
      const handle = cells[0].replace(/\*\*/g, "").trim();
      assert.ok(cells[1].length >= 20, `Expected substantive responsibility for ${handle}`);
      assert.ok(cells[2].length >= 5, `Expected non-empty stage position for ${handle}`);
      byHandle.set(handle, { role: cells[1], where: cells[2] });
    }

    assert.deepEqual(
      [...byHandle.keys()],
      ["Silas", "Momin010", "ivarakerholm-wq", "Chintufp"],
      "Stage roles must list Silas, Momin010, ivarakerholm-wq, and Chintufp in order",
    );
    assert.match(byHandle.get("Silas")!.role, /Presenter.*glasses.*props/i);
    assert.match(byHandle.get("Silas")!.where, /Centre stage/i);
    assert.match(byHandle.get("Momin010")!.role, /Operator.*laptop.*fallbacks.*bridge/i);
    assert.match(byHandle.get("Momin010")!.where, /side of stage/i);
    assert.match(byHandle.get("ivarakerholm-wq")!.role, /Props.*box in order/i);
    assert.match(byHandle.get("ivarakerholm-wq")!.where, /Next to Silas/i);
    assert.match(byHandle.get("Chintufp")!.role, /Timekeeper.*backup video/i);
    assert.match(byHandle.get("Chintufp")!.where, /Front row/i);
  });

  test("covers 6 contiguous stage beats summing to 180 seconds (3:00) with fallbacks on every beat and last-resort table", () => {
    const scriptStart = demoScript.indexOf("## The script");
    const optionalStart = demoScript.indexOf("## Optional beats");
    const lastResortStart = demoScript.indexOf("## Last-resort fallbacks");
    const afterDemoStart = demoScript.indexOf("## After the demo");
    assert.ok(scriptStart >= 0 && lastResortStart > scriptStart && afterDemoStart > lastResortStart);

    const scriptEnd = optionalStart > scriptStart && optionalStart < lastResortStart ? optionalStart : lastResortStart;
    const scriptBody = demoScript.slice(scriptStart, scriptEnd);
    const beatHeadingRe = /^###\s+(\d+:\d{2})[\u2013-](\d+:\d{2})\s+·\s+(.+)$/gm;
    const matches = [...scriptBody.matchAll(beatHeadingRe)];
    assert.equal(matches.length, 6, "Expected exactly 6 timed stage beats under ## The script");

    const expectedRanges: Array<[string, string]> = [
      ["0:00", "0:20"],
      ["0:20", "0:40"],
      ["0:40", "1:40"],
      ["1:40", "2:10"],
      ["2:10", "2:35"],
      ["2:35", "3:00"],
    ];
    assert.deepEqual(
      matches.map((m) => [m[1], m[2]]),
      expectedRanges,
      "Stage beat timestamps must match the 6 canonical ranges from 0:00 to 3:00",
    );

    let cursorSec = 0;
    let totalDurationSec = 0;
    for (let i = 0; i < matches.length; i += 1) {
      const m = matches[i];
      const startSec = parseTimestampSec(m[1]);
      const endSec = parseTimestampSec(m[2]);
      assert.equal(startSec, cursorSec, `Beat ${i + 1} (${m[3]}) must start contiguously at ${cursorSec}s`);
      assert.ok(endSec > startSec, `Beat ${i + 1} (${m[3]}) must have positive duration`);
      totalDurationSec += endSec - startSec;
      cursorSec = endSec;

      const bodyStart = (m.index ?? 0) + m[0].length;
      const bodyEnd = i + 1 < matches.length ? (matches[i + 1].index ?? scriptBody.length) : scriptBody.length;
      const beatBody = scriptBody.slice(bodyStart, bodyEnd);
      assert.ok(
        beatBody.includes("*Fallback:*") || /\bFallbacks\b/.test(beatBody),
        `Beat ${i + 1} (${m[1]}-${m[2]} ${m[3]}) must define an explicit *Fallback:* or Fallbacks recovery path`,
      );
    }

    assert.equal(cursorSec, 180, "Final stage beat must end at 180 seconds (3:00)");
    assert.equal(totalDurationSec, 180, "Stage beat durations must sum to exactly 180 seconds");

    const lastResortSection = demoScript.slice(lastResortStart, afterDemoStart);
    const fallbackRows = parseMarkdownTableRows(lastResortSection);
    assert.ok(fallbackRows.length >= 5, `Expected >= 5 rows in Last-resort fallbacks table, got ${fallbackRows.length}`);
    for (const row of fallbackRows) {
      assert.equal(row.length, 2, "Each Last-resort fallbacks row must have Situation and Do this cells");
      assert.ok(row[0].length > 5 && row[1].length > 15);
    }
    assert.ok(lastResortSection.includes("?mock=1"), "Last-resort fallbacks must document ?mock=1");
    assert.ok(lastResortSection.includes("backup video"), "Last-resort fallbacks must document backup video");
    assert.ok(lastResortSection.includes("/hud/"), "Last-resort fallbacks must document /hud/ laptop view");

    assert.ok(
      demoScript.includes("**Live is down**") &&
        demoScript.includes("Snapshot") &&
        demoScript.includes("**Check label**"),
      "DEMO_SCRIPT.md must document Snapshot fallback when Gemini Live is down",
    );
    const snapshotUsesGlassesRingOrPhone =
      (demoScript.includes("POST /api/verify") && demoScript.includes("hub.ring")) ||
      demoScript.includes("only use the phone's own frames");
    assert.equal(
      snapshotUsesGlassesRingOrPhone,
      true,
      "DEMO_SCRIPT.md Snapshot fallback must document frame source behavior",
    );
    assert.ok(
      demoScript.includes('"Back online"') &&
        demoScript.includes("**Snapshot**") &&
        demoScript.includes('"Live assistant connected"'),
      "DEMO_SCRIPT.md must document offline-to-online recovery progression",
    );
    const reconnectDocumentsCueOrNote =
      demoScript.includes("back_online") || demoScript.includes("only spoken to screen-reader users");
    assert.equal(
      reconnectDocumentsCueOrNote,
      true,
      "DEMO_SCRIPT.md must document spoken or screen-reader behavior when returning online",
    );
    assert.ok(
      demoScript.includes("stored only on this phone, and travel with a check"),
      "DEMO_SCRIPT.md consent beat must state profile data travels with a check only while it runs",
    );
    assert.ok(optionalStart > scriptStart && optionalStart < lastResortStart, "DEMO_SCRIPT.md must include ## Optional beats");
    const optionalSection = demoScript.slice(optionalStart, lastResortStart);
    for (const token of ['"Which one?"', "SPOTTER=1", "Double-checked with the pack code", "Set up by voice", "Corrected answer"]) {
      assert.ok(optionalSection.includes(token), `DEMO_SCRIPT.md Optional beats must document ${token}`);
    }
  });

  test("aligns spoken verdicts in DEMO_SCRIPT.md with server/src/safety.ts and web/src/lib/verdicts.ts", () => {
    const profile = demoProfile();
    const eveningNow = new Date(2026, 10, 15, 19, 15, 0);
    const morningNow = new Date(2026, 10, 15, 9, 15, 0);

    const amlodipineRead: LabelRead = {
      ...emptyRead("medication"),
      product: { value: "Amlodipine", confidence: 0.97 },
      ingredient: { value: "amlodipine", confidence: 0.95 },
      strength: { value: "5 mg", confidence: 0.96 },
      expiry: { value: "2027-08", confidence: 0.9 },
      readability: 0.92,
    };
    const serverMatch = checkLabelText(amlodipineRead, profile, eveningNow);
    const serverMorningMatch = checkLabelText(amlodipineRead, profile, morningNow);
    const clientMatch = matchVerdict(profile, profile.meds[0], { now: eveningNow });
    assert.equal(serverMatch.level, "match");
    assert.equal(serverMorningMatch.level, "match");
    assert.equal(clientMatch.level, "match");
    assert.equal(serverMatch.speech, "Yes, Amlodipine 5 mg, your evening pill. You haven't taken it today.");
    assert.equal(
      serverMorningMatch.speech,
      "Yes, Amlodipine 5 mg, your evening pill, but it's only morning now. You haven't taken it today.",
    );
    assert.equal(clientMatch.speech, "Yes, Amlodipine 5 mg, your evening pill. You haven't taken it today.");
    for (const phrase of ["Amlodipine", "5 mg", "your evening pill", "You haven't taken it today."]) {
      assert.ok(demoScript.includes(phrase), `DEMO_SCRIPT.md match beat must include "${phrase}"`);
    }

    const ibuprofenRead: LabelRead = {
      ...emptyRead("medication"),
      product: { value: "Ibuprofen", confidence: 0.96 },
      ingredient: { value: "ibuprofen", confidence: 0.95 },
      strength: { value: "400 mg", confidence: 0.94 },
      expiry: { value: "2027-08", confidence: 0.88 },
      readability: 0.9,
    };
    const serverIbuprofen = checkLabelText(ibuprofenRead, profile, eveningNow);
    const mockIbuprofen = mockWarningIbuprofen();
    assert.equal(serverIbuprofen.level, "warning");
    assert.equal(mockIbuprofen.level, "warning");
    assert.equal(
      serverIbuprofen.speech,
      "This is Ibuprofen 400 mg. It isn't on your medication list and your list says to avoid NSAIDs.",
    );
    assert.ok(
      demoScript.includes(serverIbuprofen.speech),
      "DEMO_SCRIPT.md warning beat must match safety.ts Ibuprofen speech verbatim",
    );
    assert.ok(mockIbuprofen.speech.includes("Ibuprofen") && mockIbuprofen.speech.includes("avoid NSAIDs"));

    const metforminTapedRead: LabelRead = {
      ...emptyRead("medication"),
      product: { value: "Metformin", confidence: 0.92 },
      ingredient: { value: "metformin hydrochloride", confidence: 0.88 },
      strength: { value: null, confidence: 0.31 },
      readability: 0.72,
    };
    const serverUnsure = checkLabelText(metforminTapedRead, profile, eveningNow);
    const mockUnsure = mockUnsureStrength();
    assert.equal(serverUnsure.level, "unsure");
    assert.equal(mockUnsure.level, "unsure");
    assert.equal(
      serverUnsure.speech,
      "It looks like Metformin, but I can't read the strength confidently. Turn the box so the side panel faces you, or ask a pharmacist.",
    );
    for (const phrase of [
      "It looks like Metformin",
      "but I can't read the strength confidently. Turn the box so the side panel faces you, or ask a pharmacist.",
    ]) {
      assert.ok(demoScript.includes(phrase), `DEMO_SCRIPT.md unsure beat must include "${phrase}"`);
    }
    assert.ok(
      mockUnsure.speech.includes("Metformin") &&
        mockUnsure.speech.includes("can't read the strength confidently") &&
        mockUnsure.speech.includes("ask a pharmacist"),
    );

    const loggedProfile = {
      ...profile,
      doseLog: [{ medId: "amlodipine", ts: new Date(2026, 10, 15, 8, 30, 0).getTime() }],
    };
    const offlineDoubleDose = matchVerdict(loggedProfile, profile.meds[0], { via: "barcode", now: eveningNow });
    assert.equal(offlineDoubleDose.level, "warning");
    assert.equal(offlineDoubleDose.takenToday, true);
    assert.ok(
      offlineDoubleDose.headline.startsWith("Amlodipine") &&
        offlineDoubleDose.headline.endsWith(": already taken today"),
      `Unexpected offline double-dose headline: ${offlineDoubleDose.headline}`,
    );
    assert.ok(
      offlineDoubleDose.speech.startsWith("You already took Amlodipine today at ") &&
        offlineDoubleDose.speech.endsWith("Don't take another unless your plan says so."),
      `Unexpected offline double-dose speech: ${offlineDoubleDose.speech}`,
    );
    assert.ok(demoScript.includes("Amlodipine: already taken today"));
    assert.ok(
      demoScript.includes("You already took Amlodipine today at <time>. Don't take another unless your plan says so."),
    );
  });

  test("verifies ?mock=1 typed fallback triggers in DEMO_SCRIPT.md and README.md route to expected MockSocket verdicts", (t: TestContext) => {
    assert.ok(readme.includes('"is this my evening pill"'), "README.md must document 'is this my evening pill' mock trigger");
    assert.ok(readme.includes('"ibuprofen"'), "README.md must document 'ibuprofen' mock trigger");
    assert.ok(readme.includes('"nuts"'), "README.md must document 'nuts' mock trigger");
    assert.ok(
      demoScript.includes('"is this my evening pill"') && demoScript.includes('"ibuprofen"'),
      "DEMO_SCRIPT.md Last-resort fallbacks must document 'is this my evening pill' and 'ibuprofen' triggers",
    );
    assert.equal(pickScenario("is this my evening pill"), 0);
    assert.equal(pickScenario("ibuprofen"), 1);
    assert.equal(pickScenario("metformin"), 2);
    assert.equal(pickScenario("nuts"), 3);
    assert.equal(pickScenario("Which one is my evening pill?"), 4);

    t.mock.timers.enable({ apis: ["setTimeout"] });
    mockCtl.failConnects = 0;
    mockCtl.offline = false;
    mockCtl.geminiDown = false;

    const runTypedMockTrigger = (typedText: string): Verdict => {
      const ws = new MockSocket();
      const verdicts: Verdict[] = [];
      ws.onmessage = (ev: MessageEvent) => {
        const msg = JSON.parse(String(ev.data)) as ServerMsg;
        if (msg.type === "verdict") verdicts.push(msg.verdict);
      };
      t.mock.timers.tick(300);
      assert.equal(ws.readyState, 1, "MockSocket should open after 250 ms");
      ws.send(JSON.stringify({ type: "start", profile: demoProfile() }));
      ws.send(JSON.stringify({ type: "text", text: typedText }));
      for (let elapsed = 0; elapsed < 13_000; elapsed += 250) {
        t.mock.timers.tick(250);
      }
      ws.send(JSON.stringify({ type: "event", name: "stop" }));
      mockCtl.sockets.delete(ws);
      assert.equal(verdicts.length, 1, `Expected 1 verdict for typed trigger "${typedText}"`);
      return verdicts[0];
    };

    const pillVerdict = runTypedMockTrigger("is this my evening pill");
    assert.equal(pillVerdict.level, "match");
    assert.equal(pillVerdict.matchedMedId, "amlodipine");
    assert.ok(pillVerdict.speech.includes("Amlodipine 5 mg"));

    const ibuVerdict = runTypedMockTrigger("ibuprofen");
    assert.equal(ibuVerdict.level, "warning");
    assert.equal(ibuVerdict.headline, mockWarningIbuprofen().headline);
    assert.ok(ibuVerdict.speech.includes("avoid NSAIDs"));

    const nutsVerdict = runTypedMockTrigger("nuts");
    assert.equal(nutsVerdict.level, "warning");
    assert.equal(nutsVerdict.headline, mockFoodNuts().headline);
    assert.ok(nutsVerdict.speech.includes("hazelnuts") && nutsVerdict.speech.includes("tree nuts"));

    const sceneVerdict = runTypedMockTrigger("Which one is my evening pill?");
    assert.equal(sceneVerdict.mode, "scene");
    assert.equal(sceneVerdict.level, "match");
    assert.match(sceneVerdict.speech, /evening pill/i);
    assert.match(sceneVerdict.speech, /ibuprofen/i);
  });

  test("matches demoProfile() in web/src/lib/storage.ts with DEMO_SCRIPT.md Pre-demo checklist and deck slide topics", () => {
    const profile = demoProfile();
    assert.deepEqual(
      profile.meds.map((m) => ({ name: m.name, strength: m.strength, schedule: m.schedule })),
      [
        { name: "Amlodipine", strength: "5 mg", schedule: ["evening"] },
        { name: "Metformin", strength: "500 mg", schedule: ["morning", "evening"] },
        { name: "Atorvastatin", strength: "20 mg", schedule: ["evening"] },
      ],
    );
    assert.deepEqual(profile.allergies, ["tree nuts", "peanut"]);
    assert.deepEqual(profile.avoid, ["NSAIDs"]);
    assert.deepEqual(profile.doseLog, []);

    const checklistSection = demoScript.slice(
      demoScript.indexOf("## Pre-demo checklist"),
      demoScript.indexOf("## The script"),
    );
    assert.ok(checklistSection.includes("Amlodipine 5 mg (evening)"));
    assert.ok(checklistSection.includes("Metformin 500 mg (morning and evening)"));
    assert.ok(checklistSection.includes("Atorvastatin 20 mg (evening)"));
    assert.ok(checklistSection.includes("allergies: tree nuts, peanut"));
    assert.ok(checklistSection.includes("avoid: NSAIDs"));
    assert.ok(checklistSection.includes("no amlodipine entry today"));

    for (let s = 1; s <= 13; s += 1) {
      assert.ok(deckHtml.includes(`id="s${s}-h"`), `deck/index.html must define #s${s}-h`);
    }
    assert.match(
      extractSlideSection(deckHtml, 9),
      /Decision support, not diagnosis/i,
      "Slide 9 in deck/index.html must cover Decision support, not diagnosis",
    );

    const referencedSlides = new Set<number>();
    for (const m of demoScript.matchAll(/\bslides?\s+(\d+(?:\s*,\s*\d+)*)/gi)) {
      for (const part of m[1].split(",")) referencedSlides.add(Number(part.trim()));
    }
    const sortedReferenced = [...referencedSlides].sort((a, b) => a - b);
    assert.deepEqual(
      sortedReferenced,
      [1, 7, 8, 10, 11, 12, 13],
      "DEMO_SCRIPT.md must reference exact deck slides 1, 7, 8, 10, 11, 12, and 13",
    );

    const expectedSlideKeywords: Record<number, RegExp> = {
      1: /Which one is the evening pill\?|Three white boxes/i,
      7: /Speculative verify|2\.1 s p50/i,
      8: /Consent first|45 s|Profile lives on the phone/i,
      10: /Resilience|Offline mode|snapshot mode/i,
      11: /1,740|0<small>\/754<\/small>|4,730/i,
      12: /Näkövammaisten liitto|Pharmacies/i,
      13: /Help us put HoldUp on 20 faces in Finland|Hold it up\. Know it's the right one\./i,
    };
    for (const slideNum of sortedReferenced) {
      const slideSection = extractSlideSection(deckHtml, slideNum);
      assert.match(
        slideSection,
        expectedSlideKeywords[slideNum],
        `Slide ${slideNum} in deck/index.html must align with its DEMO_SCRIPT.md beat topic`,
      );
    }
  });

  test("enforces USER_TEST_KIT.md verbal consent script, 4 observation tasks, outreach channels, and honest reporting guardrails", () => {
    assert.ok(
      userTestKit.includes("student prototype, not a medical device"),
      "USER_TEST_KIT.md consent script must state student prototype, not a medical device",
    );
    assert.ok(
      userTestKit.includes("don't use it for real medication decisions"),
      "USER_TEST_KIT.md consent script must bar real medication decisions",
    );
    assert.ok(
      userTestKit.includes("Google's Gemini service") && userTestKit.includes("not stored by us"),
      "USER_TEST_KIT.md consent script must disclose Google Gemini processing and non-storage",
    );
    assert.ok(
      userTestKit.includes("won't record your face or voice unless you agree") &&
        userTestKit.includes("No faces in photos or video unless explicitly agreed"),
      "USER_TEST_KIT.md must prohibit face/voice recording without explicit agreement",
    );
    assert.ok(
      userTestKit.includes("first name, initials or anonymously (your choice)"),
      "USER_TEST_KIT.md must let participants choose attribution or anonymity",
    );

    const tasksSection = userTestKit.slice(
      userTestKit.indexOf("3. **Tasks"),
      userTestKit.indexOf("4. **Questions"),
    );
    assert.ok(tasksSection.includes("observe only and don't help"));
    assert.ok(
      tasksSection.includes("Which of these three boxes is your evening pill?") && tasksSection.includes("scene mode"),
      "Tasks must include the 3-box scene mode task",
    );
    assert.ok(
      tasksSection.includes("Check this box.") && tasksSection.includes("label away from them first"),
      "Tasks must include the label-away check task",
    );
    assert.ok(
      tasksSection.includes("Does this snack contain nuts?"),
      "Tasks must include the nut snack allergen task",
    );
    assert.ok(
      tasksSection.includes("fails on purpose") &&
        tasksSection.includes("cover the strength with a thumb") &&
        tasksSection.includes("I'm not sure"),
      "Tasks must include deliberate thumb-over-strength abstention check",
    );

    const contactSection = userTestKit.slice(
      userTestKit.indexOf("## Who to contact"),
      userTestKit.indexOf("## The 10-minute session"),
    );
    assert.ok(
      contactSection.includes("Näkövammaisten liitto") &&
        contactSection.includes("Iiris") &&
        contactSection.includes("Marjaniementie 74") &&
        contactSection.includes("nkl.fi"),
      "Outreach channels must include Näkövammaisten liitto / Iiris centre (Marjaniementie 74)",
    );
    assert.ok(
      contactSection.includes("Meta booth") &&
        contactSection.includes("Amanda Le") &&
        contactSection.includes("Web Apps mentors"),
      "Outreach channels must include Meta booth mentors (Amanda Le + Web Apps mentors)",
    );

    const ethicsSection = userTestKit.slice(userTestKit.indexOf("## Ethics guardrails"));
    assert.ok(
      ethicsSection.includes('"early feedback from N users"') && ethicsSection.includes('not "validated"'),
      "Ethics guardrails must require 'early feedback from N users' and forbid overstating single-session feedback as 'validated'",
    );
    assert.ok(userTestKit.includes("docs/USER_FEEDBACK.md"), "Must record consented notes in docs/USER_FEEDBACK.md");
  });
});
