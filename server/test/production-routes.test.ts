import assert from "node:assert/strict";
import fs from "node:fs";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import vm from "node:vm";
import { env, REPO_ROOT } from "../src/env.ts";
import { startServer } from "../src/index.ts";

process.env.HOLDUP_QUIET = "1";

interface ManifestIcon {
  src?: unknown;
  sizes?: unknown;
  type?: unknown;
  purpose?: unknown;
}

interface ManifestShortcut {
  name?: unknown;
  short_name?: unknown;
  url?: unknown;
  icons?: unknown;
}

interface WebManifestShape {
  name?: unknown;
  short_name?: unknown;
  description?: unknown;
  start_url?: unknown;
  scope?: unknown;
  display?: unknown;
  background_color?: unknown;
  theme_color?: unknown;
  icons?: unknown;
  shortcuts?: unknown;
}

const EXPECTED_FIXTURES = [
  "amlodipine.jpg",
  "back_of_box.jpg",
  "blurry_amlodipine.jpg",
  "expired_metformin.jpg",
  "hazelnut_bar.jpg",
  "ibuprofen.jpg",
  "oat_milk.jpg",
] as const;

let server: http.Server;
let baseUrl = "";
let prevApiKey = "";

before(async () => {
  process.env.HOLDUP_QUIET = "1";
  prevApiKey = env.apiKey;
  env.apiKey = "";
  server = await startServer(0);
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  env.apiKey = prevApiKey;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function assertApiCacheGuard(res: Response, label: string): void {
  const cc = res.headers.get("cache-control");
  if (cc !== null) {
    assert.doesNotMatch(cc, /\bpublic\b/i, `${label} must not advertise public cache`);
    assert.doesNotMatch(cc, /max-age=[1-9]/i, `${label} must not set positive max-age`);
    assert.match(cc, /\bno-store\b/i, `${label} Cache-Control must include no-store when set`);
  }
}

test("GET /judge-handout.html serves 200 text/html matching docs/judge-handout.html", async () => {
  const diskHtml = fs.readFileSync(path.join(REPO_ROOT, "docs", "judge-handout.html"), "utf8");
  const res = await fetch(`${baseUrl}/judge-handout.html`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-powered-by"), null);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/i);
  assert.doesNotMatch(res.headers.get("cache-control") ?? "", /max-age=[1-9]/i);
  const body = await res.text();
  assert.equal(body, diskHtml);
  assert.match(body, /HoldUp/i);
  assert.match(body, /STRENGTH_MIN_CONF = 0\.80/);
  assert.match(body, /\/hud-ws/);
});

test("GET /printable-props.html serves 200 text/html with all 4 stage props and scannable barcodes", async () => {
  const diskHtml = fs.readFileSync(path.join(REPO_ROOT, "docs", "printable-props.html"), "utf8");
  const res = await fetch(`${baseUrl}/printable-props.html`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-powered-by"), null);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/i);
  assert.doesNotMatch(res.headers.get("cache-control") ?? "", /max-age=[1-9]/i);
  const body = await res.text();
  assert.equal(body, diskHtml);
  assert.match(body, /Amlodipin 5 mg/);
  assert.match(body, /Burana 400 mg/);
  assert.match(body, /Metformin 500 mg/);
  assert.match(body, /Nordic Oat/);
  for (const code of ["6432100012345", "6412345000400", "6432100054321", "7310100555111"]) {
    assert.ok(body.includes(code), `Expected barcode ${code} in printable-props.html`);
  }
  assert.match(body, /<svg[^>]*class="barcode-svg"/i);
});

test("GET /api/health, GET /api/stats, and GET /api/eval-summary return structured 200 JSON without model calls", async () => {
  const healthRes = await fetch(`${baseUrl}/api/health`);
  assert.equal(healthRes.status, 200);
  assert.equal(healthRes.headers.get("x-powered-by"), null);
  assert.match(healthRes.headers.get("content-type") ?? "", /application\/json/i);
  const healthRaw = await healthRes.text();
  assert.doesNotMatch(healthRaw, /AIza[0-9A-Za-z_-]{20,}/);
  const health = JSON.parse(healthRaw) as Record<string, unknown>;
  assert.equal(health.ok, true);
  assert.equal(health.gemini, "down");
  assert.equal(typeof health.version, "string");
  const models = health.models as Record<string, unknown>;
  assert.ok(Array.isArray(models?.live) && models.live.length > 0);
  assert.ok(Array.isArray(models?.verify) && models.verify.length > 0);
  assert.ok(Array.isArray(models?.tts) && models.tts.length > 0);

  const statsRes = await fetch(`${baseUrl}/api/stats`);
  assert.equal(statsRes.status, 200);
  assert.equal(statsRes.headers.get("x-powered-by"), null);
  assert.match(statsRes.headers.get("content-type") ?? "", /application\/json/i);
  const statsBody = (await statsRes.json()) as Record<string, unknown>;
  assert.equal(typeof statsBody.total, "number");
  assert.ok(statsBody.features !== null && typeof statsBody.features === "object");

  const evalRes = await fetch(`${baseUrl}/api/eval-summary`);
  assert.equal(evalRes.status, 200);
  assert.equal(evalRes.headers.get("x-powered-by"), null);
  assert.match(evalRes.headers.get("content-type") ?? "", /application\/json/i);
  const evalBody = (await evalRes.json()) as {
    ok: boolean;
    summary: {
      headline_metrics?: Record<string, unknown>;
      safety_invariants?: Record<string, unknown>;
      total_confident_wrong_dose_count?: unknown;
      total_false_safe_allergen_count?: unknown;
    } | null;
  };
  assert.equal(evalBody.ok, true);
  assert.notEqual(evalBody.summary, null);
  assert.equal(evalBody.summary?.headline_metrics?.never_guess_strength_min_conf, 0.8);
  assert.equal(evalBody.summary?.safety_invariants?.strength_min_conf, 0.8);
  assert.equal(evalBody.summary?.total_confident_wrong_dose_count, 0);
  assert.equal(evalBody.summary?.total_false_safe_allergen_count, 0);
});

test("API routes disallow static caching, enforce no-store when Cache-Control is present, and bypass sw.js cache", async () => {
  const apiChecks: Array<{ label: string; run: () => Promise<Response>; status: number }> = [
    { label: "GET /api/health", run: () => fetch(`${baseUrl}/api/health`), status: 200 },
    { label: "GET /api/stats", run: () => fetch(`${baseUrl}/api/stats`), status: 200 },
    { label: "GET /api/eval-summary", run: () => fetch(`${baseUrl}/api/eval-summary`), status: 200 },
    {
      label: "POST /api/verify",
      run: () =>
        fetch(`${baseUrl}/api/verify`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ frames: [] }),
        }),
      status: 400,
    },
    {
      label: "POST /api/tts",
      run: () =>
        fetch(`${baseUrl}/api/tts`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "" }),
        }),
      status: 400,
    },
    { label: "GET /api/unknown", run: () => fetch(`${baseUrl}/api/unknown`), status: 404 },
  ];

  for (const item of apiChecks) {
    const res = await item.run();
    assert.equal(res.status, item.status, `${item.label} status mismatch`);
    assert.equal(res.headers.get("x-powered-by"), null);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/i);
    assertApiCacheGuard(res, item.label);
    await res.arrayBuffer();
  }

  const swSource = fs.readFileSync(path.join(REPO_ROOT, "web", "public", "sw.js"), "utf8");
  const sandbox: Record<string, unknown> = {
    self: { addEventListener() {}, location: { origin: "https://holdup.example" } },
  };
  vm.runInNewContext(swSource, sandbox);
  const isNeverCachedPath = sandbox.isNeverCachedPath as (pathname: string) => boolean;
  assert.equal(typeof isNeverCachedPath, "function");
  for (const apiPath of [
    "/sw.js",
    "/api",
    "/api/health",
    "/api/stats",
    "/api/eval-summary",
    "/api/verify",
    "/api/tts",
    "/ingest/frame",
    "/live",
    "/hud-ws",
  ]) {
    assert.equal(isNeverCachedPath(apiPath), true, `Expected sw.js never to cache ${apiPath}`);
  }
  for (const staticPath of ["/", "/hud", "/manifest.webmanifest", "/.well-known/meta-wearables-manifest.json"]) {
    assert.equal(isNeverCachedPath(staticPath), false, `Expected sw.js to allow ${staticPath}`);
  }
});

