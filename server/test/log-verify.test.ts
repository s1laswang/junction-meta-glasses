import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { SERVER_DIR } from "../src/env.ts";
import { errSummary, redact } from "../src/log.ts";
import { FrameRing, jpegSharpness, jpegSize, toProfile, type Frame } from "../src/verify.ts";

const FAKE_KEY = ["AIza", "SyTestFakeKey1234567890"].join("");

function mkFrame(id: string, sharpness: number, ts: number): Frame {
  return { data: id, sharpness, ts, bytes: 1024, source: "phone" };
}

test("redact masks sensitive keys and preserves safe primitives", () => {
  const sensitiveKeys = [
    "text", "data", "transcript", "image", "frame", "frames", "audio",
    "profile", "speech", "headline", "question", "args", "prompt",
    "body", "key", "apikey", "api_key", "value", "API_KEY", "Transcript",
  ];
  const input: Record<string, string | number | boolean | null | undefined> = {
    model: "gemini-3.8-flash",
    ms: 142,
    ok: true,
    detail: null,
    omitted: undefined,
  };
  for (const k of sensitiveKeys) input[k] = "secret-user-content";
  const out = redact(input);
  for (const k of sensitiveKeys) assert.equal(out[k], "[redacted]", k);
  assert.equal(out.model, "gemini-3.8-flash");
  assert.equal(out.ms, 142);
  assert.equal(out.ok, true);
  assert.equal(out.detail, null);
  assert.equal("omitted" in out, false);
});

test("redact replaces strings longer than 48 chars with length marker", () => {
  const exact48 = "a".repeat(48);
  const long49 = "b".repeat(49);
  const long80 = "c".repeat(80);
  const err160 = "d".repeat(160);
  const err165 = "e".repeat(165);
  const out = redact({ exact48, long49, long80, err: err160 });
  assert.equal(out.exact48, exact48);
  assert.equal(out.long49, "[redacted:49ch]");
  assert.equal(out.long80, "[redacted:80ch]");
  assert.equal(out.err, err160);
  assert.equal(redact({ err: err165 }).err, "[redacted:165ch]");
});

test("redact and errSummary scrub Gemini-shaped keys from strings and errors", () => {
  const out = redact({
    note: `token=${FAKE_KEY}`,
    err: `auth failed for ${FAKE_KEY} on live socket`,
  });
  assert.equal(out.note, "token=[key]");
  assert.equal(out.err, "auth failed for [key] on live socket");

  const summarized = errSummary(new Error(`403 Forbidden\n  key=${FAKE_KEY}\tbad   credentials`));
  assert.equal(summarized, "403 Forbidden key=[key] bad credentials");
  assert.equal(summarized.includes("AIza"), false);

  const nonErr = errSummary(`raw failure ${FAKE_KEY} ${"x".repeat(200)}`);
  assert.ok(nonErr.startsWith("raw failure [key] "));
  assert.equal(nonErr.length, 160);
});

test("FrameRing evicts oldest past capacity, picks sharpest within sameItemMs of latest, and clears", () => {
  const ring = new FrameRing(5);
  assert.equal(ring.length, 0);
  assert.equal(ring.lastTs, 0);
  assert.deepEqual(ring.pick(2, 5000, 10_000), []);

  ring.push(mkFrame("evicted", 0.99, 5000));
  ring.push(mkFrame("old_sharp", 0.98, 2000));
  ring.push(mkFrame("r1", 0.95, 6000));
  ring.push(mkFrame("r2", 0.88, 7000));
  ring.push(mkFrame("r3", 0.52, 8000));
  ring.push(mkFrame("r4", 0.74, 9000));

  assert.equal(ring.length, 5);
  assert.equal(ring.lastTs, 9000);

  const recentPick = ring.pick(2, 5000, 10_000);
  assert.deepEqual(recentPick.map((f) => f.data), ["r4", "r3"]);

  const widerWindowPick = ring.pick(2, 5000, 25_000, 2000);
  assert.deepEqual(widerWindowPick.map((f) => f.data), ["r2", "r4"]);

  const widerWindowPick3 = ring.pick(3, 5000, 25_000, 2000);
  assert.deepEqual(widerWindowPick3.map((f) => f.data), ["r2", "r4", "r3"]);

  ring.clear();
  assert.equal(ring.length, 0);
  assert.equal(ring.lastTs, 0);
  assert.deepEqual(ring.pick(2), []);
});

