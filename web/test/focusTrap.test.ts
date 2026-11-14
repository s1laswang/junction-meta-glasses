import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
  computeWrappedFocusIndex,
  getTabbableElements,
  isFocusableElement,
  trapModalTabKey,
  type ModalTabEventLike
} from "../src/a11y/focusTrap.ts";
import { ShortcutsModal } from "../src/components/ShortcutsModal.tsx";

(globalThis as Record<string, unknown>).React = React;

type TestFn = (name: string, fn: () => void | Promise<void>) => Promise<void>;

interface StrictAssert {
  ok(value: unknown, message?: string): asserts value;
  equal<T>(actual: T, expected: T, message?: string): void;
  notEqual<T>(actual: T, expected: T, message?: string): void;
  deepEqual<T>(actual: T, expected: T, message?: string): void;
}

interface FsModule {
  readFileSync(path: URL | string, encoding: "utf8"): string;
}

const nodeTestSpec: string = "node:test";
const nodeAssertSpec: string = "node:assert" + String.fromCharCode(47) + "strict";
const nodeFsSpec: string = "node:fs";

const { test } = (await import(nodeTestSpec)) as { test: TestFn };
const assert: StrictAssert = ((await import(nodeAssertSpec)) as { default: StrictAssert }).default;
const { readFileSync } = (await import(nodeFsSpec)) as FsModule;