test("web/public/.well-known/meta-wearables-manifest.json and manifest.webmanifest conform to schema", () => {
  const publicDir = path.join(REPO_ROOT, "web", "public");
  const wearablesPath = path.join(publicDir, ".well-known", "meta-wearables-manifest.json");
  const wearablesRaw = fs.readFileSync(wearablesPath, "utf8");
  const wearables = JSON.parse(wearablesRaw) as WebManifestShape;

  assert.ok(wearables && typeof wearables === "object" && !Array.isArray(wearables));
  assert.equal(wearables.name, "HoldUp");
  assert.equal(wearables.short_name, "HoldUp");
  assert.equal(typeof wearables.description, "string");
  assert.ok((wearables.description as string).trim().length > 0);
  assert.equal(wearables.start_url, "/hud");
  assert.equal(wearables.display, "standalone");
  assert.equal(wearables.background_color, "#000000");
  assert.equal(wearables.theme_color, "#000000");

  assert.ok(Array.isArray(wearables.icons) && wearables.icons.length > 0);
  const wearablesIcons = wearables.icons as ManifestIcon[];
  for (const icon of wearablesIcons) {
    assert.equal(typeof icon.src, "string");
    assert.ok((icon.src as string).startsWith("/"));
    const iconDisk = path.join(publicDir, (icon.src as string).slice(1));
    assert.ok(fs.existsSync(iconDisk) && fs.statSync(iconDisk).isFile(), `Missing icon asset ${icon.src}`);
    assert.equal(typeof icon.sizes, "string");
    assert.equal(typeof icon.type, "string");
  }
  assert.ok(
    wearablesIcons.some((i) => i.src === "/icon.svg" && i.sizes === "512x512" && i.type === "image/svg+xml"),
  );

  const distWearablesPath = path.join(REPO_ROOT, "web", "dist", ".well-known", "meta-wearables-manifest.json");
  if (fs.existsSync(distWearablesPath)) {
    assert.equal(fs.readFileSync(distWearablesPath, "utf8"), wearablesRaw);
  }

  const pwaManifestRaw = fs.readFileSync(path.join(publicDir, "manifest.webmanifest"), "utf8");
  const pwaManifest = JSON.parse(pwaManifestRaw) as WebManifestShape;
  assert.equal(pwaManifest.short_name, "HoldUp");
  assert.equal(pwaManifest.start_url, "/");
  assert.equal(pwaManifest.scope, "/");
  assert.equal(pwaManifest.display, "standalone");
  assert.ok(Array.isArray(pwaManifest.shortcuts));
  assert.ok((pwaManifest.shortcuts as ManifestShortcut[]).some((s) => s.url === "/hud"));
});

