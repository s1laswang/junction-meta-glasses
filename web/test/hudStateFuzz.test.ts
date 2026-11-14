import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
  HudApp,
  clampHudHeadline,
  initialHudState,
  nextFocusIndex,
  reduceHudServerMsg,
  sanitizeHudText,
  type HudAppProps,
  type HudState,
  type HudWsLike
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

const DOUBLE_SLASH = "\x2f\x2f";
const LINE_COMMENT = "\x2f\x2f";
const BLOCK_COMMENT_OPEN = "\x2f*";
const BLOCK_COMMENT_CLOSE = "*\x2f";
const HTML_COMMENT_OPEN = "<" + "!--";
const EM_DASH = String.fromCharCode(8212);
const EN_DASH = String.fromCharCode(8211);
const XHTML_NS = `http:${DOUBLE_SLASH}www.w3.org/1999/xhtml`;

const MAX_HEADLINE_WORDS = 8;
const HUD_ACTION_NAMES = ["log_dose", "repeat", "dismiss"] as const;
type HudActionName = (typeof HUD_ACTION_NAMES)[number];

const ALL_COACH_CUES: readonly CoachCue[] = [
  "rotate_left",
  "rotate_right",
  "closer",
  "farther",
  "more_light",
  "hold_still",
  "other_side",
  "ok"
];

const ALL_LIVE_STATES: readonly LiveState[] = [
  "connecting",
  "open",
  "reconnecting",
  "degraded",
  "closed"
];

const ALL_VERDICT_LEVELS: readonly VerdictLevel[] = [
  "match",
  "warning",
  "unsure",
  "info"
];

const EXPECTED_CHANNELS: Record<
  VerdictLevel,
  { badge: string; shape: string; color: string }
> = {
  match: { badge: "MATCH", shape: "circle", color: "#22ff88" },
  warning: { badge: "WARNING", shape: "triangle", color: "#ffbb22" },
  unsure: { badge: "UNSURE", shape: "diamond", color: "#38d6ff" },
  info: { badge: "INFO", shape: "square", color: "#f0f6ff" }
};

const FUZZ_WORDS: readonly string[] = [
  "Amlodipine",
  "Metformin",
  "Paracetamol",
  "Ibuprofen",
  "Burana",
  "Amorion",
  "Hazelnut",
  "Almond",
  "Oat",
  "Evening",
  "Morning",
  "Scheduled",
  "Tablet",
  "Capsule",
  "Verified",
  "Strength",
  "Check",
  "Pharmacist",
  "Allergen",
  "Warning",
  "Hold",
  "Steady",
  "Closer",
  "Package",
  "Aakkoset",
  "5mg",
  "500mg",
  "2,5mg",
  "<box>",
  "&amp;",
  '"pill"',
  "'dose'"
];

type Prng = {
  nextU32(): number;
  nextFloat(): number;
  nextInt(minIncl: number, maxIncl: number): number;
  pick<T>(items: readonly T[]): T;
  chance(probability: number): boolean;
};

function createMulberry32(seed: number): Prng {
  let state = seed >>> 0;
  const nextU32 = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
  const nextFloat = (): number => nextU32() / 4294967296;
  const nextInt = (minIncl: number, maxIncl: number): number => {
    const span = maxIncl - minIncl + 1;
    return minIncl + Math.floor(nextFloat() * span);
  };
  const pick = <T,>(items: readonly T[]): T => items[nextInt(0, items.length - 1)];
  const chance = (probability: number): boolean => nextFloat() < probability;
  return { nextU32, nextFloat, nextInt, pick, chance };
}

function decodeHtmlEntities(htmlText: string): string {
  return htmlText
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'");
}

function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

function extractActionBtnTag(html: string, action: HudActionName): string {
  const pattern = new RegExp(`<button\\b[^>]*data-hud-action="${action}"[^>]*>`, "i");
  const match = pattern.exec(html);
  assert.ok(match, `Expected action button ${action}`);
  return match[0];
}

function isButtonTagDisabled(buttonTag: string): boolean {
  return /\sdisabled(?:=""|\s|>)/.test(buttonTag);
}

function makeSyntheticText(rng: Prng, wordCount: number): string {
  if (wordCount <= 0) {
    return rng.pick(["", "   ", "\n\t  "]);
  }
  const parts: string[] = [];
  for (let i = 0; i < wordCount; i += 1) {
    parts.push(rng.pick(FUZZ_WORDS));
    if (rng.chance(0.18)) {
      parts.push(rng.pick([EM_DASH, EN_DASH, "  ", "\n", "\t"]));
    }
  }
  const suffix = rng.pick(["", ",", ".", ";", ":", ",,,", "...;;;", ": "]);
  return `${parts.join(" ")}${suffix}`;
}

function makeSyntheticLabelRead(
  rng: Prng,
  kind: LabelRead["kind"]
): LabelRead {
  const productVal = rng.chance(0.2)
    ? null
    : rng.pick([
        "Amlodipine",
        "Metformin",
        `Burana ${EN_DASH} 400`,
        `Oat ${EM_DASH} Drink`,
        "Hazelnut <Bar> & Crisp"
      ]);
  const strengthVal =
    kind === "medication" && rng.chance(0.8)
      ? rng.pick(["5 mg", "500 mg", "10 mg", `2,5 mg ${EN_DASH} tablet`, "400 mg"])
      : null;

  return {
    kind,
    product: { value: productVal, confidence: rng.nextFloat() },
    ingredient: {
      value: rng.chance(0.2) ? null : rng.pick(["amlodipine", "metformin", "ibuprofen", "oats"]),
      confidence: rng.nextFloat()
    },
    strength: { value: strengthVal, confidence: rng.nextFloat() },
    dosing: {
      value: rng.chance(0.3) ? null : "1 tablet daily",
      confidence: rng.nextFloat()
    },
    expiry: {
      value: rng.chance(0.25) ? null : rng.pick(["2027-09", "2024-02", "2028-12-31"]),
      confidence: rng.nextFloat()
    },
    allergens: {
      value: rng.chance(0.3) ? null : rng.pick([[], ["oat"], ["hazelnut", "milk"]]),
      confidence: rng.nextFloat()
    },
    barcode: {
      value: rng.chance(0.4) ? null : "6432100012345",
      confidence: rng.nextFloat()
    },
    readability: rng.nextFloat(),
    guidance: rng.chance(0.4) ? makeSyntheticText(rng, rng.nextInt(2, 10)) : undefined
  };
}

