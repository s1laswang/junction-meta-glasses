import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PharmacyCameraScannerSection,
  PharmacyImportModal,
  PharmacyPreviewSection,
  bindPharmacyEscapeToClose,
  describePharmacyInput,
  preparePharmacyImport,
  startPharmacyCameraQrScan,
  type PharmacyImportModalProps,
  type PharmacyVideoSink
} from "../src/components/PharmacyImportModal.tsx";
import { buildBridgeDeepLink } from "../src/pairing/links.ts";
import {
  SAMPLE_FINNISH_PHARMACY_QR,
  encodePharmacyQrUri
} from "../src/pairing/pharmacyQr.ts";
import type { ScannedCodeClassification } from "../src/pairing/qrScanner.ts";
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
const nodeFsSpec: string = "node:fs/promises";
const nodeUrlSpec: string = "node:url";

const { test } = (await import(nodeTestSpec)) as { test: TestFn };
const assert = (await import(nodeAssertSpec)) as AssertStrict;
const { readFile } = (await import(nodeFsSpec)) as {
  readFile(path: string, encoding: string): Promise<string>;
};
const { fileURLToPath } = (await import(nodeUrlSpec)) as {
  fileURLToPath(url: string | URL): string;
};

const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);
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

test("PharmacyImportModal renders >= 56px Scan QR with Camera button, Yliopiston Apteekki sample button, primary import button, and close button", () => {
  const html = renderToStaticMarkup(
    createElement(PharmacyImportModal, {
      open: true,
      profile: DEMO_PROFILE,
      lang: "en",
      onImportProfile: noop,
      onClose: noop
    })
  );

  assert.ok(html.includes(">Scan QR with Camera</button>"));
  assert.ok(
    html.includes(">Load Sample Finnish Pharmacy QR (Yliopiston Apteekki)</button>")
  );
  assert.ok(html.includes(">Add to My On-Device Medications</button>"));
  assert.ok(html.includes(">Close</button>"));

  const scanBtn = extractOpeningTagByAttr(html, 'data-action="toggle-pharmacy-camera-scan"');
  const sampleBtn = extractOpeningTagByAttr(html, 'data-action="load-sample-pharmacy-qr"');
  const importBtn = extractOpeningTagByAttr(html, 'data-action="confirm-pharmacy-import"');
  const closeBtn = extractOpeningTagByAttr(html, 'data-action="close-pharmacy-import"');

  assert.ok(scanBtn.includes("min-height:56px"));
  assert.ok(scanBtn.includes('aria-pressed="false"'));
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

  assert.ok(enHtml.includes(">Scan QR with Camera</button>"));
  assert.ok(fiHtml.includes(">Lue QR-koodi kameralla</button>"));
  assert.ok(svHtml.includes(">Skanna QR med kameran</button>"));

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

test("PharmacyCameraScannerSection renders active viewfinder video and plain-language camera error alert across locales", () => {
  for (const [locale, stopLabel] of [
    ["en", "Stop Camera Scan"],
    ["fi", "Lopeta kameran QR-luku"],
    ["sv", "Stoppa kameraskanning"]
  ] as const) {
    const activeHtml = renderToStaticMarkup(
      createElement(PharmacyCameraScannerSection, {
        scanning: true,
        cameraError: "",
        lang: locale,
        onToggleScan: noop
      })
    );
    const btnTag = extractOpeningTagByAttr(
      activeHtml,
      'data-action="toggle-pharmacy-camera-scan"'
    );
    assert.ok(btnTag.includes("min-height:56px"));
    assert.ok(btnTag.includes('aria-pressed="true"'));
    assert.ok(activeHtml.includes(`>${stopLabel}</button>`));
    assert.ok(activeHtml.includes('data-camera-scanner="active"'));
    assert.ok(activeHtml.includes("<video"));
    assert.equal(activeHtml.includes(EM_DASH), false);
    assert.equal(activeHtml.includes(EN_DASH), false);
  }

  const errorHtml = renderToStaticMarkup(
    createElement(PharmacyCameraScannerSection, {
      scanning: false,
      cameraError: "Camera permission was denied.",
      lang: "en",
      onToggleScan: noop
    })
  );
  const errorAlert = extractOpeningTagByAttr(errorHtml, 'id="pharmacy-camera-error"');
  assert.ok(errorAlert.includes('role="alert"'));
  assert.ok(errorAlert.includes('data-camera-error="true"'));
  assert.ok(errorHtml.includes("Camera permission was denied."));
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
    assert.ok(alertTag.includes('data-code-kind="unknown"'));
    assert.equal(invalidHtml.includes(EM_DASH), false, `${locale} alert contained em dash`);
    assert.equal(invalidHtml.includes(EN_DASH), false, `${locale} alert contained en dash`);
  }
});

test("PharmacyPreviewSection and describePharmacyInput give localized smart guidance for bridge_pairing and product_barcode codes", () => {
  const bridgeUri = buildBridgeDeepLink("https://demo.trycloudflare.com", "hup23456");
  const sessionlessBridgeUri = buildBridgeDeepLink("https://demo.trycloudflare.com");
  const ean13 = "6432100012345";
  const upcA = "036000291452";

  assert.equal(preparePharmacyImport(DEMO_PROFILE, bridgeUri), null);
  assert.equal(preparePharmacyImport(DEMO_PROFILE, ean13), null);
  assert.equal(preparePharmacyImport(DEMO_PROFILE, upcA), null);

  const bridgeRenderedByLocale: Record<string, string> = {};
  const barcodeRenderedByLocale: Record<string, string> = {};

  for (const locale of ["en", "fi", "sv"] as const) {
    const bridgeGuidance = describePharmacyInput(bridgeUri, locale);
    assert.equal(bridgeGuidance.kind, "bridge_pairing");
    if (bridgeGuidance.kind === "bridge_pairing") {
      assert.equal(bridgeGuidance.serverOrigin, "https://demo.trycloudflare.com");
      assert.equal(bridgeGuidance.sessionId, "hup23456");
      assert.ok(bridgeGuidance.body.includes("https://demo.trycloudflare.com"));
      assert.ok(bridgeGuidance.body.includes("hup23456"));
    }

    const sessionlessGuidance = describePharmacyInput(sessionlessBridgeUri, locale);
    assert.equal(sessionlessGuidance.kind, "bridge_pairing");
    if (sessionlessGuidance.kind === "bridge_pairing") {
      assert.equal(sessionlessGuidance.sessionId, null);
      assert.ok(sessionlessGuidance.body.includes("https://demo.trycloudflare.com"));
    }

    const bridgeHtml = renderToStaticMarkup(
      createElement(PharmacyPreviewSection, {
        rawInput: bridgeUri,
        profile: DEMO_PROFILE,
        lang: locale
      })
    );
    const bridgeAlertTag = extractOpeningTagByAttr(bridgeHtml, 'role="alert"');
    assert.ok(bridgeAlertTag.includes('id="pharmacy-qr-error"'));
    assert.ok(bridgeAlertTag.includes('data-code-kind="bridge_pairing"'));
    assert.ok(bridgeHtml.includes("https://demo.trycloudflare.com"));
    assert.ok(bridgeHtml.includes("hup23456"));
    assert.equal(bridgeHtml.includes(EM_DASH), false);
    assert.equal(bridgeHtml.includes(EN_DASH), false);
    bridgeRenderedByLocale[locale] = bridgeHtml;

    const upcGuidance = describePharmacyInput(upcA, locale);
    assert.equal(upcGuidance.kind, "product_barcode");
    if (upcGuidance.kind === "product_barcode") {
      assert.equal(upcGuidance.normalizedDigits, "0036000291452");
      assert.ok(upcGuidance.body.includes("0036000291452"));
    }

    const barcodeHtml = renderToStaticMarkup(
      createElement(PharmacyPreviewSection, {
        rawInput: ean13,
        profile: DEMO_PROFILE,
        lang: locale
      })
    );
    const barcodeAlertTag = extractOpeningTagByAttr(barcodeHtml, 'role="alert"');
    assert.ok(barcodeAlertTag.includes('id="pharmacy-qr-error"'));
    assert.ok(barcodeAlertTag.includes('data-code-kind="product_barcode"'));
    assert.ok(barcodeHtml.includes("6432100012345"));
    assert.equal(barcodeHtml.includes(EM_DASH), false);
    assert.equal(barcodeHtml.includes(EN_DASH), false);
    barcodeRenderedByLocale[locale] = barcodeHtml;
  }

  assert.notEqual(bridgeRenderedByLocale.en, bridgeRenderedByLocale.fi);
  assert.notEqual(bridgeRenderedByLocale.en, bridgeRenderedByLocale.sv);
  assert.notEqual(bridgeRenderedByLocale.fi, bridgeRenderedByLocale.sv);

  assert.notEqual(barcodeRenderedByLocale.en, barcodeRenderedByLocale.fi);
  assert.notEqual(barcodeRenderedByLocale.en, barcodeRenderedByLocale.sv);
  assert.notEqual(barcodeRenderedByLocale.fi, barcodeRenderedByLocale.sv);

  const hostileBridge = "holdupbridge:\x2f\x2fconnect?server=javascript:alert(1)";
  const hostileGuidance = describePharmacyInput(hostileBridge, "en");
  assert.equal(hostileGuidance.kind, "unknown");
});

test("startPharmacyCameraQrScan uses environment getUserMedia + BarcodeDetector and stops tracks immediately on pharmacy_rx capture", async () => {
  const prevNavigatorDesc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const globalRecord = globalThis as Record<string, unknown>;
  const prevBarcodeDetector = globalRecord.BarcodeDetector;

  let capturedConstraints: MediaStreamConstraints | null = null;
  let trackStoppedCount = 0;
  let playCalled = false;

  const fakeStream = {
    getTracks() {
      return [
        {
          stop() {
            trackStoppedCount += 1;
          }
        }
      ];
    }
  };

  const fakeVideo: PharmacyVideoSink = {
    srcObject: null,
    play: async () => {
      playCalled = true;
    }
  };

  try {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        mediaDevices: {
          async getUserMedia(constraints: MediaStreamConstraints) {
            capturedConstraints = constraints;
            return fakeStream;
          }
        }
      }
    });

    globalRecord.BarcodeDetector = class {
      async detect(source: unknown) {
        assert.equal(source, fakeVideo);
        return [{ rawValue: SAMPLE_FINNISH_PHARMACY_QR }];
      }
    };

    const detectedEvents: ScannedCodeClassification[] = [];
    const errors: string[] = [];
    let tracksStoppedInsideCallback = false;

    const handle = startPharmacyCameraQrScan({
      lang: "en",
      getVideoElement: () => fakeVideo,
      onDetected: (classified) => {
        tracksStoppedInsideCallback = trackStoppedCount > 0 && fakeVideo.srcObject === null;
        detectedEvents.push(classified);
      },
      onError: (msg) => {
        errors.push(msg);
      }
    });

    assert.equal(await handle.ready, true);
    assert.deepEqual(capturedConstraints, { video: { facingMode: "environment" } });
    assert.equal(playCalled, true);
    assert.equal(errors.length, 0);
    assert.equal(detectedEvents.length, 1);
    assert.equal(detectedEvents[0].kind, "pharmacy_rx");
    assert.equal(tracksStoppedInsideCallback, true);
    assert.equal(handle.active, false);
    assert.equal(fakeVideo.srcObject, null);
    assert.ok(trackStoppedCount >= 1);
  } finally {
    if (prevNavigatorDesc) {
      Object.defineProperty(globalThis, "navigator", prevNavigatorDesc);
    }
    if (prevBarcodeDetector === undefined) {
      delete globalRecord.BarcodeDetector;
    } else {
      globalRecord.BarcodeDetector = prevBarcodeDetector;
    }
  }
});

