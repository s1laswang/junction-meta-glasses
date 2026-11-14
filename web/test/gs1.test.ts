import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { expiryEnd, expiryWords, isExpired, makeGs1, parseGs1, sameGtin } from "../src/lib/gs1.ts";

const GS = "\x1d";

type DetectedItem = { rawValue: string; format: string };
type BarcodeMod = typeof import("../src/lib/barcode.ts");

const mockState: {
  ctorCalls: Array<{ formats?: string[] } | undefined>;
  detectCalls: unknown[];
  getFormatsImpl: (() => Promise<string[]>) | null;
  detectImpl: (src: unknown) => Promise<DetectedItem[]>;
} = {
  ctorCalls: [],
  detectCalls: [],
  getFormatsImpl: async () => ["aztec", "data_matrix", "ean_13", "pdf417"],
  detectImpl: async () => [],
};

class DelegatingBarcodeDetector {
  constructor(opts?: { formats?: string[] }) {
    mockState.ctorCalls.push(opts);
  }
  detect(src: unknown): Promise<DetectedItem[]> {
    mockState.detectCalls.push(src);
    return mockState.detectImpl(src);
  }
  static getSupportedFormats(): Promise<string[]> {
    if (!mockState.getFormatsImpl) throw new Error("getSupportedFormats disabled");
    return mockState.getFormatsImpl();
  }
}

Object.defineProperty(globalThis, "window", {
  value: { BarcodeDetector: DelegatingBarcodeDetector },
  writable: true,
  configurable: true,
});

const barcodeMod: BarcodeMod = await import("../src/lib/barcode.ts");

async function importFreshBarcode(tag: string): Promise<BarcodeMod> {
  const href = new URL("../src/lib/barcode.ts", import.meta.url).href;
  return (await import(`${href}?case=${tag}`)) as BarcodeMod;
}

