import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConsentOnboarding } from "../src/components/ConsentOnboarding.tsx";
import { DeviceResiliencePanel } from "../src/components/DeviceResiliencePanel.tsx";
import { VerdictCard } from "../src/components/VerdictCard.tsx";
import type {
  ChaosConfig,
  ConsentRecord,
  LabelRead,
  SessionSnapshot,
  TransportMode,
  Verdict,
  VerdictLevel
} from "../src/types.ts";

(globalThis as Record<string, unknown>).React = React;

type TestFn = (name: string, fn: () => void | Promise<void>) => Promise<void>;

interface StrictAssert {
  ok(value: unknown, message?: string): asserts value;
  equal<T>(actual: T, expected: T, message?: string): void;
  notEqual<T>(actual: T, expected: T, message?: string): void;
  deepEqual<T>(actual: T, expected: T, message?: string): void;
  match(value: string, regExp: RegExp, message?: string): void;
  doesNotMatch(value: string, regExp: RegExp, message?: string): void;
}

const nodeTestSpec: string = "node:test";
const nodeAssertSpec: string = "node:assert/strict";

const test: TestFn = ((await import(nodeTestSpec)) as { test: TestFn }).test;
const assert: StrictAssert = ((await import(nodeAssertSpec)) as { default: StrictAssert }).default;

const EM_DASH = "\u2014";
const HTTPS_ORIGIN = `https:\x2f\x2fholdup.example`;
const noop = (): void => {};

const pendingConsent: ConsentRecord = {
  accepted: false,
  acceptedAt: null,
  version: "2026-11"
};

const acceptedConsent: ConsentRecord = {
  accepted: true,
  acceptedAt: Date.UTC(2026, 10, 14, 18, 30, 0),
  version: "2026-11"
};

const clearChaos: ChaosConfig = {
  forceWsDrop: false,
  forceOffline: false,
  simulateGlassesDoffed: false,
  simulateLowBattery: false
};

function makeLabelRead(overrides: Partial<LabelRead> = {}): LabelRead {
  return {
    kind: "medication",
    product: { value: "Amlodipine", confidence: 0.96 },
    ingredient: { value: "amlodipine", confidence: 0.97 },
    strength: { value: "5 mg", confidence: 0.95 },
    dosing: { value: "1 tablet each evening", confidence: 0.91 },
    expiry: { value: "2027-08", confidence: 0.89 },
    allergens: { value: [], confidence: 0.92 },
    barcode: { value: "6432100012345", confidence: 0.99 },
    readability: 0.94,
    ...overrides
  };
}

function makeVerdict(overrides: Partial<Verdict> = {}): Verdict {
  return {
    level: "match",
    headline: "Yes, your evening Amlodipine 5 mg",
    speech: "Yes, this is Amlodipine 5 mg, your scheduled evening pill.",
    matchedMedId: "aml",
    takenToday: false,
    reasons: ["Matches saved evening medication", "Strength 5 mg verified"],
    read: makeLabelRead(),
    ...overrides
  };
}

function makeSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: "hup-7f3a",
    mode: "live",
    liveState: "open",
    activeModel: "gemini-live-2.5-flash",
    checking: false,
    coach: null,
    verdict: null,
    transcripts: [],
    device: {
      connected: true,
      worn: true,
      battery: 86,
      streaming: true,
      source: "glasses"
    },
    hudConnected: true,
    network: {
      online: true,
      rttMs: 84,
      targetFps: 1,
      jpegQuality: 0.8
    },
    permissions: {
      camera: "granted",
      microphone: "granted"
    },
    cameraActive: true,
    autoStopRemainingSec: 38,
    lastError: null,
    ...overrides
  };
}

