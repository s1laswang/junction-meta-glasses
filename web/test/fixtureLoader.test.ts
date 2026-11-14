import { DEMO_SCENARIOS } from "../src/camera/demoScenarios.ts";
import {
  clearFixtureCache,
  estimateJpegByteSharpness,
  loadFixtureFrame,
  parseJpegDimensions,
  uint8ToBase64
} from "../src/camera/fixtureLoader.ts";

interface MockTimers {
  enable(opts?: { apis?: Array<"Date" | "setTimeout" | "setInterval">; now?: number }): void;
  tick(ms: number): void;
}

interface TestContext {
  mock: {
    timers: MockTimers;
  };
}

type TestFn = (name: string, fn: (t: TestContext) => void | Promise<void>) => Promise<void>;

interface StrictAssert {
  ok(value: unknown, message?: string): asserts value;
  equal<T>(actual: T, expected: T, message?: string): void;
  notEqual<T>(actual: T, expected: T, message?: string): void;
  deepEqual<T>(actual: T, expected: T, message?: string): void;
  rejects(block: () => Promise<unknown>, error?: RegExp): Promise<void>;
}

interface NodeFs {
  readdirSync(dir: string): string[];
  readFileSync(file: string): Uint8Array;
}

interface NodePath {
  dirname(p: string): string;
  resolve(...segments: string[]): string;
  join(...segments: string[]): string;
}

interface NodeUrl {
  fileURLToPath(url: string): string;
}

interface NodeBufferStatic {
  from(data: Uint8Array | number[]): { toString(encoding: "base64"): string };
}

const nodeTestSpec = String("node:test");
const nodeAssertSpec = String("node:assert/strict");
const nodeFsSpec = String("node:fs");
const nodePathSpec = String("node:path");
const nodeUrlSpec = String("node:url");

const test: TestFn = ((await import(nodeTestSpec)) as { test: TestFn }).test;
const assert: StrictAssert = ((await import(nodeAssertSpec)) as { default: StrictAssert }).default;
const fs: NodeFs = (await import(nodeFsSpec)) as NodeFs;
const path: NodePath = (await import(nodePathSpec)) as NodePath;
const fileURLToPath: NodeUrl["fileURLToPath"] = ((await import(nodeUrlSpec)) as NodeUrl).fileURLToPath;

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(testDir, "../public/fixtures");

function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function readAllFixtureFiles(): Array<{ name: string; url: string; bytes: Uint8Array }> {
  const names = fs
    .readdirSync(fixturesDir)
    .filter((entry: string) => entry.endsWith(".jpg"))
    .sort();
  return names.map((name: string) => {
    const raw = fs.readFileSync(path.join(fixturesDir, name));
    const bytes = new Uint8Array(raw.byteLength);
    bytes.set(raw);
    return {
      name,
      url: `/fixtures/${name}`,
      bytes
    };
  });
}

function makeSofHeaderStub(marker: number, w: number, h: number): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    marker,
    0x00,
    0x11,
    0x08,
    (h >> 8) & 0xff,
    h & 0xff,
    (w >> 8) & 0xff,
    w & 0xff,
    0x03,
    0x01,
    0x22,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01,
    0xff,
    0xd9
  ]);
}

test("parseJpegDimensions returns 768x768 across all 7 real demo fixture JPEGs on disk", () => {
  const fixtures = readAllFixtureFiles();
  assert.equal(fixtures.length, 7);

  const expectedUrls = DEMO_SCENARIOS.map((s) => s.fixtureUrl).sort();
  const actualUrls = fixtures.map((f) => f.url).sort();
  assert.deepEqual(actualUrls, expectedUrls);

  for (const fixture of fixtures) {
    const dims = parseJpegDimensions(fixture.bytes);
    assert.deepEqual(
      dims,
      { w: 768, h: 768 },
      `expected 768x768 for ${fixture.name}`
    );
  }
});

test("parseJpegDimensions handles SOF0, SOF2, embedded APP1 thumbnails, fill bytes, and invalid inputs", () => {
  assert.deepEqual(parseJpegDimensions(makeSofHeaderStub(0xc0, 1280, 720)), {
    w: 1280,
    h: 720
  });
  assert.deepEqual(parseJpegDimensions(makeSofHeaderStub(0xc2, 640, 480)), {
    w: 640,
    h: 480
  });

  const withApp1ThumbnailAndFill = new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe1, 0x00, 0x10,
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x78, 0x00,
    0xff, 0xc4, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xff, 0xff, 0xc2, 0x00, 0x0b, 0x08, 0x01, 0xe0, 0x03, 0x20, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9
  ]);
  assert.deepEqual(parseJpegDimensions(withApp1ThumbnailAndFill), {
    w: 800,
    h: 480
  });

  assert.equal(parseJpegDimensions(new Uint8Array(0)), null);
  assert.equal(parseJpegDimensions(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])), null);
  assert.equal(parseJpegDimensions(new Uint8Array([0xff, 0xd8, 0xff, 0xd9])), null);
  assert.equal(parseJpegDimensions(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08])), null);
  assert.equal(parseJpegDimensions(makeSofHeaderStub(0xc0, 0, 768)), null);
  assert.equal(parseJpegDimensions(makeSofHeaderStub(0xc0, 768, 0)), null);
  assert.equal(
    parseJpegDimensions(new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x03])),
    null
  );
});

