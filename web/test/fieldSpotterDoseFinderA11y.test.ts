import { after, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { ClientMsg, FeatureFlag, Field, LabelRead, SceneItem, ServerMsg, Verdict } from "../../shared/types.ts";
import type { Checker as CheckerType, CheckState } from "../src/lib/checker.ts";

const SLASH = "\x2f";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const STYLES_PATH = path.resolve(HERE, "..", "src", "styles.css");
const XHTML_NS = ["http:", "", "www.w3.org", "1999", "xhtml"].join(SLASH);
const ORIGIN_HTTPS = ["https:", "", "holdup.example"].join(SLASH);

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

type ListenerFn = (...args: unknown[]) => unknown;

function makeEventMap() {
  const map = new Map<string, Set<ListenerFn>>();
  return {
    add(type: string, fn: ListenerFn) {
      let set = map.get(type);
      if (!set) {
        set = new Set();
        map.set(type, set);
      }
      set.add(fn);
    },
    remove(type: string, fn: ListenerFn) {
      map.get(type)?.delete(fn);
    },
    emit(type: string, ev: unknown = {}) {
      for (const fn of Array.from(map.get(type) ?? [])) fn(ev);
    },
    clear() {
      map.clear();
    },
  };
}

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

type ListenerRecord = { fn: (ev: MiniEvent) => void; capture: boolean };

function matchesSimpleSelector(el: MiniElement, rawSelector: string): boolean {
  const selectors = rawSelector
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const sel of selectors) {
    if (sel.startsWith(".")) {
      const cls = sel.slice(1);
      if (el.className.split(/\s+/).includes(cls)) return true;
    } else if (sel.startsWith("#")) {
      if (el.id === sel.slice(1)) return true;
    } else if (sel === "[contenteditable=true]") {
      if (el.getAttribute("contenteditable") === "true") return true;
    } else if (el.tagName.toLowerCase() === sel.toLowerCase()) {
      return true;
    }
  }
  return false;
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
  srcObject: unknown = null;
  scrollTop = 0;
  scrollHeight = 0;
  width = 160;
  height = 120;
  readyState = 4;
  videoWidth = 1280;
  videoHeight = 960;
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

  hasClass(cls: string): boolean {
    return this.className.split(/\s+/).includes(cls);
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

  scrollIntoView(): void {}

  async play(): Promise<void> {}

  pause(): void {}

  closest(selector: string): MiniElement | null {
    let cur: MiniNode | null = this;
    while (cur instanceof MiniElement) {
      if (matchesSimpleSelector(cur, selector)) return cur;
      cur = cur.parentNode;
    }
    return null;
  }

  querySelector(selector: string): MiniElement | null {
    return this.findAll((el) => matchesSimpleSelector(el, selector))[0] ?? null;
  }

  getContext(): {
    drawImage: () => void;
    getImageData: (_x: number, _y: number, w: number, h: number) => { data: Uint8ClampedArray };
  } {
    return {
      drawImage() {},
      getImageData(_x: number, _y: number, w: number, h: number) {
        const data = new Uint8ClampedArray(w * h * 4);
        for (let i = 0; i < data.length; i += 4) {
          const v = (i / 4) % 2 === 0 ? 120 : 10;
          data[i] = v;
          data[i + 1] = v;
          data[i + 2] = v;
          data[i + 3] = 255;
        }
        return { data };
      },
    };
  }

  toDataURL(): string {
    return "data:image/jpeg;base64,ZmFrZS1mcmFtZQ==";
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
  visibilityState: "visible" | "hidden" = "visible";
  title = "";
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

function makeStorage(backing: Map<string, string>): Storage {
  return {
    get length() {
      return backing.size;
    },
    key(index: number) {
      return Array.from(backing.keys())[index] ?? null;
    },
    getItem(key: string) {
      return backing.has(key) ? backing.get(key)! : null;
    },
    setItem(key: string, value: string) {
      backing.set(key, String(value));
    },
    removeItem(key: string) {
      backing.delete(key);
    },
    clear() {
      backing.clear();
    },
  } as Storage;
}

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  url: string;
  readyState = MockWebSocket.CONNECTING;
  bufferedAmount = 0;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  sent: ClientMsg[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.readyState !== MockWebSocket.OPEN) throw new Error("Socket not open");
    this.sent.push(JSON.parse(data) as ClientMsg);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
  }

  serverOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.({ type: "open" } as Event);
  }

  serverSend(msg: ServerMsg | { type: "pong"; t: number }): void {
    this.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent);
  }
}

class MockBroadcastChannel {
  name: string;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  constructor(name: string) {
    this.name = name;
  }
  postMessage(): void {}
  close(): void {}
}

class MockAudioWorkletNode {
  port = {
    onmessage: null as ((ev: MessageEvent) => void) | null,
    close() {},
  };
  connect(dest: unknown): unknown {
    return dest;
  }
  disconnect(): void {}
}

