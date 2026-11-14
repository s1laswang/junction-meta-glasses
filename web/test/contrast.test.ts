type TestFn = (name: string, fn: () => void | Promise<void>) => Promise<void>;

type AssertStrict = {
  ok(value: unknown, message?: string): void;
  equal<T>(actual: T, expected: T, message?: string): void;
  deepEqual<T>(actual: T, expected: T, message?: string): void;
  throws(block: () => unknown, message?: string): void;
};

type FsModule = {
  readFileSync(path: URL | string, encoding: "utf8"): string;
};

const nodeTestSpec: string = "node:test";
const nodeAssertSpec: string = "node:assert/strict";
const nodeFsSpec: string = "node:fs";

const { test } = (await import(nodeTestSpec)) as { test: TestFn };
const assert = (await import(nodeAssertSpec)) as AssertStrict;
const { readFileSync } = (await import(nodeFsSpec)) as FsModule;

type TokenMap = Record<string, string>;

type ParsedCssRule = {
  media: string | null;
  selectors: string[];
  declarations: TokenMap;
};

type RgbChannels = {
  r: number;
  g: number;
  b: number;
};

function parseDeclarations(blockBody: string): TokenMap {
  const vars: TokenMap = {};
  for (const rawEntry of blockBody.split(";")) {
    const colonIndex = rawEntry.indexOf(":");
    if (colonIndex === -1) continue;
    const prop = rawEntry.slice(0, colonIndex).trim();
    const val = rawEntry.slice(colonIndex + 1).trim();
    if (prop.startsWith("--") && val.length > 0) {
      vars[prop] = val;
    }
  }
  return vars;
}

function parseCssRules(cssSource: string, media: string | null = null): ParsedCssRule[] {
  const rules: ParsedCssRule[] = [];
  let cursor = 0;
  const len = cssSource.length;

  while (cursor < len) {
    const openBrace = cssSource.indexOf("{", cursor);
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
    if (prelude.startsWith("@media")) {
      rules.push(...parseCssRules(inner, prelude));
    } else if (prelude.length > 0) {
      const selectors = prelude
        .split(",")
        .map((sel) => sel.trim())
        .filter((sel) => sel.length > 0);
      rules.push({
        media,
        selectors,
        declarations: parseDeclarations(inner)
      });
    }

    cursor = scan;
  }

  return rules;
}

function collectSelectorTokens(
  rules: ParsedCssRule[],
  selector: string,
  media: string | null = null
): TokenMap {
  const merged: TokenMap = {};
  for (const rule of rules) {
    if (rule.media === media && rule.selectors.includes(selector)) {
      Object.assign(merged, rule.declarations);
    }
  }
  return merged;
}

function resolveToken(tokens: TokenMap, primary: string, alias?: string): string {
  let raw: string | undefined = tokens[primary] ?? (alias ? tokens[alias] : undefined);
  let guard = 0;
  while (raw && raw.startsWith("var(") && raw.endsWith(")") && guard < 8) {
    const inner = raw.slice(4, -1).split(",")[0].trim();
    raw = tokens[inner];
    guard += 1;
  }
  if (!raw) {
    const label = alias ? `${primary} (or ${alias})` : primary;
    throw new Error(`Missing CSS token ${label}`);
  }
  return raw;
}

export function parseColor(input: string): RgbChannels {
  const trimmed = input.trim();
  if (trimmed.startsWith("#")) {
    const hex = trimmed.slice(1);
    if (/^[0-9a-fA-F]{3}$/.test(hex)) {
      return {
        r: Number.parseInt(hex[0] + hex[0], 16),
        g: Number.parseInt(hex[1] + hex[1], 16),
        b: Number.parseInt(hex[2] + hex[2], 16)
      };
    }
    if (/^[0-9a-fA-F]{6}$/.test(hex)) {
      return {
        r: Number.parseInt(hex.slice(0, 2), 16),
        g: Number.parseInt(hex.slice(2, 4), 16),
        b: Number.parseInt(hex.slice(4, 6), 16)
      };
    }
    throw new Error(`Unsupported hex color: ${input}`);
  }

  const rgbMatch = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i.exec(trimmed);
  if (rgbMatch) {
    const r = Number.parseInt(rgbMatch[1], 10);
    const g = Number.parseInt(rgbMatch[2], 10);
    const b = Number.parseInt(rgbMatch[3], 10);
    if (r <= 255 && g <= 255 && b <= 255) {
      return { r, g, b };
    }
  }

  throw new Error(`Unsupported CSS color value: ${input}`);
}

