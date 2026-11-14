import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { App, type AppProps } from "../src/App.tsx";
import { SAMPLE_FINNISH_PHARMACY_QR } from "../src/pairing/pharmacyQr.ts";
import {
  DEMO_PROFILE,
  createMemoryStorage,
  saveConsent,
  type KeyValueStorage
} from "../src/storage/profileStore.ts";

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

const DOUBLE_SLASH = "\x2f\x2f";
const BASE_URL = `http:${DOUBLE_SLASH}localhost:5173`;
const EM_DASH = String.fromCharCode(8212);
const EN_DASH = String.fromCharCode(8211);

function renderApp(props?: AppProps): string {
  return renderToStaticMarkup(props ? createElement(App, props) : createElement(App));
}

test("App at / renders AppHeader, skip link #main-content, ConsentOnboarding when unaccepted, JudgeDemoTour, ViewfinderStage, VerdictCard, ConversationBar, HudPreviewFrame, and CaregiverAlertCard", () => {
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

  assert.ok(html.includes("Ask HoldUp or Tap a Quick Check"));
  assert.ok(html.includes("Is this my evening pill?"));

  assert.ok(html.includes("verdict-ready-title"));
  assert.ok(html.includes("Ready to check"));

  assert.ok(html.includes("hpf-root"));
  assert.ok(html.includes('data-waveguide-viewport="600x600"'));

  assert.ok(html.includes("caregiver-share-actions"));
  assert.ok(html.includes("Preview Outgoing Family Message"));

  assert.doesNotMatch(html, /role="dialog"/);
  assert.equal(html.includes(EM_DASH), false);
  assert.equal(html.includes(EN_DASH), false);

  const defaultNoPropsHtml = renderApp();
  assert.ok(defaultNoPropsHtml.includes('id="main-content"'));
  assert.ok(defaultNoPropsHtml.includes('id="panel-check"'));
  assert.equal(defaultNoPropsHtml.includes(EM_DASH), false);

  const acceptedStorage = createMemoryStorage();
  saveConsent(true, acceptedStorage);
  const acceptedHtml = renderApp({
    initialUrl: `${BASE_URL}/`,
    controllerOptions: { storage: acceptedStorage }
  });
  assert.equal(acceptedHtml.includes("consent-onboarding"), false);
  assert.ok(acceptedHtml.includes('id="panel-check"'));
  assert.equal(acceptedHtml.includes(EM_DASH), false);
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

test("App with initialUrl=/hud renders pure #000000 .hud-root HudApp without phone AppHeader or storage writes", () => {
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
    controllerOptions: { storage: spyStorage }
  });

  assert.ok(hudHtml.includes('class="hud-root"'));
  assert.ok(hudHtml.includes('data-hud-surface="600x600-additive"'));
  assert.match(hudHtml, /background-color:\s*#000000/i);
  assert.ok(hudHtml.includes("HoldUp Ready: Hold item in view"));
  assert.ok(hudHtml.includes("AUTO SESSION"));

  assert.equal(hudHtml.includes('class="app-header"'), false);
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

test("Zero em dashes across all rendered tabs, locales, themes, scenarios, and surfaces", () => {
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

  for (const url of urls) {
    const html = renderApp({
      initialUrl: url,
      controllerOptions: { storage: createMemoryStorage() }
    });
    assert.ok(html.length > 100, `Expected non-empty render for ${url}`);
    assert.equal(html.includes(EM_DASH), false, `Found em dash in ${url}`);
    assert.equal(html.includes(EN_DASH), false, `Found en dash in ${url}`);
  }
});