test("single-origin production bundle, 7 JPEG fixtures, /deck/, and 404 JSON guards behave deterministically", async () => {
  for (const fixtureName of EXPECTED_FIXTURES) {
    const buf = fs.readFileSync(path.join(REPO_ROOT, "web", "public", "fixtures", fixtureName));
    assert.ok(buf.length >= 10 * 1024 && buf.length <= 200 * 1024);
    assert.equal(buf[0], 0xff);
    assert.equal(buf[1], 0xd8);
    assert.equal(buf[buf.length - 2], 0xff);
    assert.equal(buf[buf.length - 1], 0xd9);
  }

  const distIndex = path.join(REPO_ROOT, "web", "dist", "index.html");
  if (fs.existsSync(distIndex)) {
    const expectedIndex = fs.readFileSync(distIndex, "utf8");
    const rootRes = await fetch(`${baseUrl}/`);
    assert.equal(rootRes.status, 200);
    assert.match(rootRes.headers.get("content-type") ?? "", /text\/html/i);
    assert.match(rootRes.headers.get("cache-control") ?? "", /max-age=3600/i);
    assert.equal(await rootRes.text(), expectedIndex);

    const hudRes = await fetch(`${baseUrl}/hud`);
    assert.equal(hudRes.status, 200);
    assert.match(hudRes.headers.get("content-type") ?? "", /text\/html/i);
    assert.equal(await hudRes.text(), expectedIndex);

    const manifestRes = await fetch(`${baseUrl}/manifest.webmanifest`);
    assert.equal(manifestRes.status, 200);
    assert.match(manifestRes.headers.get("content-type") ?? "", /application\/(manifest\+)?json/i);
    await manifestRes.arrayBuffer();

    const swRes = await fetch(`${baseUrl}/sw.js`);
    assert.equal(swRes.status, 200);
    assert.match(swRes.headers.get("content-type") ?? "", /(text|application)\/javascript/i);
    await swRes.arrayBuffer();

    const wearablesRes = await fetch(`${baseUrl}/.well-known/meta-wearables-manifest.json`);
    assert.equal(wearablesRes.status, 200);
    const wearablesCt = wearablesRes.headers.get("content-type") ?? "";
    if (/json/i.test(wearablesCt)) {
      const parsed = (await wearablesRes.json()) as WebManifestShape;
      assert.equal(parsed.start_url, "/hud");
      assert.equal(parsed.background_color, "#000000");
    } else {
      assert.match(wearablesCt, /text\/html/i);
      assert.equal(await wearablesRes.text(), expectedIndex);
    }

    const fixRes = await fetch(`${baseUrl}/fixtures/amlodipine.jpg`);
    assert.equal(fixRes.status, 200);
    assert.match(fixRes.headers.get("content-type") ?? "", /^image\/jpeg\b/i);
    await fixRes.arrayBuffer();
  }

  const deckIndex = path.join(REPO_ROOT, "deck", "index.html");
  if (fs.existsSync(deckIndex)) {
    const deckRes = await fetch(`${baseUrl}/deck/`);
    assert.equal(deckRes.status, 200);
    assert.match(deckRes.headers.get("content-type") ?? "", /text\/html/i);
    assert.match(deckRes.headers.get("cache-control") ?? "", /max-age=3600/i);
    assert.equal(await deckRes.text(), fs.readFileSync(deckIndex, "utf8"));
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "holdup-prod-routes-"));
  fs.mkdirSync(path.join(tmpDir, "web", "dist", "fixtures"), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, "deck"), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, "docs"), { recursive: true });

  const spaHtml = "<!doctype html><html><head><title>SPA</title></head><body><div id=\"root\"></div></body></html>";
  fs.writeFileSync(path.join(tmpDir, "web", "dist", "index.html"), spaHtml, "utf8");
  fs.writeFileSync(path.join(tmpDir, "web", "dist", "sw.js"), "const CACHE_NAME = 'v1';", "utf8");
  fs.writeFileSync(
    path.join(tmpDir, "web", "dist", "manifest.webmanifest"),
    fs.readFileSync(path.join(REPO_ROOT, "web", "public", "manifest.webmanifest"), "utf8"),
    "utf8",
  );
  fs.copyFileSync(
    path.join(REPO_ROOT, "web", "public", "fixtures", "amlodipine.jpg"),
    path.join(tmpDir, "web", "dist", "fixtures", "amlodipine.jpg"),
  );
  fs.writeFileSync(path.join(tmpDir, "deck", "index.html"), "<!doctype html><section class=\"slide\">1</section>", "utf8");
  fs.writeFileSync(path.join(tmpDir, "docs", "judge-handout.html"), "<!doctype html><h1>Handout</h1>", "utf8");
  fs.writeFileSync(path.join(tmpDir, "docs", "printable-props.html"), "<!doctype html><h1>Props</h1>", "utf8");

  const isolated = await startServer(0, { repoRoot: tmpDir });
  const { port: isoPort } = isolated.address() as AddressInfo;
  const isoBase = `http://127.0.0.1:${isoPort}`;

  try {
    const guardRoutes: Array<{ method: string; path: string }> = [
      { method: "GET", path: "/api/unknown" },
      { method: "POST", path: "/api/unknown" },
      { method: "GET", path: "/ingest/unknown" },
      { method: "GET", path: "/deck/missing.js" },
      { method: "GET", path: "/nonexistent-doc.html" },
      { method: "POST", path: "/hud" },
    ];
    for (const g of guardRoutes) {
      const res = await fetch(`${isoBase}${g.path}`, { method: g.method });
      assert.equal(res.status, 404, `Expected 404 on ${g.method} ${g.path}`);
      assert.equal(res.headers.get("x-powered-by"), null);
      assert.match(res.headers.get("content-type") ?? "", /application\/json/i);
      assert.deepEqual(await res.json(), {
        type: "error",
        code: "not_found",
        message: "not found",
        recoverable: false,
      });
    }
  } finally {
    isolated.closeAllConnections();
    await new Promise<void>((resolve) => isolated.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("smoke-production.mjs and production-routes.test.ts contain zero comments, em dashes, or keys", () => {
  const slash = String.fromCharCode(47);
  const star = String.fromCharCode(42);
  const blockToken = slash + star;
  const lineCommentRe = new RegExp(`(^|[^:])${slash}${slash}`);
  const emDash = String.fromCharCode(0x2014);
  const coAuthoredRe = new RegExp(["Co", "Authored", "By"].join("-"), "i");
  const apiKeyRe = new RegExp("AIza" + "[0-9A-Za-z_-]{20,}");

  for (const rel of ["scripts/smoke-production.mjs", "server/test/production-routes.test.ts"]) {
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
