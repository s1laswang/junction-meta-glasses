import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.GEMINI_API_KEY = "";
process.env.ELEVENLABS_API_KEY = "";
process.env.HOLDUP_KEY = "";
process.env.HOLDUP_QUIET = "1";

const SLASH = String.fromCharCode(47);
const DOUBLE_SLASH = String.fromCharCode(47, 47);
const HTTP_SCHEME = "http:" + DOUBLE_SLASH;
const BLOCK_OPEN = String.fromCharCode(47, 42);
const BLOCK_CLOSE = String.fromCharCode(42, 47);
const HTML_COMMENT = String.fromCharCode(60, 33, 45, 45);
const EM_DASH = String.fromCharCode(8212);
const EN_DASH = String.fromCharCode(8211);

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_FILE);
const DEFAULT_ROOT = fs.existsSync(path.join(path.resolve(SCRIPT_DIR, ".."), "web"))
  ? path.resolve(SCRIPT_DIR, "..")
  : process.cwd();

const SHARED_BROWSERS = "/tmp/fleet-root/shared/ms-playwright";
const SHARED_WS_PKG = "/tmp/fleet-root/shared/junction-meta-glasses-venv/npm-ws/package.json";
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const EXPECTED_HONESTY_BANNER = "OFFLINE DEMO - PHONE CAMERA ONLY (no physical glasses)";
const SPOT_CHOICES = [
  "choice-match",
  "choice-warning",
  "choice-warning",
  "choice-warning",
  "choice-unsure",
];

if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync(SHARED_BROWSERS)) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = SHARED_BROWSERS;
}

function assertSelfHygiene() {
  const src = fs.readFileSync(SCRIPT_FILE, "utf8");
  assert.equal(src.includes(DOUBLE_SLASH), false, "verify-blindfold.mjs must contain zero line comments");
  assert.equal(src.includes(BLOCK_OPEN), false, "verify-blindfold.mjs must contain zero block comment openers");
  assert.equal(src.includes(BLOCK_CLOSE), false, "verify-blindfold.mjs must contain zero block comment closers");
  assert.equal(src.includes(HTML_COMMENT), false, "verify-blindfold.mjs must contain zero HTML comments");
  assert.equal(src.includes(EM_DASH), false, "verify-blindfold.mjs must contain zero em dashes");
  assert.equal(src.includes(EN_DASH), false, "verify-blindfold.mjs must contain zero en dashes");
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    assert.ok(
      c <= 127 && (c === 9 || c === 10 || c === 13 || c >= 32),
      `verify-blindfold.mjs must be pure ASCII; found charCode ${c} at index ${i}`,
    );
  }
}

function trimTrailingSlashes(value) {
  let out = String(value);
  while (out.length > 1 && out.endsWith(SLASH)) {
    out = out.slice(0, -1);
  }
  return out;
}

function trimLeadingSlashes(value) {
  let out = String(value);
  while (out.startsWith(SLASH)) {
    out = out.slice(1);
  }
  return out;
}

function parseCli(argv) {
  let json = false;
  let baseUrl = null;
  let rootDir = DEFAULT_ROOT;
  let outFile = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--url" && argv[i + 1]) {
      baseUrl = trimTrailingSlashes(argv[++i]);
    } else if (arg.startsWith("--url=")) {
      baseUrl = trimTrailingSlashes(arg.slice("--url=".length));
    } else if (arg === "--root" && argv[i + 1]) {
      rootDir = path.resolve(argv[++i]);
    } else if (arg.startsWith("--root=")) {
      rootDir = path.resolve(arg.slice("--root=".length));
    } else if (arg === "--out" && argv[i + 1]) {
      outFile = path.resolve(argv[++i]);
    } else if (arg.startsWith("--out=")) {
      outFile = path.resolve(arg.slice("--out=".length));
    } else if (!arg.startsWith("-") && !baseUrl) {
      baseUrl = trimTrailingSlashes(arg);
    }
  }

  return { json, baseUrl, rootDir, outFile };
}

