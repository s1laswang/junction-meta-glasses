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
const HTML_COMMENT_TOKEN = "<" + "!--";
const EM_DASH = String.fromCharCode(0x2014);
const ESCAPED_EM_DASH = ["\\", "u2014"].join("");
const CHILD_PROCESS_TOKEN = ["child", "_process"].join("");
const EXEC_SYNC_TOKEN = ["exec", "Sync"].join("");
const SPAWN_SYNC_TOKEN = ["spawn", "Sync"].join("");
const DOT_GIT_TOKEN = [".", "git"].join("");
const GIT_CLI_TOKENS = [
  ["git", " status"].join(""),
  ["git", " diff"].join(""),
  ["git", " rev-parse"].join(""),
  ["git", " log"].join(""),
];

const REQUIRED_MORNING_BRIEF_FILES = [
  "scripts/hw-session.sh",
  "eval/score_real.sh",
  "eval/real/labels.csv",
  "docs/HARDWARE_LOG.md",
  "docs/USER_TEST_KIT.md",
  "GEMINI.md",
  "GEMMA.md",
  "docs/DEMO_SCRIPT.md",
  "deck/index.html",
  "docs/evidence/verda-fieldspotter.md",
] as const;

const SUPPORTING_MORNING_BRIEF_FILES = [
  "docs/MORNING_BRIEF.md",
  "docs/EVAL.md",
  "docs/USER_FEEDBACK.md",
  "Makefile",
  "scripts/judge_accept.sh",
  "server/scripts/hw-probe.ts",
  "eval/run_eval.py",
  "README.md",
] as const;

function resolveRepoPath(relPath: string): string {
  return path.join(REPO_DIR, relPath);
}

function readRepoFile(relPath: string): string {
  return fs.readFileSync(resolveRepoPath(relPath), "utf8");
}

function assertNonEmptyFile(relPath: string): string {
  const fullPath = resolveRepoPath(relPath);
  assert.equal(fs.existsSync(fullPath), true, `Expected "${relPath}" to exist on disk`);
  const stat = fs.statSync(fullPath);
  assert.equal(stat.isFile(), true, `Expected "${relPath}" to be a regular file`);
  assert.ok(stat.size > 0, `Expected "${relPath}" to have size > 0 bytes`);
  const content = fs.readFileSync(fullPath, "utf8");
  assert.ok(content.trim().length > 0, `Expected "${relPath}" to have non-empty text content`);
  return content;
}

function extractH2Sections(markdown: string): Array<{ heading: string; body: string }> {
  const lines = markdown.split(/\r?\n/);
  const sections: Array<{ heading: string; startLine: number; endLine: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      if (sections.length > 0) {
        sections[sections.length - 1].endLine = i;
      }
      sections.push({
        heading: lines[i].slice(3).trim(),
        startLine: i + 1,
        endLine: lines.length,
      });
    }
  }
  return sections.map((s) => ({
    heading: s.heading,
    body: lines.slice(s.startLine, s.endLine).join("\n").trim(),
  }));
}

