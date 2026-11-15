import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { DeviceState, Field, LabelRead, Profile, Verdict } from "../../shared/types.ts";

const SLASH = "\x2f";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const HUD_MODULE_PATH = path.resolve(HERE, "..", "src", "screens", "Hud.tsx");
const ONBOARDING_MODULE_PATH = path.resolve(HERE, "..", "src", "screens", "Onboarding.tsx");
const PRIVACY_MODULE_PATH = path.resolve(HERE, "..", "src", "screens", "Privacy.tsx");
const STORAGE_MODULE_PATH = path.resolve(HERE, "..", "src", "lib", "storage.ts");
const PRIVACY_DOC_PATH = path.resolve(REPO_ROOT, "docs", "PRIVACY.md");
const CHECKER_PATH = path.resolve(HERE, "..", "src", "lib", "checker.ts");
const VERIFY_SERVER_PATH = path.resolve(REPO_ROOT, "server", "src", "verify.ts");
const HUB_SERVER_PATH = path.resolve(REPO_ROOT, "server", "src", "hub.ts");

const XHTML_NS = ["http:", "", "www.w3.org", "1999", "xhtml"].join(SLASH);
const ORIGIN = ["https:", "", "holdup.test"].join(SLASH);

function setGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
  });
}

setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
setGlobal("React", React);

const realSetInterval = globalThis.setInterval;
const activeIntervals = new Set<ReturnType<typeof setInterval>>();
setGlobal("setInterval", (...args: Parameters<typeof setInterval>): ReturnType<typeof setInterval> => {
  const handle = realSetInterval(...args);
  (handle as unknown as { unref?: () => void }).unref?.();
  activeIntervals.add(handle);
  return handle;
});