describe("parseGs1", () => {
  test("returns null for empty, whitespace, non-GS1, unsupported symbology, and malformed standalone inputs", () => {
    assert.equal(parseGs1(""), null);
    assert.equal(parseGs1("   "), null);
    assert.equal(parseGs1("\t\n  "), null);
    assert.equal(parseGs1("NOT_A_BARCODE"), null);
    assert.equal(parseGs1("EAN6416542002149"), null);
    assert.equal(parseGs1("]d2"), null);
    assert.equal(parseGs1("]C1"), null);
    assert.equal(parseGs1(`${GS}${GS}`), null);
    assert.equal(parseGs1("]Q3010641654200214917270800"), null);
    assert.equal(parseGs1("00123456789012345678"), null);
    assert.equal(parseGs1("(11)260115(20)01"), null);
    assert.equal(parseGs1("010641654200"), null);
    assert.equal(parseGs1("010641654200214X"), null);
    assert.equal(parseGs1("(01)6416542002149"), null);
    assert.equal(parseGs1("(01)064165420021490"), null);
    assert.equal(parseGs1("17270015"), null);
    assert.equal(parseGs1("17271301"), null);
    assert.equal(parseGs1("172708"), null);
    assert.equal(parseGs1("(01)(17)"), null);
    assert.equal(parseGs1("()"), null);
  });

  test("parses human-readable parenthesised HRI strings with compact, spaced, and reordered AIs", () => {
    const compact = "(01)06416542002149(17)270800(10)BATCH42(21)SN9001";
    assert.deepEqual(parseGs1(compact), {
      raw: compact,
      gtin: "06416542002149",
      expiry: "2027-08",
      batch: "BATCH42",
      serial: "SN9001",
    });

    const spaced = "  (01) 06410000123456 (17) 270815 (10) LOT-7A (21) SER-88B  ";
    assert.deepEqual(parseGs1(spaced), {
      raw: spaced,
      gtin: "06410000123456",
      expiry: "2027-08-15",
      batch: "LOT-7A",
      serial: "SER-88B",
    });

    const reordered = "(21)SER55(710)PZN12345(10)LOT9(17)280229(240)EXTRA99(01)06416542003375";
    assert.deepEqual(parseGs1(reordered), {
      raw: reordered,
      gtin: "06416542003375",
      expiry: "2028-02-29",
      batch: "LOT9",
      serial: "SER55",
    });
  });

  test("strips ]d2, ]C1, and leading FNC1 prefixes on raw scanner element strings", () => {
    const dm = `]d201064165420021491727080010LOT1${GS}21SN1`;
    assert.deepEqual(parseGs1(dm), {
      raw: dm,
      gtin: "06416542002149",
      expiry: "2027-08",
      batch: "LOT1",
      serial: "SN1",
    });

    const gs128 = `]C101064165420033751727113010LOT2${GS}21SN2`;
    assert.deepEqual(parseGs1(gs128), {
      raw: gs128,
      gtin: "06416542003375",
      expiry: "2027-11-30",
      batch: "LOT2",
      serial: "SN2",
    });

    const fnc1Single = `${GS}01064165420048601729010010BATCH9${GS}21SERIAL9`;
    assert.deepEqual(parseGs1(fnc1Single), {
      raw: fnc1Single,
      gtin: "06416542004860",
      expiry: "2029-01",
      batch: "BATCH9",
      serial: "SERIAL9",
    });

    const fnc1Multiple = `${GS}${GS}${GS}01064100001234561727081521ONLYSER`;
    assert.deepEqual(parseGs1(fnc1Multiple), {
      raw: fnc1Multiple,
      gtin: "06410000123456",
      expiry: "2027-08-15",
      serial: "ONLYSER",
    });

    const dmPlusFnc1 = `]d2${GS}01064165420021491727080010LOTX`;
    assert.deepEqual(parseGs1(dmPlusFnc1), {
      raw: dmPlusFnc1,
      gtin: "06416542002149",
      expiry: "2027-08",
      batch: "LOTX",
    });
  });

  test("parses variable-length AIs 10 and 21 delimited by GS in any order and enforces max length", () => {
    const serialBeforeBatchBeforeExpiry = `010641654200214921SER-FIRST${GS}10BATCH-SECOND${GS}17270800`;
    assert.deepEqual(parseGs1(serialBeforeBatchBeforeExpiry), {
      raw: serialBeforeBatchBeforeExpiry,
      gtin: "06416542002149",
      expiry: "2027-08",
      batch: "BATCH-SECOND",
      serial: "SER-FIRST",
    });

    const variableAtStart = `10FIRSTLOT${GS}${GS}21SECOND-SN${GS}010641000012345617270815${GS}`;
    assert.deepEqual(parseGs1(variableAtStart), {
      raw: variableAtStart,
      gtin: "06410000123456",
      expiry: "2027-08-15",
      batch: "FIRSTLOT",
      serial: "SECOND-SN",
    });

    const overlongBatchAndSerial = `010641654200214910ABCDEFGHIJKLMNOPQRSTUVWX${GS}2112345678901234567890999${GS}17270800`;
    assert.deepEqual(parseGs1(overlongBatchAndSerial), {
      raw: overlongBatchAndSerial,
      gtin: "06416542002149",
      expiry: "2027-08",
      batch: "ABCDEFGHIJKLMNOPQRST",
      serial: "12345678901234567890",
    });
  });

  test("skips 3-digit variable AIs (240, 710-714) and unused fixed AIs cleanly", () => {
    const with240 = `]d20106416542002149240ADD-ITEM-ID-9988${GS}10LOT-FI${GS}1727080021SN-FI`;
    assert.deepEqual(parseGs1(with240), {
      raw: with240,
      gtin: "06416542002149",
      expiry: "2027-08",
      batch: "LOT-FI",
      serial: "SN-FI",
    });

    for (const nhrnAi of ["710", "711", "712", "713", "714"]) {
      const midStream = `]d20106416542002149${nhrnAi}NHRN-CODE-123${GS}1727081510LOT-${nhrnAi}${GS}21SN-${nhrnAi}`;
      assert.deepEqual(
        parseGs1(midStream),
        {
          raw: midStream,
          gtin: "06416542002149",
          expiry: "2027-08-15",
          batch: `LOT-${nhrnAi}`,
          serial: `SN-${nhrnAi}`,
        },
        `failed mid-stream skip for AI ${nhrnAi}`,
      );

      const trailingStream = `01064100001234561727080010BATCH1${GS}${nhrnAi}TRAILING-NHRN`;
      assert.deepEqual(
        parseGs1(trailingStream),
        {
          raw: trailingStream,
          gtin: "06410000123456",
          expiry: "2027-08",
          batch: "BATCH1",
        },
        `failed trailing skip for AI ${nhrnAi}`,
      );
    }

    const withFixed11And20 = `010641654200214911260115200422CPV1${GS}241CUST1${GS}91COMPANY-INTERNAL${GS}1727080010B77${GS}21S88`;
    assert.deepEqual(parseGs1(withFixed11And20), {
      raw: withFixed11And20,
      gtin: "06416542002149",
      expiry: "2027-08",
      batch: "B77",
      serial: "S88",
    });

    const trailingNoiseAfterValid = `01064165420021491727080010B77${GS}ZZNOISE`;
    assert.deepEqual(parseGs1(trailingNoiseAfterValid), {
      raw: trailingNoiseAfterValid,
      gtin: "06416542002149",
      expiry: "2027-08",
      batch: "B77",
    });

    const manyDelimiters = `010641654200214917270800${GS.repeat(25)}10IGNORED`;
    assert.deepEqual(parseGs1(manyDelimiters), {
      raw: manyDelimiters,
      gtin: "06416542002149",
      expiry: "2027-08",
    });
  });

  test("applies YYMMDD sliding century boundary (51 -> 1951, 50 -> 2050), month validation, and DD=00 month-end rule", () => {
    assert.equal(parseGs1("010641654200214917510815")?.expiry, "1951-08-15");
    assert.equal(parseGs1("010641654200214917510800")?.expiry, "1951-08");
    assert.equal(parseGs1("010641654200214917991231")?.expiry, "1999-12-31");
    assert.equal(parseGs1("010641654200214917500815")?.expiry, "2050-08-15");
    assert.equal(parseGs1("010641654200214917500800")?.expiry, "2050-08");
    assert.equal(parseGs1("010641654200214917000105")?.expiry, "2000-01-05");
    assert.equal(parseGs1("010641654200214917270800")?.expiry, "2027-08");
    assert.equal(parseGs1("010641654200214917270815")?.expiry, "2027-08-15");

    const monthZero = parseGs1("01064165420021491727001510LOT1");
    assert.deepEqual(monthZero, {
      raw: "01064165420021491727001510LOT1",
      gtin: "06416542002149",
      expiry: undefined,
      batch: "LOT1",
    });

    const monthThirteen = parseGs1("01064165420021491727130010LOT2");
    assert.deepEqual(monthThirteen, {
      raw: "01064165420021491727130010LOT2",
      gtin: "06416542002149",
      expiry: undefined,
      batch: "LOT2",
    });

    const malformedExpiryHri = parseGs1("(01)06416542002149(17)2027-08");
    assert.deepEqual(malformedExpiryHri, {
      raw: "(01)06416542002149(17)2027-08",
      gtin: "06416542002149",
      expiry: undefined,
    });
  });

  test("ignores non-14-digit (01) GTIN while retaining other valid fields", () => {
    const shortHri = "(01)6416542002149(17)270800(10)LOT42";
    const parsedShort = parseGs1(shortHri);
    assert.equal(parsedShort?.gtin, undefined);
    assert.equal(parsedShort?.expiry, "2027-08");
    assert.equal(parsedShort?.batch, "LOT42");

    const longHri = "(01)064165420021499(17)270815(21)SN7";
    const parsedLong = parseGs1(longHri);
    assert.equal(parsedLong?.gtin, undefined);
    assert.equal(parsedLong?.expiry, "2027-08-15");
    assert.equal(parsedLong?.serial, "SN7");

    const nonDigitRaw = "010641654200214X1727080010LOT5";
    const parsedNonDigit = parseGs1(nonDigitRaw);
    assert.equal(parsedNonDigit?.gtin, undefined);
    assert.equal(parsedNonDigit?.expiry, "2027-08");
    assert.equal(parsedNonDigit?.batch, "LOT5");
  });
});

