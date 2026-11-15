import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF_FILE = fileURLToPath(import.meta.url);
const TEST_DIR = path.dirname(SELF_FILE);
const REPO_DIR = path.resolve(TEST_DIR, "..", "..");

const LINE_COMMENT = String.fromCharCode(47, 47);
const BLOCK_COMMENT = String.fromCharCode(47, 42);
const HTML_COMMENT = String.fromCharCode(60, 33, 45, 45);
const EM_DASH = String.fromCharCode(8212);
const ESCAPED_EM_DASH = ["\\u", "2014"].join("");
const MIDDOT = String.fromCharCode(183);

const SECRET_PREFIXES = [
  ["AIza", "Sy"].join(""),
  ["AQ.", "Ab"].join(""),
  ["sk_", "live_"].join(""),
  ["sk_", "test_"].join(""),
  ["ghp", "_"].join(""),
  ["ya29", "."].join(""),
];

type HeightStats = {
  count: number;
  minHeightPx: number;
  medianHeightPx: number;
  maxHeightPx: number;
  allMeet48px?: boolean;
};

type Sub48Control = {
  journey: string;
  surface: "phone" | "hud";
  tag: string;
  type: string | null;
  name: string;
  widthPx: number;
  heightPx: number;
};

type ActiveFocusSnapshot = {
  tag: string | null;
  id: string | null;
  tabIndex: string | null;
  text: string;
};

type AxTreeJourneyCheck = {
  id: string;
  category: "axtree_and_touch_targets";
  journey: string;
  surface: "phone" | "hud";
  passed: boolean;
  title: string;
  h1Text: string;
  h1TabIndex: string | null;
  activeFocus: ActiveFocusSnapshot;
  axNodeCount: number;
  visibleAxNodeCount: number;
  interactiveAxNodeCount: number;
  unnamedInteractiveCount: number;
  headings: Array<{ level: number; name: string }>;
  headingOrderValid: boolean;
  readingOrderControls: string[];
  dialogNodes: Array<{ name: string; modal: boolean }>;
  ignoredBackgroundAxNodes: number;
  modalOpen: boolean;
  touchTargets: {
    allInteractive: HeightStats;
    primaryButtons: HeightStats & { allMeet48px: boolean };
    allButtons: HeightStats & { allMeet48px: boolean };
    sub48pxControls: Sub48Control[];
  };
  sceneDetails?: {
    itemCount: number;
    currentCount: number;
    overlayBoxCount: number;
    overlayHidden: boolean;
  };
  initialScreenTransitionFocus?: {
    title: string;
    activeTag: string | null;
    activeTabIndex: string | null;
    activeText: string;
  };
};

type FocusOrModalCheck = {
  id: string;
  category: "focus_handoff_and_modal_trap";
  journey: string;
  passed: boolean;
  activeElement?: ActiveFocusSnapshot;
  modalOpen?: boolean;
  initialFocus?: ActiveFocusSnapshot;
  ignoredBackgroundAxNodes?: number;
  outsideControlsExposedInAxTree?: boolean;
  closedOnEscape?: boolean;
  escapeAnnouncement?: string[];
};

type LiveRegionCheck = {
  id: string;
  category: "live_region_single_announcement";
  action: string;
  passed: boolean;
  expectedRegion?: "polite" | "assertive";
  expectedText?: string;
  nonEmptyMutationCount?: number;
  observedMessages?: string[];
  finalRegionText?: string;
  emptyOrDuplicateClobber?: boolean;
  remainingHoldupKeysCount?: number;
};

type HudNeuralBandCheck = {
  id: string;
  category: "hud_neural_band_and_bystander_privacy";
  journey: string;
  passed: boolean;
  initialVerdictFocus: string;
  tabOrderFromAction: string[];
  enterTogglesSpeakOn: boolean;
  spokenUtterancesRecorded: number;
  cancelOnSpeakOff: boolean;
  dismissedOnEscape: boolean;
  cancelOnEscape: boolean;
  dismissedOnEnter: boolean;
  cancelOnDismissEnter: boolean;
  hudLiveRegionUpdatesObserved: number;
};

type AuditCheck = AxTreeJourneyCheck | FocusOrModalCheck | LiveRegionCheck | HudNeuralBandCheck;

