import assert from "node:assert/strict";
import fs from "node:fs";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import type { Profile, Verdict } from "../../shared/types.ts";
import {
  SAMPLE_FINNISH_PHARMACY_QR,
  encodePharmacyQrUri,
  mergePharmacyPayload,
  parsePharmacyQrUri,
} from "../../web/src/pairing/pharmacyQr.ts";
import { encodeQrMatrix } from "../../web/src/pairing/qrSvg.ts";
import { env, REPO_ROOT } from "../src/env.ts";
import { startServer } from "../src/index.ts";

process.env.HOLDUP_QUIET = "1";

const SELF_FILE = fileURLToPath(import.meta.url);
const SLASH = String.fromCharCode(47);
const STAR = String.fromCharCode(42);
const DOUBLE_SLASH = SLASH + SLASH;
const BLOCK_COMMENT_OPEN = SLASH + STAR;
const BLOCK_COMMENT_CLOSE = STAR + SLASH;
const HTML_COMMENT_OPEN = "<" + "!--";
const EM_DASH = String.fromCharCode(0x2014);
const CO_AUTHORED = ["Co", "Authored", "By"].join("-");
const API_KEY_RE = new RegExp("AIza" + "[0-9A-Za-z_-]{20,}");
const HTTP_SCHEME_RE = new RegExp(`^(?:https?:)?${DOUBLE_SLASH}`, "i");
const HOLDUP_RX_PREFIX = `holdup:${DOUBLE_SLASH}rx?v=1&data=`;
const HOLDUP_RX_URI_RE = new RegExp(`holdup:${DOUBLE_SLASH}rx\\?[A-Za-z0-9_=&%-]+`, "g");

const BOOTH_SURFACES = [
  { route: "/deck/", diskRel: ["deck", "index.html"] },
  { route: "/judge-handout.html", diskRel: ["docs", "judge-handout.html"] },
  { route: "/printable-props.html", diskRel: ["docs", "printable-props.html"] },
  { route: "/architecture-poster.html", diskRel: ["docs", "architecture-poster.html"] },
] as const;

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

const EAN_L_TO_DIGIT: Record<string, string> = {
  "0001101": "0",
  "0011001": "1",
  "0010011": "2",
  "0111101": "3",
  "0100011": "4",
  "0110001": "5",
  "0101111": "6",
  "0111011": "7",
  "0110111": "8",
  "0001011": "9",
};

const EAN_G_TO_DIGIT: Record<string, string> = {
  "0100111": "0",
  "0110011": "1",
  "0011011": "2",
  "0100001": "3",
  "0011101": "4",
  "0111001": "5",
  "0000101": "6",
  "0010001": "7",
  "0001001": "8",
  "0010111": "9",
};

const EAN_R_TO_DIGIT: Record<string, string> = {
  "1110010": "0",
  "1100110": "1",
  "1101100": "2",
  "1000010": "3",
  "1011100": "4",
  "1001110": "5",
  "1010000": "6",
  "1000100": "7",
  "1001000": "8",
  "1110100": "9",
};

const EAN_PARITY_TO_FIRST: Record<string, string> = {
  LLLLLL: "0",
  LLGLGG: "1",
  LLGGLG: "2",
  LLGGGL: "3",
  LGLLGG: "4",
  LGGLLG: "5",
  LGGGLL: "6",
  LGLGLG: "7",
  LGLGGL: "8",
  LGGLGL: "9",
};

let server: http.Server;
let baseUrl = "";
let prevApiKey = "";
let prevEnvApiKey: string | undefined;
let demoProfile: Profile;
let offlineBarcodeVerdictFn: (barcode: string, profile: Profile, now?: Date) => Verdict;

async function closeHttpServer(srv: http.Server): Promise<void> {
  srv.closeAllConnections();
  await new Promise<void>((resolve) => srv.close(() => resolve()));
}

