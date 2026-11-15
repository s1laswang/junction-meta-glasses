import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const SHARED_WS_PKG = path.join("/tmp", "fleet-root", "shared", "junction-meta-glasses-venv", "npm-ws", "package.json");
const SHARED_NODE_MODULES = path.join("/tmp", "fleet-root", "shared", "junction-meta-glasses-venv", "npm-ws", "node_modules");
const SHARED_BROWSERS = path.join("/tmp", "fleet-root", "shared", "ms-playwright");

function parseArgs(argv) {
  let baseUrl = null;
  let outFile = null;
  let full = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--full") {
      full = true;
    } else if (a === "--out" && argv[i + 1]) {
      outFile = argv[++i];
    } else if (a.startsWith("--out=")) {
      outFile = a.slice("--out=".length);
    } else if (!a.startsWith("-") && !baseUrl) {
      baseUrl = a.replace(/\/+$/, "");
    }
  }
  return { baseUrl, outFile, full };
}

if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync(SHARED_BROWSERS)) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = SHARED_BROWSERS;
}

const localRequire = createRequire(import.meta.url);
const sharedRequire = fs.existsSync(SHARED_WS_PKG) ? createRequire(SHARED_WS_PKG) : null;

function loadPkg(id) {
  try {
    return localRequire(id);
  } catch (err) {
    if (sharedRequire) return sharedRequire(id);
    throw err;
  }
}

function resolvePkg(id) {
  try {
    return localRequire.resolve(id);
  } catch (err) {
    if (sharedRequire) return sharedRequire.resolve(id);
    throw err;
  }
}

const { chromium } = loadPkg("playwright");
const axePkg = loadPkg("@axe-core/playwright");
const AxeBuilder = axePkg.default ?? axePkg;

function localOrigin(port) {
  return ["http:", "", `localhost:${port}`].join("/");
}

async function startBuiltServer() {
  const distIndex = path.join(REPO_ROOT, "web", "dist", "index.html");
  if (!fs.existsSync(distIndex)) {
    throw new Error("Missing web/dist/index.html. Run npm run build before running scripts/a11y-audit.mjs.");
  }
  const serverEntry = path.join(REPO_ROOT, "server", "src", "index.ts");
  const tsxLoader = pathToFileURL(resolvePkg("tsx")).href;
  const nodePaths = [process.env.NODE_PATH, fs.existsSync(SHARED_NODE_MODULES) ? SHARED_NODE_MODULES : ""].filter(Boolean);
  const child = spawn(process.execPath, ["--import", tsxLoader, serverEntry], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NODE_PATH: nodePaths.join(path.delimiter),
      PORT: "0",
      GEMINI_API_KEY: "",
      ELEVENLABS_API_KEY: "",
      HOLDUP_KEY: "",
      HOLDUP_QUIET: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const port = await new Promise((resolve, reject) => {
    let buf = "";
    let errBuf = "";
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for server.listening (${errBuf || buf})`));
    }, 15000);
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const m = /server\.listening\s+port=(\d+)/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.stderr.on("data", (chunk) => {
      errBuf += chunk.toString("utf8");
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited early with code ${code}: ${errBuf || buf}`));
    });
  });

  return {
    base: localOrigin(port),
    close: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
        setTimeout(() => {
          if (child.exitCode === null) child.kill("SIGKILL");
          resolve();
        }, 2000).unref();
      }),
  };
}

async function resolveDeckServer(base) {
  try {
    const res = await fetch(`${base}/deck/index.html`);
    if (res.ok) {
      const html = await res.text();
      if (html.includes("HoldUp pitch deck")) {
        return { url: `${base}/deck/index.html`, close: async () => {} };
      }
    }
  } catch {}

  const deckHtmlPath = path.join(REPO_ROOT, "deck", "index.html");
  const deckHtml = fs.readFileSync(deckHtmlPath);
  const srv = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", localOrigin(80)).pathname;
    if (pathname === "/" || pathname === "/deck" || pathname === "/deck/" || pathname === "/deck/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(deckHtml);
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
  });

  await new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = srv.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `${localOrigin(port)}/deck/`,
    close: () => new Promise((resolve) => srv.close(() => resolve())),
  };
}

