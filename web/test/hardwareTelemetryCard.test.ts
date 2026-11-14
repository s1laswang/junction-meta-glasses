import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  HardwareTelemetryCard,
  LOW_BATTERY_THRESHOLD_PCT,
  summarizeHardwareLink,
  type AdaptiveTier,
  type GlassesLinkState,
  type HardwareTelemetryCardProps,
  type SessionMode
} from "../src/components/HardwareTelemetryCard.tsx";
import type { DeviceState } from "../src/types.ts";

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

const nodeTestSpec: string = "node:test";
const nodeAssertSpec: string = "node:assert/strict";
const nodeFsSpec: string = "node:fs/promises";
const nodeUrlSpec: string = "node:url";

const { test } = (await import(nodeTestSpec)) as { test: TestFn };
const assert: AssertStrict = (await import(nodeAssertSpec)) as AssertStrict;
const { readFile } = (await import(nodeFsSpec)) as {
  readFile(path: string, encoding: string): Promise<string>;
};
const { fileURLToPath } = (await import(nodeUrlSpec)) as {
  fileURLToPath(url: string | URL): string;
};

const EM_DASH = "\u2014";
const EN_DASH = "\u2013";
const LINE_COMMENT = "\x2f\x2f";
const BLOCK_COMMENT_OPEN = "\x2f*";
const BLOCK_COMMENT_CLOSE = "*\x2f";

function makeDevice(overrides: Partial<DeviceState> = {}): DeviceState {
  return {
    connected: true,
    worn: true,
    battery: 84,
    streaming: true,
    source: "glasses",
    ...overrides
  };
}

