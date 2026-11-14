import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
  GLASSES_MIN_BATTERY_PCT,
  MIN_OFFLINE_BARCODE_DIGITS,
  PilotOnboardingCard,
  TOTAL_PILOT_STEPS,
  evaluatePilotReadiness,
  type PilotOnboardingCardProps
} from "../src/components/PilotOnboardingCard.tsx";
import { DEMO_PROFILE } from "../src/storage/profileStore.ts";
import type { DeviceState, Profile } from "../src/types.ts";

(globalThis as Record<string, unknown>).React = React;

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
const EM_DASH = "\u2014";
const EN_DASH = "\u2013";

const EMPTY_PROFILE: Profile = {
  meds: [],
  allergies: [],
  avoid: [],
  doseLog: [],
  lang: "en"
};

const PARTIAL_BARCODE_PROFILE: Profile = {
  meds: [
    {
      id: "aml",
      name: "Amlodipin",
      ingredient: "amlodipine",
      strength: "5 mg",
      schedule: ["evening"],
      barcode: "6432100012345"
    },
    {
      id: "biso",
      name: "Bisoprolol Orion",
      ingredient: "bisoprolol",
      strength: "2,5 mg",
      schedule: ["morning"]
    }
  ],
  allergies: ["peanut"],
  avoid: ["NSAIDs"],
  doseLog: [],
  lang: "fi"
};

const NO_BARCODE_PROFILE: Profile = {
  meds: [
    {
      id: "biso",
      name: "Bisoprolol Orion",
      ingredient: "bisoprolol",
      strength: "2,5 mg",
      schedule: ["morning"],
      barcode: "12345"
    }
  ],
  allergies: [],
  avoid: [],
  doseLog: [],
  lang: "en"
};

const GUARDRAILS_ONLY_PROFILE: Profile = {
  meds: [],
  allergies: ["peanut", "hazelnut"],
  avoid: ["NSAIDs"],
  doseLog: [],
  lang: "en"
};

const PHONE_DISCONNECTED_DEVICE: DeviceState = {
  connected: false,
  worn: false,
  battery: null,
  streaming: false,
  source: "phone"
};

const GLASSES_READY_DEVICE: DeviceState = {
  connected: true,
  worn: true,
  battery: 82,
  streaming: false,
  source: "glasses"
};

const GLASSES_STREAMING_DEVICE: DeviceState = {
  connected: true,
  worn: true,
  battery: 90,
  streaming: true,
  source: "glasses"
};

function renderCard(props: PilotOnboardingCardProps): string {
  return renderToStaticMarkup(createElement(PilotOnboardingCard, props));
}