after(() => {
  for (const h of activeIntervals) clearInterval(h);
  activeIntervals.clear();
});

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
    const out: string[] = [];
    for (const [k, v] of this.custom) out.push(`${k}: ${v}`);
    for (const key of Object.keys(this)) {
      if (key === "custom") continue;
      const raw = this[key];
      if ((typeof raw === "string" && raw.length > 0) || typeof raw === "number") {
        const cssProp = key.startsWith("--") ? key : key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
        out.push(`${cssProp}: ${String(raw)}`);
      }
    }
    return out.join("; ");
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
  private _checked = false;
  private _value = "";

  constructor(tag: string, namespaceURI: string, ownerDocument: MiniDocument) {
    const nodeName = namespaceURI === XHTML_NS ? tag.toUpperCase() : tag;
    super(1, nodeName, ownerDocument);
    this.tagName = nodeName;
    this.namespaceURI = namespaceURI;
  }

  get checked(): boolean {
    return this._checked;
  }

  set checked(v: boolean) {
    this._checked = Boolean(v);
    if (this._checked) this.attributes.set("checked", "");
    else this.attributes.delete("checked");
  }

  get value(): string {
    return this._value || this.attributes.get("value") || "";
  }

  set value(v: string) {
    this._value = String(v);
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
    if (this.tagName === "INPUT" && (this.type === "checkbox" || this.type === "radio")) {
      this._checked = !this._checked;
      if (this._checked) this.attributes.set("checked", "");
      else this.attributes.delete("checked");
    }
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
    if (value && this.ownerDocument) this.appendChild(new MiniText(value, this.ownerDocument));
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

function makeStorageShim(map: Map<string, string>) {
  return {
    get length() {
      return map.size;
    },
    key(index: number) {
      return Array.from(map.keys())[index] ?? null;
    },
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    setItem(key: string, value: string) {
      map.set(key, String(value));
    },
    removeItem(key: string) {
      map.delete(key);
    },
    clear() {
      map.clear();
    },
  };
}

let moduleSeq = 0;

function installEnv(initialLocal: Record<string, string> = {}, opts: { confirmAnswer?: boolean } = {}) {
  FakeWebSocket.instances = [];
  const doc = new MiniDocument();
  const localMap = new Map<string, string>(Object.entries(initialLocal));
  const sessionMap = new Map<string, string>([["holdup.temp", "ephemeral-session-token"]]);
  const cacheBuckets = new Set<string>(["holdup-shell-v1", "holdup-phrases-v1"]);
  let speechCancels = 0;
  let backs = 0;
  let confirmAnswer = opts.confirmAnswer ?? true;
  const confirmPrompts: string[] = [];
  const spoken: Array<{ text: string; lang: string }> = [];
  const winListeners = new Map<string, Set<(ev: MiniEvent) => void>>();

  const loc = {
    origin: ORIGIN,
    search: "",
    protocol: "https:",
    host: "holdup.test",
    pathname: [SLASH, "hud", ""].join(""),
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
    },
    speak(utterance: FakeSpeechSynthesisUtterance) {
      spoken.push({ text: utterance.text, lang: utterance.lang });
    },
  };

  const cachesShim = {
    async keys() {
      return [...cacheBuckets];
    },
    async delete(name: string) {
      return cacheBuckets.delete(name);
    },
  };

  const nav = {
    language: "en-US",
    onLine: true,
    userAgent: "Mozilla 5.0 Android 14 Chrome 130.0",
    vibrate: () => true,
  };

  const confirmFn = (message?: string) => {
    confirmPrompts.push(String(message ?? ""));
    return confirmAnswer;
  };

  const localStorageShim = makeStorageShim(localMap);
  const sessionStorageShim = makeStorageShim(sessionMap);

  const win = {
    document: doc,
    navigator: nav,
    location: loc,
    history: hist,
    speechSynthesis,
    caches: cachesShim,
    confirm: confirmFn,
    isSecureContext: true,
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

  setGlobal("window", win);
  setGlobal("document", doc);
  setGlobal("navigator", nav);
  setGlobal("location", loc);
  setGlobal("history", hist);
  setGlobal("localStorage", localStorageShim);
  setGlobal("sessionStorage", sessionStorageShim);
  setGlobal("caches", cachesShim);
  setGlobal("confirm", confirmFn);
  setGlobal("WebSocket", FakeWebSocket);
  setGlobal("BroadcastChannel", FakeBroadcastChannel);
  setGlobal("SpeechSynthesisUtterance", FakeSpeechSynthesisUtterance);
  setGlobal("fetch", async () => ({ status: 200, ok: true }));

  return {
    doc,
    localMap,
    sessionMap,
    cacheBuckets,
    spoken,
    confirmPrompts,
    setConfirm(next: boolean) {
      confirmAnswer = next;
    },
    cancelCount: () => speechCancels,
    backCount: () => backs,
    historyState: () => hist.state,
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
  const url = `${pathToFileURL(HUD_MODULE_PATH).href}?bystander=${++moduleSeq}`;
  return (await import(url)) as typeof import("../src/screens/Hud.tsx");
}

async function importOnboardingFresh(): Promise<typeof import("../src/screens/Onboarding.tsx")> {
  const url = `${pathToFileURL(ONBOARDING_MODULE_PATH).href}?bystander=${++moduleSeq}`;
  return (await import(url)) as typeof import("../src/screens/Onboarding.tsx");
}

async function importPrivacyFresh(): Promise<typeof import("../src/screens/Privacy.tsx")> {
  const url = `${pathToFileURL(PRIVACY_MODULE_PATH).href}?bystander=${++moduleSeq}`;
  return (await import(url)) as typeof import("../src/screens/Privacy.tsx");
}

async function importStorageFresh(): Promise<typeof import("../src/lib/storage.ts")> {
  const url = `${pathToFileURL(STORAGE_MODULE_PATH).href}?bystander=${++moduleSeq}`;
  return (await import(url)) as typeof import("../src/lib/storage.ts");
}

async function mountElement(doc: MiniDocument, node: React.ReactElement) {
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () => {
    root.render(node);
  });
  return {
    container,
    text: () => container.textContent,
    html: () => container.innerHTML,
    buttonByText(label: string) {
      const btn = container.findAll((el) => el.tagName === "BUTTON" && el.textContent.replace(/\s+/g, " ").trim().includes(label))[0];
      assert.ok(btn, `Expected button containing "${label}"`);
      return btn;
    },
    rerender: async (next: React.ReactElement) => {
      await act(async () => {
        root.render(next);
      });
    },
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
    },
  };
}