class MockAudioContext {
  state: "running" | "suspended" | "closed" = "running";
  currentTime = 0;
  destination = { kind: "destination" };
  audioWorklet = {
    async addModule() {},
  };
  async resume(): Promise<void> {
    if (this.state !== "closed") this.state = "running";
  }
  async close(): Promise<void> {
    this.state = "closed";
  }
  createGain() {
    const param = {
      value: 1,
      setValueAtTime(v: number) {
        param.value = v;
      },
      linearRampToValueAtTime(v: number) {
        param.value = v;
      },
      exponentialRampToValueAtTime(v: number) {
        param.value = v;
      },
      setTargetAtTime(v: number) {
        param.value = v;
      },
      cancelScheduledValues() {},
    };
    return {
      gain: param,
      connect(dest: unknown) {
        return dest;
      },
      disconnect() {},
    };
  }
  createOscillator() {
    return {
      type: "sine",
      frequency: {
        value: 440,
        setTargetAtTime() {},
      },
      connect(dest: unknown) {
        return dest;
      },
      start() {},
      stop() {},
    };
  }
  createBiquadFilter() {
    return {
      type: "lowpass",
      frequency: { value: 1200 },
      connect(dest: unknown) {
        return dest;
      },
    };
  }
  createMediaStreamSource() {
    return {
      connect(dest: unknown) {
        return dest;
      },
      disconnect() {},
    };
  }
  createBuffer(_channels: number, length: number, sampleRate: number) {
    const channel = new Float32Array(length);
    return {
      length,
      sampleRate,
      duration: length / sampleRate,
      getChannelData: () => channel,
    } as unknown as AudioBuffer;
  }
  createBufferSource() {
    return {
      buffer: null,
      onended: null,
      connect(dest: unknown) {
        return dest;
      },
      start() {},
      stop() {},
      disconnect() {},
    };
  }
}

class MockSpeechUtterance {
  text: string;
  lang = "";
  rate = 1;
  volume = 1;
  constructor(text = "") {
    this.text = text;
  }
}

class MockMediaMetadata {
  title: string;
  artist: string;
  album: string;
  constructor(init: { title?: string; artist?: string; album?: string } = {}) {
    this.title = init.title ?? "";
    this.artist = init.artist ?? "";
    this.album = init.album ?? "";
  }
}

class MockAudioElement {
  src: string;
  loop = false;
  paused = true;
  volume = 1;
  currentTime = 0;
  preload = "auto";
  onended: (() => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  private events = makeEventMap();

  constructor(src = "") {
    this.src = src;
  }
  addEventListener(type: string, fn: ListenerFn): void {
    this.events.add(type, fn);
  }
  removeEventListener(type: string, fn: ListenerFn): void {
    this.events.remove(type, fn);
  }
  load(): void {}
  async play(): Promise<void> {
    if (this.src.includes(`${SLASH}phrases${SLASH}`)) {
      const err = new Error("Phrase audio unavailable");
      this.onerror?.(err);
      this.events.emit("error", err);
      throw err;
    }
    this.paused = false;
  }
  pause(): void {
    this.paused = true;
  }
}

class MockBarcodeDetector {
  static async getSupportedFormats(): Promise<string[]> {
    return ["ean_13", "data_matrix"];
  }
  async detect(): Promise<Array<{ rawValue: string; format: string }>> {
    return [];
  }
}

const localMap = new Map<string, string>();
const sessionMap = new Map<string, string>();
const localStorageShim = makeStorage(localMap);
const sessionStorageShim = makeStorage(sessionMap);
const spokenTexts: string[] = [];
const winEvents = makeEventMap();
let currentDoc = new MiniDocument();

function makeMediaStream(kind: "video" | "audio", label: string): MediaStream {
  const trackEvents = makeEventMap();
  const track = {
    kind,
    label,
    readyState: "live",
    stop() {},
    addEventListener(type: string, fn: ListenerFn) {
      trackEvents.add(type, fn);
    },
    removeEventListener(type: string, fn: ListenerFn) {
      trackEvents.remove(type, fn);
    },
  };
  return {
    getTracks: () => [track],
    getVideoTracks: () => (kind === "video" ? [track] : []),
    getAudioTracks: () => (kind === "audio" ? [track] : []),
  } as unknown as MediaStream;
}

const locationShim = {
  protocol: "https:",
  host: "holdup.example",
  origin: ORIGIN_HTTPS,
  pathname: SLASH,
  search: "",
  hash: "",
};

const historyShim = {
  state: null as unknown,
  replaceState() {},
  pushState() {},
  back() {},
};

const cachesShim = {
  async keys() {
    return [] as string[];
  },
  async match() {
    return undefined;
  },
  async open() {
    return {
      async match() {
        return undefined;
      },
      async put() {},
    };
  },
};

const navigatorShim = {
  onLine: true,
  language: "en-US",
  userAgent: "Mozilla 5.0 Android 14 Mobile",
  vibrate: () => true,
  mediaDevices: {
    async getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> {
      return constraints.video ? makeMediaStream("video", "Rear Camera") : makeMediaStream("audio", "Phone Mic");
    },
    async enumerateDevices(): Promise<Array<{ kind: string; deviceId: string; label: string }>> {
      return [
        { kind: "audioinput", deviceId: "default", label: "Phone Mic" },
        { kind: "audiooutput", deviceId: "default", label: "Phone Speaker" },
      ];
    },
    addEventListener() {},
    removeEventListener() {},
  },
  mediaSession: {
    metadata: null as unknown,
    playbackState: "none",
    setActionHandler() {},
  },
  permissions: {
    async query() {
      return { state: "granted" };
    },
  },
};

const fetchShim = async (input: RequestInfo | URL): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const status = url.includes(`${SLASH}phrases${SLASH}`) ? 404 : 200;
  const payload = url.includes(`${SLASH}api${SLASH}health`) ? { ok: true, gemini: "ok" } : { calls: 0 };
  const text = JSON.stringify(payload);
  return {
    ok: status === 200,
    status,
    statusText: status === 200 ? "OK" : "Not Found",
    headers: new Headers({ "content-type": "application/json" }),
    async json() {
      return payload;
    },
    async text() {
      return text;
    },
  } as unknown as Response;
};

