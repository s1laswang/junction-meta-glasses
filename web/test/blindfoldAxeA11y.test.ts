import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEST_FILE = fileURLToPath(import.meta.url);
const TEST_DIR = path.dirname(TEST_FILE);
const REPO_DIR = process.env.HOLDUP_TEST_REPO_DIR
  ? path.resolve(process.env.HOLDUP_TEST_REPO_DIR)
  : path.resolve(TEST_DIR, "..", "..");

const AUDIT_SCRIPT_PATH = path.join(REPO_DIR, "scripts", "blindfold-a11y-audit.mjs");
const EVIDENCE_JSON_PATH = path.join(REPO_DIR, "docs", "evidence", "blindfold-a11y.json");
const MAIN_TSX_PATH = path.join(REPO_DIR, "web", "src", "main.tsx");
const BLINDFOLD_TSX_PATH = path.join(REPO_DIR, "web", "src", "screens", "Blindfold.tsx");
const BLINDFOLD_CSS_PATH = path.join(REPO_DIR, "web", "src", "screens", "blindfold.css");
const MEDIA_TS_PATH = path.join(REPO_DIR, "web", "src", "lib", "media.ts");
const STORAGE_TS_PATH = path.join(REPO_DIR, "web", "src", "lib", "storage.ts");
const COACH_TS_PATH = path.join(REPO_DIR, "web", "src", "lib", "blindfoldCoach.ts");
const PHRASE_MANIFEST_PATH = path.join(REPO_DIR, "web", "public", "phrases", "manifest.json");
const PUBLIC_DIR = path.join(REPO_DIR, "web", "public");
const SHARED_PLAYWRIGHT_DIR = "/tmp/fleet-root/shared/ms-playwright";

const SLASH = String.fromCharCode(47);
const LINE_COMMENT = String.fromCharCode(47, 47);
const BLOCK_COMMENT_OPEN = String.fromCharCode(47, 42);
const BLOCK_COMMENT_CLOSE = String.fromCharCode(42, 47);
const HTML_COMMENT_OPEN = String.fromCharCode(60, 33, 45, 45);
const EM_DASH = String.fromCharCode(8212);
const EN_DASH = String.fromCharCode(8211);
const ESCAPED_EM_DASH = String.fromCharCode(92) + "u2014";
const ESCAPED_EN_DASH = String.fromCharCode(92) + "u2013";

const EXPECTED_HONESTY_DISCLOSURE = "OFFLINE DEMO - PHONE CAMERA ONLY (no physical glasses)";
const EXPECTED_LANGS = ["en", "fi", "sv"] as const;
const EXPECTED_PHRASE_IDS = [
  "already_taken",
  "back_online",
  "camera_off",
  "cue_closer",
  "cue_further",
  "cue_more_light",
  "cue_reading",
  "cue_rotate",
  "cue_steady",
  "cue_tilt",
  "glasses_off",
  "not_sure",
  "offline",
  "unknown_offline",
] as const;

type AxeViolationRecord = {
  id: string;
  impact?: string | null;
  help?: string;
  nodes?: number | unknown[];
};

type BlindfoldAuditStateRecord = {
  state?: string;
  label?: string;
  id?: string;
  name?: string;
  round?: string | number;
  lang?: string;
  route?: string;
  url?: string;
  viewport?: string;
  media?: string;
  mediaMatches?: boolean;
  violations: AxeViolationRecord[];
  violationNodes?: number;
  passes: number;
  incomplete?: number;
  horizontalOverflowPx?: number;
  verticalOverflowPx?: number;
};

type BlindfoldAuditSummary = {
  ok?: boolean;
  totalViolationNodes?: number;
  minPrimaryButtonHeightPx?: number;
  minControlHeightPx?: number;
  micRequests?: number;
  externalRequests?: number;
  horizontalOverflowPx?: number;
};

type BlindfoldAuditReport = BlindfoldAuditSummary & {
  tool?: string;
  tags?: string;
  when?: string;
  summary?: BlindfoldAuditSummary;
  states?: BlindfoldAuditStateRecord[];
  results?: BlindfoldAuditStateRecord[];
  axeStates?: BlindfoldAuditStateRecord[];
  reflow320x568?: {
    viewport?: string;
    horizontalOverflowPx?: number;
    violations?: AxeViolationRecord[];
    passes?: number;
  };
  reducedMotion?: {
    violations?: AxeViolationRecord[];
    violationNodes?: number;
    passes?: number;
  };
  forcedColors?: {
    violations?: AxeViolationRecord[];
    violationNodes?: number;
    passes?: number;
  };
};

type PhraseManifest = {
  model: string;
  generated: string;
  phrases: Record<string, Record<string, { file: string; text: string }>>;
};

