import { registerServiceWorker } from "../src/pwa/registerSw.ts";

type TestFn = (name: string, fn: () => void | Promise<void>) => Promise<void>;

type StrictAssert = {
  ok(value: unknown, message?: string): asserts value;
  equal<T>(actual: T, expected: T, message?: string): void;
  deepEqual<T>(actual: T, expected: T, message?: string): void;
  doesNotThrow(block: () => unknown, message?: string): void;
  match(value: string, regExp: RegExp, message?: string): void;
};

type FsModule = {
  readFileSync(path: URL | string, encoding: "utf8"): string;
};

type VmModule = {
  runInNewContext(code: string, contextObject: Record<string, unknown>): unknown;
};

const nodeTestSpec: string = "node:test";
const nodeAssertSpec: string = "node:assert/strict";
const nodeFsSpec: string = "node:fs";
const nodeVmSpec: string = "node:vm";

const { test } = (await import(nodeTestSpec)) as { test: TestFn };
const assert: StrictAssert = ((await import(nodeAssertSpec)) as { default: StrictAssert }).default;
const { readFileSync } = (await import(nodeFsSpec)) as FsModule;
const vm = (await import(nodeVmSpec)) as VmModule;

const ORIGIN = "https:\x2f\x2fholdup.example";

const indexHtmlSource = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const manifestSource = readFileSync(new URL("../public/manifest.webmanifest", import.meta.url), "utf8");
const wearablesManifestSource = readFileSync(
  new URL("../public/.well-known/meta-wearables-manifest.json", import.meta.url),
  "utf8"
);
const iconSvgSource = readFileSync(new URL("../public/icon.svg", import.meta.url), "utf8");
const swSource = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");

type ManifestIcon = {
  src?: string;
  sizes?: string;
  type?: string;
  purpose?: string;
};

type ManifestShortcut = {
  name?: string;
  short_name?: string;
  description?: string;
  url?: string;
  icons?: ManifestIcon[];
};

type WebAppManifest = {
  name?: string;
  short_name?: string;
  description?: string;
  start_url?: string;
  scope?: string;
  display?: string;
  background_color?: string;
  theme_color?: string;
  icons?: ManifestIcon[];
  shortcuts?: ManifestShortcut[];
};

type MockSwRequest = {
  url: string;
  method: string;
  mode: string;
  destination: string;
  headers: {
    get(name: string): string | null;
  };
};

type ExtendableEventLike = {
  waitUntil(promise: Promise<unknown>): void;
};

type FetchEventLike = ExtendableEventLike & {
  request: MockSwRequest;
  respondWith(response: Promise<Response> | Response): void;
};

type SwListenerMap = {
  install?: (event: ExtendableEventLike) => void;
  activate?: (event: ExtendableEventLike) => void;
  fetch?: (event: FetchEventLike) => void;
};

function makeSwRequest(
  pathOrUrl: string,
  opts?: {
    method?: string;
    mode?: string;
    destination?: string;
    accept?: string;
  }
): MockSwRequest {
  const fullUrl = pathOrUrl.includes(":\x2f\x2f")
    ? pathOrUrl
    : new URL(pathOrUrl, ORIGIN).href;
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
      }
    }
  };
}

function normalizeCacheKey(input: string | MockSwRequest): string {
  if (typeof input === "string") {
    return new URL(input, ORIGIN).href;
  }
  return new URL(input.url, ORIGIN).href;
}

