import assert from "node:assert/strict";
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

type TempEnvMod = typeof import("../src/env.ts");
type TempGeminiMod = typeof import("../src/gemini.ts");
type TempIndexMod = typeof import("../src/index.ts");

type ManifestPayload = {
  model: string;
  generated: string;
  phrases: Record<string, Record<string, { file: string; text: string }>>;
};

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, "..", "..");
const SERVER_DIR = path.join(REPO_ROOT, "server");

const repoLedgerPath = path.join(REPO_ROOT, "server", "logs", "ledger.jsonl");
const repoDistPath = path.join(REPO_ROOT, "web", "dist");

const origQuiet = process.env.HOLDUP_QUIET;
const origGeminiKey = process.env.GEMINI_API_KEY;
const origElevenKey = process.env.ELEVENLABS_API_KEY;
const origLedgerPath = process.env.LEDGER_PATH;
const origHoldupKey = process.env.HOLDUP_KEY;
const origFetch = globalThis.fetch;
const origAppendFileSync = fs.appendFileSync.bind(fs);
const origWriteFileSync = fs.writeFileSync.bind(fs);
const origMkdirSync = fs.mkdirSync.bind(fs);
const origCopyFileSync = fs.copyFileSync.bind(fs);
const origRenameSync = fs.renameSync.bind(fs);

const BLINDFOLD_SECRET = "blindfold-secret";

const EXPECTED_LANGS = ["en", "fi", "sv"] as const;
const EXPECTED_PHRASE_IDS = [
  "offline",
  "back_online",
  "not_sure",
  "unknown_offline",
  "already_taken",
  "glasses_off",
  "camera_off",
  "cue_closer",
  "cue_further",
  "cue_rotate",
  "cue_tilt",
  "cue_more_light",
  "cue_steady",
  "cue_reading",
] as const;

const PHONE_INDEX_HTML = [
  "<!doctype html>",
  "<html lang=\"en\">",
  "<head>",
  "<meta charset=\"utf-8\" />",
  "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />",
  "<title>HoldUp Blindfold Phone SPA</title>",
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
  "<meta name=\"mrbd-web-app-capable\" content=\"yes\" />",
  "<title>HoldUp HUD</title>",
  "</head>",
  "<body class=\"hud-body\" data-entry=\"glasses-hud\"><div id=\"root\"></div></body>",
  "</html>",
  "",
].join("\n");

const PROBE_PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mPQqzX6DwADlwHdE7hLNwAAAABJRU5ErkJggg==",
  "base64",
);
const AMLODIPINE_JPG_PATH = path.join(REPO_ROOT, "server", "fixtures", "amlodipine.jpg");
const AMLODIPINE_JPG_BYTES = fs.readFileSync(AMLODIPINE_JPG_PATH);

const tmpRoot = fs.mkdtempSync(
  path.join(fs.existsSync("/dev/shm") ? "/dev/shm" : os.tmpdir(), "holdup-blindfold-prod-"),
);

const symlinkPaths: string[] = [];
let cleanedUp = false;
let server: http.Server | undefined;
let baseUrl = "";

let modelsGetCalls = 0;
let generateContentCalls = 0;
let loopbackFetchCalls = 0;
const externalFetchCalls: string[] = [];
const repoWriteTargets: string[] = [];

function checkNoRepoWrite(target: fs.PathOrFileDescriptor) {
  if (typeof target === "number") return;
  const asPath = target instanceof URL ? fileURLToPath(target) : Buffer.isBuffer(target) ? target.toString("utf8") : String(target);
  const resolved = path.resolve(asPath);
  if (resolved === REPO_ROOT || resolved.startsWith(`${REPO_ROOT}${path.sep}`)) {
    repoWriteTargets.push(resolved);
    throw new Error(`blocked repository write: ${resolved}`);
  }
}

let tempGemini: TempGeminiMod | undefined;
let origTempModelsGet: TempGeminiMod["ai"]["models"]["get"] | undefined;
let origTempGenerateContent: TempGeminiMod["ai"]["models"]["generateContent"] | undefined;

