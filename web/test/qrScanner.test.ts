import { buildBridgeDeepLink, buildHudUrl, buildMetaWebAppDeepLink } from "../src/pairing/links.ts";
import {
  SAMPLE_FINNISH_PHARMACY_QR,
  encodePharmacyQrUri,
  parsePharmacyQrUri
} from "../src/pairing/pharmacyQr.ts";
import {
  classifyScannedCode,
  detectAndClassifyFromSource,
  type ScannedCodeClassification
} from "../src/pairing/qrScanner.ts";

type TestFn = (name: string, fn: () => void | Promise<void>) => Promise<void>;

interface StrictAssert {
  ok(value: unknown, message?: string): void;
  equal<T>(actual: T, expected: T, message?: string): void;
  deepEqual<T>(actual: T, expected: T, message?: string): void;
  doesNotThrow(fn: () => unknown, message?: string): void;
}

const testModuleId = String("node:test");
const assertModuleId = String("node:assert/strict");
const fsModuleId = String("node:fs/promises");
const urlModuleId = String("node:url");

const { test } = (await import(testModuleId)) as { test: TestFn };
const { default: assert } = (await import(assertModuleId)) as { default: StrictAssert };
const { readFile } = (await import(fsModuleId)) as {
  readFile(path: string, encoding: string): Promise<string>;
};
const { fileURLToPath } = (await import(urlModuleId)) as {
  fileURLToPath(url: string | URL): string;
};

const EM_DASH = String.fromCharCode(0x2014);

test("classifyScannedCode classifies SAMPLE_FINNISH_PHARMACY_QR, https rx URLs, and raw JSON as pharmacy_rx", () => {
  const sampleResult = classifyScannedCode(`  ${SAMPLE_FINNISH_PHARMACY_QR}  `);
  assert.equal(sampleResult.kind, "pharmacy_rx");
  if (sampleResult.kind !== "pharmacy_rx") {
    throw new Error("Expected pharmacy_rx classification");
  }
  assert.equal(sampleResult.raw, SAMPLE_FINNISH_PHARMACY_QR);
  assert.deepEqual(sampleResult.payload, parsePharmacyQrUri(SAMPLE_FINNISH_PHARMACY_QR));
  assert.equal(sampleResult.payload.pharmacy, "Yliopiston Apteekki Helsinki");
  assert.equal(sampleResult.payload.meds.length, 2);

  const customPayload = {
    v: 1 as const,
    pharmacy: "Kallion Apteekki",
    meds: [
      {
        id: "aml",
        name: "Norvasc",
        ingredient: "amlodipine",
        strength: "5 mg",
        schedule: ["evening"],
        barcode: "6432100012345"
      }
    ]
  };
  const holdupUri = encodePharmacyQrUri(customPayload);
  const dataToken = holdupUri.split("data=")[1];
  const httpsRxUrl = `https://holdup.example.fi/rx?v=1&data=${dataToken}`;

  const httpsResult = classifyScannedCode(httpsRxUrl);
  assert.equal(httpsResult.kind, "pharmacy_rx");
  if (httpsResult.kind === "pharmacy_rx") {
    assert.equal(httpsResult.payload.pharmacy, "Kallion Apteekki");
    assert.equal(httpsResult.payload.meds[0].id, "aml");
  }

  const jsonResult = classifyScannedCode(JSON.stringify(customPayload));
  assert.equal(jsonResult.kind, "pharmacy_rx");
});

test("classifyScannedCode classifies valid HoldUp Android DAT Bridge deep links as bridge_pairing", () => {
  const bridgeWithSession = buildBridgeDeepLink("https://demo.trycloudflare.com", "hup23456");
  const result = classifyScannedCode(bridgeWithSession);
  assert.deepEqual(result, {
    kind: "bridge_pairing",
    raw: bridgeWithSession,
    serverOrigin: "https://demo.trycloudflare.com",
    sessionId: "hup23456"
  });

  const bridgeWithHyphenSession = buildBridgeDeepLink(
    "https://demo.trycloudflare.com/",
    "hup-4k_9m"
  );
  const hyphenResult = classifyScannedCode(`  ${bridgeWithHyphenSession}\n`);
  assert.deepEqual(hyphenResult, {
    kind: "bridge_pairing",
    raw: bridgeWithHyphenSession,
    serverOrigin: "https://demo.trycloudflare.com",
    sessionId: "hup-4k_9m"
  });

  const sessionless = buildBridgeDeepLink("http://localhost:8787/");
  const sessionlessResult = classifyScannedCode(sessionless);
  assert.deepEqual(sessionlessResult, {
    kind: "bridge_pairing",
    raw: sessionless,
    serverOrigin: "http://localhost:8787",
    sessionId: null
  });
});

