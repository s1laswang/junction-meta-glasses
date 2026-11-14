import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { CoachCue, DeviceState, Field, LabelRead, LiveState, SceneItem, ScenePosition, Verdict, VerdictLevel } from "../../shared/types.ts";
import { accessKey, setAccessKey } from "../src/lib/key.ts";
import { MOCK_HUD_CHANNEL } from "../src/lib/mock.ts";
import { demoProfile } from "../src/lib/storage.ts";
import { emptyRead, matchVerdict, mockFoodNuts, mockScene, mockUnsureStrength, mockWarningIbuprofen } from "../src/lib/verdicts.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const STYLES_CSS = readFileSync(resolve(HERE, "../src/styles.css"), "utf8");
const HUD_INDEX_HTML = readFileSync(resolve(HERE, "../hud/index.html"), "utf8");
const HUD_SPEC_MD = readFileSync(resolve(HERE, "../../docs/HUD_SPEC.md"), "utf8");
const MANIFEST_PATH = resolve(HERE, "../public/hud/.well-known/meta-wearables-manifest.json");
const ICON_96_PATH = resolve(HERE, "../public/hud/icon-96.png");
const ICON_MONO_PATH = resolve(HERE, "../public/hud/icon-mono.png");
const HUD_MODULE_PATH = resolve(HERE, "../src/screens/Hud.tsx");

const XHTML_NS = "http:\x2f\x2fwww.w3.org/1999/xhtml";
const SLASH2 = "\x2f\x2f";

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