describe("makeGs1 round-trips through parseGs1", () => {
  test("round-trips without batch or serial", () => {
    const raw = makeGs1({ gtin: "06416542002149", expiry: "270800" });
    assert.deepEqual(parseGs1(raw), {
      raw,
      gtin: "06416542002149",
      expiry: "2027-08",
    });
  });

  test("round-trips with batch only, serial only, and both batch and serial", () => {
    const withBatch = makeGs1({ gtin: "06416542002149", expiry: "270815", batch: "FIN-LOT-1" });
    assert.deepEqual(parseGs1(withBatch), {
      raw: withBatch,
      gtin: "06416542002149",
      expiry: "2027-08-15",
      batch: "FIN-LOT-1",
    });

    const withSerial = makeGs1({ gtin: "06410000123456", expiry: "280200", serial: "SER-ONLY-9" });
    assert.deepEqual(parseGs1(withSerial), {
      raw: withSerial,
      gtin: "06410000123456",
      expiry: "2028-02",
      serial: "SER-ONLY-9",
    });

    const withBoth = makeGs1({
      gtin: "06410000123456",
      expiry: "271231",
      batch: "BATCH-EU-4",
      serial: "SN-EU-8899",
    });
    assert.deepEqual(parseGs1(withBoth), {
      raw: withBoth,
      gtin: "06410000123456",
      expiry: "2027-12-31",
      batch: "BATCH-EU-4",
      serial: "SN-EU-8899",
    });
  });
});

