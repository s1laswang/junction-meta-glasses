import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { register } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";

const TEST_FILE = fileURLToPath(import.meta.url);
const TEST_DIR = path.dirname(TEST_FILE);
const REPO_DIR = process.env.HOLDUP_TEST_REPO_DIR
  ? path.resolve(process.env.HOLDUP_TEST_REPO_DIR)
  : path.resolve(TEST_DIR, "..", "..");

const SLASH = String.fromCharCode(47);
const SLASH2 = String.fromCharCode(47, 47);
const LINE_COMMENT = String.fromCharCode(47, 47);
const BLOCK_OPEN = String.fromCharCode(47, 42);
const BLOCK_CLOSE = String.fromCharCode(42, 47);
const HTML_COMMENT = String.fromCharCode(60, 33, 45, 45);
const EM_DASH = String.fromCharCode(8212);
const EN_DASH = String.fromCharCode(8211);
const ESCAPED_EM_DASH = [String.fromCharCode(92), "u", "2014"].join("");
const ESCAPED_EN_DASH = [String.fromCharCode(92), "u", "2013"].join("");

const SECRET_PREFIXES = [
  ["AIza", "Sy"].join(""),
  ["AQ.", "Ab"].join(""),
  ["sk_", "live_"].join(""),
  ["sk_", "test_"].join(""),
  ["ghp", "_"].join(""),
  ["ya29", "."].join(""),
];

const NORDIC_PIXEL_CODES = new Set([196, 197, 214, 228, 229, 246]);

const XHTML_NS = `http:${SLASH2}www.w3.org${SLASH}1999${SLASH}xhtml`;
const ORIGIN = `https:${SLASH2}holdup.example`;
const SHARED_PLAYWRIGHT_DIR = "/tmp/fleet-root/shared/ms-playwright";
const EXPECTED_HONESTY_BANNER = "OFFLINE DEMO - PHONE CAMERA ONLY (no physical glasses)";
const EXPECTED_LANGS = ["en", "fi", "sv"] as const;

const BLINDFOLD_TSX_PATH = path.join(REPO_DIR, "web", "src", "screens", "Blindfold.tsx");
const BLINDFOLD_CSS_PATH = path.join(REPO_DIR, "web", "src", "screens", "blindfold.css");
const PIXEL_SCENE_TS_PATH = path.join(REPO_DIR, "web", "src", "lib", "pixelScene.ts");
const MEDIA_TS_PATH = path.join(REPO_DIR, "web", "src", "lib", "media.ts");
const ANNOUNCER_TSX_PATH = path.join(REPO_DIR, "web", "src", "components", "Announcer.tsx");
const PHRASE_MANIFEST_PATH = path.join(REPO_DIR, "web", "public", "phrases", "manifest.json");

const CSS_LOADER_SOURCE = [
  "export async function load(url, context, nextLoad) {",
  "  if (url.endsWith('.css') || url.includes('.css?')) {",
  "    return { format: 'module', shortCircuit: true, source: 'export default {};' };",
  "  }",
  "  return nextLoad(url, context);",
  "}",
].join("\n");

register(`data:text${SLASH}javascript,${encodeURIComponent(CSS_LOADER_SOURCE)}`, pathToFileURL(TEST_FILE));

function setGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
  });
}

setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
setGlobal("React", React);

type ScheduledTimeout = {
  handle: ReturnType<typeof setTimeout>;
  fn: () => void;
  delay: number;
  cleared: boolean;
};

type ScheduledInterval = {
  handle: ReturnType<typeof setInterval>;
  fn: () => void;
  delay: number;
  cleared: boolean;
};

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;

const activeTimeouts = new Map<ReturnType<typeof setTimeout>, ScheduledTimeout>();
const activeIntervals = new Map<ReturnType<typeof setInterval>, ScheduledInterval>();

setGlobal(
  "setTimeout",
  (cb: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]): ReturnType<typeof setTimeout> => {
    const delay = typeof ms === "number" ? ms : 0;
    const invoke = () => cb(...rest);
    const handle = realSetTimeout(invoke, delay);
    (handle as unknown as { unref?: () => void }).unref?.();
    activeTimeouts.set(handle, { handle, fn: invoke, delay, cleared: false });
    return handle;
  },
);

setGlobal("clearTimeout", (handle?: ReturnType<typeof setTimeout>): void => {
  if (handle !== undefined) {
    const rec = activeTimeouts.get(handle);
    if (rec) rec.cleared = true;
    activeTimeouts.delete(handle);
  }
  realClearTimeout(handle);
});

setGlobal(
  "setInterval",
  (cb: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]): ReturnType<typeof setInterval> => {
    const delay = typeof ms === "number" ? ms : 0;
    const invoke = () => cb(...rest);
    const handle = realSetInterval(invoke, delay);
    (handle as unknown as { unref?: () => void }).unref?.();
    activeIntervals.set(handle, { handle, fn: invoke, delay, cleared: false });
    return handle;
  },
);

setGlobal("clearInterval", (handle?: ReturnType<typeof setInterval>): void => {
  if (handle !== undefined) {
    const rec = activeIntervals.get(handle);
    if (rec) rec.cleared = true;
    activeIntervals.delete(handle);
  }
  realClearInterval(handle);
});

after(() => {
  for (const h of activeTimeouts.keys()) realClearTimeout(h);
  for (const h of activeIntervals.keys()) realClearInterval(h);
  activeTimeouts.clear();
  activeIntervals.clear();
});

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

class MiniClassList {
  constructor(private owner: MiniElement) {}

  private tokens(): string[] {
    return this.owner.className.split(/\s+/).filter(Boolean);
  }

  private write(list: string[]): void {
    this.owner.className = list.join(" ");
  }

  add(...names: string[]): void {
    const set = new Set(this.tokens());
    for (const n of names) {
      if (n) set.add(n);
    }
    this.write([...set]);
  }

  remove(...names: string[]): void {
    const drop = new Set(names);
    this.write(this.tokens().filter((t) => !drop.has(t)));
  }

  contains(name: string): boolean {
    return this.tokens().includes(name);
  }

  toggle(name: string, force?: boolean): boolean {
    const has = this.contains(name);
    const next = force !== undefined ? force : !has;
    if (next) this.add(name);
    else this.remove(name);
    return next;
  }
}

type ListenerRecord = { fn: (ev: MiniEvent) => void; capture: boolean };

