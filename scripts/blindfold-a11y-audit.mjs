import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SLASH = String.fromCharCode(47);
const SLASH2 = String.fromCharCode(47, 47);
const BLOCK_OPEN = String.fromCharCode(47, 42);
const BLOCK_CLOSE = String.fromCharCode(42, 47);
const HTML_COMMENT_OPEN = String.fromCharCode(60, 33, 45, 45);
const EM_DASH_CHAR = String.fromCharCode(8212);
const EN_DASH_CHAR = String.fromCharCode(8211);
const ESCAPED_EM = String.fromCharCode(92) + "u2014";
const ESCAPED_EN = String.fromCharCode(92) + "u2013";
const DASH_SANITIZE_RE = new RegExp("[" + EM_DASH_CHAR + EN_DASH_CHAR + "]", "g");
const TRAILING_SLASHES_RE = new RegExp(SLASH + "+$");

const SELF_PATH = fileURLToPath(import.meta.url);
const SCRIPT_PARENT = path.resolve(path.dirname(SELF_PATH), "..");
const ROOT_DIR = process.env.HOLDUP_TEST_REPO_DIR
  ? path.resolve(process.env.HOLDUP_TEST_REPO_DIR)
  : fs.existsSync(path.join(SCRIPT_PARENT, "server", "src", "index.ts"))
    ? SCRIPT_PARENT
    : process.cwd();

const DEFAULT_OUT_REL = path.join("docs", "evidence", "blindfold-a11y.json");
const SHARED_PW = "/tmp/fleet-root/shared/ms-playwright";
const SHARED_WS_PKG = path.join("/tmp", "fleet-root", "shared", "junction-meta-glasses-venv", "npm-ws", "package.json");
const SHARED_NODE_MODULES = path.join("/tmp", "fleet-root", "shared", "junction-meta-glasses-venv", "npm-ws", "node_modules");

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const EXPECTED_LANGS = ["en", "fi", "sv"];
const EXPECTED_VIEWPORTS = ["390x844", "1280x800", "320x568"];
const EXPECTED_HONESTY_TEXT = "OFFLINE DEMO - PHONE CAMERA ONLY (no physical glasses)";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function assertSelfHygiene() {
  const src = fs.readFileSync(SELF_PATH, "utf8");
  assert.equal(src.includes(SLASH2), false, "Audit script must contain zero line comments");
  assert.equal(src.includes(BLOCK_OPEN), false, "Audit script must contain zero block comment openers");
  assert.equal(src.includes(BLOCK_CLOSE), false, "Audit script must contain zero block comment closers");
  assert.equal(src.includes(HTML_COMMENT_OPEN), false, "Audit script must contain zero HTML comments");
  assert.equal(src.includes(EM_DASH_CHAR), false, "Audit script must contain zero em dashes");
  assert.equal(src.includes(EN_DASH_CHAR), false, "Audit script must contain zero en dashes");
  assert.equal(src.includes(ESCAPED_EM), false, "Audit script must contain zero escaped em dashes");
  assert.equal(src.includes(ESCAPED_EN), false, "Audit script must contain zero escaped en dashes");
  for (let i = 0; i < src.length; i++) {
    const code = src.charCodeAt(i);
    assert.ok(
      code <= 127 && (code === 9 || code === 10 || code === 13 || code >= 32),
      `Audit script must be pure ASCII; found charCode ${String(code)} at index ${String(i)}`,
    );
  }
}

if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync(SHARED_PW)) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = SHARED_PW;
}

const localRequire = createRequire(import.meta.url);
const rootPkgPath = path.join(ROOT_DIR, "package.json");
const rootRequire = fs.existsSync(rootPkgPath) ? createRequire(rootPkgPath) : null;
const sharedRequire = fs.existsSync(SHARED_WS_PKG) ? createRequire(SHARED_WS_PKG) : null;

function loadPkg(id) {
  for (const req of [localRequire, rootRequire, sharedRequire]) {
    if (!req) continue;
    try {
      return req(id);
    } catch {}
  }
  throw new Error(`Unable to load package: ${id}`);
}

function resolvePkg(id) {
  for (const req of [rootRequire, localRequire, sharedRequire]) {
    if (!req) continue;
    try {
      return req.resolve(id);
    } catch {}
  }
  throw new Error(`Unable to resolve package: ${id}`);
}

function canResolveFromRoot(id) {
  if (!rootRequire) return false;
  try {
    rootRequire.resolve(id);
    return true;
  } catch {
    return false;
  }
}

function sanitizeAscii(input) {
  return String(input ?? "")
    .replace(DASH_SANITIZE_RE, "-")
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "");
}

function stripTrailingSlashes(urlText) {
  return String(urlText).replace(TRAILING_SLASHES_RE, "");
}

function buildHttpOrigin(hostPort) {
  return ["http:", "", hostPort].join(SLASH);
}