describe("sameGtin", () => {
  test("matches EAN-13 against GTIN-14 with leading zero and strips formatting characters", () => {
    assert.equal(sameGtin("6410000123456", "06410000123456"), true);
    assert.equal(sameGtin("06410000123456", "6410000123456"), true);
    assert.equal(sameGtin("6416542002149", "06416542002149"), true);
    assert.equal(sameGtin("00012345678905", "012345678905"), true);
    assert.equal(sameGtin("6410-0001-2345-6", "0641 0000 1234 56"), true);
    assert.equal(sameGtin("0641.6542.0021.49", "641-6542-002149"), true);
  });

  test("rejects empty, non-digit, all-zero, nullish, and distinct GTINs", () => {
    assert.equal(sameGtin("", "06410000123456"), false);
    assert.equal(sameGtin("06410000123456", ""), false);
    assert.equal(sameGtin("", ""), false);
    assert.equal(sameGtin("   ", "   "), false);
    assert.equal(sameGtin("---", "---"), false);
    assert.equal(sameGtin("00000000000000", "0000000000000"), false);
    assert.equal(sameGtin("0", "00"), false);
    assert.equal(sameGtin(null, "06410000123456"), false);
    assert.equal(sameGtin("06410000123456", undefined), false);
    assert.equal(sameGtin(null, undefined), false);
    assert.equal(sameGtin("06410000123456", "06410000123457"), false);
    assert.equal(sameGtin("6416542002149", "6416542003375"), false);
  });
});

