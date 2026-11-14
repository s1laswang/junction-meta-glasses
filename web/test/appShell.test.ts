import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { App, type AppProps } from "../src/App.tsx";
import { STRENGTH_GATE_THRESHOLD } from "../src/components/ConfidenceBreakdownCard.tsx";
import { SAMPLE_FINNISH_PHARMACY_QR } from "../src/pairing/pharmacyQr.ts";
import {
  DEMO_PROFILE,
  createMemoryStorage,
  saveConsent,
  type KeyValueStorage
} from "../src/storage/profileStore.ts";
import type { LabelRead, Verdict } from "../src/types.ts";

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

type FsModule = {
  readFileSync(path: URL | string, encoding: "utf8"): string;
};

const nodeTestSpec: string = "node:test";
const nodeAssertSpec: string = "node:assert/strict";
const nodeFsSpec: string = "node:fs";

const test: TestFn = ((await import(nodeTestSpec)) as { test: TestFn }).test;
const assert: StrictAssert = ((await import(nodeAssertSpec)) as { default: StrictAssert }).default;
const { readFileSync } = (await import(nodeFsSpec)) as FsModule;

const DOUBLE_SLASH = "\x2f\x2f";
const BLOCK_OPEN = "\x2f*";
const BLOCK_CLOSE = "*\x2f";
const BASE_URL = `http:${DOUBLE_SLASH}localhost:5173`;
const EM_DASH = String.fromCharCode(8212);
const EN_DASH = String.fromCharCode(8211);

function makeSampleRead(overrides: Partial<LabelRead> = {}): LabelRead {
  return {
    kind: "medication",
    product: { value: "Amlodipine Orion", confidence: 0.96 },
    ingredient: { value: "amlodipine", confidence: 0.95 },
    strength: { value: "5 mg", confidence: 0.93 },
    dosing: { value: "1 tablet each evening", confidence: 0.91 },
    expiry: { value: "2027-08", confidence: 0.92 },
    allergens: { value: ["lactose"], confidence: 0.88 },
    barcode: { value: "6432100012345", confidence: 0.99 },
    readability: 0.94,
    ...overrides
  };
}

function makeSampleVerdict(overrides: Partial<Verdict> = {}): Verdict {
  return {
    level: "match",
    headline: "Yes: Amlodipine 5 mg, your evening pill",
    speech: "Yes, Amlodipine 5 mg, your evening pill. You have not taken it today.",
    read: makeSampleRead(),
    matchedMedId: "aml",
    reasons: ["matches aml", "taken today: 0/1"],
    takenToday: false,
    ...overrides
  };
}

function renderApp(props?: AppProps): string {
  return renderToStaticMarkup(props ? createElement(App, props) : createElement(App));
}

