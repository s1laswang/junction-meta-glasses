import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { env, REPO_ROOT, SERVER_DIR } from "../src/env.ts";
import { startServer } from "../src/index.ts";

const TEST_ACCESS_KEY = "test-static-routing-key";
const origQuiet = process.env.HOLDUP_QUIET;
const origHoldupKey = process.env.HOLDUP_KEY;
const origApiKey = env.apiKey;

const distDir = path.join(REPO_ROOT, "web", "dist");
const hudIndexPath = path.join(distDir, "hud", "index.html");

const PHONE_INDEX_HTML = [
  "<!doctype html>",
  "<html lang=\"en\">",
  "<head>",
  "<meta charset=\"utf-8\" />",
  "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />",
  "<link rel=\"manifest\" href=\"/manifest.webmanifest\" />",
  "<title>HoldUp Phone App</title>",
  "</head>",
  "<body data-entry=\"phone-spa\"><div id=\"root\"></div></body>",
  "</html>",
  "",
].join("\n");

const HUD_INDEX_HTML = [
  "<!doctype html>",
  "<html lang=\"en\">",
  "<head>",
  "<meta charset=\"utf-8\" />",
  "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />",
  "<meta name=\"mrbd-web-app-capable\" content=\"yes\" />",
  "<title>HoldUp HUD</title>",
  "</head>",
  "<body class=\"hud-body\" data-entry=\"glasses-hud\"><div id=\"root\"></div></body>",
  "</html>",
  "",
].join("\n");

const MANIFEST_OBJECT = {
  version: 1,
  name: "HoldUp",
  description: "Hold up a medicine box or food package; HoldUp tells you if it is the right one.",
  appearance: {
    theme_color: "#2E7D32",
    icon: {
      src: "../icon-mono.png",
      type: "monochrome",
    },
  },
};

const MANIFEST_JSON = `${JSON.stringify(MANIFEST_OBJECT, null, 2)}\n`;
const BUNDLE_JS = "export const bundleHash = \"abc123\";\n";

const indexSource = fs.readFileSync(path.join(SERVER_DIR, "src", "index.ts"), "utf8");
const hasSecurityHeadersMiddleware =
  indexSource.includes("X-Content-Type-Options") &&
  indexSource.includes("Referrer-Policy") &&
  indexSource.includes("X-Frame-Options");

const createdDirs: string[] = [];
const createdFiles: string[] = [];
const overwrittenFiles: Array<{ filePath: string; prevContent: Buffer }> = [];
let distCleanedUp = false;

let server: http.Server;
let baseUrl = "";

function ensureDirTracked(targetDir: string) {
  const rel = path.relative(REPO_ROOT, targetDir);
  const parts = rel.split(path.sep).filter(Boolean);
  let cur = REPO_ROOT;
  for (const part of parts) {
    cur = path.join(cur, part);
    if (!fs.existsSync(cur)) {
      fs.mkdirSync(cur);
      createdDirs.push(cur);
    }
  }
}

function writeFixtureTracked(relInsideDist: string, content: string) {
  const fullPath = path.join(distDir, relInsideDist);
  ensureDirTracked(path.dirname(fullPath));
  if (fs.existsSync(fullPath)) {
    overwrittenFiles.push({ filePath: fullPath, prevContent: fs.readFileSync(fullPath) });
  } else {
    createdFiles.push(fullPath);
  }
  fs.writeFileSync(fullPath, content, "utf8");
}

function setupDistFixtures() {
  ensureDirTracked(distDir);
  writeFixtureTracked("index.html", PHONE_INDEX_HTML);
  writeFixtureTracked(path.join("hud", "index.html"), HUD_INDEX_HTML);
  writeFixtureTracked(path.join("hud", ".well-known", "meta-wearables-manifest.json"), MANIFEST_JSON);
  writeFixtureTracked(path.join("assets", "bundle.abc123.js"), BUNDLE_JS);
}

function cleanupDistFixtures() {
  if (distCleanedUp) return;
  distCleanedUp = true;
  for (const filePath of createdFiles) {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {}
  }
  for (const { filePath, prevContent } of overwrittenFiles) {
    try {
      fs.writeFileSync(filePath, prevContent);
    } catch {}
  }
  for (const dirPath of [...createdDirs].reverse()) {
    try {
      fs.rmdirSync(dirPath);
    } catch {}
  }
}

process.once("exit", cleanupDistFixtures);

function restoreHoldupKey() {
  if (origHoldupKey === undefined) delete process.env.HOLDUP_KEY;
  else process.env.HOLDUP_KEY = origHoldupKey;
}

