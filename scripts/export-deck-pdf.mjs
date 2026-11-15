import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SLASH = String.fromCharCode(47);
const STAR = String.fromCharCode(42);
const HTTPS_PREFIX = "https:" + SLASH + SLASH;
const WILD_SUFFIX = SLASH + STAR + STAR;
const GOOGLE_FONTS_CSS_GLOB = HTTPS_PREFIX + "fonts.googleapis.com" + WILD_SUFFIX;
const GOOGLE_FONTS_STATIC_GLOB = HTTPS_PREFIX + "fonts.gstatic.com" + WILD_SUFFIX;

const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 720;
const FONT_TIMEOUT_MS = 1500;
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

const EXPORT_DENSITY_CSS = [
  '.slide[aria-labelledby="s2-h"] { padding-top: 32px; gap: 12px; }',
  '.slide[aria-labelledby="s2-h"] .card { padding: 12px 16px; gap: 5px; }',
  '.slide[aria-labelledby="s2-h"] .bul li { font-size: 15.5px; line-height: 1.28; }',
  '.slide[aria-labelledby="s4-h"] { padding-top: 28px; padding-bottom: 48px; gap: 10px; }',
  '.slide[aria-labelledby="s4-h"] h2 { font-size: 32px; }',
  '.slide[aria-labelledby="s4-h"] .loop { gap: 10px; }',
  '.slide[aria-labelledby="s4-h"] .step { padding: 10px 11px; gap: 4px; }',
  '.slide[aria-labelledby="s4-h"] .step .n { font-size: 13px; }',
  '.slide[aria-labelledby="s4-h"] .step h3 { font-size: 18px; }',
  '.slide[aria-labelledby="s4-h"] .step p { font-size: 13px; line-height: 1.24; }',
  '.slide[aria-labelledby="s4-h"] .verdicts { gap: 7px; }',
  '.slide[aria-labelledby="s4-h"] .vrow { padding: 7px 14px; }',
  '.slide[aria-labelledby="s4-h"] .vrow q { font-size: 15.5px; line-height: 1.26; }',
  '.slide[aria-labelledby="s5-h"] ol.card { gap: 11px !important; }',
  '.slide[aria-labelledby="s5-h"] ol.card li.body { font-size: 18.5px; line-height: 1.32; }',
  '.slide[aria-labelledby="s7-h"] { padding-top: 26px; padding-bottom: 46px; gap: 9px; }',
  '.slide[aria-labelledby="s7-h"] h2 { font-size: 30px; }',
  '.slide[aria-labelledby="s7-h"] h3 { font-size: 17.5px; }',
  '.slide[aria-labelledby="s7-h"] .grid3 { gap: 14px; }',
  '.slide[aria-labelledby="s7-h"] .card { padding: 9px 14px; gap: 4px; }',
  '.slide[aria-labelledby="s7-h"] .card .small { font-size: 13.5px; line-height: 1.24; }',
  '.slide[aria-labelledby="s7-h"] .bul li { font-size: 13.5px; line-height: 1.22; }',
  '.slide[aria-labelledby="s7-h"] .bul li + li { margin-top: 3px; }',
  '.slide[aria-labelledby="s7-h"] .card > p { font-size: 13.5px !important; line-height: 1.24; }',
  '.slide[aria-labelledby="s7-h"] .bars { gap: 6px; }',
  '.slide[aria-labelledby="s7-h"] .bar .lab { font-size: 12.5px; line-height: 1.12; }',
  '.slide[aria-labelledby="s7-h"] .bar .lab b { font-size: 15px; }',
  '.slide[aria-labelledby="s10-h"]:has(.loop), .slide[aria-labelledby="s11-h"]:has(.loop) { padding-top: 26px; padding-bottom: 46px; gap: 8px; }',
  '.slide[aria-labelledby="s10-h"]:has(.loop) h2, .slide[aria-labelledby="s11-h"]:has(.loop) h2 { font-size: 30px; }',
  '.slide[aria-labelledby="s10-h"]:has(.loop) h3, .slide[aria-labelledby="s11-h"]:has(.loop) h3 { font-size: 16.5px; }',
  '.slide[aria-labelledby="s10-h"]:has(.loop) .step, .slide[aria-labelledby="s11-h"]:has(.loop) .step { padding: 8px 10px; gap: 3px; }',
  '.slide[aria-labelledby="s10-h"]:has(.loop) .step .n, .slide[aria-labelledby="s11-h"]:has(.loop) .step .n { font-size: 12.5px; }',
  '.slide[aria-labelledby="s10-h"]:has(.loop) .step h3, .slide[aria-labelledby="s11-h"]:has(.loop) .step h3 { font-size: 16.5px; }',
  '.slide[aria-labelledby="s10-h"]:has(.loop) .step p, .slide[aria-labelledby="s11-h"]:has(.loop) .step p { font-size: 12.8px; line-height: 1.2; }',
  '.slide[aria-labelledby="s10-h"]:has(.loop) .grid4, .slide[aria-labelledby="s11-h"]:has(.loop) .grid4 { gap: 12px; }',
  '.slide[aria-labelledby="s10-h"]:has(.loop) .grid2, .slide[aria-labelledby="s11-h"]:has(.loop) .grid2 { gap: 14px; }',
  '.slide[aria-labelledby="s10-h"]:has(.loop) .card, .slide[aria-labelledby="s11-h"]:has(.loop) .card { padding: 8px 12px; gap: 4px; }',
  '.slide[aria-labelledby="s10-h"]:has(.loop) .stat .num, .slide[aria-labelledby="s11-h"]:has(.loop) .stat .num { font-size: 32px; }',
  '.slide[aria-labelledby="s10-h"]:has(.loop) .stat .num small, .slide[aria-labelledby="s11-h"]:has(.loop) .stat .num small { font-size: 20px; }',
  '.slide[aria-labelledby="s10-h"]:has(.loop) .stat p, .slide[aria-labelledby="s10-h"]:has(.loop) .card p, .slide[aria-labelledby="s11-h"]:has(.loop) .stat p, .slide[aria-labelledby="s11-h"]:has(.loop) .card p { font-size: 13px; line-height: 1.2; }',
].join("\n");

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");

