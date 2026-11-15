import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { createRequire, register } from "node:module";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CoachCue, Field, LabelRead, Verdict, VerdictLevel } from "../../shared/types.ts";
import type {
  PixelSceneController,
  PixelSceneState,
  ScenePhase,
} from "../src/lib/pixelScene.ts";

const SELF_FILE = fileURLToPath(import.meta.url);
const TEST_DIR = path.dirname(SELF_FILE);
const WEB_DIR = path.resolve(TEST_DIR, "..");
const REPO_DIR = process.env.HOLDUP_TEST_REPO_DIR
  ? path.resolve(process.env.HOLDUP_TEST_REPO_DIR)
  : path.resolve(WEB_DIR, "..");

const SLASH = String.fromCharCode(47);
const SLASH2 = String.fromCharCode(47, 47);
const BLOCK_COMMENT_OPEN = String.fromCharCode(47, 42);
const BLOCK_COMMENT_CLOSE = String.fromCharCode(42, 47);
const HTML_COMMENT_OPEN = String.fromCharCode(60, 33, 45, 45);
const EM_DASH = String.fromCharCode(8212);
const EN_DASH = String.fromCharCode(8211);
const ESCAPED_EM_DASH = String.fromCharCode(92) + "u2014";
const ESCAPED_EN_DASH = String.fromCharCode(92) + "u2013";

const STYLES_CSS_PATH = path.join(REPO_DIR, "web", "src", "styles.css");
const BLINDFOLD_CSS_PATH = path.join(REPO_DIR, "web", "src", "screens", "blindfold.css");
const BLINDFOLD_TSX_PATH = path.join(REPO_DIR, "web", "src", "screens", "Blindfold.tsx");
const PIXEL_SCENE_TS_PATH = path.join(REPO_DIR, "web", "src", "lib", "pixelScene.ts");
const ICONS_TSX_PATH = path.join(REPO_DIR, "web", "src", "components", "Icons.tsx");
const COACH_TS_PATH = path.join(REPO_DIR, "web", "src", "lib", "blindfoldCoach.ts");
const SPOT_TS_PATH = path.join(REPO_DIR, "web", "src", "lib", "spotTheDanger.ts");
const SHARED_PLAYWRIGHT_DIR = [
  "",
  "tmp",
  "fleet-root",
  "shared",
  "ms-playwright",
].join(SLASH);

const CSS_LOADER_SOURCE = [
  "export async function load(url, context, nextLoad) {",
  '  if (url.endsWith(".css") || url.includes(".css?")) {',
  '    return { format: "module", shortCircuit: true, source: "export default {};" };',
  "  }",
  "  return nextLoad(url, context);",
  "}",
].join("\n");

register("data:text" + SLASH + "javascript," + encodeURIComponent(CSS_LOADER_SOURCE));

const req = createRequire(import.meta.url);
const reactCjs = req("react") as {
  useSyncExternalStore: <T>(
    subscribe: (onStoreChange: () => void) => () => void,
    getSnapshot: () => T,
    getServerSnapshot?: () => T,
  ) => T;
};
const origUseSyncExternalStore = reactCjs.useSyncExternalStore;
reactCjs.useSyncExternalStore = <T,>(
  subscribe: (onStoreChange: () => void) => () => void,
  getSnapshot: () => T,
  getServerSnapshot?: () => T,
): T => origUseSyncExternalStore(subscribe, getSnapshot, getServerSnapshot ?? getSnapshot);

const ReactMod = await import("react");
const React = ReactMod.default;
const { createElement } = ReactMod;
const { renderToStaticMarkup } = await import("react-dom" + SLASH + "server");

Object.defineProperty(globalThis, "React", {
  value: React,
  configurable: true,
  writable: true,
});

type BlindfoldLang = "en" | "fi" | "sv";
type JudgeChoice = "match" | "warning" | "unsure";

type BlindfoldViewPropsShape = {
  lang: BlindfoldLang;
  round: "blindfold" | "spot";
  blindfoldOn: boolean;
  srMode?: boolean;
  cameraState: "off" | "starting" | "on" | "denied";
  cameraProblem?: string;
  readiness: number;
  cue?: CoachCue | null;
  cueText?: string;
  lastSpoken?: string;
  verdict: Verdict | null;
  spotIndex: number;
  spotGuess: JudgeChoice | null;
  judgeScore: number;
  holdupScore: number;
  answeredCount: number;
  spotCards: ReadonlyArray<unknown>;
  activeClipId?: string | null;
};

type BlindfoldModuleShape = {
  HONESTY_BANNER_TEXT: string;
  BlindfoldView: (props: BlindfoldViewPropsShape) => React.ReactElement;
  initialBlindfoldViewProps: (
    overrides?: Partial<BlindfoldViewPropsShape>,
  ) => BlindfoldViewPropsShape;
};

type IconsModuleShape = {
  LEVEL_WORD: Record<VerdictLevel, string>;
  VerdictGlyph: (props: { level: VerdictLevel; size?: number }) => React.ReactElement;
};

type CoachModuleShape = {
  SIM_BOXES: ReadonlyArray<{
    id: string;
    label: Record<BlindfoldLang, string>;
    hint?: Record<BlindfoldLang, string>;
    expectedLevel?: VerdictLevel;
  }>;
  runSimulatedBox?: (id: string) => {
    verdict: Verdict;
    phraseId: string | null;
    coachingCues: CoachCue[];
  };
};

type SpotModuleShape = {
  SPOT_CARDS: ReadonlyArray<{
    id: string;
    round: number;
    title: Record<BlindfoldLang, string>;
    scenarioPrompt: Record<BlindfoldLang, string>;
    dangerSummary: Record<BlindfoldLang, string>;
    expectedLevel: VerdictLevel;
    read: LabelRead;
  }>;
};

type PixelSceneModuleShape = {
  mountPixelScene: (
    canvas: HTMLCanvasElement,
    initial: PixelSceneState,
  ) => PixelSceneController;
};

type PlaywrightPage = {
  route: (
    pattern: string,
    handler: (route: {
      request: () => { url: () => string };
      continue: () => Promise<void>;
      abort: () => Promise<void>;
    }) => Promise<void> | void,
  ) => Promise<void>;
  goto: (url: string, opts?: { waitUntil?: "domcontentloaded" | "load" }) => Promise<unknown>;
  addStyleTag: (opts: { content: string }) => Promise<unknown>;
  emulateMedia: (opts: {
    forcedColors?: "active" | "none" | null;
    reducedMotion?: "reduce" | "no-preference" | null;
    contrast?: "more" | "no-preference" | null;
  }) => Promise<void>;
  evaluate: <R>(expression: string) => Promise<R>;
  close: () => Promise<void>;
};

type PlaywrightContext = {
  newPage: () => Promise<PlaywrightPage>;
  close: () => Promise<void>;
};

type PlaywrightBrowser = {
  newContext: (opts: {
    viewport: { width: number; height: number };
    deviceScaleFactor?: number;
    isMobile?: boolean;
    hasTouch?: boolean;
  }) => Promise<PlaywrightContext>;
  close: () => Promise<void>;
};

type PlaywrightModule = {
  chromium: {
    launch: (opts: { headless: boolean }) => Promise<PlaywrightBrowser>;
  };
};

const ALL_LANGS: readonly BlindfoldLang[] = ["en", "fi", "sv"];
const VERDICT_LEVELS: readonly JudgeChoice[] = ["match", "warning", "unsure"];
const ALL_PHASES: readonly ScenePhase[] = [
  "idle",
  "coaching",
  "checking",
  "match",
  "warning",
  "unsure",
];

function stripBlockComments(css: string): string {
  let out = "";
  let idx = 0;
  while (idx < css.length) {
    const start = css.indexOf(BLOCK_COMMENT_OPEN, idx);
    if (start === -1) {
      out += css.slice(idx);
      break;
    }
    out += css.slice(idx, start);
    const end = css.indexOf(BLOCK_COMMENT_CLOSE, start + 2);
    if (end === -1) break;
    idx = end + 2;
  }
  return out;
}

function assertCleanAsciiHygiene(label: string, source: string): void {
  assert.ok(source.length > 100, `${label} must be non-empty`);
  assert.equal(source.includes(SLASH2), false, `${label} must contain zero line comments or double slashes`);
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

function extractBlock(css: string, header: RegExp): string {
  const match = header.exec(css);
  assert.ok(match, `Expected CSS block matching ${String(header)}`);
  const openIdx = css.indexOf("{", match.index);
  assert.ok(openIdx >= 0, `Expected opening brace for ${String(header)}`);
  let depth = 0;
  for (let i = openIdx; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(openIdx + 1, i);
    }
  }
  assert.fail(`Unclosed CSS block for ${String(header)}`);
}

function extractAllMediaBlocks(css: string, mediaPattern: RegExp): string[] {
  const blocks: string[] = [];
  const flags = mediaPattern.flags.includes("g") ? mediaPattern.flags : mediaPattern.flags + "g";
  const globalRe = new RegExp(mediaPattern.source, flags);
  let match: RegExpExecArray | null;
  while ((match = globalRe.exec(css)) !== null) {
    const openIdx = css.indexOf("{", match.index);
    if (openIdx < 0) break;
    let depth = 0;
    let endIdx = openIdx;
    for (; endIdx < css.length; endIdx++) {
      if (css[endIdx] === "{") depth++;
      else if (css[endIdx] === "}") {
        depth--;
        if (depth === 0) {
          blocks.push(css.slice(openIdx + 1, endIdx));
          break;
        }
      }
    }
    globalRe.lastIndex = endIdx + 1;
  }
  return blocks;
}

