import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { ClientMsg, CoachCue, DeviceState, ServerMsg } from "../../shared/types.ts";
import type { Checker } from "../src/lib/checker.ts";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SW_SOURCE = readFileSync(resolve(TEST_DIR, ["..", "public", "sw.js"].join("\x2f")), "utf8");
const SW_CACHE_MATCH = SW_SOURCE.match(/const\s+CACHE\s*=\s*"(holdup-shell-v\d+)"/);
const SW_CACHE_NAME = SW_CACHE_MATCH?.[1] ?? "";
const XHTML_NS = ["http:", "", "www.w3.org", "1999", "xhtml"].join("\x2f");
const RAW_FRAME_SENTINEL = "RAW_FRAME_SENTINEL_JPEG_987654321";
const DEMO_AMLODIPINE_GS1 = "]d201064165420021491727083110A1234\x1d21SN0001";
const MISMATCH_METFORMIN_GS1 = "]d201064165420033751727083110B9999\x1d21SN0002";
const BASE_NOW_MS = Date.UTC(2026, 10, 14, 19, 0, 0);

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
  width = 300;
  height = 150;
  readyState = 4;
  videoWidth = 640;
  videoHeight = 480;
  srcObject: unknown = null;

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

  async play(): Promise<void> {}

  getContext(kind: string) {
    if (kind !== "2d") return null;
    return {
      drawImage() {},
      getImageData(_x: number, _y: number, w: number, h: number) {
        const data = new Uint8ClampedArray(w * h * 4);
        for (let i = 0; i < data.length; i += 4) {
          const v = ((i >> 2) % 2 === 0) ? 235 : 20;
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
    return `data:image\x2fjpeg;base64,${RAW_FRAME_SENTINEL}`;
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
  visibilityState: "visible" | "hidden" = "visible";
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

class FakeBroadcastChannel {
  static peers = new Map<string, Set<FakeBroadcastChannel>>();
  static bootPeers = new Set<FakeBroadcastChannel>();
  static history: Array<{ name: string; data: unknown }> = [];

  name: string;
  closed = false;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  private listeners = new Set<(ev: MessageEvent) => void>();

  constructor(name: string) {
    this.name = name;
    const group = FakeBroadcastChannel.peers.get(name) ?? new Set<FakeBroadcastChannel>();
    group.add(this);
    FakeBroadcastChannel.peers.set(name, group);
  }

  postMessage(data: unknown): void {
    if (this.closed) return;
    const cloned = structuredClone(data);
    FakeBroadcastChannel.history.push({ name: this.name, data: cloned });
    const group = FakeBroadcastChannel.peers.get(this.name);
    if (!group) return;
    for (const peer of group) {
      if (peer !== this && !peer.closed) {
        const ev = new MessageEvent("message", { data: structuredClone(data) });
        peer.onmessage?.(ev);
        for (const fn of peer.listeners) fn(ev);
      }
    }
  }

  addEventListener(type: string, fn: (ev: MessageEvent) => void): void {
    if (type === "message") this.listeners.add(fn);
  }

  removeEventListener(type: string, fn: (ev: MessageEvent) => void): void {
    if (type === "message") this.listeners.delete(fn);
  }

  close(): void {
    this.closed = true;
    FakeBroadcastChannel.peers.get(this.name)?.delete(this);
  }

  static markBootPeers(): void {
    for (const group of FakeBroadcastChannel.peers.values()) {
      for (const ch of group) FakeBroadcastChannel.bootPeers.add(ch);
    }
  }

  static reset(): void {
    for (const [name, group] of FakeBroadcastChannel.peers.entries()) {
      for (const ch of [...group]) {
        if (!FakeBroadcastChannel.bootPeers.has(ch)) {
          ch.closed = true;
          group.delete(ch);
        }
      }
      if (group.size === 0) FakeBroadcastChannel.peers.delete(name);
    }
    FakeBroadcastChannel.history = [];
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

class FakeAudioWorkletNode {
  static instances: FakeAudioWorkletNode[] = [];
  port = {
    onmessage: null as ((ev: { data: { pcm: ArrayBuffer; rms: number } }) => void) | null,
    close() {},
    postMessage() {},
  };

  constructor() {
    FakeAudioWorkletNode.instances.push(this);
  }

  connect(dest: unknown) {
    return dest;
  }

  disconnect() {}
}

class FakeAudioContext {
  state: "running" | "suspended" | "closed" = "running";
  currentTime = 0;
  destination = {};
  audioWorklet = {
    async addModule(_moduleUrl: string): Promise<void> {},
  };

  async resume(): Promise<void> {
    if (this.state !== "closed") this.state = "running";
  }

  async close(): Promise<void> {
    this.state = "closed";
  }

  createMediaStreamSource(_stream: unknown) {
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
      frequency: {
        value: 440,
        setTargetAtTime() {},
      },
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

  async decodeAudioData(_buf: ArrayBuffer) {
    return this.createBuffer(1, 240, 24000);
  }
}

class FakeMediaTrack {
  kind: "video" | "audio";
  label: string;
  readyState: "live" | "ended" = "live";
  private listeners = new Map<string, Set<() => void>>();

  constructor(kind: "video" | "audio", label: string) {
    this.kind = kind;
    this.label = label;
  }

  stop(): void {
    this.readyState = "ended";
  }

  addEventListener(type: string, fn: () => void): void {
    const set = this.listeners.get(type) ?? new Set<() => void>();
    set.add(fn);
    this.listeners.set(type, set);
  }
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

class FakeAudioElement {
  src: string;
  loop = false;
  volume = 1;
  playbackRate = 1;
  currentTime = 0;
  onended: (() => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  private listeners = new Map<string, Set<(ev: Event) => void>>();

  constructor(src = "") {
    this.src = src;
  }

  addEventListener(type: string, fn: (ev: Event) => void): void {
    const set = this.listeners.get(type) ?? new Set<(ev: Event) => void>();
    set.add(fn);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, fn: (ev: Event) => void): void {
    this.listeners.get(type)?.delete(fn);
  }

  async play(): Promise<void> {
    if (this.src && !this.src.startsWith("blob:") && !this.src.startsWith("data:")) {
      const ev = new Event("error");
      this.onerror?.(ev);
      for (const fn of this.listeners.get("error") ?? []) fn(ev);
      throw new Error("Pre-rendered audio asset unavailable in unit test");
    }
  }

  pause(): void {}
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

const envState = {
  doc: new MiniDocument(),
  storage: new Map<string, string>(),
  sessionStore: new Map<string, string>(),
  cachesMap: new Map<string, Map<string, Response>>(),
  fetchedUrls: [] as string[],
  onLine: true,
  detectedCodes: [] as Array<{ rawValue: string; format: string }>,
  spoken: [] as Array<{ text: string; lang: string; volume: number }>,
  speechCancels: 0,
  vibrations: [] as Array<number | number[]>,
  winListeners: new Map<string, Set<(ev: Event | MiniEvent) => void>>(),
};

class FakeBarcodeDetector {
  static async getSupportedFormats(): Promise<string[]> {
    return ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "data_matrix", "qr_code"];
  }

  async detect(): Promise<Array<{ rawValue: string; format: string }>> {
    return [...envState.detectedCodes];
  }
}

function makeStorageShim(map: Map<string, string>) {
  const api: Record<string, unknown> = {
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
  return new Proxy(api, {
    ownKeys() {
      return [...map.keys()];
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (typeof prop === "string" && map.has(prop)) {
        return { value: map.get(prop), enumerable: true, configurable: true, writable: true };
      }
      return undefined;
    },
  });
}

const loc = {
  search: "?mock=1",
  protocol: "https:",
  host: "holdup.test",
  pathname: "\x2f",
  hash: "",
};

const hist = {
  state: null as unknown,
  pushCount: 0,
  backCount: 0,
  pushState(data: unknown) {
    hist.state = data;
    hist.pushCount++;
  },
  replaceState(data: unknown) {
    hist.state = data;
  },
  back() {
    hist.backCount++;
  },
};

const speechSynthesisShim = {
  cancel() {
    envState.speechCancels++;
  },
  speak(utterance: FakeSpeechSynthesisUtterance) {
    envState.spoken.push({ text: utterance.text, lang: utterance.lang, volume: utterance.volume });
  },
};

const mediaDevicesShim = {
  async getUserMedia(constraints: { video?: unknown; audio?: unknown }) {
    const tracks: FakeMediaTrack[] = [];
    if (constraints.video) tracks.push(new FakeMediaTrack("video", "Phone Rear Camera"));
    if (constraints.audio) tracks.push(new FakeMediaTrack("audio", "Ray-Ban Meta Hands-Free"));
    return new FakeMediaStream(tracks);
  },
  async enumerateDevices() {
    return [
      { kind: "audioinput", deviceId: "default", label: "Ray-Ban Meta Hands-Free" },
      { kind: "audiooutput", deviceId: "default", label: "Ray-Ban Meta Hands-Free" },
    ];
  },
  addEventListener() {},
  removeEventListener() {},
};

const navigatorShim = {
  get onLine() {
    return envState.onLine;
  },
  set onLine(v: boolean) {
    envState.onLine = v;
  },
  language: "en-US",
  userAgent: "Mozilla\x2f5.0 (Linux; Android 14) Chrome\x2f130.0.0.0",
  mediaDevices: mediaDevicesShim,
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
  vibrate(pattern: number | number[]) {
    envState.vibrations.push(pattern);
    return true;
  },
};

async function fetchShim(input: RequestInfo | URL): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  envState.fetchedUrls.push(url);
  if (!envState.onLine) throw new TypeError("Failed to fetch");
  return new Response(null, { status: 404, statusText: "Not Found" });
}

const cachesShim = {
  async open(name: string) {
    const bucket = envState.cachesMap.get(name) ?? new Map<string, Response>();
    envState.cachesMap.set(name, bucket);
    return {
      async put(key: RequestInfo | URL, res: Response) {
        const k = typeof key === "string" ? key : key instanceof URL ? key.href : key.url;
        bucket.set(k, res);
      },
      async match(key: RequestInfo | URL) {
        const k = typeof key === "string" ? key : key instanceof URL ? key.href : key.url;
        return bucket.get(k);
      },
    };
  },
  async keys(): Promise<string[]> {
    return [...envState.cachesMap.keys()];
  },
  async delete(name: string): Promise<boolean> {
    return envState.cachesMap.delete(name);
  },
  async has(name: string): Promise<boolean> {
    return envState.cachesMap.has(name);
  },
};

const windowShim = {
  isSecureContext: true,
  document: envState.doc,
  navigator: navigatorShim,
  location: loc,
  history: hist,
  speechSynthesis: speechSynthesisShim,
  AudioContext: FakeAudioContext,
  BarcodeDetector: FakeBarcodeDetector,
  fetch: fetchShim,
  caches: cachesShim,
  HTMLIFrameElement: class {},
  addEventListener(type: string, fn: (ev: Event | MiniEvent) => void) {
    const set = envState.winListeners.get(type) ?? new Set<(ev: Event | MiniEvent) => void>();
    set.add(fn);
    envState.winListeners.set(type, set);
  },
  removeEventListener(type: string, fn: (ev: Event | MiniEvent) => void) {
    envState.winListeners.get(type)?.delete(fn);
  },
  dispatchEvent(ev: Event | MiniEvent) {
    for (const fn of envState.winListeners.get(ev.type) ?? []) fn(ev);
    return true;
  },
};
envState.doc.defaultView = windowShim;

setGlobal("window", windowShim);
setGlobal("document", envState.doc);
setGlobal("navigator", navigatorShim);
setGlobal("location", loc);
setGlobal("history", hist);
setGlobal("localStorage", makeStorageShim(envState.storage));
setGlobal("sessionStorage", makeStorageShim(envState.sessionStore));
setGlobal("BroadcastChannel", FakeBroadcastChannel);
setGlobal("SpeechSynthesisUtterance", FakeSpeechSynthesisUtterance);
setGlobal("AudioContext", FakeAudioContext);
setGlobal("AudioWorkletNode", FakeAudioWorkletNode);
setGlobal("Audio", FakeAudioElement);
setGlobal("MediaMetadata", FakeMediaMetadata);
setGlobal("fetch", fetchShim);
setGlobal("caches", cachesShim);

const mockMod = await import("../src/lib/mock.ts");
const checkerMod = await import("../src/lib/checker.ts");
const storageMod = await import("../src/lib/storage.ts");
const feedbackMod = await import("../src/lib/feedback.ts");
const barcodeMod = await import("../src/lib/barcode.ts");
const keyMod = await import("../src/lib/key.ts");
const verdictCardMod = await import("../src/components/VerdictCard.tsx");
const announcerMod = await import("../src/components/Announcer.tsx");
const addSheetMod = await import("../src/components/AddSheet.tsx");
const hudMod = await import("../src/screens/Hud.tsx");

FakeBroadcastChannel.markBootPeers();

const { IS_MOCK, MOCK_HUD_CHANNEL, MockSocket, mockCtl, mockFetch, mockHudChannel, mockSetDevice, mockSetGeminiDown } = mockMod;
const { Checker: CheckerClass } = checkerMod;
const { deleteAllData, demoProfile, loadProfile, loadSettings, saveProfile, saveSettings, takenToday } = storageMod;
const { onAnnounce } = feedbackMod;
const { barcodeSupported } = barcodeMod;
const { setAccessKey } = keyMod;
const { VerdictCard } = verdictCardMod;
const { Announcer } = announcerMod;
const { AddSheet } = addSheetMod;
const { Hud } = hudMod;

type AnnouncementRecord = { msg: string; politeness: "polite" | "assertive" };
type HudChannelTraffic = ServerMsg | { type: "hud_hello" } | { type: "hud_event"; name?: string };

const origSocketSend = MockSocket.prototype.send;
const sentClientMessages: ClientMsg[] = [];
MockSocket.prototype.send = function patchedSend(this: InstanceType<typeof MockSocket>, data: string) {
  try {
    sentClientMessages.push(JSON.parse(data) as ClientMsg);
  } catch {
    void 0;
  }
  return origSocketSend.call(this, data);
};

async function flushMicrotasks(turns = 12): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve();
  }
}

function tickSteps(t: test.TestContext, totalMs: number, stepMs = 100): void {
  let remaining = totalMs;
  while (remaining > 0) {
    const dt = Math.min(remaining, stepMs);
    t.mock.timers.tick(dt);
    remaining -= dt;
  }
}

function resetHarness(t: test.TestContext): {
  announcements: AnnouncementRecord[];
  stopListening: () => void;
  videoEl: HTMLVideoElement;
} {
  for (const sock of [...mockCtl.sockets]) {
    sock.close();
  }
  mockCtl.sockets.clear();
  mockCtl.failConnects = 0;
  mockCtl.slow = false;
  mockCtl.offline = false;
  mockCtl.geminiDown = false;
  mockCtl.device = { connected: false, worn: false, battery: null, streaming: false, source: "phone" };

  FakeBroadcastChannel.reset();
  FakeAudioWorkletNode.instances = [];
  sentClientMessages.length = 0;

  envState.storage.clear();
  envState.sessionStore.clear();
  envState.cachesMap.clear();
  envState.fetchedUrls = [];
  envState.onLine = true;
  envState.detectedCodes = [];
  envState.spoken = [];
  envState.speechCancels = 0;
  envState.vibrations = [];
  envState.doc.body.childNodes = [];
  envState.doc.activeElement = null;
  envState.doc.visibilityState = "visible";
  hist.state = null;
  hist.pushCount = 0;
  hist.backCount = 0;

  setAccessKey("");
  saveProfile(demoProfile());

  const announcements: AnnouncementRecord[] = [];
  const stopListening = onAnnounce((msg, politeness) => {
    announcements.push({ msg, politeness });
  });

  t.after(() => {
    stopListening();
    for (const sock of [...mockCtl.sockets]) {
      sock.close();
    }
    mockCtl.sockets.clear();
    FakeBroadcastChannel.reset();
  });

  const videoEl = envState.doc.createElement("video") as unknown as HTMLVideoElement;
  return { announcements, stopListening, videoEl };
}

function teardownChecker(checker: Checker, stopListening: () => void): void {
  stopListening();
  checker.dispose();
  mockHudChannel()?.close();
  FakeBroadcastChannel.reset();
}

async function mountNode(t: test.TestContext, element: React.ReactElement) {
  const container = envState.doc.createElement("div");
  envState.doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  let mounted = true;
  await act(async () => {
    root.render(element);
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
    buttonByText: (prefix: string) => {
      const found = container.findAll((el) => el.tagName === "BUTTON" && el.textContent.trim().startsWith(prefix))[0];
      assert.ok(found, `Expected button starting with "${prefix}"`);
      return found;
    },
    rerender: async (next: React.ReactElement) => {
      await act(async () => {
        root.render(next);
      });
    },
    unmount,
  };
}

async function startMockChecker(
  t: test.TestContext,
  checker: Checker,
  videoEl: HTMLVideoElement,
): Promise<InstanceType<typeof MockSocket>> {
  t.after(() => {
    checker.dispose();
  });
  checker.attachVideo(videoEl);
  await checker.start();
  tickSteps(t, 260, 50);
  await flushMicrotasks();
  assert.equal(checker.get().running, true);
  assert.equal(checker.get().conn, "open");
  const sock = [...mockCtl.sockets][0];
  assert.ok(sock, "Expected active MockSocket in mockCtl.sockets");
  return sock;
}

test("?mock=1 runtime wiring connects IS_MOCK, MockSocket, mockFetch, mockHudChannel, sw cache shell, and mockCtl to real Checker", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: BASE_NOW_MS });
  const { stopListening, videoEl } = resetHarness(t);

  assert.equal(IS_MOCK, true);
  assert.equal(barcodeSupported, true);
  assert.equal(MOCK_HUD_CHANNEL, "holdup-hud-mock");
  assert.match(SW_CACHE_NAME, /^holdup-shell-v\d+$/);

  const shellCache = await cachesShim.open(SW_CACHE_NAME);
  await shellCache.put("\x2f", new Response("shell"));
  envState.sessionStore.set("holdup.key", "temp");
  assert.equal(await cachesShim.has(SW_CACHE_NAME), true);
  await deleteAllData();
  assert.equal(await cachesShim.has(SW_CACHE_NAME), false);
  assert.equal(envState.storage.has("holdup.profile"), false);
  assert.equal(envState.sessionStore.size, 0);
  saveProfile(demoProfile());

  const healthPromise = mockFetch("\x2fapi\x2fhealth");
  tickSteps(t, 1050, 100);
  const healthPayload = (await healthPromise) as { ok: boolean; gemini: string; models: { live: string; verify: string }; version: string };
  assert.equal(healthPayload.ok, true);
  assert.equal(healthPayload.gemini, "ok");
  assert.equal(healthPayload.models.live, "mock-gemini-live");
  assert.equal(healthPayload.version, "mock");

  const verifyPromise = mockFetch("\x2fapi\x2fverify", { profile: demoProfile() });
  tickSteps(t, 1050, 100);
  const verifyVerdict = (await verifyPromise) as { level: string; headline: string };
  assert.ok(["match", "warning", "unsure"].includes(verifyVerdict.level));
  assert.ok(verifyVerdict.headline.length > 0);

  const checker = new CheckerClass();
  const sock = await startMockChecker(t, checker, videoEl);
  assert.ok(sock instanceof MockSocket);

  tickSteps(t, 1000, 100);
  await flushMicrotasks();

  const st = checker.get();
  assert.equal(st.model, "mock-gemini-live");
  assert.equal(st.session, "MOCK");
  assert.equal(st.serverLive, "open");
  assert.equal(st.health, "ok");
  assert.deepEqual(st.serverFeatures, ["scene", "datamatrix", "addmed", "sonar"]);
  assert.ok(st.framesSent >= 1, "Expected attached video to capture and send frames to MockSocket");

  teardownChecker(checker, stopListening);
});

test("Stage Demo Scenario 1 (evening pill): start -> sendText -> full coach -> checking -> Amlodipine 5 mg match -> announce() -> logDose() localStorage + double-dose guard", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: BASE_NOW_MS });
  const { announcements, stopListening, videoEl } = resetHarness(t);
  const announcerView = await mountNode(t, createElement(Announcer));
  const checker = new CheckerClass();

  const seenCues: Array<{ cue: CoachCue; text: string }> = [];
  const seenCheckingPhases: boolean[] = [];
  let prevChecking = false;
  let lastCueKey = "";
  const unsub = checker.subscribe(() => {
    const s = checker.get();
    if (s.cue) {
      const key = `${s.cue.cue}:${s.cue.text}`;
      if (key !== lastCueKey) {
        lastCueKey = key;
        seenCues.push({ cue: s.cue.cue, text: s.cue.text });
      }
    }
    if (s.checking !== prevChecking) {
      prevChecking = s.checking;
      seenCheckingPhases.push(s.checking);
    }
  });

  await act(async () => {
    await startMockChecker(t, checker, videoEl);
    tickSteps(t, 70, 20);
  });
  assert.ok(announcerView.html().includes('role="alert" aria-live="assertive" aria-atomic="true">Check started. Camera and microphone on. Hold the item up in front of you.<'));

  checker.sendText("is this my evening pill");

  await act(async () => {
    tickSteps(t, 1650, 50);
  });
  assert.equal(checker.get().cue?.cue, "other_side");

  await act(async () => {
    tickSteps(t, 2400, 50);
  });
  assert.equal(checker.get().cue?.cue, "rotate_left");

  await act(async () => {
    tickSteps(t, 2000, 50);
  });
  assert.equal(checker.get().cue?.cue, "closer");

  await act(async () => {
    tickSteps(t, 1800, 50);
  });
  assert.equal(checker.get().cue?.cue, "hold_still");

  await act(async () => {
    tickSteps(t, 1600, 50);
  });
  assert.equal(checker.get().checking, true);
  assert.equal(checker.get().cue, null);

  await act(async () => {
    tickSteps(t, 70, 20);
  });
  assert.ok(announcerView.html().includes('role="status" aria-live="polite" aria-atomic="true">Checking\u2026<'));

  await act(async () => {
    tickSteps(t, 2800, 50);
    await flushMicrotasks();
  });

  assert.deepEqual(
    seenCues.map((c) => c.cue),
    ["other_side", "rotate_left", "closer", "hold_still", "ok"],
  );
  assert.deepEqual(seenCheckingPhases, [true, false]);

  const verdict = checker.get().verdict;
  assert.ok(verdict);
  assert.equal(verdict.level, "match");
  assert.equal(verdict.headline, "Amlodipine 5 mg");
  assert.equal(verdict.matchedMedId, "amlodipine");
  assert.equal(verdict.takenToday, false);
  assert.equal(verdict.speech, "Yes, Amlodipine 5 mg, your evening pill. You haven't taken it today.");
  assert.equal(checker.get().verdictVia, "live");

  const announceTexts = announcements.map((a) => a.msg);
  const idxStart = announceTexts.indexOf("Check started. Camera and microphone on. Hold the item up in front of you.");
  const idxReadable = announceTexts.indexOf("Readable.");
  const idxChecking = announceTexts.indexOf("Checking\u2026");
  const idxVerdict = announceTexts.indexOf("Match. Amlodipine 5 mg. Yes, Amlodipine 5 mg, your evening pill. You haven't taken it today.");
  assert.ok(idxStart >= 0 && idxReadable > idxStart && idxChecking > idxReadable && idxVerdict > idxChecking);

  await act(async () => {
    tickSteps(t, 70, 20);
  });
  assert.ok(announcerView.text().includes("Match. Amlodipine 5 mg. Yes, Amlodipine 5 mg, your evening pill. You haven't taken it today."));

  let callbackProfileCount = 0;
  checker.onProfileChange = (p) => {
    callbackProfileCount = p.doseLog.length;
  };
  await act(async () => {
    checker.logDose();
    tickSteps(t, 70, 20);
    await flushMicrotasks();
  });

  assert.equal(checker.get().verdict?.takenToday, true);
  assert.equal(callbackProfileCount, 1);

  const rawStored = envState.storage.get("holdup.profile");
  assert.ok(rawStored, "Expected holdup.profile persisted in localStorage");
  const persisted = loadProfile();
  assert.equal(persisted.doseLog.length, 1);
  assert.equal(persisted.doseLog[0].medId, "amlodipine");
  assert.equal(takenToday(persisted, "amlodipine"), true);
  assert.ok(announcements.some((a) => a.politeness === "assertive" && a.msg.startsWith("Logged Amlodipine at ") && a.msg.endsWith("Saved on this phone only.")));
  assert.ok(sentClientMessages.some((m) => m.type === "event" && m.name === "log_dose"));
  assert.ok(checker.get().captions.some((c) => c.role === "assistant" && c.text.includes("Logged. I'll remember you took it today.")));

  await act(async () => {
    checker.profileChanged();
    checker.sendText("is this my evening pill");
    tickSteps(t, 12_500, 100);
    await flushMicrotasks();
  });

  const secondVerdict = checker.get().verdict;
  assert.ok(secondVerdict);
  assert.equal(secondVerdict.level, "warning");
  assert.equal(secondVerdict.headline, "Amlodipine 5 mg: already taken today");
  assert.equal(secondVerdict.takenToday, true);

  unsub();
  await announcerView.unmount();
  teardownChecker(checker, stopListening);
});

test("Stage Demo Scenario 1 with voice:false announces every coaching cue through screen-reader live regions while keeping speechSynthesis silent", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: BASE_NOW_MS });
  const { announcements, stopListening, videoEl } = resetHarness(t);
  saveSettings({ ...loadSettings(), voice: false });
  envState.spoken = [];

  const checker = new CheckerClass();
  await startMockChecker(t, checker, videoEl);
  await flushMicrotasks();
  const spokenAfterPrime = envState.spoken.length;

  checker.sendText("is this my evening pill");
  tickSteps(t, 12_500, 100);
  await flushMicrotasks();

  const msgs = announcements.map((a) => a.msg);
  assert.ok(msgs.includes("The label is facing away. Turn it around."));
  assert.ok(msgs.includes("Turn it a little left"));
  assert.ok(msgs.includes("A bit closer"));
  assert.ok(msgs.includes("Hold still. Reading"));
  assert.ok(msgs.includes("Got it"));
  assert.equal(envState.spoken.length, spokenAfterPrime, "Expected no spoken utterances when voice setting is off");

  teardownChecker(checker, stopListening);
});