function installDocument(doc: MiniDocument): void {
  currentDoc = doc;
  const win = {
    document: doc,
    navigator: navigatorShim,
    location: locationShim,
    history: historyShim,
    isSecureContext: true,
    AudioContext: MockAudioContext,
    Audio: MockAudioElement,
    WebSocket: MockWebSocket,
    SpeechSynthesisUtterance: MockSpeechUtterance,
    BarcodeDetector: MockBarcodeDetector,
    BroadcastChannel: MockBroadcastChannel,
    HTMLIFrameElement: class {},
    fetch: fetchShim,
    caches: cachesShim,
    speechSynthesis: {
      speak(u: MockSpeechUtterance) {
        if (u.volume > 0 && u.text.trim()) spokenTexts.push(u.text);
      },
      cancel() {},
    },
    addEventListener(type: string, fn: ListenerFn) {
      winEvents.add(type, fn);
    },
    removeEventListener(type: string, fn: ListenerFn) {
      winEvents.remove(type, fn);
    },
    dispatchEvent(ev: MiniEvent) {
      winEvents.emit(ev.type, ev);
      return !ev.defaultPrevented;
    },
  };
  doc.defaultView = win;
  setGlobal("document", doc);
  setGlobal("window", win);
}

installDocument(currentDoc);
setGlobal("localStorage", localStorageShim);
setGlobal("sessionStorage", sessionStorageShim);
setGlobal("navigator", navigatorShim);
setGlobal("location", locationShim);
setGlobal("history", historyShim);
setGlobal("caches", cachesShim);
setGlobal("WebSocket", MockWebSocket);
setGlobal("fetch", fetchShim);
setGlobal("AudioContext", MockAudioContext);
setGlobal("AudioWorkletNode", MockAudioWorkletNode);
setGlobal("BroadcastChannel", MockBroadcastChannel);
setGlobal("SpeechSynthesisUtterance", MockSpeechUtterance);
setGlobal("MediaMetadata", MockMediaMetadata);
setGlobal("Audio", MockAudioElement);

const { Checker } = await import("../src/lib/checker.ts");
const { Live } = await import("../src/screens/Live.tsx");
const { onAnnounce } = await import("../src/lib/feedback.ts");
const { saveSettings, loadSettings } = await import("../src/lib/storage.ts");

type DetectedFieldBox = NonNullable<CheckState["fields"]>[number];

const f = <T,>(value: T | null, confidence = 0.96): Field<T> => ({ value, confidence });

function makeRead(product = "Amlodipine", ingredient = "amlodipine", strength: string | null = "5 mg"): LabelRead {
  return {
    kind: "medication",
    product: f(product, 0.98),
    ingredient: f(ingredient, 0.96),
    strength: strength ? f(strength, 0.95) : f<string>(null, 0),
    dosing: f("1 tablet daily", 0.91),
    expiry: f("2028-08", 0.93),
    allergens: f<string[]>(null, 0),
    barcode: f("6416542002149", 0.99),
    readability: 0.94,
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
    session: "DOSE",
    online: true,
    health: "ok",
    rtt: 42,
    policy: { fps: 1, quality: 0.7, longSide: 768, tier: "normal" },
    fps: 1,
    framesSent: 4,
    camera: "on",
    cameraPerm: "granted",
    cameraMsg: "",
    mic: "on",
    micPerm: "granted",
    micMsg: "",
    micLabel: "Phone Mic",
    micLevel: 0.1,
    route: "Phone Speaker",
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
    sharpness: 0.78,
    serverFeatures: ["scene", "datamatrix", "addmed", "sonar"],
    lastCode: null,
    readiness: 0.85,
    fields: null,
    addProposal: null,
    banner: null,
    lastError: null,
    hidden: false,
    ...overrides,
  };
}