describe("expiryEnd, isExpired, and expiryWords", () => {
  test("expiryEnd resolves exact last second for non-leap Feb, leap Feb, 30-day, 31-day, and YYYY-MM-DD dates", () => {
    assert.equal(expiryEnd("2026-02").getTime(), new Date(2026, 1, 28, 23, 59, 59).getTime());
    assert.equal(expiryEnd("2028-02").getTime(), new Date(2028, 1, 29, 23, 59, 59).getTime());
    assert.equal(expiryEnd("2026-04").getTime(), new Date(2026, 3, 30, 23, 59, 59).getTime());
    assert.equal(expiryEnd("2026-11").getTime(), new Date(2026, 10, 30, 23, 59, 59).getTime());
    assert.equal(expiryEnd("2027-08").getTime(), new Date(2027, 7, 31, 23, 59, 59).getTime());
    assert.equal(expiryEnd("2026-12").getTime(), new Date(2026, 11, 31, 23, 59, 59).getTime());
    assert.equal(expiryEnd("2027-08-15").getTime(), new Date(2027, 7, 15, 23, 59, 59).getTime());
  });

  test("isExpired keeps month-only packs valid through the entire month and marks expired right after", () => {
    assert.equal(isExpired("2026-02", new Date(2026, 1, 14, 12, 0, 0)), false);
    assert.equal(isExpired("2026-02", new Date(2026, 1, 28, 23, 59, 59)), false);
    assert.equal(isExpired("2026-02", new Date(2026, 2, 1, 0, 0, 0)), true);

    assert.equal(isExpired("2028-02", new Date(2028, 1, 28, 23, 59, 59)), false);
    assert.equal(isExpired("2028-02", new Date(2028, 1, 29, 15, 30, 0)), false);
    assert.equal(isExpired("2028-02", new Date(2028, 1, 29, 23, 59, 59)), false);
    assert.equal(isExpired("2028-02", new Date(2028, 2, 1, 0, 0, 0)), true);

    assert.equal(isExpired("2026-11", new Date(2026, 10, 14, 20, 0, 0)), false);
    assert.equal(isExpired("2026-11", new Date(2026, 10, 30, 23, 59, 59)), false);
    assert.equal(isExpired("2026-11", new Date(2026, 11, 1, 0, 0, 0)), true);

    assert.equal(isExpired("2027-08", new Date(2027, 7, 16, 9, 0, 0)), false);
    assert.equal(isExpired("2027-08", new Date(2027, 7, 31, 23, 59, 59)), false);
    assert.equal(isExpired("2027-08", new Date(2027, 8, 1, 0, 0, 0)), true);

    assert.equal(isExpired("2027-08-15", new Date(2027, 7, 15, 18, 0, 0)), false);
    assert.equal(isExpired("2027-08-15", new Date(2027, 7, 15, 23, 59, 59)), false);
    assert.equal(isExpired("2027-08-15", new Date(2027, 7, 16, 0, 0, 0)), true);

    assert.equal(isExpired("2000-01"), true);
    assert.equal(isExpired("2050-12"), false);
  });

  test("expiryWords formats YYYY-MM and YYYY-MM-DD in human-readable English", () => {
    assert.equal(expiryWords("2027-08"), "August 2027");
    assert.equal(expiryWords("2027-03-12"), "12 March 2027");
    assert.equal(expiryWords("2026-12-03"), "3 December 2026");
    assert.equal(expiryWords("2028-02"), "February 2028");
  });
});

