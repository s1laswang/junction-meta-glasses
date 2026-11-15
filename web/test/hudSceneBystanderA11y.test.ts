import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { CoachCue, DeviceState, Field, LabelRead, SceneItem, Verdict } from "../../shared/types.ts";
import type { Checker, CheckState } from "../src/lib/checker.ts";
import { policyForRtt } from "../src/lib/frames.ts";
import { setAccessKey } from "../src/lib/key.ts";
import { emptyRead } from "../src/lib/verdicts.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const STYLES_CSS = readFileSync(resolve(HERE, "../src/styles.css"), "utf8");
const CLEAN_CSS = STYLES_CSS.replace(new RegExp("\\/\\*[\\s\\S]*?\\*\\/", "g"), "");
const HUD_MODULE_PATH = resolve(HERE, "../src/screens/Hud.tsx");
const LIVE_MODULE_PATH = resolve(HERE, "../src/screens/Live.tsx");
const XHTML_NS = "http:\x2f\x2fwww.w3.org/1999/xhtml";

function setGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
  });
}

setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
setGlobal("React", React);

function escapeHtmlText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeHtmlAttr(text: string): string {
  return escapeHtmlText(text).replaceAll('"', "&quot;");
}

class MiniStyle {
  private custom = new Map<string, string>();
  [prop: string]: unknown;

  setProperty(name: string, value: string | null): void {
    if (value === null || value === "") this.custom.delete(name);
    else this.custom.set(name, String(value));
  }

  getPropertyValue(name: string): string {
    return this.custom.get(name) ?? "";
  }

  removeProperty(name: string): string {
    const prev = this.getPropertyValue(name);
    this.custom.delete(name);
    return prev;
  }

  toCssText(): string {
    const declarations: string[] = [];
    for (const [k, v] of this.custom) {
      declarations.push(`${k}: ${v}`);
    }
    for (const key of Object.keys(this)) {
      if (key === "custom") continue;
      const raw = this[key];
      if ((typeof raw === "string" && raw.length > 0) || typeof raw === "number") {
        const cssProp = key.startsWith("--") ? key : key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
        declarations.push(`${cssProp}: ${String(raw)}`);
      }
    }
    return declarations.join("; ");
  }
}

type MiniEvent = {
  type: string;
  key?: string;
  bubbles?: boolean;
  cancelable?: boolean;
  defaultPrevented: boolean;
  target?: unknown;
  currentTarget?: unknown;
  preventDefault: () => void;
  stopPropagation: () => void;
};

function makeEvent(type: string, extra: Partial<MiniEvent> = {}): MiniEvent {
  const ev: MiniEvent = {
    type,
    bubbles: true,
    cancelable: true,
    defaultPrevented: false,
    preventDefault() {
      if (ev.cancelable !== false) ev.defaultPrevented = true;
    },
    stopPropagation() {},
    ...extra,
  };
  return ev;
}

type ListenerRecord = { fn: (ev: MiniEvent) => void; capture: boolean };

class MiniNode {
  nodeType: number;
  nodeName: string;
  ownerDocument: MiniDocument | null;
  parentNode: MiniNode | null = null;
  childNodes: MiniNode[] = [];

  constructor(nodeType: number, nodeName: string, ownerDocument: MiniDocument | null) {
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.ownerDocument = ownerDocument;
  }

  get firstChild(): MiniNode | null {
    return this.childNodes[0] ?? null;
  }

  get nextSibling(): MiniNode | null {
    if (!this.parentNode) return null;
    const idx = this.parentNode.childNodes.indexOf(this);
    return idx >= 0 ? (this.parentNode.childNodes[idx + 1] ?? null) : null;
  }

  appendChild<T extends MiniNode>(child: T): T {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  insertBefore<T extends MiniNode>(child: T, ref: MiniNode | null): T {
    if (!ref) return this.appendChild(child);
    if (child.parentNode) child.parentNode.removeChild(child);
    const idx = this.childNodes.indexOf(ref);
    child.parentNode = this;
    if (idx < 0) this.childNodes.push(child);
    else this.childNodes.splice(idx, 0, child);
    return child;
  }

  removeChild<T extends MiniNode>(child: T): T {
    const idx = this.childNodes.indexOf(child);
    if (idx >= 0) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }
}

class MiniText extends MiniNode {
  nodeValue: string;

