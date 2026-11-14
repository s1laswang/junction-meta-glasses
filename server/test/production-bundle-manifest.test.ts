import assert from "node:assert/strict";
import fs from "node:fs";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { env, REPO_ROOT } from "../src/env.ts";
import { startServer } from "../src/index.ts";

process.env.HOLDUP_QUIET = "1";

const SLASH = String.fromCharCode(47);
const STAR = String.fromCharCode(42);
const HASH = String.fromCharCode(35);
const DOUBLE_SLASH = SLASH + SLASH;
const DOUBLE_STAR = STAR + STAR;
const BLOCK_OPEN = SLASH + STAR;
const BLOCK_CLOSE = STAR + SLASH;
const HTML_COMMENT_OPEN = "<" + "!--";
const EM_DASH = String.fromCharCode(0x2014);
const CO_AUTHORED_RE = new RegExp(["Co", "Authored", "By"].join("-"), "i");
const API_KEY_RE = new RegExp("AIza" + "[0-9A-Za-z_-]{20,}");
const SW_ORIGIN = `https:${DOUBLE_SLASH}holdup.example`;

interface ManifestIcon {
  src?: unknown;
  sizes?: unknown;
  type?: unknown;
  purpose?: unknown;
}

interface ManifestShortcut {
  name?: unknown;
  short_name?: unknown;
  description?: unknown;
  url?: unknown;
  icons?: unknown;
}

