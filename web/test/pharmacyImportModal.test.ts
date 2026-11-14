import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PharmacyImportModal,
  PharmacyPreviewSection,
  bindPharmacyEscapeToClose,
  preparePharmacyImport,
  type PharmacyImportModalProps
} from "../src/components/PharmacyImportModal.tsx";
import {
  SAMPLE_FINNISH_PHARMACY_QR,
  encodePharmacyQrUri
} from "../src/pairing/pharmacyQr.ts";
import { DEMO_PROFILE } from "../src/storage/profileStore.ts";
import type { Profile } from "../src/types.ts";

type TestFn = (name: string, fn: () => void | Promise<void>) => Promise<void>;

type AssertStrict = {
  ok(value: unknown, message?: string): void;
  equal<T>(actual: T, expected: T, message?: string): void;
  notEqual<T>(actual: T, expected: T, message?: string): void;
  deepEqual<T>(actual: T, expected: T, message?: string): void;
  match(value: string, regExp: RegExp, message?: string): void;
  doesNotMatch(value: string, regExp: RegExp, message?: string): void;
};

const nodeTestSpec: string = "node:test";
const nodeAssertSpec: string = "node:assert/strict";

const { test } = (await import(nodeTestSpec)) as { test: TestFn };
const assert = (await import(nodeAssertSpec)) as AssertStrict;

const EM_DASH = "\u2014";
const EN_DASH = "\u2013";
const noop = (): void => {};

