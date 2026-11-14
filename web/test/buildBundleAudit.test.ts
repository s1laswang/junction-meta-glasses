type TestFn = (name: string, fn: () => void | Promise<void>) => Promise<void>;

type StrictAssert = {
  ok(value: unknown, message?: string): asserts value;
  equal<T>(actual: T, expected: T, message?: string): void;
  deepEqual<T>(actual: T, expected: T, message?: string): void;
  match(value: string, regExp: RegExp, message?: string): void;
  throws(block: () => unknown, error?: RegExp | ((err: unknown) => boolean), message?: string): void;
};

type FsModule = {
  existsSync(path: URL | string): boolean;
  readFileSync(path: URL | string, encoding: "utf8"): string;
  readdirSync(path: URL | string): string[];
  mkdtempSync(prefix: string): string;
  writeFileSync(path: URL | string, data: string, encoding: "utf8"): void;
  rmSync(path: URL | string, options: { recursive: boolean; force: boolean }): void;
};

type OsModule = {
  tmpdir(): string;
};

type PathModule = {
  join(...parts: string[]): string;
};

const nodeTestSpec: string = "node:test";
const nodeAssertSpec: string = "node:assert/strict";
const nodeFsSpec: string = "node:fs";
const nodeOsSpec: string = "node:os";
const nodePathSpec: string = "node:path";

const { test } = (await import(nodeTestSpec)) as { test: TestFn };
const assert: StrictAssert = ((await import(nodeAssertSpec)) as { default: StrictAssert }).default;
const {
  existsSync,
  readFileSync,
  readdirSync,
  mkdtempSync,
  writeFileSync,
  rmSync
} = (await import(nodeFsSpec)) as FsModule;
const { tmpdir } = (await import(nodeOsSpec)) as OsModule;
const { join } = (await import(nodePathSpec)) as PathModule;

const SLASH = "\x2f";
const LINE_COMMENT = `${SLASH}${SLASH}`;
const BLOCK_COMMENT_OPEN = `${SLASH}*`;
const BLOCK_COMMENT_CLOSE = `*${SLASH}`;
const EM_DASH = "\u2014";

const RAW_HTTP_URL_RE = new RegExp(`https?:${SLASH}${SLASH}`, "i");
const EXTERNAL_TARGET_RE = new RegExp(`^(?:https?:)?${SLASH}${SLASH}`, "i");
const AIZA_SECRET_RE = /AIza[0-9A-Za-z_-]{20,}/;

const tokensCssUrl = new URL("../src/styles/tokens.css", import.meta.url);
const appCssUrl = new URL("../src/styles/app.css", import.meta.url);
const hudCssUrl = new URL("../src/hud/hud.css", import.meta.url);
const mainTsxUrl = new URL("../src/main.tsx", import.meta.url);
const selfTestUrl = new URL("./buildBundleAudit.test.ts", import.meta.url);
const distAssetsUrl = new URL("../dist/assets", import.meta.url);

type DeclarationEntry = {
  prop: string;
  value: string;
};

type ParsedCssRule = {
  media: string | null;
  selectors: string[];
  declarations: Record<string, string>;
  entries: DeclarationEntry[];
};

type ParsedStylesheet = {
  imports: string[];
  keyframes: string[];
  rules: ParsedCssRule[];
};

