import { describe, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type {
  ClientMsg,
  CoachCue,
  ServerMsg,
  Verdict,
  VerdictLevel,
} from "../../shared/types.ts";

const SELF_FILE = fileURLToPath(import.meta.url);
const TEST_DIR = path.dirname(SELF_FILE);
const WEB_DIR = path.resolve(TEST_DIR, "..");
const REPO_DIR = path.resolve(WEB_DIR, "..");
const PUBLIC_DIR = path.join(WEB_DIR, "public");

const SLASH = String.fromCharCode(47);
const LINE_COMMENT = String.fromCharCode(47, 47);
const BLOCK_COMMENT = String.fromCharCode(47, 42);
const HTML_COMMENT = String.fromCharCode(60, 33, 45, 45);
const EM_DASH = String.fromCharCode(8212);
const ESCAPED_EM_DASH = ["\\u", "2014"].join("");
const HTTPS_ORIGIN = ["https:", "", "holdup.example"].join(SLASH);
const XHTML_NS = ["http:", "", "www.w3.org", "1999", "xhtml"].join(SLASH);

const SECRET_PREFIXES = [
  ["AIza", "Sy"].join(""),
  ["AQ.", "Ab"].join(""),
  ["sk_", "live_"].join(""),
  ["sk_", "test_"].join(""),
  ["ghp", "_"].join(""),
  ["ya29", "."].join(""),
];

const SAFETY_PHRASE_IDS = [
  "offline",
  "back_online",
  "not_sure",
  "unknown_offline",
  "already_taken",
  "glasses_off",
  "camera_off",
] as const;

const CUE_PHRASE_IDS = [
  "cue_closer",
  "cue_further",
  "cue_rotate",
  "cue_tilt",
  "cue_more_light",
  "cue_steady",
  "cue_reading",
] as const;

const ALL_PHRASE_IDS = [...SAFETY_PHRASE_IDS, ...CUE_PHRASE_IDS] as const;
const VERDICT_LEVELS: VerdictLevel[] = ["match", "warning", "unsure", "info"];
const LOCALE_VARIANTS = ["en", "en-GB", "fi", "fi-FI", "sv", "sv-SE", "FI", "SV"] as const;

type PhraseEntry = { file: string; text: string };
type PhraseManifest = {
  model: string;
  generated: string;
  phrases: Record<string, Record<string, PhraseEntry>>;
};

const MANIFEST_PATH = path.join(PUBLIC_DIR, "phrases", "manifest.json");
const LANG_QA_PATH = path.join(REPO_DIR, "docs", "LANG_QA.md");
const REAL_MANIFEST_RAW = fs.readFileSync(MANIFEST_PATH, "utf8");
const REAL_MANIFEST = JSON.parse(REAL_MANIFEST_RAW) as PhraseManifest;
const LANG_QA_RAW = fs.readFileSync(LANG_QA_PATH, "utf8");

function setGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
  });
}

type ListenerFn = (...args: unknown[]) => unknown;

function makeEventMap() {
  const map = new Map<string, Set<ListenerFn>>();
  return {
    add(type: string, fn: ListenerFn) {
      const set = map.get(type) ?? new Set<ListenerFn>();
      set.add(fn);
      map.set(type, set);
    },
    remove(type: string, fn: ListenerFn) {
      map.get(type)?.delete(fn);
    },
    async emit(type: string, ev: unknown = {}) {
      for (const fn of [...(map.get(type) ?? [])]) {
        await fn(ev);
      }
    },
    clear() {
      map.clear();
    },
  };
}