const SLASH = String.fromCharCode(47);
const DOUBLE_SLASH = SLASH + SLASH;
const LINE_COMMENT = DOUBLE_SLASH;
const BLOCK_COMMENT_OPEN = SLASH + "*";
const BLOCK_COMMENT_CLOSE = "*" + SLASH;
const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);
const XHTML_NS = `http:${DOUBLE_SLASH}www.w3.org${SLASH}1999${SLASH}xhtml`;

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
  tabIndex: number | undefined = undefined;
  inert = false;
  controls = false;
  isContentEditable = false;
  textContentValue = "";
  focusCalls = 0;
  private disabledFlag = false;
  private hiddenFlag = false;

  constructor(nodeType: number, name: string, ownerDoc: MiniDomDocument) {
    this.nodeType = nodeType;
    this.nodeName = name.toUpperCase();
    this.tagName = nodeType === 1 ? name.toUpperCase() : "";
    this.ownerDocument = ownerDoc;
  }

  get parentElement(): MiniDomNode | null {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
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

  get disabled(): boolean {
    return this.disabledFlag;
  }

  set disabled(val: boolean) {
    this.disabledFlag = Boolean(val);
    if (this.disabledFlag) {
      this.attributes.set("disabled", "");
    } else {
      this.attributes.delete("disabled");
    }
  }

  get hidden(): boolean {
    return this.hiddenFlag;
  }

  set hidden(val: boolean) {
    this.hiddenFlag = Boolean(val);
    if (this.hiddenFlag) {
      this.attributes.set("hidden", "");
    } else {
      this.attributes.delete("hidden");
    }
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
    for (const child of this.childNodes) {
      child.parentNode = null;
    }
    this.childNodes = [];
    if (text.length > 0) {
      const textNode = new MiniDomNode(3, "#text", this.ownerDocument);
      textNode.textContentValue = text;
      textNode.parentNode = this;
      this.childNodes.push(textNode);
    }
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
    const key = name.toLowerCase();
    const str = String(value);
    this.attributes.set(key, str);
    if (key === "disabled") {
      this.disabledFlag = true;
    } else if (key === "hidden") {
      this.hiddenFlag = true;
    } else if (key === "tabindex") {
      const parsed = Number.parseInt(str, 10);
      this.tabIndex = Number.isNaN(parsed) ? undefined : parsed;
    }
  }

  setAttributeNS(_ns: string | null, name: string, value: string): void {
    this.setAttribute(name, value);
  }

  removeAttribute(name: string): void {
    const key = name.toLowerCase();
    this.attributes.delete(key);
    if (key === "disabled") {
      this.disabledFlag = false;
    } else if (key === "hidden") {
      this.hiddenFlag = false;
    } else if (key === "tabindex") {
      this.tabIndex = undefined;
    }
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name.toLowerCase()) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name.toLowerCase());
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

  focus(): void {
    if (this.disabledFlag) {
      return;
    }
    this.focusCalls += 1;
    this.ownerDocument.activeElement = this;
  }

  blur(): void {
    if (this.ownerDocument.activeElement === this) {
      this.ownerDocument.activeElement = this.ownerDocument.body;
    }
  }

  dispatchKeyDown(init: {
    key: string;
    shiftKey?: boolean;
    ctrlKey?: boolean;
    altKey?: boolean;
    metaKey?: boolean;
  }): { defaultPrevented: boolean; propagationStopped: boolean } {
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
      type: "keydown",
      key: init.key,
      code: init.key,
      shiftKey: Boolean(init.shiftKey),
      ctrlKey: Boolean(init.ctrlKey),
      altKey: Boolean(init.altKey),
      metaKey: Boolean(init.metaKey),
      repeat: false,
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
      }
    };

    for (let i = path.length - 1; i >= 0; i -= 1) {
      eventObj.currentTarget = path[i];
      for (const listener of [...(path[i].listeners.get("keydown") ?? [])]) {
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
      for (const listener of [...(path[i].listeners.get("keydown") ?? [])]) {
        if (!listener.capture) {
          listener.fn(eventObj);
        }
      }
    }

    return {
      defaultPrevented: eventObj.defaultPrevented,
      propagationStopped: eventObj.propagationStopped
    };
  }

  findByAttr(attr: string, expected: string): MiniDomNode | null {
    if (this.getAttribute(attr) === expected) {
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

function makeTabEvent(
  overrides: Partial<ModalTabEventLike> = {}
): ModalTabEventLike & { preventedCount: number } {
  const event = {
    key: "Tab",
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    defaultPrevented: false,
    preventedCount: 0,
    preventDefault() {
      event.preventedCount += 1;
      event.defaultPrevented = true;
    },
    ...overrides
  };
  return event;
}

test("computeWrappedFocusIndex wraps forward Tab, backward Shift+Tab, dialog-root -1 index, and handles empty counts", () => {
  assert.equal(computeWrappedFocusIndex(0, 0, false), -1);
  assert.equal(computeWrappedFocusIndex(0, -1, true), -1);
  assert.equal(computeWrappedFocusIndex(-2, 0, false), -1);
  assert.equal(computeWrappedFocusIndex(Number.NaN, 0, false), -1);
  assert.equal(computeWrappedFocusIndex(Number.POSITIVE_INFINITY, 0, false), -1);

  assert.equal(computeWrappedFocusIndex(1, 0, false), 0);
  assert.equal(computeWrappedFocusIndex(1, 0, true), 0);
  assert.equal(computeWrappedFocusIndex(1, -1, false), 0);
  assert.equal(computeWrappedFocusIndex(1, -1, true), 0);

  assert.equal(computeWrappedFocusIndex(3, 0, false), 1);
  assert.equal(computeWrappedFocusIndex(3, 1, false), 2);
  assert.equal(computeWrappedFocusIndex(3, 2, false), 0);

  assert.equal(computeWrappedFocusIndex(3, 2, true), 1);
  assert.equal(computeWrappedFocusIndex(3, 1, true), 0);
  assert.equal(computeWrappedFocusIndex(3, 0, true), 2);

  assert.equal(computeWrappedFocusIndex(3, -1, false), 0);
  assert.equal(computeWrappedFocusIndex(3, -1, true), 2);
  assert.equal(computeWrappedFocusIndex(3, 9, false), 0);
  assert.equal(computeWrappedFocusIndex(3, 9, true), 2);
  assert.equal(computeWrappedFocusIndex(3, Number.NaN, true), 2);
});

test("isFocusableElement identifies interactive controls and excludes disabled, aria-hidden, hidden, inert, invisible, and tabIndex=-1 elements", () => {
  const doc = new MiniDomDocument();

  assert.equal(isFocusableElement(null), false);
  assert.equal(isFocusableElement(undefined), false);
  assert.equal(isFocusableElement(doc.createTextNode("label")), false);
  assert.equal(isFocusableElement(doc.createElement("div")), false);
  assert.equal(isFocusableElement(doc.createElement("span")), false);
  assert.equal(isFocusableElement(doc.createElement("kbd")), false);

  const btn = doc.createElement("button");
  const input = doc.createElement("input");
  input.setAttribute("type", "text");
  const select = doc.createElement("select");
  const textarea = doc.createElement("textarea");
  const linkWithHref = doc.createElement("a");
  linkWithHref.setAttribute("href", "#main-content");
  const linkWithoutHref = doc.createElement("a");
  const audioWithControls = doc.createElement("audio");
  audioWithControls.setAttribute("controls", "");
  const audioWithoutControls = doc.createElement("audio");
  const tabbableDiv = doc.createElement("div");
  tabbableDiv.setAttribute("tabindex", "0");
  const editableDiv = doc.createElement("div");
  editableDiv.setAttribute("contenteditable", "true");

  assert.equal(isFocusableElement(btn), true);
  assert.equal(isFocusableElement(input), true);
  assert.equal(isFocusableElement(select), true);
  assert.equal(isFocusableElement(textarea), true);
  assert.equal(isFocusableElement(linkWithHref), true);
  assert.equal(isFocusableElement(linkWithoutHref), false);
  assert.equal(isFocusableElement(audioWithControls), true);
  assert.equal(isFocusableElement(audioWithoutControls), false);
  assert.equal(isFocusableElement(tabbableDiv), true);
  assert.equal(isFocusableElement(editableDiv), true);

  const hiddenInput = doc.createElement("input");
  hiddenInput.setAttribute("type", "hidden");
  assert.equal(isFocusableElement(hiddenInput), false);

  const decorativeSvg = doc.createElement("svg");
  decorativeSvg.setAttribute("focusable", "false");
  decorativeSvg.setAttribute("tabindex", "0");
  assert.equal(isFocusableElement(decorativeSvg), false);

  const disabledBtn = doc.createElement("button");
  disabledBtn.disabled = true;
  assert.equal(isFocusableElement(disabledBtn), false);

  const attrDisabledInput = doc.createElement("input");
  attrDisabledInput.setAttribute("disabled", "disabled");
  assert.equal(isFocusableElement(attrDisabledInput), false);

  const minusOneBtn = doc.createElement("button");
  minusOneBtn.setAttribute("tabindex", "-1");
  assert.equal(isFocusableElement(minusOneBtn), false);

  const dialogRoot = doc.createElement("div");
  dialogRoot.setAttribute("role", "dialog");
  dialogRoot.tabIndex = -1;
  assert.equal(isFocusableElement(dialogRoot), false);

  const ariaHiddenSelf = doc.createElement("button");
  ariaHiddenSelf.setAttribute("aria-hidden", "true");
  assert.equal(isFocusableElement(ariaHiddenSelf), false);

  const ariaHiddenParent = doc.createElement("div");
  ariaHiddenParent.setAttribute("aria-hidden", "true");
  const childInsideAriaHidden = doc.createElement("button");
  ariaHiddenParent.appendChild(childInsideAriaHidden);
  assert.equal(isFocusableElement(childInsideAriaHidden), false);

  const hiddenParent = doc.createElement("div");
  hiddenParent.hidden = true;
  const childInsideHidden = doc.createElement("button");
  hiddenParent.appendChild(childInsideHidden);
  assert.equal(isFocusableElement(childInsideHidden), false);

  const inertParent = doc.createElement("div");
  inertParent.inert = true;
  const childInsideInert = doc.createElement("button");
  inertParent.appendChild(childInsideInert);
  assert.equal(isFocusableElement(childInsideInert), false);

  const displayNoneParent = doc.createElement("div");
  displayNoneParent.style.display = "none";
  const childInsideDisplayNone = doc.createElement("button");
  displayNoneParent.appendChild(childInsideDisplayNone);
  assert.equal(isFocusableElement(childInsideDisplayNone), false);

  const visHiddenParent = doc.createElement("div");
  visHiddenParent.style.visibility = "hidden";
  const childInheritingHiddenVis = doc.createElement("button");
  const childExplicitVisible = doc.createElement("button");
  childExplicitVisible.style.visibility = "visible";
  visHiddenParent.appendChild(childInheritingHiddenVis);
  visHiddenParent.appendChild(childExplicitVisible);
  assert.equal(isFocusableElement(childInheritingHiddenVis), false);
  assert.equal(isFocusableElement(childExplicitVisible), true);

  const disabledFieldset = doc.createElement("fieldset");
  disabledFieldset.disabled = true;
  const firstLegend = doc.createElement("legend");
  const legendBtn = doc.createElement("button");
  firstLegend.appendChild(legendBtn);
  const bodyBtn = doc.createElement("button");
  disabledFieldset.appendChild(firstLegend);
  disabledFieldset.appendChild(bodyBtn);
  assert.equal(isFocusableElement(legendBtn), true);
  assert.equal(isFocusableElement(bodyBtn), false);
});

test("getTabbableElements returns enabled tabbable descendants in order and excludes disabled, aria-hidden, hidden, and tabIndex=-1 nodes", () => {
  const doc = new MiniDomDocument();
  const dialog = doc.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("tabindex", "-1");

  const heading = doc.createElement("h2");
  heading.setAttribute("tabindex", "-1");
  dialog.appendChild(heading);

  const firstBtn = doc.createElement("button");
  firstBtn.setAttribute("data-id", "first");
  dialog.appendChild(firstBtn);

  const disabledBtn = doc.createElement("button");
  disabledBtn.disabled = true;
  dialog.appendChild(disabledBtn);

  const ariaHiddenGroup = doc.createElement("section");
  ariaHiddenGroup.setAttribute("aria-hidden", "true");
  const buttonInAriaHidden = doc.createElement("button");
  ariaHiddenGroup.appendChild(buttonInAriaHidden);
  dialog.appendChild(ariaHiddenGroup);

  const hiddenGroup = doc.createElement("div");
  hiddenGroup.setAttribute("hidden", "");
  const inputInHidden = doc.createElement("input");
  hiddenGroup.appendChild(inputInHidden);
  dialog.appendChild(hiddenGroup);

  const skippedBtn = doc.createElement("button");
  skippedBtn.setAttribute("tabindex", "-1");
  dialog.appendChild(skippedBtn);

  const middleLink = doc.createElement("a");
  middleLink.setAttribute("href", "#shortcuts");
  dialog.appendChild(middleLink);

  const lastInput = doc.createElement("textarea");
  dialog.appendChild(lastInput);

  assert.deepEqual(getTabbableElements(dialog), [firstBtn, middleLink, lastInput]);
  assert.deepEqual(getTabbableElements(null), []);
  assert.deepEqual(getTabbableElements(undefined), []);

  dialog.hidden = true;
  assert.deepEqual(getTabbableElements(dialog), []);
  dialog.hidden = false;

  const rankedDialog = doc.createElement("div");
  const autoZeroA = doc.createElement("button");
  const rankTwo = doc.createElement("button");
  rankTwo.setAttribute("tabindex", "2");
  const rankOne = doc.createElement("button");
  rankOne.setAttribute("tabindex", "1");
  const autoZeroB = doc.createElement("button");
  rankedDialog.appendChild(autoZeroA);
  rankedDialog.appendChild(rankTwo);
  rankedDialog.appendChild(rankOne);
  rankedDialog.appendChild(autoZeroB);
  assert.deepEqual(getTabbableElements(rankedDialog), [
    rankOne,
    rankTwo,
    autoZeroA,
    autoZeroB
  ]);

  const qsaOnlyA = { tagName: "BUTTON", focus() {} };
  const qsaOnlyDisabled = { tagName: "BUTTON", disabled: true, focus() {} };
  const qsaOnlyB = { tagName: "INPUT", type: "text", focus() {} };
  const qsaContainer = {
    querySelectorAll: () => [qsaOnlyA, qsaOnlyDisabled, qsaOnlyB]
  };
  assert.deepEqual(getTabbableElements(qsaContainer), [qsaOnlyA, qsaOnlyB]);
});

test("trapModalTabKey wraps forward Tab from last to first and wraps backward Shift+Tab from first to last", () => {
  const doc = new MiniDomDocument();
  const dialog = doc.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("tabindex", "-1");

  const firstBtn = doc.createElement("button");
  const middleInput = doc.createElement("input");
  const lastBtn = doc.createElement("button");
  const nestedSpan = doc.createElement("span");
  lastBtn.appendChild(nestedSpan);

  dialog.appendChild(firstBtn);
  dialog.appendChild(middleInput);
  dialog.appendChild(lastBtn);
  doc.body.appendChild(dialog);

  firstBtn.focus();
  assert.equal(doc.activeElement, firstBtn);

  const forward1 = makeTabEvent({ shiftKey: false, target: firstBtn });
  assert.equal(trapModalTabKey(forward1, dialog), true);
  assert.equal(forward1.preventedCount, 1);
  assert.equal(doc.activeElement, middleInput);

  const forward2 = makeTabEvent({ shiftKey: false, target: middleInput });
  assert.equal(trapModalTabKey(forward2, dialog), true);
  assert.equal(forward2.preventedCount, 1);
  assert.equal(doc.activeElement, lastBtn);

  const forwardWrap = makeTabEvent({ shiftKey: false, target: lastBtn });
  assert.equal(trapModalTabKey(forwardWrap, dialog), true);
  assert.equal(forwardWrap.preventedCount, 1);
  assert.equal(doc.activeElement, firstBtn);

  const backwardWrap = makeTabEvent({ shiftKey: true, target: firstBtn });
  assert.equal(trapModalTabKey(backwardWrap, dialog), true);
  assert.equal(backwardWrap.preventedCount, 1);
  assert.equal(doc.activeElement, lastBtn);

  const backwardStep = makeTabEvent({ shiftKey: true, target: lastBtn });
  assert.equal(trapModalTabKey(backwardStep, dialog), true);
  assert.equal(backwardStep.preventedCount, 1);
  assert.equal(doc.activeElement, middleInput);

  doc.activeElement = doc.body;
  const nestedTargetWrap = makeTabEvent({ shiftKey: false, target: nestedSpan });
  assert.equal(trapModalTabKey(nestedTargetWrap, dialog), true);
  assert.equal(nestedTargetWrap.preventedCount, 1);
  assert.equal(doc.activeElement, firstBtn);
});

test("trapModalTabKey wraps Shift+Tab from dialog-root initial focus to last, focuses container on 0 tabbables, and ignores non-Tab or modifier chords", () => {
  const doc = new MiniDomDocument();
  const dialog = doc.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("tabindex", "-1");

  const firstBtn = doc.createElement("button");
  const lastBtn = doc.createElement("button");
  dialog.appendChild(firstBtn);
  dialog.appendChild(lastBtn);
  doc.body.appendChild(dialog);

  dialog.focus();
  assert.equal(doc.activeElement, dialog);

  const rootShiftTab = makeTabEvent({ shiftKey: true, target: dialog });
  assert.equal(trapModalTabKey(rootShiftTab, dialog), true);
  assert.equal(rootShiftTab.preventedCount, 1);
  assert.equal(doc.activeElement, lastBtn);

  dialog.focus();
  const rootForwardTab = makeTabEvent({ shiftKey: false, target: dialog });
  assert.equal(trapModalTabKey(rootForwardTab, dialog), true);
  assert.equal(rootForwardTab.preventedCount, 1);
  assert.equal(doc.activeElement, firstBtn);

  firstBtn.disabled = true;
  lastBtn.hidden = true;
  doc.activeElement = doc.body;
  const dialogFocusBefore = dialog.focusCalls;
  const emptyTab = makeTabEvent({ shiftKey: false, target: dialog });
  assert.equal(trapModalTabKey(emptyTab, dialog), true);
  assert.equal(emptyTab.preventedCount, 1);
  assert.equal(dialog.focusCalls, dialogFocusBefore + 1);
  assert.equal(doc.activeElement, dialog);

  firstBtn.disabled = false;
  lastBtn.hidden = false;
  firstBtn.focus();

  for (const nonTabKey of ["Escape", "Enter", " ", "ArrowDown", "r"]) {
    const ev = makeTabEvent({ key: nonTabKey, target: firstBtn });
    assert.equal(trapModalTabKey(ev, dialog), false);
    assert.equal(ev.preventedCount, 0);
    assert.equal(doc.activeElement, firstBtn);
  }

  for (const modOverride of [
    { ctrlKey: true },
    { altKey: true },
    { metaKey: true },
    { ctrlKey: true, shiftKey: true },
    { defaultPrevented: true }
  ]) {
    const ev = makeTabEvent({ ...modOverride, target: firstBtn });
    assert.equal(trapModalTabKey(ev, dialog), false);
    assert.equal(ev.preventedCount, 0);
    assert.equal(doc.activeElement, firstBtn);
  }

  const nullContainerEv = makeTabEvent({ target: firstBtn });
  assert.equal(trapModalTabKey(nullContainerEv, null), false);
  assert.equal(nullContainerEv.preventedCount, 0);
});

test("ShortcutsModal SSR and mounted dialog wire trapModalTabKey across Tab, Shift+Tab, dialog-root initial focus, muted exclusion, and Escape", async () => {
  assert.equal(
    renderToStaticMarkup(
      createElement(ShortcutsModal, {
        open: false,
        lang: "en",
        muted: false,
        onClose: () => {}
      })
    ),
    ""
  );

  for (const locale of ["en", "fi", "sv"] as const) {
    const html = renderToStaticMarkup(
      createElement(ShortcutsModal, {
        open: true,
        lang: locale,
        muted: false,
        onClose: () => {}
      })
    );
    assert.ok(html.includes('role="dialog"'));
    assert.ok(html.includes('aria-modal="true"'));
    assert.ok(html.includes('tabindex="-1"'));
    assert.ok(html.includes('data-action="play-orientation"'));
    assert.ok(html.includes('data-action="close-shortcuts"'));
    assert.equal(html.includes(EM_DASH), false);
    assert.equal(html.includes(EN_DASH), false);
  }

  const g = globalThis as Record<string, unknown>;
  const prevWindow = g.window;
  const prevDocument = g.document;
  const prevHtmlElement = g.HTMLElement;
  const prevActEnv = g.IS_REACT_ACT_ENVIRONMENT;

  const doc = new MiniDomDocument();
  const winListeners = new Map<string, Set<(ev: unknown) => void>>();
  class FakeIframe {}
  const winObj = {
    HTMLIFrameElement: FakeIframe,
    HTMLElement: MiniDomNode,
    Element: MiniDomNode,
    Node: MiniDomNode,
    document: doc,
    addEventListener(type: string, fn: (ev: unknown) => void) {
      const set = winListeners.get(type) ?? new Set<(ev: unknown) => void>();
      set.add(fn);
      winListeners.set(type, set);
    },
    removeEventListener(type: string, fn: (ev: unknown) => void) {
      winListeners.get(type)?.delete(fn);
    }
  };
  doc.defaultView = winObj;

  const triggerBtn = doc.createElement("button");
  triggerBtn.setAttribute("data-action", "open-shortcuts-trigger");
  doc.body.appendChild(triggerBtn);

  const hostContainer = doc.createElement("div");
  doc.body.appendChild(hostContainer);

  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.window = winObj;
  g.document = doc;
  g.HTMLElement = MiniDomNode;

  let closeCount = 0;
  const onClose = () => {
    closeCount += 1;
  };

  const root = createRoot(hostContainer as unknown as Element);

  try {
    triggerBtn.focus();
    assert.equal(doc.activeElement === triggerBtn, true);

    await act(async () => {
      root.render(
        createElement(ShortcutsModal, {
          open: true,
          lang: "en",
          muted: false,
          onClose
        })
      );
    });

    const dialog = hostContainer.findByAttr("role", "dialog");
    const playBtn = hostContainer.findByAttr("data-action", "play-orientation");
    const closeBtn = hostContainer.findByAttr("data-action", "close-shortcuts");
    assert.ok(dialog);
    assert.ok(playBtn);
    assert.ok(closeBtn);

    assert.equal(doc.activeElement === dialog, true);
    const unmutedTabbables = getTabbableElements(dialog);
    assert.equal(unmutedTabbables.length, 2);
    assert.equal(unmutedTabbables[0] === playBtn, true);
    assert.equal(unmutedTabbables[1] === closeBtn, true);

    let keyResult = { defaultPrevented: false, propagationStopped: false };
    await act(async () => {
      keyResult = dialog.dispatchKeyDown({ key: "Tab", shiftKey: true });
    });
    assert.equal(keyResult.defaultPrevented, true);
    assert.equal(doc.activeElement === closeBtn, true);

    await act(async () => {
      keyResult = closeBtn.dispatchKeyDown({ key: "Tab", shiftKey: false });
    });
    assert.equal(keyResult.defaultPrevented, true);
    assert.equal(doc.activeElement === playBtn, true);

    await act(async () => {
      keyResult = playBtn.dispatchKeyDown({ key: "Tab", shiftKey: false });
    });
    assert.equal(keyResult.defaultPrevented, true);
    assert.equal(doc.activeElement === closeBtn, true);

    await act(async () => {
      keyResult = closeBtn.dispatchKeyDown({ key: "Tab", shiftKey: true });
    });
    assert.equal(keyResult.defaultPrevented, true);
    assert.equal(doc.activeElement === playBtn, true);

    await act(async () => {
      keyResult = playBtn.dispatchKeyDown({ key: "Tab", shiftKey: true });
    });
    assert.equal(keyResult.defaultPrevented, true);
    assert.equal(doc.activeElement === closeBtn, true);

    await act(async () => {
      keyResult = closeBtn.dispatchKeyDown({ key: "Tab", ctrlKey: true });
    });
    assert.equal(keyResult.defaultPrevented, false);
    assert.equal(doc.activeElement === closeBtn, true);

    await act(async () => {
      root.render(
        createElement(ShortcutsModal, {
          open: true,
          lang: "fi",
          muted: true,
          onClose
        })
      );
    });

    assert.equal(playBtn.disabled, true);
    const mutedTabbables = getTabbableElements(dialog);
    assert.equal(mutedTabbables.length, 1);
    assert.equal(mutedTabbables[0] === closeBtn, true);

    await act(async () => {
      keyResult = dialog.dispatchKeyDown({ key: "Tab", shiftKey: false });
    });
    assert.equal(keyResult.defaultPrevented, true);
    assert.equal(doc.activeElement === closeBtn, true);

    await act(async () => {
      keyResult = closeBtn.dispatchKeyDown({ key: "Tab", shiftKey: true });
    });
    assert.equal(keyResult.defaultPrevented, true);
    assert.equal(doc.activeElement === closeBtn, true);

    await act(async () => {
      keyResult = closeBtn.dispatchKeyDown({ key: "Escape" });
    });
    assert.equal(keyResult.defaultPrevented, true);
    assert.equal(closeCount, 1);

    await act(async () => {
      root.render(
        createElement(ShortcutsModal, {
          open: false,
          lang: "en",
          muted: false,
          onClose
        })
      );
    });
    assert.equal(doc.activeElement === triggerBtn, true);
  } finally {
    await act(async () => {
      root.unmount();
    });
    if (prevWindow === undefined) {
      delete g.window;
    } else {
      g.window = prevWindow;
    }
    if (prevDocument === undefined) {
      delete g.document;
    } else {
      g.document = prevDocument;
    }
    if (prevHtmlElement === undefined) {
      delete g.HTMLElement;
    } else {
      g.HTMLElement = prevHtmlElement;
    }
    if (prevActEnv === undefined) {
      delete g.IS_REACT_ACT_ENVIRONMENT;
    } else {
      g.IS_REACT_ACT_ENVIRONMENT = prevActEnv;
    }
  }
});

test("focusTrap.ts, ShortcutsModal.tsx, and focusTrap.test.ts contain zero code comments and zero em or en dashes", () => {
  const files = [
    new URL("../src/a11y/focusTrap.ts", import.meta.url),
    new URL("../src/components/ShortcutsModal.tsx", import.meta.url),
    new URL("./focusTrap.test.ts", import.meta.url)
  ];

  for (const fileUrl of files) {
    const source = readFileSync(fileUrl, "utf8");
    assert.equal(source.includes(LINE_COMMENT), false, `${fileUrl.pathname} had line comment`);
    assert.equal(
      source.includes(BLOCK_COMMENT_OPEN),
      false,
      `${fileUrl.pathname} had block comment open`
    );
    assert.equal(
      source.includes(BLOCK_COMMENT_CLOSE),
      false,
      `${fileUrl.pathname} had block comment close`
    );
    assert.equal(source.includes(EM_DASH), false, `${fileUrl.pathname} had em dash`);
    assert.equal(source.includes(EN_DASH), false, `${fileUrl.pathname} had en dash`);
  }
});