interface WebManifestDoc {
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

interface MockSwRequest {
  url: string;
  method: string;
  mode: string;
  destination: string;
  headers: {
    get(name: string): string | null;
  };
}

interface SwBindings {
  cacheName: string | null;
  shellAssets: string[] | null;
  isNeverCachedPath: ((pathname: string) => boolean) | null;
  isNavigationRequest: ((request: MockSwRequest, pathname: string) => boolean) | null;
  isCacheableStaticAsset: ((pathname: string) => boolean) | null;
}

interface CssRule {
  media: string | null;
  selectors: string[];
  declarations: Record<string, string>;
}

interface DockerfileStage {
  name: string;
  lines: string[];
}

function makeSwRequest(
  pathOrUrl: string,
  opts?: {
    method?: string;
    mode?: string;
    destination?: string;
    accept?: string;
  },
): MockSwRequest {
  const fullUrl = pathOrUrl.includes(`:${DOUBLE_SLASH}`)
    ? pathOrUrl
    : new URL(pathOrUrl, SW_ORIGIN).href;
  const headerMap = new Map<string, string>();
  if (opts?.accept) {
    headerMap.set("accept", opts.accept);
  }
  return {
    url: fullUrl,
    method: opts?.method ?? "GET",
    mode: opts?.mode ?? "cors",
    destination: opts?.destination ?? "",
    headers: {
      get(name: string): string | null {
        return headerMap.get(name.toLowerCase()) ?? null;
      },
    },
  };
}

function normalizeCacheKey(query: string | MockSwRequest): string {
  return typeof query === "string"
    ? new URL(query, SW_ORIGIN).href
    : new URL(query.url, SW_ORIGIN).href;
}

function createServiceWorkerSandbox(
  swSource: string,
  opts?: { onNetworkFetch?: (req: MockSwRequest) => Promise<Response> },
) {
  const listeners: Record<string, (event: Record<string, unknown>) => void> = {};
  const buckets = new Map<string, Map<string, Response>>();
  const cacheTouches: string[] = [];
  const networkCalls: string[] = [];
  const addAllBatches: Array<{ cacheName: string; urls: string[] }> = [];
  let skipWaitingCount = 0;
  let claimCount = 0;

  const ensureBucket = (name: string): Map<string, Response> => {
    let bucket = buckets.get(name);
    if (!bucket) {
      bucket = new Map<string, Response>();
      buckets.set(name, bucket);
    }
    return bucket;
  };

  const fetchMock = async (input: string | MockSwRequest): Promise<Response> => {
    const req = typeof input === "string" ? makeSwRequest(input) : input;
    networkCalls.push(req.url);
    if (opts?.onNetworkFetch) {
      return opts.onNetworkFetch(req);
    }
    const parsed = new URL(req.url);
    if (
      parsed.pathname === "/" ||
      parsed.pathname === "/index.html" ||
      parsed.pathname === "/hud" ||
      parsed.pathname === "/hud/"
    ) {
      return new Response("<!doctype html><html><body>HoldUp Shell</body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    if (parsed.pathname.endsWith(".webmanifest") || parsed.pathname.endsWith(".json")) {
      return new Response('{"short_name":"HoldUp"}', {
        status: 200,
        headers: { "Content-Type": "application/manifest+json" },
      });
    }
    if (parsed.pathname.endsWith(".svg")) {
      return new Response(`<svg xmlns="http:${DOUBLE_SLASH}www.w3.org/2000/svg" viewBox="0 0 512 512"></svg>`, {
        status: 200,
        headers: { "Content-Type": "image/svg+xml" },
      });
    }
    return new Response(`asset:${parsed.pathname}`, {
      status: 200,
      headers: { "Content-Type": "application/javascript" },
    });
  };

  const rawCaches = {
    async open(cacheName: string) {
      const bucket = ensureBucket(cacheName);
      return {
        async addAll(urls: string[]): Promise<void> {
          const copied = Array.from(urls);
          addAllBatches.push({ cacheName, urls: copied });
          cacheTouches.push(`addAll:${cacheName}`);
          for (const u of copied) {
            const res = await fetchMock(u);
            bucket.set(normalizeCacheKey(u), res.clone());
          }
        },
        async match(query: string | MockSwRequest): Promise<Response | undefined> {
          const key = normalizeCacheKey(query);
          cacheTouches.push(`match:${cacheName}:${key}`);
          const hit = bucket.get(key);
          return hit ? hit.clone() : undefined;
        },
        async put(query: string | MockSwRequest, response: Response): Promise<void> {
          const key = normalizeCacheKey(query);
          cacheTouches.push(`put:${cacheName}:${key}`);
          bucket.set(key, response.clone());
        },
      };
    },
    async keys(): Promise<string[]> {
      return [...buckets.keys()];
    },
    async delete(cacheName: string): Promise<boolean> {
      return buckets.delete(cacheName);
    },
  };

  const cachesProxy = new Proxy(rawCaches, {
    get(target, prop, receiver) {
      cacheTouches.push(`caches.${String(prop)}`);
      return Reflect.get(target, prop, receiver);
    },
  });

  const selfMock = {
    location: { origin: SW_ORIGIN },
    async skipWaiting() {
      skipWaitingCount += 1;
    },
    clients: {
      async claim() {
        claimCount += 1;
      },
    },
    addEventListener(type: string, handler: (event: Record<string, unknown>) => void) {
      listeners[type] = handler;
    },
  };

  const context = vm.createContext({
    self: selfMock,
    caches: cachesProxy,
    fetch: fetchMock,
    URL,
    Response,
    Headers,
    Promise,
  });

  vm.runInContext(swSource, context);
  const rawBindings = vm.runInContext(
    `({
      cacheName: typeof CACHE_NAME !== "undefined" ? CACHE_NAME : null,
      shellAssets: typeof SHELL_ASSETS !== "undefined" ? SHELL_ASSETS : (typeof APP_SHELL !== "undefined" ? APP_SHELL : null),
      isNeverCachedPath: typeof isNeverCachedPath === "function" ? isNeverCachedPath : null,
      isNavigationRequest: typeof isNavigationRequest === "function" ? isNavigationRequest : null,
      isCacheableStaticAsset: typeof isCacheableStaticAsset === "function" ? isCacheableStaticAsset : null
    })`,
    context,
  ) as SwBindings;

  const bindings: SwBindings = {
    cacheName: rawBindings.cacheName,
    shellAssets: rawBindings.shellAssets
      ? Array.from(rawBindings.shellAssets, (item) => String(item))
      : null,
    isNeverCachedPath: rawBindings.isNeverCachedPath,
    isNavigationRequest: rawBindings.isNavigationRequest,
    isCacheableStaticAsset: rawBindings.isCacheableStaticAsset,
  };

  async function dispatchLifecycle(type: "install" | "activate"): Promise<void> {
    const fn = listeners[type];
    assert.ok(fn, `Expected Service Worker ${type} listener`);
    const pending: Promise<unknown>[] = [];
    fn({
      waitUntil(p: Promise<unknown>) {
        pending.push(p);
      },
    });
    await Promise.all(pending);
  }

  async function dispatchFetch(request: MockSwRequest): Promise<{
    intercepted: boolean;
    response: Response | null;
  }> {
    const fn = listeners.fetch;
    assert.ok(fn, "Expected Service Worker fetch listener");
    const pending: Promise<unknown>[] = [];
    let responded: Promise<Response> | null = null;
    fn({
      request,
      waitUntil(p: Promise<unknown>) {
        pending.push(p);
      },
      respondWith(r: Promise<Response> | Response) {
        responded = Promise.resolve(r);
      },
    });
    if (!responded) {
      await Promise.all(pending);
      return { intercepted: false, response: null };
    }
    const response = await (responded as Promise<Response>);
    await Promise.all(pending);
    return { intercepted: true, response };
  }

  return {
    bindings,
    buckets,
    ensureBucket,
    cacheTouches,
    networkCalls,
    addAllBatches,
    getSkipWaitingCount: () => skipWaitingCount,
    getClaimCount: () => claimCount,
    resetTelemetry() {
      cacheTouches.length = 0;
      networkCalls.length = 0;
    },
    dispatchLifecycle,
    dispatchFetch,
  };
}

function splitCssSelectors(prelude: string): string[] {
  const out: string[] = [];
  let start = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let quote: string | null = null;

  for (let i = 0; i < prelude.length; i++) {
    const ch = prelude[i];
    if (quote) {
      if (ch === quote && prelude[i - 1] !== "\\") {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "(") {
      parenDepth += 1;
    } else if (ch === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
    } else if (ch === "[") {
      bracketDepth += 1;
    } else if (ch === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
    } else if (ch === "," && parenDepth === 0 && bracketDepth === 0) {
      const s = prelude.slice(start, i).trim();
      if (s) out.push(s);
      start = i + 1;
    }
  }
  const rest = prelude.slice(start).trim();
  if (rest) out.push(rest);
  return out;
}

function parseCssRules(cssSource: string, media: string | null = null): CssRule[] {
  const rules: CssRule[] = [];
  let cursor = 0;
  const n = cssSource.length;

  while (cursor < n) {
    while (cursor < n && /\s/.test(cssSource[cursor])) cursor += 1;
    if (cursor >= n) break;

    const openBrace = cssSource.indexOf("{", cursor);
    const semi = cssSource.indexOf(";", cursor);
    if (semi !== -1 && (openBrace === -1 || semi < openBrace)) {
      cursor = semi + 1;
      continue;
    }
    if (openBrace === -1) break;

    const prelude = cssSource.slice(cursor, openBrace).trim();
    let depth = 1;
    let scan = openBrace + 1;
    while (scan < n && depth > 0) {
      if (cssSource[scan] === "{") depth += 1;
      else if (cssSource[scan] === "}") depth -= 1;
      scan += 1;
    }

    const inner = cssSource.slice(openBrace + 1, scan - 1);
    if (prelude.toLowerCase().startsWith("@media")) {
      rules.push(...parseCssRules(inner, prelude));
    } else if (!prelude.startsWith("@") && prelude.length > 0) {
      const declarations: Record<string, string> = {};
      for (const part of inner.split(";")) {
        const colon = part.indexOf(":");
        if (colon === -1) continue;
        const prop = part.slice(0, colon).trim();
        const val = part.slice(colon + 1).trim();
        if (prop && val) declarations[prop] = val;
      }
      rules.push({
        media,
        selectors: splitCssSelectors(prelude),
        declarations,
      });
    }
    cursor = scan;
  }

  return rules;
}

function getSelectorDeclarations(
  rules: CssRule[],
  selector: string,
  media: string | null = null,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const rule of rules) {
    if (rule.media === media && rule.selectors.includes(selector)) {
      Object.assign(merged, rule.declarations);
    }
  }
  return merged;
}

function parseDockerfileStages(source: string): DockerfileStage[] {
  const stages: DockerfileStage[] = [];
  let current: DockerfileStage | null = null;

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(HASH)) continue;
    const fromMatch = /^FROM\s+\S+\s+AS\s+([A-Za-z0-9_-]+)$/.exec(line);
    if (fromMatch) {
      current = { name: fromMatch[1], lines: [] };
      stages.push(current);
      continue;
    }
    if (current) {
      current.lines.push(line);
    }
  }