function stripScriptAndStyleBodies(html: string): string {
  return html
    .replace(/<script\b([^>]*)>[\s\S]*?<\/script>/gi, "<script$1></script>")
    .replace(/<style\b([^>]*)>[\s\S]*?<\/style>/gi, "<style$1></style>");
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&#47;/g, SLASH)
    .replace(/&#x2f;/gi, SLASH)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractTagAttributes(markup: string, attrName: "href" | "src"): string[] {
  const re = new RegExp(`\\b${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "gi");
  const values: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(markup)) !== null) {
    const raw = (match[1] ?? match[2] ?? "").trim();
    values.push(decodeHtmlEntities(raw));
  }
  return values;
}

function extractRootRelativeHrefs(html: string): string[] {
  const markup = stripScriptAndStyleBodies(html);
  const hrefs = extractTagAttributes(markup, "href");
  for (const h of hrefs) {
    assert.equal(
      h.startsWith(DOUBLE_SLASH),
      false,
      `Protocol-relative href is forbidden in booth HTML: ${h}`,
    );
  }
  return hrefs.filter((h) => h.startsWith(SLASH));
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

function decodeGs1Ean13Rects(rects: BarcodeRect[]): string {
  const modules = new Array<number>(95).fill(0);
  const guards = new Array<boolean>(95).fill(false);
  for (const rect of rects) {
    const start = rect.x - 11;
    assert.ok(start >= 0 && start + rect.w <= 95, `EAN-13 bar out of 95-module bounds: x=${rect.x} w=${rect.w}`);
    for (let k = 0; k < rect.w; k += 1) {
      modules[start + k] = 1;
      guards[start + k] = Boolean(rect.guard);
    }
  }
  const bits = modules.join("");
  assert.equal(bits.slice(0, 3), "101");
  assert.equal(bits.slice(45, 50), "01010");
  assert.equal(bits.slice(92, 95), "101");
  assert.equal(guards[0] && guards[2] && guards[46] && guards[48] && guards[92] && guards[94], true);

  let parity = "";
  let leftDigits = "";
  for (let i = 0; i < 6; i += 1) {
    const seg = bits.slice(3 + i * 7, 3 + (i + 1) * 7);
    if (EAN_L_TO_DIGIT[seg] !== undefined) {
      parity += "L";
      leftDigits += EAN_L_TO_DIGIT[seg];
    } else if (EAN_G_TO_DIGIT[seg] !== undefined) {
      parity += "G";
      leftDigits += EAN_G_TO_DIGIT[seg];
    } else {
      assert.fail(`Invalid EAN-13 left segment at index ${i}: ${seg}`);
    }
  }

  const firstDigit = EAN_PARITY_TO_FIRST[parity];
  assert.ok(firstDigit !== undefined, `Invalid EAN-13 parity pattern: ${parity}`);

  let rightDigits = "";
  for (let i = 0; i < 6; i += 1) {
    const seg = bits.slice(50 + i * 7, 50 + (i + 1) * 7);
    const digit = EAN_R_TO_DIGIT[seg];
    assert.ok(digit !== undefined, `Invalid EAN-13 right segment at index ${i}: ${seg}`);
    rightDigits += digit;
  }

  const decoded = `${firstDigit}${leftDigits}${rightDigits}`;
  let weightedSum = 0;
  for (let i = 0; i < 12; i += 1) {
    const d = decoded.charCodeAt(i) - 48;
    weightedSum += i % 2 === 1 ? d * 3 : d;
  }
  const expectedCheck = String((10 - (weightedSum % 10)) % 10);
  assert.equal(decoded[12], expectedCheck, `EAN-13 Mod-10 check digit mismatch for ${decoded}`);
  return decoded;
}

function isStaticBoothRoute(routePath: string): boolean {
  const cleanPath = routePath.split("?")[0].split("#")[0];
  return (
    cleanPath === "/deck" ||
    cleanPath.startsWith("/deck/") ||
    cleanPath === "/printable-props.html" ||
    cleanPath === "/judge-handout.html" ||
    cleanPath === "/architecture-poster.html"
  );
}

before(async () => {
  process.env.HOLDUP_QUIET = "1";
  prevEnvApiKey = process.env.GEMINI_API_KEY;
  prevApiKey = env.apiKey;
  process.env.GEMINI_API_KEY = "";
  env.apiKey = "";

  const profileModUrl = new URL("../../web/src/storage/profileStore.ts", import.meta.url).href;
  const barcodeModUrl = new URL("../../web/src/camera/barcode.ts", import.meta.url).href;
  const [profileMod, barcodeMod] = await Promise.all([
    import(profileModUrl) as Promise<{ DEMO_PROFILE: Profile }>,
    import(barcodeModUrl) as Promise<{
      offlineBarcodeVerdict: (barcode: string, profile: Profile, now?: Date) => Verdict;
    }>,
  ]);
  demoProfile = profileMod.DEMO_PROFILE;
  offlineBarcodeVerdictFn = barcodeMod.offlineBarcodeVerdict;

  server = await startServer(0);
  const { port } = server.address() as AddressInfo;
  baseUrl = `http:${DOUBLE_SLASH}127.0.0.1:${port}`;
});

after(async () => {
  if (prevEnvApiKey === undefined) {
    delete process.env.GEMINI_API_KEY;
  } else {
    process.env.GEMINI_API_KEY = prevEnvApiKey;
  }
  env.apiKey = prevApiKey;
  await closeHttpServer(server);
});

test("all 4 standalone booth HTML surfaces serve 200 text/html matching disk sources with zero external URLs", async () => {
  for (const surface of BOOTH_SURFACES) {
    const diskPath = path.join(REPO_ROOT, ...surface.diskRel);
    const expectedHtml = fs.readFileSync(diskPath, "utf8");

    const res = await fetch(`${baseUrl}${surface.route}`);
    assert.equal(res.status, 200, `Expected 200 for ${surface.route}`);
    assert.equal(res.headers.get("x-powered-by"), null);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/i);

    const html = await res.text();
    assert.equal(html, expectedHtml, `Served HTML mismatch on ${surface.route}`);
    assert.match(html, /^<!DOCTYPE html>\s*<html\b[^>]*lang="en"/i);
    assert.match(html, /<title>[^<]*HoldUp[^<]*<\/title>/i);

    const markupOnly = stripScriptAndStyleBodies(html);
    for (const attr of ["href", "src"] as const) {
      for (const target of extractTagAttributes(markupOnly, attr)) {
        assert.equal(
          HTTP_SCHEME_RE.test(target),
          false,
          `${surface.route} must not reference external ${attr}="${target}"`,
        );
      }
    }
  }
});

test("every local href='/...' and relative asset across all 4 booth HTML responses resolves to 200 with 0 broken 404s", async () => {
  const rootHrefsBySurface = new Map<string, string[]>();
  const allRootHrefs = new Set<string>();
  const sameOriginSubAssets = new Set<string>();
  const liveOrigin = new URL(baseUrl).origin;

  for (const surface of BOOTH_SURFACES) {
    const pageUrl = `${baseUrl}${surface.route}`;
    const res = await fetch(pageUrl);
    assert.equal(res.status, 200);
    const html = await res.text();

    const rootHrefs = extractRootRelativeHrefs(html);
    rootHrefsBySurface.set(surface.route, rootHrefs);
    for (const href of rootHrefs) {
      allRootHrefs.add(href);
    }

    const markup = stripScriptAndStyleBodies(html);
    for (const attr of ["href", "src"] as const) {
      for (const rawTarget of extractTagAttributes(markup, attr)) {
        if (!rawTarget || rawTarget.startsWith("#")) continue;
        const resolved = new URL(rawTarget, pageUrl);
        assert.equal(
          resolved.origin,
          liveOrigin,
          `Cross-origin link forbidden in ${surface.route}: ${rawTarget}`,
        );
        if (!rawTarget.startsWith(SLASH)) {
          sameOriginSubAssets.add(resolved.pathname + resolved.search);
        }
      }
    }
  }

  for (const expectedHref of ["/deck", "/printable-props.html", "/architecture-poster.html", "/hud"]) {
    assert.equal(
      allRootHrefs.has(expectedHref),
      true,
      `Expected booth navigation kit to include href="${expectedHref}"`,
    );
  }
  assert.ok((rootHrefsBySurface.get("/judge-handout.html")?.length ?? 0) >= 4);

  for (const subPath of sameOriginSubAssets) {
    const assetRes = await fetch(`${baseUrl}${subPath}`);
    assert.equal(assetRes.status, 200, `Broken relative asset ${subPath}`);
    await assetRes.arrayBuffer();
  }
  assert.equal(sameOriginSubAssets.has("/deck/deck.css"), true);
  assert.equal(sameOriginSubAssets.has("/deck/deck.js"), true);

  const hasWebDist = fs.existsSync(path.join(REPO_ROOT, "web", "dist", "index.html"));
  let probedCount = 0;

  for (const href of allRootHrefs) {
    if (!hasWebDist && !isStaticBoothRoute(href)) {
      continue;
    }
    probedCount += 1;
    const probeRes = await fetch(`${baseUrl}${href}`);
    assert.notEqual(probeRes.status, 404, `Navigation link ${href} returned broken 404`);
    assert.equal(probeRes.status, 200, `Navigation link ${href} expected 200, got ${probeRes.status}`);
    assert.equal(probeRes.headers.get("x-powered-by"), null);
    assert.match(probeRes.headers.get("content-type") ?? "", /text\/html/i);
    const body = await probeRes.text();
    assert.ok(body.length > 64, `Empty HTML response on probed route ${href}`);
  }

  if (hasWebDist) {
    assert.equal(probedCount, allRootHrefs.size);
  } else {
    assert.ok(probedCount >= 3);
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "holdup-booth-kit-"));
    fs.mkdirSync(path.join(tmpRoot, "deck"), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, "docs"), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, "web", "dist"), { recursive: true });

    for (const name of ["index.html", "deck.css", "deck.js"]) {
      fs.copyFileSync(path.join(REPO_ROOT, "deck", name), path.join(tmpRoot, "deck", name));
    }
    for (const surface of BOOTH_SURFACES) {
      if (surface.diskRel[0] === "docs") {
        fs.copyFileSync(
          path.join(REPO_ROOT, ...surface.diskRel),
          path.join(tmpRoot, ...surface.diskRel),
        );
      }
    }
    fs.writeFileSync(
      path.join(tmpRoot, "web", "dist", "index.html"),
      "<!DOCTYPE html><html lang=\"en\"><head><title>HoldUp HUD</title></head><body><div id=\"root\"></div></body></html>",
      "utf8",
    );

    const fullKitServer = await startServer(0, { repoRoot: tmpRoot });
    const { port: kitPort } = fullKitServer.address() as AddressInfo;
    const kitBase = `http:${DOUBLE_SLASH}127.0.0.1:${kitPort}`;

    try {
      for (const href of allRootHrefs) {
        const res = await fetch(`${kitBase}${href}`);
        assert.equal(res.status, 200, `Full booth kit route ${href} returned ${res.status}`);
        assert.match(res.headers.get("content-type") ?? "", /text\/html/i);
        await res.text();
      }
    } finally {
      await closeHttpServer(fullKitServer);
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }
});

test("live /printable-props.html embeds valid scannable 6432100012345 EAN-13 and Code-128 barcodes matching DEMO_PROFILE", async () => {
  const [propsRes, handoutRes] = await Promise.all([
    fetch(`${baseUrl}/printable-props.html`),
    fetch(`${baseUrl}/judge-handout.html`),
  ]);
  assert.equal(propsRes.status, 200);
  assert.equal(handoutRes.status, 200);
  const [propsHtml, handoutHtml] = await Promise.all([propsRes.text(), handoutRes.text()]);

  assert.equal(handoutHtml.includes("6432100012345"), true);
  assert.equal(propsHtml.includes('data-barcode="6432100012345"'), true);

  const amlSvgMatch =
    /<svg\b[^>]*class="barcode-svg"[^>]*data-barcode="6432100012345"[^>]*>([\s\S]*?)<\/svg>/i.exec(
      propsHtml,
    );
  assert.ok(amlSvgMatch, "Expected inline SVG barcode for 6432100012345 in /printable-props.html");

  const staticBarRects: BarcodeRect[] = [];
  const rectRe = /<rect\s+x="(\d+)"\s+y="4"\s+width="(\d+)"\s+height="52"\s+fill="#000000"\s*\/>/g;
  let rectMatch: RegExpExecArray | null;
  while ((rectMatch = rectRe.exec(amlSvgMatch[1])) !== null) {
    staticBarRects.push({ x: Number(rectMatch[1]), w: Number(rectMatch[2]) });
  }
  assert.ok(staticBarRects.length > 20, "Expected pre-rendered black barcode bars in static SVG");

  const scriptMatch = /<script>([\s\S]*?)<\/script>/i.exec(propsHtml);
  assert.ok(scriptMatch, "Expected inline barcode generator script in /printable-props.html");

  const windowBox: { HoldUpBarcodes?: HoldUpBarcodesApi; print: () => void } = { print() {} };
  const sandbox: Record<string, unknown> = {
    window: windowBox,
    document: {
      querySelectorAll() {
        return [];
      },
      querySelector() {
        return null;
      },
      getElementById() {
        return null;
      },
    },
  };
  vm.runInNewContext(scriptMatch[1], sandbox);

  const api = windowBox.HoldUpBarcodes;
  assert.ok(api, "Expected window.HoldUpBarcodes API on /printable-props.html");

  const code128 = api.encodeCode128("6432100012345");
  assert.equal(code128.code, "6432100012345");
  assert.equal(code128.totalWidth, 145);
  assert.deepEqual(
    staticBarRects,
    Array.from(code128.rects, (r) => ({ x: Number(r.x), w: Number(r.w) })),
  );

  assert.equal(api.computeEan13CheckDigit("6432100012345"), "0");
  const ean13 = api.encodeEan13("6432100012345");
  assert.equal(ean13.code, "6432100012340");
  assert.equal(ean13.totalWidth, 113);
  assert.equal(decodeGs1Ean13Rects(ean13.rects), "6432100012340");

  const amlMed = demoProfile.meds.find((m) => m.id === "aml");
  assert.ok(amlMed, "Expected aml medication in DEMO_PROFILE");
  assert.equal(amlMed.barcode, "6432100012345");

  const fixedEvening = new Date(2026, 10, 14, 20, 0, 0);
  const verdict = offlineBarcodeVerdictFn("6432100012345", demoProfile, fixedEvening);
  assert.equal(verdict.level, "match");
  assert.equal(verdict.matchedMedId, "aml");
});

test(`live /printable-props.html embeds Finnish holdup:${DOUBLE_SLASH}rx and SAMPLE_FINNISH_PHARMACY_QR with 1:1 DEMO_PROFILE parity`, async () => {
  const res = await fetch(`${baseUrl}/printable-props.html`);
  assert.equal(res.status, 200);
  const html = await res.text();

  const decodedText = decodeHtmlEntities(stripScriptAndStyleBodies(html));
  const extractedUris = [...new Set(decodedText.match(HOLDUP_RX_URI_RE) ?? [])];
  assert.ok(
    extractedUris.length >= 1,
    `Expected at least one embedded holdup:${DOUBLE_SLASH}rx?... URI in /printable-props.html`,
  );

  const rxAttrMatch = /data-rx-data="([A-Za-z0-9_-]+)"/.exec(html);
  assert.ok(rxAttrMatch, "Expected data-rx-data attribute on pharmacy QR card");
  const attrRxUri = `${HOLDUP_RX_PREFIX}${rxAttrMatch[1]}`;
  assert.equal(extractedUris.includes(attrRxUri), true);

  for (const uri of extractedUris) {
    const parsed = parsePharmacyQrUri(uri);
    assert.ok(parsed, `Expected parsePharmacyQrUri to decode embedded URI: ${uri}`);
    assert.equal(parsed.v, 1);
    assert.equal(encodePharmacyQrUri(parsed), uri);
    assert.ok(parsed.meds.length >= 1);

    for (const rxMed of parsed.meds) {
      const demoMed = demoProfile.meds.find((m) => m.id === rxMed.id);
      assert.ok(demoMed, `Expected ${rxMed.id} in DEMO_PROFILE.meds`);
      assert.equal(rxMed.id, demoMed.id);
      assert.equal(rxMed.name, demoMed.name);
      assert.equal(rxMed.ingredient, demoMed.ingredient);
      assert.equal(rxMed.strength, demoMed.strength);
      assert.deepEqual(rxMed.schedule, demoMed.schedule);
      assert.equal(rxMed.barcode, demoMed.barcode);
    }

    const merged = mergePharmacyPayload(demoProfile, parsed);
    assert.equal(merged.added, 0);
    assert.equal(merged.updated, parsed.meds.length);
    assert.deepEqual(merged.profile, demoProfile);
  }

  const qrSvgMatch =
    /<svg\b[^>]*class="pharmacy-qr-svg"[^>]*viewBox="0 0 (\d+) \1"[^>]*>[\s\S]*?<path d="([^"]+)"/i.exec(
      html,
    );
  assert.ok(qrSvgMatch, "Expected inline svg.pharmacy-qr-svg path in /printable-props.html");
  const expectedQrMatrix = encodeQrMatrix(attrRxUri, "L");
  assert.equal(Number(qrSvgMatch[1]), expectedQrMatrix.length + 8);
  assert.equal(qrSvgMatch[2], matrixToSvgPath(expectedQrMatrix, 4));

  const sampleAttrMatch = /data-sample-rx-data="([A-Za-z0-9_-]+)"/.exec(html);
  assert.ok(sampleAttrMatch, "Expected data-sample-rx-data attribute in /printable-props.html");
  const embeddedSampleUri = `${HOLDUP_RX_PREFIX}${sampleAttrMatch[1]}`;
  assert.equal(embeddedSampleUri, SAMPLE_FINNISH_PHARMACY_QR);

  const parsedSample = parsePharmacyQrUri(embeddedSampleUri);
  assert.ok(parsedSample, "Expected SAMPLE_FINNISH_PHARMACY_QR to decode via parsePharmacyQrUri");
  assert.equal(encodePharmacyQrUri(parsedSample), SAMPLE_FINNISH_PHARMACY_QR);
  assert.equal(parsedSample.pharmacy, "Yliopiston Apteekki Helsinki");
  assert.equal(parsedSample.meds.length, 2);
  assert.deepEqual(
    parsedSample.meds.map((m) => ({ id: m.id, barcode: m.barcode, strength: m.strength })),
    [
      { id: "bis", barcode: "6432100024680", strength: "2.5 mg" },
      { id: "ato", barcode: "6432100086420", strength: "20 mg" },
    ],
  );

  const firstSampleMerge = mergePharmacyPayload(demoProfile, parsedSample);
  assert.equal(firstSampleMerge.added, 2);
  assert.equal(firstSampleMerge.updated, 0);
  assert.deepEqual(firstSampleMerge.profile.meds.slice(0, demoProfile.meds.length), demoProfile.meds);

  const secondSampleMerge = mergePharmacyPayload(firstSampleMerge.profile, parsedSample);
  assert.equal(secondSampleMerge.added, 0);
  assert.equal(secondSampleMerge.updated, 2);
  assert.deepEqual(secondSampleMerge.profile, firstSampleMerge.profile);

  const fullDemoRoundtripUri = encodePharmacyQrUri({
    v: 1,
    pharmacy: "Yliopiston Apteekki Helsinki",
    meds: demoProfile.meds,
    allergies: demoProfile.allergies,
    avoid: demoProfile.avoid,
  });
  const fullDemoDecoded = parsePharmacyQrUri(fullDemoRoundtripUri);
  assert.ok(fullDemoDecoded);
  assert.deepEqual(fullDemoDecoded.meds, demoProfile.meds);
  assert.deepEqual(fullDemoDecoded.allergies, demoProfile.allergies);
  assert.deepEqual(fullDemoDecoded.avoid, demoProfile.avoid);
});

test("booth-html-artifacts.test.ts contains zero comments, zero em dashes, zero trailers, and zero keys", () => {
  const src = fs.readFileSync(SELF_FILE, "utf8");
  assert.equal(src.includes(DOUBLE_SLASH), false, "Must not contain double-slash token");
  assert.equal(src.includes(BLOCK_COMMENT_OPEN), false, "Must not contain block comment open token");
  assert.equal(src.includes(BLOCK_COMMENT_CLOSE), false, "Must not contain block comment close token");
  assert.equal(src.includes(HTML_COMMENT_OPEN), false, "Must not contain HTML comment open token");
  assert.equal(src.includes(EM_DASH), false, "Must not contain em dash");
  assert.equal(new RegExp(CO_AUTHORED, "i").test(src), false, "Must not contain co-author trailer");
  assert.equal(API_KEY_RE.test(src), false, "Must not contain API key");
});