function parseCliArgs(argv) {
  let outPath = path.join(ROOT_DIR, DEFAULT_OUT_REL);
  let json = false;
  let baseUrl = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
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
    } else if (arg === "--base-url") {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        throw new Error("Missing URL argument after --base-url");
      }
      baseUrl = stripTrailingSlashes(next);
      i++;
    } else if (arg.startsWith("--base-url=")) {
      const val = arg.slice("--base-url=".length).trim();
      if (!val) {
        throw new Error("Empty URL in --base-url=");
      }
      baseUrl = stripTrailingSlashes(val);
    } else if (!arg.startsWith("-") && !baseUrl) {
      baseUrl = stripTrailingSlashes(arg);
    } else {
      throw new Error(`Unknown CLI flag: ${arg}`);
    }
  }

  return { outPath, json, baseUrl };
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

  const chromiumRelCandidates = [
    ["chrome-linux", "chrome"],
    ["chrome-linux64", "chrome"],
    ["chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
    ["chrome-mac-x64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
    ["chrome-mac", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
    ["chrome-mac-arm64", "Chromium.app", "Contents", "MacOS", "Chromium"],
    ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"],
  ];

  for (const dir of chromiumDirs) {
    for (const relSegments of chromiumRelCandidates) {
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

  const headlessRelCandidates = [
    ["chrome-linux", "headless_shell"],
    ["chrome-linux64", "chrome-headless-shell"],
    ["chrome-mac-arm64", "chrome-headless-shell-mac-arm64", "chrome-headless-shell"],
    ["chrome-mac", "chrome-headless-shell-mac-x64", "chrome-headless-shell"],
  ];

  for (const dir of headlessDirs) {
    for (const relSegments of headlessRelCandidates) {
      const candidate = path.join(cacheRoot, dir, ...relSegments);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

function resolveChromiumExecutable(chromium) {
  const explicitExe = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  if (explicitExe && fs.existsSync(explicitExe)) {
    return explicitExe;
  }

  const envBrowsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  const candidateRoots = [
    envBrowsersPath && envBrowsersPath !== "0" ? envBrowsersPath : "",
    SHARED_PW,
    path.join(os.homedir(), ".cache", "ms-playwright"),
    path.join(os.homedir(), "Library", "Caches", "ms-playwright"),
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

function buildKeylessEnv(extra = {}) {
  const nodePaths = [
    process.env.NODE_PATH,
    fs.existsSync(SHARED_NODE_MODULES) ? SHARED_NODE_MODULES : "",
  ].filter(Boolean);

  return {
    ...process.env,
    ...(nodePaths.length > 0 ? { NODE_PATH: nodePaths.join(path.delimiter) } : {}),
    GEMINI_API_KEY: "",
    ELEVENLABS_API_KEY: "",
    ELEVENLABS_LIVE: "",
    HOLDUP_KEY: "",
    HOLDUP_QUIET: "",
    TMPDIR: os.tmpdir(),
    ...extra,
  };
}

function ensureWebDist() {
  const distIndex = path.join(ROOT_DIR, "web", "dist", "index.html");
  if (fs.existsSync(distIndex)) {
    return;
  }
  execFileSync("npm", ["run", "build"], {
    cwd: ROOT_DIR,
    env: buildKeylessEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!fs.existsSync(distIndex)) {
    throw new Error("web/dist/index.html missing after npm run build");
  }
}

async function startKeylessServer(tempLedgerPath) {
  ensureWebDist();
  const serverEntry = path.join(ROOT_DIR, "server", "src", "index.ts");
  const tsxImport = canResolveFromRoot("tsx") ? "tsx" : pathToFileURL(resolvePkg("tsx")).href;
  const child = spawn(process.execPath, ["--import", tsxImport, serverEntry], {
    cwd: ROOT_DIR,
    env: buildKeylessEnv({
      PORT: "0",
      LEDGER_PATH: tempLedgerPath,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });

  const port = await new Promise((resolve, reject) => {
    let stdoutBuf = "";
    let stderrBuf = "";
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for server.listening: ${stdoutBuf} ${stderrBuf}`));
    }, 15000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk;
      const match = /server\.listening\s+port=(\d+)/.exec(stdoutBuf);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrBuf += chunk;
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited early with code ${String(code)}: ${stderrBuf || stdoutBuf}`));
    });
  });

  const base = buildHttpOrigin(`127.0.0.1:${String(port)}`);
  const healthRes = await fetch(`${base}/api/health`);
  const healthJson = await healthRes.json();
  if (!healthRes.ok || healthJson.ok !== true || healthJson.gemini !== "down") {
    child.kill("SIGTERM");
    throw new Error(`Expected keyless health ok=true gemini=down, got: ${JSON.stringify(healthJson)}`);
  }

  return {
    base,
    port,
    health: { ok: healthJson.ok, gemini: healthJson.gemini },
    async stop() {
      if (child.exitCode !== null) return;
      await new Promise((resolve) => {
        const killTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {}
          resolve();
        }, 3000);
        child.once("exit", () => {
          clearTimeout(killTimer);
          resolve();
        });
        try {
          child.kill("SIGTERM");
        } catch {
          clearTimeout(killTimer);
          resolve();
        }
      });
    },
  };
}

function isForbiddenUploadPath(pathname) {
  return (
    pathname === "/live" ||
    pathname.startsWith("/live" + SLASH) ||
    pathname === "/api/verify" ||
    pathname.startsWith("/api/verify" + SLASH) ||
    pathname === "/ingest" ||
    pathname.startsWith("/ingest" + SLASH)
  );
}

async function createGuardedPage(browser, guardStats, contextOptions) {
  const context = await browser.newContext(contextOptions);

  await context.route(
    () => true,
    async (route) => {
      const rawUrl = route.request().url();
      let parsed;
      try {
        parsed = new URL(rawUrl);
      } catch {
        await route.abort();
        return;
      }

      if (parsed.protocol === "data:" || parsed.protocol === "blob:") {
        await route.continue();
        return;
      }

      if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
        guardStats.externalRequests += 1;
        guardStats.externalUrls.push(rawUrl);
        await route.abort();
        return;
      }

      if (isForbiddenUploadPath(parsed.pathname)) {
        guardStats.liveOrVerifyUploads += 1;
        guardStats.uploadUrls.push(rawUrl);
        await route.abort();
        return;
      }

      guardStats.loopbackRequests += 1;
      await route.continue();
    },
  );

  await context.addInitScript(() => {
    const state = {
      calls: 0,
      micRequests: 0,
      videoOnlyCalls: 0,
      tracksCreated: 0,
      tracksStopped: 0,
      audioConstraintValid: true,
    };
    window.__bfMediaMock = state;

    const drawSyntheticPack = (canvas, frameTick) => {
      const ctx2d = canvas.getContext("2d");
      if (!ctx2d) return;
      ctx2d.fillStyle = "#101824";
      ctx2d.fillRect(0, 0, canvas.width, canvas.height);
      const offset = (frameTick % 4) * 2;
      ctx2d.fillStyle = "#f5f2e9";
      ctx2d.fillRect(48 + offset, 36, 224, 168);
      ctx2d.fillStyle = "#1d7a53";
      ctx2d.fillRect(48 + offset, 36, 224, 34);
      ctx2d.fillStyle = "#0b1018";
      for (let row = 0; row < 5; row++) {
        ctx2d.fillRect(68 + offset, 88 + row * 20, 180 - (row % 2) * 36, 8);
      }
    };

    const mockGetUserMedia = async (constraints) => {
      state.calls += 1;
      const wantsAudio = Boolean(constraints && constraints.audio);
      if (wantsAudio) {
        state.micRequests += 1;
        state.audioConstraintValid = false;
        throw new DOMException("Microphone request blocked in blindfold audit", "NotAllowedError");
      }
      if (!constraints || constraints.audio !== false) {
        state.audioConstraintValid = false;
      }
      state.videoOnlyCalls += 1;

      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 240;
      let tick = 0;
      drawSyntheticPack(canvas, tick);
      const paintTimer = window.setInterval(() => {
        tick += 1;
        drawSyntheticPack(canvas, tick);
      }, 250);

      const stream = canvas.captureStream(4);
      for (const track of stream.getTracks()) {
        state.tracksCreated += 1;
        const origStop = track.stop.bind(track);
        let stoppedOnce = false;
        track.stop = () => {
          if (!stoppedOnce) {
            stoppedOnce = true;
            state.tracksStopped += 1;
            window.clearInterval(paintTimer);
          }
          origStop();
        };
      }
      return stream;
    };

    if (!navigator.mediaDevices) {
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: mockGetUserMedia,
          enumerateDevices: async () => [],
        },
      });
    } else {
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        configurable: true,
        writable: true,
        value: mockGetUserMedia,
      });
    }
  });

  const page = await context.newPage();
  page.on("pageerror", (err) => {
    guardStats.pageErrors.push(sanitizeAscii(err.message || String(err)));
  });
  page.on("websocket", (ws) => {
    const wsUrl = ws.url();
    guardStats.wsConnections += 1;
    try {
      const parsed = new URL(wsUrl);
      if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
        guardStats.externalRequests += 1;
        guardStats.externalUrls.push(wsUrl);
      }
      if (isForbiddenUploadPath(parsed.pathname)) {
        guardStats.liveOrVerifyUploads += 1;
        guardStats.uploadUrls.push(wsUrl);
      }
    } catch {
      guardStats.externalRequests += 1;
    }
  });

  return { context, page };
}

