import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_FILE = fileURLToPath(import.meta.url);
const TEST_DIR = path.dirname(TEST_FILE);
const REPO_DIR = path.resolve(TEST_DIR, "..", "..");
const EXPORT_SCRIPT_PATH = path.join(REPO_DIR, "scripts", "export-deck-pdf.mjs");
const DECK_HTML_PATH = path.join(REPO_DIR, "deck", "index.html");
const SHARED_PLAYWRIGHT_DIR = "/tmp/fleet-root/shared/ms-playwright";

const SLASH = String.fromCharCode(47);
const ASTERISK = String.fromCharCode(42);
const LINE_COMMENT = SLASH + SLASH;
const BLOCK_COMMENT_OPEN = SLASH + ASTERISK;
const HTML_COMMENT_OPEN = "<" + "!--";
const EM_DASH = String.fromCharCode(8212);

type SlideAuditEntry = {
  slide: number;
  headingId: string;
  heading: string;
  deckTransform: string;
  visibleSlides: number;
  scrollWidth: number;
  scrollHeight: number;
  footerClearancePx: number;
  overflow: boolean;
  axePasses: number;
  axeViolationNodes: number;
  axeViolations: Array<{ id: string; impact: string | null; help: string; nodes: number }>;
};

type DeckPdfAuditSummary = {
  ok: boolean;
  slideCount: number;
  pdfPages: number;
  pdfBytes: number;
  outPath: string | null;
  offline: boolean;
  loadMs: number;
  maxScrollWidth: number;
  maxScrollHeight: number;
  overflowSlides: number[];
  highContrastActive: boolean;
  highContrastOverflowSlides: number[];
  printCheck: {
    totalSlides: number;
    flexSlides: number;
    visiblePageNumbers: number;
    navDisplay: string;
    progressDisplay: string;
    deckTransform: string;
  };
  axeViolationNodes: number;
  failureReasons: string[];
  slides: SlideAuditEntry[];
};

