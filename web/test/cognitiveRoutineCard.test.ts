import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CognitiveRoutineCard,
  ROUTINE_STRENGTH_MIN_CONF,
  deriveRoutineStep,
  isAsNeededRoutineSlot,
  resolveRoutineSlotForHour,
  type CognitiveRoutineCardProps
} from "../src/components/CognitiveRoutineCard.tsx";
import { DEMO_PROFILE, appendDoseLog, createMemoryStorage } from "../src/storage/profileStore.ts";
import type { LabelRead, Profile, Verdict } from "../src/types.ts";

(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

type TestFn = (name: string, fn: () => void | Promise<void>) => Promise<void>;

type AssertStrict = {
  ok(value: unknown, message?: string): asserts value;
  equal<T>(actual: T, expected: T, message?: string): void;
  notEqual<T>(actual: T, expected: T, message?: string): void;
  deepEqual<T>(actual: T, expected: T, message?: string): void;
  match(value: string, regExp: RegExp, message?: string): void;
  doesNotMatch(value: string, regExp: RegExp, message?: string): void;
};

type FsModule = {
  readFileSync(path: URL | string, encoding: "utf8"): string;
};

const nodeTestSpec: string = "node:test";
const nodeAssertSpec: string = "node:assert/strict";
const nodeFsSpec: string = "node:fs";

const { test } = (await import(nodeTestSpec)) as { test: TestFn };
const assert: AssertStrict = (await import(nodeAssertSpec)) as AssertStrict;
const { readFileSync } = (await import(nodeFsSpec)) as FsModule;

const SLASH = String.fromCharCode(47);
const LINE_COMMENT = SLASH + SLASH;
const BLOCK_COMMENT_OPEN = SLASH + "*";
const BLOCK_COMMENT_CLOSE = "*" + SLASH;
const HTML_COMMENT_OPEN = "<" + "!--";
const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);
const XHTML_NS = `http:${SLASH}${SLASH}www.w3.org${SLASH}1999${SLASH}xhtml`;

const FIXED_MORNING_NOW = new Date(2026, 10, 14, 8, 30, 0);
const FIXED_EVENING_NOW = new Date(2026, 10, 14, 19, 30, 0);
const FIXED_MORNING_DOSE_TS = new Date(2026, 10, 14, 8, 15, 0).getTime();
const FIXED_EVENING_DOSE_TS = new Date(2026, 10, 14, 19, 10, 0).getTime();
const FIXED_LATE_EVENING_DOSE_TS = new Date(2026, 10, 14, 19, 25, 0).getTime();
const YESTERDAY_DOSE_TS = new Date(2026, 10, 13, 20, 0, 0).getTime();
const TOMORROW_DOSE_TS = new Date(2026, 10, 15, 8, 0, 0).getTime();

const EMPTY_PROFILE: Profile = {
  meds: [],
  allergies: [],
  avoid: [],
  doseLog: [],
  lang: "en"
};

function makeLabelRead(overrides: Partial<LabelRead> = {}): LabelRead {
  return {
    kind: "medication",
    product: { value: "Amlodipin", confidence: 0.97 },
    ingredient: { value: "amlodipine", confidence: 0.98 },
    strength: { value: "5 mg", confidence: 0.96 },
    dosing: { value: "1 tablet in the evening", confidence: 0.92 },
    expiry: { value: "2027-09", confidence: 0.91 },
    allergens: { value: [], confidence: 0.93 },
    barcode: { value: "6432100012345", confidence: 0.99 },
    readability: 0.95,
    ...overrides
  };
}

function makeVerdict(overrides: Partial<Verdict> = {}): Verdict {
  return {
    level: "match",
    headline: "Yes: Amlodipine 5 mg, your evening pill",
    speech: "Yes, Amlodipine 5 mg, your evening pill. You have not taken it today.",
    matchedMedId: "aml",
    takenToday: false,
    reasons: ["matches aml", "taken today: 0/1"],
    read: makeLabelRead(),
    ...overrides
  };
}

function renderCard(props: CognitiveRoutineCardProps): string {
  return renderToStaticMarkup(createElement(CognitiveRoutineCard, props));
}

function extractOpeningTagsByClass(html: string, classToken: string): string[] {
  const escaped = classToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `<([a-z0-9]+)\\b[^>]*class="(?:[^"]*\\s)?${escaped}(?:\\s[^"]*)?"[^>]*>`,
    "gi"
  );
  const out: string[] = [];
  let match: RegExpExecArray | null = pattern.exec(html);
  while (match !== null) {
    out.push(match[0]);
    match = pattern.exec(html);
  }
  return out;
}