function extractOpeningTagByAttr(html: string, attrName: string, attrValue: string): string {
  const escapedAttr = attrName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedVal = attrValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `<([a-z0-9]+)\\b[^>]*\\b${escapedAttr}="${escapedVal}"[^>]*>`,
    "i"
  );
  const match = pattern.exec(html);
  assert.ok(match, `Expected element with ${attrName}="${attrValue}"`);
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
  namespaceURI = `http:${SLASH}${SLASH}www.w3.org${SLASH}1999${SLASH}xhtml`;
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

  dispatchBubblingEvent(type: string): void {
    const path: MiniDomNode[] = [];
    let cursor: MiniDomNode | null = this;
    while (cursor) {
      path.push(cursor);
      cursor = cursor.parentNode;
    }

    const eventObj: {
      type: string;
      target: MiniDomNode;
      srcElement: MiniDomNode;
      currentTarget: MiniDomNode | null;
      bubbles: boolean;
      cancelable: boolean;
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
      }
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

async function withMountedCard(
  props: PilotOnboardingCardProps,
  run: (container: MiniDomNode) => Promise<void>
): Promise<void> {
  const g = globalThis as Record<string, unknown>;
  const prevWindow = g.window;
  const prevDocument = g.document;
  const prevActEnv = g.IS_REACT_ACT_ENVIRONMENT;

  const doc = new MiniDomDocument();
  const container = doc.createElement("div");
  doc.body.appendChild(container);

  class FakeIframe {}
  const winObj: Record<string, unknown> = {
    HTMLIFrameElement: FakeIframe,
    HTMLElement: MiniDomNode,
    Element: MiniDomNode,
    Node: MiniDomNode,
    document: doc,
    addEventListener: () => {},
    removeEventListener: () => {}
  };
  doc.defaultView = winObj;

  g.window = winObj;
  g.document = doc;
  g.IS_REACT_ACT_ENVIRONMENT = true;

  const root = createRoot(container as unknown as Element);

  try {
    await act(async () => {
      root.render(createElement(PilotOnboardingCard, props));
    });
    await run(container);
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
    if (prevActEnv === undefined) {
      delete g.IS_REACT_ACT_ENVIRONMENT;
    } else {
      g.IS_REACT_ACT_ENVIRONMENT = prevActEnv;
    }
  }
}

test("evaluatePilotReadiness scores 0/4 through 4/4 readiness combinations deterministically without mutating inputs", () => {
  assert.equal(TOTAL_PILOT_STEPS, 4);
  assert.equal(GLASSES_MIN_BATTERY_PCT, 15);
  assert.equal(MIN_OFFLINE_BARCODE_DIGITS, 8);

  const demoSnapshotBefore = JSON.stringify(DEMO_PROFILE);

  const zeroReady = evaluatePilotReadiness({
    consentAccepted: false,
    device: PHONE_DISCONNECTED_DEVICE,
    cameraPerm: "prompt",
    profile: EMPTY_PROFILE
  });
  assert.deepEqual(zeroReady, {
    readySteps: 0,
    totalSteps: 4,
    allReady: false,
    steps: [
      { id: "consent_accepted", done: false, detailCode: "consent_pending" },
      { id: "eye_ready", done: false, detailCode: "camera_permission_prompt" },
      { id: "profile_configured", done: false, detailCode: "profile_empty" },
      { id: "offline_barcodes_saved", done: false, detailCode: "no_meds_saved" }
    ]
  });

  const oneReady = evaluatePilotReadiness({
    consentAccepted: true,
    device: PHONE_DISCONNECTED_DEVICE,
    cameraPerm: "prompt",
    profile: EMPTY_PROFILE
  });
  assert.equal(oneReady.readySteps, 1);
  assert.equal(oneReady.totalSteps, 4);
  assert.equal(oneReady.allReady, false);
  assert.deepEqual(
    oneReady.steps.map((s) => s.done),
    [true, false, false, false]
  );

  const twoReady = evaluatePilotReadiness({
    consentAccepted: true,
    device: GLASSES_READY_DEVICE,
    cameraPerm: "prompt",
    profile: EMPTY_PROFILE
  });
  assert.equal(twoReady.readySteps, 2);
  assert.equal(twoReady.totalSteps, 4);
  assert.equal(twoReady.allReady, false);
  assert.deepEqual(
    twoReady.steps.map((s) => s.done),
    [true, true, false, false]
  );
  assert.equal(twoReady.steps[1].detailCode, "glasses_ready");

  const threeReadyPartialBarcodes = evaluatePilotReadiness({
    consentAccepted: true,
    device: GLASSES_STREAMING_DEVICE,
    cameraPerm: "prompt",
    profile: PARTIAL_BARCODE_PROFILE
  });
  assert.equal(threeReadyPartialBarcodes.readySteps, 3);
  assert.equal(threeReadyPartialBarcodes.totalSteps, 4);
  assert.equal(threeReadyPartialBarcodes.allReady, false);
  assert.deepEqual(threeReadyPartialBarcodes.steps, [
    { id: "consent_accepted", done: true, detailCode: "consent_accepted" },
    { id: "eye_ready", done: true, detailCode: "glasses_streaming" },
    { id: "profile_configured", done: true, detailCode: "meds_configured" },
    { id: "offline_barcodes_saved", done: false, detailCode: "barcodes_partial" }
  ]);

  const threeReadyMissingAllBarcodes = evaluatePilotReadiness({
    consentAccepted: true,
    device: PHONE_DISCONNECTED_DEVICE,
    cameraPerm: "granted",
    profile: NO_BARCODE_PROFILE
  });
  assert.equal(threeReadyMissingAllBarcodes.readySteps, 3);
  assert.equal(threeReadyMissingAllBarcodes.allReady, false);
  assert.equal(threeReadyMissingAllBarcodes.steps[2].detailCode, "meds_configured");
  assert.equal(threeReadyMissingAllBarcodes.steps[3].detailCode, "barcodes_missing");

  const threeReadyGuardrailsOnly = evaluatePilotReadiness({
    consentAccepted: true,
    device: PHONE_DISCONNECTED_DEVICE,
    cameraPerm: "granted",
    profile: GUARDRAILS_ONLY_PROFILE
  });
  assert.equal(threeReadyGuardrailsOnly.readySteps, 3);
  assert.equal(threeReadyGuardrailsOnly.allReady, false);
  assert.equal(threeReadyGuardrailsOnly.steps[2].detailCode, "guardrails_only");
  assert.equal(threeReadyGuardrailsOnly.steps[3].detailCode, "no_meds_saved");

  const threeReadyConsentPending = evaluatePilotReadiness({
    consentAccepted: false,
    device: GLASSES_READY_DEVICE,
    cameraPerm: "denied",
    profile: DEMO_PROFILE
  });
  assert.equal(threeReadyConsentPending.readySteps, 3);
  assert.equal(threeReadyConsentPending.allReady, false);
  assert.deepEqual(
    threeReadyConsentPending.steps.map((s) => s.done),
    [false, true, true, true]
  );

  const fourReady = evaluatePilotReadiness({
    consentAccepted: true,
    device: GLASSES_STREAMING_DEVICE,
    cameraPerm: "denied",
    profile: DEMO_PROFILE
  });
  assert.deepEqual(fourReady, {
    readySteps: 4,
    totalSteps: 4,
    allReady: true,
    steps: [
      { id: "consent_accepted", done: true, detailCode: "consent_accepted" },
      { id: "eye_ready", done: true, detailCode: "glasses_streaming" },
      { id: "profile_configured", done: true, detailCode: "meds_configured" },
      { id: "offline_barcodes_saved", done: true, detailCode: "all_barcodes_saved" }
    ]
  });

  assert.equal(JSON.stringify(DEMO_PROFILE), demoSnapshotBefore);
});

test("evaluatePilotReadiness distinguishes DAT glasses readiness vs phone camera fallback across worn, battery, and permission states", () => {
  const glassesExactFloor = evaluatePilotReadiness({
    consentAccepted: true,
    device: { connected: true, worn: true, battery: 15, streaming: false, source: "glasses" },
    cameraPerm: "denied",
    profile: DEMO_PROFILE
  });
  assert.equal(glassesExactFloor.steps[1].done, true);
  assert.equal(glassesExactFloor.steps[1].detailCode, "glasses_ready");
  assert.equal(glassesExactFloor.allReady, true);

  const glassesNullBattery = evaluatePilotReadiness({
    consentAccepted: true,
    device: { connected: true, worn: true, battery: null, streaming: true, source: "glasses" },
    cameraPerm: "unavailable",
    profile: DEMO_PROFILE
  });
  assert.equal(glassesNullBattery.steps[1].done, true);
  assert.equal(glassesNullBattery.steps[1].detailCode, "glasses_streaming");

  const glassesLowBatteryNoPhone = evaluatePilotReadiness({
    consentAccepted: true,
    device: { connected: true, worn: true, battery: 14, streaming: false, source: "phone" },
    cameraPerm: "prompt",
    profile: DEMO_PROFILE
  });
  assert.equal(glassesLowBatteryNoPhone.steps[1].done, false);
  assert.equal(glassesLowBatteryNoPhone.steps[1].detailCode, "glasses_low_battery");
  assert.equal(glassesLowBatteryNoPhone.readySteps, 3);

  const glassesLowBatteryWithPhone = evaluatePilotReadiness({
    consentAccepted: true,
    device: { connected: true, worn: true, battery: 9, streaming: false, source: "phone" },
    cameraPerm: "granted",
    profile: DEMO_PROFILE
  });
  assert.equal(glassesLowBatteryWithPhone.steps[1].done, true);
  assert.equal(glassesLowBatteryWithPhone.steps[1].detailCode, "phone_fallback_low_battery");
  assert.equal(glassesLowBatteryWithPhone.allReady, true);

  const glassesDoffedNoPhone = evaluatePilotReadiness({
    consentAccepted: true,
    device: { connected: true, worn: false, battery: 75, streaming: false, source: "phone" },
    cameraPerm: "denied",
    profile: DEMO_PROFILE
  });
  assert.equal(glassesDoffedNoPhone.steps[1].done, false);
  assert.equal(glassesDoffedNoPhone.steps[1].detailCode, "glasses_not_worn");

  const glassesDoffedWithPhone = evaluatePilotReadiness({
    consentAccepted: true,
    device: { connected: true, worn: false, battery: 75, streaming: false, source: "phone" },
    cameraPerm: "  GRANTED  ",
    profile: DEMO_PROFILE
  });
  assert.equal(glassesDoffedWithPhone.steps[1].done, true);
  assert.equal(glassesDoffedWithPhone.steps[1].detailCode, "phone_fallback_doffed");

  const phoneOnlyGranted = evaluatePilotReadiness({
    consentAccepted: true,
    device: PHONE_DISCONNECTED_DEVICE,
    cameraPerm: "granted",
    profile: DEMO_PROFILE
  });
  assert.equal(phoneOnlyGranted.steps[1].done, true);
  assert.equal(phoneOnlyGranted.steps[1].detailCode, "phone_camera_ready");
  assert.equal(phoneOnlyGranted.allReady, true);

  const phoneOnlyDenied = evaluatePilotReadiness({
    consentAccepted: true,
    device: PHONE_DISCONNECTED_DEVICE,
    cameraPerm: "denied",
    profile: DEMO_PROFILE
  });
  assert.equal(phoneOnlyDenied.steps[1].done, false);
  assert.equal(phoneOnlyDenied.steps[1].detailCode, "camera_permission_denied");

  const phoneOnlyUnavailable = evaluatePilotReadiness({
    consentAccepted: true,
    device: PHONE_DISCONNECTED_DEVICE,
    cameraPerm: "unavailable",
    profile: DEMO_PROFILE
  });
  assert.equal(phoneOnlyUnavailable.steps[1].done, false);
  assert.equal(phoneOnlyUnavailable.steps[1].detailCode, "camera_unavailable");
});

test("PilotOnboardingCard SSR renders accessible section, role=progressbar, and 4 check/pending rows with aria-hidden SVGs", () => {
  const zeroHtml = renderCard({
    consentAccepted: false,
    device: PHONE_DISCONNECTED_DEVICE,
    cameraPerm: "prompt",
    profile: EMPTY_PROFILE,
    lang: "en"
  });

  assert.match(
    zeroHtml,
    /^<section\b[^>]*aria-labelledby="pilot-onboarding-card-heading"[^>]*lang="en"/
  );
  assert.match(
    zeroHtml,
    /<h2\b[^>]*id="pilot-onboarding-card-heading"[^>]*>3-Minute Community Pilot &amp; Counter Onboarding<\/h2>/
  );
  assert.ok(zeroHtml.includes('data-ready-steps="0"'));
  assert.ok(zeroHtml.includes('data-total-steps="4"'));
  assert.ok(zeroHtml.includes('data-all-ready="false"'));
  assert.ok(zeroHtml.includes("0/4 Setup Pending"));

  const zeroProgressTag = extractOpeningTagByAttr(zeroHtml, "data-pilot-progressbar", "true");
  assert.ok(zeroProgressTag.includes('role="progressbar"'));
  assert.ok(zeroProgressTag.includes('aria-valuemin="0"'));
  assert.ok(zeroProgressTag.includes('aria-valuemax="4"'));
  assert.ok(zeroProgressTag.includes('aria-valuenow="0"'));
  assert.ok(zeroProgressTag.includes('aria-valuetext="0 of 4 onboarding steps complete"'));

  for (const stepId of [
    "consent_accepted",
    "eye_ready",
    "profile_configured",
    "offline_barcodes_saved"
  ] as const) {
    const rowTag = extractOpeningTagByAttr(zeroHtml, "data-step-id", stepId);
    assert.ok(rowTag.includes('data-step-done="false"'));
  }

  const fullHtml = renderCard({
    consentAccepted: true,
    device: GLASSES_STREAMING_DEVICE,
    cameraPerm: "denied",
    profile: DEMO_PROFILE,
    lang: "en"
  });

  assert.ok(fullHtml.includes('data-ready-steps="4"'));
  assert.ok(fullHtml.includes('data-all-ready="true"'));
  assert.ok(fullHtml.includes("4/4 Pilot Ready"));
  assert.ok(fullHtml.includes("4/4 (100%)"));

  const fullProgressTag = extractOpeningTagByAttr(fullHtml, "data-pilot-progressbar", "true");
  assert.ok(fullProgressTag.includes('aria-valuenow="4"'));
  assert.ok(
    fullProgressTag.includes(
      'aria-valuetext="4 of 4 onboarding steps complete, ready for active checks"'
    )
  );

  for (const stepId of [
    "consent_accepted",
    "eye_ready",
    "profile_configured",
    "offline_barcodes_saved"
  ] as const) {
    const rowTag = extractOpeningTagByAttr(fullHtml, "data-step-id", stepId);
    assert.ok(rowTag.includes('data-step-done="true"'));
  }

  const svgs = fullHtml.match(/<svg\b[^>]*>/gi) ?? [];
  assert.ok(svgs.length >= 6);
  for (const svgTag of svgs) {
    assert.ok(svgTag.includes('aria-hidden="true"'), `SVG must declare aria-hidden="true": ${svgTag}`);
  }
});

test("PilotOnboardingCard localizes across en, fi, and sv with regional variants and de fallback to en", () => {
  const makeProps = (lang: string): PilotOnboardingCardProps => ({
    consentAccepted: true,
    device: GLASSES_READY_DEVICE,
    cameraPerm: "prompt",
    profile: PARTIAL_BARCODE_PROFILE,
    lang,
    onOpenConsent: () => {},
    onOpenPharmacyQr: () => {},
    onStartDemoTour: () => {}
  });

  const enHtml = renderCard(makeProps("en"));
  const fiHtml = renderCard(makeProps("fi"));
  const svHtml = renderCard(makeProps("sv"));
  const fiRegionalHtml = renderCard(makeProps("fi-FI"));
  const svRegionalHtml = renderCard(makeProps("sv-SE"));
  const deFallbackHtml = renderCard(makeProps("de"));

  assert.notEqual(enHtml, fiHtml);
  assert.notEqual(enHtml, svHtml);
  assert.notEqual(fiHtml, svHtml);
  assert.equal(fiRegionalHtml, fiHtml);
  assert.equal(svRegionalHtml, svHtml);
  assert.equal(deFallbackHtml, enHtml);

  assert.ok(enHtml.includes('lang="en"'));
  assert.ok(enHtml.includes("3/4 Steps Ready"));
  assert.ok(enHtml.includes("READY"));
  assert.ok(enHtml.includes("PENDING"));
  assert.ok(enHtml.includes("Review Consent"));
  assert.ok(enHtml.includes("Import Pharmacy QR"));
  assert.ok(enHtml.includes("Run Safety Drill"));
  assert.ok(enHtml.includes("Not a medical device. Always confirm uncertain labels with a pharmacist."));

  assert.ok(fiHtml.includes('lang="fi"'));
  assert.ok(fiHtml.includes("3 minuutin pilotti- ja apteekkiperehdytys"));
  assert.ok(fiHtml.includes("3/4 vaihetta valmiina"));
  assert.ok(fiHtml.includes("VALMIS"));
  assert.ok(fiHtml.includes("ODOTTAA"));
  assert.ok(fiHtml.includes("Tarkista suostumus"));
  assert.ok(fiHtml.includes("Tuo apteekin QR"));
  assert.ok(fiHtml.includes("Aja turvaharjoitus"));
  assert.ok(fiHtml.includes("Ei lääkinnällinen laite. Varmista epävarmat pakkaukset aina apteekista."));

  assert.ok(svHtml.includes('lang="sv"'));
  assert.ok(svHtml.includes("3-minuters pilot- och apoteksintroduktion"));
  assert.ok(svHtml.includes("3/4 steg klara"));
  assert.ok(svHtml.includes("KLAR"));
  assert.ok(svHtml.includes("VÄNTAR"));
  assert.ok(svHtml.includes("Granska samtycke"));
  assert.ok(svHtml.includes("Importera apoteks-QR"));
  assert.ok(svHtml.includes("Kör säkerhetsövning"));
  assert.ok(
    svHtml.includes(
      "Inte en medicinteknisk produkt. Kontrollera alltid osäkra etiketter med apotekspersonal."
    )
  );
});

test("Action buttons render >= 56px targets only when callbacks are supplied and invoke handlers on DOM click", async () => {
  const noCallbacksHtml = renderCard({
    consentAccepted: true,
    device: GLASSES_READY_DEVICE,
    cameraPerm: "granted",
    profile: DEMO_PROFILE,
    lang: "en"
  });
  assert.equal(noCallbacksHtml.includes("<button"), false);

  const singleCallbackHtml = renderCard({
    consentAccepted: false,
    device: PHONE_DISCONNECTED_DEVICE,
    cameraPerm: "prompt",
    profile: EMPTY_PROFILE,
    lang: "en",
    onOpenConsent: () => {}
  });
  assert.ok(singleCallbackHtml.includes('data-action="open-consent"'));
  assert.equal(singleCallbackHtml.includes('data-action="open-pharmacy-qr"'), false);
  assert.equal(singleCallbackHtml.includes('data-action="start-demo-tour"'), false);

  const allCallbacksHtml = renderCard({
    consentAccepted: true,
    device: GLASSES_READY_DEVICE,
    cameraPerm: "granted",
    profile: DEMO_PROFILE,
    lang: "en",
    onOpenConsent: () => {},
    onOpenPharmacyQr: () => {},
    onStartDemoTour: () => {}
  });

  for (const actionId of ["open-consent", "open-pharmacy-qr", "start-demo-tour"] as const) {
    const btnTag = extractOpeningTagByAttr(allCallbacksHtml, "data-action", actionId);
    assert.ok(btnTag.startsWith("<button"), `${actionId} must be a <button>`);
    assert.ok(btnTag.includes('type="button"'), `${actionId} must declare type="button"`);
    assert.ok(btnTag.includes("aria-label="), `${actionId} must expose aria-label`);
    const minHeightMatch = /min-height:(\d+)px/.exec(btnTag);
    const minWidthMatch = /min-width:(\d+)px/.exec(btnTag);
    assert.ok(minHeightMatch, `${actionId} must set min-height in px`);
    assert.ok(minWidthMatch, `${actionId} must set min-width in px`);
    assert.ok(Number.parseInt(minHeightMatch[1], 10) >= 56, `${actionId} min-height must be >= 56px`);
    assert.ok(Number.parseInt(minWidthMatch[1], 10) >= 56, `${actionId} min-width must be >= 56px`);
  }

  for (const locale of ["en", "fi", "sv"] as const) {
    let consentCalls = 0;
    let pharmacyQrCalls = 0;
    let demoTourCalls = 0;

    await withMountedCard(
      {
        consentAccepted: false,
        device: GLASSES_READY_DEVICE,
        cameraPerm: "prompt",
        profile: PARTIAL_BARCODE_PROFILE,
        lang: locale,
        onOpenConsent: () => {
          consentCalls += 1;
        },
        onOpenPharmacyQr: () => {
          pharmacyQrCalls += 1;
        },
        onStartDemoTour: () => {
          demoTourCalls += 1;
        }
      },
      async (container) => {
        const consentBtn = container.findByAttr("data-action", "open-consent");
        const pharmacyBtn = container.findByAttr("data-action", "open-pharmacy-qr");
        const tourBtn = container.findByAttr("data-action", "start-demo-tour");
        assert.ok(consentBtn, `Expected open-consent button in ${locale}`);
        assert.ok(pharmacyBtn, `Expected open-pharmacy-qr button in ${locale}`);
        assert.ok(tourBtn, `Expected start-demo-tour button in ${locale}`);

        await act(async () => {
          consentBtn.dispatchBubblingEvent("click");
        });
        assert.equal(consentCalls, 1);
        assert.equal(pharmacyQrCalls, 0);
        assert.equal(demoTourCalls, 0);

        await act(async () => {
          pharmacyBtn.dispatchBubblingEvent("click");
        });
        assert.equal(consentCalls, 1);
        assert.equal(pharmacyQrCalls, 1);
        assert.equal(demoTourCalls, 0);

        await act(async () => {
          tourBtn.dispatchBubblingEvent("click");
        });
        assert.equal(consentCalls, 1);
        assert.equal(pharmacyQrCalls, 1);
        assert.equal(demoTourCalls, 1);
      }
    );
  }
});

test("PilotOnboardingCard and test suite contain zero code comments, zero em/en dashes, and zero SSR leaks", () => {
  const componentSource = readFileSync(
    new URL("../src/components/PilotOnboardingCard.tsx", import.meta.url),
    "utf8"
  );
  const testSource = readFileSync(
    new URL("./pilotOnboardingCard.test.ts", import.meta.url),
    "utf8"
  );

  for (const [label, source] of [
    ["PilotOnboardingCard.tsx", componentSource],
    ["pilotOnboardingCard.test.ts", testSource]
  ] as const) {
    assert.equal(source.includes(LINE_COMMENT), false, `${label} must not contain line comments`);
    assert.equal(
      source.includes(BLOCK_COMMENT_OPEN),
      false,
      `${label} must not contain block comments`
    );
    assert.equal(
      source.includes(BLOCK_COMMENT_CLOSE),
      false,
      `${label} must not contain block comment closures`
    );
    assert.equal(source.includes(HTML_COMMENT_OPEN), false, `${label} must not contain HTML comments`);
    assert.equal(source.includes(EM_DASH), false, `${label} must not contain em dashes`);
    assert.equal(source.includes(EN_DASH), false, `${label} must not contain en dashes`);
  }

  const dashInjectedProfile: Profile = {
    meds: [
      {
        id: `med${EM_DASH}1`,
        name: `Amlodipin ${EM_DASH} Evening`,
        ingredient: "amlodipine",
        strength: `5${EN_DASH}10 mg`,
        schedule: ["evening"],
        barcode: "6432100012345"
      }
    ],
    allergies: [`peanut${EM_DASH}trace`],
    avoid: [`NSAIDs${EN_DASH}all`],
    doseLog: [],
    lang: "en"
  };

  const devices: readonly DeviceState[] = [
    PHONE_DISCONNECTED_DEVICE,
    GLASSES_READY_DEVICE,
    GLASSES_STREAMING_DEVICE,
    { connected: true, worn: false, battery: 50, streaming: false, source: "phone" },
    { connected: true, worn: true, battery: 8, streaming: false, source: "phone" }
  ];
  const perms = ["prompt", "granted", "denied", "unavailable"] as const;
  const profiles = [
    EMPTY_PROFILE,
    PARTIAL_BARCODE_PROFILE,
    NO_BARCODE_PROFILE,
    GUARDRAILS_ONLY_PROFILE,
    DEMO_PROFILE,
    dashInjectedProfile
  ] as const;

  for (const locale of ["en", "fi", "sv", "de"]) {
    for (const device of devices) {
      for (const cameraPerm of perms) {
        for (const profile of profiles) {
          const html = renderCard({
            consentAccepted: locale !== "de",
            device,
            cameraPerm,
            profile,
            lang: locale,
            onOpenConsent: () => {},
            onOpenPharmacyQr: () => {},
            onStartDemoTour: () => {}
          });
          assert.equal(html.includes("undefined"), false);
          assert.equal(html.includes("NaN"), false);
          assert.equal(html.includes("[object"), false);
          assert.equal(html.includes(HTML_COMMENT_OPEN), false);
          assert.equal(html.includes(EM_DASH), false);
          assert.equal(html.includes(EN_DASH), false);

          const svgOpenings = html.match(/<svg\b[^>]*>/gi) ?? [];
          assert.ok(svgOpenings.length >= 9);
          for (const svgTag of svgOpenings) {
            assert.ok(svgTag.includes('aria-hidden="true"'), `SVG must be aria-hidden: ${svgTag}`);
          }
        }
      }
    }
  }
});
