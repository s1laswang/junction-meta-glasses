import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
  EmergencyMedCard,
  formatEmergencyWalletText,
  type EmergencyMedCardProps
} from "../src/components/EmergencyMedCard.tsx";
import { DEMO_PROFILE } from "../src/storage/profileStore.ts";
import type { Med, Profile } from "../src/types.ts";

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

const EM_DASH = "\u2014";
const EN_DASH = "\u2013";
const LINE_COMMENT = "\x2f\x2f";
const BLOCK_COMMENT_OPEN = "\x2f*";
const BLOCK_COMMENT_CLOSE = "*\x2f";

const EMPTY_PROFILE: Profile = {
  meds: [],
  allergies: [],
  avoid: [],
  doseLog: [],
  lang: "en"
};

function renderCard(props: EmergencyMedCardProps): string {
  return renderToStaticMarkup(createElement(EmergencyMedCard, props));
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
  namespaceURI = "http:\x2f\x2fwww.w3.org\x2f1999\x2fxhtml";
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
  props: EmergencyMedCardProps,
  envOverrides: {
    clipboardWrite?: (text: string) => Promise<void>;
    windowPrint?: () => void;
  },
  run: (container: MiniDomNode) => Promise<void>
): Promise<void> {
  const g = globalThis as Record<string, unknown>;
  const prevWindow = g.window;
  const prevDocument = g.document;
  const prevActEnv = g.IS_REACT_ACT_ENVIRONMENT;
  const prevNavigatorDesc = Object.getOwnPropertyDescriptor(globalThis, "navigator");

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
  if (envOverrides.windowPrint) {
    winObj.print = envOverrides.windowPrint;
  }
  doc.defaultView = winObj;

  g.window = winObj;
  g.document = doc;
  g.IS_REACT_ACT_ENVIRONMENT = true;

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: envOverrides.clipboardWrite
      ? { clipboard: { writeText: envOverrides.clipboardWrite } }
      : {}
  });

  const root = createRoot(container as unknown as Element);

  try {
    await act(async () => {
      root.render(createElement(EmergencyMedCard, props));
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
    if (prevNavigatorDesc) {
      Object.defineProperty(globalThis, "navigator", prevNavigatorDesc);
    } else {
      delete g.navigator;
    }
  }
}

test("formatEmergencyWalletText formats DEMO_PROFILE prescriptions, allergies, avoid rules, and user-maintained on-device notice", () => {
  const snapshotBefore = JSON.stringify(DEMO_PROFILE);
  const text = formatEmergencyWalletText(DEMO_PROFILE, "en");
  assert.equal(JSON.stringify(DEMO_PROFILE), snapshotBefore);
  assert.equal(formatEmergencyWalletText(DEMO_PROFILE, "en"), text);

  assert.ok(text.includes("HoldUp Emergency Medication & Allergy Wallet Summary"));
  assert.ok(text.includes("User-maintained on-device profile"));
  assert.ok(text.includes("zero cloud upload"));

  assert.ok(text.includes("Drug & Food Allergies (2): peanut, tree nuts"));
  assert.ok(text.includes("Avoid Drug Classes & Ingredients (1): NSAIDs"));
  assert.ok(text.includes("Active Medications (3 total, 2 scheduled):"));

  assert.ok(
    text.includes(
      "1. Amlodipin | Active ingredient: amlodipine | Strength: 5 mg | Schedule: evening"
    )
  );
  assert.ok(
    text.includes(
      "2. Metformin | Active ingredient: metformin | Strength: 500 mg | Schedule: morning, evening"
    )
  );
  assert.ok(
    text.includes(
      "3. Panadol | Active ingredient: paracetamol | Strength: 500 mg | Schedule: as needed"
    )
  );

  assert.ok(text.includes("User-maintained on-device data only."));
  assert.ok(
    text.includes("Not a medical device. Always confirm uncertain labels with a pharmacist.")
  );

  const aliasMed = {
    id: "thy",
    name: "Thyroxin",
    ingredient: "",
    activeIngredient: "levothyroxine",
    strength: "50 mcg",
    schedule: [],
    times: ["morning", "20:00"]
  } as unknown as Med;

  const aliasText = formatEmergencyWalletText(
    {
      meds: [aliasMed],
      allergies: ["penicillin", "Penicillin"],
      avoid: ["statins"],
      doseLog: [],
      lang: "en"
    },
    "en"
  );
  assert.ok(aliasText.includes("Drug & Food Allergies (1): penicillin"));
  assert.ok(aliasText.includes("Avoid Drug Classes & Ingredients (1): statins"));
  assert.ok(aliasText.includes("Active Medications (1 total, 1 scheduled):"));
  assert.ok(
    aliasText.includes(
      "1. Thyroxin | Active ingredient: levothyroxine | Strength: 50 mcg | Schedule: morning, 20:00"
    )
  );
});

test("formatEmergencyWalletText handles empty profiles cleanly across en, fi, and sv with en fallback", () => {
  const enEmpty = formatEmergencyWalletText(EMPTY_PROFILE, "en");
  const fiEmpty = formatEmergencyWalletText(EMPTY_PROFILE, "fi");
  const svEmpty = formatEmergencyWalletText(EMPTY_PROFILE, "sv");
  const deFallback = formatEmergencyWalletText(EMPTY_PROFILE, "de-DE");

  assert.equal(deFallback, enEmpty);
  assert.notEqual(enEmpty, fiEmpty);
  assert.notEqual(enEmpty, svEmpty);
  assert.notEqual(fiEmpty, svEmpty);

  assert.ok(enEmpty.includes("Drug & Food Allergies (0): None recorded on this device"));
  assert.ok(enEmpty.includes("Avoid Drug Classes & Ingredients (0): None recorded on this device"));
  assert.ok(enEmpty.includes("Active Medications (0 total, 0 scheduled):"));

  assert.ok(fiEmpty.includes("Lääke- ja ruoka-allergiat (0): Ei tallennettuja tietoja tällä laitteella"));
  assert.ok(fiEmpty.includes("Vältettävät lääkeluokat ja aineet (0): Ei tallennettuja tietoja tällä laitteella"));
  assert.ok(fiEmpty.includes("Käytössä olevat lääkkeet (0 yhteensä, 0 säännöllistä):"));
  assert.ok(fiEmpty.includes("Käyttäjän itse laitteella ylläpitämä profiili"));

  assert.ok(svEmpty.includes("Läkemedels- och matallergier (0): Inga registrerade uppgifter på den här enheten"));
  assert.ok(svEmpty.includes("Läkemedelsklasser och ämnen att undvika (0): Inga registrerade uppgifter på den här enheten"));
  assert.ok(svEmpty.includes("Aktiva läkemedel (0 totalt, 0 schemalagda):"));
  assert.ok(svEmpty.includes("Användarunderhållen profil på enheten"));
});

test("Localizes formatEmergencyWalletText and EmergencyMedCard across en, fi, and sv with en fallback", () => {
  const enText = formatEmergencyWalletText(DEMO_PROFILE, "en");
  const fiText = formatEmergencyWalletText(DEMO_PROFILE, "fi-FI");
  const svText = formatEmergencyWalletText(DEMO_PROFILE, "sv-SE");
  const frFallbackText = formatEmergencyWalletText(DEMO_PROFILE, "fr");

  assert.equal(frFallbackText, enText);
  assert.ok(fiText.includes("1. Amlodipin | Vaikuttava aine: amlodipine | Vahvuus: 5 mg | Ottoajat: ilta"));
  assert.ok(fiText.includes("2. Metformin | Vaikuttava aine: metformin | Vahvuus: 500 mg | Ottoajat: aamu, ilta"));
  assert.ok(fiText.includes("3. Panadol | Vaikuttava aine: paracetamol | Vahvuus: 500 mg | Ottoajat: tarvittaessa"));
  assert.ok(fiText.includes("Ei lääkinnällinen laite. Varmista epävarmat pakkaukset aina apteekista."));

  assert.ok(svText.includes("1. Amlodipin | Aktiv substans: amlodipine | Styrka: 5 mg | Tider: kväll"));
  assert.ok(svText.includes("2. Metformin | Aktiv substans: metformin | Styrka: 500 mg | Tider: morgon, kväll"));
  assert.ok(svText.includes("3. Panadol | Aktiv substans: paracetamol | Styrka: 500 mg | Tider: vid behov"));
  assert.ok(
    svText.includes(
      "Inte en medicinteknisk produkt. Kontrollera alltid osäkra etiketter med apotekspersonal."
    )
  );

  const enHtml = renderCard({ profile: DEMO_PROFILE, lang: "en" });
  const fiHtml = renderCard({ profile: DEMO_PROFILE, lang: "fi" });
  const svHtml = renderCard({ profile: DEMO_PROFILE, lang: "sv" });
  const fiRegionalHtml = renderCard({ profile: DEMO_PROFILE, lang: "fi-FI" });
  const svRegionalHtml = renderCard({ profile: DEMO_PROFILE, lang: "sv-SE" });
  const deFallbackHtml = renderCard({ profile: DEMO_PROFILE, lang: "de" });

  assert.notEqual(enHtml, fiHtml);
  assert.notEqual(enHtml, svHtml);
  assert.notEqual(fiHtml, svHtml);
  assert.equal(fiRegionalHtml, fiHtml);
  assert.equal(svRegionalHtml, svHtml);
  assert.equal(deFallbackHtml, enHtml);

  assert.ok(enHtml.includes('lang="en"'));
  assert.ok(enHtml.includes("Emergency Medication &amp; Allergy Wallet Card"));
  assert.ok(enHtml.includes("<span>Copy Wallet Text</span>"));
  assert.ok(enHtml.includes("<span>Print Wallet Card</span>"));

  assert.ok(fiHtml.includes('lang="fi"'));
  assert.ok(fiHtml.includes("Hätä- ja apteekkilääkekortti"));
  assert.ok(fiHtml.includes("Allergiat: 2"));
  assert.ok(fiHtml.includes("Estosäännöt: 1"));
  assert.ok(fiHtml.includes("Säännölliset lääkkeet: 2 (+1 tarvittaessa)"));
  assert.ok(fiHtml.includes("<span>Kopioi lääkekortin teksti</span>"));
  assert.ok(fiHtml.includes("<span>Tulosta lääkekortti</span>"));

  assert.ok(svHtml.includes('lang="sv"'));
  assert.ok(svHtml.includes("Akut läkemedels- och allergikort"));
  assert.ok(svHtml.includes("Allergier: 2"));
  assert.ok(svHtml.includes("Undvikanderegler: 1"));
  assert.ok(svHtml.includes("Schemalagda läkemedel: 2 (+1 vid behov)"));
  assert.ok(svHtml.includes("<span>Kopiera korttext</span>"));
  assert.ok(svHtml.includes("<span>Skriv ut läkemedelskort</span>"));
});

test("EmergencyMedCard SSR renders accessible section, high-contrast badges, structured dl/ul summary, >= 56px buttons, polite ARIA live region, and privacy notice", () => {
  const html = renderCard({
    profile: DEMO_PROFILE,
    lang: "en"
  });

  assert.match(html, /^<section\b[^>]*class="card emergency-med-card"[^>]*lang="en"/);
  assert.match(html, /aria-labelledby="[^"]+-emergency-wallet-heading"/);
  assert.ok(html.includes("@media print"));

  const liveStatusTag = extractOpeningTagByAttr(html, "data-wallet-live-status", "true");
  assert.ok(liveStatusTag.includes('role="status"'));
  assert.ok(liveStatusTag.includes('aria-live="polite"'));
  assert.ok(liveStatusTag.includes('aria-atomic="true"'));

  const allergiesBadge = extractOpeningTagByAttr(html, "data-wallet-badge", "allergies");
  assert.ok(allergiesBadge.includes('data-count="2"'));
  assert.ok(html.includes("<span>Allergies: 2</span>"));

  const avoidBadge = extractOpeningTagByAttr(html, "data-wallet-badge", "avoid");
  assert.ok(avoidBadge.includes('data-count="1"'));
  assert.ok(html.includes("<span>Avoid Rules: 1</span>"));

  const scheduledBadge = extractOpeningTagByAttr(html, "data-wallet-badge", "scheduled-meds");
  assert.ok(scheduledBadge.includes('data-count="2"'));
  assert.ok(scheduledBadge.includes('data-total-meds="3"'));
  assert.ok(html.includes("<span>Scheduled Medications: 2 (+1 as needed)</span>"));

  assert.ok(html.includes('<dl aria-label="Emergency allergy, avoid-rule, and source summary"'));
  assert.ok(html.includes("<dt"));
  assert.ok(html.includes("<dd"));
  assert.ok(html.includes('class="emergency-allergy-list"'));
  assert.ok(html.includes('class="emergency-avoid-list"'));
  assert.ok(html.includes('class="emergency-med-list"'));
  assert.ok(html.includes('class="emergency-med-dl"'));
  assert.ok(html.includes("Amlodipin 5 mg"));
  assert.ok(html.includes("Metformin 500 mg"));
  assert.ok(html.includes("Panadol 500 mg"));

  const copyBtnTag = extractOpeningTagByAttr(html, "data-action", "copy-wallet-text");
  const printBtnTag = extractOpeningTagByAttr(html, "data-action", "print-wallet-card");

  for (const [label, btnTag] of [
    ["copy-wallet-text", copyBtnTag],
    ["print-wallet-card", printBtnTag]
  ] as const) {
    assert.ok(btnTag.startsWith("<button"), `${label} must be a <button>`);
    assert.ok(btnTag.includes('type="button"'), `${label} must declare type="button"`);
    assert.ok(btnTag.includes("aria-label="), `${label} must include aria-label`);
    const minHeightMatch = /min-height:(\d+)px/.exec(btnTag);
    const minWidthMatch = /min-width:(\d+)px/.exec(btnTag);
    assert.ok(minHeightMatch, `${label} must declare min-height in px`);
    assert.ok(minWidthMatch, `${label} must declare min-width in px`);
    assert.ok(Number.parseInt(minHeightMatch[1], 10) >= 56, `${label} min-height must be >= 56px`);
    assert.ok(Number.parseInt(minWidthMatch[1], 10) >= 56, `${label} min-width must be >= 56px`);
  }

  assert.match(
    html,
    /role="note"[^>]*class="emergency-privacy-notice"|class="emergency-privacy-notice"[^>]*role="note"/
  );
  assert.ok(html.includes("100% On-Device / Zero Cloud"));
  assert.ok(html.includes("zero server or cloud upload"));

  const emptyHtml = renderCard({
    profile: EMPTY_PROFILE,
    lang: "en"
  });
  assert.ok(emptyHtml.includes("<span>Allergies: 0</span>"));
  assert.ok(emptyHtml.includes("<span>Avoid Rules: 0</span>"));
  assert.ok(emptyHtml.includes("<span>Scheduled Medications: 0</span>"));
  assert.ok(emptyHtml.includes("No medications recorded on this device."));
});

test("EmergencyMedCard Copy Wallet Text and Print Wallet Card buttons fire callbacks, fallbacks, and polite ARIA feedback", async () => {
  for (const locale of ["en", "fi", "sv"] as const) {
    const copiedPayloads: string[] = [];
    let printCalls = 0;
    let windowPrintCalls = 0;

    await withMountedCard(
      {
        profile: DEMO_PROFILE,
        lang: locale,
        onCopyText: (text) => copiedPayloads.push(text),
        onPrint: () => {
          printCalls += 1;
        }
      },
      {
        windowPrint: () => {
          windowPrintCalls += 1;
        }
      },
      async (container) => {
        const liveStatus = container.findByAttr("data-wallet-live-status", "true");
        const copyBtn = container.findByAttr("data-action", "copy-wallet-text");
        const printBtn = container.findByAttr("data-action", "print-wallet-card");

        assert.ok(liveStatus, "Expected polite ARIA live status node");
        assert.ok(copyBtn, "Expected Copy Wallet Text button");
        assert.ok(printBtn, "Expected Print Wallet Card button");
        assert.equal(liveStatus.textContent, "");

        await act(async () => {
          copyBtn.dispatchBubblingEvent("click");
        });

        assert.deepEqual(copiedPayloads, [formatEmergencyWalletText(DEMO_PROFILE, locale)]);
        assert.ok(liveStatus.textContent.length > 15, `Expected polite copy feedback in ${locale}`);

        await act(async () => {
          printBtn.dispatchBubblingEvent("click");
        });

        assert.equal(printCalls, 1);
        assert.equal(windowPrintCalls, 0);
        assert.ok(liveStatus.textContent.length > 15, `Expected polite print feedback in ${locale}`);
      }
    );
  }

  const clipboardPayloads: string[] = [];
  let fallbackWindowPrintCalls = 0;

  await withMountedCard(
    {
      profile: DEMO_PROFILE,
      lang: "en"
    },
    {
      clipboardWrite: async (text) => {
        clipboardPayloads.push(text);
      },
      windowPrint: () => {
        fallbackWindowPrintCalls += 1;
      }
    },
    async (container) => {
      const liveStatus = container.findByAttr("data-wallet-live-status", "true");
      const copyBtn = container.findByAttr("data-action", "copy-wallet-text");
      const printBtn = container.findByAttr("data-action", "print-wallet-card");
      assert.ok(liveStatus && copyBtn && printBtn);

      await act(async () => {
        copyBtn.dispatchBubblingEvent("click");
      });

      assert.deepEqual(clipboardPayloads, [formatEmergencyWalletText(DEMO_PROFILE, "en")]);
      assert.equal(
        liveStatus.textContent,
        "Copied emergency medication and allergy wallet summary to clipboard."
      );

      await act(async () => {
        printBtn.dispatchBubblingEvent("click");
      });

      assert.equal(fallbackWindowPrintCalls, 1);
    }
  );

  await withMountedCard(
    {
      profile: EMPTY_PROFILE,
      lang: "en"
    },
    {},
    async (container) => {
      const liveStatus = container.findByAttr("data-wallet-live-status", "true");
      const copyBtn = container.findByAttr("data-action", "copy-wallet-text");
      assert.ok(liveStatus && copyBtn);

      await act(async () => {
        copyBtn.dispatchBubblingEvent("click");
      });

      assert.equal(
        liveStatus.textContent,
        "Clipboard unavailable. Open the plain-text wallet preview below to copy manually."
      );
    }
  );
});

test("EmergencyMedCard and test suite contain zero code comments and zero em or en dashes", () => {
  const componentSource = readFileSync(
    new URL("../src/components/EmergencyMedCard.tsx", import.meta.url),
    "utf8"
  );
  const testSource = readFileSync(
    new URL("./emergencyMedCard.test.ts", import.meta.url),
    "utf8"
  );

  for (const [label, source] of [
    ["EmergencyMedCard.tsx", componentSource],
    ["emergencyMedCard.test.ts", testSource]
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
    assert.equal(source.includes(EM_DASH), false, `${label} must not contain em dashes`);
    assert.equal(source.includes(EN_DASH), false, `${label} must not contain en dashes`);
  }

  for (const locale of ["en", "fi", "sv", "de", "es"]) {
    for (const profile of [DEMO_PROFILE, EMPTY_PROFILE]) {
      const text = formatEmergencyWalletText(profile, locale);
      const html = renderCard({ profile, lang: locale });
      assert.equal(text.includes(EM_DASH), false);
      assert.equal(text.includes(EN_DASH), false);
      assert.equal(html.includes(EM_DASH), false);
      assert.equal(html.includes(EN_DASH), false);
    }
  }
});
