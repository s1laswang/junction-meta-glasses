import { describe, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Module, { createRequire, register } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Verdict } from "../../shared/types.ts";

const SLASH = String.fromCharCode(47);
const ASTERISK = String.fromCharCode(42);
const BACKSLASH = String.fromCharCode(92);
const LINE_CMT = SLASH + SLASH;
const BLOCK_CMT_OPEN = SLASH + ASTERISK;
const BLOCK_CMT_CLOSE = ASTERISK + SLASH;
const HTML_CMT_OPEN = String.fromCharCode(60, 33, 45, 45);
const EM_DASH = String.fromCharCode(8212);
const EN_DASH = String.fromCharCode(8211);
const ESC_EM_DASH = BACKSLASH + "u2014";
const ESC_EN_DASH = BACKSLASH + "u2013";

const reqFromHere = createRequire(import.meta.url);
const reactCjs = reqFromHere("react") as {
  useSyncExternalStore: <T>(
    subscribe: (onStoreChange: () => void) => () => void,
    getSnapshot: () => T,
    getServerSnapshot?: () => T,
  ) => T;
};
const origUseSyncExt = reactCjs.useSyncExternalStore;
reactCjs.useSyncExternalStore = <T,>(
  subscribe: (onStoreChange: () => void) => () => void,
  getSnapshot: () => T,
  getServerSnapshot?: () => T,
): T => origUseSyncExt(subscribe, getSnapshot, getServerSnapshot ?? getSnapshot);

const cjsModule = Module as unknown as {
  _extensions?: Record<string, (mod: { exports: unknown }, filename: string) => void>;
};
if (cjsModule._extensions && !cjsModule._extensions[".css"]) {
  cjsModule._extensions[".css"] = (mod) => {
    mod.exports = {};
  };
}

const cssLoaderSource = [
  "export async function resolve(specifier, context, nextResolve) {",
  '  if (specifier.endsWith(".css")) {',
  '    return { url: "data:text/javascript,export default {};", shortCircuit: true };',
  "  }",
  "  return nextResolve(specifier, context);",
  "}",
].join("\n");
register("data:text/javascript," + encodeURIComponent(cssLoaderSource));

const backingStore = new Map<string, string>();
const localStorageShim = {
  get length(): number {
    return backingStore.size;
  },
  key(index: number): string | null {
    return Array.from(backingStore.keys())[index] ?? null;
  },
  getItem(key: string): string | null {
    return backingStore.has(key) ? backingStore.get(key)! : null;
  },
  setItem(key: string, value: string): void {
    backingStore.set(key, String(value));
  },
  removeItem(key: string): void {
    backingStore.delete(key);
  },
  clear(): void {
    backingStore.clear();
  },
};

Object.defineProperty(globalThis, "localStorage", {
  value: localStorageShim,
  configurable: true,
  writable: true,
});

Object.defineProperty(globalThis, "React", {
  value: React,
  configurable: true,
  writable: true,
});

if (typeof (globalThis as { location?: unknown }).location === "undefined") {
  const initialUrl = ["http:", "", "localhost:5173", "blindfold"].join(SLASH);
  Object.defineProperty(globalThis, "location", {
    value: new URL(initialUrl),
    configurable: true,
    writable: true,
  });
}

const TEST_FILE = fileURLToPath(import.meta.url);
const TEST_DIR = path.dirname(TEST_FILE);
const WEB_DIR = path.resolve(TEST_DIR, "..");
const REPO_DIR = path.resolve(WEB_DIR, "..");
const PUBLIC_DIR = path.join(WEB_DIR, "public");
const MAIN_TSX_PATH = path.join(WEB_DIR, "src", "main.tsx");
const BLINDFOLD_TSX_PATH = path.join(WEB_DIR, "src", "screens", "Blindfold.tsx");
const BLINDFOLD_CSS_PATH = path.join(WEB_DIR, "src", "screens", "blindfold.css");
const STYLES_CSS_PATH = path.join(WEB_DIR, "src", "styles.css");
const COACH_TS_PATH = path.join(WEB_DIR, "src", "lib", "blindfoldCoach.ts");
const SPOT_TS_PATH = path.join(WEB_DIR, "src", "lib", "spotTheDanger.ts");
const PIXEL_SCENE_TS_PATH = path.join(WEB_DIR, "src", "lib", "pixelScene.ts");
const MEDIA_TS_PATH = path.join(WEB_DIR, "src", "lib", "media.ts");
const PHRASE_MANIFEST_PATH = path.join(PUBLIC_DIR, "phrases", "manifest.json");

const {
  ASSETS_CREDIT_TEXT,
  BlindfoldView,
  HONESTY_BANNER_TEXT,
  initialBlindfoldViewProps,
} = await import("../src/screens/Blindfold.tsx");
const {
  ALL_PHRASE_IDS,
  SIM_BOXES,
  runOfflineCodeVerdict,
  runSimulatedBox,
  selectCoachCue,
} = await import("../src/lib/blindfoldCoach.ts");
const {
  SPOT_CARDS,
  evaluateSpotCard,
  spotDemoProfile,
} = await import("../src/lib/spotTheDanger.ts");
import type { JudgeChoice } from "../src/lib/spotTheDanger.ts";
const { BLINDFOLD_SPRITE_URLS } = await import("../src/lib/pixelScene.ts");
const { demoProfile, logDose } = await import("../src/lib/storage.ts");

