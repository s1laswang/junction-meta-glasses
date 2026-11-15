import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CoachCue, FeatureFlag, Field, LabelRead, Verdict } from "../../shared/types.ts";
import type { Checker, CheckState } from "../src/lib/checker.ts";
import type { PermState } from "../src/lib/media.ts";

const SELF_FILE = fileURLToPath(import.meta.url);
const TEST_DIR = path.dirname(SELF_FILE);
const WEB_DIR = path.resolve(TEST_DIR, "..");
const REPO_DIR = path.resolve(WEB_DIR, "..");

const LINE_COMMENT = String.fromCharCode(47, 47);
const BLOCK_COMMENT = String.fromCharCode(47, 42);
const BLOCK_COMMENT_END = String.fromCharCode(42, 47);
const HTML_COMMENT = String.fromCharCode(60, 33, 45, 45);
const EM_DASH = String.fromCharCode(8212);
const ESCAPED_EM_DASH = ["\\u", "2014"].join("");

const req = createRequire(import.meta.url);
const reactCjs = req("react") as {
  useSyncExternalStore: <T>(
    subscribe: (onStoreChange: () => void) => () => void,
    getSnapshot: () => T,
    getServerSnapshot?: () => T,
  ) => T;
};
const origUseSyncExternalStore = reactCjs.useSyncExternalStore;
reactCjs.useSyncExternalStore = <T,>(
  subscribe: (onStoreChange: () => void) => () => void,
  getSnapshot: () => T,
  getServerSnapshot?: () => T,
): T => origUseSyncExternalStore(subscribe, getSnapshot, getServerSnapshot ?? getSnapshot);

const storageBacking = new Map<string, string>();
const sessionBacking = new Map<string, string>();

function makeStorage(backing: Map<string, string>) {
  return {
    get length() {
      return backing.size;
    },
    key(index: number): string | null {
      return Array.from(backing.keys())[index] ?? null;
    },
    getItem(key: string): string | null {
      return backing.has(key) ? backing.get(key)! : null;
    },
    setItem(key: string, value: string): void {
      backing.set(key, String(value));
    },
    removeItem(key: string): void {
      backing.delete(key);
    },
    clear(): void {
      backing.clear();
    },
  };
}

const localStorageShim = makeStorage(storageBacking);
const sessionStorageShim = makeStorage(sessionBacking);

const locationShim = {
  search: "",
  pathname: "/",
  hash: "",
  protocol: "https:",
  host: "localhost:5173",
  origin: ["https:", "", "localhost:5173"].join("/"),
};

const documentShim = {
  visibilityState: "visible",
  title: "",
  createElement: () => ({ width: 0, height: 0, getContext: () => null }),
  addEventListener() {},
  removeEventListener() {},
};

const navigatorShim = {
  language: "en-US",
  onLine: true,
  userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/130.0.0.0 Mobile",
  vibrate: () => true,
  mediaDevices: {
    getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
    enumerateDevices: async () => [{ kind: "audiooutput", label: "Phone speaker" }],
    addEventListener() {},
    removeEventListener() {},
  },
  permissions: {
    query: async () => ({ state: "prompt" }),
  },
};

const windowShim = {
  isSecureContext: true,
  speechSynthesis: {
    cancel() {},
    speak() {},
  },
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {
    return true;
  },
};

const ReactMod = await import("react");
const React = ReactMod.default;
const { createElement } = ReactMod;
const { renderToStaticMarkup } = await import("react-dom/server");

Object.defineProperty(globalThis, "React", { value: React, configurable: true, writable: true });
Object.defineProperty(globalThis, "localStorage", { value: localStorageShim, configurable: true, writable: true });
Object.defineProperty(globalThis, "sessionStorage", { value: sessionStorageShim, configurable: true, writable: true });
Object.defineProperty(globalThis, "location", { value: locationShim, configurable: true, writable: true });
Object.defineProperty(globalThis, "document", { value: documentShim, configurable: true, writable: true });
Object.defineProperty(globalThis, "navigator", { value: navigatorShim, configurable: true, writable: true });
Object.defineProperty(globalThis, "window", { value: windowShim, configurable: true, writable: true });

const { VerdictCard } = await import("../src/components/VerdictCard.tsx");
const { DevicePanel } = await import("../src/components/DevicePanel.tsx");
const { Consent, PermissionStep, PermissionRecovery } = await import("../src/screens/Onboarding.tsx");
const { Hud, HudCard, LEVEL } = await import("../src/screens/Hud.tsx");
const { explain } = await import("../src/lib/media.ts");
const { demoProfile, loadSettings, saveSettings } = await import("../src/lib/storage.ts");
const {
  emptyRead,
  matchVerdict,
  mockFoodNuts,
  mockScene,
  mockUnsureStrength,
  mockWarningIbuprofen,
  offlineUnknownBarcode,
  offlineUnknownCode,
} = await import("../src/lib/verdicts.ts");

type LiveModule = typeof import("../src/screens/Live.tsx");

async function loadLiveModule(tag: string): Promise<LiveModule> {
  const url = new URL(`../src/screens/Live.tsx?case=${tag}`, import.meta.url).href;
  return (await import(url)) as LiveModule;
}

function readRepoFile(relPath: string): string {
  return fs.readFileSync(path.join(REPO_DIR, relPath), "utf8");
}