function findSharedNodeModules(): string | null {
  let cur = REPO_ROOT;
  for (;;) {
    const candidate = path.join(cur, "node_modules");
    if (fs.existsSync(candidate)) return fs.realpathSync(candidate);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  const fromEnv = (process.env.NODE_PATH ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0 && fs.existsSync(entry));
  return fromEnv ? fs.realpathSync(fromEnv) : null;
}

function linkDir(targetPath: string, linkPath: string) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(targetPath, linkPath, "dir");
  symlinkPaths.push(linkPath);
}

function cleanupTmpRoot() {
  if (cleanedUp) return;
  cleanedUp = true;
  for (const linkPath of symlinkPaths) {
    try {
      if (fs.lstatSync(linkPath).isSymbolicLink()) fs.unlinkSync(linkPath);
    } catch {}
  }
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
}

process.once("exit", cleanupTmpRoot);

function restoreEnvVar(name: string, prev: string | undefined) {
  if (prev === undefined) delete process.env[name];
  else process.env[name] = prev;
}

function restoreHoldupKey() {
  restoreEnvVar("HOLDUP_KEY", origHoldupKey);
}

function extractFetchUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function assertSecurityHeaders(res: Response, label = "response") {
  assert.equal(res.headers.has("x-powered-by"), false, label);
  assert.equal(res.headers.get("x-powered-by"), null, label);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff", label);
  assert.equal(res.headers.get("referrer-policy"), "no-referrer", label);
  assert.equal(res.headers.get("x-frame-options"), "SAMEORIGIN", label);
}

async function assertNotFoundJson(res: Response, label = "not_found") {
  assert.equal(res.status, 404, label);
  assertSecurityHeaders(res, label);
  assert.match(res.headers.get("content-type") ?? "", /^application\/json\b/i, label);
  const body = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(
    body,
    {
      type: "error",
      code: "not_found",
      message: "not found",
      recoverable: false,
    },
    label,
  );
}

