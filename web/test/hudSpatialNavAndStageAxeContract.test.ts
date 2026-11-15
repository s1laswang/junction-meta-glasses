import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { STAGE_MSG_TYPES, initialStage, stageReduce, type StageMsg, type StageState } from "../src/lib/stage.ts";
import { mockMetrics } from "../src/lib/stageMock.ts";
import { demoProfile } from "../src/lib/storage.ts";
import { matchVerdict, mockScene, mockUnsureStrength, mockWarningIbuprofen, withCrossCheck } from "../src/lib/verdicts.ts";

const SELF_FILE = fileURLToPath(import.meta.url);
const TEST_DIR = path.dirname(SELF_FILE);
const REPO_DIR = path.resolve(TEST_DIR, "..", "..");

const LINE_COMMENT = String.fromCharCode(47, 47);
const BLOCK_OPEN = String.fromCharCode(47, 42);
const BLOCK_CLOSE = String.fromCharCode(42, 47);
const HTML_COMMENT = String.fromCharCode(60, 33, 45, 45);
const EM_DASH = String.fromCharCode(8212);
const ESCAPED_EM_DASH = ["\\u", "2014"].join("");

Object.defineProperty(globalThis, "React", { value: React, configurable: true, writable: true });
if (typeof (globalThis as { location?: unknown }).location === "undefined") {
  Object.defineProperty(globalThis, "location", {
    value: new URL("http:" + LINE_COMMENT + "localhost/stage"),
    configurable: true,
    writable: true,
  });
}

const { StageView } = await import("../src/screens/Stage.tsx");

type TransitionRecord = {
  key: string;
  expected: string;
  actual: string;
  passed: boolean;
};

type AxeStateRecord = {
  state: string;
  route: string;
  viewport: string;
  violations: Array<{ id: string; impact: string; nodes: number }>;
  violationNodes: number;
  passes: number;
  incomplete: number;
  horizontalOverflowPx: number;
  verticalOverflowPx: number;
  mediaMatches?: boolean;
};

type StageStateRecord = AxeStateRecord & {
  interactiveCount: number;
  mediaElementCount: number;
  frameOrAudioLeak: boolean;
  readOnlyFooter: boolean;
  meterAriaValid: boolean;
  statusAriaValid: boolean;
  driverBadge: string;
  statusText: string;
};

type HudStageAuditReport = {
  tool: string;
  tags: string;
  when: string;
  serverMode: {
    portFlag: string;
    keyless: boolean;
    healthOk: boolean;
  };
  browserArgs: string[];
  summary: {
    totalAuditedStates: number;
    hudAuditedStates: number;
    stageAuditedStates: number;
    totalViolationNodes: number;
    totalOverflowStates: number;
    hudSpatialNavPassRatePct: number;
    hudSpatialNavAllPassed: boolean;
    stageViewportsTested: string[];
    stageInteractiveElements: number;
    stageMediaElements: number;
    stageLeakCount: number;
    stageInvalidAriaCount: number;
    stageBroadcastHandoffAllPassed: boolean;
  };
  hud: {
    viewport: string;
    consoleErrors: number;
    spatialNav: {
      launchArgs: string[];
      passedChecks: number;
      totalChecks: number;
      passRatePct: number;
      allPassed: boolean;
      nativeButtonStructure: {
        buttonCount: number;
        labels: string[];
        allTypeButton: boolean;
        positiveTabIndexCount: number;
        nonNativeInteractiveCount: number;
        outlineWidthPx: number;
        minButtonHeightPx: number;
        passed: boolean;
      };
      autoFocus: {
        matchAutoFocusesTake: boolean;
        warningAutoFocusesRepeat: boolean;
        unsureAutoFocusesRepeat: boolean;
        passed: boolean;
      };
      arrowNavigation: {
        matchTransitions: TransitionRecord[];
        warningTransitions: TransitionRecord[];
        unsureTransitions: TransitionRecord[];
        passed: boolean;
      };
      enterSingleActivation: {
        repeatOnce: boolean;
        takeOnce: boolean;
        speakToggleOnOnce: boolean;
        speakToggleOffOnce: boolean;
        dismissOnce: boolean;
        passed: boolean;
      };
      historyBack: {
        entriesAddedForThreeVerdicts: number;
        hudVerdictStatePresent: boolean;
        poppedToIdleFirst: boolean;
        poppedToIdleSecond: boolean;
        exitedToShellOnIdleBack: boolean;
        trappedHistory: boolean;
        passed: boolean;
      };
    };
    axeStates: AxeStateRecord[];
  };
  stage: {
    viewports: Array<{
      viewport: string;
      consoleErrors: number;
      handoffVerified: boolean;
      states: StageStateRecord[];
    }>;
  };
};

