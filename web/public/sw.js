const CACHE_NAME = "holdup-shell-v1";
const APP_SHELL = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/icon.svg"
];

function isNeverCachedPath(pathname) {
  return (
    pathname === "/sw.js" ||
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/ingest" ||
    pathname.startsWith("/ingest/") ||
    pathname === "/live" ||
    pathname.startsWith("/live/") ||
    pathname === "/hud-ws" ||
    pathname.startsWith("/hud-ws/") ||
    pathname.startsWith("/@") ||
    pathname.startsWith("/src/") ||
    pathname.startsWith("/node_modules/")
  );
}

function isNavigationRequest(request, pathname) {
  if (request.mode === "navigate" || request.destination === "document") {
    return true;
  }
  if (pathname === "/" || pathname === "/index.html" || pathname === "/hud" || pathname === "/hud/") {
    return true;
  }
  const accept = request.headers.get("accept") || "";
  return accept.includes("text/html");
}

function isCacheableStaticAsset(pathname) {
  if (
    pathname === "/manifest.webmanifest" ||
    pathname === "/icon.svg" ||
    pathname === "/.well-known/meta-wearables-manifest.json"
  ) {
    return true;
  }
  if (pathname.startsWith("/assets/")) {
    return true;
  }
  if (/^\/fixtures\/.+\.(?:jpe?g|png|webp|svg)$/i.test(pathname)) {
    return true;
  }
  return /\.(?:js|mjs|css|svg|png|webp|ico|woff2?|webmanifest)$/i.test(pathname);
}

async function networkFirstNavigation(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("text/html")) {
        await cache.put("/index.html", response.clone());
        const url = new URL(request.url);
        if (url.pathname === "/" || url.pathname === "/hud" || url.pathname === "/hud/") {
          await cache.put(url.pathname, response.clone());
        }
      }
      return response;
    }
    const fallback = (await cache.match("/index.html")) || (await cache.match("/"));
    return fallback || response;
  } catch {
    const fallback = (await cache.match("/index.html")) || (await cache.match("/"));
    if (fallback) {
      return fallback;
    }
    return new Response("Offline", {
      status: 503,
      statusText: "Offline",
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  }
}

async function staleWhileRevalidate(event, request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  const revalidate = fetch(request)
    .then(async (response) => {
      if (response && response.ok && (response.type === "basic" || response.type === "default")) {
        const contentType = response.headers.get("content-type") || "";
        if (!contentType.includes("text/html")) {
          await cache.put(request, response.clone());
        }
      }
      return response;
    })
    .catch(() => undefined);

  if (cached) {
    event.waitUntil(revalidate);
    return cached;
  }

  const fresh = await revalidate;
  if (fresh) {
    return fresh;
  }

  return new Response("Offline", {
    status: 503,
    statusText: "Offline",
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  });
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") {
    return;
  }

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return;
  }

  if (url.origin !== self.location.origin) {
    return;
  }

  if (isNeverCachedPath(url.pathname)) {
    return;
  }

  if (isNavigationRequest(request, url.pathname)) {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  if (isCacheableStaticAsset(url.pathname)) {
    event.respondWith(staleWhileRevalidate(event, request));
  }
});