  return stages;
}

function compileDockerignorePattern(rawPattern: string): RegExp {
  const clean = rawPattern.replace(/^\/+|\/+$/g, "");
  const segments = clean.split(SLASH).filter((s) => s.length > 0);
  let expr = "^";

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === DOUBLE_STAR) {
      if (i === 0 && segments.length > 1) {
        expr += `(?:.+${SLASH})?`;
      } else if (i === segments.length - 1) {
        expr += `(?:${SLASH}.+)?`;
      } else {
        expr += `(?:${SLASH}.+)?${SLASH}`;
      }
      continue;
    }
    if (i > 0 && segments[i - 1] !== DOUBLE_STAR) {
      expr += SLASH;
    }
    for (const ch of seg) {
      if (ch === STAR) {
        expr += `[^${SLASH}]{0,}`;
      } else if (ch === "?") {
        expr += `[^${SLASH}]`;
      } else if ("\\^$.|+()[]{}".includes(ch)) {
        expr += `\\${ch}`;
      } else {
        expr += ch;
      }
    }
  }

  expr += `(?:${SLASH}.+)?$`;
  return new RegExp(expr);
}

function createDockerignoreMatcher(dockerignoreSource: string) {
  const compiledRules: Array<{ raw: string; negated: boolean; regex: RegExp }> = [];

  for (const rawLine of dockerignoreSource.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith(HASH)) continue;
    const negated = trimmed.startsWith("!");
    const patternBody = (negated ? trimmed.slice(1) : trimmed).trim();
    if (!patternBody) continue;
    compiledRules.push({
      raw: trimmed,
      negated,
      regex: compileDockerignorePattern(patternBody),
    });
  }

  const evaluateDirect = (cleanPath: string): boolean => {
    let ignored = false;
    for (const rule of compiledRules) {
      if (rule.regex.test(cleanPath)) {
        ignored = !rule.negated;
      }
    }
    return ignored;
  };

  const isIgnored = (relPath: string): boolean => {
    const clean = relPath.replace(/\\/g, SLASH).replace(/^\/+|\/+$/g, "");
    if (!clean || clean === ".") return false;
    const parts = clean.split(SLASH);
    let prefix = "";
    for (let i = 0; i < parts.length - 1; i++) {
      prefix = i === 0 ? parts[0] : `${prefix}${SLASH}${parts[i]}`;
      if (evaluateDirect(prefix)) {
        return true;
      }
    }
    return evaluateDirect(clean);
  };

  return { rules: compiledRules, isIgnored };
}

function copyDirectoryRecursive(srcDir: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcChild = path.join(srcDir, entry.name);
    const destChild = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryRecursive(srcChild, destChild);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcChild, destChild);
    }
  }
}

