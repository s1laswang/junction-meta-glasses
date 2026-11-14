import React, { act, createElement, isValidElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
  TactileHandlingGuideCard,
  getTactileHoldTechniques,
  type TactileHandlingGuideCardProps,
  type TactileHoldTechnique,
  type TactileTechniqueId
} from "../src/components/TactileHandlingGuideCard.tsx";
import type { CoachCue } from "../src/types.ts";

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

const EM_DASH = "\u2014";
const EN_DASH = "\u2013";
const LINE_COMMENT = "\x2f\x2f";
const BLOCK_COMMENT_OPEN = "\x2f*";
const BLOCK_COMMENT_CLOSE = "*\x2f";
const HTML_COMMENT_OPEN = "<" + "!--";

const EXPECTED_IDS: readonly TactileTechniqueId[] = [
  "chest_anchor",
  "bottle_quarter_turn",
  "blister_glare_tilt",
  "carton_barcode_find"
];

const EXPECTED_CUES: readonly CoachCue[] = [
  "hold_still",
  "rotate_left",
  "more_light",
  "other_side"
];

const ALL_COACH_CUES: readonly CoachCue[] = [
  "rotate_left",
  "rotate_right",
  "closer",
  "farther",
  "more_light",
  "hold_still",
  "other_side",
  "ok"
];

const noopSpeak = (_spokenTip: string): void => {};