function decodeHtml(html: string): string {
  return html
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
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

type ListenerRecord = { fn: (ev: MiniEvent) => void; capture: boolean };

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

  get id(): string {
    return this.attributes.get("id") ?? "";
  }

  set id(value: string) {
    if (value) this.attributes.set("id", String(value));
    else this.attributes.delete("id");
  }

  get type(): string {
    return this.attributes.get("type") ?? "";
  }

  set type(value: string) {
    if (value) this.attributes.set("type", String(value));
    else this.attributes.delete("type");
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

  addEventListener(type: string, fn: (ev: MiniEvent) => void, opts?: boolean | { capture?: boolean }): void {
    const capture = typeof opts === "boolean" ? opts : Boolean(opts?.capture);
    const list = this.listeners.get(type) ?? [];
    list.push({ fn, capture });
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, fn: (ev: MiniEvent) => void, opts?: boolean | { capture?: boolean }): void {
    const capture = typeof opts === "boolean" ? opts : Boolean(opts?.capture);
    const list = this.listeners.get(type);
    if (!list) return;
    this.listeners.set(
      type,
      list.filter((entry) => !(entry.fn === fn && entry.capture === capture)),
    );
  }

  dispatchEvent(ev: MiniEvent): boolean {
    const path: MiniNode[] = [];
    let current: MiniNode | null = this;
    while (current) {
      path.push(current);
      current = current.parentNode;
    }
    ev.target = this;
    for (let i = path.length - 1; i >= 0; i--) {
      const node = path[i] as MiniElement | MiniDocument;
      ev.currentTarget = node;
      for (const rec of node.listeners?.get(ev.type) ?? []) {
        if (rec.capture) rec.fn(ev);
      }
    }
    if (ev.bubbles !== false) {
      for (let i = 0; i < path.length; i++) {
        const node = path[i] as MiniElement | MiniDocument;
        ev.currentTarget = node;
        for (const rec of node.listeners?.get(ev.type) ?? []) {
          if (!rec.capture) rec.fn(ev);
        }
      }
    }
    return !ev.defaultPrevented;
  }

  click(): void {
    if (this.disabled) return;
    this.dispatchEvent(makeEvent("click"));
  }

  focus(): void {
    if (this.disabled) return;
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }

  get textContent(): string {
    return this.childNodes
      .map((child) => {
        if (child.nodeType === 3) return (child as MiniText).nodeValue;
        if (child.nodeType === 1) return (child as MiniElement).textContent;
        return "";
      })
      .join("");
  }

  set textContent(value: string) {
    this.childNodes = [];
    if (value !== "" && this.ownerDocument) {
      this.appendChild(new MiniText(value, this.ownerDocument));
    }
  }

  get innerHTML(): string {
    return this.childNodes.map((child) => serializeNode(child)).join("");
  }

  findAll(predicate: (el: MiniElement) => boolean): MiniElement[] {
    const matches: MiniElement[] = [];
    const visit = (node: MiniNode): void => {
      if (node.nodeType === 1) {
        const el = node as MiniElement;
        if (predicate(el)) matches.push(el);
        for (const child of el.childNodes) visit(child);
      }
    };
    for (const child of this.childNodes) visit(child);
    return matches;
  }
}

function serializeNode(node: MiniNode): string {
  if (node.nodeType === 3) return escapeHtmlText((node as MiniText).nodeValue);
  if (node.nodeType !== 1) return "";
  const el = node as MiniElement;
  const tag = el.namespaceURI === XHTML_NS ? el.tagName.toLowerCase() : el.tagName;
  const attrs: string[] = [];
  for (const [k, v] of el.attributes) {
    attrs.push(v === "" ? `${k}=""` : `${k}="${escapeHtmlAttr(v)}"`);
  }
  const css = el.style.toCssText();
  if (css) attrs.push(`style="${escapeHtmlAttr(css)}"`);
  const open = attrs.length > 0 ? `<${tag} ${attrs.join(" ")}>` : `<${tag}>`;
  return `${open}${el.innerHTML}</${tag}>`;
}

class MiniDocument extends MiniNode {
  activeElement: MiniElement | null = null;
  documentElement: MiniElement;
  body: MiniElement;
  defaultView: unknown = null;
  listeners = new Map<string, ListenerRecord[]>();

  constructor() {
    super(9, "#document", null);
    this.ownerDocument = this;
    this.documentElement = new MiniElement("html", XHTML_NS, this);
    this.body = new MiniElement("body", XHTML_NS, this);
    this.documentElement.appendChild(this.body);
    this.appendChild(this.documentElement);
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

  addEventListener(type: string, fn: (ev: MiniEvent) => void, opts?: boolean | { capture?: boolean }): void {
    const capture = typeof opts === "boolean" ? opts : Boolean(opts?.capture);
    const list = this.listeners.get(type) ?? [];
    list.push({ fn, capture });
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, fn: (ev: MiniEvent) => void, opts?: boolean | { capture?: boolean }): void {
    const capture = typeof opts === "boolean" ? opts : Boolean(opts?.capture);
    const list = this.listeners.get(type);
    if (!list) return;
    this.listeners.set(
      type,
      list.filter((entry) => !(entry.fn === fn && entry.capture === capture)),
    );
  }
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  url: string;
  readyState = 0;
  sent: string[] = [];
  closedCount = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.readyState = 3;
    this.closedCount++;
  }

  serverOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  serverJson(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  serverDrop(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

class FakeBroadcastChannel {
  static peers = new Map<string, Set<FakeBroadcastChannel>>();

  name: string;
  closed = false;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  constructor(name: string) {
    this.name = name;
    const group = FakeBroadcastChannel.peers.get(name) ?? new Set<FakeBroadcastChannel>();
    group.add(this);
    FakeBroadcastChannel.peers.set(name, group);
  }

  postMessage(data: unknown): void {
    if (this.closed) return;
    const group = FakeBroadcastChannel.peers.get(this.name);
    if (!group) return;
    for (const peer of group) {
      if (peer !== this && !peer.closed) {
        peer.onmessage?.({ data });
      }
    }
  }

  close(): void {
    this.closed = true;
    FakeBroadcastChannel.peers.get(this.name)?.delete(this);
  }

  static reset(): void {
    FakeBroadcastChannel.peers.clear();
  }
}

class FakeSpeechSynthesisUtterance {
  text: string;
  lang = "";

  constructor(text: string) {
    this.text = text;
  }
}

type BatteryControl = {
  level: number;
  setLevel: (next: number) => void;
};

type FetchCall = {
  url: string;
  init?: RequestInit;
};

type HudEnv = {
  doc: MiniDocument;
  storage: Map<string, string>;
  pushStates: Array<{ data: unknown; unused: string; url?: string | URL | null }>;
  replaceStates: Array<{ data: unknown; unused: string; url?: string | URL | null }>;
  backCount: () => number;
  spoken: Array<{ text: string; lang: string }>;
  cancelCount: () => number;
  fetchCalls: FetchCall[];
  setStatsStatus: (status: number) => void;
  dispatchWindowKey: (key: string) => MiniEvent;
  dispatchPopState: () => MiniEvent;
  battery: BatteryControl | null;
};

type EnvConfig = {
  search?: string;
  protocol?: "https:" | "http:";
  host?: string;
  pathname?: string;
  initialStorage?: Record<string, string>;
  statsStatus?: number;
  batteryLevel?: number | null;
};

let moduleCounter = 0;

function installHudEnv(cfg: EnvConfig = {}): HudEnv {
  FakeWebSocket.instances = [];
  FakeBroadcastChannel.reset();

  const doc = new MiniDocument();
  const storage = new Map<string, string>(Object.entries(cfg.initialStorage ?? {}));
  const pushStates: Array<{ data: unknown; unused: string; url?: string | URL | null }> = [];
  const replaceStates: Array<{ data: unknown; unused: string; url?: string | URL | null }> = [];
  let backs = 0;
  let speechCancels = 0;
  const spoken: Array<{ text: string; lang: string }> = [];
  const fetchCalls: FetchCall[] = [];
  let statsStatus = cfg.statsStatus ?? 200;

  const loc = {
    search: cfg.search ?? "",
    protocol: cfg.protocol ?? "https:",
    host: cfg.host ?? "holdup.test",
    pathname: cfg.pathname ?? "/hud/",
    hash: "",
  };

  const hist = {
    state: null as unknown,
    pushState(data: unknown, unused: string, url?: string | URL | null) {
      hist.state = data;
      pushStates.push({ data, unused, url });
    },
    replaceState(data: unknown, unused: string, url?: string | URL | null) {
      hist.state = data;
      replaceStates.push({ data, unused, url });
    },
    back() {
      backs++;
    },
  };

  const winListeners = new Map<string, Set<(ev: MiniEvent) => void>>();
  const speechSynthesis = {
    cancel() {
      speechCancels++;
    },
    speak(utterance: FakeSpeechSynthesisUtterance) {
      spoken.push({ text: utterance.text, lang: utterance.lang });
    },
  };

  let batteryCtrl: BatteryControl | null = null;
  const batteryListeners = new Set<() => void>();
  if (cfg.batteryLevel !== undefined && cfg.batteryLevel !== null) {
    const bObj = {
      level: cfg.batteryLevel,
      addEventListener(event: string, fn: () => void) {
        if (event === "levelchange") batteryListeners.add(fn);
      },
    };
    batteryCtrl = {
      get level() {
        return bObj.level;
      },
      setLevel(next: number) {
        bObj.level = next;
        for (const fn of batteryListeners) fn();
      },
    };
  }

  const nav: Record<string, unknown> = {
    language: "en-US",
    userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome/130.0.0.0",
  };
  if (batteryCtrl) {
    const levelRef = batteryCtrl;
    nav.getBattery = async () => ({
      get level() {
        return levelRef.level;
      },
      addEventListener(event: string, fn: () => void) {
        if (event === "levelchange") batteryListeners.add(fn);
      },
    });
  }

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

  const fetchShim = async (input: string | URL | Request, init?: RequestInit): Promise<{ status: number; ok: boolean }> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    fetchCalls.push({ url, init });
    return { status: statsStatus, ok: statsStatus >= 200 && statsStatus < 300 };
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
  setGlobal("fetch", fetchShim);

  setAccessKey("");

  return {
    doc,
    storage,
    pushStates,
    replaceStates,
    backCount: () => backs,
    spoken,
    cancelCount: () => speechCancels,
    fetchCalls,
    setStatsStatus(status: number) {
      statsStatus = status;
    },
    dispatchWindowKey(key: string) {
      const ev = makeEvent("keydown", { key });
      win.dispatchEvent(ev);
      return ev;
    },
    dispatchPopState() {
      const ev = makeEvent("popstate");
      win.dispatchEvent(ev);
      return ev;
    },
    battery: batteryCtrl,
  };
}

async function importHudFresh(): Promise<typeof import("../src/screens/Hud.tsx")> {
  const url = `${pathToFileURL(HUD_MODULE_PATH).href}?case=${++moduleCounter}`;
  return (await import(url)) as typeof import("../src/screens/Hud.tsx");
}

async function mountHud(doc: MiniDocument, HudComp: () => React.JSX.Element) {
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () => {
    root.render(createElement(HudComp));
  });
  return {
    container,
    html: () => container.innerHTML,
    buttons: () => container.findAll((el) => el.tagName === "BUTTON"),
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

function parseHexRgb(hex: string): [number, number, number] {
  const clean = hex.trim().replace(/^#/, "");
  if (clean.length === 3) {
    return [
      parseInt(clean[0] + clean[0], 16),
      parseInt(clean[1] + clean[1], 16),
      parseInt(clean[2] + clean[2], 16),
    ];
  }
  assert.equal(clean.length, 6, `Expected 3 or 6 hex digits, got ${hex}`);
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
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

function evalClampAt600(expr: string): number {
  const m = expr.match(/^clamp\(\s*([\d.]+)(px|rem)\s*,\s*([\d.]+)vmin\s*,\s*([\d.]+)(px|rem)\s*\)$/);
  assert.ok(m, `Expected clamp(min, vmin, max), got: ${expr}`);
  const toPx = (val: number, unit: string) => (unit === "rem" ? val * 16 : val);
  const minPx = toPx(Number(m[1]), m[2]);
  const midPx = Number(m[3]) * 6;
  const maxPx = toPx(Number(m[4]), m[5]);
  return Math.min(maxPx, Math.max(minPx, midPx));
}

function cssBlock(selectorPattern: RegExp): string {
  const m = STYLES_CSS.match(selectorPattern);
  assert.ok(m, `Missing CSS block matching ${String(selectorPattern)}`);
  return m[1];
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
    speech: "Yes, Amlodipine 5 mg, your evening pill. You have not taken it today.",
    read: makeRead(),
    matchedMedId: "amlodipine",
    reasons: ["Name and strength match your list", "Taken today: 0 of 1"],
    takenToday: false,
    ...overrides,
  };
}

test("HUD additive 600x600 display CSS enforces pure #000 transparent background, bounded cards, and fluid 600x600 viewport budget", () => {
  assert.match(HUD_SPEC_MD, /600\s*×\s*600,\s*additive/i);
  assert.match(HUD_SPEC_MD, /black\s*=\s*transparent/i);
  assert.match(HUD_SPEC_MD, /Don't hard-code it\.\*\*\s*Size from the viewport\./);

  const bodyBlock = cssBlock(/html:has\(body\.hud-body\),\s*body\.hud-body\s*\{([^}]+)\}/);
  assert.match(bodyBlock, /background:\s*#000\b/);
  assert.match(bodyBlock, /margin:\s*0\b/);
  assert.match(bodyBlock, /height:\s*100%/);
  assert.match(bodyBlock, /min-height:\s*0\b/);

  const rootBlock = cssBlock(/body\.hud-body\s+#root\s*\{([^}]+)\}/);
  assert.match(rootBlock, /height:\s*100%/);

  const hudBlock = cssBlock(/\.hud\s*\{([^}]+)\}/);
  assert.match(hudBlock, /--hud-accent:\s*#ffd23f/i);
  assert.match(hudBlock, /height:\s*100%/);
  assert.match(hudBlock, /box-sizing:\s*border-box/);
  assert.match(hudBlock, /color:\s*#fff/i);
  assert.match(hudBlock, /display:\s*grid/);
  assert.match(hudBlock, /grid-template-rows:\s*1fr auto auto/);
  assert.match(hudBlock, /overflow:\s*hidden/);
  assert.doesNotMatch(hudBlock, /\bwidth:\s*600px\b/);
  assert.doesNotMatch(hudBlock, /\bheight:\s*600px\b/);

  const cardBlock = cssBlock(/\.hud-card\s*\{([^}]+)\}/);
  assert.match(cardBlock, /background:\s*#000\b/);
  assert.match(cardBlock, /border:\s*4px solid #3a3a3a/i);
  assert.match(cardBlock, /border-radius:\s*20px/);

  const gapMatch = hudBlock.match(/gap:\s*(clamp\([^;]+\))/);
  const padMatch = hudBlock.match(/padding:\s*(clamp\([^;]+\))/);
  assert.ok(gapMatch && padMatch);
  const gapAt600 = evalClampAt600(gapMatch[1]);
  const padAt600 = evalClampAt600(padMatch[1]);
  assert.equal(gapAt600, 15);
  assert.equal(padAt600, 30);

  const btnBlock = cssBlock(/\.hud\s+button\s*\{([^}]+)\}/);
  const btnMinH = btnBlock.match(/min-height:\s*(clamp\([^;]+\))/);
  assert.ok(btnMinH);
  const btnHeightAt600 = evalClampAt600(btnMinH[1]);
  assert.equal(btnHeightAt600, 60);

  const remainingCardHeightAt600 = 600 - padAt600 * 2 - gapAt600 * 2 - btnHeightAt600 - 44;
  assert.ok(remainingCardHeightAt600 >= 380, `Expected >=380px card height at 600x600, got ${remainingCardHeightAt600}`);
});

test("HUD verdict, accent, status, and glyph color tokens meet WCAG AAA 7:1 text contrast and 3:1 UI border contrast on #000", () => {
  const textTokensOnBlack: Array<[string, string, number]> = [
    ["match", "#66BB6A", 7],
    ["warning", "#FFCA28", 7],
    ["unsure", "#4FC3F7", 7],
    ["info", "#FFFFFF", 7],
    ["hud-accent", "#ffd23f", 7],
    ["hud-small", "#e6e6e6", 7],
    ["hud-old", "#ddd", 7],
    ["hud-status", "#d0d0d0", 7],
  ];

  for (const [label, hex, minRatio] of textTokensOnBlack) {
    const ratio = contrastRatio(hex, "#000000");
    assert.ok(ratio >= minRatio, `${label} (${hex}) contrast on #000 is ${ratio.toFixed(2)}, expected >= ${minRatio}`);
  }

  for (const levelHex of ["#66BB6A", "#FFCA28", "#4FC3F7", "#FFFFFF"]) {
    const glyphRatio = contrastRatio("#000000", levelHex);
    assert.ok(glyphRatio >= 7, `Black glyph on ${levelHex} contrast is ${glyphRatio.toFixed(2)}, expected >= 7`);
  }

  const buttonBorderRatio = contrastRatio("#6a6a6a", "#000000");
  assert.ok(buttonBorderRatio >= 3, `HUD button border #6a6a6a on #000 is ${buttonBorderRatio.toFixed(2)}, expected >= 3`);

  const glyphBlock = cssBlock(/\.hud-glyph\s*\{([^}]+)\}/);
  assert.match(glyphBlock, /background:\s*var\(--lvl\)/);
  assert.match(glyphBlock, /color:\s*#000\b/);

  const staleBlock = cssBlock(/\.verdict-card\.stale\s*\{([^}]+)\}/);
  assert.match(staleBlock, /opacity:\s*0\.55/);
  assert.match(staleBlock, /border-style:\s*dashed/);

  const dotOpenBlock = cssBlock(/\.hud-dot\.open\s*\{([^}]+)\}/);
  assert.match(dotOpenBlock, /#66bb6a/i);
  const dotRetryBlock = cssBlock(/\.hud-dot\.retry\s*\{([^}]+)\}/);
  assert.match(dotRetryBlock, /#ffca28/i);
  assert.match(dotRetryBlock, /border-style:\s*dashed/);
});

test("HUD action button target heights, 3px focus ring, sr-only utility, and prefers-reduced-motion rules satisfy WCAG 2.2", () => {
  const actsBlock = cssBlock(/\.hud-acts\s*\{([^}]+)\}/);
  assert.match(actsBlock, /display:\s*grid/);
  assert.match(actsBlock, /grid-template-columns:\s*repeat\(3,\s*1fr\)/);

  const btnBlock = cssBlock(/\.hud\s+button\s*\{([^}]+)\}/);
  assert.match(btnBlock, /min-height:\s*clamp\(48px,\s*10vmin,\s*64px\)/);
  assert.match(btnBlock, /background:\s*#000\b/);
  assert.match(btnBlock, /color:\s*#fff/i);
  assert.match(btnBlock, /border:\s*3px solid #6a6a6a/i);
  assert.match(btnBlock, /font-weight:\s*800/);

  const speakBlock = cssBlock(/\.hud\s+\.hud-speak\s*\{([^}]+)\}/);
  assert.match(speakBlock, /min-height:\s*44px/);

  const focusBlock = cssBlock(/\.hud\s+button:focus-visible,\s*\.hud\s+button:focus\s*\{([^}]+)\}/);
  assert.match(focusBlock, /outline:\s*3px solid var\(--hud-accent\)/);
  assert.match(focusBlock, /outline-offset:\s*3px/);
  assert.match(focusBlock, /border-color:\s*var\(--hud-accent\)/);
  assert.match(focusBlock, /color:\s*var\(--hud-accent\)/);

  const srOnlyBlock = cssBlock(/\.sr-only\s*\{([^}]+)\}/);
  assert.match(srOnlyBlock, /position:\s*absolute\s*!important/);
  assert.match(srOnlyBlock, /width:\s*1px/);
  assert.match(srOnlyBlock, /height:\s*1px/);
  assert.match(srOnlyBlock, /overflow:\s*hidden/);
  assert.match(srOnlyBlock, /white-space:\s*nowrap/);

  assert.match(
    STYLES_CSS,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\*,\s*\*::before,\s*\*::after\s*\{[^}]*animation:\s*none\s*!important;[^}]*transition:\s*none\s*!important;[^}]*scroll-behavior:\s*auto\s*!important;/s,
  );
});

test("web/hud/index.html head metadata, PNG icons, and meta-wearables-manifest.json comply with docs/HUD_SPEC.md", () => {
  assert.match(HUD_INDEX_HTML, /<html\s+lang="en">/);
  assert.match(HUD_INDEX_HTML, /<meta\s+charset="utf-8"\s*\/?>/i);
  assert.match(HUD_INDEX_HTML, /<meta\s+name="viewport"\s+content="width=device-width,\s*initial-scale=1"\s*\/?>/);
  assert.doesNotMatch(HUD_INDEX_HTML, /user-scalable\s*=\s*no/i);
  assert.doesNotMatch(HUD_INDEX_HTML, /maximum-scale\s*=\s*1(\.0)?\b/i);
  assert.match(HUD_INDEX_HTML, /<meta\s+name="mrbd-web-app-capable"\s+content="yes"\s*\/?>/);
  assert.match(HUD_INDEX_HTML, /<meta\s+name="application-name"\s+content="HoldUp"\s*\/?>/);
  assert.match(HUD_INDEX_HTML, /<meta\s+name="theme-color"\s+content="#000000"\s*\/?>/);
  assert.match(HUD_INDEX_HTML, /<link\s+rel="icon"\s+type="image\/png"\s+sizes="96x96"\s+href="\/hud\/icon-96\.png"\s*\/?>/);
  assert.match(HUD_INDEX_HTML, /<body\s+class="hud-body">/);

  const manifestStat = statSync(MANIFEST_PATH);
  assert.ok(manifestStat.size <= 64 * 1024, "Wearables manifest must be <= 64 KiB");
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
    version: number;
    name: string;
    description: string;
    appearance: { theme_color: string; icon: { src: string; type: string } };
  };
  assert.equal(manifest.version, 1);
  assert.equal(manifest.name, "HoldUp");
  assert.equal(manifest.appearance.icon.type, "monochrome");
  assert.equal(manifest.appearance.icon.src, "../icon-mono.png");

  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const icon96 = readFileSync(ICON_96_PATH);
  assert.deepEqual(icon96.subarray(0, 8), pngSignature);
  const w96 = icon96.readUInt32BE(16);
  const h96 = icon96.readUInt32BE(20);
  assert.equal(w96, 96);
  assert.equal(h96, 96);
  assert.ok(w96 > 52 && h96 > 52, "HUD PNG favicon must exceed 52x52 per HUD_SPEC");

  const iconMonoStat = statSync(ICON_MONO_PATH);
  assert.ok(iconMonoStat.size <= 2 * 1024 * 1024, "Monochrome icon must be <= 2 MiB");
  const iconMono = readFileSync(ICON_MONO_PATH);
  assert.deepEqual(iconMono.subarray(0, 8), pngSignature);
});

test("Hud SSR renders sr-only h1, assertive atomic live region, idle Hold it up. card, disabled I took it, and native buttons without positive tabindex", async () => {
  installHudEnv();
  const { Hud } = await importHudFresh();
  const html = renderToStaticMarkup(createElement(Hud));
  const text = decodeHtml(html);

  assert.match(html, /^<div class="hud"><main class="hud-main"><h1 class="sr-only">HoldUp display<\/h1>/);
  assert.match(html, /<div class="hud-live" aria-live="assertive" aria-atomic="true">/);
  assert.match(html, /<section class="hud-card idle-card"><p class="hud-headline hud-accent">Hold it up\.<\/p>/);
  assert.ok(text.includes('Ask: "Is this my evening pill?"'));

  assert.match(html, /<div class="hud-acts"><button type="button">Repeat<\/button><button type="button" disabled="">I took it<\/button><button type="button">Dismiss<\/button><\/div>/);
  assert.match(html, /<footer class="hud-status"><span class="hud-dot connecting" aria-hidden="true"><\/span><span>Connecting\u2026<\/span>/);
  assert.match(html, /<button type="button" class="hud-speak" aria-pressed="false">Speak off<\/button><\/footer>/);
  assert.doesNotMatch(html, /tabindex="[1-9]/i);
});

test("Hud WS mode renders all four non-color glyph + word verdict levels, exact #66BB6A/#FFCA28/#4FC3F7/#FFFFFF tokens, and deduplicated keyFields", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const env = installHudEnv();
  const { Hud } = await importHudFresh();
  const view = await mountHud(env.doc, Hud);

  assert.equal(FakeWebSocket.instances.length, 1);
  const ws = FakeWebSocket.instances[0];
  assert.equal(ws.url, `wss:${SLASH2}holdup.test/hud-ws`);

  await act(async () => {
    ws.serverOpen();
  });
  assert.match(view.html(), /<span class="hud-dot open" aria-hidden="true"><\/span><span>connected<\/span>/);

  const expectedLevels: Array<{ level: VerdictLevel; glyph: string; word: string; color: string }> = [
    { level: "match", glyph: "\u2713", word: "RIGHT ONE", color: "#66BB6A" },
    { level: "warning", glyph: "\u26a0", word: "CHECK", color: "#FFCA28" },
    { level: "unsure", glyph: "?", word: "NOT SURE", color: "#4FC3F7" },
    { level: "info", glyph: "i", word: "INFO", color: "#FFFFFF" },
  ];

  const seenGlyphs = new Set<string>();
  const seenWords = new Set<string>();

  for (const spec of expectedLevels) {
    const verdict = makeVerdict({
      level: spec.level,
      headline: spec.level === "match" ? "Evening blood pressure pill" : `${spec.word} box`,
      matchedMedId: spec.level === "match" ? "amlodipine" : undefined,
      takenToday: spec.level === "match" ? false : undefined,
      reasons: [`Reason for ${spec.level}`],
      read: makeRead({ product: f("Amlodipine", 0.96), strength: f("5 mg", 0.95) }),
    });

    await act(async () => {
      ws.serverJson({ type: "verdict", verdict });
    });

    const html = view.html();
    const text = decodeHtml(html);
    assert.ok(html.includes(`--lvl: ${spec.color}`), `Missing --lvl ${spec.color} for ${spec.level}`);
    assert.ok(
      html.includes(`<span class="hud-glyph" aria-hidden="true">${spec.glyph}</span> ${spec.word}`),
      `Missing glyph + word "${spec.glyph} ${spec.word}" in ${html}`,
    );
    assert.ok(text.includes("Amlodipine \u00b7 5 mg"), "Expected product and strength in .hud-fields when omitted from headline");
    assert.ok(text.includes(`Reason for ${spec.level}`));
    if (spec.level === "match") {
      assert.ok(text.includes("Not taken today"));
    }
    seenGlyphs.add(spec.glyph);
    seenWords.add(spec.word);
  }

  assert.equal(seenGlyphs.size, 4);
  assert.equal(seenWords.size, 4);

  await act(async () => {
    ws.serverJson({
      type: "verdict",
      verdict: makeVerdict({
        level: "warning",
        headline: "Amlodipine 5 mg: already taken",
        matchedMedId: "amlodipine",
        takenToday: true,
        read: makeRead({ product: f("Amlodipine", 0.98), strength: f("5 mg", 0.97) }),
      }),
    });
  });
  const dedupHtml = view.html();
  assert.doesNotMatch(dedupHtml, /class="hud-fields"/, "keyFields already present in headline must not repeat");
  assert.ok(decodeHtml(dedupHtml).includes("Already taken today"));

  await view.unmount();
});

test("Hud coach cue renders 104px decorative CueArrow SVG, auto-clears after 3 seconds, and never overrides an active verdict", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const env = installHudEnv();
  const { Hud } = await importHudFresh();
  const view = await mountHud(env.doc, Hud);
  const ws = FakeWebSocket.instances[0];

  await act(async () => {
    ws.serverOpen();
    ws.serverJson({ type: "coach", cue: "rotate_left" satisfies CoachCue, text: "Turn it left" });
  });

  const cueHtml = view.html();
  assert.match(cueHtml, /<section class="hud-card cue-card">/);
  assert.match(cueHtml, /<svg[^>]*width="104"[^>]*height="104"[^>]*aria-hidden="true"[^>]*focusable="false"/);
  assert.match(cueHtml, /<p class="hud-headline">Turn it left<\/p>/);

  await act(async () => {
    t.mock.timers.tick(3000);
  });
  assert.match(view.html(), /<section class="hud-card idle-card">.*Hold it up\./);

  await act(async () => {
    ws.serverJson({ type: "coach", cue: "closer", text: "A bit closer" });
  });
  assert.match(view.html(), /A bit closer/);

  await act(async () => {
    ws.serverJson({ type: "verdict", verdict: mockWarningIbuprofen() });
  });
  assert.match(view.html(), /Ibuprofen: not on your list/);
  assert.doesNotMatch(view.html(), /cue-card/);

  await act(async () => {
    ws.serverJson({ type: "coach", cue: "other_side", text: "Turn it around" });
  });
  assert.match(view.html(), /Ibuprofen: not on your list/, "Active verdict must remain visible when a coach cue arrives");
  assert.doesNotMatch(view.html(), /cue-card/);

  await view.unmount();
});

test("HudScene switches between 3-column and 5-column strips for far_left/far_right and exposes sr-only position + word + headline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const env = installHudEnv();
  const { Hud } = await importHudFresh();
  const view = await mountHud(env.doc, Hud);
  const ws = FakeWebSocket.instances[0];

  const profile = demoProfile();
  const threeScene = mockScene(profile);
  const reversedThreeScene: Verdict = {
    ...threeScene,
    items: [...(threeScene.items ?? [])].reverse(),
  };

  await act(async () => {
    ws.serverOpen();
    ws.serverJson({ type: "verdict", verdict: reversedThreeScene });
  });

  const threeHtml = view.html();
  assert.match(threeHtml, /<section class="hud-card scene-card " style="--lvl: #66BB6A">/);
  assert.match(threeHtml, /<p class="hud-level">WHICH ONE<\/p>/);
  assert.match(threeHtml, /<ol class="hud-strip" aria-label="Packages, left to right" style="grid-template-columns: repeat\(3, 1fr\)">/);

  const threeSrOnly = Array.from(threeHtml.matchAll(/<li[^>]*>[\s\S]*?<span class="sr-only">([^<]+)<\/span><\/li>/g), (m) => decodeHtml(m[1]));
  assert.deepEqual(threeSrOnly, [
    "left: NOT SURE, Paracetamol: not on your list",
    "middle: CHECK, Ibuprofen: you avoid NSAIDs",
    "right: RIGHT ONE, Amlodipine 5 mg: evening pill",
  ]);
  assert.match(threeHtml, /<li class="hud-slot target" style="--lvl: #66BB6A; grid-column: 3">/);
  assert.match(threeHtml, /<p class="hud-fields">RIGHT: Amlodipine 5 mg: evening pill<\/p>/);

  const makeSceneItem = (position: ScenePosition, level: VerdictLevel, headline: string, matchedMedId?: string): SceneItem => ({
    position,
    level,
    headline,
    matchedMedId,
    read: makeRead(),
  });

  const fiveScene: Verdict = makeVerdict({
    mode: "scene",
    level: "match",
    headline: "Your morning pill is in the middle",
    matchedMedId: undefined,
    items: [
      makeSceneItem("far_right", "info", "Vitamin D"),
      makeSceneItem("left", "warning", "Ibuprofen 400 mg"),
      makeSceneItem("center", "match", "Metformin 500 mg"),
      makeSceneItem("far_left", "unsure", "Faded carton"),
      makeSceneItem("right", "unsure", "Side panel"),
    ],
  });

  await act(async () => {
    ws.serverJson({ type: "verdict", verdict: fiveScene });
  });

  const fiveHtml = view.html();
  assert.match(fiveHtml, /<ol class="hud-strip" aria-label="Packages, left to right" style="grid-template-columns: repeat\(5, 1fr\)">/);
  const fiveSrOnly = Array.from(fiveHtml.matchAll(/<li[^>]*>[\s\S]*?<span class="sr-only">([^<]+)<\/span><\/li>/g), (m) => decodeHtml(m[1]));
  assert.deepEqual(fiveSrOnly, [
    "far left: NOT SURE, Faded carton",
    "left: CHECK, Ibuprofen 400 mg",
    "middle: RIGHT ONE, Metformin 500 mg",
    "right: NOT SURE, Side panel",
    "far right: INFO, Vitamin D",
  ]);
  assert.match(fiveHtml, /<li class="hud-slot target" style="--lvl: #66BB6A; grid-column: 3">/);
  assert.match(fiveHtml, /<p class="hud-fields">MIDDLE: Metformin 500 mg<\/p>/);

  const noTargetScene: Verdict = makeVerdict({
    mode: "scene",
    level: "unsure",
    headline: "None of these match your list",
    matchedMedId: undefined,
    items: [
      makeSceneItem("far_left", "unsure", "Unknown bottle"),
      makeSceneItem("right", "warning", "Avoid NSAID"),
    ],
  });

  await act(async () => {
    ws.serverJson({ type: "verdict", verdict: noTargetScene });
  });

  const noTargetHtml = view.html();
  assert.match(noTargetHtml, /<section class="hud-card scene-card " style="--lvl: #fff">/);
  assert.doesNotMatch(noTargetHtml, /hud-slot target/);
  assert.doesNotMatch(noTargetHtml, /class="hud-fields"/);

  await view.unmount();
});

test("I took it is disabled when !verdict?.matchedMedId, focus targets safest primary action, and Repeat/I took it/Dismiss send WS events", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const env = installHudEnv();
  const { Hud } = await importHudFresh();
  const view = await mountHud(env.doc, Hud);
  const ws = FakeWebSocket.instances[0];

  await act(async () => {
    ws.serverOpen();
  });

  const repeatBtn = view.buttonByText("Repeat");
  const takeBtn = view.buttonByText("I took it");
  const dismissBtn = view.buttonByText("Dismiss");

  assert.equal(takeBtn.disabled, true);
  await act(async () => {
    takeBtn.click();
  });
  assert.deepEqual(ws.sent, []);

  await act(async () => {
    ws.serverJson({ type: "verdict", verdict: mockWarningIbuprofen() });
  });
  assert.equal(takeBtn.disabled, true);
  assert.equal(env.doc.activeElement, repeatBtn, "Unmatched warning must focus Repeat");

  await act(async () => {
    ws.serverJson({ type: "verdict", verdict: mockUnsureStrength() });
  });
  assert.equal(takeBtn.disabled, true);
  assert.equal(env.doc.activeElement, repeatBtn, "Unsure verdict without matchedMedId must disable I took it and focus Repeat");

  await act(async () => {
    ws.serverJson({
      type: "verdict",
      verdict: makeVerdict({
        level: "warning",
        headline: "Amlodipine 5 mg: already taken today",
        matchedMedId: "amlodipine",
        takenToday: true,
      }),
    });
  });
  assert.equal(takeBtn.disabled, false, "Matched warning enables I took it");
  assert.equal(env.doc.activeElement, repeatBtn, "Matched warning must still focus Repeat instead of I took it");

  const profile = demoProfile();
  await act(async () => {
    ws.serverJson({ type: "verdict", verdict: matchVerdict(profile, profile.meds[0]) });
  });
  assert.equal(takeBtn.disabled, false);
  assert.equal(env.doc.activeElement, takeBtn, "Match with matchedMedId focuses I took it");

  await act(async () => {
    repeatBtn.click();
  });
  assert.deepEqual(JSON.parse(ws.sent[0]), { type: "event", name: "repeat" });
  assert.ok(view.html().includes("<span>Repeating</span>"));

  await act(async () => {
    t.mock.timers.tick(1800);
  });
  assert.ok(view.html().includes("<span>connected</span>"));

  await act(async () => {
    takeBtn.click();
  });
  assert.deepEqual(JSON.parse(ws.sent[1]), { type: "event", name: "log_dose" });
  assert.ok(view.html().includes("<span>Dose logged</span>"));

  await act(async () => {
    dismissBtn.click();
  });
  assert.deepEqual(JSON.parse(ws.sent[2]), { type: "event", name: "dismiss" });
  assert.match(view.html(), /Hold it up\./);
  assert.equal(takeBtn.disabled, true);
  assert.equal(env.backCount(), 1);

  await act(async () => {
    t.mock.timers.tick(1800);
  });
  await view.unmount();
});