test("Stage Demo Scenario 2 (ibuprofen): triggers NSAID warning verdict and blocks dose logging", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: BASE_NOW_MS });
  const { announcements, stopListening, videoEl } = resetHarness(t);
  const checker = new CheckerClass();

  await startMockChecker(t, checker, videoEl);
  checker.sendText("ibuprofen");
  tickSteps(t, 12_500, 100);
  await flushMicrotasks();

  const v = checker.get().verdict;
  assert.ok(v);
  assert.equal(v.level, "warning");
  assert.equal(v.headline, "Ibuprofen: not on your list");
  assert.equal(v.matchedMedId, undefined);
  assert.ok(v.reasons.includes("Not on your medication list"));
  assert.ok(v.reasons.includes("Ibuprofen is an NSAID, and you avoid NSAIDs"));
  assert.ok(
    announcements.some(
      (a) =>
        a.politeness === "assertive" &&
        a.msg === "Warning. Ibuprofen: not on your list. This is Ibuprofen 400 milligrams. It isn't on your list, and your list says to avoid NSAIDs.",
    ),
  );

  checker.logDose();
  assert.equal(loadProfile().doseLog.length, 0);
  assert.ok(announcements.some((a) => a.politeness === "assertive" && a.msg === "There is no matched medicine to log."));

  teardownChecker(checker, stopListening);
});

