// HTTP API: health check and snapshot verify. Routed to the in-browser mock with ?mock=1.
import type { Profile, Verdict } from "../../../shared/types.ts";
import { IS_MOCK, mockFetch } from "./mock.ts";
import { AuthError, keyHeaders } from "./key.ts";

export type Health = { ok: boolean; gemini: "ok" | "down"; models?: Record<string, string>; version?: string };

async function getJson<T>(path: string, init?: RequestInit, timeoutMs = 8000): Promise<T> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(path, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), ...keyHeaders() }, signal: ctl.signal, cache: "no-store" });
    if (res.status === 401 || res.status === 403) throw new AuthError();
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

/**
 * Snapshot verify. With frames: those frames. Without frames (glasses camera): the server uses the
 * recent frames it holds for `session` (bridge frames never reach the phone).
 */
export async function verify(frames: string[], profile: Profile, opts: { question?: string; session?: string } = {}): Promise<Verdict> {
  const body = { ...(frames.length ? { frames } : {}), session: opts.session, profile, question: opts.question };
  if (IS_MOCK) return (await mockFetch("/api/verify", body)) as Verdict;
  return getJson<Verdict>("/api/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, 20000);
}
