import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_FILE = fileURLToPath(import.meta.url);
const TEST_DIR = path.dirname(TEST_FILE);
const REPO_DIR = path.resolve(TEST_DIR, "..", "..");

const SLASH = String.fromCharCode(47);
const ASTERISK = String.fromCharCode(42);
const LINE_COMMENT_TOKEN = SLASH + SLASH;
const BLOCK_COMMENT_TOKEN = SLASH + ASTERISK;
const HTML_COMMENT_TOKEN = String.fromCharCode(60, 33, 45, 45);
const EM_DASH = String.fromCharCode(0x2014);
const ESCAPED_EM_DASH = ["\\", "u2014"].join("");
const CHILD_PROCESS_TOKEN = ["child", "_process"].join("");
const EXEC_SYNC_TOKEN = ["exec", "Sync"].join("");
const SPAWN_SYNC_TOKEN = ["spawn", "Sync"].join("");
const DOT_GIT_TOKEN = [".", "g", "it"].join("");
const GIT_SPACE_TOKEN = ["g", "it", " "].join("");

const EBML_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MIN_REEL_BYTES = 1024 * 1024;
const MAX_REEL_BYTES = 25_000_000;

const EXPECTED_REEL_STATE_PREFIXES = [
  "Consent",
  "Camera permission denied",
  "Live check",
  "Drop connection",
  "Offline",
  "Glasses taken off",
  '"Which one?"',
] as const;

const EXPECTED_VERDICT_LEAD: Record<"fi" | "sv", Record<"match" | "warning" | "unsure" | "info", string>> = {
  fi: {
    match: "Oikea pakkaus.",
    warning: "Varoitus.",
    unsure: "En ole varma.",
    info: "Tiedoksi.",
  },
  sv: {
    match: "Rätt förpackning.",
    warning: "Varning.",
    unsure: "Jag är inte säker.",
    info: "För kännedom.",
  },
};

function resolveRepoPath(relPath: string): string {
  return path.join(REPO_DIR, relPath);
}

function assertNonEmptyTextFile(relPath: string): string {
  const fullPath = resolveRepoPath(relPath);
  assert.equal(fs.existsSync(fullPath), true, `Expected "${relPath}" to exist on disk`);
  const stat = fs.statSync(fullPath);
  assert.equal(stat.isFile(), true, `Expected "${relPath}" to be a regular file`);
  assert.ok(stat.size > 0, `Expected "${relPath}" to have size > 0 bytes`);
  const content = fs.readFileSync(fullPath, "utf8");
  assert.ok(content.trim().length > 0, `Expected "${relPath}" to have non-empty text content`);
  return content;
}

function readBinaryPrefix(relPath: string, maxBytes: number): { size: number; prefix: Buffer } {
  const fullPath = resolveRepoPath(relPath);
  assert.equal(fs.existsSync(fullPath), true, `Expected binary "${relPath}" to exist on disk`);
  const stat = fs.statSync(fullPath);
  assert.equal(stat.isFile(), true, `Expected "${relPath}" to be a regular file`);
  const toRead = Math.min(stat.size, maxBytes);
  const buf = Buffer.alloc(toRead);
  const fd = fs.openSync(fullPath, "r");
  try {
    const bytesRead = fs.readSync(fd, buf, 0, toRead, 0);
    return { size: stat.size, prefix: buf.subarray(0, bytesRead) };
  } finally {
    fs.closeSync(fd);
  }
}

function parseTimestampSeconds(ts: string): number {
  const match = /^(\d+):(\d{2}\.\d)$/.exec(ts.trim());
  if (!match) {
    assert.fail(`Expected M:SS.d timestamp, got "${ts}"`);
  }
  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  assert.ok(seconds >= 0 && seconds < 60, `Seconds out of range in timestamp "${ts}"`);
  return minutes * 60 + seconds;
}