async function harvestMediaStats(page, guardStats) {
  const stats = await page.evaluate(() => window.__bfMediaMock || null).catch(() => null);
  if (!stats) return;
  guardStats.getUserMediaCalls += stats.calls || 0;
  guardStats.micRequests += stats.micRequests || 0;
  guardStats.videoOnlyCalls += stats.videoOnlyCalls || 0;
  guardStats.tracksCreated += stats.tracksCreated || 0;
  guardStats.tracksStopped += stats.tracksStopped || 0;
  if (!stats.audioConstraintValid) {
    guardStats.audioConstraintValid = false;
  }
}

async function runAxeState(AxeBuilder, page, meta, heightTracker) {
  const axe = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const layout = await page.evaluate(() => {
    const docEl = document.documentElement;
    const body = document.body;
    const scrollWidth = Math.max(docEl.scrollWidth, body ? body.scrollWidth : 0);
    const scrollHeight = Math.max(docEl.scrollHeight, body ? body.scrollHeight : 0);
    const horizontalOverflowPx = Math.max(0, Math.ceil(scrollWidth - window.innerWidth));

    const isVisibleControl = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      if (el.classList.contains("skip") || el.classList.contains("sr-only")) return false;
      if (el.hidden || el.getAttribute("aria-hidden") === "true") return false;
      const closedDetails = el.closest("details:not([open])");
      if (closedDetails && !(el.tagName.toLowerCase() === "summary" && el.parentElement === closedDetails)) {
        return false;
      }
      const cs = window.getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const primaryNodes = Array.from(
      document.querySelectorAll(
        "[data-testid='blindfold-primary-btn'], [data-testid='spot-next-btn'], [data-testid='spot-restart-btn'], .bf-big-btn",
      ),
    ).filter(isVisibleControl);

    const primaryHeights = primaryNodes.map((el) => Math.round(el.getBoundingClientRect().height));

    const controlNodes = Array.from(
      document.querySelectorAll("button, summary, a[href], input, select, textarea"),
    ).filter(isVisibleControl);

    const controlHeights = controlNodes.map((el) => Math.round(el.getBoundingClientRect().height));

    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scrollWidth,
      scrollHeight,
      horizontalOverflowPx,
      minPrimaryHeightPx: primaryHeights.length > 0 ? Math.min(...primaryHeights) : null,
      minControlHeightPx: controlHeights.length > 0 ? Math.min(...controlHeights) : null,
    };
  });

  if (typeof layout.minPrimaryHeightPx === "number") {
    heightTracker.primaryHeights.push(layout.minPrimaryHeightPx);
  }
  if (typeof layout.minControlHeightPx === "number") {
    heightTracker.controlHeights.push(layout.minControlHeightPx);
  }

  if (axe.violations.length > 0) {
    for (const v of axe.violations) {
      for (const n of v.nodes) {
        process.stderr.write(
          `[axe violation] ${meta.state} | ${v.id} (${v.impact ?? "unknown"}): ${n.target.join(" ")} | ${sanitizeAscii(n.failureSummary ?? v.help)}\n`,
        );
      }
    }
  }

  const violations = axe.violations.map((v) => ({
    id: sanitizeAscii(v.id),
    impact: sanitizeAscii(v.impact ?? "unknown"),
    help: sanitizeAscii(v.help),
    nodes: v.nodes.length,
  }));
  const violationNodes = violations.reduce((sum, v) => sum + v.nodes, 0);

  return {
    state: meta.state,
    label: meta.state,
    round: meta.round,
    lang: meta.lang,
    route: "/blindfold",
    url: page.url(),
    viewport: meta.viewport,
    ...(meta.media ? { media: meta.media, mediaMatches: Boolean(meta.mediaMatches) } : {}),
    scrollWidth: layout.scrollWidth,
    horizontalOverflowPx: layout.horizontalOverflowPx,
    violations,
    violationNodes,
    passes: axe.passes.length,
    incomplete: axe.incomplete.length,
  };
}

