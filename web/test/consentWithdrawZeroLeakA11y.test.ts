import { after, test } from "node:test";
import assert from "node:assert/strict";
import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Med, Profile } from "../../shared/types.ts";

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
  private _checked = false;
  private _selected = false;
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
    if (this.tagName === "INPUT" && (this.type === "checkbox" || this.type === "radio")) {
      this._checked = !this._checked;
      if (this._checked) this.attributes.set("checked", "");
      else this.attributes.delete("checked");
    }
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
  visibilityState: "visible" | "hidden" = "visible";
  title = "";
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
  label: string;
  readyState: "live" | "ended" = "live";
  stopCalls = 0;

  constructor(kind: "video" | "audio", label: string) {
    this.kind = kind;
    this.label = label;
  }

  stop(): void {
    this.stopCalls++;
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

class FakeAudioWorkletNode {
  port = {
    onmessage: null as unknown,
    close() {},
    postMessage() {},
  };

  connect(dest: unknown) {
    return dest;
  }

  disconnect() {}
}

let audioCloseDelayMs = 0;

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state: "running" | "suspended" | "closed" = "running";
  currentTime = 0;
  destination = {};
  audioWorklet = {
    async addModule(): Promise<void> {},
  };

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  async resume(): Promise<void> {
    if (this.state !== "closed") this.state = "running";
  }

  async close(): Promise<void> {
    if (audioCloseDelayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, audioCloseDelayMs));
    }
    this.state = "closed";
  }

  createMediaStreamSource() {
    return {
      connect: (dest: unknown) => dest,
      disconnect() {},
    };
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

class FakeAudioElement {
  src: string;
  loop = false;

  constructor(src = "") {
    this.src = src;
  }

  async play(): Promise<void> {}
  pause(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

class FakeMediaMetadata {
  title: string;
  artist: string;
  album: string;

  constructor(init: { title?: string; artist?: string; album?: string } = {}) {
    this.title = init.title ?? "";
    this.artist = init.artist ?? "";
    this.album = init.album ?? "";
  }
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  readyState = 0;
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (this.readyState === 0) {
        this.readyState = 1;
        this.onopen?.();
      }
    });
  }

  send(_data: string): void {}

  close(): void {
    this.readyState = 3;
  }
}

function makeNonEnumerableMapStorage(backing: Map<string, string>, opts: { throwOnRemove?: boolean } = {}): Storage {
  const proto = {
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
      if (opts.throwOnRemove) throw new Error("SecurityError");
      backing.delete(key);
    },
    clear(): void {
      if (opts.throwOnRemove) throw new Error("SecurityError");
      backing.clear();
    },
  };
  return Object.create(proto) as Storage;
}

function makeOwnPropStorage(): Storage {
  const proto = {
    get length(): number {
      return 0;
    },
    key(): string | null {
      return null;
    },
    getItem(key: string): string | null {
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
    },
    setItem(key: string, value: string): void {
      store[key] = String(value);
    },
    removeItem(key: string): void {
      delete store[key];
    },
    clear(): void {
      for (const k of Object.keys(store)) delete store[k];
    },
  };
  const store = Object.create(proto) as Record<string, string> & Storage;
  return store;
}

const doc = new MiniDocument();
const storageBacking = new Map<string, string>();
const sessionBacking = new Map<string, string>();
const cacheBuckets = new Set<string>();
const issuedTracks: FakeMediaTrack[] = [];
let confirmResult = true;
const confirmPrompts: string[] = [];

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

const cachesShim = {
  async keys(): Promise<string[]> {
    return Array.from(cacheBuckets);
  },
  async delete(name: string): Promise<boolean> {
    return cacheBuckets.delete(name);
  },
};