function findCachedChromium() {
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
      const found = candidates.find((p) => fs.existsSync(p));
      if (found) return found;
    }
  }
  return undefined;
}

async function launchBrowser() {
  const args = ["--use-fake-device-for-media-stream"];
  try {
    return await chromium.launch({ headless: true, args });
  } catch (err) {
    const exe = findCachedChromium();
    if (exe) return await chromium.launch({ headless: true, executablePath: exe, args });
    throw err;
  }
}

const cli = parseArgs(process.argv.slice(2));
const startedServer = cli.baseUrl ? null : await startBuiltServer();
const base = cli.baseUrl ?? startedServer.base;
const deckTarget = cli.full ? await resolveDeckServer(base) : null;
const browser = await launchBrowser();
const results = [];

async function audit(page, label) {
  await page.evaluate(() => {
    if (!document.querySelector("dialog[open]")) {
      window.scrollTo(0, document.documentElement.scrollHeight);
    }
  });
  const r = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  if (r.violations.length > 0) {
    for (const v of r.violations) {
      for (const n of v.nodes) {
        process.stderr.write(`[axe violation] ${label} | ${v.id} (${v.impact}): ${n.target.join(" ")} | ${n.failureSummary ?? v.help}\n`);
      }
    }
  }
  results.push({
    label,
    url: page.url(),
    violations: r.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      nodes: v.nodes.length,
    })),
    passes: r.passes.length,
    incomplete: r.incomplete.length,
  });
}

async function askMockQuestion(page, question) {
  const input = page.locator("#ask");
  await input.fill(question);
  await page.getByRole("button", { name: "Ask", exact: true }).click();
}

async function expandVerdictDetails(page, selector) {
  const details = page.locator(`${selector} details`);
  await details.waitFor({ state: "visible" });
  const isOpen = await details.evaluate((el) => el.hasAttribute("open"));
  if (!isOpen) {
    await details.locator("summary").click();
  }
  await page.locator(`${selector} details[open]`).waitFor({ state: "visible" });
}

async function runBaselineAudit() {
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const phone = await phoneCtx.newPage();

  await phone.goto(`${base}/?mock=1`, { waitUntil: "networkidle" });
  await phone.locator("h1", { hasText: "HoldUp" }).waitFor({ state: "visible" });
  await audit(phone, "phone: first screen");

  await phone.getByRole("button", { name: "Continue", exact: true }).click();
  await phone.locator("h1", { hasText: "What HoldUp captures" }).waitFor({ state: "visible" });
  await audit(phone, "phone: after step 1");

  await phone.getByRole("button", { name: "Next", exact: true }).click();
  await phone.locator("h1", { hasText: "Where it goes" }).waitFor({ state: "visible" });
  await audit(phone, "phone: after step 2");

  await phone.getByRole("button", { name: "Next", exact: true }).click();
  await phone.locator("h1", { hasText: "What stays on this phone" }).waitFor({ state: "visible" });
  await audit(phone, "phone: after step 3");

  await phone.getByRole("button", { name: "I agree", exact: true }).click();
  await phone.locator("h1", { hasText: "Camera and microphone" }).waitFor({ state: "visible" });
  await audit(phone, "phone: after step 4");
  await phoneCtx.close();

  const hudCtx = await browser.newContext({ viewport: { width: 600, height: 600 } });
  const hud = await hudCtx.newPage();
  await hud.goto(`${base}/hud/?mock=1`, { waitUntil: "networkidle" });
  await hud.getByRole("button", { name: "Dismiss", exact: true }).click();
  await hud.locator(".verdict-card").waitFor({ state: "visible", timeout: 10000 });
  await audit(hud, "hud: verdict");
  await hudCtx.close();
}