test("Stage Demo Scenario 3 (nuts): triggers tree-nut allergen warning verdict and renders accessible VerdictCard", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: BASE_NOW_MS });
  const { announcements, stopListening, videoEl } = resetHarness(t);
  const checker = new CheckerClass();

  await startMockChecker(t, checker, videoEl);
  checker.sendText("does this snack have nuts");
  tickSteps(t, 12_500, 100);
  await flushMicrotasks();

  const v = checker.get().verdict;
  assert.ok(v);
  assert.equal(v.level, "warning");
  assert.equal(v.headline, "Contains hazelnuts");
  assert.equal(v.read.kind, "food");
  assert.deepEqual(v.read.allergens.value, ["hazelnut", "oats", "milk"]);
  assert.ok(v.reasons.includes("Allergen panel lists hazelnut"));
  assert.ok(v.reasons.includes("Your allergies: tree nuts"));
  assert.ok(announcements.some((a) => a.politeness === "assertive" && a.msg.startsWith("Warning. Contains hazelnuts.")));

  const html = renderToStaticMarkup(
    createElement(VerdictCard, {
      verdict: v,
      via: checker.get().verdictVia,
      onRepeat: () => checker.repeat(),
      onLog: () => checker.logDose(),
      onDismiss: () => checker.dismissVerdict(),
    }),
  );
  const text = decodeHtml(html);
  assert.match(html, /^<section class="verdict warning" aria-labelledby="verdict-h">/);
  assert.ok(text.includes("Contains hazelnuts"));
  assert.ok(text.includes("hazelnut, oats, milk"));
  assert.doesNotMatch(html, /I took it|Log another dose/);

  teardownChecker(checker, stopListening);
});

