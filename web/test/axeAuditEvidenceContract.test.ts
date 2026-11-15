import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Verdict } from "../../shared/types.ts";
import { VerdictCard } from "../src/components/VerdictCard.tsx";
import { emptyRead } from "../src/lib/verdicts.ts";

Object.defineProperty(globalThis, "React", { value: React, configurable: true, writable: true });

const TEST_FILE = fileURLToPath(import.meta.url);
const TEST_DIR = path.dirname(TEST_FILE);
const REPO_DIR = path.resolve(TEST_DIR, "..", "..");
const BASELINE_EVIDENCE_PATH = path.join(REPO_DIR, "docs", "evidence", "a11y-axe.json");
const FULL_EVIDENCE_PATH = path.join(REPO_DIR, "docs", "evidence", "a11y-axe-full.json");
const SCRIPT_PATH = path.join(REPO_DIR, "scripts", "a11y-audit.mjs");
const VERDICT_CARD_PATH = path.join(REPO_DIR, "web", "src", "components", "VerdictCard.tsx");

type AxeViolationSummary = {
  id: string;
  impact: string | null;
  help: string;
  nodes: number;
};

type AxeScreenResult = {
  label: string;
  url: string;
  violations: AxeViolationSummary[];
  passes: number;
  incomplete: number;
};

type AxeEvidence = {
  tool: string;
  tags: string;
  base: string;
  when: string;
  totalViolationNodes: number;
  screenCount?: number;
  results: AxeScreenResult[];
};

