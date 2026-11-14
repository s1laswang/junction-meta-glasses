import { test } from "node:test";
import assert from "node:assert/strict";
import { gs1Date, gtin14, gtinValid, parseGs1 } from "../src/gs1.ts";

const GS = "\x1d";

test("GTIN check digit", () => {
  assert.ok(gtinValid("09501101530003"));   // GS1 reference GTIN
  assert.ok(gtinValid("4006381333931"));    // EAN-13
  assert.ok(!gtinValid("09501101530004"));
  assert.equal(gtin14("4006381333931"), "04006381333931");
  assert.equal(gtin14("00000000000000"), undefined);
});

test("GS1 dates: YYMMDD, DD=00 = end of month, invalid rejected", () => {
  assert.equal(gs1Date("270831"), "2027-08-31");
  assert.equal(gs1Date("270800"), "2027-08");
  assert.equal(gs1Date("241100"), "2024-11");
  assert.equal(gs1Date("271331"), undefined);
  assert.equal(gs1Date("270231"), "2027-02-31"); // like web/src/lib/gs1.ts: no day validation
  assert.equal(gs1Date("510101"), "1951-01-01");
});

test("raw EU FMD DataMatrix with ]d2 prefix and GS separators", () => {
  // typical pack order: GTIN, expiry, batch <GS>, serial
  const raw = `]d201095011015300031727083110AB12C${GS}2112345ABCDE`;
  assert.deepEqual(parseGs1(raw), { raw, gtin: "09501101530003", expiry: "2027-08-31", batch: "AB12C", serial: "12345ABCDE" });
});

test("raw with leading FNC1, serial before batch, national number AI 714", () => {
  const raw = `${GS}010950110153000321SN998877${GS}17280500${GS}10LOT-7${GS}714ABC123`;
  const c = parseGs1(raw)!;
  assert.equal(c.gtin, "09501101530003");
  assert.equal(c.serial, "SN998877");
  assert.equal(c.expiry, "2028-05");
  assert.equal(c.batch, "LOT-7");
});

test("human-readable parenthesised form", () => {
  const c = parseGs1("(01)09501101530003(17)241100(10)B-42(21)XYZ")!;
  assert.equal(c.gtin, "09501101530003");
  assert.equal(c.expiry, "2024-11");
  assert.equal(c.batch, "B-42");
  assert.equal(c.serial, "XYZ");
});

test("web mock format (makeGs1): 01 gtin 17 yymmdd 10 batch GS 21 serial", () => {
  const c = parseGs1(`010950110153000317270800` + `10B7${GS}21S9`)!;
  assert.deepEqual({ gtin: c.gtin, expiry: c.expiry, batch: c.batch, serial: c.serial }, { gtin: "09501101530003", expiry: "2027-08", batch: "B7", serial: "S9" });
});

test("junk and non-GS1 payloads are rejected; check digit is not enforced (same as web)", () => {
  assert.equal(parseGs1("hello world"), undefined);
  assert.equal(parseGs1("https://example.com/x"), undefined);
  const c = parseGs1("(01)09501101530004(17)270831");
  assert.equal(c?.gtin, "09501101530004");
  assert.equal(c?.expiry, "2027-08-31");
});