test("classifyScannedCode rejects hostile or malformed holdupbridge URIs without misclassifying embedded digits", () => {
  const hostileInputs = [
    "holdupbridge://connect?server=javascript:alert(1)",
    "holdupbridge://connect?server=javascript%3Aalert(1234567890)",
    "holdupbridge://connect?server=data:text/html,<script>alert(1)</script>",
    "holdupbridge://connect?server=file:///etc/passwd",
    "holdupbridge://connect?server=ftp%3A%2F%2Fdemo.trycloudflare.com",
    "holdupbridge://connect?server=https%3A%2F%2Fuser%3Apass%40demo.trycloudflare.com",
    "holdupbridge://connect?server=https%3A%2F%2Fdemo.trycloudflare.com%2Fsubpath",
    "holdupbridge://connect?server=https%3A%2F%2Fdemo.trycloudflare.com%3Fx%3D1",
    "holdupbridge://connect?server=https:demo.trycloudflare.com",
    "holdupbridge://connect?session=hup23456",
    "holdupbridge://wronghost?server=https%3A%2F%2Fdemo.trycloudflare.com",
    "holdupbridge://connect/extra?server=https%3A%2F%2Fdemo.trycloudflare.com",
    "holdupbridge://connect?server=https%3A%2F%2Fdemo.trycloudflare.com&server=https%3A%2F%2Fevil.example",
    "holdupbridge://connect?server=https%3A%2F%2Fdemo.trycloudflare.com&session=abc",
    `holdupbridge://connect?server=https%3A%2F%2Fdemo.trycloudflare.com&session=${"a".repeat(65)}`,
    "holdupbridge://connect?server=https%3A%2F%2Fdemo.trycloudflare.com&session=bad%20id",
    "holdupbridge://connect?server=https%3A%2F%2Fdemo.trycloudflare.com&session=",
    "holdupbridge://connect?server=http%3A%2F%2F192.168.1.10%3A8787&session=bad!"
  ];

  for (const input of hostileInputs) {
    assert.doesNotThrow(() => {
      const res = classifyScannedCode(input);
      assert.deepEqual(res, { kind: "unknown", raw: input });
    });
  }
});

test("classifyScannedCode normalizes EAN-13, EAN-8, UPC-A, and GTIN-14 retail barcodes and rejects non-barcodes", () => {
  assert.deepEqual(classifyScannedCode("6432100012345"), {
    kind: "product_barcode",
    raw: "6432100012345",
    normalizedDigits: "6432100012345"
  });

  assert.deepEqual(classifyScannedCode("  6432 1000-12345 "), {
    kind: "product_barcode",
    raw: "6432 1000-12345",
    normalizedDigits: "6432100012345"
  });

  assert.deepEqual(classifyScannedCode("036000291452"), {
    kind: "product_barcode",
    raw: "036000291452",
    normalizedDigits: "0036000291452"
  });

  assert.deepEqual(classifyScannedCode("036000-291452"), {
    kind: "product_barcode",
    raw: "036000-291452",
    normalizedDigits: "0036000291452"
  });

  assert.deepEqual(classifyScannedCode("6412-3456"), {
    kind: "product_barcode",
    raw: "6412-3456",
    normalizedDigits: "64123456"
  });

  assert.deepEqual(classifyScannedCode("10643210001232"), {
    kind: "product_barcode",
    raw: "10643210001232",
    normalizedDigits: "10643210001232"
  });

  const nonBarcodes = [
    "",
    "   ",
    "1234567",
    "123456789012345",
    "---",
    "https://demo.trycloudflare.com/item/6432100012345",
    buildMetaWebAppDeepLink(buildHudUrl("https://demo.trycloudflare.com", "hup23456"))
  ];

  for (const raw of nonBarcodes) {
    assert.deepEqual(classifyScannedCode(raw), {
      kind: "unknown",
      raw: raw.trim()
    });
  }
});

