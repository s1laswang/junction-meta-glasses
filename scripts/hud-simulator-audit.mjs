import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_FILE);
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const WEB_ROOT = path.join(REPO_ROOT, "web");
const DIST_DIR = path.join(WEB_ROOT, "dist");

const SHARED_WS_PKG = path.join("/tmp", "fleet-root", "shared", "junction-meta-glasses-venv", "npm-ws", "package.json");
const SHARED_NODE_MODULES = path.join("/tmp", "fleet-root", "shared", "junction-meta-glasses-venv", "npm-ws", "node_modules");
const SHARED_WEB_NODE_MODULES = path.join("/tmp", "fleet-root", "shared", "junction-meta-glasses-venv", "npm-ws", "web", "node_modules");
const SHARED_BROWSERS = path.join("/tmp", "fleet-root", "shared", "ms-playwright");

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const SPATIAL_NAV_FLAG = "--enable-spatial-navigation";
const MIN_PURE_BLACK_RATIO = 0.75;
const MAX_LIT_RATIO = 0.25;

if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync(SHARED_BROWSERS)) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = SHARED_BROWSERS;
}

const localRequire = createRequire(import.meta.url);
const sharedRequire = fs.existsSync(SHARED_WS_PKG) ? createRequire(SHARED_WS_PKG) : null;

function loadPkg(id) {
  try {
    return localRequire(id);
  } catch {
    if (sharedRequire) return sharedRequire(id);
    throw new Error(`Cannot load package: ${id}`);
  }
}

function resolvePkg(id) {
  try {
    return localRequire.resolve(id);
  } catch {
    if (sharedRequire) return sharedRequire.resolve(id);
    throw new Error(`Cannot resolve package: ${id}`);
  }
}

function parseCliArgs(argv) {
  let outFile = null;
  let baseUrl = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out" && argv[i + 1]) {
      outFile = path.resolve(process.cwd(), argv[++i]);
    } else if (!arg.startsWith("-")) {
      baseUrl = arg.replace(/\/+$/, "");
    }
  }
  return { outFile, baseUrl };
}

if (process.env.HUD_AUDIT_TSX !== "1") {
  const tsxEntry = pathToFileURL(resolvePkg("tsx")).href;
  const nodePaths = [
    process.env.NODE_PATH,
    fs.existsSync(SHARED_WEB_NODE_MODULES) ? SHARED_WEB_NODE_MODULES : "",
    fs.existsSync(SHARED_NODE_MODULES) ? SHARED_NODE_MODULES : "",
  ].filter(Boolean);

  const child = spawn(process.execPath, ["--import", tsxEntry, SCRIPT_FILE, ...process.argv.slice(2)], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HUD_AUDIT_TSX: "1",
      HOLDUP_QUIET: "1",
      GEMINI_API_KEY: "offline-simulator-audit",
      ELEVENLABS_API_KEY: "",
      HOLDUP_KEY: "",
      NODE_PATH: nodePaths.join(path.delimiter),
    },
    stdio: "inherit",
  });

  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  process.exit(exitCode);
}

process.env.HOLDUP_QUIET = "1";

function httpOrigin(hostPort) {
  return ["http:", "", hostPort].join("/");
}

function wsOrigin(hostPort) {
  return ["ws:", "", hostPort].join("/");
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePngBuffer(buf) {
  const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 33 || !buf.subarray(0, 8).equals(pngSig)) {
    throw new Error("Invalid PNG signature");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatChunks = [];

  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }

  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`Unsupported PNG format: bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace}`);
  }

  const bpp = colorType === 6 ? 4 : 3;
  const rowBytes = width * bpp;
  const stride = rowBytes + 1;
  const inflated = zlib.inflateSync(Buffer.concat(idatChunks));
  if (inflated.length < height * stride) {
    throw new Error(`Truncated PNG scanlines: expected ${height * stride}, got ${inflated.length}`);
  }

  const rgba = Buffer.alloc(width * height * 4);
  let prevRow = new Uint8Array(rowBytes);

  for (let y = 0; y < height; y++) {
    const filterType = inflated[y * stride];
    const recon = new Uint8Array(rowBytes);
    const rowStart = y * stride + 1;

    for (let i = 0; i < rowBytes; i++) {
      const raw = inflated[rowStart + i];
      const left = i >= bpp ? recon[i - bpp] : 0;
      const up = prevRow[i];
      const upLeft = i >= bpp ? prevRow[i - bpp] : 0;

      if (filterType === 0) recon[i] = raw;
      else if (filterType === 1) recon[i] = (raw + left) & 0xff;
      else if (filterType === 2) recon[i] = (raw + up) & 0xff;
      else if (filterType === 3) recon[i] = (raw + ((left + up) >> 1)) & 0xff;
      else if (filterType === 4) recon[i] = (raw + paethPredictor(left, up, upLeft)) & 0xff;
      else throw new Error(`Unsupported PNG filter type ${filterType}`);
    }

    for (let x = 0; x < width; x++) {
      const dst = (y * width + x) * 4;
      const src = x * bpp;
      rgba[dst] = recon[src];
      rgba[dst + 1] = recon[src + 1];
      rgba[dst + 2] = recon[src + 2];
      rgba[dst + 3] = bpp === 4 ? recon[src + 3] : 255;
    }

    prevRow = recon;
  }

  return { bytes: buf.length, width, height, colorType, rgba };
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