function splitTopLevelSelectors(prelude: string): string[] {
  const selectors: string[] = [];
  let start = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let quoteChar: string | null = null;

  for (let i = 0; i < prelude.length; i += 1) {
    const ch = prelude[i];
    if (quoteChar) {
      if (ch === quoteChar && prelude[i - 1] !== "\\") {
        quoteChar = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quoteChar = ch;
    } else if (ch === "(") {
      parenDepth += 1;
    } else if (ch === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
    } else if (ch === "[") {
      bracketDepth += 1;
    } else if (ch === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
    } else if (ch === "," && parenDepth === 0 && bracketDepth === 0) {
      const item = prelude.slice(start, i).trim();
      if (item.length > 0) {
        selectors.push(item);
      }
      start = i + 1;
    }
  }

  const tail = prelude.slice(start).trim();
  if (tail.length > 0) {
    selectors.push(tail);
  }
  return selectors;
}

function parseDeclarations(blockBody: string): {
  declarations: Record<string, string>;
  entries: DeclarationEntry[];
} {
  const declarations: Record<string, string> = {};
  const entries: DeclarationEntry[] = [];

  for (const rawPart of blockBody.split(";")) {
    const colonIdx = rawPart.indexOf(":");
    if (colonIdx === -1) continue;
    const prop = rawPart.slice(0, colonIdx).trim();
    const value = rawPart.slice(colonIdx + 1).trim();
    if (prop.length > 0 && value.length > 0) {
      declarations[prop] = value;
      entries.push({ prop, value });
    }
  }

  return { declarations, entries };
}

function parseStylesheet(cssSource: string, media: string | null = null): ParsedStylesheet {
  const imports: string[] = [];
  const keyframes: string[] = [];
  const rules: ParsedCssRule[] = [];
  let cursor = 0;
  const len = cssSource.length;

  while (cursor < len) {
    while (cursor < len && /\s/.test(cssSource[cursor])) {
      cursor += 1;
    }
    if (cursor >= len) break;

    const openBrace = cssSource.indexOf("{", cursor);
    const semiColon = cssSource.indexOf(";", cursor);

    if (semiColon !== -1 && (openBrace === -1 || semiColon < openBrace)) {
      const statement = cssSource.slice(cursor, semiColon).trim();
      if (statement.toLowerCase().startsWith("@import")) {
        imports.push(statement);
      }
      cursor = semiColon + 1;
      continue;
    }

    if (openBrace === -1) break;

    const prelude = cssSource.slice(cursor, openBrace).trim();
    let depth = 1;
    let scan = openBrace + 1;
    while (scan < len && depth > 0) {
      const ch = cssSource[scan];
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      scan += 1;
    }

    const inner = cssSource.slice(openBrace + 1, scan - 1);
    const lowerPrelude = prelude.toLowerCase();

    if (lowerPrelude.startsWith("@media")) {
      const nested = parseStylesheet(inner, prelude);
      imports.push(...nested.imports);
      keyframes.push(...nested.keyframes);
      rules.push(...nested.rules);
    } else if (lowerPrelude.startsWith("@keyframes")) {
      keyframes.push(prelude);
    } else if (prelude.length > 0) {
      const { declarations, entries } = parseDeclarations(inner);
      rules.push({
        media,
        selectors: splitTopLevelSelectors(prelude),
        declarations,
        entries
      });
    }

    cursor = scan;
  }

  return { imports, keyframes, rules };
}

function collectRuleDeclarations(
  rules: ParsedCssRule[],
  selector: string,
  media: string | null = null
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const rule of rules) {
    if (rule.media === media && rule.selectors.includes(selector)) {
      Object.assign(merged, rule.declarations);
    }
  }
  return merged;
}

function collectRuleEntries(
  rules: ParsedCssRule[],
  selector: string,
  media: string | null = null
): DeclarationEntry[] {
  const collected: DeclarationEntry[] = [];
  for (const rule of rules) {
    if (rule.media === media && rule.selectors.includes(selector)) {
      collected.push(...rule.entries);
    }
  }
  return collected;
}

