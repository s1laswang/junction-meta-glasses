import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const HTTP_SCHEME = "http:\x2f\x2f";
const SHARED_PW_PATH = "/tmp/fleet-root/shared/ms-playwright";
const PIXEL_8_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync(SHARED_PW_PATH)) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = SHARED_PW_PATH;
}

const { chromium } = await import("playwright");

const EM_DASH_CHAR = String.fromCharCode(8212);
const EN_DASH_CHAR = String.fromCharCode(8211);

function cleanText(raw) {
  return String(raw ?? "")
    .replaceAll(EM_DASH_CHAR, "-")
    .replaceAll(EN_DASH_CHAR, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const raw = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return round1(raw);
}

function statsForHeights(items) {
  const heights = items.map((x) => x.heightPx);
  if (!heights.length) {
    return { count: 0, minHeightPx: 0, medianHeightPx: 0, maxHeightPx: 0 };
  }
  return {
    count: heights.length,
    minHeightPx: round1(Math.min(...heights)),
    medianHeightPx: median(heights),
    maxHeightPx: round1(Math.max(...heights)),
  };
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function waitForHealth(baseUrl, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for ${baseUrl}/api/health`);
}

function resolveMacChromeExecutable() {
  const cache = path.join(os.homedir(), "Library/Caches/ms-playwright");
  if (!fs.existsSync(cache)) return undefined;
  return fs
    .readdirSync(cache)
    .filter((d) => d.startsWith("chromium-"))
    .sort()
    .reverse()
    .map((d) => path.join(cache, d, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"))
    .find((p) => fs.existsSync(p));
}

const INTERACTIVE_AX_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "switch",
  "slider",
  "tab",
  "menuitem",
  "DisclosureTriangle",
]);

function axProp(node, propName) {
  const found = (node.properties ?? []).find((p) => p.name === propName);
  return found?.value?.value;
}

async function inspectJourney(page, cdp, journeyId, surface, options = {}) {
  const { nodes } = await cdp.send("Accessibility.getFullAXTree");
  const visibleNodes = nodes.filter((n) => !n.ignored);
  const interactiveNodes = visibleNodes.filter((n) => INTERACTIVE_AX_ROLES.has(n.role?.value));
  const unnamedNodes = interactiveNodes.filter((n) => !cleanText(n.name?.value));
  const headings = visibleNodes
    .filter((n) => n.role?.value === "heading")
    .map((n) => ({
      level: Number(axProp(n, "level") ?? 0),
      name: cleanText(n.name?.value),
    }));

  let headingOrderValid = headings.length > 0;
  let prevLevel = 0;
  for (const h of headings) {
    if (h.level < 1 || (prevLevel > 0 && h.level > prevLevel + 1)) {
      headingOrderValid = false;
    }
    prevLevel = h.level;
  }

  const dialogNodes = visibleNodes
    .filter((n) => n.role?.value === "dialog")
    .map((n) => ({
      name: cleanText(n.name?.value),
      modal: Boolean(axProp(n, "modal")),
    }));

  const ignoredModalNodesCount = nodes.filter(
    (n) => n.ignored && (n.ignoredReasons ?? []).some((r) => r.name === "activeModalDialog"),
  ).length;

  const domSnapshot = await page.evaluate(() => {
    const clean = (s) =>
      String(s ?? "")
        .replaceAll(String.fromCharCode(8212), "-")
        .replaceAll(String.fromCharCode(8211), "-")
        .replace(/\s+/g, " ")
        .trim();
    const activeEl = document.activeElement;
    const h1El = document.querySelector("h1");
    const openDialog = document.querySelector("dialog[open]");
    const scopeRoot = openDialog || document;
    const candidates = Array.from(scopeRoot.querySelectorAll("button, a, input, select, textarea, summary"));
    const controls = [];
    for (const el of candidates) {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      if (el.closest("[hidden]") || el.getAttribute("aria-hidden") === "true") continue;
      if (el.classList.contains("skip")) continue;
      const rawRect = el.getBoundingClientRect();
      if (rawRect.width <= 0 || rawRect.height <= 0) continue;
      const tag = el.tagName.toLowerCase();
      const inputType = (el.getAttribute("type") || "").toLowerCase();
      const labelWrap = tag === "input" && (inputType === "checkbox" || inputType === "radio") ? el.closest("label") : null;
      const hitRect = labelWrap ? labelWrap.getBoundingClientRect() : rawRect;
      const labelText =
        clean(el.getAttribute("aria-label")) ||
        clean(labelWrap ? labelWrap.textContent : "") ||
        (el.id ? clean(document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent) : "") ||
        clean(el.textContent) ||
        clean(el.getAttribute("placeholder")) ||
        el.id ||
        tag;
      const cls = clean(el.className);
      const inHudActs = Boolean(el.closest(".hud-acts"));
      const isHudSpeak = el.classList.contains("hud-speak");
      const isPrimaryButton =
        tag === "button" &&
        !isHudSpeak &&
        (inHudActs ||
          el.classList.contains("bigbtn") ||
          el.classList.contains("primary") ||
          Boolean(el.closest(".tabs")) ||
          Boolean(el.closest(".seg")) ||
          Boolean(el.closest(".onb .actions")) ||
          Boolean(el.closest("dialog")));
      controls.push({
        tag,
        type: inputType || undefined,
        role: el.getAttribute("role") || undefined,
        name: labelText.slice(0, 64),
        isButton: tag === "button",
        isPrimaryButton,
        widthPx: Math.round(hitRect.width * 10) / 10,
        heightPx: Math.round(hitRect.height * 10) / 10,
      });
    }
    return {
      title: clean(document.title),
      h1Text: clean(h1El?.textContent),
      h1TabIndex: h1El ? h1El.getAttribute("tabindex") : null,
      activeTag: activeEl ? activeEl.tagName.toLowerCase() : null,
      activeId: activeEl?.id || null,
      activeTabIndex: activeEl ? activeEl.getAttribute("tabindex") : null,
      activeText: clean(activeEl?.textContent).slice(0, 64),
      modalOpen: openDialog ? openDialog.matches(":modal") : false,
      controls,
    };
  });

  const primaryButtons = domSnapshot.controls.filter((c) => c.isPrimaryButton);
  const allButtons = domSnapshot.controls.filter((c) => c.isButton);
  const sub48Controls = domSnapshot.controls
    .filter((c) => c.heightPx < 48)
    .map((c) => ({
      journey: journeyId,
      surface,
      tag: c.tag,
      type: c.type ?? null,
      name: c.name,
      widthPx: c.widthPx,
      heightPx: c.heightPx,
    }));

  const primaryAllMeet48 = primaryButtons.every((b) => b.heightPx >= 48);
  const expectedTitleOk = options.expectedTitle ? domSnapshot.title === options.expectedTitle : true;
  const expectedFocusOk = options.expectH1Focused
    ? domSnapshot.activeTag === "h1" && domSnapshot.activeTabIndex === "-1"
    : true;
  const h1FocusableOk = options.isModal ? dialogNodes.length > 0 : domSnapshot.h1TabIndex === "-1" || surface === "hud";

  const passed =
    unnamedNodes.length === 0 &&
    headingOrderValid &&
    primaryAllMeet48 &&
    expectedTitleOk &&
    expectedFocusOk &&
    h1FocusableOk;

  return {
    id: `axtree-${journeyId}`,
    category: "axtree_and_touch_targets",
    journey: journeyId,
    surface,
    passed,
    title: domSnapshot.title,
    h1Text: domSnapshot.h1Text,
    h1TabIndex: domSnapshot.h1TabIndex,
    activeFocus: {
      tag: domSnapshot.activeTag,
      id: domSnapshot.activeId,
      tabIndex: domSnapshot.activeTabIndex,
      text: domSnapshot.activeText,
    },
    axNodeCount: nodes.length,
    visibleAxNodeCount: visibleNodes.length,
    interactiveAxNodeCount: interactiveNodes.length,
    unnamedInteractiveCount: unnamedNodes.length,
    headings,
    headingOrderValid,
    readingOrderControls: interactiveNodes.map((n) => `${n.role?.value}: ${cleanText(n.name?.value)}`),
    dialogNodes,
    ignoredBackgroundAxNodes: ignoredModalNodesCount,
    modalOpen: domSnapshot.modalOpen,
    touchTargets: {
      allInteractive: statsForHeights(domSnapshot.controls),
      primaryButtons: {
        ...statsForHeights(primaryButtons),
        allMeet48px: primaryAllMeet48,
      },
      allButtons: {
        ...statsForHeights(allButtons),
        allMeet48px: allButtons.every((b) => b.heightPx >= 48),
      },
      sub48pxControls: sub48Controls,
    },
    controlsRaw: domSnapshot.controls,
  };
}

let serverProc = null;
let baseUrl = process.argv[2] ?? "";

try {
  if (!baseUrl) {
    const distIndex = path.join(REPO_ROOT, "web", "dist", "index.html");
    if (!fs.existsSync(distIndex)) {
      const buildRes = spawnSync("npm", ["run", "build"], {
        cwd: REPO_ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
      if (buildRes.status !== 0) {
        throw new Error(`npm run build failed with code ${buildRes.status}`);
      }
    }
    const port = await getFreePort();
    baseUrl = `${HTTP_SCHEME}127.0.0.1:${port}`;
    serverProc = spawn("tsx", ["server/src/index.ts"], {
      cwd: REPO_ROOT,
      env: { ...process.env, PORT: String(port), GEMINI_API_KEY: "" },
      stdio: ["ignore", "ignore", "ignore"],
    });
    await waitForHealth(baseUrl);
  }

  const macExe = resolveMacChromeExecutable();
  const browser = await chromium.launch({
    headless: true,
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    ...(macExe ? { executablePath: macExe } : {}),
  });

  const browserVersion = browser.version();
  const journeyChecks = [];
  const focusChecks = [];
  const liveRegionChecks = [];
  const hudChecks = [];

  try {
    const phoneCtx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      userAgent: PIXEL_8_UA,
    });

    await phoneCtx.addInitScript(() => {
      window.__srMutations = [];
      const attach = () => {
        if (window.__srObserverReady || !document.documentElement) return;
        window.__srObserverReady = true;
        const classify = (node) => {
          const el = node && node.nodeType === 1 ? node : node?.parentElement;
          if (!el || !el.closest) return null;
          const polite = el.closest('#sr-polite, [role="status"][aria-live="polite"]');
          if (polite) return { region: "polite", el: polite };
          const assertive = el.closest('#sr-assertive, [role="alert"][aria-live="assertive"]');
          if (assertive) return { region: "assertive", el: assertive };
          return null;
        };
        const obs = new MutationObserver((records) => {
          const touched = new Map();
          for (const rec of records) {
            const hit = classify(rec.target);
            if (hit) touched.set(hit.region, hit.el);
            for (const added of rec.addedNodes) {
              const addedHit = classify(added);
              if (addedHit) touched.set(addedHit.region, addedHit.el);
            }
          }
          for (const [region, el] of touched.entries()) {
            const text = (el.textContent || "").replace(/\s+/g, " ").trim();
            window.__srMutations.push({ region, text, ts: Math.round(performance.now()) });
          }
        });
        obs.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
      };
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", attach, { once: true });
      } else {
        attach();
      }
    });

    const phone = await phoneCtx.newPage();
    const phoneCdp = await phoneCtx.newCDPSession(phone);
    await phoneCdp.send("Accessibility.enable");

    await phone.goto(`${baseUrl}/?mock=1`, { waitUntil: "networkidle" });
    journeyChecks.push(
      await inspectJourney(phone, phoneCdp, "onboarding-welcome", "phone", {
        expectedTitle: "HoldUp",
        expectH1Focused: true,
      }),
    );

    await phone.getByRole("button", { name: "Continue" }).click();
    journeyChecks.push(
      await inspectJourney(phone, phoneCdp, "onboarding-consent-1", "phone", {
        expectedTitle: "HoldUp",
        expectH1Focused: true,
      }),
    );

    await phone.getByRole("button", { name: "Next" }).click();
    journeyChecks.push(
      await inspectJourney(phone, phoneCdp, "onboarding-consent-2", "phone", {
        expectedTitle: "HoldUp",
        expectH1Focused: true,
      }),
    );

    await phone.getByRole("button", { name: "Next" }).click();
    journeyChecks.push(
      await inspectJourney(phone, phoneCdp, "onboarding-consent-3", "phone", {
        expectedTitle: "HoldUp",
        expectH1Focused: true,
      }),
    );

    await phone.getByRole("button", { name: "I agree" }).click();
    journeyChecks.push(
      await inspectJourney(phone, phoneCdp, "onboarding-permission-step", "phone", {
        expectedTitle: "HoldUp",
        expectH1Focused: true,
      }),
    );

    await phone.getByRole("button", { name: "Not now" }).click();
    journeyChecks.push(
      await inspectJourney(phone, phoneCdp, "onboarding-permission-recovery", "phone", {
        expectedTitle: "HoldUp",
        expectH1Focused: true,
      }),
    );

    await phoneCtx.grantPermissions(["camera", "microphone"], { origin: baseUrl });
    await phone.getByRole("button", { name: /Continue without/i }).click();
    journeyChecks.push(
      await inspectJourney(phone, phoneCdp, "check-idle", "phone", {
        expectedTitle: "Check \u00b7 HoldUp",
        expectH1Focused: true,
      }),
    );

    await phone.locator("#ask").fill("Is this my evening pill?");
    await phone.getByRole("button", { name: "Ask" }).click();
    await phone.waitForFunction(
      () => {
        const cue = document.querySelector(".cue:not(.idle) .text");
        return Boolean(cue && cue.textContent && cue.textContent.trim().length > 0);
      },
      undefined,
      { timeout: 8000 },
    );
    journeyChecks.push(
      await inspectJourney(phone, phoneCdp, "check-coaching", "phone", {
        expectedTitle: "Check \u00b7 HoldUp",
      }),
    );

    await phone.waitForFunction(
      () => {
        const h = document.querySelector("#verdict-h");
        return Boolean(h && /Amlodipine/i.test(h.textContent || ""));
      },
      undefined,
      { timeout: 18000 },
    );
    const matchCheck = await inspectJourney(phone, phoneCdp, "check-verdict-match", "phone", {
      expectedTitle: "Check \u00b7 HoldUp",
    });
    journeyChecks.push(matchCheck);
    focusChecks.push({
      id: "focus-handoff-verdict-match",
      category: "focus_handoff_and_modal_trap",
      journey: "check-verdict-match",
      passed:
        matchCheck.activeFocus.id === "verdict-h" &&
        matchCheck.activeFocus.tag === "h2" &&
        matchCheck.activeFocus.tabIndex === "-1",
      activeElement: matchCheck.activeFocus,
    });

    await phone.locator("#ask").fill("Can I take ibuprofen for pain?");
    await phone.getByRole("button", { name: "Ask" }).click();
    await phone.waitForFunction(
      () => {
        const h = document.querySelector("#verdict-h");
        return Boolean(h && /Ibuprofen/i.test(h.textContent || ""));
      },
      undefined,
      { timeout: 18000 },
    );
    const warningCheck = await inspectJourney(phone, phoneCdp, "check-verdict-warning", "phone", {
      expectedTitle: "Check \u00b7 HoldUp",
    });
    journeyChecks.push(warningCheck);
    focusChecks.push({
      id: "focus-handoff-verdict-warning",
      category: "focus_handoff_and_modal_trap",
      journey: "check-verdict-warning",
      passed:
        warningCheck.activeFocus.id === "verdict-h" &&
        warningCheck.activeFocus.tag === "h2" &&
        warningCheck.activeFocus.tabIndex === "-1",
      activeElement: warningCheck.activeFocus,
    });

    await phone.locator("#ask").fill("What strength is this metformin?");
    await phone.getByRole("button", { name: "Ask" }).click();
    await phone.waitForFunction(
      () => {
        const h = document.querySelector("#verdict-h");
        return Boolean(h && /strength/i.test(h.textContent || ""));
      },
      undefined,
      { timeout: 18000 },
    );
    const unsureCheck = await inspectJourney(phone, phoneCdp, "check-verdict-unsure", "phone", {
      expectedTitle: "Check \u00b7 HoldUp",
    });
    journeyChecks.push(unsureCheck);
    focusChecks.push({
      id: "focus-handoff-verdict-unsure",
      category: "focus_handoff_and_modal_trap",
      journey: "check-verdict-unsure",
      passed:
        unsureCheck.activeFocus.id === "verdict-h" &&
        unsureCheck.activeFocus.tag === "h2" &&
        unsureCheck.activeFocus.tabIndex === "-1",
      activeElement: unsureCheck.activeFocus,
    });

    await phone.locator("#ask").fill("Which one on the table is my evening pill?");
    await phone.getByRole("button", { name: "Ask" }).click();
    await phone.waitForSelector("ol.scene", { timeout: 16000 });
    const sceneDomInfo = await phone.evaluate(() => {
      const items = Array.from(document.querySelectorAll("ol.scene > li.scene-item"));
      const currentCount = items.filter((li) => li.getAttribute("aria-current") === "true").length;
      const overlayBoxes = document.querySelectorAll(".viewfinder .scene-box");
      const overlayHidden = overlayBoxes.length > 0 && Array.from(overlayBoxes).every((b) => Boolean(b.closest('[aria-hidden="true"]')));
      return { itemCount: items.length, currentCount, overlayBoxCount: overlayBoxes.length, overlayHidden };
    });
    const sceneCheck = await inspectJourney(phone, phoneCdp, "check-verdict-scene", "phone", {
      expectedTitle: "Check \u00b7 HoldUp",
    });
    sceneCheck.sceneDetails = sceneDomInfo;
    sceneCheck.passed =
      sceneCheck.passed &&
      sceneDomInfo.itemCount === 3 &&
      sceneDomInfo.currentCount === 1 &&
      sceneDomInfo.overlayHidden;
    journeyChecks.push(sceneCheck);
    focusChecks.push({
      id: "focus-handoff-verdict-scene",
      category: "focus_handoff_and_modal_trap",
      journey: "check-verdict-scene",
      passed:
        sceneCheck.activeFocus.id === "verdict-h" &&
        sceneCheck.activeFocus.tag === "h2" &&
        sceneCheck.activeFocus.tabIndex === "-1",
      activeElement: sceneCheck.activeFocus,
    });

    await phone.locator("#ask").fill("I want to add my medicines");
    await phone.getByRole("button", { name: "Ask" }).click();
    await phone.waitForSelector("dialog.addsheet[open]", { timeout: 10000 });
    const addSheetCheck = await inspectJourney(phone, phoneCdp, "check-addsheet-modal", "phone", {
      expectedTitle: "Check \u00b7 HoldUp",
      isModal: true,
    });
    journeyChecks.push(addSheetCheck);

    await phone.evaluate(() => {
      window.__srMutations = [];
    });
    await phone.keyboard.press("Escape");
    await phone.waitForTimeout(160);
    const addSheetAfterEsc = await phone.evaluate(() => ({
      openCount: document.querySelectorAll("dialog.addsheet[open]").length,
      mutations: window.__srMutations.slice(),
    }));
    const addSheetEscAssertive = addSheetAfterEsc.mutations.filter((m) => m.region === "assertive" && m.text.length > 0);
    const addSheetOutsideLeaked = addSheetCheck.readingOrderControls.some(
      (c) => c === "button: Profile" || c === "button: Privacy" || c === "button: Stop",
    );
    focusChecks.push({
      id: "modal-trap-and-escape-addsheet",
      category: "focus_handoff_and_modal_trap",
      journey: "check-addsheet-modal",
      passed:
        addSheetCheck.modalOpen === true &&
        addSheetCheck.dialogNodes.some((d) => d.modal === true) &&
        addSheetCheck.activeFocus.tag === "button" &&
        addSheetCheck.activeFocus.text === "Add" &&
        addSheetCheck.ignoredBackgroundAxNodes > 0 &&
        !addSheetOutsideLeaked &&
        addSheetAfterEsc.openCount === 0 &&
        addSheetEscAssertive.some((m) => m.text === "Not added."),
      modalOpen: addSheetCheck.modalOpen,
      initialFocus: addSheetCheck.activeFocus,
      ignoredBackgroundAxNodes: addSheetCheck.ignoredBackgroundAxNodes,
      outsideControlsExposedInAxTree: addSheetOutsideLeaked,
      closedOnEscape: addSheetAfterEsc.openCount === 0,
      escapeAnnouncement: addSheetEscAssertive.map((m) => m.text),
    });

    const stopBtn = phone.locator("button.bigbtn.stop");
    if (await stopBtn.count()) {
      await stopBtn.click();
      await phone.waitForTimeout(120);
    }

    await phone.locator('nav[aria-label="Main"]').getByRole("button", { name: "Profile" }).click();
    await phone.waitForTimeout(80);
    const profileHeadingFocus = await phone.evaluate(() => ({
      title: document.title.replaceAll(String.fromCharCode(8212), "-").replaceAll(String.fromCharCode(8211), "-"),
      activeTag: document.activeElement?.tagName.toLowerCase() ?? null,
      activeTabIndex: document.activeElement?.getAttribute("tabindex") ?? null,
      activeText: (document.activeElement?.textContent || "").trim(),
    }));

    phone.once("dialog", (d) => d.accept());
    await phone.getByRole("button", { name: "Load demo profile" }).click();
    await phone.waitForTimeout(140);

    const profileCheck = await inspectJourney(phone, phoneCdp, "profile", "phone", {
      expectedTitle: "Profile \u00b7 HoldUp",
    });
    profileCheck.initialScreenTransitionFocus = profileHeadingFocus;
    profileCheck.passed =
      profileCheck.passed &&
      profileHeadingFocus.title === "Profile \u00b7 HoldUp" &&
      profileHeadingFocus.activeTag === "h1" &&
      profileHeadingFocus.activeTabIndex === "-1";
    journeyChecks.push(profileCheck);

    await phone.getByRole("button", { name: /Edit Amlodipine/i }).click();
    await phone.waitForSelector("dialog[open]", { timeout: 4000 });
    const medEditorCheck = await inspectJourney(phone, phoneCdp, "profile-mededitor-modal", "phone", {
      expectedTitle: "Profile \u00b7 HoldUp",
      isModal: true,
    });
    journeyChecks.push(medEditorCheck);

    await phone.keyboard.press("Escape");
    await phone.waitForTimeout(100);
    const medEditorClosed = (await phone.locator("dialog[open]").count()) === 0;
    const medEditorOutsideLeaked = medEditorCheck.readingOrderControls.some(
      (c) => c === "button: Profile" || c === "button: Privacy" || c === "button: Add medicine",
    );
    focusChecks.push({
      id: "modal-trap-and-escape-mededitor",
      category: "focus_handoff_and_modal_trap",
      journey: "profile-mededitor-modal",
      passed:
        medEditorCheck.modalOpen === true &&
        medEditorCheck.dialogNodes.some((d) => d.modal === true) &&
        medEditorCheck.ignoredBackgroundAxNodes > 0 &&
        !medEditorOutsideLeaked &&
        medEditorClosed,
      modalOpen: medEditorCheck.modalOpen,
      ignoredBackgroundAxNodes: medEditorCheck.ignoredBackgroundAxNodes,
      outsideControlsExposedInAxTree: medEditorOutsideLeaked,
      closedOnEscape: medEditorClosed,
    });

    await phone.locator('nav[aria-label="Main"]').getByRole("button", { name: "Privacy" }).click();
    await phone.waitForTimeout(100);
    const privacyCheck = await inspectJourney(phone, phoneCdp, "privacy", "phone", {
      expectedTitle: "Privacy \u00b7 HoldUp",
      expectH1Focused: true,
    });
    journeyChecks.push(privacyCheck);

    async function measureAnnouncement(id, actionLabel, expectedRegion, expectedText, triggerFn) {
      await phone.evaluate(() => {
        window.__srMutations = [];
      });
      await triggerFn();
      await phone.waitForTimeout(180);
      const result = await phone.evaluate((region) => {
        const sel = region === "assertive" ? '#sr-assertive, [role="alert"][aria-live="assertive"]' : '#sr-polite, [role="status"][aria-live="polite"]';
        const el = document.querySelector(sel);
        const finalText = (el?.textContent || "").replace(/\s+/g, " ").trim();
        return {
          mutations: window.__srMutations.slice(),
          finalText,
        };
      }, expectedRegion);
      const nonEmpty = result.mutations.filter((m) => m.text.length > 0);
      const passed =
        nonEmpty.length === 1 &&
        nonEmpty[0].region === expectedRegion &&
        nonEmpty[0].text === expectedText &&
        result.finalText === expectedText;
      liveRegionChecks.push({
        id,
        category: "live_region_single_announcement",
        action: actionLabel,
        expectedRegion,
        expectedText,
        nonEmptyMutationCount: nonEmpty.length,
        observedMessages: nonEmpty.map((m) => `${m.region}: ${m.text}`),
        finalRegionText: result.finalText,
        emptyOrDuplicateClobber: nonEmpty.length !== 1 || result.finalText !== expectedText,
        passed,
      });
    }

    const quietSwitch = phone.getByRole("switch", { name: /Quiet mode/i });
    await measureAnnouncement("live-quiet-on", "Toggle Quiet mode on", "polite", "Quiet mode on.", () => quietSwitch.click());
    await measureAnnouncement("live-quiet-off", "Toggle Quiet mode off", "polite", "Quiet mode off.", () => quietSwitch.click());

    const voiceSwitch = phone.getByRole("switch", { name: /Spoken answers/i });
    await measureAnnouncement("live-voice-off", "Toggle Spoken answers off", "polite", "Spoken answers off.", () => voiceSwitch.click());
    await measureAnnouncement("live-voice-on", "Toggle Spoken answers on", "polite", "Spoken answers on.", () => voiceSwitch.click());

    const earconsSwitch = phone.getByRole("switch", { name: /Sounds \(earcons\)/i });
    await measureAnnouncement("live-sounds-off", "Toggle Sounds (earcons) off", "polite", "Sounds (earcons) off.", () => earconsSwitch.click());
    await measureAnnouncement("live-sounds-on", "Toggle Sounds (earcons) on", "polite", "Sounds (earcons) on.", () => earconsSwitch.click());

    const vibrationSwitch = phone.getByRole("switch", { name: /Vibration/i });
    await measureAnnouncement("live-vibration-off", "Toggle Vibration off", "polite", "Vibration off.", () => vibrationSwitch.click());
    await measureAnnouncement("live-vibration-on", "Toggle Vibration on", "polite", "Vibration on.", () => vibrationSwitch.click());

    await measureAnnouncement(
      "live-withdraw-consent",
      "Withdraw consent",
      "assertive",
      "Consent withdrawn. The camera will stay off.",
      () => phone.getByRole("button", { name: "Withdraw consent" }).click(),
    );

    await measureAnnouncement(
      "live-delete-all-data",
      "Delete all my data",
      "assertive",
      "All your HoldUp data has been deleted from this phone.",
      async () => {
        phone.once("dialog", (d) => d.accept());
        await phone.getByRole("button", { name: "Delete all my data" }).click();
      },
    );

    const remainingHoldupKeys = await phone.evaluate(() =>
      Object.keys(localStorage).filter((k) => k.startsWith("holdup.")),
    );
    liveRegionChecks.push({
      id: "privacy-zero-leak-storage-after-delete",
      category: "live_region_single_announcement",
      action: "Verify zero holdup.* localStorage keys after Delete all my data",
      remainingHoldupKeysCount: remainingHoldupKeys.length,
      passed: remainingHoldupKeys.length === 0,
    });

    await phoneCtx.close();

    const keyCtx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      userAgent: PIXEL_8_UA,
      serviceWorkers: "block",
    });
    await keyCtx.route(
      (url) => url.pathname === "/api/stats",
      (route) =>
        route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({ type: "error", code: "unauthorized", message: "access key required" }),
        }),
    );
    const keyPage = await keyCtx.newPage();
    const keyCdp = await keyCtx.newCDPSession(keyPage);
    await keyCdp.send("Accessibility.enable");
    await keyPage.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
    await keyPage.waitForFunction(
      () => {
        const h1 = document.querySelector("h1");
        return Boolean(h1 && /Access key needed/i.test(h1.textContent || ""));
      },
      undefined,
      { timeout: 8000 },
    );
    journeyChecks.push(
      await inspectJourney(keyPage, keyCdp, "access-key-401", "phone", {
        expectedTitle: "HoldUp",
        expectH1Focused: true,
      }),
    );
    await keyCtx.close();

    const hudCtx = await browser.newContext({
      viewport: { width: 600, height: 600 },
    });

    await hudCtx.addInitScript(() => {
      window.__hudSpeech = { cancels: 0, spoken: [] };
      window.__hudLiveMutations = [];
      if (typeof window.SpeechSynthesisUtterance === "undefined") {
        window.SpeechSynthesisUtterance = class SpeechSynthesisUtterance {
          constructor(text) {
            this.text = String(text ?? "");
            this.lang = "";
          }
        };
      }
      const origSynth = window.speechSynthesis;
      const origCancel = origSynth && typeof origSynth.cancel === "function" ? origSynth.cancel.bind(origSynth) : null;
      const origSpeak = origSynth && typeof origSynth.speak === "function" ? origSynth.speak.bind(origSynth) : null;
      const synthShim = {
        cancel() {
          window.__hudSpeech.cancels += 1;
          try {
            if (origCancel) origCancel();
          } catch {}
        },
        speak(utterance) {
          window.__hudSpeech.spoken.push({
            text: String(utterance?.text ?? ""),
            lang: String(utterance?.lang ?? ""),
          });
          try {
            if (origSpeak) origSpeak(utterance);
          } catch {}
        },
      };
      Object.defineProperty(window, "speechSynthesis", {
        value: synthShim,
        configurable: true,
        writable: true,
      });

      const attachHudObserver = () => {
        if (window.__hudObsReady || !document.documentElement) return;
        window.__hudObsReady = true;
        const obs = new MutationObserver(() => {
          const liveEl = document.querySelector("#live, .hud-live, [aria-live]");
          if (!liveEl) return;
          const text = (liveEl.textContent || "").replace(/\s+/g, " ").trim();
          const prev = window.__hudLiveMutations[window.__hudLiveMutations.length - 1];
          if (text && text !== prev) window.__hudLiveMutations.push(text);
        });
        obs.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
      };
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", attachHudObserver, { once: true });
      } else {
        attachHudObserver();
      }
    });

    const hud = await hudCtx.newPage();
    const hudCdp = await hudCtx.newCDPSession(hud);
    await hudCdp.send("Accessibility.enable");

    await hud.goto(`${baseUrl}/hud/?mock=1`, { waitUntil: "networkidle" });
    await hud.waitForSelector(".verdict-card", { timeout: 8000 });

    await hud.evaluate(() => {
      const ch = new BroadcastChannel("holdup-hud-mock");
      ch.postMessage({ type: "status", live: "open" });
      ch.close();
    });
    await hud.waitForTimeout(80);

    const hudVerdictCheck = await inspectJourney(hud, hudCdp, "hud-verdict", "hud", {
      expectedTitle: "HoldUp",
    });
    journeyChecks.push(hudVerdictCheck);

    const initialHudFocus = hudVerdictCheck.activeFocus.text;
    await hud.keyboard.press("Tab");
    const afterFirstTab = await hud.evaluate(() => (document.activeElement?.textContent || "").trim());
    await hud.keyboard.press("Tab");
    const afterSecondTab = await hud.evaluate(() => (document.activeElement?.textContent || "").trim());

    await hud.keyboard.press("Enter");
    await hud.waitForTimeout(60);
    const speakAfterEnterOn = await hud.evaluate(() => {
      const btn = document.querySelector(".hud-speak");
      return {
        pressed: btn?.getAttribute("aria-pressed"),
        text: (btn?.textContent || "").trim(),
      };
    });

    await hud.evaluate(() => {
      const ch = new BroadcastChannel("holdup-hud-mock");
      ch.postMessage({
        type: "verdict",
        verdict: {
          level: "match",
          headline: "Amlodipine 5 mg",
          speech: "Yes, Amlodipine 5 mg, your evening pill.",
          matchedMedId: "amlodipine",
          takenToday: false,
          reasons: ["Matches your list"],
          read: {
            kind: "medication",
            product: { value: "Amlodipine", confidence: 0.97 },
            ingredient: { value: "amlodipine", confidence: 0.95 },
            strength: { value: "5 mg", confidence: 0.96 },
            dosing: { value: null, confidence: 0 },
            expiry: { value: null, confidence: 0 },
            allergens: { value: null, confidence: 0 },
            barcode: { value: null, confidence: 0 },
            warnings: [],
            readability: 0.94,
          },
        },
      });
      ch.close();
    });
    await hud.waitForTimeout(80);

    const cancelsBeforeSpeakOff = await hud.evaluate(() => window.__hudSpeech.cancels);
    await hud.locator(".hud-speak").focus();
    await hud.keyboard.press("Enter");
    await hud.waitForTimeout(60);
    const afterSpeakOff = await hud.evaluate(() => {
      const btn = document.querySelector(".hud-speak");
      return {
        pressed: btn?.getAttribute("aria-pressed"),
        text: (btn?.textContent || "").trim(),
        cancels: window.__hudSpeech.cancels,
        spokenCount: window.__hudSpeech.spoken.length,
      };
    });

    await hud.keyboard.press("Enter");
    await hud.waitForTimeout(60);
    await hud.evaluate(() => {
      const ch = new BroadcastChannel("holdup-hud-mock");
      ch.postMessage({
        type: "verdict",
        verdict: {
          level: "warning",
          headline: "Ibuprofen 400 mg",
          speech: "Warning. Ibuprofen is an NSAID.",
          reasons: ["Avoid NSAIDs"],
          read: {
            kind: "medication",
            product: { value: "Ibuprofen", confidence: 0.97 },
            ingredient: { value: "ibuprofen", confidence: 0.95 },
            strength: { value: "400 mg", confidence: 0.96 },
            dosing: { value: null, confidence: 0 },
            expiry: { value: null, confidence: 0 },
            allergens: { value: null, confidence: 0 },
            barcode: { value: null, confidence: 0 },
            warnings: [],
            readability: 0.93,
          },
        },
      });
      ch.close();
    });
    await hud.waitForSelector(".verdict-card", { timeout: 4000 });
    const cancelsBeforeEscape = await hud.evaluate(() => window.__hudSpeech.cancels);
    await hud.keyboard.press("Escape");
    await hud.waitForTimeout(80);
    const afterEscape = await hud.evaluate(() => ({
      idleVisible: Boolean(document.querySelector(".idle-card")),
      verdictVisible: Boolean(document.querySelector(".verdict-card")),
      cancels: window.__hudSpeech.cancels,
    }));

    await hud.evaluate(() => {
      const ch = new BroadcastChannel("holdup-hud-mock");
      ch.postMessage({
        type: "verdict",
        verdict: {
          level: "match",
          mode: "scene",
          headline: "Middle is your evening pill",
          speech: "Three boxes. Middle is Amlodipine 5 mg.",
          matchedMedId: "amlodipine",
          reasons: [],
          items: [
            {
              position: "left",
              level: "warning",
              headline: "Ibuprofen 400 mg",
              read: {
                kind: "medication",
                product: { value: "Ibuprofen", confidence: 0.95 },
                ingredient: { value: "ibuprofen", confidence: 0.95 },
                strength: { value: "400 mg", confidence: 0.95 },
                dosing: { value: null, confidence: 0 },
                expiry: { value: null, confidence: 0 },
                allergens: { value: null, confidence: 0 },
                barcode: { value: null, confidence: 0 },
                warnings: [],
                readability: 0.9,
              },
            },
            {
              position: "center",
              level: "match",
              headline: "Amlodipine 5 mg",
              matchedMedId: "amlodipine",
              read: {
                kind: "medication",
                product: { value: "Amlodipine", confidence: 0.97 },
                ingredient: { value: "amlodipine", confidence: 0.96 },
                strength: { value: "5 mg", confidence: 0.96 },
                dosing: { value: null, confidence: 0 },
                expiry: { value: null, confidence: 0 },
                allergens: { value: null, confidence: 0 },
                barcode: { value: null, confidence: 0 },
                warnings: [],
                readability: 0.95,
              },
            },
            {
              position: "right",
              level: "unsure",
              headline: "Strength unreadable",
              read: {
                kind: "medication",
                product: { value: "Metformin", confidence: 0.88 },
                ingredient: { value: "metformin", confidence: 0.85 },
                strength: { value: null, confidence: 0.42 },
                dosing: { value: null, confidence: 0 },
                expiry: { value: null, confidence: 0 },
                allergens: { value: null, confidence: 0 },
                barcode: { value: null, confidence: 0 },
                warnings: [],
                readability: 0.55,
              },
            },
          ],
          read: {
            kind: "medication",
            product: { value: "Amlodipine", confidence: 0.97 },
            ingredient: { value: "amlodipine", confidence: 0.96 },
            strength: { value: "5 mg", confidence: 0.96 },
            dosing: { value: null, confidence: 0 },
            expiry: { value: null, confidence: 0 },
            allergens: { value: null, confidence: 0 },
            barcode: { value: null, confidence: 0 },
            warnings: [],
            readability: 0.95,
          },
        },
      });
      ch.close();
    });
    await hud.waitForSelector(".scene-card", { timeout: 4000 });
    const hudSceneCheck = await inspectJourney(hud, hudCdp, "hud-scene", "hud", {
      expectedTitle: "HoldUp",
    });
    journeyChecks.push(hudSceneCheck);

    const cancelsBeforeDismissEnter = await hud.evaluate(() => window.__hudSpeech.cancels);
    await hud.getByRole("button", { name: "Dismiss" }).focus();
    await hud.keyboard.press("Enter");
    await hud.waitForTimeout(80);
    const afterDismissEnter = await hud.evaluate(() => ({
      idleVisible: Boolean(document.querySelector(".idle-card")),
      cancels: window.__hudSpeech.cancels,
      liveMutations: window.__hudLiveMutations.slice(),
    }));

    const cancelOnSpeakOff = afterSpeakOff.cancels > cancelsBeforeSpeakOff;
    const cancelOnEscape = afterEscape.cancels > cancelsBeforeEscape;
    const cancelOnDismissEnter = afterDismissEnter.cancels > cancelsBeforeDismissEnter;

    hudChecks.push({
      id: "hud-neural-band-and-bystander-speech",
      category: "hud_neural_band_and_bystander_privacy",
      journey: "hud-verdict",
      passed:
        initialHudFocus === "I took it" &&
        afterFirstTab === "Dismiss" &&
        afterSecondTab === "Speak off" &&
        speakAfterEnterOn.pressed === "true" &&
        afterSpeakOff.pressed === "false" &&
        afterSpeakOff.spokenCount >= 1 &&
        cancelOnSpeakOff &&
        afterEscape.idleVisible &&
        !afterEscape.verdictVisible &&
        cancelOnEscape &&
        afterDismissEnter.idleVisible &&
        cancelOnDismissEnter &&
        afterDismissEnter.liveMutations.length >= 2,
      initialVerdictFocus: initialHudFocus,
      tabOrderFromAction: [initialHudFocus, afterFirstTab, afterSecondTab],
      enterTogglesSpeakOn: speakAfterEnterOn.pressed === "true",
      spokenUtterancesRecorded: afterSpeakOff.spokenCount,
      cancelOnSpeakOff,
      dismissedOnEscape: afterEscape.idleVisible && !afterEscape.verdictVisible,
      cancelOnEscape,
      dismissedOnEnter: afterDismissEnter.idleVisible,
      cancelOnDismissEnter,
      hudLiveRegionUpdatesObserved: afterDismissEnter.liveMutations.length,
    });

    await hudCtx.close();
  } finally {
    await browser.close();
  }

  const phoneJourneys = journeyChecks.filter((j) => j.surface === "phone");
  const hudJourneys = journeyChecks.filter((j) => j.surface === "hud");

  const phoneAllControls = phoneJourneys.flatMap((j) => j.controlsRaw);
  const phonePrimaryButtons = phoneAllControls.filter((c) => c.isPrimaryButton);
  const phoneAllButtons = phoneAllControls.filter((c) => c.isButton);

  const hudAllControls = hudJourneys.flatMap((j) => j.controlsRaw);
  const hudPrimaryButtons = hudAllControls.filter((c) => c.isPrimaryButton);

  const sub48Dedupe = new Map();
  for (const j of journeyChecks) {
    for (const item of j.touchTargets.sub48pxControls) {
      const key = `${item.surface}|${item.tag}|${item.type ?? ""}|${item.name}|${item.heightPx}`;
      if (!sub48Dedupe.has(key)) sub48Dedupe.set(key, item);
    }
  }

  const strippedJourneys = journeyChecks.map(({ controlsRaw, ...rest }) => rest);
  const allChecks = [...strippedJourneys, ...focusChecks, ...liveRegionChecks, ...hudChecks];
  const passedChecks = allChecks.filter((c) => c.passed).length;
  const failedChecks = allChecks.length - passedChecks;
  const totalUnnamed = strippedJourneys.reduce((acc, j) => acc + j.unnamedInteractiveCount, 0);
  const totalInteractiveAx = strippedJourneys.reduce((acc, j) => acc + j.interactiveAxNodeCount, 0);
  const totalAxNodes = strippedJourneys.reduce((acc, j) => acc + j.axNodeCount, 0);

  const summary = {
    journeysAudited: strippedJourneys.length,
    phoneJourneysAudited: phoneJourneys.length,
    hudJourneysAudited: hudJourneys.length,
    totalChecks: allChecks.length,
    passedChecks,
    failedChecks,
    totalAxNodesInspected: totalAxNodes,
    totalInteractiveAxNodes: totalInteractiveAx,
    unnamedInteractiveAxNodes: totalUnnamed,
    titleTransitionsVerified: ["HoldUp", "Check \u00b7 HoldUp", "Profile \u00b7 HoldUp", "Privacy \u00b7 HoldUp"],
    verdictFocusHandoffsVerified: focusChecks.filter((c) => c.id.startsWith("focus-handoff-") && c.passed).length,
    modalDialogsVerified: focusChecks.filter((c) => c.id.startsWith("modal-trap-") && c.passed).length,
    touchTargets: {
      phonePrimaryButtons: {
        ...statsForHeights(phonePrimaryButtons),
        allMeet48px: phonePrimaryButtons.every((b) => b.heightPx >= 48),
      },
      phoneAllButtons: {
        ...statsForHeights(phoneAllButtons),
        allMeet48px: phoneAllButtons.every((b) => b.heightPx >= 48),
      },
      phoneAllInteractive: statsForHeights(phoneAllControls),
      hudPrimaryButtons: {
        ...statsForHeights(hudPrimaryButtons),
        allMeet48px: hudPrimaryButtons.every((b) => b.heightPx >= 48),
      },
      hudAllInteractive: statsForHeights(hudAllControls),
      sub48pxSecondaryControls: Array.from(sub48Dedupe.values()),
    },
    liveRegionAnnouncementsVerified: liveRegionChecks.filter((c) => c.id.startsWith("live-") && c.passed).length,
    liveRegionDuplicateOrEmptyClobbers: liveRegionChecks.filter((c) => c.id.startsWith("live-") && c.emptyOrDuplicateClobber).length,
    hudSpeechCancelChecksVerified: hudChecks.every((c) => c.passed) ? 3 : 0,
  };

  const allPassed = failedChecks === 0 && totalUnnamed === 0;
  const output = {
    tool: "Playwright Chromium + CDP Accessibility.getFullAXTree + DOM MutationObserver",
    engine: `Headless Chromium ${browserVersion} (Blink AXTree via CDP)`,
    viewportPhone: {
      width: 390,
      height: 844,
      hasTouch: true,
      isMobile: true,
      device: "Android 14 Pixel 8 Chrome",
    },
    viewportHud: {
      width: 600,
      height: 600,
      device: "Meta Ray-Ban Display Web App",
    },
    when: new Date().toISOString(),
    allPassed,
    summary,
    checks: allChecks,
  };

  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
  if (!allPassed) process.exitCode = 1;
} finally {
  if (serverProc) {
    serverProc.kill("SIGTERM");
  }
}