function createSwHarness(opts?: {
  onFetch?: (request: MockSwRequest) => Promise<Response>;
}) {
  const listeners: SwListenerMap = {};
  const stores = new Map<string, Map<string, Response>>();
  const cacheTouches: string[] = [];
  const fetchUrls: string[] = [];
  let skipWaitingCount = 0;
  let clientsClaimCount = 0;

  const openBucket = (cacheName: string): Map<string, Response> => {
    let bucket = stores.get(cacheName);
    if (!bucket) {
      bucket = new Map<string, Response>();
      stores.set(cacheName, bucket);
    }
    return bucket;
  };

  const fetchImpl = async (input: string | MockSwRequest): Promise<Response> => {
    const req = typeof input === "string" ? makeSwRequest(input) : input;
    fetchUrls.push(req.url);
    if (opts?.onFetch) {
      return opts.onFetch(req);
    }
    const parsed = new URL(req.url);
    if (parsed.pathname === "/" || parsed.pathname === "/index.html" || parsed.pathname === "/hud") {
      return new Response("<!doctype html><html><body>Shell</body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }
    if (parsed.pathname.endsWith(".webmanifest") || parsed.pathname.endsWith(".json")) {
      return new Response('{"name":"HoldUp"}', {
        status: 200,
        headers: { "Content-Type": "application/manifest+json" }
      });
    }
    if (parsed.pathname.endsWith(".svg")) {
      return new Response('<svg viewBox="0 0 512 512"></svg>', {
        status: 200,
        headers: { "Content-Type": "image/svg+xml" }
      });
    }
    return new Response(`asset:${parsed.pathname}`, {
      status: 200,
      headers: { "Content-Type": "application/javascript" }
    });
  };

  const rawCaches = {
    async open(cacheName: string) {
      const bucket = openBucket(cacheName);
      return {
        async addAll(urls: string[]): Promise<void> {
          cacheTouches.push(`addAll:${cacheName}:${urls.join(",")}`);
          for (const u of urls) {
            const res = await fetchImpl(u);
            bucket.set(normalizeCacheKey(u), res.clone());
          }
        },
        async match(query: string | MockSwRequest): Promise<Response | undefined> {
          const key = normalizeCacheKey(query);
          cacheTouches.push(`match:${cacheName}:${key}`);
          const found = bucket.get(key);
          return found ? found.clone() : undefined;
        },
        async put(query: string | MockSwRequest, response: Response): Promise<void> {
          const key = normalizeCacheKey(query);
          cacheTouches.push(`put:${cacheName}:${key}`);
          bucket.set(key, response.clone());
        }
      };
    },
    async keys(): Promise<string[]> {
      return [...stores.keys()];
    },
    async delete(cacheName: string): Promise<boolean> {
      return stores.delete(cacheName);
    },
    async match(query: string | MockSwRequest): Promise<Response | undefined> {
      const key = normalizeCacheKey(query);
      for (const bucket of stores.values()) {
        const hit = bucket.get(key);
        if (hit) {
          return hit.clone();
        }
      }
      return undefined;
    }
  };

  const trackedCaches = new Proxy(rawCaches, {
    get(target, prop, receiver) {
      cacheTouches.push(`caches.${String(prop)}`);
      return Reflect.get(target, prop, receiver);
    }
  });

  const selfMock = {
    location: { origin: ORIGIN },
    skipWaiting: async () => {
      skipWaitingCount += 1;
    },
    clients: {
      claim: async () => {
        clientsClaimCount += 1;
      }
    },
    addEventListener(type: string, handler: unknown) {
      if (type === "install" || type === "activate" || type === "fetch") {
        (listeners as Record<string, unknown>)[type] = handler;
      }
    }
  };

  vm.runInNewContext(swSource, {
    self: selfMock,
    caches: trackedCaches,
    fetch: fetchImpl,
    URL,
    Response,
    Headers,
    Promise
  });

  async function dispatchLifecycle(kind: "install" | "activate"): Promise<void> {
    const handler = listeners[kind];
    assert.ok(handler, `expected ${kind} listener to be registered`);
    const pending: Promise<unknown>[] = [];
    handler({
      waitUntil(p) {
        pending.push(p);
      }
    });
    await Promise.all(pending);
  }

  async function dispatchFetch(request: MockSwRequest): Promise<{
    intercepted: boolean;
    response: Response | null;
  }> {
    const handler = listeners.fetch;
    assert.ok(handler, "expected fetch listener to be registered");
    const pending: Promise<unknown>[] = [];
    let responsePromise: Promise<Response> | null = null;

    handler({
      request,
      waitUntil(p) {
        pending.push(p);
      },
      respondWith(r) {
        responsePromise = Promise.resolve(r);
      }
    });

    if (!responsePromise) {
      await Promise.all(pending);
      return { intercepted: false, response: null };
    }

    const response = await (responsePromise as Promise<Response>);
    await Promise.all(pending);
    return { intercepted: true, response };
  }

  return {
    listeners,
    stores,
    cacheTouches,
    fetchUrls,
    openBucket,
    getSkipWaitingCount: () => skipWaitingCount,
    getClientsClaimCount: () => clientsClaimCount,
    resetTelemetry() {
      cacheTouches.length = 0;
      fetchUrls.length = 0;
    },
    dispatchLifecycle,
    dispatchFetch
  };
}

test("web/index.html includes complete mobile PWA metadata, accessible noscript fallback, and zero HTML comments", () => {
  assert.equal(indexHtmlSource.includes("<!--"), false, "HTML comments must not appear in index.html");
  assert.equal(indexHtmlSource.includes("-->"), false, "HTML comment closers must not appear in index.html");
  assert.equal(indexHtmlSource.includes("\u2014"), false, "em dashes must not appear in index.html");

  assert.match(indexHtmlSource, /<meta\s+name="description"\s+content="[^"]{20,}"\s*\/>/);
  assert.ok(indexHtmlSource.includes('<meta name="color-scheme" content="dark light" />'));
  assert.ok(indexHtmlSource.includes('<meta name="theme-color" content="#0b0f17" />'));
  assert.ok(indexHtmlSource.includes('<meta name="apple-mobile-web-app-capable" content="yes" />'));
  assert.ok(
    indexHtmlSource.includes('<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />')
  );
  assert.ok(indexHtmlSource.includes('<meta name="apple-mobile-web-app-title" content="HoldUp" />'));
  assert.ok(indexHtmlSource.includes('<link rel="icon" type="image/svg+xml" href="/icon.svg" />'));
  assert.ok(indexHtmlSource.includes('<link rel="apple-touch-icon" href="/icon.svg" />'));
  assert.ok(indexHtmlSource.includes('<link rel="manifest" href="/manifest.webmanifest" />'));

  const bodyMatch = /<body>([\s\S]*?)<\/body>/i.exec(indexHtmlSource);
  assert.ok(bodyMatch, "expected <body> section in index.html");
  const bodyHtml = bodyMatch[1];
  const noscriptMatch = /<noscript>([\s\S]*?)<\/noscript>/i.exec(bodyHtml);
  assert.ok(noscriptMatch, "expected <noscript> inside <body>");
  assert.match(noscriptMatch[1], /role="alert"/);
  assert.match(noscriptMatch[1], /JavaScript/i);
});

test("web/public/manifest.webmanifest is valid JSON with standalone display, root start_url, /icon.svg, and /hud shortcut", () => {
  const manifest = JSON.parse(manifestSource) as WebAppManifest;
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.short_name, "HoldUp");
  assert.equal(manifest.theme_color, "#0b0f17");
  assert.equal(manifest.background_color, "#0b0f17");

  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0);
  assert.ok(
    manifest.icons.some((icon) => icon.src === "/icon.svg" && icon.type === "image/svg+xml"),
    "expected /icon.svg entry in manifest icons"
  );

  assert.ok(Array.isArray(manifest.shortcuts) && manifest.shortcuts.length > 0);
  const hudShortcut = manifest.shortcuts.find((shortcut) => shortcut.url === "/hud");
  assert.ok(hudShortcut, "expected /hud shortcut in manifest.webmanifest");
  assert.ok(
    Array.isArray(hudShortcut.icons) && hudShortcut.icons.some((icon) => icon.src === "/icon.svg")
  );
});