function extractReelMarkdownStates(md: string): Array<{ n: number; name: string; startsAt: string; seconds: number }> {
  const rows: Array<{ n: number; name: string; startsAt: string; seconds: number }> = [];
  for (const line of md.split(/\r?\n/)) {
    const match = /^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*(\d+:\d{2}\.\d)\s*\|$/.exec(line.trim());
    if (match) {
      rows.push({
        n: Number(match[1]),
        name: match[2].trim(),
        startsAt: match[3].trim(),
        seconds: parseTimestampSeconds(match[3]),
      });
    }
  }
  return rows;
}

function extractRecordStatesMarks(scriptSrc: string): Array<{ n: number; name: string }> {
  const marks: Array<{ n: number; name: string }> = [];
  const markRe = /\bmark\(\s*"[AB]"\s*,\s*t[AB]\s*,\s*(\d+)\s*,\s*("(?:\\.|[^"\\])*")\s*\)/g;
  for (const match of scriptSrc.matchAll(markRe)) {
    marks.push({
      n: Number(match[1]),
      name: JSON.parse(match[2]) as string,
    });
  }
  return marks;
}

function parsePngHeader(buf: Buffer): { width: number; height: number } {
  assert.ok(buf.length >= 24, `PNG buffer too short (${buf.length} bytes)`);
  assert.equal(
    buf.subarray(0, 8).equals(PNG_SIGNATURE),
    true,
    `Invalid PNG signature: ${buf.subarray(0, 8).toString("hex")}`,
  );
  const ihdrLength = buf.readUInt32BE(8);
  const chunkType = buf.toString("ascii", 12, 16);
  assert.equal(chunkType, "IHDR", `First PNG chunk must be IHDR, got "${chunkType}"`);
  assert.equal(ihdrLength, 13, `IHDR chunk length must be 13, got ${ihdrLength}`);
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height };
}

function extractDeckSlide(deckHtml: string, slideNum: number): string {
  const headingId = `id="s${slideNum}-h"`;
  const headingIdx = deckHtml.indexOf(headingId);
  assert.ok(headingIdx >= 0, `Expected ${headingId} in deck/index.html`);
  const openIdx = deckHtml.lastIndexOf("<section", headingIdx);
  const closeTag = "</section>";
  const closeIdx = deckHtml.indexOf(closeTag, headingIdx);
  assert.ok(openIdx >= 0 && closeIdx > headingIdx, `Expected <section> wrapper around ${headingId}`);
  return deckHtml.slice(openIdx, closeIdx + closeTag.length);
}

function extractVerdictLeadMap(liveSrc: string): Record<string, Record<string, string>> {
  const blockMatch = /export const VERDICT_LEAD[\s\S]*?=\s*\{([\s\S]*?)\n\};/.exec(liveSrc);
  if (!blockMatch) {
    assert.fail("Expected export const VERDICT_LEAD block in server/src/live.ts");
  }
  const out: Record<string, Record<string, string>> = {};
  const langRe = /\b(fi|sv)\s*:\s*\{([^}]+)\}/g;
  for (const langMatch of blockMatch[1].matchAll(langRe)) {
    const lang = langMatch[1];
    const entries: Record<string, string> = {};
    const entryRe = /\b(match|warning|unsure|info)\s*:\s*"([^"]+)"/g;
    for (const entryMatch of langMatch[2].matchAll(entryRe)) {
      entries[entryMatch[1]] = entryMatch[2];
    }
    out[lang] = entries;
  }
  return out;
}

function extractAllergenGroupKeys(safetySrc: string): string[] {
  const blockMatch = /const ALLERGENS:\s*Record<string,\s*string\[\]>\s*=\s*\{([\s\S]*?)\n\};/.exec(safetySrc);
  if (!blockMatch) {
    assert.fail("Expected ALLERGENS record in server/src/safety.ts");
  }
  const keys: string[] = [];
  for (const line of blockMatch[1].split(/\r?\n/)) {
    const keyMatch = /^\s*(?:"([^"]+)"|([a-z]+))\s*:\s*\[/.exec(line);
    if (keyMatch) {
      keys.push(keyMatch[1] ?? keyMatch[2]);
    }
  }
  return keys;
}