test("estimateJpegByteSharpness scales cleanly in [0, 1] and ranks sharp above blurry fixture", () => {
  assert.equal(estimateJpegByteSharpness(new Uint8Array(0)), 0);

  const fixtures = readAllFixtureFiles();
  const byName = new Map(fixtures.map((f) => [f.name, f.bytes]));

  for (const fixture of fixtures) {
    const scoreAuto = estimateJpegByteSharpness(fixture.bytes);
    const scoreExplicit = estimateJpegByteSharpness(fixture.bytes, { w: 768, h: 768 });
    assert.equal(scoreAuto, scoreExplicit);
    assert.ok(scoreAuto > 0 && scoreAuto < 1, `expected (0, 1) for ${fixture.name}, got ${scoreAuto}`);
  }

  const sharpAml = byName.get("amlodipine.jpg");
  const blurryAml = byName.get("blurry_amlodipine.jpg");
  assert.ok(sharpAml);
  assert.ok(blurryAml);
  assert.ok(
    estimateJpegByteSharpness(sharpAml) > estimateJpegByteSharpness(blurryAml),
    "expected crisp amlodipine fixture to score higher than blurry_amlodipine"
  );

  const densePayload = new Uint8Array(64 * 64);
  assert.equal(estimateJpegByteSharpness(densePayload, { w: 64, h: 64 }), 1);

  const nonSofPayload = new Uint8Array(58_982);
  const fallbackScore = estimateJpegByteSharpness(nonSofPayload, null);
  assert.ok(fallbackScore > 0.25 && fallbackScore < 0.35);
});

test("uint8ToBase64 roundtrips 65 KB real JPEGs and large buffers identically via Node Buffer and chunked btoa", () => {
  const globalRecord = globalThis as unknown as {
    Buffer?: NodeBufferStatic;
    btoa?: unknown;
  };
  const nodeBuf = globalRecord.Buffer;
  assert.ok(nodeBuf);

  const fixtures = readAllFixtureFiles();
  const ibuprofen = fixtures.find((f) => f.name === "ibuprofen.jpg");
  assert.ok(ibuprofen);
  assert.ok(ibuprofen.bytes.length >= 65_000, `expected >= 65 KB JPEG, got ${ibuprofen.bytes.length}`);

  assert.equal(uint8ToBase64(new Uint8Array(0)), "");

  for (const fixture of fixtures) {
    const encoded = uint8ToBase64(fixture.bytes);
    const decoded = decodeBase64(encoded);
    assert.deepEqual(decoded, fixture.bytes, `roundtrip mismatch on ${fixture.name}`);
  }

  const padded = new Uint8Array(ibuprofen.bytes.length + 24);
  padded.set(ibuprofen.bytes, 11);
  const subView = padded.subarray(11, 11 + ibuprofen.bytes.length);
  const expectedB64 = nodeBuf.from(ibuprofen.bytes).toString("base64");
  assert.equal(uint8ToBase64(subView), expectedB64);

  const largeSynthetic = new Uint8Array(150_000);
  for (let i = 0; i < largeSynthetic.length; i += 1) {
    largeSynthetic[i] = (i * 131 + 17) & 0xff;
  }
  const expectedLargeB64 = nodeBuf.from(largeSynthetic).toString("base64");
  const expectedSlice1025 = nodeBuf.from(ibuprofen.bytes.subarray(0, 1025)).toString("base64");
  const expectedSlice1024 = nodeBuf.from(ibuprofen.bytes.subarray(0, 1024)).toString("base64");

  const savedBuffer = globalRecord.Buffer;
  const savedBtoa = globalRecord.btoa;

  try {
    globalRecord.Buffer = undefined;
    const browserEncodedIbuprofen = uint8ToBase64(ibuprofen.bytes);
    assert.equal(browserEncodedIbuprofen, expectedB64);
    assert.deepEqual(decodeBase64(browserEncodedIbuprofen), ibuprofen.bytes);

    const browserEncodedLarge = uint8ToBase64(largeSynthetic);
    assert.equal(browserEncodedLarge, expectedLargeB64);

    globalRecord.btoa = undefined;
    assert.equal(uint8ToBase64(ibuprofen.bytes.subarray(0, 1025)), expectedSlice1025);
    assert.equal(uint8ToBase64(ibuprofen.bytes.subarray(0, 1024)), expectedSlice1024);
  } finally {
    globalRecord.Buffer = savedBuffer;
    globalRecord.btoa = savedBtoa;
  }
});