test("Speak on/off toggle updates aria-pressed, persists holdup.hud.speak in localStorage, and speaks concise bystander-safe utterances only when enabled", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const env = installHudEnv();
  const { Hud } = await importHudFresh();
  const view = await mountHud(env.doc, Hud);
  const ws = FakeWebSocket.instances[0];

  await act(async () => {
    ws.serverOpen();
  });

  const speakBtn = view.buttonByText("Speak");
  assert.equal(speakBtn.getAttribute("aria-pressed"), "false");
  assert.equal(speakBtn.textContent, "Speak off");
  assert.equal(env.storage.get("holdup.hud.speak"), undefined);

  await act(async () => {
    ws.serverJson({ type: "verdict", verdict: makeVerdict() });
  });
  assert.equal(env.spoken.length, 0, "HUD must stay silent by default per HUD_SPEC section 7");

  await act(async () => {
    speakBtn.click();
  });
  assert.equal(speakBtn.getAttribute("aria-pressed"), "true");
  assert.equal(speakBtn.textContent, "Speak on");
  assert.equal(env.storage.get("holdup.hud.speak"), "1");

  await act(async () => {
    ws.serverJson({ type: "verdict", verdict: makeVerdict({ level: "match", headline: "Amlodipine 5 mg" }) });
  });
  assert.equal(env.cancelCount(), 1);
  assert.deepEqual(env.spoken, [{ text: "right one. Amlodipine 5 mg", lang: "en-US" }]);

  await act(async () => {
    view.buttonByText("Repeat").click();
  });
  assert.equal(env.cancelCount(), 2);
  assert.deepEqual(env.spoken[1], { text: "Amlodipine 5 mg", lang: "en-US" });

  await act(async () => {
    t.mock.timers.tick(1800);
  });
  await view.unmount();

  const ssrSavedOn = renderToStaticMarkup(createElement(Hud));
  assert.match(ssrSavedOn, /<button type="button" class="hud-speak" aria-pressed="true">Speak on<\/button>/);

  const remounted = await mountHud(env.doc, Hud);
  const remountSpeakBtn = remounted.buttonByText("Speak");
  assert.equal(remountSpeakBtn.getAttribute("aria-pressed"), "true");
  assert.equal(remountSpeakBtn.textContent, "Speak on");

  await act(async () => {
    remountSpeakBtn.click();
  });
  assert.equal(remountSpeakBtn.getAttribute("aria-pressed"), "false");
  assert.equal(remountSpeakBtn.textContent, "Speak off");
  assert.equal(env.storage.get("holdup.hud.speak"), "0");

  await remounted.unmount();
});