type CssRule = {
  selectors: string[];
  declarations: Record<string, string>;
  rawBody: string;
  order: number;
};

function parseDeclarations(body: string): Record<string, string> {
  const decls: Record<string, string> = {};
  const chunks = body.split(";");
  for (const chunk of chunks) {
    const colonIdx = chunk.indexOf(":");
    if (colonIdx <= 0) continue;
    const prop = chunk.slice(0, colonIdx).trim().toLowerCase();
    const val = chunk
      .slice(colonIdx + 1)
      .replace(new RegExp("!important", "gi"), "")
      .trim();
    if (!prop || !val) continue;
    decls[prop] = val;
    if (prop === "border") {
      const tokens = val.split(new RegExp("\\s+")).filter(Boolean);
      for (const tok of tokens) {
        if (new RegExp("^[0-9.]+(px|rem|em|cqw)$", "i").test(tok)) {
          decls["border-width"] = tok;
        } else if (
          new RegExp("^(solid|dashed|double|dotted|none)$", "i").test(tok)
        ) {
          decls["border-style"] = tok.toLowerCase();
        } else {
          decls["border-color"] = tok;
        }
      }
    }
  }
  return decls;
}

function parseCssRules(css: string, startOrder = 0): CssRule[] {
  const rules: CssRule[] = [];
  let i = 0;
  let order = startOrder;
  while (i < css.length) {
    while (i < css.length && new RegExp("\\s").test(css[i])) i++;
    if (i >= css.length) break;
    const open = css.indexOf("{", i);
    const semi = css.indexOf(";", i);
    if (semi !== -1 && (open === -1 || semi < open)) {
      i = semi + 1;
      continue;
    }
    if (open === -1) break;
    const rawHeader = css.slice(i, open).trim();
    let depth = 0;
    let close = open;
    for (; close < css.length; close++) {
      if (css[close] === "{") depth++;
      else if (css[close] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    const body = css.slice(open + 1, close);
    if (!rawHeader.startsWith("@")) {
      const selectors = rawHeader
        .split(",")
        .map((s) => s.trim().replace(new RegExp("\\s+", "g"), " "))
        .filter(Boolean);
      rules.push({
        selectors,
        declarations: parseDeclarations(body),
        rawBody: body,
        order: order++,
      });
    }
    i = close + 1;
  }
  return rules;
}

function parseCustomProperties(block: string): Record<string, string> {
  const vars: Record<string, string> = {};
  const propPattern = new RegExp("--([a-z0-9-]+)\\s*:\\s*([^;]+);", "gi");
  let match: RegExpExecArray | null;
  while ((match = propPattern.exec(block)) !== null) {
    vars[`--${match[1]}`] = match[2].trim();
  }
  return vars;
}

function resolveCssColor(rawValue: string, tokens: Record<string, string>): string {
  let val = rawValue.trim();
  const varPattern = new RegExp("var\\(\\s*(--[a-z0-9-]+)(?:\\s*,\\s*([^)]+))?\\s*\\)", "i");
  for (let guard = 0; guard < 6; guard++) {
    const m = varPattern.exec(val);
    if (!m) break;
    const replacement = tokens[m[1]] ?? m[2]?.trim() ?? "";
    assert.ok(replacement.length > 0, `Unresolved CSS variable ${m[1]} in "${rawValue}"`);
    val = (val.slice(0, m.index) + replacement + val.slice(m.index + m[0].length)).trim();
  }
  return val;
}

function hexToRgb(hex: string): [number, number, number] {
  const trimmed = hex.trim().replace(new RegExp("^#"), "");
  if (trimmed.length === 3) {
    return [
      Number.parseInt(trimmed[0] + trimmed[0], 16),
      Number.parseInt(trimmed[1] + trimmed[1], 16),
      Number.parseInt(trimmed[2] + trimmed[2], 16),
    ];
  }
  assert.equal(trimmed.length, 6, `Expected 3-digit or 6-digit hex color, got "${hex}"`);
  return [
    Number.parseInt(trimmed.slice(0, 2), 16),
    Number.parseInt(trimmed.slice(2, 4), 16),
    Number.parseInt(trimmed.slice(4, 6), 16),
  ];
}

const SRGB_LINEAR_LUT = new Float64Array(256);
for (let c = 0; c < 256; c++) {
  const srgb = c / 255;
  SRGB_LINEAR_LUT[c] = srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

function rgbToRelativeLuminance(r8: number, g8: number, b8: number): number {
  return (
    0.2126 * SRGB_LINEAR_LUT[r8 & 255] +
    0.7152 * SRGB_LINEAR_LUT[g8 & 255] +
    0.0722 * SRGB_LINEAR_LUT[b8 & 255]
  );
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return rgbToRelativeLuminance(r, g, b);
}

function contrastRatio(fgHex: string, bgHex: string): number {
  const l1 = relativeLuminance(fgHex);
  const l2 = relativeLuminance(bgHex);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

type ElementQuery = {
  tag?: string;
  classes: string[];
  attrs?: Record<string, string>;
};

function matchSimpleCompoundSelector(sel: string, query: ElementQuery): number | null {
  if (sel.includes(" ") || sel.includes(">") || sel.includes("+") || sel.includes("~")) {
    return null;
  }
  if (sel.includes(":hover") || sel.includes(":active") || sel.includes(":disabled") || sel.includes(":focus")) {
    return null;
  }

  let working = sel.trim();
  let specificity = 0;

  const notMatch = new RegExp(":not\\(\\.([a-zA-Z0-9_-]+)\\)").exec(working);
  if (notMatch) {
    if (query.classes.includes(notMatch[1])) return null;
    specificity += 10;
    working = working.replace(notMatch[0], "");
  }
  if (working.includes(":")) return null;

  const attrPattern = new RegExp("\\[([a-zA-Z0-9_-]+)=[\"']?([^\\]\"']+)[\"']?\\]", "g");
  let attrMatch: RegExpExecArray | null;
  while ((attrMatch = attrPattern.exec(working)) !== null) {
    const k = attrMatch[1];
    const v = attrMatch[2];
    if ((query.attrs?.[k] ?? "") !== v) return null;
    specificity += 10;
  }
  working = working.replace(attrPattern, "");

  const classPattern = new RegExp("\\.([a-zA-Z0-9_-]+)", "g");
  let clsMatch: RegExpExecArray | null;
  while ((clsMatch = classPattern.exec(working)) !== null) {
    if (!query.classes.includes(clsMatch[1])) return null;
    specificity += 10;
  }
  working = working.replace(classPattern, "").trim();

  if (working.length > 0) {
    if (!query.tag || working.toLowerCase() !== query.tag.toLowerCase()) return null;
    specificity += 1;
  }

  return specificity;
}

function cascadeElementDeclarations(
  rules: CssRule[],
  query: ElementQuery,
): Record<string, string> {
  const bestPropSpec = new Map<string, { spec: number; order: number; val: string }>();
  for (const rule of rules) {
    let maxSpecForRule: number | null = null;
    for (const sel of rule.selectors) {
      const spec = matchSimpleCompoundSelector(sel, query);
      if (spec !== null && (maxSpecForRule === null || spec > maxSpecForRule)) {
        maxSpecForRule = spec;
      }
    }
    if (maxSpecForRule === null) continue;
    for (const [prop, val] of Object.entries(rule.declarations)) {
      const prev = bestPropSpec.get(prop);
      if (
        !prev ||
        maxSpecForRule > prev.spec ||
        (maxSpecForRule === prev.spec && rule.order >= prev.order)
      ) {
        bestPropSpec.set(prop, { spec: maxSpecForRule, order: rule.order, val });
      }
    }
  }
  const resolved: Record<string, string> = {};
  for (const [prop, rec] of bestPropSpec.entries()) {
    resolved[prop] = rec.val;
  }
  return resolved;
}

function selectorDeclares(
  rules: CssRule[],
  targetSelector: string,
  declRe: RegExp,
): boolean {
  const norm = targetSelector.trim().replace(new RegExp("\\s+", "g"), " ");
  return rules.some((r) => r.selectors.includes(norm) && declRe.test(r.rawBody));
}

function makeSampleVerdict(level: JudgeChoice): Verdict {
  const emptyField = <T,>(value: T | null, confidence: number): Field<T> => ({
    value,
    confidence,
  });
  const sampleRead: LabelRead = {
    kind: "medication",
    product: emptyField("Amlodipine Orion", 0.98),
    ingredient: emptyField("amlodipine", 0.98),
    strength: emptyField(level === "unsure" ? "5 mg" : "5 mg", level === "unsure" ? 0.42 : 0.98),
    dosing: emptyField("1 tablet in the evening", 0.92),
    expiry: emptyField("2027-08", 0.95),
    allergens: emptyField<string[]>(null, 0),
    barcode: emptyField<string>(null, 0),
    readability: level === "unsure" ? 0.62 : 0.95,
  };
  if (level === "match") {
    return {
      level: "match",
      headline: "Yes, Amlodipine 5 mg",
      speech: "Yes, Amlodipine 5 mg, your evening pill.",
      matchedMedId: "amlodipine",
      takenToday: false,
      reasons: ["Matches saved evening prescription"],
      read: sampleRead,
    };
  }
  if (level === "warning") {
    return {
      level: "warning",
      headline: "Warning: Ibuprofen 400 mg",
      speech: "Warning: Ibuprofen 400 mg is on your avoid NSAIDs list.",
      reasons: ["Avoid rule triggered: NSAIDs"],
      read: sampleRead,
    };
  }
  return {
    level: "unsure",
    headline: "Not sure - strength unclear",
    speech: "I am not sure. I will not guess a dose.",
    reasons: ["Strength confidence below 80% gate"],
    read: sampleRead,
  };
}

function hasChromiumInRoot(cacheRoot: string): boolean {
  if (!cacheRoot || !fs.existsSync(cacheRoot)) return false;
  let entries: string[];
  try {
    entries = fs.readdirSync(cacheRoot);
  } catch {
    return false;
  }

  const candidates = [
    ["chrome-linux", "chrome"],
    ["chrome-linux64", "chrome"],
    ["chrome-linux", "headless_shell"],
    ["chrome-linux64", "chrome-headless-shell"],
    [
      "chrome-mac-arm64",
      "Google Chrome for Testing.app",
      "Contents",
      "MacOS",
      "Google Chrome for Testing",
    ],
    [
      "chrome-mac-x64",
      "Google Chrome for Testing.app",
      "Contents",
      "MacOS",
      "Google Chrome for Testing",
    ],
    ["chrome-mac-arm64", "Chromium.app", "Contents", "MacOS", "Chromium"],
    ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"],
  ];

  for (const dir of entries) {
    if (!dir.startsWith("chromium-") && !dir.startsWith("chromium_headless_shell-")) continue;
    for (const rel of candidates) {
      if (fs.existsSync(path.join(cacheRoot, dir, ...rel))) return true;
    }
  }
  return false;
}

function detectHostChromium(): boolean {
  const explicit = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  if (explicit) return fs.existsSync(explicit);

  const customBrowsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (customBrowsersPath) {
    return hasChromiumInRoot(customBrowsersPath);
  }

  const roots = [
    SHARED_PLAYWRIGHT_DIR,
    path.join(os.homedir(), ".cache", "ms-playwright"),
    path.join(os.homedir(), "Library", "Caches", "ms-playwright"),
  ];

  return roots.some((r) => hasChromiumInRoot(r));
}

function createRasterCanvas(width: number, height: number) {
  const pixels = new Uint8Array(width * height * 4);
  const attrs = new Map<string, string>();
  const scaleStack: Array<[number, number]> = [];
  let sx = 1;
  let sy = 1;
  let fillStyle = "#000000";
  let drawCalls = 0;

  const ctx = {
    imageSmoothingEnabled: true,
    get fillStyle() {
      return fillStyle;
    },
    set fillStyle(val: string) {
      fillStyle = String(val);
    },
    save() {
      scaleStack.push([sx, sy]);
    },
    restore() {
      const popped = scaleStack.pop();
      if (popped) {
        sx = popped[0];
        sy = popped[1];
      }
    },
    scale(nx: number, ny: number) {
      sx *= nx;
      sy *= ny;
    },
    clearRect(x: number, y: number, w: number, h: number) {
      drawCalls++;
      const x0 = Math.max(0, Math.floor(x * sx));
      const y0 = Math.max(0, Math.floor(y * sy));
      const x1 = Math.min(width, Math.ceil((x + w) * sx));
      const y1 = Math.min(height, Math.ceil((y + h) * sy));
      for (let py = y0; py < y1; py++) {
        for (let px = x0; px < x1; px++) {
          const off = (py * width + px) * 4;
          pixels[off] = 0;
          pixels[off + 1] = 0;
          pixels[off + 2] = 0;
          pixels[off + 3] = 0;
        }
      }
    },
    fillRect(x: number, y: number, w: number, h: number) {
      drawCalls++;
      if (!fillStyle.startsWith("#")) return;
      const [r, g, b] = hexToRgb(fillStyle);
      const x0 = Math.max(0, Math.floor(x * sx));
      const y0 = Math.max(0, Math.floor(y * sy));
      const x1 = Math.min(width, Math.ceil((x + w) * sx));
      const y1 = Math.min(height, Math.ceil((y + h) * sy));
      for (let py = y0; py < y1; py++) {
        for (let px = x0; px < x1; px++) {
          const off = (py * width + px) * 4;
          pixels[off] = r;
          pixels[off + 1] = g;
          pixels[off + 2] = b;
          pixels[off + 3] = 255;
        }
      }
    },
  };

  const canvas = {
    width,
    height,
    style: {} as Record<string, string>,
    getContext(kind: string) {
      return kind === "2d" ? ctx : null;
    },
    setAttribute(name: string, value: string) {
      attrs.set(name, String(value));
    },
    getAttribute(name: string): string | null {
      return attrs.get(name) ?? null;
    },
  };

  return {
    canvas: canvas as unknown as HTMLCanvasElement,
    ctx,
    pixels,
    attrs,
    getDrawCalls: () => drawCalls,
    snapshotLuminance(): Float32Array {
      const total = width * height;
      const luma = new Float32Array(total);
      for (let i = 0; i < total; i++) {
        const off = i * 4;
        luma[i] = rgbToRelativeLuminance(pixels[off], pixels[off + 1], pixels[off + 2]);
      }
      return luma;
    },
  };
}

function installSceneBrowserMock(initialReducedMotion = false, initialHighContrast = false) {
  const globalKeys = [
    "window",
    "document",
    "Image",
    "requestAnimationFrame",
    "cancelAnimationFrame",
  ] as const;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const k of globalKeys) {
    saved.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
  }

  let reducedMatches = initialReducedMotion;
  let hcMatches = initialHighContrast;
  const reducedListeners = new Set<() => void>();
  const hcListeners = new Set<() => void>();

  let nextRafId = 1;
  const pendingRaf = new Map<number, (ts: number) => void>();

  const requestAnimationFrameMock = (cb: (ts: number) => void): number => {
    const id = nextRafId++;
    pendingRaf.set(id, cb);
    return id;
  };
  const cancelAnimationFrameMock = (id: number): void => {
    pendingRaf.delete(id);
  };

  class PendingSpriteImage {
    src = "";
    complete = false;
    naturalWidth = 0;
    naturalHeight = 0;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
  }

  const docMock = {
    hidden: false,
    visibilityState: "visible",
    documentElement: { lang: "en" },
    addEventListener() {},
    removeEventListener() {},
  };

  const winMock = {
    requestAnimationFrame: requestAnimationFrameMock,
    cancelAnimationFrame: cancelAnimationFrameMock,
    matchMedia(query: string) {
      const isReduced = query.includes("prefers-reduced-motion");
      const isHc = query.includes("prefers-contrast");
      return {
        media: query,
        get matches() {
          return isReduced ? reducedMatches : isHc ? hcMatches : false;
        },
        addEventListener(_ev: string, fn: () => void) {
          if (isReduced) reducedListeners.add(fn);
          if (isHc) hcListeners.add(fn);
        },
        removeEventListener(_ev: string, fn: () => void) {
          if (isReduced) reducedListeners.delete(fn);
          if (isHc) hcListeners.delete(fn);
        },
      };
    },
    addEventListener() {},
    removeEventListener() {},
  };

  Object.defineProperty(globalThis, "requestAnimationFrame", {
    value: requestAnimationFrameMock,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", {
    value: cancelAnimationFrameMock,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "Image", {
    value: PendingSpriteImage,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "document", {
    value: docMock,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "window", {
    value: winMock,
    configurable: true,
    writable: true,
  });

  return {
    pendingRaf,
    stepRaf(tsMs: number): number {
      const entries = Array.from(pendingRaf.entries());
      pendingRaf.clear();
      for (const [, cb] of entries) {
        cb(tsMs);
      }
      return entries.length;
    },
    setReducedMotionMedia(next: boolean): void {
      reducedMatches = next;
      for (const fn of Array.from(reducedListeners)) fn();
    },
    restore(): void {
      for (const [k, desc] of saved.entries()) {
        if (desc) Object.defineProperty(globalThis, k, desc);
        else Reflect.deleteProperty(globalThis, k);
      }
    },
  };
}

describe("/blindfold Low-Vision Contrast, WCAG 1.4.10/1.4.12 Reflow, 2.4.11 Focus, and Pixel Scene A11y", () => {
  test("1. enforces strict self-hygiene: zero comments, zero em/en dashes, and pure ASCII", () => {
    const selfSource = fs.readFileSync(SELF_FILE, "utf8");
    assertCleanAsciiHygiene("web/test/blindfoldLowVisionAndContrastA11y.test.ts", selfSource);

    for (const [label, filePath] of [
      ["web/src/screens/Blindfold.tsx", BLINDFOLD_TSX_PATH],
      ["web/src/screens/blindfold.css", BLINDFOLD_CSS_PATH],
    ] as const) {
      assert.equal(fs.existsSync(filePath), true, `${label} must exist at ${filePath}`);
      assertCleanAsciiHygiene(label, fs.readFileSync(filePath, "utf8"));
    }

    assert.equal(fs.existsSync(PIXEL_SCENE_TS_PATH), true, "pixelScene.ts must exist");
    const pixelSceneSrc = fs.readFileSync(PIXEL_SCENE_TS_PATH, "utf8");
    assert.equal(pixelSceneSrc.includes(SLASH2), false, "pixelScene.ts must contain zero line comments");
    assert.equal(pixelSceneSrc.includes(BLOCK_COMMENT_OPEN), false, "pixelScene.ts must contain zero block comments");
    assert.equal(pixelSceneSrc.includes(BLOCK_COMMENT_CLOSE), false, "pixelScene.ts must contain zero block comment closers");
    assert.equal(pixelSceneSrc.includes(HTML_COMMENT_OPEN), false, "pixelScene.ts must contain zero HTML comments");
    assert.equal(pixelSceneSrc.includes(EM_DASH), false, "pixelScene.ts must contain zero literal em dashes");
    assert.equal(pixelSceneSrc.includes(EN_DASH), false, "pixelScene.ts must contain zero literal en dashes");
  });

  test("2a. proves deterministic WCAG 2.2 AA/AAA relative luminance and 1.4.11 non-text contrast across default dark mode and @media (prefers-contrast: more)", () => {
    const cleanStyles = stripBlockComments(fs.readFileSync(STYLES_CSS_PATH, "utf8"));
    const cleanBlindfold = stripBlockComments(fs.readFileSync(BLINDFOLD_CSS_PATH, "utf8"));

    const rootTokens = parseCustomProperties(
      extractBlock(cleanStyles, new RegExp("(?:^|\\n):root\\s*\\{")),
    );
    const stylesHcBlock = extractBlock(
      cleanStyles,
      new RegExp("@media\\s*\\(\\s*prefers-contrast\\s*:\\s*more\\s*\\)\\s*\\{"),
    );
    const hcTokens: Record<string, string> = {
      ...rootTokens,
      ...parseCustomProperties(extractBlock(stylesHcBlock, new RegExp(":root\\s*\\{"))),
    };

    const baseRules = parseCssRules(cleanBlindfold, 0);
    const blindfoldHcBlocks = extractAllMediaBlocks(
      cleanBlindfold,
      new RegExp("@media\\s*\\(\\s*prefers-contrast\\s*:\\s*more\\s*\\)"),
    );
    assert.ok(blindfoldHcBlocks.length >= 1, "blindfold.css must define @media (prefers-contrast: more)");
    const hcMediaRules = blindfoldHcBlocks.flatMap((blk, idx) =>
      parseCssRules(blk, 10_000 + idx * 1_000),
    );
    const hcRules = [...baseRules, ...hcMediaRules];

    for (const mode of [
      { name: "default-dark", tokens: rootTokens, rules: baseRules },
      { name: "prefers-contrast-more", tokens: hcTokens, rules: hcRules },
    ] as const) {
      const { tokens, rules } = mode;
      const pageDecls = cascadeElementDeclarations(rules, { classes: ["bf-page"] });
      const pageBg = resolveCssColor(pageDecls["background"] ?? "var(--bg)", tokens);
      const pageText = resolveCssColor(pageDecls["color"] ?? "var(--text)", tokens);

      for (const surfaceVar of ["--bg", "--surface", "--surface-2"] as const) {
        const bgHex = resolveCssColor(`var(${surfaceVar})`, tokens);
        const primaryRatio = contrastRatio(resolveCssColor("var(--text)", tokens), bgHex);
        assert.ok(
          primaryRatio >= 7.0,
          `[${mode.name}] primary --text on ${surfaceVar} (${bgHex}) must be >= 7.0:1 AAA, got ${primaryRatio.toFixed(2)}:1`,
        );

        const mutedRatio = contrastRatio(resolveCssColor("var(--muted)", tokens), bgHex);
        assert.ok(
          mutedRatio >= 4.5,
          `[${mode.name}] muted --muted on ${surfaceVar} (${bgHex}) must be >= 4.5:1 AA, got ${mutedRatio.toFixed(2)}:1`,
        );
      }

      const pageTextRatio = contrastRatio(pageText, pageBg);
      assert.ok(
        pageTextRatio >= 7.0,
        `[${mode.name}] .bf-page text (${pageText}) on (${pageBg}) must be >= 7.0:1 AAA, got ${pageTextRatio.toFixed(2)}:1`,
      );

      const bannerDecls = cascadeElementDeclarations(rules, { classes: ["bf-honesty-banner"] });
      const bannerBg = resolveCssColor(bannerDecls["background"] ?? pageBg, tokens);
      const bannerFg = resolveCssColor(bannerDecls["color"] ?? pageText, tokens);
      const bannerBorder = resolveCssColor(bannerDecls["border-color"] ?? "var(--accent)", tokens);
      const bannerTextRatio = contrastRatio(bannerFg, bannerBg);
      assert.ok(
        bannerTextRatio >= 7.0,
        `[${mode.name}] .bf-honesty-banner text (${bannerFg}) on (${bannerBg}) must be >= 7.0:1 AAA, got ${bannerTextRatio.toFixed(2)}:1`,
      );
      const bannerBorderVsPage = contrastRatio(bannerBorder, pageBg);
      const bannerBorderVsInner = contrastRatio(bannerBorder, bannerBg);
      assert.ok(
        bannerBorderVsPage >= 3.0 && bannerBorderVsInner >= 3.0,
        `[${mode.name}] .bf-honesty-banner border (${bannerBorder}) must be >= 3.0:1 vs page (${bannerBorderVsPage.toFixed(2)}:1) and inner (${bannerBorderVsInner.toFixed(2)}:1)`,
      );

      const badgeDecls = cascadeElementDeclarations(rules, { classes: ["bf-honesty-badge"] });
      const badgeBg = resolveCssColor(badgeDecls["background"] ?? "var(--accent)", tokens);
      const badgeFg = resolveCssColor(badgeDecls["color"] ?? "var(--on-accent)", tokens);
      const badgeRatio = contrastRatio(badgeFg, badgeBg);
      assert.ok(
        badgeRatio >= 7.0,
        `[${mode.name}] .bf-honesty-badge text (${badgeFg}) on (${badgeBg}) must be >= 7.0:1 AAA, got ${badgeRatio.toFixed(2)}:1`,
      );

      const spotCardDecls = cascadeElementDeclarations(rules, { classes: ["bf-spot-card"] });
      const spotCardBg = resolveCssColor(spotCardDecls["background"] ?? "var(--surface)", tokens);

      for (const level of VERDICT_LEVELS) {
        const vBoxDecls = cascadeElementDeclarations(rules, {
          classes: ["bf-verdict-box", level],
        });
        const vBoxBg = resolveCssColor(vBoxDecls["background"] ?? "var(--surface)", tokens);
        const vBoxFg = resolveCssColor(vBoxDecls["color"] ?? "var(--text)", tokens);
        const vBoxBorder = resolveCssColor(vBoxDecls["border-color"] ?? `var(--${level})`, tokens);

        const vBoxTextRatio = contrastRatio(vBoxFg, vBoxBg);
        assert.ok(
          vBoxTextRatio >= 4.5,
          `[${mode.name}] .bf-verdict-box.${level} text (${vBoxFg}) on (${vBoxBg}) must be >= 4.5:1 AA, got ${vBoxTextRatio.toFixed(2)}:1`,
        );

        const vBoxBorderOuter = contrastRatio(vBoxBorder, pageBg);
        const vBoxBorderInner = contrastRatio(vBoxBorder, vBoxBg);
        assert.ok(
          vBoxBorderOuter >= 3.0 && vBoxBorderInner >= 3.0,
          `[${mode.name}] .bf-verdict-box.${level} border (${vBoxBorder}) must be >= 3.0:1 (WCAG 1.4.11), got outer=${vBoxBorderOuter.toFixed(2)}:1 inner=${vBoxBorderInner.toFixed(2)}:1`,
        );

        const pillDecls = cascadeElementDeclarations(rules, {
          classes: ["bf-level-pill", level],
        });
        const pillBg = resolveCssColor(pillDecls["background"] ?? `var(--${level})`, tokens);
        const pillFg = resolveCssColor(pillDecls["color"] ?? "var(--on-accent)", tokens);
        const pillRatio = contrastRatio(pillFg, pillBg);
        assert.ok(
          pillRatio >= 4.5,
          `[${mode.name}] .bf-level-pill.${level} text (${pillFg}) on (${pillBg}) must be >= 4.5:1 AA, got ${pillRatio.toFixed(2)}:1`,
        );

        const choiceUnpressed = cascadeElementDeclarations(rules, {
          tag: "button",
          classes: ["bf-choice-btn", level],
          attrs: { "aria-pressed": "false" },
        });
        const choiceBg = resolveCssColor(choiceUnpressed["background"] ?? "var(--surface-2)", tokens);
        const choiceFg = resolveCssColor(choiceUnpressed["color"] ?? "var(--text)", tokens);
        const choiceBorder = resolveCssColor(choiceUnpressed["border-color"] ?? `var(--${level})`, tokens);

        const choiceTextRatio = contrastRatio(choiceFg, choiceBg);
        assert.ok(
          choiceTextRatio >= 4.5,
          `[${mode.name}] .bf-choice-btn.${level} text (${choiceFg}) on (${choiceBg}) must be >= 4.5:1 AA, got ${choiceTextRatio.toFixed(2)}:1`,
        );
        const choiceBorderOuter = contrastRatio(choiceBorder, spotCardBg);
        const choiceBorderInner = contrastRatio(choiceBorder, choiceBg);
        assert.ok(
          choiceBorderOuter >= 3.0 && choiceBorderInner >= 3.0,
          `[${mode.name}] .bf-choice-btn.${level} border (${choiceBorder}) must be >= 3.0:1 (WCAG 1.4.11), got outer=${choiceBorderOuter.toFixed(2)}:1 inner=${choiceBorderInner.toFixed(2)}:1`,
        );

        const choicePressed = cascadeElementDeclarations(rules, {
          tag: "button",
          classes: ["bf-choice-btn", level],
          attrs: { "aria-pressed": "true" },
        });
        const pressedBg = resolveCssColor(choicePressed["background"] ?? `var(--${level})`, tokens);
        const pressedFg = resolveCssColor(choicePressed["color"] ?? "var(--on-accent)", tokens);
        const pressedBorder = resolveCssColor(choicePressed["border-color"] ?? pressedBg, tokens);
        const pressedTextRatio = contrastRatio(pressedFg, pressedBg);
        const pressedBorderOuter = contrastRatio(pressedBorder, spotCardBg);
        assert.ok(
          pressedTextRatio >= 4.5,
          `[${mode.name}] .bf-choice-btn.${level}[aria-pressed="true"] text (${pressedFg}) on (${pressedBg}) must be >= 4.5:1 AA, got ${pressedTextRatio.toFixed(2)}:1`,
        );
        assert.ok(
          pressedBorderOuter >= 3.0,
          `[${mode.name}] .bf-choice-btn.${level}[aria-pressed="true"] border (${pressedBorder}) vs card (${spotCardBg}) must be >= 3.0:1, got ${pressedBorderOuter.toFixed(2)}:1`,
        );
      }
    }

    assert.equal(contrastRatio(hcTokens["--text"], hcTokens["--bg"]), 21);
  });

  test("2b. proves WCAG 1.4.1 non-color differentiation: verdicts render distinct VerdictGlyph SVG shapes and LEVEL_WORD text pills (Match / Warning / Not sure)", async () => {
    const iconsMod = (await import(pathToFileURL(ICONS_TSX_PATH).href)) as IconsModuleShape;
    const bfMod = (await import(pathToFileURL(BLINDFOLD_TSX_PATH).href)) as BlindfoldModuleShape;
    const spotMod = (await import(pathToFileURL(SPOT_TS_PATH).href)) as SpotModuleShape;
    const cleanBlindfold = stripBlockComments(fs.readFileSync(BLINDFOLD_CSS_PATH, "utf8"));
    const rules = parseCssRules(cleanBlindfold);

    assert.equal(iconsMod.LEVEL_WORD.match, "Match");
    assert.equal(iconsMod.LEVEL_WORD.warning, "Warning");
    assert.equal(iconsMod.LEVEL_WORD.unsure, "Not sure");

    const glyphSvgs = new Map<JudgeChoice, string>();
    for (const level of VERDICT_LEVELS) {
      const svgHtml = renderToStaticMarkup(
        createElement(iconsMod.VerdictGlyph, { level, size: 56 }),
      );
      assert.ok(svgHtml.startsWith("<svg"), `VerdictGlyph(${level}) must render an <svg>`);
      assert.ok(svgHtml.includes('aria-hidden="true"'), `VerdictGlyph(${level}) must be aria-hidden="true"`);
      glyphSvgs.set(level, svgHtml);

      const r1Html = renderToStaticMarkup(
        createElement(
          bfMod.BlindfoldView,
          bfMod.initialBlindfoldViewProps({
            round: "blindfold",
            verdict: makeSampleVerdict(level),
          }),
        ),
      );
      assert.ok(
        r1Html.includes(`class="bf-verdict-box ${level}"`),
        `Round 1 must render .bf-verdict-box.${level}`,
      );
      assert.ok(
        r1Html.includes(`class="bf-verdict-glyph ${level}"`) && r1Html.includes("<svg"),
        `Round 1 ${level} verdict must include <VerdictGlyph /> SVG icon`,
      );
      assert.ok(
        r1Html.includes(`<span class="bf-level-pill ${level}">${iconsMod.LEVEL_WORD[level]}</span>`),
        `Round 1 ${level} verdict must render LEVEL_WORD pill "${iconsMod.LEVEL_WORD[level]}"`,
      );
    }

    assert.notEqual(glyphSvgs.get("match"), glyphSvgs.get("warning"));
    assert.notEqual(glyphSvgs.get("warning"), glyphSvgs.get("unsure"));
    assert.notEqual(glyphSvgs.get("match"), glyphSvgs.get("unsure"));
    assert.ok(glyphSvgs.get("match")?.includes("<circle"));
    assert.ok(glyphSvgs.get("warning")?.includes("M36 5l33 60H3z"));
    assert.ok(glyphSvgs.get("unsure")?.includes("M36 3l33 33-33 33L3 36z"));

    const expectedLevelCardIdx: Record<JudgeChoice, number> = {
      match: spotMod.SPOT_CARDS.findIndex((c) => c.expectedLevel === "match"),
      warning: spotMod.SPOT_CARDS.findIndex((c) => c.expectedLevel === "warning"),
      unsure: spotMod.SPOT_CARDS.findIndex((c) => c.expectedLevel === "unsure"),
    };
    for (const level of VERDICT_LEVELS) {
      const idx = expectedLevelCardIdx[level];
      assert.ok(idx >= 0, `SPOT_CARDS must include at least one "${level}" card`);
      const r2Html = renderToStaticMarkup(
        createElement(
          bfMod.BlindfoldView,
          bfMod.initialBlindfoldViewProps({
            round: "spot",
            spotIndex: idx,
            spotGuess: level,
            answeredCount: 1,
            judgeScore: 1,
            holdupScore: 1,
          }),
        ),
      );
      assert.ok(
        r2Html.includes(`class="bf-verdict-glyph ${level}"`) && r2Html.includes("<svg"),
        `Round 2 ${level} reveal must include <VerdictGlyph /> SVG`,
      );
      assert.ok(
        r2Html.includes(`class="bf-level-pill ${level}">${iconsMod.LEVEL_WORD[level]} - `),
        `Round 2 ${level} reveal must include LEVEL_WORD "${iconsMod.LEVEL_WORD[level]}"`,
      );
    }

    assert.equal(
      selectorDeclares(rules, ".bf-verdict-box.warning", new RegExp("border-style\\s*:\\s*double")),
      true,
      ".bf-verdict-box.warning must use double border stroke",
    );
    assert.equal(
      selectorDeclares(rules, ".bf-verdict-box.unsure", new RegExp("border-style\\s*:\\s*dashed")),
      true,
      ".bf-verdict-box.unsure must use dashed border stroke",
    );
    assert.equal(
      selectorDeclares(rules, ".bf-choice-btn.warning", new RegExp("border-style\\s*:\\s*double")),
      true,
      ".bf-choice-btn.warning must use double border stroke",
    );
    assert.equal(
      selectorDeclares(rules, ".bf-choice-btn.unsure", new RegExp("border-style\\s*:\\s*dashed")),
      true,
      ".bf-choice-btn.unsure must use dashed border stroke",
    );
  });

  test("3a. verifies WCAG 2.4.11 zero sticky/fixed occlusion, responsive 1fr collapse, and overflow-wrap/word-break guards for Nordic compound words", async () => {
    const cleanBlindfold = stripBlockComments(fs.readFileSync(BLINDFOLD_CSS_PATH, "utf8"));
    const bfMod = (await import(pathToFileURL(BLINDFOLD_TSX_PATH).href)) as BlindfoldModuleShape;

    assert.doesNotMatch(
      cleanBlindfold,
      new RegExp("position\\s*:\\s*(sticky|fixed)\\b", "i"),
      "blindfold.css must contain zero position: sticky or position: fixed rules (WCAG 2.4.11)",
    );

    const allMediaBlocks = extractAllMediaBlocks(cleanBlindfold, new RegExp("@media\\s*[^{]+"));
    const allRules = [
      ...parseCssRules(cleanBlindfold, 0),
      ...allMediaBlocks.flatMap((b, idx) => parseCssRules(b, 5_000 + idx * 500)),
    ];

    for (const rule of allRules) {
      const pos = rule.declarations["position"];
      if (!pos) continue;
      assert.notEqual(pos, "sticky", `Unexpected sticky position on ${rule.selectors.join(", ")}`);
      assert.notEqual(pos, "fixed", `Unexpected fixed position on ${rule.selectors.join(", ")}`);
      if (pos === "absolute") {
        const allowedAbsolute = rule.selectors.every(
          (s) =>
            s.includes("a.skip") ||
            s.includes(".bf-viewfinder-placeholder") ||
            s.includes(".bf-camera-on-badge") ||
            s.includes(".bf-curtain-badge"),
        );
        assert.equal(
          allowedAbsolute,
          true,
          `position: absolute only permitted on offscreen skip-link or non-interactive viewfinder overlays, got ${rule.selectors.join(", ")}`,
        );
      }
    }

    assert.equal(
      selectorDeclares(allRules, "body.blindfold-body", new RegExp("overflow-y\\s*:\\s*auto")),
      true,
      "body.blindfold-body must allow vertical document scrolling",
    );
    assert.equal(
      selectorDeclares(allRules, "body.blindfold-body", new RegExp("height\\s*:\\s*auto")),
      true,
      "body.blindfold-body must keep height: auto for vertical flow",
    );
    assert.equal(
      selectorDeclares(allRules, ".bf-page", new RegExp("overflow-x\\s*:\\s*clip")),
      true,
      ".bf-page must guard horizontal overflow with overflow-x: clip",
    );
    assert.equal(
      selectorDeclares(
        allRules,
        ".bf-page :focus-visible",
        new RegExp("outline\\s*:\\s*3px\\s+solid\\s+var\\(--accent\\)"),
      ),
      true,
      ".bf-page :focus-visible must preserve 3px solid focus ring",
    );

    for (const wrapSel of [
      ".bf-honesty-banner",
      ".bf-title",
      ".bf-subtitle",
      ".bf-sim-panel h3",
      ".bf-sim-sub",
      ".bf-sim-btn",
      ".bf-verdict-box",
      ".bf-reveal",
      ".bf-spot-card h3",
      ".bf-card-prompt",
      ".bf-choice-btn",
      ".bf-clip-btn",
      ".bf-conf-table th",
      ".bf-conf-table td",
      ".bf-footer",
    ]) {
      assert.equal(
        selectorDeclares(
          allRules,
          wrapSel,
          new RegExp("(overflow-wrap\\s*:\\s*(anywhere|break-word)|word-break\\s*:\\s*(break-word|break-all))"),
        ),
        true,
        `Expected overflow-wrap / word-break guard on ${wrapSel}`,
      );
    }

    for (const gridSel of [".bf-choices", ".bf-sim-grid", ".bf-round-tabs", ".bf-clips-grid"]) {
      assert.equal(
        selectorDeclares(allRules, gridSel, new RegExp("grid-template-columns\\s*:\\s*1fr")),
        true,
        `Expected ${gridSel} to collapse to 1fr at narrow mobile widths`,
      );
    }

    const fiRound1 = renderToStaticMarkup(
      createElement(bfMod.BlindfoldView, bfMod.initialBlindfoldViewProps({ lang: "fi", round: "blindfold" })),
    );
    const fiRound2 = renderToStaticMarkup(
      createElement(
        bfMod.BlindfoldView,
        bfMod.initialBlindfoldViewProps({
          lang: "fi",
          round: "spot",
          spotIndex: 0,
          spotGuess: "warning",
          answeredCount: 1,
        }),
      ),
    );
    const svRound2 = renderToStaticMarkup(
      createElement(
        bfMod.BlindfoldView,
        bfMod.initialBlindfoldViewProps({
          lang: "sv",
          round: "spot",
          spotIndex: 0,
          spotGuess: "match",
          answeredCount: 1,
        }),
      ),
    );

    assert.ok(
      fiRound1.includes("pakkaussimulaatio"),
      "FI Round 1 must render compound word pakkaussimulaatio",
    );
    assert.ok(
      fiRound2.includes("turvasaannon"),
      "FI Round 2 missed-rule badge must render compound word turvasaannon",
    );
    assert.ok(
      svRound2.includes("kvallsmedicin"),
      "SV Round 2 card heading must render compound word kvallsmedicin",
    );
  });

  test("3b. verifies in headless Chromium at 320x568 with WCAG 1.4.12 spacing overrides that scrollWidth <= 320 across EN, FI, and SV, zero focus occlusion, and forced-colors borders", async (t) => {
    const customPathOverride = Boolean(
      process.env.PLAYWRIGHT_BROWSERS_PATH || process.env.PLAYWRIGHT_EXECUTABLE_PATH,
    );
    const sharedExists = fs.existsSync(SHARED_PLAYWRIGHT_DIR);
    const hasChromium = detectHostChromium();

    if (sharedExists && !customPathOverride) {
      assert.equal(
        hasChromium,
        true,
        "Shared Playwright cache exists, so Chromium binary must be detected",
      );
    } else if (!hasChromium) {
      t.skip("Playwright Chromium binary not installed on this host");
      return;
    }

    if (!process.env.PLAYWRIGHT_BROWSERS_PATH && sharedExists) {
      process.env.PLAYWRIGHT_BROWSERS_PATH = SHARED_PLAYWRIGHT_DIR;
    }

    const bfMod = (await import(pathToFileURL(BLINDFOLD_TSX_PATH).href)) as BlindfoldModuleShape;
    const coachMod = (await import(pathToFileURL(COACH_TS_PATH).href)) as CoachModuleShape;
    const playwrightName = "playwright";
    const { chromium } = (await import(playwrightName)) as PlaywrightModule;

    const cleanStylesNoImport = stripBlockComments(fs.readFileSync(STYLES_CSS_PATH, "utf8")).replace(
      new RegExp('@import\\s+["\'][^"\']+["\']\\s*;', "g"),
      "",
    );
    const cleanBlindfold = stripBlockComments(fs.readFileSync(BLINDFOLD_CSS_PATH, "utf8"));
    const sampleWarnVerdict =
      coachMod.runSimulatedBox && coachMod.SIM_BOXES[1]
        ? coachMod.runSimulatedBox(coachMod.SIM_BOXES[1].id).verdict
        : makeSampleVerdict("warning");

    const buildPageHtml = (lang: BlindfoldLang, round: "blindfold" | "spot"): string => {
      const props = bfMod.initialBlindfoldViewProps({
        lang,
        round,
        blindfoldOn: true,
        cameraState: round === "blindfold" ? "on" : "off",
        readiness: 0.88,
        cue: "rotate_left",
        cueText:
          lang === "fi"
            ? "Kaanna pakkausta hitaasti."
            : lang === "sv"
              ? "Vrid forpackningen langsamt."
              : "Turn the box slowly.",
        verdict: round === "blindfold" ? sampleWarnVerdict : null,
        spotIndex: 0,
        spotGuess: round === "spot" ? "warning" : null,
        judgeScore: 0,
        holdupScore: 1,
        answeredCount: 1,
      });

      let bodyMarkup = renderToStaticMarkup(createElement(bfMod.BlindfoldView, props));
      bodyMarkup = bodyMarkup.replace(
        '<details class="bf-clips-drawer">',
        '<details class="bf-clips-drawer" open>',
      );

      return [
        "<!doctype html>",
        `<html lang="${lang}">`,
        "<head>",
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        "<title>Meta Blindfold Low-Vision Reflow Check</title>",
        "<style>",
        cleanStylesNoImport,
        cleanBlindfold,
        "</style>",
        "</head>",
        `<body class="blindfold-body"><div id="root">${bodyMarkup}</div></body>`,
        "</html>",
      ].join("\n");
    };

    const transparentPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );

    const server = http.createServer((reqMsg, res) => {
      const reqUrl = new URL(reqMsg.url ?? SLASH, "http:" + SLASH2 + "127.0.0.1");
      if (reqUrl.pathname.endsWith(".jpg") || reqUrl.pathname.endsWith(".png")) {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(transparentPng);
        return;
      }
      const langParam = reqUrl.searchParams.get("lang");
      const lang: BlindfoldLang =
        langParam === "fi" || langParam === "sv" ? langParam : "en";
      const round: "blindfold" | "spot" =
        reqUrl.searchParams.get("round") === "spot" ? "spot" : "blindfold";
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(buildPageHtml(lang, round));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const baseUrl = "http:" + SLASH2 + "127.0.0.1:" + String(port);

    let externalRequests = 0;
    let browser: PlaywrightBrowser | null = null;

    const baseReflowExpr = [
      "(() => ({",
      "  innerWidth: window.innerWidth,",
      "  scrollWidth: document.documentElement.scrollWidth,",
      "  bodyScrollWidth: document.body.scrollWidth,",
      "}))()",
    ].join("\n");

    const spacedAuditExpr = [
      "(() => {",
      "  const scrollWidth = document.documentElement.scrollWidth;",
      "  const bodyScrollWidth = document.body.scrollWidth;",
      "  const overflowingControls = [];",
      "  const stickyOrFixed = [];",
      "  let obscuredFocusCount = 0;",
      '  for (const el of Array.from(document.querySelectorAll(".bf-page, .bf-page *"))) {',
      "    const pos = getComputedStyle(el).position;",
      '    if (pos === "sticky" || pos === "fixed") {',
      "      stickyOrFixed.push(el.tagName + '.' + el.className + ':' + pos);",
      "    }",
      "  }",
      '  const checkSelectors = "button, a:not(.skip), h1, h2, h3, h4, table, .bf-honesty-banner, .bf-verdict-box, .bf-reveal, .bf-pixel-canvas";',
      "  for (const el of Array.from(document.querySelectorAll(checkSelectors))) {",
      "    const r = el.getBoundingClientRect();",
      "    if (r.width === 0 && r.height === 0) continue;",
      "    if (r.left < -0.5 || r.right > 320.5) {",
      "      overflowingControls.push(el.tagName + '.' + el.className + '[' + r.left.toFixed(1) + '..' + r.right.toFixed(1) + ']');",
      "    }",
      "  }",
      '  const buttons = Array.from(document.querySelectorAll(".bf-page button:not(:disabled), .bf-footer a"));',
      "  for (const btn of buttons.slice(0, 8)) {",
      '    btn.scrollIntoView({ block: "center", inline: "nearest" });',
      "    btn.focus({ preventScroll: true });",
      "    const r = btn.getBoundingClientRect();",
      "    if (r.width <= 0 || r.height <= 0) continue;",
      "    const cx = Math.min(319, Math.max(1, r.left + r.width / 2));",
      "    const cy = Math.min(567, Math.max(1, r.top + r.height / 2));",
      "    const hit = document.elementFromPoint(cx, cy);",
      "    if (!hit || (!btn.contains(hit) && !hit.contains(btn))) {",
      "      obscuredFocusCount++;",
      "    }",
      "  }",
      "  return {",
      "    scrollWidth,",
      "    bodyScrollWidth,",
      "    overflowingControls,",
      "    stickyOrFixed,",
      "    obscuredFocusCount,",
      "    checkedButtons: Math.min(8, buttons.length),",
      "  };",
      "})()",
    ].join("\n");

    const forcedColorsR1Expr = [
      "(() => {",
      "  const pick = (sel) => {",
      "    const el = document.querySelector(sel);",
      "    if (!el) return null;",
      "    const cs = getComputedStyle(el);",
      "    return { width: cs.borderTopWidth, style: cs.borderTopStyle, color: cs.borderTopColor };",
      "  };",
      "  return {",
      '    banner: pick(".bf-honesty-banner"),',
      '    canvas: pick(".bf-pixel-canvas"),',
      '    viewfinder: pick(".bf-viewfinder"),',
      '    bigBtn: pick(".bf-big-btn"),',
      '    verdictBox: pick(".bf-verdict-box"),',
      "    pressed: pick('[aria-pressed=\"true\"]'),",
      "  };",
      "})()",
    ].join("\n");

    const forcedColorsR2Expr = [
      "(() => {",
      '  const el = document.querySelector(".bf-choice-btn");',
      "  if (!el) return null;",
      "  const cs = getComputedStyle(el);",
      "  return { width: cs.borderTopWidth, style: cs.borderTopStyle, color: cs.borderTopColor };",
      "})()",
    ].join("\n");

    try {
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({
        viewport: { width: 320, height: 568 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      });
      const page = await context.newPage();

      await page.route("**" + SLASH + "*", async (route) => {
        const u = route.request().url();
        if (u.startsWith(baseUrl) || u.startsWith("data:")) {
          await route.continue();
        } else {
          externalRequests++;
          await route.abort();
        }
      });

      const wcag1412Css = [
        "* {",
        "  line-height: 1.5 !important;",
        "  letter-spacing: 0.12em !important;",
        "  word-spacing: 0.16em !important;",
        "}",
        "p { margin-bottom: 2em !important; }",
      ].join("\n");

      for (const lang of ALL_LANGS) {
        for (const round of ["blindfold", "spot"] as const) {
          await page.goto(`${baseUrl}${SLASH}?lang=${lang}&round=${round}`, {
            waitUntil: "domcontentloaded",
          });

          const baseReflow = await page.evaluate<{
            innerWidth: number;
            scrollWidth: number;
            bodyScrollWidth: number;
          }>(baseReflowExpr);
          assert.equal(baseReflow.innerWidth, 320);
          assert.ok(
            baseReflow.scrollWidth <= 320 && baseReflow.bodyScrollWidth <= 320,
            `[base 320x568 ${lang} ${round}] expected scrollWidth <= 320, got doc=${baseReflow.scrollWidth} body=${baseReflow.bodyScrollWidth}`,
          );

          await page.addStyleTag({ content: wcag1412Css });

          const spacedAudit = await page.evaluate<{
            scrollWidth: number;
            bodyScrollWidth: number;
            overflowingControls: string[];
            stickyOrFixed: string[];
            obscuredFocusCount: number;
            checkedButtons: number;
          }>(spacedAuditExpr);

          assert.ok(
            spacedAudit.scrollWidth <= 320 && spacedAudit.bodyScrollWidth <= 320,
            `[WCAG 1.4.12 320x568 ${lang} ${round}] expected scrollWidth <= 320, got doc=${spacedAudit.scrollWidth} body=${spacedAudit.bodyScrollWidth}`,
          );
          assert.deepEqual(
            spacedAudit.overflowingControls,
            [],
            `[WCAG 1.4.12 320x568 ${lang} ${round}] zero controls may clip horizontally`,
          );
          assert.deepEqual(
            spacedAudit.stickyOrFixed,
            [],
            `[WCAG 1.4.12 320x568 ${lang} ${round}] zero sticky/fixed elements permitted`,
          );
          assert.equal(
            spacedAudit.obscuredFocusCount,
            0,
            `[WCAG 2.4.11 320x568 ${lang} ${round}] focused controls must never be obscured`,
          );
          assert.ok(spacedAudit.checkedButtons >= 4);
        }
      }

      type BorderSample = { width: string; style: string; color: string } | null;

      await page.emulateMedia({ forcedColors: "active" });
      await page.goto(`${baseUrl}${SLASH}?lang=en&round=blindfold`, {
        waitUntil: "domcontentloaded",
      });
      const fcR1 = await page.evaluate<{
        banner: BorderSample;
        canvas: BorderSample;
        viewfinder: BorderSample;
        bigBtn: BorderSample;
        verdictBox: BorderSample;
        pressed: BorderSample;
      }>(forcedColorsR1Expr);

      await page.goto(`${baseUrl}${SLASH}?lang=en&round=spot`, {
        waitUntil: "domcontentloaded",
      });
      const fcR2 = await page.evaluate<BorderSample>(forcedColorsR2Expr);

      for (const [label, b] of [
        [".bf-honesty-banner", fcR1.banner],
        [".bf-pixel-canvas", fcR1.canvas],
        [".bf-viewfinder", fcR1.viewfinder],
        [".bf-big-btn", fcR1.bigBtn],
        [".bf-verdict-box", fcR1.verdictBox],
        ['[aria-pressed="true"]', fcR1.pressed],
        [".bf-choice-btn", fcR2],
      ] as const) {
        assert.ok(b, `Expected element ${label} in forced-colors DOM`);
        assert.equal(b.width, "2px", `Expected 2px border in forced-colors on ${label}, got ${b.width}`);
        assert.equal(b.style, "solid", `Expected solid border in forced-colors on ${label}, got ${b.style}`);
        assert.notEqual(
          b.color,
          "rgba(0, 0, 0, 0)",
          `Expected non-transparent system border color on ${label}`,
        );
      }

      assert.equal(externalRequests, 0, "Chromium reflow test must make zero external network requests");
      await context.close();
    } finally {
      if (browser) await browser.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("4a. verifies pixelScene.ts WCAG 1.1.1 role=img + descriptive aria-label across all phases, WCAG 2.2.2 reduced-motion freeze, and WCAG 2.3.1 zero >3Hz flashing", async () => {
    const bfMod = (await import(pathToFileURL(BLINDFOLD_TSX_PATH).href)) as BlindfoldModuleShape;
    const sceneMod = (await import(pathToFileURL(PIXEL_SCENE_TS_PATH).href)) as PixelSceneModuleShape;

    for (const round of ["blindfold", "spot"] as const) {
      for (const level of [null, ...VERDICT_LEVELS] as const) {
        const html = renderToStaticMarkup(
          createElement(
            bfMod.BlindfoldView,
            bfMod.initialBlindfoldViewProps({
              round,
              cameraState: level === null && round === "blindfold" ? "on" : "off",
              verdict: level && round === "blindfold" ? makeSampleVerdict(level) : null,
              spotIndex: 0,
              spotGuess: level && round === "spot" ? level : null,
            }),
          ),
        );
        const canvasMatch = new RegExp("<canvas[^>]+class=\"bf-pixel-canvas\"[^>]*>").exec(html);
        assert.ok(canvasMatch, `Expected .bf-pixel-canvas in BlindfoldView (${round}, ${String(level)})`);
        const tag = canvasMatch[0];
        assert.ok(tag.includes('role="img"'), ".bf-pixel-canvas must declare role=\"img\"");
        const ariaMatch = new RegExp('aria-label="([^"]+)"').exec(tag);
        assert.ok(
          ariaMatch && ariaMatch[1].trim().length >= 20,
          `Expected descriptive aria-label on .bf-pixel-canvas, got "${ariaMatch?.[1] ?? ""}"`,
        );
      }
    }

    const env = installSceneBrowserMock(false, false);
    try {
      const ariaCanvas = createRasterCanvas(320, 180);
      const ariaCtrl = sceneMod.mountPixelScene(ariaCanvas.canvas, {
        mode: "blindfold",
        phase: "idle",
        blindfoldOn: true,
        score: 0,
        total: 5,
        lang: "en",
        reducedMotion: true,
      });

      for (const mode of ["blindfold", "spot"] as const) {
        for (const lang of ALL_LANGS) {
          for (const phase of ALL_PHASES) {
            ariaCtrl.update({ mode, lang, phase, blindfoldOn: mode === "blindfold", score: 3, total: 5 });
            assert.equal(ariaCanvas.attrs.get("role"), "img");
            const label = ariaCanvas.attrs.get("aria-label") ?? "";
            assert.ok(
              label.length >= 18 && label.includes(phase) && label.includes("3/5"),
              `Expected phase-aware aria-label for ${mode}/${lang}/${phase}, got "${label}"`,
            );
          }
        }
      }
      ariaCtrl.destroy();

      const reducedCanvas = createRasterCanvas(320, 180);
      env.pendingRaf.clear();
      const reducedCtrl = sceneMod.mountPixelScene(reducedCanvas.canvas, {
        mode: "blindfold",
        phase: "checking",
        blindfoldOn: true,
        score: 1,
        total: 5,
        lang: "en",
        reducedMotion: true,
      });
      assert.equal(reducedCanvas.ctx.imageSmoothingEnabled, false);
      assert.equal(
        env.pendingRaf.size,
        0,
        "reducedMotion: true must not start a continuous requestAnimationFrame loop (WCAG 2.2.2)",
      );
      const snapA = reducedCanvas.snapshotLuminance();
      reducedCtrl.renderNow();
      const snapB = reducedCanvas.snapshotLuminance();
      let diffPixels = 0;
      for (let i = 0; i < snapA.length; i++) {
        if (Math.abs(snapA[i] - snapB[i]) > 1e-6) diffPixels++;
      }
      assert.equal(diffPixels, 0, "reducedMotion: true static frames must have 0 animated pixel drift");
      reducedCtrl.destroy();

      const mqlCanvas = createRasterCanvas(320, 180);
      env.pendingRaf.clear();
      const mqlCtrl = sceneMod.mountPixelScene(mqlCanvas.canvas, {
        mode: "blindfold",
        phase: "coaching",
        blindfoldOn: true,
        score: 0,
        total: 5,
        lang: "en",
      });
      assert.equal(env.pendingRaf.size, 1, "Default motion should schedule 1 rAF callback");
      env.setReducedMotionMedia(true);
      assert.equal(
        env.pendingRaf.size,
        0,
        "prefers-reduced-motion: reduce media change must cancel active rAF loop immediately",
      );
      mqlCtrl.destroy();
      env.setReducedMotionMedia(false);

      const totalPixels = 320 * 180;
      for (const phase of ALL_PHASES) {
        const flashCanvas = createRasterCanvas(320, 180);
        env.pendingRaf.clear();
        const flashCtrl = sceneMod.mountPixelScene(flashCanvas.canvas, {
          mode: "blindfold",
          phase,
          blindfoldOn: true,
          score: 2,
          total: 5,
          lang: "en",
          cueText: "Turn box slowly",
          reducedMotion: false,
        });

        const frameMeanLumas: number[] = [];
        const pixelTransitions = new Uint8Array(totalPixels);
        const pixelLastDir = new Int8Array(totalPixels);
        let prevLuma = flashCanvas.snapshotLuminance();

        for (let f = 1; f <= 60; f++) {
          env.stepRaf(f * (1000 / 60));
          const curLuma = flashCanvas.snapshotLuminance();
          let sum = 0;
          for (let p = 0; p < totalPixels; p++) {
            const l = curLuma[p];
            sum += l;
            const delta = l - prevLuma[p];
            const darker = Math.min(l, prevLuma[p]);
            if (Math.abs(delta) >= 0.1 && darker < 0.8) {
              const dir = delta > 0 ? 1 : -1;
              if (pixelLastDir[p] !== 0 && pixelLastDir[p] !== dir) {
                pixelTransitions[p]++;
              }
              pixelLastDir[p] = dir;
            }
          }
          frameMeanLumas.push(sum / totalPixels);
          prevLuma = curLuma;
        }

        let frameWideTransitions = 0;
        let lastFrameDir = 0;
        let maxMeanDelta = 0;
        for (let i = 1; i < frameMeanLumas.length; i++) {
          const d = frameMeanLumas[i] - frameMeanLumas[i - 1];
          maxMeanDelta = Math.max(maxMeanDelta, Math.abs(d));
          if (Math.abs(d) >= 0.1) {
            const dir = d > 0 ? 1 : -1;
            if (lastFrameDir !== 0 && lastFrameDir !== dir) frameWideTransitions++;
            lastFrameDir = dir;
          }
        }
        const frameWideFlashesPerSec = Math.floor(frameWideTransitions / 2);
        assert.equal(
          frameWideFlashesPerSec,
          0,
          `[WCAG 2.3.1 phase=${phase}] expected 0 frame-wide flashes/sec, got ${frameWideFlashesPerSec}`,
        );
        assert.ok(
          maxMeanDelta < 0.02,
          `[WCAG 2.3.1 phase=${phase}] expected frame-to-frame mean luminance delta < 0.02, got ${maxMeanDelta.toFixed(4)}`,
        );

        let pixelsAbove3Hz = 0;
        for (let p = 0; p < totalPixels; p++) {
          if (pixelTransitions[p] > 6) pixelsAbove3Hz++;
        }
        const areaFractionAbove3Hz = pixelsAbove3Hz / totalPixels;
        assert.ok(
          areaFractionAbove3Hz < 0.005,
          `[WCAG 2.3.1 phase=${phase}] flashing area >3Hz must stay << 25% threshold (< 0.5%), got ${(areaFractionAbove3Hz * 100).toFixed(3)}%`,
        );

        flashCtrl.destroy();
      }
    } finally {
      env.restore();
    }
  });

  test("4b. verifies @media (forced-colors: active) applies explicit 2px solid system borders across required Blindfold surfaces, buttons, verdicts, and pressed states", () => {
    const cleanBlindfold = stripBlockComments(fs.readFileSync(BLINDFOLD_CSS_PATH, "utf8"));

    const reducedMotionBlocks = extractAllMediaBlocks(
      cleanBlindfold,
      new RegExp("@media\\s*\\(\\s*prefers-reduced-motion\\s*:\\s*reduce\\s*\\)"),
    );
    assert.ok(reducedMotionBlocks.length >= 1, "blindfold.css must define @media (prefers-reduced-motion: reduce)");
    assert.match(reducedMotionBlocks[0], new RegExp("animation-duration\\s*:\\s*0\\.01ms\\s*!important"));
    assert.match(reducedMotionBlocks[0], new RegExp("transition-duration\\s*:\\s*0\\.01ms\\s*!important"));

    const fcBlocks = extractAllMediaBlocks(
      cleanBlindfold,
      new RegExp("@media\\s*\\(\\s*forced-colors\\s*:\\s*active\\s*\\)"),
    );
    assert.ok(fcBlocks.length >= 1, "blindfold.css must define @media (forced-colors: active)");
    const fcRules = fcBlocks.flatMap((blk, idx) => parseCssRules(blk, idx * 1_000));

    const systemBorderRe = new RegExp(
      "^2px\\s+solid\\s+(ButtonText|Highlight|CanvasText|ButtonBorder)$",
      "i",
    );

    const requiredUnpressedSelectors = [
      ".bf-honesty-banner",
      ".bf-pixel-canvas",
      ".bf-viewfinder",
      ".bf-big-btn",
      ".bf-choice-btn",
      ".bf-choice-btn.match",
      ".bf-choice-btn.warning",
      ".bf-choice-btn.unsure",
      ".bf-verdict-box",
      ".bf-verdict-box.match",
      ".bf-verdict-box.warning",
      ".bf-verdict-box.unsure",
    ];

    for (const sel of requiredUnpressedSelectors) {
      const matching = fcRules.filter((r) => r.selectors.includes(sel));
      assert.ok(
        matching.length >= 1,
        `@media (forced-colors: active) must explicitly style ${sel}`,
      );
      const borderVal = matching[matching.length - 1].declarations["border"] ?? "";
      assert.match(
        borderVal,
        new RegExp("^2px\\s+solid\\s+(ButtonText|Highlight)$", "i"),
        `Expected ${sel} in @media (forced-colors: active) to declare 2px solid ButtonText/Highlight, got "${borderVal}"`,
      );
    }

    const requiredPressedSelectors = [
      '.bf-lang-btn[aria-pressed="true"]',
      '.bf-sr-toggle[aria-pressed="true"]',
      '.bf-round-tab[aria-pressed="true"]',
      '.bf-curtain-toggle[aria-pressed="true"]',
      '.bf-sim-btn[aria-pressed="true"]',
      '.bf-clip-btn[aria-pressed="true"]',
      '.bf-choice-btn[aria-pressed="true"]',
      '.bf-choice-btn.match[aria-pressed="true"]',
      '.bf-choice-btn.warning[aria-pressed="true"]',
      '.bf-choice-btn.unsure[aria-pressed="true"]',
    ];

    for (const pressedSel of requiredPressedSelectors) {
      const matching = fcRules.filter((r) => r.selectors.includes(pressedSel));
      assert.ok(
        matching.length >= 1,
        `@media (forced-colors: active) must explicitly style ${pressedSel}`,
      );
      const decls = matching[matching.length - 1].declarations;
      assert.equal(
        decls["forced-color-adjust"],
        "none",
        `Expected forced-color-adjust: none on ${pressedSel} so active state stays distinguishable`,
      );
      assert.match(
        decls["border"] ?? "",
        systemBorderRe,
        `Expected ${pressedSel} in @media (forced-colors: active) to declare 2px solid system border, got "${decls["border"] ?? ""}"`,
      );
    }
  });
});