function hasChromiumInRoot(cacheRoot: string): boolean {
  if (!cacheRoot || !fs.existsSync(cacheRoot)) return false;
  let entries: string[];
  try {
    entries = fs.readdirSync(cacheRoot);
  } catch {
    return false;
  }

  const chromiumRelCandidates = [
    ["chrome-linux", "chrome"],
    ["chrome-linux64", "chrome"],
    ["chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
    ["chrome-mac-x64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
    ["chrome-mac", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
    ["chrome-mac-arm64", "Chromium.app", "Contents", "MacOS", "Chromium"],
    ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"],
    ["chrome-linux", "headless_shell"],
    ["chrome-linux64", "chrome-headless-shell"],
    ["chrome-mac-arm64", "chrome-headless-shell-mac-arm64", "chrome-headless-shell"],
    ["chrome-mac", "chrome-headless-shell-mac-x64", "chrome-headless-shell"],
  ];

  for (const dir of entries) {
    if (!dir.startsWith("chromium-") && !dir.startsWith("chromium_headless_shell-")) continue;
    for (const rel of chromiumRelCandidates) {
      if (fs.existsSync(path.join(cacheRoot, dir, ...rel))) return true;
    }
  }
  return false;
}

function detectHostChromium(): boolean {
  const explicit = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  if (explicit && fs.existsSync(explicit)) return true;

  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH ?? "",
    SHARED_PLAYWRIGHT_DIR,
    path.join(os.homedir(), ".cache/ms-playwright"),
    path.join(os.homedir(), "Library/Caches/ms-playwright"),
  ].filter(Boolean);

  return roots.some((r) => hasChromiumInRoot(r));
}

function assertCleanAsciiHygiene(label: string, source: string): void {
  assert.ok(source.length > 200, `${label} must be non-empty`);
  assert.equal(source.includes(LINE_COMMENT), false, `${label} must contain zero line comments`);
  assert.equal(source.includes(BLOCK_COMMENT_OPEN), false, `${label} must contain zero block comment openers`);
  assert.equal(source.includes(BLOCK_COMMENT_CLOSE), false, `${label} must contain zero block comment closers`);
  assert.equal(source.includes(HTML_COMMENT_OPEN), false, `${label} must contain zero HTML comments`);
  assert.equal(source.includes(EM_DASH), false, `${label} must contain zero em dashes`);
  assert.equal(source.includes(EN_DASH), false, `${label} must contain zero en dashes`);
  assert.equal(source.includes(ESCAPED_EM_DASH), false, `${label} must contain zero escaped em dashes`);
  assert.equal(source.includes(ESCAPED_EN_DASH), false, `${label} must contain zero escaped en dashes`);

  for (let i = 0; i < source.length; i++) {
    const code = source.charCodeAt(i);
    assert.ok(
      code <= 127 && (code === 9 || code === 10 || code === 13 || code >= 32),
      `${label} must be pure ASCII; found charCode ${code} at index ${i}`,
    );
  }
}

function extractMinHeightPx(cssSource: string, classSelector: string): number {
  const escaped = classSelector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rulePattern = new RegExp(escaped + "(?![a-zA-Z0-9_-])[^{]*\\{([^}]*)\\}", "g");
  let match: RegExpExecArray | null;
  while ((match = rulePattern.exec(cssSource)) !== null) {
    const body = match[1];
    const mh = new RegExp("min-height\\s*:\\s*(\\d+(?:\\.\\d+)?)px").exec(body);
    if (mh) {
      return Number(mh[1]);
    }
  }
  return 0;
}

function pickMetric<K extends keyof BlindfoldAuditSummary>(
  report: BlindfoldAuditReport,
  key: K,
): BlindfoldAuditSummary[K] {
  const topVal = report[key];
  const sumVal = report.summary?.[key];
  if (topVal !== undefined && sumVal !== undefined) {
    assert.equal(topVal, sumVal, `Report top-level ${String(key)} must match summary.${String(key)}`);
  }
  return topVal !== undefined ? topVal : sumVal;
}

function getStateLabel(st: BlindfoldAuditStateRecord): string {
  return String(st.state ?? st.label ?? st.id ?? st.name ?? "").trim();
}

function extractStateList(report: BlindfoldAuditReport): BlindfoldAuditStateRecord[] {
  if (Array.isArray(report.states)) return report.states;
  if (Array.isArray(report.results)) return report.results;
  if (Array.isArray(report.axeStates)) return report.axeStates;
  assert.fail("Expected audited states array under report.states, report.results, or report.axeStates");
}

function assertValidBlindfoldAuditReport(report: BlindfoldAuditReport): void {
  const ok = pickMetric(report, "ok");
  const totalViolationNodes = pickMetric(report, "totalViolationNodes");
  const minPrimaryButtonHeightPx = pickMetric(report, "minPrimaryButtonHeightPx");
  const minControlHeightPx = pickMetric(report, "minControlHeightPx");
  const micRequests = pickMetric(report, "micRequests");
  const externalRequests = pickMetric(report, "externalRequests");

  assert.equal(ok, true, "Audit report ok must be true");
  assert.equal(totalViolationNodes, 0, "Audit report totalViolationNodes must be 0");
  assert.equal(typeof minPrimaryButtonHeightPx, "number", "minPrimaryButtonHeightPx must be a number");
  assert.ok(
    (minPrimaryButtonHeightPx as number) >= 88,
    `Expected minPrimaryButtonHeightPx >= 88, got ${String(minPrimaryButtonHeightPx)}`,
  );
  assert.equal(typeof minControlHeightPx, "number", "minControlHeightPx must be a number");
  assert.ok(
    (minControlHeightPx as number) >= 48,
    `Expected minControlHeightPx >= 48, got ${String(minControlHeightPx)}`,
  );
  assert.equal(micRequests, 0, "Audit report micRequests must be 0");
  assert.equal(externalRequests, 0, "Audit report externalRequests must be 0");

  const states = extractStateList(report);
  assert.ok(states.length >= 6, `Expected at least 6 audited states in blindfold-a11y.json, got ${states.length}`);

  for (const st of states) {
    const label = getStateLabel(st);
    assert.ok(label.length > 0, "Each audited state must have a non-empty state/label identifier");
    assert.ok(Array.isArray(st.violations), `State "${label}" must record a violations array`);
    assert.equal(st.violations.length, 0, `State "${label}" must have 0 axe violations`);
    if (typeof st.violationNodes === "number") {
      assert.equal(st.violationNodes, 0, `State "${label}" violationNodes must be 0`);
    }
    assert.equal(typeof st.passes, "number", `State "${label}" passes must be a number`);
    assert.ok(st.passes > 0, `State "${label}" must record passes > 0, got ${st.passes}`);
    if (typeof st.horizontalOverflowPx === "number") {
      assert.equal(
        st.horizontalOverflowPx,
        0,
        `State "${label}" must have horizontalOverflowPx === 0, got ${st.horizontalOverflowPx}`,
      );
    }
  }

  const hasRound1 = states.some((st) => {
    const lbl = getStateLabel(st);
    const r = String(st.round ?? "");
    return r === "1" || r === "blindfold" || new RegExp("round[-_\\s]*1|r1|blindfold", "i").test(lbl);
  });
  assert.equal(hasRound1, true, "Evidence JSON must include Round 1 (Blindfold) audited state(s)");

  const hasRound2 = states.some((st) => {
    const lbl = getStateLabel(st);
    const r = String(st.round ?? "");
    return r === "2" || r === "spot" || new RegExp("round[-_\\s]*2|r2|spot", "i").test(lbl);
  });
  assert.equal(hasRound2, true, "Evidence JSON must include Round 2 (Spot the Danger) audited state(s)");

  for (const lang of EXPECTED_LANGS) {
    const langRe = new RegExp("(?:^|[^a-zA-Z0-9])" + lang + "(?:$|[^a-zA-Z0-9])", "i");
    const hasLang = states.some((st) => {
      const lbl = getStateLabel(st);
      const u = String(st.url ?? st.route ?? "");
      return st.lang === lang || langRe.test(lbl) || langRe.test(u);
    });
    assert.equal(hasLang, true, `Evidence JSON must include audited state for language "${lang}"`);
  }

  const reflowStates = states.filter((st) => {
    const lbl = getStateLabel(st);
    const vp = String(st.viewport ?? "");
    return vp === "320x568" || new RegExp("320x568|320", "i").test(lbl);
  });
  if (reflowStates.length > 0) {
    for (const rs of reflowStates) {
      assert.equal(
        rs.horizontalOverflowPx,
        0,
        `320x568 state "${getStateLabel(rs)}" must report horizontalOverflowPx === 0`,
      );
      assert.equal(rs.violations.length, 0);
      assert.ok(rs.passes > 0);
    }
  } else if (report.reflow320x568) {
    assert.equal(report.reflow320x568.horizontalOverflowPx, 0, "reflow320x568.horizontalOverflowPx must be 0");
    if (Array.isArray(report.reflow320x568.violations)) {
      assert.equal(report.reflow320x568.violations.length, 0);
    }
  } else {
    assert.fail("Evidence JSON must include a 320x568 viewport reflow state with horizontalOverflowPx === 0");
  }

  const reducedMotionStates = states.filter((st) => {
    const combined = `${getStateLabel(st)} ${String(st.media ?? "")}`;
    return new RegExp("reduced[-_\\s]*motion", "i").test(combined);
  });
  if (reducedMotionStates.length > 0) {
    for (const rm of reducedMotionStates) {
      assert.equal(rm.violations.length, 0, "prefers-reduced-motion state must have 0 violations");
      assert.ok(rm.passes > 0, "prefers-reduced-motion state must record passes > 0");
    }
  } else if (report.reducedMotion) {
    assert.equal(report.reducedMotion.violations?.length ?? 0, 0);
    assert.equal(report.reducedMotion.violationNodes ?? 0, 0);
  } else {
    assert.fail("Evidence JSON must include a prefers-reduced-motion audited state with 0 violations");
  }

  const forcedColorsStates = states.filter((st) => {
    const combined = `${getStateLabel(st)} ${String(st.media ?? "")}`;
    return new RegExp("forced[-_\\s]*colors", "i").test(combined);
  });
  if (forcedColorsStates.length > 0) {
    for (const fc of forcedColorsStates) {
      assert.equal(fc.violations.length, 0, "forced-colors state must have 0 violations");
      assert.ok(fc.passes > 0, "forced-colors state must record passes > 0");
    }
  } else if (report.forcedColors) {
    assert.equal(report.forcedColors.violations?.length ?? 0, 0);
    assert.equal(report.forcedColors.violationNodes ?? 0, 0);
  } else {
    assert.fail("Evidence JSON must include a forced-colors audited state with 0 violations");
  }
}

describe("/blindfold WCAG 2.2 AA axe-core, 320px reflow, keyboard, privacy, and phrase audio contract", () => {
  test("enforces strict self-hygiene: zero comments, zero em/en dashes, and pure ASCII across audit script, contract test, Blindfold.tsx, and blindfold.css", () => {
    const selfSource = fs.readFileSync(TEST_FILE, "utf8");
    assertCleanAsciiHygiene("web/test/blindfoldAxeA11y.test.ts (self)", selfSource);

    const repoTestPath = path.join(REPO_DIR, "web", "test", "blindfoldAxeA11y.test.ts");
    const targetFiles: Array<[string, string]> = [
      ["scripts/blindfold-a11y-audit.mjs", AUDIT_SCRIPT_PATH],
      ["web/test/blindfoldAxeA11y.test.ts", fs.existsSync(repoTestPath) ? repoTestPath : TEST_FILE],
      ["web/src/screens/Blindfold.tsx", BLINDFOLD_TSX_PATH],
      ["web/src/screens/blindfold.css", BLINDFOLD_CSS_PATH],
    ];

    for (const [label, absPath] of targetFiles) {
      assert.equal(fs.existsSync(absPath), true, `${label} must exist at ${absPath}`);
      const content = fs.readFileSync(absPath, "utf8");
      assertCleanAsciiHygiene(label, content);
    }
  });

  test("verifies web/src/main.tsx lazy-mounts /blindfold inside Suspense and sets blindfold-body", () => {
    assert.equal(fs.existsSync(MAIN_TSX_PATH), true, "web/src/main.tsx must exist");
    const mainSource = fs.readFileSync(MAIN_TSX_PATH, "utf8");

    assert.ok(
      mainSource.includes('"/blindfold"'),
      "web/src/main.tsx must match the /blindfold route",
    );
    assert.match(
      mainSource,
      new RegExp("lazy\\(\\s*\\(\\)\\s*=>\\s*import\\(\\s*[\"']\\." + SLASH + "screens" + SLASH + "Blindfold(?:\\.tsx)?[\"']"),
      "web/src/main.tsx must lazy-load ./screens/Blindfold.tsx",
    );
    assert.ok(
      mainSource.includes('classList.add("blindfold-body")'),
      "web/src/main.tsx must add blindfold-body class on /blindfold",
    );
    assert.match(
      mainSource,
      new RegExp("<Suspense[^>]*>[\\s\\S]*?<Blindfold\\s*" + SLASH + ">[\\s\\S]*?<" + SLASH + "Suspense>"),
      "web/src/main.tsx must wrap <Blindfold /> in <Suspense>",
    );
  });

  test("verifies Blindfold.tsx landmarks, honesty banner, EN/FI/SV switcher, Round 1 and Round 2 controls, pixel canvas, viewfinder, and confidence table", async () => {
    const blindfoldSource = fs.readFileSync(BLINDFOLD_TSX_PATH, "utf8");
    const storageSource = fs.existsSync(STORAGE_TS_PATH) ? fs.readFileSync(STORAGE_TS_PATH, "utf8") : "";

    assert.ok(
      blindfoldSource.includes('href="#blindfold-main"') && blindfoldSource.includes('className="skip"'),
      "Blindfold.tsx must render skip link a.skip[href=\"#blindfold-main\"]",
    );
    assert.match(
      blindfoldSource,
      new RegExp('<header[^>]*className="[^"]*bf-header[^"]*"'),
      "Blindfold.tsx must render header.bf-header",
    );
    assert.match(
      blindfoldSource,
      new RegExp('<main[^>]*id="blindfold-main"'),
      "Blindfold.tsx must render main#blindfold-main",
    );
    assert.match(
      blindfoldSource,
      new RegExp('<footer[^>]*className="[^"]*bf-footer[^"]*"'),
      "Blindfold.tsx must render footer.bf-footer",
    );

    assert.ok(
      blindfoldSource.includes('data-testid="honesty-banner"'),
      "Blindfold.tsx must render [data-testid=\"honesty-banner\"]",
    );
    assert.ok(
      blindfoldSource.includes('role="region"') && blindfoldSource.includes('aria-label="Demo disclosure"'),
      "Honesty banner must carry role=\"region\" and aria-label=\"Demo disclosure\"",
    );
    assert.ok(
      blindfoldSource.includes(EXPECTED_HONESTY_DISCLOSURE),
      `Blindfold.tsx must include exact disclosure text "${EXPECTED_HONESTY_DISCLOSURE}"`,
    );

    assert.ok(
      blindfoldSource.includes("data-lang-btn"),
      "Blindfold.tsx must render [data-lang-btn] language buttons",
    );
    for (const lang of EXPECTED_LANGS) {
      const hasLangToken =
        blindfoldSource.includes(`"${lang}"`) ||
        blindfoldSource.includes(`${lang}:`) ||
        storageSource.includes(`code: "${lang}"`);
      assert.equal(hasLangToken, true, `Language switcher must support "${lang}"`);
    }
    assert.ok(
      blindfoldSource.includes("aria-pressed="),
      "Blindfold.tsx toggle buttons must expose aria-pressed",
    );
    assert.ok(
      blindfoldSource.includes("document.documentElement.lang"),
      "Blindfold.tsx must sync document.documentElement.lang on language selection",
    );

    assert.ok(
      blindfoldSource.includes('data-testid="tab-round-1"') &&
        blindfoldSource.includes('data-testid="tab-round-2"'),
      "Blindfold.tsx must render [data-testid=\"tab-round-1\"] and [data-testid=\"tab-round-2\"]",
    );
    assert.match(
      blindfoldSource,
      new RegExp('role="group"[\\s\\S]{0,600}data-testid="tab-round-1"[\\s\\S]{0,600}data-testid="tab-round-2"'),
      "Round tabs must sit inside a role=\"group\" container",
    );

    const canvasTagMatch = new RegExp("<canvas[\\s\\S]{0,450}?" + SLASH + ">").exec(blindfoldSource);
    assert.ok(canvasTagMatch, "Blindfold.tsx must render a self-closing <canvas /> element");
    const canvasTag = canvasTagMatch[0];
    assert.ok(
      canvasTag.includes("bf-pixel-canvas"),
      "Pixel scene <canvas> must carry class bf-pixel-canvas",
    );
    assert.ok(
      canvasTag.includes('role="img"'),
      "Pixel scene canvas .bf-pixel-canvas must declare role=\"img\"",
    );
    assert.ok(
      canvasTag.includes("aria-label={"),
      "Pixel scene canvas .bf-pixel-canvas must bind a dynamic aria-label",
    );
    assert.ok(
      blindfoldSource.includes("prefers-reduced-motion: reduce") && blindfoldSource.includes("reducedMotion"),
      "Blindfold.tsx must wire prefers-reduced-motion to pixel scene reducedMotion",
    );

    assert.ok(
      blindfoldSource.includes("bf-viewfinder"),
      "Blindfold.tsx must render .bf-viewfinder container",
    );
    assert.match(
      blindfoldSource,
      new RegExp('<video[\\s\\S]{0,400}aria-hidden="true"'),
      "Camera preview <video> inside .bf-viewfinder must set aria-hidden=\"true\"",
    );

    for (const requiredTestId of [
      "blindfold-primary-btn",
      "blindfold-repeat-btn",
      "blindfold-sr-mode",
      "camera-on-badge",
      "blindfold-verdict",
      "spot-scoreboard",
      "spot-reveal",
      "choice-match",
      "choice-warning",
      "choice-unsure",
      "spot-next-btn",
    ]) {
      assert.ok(
        blindfoldSource.includes(`data-testid="${requiredTestId}"`),
        `Blindfold.tsx must render [data-testid="${requiredTestId}"]`,
      );
    }

    assert.ok(
      blindfoldSource.includes("data-sim-box"),
      "Blindfold.tsx must render [data-sim-box] simulated medicine box buttons",
    );
    if (fs.existsSync(COACH_TS_PATH)) {
      const coachMod = (await import(pathToFileURL(COACH_TS_PATH).href)) as {
        SIM_BOXES?: ReadonlyArray<{ id: string }>;
      };
      assert.ok(Array.isArray(coachMod.SIM_BOXES), "blindfoldCoach.ts must export SIM_BOXES array");
      assert.equal(coachMod.SIM_BOXES.length, 6, `Expected 6 simulated boxes in SIM_BOXES, got ${coachMod.SIM_BOXES.length}`);
    } else {
      const inlineSimMatches = blindfoldSource.match(/data-sim-box/g) ?? [];
      assert.ok(
        inlineSimMatches.length >= 6 || blindfoldSource.includes("SIM_BOXES"),
        "Blindfold.tsx must wire 6 simulated boxes via SIM_BOXES or inline [data-sim-box] buttons",
      );
    }

    assert.ok(
      blindfoldSource.includes("VerdictGlyph") && blindfoldSource.includes("LEVEL_WORD"),
      "[data-testid=\"blindfold-verdict\"] must pair non-color VerdictGlyph with LEVEL_WORD text",
    );

    assert.match(
      blindfoldSource,
      new RegExp("<table[^>]*>[\\s\\S]*?<caption>[\\s\\S]*?<th\\s+scope=\"col\">[\\s\\S]*?<th\\s+scope=\"row\">"),
      "Round 2 reveal must render a semantic confidence <table> with <caption>, <th scope=\"col\">, and <th scope=\"row\">",
    );
  });

  test("verifies Blindfold.tsx Space/Escape/R keyboard handling and video-only audio: false + 45s auto-stop + track cleanup", () => {
    const blindfoldSource = fs.readFileSync(BLINDFOLD_TSX_PATH, "utf8");
    const mediaSource = fs.existsSync(MEDIA_TS_PATH) ? fs.readFileSync(MEDIA_TS_PATH, "utf8") : "";

    assert.ok(
      blindfoldSource.includes("keydown") && blindfoldSource.includes('"Escape"'),
      "Blindfold.tsx must handle Escape in a keydown listener",
    );
    assert.ok(
      blindfoldSource.includes('=== " "') || blindfoldSource.includes('=== "Space"'),
      "Blindfold.tsx must handle Space key activation",
    );
    assert.ok(
      blindfoldSource.includes('"r"') && blindfoldSource.includes('"R"'),
      "Blindfold.tsx must handle R/r key repeat shortcut",
    );

    assert.equal(
      blindfoldSource.includes("getMic"),
      false,
      "Blindfold.tsx must never request microphone access via getMic",
    );
    assert.doesNotMatch(
      blindfoldSource,
      new RegExp("audio\\s*:\\s*(true|\\{)"),
      "Blindfold.tsx must never enable audio capture in MediaStreamConstraints",
    );

    const hasInlineAudioFalse = new RegExp("audio\\s*:\\s*false").test(blindfoldSource);
    const hasGetCameraAudioFalse =
      blindfoldSource.includes("getCamera") &&
      new RegExp("function\\s+getCamera[\\s\\S]{0,300}audio\\s*:\\s*false").test(mediaSource);
    assert.equal(
      hasInlineAudioFalse || hasGetCameraAudioFalse,
      true,
      "Camera acquisition must enforce video-only audio: false",
    );

    assert.match(
      blindfoldSource,
      new RegExp("45_000|45000"),
      "Blindfold.tsx must enforce a 45s (45_000 ms) camera auto-stop timeout",
    );
    assert.ok(
      blindfoldSource.includes("setTimeout") &&
        blindfoldSource.includes("visibilitychange") &&
        blindfoldSource.includes("pagehide") &&
        blindfoldSource.includes("getTracks") &&
        blindfoldSource.includes(".stop()") &&
        blindfoldSource.includes("srcObject = null"),
      "Blindfold.tsx must stop all MediaStreamTracks and clear srcObject on auto-stop, Escape, visibilitychange, and pagehide",
    );
  });

  test("verifies blindfold.css touch targets (>=88px primary, >=56px sim boxes), prefers-reduced-motion, forced-colors, and 320px reflow rules", () => {
    const cssSource = fs.readFileSync(BLINDFOLD_CSS_PATH, "utf8");

    const primaryMinHeight = extractMinHeightPx(cssSource, ".bf-big-btn");
    assert.ok(
      primaryMinHeight >= 88,
      `Expected .bf-big-btn min-height >= 88px in blindfold.css, got ${primaryMinHeight}px`,
    );

    const simBoxMinHeight = extractMinHeightPx(cssSource, ".bf-sim-btn");
    assert.ok(
      simBoxMinHeight >= 56,
      `Expected .bf-sim-btn min-height >= 56px in blindfold.css, got ${simBoxMinHeight}px`,
    );

    for (const ctrlClass of [".bf-lang-btn", ".bf-round-tab", ".bf-choice-btn"]) {
      const mh = extractMinHeightPx(cssSource, ctrlClass);
      assert.ok(mh >= 48, `Expected ${ctrlClass} min-height >= 48px in blindfold.css, got ${mh}px`);
    }

    assert.match(
      cssSource,
      new RegExp("@media\\s*\\(\\s*prefers-reduced-motion\\s*:\\s*reduce\\s*\\)"),
      "blindfold.css must define @media (prefers-reduced-motion: reduce)",
    );
    assert.match(
      cssSource,
      new RegExp("@media\\s*\\(\\s*forced-colors\\s*:\\s*active\\s*\\)"),
      "blindfold.css must define @media (forced-colors: active)",
    );
    for (const sysColor of ["Canvas", "CanvasText", "Highlight", "HighlightText", "ButtonBorder"]) {
      assert.ok(
        cssSource.includes(sysColor),
        `blindfold.css @media (forced-colors: active) must use system color ${sysColor}`,
      );
    }

    assert.match(
      cssSource,
      new RegExp("overflow-x\\s*:\\s*(clip|hidden)"),
      "blindfold.css must prevent horizontal scroll overflow via overflow-x: clip or hidden",
    );
    assert.ok(
      cssSource.includes("overflow-wrap: anywhere") && cssSource.includes("min-width: 0"),
      "blindfold.css must enforce overflow-wrap: anywhere and min-width: 0 for 320px reflow",
    );
    assert.match(
      cssSource,
      new RegExp("@media\\s*\\(\\s*max-width\\s*:\\s*(320|360|420|480)px\\s*\\)[\\s\\S]*?grid-template-columns\\s*:\\s*1fr"),
      "blindfold.css must collapse multi-column grids to 1fr at narrow mobile widths (<= 480px) for 320px reflow",
    );
  });

  test("verifies phrase audio parity: web/public/phrases/manifest.json and all 42 /phrases/{en,fi,sv} clips exist on disk with byte size > 200", () => {
    assert.equal(fs.existsSync(PHRASE_MANIFEST_PATH), true, "web/public/phrases/manifest.json must exist");
    const manifest = JSON.parse(fs.readFileSync(PHRASE_MANIFEST_PATH, "utf8")) as PhraseManifest;

    assert.equal(typeof manifest.model, "string");
    assert.ok(manifest.model.trim().length > 0);
    const langs = Object.keys(manifest.phrases ?? {}).sort();
    assert.deepEqual(langs, [...EXPECTED_LANGS]);

    const seenFiles = new Set<string>();
    for (const lang of EXPECTED_LANGS) {
      const bucket = manifest.phrases[lang];
      assert.ok(bucket && typeof bucket === "object", `Missing phrase bucket for ${lang}`);
      const phraseIds = Object.keys(bucket).sort();
      assert.deepEqual(phraseIds, [...EXPECTED_PHRASE_IDS], `Expected exact 14 phrase IDs for ${lang}`);

      for (const id of EXPECTED_PHRASE_IDS) {
        const entry = bucket[id];
        assert.ok(entry, `Missing manifest entry ${lang}.${id}`);
        assert.match(
          entry.file,
          new RegExp("^" + SLASH + "phrases" + SLASH + lang + SLASH + id + "\\.(mp3|wav)$"),
          `Unexpected phrase file path ${entry.file}`,
        );
        assert.equal(typeof entry.text, "string");
        assert.ok(entry.text.trim().length >= 4, `Phrase text for ${lang}.${id} must be non-empty`);

        const diskPath = path.join(PUBLIC_DIR, entry.file.slice(1));
        assert.equal(fs.existsSync(diskPath), true, `Missing phrase audio file on disk: ${entry.file}`);
        const stat = fs.statSync(diskPath);
        assert.equal(stat.isFile(), true, `${entry.file} must be a regular file`);
        assert.ok(stat.size > 200, `Expected ${entry.file} byte size > 200, got ${stat.size}`);
        seenFiles.add(entry.file);
      }
    }

    assert.equal(seenFiles.size, 42, `Expected 42 distinct /phrases/{en,fi,sv} audio files, got ${seenFiles.size}`);
  });

  test("verifies static CLI contract and WCAG 2.2 AA configuration in scripts/blindfold-a11y-audit.mjs", () => {
    const scriptSource = fs.readFileSync(AUDIT_SCRIPT_PATH, "utf8");

    assert.ok(scriptSource.includes("playwright") && scriptSource.includes("chromium"), "Audit script must launch Playwright chromium");
    assert.ok(scriptSource.includes("@axe-core/playwright"), "Audit script must use @axe-core/playwright");
    for (const flag of ["--json", "--out"]) {
      assert.ok(scriptSource.includes(flag), `Audit script must support CLI flag ${flag}`);
    }
    for (const wcagTag of ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]) {
      assert.ok(scriptSource.includes(`"${wcagTag}"`), `Audit script must enforce axe WCAG tag "${wcagTag}"`);
    }
    assert.ok(
      scriptSource.includes("PLAYWRIGHT_BROWSERS_PATH") && scriptSource.includes(SHARED_PLAYWRIGHT_DIR),
      "Audit script must check PLAYWRIGHT_BROWSERS_PATH and /tmp/fleet-root/shared/ms-playwright",
    );
    assert.ok(
      scriptSource.includes("GEMINI_API_KEY") && scriptSource.includes("ELEVENLABS_API_KEY"),
      "Audit script must enforce empty GEMINI_API_KEY and ELEVENLABS_API_KEY",
    );
  });

  test("validates docs/evidence/blindfold-a11y.json contract for 0 violations, Round 1 + Round 2, EN/FI/SV, 320x568 reflow, reduced-motion, forced-colors, and 0 mic/external requests", () => {
    assert.equal(fs.existsSync(EVIDENCE_JSON_PATH), true, "docs/evidence/blindfold-a11y.json must exist");
    const raw = fs.readFileSync(EVIDENCE_JSON_PATH, "utf8");
    assert.ok(raw.length > 200 && raw.length < 100 * 1024, `Expected compact evidence JSON (< 100 KB), got ${raw.length} bytes`);
    assert.equal(raw.includes(EM_DASH), false, "docs/evidence/blindfold-a11y.json must contain zero em dashes");
    assert.equal(raw.includes(EN_DASH), false, "docs/evidence/blindfold-a11y.json must contain zero en dashes");

    const report = JSON.parse(raw) as BlindfoldAuditReport;
    assertValidBlindfoldAuditReport(report);
  });

  test("executes headless Chromium + @axe-core/playwright audit on /blindfold and asserts 0 violations", (t) => {
    const fr8SharedExists = fs.existsSync(SHARED_PLAYWRIGHT_DIR);
    const hostHasChromium = detectHostChromium();

    if (fr8SharedExists) {
      assert.equal(
        hostHasChromium,
        true,
        "FR8 shared /tmp/fleet-root/shared/ms-playwright exists, so Chromium binary must be available and never skip",
      );
    } else if (!hostHasChromium) {
      t.skip("No Playwright Chromium binary found on host");
      return;
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "holdup-blindfold-axe-"));
    const tmpEvidencePath = path.join(tmpDir, "blindfold-a11y.json");

    try {
      const stdout = execFileSync(
        process.execPath,
        [AUDIT_SCRIPT_PATH, "--json", "--out", tmpEvidencePath],
        {
          cwd: REPO_DIR,
          encoding: "utf8",
          timeout: 90000,
          env: {
            ...process.env,
            GEMINI_API_KEY: "",
            ELEVENLABS_API_KEY: "",
            TMPDIR: os.tmpdir(),
            PLAYWRIGHT_BROWSERS_PATH:
              process.env.PLAYWRIGHT_BROWSERS_PATH || SHARED_PLAYWRIGHT_DIR,
          },
        },
      );

      const parsed = JSON.parse(stdout.trim()) as BlindfoldAuditReport;
      const summary: BlindfoldAuditSummary =
        parsed.summary && typeof parsed.summary === "object" && "ok" in parsed.summary
          ? parsed.summary
          : parsed;

      assert.equal(summary.ok, true, "Live Chromium audit summary.ok must be true");
      assert.equal(summary.totalViolationNodes, 0, "Live Chromium audit summary.totalViolationNodes must be 0");

      assert.equal(fs.existsSync(tmpEvidencePath), true, "Audit script must write JSON evidence to --out path");
      const writtenReport = JSON.parse(fs.readFileSync(tmpEvidencePath, "utf8")) as BlindfoldAuditReport;
      assertValidBlindfoldAuditReport(writtenReport);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    assert.equal(fs.existsSync(tmpDir), false, "Temporary audit directory must be removed in finally block");
  });
});