test("App at / renders AppHeader, skip link #main-content, ConsentOnboarding when unaccepted, JudgeDemoTour, ViewfinderStage, VoiceActivityPill, VerdictCard, ConversationBar, HudPreviewFrame, CaregiverAlertCard, and resource footer", () => {
  const storage = createMemoryStorage();
  const html = renderApp({
    initialUrl: `${BASE_URL}/`,
    controllerOptions: { storage }
  });

  assert.ok(html.includes('href="#main-content"'));
  assert.ok(html.includes('class="skip-link"'));
  assert.ok(html.includes('class="app-header"'));
  assert.ok(html.includes('id="main-content"'));
  assert.ok(html.includes('class="app-shell"'));
  assert.ok(html.includes('data-announcer-slot="polite-a"'));
  assert.ok(html.includes('data-announcer-slot="assertive-a"'));

  assert.ok(html.includes("consent-onboarding"));
  assert.ok(html.includes("Consent &amp; On-Device Data Controls"));

  assert.ok(html.includes("judge-demo-tour"));
  assert.ok(html.includes("60-Second Interactive Judge Walkthrough"));
  assert.ok(html.includes("1. Right Evening Pill"));
  assert.ok(html.includes("5. Wi-Fi Off Barcode Fallback"));

  assert.ok(html.includes('id="panel-check"'));
  assert.ok(html.includes('role="tabpanel"'));
  assert.ok(html.includes('aria-labelledby="tab-check"'));
  assert.ok(html.includes('class="check-grid"'));

  assert.ok(html.includes("Phone Camera"));
  assert.ok(html.includes("Glasses (DAT)"));
  assert.ok(html.includes("Demo Props"));

  assert.ok(html.includes('aria-label="Open-ear voice and audio status"'));
  assert.ok(html.includes('class="voice-activity-pill voice-state-idle"'));
  assert.ok(html.includes("MIC STANDBY"));
  assert.ok(html.includes('data-bar-count="5"'));

  const viewfinderIdx = html.indexOf("Phone Camera");
  const voicePillIdx = html.indexOf('aria-label="Open-ear voice and audio status"');
  const conversationIdx = html.indexOf("Ask HoldUp or Tap a Quick Check");
  assert.ok(viewfinderIdx > 0 && voicePillIdx > viewfinderIdx);
  assert.ok(conversationIdx > voicePillIdx);

  assert.ok(html.includes("Ask HoldUp or Tap a Quick Check"));
  assert.ok(html.includes("Is this my evening pill?"));

  assert.ok(html.includes("verdict-ready-title"));
  assert.ok(html.includes("Ready to check"));
  assert.equal(html.includes("confidence-breakdown-card"), false);

  assert.ok(html.includes("hpf-root"));
  assert.ok(html.includes('data-waveguide-viewport="600x600"'));

  assert.ok(html.includes("caregiver-share-actions"));
  assert.ok(html.includes("Preview Outgoing Family Message"));

  const footerStartIdx = html.indexOf('aria-label="Submission and hardware resources"');
  assert.ok(html.includes('class="app-footer"'));
  assert.ok(footerStartIdx > html.indexOf("</main>"));
  const footerHtml = html.slice(footerStartIdx);

  const expectedFooterLinks: ReadonlyArray<[string, string]> = [
    ["/deck", "Pitch Deck (12 Slides)"],
    ["/judge-handout.html", "Judge Quick-Start (A4)"],
    ["/printable-props.html", "Printable Demo Props &amp; QR"],
    ["/hud", "Ray-Ban Display HUD (/hud)"]
  ];

  for (const [href, labelText] of expectedFooterLinks) {
    const tagRegex = new RegExp(
      `<a\\b[^>]*href="${href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>`,
      "i"
    );
    const match = tagRegex.exec(footerHtml);
    assert.ok(match, `Expected footer link for ${href}`);
    assert.ok(match[0].includes('target="_blank"'));
    assert.ok(match[0].includes('rel="noopener noreferrer"'));
    const minHeightMatch = /min-height:(\d+)px/.exec(match[0]);
    assert.ok(minHeightMatch, `Expected min-height in px on ${href}`);
    assert.ok(Number.parseInt(minHeightMatch[1], 10) >= 48);
    assert.ok(footerHtml.includes(labelText));
  }

  assert.doesNotMatch(html, /role="dialog"/);
  assert.equal(html.includes(EM_DASH), false);
  assert.equal(html.includes(EN_DASH), false);

  const defaultNoPropsHtml = renderApp();
  assert.ok(defaultNoPropsHtml.includes('id="main-content"'));
  assert.ok(defaultNoPropsHtml.includes('id="panel-check"'));
  assert.ok(defaultNoPropsHtml.includes('aria-label="Open-ear voice and audio status"'));
  assert.ok(defaultNoPropsHtml.includes('aria-label="Submission and hardware resources"'));
  assert.equal(defaultNoPropsHtml.includes(EM_DASH), false);

  const acceptedStorage = createMemoryStorage();
  saveConsent(true, acceptedStorage);
  acceptedStorage.setItem("holdup.muted", "1");
  const acceptedHtml = renderApp({
    initialUrl: `${BASE_URL}/`,
    controllerOptions: { storage: acceptedStorage }
  });
  assert.equal(acceptedHtml.includes("consent-onboarding"), false);
  assert.ok(acceptedHtml.includes('id="panel-check"'));
  assert.ok(acceptedHtml.includes("AUDIO MUTED"));
  assert.equal(acceptedHtml.includes(EM_DASH), false);
});

