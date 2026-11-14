import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

const EXPECTED_FIXTURES = Object.freeze([
  "amlodipine.jpg",
  "back_of_box.jpg",
  "blurry_amlodipine.jpg",
  "expired_metformin.jpg",
  "hazelnut_bar.jpg",
  "ibuprofen.jpg",
  "oat_milk.jpg",
]);

function ensureProductionBuild(rootDir) {
  const distIndex = path.join(rootDir, "web", "dist", "index.html");
  if (fs.existsSync(distIndex) && fs.statSync(distIndex).isFile()) {
    return distIndex;
  }
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  execFileSync(npmCmd, ["run", "build"], {
    cwd: rootDir,
    stdio: "inherit",
    env: { ...process.env },
  });
  assert.ok(
    fs.existsSync(distIndex) && fs.statSync(distIndex).isFile(),
    "Expected web/dist/index.html after npm run build",
  );
  return distIndex;
}

async function loadServerEntrypoint(rootDir) {
  process.env.HOLDUP_QUIET = "1";
  process.env.GEMINI_API_KEY = "";
  const envUrl = pathToFileURL(path.join(rootDir, "server", "src", "env.ts")).href;
  const indexUrl = pathToFileURL(path.join(rootDir, "server", "src", "index.ts")).href;
  const envMod = await import(envUrl);
  envMod.env.apiKey = "";
  const indexMod = await import(indexUrl);
  return { startServer: indexMod.startServer };
}

function assertNoPositiveCacheOnApi(res, route) {
  const cc = res.headers.get("cache-control");
  if (cc !== null) {
    assert.doesNotMatch(cc, /\bpublic\b/i, `Expected ${route} never to advertise public cache, got ${cc}`);
    assert.doesNotMatch(cc, /max-age=[1-9]/i, `Expected ${route} never to have positive max-age, got ${cc}`);
    assert.match(cc, /\bno-store\b/i, `Expected ${route} Cache-Control to include no-store when set, got ${cc}`);
  }
}

function verifyWearablesManifestObject(manifest, label) {
  assert.ok(manifest && typeof manifest === "object" && !Array.isArray(manifest), `${label} must be an object`);
  assert.equal(manifest.name, "HoldUp", `${label} name must be HoldUp`);
  assert.equal(manifest.short_name, "HoldUp", `${label} short_name must be HoldUp`);
  assert.equal(typeof manifest.description, "string", `${label} description must be string`);
  assert.ok(manifest.description.length > 0, `${label} description must be non-empty`);
  assert.equal(manifest.start_url, "/hud", `${label} start_url must be /hud`);
  assert.equal(manifest.display, "standalone", `${label} display must be standalone`);
  assert.equal(manifest.background_color, "#000000", `${label} background_color must be #000000`);
  assert.equal(manifest.theme_color, "#000000", `${label} theme_color must be #000000`);
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0, `${label} icons must be non-empty`);
  assert.ok(
    manifest.icons.some(
      (icon) => icon && icon.src === "/icon.svg" && icon.type === "image/svg+xml" && icon.sizes === "512x512",
    ),
    `${label} must include /icon.svg 512x512 image/svg+xml`,
  );
}

