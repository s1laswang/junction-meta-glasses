import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF_PATH = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(SELF_PATH), "..");
const OUT_PATH = path.join(ROOT_DIR, "docs", "evidence", "hud-stage-a11y.json");
const SHARED_PW = "/tmp/fleet-root/shared/ms-playwright";
const SLASH2 = String.fromCharCode(47, 47);
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const SPATIAL_NAV_ARGS = ["--enable-spatial-navigation", "--enable-blink-features=SpatialNavigation"];
const FRAME_SENTINEL = "SENTINEL_CAMERA_FRAME_JPEG_B64_9911";
const AUDIO_SENTINEL = "SENTINEL_MIC_AUDIO_PCM16_B64_9911";

if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync(SHARED_PW)) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = SHARED_PW;
}

const distMain = path.join(ROOT_DIR, "web", "dist", "index.html");
const distHud = path.join(ROOT_DIR, "web", "dist", "hud", "index.html");
if (!fs.existsSync(distMain) || !fs.existsSync(distHud)) {
  execFileSync("npm", ["run", "build"], { cwd: ROOT_DIR, stdio: "inherit" });
}

const { chromium } = await import("playwright");
const { default: AxeBuilder } = await import("@axe-core/playwright");

function findMacExecutable() {
  const cache = path.join(os.homedir(), "Library", "Caches", "ms-playwright");
  if (!fs.existsSync(cache)) return undefined;
  return fs
    .readdirSync(cache)
    .filter((d) => d.startsWith("chromium-"))
    .sort()
    .reverse()
    .map((d) => path.join(cache, d, "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"))
    .find((p) => fs.existsSync(p));
}

function emptyField() {
  return { value: null, confidence: 0 };
}

function makeFixtures() {
  const codeAgree = {
    raw: "(01)06416542005218(17)270831(10)B2417(21)A1",
    gtin: "06416542005218",
    expiry: "2027-08-31",
    batch: "B2417",
    serial: "A1",
  };
  const baseMedRead = {
    kind: "medication",
    product: { value: "Amlodipine", confidence: 0.97 },
    ingredient: { value: "amlodipine", confidence: 0.93 },
    strength: { value: "5 mg", confidence: 0.95 },
    dosing: emptyField(),
    expiry: { value: "2027-08-31", confidence: 0.94 },
    allergens: emptyField(),
    barcode: { value: "06416542005218", confidence: 0.99 },
    readability: 0.92,
  };
  const matchVerdict = {
    level: "match",
    headline: "Amlodipine 5 mg",
    speech: "Yes, Amlodipine 5 mg, your evening pill. You have not taken it today.",
    read: baseMedRead,
    matchedMedId: "amlodipine",
    reasons: ["Name and strength match your list", "Taken today: 0 of 1"],
    takenToday: false,
    crossCheck: {
      source: "datamatrix",
      code: codeAgree,
      agrees: true,
      details: ["GTIN matches your Amlodipine", "expiry: code 2027-08 = print 2027-08"],
    },
  };
  const warningVerdict = {
    level: "warning",
    headline: "Ibuprofen: not on your list",
    speech: "This is Ibuprofen 400 milligrams. It is not on your list, and your list says to avoid NSAIDs.",
    read: {
      ...baseMedRead,
      product: { value: "Ibuprofen", confidence: 0.96 },
      ingredient: { value: "ibuprofen", confidence: 0.95 },
      strength: { value: "400 mg", confidence: 0.94 },
      barcode: emptyField(),
    },
    reasons: ["Not on your medication list", "Ibuprofen is an NSAID, and you avoid NSAIDs"],
  };
  const warningDisagreeVerdict = {
    ...warningVerdict,
    crossCheck: {
      source: "datamatrix",
      code: codeAgree,
      agrees: false,
      details: ["pack code GTIN 06416542005218 does not match printed Ibuprofen"],
    },
  };
  const unsureVerdict = {
    level: "unsure",
    headline: "Can't read the strength",
    speech: "I can read Metformin, but I cannot read the strength confidently. Turn the box so the side panel faces you.",
    read: {
      ...baseMedRead,
      product: { value: "Metformin", confidence: 0.9 },
      ingredient: { value: "metformin hydrochloride", confidence: 0.82 },
      strength: { value: null, confidence: 0.31 },
      barcode: emptyField(),
      readability: 0.45,
      guidance: "Show the side panel with the strength",
    },
    reasons: ["Strength unreadable (confidence 31%)", "HoldUp never guesses a dose"],
  };
  const sceneVerdict = {
    mode: "scene",
    level: "match",
    headline: "Your evening pill: on the right",
    speech: "Your evening pill, Amlodipine 5 milligrams, is the one on the right.",
    read: baseMedRead,
    matchedMedId: "amlodipine",
    reasons: ["3 packages seen, left to right", "Right: matches your Amlodipine 5 mg", "Middle: ibuprofen is an NSAID"],
    items: [
      {
        position: "left",
        level: "unsure",
        headline: "Paracetamol: not on your list",
        box: [330, 70, 760, 300],
        read: { ...baseMedRead, product: { value: "Paracetamol", confidence: 0.93 }, strength: { value: "500 mg", confidence: 0.9 } },
      },
      {
        position: "center",
        level: "warning",
        headline: "Ibuprofen: you avoid NSAIDs",
        box: [300, 390, 760, 610],
        read: { ...baseMedRead, product: { value: "Ibuprofen", confidence: 0.93 }, strength: { value: "400 mg", confidence: 0.9 } },
      },
      {
        position: "right",
        level: "match",
        headline: "Amlodipine 5 mg: evening pill",
        box: [310, 700, 770, 930],
        matchedMedId: "amlodipine",
        read: baseMedRead,
      },
    ],
  };
  return { matchVerdict, warningVerdict, warningDisagreeVerdict, unsureVerdict, sceneVerdict };
}

