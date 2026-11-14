import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
  WhyGlassesComparisonCard,
  getGlassesComparisonDimensions,
  type GlassesComparisonDimensionId,
  type GlassesComparisonFilter,
  type GlassesComparisonRow,
  type WhyGlassesComparisonCardProps
} from "../src/components/WhyGlassesComparisonCard.tsx";

(globalThis as Record<string, unknown>).React = React;

type TestFn = (name: string, fn: () => void | Promise<void>) => Promise<void>;

type AssertStrict = {
  ok(value: unknown, message?: string): asserts value;
  equal<T>(actual: T, expected: T, message?: string): void;
  notEqual<T>(actual: T, expected: T, message?: string): void;
  deepEqual<T>(actual: T, expected: T, message?: string): void;
  match(value: string, regExp: RegExp, message?: string): void;
  doesNotMatch(value: string, regExp: RegExp, message?: string): void;
};

type FsModule = {
  readFileSync(path: URL | string, encoding: "utf8"): string;
};

const SLASH = String.fromCharCode(47);
const LINE_COMMENT = SLASH + SLASH;
const BLOCK_COMMENT_OPEN = SLASH + "*";
const BLOCK_COMMENT_CLOSE = "*" + SLASH;
const HTML_COMMENT_OPEN = "<" + "!--";
const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);
const XHTML_NS = `http:${SLASH}${SLASH}www.w3.org${SLASH}1999${SLASH}xhtml`;

const nodeTestSpec = "node:test";
const nodeAssertSpec = `node:assert${SLASH}strict`;
const nodeFsSpec = "node:fs";

const { test } = (await import(nodeTestSpec)) as { test: TestFn };
const assert: AssertStrict = (await import(nodeAssertSpec)) as AssertStrict;
const { readFileSync } = (await import(nodeFsSpec)) as FsModule;

const EXPECTED_IDS: readonly GlassesComparisonDimensionId[] = [
  "hands_required",
  "physical_aiming",
  "personal_safety",
  "privacy_autonomy",
  "assistive_tco"
];

function renderCard(props: WhyGlassesComparisonCardProps): string {
  return renderToStaticMarkup(createElement(WhyGlassesComparisonCard, props));
}

function extractOpeningTags(html: string, tagName: string): string[] {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>`, "gi");
  const out: string[] = [];
  let match: RegExpExecArray | null = pattern.exec(html);
  while (match !== null) {
    out.push(match[0]);
    match = pattern.exec(html);
  }
  return out;
}

function extractOpeningTagsByClass(html: string, classToken: string): string[] {
  const escaped = classToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<([a-z0-9]+)\\b[^>]*class="[^"]*\\b${escaped}\\b[^"]*"[^>]*>`, "gi");
  const out: string[] = [];
  let match: RegExpExecArray | null = pattern.exec(html);
  while (match !== null) {
    out.push(match[0]);
    match = pattern.exec(html);
  }
  return out;
}

function parseMinDimPx(tag: string, prop: "min-height" | "min-width"): number {
  const pattern = new RegExp(`${prop}\\s*:\\s*(\\d+(?:\\.\\d+)?)px`, "i");
  const match = pattern.exec(tag);
  assert.ok(match, `Expected inline ${prop} in tag: ${tag}`);
  return Number.parseFloat(match[1]);
}

type ListenerEntry = {
  fn: (ev: unknown) => void;
  capture: boolean;
};

class MiniDomNode {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly tagName: string;
  namespaceURI = XHTML_NS;
  ownerDocument: MiniDomDocument;
  parentNode: MiniDomNode | null = null;
  childNodes: MiniDomNode[] = [];
  style: Record<string, string> = {};
  attributes = new Map<string, string>();
  listeners = new Map<string, ListenerEntry[]>();
  disabled = false;
  textContentValue = "";

  constructor(nodeType: number, name: string, ownerDoc: MiniDomDocument) {
    this.nodeType = nodeType;
    this.nodeName = name.toUpperCase();
    this.tagName = name.toUpperCase();
    this.ownerDocument = ownerDoc;
  }