async function runSmoke() {
  const t0 = Date.now();
  const distIndexPath = ensureProductionBuild(REPO_ROOT);
  const expectedIndexHtml = fs.readFileSync(distIndexPath, "utf8");

  const publicWearablesPath = path.join(REPO_ROOT, "web", "public", ".well-known", "meta-wearables-manifest.json");
  const distWearablesPath = path.join(REPO_ROOT, "web", "dist", ".well-known", "meta-wearables-manifest.json");
  assert.ok(fs.existsSync(publicWearablesPath), "Missing web/public/.well-known/meta-wearables-manifest.json");
  assert.ok(fs.existsSync(distWearablesPath), "Missing web/dist/.well-known/meta-wearables-manifest.json");
  const publicWearablesRaw = fs.readFileSync(publicWearablesPath, "utf8");
  const distWearablesRaw = fs.readFileSync(distWearablesPath, "utf8");
  assert.equal(distWearablesRaw, publicWearablesRaw, "Expected dist wearables manifest to match public manifest");
  verifyWearablesManifestObject(JSON.parse(publicWearablesRaw), "disk meta-wearables-manifest.json");

  let startServer;
  try {
    ({ startServer } = await loadServerEntrypoint(REPO_ROOT));
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? err.code : "";
    if (
      (code === "ERR_UNKNOWN_FILE_EXTENSION" || code === "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX") &&
      process.env.HOLDUP_SMOKE_REEXEC !== "1"
    ) {
      const res = spawnSync(process.execPath, ["--import", "tsx", SCRIPT_PATH], {
        cwd: REPO_ROOT,
        stdio: "inherit",
        env: { ...process.env, HOLDUP_SMOKE_REEXEC: "1" },
      });
      process.exit(res.status ?? 1);
    }
    throw err;
  }

  const server = await startServer(0, { repoRoot: REPO_ROOT });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  assert.ok(port > 0, `Expected ephemeral port > 0, got ${port}`);
  const baseUrl = `http://127.0.0.1:${port}`;
  let probedCount = 0;

  try {
    const rootRes = await fetch(`${baseUrl}/`);
    probedCount++;
    assert.equal(rootRes.status, 200, "GET / must return 200");
    assert.equal(rootRes.headers.get("x-powered-by"), null);
    assert.match(rootRes.headers.get("content-type") ?? "", /text\/html/i);
    assert.match(rootRes.headers.get("cache-control") ?? "", /max-age=3600/i);
    const rootHtml = await rootRes.text();
    assert.equal(rootHtml, expectedIndexHtml);
    assert.match(rootHtml, /manifest\.webmanifest/i);

    const hudRes = await fetch(`${baseUrl}/hud`);
    probedCount++;
    assert.equal(hudRes.status, 200, "GET /hud must return 200");
    assert.equal(hudRes.headers.get("x-powered-by"), null);
    assert.match(hudRes.headers.get("content-type") ?? "", /text\/html/i);
    const hudHtml = await hudRes.text();
    assert.equal(hudHtml, expectedIndexHtml);

    const propsRes = await fetch(`${baseUrl}/printable-props.html`);
    probedCount++;
    assert.equal(propsRes.status, 200, "GET /printable-props.html must return 200");
    assert.equal(propsRes.headers.get("x-powered-by"), null);
    assert.match(propsRes.headers.get("content-type") ?? "", /text\/html/i);
    const propsHtml = await propsRes.text();
    assert.match(propsHtml, /Amlodipin 5 mg/);
    assert.match(propsHtml, /<svg[^>]*class="barcode-svg"/i);

    const handoutRes = await fetch(`${baseUrl}/judge-handout.html`);
    probedCount++;
    assert.equal(handoutRes.status, 200, "GET /judge-handout.html must return 200");
    assert.equal(handoutRes.headers.get("x-powered-by"), null);
    assert.match(handoutRes.headers.get("content-type") ?? "", /text\/html/i);
    const handoutHtml = await handoutRes.text();
    assert.match(handoutHtml, /STRENGTH_MIN_CONF = 0\.80/);
    assert.match(handoutHtml, /\/hud-ws/);

    const posterRes = await fetch(`${baseUrl}/architecture-poster.html`);
    probedCount++;
    assert.equal(posterRes.status, 200, "GET /architecture-poster.html must return 200");
    assert.equal(posterRes.headers.get("x-powered-by"), null);
    assert.match(posterRes.headers.get("content-type") ?? "", /text\/html/i);
    const posterHtml = await posterRes.text();
    assert.match(posterHtml, /<svg/i);
    assert.match(posterHtml, /STRENGTH_MIN_CONF = 0\.80/);

    const webmanifestRes = await fetch(`${baseUrl}/manifest.webmanifest`);
    probedCount++;
    assert.equal(webmanifestRes.status, 200, "GET /manifest.webmanifest must return 200");
    assert.equal(webmanifestRes.headers.get("x-powered-by"), null);
    assert.match(webmanifestRes.headers.get("content-type") ?? "", /application\/(manifest\+)?json/i);
    const webmanifest = await webmanifestRes.json();
    assert.equal(webmanifest.short_name, "HoldUp");
    assert.equal(webmanifest.start_url, "/");
    assert.equal(webmanifest.display, "standalone");

    const swRes = await fetch(`${baseUrl}/sw.js`);
    probedCount++;
    assert.equal(swRes.status, 200, "GET /sw.js must return 200");
    assert.equal(swRes.headers.get("x-powered-by"), null);
    assert.match(swRes.headers.get("content-type") ?? "", /(text|application)\/javascript/i);
    const swText = await swRes.text();
    assert.match(swText, /CACHE_NAME/);
    assert.match(swText, /isNeverCachedPath/);

    const wearablesRes = await fetch(`${baseUrl}/.well-known/meta-wearables-manifest.json`);
    probedCount++;
    assert.equal(wearablesRes.status, 200, "GET /.well-known/meta-wearables-manifest.json must return 200");
    assert.equal(wearablesRes.headers.get("x-powered-by"), null);
    const wearablesCt = wearablesRes.headers.get("content-type") ?? "";
    if (/json/i.test(wearablesCt)) {
      const wearablesJson = await wearablesRes.json();
      verifyWearablesManifestObject(wearablesJson, "HTTP /.well-known/meta-wearables-manifest.json");
    } else {
      assert.match(wearablesCt, /text\/html/i);
      const fallbackHtml = await wearablesRes.text();
      assert.equal(fallbackHtml, expectedIndexHtml);
      console.log("NOTICE /.well-known/meta-wearables-manifest.json served SPA HTML fallback; disk manifest verified");
    }

    for (const fixtureName of EXPECTED_FIXTURES) {
      const route = `/fixtures/${fixtureName}`;
      const diskBytes = fs.readFileSync(path.join(REPO_ROOT, "web", "public", "fixtures", fixtureName));
      const fixRes = await fetch(`${baseUrl}${route}`);
      probedCount++;
      assert.equal(fixRes.status, 200, `GET ${route} must return 200`);
      assert.equal(fixRes.headers.get("x-powered-by"), null);
      assert.match(fixRes.headers.get("content-type") ?? "", /^image\/jpeg\b/i);
      assert.match(fixRes.headers.get("cache-control") ?? "", /max-age=3600/i);
      const buf = Buffer.from(await fixRes.arrayBuffer());
      assert.equal(buf.length, diskBytes.length, `GET ${route} byte length mismatch`);
      assert.ok(buf.length >= 10 * 1024 && buf.length <= 200 * 1024, `GET ${route} size out of bounds`);
      assert.equal(buf[0], 0xff);
      assert.equal(buf[1], 0xd8);
      assert.equal(buf[buf.length - 2], 0xff);
      assert.equal(buf[buf.length - 1], 0xd9);
    }

    const healthRes = await fetch(`${baseUrl}/api/health`);
    probedCount++;
    assert.equal(healthRes.status, 200, "GET /api/health must return 200");
    assert.equal(healthRes.headers.get("x-powered-by"), null);
    assert.match(healthRes.headers.get("content-type") ?? "", /application\/json/i);
    assertNoPositiveCacheOnApi(healthRes, "/api/health");
    const healthRaw = await healthRes.text();
    assert.doesNotMatch(healthRaw, /AIza[0-9A-Za-z_-]{20,}/);
    const healthJson = JSON.parse(healthRaw);
    assert.equal(healthJson.ok, true);
    assert.ok(Array.isArray(healthJson.models?.live));
    assert.ok(Array.isArray(healthJson.models?.verify));
    assert.ok(Array.isArray(healthJson.models?.tts));

    const statsRes = await fetch(`${baseUrl}/api/stats`);
    probedCount++;
    assert.equal(statsRes.status, 200, "GET /api/stats must return 200");
    assert.equal(statsRes.headers.get("x-powered-by"), null);
    assert.match(statsRes.headers.get("content-type") ?? "", /application\/json/i);
    assertNoPositiveCacheOnApi(statsRes, "/api/stats");
    const statsJson = await statsRes.json();
    assert.equal(typeof statsJson.total, "number");
    assert.ok(statsJson.features && typeof statsJson.features === "object");

    const evalRes = await fetch(`${baseUrl}/api/eval-summary`);
    probedCount++;
    assert.equal(evalRes.status, 200, "GET /api/eval-summary must return 200");
    assert.equal(evalRes.headers.get("x-powered-by"), null);
    assert.match(evalRes.headers.get("content-type") ?? "", /application\/json/i);
    assertNoPositiveCacheOnApi(evalRes, "/api/eval-summary");
    const evalJson = await evalRes.json();
    assert.equal(evalJson.ok, true);
    assert.equal(evalJson.summary?.headline_metrics?.never_guess_strength_min_conf, 0.8);

    const unknownRes = await fetch(`${baseUrl}/api/unknown`);
    probedCount++;
    assert.equal(unknownRes.status, 404, "GET /api/unknown must return 404");
    assert.equal(unknownRes.headers.get("x-powered-by"), null);
    assert.match(unknownRes.headers.get("content-type") ?? "", /application\/json/i);
    assertNoPositiveCacheOnApi(unknownRes, "/api/unknown");
    const unknownJson = await unknownRes.json();
    assert.deepEqual(unknownJson, {
      type: "error",
      code: "not_found",
      message: "not found",
      recoverable: false,
    });

    const deckIndexPath = path.join(REPO_ROOT, "deck", "index.html");
    let deckStatus = "absent";
    if (fs.existsSync(deckIndexPath) && fs.statSync(deckIndexPath).isFile()) {
      const expectedDeckHtml = fs.readFileSync(deckIndexPath, "utf8");
      const deckRes = await fetch(`${baseUrl}/deck/`);
      probedCount++;
      assert.equal(deckRes.status, 200, "GET /deck/ must return 200 when deck/index.html exists");
      assert.equal(deckRes.headers.get("x-powered-by"), null);
      assert.match(deckRes.headers.get("content-type") ?? "", /text\/html/i);
      assert.match(deckRes.headers.get("cache-control") ?? "", /max-age=3600/i);
      const deckHtml = await deckRes.text();
      assert.equal(deckHtml, expectedDeckHtml);
      deckStatus = "200";
    }

    console.log(
      `PASS smoke-production: ${probedCount} routes verified on :${port} (7 JPEG fixtures, deck=${deckStatus}, ${Date.now() - t0} ms)`,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

runSmoke().catch((err) => {
  console.error("FAIL smoke-production:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