test("jpegSize and jpegSharpness handle amlodipine.jpg and non-JPEG buffers", () => {
  const jpg = fs.readFileSync(path.join(SERVER_DIR, "fixtures", "amlodipine.jpg"));
  const dim = jpegSize(jpg);
  assert.deepEqual(dim, { w: 768, h: 768 });
  const sharp = jpegSharpness(jpg);
  assert.ok(sharp > 0.3 && sharp <= 1);

  assert.equal(jpegSize(Buffer.alloc(0)), undefined);
  assert.equal(jpegSharpness(Buffer.alloc(0)), 0);

  const notJpeg = Buffer.from("plain text buffer, definitely not a JPEG image");
  assert.equal(jpegSize(notJpeg), undefined);
  const notJpegSharp = jpegSharpness(notJpeg);
  assert.ok(notJpegSharp > 0 && notJpegSharp < 0.01);

  const truncatedJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  assert.equal(jpegSize(truncatedJpeg), undefined);

  const huge = Buffer.alloc(400_000, 0x55);
  assert.equal(jpegSharpness(huge), 1);
});

test("toProfile sanitizes malformed and hostile payloads defensively", () => {
  assert.deepEqual(toProfile(null), { meds: [], allergies: [], avoid: [], doseLog: [], lang: "en" });
  assert.deepEqual(toProfile("hostile"), { meds: [], allergies: [], avoid: [], doseLog: [], lang: "en" });
  assert.deepEqual(toProfile({ meds: "nope", allergies: 42, avoid: {}, doseLog: false, lang: 123 }), {
    meds: [], allergies: [], avoid: [], doseLog: [], lang: "en",
  });

  const hostileMeds = Array.from({ length: 60 }, (_, i) => ({
    id: i === 0 ? "" : "x".repeat(100) + i,
    name: "N".repeat(200),
    ingredient: "I".repeat(200),
    strength: "S".repeat(80),
    schedule: ["", 123, "morning", ..."t".repeat(12).split("").map((c, j) => `${c}${"z".repeat(60)}${j}`)],
    barcode: i === 0 ? "B".repeat(60) : "",
    notes: i === 0 ? "M".repeat(300) : null,
  }));
  const hostileAllergies = ["", null, 99, ...Array.from({ length: 40 }, (_, i) => `allergy-${i}-${"a".repeat(80)}`)];
  const hostileAvoid = [undefined, "", ...Array.from({ length: 35 }, (_, i) => `avoid-${i}-${"v".repeat(80)}`)];
  const hostileDoseLog = [
    null,
    {},
    { medId: "bad1", ts: "not-a-number" },
    { medId: "bad2" },
    ...Array.from({ length: 510 }, (_, i) => ({ medId: i === 509 ? 999 : `m-${i}-${"k".repeat(80)}`, ts: 1000 + i })),
  ];

  const p = toProfile({
    meds: hostileMeds,
    allergies: hostileAllergies,
    avoid: hostileAvoid,
    doseLog: hostileDoseLog,
    lang: "",
  });

  assert.equal(p.meds.length, 50);
  assert.equal(p.meds[0].id, "med0");
  assert.equal(p.meds[1].id.length, 64);
  assert.equal(p.meds[0].name.length, 120);
  assert.equal(p.meds[0].ingredient.length, 120);
  assert.equal(p.meds[0].strength.length, 40);
  assert.equal(p.meds[0].schedule.length, 8);
  assert.equal(p.meds[0].schedule[0], "morning");
  assert.equal(p.meds[0].schedule[1].length, 40);
  assert.equal(p.meds[0].barcode?.length, 32);
  assert.equal(p.meds[0].notes?.length, 200);
  assert.equal("barcode" in p.meds[1], false);
  assert.equal("notes" in p.meds[1], false);

  assert.equal(p.allergies.length, 30);
  assert.equal(p.allergies[0].length, 60);
  assert.equal(p.avoid.length, 30);
  assert.equal(p.avoid[0].length, 60);

  assert.equal(p.doseLog.length, 500);
  assert.equal(p.doseLog[0].ts, 1010);
  assert.equal(p.doseLog[0].medId.length, 64);
  assert.equal(p.doseLog[499].ts, 1509);
  assert.equal(p.doseLog[499].medId, "");

  assert.equal(p.lang, "en");
  assert.equal(toProfile({ lang: "fi-FI-extra-long-locale-tag" }).lang.length, 16);
});
