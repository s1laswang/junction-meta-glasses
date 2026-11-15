import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF_FILE = fileURLToPath(import.meta.url);
const TEST_DIR = path.dirname(SELF_FILE);
const REPO_DIR = path.resolve(TEST_DIR, "..", "..");

const LINE_COMMENT = String.fromCharCode(47, 47);
const BLOCK_COMMENT = String.fromCharCode(47, 42);
const HTML_COMMENT = String.fromCharCode(60, 33, 45, 45);
const EM_DASH = String.fromCharCode(8212);
const ESCAPED_EM_DASH = ["\\u", "2014"].join("");
const LEFT_DOUBLE_QUOTE = String.fromCharCode(8220);
const RIGHT_DOUBLE_QUOTE = String.fromCharCode(8221);

const SECRET_PREFIXES = [
  ["AIza", "Sy"].join(""),
  ["AQ.", "Ab"].join(""),
  ["sk_", "live_"].join(""),
  ["sk_", "test_"].join(""),
  ["ghp", "_"].join(""),
  ["ya29", "."].join(""),
];

const ALLOWED_KIT_QUOTED_PHRASES = new Set([
  "no",
  "early feedback from N users",
  "validated",
  "set up by voice",
  "Which of these three boxes is your evening pill?",
  "Check this box.",
  "Does this snack contain nuts?",
  "I'm not sure",
]);

function readRepoFile(relPath: string): string {
  return fs.readFileSync(path.join(REPO_DIR, relPath), "utf8");
}

function assertCleanHygiene(source: string, label: string): void {
  assert.equal(source.includes(LINE_COMMENT), false, `${label} must contain zero line comments`);
  assert.equal(source.includes(BLOCK_COMMENT), false, `${label} must contain zero block comments`);
  assert.equal(source.includes(HTML_COMMENT), false, `${label} must contain zero HTML comments`);
  assert.equal(source.includes(EM_DASH), false, `${label} must contain zero em dashes`);
  assert.equal(source.includes(ESCAPED_EM_DASH), false, `${label} must contain zero escaped em dashes`);
  for (const prefix of SECRET_PREFIXES) {
    assert.equal(source.includes(prefix), false, `${label} must not contain secret prefix "${prefix}"`);
  }
}

