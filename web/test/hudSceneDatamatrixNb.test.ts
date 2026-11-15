import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { CoachCue, CrossCheck, DeviceState, Field, Gs1Code, LabelRead, LiveState, SceneItem, ScenePosition, Verdict, VerdictLevel } from "../../shared/types.ts";
import { setAccessKey } from "../src/lib/key.ts";
import { demoProfile } from "../src/lib/storage.ts";
import { emptyRead, matchVerdict, mockScene, mockUnsureStrength, mockWarningIbuprofen, offlineUnknownCode, withCrossCheck } from "../src/lib/verdicts.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const HUD_MODULE_PATH = resolve(HERE, "../src/screens/Hud.tsx");
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

  get disabled(): boolean {
    return this.attributes.has("disabled");
  }

  set disabled(value: boolean) {
    if (value) this.attributes.set("disabled", "");
    else this.attributes.delete("disabled");
  }

  hasClass(token: string): boolean {
    return this.className.split(/\s+/).includes(token);
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
    const win = this.ownerDocument?.defaultView as { dispatchCapture?: (e: MiniEvent) => void; dispatchBubble?: (e: MiniEvent) => void } | null;
    win?.dispatchCapture?.(ev);
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
      win?.dispatchBubble?.(ev);
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

type EnvConfig = {
  search?: string;
  batteryLevel?: number | null;
  batteryReject?: boolean;
};

let moduleCounter = 0;

function installHudEnv(cfg: EnvConfig = {}) {
  FakeWebSocket.instances = [];

  const doc = new MiniDocument();
  const storage = new Map<string, string>();
  const pushStates: Array<{ data: unknown; unused: string; url?: string | URL | null }> = [];
  let backs = 0;

  const loc = {
    search: cfg.search ?? "",
    protocol: "https:",
    host: "holdup.test",
    pathname: "/hud/",
    hash: "",
  };

  const hist = {
    state: null as unknown,
    pushState(data: unknown, unused: string, url?: string | URL | null) {
      hist.state = data;
      pushStates.push({ data, unused, url });
    },
    replaceState(data: unknown, _unused: string, _url?: string | URL | null) {
      hist.state = data;
    },
    back() {
      backs++;
    },
  };

  const winListeners = new Map<string, ListenerRecord[]>();
  const speechSynthesis = {
    cancel() {},
    speak(_utterance: FakeSpeechSynthesisUtterance) {},
  };

  let batteryCtrl: BatteryControl | null = null;
  const batteryListeners = new Set<() => void>();
  if (cfg.batteryLevel !== undefined && cfg.batteryLevel !== null) {
    const bObj = { level: cfg.batteryLevel };
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
  if (cfg.batteryReject) {
    nav.getBattery = async () => {
      throw new Error("Battery API unavailable");
    };
  } else if (batteryCtrl) {
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
    addEventListener(type: string, fn: (ev: MiniEvent) => void, opts?: boolean | { capture?: boolean }) {
      const capture = typeof opts === "boolean" ? opts : Boolean(opts?.capture);
      const list = winListeners.get(type) ?? [];
      list.push({ fn, capture });
      winListeners.set(type, list);
    },
    removeEventListener(type: string, fn: (ev: MiniEvent) => void, opts?: boolean | { capture?: boolean }) {
      const capture = typeof opts === "boolean" ? opts : Boolean(opts?.capture);
      const list = winListeners.get(type);
      if (!list) return;
      winListeners.set(
        type,
        list.filter((entry) => !(entry.fn === fn && entry.capture === capture)),
      );
    },
    dispatchCapture(ev: MiniEvent) {
      ev.currentTarget = win;
      for (const rec of winListeners.get(ev.type) ?? []) {
        if (rec.capture) rec.fn(ev);
      }
    },
    dispatchBubble(ev: MiniEvent) {
      ev.currentTarget = win;
      for (const rec of winListeners.get(ev.type) ?? []) {
        if (!rec.capture) rec.fn(ev);
      }
    },
    dispatchEvent(ev: MiniEvent) {
      ev.target = win;
      win.dispatchCapture(ev);
      win.dispatchBubble(ev);
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
  setGlobal("SpeechSynthesisUtterance", FakeSpeechSynthesisUtterance);
  setGlobal("fetch", async () => ({ status: 200, ok: true }));

  setAccessKey("");

  return {
    doc,
    pushStates,
    backCount: () => backs,
    battery: batteryCtrl,
    dispatchWindowKey(key: string) {
      const ev = makeEvent("keydown", { key });
      win.dispatchEvent(ev);
      return ev;
    },
    dispatchElementKey(el: MiniElement, key: string) {
      const ev = makeEvent("keydown", { key });
      el.dispatchEvent(ev);
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
  const url = `${pathToFileURL(HUD_MODULE_PATH).href}?nbcase=${++moduleCounter}`;
  return (await import(url)) as typeof import("../src/screens/Hud.tsx");
}

async function mountHud(doc: MiniDocument, HudComp: () => React.JSX.Element) {
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () => {
    root.render(createElement(HudComp));
    await Promise.resolve();
  });
  return {
    container,
    html: () => container.innerHTML,
    liveRegion: () => {
      const found = container.findAll((el) => el.hasClass("hud-live"))[0];
      assert.ok(found, "Expected .hud-live container");
      return found;
    },
    statusFooter: () => {
      const found = container.findAll((el) => el.tagName === "FOOTER" && el.hasClass("hud-status"))[0];
      assert.ok(found, "Expected footer.hud-status");
      return found;
    },
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
    headline: "Evening blood pressure pill",
    speech: "Yes, Amlodipine 5 mg, your evening pill.",
    read: makeRead(),
    matchedMedId: "amlodipine",
    reasons: ["Name and strength match your list"],
    takenToday: false,
    ...overrides,
  };
}

function makeSceneItem(position: ScenePosition, level: VerdictLevel, headline: string, matchedMedId?: string): SceneItem {
  return {
    position,
    level,
    headline,
    matchedMedId,
    read: makeRead(),
  };
}

const SAMPLE_GS1: Gs1Code = {
  raw: "01064100123456781728060010LOT9",
  gtin: "06410012345678",
  expiry: "2028-06",
  batch: "LOT9",
};

test("HUD item verdict renders crossCheck badge for agrees true, false, and null inside aria-live assertive and omits when undefined", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const env = installHudEnv();
  const { Hud } = await importHudFresh();
  const view = await mountHud(env.doc, Hud);
  const ws = FakeWebSocket.instances[0];

  await act(async () => {
    ws.serverOpen();
  });

  const live = view.liveRegion();
  assert.equal(live.getAttribute("aria-live"), "assertive");
  assert.equal(live.getAttribute("aria-atomic"), "true");

  await act(async () => {
    ws.serverJson({ type: "verdict", verdict: makeVerdict({ crossCheck: undefined }) });
  });
  assert.equal(live.textContent.includes("\u2713 Double-checked with pack code"), false);
  assert.equal(live.textContent.includes("\u26a0 Pack code mismatch"), false);
  assert.equal(live.textContent.includes("Pack code read"), false);

  const agreesTrueVerdict = withCrossCheck(
    makeVerdict({ headline: "Evening blood pressure pill", takenToday: false }),
    true,
    ["expiry: code 2028-06 = print 2028-06"],
    SAMPLE_GS1,
  );
  await act(async () => {
    ws.serverJson({ type: "verdict", verdict: agreesTrueVerdict });
  });
  const cardTrue = live.findAll((el) => el.hasClass("verdict-card"))[0];
  assert.ok(cardTrue, "Expected .verdict-card inside aria-live=assertive");
  const cardTrueParagraphs = cardTrue.findAll((el) => el.tagName === "P");
  assert.deepEqual(
    cardTrueParagraphs.map((p) => ({ cls: p.className, text: p.textContent })),
    [
      { cls: "hud-level", text: "\u2713 RIGHT ONE" },
      { cls: "hud-headline", text: "Evening blood pressure pill" },
      { cls: "hud-fields", text: "Amlodipine \u00b7 5 mg" },
      { cls: "hud-small", text: "\u2713 Double-checked with pack code" },
      { cls: "hud-small", text: "Not taken today" },
      { cls: "hud-small", text: "Name and strength match your list" },
    ],
  );

  const mismatchCrossCheck: CrossCheck = {
    source: "datamatrix",
    code: SAMPLE_GS1,
    agrees: false,
    details: ["strength: pack code 10 mg != printed 5 mg"],
  };
  await act(async () => {
    ws.serverJson({
      type: "verdict",
      verdict: makeVerdict({
        level: "warning",
        headline: "Check strength before taking",
        matchedMedId: undefined,
        takenToday: undefined,
        crossCheck: mismatchCrossCheck,
        reasons: ["Printed label conflicts with pack code"],
      }),
    });
  });
  const cardFalse = live.findAll((el) => el.hasClass("verdict-card"))[0];
  assert.ok(cardFalse);
  const smallFalse = cardFalse.findAll((el) => el.tagName === "P" && el.hasClass("hud-small")).map((p) => p.textContent);
  assert.deepEqual(smallFalse, ["\u26a0 Pack code mismatch", "Printed label conflicts with pack code"]);
  assert.equal(live.textContent.includes("\u2713 Double-checked with pack code"), false);
  assert.equal(live.textContent.includes("Pack code read"), false);

  const profile = demoProfile();
  const offlineDmMatch = matchVerdict(profile, profile.meds[0], { via: "datamatrix", code: SAMPLE_GS1 });
  assert.equal(offlineDmMatch.crossCheck?.agrees, null);
  await act(async () => {
    ws.serverJson({ type: "verdict", verdict: offlineDmMatch });
  });
  const cardNullMatch = live.findAll((el) => el.hasClass("verdict-card"))[0];
  assert.ok(cardNullMatch);
  assert.ok(
    cardNullMatch.findAll((el) => el.tagName === "P" && el.hasClass("hud-small")).some((p) => p.textContent === "Pack code read"),
    "Expected Pack code read for agrees: null on offline DataMatrix match",
  );

  await act(async () => {
    ws.serverJson({ type: "verdict", verdict: offlineUnknownCode(SAMPLE_GS1) });
  });
  const cardNullUnknown = live.findAll((el) => el.hasClass("verdict-card"))[0];
  assert.ok(cardNullUnknown);
  assert.ok(cardNullUnknown.findAll((el) => el.tagName === "P" && el.hasClass("hud-small")).some((p) => p.textContent === "Pack code read"));
  assert.equal(live.textContent.includes("\u2713 Double-checked with pack code"), false);
  assert.equal(live.textContent.includes("\u26a0 Pack code mismatch"), false);

  await act(async () => {
    ws.serverJson({ type: "verdict", verdict: mockWarningIbuprofen() });
  });
  assert.equal(live.textContent.includes("Pack code read"), false);

  await view.unmount();
});

test("HudScene switches 3-column vs 5-column CSS grids, resolves matchedMedId before fallback match, renders sr-only copy, and marks (old) on WS drop", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const env = installHudEnv();
  const { Hud } = await importHudFresh();
  const view = await mountHud(env.doc, Hud);
  const ws = FakeWebSocket.instances[0];

  await act(async () => {
    ws.serverOpen();
  });

  const threeColMatchedIdScene: Verdict = makeVerdict({
    mode: "scene",
    level: "match",
    headline: "Your evening pill: on the right",
    matchedMedId: "amlodipine",
    items: [
      makeSceneItem("right", "match", "Amlodipine 5 mg: evening pill", "amlodipine"),
      makeSceneItem("left", "match", "Metformin 500 mg: morning pill", "metformin"),
      makeSceneItem("center", "warning", "Ibuprofen 400 mg: avoid NSAIDs"),
    ],
  });

  await act(async () => {
    ws.serverJson({ type: "verdict", verdict: threeColMatchedIdScene });
  });

  const live = view.liveRegion();
  const strip3 = live.findAll((el) => el.tagName === "OL" && el.hasClass("hud-strip"))[0];
  assert.ok(strip3);
  assert.equal(strip3.style.gridTemplateColumns, "repeat(3, 1fr)");
  const slots3 = strip3.findAll((el) => el.tagName === "LI" && el.hasClass("hud-slot"));
  assert.equal(slots3.length, 3);
  assert.deepEqual(
    slots3.map((li) => ({
      col: Number(li.style.gridColumn),
      target: li.hasClass("target"),
      sr: li.findAll((s) => s.hasClass("sr-only"))[0]?.textContent,
    })),
    [
      { col: 1, target: false, sr: "left: RIGHT ONE, Metformin 500 mg: morning pill" },
      { col: 2, target: false, sr: "middle: CHECK, Ibuprofen 400 mg: avoid NSAIDs" },
      { col: 3, target: true, sr: "right: RIGHT ONE, Amlodipine 5 mg: evening pill" },
    ],
  );
  const fields3 = live.findAll((el) => el.tagName === "P" && el.hasClass("hud-fields"))[0];
  assert.equal(fields3?.textContent, "RIGHT: Amlodipine 5 mg: evening pill");

  const fiveColFallbackScene: Verdict = makeVerdict({
    mode: "scene",
    level: "match",
    headline: "Middle box is Metformin",
    matchedMedId: "non-existent-id",
    items: [
      makeSceneItem("far_right", "info", "Vitamin D3"),
      makeSceneItem("right", "unsure", "Blurry bottle"),
      makeSceneItem("center", "match", "Metformin 500 mg"),
      makeSceneItem("left", "warning", "Ibuprofen 400 mg"),
      makeSceneItem("far_left", "unsure", "Turn box around"),
    ],
  });

  await act(async () => {
    ws.serverJson({ type: "verdict", verdict: fiveColFallbackScene });
  });

  const strip5 = live.findAll((el) => el.tagName === "OL" && el.hasClass("hud-strip"))[0];
  assert.ok(strip5);
  assert.equal(strip5.style.gridTemplateColumns, "repeat(5, 1fr)");
  const slots5 = strip5.findAll((el) => el.tagName === "LI" && el.hasClass("hud-slot"));
  assert.deepEqual(
    slots5.map((li) => ({
      col: Number(li.style.gridColumn),
      target: li.hasClass("target"),
      sr: li.findAll((s) => s.hasClass("sr-only"))[0]?.textContent,
    })),
    [
      { col: 1, target: false, sr: "far left: NOT SURE, Turn box around" },
      { col: 2, target: false, sr: "left: CHECK, Ibuprofen 400 mg" },
      { col: 3, target: true, sr: "middle: RIGHT ONE, Metformin 500 mg" },
      { col: 4, target: false, sr: "right: NOT SURE, Blurry bottle" },
      { col: 5, target: false, sr: "far right: INFO, Vitamin D3" },
    ],
  );
  assert.equal(live.findAll((el) => el.tagName === "P" && el.hasClass("hud-fields"))[0]?.textContent, "MIDDLE: Metformin 500 mg");

  const sceneCardFresh = live.findAll((el) => el.hasClass("scene-card"))[0];
  assert.ok(sceneCardFresh);
  assert.equal(sceneCardFresh.hasClass("stale"), false);
  assert.equal(sceneCardFresh.findAll((el) => el.hasClass("hud-old")).length, 0);

  await act(async () => {
    ws.serverDrop();
  });

  const sceneCardStale = live.findAll((el) => el.hasClass("scene-card"))[0];
  assert.ok(sceneCardStale);
  assert.equal(sceneCardStale.hasClass("stale"), true);
  const oldBadge = sceneCardStale.findAll((el) => el.hasClass("hud-old"))[0];
  assert.ok(oldBadge);
  assert.equal(oldBadge.textContent, " (old)");
  assert.equal(sceneCardStale.findAll((el) => el.hasClass("hud-level"))[0]?.textContent, "WHICH ONE (old)");

  await act(async () => {
    t.mock.timers.tick(1000);
  });
  const ws2 = FakeWebSocket.instances[1];
  await act(async () => {
    ws2.serverOpen();
  });
  const sceneCardReconnected = live.findAll((el) => el.hasClass("scene-card"))[0];
  assert.equal(sceneCardReconnected?.hasClass("stale"), false);
  assert.equal(sceneCardReconnected?.findAll((el) => el.hasClass("hud-old")).length, 0);

  await view.unmount();
});

test("Neural Band and touchpad input contract uses native buttons, zero positive tabindex, focus handoff, and Escape/popstate dismissal without blocking spatial nav", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const env = installHudEnv();
  const { Hud } = await importHudFresh();
  const view = await mountHud(env.doc, Hud);
  const ws = FakeWebSocket.instances[0];

  await act(async () => {
    ws.serverOpen();
  });

  const checkNativeButtonsAndTabindex = () => {
    const allElements = view.container.findAll(() => true);
    for (const el of allElements) {
      const ti = el.getAttribute("tabindex");
      if (ti !== null) {
        assert.ok(Number(ti) <= 0, `Positive tabindex="${ti}" forbidden by HUD_SPEC section 6`);
      }
      if (el.getAttribute("role") === "button") {
        assert.equal(el.tagName, "BUTTON", "Interactive button role must use native <button>");
      }
    }
    const buttons = view.buttons();
    assert.equal(buttons.length, 4);
    for (const btn of buttons) {
      assert.equal(btn.tagName, "BUTTON");
      assert.equal(btn.getAttribute("type"), "button");
    }
  };

  checkNativeButtonsAndTabindex();

  const repeatBtn = view.buttonByText("Repeat");
  const takeBtn = view.buttonByText("I took it");
  const dismissBtn = view.buttonByText("Dismiss");
  assert.equal(takeBtn.disabled, true);

  const profile = demoProfile();
  await act(async () => {
    ws.serverJson({ type: "verdict", verdict: matchVerdict(profile, profile.meds[0]) });
  });
  checkNativeButtonsAndTabindex();
  assert.equal(takeBtn.disabled, false);
  assert.equal(env.doc.activeElement, takeBtn, "match + matchedMedId must focus I took it");
  assert.equal(env.pushStates.length, 1);

  for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter"] as const) {
    let btnEv!: MiniEvent;
    let winEv!: MiniEvent;
    await act(async () => {
      btnEv = env.dispatchElementKey(takeBtn, key);
      winEv = env.dispatchWindowKey(key);
    });
    assert.equal(btnEv.defaultPrevented, false, `Element keydown "${key}" must never call preventDefault()`);
    assert.equal(winEv.defaultPrevented, false, `Window keydown "${key}" must never call preventDefault()`);
    assert.equal(env.backCount(), 0);
    assert.equal(ws.sent.length, 0);
    assert.ok(view.liveRegion().textContent.includes("Amlodipine 5 mg"));
  }

  await act(async () => {
    ws.serverJson({
      type: "verdict",
      verdict: makeVerdict({ level: "match", headline: "Safe oat milk", matchedMedId: undefined, takenToday: undefined }),
    });
  });
  assert.equal(takeBtn.disabled, true);
  assert.equal(env.doc.activeElement, repeatBtn, "match without matchedMedId must focus Repeat");

  await act(async () => {
    ws.serverJson({
      type: "verdict",
      verdict: makeVerdict({ level: "warning", headline: "Already taken today", matchedMedId: "amlodipine", takenToday: true }),
    });
  });
  assert.equal(takeBtn.disabled, false);
  assert.equal(env.doc.activeElement, repeatBtn, "warning with matchedMedId must focus Repeat");

  await act(async () => {
    ws.serverJson({ type: "verdict", verdict: mockUnsureStrength() });
  });
  assert.equal(takeBtn.disabled, true);
  assert.equal(env.doc.activeElement, repeatBtn, "unsure verdict must focus Repeat");

  await act(async () => {
    ws.serverJson({ type: "verdict", verdict: mockScene(profile) });
  });
  assert.equal(takeBtn.disabled, false);
  assert.equal(env.doc.activeElement, takeBtn, "scene match with matchedMedId must focus I took it");
  assert.equal(env.pushStates.length, 1, "Multiple verdicts must not stack history entries");

  let escEv!: MiniEvent;
  await act(async () => {
    ws.serverJson({ type: "coach", cue: "closer" satisfies CoachCue, text: "Move closer" });
    escEv = env.dispatchWindowKey("Escape");
  });
  assert.equal(escEv.defaultPrevented, false);
  assert.ok(view.liveRegion().textContent.includes("Hold it up."));
  assert.equal(takeBtn.disabled, true);
  assert.equal(env.backCount(), 1);

  await act(async () => {
    env.dispatchPopState();
    env.dispatchWindowKey("Escape");
  });
  assert.equal(env.backCount(), 1, "Escape while idle must not call history.back()");

  await act(async () => {
    ws.serverJson({ type: "verdict", verdict: matchVerdict(profile, profile.meds[0]) });
  });
  assert.equal(env.pushStates.length, 2);
  assert.ok(view.liveRegion().textContent.includes("Amlodipine 5 mg"));

  await act(async () => {
    env.dispatchPopState();
  });
  assert.ok(view.liveRegion().textContent.includes("Hold it up."), "popstate from system Back must dismiss verdict card");
  assert.equal(takeBtn.disabled, true);
  assert.equal(env.backCount(), 1);

  await act(async () => {
    ws.serverJson({ type: "verdict", verdict: matchVerdict(profile, profile.meds[0]) });
  });
  assert.equal(env.pushStates.length, 3);
  await act(async () => {
    dismissBtn.click();
  });
  assert.deepEqual(JSON.parse(ws.sent[0]), { type: "event", name: "dismiss" });
  assert.ok(view.liveRegion().textContent.includes("Hold it up."));
  assert.equal(env.backCount(), 2);

  await view.unmount();
});

test("HUD status strip handles nullable DAT worn and battery sensors, switches to phone camera when worn false or disconnected, and falls back to navigator.getBattery()", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const env = installHudEnv({ batteryLevel: 0.83 });
  const { Hud } = await importHudFresh();
  const view = await mountHud(env.doc, Hud);
  const ws = FakeWebSocket.instances[0];

  const footerTexts = () =>
    view
      .statusFooter()
      .findAll((el) => el.tagName === "SPAN" && !el.hasClass("hud-dot"))
      .map((el) => el.textContent);

  await act(async () => {
    ws.serverOpen();
    ws.serverJson({ type: "status", live: "open" satisfies LiveState });
  });
  assert.deepEqual(footerTexts(), ["connected", "display 83%"]);

  await act(async () => {
    ws.serverJson({
      type: "device",
      device: { connected: true, worn: null, battery: null, streaming: true, source: "glasses" } satisfies DeviceState,
    });
  });
  assert.deepEqual(footerTexts(), ["connected", "glasses camera", "display 83%"]);

  await act(async () => {
    ws.serverJson({
      type: "device",
      device: { connected: true, worn: null, battery: 67, streaming: true, source: "glasses" } satisfies DeviceState,
    });
  });
  assert.deepEqual(footerTexts(), ["connected", "glasses camera", "glasses 67%"]);

  await act(async () => {
    ws.serverJson({
      type: "device",
      device: { connected: true, worn: true, battery: 0, streaming: true, source: "glasses" } satisfies DeviceState,
    });
  });
  assert.deepEqual(footerTexts(), ["connected", "glasses camera", "glasses 0%"]);

  await act(async () => {
    ws.serverJson({
      type: "device",
      device: { connected: true, worn: false, battery: 64, streaming: false, source: "glasses" } satisfies DeviceState,
    });
  });
  assert.deepEqual(footerTexts(), ["connected", "phone camera", "glasses 64%"]);

  await act(async () => {
    ws.serverJson({
      type: "device",
      device: { connected: false, worn: true, battery: null, streaming: false, source: "glasses" } satisfies DeviceState,
    });
  });
  assert.deepEqual(footerTexts(), ["connected", "phone camera", "display 83%"]);

  await act(async () => {
    ws.serverJson({
      type: "device",
      device: { connected: false, worn: null, battery: null, streaming: false, source: "glasses" } satisfies DeviceState,
    });
  });
  assert.deepEqual(footerTexts(), ["connected", "phone camera", "display 83%"]);

  await act(async () => {
    env.battery?.setLevel(0.576);
  });
  assert.deepEqual(footerTexts(), ["connected", "phone camera", "display 58%"]);

  await act(async () => {
    ws.serverJson({
      type: "device",
      device: { connected: true, worn: true, battery: null, streaming: true, source: "phone" } satisfies DeviceState,
    });
  });
  assert.deepEqual(footerTexts(), ["connected", "phone camera", "display 58%"]);

  await view.unmount();

  const envNoBattery = installHudEnv({ batteryReject: true });
  const { Hud: HudNoBatt } = await importHudFresh();
  const viewNoBatt = await mountHud(envNoBattery.doc, HudNoBatt);
  const wsNoBatt = FakeWebSocket.instances[0];
  await act(async () => {
    wsNoBatt.serverOpen();
    wsNoBatt.serverJson({
      type: "device",
      device: { connected: true, worn: null, battery: null, streaming: true, source: "glasses" } satisfies DeviceState,
    });
  });
  const noBattSpans = viewNoBatt
    .statusFooter()
    .findAll((el) => el.tagName === "SPAN" && !el.hasClass("hud-dot"))
    .map((el) => el.textContent);
  assert.deepEqual(noBattSpans, ["connected", "glasses camera"]);
  await viewNoBatt.unmount();
});