function assertValidAxeReport(data: AxeEvidence, expectedCount: number): void {
  assert.equal(data.tool, "axe-core via @axe-core/playwright");
  assert.equal(data.tags, "WCAG 2.0/2.1/2.2 A+AA");
  assert.equal(typeof data.base, "string");
  const parsedBase = new URL(data.base);
  assert.ok(parsedBase.protocol === "http:" || parsedBase.protocol === "https:");

  assert.equal(typeof data.when, "string");
  assert.ok(Number.isFinite(Date.parse(data.when)), "when must be a valid ISO timestamp");

  assert.equal(data.totalViolationNodes, 0, "totalViolationNodes must be 0");
  assert.ok(Array.isArray(data.results), "results must be an array");
  assert.equal(data.results.length, expectedCount, `expected ${expectedCount} audited screens, found ${data.results.length}`);

  const labels = data.results.map((r) => r.label);
  const uniqueLabels = new Set(labels);
  assert.equal(uniqueLabels.size, labels.length, "all audited screen labels must be distinct");

  for (const r of data.results) {
    assert.equal(typeof r.label, "string");
    assert.ok(r.label.trim().length > 0, "result label must be non-empty");
    const parsedUrl = new URL(r.url);
    assert.ok(parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:");
    assert.ok(Array.isArray(r.violations), `violations must be array for ${r.label}`);
    assert.equal(r.violations.length, 0, `expected 0 violations on ${r.label}`);
    assert.equal(typeof r.passes, "number");
    assert.ok(Number.isInteger(r.passes) && r.passes > 0, `expected passes > 0 on ${r.label}, got ${r.passes}`);
    assert.equal(typeof r.incomplete, "number");
    assert.ok(Number.isInteger(r.incomplete) && r.incomplete >= 0, `invalid incomplete count on ${r.label}`);
  }
}

describe("axe-core WCAG 2.2 A+AA baseline and full 35-screen audit contract", () => {
  test("docs/evidence/a11y-axe.json preserves the 6-screen baseline with 0 violations for README parity", () => {
    assert.ok(fs.existsSync(BASELINE_EVIDENCE_PATH), "docs/evidence/a11y-axe.json must exist");
    const data = JSON.parse(fs.readFileSync(BASELINE_EVIDENCE_PATH, "utf8")) as AxeEvidence;
    assertValidAxeReport(data, 6);

    assert.deepEqual(
      data.results.map((r) => r.label),
      [
        "phone: first screen",
        "phone: after step 1",
        "phone: after step 2",
        "phone: after step 3",
        "phone: after step 4",
        "hud: verdict",
      ],
    );
  });

  test("docs/evidence/a11y-axe-full.json exists, parses cleanly, and reports 0 violation nodes across 35 distinct screens and slides", () => {
    assert.ok(fs.existsSync(FULL_EVIDENCE_PATH), "docs/evidence/a11y-axe-full.json must exist");
    const data = JSON.parse(fs.readFileSync(FULL_EVIDENCE_PATH, "utf8")) as AxeEvidence;
    assertValidAxeReport(data, 35);
    assert.equal(data.screenCount, 35, "screenCount must equal 35");
  });

  test("docs/evidence/a11y-axe-full.json covers onboarding, permissions, check states, verdicts, scene, AddSheet, DevicePanel, Profile, MedEditor, Privacy, AccessKey, HUD, Stage, and all 13 deck slides", () => {
    const data = JSON.parse(fs.readFileSync(FULL_EVIDENCE_PATH, "utf8")) as AxeEvidence;
    const labelsLower = data.results.map((r) => r.label.toLowerCase());

    const requiredSubstrings = [
      "welcome",
      "consent card 1",
      "consent card 2",
      "consent card 3",
      "permission step",
      "permission recovery",
      "check idle",
      "coaching",
      "verdict match",
      "verdict warning",
      "verdict unsure",
      "scene",
      "add-sheet",
      "device panel",
      "profile",
      "med-editor",
      "privacy",
      "access-key",
      "hud: idle",
      "hud: verdict",
      "stage: coaching",
      "stage: verdict",
      "deck: slides",
    ];

    for (let s = 2; s <= 13; s++) {
      requiredSubstrings.push(`deck: slide ${s}`);
    }

    for (const token of requiredSubstrings) {
      assert.ok(
        labelsLower.some((lbl) => lbl.includes(token)),
        `docs/evidence/a11y-axe-full.json must cover screen matching "${token}"`,
      );
    }

    const phoneScreens = data.results.filter((r) => r.label.toLowerCase().startsWith("phone:"));
    assert.equal(phoneScreens.length, 18, `expected 18 phone screens, found ${phoneScreens.length}`);

    const hudScreens = data.results.filter((r) => r.label.toLowerCase().startsWith("hud:"));
    assert.equal(hudScreens.length, 2, "must audit both HUD idle and HUD verdict states");
    for (const h of hudScreens) {
      assert.ok(new URL(h.url).pathname.startsWith("/hud"), `HUD audit URL must target /hud/: ${h.url}`);
    }

    const stageScreens = data.results.filter((r) => r.label.toLowerCase().startsWith("stage:"));
    assert.equal(stageScreens.length, 2, "must audit both stage coaching and stage verdict states");
    for (const st of stageScreens) {
      assert.ok(new URL(st.url).pathname.startsWith("/stage"), `stage audit URL must target /stage: ${st.url}`);
    }

    const deckScreens = data.results.filter((r) => r.label.toLowerCase().startsWith("deck:"));
    assert.equal(deckScreens.length, 13, `expected 13 deck slides audited, found ${deckScreens.length}`);
    for (const d of deckScreens) {
      assert.ok(new URL(d.url).pathname.startsWith("/deck"), `deck audit URL must target /deck/: ${d.url}`);
    }
  });

  test("VerdictCard.tsx renders <dl> per-field confidence disclosure strictly with <dt> and <dd> items to satisfy WCAG dlitem and definition-list rules", () => {
    const verdictCardSrc = fs.readFileSync(VERDICT_CARD_PATH, "utf8");
    const dlSectionMatch = /<dl className="fields">([\s\S]*?)<\/dl>/.exec(verdictCardSrc);
    assert.ok(dlSectionMatch, "VerdictCard.tsx must render <dl className=\"fields\">");
    const dlSection = dlSectionMatch[1];
    assert.match(dlSection, /<dt>\{label\}<\/dt>/);
    assert.match(dlSection, /<dd>\{show\(f\)\}<\/dd>/);
    assert.match(dlSection, /<dd className=\{`conf /);
    assert.doesNotMatch(dlSection, /<span\b/, "<dl> must not contain <span> siblings that violate WCAG dlitem");

    const sampleVerdict: Verdict = {
      level: "unsure",
      headline: "Metformin strength unclear",
      speech: "It looks like Metformin, but I cannot read the strength confidently.",
      read: {
        ...emptyRead("medication"),
        product: { value: "Metformin", confidence: 0.94 },
        strength: { value: null, confidence: 0.31 },
        allergens: { value: ["lactose"], confidence: 0.88 },
        readability: 0.62,
      },
      reasons: ["Strength below 0.8 confidence threshold"],
    };

    const html = renderToStaticMarkup(
      createElement(VerdictCard, {
        verdict: sampleVerdict,
        via: "live",
        onRepeat: () => {},
        onLog: () => {},
        onDismiss: () => {},
      }),
    );

    const renderedDlMatch = /<dl class="fields">([\s\S]*?)<\/dl>/.exec(html);
    assert.ok(renderedDlMatch, "rendered VerdictCard markup must include <dl class=\"fields\">");
    const renderedDlInner = renderedDlMatch[1];
    const tagNames = Array.from(renderedDlInner.matchAll(/<\/?([a-zA-Z0-9]+)\b/g), (m) => m[1].toLowerCase());
    for (const tag of tagNames) {
      assert.ok(
        tag === "div" || tag === "dt" || tag === "dd",
        `unexpected <${tag}> inside <dl class="fields">; only div[style*=contents], dt, and dd are valid`,
      );
    }
    assert.match(renderedDlInner, /<dd class="conf low" aria-label="confidence 31 percent">31%<\/dd>/);
    assert.match(renderedDlInner, /<dd class="conf " aria-label="confidence 94 percent">94%<\/dd>/);
  });

  test("scripts/a11y-audit.mjs supports default 6-screen baseline, --full 35-screen mode, --out file output, WCAG 2.2 A+AA tags, 3 viewports, and zero comments or dashes", () => {
    assert.ok(fs.existsSync(SCRIPT_PATH), "scripts/a11y-audit.mjs must exist");
    const script = fs.readFileSync(SCRIPT_PATH, "utf8");
    const selfSource = fs.readFileSync(TEST_FILE, "utf8");
    const fullEvidenceRaw = fs.readFileSync(FULL_EVIDENCE_PATH, "utf8");

    assert.match(script, /@axe-core\/playwright/);
    assert.match(script, /PLAYWRIGHT_BROWSERS_PATH/);
    assert.match(script, /createRequire/);
    assert.match(script, /"--full"/);
    assert.match(script, /"--out"/);
    assert.match(script, /runBaselineAudit/);
    assert.match(script, /runFullAudit/);
    assert.match(script, /details\[open\]/);
    assert.match(script, /#sonar-vol/);
    for (const tag of ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]) {
      assert.ok(script.includes(`"${tag}"`), `scripts/a11y-audit.mjs must enforce axe tag "${tag}"`);
    }

    assert.match(script, /width:\s*390,\s*height:\s*844/);
    assert.match(script, /width:\s*600,\s*height:\s*600/);
    assert.match(script, /width:\s*1280,\s*height:\s*720/);
    assert.match(script, /process\.exitCode\s*=\s*1|process\.exit\(\s*1\s*\)/);

    const lineCommentToken = String.fromCharCode(47, 47);
    const blockCommentStart = String.fromCharCode(47, 42);
    const blockCommentEnd = String.fromCharCode(42, 47);
    const emDash = String.fromCharCode(8212);
    const enDash = String.fromCharCode(8211);
    for (const [name, src] of [
      ["scripts/a11y-audit.mjs", script],
      ["web/test/axeAuditEvidenceContract.test.ts", selfSource],
    ] as const) {
      assert.equal(src.includes(lineCommentToken), false, `${name} must not contain line comments`);
      assert.equal(src.includes(blockCommentStart), false, `${name} must not contain block comments`);
      assert.equal(src.includes(blockCommentEnd), false, `${name} must not contain block comment closers`);
      assert.equal(src.includes(emDash), false, `${name} must not contain em dashes`);
      assert.equal(src.includes(enDash), false, `${name} must not contain en dashes`);
    }
    assert.equal(fullEvidenceRaw.includes(emDash), false, "docs/evidence/a11y-axe-full.json must not contain em dashes");
  });
});