describe("docs/USER_FEEDBACK.md strict placeholder template and USER_TEST_KIT.md alignment contract", () => {
  const feedbackAbsPath = path.join(REPO_DIR, "docs/USER_FEEDBACK.md");
  const kitAbsPath = path.join(REPO_DIR, "docs/USER_TEST_KIT.md");

  test("docs/USER_FEEDBACK.md exists, links resolve cleanly, and both template and test satisfy strict hygiene", () => {
    assert.equal(fs.existsSync(feedbackAbsPath), true, "docs/USER_FEEDBACK.md must exist");
    assert.equal(fs.existsSync(kitAbsPath), true, "docs/USER_TEST_KIT.md must exist");

    const feedback = readRepoFile("docs/USER_FEEDBACK.md");
    const selfSource = fs.readFileSync(SELF_FILE, "utf8");

    assert.ok(feedback.trim().length > 500, "docs/USER_FEEDBACK.md must be a structured template");
    assertCleanHygiene(feedback, "docs/USER_FEEDBACK.md");
    assertCleanHygiene(selfSource, "web/test/userFeedbackTemplateContract.test.ts");

    const linkRe = /\[([^\]]+)\]\(([^)]+)\)/g;
    let linkCount = 0;
    for (const match of feedback.matchAll(linkRe)) {
      const target = match[2].trim().split("#")[0];
      if (!target) continue;
      const resolved = path.resolve(path.dirname(feedbackAbsPath), target);
      assert.equal(fs.existsSync(resolved), true, `Relative link "${target}" in docs/USER_FEEDBACK.md must exist`);
      linkCount++;
    }
    assert.ok(linkCount >= 2, "docs/USER_FEEDBACK.md must link to USER_TEST_KIT.md and PRIVACY.md");
  });

  test("aligns 1:1 with docs/USER_TEST_KIT.md status banner, verbal consent checklist, 4 tasks, and ethics guardrails", () => {
    const feedback = readRepoFile("docs/USER_FEEDBACK.md");
    const kit = readRepoFile("docs/USER_TEST_KIT.md");

    assert.ok(kit.includes("docs/USER_FEEDBACK.md"), "docs/USER_TEST_KIT.md must point to docs/USER_FEEDBACK.md");
    assert.ok(
      feedback.includes("Status: PENDING REAL SESSION - placeholder template only; never invent a quote"),
      "docs/USER_FEEDBACK.md must carry the exact PENDING REAL SESSION status banner",
    );

    const consentPhrases = [
      "student prototype, not a medical device",
      "no real medication decisions",
      "memory-only",
      "not stored",
      "no face or voice recorded without explicit agreement",
      "permission to write down feedback",
      "attribution choice",
      "first name, initials, or anonymous",
    ];
    for (const phrase of consentPhrases) {
      assert.ok(
        feedback.toLowerCase().includes(phrase.toLowerCase()),
        `Verbal consent checklist in docs/USER_FEEDBACK.md must include "${phrase}"`,
      );
    }

    const uncheckedBoxes = feedback.match(/^- \[ \] /gm) ?? [];
    assert.equal(uncheckedBoxes.length, 6, "Pre-session verbal consent checklist must have 6 unchecked items");

    const fourKitTasks = [
      "Which of these three boxes is your evening pill?",
      "Check this box.",
      "Does this snack contain nuts?",
      "I'm not sure",
    ];
    for (const taskText of fourKitTasks) {
      assert.ok(kit.includes(taskText), `Expected "${taskText}" in docs/USER_TEST_KIT.md`);
      assert.ok(feedback.includes(taskText), `Expected 1:1 task "${taskText}" in docs/USER_FEEDBACK.md`);
    }
    assert.ok(feedback.toLowerCase().includes("thumb"), "Task 4 must specify thumb-covered strength abstention");

    for (const guardrail of ["early feedback from N users", "validated", "Näkövammaisten liitto"]) {
      assert.ok(kit.includes(guardrail));
      assert.ok(feedback.includes(guardrail));
    }
  });

  test("preserves [TBD] placeholders across participant, consent, 4 tasks, debrief fields, and verbatim quote slot", () => {
    const feedback = readRepoFile("docs/USER_FEEDBACK.md");

    const requiredPlaceholders = [
      "Date & time (Helsinki):",
      "[TBD: first name, initials, or anonymous]",
      "[TBD: e.g. low vision, TalkBack/VoiceOver user, older adult with multiple medicines, or Meta/a11y mentor]",
      "verbal yes: [TBD]",
      "quote allowed: [TBD: yes / no]",
      "attribution: [TBD]",
      "**What worked:** `[TBD]`",
      "**What failed or was confusing:** `[TBD]`",
      "**Voice pace & chattiness:** `[TBD]`",
      "**Trust in abstention:** `[TBD]`",
      "> [TBD: paste exact consented quote from real participant or mentor here; leave as TBD until recorded]",
    ];

    for (const token of requiredPlaceholders) {
      assert.ok(feedback.includes(token), `docs/USER_FEEDBACK.md must preserve placeholder "${token}"`);
    }

    const tbdMatches = feedback.match(/\[TBD/g) ?? [];
    assert.ok(tbdMatches.length >= 14, `Expected at least 14 [TBD placeholders, got ${tbdMatches.length}`);
  });

  test("guarantees zero fabricated, invented, or implied user or mentor quotes", () => {
    const feedback = readRepoFile("docs/USER_FEEDBACK.md");

    assert.equal(feedback.includes(LEFT_DOUBLE_QUOTE), false, "Must not contain typographic left double quotes");
    assert.equal(feedback.includes(RIGHT_DOUBLE_QUOTE), false, "Must not contain typographic right double quotes");

    const blockquoteLines = feedback
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith(">"));
    assert.equal(blockquoteLines.length, 1, "Template must have exactly 1 blockquote placeholder line");
    assert.equal(
      blockquoteLines[0],
      "> [TBD: paste exact consented quote from real participant or mentor here; leave as TBD until recorded]",
    );

    const quotedSegments = [...feedback.matchAll(/"([^"\n]+)"/g)].map((m) => m[1]);
    assert.ok(quotedSegments.length >= 6, "Expected quoted task prompts and guardrail terms from USER_TEST_KIT.md");
    for (const seg of quotedSegments) {
      assert.equal(
        ALLOWED_KIT_QUOTED_PHRASES.has(seg),
        true,
        `Unexpected quoted string "${seg}" in docs/USER_FEEDBACK.md; never invent or imply a user/mentor quote`,
      );
    }

    assert.doesNotMatch(
      feedback,
      /\b(?:participant|tester|mentor|volunteer)\s+(?:said|noted|commented|reported|told\s+us)\b/i,
      "docs/USER_FEEDBACK.md must not imply any unrecorded participant or mentor statement",
    );
  });
});