test("web/public/.well-known/meta-wearables-manifest.json is valid JSON targeting /hud on OLED black with /icon.svg", () => {
  const manifest = JSON.parse(wearablesManifestSource) as WebAppManifest;
  assert.equal(manifest.start_url, "/hud");
  assert.equal(manifest.background_color, "#000000");
  assert.equal(manifest.theme_color, "#000000");
  assert.equal(manifest.display, "standalone");

  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0);
  assert.ok(
    manifest.icons.some((icon) => icon.src === "/icon.svg" && icon.type === "image/svg+xml"),
    "expected /icon.svg entry in meta-wearables-manifest.json"
  );
});

test("web/public/icon.svg is valid self-contained SVG with viewBox 0 0 512 512", () => {
  const trimmed = iconSvgSource.trim();
  assert.ok(trimmed.startsWith("<svg "), "icon.svg must start with <svg>");
  assert.ok(trimmed.endsWith("</svg>"), "icon.svg must close with </svg>");
  assert.ok(trimmed.includes('xmlns="http:\x2f\x2fwww.w3.org/2000/svg"'));
  assert.ok(trimmed.includes('viewBox="0 0 512 512"'));
  assert.ok(trimmed.includes('width="512"'));
  assert.ok(trimmed.includes('height="512"'));
  assert.equal(trimmed.includes("<!--"), false);
  assert.equal(/<script\b/i.test(trimmed), false);
});

