import React, { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DEMO_SCENARIOS } from "../src/camera/demoScenarios.ts";
import { ViewfinderStage, type ViewfinderStageProps } from "../src/components/ViewfinderStage.tsx";
import type { CameraSource, CoachCue, TransportMode } from "../src/types.ts";

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

const EM_DASH = String.fromCharCode(0x2014);
const noop = (): void => {};

function renderStage(overrides: Partial<ViewfinderStageProps> = {}): string {
  const videoRef = createRef<HTMLVideoElement>();
  const demoImgRef = createRef<HTMLImageElement>();

  return renderToStaticMarkup(
    createElement(ViewfinderStage, {
      cameraActive: false,
      source: "phone",
      onChangeSource: noop,
      mode: "live",
      coach: null,
      checking: false,
      autoStopRemainingSec: null,
      glassesConnected: false,
      glassesWorn: false,
      videoRef,
      demoImgRef,
      scenarios: DEMO_SCENARIOS,
      activeScenarioId: "amlodipine_match",
      onSelectScenario: noop,
      onStart: noop,
      onStop: noop,
      onSnapshotVerify: noop,
      onOfflineBarcodeScan: noop,
      lang: "en",
      ...overrides
    })
  );
}

function extractOpeningTagByClass(html: string, classToken: string): string {
  const escaped = classToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<([a-z0-9]+)\\b[^>]*class="[^"]*\\b${escaped}\\b[^"]*"[^>]*>`, "i");
  const match = pattern.exec(html);
  assert.ok(match, `Expected element with class "${classToken}"`);
  return match[0];
}

function extractSvgAfterMarker(html: string, marker: string): string {
  const idx = html.indexOf(marker);
  assert.ok(idx >= 0, `Expected marker "${marker}"`);
  const svgStart = html.indexOf("<svg", idx);
  const svgEnd = html.indexOf("</svg>", svgStart);
  assert.ok(svgStart >= 0 && svgEnd > svgStart, `Expected <svg> after "${marker}"`);
  return html.slice(svgStart, svgEnd + 6);
}

test("Privacy pill renders CAMERA OFF when inactive and glowing .privacy-live-dot + active source + Auto-stop countdown when active", () => {
  const offHtml = renderStage({
    cameraActive: false,
    source: "phone",
    autoStopRemainingSec: 45
  });

  const offPillTag = extractOpeningTagByClass(offHtml, "viewfinder-privacy-pill");
  assert.ok(offPillTag.includes('role="status"'));
  assert.ok(offPillTag.includes('aria-live="polite"'));
  assert.ok(offHtml.includes("CAMERA OFF: Nothing captured"));
  assert.equal(offHtml.includes("privacy-live-dot"), false);
  assert.equal(offHtml.includes("Auto-stop in"), false);

  const sourceExpectations: ReadonlyArray<[CameraSource, string, number, string]> = [
    ["phone", "Phone Camera", 38, "Auto-stop in 38s"],
    ["glasses", "Glasses (DAT)", 14.6, "Auto-stop in 15s"],
    ["demo", "Demo Props", -3, "Auto-stop in 0s"]
  ];

  for (const [source, label, sec, expectedCountdown] of sourceExpectations) {
    const onHtml = renderStage({
      cameraActive: true,
      source,
      autoStopRemainingSec: sec
    });

    assert.ok(onHtml.includes('class="privacy-live-dot"'));
    assert.ok(onHtml.includes(`CAMERA ON: ${label}`));
    assert.ok(onHtml.includes(expectedCountdown));
    assert.equal(onHtml.includes("CAMERA OFF: Nothing captured"), false);
  }

  const noTimerHtml = renderStage({
    cameraActive: true,
    source: "phone",
    autoStopRemainingSec: null
  });
  assert.ok(noTimerHtml.includes('class="privacy-live-dot"'));
  assert.ok(noTimerHtml.includes("CAMERA ON: Phone Camera"));
  assert.equal(noTimerHtml.includes("Auto-stop in"), false);
});

test("Top status bar renders LIVE, SNAPSHOT, and OFFLINE Transport Mode badges accurately", () => {
  const modes: ReadonlyArray<[TransportMode, string]> = [
    ["live", "LIVE"],
    ["snapshot", "SNAPSHOT"],
    ["offline", "OFFLINE"]
  ];

  for (const [mode, expectedBadge] of modes) {
    const html = renderStage({ mode });
    const modeTag = extractOpeningTagByClass(html, `viewfinder-mode-${mode}`);
    assert.ok(modeTag.includes(`data-transport-mode="${mode}"`));
    assert.ok(html.includes(`<span>${expectedBadge}</span>`));
  }
});

test("Segmented Source Selector renders accessible radiogroup with roving tabindex for Phone Camera, Glasses (DAT), and Demo Props", () => {
  const sources: ReadonlyArray<[CameraSource, string]> = [
    ["phone", "Phone Camera"],
    ["glasses", "Glasses (DAT)"],
    ["demo", "Demo Props"]
  ];

  for (const [selectedSource] of sources) {
    const html = renderStage({ source: selectedSource });
    const groupTag = extractOpeningTagByClass(html, "viewfinder-source-selector");
    assert.ok(groupTag.includes('role="radiogroup"'));
    assert.ok(groupTag.includes('aria-label="Camera source"'));

    for (const [optId, optLabel] of sources) {
      const pattern = new RegExp(
        `<button\\b[^>]*data-source-option="${optId}"[^>]*>[\\s\\S]*?<span>${optLabel.replace(/[()]/g, "\\$&")}</span>`,
        "i"
      );
      const match = pattern.exec(html);
      assert.ok(match, `Expected radio button for ${optLabel}`);
      const buttonMarkup = match[0];

      assert.ok(buttonMarkup.includes('role="radio"'));
      assert.ok(buttonMarkup.includes("min-height:56px"));
      if (optId === selectedSource) {
        assert.ok(buttonMarkup.includes('aria-checked="true"'));
        assert.ok(buttonMarkup.includes('tabindex="0"'));
      } else {
        assert.ok(buttonMarkup.includes('aria-checked="false"'));
        assert.ok(buttonMarkup.includes('tabindex="-1"'));
      }
    }
  }
});

test("Phone source renders visible playsInline muted autoPlay video element and toggles standby framing overlay", () => {
  const standbyHtml = renderStage({
    source: "phone",
    cameraActive: false
  });

  const videoTag = extractOpeningTagByClass(standbyHtml, "viewfinder-video");
  assert.match(videoTag, /\bplaysInline=""/i);
  assert.match(videoTag, /\bmuted=""/i);
  assert.match(videoTag, /\bautoPlay=""/i);
  assert.ok(videoTag.includes("display:block"));
  assert.doesNotMatch(videoTag, /\shidden(?:=""|\s|>)/);
  assert.ok(standbyHtml.includes("viewfinder-phone-standby"));
  assert.equal(standbyHtml.includes("viewfinder-glasses-pov"), false);
  assert.equal(standbyHtml.includes("viewfinder-demo-img"), false);
  assert.equal(standbyHtml.includes("viewfinder-scenario-grid"), false);

  const activeHtml = renderStage({
    source: "phone",
    cameraActive: true
  });
  const activeVideoTag = extractOpeningTagByClass(activeHtml, "viewfinder-video");
  assert.ok(activeVideoTag.includes("display:block"));
  assert.equal(activeHtml.includes("viewfinder-phone-standby"), false);
});

test("Glasses source hides phone video and renders first-person POV card for streaming vs waiting connection/worn states", () => {
  const streamingHtml = renderStage({
    source: "glasses",
    cameraActive: true,
    glassesConnected: true,
    glassesWorn: true
  });

  const hiddenVideo = extractOpeningTagByClass(streamingHtml, "viewfinder-video");
  assert.ok(hiddenVideo.includes("display:none"));
  assert.match(hiddenVideo, /\shidden(?:=""|\s|>)/);

  const povTag = extractOpeningTagByClass(streamingHtml, "viewfinder-glasses-pov");
  assert.ok(povTag.includes('data-glasses-connected="true"'));
  assert.ok(povTag.includes('data-glasses-worn="true"'));
  assert.ok(streamingHtml.includes("Bridge Connected"));
  assert.ok(streamingHtml.includes("Glasses Worn"));
  assert.ok(
    streamingHtml.includes(
      "Streaming first-person frames from Ray-Ban Meta via Android DAT bridge"
    )
  );
  assert.equal(streamingHtml.includes("Waiting for HoldUp Bridge stream..."), false);

  const doffedHtml = renderStage({
    source: "glasses",
    cameraActive: true,
    glassesConnected: true,
    glassesWorn: false
  });
  assert.ok(doffedHtml.includes("Bridge Connected"));
  assert.ok(doffedHtml.includes("Glasses Doffed"));
  assert.ok(doffedHtml.includes("Waiting for HoldUp Bridge stream..."));
  assert.equal(
    doffedHtml.includes("Streaming first-person frames from Ray-Ban Meta via Android DAT bridge"),
    false
  );

  const disconnectedHtml = renderStage({
    source: "glasses",
    cameraActive: false,
    glassesConnected: false,
    glassesWorn: false
  });
  assert.ok(disconnectedHtml.includes("Bridge Disconnected"));
  assert.ok(disconnectedHtml.includes("Glasses Doffed"));
  assert.ok(disconnectedHtml.includes("Waiting for HoldUp Bridge stream..."));
});

test("Demo source renders crossOrigin anonymous fixture image and all 7 accessible scenario buttons with aria-pressed", () => {
  const html = renderStage({
    source: "demo",
    activeScenarioId: "hazelnut_allergy",
    scenarios: DEMO_SCENARIOS
  });

  const hiddenVideo = extractOpeningTagByClass(html, "viewfinder-video");
  assert.ok(hiddenVideo.includes("display:none"));
  assert.match(hiddenVideo, /\shidden(?:=""|\s|>)/);

  const imgTag = extractOpeningTagByClass(html, "viewfinder-demo-img");
  assert.ok(imgTag.includes('src="/fixtures/hazelnut_bar.jpg"'));
  assert.ok(imgTag.includes('crossorigin="anonymous"'));
  assert.ok(imgTag.includes('alt="Hazelnut snack bar (allergy catch)"'));

  const gridTag = extractOpeningTagByClass(html, "viewfinder-scenario-grid");
  assert.ok(gridTag.includes('role="group"'));
  assert.ok(gridTag.includes('aria-label="Demo prop scenarios"'));

  assert.equal(DEMO_SCENARIOS.length, 7);

  const pressedTrue = html.match(/class="btn viewfinder-scenario-btn[^"]*"[^>]*aria-pressed="true"/g) ?? [];
  const pressedFalse = html.match(/class="btn viewfinder-scenario-btn[^"]*"[^>]*aria-pressed="false"/g) ?? [];
  assert.equal(pressedTrue.length, 1);
  assert.equal(pressedFalse.length, 6);

  for (const scenario of DEMO_SCENARIOS) {
    assert.ok(
      html.includes(`data-scenario-id="${scenario.id}"`),
      `Missing scenario card ${scenario.id}`
    );
    assert.ok(html.includes(scenario.title), `Missing scenario title ${scenario.title}`);
    assert.ok(html.includes(scenario.subtitle), `Missing scenario subtitle ${scenario.subtitle}`);
  }
});

test("Coaching Cue Banner omits when coach is null and renders polite banner with 8 distinct directional SVG icons", () => {
  const withoutCoachHtml = renderStage({ coach: null });
  assert.equal(withoutCoachHtml.includes("viewfinder-coach-banner"), false);

  const cues: ReadonlyArray<[CoachCue, string]> = [
    ["rotate_left", "ROTATE LEFT"],
    ["rotate_right", "ROTATE RIGHT"],
    ["closer", "MOVE CLOSER"],
    ["farther", "MOVE FARTHER"],
    ["more_light", "MORE LIGHT"],
    ["hold_still", "HOLD STILL"],
    ["other_side", "TURN PACKAGE OVER"],
    ["ok", "LABEL IN VIEW"]
  ];

  const distinctSvgs = new Set<string>();

  for (const [cue, expectedBadge] of cues) {
    const html = renderStage({
      coach: { cue, text: `Guidance prompt for ${cue}` }
    });

    const bannerTag = extractOpeningTagByClass(html, "viewfinder-coach-banner");
    assert.ok(bannerTag.includes(`data-coach-cue="${cue}"`));
    assert.ok(bannerTag.includes('role="status"'));
    assert.ok(bannerTag.includes('aria-live="polite"'));
    assert.ok(html.includes(`>${expectedBadge}</span>`));
    assert.ok(html.includes(`>Guidance prompt for ${cue}</p>`));

    const svg = extractSvgAfterMarker(html, `data-coach-cue="${cue}"`);
    distinctSvgs.add(svg);
  }

  assert.equal(distinctSvgs.size, 8, "Every CoachCue must render a distinct directional SVG icon");

  const localizedFallbackHtml = renderStage({
    lang: "fi",
    coach: { cue: "other_side", text: "   " }
  });
  assert.ok(localizedFallbackHtml.includes("Käännä toinen puoli esiin"));
});

test("Primary >= 56px controls toggle Start Check / Stop Camera, guard Read Snapshot Now while checking, and highlight Match Saved Barcode offline", () => {
  const idleLiveHtml = renderStage({
    cameraActive: false,
    checking: false,
    mode: "live"
  });

  const startBtn = extractOpeningTagByClass(idleLiveHtml, "viewfinder-btn-toggle");
  assert.ok(startBtn.includes('data-action="start-check"'));
  assert.ok(startBtn.includes("min-height:60px"));
  assert.ok(idleLiveHtml.includes("<span>Start Check</span>"));
  assert.equal(idleLiveHtml.includes("<span>Stop Camera</span>"), false);

  const snapshotBtn = extractOpeningTagByClass(idleLiveHtml, "viewfinder-btn-snapshot");
  assert.ok(snapshotBtn.includes("min-height:60px"));
  assert.ok(snapshotBtn.includes('aria-disabled="false"'));
  assert.doesNotMatch(snapshotBtn, /\sdisabled(?:=""|\s|>)/);
  assert.ok(idleLiveHtml.includes("<span>Read Snapshot Now</span>"));

  const liveBarcodeBtn = extractOpeningTagByClass(idleLiveHtml, "viewfinder-btn-barcode");
  assert.ok(liveBarcodeBtn.includes("min-height:60px"));
  assert.ok(liveBarcodeBtn.includes('data-highlighted="false"'));
  assert.equal(liveBarcodeBtn.includes("is-offline-highlighted"), false);
  assert.ok(idleLiveHtml.includes("<span>Match Saved Barcode</span>"));

  const activeCheckingOfflineHtml = renderStage({
    cameraActive: true,
    checking: true,
    mode: "offline"
  });

  const stageTag = extractOpeningTagByClass(activeCheckingOfflineHtml, "viewfinder-stage");
  assert.ok(stageTag.includes('aria-busy="true"'));
  assert.ok(activeCheckingOfflineHtml.includes("Checking label..."));

  const stopBtn = extractOpeningTagByClass(activeCheckingOfflineHtml, "viewfinder-btn-toggle");
  assert.ok(stopBtn.includes('data-action="stop-camera"'));
  assert.ok(stopBtn.includes("btn-danger"));
  assert.ok(stopBtn.includes("min-height:60px"));
  assert.ok(activeCheckingOfflineHtml.includes("<span>Stop Camera</span>"));

  const busySnapshotBtn = extractOpeningTagByClass(
    activeCheckingOfflineHtml,
    "viewfinder-btn-snapshot"
  );
  assert.match(busySnapshotBtn, /\sdisabled(?:=""|\s|>)/);
  assert.ok(busySnapshotBtn.includes('aria-disabled="true"'));

  const offlineBarcodeBtn = extractOpeningTagByClass(
    activeCheckingOfflineHtml,
    "viewfinder-btn-barcode"
  );
  assert.ok(offlineBarcodeBtn.includes('data-highlighted="true"'));
  assert.ok(offlineBarcodeBtn.includes("is-offline-highlighted"));
  assert.ok(offlineBarcodeBtn.includes("btn-primary"));
});

test("ViewfinderStage emits zero em dashes across all camera sources, transport modes, demo props, and coaching cues", () => {
  const allCues: readonly CoachCue[] = [
    "rotate_left",
    "rotate_right",
    "closer",
    "farther",
    "more_light",
    "hold_still",
    "other_side",
    "ok"
  ];

  const renders: Array<[string, string]> = [
    ["phone-off", renderStage({ source: "phone", cameraActive: false, mode: "live" })],
    [
      "phone-on",
      renderStage({ source: "phone", cameraActive: true, autoStopRemainingSec: 42, mode: "snapshot" })
    ],
    [
      "glasses-streaming",
      renderStage({
        source: "glasses",
        cameraActive: true,
        glassesConnected: true,
        glassesWorn: true,
        autoStopRemainingSec: 25
      })
    ],
    [
      "glasses-waiting",
      renderStage({
        source: "glasses",
        cameraActive: false,
        glassesConnected: false,
        glassesWorn: false,
        mode: "offline"
      })
    ],
    ...DEMO_SCENARIOS.map((s): [string, string] => [
      `demo-${s.id}`,
      renderStage({ source: "demo", activeScenarioId: s.id, checking: true })
    ]),
    ...allCues.map((cue): [string, string] => [
      `coach-${cue}`,
      renderStage({ coach: { cue, text: "" }, lang: "sv" })
    ])
  ];

  for (const [label, html] of renders) {
    assert.equal(html.includes(EM_DASH), false, `${label} must not contain any em dash`);
  }
});