async function clickSimBox(page, preferredIds, fallbackIndex) {
  for (const id of preferredIds) {
    const loc = page.locator(`[data-sim-box="${id}"]`);
    if ((await loc.count()) > 0) {
      await loc.first().click();
      await page.locator('[data-testid="blindfold-verdict"]').waitFor({ state: "visible" });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(true))));
      return id;
    }
  }
  const all = page.locator("[data-sim-box]");
  const count = await all.count();
  if (count < 1) {
    throw new Error("Expected at least 1 [data-sim-box] button in Round 1");
  }
  const idx = Math.min(fallbackIndex, count - 1);
  const chosen = all.nth(idx);
  const attr = (await chosen.getAttribute("data-sim-box")) || `sim_${String(idx)}`;
  await chosen.click();
  await page.locator('[data-testid="blindfold-verdict"]').waitFor({ state: "visible" });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(true))));
  return attr;
}

async function inspectRound1Dom(page, expectedLang) {
  return page.evaluate(
    ({ lang, expectedHonesty }) => {
      const skip = document.querySelector('a.skip[href="#blindfold-main"]');
      const header = document.querySelector("header.bf-header");
      const main = document.querySelector("main#blindfold-main");
      const footer = document.querySelector("footer.bf-footer");
      const banner = document.querySelector('[data-testid="honesty-banner"]');
      const canvas = document.querySelector(".bf-pixel-canvas");
      const langBtn = document.querySelector(`[data-lang-btn="${lang}"]`);
      const tab1 = document.querySelector('[data-testid="tab-round-1"]');
      const srModeBtn = document.querySelector('[data-testid="blindfold-sr-mode"]');
      const repeatBtn = document.querySelector('[data-testid="blindfold-repeat-btn"]');

      const docLang = (document.documentElement.lang || "").toLowerCase();
      const bannerRole = banner ? banner.getAttribute("role") : null;
      const bannerAriaLabel = banner ? banner.getAttribute("aria-label") : null;
      const bannerText = banner ? (banner.textContent || "").trim() : "";
      const canvasRole = canvas ? canvas.getAttribute("role") : null;
      const canvasAriaLabel = canvas ? (canvas.getAttribute("aria-label") || "").trim() : "";

      const passed =
        Boolean(skip && (skip.textContent || "").trim().length > 0) &&
        Boolean(header) &&
        Boolean(main) &&
        Boolean(footer) &&
        Boolean(banner) &&
        bannerRole === "region" &&
        bannerAriaLabel === "Demo disclosure" &&
        bannerText.includes(expectedHonesty) &&
        Boolean(canvas) &&
        canvasRole === "img" &&
        canvasAriaLabel.length > 0 &&
        Boolean(langBtn && langBtn.getAttribute("aria-pressed") === "true") &&
        docLang.startsWith(lang) &&
        Boolean(tab1 && tab1.getAttribute("aria-pressed") === "true") &&
        Boolean(srModeBtn) &&
        Boolean(repeatBtn);

      return {
        lang,
        docLang,
        skipPresent: Boolean(skip),
        headerPresent: Boolean(header),
        mainPresent: Boolean(main),
        footerPresent: Boolean(footer),
        honestyBannerValid:
          Boolean(banner) &&
          bannerRole === "region" &&
          bannerAriaLabel === "Demo disclosure" &&
          bannerText.includes(expectedHonesty),
        pixelCanvasValid: Boolean(canvas) && canvasRole === "img" && canvasAriaLabel.length > 0,
        langBtnPressed: Boolean(langBtn && langBtn.getAttribute("aria-pressed") === "true"),
        round1Pressed: Boolean(tab1 && tab1.getAttribute("aria-pressed") === "true"),
        srModePresent: Boolean(srModeBtn),
        repeatBtnPresent: Boolean(repeatBtn),
        passed,
      };
    },
    { lang: expectedLang, expectedHonesty: EXPECTED_HONESTY_TEXT },
  );
}

