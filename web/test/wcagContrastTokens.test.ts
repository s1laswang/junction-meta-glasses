type TestFn = (name: string, fn: () => void | Promise<void>) => Promise<void>;

interface AssertStrict {
  ok(value: unknown, message?: string): asserts value;
  equal<T>(actual: T, expected: T, message?: string): void;
  notEqual<T>(actual: T, expected: T, message?: string): void;
  deepEqual<T>(actual: T, expected: T, message?: string): void;
  throws(block: () => unknown, message?: string): void;
}

type FsModule = {
  readFileSync(path: URL | string, encoding: "utf8"): string;
};

const nodeTestSpec: string = "node:test";
const nodeAssertSpec: string = "node:assert/strict";
const nodeFsSpec: string = "node:fs";

const { test } = (await import(nodeTestSpec)) as { test: TestFn };
const assert: AssertStrict = (await import(nodeAssertSpec)) as AssertStrict;
const { readFileSync } = (await import(nodeFsSpec)) as FsModule;

type CssDeclarationMap = Record<string, string>;

type ParsedCssRule = {
  media: string | null;
  selectors: string[];
  declarations: CssDeclarationMap;
};

type Rgb8 = {
  r: number;
  g: number;
  b: number;
};

const WCAG_AA_NORMAL_TEXT = 4.5;
const WCAG_AAA_NORMAL_TEXT = 7.0;
const WCAG_AA_NON_TEXT = 3.0;

const BG_SURFACE_TOKENS = ["--bg-app", "--bg-surface", "--bg-elevated"] as const;
const VERDICT_LEVELS = ["match", "warning", "unsure", "info"] as const;

export function parseHexColor(rawColor: string): Rgb8 {
  const trimmed = rawColor.trim();
  const match = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(trimmed);
  if (!match) {
    throw new Error(`Expected 3-digit or 6-digit hex color, received: ${rawColor}`);
  }
  const hex = match[1];
  if (hex.length === 3) {
    return {
      r: Number.parseInt(hex[0] + hex[0], 16),
      g: Number.parseInt(hex[1] + hex[1], 16),
      b: Number.parseInt(hex[2] + hex[2], 16)
    };
  }
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16)
  };
}

