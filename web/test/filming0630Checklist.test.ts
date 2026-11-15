import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

function extractChecklistIds(text: string): string[] {
  const matches = text.match(/\bH(?:10|[1-9])\b/g) ?? [];
  return [...new Set(matches)].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

function extractHwPaths(text: string): string[] {
  const matches = text.match(/docs\/img\/hw\/[A-Za-z0-9._-]+/g) ?? [];
  return [...new Set(matches)].sort();
}

function extractProbeCommands(text: string): Array<{ raw: string; base: string; label: string }> {
  const re = /npm -w server run hw:probe -- --base ([^\s`]+) --label "([^"]+)"/g;
  return [...text.matchAll(re)].map((m) => ({ raw: m[0], base: m[1], label: m[2] }));
}

function extractFencedCodeBlocks(markdown: string): string[] {
  const re = /```[^\n]*\n([\s\S]*?)```/g;
  return [...markdown.matchAll(re)].map((m) => m[1]);
}

function assertMonotonicIndices(text: string, tokens: string[], context: string): void {
  let prev = -1;
  for (const token of tokens) {
    const next = text.indexOf(token, prev + 1);
    assert.ok(next > prev, `${context}: expected "${token}" after index ${prev}`);
    prev = next;
  }
}

describe("06:30 Helsinki 10-minute filming checklist contract (docs/FILMING_0630.md)", () => {
  const checklist = readRepoFile("docs/FILMING_0630.md");
  const hardwareLog = readRepoFile("docs/HARDWARE_LOG.md");
  const shotList = readRepoFile("docs/SHOT_LIST.md");
  const hardwareNotes = readRepoFile("docs/HARDWARE_NOTES.md");
  const deckHtml = readRepoFile("deck/index.html");
  const liveTs = readRepoFile("server/src/live.ts");
  const hwProbeTs = readRepoFile("server/scripts/hw-probe.ts");
  const serverPkg = JSON.parse(readRepoFile("server/package.json")) as {
    scripts?: Record<string, string>;
  };
  const selfSource = fs.readFileSync(TEST_FILE, "utf8");

  test("stays on one page (<= 95 lines) with zero em dashes and zero code comments", () => {
    const trimmedTrailing = checklist.endsWith("\n") ? checklist.slice(0, -1) : checklist;
    const lines = trimmedTrailing.split(/\r?\n/);
    assert.ok(lines.length >= 30, "docs/FILMING_0630.md must be substantive");
    assert.ok(
      lines.length <= 95,
      `docs/FILMING_0630.md must stay <= 95 lines (one page), got ${lines.length}`,
    );

    assert.equal(checklist.includes(EM_DASH), false, "docs/FILMING_0630.md must contain zero em dashes");
    assert.equal(selfSource.includes(EM_DASH), false, "filming0630Checklist.test.ts must contain zero em dashes");
    assert.equal(checklist.includes(HTML_COMMENT_OPEN), false, "docs/FILMING_0630.md must contain zero HTML comments");

    const codeBlocks = extractFencedCodeBlocks(checklist);
    assert.ok(codeBlocks.length >= 2, "Expected bash setup and pull code blocks in docs/FILMING_0630.md");
    for (const block of codeBlocks) {
      for (const rawLine of block.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        assert.equal(line.startsWith("#"), false, `Code block line must not be a shell comment: "${line}"`);
        assert.equal(line.includes(BLOCK_COMMENT_OPEN), false, `Code block line must not have block comment: "${line}"`);
        const withoutProtocols = line.replace(/https?:[^\s]+/g, "");
        assert.equal(withoutProtocols.includes(LINE_COMMENT), false, `Code block line must not have line comment: "${line}"`);
      }
    }

    assert.equal(selfSource.includes(BLOCK_COMMENT_OPEN), false, "Test file must contain zero block comments");
    for (const rawLine of selfSource.split(/\r?\n/)) {
      const withoutProtocols = rawLine.replace(/https?:[^\s"']+/g, "");
      assert.equal(
        withoutProtocols.includes(LINE_COMMENT),
        false,
        `Test file line must contain zero line comments: "${rawLine}"`,
      );
    }
  });

  test("covers the full 06:30..06:40 10-minute Helsinki timeline and 95 s master take beats in order", () => {
    assert.ok(checklist.includes("06:30-06:40"), "Must state the 06:30-06:40 10-minute window");
    assertMonotonicIndices(
      checklist,
      ["06:30-06:32", "06:32-06:33", "06:33-06:35", "06:35-06:38", "06:38-06:40"],
      "Minute blocks",
    );
    assertMonotonicIndices(
      checklist,
      ["0:00-0:10", "0:10-0:40", "0:40-0:55", "0:55-1:15", "1:15-1:22", "1:22-1:35"],
      "Master take timestamps",
    );
    assert.ok(checklist.includes("1:15-1:35"), "Must reference the 1:15-1:35 resilience window");
  });

  test("maps all H1..H10 rows and docs/img/hw/ evidence files in parity with HARDWARE_LOG.md and SHOT_LIST.md", () => {
    const expectedIds = ["H1", "H2", "H3", "H4", "H5", "H6", "H7", "H8", "H9", "H10"];
    const logTableIds = [...hardwareLog.matchAll(/^\|\s*(H(?:10|[1-9]))\s*\|/gm)].map((m) => m[1]);
    assert.deepEqual(logTableIds, expectedIds, "docs/HARDWARE_LOG.md must define H1..H10 rows");
    assert.deepEqual(extractChecklistIds(shotList), expectedIds, "docs/SHOT_LIST.md must cover H1..H10");
    assert.deepEqual(extractChecklistIds(checklist), expectedIds, "docs/FILMING_0630.md must cover H1..H10");

    assert.ok(hardwareLog.includes("## Setup used"), "docs/HARDWARE_LOG.md must keep Setup used template");
    assert.ok(hardwareLog.includes("## Checklist"), "docs/HARDWARE_LOG.md must keep Checklist template");
    assert.ok(hardwareLog.includes("## Probe rows"), "docs/HARDWARE_LOG.md must keep Probe rows template");
    assert.ok(hardwareLog.includes("docs/img/hw/"), "docs/HARDWARE_LOG.md must reference docs/img/hw/");

    const shotListFiles = extractHwPaths(shotList);
    const checklistFiles = extractHwPaths(checklist);
    assert.equal(shotListFiles.length, 10, "Expected 10 evidence file paths in docs/SHOT_LIST.md");
    assert.deepEqual(
      checklistFiles,
      shotListFiles,
      "docs/FILMING_0630.md evidence filenames must match docs/SHOT_LIST.md exactly",
    );
  });

  test("validates every hw:probe invocation against server/scripts/hw-probe.ts and docs/SHOT_LIST.md", () => {
    assert.equal(
      serverPkg.scripts?.["hw:probe"],
      "tsx scripts/hw-probe.ts",
      "server/package.json must expose hw:probe script",
    );
    assert.ok(hwProbeTs.includes('arg("base"'), "hw-probe.ts must accept --base");
    assert.ok(hwProbeTs.includes('arg("label"'), "hw-probe.ts must accept --label");
    assert.ok(hwProbeTs.includes("process.env.HOLDUP_KEY"), "hw-probe.ts must read HOLDUP_KEY from env");

    const shotProbes = extractProbeCommands(shotList).filter((p) => !p.label.startsWith("<"));
    const checklistProbes = extractProbeCommands(checklist);
    const expectedLabels = [
      "H2-H3-streaming",
      "H4-match",
      "H5-H7-hud-logged",
      "H6-safety-catches",
      "H8-glasses-off",
      "H10-live-recovered",
    ];

    assert.deepEqual(
      shotProbes.map((p) => p.label),
      expectedLabels,
      "docs/SHOT_LIST.md probe labels must match expected 6 milestones",
    );
    assert.deepEqual(
      checklistProbes.map((p) => p.label),
      expectedLabels,
      "docs/FILMING_0630.md must run all 6 hw:probe milestones in exact order",
    );
    for (const probe of checklistProbes) {
      assert.equal(
        probe.base,
        '"$TUNNEL"',
        `Expected copy-pasteable "$TUNNEL" base arg for probe ${probe.label}, got ${probe.base}`,
      );
    }
  });

  test("bakes in all 3 code-verified gotchas, H1-first rule, H8-before-H9 ordering, and Slide 5 handoff", () => {
    const apkSha = "164dea1bb474fbdbcb7bdeccd3270ccc42c46c2c1c5683f2a9bd2b894a3bfe20";
    assert.ok(hardwareNotes.includes(apkSha), "Expected prebuilt APK sha256 in docs/HARDWARE_NOTES.md");
    assert.ok(shotList.includes(apkSha), "Expected prebuilt APK sha256 in docs/SHOT_LIST.md");
    assert.ok(checklist.includes(apkSha), "docs/FILMING_0630.md must verify prebuilt APK sha256");

    assert.ok(checklist.includes(">50%"), "Must check >50% glasses battery");
    assert.ok(checklist.includes(">70%"), "Must check >70% phone battery");
    assert.ok(checklist.includes("Airplane mode ON -> Bluetooth ON -> Airplane mode OFF"), "Must pre-train Airplane+BT toggle");
    assert.ok(checklist.includes("export HOLDUP_KEY="), "Must export HOLDUP_KEY in Terminal 3");
    assert.ok(checklist.includes("export TUNNEL=https://"), "Must export TUNNEL in Terminal 3");
    assert.ok(checklist.includes("trycloudflare.com"), "Must show trycloudflare.com tunnel host");
    assert.ok(checklist.includes("/api/stats") && checklist.includes("401"), "Must warn that /api/stats 401s without HOLDUP_KEY");

    assert.ok(liveTs.includes("private finish(") && liveTs.includes("first_audio_s"), "server/src/live.ts finish() must flush first_audio_s");
    const setupSection = checklist.slice(checklist.indexOf("06:30-06:32"), checklist.indexOf("06:32-06:33"));
    assert.ok(
      setupSection.includes("10 s") && setupSection.includes("Stop check") && setupSection.includes("first_audio_s") && setupSection.includes("ledger.jsonl"),
      "Minute 0-2 must include 10 s pre-shoot mic check + Stop check to flush first_audio_s to ledger.jsonl",
    );

    const h1Section = checklist.slice(checklist.indexOf("06:32-06:33"), checklist.indexOf("06:33-06:35"));
    assertMonotonicIndices(
      h1Section,
      ["CameraAccess", "docs/img/hw/H1-camera-access.mp4", "Connect HoldUp Bridge", "Start streaming", "Hold it up."],
      "Minute 2-3 H1-before-Bridge sequence",
    );

    const masterSection = checklist.slice(checklist.indexOf("06:33-06:35"), checklist.indexOf("06:35-06:38"));
    assert.ok(masterSection.includes("10 cm"), "Master take must place lavalier mic 10 cm below right temple");
    assert.ok(masterSection.includes("1080p60") && masterSection.includes("-0.7 EV"), "Master take must lock 1080p60 and -0.7 EV");
    assert.ok(masterSection.includes("✓ RIGHT ONE"), "Master take must verify through-lens ✓ RIGHT ONE card");
    assert.ok(masterSection.includes("WARNING: already taken today"), "Master take must verify double-dose warning");
    assert.ok(masterSection.includes("Ibuprofen 400 mg") && masterSection.includes("avoid NSAIDs"), "Master take must verify Ibuprofen NSAID warning");
    assert.ok(masterSection.includes("NOT SURE") && masterSection.includes("zero dose guessing"), "Master take must verify NOT SURE abstention");

    const resilienceStart = masterSection.indexOf("1:15-1:22");
    assert.ok(resilienceStart >= 0, "Expected 1:15-1:22 H8 row in master take");
    const resilienceSlice = masterSection.slice(resilienceStart);
    assertMonotonicIndices(
      resilienceSlice,
      [
        "H8",
        "OFF while still online",
        "worn: false",
        "/ingest/state",
        "Phone camera",
        "--label \"H8-glasses-off\"",
        "1:22-1:35",
        "Airplane mode ON",
        "Amlodipine barcode",
        "H9",
        "Airplane mode OFF",
        "Live assistant connected",
        "H10",
        "Stop check",
        "--label \"H10-live-recovered\"",
      ],
      "Strict H8-online-before-H9-airplane-then-H10-Stop-check sequence",
    );

    assert.ok(deckHtml.includes('id="s5-h"'), "deck/index.html must contain Slide 5 (#s5-h)");
    const wrapSection = checklist.slice(checklist.indexOf("06:38-06:40"));
    assert.ok(wrapSection.includes("adb pull"), "Minute 8-10 must include adb pull commands");
    assert.ok(wrapSection.includes("Setup used"), "Minute 8-10 must remind Momin to fill Setup used in HARDWARE_LOG.md");
    assert.ok(wrapSection.includes("git diff"), "Minute 8-10 must check git diff for zero secrets");
    assert.ok(wrapSection.includes("#s5-h") && wrapSection.includes("deck/index.html"), "Minute 8-10 must hand video link to Slide 5 (#s5-h) in deck/index.html");
  });
});