before(async () => {
  process.env.HOLDUP_QUIET = "1";
  process.env.GEMINI_API_KEY = "";
  process.env.ELEVENLABS_API_KEY = "";
  process.env.LEDGER_PATH = path.join(tmpRoot, "ledger.jsonl");
  delete process.env.HOLDUP_KEY;

  const rootNodeModules = findSharedNodeModules();
  assert.ok(rootNodeModules, "node_modules must be resolvable for isolated server copy");
  linkDir(rootNodeModules, path.join(tmpRoot, "node_modules"));

  const serverNodeModules = path.join(SERVER_DIR, "node_modules");
  if (fs.existsSync(serverNodeModules)) {
    linkDir(fs.realpathSync(serverNodeModules), path.join(tmpRoot, "server", "node_modules"));
  }

  fs.cpSync(path.join(REPO_ROOT, "server", "src"), path.join(tmpRoot, "server", "src"), { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, "shared"), path.join(tmpRoot, "shared"), { recursive: true });

  const distDir = path.join(tmpRoot, "web", "dist");
  const hudDir = path.join(distDir, "hud");
  const spritesDir = path.join(distDir, "blindfold", "sprites");
  const labelsDir = path.join(distDir, "blindfold", "labels");
  fs.mkdirSync(hudDir, { recursive: true });
  fs.mkdirSync(spritesDir, { recursive: true });
  fs.mkdirSync(labelsDir, { recursive: true });

  fs.writeFileSync(path.join(distDir, "index.html"), PHONE_INDEX_HTML, "utf8");
  fs.writeFileSync(path.join(hudDir, "index.html"), HUD_INDEX_HTML, "utf8");
  linkDir(path.join(REPO_ROOT, "web", "public", "phrases"), path.join(distDir, "phrases"));
  fs.writeFileSync(path.join(spritesDir, "probe.png"), PROBE_PNG_BYTES);
  fs.copyFileSync(AMLODIPINE_JPG_PATH, path.join(labelsDir, "round1.jpg"));

  fs.appendFileSync = ((file: fs.PathOrFileDescriptor, data: string | Uint8Array, options?: fs.WriteFileOptions) => {
    checkNoRepoWrite(file);
    return origAppendFileSync(file, data, options);
  }) as typeof fs.appendFileSync;
  fs.writeFileSync = ((file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
    checkNoRepoWrite(file);
    return origWriteFileSync(file, data, options);
  }) as typeof fs.writeFileSync;
  fs.mkdirSync = ((dirPath: fs.PathLike, options?: fs.MakeDirectoryOptions | fs.Mode | null) => {
    checkNoRepoWrite(dirPath);
    return origMkdirSync(dirPath, options as fs.MakeDirectoryOptions | undefined);
  }) as typeof fs.mkdirSync;
  fs.copyFileSync = ((src: fs.PathLike, dest: fs.PathLike, mode?: number) => {
    checkNoRepoWrite(dest);
    return origCopyFileSync(src, dest, mode);
  }) as typeof fs.copyFileSync;
  fs.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
    checkNoRepoWrite(oldPath);
    checkNoRepoWrite(newPath);
    return origRenameSync(oldPath, newPath);
  }) as typeof fs.renameSync;

  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const rawUrl = extractFetchUrl(input);
    const parsed = new URL(rawUrl);
    if (parsed.hostname !== "127.0.0.1") {
      externalFetchCalls.push(rawUrl);
      throw new Error(`blocked external fetch: ${rawUrl}`);
    }
    loopbackFetchCalls += 1;
    return origFetch(input, init);
  }) as typeof fetch;

  const tempEnv = (await import(pathToFileURL(path.join(tmpRoot, "server", "src", "env.ts")).href)) as TempEnvMod;
  assert.equal(fs.realpathSync(tempEnv.REPO_ROOT), fs.realpathSync(tmpRoot));
  assert.equal(tempEnv.env.apiKey, "");
  assert.equal(tempEnv.env.elevenlabs, false);
  assert.equal(tempEnv.env.ledgerPath, path.join(tmpRoot, "ledger.jsonl"));

  tempGemini = (await import(pathToFileURL(path.join(tmpRoot, "server", "src", "gemini.ts")).href)) as TempGeminiMod;
  origTempModelsGet = tempGemini.ai.models.get;
  origTempGenerateContent = tempGemini.ai.models.generateContent;
  tempGemini.ai.models.get = (async () => {
    modelsGetCalls += 1;
    throw new Error("unexpected ai.models.get call");
  }) as typeof tempGemini.ai.models.get;
  tempGemini.ai.models.generateContent = (async () => {
    generateContentCalls += 1;
    throw new Error("unexpected ai.models.generateContent call");
  }) as typeof tempGemini.ai.models.generateContent;

  const tempIndex = (await import(pathToFileURL(path.join(tmpRoot, "server", "src", "index.ts")).href)) as TempIndexMod;
  server = await tempIndex.startServer(0);
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("unexpected server address");
  baseUrl = ["http:", "", `127.0.0.1:${addr.port}`].join("/");
});

afterEach(() => {
  delete process.env.HOLDUP_KEY;
});

after(async () => {
  try {
    globalThis.fetch = origFetch;
    fs.appendFileSync = origAppendFileSync;
    fs.writeFileSync = origWriteFileSync;
    fs.mkdirSync = origMkdirSync;
    fs.copyFileSync = origCopyFileSync;
    fs.renameSync = origRenameSync;
    if (tempGemini && origTempModelsGet) tempGemini.ai.models.get = origTempModelsGet;
    if (tempGemini && origTempGenerateContent) tempGemini.ai.models.generateContent = origTempGenerateContent;
    restoreHoldupKey();
    restoreEnvVar("HOLDUP_QUIET", origQuiet);
    restoreEnvVar("GEMINI_API_KEY", origGeminiKey);
    restoreEnvVar("ELEVENLABS_API_KEY", origElevenKey);
    restoreEnvVar("LEDGER_PATH", origLedgerPath);
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
  } finally {
    cleanupTmpRoot();
  }
});