function makeSyntheticVerdict(
  rng: Prng,
  opts?: {
    level?: VerdictLevel;
    takenToday?: boolean;
    extremeWords?: number;
  }
): Verdict {
  const level = opts?.level ?? rng.pick(ALL_VERDICT_LEVELS);
  const wordLen =
    opts?.extremeWords ??
    rng.pick([0, 1, 2, 5, 7, 8, 9, 12, 18, 35, 64, 120]);
  const headline = makeSyntheticText(rng, wordLen);
  const speech = makeSyntheticText(rng, rng.pick([0, 3, 10, 28, 60]));

  if (level === "match") {
    const takenToday = opts?.takenToday ?? rng.pick([false, false, true]);
    const hasMedId = rng.chance(0.9);
    return {
      level: "match",
      headline,
      speech,
      matchedMedId: hasMedId ? rng.pick(["aml", "met", "pan_500"]) : undefined,
      takenToday,
      reasons: ["Synthetic match check"],
      read: makeSyntheticLabelRead(rng, "medication")
    };
  }

  if (level === "warning") {
    const isDoubleDoseWarning = opts?.takenToday === true || rng.chance(0.35);
    return {
      level: "warning",
      headline,
      speech,
      matchedMedId: isDoubleDoseWarning ? rng.pick(["aml", "met"]) : undefined,
      takenToday: isDoubleDoseWarning ? true : rng.pick([undefined, false]),
      reasons: ["Synthetic warning check"],
      read: makeSyntheticLabelRead(rng, rng.pick(["medication", "food"]))
    };
  }

  if (level === "unsure") {
    return {
      level: "unsure",
      headline,
      speech,
      matchedMedId: undefined,
      takenToday: opts?.takenToday ?? rng.pick([undefined, false, true]),
      reasons: ["Synthetic unsure check"],
      read: makeSyntheticLabelRead(rng, rng.pick(["unreadable", "medication", "food"]))
    };
  }

  return {
    level: "info",
    headline,
    speech,
    matchedMedId: undefined,
    takenToday: opts?.takenToday ?? rng.pick([undefined, false, true]),
    reasons: ["Synthetic info check"],
    read: makeSyntheticLabelRead(rng, rng.pick(["food", "other"]))
  };
}

function makeSyntheticDevice(rng: Prng): DeviceState {
  const batteryChoices: ReadonlyArray<number | null> = [
    null,
    0,
    1,
    9,
    14,
    14.4,
    15,
    47,
    88,
    100,
    -45,
    185,
    99.7,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY
  ];
  return {
    connected: rng.chance(0.7),
    worn: rng.chance(0.65),
    battery: rng.pick(batteryChoices),
    streaming: rng.chance(0.6),
    source: rng.pick(["glasses", "phone"] as const)
  };
}

function createStorageTrap(label: string, touches: string[]): Storage {
  const target = {} as Storage;
  return new Proxy(target, {
    get(_obj, prop) {
      touches.push(`${label}:get:${String(prop)}`);
      throw new Error(`Forbidden ${label} access on HUD: ${String(prop)}`);
    },
    set(_obj, prop, value) {
      touches.push(`${label}:set:${String(prop)}=${String(value)}`);
      throw new Error(`Forbidden ${label} mutation on HUD: ${String(prop)}`);
    },
    has(_obj, prop) {
      touches.push(`${label}:has:${String(prop)}`);
      return false;
    },
    deleteProperty(_obj, prop) {
      touches.push(`${label}:delete:${String(prop)}`);
      throw new Error(`Forbidden ${label} delete on HUD: ${String(prop)}`);
    },
    ownKeys() {
      touches.push(`${label}:ownKeys`);
      return [];
    }
  });
}

async function withZeroStorageGuard(
  run: (touches: string[]) => void | Promise<void>
): Promise<void> {
  const g = globalThis as Record<string, unknown>;
  const prevLocal = Object.getOwnPropertyDescriptor(g, "localStorage");
  const prevSession = Object.getOwnPropertyDescriptor(g, "sessionStorage");
  const prevIdb = Object.getOwnPropertyDescriptor(g, "indexedDB");

  const touches: string[] = [];
  const localTrap = createStorageTrap("localStorage", touches);
  const sessionTrap = createStorageTrap("sessionStorage", touches);
  const idbTrap = createStorageTrap("indexedDB", touches);

  Object.defineProperty(g, "localStorage", {
    configurable: true,
    enumerable: true,
    get() {
      touches.push("globalThis.localStorage:getter");
      return localTrap;
    }
  });
  Object.defineProperty(g, "sessionStorage", {
    configurable: true,
    enumerable: true,
    get() {
      touches.push("globalThis.sessionStorage:getter");
      return sessionTrap;
    }
  });
  Object.defineProperty(g, "indexedDB", {
    configurable: true,
    enumerable: true,
    get() {
      touches.push("globalThis.indexedDB:getter");
      return idbTrap;
    }
  });

  try {
    await run(touches);
    assert.deepEqual(touches, [], `HUD touched browser storage: ${touches.join(", ")}`);
  } finally {
    if (prevLocal) {
      Object.defineProperty(g, "localStorage", prevLocal);
    } else {
      delete g.localStorage;
    }
    if (prevSession) {
      Object.defineProperty(g, "sessionStorage", prevSession);
    } else {
      delete g.sessionStorage;
    }
    if (prevIdb) {
      Object.defineProperty(g, "indexedDB", prevIdb);
    } else {
      delete g.indexedDB;
    }
  }
}

