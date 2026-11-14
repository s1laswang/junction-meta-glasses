type TestFn = (name: string, fn: () => void | Promise<void>) => Promise<void>;

interface AssertStrict {
  ok(value: unknown, message?: string): asserts value;
  equal<T>(actual: T, expected: T, message?: string): void;
  deepEqual<T>(actual: T, expected: T, message?: string): void;
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

const TEXT_SCALE_TOKENS = [
  "--text-xs",
  "--text-sm",
  "--text-base",
  "--text-lg",
  "--text-xl",
  "--text-2xl",
  "--text-3xl"
] as const;

const FOCUS_NOT_OBSCURED_SELECTORS = [
  ":target",
  "main[id]",
  "section[id]",
  '[role="tabpanel"]',
  "[tabindex]",
  "button",
  "a[href]",
  "input",
  "select",
  "textarea",
  "summary"
] as const;

function splitSelectors(prelude: string): string[] {
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
      const token = prelude.slice(start, i).trim();
      if (token.length > 0) {
        selectors.push(token);
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

function parseDeclarations(blockBody: string): CssDeclarationMap {
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
    } else if (!prelude.startsWith("@keyframes") && prelude.length > 0) {
      rules.push({
        media,
        selectors: splitSelectors(prelude),
        declarations: parseDeclarations(innerBody)
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

function parsePx(rawValue: string | undefined, label: string): number {
  assert.ok(rawValue, `Expected ${label} to be defined`);
  const match = /^(\d+(?:\.\d+)?)px$/.exec(rawValue.trim());
  assert.ok(match, `Expected px length for ${label}, received: ${rawValue}`);
  return Number.parseFloat(match[1]);
}

function parseRem(rawValue: string | undefined, label: string): number {
  assert.ok(rawValue, `Expected ${label} to be defined`);
  const match = /^(\d+(?:\.\d+)?)rem$/.exec(rawValue.trim());
  assert.ok(match, `Expected rem length for ${label}, received: ${rawValue}`);
  return Number.parseFloat(match[1]);
}

const tokensCssSource = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8");
const appCssSource = readFileSync(new URL("../src/styles/app.css", import.meta.url), "utf8");
const selfTestSource = readFileSync(new URL(import.meta.url), "utf8");

const tokenRules = parseCssRules(tokensCssSource);
const appRules = parseCssRules(appCssSource);

test("WCAG 2.2 SC 2.4.11 Focus Not Obscured sets scroll-padding-top and scroll-margin-top >= 96px across all interactive and landmark targets beneath sticky .app-header", () => {
  const headerDecls = collectSelectorDeclarations(appRules, ".app-header");
  assert.equal(headerDecls["position"], "sticky");
  assert.equal(headerDecls["top"], "0");

  const htmlScrollDecls = collectSelectorDeclarations(appRules, "html:not(:has(.hud-root))");
  const scrollPaddingPx = parsePx(
    htmlScrollDecls["scroll-padding-top"],
    "html:not(:has(.hud-root)) scroll-padding-top"
  );
  assert.ok(scrollPaddingPx >= 96);
  assert.equal(scrollPaddingPx, 128);

  for (const selector of FOCUS_NOT_OBSCURED_SELECTORS) {
    const decls = collectSelectorDeclarations(appRules, selector);
    const scrollMarginPx = parsePx(
      decls["scroll-margin-top"],
      `${selector} scroll-margin-top`
    );
    assert.ok(
      scrollMarginPx >= 96,
      `Expected ${selector} scroll-margin-top >= 96px, got ${scrollMarginPx}px`
    );
    assert.equal(scrollMarginPx, 128);
  }

  const skipLinkDecls = collectSelectorDeclarations(appRules, ".skip-link");
  assert.equal(skipLinkDecls["position"], "fixed");
  assert.equal(skipLinkDecls["min-height"], "var(--tap-min)");

  const skipFocusDecls = collectSelectorDeclarations(appRules, ".skip-link:focus-visible");
  assert.equal(skipFocusDecls["transform"], "translateY(0)");
});

test('low-vision typography scales [data-text-scale="125"] and [data-text-scale="150"] enforce strictly monotonic rem steps, exact 1.25x/1.5x ratios, and 60px/64px tap targets', () => {
  const rootDecls = collectSelectorDeclarations(tokenRules, ":root");
  const scale125Decls = collectSelectorDeclarations(appRules, '[data-text-scale="125"]');
  const scale150Decls = collectSelectorDeclarations(appRules, '[data-text-scale="150"]');

  const baseTapPx = parsePx(rootDecls["--tap-min"], ":root --tap-min");
  const tap125Px = parsePx(scale125Decls["--tap-min"], '[data-text-scale="125"] --tap-min');
  const tap150Px = parsePx(scale150Decls["--tap-min"], '[data-text-scale="150"] --tap-min');

  assert.equal(baseTapPx, 56);
  assert.equal(tap125Px, 60);
  assert.equal(tap150Px, 64);
  assert.ok(baseTapPx < tap125Px && tap125Px < tap150Px);

  const baseRems = TEXT_SCALE_TOKENS.map((token) =>
    parseRem(rootDecls[token], `:root ${token}`)
  );
  const scale125Rems = TEXT_SCALE_TOKENS.map((token) =>
    parseRem(scale125Decls[token], `[data-text-scale="125"] ${token}`)
  );
  const scale150Rems = TEXT_SCALE_TOKENS.map((token) =>
    parseRem(scale150Decls[token], `[data-text-scale="150"] ${token}`)
  );

  for (let i = 1; i < TEXT_SCALE_TOKENS.length; i += 1) {
    const prevToken = TEXT_SCALE_TOKENS[i - 1];
    const currToken = TEXT_SCALE_TOKENS[i];
    assert.ok(
      baseRems[i] > baseRems[i - 1],
      `:root ${currToken} (${baseRems[i]}rem) must exceed ${prevToken} (${baseRems[i - 1]}rem)`
    );
    assert.ok(
      scale125Rems[i] > scale125Rems[i - 1],
      `125% ${currToken} (${scale125Rems[i]}rem) must exceed ${prevToken} (${scale125Rems[i - 1]}rem)`
    );
    assert.ok(
      scale150Rems[i] > scale150Rems[i - 1],
      `150% ${currToken} (${scale150Rems[i]}rem) must exceed ${prevToken} (${scale150Rems[i - 1]}rem)`
    );
  }

  for (let i = 0; i < TEXT_SCALE_TOKENS.length; i += 1) {
    const token = TEXT_SCALE_TOKENS[i];
    const expected125 = baseRems[i] * 1.25;
    const expected150 = baseRems[i] * 1.5;

    assert.ok(
      Math.abs(scale125Rems[i] - expected125) < 1e-6,
      `[data-text-scale="125"] ${token} expected ${expected125}rem, got ${scale125Rems[i]}rem`
    );
    assert.ok(
      Math.abs(scale150Rems[i] - expected150) < 1e-6,
      `[data-text-scale="150"] ${token} expected ${expected150}rem, got ${scale150Rems[i]}rem`
    );
    assert.ok(baseRems[i] < scale125Rems[i] && scale125Rems[i] < scale150Rems[i]);
  }
});

test('calm cognitive density selector [data-cognitive-density="calm"] .cognitive-secondary hides secondary visual clutter even over inline display styles', () => {
  const calmSecondaryDecls = collectSelectorDeclarations(
    appRules,
    '[data-cognitive-density="calm"] .cognitive-secondary'
  );
  assert.equal(calmSecondaryDecls["display"], "none !important");
});

test("WCAG 2.2 SC 1.4.10 320px reflow guards prevent horizontal clipping across .app-shell, .app-header, .app-grid, .check-grid, .card, and .btn", () => {
  const shellDecls = collectSelectorDeclarations(appRules, ".app-shell");
  assert.equal(shellDecls["max-width"], "100%");
  assert.equal(shellDecls["overflow-x"], "clip");

  const footerDecls = collectSelectorDeclarations(appRules, ".app-footer");
  assert.equal(footerDecls["max-width"], "100%");
  assert.equal(footerDecls["overflow-x"], "clip");

  const headerDecls = collectSelectorDeclarations(appRules, ".app-header");
  assert.equal(headerDecls["width"], "100%");
  assert.equal(headerDecls["max-width"], "100%");
  assert.equal(headerDecls["min-width"], "0");
  assert.equal(headerDecls["flex-wrap"], "wrap");

  const navDecls = collectSelectorDeclarations(appRules, ".app-nav");
  assert.equal(navDecls["flex-wrap"], "wrap");
  assert.equal(navDecls["min-width"], "0");
  assert.equal(navDecls["max-width"], "100%");

  const gridDecls = collectSelectorDeclarations(appRules, ".app-grid");
  assert.equal(gridDecls["grid-template-columns"], "minmax(0, 1fr)");
  assert.equal(gridDecls["width"], "100%");

  const gridChildDecls = collectSelectorDeclarations(appRules, ".app-grid > *");
  assert.equal(gridChildDecls["min-width"], "0");

  const checkGridDecls = collectSelectorDeclarations(appRules, ".check-grid");
  assert.equal(checkGridDecls["min-width"], "0");
  assert.equal(checkGridDecls["max-width"], "100%");

  const checkGridChildDecls = collectSelectorDeclarations(appRules, ".check-grid > *");
  assert.equal(checkGridChildDecls["min-width"], "0");

  const tabpanelDecls = collectSelectorDeclarations(appRules, '[role="tabpanel"]');
  assert.equal(tabpanelDecls["min-width"], "0");
  assert.equal(tabpanelDecls["max-width"], "100%");

  const cardDecls = collectSelectorDeclarations(appRules, ".card");
  assert.equal(cardDecls["min-width"], "0");
  assert.equal(cardDecls["max-width"], "100%");
  assert.equal(cardDecls["overflow-wrap"], "break-word");

  const btnDecls = collectSelectorDeclarations(appRules, ".btn");
  assert.equal(btnDecls["min-height"], "var(--tap-min)");
  assert.equal(btnDecls["min-width"], "var(--tap-min)");
  assert.equal(btnDecls["max-width"], "100%");
  assert.equal(btnDecls["flex-wrap"], "wrap");
  assert.equal(btnDecls["white-space"], "normal");
  assert.equal(btnDecls["overflow-wrap"], "break-word");

  const narrowMedia = "@media (max-width: 360px)";
  const narrowHeader = collectSelectorDeclarations(appRules, ".app-header", narrowMedia);
  const narrowGrid = collectSelectorDeclarations(appRules, ".app-grid", narrowMedia);
  const narrowCheckGrid = collectSelectorDeclarations(appRules, ".check-grid", narrowMedia);
  const narrowCard = collectSelectorDeclarations(appRules, ".card", narrowMedia);
  const narrowBtn = collectSelectorDeclarations(appRules, ".btn", narrowMedia);
  const narrowBadge = collectSelectorDeclarations(appRules, ".badge", narrowMedia);

  assert.equal(narrowHeader["padding"], "var(--space-3)");
  assert.equal(narrowGrid["padding"], "var(--space-3)");
  assert.equal(narrowCheckGrid["gap"], "var(--space-4)");
  assert.equal(narrowCard["padding"], "var(--space-4)");
  assert.equal(narrowBtn["padding"], "var(--space-3) var(--space-4)");
  assert.equal(narrowBadge["white-space"], "normal");
  assert.equal(narrowBadge["overflow-wrap"], "break-word");
});

test("prefers-reduced-motion: reduce and forced-colors: active media queries preserve vestibular and high-contrast safety", () => {
  const reducedMotionMedia = "@media (prefers-reduced-motion: reduce)";
  const rmHtml = collectSelectorDeclarations(appRules, "html", reducedMotionMedia);
  assert.equal(rmHtml["scroll-behavior"], "auto");

  for (const selector of ["*", "*::before", "*::after"]) {
    const rmUniversal = collectSelectorDeclarations(appRules, selector, reducedMotionMedia);
    assert.equal(rmUniversal["animation-duration"], "0.01ms !important");
    assert.equal(rmUniversal["animation-iteration-count"], "1 !important");
    assert.equal(rmUniversal["transition-duration"], "0.01ms !important");
    assert.equal(rmUniversal["scroll-behavior"], "auto !important");
  }

  const rmLiveDot = collectSelectorDeclarations(appRules, ".privacy-live-dot", reducedMotionMedia);
  assert.equal(rmLiveDot["animation"], "none");
  assert.equal(rmLiveDot["box-shadow"], "none");

  const forcedColorsMedia = "@media (forced-colors: active)";
  const fcFocus = collectSelectorDeclarations(appRules, ":focus-visible", forcedColorsMedia);
  assert.equal(fcFocus["outline"], "3px solid Highlight");
  assert.equal(fcFocus["outline-offset"], "3px");

  for (const selector of [
    ".btn",
    ".card",
    ".badge",
    ".pill",
    ".chip",
    ".input",
    ".confidence-bar"
  ]) {
    const fcBordered = collectSelectorDeclarations(appRules, selector, forcedColorsMedia);
    assert.equal(fcBordered["border"], "2px solid CanvasText");
  }

  for (const selector of [".confidence-fill", ".privacy-live-dot"]) {
    const fcHighlight = collectSelectorDeclarations(appRules, selector, forcedColorsMedia);
    assert.equal(fcHighlight["background-color"], "Highlight");
    assert.equal(fcHighlight["forced-color-adjust"], "none");
  }
});

test("tokens.css, app.css, and wcag22LowVisionReflow.test.ts contain zero comments and zero em or en dashes", () => {
  const lineComment = String.fromCharCode(47, 47);
  const blockCommentOpen = String.fromCharCode(47, 42);
  const blockCommentClose = String.fromCharCode(42, 47);
  const emDash = String.fromCharCode(8212);
  const enDash = String.fromCharCode(8211);

  for (const [label, source] of [
    ["tokens.css", tokensCssSource],
    ["app.css", appCssSource],
    ["wcag22LowVisionReflow.test.ts", selfTestSource]
  ] as const) {
    assert.equal(source.includes(lineComment), false, `${label} must contain zero line comments`);
    assert.equal(
      source.includes(blockCommentOpen),
      false,
      `${label} must contain zero block comment openers`
    );
    assert.equal(
      source.includes(blockCommentClose),
      false,
      `${label} must contain zero block comment closers`
    );
    assert.equal(source.includes(emDash), false, `${label} must contain zero em dashes`);
    assert.equal(source.includes(enDash), false, `${label} must contain zero en dashes`);
  }
});