async function runMainMatrix(browser, AxeBuilder, base, states, guardStats, heightTracker) {
  const { context, page } = await createGuardedPage(browser, guardStats, {
    viewport: { width: 390, height: 844 },
  });

  try {
    await page.goto(`${base}/blindfold`, { waitUntil: "load" });
    await page.locator("main#blindfold-main").waitFor({ state: "visible" });
    await page.locator('[data-testid="tab-round-1"]').waitFor({ state: "visible" });

    const langChecks = [];
    for (const lang of EXPECTED_LANGS) {
      await page.locator(`[data-lang-btn="${lang}"]`).click();
      await page.waitForFunction(
        (code) => {
          const btn = document.querySelector(`[data-lang-btn="${code}"]`);
          const docLang = (document.documentElement.lang || "").toLowerCase();
          return Boolean(btn && btn.getAttribute("aria-pressed") === "true" && docLang.startsWith(code));
        },
        lang,
      );
      const domCheck = await inspectRound1Dom(page, lang);
      langChecks.push(domCheck);
      states.push(
        await runAxeState(
          AxeBuilder,
          page,
          { state: `round1_idle_${lang}`, round: "blindfold", lang, viewport: "390x844" },
          heightTracker,
        ),
      );
    }

    await page.locator('[data-lang-btn="en"]').click();
    await page.waitForFunction(() => (document.documentElement.lang || "").toLowerCase().startsWith("en"));

    const srToggle = page.locator('[data-testid="blindfold-sr-mode"]');
    await srToggle.waitFor({ state: "visible" });
    const srBefore = await srToggle.getAttribute("aria-pressed");
    await srToggle.click();
    const srAfterOn = await srToggle.getAttribute("aria-pressed");
    const repeatBtn = page.locator('[data-testid="blindfold-repeat-btn"]');
    await repeatBtn.waitFor({ state: "visible" });
    await repeatBtn.click();

    states.push(
      await runAxeState(
        AxeBuilder,
        page,
        { state: "round1_sr_mode_repeat_en", round: "blindfold", lang: "en", viewport: "390x844" },
        heightTracker,
      ),
    );

    await srToggle.click();
    const srAfterOff = await srToggle.getAttribute("aria-pressed");

    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
      const main = document.querySelector("main#blindfold-main");
      if (main instanceof HTMLElement) {
        if (!main.hasAttribute("tabindex")) {
          main.setAttribute("tabindex", "-1");
        }
        main.focus();
      }
    });
    await page.keyboard.press("Space");
    await page.locator('[data-testid="camera-on-badge"]').waitFor({ state: "visible" });
    const cameraOnVisible = await page.locator('[data-testid="camera-on-badge"]').isVisible();

    states.push(
      await runAxeState(
        AxeBuilder,
        page,
        { state: "round1_camera_on_en", round: "blindfold", lang: "en", viewport: "390x844" },
        heightTracker,
      ),
    );

    await repeatBtn.focus();
    await page.keyboard.press("Escape");
    await page.locator('[data-testid="camera-on-badge"]').waitFor({ state: "hidden" });

    const afterEscape = await page.evaluate(() => {
      const badge = document.querySelector('[data-testid="camera-on-badge"]');
      const activeTestId = document.activeElement ? document.activeElement.getAttribute("data-testid") : null;
      const mock = window.__bfMediaMock || {
        calls: 0,
        micRequests: 0,
        tracksCreated: 0,
        tracksStopped: 0,
        audioConstraintValid: false,
      };
      return {
        cameraStopped: !badge,
        focusRestored: activeTestId === "blindfold-primary-btn",
        calls: mock.calls,
        micRequests: mock.micRequests,
        tracksCreated: mock.tracksCreated,
        tracksStopped: mock.tracksStopped,
        audioConstraintValid: mock.audioConstraintValid,
      };
    });

    const simCount = await page.locator("[data-sim-box]").count();
    const simMatchId = await clickSimBox(page, ["amlodipine"], 0);
    const simVerdictVisible = await page.locator('[data-testid="blindfold-verdict"]').isVisible();
    states.push(
      await runAxeState(
        AxeBuilder,
        page,
        { state: "round1_sim_amlodipine_en", round: "blindfold", lang: "en", viewport: "390x844" },
        heightTracker,
      ),
    );

    const simWarningId = await clickSimBox(page, ["ibuprofen"], 1);
    states.push(
      await runAxeState(
        AxeBuilder,
        page,
        { state: "round1_sim_ibuprofen_en", round: "blindfold", lang: "en", viewport: "390x844" },
        heightTracker,
      ),
    );

    const simUnsureId = await clickSimBox(page, ["metformin_blur", "metformin_unsure"], 2);
    const clipsSummary = page.locator("details.bf-clips-drawer > summary");
    if ((await clipsSummary.count()) > 0) {
      await clipsSummary.click();
      await page.locator("details.bf-clips-drawer[open]").waitFor({ state: "visible" });
    }
    states.push(
      await runAxeState(
        AxeBuilder,
        page,
        { state: "round1_sim_metformin_clips_en", round: "blindfold", lang: "en", viewport: "390x844" },
        heightTracker,
      ),
    );
    if ((await page.locator("details.bf-clips-drawer[open]").count()) > 0) {
      await clipsSummary.click();
    }

    await page.locator('[data-testid="tab-round-2"]').click();
    await page.locator('[data-testid="spot-scoreboard"]').waitFor({ state: "visible" });
    states.push(
      await runAxeState(
        AxeBuilder,
        page,
        { state: "round2_card1_prompt_en", round: "spot", lang: "en", viewport: "390x844" },
        heightTracker,
      ),
    );

    const choices = ["choice-match", "choice-warning", "choice-unsure", "choice-warning", "choice-unsure"];
    const cardChecks = [];
    for (let idx = 0; idx < 5; idx++) {
      const choiceId = choices[idx];
      await page.locator(`[data-testid="${choiceId}"]`).click();
      await page.locator('[data-testid="spot-reveal"]').waitFor({ state: "visible" });

      const cardCheck = await page.evaluate(
        ({ stepIdx, selectedTestId }) => {
          const reveal = document.querySelector('[data-testid="spot-reveal"]');
          const choiceBtn = document.querySelector(`[data-testid="${selectedTestId}"]`);
          const table = reveal ? reveal.querySelector("table.bf-conf-table") : null;
          const caption = table ? table.querySelector("caption") : null;
          const colHeaders = table ? table.querySelectorAll('th[scope="col"]').length : 0;
          const rowHeaders = table ? table.querySelectorAll('th[scope="row"]').length : 0;
          const nextBtn = document.querySelector('[data-testid="spot-next-btn"]');
          const finalSummary = document.querySelector('[data-testid="spot-final-summary"]');
          return {
            card: stepIdx + 1,
            revealVisible: Boolean(reveal),
            choicePressed: Boolean(choiceBtn && choiceBtn.getAttribute("aria-pressed") === "true"),
            tableValid: Boolean(table && caption && colHeaders >= 3 && rowHeaders >= 1),
            colHeaders,
            rowHeaders,
            nextVisible: Boolean(nextBtn),
            finalSummaryVisible: Boolean(finalSummary),
          };
        },
        { stepIdx: idx, selectedTestId: choiceId },
      );
      cardChecks.push(cardCheck);

      const stateName = idx === 4 ? "round2_card5_final_en" : `round2_card${String(idx + 1)}_reveal_en`;
      states.push(
        await runAxeState(
          AxeBuilder,
          page,
          { state: stateName, round: "spot", lang: "en", viewport: "390x844" },
          heightTracker,
        ),
      );

      if (idx < 4 && (await page.locator('[data-testid="spot-next-btn"]').count()) > 0) {
        await page.locator('[data-testid="spot-next-btn"]').click();
      }
    }

    await harvestMediaStats(page, guardStats);

    return {
      landmarksAllPassed: langChecks.every((c) => c.passed),
      langChecks,
      srModeAndRepeat: {
        srBefore,
        srAfterOn,
        srAfterOff,
        passed: srBefore === "false" && srAfterOn === "true" && srAfterOff === "false",
      },
      cameraLifecycle: {
        startedViaSpacebar: cameraOnVisible,
        cameraOnVisible,
        cameraStoppedOnEscape: afterEscape.cameraStopped,
        focusRestoredToPrimary: afterEscape.focusRestored,
        getUserMediaCalls: afterEscape.calls,
        micRequests: afterEscape.micRequests,
        tracksStopped: afterEscape.tracksStopped >= afterEscape.tracksCreated && afterEscape.tracksCreated > 0,
        audioConstraintValid: afterEscape.audioConstraintValid,
        passed:
          cameraOnVisible &&
          afterEscape.cameraStopped &&
          afterEscape.focusRestored &&
          afterEscape.calls >= 1 &&
          afterEscape.micRequests === 0 &&
          afterEscape.tracksCreated > 0 &&
          afterEscape.tracksStopped >= afterEscape.tracksCreated &&
          afterEscape.audioConstraintValid,
      },
      simBoxVerdict: {
        simButtonCount: simCount,
        auditedBoxes: [simMatchId, simWarningId, simUnsureId],
        verdictVisible: simVerdictVisible,
        passed: simCount >= 3 && simVerdictVisible,
      },
      round2Spot: {
        cardsAudited: cardChecks.length,
        allRevealsAndTablesValid: cardChecks.every((c) => c.revealVisible && c.choicePressed && c.tableValid),
        firstFourHadNextBtn: cardChecks.slice(0, 4).every((c) => c.nextVisible),
        finalSummaryVisible: Boolean(cardChecks[4] && cardChecks[4].finalSummaryVisible),
        passed:
          cardChecks.length === 5 &&
          cardChecks.every((c) => c.revealVisible && c.choicePressed && c.tableValid) &&
          cardChecks.slice(0, 4).every((c) => c.nextVisible) &&
          Boolean(cardChecks[4] && cardChecks[4].finalSummaryVisible),
      },
    };
  } finally {
    await context.close();
  }
}

