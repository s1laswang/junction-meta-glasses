import assert from "node:assert/strict";
import fs from "node:fs";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import type { Profile, Verdict } from "../../shared/types.ts";
import { env, REPO_ROOT } from "../src/env.ts";
import { ai } from "../src/gemini.ts";
import { resetHubsForTest } from "../src/hub.ts";
import { startServer } from "../src/index.ts";
import { jpegSharpness } from "../src/verify.ts";

process.env.HOLDUP_QUIET = "1";
const tempLedger = path.join(os.tmpdir(), `holdup-api-headers-wellknown-${process.pid}.jsonl`);

let server: http.Server;
let baseUrl = "";
let prevApiKey = "";
let prevLedger = "";
let origGenerateContent: typeof ai.models.generateContent;
let mockGenerateImpl: ((params: any) => Promise<any>) | null = null;
let generateCalls = 0;

before(async () => {
  process.env.HOLDUP_QUIET = "1";
  prevApiKey = env.apiKey;
  env.apiKey = "";
  prevLedger = env.ledgerPath;
  env.ledgerPath = tempLedger;
  origGenerateContent = ai.models.generateContent.bind(ai.models);
  (ai.models as any).generateContent = async (params: any) => {
    generateCalls++;
    if (!mockGenerateImpl) {
      throw new Error("unexpected generateContent call without mock");
    }
    return mockGenerateImpl(params);
  };
  resetHubsForTest();
  server = await startServer(0);
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

beforeEach(() => {
  resetHubsForTest();
  mockGenerateImpl = null;
  generateCalls = 0;
});

afterEach(() => {
  mockGenerateImpl = null;
  resetHubsForTest();
});

after(async () => {
  resetHubsForTest();
  (ai.models as any).generateContent = origGenerateContent;
  env.apiKey = prevApiKey;
  env.ledgerPath = prevLedger;
  await closeServer(server);
  try {
    fs.rmSync(tempLedger, { force: true });
  } catch {}
});

async function closeServer(srv: http.Server): Promise<void> {
  srv.closeAllConnections();
  await new Promise<void>((resolve) => srv.close(() => resolve()));
}

function makeSyntheticSof0Jpeg(w: number, h: number, totalBytes: number, fillByte: number): Buffer {
  assert.ok(totalBytes >= 64, "synthetic JPEG requires >= 64 bytes");
  assert.notEqual(fillByte, 0xff, "fillByte must not be 0xff");
  const buf = Buffer.alloc(totalBytes, fillByte);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  buf[2] = 0xff;
  buf[3] = 0xc0;
  buf.writeUInt16BE(17, 4);
  buf[6] = 8;
  buf.writeUInt16BE(h, 7);
  buf.writeUInt16BE(w, 9);
  buf[11] = 3;
  buf[totalBytes - 2] = 0xff;
  buf[totalBytes - 1] = 0xd9;
  return buf;
}

function mockLabelJson(): string {
  return JSON.stringify({
    kind: "medication",
    product: { value: "Norvasc", confidence: 0.97 },
    ingredient: { value: "amlodipine", confidence: 0.96 },
    strength: { value: "5 mg", confidence: 0.95 },
    dosing: { value: "1 tablet daily", confidence: 0.91 },
    expiry: { value: "2027-11", confidence: 0.93 },
    allergens: { value: [], confidence: 0.88 },
    barcode: { value: "6432100012345", confidence: 0.95 },
    readability: 0.95,
  });
}

const sampleProfile: Profile = {
  meds: [{ id: "aml", name: "Norvasc", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"] }],
  allergies: [],
  avoid: [],
  doseLog: [],
  lang: "en",
};

test("GET /.well-known/meta-wearables-manifest.json serves 200 application/json instead of SPA index.html", async () => {
  const publicManifestPath = path.join(REPO_ROOT, "web", "public", ".well-known", "meta-wearables-manifest.json");
  const publicManifestRaw = fs.readFileSync(publicManifestPath, "utf8");
  const expectedManifest = JSON.parse(publicManifestRaw) as Record<string, unknown>;

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "holdup-wellknown-"));
  const distWellKnownDir = path.join(tmpRoot, "web", "dist", ".well-known");
  fs.mkdirSync(distWellKnownDir, { recursive: true });
  const spaHtml = "<!doctype html><html><head><title>SPA Shell</title></head><body><div id=\"root\"></div></body></html>";
  fs.writeFileSync(path.join(tmpRoot, "web", "dist", "index.html"), spaHtml, "utf8");
  fs.writeFileSync(path.join(distWellKnownDir, "meta-wearables-manifest.json"), publicManifestRaw, "utf8");

  const isolated = await startServer(0, { repoRoot: tmpRoot });
  const { port } = isolated.address() as AddressInfo;
  const isoBase = `http://127.0.0.1:${port}`;

  try {
    const manifestRes = await fetch(`${isoBase}/.well-known/meta-wearables-manifest.json`);
    assert.equal(manifestRes.status, 200);
    assert.equal(manifestRes.headers.get("x-powered-by"), null);
    assert.match(manifestRes.headers.get("content-type") ?? "", /application\/json/i);
    assert.match(manifestRes.headers.get("cache-control") ?? "", /max-age=3600/i);
    const parsed = (await manifestRes.json()) as Record<string, unknown>;
    assert.deepEqual(parsed, expectedManifest);
    assert.equal(parsed.name, "HoldUp");
    assert.equal(parsed.start_url, "/hud");
    assert.equal(parsed.display, "standalone");
    assert.equal(parsed.background_color, "#000000");
    assert.equal(parsed.theme_color, "#000000");

    const hudRes = await fetch(`${isoBase}/hud`);
    assert.equal(hudRes.status, 200);
    assert.match(hudRes.headers.get("content-type") ?? "", /text\/html/i);
    assert.equal(await hudRes.text(), spaHtml);
  } finally {
    await closeServer(isolated);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  const realDistManifest = path.join(REPO_ROOT, "web", "dist", ".well-known", "meta-wearables-manifest.json");
  if (fs.existsSync(realDistManifest)) {
    const realRes = await fetch(`${baseUrl}/.well-known/meta-wearables-manifest.json`);
    assert.equal(realRes.status, 200);
    assert.equal(realRes.headers.get("x-powered-by"), null);
    assert.match(realRes.headers.get("content-type") ?? "", /application\/json/i);
    assert.deepEqual(await realRes.json(), expectedManifest);
  }
});

test("all 5 API routes enforce Cache-Control: no-store across 200, 400, 404, and 503 responses", async () => {
  const healthRes = await fetch(`${baseUrl}/api/health`);
  assert.equal(healthRes.status, 200);
  assert.equal(healthRes.headers.get("cache-control"), "no-store");
  await healthRes.json();

  const statsRes = await fetch(`${baseUrl}/api/stats`);
  assert.equal(statsRes.status, 200);
  assert.equal(statsRes.headers.get("cache-control"), "no-store");
  await statsRes.json();

  const evalColdRes = await fetch(`${baseUrl}/api/eval-summary`);
  assert.equal(evalColdRes.status, 200);
  assert.equal(evalColdRes.headers.get("cache-control"), "no-store");
  await evalColdRes.json();

  const evalCachedRes = await fetch(`${baseUrl}/api/eval-summary`);
  assert.equal(evalCachedRes.status, 200);
  assert.equal(evalCachedRes.headers.get("cache-control"), "no-store");
  await evalCachedRes.json();

  const verify400Res = await fetch(`${baseUrl}/api/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ frames: [] }),
  });
  assert.equal(verify400Res.status, 400);
  assert.equal(verify400Res.headers.get("cache-control"), "no-store");
  await verify400Res.json();

  const tts400Res = await fetch(`${baseUrl}/api/tts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "" }),
  });
  assert.equal(tts400Res.status, 400);
  assert.equal(tts400Res.headers.get("cache-control"), "no-store");
  await tts400Res.json();

  assert.equal(generateCalls, 0);

  mockGenerateImpl = async () => ({ text: mockLabelJson() });
  const verify200Res = await fetch(`${baseUrl}/api/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ frames: ["A".repeat(160)], profile: sampleProfile }),
  });
  assert.equal(verify200Res.status, 200);
  assert.equal(verify200Res.headers.get("cache-control"), "no-store");
  const verdict = (await verify200Res.json()) as Verdict;
  assert.equal(verdict.level, "match");

  const pcmSample = Buffer.alloc(160, 0).toString("base64");
  mockGenerateImpl = async () => ({
    candidates: [{ content: { parts: [{ inlineData: { data: pcmSample, mimeType: "audio/pcm;rate=24000" } }] } }],
    usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 16 },
  });
  const tts200Res = await fetch(`${baseUrl}/api/tts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Hold steady." }),
  });
  assert.equal(tts200Res.status, 200);
  assert.equal(tts200Res.headers.get("cache-control"), "no-store");
  assert.match(tts200Res.headers.get("content-type") ?? "", /audio\/wav/i);
  await tts200Res.arrayBuffer();

  mockGenerateImpl = async () => {
    throw new Error("simulated tts outage");
  };
  const tts503Res = await fetch(`${baseUrl}/api/tts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Fallback check." }),
  });
  assert.equal(tts503Res.status, 503);
  assert.equal(tts503Res.headers.get("cache-control"), "no-store");
  await tts503Res.json();

  const unknownApiRes = await fetch(`${baseUrl}/api/nonexistent`);
  assert.equal(unknownApiRes.status, 404);
  assert.equal(unknownApiRes.headers.get("cache-control"), "no-store");
  await unknownApiRes.json();
});

test("POST /api/verify ranks recent frames by jpegSharpness first and falls back to length tie-breaking for non-JPEG inputs", async () => {
  const capturedBatches: string[][] = [];
  mockGenerateImpl = async (params) => {
    const parts = params.contents[0].parts as any[];
    const frames = parts.filter((p) => p.inlineData).map((p) => String(p.inlineData.data));
    capturedBatches.push(frames);
    return { text: mockLabelJson() };
  };

  const staleUltraSharpBuf = makeSyntheticSof0Jpeg(128, 128, 5500, 0x41);
  const hugeDimBlurryBuf = makeSyntheticSof0Jpeg(2048, 2048, 36000, 0x42);
  const midSharpBuf = makeSyntheticSof0Jpeg(512, 512, 20000, 0x43);
  const compactSharpBuf = makeSyntheticSof0Jpeg(256, 256, 12000, 0x44);

  const staleUltraSharpB64 = staleUltraSharpBuf.toString("base64");
  const hugeDimBlurryB64 = hugeDimBlurryBuf.toString("base64");
  const midSharpB64 = midSharpBuf.toString("base64");
  const compactSharpB64 = compactSharpBuf.toString("base64");

  assert.ok(hugeDimBlurryB64.length > midSharpB64.length);
  assert.ok(midSharpB64.length > compactSharpB64.length);
  assert.ok(jpegSharpness(compactSharpBuf) > jpegSharpness(midSharpBuf));
  assert.ok(jpegSharpness(midSharpBuf) > jpegSharpness(hugeDimBlurryBuf));

  const syntheticJpegRes = await fetch(`${baseUrl}/api/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      frames: [staleUltraSharpB64, hugeDimBlurryB64, midSharpB64, compactSharpB64],
      profile: sampleProfile,
    }),
  });
  assert.equal(syntheticJpegRes.status, 200);
  await syntheticJpegRes.json();
  assert.deepEqual(capturedBatches[0], [compactSharpB64, midSharpB64]);

  const sharpFixtureBuf = fs.readFileSync(path.join(REPO_ROOT, "web", "public", "fixtures", "amlodipine.jpg"));
  const blurryFixtureBuf = fs.readFileSync(path.join(REPO_ROOT, "web", "public", "fixtures", "blurry_amlodipine.jpg"));
  assert.ok(jpegSharpness(sharpFixtureBuf) > jpegSharpness(blurryFixtureBuf));
  const sharpFixtureB64 = sharpFixtureBuf.toString("base64");
  const blurryFixtureB64 = blurryFixtureBuf.toString("base64");

  const realFixtureRes = await fetch(`${baseUrl}/api/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      frames: [blurryFixtureB64, sharpFixtureB64],
      profile: sampleProfile,
    }),
  });
  assert.equal(realFixtureRes.status, 200);
  await realFixtureRes.json();
  assert.deepEqual(capturedBatches[1], [sharpFixtureB64, blurryFixtureB64]);

  const zeroDecodeLong = "!".repeat(360);
  const zeroDecodeShort = "!".repeat(140);
  const zeroDecodeMid = "!".repeat(240);
  assert.equal(jpegSharpness(Buffer.from(zeroDecodeLong, "base64")), 0);

  const fallbackRes = await fetch(`${baseUrl}/api/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      frames: [zeroDecodeShort, zeroDecodeLong, zeroDecodeMid],
      profile: sampleProfile,
    }),
  });
  assert.equal(fallbackRes.status, 200);
  await fallbackRes.json();
  assert.deepEqual(capturedBatches[2], [zeroDecodeLong, zeroDecodeMid]);
});

test("server/src/index.ts and server/test/api-headers-wellknown.test.ts contain zero comments, em dashes, or keys", () => {
  const slash = String.fromCharCode(47);
  const star = String.fromCharCode(42);
  const blockToken = slash + star;
  const lineCommentRe = new RegExp(`(^|[^:])${slash}${slash}`);
  const emDash = String.fromCharCode(0x2014);
  const coAuthoredRe = new RegExp(["Co", "Authored", "By"].join("-"), "i");
  const apiKeyRe = new RegExp("AIza" + "[0-9A-Za-z_-]{20,}");

  for (const rel of ["server/src/index.ts", "server/test/api-headers-wellknown.test.ts"]) {
    const text = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
    assert.equal(text.includes(blockToken), false, `Forbidden block comment token in ${rel}`);
    assert.equal(text.includes(emDash), false, `Forbidden em dash in ${rel}`);
    assert.equal(coAuthoredRe.test(text), false, `Forbidden co-authored token in ${rel}`);
    assert.equal(apiKeyRe.test(text), false, `Forbidden API key pattern in ${rel}`);
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      assert.equal(lineCommentRe.test(lines[i]), false, `Forbidden line comment in ${rel}:${i + 1}`);
    }
  }
});