const f = <T,>(value: T | null, confidence = 0.96): Field<T> => ({ value, confidence });

function makeRead(product: string, ingredient: string, strength: string | null): LabelRead {
  return {
    kind: strength ? "medication" : "food",
    product: f(product),
    ingredient: f(ingredient),
    strength: strength ? f(strength) : f<string>(null, 0),
    dosing: f("1 tablet once daily", 0.9),
    expiry: f("2028-09", 0.92),
    allergens: f<string[]>(null, 0),
    barcode: f("6416542009911", 0.98),
    readability: 0.95,
  };
}

function fullPrivateProfile(lang = "en"): Profile {
  return {
    lang,
    meds: [
      {
        id: "aml",
        name: "Amlodipine",
        ingredient: "amlodipine",
        strength: "5 mg",
        schedule: ["evening"],
        barcode: "6416542002149",
        gtin: "06416542002149",
        notes: "Cardiology clinic Dr Korhonen private note",
      },
      {
        id: "war",
        name: "Warfarin",
        ingredient: "warfarin",
        strength: "3 mg",
        schedule: ["18:00"],
        barcode: "6416542007771",
        gtin: "06416542007771",
        notes: "INR clinic weekly target",
      },
      {
        id: "met",
        name: "Metformin",
        ingredient: "metformin",
        strength: "850 mg",
        schedule: ["morning", "evening"],
        barcode: "6416542003375",
        gtin: "06416542003375",
        notes: "Take with breakfast and dinner",
      },
    ],
    allergies: ["peanut", "penicillin", "shellfish"],
    avoid: ["NSAIDs", "grapefruit"],
    doseLog: [{ medId: "war", ts: 1763190000123 }],
  };
}