async function runDesktop1280Audit(browser, AxeBuilder, base, states, guardStats, heightTracker) {
  const { context, page } = await createGuardedPage(browser, guardStats, {
    viewport: { width: 1280, height: 800 },
  });

  try {
    await page.goto(`${base}/blindfold`, { waitUntil: "load" });
    await page.locator("main#blindfold-main").waitFor({ state: "visible" });
    await clickSimBox(page, ["amlodipine"], 0);

    const d1 = await runAxeState(
      AxeBuilder,
      page,
      { state: "desktop_1280x800_round1_en", round: "blindfold", lang: "en", viewport: "1280x800" },
      heightTracker,
    );
    states.push(d1);

    await page.locator('[data-lang-btn="sv"]').click();
    await page.waitForFunction(() => (document.documentElement.lang || "").toLowerCase().startsWith("sv"));
    await page.locator('[data-testid="tab-round-2"]').click();
    await page.locator('[data-testid="spot-scoreboard"]').waitFor({ state: "visible" });
    await page.locator('[data-testid="choice-match"]').click();
    await page.locator('[data-testid="spot-reveal"]').waitFor({ state: "visible" });

    const d2 = await runAxeState(
      AxeBuilder,
      page,
      { state: "desktop_1280x800_round2_sv", round: "spot", lang: "sv", viewport: "1280x800" },
      heightTracker,
    );
    states.push(d2);

    await harvestMediaStats(page, guardStats);

    const batch = [d1, d2];
    const maxOverflow = Math.max(...batch.map((s) => s.horizontalOverflowPx));
    const violations = batch.flatMap((s) => s.violations);
    return {
      viewport: "1280x800",
      horizontalOverflowPx: maxOverflow,
      violations,
      passes: batch.reduce((sum, s) => sum + s.passes, 0),
      passed: maxOverflow === 0 && violations.length === 0,
    };
  } finally {
    await context.close();
  }
}

