import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { REPO_ROOT, SERVER_DIR } from "../src/env.ts";
import {
  parseJpegHeader,
  rankBase64Frames,
  scoreFrameOpticalQuality,
} from "../src/frameRanker.ts";
import * as verifyMod from "../src/verify.ts";
import { jpegSharpness, jpegSize, toProfile } from "../src/verify.ts";

function makeSegment(marker: number, payload: Buffer, fillCount = 0): Buffer {
  const prefix = Buffer.alloc(fillCount + 4, 0xff);
  prefix[fillCount + 1] = marker;
  prefix.writeUInt16BE(payload.length + 2, fillCount + 2);
  return Buffer.concat([prefix, payload]);
}

function makeSofPayload(w: number, h: number): Buffer {
  const p = Buffer.alloc(15);
  p[0] = 8;
  p.writeUInt16BE(h, 1);
  p.writeUInt16BE(w, 3);
  p[5] = 3;
  p[6] = 1;
  p[7] = 0x22;
  p[8] = 0;
  p[9] = 2;
  p[10] = 0x11;
  p[11] = 1;
  p[12] = 3;
  p[13] = 0x11;
  p[14] = 1;
  return p;
}

function makeDqtSegment(fillCount = 0): Buffer {
  const payload = Buffer.alloc(65, 16);
  payload[0] = 0;
  return makeSegment(0xdb, payload, fillCount);
}

function makeSosHeader(fillCount = 0): Buffer {
  const payload = Buffer.from([0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00]);
  return makeSegment(0xda, payload, fillCount);
}

function makeEntropyScan(byteCount: number, seed = 17): Buffer {
  const out = Buffer.alloc(byteCount);
  let state = seed >>> 0;
  for (let i = 0; i < byteCount; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const v = (state >>> 24) & 0xff;
    out[i] = v === 0xff ? 0x7e : v;
  }
  return out;
}

function buildTestJpeg(opts: {
  w: number;
  h: number;
  sofMarker?: number;
  fillBeforeSof?: number;
  includeDqt?: boolean;
  extraBeforeSof?: Buffer[];
  scanRaw?: Buffer;
  commentText?: string;
}): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  if (opts.commentText) {
    parts.push(makeSegment(0xfe, Buffer.from(opts.commentText, "utf8")));
  }
  if (opts.includeDqt !== false) {
    parts.push(makeDqtSegment(1));
  }
  if (opts.extraBeforeSof) {
    parts.push(...opts.extraBeforeSof);
  }
  parts.push(makeSegment(opts.sofMarker ?? 0xc0, makeSofPayload(opts.w, opts.h), opts.fillBeforeSof ?? 0));
  if (opts.scanRaw) {
    parts.push(makeSosHeader(1), opts.scanRaw);
  }
  parts.push(Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

test("parseJpegHeader and jpegSize skip ITU T.81 0xFF fill bytes and embedded APP1 thumbnails", () => {
  const fakeEmbeddedThumb = Buffer.concat([
    Buffer.from("Exif\0\0", "ascii"),
    Buffer.from([0xff, 0xd8]),
    makeSegment(0xc0, makeSofPayload(160, 120)),
    Buffer.from([0xff, 0xd9]),
  ]);
  const app1 = makeSegment(0xe1, fakeEmbeddedThumb, 3);
  const scan = makeEntropyScan(4096, 99);
  const jpg = buildTestJpeg({
    w: 1280,
    h: 720,
    sofMarker: 0xc2,
    fillBeforeSof: 5,
    extraBeforeSof: [app1],
    scanRaw: scan,
  });

  const hdr = parseJpegHeader(jpg);
  assert.deepEqual(hdr, {
    w: 1280,
    h: 720,
    hasDqt: true,
    hasSos: true,
    scanBytes: 4096,
  });
  assert.deepEqual(jpegSize(jpg), { w: 1280, h: 720 });
});

test("parseJpegHeader handles standalone RST0..RST7, TEM, SOI, stuffed 0x00, and non-SOF C4/C8/CC markers", () => {
  const standalonePreMarkers = Buffer.from([
    0xff, 0xd0,
    0xff, 0xd3,
    0xff, 0xff, 0xd7,
    0xff, 0x01,
    0xff, 0x00,
    0xff, 0xd8,
  ]);
  const dht = makeSegment(0xc4, Buffer.from([0x00, 0x01, 0x02, 0x03]));
  const jpgExt = makeSegment(0xc8, Buffer.from([0x10, 0x20, 0x30, 0x40, 0x50, 0x60]));
  const dac = makeSegment(0xcc, Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]));

  const scanPartA = makeEntropyScan(600, 11);
  const scanPartB = makeEntropyScan(400, 22);
  const scanWithRstAndStuffing = Buffer.concat([
    scanPartA,
    Buffer.from([0xff, 0x00]),
    Buffer.from([0xff, 0xd0]),
    Buffer.from([0xff, 0xd7]),
    scanPartB,
  ]);

  const jpg = buildTestJpeg({
    w: 640,
    h: 480,
    fillBeforeSof: 2,
    extraBeforeSof: [standalonePreMarkers, dht, jpgExt, dac],
    scanRaw: scanWithRstAndStuffing,
  });

  const hdr = parseJpegHeader(jpg);
  assert.deepEqual(hdr, {
    w: 640,
    h: 480,
    hasDqt: true,
    hasSos: true,
    scanBytes: 1001,
  });
  assert.deepEqual(jpegSize(jpg), { w: 640, h: 480 });
});

