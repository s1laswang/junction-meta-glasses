import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(TEST_DIR, "..", "..");
const EM_DASH = String.fromCharCode(0x2014);
const LINE_CMT = String.fromCharCode(47, 47);
const BLOCK_CMT = String.fromCharCode(47, 42);
const HTML_CMT = String.fromCharCode(60, 33, 45, 45);

type Box = {
  type: string;
  offset: number;
  size: number;
  bodyOffset: number;
  end: number;
};

function parseBoxes(buf: Buffer, start = 0, end = buf.length): Box[] {
  const boxes: Box[] = [];
  let pos = start;
  while (pos + 8 <= end) {
    const rawSize = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    let size = rawSize;
    let headerLen = 8;
    if (rawSize === 1) {
      assert.ok(pos + 16 <= end, `Truncated 64-bit MP4 box "${type}" at ${pos}`);
      size = Number(buf.readBigUInt64BE(pos + 8));
      headerLen = 16;
    } else if (rawSize === 0) {
      size = end - pos;
    }
    assert.ok(size >= headerLen, `Invalid MP4 box size ${size} for "${type}" at ${pos}`);
    const boxEnd = pos + size;
    assert.ok(boxEnd <= end, `MP4 box "${type}" at ${pos} overflows parent (${boxEnd} > ${end})`);
    boxes.push({ type, offset: pos, size, bodyOffset: pos + headerLen, end: boxEnd });
    pos = boxEnd;
  }
  return boxes;
}

function parseMvhdSeconds(buf: Buffer, mvhd: Box): number {
  const version = buf.readUInt8(mvhd.bodyOffset);
  if (version === 0) {
    const timescale = buf.readUInt32BE(mvhd.bodyOffset + 12);
    const duration = buf.readUInt32BE(mvhd.bodyOffset + 16);
    assert.ok(timescale > 0, "mvhd timescale must be > 0");
    return duration / timescale;
  }
  if (version === 1) {
    const timescale = buf.readUInt32BE(mvhd.bodyOffset + 20);
    const duration = Number(buf.readBigUInt64BE(mvhd.bodyOffset + 24));
    assert.ok(timescale > 0, "mvhd v1 timescale must be > 0");
    return duration / timescale;
  }
  assert.fail(`Unsupported mvhd version ${version}`);
}

function parseTkhdDimensions(buf: Buffer, tkhd: Box): { width: number; height: number } {
  const version = buf.readUInt8(tkhd.bodyOffset);
  const widthOffset = version === 1 ? tkhd.bodyOffset + 88 : tkhd.bodyOffset + 76;
  const heightOffset = widthOffset + 4;
  assert.ok(heightOffset + 4 <= tkhd.end, "tkhd box too small for width/height fields");
  const widthFixed = buf.readUInt32BE(widthOffset);
  const heightFixed = buf.readUInt32BE(heightOffset);
  return {
    width: widthFixed >>> 16,
    height: heightFixed >>> 16,
  };
}

function parseTrackInfo(buf: Buffer, trak: Box): {
  handler: string;
  codec: string;
  width: number;
  height: number;
} {
  const trakChildren = parseBoxes(buf, trak.bodyOffset, trak.end);
  const tkhd = trakChildren.find((b) => b.type === "tkhd");
  const mdia = trakChildren.find((b) => b.type === "mdia");
  assert.ok(tkhd, "Expected tkhd inside trak");
  assert.ok(mdia, "Expected mdia inside trak");

  const dims = parseTkhdDimensions(buf, tkhd);
  const mdiaChildren = parseBoxes(buf, mdia.bodyOffset, mdia.end);
  const hdlr = mdiaChildren.find((b) => b.type === "hdlr");
  const minf = mdiaChildren.find((b) => b.type === "minf");
  assert.ok(hdlr, "Expected hdlr inside mdia");
  assert.ok(minf, "Expected minf inside mdia");

  const handler = buf.toString("ascii", hdlr.bodyOffset + 8, hdlr.bodyOffset + 12);
  const minfChildren = parseBoxes(buf, minf.bodyOffset, minf.end);
  const stbl = minfChildren.find((b) => b.type === "stbl");
  assert.ok(stbl, "Expected stbl inside minf");

  const stblChildren = parseBoxes(buf, stbl.bodyOffset, stbl.end);
  const stsd = stblChildren.find((b) => b.type === "stsd");
  assert.ok(stsd, "Expected stsd inside stbl");

  const entryCount = buf.readUInt32BE(stsd.bodyOffset + 4);
  assert.ok(entryCount >= 1, "Expected at least one sample description in stsd");
  const codec = buf.toString("ascii", stsd.bodyOffset + 12, stsd.bodyOffset + 16);

  return { handler, codec, width: dims.width, height: dims.height };
}