function hasChromiumInRoot(cacheRoot: string): boolean {
  if (!cacheRoot || !fs.existsSync(cacheRoot)) return false;
  let entries: string[];
  try {
    entries = fs.readdirSync(cacheRoot);
  } catch {
    return false;
  }

  const chromiumRelCandidates = [
    ["chrome-linux", "chrome"],
    ["chrome-linux64", "chrome"],
    ["chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
    ["chrome-mac-x64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
    ["chrome-mac", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
    ["chrome-mac-arm64", "Chromium.app", "Contents", "MacOS", "Chromium"],
    ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"],
    ["chrome-linux", "headless_shell"],
    ["chrome-linux64", "chrome-headless-shell"],
    ["chrome-mac-arm64", "chrome-headless-shell-mac-arm64", "chrome-headless-shell"],
    ["chrome-mac", "chrome-headless-shell-mac-x64", "chrome-headless-shell"],
  ];

  for (const dir of entries) {
    if (!dir.startsWith("chromium-") && !dir.startsWith("chromium_headless_shell-")) continue;
    for (const rel of chromiumRelCandidates) {
      if (fs.existsSync(path.join(cacheRoot, dir, ...rel))) return true;
    }
  }
  return false;
}

function detectHostChromium(): boolean {
  const explicit = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  if (explicit && fs.existsSync(explicit)) return true;

  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH ?? "",
    SHARED_PLAYWRIGHT_DIR,
    path.join(os.homedir(), ".cache/ms-playwright"),
    path.join(os.homedir(), "Library/Caches/ms-playwright"),
  ].filter(Boolean);

  return roots.some((r) => hasChromiumInRoot(r));
}

function listPdfFilesInDir(dirPath: string): string[] {
  if (!fs.existsSync(dirPath)) return [];
  return fs
    .readdirSync(dirPath)
    .filter((entry) => entry.toLowerCase().endsWith(".pdf"));
}

describe("Offline-Safe 16:9 Pitch Deck PDF Exporter and Real Chromium 12-or-13-Slide Overflow & axe WCAG 2.2 AA Audit", () => {
  const selfSource = fs.readFileSync(TEST_FILE, "utf8");
  const exportScriptSource = fs.readFileSync(EXPORT_SCRIPT_PATH, "utf8");
  const deckHtmlSource = fs.readFileSync(DECK_HTML_PATH, "utf8");
  const slideSectionRe = new RegExp('<section\\s+class="slide\\b', "g");
  const expectedSlideCount = (deckHtmlSource.match(slideSectionRe) ?? []).length;

  test("enforces strict self-hygiene: zero comments and zero em dashes across exporter script and contract test", () => {
    for (const [label, source] of [
      ["scripts/export-deck-pdf.mjs", exportScriptSource],
      ["web/test/deckLayoutOverflowAndPdfContract.test.ts", selfSource],
    ] as const) {
      assert.ok(source.length > 200, `${label} must be non-empty`);
      assert.equal(source.includes(EM_DASH), false, `${label} must contain zero em dashes`);
      assert.equal(source.includes(LINE_COMMENT), false, `${label} must contain zero line comments`);
      assert.equal(source.includes(BLOCK_COMMENT_OPEN), false, `${label} must contain zero block comments`);
      assert.equal(source.includes(HTML_COMMENT_OPEN), false, `${label} must contain zero HTML comments`);
    }
  });

  test("verifies static CLI contract, multi-OS browser discovery, offline font interception, WCAG 2.2 AA axe tags, and 13.333in x 7.5in PDF configuration", () => {
    assert.ok(exportScriptSource.includes('from "playwright"'), "Exporter must import playwright");
    assert.ok(exportScriptSource.includes("chromium"), "Exporter must launch chromium");
    assert.ok(
      exportScriptSource.includes('from "@axe-core/playwright"') && exportScriptSource.includes("AxeBuilder"),
      "Exporter must import AxeBuilder from @axe-core/playwright",
    );

    for (const discoveryToken of [
      "PLAYWRIGHT_BROWSERS_PATH",
      "/tmp/fleet-root/shared/ms-playwright",
      ".cache/ms-playwright",
      "Library/Caches/ms-playwright",
    ]) {
      assert.ok(
        exportScriptSource.includes(discoveryToken),
        `Exporter browser discovery must check "${discoveryToken}"`,
      );
    }

    for (const cliFlag of ["--out", "--offline", "--json"]) {
      assert.ok(exportScriptSource.includes(cliFlag), `Exporter must support CLI flag "${cliFlag}"`);
    }

    assert.ok(
      exportScriptSource.includes("fonts.googleapis.com") &&
        exportScriptSource.includes("fonts.gstatic.com") &&
        exportScriptSource.includes("route.abort()"),
      "Exporter must intercept fonts.googleapis.com and fonts.gstatic.com and abort cleanly offline",
    );
    assert.ok(
      exportScriptSource.includes("1500"),
      "Exporter must bound external font fetches with a 1500 ms timeout when not in --offline mode",
    );

    for (const wcagTag of ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]) {
      assert.ok(
        exportScriptSource.includes(`"${wcagTag}"`),
        `Exporter must audit WCAG 2.2 AA axe tag "${wcagTag}"`,
      );
    }

    assert.ok(
      exportScriptSource.includes("1280") &&
        exportScriptSource.includes("720") &&
        exportScriptSource.includes("scrollWidth") &&
        exportScriptSource.includes("scrollHeight"),
      "Exporter must audit 1280x720 slide scrollWidth and scrollHeight overflow",
    );

    assert.ok(
      exportScriptSource.includes("prefers-contrast") &&
        exportScriptSource.includes('"print"') &&
        exportScriptSource.includes("beforeprint"),
      "Exporter must audit high-contrast (prefers-contrast: more) and @media print states",
    );

    for (const pdfSetting of ['"13.333in"', '"7.5in"', "printBackground: true", "preferCSSPageSize: true"]) {
      assert.ok(
        exportScriptSource.includes(pdfSetting),
        `Exporter must pass 16:9 PDF setting ${pdfSetting} to page.pdf()`,
      );
    }
    assert.ok(
      deckHtmlSource.includes("size: 13.333in 7.5in; margin: 0;"),
      "deck/index.html @page rule must match exporter 13.333in x 7.5in zero-margin PDF dimensions",
    );
    assert.ok(
      expectedSlideCount === 12 || expectedSlideCount === 13,
      `Expected 12 or 13 <section class="slide" elements in deck/index.html, got ${expectedSlideCount}`,
    );
    assert.ok(
      exportScriptSource.includes("addStyleTag"),
      "Exporter must inject export density stylesheet via page.addStyleTag without modifying deck/index.html",
    );
    for (const scopedSlideId of ["s2-h", "s4-h", "s5-h", "s7-h", "s10-h", "s11-h"]) {
      assert.ok(
        exportScriptSource.includes(`.slide[aria-labelledby="${scopedSlideId}"]`),
        `scripts/export-deck-pdf.mjs must retain compact export layout guard for dense slide ${scopedSlideId}`,
      );
    }
  });

  test("rejects malformed CLI invocations cleanly without writing stray PDF files to workspace", () => {
    const unknownFlagRun = spawnSync(process.execPath, [EXPORT_SCRIPT_PATH, "--not-a-valid-flag"], {
      cwd: REPO_DIR,
      encoding: "utf8",
      timeout: 10000,
    });
    assert.notEqual(unknownFlagRun.status, 0, "Unknown CLI flag must exit non-zero");

    const missingOutRun = spawnSync(process.execPath, [EXPORT_SCRIPT_PATH, "--out"], {
      cwd: REPO_DIR,
      encoding: "utf8",
      timeout: 10000,
    });
    assert.notEqual(missingOutRun.status, 0, "Missing --out path argument must exit non-zero");

    assert.deepEqual(listPdfFilesInDir(REPO_DIR), [], "Zero .pdf files permitted in repo root");
    assert.deepEqual(listPdfFilesInDir(path.join(REPO_DIR, "deck")), [], "Zero .pdf files permitted in deck/");
    assert.deepEqual(listPdfFilesInDir(path.join(REPO_DIR, "scripts")), [], "Zero .pdf files permitted in scripts/");
  });

  test("executes real headless Chromium 12-or-13-slide overflow, high-contrast, print, axe WCAG 2.2 AA audit, and 16:9 PDF export", (t) => {
    const fr8SharedExists = fs.existsSync(SHARED_PLAYWRIGHT_DIR);
    const hostHasChromium = detectHostChromium();

    if (fr8SharedExists) {
      assert.equal(
        hostHasChromium,
        true,
        "FR8 shared /tmp/fleet-root/shared/ms-playwright exists, so Chromium binary must be available and never skip",
      );
    } else if (!hostHasChromium) {
      t.skip("No Playwright Chromium binary found on host");
      return;
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "holdup-deck-pdf-"));
    const tmpPdfPath = path.join(tmpDir, "holdup-pitch-deck.pdf");

    try {
      const stdout = execFileSync(
        process.execPath,
        [EXPORT_SCRIPT_PATH, "--offline", "--json", "--out", tmpPdfPath],
        {
          cwd: REPO_DIR,
          encoding: "utf8",
          timeout: 60000,
          env: {
            ...process.env,
            PLAYWRIGHT_BROWSERS_PATH:
              process.env.PLAYWRIGHT_BROWSERS_PATH || SHARED_PLAYWRIGHT_DIR,
          },
        },
      );

      const summary = JSON.parse(stdout) as DeckPdfAuditSummary;
      assert.equal(summary.ok, true, `Expected exporter ok=true, got failures: ${summary.failureReasons.join("; ")}`);
      assert.equal(summary.offline, true);
      assert.ok(
        expectedSlideCount === 12 || expectedSlideCount === 13,
        `Deck must contain 12 or 13 slides, got ${expectedSlideCount}`,
      );
      assert.equal(summary.slideCount, expectedSlideCount, `Deck must contain exact ${expectedSlideCount} slides`);
      assert.equal(summary.pdfPages, expectedSlideCount, `Exported 16:9 PDF must contain exact ${expectedSlideCount} pages`);
      assert.ok(summary.maxScrollWidth <= 1280, `Expected maxScrollWidth <= 1280, got ${summary.maxScrollWidth}`);
      assert.ok(summary.maxScrollHeight <= 720, `Expected maxScrollHeight <= 720, got ${summary.maxScrollHeight}`);
      assert.deepEqual(summary.overflowSlides, [], "Zero slides may overflow 1280x720");
      assert.equal(summary.highContrastActive, true, "prefers-contrast: more must activate in Chromium");
      assert.deepEqual(
        summary.highContrastOverflowSlides,
        [],
        "Zero slides may overflow 1280x720 under prefers-contrast: more",
      );

      assert.equal(summary.printCheck.totalSlides, expectedSlideCount);
      assert.equal(summary.printCheck.flexSlides, expectedSlideCount);
      assert.equal(summary.printCheck.visiblePageNumbers, expectedSlideCount);
      assert.equal(summary.printCheck.navDisplay, "none");
      assert.equal(summary.printCheck.progressDisplay, "none");
      assert.equal(summary.printCheck.deckTransform, "none");

      assert.equal(
        summary.axeViolationNodes,
        0,
        `Expected 0 axe-core WCAG 2.2 AA violation nodes across all ${expectedSlideCount} slides`,
      );
      assert.equal(
        summary.slides.length,
        expectedSlideCount,
        `Summary must report per-slide metrics for all ${expectedSlideCount} slides`,
      );

      summary.slides.forEach((slideEntry, idx) => {
        const expectedSlideNum = idx + 1;
        assert.equal(slideEntry.slide, expectedSlideNum);
        assert.equal(slideEntry.headingId, `s${expectedSlideNum}-h`);
        assert.ok(slideEntry.heading.length >= 5, `Slide ${expectedSlideNum} heading must be non-empty`);
        assert.equal(slideEntry.visibleSlides, 1, `Slide ${expectedSlideNum} must be the sole visible slide`);
        assert.ok(
          slideEntry.deckTransform === "none" || slideEntry.deckTransform === "matrix(1, 0, 0, 1, 0, 0)",
          `Slide ${expectedSlideNum} #deck transform must be unit scale at 1280x720, got "${slideEntry.deckTransform}"`,
        );
        assert.ok(slideEntry.scrollWidth <= 1280, `Slide ${expectedSlideNum} scrollWidth <= 1280`);
        assert.ok(slideEntry.scrollHeight <= 720, `Slide ${expectedSlideNum} scrollHeight <= 720`);
        assert.ok(
          slideEntry.footerClearancePx >= 10,
          `Slide ${expectedSlideNum} content must clear .foot by >= 10px, got ${slideEntry.footerClearancePx}px`,
        );
        assert.equal(slideEntry.overflow, false, `Slide ${expectedSlideNum} overflow must be false`);
        assert.ok(slideEntry.axePasses > 0, `Slide ${expectedSlideNum} must pass > 0 axe WCAG rules`);
        assert.equal(slideEntry.axeViolationNodes, 0, `Slide ${expectedSlideNum} must have 0 axe violation nodes`);
        assert.deepEqual(slideEntry.axeViolations, [], `Slide ${expectedSlideNum} must have 0 axe violations`);
      });

      assert.equal(fs.existsSync(tmpPdfPath), true, "Temp PDF file must be written when --out is specified");
      const pdfBuf = fs.readFileSync(tmpPdfPath);
      assert.ok(pdfBuf.byteLength > 15000, `Expected PDF > 15000 bytes, got ${pdfBuf.byteLength}`);
      assert.equal(pdfBuf.byteLength, summary.pdfBytes, "Written PDF byte length must match JSON summary pdfBytes");

      const pdfLatin1 = pdfBuf.toString("latin1");
      assert.equal(
        pdfLatin1.startsWith("%PDF-1."),
        true,
        `Written PDF must start with "%PDF-1.", got "${pdfLatin1.slice(0, 8)}"`,
      );
      const pdfPagePattern = new RegExp(SLASH + "Type\\s*" + SLASH + "Page(?!s)\\b", "g");
      const countedPages = (pdfLatin1.match(pdfPagePattern) ?? []).length;
      assert.equal(
        countedPages,
        expectedSlideCount,
        `Written PDF binary must contain exact ${expectedSlideCount} Type Page objects`,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    assert.equal(fs.existsSync(tmpDir), false, "Temp PDF directory must be removed in finally block (DISK RULE)");
    assert.deepEqual(listPdfFilesInDir(REPO_DIR), [], "Zero .pdf files permitted in repo root");
    assert.deepEqual(listPdfFilesInDir(path.join(REPO_DIR, "deck")), [], "Zero .pdf files permitted in deck/");
    assert.deepEqual(listPdfFilesInDir(path.join(REPO_DIR, "scripts")), [], "Zero .pdf files permitted in scripts/");
  });
});
