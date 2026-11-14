import assert from "node:assert/strict";
import fs from "node:fs";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { env, REPO_ROOT } from "../src/env.ts";
import { resetHubsForTest } from "../src/hub.ts";
import { startServer } from "../src/index.ts";

process.env.HOLDUP_QUIET = "1";

let server: http.Server;
let baseUrl = "";
let prevApiKey = "";
let prevEnvGeminiKey: string | undefined;

before(async () => {
  process.env.HOLDUP_QUIET = "1";
  prevEnvGeminiKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "";
  prevApiKey = env.apiKey;
  env.apiKey = "";
  resetHubsForTest();
  server = await startServer(0);
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  resetHubsForTest();
  env.apiKey = prevApiKey;
  if (prevEnvGeminiKey === undefined) {
    delete process.env.GEMINI_API_KEY;
  } else {
    process.env.GEMINI_API_KEY = prevEnvGeminiKey;
  }
  await closeServer(server);
});

async function closeServer(srv: http.Server): Promise<void> {
  srv.closeAllConnections();
  await new Promise<void>((resolve) => srv.close(() => resolve()));
}

function assertSecurityHeaders(res: Response, label: string): void {
  assert.equal(res.headers.get("x-powered-by"), null, `${label} must omit x-powered-by`);
  assert.equal(
    res.headers.get("x-content-type-options"),
    "nosniff",
    `${label} must set x-content-type-options: nosniff`,
  );
  assert.equal(
    res.headers.get("referrer-policy"),
    "no-referrer",
    `${label} must set referrer-policy: no-referrer`,
  );
  assert.equal(
    res.headers.get("x-frame-options"),
    "SAMEORIGIN",
    `${label} must set x-frame-options: SAMEORIGIN`,
  );
  const permissionsPolicy = (res.headers.get("permissions-policy") ?? "").toLowerCase();
  assert.equal(
    permissionsPolicy.includes("camera=()"),
    false,
    `${label} must not disable camera access`,
  );
  assert.equal(
    permissionsPolicy.includes("microphone=()"),
    false,
    `${label} must not disable microphone access`,
  );
}

test("all required HTML, manifest, API 200, and API 404 routes enforce security headers and API no-store", async () => {
  const staticHtmlRoutes = [
    "/deck/",
    "/judge-handout.html",
    "/printable-props.html",
    "/architecture-poster.html",
  ];

  for (const route of staticHtmlRoutes) {
    const res = await fetch(`${baseUrl}${route}`);
    assert.equal(res.status, 200, `Expected 200 for ${route}`);
    assertSecurityHeaders(res, `GET ${route}`);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/i);
    const html = await res.text();
    assert.ok(html.length > 0, `Expected non-empty HTML body for ${route}`);
  }

  const api200Routes = ["/api/health", "/api/stats", "/api/eval-summary"];
  for (const route of api200Routes) {
    const res = await fetch(`${baseUrl}${route}`);
    assert.equal(res.status, 200, `Expected 200 for ${route}`);
    assertSecurityHeaders(res, `GET ${route}`);
    assert.equal(res.headers.get("cache-control"), "no-store", `Expected no-store on ${route}`);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/i);
    const body = (await res.json()) as Record<string, unknown>;
    if (route === "/api/health") {
      assert.equal(body.ok, true);
      assert.equal(body.gemini, "down");
    }
  }

  const unknownRes = await fetch(`${baseUrl}/api/unknown`);
  assert.equal(unknownRes.status, 404);
  assertSecurityHeaders(unknownRes, "GET /api/unknown");
  assert.equal(unknownRes.headers.get("cache-control"), "no-store");
  assert.match(unknownRes.headers.get("content-type") ?? "", /application\/json/i);
  assert.deepEqual(await unknownRes.json(), {
    type: "error",
    code: "not_found",
    message: "not found",
    recoverable: false,
  });

  const distIndex = path.join(REPO_ROOT, "web", "dist", "index.html");
  const distManifest = path.join(REPO_ROOT, "web", "dist", ".well-known", "meta-wearables-manifest.json");
  const hasBuiltDist = fs.existsSync(distIndex);

  const rootRes = await fetch(`${baseUrl}/`);
  assertSecurityHeaders(rootRes, "GET /");
  const hudRes = await fetch(`${baseUrl}/hud`);
  assertSecurityHeaders(hudRes, "GET /hud");
  const manifestRes = await fetch(`${baseUrl}/.well-known/meta-wearables-manifest.json`);
  assertSecurityHeaders(manifestRes, "GET /.well-known/meta-wearables-manifest.json");

  if (hasBuiltDist) {
    assert.equal(rootRes.status, 200);
    assert.match(rootRes.headers.get("content-type") ?? "", /text\/html/i);
    const rootHtml = await rootRes.text();

    assert.equal(hudRes.status, 200);
    assert.match(hudRes.headers.get("content-type") ?? "", /text\/html/i);
    const hudHtml = await hudRes.text();
    assert.equal(hudHtml, rootHtml);

    assert.equal(manifestRes.status, 200);
    if (fs.existsSync(distManifest)) {
      assert.match(manifestRes.headers.get("content-type") ?? "", /application\/json/i);
      const manifestJson = (await manifestRes.json()) as Record<string, unknown>;
      assert.equal(manifestJson.start_url, "/hud");
      assert.equal(manifestJson.background_color, "#000000");
      assert.equal(manifestJson.theme_color, "#000000");
    } else {
      await manifestRes.text();
    }
  } else {
    assert.equal(rootRes.status, 404);
    await rootRes.json();
    assert.equal(hudRes.status, 404);
    await hudRes.json();
    assert.equal(manifestRes.status, 404);
    await manifestRes.json();
  }
});