test("loadFixtureFrame loads real fixtures, caches hits, refreshes timestamps, and enforces 8-entry LRU", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 });
  clearFixtureCache();

  const fixtures = readAllFixtureFiles();
  const byUrl = new Map(fixtures.map((f) => [f.url, f.bytes]));
  const fetchedUrls: string[] = [];

  const fakeFetch: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    fetchedUrls.push(url);
    const realBytes = byUrl.get(url);
    if (realBytes) {
      const copy = new Uint8Array(realBytes.length);
      copy.set(realBytes);
      return new Response(copy, {
        status: 200,
        headers: { "Content-Type": "image/jpeg" }
      });
    }
    if (url.startsWith("/synthetic/")) {
      const stub = makeSofHeaderStub(0xc0, 640, 480);
      const copy = new Uint8Array(stub.length);
      copy.set(stub);
      return new Response(copy, { status: 200 });
    }
    if (url === "/non-sof.bin") {
      return new Response(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  };

  const first = await loadFixtureFrame("/fixtures/amlodipine.jpg", { fetchImpl: fakeFetch });
  assert.equal(fetchedUrls.length, 1);
  assert.equal(first.w, 768);
  assert.equal(first.h, 768);
  assert.equal(first.ts, 1_700_000_000_000);
  assert.deepEqual(decodeBase64(first.data), byUrl.get("/fixtures/amlodipine.jpg"));

  t.mock.timers.tick(1_250);
  const second = await loadFixtureFrame("/fixtures/amlodipine.jpg", { fetchImpl: fakeFetch });
  assert.equal(fetchedUrls.length, 1);
  assert.notEqual(second, first);
  assert.equal(second.data, first.data);
  assert.equal(second.sharpness, first.sharpness);
  assert.equal(second.ts, 1_700_000_001_250);
  assert.ok(second.ts > first.ts);

  t.mock.timers.tick(500);
  const uncached = await loadFixtureFrame("/fixtures/amlodipine.jpg", {
    fetchImpl: fakeFetch,
    cache: false
  });
  assert.equal(fetchedUrls.length, 2);
  assert.equal(uncached.ts, 1_700_000_001_750);

  clearFixtureCache();
  fetchedUrls.length = 0;

  for (const scenario of DEMO_SCENARIOS) {
    const frame = await loadFixtureFrame(scenario.fixtureUrl, { fetchImpl: fakeFetch });
    assert.equal(frame.w, 768);
    assert.equal(frame.h, 768);
    assert.ok(frame.sharpness > 0 && frame.sharpness <= 1);
  }
  assert.equal(fetchedUrls.length, 7);

  await loadFixtureFrame("/synthetic/8.jpg", { fetchImpl: fakeFetch });
  assert.equal(fetchedUrls.length, 8);

  const firstScenarioUrl = DEMO_SCENARIOS[0].fixtureUrl;
  const secondScenarioUrl = DEMO_SCENARIOS[1].fixtureUrl;

  await loadFixtureFrame(firstScenarioUrl, { fetchImpl: fakeFetch });
  assert.equal(fetchedUrls.length, 8);

  await loadFixtureFrame("/synthetic/9.jpg", { fetchImpl: fakeFetch });
  assert.equal(fetchedUrls.length, 9);

  await loadFixtureFrame(firstScenarioUrl, { fetchImpl: fakeFetch });
  assert.equal(fetchedUrls.length, 9);

  await loadFixtureFrame(secondScenarioUrl, { fetchImpl: fakeFetch });
  assert.equal(fetchedUrls.length, 10);

  const nonSofFrame = await loadFixtureFrame("/non-sof.bin", {
    fetchImpl: fakeFetch,
    cache: false
  });
  assert.equal(nonSofFrame.w, 768);
  assert.equal(nonSofFrame.h, 768);
  assert.equal(nonSofFrame.data, btoa(String.fromCharCode(1, 2, 3, 4, 5, 6, 7, 8)));

  await assert.rejects(
    () => loadFixtureFrame("/missing.jpg", { fetchImpl: fakeFetch }),
    /404/
  );

  clearFixtureCache();
  fetchedUrls.length = 0;
  await loadFixtureFrame(firstScenarioUrl, { fetchImpl: fakeFetch });
  assert.equal(fetchedUrls.length, 1);
});