test("Hud marks item and scene verdicts stale with (old) when WS disconnects, backs off 1s -> 2s -> 5s, and clears stale on reconnect", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const env = installHudEnv({ statsStatus: 200 });
  const { Hud } = await importHudFresh();
  const view = await mountHud(env.doc, Hud);

  const ws1 = FakeWebSocket.instances[0];
  await act(async () => {
    ws1.serverOpen();
    ws1.serverJson({ type: "verdict", verdict: makeVerdict({ headline: "Amlodipine 5 mg" }) });
  });
  assert.doesNotMatch(view.html(), /\(old\)/);
  assert.doesNotMatch(view.html(), /verdict-card stale/);

  await act(async () => {
    ws1.serverDrop();
  });
  assert.match(view.html(), /<section class="hud-card verdict-card stale"/);
  assert.match(view.html(), /RIGHT ONE<span class="hud-old"> \(old\)<\/span>/);
  assert.match(view.html(), /<span class="hud-dot retry" aria-hidden="true"><\/span><span>Reconnecting\u2026<\/span>/);
  assert.equal(FakeWebSocket.instances.length, 1);

  await act(async () => {
    t.mock.timers.tick(999);
  });
  assert.equal(FakeWebSocket.instances.length, 1);

  await act(async () => {
    t.mock.timers.tick(1);
  });
  assert.equal(FakeWebSocket.instances.length, 2, "First reconnect fires at 1000ms");

  const ws2 = FakeWebSocket.instances[1];
  await act(async () => {
    ws2.serverDrop();
    t.mock.timers.tick(1999);
  });
  assert.equal(FakeWebSocket.instances.length, 2);

  await act(async () => {
    t.mock.timers.tick(1);
  });
  assert.equal(FakeWebSocket.instances.length, 3, "Second reconnect fires at 2000ms");

  const ws3 = FakeWebSocket.instances[2];
  await act(async () => {
    ws3.serverDrop();
    t.mock.timers.tick(4999);
  });
  assert.equal(FakeWebSocket.instances.length, 3);

  await act(async () => {
    t.mock.timers.tick(1);
  });
  assert.equal(FakeWebSocket.instances.length, 4, "Third reconnect fires at 5000ms");

  const ws4 = FakeWebSocket.instances[3];
  await act(async () => {
    ws4.serverDrop();
    t.mock.timers.tick(5000);
  });
  assert.equal(FakeWebSocket.instances.length, 5, "Fourth+ reconnect caps at 5000ms");

  const ws5 = FakeWebSocket.instances[4];
  await act(async () => {
    ws5.serverOpen();
  });
  assert.doesNotMatch(view.html(), /\(old\)/);
  assert.doesNotMatch(view.html(), /verdict-card stale/);
  assert.match(view.html(), /<span>connected<\/span>/);

  await act(async () => {
    ws5.serverJson({ type: "verdict", verdict: mockScene(demoProfile()) });
    ws5.serverDrop();
  });
  assert.match(view.html(), /<section class="hud-card scene-card stale"/);
  assert.match(view.html(), /WHICH ONE<span class="hud-old"> \(old\)<\/span>/);

  await view.unmount();
});