async function runFullAudit(deckUrl) {
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const phone = await phoneCtx.newPage();

  await phone.goto(`${base}/?mock=1`, { waitUntil: "networkidle" });
  await phone.locator("h1", { hasText: "HoldUp" }).waitFor({ state: "visible" });
  await audit(phone, "phone: welcome");

  await phone.getByRole("button", { name: "Continue", exact: true }).click();
  await phone.locator("h1", { hasText: "What HoldUp captures" }).waitFor({ state: "visible" });
  await audit(phone, "phone: consent card 1");

  await phone.getByRole("button", { name: "Next", exact: true }).click();
  await phone.locator("h1", { hasText: "Where it goes" }).waitFor({ state: "visible" });
  await audit(phone, "phone: consent card 2");

  await phone.getByRole("button", { name: "Next", exact: true }).click();
  await phone.locator("h1", { hasText: "What stays on this phone" }).waitFor({ state: "visible" });
  await audit(phone, "phone: consent card 3");

  await phone.getByRole("button", { name: "I agree", exact: true }).click();
  await phone.locator("h1", { hasText: "Camera and microphone" }).waitFor({ state: "visible" });
  await audit(phone, "phone: permission step");

  await phone.getByRole("button", { name: "Not now", exact: true }).click();
  await phone.locator("h1", { hasText: "HoldUp can't use" }).waitFor({ state: "visible" });
  await audit(phone, "phone: permission recovery");

  await phone.getByRole("button", { name: /continue without/i }).click();
  await phone.getByRole("button", { name: "Start check", exact: true }).waitFor({ state: "visible" });

  await phone.locator("nav.tabs").getByRole("button", { name: "Profile", exact: true }).click();
  await phone.locator("h1", { hasText: "Profile" }).waitFor({ state: "visible" });
  phone.once("dialog", (d) => d.accept());
  await phone.getByRole("button", { name: "Load demo profile", exact: true }).click();
  await phone.locator(".medlist li").first().waitFor({ state: "visible" });

  await phone.locator("nav.tabs").getByRole("button", { name: "Check", exact: true }).click();
  await phone.getByRole("button", { name: "Start check", exact: true }).waitFor({ state: "visible" });
  await audit(phone, "phone: check idle");

  await phoneCtx.grantPermissions(["camera", "microphone"], { origin: base });
  await askMockQuestion(phone, "is this my evening pill");
  await phone.locator(".cue", { hasText: "Turn it around" }).waitFor({ state: "visible", timeout: 10000 });
  await audit(phone, "phone: check running / coaching");

  await phone.locator("section.verdict.match").waitFor({ state: "visible", timeout: 20000 });
  await expandVerdictDetails(phone, "section.verdict.match");
  await audit(phone, "phone: verdict match");
  await phone.locator("section.verdict.match").getByRole("button", { name: "I took it", exact: true }).click();

  await askMockQuestion(phone, "ibuprofen");
  await phone.locator("section.verdict.warning").waitFor({ state: "visible", timeout: 20000 });
  await expandVerdictDetails(phone, "section.verdict.warning");
  await audit(phone, "phone: verdict warning");

  await askMockQuestion(phone, "metformin strength");
  await phone.locator("section.verdict.unsure").waitFor({ state: "visible", timeout: 20000 });
  await expandVerdictDetails(phone, "section.verdict.unsure");
  await audit(phone, "phone: verdict unsure");

  await askMockQuestion(phone, "which one is my evening pill");
  await phone.locator("ol.scene").waitFor({ state: "visible", timeout: 20000 });
  await expandVerdictDetails(phone, "section.verdict");
  await audit(phone, "phone: scene 3-box");

  await askMockQuestion(phone, "add this medicine");
  await phone.locator("dialog.addsheet[open]").waitFor({ state: "visible", timeout: 15000 });
  await audit(phone, "phone: add-sheet modal");
  await phone.locator("dialog.addsheet").getByRole("button", { name: "Cancel", exact: true }).click();
  await phone.locator("dialog.addsheet").waitFor({ state: "detached" });

  await phone.getByRole("button", { name: "Stop", exact: true }).click();
  await phone.getByRole("button", { name: "Start check", exact: true }).waitFor({ state: "visible" });

  await phone.goto(`${base}/?mock=1&debug=1`, { waitUntil: "networkidle" });
  await phone.locator("details.panel[open] .sim").waitFor({ state: "visible" });
  await audit(phone, "phone: device panel");

  await phone.locator("nav.tabs").getByRole("button", { name: "Profile", exact: true }).click();
  await phone.locator("h1", { hasText: "Profile" }).waitFor({ state: "visible" });
  await audit(phone, "phone: profile");

  await phone.getByRole("button", { name: "Add medicine", exact: true }).click();
  await phone.locator("dialog[open] #med-h").waitFor({ state: "visible" });
  await audit(phone, "phone: med-editor modal");
  await phone.locator("dialog[open]").getByRole("button", { name: "Cancel", exact: true }).click();
  await phone.locator("dialog[open]").waitFor({ state: "detached" });

  await phone.locator("nav.tabs").getByRole("button", { name: "Privacy", exact: true }).click();
  await phone.locator("h1", { hasText: "Privacy" }).waitFor({ state: "visible" });
  await phone.locator("#sonar-vol").waitFor({ state: "visible" });
  await audit(phone, "phone: privacy");
  await phoneCtx.close();

  const keyCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const keyPage = await keyCtx.newPage();
  await keyPage.route(
    (u) => u.pathname === "/api/stats",
    (route) =>
      route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ type: "error", code: "unauthorized", message: "access key required", recoverable: false }),
      }),
  );
  await keyPage.goto(`${base}/`, { waitUntil: "networkidle" });
  await keyPage.locator("h1", { hasText: "Access key needed" }).waitFor({ state: "visible", timeout: 10000 });
  await audit(keyPage, "phone: access-key");
  await keyCtx.close();

  const hudCtx = await browser.newContext({ viewport: { width: 600, height: 600 } });
  const hud = await hudCtx.newPage();
  await hud.goto(`${base}/hud/?mock=1`, { waitUntil: "networkidle" });
  await hud.getByRole("button", { name: "Dismiss", exact: true }).click();
  await hud.locator(".idle-card").waitFor({ state: "visible" });
  await audit(hud, "hud: idle");
  await hud.locator(".verdict-card").waitFor({ state: "visible", timeout: 10000 });
  await audit(hud, "hud: verdict");
  await hudCtx.close();

  const deckCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await deckCtx.route(
    (u) => u.hostname.includes("fonts.g"),
    (route) => route.abort(),
  );
  const deck = await deckCtx.newPage();
  await deck.goto(deckUrl, { waitUntil: "domcontentloaded" });
  await deck.locator("#deck .slide:not([hidden])").waitFor({ state: "visible" });
  const slideCount = await deck.locator("#deck .slide").count();
  for (let s = 1; s <= slideCount; s++) {
    if (s > 1) {
      await deck.locator("#next").click();
    }
    await deck.locator(`#s${s}-h`).waitFor({ state: "visible" });
    await audit(deck, s === 1 ? "deck: slides" : `deck: slide ${s}`);
  }
  await deckCtx.close();
}

try {
  if (cli.full) {
    await runFullAudit(deckTarget.url);
  } else {
    await runBaselineAudit();
  }
} finally {
  await browser.close();
  if (deckTarget) await deckTarget.close();
  if (startedServer) await startedServer.close();
}

const total = results.reduce((n, r) => n + r.violations.reduce((m, v) => m + v.nodes, 0), 0);
const hasViolations = total > 0 || results.some((r) => r.violations.length > 0);
const output = {
  tool: "axe-core via @axe-core/playwright",
  tags: "WCAG 2.0/2.1/2.2 A+AA",
  base,
  when: new Date().toISOString(),
  totalViolationNodes: total,
  ...(cli.full ? { screenCount: results.length } : {}),
  results,
};
const serialized = JSON.stringify(output, null, 2);
if (cli.outFile) {
  const resolvedOut = path.resolve(process.cwd(), cli.outFile);
  fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
  fs.writeFileSync(resolvedOut, `${serialized}\n`, "utf8");
}
console.log(serialized);
if (hasViolations) {
  process.exitCode = 1;
}