test("sw.js pre-cached shell URLs map to real files in web/public or web/index.html while API, ingest, live, and hud-ws paths bypass caching", async () => {
  const webDir = path.join(REPO_ROOT, "web");
  const publicDir = path.join(webDir, "public");
  const indexHtmlPath = path.join(webDir, "index.html");
  const swPath = path.join(publicDir, "sw.js");

  const swSource = fs.readFileSync(swPath, "utf8");
  let networkOnline = true;
  const sw = createServiceWorkerSandbox(swSource, {
    onNetworkFetch: async (req) => {
      if (!networkOnline) {
        throw new Error("Simulated offline disconnect");
      }
      const parsed = new URL(req.url);
      if (parsed.pathname === "/" || parsed.pathname === "/index.html" || parsed.pathname === "/hud") {
        return new Response("<!doctype html><html><body>HoldUp Cached Shell</body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      return new Response(`static:${parsed.pathname}`, {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
      });
    },
  });

  const { cacheName, shellAssets, isNeverCachedPath, isNavigationRequest, isCacheableStaticAsset } =
    sw.bindings;

  assert.equal(cacheName, "holdup-shell-v1");
  assert.ok(Array.isArray(shellAssets) && shellAssets.length >= 4, "Expected non-empty shell pre-cache list");
  assert.equal(new Set(shellAssets).size, shellAssets.length, "Shell pre-cache URLs must be unique");
  assert.deepEqual(shellAssets, ["/", "/index.html", "/manifest.webmanifest", "/icon.svg"]);
  assert.equal(typeof isNeverCachedPath, "function");
  assert.equal(typeof isNavigationRequest, "function");
  assert.equal(typeof isCacheableStaticAsset, "function");

  await sw.dispatchLifecycle("install");
  assert.equal(sw.getSkipWaitingCount(), 1);
  assert.equal(sw.addAllBatches.length, 1);
  assert.equal(sw.addAllBatches[0].cacheName, cacheName);
  assert.deepEqual(sw.addAllBatches[0].urls, shellAssets);

  await sw.dispatchLifecycle("activate");
  assert.equal(sw.getClaimCount(), 1);

  const distDir = path.join(webDir, "dist");
  const hasBuiltDist = fs.existsSync(path.join(distDir, "index.html"));

  for (const assetUrl of shellAssets) {
    assert.ok(assetUrl.startsWith(SLASH), `Pre-cached URL must start with /: ${assetUrl}`);
    assert.equal(assetUrl.includes("?"), false, `Pre-cached URL must not contain query string: ${assetUrl}`);
    assert.equal(assetUrl.includes(HASH), false, `Pre-cached URL must not contain hash: ${assetUrl}`);
    assert.equal(
      isNeverCachedPath!(assetUrl),
      false,
      `Pre-cached shell asset ${assetUrl} must not be marked never-cached`,
    );

    if (assetUrl === "/" || assetUrl === "/index.html") {
      assert.equal(fs.existsSync(indexHtmlPath), true, `Expected ${assetUrl} to map to web/index.html`);
      const stat = fs.statSync(indexHtmlPath);
      assert.equal(stat.isFile(), true);
      assert.ok(stat.size > 0);
      if (hasBuiltDist) {
        const builtIndex = path.join(distDir, "index.html");
        assert.equal(fs.existsSync(builtIndex) && fs.statSync(builtIndex).isFile(), true);
      }
    } else {
      const rel = assetUrl.slice(1);
      const resolvedPublic = path.resolve(publicDir, rel);
      const relFromPublic = path.relative(publicDir, resolvedPublic);
      assert.equal(relFromPublic.startsWith(".."), false, `Shell asset escaped web/public: ${assetUrl}`);
      assert.equal(
        fs.existsSync(resolvedPublic) && fs.statSync(resolvedPublic).isFile(),
        true,
        `Expected ${assetUrl} to map to real file web/public/${rel}`,
      );
      assert.ok(fs.statSync(resolvedPublic).size > 0);
      assert.equal(
        isCacheableStaticAsset!(assetUrl),
        true,
        `Expected static shell asset ${assetUrl} to match isCacheableStaticAsset`,
      );
      if (hasBuiltDist) {
        const builtAsset = path.resolve(distDir, rel);
        assert.equal(fs.existsSync(builtAsset) && fs.statSync(builtAsset).isFile(), true);
      }
    }
  }

  const fixturesDir = path.join(publicDir, "fixtures");
  const fixtureFiles = fs.readdirSync(fixturesDir).filter((name) => name.endsWith(".jpg")).sort();
  assert.equal(fixtureFiles.length, 7);
  for (const fixtureName of fixtureFiles) {
    const fixtureUrl = `/fixtures/${fixtureName}`;
    assert.equal(isNeverCachedPath!(fixtureUrl), false);
    assert.equal(isCacheableStaticAsset!(fixtureUrl), true);
  }

  const strictlyBypassedPaths = [
    "/sw.js",
    "/api",
    "/api/",
    "/api/health",
    "/api/stats",
    "/api/eval-summary",
    "/api/verify",
    "/api/tts",
    "/api/unknown",
    "/ingest",
    "/ingest/",
    "/ingest/frame",
    "/ingest/state",
    "/live",
    "/live/",
    "/live/reconnect",
    "/hud-ws",
    "/hud-ws/",
    "/hud-ws/reconnect",
    "/@vite/client",
    "/src/main.tsx",
    "/node_modules/vite/index.js",
  ];

  for (const bypassedPath of strictlyBypassedPaths) {
    assert.equal(
      isNeverCachedPath!(bypassedPath),
      true,
      `Expected isNeverCachedPath(${bypassedPath}) === true`,
    );
  }

  for (const allowedPath of [
    "/",
    "/index.html",
    "/hud",
    "/hud/",
    "/manifest.webmanifest",
    "/icon.svg",
    "/.well-known/meta-wearables-manifest.json",
    "/assets/index-bundle.js",
    "/assets/index-bundle.css",
  ]) {
    assert.equal(
      isNeverCachedPath!(allowedPath),
      false,
      `Expected isNeverCachedPath(${allowedPath}) === false`,
    );
  }

  sw.ensureBucket(cacheName!).set(
    normalizeCacheKey("/api/health"),
    new Response('{"ok":false,"stale":true}', { status: 200 }),
  );
  sw.ensureBucket(cacheName!).set(
    normalizeCacheKey("/api/verify"),
    new Response('{"level":"match","stale":true}', { status: 200 }),
  );

  const liveBypassRequests: MockSwRequest[] = [
    makeSwRequest("/api/health", { method: "GET" }),
    makeSwRequest("/api/stats", { method: "GET" }),
    makeSwRequest("/api/eval-summary", { method: "GET" }),
    makeSwRequest("/api/verify", { method: "POST" }),
    makeSwRequest("/api/verify", { method: "GET" }),
    makeSwRequest("/api/tts", { method: "POST" }),
    makeSwRequest("/api/tts", { method: "GET" }),
    makeSwRequest("/ingest/frame?session=s100", { method: "POST" }),
    makeSwRequest("/ingest/frame", { method: "GET" }),
    makeSwRequest("/ingest/state?session=s100", { method: "POST" }),
    makeSwRequest("/ingest/state", { method: "GET" }),
    makeSwRequest("/live", { method: "GET" }),
    makeSwRequest("/live?session=s100", { method: "GET" }),
    makeSwRequest("/hud-ws", { method: "GET" }),
    makeSwRequest("/hud-ws?session=s100", { method: "GET" }),
    makeSwRequest("/sw.js", { method: "GET" }),
  ];

  for (const req of liveBypassRequests) {
    sw.resetTelemetry();
    const outcome = await sw.dispatchFetch(req);
    assert.equal(
      outcome.intercepted,
      false,
      `Service Worker must never intercept ${req.method} ${req.url}`,
    );
    assert.deepEqual(
      sw.cacheTouches,
      [],
      `Service Worker must never read or write cache for ${req.method} ${req.url}`,
    );
    assert.deepEqual(
      sw.networkCalls,
      [],
      `Service Worker must not proxy ${req.method} ${req.url}`,
    );
  }

  networkOnline = false;
  for (const navRoute of ["/", "/hud"]) {
    assert.equal(
      isNavigationRequest!(
        makeSwRequest(navRoute, { mode: "navigate", destination: "document", accept: "text/html" }),
        navRoute,
      ),
      true,
    );
    const offlineNav = await sw.dispatchFetch(
      makeSwRequest(navRoute, { mode: "navigate", destination: "document", accept: "text/html" }),
    );
    assert.equal(offlineNav.intercepted, true);
    assert.ok(offlineNav.response);
    assert.equal(offlineNav.response.status, 200);
    assert.match(await offlineNav.response.text(), /HoldUp Cached Shell/);
  }
});

