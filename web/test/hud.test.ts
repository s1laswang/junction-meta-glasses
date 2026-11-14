import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  HudApp,
  buildHudWsUrl,
  clampHudHeadline,
  computeHudReconnectDelayMs,
  initialHudState,
  nextFocusIndex,
  reduceHudServerMsg,
  resolveHudSession,
  resolveHudSpeak,
  validateHudSessionParam,
  type HudAppProps
} from "../src/hud/HudApp.tsx";
import type {
  CoachCue,
  DeviceState,
  LabelRead,
  LiveState,
  ServerMsg,
  Verdict,
  VerdictLevel
} from "../../shared/types.ts";

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

interface FsModule {
  readFileSync(path: URL | string, encoding: "utf8"): string;
}

const nodeTestSpec: string = "node:test";
const nodeAssertSpec: string = "node:assert/strict";
const nodeFsSpec: string = "node:fs";

const test: TestFn = ((await import(nodeTestSpec)) as { test: TestFn }).test;
const assert: StrictAssert = ((await import(nodeAssertSpec)) as { default: StrictAssert }).default;
const { readFileSync } = (await import(nodeFsSpec)) as FsModule;

const EM_DASH = String.fromCharCode(8212);
const EN_DASH = String.fromCharCode(8211);
const DOUBLE_SLASH = "\x2f\x2f";

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