function assertSecurityHeaders(res: Response) {
  assert.equal(res.headers.has("x-powered-by"), false);
  assert.equal(res.headers.get("x-powered-by"), null);
  if (hasSecurityHeadersMiddleware) {
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    assert.equal(res.headers.get("x-frame-options"), "SAMEORIGIN");
  }
}

async function assertNotFoundJson(res: Response) {
  assert.equal(res.status, 404);
  assertSecurityHeaders(res);
  const contentType = res.headers.get("content-type") ?? "";
  assert.match(contentType, /application\/json/i);
  const body = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(body, {
    type: "error",
    code: "not_found",
    message: "not found",
    recoverable: false,
  });
}

before(async () => {
  process.env.HOLDUP_QUIET = "1";
  env.apiKey = "";
  delete process.env.HOLDUP_KEY;
  setupDistFixtures();
  server = await startServer(0);
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("unexpected server address");
  baseUrl = ["http:", "", `127.0.0.1:${addr.port}`].join("/");
});

afterEach(() => {
  restoreHoldupKey();
});

after(async () => {
  try {
    restoreHoldupKey();
    if (origQuiet === undefined) delete process.env.HOLDUP_QUIET;
    else process.env.HOLDUP_QUIET = origQuiet;
    env.apiKey = origApiKey;
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    cleanupDistFixtures();
  }
});

test("GET / and SPA client routes (/profile, /privacy, nested, /hudson) plus HEAD serve phone index.html with Cache-Control: no-cache and security headers", async () => {
  for (const route of ["/", "/profile", "/privacy", "/check/session/demo", "/hudson"]) {
    const res = await fetch(`${baseUrl}${route}`);
    assert.equal(res.status, 200, `GET ${route}`);
    assertSecurityHeaders(res);
    assert.equal(res.headers.get("cache-control"), "no-cache", `Cache-Control on GET ${route}`);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/i);
    const html = await res.text();
    assert.equal(html, PHONE_INDEX_HTML, `phone HTML on GET ${route}`);
    assert.equal(html.includes("hud-body"), false);
  }

  for (const route of ["/", "/profile", "/privacy"]) {
    const headRes = await fetch(`${baseUrl}${route}`, { method: "HEAD" });
    assert.equal(headRes.status, 200, `HEAD ${route}`);
    assertSecurityHeaders(headRes);
    assert.equal(headRes.headers.get("cache-control"), "no-cache", `Cache-Control on HEAD ${route}`);
    assert.match(headRes.headers.get("content-type") ?? "", /text\/html/i);
    assert.equal(await headRes.text(), "");
  }
});

test("Phone root and SPA client routes remain public when HOLDUP_KEY is set", async () => {
  process.env.HOLDUP_KEY = TEST_ACCESS_KEY;

  const gatedApiRes = await fetch(`${baseUrl}/api/stats`);
  assert.equal(gatedApiRes.status, 401);
  assertSecurityHeaders(gatedApiRes);
  const gatedBody = (await gatedApiRes.json()) as Record<string, unknown>;
  assert.equal(gatedBody.code, "unauthorized");

  for (const route of ["/", "/profile", "/privacy"]) {
    const noKeyRes = await fetch(`${baseUrl}${route}`);
    assert.equal(noKeyRes.status, 200, `public GET ${route} without key`);
    assertSecurityHeaders(noKeyRes);
    assert.equal(noKeyRes.headers.get("cache-control"), "no-cache");
    assert.equal(await noKeyRes.text(), PHONE_INDEX_HTML);

    const wrongKeyRes = await fetch(`${baseUrl}${route}?key=wrong-key`, {
      headers: { "x-holdup-key": "wrong-key" },
    });
    assert.equal(wrongKeyRes.status, 200, `public GET ${route} with wrong key`);
    assertSecurityHeaders(wrongKeyRes);
    assert.equal(wrongKeyRes.headers.get("cache-control"), "no-cache");
    assert.equal(await wrongKeyRes.text(), PHONE_INDEX_HTML);
  }

  const headRootRes = await fetch(`${baseUrl}/`, { method: "HEAD" });
  assert.equal(headRootRes.status, 200);
  assertSecurityHeaders(headRootRes);
  assert.equal(headRootRes.headers.get("cache-control"), "no-cache");
  assert.equal(await headRootRes.text(), "");
});