function extractOpeningTagByClass(html: string, classToken: string): string {
  const escaped = classToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<([a-z0-9]+)\\b[^>]*class="[^"]*\\b${escaped}\\b[^"]*"[^>]*>`, "i");
  const match = pattern.exec(html);
  assert.ok(match, `Expected element with class "${classToken}"`);
  return match[0];
}

function extractBadgeSvg(html: string, level: VerdictLevel): string {
  const marker = `verdict-badge-${level}`;
  const badgeIdx = html.indexOf(marker);
  assert.ok(badgeIdx >= 0, `Missing badge marker ${marker}`);
  const svgStart = html.indexOf("<svg", badgeIdx);
  const svgEnd = html.indexOf("</svg>", svgStart);
  assert.ok(svgStart >= 0 && svgEnd > svgStart, `Missing <svg> inside ${marker}`);
  return html.slice(svgStart, svgEnd + 6);
}

test("ConsentOnboarding inline mode renders section with aria-labelledby, all 5 principles, dynamic med count, and accept button", () => {
  const htmlPlural = renderToStaticMarkup(
    createElement(ConsentOnboarding, {
      lang: "en",
      consent: pendingConsent,
      profileMedCount: 3,
      onAccept: noop,
      onClose: noop,
      onResetDemoProfile: noop,
      onWipeAllData: noop
    })
  );

  assert.match(htmlPlural, /^<section\b[^>]*aria-labelledby="consent-heading"/);
  assert.match(htmlPlural, /aria-describedby="consent-subtitle"/);
  assert.doesNotMatch(htmlPlural, /role="dialog"/);
  assert.doesNotMatch(htmlPlural, /aria-modal="true"/);
  assert.doesNotMatch(htmlPlural, />Close<\/button>/);

  assert.ok(htmlPlural.includes('id="consent-heading"'));
  assert.ok(htmlPlural.includes("Consent &amp; On-Device Data Controls"));
  assert.ok(htmlPlural.includes("Consent required before live label checks (v2026-11)"));
  assert.ok(htmlPlural.includes('aria-label="Five privacy and safety commitments"'));

  for (const badge of ["01", "02", "03", "04", "05"]) {
    assert.ok(htmlPlural.includes(`>${badge}</span>`), `Missing principle badge ${badge}`);
  }
  assert.ok(htmlPlural.includes("Camera runs only when you ask"));
  assert.ok(htmlPlural.includes("Zero server storage"));
  assert.ok(htmlPlural.includes("Your medication list stays on this device"));
  assert.ok(htmlPlural.includes("3 medicines currently saved on device"));
  assert.ok(htmlPlural.includes("Bystander privacy"));
  assert.ok(htmlPlural.includes("Not a medical device"));
  assert.ok(htmlPlural.includes("&lt; 80% confidence"));

  assert.ok(htmlPlural.includes('role="status"'));
  assert.ok(htmlPlural.includes('aria-live="polite"'));
  assert.ok(htmlPlural.includes(">I Understand, Continue to HoldUp</button>"));
  assert.ok(htmlPlural.includes(">Load Demo Profile (3 Meds + Nut Allergy)</button>"));
  assert.ok(htmlPlural.includes(">Delete All My Local Data</button>"));

  const htmlSingular = renderToStaticMarkup(
    createElement(ConsentOnboarding, {
      lang: "en",
      consent: acceptedConsent,
      profileMedCount: 1,
      onAccept: noop,
      onResetDemoProfile: noop,
      onWipeAllData: noop
    })
  );
  assert.ok(htmlSingular.includes("1 medicine currently saved on device"));
  assert.ok(htmlSingular.includes("Consent active (v2026-11"));

  const htmlClamped = renderToStaticMarkup(
    createElement(ConsentOnboarding, {
      lang: "en",
      consent: pendingConsent,
      profileMedCount: -5,
      onAccept: noop,
      onResetDemoProfile: noop,
      onWipeAllData: noop
    })
  );
  assert.ok(htmlClamped.includes("0 medicines currently saved on device"));
});

test("ConsentOnboarding localizes cleanly in Finnish (fi) and falls back cleanly to English for unknown locale (de)", () => {
  const fiSingular = renderToStaticMarkup(
    createElement(ConsentOnboarding, {
      lang: "fi",
      consent: pendingConsent,
      profileMedCount: 1,
      onAccept: noop,
      onResetDemoProfile: noop,
      onWipeAllData: noop
    })
  );

  assert.ok(fiSingular.includes("Suostumus ja laitteen tietojen hallinta"));
  assert.ok(fiSingular.includes('aria-label="Viisi tietosuoja- ja turvallisuusperiaatetta"'));
  assert.ok(fiSingular.includes("Kamera käynnistyy vain pyynnöstäsi"));
  assert.ok(fiSingular.includes("Ei tallennusta palvelimelle"));
  assert.ok(fiSingular.includes("Lääkelistasi pysyy tällä laitteella"));
  assert.ok(fiSingular.includes("1 lääke tallennettuna laitteelle"));
  assert.ok(fiSingular.includes("Sivullisten yksityisyys"));
  assert.ok(fiSingular.includes("Ei lääkinnällinen laite"));
  assert.ok(fiSingular.includes(">Ymmärrän, jatka HoldUpiin</button>"));

  const fiRegionalPlural = renderToStaticMarkup(
    createElement(ConsentOnboarding, {
      lang: "fi-FI",
      consent: acceptedConsent,
      profileMedCount: 4,
      onAccept: noop,
      onResetDemoProfile: noop,
      onWipeAllData: noop
    })
  );
  assert.ok(fiRegionalPlural.includes("4 lääkettä tallennettuna laitteelle"));
  assert.ok(fiRegionalPlural.includes("Suostumus voimassa (v2026-11"));

  const deFallback = renderToStaticMarkup(
    createElement(ConsentOnboarding, {
      lang: "de",
      consent: pendingConsent,
      profileMedCount: 2,
      onAccept: noop,
      onResetDemoProfile: noop,
      onWipeAllData: noop
    })
  );
  assert.ok(deFallback.includes("Consent &amp; On-Device Data Controls"));
  assert.ok(deFallback.includes("2 medicines currently saved on device"));
  assert.ok(deFallback.includes(">I Understand, Continue to HoldUp</button>"));
  assert.equal(deFallback.includes("Suostumus"), false);
});

test("ConsentOnboarding modal mode renders role=dialog, aria-modal=true, and localized close control", () => {
  const modalEn = renderToStaticMarkup(
    createElement(ConsentOnboarding, {
      lang: "en",
      consent: acceptedConsent,
      profileMedCount: 3,
      isModal: true,
      onAccept: noop,
      onClose: noop,
      onResetDemoProfile: noop,
      onWipeAllData: noop
    })
  );

  assert.equal(modalEn.startsWith("<section"), false);
  assert.match(modalEn, /<div\b[^>]*role="dialog"[^>]*aria-modal="true"/);
  assert.match(modalEn, /aria-labelledby="consent-heading"/);
  assert.match(modalEn, /aria-describedby="consent-subtitle"/);
  assert.match(modalEn, /tabindex="-1"/);
  assert.ok(modalEn.includes(">Close</button>"));

  const modalFi = renderToStaticMarkup(
    createElement(ConsentOnboarding, {
      lang: "fi",
      consent: acceptedConsent,
      profileMedCount: 3,
      isModal: true,
      onAccept: noop,
      onClose: noop,
      onResetDemoProfile: noop,
      onWipeAllData: noop
    })
  );
  assert.match(modalFi, /role="dialog"/);
  assert.match(modalFi, /aria-modal="true"/);
  assert.ok(modalFi.includes(">Sulje</button>"));

  const modalWithoutClose = renderToStaticMarkup(
    createElement(ConsentOnboarding, {
      lang: "en",
      consent: acceptedConsent,
      profileMedCount: 3,
      isModal: true,
      onAccept: noop,
      onResetDemoProfile: noop,
      onWipeAllData: noop
    })
  );
  assert.match(modalWithoutClose, /role="dialog"/);
  assert.match(modalWithoutClose, /aria-modal="true"/);
  assert.equal(modalWithoutClose.includes(">Close</button>"), false);
});

test("VerdictCard checking=true renders polite status banner and aria-busy=true", () => {
  const html = renderToStaticMarkup(
    createElement(VerdictCard, {
      verdict: null,
      checking: true,
      mode: "live",
      lang: "en",
      onLogDose: noop,
      onRepeat: noop
    })
  );

  const sectionTag = extractOpeningTagByClass(html, "verdict-checking");
  assert.ok(sectionTag.includes('aria-busy="true"'));
  assert.ok(sectionTag.includes('aria-label="Label safety verdict"'));

  const bannerTag = extractOpeningTagByClass(html, "verdict-checking-banner");
  assert.ok(bannerTag.includes('role="status"'));
  assert.ok(bannerTag.includes('aria-live="polite"'));
  assert.ok(html.includes("Hold still, verifying label with schema checker..."));
  assert.equal(html.includes("verdict-ready-body"), false);
});

test("VerdictCard verdict=null and checking=false renders calm ready guidance across transport modes", () => {
  const modeExpectations: Array<[TransportMode, string]> = [
    ["live", "Live mode"],
    ["snapshot", "Snapshot mode"],
    ["offline", "Offline barcode mode"]
  ];

  for (const [mode, expectedLabel] of modeExpectations) {
    const html = renderToStaticMarkup(
      createElement(VerdictCard, {
        verdict: null,
        checking: false,
        mode,
        lang: "en",
        onLogDose: noop,
        onRepeat: noop
      })
    );

    const sectionTag = extractOpeningTagByClass(html, "verdict-ready");
    assert.ok(sectionTag.includes('aria-busy="false"'));
    assert.ok(html.includes("Ready to check"));
    assert.ok(html.includes(expectedLabel));
    assert.ok(html.includes("Hold up a medicine box or food package, or choose a demo prop"));
    assert.ok(html.includes("never guesses a medication dose"));
    assert.equal(html.includes("verdict-checking-banner"), false);
    assert.match(html, /class="sr-only verdict-live-region"[^>]*aria-live="assertive"[^>]*><\/div>/);
  }
});

test("VerdictCard match verdict renders verdict-match, assertive live region, enabled Log Dose button, and Repeat button", () => {
  const verdict = makeVerdict();
  const html = renderToStaticMarkup(
    createElement(VerdictCard, {
      verdict,
      checking: false,
      mode: "live",
      lang: "en",
      onLogDose: noop,
      onRepeat: noop
    })
  );

  const sectionTag = extractOpeningTagByClass(html, "verdict-match");
  assert.ok(sectionTag.includes('aria-busy="false"'));

  assert.match(
    html,
    /class="sr-only verdict-live-region"[^>]*aria-live="assertive"[^>]*aria-atomic="true"[^>]*>MATCH: Yes, your evening Amlodipine 5 mg\. Yes, this is Amlodipine 5 mg, your scheduled evening pill\.<\/div>/
  );

  assert.ok(html.includes("Not taken today"));
  assert.ok(html.includes("Matches saved evening medication"));

  const logBtnTag = extractOpeningTagByClass(html, "verdict-btn-log");
  assert.doesNotMatch(logBtnTag, /\sdisabled(?:=""|=|\s|>)/);
  assert.ok(logBtnTag.includes('aria-disabled="false"'));
  assert.ok(html.includes("<span>I Took It (Log Dose)</span>"));

  const repeatBtnTag = extractOpeningTagByClass(html, "verdict-btn-repeat");
  assert.doesNotMatch(repeatBtnTag, /\sdisabled(?:=""|=|\s|>)/);
  assert.ok(html.includes("<span>Repeat Answer</span>"));

  assert.ok(html.includes("Per-Field Confidence Breakdown"));
  assert.ok(html.includes('aria-label="Strength confidence 95%"'));
});

test("VerdictCard double-dose safety guard disables Log Dose button when warning verdict has takenToday=true", () => {
  const alreadyTakenWarning = makeVerdict({
    level: "warning",
    headline: "Stop: already taken today",
    speech: "Hold on. You already logged Amlodipine 5 mg today.",
    matchedMedId: "aml",
    takenToday: true,
    reasons: ["Dose already logged earlier today"]
  });

  const guardedHtml = renderToStaticMarkup(
    createElement(VerdictCard, {
      verdict: alreadyTakenWarning,
      checking: false,
      mode: "live",
      lang: "en",
      onLogDose: noop,
      onRepeat: noop
    })
  );

  const guardedLogBtn = extractOpeningTagByClass(guardedHtml, "verdict-btn-log");
  assert.match(guardedLogBtn, /\sdisabled(?:=""|\s|>)/);
  assert.ok(guardedLogBtn.includes('aria-disabled="true"'));
  assert.ok(guardedHtml.includes("<span>Already Logged Today</span>"));
  assert.equal(guardedHtml.includes("<span>I Took It (Log Dose)</span>"), false);
  assert.ok(guardedHtml.includes("Taken today"));
  assert.ok(guardedHtml.includes("verdict-double-dose-guard"));
  assert.ok(guardedHtml.includes("Double-dose protection active"));

  const repeatBtn = extractOpeningTagByClass(guardedHtml, "verdict-btn-repeat");
  assert.doesNotMatch(repeatBtn, /\sdisabled(?:=""|=|\s|>)/);

  const unloggedWarning = makeVerdict({
    level: "warning",
    headline: "Check schedule before taking",
    speech: "This is your evening pill, but it is morning.",
    matchedMedId: "aml",
    takenToday: false,
    reasons: ["Scheduled for evening"]
  });
  const unloggedWarningHtml = renderToStaticMarkup(
    createElement(VerdictCard, {
      verdict: unloggedWarning,
      checking: false,
      mode: "live",
      lang: "en",
      onLogDose: noop,
      onRepeat: noop
    })
  );
  const unloggedBtn = extractOpeningTagByClass(unloggedWarningHtml, "verdict-btn-log");
  assert.doesNotMatch(unloggedBtn, /\sdisabled(?:=""|=|\s|>)/);
  assert.ok(unloggedBtn.includes('aria-disabled="false"'));

  const unmatchedFood = makeVerdict({
    level: "info",
    headline: "Oat milk, allergen clear",
    speech: "No peanuts or tree nuts listed.",
    matchedMedId: undefined,
    takenToday: undefined,
    reasons: []
  });
  const unmatchedHtml = renderToStaticMarkup(
    createElement(VerdictCard, {
      verdict: unmatchedFood,
      checking: false,
      mode: "live",
      lang: "en",
      onLogDose: noop,
      onRepeat: noop
    })
  );
  const unmatchedBtn = extractOpeningTagByClass(unmatchedHtml, "verdict-btn-log");
  assert.match(unmatchedBtn, /\sdisabled(?:=""|\s|>)/);
  assert.ok(unmatchedBtn.includes('aria-disabled="true"'));
});

test("VerdictCard low-confidence strength safety flag displays < 80% threshold refusal notice", () => {
  const blurryStrengthVerdict = makeVerdict({
    level: "unsure",
    headline: "Strength unclear, do not guess",
    speech: "I can read Amlodipine, but the milligram strength is blurry. Please steady the box or ask a pharmacist.",
    matchedMedId: undefined,
    takenToday: undefined,
    reasons: ["Strength confidence 25% is below 80% safety threshold"],
    read: makeLabelRead({
      strength: { value: null, confidence: 0.25 },
      readability: 0.58
    })
  });

  const html = renderToStaticMarkup(
    createElement(VerdictCard, {
      verdict: blurryStrengthVerdict,
      checking: false,
      mode: "snapshot",
      lang: "en",
      onLogDose: noop,
      onRepeat: noop
    })
  );

  const strengthRowTag = extractOpeningTagByClass(html, "confidence-row-strength");
  assert.ok(strengthRowTag.includes("confidence-row-flagged"));
  assert.ok(strengthRowTag.includes('data-field="strength"'));

  const warningTag = extractOpeningTagByClass(html, "confidence-threshold-warning");
  assert.ok(warningTag.includes('role="note"'));
  assert.ok(html.includes("Below 80% safety threshold: dose never guessed"));
  assert.ok(html.includes('aria-label="Strength confidence 25%"'));
  assert.ok(html.includes("Not readable"));
});

test("VerdictCard strength safety threshold flags 79% confidence and clears at 80% confidence", () => {
  const belowThresholdHtml = renderToStaticMarkup(
    createElement(VerdictCard, {
      verdict: makeVerdict({
        level: "unsure",
        read: makeLabelRead({ strength: { value: "5 mg", confidence: 0.79 } })
      }),
      checking: false,
      mode: "live",
      lang: "en",
      onLogDose: noop,
      onRepeat: noop
    })
  );
  assert.ok(belowThresholdHtml.includes("confidence-row-flagged"));
  assert.ok(belowThresholdHtml.includes("Below 80% safety threshold: dose never guessed"));

  const atThresholdHtml = renderToStaticMarkup(
    createElement(VerdictCard, {
      verdict: makeVerdict({
        level: "match",
        read: makeLabelRead({ strength: { value: "5 mg", confidence: 0.8 } })
      }),
      checking: false,
      mode: "live",
      lang: "en",
      onLogDose: noop,
      onRepeat: noop
    })
  );
  assert.equal(atThresholdHtml.includes("confidence-row-flagged"), false);
  assert.equal(atThresholdHtml.includes("Below 80% safety threshold: dose never guessed"), false);
});

test("VerdictCard all 4 VerdictLevel states render distinct SVG icons and non-color text labels", () => {
  const expectedByLevel: Array<{
    level: VerdictLevel;
    label: string;
    summary: string;
    borderStyle: string;
  }> = [
    { level: "match", label: "MATCH", summary: "Verified safe match", borderStyle: "border-style:solid" },
    { level: "warning", label: "WARNING", summary: "Safety warning", borderStyle: "border-style:double" },
    { level: "unsure", label: "UNSURE", summary: "Cannot confirm safely", borderStyle: "border-style:dashed" },
    { level: "info", label: "INFO", summary: "Label information", borderStyle: "border-style:solid" }
  ];

  const svgs = new Set<string>();

  for (const spec of expectedByLevel) {
    const html = renderToStaticMarkup(
      createElement(VerdictCard, {
        verdict: makeVerdict({ level: spec.level }),
        checking: false,
        mode: "live",
        lang: "en",
        onLogDose: noop,
        onRepeat: noop
      })
    );

    const sectionTag = extractOpeningTagByClass(html, `verdict-${spec.level}`);
    assert.ok(sectionTag.includes(spec.borderStyle), `Expected ${spec.borderStyle} for ${spec.level}`);
    assert.ok(html.includes(`<span>${spec.label}</span>`), `Missing label ${spec.label}`);
    assert.ok(html.includes(spec.summary), `Missing summary ${spec.summary}`);

    const svg = extractBadgeSvg(html, spec.level);
    svgs.add(svg);
  }

  assert.equal(svgs.size, 4, "Each VerdictLevel must render a distinct SVG icon shape");
});

test("DeviceResiliencePanel renders LIVE, SNAPSHOT, and OFFLINE transport modes with RTT and offline telemetry", () => {
  const liveHtml = renderToStaticMarkup(
    createElement(DeviceResiliencePanel, {
      snapshot: makeSnapshot({
        mode: "live",
        network: { online: true, rttMs: 92, targetFps: 1, jpegQuality: 0.8 }
      }),
      chaos: clearChaos,
      onChangeChaos: noop,
      serverOrigin: HTTPS_ORIGIN
    })
  );
  assert.ok(liveHtml.includes(">LIVE</div>"));
  assert.ok(liveHtml.includes("Bidirectional Gemini Live stream"));
  assert.ok(liveHtml.includes(">92 ms</div>"));
  assert.ok(liveHtml.includes("Live WebSocket ping-pong telemetry"));
  assert.ok(liveHtml.includes("1 fps @ 80% JPEG"));

  const snapshotHtml = renderToStaticMarkup(
    createElement(DeviceResiliencePanel, {
      snapshot: makeSnapshot({
        mode: "snapshot",
        liveState: "reconnecting",
        network: { online: true, rttMs: null, targetFps: 0.5, jpegQuality: 0.5 }
      }),
      chaos: clearChaos,
      onChangeChaos: noop,
      serverOrigin: HTTPS_ORIGIN
    })
  );
  assert.ok(snapshotHtml.includes(">SNAPSHOT</div>"));
  assert.ok(snapshotHtml.includes("HTTP /api/verify + TTS fallback"));
  assert.ok(snapshotHtml.includes(">measuring</div>"));
  assert.ok(snapshotHtml.includes("0.5 fps @ 50% JPEG"));

  const offlineHtml = renderToStaticMarkup(
    createElement(DeviceResiliencePanel, {
      snapshot: makeSnapshot({
        mode: "offline",
        liveState: "closed",
        activeModel: null,
        network: { online: false, rttMs: null, targetFps: 0.5, jpegQuality: 0.5 }
      }),
      chaos: clearChaos,
      onChangeChaos: noop,
      serverOrigin: HTTPS_ORIGIN
    })
  );
  assert.ok(offlineHtml.includes(">OFFLINE</div>"));
  assert.ok(offlineHtml.includes("On-device BarcodeDetector match"));
  assert.ok(offlineHtml.includes(">offline</div>"));
  assert.ok(offlineHtml.includes("Network unreachable - local mode"));
  assert.ok(offlineHtml.includes("closed (standby)"));
});

test("DeviceResiliencePanel renders Ray-Ban Glasses worn, doffed, battery, and Display /hud status", () => {
  const wornHtml = renderToStaticMarkup(
    createElement(DeviceResiliencePanel, {
      snapshot: makeSnapshot({
        device: {
          connected: true,
          worn: true,
          battery: 88,
          streaming: true,
          source: "glasses"
        },
        hudConnected: true
      }),
      chaos: clearChaos,
      onChangeChaos: noop,
      serverOrigin: HTTPS_ORIGIN
    })
  );
  assert.ok(wornHtml.includes("Connected / Worn / 88%"));
  assert.ok(wornHtml.includes("DAT camera frames streaming"));
  assert.ok(wornHtml.includes(">Glasses DAT</div>"));
  assert.ok(wornHtml.includes("Connected (/hud)"));
  assert.ok(wornHtml.includes("600x600 in-lens card synced"));
  assert.ok(wornHtml.includes(">Glasses Linked</span>"));

  const doffedLowBatteryHtml = renderToStaticMarkup(
    createElement(DeviceResiliencePanel, {
      snapshot: makeSnapshot({
        device: {
          connected: true,
          worn: false,
          battery: 7,
          streaming: false,
          source: "phone"
        },
        hudConnected: false,
        cameraActive: false,
        autoStopRemainingSec: null
      }),
      chaos: clearChaos,
      onChangeChaos: noop,
      serverOrigin: HTTPS_ORIGIN
    })
  );
  assert.ok(doffedLowBatteryHtml.includes("Connected / Doffed / 7%"));
  assert.ok(doffedLowBatteryHtml.includes("Bluetooth audio ready, DAT idle"));
  assert.ok(doffedLowBatteryHtml.includes(">Phone Camera</div>"));
  assert.ok(doffedLowBatteryHtml.includes("Camera idle (privacy-safe)"));
  assert.ok(doffedLowBatteryHtml.includes("Waiting (/hud)"));
  assert.ok(doffedLowBatteryHtml.includes("Open /hud for side-by-side display"));

  const disconnectedHtml = renderToStaticMarkup(
    createElement(DeviceResiliencePanel, {
      snapshot: makeSnapshot({
        device: {
          connected: false,
          worn: false,
          battery: null,
          streaming: false,
          source: "phone"
        },
        hudConnected: false
      }),
      chaos: clearChaos,
      onChangeChaos: noop,
      serverOrigin: HTTPS_ORIGIN
    })
  );
  assert.ok(disconnectedHtml.includes("Disconnected / Doffed / N/A"));
  assert.ok(disconnectedHtml.includes(">Standby</span>"));
});

test("DeviceResiliencePanel renders all 4 chaos simulator buttons with aria-pressed and fault telemetry", () => {
  const nominalHtml = renderToStaticMarkup(
    createElement(DeviceResiliencePanel, {
      snapshot: makeSnapshot(),
      chaos: clearChaos,
      onChangeChaos: noop,
      serverOrigin: HTTPS_ORIGIN
    })
  );

  const pressedFalseMatches = nominalHtml.match(/aria-pressed="false"/g) ?? [];
  const pressedTrueMatches = nominalHtml.match(/aria-pressed="true"/g) ?? [];
  assert.equal(pressedFalseMatches.length, 4);
  assert.equal(pressedTrueMatches.length, 0);
  assert.ok(nominalHtml.includes("Nominal Telemetry"));
  assert.equal(nominalHtml.includes("Reset All Faults"), false);
  assert.ok(nominalHtml.includes("Simulate Live WS Drop"));
  assert.ok(nominalHtml.includes("Simulate Complete Offline"));
  assert.ok(nominalHtml.includes("Simulate Glasses Taken Off (Doffed)"));
  assert.ok(nominalHtml.includes("Simulate Glasses Low Battery (&lt;10%)"));

  const activeChaos: ChaosConfig = {
    forceWsDrop: true,
    forceOffline: false,
    simulateGlassesDoffed: true,
    simulateLowBattery: false
  };
  const faultHtml = renderToStaticMarkup(
    createElement(DeviceResiliencePanel, {
      snapshot: makeSnapshot({
        lastError: {
          code: "ws_drop",
          message: "Live WebSocket closed unexpectedly",
          recoverable: true
        }
      }),
      chaos: activeChaos,
      onChangeChaos: noop,
      serverOrigin: HTTPS_ORIGIN
    })
  );

  assert.equal((faultHtml.match(/aria-pressed="true"/g) ?? []).length, 2);
  assert.equal((faultHtml.match(/aria-pressed="false"/g) ?? []).length, 2);
  assert.equal((faultHtml.match(/>ACTIVE<\/span>/g) ?? []).length, 2);
  assert.equal((faultHtml.match(/>OFF<\/span>/g) ?? []).length, 2);
  assert.ok(faultHtml.includes("2 Faults Simulated"));
  assert.ok(faultHtml.includes(">Reset All Faults</button>"));
  assert.match(faultHtml, /role="alert"[\s\S]*Last Error \(ws_drop\):/);
  assert.ok(faultHtml.includes("recoverable fallback active"));
});

test("DeviceResiliencePanel renders session ID, /hud link, bridge deep-link, and QR SVG markup when passed", () => {
  const withoutQrHtml = renderToStaticMarkup(
    createElement(DeviceResiliencePanel, {
      snapshot: makeSnapshot({ sessionId: "hup-9k2m" }),
      chaos: clearChaos,
      onChangeChaos: noop,
      serverOrigin: `${HTTPS_ORIGIN}/`
    })
  );

  assert.ok(withoutQrHtml.includes("<code>hup-9k2m</code>"));
  assert.ok(withoutQrHtml.includes(`href="${HTTPS_ORIGIN}/hud?session=hup-9k2m"`));
  assert.ok(withoutQrHtml.includes("Open /hud in New Tab"));
  assert.ok(
    withoutQrHtml.includes(
      `href="holdupbridge:\x2f\x2fconnect?server=${encodeURIComponent(HTTPS_ORIGIN)}&amp;session=hup-9k2m"`
    )
  );
  assert.equal(withoutQrHtml.includes("QR code to open the Ray-Ban Display HUD"), false);
  assert.equal(withoutQrHtml.includes("QR code to configure the HoldUp Android DAT Bridge"), false);

  const hudSvg = '<svg viewBox="0 0 16 16"><rect width="16" height="16" fill="black"/></svg>';
  const bridgeSvg = '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="8"/></svg>';

  const withQrHtml = renderToStaticMarkup(
    createElement(DeviceResiliencePanel, {
      snapshot: makeSnapshot({ sessionId: "hup-9k2m" }),
      chaos: clearChaos,
      onChangeChaos: noop,
      serverOrigin: HTTPS_ORIGIN,
      hudQrSvg: hudSvg,
      bridgeQrSvg: bridgeSvg
    })
  );

  assert.ok(withQrHtml.includes('alt="QR code to open the Ray-Ban Display HUD"'));
  assert.ok(withQrHtml.includes('alt="QR code to configure the HoldUp Android DAT Bridge"'));
  assert.equal((withQrHtml.match(/src="data:image\/svg\+xml;utf8,/g) ?? []).length, 2);
  assert.ok(withQrHtml.includes(encodeURIComponent("rect width=\"16\"")));
  assert.ok(withQrHtml.includes(encodeURIComponent("circle cx=\"10\"")));
});

test("All core UI components emit zero em dashes across all locales, verdict levels, and resilience states", () => {
  const renders: Array<[string, string]> = [
    [
      "ConsentOnboarding-en-inline",
      renderToStaticMarkup(
        createElement(ConsentOnboarding, {
          lang: "en",
          consent: pendingConsent,
          profileMedCount: 3,
          onAccept: noop,
          onResetDemoProfile: noop,
          onWipeAllData: noop
        })
      )
    ],
    [
      "ConsentOnboarding-fi-modal",
      renderToStaticMarkup(
        createElement(ConsentOnboarding, {
          lang: "fi",
          consent: acceptedConsent,
          profileMedCount: 1,
          isModal: true,
          onAccept: noop,
          onClose: noop,
          onResetDemoProfile: noop,
          onWipeAllData: noop
        })
      )
    ],
    [
      "VerdictCard-checking",
      renderToStaticMarkup(
        createElement(VerdictCard, {
          verdict: null,
          checking: true,
          mode: "live",
          lang: "en",
          onLogDose: noop,
          onRepeat: noop
        })
      )
    ],
    [
      "VerdictCard-ready",
      renderToStaticMarkup(
        createElement(VerdictCard, {
          verdict: null,
          checking: false,
          mode: "offline",
          lang: "en",
          onLogDose: noop,
          onRepeat: noop
        })
      )
    ],
    ...(
      ["match", "warning", "unsure", "info"] as const
    ).map((level): [string, string] => [
      `VerdictCard-${level}`,
      renderToStaticMarkup(
        createElement(VerdictCard, {
          verdict: makeVerdict({
            level,
            takenToday: level === "warning",
            read: makeLabelRead({
              strength: { value: level === "unsure" ? null : "5 mg", confidence: level === "unsure" ? 0.25 : 0.95 }
            })
          }),
          checking: false,
          mode: "snapshot",
          lang: "en",
          onLogDose: noop,
          onRepeat: noop
        })
      )
    ]),
    ...(
      ["live", "snapshot", "offline"] as const
    ).map((mode): [string, string] => [
      `DeviceResiliencePanel-${mode}`,
      renderToStaticMarkup(
        createElement(DeviceResiliencePanel, {
          snapshot: makeSnapshot({
            mode,
            hudConnected: mode === "live",
            network: {
              online: mode !== "offline",
              rttMs: mode === "live" ? 65 : null,
              targetFps: 1,
              jpegQuality: 0.8
            },
            lastError:
              mode === "offline"
                ? { code: "offline", message: "Network unreachable", recoverable: true }
                : null
          }),
          chaos: {
            forceWsDrop: mode === "snapshot",
            forceOffline: mode === "offline",
            simulateGlassesDoffed: mode !== "live",
            simulateLowBattery: mode === "offline"
          },
          onChangeChaos: noop,
          serverOrigin: HTTPS_ORIGIN,
          hudQrSvg: '<svg viewBox="0 0 8 8"><rect width="8" height="8"/></svg>',
          bridgeQrSvg: '<svg viewBox="0 0 8 8"><rect width="8" height="8"/></svg>'
        })
      )
    ])
  ];

  for (const [label, html] of renders) {
    assert.equal(html.includes(EM_DASH), false, `${label} contained an em dash`);
  }
});