test("manifest.webmanifest, .well-known/meta-wearables-manifest.json, icon.svg, index.html, tokens.css, and hud.css align 1:1 on icons, start_url, and #000000 Ray-Ban Display colors", () => {
  const webDir = path.join(REPO_ROOT, "web");
  const publicDir = path.join(webDir, "public");

  const pwaManifestRaw = fs.readFileSync(path.join(publicDir, "manifest.webmanifest"), "utf8");
  const wearablesManifestRaw = fs.readFileSync(
    path.join(publicDir, ".well-known", "meta-wearables-manifest.json"),
    "utf8",
  );
  const iconSvgRaw = fs.readFileSync(path.join(publicDir, "icon.svg"), "utf8");
  const indexHtmlRaw = fs.readFileSync(path.join(webDir, "index.html"), "utf8");
  const hudCssRaw = fs.readFileSync(path.join(webDir, "src", "hud", "hud.css"), "utf8");
  const tokensCssRaw = fs.readFileSync(path.join(webDir, "src", "styles", "tokens.css"), "utf8");

  const pwaManifest = JSON.parse(pwaManifestRaw) as WebManifestDoc;
  const wearablesManifest = JSON.parse(wearablesManifestRaw) as WebManifestDoc;

  assert.equal(pwaManifest.short_name, "HoldUp");
  assert.equal(wearablesManifest.short_name, "HoldUp");
  assert.equal(wearablesManifest.name, "HoldUp");
  assert.equal(pwaManifest.display, "standalone");
  assert.equal(wearablesManifest.display, "standalone");

  assert.equal(pwaManifest.start_url, "/");
  assert.equal(pwaManifest.scope, "/");
  assert.equal(wearablesManifest.start_url, "/hud");
  assert.notEqual(pwaManifest.start_url, wearablesManifest.start_url);

  assert.ok(Array.isArray(pwaManifest.shortcuts) && pwaManifest.shortcuts.length > 0);
  const shortcuts = pwaManifest.shortcuts as ManifestShortcut[];
  const hudShortcut = shortcuts.find((s) => s.url === wearablesManifest.start_url);
  assert.ok(hudShortcut, "Expected manifest.webmanifest shortcut targeting /hud");

  assert.ok(Array.isArray(pwaManifest.icons) && pwaManifest.icons.length > 0);
  assert.ok(Array.isArray(wearablesManifest.icons) && wearablesManifest.icons.length > 0);
  const pwaIcons = pwaManifest.icons as ManifestIcon[];
  const wearablesIcons = wearablesManifest.icons as ManifestIcon[];
  const shortcutIcons = Array.isArray(hudShortcut.icons) ? (hudShortcut.icons as ManifestIcon[]) : [];
  assert.ok(shortcutIcons.length > 0, "Expected /hud shortcut to declare /icon.svg");

  for (const icon of [...pwaIcons, ...shortcutIcons, ...wearablesIcons]) {
    assert.equal(icon.src, "/icon.svg");
    assert.equal(icon.type, "image/svg+xml");
    const diskIcon = path.join(publicDir, String(icon.src).slice(1));
    assert.equal(fs.existsSync(diskIcon) && fs.statSync(diskIcon).isFile(), true);
  }

  assert.ok(
    pwaIcons.some((i) => i.src === "/icon.svg" && i.sizes === "512x512" && i.type === "image/svg+xml"),
    "Expected 512x512 /icon.svg in manifest.webmanifest",
  );
  assert.ok(
    wearablesIcons.some((i) => i.src === "/icon.svg" && i.sizes === "512x512" && i.type === "image/svg+xml"),
    "Expected 512x512 /icon.svg in meta-wearables-manifest.json",
  );

  assert.ok(iconSvgRaw.includes('width="512"'));
  assert.ok(iconSvgRaw.includes('height="512"'));
  assert.ok(iconSvgRaw.includes('viewBox="0 0 512 512"'));
  assert.ok(indexHtmlRaw.includes('<link rel="icon" type="image/svg+xml" href="/icon.svg" />'));
  assert.ok(indexHtmlRaw.includes('<link rel="apple-touch-icon" href="/icon.svg" />'));
  assert.ok(indexHtmlRaw.includes('<link rel="manifest" href="/manifest.webmanifest" />'));

  assert.equal(wearablesManifest.background_color, "#000000");
  assert.equal(wearablesManifest.theme_color, "#000000");

  const hudRules = parseCssRules(hudCssRaw);
  for (const hostSelector of [":root:has(.hud-root)", "body:has(.hud-root)", "#root:has(.hud-root)"]) {
    const decls = getSelectorDeclarations(hudRules, hostSelector);
    assert.equal(
      decls["background"],
      wearablesManifest.background_color,
      `${hostSelector} background must match wearables manifest #000000`,
    );
    assert.equal(
      decls["background-color"],
      wearablesManifest.background_color,
      `${hostSelector} background-color must match wearables manifest #000000`,
    );
  }

  const hudRootDecls = getSelectorDeclarations(hudRules, ".hud-root");
  assert.equal(hudRootDecls["--hud-bg"], wearablesManifest.theme_color);
  assert.equal(hudRootDecls["background"], wearablesManifest.background_color);
  assert.equal(hudRootDecls["background-color"], wearablesManifest.background_color);
  assert.equal(hudRootDecls["color"], "#ffffff");

  for (const hudSurface of [
    ".hud-topbar",
    ".hud-device-pill",
    ".hud-stage",
    ".hud-card",
    ".hud-shape-frame",
    ".hud-badge",
    ".hud-chip",
    ".hud-coach-card",
    ".hud-standby",
    ".hud-action-btn",
  ]) {
    const surfaceDecls = getSelectorDeclarations(hudRules, hudSurface);
    assert.equal(
      surfaceDecls["background-color"],
      wearablesManifest.background_color,
      `Expected ${hudSurface} background-color to align 1:1 with #000000 waveguide canvas`,
    );
  }

  assert.equal(pwaManifest.background_color, "#0b0f17");
  assert.equal(pwaManifest.theme_color, "#0b0f17");

  const metaThemeMatch = /<meta\s+name="theme-color"\s+content="([^"]+)"\s*\/?>/i.exec(indexHtmlRaw);
  assert.ok(metaThemeMatch, "Expected <meta name=\"theme-color\"> in web/index.html");
  assert.equal(metaThemeMatch[1], pwaManifest.theme_color);

  const tokenRules = parseCssRules(tokensCssRaw);
  const rootTokenDecls = getSelectorDeclarations(tokenRules, ":root");
  assert.equal(rootTokenDecls["--bg-app"], pwaManifest.background_color);
  assert.ok(iconSvgRaw.includes(`fill="${String(pwaManifest.background_color)}"`));

  const distDir = path.join(webDir, "dist");
  if (fs.existsSync(path.join(distDir, "index.html"))) {
    assert.equal(fs.readFileSync(path.join(distDir, "manifest.webmanifest"), "utf8"), pwaManifestRaw);
    assert.equal(
      fs.readFileSync(path.join(distDir, ".well-known", "meta-wearables-manifest.json"), "utf8"),
      wearablesManifestRaw,
    );
    assert.equal(fs.readFileSync(path.join(distDir, "icon.svg"), "utf8"), iconSvgRaw);
    assert.equal(
      fs.readFileSync(path.join(distDir, "sw.js"), "utf8"),
      fs.readFileSync(path.join(publicDir, "sw.js"), "utf8"),
    );
  }
});