function makeReactiveChecker(initialOverrides: Partial<CheckState> = {}) {
  let current = makeCheckState(initialOverrides);
  const subs = new Set<() => void>();
  const featureSet = new Set<FeatureFlag>(["scene", "datamatrix", "addmed", "sonar"]);
  const stub = {
    subscribe(fn: () => void) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
    get() {
      return current;
    },
    attachVideo() {},
    primary() {},
    async start() {},
    async stop() {},
    async snapshot() {},
    async offlineCheckImage() {},
    backToLive() {},
    repeat() {},
    logDose() {},
    dismissVerdict() {},
    async setSource() {},
    sendText() {},
    answerProposal() {},
    feature(flag: FeatureFlag) {
      return featureSet.has(flag);
    },
    simulateDrop() {},
    injectCode() {},
    toggleSnapshotMode() {},
  } as unknown as CheckerType;

  return {
    checker: stub,
    getState: () => current,
    update(patch: Partial<CheckState>) {
      current = { ...current, ...patch };
      for (const fn of subs) fn();
    },
  };
}

async function mountLive(initialOverrides: Partial<CheckState> = {}, consented = true) {
  localMap.clear();
  sessionMap.clear();
  winEvents.clear();
  const doc = new MiniDocument();
  installDocument(doc);
  const store = makeReactiveChecker(initialOverrides);
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () => {
    root.render(
      createElement(Live, {
        checker: store.checker,
        consented,
        onReviewConsent: () => {},
        onFixPermissions: () => {},
      }),
    );
  });
  return {
    doc,
    container,
    store,
    async patch(next: Partial<CheckState>) {
      await act(async () => {
        store.update(next);
      });
    },
    fieldBoxes() {
      return container.findAll((el) => el.hasClass("field-box"));
    },
    sceneBoxes() {
      return container.findAll((el) => el.hasClass("scene-box"));
    },
    async unmount() {
      await act(async () => {
        root.unmount();
      });
    },
  };
}

const stripCssCommentsPattern = new RegExp("\\x2f\\*[\\s\\S]*?\\*\\x2f", "g");
const rawStyles = fs.readFileSync(STYLES_PATH, "utf8");
const cleanStyles = rawStyles.replace(stripCssCommentsPattern, "");

function extractCssBlock(css: string, selectorPattern: RegExp): string {
  const m = selectorPattern.exec(css);
  if (!m) throw new Error(`Expected CSS block matching ${String(selectorPattern)}`);
  const openIdx = css.indexOf("{", m.index);
  if (openIdx < 0) throw new Error(`Expected opening brace for ${String(selectorPattern)}`);
  let depth = 0;
  for (let i = openIdx; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(openIdx + 1, i);
    }
  }
  throw new Error(`Unclosed CSS block for ${String(selectorPattern)}`);
}