function readRepoFile(relPath: string): string {
  return fs.readFileSync(path.join(REPO_DIR, relPath), "utf8");
}

function parseHexRgb(hex: string): [number, number, number] {
  const clean = hex.trim().replace(/^#/, "");
  if (clean.length === 3) {
    return [
      parseInt(clean[0] + clean[0], 16),
      parseInt(clean[1] + clean[1], 16),
      parseInt(clean[2] + clean[2], 16),
    ];
  }
  assert.equal(clean.length, 6, `Expected 3 or 6 hex digits, got ${hex}`);
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHexRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(fgHex: string, bgHex: string): number {
  const l1 = relativeLuminance(fgHex);
  const l2 = relativeLuminance(bgHex);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function renderStage(
  state: StageState,
  opts: Partial<{ conn: "open" | "retry" | "connecting"; keyNeeded: boolean; driver: "script" | "phone" | "server" }> = {},
): string {
  return renderToStaticMarkup(
    createElement(StageView, {
      s: state,
      conn: "open",
      keyNeeded: false,
      driver: "server",
      ...opts,
    }),
  );
}

describe("HUD Chromium --enable-spatial-navigation and /stage axe WCAG 2.2 AA audit contract", () => {
  test("verifies docs/evidence/hud-stage-a11y.json stays under 60 KB with 0 axe violations, 0 overflow, and 100% spatial-nav pass", () => {
    const evidenceAbs = path.join(REPO_DIR, "docs", "evidence", "hud-stage-a11y.json");
    assert.equal(fs.existsSync(evidenceAbs), true, "docs/evidence/hud-stage-a11y.json must exist");

    const stat = fs.statSync(evidenceAbs);
    assert.ok(stat.size > 500 && stat.size < 60 * 1024, `Expected compact JSON < 60 KB, got ${stat.size} bytes`);

    const report = JSON.parse(fs.readFileSync(evidenceAbs, "utf8")) as HudStageAuditReport;
    assert.match(report.tags, /WCAG.*2\.2.*A\+AA/);
    assert.equal(report.serverMode.portFlag, "PORT=0");
    assert.equal(report.serverMode.keyless, true);
    assert.equal(report.serverMode.healthOk, true);
    assert.deepEqual(report.browserArgs, ["--enable-spatial-navigation", "--enable-blink-features=SpatialNavigation"]);

    assert.equal(report.summary.totalViolationNodes, 0);
    assert.equal(report.summary.totalOverflowStates, 0);
    assert.equal(report.summary.hudSpatialNavPassRatePct, 100);
    assert.equal(report.summary.hudSpatialNavAllPassed, true);
    assert.equal(report.summary.stageInteractiveElements, 0);
    assert.equal(report.summary.stageMediaElements, 0);
    assert.equal(report.summary.stageLeakCount, 0);
    assert.equal(report.summary.stageInvalidAriaCount, 0);
    assert.equal(report.summary.stageBroadcastHandoffAllPassed, true);

    const expectedHudStates = [
      "idle",
      "coach_cue",
      "match",
      "warning",
      "unsure",
      "scene_strip",
      "key_needed",
      "prefers_contrast_more",
      "prefers_reduced_motion",
    ];
    const actualHudStates = report.hud.axeStates.map((s) => s.state);
    for (const reqState of expectedHudStates) {
      assert.ok(actualHudStates.includes(reqState), `Missing audited HUD state "${reqState}"`);
    }
    assert.equal(report.hud.viewport, "600x600");
    assert.equal(report.hud.consoleErrors, 0);

    for (const hudState of report.hud.axeStates) {
      assert.equal(hudState.viewport, "600x600");
      assert.equal(hudState.violations.length, 0, `HUD state ${hudState.state} had axe violations`);
      assert.equal(hudState.violationNodes, 0);
      assert.ok(hudState.passes > 0, `HUD state ${hudState.state} must record positive axe passes`);
      assert.equal(hudState.horizontalOverflowPx, 0, `HUD state ${hudState.state} overflowed horizontally`);
      assert.equal(hudState.verticalOverflowPx, 0, `HUD state ${hudState.state} overflowed vertically`);
      if (hudState.state === "prefers_contrast_more" || hudState.state === "prefers_reduced_motion") {
        assert.equal(hudState.mediaMatches, true, `HUD media query ${hudState.state} must match in Chromium`);
      }
    }
  });

  test("verifies HUD_SPEC section 6 and section 8 native-button spatial navigation, single Enter activation, auto-focus, and history.back() contracts", () => {
    const hudSpec = readRepoFile("docs/HUD_SPEC.md");
    const hudSource = readRepoFile("web/src/screens/Hud.tsx");
    const report = JSON.parse(readRepoFile("docs/evidence/hud-stage-a11y.json")) as HudStageAuditReport;

    assert.match(hudSpec, /native `<button>`s only/);
    assert.match(hudSpec, /--enable-spatial-navigation/);
    assert.ok(hudSpec.includes("Enter activates each one **once**"));
    assert.match(hudSpec, /history\.back\(\)/);

    const nav = report.hud.spatialNav;
    assert.deepEqual(nav.launchArgs, ["--enable-spatial-navigation", "--enable-blink-features=SpatialNavigation"]);
    assert.equal(nav.allPassed, true);
    assert.equal(nav.passRatePct, 100);
    assert.equal(nav.passedChecks, nav.totalChecks);

    assert.equal(nav.nativeButtonStructure.passed, true);
    assert.equal(nav.nativeButtonStructure.buttonCount, 4);
    assert.deepEqual(nav.nativeButtonStructure.labels, ["Repeat", "I took it", "Dismiss", "Speak off"]);
    assert.equal(nav.nativeButtonStructure.allTypeButton, true);
    assert.equal(nav.nativeButtonStructure.positiveTabIndexCount, 0);
    assert.equal(nav.nativeButtonStructure.nonNativeInteractiveCount, 0);
    assert.ok(nav.nativeButtonStructure.outlineWidthPx >= 3);
    assert.ok(nav.nativeButtonStructure.minButtonHeightPx >= 44);

    assert.equal(nav.autoFocus.matchAutoFocusesTake, true);
    assert.equal(nav.autoFocus.warningAutoFocusesRepeat, true);
    assert.equal(nav.autoFocus.unsureAutoFocusesRepeat, true);
    assert.equal(nav.autoFocus.passed, true);

    assert.equal(nav.arrowNavigation.passed, true);
    assert.deepEqual(
      nav.arrowNavigation.matchTransitions.map((t) => `${t.key}->${t.actual}`),
      [
        "ArrowLeft->Repeat",
        "ArrowRight->I took it",
        "ArrowRight->Dismiss",
        "ArrowDown->Speak off",
        "ArrowUp->Dismiss",
        "ArrowLeft->I took it",
      ],
    );
    assert.deepEqual(
      nav.arrowNavigation.warningTransitions.map((t) => `${t.key}->${t.actual}`),
      ["ArrowRight->Dismiss", "ArrowDown->Speak off", "ArrowUp->Dismiss", "ArrowLeft->Repeat"],
    );
    assert.deepEqual(
      nav.arrowNavigation.unsureTransitions.map((t) => `${t.key}->${t.actual}`),
      ["ArrowRight->Dismiss", "ArrowLeft->Repeat"],
    );

    assert.equal(nav.enterSingleActivation.repeatOnce, true);
    assert.equal(nav.enterSingleActivation.takeOnce, true);
    assert.equal(nav.enterSingleActivation.speakToggleOnOnce, true);
    assert.equal(nav.enterSingleActivation.speakToggleOffOnce, true);
    assert.equal(nav.enterSingleActivation.dismissOnce, true);
    assert.equal(nav.enterSingleActivation.passed, true);

    assert.equal(nav.historyBack.entriesAddedForThreeVerdicts, 1);
    assert.equal(nav.historyBack.hudVerdictStatePresent, true);
    assert.equal(nav.historyBack.poppedToIdleFirst, true);
    assert.equal(nav.historyBack.poppedToIdleSecond, true);
    assert.equal(nav.historyBack.exitedToShellOnIdleBack, true);
    assert.equal(nav.historyBack.trappedHistory, false);
    assert.equal(nav.historyBack.passed, true);

    assert.doesNotMatch(hudSource, /Arrow(Up|Down|Left|Right)/);
    assert.doesNotMatch(hudSource, /preventDefault\s*\(/);
    assert.doesNotMatch(hudSource, /tabIndex\s*=\s*\{?\s*[1-9]/);
    assert.match(hudSource, /history\.pushState\(\{\s*hudVerdict:\s*1\s*\},\s*""\)/);
    assert.match(hudSource, /window\.addEventListener\("popstate",\s*onPop\)/);
  });

  test("verifies /stage projector view across 1024x576, 1280x720, and 1920x1080 enforces strict read-only DOM, zero frame/audio leak, ARIA meter/status, high-contrast, and reduced-motion", () => {
    const report = JSON.parse(readRepoFile("docs/evidence/hud-stage-a11y.json")) as HudStageAuditReport;
    const stylesCss = readRepoFile("web/src/styles.css");
    const serverIndex = readRepoFile("server/src/index.ts");

    assert.deepEqual(report.summary.stageViewportsTested, ["1024x576", "1280x720", "1920x1080"]);
    assert.equal(report.stage.viewports.length, 3);

    const requiredStageStates = [
      "scripted_coaching",
      "scripted_checking",
      "scripted_verdict",
      "handoff_warning",
      "handoff_unsure",
      "handoff_scene",
      "prefers_contrast_more",
      "prefers_reduced_motion",
    ];

    for (const vp of report.stage.viewports) {
      assert.equal(vp.consoleErrors, 0, `Stage viewport ${vp.viewport} had console errors`);
      assert.equal(vp.handoffVerified, true, `Stage viewport ${vp.viewport} failed BroadcastChannel handoff`);
      const stateNames = vp.states.map((s) => s.state);
      for (const expected of requiredStageStates) {
        assert.ok(stateNames.includes(expected), `Stage viewport ${vp.viewport} missing state ${expected}`);
      }
      for (const st of vp.states) {
        assert.equal(st.violations.length, 0, `Stage ${vp.viewport} ${st.state} had axe violations`);
        assert.equal(st.violationNodes, 0);
        assert.ok(st.passes > 0);
        assert.equal(st.horizontalOverflowPx, 0, `Stage ${vp.viewport} ${st.state} overflowed horizontally`);
        assert.equal(st.verticalOverflowPx, 0, `Stage ${vp.viewport} ${st.state} overflowed vertically`);
        assert.equal(st.interactiveCount, 0, `Stage ${vp.viewport} ${st.state} must have 0 interactive controls`);
        assert.equal(st.mediaElementCount, 0, `Stage ${vp.viewport} ${st.state} must have 0 media elements`);
        assert.equal(st.frameOrAudioLeak, false, `Stage ${vp.viewport} ${st.state} leaked camera frame or audio data`);
        assert.equal(st.readOnlyFooter, true);
        assert.equal(st.meterAriaValid, true);
        assert.equal(st.statusAriaValid, true);
        if (st.state === "prefers_contrast_more" || st.state === "prefers_reduced_motion") {
          assert.equal(st.mediaMatches, true, `Stage ${vp.viewport} ${st.state} media emulation must take effect`);
        }
      }
    }

    assert.equal(STAGE_MSG_TYPES.has("frame"), false);
    assert.equal(STAGE_MSG_TYPES.has("audio"), false);

    const profile = demoProfile();
    const gs1Code = { raw: "(01)06416542005218", gtin: "06416542005218", expiry: "2027-08" };
    const initial = initialStage();
    const afterFrame = stageReduce(initial, { type: "frame", data: "RAW_JPEG" } as unknown as StageMsg);
    const afterAudio = stageReduce(initial, { type: "audio", data: "RAW_PCM16" } as unknown as StageMsg);
    assert.equal(afterFrame, initial, "stageReduce must ignore camera frame payloads");
    assert.equal(afterAudio, initial, "stageReduce must ignore audio payloads");

    const variants: StageState[] = [
      initial,
      stageReduce(stageReduce(initial, { type: "coach", cue: "rotate_left", text: "Turn it left" }), { type: "readiness", value: 0.42 }),
      stageReduce(initial, { type: "checking", phase: "start" }),
      stageReduce(
        stageReduce(initial, {
          type: "verdict",
          verdict: withCrossCheck(matchVerdict(profile, profile.meds[0]), true, ["GTIN matches"], gs1Code),
        }),
        mockMetrics({ firstAudioS: 1.1, firstAudioP50S: 1.2, turns: 3, verify: { ms: 40, source: "cache", level: "match" } }),
      ),
      stageReduce(initial, {
        type: "verdict",
        verdict: withCrossCheck(mockWarningIbuprofen(), false, ["Pack code disagrees"], gs1Code),
      }),
      stageReduce(initial, { type: "verdict", verdict: mockUnsureStrength() }),
      stageReduce(stageReduce(initial, { type: "verdict", verdict: mockScene(profile) }), { type: "readiness", value: 0.88 }),
    ];

    for (const s of variants) {
      const html = renderStage(s, { driver: "phone" });
      assert.doesNotMatch(html, /<(button|input|select|textarea|img|video|canvas|audio|iframe)\b/i);
      assert.doesNotMatch(html, /tabindex=/i);
      assert.doesNotMatch(html, /data:image|data:audio|blob:/i);
      assert.match(html, /role="meter"[^>]+aria-labelledby="stage-ready-label"[^>]+aria-valuemin="0"[^>]+aria-valuemax="100"/);
      assert.match(html, /class="stage-conn open" role="status"/);
      assert.match(html, /Read-only view\. No camera images are shown or sent here\./);
    }

    const onStageMatch = serverIndex.match(/function onStage\([\s\S]*?\n\}/);
    assert.ok(onStageMatch, "Expected onStage handler in server/src/index.ts");
    assert.doesNotMatch(onStageMatch[0], /\.on\(\s*["']message["']/, "Server /hud-ws?role=stage must ignore incoming client messages");

    const hcMatch = stylesCss.match(/@media\s*\(prefers-contrast:\s*more\)\s*\{\s*:root\s*\{([^}]+)\}\s*\}/);
    assert.ok(hcMatch, "Expected @media (prefers-contrast: more) token block in styles.css");
    const hcTokens = hcMatch[1];
    assert.match(hcTokens, /--bg:\s*#000\b/);
    assert.match(hcTokens, /--surface:\s*#000\b/);
    assert.match(hcTokens, /--border:\s*#fff\b/i);
    assert.match(hcTokens, /--text:\s*#fff\b/i);

    for (const [tokenName, hex] of [
      ["--text", "#ffffff"],
      ["--muted", "#e6e6e6"],
      ["--accent", "#ffe14d"],
      ["--match", "#6dffbe"],
      ["--warning", "#ffb070"],
      ["--unsure", "#c2dcff"],
    ] as const) {
      const ratio = contrastRatio(hex, "#000000");
      assert.ok(ratio >= 7, `prefers-contrast: more token ${tokenName} (${hex}) contrast on #000 is ${ratio.toFixed(2)}, expected >= 7`);
    }

    assert.match(
      stylesCss,
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\*,\s*\*::before,\s*\*::after\s*\{[^}]*animation:\s*none\s*!important;[^}]*transition:\s*none\s*!important;[^}]*scroll-behavior:\s*auto\s*!important;/s,
    );
  });

  test("enforces zero code comments and zero em dashes across all three new audit, evidence, and test files", () => {
    const targetFiles = [
      "scripts/hud-stage-a11y-audit.mjs",
      "docs/evidence/hud-stage-a11y.json",
      "web/test/hudSpatialNavAndStageAxeContract.test.ts",
    ];

    for (const relPath of targetFiles) {
      const content = readRepoFile(relPath);
      assert.equal(content.includes(LINE_COMMENT), false, `${relPath} must contain zero line comments`);
      assert.equal(content.includes(BLOCK_OPEN), false, `${relPath} must contain zero block comment openers`);
      assert.equal(content.includes(BLOCK_CLOSE), false, `${relPath} must contain zero block comment closers`);
      assert.equal(content.includes(HTML_COMMENT), false, `${relPath} must contain zero HTML comments`);
      assert.equal(content.includes(EM_DASH), false, `${relPath} must contain zero em dashes`);
      assert.equal(content.includes(ESCAPED_EM_DASH), false, `${relPath} must contain zero escaped em dashes`);
    }
  });
});