type TalkBackAuditReport = {
  tool: string;
  engine: string;
  viewportPhone: {
    width: number;
    height: number;
    hasTouch: boolean;
    isMobile: boolean;
    device: string;
  };
  viewportHud: {
    width: number;
    height: number;
    device: string;
  };
  when: string;
  allPassed: boolean;
  summary: {
    journeysAudited: number;
    phoneJourneysAudited: number;
    hudJourneysAudited: number;
    totalChecks: number;
    passedChecks: number;
    failedChecks: number;
    totalAxNodesInspected: number;
    totalInteractiveAxNodes: number;
    unnamedInteractiveAxNodes: number;
    titleTransitionsVerified: string[];
    verdictFocusHandoffsVerified: number;
    modalDialogsVerified: number;
    touchTargets: {
      phonePrimaryButtons: HeightStats & { allMeet48px: boolean };
      phoneAllButtons: HeightStats & { allMeet48px: boolean };
      phoneAllInteractive: HeightStats;
      hudPrimaryButtons: HeightStats & { allMeet48px: boolean };
      hudAllInteractive: HeightStats;
      sub48pxSecondaryControls: Sub48Control[];
    };
    liveRegionAnnouncementsVerified: number;
    liveRegionDuplicateOrEmptyClobbers: number;
    hudSpeechCancelChecksVerified: number;
  };
  checks: AuditCheck[];
};

function readRepoFile(relPath: string): string {
  return fs.readFileSync(path.join(REPO_DIR, relPath), "utf8");
}

function assertCleanHygiene(source: string, label: string): void {
  assert.equal(source.includes(LINE_COMMENT), false, `${label} must contain zero line comments`);
  assert.equal(source.includes(BLOCK_COMMENT), false, `${label} must contain zero block comments`);
  assert.equal(source.includes(HTML_COMMENT), false, `${label} must contain zero HTML comments`);
  assert.equal(source.includes(EM_DASH), false, `${label} must contain zero em dashes`);
  assert.equal(source.includes(ESCAPED_EM_DASH), false, `${label} must contain zero escaped em dashes`);
  for (const prefix of SECRET_PREFIXES) {
    assert.equal(source.includes(prefix), false, `${label} must not contain secret prefix "${prefix}"`);
  }
}

