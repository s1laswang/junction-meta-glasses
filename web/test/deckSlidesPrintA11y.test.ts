import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const DECK_URL = new URL("../../deck/index.html", import.meta.url);
const DECK_HTML = readFileSync(DECK_URL, "utf8");

const HTML_COMMENT_RE = new RegExp("<!--[\\s\\S]*?-->", "g");
const CSS_COMMENT_RE = new RegExp("\\x2f\\*[\\s\\S]*?\\*\\x2f", "g");

const CLEAN_HTML = DECK_HTML.replace(HTML_COMMENT_RE, "");

function extractTagContent(html: string, tagName: string): string {
  const re = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\x2f${tagName}>`, "i");
  const match = re.exec(html);
  assert.ok(match, `Expected <${tagName}> block in deck/index.html`);
  return match[1];
}

const RAW_STYLE = extractTagContent(CLEAN_HTML, "style");
const CLEAN_CSS = RAW_STYLE.replace(CSS_COMMENT_RE, "");
const INLINE_SCRIPT = extractTagContent(CLEAN_HTML, "script");

function parseAttributes(openTag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  for (const m of openTag.matchAll(attrRe)) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return attrs;
}

function decodeEntities(raw: string): string {
  const named: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
    "&nbsp;": " ",
    "&middot;": "\u00b7",
    "&ldquo;": "\u201c",
    "&rdquo;": "\u201d",
    "&lsquo;": "\u2018",
    "&rsquo;": "\u2019",
    "&ndash;": "\u2013",
    "&times;": "\u00d7",
  };
  return raw
    .replace(/&#(\d+);/g, (_all, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_all, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&[a-zA-Z0-9#]+;/g, (ent) => named[ent] ?? ent);
}

function stripTagsAndDecode(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]+>/g, ""));
}

type BalancedElement = {
  openTag: string;
  attrs: Record<string, string>;
  innerHtml: string;
  outerHtml: string;
};

function findBalancedElements(html: string, tagName: string): BalancedElement[] {
  const results: BalancedElement[] = [];
  const tokenRe = new RegExp(`<(\x2f)?${tagName}\\b[^>]*>`, "gi");
  let depth = 0;
  let startIdx = -1;
  let openTag = "";
  let innerStart = -1;

  for (const match of html.matchAll(tokenRe)) {
    const token = match[0];
    const isClose = Boolean(match[1]);
    const selfClosing = !isClose && token.endsWith("\x2f>");
    const idx = match.index ?? 0;

    if (!isClose) {
      if (selfClosing) {
        if (depth === 0) {
          results.push({
            openTag: token,
            attrs: parseAttributes(token),
            innerHtml: "",
            outerHtml: token,
          });
        }
        continue;
      }
      if (depth === 0) {
        startIdx = idx;
        openTag = token;
        innerStart = idx + token.length;
      }
      depth++;
    } else if (depth > 0) {
      depth--;
      if (depth === 0) {
        results.push({
          openTag,
          attrs: parseAttributes(openTag),
          innerHtml: html.slice(innerStart, idx),
          outerHtml: html.slice(startIdx, idx + token.length),
        });
      }
    }
  }

  assert.equal(depth, 0, `Unbalanced <${tagName}> tags in deck/index.html`);
  return results;
}

function findAllBalancedElements(html: string, tagName: string): BalancedElement[] {
  const out: BalancedElement[] = [];
  for (const el of findBalancedElements(html, tagName)) {
    out.push(el, ...findAllBalancedElements(el.innerHtml, tagName));
  }
  return out;
}

function hasClass(attrs: Record<string, string>, className: string): boolean {
  return (attrs.class ?? "").trim().split(/\s+/).includes(className);
}

function extractCssBlock(css: string, header: RegExp): string {
  const match = header.exec(css);
  assert.ok(match, `Missing CSS block matching ${String(header)}`);
  const openIdx = css.indexOf("{", match.index + match[0].length - 1);
  assert.ok(openIdx >= 0, `Missing opening brace for ${String(header)}`);
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

function parseCustomProperties(cssBlock: string): Record<string, string> {
  const props: Record<string, string> = {};
  const re = /--([a-zA-Z0-9-]+)\s*:\s*([^;]+);/g;
  for (const m of cssBlock.matchAll(re)) {
    props[`--${m[1]}`] = m[2].trim();
  }
  return props;
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.trim().replace(/^#/, "");
  if (clean.length === 3) {
    return [
      Number.parseInt(clean[0] + clean[0], 16),
      Number.parseInt(clean[1] + clean[1], 16),
      Number.parseInt(clean[2] + clean[2], 16),
    ];
  }
  assert.equal(clean.length, 6, `Expected 3 or 6 hex digits, got ${hex}`);
  return [
    Number.parseInt(clean.slice(0, 2), 16),
    Number.parseInt(clean.slice(2, 4), 16),
    Number.parseInt(clean.slice(4, 6), 16),
  ];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((ch) => {
    const s = ch / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(fgHex: string, bgHex: string): number {
  const l1 = relativeLuminance(fgHex);
  const l2 = relativeLuminance(bgHex);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

const SLIDE_SECTIONS = findBalancedElements(CLEAN_HTML, "section").filter((el) => hasClass(el.attrs, "slide"));

function extractSlideHeading(slideInnerHtml: string): { tag: string; id: string; text: string } {
  const headingRe = /<(h1|h2)\b([^>]*)>([\s\S]*?)<\x2f\1>/gi;
  const matches = [...slideInnerHtml.matchAll(headingRe)];
  assert.equal(matches.length, 1, "Each slide must contain exactly one primary h1 or h2 heading");
  const tag = matches[0][1].toLowerCase();
  const attrs = parseAttributes(`<${tag} ${matches[0][2]}>`);
  const text = stripTagsAndDecode(matches[0][3]).trim();
  return { tag, id: attrs.id ?? "", text };
}

describe("deck/index.html structural & WCAG 2.2 AA invariants", () => {
  test("declares lang=en, zoom-safe viewport, unique document IDs, and 12 slides with valid aria-labelledby h1/h2 headings", () => {
    assert.match(CLEAN_HTML, /^\s*<!doctype html>/i);
    const htmlMatch = /<html\b[^>]*>/i.exec(CLEAN_HTML);
    assert.ok(htmlMatch, "Expected <html> root tag");
    assert.equal(parseAttributes(htmlMatch[0]).lang, "en");

    const metaTags = [...CLEAN_HTML.matchAll(/<meta\b[^>]*>/gi)].map((m) => parseAttributes(m[0]));
    assert.ok(metaTags.some((m) => m.charset?.toLowerCase() === "utf-8"));
    const viewport = metaTags.find((m) => m.name?.toLowerCase() === "viewport")?.content ?? "";
    assert.match(viewport, /width=device-width/i);
    assert.match(viewport, /initial-scale=1\b/i);
    assert.doesNotMatch(viewport, /user-scalable\s*=\s*(?:no|0|false)/i);
    assert.doesNotMatch(viewport, /maximum-scale\s*=\s*1(?:\.0)?\b/i);

    assert.doesNotMatch(CLEAN_HTML, /\btabindex\s*=\s*["']?[1-9]/i);

    const allIds: string[] = [];
    for (const tagMatch of CLEAN_HTML.matchAll(/<[a-zA-Z0-9:-]+\b[^>]*\bid\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>/g)) {
      const idVal = tagMatch[1] ?? tagMatch[2] ?? "";
      assert.ok(idVal.length > 0, "Element id attribute must not be empty");
      allIds.push(idVal);
    }
    const uniqueIds = new Set(allIds);
    assert.equal(uniqueIds.size, allIds.length, "Every id in deck/index.html must be unique");

    const mainTags = findBalancedElements(CLEAN_HTML, "main");
    assert.equal(mainTags.length, 1);
    assert.equal(mainTags[0].attrs.id, "deck");
    assert.equal(mainTags[0].attrs["aria-roledescription"], "slide deck");
    assert.ok((mainTags[0].attrs["aria-label"] ?? "").trim().length > 0);

    assert.equal(SLIDE_SECTIONS.length, 12, "Deck must contain exact 12 <section class=\"slide\"> elements");

    SLIDE_SECTIONS.forEach((slide, idx) => {
      const expectedId = `s${idx + 1}-h`;
      assert.equal(slide.attrs["aria-roledescription"], "slide", `Slide ${idx + 1} aria-roledescription`);
      assert.equal(slide.attrs["aria-labelledby"], expectedId, `Slide ${idx + 1} aria-labelledby`);

      const heading = extractSlideHeading(slide.innerHtml);
      assert.ok(heading.tag === "h1" || heading.tag === "h2", `Slide ${idx + 1} heading tag must be h1 or h2`);
      if (idx === 0) {
        assert.equal(heading.tag, "h1", "Slide 1 must carry the deck h1");
      } else {
        assert.equal(heading.tag, "h2", `Slide ${idx + 1} must use h2`);
      }
      assert.equal(heading.id, expectedId, `Slide ${idx + 1} heading id must match aria-labelledby`);
      assert.ok(heading.text.length >= 5, `Slide ${idx + 1} heading text must be non-empty`);

      const pgMatch = /<span\s+class="pg">(\d+)<\x2fspan>/.exec(slide.innerHtml);
      assert.equal(pgMatch?.[1], String(idx + 1), `Slide ${idx + 1} footer .pg number`);
    });
  });

  test("enforces #live polite atomic sr-only region, 44x44 #nav buttons, 3px :focus-visible outline, prefers-contrast: more, and prefers-reduced-motion: reduce", () => {
    const progressMatch = /<div\b[^>]*\bid="progress"[^>]*><\x2fdiv>/i.exec(CLEAN_HTML);
    assert.ok(progressMatch, "Expected #progress bar element");
    assert.equal(parseAttributes(progressMatch[0])["aria-hidden"], "true");

    const liveMatch = /<p\b[^>]*\bid="live"[^>]*>([\s\S]*?)<\x2fp>/i.exec(CLEAN_HTML);
    assert.ok(liveMatch, "Expected #live announcer element");
    const liveAttrs = parseAttributes(liveMatch[0]);
    assert.ok(hasClass(liveAttrs, "sr-only"), "#live must have sr-only class");
    assert.equal(liveAttrs["aria-live"], "polite");
    assert.equal(liveAttrs["aria-atomic"], "true");
    assert.equal(liveMatch[1].trim(), "");

    const navElements = findBalancedElements(CLEAN_HTML, "nav");
    assert.equal(navElements.length, 1);
    assert.equal(navElements[0].attrs.id, "nav");
    assert.equal(navElements[0].attrs["aria-label"], "Slide navigation");

    const navButtons = findBalancedElements(navElements[0].innerHtml, "button");
    assert.equal(navButtons.length, 2);
    assert.equal(navButtons[0].attrs.id, "prev");
    assert.equal(navButtons[0].attrs.type, "button");
    assert.equal(navButtons[0].attrs["aria-label"], "Previous slide");
    assert.equal(navButtons[1].attrs.id, "next");
    assert.equal(navButtons[1].attrs.type, "button");
    assert.equal(navButtons[1].attrs["aria-label"], "Next slide");

    const countMatch = /<span\b[^>]*\bid="count"[^>]*>([\s\S]*?)<\x2fspan>/i.exec(navElements[0].innerHtml);
    assert.ok(countMatch, "Expected #count status inside #nav");
    assert.equal(parseAttributes(countMatch[0])["aria-hidden"], "true");
    assert.equal(countMatch[1].trim(), "1 / 12");

    const srOnlyCss = extractCssBlock(CLEAN_CSS, /\.sr-only\s*\{/);
    assert.match(srOnlyCss, /position\s*:\s*absolute\s*!important/i);
    assert.match(srOnlyCss, /width\s*:\s*1px/i);
    assert.match(srOnlyCss, /height\s*:\s*1px/i);
    assert.match(srOnlyCss, /overflow\s*:\s*hidden/i);
    assert.match(srOnlyCss, /clip\s*:\s*rect\(0\s+0\s+0\s+0\)/i);
    assert.match(srOnlyCss, /white-space\s*:\s*nowrap/i);

    const navBtnCss = extractCssBlock(CLEAN_CSS, /#nav\s+button\s*\{/);
    const minW = /min-width\s*:\s*(\d+)px/i.exec(navBtnCss);
    const minH = /min-height\s*:\s*(\d+)px/i.exec(navBtnCss);
    assert.ok(minW && Number(minW[1]) >= 44, "#nav button min-width must be >= 44px");
    assert.ok(minH && Number(minH[1]) >= 44, "#nav button min-height must be >= 44px");
    assert.equal(Number(minW[1]), 44);
    assert.equal(Number(minH[1]), 44);

    const focusCss = extractCssBlock(CLEAN_CSS, /:focus-visible\s*\{/);
    assert.match(focusCss, /outline\s*:\s*3px\s+solid\s+var\(--accent\)/i);
    assert.match(focusCss, /outline-offset\s*:\s*3px/i);

    const rootVars = parseCustomProperties(extractCssBlock(CLEAN_CSS, /:root\s*\{/));
    assert.match(rootVars["--font"] ?? "", /Atkinson Hyperlegible Next/);
    assert.match(rootVars["--mono"] ?? "", /Atkinson Hyperlegible Mono/);
    for (const token of ["--text", "--muted", "--accent", "--match", "--warning", "--unsure"]) {
      const hex = rootVars[token];
      assert.ok(hex, `Expected ${token} in :root`);
      assert.ok(
        contrastRatio(hex, rootVars["--bg"]) >= 4.5,
        `${token} (${hex}) must meet >= 4.5:1 AA contrast on --bg (${rootVars["--bg"]})`,
      );
      assert.ok(
        contrastRatio(hex, rootVars["--surface"]) >= 4.5,
        `${token} (${hex}) must meet >= 4.5:1 AA contrast on --surface (${rootVars["--surface"]})`,
      );
    }
    assert.ok(contrastRatio(rootVars["--on-accent"], rootVars["--accent"]) >= 7);

    const moreContrastOuter = extractCssBlock(CLEAN_CSS, /@media\s*\(\s*prefers-contrast\s*:\s*more\s*\)\s*\{/);
    const moreVars = parseCustomProperties(extractCssBlock(moreContrastOuter, /:root\s*\{/));
    for (const token of [
      "--bg",
      "--surface",
      "--surface-2",
      "--border",
      "--text",
      "--muted",
      "--accent",
      "--match",
      "--warning",
      "--unsure",
    ]) {
      assert.ok(moreVars[token], `Expected ${token} override in @media (prefers-contrast: more)`);
    }
    for (const fg of ["--text", "--muted", "--accent", "--match", "--warning", "--unsure"]) {
      assert.ok(
        contrastRatio(moreVars[fg], moreVars["--bg"]) >= 7,
        `High-contrast ${fg} (${moreVars[fg]}) must meet >= 7:1 AAA on ${moreVars["--bg"]}`,
      );
    }
    assert.ok(contrastRatio(moreVars["--border"], moreVars["--bg"]) >= 7);

    const reducedMotionOuter = extractCssBlock(CLEAN_CSS, /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)\s*\{/);
    const reducedProgressCss = extractCssBlock(reducedMotionOuter, /#progress\s*\{/);
    assert.match(reducedProgressCss, /transition\s*:\s*none\b/i);
  });

  test("every <svg> in deck/index.html is either aria-hidden=\"true\" or role=\"img\" with valid non-empty <title>/<desc> aria-labelledby targets", () => {
    const svgs = findBalancedElements(CLEAN_HTML, "svg");
    assert.ok(svgs.length >= 10, `Expected at least 10 SVGs in deck/index.html, found ${svgs.length}`);

    let decorativeCount = 0;
    let informativeCount = 0;

    svgs.forEach((svg, idx) => {
      const ariaHidden = svg.attrs["aria-hidden"];
      const role = svg.attrs.role;

      if (ariaHidden === "true") {
        decorativeCount++;
        assert.notEqual(role, "img", `SVG #${idx + 1} must not combine aria-hidden="true" with role="img"`);
        return;
      }

      assert.equal(
        role,
        "img",
        `Non-hidden SVG #${idx + 1} must declare role="img" or aria-hidden="true"`,
      );
      informativeCount++;

      const labelledBy = (svg.attrs["aria-labelledby"] ?? "").trim();
      assert.ok(labelledBy.length > 0, `SVG #${idx + 1} with role="img" must provide aria-labelledby`);
      const refIds = labelledBy.split(/\s+/);

      const titles = findBalancedElements(svg.innerHtml, "title");
      const descs = findBalancedElements(svg.innerHtml, "desc");
      const labelNodes = new Map<string, { tag: "title" | "desc"; text: string }>();
      for (const t of titles) {
        if (t.attrs.id) labelNodes.set(t.attrs.id, { tag: "title", text: stripTagsAndDecode(t.innerHtml).trim() });
      }
      for (const d of descs) {
        if (d.attrs.id) labelNodes.set(d.attrs.id, { tag: "desc", text: stripTagsAndDecode(d.innerHtml).trim() });
      }

      let hasTitle = false;
      for (const refId of refIds) {
        const target = labelNodes.get(refId);
        assert.ok(target, `SVG #${idx + 1} aria-labelledby target #${refId} must be a <title> or <desc> inside that SVG`);
        assert.ok(target.text.length > 0, `SVG #${idx + 1} #${refId} (${target.tag}) must have non-empty accessible text`);
        if (target.tag === "title") hasTitle = true;
      }
      assert.ok(hasTitle, `SVG #${idx + 1} with role="img" must reference at least one <title>`);
    });

    assert.ok(decorativeCount >= 8, "Expected decorative icon SVGs with aria-hidden=\"true\"");
    assert.ok(informativeCount >= 2, "Expected informative diagram SVGs with role=\"img\"");

    const slide7 = SLIDE_SECTIONS[6];
    const barsChart = findAllBalancedElements(slide7.innerHtml, "div").find((d) => hasClass(d.attrs, "bars"));
    assert.ok(barsChart, "Slide 7 must expose .bars latency chart");
    assert.equal(barsChart.attrs.role, "img");
    assert.equal(barsChart.attrs["aria-labelledby"], "s7-chart-t");
    const chartLabel = findAllBalancedElements(barsChart.innerHtml, "span").find((sp) => sp.attrs.id === "s7-chart-t");
    assert.ok(chartLabel && hasClass(chartLabel.attrs, "sr-only"), "Slide 7 chart must include #s7-chart-t.sr-only");
    assert.ok(stripTagsAndDecode(chartLabel.innerHtml).trim().length > 20);

    const slide9 = SLIDE_SECTIONS[8];
    const tables = findBalancedElements(slide9.innerHtml, "table");
    assert.equal(tables.length, 1, "Slide 9 must include 1 resilience table");
    const captions = findBalancedElements(tables[0].innerHtml, "caption");
    assert.equal(captions.length, 1, "Slide 9 table must include accessible <caption>");
    assert.ok(hasClass(captions[0].attrs, "sr-only"));
    assert.ok(stripTagsAndDecode(captions[0].innerHtml).trim().length > 5);
    const ths = findBalancedElements(tables[0].innerHtml, "th");
    assert.equal(ths.length, 2);
    ths.forEach((th) => assert.equal(th.attrs.scope, "col"));
  });

  test("Slide 4 verdict rows combine distinct SVG shapes, uppercase Match / Warning / Not sure words, and CSS --vc color variables", () => {
    const vrowCss = extractCssBlock(CLEAN_CSS, /\.vrow\s*\{/);
    assert.match(vrowCss, /border-left\s*:\s*6px\s+solid\s+var\(--vc\)/i);

    const vrowWordCss = extractCssBlock(CLEAN_CSS, /\.vrow\s+\.w\s*\{/);
    assert.match(vrowWordCss, /color\s*:\s*var\(--vc\)/i);
    assert.match(vrowWordCss, /text-transform\s*:\s*uppercase/i);

    assert.match(extractCssBlock(CLEAN_CSS, /\.vrow\.match\s*\{/), /--vc\s*:\s*var\(--match\)/);
    assert.match(extractCssBlock(CLEAN_CSS, /\.vrow\.warning\s*\{/), /--vc\s*:\s*var\(--warning\)/);
    assert.match(extractCssBlock(CLEAN_CSS, /\.vrow\.unsure\s*\{/), /--vc\s*:\s*var\(--unsure\)/);

    const slide4 = SLIDE_SECTIONS[3];
    assert.equal(slide4.attrs["aria-labelledby"], "s4-h");

    const divsOnSlide4 = findBalancedElements(slide4.innerHtml, "div");
    const verdictsList = divsOnSlide4.find((d) => hasClass(d.attrs, "verdicts"));
    assert.ok(verdictsList, "Slide 4 must contain .verdicts list container");
    assert.equal(verdictsList.attrs.role, "list");
    assert.ok((verdictsList.attrs["aria-label"] ?? "").trim().length > 0);

    const vrows = findBalancedElements(verdictsList.innerHtml, "div").filter((d) => hasClass(d.attrs, "vrow"));
    assert.equal(vrows.length, 3, "Slide 4 .verdicts must contain exact 3 .vrow items");

    const expected: Array<{ cls: string; word: string; shapeCheck: RegExp }> = [
      { cls: "match", word: "Match", shapeCheck: /<circle\b/ },
      { cls: "warning", word: "Warning", shapeCheck: /M36 5l33 60H3z/ },
      { cls: "unsure", word: "Not sure", shapeCheck: /M36 3l33 33-33 33L3 36z/ },
    ];

    const svgGeometries = new Set<string>();

    expected.forEach((spec, idx) => {
      const row = vrows[idx];
      assert.equal(row.attrs.role, "listitem");
      assert.ok(hasClass(row.attrs, spec.cls), `Expected .vrow.${spec.cls} on verdict row ${idx + 1}`);

      const rowSvgs = findBalancedElements(row.innerHtml, "svg");
      assert.equal(rowSvgs.length, 1, `Verdict row ${spec.cls} must have exactly 1 shape SVG`);
      assert.equal(rowSvgs[0].attrs["aria-hidden"], "true");
      assert.match(rowSvgs[0].innerHtml, spec.shapeCheck, `Verdict row ${spec.cls} must use distinct icon shape`);
      svgGeometries.add(rowSvgs[0].innerHtml.replace(/\s+/g, " ").trim());

      const wordMatch = /<span\s+class="w">([^<]+)<\x2fspan>/.exec(row.innerHtml);
      assert.equal(wordMatch?.[1]?.trim(), spec.word, `Verdict row ${spec.cls} explicit word`);

      const quoteMatch = /<q>([\s\S]*?)<\x2fq>/.exec(row.innerHtml);
      assert.ok((quoteMatch?.[1]?.trim().length ?? 0) > 15, `Verdict row ${spec.cls} spoken quote must be non-empty`);
    });

    assert.equal(svgGeometries.size, 3, "All 3 verdict rows must render pairwise-distinct SVG shapes");
  });

  test("enforces 16:9 print handout contract (@page 13.333in x 7.5in margin 0 and @media print slide/nav/progress rules)", () => {
    const pageBlock = extractCssBlock(CLEAN_CSS, /@page\s*\{/);
    assert.match(pageBlock, /size\s*:\s*13\.333in\s+7\.5in\s*;/i);
    assert.match(pageBlock, /margin\s*:\s*0\s*;/i);

    const printCss = extractCssBlock(CLEAN_CSS, /@media\s+print\s*\{/);
    assert.match(printCss, /print-color-adjust\s*:\s*exact/i);

    const printDeckBlock = extractCssBlock(printCss, /#deck\s*\{/);
    assert.match(printDeckBlock, /transform\s*:\s*none\s*!important/i);

    const printSlidesBlock = extractCssBlock(printCss, /\.slide\s*,\s*\.slide\[hidden\]\s*\{/);
    assert.match(printSlidesBlock, /display\s*:\s*flex\s*!important/i);
    assert.match(printSlidesBlock, /position\s*:\s*relative/i);
    assert.match(printSlidesBlock, /break-after\s*:\s*page/i);

    const lastSlideBlock = extractCssBlock(printCss, /\.slide:last-child\s*\{/);
    assert.match(lastSlideBlock, /break-after\s*:\s*auto/i);

    const hiddenChromeBlock = extractCssBlock(printCss, /#nav\s*,\s*#progress\s*\{/);
    assert.match(hiddenChromeBlock, /display\s*:\s*none\s*!important/i);

    const footerPageBlock = extractCssBlock(printCss, /\.foot\s+\.pg\s*\{/);
    assert.match(footerPageBlock, /visibility\s*:\s*visible/i);
  });
});

type KeydownInit = {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  targetTag?: "body" | "button";
};

type MockSlide = {
  index: number;
  headingText: string;
  hidden: boolean;
  attrs: Map<string, string>;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  querySelector(selector: string): { textContent: string } | null;
};

function createDeckHarness(opts: { initialHash?: string; innerWidth?: number; innerHeight?: number } = {}) {
  const slideHeadings = SLIDE_SECTIONS.map((s) => extractSlideHeading(s.innerHtml).text);
  const slides: MockSlide[] = slideHeadings.map((headingText, index) => {
    const attrs = new Map<string, string>();
    return {
      index,
      headingText,
      hidden: false,
      attrs,
      setAttribute(name: string, value: string) {
        attrs.set(name, String(value));
      },
      getAttribute(name: string) {
        return attrs.get(name) ?? null;
      },
      querySelector(selector: string) {
        if (selector === "h1, h2") return { textContent: headingText };
        return null;
      },
    };
  });

  const deck = { style: { transform: "" } };
  const bar = { style: { width: "" } };
  const count = { textContent: "1 / 12" };

  let liveText = "";
  const liveWrites: string[] = [];
  const live = {
    get textContent() {
      return liveText;
    },
    set textContent(val: string) {
      liveText = String(val);
      liveWrites.push(liveText);
    },
  };

  const buttonListeners: Record<"prev" | "next", Array<() => void>> = { prev: [], next: [] };
  const makeNavButton = (id: "prev" | "next") => ({
    id,
    addEventListener(type: string, fn: () => void) {
      if (type === "click") buttonListeners[id].push(fn);
    },
    closest(selector: string) {
      return selector === "button" ? this : null;
    },
  });
  const prevBtn = makeNavButton("prev");
  const nextBtn = makeNavButton("next");

  const docListeners = new Map<string, Array<(ev: unknown) => void>>();
  const winListeners = new Map<string, Array<(ev?: unknown) => void>>();

  const locationObj = {
    hash: opts.initialHash ?? "",
  };

  const replaceStateCalls: Array<{ data: unknown; unused: string; url: string }> = [];
  const historyObj = {
    replaceState(data: unknown, unused: string, url: string) {
      replaceStateCalls.push({ data, unused, url });
      if (typeof url === "string" && url.startsWith("#")) {
        locationObj.hash = url;
      }
    },
  };

  const elementsById: Record<string, unknown> = {
    deck,
    live,
    count,
    progress: bar,
    prev: prevBtn,
    next: nextBtn,
  };

  const documentObj = {
    querySelectorAll(selector: string) {
      return selector === ".slide" ? slides : [];
    },
    getElementById(id: string) {
      return elementsById[id] ?? null;
    },
    addEventListener(type: string, fn: (ev: unknown) => void) {
      const list = docListeners.get(type) ?? [];
      list.push(fn);
      docListeners.set(type, list);
    },
  };

  const windowObj = {
    innerWidth: opts.innerWidth ?? 1280,
    innerHeight: opts.innerHeight ?? 720,
    addEventListener(type: string, fn: (ev?: unknown) => void) {
      const list = winListeners.get(type) ?? [];
      list.push(fn);
      winListeners.set(type, list);
    },
  };

  const context = vm.createContext({
    document: documentObj,
    window: windowObj,
    location: locationObj,
    history: historyObj,
    Math,
    Number,
    parseInt,
  });

  vm.runInContext(INLINE_SCRIPT, context, { filename: "deck/index.html" });

  return {
    slides,
    slideHeadings,
    deck,
    bar,
    count,
    live,
    liveWrites,
    location: locationObj,
    replaceStateCalls,
    window: windowObj,
    visibleSlideIndices(): number[] {
      return slides.filter((s) => !s.hidden).map((s) => s.index);
    },
    clickPrev() {
      for (const fn of buttonListeners.prev) fn();
    },
    clickNext() {
      for (const fn of buttonListeners.next) fn();
    },
    pressKey(init: KeydownInit | string): { defaultPrevented: boolean } {
      const normalized: KeydownInit = typeof init === "string" ? { key: init } : init;
      const target =
        normalized.targetTag === "button"
          ? nextBtn
          : {
              closest() {
                return null;
              },
            };
      const ev = {
        key: normalized.key,
        altKey: Boolean(normalized.altKey),
        ctrlKey: Boolean(normalized.ctrlKey),
        metaKey: Boolean(normalized.metaKey),
        target,
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
      };
      for (const fn of docListeners.get("keydown") ?? []) fn(ev);
      return { defaultPrevented: ev.defaultPrevented };
    },
    dispatchWindow(type: "resize" | "beforeprint" | "afterprint") {
      for (const fn of winListeners.get(type) ?? []) fn();
    },
  };
}

describe("deck/index.html inline controller execution in node:vm", () => {
  test("initial hash #5 selects Slide 5 without unsolicited live announcement, labels all 12 slides, and scales #deck", () => {
    const h = createDeckHarness({ initialHash: "#5", innerWidth: 1920, innerHeight: 1080 });

    assert.deepEqual(h.visibleSlideIndices(), [4]);
    assert.equal(h.slides[4].hidden, false);
    h.slides.forEach((s, idx) => {
      assert.equal(s.hidden, idx !== 4, `Slide ${idx + 1} hidden state at #5`);
      assert.equal(s.getAttribute("aria-label"), `Slide ${idx + 1} of 12`);
    });
    assert.equal(h.count.textContent, "5 / 12");
    assert.equal(h.bar.style.width, `${(5 / 12) * 100}%`);
    assert.equal(h.location.hash, "#5");
    assert.equal(h.replaceStateCalls.length, 0);
    assert.equal(h.live.textContent, "");
    assert.equal(h.liveWrites.length, 0);
    assert.equal(h.deck.style.transform, "scale(1.5)");

    h.window.innerWidth = 640;
    h.window.innerHeight = 720;
    h.dispatchWindow("resize");
    assert.equal(h.deck.style.transform, "scale(0.5)");

    const defaultDeck = createDeckHarness({ initialHash: "" });
    assert.deepEqual(defaultDeck.visibleSlideIndices(), [0]);
    assert.equal(defaultDeck.count.textContent, "1 / 12");
    assert.equal(defaultDeck.location.hash, "#1");

    const invalidHashDeck = createDeckHarness({ initialHash: "#not-a-number" });
    assert.deepEqual(invalidHashDeck.visibleSlideIndices(), [0]);
    assert.equal(invalidHashDeck.count.textContent, "1 / 12");

    const clampedHighDeck = createDeckHarness({ initialHash: "#99" });
    assert.deepEqual(clampedHighDeck.visibleSlideIndices(), [11]);
    assert.equal(clampedHighDeck.count.textContent, "12 / 12");
    assert.equal(clampedHighDeck.location.hash, "#12");
  });

  test("keyboard navigation (ArrowRight, ArrowLeft, PageDown, PageUp, Home, End) clamps 0..11, updates #progress and history.replaceState, and announces via #live", () => {
    const h = createDeckHarness({ initialHash: "#5" });

    assert.equal(h.pressKey("ArrowRight").defaultPrevented, true);
    assert.deepEqual(h.visibleSlideIndices(), [5]);
    assert.equal(h.count.textContent, "6 / 12");
    assert.equal(h.bar.style.width, `${(6 / 12) * 100}%`);
    assert.equal(h.location.hash, "#6");
    assert.equal(h.replaceStateCalls.at(-1)?.url, "#6");
    assert.equal(h.live.textContent, `Slide 6 of 12: ${h.slideHeadings[5]}`);

    assert.equal(h.pressKey("ArrowLeft").defaultPrevented, true);
    assert.deepEqual(h.visibleSlideIndices(), [4]);
    assert.equal(h.count.textContent, "5 / 12");
    assert.equal(h.bar.style.width, `${(5 / 12) * 100}%`);
    assert.equal(h.location.hash, "#5");
    assert.equal(h.live.textContent, `Slide 5 of 12: ${h.slideHeadings[4]}`);

    assert.equal(h.pressKey("PageDown").defaultPrevented, true);
    assert.deepEqual(h.visibleSlideIndices(), [5]);
    assert.equal(h.count.textContent, "6 / 12");
    assert.equal(h.live.textContent, `Slide 6 of 12: ${h.slideHeadings[5]}`);

    assert.equal(h.pressKey("PageUp").defaultPrevented, true);
    assert.deepEqual(h.visibleSlideIndices(), [4]);
    assert.equal(h.count.textContent, "5 / 12");
    assert.equal(h.live.textContent, `Slide 5 of 12: ${h.slideHeadings[4]}`);

    for (const fwdKey of [" ", "Enter", "n"]) {
      const prevIdx = h.visibleSlideIndices()[0];
      assert.equal(h.pressKey(fwdKey).defaultPrevented, true);
      assert.deepEqual(h.visibleSlideIndices(), [prevIdx + 1]);
    }
    for (const backKey of ["Backspace", "p"]) {
      const prevIdx = h.visibleSlideIndices()[0];
      assert.equal(h.pressKey(backKey).defaultPrevented, true);
      assert.deepEqual(h.visibleSlideIndices(), [prevIdx - 1]);
    }

    assert.equal(h.pressKey("Home").defaultPrevented, true);
    assert.deepEqual(h.visibleSlideIndices(), [0]);
    assert.equal(h.count.textContent, "1 / 12");
    assert.equal(h.bar.style.width, `${(1 / 12) * 100}%`);
    assert.equal(h.location.hash, "#1");
    assert.equal(h.live.textContent, `Slide 1 of 12: ${h.slideHeadings[0]}`);

    const replaceCountAtStart = h.replaceStateCalls.length;
    assert.equal(h.pressKey("ArrowLeft").defaultPrevented, true);
    assert.deepEqual(h.visibleSlideIndices(), [0]);
    assert.equal(h.count.textContent, "1 / 12");
    assert.equal(h.pressKey("PageUp").defaultPrevented, true);
    assert.deepEqual(h.visibleSlideIndices(), [0]);
    assert.equal(h.replaceStateCalls.length, replaceCountAtStart);

    assert.equal(h.pressKey("End").defaultPrevented, true);
    assert.deepEqual(h.visibleSlideIndices(), [11]);
    assert.equal(h.count.textContent, "12 / 12");
    assert.equal(h.bar.style.width, "100%");
    assert.equal(h.location.hash, "#12");
    assert.equal(h.live.textContent, `Slide 12 of 12: ${h.slideHeadings[11]}`);

    const replaceCountAtEnd = h.replaceStateCalls.length;
    assert.equal(h.pressKey("ArrowRight").defaultPrevented, true);
    assert.deepEqual(h.visibleSlideIndices(), [11]);
    assert.equal(h.count.textContent, "12 / 12");
    assert.equal(h.bar.style.width, "100%");
    assert.equal(h.pressKey("PageDown").defaultPrevented, true);
    assert.deepEqual(h.visibleSlideIndices(), [11]);
    assert.equal(h.replaceStateCalls.length, replaceCountAtEnd);

    h.clickPrev();
    assert.deepEqual(h.visibleSlideIndices(), [10]);
    assert.equal(h.count.textContent, "11 / 12");
    assert.equal(h.live.textContent, `Slide 11 of 12: ${h.slideHeadings[10]}`);

    h.clickNext();
    assert.deepEqual(h.visibleSlideIndices(), [11]);
    assert.equal(h.count.textContent, "12 / 12");

    assert.equal(h.pressKey({ key: "Enter", targetTag: "button" }).defaultPrevented, false);
    assert.equal(h.pressKey({ key: " ", targetTag: "button" }).defaultPrevented, false);
    assert.equal(h.pressKey({ key: "ArrowLeft", altKey: true }).defaultPrevented, false);
    assert.equal(h.pressKey({ key: "p", ctrlKey: true }).defaultPrevented, false);
    assert.equal(h.pressKey({ key: "ArrowLeft", metaKey: true }).defaultPrevented, false);
    assert.deepEqual(h.visibleSlideIndices(), [11]);
  });

  test("beforeprint unhides all 12 slides for PDF export and afterprint restores single-slide visibility without spurious live announcements", () => {
    const h = createDeckHarness({ initialHash: "#3" });
    h.pressKey("ArrowRight");
    assert.deepEqual(h.visibleSlideIndices(), [3]);
    assert.equal(h.count.textContent, "4 / 12");
    assert.equal(h.liveWrites.length, 1);
    const announcementBeforePrint = h.live.textContent;
    assert.equal(announcementBeforePrint, `Slide 4 of 12: ${h.slideHeadings[3]}`);

    h.dispatchWindow("beforeprint");
    assert.deepEqual(
      h.visibleSlideIndices(),
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
      "beforeprint must unhide all 12 slides",
    );
    assert.equal(h.liveWrites.length, 1, "beforeprint must not write to #live");
    assert.equal(h.live.textContent, announcementBeforePrint);

    h.dispatchWindow("afterprint");
    assert.deepEqual(h.visibleSlideIndices(), [3], "afterprint must restore active Slide 4 only");
    h.slides.forEach((s, idx) => {
      assert.equal(s.hidden, idx !== 3, `Slide ${idx + 1} hidden state after print`);
    });
    assert.equal(h.count.textContent, "4 / 12");
    assert.equal(h.location.hash, "#4");
    assert.equal(h.liveWrites.length, 1, "afterprint must not emit a spurious #live announcement");
    assert.equal(h.live.textContent, announcementBeforePrint);
  });
});