test("Stage Demo abstention (blurry unreadable strength): returns unsure verdict and never guesses a dose", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: BASE_NOW_MS });
  const { announcements, stopListening, videoEl } = resetHarness(t);
  const checker = new CheckerClass();

  await startMockChecker(t, checker, videoEl);
  checker.sendText("blurry metformin box, can you read the strength");
  tickSteps(t, 12_500, 100);
  await flushMicrotasks();

  const v = checker.get().verdict;
  assert.ok(v);
  assert.equal(v.level, "unsure");
  assert.equal(v.headline, "Can't read the strength");
  assert.equal(v.matchedMedId, undefined);
  assert.equal(v.read.product.value, "Metformin");
  assert.equal(v.read.strength.value, null);
  assert.ok(v.read.strength.confidence < 0.7);
  assert.ok(v.reasons.includes("HoldUp never guesses a dose"));
  assert.doesNotMatch(v.headline, /\b\d+\s*(mg|milligrams?|mcg|ml)\b/i);
  assert.doesNotMatch(v.speech, /\b\d+\s*(mg|milligrams?|mcg|ml)\b/i);
  assert.ok(
    announcements.some(
      (a) =>
        a.politeness === "assertive" &&
        a.msg === "Not sure. Can't read the strength. I can read Metformin, but I can't read the strength confidently. Turn the box so the side panel faces you, or ask a pharmacist.",
    ),
  );

  const html = renderToStaticMarkup(
    createElement(VerdictCard, {
      verdict: v,
      via: checker.get().verdictVia,
      onRepeat: () => checker.repeat(),
      onLog: () => checker.logDose(),
      onDismiss: () => checker.dismissVerdict(),
    }),
  );
  assert.match(html, /^<section class="verdict unsure" aria-labelledby="verdict-h">/);
  assert.match(html, /<dt>Strength<\/dt><dd>Not readable<\/dd><dd class="conf low" aria-label="confidence 31 percent">31%<\/dd>/);
  assert.doesNotMatch(html, /I took it|Log another dose/);

  teardownChecker(checker, stopListening);
});