test("GET /blindfold, GET /blindfold/, GET /blindfold?lang=fi, and HEAD /blindfold/ serve phone SPA index.html with no-cache and security headers when HOLDUP_KEY is unset", async () => {
  const manualRes = await fetch(`${baseUrl}/blindfold`, { redirect: "manual" });
  assertSecurityHeaders(manualRes, "manual GET /blindfold");
  assert.ok(
    manualRes.status === 301 || manualRes.status === 200,
    `expected 301 or 200 for manual GET /blindfold, got ${manualRes.status}`,
  );
  if (manualRes.status === 301) {
    const loc = manualRes.headers.get("location") ?? "";
    assert.ok(loc === "/blindfold/" || loc.endsWith("/blindfold/"), `unexpected redirect location: ${loc}`);
  }

  for (const route of ["/blindfold", "/blindfold/", "/blindfold?lang=fi"]) {
    const res = await fetch(`${baseUrl}${route}`);
    assert.equal(res.status, 200, `GET ${route}`);
    assertSecurityHeaders(res, `GET ${route}`);
    assert.match(res.headers.get("content-type") ?? "", /^text\/html\b/i, `Content-Type on GET ${route}`);
    assert.equal(res.headers.get("cache-control"), "no-cache", `Cache-Control on GET ${route}`);
    const html = await res.text();
    assert.equal(html, PHONE_INDEX_HTML, `phone SPA HTML on GET ${route}`);
    assert.equal(html.includes("<div id=\"root\"></div>"), true);
    assert.equal(html.includes("hud-body"), false);
    assert.notEqual(html, HUD_INDEX_HTML);
  }

  const headRes = await fetch(`${baseUrl}/blindfold/`, { method: "HEAD" });
  assert.equal(headRes.status, 200, "HEAD /blindfold/");
  assertSecurityHeaders(headRes, "HEAD /blindfold/");
  assert.match(headRes.headers.get("content-type") ?? "", /^text\/html\b/i, "Content-Type on HEAD /blindfold/");
  assert.equal(headRes.headers.get("cache-control"), "no-cache", "Cache-Control on HEAD /blindfold/");
  assert.equal(await headRes.text(), "");

  const hudRes = await fetch(`${baseUrl}/hud/`);
  assert.equal(hudRes.status, 200);
  assertSecurityHeaders(hudRes, "GET /hud/");
  assert.equal(await hudRes.text(), HUD_INDEX_HTML);
});

test("/blindfold routes stay 100% public under HOLDUP_KEY while GET /api/stats without key returns 401", async () => {
  process.env.HOLDUP_KEY = BLINDFOLD_SECRET;

  const unauthStats = await fetch(`${baseUrl}/api/stats`);
  assert.equal(unauthStats.status, 401);
  assertSecurityHeaders(unauthStats, "unauthenticated GET /api/stats");
  assert.match(unauthStats.headers.get("content-type") ?? "", /^application\/json\b/i);
  assert.deepEqual(await unauthStats.json(), {
    type: "error",
    code: "unauthorized",
    message: "access key required",
    recoverable: false,
  });

  const wrongStats = await fetch(`${baseUrl}/api/stats?key=wrong-key`, {
    headers: { "x-holdup-key": "wrong-header-key" },
  });
  assert.equal(wrongStats.status, 401);
  assertSecurityHeaders(wrongStats, "wrong-key GET /api/stats");

  for (const route of ["/blindfold", "/blindfold/", "/blindfold?lang=fi"]) {
    const noKeyRes = await fetch(`${baseUrl}${route}`);
    assert.equal(noKeyRes.status, 200, `no-key GET ${route}`);
    assertSecurityHeaders(noKeyRes, `no-key GET ${route}`);
    assert.match(noKeyRes.headers.get("content-type") ?? "", /^text\/html\b/i);
    assert.equal(noKeyRes.headers.get("cache-control"), "no-cache");
    assert.equal(await noKeyRes.text(), PHONE_INDEX_HTML);

    const sep = route.includes("?") ? "&" : "?";
    const wrongQueryRes = await fetch(`${baseUrl}${route}${sep}key=wrong-key`);
    assert.equal(wrongQueryRes.status, 200, `wrong ?key GET ${route}`);
    assertSecurityHeaders(wrongQueryRes, `wrong ?key GET ${route}`);
    assert.match(wrongQueryRes.headers.get("content-type") ?? "", /^text\/html\b/i);
    assert.equal(wrongQueryRes.headers.get("cache-control"), "no-cache");
    assert.equal(await wrongQueryRes.text(), PHONE_INDEX_HTML);

    const wrongHeaderRes = await fetch(`${baseUrl}${route}`, {
      headers: { "x-holdup-key": "wrong-header-key" },
    });
    assert.equal(wrongHeaderRes.status, 200, `wrong x-holdup-key GET ${route}`);
    assertSecurityHeaders(wrongHeaderRes, `wrong x-holdup-key GET ${route}`);
    assert.match(wrongHeaderRes.headers.get("content-type") ?? "", /^text\/html\b/i);
    assert.equal(wrongHeaderRes.headers.get("cache-control"), "no-cache");
    assert.equal(await wrongHeaderRes.text(), PHONE_INDEX_HTML);
  }

  for (const [label, url, headers] of [
    ["no-key HEAD", `${baseUrl}/blindfold/`, undefined],
    ["wrong ?key HEAD", `${baseUrl}/blindfold/?key=wrong-key`, undefined],
    ["wrong header HEAD", `${baseUrl}/blindfold/`, { "x-holdup-key": "wrong-header-key" }],
  ] as const) {
    const headRes = await fetch(url, { method: "HEAD", headers });
    assert.equal(headRes.status, 200, label);
    assertSecurityHeaders(headRes, label);
    assert.match(headRes.headers.get("content-type") ?? "", /^text\/html\b/i, label);
    assert.equal(headRes.headers.get("cache-control"), "no-cache", label);
    assert.equal(await headRes.text(), "", label);
  }
});

