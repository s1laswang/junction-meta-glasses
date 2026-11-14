import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { offlineBarcodeVerdict } from "../src/camera/barcode.ts";
import {
  MIN_OFFLINE_BARCODE_DIGITS,
  OfflineReadinessCard,
  summarizeOfflineCoverage,
  type OfflineReadinessCardProps
} from "../src/components/OfflineReadinessCard.tsx";
import { DEMO_PROFILE } from "../src/storage/profileStore.ts";
import type { Profile, TransportMode } from "../src/types.ts";

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

const nodeTestSpec: string = "node:test";
const nodeAssertSpec: string = "node:assert/strict";
const nodeFsSpec: string = "node:fs";

const { test } = (await import(nodeTestSpec)) as { test: TestFn };
const assert: AssertStrict = (await import(nodeAssertSpec)) as AssertStrict;
const { readFileSync } = (await import(nodeFsSpec)) as FsModule;

const SLASH = String.fromCharCode(47);
const LINE_COMMENT = SLASH + SLASH;
const BLOCK_COMMENT_OPEN = SLASH + "*";
const BLOCK_COMMENT_CLOSE = "*" + SLASH;
const HTML_COMMENT_OPEN = "<" + "!--";
const EM_DASH = "\u2014";
const EN_DASH = "\u2013";

const EMPTY_PROFILE: Profile = {
  meds: [],
  allergies: [],
  avoid: [],
  doseLog: [],
  lang: "en"
};

const MIXED_PROFILE: Profile = {
  meds: [
    {
      id: "aml",
      name: "Amlodipin",
      ingredient: "amlodipine",
      strength: "5 mg",
      schedule: ["evening"],
      barcode: "6432 1000-12345"
    },
    {
      id: "vitd",
      name: "Vitamin D",
      ingredient: "colecalciferol",
      strength: "20 mcg",
      schedule: ["morning"]
    },
    {
      id: "upc",
      name: "Aspirin Cardio",
      ingredient: "aspirin",
      strength: "100 mg",
      schedule: ["morning"],
      barcode: "036000-291452"
    }
  ],
  allergies: [],
  avoid: [],
  doseLog: [],
  lang: "en"
};

function renderCard(props: OfflineReadinessCardProps): string {
  return renderToStaticMarkup(createElement(OfflineReadinessCard, props));
}

function extractOpeningTagByAttr(html: string, attrName: string, attrValue: string): string {
  const escapedAttr = attrName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedVal = attrValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `<([a-z0-9]+)\\b[^>]*\\b${escapedAttr}="${escapedVal}"[^>]*>`,
    "i"
  );
  const match = pattern.exec(html);
  assert.ok(match, `Expected element with ${attrName}="${attrValue}"`);
  return match[0];
}

type ListenerEntry = {
  fn: (ev: unknown) => void;
  capture: boolean;
};

class MiniDomNode {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly tagName: string;
  namespaceURI = `http:${SLASH}${SLASH}www.w3.org${SLASH}1999${SLASH}xhtml`;
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