function renderCard(overrides: Partial<HardwareTelemetryCardProps> = {}): string {
  const props: HardwareTelemetryCardProps = {
    device: makeDevice(),
    hudConnected: true,
    mode: "live",
    rttMs: 92,
    cameraActive: true,
    lang: "en",
    ...overrides
  };
  return renderToStaticMarkup(createElement(HardwareTelemetryCard, props));
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

test("summarizeHardwareLink resolves all 5 glassesLink states and Capture LED invariants", () => {
  assert.equal(LOW_BATTERY_THRESHOLD_PCT, 15);

  const streaming = summarizeHardwareLink({
    device: makeDevice({ connected: true, worn: true, battery: 84, streaming: true, source: "glasses" }),
    hudConnected: true,
    mode: "live",
    rttMs: 88,
    cameraActive: true
  });
  assert.equal(streaming.glassesLink, "streaming_glasses");
  assert.equal(streaming.captureLedActive, true);
  assert.equal(streaming.activeEye, "glasses");
  assert.equal(streaming.bluetoothAudioReady, true);
  assert.equal(streaming.batteryPercent, 84);

  const standbyIdleStream = summarizeHardwareLink({
    device: makeDevice({ connected: true, worn: true, battery: 78, streaming: false, source: "phone" }),
    hudConnected: false,
    mode: "live",
    rttMs: 110,
    cameraActive: false
  });
  assert.equal(standbyIdleStream.glassesLink, "standby_glasses");
  assert.equal(standbyIdleStream.captureLedActive, false);
  assert.equal(standbyIdleStream.activeEye, "phone");
  assert.equal(standbyIdleStream.bluetoothAudioReady, true);

  const standbyCameraStopped = summarizeHardwareLink({
    device: makeDevice({ connected: true, worn: true, battery: 78, streaming: true, source: "glasses" }),
    hudConnected: true,
    mode: "live",
    rttMs: 110,
    cameraActive: false
  });
  assert.equal(standbyCameraStopped.glassesLink, "standby_glasses");
  assert.equal(standbyCameraStopped.captureLedActive, false);

  const thresholdExact = summarizeHardwareLink({
    device: makeDevice({ connected: true, worn: true, battery: 15, streaming: true, source: "glasses" }),
    hudConnected: true,
    mode: "live",
    rttMs: 110,
    cameraActive: true
  });
  assert.equal(thresholdExact.glassesLink, "streaming_glasses");

  const lowBattery = summarizeHardwareLink({
    device: makeDevice({ connected: true, worn: true, battery: 12, streaming: false, source: "phone" }),
    hudConnected: true,
    mode: "live",
    rttMs: 120,
    cameraActive: true
  });
  assert.equal(lowBattery.glassesLink, "low_battery_fallback");
  assert.equal(lowBattery.captureLedActive, false);
  assert.equal(lowBattery.batteryPercent, 12);
  assert.equal(lowBattery.activeEye, "phone");

  const doffed = summarizeHardwareLink({
    device: makeDevice({ connected: true, worn: false, battery: 66, streaming: false, source: "phone" }),
    hudConnected: false,
    mode: "live",
    rttMs: 140,
    cameraActive: true
  });
  assert.equal(doffed.glassesLink, "doffed_fallback");
  assert.equal(doffed.captureLedActive, false);
  assert.equal(doffed.activeEye, "phone");

  const phoneOnly = summarizeHardwareLink({
    device: makeDevice({ connected: false, worn: false, battery: null, streaming: false, source: "phone" }),
    hudConnected: false,
    mode: "live",
    rttMs: 140,
    cameraActive: true
  });
  assert.equal(phoneOnly.glassesLink, "phone_only");
  assert.equal(phoneOnly.captureLedActive, false);
  assert.equal(phoneOnly.bluetoothAudioReady, false);
  assert.equal(phoneOnly.batteryPercent, null);
});

test("summarizeHardwareLink maps computeAdaptiveParams across all 4 adaptiveTier states", () => {
  const highNullRtt = summarizeHardwareLink({
    device: makeDevice(),
    hudConnected: true,
    mode: "live",
    rttMs: null,
    cameraActive: true
  });
  assert.equal(highNullRtt.adaptiveTier, "high_768p");
  assert.equal(highNullRtt.adaptiveParams.maxDim, 768);
  assert.equal(highNullRtt.adaptiveParams.targetFps, 1.0);
  assert.equal(highNullRtt.rttMs, null);

  const highFast = summarizeHardwareLink({
    device: makeDevice(),
    hudConnected: true,
    mode: "live",
    rttMs: 249,
    cameraActive: true
  });
  assert.equal(highFast.adaptiveTier, "high_768p");
  assert.equal(highFast.adaptiveParams.jpegQuality, 0.78);

  const mediumLowerBound = summarizeHardwareLink({
    device: makeDevice(),
    hudConnected: true,
    mode: "live",
    rttMs: 250,
    cameraActive: true
  });
  assert.equal(mediumLowerBound.adaptiveTier, "medium_640p");
  assert.equal(mediumLowerBound.adaptiveParams.maxDim, 640);
  assert.equal(mediumLowerBound.adaptiveParams.targetFps, 0.75);

  const mediumUpperBound = summarizeHardwareLink({
    device: makeDevice(),
    hudConnected: true,
    mode: "snapshot",
    rttMs: 650,
    cameraActive: true
  });
  assert.equal(mediumUpperBound.adaptiveTier, "medium_640p");
  assert.equal(mediumUpperBound.adaptiveParams.jpegQuality, 0.64);

  const lowSlow = summarizeHardwareLink({
    device: makeDevice(),
    hudConnected: false,
    mode: "snapshot",
    rttMs: 651,
    cameraActive: true
  });
  assert.equal(lowSlow.adaptiveTier, "low_512p");
  assert.equal(lowSlow.adaptiveParams.maxDim, 512);
  assert.equal(lowSlow.adaptiveParams.targetFps, 0.5);
  assert.equal(lowSlow.adaptiveParams.jpegQuality, 0.5);

  const offlineTier = summarizeHardwareLink({
    device: makeDevice({ connected: false, worn: false, battery: null, streaming: false, source: "phone" }),
    hudConnected: false,
    mode: "offline",
    rttMs: 95,
    cameraActive: false
  });
  assert.equal(offlineTier.adaptiveTier, "offline");
  assert.equal(offlineTier.adaptiveParams.targetFps, 0);
});

test("HardwareTelemetryCard SSR renders accessible section, 4 crisp tiles with distinct icons, and all link/tier states", () => {
  const activeHtml = renderCard();

  assert.match(
    activeHtml,
    /^<section\b[^>]*aria-labelledby="hardware-telemetry-card-heading"[^>]*lang="en"/
  );
  assert.match(
    activeHtml,
    /<h2\b[^>]*id="hardware-telemetry-card-heading"[^>]*>Meta AI Glasses, Capture LED &amp; Adaptive Link Telemetry<\/h2>/
  );
  assert.ok(activeHtml.includes('role="status"'));
  assert.ok(activeHtml.includes('aria-live="polite"'));
  assert.ok(activeHtml.includes('data-glasses-link="streaming_glasses"'));
  assert.ok(activeHtml.includes('data-capture-led="active"'));
  assert.ok(activeHtml.includes('data-hud-link="connected"'));
  assert.ok(activeHtml.includes('data-adaptive-tier="high_768p"'));

  const expectedStates: Record<string, string> = {
    "dat-camera": "streaming_glasses",
    "capture-led": "active",
    "hud-waveguide": "connected",
    "adaptive-bandwidth": "high_768p"
  };

  const svgs = new Set<string>();
  for (const [tileId, expectedState] of Object.entries(expectedStates)) {
    const tileTag = extractOpeningTagByAttr(activeHtml, "data-tile-id", tileId);
    assert.ok(
      tileTag.includes(`data-tile-state="${expectedState}"`),
      `Expected data-tile-state="${expectedState}" on ${tileId}`
    );

    const startIdx = activeHtml.indexOf(`data-tile-id="${tileId}"`);
    const svgStart = activeHtml.indexOf("<svg", startIdx);
    const svgEnd = activeHtml.indexOf("</svg>", svgStart);
    assert.ok(svgStart >= 0 && svgEnd > svgStart, `Missing SVG icon in ${tileId}`);
    const svgMarkup = activeHtml.slice(svgStart, svgEnd + 6);
    assert.ok(svgMarkup.includes('aria-hidden="true"'));
    svgs.add(svgMarkup);
  }
  assert.equal(svgs.size, 4, "All 4 hardware telemetry tiles must render distinct SVG icons");

  assert.ok(activeHtml.includes("Ray-Ban Gen 2 DAT Camera"));
  assert.ok(activeHtml.includes("Firmware Capture LED Bystander Indicator"));
  assert.ok(activeHtml.includes("Ray-Ban Display /hud-ws Waveguide"));
  assert.ok(activeHtml.includes("RTT-Adaptive Bandwidth Tier"));
  assert.ok(activeHtml.includes("LED LOCKED ON"));
  assert.ok(activeHtml.includes("SYNCED /hud-ws"));
  assert.ok(activeHtml.includes("768 px @ 1 fps, 78% JPEG (92 ms, LIVE)"));

  const lowBatHtml = renderCard({
    device: makeDevice({ connected: true, worn: true, battery: 12, streaming: false, source: "phone" }),
    hudConnected: false,
    mode: "snapshot",
    rttMs: 420,
    cameraActive: true
  });
  assert.ok(lowBatHtml.includes('data-glasses-link="low_battery_fallback"'));
  assert.ok(lowBatHtml.includes('data-capture-led="inactive"'));
  assert.ok(lowBatHtml.includes('data-hud-link="standby"'));
  assert.ok(lowBatHtml.includes('data-adaptive-tier="medium_640p"'));
  assert.ok(lowBatHtml.includes("Battery 12% (&lt;15%) -&gt; Phone Camera"));
  assert.ok(lowBatHtml.includes("LED OFF (IDLE)"));
  assert.ok(lowBatHtml.includes("WAITING /hud-ws"));
  assert.ok(lowBatHtml.includes("640 px @ 0.75 fps, 64% JPEG (420 ms, SNAPSHOT)"));

  const doffedHtml = renderCard({
    device: makeDevice({ connected: true, worn: false, battery: 72, streaming: false, source: "phone" }),
    hudConnected: false,
    mode: "live",
    rttMs: 820,
    cameraActive: true
  });
  assert.ok(doffedHtml.includes('data-glasses-link="doffed_fallback"'));
  assert.ok(doffedHtml.includes('data-adaptive-tier="low_512p"'));
  assert.ok(doffedHtml.includes("DOFFED FALLBACK"));
  assert.ok(doffedHtml.includes("LOW 512P SAVER"));

  const standbyHtml = renderCard({
    device: makeDevice({ connected: true, worn: true, battery: 90, streaming: false, source: "phone" }),
    cameraActive: false
  });
  assert.ok(standbyHtml.includes('data-glasses-link="standby_glasses"'));
  assert.ok(standbyHtml.includes("BT HFP READY"));

  const phoneOfflineHtml = renderCard({
    device: makeDevice({ connected: false, worn: false, battery: null, streaming: false, source: "phone" }),
    hudConnected: false,
    mode: "offline",
    rttMs: null,
    cameraActive: false
  });
  assert.ok(phoneOfflineHtml.includes('data-glasses-link="phone_only"'));
  assert.ok(phoneOfflineHtml.includes('data-adaptive-tier="offline"'));
  assert.ok(phoneOfflineHtml.includes("PHONE EYE ACTIVE"));
  assert.ok(phoneOfflineHtml.includes("OFFLINE LOCAL"));
  assert.ok(phoneOfflineHtml.includes("0 fps network stream (OFFLINE BarcodeDetector)"));
});

test("Localizes HardwareTelemetryCard across en, fi, sv with en fallback", () => {
  const enHtml = renderCard({ lang: "en" });
  const fiHtml = renderCard({ lang: "fi-FI" });
  const svHtml = renderCard({ lang: "sv-SE" });
  const deHtml = renderCard({ lang: "de" });

  assert.ok(fiHtml.includes('lang="fi"'));
  assert.ok(fiHtml.includes("Meta AI -lasit, kuvaus-LED ja mukautuva yhteystelemetria"));
  assert.ok(fiHtml.includes("Ray-Ban Gen 2 DAT -kamera"));
  assert.ok(fiHtml.includes("LED LUKITTU PÄÄLLE"));
  assert.ok(fiHtml.includes("SYNKRONOITU /hud-ws"));
  assert.ok(fiHtml.includes("KORKEA 768P"));

  assert.ok(svHtml.includes('lang="sv"'));
  assert.ok(svHtml.includes("Meta AI-glasögon, inspelnings-LED och adaptiv länktelemetri"));
  assert.ok(svHtml.includes("Ray-Ban Gen 2 DAT-kamera"));
  assert.ok(svHtml.includes("LED LÅST PÅ"));
  assert.ok(svHtml.includes("SYNKAD /hud-ws"));
  assert.ok(svHtml.includes("HÖG 768P"));

  assert.equal(deHtml, enHtml);
});

test("HardwareTelemetryCard and test suite contain zero comments, zero em dashes, and zero en dashes", async () => {
  const deviceCases: DeviceState[] = [
    makeDevice({ connected: true, worn: true, battery: 84, streaming: true, source: "glasses" }),
    makeDevice({ connected: true, worn: true, battery: 84, streaming: false, source: "phone" }),
    makeDevice({ connected: true, worn: true, battery: 12, streaming: false, source: "phone" }),
    makeDevice({ connected: true, worn: false, battery: 64, streaming: false, source: "phone" }),
    makeDevice({ connected: false, worn: false, battery: null, streaming: false, source: "phone" })
  ];
  const modes: SessionMode[] = ["live", "snapshot", "offline"];
  const rtts: Array<number | null> = [null, 90, 420, 820];
  const locales = ["en", "fi", "sv", "de"];

  for (const lang of locales) {
    for (const device of deviceCases) {
      for (const mode of modes) {
        for (const rttMs of rtts) {
          for (const hudConnected of [true, false]) {
            const html = renderCard({
              device,
              hudConnected,
              mode,
              rttMs,
              cameraActive: device.streaming,
              lang
            });
            const checkResult: { link: GlassesLinkState; tier: AdaptiveTier } = {
              link: summarizeHardwareLink({
                device,
                hudConnected,
                mode,
                rttMs,
                cameraActive: device.streaming
              }).glassesLink,
              tier: summarizeHardwareLink({
                device,
                hudConnected,
                mode,
                rttMs,
                cameraActive: device.streaming
              }).adaptiveTier
            };
            assert.equal(
              html.includes(EM_DASH),
              false,
              `Em dash found for lang=${lang} link=${checkResult.link} tier=${checkResult.tier}`
            );
            assert.equal(
              html.includes(EN_DASH),
              false,
              `En dash found for lang=${lang} link=${checkResult.link} tier=${checkResult.tier}`
            );
          }
        }
      }
    }
  }

  const componentPath = fileURLToPath(
    new URL("../src/components/HardwareTelemetryCard.tsx", import.meta.url)
  );
  const testPath = fileURLToPath(new URL(import.meta.url));
  const [componentSrc, testSrc] = await Promise.all([
    readFile(componentPath, "utf8"),
    readFile(testPath, "utf8")
  ]);

  for (const [name, src] of [
    ["HardwareTelemetryCard.tsx", componentSrc],
    ["hardwareTelemetryCard.test.ts", testSrc]
  ] as const) {
    assert.equal(src.includes(EM_DASH), false, `${name} contains an em dash`);
    assert.equal(src.includes(EN_DASH), false, `${name} contains an en dash`);
    assert.equal(src.includes(LINE_COMMENT), false, `${name} contains a line comment`);
    assert.equal(src.includes(BLOCK_COMMENT_OPEN), false, `${name} contains a block comment opener`);
    assert.equal(src.includes(BLOCK_COMMENT_CLOSE), false, `${name} contains a block comment closer`);
  }
});