test("GET /phrases/manifest.json returns 200 JSON with Cache-Control: no-cache publicly with and without HOLDUP_KEY for 3 languages x 14 IDs = 42 entries", async () => {
  const openRes = await fetch(`${baseUrl}/phrases/manifest.json`);
  assert.equal(openRes.status, 200);
  assertSecurityHeaders(openRes, "open GET /phrases/manifest.json");
  assert.match(openRes.headers.get("content-type") ?? "", /^application\/json\b/i);
  assert.equal(openRes.headers.get("cache-control"), "no-cache");
  const manifest = (await openRes.json()) as ManifestPayload;

  assert.deepEqual(Object.keys(manifest.phrases).sort(), [...EXPECTED_LANGS]);
  let entryCount = 0;
  for (const lang of EXPECTED_LANGS) {
    const langMap = manifest.phrases[lang];
    assert.ok(langMap, `missing language ${lang}`);
    assert.deepEqual(Object.keys(langMap).sort(), [...EXPECTED_PHRASE_IDS].sort());
    for (const id of EXPECTED_PHRASE_IDS) {
      const entry = langMap[id];
      assert.ok(entry, `missing ${lang}/${id}`);
      assert.equal(typeof entry.text, "string");
      assert.ok(entry.text.length > 0);
      assert.match(entry.file, new RegExp(`^/phrases/${lang}/${id}\\.(mp3|wav)$`));
      entryCount += 1;
    }
  }
  assert.equal(entryCount, 42);

  const headRes = await fetch(`${baseUrl}/phrases/manifest.json`, { method: "HEAD" });
  assert.equal(headRes.status, 200);
  assertSecurityHeaders(headRes, "HEAD /phrases/manifest.json");
  assert.match(headRes.headers.get("content-type") ?? "", /^application\/json\b/i);
  assert.equal(headRes.headers.get("cache-control"), "no-cache");
  assert.equal(await headRes.text(), "");

  process.env.HOLDUP_KEY = BLINDFOLD_SECRET;
  for (const [label, url, headers] of [
    ["no-key manifest", `${baseUrl}/phrases/manifest.json`, undefined],
    ["wrong ?key manifest", `${baseUrl}/phrases/manifest.json?key=wrong`, undefined],
    ["wrong header manifest", `${baseUrl}/phrases/manifest.json`, { "x-holdup-key": "wrong" }],
  ] as const) {
    const keyedRes = await fetch(url, { headers });
    assert.equal(keyedRes.status, 200, label);
    assertSecurityHeaders(keyedRes, label);
    assert.match(keyedRes.headers.get("content-type") ?? "", /^application\/json\b/i, label);
    assert.equal(keyedRes.headers.get("cache-control"), "no-cache", label);
    assert.deepEqual(await keyedRes.json(), manifest, label);
  }
});