test("factual disclosure parity across Onboarding.tsx (all 3 consent cards), Privacy.tsx, and docs/PRIVACY.md", async () => {
  const env = installEnv({
    "holdup.profile": JSON.stringify(fullPrivateProfile("en")),
    "holdup.consent": JSON.stringify({ version: 1, ts: 1763180000000 }),
    "holdup.settings": JSON.stringify({ voice: true, quiet: false }),
    "holdup.session": "ABCD",
    "holdup.hud.speak": "1",
    "unrelated.app.preference": "keep-me",
  });

  const [{ Consent }, { Privacy }, storageMod] = await Promise.all([
    importOnboardingFresh(),
    importPrivacyFresh(),
    importStorageFresh(),
  ]);

  let agreed = 0;
  let declined = 0;
  const onb = await mountElement(
    env.doc,
    createElement(Consent, {
      onAgree: () => {
        agreed++;
      },
      onNotNow: () => {
        declined++;
      },
    }),
  );

  assert.match(onb.text(), /three short things about your privacy/i);
  await act(async () => {
    onb.buttonByText("Continue").click();
  });

  const progress1 = onb.container.findAll((el) => el.getAttribute("role") === "progressbar")[0];
  assert.ok(progress1);
  assert.equal(progress1.getAttribute("aria-valuemin"), "1");
  assert.equal(progress1.getAttribute("aria-valuemax"), "3");
  assert.equal(progress1.getAttribute("aria-valuenow"), "1");
  assert.equal(progress1.getAttribute("aria-valuetext"), "Card 1 of 3");
  const card1Text = onb.text();
  assert.match(card1Text, /What HoldUp captures/);
  assert.match(card1Text, /CAMERA ON/);
  assert.match(card1Text, /turns off by itself after 45 seconds without a label/);
  assert.match(card1Text, /Your voice, only while you're in a check\./);
  assert.match(card1Text, /No pictures are taken in the background, ever\./);

  await act(async () => {
    onb.buttonByText("Next").click();
  });
  const progress2 = onb.container.findAll((el) => el.getAttribute("role") === "progressbar")[0];
  assert.equal(progress2?.getAttribute("aria-valuenow"), "2");
  assert.equal(progress2?.getAttribute("aria-valuetext"), "Card 2 of 3");
  const card2Text = onb.text();
  assert.match(card2Text, /Where it goes/);
  assert.match(card2Text, /encrypted connection to the HoldUp server and Google's Gemini AI/);
  assert.match(card2Text, /handles them in memory and does not store your pictures, audio or what you said/);
  assert.match(card2Text, /People in view are ignored\. HoldUp never describes faces\./);

  await act(async () => {
    onb.buttonByText("Next").click();
  });
  const progress3 = onb.container.findAll((el) => el.getAttribute("role") === "progressbar")[0];
  assert.equal(progress3?.getAttribute("aria-valuenow"), "3");
  assert.equal(progress3?.getAttribute("aria-valuetext"), "Card 3 of 3");
  const card3Text = onb.text();
  assert.match(card3Text, /What stays on this phone/);
  assert.match(card3Text, /stored only on this phone/);
  assert.match(card3Text, /in memory only while a check runs \(up to 10 minutes for reconnecting\), never on disk/);
  assert.match(card3Text, /You can delete everything with one button in Privacy\./);
  assert.match(card3Text, /HoldUp is a research prototype, not a CE-marked medical device\./);
  assert.match(card3Text, /when it isn't sure it tells you to ask a pharmacist\./);

  await act(async () => {
    onb.buttonByText("Back").click();
  });
  assert.match(onb.text(), /Where it goes/);
  await act(async () => {
    onb.buttonByText("Next").click();
  });
  await act(async () => {
    onb.buttonByText("Not now").click();
  });
  assert.equal(declined, 1);
  await act(async () => {
    onb.buttonByText("I agree").click();
  });
  assert.equal(agreed, 1);
  await onb.unmount();

  let withdrew = 0;
  let deleted = 0;
  let reviewed = 0;
  const priv = await mountElement(
    env.doc,
    createElement(Privacy, {
      consent: { version: 1, ts: 1763180000000 },
      onWithdraw: () => {
        withdrew++;
        return false;
      },
      onReviewConsent: () => {
        reviewed++;
      },
      onDeleteAll: () => {
        deleted++;
        void storageMod.deleteAllData();
      },
    }),
  );

  const privText = priv.text();
  assert.match(privText, /On only during a check\./);
  assert.match(privText, /HoldUp keeps them in memory only and never saves them\./);
  assert.match(privText, /Your medicine list, allergies, avoid list, dose log and settings\./);
  assert.match(privText, /Delete all my data/);
  assert.match(privText, /HoldUp is a research prototype, not a CE-marked medical device\./);
  assert.match(privText, /Ask a pharmacist about anything uncertain\./);

  const deleteButtons = priv.container.findAll(
    (el) => el.tagName === "BUTTON" && el.textContent.replace(/\s+/g, " ").trim() === "Delete all my data",
  );
  assert.equal(deleteButtons.length, 1);

  env.setConfirm(false);
  await act(async () => {
    deleteButtons[0].click();
  });
  assert.equal(deleted, 0);
  assert.equal(env.localMap.has("holdup.profile"), true);

  env.setConfirm(true);
  await act(async () => {
    deleteButtons[0].click();
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(deleted, 1);
  assert.equal(env.confirmPrompts.length, 2);
  for (const wipedKey of ["holdup.profile", "holdup.consent", "holdup.settings", "holdup.session", "holdup.hud.speak"]) {
    assert.equal(env.localMap.has(wipedKey), false, `Expected deleteAllData() to wipe ${wipedKey}`);
  }
  assert.equal(env.localMap.get("unrelated.app.preference"), "keep-me");
  assert.equal(env.sessionMap.size, 0);
  assert.equal(env.cacheBuckets.size, 0);

  await act(async () => {
    priv.buttonByText("Withdraw consent").click();
  });
  assert.equal(withdrew, 1);

  await priv.rerender(
    createElement(Privacy, {
      consent: null,
      onWithdraw: () => false,
      onReviewConsent: () => {
        reviewed++;
      },
      onDeleteAll: () => {},
    }),
  );
  assert.match(priv.text(), /Not given\. The camera stays off\./);
  await act(async () => {
    priv.buttonByText("Review and agree").click();
  });
  assert.equal(reviewed, 1);
  await priv.unmount();

  const privacyDoc = fs.readFileSync(PRIVACY_DOC_PATH, "utf8");
  const checkerSrc = fs.readFileSync(CHECKER_PATH, "utf8");
  const verifyServerSrc = fs.readFileSync(VERIFY_SERVER_PATH, "utf8");
  const hubServerSrc = fs.readFileSync(HUB_SERVER_PATH, "utf8");

  assert.match(privacyDoc, /auto-stops after 45 s/i);
  assert.match(checkerSrc, /AUTO_STOP_MS\s*=\s*45[_]?000/);

  assert.match(privacyDoc, /frame ring: last 8 frames/i);
  assert.match(privacyDoc, /memory-only\*\* ring buffer of the last 8 frames per session/i);
  assert.match(privacyDoc, /cleared when the phone disconnects and are never written to disk/i);
  assert.match(verifyServerSrc, /constructor\(private size = 8\)/);
  assert.match(hubServerSrc, /new FrameRing\(8\)/);

  assert.match(privacyDoc, /held only in server memory while the check runs \(up to 10 minutes for reconnects\)/i);
  assert.match(privacyDoc, /removed 10 minutes after its last activity with no phone connected/i);
  assert.match(privacyDoc, /kept in server memory for up to 10 minutes after the phone disconnects/i);
  assert.match(hubServerSrc, /10 \* 60_000/);

  assert.match(privacyDoc, /research prototype, not a CE-marked medical device/i);
  assert.match(privacyDoc, /\*\*Delete all my data\*\* \(Privacy tab\): removes every `holdup\.\*` key from `localStorage`, clears `sessionStorage` and the offline app cache/i);

  assert.match(privacyDoc, /ignore people and faces and never describe a person/i);
  assert.match(privacyDoc, /"I only help with labels"/);
  assert.match(privacyDoc, /The Display HUD's optional "Speak" toggle is off by default, because the glasses speaker can be heard by people nearby/i);
  assert.match(privacyDoc, /make \*\*no\*\* "not used for training" claim for this prototype/i);

  const combinedUiText = `${card1Text}\n${card2Text}\n${card3Text}\n${privText}`;
  assert.equal(/never used for training|not used to train/i.test(combinedUiText), false);
});

test("Hud.tsx bystander speaker privacy: holdup.hud.speak defaults to false (Speak off) and never speaks verdicts or Repeat aloud until opted in", async () => {
  const env = installEnv({
    "holdup.profile": JSON.stringify(fullPrivateProfile("en")),
  });
  assert.equal(env.localMap.has("holdup.hud.speak"), false);

  const { Hud } = await importHudFresh();
  const view = await mountElement(env.doc, createElement(Hud));

  const speakBtn = view.buttonByText("Speak");
  assert.equal(speakBtn.textContent.trim(), "Speak off");
  assert.equal(speakBtn.getAttribute("aria-pressed"), "false");
  assert.equal(env.localMap.get("holdup.hud.speak") ?? null, null);

  const ws = FakeWebSocket.instances[0];
  assert.ok(ws);
  await act(async () => {
    ws.serverOpen();
    ws.serverJson({
      type: "verdict",
      verdict: {
        level: "match",
        headline: "Amlodipine 5 mg",
        speech: "Yes, Amlodipine 5 mg, your evening pill. You have not taken it today.",
        read: makeRead("Norvasc", "amlodipine", "5 mg"),
        matchedMedId: "aml",
        reasons: ["matches saved evening schedule"],
        takenToday: false,
      } satisfies Verdict,
    });
  });

  assert.match(view.text(), /Amlodipine 5 mg/);
  assert.equal(env.spoken.length, 0);

  await act(async () => {
    view.buttonByText("Repeat").click();
  });
  assert.equal(env.spoken.length, 0);
  assert.deepEqual(
    ws.sent.map((raw) => JSON.parse(raw)),
    [{ type: "event", name: "repeat" }],
  );

  await view.unmount();
});

test("Hud.tsx Speak on utters ONLY level word + short headline and never leaks full prescription, allergy, avoid, note, barcode, or doseLog profile", async () => {
  const env = installEnv({
    "holdup.profile": JSON.stringify(fullPrivateProfile("fi")),
  });

  const { Hud } = await importHudFresh();
  const view = await mountElement(env.doc, createElement(Hud));
  const ws = FakeWebSocket.instances[0];
  assert.ok(ws);
  await act(async () => {
    ws.serverOpen();
  });

  const speakBtn = view.buttonByText("Speak");
  await act(async () => {
    speakBtn.click();
  });
  assert.equal(speakBtn.textContent.trim(), "Speak on");
  assert.equal(speakBtn.getAttribute("aria-pressed"), "true");
  assert.equal(env.localMap.get("holdup.hud.speak"), "1");

  const cases: Array<{ verdict: Verdict; expectedUtterance: string }> = [
    {
      verdict: {
        level: "match",
        headline: "Evening pill",
        speech: "Yes, Amlodipine 5 mg, your evening pill. Other meds on file: Warfarin 3 mg, Metformin 850 mg.",
        read: makeRead("Norvasc", "amlodipine", "5 mg"),
        matchedMedId: "aml",
        reasons: ["matched evening schedule"],
        takenToday: false,
      },
      expectedUtterance: "right one. Evening pill",
    },
    {
      verdict: {
        level: "warning",
        headline: "Avoid: Ibuprofen",
        speech: "Warning. This is Ibuprofen 400 mg. Your avoid list includes NSAIDs and grapefruit; allergies peanut, penicillin, shellfish.",
        read: makeRead("Burana", "ibuprofen", "400 mg"),
        reasons: ["avoid list NSAIDs; patient note Dr Korhonen"],
      },
      expectedUtterance: "check. Avoid: Ibuprofen",
    },
    {
      verdict: {
        level: "unsure",
        headline: "Strength unclear",
        speech: "I am not sure of the strength on this Metformin pack. Turn the box to show the side panel.",
        read: makeRead("Glucophage", "metformin", null),
        reasons: ["strength confidence 0.25 below 0.80"],
      },
      expectedUtterance: "not sure. Strength unclear",
    },
    {
      verdict: {
        level: "info",
        headline: "Oat drink",
        speech: "Oatly Oat Drink. Lists none of your peanut, penicillin, or shellfish allergies.",
        read: makeRead("Oatly", "oat drink", null),
        reasons: ["allergen panel read clearly"],
      },
      expectedUtterance: "info. Oat drink",
    },
  ];

  const leakedSecrets = [
    "Warfarin",
    "warfarin",
    "Metformin",
    "850 mg",
    "3 mg",
    "peanut",
    "penicillin",
    "shellfish",
    "grapefruit",
    "NSAIDs",
    "Korhonen",
    "INR",
    "6416542002149",
    "6416542009911",
    "1763190000123",
  ];

  for (const c of cases) {
    await act(async () => {
      ws.serverJson({ type: "verdict", verdict: c.verdict });
    });
    const last = env.spoken.at(-1);
    if (!last) throw new Error("Expected spoken utterance");
    assert.equal(last.text, c.expectedUtterance);
    assert.equal(last.lang, "fi-FI");
    for (const secret of leakedSecrets) {
      assert.equal(last.text.includes(secret), false, `HUD speaker leaked private detail: ${secret}`);
    }
  }

  env.localMap.set("holdup.profile", JSON.stringify(fullPrivateProfile("sv")));
  await act(async () => {
    view.buttonByText("Repeat").click();
  });
  assert.equal(env.spoken.at(-1)?.text, "Oat drink");
  assert.equal(env.spoken.at(-1)?.lang, "sv-SE");

  const cancelsBeforeToggleOff = env.cancelCount();
  await act(async () => {
    speakBtn.click();
  });
  assert.equal(speakBtn.textContent.trim(), "Speak off");
  assert.equal(speakBtn.getAttribute("aria-pressed"), "false");
  assert.equal(env.localMap.get("holdup.hud.speak"), "0");
  assert.ok(env.cancelCount() > cancelsBeforeToggleOff);

  await view.unmount();
});

test("Hud.tsx immediately calls speechSynthesis.cancel() on device.worn === false, Escape, and popstate", async () => {
  const env = installEnv({
    "holdup.profile": JSON.stringify(fullPrivateProfile("en")),
    "holdup.hud.speak": "1",
  });

  const { Hud } = await importHudFresh();
  const view = await mountElement(env.doc, createElement(Hud));
  const ws = FakeWebSocket.instances[0];
  assert.ok(ws);
  await act(async () => {
    ws.serverOpen();
  });

  const sampleVerdict: Verdict = {
    level: "match",
    headline: "Evening pill",
    speech: "Yes, Amlodipine 5 mg, your evening pill.",
    read: makeRead("Norvasc", "amlodipine", "5 mg"),
    matchedMedId: "aml",
    reasons: [],
    takenToday: false,
  };

  await act(async () => {
    ws.serverJson({ type: "verdict", verdict: sampleVerdict });
  });
  assert.equal(env.spoken.length, 1);
  assert.equal(env.spoken[0]?.lang, "en-US");
  assert.deepEqual(env.historyState(), { hudVerdict: 1 });

  const c0 = env.cancelCount();
  const wornTrue: DeviceState = { connected: true, worn: true, battery: 88, streaming: true, source: "glasses" };
  const wornUnknown = { connected: true, worn: null, battery: 88, streaming: true, source: "glasses" } as unknown as DeviceState;
  await act(async () => {
    ws.serverJson({ type: "device", device: wornTrue });
    ws.serverJson({ type: "device", device: wornUnknown });
  });
  assert.equal(env.cancelCount(), c0);

  const wornFalse: DeviceState = { connected: true, worn: false, battery: 86, streaming: false, source: "glasses" };
  await act(async () => {
    ws.serverJson({ type: "device", device: wornFalse });
  });
  assert.equal(env.cancelCount(), c0 + 1);
  assert.match(view.text(), /phone camera/);

  const cBeforeArrow = env.cancelCount();
  await act(async () => {
    env.dispatchKey("ArrowRight");
  });
  assert.equal(env.cancelCount(), cBeforeArrow);

  const cBeforeEscape = env.cancelCount();
  const backsBeforeEscape = env.backCount();
  await act(async () => {
    env.dispatchKey("Escape");
  });
  assert.equal(env.cancelCount(), cBeforeEscape + 1);
  assert.equal(env.backCount(), backsBeforeEscape + 1);
  assert.match(view.text(), /Hold it up\./);

  await act(async () => {
    ws.serverJson({ type: "verdict", verdict: sampleVerdict });
  });
  assert.match(view.text(), /Evening pill/);

  const cBeforePop = env.cancelCount();
  await act(async () => {
    env.dispatchPopState();
  });
  assert.equal(env.cancelCount(), cBeforePop + 1);
  assert.match(view.text(), /Hold it up\./);

  const cBeforeUnmount = env.cancelCount();
  await view.unmount();
  assert.equal(env.cancelCount(), cBeforeUnmount + 1);
});

test("bystanderConsentDisclosureParity.test.ts contains zero code comments and zero em dashes", () => {
  const selfPath = fileURLToPath(import.meta.url);
  const src = fs.readFileSync(selfPath, "utf8");
  assert.equal(src.includes("\x2f\x2f"), false);
  assert.equal(src.includes("\x2f*"), false);
  assert.equal(src.includes(String.fromCharCode(0x2014)), false);
});
