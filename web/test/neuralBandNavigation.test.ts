import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
  HudApp,
  buildHudWsUrl,
  clampHudHeadline,
  computeHudReconnectDelayMs,
  initialHudState,
  nextFocusIndex,
  reduceHudServerMsg,
  resolveHudSession,
  resolveHudSpeak,
  sanitizeHudText,
  validateHudSessionParam,
  type HudAppProps,
  type HudWsLike
} from "../src/hud/HudApp.tsx";
import type {
  CoachCue,
  DeviceState,
  LabelRead,
  ServerMsg,
  Verdict,
  VerdictLevel
} from "../../shared/types.ts";

(globalThis as Record<string, unknown>).React = React;

type TestFn = (name: string, fn: () => void | Promise<void>) => Promise<void>;

interface StrictAssert {
  ok(value: unknown, message?: string): asserts value;
  equal<T>(actual: T, expected: T, message?: string): void;
  notEqual<T>(actual: T, expected: T, message?: string): void;
  deepEqual<T>(actual: T, expected: T, message?: string): void;
  match(value: string, regExp: RegExp, message?: string): void;
  doesNotMatch(value: string, regExp: RegExp, message?: string): void;
}

interface FsModule {
  readFileSync(path: URL | string, encoding: "utf8"): string;
}

const nodeTestSpec: string = "node:test";
const nodeAssertSpec: string = "node:assert/strict";
const nodeFsSpec: string = "node:fs";

const test: TestFn = ((await import(nodeTestSpec)) as { test: TestFn }).test;
const assert: StrictAssert = ((await import(nodeAssertSpec)) as { default: StrictAssert }).default;
const { readFileSync } = (await import(nodeFsSpec)) as FsModule;

const DOUBLE_SLASH = "\x2f\x2f";
const LINE_COMMENT = "\x2f\x2f";
const BLOCK_COMMENT_OPEN = "\x2f*";
const BLOCK_COMMENT_CLOSE = "*\x2f";
const HTML_COMMENT_OPEN = "<" + "!--";
const EM_DASH = String.fromCharCode(8212);
const EN_DASH = String.fromCharCode(8211);
const XHTML_NS = `http:${DOUBLE_SLASH}www.w3.org/1999/xhtml`;

type HudOutboundEvent = {
  type: "event";
  name: "log_dose" | "repeat" | "dismiss";
};

function makeDevice(overrides: Partial<DeviceState> = {}): DeviceState {
  return {
    connected: true,
    worn: true,
    battery: 88,
    streaming: true,
    source: "glasses",
    ...overrides
  };
}

function makeLabelRead(overrides: Partial<LabelRead> = {}): LabelRead {
  return {
    kind: "medication",
    product: { value: "Amlodipine", confidence: 0.98 },
    ingredient: { value: "amlodipine", confidence: 0.97 },
    strength: { value: "5 mg", confidence: 0.96 },
    dosing: { value: "1 tablet each evening", confidence: 0.92 },
    expiry: { value: "2027-09", confidence: 0.94 },
    allergens: { value: [], confidence: 0.95 },
    barcode: { value: "6432100012345", confidence: 0.99 },
    readability: 0.96,
    ...overrides
  };
}

function makeVerdict(overrides: Partial<Verdict> = {}): Verdict {
  return {
    level: "match",
    headline: "Yes, your evening Amlodipine 5 mg",
    speech: "Yes, this is Amlodipine 5 mg, your scheduled evening pill.",
    matchedMedId: "aml",
    takenToday: false,
    reasons: ["Matches saved evening medication", "Strength 5 mg verified"],
    read: makeLabelRead(),
    ...overrides
  };
}

function renderHudSsr(props?: HudAppProps): string {
  return renderToStaticMarkup(createElement(HudApp, props));
}

function extractActionBtnTag(
  html: string,
  action: "log_dose" | "repeat" | "dismiss"
): string {
  const pattern = new RegExp(`<button\\b[^>]*data-hud-action="${action}"[^>]*>`, "i");
  const match = pattern.exec(html);
  assert.ok(match, `Expected HUD action button ${action}`);
  return match[0];
}

type ListenerEntry = {
  fn: (ev: unknown) => void;
  capture: boolean;
};

class MiniDomNode {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly tagName: string;
  namespaceURI: string = XHTML_NS;
  ownerDocument: MiniDomDocument;
  parentNode: MiniDomNode | null = null;
  childNodes: MiniDomNode[] = [];
  style: Record<string, string> = {};
  attributes = new Map<string, string>();
  listeners = new Map<string, ListenerEntry[]>();
  disabled = false;
  textContentValue = "";
  lastFocusOptions: { preventScroll?: boolean } | undefined = undefined;
  focusCalls = 0;
  blurCalls = 0;

  constructor(nodeType: number, name: string, ownerDoc: MiniDomDocument) {
    this.nodeType = nodeType;
    this.nodeName = name.toUpperCase();
    this.tagName = name.toUpperCase();
    this.ownerDocument = ownerDoc;
  }

  get firstChild(): MiniDomNode | null {
    return this.childNodes[0] ?? null;
  }

  get nextSibling(): MiniDomNode | null {
    if (!this.parentNode) {
      return null;
    }
    const idx = this.parentNode.childNodes.indexOf(this);
    return idx >= 0 ? (this.parentNode.childNodes[idx + 1] ?? null) : null;
  }

  get nodeValue(): string {
    return this.textContentValue;
  }

  set nodeValue(val: string) {
    this.textContentValue = String(val);
  }

  get textContent(): string {
    if (this.nodeType === 3) {
      return this.textContentValue;
    }
    return this.childNodes.map((child) => child.textContent).join("");
  }

  set textContent(val: string) {
    if (this.nodeType === 3) {
      this.textContentValue = String(val);
      return;
    }
    const text = String(val);
    if (text.length === 0) {
      for (const child of this.childNodes) {
        child.parentNode = null;
      }
      this.childNodes = [];
      return;
    }
    const textNode = new MiniDomNode(3, "#text", this.ownerDocument);
    textNode.textContentValue = text;
    textNode.parentNode = this;
    this.childNodes = [textNode];
  }