describe("barcode.ts wrapper", () => {
  test("filters supported formats, detects all codes, extracts first barcode, and reuses detector singleton", async () => {
    assert.equal(barcodeMod.barcodeSupported, true);

    mockState.ctorCalls.length = 0;
    mockState.detectCalls.length = 0;
    mockState.getFormatsImpl = async () => ["aztec", "data_matrix", "ean_13", "pdf417"];

    const fakeCanvas = { width: 640, height: 480 } as unknown as CanvasImageSource;
    const expected: DetectedItem[] = [
      { rawValue: `]d201064165420021491727080010LOT1${GS}21SN1`, format: "data_matrix" },
      { rawValue: "6416542002149", format: "ean_13" },
    ];
    mockState.detectImpl = async () => expected;

    const codes = await barcodeMod.detectCodes(fakeCanvas);
    assert.deepEqual(codes, expected);
    assert.equal(mockState.ctorCalls.length, 1);
    assert.deepEqual(mockState.ctorCalls[0], { formats: ["ean_13", "data_matrix"] });
    assert.equal(mockState.detectCalls[0], fakeCanvas);

    const first = await barcodeMod.detectBarcode(fakeCanvas);
    assert.equal(first, expected[0].rawValue);
    assert.equal(mockState.ctorCalls.length, 1);

    mockState.detectImpl = async () => [];
    assert.equal(await barcodeMod.detectBarcode(fakeCanvas), null);
    assert.deepEqual(await barcodeMod.detectCodes(fakeCanvas), []);
  });

  test("dataMatrixSupported reflects getSupportedFormats result and swallows errors", async () => {
    mockState.getFormatsImpl = async () => ["ean_13", "data_matrix"];
    assert.equal(await barcodeMod.dataMatrixSupported(), true);

    mockState.getFormatsImpl = async () => ["ean_13", "qr_code"];
    assert.equal(await barcodeMod.dataMatrixSupported(), false);

    mockState.getFormatsImpl = async () => {
      throw new Error("format query failed");
    };
    assert.equal(await barcodeMod.dataMatrixSupported(), false);
  });

  test("detectCodes and detectBarcode swallow detect() exceptions cleanly", async () => {
    const fakeCanvas = { width: 320, height: 240 } as unknown as CanvasImageSource;
    mockState.detectImpl = async () => {
      throw new DOMException("InvalidStateError");
    };

    assert.deepEqual(await barcodeMod.detectCodes(fakeCanvas), []);
    assert.equal(await barcodeMod.detectBarcode(fakeCanvas), null);
  });

  test("falls back to full wanted format list when getSupportedFormats throws or is absent during init", async () => {
    const prevWin = globalThis.window;
    try {
      const ctorFormatsOnThrow: Array<{ formats?: string[] } | undefined> = [];
      class ThrowingFormatsDetector {
        constructor(opts?: { formats?: string[] }) {
          ctorFormatsOnThrow.push(opts);
        }
        async detect(): Promise<DetectedItem[]> {
          return [{ rawValue: "06416542002149", format: "ean_13" }];
        }
        static async getSupportedFormats(): Promise<string[]> {
          throw new Error("not implemented");
        }
      }

      Object.defineProperty(globalThis, "window", {
        value: { BarcodeDetector: ThrowingFormatsDetector },
        writable: true,
        configurable: true,
      });

      const modThrow = await importFreshBarcode("formats-throw");
      const fakeSrc = {} as CanvasImageSource;
      assert.equal(modThrow.barcodeSupported, true);
      assert.equal(await modThrow.dataMatrixSupported(), false);
      assert.equal(await modThrow.detectBarcode(fakeSrc), "06416542002149");
      assert.deepEqual(ctorFormatsOnThrow, [
        { formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "data_matrix", "qr_code"] },
      ]);

      const ctorFormatsNoStatic: Array<{ formats?: string[] } | undefined> = [];
      class NoStaticFormatsDetector {
        constructor(opts?: { formats?: string[] }) {
          ctorFormatsNoStatic.push(opts);
        }
        async detect(): Promise<DetectedItem[]> {
          return [{ rawValue: "6410000123456", format: "ean_13" }];
        }
      }

      Object.defineProperty(globalThis, "window", {
        value: { BarcodeDetector: NoStaticFormatsDetector },
        writable: true,
        configurable: true,
      });

      const modNoStatic = await importFreshBarcode("no-static-formats");
      assert.equal(modNoStatic.barcodeSupported, true);
      assert.equal(await modNoStatic.dataMatrixSupported(), false);
      assert.deepEqual(await modNoStatic.detectCodes(fakeSrc), [{ rawValue: "6410000123456", format: "ean_13" }]);
      assert.deepEqual(ctorFormatsNoStatic, [
        { formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "data_matrix", "qr_code"] },
      ]);
    } finally {
      Object.defineProperty(globalThis, "window", {
        value: prevWin,
        writable: true,
        configurable: true,
      });
    }
  });

  test("gracefully reports unsupported and returns empty results when BarcodeDetector or window is absent", async () => {
    const prevWin = globalThis.window;
    const fakeSrc = {} as CanvasImageSource;
    try {
      Object.defineProperty(globalThis, "window", {
        value: {},
        writable: true,
        configurable: true,
      });
      const modNoDetector = await importFreshBarcode("no-detector");
      assert.equal(modNoDetector.barcodeSupported, false);
      assert.equal(await modNoDetector.dataMatrixSupported(), false);
      assert.deepEqual(await modNoDetector.detectCodes(fakeSrc), []);
      assert.equal(await modNoDetector.detectBarcode(fakeSrc), null);

      Reflect.deleteProperty(globalThis, "window");
      const modNoWindow = await importFreshBarcode("no-window");
      assert.equal(modNoWindow.barcodeSupported, false);
      assert.equal(await modNoWindow.dataMatrixSupported(), false);
      assert.deepEqual(await modNoWindow.detectCodes(fakeSrc), []);
      assert.equal(await modNoWindow.detectBarcode(fakeSrc), null);
    } finally {
      Object.defineProperty(globalThis, "window", {
        value: prevWin,
        writable: true,
        configurable: true,
      });
    }
  });
});