describe("States reel, dose-finder screenshot, live-fidelity, SIM_USER_TESTS & LANG_QA evidence contract", () => {
  test("docs/evidence/states-reel.webm is a valid 1..25 MB WebM EBML container matching docs/evidence/states-reel.md and scripts/record-states.mjs", () => {
    const { size, prefix } = readBinaryPrefix("docs/evidence/states-reel.webm", 256);
    assert.ok(
      size >= MIN_REEL_BYTES && size <= MAX_REEL_BYTES,
      `Expected states-reel.webm size in 1 MB .. 25 MB, got ${size} bytes`,
    );
    assert.equal(
      prefix.subarray(0, 4).equals(EBML_MAGIC),
      true,
      `states-reel.webm must start with EBML magic bytes 1A 45 DF A3, got ${prefix.subarray(0, 4).toString("hex")}`,
    );
    const ebmlHeaderLatin1 = prefix.subarray(0, 128).toString("latin1");
    assert.ok(
      ebmlHeaderLatin1.includes("webm"),
      'states-reel.webm EBML header must contain DocType "webm"',
    );

    const reelMd = assertNonEmptyTextFile("docs/evidence/states-reel.md");
    const recordScript = assertNonEmptyTextFile("scripts/record-states.mjs");
    assert.equal(reelMd.includes(EM_DASH), false, "docs/evidence/states-reel.md must contain zero em dashes");

    const summaryMatch = /`states-reel\.webm`\s*\((\d+:\d{2}\.\d),\s*(\d+\.\d)\s*MB,\s*990x844\)/.exec(reelMd);
    if (!summaryMatch) {
      assert.fail("states-reel.md must declare duration, MB size, and 990x844 dimensions");
    }
    const reelDurationLabel = summaryMatch[1];
    const totalSeconds = parseTimestampSeconds(reelDurationLabel);
    const expectedMb = (size / 1e6).toFixed(1);
    assert.equal(
      summaryMatch[2],
      expectedMb,
      `states-reel.md reported size (${summaryMatch[2]} MB) must match states-reel.webm (${expectedMb} MB)`,
    );

    for (const token of [
      "390x844",
      "600x600",
      "990x844",
      "/?mock=1",
      "/hud/?mock=1",
      "**mock mode**",
      "scripted server, no Gemini calls",
      "fake camera",
      "scripts/record-states.mjs",
      "node scripts/record-states.mjs " + "http:" + SLASH + SLASH + "localhost:8790",
    ]) {
      assert.ok(reelMd.includes(token), `docs/evidence/states-reel.md must include "${token}"`);
    }

    const mdStates = extractReelMarkdownStates(reelMd);
    assert.equal(mdStates.length, 7, "docs/evidence/states-reel.md must document all 7 numbered states in its table");
    assert.deepEqual(
      mdStates.map((s) => s.n),
      [1, 2, 3, 4, 5, 6, 7],
      "State numbers in states-reel.md must be 1..7 in order",
    );

    for (let i = 0; i < EXPECTED_REEL_STATE_PREFIXES.length; i++) {
      assert.ok(
        mdStates[i].name.startsWith(EXPECTED_REEL_STATE_PREFIXES[i]),
        `State ${i + 1} ("${mdStates[i].name}") must start with "${EXPECTED_REEL_STATE_PREFIXES[i]}"`,
      );
      if (i > 0) {
        assert.ok(
          mdStates[i].seconds > mdStates[i - 1].seconds,
          `State ${i + 1} timestamp (${mdStates[i].startsAt}) must be strictly after state ${i} (${mdStates[i - 1].startsAt})`,
        );
      }
      assert.ok(
        mdStates[i].seconds < totalSeconds,
        `State ${i + 1} timestamp (${mdStates[i].startsAt}) must precede reel end (${reelDurationLabel})`,
      );
      assert.match(
        reelMd,
        new RegExp(`^${i + 1}\\.\\s+`, "m"),
        `states-reel.md must include numbered production note ${i + 1}.`,
      );
    }

    assert.ok(
      recordScript.includes("const PHONE = { width: 390, height: 844 };"),
      "scripts/record-states.mjs must define PHONE 390x844 viewport",
    );
    assert.ok(
      recordScript.includes("const HUD = { width: 600, height: 600 };"),
      "scripts/record-states.mjs must define HUD 600x600 viewport",
    );
    assert.ok(
      recordScript.includes("const W = PHONE.width + HUD.width;"),
      "scripts/record-states.mjs must stitch PHONE.width + HUD.width (990)",
    );
    assert.ok(
      recordScript.includes("--use-fake-device-for-media-stream"),
      "scripts/record-states.mjs must use Chromium fake media stream device",
    );

    const scriptMarks = extractRecordStatesMarks(recordScript);
    assert.deepEqual(
      scriptMarks,
      mdStates.map((s) => ({ n: s.n, name: s.name })),
      "All 7 mark() states in scripts/record-states.mjs must match docs/evidence/states-reel.md table rows",
    );
  });

  test("docs/img/dose-finder-live.png has valid PNG signature + IHDR dimensions and live-fidelity.md matches Slide 7, MORNING_BRIEF.md, and server code", () => {
    const { size: pngSize, prefix: pngHeader } = readBinaryPrefix("docs/img/dose-finder-live.png", 64);
    assert.ok(pngSize > 10_000 && pngSize < 5_000_000, `Expected reasonable PNG size, got ${pngSize} bytes`);
    const { width, height } = parsePngHeader(pngHeader);
    assert.ok(width > 0 && height > 0, `Expected positive PNG IHDR dimensions, got ${width}x${height}`);

    const spotterShot = assertNonEmptyTextFile("scripts/spotter-shot.mjs");
    const vpMatch = /viewport:\s*\{\s*width:\s*(\d+),\s*height:\s*(\d+)\s*\}/.exec(spotterShot);
    if (!vpMatch) {
      assert.fail("scripts/spotter-shot.mjs must specify Playwright viewport width and height");
    }
    assert.equal(width, Number(vpMatch[1]), "dose-finder-live.png width must match spotter-shot.mjs viewport width");
    assert.equal(height, Number(vpMatch[2]), "dose-finder-live.png height must match spotter-shot.mjs viewport height");

    for (const token of [
      "SPOTTER=1",
      "server/fixtures/amlodipine.jpg",
      "--use-file-for-fake-video-capture=",
      'm.type === "fields"',
      'm.type === "coach"',
      ".field-box",
      "page.screenshot",
    ]) {
      assert.ok(spotterShot.includes(token), `scripts/spotter-shot.mjs must include "${token}"`);
    }
    const fixtureStat = fs.statSync(resolveRepoPath("server/fixtures/amlodipine.jpg"));
    assert.ok(fixtureStat.isFile() && fixtureStat.size > 0, "server/fixtures/amlodipine.jpg must exist and be non-empty");

    const liveFidelityMd = assertNonEmptyTextFile("docs/evidence/live-fidelity.md");
    const fidelitySrc = assertNonEmptyTextFile("server/src/fidelity.ts");
    const liveSrc = assertNonEmptyTextFile("server/src/live.ts");
    assertNonEmptyTextFile("server/test/fidelity.test.ts");
    const deckHtml = assertNonEmptyTextFile("deck/index.html");
    const morningBrief = assertNonEmptyTextFile("docs/MORNING_BRIEF.md");

    assert.equal(liveFidelityMd.includes(EM_DASH), false, "docs/evidence/live-fidelity.md must contain zero em dashes");

    for (const token of [
      "server/src/fidelity.ts",
      "server/src/live.ts",
      "server/test/fidelity.test.ts",
      '{type:"correction"}',
      "live_fidelity",
      "GET /api/stats",
      "Wilson interval",
    ]) {
      assert.ok(liveFidelityMd.includes(token), `docs/evidence/live-fidelity.md must include "${token}"`);
    }

    const fidelityRow = /^\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|$/m.exec(liveFidelityMd);
    if (!fidelityRow) {
      assert.fail("docs/evidence/live-fidelity.md must contain the measured verdicts table row");
    }
    const checkedCount = Number(fidelityRow[1]);
    const passedCount = Number(fidelityRow[2]);
    const correctedCount = Number(fidelityRow[3]);
    assert.equal(checkedCount, 16, "live-fidelity.md must record 16 verdicts checked");
    assert.equal(passedCount, 15, "live-fidelity.md must record 15 verdicts passed");
    assert.equal(correctedCount, 1, "live-fidelity.md must record 1 verdict corrected aloud");
    assert.equal(passedCount + correctedCount, checkedCount, "Passed + Corrected aloud must equal Verdicts checked");

    const slide7 = extractDeckSlide(deckHtml, 7);
    assert.ok(
      slide7.includes(`${checkedCount} live verdicts checked, ${correctedCount} corrected`),
      "Slide 7 in deck/index.html must match live-fidelity.md (16 live verdicts checked, 1 corrected)",
    );
    assert.ok(
      morningBrief.includes(`${checkedCount} live verdicts checked, ${correctedCount} corrected`),
      "docs/MORNING_BRIEF.md must match live-fidelity.md (16 live verdicts checked, 1 corrected)",
    );

    assert.ok(fidelitySrc.includes("export function speechFidelity("), "server/src/fidelity.ts must export speechFidelity");
    for (const reason of [
      "not_spoken",
      "strength_missing",
      "strength_invented",
      "affirmative_on_caution",
      "caution_dropped",
      "name_missing",
      "lead_missing",
    ]) {
      assert.ok(fidelitySrc.includes(`"${reason}"`), `server/src/fidelity.ts must define FidelityReason "${reason}"`);
    }
    assert.ok(liveSrc.includes('feature: "live_fidelity"'), "server/src/live.ts must log live_fidelity to the ledger");
    assert.ok(liveSrc.includes('type: "correction"'), "server/src/live.ts must send { type: \"correction\" } on mismatch");
  });

  test("docs/SIM_USER_TESTS.md maintains strict simulation honesty disclosure, all 40 personas (P01..P40), 80/80 task sessions, and UX-01..UX-10", () => {
    const simDoc = assertNonEmptyTextFile("docs/SIM_USER_TESTS.md");
    assert.equal(simDoc.includes(EM_DASH), false, "docs/SIM_USER_TESTS.md must contain zero em dashes");

    for (const disclosureToken of [
      "CRITICAL HONESTY DISCLOSURE",
      "zero (`n = 0`) real blind or low-vision human user sessions",
      "100% SIMULATED",
      "Never cite these numbers as real human user validation.",
      "`n = 40` personas",
      "`n = 80` task sessions",
      "40 / 40 = 100.00%",
      "80 / 80 = 100.00%",
      "docs/LANG_QA.md",
    ]) {
      assert.ok(simDoc.includes(disclosureToken), `docs/SIM_USER_TESTS.md must include "${disclosureToken}"`);
    }

    for (let i = 1; i <= 40; i++) {
      const pid = `P${String(i).padStart(2, "0")}`;
      assert.ok(
        simDoc.includes(`| **${pid}** |`),
        `docs/SIM_USER_TESTS.md Section 4 ledger must include row for ${pid}`,
      );
      assert.ok(
        simDoc.includes(`- **\`${pid}\` `),
        `docs/SIM_USER_TESTS.md Section 5 transcripts must include reflection for ${pid}`,
      );
    }

    for (let d = 1; d <= 10; d++) {
      const uxId = `UX-${String(d).padStart(2, "0")}`;
      assert.ok(
        simDoc.includes(`| **${uxId}** |`),
        `docs/SIM_USER_TESTS.md Section 3 defect table must include ${uxId}`,
      );
    }
  });

  test("docs/LANG_QA.md maintains model-reviewed honesty disclosure, 17/30 string audit, 14/14 EU allergen groups, and exact VERDICT_LEAD parity with server/src/live.ts", () => {
    const langQa = assertNonEmptyTextFile("docs/LANG_QA.md");
    const liveSrc = assertNonEmptyTextFile("server/src/live.ts");
    const safetySrc = assertNonEmptyTextFile("server/src/safety.ts");
    const privacyDoc = assertNonEmptyTextFile("docs/PRIVACY.md");

    assert.equal(langQa.includes(EM_DASH), false, "docs/LANG_QA.md must contain zero em dashes");

    for (const token of [
      "HONESTY DISCLOSURE (MODEL-REVIEWED QA)",
      "SIMULATED / MODEL-REVIEWED",
      "not a human native speaker",
      "17 / 30",
      "14 / 14 = 100.00%",
      "`14` EU allergen groups",
    ]) {
      assert.ok(langQa.includes(token), `docs/LANG_QA.md must include "${token}"`);
    }

    const allergenKeys = extractAllergenGroupKeys(safetySrc);
    assert.equal(
      allergenKeys.length,
      14,
      `server/src/safety.ts ALLERGENS must define all 14 EU allergen groups, got ${allergenKeys.length}`,
    );

    const parsedVerdictLead = extractVerdictLeadMap(liveSrc);
    assert.deepEqual(
      parsedVerdictLead,
      EXPECTED_VERDICT_LEAD,
      "server/src/live.ts VERDICT_LEAD must match the 8 audited FI/SV openers",
    );

    for (const lang of ["fi", "sv"] as const) {
      for (const level of ["match", "warning", "unsure", "info"] as const) {
        const phrase = EXPECTED_VERDICT_LEAD[lang][level];
        assert.ok(
          langQa.includes(`"${phrase}"`),
          `docs/LANG_QA.md must include ${lang}.${level} opener "${phrase}"`,
        );
        assert.ok(
          privacyDoc.includes(`"${phrase}"`),
          `docs/PRIVACY.md must stay in lockstep on ${lang}.${level} opener "${phrase}"`,
        );
      }
    }
    assert.ok(privacyDoc.includes("docs/LANG_QA.md"), "docs/PRIVACY.md must reference docs/LANG_QA.md");
  });

  test("test file maintains strict hygiene: zero comments, zero em dashes, and zero subprocess or VCS calls so zip downloads pass", () => {
    const selfSource = fs.readFileSync(TEST_FILE, "utf8");
    assert.equal(selfSource.includes(LINE_COMMENT_TOKEN), false, "Test file must contain zero line comments");
    assert.equal(selfSource.includes(BLOCK_COMMENT_TOKEN), false, "Test file must contain zero block comments");
    assert.equal(selfSource.includes(HTML_COMMENT_TOKEN), false, "Test file must contain zero HTML comments");
    assert.equal(selfSource.includes(EM_DASH), false, "Test file must contain zero U+2014 em dashes");
    assert.equal(selfSource.includes(ESCAPED_EM_DASH), false, "Test file must contain zero escaped em dashes");
    assert.equal(selfSource.includes(CHILD_PROCESS_TOKEN), false, "Test file must not reference subprocess module");
    assert.equal(selfSource.includes(EXEC_SYNC_TOKEN), false, "Test file must not call sync command runner");
    assert.equal(selfSource.includes(SPAWN_SYNC_TOKEN), false, "Test file must not call sync process spawner");
    assert.equal(selfSource.includes(DOT_GIT_TOKEN), false, "Test file must not inspect VCS metadata directory");
    assert.equal(selfSource.includes(GIT_SPACE_TOKEN), false, "Test file must not invoke VCS CLI commands");
  });
});