const LANGS = ["en", "fi", "sv"] as const;
const MORNING_EET = new Date("2026-11-15T08:30:00+02:00");
const EVENING_EET = new Date("2026-11-15T20:00:00+02:00");
const EVENING_UTC = new Date("2026-11-15T19:00:00Z");

type PhraseManifest = {
  model: string;
  generated: string;
  phrases: Record<string, Record<string, { file: string; text: string }>>;
};

function assertCleanAsciiSource(label: string, src: string): void {
  assert.ok(src.length > 100, `${label} must be non-empty`);
  assert.equal(src.includes(LINE_CMT), false, `${label} must contain zero line comments`);
  assert.equal(src.includes(BLOCK_CMT_OPEN), false, `${label} must contain zero block comment openers`);
  assert.equal(src.includes(BLOCK_CMT_CLOSE), false, `${label} must contain zero block comment closers`);
  assert.equal(src.includes(HTML_CMT_OPEN), false, `${label} must contain zero HTML comments`);
  assert.equal(src.includes(EM_DASH), false, `${label} must contain zero em dashes`);
  assert.equal(src.includes(EN_DASH), false, `${label} must contain zero en dashes`);
  assert.equal(src.includes(ESC_EM_DASH), false, `${label} must contain zero escaped em dashes`);
  assert.equal(src.includes(ESC_EN_DASH), false, `${label} must contain zero escaped en dashes`);
  for (let i = 0; i < src.length; i++) {
    const code = src.charCodeAt(i);
    assert.ok(
      code <= 127 && (code === 9 || code === 10 || code === 13 || code >= 32),
      `${label} must be pure ASCII <= 127; found charCode ${code} at index ${i}`,
    );
  }
}

function extractCssRuleBodies(cssSource: string, classSelector: string): string[] {
  const escaped = classSelector.replace(/[.*+?^${}()|[\]\\]/g, BACKSLASH + "$&");
  const re = new RegExp(escaped + "(?![a-zA-Z0-9_-])[^{]*\\{([^}]*)\\}", "g");
  const bodies: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(cssSource)) !== null) {
    bodies.push(match[1]);
  }
  return bodies;
}

function extractPxProp(cssSource: string, classSelector: string, propName: string): number {
  const bodies = extractCssRuleBodies(cssSource, classSelector);
  const propRe = new RegExp("(?:^|[;\\s])" + propName + "\\s*:\\s*(\\d+(?:\\.\\d+)?)px");
  for (const body of bodies) {
    const m = propRe.exec(body);
    if (m) return Number(m[1]);
  }
  return 0;
}

function extractHtmlClasses(html: string): Set<string> {
  const out = new Set<string>();
  const re = /class="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    for (const token of m[1].trim().split(/\s+/)) {
      if (token) out.add(token);
    }
  }
  return out;
}

function renderView(overrides: Parameters<typeof initialBlindfoldViewProps>[0] = {}): string {
  return renderToStaticMarkup(createElement(BlindfoldView, initialBlindfoldViewProps(overrides)));
}