test("All 42 /phrases/{en,fi,sv} audio clips serve 200 publicly with and without HOLDUP_KEY, audio Content-Type, max-age=3600, security headers, >1024 bytes, and valid RIFF/WAVE or ID3/MPEG headers", async () => {
  const manifestRes = await fetch(`${baseUrl}/phrases/manifest.json`);
  assert.equal(manifestRes.status, 200);
  const manifest = (await manifestRes.json()) as ManifestPayload;

  const clipUrls: string[] = [];
  for (const lang of EXPECTED_LANGS) {
    for (const id of EXPECTED_PHRASE_IDS) {
      clipUrls.push(manifest.phrases[lang][id].file);
    }
  }
  assert.equal(clipUrls.length, 42);

  async function verifyAllClips(modeLabel: string) {
    for (const clipUrl of clipUrls) {
      const res = await fetch(`${baseUrl}${clipUrl}`);
      const tag = `${modeLabel} ${clipUrl}`;
      assert.equal(res.status, 200, tag);
      assertSecurityHeaders(res, tag);
      const cc = res.headers.get("cache-control") ?? "";
      assert.match(cc, /\bmax-age=3600\b/, tag);
      assert.equal(cc.includes("no-cache"), false, tag);
      const ct = res.headers.get("content-type") ?? "";
      const buf = Buffer.from(await res.arrayBuffer());
      assert.ok(buf.length > 1024, `expected >1024 bytes for ${tag}, got ${buf.length}`);
      if (clipUrl.endsWith(".wav")) {
        assert.match(ct, /^audio\/(wav|wave|x-wav)\b/i, tag);
        assert.equal(buf.subarray(0, 4).toString("ascii"), "RIFF", tag);
        assert.equal(buf.subarray(8, 12).toString("ascii"), "WAVE", tag);
      } else {
        assert.equal(clipUrl.endsWith(".mp3"), true, tag);
        assert.match(ct, /^audio\/mpeg\b/i, tag);
        const hasId3 = buf.subarray(0, 3).toString("ascii") === "ID3";
        const hasMpegSync = buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0;
        assert.equal(hasId3 || hasMpegSync, true, `invalid MP3 header on ${tag}`);
      }
    }
  }

  await verifyAllClips("open");

  process.env.HOLDUP_KEY = BLINDFOLD_SECRET;
  const statsCheck = await fetch(`${baseUrl}/api/stats`);
  assert.equal(statsCheck.status, 401);

  await verifyAllClips("keyed-no-token");

  const wrongKeyClip = await fetch(`${baseUrl}${clipUrls[0]}?key=wrong-key`, {
    headers: { "x-holdup-key": "wrong-header" },
  });
  assert.equal(wrongKeyClip.status, 200);
  assertSecurityHeaders(wrongKeyClip, "wrong-key clip");
  assert.match(wrongKeyClip.headers.get("cache-control") ?? "", /\bmax-age=3600\b/);
});