function analyzeAdditiveFrame(pngBuf) {
  const decoded = decodePngBuffer(pngBuf);
  const totalPixels = decoded.width * decoded.height;
  let pureBlackPixels = 0;
  let nearBlackPixels = 0;
  let lumSum = 0;

  for (let i = 0; i < decoded.rgba.length; i += 4) {
    const r = decoded.rgba[i];
    const g = decoded.rgba[i + 1];
    const b = decoded.rgba[i + 2];
    if (r === 0 && g === 0 && b === 0) pureBlackPixels++;
    if (r <= 4 && g <= 4 && b <= 4) nearBlackPixels++;
    lumSum += (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  }

  const litPixels = totalPixels - pureBlackPixels;
  return {
    width: decoded.width,
    height: decoded.height,
    totalPixels,
    pureBlackPixels,
    pureBlackRatio: round4(pureBlackPixels / totalPixels),
    nearBlackPixels,
    nearBlackRatio: round4(nearBlackPixels / totalPixels),
    litPixels,
    litRatio: round4(litPixels / totalPixels),
    meanLuminance: round4(lumSum / totalPixels),
  };
}

function inspectPngIcon(pngBuf, opts = {}) {
  const decoded = decodePngBuffer(pngBuf);
  const pixelAlpha = (x, y) => decoded.rgba[(y * decoded.width + x) * 4 + 3];
  const transparentCorners =
    pixelAlpha(0, 0) === 0 &&
    pixelAlpha(decoded.width - 1, 0) === 0 &&
    pixelAlpha(0, decoded.height - 1) === 0 &&
    pixelAlpha(decoded.width - 1, decoded.height - 1) === 0;

  let transparentPixels = 0;
  let maskPixels = 0;
  let pureWhiteMask = true;

  if (opts.expectMonochrome) {
    for (let i = 0; i < decoded.rgba.length; i += 4) {
      const r = decoded.rgba[i];
      const g = decoded.rgba[i + 1];
      const b = decoded.rgba[i + 2];
      const a = decoded.rgba[i + 3];
      if (a === 0) {
        transparentPixels++;
      } else {
        maskPixels++;
        if (r !== 255 || g !== 255 || b !== 255) pureWhiteMask = false;
      }
    }
  }

  return {
    bytes: decoded.bytes,
    width: decoded.width,
    height: decoded.height,
    transparentCorners,
    ...(opts.expectMonochrome ? { pureWhiteMask, transparentPixels, maskPixels } : {}),
  };
}

async function ensureWebDistBuilt() {
  const hudDistIndex = path.join(DIST_DIR, "hud", "index.html");
  if (fs.existsSync(hudDistIndex)) {
    return { createdDist: false };
  }

  const vitePkg = loadPkg("vite");
  const reactPluginPkg = loadPkg("@vitejs/plugin-react");
  const reactPlugin = reactPluginPkg.default ?? reactPluginPkg;
  const localModules = path.join(REPO_ROOT, "node_modules");
  const alias =
    !fs.existsSync(localModules) && fs.existsSync(SHARED_NODE_MODULES)
      ? [
          {
            find: /^@fontsource\/atkinson-hyperlegible-next\/(.*)$/,
            replacement: path.join(SHARED_NODE_MODULES, "@fontsource", "atkinson-hyperlegible-next", "$1"),
          },
          {
            find: /^@fontsource\/atkinson-hyperlegible-mono\/(.*)$/,
            replacement: path.join(SHARED_NODE_MODULES, "@fontsource", "atkinson-hyperlegible-mono", "$1"),
          },
          {
            find: /^react-dom\/client$/,
            replacement: path.join(SHARED_NODE_MODULES, "react-dom", "client.js"),
          },
          {
            find: /^react-dom$/,
            replacement: path.join(SHARED_NODE_MODULES, "react-dom", "index.js"),
          },
          {
            find: /^react\/jsx-runtime$/,
            replacement: path.join(SHARED_NODE_MODULES, "react", "jsx-runtime.js"),
          },
          {
            find: /^react\/jsx-dev-runtime$/,
            replacement: path.join(SHARED_NODE_MODULES, "react", "jsx-dev-runtime.js"),
          },
          {
            find: /^react$/,
            replacement: path.join(SHARED_NODE_MODULES, "react", "index.js"),
          },
        ]
      : [];

  await vitePkg.build({
    configFile: false,
    root: WEB_ROOT,
    logLevel: "silent",
    plugins: [reactPlugin()],
    resolve: { alias },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      rollupOptions: {
        input: {
          main: path.join(WEB_ROOT, "index.html"),
          hud: path.join(WEB_ROOT, "hud", "index.html"),
        },
      },
    },
  });

  return { createdDist: true };
}