describe("Blindfold Challenge route, SSR view states, localized a11y hooks, CSS parity, and offline safety contract", () => {
  test("enforces strict pure-ASCII zero-comment zero-dash hygiene and zero network/API usage across Blindfold modules", () => {
    const selfSrc = fs.readFileSync(TEST_FILE, "utf8");
    assertCleanAsciiSource("web/test/blindfoldChallengeContract.test.ts", selfSrc);

    const asciiCleanFiles: ReadonlyArray<[string, string]> = [
      ["web/src/screens/Blindfold.tsx", BLINDFOLD_TSX_PATH],
      ["web/src/screens/blindfold.css", BLINDFOLD_CSS_PATH],
      ["web/src/lib/blindfoldCoach.ts", COACH_TS_PATH],
      ["web/src/lib/spotTheDanger.ts", SPOT_TS_PATH],
    ];

    for (const [label, absPath] of asciiCleanFiles) {
      assert.equal(fs.existsSync(absPath), true, `Expected ${label} at ${absPath}`);
      assertCleanAsciiSource(label, fs.readFileSync(absPath, "utf8"));
    }

    assert.equal(fs.existsSync(PIXEL_SCENE_TS_PATH), true, "Expected pixelScene.ts to exist");
    const offlineRuntimeFiles: ReadonlyArray<[string, string]> = [
      ["Blindfold.tsx", BLINDFOLD_TSX_PATH],
      ["blindfoldCoach.ts", COACH_TS_PATH],
      ["spotTheDanger.ts", SPOT_TS_PATH],
      ["pixelScene.ts", PIXEL_SCENE_TS_PATH],
    ];

    const forbiddenRuntimeTokens = [
      "WebSocket",
      "BroadcastChannel",
      "sendBeacon",
      "GEMINI_API_KEY",
      "ELEVENLABS_API_KEY",
      "child_process",
    ];

    for (const [label, absPath] of offlineRuntimeFiles) {
      const content = fs.readFileSync(absPath, "utf8");
      assert.doesNotMatch(content, /\bfetch\s*\(/, `${label} must never call fetch() directly`);
      for (const tok of forbiddenRuntimeTokens) {
        assert.equal(content.includes(tok), false, `${label} must not reference ${tok}`);
      }
    }
  });

  test("wires /blindfold route in web/src/main.tsx with trailing-slash normalization, lazy Suspense boundary, and blindfold-body class", () => {
    const mainSrc = fs.readFileSync(MAIN_TSX_PATH, "utf8");
    assert.ok(mainSrc.includes('path.endsWith("/blindfold")'), "main.tsx must match /blindfold after trimming trailing slashes");
    assert.match(
      mainSrc,
      new RegExp("lazy\\(\\s*\\(\\)\\s*=>\\s*import\\(\\s*[\"']\\." + SLASH + "screens" + SLASH + "Blindfold\\.tsx[\"']"),
      "main.tsx must lazy-load ./screens/Blindfold.tsx",
    );
    assert.ok(
      mainSrc.includes('document.body.classList.add("blindfold-body")'),
      "main.tsx must add blindfold-body to document.body",
    );
    assert.match(
      mainSrc,
      new RegExp("isBlindfold\\s*\\?\\s*\\(\\s*<Suspense[^>]*>[\\s\\S]*?<Blindfold\\s*" + SLASH + ">[\\s\\S]*?<" + SLASH + "Suspense>"),
      "main.tsx must wrap <Blindfold /> in <Suspense>",
    );
    assert.ok(mainSrc.includes("<Hud />"), "main.tsx must preserve /hud entry");
    assert.ok(mainSrc.includes("<Stage />"), "main.tsx must preserve /stage entry");
    assert.ok(mainSrc.includes("<App />"), "main.tsx must preserve default <App /> entry");
  });

  test("renders semantic landmarks, skip link, Announcer live regions, honesty disclosure banner, CC0 credit, and demo route links", () => {
    assert.equal(HONESTY_BANNER_TEXT, "OFFLINE DEMO - PHONE CAMERA ONLY (no physical glasses)");
    assert.ok(ASSETS_CREDIT_TEXT.includes("CC0 1.0"));
    assert.ok(ASSETS_CREDIT_TEXT.includes("docs/demo/ASSETS.md"));
    assert.equal(fs.existsSync(path.join(REPO_DIR, "docs", "demo", "ASSETS.md")), true, "docs/demo/ASSETS.md must exist");

    const html = renderView();
    assert.match(html, /<div class="bf-page" data-lang="en" data-round="blindfold">/);
    assert.match(html, /<a class="skip" href="#blindfold-main">Skip to challenge<\/a>/);
    assert.match(html, /role="status" aria-live="polite" aria-atomic="true"/);
    assert.match(html, /role="alert" aria-live="assertive" aria-atomic="true"/);
    assert.match(html, /<header class="bf-header">/);
    assert.match(
      html,
      /<div class="bf-honesty-banner" role="region" aria-label="Demo disclosure" data-testid="honesty-banner">/,
    );
    assert.ok(html.includes(HONESTY_BANNER_TEXT));
    assert.ok(html.includes(ASSETS_CREDIT_TEXT));
    assert.match(html, /<h1 class="bf-title">Meta Blindfold Challenge<\/h1>/);
    assert.match(html, /<main id="blindfold-main" class="bf-main" tabindex="-1">/);
    assert.match(html, /<footer class="bf-footer">/);
    assert.match(html, /<nav class="bf-footer-links" aria-label="Demo routes">/);
    assert.ok(html.includes('href="/?mock=1"'));
    assert.ok(html.includes('href="/stage?mock=1"'));
  });

  test("localizes EN, FI, and SV UI copy with exact aria-pressed toggle states on language, screen-reader quiet mode, and round tabs", () => {
    const htmlByLang: Record<(typeof LANGS)[number], string> = {
      en: renderView({ lang: "en", srMode: false, round: "blindfold" }),
      fi: renderView({ lang: "fi", srMode: true, round: "blindfold" }),
      sv: renderView({ lang: "sv", srMode: false, round: "spot" }),
    };

    assert.match(htmlByLang.en, /role="group" aria-label="Language"/);
    assert.match(htmlByLang.en, /data-lang-btn="en" aria-pressed="true"/);
    assert.match(htmlByLang.en, /data-lang-btn="fi" aria-pressed="false"/);
    assert.match(htmlByLang.en, /data-lang-btn="sv" aria-pressed="false"/);
    assert.match(htmlByLang.en, /data-testid="blindfold-sr-mode" aria-pressed="false">Screen reader quiet audio: OFF<\/button>/);
    assert.match(htmlByLang.en, /role="group" aria-label="Demo round"/);
    assert.match(htmlByLang.en, /data-testid="tab-round-1" aria-pressed="true"/);
    assert.match(htmlByLang.en, /data-testid="tab-round-2" aria-pressed="false"/);

    assert.match(htmlByLang.fi, /<div class="bf-page" data-lang="fi" data-round="blindfold">/);
    assert.match(htmlByLang.fi, /data-lang-btn="fi" aria-pressed="true"/);
    assert.match(htmlByLang.fi, /data-testid="blindfold-sr-mode" aria-pressed="true">Ruudunlukijan hiljainen tila: ON<\/button>/);
    assert.ok(htmlByLang.fi.includes("Siirry haasteeseen"));
    assert.ok(htmlByLang.fi.includes("Kierros 1: Sokkokamera"));
    assert.ok(htmlByLang.fi.includes("Aloita sokkotarkistus"));
    assert.ok(htmlByLang.fi.includes("Etiketin luettavuus"));

    assert.match(htmlByLang.sv, /<div class="bf-page" data-lang="sv" data-round="spot">/);
    assert.match(htmlByLang.sv, /data-lang-btn="sv" aria-pressed="true"/);
    assert.match(htmlByLang.sv, /data-testid="tab-round-1" aria-pressed="false"/);
    assert.match(htmlByLang.sv, /data-testid="tab-round-2" aria-pressed="true"/);
    assert.ok(htmlByLang.sv.includes("Hoppa till utmaningen"));
    assert.ok(htmlByLang.sv.includes("Runda 2: Hitta faran - Domare mot HoldUp"));
    assert.ok(htmlByLang.sv.includes("Saker (1)"));
    assert.ok(htmlByLang.sv.includes("Fara (2)"));
    assert.ok(htmlByLang.sv.includes("Inte saker - avsta (3)"));
  });

  test("binds pixel scene canvas role=img with phase-accurate aria-label across Round 1 and Round 2 and verifies sprite assets exist", () => {
    const spriteEntries = Object.entries(BLINDFOLD_SPRITE_URLS);
    assert.ok(spriteEntries.length >= 40, `Expected >= 40 pixel sprites in BLINDFOLD_SPRITE_URLS, got ${spriteEntries.length}`);
    for (const [key, relUrl] of spriteEntries) {
      const diskPath = path.join(PUBLIC_DIR, relUrl.startsWith(SLASH) ? relUrl.slice(1) : relUrl);
      assert.equal(fs.existsSync(diskPath), true, `Missing pixel sprite ${key} at ${relUrl}`);
      assert.ok(fs.statSync(diskPath).size > 64, `Expected non-empty PNG for sprite ${key}`);
    }

    const r1Idle = renderView({ round: "blindfold", blindfoldOn: true, cameraState: "off" });
    assert.match(
      r1Idle,
      /<canvas class="bf-pixel-canvas" width="480" height="270" role="img" aria-label="Pixel art pharmacy and home scene: blindfold mode active, phase idle\."/,
    );

    const r1Starting = renderView({ round: "blindfold", blindfoldOn: false, cameraState: "starting" });
    assert.ok(r1Starting.includes("blindfold mode lifted, phase checking."));

    const r1Coaching = renderView({
      round: "blindfold",
      blindfoldOn: true,
      cameraState: "on",
      cueText: "Turn the box slowly.",
    });
    assert.ok(r1Coaching.includes("blindfold mode active, phase coaching, cue Turn the box slowly.."));

    const sampleMatch = runSimulatedBox(SIM_BOXES[0].id, demoProfile(), EVENING_EET).verdict;
    const r1Match = renderView({ round: "blindfold", verdict: sampleMatch });
    assert.ok(r1Match.includes("phase match"));

    const r2Spot = renderView({
      round: "spot",
      spotIndex: 1,
      spotGuess: "warning",
      judgeScore: 2,
      holdupScore: 2,
      answeredCount: 2,
    });
    assert.ok(
      r2Spot.includes(
        "Pixel art pharmacy Spot the Danger scene: card 2 of 5, phase warning, Judge 2 of 5 vs HoldUp 5 of 5.",
      ),
    );
  });

  test("renders Round 1 camera states, blindfold blur curtain, readiness meter clamping, non-spamming cue strip, and primary controls", () => {
    const offHtml = renderView({ cameraState: "off", blindfoldOn: true, readiness: -0.4 });
    assert.match(offHtml, /<video class="bf-video blindfolded" playsinline="" muted="" autoplay="" aria-hidden="true"><\/video>/i);
    assert.equal(offHtml.includes('data-testid="camera-on-badge"'), false);
    assert.match(offHtml, /role="meter" aria-label="Label readiness" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"/);
    assert.match(offHtml, /class="bf-meter-fill" style="width:0%"/);
    assert.match(offHtml, /class="bf-cue-strip" aria-live="off"/);
    assert.match(offHtml, /class="bf-big-btn" data-testid="blindfold-primary-btn">Start blindfold camera check \(Space\)<\/button>/);

    const startingHtml = renderView({ cameraState: "starting", readiness: 0.25 });
    assert.match(
      startingHtml,
      /class="bf-big-btn" data-testid="blindfold-primary-btn" disabled="">Starting phone camera\.\.\.<\/button>/,
    );

    const onCurtainHtml = renderView({
      cameraState: "on",
      blindfoldOn: true,
      readiness: 0.644,
      cue: "rotate_left",
      cueText: "Turn the box slowly.",
      lastSpoken: "Turn the box slowly.",
    });
    assert.ok(onCurtainHtml.includes('data-testid="camera-on-badge"'));
    assert.ok(onCurtainHtml.includes("CAMERA ON - LOCAL ONLY"));
    assert.ok(onCurtainHtml.includes("EYES-CLOSED AUDIO MODE"));
    assert.ok(onCurtainHtml.includes("blindfold blur curtain enabled"));
    assert.match(onCurtainHtml, /aria-valuenow="64"/);
    assert.match(onCurtainHtml, /style="width:64%"/);
    assert.match(onCurtainHtml, /class="bf-big-btn running" data-testid="blindfold-primary-btn">Stop camera \(Space or Esc\)<\/button>/);
    assert.ok(onCurtainHtml.includes('data-testid="blindfold-curtain-btn" aria-pressed="true"'));
    assert.ok(onCurtainHtml.includes('data-testid="blindfold-repeat-btn"'));

    const onLiftedHtml = renderView({ cameraState: "on", blindfoldOn: false, readiness: 1.75 });
    assert.match(onLiftedHtml, /<video class="bf-video" playsinline=""/i);
    assert.equal(onLiftedHtml.includes("EYES-CLOSED AUDIO MODE"), false);
    assert.ok(onLiftedHtml.includes("preview visible"));
    assert.match(onLiftedHtml, /aria-valuenow="100"/);
    assert.ok(onLiftedHtml.includes('data-testid="blindfold-curtain-btn" aria-pressed="false"'));

    const deniedHtml = renderView({
      cameraState: "denied",
      cameraProblem: "Camera permission was blocked.",
    });
    assert.ok(deniedHtml.includes("Phone camera unavailable. Camera permission was blocked."));
    assert.ok(deniedHtml.includes("Camera permission was blocked."));
  });

  test("renders Round 1 verdict card across match, warning, and unsure with non-color glyph + LEVEL_WORD, focusable heading, and dose actions", () => {
    const profile = demoProfile();
    const matchVerdict = runSimulatedBox(SIM_BOXES[0].id, profile, EVENING_EET).verdict;
    assert.equal(matchVerdict.level, "match");
    assert.equal(matchVerdict.matchedMedId, "amlodipine");
    assert.equal(matchVerdict.takenToday, false);

    const matchHtml = renderView({ verdict: matchVerdict });
    assert.match(matchHtml, /<section class="bf-verdict-box match" data-testid="blindfold-verdict" aria-labelledby="bf-verdict-h">/);
    assert.match(matchHtml, /<span class="bf-verdict-glyph match"><svg/);
    assert.match(matchHtml, /<span class="bf-level-pill match">Match<\/span>/);
    assert.match(matchHtml, /<h3 id="bf-verdict-h" tabindex="-1">/);
    assert.ok(matchHtml.includes(">I took it</button>"));
    assert.ok(matchHtml.includes(">Repeat</button>"));
    assert.ok(matchHtml.includes(">Dismiss</button>"));

    const alreadyTakenHtml = renderView({ verdict: { ...matchVerdict, level: "warning", takenToday: true } });
    assert.match(alreadyTakenHtml, /<span class="bf-level-pill warning">Warning<\/span>/);
    assert.ok(alreadyTakenHtml.includes(">Log another dose</button>"));

    const unknownSpec = SIM_BOXES.find((b) => b.id === "unknown_pack") ?? SIM_BOXES.find((b) => b.expectedLevel === "unsure");
    assert.ok(unknownSpec, "Expected at least one unsure SIM_BOXES entry");
    const unsureVerdict = runSimulatedBox(unknownSpec.id, profile, EVENING_EET).verdict;
    const unsureHtml = renderView({ verdict: unsureVerdict });
    assert.match(unsureHtml, /<section class="bf-verdict-box unsure" data-testid="blindfold-verdict"/);
    assert.match(unsureHtml, /<span class="bf-level-pill unsure">Not sure<\/span>/);
    assert.equal(unsureHtml.includes(">I took it</button>"), false);
  });

  test("renders 6 simulated medicine boxes and guarantees deterministic verdicts across 08:30 EET, 20:00 EET, 19:00 UTC, and dose logging", (t: TestContext) => {
    localStorageShim.clear();
    const profile = demoProfile();

    assert.equal(SIM_BOXES.length, 6, `Expected 6 items in SIM_BOXES, got ${SIM_BOXES.length}`);
    const uniqueIds = new Set(SIM_BOXES.map((b) => b.id));
    assert.equal(uniqueIds.size, 6, "SIM_BOXES must have 6 distinct IDs");
    assert.equal(SIM_BOXES[0].id, "amlodipine", "First SIM_BOXES item must be amlodipine");
    assert.equal(SIM_BOXES[0].expectedLevel, "match");
    assert.equal(SIM_BOXES.some((b) => b.id === "ibuprofen" && b.expectedLevel === "warning"), true);
    assert.equal(SIM_BOXES.some((b) => b.id === "unknown_pack" && b.expectedLevel === "unsure"), true);

    const viewHtml = renderView({ round: "blindfold", lang: "en" });
    for (const spec of SIM_BOXES) {
      assert.ok(viewHtml.includes(`data-sim-box="${spec.id}"`), `BlindfoldView must render [data-sim-box="${spec.id}"]`);
      for (const lang of LANGS) {
        assert.ok(spec.label[lang].trim().length > 0, `Missing ${lang} label for ${spec.id}`);
        assert.ok(spec.hint[lang].trim().length > 0, `Missing ${lang} hint for ${spec.id}`);
      }

      const morning = runSimulatedBox(spec.id, profile, MORNING_EET);
      const evening = runSimulatedBox(spec.id, profile, EVENING_EET);
      const utcEve = runSimulatedBox(spec.id, profile, EVENING_UTC);
      assert.equal(morning.verdict.level, spec.expectedLevel, `${spec.id} at 08:30 EET must be ${spec.expectedLevel}`);
      assert.equal(evening.verdict.level, spec.expectedLevel, `${spec.id} at 20:00 EET must be ${spec.expectedLevel}`);
      assert.equal(utcEve.verdict.level, spec.expectedLevel, `${spec.id} at 19:00 UTC must be ${spec.expectedLevel}`);
      assert.ok(morning.coachingCues.length > 0);
    }

    t.mock.timers.enable({ apis: ["Date"], now: MORNING_EET.getTime() });
    try {
      const beforeLog = runSimulatedBox("amlodipine", profile);
      assert.equal(beforeLog.verdict.level, "match");
      assert.equal(beforeLog.verdict.takenToday, false);

      const logged = logDose(profile, "amlodipine");
      const afterLog = runSimulatedBox("amlodipine", logged);
      assert.equal(afterLog.verdict.level, "warning");
      assert.equal(afterLog.verdict.takenToday, true);
      assert.equal(afterLog.phraseId, "already_taken");

      const offlineUnknown = runOfflineCodeVerdict("6416542999998", profile, MORNING_EET);
      assert.equal(offlineUnknown.verdict.level, "unsure");
      assert.equal(offlineUnknown.phraseId, "unknown_offline");
    } finally {
      t.mock.timers.reset();
    }

    const cueSel = selectCoachCue({
      brightness: 0.6,
      sharpness: 0.6,
      motion: 0.01,
      edgeDensity: 0.25,
      glare: 0.02,
      readiness: 0.85,
    });
    assert.equal(cueSel.cue, "ok");
    assert.equal(cueSel.phraseId, "cue_reading");
  });

  test("renders Round 2 Spot the Danger 5-card flow, pack JPEGs, Judge vs HoldUp scoreboard, semantic confidence table, and final restart", () => {
    assert.equal(SPOT_CARDS.length, 5);
    const expectedLevels: ReadonlyArray<Verdict["level"]> = ["match", "warning", "warning", "warning", "unsure"];
    const profile = spotDemoProfile();
    assert.equal(profile.meds.length, 3);

    for (let idx = 0; idx < SPOT_CARDS.length; idx++) {
      const card = SPOT_CARDS[idx];
      assert.equal(card.round, idx + 1);
      assert.equal(card.expectedLevel, expectedLevels[idx]);
      const imgDiskPath = path.join(PUBLIC_DIR, card.imageUrl.startsWith(SLASH) ? card.imageUrl.slice(1) : card.imageUrl);
      assert.equal(fs.existsSync(imgDiskPath), true, `Expected Round 2 label image on disk: ${card.imageUrl}`);
      assert.ok(fs.statSync(imgDiskPath).size > 2000, `Expected non-trivial JPEG size for ${card.imageUrl}`);

      const expectedChoice: JudgeChoice = card.expectedLevel === "info" ? "match" : card.expectedLevel;
      for (const lang of LANGS) {
        const rightEval = evaluateSpotCard(card, expectedChoice, lang);
        assert.equal(rightEval.correct, true);
        assert.equal(rightEval.holdupVerdict.level, card.expectedLevel);
      }

      const wrongChoice: JudgeChoice = expectedChoice === "match" ? "warning" : "match";
      const wrongEval = evaluateSpotCard(card, wrongChoice, "en");
      assert.equal(wrongEval.correct, false);

      const revealHtml = renderView({
        round: "spot",
        lang: "en",
        spotIndex: idx,
        spotGuess: expectedChoice,
        judgeScore: idx + 1,
        holdupScore: idx + 1,
        answeredCount: idx + 1,
        spotCards: SPOT_CARDS,
      });

      assert.ok(revealHtml.includes('data-testid="spot-scoreboard"'));
      assert.ok(revealHtml.includes(`src="${card.imageUrl}"`));
      assert.ok(revealHtml.includes(`alt="${card.title.en} (${card.degradation})"`));
      assert.ok(revealHtml.includes('data-testid="choice-match"'));
      assert.ok(revealHtml.includes('data-testid="choice-warning"'));
      assert.ok(revealHtml.includes('data-testid="choice-unsure"'));
      assert.ok(revealHtml.includes(`data-testid="choice-${card.expectedLevel}" aria-pressed="true"`));
      assert.ok(revealHtml.includes('data-testid="spot-reveal"'));
      assert.ok(revealHtml.includes('data-testid="blindfold-verdict"'));
      assert.ok(revealHtml.includes("Judge call matched safety rule"));
      assert.match(
        revealHtml,
        /<table class="bf-conf-table"><caption>Per-field confidence read[\s\S]*?<th scope="col">Field<\/th><th scope="col">Read value<\/th><th scope="col">Confidence<\/th>[\s\S]*?<th scope="row">Product<\/th>[\s\S]*?<th scope="row">Strength<\/th>[\s\S]*?<th scope="row">Allergens<\/th>[\s\S]*?<th scope="row">Barcode<\/th>/,
      );

      if (idx < SPOT_CARDS.length - 1) {
        assert.ok(revealHtml.includes('data-testid="spot-next-btn"'));
        assert.equal(revealHtml.includes('data-testid="spot-final-summary"'), false);
      } else {
        assert.ok(revealHtml.includes('data-testid="spot-final-summary"'));
        assert.ok(revealHtml.includes("Final score: Judge 5/5 vs HoldUp 5/5"));
        assert.ok(revealHtml.includes('data-testid="spot-restart-btn"'));
      }
    }

    const missedHtml = renderView({
      round: "spot",
      lang: "en",
      spotIndex: 1,
      spotGuess: "match",
      judgeScore: 0,
      holdupScore: 1,
      answeredCount: 1,
      spotCards: SPOT_CARDS,
    });
    assert.ok(missedHtml.includes("Judge call missed the safety rule"));
    assert.ok(missedHtml.includes("Not readable"));

    const foodRevealHtml = renderView({
      round: "spot",
      lang: "en",
      spotIndex: 3,
      spotGuess: "warning",
      judgeScore: 4,
      holdupScore: 4,
      answeredCount: 4,
      spotCards: SPOT_CARDS,
    });
    assert.ok(foodRevealHtml.includes("arachis oil, hazelnut"));
  });

  test("verifies all 14 offline voice clip audition buttons across EN/FI/SV (42 clips) match manifest.json and on-disk audio", () => {
    assert.equal(ALL_PHRASE_IDS.length, 14);
    const manifest = JSON.parse(fs.readFileSync(PHRASE_MANIFEST_PATH, "utf8")) as PhraseManifest;

    let verifiedFiles = 0;
    for (const lang of LANGS) {
      const activeId = "not_sure";
      const html = renderView({ lang, activeClipId: activeId });
      assert.match(html, /<details class="bf-clips-drawer"><summary class="bf-clips-summary">/);
      assert.ok(
        html.includes(`class="bf-clip-btn active" data-clip-id="${activeId}"`),
        `Expected active clip button class on ${activeId} in ${lang}`,
      );

      for (const clipId of ALL_PHRASE_IDS) {
        assert.ok(html.includes(`data-clip-id="${clipId}"`));
        assert.ok(html.includes(`/phrases/${lang}/${clipId}</small>`));

        const entry = manifest.phrases[lang]?.[clipId];
        assert.ok(entry, `Missing manifest entry ${lang}.${clipId}`);
        const rel = entry.file.startsWith(SLASH) ? entry.file.slice(1) : entry.file;
        const audioPath = path.join(PUBLIC_DIR, rel);
        assert.equal(fs.existsSync(audioPath), true, `Missing phrase audio file: ${entry.file}`);
        assert.ok(fs.statSync(audioPath).size > 200, `Expected audio file > 200 bytes: ${entry.file}`);
        verifiedFiles++;
      }
    }
    assert.equal(verifiedFiles, 42);
  });

  test("enforces keyboard shortcuts, interactive target guard, srMode quiet audio gate, video-only audio:false, and 45s camera cleanup", () => {
    const blindfoldSrc = fs.readFileSync(BLINDFOLD_TSX_PATH, "utf8");
    const mediaSrc = fs.readFileSync(MEDIA_TS_PATH, "utf8");

    assert.ok(blindfoldSrc.includes("function isInteractiveTarget("));
    assert.ok(blindfoldSrc.includes('e.key === "Escape"'));
    assert.ok(blindfoldSrc.includes('e.key === " "') && blindfoldSrc.includes('e.key === "Enter"'));
    assert.ok(blindfoldSrc.includes('e.key === "r"') && blindfoldSrc.includes('e.key === "R"'));
    assert.ok(blindfoldSrc.includes('e.key === "1"') && blindfoldSrc.includes('e.key === "2"') && blindfoldSrc.includes('e.key === "3"'));

    assert.ok(
      blindfoldSrc.includes("announceThrottled(") && blindfoldSrc.includes("if (srModeRef.current) return;"),
      "srMode must keep screen-reader announcements active while muting synthetic voice/chimes",
    );

    assert.equal(blindfoldSrc.includes("getMic"), false, "Blindfold.tsx must never call getMic");
    assert.doesNotMatch(blindfoldSrc, /audio\s*:\s*(true|\{)/, "Blindfold.tsx must never request microphone audio");
    assert.match(mediaSrc, /function\s+getCamera[\s\S]{0,300}audio\s*:\s*false/, "getCamera() must enforce audio: false");

    assert.ok(blindfoldSrc.includes("const AUTO_STOP_MS = 45_000;"), "Blindfold.tsx must enforce 45_000 ms auto-stop");
    for (const lifecycleToken of [
      "visibilitychange",
      "pagehide",
      "getTracks()",
      "track.stop()",
      "videoRef.current.srcObject = null",
      "verdictHeadingRef.current?.focus()",
      "primaryBtnRef.current?.focus()",
      "document.documentElement.lang = lang",
    ]) {
      assert.ok(blindfoldSrc.includes(lifecycleToken), `Blindfold.tsx must include ${lifecycleToken}`);
    }
  });

  test("enforces 100% DOM-to-CSS class parity, touch target minimums, meter track clipping, 320px reflow, and media query accessibility in blindfold.css", () => {
    const blindfoldCss = fs.readFileSync(BLINDFOLD_CSS_PATH, "utf8");
    const webStylesCss = fs.readFileSync(STYLES_CSS_PATH, "utf8");
    const combinedCss = `${webStylesCss}\n${blindfoldCss}`;

    const sampleMatch = runSimulatedBox(SIM_BOXES[0].id, demoProfile(), EVENING_EET).verdict;
    const htmlSamples = [
      renderView({ round: "blindfold", cameraState: "off", blindfoldOn: true }),
      renderView({ round: "blindfold", cameraState: "on", blindfoldOn: true, cueText: "Hold still.", lastSpoken: "Hold still." }),
      renderView({ round: "blindfold", cameraState: "off", verdict: sampleMatch, activeClipId: "cue_steady" }),
      renderView({ round: "spot", spotIndex: 0, spotGuess: "match", judgeScore: 1, holdupScore: 1, answeredCount: 1 }),
      renderView({ round: "spot", spotIndex: 4, spotGuess: "unsure", judgeScore: 5, holdupScore: 5, answeredCount: 5 }),
    ];

    const renderedClasses = new Set<string>();
    for (const html of htmlSamples) {
      for (const cls of extractHtmlClasses(html)) {
        renderedClasses.add(cls);
      }
    }

    const unstyledBf: string[] = [];
    const unstyledAny: string[] = [];
    for (const cls of renderedClasses) {
      const escaped = cls.replace(/[.*+?^${}()|[\]\\]/g, BACKSLASH + "$&");
      const selectorRe = new RegExp("\\." + escaped + "(?![a-zA-Z0-9_-])");
      if (cls.startsWith("bf-")) {
        if (!selectorRe.test(blindfoldCss)) unstyledBf.push(cls);
      } else if (!selectorRe.test(combinedCss)) {
        unstyledAny.push(cls);
      }
    }
    assert.deepEqual(unstyledBf, [], `Unstyled bf-* classes in blindfold.css: ${unstyledBf.join(", ")}`);
    assert.deepEqual(unstyledAny, [], `Unstyled classes in combined CSS: ${unstyledAny.join(", ")}`);

    assert.ok(extractPxProp(blindfoldCss, ".bf-big-btn", "min-height") >= 88, ".bf-big-btn min-height must be >= 88px");
    for (const cls56 of [
      ".bf-lang-btn",
      ".bf-sr-toggle",
      ".bf-round-tab",
      ".bf-curtain-toggle",
      ".bf-repeat-btn",
      ".bf-sim-btn",
      ".bf-clip-btn",
      ".bf-choice-btn",
    ]) {
      const mh = extractPxProp(blindfoldCss, cls56, "min-height");
      assert.ok(mh >= 56, `Expected ${cls56} min-height >= 56px, got ${mh}px`);
    }

    const actionMinH = extractPxProp(blindfoldCss, ".bf-action-btn", "min-height");
    const actionMinW = extractPxProp(blindfoldCss, ".bf-action-btn", "min-width");
    assert.ok(actionMinH >= 52, `Expected .bf-action-btn min-height >= 52px, got ${actionMinH}px`);
    assert.ok(actionMinW >= 56, `Expected .bf-action-btn min-width >= 56px, got ${actionMinW}px`);

    const meterTrackH = extractPxProp(blindfoldCss, ".bf-meter-track", "height");
    const meterTrackBodies = extractCssRuleBodies(blindfoldCss, ".bf-meter-track").join("\n");
    assert.equal(meterTrackH, 16, `Expected .bf-meter-track height: 16px, got ${meterTrackH}px`);
    assert.match(meterTrackBodies, /overflow\s*:\s*hidden/, "Expected .bf-meter-track overflow: hidden");

    assert.doesNotMatch(blindfoldCss, /\bposition\s*:\s*(sticky|fixed)\b/i, "blindfold.css must have zero sticky/fixed positioning");
    assert.match(blindfoldCss, /overflow-x\s*:\s*(clip|hidden)/);
    assert.ok(blindfoldCss.includes("overflow-wrap: anywhere") && blindfoldCss.includes("min-width: 0"));
    assert.match(blindfoldCss, /@media\s*\(\s*max-width\s*:\s*480px\s*\)[\s\S]*?grid-template-columns\s*:\s*1fr/);
    assert.match(blindfoldCss, /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/);
    assert.match(blindfoldCss, /@media\s*\(\s*prefers-contrast\s*:\s*more\s*\)/);
    assert.match(blindfoldCss, /@media\s*\(\s*forced-colors\s*:\s*active\s*\)/);
    assert.ok(blindfoldCss.includes("Canvas") && blindfoldCss.includes("CanvasText"));
  });
});