test("web/public/sw.js installs shell, prunes old caches, and serves navigation and static assets with offline fallback", async () => {
  let networkOnline = true;
  let assetVersion = 1;

  const harness = createSwHarness({
    onFetch: async (req) => {
      if (!networkOnline) {
        throw new Error("Simulated network offline");
      }
      const parsed = new URL(req.url);
      if (parsed.pathname === "/" || parsed.pathname === "/index.html" || parsed.pathname === "/hud") {
        return new Response(`<!doctype html><title>Shell v${assetVersion}</title>`, {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }
      if (parsed.pathname === "/assets/index.js") {
        return new Response(`console.log("v${assetVersion}");`, {
          status: 200,
          headers: { "Content-Type": "application/javascript" }
        });
      }
      return new Response(`static:${parsed.pathname}:v${assetVersion}`, {
        status: 200,
        headers: { "Content-Type": "image/svg+xml" }
      });
    }
  });

  harness.openBucket("holdup-shell-legacy-v0").set(
    normalizeCacheKey("/legacy.js"),
    new Response("legacy", { status: 200 })
  );

  await harness.dispatchLifecycle("install");
  assert.equal(harness.getSkipWaitingCount(), 1);
  assert.ok(harness.stores.has("holdup-shell-v1"));

  const shellBucket = harness.openBucket("holdup-shell-v1");
  for (const shellPath of ["/", "/index.html", "/manifest.webmanifest", "/icon.svg"]) {
    assert.ok(
      shellBucket.has(normalizeCacheKey(shellPath)),
      `expected ${shellPath} to be precached on install`
    );
  }

  await harness.dispatchLifecycle("activate");
  assert.equal(harness.getClientsClaimCount(), 1);
  assert.equal(harness.stores.has("holdup-shell-legacy-v0"), false);
  assert.equal(harness.stores.has("holdup-shell-v1"), true);

  const onlineNav = await harness.dispatchFetch(
    makeSwRequest("/hud", { mode: "navigate", destination: "document", accept: "text/html" })
  );
  assert.equal(onlineNav.intercepted, true);
  assert.ok(onlineNav.response);
  assert.equal(onlineNav.response.status, 200);
  assert.match(await onlineNav.response.text(), /Shell v1/);

  networkOnline = false;
  const offlineNav = await harness.dispatchFetch(
    makeSwRequest("/hud", { mode: "navigate", destination: "document", accept: "text/html" })
  );
  assert.equal(offlineNav.intercepted, true);
  assert.ok(offlineNav.response);
  assert.equal(offlineNav.response.status, 200);
  assert.match(await offlineNav.response.text(), /Shell v1/);

  networkOnline = true;
  const firstAsset = await harness.dispatchFetch(
    makeSwRequest("/assets/index.js", { destination: "script" })
  );
  assert.equal(firstAsset.intercepted, true);
  assert.ok(firstAsset.response);
  assert.equal(await firstAsset.response.text(), 'console.log("v1");');

  assetVersion = 2;
  const cachedAsset = await harness.dispatchFetch(
    makeSwRequest("/assets/index.js", { destination: "script" })
  );
  assert.equal(cachedAsset.intercepted, true);
  assert.ok(cachedAsset.response);
  assert.equal(await cachedAsset.response.text(), 'console.log("v1");');

  const refreshedAsset = await harness.dispatchFetch(
    makeSwRequest("/assets/index.js", { destination: "script" })
  );
  assert.ok(refreshedAsset.response);
  assert.equal(await refreshedAsset.response.text(), 'console.log("v2");');
});

test("web/public/sw.js explicitly bypasses API, health, TTS, camera ingest, and WebSocket endpoints without touching caches", async () => {
  const harness = createSwHarness();
  harness.resetTelemetry();

  const bypassedRequests: MockSwRequest[] = [
    makeSwRequest("/api/verify", { method: "POST" }),
    makeSwRequest("/api/verify", { method: "GET" }),
    makeSwRequest("/api/health", { method: "GET" }),
    makeSwRequest("/api/tts", { method: "POST" }),
    makeSwRequest("/api/tts", { method: "GET" }),
    makeSwRequest("/ingest/frame", { method: "POST" }),
    makeSwRequest("/ingest/frame", { method: "GET" }),
    makeSwRequest("/ingest/state", { method: "POST" }),
    makeSwRequest("/ingest/state", { method: "GET" }),
    makeSwRequest("/live", { method: "GET" }),
    makeSwRequest("/live?session=hup-4k9m", { method: "GET" }),
    makeSwRequest("/hud-ws", { method: "GET" }),
    makeSwRequest("/hud-ws?session=hup-4k9m", { method: "GET" }),
    makeSwRequest("/sw.js", { method: "GET" }),
    makeSwRequest("https:\x2f\x2fgenerativelanguage.googleapis.com/v1beta/models", { method: "GET" })
  ];

  for (const req of bypassedRequests) {
    harness.resetTelemetry();
    const outcome = await harness.dispatchFetch(req);
    assert.equal(
      outcome.intercepted,
      false,
      `expected Service Worker not to intercept ${req.method} ${req.url}`
    );
    assert.deepEqual(
      harness.cacheTouches,
      [],
      `expected zero caches access for ${req.method} ${req.url}`
    );
    assert.deepEqual(
      harness.fetchUrls,
      [],
      `expected Service Worker not to proxy fetch for ${req.method} ${req.url}`
    );
  }
});

test("registerServiceWorker does not throw in Node or when navigator.serviceWorker rejects", async () => {
  assert.doesNotThrow(() => {
    registerServiceWorker();
  });

  const g = globalThis as Record<string, unknown>;
  const prevWindow = g.window;
  const prevDocument = g.document;
  const prevNavDesc = Object.getOwnPropertyDescriptor(globalThis, "navigator");

  const registerCalls: Array<{ scriptUrl: string; options: unknown }> = [];

  try {
    g.window = {
      addEventListener: () => {}
    };
    g.document = {
      readyState: "complete"
    };
    Object.defineProperty(globalThis, "navigator", {
      value: {},
      configurable: true,
      writable: true
    });

    assert.doesNotThrow(() => {
      registerServiceWorker();
    });

    Object.defineProperty(globalThis, "navigator", {
      value: {
        serviceWorker: {
          register(scriptUrl: string, options?: unknown) {
            registerCalls.push({ scriptUrl, options });
            return Promise.reject(new Error("ServiceWorker registration rejected"));
          }
        }
      },
      configurable: true,
      writable: true
    });

    assert.doesNotThrow(() => {
      registerServiceWorker();
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 15));

    assert.equal(registerCalls.length, 1);
    assert.equal(registerCalls[0].scriptUrl, "/sw.js");
    assert.deepEqual(registerCalls[0].options, { scope: "/" });

    assert.doesNotThrow(() => {
      registerServiceWorker();
    });
    assert.equal(registerCalls.length, 1);
  } finally {
    if (prevWindow !== undefined) {
      g.window = prevWindow;
    } else {
      delete g.window;
    }
    if (prevDocument !== undefined) {
      g.document = prevDocument;
    } else {
      delete g.document;
    }
    if (prevNavDesc) {
      Object.defineProperty(globalThis, "navigator", prevNavDesc);
    } else {
      delete g.navigator;
    }
  }
});