function findCachedFullChromium() {
  const caches = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    SHARED_BROWSERS,
    path.join(os.homedir(), ".cache", "ms-playwright"),
    path.join(os.homedir(), "Library", "Caches", "ms-playwright"),
  ].filter(Boolean);

  for (const cache of caches) {
    if (!fs.existsSync(cache)) continue;
    const dirs = fs.readdirSync(cache).sort().reverse();
    for (const d of dirs) {
      if (!d.startsWith("chromium-") && !d.startsWith("chromium_headless_shell-")) continue;
      const candidates = [
        path.join(cache, d, "chrome-linux", "headless_shell"),
        path.join(cache, d, "chrome-linux", "chrome"),
        path.join(
          cache,
          d,
          "chrome-mac-arm64",
          "Google Chrome for Testing.app",
          "Contents",
          "MacOS",
          "Google Chrome for Testing",
        ),
      ];
      const hit = candidates.find((p) => fs.existsSync(p));
      if (hit) return hit;
    }
  }
  return undefined;
}

async function launchSpatialNavBrowser(chromium) {
  const args = [SPATIAL_NAV_FLAG];
  try {
    return await chromium.launch({ headless: true, args });
  } catch {
    const exe = findCachedFullChromium();
    if (exe) return await chromium.launch({ headless: true, executablePath: exe, args });
    throw new Error("Unable to launch headless Chromium for HUD 600x600 simulator audit");
  }
}

