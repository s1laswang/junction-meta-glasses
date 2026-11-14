import { GoogleGenAI } from "@google/genai";
import { env } from "./env.ts";

// SDK 3.x defaults to apiVersion "v1", where the Live (BidiGenerateContent) endpoint 404s. v1beta works for all.
export const ai = new GoogleGenAI({ apiKey: env.apiKey, httpOptions: { apiVersion: "v1beta" } });

/** Small semaphore: the key is shared across teams, keep concurrent unary calls capped. */
export class Semaphore {
  private q: (() => void)[] = [];
  constructor(private free: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free--;
    else await new Promise<void>((r) => this.q.push(r));
    try { return await fn(); } finally {
      const next = this.q.shift();
      if (next) next(); else this.free++;
    }
  }
}
export const unaryGate = new Semaphore(Number(process.env.GEMINI_MAX_CONCURRENCY ?? 4));

export type ErrKind = "quota" | "not_found" | "timeout" | "empty" | "bad_request" | "server" | "network";
export function classify(e: unknown): ErrKind {
  const any = e as any;
  const status = any?.status ?? any?.code;
  const msg = String(any?.message ?? e);
  if (any?.name === "AbortError" || /abort|timed? ?out/i.test(msg)) return "timeout";
  if (status === 429 || /429|RESOURCE_EXHAUSTED|quota/i.test(msg)) return "quota";
  if (status === 404 || /\b404\b|NOT_FOUND|no longer available/i.test(msg)) return "not_found";
  if (/empty reply/i.test(msg)) return "empty";
  if (status === 400 || /\b400\b|INVALID_ARGUMENT/i.test(msg)) return "bad_request";
  if (typeof status === "number" && status >= 500) return "server";
  if (/\b5\d\d\b|UNAVAILABLE|INTERNAL/i.test(msg)) return "server";
  return "network";
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Exponential backoff with full jitter. attempt 0 -> up to base ms. */
export const backoffMs = (attempt: number, base = 500, cap = 8000) =>
  Math.round(Math.random() * Math.min(cap, base * 2 ** attempt));