test("detectAndClassifyFromSource selects highest-priority classification when multiple codes appear in frame", async () => {
  const fakeFrame = { width: 640, height: 480 };
  const bridgeUri = buildBridgeDeepLink("https://demo.trycloudflare.com", "hup23456");

  const allFourHit = await detectAndClassifyFromSource(fakeFrame, async () => ({
    async detect(s: unknown) {
      assert.equal(s, fakeFrame);
      return [
        { rawValue: "https://unrecognized.example.com" },
        { rawValue: "6432100012345" },
        { rawValue: bridgeUri },
        { rawValue: SAMPLE_FINNISH_PHARMACY_QR }
      ];
    }
  }));
  assert.ok(allFourHit !== null && allFourHit.kind === "pharmacy_rx");

  const bridgeOverBarcode = await detectAndClassifyFromSource(fakeFrame, async () => ({
    async detect() {
      return [
        { rawValue: "6432100012345" },
        { rawValue: "https://unrecognized.example.com" },
        { rawValue: bridgeUri }
      ];
    }
  }));
  assert.deepEqual(bridgeOverBarcode, {
    kind: "bridge_pairing",
    raw: bridgeUri,
    serverOrigin: "https://demo.trycloudflare.com",
    sessionId: "hup23456"
  });

  const barcodeOverUnknown = await detectAndClassifyFromSource(fakeFrame, async () => ({
    async detect() {
      return [
        { rawValue: "   " },
        { rawValue: "holdupbridge://connect?server=javascript:alert(1)" },
        { rawValue: "036000291452" },
        { rawValue: "6432100012345" }
      ];
    }
  }));
  assert.deepEqual(barcodeOverUnknown, {
    kind: "product_barcode",
    raw: "036000291452",
    normalizedDigits: "0036000291452"
  });

  const unknownOnly = await detectAndClassifyFromSource(fakeFrame, async () => ({
    async detect() {
      return [{ rawValue: "https://unrecognized.example.com/qr" }];
    }
  }));
  assert.deepEqual(unknownOnly, {
    kind: "unknown",
    raw: "https://unrecognized.example.com/qr"
  });
});

test("detectAndClassifyFromSource uses global BarcodeDetector formats and returns null safely when headless, empty, or throwing", async () => {
  const globalRecord = globalThis as Record<string, unknown>;
  const originalDetector = globalRecord.BarcodeDetector;
  const fakeCanvas = { tagName: "CANVAS" };

  try {
    delete globalRecord.BarcodeDetector;
    assert.equal(await detectAndClassifyFromSource(fakeCanvas), null);
    assert.equal(await detectAndClassifyFromSource(null), null);
    assert.equal(await detectAndClassifyFromSource(undefined), null);

    let capturedFormats: string[] = [];
    globalRecord.BarcodeDetector = class {
      constructor(opts?: { formats?: string[] }) {
        capturedFormats = opts?.formats ?? [];
      }
      async detect() {
        return [{ rawValue: "6432100012345" }];
      }
    };

    const detected = await detectAndClassifyFromSource(fakeCanvas);
    assert.deepEqual(capturedFormats, [
      "qr_code",
      "ean_13",
      "ean_8",
      "upc_a",
      "upc_e",
      "code_128"
    ]);
    assert.deepEqual(detected, {
      kind: "product_barcode",
      raw: "6432100012345",
      normalizedDigits: "6432100012345"
    });

    globalRecord.BarcodeDetector = class {
      async detect() {
        return [{ rawValue: "   " }, {}];
      }
    };
    assert.equal(await detectAndClassifyFromSource(fakeCanvas), null);

    globalRecord.BarcodeDetector = class {
      async detect(): Promise<Array<{ rawValue?: string }>> {
        throw new Error("Detached video frame");
      }
    };
    assert.equal(await detectAndClassifyFromSource(fakeCanvas), null);

    assert.equal(await detectAndClassifyFromSource(fakeCanvas, () => null), null);
    const strictTypedFactory: () => Promise<{
      detect(s: unknown): Promise<Array<{ rawValue?: string }>>;
    }> | null = async () => ({
      async detect() {
        return [{ rawValue: "036000291452" }];
      }
    });
    assert.deepEqual(await detectAndClassifyFromSource(fakeCanvas, strictTypedFactory), {
      kind: "product_barcode",
      raw: "036000291452",
      normalizedDigits: "0036000291452"
    });
    assert.equal(
      await detectAndClassifyFromSource(fakeCanvas, async () => {
        throw new Error("Factory init failure");
      }),
      null
    );
  } finally {
    if (originalDetector === undefined) {
      delete globalRecord.BarcodeDetector;
    } else {
      globalRecord.BarcodeDetector = originalDetector;
    }
  }
});

test("scanner module and test outputs contain zero em dashes", async () => {
  const samples: ScannedCodeClassification[] = [
    classifyScannedCode(SAMPLE_FINNISH_PHARMACY_QR),
    classifyScannedCode(buildBridgeDeepLink("https://demo.trycloudflare.com", "hup23456")),
    classifyScannedCode("6432100012345"),
    classifyScannedCode("holdupbridge://connect?server=javascript:alert(1)")
  ];
  for (const item of samples) {
    assert.equal(JSON.stringify(item).includes(EM_DASH), false);
  }

  const scannerPath = fileURLToPath(new URL("../src/pairing/qrScanner.ts", import.meta.url));
  const testPath = fileURLToPath(new URL("./qrScanner.test.ts", import.meta.url));
  const [scannerSource, testSource] = await Promise.all([
    readFile(scannerPath, "utf8"),
    readFile(testPath, "utf8")
  ]);
  assert.equal(scannerSource.includes(EM_DASH), false);
  assert.equal(testSource.includes(EM_DASH), false);
});