test("GET /hud/, GET /hud/subpath, and GET /hud serve hud/index.html (never phone index.html) with Cache-Control: no-cache", async () => {
  for (const route of ["/hud/", "/hud/subpath", "/hud/deep/nested?session=demo"]) {
    const res = await fetch(`${baseUrl}${route}`);
    assert.equal(res.status, 200, `GET ${route}`);
    assertSecurityHeaders(res);
    assert.equal(res.headers.get("cache-control"), "no-cache", `Cache-Control on GET ${route}`);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/i);
    const html = await res.text();
    assert.equal(html, HUD_INDEX_HTML, `HUD HTML on GET ${route}`);
    assert.notEqual(html, PHONE_INDEX_HTML);
  }

  const manualHudRes = await fetch(`${baseUrl}/hud`, { redirect: "manual" });
  assertSecurityHeaders(manualHudRes);
  assert.ok(
    manualHudRes.status === 301 || manualHudRes.status === 302 || manualHudRes.status === 200,
    `expected 301/302/200 for GET /hud, got ${manualHudRes.status}`,
  );
  if (manualHudRes.status === 301 || manualHudRes.status === 302) {
    const loc = manualHudRes.headers.get("location") ?? "";
    assert.ok(loc === "/hud/" || loc.endsWith("/hud/"), `expected redirect to /hud/, got ${loc}`);
  } else {
    assert.equal(manualHudRes.headers.get("cache-control"), "no-cache");
    assert.equal(await manualHudRes.text(), HUD_INDEX_HTML);
  }

  const followedHudRes = await fetch(`${baseUrl}/hud`);
  assert.equal(followedHudRes.status, 200);
  assertSecurityHeaders(followedHudRes);
  assert.equal(followedHudRes.headers.get("cache-control"), "no-cache");
  assert.match(followedHudRes.headers.get("content-type") ?? "", /text\/html/i);
  const followedHtml = await followedHudRes.text();
  assert.equal(followedHtml, HUD_INDEX_HTML);
  assert.notEqual(followedHtml, PHONE_INDEX_HTML);

  for (const route of ["/hud/", "/hud/subpath"]) {
    const headHudRes = await fetch(`${baseUrl}${route}`, { method: "HEAD" });
    assert.equal(headHudRes.status, 200, `HEAD ${route}`);
    assertSecurityHeaders(headHudRes);
    assert.equal(headHudRes.headers.get("cache-control"), "no-cache");
    assert.equal(await headHudRes.text(), "");
  }
});

test("HUD routes (/hud/, /hud/subpath, /hud) remain public when HOLDUP_KEY is set", async () => {
  process.env.HOLDUP_KEY = TEST_ACCESS_KEY;

  for (const route of ["/hud/", "/hud/subpath", "/hud"]) {
    const noKeyRes = await fetch(`${baseUrl}${route}`);
    assert.equal(noKeyRes.status, 200, `public GET ${route} without key`);
    assertSecurityHeaders(noKeyRes);
    assert.equal(noKeyRes.headers.get("cache-control"), "no-cache");
    assert.equal(await noKeyRes.text(), HUD_INDEX_HTML);

    const wrongKeyRes = await fetch(`${baseUrl}${route}?key=wrong-key`, {
      headers: { "x-holdup-key": "wrong-key" },
    });
    assert.equal(wrongKeyRes.status, 200, `public GET ${route} with wrong key`);
    assertSecurityHeaders(wrongKeyRes);
    assert.equal(wrongKeyRes.headers.get("cache-control"), "no-cache");
    assert.equal(await wrongKeyRes.text(), HUD_INDEX_HTML);
  }
});

test("GET /hud/.well-known/meta-wearables-manifest.json returns 200 JSON with Cache-Control: no-cache via dotfiles: allow", async () => {
  const manifestPath = "/hud/.well-known/meta-wearables-manifest.json";

  const openRes = await fetch(`${baseUrl}${manifestPath}`);
  assert.equal(openRes.status, 200);
  assertSecurityHeaders(openRes);
  assert.equal(openRes.headers.get("cache-control"), "no-cache");
  assert.match(openRes.headers.get("content-type") ?? "", /application\/json/i);
  const parsed = (await openRes.json()) as Record<string, unknown>;
  assert.deepEqual(parsed, MANIFEST_OBJECT);

  const headRes = await fetch(`${baseUrl}${manifestPath}`, { method: "HEAD" });
  assert.equal(headRes.status, 200);
  assertSecurityHeaders(headRes);
  assert.equal(headRes.headers.get("cache-control"), "no-cache");
  assert.match(headRes.headers.get("content-type") ?? "", /application\/json/i);
  assert.equal(await headRes.text(), "");

  process.env.HOLDUP_KEY = TEST_ACCESS_KEY;
  const keyedRes = await fetch(`${baseUrl}${manifestPath}`);
  assert.equal(keyedRes.status, 200);
  assertSecurityHeaders(keyedRes);
  assert.equal(keyedRes.headers.get("cache-control"), "no-cache");
  assert.match(keyedRes.headers.get("content-type") ?? "", /application\/json/i);
  assert.deepEqual(await keyedRes.json(), MANIFEST_OBJECT);
});