async function startKeylessServer(tempLedgerPath) {
  const child = spawn(process.execPath, ["--import", "tsx", path.join(ROOT_DIR, "server", "src", "index.ts")], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      PORT: "0",
      GEMINI_API_KEY: "",
      ELEVENLABS_API_KEY: "",
      ELEVENLABS_LIVE: "",
      HOLDUP_KEY: "",
      HOLDUP_QUIET: "",
      LEDGER_PATH: tempLedgerPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const port = await new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    const timer = setTimeout(() => reject(new Error("Timed out waiting for server.listening: " + out + " " + err)), 15000);
    child.stdout.on("data", (chunk) => {
      out += chunk.toString();
      const match = out.match(/server\.listening\s+port=(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.stderr.on("data", (chunk) => {
      err += chunk.toString();
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited early with code ${String(code)}: ${err}`));
    });
  });

  const base = "http:" + SLASH2 + "127.0.0.1:" + String(port);
  const healthRes = await fetch(base + "/api/health");
  const healthJson = await healthRes.json();
  if (!healthRes.ok || healthJson.ok !== true || healthJson.gemini !== "down") {
    child.kill("SIGTERM");
    throw new Error("Expected keyless server health ok=true gemini=down, got: " + JSON.stringify(healthJson));
  }

  return {
    base,
    port,
    health: { ok: healthJson.ok, gemini: healthJson.gemini },
    async stop() {
      if (child.exitCode !== null) return;
      await new Promise((resolve) => {
        const killTimer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 3000);
        child.once("exit", () => {
          clearTimeout(killTimer);
          resolve();
        });
        child.kill("SIGTERM");
      });
    },
  };
}

async function runAxeWithOverflow(page, meta) {
  const axe = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const layout = await page.evaluate(() => {
    const docEl = document.documentElement;
    const body = document.body;
    const sw = Math.max(docEl.scrollWidth, body ? body.scrollWidth : 0);
    const sh = Math.max(docEl.scrollHeight, body ? body.scrollHeight : 0);
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      horizontalOverflowPx: Math.max(0, sw - window.innerWidth),
      verticalOverflowPx: Math.max(0, sh - window.innerHeight),
    };
  });
  const violations = axe.violations.map((v) => ({
    id: v.id,
    impact: v.impact ?? "unknown",
    nodes: v.nodes.length,
  }));
  const violationNodes = violations.reduce((sum, v) => sum + v.nodes, 0);
  return {
    ...meta,
    violations,
    violationNodes,
    passes: axe.passes.length,
    incomplete: axe.incomplete.length,
    horizontalOverflowPx: layout.horizontalOverflowPx,
    verticalOverflowPx: layout.verticalOverflowPx,
  };
}

async function auditHud(browser, base, fixtures) {
  const ctx = await browser.newContext({ viewport: { width: 600, height: 600 } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("pageerror", (err) => consoleErrors.push(err.message));

  await page.goto(base + "/hud/?mock=1", { waitUntil: "networkidle" });

  await page.evaluate(() => {
    const w = window;
    w.__hudEvents = [];
    w.__hudClicks = {};
    const listener = new BroadcastChannel("holdup-hud-mock");
    listener.onmessage = (ev) => {
      if (ev.data && ev.data.type === "hud_event") {
        w.__hudEvents.push(ev.data.name);
      }
    };
    w.__hudDriver = new BroadcastChannel("holdup-hud-mock");
    w.__hudDriver.postMessage({ type: "status", live: "open" });
    document.addEventListener(
      "click",
      (ev) => {
        const target = ev.target;
        const btn = target && typeof target.closest === "function" ? target.closest("button") : null;
        if (!btn) return;
        const key = btn.classList.contains("hud-speak") ? "Speak" : (btn.textContent || "").trim();
        w.__hudClicks[key] = (w.__hudClicks[key] || 0) + 1;
      },
      true,
    );
  });

  const postHud = (msg) =>
    page.evaluate((payload) => {
      window.__hudDriver.postMessage(payload);
    }, msg);

  const focusedLabel = () =>
    page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el.tagName !== "BUTTON") return "NONE";
      return (el.textContent || "").trim();
    });

  await page.keyboard.press("Escape");
  await page.waitForSelector(".idle-card");

  const axeStates = [];
  axeStates.push(await runAxeWithOverflow(page, { state: "idle", route: "/hud/?mock=1", viewport: "600x600" }));

  const nativeButtonStructure = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll("button"));
    const labels = buttons.map((b) => (b.textContent || "").trim());
    const allTypeButton = buttons.every((b) => b.getAttribute("type") === "button");
    const positiveTabIndexCount = document.querySelectorAll("[tabindex]").length
      ? Array.from(document.querySelectorAll("[tabindex]")).filter((el) => Number(el.getAttribute("tabindex")) > 0).length
      : 0;
    const nonNativeInteractiveCount = document.querySelectorAll("input, select, textarea, a[href], [role='button']").length;
    buttons[0]?.focus();
    const outlineWidthPx = buttons[0] ? parseFloat(getComputedStyle(buttons[0]).outlineWidth || "0") : 0;
    const minButtonHeightPx = Math.min(...buttons.map((b) => Math.round(b.getBoundingClientRect().height)));
    return {
      buttonCount: buttons.length,
      labels,
      allTypeButton,
      positiveTabIndexCount,
      nonNativeInteractiveCount,
      outlineWidthPx,
      minButtonHeightPx,
      passed:
        buttons.length === 4 &&
        labels[0] === "Repeat" &&
        labels[1] === "I took it" &&
        labels[2] === "Dismiss" &&
        labels[3] === "Speak off" &&
        allTypeButton &&
        positiveTabIndexCount === 0 &&
        nonNativeInteractiveCount === 0 &&
        outlineWidthPx >= 3 &&
        minButtonHeightPx >= 44,
    };
  });

  await postHud({ type: "coach", cue: "rotate_left", text: "Turn it left" });
  await page.waitForSelector(".cue-card");
  axeStates.push(await runAxeWithOverflow(page, { state: "coach_cue", route: "/hud/?mock=1", viewport: "600x600" }));

  await postHud({ type: "verdict", verdict: fixtures.matchVerdict });
  await page.waitForFunction(() => document.querySelector(".verdict-card .hud-headline")?.textContent === "Amlodipine 5 mg");
  const matchFocus = await page.evaluate(() => {
    const takeBtn = Array.from(document.querySelectorAll("button")).find((b) => (b.textContent || "").trim() === "I took it");
    return {
      focused: (document.activeElement?.textContent || "").trim(),
      takeDisabled: Boolean(takeBtn?.disabled),
    };
  });
  axeStates.push(await runAxeWithOverflow(page, { state: "match", route: "/hud/?mock=1", viewport: "600x600" }));

  const matchTransitions = [];
  for (const [key, expected] of [
    ["ArrowLeft", "Repeat"],
    ["ArrowRight", "I took it"],
    ["ArrowRight", "Dismiss"],
    ["ArrowDown", "Speak off"],
    ["ArrowUp", "Dismiss"],
    ["ArrowLeft", "I took it"],
  ]) {
    await page.keyboard.press(key);
    const actual = await focusedLabel();
    matchTransitions.push({ key, expected, actual, passed: actual === expected });
  }

  await page.evaluate(() => {
    window.__hudEvents = [];
    window.__hudClicks = {};
  });

  await page.keyboard.press("ArrowLeft");
  const beforeRepeatFocus = await focusedLabel();
  await page.keyboard.press("Enter");
  const repeatActivation = await page.evaluate((focusedBefore) => ({
    focusedBefore,
    clicks: window.__hudClicks["Repeat"] || 0,
    events: [...window.__hudEvents],
    statusText: (document.querySelector(".hud-status")?.textContent || "").includes("Repeating"),
  }), beforeRepeatFocus);

  await page.evaluate(() => {
    window.__hudEvents = [];
  });
  await page.keyboard.press("ArrowRight");
  const beforeTakeFocus = await focusedLabel();
  await page.keyboard.press("Enter");
  const takeActivation = await page.evaluate((focusedBefore) => ({
    focusedBefore,
    clicks: window.__hudClicks["I took it"] || 0,
    events: [...window.__hudEvents],
    statusText: (document.querySelector(".hud-status")?.textContent || "").includes("Dose logged"),
  }), beforeTakeFocus);

  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  const beforeSpeakOnFocus = await focusedLabel();
  await page.keyboard.press("Enter");
  const speakOnActivation = await page.evaluate((focusedBefore) => {
    const btn = document.querySelector("button.hud-speak");
    return {
      focusedBefore,
      clicksAfterOn: window.__hudClicks["Speak"] || 0,
      labelAfterOn: (btn?.textContent || "").trim(),
      ariaPressedAfterOn: btn?.getAttribute("aria-pressed"),
      storedAfterOn: localStorage.getItem("holdup.hud.speak"),
    };
  }, beforeSpeakOnFocus);

  await page.keyboard.press("Enter");
  const speakOffActivation = await page.evaluate(() => {
    const btn = document.querySelector("button.hud-speak");
    return {
      clicksAfterOff: window.__hudClicks["Speak"] || 0,
      labelAfterOff: (btn?.textContent || "").trim(),
      ariaPressedAfterOff: btn?.getAttribute("aria-pressed"),
      storedAfterOff: localStorage.getItem("holdup.hud.speak"),
    };
  });

  await page.evaluate(() => {
    window.__hudEvents = [];
  });
  await page.keyboard.press("ArrowUp");
  const beforeDismissFocus = await focusedLabel();
  await page.keyboard.press("Enter");
  await page.waitForSelector(".idle-card");
  const dismissActivation = await page.evaluate((focusedBefore) => {
    const takeBtn = Array.from(document.querySelectorAll("button")).find((b) => (b.textContent || "").trim() === "I took it");
    return {
      focusedBefore,
      clicks: window.__hudClicks["Dismiss"] || 0,
      events: [...window.__hudEvents],
      clearedToIdle: Boolean(document.querySelector(".idle-card")),
      takeDisabledAfterDismiss: Boolean(takeBtn?.disabled),
    };
  }, beforeDismissFocus);

  await postHud({ type: "verdict", verdict: fixtures.warningVerdict });
  await page.waitForFunction(() => (document.querySelector(".verdict-card .hud-headline")?.textContent || "").includes("Ibuprofen"));
  const warningFocus = await page.evaluate(() => {
    const takeBtn = Array.from(document.querySelectorAll("button")).find((b) => (b.textContent || "").trim() === "I took it");
    return {
      focused: (document.activeElement?.textContent || "").trim(),
      takeDisabled: Boolean(takeBtn?.disabled),
    };
  });
  axeStates.push(await runAxeWithOverflow(page, { state: "warning", route: "/hud/?mock=1", viewport: "600x600" }));

  const warningTransitions = [];
  for (const [key, expected] of [
    ["ArrowRight", "Dismiss"],
    ["ArrowDown", "Speak off"],
    ["ArrowUp", "Dismiss"],
    ["ArrowLeft", "Repeat"],
  ]) {
    await page.keyboard.press(key);
    const actual = await focusedLabel();
    warningTransitions.push({ key, expected, actual, passed: actual === expected });
  }

  await postHud({ type: "verdict", verdict: fixtures.unsureVerdict });
  await page.waitForFunction(() => (document.querySelector(".verdict-card .hud-headline")?.textContent || "").includes("strength"));
  const unsureFocus = await page.evaluate(() => {
    const takeBtn = Array.from(document.querySelectorAll("button")).find((b) => (b.textContent || "").trim() === "I took it");
    return {
      focused: (document.activeElement?.textContent || "").trim(),
      takeDisabled: Boolean(takeBtn?.disabled),
    };
  });
  axeStates.push(await runAxeWithOverflow(page, { state: "unsure", route: "/hud/?mock=1", viewport: "600x600" }));

  const unsureTransitions = [];
  for (const [key, expected] of [
    ["ArrowRight", "Dismiss"],
    ["ArrowLeft", "Repeat"],
  ]) {
    await page.keyboard.press(key);
    const actual = await focusedLabel();
    unsureTransitions.push({ key, expected, actual, passed: actual === expected });
  }

  await postHud({ type: "verdict", verdict: fixtures.sceneVerdict });
  await page.waitForSelector(".scene-card ol.hud-strip");
  axeStates.push(await runAxeWithOverflow(page, { state: "scene_strip", route: "/hud/?mock=1", viewport: "600x600" }));

  const histPage = await ctx.newPage();
  await histPage.goto("data:text/html,<title>shell</title>");
  await histPage.goto(base + "/hud/?mock=1", { waitUntil: "networkidle" });
  await histPage.evaluate(() => {
    window.__histDriver = new BroadcastChannel("holdup-hud-mock");
    window.__histDriver.postMessage({ type: "status", live: "open" });
  });
  const postHist = (msg) =>
    histPage.evaluate((payload) => {
      window.__histDriver.postMessage(payload);
    }, msg);

  const historyIdleLen = await histPage.evaluate(() => history.length);
  await postHist({ type: "verdict", verdict: fixtures.matchVerdict });
  await histPage.waitForFunction(() => document.querySelector(".verdict-card .hud-headline")?.textContent === "Amlodipine 5 mg");
  await postHist({ type: "verdict", verdict: fixtures.warningVerdict });
  await histPage.waitForFunction(() => (document.querySelector(".verdict-card .hud-headline")?.textContent || "").includes("Ibuprofen"));
  await postHist({ type: "verdict", verdict: fixtures.unsureVerdict });
  await histPage.waitForFunction(() => (document.querySelector(".verdict-card .hud-headline")?.textContent || "").includes("strength"));

  const historyDuring = await histPage.evaluate(() => ({
    length: history.length,
    hudVerdict: history.state?.hudVerdict ?? null,
  }));

  await histPage.evaluate(() => history.back());
  await histPage.waitForSelector(".idle-card");
  const historyAfterFirstBack = await histPage.evaluate(() => ({
    idleVisible: Boolean(document.querySelector(".idle-card")),
    state: history.state,
    pathname: location.pathname,
  }));

  await postHist({ type: "verdict", verdict: fixtures.matchVerdict });
  await histPage.waitForSelector(".verdict-card");
  await histPage.evaluate(() => history.back());
  await histPage.waitForSelector(".idle-card");
  const historyAfterSecondBack = await histPage.evaluate(() => ({
    idleVisible: Boolean(document.querySelector(".idle-card")),
    state: history.state,
    pathname: location.pathname,
  }));

  await histPage.goBack();
  const exitedToShellOnIdleBack = histPage.url().startsWith("data:text/html");
  await histPage.close();

  const historyBack = {
    entriesAddedForThreeVerdicts: historyDuring.length - historyIdleLen,
    hudVerdictStatePresent: historyDuring.hudVerdict === 1,
    poppedToIdleFirst: historyAfterFirstBack.idleVisible && historyAfterFirstBack.state === null && historyAfterFirstBack.pathname === "/hud/",
    poppedToIdleSecond: historyAfterSecondBack.idleVisible && historyAfterSecondBack.state === null && historyAfterSecondBack.pathname === "/hud/",
    exitedToShellOnIdleBack,
    trappedHistory: historyDuring.length - historyIdleLen > 1 || !exitedToShellOnIdleBack,
    passed:
      historyDuring.length - historyIdleLen === 1 &&
      historyDuring.hudVerdict === 1 &&
      historyAfterFirstBack.idleVisible &&
      historyAfterFirstBack.state === null &&
      historyAfterSecondBack.idleVisible &&
      historyAfterSecondBack.state === null &&
      exitedToShellOnIdleBack,
  };

  const hudCdp = await ctx.newCDPSession(page);
  await hudCdp.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-contrast", value: "more" }],
  });
  await postHud({ type: "verdict", verdict: fixtures.matchVerdict });
  await page.waitForSelector(".verdict-card");
  const hudContrastMatches = await page.evaluate(() => matchMedia("(prefers-contrast: more)").matches);
  axeStates.push({
    ...(await runAxeWithOverflow(page, { state: "prefers_contrast_more", route: "/hud/?mock=1", viewport: "600x600" })),
    mediaMatches: hudContrastMatches,
  });

  await hudCdp.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  await postHud({ type: "verdict", verdict: fixtures.warningVerdict });
  await page.waitForFunction(() => (document.querySelector(".verdict-card .hud-headline")?.textContent || "").includes("Ibuprofen"));
  const hudReducedMotion = await page.evaluate(() => {
    const btn = document.querySelector(".hud button");
    return {
      matches: matchMedia("(prefers-reduced-motion: reduce)").matches,
      transitionDuration: btn ? getComputedStyle(btn).transitionDuration : "",
    };
  });
  axeStates.push({
    ...(await runAxeWithOverflow(page, { state: "prefers_reduced_motion", route: "/hud/?mock=1", viewport: "600x600" })),
    mediaMatches: hudReducedMotion.matches && hudReducedMotion.transitionDuration === "0s",
  });

  const keyPage = await ctx.newPage();
  await keyPage.route(
    (url) => url.pathname === "/api/stats",
    (route) =>
      route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ type: "error", code: "unauthorized", message: "access key required", recoverable: false }),
      }),
  );
  await keyPage.routeWebSocket(
    (url) => url.pathname === "/hud-ws",
    (ws) => {
      ws.close({ code: 4401, reason: "unauthorized" });
    },
  );
  await keyPage.goto(base + "/hud/", { waitUntil: "domcontentloaded" });
  await keyPage.waitForFunction(() => document.querySelector(".hud-card .hud-headline")?.textContent === "Access key needed");
  axeStates.push(await runAxeWithOverflow(keyPage, { state: "key_needed", route: "/hud/", viewport: "600x600" }));
  await keyPage.close();
  await ctx.close();

  const autoFocus = {
    matchAutoFocusesTake: matchFocus.focused === "I took it" && matchFocus.takeDisabled === false,
    warningAutoFocusesRepeat: warningFocus.focused === "Repeat" && warningFocus.takeDisabled === true,
    unsureAutoFocusesRepeat: unsureFocus.focused === "Repeat" && unsureFocus.takeDisabled === true,
  };
  autoFocus.passed = autoFocus.matchAutoFocusesTake && autoFocus.warningAutoFocusesRepeat && autoFocus.unsureAutoFocusesRepeat;

  const enterSingleActivation = {
    repeatOnce:
      repeatActivation.focusedBefore === "Repeat" &&
      repeatActivation.clicks === 1 &&
      repeatActivation.events.length === 1 &&
      repeatActivation.events[0] === "repeat" &&
      repeatActivation.statusText,
    takeOnce:
      takeActivation.focusedBefore === "I took it" &&
      takeActivation.clicks === 1 &&
      takeActivation.events.length === 1 &&
      takeActivation.events[0] === "log_dose" &&
      takeActivation.statusText,
    speakToggleOnOnce:
      speakOnActivation.focusedBefore === "Speak off" &&
      speakOnActivation.clicksAfterOn === 1 &&
      speakOnActivation.labelAfterOn === "Speak on" &&
      speakOnActivation.ariaPressedAfterOn === "true" &&
      speakOnActivation.storedAfterOn === "1",
    speakToggleOffOnce:
      speakOffActivation.clicksAfterOff === 2 &&
      speakOffActivation.labelAfterOff === "Speak off" &&
      speakOffActivation.ariaPressedAfterOff === "false" &&
      speakOffActivation.storedAfterOff === "0",
    dismissOnce:
      dismissActivation.focusedBefore === "Dismiss" &&
      dismissActivation.clicks === 1 &&
      dismissActivation.events.length === 1 &&
      dismissActivation.events[0] === "dismiss" &&
      dismissActivation.clearedToIdle &&
      dismissActivation.takeDisabledAfterDismiss,
  };
  enterSingleActivation.passed =
    enterSingleActivation.repeatOnce &&
    enterSingleActivation.takeOnce &&
    enterSingleActivation.speakToggleOnOnce &&
    enterSingleActivation.speakToggleOffOnce &&
    enterSingleActivation.dismissOnce;

  const allTransitions = [...matchTransitions, ...warningTransitions, ...unsureTransitions];
  const arrowNavigation = {
    matchTransitions,
    warningTransitions,
    unsureTransitions,
    passed: allTransitions.every((t) => t.passed),
  };

  const checkOutcomes = [
    nativeButtonStructure.passed,
    autoFocus.passed,
    arrowNavigation.passed,
    enterSingleActivation.passed,
    historyBack.passed,
  ];
  const passedChecks = checkOutcomes.filter(Boolean).length;

  return {
    viewport: "600x600",
    consoleErrors: consoleErrors.length,
    spatialNav: {
      launchArgs: SPATIAL_NAV_ARGS,
      passedChecks,
      totalChecks: checkOutcomes.length,
      passRatePct: Math.round((passedChecks / checkOutcomes.length) * 100),
      allPassed: passedChecks === checkOutcomes.length,
      nativeButtonStructure,
      autoFocus,
      arrowNavigation,
      enterSingleActivation,
      historyBack,
    },
    axeStates,
  };
}

async function inspectStageSemantics(page, sentinels) {
  return page.evaluate(({ frameSentinel, audioSentinel }) => {
    const interactiveSelector = "button, input, select, textarea, a[href], summary, [role='button'], [role='link'], [contenteditable='true']";
    const positiveOrZeroTabIndex = Array.from(document.querySelectorAll("[tabindex]")).filter((el) => Number(el.getAttribute("tabindex")) >= 0).length;
    const interactiveCount = document.querySelectorAll(interactiveSelector).length + positiveOrZeroTabIndex;
    const mediaElementCount = document.querySelectorAll("img, video, canvas, audio, picture, iframe, object, embed").length;
    const html = document.documentElement.outerHTML;
    const hasDataImage = html.includes("data:image/") || html.includes("data:audio/") || html.includes("blob:");
    const hasSentinel = html.includes(frameSentinel) || html.includes(audioSentinel);
    const footerText = (document.querySelector("footer.stage-foot")?.textContent || "").trim();

    const meters = Array.from(document.querySelectorAll("[role='meter']"));
    const meter = meters[0] || null;
    const labelId = meter?.getAttribute("aria-labelledby") || "";
    const labelEl = labelId ? document.getElementById(labelId) : null;
    const min = Number(meter?.getAttribute("aria-valuemin"));
    const max = Number(meter?.getAttribute("aria-valuemax"));
    const now = Number(meter?.getAttribute("aria-valuenow"));
    const valueText = (meter?.getAttribute("aria-valuetext") || "").trim();
    const meterAriaValid =
      meters.length === 1 &&
      Boolean(labelEl && (labelEl.textContent || "").trim().length > 0) &&
      min === 0 &&
      max === 100 &&
      Number.isFinite(now) &&
      now >= 0 &&
      now <= 100 &&
      valueText.length > 0;

    const statuses = Array.from(document.querySelectorAll("[role='status']"));
    const status = statuses[0] || null;
    const statusText = (status?.textContent || "").trim();
    const dotHidden = status?.querySelector(".stage-dot")?.getAttribute("aria-hidden") === "true";
    const statusAriaValid = statuses.length === 1 && statusText.length > 0 && dotHidden;

    return {
      interactiveCount,
      mediaElementCount,
      frameOrAudioLeak: hasDataImage || hasSentinel,
      readOnlyFooter: footerText === "Read-only view. No camera images are shown or sent here.",
      meterAriaValid,
      statusAriaValid,
      statusText,
      driverBadge: (document.querySelector(".stage-mock")?.textContent || "").trim(),
    };
  }, sentinels);
}

async function auditStageViewport(browser, base, fixtures, width, height) {
  const viewportLabel = `${width}x${height}`;
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("pageerror", (err) => consoleErrors.push(err.message));

  await page.goto(base + "/stage?mock=1", { waitUntil: "networkidle" });
  await page.waitForSelector(".stage h1");

  const states = [];
  const recordStageState = async (state, extra = {}) => {
    const axe = await runAxeWithOverflow(page, { state, route: "/stage?mock=1", viewport: viewportLabel });
    const sem = await inspectStageSemantics(page, { frameSentinel: FRAME_SENTINEL, audioSentinel: AUDIO_SENTINEL });
    states.push({
      ...axe,
      interactiveCount: sem.interactiveCount,
      mediaElementCount: sem.mediaElementCount,
      frameOrAudioLeak: sem.frameOrAudioLeak,
      readOnlyFooter: sem.readOnlyFooter,
      meterAriaValid: sem.meterAriaValid,
      statusAriaValid: sem.statusAriaValid,
      driverBadge: sem.driverBadge,
      statusText: sem.statusText,
      ...extra,
    });
  };

  await page.waitForSelector(".stage-cue.on", { timeout: 6000 });
  await recordStageState("scripted_coaching");

  await page.waitForSelector(".stage-cue.checking", { timeout: 10000 });
  await recordStageState("scripted_checking");

  await page.waitForSelector(".stage-lens .verdict-card", { timeout: 6000 });
  await recordStageState("scripted_verdict");

  const peerPage = await ctx.newPage();
  await peerPage.goto(base + "/?mock=1", { waitUntil: "domcontentloaded" });
  const postStageBatch = (messages) =>
    peerPage.evaluate((batch) => {
      const ch = new BroadcastChannel("holdup-stage-mock");
      for (const msg of batch) ch.postMessage(msg);
      ch.close();
    }, messages);

  await postStageBatch([
    { type: "ready", model: "mock-gemini-live", session: "MOCK", features: ["scene", "datamatrix", "addmed", "sonar"] },
    { type: "status", live: "open" },
    { type: "device", device: { connected: true, worn: true, battery: 82, streaming: true, source: "glasses" } },
    {
      type: "metrics",
      model: "mock-gemini-live",
      firstAudioS: 1.1,
      firstAudioP50S: 1.1,
      turns: 2,
      verify: { ms: 38, source: "cache", level: "warning" },
      cache: { hits: 2, misses: 0 },
      features: ["scene", "datamatrix", "addmed", "sonar"],
      phone: true,
      hud: true,
      source: "glasses",
      fps: 1,
      frameKb: 36.2,
    },
    { type: "frame", data: FRAME_SENTINEL },
    { type: "audio", data: AUDIO_SENTINEL },
    { type: "transcript", role: "user", text: "Can I take this for my headache?", final: true },
    { type: "readiness", value: 0.64 },
    { type: "verdict", verdict: fixtures.warningDisagreeVerdict },
    { type: "transcript", role: "assistant", text: fixtures.warningDisagreeVerdict.speech, final: true },
  ]);

  await page.waitForFunction(() => (document.querySelector("[role='status']")?.textContent || "").includes("Mock phone"));
  await recordStageState("handoff_warning");

  await postStageBatch([
    { type: "transcript", role: "user", text: "What strength is this one?", final: true },
    { type: "readiness", value: 0.35 },
    { type: "verdict", verdict: fixtures.unsureVerdict },
    { type: "transcript", role: "assistant", text: fixtures.unsureVerdict.speech, final: true },
  ]);
  await page.waitForFunction(() => (document.querySelector(".stage-lens .hud-headline")?.textContent || "").includes("strength"));
  await recordStageState("handoff_unsure");

  await postStageBatch([
    { type: "transcript", role: "user", text: "Which one is my evening pill?", final: true },
    { type: "readiness", value: 0.88 },
    { type: "verdict", verdict: fixtures.sceneVerdict },
    { type: "transcript", role: "assistant", text: fixtures.sceneVerdict.speech, final: true },
  ]);
  await page.waitForSelector(".stage-lens .scene-card ol.hud-strip");
  await recordStageState("handoff_scene");

  await peerPage.evaluate(() => {
    const hudCh = new BroadcastChannel("holdup-hud-mock");
    hudCh.postMessage({ type: "hud_event", name: "dismiss" });
    hudCh.close();
  });
  await page.waitForSelector(".stage-lens .idle-card");
  const dismissMirrored = await page.evaluate(() => ({
    replicaClearedToIdle: Boolean(document.querySelector(".stage-lens .idle-card")),
    badgeKeptAfterDismiss: (document.querySelector(".stage-badge")?.textContent || "").includes("Scene: no pack code"),
  }));

  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-contrast", value: "more" }],
  });
  await postStageBatch([
    { type: "readiness", value: 0.91 },
    { type: "verdict", verdict: fixtures.matchVerdict },
  ]);
  await page.waitForFunction(() => document.querySelector(".stage-lens .hud-headline")?.textContent === "Amlodipine 5 mg");
  const contrastCheck = await page.evaluate(() => ({
    matches: matchMedia("(prefers-contrast: more)").matches,
    borderToken: getComputedStyle(document.documentElement).getPropertyValue("--border").trim().toLowerCase(),
  }));
  await recordStageState("prefers_contrast_more", {
    mediaMatches: contrastCheck.matches && (contrastCheck.borderToken === "#fff" || contrastCheck.borderToken === "#ffffff"),
  });

  await cdp.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  await postStageBatch([{ type: "checking", phase: "start" }]);
  await page.waitForSelector(".stage-spin");
  const reducedMotionCheck = await page.evaluate(() => {
    const spin = document.querySelector(".stage-spin");
    const fill = document.querySelector(".stage-meter-fill");
    return {
      matches: matchMedia("(prefers-reduced-motion: reduce)").matches,
      spinAnimationName: spin ? getComputedStyle(spin).animationName : "",
      meterTransitionDuration: fill ? getComputedStyle(fill).transitionDuration : "",
    };
  });
  await recordStageState("prefers_reduced_motion", {
    mediaMatches:
      reducedMotionCheck.matches &&
      reducedMotionCheck.spinAnimationName === "none" &&
      reducedMotionCheck.meterTransitionDuration === "0s",
  });

  await peerPage.close();
  await ctx.close();

  return {
    viewport: viewportLabel,
    consoleErrors: consoleErrors.length,
    handoffVerified:
      states.some((s) => s.driverBadge === "SCRIPTED (mock)" && s.statusText === "Scripted demo") &&
      states.some((s) => s.driverBadge === "MOCK" && s.statusText === "Mock phone") &&
      dismissMirrored.replicaClearedToIdle &&
      dismissMirrored.badgeKeptAfterDismiss,
    states,
  };
}

const tempLedgerPath = path.join(os.tmpdir(), `holdup-hud-stage-audit-${process.pid}.jsonl`);
const fixtures = makeFixtures();
const server = await startKeylessServer(tempLedgerPath);
const macExe = process.env.PLAYWRIGHT_BROWSERS_PATH ? undefined : findMacExecutable();
const browser = await chromium.launch({
  headless: true,
  args: SPATIAL_NAV_ARGS,
  ...(macExe ? { executablePath: macExe } : {}),
});

try {
  const hud = await auditHud(browser, server.base, fixtures);
  const stageViewports = await Promise.all(
    [
      [1024, 576],
      [1280, 720],
      [1920, 1080],
    ].map(([w, h]) => auditStageViewport(browser, server.base, fixtures, w, h)),
  );

  const allStageStates = stageViewports.flatMap((v) => v.states);
  const allAxeStates = [...hud.axeStates, ...allStageStates];
  const totalViolationNodes = allAxeStates.reduce((sum, s) => sum + s.violationNodes, 0);
  const totalOverflowStates = allAxeStates.filter((s) => s.horizontalOverflowPx > 0 || s.verticalOverflowPx > 0).length;
  const stageInteractiveTotal = allStageStates.reduce((sum, s) => sum + s.interactiveCount, 0);
  const stageMediaTotal = allStageStates.reduce((sum, s) => sum + s.mediaElementCount, 0);
  const stageLeakCount = allStageStates.filter((s) => s.frameOrAudioLeak || !s.readOnlyFooter).length;
  const stageInvalidAriaCount = allStageStates.filter((s) => !s.meterAriaValid || !s.statusAriaValid).length;

  const report = {
    tool: "axe-core via @axe-core/playwright + Chromium SpatialNavigation",
    tags: "WCAG 2.0/2.1/2.2 A+AA",
    when: new Date().toISOString(),
    serverMode: {
      portFlag: "PORT=0",
      keyless: server.health.gemini === "down",
      healthOk: server.health.ok,
    },
    browserArgs: SPATIAL_NAV_ARGS,
    summary: {
      totalAuditedStates: allAxeStates.length,
      hudAuditedStates: hud.axeStates.length,
      stageAuditedStates: allStageStates.length,
      totalViolationNodes,
      totalOverflowStates,
      hudSpatialNavPassRatePct: hud.spatialNav.passRatePct,
      hudSpatialNavAllPassed: hud.spatialNav.allPassed,
      stageViewportsTested: stageViewports.map((v) => v.viewport),
      stageInteractiveElements: stageInteractiveTotal,
      stageMediaElements: stageMediaTotal,
      stageLeakCount,
      stageInvalidAriaCount,
      stageBroadcastHandoffAllPassed: stageViewports.every((v) => v.handoffVerified),
    },
    hud,
    stage: {
      viewports: stageViewports,
    },
  };

  const serialized = JSON.stringify(report, null, 2) + "\n";
  const byteLength = Buffer.byteLength(serialized, "utf8");
  if (byteLength >= 60 * 1024) {
    throw new Error(`Evidence JSON exceeds 60 KB budget: ${byteLength} bytes`);
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, serialized, "utf8");

  if (
    totalViolationNodes !== 0 ||
    totalOverflowStates !== 0 ||
    !hud.spatialNav.allPassed ||
    stageInteractiveTotal !== 0 ||
    stageMediaTotal !== 0 ||
    stageLeakCount !== 0 ||
    stageInvalidAriaCount !== 0 ||
    !report.summary.stageBroadcastHandoffAllPassed
  ) {
    throw new Error("HUD spatial-nav or /stage axe audit failed: " + JSON.stringify(report.summary));
  }

  console.log(JSON.stringify({ out: "docs/evidence/hud-stage-a11y.json", bytes: byteLength, summary: report.summary }, null, 2));
} finally {
  await browser.close().catch(() => {});
  await server.stop().catch(() => {});
  fs.rmSync(tempLedgerPath, { force: true });
}
