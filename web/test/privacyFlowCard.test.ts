import React, { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BYSTANDER_RED_TEAM_SCENES,
  IDLE_AUTO_STOP_SEC,
  MAX_RING_FRAMES,
  PrivacyFlowCard,
  summarizePrivacyBoundaries,
  type PrivacyFlowCardProps,
  type PrivacyZoneId
} from "../src/components/PrivacyFlowCard.tsx";
import type { ConsentRecord, DeviceState, Profile } from "../src/types.ts";

(globalThis as Record<string, unknown>).React = React;

type TestFn = (name: string, fn: () => void | Promise<void>) => Promise<void>;

type AssertStrict = {
  ok(value: unknown, message?: string): asserts value;
  equal<T>(actual: T, expected: T, message?: string): void;
  notEqual<T>(actual: T, expected: T, message?: string): void;
  deepEqual<T>(actual: T, expected: T, message?: string): void;
  match(value: string, regExp: RegExp, message?: string): void;
  doesNotMatch(value: string, regExp: RegExp, message?: string): void;
};

type FsModule = {
  readFileSync(path: URL | string, encoding: "utf8"): string;
};

const nodeTestSpec: string = "node:test";
const nodeAssertSpec: string = "node:assert/strict";
const nodeFsSpec: string = "node:fs";

const { test } = (await import(nodeTestSpec)) as { test: TestFn };
const assert: AssertStrict = (await import(nodeAssertSpec)) as AssertStrict;
const { readFileSync } = (await import(nodeFsSpec)) as FsModule;

const EM_DASH = "\u2014";
const EN_DASH = "\u2013";
const LINE_COMMENT = "\x2f\x2f";
const BLOCK_COMMENT_OPEN = "\x2f*";
const BLOCK_COMMENT_CLOSE = "*\x2f";

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    meds: [
      {
        id: "aml",
        name: "Amlodipin Orion",
        ingredient: "amlodipine",
        strength: "5 mg",
        schedule: ["evening"],
        barcode: "6432100012345"
      },
      {
        id: "met",
        name: "Metforem",
        ingredient: "metformin",
        strength: "500 mg",
        schedule: ["morning", "evening"]
      },
      {
        id: "pan",
        name: "Panadol",
        ingredient: "paracetamol",
        strength: "500 mg",
        schedule: ["as needed"]
      }
    ],
    allergies: ["hazelnut", "peanut"],
    avoid: ["NSAIDs"],
    doseLog: [
      { medId: "met", ts: 1763107200000 },
      { medId: "aml", ts: 1763143200000 }
    ],
    lang: "en",
    ...overrides
  };
}

function makeConsent(overrides: Partial<ConsentRecord> = {}): ConsentRecord {
  return {
    accepted: true,
    acceptedAt: 1763100000000,
    version: "1",
    ...overrides
  };
}

function makeDevice(overrides: Partial<DeviceState> = {}): DeviceState {
  return {
    connected: true,
    worn: true,
    battery: 82,
    streaming: true,
    source: "glasses",
    ...overrides
  };
}

function renderCard(overrides: Partial<PrivacyFlowCardProps> = {}): string {
  const props: PrivacyFlowCardProps = {
    profile: makeProfile(),
    consent: makeConsent(),
    cameraActive: true,
    autoStopRemainingSec: 38,
    device: makeDevice(),
    lang: "en",
    ...overrides
  };
  return renderToStaticMarkup(createElement(PrivacyFlowCard, props));
}

function extractOpeningTagByAttr(html: string, attrName: string, attrValue: string): string {
  const escapedAttr = attrName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedVal = attrValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `<([a-z0-9]+)\\b[^>]*\\b${escapedAttr}="${escapedVal}"[^>]*>`,
    "i"
  );
  const match = pattern.exec(html);
  assert.ok(match, `Expected element with ${attrName}="${attrValue}"`);
  return match[0];
}