function assertHudSsrInvariants(
  html: string,
  state: HudState,
  stepLabel: string
): void {
  assert.ok(html.length > 100, `${stepLabel}: SSR output unexpectedly empty`);
  assert.match(html, /^<main\b[^>]*class="hud-root"/, `${stepLabel}: root must be <main class="hud-root">`);
  assert.ok(
    html.includes('data-hud-surface="600x600-additive"'),
    `${stepLabel}: missing 600x600-additive surface marker`
  );
  assert.ok(
    html.includes("background-color:#000000"),
    `${stepLabel}: root must enforce inline #000000 background`
  );
  assert.ok(
    html.includes("color:#ffffff"),
    `${stepLabel}: root must enforce high-contrast #ffffff foreground`
  );

  assert.equal(
    html.includes("undefined"),
    false,
    `${stepLabel}: rendered HTML must never emit "undefined"`
  );
  assert.equal(
    html.includes("NaN"),
    false,
    `${stepLabel}: rendered HTML must never emit "NaN"`
  );
  assert.equal(
    html.includes("Infinity"),
    false,
    `${stepLabel}: rendered HTML must never emit "Infinity"`
  );
  assert.equal(
    html.includes(HTML_COMMENT_OPEN),
    false,
    `${stepLabel}: rendered HTML must never contain comments`
  );
  assert.equal(
    html.includes(EM_DASH),
    false,
    `${stepLabel}: rendered HTML must never contain em dashes`
  );
  assert.equal(
    html.includes(EN_DASH),
    false,
    `${stepLabel}: rendered HTML must never contain en dashes`
  );

  const inlineBgs = [...html.matchAll(/background(?:-color)?:\s*([^;"']+)/gi)];
  assert.ok(inlineBgs.length >= 2, `${stepLabel}: expected >= 2 inline #000000 waveguide backgrounds`);
  for (const bgMatch of inlineBgs) {
    assert.equal(
      bgMatch[1].trim().toLowerCase(),
      "#000000",
      `${stepLabel}: non-black inline background "${bgMatch[1]}" violates additive waveguide`
    );
  }

  const allButtonTags = html.match(/<button\b[^>]*>/gi) ?? [];
  assert.equal(allButtonTags.length, 3, `${stepLabel}: HUD must render exactly 3 action buttons`);

  assert.ok(
    Number.isInteger(state.focusIndex) &&
      state.focusIndex >= 0 &&
      state.focusIndex < HUD_ACTION_NAMES.length,
    `${stepLabel}: focusIndex ${state.focusIndex} out of [0, 2]`
  );

  const logBtn = extractActionBtnTag(html, "log_dose");
  const repeatBtn = extractActionBtnTag(html, "repeat");
  const dismissBtn = extractActionBtnTag(html, "dismiss");

  assert.equal(isButtonTagDisabled(repeatBtn), false, `${stepLabel}: Repeat must stay enabled`);
  assert.equal(isButtonTagDisabled(dismissBtn), false, `${stepLabel}: Dismiss must stay enabled`);

  const buttonTags = [logBtn, repeatBtn, dismissBtn];
  for (let idx = 0; idx < HUD_ACTION_NAMES.length; idx += 1) {
    const tag = buttonTags[idx];
    if (idx === state.focusIndex) {
      assert.ok(tag.includes('data-focused="true"'), `${stepLabel}: button ${idx} must be focused`);
      assert.ok(tag.includes('aria-current="true"'), `${stepLabel}: button ${idx} must have aria-current`);
    } else {
      assert.ok(tag.includes('data-focused="false"'), `${stepLabel}: button ${idx} must not be focused`);
      assert.equal(tag.includes("aria-current="), false, `${stepLabel}: button ${idx} must omit aria-current`);
    }
  }

  const activeVerdict = state.verdict && !state.dismissed ? state.verdict : null;
  const logBtnDisabled = isButtonTagDisabled(logBtn);

  if (
    !activeVerdict ||
    activeVerdict.level !== "match" ||
    activeVerdict.takenToday === true ||
    !activeVerdict.matchedMedId
  ) {
    assert.equal(
      logBtnDisabled,
      true,
      `${stepLabel}: Log Dose MUST be disabled when no active match or takenToday=true (level=${String(activeVerdict?.level)}, takenToday=${String(activeVerdict?.takenToday)})`
    );
    assert.ok(logBtn.includes('aria-disabled="true"'), `${stepLabel}: Log Dose must report aria-disabled="true"`);
  } else {
    assert.equal(
      logBtnDisabled,
      false,
      `${stepLabel}: Log Dose must be enabled on active match with matchedMedId and !takenToday`
    );
    assert.ok(logBtn.includes('aria-disabled="false"'), `${stepLabel}: Log Dose must report aria-disabled="false"`);
  }

  if (activeVerdict) {
    const expectedChannel = EXPECTED_CHANNELS[activeVerdict.level];
    assert.ok(
      html.includes(`data-verdict-level="${activeVerdict.level}"`),
      `${stepLabel}: missing verdict level ${activeVerdict.level}`
    );
    assert.ok(
      html.includes(`data-verdict-shape="${expectedChannel.shape}"`),
      `${stepLabel}: missing shape ${expectedChannel.shape}`
    );
    assert.ok(
      html.includes(`>${expectedChannel.badge}</span>`),
      `${stepLabel}: missing badge ${expectedChannel.badge}`
    );
    assert.ok(
      html.includes(`border-color:${expectedChannel.color}`),
      `${stepLabel}: missing border color ${expectedChannel.color}`
    );

    const headlineMatch = new RegExp('<h1 class="hud-headline">([^<]*)<\\x2fh1>').exec(html);
    assert.ok(headlineMatch, `${stepLabel}: active verdict must render .hud-headline`);
    const renderedHeadline = decodeHtmlEntities(headlineMatch[1]);
    const headlineWords = countWords(renderedHeadline);
    assert.ok(
      headlineWords <= MAX_HEADLINE_WORDS,
      `${stepLabel}: rendered headline "${renderedHeadline}" has ${headlineWords} words (> 8)`
    );
    assert.doesNotMatch(
      renderedHeadline,
      /[,.;:]+$/,
      `${stepLabel}: rendered headline must strip trailing punctuation`
    );
    assert.equal(renderedHeadline, clampHudHeadline(activeVerdict.headline));
  } else if (state.coach) {
    assert.ok(
      html.includes(`data-coach-cue="${state.coach.cue}"`),
      `${stepLabel}: expected coach cue ${state.coach.cue}`
    );
    assert.equal(
      html.includes("data-verdict-level="),
      false,
      `${stepLabel}: coach state must not render verdict card`
    );
  } else {
    assert.ok(
      html.includes('data-hud-standby="true"'),
      `${stepLabel}: idle or dismissed state must render #000000 standby`
    );
  }
}

type FuzzStats = {
  steps: number;
  coachBursts: number;
  checkingToggles: number;
  extremeVerdicts: number;
  takenTodayFlips: number;
  nonMatchVerdicts: number;
  deviceUpdates: number;
  dismissReopenCycles: number;
  malformedPayloads: number;
};

function runSeededFuzzSequence(seed: number, totalSteps: number): FuzzStats {
  const rng = createMulberry32(seed);
  let state: HudState = initialHudState({ speechEnabled: rng.chance(0.5) });
  let sessionParam: string | null | undefined = undefined;

  const stats: FuzzStats = {
    steps: 0,
    coachBursts: 0,
    checkingToggles: 0,
    extremeVerdicts: 0,
    takenTodayFlips: 0,
    nonMatchVerdicts: 0,
    deviceUpdates: 0,
    dismissReopenCycles: 0,
    malformedPayloads: 0
  };

  for (let step = 0; step < totalSteps; step += 1) {
    const bucket = step < 16 ? step % 8 : rng.nextInt(0, 7);

    if (bucket === 0) {
      const burstCount = rng.nextInt(1, 4);
      for (let b = 0; b < burstCount; b += 1) {
        const cue = rng.pick(ALL_COACH_CUES);
        const text = makeSyntheticText(rng, rng.pick([0, 2, 5, 14, 30]));
        state = reduceHudServerMsg(state, { type: "coach", cue, text });
      }
      stats.coachBursts += 1;
    } else if (bucket === 1) {
      const beforeChecking = state;
      const afterStart = reduceHudServerMsg(state, { type: "checking", phase: "start" });
      assert.equal(afterStart, beforeChecking, "checking:start must keep HUD reducer state referentially stable");
      state = reduceHudServerMsg(afterStart, {
        type: "coach",
        cue: "hold_still",
        text: `Hold still ${EM_DASH} reading label`
      });
      const nonHudNoise: ServerMsg = rng.pick([
        { type: "checking", phase: "end" },
        { type: "audio", data: "AAAA" },
        { type: "transcript", role: "assistant", text: "Hold steady", final: false },
        { type: "ready", model: "gemini-3.8-live", session: "hup-fuzz" },
        { type: "pong", t: step * 100 },
        { type: "interrupted" },
        { type: "hud", connected: true },
        { type: "error", code: "rate_limit", message: "Retry", recoverable: true }
      ]);
      const beforeNoise = state;
      state = reduceHudServerMsg(state, nonHudNoise);
      assert.equal(state, beforeNoise);
      stats.checkingToggles += 1;
    } else if (bucket === 2) {
      const level = rng.pick(ALL_VERDICT_LEVELS);
      const extremeWords = rng.pick([0, 1, 8, 9, 15, 42, 96, 130]);
      const verdict = makeSyntheticVerdict(rng, { level, extremeWords });
      state = reduceHudServerMsg(state, { type: "verdict", verdict });
      stats.extremeVerdicts += 1;
      if (level !== "match") {
        stats.nonMatchVerdicts += 1;
      }
    } else if (bucket === 3) {
      const freshMatch = makeSyntheticVerdict(rng, {
        level: "match",
        takenToday: false,
        extremeWords: rng.pick([4, 8, 22])
      });
      freshMatch.matchedMedId = "aml";
      state = reduceHudServerMsg(state, { type: "verdict", verdict: freshMatch });
      assertHudSsrInvariants(
        renderToStaticMarkup(createElement(HudApp, { sessionParam, initialState: state })),
        state,
        `seed=${seed}:step=${step}:pre-takenToday`
      );

      const loggedMatch: Verdict = {
        ...freshMatch,
        takenToday: true,
        headline: makeSyntheticText(rng, rng.pick([6, 11, 25]))
      };
      state = reduceHudServerMsg(state, { type: "verdict", verdict: loggedMatch });
      assertHudSsrInvariants(
        renderToStaticMarkup(createElement(HudApp, { sessionParam, initialState: state })),
        state,
        `seed=${seed}:step=${step}:post-takenToday`
      );

      if (rng.chance(0.5)) {
        const doubleDoseWarn: Verdict = {
          ...loggedMatch,
          level: "warning",
          takenToday: true
        };
        state = reduceHudServerMsg(state, { type: "verdict", verdict: doubleDoseWarn });
        stats.nonMatchVerdicts += 1;
      }
      stats.takenTodayFlips += 1;
    } else if (bucket === 4) {
      state = reduceHudServerMsg(state, {
        type: "device",
        device: makeSyntheticDevice(rng)
      });
      state = reduceHudServerMsg(state, {
        type: "status",
        live: rng.pick(ALL_LIVE_STATES),
        detail: rng.chance(0.5) ? "probe" : undefined
      });
      state = {
        ...state,
        connected: rng.chance(0.75),
        speechEnabled: rng.chance(0.5)
      };
      sessionParam = rng.pick([
        undefined,
        null,
        "hup-7f3a",
        "bench_session_2026",
        "bad/session",
        "ab",
        ""
      ]);
      stats.deviceUpdates += 1;
    } else if (bucket === 5) {
      if (!state.verdict) {
        state = reduceHudServerMsg(state, {
          type: "verdict",
          verdict: makeSyntheticVerdict(rng, { level: "match", takenToday: false })
        });
      }
      state = { ...state, dismissed: true, coach: null };
      assertHudSsrInvariants(
        renderToStaticMarkup(createElement(HudApp, { sessionParam, initialState: state })),
        state,
        `seed=${seed}:step=${step}:dismissed`
      );

      if (rng.chance(0.5)) {
        const reopenVerdict = makeSyntheticVerdict(rng);
        state = reduceHudServerMsg(state, { type: "verdict", verdict: reopenVerdict });
        assert.equal(state.dismissed, false, "New verdict must clear dismissed state");
        assert.equal(state.coach, null, "New verdict must clear coach state");
        if (reopenVerdict.level !== "match") {
          stats.nonMatchVerdicts += 1;
        }
      }
      stats.dismissReopenCycles += 1;
    } else if (bucket === 6) {
      const nonMatchLevel = rng.pick(["warning", "unsure", "info"] as const);
      const verdict = makeSyntheticVerdict(rng, {
        level: nonMatchLevel,
        takenToday: rng.pick([false, true])
      });
      state = reduceHudServerMsg(state, { type: "verdict", verdict });
      stats.nonMatchVerdicts += 1;
    } else {
      const malformedVariant = rng.nextInt(0, 5);
      if (malformedVariant === 0) {
        const unknownMsg = {
          type: rng.pick(["unknown_packet", "", "telemetry_blob", "frame_ack"]),
          payload: { nested: [1, 2, null] }
        } as unknown as ServerMsg;
        const prev = state;
        state = reduceHudServerMsg(state, unknownMsg);
        assert.equal(state, prev);
      } else if (malformedVariant === 1) {
        const weirdCoach = {
          type: "coach",
          cue: rng.pick(ALL_COACH_CUES),
          text: rng.pick([undefined, null, 404, { bad: true }])
        } as unknown as ServerMsg;
        state = reduceHudServerMsg(state, weirdCoach);
        assert.equal(state.coach?.text, "");
      } else if (malformedVariant === 2) {
        const nullDeviceMsg = {
          type: "device",
          device: null
        } as unknown as ServerMsg;
        state = reduceHudServerMsg(state, nullDeviceMsg);
        assert.equal(state.device, null);
      } else if (malformedVariant === 3) {
        const weirdStatusMsg = {
          type: "status",
          live: "mystery_transport_state"
        } as unknown as ServerMsg;
        state = reduceHudServerMsg(state, weirdStatusMsg);
      } else if (malformedVariant === 4) {
        const nullVerdictMsg = {
          type: "verdict",
          verdict: null
        } as unknown as ServerMsg;
        state = reduceHudServerMsg(state, nullVerdictMsg);
        assert.equal(state.verdict, null);
      } else {
        const baseVerdict = makeSyntheticVerdict(rng, { level: rng.pick(ALL_VERDICT_LEVELS) });
        const missingStringsVerdict = {
          ...baseVerdict,
          headline: undefined as unknown as string,
          speech: null as unknown as string
        };
        state = reduceHudServerMsg(state, {
          type: "verdict",
          verdict: missingStringsVerdict
        });
        if (baseVerdict.level !== "match") {
          stats.nonMatchVerdicts += 1;
        }
      }
      stats.malformedPayloads += 1;
    }

    const navKey = rng.pick([
      "ArrowRight",
      "ArrowDown",
      "ArrowLeft",
      "ArrowUp",
      "Enter",
      " ",
      "Escape",
      "Backspace",
      "Tab"
    ]);
    const rawFocusCandidate = rng.chance(0.25)
      ? rng.pick([-99, -1, 0, 1, 2, 3, 47, Number.NaN, Number.POSITIVE_INFINITY])
      : state.focusIndex;
    const boundedFocus = nextFocusIndex(rawFocusCandidate, HUD_ACTION_NAMES.length, navKey);
    assert.ok(
      Number.isInteger(boundedFocus) &&
        boundedFocus >= 0 &&
        boundedFocus <= HUD_ACTION_NAMES.length - 1,
      `nextFocusIndex returned out-of-range index ${boundedFocus}`
    );
    state = { ...state, focusIndex: boundedFocus };

    const props: HudAppProps = {
      sessionParam,
      speak: state.speechEnabled,
      initialState: state
    };
    const html = renderToStaticMarkup(createElement(HudApp, props));
    assertHudSsrInvariants(html, state, `seed=${seed}:step=${step}:bucket=${bucket}`);
    stats.steps += 1;
  }

  return stats;
}

type ListenerEntry = {
  fn: (ev: unknown) => void;
  capture: boolean;
};

class MiniDomNode {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly tagName: string;
  namespaceURI: string = XHTML_NS;
  ownerDocument: MiniDomDocument;
  parentNode: MiniDomNode | null = null;
  childNodes: MiniDomNode[] = [];
  style: Record<string, string> = {};
  attributes = new Map<string, string>();
  listeners = new Map<string, ListenerEntry[]>();
  disabled = false;
  textContentValue = "";

  constructor(nodeType: number, name: string, ownerDoc: MiniDomDocument) {
    this.nodeType = nodeType;
    this.nodeName = name.toUpperCase();
    this.tagName = name.toUpperCase();
    this.ownerDocument = ownerDoc;
  }

  get firstChild(): MiniDomNode | null {
    return this.childNodes[0] ?? null;
  }

  get nextSibling(): MiniDomNode | null {
    if (!this.parentNode) return null;
    const idx = this.parentNode.childNodes.indexOf(this);
    return idx >= 0 ? (this.parentNode.childNodes[idx + 1] ?? null) : null;
  }

  get nodeValue(): string {
    return this.textContentValue;
  }

  set nodeValue(val: string) {
    this.textContentValue = String(val);
  }

  get textContent(): string {
    if (this.nodeType === 3) return this.textContentValue;
    return this.childNodes.map((c) => c.textContent).join("");
  }

  set textContent(val: string) {
    if (this.nodeType === 3) {
      this.textContentValue = String(val);
      return;
    }
    const str = String(val);
    if (!str) {
      for (const c of this.childNodes) c.parentNode = null;
      this.childNodes = [];
      return;
    }
    const textNode = new MiniDomNode(3, "#text", this.ownerDocument);
    textNode.textContentValue = str;
    textNode.parentNode = this;
    this.childNodes = [textNode];
  }

  appendChild(child: MiniDomNode): MiniDomNode {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  insertBefore(child: MiniDomNode, ref: MiniDomNode | null): MiniDomNode {
    if (!ref) return this.appendChild(child);
    if (child.parentNode) child.parentNode.removeChild(child);
    const idx = this.childNodes.indexOf(ref);
    child.parentNode = this;
    if (idx === -1) this.childNodes.push(child);
    else this.childNodes.splice(idx, 0, child);
    return child;
  }

  removeChild(child: MiniDomNode): MiniDomNode {
    const idx = this.childNodes.indexOf(child);
    if (idx >= 0) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
    if (name === "disabled") this.disabled = true;
  }

  setAttributeNS(_ns: string | null, name: string, value: string): void {
    this.setAttribute(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
    if (name === "disabled") this.disabled = false;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(
    type: string,
    fn: (ev: unknown) => void,
    opts?: boolean | { capture?: boolean }
  ): void {
    const capture = typeof opts === "boolean" ? opts : Boolean(opts?.capture);
    const list = this.listeners.get(type) ?? [];
    list.push({ fn, capture });
    this.listeners.set(type, list);
  }

  removeEventListener(
    type: string,
    fn: (ev: unknown) => void,
    opts?: boolean | { capture?: boolean }
  ): void {
    const capture = typeof opts === "boolean" ? opts : Boolean(opts?.capture);
    const list = this.listeners.get(type);
    if (!list) return;
    const idx = list.findIndex((entry) => entry.fn === fn && entry.capture === capture);
    if (idx >= 0) list.splice(idx, 1);
  }

  focus(): void {
    if (!this.disabled) {
      this.ownerDocument.activeElement = this;
    }
  }

  blur(): void {
    if (this.ownerDocument.activeElement === this) {
      this.ownerDocument.activeElement = this.ownerDocument.body;
    }
  }

  findByAttr(attr: string, expected: string): MiniDomNode | null {
    if (this.attributes.get(attr) === expected) return this;
    for (const child of this.childNodes) {
      const found = child.findByAttr(attr, expected);
      if (found) return found;
    }
    return null;
  }
}

class MiniDomDocument {
  readonly nodeType = 9;
  defaultView: unknown = null;
  documentElement: MiniDomNode;
  body: MiniDomNode;
  activeElement: MiniDomNode;
  listeners = new Map<string, Set<(ev: unknown) => void>>();

  constructor() {
    this.documentElement = new MiniDomNode(1, "html", this);
    this.body = new MiniDomNode(1, "body", this);
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
  }

  createElement(tag: string): MiniDomNode {
    return new MiniDomNode(1, tag, this);
  }

  createElementNS(ns: string, tag: string): MiniDomNode {
    const node = new MiniDomNode(1, tag, this);
    node.namespaceURI = ns;
    return node;
  }

  createTextNode(text: string): MiniDomNode {
    const node = new MiniDomNode(3, "#text", this);
    node.textContentValue = String(text);
    return node;
  }

  addEventListener(type: string, fn: (ev: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set<(ev: unknown) => void>();
    set.add(fn);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, fn: (ev: unknown) => void): void {
    this.listeners.get(type)?.delete(fn);
  }
}

class FakeHudSocket implements HudWsLike {
  readyState = 0;
  readonly sent: Array<{ type: string; name: string }> = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as { type: string; name: string });
  }

  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  receiveRaw(payload: unknown): void {
    this.onmessage?.({ data: payload });
  }
}

class MockHistory {
  private stack: Array<{ state: unknown; url: string }> = [{ state: null, url: "/hud" }];
  private idx = 0;
  maxLength = 1;
  private readonly onPop: (state: unknown) => void;

  constructor(onPop: (state: unknown) => void) {
    this.onPop = onPop;
  }

  get length(): number {
    return this.stack.length;
  }

  get state(): unknown {
    return this.stack[this.idx]?.state ?? null;
  }

  pushState(state: unknown, _unused: string, url?: string): void {
    this.stack = this.stack.slice(0, this.idx + 1);
    this.stack.push({ state, url: url ?? "/hud" });
    this.idx = this.stack.length - 1;
    if (this.stack.length > this.maxLength) {
      this.maxLength = this.stack.length;
    }
  }

  replaceState(state: unknown, _unused: string, url?: string): void {
    this.stack[this.idx] = { state, url: url ?? "/hud" };
    if (this.stack.length > this.maxLength) {
      this.maxLength = this.stack.length;
    }
  }

  back(): void {
    if (this.idx > 0) {
      this.idx -= 1;
      this.stack = this.stack.slice(0, this.idx + 1);
      this.onPop(this.state);
    }
  }
}

test("Deterministic 250-step PRNG fuzz sequence preserves pure #000000 waveguide scoping, <= 8 word headlines, Log Dose gating, focus bounds, and zero storage touches", async () => {
  const hudCssSource = readFileSync(new URL("../src/hud/hud.css", import.meta.url), "utf8");
  for (const requiredRule of [
    ":root:has(.hud-root)",
    "body:has(.hud-root)",
    "#root:has(.hud-root)",
    ".hud-root",
    "background-color: #000000",
    "overflow: hidden"
  ]) {
    assert.ok(
      hudCssSource.includes(requiredRule),
      `hud.css must preserve waveguide scoping rule "${requiredRule}"`
    );
  }

  await withZeroStorageGuard(() => {
    const stats = runSeededFuzzSequence(0x20261115, 250);
    assert.equal(stats.steps, 250);
    assert.ok(stats.coachBursts >= 20, `Expected >= 20 coach bursts, got ${stats.coachBursts}`);
    assert.ok(stats.checkingToggles >= 20, `Expected >= 20 checking toggles, got ${stats.checkingToggles}`);
    assert.ok(stats.extremeVerdicts >= 20, `Expected >= 20 extreme verdicts, got ${stats.extremeVerdicts}`);
    assert.ok(stats.takenTodayFlips >= 20, `Expected >= 20 takenToday transitions, got ${stats.takenTodayFlips}`);
    assert.ok(stats.nonMatchVerdicts >= 40, `Expected >= 40 non-match verdicts, got ${stats.nonMatchVerdicts}`);
    assert.ok(stats.deviceUpdates >= 20, `Expected >= 20 device updates, got ${stats.deviceUpdates}`);
    assert.ok(stats.dismissReopenCycles >= 20, `Expected >= 20 dismiss/reopen cycles, got ${stats.dismissReopenCycles}`);
    assert.ok(stats.malformedPayloads >= 20, `Expected >= 20 malformed payloads, got ${stats.malformedPayloads}`);
  });
});

test("Multi-seed PRNG property sweep (4 seeds x 60 steps = 240 steps) and 400-case nextFocusIndex + clampHudHeadline fuzzing hold all invariants", async () => {
  await withZeroStorageGuard(() => {
    const seeds = [0xa11ce001, 0xbeef2026, 0x5afe0800, 0xc0ffee42] as const;
    for (const seed of seeds) {
      const stats = runSeededFuzzSequence(seed, 60);
      assert.equal(stats.steps, 60);
    }

    const rng = createMulberry32(0x778899aa);
    const keys = [
      "ArrowRight",
      "ArrowDown",
      "ArrowLeft",
      "ArrowUp",
      "Enter",
      " ",
      "Escape",
      "Backspace",
      "Home",
      "End",
      "",
      "Unidentified"
    ];

    for (let i = 0; i < 400; i += 1) {
      const actionCount = rng.pick([1, 2, 3, 4, 5, 6]);
      const current = rng.chance(0.3)
        ? rng.pick([
            -10000,
            -7,
            -1,
            -0.8,
            1.7,
            9999,
            Number.NaN,
            Number.POSITIVE_INFINITY,
            Number.NEGATIVE_INFINITY
          ])
        : rng.nextInt(-25, 25);
      const key = rng.pick(keys);
      const idx = nextFocusIndex(current, actionCount, key);
      assert.equal(Number.isInteger(idx), true);
      assert.ok(
        idx >= 0 && idx <= actionCount - 1,
        `nextFocusIndex(${String(current)}, ${actionCount}, "${key}") -> ${idx} outside [0, ${actionCount - 1}]`
      );

      for (const nonPositiveCount of [0, -1, -50, Number.NaN]) {
        assert.equal(nextFocusIndex(current, nonPositiveCount, key), 0);
      }

      const rawHeadline = makeSyntheticText(rng, rng.nextInt(0, 90));
      const clamped = clampHudHeadline(rawHeadline);
      assert.ok(countWords(clamped) <= MAX_HEADLINE_WORDS);
      assert.equal(clamped.includes(EM_DASH), false);
      assert.equal(clamped.includes(EN_DASH), false);
      assert.doesNotMatch(clamped, /[,.;:]+$/);

      const cleaned = sanitizeHudText(rawHeadline);
      assert.equal(cleaned.includes(EM_DASH), false);
      assert.equal(cleaned.includes(EN_DASH), false);
    }
  });
});

test("Mounted HudApp WebSocket fuzzing (100 randomized wire frames, Neural Band keys, and Swipe-Back popstate) preserves <= 2 history cap, #000000 root, Log Dose safety, and zero storage", async () => {
  await withZeroStorageGuard(async (touches) => {
    const g = globalThis as Record<string, unknown>;
    const prevWindow = g.window;
    const prevDocument = g.document;
    const prevActEnv = g.IS_REACT_ACT_ENVIRONMENT;
    const realDateNow = Date.now;

    let nowMs = 1_763_160_000_000;
    Date.now = () => nowMs;

    const winListeners = new Map<string, Set<(ev: unknown) => void>>();
    const dispatchWin = (type: string, ev: unknown) => {
      for (const fn of [...(winListeners.get(type) ?? [])]) {
        fn(ev);
      }
    };

    const history = new MockHistory((popped) => {
      dispatchWin("popstate", { type: "popstate", state: popped });
    });

    const doc = new MiniDomDocument();
    const container = doc.createElement("div");
    doc.body.appendChild(container);

    const localWinTrap = createStorageTrap("window.localStorage", touches);
    const sessionWinTrap = createStorageTrap("window.sessionStorage", touches);

    class FakeIframe {}
    const winObj: Record<string, unknown> = {
      HTMLIFrameElement: FakeIframe,
      HTMLElement: MiniDomNode,
      Element: MiniDomNode,
      Node: MiniDomNode,
      document: doc,
      location: {
        protocol: "https:",
        host: "glasses.holdup.fi",
        pathname: "/hud",
        search: ""
      },
      history,
      addEventListener(type: string, fn: (ev: unknown) => void) {
        const set = winListeners.get(type) ?? new Set<(ev: unknown) => void>();
        set.add(fn);
        winListeners.set(type, set);
      },
      removeEventListener(type: string, fn: (ev: unknown) => void) {
        winListeners.get(type)?.delete(fn);
      }
    };

    Object.defineProperty(winObj, "localStorage", {
      configurable: true,
      get() {
        touches.push("window.localStorage:getter");
        return localWinTrap;
      }
    });
    Object.defineProperty(winObj, "sessionStorage", {
      configurable: true,
      get() {
        touches.push("window.sessionStorage:getter");
        return sessionWinTrap;
      }
    });

    doc.defaultView = winObj;
    g.IS_REACT_ACT_ENVIRONMENT = true;
    g.window = winObj;
    g.document = doc;

    let socket: FakeHudSocket | null = null;
    const root = createRoot(container as unknown as Element);

    try {
      await act(async () => {
        root.render(
          createElement(HudApp, {
            createWs: () => {
              socket = new FakeHudSocket();
              return socket;
            }
          })
        );
      });

      assert.ok(socket, "Expected mounted HudApp to open WebSocket");
      const ws = socket as FakeHudSocket;
      await act(async () => {
        ws.open();
      });

      const rng = createMulberry32(0x5150f00d);
      const encoder = new TextEncoder();
      const tracker: { verdict: Verdict | null; dismissed: boolean } = {
        verdict: null,
        dismissed: false
      };

      for (let i = 0; i < 100; i += 1) {
        nowMs += 200;
        const op = rng.nextInt(0, 5);

        await act(async () => {
          if (op === 0) {
            const malformedRaw: unknown = rng.pick([
              "",
              "{",
              '{"type":',
              "not-json",
              "null",
              "42",
              '"plain"',
              "[1,2,3]",
              '{"missingType":true}',
              encoder.encode('{"broken":').buffer,
              encoder.encode("null"),
              null,
              undefined,
              999,
              { noTypeField: "ignored" },
              JSON.stringify({ type: "unknown_wire_type", extra: 1 })
            ]);
            ws.receiveRaw(malformedRaw);
          } else if (op === 1) {
            const msg: ServerMsg = {
              type: "coach",
              cue: rng.pick(ALL_COACH_CUES),
              text: makeSyntheticText(rng, rng.nextInt(0, 20))
            };
            ws.receiveRaw(rng.chance(0.5) ? JSON.stringify(msg) : encoder.encode(JSON.stringify(msg)));
          } else if (op === 2) {
            const verdict = makeSyntheticVerdict(rng);
            tracker.verdict = verdict;
            tracker.dismissed = false;
            const serialized = JSON.stringify({ type: "verdict", verdict });
            ws.receiveRaw(
              rng.chance(0.35)
                ? encoder.encode(serialized).buffer
                : serialized
            );
          } else if (op === 3) {
            ws.receiveRaw(
              JSON.stringify({
                type: "device",
                device: makeSyntheticDevice(rng)
              })
            );
            ws.receiveRaw(
              JSON.stringify({
                type: "status",
                live: rng.pick(ALL_LIVE_STATES)
              })
            );
          } else if (op === 4) {
            const key = rng.pick(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter"]);
            const sentBefore = ws.sent.length;
            dispatchWin("keydown", {
              type: "keydown",
              key,
              preventDefault() {}
            });
            if (ws.sent.length > sentBefore) {
              const latestSent = ws.sent[ws.sent.length - 1];
              if (latestSent.name === "log_dose") {
                assert.equal(tracker.dismissed, false, "log_dose must never fire while dismissed");
                assert.ok(tracker.verdict, "log_dose requires active verdict");
                assert.equal(tracker.verdict.level, "match", "log_dose must never fire when level !== match");
                assert.notEqual(tracker.verdict.takenToday, true, "log_dose must never fire when takenToday === true");
                assert.ok(Boolean(tracker.verdict.matchedMedId), "log_dose requires matchedMedId");
              }
              if (latestSent.name === "dismiss") {
                tracker.dismissed = true;
              }
            }
          } else {
            history.back();
            tracker.dismissed = true;
          }
        });

        assert.equal(doc.documentElement.style.backgroundColor, "#000000");
        assert.equal(doc.body.style.backgroundColor, "#000000");
        assert.ok(history.length <= 2, `History length ${history.length} exceeded <= 2 cap`);
        assert.ok(history.maxLength <= 2, `Max history length ${history.maxLength} exceeded <= 2 cap`);

        const logBtn = container.findByAttr("data-hud-action", "log_dose");
        assert.ok(logBtn);
        const activeVerdict = tracker.verdict;
        if (
          tracker.dismissed ||
          !activeVerdict ||
          activeVerdict.level !== "match" ||
          activeVerdict.takenToday === true ||
          !activeVerdict.matchedMedId
        ) {
          assert.equal(logBtn.disabled, true);
        } else {
          assert.equal(logBtn.disabled, false);
        }
      }
    } finally {
      await act(async () => {
        root.unmount();
      });
      Date.now = realDateNow;
      if (prevWindow !== undefined) g.window = prevWindow;
      else delete g.window;
      if (prevDocument !== undefined) g.document = prevDocument;
      else delete g.document;
      if (prevActEnv !== undefined) g.IS_REACT_ACT_ENVIRONMENT = prevActEnv;
      else delete g.IS_REACT_ACT_ENVIRONMENT;
    }
  });
});

test("Zero comments and zero em or en dashes exist in hudStateFuzz.test.ts, HudApp.tsx, and hud.css", () => {
  const selfSource = readFileSync(new URL("./hudStateFuzz.test.ts", import.meta.url), "utf8");
  const hudTsxSource = readFileSync(new URL("../src/hud/HudApp.tsx", import.meta.url), "utf8");
  const hudCssSource = readFileSync(new URL("../src/hud/hud.css", import.meta.url), "utf8");

  assert.equal(hudTsxSource.includes("localStorage"), false);
  assert.equal(hudTsxSource.includes("sessionStorage"), false);
  assert.equal(hudTsxSource.includes("indexedDB"), false);

  for (const [name, src] of [
    ["hudStateFuzz.test.ts", selfSource],
    ["HudApp.tsx", hudTsxSource],
    ["hud.css", hudCssSource]
  ] as const) {
    assert.equal(src.includes(LINE_COMMENT), false, `${name} must contain zero line comments`);
    assert.equal(src.includes(BLOCK_COMMENT_OPEN), false, `${name} must contain zero block comments`);
    assert.equal(src.includes(BLOCK_COMMENT_CLOSE), false, `${name} must contain zero block comment closers`);
    assert.equal(src.includes(HTML_COMMENT_OPEN), false, `${name} must contain zero HTML comments`);
    assert.equal(src.includes(EM_DASH), false, `${name} must contain zero em dashes`);
    assert.equal(src.includes(EN_DASH), false, `${name} must contain zero en dashes`);
  }
});
