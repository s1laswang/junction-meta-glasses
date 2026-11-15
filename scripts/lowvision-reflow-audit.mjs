import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const sharedPlaywright = "/tmp/fleet-root/shared/ms-playwright";
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync(sharedPlaywright)) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = sharedPlaywright;
}

const { chromium } = await import("playwright");
const { default: AxeBuilder } = await import("@axe-core/playwright");

const WCAG_AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

const WCAG_1412_CSS = [
  "* {",
  "  line-height: 1.5 !important;",
  "  letter-spacing: 0.12em !important;",
  "  word-spacing: 0.16em !important;",
  "}",
].join("\n");

const MOBILE_EMULATION = {
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 3,
};

function makeHttpOrigin(hostPort) {
  return ["http:", "", hostPort].join("/");
}

function resolveChromiumExecutable() {
  const candidates = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    sharedPlaywright,
    path.join(os.homedir(), ".cache/ms-playwright"),
    path.join(os.homedir(), "Library/Caches/ms-playwright"),
  ].filter((p) => p && fs.existsSync(p));

  for (const dir of candidates) {
    const builds = fs
      .readdirSync(dir)
      .filter((d) => d.startsWith("chromium-"))
      .sort()
      .reverse();
    for (const b of builds) {
      const bins = [
        path.join(dir, b, "chrome-linux/chrome"),
        path.join(dir, b, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
        path.join(dir, b, "chrome-mac/Chromium.app/Contents/MacOS/Chromium"),
      ];
      const hit = bins.find((p) => fs.existsSync(p));
      if (hit) return hit;
    }
  }
  return undefined;
}

function ensureWebDistBuilt() {
  const mainHtml = path.join(repoRoot, "web/dist/index.html");
  const hudHtml = path.join(repoRoot, "web/dist/hud/index.html");
  if (!fs.existsSync(mainHtml) || !fs.existsSync(hudHtml)) {
    execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });
  }
}

