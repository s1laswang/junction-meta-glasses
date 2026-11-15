import { GoogleGenAI } from "@google/genai";
import { env } from "./env.ts";

// SDK 3.x defaults to apiVersion "v1", where the Live (BidiGenerateContent) endpoint 404s. v1beta works for all.
export const ai = new GoogleGenAI({ apiKey: env.apiKey, httpOptions: { apiVersion: "v1beta" } });

/** Small semaphore: the key is shared across teams, keep concurrent unary calls capped. */
export class Semaphore {
  private q: (() => void)[] = [];
  private free: number;
  constructor(free: number) {
    this.free = Number.isFinite(free) && Math.floor(free) >= 1 ? Math.floor(free) : 1;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free--;
    else await new Promise<void>((r) => this.q.push(r));
    try { return await fn(); } finally {
      const next = this.q.shift();
      if (next) next(); else this.free++;
    }
  }
}
const rawMaxConc = process.env.GEMINI_MAX_CONCURRENCY?.trim();
const parsedMaxConc = rawMaxConc ? Number(rawMaxConc) : Number.NaN;
export const unaryGate = new Semaphore(
  Number.isFinite(parsedMaxConc) && Math.floor(parsedMaxConc) >= 1 ? Math.floor(parsedMaxConc) : 4,
);

export type ErrKind = "quota" | "not_found" | "timeout" | "empty" | "bad_request" | "server" | "network";
export function classify(e: unknown): ErrKind {
  const any = e as any;
  const status = any?.status ?? any?.code ?? any?.cause?.status ?? any?.cause?.code;
  const code = String(any?.code ?? any?.cause?.code ?? "");
  const msg = `${String(any?.message ?? e)} ${String(any?.cause?.message ?? "")}`;
  if (
    any?.name === "AbortError" ||
    any?.cause?.name === "AbortError" ||
    status === 408 ||
    /^(ETIMEDOUT|ECONNABORTED|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)$/i.test(code) ||
    /\b408\b|abort|timed? ?out|ETIMEDOUT|ECONNABORTED|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT/i.test(msg)
  ) return "timeout";
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