test("App renders ConfidenceBreakdownCard between VerdictCard and HudPreviewFrame when a verdict is present", () => {
  assert.equal(STRENGTH_GATE_THRESHOLD, 0.8);

  const passedVerdict = makeSampleVerdict();
  const passedHtml = renderApp({
    initialUrl: `${BASE_URL}/`,
    controllerOptions: { storage: createMemoryStorage() },
    initialVerdict: passedVerdict
  });

  assert.ok(passedHtml.includes("Yes: Amlodipine 5 mg, your evening pill"));
  assert.ok(passedHtml.includes("confidence-breakdown-card"));
  assert.ok(passedHtml.includes('id="confidence-breakdown-heading"'));
  assert.ok(passedHtml.includes("80% Dose Gate: PASSED (93%)"));
  assert.ok(passedHtml.includes('data-threshold-pct="80"'));

  const meterMatches = passedHtml.match(/class="sr-only confidence-inspector-meter"/g) ?? [];
  assert.equal(meterMatches.length, 8);

  const verdictCardIdx = passedHtml.indexOf("Yes: Amlodipine 5 mg, your evening pill");
  const confidenceCardIdx = passedHtml.indexOf('id="confidence-breakdown-heading"');
  const hudPreviewIdx = passedHtml.indexOf('id="hpf-heading"');
  const caregiverIdx = passedHtml.indexOf("caregiver-share-actions");

  assert.ok(verdictCardIdx > 0);
  assert.ok(confidenceCardIdx > verdictCardIdx);
  assert.ok(hudPreviewIdx > confidenceCardIdx);
  assert.ok(caregiverIdx > hudPreviewIdx);
  assert.equal(passedHtml.includes(EM_DASH), false);
  assert.equal(passedHtml.includes(EN_DASH), false);

  const blockedVerdict = makeSampleVerdict({
    level: "unsure",
    headline: "Amlodipine: strength unclear",
    speech: "I see Amlodipine, but the milligram strength is blurry.",
    read: makeSampleRead({
      strength: { value: "5 mg", confidence: 0.74 }
    }),
    reasons: ["strength confidence 0.74 < 0.8"]
  });

  const blockedHtml = renderApp({
    initialUrl: `${BASE_URL}/`,
    controllerOptions: { storage: createMemoryStorage() },
    initialVerdict: blockedVerdict
  });

  assert.ok(blockedHtml.includes("80% Dose Gate: BLOCKED (74% &lt; 80%)"));
  assert.ok(blockedHtml.includes("Blocked by 80% never-guess gate"));
  assert.equal(blockedHtml.includes(EM_DASH), false);
  assert.equal(blockedHtml.includes(EN_DASH), false);

  for (const locale of ["fi", "sv"] as const) {
    const localizedHtml = renderApp({
      initialUrl: `${BASE_URL}/?lang=${locale}`,
      controllerOptions: { storage: createMemoryStorage() },
      initialVerdict: passedVerdict
    });
    assert.ok(localizedHtml.includes("confidence-breakdown-card"));
    assert.equal(localizedHtml.includes(EM_DASH), false);
    assert.equal(localizedHtml.includes(EN_DASH), false);
  }
});

test("App with initialUrl=?tab=profile renders ProfileManager, saved medications, and CaregiverAlertCard", () => {
  const storage = createMemoryStorage();
  const html = renderApp({
    initialUrl: `${BASE_URL}/?tab=profile`,
    controllerOptions: { storage }
  });

  assert.ok(html.includes('id="panel-profile"'));
  assert.ok(html.includes('aria-labelledby="tab-profile"'));
  assert.equal(html.includes('id="panel-check"'), false);
  assert.equal(html.includes('id="panel-device"'), false);

  for (const med of DEMO_PROFILE.meds) {
    assert.ok(html.includes(med.name), `Expected medication ${med.name} in profile tab`);
    assert.ok(html.includes(med.strength), `Expected strength ${med.strength} in profile tab`);
  }

  assert.ok(html.includes("NSAIDs"));
  assert.ok(html.includes("caregiver-share-actions"));
  assert.equal(html.includes(EM_DASH), false);
  assert.equal(html.includes(EN_DASH), false);
});

