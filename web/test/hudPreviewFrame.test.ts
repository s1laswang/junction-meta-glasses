import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HudPreviewFrame, type HudPreviewFrameProps } from "../src/hud/HudPreviewFrame.tsx";
import type {
  CoachCue,
  DeviceState,
  LabelRead,
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
const noop = (): void => {};

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

function makeLabelRead(overrides: Partial<LabelRead> = {}): LabelRead {
  return {
    kind: "medication",
    product: { value: "Amlodipine", confidence: 0.97 },
    ingredient: { value: "amlodipine", confidence: 0.96 },
    strength: { value: "5 mg", confidence: 0.95 },
    dosing: { value: "1 tablet each evening", confidence: 0.91 },
    expiry: { value: "2027-08", confidence: 0.9 },
    allergens: { value: [], confidence: 0.93 },
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

function renderHudPreview(overrides: Partial<HudPreviewFrameProps> = {}): string {
  return renderToStaticMarkup(
    createElement(HudPreviewFrame, {
      verdict: null,
      coach: null,
      checking: false,
      device: makeDevice(),
      hudSocketConnected: true,
      onTriggerHudEvent: noop,
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

function extractActionButtonTag(html: string, actionName: "log_dose" | "repeat" | "dismiss"): string {
  const pattern = new RegExp(`<button\\b[^>]*data-hud-action="${actionName}"[^>]*>`, "i");
  const match = pattern.exec(html);
  assert.ok(match, `Expected HUD action button "${actionName}"`);
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

test("Standby state renders pure #000000 600x600 waveguide viewport, /hud standalone link, and all 3 Neural Band gesture simulator controls", () => {
  const html = renderHudPreview({
    verdict: null,
    coach: null,
    checking: false
  });

  assert.match(html, /^<section\b[^>]*class="hpf-root"[^>]*aria-labelledby="hpf-heading"/);
  assert.ok(html.includes('id="hpf-heading"'));
  assert.ok(html.includes("Meta Ray-Ban Display: In-Lens Waveguide Preview (600x600 Additive)"));

  const waveguideTag = extractOpeningTagByClass(html, "hpf-waveguide");
  assert.ok(waveguideTag.includes('data-waveguide-viewport="600x600"'));
  assert.ok(waveguideTag.includes("background-color:#000000"));
  assert.ok(waveguideTag.includes("aspect-ratio:1 / 1"));
  assert.ok(waveguideTag.includes('tabindex="0"'));
  assert.ok(waveguideTag.includes('role="group"'));
  assert.ok(waveguideTag.includes('aria-label="600 by 600 additive light waveguide viewport"'));
  assert.ok(html.includes("<span>600x600 ADDITIVE</span>"));

  const reticleTag = extractOpeningTagByClass(html, "hpf-reticle");
  assert.ok(reticleTag.includes('data-idle-reticle="true"'));
  assert.ok(html.includes("STANDBY RETICLE"));
  assert.equal(html.includes('class="hpf-checking-box"'), false);
  assert.equal(html.includes('class="hpf-hud-card"'), false);
  assert.equal(html.includes('class="hpf-coach-card"'), false);
  assert.equal(html.includes("data-verdict-level="), false);
  assert.equal(html.includes("data-coach-cue="), false);

  const openLinkTag = extractOpeningTagByClass(html, "hpf-open-link");
  assert.ok(openLinkTag.includes('href="/hud"'));
  assert.ok(openLinkTag.includes('target="_blank"'));
  assert.ok(openLinkTag.includes('rel="noopener noreferrer"'));
  assert.ok(html.includes("<span>Open /hud Window</span>"));

  const neuralBarTag = extractOpeningTagByClass(html, "hpf-neural-bar");
  assert.ok(neuralBarTag.includes('role="group"'));
  assert.ok(neuralBarTag.includes('aria-label="Simulated Meta Neural Band Gesture Bar"'));
  assert.ok(html.includes("Focus: Log Dose (Save to device log)"));

  assert.ok(html.includes("<span>Thumb Swipe Left (ArrowLeft)</span>"));
  assert.ok(html.includes("<span>Thumb Swipe Right (ArrowRight)</span>"));
  assert.ok(html.includes("<span>Index Pinch (Enter)</span>"));

  const pinchBtnTag = extractOpeningTagByClass(html, "hpf-gesture-pinch");
  assert.ok(pinchBtnTag.includes('type="button"'));
});

test("Standalone /hud link preserves encoded ?session= query parameter when window.location.search is present", () => {
  const g = globalThis as Record<string, unknown>;
  const previousWindow = g.window;

  try {
    delete g.window;
    const ssrHtml = renderHudPreview();
    assert.ok(extractOpeningTagByClass(ssrHtml, "hpf-open-link").includes('href="/hud"'));

    g.window = { location: { search: "?theme=high-contrast" } };
    const noSessionHtml = renderHudPreview();
    assert.ok(extractOpeningTagByClass(noSessionHtml, "hpf-open-link").includes('href="/hud"'));

    g.window = { location: { search: "?session=hup-7f3a&lang=en" } };
    const sessionHtml = renderHudPreview();
    assert.ok(
      extractOpeningTagByClass(sessionHtml, "hpf-open-link").includes('href="/hud?session=hup-7f3a"')
    );

    g.window = { location: { search: "?session=demo%20room%2B1" } };
    const encodedSessionHtml = renderHudPreview();
    assert.ok(
      extractOpeningTagByClass(encodedSessionHtml, "hpf-open-link").includes(
        'href="/hud?session=demo%20room%2B1"'
      )
    );
  } finally {
    if (previousWindow === undefined) {
      delete g.window;
    } else {
      g.window = previousWindow;
    }
  }
});

test("checking=true renders polite waveguide checking indicator and overrides coach or stale verdict", () => {
  const html = renderHudPreview({
    checking: true,
    verdict: null,
    coach: null
  });

  const waveguideTag = extractOpeningTagByClass(html, "hpf-waveguide");
  assert.ok(waveguideTag.includes("background-color:#000000"));

  const checkingTag = extractOpeningTagByClass(html, "hpf-checking-box");
  assert.ok(checkingTag.includes('role="status"'));
  assert.ok(checkingTag.includes('aria-live="polite"'));

  const orbTag = extractOpeningTagByClass(html, "hpf-pulse-orb");
  assert.ok(orbTag.includes('aria-hidden="true"'));
  const orbSvg = extractSvgAfterMarker(html, 'class="hpf-pulse-orb"');
  assert.ok(orbSvg.includes("#22ff88"));

  assert.ok(html.includes("CHECKING LABEL..."));
  assert.ok(html.includes("Verifying fields and personal medication safety"));
  assert.equal(html.includes("STANDBY RETICLE"), false);
  assert.equal(html.includes("data-verdict-level="), false);
  assert.equal(html.includes("data-coach-cue="), false);

  const overrideHtml = renderHudPreview({
    checking: true,
    verdict: makeVerdict(),
    coach: { cue: "hold_still", text: "Hold still" }
  });
  assert.ok(overrideHtml.includes("CHECKING LABEL..."));
  assert.equal(overrideHtml.includes("data-verdict-level="), false);
  assert.equal(overrideHtml.includes("data-coach-cue="), false);
});

test("Coaching state with other_side renders directional TURN PACKAGE OVER cue, prompt text, and SVG arrow inside waveguide", () => {
  const html = renderHudPreview({
    verdict: null,
    checking: false,
    coach: { cue: "other_side", text: "Turn it around" }
  });

  const waveguideTag = extractOpeningTagByClass(html, "hpf-waveguide");
  assert.ok(waveguideTag.includes("background-color:#000000"));

  const coachTag = extractOpeningTagByClass(html, "hpf-coach-card");
  assert.ok(coachTag.includes('data-coach-cue="other_side"'));
  assert.ok(coachTag.includes('role="status"'));
  assert.ok(coachTag.includes('aria-live="polite"'));
  assert.ok(coachTag.includes("border-color:#38d6ff"));

  const arrowSvg = extractSvgAfterMarker(html, 'data-coach-cue="other_side"');
  assert.ok(arrowSvg.includes('viewBox="0 0 40 40"'));
  assert.ok(arrowSvg.includes('aria-hidden="true"'));
  assert.ok(arrowSvg.includes("M8 15H31L25.5 9.5M32 25H9L14.5 30.5"));
  assert.ok(arrowSvg.includes('stroke="#38d6ff"'));

  assert.ok(html.includes(">TURN PACKAGE OVER</span>"));
  assert.ok(html.includes(">Turn it around</p>"));
  assert.equal(html.includes("STANDBY RETICLE"), false);
  assert.equal(html.includes("data-verdict-level="), false);
});

test("All 8 CoachCue variants render distinct directional SVG glyphs, uppercase labels, and cue accent colors", () => {
  const expectations: ReadonlyArray<{
    cue: CoachCue;
    label: string;
    accent: string;
  }> = [
    { cue: "rotate_left", label: "ROTATE LEFT", accent: "#38d6ff" },
    { cue: "rotate_right", label: "ROTATE RIGHT", accent: "#38d6ff" },
    { cue: "closer", label: "MOVE CLOSER", accent: "#38d6ff" },
    { cue: "farther", label: "MOVE FARTHER", accent: "#38d6ff" },
    { cue: "more_light", label: "MORE LIGHT", accent: "#ffbb22" },
    { cue: "hold_still", label: "HOLD STILL", accent: "#38d6ff" },
    { cue: "other_side", label: "TURN PACKAGE OVER", accent: "#38d6ff" },
    { cue: "ok", label: "LABEL LOCKED", accent: "#22ff88" }
  ];

  const svgs = new Set<string>();

  for (const spec of expectations) {
    const html = renderHudPreview({
      verdict: null,
      checking: false,
      coach: { cue: spec.cue, text: `Cue prompt for ${spec.cue}` }
    });

    const coachTag = extractOpeningTagByClass(html, "hpf-coach-card");
    assert.ok(coachTag.includes(`data-coach-cue="${spec.cue}"`));
    assert.ok(coachTag.includes(`border-color:${spec.accent}`));
    assert.ok(html.includes(`>${spec.label}</span>`));
    assert.ok(html.includes(`>Cue prompt for ${spec.cue}</p>`));

    const svg = extractSvgAfterMarker(html, `data-coach-cue="${spec.cue}"`);
    svgs.add(svg);
  }

  assert.equal(svgs.size, 8, "Every CoachCue must render a distinct directional SVG glyph");
});

test("All 4 VerdictLevel states render distinct SVG geometries, luminous badges, headlines, and action strips with #ffee00 focus", () => {
  const specs: ReadonlyArray<{
    level: VerdictLevel;
    badge: string;
    color: string;
    headline: string;
  }> = [
    {
      level: "match",
      badge: "MATCH",
      color: "#22ff88",
      headline: "Yes, your evening Amlodipine 5 mg"
    },
    {
      level: "warning",
      badge: "WARNING",
      color: "#ffbb22",
      headline: "Stop: NSAID avoid rule hit"
    },
    {
      level: "unsure",
      badge: "UNSURE",
      color: "#38d6ff",
      headline: "Strength unclear, hold steady"
    },
    {
      level: "info",
      badge: "INFO",
      color: "#ffffff",
      headline: "Oat milk, no listed nuts"
    }
  ];

  const rawSvgs = new Set<string>();
  const colorNeutralGeometries = new Set<string>();

  for (const spec of specs) {
    const html = renderHudPreview({
      checking: false,
      coach: null,
      verdict: makeVerdict({
        level: spec.level,
        headline: spec.headline
      })
    });

    const cardTag = extractOpeningTagByClass(html, "hpf-hud-card");
    assert.ok(cardTag.includes(`data-verdict-level="${spec.level}"`));
    assert.ok(cardTag.includes('role="region"'));
    assert.ok(cardTag.includes(`aria-label="${spec.badge} verdict card"`));
    assert.ok(cardTag.includes("background-color:#000000"));
    assert.ok(cardTag.includes(`border:2.5px solid ${spec.color}`));

    assert.ok(html.includes(`>${spec.badge}</span>`));
    assert.ok(html.includes(`<h3 class="hpf-hud-headline">${spec.headline}</h3>`));
    assert.ok(html.includes("Amlodipine 5 mg"));

    const glyphSvg = extractSvgAfterMarker(html, 'class="hpf-card-badge-group"');
    assert.ok(glyphSvg.includes(spec.color));
    rawSvgs.add(glyphSvg);
    colorNeutralGeometries.add(
      glyphSvg.replace(/stroke="[^"]*"/g, "").replace(/fill="[^"]*"/g, "")
    );

    const actionsGroupTag = extractOpeningTagByClass(html, "hpf-wg-actions");
    assert.ok(actionsGroupTag.includes('role="group"'));
    assert.ok(actionsGroupTag.includes('aria-label="In-lens HUD actions"'));

    assert.ok(html.includes('data-hud-action="log_dose"'));
    assert.ok(html.includes(">Log Dose</button>"));
    assert.ok(html.includes('data-hud-action="repeat"'));
    assert.ok(html.includes(">Repeat</button>"));
    assert.ok(html.includes('data-hud-action="dismiss"'));
    assert.ok(html.includes(">Dismiss</button>"));

    const logDoseBtn = extractActionButtonTag(html, "log_dose");
    assert.ok(logDoseBtn.includes('data-focused="true"'));
    assert.ok(logDoseBtn.includes('aria-current="true"'));
    assert.ok(logDoseBtn.includes("color:#ffee00"));
    assert.ok(logDoseBtn.includes("border:2px solid #ffee00"));
    assert.ok(logDoseBtn.includes("outline:2px solid #ffee00"));

    for (const unfocusedName of ["repeat", "dismiss"] as const) {
      const unfocusedBtn = extractActionButtonTag(html, unfocusedName);
      assert.ok(unfocusedBtn.includes('data-focused="false"'));
      assert.equal(unfocusedBtn.includes("aria-current="), false);
      assert.ok(unfocusedBtn.includes("background-color:#000000"));
      assert.ok(unfocusedBtn.includes("color:#ffffff"));
    }
  }

  assert.equal(rawSvgs.size, 4, "All 4 VerdictLevel states must render distinct SVG icons");
  assert.equal(
    colorNeutralGeometries.size,
    4,
    "All 4 VerdictLevel SVG icons must have distinct non-color geometric silhouettes"
  );
});

test("Verdict card renders TAKEN TODAY vs NOT TAKEN chips, speech fallback, blank product handling, and coach precedence", () => {
  const takenHtml = renderHudPreview({
    verdict: makeVerdict({ takenToday: true }),
    coach: { cue: "closer", text: "Move closer" }
  });
  assert.ok(takenHtml.includes(">TAKEN TODAY</span>"));
  assert.equal(takenHtml.includes(">NOT TAKEN</span>"), false);
  assert.equal(takenHtml.includes("data-coach-cue="), false);

  const notTakenHtml = renderHudPreview({
    verdict: makeVerdict({ takenToday: false })
  });
  assert.ok(notTakenHtml.includes(">NOT TAKEN</span>"));
  assert.equal(notTakenHtml.includes(">TAKEN TODAY</span>"), false);

  const foodFallbackHtml = renderHudPreview({
    verdict: makeVerdict({
      level: "info",
      headline: "Barista oat milk",
      speech: "No peanuts or tree nuts listed on this carton.",
      reasons: [],
      takenToday: undefined,
      read: makeLabelRead({
        kind: "food",
        product: { value: null, confidence: 0.2 },
        strength: { value: null, confidence: 0.1 }
      })
    })
  });
  assert.equal(foodFallbackHtml.includes("TAKEN TODAY"), false);
  assert.equal(foodFallbackHtml.includes("NOT TAKEN"), false);
  assert.equal(foodFallbackHtml.includes('class="hpf-hud-product"'), false);
  assert.ok(foodFallbackHtml.includes("No peanuts or tree nuts listed on this carton."));
});

test("Glasses device telemetry renders connected, worn, doffed, disconnected, phone eye, LED streaming, and battery bounds", () => {
  const wornHtml = renderHudPreview({
    device: makeDevice({
      connected: true,
      worn: true,
      battery: 84,
      streaming: true,
      source: "glasses"
    }),
    hudSocketConnected: true
  });
  assert.ok(wornHtml.includes(">Glasses Worn</span>"));
  assert.ok(wornHtml.includes(">Battery 84%</span>"));
  assert.ok(wornHtml.includes("SYNC | 84%"));
  assert.ok(wornHtml.includes("<span>LED STREAMING</span>"));

  const doffedHtml = renderHudPreview({
    device: makeDevice({
      connected: true,
      worn: false,
      battery: 14.4,
      streaming: false,
      source: "glasses"
    }),
    hudSocketConnected: true
  });
  assert.ok(doffedHtml.includes(">Glasses Doffed</span>"));
  assert.ok(doffedHtml.includes(">Battery 14%</span>"));
  assert.ok(doffedHtml.includes("SYNC | 14%"));
  assert.ok(doffedHtml.includes("<span>LED IDLE</span>"));

  const glassesDisconnectedHtml = renderHudPreview({
    device: makeDevice({
      connected: false,
      worn: false,
      battery: null,
      streaming: false,
      source: "glasses"
    }),
    hudSocketConnected: false
  });
  assert.ok(glassesDisconnectedHtml.includes(">Glasses Disconnected</span>"));
  assert.equal(glassesDisconnectedHtml.includes("Battery "), false);
  assert.ok(glassesDisconnectedHtml.includes("<span>SIM</span>"));

  const phoneEyeHtml = renderHudPreview({
    device: makeDevice({
      connected: false,
      worn: false,
      battery: Number.NaN,
      streaming: false,
      source: "phone"
    }),
    hudSocketConnected: false
  });
  assert.ok(phoneEyeHtml.includes(">Phone Eye Active</span>"));
  assert.equal(phoneEyeHtml.includes("Battery "), false);

  const clampedHighHtml = renderHudPreview({
    device: makeDevice({ battery: 142 })
  });
  assert.ok(clampedHighHtml.includes(">Battery 100%</span>"));
  assert.ok(clampedHighHtml.includes("SYNC | 100%"));

  const clampedLowHtml = renderHudPreview({
    device: makeDevice({ battery: -9 })
  });
  assert.ok(clampedLowHtml.includes(">Battery 0%</span>"));
  assert.ok(clampedLowHtml.includes("SYNC | 0%"));
});

test("hudSocketConnected toggles HUD WS Connected / SYNC vs HUD WS Local Preview / SIM accurately", () => {
  const connectedHtml = renderHudPreview({
    hudSocketConnected: true,
    device: makeDevice({ battery: 91 })
  });
  assert.ok(connectedHtml.includes("HUD WS Connected"));
  assert.equal(connectedHtml.includes("HUD WS Local Preview"), false);
  assert.ok(connectedHtml.includes("<span>SYNC | 91%</span>"));

  const localPreviewHtml = renderHudPreview({
    hudSocketConnected: false,
    device: makeDevice({ battery: 91 })
  });
  assert.ok(localPreviewHtml.includes("HUD WS Local Preview"));
  assert.equal(localPreviewHtml.includes("HUD WS Connected"), false);
  assert.ok(localPreviewHtml.includes("<span>SIM | 91%</span>"));
});

test("Optical additive CSS invariants hold and zero em dashes appear across every HUD state and telemetry combination", () => {
  const allCueRenders = (
    [
      "rotate_left",
      "rotate_right",
      "closer",
      "farther",
      "more_light",
      "hold_still",
      "other_side",
      "ok"
    ] as const
  ).map((cue): [string, string] => [
    `coach-${cue}`,
    renderHudPreview({ coach: { cue, text: `Adjust ${cue}` } })
  ]);

  const allVerdictRenders = (["match", "warning", "unsure", "info"] as const).map(
    (level): [string, string] => [
      `verdict-${level}`,
      renderHudPreview({
        verdict: makeVerdict({
          level,
          takenToday: level === "warning" ? true : level === "match" ? false : undefined
        }),
        hudSocketConnected: level === "match" || level === "warning"
      })
    ]
  );

  const renders: ReadonlyArray<[string, string]> = [
    ["standby-glasses", renderHudPreview()],
    [
      "standby-phone-sim",
      renderHudPreview({
        hudSocketConnected: false,
        device: makeDevice({ connected: false, worn: false, battery: null, streaming: false, source: "phone" })
      })
    ],
    ["checking", renderHudPreview({ checking: true, hudSocketConnected: false })],
    ...allCueRenders,
    ...allVerdictRenders
  ];

  for (const [name, html] of renders) {
    assert.equal(html.includes(EM_DASH), false, `${name} must not contain any em dash`);
    assert.ok(
      html.includes('data-waveguide-viewport="600x600"'),
      `${name} must retain 600x600 waveguide viewport`
    );
    assert.ok(
      html.includes("background-color:#000000"),
      `${name} must retain pure #000000 inline waveguide background`
    );
    assert.ok(
      html.includes("@media (prefers-reduced-motion: reduce)"),
      `${name} must include reduced-motion safeguard`
    );
  }
});