test("Hud renders Access key needed card on 401 and 403 /api/stats responses and forwards ?session= and x-holdup-key", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const env = installHudEnv({
    search: "?session=PAIR7",
    protocol: "http:",
    host: "localhost:8787",
    statsStatus: 401,
  });
  setAccessKey("secret-99");
  assert.equal(accessKey(), "secret-99");

  const { Hud } = await importHudFresh();
  const view = await mountHud(env.doc, Hud);

  const ws1 = FakeWebSocket.instances[0];
  assert.equal(ws1.url, `ws:${SLASH2}localhost:8787/hud-ws?session=PAIR7&key=secret-99`);

  await act(async () => {
    ws1.serverDrop();
  });

  assert.equal(env.fetchCalls.length, 1);
  assert.equal(env.fetchCalls[0].url, "/api/stats");
  assert.equal(env.fetchCalls[0].init?.cache, "no-store");
  assert.deepEqual(env.fetchCalls[0].init?.headers, { "x-holdup-key": "secret-99" });

  const keyHtml401 = view.html();
  assert.match(keyHtml401, /<section class="hud-card" style="border-color: #FFCA28">/i);
  assert.match(keyHtml401, /<p class="hud-headline">Access key needed<\/p>/);
  assert.ok(decodeHtml(keyHtml401).includes("Open the HUD link with its ?key=\u2026 (set it in the Meta AI app)."));

  await act(async () => {
    t.mock.timers.tick(1000);
  });
  const ws2 = FakeWebSocket.instances[1];
  await act(async () => {
    ws2.serverOpen();
  });
  assert.doesNotMatch(view.html(), /Access key needed/);
  assert.match(view.html(), /Hold it up\./);

  env.setStatsStatus(403);
  await act(async () => {
    ws2.serverDrop();
  });
  assert.match(view.html(), /<p class="hud-headline">Access key needed<\/p>/);

  setAccessKey("");
  await view.unmount();
});