export function srgb8ToLinear(channel8Bit: number): number {
  if (!Number.isFinite(channel8Bit) || channel8Bit < 0 || channel8Bit > 255) {
    throw new Error(`sRGB channel out of [0, 255] range: ${channel8Bit}`);
  }
  const srgb = channel8Bit / 255;
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hexColor: string): number {
  const { r, g, b } = parseHexColor(hexColor);
  const R = srgb8ToLinear(r);
  const G = srgb8ToLinear(g);
  const B = srgb8ToLinear(b);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

export function contrastRatio(foregroundHex: string, backgroundHex: string): number {
  const lumA = relativeLuminance(foregroundHex);
  const lumB = relativeLuminance(backgroundHex);
  const L1 = Math.max(lumA, lumB);
  const L2 = Math.min(lumA, lumB);
  return (L1 + 0.05) / (L2 + 0.05);
}

function parseRuleDeclarations(blockBody: string): CssDeclarationMap {
  const declarations: CssDeclarationMap = {};
  for (const rawEntry of blockBody.split(";")) {
    const colonIdx = rawEntry.indexOf(":");
    if (colonIdx === -1) continue;
    const prop = rawEntry.slice(0, colonIdx).trim();
    const val = rawEntry.slice(colonIdx + 1).trim();
    if (prop.length > 0 && val.length > 0) {
      declarations[prop] = val;
    }
  }
  return declarations;
}

function parseCssRules(cssSource: string, media: string | null = null): ParsedCssRule[] {
  const rules: ParsedCssRule[] = [];
  let cursor = 0;
  const totalLength = cssSource.length;

  while (cursor < totalLength) {
    const nextSemi = cssSource.indexOf(";", cursor);
    const openBrace = cssSource.indexOf("{", cursor);
    if (openBrace === -1) break;

    if (nextSemi !== -1 && nextSemi < openBrace) {
      const statement = cssSource.slice(cursor, nextSemi).trim();
      if (statement.startsWith("@import")) {
        cursor = nextSemi + 1;
        continue;
      }
    }

    const prelude = cssSource.slice(cursor, openBrace).trim();
    let depth = 1;
    let scan = openBrace + 1;
    while (scan < totalLength && depth > 0) {
      const ch = cssSource[scan];
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      scan += 1;
    }

    const innerBody = cssSource.slice(openBrace + 1, scan - 1);
    if (prelude.startsWith("@media")) {
      rules.push(...parseCssRules(innerBody, prelude));
    } else if (prelude.startsWith("@keyframes")) {
      cursor = scan;
      continue;
    } else if (prelude.length > 0) {
      const selectors = prelude
        .split(",")
        .map((sel) => sel.trim())
        .filter((sel) => sel.length > 0);
      rules.push({
        media,
        selectors,
        declarations: parseRuleDeclarations(innerBody)
      });
    }

    cursor = scan;
  }

  return rules;
}

function collectSelectorDeclarations(
  rules: ParsedCssRule[],
  selector: string,
  media: string | null = null
): CssDeclarationMap {
  const merged: CssDeclarationMap = {};
  for (const rule of rules) {
    if (rule.media === media && rule.selectors.includes(selector)) {
      Object.assign(merged, rule.declarations);
    }
  }
  return merged;
}

function collectCustomProperties(declarations: CssDeclarationMap): CssDeclarationMap {
  const tokens: CssDeclarationMap = {};
  for (const [prop, val] of Object.entries(declarations)) {
    if (prop.startsWith("--")) {
      tokens[prop] = val;
    }
  }
  return tokens;
}

function resolveCssToken(tokens: CssDeclarationMap, tokenName: string): string {
  let current: string | undefined = tokens[tokenName];
  let hops = 0;
  while (current && current.startsWith("var(") && current.endsWith(")") && hops < 8) {
    const refName = current.slice(4, -1).split(",")[0].trim();
    current = tokens[refName];
    hops += 1;
  }
  if (!current) {
    throw new Error(`Missing CSS token ${tokenName}`);
  }
  return current;
}

function extractFirstHexLiteral(cssValue: string, label: string): string {
  const match = /#[0-9a-fA-F]{3,6}\b/.exec(cssValue);
  if (!match) {
    throw new Error(`Expected hex color in ${label}, got: ${cssValue}`);
  }
  return match[0].toLowerCase();
}

function assertContrastAtLeast(
  contextLabel: string,
  fgName: string,
  fgHex: string,
  bgName: string,
  bgHex: string,
  minRatio: number
): number {
  const ratio = contrastRatio(fgHex, bgHex);
  assert.ok(
    ratio >= minRatio,
    `[${contextLabel}] ${fgName} (${fgHex}) vs ${bgName} (${bgHex}) achieved ${ratio.toFixed(2)}:1, expected >= ${minRatio.toFixed(2)}:1`
  );
  return ratio;
}

const tokensCssSource = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8");
const appCssSource = readFileSync(new URL("../src/styles/app.css", import.meta.url), "utf8");
const hudCssSource = readFileSync(new URL("../src/hud/hud.css", import.meta.url), "utf8");

const tokenRules = parseCssRules(tokensCssSource);
const appRules = parseCssRules(appCssSource);
const hudRules = parseCssRules(hudCssSource);

const rootTokens = collectCustomProperties(collectSelectorDeclarations(tokenRules, ":root"));
const darkSelectorTokens = collectCustomProperties(
  collectSelectorDeclarations(tokenRules, '[data-theme="dark"]')
);
const lightOverrideTokens = collectCustomProperties(
  collectSelectorDeclarations(tokenRules, '[data-theme="light"]')
);
const highContrastOverrideTokens = collectCustomProperties(
  collectSelectorDeclarations(tokenRules, '[data-theme="high-contrast"]')
);
const prefersContrastMoreOverrideTokens = collectCustomProperties(
  collectSelectorDeclarations(
    tokenRules,
    ":root:not([data-theme])",
    "@media (prefers-contrast: more)"
  )
);

const darkThemeTokens: CssDeclarationMap = { ...rootTokens, ...darkSelectorTokens };
const lightThemeTokens: CssDeclarationMap = { ...rootTokens, ...lightOverrideTokens };
const highContrastThemeTokens: CssDeclarationMap = {
  ...rootTokens,
  ...highContrastOverrideTokens
};
const prefersContrastMoreTokens: CssDeclarationMap = {
  ...rootTokens,
  ...prefersContrastMoreOverrideTokens
};

test("WCAG 2.x relative luminance L = 0.2126*R + 0.7152*G + 0.0722*B and contrast ratio satisfy exact mathematical laws", () => {
  assert.equal(relativeLuminance("#000000"), 0);
  assert.equal(relativeLuminance("#000"), 0);
  assert.ok(Math.abs(relativeLuminance("#ffffff") - 1) < 1e-12);
  assert.ok(Math.abs(relativeLuminance("#fff") - 1) < 1e-12);

  assert.ok(Math.abs(relativeLuminance("#ff0000") - 0.2126) < 1e-12);
  assert.ok(Math.abs(relativeLuminance("#00ff00") - 0.7152) < 1e-12);
  assert.ok(Math.abs(relativeLuminance("#0000ff") - 0.0722) < 1e-12);
  assert.ok(
    Math.abs(
      relativeLuminance("#ff0000") +
        relativeLuminance("#00ff00") +
        relativeLuminance("#0000ff") -
        1
    ) < 1e-12
  );

  const belowKnee = srgb8ToLinear(10);
  assert.ok(Math.abs(belowKnee - 10 / 255 / 12.92) < 1e-15);
  const aboveKnee = srgb8ToLinear(11);
  assert.ok(Math.abs(aboveKnee - ((11 / 255 + 0.055) / 1.055) ** 2.4) < 1e-15);

  assert.ok(Math.abs(contrastRatio("#ffffff", "#000000") - 21) < 1e-12);
  assert.equal(contrastRatio("#0b0f17", "#f8fafc"), contrastRatio("#f8fafc", "#0b0f17"));
  assert.equal(contrastRatio("#22ff88", "#22ff88"), 1);

  assert.throws(() => parseHexColor("rgba(0, 0, 0, 0.8)"));
  assert.throws(() => parseHexColor("#12345"));
  assert.throws(() => srgb8ToLinear(-1));
  assert.throws(() => srgb8ToLinear(256));
});

test("dark and light themes parsed from tokens.css achieve >= 4.5:1 WCAG AA (and AAA) for primary, secondary, muted, and verdict text across all surfaces", () => {
  assert.ok(Object.keys(rootTokens).length > 0, ":root must define design tokens");
  assert.deepEqual(rootTokens, darkSelectorTokens);

  for (const [themeName, themeOverrides, mergedTheme] of [
    ["dark", darkSelectorTokens, darkThemeTokens],
    ["light", lightOverrideTokens, lightThemeTokens]
  ] as const) {
    for (const requiredToken of [
      ...BG_SURFACE_TOKENS,
      "--text-primary",
      "--text-secondary",
      "--text-muted",
      "--focus-ring"
    ]) {
      assert.ok(
        requiredToken in themeOverrides,
        `[${themeName}] ${requiredToken} must be explicitly defined in tokens.css`
      );
    }

    const primaryHex = resolveCssToken(mergedTheme, "--text-primary");
    const secondaryHex = resolveCssToken(mergedTheme, "--text-secondary");
    const mutedHex = resolveCssToken(mergedTheme, "--text-muted");

    for (const bgToken of BG_SURFACE_TOKENS) {
      const bgHex = resolveCssToken(mergedTheme, bgToken);
      assertContrastAtLeast(
        themeName,
        "--text-primary",
        primaryHex,
        bgToken,
        bgHex,
        WCAG_AA_NORMAL_TEXT
      );
      assertContrastAtLeast(
        themeName,
        "--text-secondary",
        secondaryHex,
        bgToken,
        bgHex,
        WCAG_AA_NORMAL_TEXT
      );
      assertContrastAtLeast(
        themeName,
        "--text-muted",
        mutedHex,
        bgToken,
        bgHex,
        WCAG_AA_NORMAL_TEXT
      );
    }

    for (const level of VERDICT_LEVELS) {
      const fgToken = `--verdict-${level}-fg`;
      const bgToken = `--verdict-${level}-bg`;
      assertContrastAtLeast(
        themeName,
        fgToken,
        resolveCssToken(mergedTheme, fgToken),
        bgToken,
        resolveCssToken(mergedTheme, bgToken),
        WCAG_AA_NORMAL_TEXT
      );
    }

    assertContrastAtLeast(
      themeName,
      "--accent-fg",
      resolveCssToken(mergedTheme, "--accent-fg"),
      "--accent",
      resolveCssToken(mergedTheme, "--accent"),
      WCAG_AA_NORMAL_TEXT
    );
    assertContrastAtLeast(
      themeName,
      "--danger-fg",
      resolveCssToken(mergedTheme, "--danger-fg"),
      "--danger",
      resolveCssToken(mergedTheme, "--danger"),
      WCAG_AA_NORMAL_TEXT
    );
  }
});

test('[data-theme="high-contrast"] and @media (prefers-contrast: more) achieve >= 7.0:1 WCAG AAA across --bg-app, --bg-surface, and --bg-elevated', () => {
  assert.deepEqual(highContrastOverrideTokens, prefersContrastMoreOverrideTokens);
  assert.deepEqual(highContrastThemeTokens, prefersContrastMoreTokens);

  for (const requiredToken of [
    ...BG_SURFACE_TOKENS,
    "--text-primary",
    "--text-secondary",
    "--text-muted",
    "--focus-ring"
  ]) {
    assert.ok(
      requiredToken in highContrastOverrideTokens,
      `[high-contrast] ${requiredToken} must be explicitly defined in tokens.css`
    );
  }

  const primaryHex = resolveCssToken(highContrastThemeTokens, "--text-primary");
  const secondaryHex = resolveCssToken(highContrastThemeTokens, "--text-secondary");
  const mutedHex = resolveCssToken(highContrastThemeTokens, "--text-muted");

  for (const bgToken of BG_SURFACE_TOKENS) {
    const bgHex = resolveCssToken(highContrastThemeTokens, bgToken);
    assertContrastAtLeast(
      "high-contrast",
      "--text-primary",
      primaryHex,
      bgToken,
      bgHex,
      WCAG_AAA_NORMAL_TEXT
    );
    assertContrastAtLeast(
      "high-contrast",
      "--text-secondary",
      secondaryHex,
      bgToken,
      bgHex,
      WCAG_AAA_NORMAL_TEXT
    );
    assertContrastAtLeast(
      "high-contrast",
      "--text-muted",
      mutedHex,
      bgToken,
      bgHex,
      WCAG_AAA_NORMAL_TEXT
    );
  }

  for (const level of VERDICT_LEVELS) {
    const fgToken = `--verdict-${level}-fg`;
    const borderToken = `--verdict-${level}-border`;
    const bgToken = `--verdict-${level}-bg`;
    const bgHex = resolveCssToken(highContrastThemeTokens, bgToken);

    assertContrastAtLeast(
      "high-contrast",
      fgToken,
      resolveCssToken(highContrastThemeTokens, fgToken),
      bgToken,
      bgHex,
      WCAG_AAA_NORMAL_TEXT
    );
    assertContrastAtLeast(
      "high-contrast",
      borderToken,
      resolveCssToken(highContrastThemeTokens, borderToken),
      bgToken,
      bgHex,
      WCAG_AAA_NORMAL_TEXT
    );
  }

  assertContrastAtLeast(
    "high-contrast",
    "--accent-fg",
    resolveCssToken(highContrastThemeTokens, "--accent-fg"),
    "--accent",
    resolveCssToken(highContrastThemeTokens, "--accent"),
    WCAG_AAA_NORMAL_TEXT
  );
  assertContrastAtLeast(
    "high-contrast",
    "--danger-fg",
    resolveCssToken(highContrastThemeTokens, "--danger-fg"),
    "--danger",
    resolveCssToken(highContrastThemeTokens, "--danger"),
    WCAG_AAA_NORMAL_TEXT
  );
});

test("focus ring and non-text UI boundaries achieve >= 3.0:1 (WCAG 2.2 SC 1.4.11 & 2.4.11) across all 3 themes", () => {
  const focusVisibleDecls = collectSelectorDeclarations(appRules, ":focus-visible");
  const outlineSpec = focusVisibleDecls["outline"] ?? "";
  assert.ok(
    outlineSpec.includes("var(--focus-ring)"),
    "app.css :focus-visible must bind outline to var(--focus-ring)"
  );
  const outlineWidthMatch = /^(\d+(?:\.\d+)?)px\b/.exec(outlineSpec);
  assert.ok(outlineWidthMatch, `Expected pixel outline width in app.css, got: ${outlineSpec}`);
  assert.ok(
    Number.parseFloat(outlineWidthMatch[1]) >= 2,
    "Focus outline width must be >= 2px"
  );

  for (const [themeName, themeTokens] of [
    ["dark", darkThemeTokens],
    ["light", lightThemeTokens],
    ["high-contrast", highContrastThemeTokens]
  ] as const) {
    const focusRingHex = resolveCssToken(themeTokens, "--focus-ring");
    const borderStrongHex = resolveCssToken(themeTokens, "--border-strong");

    for (const bgToken of BG_SURFACE_TOKENS) {
      const bgHex = resolveCssToken(themeTokens, bgToken);
      assertContrastAtLeast(
        themeName,
        "--focus-ring",
        focusRingHex,
        bgToken,
        bgHex,
        WCAG_AA_NON_TEXT
      );
      assertContrastAtLeast(
        themeName,
        "--border-strong",
        borderStrongHex,
        bgToken,
        bgHex,
        WCAG_AA_NON_TEXT
      );
    }

    for (const level of VERDICT_LEVELS) {
      const borderToken = `--verdict-${level}-border`;
      const bgToken = `--verdict-${level}-bg`;
      assertContrastAtLeast(
        themeName,
        borderToken,
        resolveCssToken(themeTokens, borderToken),
        bgToken,
        resolveCssToken(themeTokens, bgToken),
        WCAG_AA_NON_TEXT
      );
    }
  }
});

test("Ray-Ban Display hud.css verdict, primary text, and focus colors achieve >= 7.0:1 WCAG AAA against pure #000000 waveguide background", () => {
  const hudRootDecls = collectSelectorDeclarations(hudRules, ".hud-root");
  const hudCustomTokens = collectCustomProperties(hudRootDecls);

  const hudBgHex = resolveCssToken(hudCustomTokens, "--hud-bg").toLowerCase();
  assert.equal(hudBgHex, "#000000");
  assert.equal(relativeLuminance(hudBgHex), 0);
  assert.equal((hudRootDecls["background-color"] ?? "").toLowerCase(), "#000000");

  const hudPrimaryFgHex = resolveCssToken(hudCustomTokens, "--hud-fg");
  assertContrastAtLeast(
    "hud-waveguide",
    "--hud-fg",
    hudPrimaryFgHex,
    "--hud-bg",
    hudBgHex,
    WCAG_AAA_NORMAL_TEXT
  );

  const hudFocusHex = resolveCssToken(hudCustomTokens, "--hud-focus");
  assertContrastAtLeast(
    "hud-waveguide",
    "--hud-focus",
    hudFocusHex,
    "--hud-bg",
    hudBgHex,
    WCAG_AAA_NORMAL_TEXT
  );

  for (const level of VERDICT_LEVELS) {
    const tokenName = `--hud-${level}`;
    const tokenHex = resolveCssToken(hudCustomTokens, tokenName).toLowerCase();
    assertContrastAtLeast(
      "hud-waveguide",
      tokenName,
      tokenHex,
      "--hud-bg",
      hudBgHex,
      WCAG_AAA_NORMAL_TEXT
    );

    const badgeDecls = collectSelectorDeclarations(hudRules, `.hud-badge--${level}`);
    const badgeColorHex = extractFirstHexLiteral(
      badgeDecls["color"] ?? "",
      `.hud-badge--${level} color`
    );
    const badgeBorderHex = extractFirstHexLiteral(
      badgeDecls["border"] ?? "",
      `.hud-badge--${level} border`
    );
    assert.equal(badgeColorHex, tokenHex);
    assert.equal(badgeBorderHex, tokenHex);
    assertContrastAtLeast(
      "hud-waveguide",
      `.hud-badge--${level}`,
      badgeColorHex,
      "#000000",
      hudBgHex,
      WCAG_AAA_NORMAL_TEXT
    );

    const cardDecls = collectSelectorDeclarations(hudRules, `.hud-card--${level}`);
    const cardBorderHex = extractFirstHexLiteral(
      cardDecls["border"] ?? "",
      `.hud-card--${level} border`
    );
    assert.equal(cardBorderHex, tokenHex);
    assertContrastAtLeast(
      "hud-waveguide",
      `.hud-card--${level}`,
      cardBorderHex,
      "#000000",
      hudBgHex,
      WCAG_AAA_NORMAL_TEXT
    );
  }

  for (const textSelector of [
    ".hud-headline",
    ".hud-topbar",
    ".hud-speech-caption",
    ".hud-coach-text",
    ".hud-coach-cue-badge",
    ".hud-standby-label",
    ".hud-action-btn"
  ]) {
    const decls = collectSelectorDeclarations(hudRules, textSelector);
    const fgHex = extractFirstHexLiteral(decls["color"] ?? "", `${textSelector} color`);
    assertContrastAtLeast(
      "hud-waveguide",
      textSelector,
      fgHex,
      "#000000",
      hudBgHex,
      WCAG_AAA_NORMAL_TEXT
    );
  }

  const focusedActionDecls = collectSelectorDeclarations(
    hudRules,
    '.hud-action-btn[data-focused="true"]'
  );
  const focusedOutlineHex = extractFirstHexLiteral(
    focusedActionDecls["outline"] ?? "",
    '.hud-action-btn[data-focused="true"] outline'
  );
  assert.equal(focusedOutlineHex, hudFocusHex.toLowerCase());
  assertContrastAtLeast(
    "hud-waveguide",
    '.hud-action-btn[data-focused="true"]',
    focusedOutlineHex,
    "#000000",
    hudBgHex,
    WCAG_AAA_NORMAL_TEXT
  );

  const allHudHexLiterals = new Set(
    Array.from(hudCssSource.matchAll(/#[0-9a-fA-F]{3,6}\b/g), (m) => m[0].toLowerCase())
  );
  assert.ok(allHudHexLiterals.has("#000000"));
  assert.ok(allHudHexLiterals.size >= 6);
  for (const hexLiteral of allHudHexLiterals) {
    if (hexLiteral === "#000000") continue;
    assertContrastAtLeast(
      "hud-waveguide-all-hex",
      hexLiteral,
      hexLiteral,
      "#000000",
      "#000000",
      WCAG_AAA_NORMAL_TEXT
    );
  }
});

test("wcagContrastTokens.test.ts contains zero comments and zero em dashes", () => {
  const selfSource = readFileSync(new URL(import.meta.url), "utf8");
  const lineCommentToken = String.fromCharCode(47, 47);
  const blockCommentOpen = String.fromCharCode(47, 42);
  const blockCommentClose = String.fromCharCode(42, 47);
  const emDash = String.fromCharCode(8212);

  assert.equal(selfSource.includes(lineCommentToken), false);
  assert.equal(selfSource.includes(blockCommentOpen), false);
  assert.equal(selfSource.includes(blockCommentClose), false);
  assert.equal(selfSource.includes(emDash), false);
});
