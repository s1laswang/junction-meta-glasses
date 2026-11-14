import { offlineBarcodeVerdict } from "../src/camera/barcode.ts";
import { DEMO_SCENARIOS } from "../src/camera/demoScenarios.ts";
import {
  SAMPLE_FINNISH_PHARMACY_QR,
  encodePharmacyQrUri,
  mergePharmacyPayload,
  parsePharmacyQrUri
} from "../src/pairing/pharmacyQr.ts";
import { encodeQrMatrix } from "../src/pairing/qrSvg.ts";
import { DEMO_PROFILE } from "../src/storage/profileStore.ts";

type TestFn = (name: string, fn: () => void | Promise<void>) => Promise<void>;

type StrictAssert = {
  ok(value: unknown, message?: string): asserts value;
  equal<T>(actual: T, expected: T, message?: string): void;
  deepEqual<T>(actual: T, expected: T, message?: string): void;
  match(value: string, regExp: RegExp, message?: string): void;
  doesNotMatch(value: string, regExp: RegExp, message?: string): void;
};

type FsModule = {
  existsSync(path: URL | string): boolean;
  readFileSync(path: URL | string, encoding: "utf8"): string;
};

type VmModule = {
  runInNewContext(code: string, contextObject: Record<string, unknown>): unknown;
};

const nodeTestSpec: string = "node:test";
const nodeAssertSpec: string = "node:assert/strict";
const nodeFsSpec: string = "node:fs";
const nodeVmSpec: string = "node:vm";

const { test } = (await import(nodeTestSpec)) as { test: TestFn };
const assert: StrictAssert = ((await import(nodeAssertSpec)) as { default: StrictAssert }).default;
const { existsSync, readFileSync } = (await import(nodeFsSpec)) as FsModule;
const vm = (await import(nodeVmSpec)) as VmModule;

const SLASH = String.fromCharCode(47);
const STAR = String.fromCharCode(42);
const DOUBLE_SLASH = SLASH + SLASH;
const CSS_COMMENT_OPEN = SLASH + STAR;
const CSS_COMMENT_CLOSE = STAR + SLASH;
const HTML_COMMENT_OPEN = "\x3c!--";
const HTML_COMMENT_CLOSE = "--\x3e";
const HTTP_SCHEME = `http:${DOUBLE_SLASH}`;
const HTTPS_SCHEME = `https:${DOUBLE_SLASH}`;
const HOLDUP_RX_PREFIX = `holdup:${DOUBLE_SLASH}rx?v=1&data=`;
const EM_DASH = "\u2014";
const EN_DASH = "\u2013";

const printablePropsUrl = new URL("../../docs/printable-props.html", import.meta.url);
const serverIndexUrl = new URL("../../server/src/index.ts", import.meta.url);
const selfTestUrl = new URL("./printableProps.test.ts", import.meta.url);

type BarcodeRect = {
  x: number;
  w: number;
  guard?: boolean;
};

type EncodedBarcode = {
  code: string;
  totalWidth: number;
  rects: BarcodeRect[];
};

type HoldUpBarcodesApi = {
  computeEan13CheckDigit(digits12: string): string;
  encodeEan13(rawCode: string): EncodedBarcode;
  encodeCode128(rawCode: string): EncodedBarcode;
  applySymbology(mode: "code128" | "ean13"): void;
};

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&#47;/g, SLASH)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function matrixToSvgPath(matrix: boolean[][], margin: number): string {
  const count = matrix.length;
  const segments: string[] = [];
  for (let r = 0; r < count; r += 1) {
    let c = 0;
    while (c < count) {
      if (!matrix[r][c]) {
        c += 1;
        continue;
      }
      let w = 1;
      while (c + w < count && matrix[r][c + w]) {
        w += 1;
      }
      segments.push(`M${c + margin} ${r + margin}h${w}v1h-${w}z`);
      c += w;
    }
  }
  return segments.join("");
}