  get firstChild(): MiniDomNode | null {
    return this.childNodes[0] ?? null;
  }

  get nextSibling(): MiniDomNode | null {
    if (!this.parentNode) {
      return null;
    }
    const idx = this.parentNode.childNodes.indexOf(this);
    return idx >= 0 ? (this.parentNode.childNodes[idx + 1] ?? null) : null;
  }

  get nodeValue(): string {
    return this.textContentValue;
  }

  set nodeValue(val: string) {
    this.textContentValue = String(val);
  }

  get textContent(): string {
    if (this.nodeType === 3) {
      return this.textContentValue;
    }
    return this.childNodes.map((child) => child.textContent).join("");
  }

  set textContent(val: string) {
    if (this.nodeType === 3) {
      this.textContentValue = String(val);
      return;
    }
    const text = String(val);
    if (text.length === 0) {
      for (const child of this.childNodes) {
        child.parentNode = null;
      }
      this.childNodes = [];
      return;
    }
    const textNode = new MiniDomNode(3, "#text", this.ownerDocument);
    textNode.textContentValue = text;
    textNode.parentNode = this;
    this.childNodes = [textNode];
  }

  appendChild(child: MiniDomNode): MiniDomNode {
    if (child.parentNode) {
      child.parentNode.removeChild(child);
    }
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  insertBefore(child: MiniDomNode, ref: MiniDomNode | null): MiniDomNode {
    if (!ref) {
      return this.appendChild(child);
    }
    if (child.parentNode) {
      child.parentNode.removeChild(child);
    }
    const idx = this.childNodes.indexOf(ref);
    child.parentNode = this;
    if (idx === -1) {
      this.childNodes.push(child);
    } else {
      this.childNodes.splice(idx, 0, child);
    }
    return child;
  }

  removeChild(child: MiniDomNode): MiniDomNode {
    const idx = this.childNodes.indexOf(child);
    if (idx >= 0) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }

  setAttribute(name: string, value: string): void {
    const str = String(value);
    this.attributes.set(name, str);
    if (name === "disabled") {
      this.disabled = true;
    }
  }

  setAttributeNS(_ns: string | null, name: string, value: string): void {
    this.setAttribute(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
    if (name === "disabled") {
      this.disabled = false;
    }
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(
    type: string,
    fn: (ev: unknown) => void,
    opts?: boolean | { capture?: boolean }
  ): void {
    const capture = typeof opts === "boolean" ? opts : Boolean(opts?.capture);
    const list = this.listeners.get(type) ?? [];
    list.push({ fn, capture });
    this.listeners.set(type, list);
  }

  removeEventListener(
    type: string,
    fn: (ev: unknown) => void,
    opts?: boolean | { capture?: boolean }
  ): void {
    const capture = typeof opts === "boolean" ? opts : Boolean(opts?.capture);
    const list = this.listeners.get(type);
    if (!list) {
      return;
    }
    const idx = list.findIndex((entry) => entry.fn === fn && entry.capture === capture);
    if (idx >= 0) {
      list.splice(idx, 1);
    }
  }

  dispatchBubblingEvent(type: string): void {
    const path: MiniDomNode[] = [];
    let cursor: MiniDomNode | null = this;
    while (cursor) {
      path.push(cursor);
      cursor = cursor.parentNode;
    }

    const eventObj: {
      type: string;
      target: MiniDomNode;
      srcElement: MiniDomNode;
      currentTarget: MiniDomNode | null;
      bubbles: boolean;
      cancelable: boolean;
      defaultPrevented: boolean;
      propagationStopped: boolean;
      preventDefault(): void;
      stopPropagation(): void;
    } = {
      type,
      target: this,
      srcElement: this,
      currentTarget: null,
      bubbles: true,
      cancelable: true,
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.propagationStopped = true;
      }
    };

    for (let i = path.length - 1; i >= 0; i -= 1) {
      eventObj.currentTarget = path[i];
      for (const listener of [...(path[i].listeners.get(type) ?? [])]) {
        if (listener.capture) {
          listener.fn(eventObj);
        }
      }
    }

    for (let i = 0; i < path.length; i += 1) {
      if (eventObj.propagationStopped) {
        break;
      }
      eventObj.currentTarget = path[i];
      for (const listener of [...(path[i].listeners.get(type) ?? [])]) {
        if (!listener.capture) {
          listener.fn(eventObj);
        }
      }
    }
  }

  findAllByAttr(attr: string, expected: string, out: MiniDomNode[] = []): MiniDomNode[] {
    if (this.attributes.get(attr) === expected) {
      out.push(this);
    }
    for (const child of this.childNodes) {
      child.findAllByAttr(attr, expected, out);
    }
    return out;
  }
}

class MiniDomDocument {
  readonly nodeType = 9;
  defaultView: unknown = null;
  documentElement: MiniDomNode;
  body: MiniDomNode;
  activeElement: MiniDomNode;
  listeners = new Map<string, Set<(ev: unknown) => void>>();

  constructor() {
    this.documentElement = new MiniDomNode(1, "html", this);
    this.body = new MiniDomNode(1, "body", this);
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
  }

  createElement(tag: string): MiniDomNode {
    return new MiniDomNode(1, tag, this);
  }

  createElementNS(ns: string, tag: string): MiniDomNode {
    const el = new MiniDomNode(1, tag, this);
    el.namespaceURI = ns;
    return el;
  }

  createTextNode(text: string): MiniDomNode {
    const node = new MiniDomNode(3, "#text", this);
    node.textContentValue = String(text);
    return node;
  }

  addEventListener(type: string, fn: (ev: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set<(ev: unknown) => void>();
    set.add(fn);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, fn: (ev: unknown) => void): void {
    this.listeners.get(type)?.delete(fn);
  }
}

async function withMountedCard(
  props: WhyGlassesComparisonCardProps,
  run: (container: MiniDomNode) => Promise<void>
): Promise<void> {
  const g = globalThis as Record<string, unknown>;
  const prevWindow = g.window;
  const prevDocument = g.document;
  const prevActEnv = g.IS_REACT_ACT_ENVIRONMENT;

  const doc = new MiniDomDocument();
  const container = doc.createElement("div");
  doc.body.appendChild(container);

  class FakeIframe {}
  const winObj: Record<string, unknown> = {
    HTMLIFrameElement: FakeIframe,
    HTMLElement: MiniDomNode,
    Element: MiniDomNode,
    Node: MiniDomNode,
    document: doc,
    addEventListener: () => {},
    removeEventListener: () => {}
  };
  doc.defaultView = winObj;

  g.window = winObj;
  g.document = doc;
  g.IS_REACT_ACT_ENVIRONMENT = true;

  const root = createRoot(container as unknown as Element);

  try {
    await act(async () => {
      root.render(createElement(WhyGlassesComparisonCard, props));
    });
    await run(container);
  } finally {
    await act(async () => {
      root.unmount();
    });
    if (prevWindow === undefined) {
      delete g.window;
    } else {
      g.window = prevWindow;
    }
    if (prevDocument === undefined) {
      delete g.document;
    } else {
      g.document = prevDocument;
    }
    if (prevActEnv === undefined) {
      delete g.IS_REACT_ACT_ENVIRONMENT;
    } else {
      g.IS_REACT_ACT_ENVIRONMENT = prevActEnv;
    }
  }
}

test("getGlassesComparisonDimensions returns all 5 localized rows across en, fi, sv with de fallback and matches eval/unit_economics.json", () => {
  const enRows: GlassesComparisonRow[] = getGlassesComparisonDimensions("en");
  const fiRows: GlassesComparisonRow[] = getGlassesComparisonDimensions("fi");
  const svRows: GlassesComparisonRow[] = getGlassesComparisonDimensions("sv");
  const deRows: GlassesComparisonRow[] = getGlassesComparisonDimensions("de");

  const unitEconomicsRaw = JSON.parse(
    readFileSync(new URL(`..${SLASH}..${SLASH}eval${SLASH}unit_economics.json`, import.meta.url), "utf8")
  ) as {
    headline_summary: {
      per_check_gemini_cost_eur_standard: number;
      tco_3yr_holdup_rayban_meta_gen2_eur: number;
      tco_3yr_orcam_myeye_midpoint_eur: number;
      tco_3yr_aira_paid_daily_plan_eur: number;
      tco_savings_vs_orcam_midpoint_pct: number;
      tco_cost_reduction_multiple_vs_orcam: number;
    };
    token_and_cost_model: {
      usage_cadence: {
        checks_per_year: number;
        checks_over_3_years: number;
      };
    };
  };

  assert.equal(unitEconomicsRaw.headline_summary.tco_3yr_holdup_rayban_meta_gen2_eur, 341.68);
  assert.equal(unitEconomicsRaw.headline_summary.tco_3yr_aira_paid_daily_plan_eur, 2340);
  assert.equal(unitEconomicsRaw.headline_summary.tco_3yr_orcam_myeye_midpoint_eur, 4150);
  assert.equal(unitEconomicsRaw.headline_summary.tco_savings_vs_orcam_midpoint_pct, 91.8);
  assert.equal(unitEconomicsRaw.headline_summary.tco_cost_reduction_multiple_vs_orcam, 12.1);
  assert.equal(unitEconomicsRaw.headline_summary.per_check_gemini_cost_eur_standard, 0.00294);
  assert.equal(unitEconomicsRaw.token_and_cost_model.usage_cadence.checks_per_year, 1440);
  assert.equal(unitEconomicsRaw.token_and_cost_model.usage_cadence.checks_over_3_years, 4320);

  for (const [locale, rows] of [
    ["en", enRows],
    ["fi", fiRows],
    ["sv", svRows]
  ] as const) {
    assert.equal(rows.length, 5, `Expected 5 comparison rows for ${locale}`);
    assert.deepEqual(
      rows.map((r) => r.id),
      EXPECTED_IDS,
      `Unexpected row IDs for ${locale}`
    );

    for (const row of rows) {
      assert.ok(row.dimension.trim().length > 8, `Short dimension for ${locale}:${row.id}`);
      assert.ok(row.holdupGlasses.trim().length > 25, `Short holdupGlasses for ${locale}:${row.id}`);
      assert.ok(row.smartphoneOcr.trim().length > 25, `Short smartphoneOcr for ${locale}:${row.id}`);
      assert.ok(
        row.remoteVolunteerVideo.trim().length > 25,
        `Short remoteVolunteerVideo for ${locale}:${row.id}`
      );
      assert.ok(
        row.legacyOcrCamera.trim().length > 25,
        `Short legacyOcrCamera for ${locale}:${row.id}`
      );
    }

    assert.ok(rows[0].holdupGlasses.includes("0"));
    assert.ok(rows[0].smartphoneOcr.includes("3"));

    assert.ok(rows[1].holdupGlasses.includes("~1 fps"));
    assert.ok(rows[1].holdupGlasses.includes("Gemini Live"));
    assert.ok(rows[1].holdupGlasses.includes("FrameRing.pick"));

    assert.ok(rows[2].holdupGlasses.includes("STRENGTH_MIN_CONF = 0.80"));
    assert.ok(rows[2].smartphoneOcr.includes("0.80"));

    assert.ok(rows[3].holdupGlasses.includes("localStorage"));
    assert.ok(rows[3].holdupGlasses.includes("#000000"));
    assert.ok(rows[3].remoteVolunteerVideo.includes("1,440"));

    assert.ok(rows[4].dimension.includes("4,320"));
    assert.ok(rows[4].holdupGlasses.includes("EUR 341.68"));
    assert.ok(rows[4].holdupGlasses.includes("0.00294"));
    assert.ok(rows[4].holdupGlasses.includes("91.8%"));
    assert.ok(rows[4].holdupGlasses.includes("12.1x"));
    assert.ok(rows[4].remoteVolunteerVideo.includes("EUR 2,340.00"));
    assert.ok(rows[4].legacyOcrCamera.includes("EUR 4,150.00"));
    assert.ok(rows[4].legacyOcrCamera.includes("91.8%"));
  }

  for (let i = 0; i < 5; i += 1) {
    for (const key of [
      "dimension",
      "holdupGlasses",
      "smartphoneOcr",
      "remoteVolunteerVideo",
      "legacyOcrCamera"
    ] as const) {
      assert.notEqual(enRows[i][key], fiRows[i][key], `Expected distinct en/fi ${key} on row ${i}`);
      assert.notEqual(enRows[i][key], svRows[i][key], `Expected distinct en/sv ${key} on row ${i}`);
      assert.notEqual(fiRows[i][key], svRows[i][key], `Expected distinct fi/sv ${key} on row ${i}`);
    }
  }

  assert.deepEqual(deRows, enRows);
  assert.deepEqual(getGlassesComparisonDimensions("de-DE"), enRows);
  assert.deepEqual(getGlassesComparisonDimensions(""), enRows);
  assert.deepEqual(getGlassesComparisonDimensions("fi-FI"), fiRows);
  assert.deepEqual(getGlassesComparisonDimensions("sv-SE"), svRows);
  assert.deepEqual(getGlassesComparisonDimensions("EN-US"), enRows);

  const originalDimension = enRows[0].dimension;
  enRows[0].dimension = "mutated";
  assert.equal(getGlassesComparisonDimensions("en")[0].dimension, originalDimension);
});

test("WhyGlassesComparisonCard SSR renders accessible section, semantic table scopes, 4 KPIs, and >= 56px spotlight buttons across en, fi, sv, and de", () => {
  const enHtml = renderCard({ lang: "en" });
  const fiHtml = renderCard({ lang: "fi" });
  const svHtml = renderCard({ lang: "sv" });
  const deHtml = renderCard({ lang: "de" });
  const fiRegionalHtml = renderCard({ lang: "fi-FI" });
  const svRegionalHtml = renderCard({ lang: "sv-SE" });

  assert.notEqual(enHtml, fiHtml);
  assert.notEqual(enHtml, svHtml);
  assert.notEqual(fiHtml, svHtml);
  assert.equal(deHtml, enHtml);
  assert.equal(fiRegionalHtml, fiHtml);
  assert.equal(svRegionalHtml, svHtml);

  for (const [label, html, expectedLang] of [
    ["en", enHtml, "en"],
    ["fi", fiHtml, "fi"],
    ["sv", svHtml, "sv"],
    ["de", deHtml, "en"]
  ] as const) {
    assert.equal(html.includes("undefined"), false, `Unexpected undefined in ${label}`);
    assert.equal(html.includes("NaN"), false, `Unexpected NaN in ${label}`);
    assert.equal(html.includes("[object"), false, `Unexpected [object in ${label}`);
    assert.equal(html.includes(HTML_COMMENT_OPEN), false, `Unexpected HTML comment in ${label}`);

    const sections = extractOpeningTagsByClass(html, "why-glasses-comparison-card");
    assert.equal(sections.length, 1, `Expected 1 root section in ${label}`);
    assert.ok(sections[0].startsWith("<section"));
    assert.ok(sections[0].includes('aria-labelledby="why-glasses-comparison-heading"'));
    assert.ok(sections[0].includes(`lang="${expectedLang}"`));
    assert.ok(sections[0].includes('data-selected-dimension="all"'));
    assert.ok(html.includes('id="why-glasses-comparison-heading"'));

    const kpiTiles = extractOpeningTagsByClass(html, "why-glasses-kpi-tile");
    assert.equal(kpiTiles.length, 4, `Expected 4 KPI tiles in ${label}`);
    assert.ok(html.includes('data-kpi-id="zero_wrong_doses"'));
    assert.ok(html.includes('data-kpi-id="live_hud_p50"'));
    assert.ok(html.includes('data-kpi-id="three_year_tco"'));
    assert.ok(html.includes('data-kpi-id="tco_savings"'));

    assert.ok(html.includes(">0</strong>"));
    assert.ok(html.includes(">2.74 s</strong>"));
    assert.ok(html.includes(">EUR 341.68</strong>"));
    assert.ok(html.includes(">91.8%</strong>"));

    assert.ok(html.includes("341.68"));
    assert.ok(html.includes("2,340.00"));
    assert.ok(html.includes("4,150"));
    assert.ok(html.includes("4,150.00"));
    assert.ok(html.includes("91.8%"));
    assert.ok(html.includes("2.74 s"));
    assert.ok(html.includes("STRENGTH_MIN_CONF = 0.80"));
    assert.ok(html.includes("FrameRing.pick"));
    assert.ok(html.includes("#000000"));
    assert.ok(html.includes("1,440"));

    const regions = extractOpeningTagsByClass(html, "why-glasses-table-region");
    assert.equal(regions.length, 1);
    assert.ok(regions[0].includes('role="region"'));
    assert.ok(regions[0].includes('aria-labelledby="why-glasses-comparison-table-caption"'));
    assert.ok(regions[0].includes('tabindex="0"'));

    const tables = extractOpeningTagsByClass(html, "why-glasses-comparison-table");
    assert.equal(tables.length, 1);
    assert.ok(tables[0].startsWith("<table"));
    assert.ok(html.includes('<caption id="why-glasses-comparison-table-caption"'));

    const thTags = extractOpeningTags(html, "th");
    const colScopes = thTags.filter((tag) => tag.includes('scope="col"'));
    const rowScopes = thTags.filter((tag) => tag.includes('scope="row"'));
    assert.equal(colScopes.length, 5, `Expected 5 <th scope="col"> in ${label}`);
    assert.equal(rowScopes.length, 5, `Expected 5 <th scope="row"> in ${label}`);
    assert.equal(thTags.length, 10, `Every <th> must have explicit col or row scope in ${label}`);

    for (const id of EXPECTED_IDS) {
      assert.ok(
        rowScopes.some((tag) => tag.includes(`data-row-header="${id}"`)),
        `Missing <th scope="row"> for ${id} in ${label}`
      );
    }

    const tdTags = extractOpeningTags(html, "td");
    assert.equal(tdTags.length, 20, `Expected 20 <td> cells across 5 rows in ${label}`);

    const filterBtns = extractOpeningTagsByClass(html, "why-glasses-filter-btn");
    assert.equal(filterBtns.length, 6, `Expected 6 spotlight filter buttons in ${label}`);
    for (const btnTag of filterBtns) {
      assert.ok(btnTag.startsWith("<button"));
      assert.ok(btnTag.includes('type="button"'));
      assert.ok(/aria-label="[^"]+"/.test(btnTag));
      assert.ok(parseMinDimPx(btnTag, "min-height") >= 56);
      assert.ok(parseMinDimPx(btnTag, "min-width") >= 56);
    }

    const svgTags = extractOpeningTags(html, "svg");
    assert.ok(svgTags.length >= 15);
    for (const svgTag of svgTags) {
      assert.ok(svgTag.includes('aria-hidden="true"'));
      assert.ok(svgTag.includes('focusable="false"'));
    }
  }

  assert.ok(enHtml.includes("HoldUp on Meta AI Glasses"));
  assert.ok(enHtml.includes("Smartphone OCR Apps"));
  assert.ok(enHtml.includes("Remote Human Video"));
  assert.ok(enHtml.includes("Dedicated OCR Cameras (OrCam)"));
  assert.ok(enHtml.includes("Confident-wrong doses"));

  assert.ok(fiHtml.includes("HoldUp Meta AI -laseilla"));
  assert.ok(fiHtml.includes("Älypuhelimen OCR-sovellukset"));
  assert.ok(fiHtml.includes("Etävideotuki"));
  assert.ok(fiHtml.includes("Erilliset OCR-kamerat (OrCam)"));

  assert.ok(svHtml.includes("HoldUp på Meta AI-glasögon"));
  assert.ok(svHtml.includes("Mobilappar med OCR"));
  assert.ok(svHtml.includes("Mänsklig videoassistans"));
  assert.ok(svHtml.includes("Dedikerade OCR-kameror (OrCam)"));
});

test("WhyGlassesComparisonCard interactive dimension buttons spotlight individual rows while keeping all 5 semantic rows mounted", async () => {
  await withMountedCard({ lang: "en" }, async (container) => {
    const buttons = container.findAllByAttr("data-action", "spotlight-dimension");
    assert.equal(buttons.length, 6);

    for (const targetId of EXPECTED_IDS) {
      const btn = container.findAllByAttr("data-dimension-filter", targetId)[0];
      assert.ok(btn, `Expected filter button for ${targetId}`);

      await act(async () => {
        btn.dispatchBubblingEvent("click");
      });

      const rootSection = container.findAllByAttr("data-selected-dimension", targetId);
      assert.equal(rootSection.length, 1);
      assert.equal(btn.getAttribute("aria-pressed"), "true");

      const spotlightBanner = container.findAllByAttr("data-spotlight-active", targetId);
      assert.equal(spotlightBanner.length, 1);

      for (const candidateId of EXPECTED_IDS) {
        const rowNodes = container.findAllByAttr("data-dimension-id", candidateId);
        assert.equal(rowNodes.length, 1, `Row ${candidateId} must remain mounted`);
        assert.equal(
          rowNodes[0].getAttribute("data-highlighted"),
          candidateId === targetId ? "true" : "false"
        );
      }
    }

    const allBtn = container.findAllByAttr("data-dimension-filter", "all")[0];
    await act(async () => {
      allBtn.dispatchBubblingEvent("click");
    });
    assert.equal(container.findAllByAttr("data-selected-dimension", "all").length, 1);
    assert.equal(container.findAllByAttr("data-highlighted", "true").length, 0);
  });
});

test("WhyGlassesComparisonCard and test suite contain zero comments and zero em or en dashes", () => {
  const componentSource = readFileSync(
    new URL(`..${SLASH}src${SLASH}components${SLASH}WhyGlassesComparisonCard.tsx`, import.meta.url),
    "utf8"
  );
  const testSource = readFileSync(
    new URL(`.${SLASH}whyGlassesComparisonCard.test.ts`, import.meta.url),
    "utf8"
  );

  for (const [label, source] of [
    ["WhyGlassesComparisonCard.tsx", componentSource],
    ["whyGlassesComparisonCard.test.ts", testSource]
  ] as const) {
    assert.equal(source.includes(LINE_COMMENT), false, `${label} must not contain line comments`);
    assert.equal(
      source.includes(BLOCK_COMMENT_OPEN),
      false,
      `${label} must not contain block comment openings`
    );
    assert.equal(
      source.includes(BLOCK_COMMENT_CLOSE),
      false,
      `${label} must not contain block comment closures`
    );
    assert.equal(
      source.includes(HTML_COMMENT_OPEN),
      false,
      `${label} must not contain HTML comments`
    );
    assert.equal(source.includes(EM_DASH), false, `${label} must not contain em dashes`);
    assert.equal(source.includes(EN_DASH), false, `${label} must not contain en dashes`);
  }

  const filters: readonly GlassesComparisonFilter[] = ["all", ...EXPECTED_IDS];
  for (const lang of ["en", "fi", "sv", "de"]) {
    for (const filter of filters) {
      const html = renderCard({ lang, defaultSelectedDimension: filter });
      assert.equal(html.includes(EM_DASH), false, `Em dash in HTML for ${lang}:${filter}`);
      assert.equal(html.includes(EN_DASH), false, `En dash in HTML for ${lang}:${filter}`);
      assert.equal(
        html.includes(HTML_COMMENT_OPEN),
        false,
        `HTML comment in HTML for ${lang}:${filter}`
      );
      assert.equal(html.includes("undefined"), false, `Leaked undefined for ${lang}:${filter}`);
    }
  }
});