function extractOpeningTagsByClass(html: string, classToken: string): string[] {
  const escaped = classToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<([a-z0-9]+)\\b[^>]*class="[^"]*\\b${escaped}\\b[^"]*"[^>]*>`, "gi");
  const out: string[] = [];
  let match: RegExpExecArray | null = pattern.exec(html);
  while (match !== null) {
    out.push(match[0]);
    match = pattern.exec(html);
  }
  return out;
}

test("summarizePrivacyBoundaries computes accurate counts and statuses across all 4 zones", () => {
  assert.equal(MAX_RING_FRAMES, 8);
  assert.equal(IDLE_AUTO_STOP_SEC, 45);
  assert.equal(BYSTANDER_RED_TEAM_SCENES, 8);

  const activeSummary = summarizePrivacyBoundaries({
    profile: makeProfile(),
    consent: makeConsent({ accepted: true, version: "1.2" }),
    cameraActive: true,
    autoStopRemainingSec: 38,
    device: makeDevice({ connected: true, streaming: true })
  });

  assert.deepEqual(activeSummary.onDeviceStorage, {
    medCount: 3,
    allergyCount: 2,
    avoidCount: 1,
    doseLogCount: 2,
    consentAccepted: true,
    consentVersion: "1.2",
    cloudDbRows: 0
  });

  assert.deepEqual(activeSummary.ephemeralHubRam, {
    maxRingFrames: 8,
    idleAutoStopSec: 45,
    cameraActive: true,
    activeCountdownSec: 38,
    clearedOnDisconnect: true,
    serverDiskFiles: 0
  });

  assert.deepEqual(activeSummary.blindModelReader, {
    profileFieldsSentToReadLabel: 0,
    bystanderFaceIgnoreEnforced: true,
    bystanderPiiLeaks: 0,
    bystanderRedTeamScenes: 8,
    maxFramesPerVerify: 3
  });

  assert.deepEqual(activeSummary.loanerGlassesHud, {
    hudPersistentBytes: 0,
    captureLedActive: true,
    glassesConnected: true,
    glassesStreaming: true
  });

  const idlePending = summarizePrivacyBoundaries({
    profile: makeProfile({ meds: [], allergies: [], avoid: [], doseLog: [] }),
    consent: null,
    cameraActive: false,
    autoStopRemainingSec: 29,
    device: makeDevice({ connected: true, streaming: true })
  });

  assert.equal(idlePending.onDeviceStorage.medCount, 0);
  assert.equal(idlePending.onDeviceStorage.allergyCount, 0);
  assert.equal(idlePending.onDeviceStorage.avoidCount, 0);
  assert.equal(idlePending.onDeviceStorage.doseLogCount, 0);
  assert.equal(idlePending.onDeviceStorage.consentAccepted, false);
  assert.equal(idlePending.onDeviceStorage.consentVersion, null);
  assert.equal(idlePending.onDeviceStorage.cloudDbRows, 0);

  assert.equal(idlePending.ephemeralHubRam.cameraActive, false);
  assert.equal(idlePending.ephemeralHubRam.activeCountdownSec, null);
  assert.equal(idlePending.loanerGlassesHud.captureLedActive, false);
  assert.equal(idlePending.loanerGlassesHud.hudPersistentBytes, 0);

  const unacceptedRecord = summarizePrivacyBoundaries({
    profile: makeProfile(),
    consent: makeConsent({ accepted: false, acceptedAt: null, version: "1" }),
    cameraActive: true,
    autoStopRemainingSec: 99,
    device: makeDevice({ connected: true, streaming: false })
  });
  assert.equal(unacceptedRecord.onDeviceStorage.consentAccepted, false);
  assert.equal(unacceptedRecord.ephemeralHubRam.activeCountdownSec, 45);
  assert.equal(unacceptedRecord.loanerGlassesHud.captureLedActive, false);

  const disconnectedGlasses = summarizePrivacyBoundaries({
    profile: makeProfile(),
    consent: makeConsent(),
    cameraActive: true,
    autoStopRemainingSec: null,
    device: makeDevice({ connected: false, streaming: true })
  });
  assert.equal(disconnectedGlasses.ephemeralHubRam.activeCountdownSec, null);
  assert.equal(disconnectedGlasses.loanerGlassesHud.captureLedActive, false);
});

test("PrivacyFlowCard SSR renders accessible section, 4 distinct zone tiles, camera/consent states, and >= 56px action buttons", () => {
  const noopOpen = (): void => {};
  const noopWipe = (): void => {};

  const activeHtml = renderCard({
    onOpenPrivacyModal: noopOpen,
    onWipeAll: noopWipe
  });

  assert.match(
    activeHtml,
    /^<section\b[^>]*aria-labelledby="privacy-flow-card-heading"[^>]*lang="en"/
  );
  assert.ok(activeHtml.includes('role="status"'));
  assert.ok(activeHtml.includes('aria-live="polite"'));
  assert.ok(activeHtml.includes('data-consent-state="accepted"'));
  assert.ok(activeHtml.includes('data-camera-state="active"'));
  assert.ok(activeHtml.includes('data-capture-led="active"'));
  assert.ok(activeHtml.includes("Consent Active (v1)"));
  assert.ok(activeHtml.includes("Camera Active (38s auto-stop)"));
  assert.ok(activeHtml.includes("3 meds, 2 allergies, 1 avoid rules, 2 doses, 0 cloud DB rows"));
  assert.ok(activeHtml.includes("0 profile fields sent to readLabel(), 0/8 bystander PII leaks"));
  assert.ok(activeHtml.includes("0 B persistent on /hud, Hardware Capture LED ON (DAT 1.0.1)"));

  const expectedZones: Record<PrivacyZoneId, string> = {
    onDeviceStorage: "accepted",
    ephemeralHubRam: "active",
    blindModelReader: "isolated",
    loanerGlassesHud: "led_active"
  };

  const svgs = new Set<string>();
  for (const [zoneId, expectedState] of Object.entries(expectedZones)) {
    const tileTag = extractOpeningTagByAttr(activeHtml, "data-zone-id", zoneId);
    assert.ok(
      tileTag.includes(`data-zone-state="${expectedState}"`),
      `Expected data-zone-state="${expectedState}" on ${zoneId}`
    );

    const startIdx = activeHtml.indexOf(`data-zone-id="${zoneId}"`);
    const svgStart = activeHtml.indexOf("<svg", startIdx);
    const svgEnd = activeHtml.indexOf("</svg>", svgStart);
    assert.ok(svgStart >= 0 && svgEnd > svgStart, `Missing SVG icon in ${zoneId}`);
    const svgMarkup = activeHtml.slice(svgStart, svgEnd + 6);
    assert.ok(svgMarkup.includes('aria-hidden="true"'));
    svgs.add(svgMarkup);
  }
  assert.equal(svgs.size, 4, "All 4 privacy boundary zones must render distinct SVG icons");

  const openButtons = extractOpeningTagsByClass(activeHtml, "privacy-open-modal-btn");
  const wipeButtons = extractOpeningTagsByClass(activeHtml, "privacy-wipe-all-btn");
  assert.equal(openButtons.length, 1);
  assert.equal(wipeButtons.length, 1);

  for (const btnTag of [...openButtons, ...wipeButtons]) {
    assert.ok(btnTag.startsWith("<button"));
    assert.ok(btnTag.includes('type="button"'));
    assert.match(btnTag, /min-height:\s*56px/i);
    assert.match(btnTag, /min-width:\s*56px/i);
  }

  const idlePendingHtml = renderCard({
    consent: null,
    cameraActive: false,
    autoStopRemainingSec: null,
    device: makeDevice({ connected: false, streaming: false })
  });
  assert.ok(idlePendingHtml.includes('data-consent-state="pending"'));
  assert.ok(idlePendingHtml.includes('data-camera-state="idle"'));
  assert.ok(idlePendingHtml.includes('data-capture-led="inactive"'));
  assert.ok(idlePendingHtml.includes("Consent Pending"));
  assert.ok(idlePendingHtml.includes("Camera Off (RAM Ring Empty)"));
  assert.ok(idlePendingHtml.includes("CONSENT REQUIRED"));
  assert.ok(idlePendingHtml.includes("IDLE / 0 RAM FRAMES"));
  assert.ok(idlePendingHtml.includes("0 B HUD / LED OFF"));
  assert.equal(extractOpeningTagsByClass(idlePendingHtml, "privacy-open-modal-btn").length, 0);
  assert.equal(extractOpeningTagsByClass(idlePendingHtml, "privacy-wipe-all-btn").length, 0);
  assert.equal(idlePendingHtml.includes("privacy-flow-actions"), false);
});

test("PrivacyFlowCard localizes across en, fi, and sv with en fallback", () => {
  const noop = (): void => {};
  const makeLocalized = (lang: string): string =>
    renderCard({
      lang,
      onOpenPrivacyModal: noop,
      onWipeAll: noop
    });

  const enHtml = makeLocalized("en");
  const fiHtml = makeLocalized("fi");
  const svHtml = makeLocalized("sv");
  const fiRegionalHtml = makeLocalized("fi-FI");
  const svRegionalHtml = makeLocalized("sv-SE");
  const deFallbackHtml = makeLocalized("de");

  assert.notEqual(enHtml, fiHtml);
  assert.notEqual(enHtml, svHtml);
  assert.notEqual(fiHtml, svHtml);
  assert.equal(fiRegionalHtml, fiHtml);
  assert.equal(svRegionalHtml, svHtml);
  assert.equal(deFallbackHtml, enHtml);

  assert.ok(fiHtml.includes('lang="fi"'));
  assert.ok(fiHtml.includes("4 tiukkaa tietosuoja- ja suostumusrajaa"));
  assert.ok(fiHtml.includes("3 lääkettä, 2 allergiaa, 1 välttösääntöä, 2 annosta, 0 pilviriviä"));
  assert.ok(fiHtml.includes("Tietosuoja ja suostumus"));
  assert.ok(fiHtml.includes("Poista kaikki tiedot tältä laitteelta"));

  assert.ok(svHtml.includes('lang="sv"'));
  assert.ok(svHtml.includes("4 strikta integritets- och samtyckesgränser"));
  assert.ok(svHtml.includes("3 läkemedel, 2 allergier, 1 undvik-regler, 2 doser, 0 molnrader"));
  assert.ok(svHtml.includes("Integritet och samtycke"));
  assert.ok(svHtml.includes("Radera all data från den här enheten"));
});

test("PrivacyFlowCard action buttons invoke onOpenPrivacyModal and onWipeAll callbacks cleanly", () => {
  type ButtonPropsRecord = {
    onClick?: () => void;
    children?: unknown;
    "data-privacy-action"?: string;
  };

  function collectButtons(node: unknown, acc: ButtonPropsRecord[] = []): ButtonPropsRecord[] {
    if (Array.isArray(node)) {
      for (const child of node) {
        collectButtons(child, acc);
      }
      return acc;
    }
    if (!isValidElement(node)) {
      return acc;
    }
    const props = node.props as ButtonPropsRecord;
    if (node.type === "button") {
      acc.push(props);
    }
    if (props && props.children !== undefined) {
      collectButtons(props.children, acc);
    }
    return acc;
  }

  for (const locale of ["en", "fi", "sv"] as const) {
    let openCalls = 0;
    let wipeCalls = 0;

    const tree = PrivacyFlowCard({
      profile: makeProfile(),
      consent: makeConsent(),
      cameraActive: true,
      autoStopRemainingSec: 38,
      device: makeDevice(),
      lang: locale,
      onOpenPrivacyModal: () => {
        openCalls += 1;
      },
      onWipeAll: () => {
        wipeCalls += 1;
      }
    });

    const buttons = collectButtons(tree);
    assert.equal(buttons.length, 2);
    assert.equal(buttons[0]["data-privacy-action"], "open-modal");
    assert.equal(buttons[1]["data-privacy-action"], "wipe-all");

    buttons[0].onClick?.();
    assert.equal(openCalls, 1);
    assert.equal(wipeCalls, 0);

    buttons[1].onClick?.();
    assert.equal(openCalls, 1);
    assert.equal(wipeCalls, 1);
  }
});

test("PrivacyFlowCard and test suite contain zero code comments and zero em or en dashes", () => {
  const componentSource = readFileSync(
    new URL("../src/components/PrivacyFlowCard.tsx", import.meta.url),
    "utf8"
  );
  const testSource = readFileSync(new URL("./privacyFlowCard.test.ts", import.meta.url), "utf8");

  for (const [label, source] of [
    ["PrivacyFlowCard.tsx", componentSource],
    ["privacyFlowCard.test.ts", testSource]
  ] as const) {
    assert.equal(source.includes(LINE_COMMENT), false, `${label} must not contain line comments`);
    assert.equal(
      source.includes(BLOCK_COMMENT_OPEN),
      false,
      `${label} must not contain block comments`
    );
    assert.equal(
      source.includes(BLOCK_COMMENT_CLOSE),
      false,
      `${label} must not contain block comment closures`
    );
    assert.equal(source.includes(EM_DASH), false, `${label} must not contain em dashes`);
    assert.equal(source.includes(EN_DASH), false, `${label} must not contain en dashes`);
  }

  const noop = (): void => {};
  const consents: Array<ConsentRecord | null> = [
    null,
    makeConsent({ accepted: false, acceptedAt: null }),
    makeConsent({ accepted: true, version: "1" })
  ];
  const cameraStates: Array<{ active: boolean; sec: number | null }> = [
    { active: false, sec: null },
    { active: true, sec: null },
    { active: true, sec: 38 }
  ];
  const devices: DeviceState[] = [
    makeDevice({ connected: true, streaming: true }),
    makeDevice({ connected: false, streaming: false })
  ];

  for (const lang of ["en", "fi", "sv", "de"]) {
    for (const consent of consents) {
      for (const cam of cameraStates) {
        for (const device of devices) {
          for (const withActions of [false, true]) {
            const html = renderCard({
              consent,
              cameraActive: cam.active,
              autoStopRemainingSec: cam.sec,
              device,
              lang,
              onOpenPrivacyModal: withActions ? noop : undefined,
              onWipeAll: withActions ? noop : undefined
            });
            assert.equal(html.includes(EM_DASH), false, `Em dash found for lang=${lang}`);
            assert.equal(html.includes(EN_DASH), false, `En dash found for lang=${lang}`);
          }
        }
      }
    }
  }
});