describe("TalkBack AXTree, live-region single announcement, verdict focus handoff, and 48px touch-target audit contract", () => {
  const scriptPath = path.join(REPO_DIR, "scripts/talkback-audit.mjs");
  const evidencePath = path.join(REPO_DIR, "docs/evidence/talkback-audit.json");

  test("scripts/talkback-audit.mjs and docs/evidence/talkback-audit.json exist and satisfy strict source hygiene", () => {
    assert.equal(fs.existsSync(scriptPath), true, "scripts/talkback-audit.mjs must exist");
    assert.equal(fs.existsSync(evidencePath), true, "docs/evidence/talkback-audit.json must exist");
    assert.ok(fs.statSync(scriptPath).size > 1000, "scripts/talkback-audit.mjs must be non-trivial");
    assert.ok(fs.statSync(evidencePath).size > 1000, "docs/evidence/talkback-audit.json must be non-trivial");

    const scriptSource = readRepoFile("scripts/talkback-audit.mjs");
    const evidenceSource = readRepoFile("docs/evidence/talkback-audit.json");
    const selfSource = fs.readFileSync(SELF_FILE, "utf8");

    assertCleanHygiene(scriptSource, "scripts/talkback-audit.mjs");
    assertCleanHygiene(evidenceSource, "docs/evidence/talkback-audit.json");
    assertCleanHygiene(selfSource, "web/test/talkbackAxTreeAndTouchTargetA11y.test.ts");

    assert.ok(scriptSource.includes("Accessibility.enable"), "Audit script must enable CDP Accessibility domain");
    assert.ok(scriptSource.includes("Accessibility.getFullAXTree"), "Audit script must inspect full Blink AXTree via CDP");
    assert.ok(scriptSource.includes("MutationObserver"), "Audit script must observe live-region DOM mutations");
    assert.ok(scriptSource.includes("width: 390, height: 844"), "Audit script must test 390x844 mobile viewport");
    assert.ok(scriptSource.includes("width: 600, height: 600"), "Audit script must test 600x600 Ray-Ban Display HUD viewport");
    assert.ok(scriptSource.includes('GEMINI_API_KEY: ""'), "Audit script must run keyless in mock mode");
  });

  test("top-level summary passes 100% of checks with zero failed checks and zero unnamed interactive AXTree nodes", () => {
    const report = JSON.parse(readRepoFile("docs/evidence/talkback-audit.json")) as TalkBackAuditReport;

    assert.equal(report.allPassed, true, "allPassed must be true");
    assert.match(report.tool, /Playwright.*Accessibility\.getFullAXTree.*MutationObserver/);
    assert.match(report.engine, /Headless Chromium/);
    assert.equal(Number.isNaN(Date.parse(report.when)), false, "when must be a valid ISO timestamp");

    assert.equal(report.viewportPhone.width, 390);
    assert.equal(report.viewportPhone.height, 844);
    assert.equal(report.viewportPhone.hasTouch, true);
    assert.equal(report.viewportPhone.isMobile, true);
    assert.match(report.viewportPhone.device, /Android.*Pixel/i);

    assert.equal(report.viewportHud.width, 600);
    assert.equal(report.viewportHud.height, 600);
    assert.match(report.viewportHud.device, /Ray-Ban Display/i);

    const { summary, checks } = report;
    assert.equal(summary.failedChecks, 0, "failedChecks must be 0");
    assert.equal(summary.passedChecks, summary.totalChecks, "passedChecks must equal totalChecks");
    assert.equal(summary.totalChecks, checks.length, "summary.totalChecks must match checks array length");
    assert.ok(summary.totalChecks >= 35, `Expected at least 35 total checks, got ${summary.totalChecks}`);

    assert.equal(summary.phoneJourneysAudited, 17);
    assert.equal(summary.hudJourneysAudited, 2);
    assert.equal(summary.journeysAudited, summary.phoneJourneysAudited + summary.hudJourneysAudited);

    assert.equal(summary.unnamedInteractiveAxNodes, 0, "unnamedInteractiveAxNodes must be 0 across all journeys");
    assert.ok(summary.totalInteractiveAxNodes >= 140, "Expected >= 140 interactive AXTree nodes inspected");
    assert.ok(summary.totalAxNodesInspected >= 2000, "Expected >= 2000 total AXTree nodes inspected");

    for (const check of checks) {
      assert.equal(check.passed, true, `Check "${check.id}" must pass`);
    }
  });

  test("verifies document.title transitions and heading order across HoldUp, Check, Profile, and Privacy journeys", () => {
    const report = JSON.parse(readRepoFile("docs/evidence/talkback-audit.json")) as TalkBackAuditReport;
    const expectedTitles = [
      "HoldUp",
      `Check ${MIDDOT} HoldUp`,
      `Profile ${MIDDOT} HoldUp`,
      `Privacy ${MIDDOT} HoldUp`,
    ];

    assert.deepEqual(
      report.summary.titleTransitionsVerified,
      expectedTitles,
      "titleTransitionsVerified must cover HoldUp, Check, Profile, and Privacy",
    );

    const axChecks = report.checks.filter(
      (c): c is AxTreeJourneyCheck => c.category === "axtree_and_touch_targets",
    );
    assert.equal(axChecks.length, report.summary.journeysAudited);

    const summedInteractive = axChecks.reduce((acc, c) => acc + c.interactiveAxNodeCount, 0);
    const summedNodes = axChecks.reduce((acc, c) => acc + c.axNodeCount, 0);
    assert.equal(summedInteractive, report.summary.totalInteractiveAxNodes);
    assert.equal(summedNodes, report.summary.totalAxNodesInspected);

    for (const ax of axChecks) {
      assert.equal(ax.unnamedInteractiveCount, 0, `Journey "${ax.journey}" must have 0 unnamed interactive AX nodes`);
      assert.equal(ax.headingOrderValid, true, `Journey "${ax.journey}" must preserve valid heading hierarchy`);
      assert.equal(
        ax.readingOrderControls.length,
        ax.interactiveAxNodeCount,
        `Journey "${ax.journey}" readingOrderControls must list every interactive AX node`,
      );
      for (const entry of ax.readingOrderControls) {
        const colonIdx = entry.indexOf(":");
        assert.ok(colonIdx > 0, `Expected "role: name" format in "${entry}"`);
        const accessibleName = entry.slice(colonIdx + 1).trim();
        assert.ok(accessibleName.length > 0, `Interactive AX node in "${ax.journey}" must have a non-empty name`);
      }
    }

    const byJourney = new Map(axChecks.map((c) => [c.journey, c]));
    for (const onbJourney of [
      "onboarding-welcome",
      "onboarding-consent-1",
      "onboarding-consent-2",
      "onboarding-consent-3",
      "onboarding-permission-step",
      "onboarding-permission-recovery",
      "access-key-401",
    ]) {
      const item = byJourney.get(onbJourney);
      assert.ok(item, `Missing audited phone journey "${onbJourney}"`);
      assert.equal(item.title, "HoldUp");
      assert.equal(item.activeFocus.tag, "h1");
      assert.equal(item.activeFocus.tabIndex, "-1");
    }

    const checkIdle = byJourney.get("check-idle");
    assert.ok(checkIdle, "Missing check-idle journey");
    assert.equal(checkIdle.title, `Check ${MIDDOT} HoldUp`);
    assert.equal(checkIdle.activeFocus.tag, "h1");
    assert.equal(checkIdle.activeFocus.tabIndex, "-1");

    const profile = byJourney.get("profile");
    assert.ok(profile && profile.initialScreenTransitionFocus, "Missing profile journey transition focus");
    assert.equal(profile.title, `Profile ${MIDDOT} HoldUp`);
    assert.equal(profile.initialScreenTransitionFocus.title, `Profile ${MIDDOT} HoldUp`);
    assert.equal(profile.initialScreenTransitionFocus.activeTag, "h1");
    assert.equal(profile.initialScreenTransitionFocus.activeTabIndex, "-1");

    const privacy = byJourney.get("privacy");
    assert.ok(privacy, "Missing privacy journey");
    assert.equal(privacy.title, `Privacy ${MIDDOT} HoldUp`);
    assert.equal(privacy.activeFocus.tag, "h1");
    assert.equal(privacy.activeFocus.tabIndex, "-1");
  });

  test("closes QA Re-test #4: >= 4 verdict focus handoffs to h2#verdict-h, modal AXTree background isolation, and 0 live-region clobbers", () => {
    const qaDoc = readRepoFile("docs/QA.md");
    assert.ok(
      qaDoc.includes("4. TalkBack on: start a check; the verdict is announced once (not duplicated by the captions); focus lands on the verdict heading."),
      "docs/QA.md must list Re-test #4 for TalkBack verdict announcement and heading focus",
    );

    const report = JSON.parse(readRepoFile("docs/evidence/talkback-audit.json")) as TalkBackAuditReport;
    assert.ok(
      report.summary.verdictFocusHandoffsVerified >= 4,
      `Expected verdictFocusHandoffsVerified >= 4, got ${report.summary.verdictFocusHandoffsVerified}`,
    );

    const focusChecks = report.checks.filter(
      (c): c is FocusOrModalCheck => c.category === "focus_handoff_and_modal_trap",
    );
    const verdictFocusIds = [
      "focus-handoff-verdict-match",
      "focus-handoff-verdict-warning",
      "focus-handoff-verdict-unsure",
      "focus-handoff-verdict-scene",
    ];
    for (const id of verdictFocusIds) {
      const check = focusChecks.find((c) => c.id === id);
      assert.ok(check && check.activeElement, `Expected verdict focus check "${id}"`);
      assert.equal(check.passed, true);
      assert.equal(check.activeElement.tag, "h2");
      assert.equal(check.activeElement.id, "verdict-h");
      assert.equal(check.activeElement.tabIndex, "-1");
      assert.ok(check.activeElement.text.length > 0);
    }

    const sceneJourney = report.checks.find(
      (c): c is AxTreeJourneyCheck => c.id === "axtree-check-verdict-scene",
    );
    assert.ok(sceneJourney?.sceneDetails, "Expected sceneDetails on axtree-check-verdict-scene");
    assert.equal(sceneJourney.sceneDetails.itemCount, 3);
    assert.equal(sceneJourney.sceneDetails.currentCount, 1);
    assert.equal(sceneJourney.sceneDetails.overlayHidden, true);

    assert.ok(report.summary.modalDialogsVerified >= 2, "Expected both AddSheet and MedEditor modals verified");
    for (const modalId of ["modal-trap-and-escape-addsheet", "modal-trap-and-escape-mededitor"]) {
      const modalCheck = focusChecks.find((c) => c.id === modalId);
      assert.ok(modalCheck, `Expected modal trap check "${modalId}"`);
      assert.equal(modalCheck.passed, true);
      assert.equal(modalCheck.modalOpen, true);
      assert.ok((modalCheck.ignoredBackgroundAxNodes ?? 0) > 0, `${modalId} must suppress background AXTree nodes`);
      assert.equal(modalCheck.outsideControlsExposedInAxTree, false);
      assert.equal(modalCheck.closedOnEscape, true);
    }
    const addSheetModal = focusChecks.find((c) => c.id === "modal-trap-and-escape-addsheet")!;
    assert.ok(addSheetModal.escapeAnnouncement?.includes("Not added."));

    assert.equal(
      report.summary.liveRegionDuplicateOrEmptyClobbers,
      0,
      "liveRegionDuplicateOrEmptyClobbers must be 0",
    );
    assert.ok(report.summary.liveRegionAnnouncementsVerified >= 10);

    const liveChecks = report.checks.filter(
      (c): c is LiveRegionCheck => c.category === "live_region_single_announcement" && c.id.startsWith("live-"),
    );
    assert.equal(liveChecks.length, report.summary.liveRegionAnnouncementsVerified);
    for (const lc of liveChecks) {
      assert.equal(lc.passed, true, `Live-region check "${lc.id}" must pass`);
      assert.equal(lc.nonEmptyMutationCount, 1, `"${lc.id}" must emit exactly 1 non-empty live-region mutation`);
      assert.equal(lc.emptyOrDuplicateClobber, false, `"${lc.id}" must not clobber or duplicate announcements`);
      assert.equal(lc.finalRegionText, lc.expectedText);
    }

    const zeroLeakCheck = report.checks.find(
      (c): c is LiveRegionCheck => c.id === "privacy-zero-leak-storage-after-delete",
    );
    assert.ok(zeroLeakCheck, "Expected privacy-zero-leak-storage-after-delete check");
    assert.equal(zeroLeakCheck.passed, true);
    assert.equal(zeroLeakCheck.remainingHoldupKeysCount, 0);
  });

  test("enforces >= 48px touch targets for all phone buttons, >= 60px for HUD primary buttons, and HUD speech cancellation", () => {
    const report = JSON.parse(readRepoFile("docs/evidence/talkback-audit.json")) as TalkBackAuditReport;
    const { touchTargets } = report.summary;

    assert.equal(touchTargets.phonePrimaryButtons.allMeet48px, true, "phonePrimaryButtons.allMeet48px must be true");
    assert.ok(touchTargets.phonePrimaryButtons.minHeightPx >= 48);
    assert.ok(touchTargets.phonePrimaryButtons.count > 0);

    assert.equal(touchTargets.phoneAllButtons.allMeet48px, true, "phoneAllButtons.allMeet48px must be true");
    assert.ok(touchTargets.phoneAllButtons.minHeightPx >= 48);
    assert.ok(touchTargets.phoneAllButtons.count >= touchTargets.phonePrimaryButtons.count);

    assert.equal(touchTargets.hudPrimaryButtons.allMeet48px, true, "hudPrimaryButtons.allMeet48px must be true");
    assert.ok(touchTargets.hudPrimaryButtons.minHeightPx >= 60, "HUD primary action buttons must meet >= 60px");
    assert.equal(touchTargets.hudPrimaryButtons.count, 6);

    const phoneJourneys = report.checks.filter(
      (c): c is AxTreeJourneyCheck => c.category === "axtree_and_touch_targets" && c.surface === "phone",
    );
    for (const pj of phoneJourneys) {
      assert.equal(pj.touchTargets.primaryButtons.allMeet48px, true, `Phone journey "${pj.journey}" primary buttons < 48px`);
      assert.equal(pj.touchTargets.allButtons.allMeet48px, true, `Phone journey "${pj.journey}" has a button < 48px`);
    }

    const phoneSub48Buttons = touchTargets.sub48pxSecondaryControls.filter(
      (c) => c.surface === "phone" && c.tag === "button",
    );
    assert.equal(phoneSub48Buttons.length, 0, "Zero phone <button> controls may be shorter than 48px");

    const hudSub48 = touchTargets.sub48pxSecondaryControls.filter((c) => c.surface === "hud");
    for (const item of hudSub48) {
      assert.ok(item.heightPx >= 44, `HUD secondary control "${item.name}" must remain >= 44px, got ${item.heightPx}`);
    }

    assert.equal(report.summary.hudSpeechCancelChecksVerified, 3);
    const hudCheck = report.checks.find(
      (c): c is HudNeuralBandCheck => c.id === "hud-neural-band-and-bystander-speech",
    );
    assert.ok(hudCheck, "Expected hud-neural-band-and-bystander-speech check");
    assert.equal(hudCheck.passed, true);
    assert.equal(hudCheck.initialVerdictFocus, "I took it");
    assert.deepEqual(hudCheck.tabOrderFromAction, ["I took it", "Dismiss", "Speak off"]);
    assert.equal(hudCheck.enterTogglesSpeakOn, true);
    assert.equal(hudCheck.cancelOnSpeakOff, true);
    assert.equal(hudCheck.dismissedOnEscape, true);
    assert.equal(hudCheck.cancelOnEscape, true);
    assert.equal(hudCheck.dismissedOnEnter, true);
    assert.equal(hudCheck.cancelOnDismissEnter, true);
  });
});