test("Dockerfile runtime stage copies and build inputs align 1:1 with .dockerignore inclusions and sensitive exclusions", () => {
  const dockerfileRaw = fs.readFileSync(path.join(REPO_ROOT, "Dockerfile"), "utf8");
  const dockerignoreRaw = fs.readFileSync(path.join(REPO_ROOT, ".dockerignore"), "utf8");

  const stages = parseDockerfileStages(dockerfileRaw);
  assert.deepEqual(
    stages.map((s) => s.name),
    ["build", "runtime"],
  );
  const [buildStage, runtimeStage] = stages;

  const matcher = createDockerignoreMatcher(dockerignoreRaw);
  assert.ok(matcher.rules.length >= 20, "Expected populated .dockerignore rule set");

  const runtimeCopies: Array<{ fromAppPath: string; destRelPath: string }> = [];
  for (const line of runtimeStage.lines) {
    if (!line.startsWith("COPY ")) continue;
    const match = /^COPY\s+--from=build(?:\s+--chown=\S+)?\s+(\/app\/\S+)\s+(\.\/\S+)$/.exec(line);
    assert.ok(match, `Every runtime COPY must come --from=build: ${line}`);
    runtimeCopies.push({
      fromAppPath: match[1].slice("/app/".length),
      destRelPath: match[2].slice("./".length),
    });
  }

  const runtimeTargets = runtimeCopies.map((c) => c.destRelPath);
  for (const requiredRuntimeTarget of [
    "package.json",
    "shared",
    "server",
    "web/package.json",
    "web/dist",
    "deck",
    "docs",
    "eval/combined_summary.json",
  ]) {
    assert.ok(
      runtimeTargets.includes(requiredRuntimeTarget),
      `Expected Dockerfile runtime stage to copy ${requiredRuntimeTarget}`,
    );
  }

  for (const copyEntry of runtimeCopies) {
    assert.equal(copyEntry.fromAppPath, copyEntry.destRelPath);
    if (copyEntry.destRelPath === "node_modules") {
      assert.ok(buildStage.lines.some((l) => l.startsWith("RUN npm install")));
      assert.equal(matcher.isIgnored("package.json"), false);
      assert.equal(matcher.isIgnored("server/package.json"), false);
      assert.equal(matcher.isIgnored("web/package.json"), false);
      continue;
    }
    if (copyEntry.destRelPath === "web/dist") {
      assert.ok(buildStage.lines.includes("COPY web ./web"));
      assert.ok(buildStage.lines.includes("RUN npm run typecheck && npm run build"));
      assert.equal(matcher.isIgnored("web"), false);
      continue;
    }
    assert.equal(
      matcher.isIgnored(copyEntry.destRelPath),
      false,
      `Expected runtime artifact ${copyEntry.destRelPath} to be permitted by .dockerignore`,
    );
    assert.equal(
      fs.existsSync(path.join(REPO_ROOT, copyEntry.destRelPath)),
      true,
      `Expected ${copyEntry.destRelPath} to exist on disk`,
    );
  }

  const permittedConcretePaths = [
    "package.json",
    "server/package.json",
    "web/package.json",
    ".env.example",
    "shared",
    "shared/types.ts",
    "shared/label_schema.json",
    "shared/verify_prompt.md",
    "server",
    "server/src/index.ts",
    "server/src/safety.ts",
    "server/src/verify.ts",
    "web",
    "web/index.html",
    "web/vite.config.ts",
    "web/src/main.tsx",
    "web/src/hud/hud.css",
    "web/src/styles/tokens.css",
    "web/public/sw.js",
    "web/public/manifest.webmanifest",
    "web/public/.well-known/meta-wearables-manifest.json",
    "web/public/icon.svg",
    "web/public/fixtures/amlodipine.jpg",
    "deck",
    "deck/index.html",
    "deck/deck.css",
    "deck/deck.js",
    "docs",
    "docs/judge-handout.html",
    "docs/printable-props.html",
    "docs/DEPLOY.md",
    "eval/combined_summary.json",
  ];

  for (const permittedPath of permittedConcretePaths) {
    assert.equal(
      matcher.isIgnored(permittedPath),
      false,
      `.dockerignore must permit ${permittedPath}`,
    );
    assert.equal(
      fs.existsSync(path.join(REPO_ROOT, permittedPath)),
      true,
      `Expected permitted path ${permittedPath} to exist in repository`,
    );
  }

  const excludedPaths = [
    ".env",
    ".env.local",
    ".env.production",
    ".git",
    ".git/HEAD",
    ".git/config",
    "eval/out",
    "eval/out/latest.json",
    "eval/synthetic",
    "eval/synthetic/frame01.jpg",
    "eval/real/raw_capture.jpg",
    "server/logs",
    "server/logs/calls.jsonl",
    "node_modules",
    "server/node_modules",
    "web/node_modules",
  ];

  for (const excludedPath of excludedPaths) {
    assert.equal(
      matcher.isIgnored(excludedPath),
      true,
      `.dockerignore must exclude ${excludedPath}`,
    );
  }

  assert.ok(
    runtimeStage.lines.some((l) => l.startsWith("RUN mkdir -p") && l.includes("/app/server/logs")),
    "Runtime stage must recreate empty /app/server/logs after .dockerignore excludes host server/logs",
  );
});