test("App with initialUrl=?tab=device renders DeviceResiliencePanel with real SVG QR codes, EvalProofCard, and HudPreviewFrame", () => {
  const storage = createMemoryStorage();
  const html = renderApp({
    initialUrl: `${BASE_URL}/?tab=device`,
    controllerOptions: { storage }
  });

  assert.ok(html.includes('id="panel-device"'));
  assert.ok(html.includes('aria-labelledby="tab-device"'));
  assert.equal(html.includes('id="panel-check"'), false);
  assert.equal(html.includes('id="panel-profile"'), false);

  assert.ok(html.includes("Hardware Pairing (Android DAT Bridge + Ray-Ban Display /hud)"));
  assert.ok(html.includes("Simulate Live WS Drop"));
  assert.ok(html.includes("Simulate Complete Offline"));
  assert.ok(html.includes(`holdupbridge:${DOUBLE_SLASH}connect?server=`));
  assert.ok(html.includes("/hud?session="));

  assert.ok(html.includes("<svg"));
  assert.ok(html.includes('alt="QR code to open the Ray-Ban Display HUD"'));
  assert.ok(html.includes('alt="QR code to configure the HoldUp Android DAT Bridge"'));

  const qrUriMatches = [
    ...html.matchAll(/src="(data:image\/svg\+xml;utf8,([^"]+))"/g)
  ];
  assert.equal(qrUriMatches.length, 2);

  const decodedQrSvgs = qrUriMatches.map((m) => decodeURIComponent(m[2]));
  for (const svgMarkup of decodedQrSvgs) {
    assert.ok(svgMarkup.startsWith("<svg "));
    assert.ok(svgMarkup.includes("<path d=\"M"));
    assert.equal(svgMarkup.includes(EM_DASH), false);
  }
  assert.ok(
    decodedQrSvgs.some((svgMarkup) => svgMarkup.includes("Ray-Ban Display HUD QR"))
  );
  assert.ok(
    decodedQrSvgs.some((svgMarkup) => svgMarkup.includes("HoldUp Android DAT Bridge QR"))
  );

  assert.ok(html.includes("ECE 0.0138"));
  assert.ok(html.includes("Zero Server Image Retention"));
  assert.ok(html.includes("hpf-root"));
  assert.equal(html.includes(EM_DASH), false);
  assert.equal(html.includes(EN_DASH), false);
});