  constructor(text: string, ownerDocument: MiniDocument) {
    super(3, "#text", ownerDocument);
    this.nodeValue = String(text);
  }

  get textContent(): string {
    return this.nodeValue;
  }

  set textContent(value: string) {
    this.nodeValue = String(value);
  }
}

class MiniElement extends MiniNode {
  tagName: string;
  namespaceURI: string;
  style = new MiniStyle();
  attributes = new Map<string, string>();
  listeners = new Map<string, ListenerRecord[]>();
  scrollTop = 0;
  scrollHeight = 0;

  constructor(tag: string, namespaceURI: string, ownerDocument: MiniDocument) {
    const nodeName = namespaceURI === XHTML_NS ? tag.toUpperCase() : tag;
    super(1, nodeName, ownerDocument);
    this.tagName = nodeName;
    this.namespaceURI = namespaceURI;
  }

  get className(): string {
    return this.attributes.get("class") ?? "";
  }

  set className(value: string) {
    if (value) this.attributes.set("class", String(value));
    else this.attributes.delete("class");
  }

  get disabled(): boolean {
    return this.attributes.has("disabled");
  }

  set disabled(value: boolean) {
    if (value) this.attributes.set("disabled", "");
    else this.attributes.delete("disabled");
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }

  setAttributeNS(_ns: string | null, name: string, value: string): void {
    this.setAttribute(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  addEventListener(type: string, fn: (ev: MiniEvent) => void, options?: boolean | { capture?: boolean }): void {
    const capture = typeof options === "boolean" ? options : Boolean(options?.capture);
    const list = this.listeners.get(type) ?? [];
    list.push({ fn, capture });
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, fn: (ev: MiniEvent) => void, options?: boolean | { capture?: boolean }): void {
    const capture = typeof options === "boolean" ? options : Boolean(options?.capture);
    const list = this.listeners.get(type);
    if (!list) return;
    this.listeners.set(
      type,
      list.filter((item) => item.fn !== fn || item.capture !== capture),
    );
  }

  dispatchEvent(ev: MiniEvent): boolean {
    ev.target ??= this;
    const chain: MiniElement[] = [];
    let cur: MiniNode | null = this;
    while (cur instanceof MiniElement) {
      chain.push(cur);
      cur = cur.parentNode;
    }
    const doc = this.ownerDocument;
    if (doc) doc.runListeners(ev.type, ev, true);
    for (let i = chain.length - 1; i >= 0; i--) {
      const node = chain[i];
      ev.currentTarget = node;
      for (const rec of node.listeners.get(ev.type) ?? []) {
        if (rec.capture) rec.fn(ev);
      }
    }
    if (ev.bubbles !== false) {
      for (const node of chain) {
        ev.currentTarget = node;
        for (const rec of node.listeners.get(ev.type) ?? []) {
          if (!rec.capture) rec.fn(ev);
        }
      }
      if (doc) doc.runListeners(ev.type, ev, false);
    }
    return !ev.defaultPrevented;
  }

  focus(): void {
    if (this.disabled) return;
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }

  blur(): void {
    if (this.ownerDocument && this.ownerDocument.activeElement === this) {
      this.ownerDocument.activeElement = this.ownerDocument.body;
    }
  }

  click(): void {
    if (this.disabled) return;
    this.dispatchEvent(makeEvent("click"));
  }

  get textContent(): string {
    let out = "";
    for (const child of this.childNodes) {
      if (child instanceof MiniText || child instanceof MiniElement) out += child.textContent;
    }
    return out;
  }

  set textContent(value: string) {
    this.childNodes = [];
    if (value) this.appendChild(new MiniText(value, this.ownerDocument!));
  }

  get innerHTML(): string {
    return this.childNodes.map((child) => serializeNode(child)).join("");
  }

  findAll(predicate: (el: MiniElement) => boolean): MiniElement[] {
    const out: MiniElement[] = [];
    for (const child of this.childNodes) {
      if (child instanceof MiniElement) {
        if (predicate(child)) out.push(child);
        out.push(...child.findAll(predicate));
      }
    }
    return out;
  }
}

function serializeNode(node: MiniNode): string {
  if (node instanceof MiniText) return escapeHtmlText(node.nodeValue);
  if (node instanceof MiniElement) {
    const tag = node.tagName.toLowerCase();
    const attrs: string[] = [];
    for (const [k, v] of node.attributes) {
      attrs.push(`${k}="${escapeHtmlAttr(v)}"`);
    }
    const css = node.style.toCssText();
    if (css) attrs.push(`style="${escapeHtmlAttr(css)}"`);
    const attrStr = attrs.length ? " " + attrs.join(" ") : "";
    return `<${tag}${attrStr}>${node.innerHTML}</${tag}>`;
  }
  return "";
}

class MiniDocument extends MiniNode {
  documentElement: MiniElement;
  body: MiniElement;
  activeElement: MiniElement;
  defaultView: unknown = null;
  visibilityState = "visible";
  private docListeners = new Map<string, ListenerRecord[]>();

  constructor() {
    super(9, "#document", null);
    this.ownerDocument = this;
    this.documentElement = new MiniElement("html", XHTML_NS, this);
    this.body = new MiniElement("body", XHTML_NS, this);
    this.documentElement.appendChild(this.body);
    this.appendChild(this.documentElement);
    this.activeElement = this.body;
  }

  createElement(tag: string): MiniElement {
    return new MiniElement(tag, XHTML_NS, this);
  }

  createElementNS(ns: string, tag: string): MiniElement {
    return new MiniElement(tag, ns, this);
  }

  createTextNode(text: string): MiniText {
    return new MiniText(text, this);
  }

  addEventListener(type: string, fn: (ev: MiniEvent) => void, options?: boolean | { capture?: boolean }): void {
    const capture = typeof options === "boolean" ? options : Boolean(options?.capture);
    const list = this.docListeners.get(type) ?? [];
    list.push({ fn, capture });
    this.docListeners.set(type, list);
  }

  removeEventListener(type: string, fn: (ev: MiniEvent) => void, options?: boolean | { capture?: boolean }): void {
    const capture = typeof options === "boolean" ? options : Boolean(options?.capture);
    const list = this.docListeners.get(type);
    if (!list) return;
    this.docListeners.set(
      type,
      list.filter((item) => item.fn !== fn || item.capture !== capture),
    );
  }

  runListeners(type: string, ev: MiniEvent, capture: boolean): void {
    ev.currentTarget = this;
    for (const rec of this.docListeners.get(type) ?? []) {
      if (rec.capture === capture) rec.fn(ev);
    }
  }
}

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  url: string;
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  serverOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  serverJson(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

class FakeBroadcastChannel {
  name: string;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(name: string) {
    this.name = name;
  }
  postMessage(): void {}
  close(): void {}
}

class FakeSpeechSynthesisUtterance {
  text: string;
  lang = "";
  constructor(text: string) {
    this.text = text;
  }
}

let moduleSeq = 0;

function installEnv(initialStorage: Record<string, string> = {}, cancelThrows = false) {
  FakeWebSocket.instances = [];
  const doc = new MiniDocument();
  const storage = new Map<string, string>(Object.entries(initialStorage));
  let speechCancels = 0;
  let backs = 0;
  const spoken: Array<{ text: string; lang: string }> = [];
  const winListeners = new Map<string, Set<(ev: MiniEvent) => void>>();

  const loc = {
    search: "",
    protocol: "https:",
    host: "holdup.test",
    pathname: "/hud/",
    hash: "",
  };

  const hist = {
    state: null as unknown,
    pushState(data: unknown) {
      hist.state = data;
    },
    replaceState(data: unknown) {
      hist.state = data;
    },
    back() {
      backs++;
    },
  };

  const speechSynthesis = {
    cancel() {
      speechCancels++;
      if (cancelThrows) throw new Error("speechSynthesis unavailable");
    },
    speak(utterance: FakeSpeechSynthesisUtterance) {
      spoken.push({ text: utterance.text, lang: utterance.lang });
    },
  };

  const nav = {
    language: "en-US",
    onLine: true,
    userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome/130.0.0.0",
  };

  const win = {
    document: doc,
    navigator: nav,
    location: loc,
    history: hist,
    speechSynthesis,
    HTMLIFrameElement: class {},
    addEventListener(type: string, fn: (ev: MiniEvent) => void) {
      const set = winListeners.get(type) ?? new Set<(ev: MiniEvent) => void>();
      set.add(fn);
      winListeners.set(type, set);
    },
    removeEventListener(type: string, fn: (ev: MiniEvent) => void) {
      winListeners.get(type)?.delete(fn);
    },
    dispatchEvent(ev: MiniEvent) {
      for (const fn of winListeners.get(ev.type) ?? []) fn(ev);
      return !ev.defaultPrevented;
    },
  };
  doc.defaultView = win;

  const localStorageShim = {
    get length() {
      return storage.size;
    },
    key(index: number) {
      return Array.from(storage.keys())[index] ?? null;
    },
    getItem(key: string) {
      return storage.has(key) ? storage.get(key)! : null;
    },
    setItem(key: string, value: string) {
      storage.set(key, String(value));
    },
    removeItem(key: string) {
      storage.delete(key);
    },
    clear() {
      storage.clear();
    },
  };

  setGlobal("window", win);
  setGlobal("document", doc);
  setGlobal("navigator", nav);
  setGlobal("location", loc);
  setGlobal("history", hist);
  setGlobal("localStorage", localStorageShim);
  setGlobal("WebSocket", FakeWebSocket);
  setGlobal("BroadcastChannel", FakeBroadcastChannel);
  setGlobal("SpeechSynthesisUtterance", FakeSpeechSynthesisUtterance);
  setGlobal("fetch", async () => ({ status: 200, ok: true }));
  setAccessKey("");

  return {
    doc,
    storage,
    spoken,
    cancelCount: () => speechCancels,
    backCount: () => backs,
    dispatchKey(key: string) {
      const ev = makeEvent("keydown", { key });
      win.dispatchEvent(ev);
      return ev;
    },
    dispatchPopState() {
      const ev = makeEvent("popstate");
      win.dispatchEvent(ev);
      return ev;
    },
  };
}

async function importHudFresh(): Promise<typeof import("../src/screens/Hud.tsx")> {
  const url = `${pathToFileURL(HUD_MODULE_PATH).href}?a4=${++moduleSeq}`;
  return (await import(url)) as typeof import("../src/screens/Hud.tsx");
}

async function importLiveFresh(): Promise<typeof import("../src/screens/Live.tsx")> {
  const url = `${pathToFileURL(LIVE_MODULE_PATH).href}?a4=${++moduleSeq}`;
  return (await import(url)) as typeof import("../src/screens/Live.tsx");
}

async function mountHud(doc: MiniDocument, HudComp: () => React.JSX.Element) {
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () => {
    root.render(createElement(HudComp));
  });
  return {
    html: () => container.innerHTML,
    buttonByText: (prefix: string) => {
      const found = container.findAll((el) => el.tagName === "BUTTON" && el.textContent.trim().startsWith(prefix))[0];
      assert.ok(found, `Expected button starting with "${prefix}"`);
      return found;
    },
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
    },
  };
}

function extractCssBlock(css: string, selector: RegExp): string {
  const match = selector.exec(css);
  assert.ok(match, `Missing CSS block matching ${String(selector)}`);
  const openIdx = css.indexOf("{", match.index);
  assert.ok(openIdx >= 0, `Missing opening brace for ${String(selector)}`);
  let depth = 0;
  for (let i = openIdx; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(openIdx + 1, i);
    }
  }
  assert.fail(`Unclosed CSS block for ${String(selector)}`);
}

function parseHexRgb(hex: string): [number, number, number] {
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
  const [r, g, b] = parseHexRgb(hex).map((channel) => {
    const s = channel / 255;
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

const f = <T,>(value: T | null, confidence = 0.95): Field<T> => ({ value, confidence });

function makeRead(overrides: Partial<LabelRead> = {}): LabelRead {
  return {
    ...emptyRead("medication"),
    product: f("Amlodipine", 0.97),
    ingredient: f("amlodipine", 0.94),
    strength: f("5 mg", 0.96),
    readability: 0.92,
    ...overrides,
  };
}

function makeVerdict(overrides: Partial<Verdict> = {}): Verdict {
  return {
    level: "match",
    headline: "Amlodipine 5 mg",
    speech: "Yes, Amlodipine 5 mg, your evening pill.",
    read: makeRead(),
    matchedMedId: "amlodipine",
    reasons: ["Matches your list"],
    takenToday: false,
    ...overrides,
  };
}

function makeStubChecker(overrides: Partial<CheckState> = {}): Checker {
  const state: CheckState = {
    running: true,
    mode: "live",
    conn: "open",
    connAttempt: 0,
    nextRetryMs: null,
    serverLive: "open",
    serverDetail: "",
    model: "gemini-live",
    session: "ABCD",
    online: true,
    health: "ok",
    rtt: 42,
    policy: policyForRtt(42),
    fps: 1,
    framesSent: 4,
    camera: "on",
    cameraPerm: "granted",
    cameraMsg: "",
    mic: "on",
    micPerm: "granted",
    micMsg: "",
    micLabel: "Mic",
    micLevel: 0,
    route: "",
    source: "phone",
    device: null,
    captions: [],
    cue: null,
    verdict: null,
    verdictVia: "live",
    autoStopAt: null,
    snapshotBusy: false,
    checking: false,
    hudConnected: false,
    authNeeded: false,
    speaking: false,
    sharpness: 0.72,
    serverFeatures: ["scene", "datamatrix", "addmed", "sonar"],
    lastCode: null,
    readiness: null,
    addProposal: null,
    banner: null,
    lastError: null,
    hidden: false,
    ...overrides,
  };
  return {
    subscribe: () => () => {},
    get: () => state,
    attachVideo: () => {},
    primary: () => {},
    stop: async () => {},
    start: async () => {},
    setSource: async () => {},
    sendText: () => {},
    repeat: () => {},
    logDose: () => {},
    dismissVerdict: () => {},
    snapshot: async () => {},
    offlineCheckImage: async () => {},
    backToLive: () => {},
    answerProposal: () => {},
    simulateDrop: () => {},
    toggleSnapshotMode: () => {},
    feature: () => true,
    injectCode: () => {},
  } as unknown as Checker;
}

test("HUD .scene-card, .scene-card.stale, and Live .scene-box.info rules enforce border, stale dimming, and >= 7:1 WCAG AAA contrast", () => {
  const verdictCardBlock = extractCssBlock(CLEAN_CSS, /(?:^|\s)\.verdict-card\s*\{/);
  const verdictStaleBlock = extractCssBlock(CLEAN_CSS, /(?:^|\s)\.verdict-card\.stale\s*\{/);
  const sceneCardBlock = extractCssBlock(CLEAN_CSS, /(?:^|\s)\.scene-card\s*\{/);
  const sceneStaleBlock = extractCssBlock(CLEAN_CSS, /(?:^|\s)\.scene-card\.stale\s*\{/);

  assert.match(verdictCardBlock, /border-color:\s*var\(--lvl\)/);
  assert.match(verdictStaleBlock, /opacity:\s*0\.55/);
  assert.match(verdictStaleBlock, /border-style:\s*dashed/);
  assert.match(sceneCardBlock, /border-color:\s*var\(--lvl\)/);
  assert.match(sceneStaleBlock, /opacity:\s*0\.55/);
  assert.match(sceneStaleBlock, /border-style:\s*dashed/);

  const sceneBoxInfoBlock = extractCssBlock(CLEAN_CSS, /(?:^|\s)\.scene-box\.info\s*\{/);
  assert.match(sceneBoxInfoBlock, /--ic:\s*var\(--muted\)/);

  const sceneBoxSpanBlock = extractCssBlock(CLEAN_CSS, /(?:^|\s)\.scene-box\s+span\s*\{/);
  assert.match(sceneBoxSpanBlock, /background:\s*var\(--ic,\s*var\(--unsure\)\)/);
  const badgeTextMatch = sceneBoxSpanBlock.match(/color:\s*(#[0-9a-fA-F]{3,6})\b/);
  assert.ok(badgeTextMatch, "Expected hex text color on .scene-box span");
  const badgeTextHex = badgeTextMatch[1];
  assert.equal(badgeTextHex.toLowerCase(), "#0b1018");

  const rootBlock = extractCssBlock(CLEAN_CSS, /:root\s*\{/);
  const defaultMutedMatch = rootBlock.match(/--muted:\s*(#[0-9a-fA-F]{3,6})\b/);
  assert.ok(defaultMutedMatch, "Expected --muted hex color in :root");
  const defaultInfoContrast = contrastRatio(badgeTextHex, defaultMutedMatch[1]);
  assert.ok(
    defaultInfoContrast >= 7,
    `Expected .scene-box.info text ${badgeTextHex} on ${defaultMutedMatch[1]} >= 7:1, got ${defaultInfoContrast.toFixed(2)}`,
  );

  const moreContrastMedia = extractCssBlock(CLEAN_CSS, /@media\s*\(prefers-contrast:\s*more\)\s*\{/);
  const moreRootBlock = extractCssBlock(moreContrastMedia, /:root\s*\{/);
  const moreMutedMatch = moreRootBlock.match(/--muted:\s*(#[0-9a-fA-F]{3,6})\b/);
  assert.ok(moreMutedMatch, "Expected --muted hex color in prefers-contrast: more");
  const moreInfoContrast = contrastRatio(badgeTextHex, moreMutedMatch[1]);
  assert.ok(
    moreInfoContrast >= 7,
    `Expected high-contrast .scene-box.info text ${badgeTextHex} on ${moreMutedMatch[1]} >= 7:1, got ${moreInfoContrast.toFixed(2)}`,
  );
});

test("Live camera viewfinder scene-box overlay renders non-color 'i' glyph for info items alongside match, warning, and unsure", async () => {
  const env = installEnv();
  const { Live } = await importLiveFresh();

  const items: SceneItem[] = [
    { position: "far_left", level: "unsure", headline: "Blurry box", box: [100, 40, 500, 240], read: emptyRead("medication") },
    { position: "left", level: "warning", headline: "Ibuprofen 400 mg", box: [120, 270, 560, 480], read: makeRead({ product: f("Ibuprofen", 0.96) }) },
    { position: "center", level: "match", headline: "Amlodipine 5 mg", matchedMedId: "amlodipine", box: [110, 510, 580, 730], read: makeRead() },
    { position: "right", level: "info", headline: "Oat crackers", box: [140, 760, 540, 960], read: emptyRead("food") },
  ];
  const sceneVerdict: Verdict = makeVerdict({
    mode: "scene",
    headline: "Middle is your evening pill",
    items,
  });

  const checker = makeStubChecker({ verdict: sceneVerdict });
  const container = env.doc.createElement("div");
  env.doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);

  await act(async () => {
    root.render(
      createElement(Live, {
        checker,
        consented: true,
        onReviewConsent: () => {},
        onFixPermissions: () => {},
      }),
    );
  });

  const html = container.innerHTML;
  assert.match(html, /<div class="scene-box unsure"[^>]*><span>\? Far left<\/span><\/div>/);
  assert.match(html, /<div class="scene-box warning"[^>]*><span>\u26a0 Left<\/span><\/div>/);
  assert.match(html, /<div class="scene-box match"[^>]*><span>\u2713 Middle<\/span><\/div>/);
  assert.match(html, /<div class="scene-box info"[^>]*><span>i Right<\/span><\/div>/);
  assert.doesNotMatch(html, /\? Right/);

  await act(async () => {
    root.unmount();
  });
});

test("HUD bystander open-ear audio privacy cancels speech on Speak-off, Dismiss, active Escape, popstate, doffed glasses (worn===false only), and unmount", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const env = installEnv();
  const { Hud } = await importHudFresh();
  const view = await mountHud(env.doc, Hud);
  const ws = FakeWebSocket.instances[0];

  await act(async () => {
    ws.serverOpen();
  });

  const speakBtn = view.buttonByText("Speak");
  assert.equal(speakBtn.getAttribute("aria-pressed"), "false");
  assert.equal(speakBtn.textContent, "Speak off");

  await act(async () => {
    ws.serverJson({ type: "verdict", verdict: makeVerdict({ headline: "Silent by default" }) });
  });
  assert.equal(env.spoken.length, 0);
  assert.equal(env.cancelCount(), 0);

  await act(async () => {
    speakBtn.click();
  });
  assert.equal(speakBtn.getAttribute("aria-pressed"), "true");

  await act(async () => {
    ws.serverJson({ type: "verdict", verdict: makeVerdict({ headline: "Amlodipine 5 mg" }) });
  });
  assert.equal(env.spoken.length, 1);
  const cancelsAfterFirstSay = env.cancelCount();
  assert.equal(cancelsAfterFirstSay, 1);

  await act(async () => {
    speakBtn.click();
  });
  assert.equal(speakBtn.getAttribute("aria-pressed"), "false");
  assert.equal(env.storage.get("holdup.hud.speak"), "0");
  assert.equal(env.cancelCount(), cancelsAfterFirstSay + 1, "Toggling Speak off must immediately cancel open-ear speech");

  await act(async () => {
    speakBtn.click();
  });
  assert.equal(env.cancelCount(), cancelsAfterFirstSay + 1, "Toggling Speak on must not spuriously cancel speech");

  await act(async () => {
    ws.serverJson({ type: "verdict", verdict: makeVerdict({ headline: "Metformin 500 mg" }) });
  });
  const cancelsBeforeDismiss = env.cancelCount();
  await act(async () => {
    view.buttonByText("Dismiss").click();
  });
  assert.equal(env.cancelCount(), cancelsBeforeDismiss + 1, "Dismiss button must immediately cancel speech");
  assert.match(view.html(), /Hold it up\./);

  const cancelsIdleEsc = env.cancelCount();
  await act(async () => {
    env.dispatchKey("Escape");
  });
  assert.equal(env.cancelCount(), cancelsIdleEsc, "Escape on idle card must not call speechSynthesis.cancel()");

  await act(async () => {
    ws.serverJson({ type: "verdict", verdict: makeVerdict({ headline: "Atorvastatin 20 mg" }) });
  });
  const cancelsBeforeVerdictEsc = env.cancelCount();
  await act(async () => {
    env.dispatchKey("Escape");
  });
  assert.equal(env.cancelCount(), cancelsBeforeVerdictEsc + 1, "Escape while verdict is active must cancel speech");
  assert.match(view.html(), /Hold it up\./);

  await act(async () => {
    ws.serverJson({ type: "coach", cue: "closer" satisfies CoachCue, text: "A bit closer" });
  });
  const cancelsBeforeCueEsc = env.cancelCount();
  await act(async () => {
    env.dispatchKey("Escape");
  });
  assert.equal(env.cancelCount(), cancelsBeforeCueEsc + 1, "Escape while coach cue is active must cancel speech");

  await act(async () => {
    ws.serverJson({ type: "verdict", verdict: makeVerdict({ headline: "Popstate verdict" }) });
  });
  const cancelsBeforePop = env.cancelCount();
  await act(async () => {
    env.dispatchPopState();
  });
  assert.equal(env.cancelCount(), cancelsBeforePop + 1, "System Back popstate must cancel speech");

  await act(async () => {
    ws.serverJson({ type: "verdict", verdict: makeVerdict({ headline: "Glasses worn check" }) });
  });
  const cancelsBeforeDevice = env.cancelCount();

  await act(async () => {
    ws.serverJson({
      type: "device",
      device: { connected: true, worn: true, battery: 82, streaming: true, source: "glasses" } satisfies DeviceState,
    });
  });
  assert.equal(env.cancelCount(), cancelsBeforeDevice, "worn: true must not cancel speech");

  await act(async () => {
    ws.serverJson({
      type: "device",
      device: { connected: true, worn: null, battery: null, streaming: true, source: "glasses" } satisfies DeviceState,
    });
  });
  assert.equal(env.cancelCount(), cancelsBeforeDevice, "worn: null (unknown sensor state) must NOT cancel speech");

  await act(async () => {
    ws.serverJson({
      type: "device",
      device: { connected: true, worn: false, battery: 79, streaming: false, source: "glasses" } satisfies DeviceState,
    });
  });
  assert.equal(env.cancelCount(), cancelsBeforeDevice + 1, "worn: false (doffed glasses) must immediately cancel open-ear speech");

  const cancelsBeforeUnmount = env.cancelCount();
  await act(async () => {
    t.mock.timers.tick(1800);
  });
  await view.unmount();
  assert.equal(env.cancelCount(), cancelsBeforeUnmount + 1, "Unmounting Hud must cancel active speech");
});

test("HUD TTS say sets u.lang to en-US by default or for en, fi-FI for fi, sv-SE for sv, and falls back safely on invalid profile JSON", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const env = installEnv({ "holdup.hud.speak": "1" });
  const { Hud } = await importHudFresh();
  const view = await mountHud(env.doc, Hud);
  const ws = FakeWebSocket.instances[0];

  await act(async () => {
    ws.serverOpen();
    ws.serverJson({ type: "verdict", verdict: makeVerdict({ level: "match", headline: "Amlodipine 5 mg" }) });
  });
  assert.deepEqual(env.spoken[0], { text: "right one. Amlodipine 5 mg", lang: "en-US" });

  env.storage.set("holdup.profile", JSON.stringify({ lang: "en", meds: [], allergies: [], avoid: [], doseLog: [] }));
  await act(async () => {
    ws.serverJson({ type: "verdict", verdict: makeVerdict({ level: "warning", headline: "Ibuprofen 400 mg" }) });
  });
  assert.deepEqual(env.spoken[1], { text: "check. Ibuprofen 400 mg", lang: "en-US" });

  env.storage.set("holdup.profile", JSON.stringify({ lang: "fi", meds: [], allergies: [], avoid: [], doseLog: [] }));
  await act(async () => {
    ws.serverJson({ type: "verdict", verdict: makeVerdict({ level: "match", headline: "Amlodipiini 5 mg" }) });
  });
  assert.deepEqual(env.spoken[2], { text: "right one. Amlodipiini 5 mg", lang: "fi-FI" });

  await act(async () => {
    view.buttonByText("Repeat").click();
  });
  assert.deepEqual(env.spoken[3], { text: "Amlodipiini 5 mg", lang: "fi-FI" });

  env.storage.set("holdup.profile", JSON.stringify({ lang: "sv", meds: [], allergies: [], avoid: [], doseLog: [] }));
  await act(async () => {
    ws.serverJson({ type: "verdict", verdict: makeVerdict({ level: "unsure", headline: "Metformin" }) });
  });
  assert.deepEqual(env.spoken[4], { text: "not sure. Metformin", lang: "sv-SE" });

  env.storage.set("holdup.profile", "{not-valid-json");
  await act(async () => {
    ws.serverJson({ type: "verdict", verdict: makeVerdict({ level: "info", headline: "Oat milk" }) });
  });
  assert.deepEqual(env.spoken[5], { text: "info. Oat milk", lang: "en-US" });

  await act(async () => {
    t.mock.timers.tick(1800);
  });
  await view.unmount();

  const throwingEnv = installEnv({ "holdup.hud.speak": "1" }, true);
  const { Hud: HudThrowing } = await importHudFresh();
  const throwingView = await mountHud(throwingEnv.doc, HudThrowing);
  const wsThrow = FakeWebSocket.instances[0];
  await act(async () => {
    wsThrow.serverOpen();
    wsThrow.serverJson({ type: "device", device: { connected: true, worn: false, battery: 50, streaming: false, source: "glasses" } });
    throwingView.buttonByText("Speak").click();
  });
  await throwingView.unmount();
});