test("Signature feature scene (which one): produces spatial 3-package scene verdict rendered cleanly via VerdictCard", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: BASE_NOW_MS });
  const { stopListening, videoEl } = resetHarness(t);
  const checker = new CheckerClass();

  await startMockChecker(t, checker, videoEl);
  assert.equal(checker.feature("scene"), true);

  checker.sendText("which one on the table is my evening pill");
  tickSteps(t, 12_500, 100);
  await flushMicrotasks();

  const v = checker.get().verdict;
  assert.ok(v);
  assert.equal(v.mode, "scene");
  assert.equal(v.level, "match");
  assert.equal(v.headline, "Your evening pill: on the right");
  assert.equal(v.matchedMedId, "amlodipine");
  assert.equal(v.items?.length, 3);

  const cardView = await mountNode(
    t,
    createElement(VerdictCard, {
      verdict: v,
      via: checker.get().verdictVia,
      onRepeat: () => checker.repeat(),
      onLog: () => checker.logDose(),
      onDismiss: () => checker.dismissVerdict(),
    }),
  );

  const html = cardView.html();
  assert.match(html, /<ol class="scene" aria-label="3 packages, left to right" style="grid-template-columns: 1fr 1fr 1\.5fr">/);
  assert.match(html, /<li class="scene-item unsure\s*"><span class="scene-pos">Left<\/span>/);
  assert.match(html, /<li class="scene-item warning\s*"><span class="scene-pos">Middle<\/span>/);
  assert.match(html, /<li class="scene-item match target" aria-current="true"><span class="scene-pos">Right<\/span>/);
  assert.match(html, /<span class="sr-only">This is the one you asked about\.<\/span>/);

  await act(async () => {
    cardView.buttonByText("I took it").click();
    await flushMicrotasks();
  });
  assert.equal(checker.get().verdict?.takenToday, true);
  assert.equal(takenToday(loadProfile(), "amlodipine"), true);

  await cardView.unmount();
  teardownChecker(checker, stopListening);
});

