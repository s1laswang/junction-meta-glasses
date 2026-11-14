import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
  COGNITIVE_DENSITIES,
  DEFAULT_READING_COMFORT,
  READING_COMFORT_KEY,
  TEXT_SCALES,
  isCognitiveDensity,
  isTextScale,
  loadReadingComfort,
  nextTextScale,
  sanitizeReadingComfort,
  saveReadingComfort,
  shouldShowSecondarySurface,
  textScaleCssPercent,
  textScaleMultiplier,
  type CognitiveDensity,
  type KeyValueStorage,
  type ReadingComfortPrefs,
  type TextScale
} from "../src/a11y/readingComfort.ts";
import {
  ReadingComfortBar,
  formatReadingComfortStatus,
  type ReadingComfortBarProps
} from "../src/components/ReadingComfortBar.tsx";
import { createMemoryStorage, wipeAllLocalData } from "../src/storage/profileStore.ts";

(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

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

const nodeTestSpec: string = "node:test";
const nodeAssertSpec: string = `node:assert${SLASH}strict`;
const nodeFsSpec: string = "node:fs";

const { test } = (await import(nodeTestSpec)) as { test: TestFn };
const assert: AssertStrict = (await import(nodeAssertSpec)) as AssertStrict;
const { readFileSync } = (await import(nodeFsSpec)) as FsModule;

function renderBar(props: ReadingComfortBarProps = {}): string {
  return renderToStaticMarkup(createElement(ReadingComfortBar, props));
}

function extractOpeningTags(html: string, tagName: string): string[] {
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

function parseMinDimPx(tag: string, prop: "min-height" | "min-width"): number {
  const pattern = new RegExp(`${prop}\\s*:\\s*(\\d+(?:\\.\\d+)?)px`, "i");
  const match = pattern.exec(tag);
  assert.ok(match, `Expected inline ${prop} in tag: ${tag}`);
  return Number.parseFloat(match[1]);
}

function collectIds(html: string): Set<string> {
  const ids = new Set<string>();
  const re = /\bid="([^"]+)"/gi;
  let match: RegExpExecArray | null = re.exec(html);
  while (match !== null) {
    ids.add(match[1]);
    match = re.exec(html);
  }
  return ids;
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
    this.attributes.set(name, String(value));
  }

  setAttributeNS(_ns: string | null, name: string, value: string): void {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  getAttribute(name: string): string | null {
    return this.attributes.has(name) ? (this.attributes.get(name) ?? null) : null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  addEventListener(
    type: string,
    fn: (ev: unknown) => void,
    options?: boolean | { capture?: boolean }
  ): void {
    const capture = typeof options === "boolean" ? options : Boolean(options?.capture);
    const list = this.listeners.get(type) ?? [];
    list.push({ fn, capture });
    this.listeners.set(type, list);
  }

  removeEventListener(
    type: string,
    fn: (ev: unknown) => void,
    options?: boolean | { capture?: boolean }
  ): void {
    const capture = typeof options === "boolean" ? options : Boolean(options?.capture);
    const list = this.listeners.get(type);
    if (!list) {
      return;
    }
    this.listeners.set(
      type,
      list.filter((entry) => !(entry.fn === fn && entry.capture === capture))
    );
  }

  findAll(predicate: (node: MiniDomNode) => boolean, acc: MiniDomNode[] = []): MiniDomNode[] {
    if (predicate(this)) {
      acc.push(this);
    }
    for (const child of this.childNodes) {
      child.findAll(predicate, acc);
    }
    return acc;
  }

  click(): void {
    const path: MiniDomNode[] = [];
    let cur: MiniDomNode | null = this;
    while (cur) {
      path.push(cur);
      cur = cur.parentNode;
    }
    path.push(this.ownerDocument as unknown as MiniDomNode);

    const event = {
      type: "click",
      bubbles: true,
      cancelable: true,
      defaultPrevented: false,
      target: this,
      currentTarget: this as unknown,
      nativeEvent: null as unknown,
      preventDefault() {
        event.defaultPrevented = true;
      },
      stopPropagation() {},
      stopImmediatePropagation() {}
    };

    for (let i = path.length - 1; i >= 0; i -= 1) {
      const node = path[i];
      event.currentTarget = node;
      const entries = node.listeners?.get("click") ?? [];
      for (const entry of entries) {
        if (entry.capture) {
          entry.fn(event);
        }
      }
    }

    for (let i = 0; i < path.length; i += 1) {
      const node = path[i];
      event.currentTarget = node;
      const entries = node.listeners?.get("click") ?? [];
      for (const entry of entries) {
        if (!entry.capture) {
          entry.fn(event);
        }
      }
    }
  }
}

class MiniDomDocument {
  readonly nodeType = 9;
  readonly nodeName = "#DOCUMENT";
  ownerDocument: MiniDomDocument;
  documentElement: MiniDomNode;
  body: MiniDomNode;
  activeElement: MiniDomNode;
  defaultView: Record<string, unknown>;
  listeners = new Map<string, ListenerEntry[]>();

  constructor(win: Record<string, unknown>) {
    this.ownerDocument = this;
    this.defaultView = win;
    this.documentElement = new MiniDomNode(1, "html", this);
    this.body = new MiniDomNode(1, "body", this);
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
  }

  createElement(tag: string): MiniDomNode {
    return new MiniDomNode(1, tag, this);
  }

  createElementNS(_ns: string, tag: string): MiniDomNode {
    return new MiniDomNode(1, tag, this);
  }

  createTextNode(text: string): MiniDomNode {
    const node = new MiniDomNode(3, "#text", this);
    node.textContentValue = String(text);
    return node;
  }

  createComment(text: string): MiniDomNode {
    const node = new MiniDomNode(8, "#comment", this);
    node.textContentValue = String(text);
    return node;
  }

  addEventListener(
    type: string,
    fn: (ev: unknown) => void,
    options?: boolean | { capture?: boolean }
  ): void {
    const capture = typeof options === "boolean" ? options : Boolean(options?.capture);
    const list = this.listeners.get(type) ?? [];
    list.push({ fn, capture });
    this.listeners.set(type, list);
  }

  removeEventListener(
    type: string,
    fn: (ev: unknown) => void,
    options?: boolean | { capture?: boolean }
  ): void {
    const capture = typeof options === "boolean" ? options : Boolean(options?.capture);
    const list = this.listeners.get(type);
    if (!list) {
      return;
    }
    this.listeners.set(
      type,
      list.filter((entry) => !(entry.fn === fn && entry.capture === capture))
    );
  }
}

async function withMiniDom(run: (container: MiniDomNode) => Promise<void>): Promise<void> {
  const g = globalThis as Record<string, unknown>;
  const savedWindow = g.window;
  const savedDocument = g.document;
  const savedHTMLElement = g.HTMLElement;
  const savedNode = g.Node;

  class FakeIframe {}
  const win: Record<string, unknown> = {
    event: undefined,
    HTMLIFrameElement: FakeIframe,
    HTMLElement: MiniDomNode,
    Element: MiniDomNode,
    Node: MiniDomNode,
    navigator: g.navigator ?? { userAgent: "node" },
    addEventListener: () => {},
    removeEventListener: () => {}
  };
  const doc = new MiniDomDocument(win);
  win.document = doc;

  g.window = win;
  g.document = doc;
  g.HTMLElement = MiniDomNode;
  g.Node = MiniDomNode;

  const container = doc.createElement("div");
  doc.body.appendChild(container);

  try {
    await run(container);
  } finally {
    if (savedWindow === undefined) {
      delete g.window;
    } else {
      g.window = savedWindow;
    }
    if (savedDocument === undefined) {
      delete g.document;
    } else {
      g.document = savedDocument;
    }
    if (savedHTMLElement === undefined) {
      delete g.HTMLElement;
    } else {
      g.HTMLElement = savedHTMLElement;
    }
    if (savedNode === undefined) {
      delete g.Node;
    } else {
      g.Node = savedNode;
    }
  }
}

test("readingComfort constants, nextTextScale, and shouldShowSecondarySurface uphold exact contracts", () => {
  assert.equal(READING_COMFORT_KEY, "holdup.readingComfort");
  assert.deepEqual(DEFAULT_READING_COMFORT, { textScale: "100", density: "full" });
  assert.deepEqual(TEXT_SCALES, ["100", "125", "150"]);
  assert.deepEqual(COGNITIVE_DENSITIES, ["full", "calm"]);

  assert.equal(nextTextScale("100"), "125");
  assert.equal(nextTextScale("125"), "150");
  assert.equal(nextTextScale("150"), "100");
  assert.equal(nextTextScale("invalid" as TextScale), "100");

  assert.equal(shouldShowSecondarySurface("full"), true);
  assert.equal(shouldShowSecondarySurface("calm"), false);

  assert.equal(isTextScale("100"), true);
  assert.equal(isTextScale("125"), true);
  assert.equal(isTextScale("150"), true);
  assert.equal(isTextScale("200"), false);

  assert.equal(isCognitiveDensity("full"), true);
  assert.equal(isCognitiveDensity("calm"), true);
  assert.equal(isCognitiveDensity("minimal"), false);

  assert.equal(textScaleCssPercent("100"), "100%");
  assert.equal(textScaleCssPercent("125"), "125%");
  assert.equal(textScaleCssPercent("150"), "150%");

  assert.equal(textScaleMultiplier("100"), 1);
  assert.equal(textScaleMultiplier("125"), 1.25);
  assert.equal(textScaleMultiplier("150"), 1.5);
});

test("loadReadingComfort and saveReadingComfort persist all valid combinations and sanitize malformed payloads", () => {
  const storage = createMemoryStorage();

  const initial = loadReadingComfort(storage);
  assert.deepEqual(initial, { textScale: "100", density: "full" });
  assert.equal(storage.getItem(READING_COMFORT_KEY), null);

  initial.textScale = "150";
  initial.density = "calm";
  assert.deepEqual(DEFAULT_READING_COMFORT, { textScale: "100", density: "full" });
  assert.deepEqual(loadReadingComfort(storage), { textScale: "100", density: "full" });

  for (const scale of TEXT_SCALES) {
    for (const density of COGNITIVE_DENSITIES) {
      const saved = saveReadingComfort({ textScale: scale, density }, storage);
      assert.deepEqual(saved, { textScale: scale, density });
      assert.deepEqual(loadReadingComfort(storage), { textScale: scale, density });
    }
  }

  for (const corrupt of ["{broken", "", "null", "[]", "99", '"150"']) {
    storage.setItem(READING_COMFORT_KEY, corrupt);
    assert.deepEqual(loadReadingComfort(storage), DEFAULT_READING_COMFORT);
  }

  storage.setItem(READING_COMFORT_KEY, JSON.stringify({ textScale: "125", density: "unknown" }));
  assert.deepEqual(loadReadingComfort(storage), { textScale: "125", density: "full" });

  storage.setItem(READING_COMFORT_KEY, JSON.stringify({ textScale: "900", density: "calm" }));
  assert.deepEqual(loadReadingComfort(storage), { textScale: "100", density: "calm" });

  assert.deepEqual(sanitizeReadingComfort(null), DEFAULT_READING_COMFORT);
});

test("wipeAllLocalData automatically erases holdup.readingComfort across memory, global localStorage, minimal, and fallback stores", () => {
  const storage = createMemoryStorage();
  storage.setItem("unrelated.keep", "yes");
  saveReadingComfort({ textScale: "150", density: "calm" }, storage);
  assert.ok(storage.getItem(READING_COMFORT_KEY) !== null);
  assert.equal(storage.length, 2);

  wipeAllLocalData(storage);

  assert.equal(storage.getItem(READING_COMFORT_KEY), null);
  assert.equal(storage.getItem("unrelated.keep"), "yes");
  assert.deepEqual(loadReadingComfort(storage), DEFAULT_READING_COMFORT);

  const backing = new Map<string, string>();
  const minimalStorage: KeyValueStorage = {
    getItem: (k) => backing.get(k) ?? null,
    setItem: (k, v) => {
      backing.set(k, v);
    },
    removeItem: (k) => {
      backing.delete(k);
    }
  };
  saveReadingComfort({ textScale: "125", density: "calm" }, minimalStorage);
  assert.deepEqual(loadReadingComfort(minimalStorage), { textScale: "125", density: "calm" });
  wipeAllLocalData(minimalStorage);
  assert.deepEqual(loadReadingComfort(minimalStorage), DEFAULT_READING_COMFORT);
  assert.equal(minimalStorage.getItem(READING_COMFORT_KEY), null);

  const throwingStorage: KeyValueStorage = {
    getItem() {
      return null;
    },
    setItem() {
      throw new Error("QuotaExceededError");
    },
    removeItem() {
      throw new Error("SecurityError");
    }
  };
  saveReadingComfort({ textScale: "150", density: "calm" }, throwingStorage);
  assert.deepEqual(loadReadingComfort(throwingStorage), { textScale: "150", density: "calm" });
  wipeAllLocalData(throwingStorage);
  assert.deepEqual(loadReadingComfort(throwingStorage), DEFAULT_READING_COMFORT);

  const prevLocalStorage = (globalThis as { localStorage?: unknown }).localStorage;
  const mockGlobal = createMemoryStorage();
  try {
    (globalThis as { localStorage?: unknown }).localStorage = mockGlobal;
    saveReadingComfort({ textScale: "125", density: "calm" });
    assert.ok(mockGlobal.getItem(READING_COMFORT_KEY) !== null);
    assert.deepEqual(loadReadingComfort(), { textScale: "125", density: "calm" });

    wipeAllLocalData();
    assert.equal(mockGlobal.getItem(READING_COMFORT_KEY), null);
    assert.deepEqual(loadReadingComfort(), DEFAULT_READING_COMFORT);

    delete (globalThis as { localStorage?: unknown }).localStorage;
    saveReadingComfort({ textScale: "150", density: "calm" });
    assert.deepEqual(loadReadingComfort(), { textScale: "150", density: "calm" });
    wipeAllLocalData();
    assert.deepEqual(loadReadingComfort(), DEFAULT_READING_COMFORT);
  } finally {
    if (prevLocalStorage === undefined) {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    } else {
      (globalThis as { localStorage?: unknown }).localStorage = prevLocalStorage;
    }
  }
});

test("ReadingComfortBar SSR renders WCAG 2.2 AAA section, >= 56px buttons, aria-pressed states, data attributes, and polite status across en, fi, sv", () => {
  const htmlEnDefault = renderBar({ lang: "en" });
  const htmlFiDefault = renderBar({ lang: "fi" });
  const htmlSvDefault = renderBar({ lang: "sv" });
  const htmlDeFallback = renderBar({ lang: "de-DE" });

  assert.notEqual(htmlEnDefault, htmlFiDefault);
  assert.notEqual(htmlEnDefault, htmlSvDefault);
  assert.notEqual(htmlFiDefault, htmlSvDefault);
  assert.equal(htmlDeFallback, htmlEnDefault);

  assert.ok(htmlEnDefault.includes("Calm Essential View"));
  assert.ok(htmlEnDefault.includes("Full Detail View"));
  assert.ok(htmlFiDefault.includes("Rauhallinen perustila"));
  assert.ok(htmlFiDefault.includes("Täysi tietonäkymä"));
  assert.ok(htmlSvDefault.includes("Lugnt basläge"));
  assert.ok(htmlSvDefault.includes("Full detaljvy"));

  for (const locale of ["en", "fi", "sv"] as const) {
    for (const scale of TEXT_SCALES) {
      for (const density of COGNITIVE_DENSITIES) {
        const html = renderBar({
          lang: locale,
          prefs: { textScale: scale, density }
        });

        assert.equal(html.includes("undefined"), false);
        assert.equal(html.includes("NaN"), false);
        assert.equal(html.includes("[object"), false);
        assert.equal(html.includes(HTML_COMMENT_OPEN), false);
        assert.equal(html.includes(EM_DASH), false);
        assert.equal(html.includes(EN_DASH), false);

        assert.ok(html.includes("100%"));
        assert.ok(html.includes("125%"));
        assert.ok(html.includes("150%"));

        const sections = extractOpeningTags(html, "section");
        assert.equal(sections.length, 1);
        assert.ok(sections[0].includes('aria-labelledby="reading-comfort-heading"'));
        assert.ok(sections[0].includes(`lang="${locale}"`));
        assert.ok(sections[0].includes(`data-text-scale="${scale}"`));
        assert.ok(sections[0].includes(`data-cognitive-density="${density}"`));
        assert.ok(
          sections[0].includes(
            `data-secondary-surface="${density === "calm" ? "hidden" : "visible"}"`
          )
        );

        const ids = collectIds(html);
        assert.ok(ids.has("reading-comfort-heading"));
        assert.ok(ids.has("reading-comfort-scale-heading"));
        assert.ok(ids.has("reading-comfort-density-heading"));

        const svgs = extractOpeningTags(html, "svg");
        assert.ok(svgs.length >= 6);
        for (const svg of svgs) {
          assert.ok(svg.includes('aria-hidden="true"'));
          assert.ok(svg.includes('focusable="false"'));
        }

        const buttons = extractOpeningTags(html, "button");
        assert.equal(buttons.length, 5);
        for (const btn of buttons) {
          assert.ok(btn.includes('type="button"'));
          assert.ok(/\bclass="[^"]*\bbtn\b/.test(btn));
          assert.ok(parseMinDimPx(btn, "min-height") >= 56);
          assert.ok(parseMinDimPx(btn, "min-width") >= 56);
          assert.ok(/aria-label="[^"]+"/.test(btn));
        }

        for (const candidateScale of TEXT_SCALES) {
          const btnTag = extractOpeningTagByAttr(html, "data-scale-option", candidateScale);
          const expectedPressed = candidateScale === scale ? "true" : "false";
          assert.ok(btnTag.includes(`aria-pressed="${expectedPressed}"`));
        }

        for (const candidateDensity of COGNITIVE_DENSITIES) {
          const btnTag = extractOpeningTagByAttr(html, "data-density-option", candidateDensity);
          const expectedPressed = candidateDensity === density ? "true" : "false";
          assert.ok(btnTag.includes(`aria-pressed="${expectedPressed}"`));
        }

        const statusTag = extractOpeningTagByAttr(html, "role", "status");
        assert.ok(statusTag.includes('aria-live="polite"'));
        assert.ok(statusTag.includes('aria-atomic="true"'));
        assert.ok(statusTag.includes(`data-text-scale="${scale}"`));
        assert.ok(statusTag.includes(`data-cognitive-density="${density}"`));
        const expectedStatusText = formatReadingComfortStatus(locale, {
          textScale: scale,
          density
        });
        assert.ok(html.includes(expectedStatusText));
      }
    }
  }
});