test("docs/printable-props.html exists as self-contained A4 portrait HTML5 with @page print CSS and /printable-props.html server route", () => {
  assert.equal(existsSync(printablePropsUrl), true, "docs/printable-props.html must exist");
  const html = readFileSync(printablePropsUrl, "utf8");

  assert.match(html, /^<!DOCTYPE html>\s*<html\b[^>]*lang="en"/i);
  assert.match(html, /@page\s*\{\s*size:\s*A4\s+portrait;\s*margin:\s*10mm;\s*\}/i);
  assert.match(html, /@media\s+print\s*\{/i);
  assert.match(html, /\.no-print\s*\{\s*display:\s*none\s*!important;\s*\}/i);

  const sheets = html.match(/<section\b[^>]*class="a4-sheet"/gi) ?? [];
  assert.equal(sheets.length, 2, "Expected 2 printable A4 sheets");
  assert.ok(html.includes('aria-label="Printable Prop Sheet 1"'));
  assert.ok(html.includes('aria-label="Printable Prop Sheet 2"'));
  assert.ok(html.includes("</html>"));

  const serverSource = readFileSync(serverIndexUrl, "utf8");
  assert.ok(
    serverSource.includes('app.get("/printable-props.html"'),
    "Expected /printable-props.html route in server/src/index.ts"
  );
  assert.ok(
    serverSource.includes('"printable-props.html"'),
    "Expected docs/printable-props.html binding in server/src/index.ts"
  );
});

test("docs/printable-props.html and printableProps.test.ts have zero external http/https dependencies, zero comments, and zero em/en dashes", () => {
  const html = readFileSync(printablePropsUrl, "utf8");
  const selfSource = readFileSync(selfTestUrl, "utf8");

  assert.equal(html.toLowerCase().includes(HTTP_SCHEME), false, "Must not reference external http URLs");
  assert.equal(html.toLowerCase().includes(HTTPS_SCHEME), false, "Must not reference external https URLs");

  const externalScriptPattern = /<script\b[^>]*\bsrc\s*=/i;
  const externalLinkPattern = /<link\b/i;
  const externalImgPattern = /<img\b/i;
  const externalCssUrlPattern = new RegExp(`url\\s*\\(\\s*["']?\\s*(?:https?:)?${DOUBLE_SLASH}`, "i");

  assert.doesNotMatch(html, externalScriptPattern, "Must not include external <script>");
  assert.doesNotMatch(html, externalLinkPattern, "Must not include external <link>");
  assert.doesNotMatch(html, externalImgPattern, "Must not include <img> dependencies");
  assert.doesNotMatch(html, /@import\b/i, "Must not include CSS @import");
  assert.doesNotMatch(html, externalCssUrlPattern, "Must not include external CSS url()");

  assert.equal(html.includes(HTML_COMMENT_OPEN), false, "Must contain zero HTML comment openings");
  assert.equal(html.includes(HTML_COMMENT_CLOSE), false, "Must contain zero HTML comment closings");
  assert.equal(html.includes(CSS_COMMENT_OPEN), false, "Must contain zero block comment openings");
  assert.equal(html.includes(CSS_COMMENT_CLOSE), false, "Must contain zero block comment closings");
  assert.equal(html.includes(DOUBLE_SLASH), false, "Must contain zero line comments");

  for (const forbiddenDash of [EM_DASH, EN_DASH, "&mdash;", "&ndash;", "&#8212;", "&#8211;", "&#x2014;", "&#x2013;"]) {
    assert.equal(html.toLowerCase().includes(forbiddenDash.toLowerCase()), false, `Forbidden dash token: ${forbiddenDash}`);
  }

  assert.equal(selfSource.includes(HTML_COMMENT_OPEN), false);
  assert.equal(selfSource.includes(CSS_COMMENT_OPEN), false);
  assert.equal(selfSource.includes(CSS_COMMENT_CLOSE), false);
  assert.equal(selfSource.includes(DOUBLE_SLASH), false);
  assert.equal(selfSource.includes(EM_DASH), false);
});

test("docs/printable-props.html contains valid medication and allergen prop cards aligned with DEMO_SCENARIOS and barcode 6432100012345", () => {
  const html = readFileSync(printablePropsUrl, "utf8");

  const propArticles = html.match(/<article\b[^>]*class="prop-unit"/gi) ?? [];
  assert.equal(propArticles.length, 4, "Expected 4 printable stage prop wrap cards");

  const expectedProps = [
    {
      title: "Amlodipin 5 mg",
      detail: "amlodipine",
      expiry: "EXP 08/2027",
      barcode: "6432100012345",
      scenarioIds: ["amlodipine_match", "blurry_strength", "back_of_box"]
    },
    {
      title: "Burana 400 mg",
      detail: "ibuprofeeni / ibuprofen",
      expiry: "EXP 11/2027",
      barcode: "6412345000400",
      scenarioIds: ["ibuprofen_nsaid"]
    },
    {
      title: "Metformin 500 mg",
      detail: "metformin hydrochloride",
      expiry: "EXP 04/2025",
      barcode: "6432100054321",
      scenarioIds: ["expired_med"]
    },
    {
      title: "Nordic Oat &amp; Hazelnut Bar",
      detail: "roasted hazelnuts 12%, arachis oil",
      expiry: "14.09.2027",
      barcode: "7310100555111",
      scenarioIds: ["hazelnut_allergy"]
    }
  ] as const;

  for (const prop of expectedProps) {
    assert.ok(html.includes(prop.title), `Missing prop title: ${prop.title}`);
    assert.ok(html.includes(prop.detail), `Missing prop detail: ${prop.detail}`);
    assert.ok(html.includes(prop.expiry), `Missing prop expiry: ${prop.expiry}`);

    const svgPattern = new RegExp(
      `<svg[^>]*class="barcode-svg"[^>]*data-barcode="${prop.barcode}"[^>]*role="img"[^>]*aria-label="Barcode ${prop.barcode}"`,
      "i"
    );
    assert.match(html, svgPattern, `Missing accessible barcode SVG for ${prop.barcode}`);

    for (const scenarioId of prop.scenarioIds) {
      const scenario = DEMO_SCENARIOS.find((item) => item.id === scenarioId);
      assert.ok(scenario, `Expected scenario ${scenarioId} in DEMO_SCENARIOS`);
      assert.equal(scenario.barcode, prop.barcode, `Barcode mismatch on scenario ${scenarioId}`);
    }
  }

  const now = new Date(2026, 10, 14, 20, 0, 0);
  const offlineAmlVerdict = offlineBarcodeVerdict("6432100012345", DEMO_PROFILE, now);
  assert.equal(offlineAmlVerdict.level, "match");
  assert.equal(offlineAmlVerdict.matchedMedId, "aml");
});

test("docs/printable-props.html inline HoldUpBarcodes script encodes GS1 EAN-13 and Code-128 for 6432100012345 and triggers print", () => {
  const html = readFileSync(printablePropsUrl, "utf8");
  const scriptMatch = /<script>([\s\S]*?)<\/script>/i.exec(html);
  assert.ok(scriptMatch, "Expected inline <script> block in docs/printable-props.html");

  type MockSvgElement = {
    barcode: string;
    viewBox: string;
    innerHTML: string;
    getAttribute(name: string): string | null;
    setAttribute(name: string, value: string): void;
  };

  const barcodes = ["6432100012345", "6412345000400", "6432100054321", "7310100555111"];
  const svgNodes: MockSvgElement[] = barcodes.map((code) => ({
    barcode: code,
    viewBox: "0 0 145 76",
    innerHTML: "",
    getAttribute(name: string) {
      if (name === "data-barcode") return this.barcode;
      if (name === "viewBox") return this.viewBox;
      return null;
    },
    setAttribute(name: string, value: string) {
      if (name === "viewBox") {
        this.viewBox = value;
      }
    }
  }));

  const metaNodes: Record<string, { textContent: string }> = {};
  for (const code of barcodes) {
    metaNodes[code] = { textContent: `CODE-128 EXACT: ${code}` };
  }

  const buttonPressed: Record<string, string> = {
    "btn-mode-code128": "true",
    "btn-mode-ean13": "false"
  };
  const buttonListeners: Record<string, () => void> = {};
  let printCalls = 0;

  const windowObj: { HoldUpBarcodes?: HoldUpBarcodesApi; print: () => void } = {
    print() {
      printCalls += 1;
    }
  };

  const context: Record<string, unknown> = {
    window: windowObj,
    document: {
      querySelectorAll(selector: string) {
        if (selector === "svg[data-barcode]") return svgNodes;
        return [];
      },
      querySelector(selector: string) {
        const m = /^\[data-meta-for="(\d+)"\]$/.exec(selector);
        if (m && metaNodes[m[1]]) {
          return metaNodes[m[1]];
        }
        return null;
      },
      getElementById(id: string) {
        if (id === "btn-mode-code128" || id === "btn-mode-ean13" || id === "btn-print-sheet") {
          return {
            setAttribute(name: string, value: string) {
              if (name === "aria-pressed") {
                buttonPressed[id] = value;
              }
            },
            addEventListener(_event: string, handler: () => void) {
              buttonListeners[id] = handler;
            }
          };
        }
        return null;
      }
    }
  };

  vm.runInNewContext(scriptMatch[1], context);

  const api = windowObj.HoldUpBarcodes;
  assert.ok(api, "Expected window.HoldUpBarcodes API");

  assert.equal(api.computeEan13CheckDigit("6432100012345"), "0");
  const ean13 = api.encodeEan13("6432100012345");
  assert.equal(ean13.code, "6432100012340");
  assert.equal(ean13.totalWidth, 113);
  assert.ok(ean13.rects.some((r) => r.guard === true), "Expected GS1 EAN-13 guard bars");
  assert.ok(ean13.rects.some((r) => r.guard === false), "Expected GS1 EAN-13 data bars");

  const code128 = api.encodeCode128("6432100012345");
  assert.equal(code128.code, "6432100012345");
  assert.equal(code128.totalWidth, 145);
  assert.ok(code128.rects.length > 20);

  assert.ok(buttonListeners["btn-mode-ean13"], "Expected EAN-13 toggle listener");
  buttonListeners["btn-mode-ean13"]();
  assert.equal(svgNodes[0].viewBox, "0 0 113 78");
  assert.ok(svgNodes[0].innerHTML.includes('height="58"'), "Expected taller EAN-13 guard bar SVG rects");
  assert.equal(metaNodes["6432100012345"].textContent, "GS1 EAN-13: 6432100012340 (DEMO ID: 6432100012345)");
  assert.equal(buttonPressed["btn-mode-ean13"], "true");
  assert.equal(buttonPressed["btn-mode-code128"], "false");

  assert.ok(buttonListeners["btn-mode-code128"], "Expected Code-128 toggle listener");
  buttonListeners["btn-mode-code128"]();
  assert.equal(svgNodes[0].viewBox, "0 0 145 76");
  assert.ok(svgNodes[0].innerHTML.includes(">6432100012345</text>"));
  assert.equal(metaNodes["6432100012345"].textContent, "CODE-128 EXACT: 6432100012345");
  assert.equal(buttonPressed["btn-mode-code128"], "true");
  assert.equal(buttonPressed["btn-mode-ean13"], "false");

  assert.ok(buttonListeners["btn-print-sheet"], "Expected print button listener");
  buttonListeners["btn-print-sheet"]();
  assert.equal(printCalls, 1);
});

test("docs/printable-props.html includes scannable zero-PII Finnish pharmacy QR reference matching pharmacyQr.ts and qrSvg.ts", () => {
  const html = readFileSync(printablePropsUrl, "utf8");

  assert.ok(html.includes("Pharmacy QR Onboarding Sticker (25 mm, Zero-PII)"));
  assert.ok(html.includes("Yliopiston Apteekki Helsinki"));
  assert.ok(html.includes("Braille-clear flap"));

  const rxAttrMatch = /data-rx-data="([A-Za-z0-9_-]+)"/.exec(html);
  assert.ok(rxAttrMatch, "Expected data-rx-data attribute on pharmacy QR card");
  const prop1RxUri = `${HOLDUP_RX_PREFIX}${rxAttrMatch[1]}`;
  const parsedProp1Rx = parsePharmacyQrUri(prop1RxUri);
  assert.ok(parsedProp1Rx, "Expected data-rx-data URI to parse via parsePharmacyQrUri");
  assert.equal(parsedProp1Rx.v, 1);
  assert.equal(parsedProp1Rx.pharmacy, "Yliopiston Apteekki");
  assert.equal(parsedProp1Rx.meds.length, 1);
  assert.equal(parsedProp1Rx.meds[0].id, "aml");
  assert.equal(parsedProp1Rx.meds[0].name, "Amlodipin");
  assert.equal(parsedProp1Rx.meds[0].ingredient, "amlodipine");
  assert.equal(parsedProp1Rx.meds[0].strength, "5 mg");
  assert.equal(parsedProp1Rx.meds[0].barcode, "6432100012345");
  assert.equal(encodePharmacyQrUri(parsedProp1Rx), prop1RxUri);

  const displayedUriMatch = /<div class="pharmacy-qr-uri">URI:\s*([^<]+)<\/div>/.exec(html);
  assert.ok(displayedUriMatch, "Expected displayed .pharmacy-qr-uri element");
  const decodedDisplayedUri = decodeHtmlEntities(displayedUriMatch[1].trim());
  assert.equal(decodedDisplayedUri, prop1RxUri);

  const qrSvgMatch = /<svg[^>]*class="pharmacy-qr-svg"[^>]*viewBox="0 0 (\d+) \1"[^>]*role="img"[^>]*aria-label="[^"]+"[^>]*>[\s\S]*?<path d="([^"]+)"/.exec(
    html
  );
  assert.ok(qrSvgMatch, "Expected accessible inline svg.pharmacy-qr-svg with <path>");
  const expectedMatrix = encodeQrMatrix(prop1RxUri, "L");
  const expectedViewSize = expectedMatrix.length + 8;
  assert.equal(Number(qrSvgMatch[1]), expectedViewSize);
  assert.equal(qrSvgMatch[2], matrixToSvgPath(expectedMatrix, 4));

  const sampleRxAttrMatch = /data-sample-rx-data="([A-Za-z0-9_-]+)"/.exec(html);
  assert.ok(sampleRxAttrMatch, "Expected data-sample-rx-data attribute for SAMPLE_FINNISH_PHARMACY_QR");
  const reconstructedSampleUri = `${HOLDUP_RX_PREFIX}${sampleRxAttrMatch[1]}`;
  assert.equal(reconstructedSampleUri, SAMPLE_FINNISH_PHARMACY_QR);

  const parsedSample = parsePharmacyQrUri(reconstructedSampleUri);
  assert.ok(parsedSample, "Expected SAMPLE_FINNISH_PHARMACY_QR to parse");
  assert.equal(parsedSample.pharmacy, "Yliopiston Apteekki Helsinki");
  const merged = mergePharmacyPayload(DEMO_PROFILE, parsedSample);
  assert.equal(merged.added, 2);
  assert.equal(merged.updated, 0);
});
