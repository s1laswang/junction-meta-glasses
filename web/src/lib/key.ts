// Optional access key (server env HOLDUP_KEY). Read once from ?key=, kept in localStorage, sent as
// the x-holdup-key header on HTTP and as ?key= on WebSockets (browsers can't set WS headers).
const STORE = "holdup.key";

export class AuthError extends Error {
  constructor() {
    super("Access key needed");
    this.name = "AuthError";
  }
}

let cached: string | null | undefined;

export function accessKey(): string | null {
  if (cached !== undefined) return cached;
  try {
    const params = new URLSearchParams(location.search);
    const fromUrl = params.get("key");
    if (fromUrl) {
      localStorage.setItem(STORE, fromUrl);
      // don't leave the key in the address bar, history or screenshots
      params.delete("key");
      const qs = params.toString();
      history.replaceState(history.state, "", location.pathname + (qs ? `?${qs}` : "") + location.hash);
    }
    cached = fromUrl || localStorage.getItem(STORE);
  } catch {
    cached = null;
  }
  return cached;
}

export function setAccessKey(k: string) {
  cached = k.trim() || null;
  try {
    if (cached) localStorage.setItem(STORE, cached);
    else localStorage.removeItem(STORE);
  } catch {
    /* ignore */
  }
}

export function clearAccessKey() {
  cached = null;
  try {
    localStorage.removeItem(STORE);
  } catch {}
}

export function keyHeaders(): Record<string, string> {
  const k = accessKey();
  return k ? { "x-holdup-key": k } : {};
}

/** Append ?key= to a ws:// or relative URL when a key is set. */
export function withKey(url: string): string {
  const k = accessKey();
  if (!k) return url;
  return url + (url.includes("?") ? "&" : "?") + "key=" + encodeURIComponent(k);
}