async function auditManifestAndHead(base, page) {
  const bareRes = await fetch(`${base}/hud`, { redirect: "manual" });
  const bareLoc = bareRes.headers.get("location") ?? "";
  const resolvedRedirect = bareLoc ? new URL(bareLoc, `${base}/hud`).pathname : "";

  const indexRes = await fetch(`${base}/hud/`);
  const indexCt = indexRes.headers.get("content-type") ?? "";
  const indexCc = indexRes.headers.get("cache-control") ?? "";

  const manifestUrl = `${base}/hud/.well-known/meta-wearables-manifest.json`;
  const manifestRes = await fetch(manifestUrl);
  const manifestCt = manifestRes.headers.get("content-type") ?? "";
  const manifestBuf = Buffer.from(await manifestRes.arrayBuffer());
  const manifestJson = JSON.parse(manifestBuf.toString("utf8"));
  const resolvedIconUrl = new URL(manifestJson.appearance.icon.src, manifestUrl).href;
  const resolvedIconPath = new URL(resolvedIconUrl).pathname;

  const monoRes = await fetch(resolvedIconUrl);
  const monoCt = monoRes.headers.get("content-type") ?? "";
  const monoBuf = Buffer.from(await monoRes.arrayBuffer());
  const monoInfo = inspectPngIcon(monoBuf, { expectMonochrome: true });

  const icon96Url = `${base}/hud/icon-96.png`;
  const icon96Res = await fetch(icon96Url);
  const icon96Ct = icon96Res.headers.get("content-type") ?? "";
  const icon96Buf = Buffer.from(await icon96Res.arrayBuffer());
  const icon96Info = inspectPngIcon(icon96Buf, { expectMonochrome: false });

  await page.goto(`${base}/hud/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".hud", { timeout: 5000 });
  const head = await page.evaluate(() => {
    const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.getAttribute("content") ?? null;
    const charsetEl = document.querySelector("meta[charset]");
    const viewport = meta("viewport") ?? "";
    const iconLink = document.querySelector('link[rel="icon"]');
    const svgIcons = Array.from(document.querySelectorAll('link[rel*="icon"]')).filter(
      (el) => el.getAttribute("type") === "image/svg+xml" || (el.getAttribute("href") ?? "").endsWith(".svg"),
    );
    return {
      lang: document.documentElement.getAttribute("lang"),
      charset: charsetEl?.getAttribute("charset")?.toLowerCase() ?? null,
      viewport,
      zoomRestricted: /user-scalable\s*=\s*(no|0|false)|maximum-scale\s*=\s*1(\.0)?\b/i.test(viewport),
      mrbdWebAppCapable: meta("mrbd-web-app-capable"),
      applicationName: meta("application-name"),
      themeColor: meta("theme-color")?.toLowerCase() ?? null,
      title: document.title,
      faviconHref: iconLink?.getAttribute("href") ?? null,
      faviconSizes: iconLink?.getAttribute("sizes") ?? null,
      faviconType: iconLink?.getAttribute("type") ?? null,
      svgFaviconCount: svgIcons.length,
    };
  });

  return {
    hudBareRedirect: {
      status: bareRes.status,
      location: bareLoc,
      redirectsToTrailingSlash: bareRes.status >= 300 && bareRes.status < 400 && resolvedRedirect === "/hud/",
    },
    hudIndex: {
      status: indexRes.status,
      contentType: indexCt,
      cacheControl: indexCc,
    },
    wearablesManifest: {
      url: manifestUrl,
      status: manifestRes.status,
      contentType: manifestCt,
      bytes: manifestBuf.length,
      maxBytes: 65536,
      version: manifestJson.version,
      name: manifestJson.name,
      description: manifestJson.description,
      themeColor: manifestJson.appearance?.theme_color ?? null,
      iconType: manifestJson.appearance?.icon?.type ?? null,
      iconSrc: manifestJson.appearance?.icon?.src ?? null,
      resolvedIconPath,
    },
    icons: {
      iconMono: {
        status: monoRes.status,
        contentType: monoCt,
        maxBytes: 2097152,
        ...monoInfo,
      },
      icon96: {
        status: icon96Res.status,
        contentType: icon96Ct,
        exceeds52x52: icon96Info.width > 52 && icon96Info.height > 52,
        ...icon96Info,
      },
    },
    head,
  };
}

async function captureHudState(page, AxeBuilder, label) {
  const domMetrics = await page.evaluate(() => {
    const docEl = document.documentElement;
    const body = document.body;
    const card = document.querySelector(".hud-card");
    const headline = document.querySelector(".hud-headline")?.textContent?.trim() ?? "";
    const actButtons = Array.from(document.querySelectorAll(".hud-acts button"));
    const speakBtn = document.querySelector(".hud-speak");

    const fits600 = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= 600.5 && r.bottom <= 600.5;
    };

    const actHeights = actButtons.map((b) => Math.round(b.getBoundingClientRect().height * 100) / 100);
    const speakHeight = speakBtn ? Math.round(speakBtn.getBoundingClientRect().height * 100) / 100 : 0;

    const htmlBg = getComputedStyle(docEl).backgroundColor;
    const bodyBg = getComputedStyle(body).backgroundColor;
    const cardBg = card ? getComputedStyle(card).backgroundColor : "";
    const actBgs = actButtons.map((b) => getComputedStyle(b).backgroundColor);

    return {
      cardClass: card?.className?.trim() ?? "",
      headline,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollWidth: docEl.scrollWidth,
        scrollHeight: docEl.scrollHeight,
        horizontalOverflow: docEl.scrollWidth > window.innerWidth,
        verticalOverflow: docEl.scrollHeight > window.innerHeight,
      },
      bounds: {
        cardFitsViewport: fits600(card),
        buttonsFitViewport: actButtons.length === 3 && actButtons.every(fits600) && fits600(speakBtn),
        minActionButtonHeightPx: actHeights.length ? Math.min(...actHeights) : 0,
        speakButtonHeightPx: speakHeight,
      },
      computedBackgrounds: {
        html: htmlBg,
        body: bodyBg,
        card: cardBg,
        actionButtonsAllPureBlack: actBgs.length === 3 && actBgs.every((c) => c === "rgb(0, 0, 0)"),
      },
    };
  });

  const pngShot = await page.screenshot({ type: "png" });
  const pixelBudget = analyzeAdditiveFrame(pngShot);
  const axeRes = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const violationNodes = axeRes.violations.reduce((sum, v) => sum + v.nodes.length, 0);

  return {
    label,
    url: page.url(),
    ...domMetrics,
    pixelBudget,
    axe: {
      violations: axeRes.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        nodes: v.nodes.length,
      })),
      violationNodes,
      passes: axeRes.passes.length,
      incomplete: axeRes.incomplete.length,
    },
  };
}

const { outFile, baseUrl } = parseCliArgs(process.argv.slice(2));
const { chromium } = loadPkg("playwright");
const axePkg = loadPkg("@axe-core/playwright");
const AxeBuilder = axePkg.default ?? axePkg;
const wsPkg = loadPkg("ws");
const WsClient = wsPkg.WebSocket ?? wsPkg.default ?? wsPkg;

let createdDist = false;
let serverInstance = null;
const serverSockets = new Set();
const hudUpgradeSockets = new Set();
let browser = null;

async function closeServerNow() {
  if (!serverInstance) return;
  const srv = serverInstance;
  serverInstance = null;
  for (const sock of serverSockets) {
    try {
      sock.destroy();
    } catch {}
  }
  serverSockets.clear();
  hudUpgradeSockets.clear();
  await new Promise((resolve) => {
    srv.close(() => resolve());
    srv.closeAllConnections?.();
  });
}

try {
  let base = baseUrl;
  let hubApi = null;

  if (!base) {
    const buildState = await ensureWebDistBuilt();
    createdDist = buildState.createdDist;
    const serverMod = await import(pathToFileURL(path.join(REPO_ROOT, "server", "src", "index.ts")).href);
    const hubMod = await import(pathToFileURL(path.join(REPO_ROOT, "server", "src", "hub.ts")).href);
    serverInstance = await serverMod.startServer(0);
    serverInstance.on("connection", (sock) => {
      serverSockets.add(sock);
      sock.once("close", () => serverSockets.delete(sock));
    });
    serverInstance.on("upgrade", (req, sock) => {
      serverSockets.add(sock);
      sock.once("close", () => serverSockets.delete(sock));
      if ((req.url ?? "").startsWith("/hud-ws")) {
        hudUpgradeSockets.add(sock);
        sock.once("close", () => hudUpgradeSockets.delete(sock));
      }
    });
    const addr = serverInstance.address();
    const port = typeof addr === "object" && addr ? addr.port : 8787;
    base = httpOrigin(`localhost:${port}`);
    hubApi = hubMod;
  }

  const verdictsMod = await import(pathToFileURL(path.join(WEB_ROOT, "src", "lib", "verdicts.ts")).href);
  const storageMod = await import(pathToFileURL(path.join(WEB_ROOT, "src", "lib", "storage.ts")).href);
  const profile = storageMod.demoProfile();

  browser = await launchSpatialNavBrowser(chromium);
  const context = await browser.newContext({
    viewport: { width: 600, height: 600 },
    deviceScaleFactor: 1,
  });

  const consoleErrors = [];
  const pageErrors = [];
  const attachListeners = (p) => {
    p.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    p.on("pageerror", (err) => {
      pageErrors.push(String(err));
    });
  };

  const page = await context.newPage();
  attachListeners(page);

  const manifestAndHead = await auditManifestAndHead(base, page);
  await page.waitForFunction(() => document.body.textContent?.includes("connected") ?? false, null, { timeout: 5000 });

  const states = [];
  states.push(await captureHudState(page, AxeBuilder, "hud: idle"));

  const sessionId = "SIMHUD01";
  const hostPort = new URL(base).host;
  const phoneMessages = [];

  const phoneWs = new WsClient(`${wsOrigin(hostPort)}/live?session=${sessionId}`);
  await new Promise((resolve, reject) => {
    phoneWs.once("open", resolve);
    phoneWs.once("error", reject);
  });
  phoneWs.on("message", (raw) => {
    try {
      phoneMessages.push(JSON.parse(raw.toString("utf8")));
    } catch {}
  });

  const hub = hubApi ? hubApi.getOrCreateHub(sessionId) : null;
  if (hub && hubApi) {
    hub.emit({ type: "status", live: "open" });
    hubApi.markLatest(hub);
  }

  await page.waitForTimeout(80);
  const phoneNotifiedHudConnected = phoneMessages.some((m) => m.type === "hud" && m.connected === true);

  const ingestRes = await fetch(`${base}/ingest/state`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ connected: true, worn: true, battery: 82, streaming: true }),
  });

  await page.waitForFunction(
    () => {
      const t = document.querySelector(".hud-status")?.textContent ?? "";
      return t.includes("glasses camera") && t.includes("glasses 82%");
    },
    null,
    { timeout: 5000 },
  );

  const statusTextAfterIngest = await page.locator(".hud-status").textContent();

  if (hub) {
    hub.emit({ type: "coach", cue: "rotate_left", text: "Turn it left" });
  }
  await page.waitForFunction(
    () => document.querySelector(".hud-headline")?.textContent?.trim() === "Turn it left",
    null,
    { timeout: 5000 },
  );
  states.push(await captureHudState(page, AxeBuilder, "hud: coach cue"));
  const realtimeCoachDelivered = true;

  const warningVerdict = verdictsMod.mockWarningIbuprofen();
  if (hub) {
    hub.emit({ type: "verdict", verdict: warningVerdict });
  }
  await page.waitForFunction(
    () => document.querySelector(".hud-headline")?.textContent?.includes("Ibuprofen") ?? false,
    null,
    { timeout: 5000 },
  );
  const autoFocusOnWarningWithoutMedId = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
  states.push(await captureHudState(page, AxeBuilder, "hud: verdict warning"));

  const unsureVerdict = verdictsMod.mockUnsureStrength();
  if (hub) {
    hub.emit({ type: "verdict", verdict: unsureVerdict });
  }
  await page.waitForFunction(
    (expected) => document.querySelector(".hud-headline")?.textContent?.trim() === expected,
    unsureVerdict.headline,
    { timeout: 5000 },
  );
  const autoFocusOnUnsureWithoutMedId = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
  const takeItDisabledWhenUnmatched = await page.evaluate(
    () => Array.from(document.querySelectorAll(".hud-acts button")).find((b) => b.textContent?.trim() === "I took it")?.hasAttribute("disabled") ?? false,
  );
  await page.keyboard.press("ArrowRight");
  const fromRepeatArrowRight = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
  await page.keyboard.press("ArrowLeft");
  const fromDismissArrowLeft = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
  states.push(await captureHudState(page, AxeBuilder, "hud: verdict unsure"));

  const allergenVerdict = verdictsMod.mockFoodNuts();
  if (hub) {
    hub.emit({ type: "verdict", verdict: allergenVerdict });
  }
  await page.waitForFunction(
    (expected) => document.querySelector(".hud-headline")?.textContent?.trim() === expected,
    allergenVerdict.headline,
    { timeout: 5000 },
  );
  states.push(await captureHudState(page, AxeBuilder, "hud: verdict allergen"));

  const sceneVerdict = verdictsMod.mockScene(profile);
  if (hub) {
    hub.emit({ type: "verdict", verdict: sceneVerdict });
  }
  await page.waitForFunction(
    () => document.querySelector(".hud-level")?.textContent?.includes("WHICH ONE") ?? false,
    null,
    { timeout: 5000 },
  );
  states.push(await captureHudState(page, AxeBuilder, "hud: verdict scene"));

  const matchV = verdictsMod.matchVerdict(profile, profile.meds[0]);
  if (hub) {
    hub.emit({ type: "verdict", verdict: matchV });
  }
  await page.waitForFunction(
    () => (document.querySelector(".hud-level")?.textContent?.includes("RIGHT ONE") ?? false),
    null,
    { timeout: 5000 },
  );
  const realtimeVerdictDelivered = true;
  const autoFocusOnMatchWithMedId = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
  states.push(await captureHudState(page, AxeBuilder, "hud: verdict match"));

  const buttonDomAudit = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll("button"));
    const posTab = Array.from(document.querySelectorAll("[tabindex]")).filter((el) => Number(el.getAttribute("tabindex")) > 0);
    const active = document.activeElement;
    const cs = active ? getComputedStyle(active) : null;
    return {
      positiveTabIndexCount: posTab.length,
      allButtonsNativeTag: buttons.length === 4 && buttons.every((b) => b.tagName === "BUTTON"),
      focusRingStyle: {
        outlineWidthPx: cs ? parseFloat(cs.outlineWidth) : 0,
        outlineStyle: cs?.outlineStyle ?? "",
        outlineColor: cs?.outlineColor ?? "",
        outlineOffsetPx: cs ? parseFloat(cs.outlineOffset) : 0,
      },
    };
  });

  const navKeys = ["ArrowLeft", "ArrowRight", "ArrowRight", "ArrowDown", "ArrowUp"];
  const visited = [autoFocusOnMatchWithMedId];
  for (const k of navKeys) {
    await page.keyboard.press(k);
    visited.push(await page.evaluate(() => document.activeElement?.textContent?.trim() ?? ""));
  }
  const visitedSet = new Set(visited);
  const reachesAllFourControls =
    visitedSet.has("Repeat") &&
    visitedSet.has("I took it") &&
    visitedSet.has("Dismiss") &&
    visitedSet.has("Speak off");

  await page.keyboard.press("ArrowDown");
  const speakBefore = await page.locator(".hud-speak").getAttribute("aria-pressed");
  await page.keyboard.press("Enter");
  const speakAfterFirstEnter = await page.locator(".hud-speak").getAttribute("aria-pressed");
  await page.keyboard.press("Enter");
  const speakAfterSecondEnter = await page.locator(".hud-speak").getAttribute("aria-pressed");

  const latePage = await context.newPage();
  attachListeners(latePage);
  await latePage.goto(`${base}/hud/?session=${sessionId}`, { waitUntil: "domcontentloaded" });
  await latePage.waitForFunction(
    () => document.querySelector(".hud-headline")?.textContent?.includes("Amlodipine 5 mg") ?? false,
    null,
    { timeout: 5000 },
  );
  const lateJoinReplay = await latePage.evaluate(() => {
    const status = document.querySelector(".hud-status")?.textContent ?? "";
    return {
      explicitSessionParam: new URLSearchParams(location.search).get("session"),
      replayedVerdictHeadline: document.querySelector(".hud-headline")?.textContent?.trim() ?? "",
      replayedCamera: status.includes("glasses camera") ? "glasses camera" : "",
      replayedBattery: status.includes("glasses 82%") ? "glasses 82%" : "",
    };
  });
  await latePage.close();

  phoneMessages.length = 0;
  await page.locator(".hud-acts button", { hasText: "Repeat" }).focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".hud-status")?.textContent?.includes("Repeating") ?? false, null, { timeout: 3000 });
  const repeatToast = "Repeating";

  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".hud-status")?.textContent?.includes("Dose logged") ?? false, null, { timeout: 3000 });
  const logDoseToast = "Dose logged";

  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".hud-headline")?.textContent?.trim() === "Hold it up.", null, { timeout: 3000 });
  const dismissReturnsToIdle = true;

  await page.waitForTimeout(80);
  const hudEventsForwardedToPhone = phoneMessages.filter((m) => m.type === "hud_event").map((m) => m.name);

  const historySessionId = "HISTHUD01";
  const historyHub = hubApi ? hubApi.getOrCreateHub(historySessionId) : null;
  if (historyHub) {
    historyHub.emit({ type: "status", live: "open" });
  }
  const historyPage = await context.newPage();
  attachListeners(historyPage);
  await historyPage.goto(`${base}/hud/?session=${historySessionId}`, { waitUntil: "domcontentloaded" });
  await historyPage.waitForFunction(
    () => document.querySelector(".hud-headline")?.textContent?.trim() === "Hold it up.",
    null,
    { timeout: 5000 },
  );
  const historyLengthBeforeVerdicts = await historyPage.evaluate(() => window.history.length);
  if (historyHub) {
    historyHub.emit({ type: "verdict", verdict: warningVerdict });
    await historyPage.waitForFunction(
      () => document.querySelector(".hud-headline")?.textContent?.includes("Ibuprofen") ?? false,
      null,
      { timeout: 5000 },
    );
    historyHub.emit({ type: "verdict", verdict: unsureVerdict });
    await historyPage.waitForFunction(
      (expected) => document.querySelector(".hud-headline")?.textContent?.trim() === expected,
      unsureVerdict.headline,
      { timeout: 5000 },
    );
    historyHub.emit({ type: "verdict", verdict: allergenVerdict });
    await historyPage.waitForFunction(
      (expected) => document.querySelector(".hud-headline")?.textContent?.trim() === expected,
      allergenVerdict.headline,
      { timeout: 5000 },
    );
    historyHub.emit({ type: "verdict", verdict: matchV });
  }
  await historyPage.waitForFunction(
    () => document.querySelector(".hud-headline")?.textContent?.includes("Amlodipine 5 mg") ?? false,
    null,
    { timeout: 5000 },
  );
  const historyLengthWithVerdict = await historyPage.evaluate(() => window.history.length);
  const historyDelta = historyLengthWithVerdict - historyLengthBeforeVerdicts;
  await historyPage.goBack();
  await historyPage.waitForFunction(
    () => document.querySelector(".hud-headline")?.textContent?.trim() === "Hold it up.",
    null,
    { timeout: 5000 },
  );
  const systemBackDismissesToIdle = (await historyPage.evaluate(() => location.pathname)) === "/hud/";
  await historyPage.close();

  const mockPage = await context.newPage();
  attachListeners(mockPage);
  const mockConsoleStart = consoleErrors.length;
  const mockPageErrStart = pageErrors.length;
  await mockPage.goto(`${base}/hud/?mock=1`, { waitUntil: "domcontentloaded" });
  await mockPage.waitForFunction(() => document.querySelector(".hud-status")?.textContent?.includes("connected") ?? false, null, { timeout: 5000 });
  const mockConnected = true;
  await mockPage.close();
  const mockConsoleErrorCount = consoleErrors.length - mockConsoleStart;
  const mockPageErrorCount = pageErrors.length - mockPageErrStart;

  if (hub) {
    hub.emit({ type: "verdict", verdict: matchV });
  }
  await page.waitForFunction(
    () => document.querySelector(".hud-headline")?.textContent?.includes("Amlodipine 5 mg") ?? false,
    null,
    { timeout: 5000 },
  );

  await page.evaluate(() => {
    window.WebSocket = class PendingHudWebSocket {
      constructor() {
        this.readyState = 0;
        this.onopen = null;
        this.onmessage = null;
        this.onclose = null;
        this.onerror = null;
      }
      send() {}
      close() {
        this.readyState = 3;
      }
    };
  });

  for (const sock of [...hudUpgradeSockets]) {
    try {
      sock.destroy();
    } catch {}
  }

  await page.waitForFunction(
    () => (document.querySelector(".hud-old")?.textContent?.includes("(old)") ?? false),
    null,
    { timeout: 5000 },
  );
  states.push(await captureHudState(page, AxeBuilder, "hud: stale verdict"));

  phoneWs.close();
  await browser.close();
  browser = null;
  await closeServerNow();

  const totalViolationNodes = states.reduce((sum, s) => sum + s.axe.violationNodes, 0);
  const observedMinPureBlackRatio = Math.min(...states.map((s) => s.pixelBudget.pureBlackRatio));
  const observedMaxLitRatio = Math.max(...states.map((s) => s.pixelBudget.litRatio));
  const observedMaxMeanLuminance = Math.max(...states.map((s) => s.pixelBudget.meanLuminance));
  const allStatesPureBlackCanvas = states.every(
    (s) =>
      s.computedBackgrounds.html === "rgb(0, 0, 0)" &&
      s.computedBackgrounds.body === "rgb(0, 0, 0)" &&
      s.computedBackgrounds.card === "rgb(0, 0, 0)" &&
      s.computedBackgrounds.actionButtonsAllPureBlack,
  );
  const allStatesZeroOverflow = states.every(
    (s) =>
      !s.viewport.horizontalOverflow &&
      !s.viewport.verticalOverflow &&
      s.bounds.cardFitsViewport &&
      s.bounds.buttonsFitViewport &&
      s.bounds.minActionButtonHeightPx >= 48 &&
      s.bounds.speakButtonHeightPx >= 44,
  );

  const checks = [
    manifestAndHead.hudBareRedirect.redirectsToTrailingSlash,
    manifestAndHead.hudIndex.status === 200,
    manifestAndHead.wearablesManifest.status === 200,
    manifestAndHead.wearablesManifest.contentType.includes("application/json"),
    manifestAndHead.wearablesManifest.bytes <= 65536,
    manifestAndHead.wearablesManifest.version === 1,
    manifestAndHead.wearablesManifest.name === "HoldUp",
    manifestAndHead.wearablesManifest.iconType === "monochrome",
    manifestAndHead.wearablesManifest.resolvedIconPath === "/hud/icon-mono.png",
    manifestAndHead.icons.iconMono.status === 200,
    manifestAndHead.icons.iconMono.pureWhiteMask === true,
    manifestAndHead.icons.iconMono.transparentCorners === true,
    manifestAndHead.icons.icon96.status === 200,
    manifestAndHead.icons.icon96.exceeds52x52 === true,
    manifestAndHead.head.mrbdWebAppCapable === "yes",
    manifestAndHead.head.zoomRestricted === false,
    manifestAndHead.head.svgFaviconCount === 0,
    phoneNotifiedHudConnected,
    ingestRes.status === 204,
    (statusTextAfterIngest ?? "").includes("glasses camera"),
    (statusTextAfterIngest ?? "").includes("glasses 82%"),
    lateJoinReplay.replayedVerdictHeadline.includes("Amlodipine 5 mg"),
    hudEventsForwardedToPhone.join(",") === "repeat,log_dose,dismiss",
    buttonDomAudit.positiveTabIndexCount === 0,
    buttonDomAudit.allButtonsNativeTag,
    reachesAllFourControls,
    takeItDisabledWhenUnmatched,
    fromRepeatArrowRight === "Dismiss",
    fromDismissArrowLeft === "Repeat",
    speakBefore === "false" && speakAfterFirstEnter === "true" && speakAfterSecondEnter === "false",
    historyDelta === 1 && historyDelta <= 5,
    systemBackDismissesToIdle,
    totalViolationNodes === 0,
    observedMinPureBlackRatio >= MIN_PURE_BLACK_RATIO,
    observedMaxLitRatio <= MAX_LIT_RATIO,
    allStatesPureBlackCanvas,
    allStatesZeroOverflow,
    consoleErrors.length === 0,
    pageErrors.length === 0,
  ];

  const allChecksPassed = checks.every(Boolean);

  const report = {
    tool: "playwright-chromium + @axe-core/playwright",
    tags: "WCAG 2.0/2.1/2.2 A+AA",
    browserArgs: [SPATIAL_NAV_FLAG],
    viewport: {
      width: 600,
      height: 600,
      deviceScaleFactor: 1,
      totalPixels: 360000,
    },
    base,
    when: new Date().toISOString(),
    allChecksPassed,
    totalViolationNodes,
    consoleErrorCount: consoleErrors.length,
    pageErrorCount: pageErrors.length,
    stateCount: states.length,
    manifestAndHead,
    hudWsFanout: {
      sessionId,
      floatingHudAttachedWithoutSessionParam: true,
      phoneNotifiedHudConnected,
      ingestStateStatus: ingestRes.status,
      glassesStatusRendered: {
        camera: (statusTextAfterIngest ?? "").includes("glasses camera") ? "glasses camera" : "",
        battery: (statusTextAfterIngest ?? "").includes("glasses 82%") ? "glasses 82%" : "",
      },
      realtimeCoachDelivered,
      realtimeVerdictDelivered,
      lateJoinReplay,
      hudEventsForwardedToPhone,
      mockModeStandalone: {
        connected: mockConnected,
        consoleErrors: mockConsoleErrorCount,
        pageErrors: mockPageErrorCount,
      },
    },
    spatialNavigation: {
      enabledFlag: SPATIAL_NAV_FLAG,
      positiveTabIndexCount: buttonDomAudit.positiveTabIndexCount,
      allButtonsNativeTag: buttonDomAudit.allButtonsNativeTag,
      focusRingStyle: buttonDomAudit.focusRingStyle,
      autoFocusOnMatchWithMedId,
      autoFocusOnWarningWithoutMedId,
      autoFocusOnUnsureWithoutMedId,
      enabledTraversal: {
        keys: navKeys,
        visited,
        reachesAllFourControls,
      },
      disabledButtonSkip: {
        takeItDisabledWhenUnmatched,
        fromRepeatArrowRight,
        fromDismissArrowLeft,
      },
      enterSingleActivation: {
        speakToggleEnterOnce: {
          before: speakBefore,
          afterFirstEnter: speakAfterFirstEnter,
          afterSecondEnter: speakAfterSecondEnter,
        },
        repeatToast,
        logDoseToast,
        dismissReturnsToIdle,
      },
      historyAndBackGesture: {
        consecutiveVerdictsEmitted: 4,
        historyDelta,
        maxAllowedHistoryEntries: 5,
        systemBackDismissesToIdle,
      },
    },
    additiveBlackPixelBudget: {
      minPureBlackRatioRequired: MIN_PURE_BLACK_RATIO,
      maxLitRatioAllowed: MAX_LIT_RATIO,
      observedMinPureBlackRatio,
      observedMaxLitRatio,
      observedMaxMeanLuminance,
      allStatesPureBlackCanvas,
      allStatesZeroOverflow,
    },
    states,
  };

  const formatted = `${JSON.stringify(report, null, 2)}\n`;
  if (outFile) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, formatted, "utf8");
  } else {
    process.stdout.write(formatted);
  }

  if (!allChecksPassed) {
    process.exitCode = 1;
  }
} catch (err) {
  process.stderr.write(`${err?.stack ?? err}\n`);
  process.exitCode = 1;
} finally {
  if (browser) {
    await browser.close().catch(() => {});
  }
  await closeServerNow();
  if (createdDist) {
    fs.rmSync(DIST_DIR, { recursive: true, force: true });
  }
}

process.exit(process.exitCode ?? 0);