async function startKeylessServer(ledgerFile) {
  const serverEntry = path.join(repoRoot, "server/src/index.ts");
  const child = spawn(process.execPath, ["--import", "tsx", serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: "0",
      GEMINI_API_KEY: "",
      ELEVENLABS_API_KEY: "",
      HOLDUP_KEY: "",
      HOLDUP_QUIET: "",
      LEDGER_PATH: ledgerFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const port = await new Promise((resolve, reject) => {
    let stdoutBuf = "";
    let stderrBuf = "";
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for server/src/index.ts PORT=0 startup: ${stderrBuf || stdoutBuf}`));
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
      reject(new Error(`server/src/index.ts exited early with code ${String(code)}: ${stderrBuf || stdoutBuf}`));
    });
  });

  const origin = makeHttpOrigin(`127.0.0.1:${port}`);
  const healthRes = await fetch(`${origin}/api/health`);
  if (!healthRes.ok) {
    throw new Error(`Health check failed with HTTP ${healthRes.status}`);
  }
  const healthJson = await healthRes.json();
  return { child, origin, port, health: healthJson };
}

async function stopChildProcess(child) {
  if (!child || child.exitCode !== null) return;
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
}

async function ensureConditionStyle(page, condition) {
  if (!condition.textSpacing1412) return;
  await page.evaluate((cssText) => {
    let tag = document.getElementById("wcag-1412-override");
    if (!tag) {
      tag = document.createElement("style");
      tag.id = "wcag-1412-override";
      tag.textContent = cssText;
      document.head.appendChild(tag);
    }
  }, WCAG_1412_CSS);
  await page.waitForTimeout(50);
}

async function runAxeAudit(page, conditionId, screen) {
  const res = await new AxeBuilder({ page }).withTags(WCAG_AXE_TAGS).analyze();
  const violationNodes = res.violations.reduce((sum, v) => sum + v.nodes.length, 0);
  return {
    condition: conditionId,
    screen,
    passes: res.passes.length,
    violationCount: res.violations.length,
    violationNodes,
    violations: res.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      nodes: v.nodes.length,
    })),
  };
}

async function measureScreen(page, condition, screen) {
  await ensureConditionStyle(page, condition);
  const metrics = await page.evaluate(
    ({ isHud, isTextSpacing }) => {
      const innerWidth = window.innerWidth;
      const innerHeight = window.innerHeight;
      const docScrollWidth = document.documentElement.scrollWidth;
      const bodyScrollWidth = document.body ? document.body.scrollWidth : 0;
      const scrollWidth = Math.max(docScrollWidth, bodyScrollWidth);
      const docOverflowPx = Math.max(0, Math.ceil(scrollWidth - innerWidth));
      const mainEl = document.querySelector(".app > main");
      const mainRect = mainEl instanceof HTMLElement ? mainEl.getBoundingClientRect() : null;
      const mainOverflowPx =
        !isTextSpacing && mainEl instanceof HTMLElement
          ? Math.max(0, Math.ceil(mainEl.scrollWidth - mainEl.clientWidth) - 1)
          : 0;
      const overflowPx = Math.max(docOverflowPx, mainOverflowPx);

      const controlNodes = Array.from(
        document.querySelectorAll("button, input, select, textarea, summary, [role='switch'], a[href]"),
      ).filter((el) => {
        if (!(el instanceof HTMLElement)) return false;
        if (el.classList.contains("skip") || el.classList.contains("sr-only")) return false;
        if (el.hidden || el.getAttribute("aria-hidden") === "true") return false;
        const closedDetails = el.closest("details:not([open])");
        if (closedDetails && !(el.tagName.toLowerCase() === "summary" && el.parentElement === closedDetails)) {
          return false;
        }
        const cs = window.getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });

      const clippedSelectors = [];
      for (const el of controlNodes) {
        const r = el.getBoundingClientRect();
        const cs = window.getComputedStyle(el);
        const tag = el.tagName.toLowerCase();
        const horizOut = r.left < -1 || r.right > innerWidth + 1;
        const mainHorizOut =
          Boolean(mainRect && mainEl && mainEl.contains(el)) &&
          (r.left < mainRect.left - 1 || r.right > mainRect.right + 1);
        const vertOut = isHud && (r.top < -1 || r.bottom > innerHeight + 1);
        const internalClipped =
          (tag === "button" || tag === "summary" || tag === "select") &&
          ((cs.overflowX === "hidden" && el.scrollWidth > el.clientWidth + 2) ||
            (cs.overflowY === "hidden" && el.scrollHeight > el.clientHeight + 2) ||
            r.height < 24 ||
            r.width < 24);
        if (horizOut || mainHorizOut || vertOut || internalClipped) {
          const label = (el.textContent || el.getAttribute("aria-label") || el.id || tag).trim().slice(0, 24);
          clippedSelectors.push(`${tag}:${label}`);
        }
      }

      if (isHud) {
        const hudCard = document.querySelector(".hud-card");
        if (hudCard instanceof HTMLElement) {
          const cr = hudCard.getBoundingClientRect();
          if (cr.top < -1 || cr.left < -1 || cr.right > innerWidth + 1 || cr.bottom > innerHeight + 1) {
            clippedSelectors.push("section.hud-card");
          }
        }
      }

      const visibleButtons = controlNodes.filter((el) => el.tagName.toLowerCase() === "button").length;
      const openDetails = document.querySelectorAll("details[open]").length;

      return {
        innerWidth,
        innerHeight,
        scrollWidth,
        overflowPx,
        controlsChecked: controlNodes.length,
        clippedControls: clippedSelectors.length,
        clippedSample: clippedSelectors.slice(0, 4),
        visibleButtons,
        openDetails,
      };
    },
    { isHud: Boolean(condition.isHud), isTextSpacing: Boolean(condition.textSpacing1412) },
  );

  const viewportExact = metrics.innerWidth === condition.width && metrics.innerHeight === condition.height;
  const pass = viewportExact && metrics.overflowPx === 0 && metrics.clippedControls === 0;

  return {
    id: `${condition.id}:${screen}`,
    condition: condition.id,
    screen,
    viewport: `${condition.width}x${condition.height}`,
    textSpacing1412: Boolean(condition.textSpacing1412),
    innerWidth: metrics.innerWidth,
    scrollWidth: metrics.scrollWidth,
    overflowPx: metrics.overflowPx,
    controlsChecked: metrics.controlsChecked,
    clippedControls: metrics.clippedControls,
    visibleButtons: metrics.visibleButtons,
    openDetails: metrics.openDetails,
    ...(metrics.clippedSample.length ? { clippedSample: metrics.clippedSample } : {}),
    pass,
  };
}

async function auditVerdictStopBar(page, condition, stageLabel, requireInitialClear) {
  await ensureConditionStyle(page, condition);
  const check = await page.evaluate((scrollBlock) => {
    const stopBar = document.querySelector(".bigbtn-wrap");
    const tabs = document.querySelector("nav.tabs");
    const buttons = Array.from(document.querySelectorAll("section.verdict .actions button"));
    if (!(stopBar instanceof HTMLElement) || !(tabs instanceof HTMLElement) || buttons.length === 0) {
      return {
        foundStopBar: Boolean(stopBar),
        actionCount: buttons.length,
        labels: [],
        initialAllClear: false,
        allClearAfterFocus: false,
        obscuredCount: buttons.length || 1,
        minClearanceAboveStopBarPx: -999,
      };
    }

    const initialBarRect = stopBar.getBoundingClientRect();
    const initialClear = buttons.every((b) => {
      const r = b.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= initialBarRect.top + 1;
    });

    const perButton = [];
    for (const btn of buttons) {
      if (!(btn instanceof HTMLElement)) continue;
      btn.scrollIntoView({ block: scrollBlock });
      btn.focus({ preventScroll: false });
      const r = btn.getBoundingClientRect();
      const barRect = stopBar.getBoundingClientRect();
      const tabsRect = tabs.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      const hitSelf = Boolean(hit && (hit === btn || btn.contains(hit)));
      const hitStopBar = Boolean(hit && stopBar.contains(hit));
      const hitTabs = Boolean(hit && tabs.contains(hit));
      const clearancePx = Math.round(barRect.top - r.bottom);
      const obscured =
        r.top < 0 ||
        r.bottom > barRect.top + 1 ||
        r.bottom > tabsRect.top + 1 ||
        !hitSelf ||
        hitStopBar ||
        hitTabs;
      perButton.push({
        label: (btn.textContent || "").trim(),
        clearancePx,
        hitSelf,
        obscured,
      });
    }

    const obscuredCount = perButton.filter((b) => b.obscured).length;
    const minClearanceAboveStopBarPx = Math.min(...perButton.map((b) => b.clearancePx));
    return {
      foundStopBar: true,
      actionCount: perButton.length,
      labels: perButton.map((b) => b.label),
      initialAllClear: initialClear,
      allClearAfterFocus: obscuredCount === 0,
      obscuredCount,
      minClearanceAboveStopBarPx,
    };
  }, requireInitialClear ? "nearest" : "center");

  const expectedLabels = ["Repeat", "I took it", "Dismiss"];
  const hasExpectedActions = expectedLabels.every((lbl) => check.labels.includes(lbl));

  return {
    condition: condition.id,
    stage: stageLabel,
    viewport: `${condition.width}x${condition.height}`,
    textSpacing1412: Boolean(condition.textSpacing1412),
    actionCount: check.actionCount,
    labels: check.labels,
    hasExpectedActions,
    initialAllClear: check.initialAllClear,
    allClearAfterFocus: check.allClearAfterFocus,
    obscuredCount: check.obscuredCount,
    minClearanceAboveStopBarPx: check.minClearanceAboveStopBarPx,
    pass:
      check.foundStopBar &&
      hasExpectedActions &&
      (!requireInitialClear || check.initialAllClear) &&
      check.allClearAfterFocus &&
      check.obscuredCount === 0 &&
      check.minClearanceAboveStopBarPx >= 0,
  };
}

async function auditPrivacySwitches(page, condition) {
  await ensureConditionStyle(page, condition);
  const check = await page.evaluate(() => {
    const tabs = document.querySelector("nav.tabs");
    const featScene = document.querySelector("input[aria-describedby='feat-scene']");
    const switches = Array.from(document.querySelectorAll("input[role='switch']"));
    const deleteBtn = Array.from(document.querySelectorAll("button")).find((b) =>
      /delete all my data/i.test(b.textContent || ""),
    );

    if (!(tabs instanceof HTMLElement) || !(featScene instanceof HTMLElement) || switches.length === 0) {
      return {
        switchesTotal: switches.length,
        switchesHitCount: 0,
        tabsCoveredCount: switches.length || 1,
        featSceneHit: false,
        featSceneHits: [],
        deleteBtnClear: false,
        minClearanceAboveTabsPx: -999,
      };
    }

    function probeSwitch(sw) {
      sw.scrollIntoView({ block: "nearest" });
      sw.focus({ preventScroll: false });
      const r = sw.getBoundingClientRect();
      const label = sw.closest("label.switch");
      const tabsRect = tabs.getBoundingClientRect();
      const samplePoints = [
        [r.left + r.width / 2, r.top + 2],
        [r.left + r.width / 2, r.top + r.height / 2],
        [r.left + r.width / 2, r.bottom - 2],
      ];
      const hits = samplePoints.map(([x, y]) => document.elementFromPoint(x, y));
      const coveredByTabs = hits.some((h) => !h || tabs.contains(h)) || r.bottom > tabsRect.top + 1 || r.top < 0;
      const hitsSwitchOrLabel = hits.every(
        (h) => h && (h === sw || (label instanceof HTMLElement && (h === label || label.contains(h)))),
      );
      const hitTags = hits.map((h) => (h ? h.tagName.toLowerCase() : "none"));
      return {
        clearancePx: Math.round(tabsRect.top - r.bottom),
        coveredByTabs,
        hitsSwitchOrLabel,
        hitTags,
      };
    }

    const switchResults = switches.filter((s) => s instanceof HTMLElement).map((s) => probeSwitch(s));

    let deleteBtnClear = false;
    if (deleteBtn instanceof HTMLElement) {
      deleteBtn.scrollIntoView({ block: "nearest" });
      const dr = deleteBtn.getBoundingClientRect();
      const tabsRect = tabs.getBoundingClientRect();
      const dHit = document.elementFromPoint(dr.left + dr.width / 2, dr.top + dr.height / 2);
      deleteBtnClear =
        dr.top >= 0 &&
        dr.bottom <= tabsRect.top + 1 &&
        Boolean(dHit && (dHit === deleteBtn || deleteBtn.contains(dHit)) && !tabs.contains(dHit));
    }

    const featSceneProbe = probeSwitch(featScene);
    const switchesHitCount = switchResults.filter((s) => s.hitsSwitchOrLabel && !s.coveredByTabs).length;
    const tabsCoveredCount = switchResults.filter((s) => s.coveredByTabs).length;
    const minClearanceAboveTabsPx = Math.min(...switchResults.map((s) => s.clearancePx));

    return {
      switchesTotal: switchResults.length,
      switchesHitCount,
      tabsCoveredCount,
      featSceneHit: featSceneProbe.hitsSwitchOrLabel && !featSceneProbe.coveredByTabs,
      featSceneHits: featSceneProbe.hitTags,
      deleteBtnClear,
      minClearanceAboveTabsPx,
    };
  });

  return {
    condition: condition.id,
    viewport: `${condition.width}x${condition.height}`,
    textSpacing1412: Boolean(condition.textSpacing1412),
    switchesTotal: check.switchesTotal,
    switchesHitCount: check.switchesHitCount,
    tabsCoveredCount: check.tabsCoveredCount,
    featSceneHit: check.featSceneHit,
    featSceneHits: check.featSceneHits,
    deleteBtnClear: check.deleteBtnClear,
    minClearanceAboveTabsPx: check.minClearanceAboveTabsPx,
    pass:
      check.switchesTotal >= 8 &&
      check.switchesHitCount === check.switchesTotal &&
      check.tabsCoveredCount === 0 &&
      check.featSceneHit &&
      check.deleteBtnClear &&
      check.minClearanceAboveTabsPx >= 0,
  };
}

async function askMockQuestion(page, query) {
  const input = page.locator("#ask");
  await input.fill(query);
  await page.locator("form.textask button[type='submit']").first().click();
  await page.waitForSelector("section.verdict", { timeout: 18000 });
  await page.waitForTimeout(120);
}

async function runPhoneCondition(browser, baseUrl, condition) {
  const ctx = await browser.newContext({
    viewport: { width: condition.width, height: condition.height },
    ...MOBILE_EMULATION,
  });
  const page = await ctx.newPage();
  const screens = [];
  const verdictOcclusions = [];
  const axeRuns = [];

  try {
    await page.goto(`${baseUrl}/?mock=1`, { waitUntil: "networkidle" });
    screens.push(await measureScreen(page, condition, "onboarding-welcome"));

    await page.getByRole("button", { name: /^continue$/i }).click();
    await page.waitForTimeout(80);
    await page.getByRole("button", { name: /^next$/i }).click();
    await page.waitForTimeout(80);
    await page.getByRole("button", { name: /^next$/i }).click();
    await page.waitForTimeout(80);
    screens.push(await measureScreen(page, condition, "onboarding-consent"));
    if (!condition.textSpacing1412) {
      axeRuns.push(await runAxeAudit(page, condition.id, "onboarding-consent"));
    }

    await page.getByRole("button", { name: /^i agree$/i }).click();
    await page.waitForTimeout(120);
    if (await page.getByRole("heading", { name: /camera and microphone/i }).count()) {
      await page.getByRole("button", { name: /^not now$/i }).click();
      await page.waitForTimeout(120);
      if (await page.getByRole("button", { name: /continue without/i }).count()) {
        screens.push(await measureScreen(page, condition, "permissions-recovery"));
        await page.getByRole("button", { name: /continue without/i }).click();
        await page.waitForTimeout(120);
      }
    }

    screens.push(await measureScreen(page, condition, "check-idle"));

    await askMockQuestion(page, "is this my evening pill");
    screens.push(await measureScreen(page, condition, "check-verdict"));
    verdictOcclusions.push(await auditVerdictStopBar(page, condition, "verdict-initial", true));
    if (!condition.textSpacing1412) {
      axeRuns.push(await runAxeAudit(page, condition.id, "check-verdict"));
    }

    const detailsSummary = page.locator("section.verdict details summary");
    if (await detailsSummary.count()) {
      await detailsSummary.click();
      await page.waitForTimeout(80);
    }
    screens.push(await measureScreen(page, condition, "check-verdict-details"));
    verdictOcclusions.push(await auditVerdictStopBar(page, condition, "verdict-details-expanded", false));

    await page.getByRole("button", { name: /^dismiss$/i }).click();
    await page.waitForTimeout(80);
    const stopBtn = page.locator("button.bigbtn.stop");
    if (await stopBtn.count()) {
      await stopBtn.click();
      await page.waitForTimeout(80);
    }

    await page.locator("nav.tabs button", { hasText: "Profile" }).click();
    await page.waitForTimeout(140);
    screens.push(await measureScreen(page, condition, "profile"));
    axeRuns.push(await runAxeAudit(page, condition.id, "profile"));

    await page.locator("nav.tabs button", { hasText: "Privacy" }).click();
    await page.waitForTimeout(140);
    screens.push(await measureScreen(page, condition, "privacy"));
    axeRuns.push(await runAxeAudit(page, condition.id, "privacy"));
    const privacyOcclusion = await auditPrivacySwitches(page, condition);

    return { screens, verdictOcclusions, privacyOcclusion, axeRuns };
  } finally {
    await ctx.close();
  }
}

async function runHudCondition(browser, baseUrl, condition) {
  const ctx = await browser.newContext({
    viewport: { width: condition.width, height: condition.height },
  });
  const page = await ctx.newPage();
  const screens = [];
  const axeRuns = [];

  try {
    await page.goto(`${baseUrl}/hud/?mock=1`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".cue-card", { timeout: 6000 });
    screens.push(await measureScreen(page, condition, "hud-coach-cue"));

    await page.waitForSelector(".verdict-card", { timeout: 6000 });
    screens.push(await measureScreen(page, condition, "hud-verdict"));
    axeRuns.push(await runAxeAudit(page, condition.id, "hud-verdict"));

    return { screens, axeRuns };
  } finally {
    await ctx.close();
  }
}

const args = process.argv.slice(2);
let explicitBase = null;
let outPath = path.join(repoRoot, "docs/evidence/lowvision-reflow-audit.json");
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--out" && args[i + 1]) {
    outPath = path.resolve(args[++i]);
  } else if (!args[i].startsWith("--") && !explicitBase) {
    explicitBase = args[i];
  }
}

const PHONE_CONDITIONS = [
  {
    id: "360x800-mobile",
    width: 360,
    height: 800,
    device: "Android TalkBack (docs/QA.md #13)",
    wcag: "1.4.10 + 2.4.11 + 2.5.8",
    textSpacing1412: false,
  },
  {
    id: "360x800-1.4.12",
    width: 360,
    height: 800,
    device: "Android TalkBack (docs/QA.md #13) + WCAG 1.4.12",
    wcag: "1.4.12 + 2.4.11 + 2.5.8",
    textSpacing1412: true,
  },
  {
    id: "375x667-mobile",
    width: 375,
    height: 667,
    device: "iPhone SE",
    wcag: "1.4.10 + 2.4.11 + 2.5.8",
    textSpacing1412: false,
  },
  {
    id: "375x667-1.4.12",
    width: 375,
    height: 667,
    device: "iPhone SE + WCAG 1.4.12",
    wcag: "1.4.12 + 2.4.11 + 2.5.8",
    textSpacing1412: true,
  },
  {
    id: "390x844-mobile",
    width: 390,
    height: 844,
    device: "iPhone 14",
    wcag: "1.4.10 + 2.4.11 + 2.5.8",
    textSpacing1412: false,
  },
  {
    id: "390x844-1.4.12",
    width: 390,
    height: 844,
    device: "iPhone 14 + WCAG 1.4.12",
    wcag: "1.4.12 + 2.4.11 + 2.5.8",
    textSpacing1412: true,
  },
];

const HUD_CONDITIONS = [
  {
    id: "600x600-hud",
    width: 600,
    height: 600,
    device: "Ray-Ban Display HUD",
    wcag: "HUD 600x600",
    textSpacing1412: false,
    isHud: true,
  },
  {
    id: "600x600-hud-1.4.12",
    width: 600,
    height: 600,
    device: "Ray-Ban Display HUD + WCAG 1.4.12",
    wcag: "HUD 600x600 + 1.4.12",
    textSpacing1412: true,
    isHud: true,
  },
];

ensureWebDistBuilt();

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "holdup-lowvision-"));
const tempLedger = path.join(tempDir, "ledger.jsonl");
let startedServer = null;
let baseUrl = explicitBase;
let browser = null;

const allScreens = [];
const verdictOcclusionAudit = [];
const privacyOcclusionAudit = [];
const axeSummary = [];

try {
  if (!baseUrl) {
    startedServer = await startKeylessServer(tempLedger);
    baseUrl = startedServer.origin;
  }

  const exe = resolveChromiumExecutable();
  browser = await chromium.launch({
    headless: true,
    ...(exe ? { executablePath: exe } : {}),
  });

  const phoneBatches = [PHONE_CONDITIONS.slice(0, 3), PHONE_CONDITIONS.slice(3)];
  for (const batch of phoneBatches) {
    const batchOut = await Promise.all(batch.map((cond) => runPhoneCondition(browser, baseUrl, cond)));
    for (const item of batchOut) {
      allScreens.push(...item.screens);
      verdictOcclusionAudit.push(...item.verdictOcclusions);
      privacyOcclusionAudit.push(item.privacyOcclusion);
      axeSummary.push(...item.axeRuns);
    }
  }

  const hudOut = await Promise.all(HUD_CONDITIONS.map((cond) => runHudCondition(browser, baseUrl, cond)));
  for (const item of hudOut) {
    allScreens.push(...item.screens);
    axeSummary.push(...item.axeRuns);
  }
} finally {
  if (browser) {
    await browser.close();
  }
  if (startedServer) {
    await stopChildProcess(startedServer.child);
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
}

const horizontalOverflowCount = allScreens.filter((s) => s.overflowPx > 0).length;
const clippedControlCount = allScreens.reduce((sum, s) => sum + s.clippedControls, 0);
const privacySwitchChecks = privacyOcclusionAudit.reduce((sum, p) => sum + p.switchesTotal, 0);
const privacySwitchOccludedCount = privacyOcclusionAudit.reduce(
  (sum, p) => sum + p.tabsCoveredCount + (p.switchesTotal - p.switchesHitCount),
  0,
);
const verdictActionChecks = verdictOcclusionAudit.reduce((sum, v) => sum + v.actionCount, 0);
const verdictActionObscuredCount = verdictOcclusionAudit.reduce((sum, v) => sum + v.obscuredCount, 0);
const axeViolationCount = axeSummary.reduce((sum, a) => sum + a.violationCount, 0);
const axeViolationNodes = axeSummary.reduce((sum, a) => sum + a.violationNodes, 0);

const allScreensPass = allScreens.every((s) => s.pass);
const allPrivacyPass = privacyOcclusionAudit.every((p) => p.pass);
const allVerdictPass = verdictOcclusionAudit.every((v) => v.pass);
const allAxePass = axeViolationCount === 0 && axeViolationNodes === 0;

const allPassed =
  allScreensPass &&
  allPrivacyPass &&
  allVerdictPass &&
  allAxePass &&
  horizontalOverflowCount === 0 &&
  clippedControlCount === 0 &&
  privacySwitchOccludedCount === 0 &&
  verdictActionObscuredCount === 0;

const report = {
  tool: "playwright headless chromium mobile occlusion, axe WCAG 2.2 AA & WCAG 1.4.12 text-spacing audit",
  wcagCriteria: [
    "1.4.4 Resize Text (AA)",
    "1.4.10 Reflow (AA)",
    "1.4.12 Text Spacing (AA)",
    "2.4.11 Focus Not Obscured (Minimum) (AA)",
    "2.5.8 Target Size (Minimum) (AA)",
  ],
  qaFindingClosed:
    "docs/QA.md #13 (mobile emulation isMobile=true, hasTouch=true, deviceScaleFactor=3 across 360x800, 375x667, 390x844 + 600x600 HUD)",
  server: explicitBase ? "external" : "server/src/index.ts PORT=0 keyless",
  mobileEmulation: MOBILE_EMULATION,
  textSpacingOverride: {
    lineHeight: 1.5,
    letterSpacingEm: 0.12,
    wordSpacingEm: 0.16,
  },
  when: new Date().toISOString(),
  summary: {
    totalScreenChecks: allScreens.length,
    passedScreenChecks: allScreens.filter((s) => s.pass).length,
    horizontalOverflowCount,
    clippedControlCount,
    privacySwitchChecks,
    privacySwitchOccludedCount,
    verdictActionChecks,
    verdictActionObscuredCount,
    axeAudits: axeSummary.length,
    axeViolationCount,
    axeViolationNodes,
    allPassed,
  },
  conditionsSummary: [...PHONE_CONDITIONS, ...HUD_CONDITIONS].map((c) => {
    const condScreens = allScreens.filter((s) => s.condition === c.id);
    const condPrivacy = privacyOcclusionAudit.find((p) => p.condition === c.id);
    const condVerdicts = verdictOcclusionAudit.filter((v) => v.condition === c.id);
    const condAxe = axeSummary.filter((a) => a.condition === c.id);
    return {
      condition: c.id,
      viewport: `${c.width}x${c.height}`,
      device: c.device,
      textSpacing1412: Boolean(c.textSpacing1412),
      screensChecked: condScreens.length,
      screensPassed: condScreens.filter((s) => s.pass).length,
      maxOverflowPx: Math.max(0, ...condScreens.map((s) => s.overflowPx)),
      clippedControls: condScreens.reduce((sum, s) => sum + s.clippedControls, 0),
      privacySwitchesPass: condPrivacy ? condPrivacy.pass : null,
      verdictActionsPass: condVerdicts.length ? condVerdicts.every((v) => v.pass) : null,
      axeViolations: condAxe.reduce((sum, a) => sum + a.violationNodes, 0),
    };
  }),
  privacyOcclusionAudit,
  verdictOcclusionAudit,
  axeSummary,
  screens: allScreens,
};

const json = `${JSON.stringify(report, null, 2)}\n`;
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, json, "utf8");
process.stdout.write(json);

if (!allPassed) {
  process.exitCode = 1;
}