  findByAttr(attr: string, expected: string): MiniDomNode | null {
    if (this.attributes.get(attr) === expected) {
      return this;
    }
    for (const child of this.childNodes) {
      const found = child.findByAttr(attr, expected);
      if (found) {
        return found;
      }
    }
    return null;
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
  props: OfflineReadinessCardProps,
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
      root.render(createElement(OfflineReadinessCard, props));
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

test("summarizeOfflineCoverage reports 3/3 = 100% for DEMO_PROFILE and aligns with offlineBarcodeVerdict", () => {
  assert.equal(MIN_OFFLINE_BARCODE_DIGITS, 8);

  const snapshotBefore = JSON.stringify(DEMO_PROFILE);
  const summary = summarizeOfflineCoverage(DEMO_PROFILE);
  assert.equal(JSON.stringify(DEMO_PROFILE), snapshotBefore);

  assert.equal(summary.totalMeds, 3);
  assert.equal(summary.barcodeReadyCount, 3);
  assert.equal(summary.missingBarcodeCount, 0);
  assert.equal(summary.coveragePct, 100);
  assert.deepEqual(summary.items, [
    {
      id: "aml",
      name: "Amlodipin",
      strength: "5 mg",
      normalizedBarcode: "6432100012345",
      offlineReady: true
    },
    {
      id: "met",
      name: "Metformin",
      strength: "500 mg",
      normalizedBarcode: "6432100054321",
      offlineReady: true
    },
    {
      id: "par",
      name: "Panadol",
      strength: "500 mg",
      normalizedBarcode: "6432100098765",
      offlineReady: true
    }
  ]);

  const fixedNow = new Date(2026, 10, 14, 20, 0, 0);
  for (const item of summary.items) {
    assert.ok(item.normalizedBarcode !== null);
    const verdict = offlineBarcodeVerdict(item.normalizedBarcode, DEMO_PROFILE, fixedNow);
    assert.equal(verdict.level, "match");
    assert.equal(verdict.matchedMedId, item.id);
  }
});

test("summarizeOfflineCoverage handles mixed ready/missing profiles, EAN-8/UPC-A normalization, <8 digit rejection, and empty profiles", () => {
  const mixed = summarizeOfflineCoverage(MIXED_PROFILE);
  assert.equal(mixed.totalMeds, 3);
  assert.equal(mixed.barcodeReadyCount, 2);
  assert.equal(mixed.missingBarcodeCount, 1);
  assert.equal(mixed.coveragePct, 67);
  assert.deepEqual(mixed.items, [
    {
      id: "aml",
      name: "Amlodipin",
      strength: "5 mg",
      normalizedBarcode: "6432100012345",
      offlineReady: true
    },
    {
      id: "vitd",
      name: "Vitamin D",
      strength: "20 mcg",
      normalizedBarcode: null,
      offlineReady: false
    },
    {
      id: "upc",
      name: "Aspirin Cardio",
      strength: "100 mg",
      normalizedBarcode: "0036000291452",
      offlineReady: true
    }
  ]);

  const edgeProfile: Profile = {
    meds: [
      {
        id: "ean8",
        name: "",
        ingredient: "bisoprolol",
        strength: "2,5 mg",
        schedule: ["morning"],
        barcode: "6412-3456"
      },
      {
        id: "short7",
        name: "ShortCode",
        ingredient: "cetirizine",
        strength: "10 mg",
        schedule: ["evening"],
        barcode: "1234567"
      },
      {
        id: "blank",
        name: "BlankCode",
        ingredient: "ramipril",
        strength: "5 mg",
        schedule: ["morning"],
        barcode: "   abc   "
      }
    ],
    allergies: [],
    avoid: [],
    doseLog: [],
    lang: "en"
  };

  const edgeSummary = summarizeOfflineCoverage(edgeProfile);
  assert.equal(edgeSummary.totalMeds, 3);
  assert.equal(edgeSummary.barcodeReadyCount, 1);
  assert.equal(edgeSummary.missingBarcodeCount, 2);
  assert.equal(edgeSummary.coveragePct, 33);
  assert.deepEqual(edgeSummary.items, [
    {
      id: "ean8",
      name: "bisoprolol",
      strength: "2,5 mg",
      normalizedBarcode: "64123456",
      offlineReady: true
    },
    {
      id: "short7",
      name: "ShortCode",
      strength: "10 mg",
      normalizedBarcode: null,
      offlineReady: false
    },
    {
      id: "blank",
      name: "BlankCode",
      strength: "5 mg",
      normalizedBarcode: null,
      offlineReady: false
    }
  ]);

  const zeroReadyProfile: Profile = {
    ...EMPTY_PROFILE,
    meds: [MIXED_PROFILE.meds[1]]
  };
  const zeroReady = summarizeOfflineCoverage(zeroReadyProfile);
  assert.equal(zeroReady.totalMeds, 1);
  assert.equal(zeroReady.barcodeReadyCount, 0);
  assert.equal(zeroReady.missingBarcodeCount, 1);
  assert.equal(zeroReady.coveragePct, 0);

  const emptySummary = summarizeOfflineCoverage(EMPTY_PROFILE);
  assert.deepEqual(emptySummary, {
    totalMeds: 0,
    barcodeReadyCount: 0,
    missingBarcodeCount: 0,
    coveragePct: 100,
    items: []
  });
});

test("OfflineReadinessCard SSR renders accessible section, coverage meter, per-med badges, and mode === offline active callout", () => {
  const liveDemoHtml = renderCard({
    profile: DEMO_PROFILE,
    mode: "live",
    lang: "en"
  });

  assert.match(
    liveDemoHtml,
    /^<section\b[^>]*aria-labelledby="offline-readiness-card-heading"[^>]*lang="en"/
  );
  assert.match(
    liveDemoHtml,
    /<h2\b[^>]*id="offline-readiness-card-heading"[^>]*>On-Device Offline Barcode Coverage &amp; Pack Readiness<\/h2>/
  );
  assert.ok(liveDemoHtml.includes('data-coverage-pct="100"'));
  assert.ok(liveDemoHtml.includes('data-ready-count="3"'));
  assert.ok(liveDemoHtml.includes('data-missing-count="0"'));
  assert.ok(liveDemoHtml.includes("3/3 Ready (100%)"));
  assert.equal(liveDemoHtml.includes('data-offline-callout="active"'), false);

  const meterTag = extractOpeningTagByAttr(liveDemoHtml, "data-coverage-meter", "true");
  assert.ok(meterTag.includes('value="100"'));
  assert.ok(meterTag.includes('aria-label="Offline barcode coverage: 100% (3 of 3 saved medications ready)"'));

  for (const medId of ["aml", "met", "par"]) {
    const liTag = extractOpeningTagByAttr(liveDemoHtml, "data-med-id", medId);
    assert.ok(liTag.includes('data-offline-ready="true"'));
  }
  assert.ok(liveDemoHtml.includes("EAN/GTIN 6432100012345"));
  assert.ok(liveDemoHtml.includes("EAN/GTIN 6432100054321"));
  assert.ok(liveDemoHtml.includes("EAN/GTIN 6432100098765"));

  const snapshotMixedHtml = renderCard({
    profile: MIXED_PROFILE,
    mode: "snapshot",
    lang: "en"
  });
  assert.equal(snapshotMixedHtml.includes('data-offline-callout="active"'), false);
  assert.ok(snapshotMixedHtml.includes("2/3 Ready (67%)"));
  assert.ok(snapshotMixedHtml.includes('data-med-badge="ready"'));
  assert.ok(snapshotMixedHtml.includes('data-med-badge="missing"'));
  assert.ok(snapshotMixedHtml.includes("OFFLINE READY"));
  assert.ok(snapshotMixedHtml.includes("MISSING BARCODE"));
  assert.ok(snapshotMixedHtml.includes("EAN/GTIN 0036000291452"));

  const vitdTag = extractOpeningTagByAttr(snapshotMixedHtml, "data-med-id", "vitd");
  assert.ok(vitdTag.includes('data-offline-ready="false"'));

  const offlineDemoHtml = renderCard({
    profile: DEMO_PROFILE,
    mode: "offline",
    lang: "en"
  });
  const calloutTag = extractOpeningTagByAttr(offlineDemoHtml, "data-offline-callout", "active");
  assert.ok(calloutTag.includes('role="status"'));
  assert.ok(calloutTag.includes('aria-live="polite"'));
  assert.ok(offlineDemoHtml.includes("Offline Mode Active: On-Device Barcode Matching Only"));
  assert.ok(offlineDemoHtml.includes("All 3 saved prescriptions have a verified EAN/GTIN barcode"));

  const offlineMixedHtml = renderCard({
    profile: MIXED_PROFILE,
    mode: "offline",
    lang: "en"
  });
  assert.ok(offlineMixedHtml.includes('data-offline-callout="active"'));
  assert.ok(
    offlineMixedHtml.includes(
      "2 of 3 saved prescriptions can be matched by barcode offline, while 1 pack lacks a saved barcode"
    )
  );

  const offlineEmptyHtml = renderCard({
    profile: EMPTY_PROFILE,
    mode: "offline",
    lang: "en"
  });
  assert.ok(offlineEmptyHtml.includes('data-offline-callout="active"'));
  assert.ok(offlineEmptyHtml.includes('data-empty-meds="true"'));
  assert.ok(offlineEmptyHtml.includes("0 Saved Meds (100%)"));
  assert.ok(offlineEmptyHtml.includes("0 medications are saved on this device"));
});

test("Localizes OfflineReadinessCard across en, fi, and sv with en fallback", () => {
  const enHtml = renderCard({
    profile: MIXED_PROFILE,
    mode: "offline",
    lang: "en",
    onScanBarcodeNow: () => {},
    onOpenPharmacyImport: () => {}
  });
  const fiHtml = renderCard({
    profile: MIXED_PROFILE,
    mode: "offline",
    lang: "fi",
    onScanBarcodeNow: () => {},
    onOpenPharmacyImport: () => {}
  });
  const svHtml = renderCard({
    profile: MIXED_PROFILE,
    mode: "offline",
    lang: "sv",
    onScanBarcodeNow: () => {},
    onOpenPharmacyImport: () => {}
  });
  const fiRegionalHtml = renderCard({
    profile: MIXED_PROFILE,
    mode: "offline",
    lang: "fi-FI",
    onScanBarcodeNow: () => {},
    onOpenPharmacyImport: () => {}
  });
  const svRegionalHtml = renderCard({
    profile: MIXED_PROFILE,
    mode: "offline",
    lang: "sv-SE",
    onScanBarcodeNow: () => {},
    onOpenPharmacyImport: () => {}
  });
  const deFallbackHtml = renderCard({
    profile: MIXED_PROFILE,
    mode: "offline",
    lang: "de",
    onScanBarcodeNow: () => {},
    onOpenPharmacyImport: () => {}
  });

  assert.notEqual(enHtml, fiHtml);
  assert.notEqual(enHtml, svHtml);
  assert.notEqual(fiHtml, svHtml);
  assert.equal(fiRegionalHtml, fiHtml);
  assert.equal(svRegionalHtml, svHtml);
  assert.equal(deFallbackHtml, enHtml);

  assert.ok(enHtml.includes('lang="en"'));
  assert.ok(enHtml.includes("Scan Barcode Now"));
  assert.ok(enHtml.includes("Import Pharmacy QR"));
  assert.ok(enHtml.includes("Not a medical device. Always confirm uncertain labels with a pharmacist."));

  assert.ok(fiHtml.includes('lang="fi"'));
  assert.ok(fiHtml.includes("Laitteen offline-viivakoodikattavuus ja pakkausvalmius"));
  assert.ok(fiHtml.includes("Offline-tila käytössä: vain laitteen viivakooditäsmäys"));
  assert.ok(fiHtml.includes("OFFLINE-VALMIS"));
  assert.ok(fiHtml.includes("VIIVAKOODI PUUTTUU"));
  assert.ok(fiHtml.includes("Lue viivakoodi nyt"));
  assert.ok(fiHtml.includes("Tuo apteekin QR"));
  assert.ok(fiHtml.includes("Ei lääkinnällinen laite. Varmista epävarmat pakkaukset aina apteekista."));

  assert.ok(svHtml.includes('lang="sv"'));
  assert.ok(svHtml.includes("Lokal offline-streckkodstäckning och förpackningsberedskap"));
  assert.ok(svHtml.includes("Offline-läge aktivt: endast lokal streckkodsmatchning"));
  assert.ok(svHtml.includes("OFFLINE-REDO"));
  assert.ok(svHtml.includes("STRECKKOD SAKNAS"));
  assert.ok(svHtml.includes("Skanna streckkod nu"));
  assert.ok(svHtml.includes("Importera apoteks-QR"));
  assert.ok(
    svHtml.includes(
      "Inte en medicinteknisk produkt. Kontrollera alltid osäkra etiketter med apotekspersonal."
    )
  );
});

test("Action buttons render >= 56px targets only when callbacks are supplied and invoke handlers on click", async () => {
  const noButtonsHtml = renderCard({
    profile: DEMO_PROFILE,
    mode: "live",
    lang: "en"
  });
  assert.equal(noButtonsHtml.includes("<button"), false);

  const scanOnlyHtml = renderCard({
    profile: DEMO_PROFILE,
    mode: "live",
    lang: "en",
    onScanBarcodeNow: () => {}
  });
  assert.ok(scanOnlyHtml.includes('data-action="scan-barcode-now"'));
  assert.equal(scanOnlyHtml.includes('data-action="open-pharmacy-import"'), false);

  const importOnlyHtml = renderCard({
    profile: DEMO_PROFILE,
    mode: "live",
    lang: "en",
    onOpenPharmacyImport: () => {}
  });
  assert.equal(importOnlyHtml.includes('data-action="scan-barcode-now"'), false);
  assert.ok(importOnlyHtml.includes('data-action="open-pharmacy-import"'));

  const bothHtml = renderCard({
    profile: DEMO_PROFILE,
    mode: "offline",
    lang: "en",
    onScanBarcodeNow: () => {},
    onOpenPharmacyImport: () => {}
  });

  const scanBtnTag = extractOpeningTagByAttr(bothHtml, "data-action", "scan-barcode-now");
  const importBtnTag = extractOpeningTagByAttr(bothHtml, "data-action", "open-pharmacy-import");

  for (const [label, btnTag] of [
    ["scan-barcode-now", scanBtnTag],
    ["open-pharmacy-import", importBtnTag]
  ] as const) {
    assert.ok(btnTag.startsWith("<button"), `${label} must be a <button>`);
    assert.ok(btnTag.includes('type="button"'), `${label} must declare type="button"`);
    assert.ok(btnTag.includes("aria-label="), `${label} must expose aria-label`);
    const minHeightMatch = /min-height:(\d+)px/.exec(btnTag);
    const minWidthMatch = /min-width:(\d+)px/.exec(btnTag);
    assert.ok(minHeightMatch, `${label} must set min-height in px`);
    assert.ok(minWidthMatch, `${label} must set min-width in px`);
    assert.ok(Number.parseInt(minHeightMatch[1], 10) >= 56, `${label} min-height must be >= 56px`);
    assert.ok(Number.parseInt(minWidthMatch[1], 10) >= 56, `${label} min-width must be >= 56px`);
  }

  for (const locale of ["en", "fi", "sv"] as const) {
    let scanCalls = 0;
    let importCalls = 0;

    await withMountedCard(
      {
        profile: MIXED_PROFILE,
        mode: "offline",
        lang: locale,
        onScanBarcodeNow: () => {
          scanCalls += 1;
        },
        onOpenPharmacyImport: () => {
          importCalls += 1;
        }
      },
      async (container) => {
        const scanBtn = container.findByAttr("data-action", "scan-barcode-now");
        const importBtn = container.findByAttr("data-action", "open-pharmacy-import");
        assert.ok(scanBtn, `Expected scan button in ${locale}`);
        assert.ok(importBtn, `Expected import button in ${locale}`);

        await act(async () => {
          scanBtn.dispatchBubblingEvent("click");
        });
        assert.equal(scanCalls, 1);
        assert.equal(importCalls, 0);

        await act(async () => {
          importBtn.dispatchBubblingEvent("click");
        });
        assert.equal(scanCalls, 1);
        assert.equal(importCalls, 1);
      }
    );
  }
});

test("OfflineReadinessCard and test suite contain zero code comments, zero em/en dashes, and zero SSR leaks", () => {
  const componentSource = readFileSync(
    new URL("../src/components/OfflineReadinessCard.tsx", import.meta.url),
    "utf8"
  );
  const testSource = readFileSync(
    new URL("./offlineReadinessCard.test.ts", import.meta.url),
    "utf8"
  );

  for (const [label, source] of [
    ["OfflineReadinessCard.tsx", componentSource],
    ["offlineReadinessCard.test.ts", testSource]
  ] as const) {
    assert.equal(source.includes(LINE_COMMENT), false, `${label} must not contain line comments`);
    assert.equal(
      source.includes(BLOCK_COMMENT_OPEN),
      false,
      `${label} must not contain block comments`
    );
    assert.equal(
      source.includes(BLOCK_COMMENT_CLOSE),
      false,
      `${label} must not contain block comment closures`
    );
    assert.equal(source.includes(HTML_COMMENT_OPEN), false, `${label} must not contain HTML comments`);
    assert.equal(source.includes(EM_DASH), false, `${label} must not contain em dashes`);
    assert.equal(source.includes(EN_DASH), false, `${label} must not contain en dashes`);
  }

  const dashInjectedProfile: Profile = {
    meds: [
      {
        id: `med${EM_DASH}1`,
        name: `Amlodipin ${EM_DASH} Evening`,
        ingredient: "amlodipine",
        strength: `5${EN_DASH}10 mg`,
        schedule: ["evening"],
        barcode: "6432100012345"
      }
    ],
    allergies: [],
    avoid: [],
    doseLog: [],
    lang: "en"
  };

  const modes: readonly TransportMode[] = ["live", "snapshot", "offline"];
  const profiles: readonly Profile[] = [
    DEMO_PROFILE,
    MIXED_PROFILE,
    EMPTY_PROFILE,
    dashInjectedProfile
  ];

  for (const locale of ["en", "fi", "sv", "de"]) {
    for (const mode of modes) {
      for (const profile of profiles) {
        const html = renderCard({
          profile,
          mode,
          lang: locale,
          onScanBarcodeNow: () => {},
          onOpenPharmacyImport: () => {}
        });
        assert.equal(html.includes("undefined"), false);
        assert.equal(html.includes("NaN"), false);
        assert.equal(html.includes("[object"), false);
        assert.equal(html.includes(HTML_COMMENT_OPEN), false);
        assert.equal(html.includes(EM_DASH), false);
        assert.equal(html.includes(EN_DASH), false);

        const svgOpenings = html.match(/<svg\b[^>]*>/gi) ?? [];
        assert.ok(svgOpenings.length >= 4);
        for (const svgTag of svgOpenings) {
          assert.ok(svgTag.includes('aria-hidden="true"'), `SVG must be aria-hidden: ${svgTag}`);
        }
      }
    }
  }
});
