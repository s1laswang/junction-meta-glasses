import fs from "node:fs";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { env, REPO_ROOT } from "../src/env.ts";
import { startServer } from "../src/index.ts";

process.env.HOLDUP_QUIET = "1";

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

async function closeHttpServer(srv: http.Server): Promise<void> {
  srv.closeAllConnections();
  await new Promise<void>((resolve) => srv.close(() => resolve()));
}

test("GET /api/eval-summary returns 200 JSON with ok true and never_guess_strength_min_conf 0.8", async () => {
  const res = await fetch(`${baseUrl}/api/eval-summary`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-powered-by"), null);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/i);
  const body = (await res.json()) as Record<string, any>;
  assert.equal(body.ok, true);
  assert.equal(typeof body.summary, "object");
  assert.notEqual(body.summary, null);
  assert.equal(body.summary.headline_metrics?.never_guess_strength_min_conf, 0.8);
  assert.equal(body.summary.safety_invariants?.strength_min_conf, 0.8);
});

test("GET /printable-props.html returns 200 text/html with AMLODIPIN and SVG barcode markup", async () => {
  const res = await fetch(`${baseUrl}/printable-props.html`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-powered-by"), null);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/i);
  const html = await res.text();
  assert.match(html, /amlodipin/i);
  assert.match(html, /<svg[^>]*class="barcode-svg"/i);
  assert.match(html, /<\/svg>/i);
});

test("GET /deck/nonexistent-asset.js returns 404 JSON not_found and never SPA HTML", async () => {
  const res = await fetch(`${baseUrl}/deck/nonexistent-asset.js`);
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("x-powered-by"), null);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/i);
  const body = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(body, {
    type: "error",
    code: "not_found",
    message: "not found",
    recoverable: false,
  });
});

test("GET /hud returns 200 HTML from web/dist/index.html when web/dist exists", async () => {
  const distIndex = path.join(REPO_ROOT, "web", "dist", "index.html");
  const res = await fetch(`${baseUrl}/hud`);
  if (fs.existsSync(distIndex)) {
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/i);
    const html = await res.text();
    const expected = fs.readFileSync(distIndex, "utf8");
    assert.equal(html, expected);
  } else {
    assert.equal(res.status, 404);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.code, "not_found");
  }
});