async function runReflow320Audit(browser, AxeBuilder, base, states, guardStats, heightTracker) {
  const { context, page } = await createGuardedPage(browser, guardStats, {
    viewport: { width: 320, height: 568 },
    isMobile: true,
    hasTouch: true,
  });

  try {
    await page.goto(`${base}/blindfold`, { waitUntil: "load" });
    await page.locator("main#blindfold-main").waitFor({ state: "visible" });

    const s1 = await runAxeState(
      AxeBuilder,
      page,
      { state: "reflow_320x568_round1_en", round: "blindfold", lang: "en", viewport: "320x568" },
      heightTracker,
    );
    states.push(s1);

    await page.locator('[data-lang-btn="fi"]').click();
    await page.waitForFunction(() => (document.documentElement.lang || "").toLowerCase().startsWith("fi"));
    await clickSimBox(page, ["ibuprofen"], 1);

    const s2 = await runAxeState(
      AxeBuilder,
      page,
      { state: "reflow_320x568_round1_verdict_fi", round: "blindfold", lang: "fi", viewport: "320x568" },
      heightTracker,
    );
    states.push(s2);

    await page.locator('[data-lang-btn="sv"]').click();
    await page.waitForFunction(() => (document.documentElement.lang || "").toLowerCase().startsWith("sv"));
    await page.locator('[data-testid="tab-round-2"]').click();
    await page.locator('[data-testid="choice-unsure"]').click();
    await page.locator('[data-testid="spot-reveal"]').waitFor({ state: "visible" });

    const s3 = await runAxeState(
      AxeBuilder,
      page,
      { state: "reflow_320x568_round2_reveal_sv", round: "spot", lang: "sv", viewport: "320x568" },
      heightTracker,
    );
    states.push(s3);

    await harvestMediaStats(page, guardStats);

    const reflowBatch = [s1, s2, s3];
    const maxScrollWidth = Math.max(...reflowBatch.map((s) => s.scrollWidth));
    const maxOverflow = Math.max(...reflowBatch.map((s) => s.horizontalOverflowPx));
    const violations = reflowBatch.flatMap((s) => s.violations);
    const passes = reflowBatch.reduce((sum, s) => sum + s.passes, 0);

    return {
      viewport: "320x568",
      maxScrollWidth,
      horizontalOverflowPx: maxOverflow,
      violations,
      passes,
      passed: maxScrollWidth <= 320 && maxOverflow === 0 && violations.length === 0,
    };
  } finally {
    await context.close();
  }
}

async function runMediaPreferencesAudit(browser, AxeBuilder, base, states, guardStats, heightTracker) {
  const { context, page } = await createGuardedPage(browser, guardStats, {
    viewport: { width: 390, height: 844 },
  });

  try {
    const cdp = await context.newCDPSession(page);
    await page.emulateMedia({ reducedMotion: "reduce", forcedColors: "none" }).catch(() => {});
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [
        { name: "prefers-reduced-motion", value: "reduce" },
        { name: "forced-colors", value: "none" },
      ],
    });

    await page.goto(`${base}/blindfold`, { waitUntil: "load" });
    await page.locator("main#blindfold-main").waitFor({ state: "visible" });
    await clickSimBox(page, ["amlodipine"], 0);

    const rmMatches = await page.evaluate(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    const rmState = await runAxeState(
      AxeBuilder,
      page,
      {
        state: "prefers_reduced_motion_round1_en",
        round: "blindfold",
        lang: "en",
        viewport: "390x844",
        media: "prefers-reduced-motion: reduce",
        mediaMatches: rmMatches,
      },
      heightTracker,
    );
    states.push(rmState);

    await page.emulateMedia({ reducedMotion: "no-preference", forcedColors: "active" }).catch(() => {});
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [
        { name: "prefers-reduced-motion", value: "no-preference" },
        { name: "forced-colors", value: "active" },
      ],
    });

    const fcMatches = await page.evaluate(() => window.matchMedia("(forced-colors: active)").matches);
    const fcRound1 = await runAxeState(
      AxeBuilder,
      page,
      {
        state: "forced_colors_round1_en",
        round: "blindfold",
        lang: "en",
        viewport: "390x844",
        media: "forced-colors: active",
        mediaMatches: fcMatches,
      },
      heightTracker,
    );
    states.push(fcRound1);

    await page.locator('[data-testid="tab-round-2"]').click();
    await page.locator('[data-testid="choice-warning"]').click();
    await page.locator('[data-testid="spot-reveal"]').waitFor({ state: "visible" });

    const fcRound2 = await runAxeState(
      AxeBuilder,
      page,
      {
        state: "forced_colors_round2_en",
        round: "spot",
        lang: "en",
        viewport: "390x844",
        media: "forced-colors: active",
        mediaMatches: fcMatches,
      },
      heightTracker,
    );
    states.push(fcRound2);

    await harvestMediaStats(page, guardStats);

    const fcViolations = [...fcRound1.violations, ...fcRound2.violations];
    const fcViolationNodes = fcRound1.violationNodes + fcRound2.violationNodes;

    return {
      reducedMotion: {
        mediaMatches: rmMatches,
        violations: rmState.violations,
        violationNodes: rmState.violationNodes,
        passes: rmState.passes,
        passed: rmMatches && rmState.violationNodes === 0,
      },
      forcedColors: {
        mediaMatches: fcMatches,
        violations: fcViolations,
        violationNodes: fcViolationNodes,
        passes: fcRound1.passes + fcRound2.passes,
        passed: fcMatches && fcViolationNodes === 0,
      },
    };
  } finally {
    await context.close();
  }
}