function extractOpeningTagByAttr(html: string, attrSnippet: string): string {
  const escaped = attrSnippet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<([a-z0-9]+)\\b[^>]*${escaped}[^>]*>`, "i");
  const match = pattern.exec(html);
  assert.ok(match, `Expected element with attribute snippet ${attrSnippet}`);
  return match ? match[0] : "";
}

test("PharmacyImportModal returns empty markup when closed and accessible role=dialog when open", () => {
  const closedProps: PharmacyImportModalProps = {
    open: false,
    profile: DEMO_PROFILE,
    lang: "en",
    onImportProfile: noop,
    onClose: noop
  };
  const closedHtml = renderToStaticMarkup(createElement(PharmacyImportModal, closedProps));
  assert.equal(closedHtml, "");

  const openProps: PharmacyImportModalProps = {
    open: true,
    profile: DEMO_PROFILE,
    lang: "en",
    onImportProfile: noop,
    onClose: noop
  };
  const openHtml = renderToStaticMarkup(createElement(PharmacyImportModal, openProps));

  const dialogTag = extractOpeningTagByAttr(openHtml, 'role="dialog"');
  assert.ok(dialogTag.includes('aria-modal="true"'));
  assert.ok(dialogTag.includes('aria-labelledby="pharmacy-import-dialog-title"'));
  assert.ok(dialogTag.includes('aria-describedby="pharmacy-import-dialog-subtitle"'));
  assert.ok(dialogTag.includes('tabindex="-1"'));

  assert.ok(openHtml.includes('id="pharmacy-import-dialog-title"'));
  assert.ok(openHtml.includes('id="pharmacy-import-dialog-subtitle"'));
  assert.ok(openHtml.includes('for="pharmacy-qr-input"'));
  assert.ok(openHtml.includes('id="pharmacy-qr-input"'));
  assert.ok(openHtml.includes('role="status"'));
  assert.ok(openHtml.includes('aria-live="polite"'));
  assert.doesNotMatch(openHtml, /role="alert"/);
  assert.equal(openHtml.includes(EM_DASH), false);
  assert.equal(openHtml.includes(EN_DASH), false);
});

test("PharmacyImportModal renders >= 56px Yliopiston Apteekki sample button, primary import button, and close button", () => {
  const html = renderToStaticMarkup(
    createElement(PharmacyImportModal, {
      open: true,
      profile: DEMO_PROFILE,
      lang: "en",
      onImportProfile: noop,
      onClose: noop
    })
  );

  assert.ok(
    html.includes(">Load Sample Finnish Pharmacy QR (Yliopiston Apteekki)</button>")
  );
  assert.ok(html.includes(">Add to My On-Device Medications</button>"));
  assert.ok(html.includes(">Close</button>"));

  const sampleBtn = extractOpeningTagByAttr(html, 'data-action="load-sample-pharmacy-qr"');
  const importBtn = extractOpeningTagByAttr(html, 'data-action="confirm-pharmacy-import"');
  const closeBtn = extractOpeningTagByAttr(html, 'data-action="close-pharmacy-import"');

  assert.ok(sampleBtn.includes("min-height:56px"));
  assert.ok(importBtn.includes("min-height:56px"));
  assert.ok(closeBtn.includes("min-height:56px"));

  assert.match(importBtn, /\sdisabled(?:=""|\s|>)/);
  assert.ok(importBtn.includes('aria-disabled="true"'));
});

test("PharmacyImportModal localizes cleanly in en, fi, sv with fallback and zero em dashes", () => {
  const enHtml = renderToStaticMarkup(
    createElement(PharmacyImportModal, {
      open: true,
      profile: DEMO_PROFILE,
      lang: "en",
      onImportProfile: noop,
      onClose: noop
    })
  );
  const fiHtml = renderToStaticMarkup(
    createElement(PharmacyImportModal, {
      open: true,
      profile: DEMO_PROFILE,
      lang: "fi",
      onImportProfile: noop,
      onClose: noop
    })
  );
  const svHtml = renderToStaticMarkup(
    createElement(PharmacyImportModal, {
      open: true,
      profile: DEMO_PROFILE,
      lang: "sv",
      onImportProfile: noop,
      onClose: noop
    })
  );
  const deFallbackHtml = renderToStaticMarkup(
    createElement(PharmacyImportModal, {
      open: true,
      profile: DEMO_PROFILE,
      lang: "de",
      onImportProfile: noop,
      onClose: noop
    })
  );

  assert.notEqual(enHtml, fiHtml);
  assert.notEqual(enHtml, svHtml);
  assert.notEqual(fiHtml, svHtml);
  assert.equal(deFallbackHtml, enHtml);

  for (const [locale, html] of [
    ["en", enHtml],
    ["fi", fiHtml],
    ["sv", svHtml]
  ] as const) {
    assert.ok(html.includes("Yliopiston Apteekki"), `${locale} missing Yliopiston Apteekki`);
    assert.equal(html.includes(EM_DASH), false, `${locale} contained em dash`);
    assert.equal(html.includes(EN_DASH), false, `${locale} contained en dash`);
  }
});

test("PharmacyPreviewSection renders live parsed preview with pharmacy, meds, fields, and refill status or role=alert when invalid", () => {
  const samplePreviewHtml = renderToStaticMarkup(
    createElement(PharmacyPreviewSection, {
      rawInput: SAMPLE_FINNISH_PHARMACY_QR,
      profile: DEMO_PROFILE,
      lang: "en"
    })
  );

  assert.doesNotMatch(samplePreviewHtml, /role="alert"/);
  assert.ok(samplePreviewHtml.includes("Yliopiston Apteekki Helsinki"));
  assert.ok(samplePreviewHtml.includes("2 medications (2 new, 0 refill updates)"));

  assert.ok(samplePreviewHtml.includes("Bisoprolol"));
  assert.ok(samplePreviewHtml.includes("bisoprolol"));
  assert.ok(samplePreviewHtml.includes("2.5 mg"));
  assert.ok(samplePreviewHtml.includes("morning"));
  assert.ok(samplePreviewHtml.includes("6432100024680"));

  assert.ok(samplePreviewHtml.includes("Atorvastatin"));
  assert.ok(samplePreviewHtml.includes("atorvastatin"));
  assert.ok(samplePreviewHtml.includes("20 mg"));
  assert.ok(samplePreviewHtml.includes("evening"));
  assert.ok(samplePreviewHtml.includes("6432100086420"));

  assert.equal(samplePreviewHtml.includes(EM_DASH), false);
  assert.equal(samplePreviewHtml.includes(EN_DASH), false);

  const customNoPharmacyUri = encodePharmacyQrUri({
    v: 1,
    meds: [
      {
        id: "aml",
        name: "Amlodipine Orion",
        ingredient: "amlodipine",
        strength: "5 mg",
        schedule: ["evening"],
        barcode: "6432100012345"
      }
    ],
    allergies: ["hazelnut"],
    avoid: ["grapefruit"]
  });
  const refillPreviewHtml = renderToStaticMarkup(
    createElement(PharmacyPreviewSection, {
      rawInput: customNoPharmacyUri,
      profile: DEMO_PROFILE,
      lang: "en"
    })
  );
  assert.equal(refillPreviewHtml.includes("Dispensing pharmacy:"), false);
  assert.ok(refillPreviewHtml.includes("1 medication (0 new, 1 refill update)"));
  assert.ok(refillPreviewHtml.includes("Refill update"));
  assert.ok(refillPreviewHtml.includes("hazelnut"));
  assert.ok(refillPreviewHtml.includes("grapefruit"));
  assert.equal(refillPreviewHtml.includes(EM_DASH), false);

  for (const locale of ["en", "fi", "sv"] as const) {
    const invalidHtml = renderToStaticMarkup(
      createElement(PharmacyPreviewSection, {
        rawInput: "holdup:\x2f\x2frx?v=1&data=corrupted_payload",
        profile: DEMO_PROFILE,
        lang: locale
      })
    );
    const alertTag = extractOpeningTagByAttr(invalidHtml, 'role="alert"');
    assert.ok(alertTag.includes('id="pharmacy-qr-error"'));
    assert.equal(invalidHtml.includes(EM_DASH), false, `${locale} alert contained em dash`);
    assert.equal(invalidHtml.includes(EN_DASH), false, `${locale} alert contained en dash`);
  }
});

test("preparePharmacyImport merges medications idempotently and bindPharmacyEscapeToClose handles Escape cleanly", () => {
  assert.equal(preparePharmacyImport(DEMO_PROFILE, ""), null);
  assert.equal(preparePharmacyImport(DEMO_PROFILE, "{broken json"), null);

  const firstImport = preparePharmacyImport(DEMO_PROFILE, SAMPLE_FINNISH_PHARMACY_QR);
  assert.ok(firstImport !== null);
  if (!firstImport) {
    throw new Error("Expected firstImport result");
  }

  let capturedProfile: Profile | null = null;
  let capturedSummary: { added: number; updated: number; pharmacy?: string } | null = null;
  const onImportProfile: PharmacyImportModalProps["onImportProfile"] = (next, summary) => {
    capturedProfile = next;
    capturedSummary = summary;
  };
  onImportProfile(firstImport.next, firstImport.summary);

  assert.deepEqual(capturedSummary, {
    added: 2,
    updated: 0,
    pharmacy: "Yliopiston Apteekki Helsinki"
  });
  assert.ok(capturedProfile !== null);
  assert.equal(firstImport.next.meds.length, DEMO_PROFILE.meds.length + 2);

  const secondImport = preparePharmacyImport(firstImport.next, SAMPLE_FINNISH_PHARMACY_QR);
  assert.ok(secondImport !== null);
  if (secondImport) {
    assert.deepEqual(secondImport.summary, {
      added: 0,
      updated: 2,
      pharmacy: "Yliopiston Apteekki Helsinki"
    });
    assert.equal(secondImport.next.meds.length, firstImport.next.meds.length);
  }

  const rawJsonNoPharmacy = JSON.stringify({
    v: 1,
    meds: [{ name: "Thyroxin", ingredient: "levothyroxine", strength: "50 mcg", schedule: ["morning"] }]
  });
  const noPharmacyResult = preparePharmacyImport(DEMO_PROFILE, rawJsonNoPharmacy);
  assert.ok(noPharmacyResult !== null);
  if (noPharmacyResult) {
    assert.deepEqual(noPharmacyResult.summary, { added: 1, updated: 0 });
    assert.equal("pharmacy" in noPharmacyResult.summary, false);
  }

  let listener: ((ev: KeyboardEvent) => void) | null = null;
  const host = {
    addEventListener(_type: "keydown", fn: (ev: KeyboardEvent) => void) {
      listener = fn;
    },
    removeEventListener(_type: "keydown", fn: (ev: KeyboardEvent) => void) {
      if (listener === fn) {
        listener = null;
      }
    }
  };

  let closed = 0;
  let prevented = 0;
  const detachDisabled = bindPharmacyEscapeToClose(
    () => {
      closed += 1;
    },
    { enabled: false, host }
  );
  assert.equal(listener, null);
  detachDisabled();

  const detach = bindPharmacyEscapeToClose(
    () => {
      closed += 1;
    },
    { enabled: true, host }
  );
  assert.notEqual(listener, null);

  const emitKey = (key: string, defaultPrevented = false) => {
    listener?.({
      key,
      defaultPrevented,
      preventDefault() {
        prevented += 1;
      }
    } as unknown as KeyboardEvent);
  };

  emitKey("Enter");
  assert.equal(closed, 0);

  emitKey("Escape", true);
  assert.equal(closed, 0);
  assert.equal(prevented, 0);

  emitKey("Escape");
  assert.equal(closed, 1);
  assert.equal(prevented, 1);

  detach();
  assert.equal(listener, null);
});
