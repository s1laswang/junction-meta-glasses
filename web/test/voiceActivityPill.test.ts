import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { rmsLevel } from "../src/audio/pcm.ts";
import {
  VoiceActivityPill,
  quantizeMicBars,
  resolveVoiceActivityState,
  type VoiceActivityPillProps,
  type VoiceActivityState
} from "../src/components/VoiceActivityPill.tsx";
import type { LiveState, TransportMode } from "../src/types.ts";

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
const noop = (): void => {};

function makeProps(overrides: Partial<VoiceActivityPillProps> = {}): VoiceActivityPillProps {
  return {
    cameraActive: true,
    mode: "live",
    live: "open",
    muted: false,
    assistantSpeaking: false,
    micRms: 0.4,
    lang: "en",
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

function extractBadgeSvg(html: string, state: VoiceActivityState): string {
  const marker = `data-voice-badge="${state}"`;
  const idx = html.indexOf(marker);
  assert.ok(idx >= 0, `Expected badge marker ${marker}`);
  const svgStart = html.indexOf("<svg", idx);
  const closeToken = "<" + "\x2fsvg>";
  const svgEnd = html.indexOf(closeToken, svgStart);
  assert.ok(svgStart >= 0 && svgEnd > svgStart, `Expected svg inside ${marker}`);
  return html.slice(svgStart, svgEnd + closeToken.length);
}

test("resolveVoiceActivityState resolves all 6 states with deterministic priority and privacy invariants", () => {
  assert.equal(
    resolveVoiceActivityState({
      cameraActive: true,
      mode: "live",
      live: "open",
      muted: false,
      assistantSpeaking: false
    }),
    "listening"
  );

  assert.equal(
    resolveVoiceActivityState({
      cameraActive: true,
      mode: "live",
      live: "open",
      muted: false,
      assistantSpeaking: true
    }),
    "assistant_speaking"
  );

  assert.equal(
    resolveVoiceActivityState({
      cameraActive: false,
      mode: "snapshot",
      live: "degraded",
      muted: false,
      assistantSpeaking: true
    }),
    "assistant_speaking"
  );

  assert.equal(
    resolveVoiceActivityState({
      cameraActive: true,
      mode: "snapshot",
      live: "closed",
      muted: false
    }),
    "snapshot_ready"
  );

  assert.equal(
    resolveVoiceActivityState({
      cameraActive: true,
      mode: "live",
      live: "degraded",
      muted: false
    }),
    "snapshot_ready"
  );

  assert.equal(
    resolveVoiceActivityState({
      cameraActive: true,
      mode: "offline",
      live: "closed",
      muted: false
    }),
    "offline_local"
  );

  assert.equal(
    resolveVoiceActivityState({
      cameraActive: false,
      mode: "offline",
      live: "closed",
      muted: false
    }),
    "offline_local"
  );

  assert.equal(
    resolveVoiceActivityState({
      cameraActive: true,
      mode: "live",
      live: "open",
      muted: true,
      assistantSpeaking: true
    }),
    "muted"
  );

  assert.equal(
    resolveVoiceActivityState({
      cameraActive: false,
      mode: "offline",
      live: "closed",
      muted: true
    }),
    "muted"
  );

  assert.equal(
    resolveVoiceActivityState({
      cameraActive: false,
      mode: "live",
      live: "closed",
      muted: false
    }),
    "idle"
  );

  assert.equal(
    resolveVoiceActivityState({
      cameraActive: false,
      mode: "live",
      live: "open",
      muted: false
    }),
    "idle"
  );

  assert.equal(
    resolveVoiceActivityState({
      cameraActive: true,
      mode: "live",
      live: "connecting",
      muted: false
    }),
    "idle"
  );

  assert.equal(
    resolveVoiceActivityState({
      cameraActive: true,
      mode: "live",
      live: "reconnecting",
      muted: false
    }),
    "idle"
  );
});

test("quantizeMicBars clamps finite and non-finite inputs cleanly into [0.2, 1.0]", () => {
  assert.deepEqual(quantizeMicBars(0), [0.2, 0.2, 0.2, 0.2, 0.2]);
  assert.deepEqual(quantizeMicBars(1), [1, 1, 1, 1, 1]);
  assert.deepEqual(quantizeMicBars(Number.NaN), [0.2, 0.2, 0.2, 0.2, 0.2]);
  assert.deepEqual(quantizeMicBars(-5), [0.2, 0.2, 0.2, 0.2, 0.2]);
  assert.deepEqual(quantizeMicBars(Number.NEGATIVE_INFINITY), [0.2, 0.2, 0.2, 0.2, 0.2]);
  assert.deepEqual(quantizeMicBars(Number.POSITIVE_INFINITY), [1, 1, 1, 1, 1]);
  assert.deepEqual(quantizeMicBars(4.2), [1, 1, 1, 1, 1]);

  const halfRms = rmsLevel(new Float32Array([0.5, -0.5, 0.5, -0.5]));
  assert.deepEqual(quantizeMicBars(halfRms), [1, 1, 0.6, 0.2, 0.2]);

  assert.equal(quantizeMicBars(0.4, 3).length, 3);
  assert.deepEqual(quantizeMicBars(0.5, 0), []);
  assert.deepEqual(quantizeMicBars(0.5, -2), []);
  assert.equal(quantizeMicBars(0.5, Number.NaN).length, 5);

  const sweep = [-10, -0.1, 0, 0.08, 0.22, 0.35, 0.5, 0.74, 0.92, 1, 10];
  let previous = quantizeMicBars(sweep[0]);
  for (const sample of sweep) {
    const bars = quantizeMicBars(sample, 5);
    assert.equal(bars.length, 5);
    for (let i = 0; i < bars.length; i += 1) {
      assert.ok(Number.isFinite(bars[i]), `Bar ${i} must be finite for rms=${sample}`);
      assert.ok(bars[i] >= 0.2 && bars[i] <= 1.0, `Bar ${i} out of [0.2, 1.0] for rms=${sample}`);
      assert.ok(bars[i] >= previous[i], `Bar ${i} should be monotonic for rms=${sample}`);
    }
    previous = bars;
  }
});

test("VoiceActivityPill renders distinct SVG icons, high-contrast badges, and 5-bar aria-hidden VU meter for all 6 states", () => {
  const stateConfigs: ReadonlyArray<[VoiceActivityState, VoiceActivityPillProps, string]> = [
    ["listening", makeProps({ cameraActive: true, mode: "live", live: "open", muted: false, micRms: 0.6 }), "MIC LISTENING"],
    [
      "assistant_speaking",
      makeProps({ cameraActive: true, mode: "live", live: "open", muted: false, assistantSpeaking: true, micRms: 0.3 }),
      "HOLDUP SPEAKING"
    ],
    ["snapshot_ready", makeProps({ cameraActive: true, mode: "snapshot", live: "closed", muted: false }), "SNAPSHOT AUDIO"],
    ["offline_local", makeProps({ cameraActive: false, mode: "offline", live: "closed", muted: false }), "OFFLINE LOCAL"],
    ["muted", makeProps({ cameraActive: true, mode: "live", live: "open", muted: true, micRms: 0.9 }), "AUDIO MUTED"],
    ["idle", makeProps({ cameraActive: false, mode: "live", live: "closed", muted: false, micRms: 0.8 }), "MIC STANDBY"]
  ];

  const svgs = new Set<string>();

  for (const [expectedState, props, expectedBadge] of stateConfigs) {
    const html = renderToStaticMarkup(createElement(VoiceActivityPill, props));
    const regionTag = extractOpeningTagByClass(html, "voice-activity-pill");

    assert.ok(regionTag.includes('role="region"'));
    assert.ok(regionTag.includes('aria-label="Open-ear voice and audio status"'));
    assert.ok(regionTag.includes(`data-voice-state="${expectedState}"`));
    assert.ok(html.includes(`<span>${expectedBadge}<` + "\x2fspan>"));

    const vuTag = extractOpeningTagByClass(html, "voice-vu-meter");
    assert.ok(vuTag.includes('aria-hidden="true"'));
    assert.ok(vuTag.includes('data-bar-count="5"'));

    const barMatches = html.match(/class="voice-vu-bar"/g) ?? [];
    assert.equal(barMatches.length, 5, `Expected 5 VU bars in state ${expectedState}`);

    if (expectedState === "muted" || expectedState === "idle") {
      const restingMatches = html.match(/data-bar-height="0\.2"/g) ?? [];
      assert.equal(restingMatches.length, 5, `${expectedState} must clamp VU meter to resting 0.2`);
    }

    if (expectedState === "listening") {
      assert.ok(html.includes('class="privacy-live-dot"'));
      assert.ok(html.includes('data-bar-height="1"'));
    }

    svgs.add(extractBadgeSvg(html, expectedState));
  }

  assert.equal(svgs.size, 6, "All 6 VoiceActivityState values must render distinct SVG icons");
});

test("VoiceActivityPill localizes region aria-label and status text across en, fi, sv with fallback to en", () => {
  const enHtml = renderToStaticMarkup(
    createElement(VoiceActivityPill, makeProps({ lang: "en", assistantSpeaking: true, onInterruptSpeech: noop }))
  );
  const fiHtml = renderToStaticMarkup(
    createElement(VoiceActivityPill, makeProps({ lang: "fi", assistantSpeaking: true, onInterruptSpeech: noop }))
  );
  const svHtml = renderToStaticMarkup(
    createElement(VoiceActivityPill, makeProps({ lang: "sv", assistantSpeaking: true, onInterruptSpeech: noop }))
  );
  const fiRegionalHtml = renderToStaticMarkup(
    createElement(VoiceActivityPill, makeProps({ lang: "fi-FI", assistantSpeaking: true, onInterruptSpeech: noop }))
  );
  const fallbackHtml = renderToStaticMarkup(
    createElement(VoiceActivityPill, makeProps({ lang: "de-DE", assistantSpeaking: true, onInterruptSpeech: noop }))
  );

  assert.notEqual(enHtml, fiHtml);
  assert.notEqual(enHtml, svHtml);
  assert.notEqual(fiHtml, svHtml);
  assert.equal(fiRegionalHtml, fiHtml);
  assert.equal(fallbackHtml, enHtml);

  assert.ok(enHtml.includes('aria-label="Open-ear voice and audio status"'));
  assert.ok(enHtml.includes("HOLDUP SPEAKING"));
  assert.ok(enHtml.includes("Interrupt Speech"));

  assert.ok(fiHtml.includes('aria-label="Avoimen korvan puhe- ja äänitila"'));
  assert.ok(fiHtml.includes("HOLDUP PUHUU"));
  assert.ok(fiHtml.includes("Keskeytä puhe"));

  assert.ok(svHtml.includes('aria-label="Röst- och ljudstatus med öppet öra"'));
  assert.ok(svHtml.includes("HOLDUP TALAR"));
  assert.ok(svHtml.includes("Avbryt tal"));
});

test("VoiceActivityPill renders >= 48px Interrupt Speech button only when assistantSpeaking is true and onInterruptSpeech is provided", () => {
  const activeWithHandler = renderToStaticMarkup(
    createElement(
      VoiceActivityPill,
      makeProps({
        assistantSpeaking: true,
        onInterruptSpeech: noop,
        lang: "en"
      })
    )
  );

  const btnTag = extractOpeningTagByClass(activeWithHandler, "voice-interrupt-btn");
  assert.ok(btnTag.includes('type="button"'));
  assert.ok(btnTag.includes('data-action="interrupt-speech"'));
  assert.ok(activeWithHandler.includes("<span>Interrupt Speech<" + "\x2fspan>"));

  const minHeightMatch = /min-height:(\d+)px/.exec(btnTag);
  const minWidthMatch = /min-width:(\d+)px/.exec(btnTag);
  assert.ok(minHeightMatch, "Interrupt button must specify min-height in px");
  assert.ok(minWidthMatch, "Interrupt button must specify min-width in px");
  assert.ok(Number.parseInt(minHeightMatch[1], 10) >= 48);
  assert.ok(Number.parseInt(minWidthMatch[1], 10) >= 48);

  const activeWithoutHandler = renderToStaticMarkup(
    createElement(
      VoiceActivityPill,
      makeProps({
        assistantSpeaking: true,
        onInterruptSpeech: undefined,
        lang: "en"
      })
    )
  );
  assert.equal(activeWithoutHandler.includes("voice-interrupt-btn"), false);

  const silentWithHandler = renderToStaticMarkup(
    createElement(
      VoiceActivityPill,
      makeProps({
        assistantSpeaking: false,
        onInterruptSpeech: noop,
        lang: "en"
      })
    )
  );
  assert.equal(silentWithHandler.includes("voice-interrupt-btn"), false);
  assert.equal(silentWithHandler.includes("Interrupt Speech"), false);
});

test("VoiceActivityPill and its test suite contain zero code comments and emit zero em dashes", () => {
  const componentSource = readFileSync(
    new URL("../src/components/VoiceActivityPill.tsx", import.meta.url),
    "utf8"
  );
  const testSource = readFileSync(new URL("./voiceActivityPill.test.ts", import.meta.url), "utf8");

  for (const [label, source] of [
    ["VoiceActivityPill.tsx", componentSource],
    ["voiceActivityPill.test.ts", testSource]
  ] as const) {
    assert.equal(source.includes(LINE_COMMENT), false, `${label} must not contain line comments`);
    assert.equal(source.includes(BLOCK_COMMENT_OPEN), false, `${label} must not contain block comments`);
    assert.equal(source.includes(BLOCK_COMMENT_CLOSE), false, `${label} must not contain block comment closures`);
    assert.equal(source.includes(EM_DASH), false, `${label} must not contain em dashes`);
    assert.equal(source.includes(EN_DASH), false, `${label} must not contain en dashes`);
  }

  const locales = ["en", "fi", "sv", "de", "es"];
  const modes: readonly TransportMode[] = ["live", "snapshot", "offline"];
  const liveStates: readonly LiveState[] = ["connecting", "open", "reconnecting", "degraded", "closed"];

  for (const lang of locales) {
    for (const mode of modes) {
      for (const live of liveStates) {
        for (const muted of [false, true]) {
          for (const assistantSpeaking of [false, true]) {
            for (const cameraActive of [false, true]) {
              const html = renderToStaticMarkup(
                createElement(VoiceActivityPill, {
                  cameraActive,
                  mode,
                  live,
                  muted,
                  assistantSpeaking,
                  micRms: 0.45,
                  lang,
                  onInterruptSpeech: noop
                })
              );
              assert.equal(html.includes(EM_DASH), false);
              assert.equal(html.includes(EN_DASH), false);
            }
          }
        }
      }
    }
  }
});