test("parseJpegHeader and jpegSize reject len < 2, out-of-bounds segments, and truncated JPEGs without throwing", () => {
  const lenZero = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00]),
    makeSegment(0xc0, makeSofPayload(768, 768)),
    Buffer.from([0xff, 0xd9]),
  ]);
  assert.equal(parseJpegHeader(lenZero), undefined);
  assert.equal(jpegSize(lenZero), undefined);

  const lenOne = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01]),
    makeSegment(0xc0, makeSofPayload(768, 768)),
    Buffer.from([0xff, 0xd9]),
  ]);
  assert.equal(parseJpegHeader(lenOne), undefined);
  assert.equal(jpegSize(lenOne), undefined);

  const shortSof = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x06, 0x08, 0x03, 0x00, 0x03, 0xff, 0xd9]);
  assert.equal(parseJpegHeader(shortSof), undefined);
  assert.equal(jpegSize(shortSof), undefined);

  const oobSegment = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x40, 0x4a, 0x46, 0x49, 0x46]);
  assert.equal(parseJpegHeader(oobSegment), undefined);
  assert.equal(jpegSize(oobSegment), undefined);

  const trailingFill = Buffer.from([0xff, 0xd8, 0xff, 0xff, 0xff]);
  assert.equal(parseJpegHeader(trailingFill), undefined);
  assert.equal(jpegSize(trailingFill), undefined);

  assert.equal(parseJpegHeader(Buffer.alloc(0)), undefined);
  assert.equal(parseJpegHeader(Buffer.from([0xff, 0xd8])), undefined);
  assert.equal(parseJpegHeader(Buffer.from("not a jpeg buffer")), undefined);

  const serverFixture = fs.readFileSync(path.join(SERVER_DIR, "fixtures", "amlodipine.jpg"));
  assert.deepEqual(jpegSize(serverFixture), { w: 768, h: 768 });
  const fullHdr = parseJpegHeader(serverFixture);
  assert.ok(fullHdr);
  assert.equal(fullHdr.w, 768);
  assert.equal(fullHdr.h, 768);
  assert.equal(fullHdr.hasDqt, true);
  assert.equal(fullHdr.hasSos, true);
  assert.ok(fullHdr.scanBytes > 90_000);

  const sofOnlyNoEoi = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    makeSegment(0xc0, makeSofPayload(768, 768)),
  ]);
  assert.equal(parseJpegHeader(sofOnlyNoEoi), undefined);
  assert.equal(jpegSize(sofOnlyNoEoi), undefined);

  for (const cut of [10, 150, 220, 500, 4000, serverFixture.length - 1]) {
    const truncated = serverFixture.subarray(0, cut);
    assert.equal(parseJpegHeader(truncated), undefined, `expected undefined at cut=${cut}`);
    assert.equal(jpegSize(truncated), undefined, `expected jpegSize undefined at cut=${cut}`);
  }
});