test("Hud never intercepts ArrowUp/ArrowDown/ArrowLeft/ArrowRight/Enter spatial navigation, pushes at most 1 history entry, and dismisses on Escape and popstate", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const env = installHudEnv();
  const { Hud } = await importHudFresh();
  const view = await mountHud(env.doc, Hud);
  const ws = FakeWebSocket.instances[0];

  await act(async () => {
    ws.serverOpen();
    ws.serverJson({ type: "verdict", verdict: makeVerdict({ headline: "First box" }) });
    ws.serverJson({ type: "verdict", verdict: mockFoodNuts() });
    ws.serverJson({ type: "verdict", verdict: mockWarningIbuprofen() });
  });

  assert.equal(env.pushStates.length, 1, "Consecutive verdicts must push at most 1 history entry");
  assert.deepEqual(env.pushStates[0].data, { hudVerdict: 1 });

  for (const navKey of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", " ", "Tab"]) {
    let ev!: MiniEvent;
    await act(async () => {
      ev = env.dispatchWindowKey(navKey);
    });
    assert.equal(ev.defaultPrevented, false, `Key "${navKey}" must not call preventDefault()`);
    assert.match(view.html(), /Ibuprofen: not on your list/, `Key "${navKey}" must not dismiss active verdict`);
    assert.equal(env.backCount(), 0);
  }

  let escEvent!: MiniEvent;
  await act(async () => {
    escEvent = env.dispatchWindowKey("Escape");
  });
  assert.equal(escEvent.defaultPrevented, false);
  assert.match(view.html(), /Hold it up\./);
  assert.equal(env.backCount(), 1, "Escape pops the single pushed history entry");

  await act(async () => {
    env.dispatchPopState();
  });

  await act(async () => {
    ws.serverJson({ type: "verdict", verdict: makeVerdict({ headline: "Second check" }) });
  });
  assert.equal(env.pushStates.length, 2, "After popstate reset, a new verdict pushes 1 fresh history entry");
  assert.match(view.html(), /Second check/);

  await act(async () => {
    env.dispatchPopState();
  });
  assert.match(view.html(), /Hold it up\./, "System Back popstate dismisses verdict to idle card");
  assert.equal(env.backCount(), 1, "popstate handler must not call history.back() a second time");

  await view.unmount();
});