function renderCard(props: TactileHandlingGuideCardProps): string {
  return renderToStaticMarkup(createElement(TactileHandlingGuideCard, props));
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

type ListenerEntry = {
  fn: (ev: unknown) => void;
  capture: boolean;
};

class MiniDomNode {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly tagName: string;
  namespaceURI = "http:\x2f\x2fwww.w3.org\x2f1999\x2fxhtml";
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
  props: TactileHandlingGuideCardProps,
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
      root.render(createElement(TactileHandlingGuideCard, props));
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

test("getTactileHoldTechniques returns all 4 localized techniques across en, fi, sv with de fallback and immutability", () => {
  const enList: TactileHoldTechnique[] = getTactileHoldTechniques("en");
  const fiList: TactileHoldTechnique[] = getTactileHoldTechniques("fi");
  const svList: TactileHoldTechnique[] = getTactileHoldTechniques("sv");
  const deList: TactileHoldTechnique[] = getTactileHoldTechniques("de");

  for (const [locale, list] of [
    ["en", enList],
    ["fi", fiList],
    ["sv", svList]
  ] as const) {
    assert.equal(list.length, 4, `Expected 4 techniques for ${locale}`);
    assert.deepEqual(
      list.map((item) => item.id),
      EXPECTED_IDS,
      `Unexpected technique IDs for ${locale}`
    );
    assert.deepEqual(
      list.map((item) => item.relatedCue),
      EXPECTED_CUES,
      `Unexpected relatedCue values for ${locale}`
    );

    for (const item of list) {
      assert.ok(item.title.trim().length > 0, `Empty title for ${locale}:${item.id}`);
      assert.ok(item.summary.trim().length > 20, `Short summary for ${locale}:${item.id}`);
      assert.ok(item.spokenTip.trim().length > 20, `Short spokenTip for ${locale}:${item.id}`);
      assert.ok(ALL_COACH_CUES.includes(item.relatedCue));
    }
  }

  for (let i = 0; i < 4; i += 1) {
    assert.notEqual(enList[i].title, fiList[i].title);
    assert.notEqual(enList[i].title, svList[i].title);
    assert.notEqual(fiList[i].title, svList[i].title);

    assert.notEqual(enList[i].summary, fiList[i].summary);
    assert.notEqual(enList[i].summary, svList[i].summary);
    assert.notEqual(fiList[i].summary, svList[i].summary);

    assert.notEqual(enList[i].spokenTip, fiList[i].spokenTip);
    assert.notEqual(enList[i].spokenTip, svList[i].spokenTip);
    assert.notEqual(fiList[i].spokenTip, svList[i].spokenTip);
  }

  assert.deepEqual(deList, enList);
  assert.deepEqual(getTactileHoldTechniques("de-DE"), enList);
  assert.deepEqual(getTactileHoldTechniques(""), enList);
  assert.deepEqual(getTactileHoldTechniques("fi-FI"), fiList);
  assert.deepEqual(getTactileHoldTechniques("sv-SE"), svList);
  assert.deepEqual(getTactileHoldTechniques("EN-US"), enList);

  const originalTitle = enList[0].title;
  enList[0].title = "mutated";
  assert.equal(getTactileHoldTechniques("en")[0].title, originalTitle);
});

test("TactileHandlingGuideCard SSR renders accessible section, 4 distinct aria-hidden hold SVGs, and >= 56px Hear Tip buttons", () => {
  const html = renderCard({
    lang: "en",
    onSpeakTip: noopSpeak
  });

  assert.match(
    html,
    /^<section\b[^>]*aria-labelledby="tactile-handling-guide-heading"[^>]*lang="en"/
  );
  assert.match(
    html,
    /<h2\b[^>]*id="tactile-handling-guide-heading"[^>]*>Tactile &amp; Proprioceptive Hold Guide<\/h2>/
  );
  assert.ok(html.includes('role="status"'));
  assert.ok(html.includes('aria-live="polite"'));
  assert.ok(html.includes('data-active-cue="none"'));
  assert.ok(html.includes('data-highlighted-technique="none"'));

  const svgs = new Set<string>();
  for (const id of EXPECTED_IDS) {
    const liTag = extractOpeningTagByAttr(html, "data-technique-id", id);
    assert.ok(liTag.startsWith("<li"));
    assert.ok(liTag.includes('data-highlighted="false"'));

    const svgTag = extractOpeningTagByAttr(html, "data-hold-icon", id);
    assert.ok(svgTag.startsWith("<svg"));
    assert.ok(svgTag.includes('aria-hidden="true"'));
    assert.ok(svgTag.includes('focusable="false"'));

    const svgIdx = html.indexOf(`data-hold-icon="${id}"`);
    const svgOpen = html.lastIndexOf("<svg", svgIdx);
    const svgClose = html.indexOf("</svg>", svgIdx);
    assert.ok(svgOpen >= 0 && svgClose > svgOpen, `Missing SVG body for ${id}`);
    svgs.add(html.slice(svgOpen, svgClose + 6));
  }
  assert.equal(svgs.size, 4, "All 4 tactile holds must render distinct inline SVG icons");

  const hearButtons = extractOpeningTagsByClass(html, "tactile-hear-tip-btn");
  assert.equal(hearButtons.length, 4);

  for (const btnTag of hearButtons) {
    assert.ok(btnTag.startsWith("<button"));
    assert.ok(btnTag.includes('type="button"'));
    assert.ok(btnTag.includes('aria-label="Hear Tip: '));
    const minHeightMatch = /min-height:\s*(\d+)px/i.exec(btnTag);
    const minWidthMatch = /min-width:\s*(\d+)px/i.exec(btnTag);
    assert.ok(minHeightMatch, `Expected inline min-height on button: ${btnTag}`);
    assert.ok(minWidthMatch, `Expected inline min-width on button: ${btnTag}`);
    assert.ok(Number.parseInt(minHeightMatch[1], 10) >= 56);
    assert.ok(Number.parseInt(minWidthMatch[1], 10) >= 56);
  }
  assert.equal((html.match(/>Hear Tip<\/span>/g) ?? []).length, 4);

  const readOnlyHtml = renderCard({ lang: "en" });
  assert.equal(extractOpeningTagsByClass(readOnlyHtml, "tactile-hear-tip-btn").length, 0);
  assert.equal(extractOpeningTagsByClass(readOnlyHtml, "tactile-hold-icon").length, 4);
});

test("TactileHandlingGuideCard highlights the exact technique matching activeCue and clears highlight on null or non-matching cues", () => {
  const techniques = getTactileHoldTechniques("en");

  for (const target of techniques) {
    const html = renderCard({
      lang: "en",
      activeCue: target.relatedCue,
      onSpeakTip: noopSpeak
    });

    assert.ok(html.includes(`data-active-cue="${target.relatedCue}"`));
    assert.ok(html.includes(`data-highlighted-technique="${target.id}"`));
    assert.ok(html.includes(`Active Hold: ${target.title.replace("&", "&amp;")}`));
    assert.equal((html.match(/tactile-technique-active-badge/g) ?? []).length, 1);

    for (const candidate of techniques) {
      const liTag = extractOpeningTagByAttr(html, "data-technique-id", candidate.id);
      if (candidate.id === target.id) {
        assert.ok(liTag.includes('data-highlighted="true"'));
        assert.ok(liTag.includes('aria-current="step"'));
        assert.ok(liTag.includes("is-highlighted"));
      } else {
        assert.ok(liTag.includes('data-highlighted="false"'));
        assert.equal(liTag.includes("aria-current="), false);
        assert.equal(liTag.includes("is-highlighted"), false);
      }
    }
  }

  for (const nonMatchingCue of [null, undefined, "ok", "closer"] as const) {
    const html = renderCard({
      lang: "en",
      activeCue: nonMatchingCue,
      onSpeakTip: noopSpeak
    });
    assert.ok(html.includes('data-highlighted-technique="none"'));
    assert.equal(html.includes('data-highlighted="true"'), false);
    assert.equal(html.includes('aria-current="step"'), false);
    assert.equal(html.includes("tactile-technique-active-badge"), false);
  }
});

test("TactileHandlingGuideCard localizes across en, fi, sv with de fallback", () => {
  const makeHtml = (lang: string): string =>
    renderCard({
      lang,
      activeCue: "more_light",
      onSpeakTip: noopSpeak
    });

  const enHtml = makeHtml("en");
  const fiHtml = makeHtml("fi");
  const svHtml = makeHtml("sv");
  const fiRegionalHtml = makeHtml("fi-FI");
  const svRegionalHtml = makeHtml("sv-SE");
  const deFallbackHtml = makeHtml("de");

  assert.notEqual(enHtml, fiHtml);
  assert.notEqual(enHtml, svHtml);
  assert.notEqual(fiHtml, svHtml);
  assert.equal(fiRegionalHtml, fiHtml);
  assert.equal(svRegionalHtml, svHtml);
  assert.equal(deFallbackHtml, enHtml);

  assert.ok(enHtml.includes('lang="en"'));
  assert.ok(enHtml.includes("ACTIVE CUE"));
  assert.ok(enHtml.includes(">Hear Tip</span>"));

  assert.ok(fiHtml.includes('lang="fi"'));
  assert.ok(fiHtml.includes("Tunto- ja asento-opas pakkausten pitelyyn"));
  assert.ok(fiHtml.includes("AKTIIVINEN OHJE"));
  assert.ok(fiHtml.includes(">Kuuntele ohje</span>"));

  assert.ok(svHtml.includes('lang="sv"'));
  assert.ok(svHtml.includes("Taktil och proprioceptiv greppguide"));
  assert.ok(svHtml.includes("AKTIV SIGNAL"));
  assert.ok(svHtml.includes(">Lyssna på tips</span>"));
});

test("TactileHandlingGuideCard Hear Tip buttons invoke onSpeakTip with localized spokenTip payloads", async () => {
  type ButtonPropsRecord = {
    onClick?: () => void;
    children?: unknown;
    "data-technique-id"?: string;
  };

  function collectButtons(node: unknown, acc: ButtonPropsRecord[] = []): ButtonPropsRecord[] {
    if (Array.isArray(node)) {
      for (const child of node) {
        collectButtons(child, acc);
      }
      return acc;
    }
    if (!isValidElement(node)) {
      return acc;
    }
    const props = node.props as ButtonPropsRecord;
    if (node.type === "button") {
      acc.push(props);
    }
    if (props && props.children !== undefined) {
      collectButtons(props.children, acc);
    }
    return acc;
  }

  for (const locale of ["en", "fi", "sv", "de"] as const) {
    const spokenFromTree: string[] = [];
    const tree = TactileHandlingGuideCard({
      lang: locale,
      activeCue: "rotate_left",
      onSpeakTip: (tip) => spokenFromTree.push(tip)
    });

    const buttons = collectButtons(tree);
    assert.equal(buttons.length, 4);
    for (const btn of buttons) {
      assert.equal(typeof btn.onClick, "function");
      btn.onClick?.();
    }

    const expectedTips = getTactileHoldTechniques(locale).map((item) => item.spokenTip);
    assert.deepEqual(spokenFromTree, expectedTips);

    const spokenFromDom: string[] = [];
    await withMountedCard(
      {
        lang: locale,
        activeCue: "hold_still",
        onSpeakTip: (tip) => spokenFromDom.push(tip)
      },
      async (container) => {
        const domButtons = container.findAllByAttr("data-action", "speak-tip");
        assert.equal(domButtons.length, 4);
        for (const btnNode of domButtons) {
          await act(async () => {
            btnNode.dispatchBubblingEvent("click");
          });
        }
        assert.deepEqual(spokenFromDom, expectedTips);
      }
    );
  }
});

test("TactileHandlingGuideCard and test suite contain zero code comments and zero em or en dashes", () => {
  const componentSource = readFileSync(
    new URL("../src/components/TactileHandlingGuideCard.tsx", import.meta.url),
    "utf8"
  );
  const testSource = readFileSync(
    new URL("./tactileHandlingGuideCard.test.ts", import.meta.url),
    "utf8"
  );

  for (const [label, source] of [
    ["TactileHandlingGuideCard.tsx", componentSource],
    ["tactileHandlingGuideCard.test.ts", testSource]
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

  const cueVariants: ReadonlyArray<CoachCue | null | undefined> = [
    undefined,
    null,
    ...ALL_COACH_CUES
  ];

  for (const lang of ["en", "fi", "sv", "de"]) {
    for (const activeCue of cueVariants) {
      for (const withSpeak of [false, true]) {
        const html = renderCard({
          lang,
          activeCue,
          onSpeakTip: withSpeak ? noopSpeak : undefined
        });
        assert.equal(html.includes(EM_DASH), false, `Em dash found for lang=${lang}`);
        assert.equal(html.includes(EN_DASH), false, `En dash found for lang=${lang}`);
        assert.equal(html.includes(HTML_COMMENT_OPEN), false, `HTML comment found for lang=${lang}`);
        assert.equal(html.includes("undefined"), false, `Leaked undefined for lang=${lang}`);
      }
    }
  }
});