test("startPharmacyCameraQrScan surfaces wrong-kind scans while keeping camera open until pharmacy_rx or stop()", async () => {
  let trackStopped = 0;
  const fakeStream = {
    getTracks: () => [
      {
        stop() {
          trackStopped += 1;
        }
      }
    ]
  };
  const fakeVideo: PharmacyVideoSink = { srcObject: null };
  const bridgeUri = buildBridgeDeepLink("https://demo.trycloudflare.com", "hup23456");

  const frames: Array<Array<{ rawValue?: string }>> = [
    [{ rawValue: "6432100012345" }],
    [{ rawValue: bridgeUri }],
    [{ rawValue: SAMPLE_FINNISH_PHARMACY_QR }]
  ];
  let callIndex = 0;

  let resolveDone: (() => void) | null = null;
  const donePromise = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const seenKinds: Array<ScannedCodeClassification["kind"]> = [];
  const handle = startPharmacyCameraQrScan({
    lang: "en",
    scanIntervalMs: 10,
    getVideoElement: () => fakeVideo,
    getUserMedia: async () => fakeStream,
    detectorFactory: async () => ({
      async detect() {
        const next = frames[callIndex] ?? [];
        callIndex += 1;
        return next;
      }
    }),
    onDetected: (classified) => {
      seenKinds.push(classified.kind);
      if (classified.kind !== "pharmacy_rx") {
        assert.equal(trackStopped, 0);
      } else {
        resolveDone?.();
      }
    },
    onError: () => {
      throw new Error("Unexpected camera error");
    }
  });

  await handle.ready;
  await donePromise;

  assert.deepEqual(seenKinds, ["product_barcode", "bridge_pairing", "pharmacy_rx"]);
  assert.ok(trackStopped >= 1);
  assert.equal(handle.active, false);
  assert.equal(fakeVideo.srcObject, null);

  let pendingTrackStopped = 0;
  const pendingResolvers: Array<(s: { getTracks: () => Array<{ stop: () => void }> }) => void> = [];
  const pendingHandle = startPharmacyCameraQrScan({
    lang: "en",
    getVideoElement: () => ({ srcObject: null }),
    getUserMedia: () =>
      new Promise((resolve) => {
        pendingResolvers.push(resolve);
      }),
    detectorFactory: async () => ({
      async detect() {
        return [];
      }
    }),
    onDetected: noop,
    onError: noop
  });

  pendingHandle.stop();
  assert.equal(pendingHandle.active, false);
  pendingResolvers[0]?.({
    getTracks: () => [
      {
        stop() {
          pendingTrackStopped += 1;
        }
      }
    ]
  });
  assert.equal(await pendingHandle.ready, false);
  assert.equal(pendingTrackStopped, 1);
});