  appendChild(child: MiniDomNode): MiniDomNode {
    if (child.parentNode) {
      child.parentNode.removeChild(child);
    }
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  insertBefore(child: MiniDomNode, ref: MiniDomNode | null): MiniDomNode {
    if (!ref) {
      return this.appendChild(child);
    }
    if (child.parentNode) {
      child.parentNode.removeChild(child);
    }
    const idx = this.childNodes.indexOf(ref);
    child.parentNode = this;
    if (idx === -1) {
      this.childNodes.push(child);
    } else {
      this.childNodes.splice(idx, 0, child);
    }
    return child;
  }

  removeChild(child: MiniDomNode): MiniDomNode {
    const idx = this.childNodes.indexOf(child);
    if (idx >= 0) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }

  setAttribute(name: string, value: string): void {
    const str = String(value);
    this.attributes.set(name, str);
    if (name === "disabled") {
      this.disabled = true;
    }
  }

  setAttributeNS(_ns: string | null, name: string, value: string): void {
    this.setAttribute(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
    if (name === "disabled") {
      this.disabled = false;
    }
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(
    type: string,
    fn: (ev: unknown) => void,
    opts?: boolean | { capture?: boolean }
  ): void {
    const capture = typeof opts === "boolean" ? opts : Boolean(opts?.capture);
    const list = this.listeners.get(type) ?? [];
    list.push({ fn, capture });
    this.listeners.set(type, list);
  }

  removeEventListener(
    type: string,
    fn: (ev: unknown) => void,
    opts?: boolean | { capture?: boolean }
  ): void {
    const capture = typeof opts === "boolean" ? opts : Boolean(opts?.capture);
    const list = this.listeners.get(type);
    if (!list) {
      return;
    }
    const idx = list.findIndex((entry) => entry.fn === fn && entry.capture === capture);
    if (idx >= 0) {
      list.splice(idx, 1);
    }
  }

  focus(options?: { preventScroll?: boolean }): void {
    if (this.disabled) {
      return;
    }
    this.focusCalls += 1;
    this.lastFocusOptions = options;
    this.ownerDocument.activeElement = this;
  }

  blur(): void {
    this.blurCalls += 1;
    if (this.ownerDocument.activeElement === this) {
      this.ownerDocument.activeElement = this.ownerDocument.body;
    }
  }

  dispatchBubblingEvent(type: string, extra: Record<string, unknown> = {}): {
    defaultPrevented: boolean;
  } {
    const path: MiniDomNode[] = [];
    let cursor: MiniDomNode | null = this;
    while (cursor) {
      path.push(cursor);
      cursor = cursor.parentNode;
    }

    const eventObj: Record<string, unknown> & {
      defaultPrevented: boolean;
      propagationStopped: boolean;
      preventDefault(): void;
      stopPropagation(): void;
    } = {
      type,
      target: this,
      srcElement: this,
      currentTarget: null,
      bubbles: true,
      cancelable: true,
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.propagationStopped = true;
      },
      ...extra
    };

    for (let i = path.length - 1; i >= 0; i -= 1) {
      eventObj.currentTarget = path[i];
      for (const listener of [...(path[i].listeners.get(type) ?? [])]) {
        if (listener.capture) {
          listener.fn(eventObj);
        }
      }
    }

    for (let i = 0; i < path.length; i += 1) {
      if (eventObj.propagationStopped) {
        break;
      }
      eventObj.currentTarget = path[i];
      for (const listener of [...(path[i].listeners.get(type) ?? [])]) {
        if (!listener.capture) {
          listener.fn(eventObj);
        }
      }
    }

    return { defaultPrevented: eventObj.defaultPrevented };
  }

  findByAttr(attr: string, expected: string): MiniDomNode | null {
    if (this.attributes.get(attr) === expected) {
      return this;
    }
    for (const child of this.childNodes) {
      const found = child.findByAttr(attr, expected);
      if (found) {
        return found;
      }
    }
    return null;
  }

  findAllByTag(tagName: string, out: MiniDomNode[] = []): MiniDomNode[] {
    if (this.nodeType === 1 && this.tagName === tagName.toUpperCase()) {
      out.push(this);
    }
    for (const child of this.childNodes) {
      child.findAllByTag(tagName, out);
    }
    return out;
  }
}

class MiniDomDocument {
  readonly nodeType = 9;
  defaultView: unknown = null;
  documentElement: MiniDomNode;
  body: MiniDomNode;
  activeElement: MiniDomNode;
  listeners = new Map<string, Set<(ev: unknown) => void>>();

  constructor() {
    this.documentElement = new MiniDomNode(1, "html", this);
    this.body = new MiniDomNode(1, "body", this);
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
  }

  createElement(tag: string): MiniDomNode {
    return new MiniDomNode(1, tag, this);
  }

  createElementNS(ns: string, tag: string): MiniDomNode {
    const el = new MiniDomNode(1, tag, this);
    el.namespaceURI = ns;
    return el;
  }

  createTextNode(text: string): MiniDomNode {
    const node = new MiniDomNode(3, "#text", this);
    node.textContentValue = String(text);
    return node;
  }

  addEventListener(type: string, fn: (ev: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set<(ev: unknown) => void>();
    set.add(fn);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, fn: (ev: unknown) => void): void {
    this.listeners.get(type)?.delete(fn);
  }
}

class FakeHudSocket implements HudWsLike {
  readyState = 0;
  readonly sent: HudOutboundEvent[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data) as HudOutboundEvent);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(msg: ServerMsg): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  receiveRaw(payload: unknown): void {
    this.onmessage?.({ data: payload });
  }

  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

class MockHistory {
  private stack: Array<{ state: unknown; url: string }> = [{ state: null, url: "/hud" }];
  private index = 0;
  maxLength = 1;
  pushCount = 0;
  replaceCount = 0;
  private readonly onPop: (state: unknown) => void;

  constructor(onPop: (state: unknown) => void) {
    this.onPop = onPop;
  }

  get length(): number {
    return this.stack.length;
  }

  get state(): unknown {
    return this.stack[this.index]?.state ?? null;
  }

  pushState(state: unknown, _unused: string, url?: string): void {
    this.stack = this.stack.slice(0, this.index + 1);
    this.stack.push({ state, url: url ?? "/hud" });
    this.index = this.stack.length - 1;
    this.pushCount += 1;
    if (this.stack.length > this.maxLength) {
      this.maxLength = this.stack.length;
    }
  }

  replaceState(state: unknown, _unused: string, url?: string): void {
    this.stack[this.index] = {
      state,
      url: url ?? this.stack[this.index]?.url ?? "/hud"
    };
    this.replaceCount += 1;
    if (this.stack.length > this.maxLength) {
      this.maxLength = this.stack.length;
    }
  }

  back(): void {
    if (this.index > 0) {
      this.index -= 1;
      this.stack = this.stack.slice(0, this.index + 1);
      this.onPop(this.state);
    }
  }
}

function createStorageTrap(label: string, touches: string[]): Storage {
  const target = {} as Storage;
  return new Proxy(target, {
    get(_obj, prop) {
      touches.push(`${label}:get:${String(prop)}`);
      throw new Error(`Forbidden ${label} read on HUD: ${String(prop)}`);
    },
    set(_obj, prop, value) {
      touches.push(`${label}:set:${String(prop)}=${String(value)}`);
      throw new Error(`Forbidden ${label} write on HUD: ${String(prop)}`);
    },
    has(_obj, prop) {
      touches.push(`${label}:has:${String(prop)}`);
      return false;
    },
    deleteProperty(_obj, prop) {
      touches.push(`${label}:delete:${String(prop)}`);
      throw new Error(`Forbidden ${label} delete on HUD: ${String(prop)}`);
    },
    ownKeys() {
      touches.push(`${label}:ownKeys`);
      return [];
    }
  });
}

type MountedHudOptions = {
  protocol?: string;
  host?: string;
  pathname?: string;
  search?: string;
  props?: Omit<HudAppProps, "createWs">;
  mapEscapeAndBackspaceToHistoryBack?: boolean;
  initialHtmlBg?: string;
  initialBodyBg?: string;
};

type MountedHudHarness = {
  doc: MiniDomDocument;
  container: MiniDomNode;
  history: MockHistory;
  sockets: FakeHudSocket[];
  storageTouches: string[];
  spokenUtterances: Array<{ text: string; lang: string; rate: number }>;
  speechCancelCount: () => number;
  windowListenerCount: (type: string) => number;
  advanceClockMs: (deltaMs: number) => void;
  getActionButton: (name: "log_dose" | "repeat" | "dismiss") => MiniDomNode;
  focusedActionName: () => string | null;
  pressKey: (key: string) => Promise<{ defaultPrevented: boolean }>;
  clickAction: (name: "log_dose" | "repeat" | "dismiss") => Promise<void>;
  focusAction: (name: "log_dose" | "repeat" | "dismiss") => Promise<void>;
  swipeBack: () => Promise<void>;
  sendServerMsg: (msg: ServerMsg) => Promise<void>;
  unmount: () => Promise<void>;
};

async function withMountedHud(
  options: MountedHudOptions,
  run: (hud: MountedHudHarness) => Promise<void>
): Promise<void> {
  const g = globalThis as Record<string, unknown>;
  const prevWindow = g.window;
  const prevDocument = g.document;
  const prevActEnv = g.IS_REACT_ACT_ENVIRONMENT;
  const prevUtterance = g.SpeechSynthesisUtterance;
  const prevLocalDesc = Object.getOwnPropertyDescriptor(g, "localStorage");
  const prevSessionDesc = Object.getOwnPropertyDescriptor(g, "sessionStorage");
  const prevIndexedDbDesc = Object.getOwnPropertyDescriptor(g, "indexedDB");
  const realDateNow = Date.now;

  let nowMs = 1_763_150_000_000;
  Date.now = () => nowMs;

  const storageTouches: string[] = [];
  const localTrap = createStorageTrap("localStorage", storageTouches);
  const sessionTrap = createStorageTrap("sessionStorage", storageTouches);
  const idbTrap = createStorageTrap("indexedDB", storageTouches);

  const spokenUtterances: Array<{ text: string; lang: string; rate: number }> = [];
  let cancels = 0;

  class MockUtterance {
    text: string;
    lang = "en-US";
    rate = 1.0;
    constructor(text: string) {
      this.text = text;
    }
  }

  const winListeners = new Map<string, Set<(ev: unknown) => void>>();
  const dispatchWindowEvent = (type: string, ev: unknown) => {
    for (const fn of [...(winListeners.get(type) ?? [])]) {
      fn(ev);
    }
  };

  const history = new MockHistory((poppedState) => {
    dispatchWindowEvent("popstate", { type: "popstate", state: poppedState });
  });

  const doc = new MiniDomDocument();
  doc.documentElement.style.backgroundColor = options.initialHtmlBg ?? "rgb(18, 25, 38)";
  doc.body.style.backgroundColor = options.initialBodyBg ?? "rgb(18, 25, 38)";
  doc.body.style.margin = "8px";
  doc.body.style.overflow = "auto";

  const container = doc.createElement("div");
  doc.body.appendChild(container);

  class FakeIframe {}
  const winObj: Record<string, unknown> = {
    HTMLIFrameElement: FakeIframe,
    HTMLElement: MiniDomNode,
    Element: MiniDomNode,
    Node: MiniDomNode,
    document: doc,
    location: {
      protocol: options.protocol ?? "https:",
      host: options.host ?? "holdup.example",
      pathname: options.pathname ?? "/hud",
      search: options.search ?? ""
    },
    history,
    speechSynthesis: {
      cancel() {
        cancels += 1;
      },
      speak(u: MockUtterance) {
        spokenUtterances.push({ text: u.text, lang: u.lang, rate: u.rate });
      }
    },
    addEventListener(type: string, fn: (ev: unknown) => void) {
      const set = winListeners.get(type) ?? new Set<(ev: unknown) => void>();
      set.add(fn);
      winListeners.set(type, set);
    },
    removeEventListener(type: string, fn: (ev: unknown) => void) {
      winListeners.get(type)?.delete(fn);
    }
  };

  Object.defineProperty(winObj, "localStorage", {
    configurable: true,
    get() {
      storageTouches.push("window.localStorage:getter");
      return localTrap;
    }
  });
  Object.defineProperty(winObj, "sessionStorage", {
    configurable: true,
    get() {
      storageTouches.push("window.sessionStorage:getter");
      return sessionTrap;
    }
  });
  Object.defineProperty(winObj, "indexedDB", {
    configurable: true,
    get() {
      storageTouches.push("window.indexedDB:getter");
      return idbTrap;
    }
  });

  doc.defaultView = winObj;

  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.window = winObj;
  g.document = doc;
  g.SpeechSynthesisUtterance = MockUtterance;

  Object.defineProperty(g, "localStorage", {
    configurable: true,
    get() {
      storageTouches.push("global.localStorage:getter");
      return localTrap;
    }
  });
  Object.defineProperty(g, "sessionStorage", {
    configurable: true,
    get() {
      storageTouches.push("global.sessionStorage:getter");
      return sessionTrap;
    }
  });
  Object.defineProperty(g, "indexedDB", {
    configurable: true,
    get() {
      storageTouches.push("global.indexedDB:getter");
      return idbTrap;
    }
  });

  const sockets: FakeHudSocket[] = [];
  const root = createRoot(container as unknown as Element);
  let unmounted = false;

  const unmount = async () => {
    if (!unmounted) {
      unmounted = true;
      await act(async () => {
        root.unmount();
      });
    }
  };

  try {
    await act(async () => {
      root.render(
        createElement(HudApp, {
          ...options.props,
          createWs: (url: string) => {
            const sock = new FakeHudSocket(url);
            sockets.push(sock);
            return sock;
          }
        })
      );
    });

    const getActionButton = (name: "log_dose" | "repeat" | "dismiss"): MiniDomNode => {
      const btn = container.findByAttr("data-hud-action", name);
      assert.ok(btn, `Expected mounted button for ${name}`);
      return btn;
    };

    const focusedActionName = (): string | null => {
      for (const name of ["log_dose", "repeat", "dismiss"] as const) {
        const btn = getActionButton(name);
        if (btn.getAttribute("data-focused") === "true") {
          return name;
        }
      }
      return null;
    };

    const harness: MountedHudHarness = {
      doc,
      container,
      history,
      sockets,
      storageTouches,
      spokenUtterances,
      speechCancelCount: () => cancels,
      windowListenerCount: (type: string) => winListeners.get(type)?.size ?? 0,
      advanceClockMs: (deltaMs: number) => {
        nowMs += deltaMs;
      },
      getActionButton,
      focusedActionName,
      pressKey: async (key: string) => {
        let prevented = false;
        await act(async () => {
          const ev = {
            type: "keydown",
            key,
            defaultPrevented: false,
            preventDefault() {
              this.defaultPrevented = true;
              prevented = true;
            }
          };
          dispatchWindowEvent("keydown", ev);

          if ((key === " " || key === "Spacebar") && !ev.defaultPrevented) {
            const active = doc.activeElement;
            if (active.tagName === "BUTTON" && !active.disabled) {
              active.dispatchBubblingEvent("click");
              prevented = true;
            }
          }

          if (
            options.mapEscapeAndBackspaceToHistoryBack &&
            (key === "Escape" || key === "Backspace") &&
            !ev.defaultPrevented
          ) {
            history.back();
            prevented = true;
          }
        });
        return { defaultPrevented: prevented };
      },
      clickAction: async (name) => {
        const btn = getActionButton(name);
        if (btn.disabled) {
          return;
        }
        await act(async () => {
          btn.dispatchBubblingEvent("click");
        });
      },
      focusAction: async (name) => {
        const btn = getActionButton(name);
        if (btn.disabled) {
          return;
        }
        await act(async () => {
          btn.focus({ preventScroll: true });
          btn.dispatchBubblingEvent("focusin");
        });
      },
      swipeBack: async () => {
        await act(async () => {
          history.back();
        });
      },
      sendServerMsg: async (msg: ServerMsg) => {
        const activeSocket = sockets.at(-1);
        assert.ok(activeSocket, "Expected active FakeHudSocket");
        await act(async () => {
          activeSocket.receive(msg);
        });
      },
      unmount
    };

    await run(harness);
  } finally {
    await unmount();
    Date.now = realDateNow;

    if (prevWindow !== undefined) {
      g.window = prevWindow;
    } else {
      delete g.window;
    }
    if (prevDocument !== undefined) {
      g.document = prevDocument;
    } else {
      delete g.document;
    }
    if (prevActEnv !== undefined) {
      g.IS_REACT_ACT_ENVIRONMENT = prevActEnv;
    } else {
      delete g.IS_REACT_ACT_ENVIRONMENT;
    }
    if (prevUtterance !== undefined) {
      g.SpeechSynthesisUtterance = prevUtterance;
    } else {
      delete g.SpeechSynthesisUtterance;
    }
    if (prevLocalDesc) {
      Object.defineProperty(g, "localStorage", prevLocalDesc);
    } else {
      delete g.localStorage;
    }
    if (prevSessionDesc) {
      Object.defineProperty(g, "sessionStorage", prevSessionDesc);
    } else {
      delete g.sessionStorage;
    }
    if (prevIndexedDbDesc) {
      Object.defineProperty(g, "indexedDB", prevIndexedDbDesc);
    } else {
      delete g.indexedDB;
    }
  }
}

test("nextFocusIndex wraps circularly and normalizes bounds across 3-button and 2-button Neural Band action strips", () => {
  for (const forwardKey of ["ArrowRight", "ArrowDown"] as const) {
    assert.equal(nextFocusIndex(1, 3, forwardKey), 2);
    assert.equal(nextFocusIndex(2, 3, forwardKey), 0);
    assert.equal(nextFocusIndex(0, 3, forwardKey), 1);

    assert.equal(nextFocusIndex(0, 2, forwardKey), 1);
    assert.equal(nextFocusIndex(1, 2, forwardKey), 0);
  }

  for (const backwardKey of ["ArrowLeft", "ArrowUp"] as const) {
    assert.equal(nextFocusIndex(1, 3, backwardKey), 0);
    assert.equal(nextFocusIndex(0, 3, backwardKey), 2);
    assert.equal(nextFocusIndex(2, 3, backwardKey), 1);

    assert.equal(nextFocusIndex(0, 2, backwardKey), 1);
    assert.equal(nextFocusIndex(1, 2, backwardKey), 0);
  }

  for (const singleKey of ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Enter"] as const) {
    assert.equal(nextFocusIndex(0, 1, singleKey), 0);
    assert.equal(nextFocusIndex(4, 1, singleKey), 0);
    assert.equal(nextFocusIndex(2, 0, singleKey), 0);
    assert.equal(nextFocusIndex(1, -3, singleKey), 0);
    assert.equal(nextFocusIndex(1, Number.NaN, singleKey), 0);
  }

  assert.equal(nextFocusIndex(-1, 3, "Enter"), 2);
  assert.equal(nextFocusIndex(-4, 3, " "), 2);
  assert.equal(nextFocusIndex(7, 3, "Escape"), 1);
  assert.equal(nextFocusIndex(5, 3, "Backspace"), 2);
  assert.equal(nextFocusIndex(1.9, 3, "ArrowRight"), 2);
  assert.equal(nextFocusIndex(Number.POSITIVE_INFINITY, 3, "ArrowRight"), 1);
  assert.equal(nextFocusIndex(Number.NaN, 2, "ArrowLeft"), 1);
});

test("HudApp SSR action strip enforces safe Repeat default focus and gates Log Dose across match, takenToday=true, and non-match verdicts", () => {
  const defaults = initialHudState();
  assert.equal(defaults.focusIndex, 1);
  assert.equal(defaults.dismissed, false);
  assert.equal(defaults.speechEnabled, false);

  const eligibleMatch = makeVerdict({
    level: "match",
    matchedMedId: "aml",
    takenToday: false
  });

  for (const [idx, expectedAction] of [
    [0, "log_dose"],
    [1, "repeat"],
    [2, "dismiss"]
  ] as const) {
    const html = renderHudSsr({
      initialState: {
        connected: true,
        live: "open",
        verdict: eligibleMatch,
        dismissed: false,
        focusIndex: idx
      }
    });

    for (const action of ["log_dose", "repeat", "dismiss"] as const) {
      const tag = extractActionBtnTag(html, action);
      assert.doesNotMatch(tag, /\sdisabled(?:=""|=|\s|>)/);
      assert.ok(tag.includes('aria-disabled="false"'));
      if (action === expectedAction) {
        assert.ok(tag.includes('data-focused="true"'));
        assert.ok(tag.includes('aria-current="true"'));
      } else {
        assert.ok(tag.includes('data-focused="false"'));
        assert.equal(tag.includes("aria-current="), false);
      }
    }
  }

  const nonLoggableVerdicts: ReadonlyArray<[string, Verdict]> = [
    [
      "match:takenToday=true",
      makeVerdict({ level: "match", matchedMedId: "aml", takenToday: true })
    ],
    [
      "warning:double_dose",
      makeVerdict({
        level: "warning",
        headline: "Already taken Amlodipine today",
        matchedMedId: "aml",
        takenToday: true
      })
    ],
    [
      "warning:nsaid_avoid",
      makeVerdict({
        level: "warning",
        headline: "Stop: NSAID avoid rule hit",
        matchedMedId: undefined,
        takenToday: undefined
      })
    ],
    [
      "unsure:unreadable_strength",
      makeVerdict({
        level: "unsure",
        headline: "Strength unclear, hold steady",
        matchedMedId: undefined,
        takenToday: undefined
      })
    ],
    [
      "info:safe_food",
      makeVerdict({
        level: "info",
        headline: "Oat drink: no listed allergens",
        matchedMedId: undefined,
        takenToday: undefined,
        read: makeLabelRead({ kind: "food", strength: { value: null, confidence: 0 } })
      })
    ]
  ];

  for (const [label, verdict] of nonLoggableVerdicts) {
    const html = renderHudSsr({
      initialState: {
        connected: true,
        live: "open",
        verdict
      }
    });

    const logBtn = extractActionBtnTag(html, "log_dose");
    assert.match(logBtn, /\sdisabled(?:=""|\s|>)/, `${label} must disable Log Dose`);
    assert.ok(logBtn.includes('aria-disabled="true"'));
    assert.ok(logBtn.includes('data-focused="false"'));

    const repeatBtn = extractActionBtnTag(html, "repeat");
    assert.doesNotMatch(repeatBtn, /\sdisabled(?:=""|=|\s|>)/, `${label} must keep Repeat enabled`);
    assert.ok(repeatBtn.includes('aria-disabled="false"'));
    assert.ok(repeatBtn.includes('data-focused="true"'));
    assert.ok(repeatBtn.includes('aria-current="true"'));

    const dismissBtn = extractActionBtnTag(html, "dismiss");
    assert.doesNotMatch(dismissBtn, /\sdisabled(?:=""|=|\s|>)/, `${label} must keep Dismiss enabled`);
    assert.ok(dismissBtn.includes('aria-disabled="false"'));
  }

  let reduced = initialHudState({ speechEnabled: true });
  reduced = reduceHudServerMsg(reduced, {
    type: "coach",
    cue: "closer",
    text: "Move package closer"
  });
  assert.equal(reduced.focusIndex, 1);
  reduced = reduceHudServerMsg(reduced, { type: "verdict", verdict: eligibleMatch });
  assert.equal(reduced.coach, null);
  assert.equal(reduced.dismissed, false);
  assert.equal(reduced.focusIndex, 1);
});

test("Mounted HudApp cycles spatial focus on ArrowRight, ArrowDown, ArrowLeft, and ArrowUp and blurs DOM focus on disabled Log Dose", async () => {
  await withMountedHud(
    {
      initialHtmlBg: "rgb(12, 16, 24)",
      initialBodyBg: "rgb(12, 16, 24)"
    },
    async (hud) => {
      assert.equal(hud.doc.documentElement.style.backgroundColor, "#000000");
      assert.equal(hud.doc.body.style.backgroundColor, "#000000");
      assert.equal(hud.doc.body.style.margin, "0");
      assert.equal(hud.doc.body.style.overflow, "hidden");
      assert.equal(hud.sockets.length, 1);

      await act(async () => {
        hud.sockets[0].open();
      });

      await hud.sendServerMsg({
        type: "verdict",
        verdict: makeVerdict({ level: "match", matchedMedId: "aml", takenToday: false })
      });

      const logBtn = hud.getActionButton("log_dose");
      const repeatBtn = hud.getActionButton("repeat");
      const dismissBtn = hud.getActionButton("dismiss");

      assert.equal(logBtn.disabled, false);
      assert.equal(repeatBtn.disabled, false);
      assert.equal(dismissBtn.disabled, false);
      assert.equal(hud.focusedActionName(), "repeat");

      const r1 = await hud.pressKey("ArrowRight");
      assert.equal(r1.defaultPrevented, true);
      assert.equal(hud.focusedActionName(), "dismiss");
      assert.equal(hud.doc.activeElement, dismissBtn);
      assert.deepEqual(dismissBtn.lastFocusOptions, { preventScroll: true });

      const r2 = await hud.pressKey("ArrowRight");
      assert.equal(r2.defaultPrevented, true);
      assert.equal(hud.focusedActionName(), "log_dose");
      assert.equal(hud.doc.activeElement, logBtn);

      const r3 = await hud.pressKey("ArrowRight");
      assert.equal(r3.defaultPrevented, true);
      assert.equal(hud.focusedActionName(), "repeat");
      assert.equal(hud.doc.activeElement, repeatBtn);

      await hud.pressKey("ArrowDown");
      assert.equal(hud.focusedActionName(), "dismiss");
      await hud.pressKey("ArrowDown");
      assert.equal(hud.focusedActionName(), "log_dose");
      await hud.pressKey("ArrowDown");
      assert.equal(hud.focusedActionName(), "repeat");

      const l1 = await hud.pressKey("ArrowLeft");
      assert.equal(l1.defaultPrevented, true);
      assert.equal(hud.focusedActionName(), "log_dose");
      assert.equal(hud.doc.activeElement, logBtn);

      await hud.pressKey("ArrowLeft");
      assert.equal(hud.focusedActionName(), "dismiss");
      assert.equal(hud.doc.activeElement, dismissBtn);

      await hud.pressKey("ArrowLeft");
      assert.equal(hud.focusedActionName(), "repeat");
      assert.equal(hud.doc.activeElement, repeatBtn);

      await hud.pressKey("ArrowUp");
      assert.equal(hud.focusedActionName(), "log_dose");
      await hud.pressKey("ArrowUp");
      assert.equal(hud.focusedActionName(), "dismiss");
      await hud.pressKey("ArrowUp");
      assert.equal(hud.focusedActionName(), "repeat");

      await hud.sendServerMsg({
        type: "verdict",
        verdict: makeVerdict({ level: "match", matchedMedId: "aml", takenToday: true })
      });

      assert.equal(logBtn.disabled, true);
      assert.equal(logBtn.getAttribute("aria-disabled"), "true");
      assert.equal(repeatBtn.disabled, false);
      assert.equal(dismissBtn.disabled, false);

      const logFocusBefore = logBtn.focusCalls;
      await hud.pressKey("ArrowLeft");
      assert.equal(hud.focusedActionName(), "log_dose");
      assert.equal(logBtn.focusCalls, logFocusBefore, "Disabled Log Dose must not receive DOM focus");
      assert.equal(hud.doc.activeElement, hud.doc.body, "Active element must blur when landing on disabled slot");

      await hud.pressKey("ArrowLeft");
      assert.equal(hud.focusedActionName(), "dismiss");
      assert.equal(hud.doc.activeElement, dismissBtn);

      await hud.pressKey("ArrowRight");
      assert.equal(hud.focusedActionName(), "log_dose");
      assert.equal(hud.doc.activeElement, hud.doc.body);

      await hud.pressKey("ArrowRight");
      assert.equal(hud.focusedActionName(), "repeat");
      assert.equal(hud.doc.activeElement, repeatBtn);

      for (const nonMatchLevel of ["warning", "unsure", "info"] as const) {
        await hud.sendServerMsg({
          type: "verdict",
          verdict: makeVerdict({
            level: nonMatchLevel,
            matchedMedId: undefined,
            takenToday: undefined
          })
        });
        assert.equal(logBtn.disabled, true);
        assert.equal(repeatBtn.disabled, false);
        assert.equal(dismissBtn.disabled, false);
      }

      await hud.focusAction("dismiss");
      assert.equal(hud.focusedActionName(), "dismiss");
      assert.equal(dismissBtn.getAttribute("aria-current"), "true");

      await hud.focusAction("repeat");
      assert.equal(hud.focusedActionName(), "repeat");
      assert.equal(repeatBtn.getAttribute("aria-current"), "true");

      await hud.unmount();
      assert.equal(hud.doc.documentElement.style.backgroundColor, "rgb(12, 16, 24)");
      assert.equal(hud.doc.body.style.backgroundColor, "rgb(12, 16, 24)");
      assert.equal(hud.windowListenerCount("keydown"), 0);
      assert.equal(hud.windowListenerCount("popstate"), 0);
    }
  );
});

test("Mounted HudApp dispatches log_dose and repeat over /hud-ws and dismisses locally on Enter and Space with 150ms pinch debounce", async () => {
  await withMountedHud(
    {
      props: { speak: true }
    },
    async (hud) => {
      const ws = hud.sockets[0];
      await act(async () => {
        ws.open();
      });

      await hud.sendServerMsg({
        type: "verdict",
        verdict: makeVerdict({
          level: "match",
          headline: "Yes, Amlodipine 5 mg",
          speech: "Yes, this is Amlodipine 5 mg.",
          matchedMedId: "aml",
          takenToday: false
        })
      });

      assert.equal(hud.spokenUtterances.length, 1);
      assert.equal(hud.spokenUtterances[0].text, "Yes, this is Amlodipine 5 mg.");
      assert.equal(hud.focusedActionName(), "repeat");

      const enterRepeat = await hud.pressKey("Enter");
      assert.equal(enterRepeat.defaultPrevented, true);
      assert.deepEqual(ws.sent, [{ type: "event", name: "repeat" }]);
      assert.equal(hud.spokenUtterances.length, 2);

      hud.advanceClockMs(40);
      await hud.clickAction("repeat");
      assert.equal(ws.sent.length, 1, "Synthesized click within 150ms after Enter must be debounced");

      hud.advanceClockMs(160);
      await hud.pressKey("ArrowLeft");
      assert.equal(hud.focusedActionName(), "log_dose");

      const enterLog = await hud.pressKey("Enter");
      assert.equal(enterLog.defaultPrevented, true);
      assert.deepEqual(ws.sent, [
        { type: "event", name: "repeat" },
        { type: "event", name: "log_dose" }
      ]);

      hud.advanceClockMs(30);
      await hud.clickAction("log_dose");
      assert.equal(ws.sent.length, 2, "Duplicate log_dose pinch within 150ms must be suppressed");

      await hud.sendServerMsg({
        type: "verdict",
        verdict: makeVerdict({
          level: "match",
          headline: "Yes, Amlodipine 5 mg",
          speech: "Logged your evening Amlodipine dose.",
          matchedMedId: "aml",
          takenToday: true
        })
      });

      hud.advanceClockMs(200);
      await hud.pressKey("Enter");
      await hud.pressKey(" ");
      assert.equal(ws.sent.length, 2, "Disabled Log Dose must not dispatch on Enter or Space");

      await hud.pressKey("ArrowRight");
      assert.equal(hud.focusedActionName(), "repeat");
      const spaceRepeat = await hud.pressKey(" ");
      assert.equal(spaceRepeat.defaultPrevented, true);
      assert.deepEqual(ws.sent.at(-1), { type: "event", name: "repeat" });
      assert.equal(ws.sent.length, 3);

      hud.advanceClockMs(200);
      await hud.sendServerMsg({
        type: "verdict",
        verdict: makeVerdict({
          level: "match",
          matchedMedId: "aml",
          takenToday: false
        })
      });
      await hud.pressKey("ArrowLeft");
      assert.equal(hud.focusedActionName(), "log_dose");
      const spaceLog = await hud.pressKey(" ");
      assert.equal(spaceLog.defaultPrevented, true);
      assert.deepEqual(ws.sent.at(-1), { type: "event", name: "log_dose" });
      assert.equal(ws.sent.length, 4);

      hud.advanceClockMs(200);
      await hud.pressKey("ArrowLeft");
      assert.equal(hud.focusedActionName(), "dismiss");
      assert.notEqual(hud.container.findByAttr("data-verdict-level", "match"), null);

      const cancelsBeforeDismiss = hud.speechCancelCount();
      const spaceDismiss = await hud.pressKey(" ");
      assert.equal(spaceDismiss.defaultPrevented, true);
      assert.equal(hud.container.findByAttr("data-verdict-level", "match"), null);
      assert.notEqual(hud.container.findByAttr("data-hud-standby", "true"), null);
      assert.equal(hud.getActionButton("log_dose").disabled, true);
      assert.ok(hud.speechCancelCount() > cancelsBeforeDismiss);
      assert.deepEqual(ws.sent.at(-1), { type: "event", name: "dismiss" });

      hud.advanceClockMs(200);
      await hud.sendServerMsg({
        type: "verdict",
        verdict: makeVerdict({ level: "warning", matchedMedId: undefined })
      });
      assert.notEqual(hud.container.findByAttr("data-verdict-level", "warning"), null);
      const enterDismiss = await hud.pressKey("Enter");
      assert.equal(enterDismiss.defaultPrevented, true);
      assert.equal(hud.container.findByAttr("data-verdict-level", "warning"), null);
      assert.notEqual(hud.container.findByAttr("data-hud-standby", "true"), null);
      assert.deepEqual(ws.sent.at(-1), { type: "event", name: "dismiss" });
    }
  );
});

test("Swipe-Back popstate and Escape or Backspace back navigation dismiss active verdicts to #000000 standby within <= 2 history entry cap", async () => {
  await withMountedHud(
    {
      props: { speak: true }
    },
    async (hud) => {
      const ws = hud.sockets[0];
      await act(async () => {
        ws.open();
      });

      assert.equal(hud.history.length, 1);
      assert.deepEqual(hud.history.state, { hudView: "standby" });
      assert.equal(hud.history.pushCount, 0);

      const cues: readonly CoachCue[] = [
        "rotate_left",
        "rotate_right",
        "closer",
        "farther",
        "more_light",
        "hold_still",
        "other_side",
        "ok"
      ];
      await hud.sendServerMsg({ type: "status", live: "open" });
      await hud.sendServerMsg({ type: "device", device: makeDevice() });
      for (const cue of cues) {
        await hud.sendServerMsg({ type: "coach", cue, text: `Cue ${cue}` });
        assert.equal(hud.history.length, 1, `Coach cue ${cue} must not push history`);
      }
      assert.equal(hud.history.pushCount, 0);

      const levels: readonly VerdictLevel[] = ["match", "warning", "unsure", "info"];
      for (let i = 0; i < 12; i += 1) {
        const level = levels[i % levels.length];
        await hud.sendServerMsg({
          type: "verdict",
          verdict: makeVerdict({
            level,
            headline: `Verdict card number ${i + 1}`,
            matchedMedId: level === "match" ? "aml" : undefined
          })
        });
        assert.equal(hud.history.length, 2, `Verdict #${i + 1} must hold history at 2`);
        assert.ok(hud.history.maxLength <= 2, "History depth must never exceed 2");
        assert.deepEqual(hud.history.state, { hudView: "verdict" });
      }
      assert.equal(hud.history.pushCount, 1, "12 consecutive verdicts must pushState only once");

      const sentBeforeRawKeys = ws.sent.length;
      await hud.pressKey("Escape");
      await hud.pressKey("Backspace");
      assert.equal(hud.focusedActionName(), "repeat");
      assert.equal(ws.sent.length, sentBeforeRawKeys);
      assert.equal(hud.history.length, 2);

      const cancelsBeforeBack = hud.speechCancelCount();
      await hud.swipeBack();

      assert.equal(hud.history.length, 1);
      assert.deepEqual(hud.history.state, { hudView: "standby" });
      assert.equal(hud.container.findByAttr("data-hud-standby", "true")?.style.backgroundColor, "#000000");
      assert.equal(hud.container.findByAttr("data-verdict-level", "info"), null);
      assert.ok(hud.speechCancelCount() > cancelsBeforeBack);
      assert.deepEqual(ws.sent.at(-1), { type: "event", name: "dismiss" });
      assert.equal(ws.closed, false, "popstate dismissal must keep /hud-ws socket open");

      await hud.sendServerMsg({
        type: "verdict",
        verdict: makeVerdict({ level: "match", headline: "Post-back match" })
      });
      assert.equal(hud.history.length, 2);
      assert.equal(hud.history.maxLength, 2);
      assert.notEqual(hud.container.findByAttr("data-verdict-level", "match"), null);

      hud.advanceClockMs(250);
      await hud.pressKey("ArrowRight");
      assert.equal(hud.focusedActionName(), "dismiss");
      await hud.pressKey("Enter");
      assert.notEqual(hud.container.findByAttr("data-hud-standby", "true"), null);
      assert.equal(hud.history.length, 2);

      await hud.sendServerMsg({
        type: "verdict",
        verdict: makeVerdict({ level: "warning", headline: "Post-button-dismiss warning" })
      });
      assert.equal(hud.history.length, 2);
      assert.equal(hud.history.maxLength, 2, "Button dismiss + new verdict must stay <= 2");
    }
  );

  await withMountedHud(
    {
      mapEscapeAndBackspaceToHistoryBack: true
    },
    async (hud) => {
      const ws = hud.sockets[0];
      await act(async () => {
        ws.open();
      });

      await hud.sendServerMsg({
        type: "verdict",
        verdict: makeVerdict({ level: "match", headline: "Escape back test" })
      });
      assert.equal(hud.history.length, 2);
      assert.notEqual(hud.container.findByAttr("data-verdict-level", "match"), null);

      await hud.pressKey("Escape");
      assert.equal(hud.history.length, 1);
      assert.notEqual(hud.container.findByAttr("data-hud-standby", "true"), null);
      assert.equal(hud.container.findByAttr("data-hud-standby", "true")?.style.backgroundColor, "#000000");
      assert.deepEqual(ws.sent.at(-1), { type: "event", name: "dismiss" });

      await hud.sendServerMsg({
        type: "verdict",
        verdict: makeVerdict({ level: "warning", headline: "Backspace back test" })
      });
      assert.equal(hud.history.length, 2);
      assert.notEqual(hud.container.findByAttr("data-verdict-level", "warning"), null);

      await hud.pressKey("Backspace");
      assert.equal(hud.history.length, 1);
      assert.notEqual(hud.container.findByAttr("data-hud-standby", "true"), null);
      assert.equal(hud.history.maxLength, 2);
      assert.deepEqual(ws.sent.at(-1), { type: "event", name: "dismiss" });
    }
  );
});

test("Session-less /hud vs ?session= WebSocket URL construction, binary wire frames, reconnect backoff, and zero localStorage or sessionStorage touches", async () => {
  assert.equal(
    buildHudWsUrl(undefined, { protocol: "https:", host: "glasses.holdup.fi", search: "" }),
    `wss:${DOUBLE_SLASH}glasses.holdup.fi/hud-ws`
  );
  assert.equal(
    buildHudWsUrl(undefined, { protocol: "http:", host: "localhost:5173", search: "" }),
    `ws:${DOUBLE_SLASH}localhost:5173/hud-ws`
  );
  assert.equal(
    buildHudWsUrl(undefined, { protocol: "http:", host: "   ", search: "" }),
    `ws:${DOUBLE_SLASH}localhost:8787/hud-ws`
  );
  assert.equal(
    buildHudWsUrl(undefined, {
      protocol: "https:",
      host: "glasses.holdup.fi",
      search: "?session=hup-7f3a#verdict"
    }),
    `wss:${DOUBLE_SLASH}glasses.holdup.fi/hud-ws?session=hup-7f3a`
  );
  assert.equal(
    buildHudWsUrl("bench_room-09", {
      protocol: "https:",
      host: "glasses.holdup.fi",
      search: "?session=ignored1"
    }),
    `wss:${DOUBLE_SLASH}glasses.holdup.fi/hud-ws?session=bench_room-09`
  );
  assert.equal(
    buildHudWsUrl(null, {
      protocol: "https:",
      host: "glasses.holdup.fi",
      search: "?session=hup-7f3a"
    }),
    `wss:${DOUBLE_SLASH}glasses.holdup.fi/hud-ws`
  );

  for (const invalidSession of [
    "",
    "abc",
    "x".repeat(65),
    "../admin",
    "bad session",
    "bad/slash",
    "bad?query=1"
  ]) {
    assert.equal(validateHudSessionParam(invalidSession), null);
    assert.equal(
      resolveHudSession(undefined, `?session=${encodeURIComponent(invalidSession)}`),
      null
    );
    assert.equal(
      buildHudWsUrl(undefined, {
        protocol: "https:",
        host: "glasses.holdup.fi",
        search: `?session=${encodeURIComponent(invalidSession)}`
      }),
      `wss:${DOUBLE_SLASH}glasses.holdup.fi/hud-ws`
    );
  }

  assert.equal(resolveHudSpeak(undefined, "?speak=1#top"), true);
  assert.equal(resolveHudSpeak(undefined, "?speak=TRUE"), true);
  assert.equal(resolveHudSpeak(undefined, "?speak=false"), false);
  assert.equal(computeHudReconnectDelayMs(-2), 500);
  assert.equal(computeHudReconnectDelayMs(0), 500);
  assert.equal(computeHudReconnectDelayMs(1), 1000);
  assert.equal(computeHudReconnectDelayMs(2), 2000);
  assert.equal(computeHudReconnectDelayMs(3), 4000);
  assert.equal(computeHudReconnectDelayMs(4), 5000);
  assert.equal(computeHudReconnectDelayMs(99), 5000);

  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const scheduledTimers = new Map<number, { fn: () => void; delay: number }>();
  let nextTimerId = 1;

  globalThis.setTimeout = ((fn: (...args: unknown[]) => void, delay?: number) => {
    const id = nextTimerId;
    nextTimerId += 1;
    scheduledTimers.set(id, { fn: () => fn(), delay: Number(delay ?? 0) });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
    scheduledTimers.delete(Number(id));
  }) as typeof clearTimeout;

  try {
    await withMountedHud(
      {
        protocol: "https:",
        host: "glasses.holdup.fi",
        search: ""
      },
      async (hud) => {
        assert.equal(hud.sockets.length, 1);
        assert.equal(hud.sockets[0].url, `wss:${DOUBLE_SLASH}glasses.holdup.fi/hud-ws`);
        assert.ok(hud.container.textContent.includes("AUTO SESSION"));

        await act(async () => {
          hud.sockets[0].open();
        });

        const encoder = new TextEncoder();
        const coachBytes = encoder.encode(
          JSON.stringify({ type: "coach", cue: "hold_still", text: "Hold steady" })
        );
        await act(async () => {
          hud.sockets[0].receiveRaw(coachBytes.buffer);
        });
        assert.notEqual(hud.container.findByAttr("data-coach-cue", "hold_still"), null);

        const verdictBytes = encoder.encode(
          JSON.stringify({ type: "verdict", verdict: makeVerdict({ headline: "Binary frame match" }) })
        );
        await act(async () => {
          hud.sockets[0].receiveRaw(verdictBytes);
        });
        assert.notEqual(hud.container.findByAttr("data-verdict-level", "match"), null);

        await act(async () => {
          hud.sockets[0].drop();
        });
        assert.equal(scheduledTimers.size, 1);
        const firstReconnect = [...scheduledTimers.values()][0];
        assert.equal(firstReconnect.delay, 500);

        scheduledTimers.clear();
        await act(async () => {
          firstReconnect.fn();
        });
        assert.equal(hud.sockets.length, 2);
        assert.equal(hud.sockets[1].url, `wss:${DOUBLE_SLASH}glasses.holdup.fi/hud-ws`);

        await act(async () => {
          hud.sockets[1].drop();
        });
        const secondReconnect = [...scheduledTimers.values()][0];
        assert.equal(secondReconnect.delay, 1000);

        assert.deepEqual(hud.storageTouches, []);
      }
    );
    assert.equal(scheduledTimers.size, 0, "Unmount must clear pending reconnect timer");
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }

  await withMountedHud(
    {
      protocol: "https:",
      host: "glasses.holdup.fi",
      search: "?session=hup-9a4f&speak=1"
    },
    async (hud) => {
      assert.equal(hud.sockets.length, 1);
      assert.equal(
        hud.sockets[0].url,
        `wss:${DOUBLE_SLASH}glasses.holdup.fi/hud-ws?session=hup-9a4f`
      );
      assert.ok(hud.container.textContent.includes("SESSION hup-9a4f | SPEAK"));

      await act(async () => {
        hud.sockets[0].open();
      });
      await hud.sendServerMsg({
        type: "verdict",
        verdict: makeVerdict({ matchedMedId: "aml", takenToday: false })
      });
      await hud.pressKey("ArrowLeft");
      await hud.pressKey("Enter");
      await hud.swipeBack();

      assert.deepEqual(hud.sockets[0].sent, [
        { type: "event", name: "log_dose" },
        { type: "event", name: "dismiss" }
      ]);
      assert.deepEqual(hud.storageTouches, []);
    }
  );
});

test("Zero comments and zero em or en dashes exist across HudApp.tsx, hud.css, neuralBandNavigation.test.ts, and rendered HUD states", () => {
  const hudTsxSource = readFileSync(new URL("../src/hud/HudApp.tsx", import.meta.url), "utf8");
  const hudCssSource = readFileSync(new URL("../src/hud/hud.css", import.meta.url), "utf8");
  const selfSource = readFileSync(new URL("./neuralBandNavigation.test.ts", import.meta.url), "utf8");

  assert.equal(hudTsxSource.includes("localStorage"), false);
  assert.equal(hudTsxSource.includes("sessionStorage"), false);
  assert.equal(hudTsxSource.includes("indexedDB"), false);
  assert.equal(hudTsxSource.includes("document.cookie"), false);

  for (const [label, src] of [
    ["HudApp.tsx", hudTsxSource],
    ["hud.css", hudCssSource],
    ["neuralBandNavigation.test.ts", selfSource]
  ] as const) {
    assert.equal(src.includes(LINE_COMMENT), false, `${label} must contain zero line comments`);
    assert.equal(src.includes(BLOCK_COMMENT_OPEN), false, `${label} must contain zero block comments`);
    assert.equal(src.includes(BLOCK_COMMENT_CLOSE), false, `${label} must contain zero block comment closers`);
    assert.equal(src.includes(HTML_COMMENT_OPEN), false, `${label} must contain zero HTML comments`);
    assert.equal(src.includes(EM_DASH), false, `${label} must contain zero em dashes`);
    assert.equal(src.includes(EN_DASH), false, `${label} must contain zero en dashes`);
  }

  assert.equal(sanitizeHudText(`Dose ${EM_DASH} 5 mg ${EN_DASH} evening`), "Dose : 5 mg - evening");
  assert.equal(
    clampHudHeadline(`One ${EM_DASH} two three four five six seven eight nine;`),
    "One : two three four five six seven"
  );

  for (const level of ["match", "warning", "unsure", "info"] as const) {
    const html = renderHudSsr({
      sessionParam: "hup-7f3a",
      speak: true,
      initialState: {
        connected: true,
        live: "open",
        device: makeDevice(),
        verdict: makeVerdict({
          level,
          headline: `Check ${EM_DASH} ${level} ${EN_DASH} result`,
          speech: `Verified ${EM_DASH} ${level} ${EN_DASH} detail.`
        })
      }
    });
    assert.equal(html.includes(HTML_COMMENT_OPEN), false);
    assert.equal(html.includes(EM_DASH), false);
    assert.equal(html.includes(EN_DASH), false);
  }
});