test("Signature feature addmed (add): requires explicit confirmation via AddSheet, saves med to localStorage, sends profile_add_result, and rejects on timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: BASE_NOW_MS });
  const { announcements, stopListening, videoEl } = resetHarness(t);
  const checker = new CheckerClass();
  t.after(() => {
    checker.dispose();
  });
  checker.attachVideo(videoEl);

  await checker.startSetupByVoice();
  tickSteps(t, 260, 50);
  await flushMicrotasks();
  const sock = [...mockCtl.sockets][0];
  assert.ok(sock);
  tickSteps(t, 6100, 100);
  await flushMicrotasks();

  const proposal = checker.get().addProposal;
  assert.ok(proposal, "Expected addProposal from MockSocket profile_add");
  assert.equal(proposal.med.name, "Lisinopril");
  assert.equal(proposal.med.strength, "10 mg");
  assert.deepEqual(proposal.med.schedule, ["morning"]);
  assert.equal(proposal.med.gtin, "06416542005218");
  assert.equal(loadProfile().meds.length, 3, "Medication must not be saved before user confirms");
  assert.ok(announcements.some((a) => a.politeness === "assertive" && a.msg.includes("Add Lisinopril 10 mg, morning to your list? Double-tap Add to confirm, or Cancel.")));

  const sheetView = await mountNode(
    t,
    createElement(AddSheet, {
      med: proposal.med,
      speech: proposal.speech,
      expiresAt: proposal.expiresAt,
      onAnswer: (accepted) => checker.answerProposal(accepted),
    }),
  );
  assert.match(sheetView.html(), /<dialog class="addsheet" aria-labelledby="add-h" aria-describedby="add-d" open="">/);
  const addBtn = sheetView.buttonByText("Add");
  assert.equal(envState.doc.activeElement, addBtn, "AddSheet must move initial focus to Add button");

  await act(async () => {
    addBtn.click();
    await flushMicrotasks();
  });
  await sheetView.unmount();

  assert.equal(checker.get().addProposal, null);
  const updatedProfile = loadProfile();
  assert.equal(updatedProfile.meds.length, 4);
  const addedMed = updatedProfile.meds.find((m) => m.name === "Lisinopril");
  assert.ok(addedMed);
  assert.equal(addedMed.strength, "10 mg");
  assert.equal(addedMed.gtin, "06416542005218");

  const addResultMsg = sentClientMessages.find((m): m is Extract<ClientMsg, { type: "profile_add_result" }> => m.type === "profile_add_result");
  assert.ok(addResultMsg);
  assert.equal(addResultMsg.proposalId, proposal.proposalId);
  assert.equal(addResultMsg.accepted, true);
  assert.equal(addResultMsg.med?.name, "Lisinopril");
  assert.ok(announcements.some((a) => a.politeness === "assertive" && a.msg.startsWith("Added Lisinopril 10 mg, morning to your list. Saved on this phone only.")));
  assert.ok(checker.get().captions.some((c) => c.role === "assistant" && c.text.includes("Added Lisinopril to your list.")));

  sentClientMessages.length = 0;
  checker.sendText("add another medicine");
  tickSteps(t, 6100, 100);
  await flushMicrotasks();
  const secondProposal = checker.get().addProposal;
  assert.ok(secondProposal);

  tickSteps(t, 30_000, 500);
  sock.pushStatus({ type: "transcript", role: "assistant", text: "Tap Add on your phone to confirm.", final: true });
  tickSteps(t, 30_000, 500);
  await flushMicrotasks();
  assert.equal(checker.get().addProposal, null);
  assert.equal(loadProfile().meds.length, 4, "Timed-out proposal must not save duplicate medication");
  const timeoutResult = sentClientMessages.find((m): m is Extract<ClientMsg, { type: "profile_add_result" }> => m.type === "profile_add_result");
  assert.ok(timeoutResult);
  assert.equal(timeoutResult.proposalId, secondProposal.proposalId);
  assert.equal(timeoutResult.accepted, false);
  assert.ok(announcements.some((a) => a.msg === "No answer, so I didn't add it."));

  teardownChecker(checker, stopListening);
});

test("Signature feature datamatrix (injectCode): produces crossCheck agrees:true on matching pack code and agrees:false on mismatched GTIN", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: BASE_NOW_MS });
  const { announcements, stopListening, videoEl } = resetHarness(t);
  const checker = new CheckerClass();

  await startMockChecker(t, checker, videoEl);
  checker.sendText("is this my evening pill");
  tickSteps(t, 1000, 100);

  checker.injectCode(DEMO_AMLODIPINE_GS1);
  assert.equal(checker.get().lastCode?.gtin, "06416542002149");
  assert.equal(checker.get().lastCode?.expiry, "2027-08-31");
  assert.equal(checker.get().lastCode?.batch, "A1234");
  assert.equal(checker.get().lastCode?.serial, "SN0001");
  assert.ok(sentClientMessages.some((m) => m.type === "datamatrix" && m.raw === DEMO_AMLODIPINE_GS1));
  assert.ok(announcements.some((a) => a.msg === "Pack code read, expiry 2027-08-31. Double-checking the label."));

  tickSteps(t, 11_500, 100);
  await flushMicrotasks();
  const okVerdict = checker.get().verdict;
  assert.ok(okVerdict?.crossCheck);
  assert.equal(okVerdict.crossCheck.source, "datamatrix");
  assert.equal(okVerdict.crossCheck.agrees, true);
  assert.ok(okVerdict.crossCheck.details.some((d) => d.includes("GTIN 06416542002149 = your Amlodipine")));

  const okCardHtml = renderToStaticMarkup(
    createElement(VerdictCard, {
      verdict: okVerdict,
      via: checker.get().verdictVia,
      onRepeat: () => {},
      onLog: () => {},
      onDismiss: () => {},
    }),
  );
  assert.match(okCardHtml, /<div class="xcheck ok" role="note">/);
  assert.match(okCardHtml, /<strong>Double-checked: printed label = pack code<\/strong>/);

  checker.sendText("is this my evening pill");
  tickSteps(t, 1000, 100);
  checker.injectCode(MISMATCH_METFORMIN_GS1);
  tickSteps(t, 11_500, 100);
  await flushMicrotasks();

  const badVerdict = checker.get().verdict;
  assert.ok(badVerdict?.crossCheck);
  assert.equal(badVerdict.crossCheck.source, "datamatrix");
  assert.equal(badVerdict.crossCheck.agrees, false);
  assert.ok(badVerdict.crossCheck.details.some((d) => d.includes("pack code GTIN 06416542003375 is not Amlodipine")));

  const badCardHtml = renderToStaticMarkup(
    createElement(VerdictCard, {
      verdict: badVerdict,
      via: checker.get().verdictVia,
      onRepeat: () => {},
      onLog: () => {},
      onDismiss: () => {},
    }),
  );
  assert.match(badCardHtml, /<div class="xcheck bad" role="note">/);
  assert.match(badCardHtml, /<strong>The printed label and the pack code disagree<\/strong>/);
  assert.ok(decodeHtml(badCardHtml).includes("Don't rely on this answer; ask a pharmacist."));

  teardownChecker(checker, stopListening);
});

test("Signature feature sonar: updates CheckState.readiness across mock ramp, announces Readable. once >= 0.8, clears on verdict, and respects quiet mode", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: BASE_NOW_MS });
  const { announcements, stopListening, videoEl } = resetHarness(t);
  const checker = new CheckerClass();

  const observedReadiness: number[] = [];
  const unsub = checker.subscribe(() => {
    const r = checker.get().readiness;
    if (r !== null && observedReadiness[observedReadiness.length - 1] !== r) {
      observedReadiness.push(r);
    }
  });

  await startMockChecker(t, checker, videoEl);
  assert.equal(checker.get().readiness, null);

  checker.sendText("is this my evening pill");
  tickSteps(t, 2000, 100);
  const earlyReadiness = checker.get().readiness;
  assert.ok(earlyReadiness !== null && earlyReadiness > 0 && earlyReadiness < 0.5, `Expected low initial readiness, got ${String(earlyReadiness)}`);

  tickSteps(t, 7200, 100);
  assert.ok(observedReadiness.some((v) => v >= 0.8 && v <= 0.97), "Expected readiness ramp to exceed 0.8");
  assert.equal(announcements.filter((a) => a.msg === "Readable.").length, 1);

  tickSteps(t, 3500, 100);
  await flushMicrotasks();
  assert.ok(checker.get().verdict);
  assert.equal(checker.get().readiness, null, "Verdict arrival must stop sonar and reset readiness to null");

  unsub();
  await checker.stop();

  saveSettings({ ...loadSettings(), quiet: true });
  tickSteps(t, 4000, 200);
  await startMockChecker(t, checker, videoEl);
  checker.sendText("ibuprofen");
  tickSteps(t, 5000, 100);
  assert.equal(checker.get().readiness, null, "Quiet mode must suppress readiness sonar state");

  teardownChecker(checker, stopListening);
});