function srgbToLinear(channel8Bit: number): number {
  const normalized = channel8Bit / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function parseColorRgb(rawColor: string): [number, number, number] {
  const trimmed = rawColor.trim();
  const hexMatch = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(trimmed);
  if (hexMatch) {
    const hex = hexMatch[1];
    if (hex.length === 3) {
      return [
        Number.parseInt(hex[0] + hex[0], 16),
        Number.parseInt(hex[1] + hex[1], 16),
        Number.parseInt(hex[2] + hex[2], 16)
      ];
    }
    return [
      Number.parseInt(hex.slice(0, 2), 16),
      Number.parseInt(hex.slice(2, 4), 16),
      Number.parseInt(hex.slice(4, 6), 16)
    ];
  }

  const rgbMatch = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i.exec(trimmed);
  if (rgbMatch) {
    return [
      Number.parseInt(rgbMatch[1], 10),
      Number.parseInt(rgbMatch[2], 10),
      Number.parseInt(rgbMatch[3], 10)
    ];
  }

  throw new Error(`Unsupported color token value: ${rawColor}`);
}

function contrastRatio(fg: string, bg: string): number {
  const [r1, g1, b1] = parseColorRgb(fg);
  const [r2, g2, b2] = parseColorRgb(bg);
  const lum1 = 0.2126 * srgbToLinear(r1) + 0.7152 * srgbToLinear(g1) + 0.0722 * srgbToLinear(b1);
  const lum2 = 0.2126 * srgbToLinear(r2) + 0.7152 * srgbToLinear(g2) + 0.0722 * srgbToLinear(b2);
  const lighter = Math.max(lum1, lum2);
  const darker = Math.min(lum1, lum2);
  return (lighter + 0.05) / (darker + 0.05);
}

function parsePx(raw: string, contextLabel: string): number {
  const match = /^(\d+(?:\.\d+)?)px$/.exec(raw.trim());
  if (!match) {
    throw new Error(`Expected px value for ${contextLabel}, received: ${raw}`);
  }
  return Number.parseFloat(match[1]);
}

function evaluateTouchMinPx(
  rawExpr: string,
  tokens: Record<string, string>,
  viewportPx = 600
): { floorPx: number; atViewportPx: number } {
  const expr = rawExpr.trim();
  const directPx = /^(\d+(?:\.\d+)?)px$/.exec(expr);
  if (directPx) {
    const val = Number.parseFloat(directPx[1]);
    return { floorPx: val, atViewportPx: val };
  }

  const varRef = /^var\(\s*(--[a-z0-9-]+)\s*\)$/i.exec(expr);
  if (varRef) {
    const tokenVal = tokens[varRef[1]];
    assert.ok(tokenVal, `Expected token ${varRef[1]} to exist`);
    const px = parsePx(tokenVal, varRef[1]);
    return { floorPx: px, atViewportPx: px };
  }

  const calcMult = /^calc\(\s*var\(\s*(--[a-z0-9-]+)\s*\)\s*\*\s*(\d+(?:\.\d+)?)\s*\)$/i.exec(expr);
  if (calcMult) {
    const tokenVal = tokens[calcMult[1]];
    assert.ok(tokenVal, `Expected token ${calcMult[1]} to exist`);
    const px = parsePx(tokenVal, calcMult[1]) * Number.parseFloat(calcMult[2]);
    return { floorPx: px, atViewportPx: px };
  }

  const clampMatch = /^clamp\(\s*(\d+(?:\.\d+)?)px\s*,\s*(\d+(?:\.\d+)?)vmin\s*,\s*(\d+(?:\.\d+)?)px\s*\)$/i.exec(
    expr
  );
  if (clampMatch) {
    const minPx = Number.parseFloat(clampMatch[1]);
    const vminCoef = Number.parseFloat(clampMatch[2]);
    const maxPx = Number.parseFloat(clampMatch[3]);
    const preferredPx = (vminCoef / 100) * viewportPx;
    const clamped = Math.min(maxPx, Math.max(minPx, preferredPx));
    return { floorPx: minPx, atViewportPx: clamped };
  }

  throw new Error(`Unsupported touch-target sizing expression: ${rawExpr}`);
}

function extractCssUrls(cssSource: string): string[] {
  const urls: string[] = [];
  const urlRe = /url\(\s*([^)]+?)\s*\)/gi;
  let match: RegExpExecArray | null;
  while ((match = urlRe.exec(cssSource)) !== null) {
    const cleaned = match[1].trim().replace(/^["']|["']$/g, "");
    urls.push(cleaned);
  }
  return urls;
}

function extractImportTarget(importStatement: string): string {
  const body = importStatement.replace(/^@import\s+/i, "").trim();
  const urlWrap = /^url\(\s*([^)]+?)\s*\)/i.exec(body);
  const raw = urlWrap ? urlWrap[1].trim() : body.split(/\s+/)[0];
  return raw.replace(/^["']|["']$/g, "");
}

export type DistAuditResult =
  | { skipped: true; jsCount: 0; cssCount: 0 }
  | { skipped: false; jsCount: number; cssCount: number; cssBundleText: string };

export function auditDistAssetsDir(assetsDir: URL | string): DistAuditResult {
  if (!existsSync(assetsDir)) {
    return { skipped: true, jsCount: 0, cssCount: 0 };
  }

  const entries = readdirSync(assetsDir);
  const jsFiles = entries.filter((name) => name.endsWith(".js"));
  const cssFiles = entries.filter((name) => name.endsWith(".css"));

  if (jsFiles.length < 1) {
    throw new Error("Expected at least one .js bundle in web/dist/assets");
  }
  if (cssFiles.length < 1) {
    throw new Error("Expected at least one .css bundle in web/dist/assets");
  }

  const resolveAssetPath = (fileName: string): URL | string => {
    if (assetsDir instanceof URL) {
      const baseHref = assetsDir.href.endsWith("/") ? assetsDir.href : `${assetsDir.href}/`;
      return new URL(fileName, baseHref);
    }
    return join(assetsDir, fileName);
  };

  for (const fileName of [...jsFiles, ...cssFiles]) {
    const content = readFileSync(resolveAssetPath(fileName), "utf8");
    if (content.trim().length === 0) {
      throw new Error(`Compiled asset ${fileName} must not be empty`);
    }
    if (AIZA_SECRET_RE.test(content)) {
      throw new Error(`Leaked Gemini API key detected in compiled bundle ${fileName}`);
    }
  }

  const cssBundleText = cssFiles
    .map((fileName) => readFileSync(resolveAssetPath(fileName), "utf8"))
    .join("\n");

  return {
    skipped: false,
    jsCount: jsFiles.length,
    cssCount: cssFiles.length,
    cssBundleText
  };
}

const tokensCssSource = readFileSync(tokensCssUrl, "utf8");
const appCssSource = readFileSync(appCssUrl, "utf8");
const hudCssSource = readFileSync(hudCssUrl, "utf8");
const mainTsxSource = readFileSync(mainTsxUrl, "utf8");
const selfTestSource = readFileSync(selfTestUrl, "utf8");

const tokensParsed = parseStylesheet(tokensCssSource);
const appParsed = parseStylesheet(appCssSource);
const hudParsed = parseStylesheet(hudCssSource);

const rootTokens = collectRuleDeclarations(tokensParsed.rules, ":root");

test("main.tsx imports tokens.css, app.css, and hud.css in cascade order and all stylesheets plus buildBundleAudit.test.ts contain zero CSS comments and zero em dashes", () => {
  for (const [label, source] of [
    ["tokens.css", tokensCssSource],
    ["app.css", appCssSource],
    ["hud.css", hudCssSource],
    ["buildBundleAudit.test.ts", selfTestSource]
  ] as const) {
    assert.ok(source.trim().length > 0, `${label} must be non-empty`);
    assert.equal(
      source.includes(BLOCK_COMMENT_OPEN),
      false,
      `${label} must contain zero CSS block comment openers`
    );
    assert.equal(
      source.includes(BLOCK_COMMENT_CLOSE),
      false,
      `${label} must contain zero CSS block comment closers`
    );
    assert.equal(source.includes(EM_DASH), false, `${label} must contain zero em dashes`);
  }

  assert.equal(
    selfTestSource.includes(LINE_COMMENT),
    false,
    "buildBundleAudit.test.ts must contain zero line comments"
  );

  const tokensIdx = mainTsxSource.indexOf('import "./styles/tokens.css";');
  const appIdx = mainTsxSource.indexOf('import "./styles/app.css";');
  const hudIdx = mainTsxSource.indexOf('import "./hud/hud.css";');

  assert.ok(tokensIdx >= 0, "main.tsx must import ./styles/tokens.css");
  assert.ok(appIdx >= 0, "main.tsx must import ./styles/app.css");
  assert.ok(hudIdx >= 0, "main.tsx must import ./hud/hud.css");
  assert.ok(tokensIdx < appIdx, "tokens.css must precede app.css in main.tsx");
  assert.ok(appIdx < hudIdx, "app.css must precede hud.css in main.tsx");
});

test('tokens.css defines :root, [data-theme="light"], and [data-theme="high-contrast"] with WCAG 2.2 AAA luminance contrast invariants', () => {
  const darkExplicit = collectRuleDeclarations(tokensParsed.rules, '[data-theme="dark"]');
  const lightOverrides = collectRuleDeclarations(tokensParsed.rules, '[data-theme="light"]');
  const highContrastOverrides = collectRuleDeclarations(
    tokensParsed.rules,
    '[data-theme="high-contrast"]'
  );
  const prefersContrastOverrides = collectRuleDeclarations(
    tokensParsed.rules,
    ":root:not([data-theme])",
    "@media (prefers-contrast: more)"
  );

  assert.ok(Object.keys(rootTokens).length > 0, ":root must define design tokens");
  assert.ok(Object.keys(lightOverrides).length > 0, '[data-theme="light"] must define overrides');
  assert.ok(
    Object.keys(highContrastOverrides).length > 0,
    '[data-theme="high-contrast"] must define overrides'
  );
  assert.deepEqual(rootTokens, darkExplicit, ':root and [data-theme="dark"] must stay identical');
  assert.deepEqual(
    prefersContrastOverrides,
    highContrastOverrides,
    "@media (prefers-contrast: more) must mirror high-contrast tokens"
  );

  const lightTokens = { ...rootTokens, ...lightOverrides };
  const highContrastTokens = { ...rootTokens, ...highContrastOverrides };

  const requiredTokens = [
    "--tap-min",
    "--bg-app",
    "--bg-surface",
    "--bg-elevated",
    "--text-primary",
    "--text-secondary",
    "--text-muted",
    "--focus-ring",
    "--accent",
    "--accent-fg",
    "--danger",
    "--danger-fg",
    "--verdict-match-bg",
    "--verdict-match-fg",
    "--verdict-match-border",
    "--verdict-warning-bg",
    "--verdict-warning-fg",
    "--verdict-warning-border",
    "--verdict-unsure-bg",
    "--verdict-unsure-fg",
    "--verdict-unsure-border",
    "--verdict-info-bg",
    "--verdict-info-fg",
    "--verdict-info-border"
  ];

  for (const [themeName, map] of [
    [":root", rootTokens],
    ["light", lightTokens],
    ["high-contrast", highContrastTokens]
  ] as const) {
    for (const tokenName of requiredTokens) {
      assert.ok(map[tokenName], `[${themeName}] missing token ${tokenName}`);
    }

    assert.ok(
      contrastRatio(map["--text-primary"], map["--bg-app"]) >= 14,
      `[${themeName}] --text-primary vs --bg-app must achieve >= 14:1`
    );
    assert.ok(
      contrastRatio(map["--text-primary"], map["--bg-surface"]) >= 14,
      `[${themeName}] --text-primary vs --bg-surface must achieve >= 14:1`
    );
    assert.ok(
      contrastRatio(map["--text-secondary"], map["--bg-app"]) >= 7,
      `[${themeName}] --text-secondary vs --bg-app must achieve WCAG AAA >= 7:1`
    );
    assert.ok(
      contrastRatio(map["--text-muted"], map["--bg-surface"]) >= 7,
      `[${themeName}] --text-muted vs --bg-surface must achieve WCAG AAA >= 7:1`
    );
    assert.ok(
      contrastRatio(map["--focus-ring"], map["--bg-app"]) >= 9,
      `[${themeName}] --focus-ring vs --bg-app must achieve >= 9:1`
    );
    assert.ok(
      contrastRatio(map["--accent-fg"], map["--accent"]) >= 7,
      `[${themeName}] --accent-fg vs --accent must achieve >= 7:1`
    );
  }

  assert.equal(highContrastTokens["--bg-app"], "#000000");
  assert.equal(highContrastTokens["--text-primary"], "#ffffff");
  assert.ok(contrastRatio(highContrastTokens["--text-primary"], highContrastTokens["--bg-app"]) >= 19);
  assert.ok(contrastRatio(highContrastTokens["--focus-ring"], highContrastTokens["--bg-app"]) >= 15);
});

test("app.css and hud.css enforce :focus-visible rings, .skip-link keyboard reveal, forced-colors, and @media (prefers-reduced-motion: reduce)", () => {
  const focusVisible = collectRuleDeclarations(appParsed.rules, ":focus-visible");
  assert.equal(focusVisible["outline"], "3px solid var(--focus-ring)");
  assert.equal(focusVisible["outline-offset"], "3px");

  const focusNotVisible = collectRuleDeclarations(appParsed.rules, ":focus:not(:focus-visible)");
  assert.equal(focusNotVisible["outline"], "none");

  const forcedColorsFocus = collectRuleDeclarations(
    appParsed.rules,
    ":focus-visible",
    "@media (forced-colors: active)"
  );
  assert.equal(forcedColorsFocus["outline"], "3px solid Highlight");
  assert.equal(forcedColorsFocus["outline-offset"], "3px");

  const hudFocusVisible = collectRuleDeclarations(hudParsed.rules, ".hud-action-btn:focus-visible");
  const hudDataFocused = collectRuleDeclarations(
    hudParsed.rules,
    '.hud-action-btn[data-focused="true"]'
  );
  assert.equal(hudFocusVisible["outline"], "4px solid #ffee00");
  assert.equal(hudFocusVisible["outline-offset"], "3px");
  assert.equal(hudDataFocused["outline"], "4px solid #ffee00");

  const skipLink = collectRuleDeclarations(appParsed.rules, ".skip-link");
  assert.equal(skipLink["position"], "fixed");
  assert.equal(skipLink["min-height"], "var(--tap-min)");
  assert.equal(skipLink["transform"], "translateY(-200%)");

  const skipLinkFocus = collectRuleDeclarations(appParsed.rules, ".skip-link:focus");
  const skipLinkFocusVisible = collectRuleDeclarations(appParsed.rules, ".skip-link:focus-visible");
  assert.equal(skipLinkFocus["transform"], "translateY(0)");
  assert.equal(skipLinkFocusVisible["transform"], "translateY(0)");

  const reducedMotionMedia = "@media (prefers-reduced-motion: reduce)";
  const rmHtml = collectRuleDeclarations(appParsed.rules, "html", reducedMotionMedia);
  assert.equal(rmHtml["scroll-behavior"], "auto");

  for (const universalSel of ["*", "*::before", "*::after"]) {
    const rmUniversal = collectRuleDeclarations(appParsed.rules, universalSel, reducedMotionMedia);
    assert.equal(rmUniversal["animation-duration"], "0.01ms !important");
    assert.equal(rmUniversal["animation-iteration-count"], "1 !important");
    assert.equal(rmUniversal["transition-duration"], "0.01ms !important");
    assert.equal(rmUniversal["scroll-behavior"], "auto !important");
  }

  const rmLiveDot = collectRuleDeclarations(
    appParsed.rules,
    ".privacy-live-dot",
    reducedMotionMedia
  );
  assert.equal(rmLiveDot["animation"], "none");
  assert.equal(rmLiveDot["box-shadow"], "none");

  const rmHudBtn = collectRuleDeclarations(hudParsed.rules, ".hud-action-btn", reducedMotionMedia);
  assert.equal(rmHudBtn["transition"], "none");
});

test("touch-target minimum heights (>= 48px) hold across tokens.css, app.css, and hud.css", () => {
  const tapMinPx = parsePx(rootTokens["--tap-min"], "--tap-min");
  assert.ok(tapMinPx >= 48, `Expected --tap-min >= 48px, got ${tapMinPx}px`);

  const appTouchSelectors = [
    ".skip-link",
    ".app-nav a",
    ".app-nav button",
    ".btn",
    ".btn-lg",
    "button.chip",
    "a.chip",
    '[role="button"].chip',
    ".input",
    "textarea.input"
  ];

  for (const selector of appTouchSelectors) {
    const decls = collectRuleDeclarations(appParsed.rules, selector);
    const minHeightRaw = decls["min-height"];
    assert.ok(minHeightRaw, `Expected ${selector} in app.css to declare min-height`);
    const { floorPx, atViewportPx } = evaluateTouchMinPx(minHeightRaw, rootTokens);
    assert.ok(
      floorPx >= 48 && atViewportPx >= 48,
      `Expected ${selector} min-height >= 48px, resolved floor=${floorPx}px viewport=${atViewportPx}px`
    );
  }

  const btnDecls = collectRuleDeclarations(appParsed.rules, ".btn");
  const btnMinWidth = evaluateTouchMinPx(btnDecls["min-width"], rootTokens);
  assert.ok(btnMinWidth.floorPx >= 48, "Expected .btn min-width >= 48px");

  const hudBtnDecls = collectRuleDeclarations(hudParsed.rules, ".hud-action-btn");
  const hudBtnHeight = evaluateTouchMinPx(hudBtnDecls["min-height"], rootTokens, 600);
  assert.ok(
    hudBtnHeight.floorPx >= 48 && hudBtnHeight.atViewportPx >= 48,
    `Expected .hud-action-btn min-height >= 48px, got floor=${hudBtnHeight.floorPx}px at600=${hudBtnHeight.atViewportPx}px`
  );
});

test("hud.css enforces .hud-root pure #000000 additive waveguide canvas and 600px viewport bounds", () => {
  for (const hostSelector of [":root:has(.hud-root)", "body:has(.hud-root)", "#root:has(.hud-root)"]) {
    const hostDecls = collectRuleDeclarations(hudParsed.rules, hostSelector);
    assert.equal(hostDecls["background"], "#000000", `${hostSelector} must set background: #000000`);
    assert.equal(
      hostDecls["background-color"],
      "#000000",
      `${hostSelector} must set background-color: #000000`
    );
  }

  const hudRootDecls = collectRuleDeclarations(hudParsed.rules, ".hud-root");
  const hudRootEntries = collectRuleEntries(hudParsed.rules, ".hud-root");
  const hudRootHeights = hudRootEntries.filter((e) => e.prop === "height").map((e) => e.value);

  assert.equal(hudRootDecls["--hud-bg"], "#000000");
  assert.equal(hudRootDecls["background"], "#000000");
  assert.equal(hudRootDecls["background-color"], "#000000");
  assert.equal(hudRootDecls["color"], "#ffffff");
  assert.equal(hudRootDecls["width"], "100vw");
  assert.ok(hudRootHeights.includes("100vh"), ".hud-root must include 100vh fallback");
  assert.ok(hudRootHeights.includes("100dvh"), ".hud-root must include 100dvh bound");
  assert.equal(hudRootDecls["max-width"], "100vw");
  assert.equal(hudRootDecls["max-height"], "100dvh");
  assert.equal(hudRootDecls["margin"], "0");
  assert.equal(hudRootDecls["overflow"], "hidden");

  const rootPadding = evaluateTouchMinPx(hudRootDecls["padding"], rootTokens, 600);
  const maxRootPadMatch = /^clamp\(\s*\d+(?:\.\d+)?px\s*,\s*\d+(?:\.\d+)?vmin\s*,\s*(\d+(?:\.\d+)?)px\s*\)$/i.exec(
    hudRootDecls["padding"]
  );
  assert.ok(maxRootPadMatch, ".hud-root padding must use bounded clamp(...)");
  const maxRootPadPx = Number.parseFloat(maxRootPadMatch[1]);
  assert.ok(rootPadding.atViewportPx <= 20 && maxRootPadPx === 20);

  for (const boundedRegion of [".hud-topbar", ".hud-stage", ".hud-actions"]) {
    const regionDecls = collectRuleDeclarations(hudParsed.rules, boundedRegion);
    const maxWidthPx = parsePx(regionDecls["max-width"], `${boundedRegion} max-width`);
    assert.ok(maxWidthPx <= 600, `${boundedRegion} max-width must fit within 600px waveguide`);
    assert.equal(
      maxWidthPx + 2 * maxRootPadPx,
      600,
      `${boundedRegion} max-width (${maxWidthPx}px) + 2 * ${maxRootPadPx}px padding must equal 600px waveguide viewport`
    );
  }

  const hudCardDecls = collectRuleDeclarations(hudParsed.rules, ".hud-card");
  assert.equal(hudCardDecls["background-color"], "#000000");
  assert.equal(hudCardDecls["width"], "min(92%, 520px)");
  assert.equal(hudCardDecls["max-height"], "100%");

  const hudCoachDecls = collectRuleDeclarations(hudParsed.rules, ".hud-coach-card");
  assert.equal(hudCoachDecls["background-color"], "#000000");
  assert.equal(hudCoachDecls["width"], "min(82%, 440px)");

  const dimensionProps = new Set([
    "width",
    "min-width",
    "max-width",
    "height",
    "min-height",
    "max-height"
  ]);
  for (const rule of hudParsed.rules) {
    for (const entry of rule.entries) {
      if (!dimensionProps.has(entry.prop)) continue;
      const pxMatches = entry.value.matchAll(/(\d+(?:\.\d+)?)px/g);
      for (const m of pxMatches) {
        const px = Number.parseFloat(m[1]);
        assert.ok(
          px <= 600,
          `HUD rule ${rule.selectors.join(", ")} ${entry.prop}: ${entry.value} exceeds 600px waveguide bound`
        );
      }
    }
  }
});

test("tokens.css, app.css, and hud.css perform zero external http/https @import or url(...) fetches for 100% offline/tunnel safety", () => {
  for (const [label, source, parsed, baseUrl] of [
    ["tokens.css", tokensCssSource, tokensParsed, tokensCssUrl],
    ["app.css", appCssSource, appParsed, appCssUrl],
    ["hud.css", hudCssSource, hudParsed, hudCssUrl]
  ] as const) {
    assert.equal(
      RAW_HTTP_URL_RE.test(source),
      false,
      `${label} must contain zero http/https URLs`
    );
    assert.equal(
      source.toLowerCase().includes("@font-face"),
      false,
      `${label} must not fetch external @font-face assets`
    );

    for (const imp of parsed.imports) {
      const target = extractImportTarget(imp);
      assert.equal(
        EXTERNAL_TARGET_RE.test(target),
        false,
        `${label} @import must not target external URL: ${target}`
      );
      assert.ok(
        target.startsWith("./") || target.startsWith("../"),
        `${label} @import must use a local relative path: ${target}`
      );
      const resolvedImportUrl = new URL(target, baseUrl);
      assert.equal(
        existsSync(resolvedImportUrl),
        true,
        `${label} @import target must exist on disk: ${target}`
      );
    }

    const cssUrls = extractCssUrls(source);
    for (const target of cssUrls) {
      assert.equal(
        EXTERNAL_TARGET_RE.test(target),
        false,
        `${label} url(...) must not target external host: ${target}`
      );
    }
  }

  assert.equal(tokensParsed.imports.length, 0);
  assert.deepEqual(appParsed.imports, ['@import "./tokens.css"']);
  assert.equal(hudParsed.imports.length, 0);
});

test("auditDistAssetsDir skips gracefully when unbuilt, rejects missing bundles or AIza secrets, and verifies web/dist/assets when built", () => {
  const missingDir = join(tmpdir(), `holdup-missing-dist-${Date.now()}`);
  const missingResult = auditDistAssetsDir(missingDir);
  assert.deepEqual(missingResult, { skipped: true, jsCount: 0, cssCount: 0 });

  const sandboxDir = mkdtempSync(join(tmpdir(), "holdup-bundle-audit-"));
  try {
    assert.throws(
      () => auditDistAssetsDir(sandboxDir),
      /Expected at least one \.js bundle/
    );

    writeFileSync(join(sandboxDir, "index-test.js"), "console.log(1);", "utf8");
    assert.throws(
      () => auditDistAssetsDir(sandboxDir),
      /Expected at least one \.css bundle/
    );

    const fakeKey = ["AIza", "SyB1234567890abcdefghijklmno"].join("");
    writeFileSync(
      join(sandboxDir, "index-test.css"),
      `:root{--k:"${fakeKey}"}`,
      "utf8"
    );
    assert.throws(
      () => auditDistAssetsDir(sandboxDir),
      /Leaked Gemini API key/
    );

    writeFileSync(join(sandboxDir, "index-test.css"), ":root{color-scheme:dark}", "utf8");
    const validSandbox = auditDistAssetsDir(sandboxDir);
    assert.equal(validSandbox.skipped, false);
    if (!validSandbox.skipped) {
      assert.equal(validSandbox.jsCount, 1);
      assert.equal(validSandbox.cssCount, 1);
    }
  } finally {
    rmSync(sandboxDir, { recursive: true, force: true });
  }

  const realResult = auditDistAssetsDir(distAssetsUrl);
  if (!realResult.skipped) {
    assert.ok(realResult.jsCount >= 1, "Expected >= 1 compiled .js bundle in web/dist/assets");
    assert.ok(realResult.cssCount >= 1, "Expected >= 1 compiled .css bundle in web/dist/assets");

    const css = realResult.cssBundleText;
    assert.ok(css.includes(":root"), "Compiled CSS bundle must contain :root");
    assert.match(css, /\[data-theme=["']?light["']?\]/);
    assert.match(css, /\[data-theme=["']?high-contrast["']?\]/);
    assert.ok(css.includes(":focus-visible"), "Compiled CSS bundle must contain :focus-visible");
    assert.ok(
      css.includes("prefers-reduced-motion"),
      "Compiled CSS bundle must contain prefers-reduced-motion"
    );
    assert.ok(css.includes(".skip-link"), "Compiled CSS bundle must contain .skip-link");
    assert.ok(css.includes(".hud-root"), "Compiled CSS bundle must contain .hud-root");
    assert.equal(RAW_HTTP_URL_RE.test(css), false, "Compiled CSS bundle must be 100% offline");
    assert.equal(
      css.includes(BLOCK_COMMENT_OPEN),
      false,
      "Compiled CSS bundle must contain zero CSS comments"
    );
    assert.equal(css.includes(EM_DASH), false, "Compiled CSS bundle must contain zero em dashes");
  }
});