function createStorage(): Storage {
  const store: Record<string, string> = Object.create(null);
  const proto = {
    get length(): number {
      return Object.keys(store).length;
    },
    key(index: number): string | null {
      return Object.keys(store)[index] ?? null;
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
  return Object.setPrototypeOf(store, proto) as Storage;
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
}

type MiniEvent = {
  type: string;
  key?: string;
  bubbles?: boolean;
  cancelable?: boolean;
  repeat?: boolean;
  defaultPrevented: boolean;
  target?: unknown;
  currentTarget?: unknown;
  preventDefault: () => void;
  stopPropagation: () => void;
};

function makeDomEvent(type: string, extra: Partial<MiniEvent> = {}): MiniEvent {
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
  [prop: string]: unknown;

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

class MiniComment extends MiniNode {
  nodeValue: string;

  constructor(text: string, ownerDocument: MiniDocument) {
    super(8, "#comment", ownerDocument);
    this.nodeValue = String(text);
  }
}

function matchesSingleSelector(el: MiniElement, raw: string): boolean {
  const s = raw.trim();
  if (!s) return false;
  if (s === "[contenteditable=true]") return el.getAttribute("contenteditable") === "true";
  if (s.startsWith(".")) {
    const cls = s.slice(1);
    return el.className.split(/\s+/).filter(Boolean).includes(cls);
  }
  if (s.startsWith("#")) {
    return el.getAttribute("id") === s.slice(1);
  }
  const dotIdx = s.indexOf(".");
  if (dotIdx > 0) {
    const tag = s.slice(0, dotIdx).toUpperCase();
    const cls = s.slice(dotIdx + 1);
    return el.tagName.toUpperCase() === tag && el.className.split(/\s+/).filter(Boolean).includes(cls);
  }
  return el.tagName.toUpperCase() === s.toUpperCase();
}

class MiniElement extends MiniNode {
  tagName: string;
  namespaceURI: string;
  style = new MiniStyle();
  attributes = new Map<string, string>();
  listeners = new Map<string, ListenerRecord[]>();
  scrollTop = 0;
  scrollHeight = 120;
  width = 320;
  height = 240;
  videoWidth = 640;
  videoHeight = 480;
  srcObject: unknown = null;
  value = "";
  scrollIntoViewCalls: unknown[] = [];

  constructor(tag: string, namespaceURI: string, ownerDocument: MiniDocument) {
    const nodeName = namespaceURI === XHTML_NS ? tag.toUpperCase() : tag;
    super(1, nodeName, ownerDocument);
    this.tagName = nodeName;
    this.namespaceURI = namespaceURI;
  }

  get id(): string {
    return this.attributes.get("id") ?? "";
  }

  set id(v: string) {
    if (v) this.attributes.set("id", String(v));
    else this.attributes.delete("id");
  }

  get className(): string {
    return this.attributes.get("class") ?? "";
  }

  set className(v: string) {
    if (v) this.attributes.set("class", String(v));
    else this.attributes.delete("class");
  }

  get disabled(): boolean {
    return this.attributes.has("disabled");
  }

  set disabled(v: boolean) {
    if (v) this.attributes.set("disabled", "");
    else this.attributes.delete("disabled");
  }

  setAttribute(name: string, val: string): void {
    this.attributes.set(name, String(val));
  }

  setAttributeNS(_ns: string | null, name: string, val: string): void {
    this.setAttribute(name, val);
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

  matches(selector: string): boolean {
    return selector.split(",").some((part) => matchesSingleSelector(this, part));
  }

  closest(selector: string): MiniElement | null {
    let cur: MiniNode | null = this;
    while (cur instanceof MiniElement) {
      if (cur.matches(selector)) return cur;
      cur = cur.parentNode;
    }
    return null;
  }

  querySelector(selector: string): MiniElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): MiniElement[] {
    return this.findAll((el) => el.matches(selector));
  }

  scrollIntoView(opts?: unknown): void {
    this.scrollIntoViewCalls.push(opts ?? null);
  }

  async play(): Promise<void> {}

  pause(): void {}

  getContext(kind: string) {
    if (kind !== "2d") return null;
    return {
      drawImage() {},
      getImageData: (_x: number, _y: number, w: number, h: number) => {
        const data = new Uint8ClampedArray(w * h * 4);
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const idx = (y * w + x) * 4;
            const lum = ((x + y) % 2 === 0 ? 235 : 20);
            data[idx] = lum;
            data[idx + 1] = lum;
            data[idx + 2] = lum;
            data[idx + 3] = 255;
          }
        }
        return { data, width: w, height: h };
      },
    };
  }

  toDataURL(): string {
    return "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD";
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
    this.dispatchEvent(makeDomEvent("click"));
  }

  get textContent(): string {
    let out = "";
    for (const child of this.childNodes) {
      if (child instanceof MiniText || child instanceof MiniElement) out += child.textContent;
    }
    return out;
  }

  set textContent(val: string) {
    this.childNodes = [];
    if (val) this.appendChild(new MiniText(val, this.ownerDocument!));
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

class MiniDocument extends MiniNode {
  documentElement: MiniElement;
  body: MiniElement;
  activeElement: MiniElement;
  defaultView: unknown = null;
  visibilityState: "visible" | "hidden" = "visible";
  title = "HoldUp";
  private docEvents = makeEventMap();
  private reactListeners = new Map<string, ListenerRecord[]>();

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

  createElementNS(ns: string | null, tag: string): MiniElement {
    return new MiniElement(tag, ns ?? XHTML_NS, this);
  }

  createTextNode(text: string): MiniText {
    return new MiniText(text, this);
  }

  createComment(text: string): MiniComment {
    return new MiniComment(text, this);
  }

  getElementById(id: string): MiniElement | null {
    return this.body.findAll((el) => el.getAttribute("id") === id)[0] ?? null;
  }

  addEventListener(type: string, fn: ListenerFn, options?: boolean | { capture?: boolean }): void {
    this.docEvents.add(type, fn);
    const capture = typeof options === "boolean" ? options : Boolean(options?.capture);
    const list = this.reactListeners.get(type) ?? [];
    list.push({ fn: fn as (ev: MiniEvent) => void, capture });
    this.reactListeners.set(type, list);
  }

  removeEventListener(type: string, fn: ListenerFn, options?: boolean | { capture?: boolean }): void {
    this.docEvents.remove(type, fn);
    const capture = typeof options === "boolean" ? options : Boolean(options?.capture);
    const list = this.reactListeners.get(type);
    if (!list) return;
    this.reactListeners.set(
      type,
      list.filter((item) => item.fn !== fn || item.capture !== capture),
    );
  }

  runListeners(type: string, ev: MiniEvent, capture: boolean): void {
    ev.currentTarget = this;
    for (const rec of this.reactListeners.get(type) ?? []) {
      if (rec.capture === capture) rec.fn(ev);
    }
  }

  async emitVisibility(next: "visible" | "hidden"): Promise<void> {
    this.visibilityState = next;
    await this.docEvents.emit("visibilitychange", { type: "visibilitychange" });
  }
}

type VoiceInfo = {
  name: string;
  lang: string;
  default: boolean;
  localService: boolean;
  voiceURI: string;
};

type SpokenUtteranceRecord = {
  text: string;
  lang: string;
  rate: number;
  volume: number;
  resolvedVoice: VoiceInfo | null;
};

const DEFAULT_VOICES: VoiceInfo[] = [
  { name: "Karen", lang: "en-AU", default: false, localService: true, voiceURI: "en-AU-karen" },
  { name: "Samantha", lang: "en-US", default: false, localService: true, voiceURI: "en-US-samantha" },
  { name: "Daniel", lang: "en-GB", default: true, localService: true, voiceURI: "en-GB-daniel" },
  { name: "Satu", lang: "fi-FI", default: false, localService: true, voiceURI: "fi-FI-satu" },
  { name: "Alva", lang: "sv-SE", default: false, localService: true, voiceURI: "sv-SE-alva" },
];

function resolveSynthVoice(voices: VoiceInfo[], lang: string): VoiceInfo | null {
  if (!voices.length) return null;
  const target = (lang || "").trim().toLowerCase();
  if (!target) return voices.find((v) => v.default) ?? voices[0] ?? null;
  const exact = voices.find((v) => v.lang.toLowerCase() === target);
  if (exact) return exact;
  const primary = target.slice(0, 2);
  const subtag = voices.find((v) => v.lang.toLowerCase().slice(0, 2) === primary);
  if (subtag) return subtag;
  return voices.find((v) => v.default) ?? voices[0] ?? null;
}

class MockUtterance {
  text: string;
  lang = "";
  rate = 1;
  volume = 1;
  voice: VoiceInfo | null = null;

  constructor(text: string) {
    this.text = text;
  }
}

type TrackedGainOp = {
  op: "set" | "linear" | "exp" | "target" | "cancel";
  value: number;
  time: number;
};

type TrackedOscillator = {
  type: OscillatorType;
  frequency: {
    value: number;
    targets: Array<{ value: number; time: number; tau: number }>;
    setTargetAtTime: (value: number, time: number, tau: number) => void;
  };
  startedAt: number | null;
  stoppedAt: number | null;
  connect: (dest: unknown) => unknown;
  start: (when?: number) => void;
  stop: (when?: number) => void;
};

type TrackedGain = {
  gain: {
    value: number;
    ops: TrackedGainOp[];
    setValueAtTime: (value: number, time: number) => void;
    linearRampToValueAtTime: (value: number, time: number) => void;
    exponentialRampToValueAtTime: (value: number, time: number) => void;
    setTargetAtTime: (value: number, time: number, tau: number) => void;
    cancelScheduledValues: (time: number) => void;
  };
  connect: (dest: unknown) => unknown;
};

type TrackedBufferSource = {
  buffer: AudioBuffer | null;
  onended: (() => void) | null;
  started: boolean;
  stopped: boolean;
  connect: (dest: unknown) => unknown;
  start: (when?: number) => void;
  stop: () => void;
  disconnect: () => void;
};

class MockAudioContext {
  state: "running" | "suspended" | "closed" = "running";
  currentTime = 0;
  destination = { kind: "destination" };
  oscillators: TrackedOscillator[] = [];
  gains: TrackedGain[] = [];
  bufferSources: TrackedBufferSource[] = [];
  audioWorklet = {
    async addModule(_url: string): Promise<void> {},
  };

  constructor() {
    env.audioContexts.push(this);
  }

  async resume(): Promise<void> {
    if (this.state !== "closed") this.state = "running";
  }

  async close(): Promise<void> {
    this.state = "closed";
  }

  createMediaStreamSource() {
    return {
      connect: (dest: unknown) => dest,
      disconnect() {},
    };
  }

  createBiquadFilter() {
    return {
      type: "lowpass",
      frequency: { value: 1200 },
      connect: (dest: unknown) => dest,
    };
  }

  createOscillator(): TrackedOscillator {
    const targets: Array<{ value: number; time: number; tau: number }> = [];
    const osc: TrackedOscillator = {
      type: "sine",
      frequency: {
        value: 440,
        targets,
        setTargetAtTime(val: number, time: number, tau: number) {
          osc.frequency.value = val;
          targets.push({ value: val, time, tau });
        },
      },
      startedAt: null,
      stoppedAt: null,
      connect: (dest: unknown) => dest,
      start(when = 0) {
        osc.startedAt = when;
      },
      stop(when = 0) {
        osc.stoppedAt = when;
      },
    };
    this.oscillators.push(osc);
    env.allOscillators.push(osc);
    return osc;
  }

  createGain(): TrackedGain {
    const ops: TrackedGainOp[] = [];
    const g: TrackedGain = {
      gain: {
        value: 1,
        ops,
        setValueAtTime(val: number, time: number) {
          g.gain.value = val;
          ops.push({ op: "set", value: val, time });
        },
        linearRampToValueAtTime(val: number, time: number) {
          g.gain.value = val;
          ops.push({ op: "linear", value: val, time });
        },
        exponentialRampToValueAtTime(val: number, time: number) {
          g.gain.value = val;
          ops.push({ op: "exp", value: val, time });
        },
        setTargetAtTime(val: number, time: number) {
          g.gain.value = val;
          ops.push({ op: "target", value: val, time });
        },
        cancelScheduledValues(time: number) {
          ops.push({ op: "cancel", value: 0, time });
        },
      },
      connect: (dest: unknown) => dest,
    };
    this.gains.push(g);
    env.allGains.push(g);
    return g;
  }

  createBuffer(_channels: number, length: number, sampleRate: number): AudioBuffer {
    const channel = new Float32Array(length);
    return {
      length,
      sampleRate,
      duration: length / sampleRate,
      numberOfChannels: 1,
      getChannelData: () => channel,
    } as unknown as AudioBuffer;
  }

  createBufferSource(): AudioBufferSourceNode {
    const src: TrackedBufferSource = {
      buffer: null,
      onended: null,
      started: false,
      stopped: false,
      connect: (dest: unknown) => dest,
      start() {
        src.started = true;
      },
      stop() {
        src.stopped = true;
      },
      disconnect() {},
    };
    this.bufferSources.push(src);
    env.allBufferSources.push(src);
    return src as unknown as AudioBufferSourceNode;
  }
}

class MockAudioWorkletNode {
  port = {
    onmessage: null as ((ev: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => void) | null,
    close() {},
  };

  connect(dest: unknown) {
    return dest;
  }

  disconnect(): void {}
}

class TrackedAudioElement {
  src: string;
  loop = false;
  volume = 1;
  paused = true;
  playCalls = 0;
  pauseCalls = 0;
  private timeValue = 2.4;

  constructor(src = "") {
    this.src = src;
    env.audioElements.push(this);
    if (src.includes(`${SLASH}phrases${SLASH}`)) {
      env.phraseAudioElements.push(this);
    }
  }

  get currentTime(): number {
    return this.timeValue;
  }

  set currentTime(v: number) {
    this.timeValue = v;
  }

  async play(): Promise<void> {
    this.playCalls++;
    if (this.src.includes(`${SLASH}phrases${SLASH}`)) {
      if (env.phrasePlayGate) await env.phrasePlayGate;
      if (env.rejectPhrasePlay) {
        this.paused = true;
        throw new Error("NotAllowedError: play blocked");
      }
    }
    this.paused = false;
  }

  pause(): void {
    this.pauseCalls++;
    this.paused = true;
  }
}

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

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
    env.sockets.push(this);
  }

  send(raw: string): void {
    if (this.readyState !== MockWebSocket.OPEN) throw new Error("Socket not open");
    this.sent.push(JSON.parse(raw) as ClientMsg);
  }

  close(code = 1000, reason = ""): void {
    this.readyState = MockWebSocket.CLOSED;
    const ev = Object.assign(new Event("close"), { code, reason, wasClean: code === 1000 }) as CloseEvent;
    this.onclose?.(ev);
  }

  serverOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  serverSend(msg: unknown): void {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(msg) }));
  }
}