function extractAllOpeningTags(html: string, tagName: string): string[] {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>`, "gi");
  const out: string[] = [];
  let match: RegExpExecArray | null = pattern.exec(html);
  while (match !== null) {
    out.push(match[0]);
    match = pattern.exec(html);
  }
  return out;
}

function parseRemFontSize(tag: string): number {
  const styleMatch = /\bstyle="([^"]*)"/i.exec(tag);
  assert.ok(styleMatch, `Expected style attribute on tag: ${tag}`);
  const fontSizeMatch = /font-size:[^;]*?(\d+(?:\.\d+)?)rem/i.exec(styleMatch[1]);
  assert.ok(fontSizeMatch, `Expected rem font-size in style: ${styleMatch[1]}`);
  return Number.parseFloat(fontSizeMatch[1]);
}

type ListenerEntry = {
  fn: (ev: unknown) => void;
  capture: boolean;
};

class MiniDomNode {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly tagName: string;
  namespaceURI = XHTML_NS;
  ownerDocument: MiniDomDocument;
  parentNode: MiniDomNode | null = null;
  childNodes: MiniDomNode[] = [];
  style: Record<string, string> = {};
  attributes = new Map<string, string>();
  listeners = new Map<string, ListenerEntry[]>();
  disabled = false;
  textContentValue = "";

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
    this.childNodes = [];
    if (this.nodeType === 3) {
      this.textContentValue = String(val);
    } else if (val) {
      const txt = this.ownerDocument.createTextNode(String(val));
      this.appendChild(txt);
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

  insertBefore(newNode: MiniDomNode, refNode: MiniDomNode | null): MiniDomNode {
    if (!refNode) {
      return this.appendChild(newNode);
    }
    if (newNode.parentNode) {
      newNode.parentNode.removeChild(newNode);
    }
    const idx = this.childNodes.indexOf(refNode);
    newNode.parentNode = this;
    if (idx === -1) {
      this.childNodes.push(newNode);
    } else {
      this.childNodes.splice(idx, 0, newNode);
    }
    return newNode;
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
    this.attributes.set(name, String(value));
  }

  setAttributeNS(_ns: string | null, name: string, value: string): void {
    this.setAttribute(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  addEventListener(type: string, fn: (ev: unknown) => void, options?: boolean | { capture?: boolean }): void {
    const capture = typeof options === "boolean" ? options : Boolean(options?.capture);
    const list = this.listeners.get(type) ?? [];
    list.push({ fn, capture });
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, fn: (ev: unknown) => void): void {
    const list = this.listeners.get(type);
    if (!list) {
      return;
    }
    this.listeners.set(
      type,
      list.filter((entry) => entry.fn !== fn)
    );
  }

  querySelectorAllByAttr(attrName: string, attrValue?: string): MiniDomNode[] {
    const matches: MiniDomNode[] = [];
    const visit = (node: MiniDomNode): void => {
      if (node.nodeType === 1) {
        const actual = node.getAttribute(attrName);
        if (actual !== null && (attrValue === undefined || actual === attrValue)) {
          matches.push(node);
        }
      }
      for (const child of node.childNodes) {
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  click(): void {
    if (this.disabled) {
      return;
    }
    const path: MiniDomNode[] = [];
    let cur: MiniDomNode | null = this;
    while (cur !== null) {
      path.push(cur);
      cur = cur.parentNode;
    }
    const event = {
      type: "click",
      bubbles: true,
      cancelable: true,
      defaultPrevented: false,
      target: this,
      currentTarget: this as MiniDomNode | null,
      eventPhase: 2,
      timeStamp: Date.now(),
      isTrusted: true,
      nativeEvent: null as unknown,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        void 0;
      }
    };
    event.nativeEvent = event;
    for (let i = path.length - 1; i >= 0; i -= 1) {
      const node = path[i];
      event.currentTarget = node;
      for (const entry of node.listeners.get("click") ?? []) {
        if (entry.capture) {
          entry.fn(event);
        }
      }
    }
    for (let i = 0; i < path.length; i += 1) {
      const node = path[i];
      event.currentTarget = node;
      for (const entry of node.listeners.get("click") ?? []) {
        if (!entry.capture) {
          entry.fn(event);
        }
      }
    }
  }
}

class MiniDomDocument extends MiniDomNode {
  body: MiniDomNode;
  documentElement: MiniDomNode;
  activeElement: MiniDomNode | null = null;
  defaultView: unknown = null;

  constructor() {
    super(9, "#document", null as unknown as MiniDomDocument);
    this.ownerDocument = this;
    this.documentElement = new MiniDomNode(1, "html", this);
    this.body = new MiniDomNode(1, "body", this);
    this.documentElement.appendChild(this.body);
    this.appendChild(this.documentElement);
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

  createComment(text: string): MiniDomNode {
    const node = new MiniDomNode(8, "#comment", this);
    node.textContentValue = String(text);
    return node;
  }
}

async function withMiniDom(fn: (container: MiniDomNode) => Promise<void> | void): Promise<void> {
  const g = globalThis as Record<string, unknown>;
  const prevDoc = g.document;
  const prevWin = g.window;
  const prevElem = g.HTMLElement;
  const prevNode = g.Node;

  const doc = new MiniDomDocument();
  const win = {
    document: doc,
    HTMLIFrameElement: class {},
    HTMLElement: MiniDomNode,
    Node: MiniDomNode,
    SVGElement: MiniDomNode,
    Event: class {},
    MouseEvent: class {}
  };
  doc.defaultView = win;

  g.document = doc;
  g.window = win;
  g.HTMLElement = MiniDomNode;
  g.Node = MiniDomNode;

  const container = doc.createElement("div");
  doc.body.appendChild(container);

  try {
    await fn(container);
  } finally {
    g.document = prevDoc;
    g.window = prevWin;
    g.HTMLElement = prevElem;
    g.Node = prevNode;
  }
}

test("deriveRoutineStep handles empty profile and ignores as-needed, prn, tarvittaessa, and vid behov slots", () => {
  assert.equal(ROUTINE_STRENGTH_MIN_CONF, 0.8);
  assert.equal(isAsNeededRoutineSlot("as needed"), true);
  assert.equal(isAsNeededRoutineSlot("PRN"), true);
  assert.equal(isAsNeededRoutineSlot("tarvittaessa"), true);
  assert.equal(isAsNeededRoutineSlot("vid behov"), true);
  assert.equal(isAsNeededRoutineSlot("evening"), false);

  const emptyResult = deriveRoutineStep(EMPTY_PROFILE, false, null, FIXED_EVENING_NOW);
  assert.equal(emptyResult.activeStep, 1);
  assert.equal(emptyResult.scheduledTaken, 0);
  assert.equal(emptyResult.scheduledRemaining, 0);
  assert.equal(emptyResult.scheduledTotal, 0);
  assert.equal(emptyResult.allScheduledTaken, false);
  assert.equal(emptyResult.nextScheduledMed, null);
  assert.equal(emptyResult.nextScheduledSlot, null);
  assert.equal(emptyResult.outcome, "empty_profile");
  assert.equal(emptyResult.primaryAction, "start_check");
  assert.equal(emptyResult.canLogDose, false);
  assert.equal(emptyResult.doubleDoseBlocked, false);

  const prnOnlyProfile: Profile = {
    meds: [
      { id: "par", name: "Panadol", ingredient: "paracetamol", strength: "500 mg", schedule: ["as needed"] },
      { id: "cet", name: "Heinix", ingredient: "cetirizine", strength: "10 mg", schedule: ["prn"] },
      { id: "mel", name: "Melatoniini", ingredient: "melatonin", strength: "3 mg", schedule: ["tarvittaessa"] },
      { id: "sal", name: "Ventoline", ingredient: "salbutamol", strength: "0.1 mg", schedule: ["vid behov"] }
    ],
    allergies: [],
    avoid: [],
    doseLog: [
      { medId: "par", ts: FIXED_MORNING_DOSE_TS },
      { medId: "cet", ts: FIXED_EVENING_DOSE_TS }
    ],
    lang: "fi"
  };

  const prnResult = deriveRoutineStep(prnOnlyProfile, false, null, FIXED_EVENING_NOW);
  assert.equal(prnResult.activeStep, 1);
  assert.equal(prnResult.scheduledTaken, 0);
  assert.equal(prnResult.scheduledRemaining, 0);
  assert.equal(prnResult.scheduledTotal, 0);
  assert.equal(prnResult.allScheduledTaken, false);
  assert.equal(prnResult.nextScheduledMed, null);
  assert.equal(prnResult.outcome, "empty_profile");
});

test("deriveRoutineStep computes pending morning and evening doses and prioritizes current time window", () => {
  assert.equal(resolveRoutineSlotForHour(8), "morning");
  assert.equal(resolveRoutineSlotForHour(13), "noon");
  assert.equal(resolveRoutineSlotForHour(19), "evening");
  assert.equal(resolveRoutineSlotForHour(23), "bedtime");

  const withOtherDaysOnly: Profile = {
    ...DEMO_PROFILE,
    doseLog: [
      { medId: "aml", ts: YESTERDAY_DOSE_TS },
      { medId: "met", ts: TOMORROW_DOSE_TS }
    ]
  };

  const morningPending = deriveRoutineStep(withOtherDaysOnly, false, null, FIXED_MORNING_NOW);
  assert.equal(morningPending.activeStep, 1);
  assert.equal(morningPending.scheduledTaken, 0);
  assert.equal(morningPending.scheduledRemaining, 3);
  assert.equal(morningPending.scheduledTotal, 3);
  assert.equal(morningPending.allScheduledTaken, false);
  assert.equal(morningPending.outcome, "due_pill");
  assert.equal(morningPending.nextScheduledMed?.id, "met");
  assert.equal(morningPending.nextScheduledSlot, "morning");

  const storage = createMemoryStorage();
  const afterMorningMet = appendDoseLog(DEMO_PROFILE, "met", FIXED_MORNING_DOSE_TS, storage);
  const eveningPending = deriveRoutineStep(afterMorningMet, false, null, FIXED_EVENING_NOW);

  assert.equal(eveningPending.activeStep, 1);
  assert.equal(eveningPending.scheduledTaken, 1);
  assert.equal(eveningPending.scheduledRemaining, 2);
  assert.equal(eveningPending.scheduledTotal, 3);
  assert.equal(eveningPending.allScheduledTaken, false);
  assert.equal(eveningPending.outcome, "due_pill");
  assert.equal(eveningPending.nextScheduledMed?.id, "aml");
  assert.equal(eveningPending.nextScheduledMed?.name, "Amlodipin");
  assert.equal(eveningPending.nextScheduledSlot, "evening");
  assert.equal(eveningPending.primaryAction, "start_check");

  const afterAmlLogged = appendDoseLog(afterMorningMet, "aml", FIXED_EVENING_DOSE_TS, storage);
  const secondEveningPending = deriveRoutineStep(afterAmlLogged, false, null, FIXED_EVENING_NOW);
  assert.equal(secondEveningPending.scheduledTaken, 2);
  assert.equal(secondEveningPending.scheduledRemaining, 1);
  assert.equal(secondEveningPending.nextScheduledMed?.id, "met");
  assert.equal(secondEveningPending.nextScheduledSlot, "evening");
});

test("deriveRoutineStep celebrates all scheduled doses taken and caps per-medication duplicate logs", () => {
  const storage = createMemoryStorage();
  let completeProfile = appendDoseLog(DEMO_PROFILE, "met", FIXED_MORNING_DOSE_TS, storage);
  completeProfile = appendDoseLog(completeProfile, "aml", FIXED_EVENING_DOSE_TS, storage);
  completeProfile = appendDoseLog(completeProfile, "met", FIXED_LATE_EVENING_DOSE_TS, storage);

  const allDone = deriveRoutineStep(completeProfile, false, null, FIXED_EVENING_NOW);
  assert.equal(allDone.activeStep, 1);
  assert.equal(allDone.scheduledTaken, 3);
  assert.equal(allDone.scheduledRemaining, 0);
  assert.equal(allDone.scheduledTotal, 3);
  assert.equal(allDone.allScheduledTaken, true);
  assert.equal(allDone.nextScheduledMed, null);
  assert.equal(allDone.nextScheduledSlot, null);
  assert.equal(allDone.outcome, "all_taken");
  assert.equal(allDone.tone, "match");
  assert.equal(allDone.primaryAction, "start_check");

  const duplicateAmlOnly: Profile = {
    ...DEMO_PROFILE,
    doseLog: [
      { medId: "aml", ts: FIXED_EVENING_DOSE_TS },
      { medId: "aml", ts: FIXED_LATE_EVENING_DOSE_TS }
    ]
  };
  const capped = deriveRoutineStep(duplicateAmlOnly, false, null, FIXED_EVENING_NOW);
  assert.equal(capped.scheduledTaken, 1);
  assert.equal(capped.scheduledRemaining, 2);
  assert.equal(capped.allScheduledTaken, false);
  assert.equal(capped.nextScheduledMed?.id, "met");
});

test("deriveRoutineStep enters step 2 chest-height coaching when camera is active with no verdict", () => {
  const storage = createMemoryStorage();
  const partialProfile = appendDoseLog(DEMO_PROFILE, "met", FIXED_MORNING_DOSE_TS, storage);

  const activeCameraState = deriveRoutineStep(partialProfile, true, null, FIXED_EVENING_NOW);
  assert.equal(activeCameraState.activeStep, 2);
  assert.equal(activeCameraState.outcome, "camera_coaching");
  assert.equal(activeCameraState.primaryAction, "start_check");
  assert.equal(activeCameraState.tone, "info");
  assert.equal(activeCameraState.canLogDose, false);
  assert.equal(activeCameraState.doubleDoseBlocked, false);
  assert.equal(activeCameraState.scheduledTaken, 1);
  assert.equal(activeCameraState.scheduledRemaining, 2);
  assert.equal(activeCameraState.nextScheduledMed?.id, "aml");
});

test("deriveRoutineStep enters step 3 across match, warning, <80% unsure, info, and double-dose block", () => {
  const matchVerdict = makeVerdict();
  const matchStep = deriveRoutineStep(DEMO_PROFILE, true, matchVerdict, FIXED_EVENING_NOW);
  assert.equal(matchStep.activeStep, 3);
  assert.equal(matchStep.outcome, "verified_match");
  assert.equal(matchStep.primaryAction, "log_dose");
  assert.equal(matchStep.tone, "match");
  assert.equal(matchStep.canLogDose, true);
  assert.equal(matchStep.doubleDoseBlocked, false);
  assert.equal(matchStep.belowStrengthThreshold, false);
  assert.equal(matchStep.requiresPharmacistCheck, false);
  assert.equal(matchStep.matchedMedId, "aml");

  const storage = createMemoryStorage();
  const metMorningTaken = appendDoseLog(DEMO_PROFILE, "met", FIXED_MORNING_DOSE_TS, storage);
  const secondMetMatch = makeVerdict({
    matchedMedId: "met",
    takenToday: true,
    headline: "Yes: Metformin 500 mg, your evening pill",
    read: makeLabelRead({
      product: { value: "Metformin", confidence: 0.96 },
      ingredient: { value: "metformin", confidence: 0.97 },
      strength: { value: "500 mg", confidence: 0.95 }
    })
  });
  const secondMetStep = deriveRoutineStep(metMorningTaken, false, secondMetMatch, FIXED_EVENING_NOW);
  assert.equal(secondMetStep.outcome, "verified_match");
  assert.equal(secondMetStep.canLogDose, true);
  assert.equal(secondMetStep.doubleDoseBlocked, false);

  const avoidWarningVerdict = makeVerdict({
    level: "warning",
    headline: "Burana 400 mg: on your avoid list",
    speech: "This is Ibuprofen 400 mg. Your profile says to avoid NSAIDs.",
    matchedMedId: undefined,
    takenToday: undefined,
    reasons: ["Ibuprofen is an NSAID, on your avoid list"],
    read: makeLabelRead({
      product: { value: "Burana", confidence: 0.96 },
      ingredient: { value: "ibuprofen", confidence: 0.97 },
      strength: { value: "400 mg", confidence: 0.95 }
    })
  });
  const warningStep = deriveRoutineStep(DEMO_PROFILE, false, avoidWarningVerdict, FIXED_EVENING_NOW);
  assert.equal(warningStep.activeStep, 3);
  assert.equal(warningStep.outcome, "safety_warning");
  assert.equal(warningStep.primaryAction, "repeat_verdict");
  assert.equal(warningStep.tone, "warning");
  assert.equal(warningStep.canLogDose, false);
  assert.equal(warningStep.doubleDoseBlocked, false);
  assert.equal(warningStep.requiresPharmacistCheck, true);

  const blurryUnsureVerdict = makeVerdict({
    level: "unsure",
    headline: "Amlodipine: strength unclear",
    speech: "It looks like Amlodipine, but I cannot read the strength confidently.",
    matchedMedId: "aml",
    takenToday: undefined,
    reasons: ["strength confidence 0.42 < 0.8"],
    read: makeLabelRead({
      strength: { value: "5 mg", confidence: 0.42 },
      readability: 0.54
    })
  });
  const unsureStep = deriveRoutineStep(DEMO_PROFILE, true, blurryUnsureVerdict, FIXED_EVENING_NOW);
  assert.equal(unsureStep.activeStep, 3);
  assert.equal(unsureStep.outcome, "unsure_reaim");
  assert.equal(unsureStep.primaryAction, "start_check");
  assert.equal(unsureStep.tone, "unsure");
  assert.equal(unsureStep.canLogDose, false);
  assert.equal(unsureStep.belowStrengthThreshold, true);
  assert.equal(unsureStep.requiresPharmacistCheck, true);

  const lowConfMatchVerdict = makeVerdict({
    level: "match",
    read: makeLabelRead({
      strength: { value: "5 mg", confidence: 0.75 }
    })
  });
  const gatedStep = deriveRoutineStep(DEMO_PROFILE, false, lowConfMatchVerdict, FIXED_EVENING_NOW);
  assert.equal(gatedStep.outcome, "unsure_reaim");
  assert.equal(gatedStep.canLogDose, false);
  assert.equal(gatedStep.belowStrengthThreshold, true);

  const oatMilkInfoVerdict = makeVerdict({
    level: "info",
    headline: "Oat milk: none of your allergens",
    speech: "Oat milk: no peanut and tree nuts listed.",
    matchedMedId: undefined,
    takenToday: undefined,
    reasons: ["no listed allergen matches your profile"],
    read: makeLabelRead({
      kind: "food",
      product: { value: "Oat milk", confidence: 0.96 },
      ingredient: { value: "water, oats", confidence: 0.92 },
      strength: { value: null, confidence: 0 }
    })
  });
  const infoStep = deriveRoutineStep(DEMO_PROFILE, false, oatMilkInfoVerdict, FIXED_EVENING_NOW);
  assert.equal(infoStep.activeStep, 3);
  assert.equal(infoStep.outcome, "info_read");
  assert.equal(infoStep.primaryAction, "repeat_verdict");
  assert.equal(infoStep.tone, "info");
  assert.equal(infoStep.canLogDose, false);
  assert.equal(infoStep.requiresPharmacistCheck, false);

  const doubleDoseWarning = makeVerdict({
    level: "warning",
    headline: "Amlodipine 5 mg: already taken today",
    speech: "This is Amlodipine 5 mg, your evening pill. You already took it today.",
    matchedMedId: "aml",
    takenToday: true,
    reasons: ["matches aml", "taken today: 1/1"]
  });
  const blockedWarningStep = deriveRoutineStep(DEMO_PROFILE, false, doubleDoseWarning, FIXED_EVENING_NOW);
  assert.equal(blockedWarningStep.activeStep, 3);
  assert.equal(blockedWarningStep.outcome, "double_dose_blocked");
  assert.equal(blockedWarningStep.primaryAction, "repeat_verdict");
  assert.equal(blockedWarningStep.tone, "warning");
  assert.equal(blockedWarningStep.canLogDose, false);
  assert.equal(blockedWarningStep.doubleDoseBlocked, true);
  assert.equal(blockedWarningStep.requiresPharmacistCheck, true);

  const optimisticPostLogMatch = makeVerdict({
    level: "match",
    matchedMedId: "aml",
    takenToday: true
  });
  const blockedPostLogStep = deriveRoutineStep(DEMO_PROFILE, false, optimisticPostLogMatch, FIXED_EVENING_NOW);
  assert.equal(blockedPostLogStep.outcome, "double_dose_blocked");
  assert.equal(blockedPostLogStep.doubleDoseBlocked, true);
  assert.equal(blockedPostLogStep.canLogDose, false);

  const amlLoggedProfile = appendDoseLog(DEMO_PROFILE, "aml", FIXED_EVENING_DOSE_TS, storage);
  const blockedFromLogStep = deriveRoutineStep(amlLoggedProfile, false, matchVerdict, FIXED_EVENING_NOW);
  assert.equal(blockedFromLogStep.outcome, "double_dose_blocked");
  assert.equal(blockedFromLogStep.doubleDoseBlocked, true);
  assert.equal(blockedFromLogStep.canLogDose, false);
});

test("CognitiveRoutineCard SSR renders WCAG 2.2 AAA section, 3-step ol with aria-current=step, >=1.25rem callout, and >=60px primary target", () => {
  const storage = createMemoryStorage();
  const partialProfile = appendDoseLog(DEMO_PROFILE, "met", FIXED_MORNING_DOSE_TS, storage);

  const step1Html = renderCard({
    profile: partialProfile,
    cameraActive: false,
    lastVerdict: null,
    lang: "en",
    now: FIXED_EVENING_NOW,
    onStartCheck: () => {},
    onLogDose: () => {},
    onRepeatVerdict: () => {}
  });

  const sectionTags = extractAllOpeningTags(step1Html, "section");
  assert.equal(sectionTags.length, 1);
  assert.ok(sectionTags[0].includes('aria-labelledby="'));
  assert.ok(sectionTags[0].includes('lang="en"'));
  assert.ok(sectionTags[0].includes('data-active-step="1"'));

  const olTags = extractAllOpeningTags(step1Html, "ol");
  assert.equal(olTags.length, 1);

  const step1Lis = extractOpeningTagsByClass(step1Html, "cognitive-routine-step");
  assert.equal(step1Lis.length, 3);
  assert.equal(step1Lis[0].includes('aria-current="step"'), true);
  assert.equal(step1Lis[1].includes('aria-current="step"'), false);
  assert.equal(step1Lis[2].includes('aria-current="step"'), false);

  const step2Html = renderCard({
    profile: partialProfile,
    cameraActive: true,
    lastVerdict: null,
    lang: "en",
    now: FIXED_EVENING_NOW
  });
  const step2Lis = extractOpeningTagsByClass(step2Html, "cognitive-routine-step");
  assert.equal(step2Lis[0].includes('aria-current="step"'), false);
  assert.equal(step2Lis[1].includes('aria-current="step"'), true);
  assert.equal(step2Lis[2].includes('aria-current="step"'), false);
  assert.ok(step2Html.includes("Hold Amlodipin 5 mg steady at chest height"));

  const step3Html = renderCard({
    profile: partialProfile,
    cameraActive: false,
    lastVerdict: makeVerdict(),
    lang: "en",
    now: FIXED_EVENING_NOW,
    onStartCheck: () => {},
    onLogDose: () => {},
    onRepeatVerdict: () => {}
  });
  const step3Lis = extractOpeningTagsByClass(step3Html, "cognitive-routine-step");
  assert.equal(step3Lis[0].includes('aria-current="step"'), false);
  assert.equal(step3Lis[1].includes('aria-current="step"'), false);
  assert.equal(step3Lis[2].includes('aria-current="step"'), true);

  const calloutHeadlines = extractOpeningTagsByClass(step3Html, "cognitive-routine-callout-headline");
  const calloutBodies = extractOpeningTagsByClass(step3Html, "cognitive-routine-callout-body");
  assert.equal(calloutHeadlines.length, 1);
  assert.equal(calloutBodies.length, 1);
  assert.ok(parseRemFontSize(calloutHeadlines[0]) >= 1.25);
  assert.ok(parseRemFontSize(calloutBodies[0]) >= 1.25);

  for (const html of [step1Html, step2Html, step3Html]) {
    const primaryBtns = extractOpeningTagsByClass(html, "cognitive-routine-primary-btn");
    assert.equal(primaryBtns.length, 1);
    const primaryMinH = /min-height:(\d+)px/.exec(primaryBtns[0]);
    const primaryMinW = /min-width:(\d+)px/.exec(primaryBtns[0]);
    assert.ok(primaryMinH && Number.parseInt(primaryMinH[1], 10) >= 60);
    assert.ok(primaryMinW && Number.parseInt(primaryMinW[1], 10) >= 56);

    const allBtns = extractAllOpeningTags(html, "button");
    assert.ok(allBtns.length >= 1);
    for (const btnTag of allBtns) {
      const minH = /min-height:(\d+)px/.exec(btnTag);
      const minW = /min-width:(\d+)px/.exec(btnTag);
      assert.ok(minH && Number.parseInt(minH[1], 10) >= 56);
      assert.ok(minW && Number.parseInt(minW[1], 10) >= 56);
    }

    assert.ok(html.includes("EU MDR Art. 2(1)"));
  }
});

test("CognitiveRoutineCard localizes across en, fi, and sv with regional normalization and de fallback", () => {
  const storage = createMemoryStorage();
  const partialProfile = appendDoseLog(DEMO_PROFILE, "met", FIXED_MORNING_DOSE_TS, storage);

  const makeProps = (lang: string): CognitiveRoutineCardProps => ({
    profile: partialProfile,
    cameraActive: false,
    lastVerdict: null,
    lang,
    now: FIXED_EVENING_NOW,
    onStartCheck: () => {}
  });

  const enHtml = renderCard(makeProps("en"));
  const fiHtml = renderCard(makeProps("fi"));
  const svHtml = renderCard(makeProps("sv"));
  const fiRegionalHtml = renderCard(makeProps("fi-FI"));
  const svRegionalHtml = renderCard(makeProps("sv-SE"));
  const deFallbackHtml = renderCard(makeProps("de-DE"));

  assert.notEqual(enHtml, fiHtml);
  assert.notEqual(enHtml, svHtml);
  assert.notEqual(fiHtml, svHtml);
  assert.equal(fiRegionalHtml, fiHtml);
  assert.equal(svRegionalHtml, svHtml);
  assert.equal(deFallbackHtml, enHtml);

  assert.ok(enHtml.includes('lang="en"'));
  assert.ok(enHtml.includes("Guided 3-Step Pill Routine"));
  assert.ok(enHtml.includes("1 taken, 2 left today"));
  assert.ok(enHtml.includes("Next scheduled pill: Amlodipin 5 mg (Evening)"));
  assert.ok(enHtml.includes("Start Check for Amlodipin 5 mg"));

  assert.ok(fiHtml.includes('lang="fi"'));
  assert.ok(fiHtml.includes("Ohjattu 3 vaiheen lääkerutiini"));
  assert.ok(fiHtml.includes("1 otettu, 2 jäljellä tänään"));
  assert.ok(fiHtml.includes("Seuraava säännöllinen lääke: Amlodipin 5 mg (Ilta)"));
  assert.ok(fiHtml.includes("Aloita tarkistus: Amlodipin 5 mg"));
  assert.ok(fiHtml.includes("apteekista"));

  assert.ok(svHtml.includes('lang="sv"'));
  assert.ok(svHtml.includes("Guidad 3-stegs medicinrutin"));
  assert.ok(svHtml.includes("1 tagna, 2 kvar idag"));
  assert.ok(svHtml.includes("Nästa schemalagda medicin: Amlodipin 5 mg (Kväll)"));
  assert.ok(svHtml.includes("Starta kontroll för Amlodipin 5 mg"));
  assert.ok(svHtml.includes("apotekspersonal"));
});

test("CognitiveRoutineCard dispatches onStartCheck, onLogDose, and onRepeatVerdict while blocking double-dose logging", async () => {
  await withMiniDom(async (container) => {
    let startCalls = 0;
    const loggedIds: Array<string | undefined> = [];
    let repeatCalls = 0;

    const root = createRoot(container as unknown as Element);

    await act(async () => {
      root.render(
        createElement(CognitiveRoutineCard, {
          profile: DEMO_PROFILE,
          cameraActive: false,
          lastVerdict: null,
          lang: "en",
          now: FIXED_EVENING_NOW,
          onStartCheck: () => {
            startCalls += 1;
          },
          onLogDose: (medId) => {
            loggedIds.push(medId);
          },
          onRepeatVerdict: () => {
            repeatCalls += 1;
          }
        })
      );
    });

    const step1Btn = container.querySelectorAllByAttr("data-primary-action", "start_check");
    assert.equal(step1Btn.length, 1);
    await act(async () => {
      step1Btn[0].click();
    });
    assert.equal(startCalls, 1);
    assert.equal(loggedIds.length, 0);

    await act(async () => {
      root.render(
        createElement(CognitiveRoutineCard, {
          profile: DEMO_PROFILE,
          cameraActive: false,
          lastVerdict: makeVerdict(),
          lang: "en",
          now: FIXED_EVENING_NOW,
          onStartCheck: () => {
            startCalls += 1;
          },
          onLogDose: (medId) => {
            loggedIds.push(medId);
          },
          onRepeatVerdict: () => {
            repeatCalls += 1;
          }
        })
      );
    });

    const matchLogBtn = container.querySelectorAllByAttr("data-primary-action", "log_dose");
    const matchRepeatBtn = container.querySelectorAllByAttr("data-secondary-action", "repeat_verdict");
    assert.equal(matchLogBtn.length, 1);
    assert.equal(matchRepeatBtn.length, 1);
    await act(async () => {
      matchLogBtn[0].click();
      matchRepeatBtn[0].click();
    });
    assert.deepEqual(loggedIds, ["aml"]);
    assert.equal(repeatCalls, 1);

    const doubleDoseVerdict = makeVerdict({
      level: "warning",
      matchedMedId: "aml",
      takenToday: true,
      headline: "Amlodipine 5 mg: already taken today"
    });

    await act(async () => {
      root.render(
        createElement(CognitiveRoutineCard, {
          profile: DEMO_PROFILE,
          cameraActive: false,
          lastVerdict: doubleDoseVerdict,
          lang: "en",
          now: FIXED_EVENING_NOW,
          onStartCheck: () => {
            startCalls += 1;
          },
          onLogDose: (medId) => {
            loggedIds.push(medId);
          },
          onRepeatVerdict: () => {
            repeatCalls += 1;
          }
        })
      );
    });

    assert.equal(container.querySelectorAllByAttr("data-primary-action", "log_dose").length, 0);
    assert.equal(container.querySelectorAllByAttr("data-dose-log-blocked", "true").length, 1);
    const blockedPrimaryBtn = container.querySelectorAllByAttr("data-primary-action", "repeat_verdict");
    const blockedSecondaryBtn = container.querySelectorAllByAttr("data-secondary-action", "start_check");
    assert.equal(blockedPrimaryBtn.length, 1);
    assert.equal(blockedSecondaryBtn.length, 1);
    await act(async () => {
      blockedPrimaryBtn[0].click();
      blockedSecondaryBtn[0].click();
    });
    assert.deepEqual(loggedIds, ["aml"]);
    assert.equal(repeatCalls, 2);
    assert.equal(startCalls, 2);

    const unsureVerdict = makeVerdict({
      level: "unsure",
      read: makeLabelRead({ strength: { value: "5 mg", confidence: 0.45 } })
    });
    await act(async () => {
      root.render(
        createElement(CognitiveRoutineCard, {
          profile: DEMO_PROFILE,
          cameraActive: false,
          lastVerdict: unsureVerdict,
          lang: "en",
          now: FIXED_EVENING_NOW,
          onStartCheck: () => {
            startCalls += 1;
          },
          onLogDose: (medId) => {
            loggedIds.push(medId);
          },
          onRepeatVerdict: () => {
            repeatCalls += 1;
          }
        })
      );
    });

    const unsurePrimary = container.querySelectorAllByAttr("data-primary-action", "start_check");
    const unsureSecondary = container.querySelectorAllByAttr("data-secondary-action", "repeat_verdict");
    assert.equal(unsurePrimary.length, 1);
    assert.equal(unsureSecondary.length, 1);
    await act(async () => {
      unsurePrimary[0].click();
      unsureSecondary[0].click();
    });
    assert.equal(startCalls, 3);
    assert.equal(repeatCalls, 3);
    assert.deepEqual(loggedIds, ["aml"]);

    await act(async () => {
      root.unmount();
    });
  });
});

test("CognitiveRoutineCard and cognitiveRoutineCard.test.ts contain zero code comments and zero em or en dashes", () => {
  const componentSource = readFileSync(
    new URL("../src/components/CognitiveRoutineCard.tsx", import.meta.url),
    "utf8"
  );
  const testSource = readFileSync(
    new URL("./cognitiveRoutineCard.test.ts", import.meta.url),
    "utf8"
  );

  for (const [label, source] of [
    ["CognitiveRoutineCard.tsx", componentSource],
    ["cognitiveRoutineCard.test.ts", testSource]
  ] as const) {
    assert.equal(source.includes(LINE_COMMENT), false, `${label} must not contain line comments`);
    assert.equal(source.includes(BLOCK_COMMENT_OPEN), false, `${label} must not contain block comments`);
    assert.equal(source.includes(BLOCK_COMMENT_CLOSE), false, `${label} must not contain block comment closures`);
    assert.equal(source.includes(HTML_COMMENT_OPEN), false, `${label} must not contain HTML comments`);
    assert.equal(source.includes(EM_DASH), false, `${label} must not contain em dashes`);
    assert.equal(source.includes(EN_DASH), false, `${label} must not contain en dashes`);
  }

  const storage = createMemoryStorage();
  const allTakenProfile = appendDoseLog(
    appendDoseLog(
      appendDoseLog(DEMO_PROFILE, "met", FIXED_MORNING_DOSE_TS, storage),
      "aml",
      FIXED_EVENING_DOSE_TS,
      storage
    ),
    "met",
    FIXED_LATE_EVENING_DOSE_TS,
    storage
  );

  const states: ReadonlyArray<{
    profile: Profile;
    cameraActive: boolean;
    lastVerdict: Verdict | null;
  }> = [
    { profile: EMPTY_PROFILE, cameraActive: false, lastVerdict: null },
    { profile: DEMO_PROFILE, cameraActive: false, lastVerdict: null },
    { profile: allTakenProfile, cameraActive: false, lastVerdict: null },
    { profile: DEMO_PROFILE, cameraActive: true, lastVerdict: null },
    { profile: DEMO_PROFILE, cameraActive: false, lastVerdict: makeVerdict() },
    {
      profile: DEMO_PROFILE,
      cameraActive: false,
      lastVerdict: makeVerdict({ level: "warning", takenToday: true, headline: "Already taken today" })
    },
    {
      profile: DEMO_PROFILE,
      cameraActive: false,
      lastVerdict: makeVerdict({ level: "warning", matchedMedId: undefined, headline: "Avoid NSAIDs" })
    },
    {
      profile: DEMO_PROFILE,
      cameraActive: false,
      lastVerdict: makeVerdict({
        level: "unsure",
        read: makeLabelRead({ strength: { value: "5 mg", confidence: 0.4 } })
      })
    },
    {
      profile: DEMO_PROFILE,
      cameraActive: false,
      lastVerdict: makeVerdict({
        level: "info",
        matchedMedId: undefined,
        read: makeLabelRead({ kind: "food", strength: { value: null, confidence: 0 } })
      })
    }
  ];

  for (const lang of ["en", "fi", "sv", "de"]) {
    for (const st of states) {
      const html = renderCard({
        profile: st.profile,
        cameraActive: st.cameraActive,
        lastVerdict: st.lastVerdict,
        lang,
        now: FIXED_EVENING_NOW,
        onStartCheck: () => {},
        onLogDose: () => {},
        onRepeatVerdict: () => {}
      });
      assert.equal(html.includes(EM_DASH), false);
      assert.equal(html.includes(EN_DASH), false);
      assert.equal(html.includes(HTML_COMMENT_OPEN), false);
      assert.equal(html.includes("undefined"), false);
      assert.equal(html.includes("NaN"), false);
      assert.equal(html.includes("[object"), false);
    }
  }
});