test("parseJpegHeader, jpegSize, and scoreFrameOpticalQuality reject 0x0, 0xH, and Wx0 dimensions safely", () => {
  for (const [w, h] of [
    [0, 0],
    [0, 768],
    [768, 0],
  ] as const) {
    const zeroDimJpg = buildTestJpeg({ w, h, scanRaw: makeEntropyScan(2048, 33) });
    assert.equal(parseJpegHeader(zeroDimJpg), undefined);
    assert.equal(jpegSize(zeroDimJpg), undefined);
    const q = scoreFrameOpticalQuality(zeroDimJpg);
    assert.deepEqual(q, {
      score: 0,
      sharpness: 0,
      glarePenalty: 0,
      validJpeg: false,
      width: 0,
      height: 0,
    });
    const legacySharp = jpegSharpness(zeroDimJpg);
    assert.equal(Number.isFinite(legacySharp), true);
    assert.ok(legacySharp >= 0 && legacySharp <= 1);
  }
});

test("scoreFrameOpticalQuality ranks sharp amlodipine.jpg strictly above blurry_amlodipine.jpg in web/public/fixtures", () => {
  const fixturesDir = path.join(REPO_ROOT, "web", "public", "fixtures");
  const sharpBuf = fs.readFileSync(path.join(fixturesDir, "amlodipine.jpg"));
  const blurryBuf = fs.readFileSync(path.join(fixturesDir, "blurry_amlodipine.jpg"));

  const sharpQ = scoreFrameOpticalQuality(sharpBuf);
  const blurryQ = scoreFrameOpticalQuality(blurryBuf);
  const repeatSharpQ = scoreFrameOpticalQuality(sharpBuf);
  assert.deepEqual(sharpQ, repeatSharpQ);

  for (const q of [sharpQ, blurryQ]) {
    assert.equal(q.validJpeg, true);
    assert.equal(q.width, 768);
    assert.equal(q.height, 768);
    assert.ok(q.score >= 0 && q.score <= 1);
    assert.ok(q.sharpness >= 0 && q.sharpness <= 1);
    assert.ok(q.glarePenalty >= 0 && q.glarePenalty <= 1);
  }

  assert.ok(
    sharpQ.score > blurryQ.score,
    `expected sharp score (${sharpQ.score}) > blurry score (${blurryQ.score})`,
  );
  assert.ok(
    sharpQ.sharpness > blurryQ.sharpness,
    `expected sharp sharpness (${sharpQ.sharpness}) > blurry sharpness (${blurryQ.sharpness})`,
  );

  const bloatedApp1 = makeSegment(0xe1, Buffer.alloc(20_000, 0x33));
  const bloatedBlurry = Buffer.concat([
    blurryBuf.subarray(0, 2),
    bloatedApp1,
    blurryBuf.subarray(2),
  ]);
  assert.ok(bloatedBlurry.length > sharpBuf.length);
  const bloatedBlurryQ = scoreFrameOpticalQuality(bloatedBlurry);
  assert.ok(sharpQ.score > bloatedBlurryQ.score);
});