test("ReadingComfortBar interactive clicks toggle text scale and cognitive density, persist to storage, and emit announcements", async () => {
  const storage = createMemoryStorage();
  const observedChanges: ReadingComfortPrefs[] = [];
  const observedScales: TextScale[] = [];
  const observedDensities: CognitiveDensity[] = [];
  const observedAnnouncements: string[] = [];

  await withMiniDom(async (container) => {
    const root = createRoot(container as unknown as Element);

    await act(async () => {
      root.render(
        createElement(ReadingComfortBar, {
          lang: "en",
          storage,
          onChange: (next) => observedChanges.push(next),
          onChangeTextScale: (s) => observedScales.push(s),
          onChangeDensity: (d) => observedDensities.push(d),
          onAnnounce: (msg) => observedAnnouncements.push(msg)
        })
      );
    });

    const getSection = (): MiniDomNode => {
      const found = container.findAll((n) => n.tagName === "SECTION");
      assert.equal(found.length, 1);
      return found[0];
    };

    const getScaleBtn = (scale: TextScale): MiniDomNode => {
      const found = container.findAll(
        (n) => n.tagName === "BUTTON" && n.getAttribute("data-scale-option") === scale
      );
      assert.equal(found.length, 1);
      return found[0];
    };

    const getDensityBtn = (mode: CognitiveDensity): MiniDomNode => {
      const found = container.findAll(
        (n) => n.tagName === "BUTTON" && n.getAttribute("data-density-option") === mode
      );
      assert.equal(found.length, 1);
      return found[0];
    };

    const getStatusNode = (): MiniDomNode => {
      const found = container.findAll((n) => n.getAttribute("role") === "status");
      assert.equal(found.length, 1);
      return found[0];
    };

    assert.equal(getSection().getAttribute("data-text-scale"), "100");
    assert.equal(getSection().getAttribute("data-cognitive-density"), "full");
    assert.equal(getScaleBtn("100").getAttribute("aria-pressed"), "true");
    assert.equal(getScaleBtn("150").getAttribute("aria-pressed"), "false");
    assert.equal(getDensityBtn("full").getAttribute("aria-pressed"), "true");
    assert.equal(getDensityBtn("calm").getAttribute("aria-pressed"), "false");

    await act(async () => {
      getScaleBtn("150").click();
    });

    assert.equal(getSection().getAttribute("data-text-scale"), "150");
    assert.equal(getScaleBtn("150").getAttribute("aria-pressed"), "true");
    assert.equal(getScaleBtn("100").getAttribute("aria-pressed"), "false");
    assert.deepEqual(loadReadingComfort(storage), { textScale: "150", density: "full" });
    assert.match(getStatusNode().textContent, /150% text size, Full Detail View/);

    await act(async () => {
      getDensityBtn("calm").click();
    });

    assert.equal(getSection().getAttribute("data-cognitive-density"), "calm");
    assert.equal(getSection().getAttribute("data-secondary-surface"), "hidden");
    assert.equal(getDensityBtn("calm").getAttribute("aria-pressed"), "true");
    assert.equal(getDensityBtn("full").getAttribute("aria-pressed"), "false");
    assert.deepEqual(loadReadingComfort(storage), { textScale: "150", density: "calm" });
    assert.match(getStatusNode().textContent, /150% text size, Calm Essential View/);

    await act(async () => {
      getScaleBtn("125").click();
      getDensityBtn("full").click();
    });

    assert.equal(getSection().getAttribute("data-text-scale"), "125");
    assert.equal(getSection().getAttribute("data-cognitive-density"), "full");
    assert.equal(getSection().getAttribute("data-secondary-surface"), "visible");
    assert.deepEqual(loadReadingComfort(storage), { textScale: "125", density: "full" });

    assert.deepEqual(observedChanges, [
      { textScale: "150", density: "full" },
      { textScale: "150", density: "calm" },
      { textScale: "125", density: "calm" },
      { textScale: "125", density: "full" }
    ]);
    assert.deepEqual(observedScales, ["150", "125"]);
    assert.deepEqual(observedDensities, ["calm", "full"]);
    assert.equal(observedAnnouncements.length, 4);
    assert.match(observedAnnouncements[1], /Calm Essential View/);
    assert.match(observedAnnouncements[3], /125% text size, Full Detail View/);

    await act(async () => {
      root.unmount();
    });
  });
});

test("readingComfort module, ReadingComfortBar component, and readingComfort test contain zero comments and zero em or en dashes", () => {
  const files: readonly [string, URL][] = [
    ["readingComfort.ts", new URL("../src/a11y/readingComfort.ts", import.meta.url)],
    ["ReadingComfortBar.tsx", new URL("../src/components/ReadingComfortBar.tsx", import.meta.url)],
    ["readingComfort.test.ts", new URL("./readingComfort.test.ts", import.meta.url)]
  ];

  for (const [label, fileUrl] of files) {
    const src = readFileSync(fileUrl, "utf8");
    assert.equal(src.includes(LINE_COMMENT), false, `${label} contains line comment`);
    assert.equal(src.includes(BLOCK_COMMENT_OPEN), false, `${label} contains block comment open`);
    assert.equal(src.includes(BLOCK_COMMENT_CLOSE), false, `${label} contains block comment close`);
    assert.equal(src.includes(HTML_COMMENT_OPEN), false, `${label} contains HTML comment`);
    assert.equal(src.includes(EM_DASH), false, `${label} contains em dash`);
    assert.equal(src.includes(EN_DASH), false, `${label} contains en dash`);
  }
});