function stripBlockComments(css: string): string {
  let out = "";
  let idx = 0;
  while (idx < css.length) {
    const start = css.indexOf(BLOCK_COMMENT, idx);
    if (start === -1) {
      out += css.slice(idx);
      break;
    }
    out += css.slice(idx, start);
    const end = css.indexOf(BLOCK_COMMENT_END, start + 2);
    if (end === -1) break;
    idx = end + 2;
  }
  return out;
}

function extractBlock(css: string, header: RegExp): string {
  const match = header.exec(css);
  assert.ok(match, `Expected CSS block matching ${String(header)}`);
  const openIdx = css.indexOf("{", match.index);
  assert.ok(openIdx >= 0, `Expected opening brace for ${String(header)}`);
  let depth = 0;
  for (let i = openIdx; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(openIdx + 1, i);
    }
  }
  assert.fail(`Unclosed CSS block for ${String(header)}`);
}

type CssRule = {
  selectors: string[];
  body: string;
};

function parseTopLevelCssRules(css: string): CssRule[] {
  const rules: CssRule[] = [];
  let i = 0;
  while (i < css.length) {
    while (i < css.length && /\s/.test(css[i])) i++;
    if (i >= css.length) break;
    const open = css.indexOf("{", i);
    const semi = css.indexOf(";", i);
    if (semi !== -1 && (open === -1 || semi < open)) {
      i = semi + 1;
      continue;
    }
    if (open === -1) break;
    const rawHeader = css.slice(i, open).trim();
    let depth = 0;
    let close = open;
    for (; close < css.length; close++) {
      if (css[close] === "{") depth++;
      else if (css[close] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    const body = css.slice(open + 1, close);
    if (!rawHeader.startsWith("@")) {
      const selectors = rawHeader
        .split(",")
        .map((s) => s.trim().replace(/\s+/g, " "))
        .filter(Boolean);
      rules.push({ selectors, body });
    }
    i = close + 1;
  }
  return rules;
}

function selectorHasDeclaration(rules: CssRule[], targetSelector: string, declarationPattern: RegExp): boolean {
  const normalizedTarget = targetSelector.trim().replace(/\s+/g, " ");
  return rules.some(
    (rule) => rule.selectors.includes(normalizedTarget) && declarationPattern.test(rule.body),
  );
}

function parseCustomProperties(block: string): Record<string, string> {
  const vars: Record<string, string> = {};
  const propPattern = /--([a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let match: RegExpExecArray | null;
  while ((match = propPattern.exec(block)) !== null) {
    vars[`--${match[1]}`] = match[2].trim();
  }
  return vars;
}

function hexToRgb(hex: string): [number, number, number] {
  const trimmed = hex.trim().replace(/^#/, "");
  if (trimmed.length === 3) {
    return [
      Number.parseInt(trimmed[0] + trimmed[0], 16),
      Number.parseInt(trimmed[1] + trimmed[1], 16),
      Number.parseInt(trimmed[2] + trimmed[2], 16),
    ];
  }
  return [
    Number.parseInt(trimmed.slice(0, 2), 16),
    Number.parseInt(trimmed.slice(2, 4), 16),
    Number.parseInt(trimmed.slice(4, 6), 16),
  ];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((channel) => {
    const srgb = channel / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(fgHex: string, bgHex: string): number {
  const l1 = relativeLuminance(fgHex);
  const l2 = relativeLuminance(bgHex);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function decodeHtml(html: string): string {
  return html
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function extractHudHeadline(html: string): string {
  const match = /<p class="hud-headline[^"]*">([\s\S]*?)<\/p>/.exec(html);
  assert.ok(match, `Expected .hud-headline in HUD card markup: ${html}`);
  return decodeHtml(match[1].replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function wordCount(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function makeCheckState(overrides: Partial<CheckState> = {}): CheckState {
  return {
    running: false,
    mode: "live",
    conn: "idle",
    connAttempt: 0,
    nextRetryMs: null,
    serverLive: null,
    serverDetail: "",
    model: null,
    session: "A7W1",
    online: true,
    health: "ok",
    rtt: null,
    policy: { fps: 1, quality: 0.7, longSide: 768, tier: "normal" },
    fps: 0,
    framesSent: 0,
    camera: "off",
    cameraPerm: "granted",
    cameraMsg: "",
    mic: "off",
    micPerm: "granted",
    micMsg: "",
    micLabel: "",
    micLevel: 0,
    route: "Phone speaker",
    source: "phone",
    device: null,
    captions: [],
    cue: null,
    verdict: null,
    verdictVia: null,
    autoStopAt: null,
    snapshotBusy: false,
    checking: false,
    hudConnected: null,
    authNeeded: false,
    speaking: false,
    sharpness: 0,
    serverFeatures: null,
    lastCode: null,
    readiness: null,
    addProposal: null,
    banner: null,
    lastError: null,
    hidden: false,
    ...overrides,
  };
}

function makeStubChecker(
  state: CheckState,
  enabledFeatures: FeatureFlag[] = ["scene", "datamatrix", "addmed", "sonar"],
): Checker {
  const featureSet = new Set<FeatureFlag>(enabledFeatures);
  return {
    subscribe: () => () => {},
    get: () => state,
    attachVideo() {},
    primary() {},
    start: async () => {},
    stop: async () => {},
    snapshot: async () => {},
    offlineCheckImage: async () => {},
    backToLive() {},
    repeat() {},
    logDose() {},
    dismissVerdict() {},
    setSource: async () => {},
    sendText() {},
    answerProposal() {},
    feature: (flag: FeatureFlag) => featureSet.has(flag),
    simulateDrop() {},
    injectCode() {},
    toggleSnapshotMode() {},
    retryKey: async () => {},
    profileChanged() {},
    startSetupByVoice: async () => {},
  } as unknown as Checker;
}

type AuditSummary = {
  totalScreenChecks: number;
  passedScreenChecks: number;
  horizontalOverflowCount: number;
  clippedControlCount: number;
  privacySwitchChecks: number;
  privacySwitchOccludedCount: number;
  verdictActionChecks: number;
  verdictActionObscuredCount: number;
  axeAudits: number;
  axeViolationCount: number;
  axeViolationNodes: number;
  allPassed: boolean;
};

type ConditionSummary = {
  condition: string;
  viewport: string;
  device: string;
  textSpacing1412: boolean;
  screensChecked: number;
  screensPassed: number;
  maxOverflowPx: number;
  clippedControls: number;
  privacySwitchesPass: boolean | null;
  verdictActionsPass: boolean | null;
  axeViolations: number;
};

type PrivacyOcclusionEntry = {
  condition: string;
  viewport: string;
  textSpacing1412: boolean;
  switchesTotal: number;
  switchesHitCount: number;
  tabsCoveredCount: number;
  featSceneHit: boolean;
  featSceneHits: string[];
  deleteBtnClear: boolean;
  minClearanceAboveTabsPx: number;
  pass: boolean;
};

type VerdictOcclusionEntry = {
  condition: string;
  stage: string;
  viewport: string;
  textSpacing1412: boolean;
  actionCount: number;
  labels: string[];
  hasExpectedActions: boolean;
  initialAllClear: boolean;
  allClearAfterFocus: boolean;
  obscuredCount: number;
  minClearanceAboveStopBarPx: number;
  pass: boolean;
};

type AxeEntry = {
  condition: string;
  screen: string;
  passes: number;
  violationCount: number;
  violationNodes: number;
  violations: unknown[];
};

type ScreenEntry = {
  id: string;
  condition: string;
  screen: string;
  viewport: string;
  textSpacing1412: boolean;
  innerWidth: number;
  scrollWidth: number;
  overflowPx: number;
  controlsChecked: number;
  clippedControls: number;
  visibleButtons: number;
  openDetails: number;
  pass: boolean;
};

type LowVisionAuditReport = {
  tool: string;
  wcagCriteria: string[];
  qaFindingClosed: string;
  server: string;
  mobileEmulation: {
    isMobile: boolean;
    hasTouch: boolean;
    deviceScaleFactor: number;
  };
  textSpacingOverride: {
    lineHeight: number;
    letterSpacingEm: number;
    wordSpacingEm: number;
  };
  when: string;
  summary: AuditSummary;
  conditionsSummary: ConditionSummary[];
  privacyOcclusionAudit: PrivacyOcclusionEntry[];
  verdictOcclusionAudit: VerdictOcclusionEntry[];
  axeSummary: AxeEntry[];
  screens: ScreenEntry[];
};

describe("Mobile viewport occlusion, axe WCAG 2.2 AA, and WCAG 1.4.12 text-spacing audit evidence", () => {
  const auditPath = path.join(REPO_DIR, "docs/evidence/lowvision-reflow-audit.json");

  test("docs/evidence/lowvision-reflow-audit.json is compact (< 80 KB) and achieves 100% pass across 360x800, 375x667, 390x844, and 600x600 HUD", () => {
    assert.equal(fs.existsSync(auditPath), true, "docs/evidence/lowvision-reflow-audit.json must exist");
    const stat = fs.statSync(auditPath);
    assert.ok(stat.size > 1000 && stat.size < 80 * 1024, `Expected compact JSON < 80 KB, got ${stat.size} bytes`);

    const report = JSON.parse(fs.readFileSync(auditPath, "utf8")) as LowVisionAuditReport;
    assert.equal(report.summary.allPassed, true);
    assert.equal(report.summary.totalScreenChecks, report.screens.length);
    assert.equal(report.summary.passedScreenChecks, report.summary.totalScreenChecks);
    assert.ok(report.screens.length >= 52, `Expected >= 52 screen checks, got ${report.screens.length}`);

    assert.equal(report.summary.horizontalOverflowCount, 0);
    assert.equal(report.summary.clippedControlCount, 0);
    assert.equal(report.summary.privacySwitchOccludedCount, 0);
    assert.equal(report.summary.verdictActionObscuredCount, 0);
    assert.equal(report.summary.axeViolationCount, 0);
    assert.equal(report.summary.axeViolationNodes, 0);

    assert.equal(report.server, "server/src/index.ts PORT=0 keyless");
    assert.deepEqual(report.mobileEmulation, {
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
    });
    assert.deepEqual(report.textSpacingOverride, {
      lineHeight: 1.5,
      letterSpacingEm: 0.12,
      wordSpacingEm: 0.16,
    });
    assert.match(report.qaFindingClosed, /docs\/QA\.md #13/);
    assert.match(report.qaFindingClosed, /360x800/);
    assert.match(report.qaFindingClosed, /375x667/);
    assert.match(report.qaFindingClosed, /390x844/);
    assert.match(report.qaFindingClosed, /600x600/);

    const expectedConditions: Array<{ id: string; viewport: string; width: number; textSpacing1412: boolean }> = [
      { id: "360x800-mobile", viewport: "360x800", width: 360, textSpacing1412: false },
      { id: "360x800-1.4.12", viewport: "360x800", width: 360, textSpacing1412: true },
      { id: "375x667-mobile", viewport: "375x667", width: 375, textSpacing1412: false },
      { id: "375x667-1.4.12", viewport: "375x667", width: 375, textSpacing1412: true },
      { id: "390x844-mobile", viewport: "390x844", width: 390, textSpacing1412: false },
      { id: "390x844-1.4.12", viewport: "390x844", width: 390, textSpacing1412: true },
      { id: "600x600-hud", viewport: "600x600", width: 600, textSpacing1412: false },
      { id: "600x600-hud-1.4.12", viewport: "600x600", width: 600, textSpacing1412: true },
    ];

    assert.deepEqual(
      report.conditionsSummary.map((c) => c.condition),
      expectedConditions.map((e) => e.id),
    );

    for (const expected of expectedConditions) {
      const cond = report.conditionsSummary.find((c) => c.condition === expected.id);
      assert.ok(cond, `Missing condition summary ${expected.id}`);
      assert.equal(cond.viewport, expected.viewport);
      assert.equal(cond.textSpacing1412, expected.textSpacing1412);
      assert.equal(cond.screensPassed, cond.screensChecked);
      assert.equal(cond.maxOverflowPx, 0);
      assert.equal(cond.clippedControls, 0);
      assert.equal(cond.axeViolations, 0);

      const screens = report.screens.filter((s) => s.condition === expected.id);
      assert.equal(screens.length, cond.screensChecked);
      for (const s of screens) {
        assert.equal(s.pass, true, `Expected ${s.id} to pass`);
        assert.equal(s.innerWidth, expected.width);
        assert.ok(s.scrollWidth <= s.innerWidth, `Expected scrollWidth <= innerWidth on ${s.id}`);
        assert.equal(s.overflowPx, 0);
        assert.equal(s.clippedControls, 0);
        assert.ok(s.controlsChecked >= 1);
      }
    }

    for (const requiredScreen of [
      "onboarding-welcome",
      "onboarding-consent",
      "permissions-recovery",
      "check-idle",
      "check-verdict",
      "check-verdict-details",
      "profile",
      "privacy",
    ]) {
      const textSpacingRuns = report.screens.filter((s) => s.screen === requiredScreen && s.textSpacing1412);
      assert.equal(textSpacingRuns.length, 3, `Expected 3 WCAG 1.4.12 phone viewports for ${requiredScreen}`);
      for (const item of textSpacingRuns) {
        assert.equal(item.clippedControls, 0);
        assert.equal(item.pass, true);
      }
    }
  });

  test("verifies Privacy switches (feat-scene + all role=switch) never sit under nav.tabs, Verdict actions clear .bigbtn-wrap Stop bar, and axe WCAG 2.2 A+AA has 0 violations", () => {
    const report = JSON.parse(fs.readFileSync(auditPath, "utf8")) as LowVisionAuditReport;

    assert.equal(report.privacyOcclusionAudit.length, 6);
    assert.equal(report.summary.privacySwitchChecks, 48);
    for (const priv of report.privacyOcclusionAudit) {
      assert.equal(priv.pass, true, `Expected Privacy switch occlusion pass on ${priv.condition}`);
      assert.equal(priv.switchesTotal, 8);
      assert.equal(priv.switchesHitCount, 8);
      assert.equal(priv.tabsCoveredCount, 0);
      assert.equal(priv.featSceneHit, true);
      assert.equal(priv.featSceneHits.length, 3);
      assert.equal(priv.deleteBtnClear, true);
      assert.ok(priv.minClearanceAboveTabsPx >= 0);
    }

    assert.equal(report.verdictOcclusionAudit.length, 12);
    assert.equal(report.summary.verdictActionChecks, 36);
    for (const verd of report.verdictOcclusionAudit) {
      assert.equal(verd.pass, true, `Expected Verdict Stop-bar clearance pass on ${verd.condition}:${verd.stage}`);
      assert.deepEqual(verd.labels, ["Repeat", "I took it", "Dismiss"]);
      assert.equal(verd.hasExpectedActions, true);
      if (verd.stage === "verdict-initial") {
        assert.equal(verd.initialAllClear, true, `Expected immediate Stop-bar clearance on ${verd.condition}`);
      }
      assert.equal(verd.allClearAfterFocus, true);
      assert.equal(verd.obscuredCount, 0);
      assert.ok(verd.minClearanceAboveStopBarPx >= 0);
    }

    const privacyAxe = report.axeSummary.filter((a) => a.screen === "privacy");
    const profileAxe = report.axeSummary.filter((a) => a.screen === "profile");
    const hudAxe = report.axeSummary.filter((a) => a.screen === "hud-verdict");
    assert.equal(privacyAxe.length, 6);
    assert.equal(profileAxe.length, 6);
    assert.equal(hudAxe.length, 2);
    for (const axeItem of report.axeSummary) {
      assert.equal(axeItem.violationCount, 0, `Expected 0 axe violations on ${axeItem.condition}:${axeItem.screen}`);
      assert.equal(axeItem.violationNodes, 0);
      assert.equal(axeItem.violations.length, 0);
      assert.ok(axeItem.passes >= 15, `Expected >= 15 axe rule passes on ${axeItem.condition}:${axeItem.screen}`);
    }
  });

  test("scripts/lowvision-reflow-audit.mjs spawns server/src/index.ts on PORT=0 keyless with shared ms-playwright and WCAG 1.4.12 overrides", () => {
    const scriptSrc = readRepoFile("scripts/lowvision-reflow-audit.mjs");
    assert.match(scriptSrc, /server\/src\/index\.ts/);
    assert.match(scriptSrc, /PORT:\s*"0"/);
    assert.match(scriptSrc, /GEMINI_API_KEY:\s*""/);
    assert.match(scriptSrc, /\/tmp\/fleet-root\/shared\/ms-playwright/);
    assert.match(scriptSrc, /isMobile:\s*true/);
    assert.match(scriptSrc, /hasTouch:\s*true/);
    assert.match(scriptSrc, /deviceScaleFactor:\s*3/);
    assert.match(scriptSrc, /line-height:\s*1\.5\s*!important;/);
    assert.match(scriptSrc, /letter-spacing:\s*0\.12em\s*!important;/);
    assert.match(scriptSrc, /word-spacing:\s*0\.16em\s*!important;/);
    assert.match(scriptSrc, /os\.tmpdir\(\)/);
  });
});

describe("WCAG 1.4.4, 1.4.10, 1.4.12, and 2.4.11 layout invariants on origin/main styles.css", () => {
  const rawStyles = readRepoFile("web/src/styles.css");
  const cleanStyles = stripBlockComments(rawStyles);
  const rules = parseTopLevelCssRules(cleanStyles);

  test("styles.css enforces app-shell main scroll isolation, static bottom tabs, and WCAG 2.4.11 Stop-bar scroll clearance", () => {
    assert.equal(selectorHasDeclaration(rules, ".app", /height\s*:\s*100dvh\s*;/), true);
    assert.equal(selectorHasDeclaration(rules, ".app", /overflow\s*:\s*hidden\s*;/), true);
    assert.equal(selectorHasDeclaration(rules, ".app > main", /min-height\s*:\s*0\s*;/), true);
    assert.equal(selectorHasDeclaration(rules, ".app > main", /overflow-y\s*:\s*auto\s*;/), true);
    assert.equal(selectorHasDeclaration(rules, ".app > main", /scroll-padding-bottom\s*:\s*16px\s*;/), true);
    assert.equal(
      selectorHasDeclaration(rules, ".app > main:has(.bigbtn-wrap)", /scroll-padding-bottom\s*:\s*calc\(140px\s*\+\s*16px\)\s*;/),
      true,
    );
    assert.equal(selectorHasDeclaration(rules, ".app > .tabs", /position\s*:\s*static\s*;/), true);
    assert.equal(selectorHasDeclaration(rules, ".app > .tabs", /flex\s*:\s*none\s*;/), true);
    assert.equal(selectorHasDeclaration(rules, ".app > main .bigbtn-wrap", /bottom\s*:\s*0\s*;/), true);
    assert.equal(
      selectorHasDeclaration(rules, ".verdict .actions", /scroll-margin-bottom\s*:\s*calc\(140px\s*\+\s*16px\)\s*;/),
      true,
    );

    const liveSrc = readRepoFile("web/src/screens/Live.tsx");
    assert.match(liveSrc, /scrollIntoView\(\{\s*block:\s*"nearest"\s*\}\)/);
  });

  test("styles.css and HTML viewports preserve WCAG 1.4.4 rem scaling, 1.4.10/1.4.12 min-height and wrapping rules, AAA contrast, and pinch-zoom", () => {
    for (const wrapSelector of [".row", ".verdict .actions", ".banner .actions", ".checks", ".tags", ".sim", ".hud-status"]) {
      assert.equal(
        selectorHasDeclaration(rules, wrapSelector, /flex-wrap\s*:\s*wrap\s*;/),
        true,
        `Expected ${wrapSelector} to declare flex-wrap: wrap`,
      );
    }

    assert.equal(selectorHasDeclaration(rules, ".scene-item", /min-width\s*:\s*0\s*;/), true);
    assert.equal(selectorHasDeclaration(rules, ".hud-main", /min-height\s*:\s*0\s*;/), true);
    assert.equal(selectorHasDeclaration(rules, ".kv dd", /overflow-wrap\s*:\s*anywhere\s*;/), true);
    assert.equal(selectorHasDeclaration(rules, ".hud-headline", /overflow-wrap\s*:\s*anywhere\s*;/), true);
    assert.equal(selectorHasDeclaration(rules, ".scene-head", /overflow-wrap\s*:\s*break-word\s*;/), true);
    assert.equal(
      selectorHasDeclaration(rules, "dialog.addsheet", /width\s*:\s*min\(600px,\s*calc\(100vw\s*-\s*16px\)\)\s*;/),
      true,
    );
    assert.equal(
      selectorHasDeclaration(rules, "dialog", /width\s*:\s*min\(560px,\s*calc\(100vw\s*-\s*32px\)\)\s*;/),
      true,
    );

    const rootBlock = extractBlock(cleanStyles, /(?:^|\n):root\s*\{/);
    const root = parseCustomProperties(rootBlock);

    for (const bgToken of ["--bg", "--surface", "--surface-2"] as const) {
      assert.ok(contrastRatio(root["--text"], root[bgToken]) >= 7.0);
      assert.ok(contrastRatio(root["--muted"], root[bgToken]) >= 4.5);
    }
    assert.ok(contrastRatio(root["--accent"], root["--bg"]) >= 7.0);
    assert.ok(contrastRatio(root["--on-accent"], root["--accent"]) >= 7.0);
    for (const verdictToken of ["--match", "--warning", "--unsure"] as const) {
      assert.ok(contrastRatio(root[verdictToken], root["--bg"]) >= 4.5);
      assert.ok(contrastRatio(root[verdictToken], root["--surface"]) >= 4.5);
    }

    const hcMediaBlock = extractBlock(cleanStyles, /@media\s*\(\s*prefers-contrast\s*:\s*more\s*\)\s*\{/);
    const hc = { ...root, ...parseCustomProperties(extractBlock(hcMediaBlock, /:root\s*\{/)) };
    assert.equal(contrastRatio(hc["--text"], hc["--bg"]), 21);
    assert.equal(contrastRatio(hc["--border"], hc["--bg"]), 21);

    for (const scaleToken of ["--t-base", "--t-md", "--t-lg", "--t-xl", "--t-xxl"] as const) {
      assert.match(root[scaleToken], /^[0-9.]+rem$/);
    }
    assert.equal(root["--t-base"], "1.125rem");
    assert.equal(root["--tap"], "56px");

    const htmlBlock = extractBlock(cleanStyles, /(?:^|\n)html\s*\{/);
    assert.match(htmlBlock, /-webkit-text-size-adjust\s*:\s*100%\s*;/);
    assert.match(htmlBlock, /text-size-adjust\s*:\s*100%\s*;/);
    assert.doesNotMatch(htmlBlock, /font-size\s*:\s*[0-9.]+px/);

    assert.equal(selectorHasDeclaration(rules, ".btn", /min-height\s*:\s*var\(--tap\)\s*;/), true);
    assert.equal(selectorHasDeclaration(rules, ".switch", /min-height\s*:\s*var\(--tap\)\s*;/), true);
    assert.equal(selectorHasDeclaration(rules, "details.panel summary", /min-height\s*:\s*var\(--tap\)\s*;/), true);
    assert.equal(selectorHasDeclaration(rules, ".bigbtn", /min-height\s*:\s*104px\s*;/), true);
    assert.equal(selectorHasDeclaration(rules, ".hud button", /min-height\s*:\s*clamp\(48px,\s*10vmin,\s*64px\)\s*;/), true);
    assert.match(extractBlock(cleanStyles, /(?:^|\n):focus-visible\s*\{/), /outline\s*:\s*3px\s+solid\s+var\(--accent\)\s*;/);
    assert.match(extractBlock(cleanStyles, /\.verdict\.warning\s*\{/), /border-style\s*:\s*double\s*;/);
    assert.match(extractBlock(cleanStyles, /\.verdict\.unsure\s*\{/), /border-style\s*:\s*dashed\s*;/);
    assert.match(
      extractBlock(cleanStyles, /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)\s*\{/),
      /animation\s*:\s*none\s*!important\s*;/,
    );

    for (const htmlRel of ["web/index.html", "web/hud/index.html"]) {
      const html = readRepoFile(htmlRel);
      const viewportMatch = /<meta\s+name="viewport"\s+content="([^"]+)"/i.exec(html);
      assert.ok(viewportMatch, `Expected viewport meta in ${htmlRel}`);
      const content = viewportMatch[1].toLowerCase();
      assert.match(content, /width=device-width/);
      assert.match(content, /initial-scale=1/);
      assert.doesNotMatch(content, /user-scalable\s*=\s*(no|0|false)/);
      assert.doesNotMatch(content, /maximum-scale\s*=\s*[1-4](\b|\.)/);
    }
  });
});

describe("Cognitive-load, progressive-disclosure, non-blaming recovery, and HUD headline budget invariants", () => {
  test("caps primary actions at <= 3 across Onboarding, Live Check, VerdictCard, and HUD, with collapsed <details> in VerdictCard and DevicePanel", async () => {
    localStorageShim.clear();
    locationShim.search = "";

    const welcomeHtml = renderToStaticMarkup(createElement(Consent, { onAgree: () => {}, onNotNow: () => {} }));
    assert.equal((welcomeHtml.match(/<button\b/g) ?? []).length, 1);

    const permStepHtml = renderToStaticMarkup(createElement(PermissionStep, { onDone: () => {} }));
    assert.ok((permStepHtml.match(/<button\b/g) ?? []).length <= 3);

    const { Live: LiveDefault } = await loadLiveModule("cognitive-default");
    const unconsentedHtml = renderToStaticMarkup(
      createElement(LiveDefault, {
        checker: makeStubChecker(makeCheckState()),
        consented: false,
        onReviewConsent: () => {},
        onFixPermissions: () => {},
      }),
    );
    assert.equal((unconsentedHtml.match(/class="bigbtn/g) ?? []).length, 0);
    assert.equal((unconsentedHtml.match(/<video\b/g) ?? []).length, 0);
    assert.equal((unconsentedHtml.match(/<button\b/g) ?? []).length, 1);

    assert.equal(loadSettings().showPanel, false);
    const liveIdleHtml = renderToStaticMarkup(
      createElement(LiveDefault, {
        checker: makeStubChecker(makeCheckState({ running: false })),
        consented: true,
        onReviewConsent: () => {},
        onFixPermissions: () => {},
      }),
    );
    assert.equal((liveIdleHtml.match(/<button[^>]*class="bigbtn[^"]*"/g) ?? []).length, 1);
    assert.match(liveIdleHtml, /<details class="panel"><summary>Device state<\/summary>/);
    assert.doesNotMatch(liveIdleHtml, /<details class="panel" open/);

    saveSettings({ ...loadSettings(), showPanel: true });
    const { Live: LivePanelOpen } = await loadLiveModule("cognitive-panel-open");
    const openPanelHtml = renderToStaticMarkup(
      createElement(LivePanelOpen, {
        checker: makeStubChecker(makeCheckState()),
        consented: true,
        onReviewConsent: () => {},
        onFixPermissions: () => {},
      }),
    );
    assert.match(openPanelHtml, /<details class="panel" open=""/);

    const closedPanelDirect = renderToStaticMarkup(
      createElement(DevicePanel, {
        s: makeCheckState(),
        checker: makeStubChecker(makeCheckState()),
        open: false,
        onToggle: () => {},
      }),
    );
    assert.doesNotMatch(closedPanelDirect, /<details class="panel" open/);
    localStorageShim.clear();

    const p = demoProfile();
    const verdicts: Verdict[] = [
      matchVerdict(p, p.meds[0]),
      mockWarningIbuprofen(),
      mockUnsureStrength(),
      mockFoodNuts(),
      mockScene(p),
    ];

    for (const verdict of verdicts) {
      const html = renderToStaticMarkup(
        createElement(VerdictCard, {
          verdict,
          via: "live",
          onRepeat: () => {},
          onLog: () => {},
          onDismiss: () => {},
        }),
      );
      assert.doesNotMatch(html, /<details[^>]*\bopen\b/);
      const hasReadableRows = Object.entries(verdict.read).some(
        ([k, v]) =>
          k !== "kind" &&
          k !== "readability" &&
          v &&
          typeof v === "object" &&
          "value" in v &&
          ((v as Field<unknown>).value != null || (v as Field<unknown>).confidence > 0),
      );
      if (hasReadableRows) {
        assert.match(html, /<details><summary[^>]*>What I read, and how sure I am<\/summary><dl class="fields">/);
      }
      const actionButtons = html.match(/<div class="actions">([\s\S]*?)<\/div>/)?.[1].match(/<button\b/g) ?? [];
      assert.ok(actionButtons.length >= 2 && actionButtons.length <= 3);
    }

    const emptyVerdict: Verdict = {
      level: "unsure",
      headline: "Could not read label",
      speech: "I cannot read the label yet. Turn the box toward the light.",
      read: emptyRead("unknown") as LabelRead,
      reasons: ["No text visible"],
    };
    const emptyHtml = renderToStaticMarkup(
      createElement(VerdictCard, {
        verdict: emptyVerdict,
        via: "live",
        onRepeat: () => {},
        onLog: () => {},
        onDismiss: () => {},
      }),
    );
    assert.doesNotMatch(emptyHtml, /<details\b/);

    const hudFullHtml = renderToStaticMarkup(createElement(Hud));
    const hudActsMatch = /<div class="hud-acts">([\s\S]*?)<\/div>/.exec(hudFullHtml);
    assert.ok(hudActsMatch, "Expected .hud-acts action bar in Hud");
    const hudActionButtons = hudActsMatch[1].match(/<button\b/g) ?? [];
    assert.equal(hudActionButtons.length, 3, "HUD primary action bar must contain exactly 3 buttons");
  });

  test("enforces plain-language, non-blaming permission recovery copy and fallback paths across camera and microphone states", () => {
    const onboardingSrc = readRepoFile("web/src/screens/Onboarding.tsx");
    const cardsBlockMatch = /const CARDS = \[([\s\S]*?)\n\];/.exec(onboardingSrc);
    assert.ok(cardsBlockMatch, "Expected CARDS in Onboarding.tsx");
    const pointBlocks = [...cardsBlockMatch[1].matchAll(/points:\s*\[([\s\S]*?)\]/g)].map((m) => m[1]);
    assert.equal(pointBlocks.length, 3);
    for (const block of pointBlocks) {
      const bullets = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      assert.ok(bullets.length >= 1 && bullets.length <= 3);
      for (const bullet of bullets) {
        assert.doesNotMatch(
          bullet,
          /\b(hereinafter|indemnif|subprocessor|arbitration|tort|warranties|liable|pursuant)\b/i,
        );
      }
    }

    const permStates: PermState[] = ["denied", "blocked", "unavailable", "in-use", "insecure"];
    for (const kind of ["camera", "mic"] as const) {
      for (const st of permStates) {
        const msg = explain(kind, st);
        assert.ok(msg.length > 10, `Expected plain-language explanation for ${kind}:${st}`);
        assert.ok(wordCount(msg) <= 22, `Expected concise <= 22-word explanation for ${kind}:${st}`);
        assert.doesNotMatch(
          msg,
          /\b(notallowederror|permissiondeniederror|overconstrainederror|error code|fault|illegal|invalid user)\b/i,
        );
      }
    }
    assert.match(explain("camera", "denied"), /That's fine\. You can turn it on any time\./);
    assert.match(explain("mic", "denied"), /That's fine\. You can turn it on any time\./);

    const recoveryCombinations: Array<{ camera: PermState; mic: PermState; expectedHeading: string }> = [
      { camera: "denied", mic: "denied", expectedHeading: "HoldUp can't use the camera or microphone yet" },
      { camera: "blocked", mic: "granted", expectedHeading: "HoldUp can't use the camera yet" },
      { camera: "granted", mic: "denied", expectedHeading: "HoldUp can't use the microphone yet" },
    ];

    for (const combo of recoveryCombinations) {
      const html = renderToStaticMarkup(
        createElement(PermissionRecovery, {
          result: { camera: combo.camera, mic: combo.mic },
          onRetry: () => {},
          onContinue: () => {},
        }),
      );
      const text = decodeHtml(html);
      assert.ok(text.includes(combo.expectedHeading));
      assert.ok(text.includes("You can still use HoldUp"));
      const buttons = html.match(/<button\b/g) ?? [];
      assert.equal(buttons.length, 2, "PermissionRecovery must present exactly 2 clear recovery actions");
    }
  });

  test("enforces concise HUD headline budget (<= 8 words per docs/HUD_SPEC.md) and zero buttons inside pure HudCard", () => {
    const p = demoProfile();
    const med = p.meds[0];
    const sampleCode = { raw: "010641654200214917270831", gtin: "06416542002149", expiry: "2027-08-31" };
    const expiredCode = { raw: "010641654200214917250831", gtin: "06416542002149", expiry: "2025-08-31" };
    const loggedProfile = { ...p, doseLog: [{ medId: med.id, ts: Date.now() - 60_000 }] };

    const hudVerdicts: Verdict[] = [
      matchVerdict(p, med),
      matchVerdict(p, med, { via: "barcode" }),
      matchVerdict(p, med, { via: "datamatrix", code: sampleCode }),
      matchVerdict(p, med, { via: "datamatrix", code: expiredCode, now: new Date("2026-11-15T08:00:00Z") }),
      matchVerdict(loggedProfile, med),
      mockWarningIbuprofen(),
      mockUnsureStrength(),
      mockFoodNuts(),
      mockScene(p),
      offlineUnknownCode(sampleCode),
      offlineUnknownBarcode("6416542002149"),
    ];

    const idleCardHtml = renderToStaticMarkup(
      createElement(HudCard, { keyNeeded: false, cue: null, verdict: null, stale: false }),
    );
    assert.equal((idleCardHtml.match(/<button\b/g) ?? []).length, 0);
    assert.ok(wordCount(extractHudHeadline(idleCardHtml)) <= 8);

    const keyCardHtml = renderToStaticMarkup(
      createElement(HudCard, { keyNeeded: true, cue: null, verdict: null, stale: false }),
    );
    assert.equal((keyCardHtml.match(/<button\b/g) ?? []).length, 0);
    assert.ok(wordCount(extractHudHeadline(keyCardHtml)) <= 8);

    const cues: Array<{ cue: CoachCue; text: string }> = [
      { cue: "other_side", text: "Turn it around" },
      { cue: "closer", text: "A bit closer" },
      { cue: "rotate_left", text: "Turn it left" },
      { cue: "hold_still", text: "Hold still" },
    ];
    for (const c of cues) {
      const cueHtml = renderToStaticMarkup(
        createElement(HudCard, { keyNeeded: false, cue: c, verdict: null, stale: false }),
      );
      assert.equal((cueHtml.match(/<button\b/g) ?? []).length, 0);
      assert.ok(wordCount(extractHudHeadline(cueHtml)) <= 4);
    }

    for (const lvl of Object.values(LEVEL)) {
      assert.ok(lvl.glyph.length >= 1);
      assert.ok(wordCount(lvl.word) <= 2);
    }

    for (const verdict of hudVerdicts) {
      const cardHtml = renderToStaticMarkup(
        createElement(HudCard, { keyNeeded: false, cue: null, verdict, stale: false }),
      );
      assert.equal((cardHtml.match(/<button\b/g) ?? []).length, 0, "HudCard itself must contain 0 buttons");
      const headline = extractHudHeadline(cardHtml);
      const words = wordCount(headline);
      assert.ok(words >= 1 && words <= 8, `Expected HUD headline "${headline}" to be <= 8 words, got ${words}`);
      assert.ok(headline.length <= 48, `Expected concise HUD headline <= 48 chars, got "${headline}"`);
    }
  });

  test("enforces zero code comments and zero em dashes across all 3 audit and test files", () => {
    for (const relPath of [
      "scripts/lowvision-reflow-audit.mjs",
      "docs/evidence/lowvision-reflow-audit.json",
      "web/test/lowVisionReflowAndCognitiveLoadA11y.test.ts",
    ]) {
      const content = readRepoFile(relPath);
      assert.equal(content.includes(LINE_COMMENT), false, `${relPath} must contain zero line comments`);
      assert.equal(content.includes(BLOCK_COMMENT), false, `${relPath} must contain zero block comments`);
      assert.equal(content.includes(HTML_COMMENT), false, `${relPath} must contain zero HTML comments`);
      assert.equal(content.includes(EM_DASH), false, `${relPath} must contain zero em dashes`);
      assert.equal(content.includes(ESCAPED_EM_DASH), false, `${relPath} must contain zero escaped em dashes`);
    }
  });
});