test("App with initialUrl=/hud renders pure #000000 .hud-root HudApp without phone AppHeader, footer, or storage writes", () => {
  const writes: Array<{ key: string; value: string }> = [];
  const spyStorage: KeyValueStorage = {
    getItem() {
      return null;
    },
    setItem(key: string, value: string) {
      writes.push({ key, value });
    },
    removeItem(key: string) {
      writes.push({ key, value: "" });
    }
  };

  const hudHtml = renderApp({
    initialUrl: `${BASE_URL}/hud`,
    controllerOptions: { storage: spyStorage },
    initialVerdict: makeSampleVerdict()
  });

  assert.ok(hudHtml.includes('class="hud-root"'));
  assert.ok(hudHtml.includes('data-hud-surface="600x600-additive"'));
  assert.match(hudHtml, /background-color:\s*#000000/i);
  assert.ok(hudHtml.includes("HoldUp Ready: Hold item in view"));
  assert.ok(hudHtml.includes("AUTO SESSION"));

  assert.equal(hudHtml.includes('class="app-header"'), false);
  assert.equal(hudHtml.includes('class="app-footer"'), false);
  assert.equal(hudHtml.includes('aria-label="Submission and hardware resources"'), false);
  assert.equal(hudHtml.includes("voice-activity-pill"), false);
  assert.equal(hudHtml.includes("confidence-breakdown-card"), false);
  assert.equal(hudHtml.includes("/judge-handout.html"), false);
  assert.equal(hudHtml.includes("/printable-props.html"), false);
  assert.equal(hudHtml.includes('class="skip-link"'), false);
  assert.equal(hudHtml.includes('id="main-content"'), false);
  assert.equal(hudHtml.includes("consent-onboarding"), false);
  assert.equal(writes.length, 0);
  assert.equal(hudHtml.includes(EM_DASH), false);
  assert.equal(hudHtml.includes(EN_DASH), false);

  const sessionHudHtml = renderApp({
    initialUrl: `${BASE_URL}/hud/?session=hup-4k9m&speak=1`,
    controllerOptions: { storage: spyStorage }
  });
  assert.ok(sessionHudHtml.includes("SESSION hup-4k9m"));
  assert.ok(sessionHudHtml.includes("SPEAK"));
  assert.equal(sessionHudHtml.includes('class="app-footer"'), false);
  assert.equal(writes.length, 0);
  assert.equal(sessionHudHtml.includes(EM_DASH), false);
});

test("App with ?rx= deep link opens PharmacyImportModal role=dialog and ignores hostile rx schemes", () => {
  const storage = createMemoryStorage();
  const rxUrl = `${BASE_URL}/?rx=${encodeURIComponent(SAMPLE_FINNISH_PHARMACY_QR)}`;
  const html = renderApp({
    initialUrl: rxUrl,
    controllerOptions: { storage }
  });

  assert.match(html, /role="dialog"/);
  assert.ok(html.includes('aria-modal="true"'));
  assert.ok(html.includes('id="pharmacy-import-dialog-title"'));
  assert.ok(html.includes("Import Prescription QR"));
  assert.ok(html.includes("Yliopiston Apteekki"));
  assert.equal(html.includes(EM_DASH), false);
  assert.equal(html.includes(EN_DASH), false);

  const hostileHtml = renderApp({
    initialUrl: `${BASE_URL}/?rx=${encodeURIComponent("javascript:alert(1)")}`,
    controllerOptions: { storage: createMemoryStorage() }
  });
  assert.doesNotMatch(hostileHtml, /role="dialog"/);
});

test("Zero em dashes and zero code comments across all rendered tabs, locales, themes, scenarios, surfaces, and source files", () => {
  const urls: readonly string[] = [
    `${BASE_URL}/`,
    `${BASE_URL}/?lang=fi`,
    `${BASE_URL}/?lang=sv`,
    `${BASE_URL}/?theme=light`,
    `${BASE_URL}/?theme=high-contrast`,
    `${BASE_URL}/?scenario=hazelnut_allergy`,
    `${BASE_URL}/?tab=profile&lang=fi`,
    `${BASE_URL}/?tab=profile&lang=sv`,
    `${BASE_URL}/?tab=device&lang=fi`,
    `${BASE_URL}/?tab=device&lang=sv`,
    `${BASE_URL}/?rx=${encodeURIComponent(SAMPLE_FINNISH_PHARMACY_QR)}&lang=fi`,
    `${BASE_URL}/hud`,
    `${BASE_URL}/hud?session=hup-7a2b&speak=true`
  ];

  const sampleVerdict = makeSampleVerdict();

  for (const url of urls) {
    for (const verdict of [null, sampleVerdict] as const) {
      const html = renderApp({
        initialUrl: url,
        controllerOptions: { storage: createMemoryStorage() },
        initialVerdict: verdict
      });
      assert.ok(html.length > 100, `Expected non-empty render for ${url}`);
      assert.equal(html.includes(EM_DASH), false, `Found em dash in ${url}`);
      assert.equal(html.includes(EN_DASH), false, `Found en dash in ${url}`);
    }
  }

  const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const testSource = readFileSync(new URL("./appShell.test.ts", import.meta.url), "utf8");

  for (const [label, source] of [
    ["App.tsx", appSource],
    ["appShell.test.ts", testSource]
  ] as const) {
    assert.equal(source.includes(DOUBLE_SLASH), false, `${label} must not contain line comments`);
    assert.equal(source.includes(BLOCK_OPEN), false, `${label} must not contain block comments`);
    assert.equal(source.includes(BLOCK_CLOSE), false, `${label} must not contain block comment closures`);
    assert.equal(source.includes(EM_DASH), false, `${label} must not contain em dashes`);
    assert.equal(source.includes(EN_DASH), false, `${label} must not contain en dashes`);
  }
});