test("Static sub-assets /blindfold/sprites/probe.png and /blindfold/labels/round1.jpg serve 200 publicly with max-age=3600 without shadowing SPA fallback on /blindfold/", async () => {
  async function assertStaticAndSpaCoexistence(headers?: Record<string, string>, querySuffix = "") {
    const pngRes = await fetch(`${baseUrl}/blindfold/sprites/probe.png${querySuffix}`, { headers });
    assert.equal(pngRes.status, 200);
    assertSecurityHeaders(pngRes, "GET /blindfold/sprites/probe.png");
    assert.match(pngRes.headers.get("content-type") ?? "", /^image\/png\b/i);
    const pngCc = pngRes.headers.get("cache-control") ?? "";
    assert.match(pngCc, /\bmax-age=3600\b/);
    assert.equal(pngCc.includes("no-cache"), false);
    const pngBuf = Buffer.from(await pngRes.arrayBuffer());
    assert.deepEqual(pngBuf, PROBE_PNG_BYTES);
    assert.deepEqual(pngBuf.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    const jpgRes = await fetch(`${baseUrl}/blindfold/labels/round1.jpg${querySuffix}`, { headers });
    assert.equal(jpgRes.status, 200);
    assertSecurityHeaders(jpgRes, "GET /blindfold/labels/round1.jpg");
    assert.match(jpgRes.headers.get("content-type") ?? "", /^image\/jpeg\b/i);
    const jpgCc = jpgRes.headers.get("cache-control") ?? "";
    assert.match(jpgCc, /\bmax-age=3600\b/);
    assert.equal(jpgCc.includes("no-cache"), false);
    const jpgBuf = Buffer.from(await jpgRes.arrayBuffer());
    assert.equal(jpgBuf.length, AMLODIPINE_JPG_BYTES.length);
    assert.equal(jpgBuf[0], 0xff);
    assert.equal(jpgBuf[1], 0xd8);
    assert.deepEqual(jpgBuf, AMLODIPINE_JPG_BYTES);

    for (const spaRoute of ["/blindfold", "/blindfold/", "/blindfold/round/1"]) {
      const spaRes = await fetch(`${baseUrl}${spaRoute}${querySuffix}`, { headers });
      assert.equal(spaRes.status, 200, `SPA coexistence ${spaRoute}`);
      assertSecurityHeaders(spaRes, `SPA coexistence ${spaRoute}`);
      assert.match(spaRes.headers.get("content-type") ?? "", /^text\/html\b/i);
      assert.equal(spaRes.headers.get("cache-control"), "no-cache");
      assert.equal(await spaRes.text(), PHONE_INDEX_HTML);
    }
  }

  await assertStaticAndSpaCoexistence();

  process.env.HOLDUP_KEY = BLINDFOLD_SECRET;
  await assertStaticAndSpaCoexistence();
  await assertStaticAndSpaCoexistence({ "x-holdup-key": "wrong-key" }, "?key=wrong-key");
});

test("Non-GET methods (POST /blindfold, DELETE /blindfold/) and reserved API paths (GET /api/blindfold) return 404 JSON not_found and never SPA HTML", async () => {
  for (const [method, route] of [
    ["POST", "/blindfold"],
    ["POST", "/blindfold/"],
    ["DELETE", "/blindfold/"],
    ["PUT", "/blindfold"],
    ["PATCH", "/blindfold/"],
  ] as const) {
    const res = await fetch(`${baseUrl}${route}`, { method });
    await assertNotFoundJson(res, `${method} ${route}`);
  }

  const openApiBlindfold = await fetch(`${baseUrl}/api/blindfold`);
  await assertNotFoundJson(openApiBlindfold, "open GET /api/blindfold");

  process.env.HOLDUP_KEY = BLINDFOLD_SECRET;

  const unauthApiBlindfold = await fetch(`${baseUrl}/api/blindfold`);
  assert.equal(unauthApiBlindfold.status, 401);
  assertSecurityHeaders(unauthApiBlindfold, "unauth GET /api/blindfold");
  assert.match(unauthApiBlindfold.headers.get("content-type") ?? "", /^application\/json\b/i);
  assert.deepEqual(await unauthApiBlindfold.json(), {
    type: "error",
    code: "unauthorized",
    message: "access key required",
    recoverable: false,
  });

  const authedQueryApiBlindfold = await fetch(`${baseUrl}/api/blindfold?key=${BLINDFOLD_SECRET}`);
  await assertNotFoundJson(authedQueryApiBlindfold, "authed ?key GET /api/blindfold");

  const authedHeaderApiBlindfold = await fetch(`${baseUrl}/api/blindfold`, {
    headers: { "x-holdup-key": BLINDFOLD_SECRET },
  });
  await assertNotFoundJson(authedHeaderApiBlindfold, "authed header GET /api/blindfold");

  for (const [method, route] of [
    ["POST", "/blindfold"],
    ["DELETE", "/blindfold/"],
  ] as const) {
    const keyedMethodRes = await fetch(`${baseUrl}${route}`, { method });
    await assertNotFoundJson(keyedMethodRes, `keyed ${method} ${route}`);
  }
});

test("Zero calls to ai.models.get, ai.models.generateContent, or external fetch, and workspace server/logs/ledger.jsonl is untouched", () => {
  assert.equal(modelsGetCalls, 0);
  assert.equal(generateContentCalls, 0);
  assert.deepEqual(externalFetchCalls, []);
  assert.ok(loopbackFetchCalls > 0);
  assert.equal(fs.existsSync(path.join(tmpRoot, "ledger.jsonl")), false);
  assert.equal(fs.existsSync(path.join(tmpRoot, "server", "logs", "ledger.jsonl")), false);
  assert.equal(repoWriteTargets.includes(repoLedgerPath), false);
  assert.equal(
    repoWriteTargets.some((target) => target === repoDistPath || target.startsWith(`${repoDistPath}${path.sep}`)),
    false,
  );
  assert.deepEqual(repoWriteTargets, []);
});