test("Hud ?mock=1 mode cycles demo states, yields to BroadcastChannel phone events, reports camera/battery status, and escapes untrusted HTML", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const env = installHudEnv({ search: "?mock=1", batteryLevel: 0.64 });
  const phoneChannel = new FakeBroadcastChannel(MOCK_HUD_CHANNEL);
  const receivedFromHud: unknown[] = [];
  phoneChannel.onmessage = (ev) => {
    receivedFromHud.push(ev.data);
  };

  const { Hud } = await importHudFresh();
  const view = await mountHud(env.doc, Hud);

  assert.equal(FakeWebSocket.instances.length, 0, "?mock=1 mode must not open a WebSocket");
  assert.match(view.html(), /Turn it around/);
  assert.match(view.html(), /<span>glasses camera<\/span><span>glasses 78%<\/span>/);

  await act(async () => {
    t.mock.timers.tick(4000);
  });
  assert.match(view.html(), /Amlodipine 5 mg/);

  const xssPayload = "<img src=x onerror=alert(1)>";
  await act(async () => {
    phoneChannel.postMessage({ type: "status", live: "degraded" satisfies LiveState });
    phoneChannel.postMessage({
      type: "device",
      device: { connected: true, worn: null, battery: null, streaming: true, source: "glasses" } satisfies DeviceState,
    });
    phoneChannel.postMessage({
      type: "verdict",
      verdict: makeVerdict({
        level: "info",
        headline: `Safe ${xssPayload}`,
        matchedMedId: "amlodipine",
      }),
    });
  });

  const drivenHtml = view.html();
  assert.doesNotMatch(drivenHtml, /<img\b/i);
  assert.match(drivenHtml, /Safe &lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(drivenHtml, /<span>snapshot mode<\/span>/);
  assert.match(drivenHtml, /<span>glasses camera<\/span><span>display 64%<\/span>/);

  await act(async () => {
    t.mock.timers.tick(8000);
  });
  assert.match(view.html(), /Safe &lt;img src=x onerror=alert\(1\)&gt;/, "Auto-cycle must stop once phone BroadcastChannel drives HUD");

  await act(async () => {
    phoneChannel.postMessage({ type: "status", live: "reconnecting" satisfies LiveState });
    phoneChannel.postMessage({
      type: "device",
      device: { connected: true, worn: false, battery: 52, streaming: false, source: "glasses" } satisfies DeviceState,
    });
  });
  assert.match(view.html(), /<span>AI reconnecting\u2026<\/span><span>phone camera<\/span><span>glasses 52%<\/span>/);

  await act(async () => {
    view.buttonByText("Repeat").click();
    view.buttonByText("I took it").click();
    view.buttonByText("Dismiss").click();
  });
  assert.deepEqual(receivedFromHud, [
    { type: "hud_event", name: "repeat" },
    { type: "hud_event", name: "log_dose" },
    { type: "hud_event", name: "dismiss" },
  ]);

  await act(async () => {
    t.mock.timers.tick(1800);
  });
  phoneChannel.close();
  await view.unmount();
});