test("staged runtime bundle serves sw.js pre-cached assets, both manifests, /hud, /deck/, docs, and no-store /api routes without model calls", async () => {
  const stagedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "holdup-bundle-manifest-"));
  const prevApiKey = env.apiKey;
  env.apiKey = "";
  let srv: http.Server | null = null;

  try {
    const stagedDist = path.join(stagedRoot, "web", "dist");
    copyDirectoryRecursive(path.join(REPO_ROOT, "web", "public"), stagedDist);
    fs.copyFileSync(path.join(REPO_ROOT, "web", "index.html"), path.join(stagedDist, "index.html"));
    copyDirectoryRecursive(path.join(REPO_ROOT, "deck"), path.join(stagedRoot, "deck"));

    const stagedDocs = path.join(stagedRoot, "docs");
    fs.mkdirSync(stagedDocs, { recursive: true });
    fs.copyFileSync(
      path.join(REPO_ROOT, "docs", "judge-handout.html"),
      path.join(stagedDocs, "judge-handout.html"),
    );
    fs.copyFileSync(
      path.join(REPO_ROOT, "docs", "printable-props.html"),
      path.join(stagedDocs, "printable-props.html"),
    );

    const stagedEval = path.join(stagedRoot, "eval");
    fs.mkdirSync(stagedEval, { recursive: true });
    fs.copyFileSync(
      path.join(REPO_ROOT, "eval", "combined_summary.json"),
      path.join(stagedEval, "combined_summary.json"),
    );

    srv = await startServer(0, { repoRoot: stagedRoot });
    const { port } = srv.address() as AddressInfo;
    const baseUrl = `http:${DOUBLE_SLASH}127.0.0.1:${port}`;

    const rootRes = await fetch(`${baseUrl}/`);
    assert.equal(rootRes.status, 200);
    assert.match(rootRes.headers.get("content-type") ?? "", /text\/html/i);
    const rootHtml = await rootRes.text();

    const indexRes = await fetch(`${baseUrl}/index.html`);
    assert.equal(indexRes.status, 200);
    assert.equal(await indexRes.text(), rootHtml);

    const hudRes = await fetch(`${baseUrl}/hud`);
    assert.equal(hudRes.status, 200);
    assert.match(hudRes.headers.get("content-type") ?? "", /text\/html/i);
    assert.equal(await hudRes.text(), rootHtml);

    const pwaManifestRes = await fetch(`${baseUrl}/manifest.webmanifest`);
    assert.equal(pwaManifestRes.status, 200);
    assert.match(pwaManifestRes.headers.get("content-type") ?? "", /application\/(manifest\+)?json/i);
    const pwaManifestJson = (await pwaManifestRes.json()) as WebManifestDoc;
    assert.equal(pwaManifestJson.start_url, "/");
    assert.equal(pwaManifestJson.background_color, "#0b0f17");

    const wearablesRes = await fetch(`${baseUrl}/.well-known/meta-wearables-manifest.json`);
    assert.equal(wearablesRes.status, 200);
    assert.match(wearablesRes.headers.get("content-type") ?? "", /application\/json/i);
    const wearablesJson = (await wearablesRes.json()) as WebManifestDoc;
    assert.equal(wearablesJson.start_url, "/hud");
    assert.equal(wearablesJson.background_color, "#000000");
    assert.equal(wearablesJson.theme_color, "#000000");

    const iconRes = await fetch(`${baseUrl}/icon.svg`);
    assert.equal(iconRes.status, 200);
    assert.match(iconRes.headers.get("content-type") ?? "", /image\/svg\+xml/i);
    assert.match(await iconRes.text(), /viewBox="0 0 512 512"/);

    const swRes = await fetch(`${baseUrl}/sw.js`);
    assert.equal(swRes.status, 200);
    assert.match(swRes.headers.get("content-type") ?? "", /(text|application)\/javascript/i);
    assert.equal(
      await swRes.text(),
      fs.readFileSync(path.join(REPO_ROOT, "web", "public", "sw.js"), "utf8"),
    );

    const fixtureRes = await fetch(`${baseUrl}/fixtures/amlodipine.jpg`);
    assert.equal(fixtureRes.status, 200);
    assert.match(fixtureRes.headers.get("content-type") ?? "", /^image\/jpeg\b/i);
    await fixtureRes.arrayBuffer();

    const deckRes = await fetch(`${baseUrl}/deck/`);
    assert.equal(deckRes.status, 200);
    assert.match(deckRes.headers.get("content-type") ?? "", /text\/html/i);
    await deckRes.text();

    for (const docRoute of ["/judge-handout.html", "/printable-props.html"]) {
      const docRes = await fetch(`${baseUrl}${docRoute}`);
      assert.equal(docRes.status, 200);
      assert.match(docRes.headers.get("content-type") ?? "", /text\/html/i);
      await docRes.text();
    }

    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    assert.equal(healthRes.headers.get("cache-control"), "no-store");
    const healthJson = (await healthRes.json()) as Record<string, unknown>;
    assert.equal(healthJson.ok, true);
    assert.equal(healthJson.gemini, "down");

    const evalRes = await fetch(`${baseUrl}/api/eval-summary`);
    assert.equal(evalRes.status, 200);
    assert.equal(evalRes.headers.get("cache-control"), "no-store");
    const evalJson = (await evalRes.json()) as { ok: boolean; summary: Record<string, unknown> | null };
    assert.equal(evalJson.ok, true);
    assert.notEqual(evalJson.summary, null);
  } finally {
    env.apiKey = prevApiKey;
    if (srv) {
      srv.closeAllConnections();
      await new Promise<void>((resolve) => srv!.close(() => resolve()));
    }
    fs.rmSync(stagedRoot, { recursive: true, force: true });
  }
});