test("Cross-tab Ray-Ban Display HUD sync over BroadcastChannel: mirrors status, device, coach, and verdict without leaking frames, audio, or full profile, and handles hud_hello and hud_event repeat, log_dose, and dismiss", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: BASE_NOW_MS });
  const { announcements, stopListening, videoEl } = resetHarness(t);

  const hudSpyMessages: HudChannelTraffic[] = [];
  const hudSpyChannel = new BroadcastChannel(MOCK_HUD_CHANNEL);
  t.after(() => {
    hudSpyChannel.close();
  });
  hudSpyChannel.onmessage = (ev: MessageEvent) => {
    hudSpyMessages.push(ev.data as HudChannelTraffic);
  };

  const hudView = await mountNode(t, createElement(Hud));
  const checker = new CheckerClass();
  await act(async () => {
    await startMockChecker(t, checker, videoEl);
  });

  const worklet = FakeAudioWorkletNode.instances[0];
  assert.ok(worklet, "Expected MicCapture AudioWorkletNode");
  const fakePcm = new Int16Array([1200, -1200, 2400, -2400]).buffer;
  await act(async () => {
    worklet.port.onmessage?.({ data: { pcm: fakePcm, rms: 0.35 } });
    tickSteps(t, 1200, 100);
  });

  assert.ok(sentClientMessages.some((m) => m.type === "start"), "Expected start message with profile sent to MockSocket");
  assert.ok(sentClientMessages.some((m) => m.type === "frame" && m.data === RAW_FRAME_SENTINEL), "Expected raw camera frame sent to MockSocket");
  assert.ok(sentClientMessages.some((m) => m.type === "audio"), "Expected mic PCM chunk sent to MockSocket");

  await act(async () => {
    mockSetDevice({ connected: true, worn: true, battery: 82, streaming: true, source: "glasses" });
  });
  assert.ok(hudView.html().includes("<span>glasses camera</span>"));
  assert.ok(hudView.html().includes("<span>glasses 82%</span>"));

  await act(async () => {
    checker.sendText("is this my evening pill");
    tickSteps(t, 1700, 100);
    await flushMicrotasks();
  });
  assert.match(hudView.html(), /<section class="hud-card cue-card">/);
  assert.ok(hudView.text().includes("The label is facing away. Turn it around."));

  await act(async () => {
    tickSteps(t, 10_800, 100);
    await flushMicrotasks();
  });
  assert.match(hudView.html(), /RIGHT ONE/);
  assert.ok(hudView.text().includes("Amlodipine 5 mg"));

  await act(async () => {
    hudSpyChannel.postMessage({ type: "hud_hello" });
    await flushMicrotasks();
  });

  const allowedTypes = new Set(["status", "device", "coach", "verdict", "hud_hello", "hud_event"]);
  const mirroredServerMsgs = hudSpyMessages.filter(
    (m): m is ServerMsg => m.type === "status" || m.type === "device" || m.type === "coach" || m.type === "verdict",
  );
  assert.ok(mirroredServerMsgs.length >= 4);
  for (const msg of hudSpyMessages) {
    assert.ok(allowedTypes.has(msg.type), `Unexpected message type "${msg.type}" leaked onto HUD BroadcastChannel`);
  }
  assert.ok(mirroredServerMsgs.some((m) => m.type === "status" && m.live === "open"));
  assert.ok(mirroredServerMsgs.some((m) => m.type === "device" && m.device.battery === 82));
  assert.ok(mirroredServerMsgs.some((m) => m.type === "coach" && m.cue === "other_side"));
  assert.ok(mirroredServerMsgs.some((m) => m.type === "verdict" && m.verdict.headline === "Amlodipine 5 mg"));

  const serializedHudTraffic = JSON.stringify(hudSpyMessages);
  assert.equal(serializedHudTraffic.includes(RAW_FRAME_SENTINEL), false, "Raw camera frame bytes must never leak onto HUD BroadcastChannel");
  assert.equal(serializedHudTraffic.includes("Metformin"), false, "Unrelated profile medication Metformin must not leak onto HUD BroadcastChannel");
  assert.equal(serializedHudTraffic.includes("Atorvastatin"), false, "Unrelated profile medication Atorvastatin must not leak onto HUD BroadcastChannel");
  assert.equal(serializedHudTraffic.includes("peanut"), false, "Profile allergies must not leak onto HUD BroadcastChannel");
  assert.equal(serializedHudTraffic.includes("NSAIDs"), false, "Profile avoid list must not leak onto HUD BroadcastChannel");
  assert.equal(serializedHudTraffic.includes("doseLog"), false, "Full profile doseLog array must not leak onto HUD BroadcastChannel");

  const spokenBeforeRepeat = envState.spoken.length;
  const announcesBeforeRepeat = announcements.length;
  await act(async () => {
    hudView.buttonByText("Repeat").click();
    await flushMicrotasks();
  });
  assert.ok(envState.spoken.length > spokenBeforeRepeat, "HUD Repeat must trigger phone speech repeat");
  assert.ok(
    announcements.slice(announcesBeforeRepeat).some((a) => a.msg === "Yes, Amlodipine 5 mg, your evening pill. You haven't taken it today."),
    "HUD Repeat must re-announce the verdict speech on Checker",
  );

  const takeBtn = hudView.buttonByText("I took it");
  assert.equal(takeBtn.disabled, false);
  await act(async () => {
    takeBtn.click();
    await flushMicrotasks();
  });
  assert.equal(checker.get().verdict?.takenToday, true);
  assert.equal(takenToday(loadProfile(), "amlodipine"), true);

  await act(async () => {
    hudView.buttonByText("Dismiss").click();
    await flushMicrotasks();
  });
  assert.equal(checker.get().verdict, null, "HUD Dismiss must clear Checker verdict");
  assert.match(hudView.html(), /Hold it up\./);

  await act(async () => {
    tickSteps(t, 2000, 100);
  });
  hudSpyChannel.close();
  await hudView.unmount();
  teardownChecker(checker, stopListening);
});

