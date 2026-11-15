import { after, test } from "node:test";
import assert from "node:assert/strict";
import React, { StrictMode, act, createElement, useState } from "react";
import type { FeatureFlag, Med, Profile as ProfileType } from "../../shared/types.ts";
import type { Checker, CheckState } from "../src/lib/checker.ts";

const XHTML_NS = ["http:", "", "www.w3.org", "1999", "xhtml"].join("\x2f");
const ORIGIN = ["https:", "", "holdup.example"].join("\x2f");

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

type ListenerRecord = { fn: (ev: MiniEvent) => void; capture: boolean };

type MiniEvent = {
  type: string;
  key?: string;
  repeat?: boolean;
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

  get isConnected(): boolean {
    let cur: MiniNode | null = this;
    while (cur) {
      if (cur.nodeType === 9) return true;
      cur = cur.parentNode;
    }
    return false;
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
      if (this.ownerDocument?.activeElement && !this.ownerDocument.activeElement.isConnected) {
        this.ownerDocument.activeElement = this.ownerDocument.body;
      }
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
  private _selected = false;
  private _hasValue = false;
  private _value = "";
  width = 320;
  height = 240;
  readyState = 4;
  videoWidth = 640;
  videoHeight = 480;
  srcObject: unknown = null;
  scrollTop = 0;
  scrollHeight = 0;

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

  get selected(): boolean {
    return this._selected;
  }

  set selected(v: boolean) {
    this._selected = Boolean(v);
  }

  get options(): MiniElement[] {
    return this.findAll((el) => el.tagName === "OPTION");
  }

  get value(): string {
    return this._hasValue ? this._value : (this.attributes.get("value") ?? "");
  }

  set value(v: string) {
    this._hasValue = true;
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

  get open(): boolean {
    return this.attributes.has("open");
  }

  set open(value: boolean) {
    if (value) this.attributes.set("open", "");
    else this.attributes.delete("open");
  }

  showModal(): void {
    this.open = true;
  }

  close(): void {
    this.open = false;
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

  async play(): Promise<void> {}

  getContext(kind: string) {
    if (kind !== "2d") return null;
    return {
      drawImage() {},
      getImageData(_x: number, _y: number, w: number, h: number) {
        return { data: new Uint8ClampedArray(w * h * 4) };
      },
    };
  }

  toDataURL(): string {
    return "data:image\x2fjpeg;base64,AA==";
  }

  closest(selector: string): MiniElement | null {
    const targets = selector.split(",").map((s) => s.trim().toUpperCase());
    let cur: MiniNode | null = this;
    while (cur && cur.nodeType === 1) {
      const el = cur as MiniElement;
      if (targets.includes(el.tagName)) return el;
      cur = cur.parentNode;
    }
    return null;
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
    for (let i = path.length - 1; i >= 1; i--) {
      const node = path[i] as MiniElement | MiniDocument;
      ev.currentTarget = node;
      for (const rec of node.listeners?.get(ev.type) ?? []) {
        if (rec.capture) rec.fn(ev);
      }
    }
    ev.currentTarget = this;
    for (const rec of this.listeners.get(ev.type) ?? []) {
      rec.fn(ev);
    }
    if (ev.bubbles !== false) {
      for (let i = 1; i < path.length; i++) {
        const node = path[i] as MiniElement | MiniDocument;
        ev.currentTarget = node;
        for (const rec of node.listeners?.get(ev.type) ?? []) {
          if (!rec.capture) rec.fn(ev);
        }
      }
    }
    if (ev.type === "keydown" && ev.key === "Escape" && !ev.defaultPrevented) {
      const dialog = this.closest("dialog");
      if (dialog && dialog.open) {
        const cancelEv = makeEvent("cancel", { bubbles: false, cancelable: true });
        const notPrevented = dialog.dispatchEvent(cancelEv);
        if (notPrevented) dialog.close();
      }
    }
    return !ev.defaultPrevented;
  }

  click(): void {
    if (this.disabled) return;
    if (this.tagName === "INPUT" && (this.type === "checkbox" || this.type === "radio")) {
      this._checked = !this._checked;
      if (this._checked) this.attributes.set("checked", "");
      else this.attributes.delete("checked");
    }
    const clickEv = makeEvent("click");
    const notPrevented = this.dispatchEvent(clickEv);
    if (notPrevented && this.tagName === "BUTTON") {
      const btnType = (this.type || "submit").toLowerCase();
      if (btnType === "submit") {
        const form = this.closest("form");
        if (form) form.dispatchEvent(makeEvent("submit", { bubbles: true, cancelable: true }));
      }
    }
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
  visibilityState: "visible" | "hidden" = "visible";
  title = "";
  oninput: unknown = null;
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

class FakeMediaTrack {
  kind: "video" | "audio";
  readyState: "live" | "ended" = "live";

  constructor(kind: "video" | "audio") {
    this.kind = kind;
  }

  stop(): void {
    this.readyState = "ended";
  }

  addEventListener(): void {}
}

class FakeMediaStream {
  private tracks: FakeMediaTrack[];

  constructor(tracks: FakeMediaTrack[]) {
    this.tracks = tracks;
  }

  getTracks(): FakeMediaTrack[] {
    return [...this.tracks];
  }

  getVideoTracks(): FakeMediaTrack[] {
    return this.tracks.filter((t) => t.kind === "video");
  }

  getAudioTracks(): FakeMediaTrack[] {
    return this.tracks.filter((t) => t.kind === "audio");
  }
}

class FakeAudioContext {
  state: "running" | "suspended" | "closed" = "running";
  currentTime = 0;
  destination = {};
  audioWorklet = {
    async addModule(): Promise<void> {},
  };

  async resume(): Promise<void> {
    if (this.state !== "closed") this.state = "running";
  }

  async close(): Promise<void> {
    this.state = "closed";
  }

  createMediaStreamSource() {
    return { connect: (dest: unknown) => dest, disconnect() {} };
  }

  createGain() {
    return {
      gain: {
        value: 0,
        setValueAtTime() {},
        linearRampToValueAtTime() {},
        exponentialRampToValueAtTime() {},
        setTargetAtTime() {},
        cancelScheduledValues() {},
      },
      connect: (dest: unknown) => dest,
      disconnect() {},
    };
  }

  createOscillator() {
    return {
      type: "sine",
      frequency: { value: 440, setTargetAtTime() {} },
      connect: (dest: unknown) => dest,
      disconnect() {},
      start() {},
      stop() {},
    };
  }

  createBiquadFilter() {
    return {
      type: "lowpass",
      frequency: { value: 1200 },
      connect: (dest: unknown) => dest,
      disconnect() {},
    };
  }

  createBuffer(_channels: number, samples: number, sampleRate: number) {
    return {
      duration: samples / sampleRate,
      getChannelData: () => new Float32Array(samples),
    };
  }

  createBufferSource() {
    return {
      buffer: null as unknown,
      onended: null as (() => void) | null,
      connect: (dest: unknown) => dest,
      disconnect() {},
      start() {},
      stop() {},
    };
  }
}

class FakeSpeechSynthesisUtterance {
  text: string;
  lang = "";
  rate = 1;
  volume = 1;

  constructor(text: string) {
    this.text = text;
  }
}

let barcodeDetections: Array<{ rawValue: string; format: string }> = [];

class MockBarcodeDetector {
  async detect() {
    return barcodeDetections;
  }

  static async getSupportedFormats() {
    return ["ean_13", "data_matrix", "qr_code"];
  }
}

function makeMapStorage(backing: Map<string, string>): Storage {
  return {
    get length(): number {
      return backing.size;
    },
    key(index: number): string | null {
      return Array.from(backing.keys())[index] ?? null;
    },
    getItem(key: string): string | null {
      return backing.has(key) ? backing.get(key)! : null;
    },
    setItem(key: string, value: string): void {
      backing.set(key, String(value));
    },
    removeItem(key: string): void {
      backing.delete(key);
    },
    clear(): void {
      backing.clear();
    },
  } as Storage;
}

const doc = new MiniDocument();
const storageBacking = new Map<string, string>();
const sessionBacking = new Map<string, string>();
let confirmResult = true;
let requiredServerKey: string | null = null;

const loc = {
  origin: ORIGIN,
  protocol: "https:",
  host: "holdup.example",
  pathname: "\x2f",
  search: "",
  hash: "",
};

const hist = {
  state: null as unknown,
  replaceState(data: unknown, _unused: string, url?: string | URL | null) {
    hist.state = data;
    if (typeof url === "string") {
      const qIdx = url.indexOf("?");
      const hIdx = url.indexOf("#");
      loc.search = qIdx >= 0 ? url.slice(qIdx, hIdx >= 0 ? hIdx : undefined) : "";
    }
  },
  pushState() {},
  back() {},
};

const navigatorShim = {
  language: "en-US",
  onLine: true,
  userAgent: "Mozilla\x2f5.0 (Linux; Android 14) Chrome\x2f130.0.0.0",
  vibrate: () => true,
  mediaDevices: {
    async getUserMedia(constraints: { video?: unknown; audio?: unknown }) {
      const tracks: FakeMediaTrack[] = [];
      if (constraints.video) tracks.push(new FakeMediaTrack("video"));
      if (constraints.audio) tracks.push(new FakeMediaTrack("audio"));
      return new FakeMediaStream(tracks);
    },
    async enumerateDevices() {
      return [{ kind: "audiooutput", label: "Phone speaker" }];
    },
    addEventListener() {},
    removeEventListener() {},
  },
  permissions: {
    async query() {
      return { state: "granted" };
    },
  },
  mediaSession: {
    metadata: null as unknown,
    playbackState: "none",
    setActionHandler() {},
  },
};

const fetchShim = async (input: unknown, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  const headers = (init?.headers ?? {}) as Record<string, string>;
  if (url.includes("\x2fapi\x2fhealth")) {
    return new Response(JSON.stringify({ ok: true, gemini: "ok" }), {
      status: 200,
      headers: { "content-type": "application\x2fjson" },
    });
  }
  if (url.includes("\x2fapi\x2fstats")) {
    if (requiredServerKey !== null) {
      const provided = headers["x-holdup-key"];
      if (!provided) {
        return new Response(JSON.stringify({ message: "Access key required" }), {
          status: 401,
          headers: { "content-type": "application\x2fjson" },
        });
      }
      if (provided !== requiredServerKey) {
        return new Response(JSON.stringify({ message: "Wrong access key" }), {
          status: 403,
          headers: { "content-type": "application\x2fjson" },
        });
      }
    }
    return new Response(JSON.stringify({ calls: 0 }), {
      status: 200,
      headers: { "content-type": "application\x2fjson" },
    });
  }
  return new Response("{}", {
    status: 200,
    headers: { "content-type": "application\x2fjson" },
  });
};

const windowListeners = new Map<string, Array<(ev: MiniEvent) => void>>();
const windowShim: Record<string, unknown> = {
  isSecureContext: true,
  document: doc,
  navigator: navigatorShim,
  location: loc,
  history: hist,
  AudioContext: FakeAudioContext,
  BarcodeDetector: MockBarcodeDetector,
  HTMLInputElement: MiniElement,
  HTMLElement: MiniElement,
  HTMLIFrameElement: class {},
  speechSynthesis: {
    cancel() {},
    speak() {},
  },
  confirm(): boolean {
    return confirmResult;
  },
  addEventListener(type: string, fn: (ev: MiniEvent) => void) {
    const list = windowListeners.get(type) ?? [];
    list.push(fn);
    windowListeners.set(type, list);
  },
  removeEventListener(type: string, fn: (ev: MiniEvent) => void) {
    const list = windowListeners.get(type);
    if (!list) return;
    windowListeners.set(
      type,
      list.filter((f) => f !== fn),
    );
  },
  dispatchEvent(ev: MiniEvent) {
    for (const fn of windowListeners.get(ev.type) ?? []) fn(ev);
    return !ev.defaultPrevented;
  },
};
doc.defaultView = windowShim;

setGlobal("window", windowShim);
setGlobal("document", doc);
setGlobal("navigator", navigatorShim);
setGlobal("location", loc);
setGlobal("history", hist);
setGlobal("localStorage", makeMapStorage(storageBacking));
setGlobal("sessionStorage", makeMapStorage(sessionBacking));
setGlobal("confirm", () => confirmResult);
setGlobal("fetch", fetchShim);
setGlobal("AudioContext", FakeAudioContext);
setGlobal("SpeechSynthesisUtterance", FakeSpeechSynthesisUtterance);
setGlobal("HTMLInputElement", MiniElement);
setGlobal("HTMLElement", MiniElement);

const { createRoot } = await import("react-dom/client");

const protoVal = Object.getOwnPropertyDescriptor(MiniElement.prototype, "value")!;
function setInputValue(el: MiniElement, value: string): void {
  protoVal.set!.call(el, value);
  el.dispatchEvent(makeEvent("input", { bubbles: true }));
}

const keyMod = await import("../src/lib/key.ts");
const storageMod = await import("../src/lib/storage.ts");
const verdictsMod = await import("../src/lib/verdicts.ts");
const profileMod = await import("../src/screens/Profile.tsx");
const addSheetMod = await import("../src/components/AddSheet.tsx");
const liveScreenMod = await import("../src/screens/Live.tsx");

const { clearAccessKey, setAccessKey } = keyMod;
const { demoProfile, loadSettings, saveConsent, saveProfile, saveSettings } = storageMod;
const { matchVerdict } = verdictsMod;
const { Profile } = profileMod;
const { AddSheet } = addSheetMod;
const { Live } = liveScreenMod;

type AppModule = typeof import("../src/App.tsx");

async function loadFreshApp(tag: string): Promise<AppModule> {
  const href = new URL(`../src/App.tsx?case=${tag}`, import.meta.url).href;
  return (await import(href)) as AppModule;
}

async function flushAsync(ms = 0): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
  if (ms > 0) await new Promise<void>((resolve) => setTimeout(resolve, ms));
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

function resetHarness(): void {
  storageBacking.clear();
  sessionBacking.clear();
  barcodeDetections = [];
  confirmResult = true;
  requiredServerKey = null;
  loc.search = "";
  loc.pathname = "\x2f";
  loc.hash = "";
  doc.body.childNodes = [];
  doc.activeElement = null;
  doc.title = "";
  clearAccessKey();
}

async function mountElement(t: test.TestContext, element: React.ReactElement) {
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  let mounted = true;

  await act(async () => {
    root.render(element);
    await flushAsync(10);
  });

  const unmount = async () => {
    if (!mounted) return;
    mounted = false;
    await act(async () => {
      root.unmount();
    });
  };
  t.after(async () => {
    await unmount();
  });

  return {
    container,
    rerender: async (next: React.ReactElement) => {
      await act(async () => {
        root.render(next);
        await flushAsync(10);
      });
    },
    html: () => container.innerHTML,
    text: () => decodeHtml(container.innerHTML),
    byId: (id: string): MiniElement => {
      const el = container.findAll((n) => n.id === id)[0];
      assert.ok(el, `Expected element #${id}`);
      return el;
    },
    buttonByText: (label: string): MiniElement => {
      const btn = container.findAll((n) => n.tagName === "BUTTON" && n.textContent.trim() === label)[0];
      assert.ok(btn, `Expected button "${label}"`);
      return btn;
    },
    buttonByAriaLabel: (label: string): MiniElement => {
      const btn = container.findAll((n) => n.tagName === "BUTTON" && n.getAttribute("aria-label") === label)[0];
      assert.ok(btn, `Expected button with aria-label="${label}"`);
      return btn;
    },
    unmount,
  };
}

function makeCheckState(overrides: Partial<CheckState> = {}): CheckState {
  return {
    running: true,
    mode: "live",
    conn: "open",
    connAttempt: 0,
    nextRetryMs: null,
    serverLive: "open",
    serverDetail: "",
    model: "gemini-3.8-live",
    session: "F0C5",
    online: true,
    health: "ok",
    rtt: 90,
    policy: { fps: 1, quality: 0.7, longSide: 768, tier: "normal" },
    fps: 1,
    framesSent: 3,
    camera: "on",
    cameraPerm: "granted",
    cameraMsg: "",
    mic: "on",
    micPerm: "granted",
    micMsg: "",
    micLabel: "Phone mic",
    micLevel: 0,
    route: "Phone speaker",
    source: "phone",
    device: null,
    captions: [],
    cue: null,
    verdict: null,
    verdictVia: null,
    autoStopAt: null,
    snapshotBusy: false,
    checking: false,
    hudConnected: null,
    authNeeded: false,
    speaking: false,
    sharpness: 0.7,
    serverFeatures: ["scene", "datamatrix", "addmed", "sonar"],
    lastCode: null,
    readiness: null,
    addProposal: null,
    banner: null,
    lastError: null,
    hidden: false,
    ...overrides,
  };
}

function createInteractiveChecker(initialOverrides: Partial<CheckState> = {}) {
  let state = makeCheckState(initialOverrides);
  const subs = new Set<() => void>();
  const enabled = new Set<FeatureFlag>(["scene", "datamatrix", "addmed", "sonar"]);

  const setState = (patch: Partial<CheckState>) => {
    state = { ...state, ...patch };
    for (const fn of subs) fn();
  };

  const checker = {
    subscribe: (fn: () => void) => {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
    get: () => state,
    attachVideo() {},
    primary() {},
    start: async () => {},
    stop: async () => {},
    snapshot: async () => {},
    offlineCheckImage: async () => {},
    backToLive() {},
    repeat() {},
    logDose() {},
    dismissVerdict() {
      setState({ verdict: null });
    },
    setSource: async () => {},
    sendText() {},
    answerProposal() {
      setState({ addProposal: null });
    },
    feature: (flag: FeatureFlag) => enabled.has(flag),
    simulateDrop() {},
    injectCode() {},
    toggleSnapshotMode() {},
  } as unknown as Checker;

  return { checker, setState, getState: () => state };
}

test("Profile -> Add medicine / Edit -> MedEditor focuses #m-name; Cancel, Save, and Escape restore opener; Remove restores Add medicine fallback", async (t) => {
  resetHarness();
  const initial = demoProfile();
  saveProfile(initial);

  function ProfileHost() {
    const [p, setP] = useState<ProfileType>(initial);
    return createElement(Profile, { profile: p, onChange: setP });
  }

  const ui = await mountElement(t, createElement(ProfileHost));
  const addMedBtn = ui.buttonByText("Add medicine");

  addMedBtn.focus();
  assert.equal(doc.activeElement, addMedBtn);

  await act(async () => {
    addMedBtn.click();
    await flushAsync();
  });

  const dialog1 = ui.container.findAll((el) => el.tagName === "DIALOG")[0];
  assert.ok(dialog1?.open, "Expected MedEditor dialog open");
  const nameInput1 = ui.byId("m-name");
  assert.equal(doc.activeElement, nameInput1, "MedEditor must focus #m-name on open");

  await act(async () => {
    ui.buttonByText("Cancel").click();
    await flushAsync();
  });
  assert.equal(ui.container.findAll((el) => el.tagName === "DIALOG").length, 0);
  assert.equal(doc.activeElement, addMedBtn, "Cancel must restore focus to Add medicine opener");

  addMedBtn.focus();
  await act(async () => {
    addMedBtn.click();
    await flushAsync();
  });
  assert.equal(doc.activeElement, ui.byId("m-name"));

  await act(async () => {
    setInputValue(ui.byId("m-name"), "Colecalciferol");
    setInputValue(ui.byId("m-str"), "20 mcg");
    await flushAsync();
  });
  await act(async () => {
    ui.buttonByText("Save").click();
    await flushAsync();
  });
  assert.equal(ui.container.findAll((el) => el.tagName === "DIALOG").length, 0);
  assert.ok(ui.text().includes("Colecalciferol"));
  assert.equal(doc.activeElement, addMedBtn, "Save from Add medicine must restore focus to Add medicine opener");

  const editMetforminBtn = ui.buttonByAriaLabel("Edit Metformin 500 mg");
  editMetforminBtn.focus();
  await act(async () => {
    editMetforminBtn.click();
    await flushAsync();
  });
  const nameInputEsc = ui.byId("m-name");
  assert.equal(doc.activeElement, nameInputEsc);
  assert.equal(nameInputEsc.value, "Metformin");

  await act(async () => {
    nameInputEsc.dispatchEvent(makeEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await flushAsync();
  });
  assert.equal(ui.container.findAll((el) => el.tagName === "DIALOG").length, 0);
  assert.equal(doc.activeElement, editMetforminBtn, "Escape onCancel must restore focus to Edit opener");

  const editAmlodipineBtn = ui.buttonByAriaLabel("Edit Amlodipine 5 mg");
  editAmlodipineBtn.focus();
  await act(async () => {
    editAmlodipineBtn.click();
    await flushAsync();
  });
  assert.equal(doc.activeElement, ui.byId("m-name"));

  await act(async () => {
    setInputValue(ui.byId("m-notes"), "Take with water");
    await flushAsync();
  });
  await act(async () => {
    ui.buttonByText("Save").click();
    await flushAsync();
  });
  assert.equal(ui.container.findAll((el) => el.tagName === "DIALOG").length, 0);
  assert.equal(doc.activeElement, editAmlodipineBtn, "Save on Edit must restore focus to Edit opener");

  editMetforminBtn.focus();
  await act(async () => {
    editMetforminBtn.click();
    await flushAsync();
  });
  assert.equal(doc.activeElement, ui.byId("m-name"));

  confirmResult = false;
  await act(async () => {
    ui.buttonByText("Remove").click();
    await flushAsync();
  });
  assert.equal(ui.container.findAll((el) => el.tagName === "DIALOG").length, 1, "Declining confirm keeps MedEditor open");

  confirmResult = true;
  await act(async () => {
    ui.buttonByText("Remove").click();
    await flushAsync();
  });
  assert.equal(ui.container.findAll((el) => el.tagName === "DIALOG").length, 0);
  assert.equal(editMetforminBtn.isConnected, false, "Deleted medicine Edit button must be disconnected");
  assert.equal(doc.activeElement, addMedBtn, "Remove must fall back to Add medicine button when Edit opener unmounts");
});

test("MedEditor -> BarcodeScanner focuses Cancel scan on mount and restores Scan and Scan pack code buttons on close and onResult", async (t) => {
  resetHarness();
  saveSettings({
    ...loadSettings(),
    features: { ...loadSettings().features, datamatrix: true },
  });
  const initial = demoProfile();

  function ProfileHost() {
    const [p, setP] = useState<ProfileType>(initial);
    return createElement(Profile, { profile: p, onChange: setP });
  }

  const ui = await mountElement(t, createElement(ProfileHost));
  const addMedBtn = ui.buttonByText("Add medicine");
  addMedBtn.focus();
  await act(async () => {
    addMedBtn.click();
    await flushAsync();
  });

  const scanBtn = ui.buttonByText("Scan");
  assert.equal(scanBtn.disabled, false);
  scanBtn.focus();
  await act(async () => {
    scanBtn.click();
    await flushAsync(20);
  });

  const cancelScan1 = ui.buttonByText("Cancel scan");
  assert.equal(doc.activeElement, cancelScan1, "BarcodeScanner must focus Cancel scan on mount");

  await act(async () => {
    cancelScan1.click();
    await flushAsync();
  });
  assert.equal(ui.container.findAll((el) => el.getAttribute("aria-label") === "Barcode scanner").length, 0);
  assert.equal(doc.activeElement, scanBtn, "Closing BarcodeScanner must restore focus to Scan button");

  barcodeDetections = [{ rawValue: "6416542002149", format: "ean_13" }];
  scanBtn.focus();
  await act(async () => {
    scanBtn.click();
    await flushAsync(20);
  });
  assert.equal(doc.activeElement, ui.buttonByText("Cancel scan"));

  await act(async () => {
    await flushAsync(350);
  });
  assert.equal(ui.container.findAll((el) => el.getAttribute("aria-label") === "Barcode scanner").length, 0);
  assert.equal(ui.byId("m-bc").value, "6416542002149");
  assert.equal(doc.activeElement, scanBtn, "BarcodeScanner onResult must restore focus to Scan button");

  barcodeDetections = [];
  const scanPackBtn = ui.buttonByText("Scan pack code");
  assert.equal(scanPackBtn.disabled, false);
  scanPackBtn.focus();
  await act(async () => {
    scanPackBtn.click();
    await flushAsync(20);
  });

  const cancelScan2 = ui.buttonByText("Cancel scan");
  assert.equal(doc.activeElement, cancelScan2, "Pack scanner must focus Cancel scan on mount");

  await act(async () => {
    cancelScan2.click();
    await flushAsync();
  });
  assert.equal(doc.activeElement, scanPackBtn, "Closing pack scanner must restore focus to Scan pack code button");

  barcodeDetections = [{ rawValue: "]d201064165420021491727083110A1234", format: "data_matrix" }];
  scanPackBtn.focus();
  await act(async () => {
    scanPackBtn.click();
    await flushAsync(20);
  });
  assert.equal(doc.activeElement, ui.buttonByText("Cancel scan"));

  await act(async () => {
    await flushAsync(350);
  });
  assert.equal(ui.container.findAll((el) => el.getAttribute("aria-label") === "Barcode scanner").length, 0);
  assert.equal(ui.byId("m-gtin").value, "06416542002149");
  assert.equal(doc.activeElement, scanPackBtn, "Pack scanner onResult must restore focus to Scan pack code button");
});

test("AddSheet focuses Add on open and restores prior focused element on Add, Cancel, Escape, and unmount", async (t) => {
  resetHarness();
  const sampleMed: Med = {
    id: "lisinopril",
    name: "Lisinopril",
    ingredient: "lisinopril",
    strength: "10 mg",
    schedule: ["morning"],
    gtin: "06416542005218",
  };
  const answers: boolean[] = [];

  function SheetHarness({ open, showOpener = true }: { open: boolean; showOpener?: boolean }) {
    return createElement(
      "div",
      null,
      showOpener ? createElement("button", { id: "prior-focus", type: "button" }, "Prior trigger") : null,
      createElement("button", { id: "other-focus", type: "button" }, "Other control"),
      open
        ? createElement(AddSheet, {
            med: sampleMed,
            speech: "Add Lisinopril 10 mg?",
            expiresAt: Date.now() + 60_000,
            onAnswer: (accepted) => answers.push(accepted),
          })
        : null,
    );
  }

  const ui = await mountElement(t, createElement(SheetHarness, { open: false }));
  const priorBtn = ui.byId("prior-focus");

  priorBtn.focus();
  assert.equal(doc.activeElement, priorBtn);
  await ui.rerender(createElement(SheetHarness, { open: true }));
  const addBtn1 = ui.buttonByText("Add");
  assert.equal(doc.activeElement, addBtn1, "AddSheet must move focus to Add button on mount");

  await act(async () => {
    addBtn1.click();
  });
  assert.deepEqual(answers, [true]);
  await ui.rerender(createElement(SheetHarness, { open: false }));
  assert.equal(doc.activeElement, priorBtn, "AddSheet must restore prior focus after Add closes sheet");

  priorBtn.focus();
  await ui.rerender(createElement(SheetHarness, { open: true }));
  assert.equal(doc.activeElement, ui.buttonByText("Add"));

  await act(async () => {
    ui.buttonByText("Cancel").click();
  });
  assert.deepEqual(answers, [true, false]);
  await ui.rerender(createElement(SheetHarness, { open: false }));
  assert.equal(doc.activeElement, priorBtn, "AddSheet must restore prior focus after Cancel closes sheet");

  priorBtn.focus();
  await ui.rerender(createElement(SheetHarness, { open: true }));
  const addBtnEsc = ui.buttonByText("Add");
  assert.equal(doc.activeElement, addBtnEsc);

  await act(async () => {
    addBtnEsc.dispatchEvent(makeEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  assert.deepEqual(answers, [true, false, false]);
  await ui.rerender(createElement(SheetHarness, { open: false }));
  assert.equal(doc.activeElement, priorBtn, "AddSheet must restore prior focus after Escape closes sheet");

  priorBtn.focus();
  await ui.rerender(createElement(SheetHarness, { open: true }));
  assert.equal(doc.activeElement, ui.buttonByText("Add"));
  await ui.rerender(createElement(SheetHarness, { open: false }));
  assert.equal(doc.activeElement, priorBtn, "AddSheet must restore prior focus on direct unmount");

  priorBtn.focus();
  await ui.rerender(createElement(SheetHarness, { open: true, showOpener: true }));
  assert.equal(doc.activeElement, ui.buttonByText("Add"));
  await ui.rerender(createElement(SheetHarness, { open: false, showOpener: false }));
  assert.equal(priorBtn.isConnected, false);
  assert.notEqual(doc.activeElement, priorBtn, "AddSheet must not focus detached element");
});

test("Live -> VerdictCard focuses #verdict-h on arrival and restores .bigbtn focus on Dismiss", async (t) => {
  resetHarness();
  const profile = demoProfile();
  const { checker, setState, getState } = createInteractiveChecker({ running: true, mode: "live", verdict: null });

  const ui = await mountElement(
    t,
    createElement(Live, {
      checker,
      consented: true,
      onReviewConsent: () => {},
      onFixPermissions: () => {},
    }),
  );

  const bigBtn = ui.container.findAll((el) => el.tagName === "BUTTON" && el.className.includes("bigbtn"))[0];
  assert.ok(bigBtn, "Expected primary .bigbtn");

  const firstVerdict = matchVerdict(profile, profile.meds[0]);
  await act(async () => {
    setState({ verdict: firstVerdict, verdictVia: "live" });
    await flushAsync();
  });

  const verdictHeading1 = ui.byId("verdict-h");
  assert.equal(verdictHeading1.textContent, "Amlodipine 5 mg");
  assert.equal(doc.activeElement, verdictHeading1, "New verdict must focus #verdict-h");

  const dismissBtn1 = ui.buttonByText("Dismiss");
  dismissBtn1.focus();
  assert.equal(doc.activeElement, dismissBtn1);

  await act(async () => {
    dismissBtn1.click();
    await flushAsync();
  });

  assert.equal(getState().verdict, null, "Dismiss must call checker.dismissVerdict()");
  assert.equal(ui.container.findAll((el) => el.id === "verdict-h").length, 0);
  assert.equal(doc.activeElement, bigBtn, "Dismissing VerdictCard must restore focus to .bigbtn instead of document.body");

  const secondVerdict = matchVerdict(profile, profile.meds[1]);
  await act(async () => {
    setState({ verdict: secondVerdict, verdictVia: "snapshot" });
    await flushAsync();
  });

  const verdictHeading2 = ui.byId("verdict-h");
  assert.equal(verdictHeading2.textContent, "Metformin 500 mg");
  assert.equal(doc.activeElement, verdictHeading2, "Subsequent verdict must focus #verdict-h");

  await act(async () => {
    ui.buttonByText("Dismiss").click();
    await flushAsync();
  });
  assert.equal(doc.activeElement, bigBtn, "Second Dismiss must also restore focus to .bigbtn");
});

test("AccessKey + App auth gate sets document.title to Access key needed, wires #key-lede + aria-invalid when had is true, and restores h1 focus and title when authNeeded clears", async (t) => {
  resetHarness();
  saveConsent();
  requiredServerKey = "junction-valid-key";

  const { App } = await loadFreshApp("auth-focus-title-flow");
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
  });

  await act(async () => {
    root.render(createElement(App));
    await flushAsync(30);
  });

  assert.equal(doc.title, "Access key needed \u00b7 HoldUp");
  const accessH1 = container.findAll((el) => el.tagName === "H1")[0];
  assert.ok(accessH1);
  assert.equal(accessH1.textContent.trim(), "Access key needed");
  assert.equal(doc.activeElement, accessH1, "AccessKey must focus its h1 on mount");

  const ledeFresh = container.findAll((el) => el.id === "key-lede")[0];
  assert.ok(ledeFresh, "Expected <p id=\"key-lede\">");
  assert.ok(ledeFresh.textContent.includes("This HoldUp server only lets in people who have its private link."));

  const keyInputFresh = container.findAll((el) => el.id === "key")[0];
  assert.ok(keyInputFresh, "Expected <input id=\"key\">");
  assert.equal(keyInputFresh.getAttribute("aria-describedby"), "key-lede");
  assert.equal(keyInputFresh.getAttribute("aria-invalid"), null, "Fresh AccessKey prompt must omit aria-invalid");

  await act(async () => {
    setInputValue(keyInputFresh, "wrong-attempt");
    await flushAsync();
  });
  const submitFresh = container.findAll((el) => el.tagName === "BUTTON" && el.textContent.trim() === "Save and try again")[0];
  assert.ok(submitFresh);
  assert.equal(submitFresh.disabled, false);

  await act(async () => {
    submitFresh.click();
    await flushAsync(30);
  });

  assert.equal(doc.title, "Access key needed \u00b7 HoldUp");
  const ledeRejected = container.findAll((el) => el.id === "key-lede")[0];
  assert.ok(ledeRejected);
  assert.ok(ledeRejected.textContent.includes("The access key saved on this phone wasn't accepted."));

  const keyInputRejected = container.findAll((el) => el.id === "key")[0];
  assert.ok(keyInputRejected);
  assert.equal(keyInputRejected.getAttribute("aria-describedby"), "key-lede");
  assert.equal(keyInputRejected.getAttribute("aria-invalid"), "true", "Rejected key prompt (had=true) must expose aria-invalid=\"true\"");

  await act(async () => {
    setInputValue(keyInputRejected, "junction-valid-key");
    await flushAsync();
  });
  const submitValid = container.findAll((el) => el.tagName === "BUTTON" && el.textContent.trim() === "Save and try again")[0];
  assert.ok(submitValid);

  await act(async () => {
    submitValid.click();
    await flushAsync(30);
  });

  assert.equal(doc.title, "Check \u00b7 HoldUp", "Clearing authNeeded must restore Check document.title");
  const checkH1 = container.findAll((el) => el.tagName === "H1")[0];
  assert.ok(checkH1);
  assert.equal(checkH1.textContent.trim(), "Check a label");
  assert.equal(doc.activeElement, checkH1, "Clearing authNeeded must move focus back to screen h1");

  const profileTab = container.findAll((el) => el.tagName === "BUTTON" && el.textContent.trim() === "Profile")[0];
  assert.ok(profileTab);
  await act(async () => {
    profileTab.click();
    await flushAsync(10);
  });
  assert.equal(doc.title, "Profile \u00b7 HoldUp");
  const profileH1 = container.findAll((el) => el.tagName === "H1")[0];
  assert.equal(profileH1?.textContent.trim(), "Profile");
  assert.equal(doc.activeElement, profileH1);

  setAccessKey("expired-key");
  assert.equal(localStorage.getItem("holdup.key"), "expired-key");
  clearAccessKey();
});

test("StrictMode double-effect lifecycle preserves focus restoration across MedEditor, BarcodeScanner, and AddSheet", async (t) => {
  resetHarness();
  const initial = demoProfile();

  function StrictProfileHost() {
    const [p, setP] = useState<ProfileType>(initial);
    const [sheetOpen, setSheetOpen] = useState(false);
    return createElement(
      StrictMode,
      null,
      createElement("button", { id: "strict-sheet-btn", type: "button", onClick: () => setSheetOpen(true) }, "Open proposal"),
      sheetOpen
        ? createElement(AddSheet, {
            med: initial.meds[0],
            speech: "Add Amlodipine 5 mg?",
            expiresAt: Date.now() + 60_000,
            onAnswer: () => setSheetOpen(false),
          })
        : null,
      createElement(Profile, { profile: p, onChange: setP }),
    );
  }

  const ui = await mountElement(t, createElement(StrictProfileHost));
  const editAtorva = ui.buttonByAriaLabel("Edit Atorvastatin 20 mg");
  editAtorva.focus();
  await act(async () => {
    editAtorva.click();
    await flushAsync();
  });
  assert.equal(doc.activeElement, ui.byId("m-name"));

  const scanBtn = ui.buttonByText("Scan");
  scanBtn.focus();
  await act(async () => {
    scanBtn.click();
    await flushAsync(20);
  });
  assert.equal(doc.activeElement, ui.buttonByText("Cancel scan"));

  await act(async () => {
    ui.buttonByText("Cancel scan").click();
    await flushAsync();
  });
  assert.equal(doc.activeElement, scanBtn);

  await act(async () => {
    ui.buttonByText("Cancel").click();
    await flushAsync();
  });
  assert.equal(doc.activeElement, editAtorva);

  const sheetBtn = ui.byId("strict-sheet-btn");
  sheetBtn.focus();
  await act(async () => {
    sheetBtn.click();
    await flushAsync();
  });
  assert.equal(doc.activeElement, ui.buttonByText("Add"));

  await act(async () => {
    ui.buttonByText("Cancel").click();
    await flushAsync();
  });
  assert.equal(doc.activeElement, sheetBtn);
});