function extractMorningBriefRepoPaths(markdown: string): string[] {
  const rootFiles = new Set(["README.md", "BRIEF.md", "GEMINI.md", "GEMMA.md", "Makefile", "package.json"]);
  const found = new Set<string>();

  for (const match of markdown.matchAll(/`([^`\n]+)`/g)) {
    const token = match[1].trim();
    if (rootFiles.has(token)) {
      found.add(token);
    }
  }

  const pathRe = new RegExp(
    "\\b((?:scripts|eval|docs|deck|server|web|shared|android-dat)" + SLASH + "[A-Za-z0-9_." + SLASH + "-]+)",
    "g",
  );
  for (const match of markdown.matchAll(pathRe)) {
    const cleaned = match[1].replace(/[.,;:)]+$/, "");
    found.add(cleaned);
  }

  return [...found].sort();
}

function splitCsvRow(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      cells.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

describe("Morning brief readiness contract (docs/MORNING_BRIEF.md)", () => {
  const morningBrief = assertNonEmptyFile("docs/MORNING_BRIEF.md");
  const sections = extractH2Sections(morningBrief);

  test("docs/MORNING_BRIEF.md is linked from README.md and defines the 5 readiness sections, 8-step 08:00 checklist, and all 10 core file pointers", () => {
    const readme = assertNonEmptyFile("README.md");
    assert.ok(
      readme.includes("[docs/MORNING_BRIEF.md](docs/MORNING_BRIEF.md)"),
      "README.md must link to docs/MORNING_BRIEF.md",
    );

    assert.deepEqual(
      sections.map((s) => s.heading),
      [
        "Where we stand",
        "What changed overnight",
        "08:00 checklist",
        "What to submit where",
        "Say these carefully on stage",
      ],
      "docs/MORNING_BRIEF.md must keep all 5 H2 sections in order",
    );

    const checklistBody = sections[2].body;
    for (let step = 1; step <= 8; step++) {
      assert.match(
        checklistBody,
        new RegExp(`^${step}\\.\\s+\\*\\*`, "m"),
        `08:00 checklist must include numbered step ${step}`,
      );
    }

    for (const relPath of REQUIRED_MORNING_BRIEF_FILES) {
      assert.ok(
        morningBrief.includes(relPath),
        `docs/MORNING_BRIEF.md must reference "${relPath}"`,
      );
    }
  });

  test("every file, script, and directory referenced in docs/MORNING_BRIEF.md exists on disk and is non-empty", () => {
    for (const relPath of REQUIRED_MORNING_BRIEF_FILES) {
      assertNonEmptyFile(relPath);
    }
    for (const relPath of SUPPORTING_MORNING_BRIEF_FILES) {
      assertNonEmptyFile(relPath);
    }

    const evalRealDir = resolveRepoPath("eval/real");
    assert.equal(fs.existsSync(evalRealDir), true, "eval/real directory must exist");
    assert.equal(fs.statSync(evalRealDir).isDirectory(), true, "eval/real must be a directory");

    const extracted = extractMorningBriefRepoPaths(morningBrief);
    assert.ok(
      extracted.length >= REQUIRED_MORNING_BRIEF_FILES.length,
      `Expected at least ${REQUIRED_MORNING_BRIEF_FILES.length} extracted repo paths, got ${extracted.length}`,
    );
    for (const reqPath of REQUIRED_MORNING_BRIEF_FILES) {
      assert.ok(extracted.includes(reqPath), `Extractor must capture "${reqPath}" from docs/MORNING_BRIEF.md`);
    }

    for (const relPath of extracted) {
      if (relPath.endsWith(SLASH)) {
        const dirPath = resolveRepoPath(relPath.slice(0, -1));
        assert.equal(fs.existsSync(dirPath), true, `Referenced directory "${relPath}" must exist`);
        assert.equal(fs.statSync(dirPath).isDirectory(), true, `Referenced path "${relPath}" must be a directory`);
      } else {
        assertNonEmptyFile(relPath);
      }
    }
  });

  test("scripts/hw-session.sh and docs/HARDWARE_LOG.md support start, urls, probe, and stop for the 08:00 glasses session", () => {
    const hwSession = assertNonEmptyFile("scripts/hw-session.sh");
    const hardwareLog = assertNonEmptyFile("docs/HARDWARE_LOG.md");
    const serverPkg = JSON.parse(readRepoFile("server/package.json")) as {
      scripts?: Record<string, string>;
    };

    const shebang = "#!" + SLASH + "usr" + SLASH + "bin" + SLASH + "env bash";
    assert.ok(hwSession.startsWith(shebang), "scripts/hw-session.sh must start with bash shebang");
    assert.ok(hwSession.includes("set -euo pipefail"), "scripts/hw-session.sh must enable strict bash error handling");

    for (const subcmd of ["start)", "urls)", "probe)", "stop)"]) {
      assert.ok(hwSession.includes(subcmd), `scripts/hw-session.sh must handle subcommand ${subcmd}`);
    }

    assert.ok(hwSession.includes('SPOTTER="${SPOTTER:-0}"'), "scripts/hw-session.sh must forward SPOTTER flag");
    assert.ok(hwSession.includes("HOLDUP_KEY"), "scripts/hw-session.sh must configure HOLDUP_KEY");
    assert.ok(hwSession.includes('PORT="${PORT:-8787}"'), "scripts/hw-session.sh must default PORT to 8787");
    assert.ok(hwSession.includes(`$url${SLASH}?key=$key`), "scripts/hw-session.sh urls() must print phone and bridge URL with key");
    assert.ok(hwSession.includes(`$url${SLASH}hud${SLASH}?key=$key`), "scripts/hw-session.sh urls() must print Display Web App URL with key");
    assert.ok(hwSession.includes(`$url${SLASH}stage?key=$key`), "scripts/hw-session.sh urls() must print projector /stage URL with key");
    assert.ok(hwSession.includes(`$url${SLASH}api${SLASH}health`), "scripts/hw-session.sh urls() must print /api/health URL");
    assert.ok(hwSession.includes("hw:probe"), "scripts/hw-session.sh probe must invoke server hw:probe script");
    assert.equal(serverPkg.scripts?.["hw:probe"], "tsx scripts/hw-probe.ts");

    assert.ok(hardwareLog.includes("## Setup used"), "docs/HARDWARE_LOG.md must include Setup used section");
    assert.ok(hardwareLog.includes("## Checklist"), "docs/HARDWARE_LOG.md must include Checklist section");
    assert.ok(hardwareLog.includes("## Probe rows"), "docs/HARDWARE_LOG.md must include Probe rows section");
    for (const stepId of ["H1", "H2", "H3", "H4"]) {
      assert.match(hardwareLog, new RegExp(`^\\|\\s*${stepId}\\s*\\|`, "m"), `docs/HARDWARE_LOG.md must define row ${stepId}`);
    }
  });

  test("eval/score_real.sh, eval/real/labels.csv, docs/USER_TEST_KIT.md, and docs/USER_FEEDBACK.md are ready for real photos and user testing", () => {
    const scoreReal = assertNonEmptyFile("eval/score_real.sh");
    const labelsCsv = assertNonEmptyFile("eval/real/labels.csv");
    const userTestKit = assertNonEmptyFile("docs/USER_TEST_KIT.md");
    const userFeedback = assertNonEmptyFile("docs/USER_FEEDBACK.md");

    const shebang = "#!" + SLASH + "usr" + SLASH + "bin" + SLASH + "env bash";
    assert.ok(scoreReal.startsWith(shebang), "eval/score_real.sh must start with bash shebang");
    assert.ok(scoreReal.includes("set -euo pipefail"), "eval/score_real.sh must enable strict bash error handling");
    assert.ok(scoreReal.includes("eval/run_eval.py predict --set real"), "eval/score_real.sh must run real-photo prediction");
    assert.ok(scoreReal.includes("eval/run_eval.py score"), "eval/score_real.sh must score predictions");
    assert.ok(scoreReal.includes("eval/results/real_results.json"), "eval/score_real.sh must write eval/results/real_results.json");

    const csvLines = labelsCsv
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    assert.ok(csvLines.length >= 2, "eval/real/labels.csv must contain the header row and at least one template or photo row");
    assert.equal(
      csvLines[0],
      "file,kind,product,ingredient,strength,expiry,allergens,notes",
      "eval/real/labels.csv header must match the 8-column schema expected by score_real.sh",
    );
    for (const row of csvLines.slice(1)) {
      const cols = splitCsvRow(row);
      assert.equal(cols.length, 8, `Every row in eval/real/labels.csv must have 8 columns: "${row}"`);
      assert.ok(cols[0].length > 0, "Every row in eval/real/labels.csv must specify a filename");
      assert.ok(cols[1] === "medication" || cols[1] === "food", `Row kind must be medication or food, got "${cols[1]}"`);
    }

    assert.ok(userTestKit.includes("## The 10-minute session"), "docs/USER_TEST_KIT.md must define the 10-minute session");
    assert.ok(userTestKit.includes("## Ethics guardrails"), "docs/USER_TEST_KIT.md must define Ethics guardrails");
    assert.ok(userTestKit.includes("docs/USER_FEEDBACK.md"), "docs/USER_TEST_KIT.md must point to docs/USER_FEEDBACK.md");
    assert.ok(userFeedback.includes("USER_TEST_KIT.md"), "docs/USER_FEEDBACK.md must reference USER_TEST_KIT.md");
    assert.ok(userFeedback.toLowerCase().includes("consent"), "docs/USER_FEEDBACK.md must record verbal consent");
  });

  test("track submission files (deck/index.html, docs/DEMO_SCRIPT.md, GEMINI.md, GEMMA.md, docs/evidence/verda-fieldspotter.md) match What to submit where", () => {
    const submitSection = sections[3].body;
    const stageSection = sections[4].body;
    const deckHtml = assertNonEmptyFile("deck/index.html");
    const evalDoc = assertNonEmptyFile("docs/EVAL.md");
    const demoScript = assertNonEmptyFile("docs/DEMO_SCRIPT.md");
    const geminiDoc = assertNonEmptyFile("GEMINI.md");
    const gemmaDoc = assertNonEmptyFile("GEMMA.md");
    const verdaDoc = assertNonEmptyFile("docs/evidence/verda-fieldspotter.md");

    for (const trackRowToken of [
      "Meta: AI Glasses for Everyone, Everyday",
      "deck/index.html",
      "docs/DEMO_SCRIPT.md",
      "Google DeepMind: Best Use of Gemini API",
      "GEMINI.md",
      "Google DeepMind: Best Use of Gemma",
      "GEMMA.md",
      "Verda Compute Track",
      "docs/evidence/verda-fieldspotter.md",
    ]) {
      assert.ok(submitSection.includes(trackRowToken), `What to submit where must include "${trackRowToken}"`);
    }

    const slideRe = new RegExp("<section\\s+class=\"slide(?:\\s+[^\"]*)?\"[\\s\\S]*?<" + SLASH + "section>", "g");
    const slides = deckHtml.match(slideRe) ?? [];
    assert.equal(slides.length, 13, "deck/index.html must contain 13 slides");
    for (let n = 1; n <= 13; n++) {
      assert.ok(deckHtml.includes(`id="s${n}-h"`), `deck/index.html must contain slide heading #s${n}-h`);
    }
    assert.ok(deckHtml.includes("@media print"), "deck/index.html must include @media print rules for PDF handout export");
    assert.ok(deckHtml.includes("Which one is the evening pill?"), "deck/index.html Slide 1 must open with the Which one hook");
    assert.ok(
      (deckHtml.includes("1,060") || evalDoc.includes("1,060")) &&
        deckHtml.includes("1/536") &&
        deckHtml.includes("4/3,033"),
      "deck/index.html and docs/EVAL.md must include held-out v3 metrics",
    );
    assert.ok(deckHtml.includes("$0.003"), "deck/index.html adoption slide must include measured $0.003 cost per label read");

    for (const demoToken of ["HoldUp demo script (3 minutes)", "Pre-demo checklist", "Which one?", "SPOTTER=1", "Last-resort fallbacks"]) {
      assert.ok(demoScript.includes(demoToken), `docs/DEMO_SCRIPT.md must include "${demoToken}"`);
    }

    for (const geminiToken of ["gemini-3.8-live", "gemini-3.8-flash", "verify_label", "safety.ts", "1,740", "0 of 754", "1,060", "1/536", "4/3,033"]) {
      assert.ok(geminiDoc.includes(geminiToken), `GEMINI.md must include "${geminiToken}"`);
    }

    for (const gemmaToken of ["PaliGemma 2 3B", "LoRA", "348", "91.4%", "89.9%"]) {
      assert.ok(gemmaDoc.includes(gemmaToken), `GEMMA.md must include "${gemmaToken}"`);
    }

    for (const verdaToken of ["Verda", "H100", "yolov8n", "96.8%", "34.5 ms", "12.8 MB", "web/public/models/fieldspotter.onnx"]) {
      assert.ok(verdaDoc.includes(verdaToken), `docs/evidence/verda-fieldspotter.md must include "${verdaToken}"`);
    }
    const onnxStat = fs.statSync(resolveRepoPath("web/public/models/fieldspotter.onnx"));
    assert.ok(onnxStat.isFile() && onnxStat.size > 0, "web/public/models/fieldspotter.onnx must exist and be non-empty");

    for (const guardrailToken of ["It only states a dose it can read clearly", "1 of 536", "synthetic", "prototypes"]) {
      assert.ok(stageSection.includes(guardrailToken), `Say these carefully on stage must include "${guardrailToken}"`);
    }
  });

  test("test file maintains strict hygiene: zero comments, zero em dashes, and zero git or subprocess calls so zip archives pass", () => {
    const selfSource = fs.readFileSync(TEST_FILE, "utf8");
    assert.equal(selfSource.includes(LINE_COMMENT_TOKEN), false, "Test file must contain zero line comments");
    assert.equal(selfSource.includes(BLOCK_COMMENT_TOKEN), false, "Test file must contain zero block comments");
    assert.equal(selfSource.includes(HTML_COMMENT_TOKEN), false, "Test file must contain zero HTML comments");
    assert.equal(selfSource.includes(EM_DASH), false, "Test file must contain zero U+2014 em dashes");
    assert.equal(selfSource.includes(ESCAPED_EM_DASH), false, "Test file must contain zero escaped em dashes");
    assert.equal(selfSource.includes(CHILD_PROCESS_TOKEN), false, "Test file must not import subprocess module");
    assert.equal(selfSource.includes(EXEC_SYNC_TOKEN), false, "Test file must not call sync command runner");
    assert.equal(selfSource.includes(SPAWN_SYNC_TOKEN), false, "Test file must not call sync process spawner");
    assert.equal(selfSource.includes(DOT_GIT_TOKEN), false, "Test file must not inspect VCS metadata directory");
    for (const gitToken of GIT_CLI_TOKENS) {
      assert.equal(selfSource.includes(gitToken), false, `Test file must not invoke "${gitToken}"`);
    }
  });
});