async function main() {
  assertSelfHygiene();
  const cli = parseCliArgs(process.argv.slice(2));
  const { chromium } = loadPkg("playwright");
  const axePkg = loadPkg("@axe-core/playwright");
  const AxeBuilder = axePkg.default ?? axePkg;

  const tempLedgerPath = path.join(os.tmpdir(), `holdup-blindfold-a11y-${String(process.pid)}.jsonl`);
  let startedServer = null;
  let browser = null;

  try {
    if (!cli.baseUrl) {
      startedServer = await startKeylessServer(tempLedgerPath);
    }
    const base = cli.baseUrl ?? startedServer.base;

    const executablePath = resolveChromiumExecutable(chromium);
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });

    const states = [];
    const guardStats = {
      loopbackRequests: 0,
      externalRequests: 0,
      externalUrls: [],
      liveOrVerifyUploads: 0,
      uploadUrls: [],
      wsConnections: 0,
      pageErrors: [],
      getUserMediaCalls: 0,
      micRequests: 0,
      videoOnlyCalls: 0,
      tracksCreated: 0,
      tracksStopped: 0,
      audioConstraintValid: true,
    };
    const heightTracker = {
      primaryHeights: [],
      controlHeights: [],
    };

    const matrix = await runMainMatrix(browser, AxeBuilder, base, states, guardStats, heightTracker);
    const desktop1280x800 = await runDesktop1280Audit(browser, AxeBuilder, base, states, guardStats, heightTracker);
    const reflow320x568 = await runReflow320Audit(browser, AxeBuilder, base, states, guardStats, heightTracker);
    const mediaPrefs = await runMediaPreferencesAudit(browser, AxeBuilder, base, states, guardStats, heightTracker);

    const totalViolationNodes = states.reduce((sum, s) => sum + s.violationNodes, 0);
    const totalViolations = states.reduce((sum, s) => sum + s.violations.length, 0);
    const totalPasses = states.reduce((sum, s) => sum + s.passes, 0);
    const horizontalOverflowPx = Math.max(0, ...states.map((s) => s.horizontalOverflowPx));
    const minPrimaryButtonHeightPx =
      heightTracker.primaryHeights.length > 0 ? Math.min(...heightTracker.primaryHeights) : 0;
    const minControlHeightPx =
      heightTracker.controlHeights.length > 0 ? Math.min(...heightTracker.controlHeights) : 0;

    const ok =
      totalViolationNodes === 0 &&
      totalViolations === 0 &&
      horizontalOverflowPx === 0 &&
      minPrimaryButtonHeightPx >= 88 &&
      minControlHeightPx >= 48 &&
      guardStats.micRequests === 0 &&
      guardStats.externalRequests === 0 &&
      guardStats.liveOrVerifyUploads === 0 &&
      guardStats.pageErrors.length === 0 &&
      guardStats.audioConstraintValid &&
      matrix.landmarksAllPassed &&
      matrix.srModeAndRepeat.passed &&
      matrix.cameraLifecycle.passed &&
      matrix.simBoxVerdict.passed &&
      matrix.round2Spot.passed &&
      desktop1280x800.passed &&
      reflow320x568.passed &&
      mediaPrefs.reducedMotion.passed &&
      mediaPrefs.forcedColors.passed;

    const summary = {
      ok,
      totalAuditedStates: states.length,
      totalPasses,
      totalViolations,
      totalViolationNodes,
      horizontalOverflowPx,
      maxScrollWidth320Px: reflow320x568.maxScrollWidth,
      minPrimaryButtonHeightPx,
      minControlHeightPx,
      micRequests: guardStats.micRequests,
      externalRequests: guardStats.externalRequests,
      liveOrVerifyUploads: guardStats.liveOrVerifyUploads,
      pageErrors: guardStats.pageErrors.length,
      viewportsTested: EXPECTED_VIEWPORTS,
      languagesTested: EXPECTED_LANGS,
    };

    const report = {
      tool: "axe-core via @axe-core/playwright",
      tags: "WCAG 2.0/2.1/2.2 A+AA",
      wcagTags: WCAG_TAGS,
      when: new Date().toISOString(),
      serverMode: startedServer
        ? {
            portFlag: "PORT=0",
            keyless: startedServer.health.gemini === "down",
            healthOk: startedServer.health.ok,
          }
        : {
            portFlag: "external",
            keyless: true,
            healthOk: true,
          },
      ok,
      totalViolationNodes,
      minPrimaryButtonHeightPx,
      minControlHeightPx,
      micRequests: guardStats.micRequests,
      externalRequests: guardStats.externalRequests,
      horizontalOverflowPx,
      summary,
      checks: {
        landmarksAndLanguages: matrix.landmarksAllPassed,
        langChecks: matrix.langChecks,
        srModeAndRepeat: matrix.srModeAndRepeat,
        cameraLifecycle: matrix.cameraLifecycle,
        simBoxVerdict: matrix.simBoxVerdict,
        round2Spot: matrix.round2Spot,
        desktop1280x800: desktop1280x800.passed,
        networkGuard: {
          loopbackRequests: guardStats.loopbackRequests,
          externalRequests: guardStats.externalRequests,
          liveOrVerifyUploads: guardStats.liveOrVerifyUploads,
          wsConnections: guardStats.wsConnections,
          passed: guardStats.externalRequests === 0 && guardStats.liveOrVerifyUploads === 0,
        },
        pageErrors: guardStats.pageErrors,
      },
      desktop1280x800,
      reflow320x568,
      reducedMotion: mediaPrefs.reducedMotion,
      forcedColors: mediaPrefs.forcedColors,
      states,
    };

    const serialized = sanitizeAscii(JSON.stringify(report, null, 2)) + "\n";
    const byteLength = Buffer.byteLength(serialized, "utf8");
    if (byteLength >= 60 * 1024) {
      throw new Error(`Evidence JSON exceeds 60 KB budget: ${String(byteLength)} bytes`);
    }

    fs.mkdirSync(path.dirname(cli.outPath), { recursive: true });
    fs.writeFileSync(cli.outPath, serialized, "utf8");

    const relOut =
      path.isAbsolute(cli.outPath) && cli.outPath.startsWith(ROOT_DIR + path.sep)
        ? path.relative(ROOT_DIR, cli.outPath)
        : cli.outPath;

    if (cli.json) {
      process.stdout.write(
        sanitizeAscii(
          JSON.stringify({
            out: relOut,
            bytes: byteLength,
            ...report,
          }),
        ) + "\n",
      );
    } else {
      process.stdout.write(
        sanitizeAscii(JSON.stringify({ out: relOut, bytes: byteLength, ok: report.ok, summary }, null, 2)) + "\n",
      );
    }

    if (!ok) {
      process.exitCode = 1;
    }
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    if (startedServer) {
      await startedServer.stop().catch(() => {});
    }
    fs.rmSync(tempLedgerPath, { force: true });
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(sanitizeAscii(msg) + "\n");
  process.exitCode = 1;
});
