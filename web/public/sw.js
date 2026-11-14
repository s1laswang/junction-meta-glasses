// HoldUp service worker: caches the app shell so the app (and its offline barcode mode) loads without a network.
// Never caches API calls, sockets, frames or anything user-specific.
const CACHE = "holdup-shell-v2"; // v2: + pre-rendered ElevenLabs phrases (/phrases/)
const SHELL = ["/", "/index.html", "/hud/", "/manifest.webmanifest", "/pcm-capture-worklet.js", "/icons/icon.svg", "/icons/icon-192.png", "/icons/icon-512.png"];
const NEVER = /^\/(api|live|hud-ws|ingest)(\/|$|\?)/;

async function precache() {
  const cache = await caches.open(CACHE);
  await Promise.all(SHELL.map((u) => cache.add(new Request(u, { cache: "reload" })).catch(() => {})));
  // pull in the hashed JS/CSS/font assets referenced by the HTML entry points
  // offline voice: pre-rendered phrases (server/scripts/prerender-phrases.ts); absent manifest = browser voice only
  try {
    const m = await (await fetch("/phrases/manifest.json", { cache: "reload" })).json();
    const files = Object.values(m.phrases ?? {}).flatMap((byId) => Object.values(byId).map((p) => p.file));
    await Promise.all(["/phrases/manifest.json", ...files].map((u) => cache.add(u).catch(() => {})));
  } catch {
    /* no phrases rendered */
  }
  for (const page of ["/", "/hud/"]) {
    try {
      const html = await (await fetch(page, { cache: "reload" })).text();
      const urls = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
      await Promise.all(urls.map((u) => cache.add(u).catch(() => {})));
    } catch {
      /* offline during install: runtime caching fills in later */
    }
  }
}

self.addEventListener("install", (e) => {
  e.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || NEVER.test(url.pathname)) return;

  // pages: network first (fresh deploys), cached shell when offline
  if (req.mode === "navigate") {
    const shell = url.pathname.startsWith("/hud") ? "/hud/" : "/";
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put(shell, res.clone()));
          return res;
        })
        .catch(async () => (await caches.match(shell)) || (await caches.match("/index.html")) || Response.error()),
    );
    return;
  }

  // static assets: cache first, then network (hashed file names make this safe)
  e.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok && (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icons/") || url.pathname.startsWith("/phrases/"))) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