test("startPharmacyCameraQrScan surfaces localized plain-language messages when camera or BarcodeDetector is unavailable or denied", async () => {
  const prevNavigatorDesc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const globalRecord = globalThis as Record<string, unknown>;
  const prevBarcodeDetector = globalRecord.BarcodeDetector;

  try {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {}
    });
    delete globalRecord.BarcodeDetector;

    for (const locale of ["en", "fi", "sv"] as const) {
      let noCameraMsg = "";
      const h1 = startPharmacyCameraQrScan({
        lang: locale,
        getVideoElement: () => null,
        onDetected: noop,
        onError: (msg) => {
          noCameraMsg = msg;
        }
      });
      assert.equal(h1.active, false);
      assert.equal(await h1.ready, false);
      assert.ok(noCameraMsg.length > 20);
      assert.equal(noCameraMsg.includes(EM_DASH), false);

      let noDetectorMsg = "";
      const h2 = startPharmacyCameraQrScan({
        lang: locale,
        getVideoElement: () => null,
        getUserMedia: async () => ({ getTracks: () => [] }),
        isDetectorSupported: () => false,
        onDetected: noop,
        onError: (msg) => {
          noDetectorMsg = msg;
        }
      });
      assert.equal(h2.active, false);
      assert.equal(await h2.ready, false);
      assert.ok(noDetectorMsg.includes("BarcodeDetector"));
      assert.equal(noDetectorMsg.includes(EM_DASH), false);

      let deniedMsg = "";
      const h3 = startPharmacyCameraQrScan({
        lang: locale,
        getVideoElement: () => null,
        getUserMedia: async () => {
          const err = new Error("Denied");
          err.name = "NotAllowedError";
          throw err;
        },
        isDetectorSupported: () => true,
        onDetected: noop,
        onError: (msg) => {
          deniedMsg = msg;
        }
      });
      assert.equal(await h3.ready, false);
      assert.equal(h3.active, false);
      assert.ok(deniedMsg.length > 20);
      assert.notEqual(deniedMsg, noDetectorMsg);

      let hardwareMsg = "";
      const h4 = startPharmacyCameraQrScan({
        lang: locale,
        getVideoElement: () => null,
        getUserMedia: async () => {
          const err = new Error("No camera");
          err.name = "NotFoundError";
          throw err;
        },
        isDetectorSupported: () => true,
        onDetected: noop,
        onError: (msg) => {
          hardwareMsg = msg;
        }
      });
      assert.equal(await h4.ready, false);
      assert.equal(h4.active, false);
      assert.ok(hardwareMsg.length > 20);
      assert.notEqual(hardwareMsg, deniedMsg);
    }
  } finally {
    if (prevNavigatorDesc) {
      Object.defineProperty(globalThis, "navigator", prevNavigatorDesc);
    }
    if (prevBarcodeDetector === undefined) {
      delete globalRecord.BarcodeDetector;
    } else {
      globalRecord.BarcodeDetector = prevBarcodeDetector;
    }
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

test("PharmacyImportModal and test sources contain zero em dashes or en dashes", async () => {
  const modalPath = fileURLToPath(
    new URL("../src/components/PharmacyImportModal.tsx", import.meta.url)
  );
  const testPath = fileURLToPath(new URL("./pharmacyImportModal.test.ts", import.meta.url));
  const [modalSource, testSource] = await Promise.all([
    readFile(modalPath, "utf8"),
    readFile(testPath, "utf8")
  ]);

  assert.equal(modalSource.includes(EM_DASH), false);
  assert.equal(modalSource.includes(EN_DASH), false);
  assert.equal(testSource.indexOf(String.fromCharCode(0x2014)), -1);
  assert.equal(testSource.indexOf(String.fromCharCode(0x2013)), -1);
});