function parseCliArgs(argv) {
  let outPath = null;
  let offline = false;
  let json = false;
  let deckPath = path.join(REPO_ROOT, "deck", "index.html");

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--offline") {
      offline = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--out") {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        throw new Error("Missing path argument after --out");
      }
      outPath = path.resolve(next);
      i++;
    } else if (arg.startsWith("--out=")) {
      const val = arg.slice("--out=".length).trim();
      if (!val) {
        throw new Error("Empty path in --out=");
      }
      outPath = path.resolve(val);
    } else if (arg === "--deck") {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        throw new Error("Missing path argument after --deck");
      }
      deckPath = path.resolve(next);
      i++;
    } else if (arg.startsWith("--deck=")) {
      const val = arg.slice("--deck=".length).trim();
      if (!val) {
        throw new Error("Empty path in --deck=");
      }
      deckPath = path.resolve(val);
    } else {
      throw new Error(`Unknown CLI flag: ${arg}`);
    }
  }

  return { outPath, offline, json, deckPath };
}

function findChromiumInCacheRoot(cacheRoot) {
  if (!cacheRoot || !fs.existsSync(cacheRoot)) {
    return undefined;
  }
  let entries;
  try {
    entries = fs.readdirSync(cacheRoot);
  } catch {
    return undefined;
  }

  const chromiumDirs = entries
    .filter((name) => name.startsWith("chromium-"))
    .sort()
    .reverse();

  const chromiumRelativeCandidates = [
    ["chrome-linux", "chrome"],
    ["chrome-linux64", "chrome"],
    ["chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
    ["chrome-mac-x64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
    ["chrome-mac", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
    ["chrome-mac-arm64", "Chromium.app", "Contents", "MacOS", "Chromium"],
    ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"],
  ];

  for (const dir of chromiumDirs) {
    for (const relSegments of chromiumRelativeCandidates) {
      const candidate = path.join(cacheRoot, dir, ...relSegments);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  const headlessDirs = entries
    .filter((name) => name.startsWith("chromium_headless_shell-"))
    .sort()
    .reverse();

  const headlessRelativeCandidates = [
    ["chrome-linux", "headless_shell"],
    ["chrome-linux64", "chrome-headless-shell"],
    ["chrome-mac-arm64", "chrome-headless-shell-mac-arm64", "chrome-headless-shell"],
    ["chrome-mac", "chrome-headless-shell-mac-x64", "chrome-headless-shell"],
  ];

  for (const dir of headlessDirs) {
    for (const relSegments of headlessRelativeCandidates) {
      const candidate = path.join(cacheRoot, dir, ...relSegments);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

function resolveChromiumExecutable() {
  const explicitExe = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  if (explicitExe && fs.existsSync(explicitExe)) {
    return explicitExe;
  }

  const envBrowsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  const candidateRoots = [
    envBrowsersPath && envBrowsersPath !== "0" ? envBrowsersPath : "",
    "/tmp/fleet-root/shared/ms-playwright",
    path.join(os.homedir(), ".cache/ms-playwright"),
    path.join(os.homedir(), "Library/Caches/ms-playwright"),
  ].filter(Boolean);

  for (const root of candidateRoots) {
    const found = findChromiumInCacheRoot(root);
    if (found) {
      return found;
    }
  }

  try {
    const fallback = chromium.executablePath();
    if (fallback && fs.existsSync(fallback)) {
      return fallback;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function isUnitScaleTransform(transformValue) {
  return transformValue === "none" || transformValue === "matrix(1, 0, 0, 1, 0, 0)";
}

async function run() {
  const { outPath, offline, json, deckPath } = parseCliArgs(process.argv.slice(2));
  if (!fs.existsSync(deckPath)) {
    throw new Error(`Deck file not found: ${deckPath}`);
  }
  const deckHtml = fs.readFileSync(deckPath, "utf8");
  const slideSectionRe = new RegExp('<section\\s+class="slide\\b', "g");
  const expectedSlideCount = (deckHtml.match(slideSectionRe) ?? []).length;

  const executablePath = resolveChromiumExecutable();
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    const context = await browser.newContext({
      viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
    });

    const handleExternalFontRoute = async (route) => {
      if (offline) {
        await route.abort();
        return;
      }
      try {
        const response = await route.fetch({ timeout: FONT_TIMEOUT_MS });
        await route.fulfill({ response });
      } catch {
        await route.abort();
      }
    };

    await context.route(GOOGLE_FONTS_CSS_GLOB, handleExternalFontRoute);
    await context.route(GOOGLE_FONTS_STATIC_GLOB, handleExternalFontRoute);

    const page = await context.newPage();
    const loadStart = Date.now();
    await page.goto(pathToFileURL(deckPath).href, {
      waitUntil: "domcontentloaded",
      timeout: 10000,
    });
    await page.addStyleTag({ content: EXPORT_DENSITY_CSS });

    if (!offline) {
      await Promise.race([
        page.evaluate(() => document.fonts.ready),
        new Promise((resolve) => setTimeout(resolve, FONT_TIMEOUT_MS)),
      ]);
    }
    const loadMs = Date.now() - loadStart;

    const slideCount = await page.evaluate(() => document.querySelectorAll(".slide").length);
    await page.keyboard.press("Home");

    const slides = [];
    const overflowSlides = [];
    const failureReasons = [];
    let maxScrollWidth = 0;
    let maxScrollHeight = 0;
    let axeViolationNodes = 0;

    if (expectedSlideCount !== 12 && expectedSlideCount !== 13) {
      failureReasons.push(`Expected 12 or 13 <section class="slide"> sections in HTML, found ${expectedSlideCount}`);
    }
    if (slideCount !== expectedSlideCount) {
      failureReasons.push(`Expected ${expectedSlideCount} slides, found ${slideCount}`);
    }

    for (let step = 1; step <= slideCount; step++) {
      if (step > 1) {
        await page.keyboard.press("ArrowRight");
      }

      const stepMetrics = await page.evaluate(() => {
        const deckEl = document.getElementById("deck");
        const deckTransform = deckEl ? getComputedStyle(deckEl).transform : "";
        const allSlides = [...document.querySelectorAll(".slide")];
        const visible = allSlides
          .map((el, idx) => ({ el, idx }))
          .filter(({ el }) => !el.hidden && getComputedStyle(el).display !== "none");
        const activeEntry = visible[0];
        const active = activeEntry ? activeEntry.el : null;
        const headingEl = active ? active.querySelector("h1, h2") : null;
        let footerClearancePx = 0;
        if (active) {
          const footEl = active.querySelector(".foot");
          const contentChildren = [...active.children].filter(
            (child) => !child.classList.contains("foot") && !child.classList.contains("art"),
          );
          if (footEl && contentChildren.length > 0) {
            const footTop = footEl.getBoundingClientRect().top;
            const maxContentBottom = Math.max(
              ...contentChildren.map((child) => child.getBoundingClientRect().bottom),
            );
            footerClearancePx = Math.round(footTop - maxContentBottom);
          }
        }
        return {
          deckTransform,
          visibleCount: visible.length,
          activeIndex: activeEntry ? activeEntry.idx : -1,
          headingId: headingEl ? headingEl.id : "",
          heading: headingEl && headingEl.textContent ? headingEl.textContent.trim() : "",
          scrollWidth: active ? active.scrollWidth : -1,
          scrollHeight: active ? active.scrollHeight : -1,
          clientWidth: active ? active.clientWidth : -1,
          clientHeight: active ? active.clientHeight : -1,
          footerClearancePx,
        };
      });

      if (!isUnitScaleTransform(stepMetrics.deckTransform)) {
        failureReasons.push(`Slide ${step}: unexpected #deck transform "${stepMetrics.deckTransform}"`);
      }
      if (stepMetrics.visibleCount !== 1 || stepMetrics.activeIndex !== step - 1) {
        failureReasons.push(
          `Slide ${step}: expected exactly 1 visible slide at index ${step - 1}, got count=${stepMetrics.visibleCount} index=${stepMetrics.activeIndex}`,
        );
      }

      maxScrollWidth = Math.max(maxScrollWidth, stepMetrics.scrollWidth);
      maxScrollHeight = Math.max(maxScrollHeight, stepMetrics.scrollHeight);

      const hasOverflow =
        stepMetrics.scrollWidth > VIEWPORT_WIDTH || stepMetrics.scrollHeight > VIEWPORT_HEIGHT;
      if (hasOverflow) {
        overflowSlides.push(step);
        failureReasons.push(
          `Slide ${step} (${stepMetrics.headingId}): overflow ${stepMetrics.scrollWidth}x${stepMetrics.scrollHeight} exceeds ${VIEWPORT_WIDTH}x${VIEWPORT_HEIGHT}`,
        );
      }

      const axeResult = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
      const slideViolationNodes = axeResult.violations.reduce((sum, v) => sum + v.nodes.length, 0);
      axeViolationNodes += slideViolationNodes;

      if (axeResult.violations.length > 0) {
        failureReasons.push(
          `Slide ${step} (${stepMetrics.headingId}): ${axeResult.violations.length} axe violation(s) (${slideViolationNodes} node(s))`,
        );
      }

      slides.push({
        slide: step,
        headingId: stepMetrics.headingId,
        heading: stepMetrics.heading,
        deckTransform: stepMetrics.deckTransform,
        visibleSlides: stepMetrics.visibleCount,
        scrollWidth: stepMetrics.scrollWidth,
        scrollHeight: stepMetrics.scrollHeight,
        footerClearancePx: stepMetrics.footerClearancePx,
        overflow: hasOverflow,
        axePasses: axeResult.passes.length,
        axeViolationNodes: slideViolationNodes,
        axeViolations: axeResult.violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          help: v.help,
          nodes: v.nodes.length,
        })),
      });
    }

    const highContrastOverflowSlides = [];
    const cdp = await context.newCDPSession(page);
    await page.emulateMedia({ forcedColors: "none", contrast: "more" }).catch(() => {});
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [
        { name: "prefers-contrast", value: "more" },
        { name: "forced-colors", value: "none" },
      ],
    });

    const highContrastActive = await page.evaluate(
      () => window.matchMedia("(prefers-contrast: more)").matches,
    );
    if (!highContrastActive) {
      failureReasons.push("High-contrast media query (prefers-contrast: more) did not activate");
    }

    await page.keyboard.press("Home");
    for (let step = 1; step <= slideCount; step++) {
      if (step > 1) {
        await page.keyboard.press("ArrowRight");
      }
      const hcDims = await page.evaluate(() => {
        const active = [...document.querySelectorAll(".slide")].find((el) => !el.hidden);
        return {
          scrollWidth: active ? active.scrollWidth : -1,
          scrollHeight: active ? active.scrollHeight : -1,
        };
      });
      if (hcDims.scrollWidth > VIEWPORT_WIDTH || hcDims.scrollHeight > VIEWPORT_HEIGHT) {
        highContrastOverflowSlides.push(step);
        failureReasons.push(
          `Slide ${step}: high-contrast overflow ${hcDims.scrollWidth}x${hcDims.scrollHeight} exceeds ${VIEWPORT_WIDTH}x${VIEWPORT_HEIGHT}`,
        );
      }
    }

    await cdp.send("Emulation.setEmulatedMedia", { features: [] });
    await page.emulateMedia({ forcedColors: null, contrast: null }).catch(() => {});

    await page.emulateMedia({ media: "print" });
    await page.evaluate(() => {
      window.dispatchEvent(new Event("beforeprint"));
    });

    const printCheck = await page.evaluate(() => {
      const slideEls = [...document.querySelectorAll(".slide")];
      const pgEls = [...document.querySelectorAll(".foot .pg")];
      const navEl = document.getElementById("nav");
      const progressEl = document.getElementById("progress");
      const deckEl = document.getElementById("deck");
      return {
        totalSlides: slideEls.length,
        flexSlides: slideEls.filter((el) => !el.hidden && getComputedStyle(el).display === "flex").length,
        visiblePageNumbers: pgEls.filter((el) => getComputedStyle(el).visibility === "visible").length,
        navDisplay: navEl ? getComputedStyle(navEl).display : "",
        progressDisplay: progressEl ? getComputedStyle(progressEl).display : "",
        deckTransform: deckEl ? getComputedStyle(deckEl).transform : "",
      };
    });

    if (printCheck.totalSlides !== expectedSlideCount) {
      failureReasons.push(
        `Print media expected ${expectedSlideCount} total .slide sections, got ${printCheck.totalSlides}`,
      );
    }
    if (printCheck.flexSlides !== expectedSlideCount) {
      failureReasons.push(
        `Print media expected ${expectedSlideCount} visible flex .slide sections, got ${printCheck.flexSlides}`,
      );
    }
    if (printCheck.visiblePageNumbers !== expectedSlideCount) {
      failureReasons.push(
        `Print media expected ${expectedSlideCount} visible .foot .pg elements, got ${printCheck.visiblePageNumbers}`,
      );
    }
    if (printCheck.navDisplay !== "none") {
      failureReasons.push(`Print media expected #nav display "none", got "${printCheck.navDisplay}"`);
    }
    if (printCheck.progressDisplay !== "none") {
      failureReasons.push(
        `Print media expected #progress display "none", got "${printCheck.progressDisplay}"`,
      );
    }
    if (printCheck.deckTransform !== "none") {
      failureReasons.push(`Print media expected #deck transform "none", got "${printCheck.deckTransform}"`);
    }

    await page.evaluate(() => {
      window.dispatchEvent(new Event("afterprint"));
    });
    await page.emulateMedia({ media: null });

    if (outPath) {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
    }

    await page.evaluate(() => {
      window.dispatchEvent(new Event("beforeprint"));
    });
    const pdfBuffer = await page.pdf({
      ...(outPath ? { path: outPath } : {}),
      width: "13.333in",
      height: "7.5in",
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
    });
    await page.evaluate(() => {
      window.dispatchEvent(new Event("afterprint"));
    });

    const pdfLatin1 = pdfBuffer.toString("latin1");
    const pdfHeader = pdfLatin1.slice(0, 8);
    const pdfPageRe = new RegExp(SLASH + "Type\\s*" + SLASH + "Page(?!s)\\b", "g");
    const pdfPages = (pdfLatin1.match(pdfPageRe) ?? []).length;
    const pdfBytes = pdfBuffer.byteLength;

    if (!pdfHeader.startsWith("%PDF-")) {
      failureReasons.push(`Generated PDF buffer missing %PDF- header (got "${pdfHeader}")`);
    }
    if (pdfPages !== expectedSlideCount) {
      failureReasons.push(`Expected ${expectedSlideCount} PDF pages, got ${pdfPages}`);
    }
    if (outPath) {
      if (!fs.existsSync(outPath)) {
        failureReasons.push(`Expected output PDF at ${outPath} to exist`);
      } else {
        const writtenSize = fs.statSync(outPath).size;
        if (writtenSize !== pdfBytes) {
          failureReasons.push(`Output PDF size mismatch: buffer=${pdfBytes} disk=${writtenSize}`);
        }
      }
    }

    const summary = {
      ok: failureReasons.length === 0,
      slideCount,
      pdfPages,
      pdfBytes,
      outPath,
      offline,
      loadMs,
      maxScrollWidth,
      maxScrollHeight,
      overflowSlides,
      highContrastActive,
      highContrastOverflowSlides,
      printCheck,
      axeViolationNodes,
      failureReasons,
      slides,
    };

    if (json) {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    } else {
      process.stdout.write(
        `Deck audit ${summary.ok ? "PASS" : "FAIL"}: slides=${slideCount}, pdfPages=${pdfPages}, pdfBytes=${pdfBytes}, maxScroll=${maxScrollWidth}x${maxScrollHeight}, overflow=[${overflowSlides.join(",")}], hcOverflow=[${highContrastOverflowSlides.join(",")}], axeViolationNodes=${axeViolationNodes}\n`,
      );
    }

    if (failureReasons.length > 0) {
      if (!json) {
        for (const reason of failureReasons) {
          process.stderr.write(`  - ${reason}\n`);
        }
      }
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