test("isolated repoRoot verifies all 10 200 routes, API no-store, ingest routes, and 404 responses unconditionally", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "holdup-sec-headers-"));
  fs.mkdirSync(path.join(tmpRoot, "web", "dist", ".well-known"), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, "deck"), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, "docs"), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, "eval"), { recursive: true });

  const spaHtml = "<!doctype html><html><head><title>HoldUp</title></head><body><div id=\"root\"></div></body></html>";
  const deckHtml = "<!doctype html><html><head><title>Deck</title></head><body><section class=\"slide\">1</section></body></html>";
  const docHtml = "<!doctype html><html><head><title>Doc</title></head><body><main>Doc</main></body></html>";
  const publicManifestRaw = fs.readFileSync(
    path.join(REPO_ROOT, "web", "public", ".well-known", "meta-wearables-manifest.json"),
    "utf8",
  );

  fs.writeFileSync(path.join(tmpRoot, "web", "dist", "index.html"), spaHtml, "utf8");
  fs.writeFileSync(
    path.join(tmpRoot, "web", "dist", ".well-known", "meta-wearables-manifest.json"),
    publicManifestRaw,
    "utf8",
  );
  fs.writeFileSync(path.join(tmpRoot, "deck", "index.html"), deckHtml, "utf8");
  fs.writeFileSync(path.join(tmpRoot, "docs", "judge-handout.html"), docHtml, "utf8");
  fs.writeFileSync(path.join(tmpRoot, "docs", "printable-props.html"), docHtml, "utf8");
  fs.writeFileSync(path.join(tmpRoot, "docs", "architecture-poster.html"), docHtml, "utf8");
  fs.writeFileSync(
    path.join(tmpRoot, "eval", "combined_summary.json"),
    JSON.stringify({
      safety_invariants: { strength_min_conf: 0.8 },
      overall_verdict_accuracy: 0.981,
      total_confident_wrong_dose_count: 0,
      occluded_abstention_rate: 0.982,
      total_label_cases_evaluated: 53,
    }),
    "utf8",
  );

  const isolated = await startServer(0, { repoRoot: tmpRoot });
  const { port } = isolated.address() as AddressInfo;
  const isoBase = `http://127.0.0.1:${port}`;

  try {
    const routes200 = [
      "/",
      "/hud",
      "/deck/",
      "/judge-handout.html",
      "/printable-props.html",
      "/architecture-poster.html",
      "/.well-known/meta-wearables-manifest.json",
      "/api/health",
      "/api/stats",
      "/api/eval-summary",
    ];

    for (const route of routes200) {
      const res = await fetch(`${isoBase}${route}`);
      assert.equal(res.status, 200, `Expected 200 on isolated ${route}`);
      assertSecurityHeaders(res, `isolated GET ${route}`);
      if (route.startsWith("/api/")) {
        assert.equal(res.headers.get("cache-control"), "no-store", `Expected no-store on isolated ${route}`);
      }
      if (route === "/.well-known/meta-wearables-manifest.json") {
        const manifest = (await res.json()) as Record<string, unknown>;
        assert.equal(manifest.start_url, "/hud");
        assert.equal(manifest.background_color, "#000000");
        assert.equal(manifest.theme_color, "#000000");
      } else {
        await res.arrayBuffer();
      }
    }

    const verify400 = await fetch(`${isoBase}/api/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ frames: [] }),
    });
    assert.equal(verify400.status, 400);
    assertSecurityHeaders(verify400, "POST /api/verify");
    assert.equal(verify400.headers.get("cache-control"), "no-store");
    await verify400.json();

    const tts400 = await fetch(`${isoBase}/api/tts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "" }),
    });
    assert.equal(tts400.status, 400);
    assertSecurityHeaders(tts400, "POST /api/tts");
    assert.equal(tts400.headers.get("cache-control"), "no-store");
    await tts400.json();

    const ingestState = await fetch(`${isoBase}/ingest/state`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connected: true, worn: true, streaming: false, battery: 90 }),
    });
    assert.equal(ingestState.status, 204);
    assertSecurityHeaders(ingestState, "POST /ingest/state");
    await ingestState.arrayBuffer();

    const apiUnknown = await fetch(`${isoBase}/api/unknown`);
    assert.equal(apiUnknown.status, 404);
    assertSecurityHeaders(apiUnknown, "isolated GET /api/unknown");
    assert.equal(apiUnknown.headers.get("cache-control"), "no-store");
    await apiUnknown.json();

    const docUnknown = await fetch(`${isoBase}/missing-doc.html`);
    assert.equal(docUnknown.status, 404);
    assertSecurityHeaders(docUnknown, "isolated GET /missing-doc.html");
    await docUnknown.json();
  } finally {
    await closeServer(isolated);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("server/src/index.ts and server/test/security-headers.test.ts contain zero comments, em dashes, or keys", () => {
  const slash = String.fromCharCode(47);
  const star = String.fromCharCode(42);
  const blockToken = slash + star;
  const lineCommentRe = new RegExp(`(^|[^:])${slash}${slash}`);
  const emDash = String.fromCharCode(0x2014);
  const coAuthoredRe = new RegExp(["Co", "Authored", "By"].join("-"), "i");
  const apiKeyRe = new RegExp("AIza" + "[0-9A-Za-z_-]{20,}");

  for (const rel of ["server/src/index.ts", "server/test/security-headers.test.ts"]) {
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