class MockBroadcastChannel {
  name: string;
  onmessage: ((ev: MessageEvent) => void) | null = null;

  constructor(name: string) {
    this.name = name;
  }

  postMessage(_data: unknown): void {}
  close(): void {}
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

type MockMediaTrack = {
  kind: "video" | "audio";
  label: string;
  readyState: "live" | "ended";
  stopCalls: number;
  stop: () => void;
  addEventListener: (type: string, fn: ListenerFn) => void;
  removeEventListener: (type: string, fn: ListenerFn) => void;
};

function createTrack(kind: "video" | "audio", label: string): MockMediaTrack {
  const events = makeEventMap();
  const track: MockMediaTrack = {
    kind,
    label,
    readyState: "live",
    stopCalls: 0,
    stop() {
      track.stopCalls++;
      track.readyState = "ended";
    },
    addEventListener(type: string, fn: ListenerFn) {
      events.add(type, fn);
    },
    removeEventListener(type: string, fn: ListenerFn) {
      events.remove(type, fn);
    },
  };
  return track;
}

const localStorageShim = createStorage();
const sessionStorageShim = createStorage();
const winEvents = makeEventMap();
const doc = new MiniDocument();

const env = {
  voices: [...DEFAULT_VOICES] as VoiceInfo[],
  utterances: [] as SpokenUtteranceRecord[],
  cancelCalls: 0,
  vibrateCalls: [] as Array<number | number[]>,
  audioContexts: [] as MockAudioContext[],
  allOscillators: [] as TrackedOscillator[],
  allGains: [] as TrackedGain[],
  allBufferSources: [] as TrackedBufferSource[],
  audioElements: [] as TrackedAudioElement[],
  phraseAudioElements: [] as TrackedAudioElement[],
  rejectPhrasePlay: false,
  phrasePlayGate: null as Promise<void> | null,
  manifestStatus: 200,
  manifestBody: REAL_MANIFEST_RAW,
  sockets: [] as MockWebSocket[],
  videoTracks: [] as MockMediaTrack[],
  audioTracks: [] as MockMediaTrack[],
  historyPushes: 0,
  historyBacks: 0,
  navigatorLang: "en-GB",
  onLine: true,
};

const speechSynthesisShim = {
  speaking: false,
  getVoices: () => env.voices,
  cancel() {
    env.cancelCalls++;
    speechSynthesisShim.speaking = false;
  },
  speak(u: MockUtterance) {
    speechSynthesisShim.speaking = true;
    const resolved = u.voice ?? resolveSynthVoice(env.voices, u.lang);
    env.utterances.push({
      text: u.text,
      lang: u.lang,
      rate: u.rate,
      volume: u.volume,
      resolvedVoice: resolved,
    });
  },
};

const locationShim = {
  href: `${HTTPS_ORIGIN}${SLASH}`,
  origin: HTTPS_ORIGIN,
  protocol: "https:",
  host: "holdup.example",
  pathname: SLASH,
  search: "",
  hash: "",
};

const historyShim = {
  state: null as unknown,
  pushState(state: unknown) {
    historyShim.state = state;
    env.historyPushes++;
  },
  replaceState(state: unknown) {
    historyShim.state = state;
  },
  back() {
    env.historyBacks++;
    void winEvents.emit("popstate", makeDomEvent("popstate"));
  },
};

const navigatorShim = {
  get language() {
    return env.navigatorLang;
  },
  get onLine() {
    return env.onLine;
  },
  userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/131.0.0.0 Mobile",
  vibrate(pattern: number | number[]) {
    env.vibrateCalls.push(pattern);
    return true;
  },
  mediaSession: {
    metadata: null as unknown,
    playbackState: "none",
    setActionHandler() {},
  },
  mediaDevices: {
    async getUserMedia(constraints?: MediaStreamConstraints): Promise<MediaStream> {
      const vTracks: MockMediaTrack[] = [];
      const aTracks: MockMediaTrack[] = [];
      if (constraints?.video) {
        const vt = createTrack("video", "Rear label camera");
        vTracks.push(vt);
        env.videoTracks.push(vt);
      }
      if (constraints?.audio) {
        const at = createTrack("audio", "Glasses HFP mic");
        aTracks.push(at);
        env.audioTracks.push(at);
      }
      return {
        getTracks: () => [...vTracks, ...aTracks] as unknown as MediaStreamTrack[],
        getVideoTracks: () => vTracks as unknown as MediaStreamTrack[],
        getAudioTracks: () => aTracks as unknown as MediaStreamTrack[],
      } as unknown as MediaStream;
    },
    async enumerateDevices() {
      return [
        { kind: "audioinput", label: "Ray-Ban Meta HFP" },
        { kind: "audiooutput", label: "Ray-Ban Meta Audio" },
      ];
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

class MiniHTMLIFrameElement extends MiniElement {}

const windowShim: Record<string, unknown> = {
  window: null,
  document: doc,
  location: locationShim,
  history: historyShim,
  navigator: navigatorShim,
  localStorage: localStorageShim,
  sessionStorage: sessionStorageShim,
  isSecureContext: true,
  Node: MiniNode,
  Element: MiniElement,
  HTMLElement: MiniElement,
  HTMLIFrameElement: MiniHTMLIFrameElement,
  speechSynthesis: speechSynthesisShim,
  SpeechSynthesisUtterance: MockUtterance,
  AudioContext: MockAudioContext,
  AudioWorkletNode: MockAudioWorkletNode,
  Audio: TrackedAudioElement,
  WebSocket: MockWebSocket,
  BroadcastChannel: MockBroadcastChannel,
  MediaMetadata: MockMediaMetadata,
  URL,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  addEventListener(type: string, fn: ListenerFn) {
    winEvents.add(type, fn);
  },
  removeEventListener(type: string, fn: ListenerFn) {
    winEvents.remove(type, fn);
  },
  dispatchEvent(ev: MiniEvent) {
    void winEvents.emit(ev.type, ev);
    return !ev.defaultPrevented;
  },
};
windowShim.window = windowShim;
doc.defaultView = windowShim;

if (typeof URL.createObjectURL !== "function") {
  URL.createObjectURL = () => "blob:holdup-silent";
}

setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
setGlobal("React", React);
setGlobal("window", windowShim);
setGlobal("document", doc);
setGlobal("Node", MiniNode);
setGlobal("Element", MiniElement);
setGlobal("HTMLElement", MiniElement);
setGlobal("HTMLIFrameElement", MiniHTMLIFrameElement);
setGlobal("location", locationShim);
setGlobal("history", historyShim);
setGlobal("navigator", navigatorShim);
setGlobal("localStorage", localStorageShim);
setGlobal("sessionStorage", sessionStorageShim);
setGlobal("speechSynthesis", speechSynthesisShim);
setGlobal("SpeechSynthesisUtterance", MockUtterance);
setGlobal("AudioContext", MockAudioContext);
setGlobal("AudioWorkletNode", MockAudioWorkletNode);
setGlobal("Audio", TrackedAudioElement);
setGlobal("WebSocket", MockWebSocket);
setGlobal("BroadcastChannel", MockBroadcastChannel);
setGlobal("MediaMetadata", MockMediaMetadata);
setGlobal("fetch", async (input: RequestInfo | URL): Promise<Response> => {
  const url = String(input);
  if (url.includes(`${SLASH}phrases${SLASH}manifest.json`)) {
    if (env.manifestStatus === 0) throw new TypeError("Failed to fetch manifest");
    return new Response(env.manifestBody, {
      status: env.manifestStatus,
      headers: { "content-type": "application/json" },
    });
  }
  if (url.includes(`${SLASH}api${SLASH}health`)) {
    return new Response(JSON.stringify({ ok: true, gemini: "ok" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (url.includes(`${SLASH}api${SLASH}stats`)) {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
});

const storageMod = await import("../src/lib/storage.ts");
const feedbackMod = await import("../src/lib/feedback.ts");
const phrasesMod = await import("../src/lib/phrases.ts");
const audioMod = await import("../src/lib/audio.ts");
const verdictsMod = await import("../src/lib/verdicts.ts");
const checkerMod = await import("../src/lib/checker.ts");
const announcerMod = await import("../src/components/Announcer.tsx");
const liveScreenMod = await import("../src/screens/Live.tsx");
const hudScreenMod = await import("../src/screens/Hud.tsx");
const serverLiveMod = await import("../../server/src/live.ts");
const prerenderMod = await import("../../server/scripts/prerender-phrases.ts");

function resetEnv(): void {
  phrasesMod.stopPhrase();
  feedbackMod.stopSpeaking();
  localStorageShim.clear();
  sessionStorageShim.clear();
  doc.visibilityState = "visible";
  doc.body.childNodes = [];
  doc.activeElement = doc.body;
  env.voices = [...DEFAULT_VOICES];
  env.utterances.length = 0;
  env.cancelCalls = 0;
  env.vibrateCalls.length = 0;
  env.audioContexts.length = 0;
  env.allOscillators.length = 0;
  env.allGains.length = 0;
  env.allBufferSources.length = 0;
  env.audioElements.length = 0;
  env.phraseAudioElements.length = 0;
  env.rejectPhrasePlay = false;
  env.phrasePlayGate = null;
  env.manifestStatus = 200;
  env.manifestBody = REAL_MANIFEST_RAW;
  env.sockets.length = 0;
  env.videoTracks.length = 0;
  env.audioTracks.length = 0;
  env.historyPushes = 0;
  env.historyBacks = 0;
  env.navigatorLang = "en-GB";
  env.onLine = true;
}

async function flushMicrotasks(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

function loadFreshPhrases(tag: string): Promise<typeof phrasesMod> {
  const base = pathToFileURL(path.join(WEB_DIR, "src", "lib", "phrases.ts")).href;
  return import(`${base}?case=${encodeURIComponent(tag)}`) as Promise<typeof phrasesMod>;
}

function makeVerdict(level: VerdictLevel, headline: string, speech: string, matchedMedId?: string): Verdict {
  return {
    level,
    headline,
    speech,
    matchedMedId,
    takenToday: false,
    reasons: [speech],
    read: verdictsMod.emptyRead(),
  };
}

type LangQaRow = {
  id: string;
  english: string;
  original: string;
  audited: string;
};

function parseLangQaSection(markdown: string, headingPrefix: string): Map<string, LangQaRow> {
  const lines = markdown.split("\n");
  const startIdx = lines.findIndex((line) => line.startsWith(headingPrefix));
  assert.ok(startIdx >= 0, `Missing section ${headingPrefix}`);
  const rows = new Map<string, LangQaRow>();
  const englishRe = new RegExp('\\*"([^"]+)"\\*');
  const origRe = new RegExp('\\*\\*Original:\\*\\*\\s*`"([^"]+)"`');
  const auditedRe = new RegExp('\\*\\*(?:Corrected|Unchanged):\\*\\*\\s*`"([^"]+)"`');
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("### ") || line.startsWith("## ")) break;
    if (!line.startsWith("| `")) continue;
    const cols = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cols.length < 5) continue;
    const id = cols[0].replaceAll("`", "").trim();
    const enMatch = englishRe.exec(cols[1]);
    const origMatch = origRe.exec(cols[2]);
    const audMatch = auditedRe.exec(cols[4]);
    assert.ok(enMatch && origMatch && audMatch, `Malformed LANG_QA row for ${id}`);
    rows.set(id, {
      id,
      english: enMatch[1],
      original: origMatch[1],
      audited: audMatch[1],
    });
  }
  return rows;
}

function parseLangQaVerdictLeads(markdown: string): Record<"fi" | "sv", Record<VerdictLevel, string>> {
  const lines = markdown.split("\n");
  const startIdx = lines.findIndex((line) => line.startsWith("### 3.1 "));
  assert.ok(startIdx >= 0, "Missing section 3.1 in LANG_QA.md");
  const out: Record<"fi" | "sv", Record<string, string>> = { fi: {}, sv: {} };
  const fiRe = new RegExp('`fi`:\\s*`"([^"]+)"`');
  const svRe = new RegExp('`sv`:\\s*`"([^"]+)"`');
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("### ") || line.startsWith("## ")) break;
    if (!line.startsWith("| `")) continue;
    const cols = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cols.length < 5) continue;
    const level = cols[0].replaceAll("`", "").trim();
    const fiMatch = fiRe.exec(cols[4]);
    const svMatch = svRe.exec(cols[4]);
    assert.ok(fiMatch && svMatch, `Malformed LANG_QA verdict row for ${level}`);
    out.fi[level] = fiMatch[1];
    out.sv[level] = svMatch[1];
  }
  return out as Record<"fi" | "sv", Record<VerdictLevel, string>>;
}

describe("TASK A-W4: Multilingual EN/FI/SV voice, live-region anti-flooding, deafblind/quiet & cognitive-load accessibility", () => {
  test("feedback.ts speak, primeSpeech, stopSpeaking, and defaultLang handle multi-voice EN/FI/SV selection across en, en-GB, fi, fi-FI, sv, sv-SE, FI, and SV", () => {
    resetEnv();

    feedbackMod.primeSpeech();
    const expectedNorm: Record<(typeof LOCALE_VARIANTS)[number], "en" | "fi" | "sv"> = {
      en: "en",
      "en-GB": "en",
      fi: "fi",
      "fi-FI": "fi",
      sv: "sv",
      "sv-SE": "sv",
      FI: "fi",
      SV: "sv",
    };

    for (const variant of LOCALE_VARIANTS) {
      env.navigatorLang = variant;
      assert.equal(storageMod.defaultLang(), expectedNorm[variant], `defaultLang(${variant})`);

      env.utterances.length = 0;
      env.cancelCalls = 0;
      localStorageShim.setItem(
        "holdup.profile",
        JSON.stringify({ ...storageMod.demoProfile(), lang: variant }),
      );
      feedbackMod.speak("Yes, this is Amlodipine 5 mg.");
      assert.equal(env.cancelCalls, 1);
      assert.equal(env.utterances.length, 1);
      assert.equal(env.utterances[0].lang, "en-GB");
      assert.equal(env.utterances[0].resolvedVoice?.lang, "en-GB");
      assert.equal(env.utterances[0].resolvedVoice?.name, "Daniel");
    }

    const explicitBcp47: Array<{ lang: string; expectedVoiceLang: string; expectedName: string }> = [
      { lang: "en-GB", expectedVoiceLang: "en-GB", expectedName: "Daniel" },
      { lang: "en-US", expectedVoiceLang: "en-US", expectedName: "Samantha" },
      { lang: "fi-FI", expectedVoiceLang: "fi-FI", expectedName: "Satu" },
      { lang: "sv-SE", expectedVoiceLang: "sv-SE", expectedName: "Alva" },
      { lang: "fi", expectedVoiceLang: "fi-FI", expectedName: "Satu" },
      { lang: "sv", expectedVoiceLang: "sv-SE", expectedName: "Alva" },
      { lang: "FI", expectedVoiceLang: "fi-FI", expectedName: "Satu" },
      { lang: "SV", expectedVoiceLang: "sv-SE", expectedName: "Alva" },
    ];

    for (const item of explicitBcp47) {
      env.utterances.length = 0;
      env.cancelCalls = 0;
      feedbackMod.speak("Localized check", { lang: item.lang, interrupt: false });
      assert.equal(env.cancelCalls, 0);
      assert.equal(env.utterances.length, 1);
      assert.equal(env.utterances[0].lang, item.lang);
      assert.equal(env.utterances[0].resolvedVoice?.lang, item.expectedVoiceLang);
      assert.equal(env.utterances[0].resolvedVoice?.name, item.expectedName);
    }

    env.cancelCalls = 0;
    feedbackMod.stopSpeaking();
    assert.equal(env.cancelCalls, 1);
  });

  test("phrases.ts playPhrase, sayPhrase, stopPhrase, cuePhraseId, and verdictPhraseId preserve localized FI/SV clips without English MP3 fallback on failure", async () => {
    resetEnv();
    const freshOk = await loadFreshPhrases("ok-clips");

    for (const lang of ["en", "fi", "sv"] as const) {
      for (const id of SAFETY_PHRASE_IDS) {
        env.phraseAudioElements.length = 0;
        const spoken: string[] = [];
        const localized = REAL_MANIFEST.phrases[lang][id].text;
        await freshOk.sayPhrase(id, lang, (t) => spoken.push(t), localized);
        assert.equal(env.phraseAudioElements.length, 1);
        assert.equal(env.phraseAudioElements[0].src, `/phrases/${lang}/${id}.mp3`);
        assert.equal(spoken.length, 0);
      }
    }

    env.rejectPhrasePlay = true;
    for (const lang of ["fi", "sv"] as const) {
      for (const id of SAFETY_PHRASE_IDS) {
        env.phraseAudioElements.length = 0;
        const played = await freshOk.playPhrase(id, lang);
        assert.equal(played, false, `playPhrase(${id}, ${lang}) must return false when MP3 play fails`);
        assert.equal(env.phraseAudioElements.length, 1);
        assert.equal(env.phraseAudioElements[0].src, `/phrases/${lang}/${id}.mp3`);
        assert.equal(
          env.phraseAudioElements.some((a) => a.src.includes(`${SLASH}phrases${SLASH}en${SLASH}`)),
          false,
          `playPhrase(${id}, ${lang}) must never attempt an English .mp3`,
        );

        const spokenFallback: string[] = [];
        const localizedText = REAL_MANIFEST.phrases[lang][id].text;
        await freshOk.sayPhrase(id, lang, (t) => spokenFallback.push(t), localizedText);
        assert.deepEqual(spokenFallback, [localizedText]);
        assert.notEqual(spokenFallback[0], REAL_MANIFEST.phrases.en[id].text);
      }
    }

    env.rejectPhrasePlay = false;
    env.manifestStatus = 503;
    const freshMiss = await loadFreshPhrases("manifest-503");
    for (const lang of ["fi", "sv"] as const) {
      env.phraseAudioElements.length = 0;
      const spoken: string[] = [];
      const localized = REAL_MANIFEST.phrases[lang].offline.text;
      await freshMiss.sayPhrase("offline", lang, (t) => spoken.push(t), localized);
      assert.equal(env.phraseAudioElements.length, 0, "no English .mp3 attempted when manifest misses");
      assert.deepEqual(spoken, [localized]);
    }
    env.manifestStatus = 200;

    let releasePlay: () => void = () => {};
    env.phrasePlayGate = new Promise<void>((resolve) => {
      releasePlay = resolve;
    });
    env.phraseAudioElements.length = 0;
    const inFlightSpoken: string[] = [];
    const pendingSay = freshOk.sayPhrase(
      "not_sure",
      "fi",
      (t) => inFlightSpoken.push(t),
      REAL_MANIFEST.phrases.fi.not_sure.text,
    );
    await flushMicrotasks();
    assert.equal(env.phraseAudioElements.length, 1);
    freshOk.stopPhrase();
    releasePlay();
    await pendingSay;
    assert.equal(env.phraseAudioElements[0].paused, true);
    assert.equal(env.phraseAudioElements[0].currentTime, 0);
    assert.equal(inFlightSpoken.length, 0, "stopPhrase mid-flight must suppress fallback speech");
    env.phrasePlayGate = null;

    assert.equal(phrasesMod.cuePhraseId("closer"), "cue_closer");
    assert.equal(phrasesMod.cuePhraseId("farther"), "cue_further");
    assert.equal(phrasesMod.cuePhraseId("rotate_left"), "cue_rotate");
    assert.equal(phrasesMod.cuePhraseId("rotate_right"), "cue_rotate");
    assert.equal(phrasesMod.cuePhraseId("other_side"), "cue_tilt");
    assert.equal(phrasesMod.cuePhraseId("more_light"), "cue_more_light");
    assert.equal(phrasesMod.cuePhraseId("hold_still", "Hold still"), "cue_steady");
    assert.equal(phrasesMod.cuePhraseId("hold_still", "Reading the label"), "cue_reading");
    assert.equal(phrasesMod.cuePhraseId("ok", "Got it"), "cue_reading");
    assert.equal(phrasesMod.cuePhraseId("ok", "Camera stopped"), "camera_off");

    assert.equal(
      phrasesMod.verdictPhraseId(makeVerdict("unsure", "Strength unreadable", "I'm not sure."), "live"),
      "not_sure",
    );
    assert.equal(
      phrasesMod.verdictPhraseId(
        makeVerdict("warning", "Amlodipine already taken today", "You already took Amlodipine today."),
        "offline",
      ),
      "already_taken",
    );
    assert.equal(
      phrasesMod.verdictPhraseId(
        makeVerdict("unsure", "Not one of your saved barcodes", "Unknown barcode."),
        "offline",
      ),
      "unknown_offline",
    );
    assert.equal(
      phrasesMod.verdictPhraseId(
        makeVerdict("match", "Amlodipine 5 mg", "Yes, this is Amlodipine 5 mg.", "amlodipine"),
        "live",
      ),
      null,
    );
  });

  test("Hud.tsx hudSpeechLang maps holdup.profile lang (fi, sv, en) to fi-FI, sv-SE, en-US and cancels immediately on worn:false, Dismiss, and Speak off", async (t: TestContext) => {
    resetEnv();
    localStorageShim.setItem("holdup.hud.speak", "1");

    const mount = doc.createElement("div");
    doc.body.appendChild(mount);
    const root = createRoot(mount as unknown as Element);
    t.after(async () => {
      await act(async () => {
        root.unmount();
      });
    });

    await act(async () => {
      root.render(createElement(hudScreenMod.Hud));
    });
    assert.equal(env.sockets.length, 1);
    const ws = env.sockets[0];
    await act(async () => {
      ws.serverOpen();
    });

    const hudLangCases: Array<{ rawProfile: string | null; expectedLang: string }> = [
      { rawProfile: JSON.stringify({ ...storageMod.demoProfile(), lang: "fi" }), expectedLang: "fi-FI" },
      { rawProfile: JSON.stringify({ ...storageMod.demoProfile(), lang: "sv" }), expectedLang: "sv-SE" },
      { rawProfile: JSON.stringify({ ...storageMod.demoProfile(), lang: "en" }), expectedLang: "en-US" },
      { rawProfile: "{bad-json", expectedLang: "en-US" },
      { rawProfile: null, expectedLang: "en-US" },
    ];

    for (const item of hudLangCases) {
      env.utterances.length = 0;
      if (item.rawProfile === null) localStorageShim.removeItem("holdup.profile");
      else localStorageShim.setItem("holdup.profile", item.rawProfile);

      const v = makeVerdict("match", `Amlodipine 5 mg (${item.expectedLang})`, "Yes, Amlodipine 5 mg.", "amlodipine");
      await act(async () => {
        ws.serverSend({ type: "verdict", verdict: v });
      });
      assert.equal(env.utterances.length, 1);
      assert.equal(env.utterances[0].lang, item.expectedLang);
      assert.equal(env.utterances[0].text, `right one. ${v.headline}`);
    }

    env.cancelCalls = 0;
    await act(async () => {
      ws.serverSend({
        type: "device",
        device: { connected: true, worn: false, battery: 74, streaming: false, source: "glasses" },
      });
    });
    assert.ok(env.cancelCalls >= 1, "taking glasses off (worn: false) must cancel HUD speech");

    env.cancelCalls = 0;
    const speakBtn = mount.findAll((el) => el.matches(".hud-speak"))[0];
    assert.ok(speakBtn, "HUD Speak toggle button must exist");
    assert.equal(speakBtn.getAttribute("aria-pressed"), "true");
    await act(async () => {
      speakBtn.click();
    });
    assert.equal(speakBtn.getAttribute("aria-pressed"), "false");
    assert.equal(localStorageShim.getItem("holdup.hud.speak"), "0");
    assert.ok(env.cancelCalls >= 1, "turning Speak off must cancel HUD speech");
  });

  test("Deafblind / haptics-only & quiet mode (voice:false, earcons:false, haptics:true, quiet:true) emits zero audio/TTS, distinct vibration patterns, and 100% announce() delivery", async (t: TestContext) => {
    resetEnv();
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_700_000_000_000 });

    feedbackMod.primeSpeech();
    env.utterances.length = 0;

    storageMod.saveSettings({
      ...storageMod.loadSettings(),
      voice: false,
      earcons: false,
      haptics: true,
      quiet: true,
    });

    const mount = doc.createElement("div");
    doc.body.appendChild(mount);
    const root = createRoot(mount as unknown as Element);

    const announcements: Array<{ msg: string; politeness: "polite" | "assertive" }> = [];
    const offAnnounce = feedbackMod.onAnnounce((msg, politeness) => {
      announcements.push({ msg, politeness });
    });

    const checker = new checkerMod.Checker();
    t.after(async () => {
      offAnnounce();
      checker.dispose();
      await act(async () => {
        root.unmount();
      });
    });

    await act(async () => {
      root.render(createElement(announcerMod.Announcer));
    });

    await checker.start();
    assert.equal(env.sockets.length, 1);
    const ws = env.sockets[0];
    ws.serverOpen();
    ws.serverSend({
      type: "ready",
      session: checker.get().session,
      model: "gemini-3.8-live",
      features: ["scene", "datamatrix", "addmed", "sonar"],
    });

    const pcmChunk = audioMod.synthPcmChunks([440], 100)[0];
    ws.serverSend({ type: "audio", data: pcmChunk });
    ws.serverSend({ type: "readiness", value: 0.45 });
    ws.serverSend({ type: "readiness", value: 0.92 });

    const directionalCues: Array<{ cue: CoachCue; text: string }> = [
      { cue: "rotate_left", text: "Turn the box left" },
      { cue: "rotate_right", text: "Turn the box right" },
      { cue: "closer", text: "A bit closer" },
      { cue: "farther", text: "Move slightly back" },
      { cue: "hold_still", text: "Hold still" },
      { cue: "ok", text: "Got it, reading" },
    ];
    const cueVibrateSigs: string[] = [];
    for (const c of directionalCues) {
      const before = env.vibrateCalls.length;
      ws.serverSend({ type: "coach", cue: c.cue, text: c.text });
      assert.equal(env.vibrateCalls.length, before + 1);
      cueVibrateSigs.push(JSON.stringify(env.vibrateCalls[before]));
      assert.ok(
        announcements.some((a) => a.msg === c.text && a.politeness === "polite"),
        `coach cue "${c.text}" must be delivered politely to screen readers when voice is false`,
      );
    }
    assert.equal(new Set(cueVibrateSigs).size, directionalCues.length, "directional coaching cues must have pairwise-distinct vibration signatures");

    ws.serverSend({ type: "checking", phase: "start" });
    assert.ok(announcements.some((a) => a.msg === "Checking…" && a.politeness === "polite"));

    const verdictSignatures: Record<VerdictLevel, string> = {
      match: "",
      warning: "",
      unsure: "",
      info: "",
    };
    const sampleVerdicts: Record<VerdictLevel, Verdict> = {
      match: makeVerdict("match", "Amlodipine 5 mg", "Yes, this is Amlodipine 5 mg.", "amlodipine"),
      warning: makeVerdict("warning", "Ibuprofen 400 mg", "Warning: Ibuprofen is on your avoid list."),
      unsure: makeVerdict("unsure", "Strength unreadable", "I'm not sure. I won't guess a dose."),
      info: makeVerdict("info", "Oat crackers", "Info: Oat crackers, no tree nuts or peanuts listed."),
    };

    for (const lvl of VERDICT_LEVELS) {
      const before = env.vibrateCalls.length;
      const v = sampleVerdicts[lvl];
      await act(async () => {
        ws.serverSend({ type: "verdict", verdict: v });
        t.mock.timers.tick(80);
      });
      assert.equal(env.vibrateCalls.length, before + 1);
      verdictSignatures[lvl] = JSON.stringify(env.vibrateCalls[before]);
      const expectedAnnouncement = `${checkerMod.levelWord(lvl)}. ${v.headline}. ${v.speech}`;
      assert.ok(
        announcements.some((a) => a.msg === expectedAnnouncement && a.politeness === "assertive"),
        `verdict ${lvl} must announce assertively`,
      );
      const alertNode = mount.findAll((el) => el.getAttribute("role") === "alert")[0];
      assert.equal(alertNode?.textContent, expectedAnnouncement);
    }

    assert.equal(verdictSignatures.match, JSON.stringify([90, 70, 90]));
    assert.equal(verdictSignatures.warning, JSON.stringify([300, 120, 300, 120, 300]));
    assert.equal(verdictSignatures.unsure, JSON.stringify([160, 120, 60]));
    assert.equal(verdictSignatures.info, JSON.stringify(60));
    assert.equal(new Set(Object.values(verdictSignatures)).size, 4, "match, warning, unsure, and info haptic patterns must be pairwise distinct");

    ws.serverSend({ type: "correction", speech: "Warning: Ibuprofen is an NSAID on your avoid list." });
    assert.ok(
      announcements.some(
        (a) => a.msg === "Corrected answer: Warning: Ibuprofen is an NSAID on your avoid list." && a.politeness === "assertive",
      ),
    );

    await checker.stop();
    await flushMicrotasks();

    assert.equal(env.utterances.length, 0, "zero speechSynthesis utterances in deafblind/haptics-only mode");
    assert.equal(env.allBufferSources.length, 0, "zero PCM audio playback in deafblind/haptics-only mode");
    assert.equal(env.phraseAudioElements.length, 0, "zero phrase Audio clips in deafblind/haptics-only mode");
    assert.equal(env.allOscillators.length, 0, "zero earcon or Sonar oscillators when earcons:false and quiet:true");
    assert.ok(
      announcements.some((a) => a.msg.startsWith("Check started.") && a.politeness === "assertive"),
    );
    assert.ok(
      announcements.some((a) => a.msg.startsWith("Check stopped.") && a.politeness === "assertive"),
    );

    storageMod.saveSettings({
      ...storageMod.loadSettings(),
      voice: false,
      earcons: true,
      haptics: true,
      quiet: true,
    });
    env.allGains.length = 0;
    feedbackMod.earcon.match();
    const quietRamps = env.allGains.flatMap((g) => g.gain.ops.filter((op) => op.op === "linear").map((op) => op.value));
    assert.deepEqual(quietRamps, [0.09, 0.09, 0.09], "quiet:true halves earcon linear ramp peak from 0.18 to 0.09");
  });

  test("Live.tsx screen-reader anti-flooding keeps partial captions out of aria-live=polite while announcing final non-user lines and single-shot verdicts", async (t: TestContext) => {
    resetEnv();
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_700_000_000_000 });
    storageMod.saveConsent();

    const checker = new checkerMod.Checker();
    const mount = doc.createElement("div");
    doc.body.appendChild(mount);
    const root = createRoot(mount as unknown as Element);

    const announcements: Array<{ msg: string; politeness: "polite" | "assertive" }> = [];
    const offAnnounce = feedbackMod.onAnnounce((msg, politeness) => {
      announcements.push({ msg, politeness });
    });

    t.after(async () => {
      offAnnounce();
      checker.dispose();
      await act(async () => {
        root.unmount();
      });
    });

    await act(async () => {
      root.render(
        createElement(
          React.Fragment,
          null,
          createElement(announcerMod.Announcer),
          createElement(liveScreenMod.Live, {
            checker,
            consented: true,
            onReviewConsent: () => {},
            onFixPermissions: () => {},
          }),
        ),
      );
    });

    await act(async () => {
      await checker.start();
    });
    const ws = env.sockets[0];
    await act(async () => {
      ws.serverOpen();
    });

    const getConversationPoliteP = () =>
      mount.findAll(
        (el) =>
          el.tagName === "P" &&
          el.className.includes("sr-only") &&
          el.getAttribute("aria-live") === "polite" &&
          el.getAttribute("aria-atomic") === "true",
      )[0];

    assert.ok(getConversationPoliteP(), "Live.tsx sr-only polite caption paragraph must exist");
    assert.equal(getConversationPoliteP().textContent, "");

    const partialStream: ServerMsg[] = [
      { type: "transcript", role: "user", text: "Is this", final: false },
      { type: "transcript", role: "user", text: "Is this my evening pill?", final: true },
      { type: "transcript", role: "assistant", text: "Hold", final: false },
      { type: "transcript", role: "assistant", text: "Hold the box", final: false },
      { type: "transcript", role: "assistant", text: "Hold the box steady", final: false },
    ];

    for (const msg of partialStream) {
      await act(async () => {
        ws.serverSend(msg);
      });
      assert.equal(
        getConversationPoliteP().textContent,
        "",
        "partial streaming captions and user transcripts must never update the sr-only aria-live=polite region",
      );
    }

    const captionsLog = mount.findAll((el) => el.className.includes("captions"))[0];
    assert.ok(captionsLog, "visible div.captions must render when captions exist");
    assert.equal(captionsLog.getAttribute("role"), "log");
    assert.equal(captionsLog.getAttribute("aria-live"), "off");

    await act(async () => {
      ws.serverSend({ type: "transcript", role: "assistant", text: "Hold the box steady so I can read it.", final: true });
    });
    assert.equal(getConversationPoliteP().textContent, "HoldUp: Hold the box steady so I can read it.");

    announcements.length = 0;
    const matchV = makeVerdict("match", "Amlodipine 5 mg", "Yes, this is Amlodipine 5 mg for the evening.", "amlodipine");
    await act(async () => {
      ws.serverSend({ type: "verdict", verdict: matchV });
      ws.serverSend({ type: "transcript", role: "assistant", text: "Yes, this is", final: false });
      ws.serverSend({ type: "transcript", role: "assistant", text: "Yes, this is Amlodipine", final: false });
      t.mock.timers.tick(80);
    });

    const expectedVerdictMsg = "Match. Amlodipine 5 mg. Yes, this is Amlodipine 5 mg for the evening.";
    const verdictAnnounceCount = announcements.filter((a) => a.msg === expectedVerdictMsg).length;
    assert.equal(verdictAnnounceCount, 1, "verdict must announce exactly once without duplicate clobber");
    assert.equal(
      getConversationPoliteP().textContent,
      "HoldUp: Hold the box steady so I can read it.",
      "partial post-verdict assistant transcripts must not clobber the polite caption region",
    );

    const verdictHeading = mount.findAll((el) => el.getAttribute("id") === "verdict-h")[0];
    assert.ok(verdictHeading, "VerdictCard heading must mount");
    assert.equal(doc.activeElement, verdictHeading, "focus moves to VerdictCard heading on new verdict");
    const actionsEl = mount.findAll((el) => el.closest(".verdict") !== null && el.matches(".actions"))[0];
    assert.ok(actionsEl && actionsEl.scrollIntoViewCalls.length >= 1, "VerdictCard .actions scrolls clear of sticky Stop bar");

    env.onLine = false;
    await act(async () => {
      await winEvents.emit("offline", { type: "offline" });
      checker.sendText("Can you read this?");
    });
    assert.equal(
      getConversationPoliteP().textContent,
      "Note: Offline: I can only check your saved medicines by barcode right now.",
    );
  });

  test("User transcript barge-in flushes PcmPlayer, unducks Sonar, cancels speechSynthesis and active phrase Audio, while ignoring whitespace", async (t: TestContext) => {
    resetEnv();
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_700_000_000_000 });

    storageMod.saveSettings({
      ...storageMod.loadSettings(),
      voice: true,
      earcons: true,
      haptics: true,
      quiet: false,
    });

    const checker = new checkerMod.Checker();
    t.after(() => checker.dispose());

    await checker.start();
    const ws = env.sockets[0];
    ws.serverOpen();
    ws.serverSend({
      type: "ready",
      session: checker.get().session,
      model: "gemini-3.8-live",
      features: ["scene", "datamatrix", "addmed", "sonar"],
    });

    ws.serverSend({ type: "readiness", value: 0.85 });
    assert.equal(checker.get().readiness, 0.85);
    const sonarGainCountBeforeDuck = env.allGains.reduce(
      (sum, g) => sum + g.gain.ops.filter((op) => op.op === "target").length,
      0,
    );
    assert.ok(sonarGainCountBeforeDuck >= 1, "Sonar active gain scheduled");

    const pcmChunk = audioMod.synthPcmChunks([520, 620], 180)[0];
    ws.serverSend({ type: "audio", data: pcmChunk });
    assert.equal(checker.get().speaking, true);

    const duckedTargets = env.allGains.flatMap((g) => g.gain.ops.filter((op) => op.op === "target").map((op) => op.value));
    const expectedUnducked = 0.35 * 0.09;
    const expectedDucked = expectedUnducked * 0.25;
    assert.ok(duckedTargets.some((v) => Math.abs(v - expectedDucked) < 1e-6), "Sonar gain ducks to 0.25x while assistant speaks");

    await phrasesMod.playPhrase("not_sure", "fi");
    const activePhraseAudio = env.phraseAudioElements[env.phraseAudioElements.length - 1];
    assert.ok(activePhraseAudio && !activePhraseAudio.paused);
    feedbackMod.speak("Assistant speaking");
    const cancelsBeforeWhitespace = env.cancelCalls;
    const stopDeadlineBefore = checker.get().autoStopAt ?? 0;

    t.mock.timers.tick(5_000);
    ws.serverSend({ type: "transcript", role: "user", text: "   ", final: false });
    assert.equal(checker.get().speaking, true, "whitespace-only user transcript must not barge in");
    assert.equal(activePhraseAudio.paused, false);
    assert.equal(env.cancelCalls, cancelsBeforeWhitespace);

    ws.serverSend({ type: "transcript", role: "user", text: "Wait, check the back", final: false });
    assert.equal(checker.get().speaking, false, "non-empty user transcript flushes PcmPlayer immediately");
    assert.equal(activePhraseAudio.paused, true, "barge-in pauses active phrase Audio");
    assert.equal(activePhraseAudio.currentTime, 0, "barge-in resets phrase Audio currentTime to 0");
    assert.equal(env.cancelCalls, cancelsBeforeWhitespace + 1, "barge-in cancels speechSynthesis");
    assert.ok((checker.get().autoStopAt ?? 0) > stopDeadlineBefore, "barge-in rearms 45s auto-stop timer");
    assert.ok(env.allBufferSources.every((s) => s.stopped), "all queued PcmPlayer buffer sources stopped");
  });

  test("Explicit stop(), 45s AUTO_STOP_MS timer, and server auto-stop status stop camera, mic, Sonar, and active audio cleanly", async (t: TestContext) => {
    resetEnv();
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_700_000_000_000 });

    const announcements: Array<{ msg: string; politeness: "polite" | "assertive" }> = [];
    const offAnnounce = feedbackMod.onAnnounce((msg, politeness) => {
      announcements.push({ msg, politeness });
    });

    const checker = new checkerMod.Checker();
    t.after(() => {
      offAnnounce();
      checker.dispose();
    });

    await checker.start();
    const ws1 = env.sockets[0];
    ws1.serverOpen();
    ws1.serverSend({ type: "readiness", value: 0.75 });
    await phrasesMod.playPhrase("offline", "sv");
    const svAudio = env.phraseAudioElements[env.phraseAudioElements.length - 1];
    const camTrack1 = env.videoTracks[0];
    const micTrack1 = env.audioTracks[0];

    await checker.stop();
    assert.equal(checker.get().running, false);
    assert.equal(checker.get().camera, "off");
    assert.equal(checker.get().mic, "off");
    assert.equal(checker.get().readiness, null);
    assert.ok(camTrack1.stopCalls >= 1, "stop() stops phone camera video track");
    assert.ok(micTrack1.stopCalls >= 1, "stop() stops microphone audio track");
    assert.equal(svAudio.paused, true, "stop() pauses active phrase Audio");
    assert.equal(svAudio.currentTime, 0);
    assert.ok(
      announcements.some((a) => a.msg === "Check stopped. Camera and microphone off." && a.politeness === "assertive"),
    );

    announcements.length = 0;
    env.phraseAudioElements.length = 0;
    await checker.start();
    const ws2 = env.sockets[env.sockets.length - 1];
    ws2.serverOpen();
    ws2.serverSend({ type: "readiness", value: 0.65 });
    const camTrack2 = env.videoTracks[env.videoTracks.length - 1];
    const micTrack2 = env.audioTracks[env.audioTracks.length - 1];

    t.mock.timers.tick(45_000);
    await flushMicrotasks(10);

    assert.equal(checker.get().running, false, "45s AUTO_STOP_MS stops session automatically");
    assert.equal(checker.get().camera, "off");
    assert.equal(checker.get().mic, "off");
    assert.equal(checker.get().readiness, null);
    assert.ok(camTrack2.stopCalls >= 1, "45s auto-stop releases camera track");
    assert.ok(micTrack2.stopCalls >= 1, "45s auto-stop releases mic track");
    assert.ok(
      announcements.some(
        (a) => a.msg === "Stopped automatically after 45 seconds without a label. Camera off." && a.politeness === "assertive",
      ),
    );
    assert.ok(
      env.phraseAudioElements.some((a) => a.src.endsWith(`${SLASH}camera_off.mp3`)),
      "45s auto-stop plays camera_off phrase",
    );

    announcements.length = 0;
    env.phraseAudioElements.length = 0;
    await checker.start();
    const ws3 = env.sockets[env.sockets.length - 1];
    ws3.serverOpen();
    const camTrack3 = env.videoTracks[env.videoTracks.length - 1];

    ws3.serverSend({ type: "status", live: "closed", detail: "auto-stopped: no camera frames for 45 s" });
    await flushMicrotasks(10);

    assert.equal(checker.get().running, false, "server auto-stop status stops session");
    assert.ok(camTrack3.stopCalls >= 1);
    assert.ok(
      announcements.some(
        (a) => a.msg === "Stopped automatically after 45 seconds without a label. Camera off." && a.politeness === "assertive",
      ),
    );
    assert.ok(env.phraseAudioElements.some((a) => a.src.endsWith(`${SLASH}camera_off.mp3`)));
  });

  test("visibilitychange hidden pauses camera tracks and halts frame capture, and visible resumes camera with calm announcement", async (t: TestContext) => {
    resetEnv();
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_700_000_000_000 });

    const announcements: Array<{ msg: string; politeness: "polite" | "assertive" }> = [];
    const offAnnounce = feedbackMod.onAnnounce((msg, politeness) => {
      announcements.push({ msg, politeness });
    });

    const checker = new checkerMod.Checker();
    const videoEl = doc.createElement("video") as unknown as HTMLVideoElement;
    checker.attachVideo(videoEl);

    t.after(() => {
      offAnnounce();
      checker.dispose();
    });

    await checker.start();
    const ws = env.sockets[0];
    ws.serverOpen();
    const initialCamTrack = env.videoTracks[0];
    assert.equal(checker.get().camera, "on");
    assert.equal(checker.get().hidden, false);

    t.mock.timers.tick(500);
    const sentBeforeHide = checker.get().framesSent;
    assert.ok(sentBeforeHide >= 1, "camera sends sharp frame while visible");

    await doc.emitVisibility("hidden");
    assert.equal(checker.get().hidden, true);
    assert.equal(checker.get().camera, "paused");
    assert.ok(initialCamTrack.stopCalls >= 1, "backgrounding immediately stops phone camera track");
    assert.equal((videoEl as unknown as MiniElement).srcObject, null, "backgrounding detaches video.srcObject");

    t.mock.timers.tick(3_000);
    assert.equal(checker.get().framesSent, sentBeforeHide, "zero frames sent while app is hidden in background");

    await doc.emitVisibility("visible");
    await flushMicrotasks();
    assert.equal(checker.get().hidden, false);
    assert.equal(checker.get().camera, "on");
    assert.equal(env.videoTracks.length, 2, "returning to foreground acquires a fresh camera stream");
    assert.ok(
      announcements.some((a) => a.msg === "Welcome back. Camera resumed." && a.politeness === "polite"),
    );
  });

  test("100% string parity across docs/LANG_QA.md, web/public/phrases/manifest.json, server/scripts/prerender-phrases.ts, web/src/lib/phrases.ts, and server/src/live.ts VERDICT_LEAD", () => {
    const fiRows = parseLangQaSection(LANG_QA_RAW, "### 2.1 Finnish");
    const svRows = parseLangQaSection(LANG_QA_RAW, "### 2.2 Swedish");
    const docLeads = parseLangQaVerdictLeads(LANG_QA_RAW);

    assert.equal(fiRows.size, 7, "LANG_QA.md 2.1 documents all 7 safety phrase IDs");
    assert.equal(svRows.size, 7, "LANG_QA.md 2.2 documents all 7 safety phrase IDs");

    for (const id of SAFETY_PHRASE_IDS) {
      const fiRow = fiRows.get(id);
      const svRow = svRows.get(id);
      assert.ok(fiRow, `LANG_QA.md 2.1 missing ${id}`);
      assert.ok(svRow, `LANG_QA.md 2.2 missing ${id}`);

      assert.equal(fiRow.english, REAL_MANIFEST.phrases.en[id].text, `LANG_QA 2.1 English parity for ${id}`);
      assert.equal(svRow.english, REAL_MANIFEST.phrases.en[id].text, `LANG_QA 2.2 English parity for ${id}`);
      assert.equal(fiRow.original, REAL_MANIFEST.phrases.fi[id].text, `LANG_QA 2.1 FI manifest parity for ${id}`);
      assert.equal(svRow.original, REAL_MANIFEST.phrases.sv[id].text, `LANG_QA 2.2 SV manifest parity for ${id}`);
      assert.ok(fiRow.audited.length >= 10, `LANG_QA 2.1 audited FI text non-empty for ${id}`);
      assert.ok(svRow.audited.length >= 10, `LANG_QA 2.2 audited SV text non-empty for ${id}`);
      assert.equal(fiRow.audited.includes("offline-tilassa"), false);
    }

    for (const lang of ["en", "fi", "sv"] as const) {
      for (const id of ALL_PHRASE_IDS) {
        const entry = REAL_MANIFEST.phrases[lang]?.[id];
        assert.ok(entry, `manifest.json missing ${lang}/${id}`);
        assert.equal(entry.text, prerenderMod.PHRASES[id]?.[lang], `prerender PHRASES parity for ${lang}/${id}`);
        const relFile = entry.file.startsWith(SLASH) ? entry.file.slice(1) : entry.file;
        const diskFile = path.join(PUBLIC_DIR, relFile);
        assert.equal(fs.existsSync(diskFile), true, `missing audio asset ${diskFile}`);
        assert.ok(fs.statSync(diskFile).size > 1024, `audio asset ${diskFile} must exceed 1 KiB`);
      }
    }

    assert.deepEqual(serverLiveMod.VERDICT_LEAD.fi, {
      match: "Oikea pakkaus.",
      warning: "Varoitus.",
      unsure: "En ole varma.",
      info: "Tiedoksi.",
    });
    assert.deepEqual(serverLiveMod.VERDICT_LEAD.sv, {
      match: "Rätt förpackning.",
      warning: "Varning.",
      unsure: "Jag är inte säker.",
      info: "För kännedom.",
    });
    assert.deepEqual(docLeads.fi, serverLiveMod.VERDICT_LEAD.fi);
    assert.deepEqual(docLeads.sv, serverLiveMod.VERDICT_LEAD.sv);

    for (const level of VERDICT_LEVELS) {
      assert.deepEqual(serverLiveMod.leadFor("en", level), {});
      assert.deepEqual(serverLiveMod.leadFor("en-GB", level), {});
      for (const fiTag of ["fi", "fi-FI", "FI"]) {
        assert.equal(serverLiveMod.leadFor(fiTag, level).lead, serverLiveMod.VERDICT_LEAD.fi[level]);
      }
      for (const svTag of ["sv", "sv-SE", "SV"]) {
        assert.equal(serverLiveMod.leadFor(svTag, level).lead, serverLiveMod.VERDICT_LEAD.sv[level]);
      }
    }

    for (const nordicTag of ["fi", "fi-FI", "FI", "sv", "sv-SE", "SV"]) {
      const instr = serverLiveMod.speakInstruction(nordicTag, "Tail.");
      assert.ok(instr.includes("First say `lead` exactly as written"));
      assert.ok(instr.includes("do not repeat the opener"));
      assert.ok(instr.includes("2,5 mg"));
    }
    assert.equal(serverLiveMod.speakInstruction("en-GB", "Tail."), "Say `speech` word for word, then stop. Tail.");
  });

  test("multilingualCognitiveVoiceA11y.test.ts enforces zero code comments, zero em dashes, and zero secret prefixes", () => {
    const raw = fs.readFileSync(SELF_FILE, "utf8");
    assert.equal(raw.includes(LINE_COMMENT), false, "zero line comments allowed");
    assert.equal(raw.includes(BLOCK_COMMENT), false, "zero block comments allowed");
    assert.equal(raw.includes(HTML_COMMENT), false, "zero HTML comments allowed");
    assert.equal(raw.includes(EM_DASH), false, "zero em dashes allowed");
    assert.equal(raw.includes(ESCAPED_EM_DASH), false, "zero escaped em dashes allowed");
    for (const prefix of SECRET_PREFIXES) {
      assert.equal(raw.includes(prefix), false, `secret prefix ${prefix} forbidden`);
    }
  });
});