test("scoreFrameOpticalQuality penalizes low-BPP glare/washout, clipped high-byte runs, and flat scan buffers", () => {
  const fixturesDir = path.join(REPO_ROOT, "web", "public", "fixtures");
  const sharpBuf = fs.readFileSync(path.join(fixturesDir, "amlodipine.jpg"));
  const blurryBuf = fs.readFileSync(path.join(fixturesDir, "blurry_amlodipine.jpg"));
  const sharpQ = scoreFrameOpticalQuality(sharpBuf);
  const blurryQ = scoreFrameOpticalQuality(blurryBuf);

  const washedOutLowBpp = buildTestJpeg({
    w: 768,
    h: 768,
    scanRaw: makeEntropyScan(4000, 77),
  });
  const washedOutQ = scoreFrameOpticalQuality(washedOutLowBpp);
  assert.equal(washedOutQ.validJpeg, true);
  assert.ok(washedOutQ.glarePenalty > 0.5, `expected low-BPP glarePenalty > 0.5, got ${washedOutQ.glarePenalty}`);
  assert.ok(washedOutQ.score < blurryQ.score);

  const clippedChunks: Buffer[] = [];
  for (let i = 0; i < 1000; i++) {
    clippedChunks.push(Buffer.alloc(40, 0xfe), Buffer.from([0xff, 0x00]), makeEntropyScan(24, i + 1));
  }
  const clippedHighRunJpg = buildTestJpeg({
    w: 768,
    h: 768,
    scanRaw: Buffer.concat(clippedChunks),
  });
  assert.ok(clippedHighRunJpg.length > sharpBuf.length);
  const clippedQ = scoreFrameOpticalQuality(clippedHighRunJpg);
  assert.equal(clippedQ.validJpeg, true);
  assert.ok(clippedQ.glarePenalty > 0.8, `expected clipped glarePenalty > 0.8, got ${clippedQ.glarePenalty}`);
  assert.ok(clippedQ.score < blurryQ.score);

  const flatScanJpg = buildTestJpeg({
    w: 768,
    h: 768,
    scanRaw: Buffer.alloc(65_000, 0x55),
  });
  const flatQ = scoreFrameOpticalQuality(flatScanJpg);
  assert.equal(flatQ.validJpeg, true);
  assert.equal(flatQ.glarePenalty, 1);
  assert.equal(flatQ.score, 0);
});

test("rankBase64Frames orders frames by optical quality score with recency tie-breaking and verify.ts re-exports helpers", () => {
  const fixturesDir = path.join(REPO_ROOT, "web", "public", "fixtures");
  const sharpB64 = fs.readFileSync(path.join(fixturesDir, "amlodipine.jpg")).toString("base64");
  const blurryB64 = fs.readFileSync(path.join(fixturesDir, "blurry_amlodipine.jpg")).toString("base64");
  const washedOutB64 = buildTestJpeg({
    w: 768,
    h: 768,
    scanRaw: makeEntropyScan(3500, 5),
  }).toString("base64");
  const corruptB64 = Buffer.from("corrupt-non-jpeg-payload").toString("base64");

  assert.deepEqual(
    rankBase64Frames([corruptB64, washedOutB64, blurryB64, sharpB64]),
    [sharpB64, blurryB64],
  );
  assert.deepEqual(
    rankBase64Frames([washedOutB64, sharpB64, blurryB64], 1),
    [sharpB64],
  );
  assert.deepEqual(
    rankBase64Frames([corruptB64, washedOutB64, blurryB64, sharpB64], 3),
    [sharpB64, blurryB64, washedOutB64],
  );

  const sharedScan = makeEntropyScan(48_000, 123);
  const olderTieB64 = buildTestJpeg({
    w: 768,
    h: 768,
    commentText: "older-capture-slot-0",
    scanRaw: sharedScan,
  }).toString("base64");
  const newerTieB64 = buildTestJpeg({
    w: 768,
    h: 768,
    commentText: "newer-capture-slot-1",
    scanRaw: sharedScan,
  }).toString("base64");
  assert.notEqual(olderTieB64, newerTieB64);
  assert.equal(
    scoreFrameOpticalQuality(Buffer.from(olderTieB64, "base64")).score,
    scoreFrameOpticalQuality(Buffer.from(newerTieB64, "base64")).score,
  );
  assert.deepEqual(rankBase64Frames([olderTieB64, newerTieB64], 2), [newerTieB64, olderTieB64]);

  const dataUrlSharp = `data:image/jpeg;base64,${sharpB64}`;
  assert.deepEqual(rankBase64Frames([blurryB64, dataUrlSharp], 1), [dataUrlSharp]);

  assert.deepEqual(rankBase64Frames([]), []);
  assert.deepEqual(rankBase64Frames(["", "   "]), []);
  assert.deepEqual(rankBase64Frames([sharpB64], 0), []);
  assert.deepEqual(rankBase64Frames([sharpB64], -2), []);
  assert.deepEqual(rankBase64Frames([sharpB64], Number.NaN), []);

  assert.equal(verifyMod.scoreFrameOpticalQuality, scoreFrameOpticalQuality);
  assert.equal(verifyMod.rankBase64Frames, rankBase64Frames);
  for (const key of [
    "FrameRing",
    "jpegSharpness",
    "jpegSize",
    "toLabelRead",
    "readLabel",
    "verify",
    "emptyProfile",
    "toProfile",
    "LABEL_SCHEMA",
    "VERIFY_PROMPT",
    "scoreFrameOpticalQuality",
    "rankBase64Frames",
  ]) {
    assert.equal(key in verifyMod, true, `verify.ts must export ${key}`);
  }
});

