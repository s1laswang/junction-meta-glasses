// HTTP API: health check and snapshot verify. Routed to the in-browser mock with ?mock=1.
import type { Profile, Verdict } from "../../../shared/types.ts";
import { IS_MOCK, mockFetch } from "./mock.ts";

export type Health = { ok: boolean; gemini: "ok" | "down"; models?: Record<string, string>; version?: string };

async function getJson<T>(path: string, init?: RequestInit, timeoutMs = 8000): Promise<T> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(path, { ...init, signal: ctl.signal, cache: "no-store" });
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      try {
        const j = await res.json();
        if (j?.message) msg = j.message;
      } catch {
        /* ignore */
      }
      throw new Error(msg);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

export async function health(): Promise<Health> {
  if (IS_MOCK) return (await mockFetch("/api/health")) as Health;
  return getJson<Health>("/api/health", undefined, 4000);
}

export async function verify(frames: string[], profile: Profile, question?: string): Promise<Verdict> {
  const body = { frames, profile, question };
  if (IS_MOCK) return (await mockFetch("/api/verify", body)) as Verdict;
  return getJson<Verdict>("/api/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, 20000);
}