describe("Mock demo video contract (docs/demo/holdup-mock-demo.mp4)", () => {
  const mp4Path = path.join(REPO_DIR, "docs", "demo", "holdup-mock-demo.mp4");
  const scriptPath = path.join(REPO_DIR, "scripts", "record-mock-demo.mjs");
  const docPath = path.join(REPO_DIR, "docs", "demo", "README.md");
  const testPath = path.join(REPO_DIR, "web", "test", "mockDemoVideoContract.test.ts");

  test("holdup-mock-demo.mp4 exists within size budget and has valid +faststart 1280x720 H.264+AAC MP4 structure (60..90s)", () => {
    assert.ok(fs.existsSync(mp4Path), "Expected docs/demo/holdup-mock-demo.mp4 to exist");
    const stat = fs.statSync(mp4Path);
    assert.ok(stat.size > 200 * 1024, `Expected MP4 > 200 KB, got ${stat.size} bytes`);
    assert.ok(stat.size < 4 * 1024 * 1024, `Expected MP4 < 4 MB, got ${stat.size} bytes`);

    const buf = fs.readFileSync(mp4Path);
    const topBoxes = parseBoxes(buf);
    assert.ok(topBoxes.length >= 3, "Expected ftyp, moov, and mdat top-level boxes");
    assert.equal(topBoxes[0].type, "ftyp", "First MP4 atom must be ftyp");

    const moovIdx = topBoxes.findIndex((b) => b.type === "moov");
    const mdatIdx = topBoxes.findIndex((b) => b.type === "mdat");
    assert.ok(moovIdx >= 0, "Expected moov atom in MP4");
    assert.ok(mdatIdx >= 0, "Expected mdat atom in MP4");
    assert.ok(moovIdx < mdatIdx, "Expected moov atom before mdat (+faststart)");

    const moov = topBoxes[moovIdx];
    const moovChildren = parseBoxes(buf, moov.bodyOffset, moov.end);
    const mvhd = moovChildren.find((b) => b.type === "mvhd");
    assert.ok(mvhd, "Expected mvhd atom inside moov");

    const durationSeconds = parseMvhdSeconds(buf, mvhd);
    assert.ok(
      durationSeconds >= 60 && durationSeconds <= 90,
      `Expected MP4 duration between 60.0s and 90.0s, got ${durationSeconds.toFixed(2)}s`,
    );

    const traks = moovChildren.filter((b) => b.type === "trak").map((t) => parseTrackInfo(buf, t));
    const videoTrack = traks.find((t) => t.handler === "vide");
    const audioTrack = traks.find((t) => t.handler === "soun");
    assert.ok(videoTrack, "Expected video (vide) track in MP4");
    assert.ok(audioTrack, "Expected audio (soun) track in MP4");
    assert.equal(videoTrack.codec, "avc1", "Expected H.264 (avc1) video codec");
    assert.equal(audioTrack.codec, "mp4a", "Expected AAC (mp4a) audio codec");
    assert.equal(videoTrack.width, 1280, "Expected tkhd video width 1280");
    assert.equal(videoTrack.height, 720, "Expected tkhd video height 720");
  });

  test("generator script and docs/demo/README.md explicitly disclose ?mock=1 browser simulation and never claim physical glasses capture", () => {
    const scriptSrc = fs.readFileSync(scriptPath, "utf8");
    const readmeSrc = fs.readFileSync(docPath, "utf8");

    const requiredBanner = "SIMULATION / MOCK MODE (?mock=1) - BROWSER DEMO, NOT PHYSICAL GLASSES HARDWARE";
    assert.ok(scriptSrc.includes(requiredBanner), "Generator script must embed the permanent simulation banner");
    assert.ok(readmeSrc.includes("SIMULATION / MOCK MODE"), "docs/demo/README.md must state SIMULATION / MOCK MODE");
    assert.ok(readmeSrc.includes("?mock=1"), "docs/demo/README.md must identify ?mock=1 mode");
    assert.ok(readmeSrc.includes("HARDWARE_LOG.md"), "docs/demo/README.md must point to docs/HARDWARE_LOG.md for real hardware proof");
    assert.ok(readmeSrc.includes("docs/img/hw/"), "docs/demo/README.md must point to docs/img/hw/ for hardware evidence");
    assert.ok(readmeSrc.includes("node scripts/record-mock-demo.mjs"), "docs/demo/README.md must document the reproduction command");

    for (let beat = 1; beat <= 5; beat++) {
      assert.ok(readmeSrc.includes(`Beat ${beat}`), `docs/demo/README.md must document Beat ${beat}`);
    }

    const lines = readmeSrc.trimEnd().split("\n");
    assert.ok(
      lines.length >= 25 && lines.length <= 40,
      `docs/demo/README.md must stay concise (25..40 lines), got ${lines.length}`,
    );

    const forbiddenClaims = [
      "recorded on physical glasses",
      "filmed through the Ray-Ban lens",
      "captured from real Meta glasses",
      "live hardware recording",
    ];
    for (const claim of forbiddenClaims) {
      assert.equal(readmeSrc.toLowerCase().includes(claim.toLowerCase()), false, `README must not claim "${claim}"`);
      assert.equal(scriptSrc.toLowerCase().includes(claim.toLowerCase()), false, `Script must not claim "${claim}"`);
    }
  });

  test("new code and documentation files contain zero code comments and zero em dashes", () => {
    const codeFiles = [scriptPath, testPath];
    for (const file of codeFiles) {
      const src = fs.readFileSync(file, "utf8");
      const rel = path.relative(REPO_DIR, file);
      assert.equal(src.includes(LINE_CMT), false, `${rel} must contain zero line comments`);
      assert.equal(src.includes(BLOCK_CMT), false, `${rel} must contain zero block comments`);
      assert.equal(src.includes(HTML_CMT), false, `${rel} must contain zero HTML comments`);
    }

    for (const file of [scriptPath, docPath, testPath]) {
      const src = fs.readFileSync(file, "utf8");
      const rel = path.relative(REPO_DIR, file);
      assert.equal(src.includes(EM_DASH), false, `${rel} must contain zero em dashes`);
      assert.equal(src.includes(HTML_CMT), false, `${rel} must contain zero HTML comments`);
    }
  });
});