test("toProfile rejects NaN, Infinity, and -Infinity doseLog timestamps while preserving finite numeric timestamps", () => {
  const p = toProfile({
    doseLog: [
      { medId: "nan-ts", ts: Number.NaN },
      { medId: "pos-inf", ts: Number.POSITIVE_INFINITY },
      { medId: "neg-inf", ts: Number.NEGATIVE_INFINITY },
      { medId: "str-ts", ts: "1700000000000" },
      { medId: "null-ts", ts: null },
      { medId: "valid-zero", ts: 0 },
      { medId: "valid-epoch", ts: 1_700_000_123_456 },
    ],
  });

  assert.deepEqual(p.doseLog, [
    { medId: "valid-zero", ts: 0 },
    { medId: "valid-epoch", ts: 1_700_000_123_456 },
  ]);
});

test("frameRanker.ts, verify.ts, and frame-ranker.test.ts contain zero comments, zero em dashes, zero trailers, and zero keys", () => {
  const slash = String.fromCharCode(47);
  const star = String.fromCharCode(42);
  const doubleSlash = slash + slash;
  const blockOpen = slash + star;
  const blockClose = star + slash;
  const emDash = String.fromCharCode(0x2014);
  const coAuthoredRe = new RegExp(["Co", "Authored", "By"].join("-"), "i");
  const apiKeyRe = new RegExp("AIza" + "[0-9A-Za-z_-]{20,}");

  const targetFiles = [
    path.join(REPO_ROOT, "server", "src", "frameRanker.ts"),
    path.join(REPO_ROOT, "server", "src", "verify.ts"),
    path.join(REPO_ROOT, "server", "test", "frame-ranker.test.ts"),
  ];

  for (const fullPath of targetFiles) {
    const rel = path.relative(REPO_ROOT, fullPath);
    const src = fs.readFileSync(fullPath, "utf8");
    assert.equal(src.includes(doubleSlash), false, `${rel} must not contain line comment token`);
    assert.equal(src.includes(blockOpen), false, `${rel} must not contain block comment open token`);
    assert.equal(src.includes(blockClose), false, `${rel} must not contain block comment close token`);
    assert.equal(src.includes(emDash), false, `${rel} must not contain em dash`);
    assert.equal(coAuthoredRe.test(src), false, `${rel} must not contain trailer token`);
    assert.equal(apiKeyRe.test(src), false, `${rel} must not contain API key`);
  }
});