function parseDeclarations(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  const declRe = /([a-zA-Z-]+|--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(block)) !== null) {
    out[m[1].trim()] = m[2].trim();
  }
  return out;
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.trim().replace(/^#/, "");
  if (clean.length === 3) {
    return [
      Number.parseInt(clean[0] + clean[0], 16),
      Number.parseInt(clean[1] + clean[1], 16),
      Number.parseInt(clean[2] + clean[2], 16),
    ];
  }
  assert.equal(clean.length, 6, `Expected 3-digit or 6-digit hex color, got ${hex}`);
  return [
    Number.parseInt(clean.slice(0, 2), 16),
    Number.parseInt(clean.slice(2, 4), 16),
    Number.parseInt(clean.slice(4, 6), 16),
  ];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((ch) => {
    const s = ch / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(fgHex: string, bgHex: string): number {
  const l1 = relativeLuminance(fgHex);
  const l2 = relativeLuminance(bgHex);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function remToPx(remVal: string): number {
  const m = /^([0-9.]+)rem$/.exec(remVal.trim());
  if (!m) throw new Error(`Expected rem value, got ${remVal}`);
  return Number.parseFloat(m[1]) * 16;
}

test("Live.tsx Dose Finder overlay renders aria-hidden container, maps 0..1000 boxes to percentage geometry, keeps TalkBack/VoiceOver live regions silent, and uses pointer-events: none", async () => {
  const sampleFields: DetectedFieldBox[] = [
    { label: "strength", box: [220, 150, 380, 620], score: 0.94 },
    { label: "product", box: [80, 100, 190, 740], score: 0.91 },
    { label: "expiry", box: [680, 140, 790, 520], score: 0.87 },
    { label: "allergens", box: [810, 120, 930, 880], score: 0.83 },
  ];

  const view = await mountLive({ camera: "on", source: "phone", fields: sampleFields });
  try {
    const viewfinder = view.container.findAll((el) => el.hasClass("viewfinder"))[0];
    assert.ok(viewfinder, "Expected .viewfinder container");
    assert.equal(viewfinder.getAttribute("role"), "img");
    assert.equal(viewfinder.getAttribute("aria-label"), "Camera on. Picture sharpness 78 percent.");

    const boxes = view.fieldBoxes();
    assert.equal(boxes.length, 4);

    const overlayWrapper = boxes[0]?.parentNode;
    if (!(overlayWrapper instanceof MiniElement)) {
      throw new Error("Expected wrapper div around .field-box nodes");
    }
    assert.equal(overlayWrapper.parentNode, viewfinder);
    assert.equal(overlayWrapper.getAttribute("aria-hidden"), "true");

    for (const box of boxes) {
      assert.equal(box.parentNode, overlayWrapper);
      assert.equal(box.hasAttribute("tabindex"), false);
      const interactiveInside = box.findAll((el) => ["BUTTON", "A", "INPUT", "SELECT", "TEXTAREA"].includes(el.tagName));
      assert.equal(interactiveInside.length, 0);
    }

    assert.equal(boxes[0]?.className, "field-box strength");
    assert.equal(boxes[0]?.style.top, "22%");
    assert.equal(boxes[0]?.style.left, "15%");
    assert.equal(boxes[0]?.style.height, "16%");
    assert.equal(boxes[0]?.style.width, "47%");
    assert.equal(boxes[0]?.textContent, "Dose");

    assert.equal(boxes[1]?.className, "field-box product");
    assert.equal(boxes[1]?.style.top, "8%");
    assert.equal(boxes[1]?.style.left, "10%");
    assert.equal(boxes[1]?.style.height, "11%");
    assert.equal(boxes[1]?.style.width, "64%");
    assert.equal(boxes[1]?.textContent, "Name");

    assert.equal(boxes[2]?.className, "field-box expiry");
    assert.equal(boxes[2]?.style.top, "68%");
    assert.equal(boxes[2]?.style.left, "14%");
    assert.equal(boxes[2]?.style.height, "11%");
    assert.equal(boxes[2]?.style.width, "38%");
    assert.equal(boxes[2]?.textContent, "Expiry");

    assert.equal(boxes[3]?.className, "field-box allergens");
    assert.equal(boxes[3]?.style.top, "81%");
    assert.equal(boxes[3]?.style.left, "12%");
    assert.equal(boxes[3]?.style.height, "12%");
    assert.equal(boxes[3]?.style.width, "76%");
    assert.equal(boxes[3]?.textContent, "Allergens");

    await view.patch({
      fields: [{ label: "strength", box: [250, 180, 410, 650], score: 0.96 }],
    });
    assert.equal(view.fieldBoxes().length, 1);
    assert.equal(view.fieldBoxes()[0]?.style.top, "25%");
    assert.equal(view.fieldBoxes()[0]?.style.left, "18%");

    const politeLiveRegions = view.container.findAll((el) => el.getAttribute("aria-live") === "polite");
    assert.equal(politeLiveRegions.length, 1);
    assert.equal(politeLiveRegions[0]?.textContent, "");
    assert.equal(/25%|18%|220|150/.test(viewfinder.getAttribute("aria-label") ?? ""), false);

    const fieldBoxCss = parseDeclarations(extractCssBlock(cleanStyles, /(?:^|\})\s*\.field-box\s*\{/));
    assert.equal(fieldBoxCss["pointer-events"], "none");
    assert.equal(fieldBoxCss["position"], "absolute");
  } finally {
    await view.unmount();
  }
});

test("WCAG 1.4.1 non-color differentiation: .field-box.strength ('Dose') uses 4px solid var(--accent) + 0.95rem vs product/expiry/allergens ('Name'/'Expiry'/'Allergens') using 2px dashed var(--muted) + 0.8rem", async () => {
  const baseDecls = parseDeclarations(extractCssBlock(cleanStyles, /(?:^|\})\s*\.field-box\s*\{/));
  const strengthDecls = parseDeclarations(extractCssBlock(cleanStyles, /(?:^|\})\s*\.field-box\.strength\s*\{/));
  const baseSpanDecls = parseDeclarations(extractCssBlock(cleanStyles, /(?:^|\})\s*\.field-box\s+span\s*\{/));
  const strengthSpanDecls = parseDeclarations(extractCssBlock(cleanStyles, /(?:^|\})\s*\.field-box\.strength\s+span\s*\{/));

  assert.equal(baseDecls["border"], "2px dashed var(--muted)");
  assert.equal(baseDecls["pointer-events"], "none");
  assert.equal(strengthDecls["border"], "4px solid var(--accent)");

  assert.equal(baseSpanDecls["background"], "var(--muted)");
  assert.equal(baseSpanDecls["color"], "#0b1018");
  assert.equal(baseSpanDecls["font-weight"], "800");
  assert.equal(baseSpanDecls["font-size"], "0.8rem");
  assert.equal(baseSpanDecls["white-space"], "nowrap");

  assert.equal(strengthSpanDecls["background"], "var(--accent)");
  assert.equal(strengthSpanDecls["font-size"], "0.95rem");

  const basePx = remToPx(baseSpanDecls["font-size"]);
  const strengthPx = remToPx(strengthSpanDecls["font-size"]);
  assert.equal(basePx, 12.8);
  assert.equal(strengthPx, 15.2);
  assert.ok(strengthPx > basePx);

  const view = await mountLive({
    camera: "on",
    source: "phone",
    fields: [
      { label: "strength", box: [100, 100, 200, 400], score: 0.95 },
      { label: "product", box: [220, 100, 320, 400], score: 0.92 },
      { label: "expiry", box: [340, 100, 440, 400], score: 0.9 },
      { label: "allergens", box: [460, 100, 560, 400], score: 0.88 },
    ],
  });
  try {
    const renderedPairs = view.fieldBoxes().map((el) => {
      const span = el.querySelector("span");
      if (!span) throw new Error("Expected span badge inside each .field-box");
      return [el.className, span.textContent] as const;
    });
    assert.deepEqual(renderedPairs, [
      ["field-box strength", "Dose"],
      ["field-box product", "Name"],
      ["field-box expiry", "Expiry"],
      ["field-box allergens", "Allergens"],
    ]);
  } finally {
    await view.unmount();
  }
});

test("WCAG 1.4.3, 1.4.6, and 1.4.11 contrast: #0b1018 badge text on var(--accent) and var(--muted) exceeds 7:1 AAA in default and prefers-contrast: more palettes", () => {
  const rootDecls = parseDeclarations(extractCssBlock(cleanStyles, /:root\s*\{/));
  const moreContrastMediaBlock = extractCssBlock(cleanStyles, /@media\s*\(\s*prefers-contrast\s*:\s*more\s*\)\s*\{/);
  const moreContrastRootDecls = parseDeclarations(extractCssBlock(moreContrastMediaBlock, /:root\s*\{/));
  const spanDecls = parseDeclarations(extractCssBlock(cleanStyles, /(?:^|\})\s*\.field-box\s+span\s*\{/));
  const viewfinderDecls = parseDeclarations(extractCssBlock(cleanStyles, /(?:^|\})\s*\.viewfinder\s*\{/));

  const fgHex = spanDecls["color"];
  const defaultAccent = rootDecls["--accent"];
  const defaultMuted = rootDecls["--muted"];
  const defaultBg = rootDecls["--bg"];
  const viewfinderBg = viewfinderDecls["background"];

  assert.equal(fgHex, "#0b1018");
  assert.equal(defaultAccent, "#ffd23f");
  assert.equal(defaultMuted, "#b3bdcc");
  assert.equal(defaultBg, "#0b1018");
  assert.equal(viewfinderBg, "#05080d");

  const lumFg = relativeLuminance(fgHex);
  const lumAccent = relativeLuminance(defaultAccent);
  const lumMuted = relativeLuminance(defaultMuted);
  assert.ok(lumFg > 0 && lumFg < 0.01, `Expected dark ink luminance < 0.01, got ${lumFg}`);
  assert.ok(lumAccent > lumMuted, "Expected --accent luminance to exceed --muted luminance");

  const accentTextRatio = contrastRatio(fgHex, defaultAccent);
  const mutedTextRatio = contrastRatio(fgHex, defaultMuted);
  assert.ok(accentTextRatio >= 7, `Expected #0b1018 on var(--accent) >= 7:1 AAA, got ${accentTextRatio.toFixed(2)}:1`);
  assert.ok(mutedTextRatio >= 7, `Expected #0b1018 on var(--muted) >= 7:1 AAA, got ${mutedTextRatio.toFixed(2)}:1`);
  assert.ok(accentTextRatio > 13, `Expected #0b1018 on #ffd23f > 13:1, got ${accentTextRatio.toFixed(2)}:1`);
  assert.ok(mutedTextRatio > 9.5, `Expected #0b1018 on #b3bdcc > 9.5:1, got ${mutedTextRatio.toFixed(2)}:1`);

  const highContrastAccent = moreContrastRootDecls["--accent"];
  const highContrastMuted = moreContrastRootDecls["--muted"];
  assert.equal(highContrastAccent, "#ffe14d");
  assert.equal(highContrastMuted, "#e6e6e6");

  const hcAccentRatio = contrastRatio(fgHex, highContrastAccent);
  const hcMutedRatio = contrastRatio(fgHex, highContrastMuted);
  assert.ok(hcAccentRatio >= 7, `Expected high-contrast #0b1018 on var(--accent) >= 7:1 AAA, got ${hcAccentRatio.toFixed(2)}:1`);
  assert.ok(hcMutedRatio >= 7, `Expected high-contrast #0b1018 on var(--muted) >= 7:1 AAA, got ${hcMutedRatio.toFixed(2)}:1`);
  assert.ok(hcAccentRatio > accentTextRatio);
  assert.ok(hcMutedRatio > mutedTextRatio);

  assert.ok(contrastRatio(defaultAccent, viewfinderBg) >= 3);
  assert.ok(contrastRatio(defaultMuted, viewfinderBg) >= 3);
  assert.ok(contrastRatio(defaultAccent, defaultBg) >= 3);
  assert.ok(contrastRatio(defaultMuted, defaultBg) >= 3);
});

test("Cognitive-load and visual declutter: .field-box is suppressed when verdict.mode === 'scene', when camera !== 'on', when source === 'glasses', and when fields is empty or null", async () => {
  const activeFields: DetectedFieldBox[] = [
    { label: "strength", box: [240, 180, 420, 620], score: 0.93 },
    { label: "product", box: [100, 120, 210, 700], score: 0.89 },
  ];

  const itemVerdict: Verdict = {
    level: "match",
    mode: "item",
    headline: "Amlodipine 5 mg",
    speech: "Yes, Amlodipine 5 mg, your evening pill.",
    matchedMedId: "aml",
    reasons: ["Matches your evening schedule"],
    takenToday: false,
    read: makeRead("Amlodipine", "amlodipine", "5 mg"),
  };

  const sceneItems: SceneItem[] = [
    {
      position: "left",
      box: [180, 80, 760, 450],
      level: "match",
      headline: "Amlodipine 5 mg: evening pill",
      matchedMedId: "aml",
      read: makeRead("Amlodipine", "amlodipine", "5 mg"),
    },
    {
      position: "right",
      box: [200, 540, 780, 910],
      level: "warning",
      headline: "Ibuprofen 400 mg: avoid NSAIDs",
      read: makeRead("Burana", "ibuprofen", "400 mg"),
    },
  ];

  const sceneVerdict: Verdict = {
    level: "match",
    mode: "scene",
    headline: "Left box: Amlodipine 5 mg",
    speech: "Take the box on the left, Amlodipine 5 mg.",
    matchedMedId: "aml",
    reasons: ["Left package matches evening schedule"],
    items: sceneItems,
    read: makeRead("Amlodipine", "amlodipine", "5 mg"),
  };

  const view = await mountLive({ camera: "on", source: "phone", fields: activeFields, verdict: null });
  try {
    assert.equal(view.fieldBoxes().length, 2);
    assert.equal(view.sceneBoxes().length, 0);

    await view.patch({ verdict: itemVerdict });
    assert.equal(view.fieldBoxes().length, 2);
    assert.equal(view.sceneBoxes().length, 0);

    await view.patch({ verdict: sceneVerdict });
    assert.equal(view.fieldBoxes().length, 0, "Expected .field-box to be suppressed during scene mode");
    assert.equal(view.sceneBoxes().length, 2, "Expected .scene-box to render cleanly without .field-box overlap");

    await view.patch({ verdict: null });
    assert.equal(view.fieldBoxes().length, 2);
    assert.equal(view.sceneBoxes().length, 0);

    for (const nonActiveCamera of ["off", "starting", "paused", "error"] as const) {
      await view.patch({ camera: nonActiveCamera });
      assert.equal(view.fieldBoxes().length, 0, `Expected .field-box suppressed when camera === "${nonActiveCamera}"`);
    }

    await view.patch({ camera: "on", source: "glasses" });
    assert.equal(view.fieldBoxes().length, 0, "Expected .field-box suppressed when source === 'glasses'");

    await view.patch({ camera: "on", source: "phone", fields: [] });
    assert.equal(view.fieldBoxes().length, 0);

    await view.patch({ fields: null });
    assert.equal(view.fieldBoxes().length, 0);
  } finally {
    await view.unmount();
  }
});

test("Stale-box safety: Checker handling { type: 'fields', fields } sets state.fields, resets debounce on rapid updates, and auto-clears fields to null after 2500ms", async (t: TestContext) => {
  const BASE_NOW = 1_763_196_000_000;
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: BASE_NOW });

  localMap.clear();
  sessionMap.clear();
  spokenTexts.length = 0;
  MockWebSocket.instances = [];
  saveSettings({ ...loadSettings(), voice: true, source: "phone" });

  const announcements: Array<{ text: string; politeness: string }> = [];
  const offAnnounce = onAnnounce((text, politeness) => {
    announcements.push({ text, politeness });
  });

  const doc = new MiniDocument();
  installDocument(doc);
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);

  const checker = new Checker();
  let subscriberUpdates = 0;
  const unsub = checker.subscribe(() => {
    subscriberUpdates++;
  });

  try {
    act(() => {
      root.render(
        createElement(Live, {
          checker,
          consented: true,
          onReviewConsent: () => {},
          onFixPermissions: () => {},
        }),
      );
    });

    assert.equal(checker.get().fields, null);
    assert.equal(container.findAll((el) => el.hasClass("field-box")).length, 0);

    await act(async () => {
      await checker.start();
    });
    assert.equal(checker.get().running, true);
    assert.equal(checker.get().camera, "on");
    assert.equal(MockWebSocket.instances.length, 1);

    const ws = MockWebSocket.instances[0]!;
    act(() => {
      ws.serverOpen();
      ws.serverSend({
        type: "ready",
        model: "gemini-3.8-live",
        session: checker.get().session,
        features: ["scene", "datamatrix", "addmed", "sonar"],
      });
    });

    const batch1: DetectedFieldBox[] = [
      { label: "strength", box: [200, 140, 360, 580], score: 0.92 },
      { label: "product", box: [70, 110, 180, 720], score: 0.89 },
    ];
    const updatesBeforeFields = subscriberUpdates;
    act(() => {
      ws.serverSend({ type: "fields", fields: batch1 });
    });
    assert.deepEqual(checker.get().fields, batch1);
    assert.ok(subscriberUpdates > updatesBeforeFields);
    assert.deepEqual(
      container.findAll((el) => el.hasClass("field-box")).map((el) => el.textContent),
      ["Dose", "Name"],
    );

    act(() => {
      t.mock.timers.tick(1500);
    });
    assert.deepEqual(checker.get().fields, batch1);

    const batch2: DetectedFieldBox[] = [
      { label: "product", box: [85, 115, 195, 735], score: 0.93 },
      { label: "expiry", box: [690, 160, 800, 520], score: 0.86 },
    ];
    act(() => {
      ws.serverSend({ type: "fields", fields: batch2 });
    });
    assert.deepEqual(checker.get().fields, batch2);
    assert.deepEqual(
      container.findAll((el) => el.hasClass("field-box")).map((el) => el.textContent),
      ["Name", "Expiry"],
    );

    act(() => {
      t.mock.timers.tick(1500);
    });
    assert.deepEqual(
      checker.get().fields,
      batch2,
      "Expected rapid { type: 'fields' } update at +1500ms to cancel the prior 2500ms timer",
    );
    assert.equal(container.findAll((el) => el.hasClass("field-box")).length, 2);

    const batch3: DetectedFieldBox[] = [
      { label: "strength", box: [230, 160, 390, 610], score: 0.97 },
    ];
    act(() => {
      ws.serverSend({ type: "fields", fields: batch3 });
    });
    assert.deepEqual(checker.get().fields, batch3);

    act(() => {
      t.mock.timers.tick(2499);
    });
    assert.deepEqual(checker.get().fields, batch3, "Expected fields to remain visible at 2499ms after latest update");
    assert.deepEqual(
      container.findAll((el) => el.hasClass("field-box")).map((el) => el.textContent),
      ["Dose"],
    );

    act(() => {
      t.mock.timers.tick(1);
    });
    assert.equal(checker.get().fields, null, "Expected fields to auto-clear to null at 2500ms so stale boxes disappear");
    assert.equal(container.findAll((el) => el.hasClass("field-box")).length, 0);

    act(() => {
      ws.serverSend({
        type: "coach",
        cue: "other_side",
        text: "Your fingers may be covering the dose. Shift your grip.",
        say: true,
      });
    });
    assert.equal(checker.get().fields, null);
    assert.equal(checker.get().cue?.cue, "other_side");
    assert.ok(spokenTexts.includes("Your fingers may be covering the dose. Shift your grip."));
  } finally {
    act(() => {
      root.unmount();
    });
    unsub();
    offAnnounce();
    await checker.stop();
    checker.dispose();
    t.mock.timers.reset();
  }
});

test("fieldSpotterDoseFinderA11y.test.ts contains zero code comments and zero em dashes", () => {
  const selfPath = fileURLToPath(import.meta.url);
  const src = fs.readFileSync(selfPath, "utf8");
  assert.equal(src.includes("\x2f\x2f"), false);
  assert.equal(src.includes("\x2f*"), false);
  assert.equal(src.includes(String.fromCharCode(0x2014)), false);
});