test("isolated repoRoot covers /deck static serving, /judge-handout.html, eval-summary 10s cache and missing fallback, and SPA /hud isolation", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "holdup-routes-"));
  fs.mkdirSync(path.join(tmpDir, "deck"), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, "docs"), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, "eval"), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, "web", "dist"), { recursive: true });

  const spaHtml = "<!doctype html><html><head><title>HoldUp SPA</title></head><body><div id=\"root\"></div></body></html>";
  const deckHtml = "<!doctype html><html><head><title>HoldUp 12-Slide Deck</title></head><body><section class=\"slide\">Slide 1</section></body></html>";
  const handoutHtml = "<!doctype html><html><head><title>HoldUp Judge Handout</title></head><body><h1>Quick-Start Handout</h1></body></html>";

  fs.writeFileSync(path.join(tmpDir, "web", "dist", "index.html"), spaHtml, "utf8");
  fs.writeFileSync(path.join(tmpDir, "deck", "index.html"), deckHtml, "utf8");
  fs.writeFileSync(path.join(tmpDir, "deck", "deck.css"), ".slide { color: #fff; }", "utf8");

  const tempServer = await startServer(0, { repoRoot: tmpDir });
  const { port } = tempServer.address() as AddressInfo;
  const tempBase = `http://127.0.0.1:${port}`;

  try {
    const missingEvalRes = await fetch(`${tempBase}/api/eval-summary`);
    assert.equal(missingEvalRes.status, 200);
    assert.deepEqual(await missingEvalRes.json(), { ok: false, summary: null });

    const evalPath = path.join(tmpDir, "eval", "combined_summary.json");
    fs.writeFileSync(evalPath, "{corrupt-json", "utf8");
    const corruptEvalRes = await fetch(`${tempBase}/api/eval-summary`);
    assert.equal(corruptEvalRes.status, 200);
    assert.deepEqual(await corruptEvalRes.json(), { ok: false, summary: null });

    fs.writeFileSync(
      evalPath,
      JSON.stringify({
        generated_at: "2026-11-14T15:00:00Z",
        safety_invariants: { strength_min_conf: 0.8 },
        overall_verdict_accuracy: 1.0,
        total_confident_wrong_dose_count: 0,
        occluded_abstention_rate: 1.0,
        total_label_cases_evaluated: 25,
      }),
      "utf8",
    );

    const validEvalRes = await fetch(`${tempBase}/api/eval-summary`);
    assert.equal(validEvalRes.status, 200);
    const validBody = (await validEvalRes.json()) as Record<string, any>;
    assert.equal(validBody.ok, true);
    assert.equal(validBody.summary.headline_metrics.never_guess_strength_min_conf, 0.8);
    assert.equal(validBody.summary.total_label_cases_evaluated, 25);

    fs.rmSync(evalPath, { force: true });
    const cachedEvalRes = await fetch(`${tempBase}/api/eval-summary`);
    assert.equal(cachedEvalRes.status, 200);
    const cachedBody = (await cachedEvalRes.json()) as Record<string, any>;
    assert.equal(cachedBody.ok, true);
    assert.equal(cachedBody.summary.headline_metrics.never_guess_strength_min_conf, 0.8);

    const deckRootRes = await fetch(`${tempBase}/deck`);
    assert.equal(deckRootRes.status, 200);
    assert.match(deckRootRes.headers.get("content-type") ?? "", /text\/html/i);
    assert.match(deckRootRes.headers.get("cache-control") ?? "", /max-age=3600/i);
    assert.equal(await deckRootRes.text(), deckHtml);

    const deckCssRes = await fetch(`${tempBase}/deck/deck.css`);
    assert.equal(deckCssRes.status, 200);
    assert.match(deckCssRes.headers.get("content-type") ?? "", /text\/css/i);
    assert.equal(await deckCssRes.text(), ".slide { color: #fff; }");

    const deck404Res = await fetch(`${tempBase}/deck/nonexistent-asset.js`);
    assert.equal(deck404Res.status, 404);
    assert.match(deck404Res.headers.get("content-type") ?? "", /application\/json/i);
    assert.equal(((await deck404Res.json()) as Record<string, unknown>).code, "not_found");

    const traversalRes = await fetch(`${tempBase}/deck/%2e%2e/web/dist/index.html`);
    assert.equal(traversalRes.status, 404);
    assert.equal(((await traversalRes.json()) as Record<string, unknown>).code, "not_found");

    const missingHandoutRes = await fetch(`${tempBase}/judge-handout.html`);
    assert.equal(missingHandoutRes.status, 404);
    assert.match(missingHandoutRes.headers.get("content-type") ?? "", /application\/json/i);
    assert.equal(((await missingHandoutRes.json()) as Record<string, unknown>).code, "not_found");

    fs.writeFileSync(path.join(tmpDir, "docs", "judge-handout.html"), handoutHtml, "utf8");
    const presentHandoutRes = await fetch(`${tempBase}/judge-handout.html`);
    assert.equal(presentHandoutRes.status, 200);
    assert.match(presentHandoutRes.headers.get("content-type") ?? "", /text\/html/i);
    assert.equal(await presentHandoutRes.text(), handoutHtml);

    const hudRes = await fetch(`${tempBase}/hud`);
    assert.equal(hudRes.status, 200);
    assert.match(hudRes.headers.get("content-type") ?? "", /text\/html/i);
    assert.equal(await hudRes.text(), spaHtml);

    const unmatchedHtmlRes = await fetch(`${tempBase}/unknown-doc.html`);
    assert.equal(unmatchedHtmlRes.status, 404);
    assert.equal(((await unmatchedHtmlRes.json()) as Record<string, unknown>).code, "not_found");
  } finally {
    await closeHttpServer(tempServer);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