function makeLabelRead(overrides: Partial<LabelRead> = {}): LabelRead {
  return {
    kind: "medication",
    product: { value: "Amlodipine", confidence: 0.97 },
    ingredient: { value: "amlodipine", confidence: 0.96 },
    strength: { value: "5 mg", confidence: 0.95 },
    dosing: { value: "1 tablet each evening", confidence: 0.91 },
    expiry: { value: "2027-09", confidence: 0.9 },
    allergens: { value: [], confidence: 0.94 },
    barcode: { value: "6432100012345", confidence: 0.99 },
    readability: 0.95,
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

function renderHud(props?: HudAppProps): string {
  return renderToStaticMarkup(createElement(HudApp, props));
}

function extractActionBtnTag(
  html: string,
  action: "log_dose" | "repeat" | "dismiss"
): string {
  const pattern = new RegExp(`<button\\b[^>]*data-hud-action="${action}"[^>]*>`, "i");
  const match = pattern.exec(html);
  assert.ok(match, `Expected action button ${action}`);
  return match[0];
}

function extractSvgAfter(html: string, marker: string): string {
  const idx = html.indexOf(marker);
  assert.ok(idx >= 0, `Expected marker ${marker}`);
  const start = html.indexOf("<svg", idx);
  const end = html.indexOf("</svg>", start);
  assert.ok(start >= 0 && end > start, `Expected <svg> after ${marker}`);
  return html.slice(start, end + 6);
}

test("initialHudState initializes clean standby defaults and respects speechEnabled option", () => {
  const s0 = initialHudState();
  assert.equal(s0.connected, false);
  assert.equal(s0.live, "closed");
  assert.equal(s0.coach, null);
  assert.equal(s0.verdict, null);
  assert.equal(s0.device, null);
  assert.equal(s0.dismissed, false);
  assert.equal(s0.speechEnabled, false);
  assert.equal(s0.focusIndex, 1);

  const sSpeak = initialHudState({ speechEnabled: true });
  assert.equal(sSpeak.speechEnabled, true);
  assert.equal(sSpeak.focusIndex, 1);
});

test("reduceHudServerMsg handles status, device, coach, verdict un-dismissing + coach clearing, and ignores non-HUD messages", () => {
  const base = initialHudState({ speechEnabled: true });

  const liveStates: readonly LiveState[] = [
    "connecting",
    "open",
    "reconnecting",
    "degraded",
    "closed"
  ];
  let cur = base;
  for (const live of liveStates) {
    cur = reduceHudServerMsg(cur, { type: "status", live, detail: "step" });
    assert.equal(cur.live, live);
  }

  const dev = makeDevice({ battery: 67, worn: true });
  const afterDev = reduceHudServerMsg(cur, { type: "device", device: dev });
  assert.deepEqual(afterDev.device, dev);

  const afterCoach = reduceHudServerMsg(afterDev, {
    type: "coach",
    cue: "rotate_left",
    text: `Turn it left ${EM_DASH} hold steady`
  });
  assert.ok(afterCoach.coach);
  assert.equal(afterCoach.coach.cue, "rotate_left");
  assert.equal(afterCoach.coach.text.includes(EM_DASH), false);
  assert.equal(afterCoach.coach.text, "Turn it left : hold steady");

  const v1 = makeVerdict({ headline: "Yes, Amlodipine 5 mg" });
  const afterV1 = reduceHudServerMsg(afterCoach, { type: "verdict", verdict: v1 });
  assert.deepEqual(afterV1.verdict, v1);
  assert.equal(afterV1.coach, null, "New verdict must clear stale coach");
  assert.equal(afterV1.dismissed, false);

  const dismissedState = {
    ...afterV1,
    dismissed: true,
    coach: { cue: "closer" as const, text: "Move closer" }
  };
  const v2 = makeVerdict({
    level: "warning",
    headline: "Stop: NSAID avoid rule hit",
    matchedMedId: undefined
  });
  const afterV2 = reduceHudServerMsg(dismissedState, { type: "verdict", verdict: v2 });
  assert.deepEqual(afterV2.verdict, v2);
  assert.equal(afterV2.dismissed, false, "New verdict must clear dismissed flag");
  assert.equal(afterV2.coach, null, "New verdict must clear coach cue");
  assert.equal(afterV2.speechEnabled, true);
  assert.deepEqual(afterV2.device, dev);

  const nonHudMsgs: readonly ServerMsg[] = [
    { type: "ready", model: "gemini-3.8-live", session: "hup-1234" },
    { type: "audio", data: "AAAA" },
    { type: "transcript", role: "assistant", text: "Hello", final: true },
    { type: "error", code: "quota", message: "Busy", recoverable: true },
    { type: "pong", t: 123 },
    { type: "interrupted" },
    { type: "checking", phase: "start" },
    { type: "hud", connected: true }
  ];
  for (const msg of nonHudMsgs) {
    const unchanged = reduceHudServerMsg(afterV2, msg);
    assert.equal(unchanged, afterV2);
  }
});

test("nextFocusIndex wraps cyclic focus cleanly across ArrowRight, ArrowDown, ArrowLeft, and ArrowUp", () => {
  assert.equal(nextFocusIndex(0, 3, "ArrowRight"), 1);
  assert.equal(nextFocusIndex(1, 3, "ArrowRight"), 2);
  assert.equal(nextFocusIndex(2, 3, "ArrowRight"), 0);

  assert.equal(nextFocusIndex(0, 3, "ArrowDown"), 1);
  assert.equal(nextFocusIndex(1, 3, "ArrowDown"), 2);
  assert.equal(nextFocusIndex(2, 3, "ArrowDown"), 0);

  assert.equal(nextFocusIndex(2, 3, "ArrowLeft"), 1);
  assert.equal(nextFocusIndex(1, 3, "ArrowLeft"), 0);
  assert.equal(nextFocusIndex(0, 3, "ArrowLeft"), 2);

  assert.equal(nextFocusIndex(2, 3, "ArrowUp"), 1);
  assert.equal(nextFocusIndex(1, 3, "ArrowUp"), 0);
  assert.equal(nextFocusIndex(0, 3, "ArrowUp"), 2);

  assert.equal(nextFocusIndex(1, 3, "Enter"), 1);
  assert.equal(nextFocusIndex(2, 3, "Escape"), 2);
  assert.equal(nextFocusIndex(-1, 3, "Enter"), 2);
  assert.equal(nextFocusIndex(5, 3, "ArrowRight"), 0);
  assert.equal(nextFocusIndex(0, 0, "ArrowRight"), 0);
});

test("session-less /hud-ws URL builder, session validation, speak flag, headline cap, and backoff helpers work deterministically", () => {
  assert.equal(validateHudSessionParam("hup-7f3a"), "hup-7f3a");
  assert.equal(validateHudSessionParam("  demo_session_01  "), "demo_session_01");
  assert.equal(validateHudSessionParam("ab"), null);
  assert.equal(validateHudSessionParam("bad/session"), null);
  assert.equal(validateHudSessionParam(""), null);
  assert.equal(validateHudSessionParam(null), null);

  assert.equal(
    buildHudWsUrl(undefined, { protocol: "https:", host: "holdup.example", search: "" }),
    `wss:${DOUBLE_SLASH}holdup.example/hud-ws`
  );
  assert.equal(
    buildHudWsUrl(undefined, {
      protocol: "https:",
      host: "holdup.example",
      search: "?session=bad!"
    }),
    `wss:${DOUBLE_SLASH}holdup.example/hud-ws`
  );
  assert.equal(
    buildHudWsUrl(undefined, {
      protocol: "https:",
      host: "holdup.example",
      search: "?session=hup-7f3a&speak=1"
    }),
    `wss:${DOUBLE_SLASH}holdup.example/hud-ws?session=hup-7f3a`
  );
  assert.equal(
    buildHudWsUrl("bench-02", { protocol: "http:", host: "localhost:5173", search: "" }),
    `ws:${DOUBLE_SLASH}localhost:5173/hud-ws?session=bench-02`
  );
  assert.equal(
    buildHudWsUrl(null, {
      protocol: "https:",
      host: "holdup.example",
      search: "?session=hup-7f3a"
    }),
    `wss:${DOUBLE_SLASH}holdup.example/hud-ws`
  );

  assert.equal(resolveHudSession(undefined, "?session=hup-9k2m"), "hup-9k2m");
  assert.equal(resolveHudSpeak(undefined, "?speak=1"), true);
  assert.equal(resolveHudSpeak(undefined, "?speak=true"), true);
  assert.equal(resolveHudSpeak(undefined, "?speak=0"), false);
  assert.equal(resolveHudSpeak(true, "?speak=0"), true);
  assert.equal(resolveHudSpeak(false, "?speak=1"), false);

  const clamped = clampHudHeadline(
    "One two three four five six seven eight nine ten eleven,"
  );
  assert.equal(clamped, "One two three four five six seven eight");
  assert.ok(clamped.split(/\s+/).length <= 8);

  assert.equal(computeHudReconnectDelayMs(0), 500);
  assert.equal(computeHudReconnectDelayMs(1), 1000);
  assert.equal(computeHudReconnectDelayMs(2), 2000);
  assert.equal(computeHudReconnectDelayMs(3), 4000);
  assert.equal(computeHudReconnectDelayMs(4), 5000);
  assert.equal(computeHudReconnectDelayMs(9), 5000);
});

test("HudApp SSR standby renders pure #000000 root, waveguide status strip, standby reticle, and 3 Neural Band buttons", () => {
  const html = renderHud();

  assert.match(html, /^<main\b[^>]*class="hud-root"/);
  assert.ok(html.includes("background-color:#000000"));
  assert.ok(html.includes("color:#ffffff"));
  assert.ok(html.includes('data-hud-surface="600x600-additive"'));

  assert.ok(html.includes("RECONNECTING"));
  assert.ok(html.includes("GLASSES STANDBY"));
  assert.ok(html.includes("AUTO SESSION"));
  assert.ok(html.includes('data-hud-standby="true"'));
  assert.ok(html.includes("HoldUp Ready: Hold item in view"));

  const logBtn = extractActionBtnTag(html, "log_dose");
  assert.match(logBtn, /\sdisabled(?:=""|\s|>)/);
  assert.ok(logBtn.includes('aria-disabled="true"'));
  assert.ok(logBtn.includes('data-focused="false"'));
  assert.ok(html.includes(">Log Dose</button>"));

  const repeatBtn = extractActionBtnTag(html, "repeat");
  assert.doesNotMatch(repeatBtn, /\sdisabled(?:=""|=|\s|>)/);
  assert.ok(repeatBtn.includes('data-focused="true"'));
  assert.ok(repeatBtn.includes('aria-current="true"'));
  assert.ok(html.includes(">Repeat</button>"));

  const dismissBtn = extractActionBtnTag(html, "dismiss");
  assert.doesNotMatch(dismissBtn, /\sdisabled(?:=""|=|\s|>)/);
  assert.ok(dismissBtn.includes('data-focused="false"'));
  assert.ok(html.includes(">Dismiss</button>"));
});

test("HudApp SSR renders all 8 CoachCue directional arrow SVGs and coaching prompts", () => {
  const cues: readonly CoachCue[] = [
    "rotate_left",
    "rotate_right",
    "closer",
    "farther",
    "more_light",
    "hold_still",
    "other_side",
    "ok"
  ];
  const distinctSvgs = new Set<string>();

  for (const cue of cues) {
    const html = renderHud({
      sessionParam: "hup-7f3a",
      speak: true,
      initialState: {
        connected: true,
        live: "open",
        device: makeDevice({ battery: 90, worn: true }),
        coach: { cue, text: `Coach prompt ${cue}` }
      }
    });

    assert.ok(html.includes("HUD LIVE"));
    assert.ok(html.includes("WORN 90%"));
    assert.ok(html.includes("SESSION hup-7f3a | SPEAK"));
    assert.ok(html.includes(`data-coach-cue="${cue}"`));
    assert.ok(html.includes(`>Coach prompt ${cue}</p>`));
    assert.equal(html.includes("HoldUp Ready: Hold item in view"), false);

    const svg = extractSvgAfter(html, `data-coach-cue="${cue}"`);
    distinctSvgs.add(svg);
  }

  assert.equal(distinctSvgs.size, 8, "Each CoachCue must render a distinct SVG arrow");
});

test("HudApp SSR renders all 4 VerdictLevel cards with 4-channel redundancy, <=8 word cap, strength + takenToday badges, Log Dose gating, and dismiss behavior", () => {
  const specs: ReadonlyArray<{
    level: VerdictLevel;
    badge: string;
    shape: string;
    color: string;
  }> = [
    { level: "match", badge: "MATCH", shape: "circle", color: "#22ff88" },
    { level: "warning", badge: "WARNING", shape: "triangle", color: "#ffbb22" },
    { level: "unsure", badge: "UNSURE", shape: "diamond", color: "#38d6ff" },
    { level: "info", badge: "INFO", shape: "square", color: "#f0f6ff" }
  ];

  const colorNeutralGeometries = new Set<string>();

  for (const spec of specs) {
    const canLog = spec.level === "match";
    const verdict = makeVerdict({
      level: spec.level,
      headline: "Alpha beta gamma delta epsilon zeta eta theta iota kappa",
      speech: `Spoken summary for ${spec.level} ${EM_DASH} verified ${EN_DASH} clear.`,
      matchedMedId: canLog ? "aml" : undefined,
      takenToday: spec.level === "warning" ? true : canLog ? false : undefined
    });

    const html = renderHud({
      initialState: {
        connected: true,
        live: "open",
        verdict,
        dismissed: false,
        focusIndex: 0
      }
    });

    assert.ok(html.includes(`data-verdict-level="${spec.level}"`));
    assert.ok(html.includes(`data-verdict-shape="${spec.shape}"`));
    assert.ok(html.includes(`border-color:${spec.color}`));
    assert.ok(html.includes(`>${spec.badge}</span>`));
    assert.ok(
      html.includes(
        '<h1 class="hud-headline">Alpha beta gamma delta epsilon zeta eta theta</h1>'
      )
    );
    assert.equal(html.includes("iota"), false);
    assert.ok(html.includes('data-hud-strength="5 mg"'));
    assert.ok(html.includes(">5 mg</span>"));
    assert.ok(html.includes('class="hud-speech-caption"'));

    if (spec.level === "match") {
      assert.ok(html.includes(">NOT TAKEN TODAY</span>"));
      const logBtn = extractActionBtnTag(html, "log_dose");
      assert.doesNotMatch(logBtn, /\sdisabled(?:=""|=|\s|>)/);
      assert.ok(logBtn.includes('aria-disabled="false"'));
      assert.ok(logBtn.includes('data-focused="true"'));
    } else if (spec.level === "warning") {
      assert.ok(html.includes(">TAKEN TODAY</span>"));
      const logBtn = extractActionBtnTag(html, "log_dose");
      assert.match(logBtn, /\sdisabled(?:=""|\s|>)/);
      assert.ok(logBtn.includes('aria-disabled="true"'));
    } else {
      const logBtn = extractActionBtnTag(html, "log_dose");
      assert.match(logBtn, /\sdisabled(?:=""|\s|>)/);
      assert.ok(logBtn.includes('aria-disabled="true"'));
    }

    const svg = extractSvgAfter(html, `data-shape="${spec.shape}"`);
    assert.ok(svg.includes(spec.color));
    colorNeutralGeometries.add(
      svg.replace(/stroke="[^"]*"/g, "").replace(/fill="[^"]*"/g, "")
    );
  }

  assert.equal(
    colorNeutralGeometries.size,
    4,
    "All 4 VerdictLevel icons must have distinct non-color geometries"
  );

  const dismissedHtml = renderHud({
    initialState: {
      connected: true,
      live: "open",
      verdict: makeVerdict(),
      dismissed: true
    }
  });
  assert.equal(dismissedHtml.includes("data-verdict-level="), false);
  assert.ok(dismissedHtml.includes("HoldUp Ready: Hold item in view"));
  assert.match(extractActionBtnTag(dismissedHtml, "log_dose"), /\sdisabled(?:=""|\s|>)/);
});

test("hud.css enforces pure #000000 additive waveguide scoping, semantic tokens, 4px #ffee00 focus ring, and zero em dashes across all HUD files and renders", () => {
  const hudCss = readFileSync(new URL("../src/hud/hud.css", import.meta.url), "utf8");
  const hudTsx = readFileSync(new URL("../src/hud/HudApp.tsx", import.meta.url), "utf8");

  assert.ok(hudCss.includes(":root:has(.hud-root)"));
  assert.ok(hudCss.includes("background: #000000"));
  assert.ok(hudCss.includes("#22ff88"));
  assert.ok(hudCss.includes("#ffbb22"));
  assert.ok(hudCss.includes("#38d6ff"));
  assert.ok(hudCss.includes("#f0f6ff"));
  assert.ok(hudCss.includes("clamp(26px, 5.5vmin, 38px)"));
  assert.ok(hudCss.includes("4px solid #ffee00"));
  assert.ok(hudCss.includes(".hud-action-btn:focus-visible"));
  assert.ok(hudCss.includes('.hud-action-btn[data-focused="true"]'));
  assert.ok(hudCss.includes("@media (prefers-reduced-motion: reduce)"));

  assert.equal(hudCss.includes(EM_DASH), false);
  assert.equal(hudTsx.includes(EM_DASH), false);

  const sampleRenders = [
    renderHud(),
    renderHud({
      initialState: {
        connected: true,
        live: "reconnecting",
        device: makeDevice({ connected: true, worn: false, battery: 11 })
      }
    }),
    renderHud({
      initialState: {
        connected: false,
        live: "degraded",
        device: makeDevice({ connected: false, worn: false, battery: null, source: "phone" }),
        coach: { cue: "other_side", text: `Flip package ${EM_DASH} show label` }
      }
    }),
    renderHud({
      initialState: {
        connected: true,
        live: "open",
        verdict: makeVerdict({
          headline: `Match ${EM_DASH} Amlodipine 5 mg`,
          speech: `Confirmed ${EM_DASH} evening tablet.`
        })
      }
    })
  ];

  for (const html of sampleRenders) {
    assert.equal(html.includes(EM_DASH), false);
    assert.equal(html.includes(EN_DASH), false);
  }
});