type MiniEvent = {
  type: string;
  key?: string;
  repeat?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
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
    key: "",
    repeat: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
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

function matchesSimpleSelector(el: MiniElement, rawSel: string): boolean {
  const sel = rawSel.trim();
  if (!sel) return false;
  if (sel === "[contenteditable=true]") {
    return el.getAttribute("contenteditable") === "true";
  }
  return el.tagName === sel.toUpperCase();
}

class MiniElement extends MiniNode {
  tagName: string;
  namespaceURI: string;
  style = new MiniStyle();
  classList: MiniClassList;
  attributes = new Map<string, string>();
  listeners = new Map<string, ListenerRecord[]>();
  width = 480;
  height = 270;
  readyState = 4;
  videoWidth = 640;
  videoHeight = 480;
  srcObject: unknown = null;
  paused = false;

  constructor(tag: string, namespaceURI: string, ownerDocument: MiniDocument) {
    const nodeName = namespaceURI === XHTML_NS ? tag.toUpperCase() : tag;
    super(1, nodeName, ownerDocument);
    this.tagName = nodeName;
    this.namespaceURI = namespaceURI;
    this.classList = new MiniClassList(this);
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

  get lang(): string {
    return this.attributes.get("lang") ?? "";
  }

  set lang(value: string) {
    if (value) this.attributes.set("lang", String(value));
    else this.attributes.delete("lang");
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

  async play(): Promise<void> {
    this.paused = false;
  }

  pause(): void {
    this.paused = true;
  }

  getContext(kind: string) {
    if (kind !== "2d") return null;
    return {
      imageSmoothingEnabled: false,
      fillStyle: "#000000",
      fillRect() {},
      clearRect() {},
      save() {},
      scale() {},
      restore() {},
      drawImage() {},
      getImageData(_x: number, _y: number, w: number, h: number) {
        const buf = new Uint8ClampedArray(w * h * 4);
        buf.fill(120);
        return { data: buf };
      },
    };
  }

  closest(selector: string): MiniElement | null {
    const parts = selector.split(",");
    let cur: MiniNode | null = this;
    while (cur && cur.nodeType === 1) {
      const el = cur as MiniElement;
      if (parts.some((p) => matchesSimpleSelector(el, p))) return el;
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
    const pathNodes: MiniNode[] = [];
    let current: MiniNode | null = this;
    while (current) {
      pathNodes.push(current);
      current = current.parentNode;
    }
    if (!ev.target) ev.target = this;
    for (let i = pathNodes.length - 1; i >= 0; i--) {
      const node = pathNodes[i] as MiniElement | MiniDocument;
      ev.currentTarget = node;
      for (const rec of node.listeners?.get(ev.type) ?? []) {
        if (rec.capture) rec.fn(ev);
      }
    }
    if (ev.bubbles !== false) {
      for (let i = 0; i < pathNodes.length; i++) {
        const node = pathNodes[i] as MiniElement | MiniDocument;
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

class MiniDocument extends MiniNode {
  activeElement: MiniElement | null = null;
  visibilityState: "visible" | "hidden" = "visible";
  hidden = false;
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

  dispatchEvent(ev: MiniEvent): boolean {
    if (!ev.target) ev.target = this;
    ev.currentTarget = this;
    for (const rec of [...(this.listeners.get(ev.type) ?? [])]) {
      rec.fn(ev);
    }
    return !ev.defaultPrevented;
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

const storageBacking = new Map<string, string>();
const sessionBacking = new Map<string, string>();
const issuedTracks: FakeMediaTrack[] = [];
const getUserMediaCalls: Array<{ video?: unknown; audio?: unknown }> = [];
const fetchUrls: string[] = [];
const spokenUtterances: string[] = [];
const playedAudioUrls: string[] = [];
let pcmBuffersStarted = 0;

class FakeAudioContext {
  state: "running" | "suspended" | "closed" = "running";
  currentTime = 0;
  destination = {};

  async resume(): Promise<void> {
    if (this.state !== "closed") this.state = "running";
  }

  async close(): Promise<void> {
    this.state = "closed";
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
      start() {
        pcmBuffersStarted++;
      },
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
  currentTime = 0;

  constructor(src = "") {
    this.src = src;
  }

  async play(): Promise<void> {
    playedAudioUrls.push(this.src);
  }

  pause(): void {}
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  readyState = 3;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(): void {}
  close(): void {}
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

const loc = {
  origin: ORIGIN,
  protocol: "https:",
  host: "holdup.example",
  pathname: `${SLASH}blindfold`,
  search: "",
  hash: "",
};

const hist = {
  state: null as unknown,
  replaceState() {},
  pushState() {},
  back() {},
};

const navigatorShim = {
  language: "en-US",
  onLine: true,
  userAgent: `Mozilla${SLASH}5.0 (Linux; Android 14) Chrome${SLASH}131.0.0.0`,
  vibrate: () => true,
  mediaDevices: {
    async getUserMedia(constraints: { video?: unknown; audio?: unknown }) {
      getUserMediaCalls.push(constraints);
      const tracks: FakeMediaTrack[] = [];
      if (constraints.video) {
        const vt = new FakeMediaTrack("video", "Phone Rear Camera");
        issuedTracks.push(vt);
        tracks.push(vt);
      }
      if (constraints.audio) {
        const at = new FakeMediaTrack("audio", "Phone Microphone");
        issuedTracks.push(at);
        tracks.push(at);
      }
      return new FakeMediaStream(tracks);
    },
    async enumerateDevices() {
      return [];
    },
    addEventListener() {},
    removeEventListener() {},
  },
  permissions: {
    async query() {
      return { state: "granted" };
    },
  },
};

const cachedPhraseManifestJson = fs.existsSync(PHRASE_MANIFEST_PATH)
  ? fs.readFileSync(PHRASE_MANIFEST_PATH, "utf8")
  : JSON.stringify({ model: "mock", generated: "2026-11-15T00:00:00Z", phrases: { en: {}, fi: {}, sv: {} } });

const fetchShim = async (input: unknown): Promise<Response> => {
  const url = String(input);
  fetchUrls.push(url);
  if (url.endsWith("/phrases/manifest.json")) {
    return new Response(cachedPhraseManifestJson, {
      status: 200,
      headers: { "content-type": `application${SLASH}json` },
    });
  }
  return new Response("{}", {
    status: 404,
    headers: { "content-type": `application${SLASH}json` },
  });
};

const windowListeners = new Map<string, ListenerRecord[]>();

const windowShim: Record<string, unknown> = {
  isSecureContext: true,
  document: doc,
  navigator: navigatorShim,
  location: loc,
  history: hist,
  AudioContext: FakeAudioContext,
  HTMLElement: MiniElement,
  HTMLInputElement: MiniElement,
  HTMLIFrameElement: class {},
  matchMedia(query: string) {
    return {
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    };
  },
  speechSynthesis: {
    cancel() {},
    speak(utterance: { text?: string; volume?: number }) {
      if ((utterance.volume ?? 1) > 0 && utterance.text && utterance.text.trim().length > 0) {
        spokenUtterances.push(utterance.text);
      }
    },
  },
  addEventListener(type: string, fn: (ev: MiniEvent) => void, opts?: boolean | { capture?: boolean }) {
    const capture = typeof opts === "boolean" ? opts : Boolean(opts?.capture);
    const list = windowListeners.get(type) ?? [];
    list.push({ fn, capture });
    windowListeners.set(type, list);
  },
  removeEventListener(type: string, fn: (ev: MiniEvent) => void, opts?: boolean | { capture?: boolean }) {
    const capture = typeof opts === "boolean" ? opts : Boolean(opts?.capture);
    const list = windowListeners.get(type);
    if (!list) return;
    windowListeners.set(
      type,
      list.filter((entry) => !(entry.fn === fn && entry.capture === capture)),
    );
  },
  dispatchEvent(ev: MiniEvent): boolean {
    if (!ev.target) ev.target = doc.body;
    ev.currentTarget = windowShim;
    for (const rec of [...(windowListeners.get(ev.type) ?? [])]) {
      rec.fn(ev);
    }
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
setGlobal("fetch", fetchShim);
setGlobal("WebSocket", FakeWebSocket);
setGlobal("AudioContext", FakeAudioContext);
setGlobal("SpeechSynthesisUtterance", FakeSpeechSynthesisUtterance);
setGlobal("Audio", FakeAudioElement);

const feedbackMod = await import("../src/lib/feedback.ts");
const blindfoldMod = await import("../src/screens/Blindfold.tsx");

const { onAnnounce } = feedbackMod;
const { Blindfold, HONESTY_BANNER_TEXT } = blindfoldMod;

function resetHarness(): void {
  for (const h of activeTimeouts.keys()) realClearTimeout(h);
  for (const h of activeIntervals.keys()) realClearInterval(h);
  activeTimeouts.clear();
  activeIntervals.clear();
  storageBacking.clear();
  sessionBacking.clear();
  issuedTracks.length = 0;
  getUserMediaCalls.length = 0;
  fetchUrls.length = 0;
  spokenUtterances.length = 0;
  playedAudioUrls.length = 0;
  pcmBuffersStarted = 0;
  FakeWebSocket.instances.length = 0;
  loc.pathname = `${SLASH}blindfold`;
  loc.search = "";
  loc.hash = "";
  doc.visibilityState = "visible";
  doc.hidden = false;
  doc.body.childNodes = [];
  doc.body.className = "";
  doc.documentElement.lang = "en";
  doc.activeElement = null;
  doc.title = "";
}

async function flushAsync(ms = 0): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
  if (ms > 0) {
    await new Promise<void>((resolve) => realSetTimeout(resolve, ms));
  }
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

async function mountBlindfold(t: test.TestContext) {
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  let mounted = true;

  await act(async () => {
    root.render(createElement(Blindfold));
    await flushAsync(10);
  });

  const unmount = async () => {
    if (!mounted) return;
    mounted = false;
    await act(async () => {
      root.unmount();
      await flushAsync(5);
    });
  };

  t.after(async () => {
    await unmount();
  });

  return {
    container,
    byTestId(testId: string): MiniElement {
      const found = container.findAll((el) => el.getAttribute("data-testid") === testId)[0];
      assert.ok(found, `Expected element [data-testid="${testId}"]`);
      return found;
    },
    queryTestId(testId: string): MiniElement | null {
      return container.findAll((el) => el.getAttribute("data-testid") === testId)[0] ?? null;
    },
    unmount,
  };
}

function dispatchWindowKey(key: string, target: MiniNode): MiniEvent {
  const ev = makeEvent("keydown", { key, target });
  (windowShim.dispatchEvent as (e: MiniEvent) => boolean)(ev);
  return ev;
}

function assertZeroCommentsAndSecrets(label: string, source: string, allowEscapedDash = false): void {
  assert.ok(source.length > 200, `${label} must be non-empty`);
  assert.equal(source.includes(LINE_COMMENT), false, `${label} must contain zero line comments`);
  assert.equal(source.includes(BLOCK_OPEN), false, `${label} must contain zero block comment openers`);
  assert.equal(source.includes(BLOCK_CLOSE), false, `${label} must contain zero block comment closers`);
  assert.equal(source.includes(HTML_COMMENT), false, `${label} must contain zero HTML comments`);
  assert.equal(source.includes(EM_DASH), false, `${label} must contain zero em dashes`);
  assert.equal(source.includes(EN_DASH), false, `${label} must contain zero en dashes`);
  if (!allowEscapedDash) {
    assert.equal(source.includes(ESCAPED_EM_DASH), false, `${label} must contain zero escaped em dashes`);
    assert.equal(source.includes(ESCAPED_EN_DASH), false, `${label} must contain zero escaped en dashes`);
  }
  for (const prefix of SECRET_PREFIXES) {
    assert.equal(source.includes(prefix), false, `${label} must not contain secret prefix "${prefix}"`);
  }
}

function assertPureAscii(label: string, source: string, allowedExtraCodes?: ReadonlySet<number>): void {
  for (let i = 0; i < source.length; i++) {
    const code = source.charCodeAt(i);
    const validAscii = code <= 127 && (code === 9 || code === 10 || code === 13 || code >= 32);
    const validExtra = allowedExtraCodes ? allowedExtraCodes.has(code) : false;
    assert.ok(
      validAscii || validExtra,
      `${label} must satisfy character hygiene; found charCode ${code} at index ${i}`,
    );
  }
}

function findChromiumExecutableInRoot(cacheRoot: string): string | undefined {
  if (!cacheRoot || !fs.existsSync(cacheRoot)) return undefined;
  let dirs: string[];
  try {
    dirs = fs.readdirSync(cacheRoot).sort().reverse();
  } catch {
    return undefined;
  }
  const relCandidates = [
    ["chrome-linux", "chrome"],
    ["chrome-linux64", "chrome"],
    ["chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
    ["chrome-mac-x64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
    ["chrome-mac", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
    ["chrome-linux", "headless_shell"],
    ["chrome-linux64", "chrome-headless-shell"],
  ];
  for (const dir of dirs) {
    if (!dir.startsWith("chromium-") && !dir.startsWith("chromium_headless_shell-")) continue;
    for (const rel of relCandidates) {
      const candidate = path.join(cacheRoot, dir, ...rel);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function resolveChromiumBinary(): string | undefined {
  const explicit = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH ?? "",
    SHARED_PLAYWRIGHT_DIR,
    path.join(os.homedir(), ".cache", "ms-playwright"),
    path.join(os.homedir(), "Library", "Caches", "ms-playwright"),
  ].filter(Boolean);
  for (const root of roots) {
    const bin = findChromiumExecutableInRoot(root);
    if (bin) return bin;
  }
  return undefined;
}

type CdpAxProperty = {
  name: string;
  value?: { value?: unknown };
};

type CdpAxNode = {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  properties?: CdpAxProperty[];
};

function axPropValue(node: CdpAxNode, propName: string): unknown {
  const found = (node.properties ?? []).find((p) => p.name === propName);
  return found?.value?.value;
}

describe("/blindfold eyes-closed TalkBack AXTree, cognitive load, consent, and bystander privacy contract", () => {
  test("enforces strict self and target hygiene: zero comments, zero em/en dashes, pure ASCII, and zero secret prefixes", () => {
    const selfSource = fs.readFileSync(TEST_FILE, "utf8");
    assertZeroCommentsAndSecrets("web/test/blindfoldTalkbackAndPrivacyA11y.test.ts (self)", selfSource);
    assertPureAscii("web/test/blindfoldTalkbackAndPrivacyA11y.test.ts (self)", selfSource);

    assert.equal(fs.existsSync(BLINDFOLD_TSX_PATH), true, "web/src/screens/Blindfold.tsx must exist");
    assert.equal(fs.existsSync(BLINDFOLD_CSS_PATH), true, "web/src/screens/blindfold.css must exist");
    assert.equal(fs.existsSync(PIXEL_SCENE_TS_PATH), true, "web/src/lib/pixelScene.ts must exist");

    const blindfoldSource = fs.readFileSync(BLINDFOLD_TSX_PATH, "utf8");
    const cssSource = fs.readFileSync(BLINDFOLD_CSS_PATH, "utf8");
    const pixelSceneSource = fs.readFileSync(PIXEL_SCENE_TS_PATH, "utf8");

    assertZeroCommentsAndSecrets("web/src/screens/Blindfold.tsx", blindfoldSource);
    assertPureAscii("web/src/screens/Blindfold.tsx", blindfoldSource);

    assertZeroCommentsAndSecrets("web/src/screens/blindfold.css", cssSource);
    assertPureAscii("web/src/screens/blindfold.css", cssSource);

    assertZeroCommentsAndSecrets("web/src/lib/pixelScene.ts", pixelSceneSource, true);
    assertPureAscii("web/src/lib/pixelScene.ts", pixelSceneSource, NORDIC_PIXEL_CODES);
  });

  test("window keydown Space skips interactive targets (BUTTON, A, SUMMARY, INPUT, SELECT, TEXTAREA) so focused controls never double-toggle", async (t) => {
    resetHarness();
    const blindfoldSource = fs.readFileSync(BLINDFOLD_TSX_PATH, "utf8");
    for (const tagToken of ["button", "a", "input", "select", "textarea", "summary"]) {
      assert.ok(
        blindfoldSource.includes(tagToken),
        `isInteractiveTarget in Blindfold.tsx must guard interactive selector "${tagToken}"`,
      );
    }

    const ui = await mountBlindfold(t);
    const primaryBtn = ui.byTestId("blindfold-primary-btn");
    const srToggleBtn = ui.byTestId("blindfold-sr-mode");
    const skipLink = ui.container.findAll((el) => el.tagName === "A")[0];
    const clipsSummary = ui.container.findAll((el) => el.tagName === "SUMMARY")[0];
    assert.ok(skipLink, "Expected skip link <a>");
    assert.ok(clipsSummary, "Expected clips drawer <summary>");

    const syntheticInput = doc.createElement("input");
    const syntheticSelect = doc.createElement("select");
    const syntheticTextarea = doc.createElement("textarea");
    const nestedSpanInsideButton = doc.createElement("span");
    primaryBtn.appendChild(nestedSpanInsideButton);
    ui.container.appendChild(syntheticInput);
    ui.container.appendChild(syntheticSelect);
    ui.container.appendChild(syntheticTextarea);

    const interactiveTargets: Array<[string, MiniElement]> = [
      ["BUTTON (primary)", primaryBtn],
      ["BUTTON (sr-mode)", srToggleBtn],
      ["nested SPAN inside BUTTON", nestedSpanInsideButton],
      ["A", skipLink],
      ["SUMMARY", clipsSummary],
      ["INPUT", syntheticInput],
      ["SELECT", syntheticSelect],
      ["TEXTAREA", syntheticTextarea],
    ];

    for (const [label, targetEl] of interactiveTargets) {
      targetEl.focus();
      let ev: MiniEvent | null = null;
      await act(async () => {
        ev = dispatchWindowKey(" ", targetEl);
        await flushAsync(5);
      });
      assert.equal(ev!.defaultPrevented, false, `Space on ${label} must not preventDefault in window keydown`);
      assert.equal(getUserMediaCalls.length, 0, `Space on ${label} must not start camera`);
      assert.equal(ui.queryTestId("camera-on-badge"), null, `Camera must stay off after Space on ${label}`);
      assert.equal(srToggleBtn.getAttribute("aria-pressed"), "false", `Space on ${label} must not double-toggle srMode`);
    }

    const mainEl = ui.container.findAll((el) => el.tagName === "MAIN")[0];
    assert.ok(mainEl, "Expected <main id=blindfold-main>");

    let startEv: MiniEvent | null = null;
    await act(async () => {
      startEv = dispatchWindowKey(" ", mainEl);
      await flushAsync(20);
    });
    assert.equal(startEv!.defaultPrevented, true, "Space on non-interactive <main> must preventDefault");
    assert.equal(getUserMediaCalls.length, 1, "Space on <main> must start camera once");
    assert.ok(ui.queryTestId("camera-on-badge"), "Expected [data-testid=camera-on-badge] when camera is on");

    let stopEv: MiniEvent | null = null;
    await act(async () => {
      stopEv = dispatchWindowKey(" ", mainEl);
      await flushAsync(20);
    });
    assert.equal(stopEv!.defaultPrevented, true, "Second Space on <main> must stop camera");
    assert.equal(ui.queryTestId("camera-on-badge"), null, "Camera badge must disappear on Space stop");
    assert.equal(issuedTracks[0]?.readyState, "ended");
  });

  test("Escape immediately stops active camera, plays camera_off, and restores focus to [data-testid=blindfold-primary-btn]", async (t) => {
    resetHarness();
    const announcements: Array<{ msg: string; politeness: "polite" | "assertive" }> = [];
    const off = onAnnounce((msg, politeness) => announcements.push({ msg, politeness }));
    t.after(off);

    const ui = await mountBlindfold(t);
    const primaryBtn = ui.byTestId("blindfold-primary-btn");
    const repeatBtn = ui.byTestId("blindfold-repeat-btn");

    await act(async () => {
      primaryBtn.click();
      await flushAsync(25);
    });

    assert.equal(issuedTracks.length, 1);
    assert.equal(issuedTracks[0].readyState, "live");
    assert.ok(ui.queryTestId("camera-on-badge"), "Expected camera-on-badge while running");

    repeatBtn.focus();
    assert.equal(doc.activeElement, repeatBtn);
    announcements.length = 0;
    playedAudioUrls.length = 0;
    spokenUtterances.length = 0;

    let escEv: MiniEvent | null = null;
    await act(async () => {
      escEv = dispatchWindowKey("Escape", repeatBtn);
      await flushAsync(75);
    });

    assert.equal(escEv!.defaultPrevented, true, "Escape while camera is on must preventDefault");
    assert.equal(issuedTracks[0].readyState, "ended", "Escape must immediately stop MediaStreamTrack");
    assert.ok(issuedTracks[0].stopCalls >= 1);
    const videoEl = ui.container.findAll((el) => el.tagName === "VIDEO")[0];
    assert.equal(videoEl?.srcObject, null, "Escape must clear video.srcObject");
    assert.equal(ui.queryTestId("camera-on-badge"), null, "Escape must clear camera-on-badge");

    const playedCameraOff =
      playedAudioUrls.some((u) => u.includes("/phrases/en/camera_off")) ||
      spokenUtterances.includes("Camera off.");
    assert.equal(playedCameraOff, true, "Escape must play camera_off phrase clip or fallback speech");

    const cameraOffClipBtn = ui.container.findAll((el) => el.getAttribute("data-clip-id") === "camera_off")[0];
    assert.ok(cameraOffClipBtn?.classList.contains("active"), "camera_off clip must be recorded as activeClipId");
    assert.ok(
      announcements.some((a) => a.msg === "Camera off." && a.politeness === "polite"),
      "Escape must announce Camera off. via Announcer",
    );
    assert.equal(doc.activeElement, primaryBtn, "Escape must restore focus to [data-testid=blindfold-primary-btn]");

    const simBtn = ui.container.findAll((el) => el.hasAttribute("data-sim-box"))[0];
    assert.ok(simBtn, "Expected simulated box button");
    await act(async () => {
      simBtn.click();
      await flushAsync(25);
    });
    assert.ok(ui.queryTestId("blindfold-verdict"), "Expected simulated box verdict");

    await act(async () => {
      dispatchWindowKey("Escape", repeatBtn);
      await flushAsync(15);
    });
    assert.equal(ui.queryTestId("blindfold-verdict"), null, "Escape must dismiss open verdict");
    assert.equal(doc.activeElement, primaryBtn, "Escape on verdict must restore focus to primary button");
  });

  test("R shortcut repeats last spoken cue or verdict, and 1/2/3 shortcuts map to Round 2 match/warning/unsure", async (t) => {
    resetHarness();
    const announcements: Array<{ msg: string; politeness: "polite" | "assertive" }> = [];
    const off = onAnnounce((msg, politeness) => announcements.push({ msg, politeness }));
    t.after(off);

    const ui = await mountBlindfold(t);
    const mainEl = ui.container.findAll((el) => el.tagName === "MAIN")[0]!;

    announcements.length = 0;
    await act(async () => {
      const ev = dispatchWindowKey("r", mainEl);
      assert.equal(ev.defaultPrevented, true);
      await flushAsync(25);
    });
    assert.equal(announcements.length, 1);
    assert.match(announcements[0].msg, /Camera off\. Press Start or Space/i);

    const simBtn = ui.container.findAll((el) => el.hasAttribute("data-sim-box"))[0]!;
    await act(async () => {
      simBtn.click();
      await flushAsync(25);
    });
    const verdictBox = ui.byTestId("blindfold-verdict");
    const speechEl = verdictBox.findAll((el) => el.classList.contains("bf-verdict-speech"))[0];
    assert.ok(speechEl && speechEl.textContent.length > 0, "Expected non-empty verdict speech");
    const expectedSpeech = speechEl.textContent;

    announcements.length = 0;
    playedAudioUrls.length = 0;
    spokenUtterances.length = 0;
    await act(async () => {
      const ev = dispatchWindowKey("R", mainEl);
      assert.equal(ev.defaultPrevented, true);
      await flushAsync(25);
    });
    assert.deepEqual(announcements, [{ msg: expectedSpeech, politeness: "polite" }]);
    assert.ok(
      playedAudioUrls.length + spokenUtterances.length >= 1,
      "R repeat must replay spoken verdict or clip when srMode is off",
    );

    const round2Tab = ui.byTestId("tab-round-2");
    await act(async () => {
      round2Tab.click();
      await flushAsync(20);
    });

    const choiceMatch = ui.byTestId("choice-match");
    const choiceWarning = ui.byTestId("choice-warning");
    const choiceUnsure = ui.byTestId("choice-unsure");
    assert.equal(choiceMatch.getAttribute("aria-pressed"), "false");
    assert.equal(choiceWarning.getAttribute("aria-pressed"), "false");
    assert.equal(choiceUnsure.getAttribute("aria-pressed"), "false");

    const blockedOnBtn = dispatchWindowKey("1", choiceMatch);
    assert.equal(blockedOnBtn.defaultPrevented, false, "Digit shortcut on focused button must not double-trigger");
    assert.equal(choiceMatch.getAttribute("aria-pressed"), "false");

    await act(async () => {
      const ev1 = dispatchWindowKey("1", mainEl);
      assert.equal(ev1.defaultPrevented, true);
      await flushAsync(25);
    });
    assert.equal(choiceMatch.getAttribute("aria-pressed"), "true");
    assert.equal(choiceWarning.getAttribute("aria-pressed"), "false");
    assert.equal(choiceUnsure.getAttribute("aria-pressed"), "false");
    assert.ok(ui.queryTestId("spot-reveal"), "Pressing 1 must reveal HoldUp safety comparison");

    await act(async () => {
      const ev2 = dispatchWindowKey("2", mainEl);
      assert.equal(ev2.defaultPrevented, true);
      await flushAsync(25);
    });
    assert.equal(choiceMatch.getAttribute("aria-pressed"), "false");
    assert.equal(choiceWarning.getAttribute("aria-pressed"), "true");
    assert.equal(choiceUnsure.getAttribute("aria-pressed"), "false");

    await act(async () => {
      const ev3 = dispatchWindowKey("3", mainEl);
      assert.equal(ev3.defaultPrevented, true);
      await flushAsync(25);
    });
    assert.equal(choiceMatch.getAttribute("aria-pressed"), "false");
    assert.equal(choiceWarning.getAttribute("aria-pressed"), "false");
    assert.equal(choiceUnsure.getAttribute("aria-pressed"), "true");
  });

  test("[data-testid=blindfold-sr-mode] suppresses overlapping speech/clip/chime audio while preserving <Announcer />, and .bf-cue-strip sets aria-live=off", async (t) => {
    resetHarness();
    assert.equal(fs.existsSync(ANNOUNCER_TSX_PATH), true, "Announcer.tsx must exist");
    const blindfoldSource = fs.readFileSync(BLINDFOLD_TSX_PATH, "utf8");
    assert.ok(
      blindfoldSource.includes('className="bf-cue-strip" aria-live="off"'),
      ".bf-cue-strip must explicitly declare aria-live=\"off\"",
    );

    const announcements: Array<{ msg: string; politeness: "polite" | "assertive" }> = [];
    const off = onAnnounce((msg, politeness) => announcements.push({ msg, politeness }));
    t.after(off);

    const ui = await mountBlindfold(t);

    const cueStrip = ui.container.findAll((el) => el.classList.contains("bf-cue-strip"))[0];
    assert.ok(cueStrip, "Expected .bf-cue-strip in Round 1");
    assert.equal(cueStrip.getAttribute("aria-live"), "off", ".bf-cue-strip must keep aria-live=off");

    const assertSingleSpeakerLiveRegions = () => {
      const activeLiveNodes = ui.container.findAll((el) => {
        const live = el.getAttribute("aria-live");
        const role = el.getAttribute("role");
        return (live !== null && live !== "off") || role === "status" || role === "alert";
      });
      assert.equal(
        activeLiveNodes.length,
        2,
        `Expected exactly 2 <Announcer /> live regions, got ${activeLiveNodes.length}`,
      );
      for (const node of activeLiveNodes) {
        assert.equal(node.classList.contains("sr-only"), true, "Active live regions must belong to <Announcer />");
        assert.equal(node.getAttribute("aria-atomic"), "true", "Active live regions must set aria-atomic=true");
      }
    };

    assertSingleSpeakerLiveRegions();

    await act(async () => {
      ui.byTestId("blindfold-primary-btn").click();
      await flushAsync(25);
    });
    assertSingleSpeakerLiveRegions();

    const frameLoop = [...activeIntervals.values()].find((it) => !it.cleared && it.delay === 280);
    assert.ok(frameLoop, "Expected 280ms local frame coaching interval while camera is on");
    announcements.length = 0;
    await act(async () => {
      frameLoop.fn();
      frameLoop.fn();
      frameLoop.fn();
      await flushAsync(10);
    });
    assert.ok(
      announcements.length <= 1,
      `Coaching ticks within ANNOUNCE_GAP_MS must not flood <Announcer />; got ${announcements.length}`,
    );

    await act(async () => {
      ui.byTestId("blindfold-primary-btn").click();
      await flushAsync(25);
    });

    const srBtn = ui.byTestId("blindfold-sr-mode");
    assert.equal(srBtn.getAttribute("aria-pressed"), "false");

    playedAudioUrls.length = 0;
    spokenUtterances.length = 0;
    await act(async () => {
      ui.byTestId("blindfold-repeat-btn").click();
      await flushAsync(25);
    });
    assert.ok(
      playedAudioUrls.length + spokenUtterances.length >= 1,
      "When srMode is OFF, Repeat must produce spoken or clip audio",
    );

    await act(async () => {
      srBtn.click();
      await flushAsync(10);
    });
    assert.equal(srBtn.getAttribute("aria-pressed"), "true", "Clicking blindfold-sr-mode must set aria-pressed=true");

    resetAudioSpiesOnly();
    announcements.length = 0;

    const simBoxes = ui.container.findAll((el) => el.hasAttribute("data-sim-box"));
    assert.ok(simBoxes.length >= 5, `Expected simulated boxes, got ${simBoxes.length}`);
    const clipBtn = ui.container.findAll((el) => el.getAttribute("data-clip-id") === "cue_closer")[0];
    assert.ok(clipBtn, "Expected [data-clip-id=cue_closer]");

    await act(async () => {
      simBoxes[0].click();
      await flushAsync(70);
    });
    assertSingleSpeakerLiveRegions();

    await act(async () => {
      ui.byTestId("blindfold-repeat-btn").click();
      await flushAsync(70);
    });
    await act(async () => {
      clipBtn.click();
      await flushAsync(70);
    });

    assert.equal(
      playedAudioUrls.length,
      0,
      "When srMode is ON, zero pre-rendered phrase clips may play over screen reader output",
    );
    assert.equal(
      spokenUtterances.length,
      0,
      "When srMode is ON, zero speechSynthesis utterances may collide with <Announcer />",
    );
    assert.equal(pcmBuffersStarted, 0, "When srMode is ON, PCM unlock chime must be suppressed");
    assert.ok(announcements.length >= 3, "When srMode is ON, <Announcer /> must still receive every cue and verdict");

    const politeRegion = ui.container.findAll((el) => el.getAttribute("aria-live") === "polite")[0]!;
    assert.equal(politeRegion.textContent, "A bit closer.");

    await act(async () => {
      ui.byTestId("tab-round-2").click();
      await flushAsync(20);
    });
    await act(async () => {
      ui.byTestId("choice-warning").click();
      await flushAsync(25);
    });
    assertSingleSpeakerLiveRegions();
    assert.equal(playedAudioUrls.length, 0);
    assert.equal(spokenUtterances.length, 0);
  });

  test("enforces camera default off, video-only audio:false, [data-testid=camera-on-badge], AUTO_STOP_MS=45_000, and track cleanup across all 6 lifecycle exits", async (t) => {
    resetHarness();
    assert.equal(fs.existsSync(MEDIA_TS_PATH), true, "web/src/lib/media.ts must exist");
    const blindfoldSource = fs.readFileSync(BLINDFOLD_TSX_PATH, "utf8");
    const mediaSource = fs.readFileSync(MEDIA_TS_PATH, "utf8");

    assert.ok(blindfoldSource.includes("const AUTO_STOP_MS = 45_000;"), "Blindfold.tsx must set AUTO_STOP_MS = 45_000");
    assert.equal(blindfoldSource.includes("getMic"), false, "Blindfold.tsx must never import or call getMic");
    assert.match(mediaSource, /function\s+getCamera[\s\S]{0,260}audio:\s*false/, "getCamera() must enforce audio: false");

    const announcements: Array<{ msg: string; politeness: "polite" | "assertive" }> = [];
    const off = onAnnounce((msg, politeness) => announcements.push({ msg, politeness }));
    t.after(off);

    const ui = await mountBlindfold(t);
    const primaryBtn = ui.byTestId("blindfold-primary-btn");
    const videoEl = () => ui.container.findAll((el) => el.tagName === "VIDEO")[0]!;

    assert.equal(getUserMediaCalls.length, 0, "Camera must default to off on mount with 0 getUserMedia calls");
    assert.equal(ui.queryTestId("camera-on-badge"), null, "camera-on-badge must not render when cameraState is off");

    await act(async () => {
      primaryBtn.click();
      await flushAsync(25);
    });
    assert.equal(getUserMediaCalls.length, 1);
    assert.equal(getUserMediaCalls[0].audio, false, "getUserMedia must request audio: false (video-only)");
    assert.equal(Boolean(getUserMediaCalls[0].video), true, "getUserMedia must request video constraints");
    assert.equal(issuedTracks.filter((tr) => tr.kind === "audio").length, 0, "Zero audio tracks may be created");

    const badgeEn = ui.byTestId("camera-on-badge");
    assert.ok(badgeEn.textContent.includes("CAMERA ON - LOCAL ONLY"));

    const fiBtn = ui.container.findAll((el) => el.getAttribute("data-lang-btn") === "fi")[0]!;
    await act(async () => {
      fiBtn.click();
      await flushAsync(10);
    });
    assert.ok(ui.byTestId("camera-on-badge").textContent.includes("KAMERA PAALLA - VAIN PAIKALLINEN"));

    const svBtn = ui.container.findAll((el) => el.getAttribute("data-lang-btn") === "sv")[0]!;
    await act(async () => {
      svBtn.click();
      await flushAsync(10);
    });
    assert.ok(ui.byTestId("camera-on-badge").textContent.includes("KAMERA PA - ENDAST LOKALT"));

    const enBtn = ui.container.findAll((el) => el.getAttribute("data-lang-btn") === "en")[0]!;
    await act(async () => {
      enBtn.click();
      await flushAsync(10);
    });

    const autoStopEntry = [...activeTimeouts.values()].find((tm) => !tm.cleared && tm.delay === 45_000);
    assert.ok(autoStopEntry, "Starting camera must arm AUTO_STOP_MS = 45_000 timeout");
    const trackAuto = issuedTracks[issuedTracks.length - 1];
    assert.equal(trackAuto.readyState, "live");

    announcements.length = 0;
    await act(async () => {
      autoStopEntry.fn();
      await flushAsync(30);
    });
    assert.equal(trackAuto.readyState, "ended", "45_000ms idle auto-stop must stop MediaStreamTrack");
    assert.ok(trackAuto.stopCalls >= 1);
    assert.equal(videoEl().srcObject, null, "45_000ms auto-stop must clear video.srcObject");
    assert.equal(ui.queryTestId("camera-on-badge"), null, "45_000ms auto-stop must hide camera-on-badge");
    assert.ok(announcements.some((a) => a.msg === "Camera off."));
    assert.equal(doc.activeElement, primaryBtn, "45_000ms auto-stop must restore focus to primary button");

    const startFreshStream = async (): Promise<FakeMediaTrack> => {
      const prevCount = issuedTracks.length;
      await act(async () => {
        ui.byTestId("blindfold-primary-btn").click();
        await flushAsync(25);
      });
      assert.equal(issuedTracks.length, prevCount + 1);
      const track = issuedTracks[issuedTracks.length - 1];
      assert.equal(track.readyState, "live");
      assert.ok(ui.queryTestId("camera-on-badge"));
      return track;
    };

    const trackStopBtn = await startFreshStream();
    await act(async () => {
      ui.byTestId("blindfold-primary-btn").click();
      await flushAsync(20);
    });
    assert.equal(trackStopBtn.readyState, "ended", "Stop button must stop MediaStreamTrack");
    assert.equal(videoEl().srcObject, null);
    assert.equal(ui.queryTestId("camera-on-badge"), null);

    const trackEsc = await startFreshStream();
    await act(async () => {
      dispatchWindowKey("Escape", doc.body);
      await flushAsync(20);
    });
    assert.equal(trackEsc.readyState, "ended", "Escape must stop MediaStreamTrack");
    assert.equal(videoEl().srcObject, null);
    assert.equal(ui.queryTestId("camera-on-badge"), null);

    const trackRoundSwitch = await startFreshStream();
    await act(async () => {
      ui.byTestId("tab-round-2").click();
      await flushAsync(20);
    });
    assert.equal(trackRoundSwitch.readyState, "ended", "Round 1->2 switch must stop MediaStreamTrack");
    assert.equal(ui.queryTestId("camera-on-badge"), null);

    await act(async () => {
      ui.byTestId("tab-round-1").click();
      await flushAsync(20);
    });

    const trackVisHidden = await startFreshStream();
    doc.visibilityState = "hidden";
    doc.hidden = true;
    await act(async () => {
      doc.dispatchEvent(makeEvent("visibilitychange", { target: doc }));
      await flushAsync(20);
    });
    assert.equal(trackVisHidden.readyState, "ended", "visibilitychange (hidden) must stop MediaStreamTrack");
    assert.equal(videoEl().srcObject, null);
    assert.equal(ui.queryTestId("camera-on-badge"), null);
    doc.visibilityState = "visible";
    doc.hidden = false;

    const trackPageHide = await startFreshStream();
    await act(async () => {
      (windowShim.dispatchEvent as (e: MiniEvent) => boolean)(makeEvent("pagehide", { target: doc }));
      await flushAsync(20);
    });
    assert.equal(trackPageHide.readyState, "ended", "pagehide must stop MediaStreamTrack");
    assert.equal(videoEl().srcObject, null);
    assert.equal(ui.queryTestId("camera-on-badge"), null);

    const trackUnmount = await startFreshStream();
    await ui.unmount();
    assert.equal(trackUnmount.readyState, "ended", "Component unmount must stop MediaStreamTrack");
    assert.ok(trackUnmount.stopCalls >= 1);
  });

  test("enforces honesty disclosure region and zero /live, /api/verify, /ingest/frame, or external network calls", async (t) => {
    resetHarness();
    const blindfoldSource = fs.readFileSync(BLINDFOLD_TSX_PATH, "utf8");
    const pixelSceneSource = fs.readFileSync(PIXEL_SCENE_TS_PATH, "utf8");

    for (const forbidden of [
      "/live",
      "/api/verify",
      "/ingest/frame",
      "/api/tts",
      "new WebSocket",
      "navigator.sendBeacon",
      `http:${SLASH2}`,
      `https:${SLASH2}`,
      `ws:${SLASH2}`,
      `wss:${SLASH2}`,
    ]) {
      assert.equal(
        blindfoldSource.includes(forbidden),
        false,
        `Blindfold.tsx must not reference "${forbidden}"`,
      );
      assert.equal(
        pixelSceneSource.includes(forbidden),
        false,
        `pixelScene.ts must not reference "${forbidden}"`,
      );
    }

    assert.equal(HONESTY_BANNER_TEXT, EXPECTED_HONESTY_BANNER);

    const ui = await mountBlindfold(t);

    for (const lang of EXPECTED_LANGS) {
      const langBtn = ui.container.findAll((el) => el.getAttribute("data-lang-btn") === lang)[0]!;
      await act(async () => {
        langBtn.click();
        await flushAsync(10);
      });
      const banner = ui.byTestId("honesty-banner");
      assert.equal(banner.getAttribute("role"), "region");
      assert.equal(banner.getAttribute("aria-label"), "Demo disclosure");
      assert.ok(
        banner.textContent.includes(EXPECTED_HONESTY_BANNER),
        `Honesty banner must display "${EXPECTED_HONESTY_BANNER}" in lang=${lang}`,
      );
    }

    await act(async () => {
      ui.byTestId("blindfold-primary-btn").click();
      await flushAsync(25);
    });
    const frameLoop = [...activeIntervals.values()].find((it) => !it.cleared && it.delay === 280);
    if (frameLoop) {
      await act(async () => {
        frameLoop.fn();
        await flushAsync(15);
      });
    }

    const simBtn = ui.container.findAll((el) => el.hasAttribute("data-sim-box"))[0]!;
    await act(async () => {
      simBtn.click();
      await flushAsync(25);
    });

    const logBtn = ui.container.findAll(
      (el) => el.tagName === "BUTTON" && (el.textContent === "I took it" || el.textContent === "Log another dose"),
    )[0];
    if (logBtn) {
      await act(async () => {
        logBtn.click();
        await flushAsync(15);
      });
    }

    await act(async () => {
      ui.byTestId("tab-round-2").click();
      await flushAsync(15);
    });
    assert.ok(ui.byTestId("honesty-banner").textContent.includes(EXPECTED_HONESTY_BANNER));

    await act(async () => {
      ui.byTestId("choice-match").click();
      await flushAsync(20);
    });
    const nextBtn = ui.queryTestId("spot-next-btn");
    if (nextBtn) {
      await act(async () => {
        nextBtn.click();
        await flushAsync(15);
      });
    }

    assert.equal(FakeWebSocket.instances.length, 0, "/blindfold must open 0 WebSockets");
    for (const url of fetchUrls) {
      assert.equal(url.includes("/live"), false, `Forbidden /live fetch: ${url}`);
      assert.equal(url.includes("/api/verify"), false, `Forbidden /api/verify fetch: ${url}`);
      assert.equal(url.includes("/ingest/frame"), false, `Forbidden /ingest/frame fetch: ${url}`);
      assert.equal(url.includes("/api/"), false, `Forbidden /api/ endpoint fetch: ${url}`);
      assert.equal(url.includes(SLASH2), false, `Forbidden external network URL: ${url}`);
      assert.equal(url, "/phrases/manifest.json", `Unexpected fetch path on /blindfold: ${url}`);
    }
  });

  test("verifies headless Chromium CDP Accessibility.getFullAXTree has 0 unnamed button/link/region/img/progressbar nodes across EN/FI/SV and Round 1/2 plus aria-pressed transitions", async (t) => {
    const sharedPwExists = fs.existsSync(SHARED_PLAYWRIGHT_DIR);
    if (!process.env.PLAYWRIGHT_BROWSERS_PATH && sharedPwExists) {
      process.env.PLAYWRIGHT_BROWSERS_PATH = SHARED_PLAYWRIGHT_DIR;
    }

    const chromiumExecutable = resolveChromiumBinary();
    if (sharedPwExists) {
      assert.ok(
        chromiumExecutable,
        "Shared /tmp/fleet-root/shared/ms-playwright exists, so headless Chromium must run without skipping",
      );
    } else if (!chromiumExecutable) {
      t.skip("Playwright Chromium binary not found on host; skipping live CDP AXTree check");
      return;
    }

    const prevGeminiKey = process.env.GEMINI_API_KEY;
    const prevElevenKey = process.env.ELEVENLABS_API_KEY;
    process.env.GEMINI_API_KEY = "";
    process.env.ELEVENLABS_API_KEY = "";

    const tmpViteCache = fs.mkdtempSync(path.join(os.tmpdir(), "holdup-bf-ax-vite-"));
    const { createServer } = await import("vite");
    const { chromium } = await import("playwright");

    const webRoot = path.join(REPO_DIR, "web");
    const viteServer = await createServer({
      root: webRoot,
      configFile: false,
      cacheDir: tmpViteCache,
      logLevel: "silent",
      esbuild: {
        jsx: "automatic",
      },
      server: {
        host: "127.0.0.1",
        port: 0,
        strictPort: false,
        fs: { allow: [REPO_DIR] },
      },
    });

    let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;

    try {
      await viteServer.listen();
      const address = viteServer.httpServer?.address();
      assert.ok(address && typeof address === "object", "Expected Vite HTTP server bound address");
      const baseOrigin = `http:${SLASH2}127.0.0.1:${address.port}`;

      browser = await chromium.launch({
        headless: true,
        executablePath: chromiumExecutable,
      });

      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        reducedMotion: "reduce",
      });
      const page = await context.newPage();

      const observedRequests: string[] = [];
      const observedWebSockets: string[] = [];
      page.on("request", (req) => {
        observedRequests.push(req.url());
      });
      page.on("websocket", (ws) => {
        observedWebSockets.push(ws.url());
      });

      const cdp = await context.newCDPSession(page);
      await cdp.send("Accessibility.enable");

      await page.goto(`${baseOrigin}${SLASH}blindfold`, { waitUntil: "networkidle" });
      await page.locator('[data-testid="honesty-banner"]').waitFor({ state: "visible" });

      const NAMED_REQUIRED_ROLES = new Set([
        "button",
        "link",
        "region",
        "img",
        "image",
        "canvas",
        "progressbar",
        "meter",
      ]);

      const inspectAxSnapshot = async (stateLabel: string) => {
        const { nodes } = (await cdp.send("Accessibility.getFullAXTree")) as { nodes: CdpAxNode[] };
        const visible = nodes.filter((n) => !n.ignored);
        const targetRoleNodes = visible.filter((n) => NAMED_REQUIRED_ROLES.has(String(n.role?.value ?? "")));
        const unnamed = targetRoleNodes.filter((n) => String(n.name?.value ?? "").trim().length === 0);

        assert.equal(
          unnamed.length,
          0,
          `AXTree state "${stateLabel}" must have 0 unnamed button/link/region/img/progressbar nodes; found: ${JSON.stringify(
            unnamed.map((u) => ({ role: u.role?.value, nodeId: u.nodeId })),
          )}`,
        );

        const countByRole = (roles: string[]) =>
          visible.filter((n) => roles.includes(String(n.role?.value ?? ""))).length;

        assert.ok(countByRole(["button"]) >= 6, `Expected >= 6 named buttons in "${stateLabel}"`);
        assert.ok(countByRole(["link"]) >= 2, `Expected >= 2 named links in "${stateLabel}"`);
        assert.ok(countByRole(["region"]) >= 3, `Expected >= 3 named regions in "${stateLabel}"`);
        assert.ok(countByRole(["img", "image", "canvas"]) >= 1, `Expected >= 1 named img node in "${stateLabel}"`);

        return visible;
      };

      const readAxPressedByName = async (substr: string): Promise<string> => {
        const { nodes } = (await cdp.send("Accessibility.getFullAXTree")) as { nodes: CdpAxNode[] };
        const btn = nodes.find(
          (n) =>
            !n.ignored &&
            n.role?.value === "button" &&
            String(n.name?.value ?? "").includes(substr),
        );
        assert.ok(btn, `Expected AXTree button whose accessible name includes "${substr}"`);
        return String(axPropValue(btn, "pressed"));
      };

      for (const lang of EXPECTED_LANGS) {
        await page.locator(`[data-lang-btn="${lang}"]`).click();
        await page.locator('[data-testid="tab-round-1"]').click();
        const r1Nodes = await inspectAxSnapshot(`round1-${lang}`);
        const hasMeterOrProgress = r1Nodes.some((n) => {
          const r = String(n.role?.value ?? "");
          return r === "meter" || r === "progressbar";
        });
        assert.equal(hasMeterOrProgress, true, `Round 1 (${lang}) must expose named meter/progressbar in AXTree`);

        await page.locator('[data-testid="tab-round-2"]').click();
        const r2Nodes = await inspectAxSnapshot(`round2-${lang}`);
        const r2Imgs = r2Nodes.filter((n) => ["img", "image", "canvas"].includes(String(n.role?.value ?? "")));
        assert.ok(r2Imgs.length >= 2, `Round 2 (${lang}) must expose >= 2 named img nodes (canvas + card image)`);
      }

      await page.locator('[data-lang-btn="en"]').click();
      await page.locator('[data-testid="tab-round-1"]').click();

      assert.equal(await readAxPressedByName("EN -"), "true");
      assert.equal(await readAxPressedByName("FI -"), "false");
      assert.equal(await readAxPressedByName("SV -"), "false");

      await page.locator('[data-lang-btn="fi"]').click();
      assert.equal(await readAxPressedByName("EN -"), "false");
      assert.equal(await readAxPressedByName("FI -"), "true");

      await page.locator('[data-lang-btn="sv"]').click();
      assert.equal(await readAxPressedByName("FI -"), "false");
      assert.equal(await readAxPressedByName("SV -"), "true");

      await page.locator('[data-lang-btn="en"]').click();

      assert.equal(await readAxPressedByName("Screen reader quiet audio"), "false");
      await page.locator('[data-testid="blindfold-sr-mode"]').click();
      assert.equal(await readAxPressedByName("Screen reader quiet audio"), "true");
      await page.locator('[data-testid="blindfold-sr-mode"]').click();
      assert.equal(await readAxPressedByName("Screen reader quiet audio"), "false");

      assert.equal(await readAxPressedByName("Blindfold view ON"), "true");
      await page.locator('[data-testid="blindfold-curtain-btn"]').click();
      assert.equal(await readAxPressedByName("Blindfold view OFF"), "false");
      await page.locator('[data-testid="blindfold-curtain-btn"]').click();
      assert.equal(await readAxPressedByName("Blindfold view ON"), "true");

      await page.locator("[data-sim-box]").first().click();
      await page.locator('[data-testid="blindfold-verdict"]').waitFor({ state: "visible" });
      await inspectAxSnapshot("round1-en-verdict-open");

      assert.equal(await readAxPressedByName("Round 1: Blindfold Camera"), "true");
      assert.equal(await readAxPressedByName("Round 2: Spot the Danger"), "false");

      await page.locator('[data-testid="tab-round-2"]').click();
      assert.equal(await readAxPressedByName("Round 1: Blindfold Camera"), "false");
      assert.equal(await readAxPressedByName("Round 2: Spot the Danger"), "true");

      assert.equal(await readAxPressedByName("Safe (1)"), "false");
      assert.equal(await readAxPressedByName("Danger (2)"), "false");
      assert.equal(await readAxPressedByName("Not sure - abstain (3)"), "false");

      await page.locator('[data-testid="choice-match"]').click();
      await page.locator('[data-testid="spot-reveal"]').waitFor({ state: "visible" });
      assert.equal(await readAxPressedByName("Safe (1)"), "true");
      assert.equal(await readAxPressedByName("Danger (2)"), "false");
      assert.equal(await readAxPressedByName("Not sure - abstain (3)"), "false");
      await inspectAxSnapshot("round2-en-reveal-open");

      await page.locator('[data-testid="choice-warning"]').click();
      assert.equal(await readAxPressedByName("Safe (1)"), "false");
      assert.equal(await readAxPressedByName("Danger (2)"), "true");
      assert.equal(await readAxPressedByName("Not sure - abstain (3)"), "false");

      await page.locator('[data-testid="choice-unsure"]').click();
      assert.equal(await readAxPressedByName("Safe (1)"), "false");
      assert.equal(await readAxPressedByName("Danger (2)"), "false");
      assert.equal(await readAxPressedByName("Not sure - abstain (3)"), "true");

      const nonViteWs = observedWebSockets.filter((u) => !u.startsWith(`ws:${SLASH2}127.0.0.1:`));
      assert.equal(nonViteWs.length, 0, `Expected 0 app/external WebSockets, got ${JSON.stringify(nonViteWs)}`);

      for (const reqUrl of observedRequests) {
        if (reqUrl.startsWith("data:") || reqUrl.startsWith("blob:")) continue;
        assert.equal(
          reqUrl.startsWith(baseOrigin),
          true,
          `Expected strictly local origin ${baseOrigin}, got external request ${reqUrl}`,
        );
        const pathname = new URL(reqUrl).pathname;
        assert.equal(
          pathname === "/live" || pathname.startsWith("/live/"),
          false,
          `Forbidden /live request in Chromium: ${reqUrl}`,
        );
        assert.equal(pathname.startsWith("/api/verify"), false, `Forbidden /api/verify request in Chromium: ${reqUrl}`);
        assert.equal(pathname.startsWith("/ingest/frame"), false, `Forbidden /ingest/frame request in Chromium: ${reqUrl}`);
        assert.equal(pathname.startsWith("/api/"), false, `Forbidden /api/ request in Chromium: ${reqUrl}`);
        assert.equal(pathname.startsWith("/ingest/"), false, `Forbidden /ingest/ request in Chromium: ${reqUrl}`);
      }
    } finally {
      if (browser) {
        await browser.close().catch(() => {});
      }
      await viteServer.close().catch(() => {});
      fs.rmSync(tmpViteCache, { recursive: true, force: true });
      if (prevGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prevGeminiKey;
      if (prevElevenKey === undefined) delete process.env.ELEVENLABS_API_KEY;
      else process.env.ELEVENLABS_API_KEY = prevElevenKey;
    }
  });
});

function resetAudioSpiesOnly(): void {
  playedAudioUrls.length = 0;
  spokenUtterances.length = 0;
  pcmBuffersStarted = 0;
}
