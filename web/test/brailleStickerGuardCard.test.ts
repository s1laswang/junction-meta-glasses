import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BrailleStickerGuardCard,
  getCartonPlacementZones,
  type BrailleStickerGuardCardProps,
  type CartonPlacementZone,
  type CartonPlacementZoneId,
  type CartonZoneStatus
} from "../src/components/BrailleStickerGuardCard.tsx";

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
const EM_DASH = "\u2014";
const EN_DASH = "\u2013";
const HOLDUP_RX_URI = `holdup:${SLASH}${SLASH}rx`;

const nodeTestSpec: string = "node:test";
const nodeAssertSpec: string = `node:assert${SLASH}strict`;
const nodeFsSpec: string = "node:fs";

const { test } = (await import(nodeTestSpec)) as { test: TestFn };
const assert: AssertStrict = (await import(nodeAssertSpec)) as AssertStrict;
const { readFileSync } = (await import(nodeFsSpec)) as FsModule;

const EXPECTED_ZONE_IDS: readonly CartonPlacementZoneId[] = [
  "braille_front_protected",
  "strength_ink_clear",
  "holdup_qr_side_flap",
  "ean_barcode_panel"
];

const EXPECTED_ZONE_STATUSES: readonly CartonZoneStatus[] = [
  "never_cover",
  "never_cover",
  "safe_qr_zone",
  "optical_anchor"
];

const EXPECTED_CARTON_PANELS: readonly string[] = [
  "front",
  "side_flap",
  "barcode_panel"
];

const noop = (): void => {};
const noopSpeak = (_text: string): void => {};