const navigatorShim = {
  language: "en-US",
  onLine: true,
  userAgent: "Mozilla\x2f5.0 (Linux; Android 14) Chrome\x2f130.0.0.0",
  vibrate: () => true,
  mediaDevices: {
    async getUserMedia(constraints: { video?: unknown; audio?: unknown }) {
      const tracks: FakeMediaTrack[] = [];
      if (constraints.video) {
        const vt = new FakeMediaTrack("video", "Rear Camera");
        issuedTracks.push(vt);
        tracks.push(vt);
      }
      if (constraints.audio) {
        const at = new FakeMediaTrack("audio", "Glasses Mic");
        issuedTracks.push(at);
        tracks.push(at);
      }
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

const fetchShim = async (input: unknown): Promise<Response> => {
  const url = String(input);
  if (url.includes("\x2fapi\x2fhealth")) {
    return new Response(JSON.stringify({ ok: true, gemini: "ok" }), {
      status: 200,
      headers: { "content-type": "application\x2fjson" },
    });
  }
  if (url.includes("\x2fapi\x2fstats")) {
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

const windowShim: Record<string, unknown> = {
  isSecureContext: true,
  document: doc,
  navigator: navigatorShim,
  location: loc,
  history: hist,
  caches: cachesShim,
  AudioContext: FakeAudioContext,
  HTMLInputElement: MiniElement,
  HTMLElement: MiniElement,
  HTMLIFrameElement: class {},
  speechSynthesis: {
    cancel() {},
    speak() {},
  },
  confirm(msg: string): boolean {
    confirmPrompts.push(msg);
    return confirmResult;
  },
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {
    return true;
  },
};
doc.defaultView = windowShim;

setGlobal("window", windowShim);
setGlobal("document", doc);
setGlobal("navigator", navigatorShim);
setGlobal("location", loc);
setGlobal("history", hist);
setGlobal("localStorage", makeNonEnumerableMapStorage(storageBacking));
setGlobal("sessionStorage", makeNonEnumerableMapStorage(sessionBacking));
setGlobal("caches", cachesShim);
setGlobal("confirm", (msg: string) => {
  confirmPrompts.push(msg);
  return confirmResult;
});
setGlobal("fetch", fetchShim);
setGlobal("WebSocket", FakeWebSocket);
setGlobal("AudioContext", FakeAudioContext);
setGlobal("AudioWorkletNode", FakeAudioWorkletNode);
setGlobal("SpeechSynthesisUtterance", FakeSpeechSynthesisUtterance);
setGlobal("Audio", FakeAudioElement);
setGlobal("MediaMetadata", FakeMediaMetadata);

const keyMod = await import("../src/lib/key.ts");
const storageMod = await import("../src/lib/storage.ts");
const liveMod = await import("../src/lib/live.ts");
const feedbackMod = await import("../src/lib/feedback.ts");

const { accessKey, clearAccessKey, keyHeaders, setAccessKey, withKey } = keyMod;
const {
  deleteAllData,
  loadConsent,
  loadProfile,
  loadSettings,
  saveConsent,
  saveProfile,
  saveSettings,
  sessionCode,
} = storageMod;
const { liveUrl } = liveMod;
const { onAnnounce } = feedbackMod;

type AppModule = typeof import("../src/App.tsx");

async function loadFreshApp(tag: string): Promise<AppModule> {
  const href = new URL(`../src/App.tsx?case=${tag}`, import.meta.url).href;
  return (await import(href)) as AppModule;
}

function resetHarness(): void {
  storageBacking.clear();
  sessionBacking.clear();
  cacheBuckets.clear();
  issuedTracks.length = 0;
  FakeAudioContext.instances.length = 0;
  FakeWebSocket.instances.length = 0;
  confirmPrompts.length = 0;
  confirmResult = true;
  audioCloseDelayMs = 0;
  loc.search = "";
  loc.pathname = "\x2f";
  loc.hash = "";
  doc.body.childNodes = [];
  doc.activeElement = null;
  doc.title = "";
  setGlobal("localStorage", makeNonEnumerableMapStorage(storageBacking));
  setGlobal("sessionStorage", makeNonEnumerableMapStorage(sessionBacking));
  clearAccessKey();
}

function savedCustomProfile(): Profile {
  const meds: Med[] = [
    {
      id: "bisoprolol-25",
      name: "Bisoprolol Orion",
      ingredient: "bisoprolol",
      strength: "2.5 mg",
      schedule: ["morning"],
      barcode: "6432100099111",
      gtin: "06432100099111",
      notes: "Morning heart tablet",
    },
    {
      id: "thyroxin-50",
      name: "Thyroxin",
      ingredient: "levothyroxine",
      strength: "50 mcg",
      schedule: ["morning"],
    },
  ];
  return {
    lang: "en",
    meds,
    allergies: ["hazelnut"],
    avoid: ["ibuprofen"],
    doseLog: [{ medId: "bisoprolol-25", ts: Date.now() - 1_000 }],
  };
}

async function flushAsync(ms = 0): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
  if (ms > 0) await new Promise<void>((resolve) => setTimeout(resolve, ms));
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

async function mountApp(t: test.TestContext, tag: string) {
  const { App } = await loadFreshApp(tag);
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  let mounted = true;

  await act(async () => {
    root.render(createElement(App));
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
    html: () => container.innerHTML,
    text: () => decodeHtml(container.innerHTML),
    buttonByText: (label: string): MiniElement => {
      const btn = container.findAll((el) => el.tagName === "BUTTON" && el.textContent.trim() === label)[0];
      assert.ok(btn, `Expected button "${label}"`);
      return btn;
    },
    buttonContaining: (substr: string): MiniElement => {
      const btn = container.findAll((el) => el.tagName === "BUTTON" && el.textContent.includes(substr))[0];
      assert.ok(btn, `Expected button containing "${substr}"`);
      return btn;
    },
    switchByLabelPrefix: (prefix: string): MiniElement => {
      const labelEl = container.findAll(
        (el) => el.tagName === "LABEL" && el.className.includes("switch") && el.textContent.trim().startsWith(prefix),
      )[0];
      assert.ok(labelEl, `Expected switch label starting with "${prefix}"`);
      const input = labelEl.findAll((el) => el.tagName === "INPUT" && el.getAttribute("role") === "switch")[0];
      assert.ok(input, `Expected switch input inside "${prefix}"`);
      return input;
    },
    liveRegionText: (politeness: "polite" | "assertive"): string => {
      const region = container.findAll((el) => el.getAttribute("aria-live") === politeness)[0];
      assert.ok(region, `Expected aria-live="${politeness}" region`);
      return region.textContent;
    },
    unmount,
  };
}

test("deleteAllData wipes every holdup.* key across key(i) and Object.keys shims, clears sessionStorage and caches, and immediately resets accessKey, keyHeaders, and withKey in RAM", async () => {
  storageBacking.clear();
  sessionBacking.clear();
  cacheBuckets.clear();
  loc.search = "?mock=1&key=url-extracted-secret";
  assert.equal(accessKey(), "url-extracted-secret");
  assert.equal(localStorage.getItem("holdup.key"), "url-extracted-secret");
  assert.equal(loc.search, "?mock=1");
  assert.deepEqual(keyHeaders(), { "x-holdup-key": "url-extracted-secret" });
  assert.equal(withKey("\x2fhud-ws"), "\x2fhud-ws?key=url-extracted-secret");

  await deleteAllData();
  assert.equal(localStorage.getItem("holdup.key"), null);
  assert.equal(accessKey(), null);
  assert.deepEqual(keyHeaders(), {});
  assert.equal(withKey("\x2fhud-ws"), "\x2fhud-ws");

  resetHarness();

  saveProfile(savedCustomProfile());
  saveConsent();
  saveSettings({ ...loadSettings(), quiet: true, voice: false });
  const code = sessionCode();
  assert.equal(code.length, 4);
  setAccessKey("secret-tunnel-key-2026");
  localStorage.setItem("holdup.hud.speak", "1");
  localStorage.setItem("unrelated.key", "keep-me");
  sessionStorage.setItem("holdup.tab", "active");
  sessionStorage.setItem("other.session", "temp");
  cacheBuckets.add("holdup-shell-v1");
  cacheBuckets.add("holdup-phrases-v1");

  assert.equal(Object.keys(localStorage).length, 0);
  assert.equal(localStorage.length, 7);
  assert.equal(accessKey(), "secret-tunnel-key-2026");
  assert.deepEqual(keyHeaders(), { "x-holdup-key": "secret-tunnel-key-2026" });
  assert.equal(withKey("\x2fhud-ws"), "\x2fhud-ws?key=secret-tunnel-key-2026");
  assert.ok(liveUrl("K7P9").includes("key=secret-tunnel-key-2026"));

  await deleteAllData();

  for (const k of [
    "holdup.profile",
    "holdup.consent",
    "holdup.settings",
    "holdup.session",
    "holdup.key",
    "holdup.hud.speak",
  ]) {
    assert.equal(localStorage.getItem(k), null, `Expected ${k} to be wiped`);
  }
  assert.equal(localStorage.getItem("unrelated.key"), "keep-me");
  assert.equal(sessionStorage.length, 0);
  assert.equal(cacheBuckets.size, 0);

  assert.equal(accessKey(), null);
  assert.deepEqual(keyHeaders(), {});
  assert.equal(withKey("\x2fhud-ws"), "\x2fhud-ws");
  assert.equal(liveUrl("K7P9").includes("key="), false);

  const ownPropStore = makeOwnPropStorage();
  setGlobal("localStorage", ownPropStore);
  saveProfile(savedCustomProfile());
  saveConsent();
  saveSettings({ ...loadSettings(), quiet: true });
  sessionCode();
  setAccessKey("own-prop-secret");
  localStorage.setItem("holdup.hud.speak", "1");
  localStorage.setItem("keep.foreign", "ok");
  assert.equal(localStorage.length, 0);
  assert.ok(Object.keys(localStorage).includes("holdup.key"));
  assert.equal(accessKey(), "own-prop-secret");

  await deleteAllData();

  assert.deepEqual(Object.keys(localStorage), ["keep.foreign"]);
  assert.equal(accessKey(), null);
  assert.deepEqual(keyHeaders(), {});
  assert.equal(withKey("\x2fhud-ws"), "\x2fhud-ws");

  const blockedBacking = new Map<string, string>([["holdup.key", "stuck-on-disk"]]);
  setGlobal("localStorage", makeNonEnumerableMapStorage(blockedBacking, { throwOnRemove: true }));
  setAccessKey("ram-only-key");
  assert.equal(accessKey(), "ram-only-key");
  clearAccessKey();
  assert.equal(accessKey(), null);
  assert.deepEqual(keyHeaders(), {});
  assert.equal(withKey("\x2fhud-ws"), "\x2fhud-ws");
});

test("Interactive App consent withdrawal when idle removes holdup.consent, preserves saved medicines, gates Check behind HoldUp needs your OK first, and announces once assertively", async (t) => {
  resetHarness();
  const custom = savedCustomProfile();
  saveProfile(custom);
  saveConsent();

  const announcements: Array<{ msg: string; politeness: "polite" | "assertive" }> = [];
  const off = onAnnounce((msg, politeness) => announcements.push({ msg, politeness }));
  t.after(off);

  const ui = await mountApp(t, "withdraw-idle");

  assert.ok(!ui.text().includes("HoldUp needs your OK first"));
  assert.ok(ui.text().includes("Start check"));

  await act(async () => {
    ui.buttonByText("Profile").click();
  });
  assert.ok(ui.text().includes("Bisoprolol Orion"));
  assert.ok(ui.text().includes("Thyroxin"));

  await act(async () => {
    ui.buttonByText("Privacy").click();
  });
  assert.ok(ui.text().includes("You agreed on"));
  const withdrawBtn = ui.buttonByText("Withdraw consent");

  announcements.length = 0;
  await act(async () => {
    withdrawBtn.click();
    await flushAsync(80);
  });

  assert.equal(localStorage.getItem("holdup.consent"), null);
  assert.equal(loadConsent(), null);
  assert.deepEqual(
    loadProfile().meds.map((m) => m.name),
    ["Bisoprolol Orion", "Thyroxin"],
  );

  assert.ok(ui.text().includes("Not given. The camera stays off."));
  assert.ok(ui.text().includes("Review and agree"));
  assert.equal(
    ui.container.findAll((el) => el.tagName === "BUTTON" && el.textContent.trim() === "Withdraw consent").length,
    0,
  );

  assert.deepEqual(announcements, [
    { msg: "Consent withdrawn. The camera will stay off.", politeness: "assertive" },
  ]);
  assert.equal(ui.liveRegionText("assertive"), "Consent withdrawn. The camera will stay off.");

  await act(async () => {
    ui.buttonByText("Profile").click();
  });
  assert.ok(ui.text().includes("Bisoprolol Orion"));
  assert.ok(ui.text().includes("Thyroxin"));

  await act(async () => {
    ui.buttonByText("Check").click();
  });
  assert.ok(ui.text().includes("HoldUp needs your OK first"));
  assert.equal(ui.container.findAll((el) => el.tagName === "VIDEO").length, 0);
  assert.ok(!ui.text().includes("CAMERA ON"));
  assert.ok(!ui.text().includes("Start check"));
});

test("Interactive App consent withdrawal while a check is running stops camera and mic, preserves saved medicines, gates Check, and never clobbers assertive withdrawal announcement with Check stopped", async (t) => {
  resetHarness();
  audioCloseDelayMs = 25;
  saveProfile(savedCustomProfile());
  saveConsent();

  const announcements: Array<{ msg: string; politeness: "polite" | "assertive" }> = [];
  const off = onAnnounce((msg, politeness) => announcements.push({ msg, politeness }));
  t.after(off);

  const ui = await mountApp(t, "withdraw-running");

  await act(async () => {
    ui.buttonByText("Start check").click();
    await flushAsync(30);
  });

  const videoTracks = issuedTracks.filter((tr) => tr.kind === "video");
  const audioTracks = issuedTracks.filter((tr) => tr.kind === "audio");
  assert.equal(videoTracks.length, 1);
  assert.equal(audioTracks.length, 1);
  assert.equal(videoTracks[0].readyState, "live");
  assert.equal(audioTracks[0].readyState, "live");
  assert.ok(ui.text().includes("CAMERA ON"));

  await act(async () => {
    ui.buttonByText("Privacy").click();
  });

  announcements.length = 0;
  await act(async () => {
    ui.buttonByText("Withdraw consent").click();
    await flushAsync(140);
  });

  assert.equal(videoTracks[0].readyState, "ended");
  assert.equal(audioTracks[0].readyState, "ended");
  assert.ok(videoTracks[0].stopCalls >= 1);
  assert.ok(audioTracks[0].stopCalls >= 1);
  assert.ok(FakeAudioContext.instances.some((ctx) => ctx.state === "closed"));

  assert.equal(localStorage.getItem("holdup.consent"), null);
  assert.deepEqual(
    loadProfile().meds.map((m) => m.name),
    ["Bisoprolol Orion", "Thyroxin"],
  );

  assert.equal(
    announcements.some((a) => a.msg.startsWith("Check stopped")),
    false,
  );
  assert.deepEqual(announcements, [
    { msg: "Consent withdrawn. The camera will stay off.", politeness: "assertive" },
  ]);
  assert.equal(ui.liveRegionText("assertive"), "Consent withdrawn. The camera will stay off.");

  await act(async () => {
    ui.buttonByText("Check").click();
  });
  assert.ok(ui.text().includes("HoldUp needs your OK first"));
  assert.equal(ui.container.findAll((el) => el.tagName === "VIDEO").length, 0);
  assert.ok(!ui.text().includes("CAMERA ON"));
});

test("Interactive App Delete all my data stops active check, wipes storage and in-memory accessKey immediately, and returns to Consent onboarding", async (t) => {
  resetHarness();
  saveProfile(savedCustomProfile());
  saveConsent();
  setAccessKey("live-session-secret");
  localStorage.setItem("holdup.hud.speak", "1");
  sessionStorage.setItem("holdup.ephemeral", "1");
  cacheBuckets.add("holdup-shell-v1");

  const announcements: Array<{ msg: string; politeness: "polite" | "assertive" }> = [];
  const off = onAnnounce((msg, politeness) => announcements.push({ msg, politeness }));
  t.after(off);

  const ui = await mountApp(t, "delete-all-running");

  await act(async () => {
    ui.buttonByText("Start check").click();
    await flushAsync(20);
  });
  assert.equal(issuedTracks.every((tr) => tr.readyState === "live"), true);

  await act(async () => {
    ui.buttonByText("Privacy").click();
  });

  confirmResult = false;
  await act(async () => {
    ui.buttonContaining("Delete all my data").click();
    await flushAsync(20);
  });
  assert.equal(confirmPrompts.length, 1);
  assert.equal(accessKey(), "live-session-secret");
  assert.notEqual(loadConsent(), null);

  confirmResult = true;
  announcements.length = 0;
  await act(async () => {
    ui.buttonContaining("Delete all my data").click();
    await flushAsync(20);
  });
  await act(async () => {
    await flushAsync(80);
  });

  assert.equal(issuedTracks.every((tr) => tr.readyState === "ended"), true);
  assert.equal(localStorage.getItem("holdup.key"), null);
  assert.equal(localStorage.getItem("holdup.consent"), null);
  assert.equal(localStorage.getItem("holdup.profile"), null);
  assert.equal(localStorage.getItem("holdup.settings"), null);
  assert.equal(localStorage.getItem("holdup.hud.speak"), null);
  assert.equal(sessionStorage.length, 0);
  assert.equal(cacheBuckets.size, 0);
  assert.equal(accessKey(), null);
  assert.deepEqual(keyHeaders(), {});
  assert.equal(withKey("\x2fhud-ws"), "\x2fhud-ws");
  assert.ok(
    announcements.some(
      (a) => a.msg === "All your HoldUp data has been deleted from this phone." && a.politeness === "assertive",
    ),
  );
  assert.equal(ui.liveRegionText("assertive"), "All your HoldUp data has been deleted from this phone.");
  assert.ok(ui.text().includes("First, three short things about your privacy."));
});

test("Privacy announces Quiet mode, Spoken answers, Sounds (earcons), and Vibration toggles politely and persists each setting", async (t) => {
  resetHarness();
  saveConsent();

  const announcements: Array<{ msg: string; politeness: "polite" | "assertive" }> = [];
  const off = onAnnounce((msg, politeness) => announcements.push({ msg, politeness }));
  t.after(off);

  const ui = await mountApp(t, "privacy-feedback-switches");

  await act(async () => {
    ui.buttonByText("Privacy").click();
  });

  const cases: Array<{
    prefix: string;
    readSetting: () => boolean;
    initial: boolean;
    firstExpected: string;
    secondExpected: string;
  }> = [
    {
      prefix: "Quiet mode",
      readSetting: () => loadSettings().quiet,
      initial: false,
      firstExpected: "Quiet mode on.",
      secondExpected: "Quiet mode off.",
    },
    {
      prefix: "Spoken answers",
      readSetting: () => loadSettings().voice,
      initial: true,
      firstExpected: "Spoken answers off.",
      secondExpected: "Spoken answers on.",
    },
    {
      prefix: "Sounds (earcons)",
      readSetting: () => loadSettings().earcons,
      initial: true,
      firstExpected: "Sounds (earcons) off.",
      secondExpected: "Sounds (earcons) on.",
    },
    {
      prefix: "Vibration",
      readSetting: () => loadSettings().haptics,
      initial: true,
      firstExpected: "Vibration off.",
      secondExpected: "Vibration on.",
    },
  ];

  for (const c of cases) {
    const sw = ui.switchByLabelPrefix(c.prefix);
    assert.equal(sw.checked, c.initial);
    assert.equal(c.readSetting(), c.initial);

    announcements.length = 0;
    await act(async () => {
      sw.click();
      await flushAsync(75);
    });
    assert.equal(sw.checked, !c.initial);
    assert.equal(c.readSetting(), !c.initial);
    assert.deepEqual(announcements, [{ msg: c.firstExpected, politeness: "polite" }]);
    assert.equal(ui.liveRegionText("polite"), c.firstExpected);

    announcements.length = 0;
    await act(async () => {
      sw.click();
      await flushAsync(75);
    });
    assert.equal(sw.checked, c.initial);
    assert.equal(c.readSetting(), c.initial);
    assert.deepEqual(announcements, [{ msg: c.secondExpected, politeness: "polite" }]);
    assert.equal(ui.liveRegionText("polite"), c.secondExpected);
  }
});