test("GET /assets/bundle.abc123.js returns 200 with max-age=3600 and not no-cache", async () => {
  const assetPath = "/assets/bundle.abc123.js";

  const openRes = await fetch(`${baseUrl}${assetPath}`);
  assert.equal(openRes.status, 200);
  assertSecurityHeaders(openRes);
  const cc = openRes.headers.get("cache-control") ?? "";
  assert.match(cc, /\bmax-age=3600\b/);
  assert.equal(cc.includes("no-cache"), false);
  assert.match(openRes.headers.get("content-type") ?? "", /javascript/i);
  assert.equal(await openRes.text(), BUNDLE_JS);

  process.env.HOLDUP_KEY = TEST_ACCESS_KEY;
  const keyedRes = await fetch(`${baseUrl}${assetPath}`);
  assert.equal(keyedRes.status, 200);
  assertSecurityHeaders(keyedRes);
  const keyedCc = keyedRes.headers.get("cache-control") ?? "";
  assert.match(keyedCc, /\bmax-age=3600\b/);
  assert.equal(keyedCc.includes("no-cache"), false);
  assert.equal(await keyedRes.text(), BUNDLE_JS);
});

test("Reserved prefixes (/api/unknown, /ingest/unknown, /live, /hud-ws) and non-GET/HEAD methods never fall through to SPA index.html", async () => {
  for (const reservedPath of [
    "/api",
    "/api/unknown",
    "/ingest",
    "/ingest/unknown",
    "/live",
    "/live/subpath",
    "/hud-ws",
    "/hud-ws/subpath",
  ]) {
    const res = await fetch(`${baseUrl}${reservedPath}`);
    await assertNotFoundJson(res);
  }

  const headApiUnknown = await fetch(`${baseUrl}/api/unknown`, { method: "HEAD" });
  assert.equal(headApiUnknown.status, 404);
  assertSecurityHeaders(headApiUnknown);
  assert.match(headApiUnknown.headers.get("content-type") ?? "", /application\/json/i);
  assert.equal(await headApiUnknown.text(), "");

  for (const [method, route] of [
    ["POST", "/some-route"],
    ["POST", "/"],
    ["POST", "/profile"],
    ["PUT", "/privacy"],
    ["DELETE", "/hud/"],
    ["PATCH", "/hud/subpath"],
  ] as const) {
    const res = await fetch(`${baseUrl}${route}`, { method });
    await assertNotFoundJson(res);
  }

  process.env.HOLDUP_KEY = TEST_ACCESS_KEY;
  for (const authReserved of ["/api/unknown", "/ingest/unknown"]) {
    const unauthRes = await fetch(`${baseUrl}${authReserved}`);
    assert.equal(unauthRes.status, 401);
    assertSecurityHeaders(unauthRes);
    assert.match(unauthRes.headers.get("content-type") ?? "", /application\/json/i);
    assert.deepEqual(await unauthRes.json(), {
      type: "error",
      code: "unauthorized",
      message: "access key required",
      recoverable: false,
    });

    const authedRes = await fetch(`${baseUrl}${authReserved}?key=${TEST_ACCESS_KEY}`);
    await assertNotFoundJson(authedRes);
  }

  for (const wsReserved of ["/live", "/hud-ws"]) {
    const res = await fetch(`${baseUrl}${wsReserved}`);
    await assertNotFoundJson(res);
  }
});

test("HUD subpath fallback falls back to phone index.html when hud/index.html is absent", async () => {
  fs.unlinkSync(hudIndexPath);
  try {
    const fallbackRes = await fetch(`${baseUrl}/hud/subpath`);
    assert.equal(fallbackRes.status, 200);
    assertSecurityHeaders(fallbackRes);
    assert.equal(fallbackRes.headers.get("cache-control"), "no-cache");
    assert.equal(await fallbackRes.text(), PHONE_INDEX_HTML);
  } finally {
    fs.writeFileSync(hudIndexPath, HUD_INDEX_HTML, "utf8");
  }

  const restoredRes = await fetch(`${baseUrl}/hud/subpath`);
  assert.equal(restoredRes.status, 200);
  assert.equal(await restoredRes.text(), HUD_INDEX_HTML);
});