export function srgbChannelToLinear(channel8Bit: number): number {
  const srgb = channel8Bit / 255;
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(color: string): number {
  const { r, g, b } = parseColor(color);
  const R = srgbChannelToLinear(r);
  const G = srgbChannelToLinear(g);
  const B = srgbChannelToLinear(b);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

export function contrastRatio(colorA: string, colorB: string): number {
  const lumA = relativeLuminance(colorA);
  const lumB = relativeLuminance(colorB);
  const L1 = Math.max(lumA, lumB);
  const L2 = Math.min(lumA, lumB);
  return (L1 + 0.05) / (L2 + 0.05);
}

function parsePxValue(raw: string, tokenName: string): number {
  const match = /^(\d+(?:\.\d+)?)px$/.exec(raw.trim());
  if (!match) {
    throw new Error(`Expected pixel length for ${tokenName}, got ${raw}`);
  }
  return Number.parseFloat(match[1]);
}

function assertMinContrast(
  themeName: string,
  tokens: TokenMap,
  fgSpec: [string, string?],
  bgSpec: [string, string?],
  minRatio: number
): number {
  const fgColor = resolveToken(tokens, fgSpec[0], fgSpec[1]);
  const bgColor = resolveToken(tokens, bgSpec[0], bgSpec[1]);
  const ratio = contrastRatio(fgColor, bgColor);
  assert.ok(
    ratio >= minRatio,
    `[${themeName}] ${fgSpec[0]} (${fgColor}) on ${bgSpec[0]} (${bgColor}) contrast ${ratio.toFixed(2)}:1 < ${minRatio}:1`
  );
  return ratio;
}

const tokensCssUrl = new URL("../src/styles/tokens.css", import.meta.url);
const tokensCssSource = readFileSync(tokensCssUrl, "utf8");
const parsedRules = parseCssRules(tokensCssSource);

const rootTokens = collectSelectorTokens(parsedRules, ":root");
const explicitDarkTokens = collectSelectorTokens(parsedRules, '[data-theme="dark"]');
const darkTheme: TokenMap = { ...rootTokens, ...explicitDarkTokens };
const lightTheme: TokenMap = {
  ...rootTokens,
  ...collectSelectorTokens(parsedRules, '[data-theme="light"]')
};
const highContrastTheme: TokenMap = {
  ...rootTokens,
  ...collectSelectorTokens(parsedRules, '[data-theme="high-contrast"]')
};
const prefersContrastMoreTheme: TokenMap = {
  ...rootTokens,
  ...collectSelectorTokens(
    parsedRules,
    ":root:not([data-theme])",
    "@media (prefers-contrast: more)"
  )
};

const VERDICT_LEVELS = ["match", "warning", "unsure", "info"] as const;

test("WCAG 2.2 relative luminance and contrast ratio satisfy reference boundary laws", () => {
  assert.equal(relativeLuminance("#000000"), 0);
  assert.equal(relativeLuminance("#000"), 0);
  assert.ok(Math.abs(relativeLuminance("#ffffff") - 1) < 1e-12);
  assert.ok(Math.abs(relativeLuminance("#fff") - 1) < 1e-12);
  assert.ok(Math.abs(contrastRatio("#ffffff", "#000000") - 21) < 1e-12);
  assert.equal(contrastRatio("#121926", "#f8fafc"), contrastRatio("#f8fafc", "#121926"));
  assert.equal(contrastRatio("#5cc0ff", "#5cc0ff"), 1);

  const lowLinear = srgbChannelToLinear(10);
  const expectedLow = 10 / 255 / 12.92;
  assert.ok(Math.abs(lowLinear - expectedLow) < 1e-15);

  const highLinear = srgbChannelToLinear(11);
  const expectedHigh = ((11 / 255 + 0.055) / 1.055) ** 2.4;
  assert.ok(Math.abs(highLinear - expectedHigh) < 1e-15);

  assert.equal(relativeLuminance("rgb(248, 250, 252)"), relativeLuminance("#f8fafc"));
  assert.throws(() => parseColor("rgba(0, 0, 0, 0.5)"));
  assert.throws(() => parseColor("not-a-color"));
});

test(":root dark theme tokens achieve WCAG 2.2 AAA luminance contrast thresholds", () => {
  assert.ok(Object.keys(rootTokens).length > 0, ":root block must define tokens");
  assert.deepEqual(rootTokens, explicitDarkTokens);

  for (const bgToken of [
    ["--bg-app", "--bg-canvas"],
    ["--bg-surface"],
    ["--bg-elevated"]
  ] as Array<[string, string?]>) {
    assertMinContrast("dark", darkTheme, ["--text-primary"], bgToken, 14);
  }

  for (const bgToken of [
    ["--bg-app", "--bg-canvas"],
    ["--bg-surface"],
    ["--bg-elevated"]
  ] as Array<[string, string?]>) {
    assertMinContrast("dark", darkTheme, ["--text-secondary"], bgToken, 7);
  }

  for (const level of VERDICT_LEVELS) {
    assertMinContrast(
      "dark",
      darkTheme,
      [`--verdict-${level}-fg`, `--verdict-${level}-text`],
      [`--verdict-${level}-bg`],
      7
    );
    assertMinContrast(
      "dark",
      darkTheme,
      [`--verdict-${level}-border`],
      [`--verdict-${level}-bg`],
      3
    );
  }
});

test('[data-theme="light"] tokens achieve WCAG 2.2 AAA luminance contrast thresholds', () => {
  for (const bgToken of [
    ["--bg-app", "--bg-canvas"],
    ["--bg-surface"],
    ["--bg-elevated"]
  ] as Array<[string, string?]>) {
    assertMinContrast("light", lightTheme, ["--text-primary"], bgToken, 14);
  }

  for (const bgToken of [
    ["--bg-app", "--bg-canvas"],
    ["--bg-surface"],
    ["--bg-elevated"]
  ] as Array<[string, string?]>) {
    assertMinContrast("light", lightTheme, ["--text-secondary"], bgToken, 7);
  }

  for (const level of VERDICT_LEVELS) {
    assertMinContrast(
      "light",
      lightTheme,
      [`--verdict-${level}-fg`, `--verdict-${level}-text`],
      [`--verdict-${level}-bg`],
      7
    );
    assertMinContrast(
      "light",
      lightTheme,
      [`--verdict-${level}-border`],
      [`--verdict-${level}-bg`],
      3
    );
  }
});

test('[data-theme="high-contrast"] tokens achieve >= 19:1 text, >= 15:1 focus ring, and >= 56px tap target', () => {
  for (const bgToken of [
    ["--bg-app", "--bg-canvas"],
    ["--bg-surface"],
    ["--bg-elevated"]
  ] as Array<[string, string?]>) {
    assertMinContrast("high-contrast", highContrastTheme, ["--text-primary"], bgToken, 19);
  }

  for (const bgToken of [
    ["--bg-app", "--bg-canvas"],
    ["--bg-surface"]
  ] as Array<[string, string?]>) {
    assertMinContrast("high-contrast", highContrastTheme, ["--text-secondary"], bgToken, 19);
  }

  assertMinContrast(
    "high-contrast",
    highContrastTheme,
    ["--focus-ring"],
    ["--bg-app", "--bg-canvas"],
    15
  );
  assertMinContrast("high-contrast", highContrastTheme, ["--focus-ring"], ["--bg-surface"], 15);

  for (const level of VERDICT_LEVELS) {
    assertMinContrast(
      "high-contrast",
      highContrastTheme,
      [`--verdict-${level}-fg`, `--verdict-${level}-text`],
      [`--verdict-${level}-bg`],
      7
    );
    assertMinContrast(
      "high-contrast",
      highContrastTheme,
      [`--verdict-${level}-border`],
      [`--verdict-${level}-bg`],
      7
    );
  }

  const tapMinPx = parsePxValue(resolveToken(highContrastTheme, "--tap-min"), "--tap-min");
  assert.ok(tapMinPx >= 56, `Expected --tap-min >= 56px, got ${tapMinPx}px`);

  assert.deepEqual(prefersContrastMoreTheme, highContrastTheme);
});

test("muted text, accent buttons, danger actions, and focus rings stay accessible across all 3 themes", () => {
  for (const [themeName, themeTokens] of [
    ["dark", darkTheme],
    ["light", lightTheme],
    ["high-contrast", highContrastTheme]
  ] as const) {
    assertMinContrast(themeName, themeTokens, ["--text-muted"], ["--bg-app", "--bg-canvas"], 7);
    assertMinContrast(themeName, themeTokens, ["--text-muted"], ["--bg-surface"], 7);
    assertMinContrast(themeName, themeTokens, ["--accent-fg"], ["--accent"], 7);
    assertMinContrast(themeName, themeTokens, ["--danger-fg"], ["--danger"], 7);
    assertMinContrast(themeName, themeTokens, ["--focus-ring"], ["--bg-app", "--bg-canvas"], 9);
    assertMinContrast(themeName, themeTokens, ["--focus-ring"], ["--bg-surface"], 9);
  }
});