test("Resilience demo controls: simulateDrop() backs off to snapshot mode and recovers to live, and mockCtl.slow adapts frame policy", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: BASE_NOW_MS });
  const { announcements, stopListening, videoEl } = resetHarness(t);
  const checker = new CheckerClass();

  await startMockChecker(t, checker, videoEl);
  tickSteps(t, 600, 100);
  assert.ok(checker.get().framesSent >= 1);

  checker.simulateDrop();
  assert.equal(mockCtl.failConnects, 2);
  assert.equal(checker.get().conn, "reconnecting");
  assert.equal(checker.get().connAttempt, 1);
  assert.equal(checker.get().mode, "live");
  assert.ok(announcements.some((a) => a.msg === "Connection lost. Reconnecting."));

  tickSteps(t, 1650, 50);
  assert.equal(checker.get().conn, "reconnecting");
  assert.equal(checker.get().connAttempt, 2);
  assert.equal(checker.get().mode, "snapshot");
  assert.equal(checker.get().banner?.title, "Snapshot mode");
  assert.ok(announcements.some((a) => a.politeness === "assertive" && a.msg === "Connection lost. Switched to snapshot mode. I'll keep trying to reconnect."));

  const snapPromise = checker.snapshot(undefined, "is this my evening pill");
  await flushMicrotasks();
  tickSteps(t, 1050, 50);
  await snapPromise;
  await flushMicrotasks();
  assert.ok(checker.get().verdict, "Snapshot fallback via mockFetch must produce a verdict while live socket is down");
  assert.equal(checker.get().verdictVia, "snapshot");

  tickSteps(t, 8000, 100);
  await flushMicrotasks();
  assert.equal(mockCtl.failConnects, 0);
  assert.equal(checker.get().conn, "open");
  assert.equal(checker.get().mode, "live");
  assert.ok(announcements.some((a) => a.msg === "Reconnected. Live assistant is back."));

  mockCtl.slow = true;
  tickSteps(t, 5000, 100);
  assert.ok((checker.get().rtt ?? 0) >= 1100, `Expected slow RTT >= 1100ms, got ${String(checker.get().rtt)}`);
  assert.ok(checker.get().policy.tier === "slow" || checker.get().policy.tier === "very-slow");
  assert.ok(announcements.some((a) => a.msg === "Slow connection. Sending fewer pictures to keep up."));

  mockCtl.slow = false;
  tickSteps(t, 3500, 100);
  assert.ok((checker.get().rtt ?? 9999) < 700);
  assert.equal(checker.get().policy.tier, "normal");
  assert.ok(announcements.some((a) => a.msg === "Connection is fast again."));

  teardownChecker(checker, stopListening);
});

test("Resilience demo controls: mockCtl.geminiDown, pushDevice({ connected: true, worn: false, battery: 10 }) glasses-to-phone fallback + low-battery alert, and mockCtl.offline barcode mode", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: BASE_NOW_MS });
  const { announcements, stopListening, videoEl } = resetHarness(t);
  const checker = new CheckerClass();

  const sock = await startMockChecker(t, checker, videoEl);

  mockSetGeminiDown(true);
  assert.equal(mockCtl.geminiDown, true);
  const degradedHealth = checker.checkHealth();
  tickSteps(t, 1050, 100);
  await degradedHealth;
  await flushMicrotasks();
  assert.equal(checker.get().health, "down");
  assert.equal(checker.get().serverLive, "degraded");
  assert.equal(checker.get().mode, "snapshot");
  assert.ok(announcements.some((a) => a.politeness === "assertive" && a.msg.includes("Live assistant unavailable") && a.msg.includes("Switched to snapshot mode.")));

  mockSetGeminiDown(false);
  assert.equal(mockCtl.geminiDown, false);
  assert.equal(checker.get().serverLive, "open");
  assert.equal(checker.get().mode, "live");
  assert.ok(announcements.some((a) => a.msg === "Live assistant is back."));

  await checker.setSource("glasses");
  mockSetDevice({ connected: true, worn: true, battery: 82, streaming: true, source: "glasses" });
  assert.equal(checker.get().source, "glasses");
  assert.equal(checker.get().camera, "off");

  const lowUnwornState: DeviceState = { connected: true, worn: false, battery: 10, streaming: false, source: "glasses" };
  mockCtl.device = lowUnwornState;
  sock.pushDevice(lowUnwornState);
  await flushMicrotasks();

  assert.equal(checker.get().source, "phone", "Unworn glasses must automatically fall back to phone camera");
  assert.equal(checker.get().camera, "on");
  assert.equal(loadSettings().source, "phone");
  assert.ok(sentClientMessages.some((m) => m.type === "source" && m.source === "phone"));
  assert.ok(
    announcements.some((a) => a.politeness === "assertive" && a.msg === "Glasses taken off. Switched to the phone camera."),
    "Expected glasses-to-phone fallback announcement",
  );
  assert.ok(
    announcements.some((a) => a.politeness === "assertive" && a.msg === "Glasses battery low: 10 percent."),
    "Expected assertive low-battery announcement at 10 percent",
  );

  mockCtl.offline = true;
  envState.onLine = false;
  windowShim.dispatchEvent(new Event("offline"));

  const offlineHealth = checker.checkHealth();
  tickSteps(t, 1050, 100);
  await offlineHealth;
  await flushMicrotasks();

  assert.equal(checker.get().online, false);
  assert.equal(checker.get().mode, "offline");
  assert.equal(checker.get().health, "unreachable");
  assert.equal(checker.get().banner?.title, "Offline mode");
  assert.ok(
    announcements.some(
      (a) => a.politeness === "assertive" && a.msg === "You're offline. I can still recognise your saved medicines by barcode, but I can't read new labels.",
    ),
  );

  envState.detectedCodes = [{ rawValue: "6416542002149", format: "ean_13" }];
  tickSteps(t, 550, 100);
  await flushMicrotasks();

  const barcodeVerdict = checker.get().verdict;
  assert.ok(barcodeVerdict);
  assert.equal(barcodeVerdict.level, "match");
  assert.equal(barcodeVerdict.headline, "Amlodipine 5 mg (barcode match)");
  assert.equal(checker.get().verdictVia, "offline");
  assert.ok(barcodeVerdict.speech.includes("matched the barcode offline"));

  envState.detectedCodes = [{ rawValue: "9999999999999", format: "ean_13" }];
  tickSteps(t, 550, 100);
  await flushMicrotasks();

  const unknownVerdict = checker.get().verdict;
  assert.ok(unknownVerdict);
  assert.equal(unknownVerdict.level, "unsure");
  assert.equal(unknownVerdict.headline, "Not one of your saved barcodes");

  checker.sendText("what is this box");
  assert.ok(checker.get().captions.some((c) => c.role === "system" && c.text === "Offline: I can only check your saved medicines by barcode right now."));

  envState.detectedCodes = [];
  mockCtl.offline = false;
  envState.onLine = true;
  windowShim.dispatchEvent(new Event("online"));
  tickSteps(t, 1200, 100);
  await flushMicrotasks();

  assert.equal(checker.get().online, true);
  assert.equal(checker.get().mode, "live");
  assert.equal(checker.get().health, "ok");

  teardownChecker(checker, stopListening);
});