test("production-bundle-manifest.test.ts and cross-checked bundle artifacts contain zero comments, em dashes, attribution trailers, or API keys", () => {
  const selfRel = "server/test/production-bundle-manifest.test.ts";
  const selfText = fs.readFileSync(path.join(REPO_ROOT, selfRel), "utf8");

  assert.equal(selfText.includes(DOUBLE_SLASH), false, `Forbidden double-slash sequence in ${selfRel}`);
  assert.equal(selfText.includes(BLOCK_OPEN), false, `Forbidden block comment opener in ${selfRel}`);
  assert.equal(selfText.includes(BLOCK_CLOSE), false, `Forbidden block comment closer in ${selfRel}`);
  assert.equal(selfText.includes(HTML_COMMENT_OPEN), false, `Forbidden HTML comment in ${selfRel}`);
  assert.equal(selfText.includes(EM_DASH), false, `Forbidden em dash in ${selfRel}`);
  assert.equal(CO_AUTHORED_RE.test(selfText), false, `Forbidden co-authored token in ${selfRel}`);
  assert.equal(API_KEY_RE.test(selfText), false, `Forbidden API key pattern in ${selfRel}`);

  const lineCommentRe = new RegExp(`(^|[^:])${DOUBLE_SLASH}`);
  for (const rel of [
    "web/public/sw.js",
    "web/public/manifest.webmanifest",
    "web/public/.well-known/meta-wearables-manifest.json",
    "web/src/hud/hud.css",
  ]) {
    const content = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
    assert.equal(content.includes(BLOCK_OPEN), false, `Forbidden block comment opener in ${rel}`);
    assert.equal(content.includes(BLOCK_CLOSE), false, `Forbidden block comment closer in ${rel}`);
    assert.equal(content.includes(HTML_COMMENT_OPEN), false, `Forbidden HTML comment in ${rel}`);
    assert.equal(content.includes(EM_DASH), false, `Forbidden em dash in ${rel}`);
    assert.equal(CO_AUTHORED_RE.test(content), false, `Forbidden co-authored token in ${rel}`);
    assert.equal(API_KEY_RE.test(content), false, `Forbidden API key pattern in ${rel}`);
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      assert.equal(lineCommentRe.test(lines[i]), false, `Forbidden line comment in ${rel}:${i + 1}`);
    }
  }
});