function createModuleLoader(rootDir) {
  const loaders = [createRequire(import.meta.url)];
  const rootPkg = path.join(rootDir, "package.json");
  if (fs.existsSync(rootPkg)) {
    loaders.push(createRequire(rootPkg));
  }
  if (fs.existsSync(SHARED_WS_PKG)) {
    loaders.push(createRequire(SHARED_WS_PKG));
  }
  return function loadPkg(id) {
    let lastErr = null;
    for (const req of loaders) {
      try {
        return req(id);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr ?? new Error(`Cannot resolve package ${id}`);
  };
}

function findChromiumExecutable() {
  if (process.env.PLAYWRIGHT_EXECUTABLE_PATH && fs.existsSync(process.env.PLAYWRIGHT_EXECUTABLE_PATH)) {
    return process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  }
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    SHARED_BROWSERS,
    path.join(os.homedir(), ".cache", "ms-playwright"),
    path.join(os.homedir(), "Library", "Caches", "ms-playwright"),
  ].filter(Boolean);

  const relCandidates = [
    ["chrome-linux", "headless_shell"],
    ["chrome-linux", "chrome"],
    ["chrome-linux64", "chrome"],
    ["chrome-linux64", "chrome-headless-shell"],
    ["chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
    ["chrome-mac-x64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
    ["chrome-mac", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
    ["chrome-mac-arm64", "Chromium.app", "Contents", "MacOS", "Chromium"],
  ];

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const entries = fs.readdirSync(root).sort().reverse();
    for (const dir of entries) {
      if (!dir.startsWith("chromium-") && !dir.startsWith("chromium_headless_shell-")) continue;
      for (const rel of relCandidates) {
        const full = path.join(root, dir, ...rel);
        if (fs.existsSync(full)) return full;
      }
    }
  }
  return undefined;
}

const MIME_BY_EXT = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

function safeResolveUnder(baseDir, relPath) {
  const candidate = path.resolve(baseDir, relPath);
  const prefix = baseDir.endsWith(path.sep) ? baseDir : baseDir + path.sep;
  if (candidate !== baseDir && !candidate.startsWith(prefix)) {
    return null;
  }
  return candidate;
}

async function startStaticBlindfoldServer(rootDir) {
  const distDir = path.join(rootDir, "web", "dist");
  const publicDir = path.join(rootDir, "web", "public");
  const indexHtmlPath = path.join(distDir, "index.html");

  if (!fs.existsSync(indexHtmlPath)) {
    throw new Error(`Missing ${indexHtmlPath}. Build web first or pass --url / --root.`);
  }

  const securityHeaders = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "SAMEORIGIN",
  };

  const server = http.createServer((req, res) => {
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      const payload = JSON.stringify({
        type: "error",
        code: "not_found",
        message: "not found",
        recoverable: false,
      });
      res.writeHead(404, {
        ...securityHeaders,
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(payload);
      return;
    }

    const parsed = new URL(req.url ?? SLASH, HTTP_SCHEME + "127.0.0.1");
    const pathname = decodeURIComponent(parsed.pathname);

    if (pathname === "/favicon.ico") {
      res.writeHead(204, securityHeaders);
      res.end();
      return;
    }

    const rel = trimLeadingSlashes(pathname);
    let hitPath = null;

    if (rel.length > 0) {
      for (const candidateBase of [distDir, publicDir]) {
        if (!fs.existsSync(candidateBase)) continue;
        const resolved = safeResolveUnder(candidateBase, rel);
        if (resolved && fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
          hitPath = resolved;
          break;
        }
        const indexUnderDir = resolved ? path.join(resolved, "index.html") : null;
        if (indexUnderDir && fs.existsSync(indexUnderDir) && fs.statSync(indexUnderDir).isFile()) {
          hitPath = indexUnderDir;
          break;
        }
      }
    }

    const isSpaRoute =
      pathname === SLASH ||
      pathname === "/blindfold" ||
      pathname.startsWith("/blindfold" + SLASH) ||
      pathname === "/stage" ||
      pathname.startsWith("/stage" + SLASH);

    if (!hitPath && isSpaRoute) {
      res.writeHead(200, {
        ...securityHeaders,
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      if (method === "HEAD") {
        res.end();
      } else {
        res.end(fs.readFileSync(indexHtmlPath));
      }
      return;
    }

    if (!hitPath) {
      res.writeHead(404, {
        ...securityHeaders,
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(
        JSON.stringify({
          type: "error",
          code: "not_found",
          message: "not found",
          recoverable: false,
        }),
      );
      return;
    }

    const ext = path.extname(hitPath).toLowerCase();
    const contentType = MIME_BY_EXT[ext] ?? "application/octet-stream";
    const cacheControl = ext === ".html" || ext === ".json" ? "no-cache" : "public, max-age=3600";

    res.writeHead(200, {
      ...securityHeaders,
      "Content-Type": contentType,
      "Cache-Control": cacheControl,
    });
    if (method === "HEAD") {
      res.end();
    } else {
      res.end(fs.readFileSync(hitPath));
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    baseUrl: HTTP_SCHEME + "127.0.0.1:" + String(port),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

async function measureVisibleButtons(page, selector = "button") {
  return page.evaluate((sel) => {
    const nodes = Array.from(document.querySelectorAll(sel));
    const visible = [];
    for (const el of nodes) {
      if (!(el instanceof HTMLElement)) continue;
      const cs = window.getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      visible.push({
        text: (el.textContent ?? "").trim().slice(0, 60),
        className: typeof el.className === "string" ? el.className : "",
        testId: el.getAttribute("data-testid") ?? "",
        width: r.width,
        height: r.height,
      });
    }
    return visible;
  }, selector);
}

async function measureHorizontalOverflow(page) {
  return page.evaluate(() => {
    const vw = window.innerWidth;
    const docSw = document.documentElement.scrollWidth;
    const bodySw = document.body ? document.body.scrollWidth : 0;
    const maxSw = Math.max(docSw, bodySw);
    return {
      innerWidth: vw,
      scrollWidth: maxSw,
      horizontalOverflowPx: Math.max(0, Math.ceil(maxSw - vw)),
    };
  });
}

assertSelfHygiene();

const cli = parseCli(process.argv.slice(2));
const loadPkg = createModuleLoader(cli.rootDir);
const { chromium } = loadPkg("playwright");
const axeModule = loadPkg("@axe-core/playwright");
const AxeBuilder = axeModule.default ?? axeModule;

const startedServer = cli.baseUrl ? null : await startStaticBlindfoldServer(cli.rootDir);
const baseUrl = cli.baseUrl ?? startedServer.baseUrl;

const launchArgs = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"];
const executablePath = findChromiumExecutable();

let browser = null;
try {
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: launchArgs,
  });
} catch (err) {
  if (!executablePath) throw err;
  browser = await chromium.launch({ headless: true, args: launchArgs });
}

const consoleErrors = [];
const pageErrors = [];
const externalRequests = [];
const axeStates = [];
let totalMicRequests = 0;
let minPrimaryButtonHeightPx = Infinity;
let minVisibleButtonHeightPx = Infinity;
let maxReflowOverflowPx = 0;

function attachGuards(context) {
  context.addInitScript(() => {
    window.__bfMicRequests = 0;
    const md = navigator.mediaDevices;
    if (md && typeof md.getUserMedia === "function") {
      const orig = md.getUserMedia.bind(md);
      md.getUserMedia = function patchedGetUserMedia(constraints) {
        if (constraints && constraints.audio) {
          window.__bfMicRequests = (window.__bfMicRequests || 0) + 1;
        }
        return orig(constraints);
      };
    }
  });

  context.route(() => true, (route) => {
    const rawUrl = route.request().url();
    if (rawUrl.startsWith("data:") || rawUrl.startsWith("blob:")) {
      return route.continue();
    }
    let parsed = null;
    try {
      parsed = new URL(rawUrl);
    } catch {
      externalRequests.push(rawUrl);
      return route.abort();
    }
    if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
      externalRequests.push(rawUrl);
      return route.abort();
    }
    return route.continue();
  });
}

function attachPageListeners(page) {
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push(msg.text());
    }
  });
  page.on("pageerror", (err) => {
    pageErrors.push(String(err));
  });
}

async function runAxeCheck(page, stateName) {
  const report = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const violationNodes = report.violations.reduce((sum, v) => sum + v.nodes.length, 0);
  axeStates.push({
    state: stateName,
    passes: report.passes.length,
    violations: report.violations.length,
    violationNodes,
  });
  assert.equal(
    report.violations.length,
    0,
    `Axe WCAG 2.2 AA violation in ${stateName}: ${JSON.stringify(
      report.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length })),
    )}`,
  );
}

async function collectMicCount(page) {
  const count = await page.evaluate(() => Number(window.__bfMicRequests || 0));
  totalMicRequests += count;
}

try {
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  attachGuards(phoneCtx);
  const page = await phoneCtx.newPage();
  attachPageListeners(page);

  await page.goto(baseUrl + "/blindfold", { waitUntil: "networkidle" });

  const banner = page.locator('[data-testid="honesty-banner"]');
  await banner.waitFor({ state: "visible", timeout: 10000 });
  const bannerText = await banner.innerText();
  assert.ok(
    bannerText.includes(EXPECTED_HONESTY_BANNER),
    `Expected honesty banner to contain "${EXPECTED_HONESTY_BANNER}", got "${bannerText}"`,
  );

  const canvasInfo = await page.evaluate(() => {
    const c = document.querySelector('canvas.bf-pixel-canvas[role="img"]');
    if (!(c instanceof HTMLCanvasElement)) return null;
    const rect = c.getBoundingClientRect();
    return {
      ariaLabel: (c.getAttribute("aria-label") ?? "").trim(),
      width: c.width,
      height: c.height,
      boxWidth: rect.width,
      boxHeight: rect.height,
    };
  });
  assert.ok(canvasInfo, "Expected <canvas class=\"bf-pixel-canvas\" role=\"img\"> to exist");
  assert.ok(canvasInfo.ariaLabel.length > 0, "Expected non-empty aria-label on .bf-pixel-canvas");
  assert.ok(canvasInfo.width > 0 && canvasInfo.height > 0, "Expected positive canvas intrinsic dimensions");
  assert.ok(canvasInfo.boxWidth > 0 && canvasInfo.boxHeight > 0, "Expected positive canvas bounding box");

  const primaryBox = await page.locator('[data-testid="blindfold-primary-btn"]').boundingBox();
  assert.ok(primaryBox, "Expected [data-testid=\"blindfold-primary-btn\"] boundingBox");
  minPrimaryButtonHeightPx = Math.min(minPrimaryButtonHeightPx, primaryBox.height);
  assert.ok(
    primaryBox.height >= 88,
    `Expected [data-testid="blindfold-primary-btn"] height >= 88, got ${primaryBox.height}`,
  );

  for (const requiredBtnSel of [".bf-sr-toggle", ".bf-curtain-toggle", ".bf-repeat-btn", ".bf-sim-btn"]) {
    const matching = await measureVisibleButtons(page, requiredBtnSel);
    assert.ok(matching.length > 0, `Expected visible button(s) matching ${requiredBtnSel}`);
    for (const b of matching) {
      assert.ok(
        b.height >= 48,
        `Expected ${requiredBtnSel} ("${b.text}") height >= 48, got ${b.height}`,
      );
    }
  }

  const r1Buttons = await measureVisibleButtons(page, "button");
  assert.ok(r1Buttons.length > 0, "Expected visible buttons on Round 1");
  for (const b of r1Buttons) {
    minVisibleButtonHeightPx = Math.min(minVisibleButtonHeightPx, b.height);
    assert.ok(
      b.height >= 48,
      `Expected visible button "${b.text}" height >= 48 on Round 1, got ${b.height}`,
    );
  }

  await runAxeCheck(page, "round1-initial-en");

  const langSequence = ["fi", "sv", "en"];
  for (const code of langSequence) {
    const langBtn = page.locator(`[data-lang-btn="${code}"]`);
    await langBtn.waitFor({ state: "visible" });
    await langBtn.click();
    const docLang = await page.evaluate(() => document.documentElement.lang);
    assert.equal(docLang, code, `Expected document.documentElement.lang === "${code}", got "${docLang}"`);
    if (code !== "en") {
      await runAxeCheck(page, `round1-lang-${code}`);
    }
  }

  const simButtons = page.locator("[data-sim-box]");
  const simCount = await simButtons.count();
  assert.ok(simCount >= 2, `Expected at least 2 [data-sim-box] buttons, got ${simCount}`);

  for (const idx of [0, 1]) {
    await simButtons.nth(idx).click();
    const verdictBox = page.locator('[data-testid="blindfold-verdict"]');
    await verdictBox.waitFor({ state: "visible", timeout: 5000 });
    const actionButtons = await measureVisibleButtons(page, ".bf-action-btn");
    assert.ok(actionButtons.length > 0, "Expected visible .bf-action-btn buttons inside verdict");
    for (const ab of actionButtons) {
      minVisibleButtonHeightPx = Math.min(minVisibleButtonHeightPx, ab.height);
      assert.ok(
        ab.height >= 48,
        `Expected .bf-action-btn "${ab.text}" height >= 48, got ${ab.height}`,
      );
    }
    if (idx === 0) {
      await runAxeCheck(page, "round1-verdict-box-0");
    }
  }

  const clipsDrawer = page.locator("details.bf-clips-drawer");
  await clipsDrawer.waitFor({ state: "visible" });
  const wasOpen = await clipsDrawer.evaluate((el) => el.hasAttribute("open"));
  if (!wasOpen) {
    await clipsDrawer.locator("summary").click();
  }
  await page.locator("details.bf-clips-drawer[open]").waitFor({ state: "visible" });
  const clipCount = await page.locator("details.bf-clips-drawer [data-clip-id]").count();
  assert.equal(clipCount, 14, `Expected 14 [data-clip-id] buttons in .bf-clips-drawer, got ${clipCount}`);
  const clipButtons = await measureVisibleButtons(page, "details.bf-clips-drawer [data-clip-id]");
  assert.equal(clipButtons.length, 14, `Expected 14 visible [data-clip-id] buttons, got ${clipButtons.length}`);
  for (const cb of clipButtons) {
    minVisibleButtonHeightPx = Math.min(minVisibleButtonHeightPx, cb.height);
    assert.ok(cb.height >= 48, `Expected [data-clip-id] button height >= 48, got ${cb.height}`);
  }

  await page.locator('[data-testid="tab-round-2"]').click();
  const scoreboard = page.locator('[data-testid="spot-scoreboard"]');
  await scoreboard.waitFor({ state: "visible", timeout: 5000 });
  await runAxeCheck(page, "round2-card1-initial");

  for (let cardIdx = 0; cardIdx < SPOT_CHOICES.length; cardIdx++) {
    const choiceTestId = SPOT_CHOICES[cardIdx];
    const choiceBtn = page.locator(`[data-testid="${choiceTestId}"]`);
    await choiceBtn.waitFor({ state: "visible" });
    await choiceBtn.click();

    const reveal = page.locator('[data-testid="spot-reveal"]');
    await reveal.waitFor({ state: "visible", timeout: 5000 });

    const tableMeta = await page.evaluate(() => {
      const tbl = document.querySelector("table.bf-conf-table");
      if (!(tbl instanceof HTMLTableElement)) return null;
      return {
        hasCaption: Boolean(tbl.querySelector("caption")?.textContent?.trim()),
        colHeaders: tbl.querySelectorAll('th[scope="col"]').length,
        rowHeaders: tbl.querySelectorAll('th[scope="row"]').length,
      };
    });
    assert.ok(tableMeta, `Expected semantic table.bf-conf-table on card ${cardIdx + 1}`);
    assert.equal(tableMeta.hasCaption, true, "Expected non-empty caption on table.bf-conf-table");
    assert.ok(tableMeta.colHeaders >= 3, "Expected >= 3 th[scope=\"col\"] headers on table.bf-conf-table");
    assert.ok(tableMeta.rowHeaders >= 5, "Expected >= 5 th[scope=\"row\"] headers on table.bf-conf-table");

    const r2Buttons = await measureVisibleButtons(page, "button");
    for (const b of r2Buttons) {
      minVisibleButtonHeightPx = Math.min(minVisibleButtonHeightPx, b.height);
      assert.ok(
        b.height >= 48,
        `Expected visible button "${b.text}" height >= 48 on Round 2 card ${cardIdx + 1}, got ${b.height}`,
      );
    }

    if (cardIdx === 0) {
      await runAxeCheck(page, "round2-card1-reveal");
    }

    if (cardIdx < SPOT_CHOICES.length - 1) {
      const nextBtn = page.locator('[data-testid="spot-next-btn"]');
      await nextBtn.waitFor({ state: "visible" });
      await nextBtn.click();
    } else {
      const finalSummary = page.locator('[data-testid="spot-final-summary"]');
      await finalSummary.waitFor({ state: "visible", timeout: 5000 });
      const finalText = await finalSummary.innerText();
      assert.ok(
        finalText.includes("HoldUp 5/5"),
        `Expected final summary to include "HoldUp 5/5", got "${finalText}"`,
      );
      await runAxeCheck(page, "round2-final-summary");
    }
  }

  await page.goto(baseUrl + "/blindfold?round=spot", { waitUntil: "networkidle" });
  await page.locator('[data-testid="spot-scoreboard"]').waitFor({ state: "visible", timeout: 5000 });

  await collectMicCount(page);
  await phoneCtx.close();

  const reflowCtx = await browser.newContext({ viewport: { width: 320, height: 568 } });
  attachGuards(reflowCtx);
  const reflowPage = await reflowCtx.newPage();
  attachPageListeners(reflowPage);

  await reflowPage.goto(baseUrl + "/blindfold", { waitUntil: "networkidle" });
  await reflowPage.locator('[data-testid="honesty-banner"]').waitFor({ state: "visible", timeout: 10000 });
  const r1Reflow = await measureHorizontalOverflow(reflowPage);
  maxReflowOverflowPx = Math.max(maxReflowOverflowPx, r1Reflow.horizontalOverflowPx);
  assert.equal(r1Reflow.innerWidth, 320, `Expected 320px viewport width, got ${r1Reflow.innerWidth}`);
  assert.ok(
    r1Reflow.scrollWidth <= 320 && r1Reflow.horizontalOverflowPx === 0,
    `Expected Round 1 scrollWidth <= 320 at 320x568, got ${r1Reflow.scrollWidth}`,
  );
  await runAxeCheck(reflowPage, "reflow-320x568-round1");

  await reflowPage.locator('[data-testid="tab-round-2"]').click();
  await reflowPage.locator('[data-testid="spot-scoreboard"]').waitFor({ state: "visible", timeout: 5000 });
  const r2PreReflow = await measureHorizontalOverflow(reflowPage);
  maxReflowOverflowPx = Math.max(maxReflowOverflowPx, r2PreReflow.horizontalOverflowPx);
  assert.ok(
    r2PreReflow.scrollWidth <= 320 && r2PreReflow.horizontalOverflowPx === 0,
    `Expected Round 2 pre-reveal scrollWidth <= 320 at 320x568, got ${r2PreReflow.scrollWidth}`,
  );

  await reflowPage.locator('[data-testid="choice-match"]').click();
  await reflowPage.locator('[data-testid="spot-reveal"]').waitFor({ state: "visible", timeout: 5000 });
  const r2RevealReflow = await measureHorizontalOverflow(reflowPage);
  maxReflowOverflowPx = Math.max(maxReflowOverflowPx, r2RevealReflow.horizontalOverflowPx);
  assert.ok(
    r2RevealReflow.scrollWidth <= 320 && r2RevealReflow.horizontalOverflowPx === 0,
    `Expected Round 2 reveal scrollWidth <= 320 at 320x568, got ${r2RevealReflow.scrollWidth}`,
  );
  await runAxeCheck(reflowPage, "reflow-320x568-round2-reveal");

  await collectMicCount(reflowPage);
  await reflowCtx.close();

  assert.equal(consoleErrors.length, 0, `Unexpected console.error messages: ${consoleErrors.join(" | ")}`);
  assert.equal(pageErrors.length, 0, `Unexpected pageerror events: ${pageErrors.join(" | ")}`);
  assert.equal(totalMicRequests, 0, `Expected 0 microphone requests, got ${totalMicRequests}`);
  assert.equal(externalRequests.length, 0, `Unexpected external network requests: ${externalRequests.join(" | ")}`);

  const totalAxeViolations = axeStates.reduce((sum, s) => sum + s.violationNodes, 0);
  assert.equal(totalAxeViolations, 0, `Expected 0 total axe violation nodes, got ${totalAxeViolations}`);

  const summary = {
    ok: true,
    status: "PASS",
    baseUrl,
    honestyBannerVerified: true,
    canvasVerified: true,
    langsVerified: langSequence,
    simBoxesClicked: 2,
    simBoxesTotal: simCount,
    offlineVoiceClipsCount: 14,
    spotCardsCompleted: SPOT_CHOICES.length,
    holdupFinalScore: "5/5",
    minPrimaryButtonHeightPx: Math.round(minPrimaryButtonHeightPx * 100) / 100,
    minControlHeightPx: Math.round(minVisibleButtonHeightPx * 100) / 100,
    reflow320x568HorizontalOverflowPx: maxReflowOverflowPx,
    axeStatesAudited: axeStates.length,
    totalViolationNodes: totalAxeViolations,
    consoleErrors: consoleErrors.length,
    pageErrors: pageErrors.length,
    micRequests: totalMicRequests,
    externalRequests: externalRequests.length,
    axeStates,
  };

  if (cli.outFile) {
    fs.mkdirSync(path.dirname(cli.outFile), { recursive: true });
    fs.writeFileSync(cli.outFile, JSON.stringify(summary, null, 2) + "\n", "utf8");
  }

  if (cli.json) {
    process.stdout.write(JSON.stringify(summary) + "\n");
  } else {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  }
} finally {
  if (browser) {
    await browser.close();
  }
  if (startedServer) {
    await startedServer.close();
  }
}