function renderCard(props: BrailleStickerGuardCardProps): string {
  return renderToStaticMarkup(createElement(BrailleStickerGuardCard, props));
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

function extractOpeningTagsByTagName(html: string, tagName: string): string[] {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<${escaped}\\b[^>]*>`, "gi");
  const out: string[] = [];
  let match: RegExpExecArray | null = pattern.exec(html);
  while (match !== null) {
    out.push(match[0]);
    match = pattern.exec(html);
  }
  return out;
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
  props: BrailleStickerGuardCardProps,
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
      root.render(createElement(BrailleStickerGuardCard, props));
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

test("getCartonPlacementZones returns all 4 localized carton zones across en, fi, sv with de fallback and immutability", () => {
  const enZones: CartonPlacementZone[] = getCartonPlacementZones("en");
  const fiZones: CartonPlacementZone[] = getCartonPlacementZones("fi");
  const svZones: CartonPlacementZone[] = getCartonPlacementZones("sv");
  const deZones: CartonPlacementZone[] = getCartonPlacementZones("de");

  for (const [locale, zones] of [
    ["en", enZones],
    ["fi", fiZones],
    ["sv", svZones]
  ] as const) {
    assert.equal(zones.length, 4, `Expected 4 zones for ${locale}`);
    assert.deepEqual(
      zones.map((z) => z.id),
      EXPECTED_ZONE_IDS,
      `Unexpected zone IDs for ${locale}`
    );
    assert.deepEqual(
      zones.map((z) => z.status),
      EXPECTED_ZONE_STATUSES,
      `Unexpected zone statuses for ${locale}`
    );

    for (const zone of zones) {
      assert.ok(zone.title.trim().length > 8, `Short title for ${locale}:${zone.id}`);
      assert.ok(zone.rule.trim().length > 30, `Short rule for ${locale}:${zone.id}`);
      assert.ok(
        zone.spokenGuidance.trim().length > 30,
        `Short spokenGuidance for ${locale}:${zone.id}`
      );
    }

    assert.ok(zones[2].title.includes("25 mm"));
    assert.ok(zones[2].title.includes(HOLDUP_RX_URI));
    assert.ok(zones[2].rule.includes(`${HOLDUP_RX_URI}?v=1`));
    assert.ok(zones[3].rule.includes("EAN-13"));
  }

  for (let i = 0; i < 4; i += 1) {
    assert.notEqual(enZones[i].title, fiZones[i].title);
    assert.notEqual(enZones[i].title, svZones[i].title);
    assert.notEqual(fiZones[i].title, svZones[i].title);

    assert.notEqual(enZones[i].rule, fiZones[i].rule);
    assert.notEqual(enZones[i].rule, svZones[i].rule);
    assert.notEqual(fiZones[i].rule, svZones[i].rule);

    assert.notEqual(enZones[i].spokenGuidance, fiZones[i].spokenGuidance);
    assert.notEqual(enZones[i].spokenGuidance, svZones[i].spokenGuidance);
    assert.notEqual(fiZones[i].spokenGuidance, svZones[i].spokenGuidance);
  }

  assert.deepEqual(deZones, enZones);
  assert.deepEqual(getCartonPlacementZones("de-DE"), enZones);
  assert.deepEqual(getCartonPlacementZones(""), enZones);
  assert.deepEqual(getCartonPlacementZones("fi-FI"), fiZones);
  assert.deepEqual(getCartonPlacementZones("sv-SE"), svZones);
  assert.deepEqual(getCartonPlacementZones("EN-US"), enZones);

  const savedTitle = enZones[0].title;
  enZones[0].title = "mutated";
  assert.equal(getCartonPlacementZones("en")[0].title, savedTitle);
});

test("BrailleStickerGuardCard SSR renders accessible section, labeled role=img 3-panel SVG diagram, 4 zone cards, and >= 56px buttons", () => {
  const html = renderCard({
    lang: "en",
    onOpenPharmacyQr: noop,
    onSpeakGuidance: noopSpeak
  });

  assert.match(
    html,
    /^<section\b[^>]*aria-labelledby="braille-sticker-guard-heading"[^>]*lang="en"/
  );
  assert.match(
    html,
    /<h2\b[^>]*id="braille-sticker-guard-heading"[^>]*>Braille Preservation &amp; Pharmacy Sticker Guardrail<\/h2>/
  );
  assert.ok(html.includes('role="status"'));
  assert.ok(html.includes('aria-live="polite"'));
  assert.ok(html.includes('data-zone-count="4"'));
  assert.ok(html.includes("100% Braille Uncovered"));
  assert.ok(html.includes(`25 x 25 mm ${HOLDUP_RX_URI} Flap`));

  const diagramSvgTag = extractOpeningTagByAttr(html, "data-carton-diagram", "three-panel");
  assert.ok(diagramSvgTag.startsWith("<svg"));
  assert.ok(diagramSvgTag.includes('role="img"'));
  assert.ok(diagramSvgTag.includes("aria-label="));
  assert.ok(
    diagramSvgTag.includes(
      'aria-labelledby="braille-carton-diagram-title braille-carton-diagram-desc"'
    )
  );
  assert.match(
    html,
    /<title id="braille-carton-diagram-title">Three-panel medication carton sticker placement diagram<\/title>/
  );
  assert.match(html, /<desc id="braille-carton-diagram-desc">Panel 1 shows protected embossed Braille/);

  for (const panelId of EXPECTED_CARTON_PANELS) {
    const panelTag = extractOpeningTagByAttr(html, "data-carton-panel", panelId);
    assert.ok(panelTag.startsWith("<g"));
  }

  for (let i = 0; i < EXPECTED_ZONE_IDS.length; i += 1) {
    const zoneId = EXPECTED_ZONE_IDS[i];
    const expectedStatus = EXPECTED_ZONE_STATUSES[i];

    const svgZoneTag = extractOpeningTagByAttr(html, "data-diagram-zone", zoneId);
    assert.ok(svgZoneTag.startsWith("<g"));

    const liTag = extractOpeningTagByAttr(html, "data-zone-id", zoneId);
    assert.ok(liTag.startsWith("<li"));
    assert.ok(liTag.includes(`data-zone-status="${expectedStatus}"`));
  }

  assert.equal((html.match(/data-braille-cell="/g) ?? []).length, 8);

  const allSvgs = extractOpeningTagsByTagName(html, "svg");
  assert.ok(allSvgs.length >= 8);
  let roleImgSvgCount = 0;
  for (const svgTag of allSvgs) {
    if (svgTag.includes('data-carton-diagram="three-panel"')) {
      roleImgSvgCount += 1;
      assert.ok(svgTag.includes('role="img"'));
      assert.equal(svgTag.includes('aria-hidden="true"'), false);
    } else {
      assert.ok(svgTag.includes('aria-hidden="true"'), `Decorative SVG must be aria-hidden: ${svgTag}`);
      assert.ok(svgTag.includes('focusable="false"'), `Decorative SVG must set focusable=false: ${svgTag}`);
    }
  }
  assert.equal(roleImgSvgCount, 1);

  const allButtons = extractOpeningTagsByTagName(html, "button");
  assert.equal(allButtons.length, 6);
  for (const btnTag of allButtons) {
    assert.ok(btnTag.includes('type="button"'));
    assert.ok(btnTag.includes("aria-label="));
    assert.match(btnTag, /\bclass="[^"]*\bbtn\b/);
    const minHeightMatch = /min-height:\s*(\d+)px/i.exec(btnTag);
    const minWidthMatch = /min-width:\s*(\d+)px/i.exec(btnTag);
    assert.ok(minHeightMatch, `Expected min-height in px on button: ${btnTag}`);
    assert.ok(minWidthMatch, `Expected min-width in px on button: ${btnTag}`);
    assert.ok(Number.parseInt(minHeightMatch[1], 10) >= 56);
    assert.ok(Number.parseInt(minWidthMatch[1], 10) >= 56);
  }

  const readOnlyHtml = renderCard({ lang: "en" });
  assert.equal(readOnlyHtml.includes("<button"), false);
  assert.ok(readOnlyHtml.includes('data-carton-diagram="three-panel"'));

  const qrOnlyHtml = renderCard({ lang: "en", onOpenPharmacyQr: noop });
  assert.equal(extractOpeningTagsByTagName(qrOnlyHtml, "button").length, 1);
  assert.ok(qrOnlyHtml.includes('data-action="open-pharmacy-qr"'));
  assert.equal(qrOnlyHtml.includes('data-action="speak-zone-guidance"'), false);

  const speakOnlyHtml = renderCard({ lang: "en", onSpeakGuidance: noopSpeak });
  assert.equal(extractOpeningTagsByTagName(speakOnlyHtml, "button").length, 5);
  assert.ok(speakOnlyHtml.includes('data-action="speak-overview-guidance"'));
  assert.equal(speakOnlyHtml.includes('data-action="open-pharmacy-qr"'), false);
});

test("BrailleStickerGuardCard localizes across en, fi, and sv with de fallback", () => {
  const makeLocalized = (lang: string): string =>
    renderCard({
      lang,
      onOpenPharmacyQr: noop,
      onSpeakGuidance: noopSpeak
    });

  const enHtml = makeLocalized("en");
  const fiHtml = makeLocalized("fi");
  const svHtml = makeLocalized("sv");
  const fiRegionalHtml = makeLocalized("fi-FI");
  const svRegionalHtml = makeLocalized("sv-SE");
  const deFallbackHtml = makeLocalized("de");

  assert.notEqual(enHtml, fiHtml);
  assert.notEqual(enHtml, svHtml);
  assert.notEqual(fiHtml, svHtml);
  assert.equal(fiRegionalHtml, fiHtml);
  assert.equal(svRegionalHtml, svHtml);
  assert.equal(deFallbackHtml, enHtml);

  assert.ok(enHtml.includes('lang="en"'));
  assert.ok(enHtml.includes("NEVER COVER"));
  assert.ok(enHtml.includes("SAFE 25 MM QR ZONE"));
  assert.ok(enHtml.includes("OPTICAL OFFLINE ANCHOR"));
  assert.ok(enHtml.includes("Open Pharmacy QR Import"));
  assert.ok(enHtml.includes("Speak Full Placement Guide"));
  assert.ok(enHtml.includes("Not a medical device. Always confirm uncertain labels with a pharmacist."));

  assert.ok(fiHtml.includes('lang="fi"'));
  assert.ok(fiHtml.includes("Pistekirjoituksen suoja ja apteekkitarran sijoitusopas"));
  assert.ok(fiHtml.includes("ÄLÄ PEITÄ KOSKAAN"));
  assert.ok(fiHtml.includes("TURVALLINEN 25 MM QR-ALUE"));
  assert.ok(fiHtml.includes("OPTINEN OFFLINE-ANKKURI"));
  assert.ok(fiHtml.includes("Avaa apteekin QR-tuonti"));
  assert.ok(fiHtml.includes("Kuuntele koko sijoitusopas"));
  assert.ok(fiHtml.includes("Ei lääkinnällinen laite. Varmista epävarmat pakkaukset aina apteekista."));

  assert.ok(svHtml.includes('lang="sv"'));
  assert.ok(svHtml.includes("Punktskriftsskydd och placeringsguide för apoteksetikett"));
  assert.ok(svHtml.includes("TÄCK ALDRIG"));
  assert.ok(svHtml.includes("SÄKER 25 MM QR-ZON"));
  assert.ok(svHtml.includes("OPTISKT OFFLINE-ANKARE"));
  assert.ok(svHtml.includes("Öppna apoteks-QR-import"));
  assert.ok(svHtml.includes("Läs upp hela placeringsguiden"));
  assert.ok(
    svHtml.includes(
      "Inte en medicinteknisk produkt. Kontrollera alltid osäkra etiketter med apotekspersonal."
    )
  );
});

test("Mounted DOM buttons invoke onSpeakGuidance and onOpenPharmacyQr callbacks across en, fi, sv, and de", async () => {
  for (const locale of ["en", "fi", "sv", "de"] as const) {
    const spokenTexts: string[] = [];
    let openQrCount = 0;

    await withMountedCard(
      {
        lang: locale,
        onOpenPharmacyQr: () => {
          openQrCount += 1;
        },
        onSpeakGuidance: (text) => {
          spokenTexts.push(text);
        }
      },
      async (container) => {
        const zoneButtons = container.findAllByAttr("data-action", "speak-zone-guidance");
        assert.equal(zoneButtons.length, 4, `Expected 4 zone speak buttons in ${locale}`);

        for (const btn of zoneButtons) {
          await act(async () => {
            btn.dispatchBubblingEvent("click");
          });
        }

        const expectedZoneGuidance = getCartonPlacementZones(locale).map((z) => z.spokenGuidance);
        assert.deepEqual(spokenTexts, expectedZoneGuidance);
        assert.equal(openQrCount, 0);

        const overviewBtn = container.findByAttr("data-action", "speak-overview-guidance");
        assert.ok(overviewBtn, `Expected overview speak button in ${locale}`);
        await act(async () => {
          overviewBtn.dispatchBubblingEvent("click");
        });
        assert.equal(spokenTexts.length, 5);
        assert.ok(spokenTexts[4].includes("25"));
        assert.equal(openQrCount, 0);

        const openQrBtn = container.findByAttr("data-action", "open-pharmacy-qr");
        assert.ok(openQrBtn, `Expected open-pharmacy-qr button in ${locale}`);
        await act(async () => {
          openQrBtn.dispatchBubblingEvent("click");
        });
        assert.equal(openQrCount, 1);
        assert.equal(spokenTexts.length, 5);
      }
    );
  }
});

test("BrailleStickerGuardCard and test suite contain zero code comments, zero em/en dashes, and zero SSR leaks", () => {
  const componentSource = readFileSync(
    new URL("../src/components/BrailleStickerGuardCard.tsx", import.meta.url),
    "utf8"
  );
  const testSource = readFileSync(
    new URL("./brailleStickerGuardCard.test.ts", import.meta.url),
    "utf8"
  );

  for (const [label, source] of [
    ["BrailleStickerGuardCard.tsx", componentSource],
    ["brailleStickerGuardCard.test.ts", testSource]
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
    assert.equal(
      source.includes(HTML_COMMENT_OPEN),
      false,
      `${label} must not contain HTML comments`
    );
    assert.equal(source.includes(EM_DASH), false, `${label} must not contain em dashes`);
    assert.equal(source.includes(EN_DASH), false, `${label} must not contain en dashes`);
  }

  for (const locale of ["en", "fi", "sv", "de"]) {
    for (const withQr of [false, true]) {
      for (const withSpeak of [false, true]) {
        const html = renderCard({
          lang: locale,
          onOpenPharmacyQr: withQr ? noop : undefined,
          onSpeakGuidance: withSpeak ? noopSpeak : undefined
        });
        assert.equal(html.includes("undefined"), false, `Leaked undefined for ${locale}`);
        assert.equal(html.includes("NaN"), false, `Leaked NaN for ${locale}`);
        assert.equal(html.includes("[object"), false, `Leaked [object for ${locale}`);
        assert.equal(html.includes(HTML_COMMENT_OPEN), false, `HTML comment for ${locale}`);
        assert.equal(html.includes(EM_DASH), false, `Em dash found for ${locale}`);
        assert.equal(html.includes(EN_DASH), false, `En dash found for ${locale}`);
      }
    }
  }
});
