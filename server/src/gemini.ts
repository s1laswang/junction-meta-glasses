import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { GoogleGenAI } from "@google/genai";
import { HttpsProxyAgent } from "https-proxy-agent";
import { env } from "./env.ts";

function splitHostPort(raw: string): { host: string; port: string } {
  const s = raw.trim().toLowerCase();
  if (!s) return { host: "", port: "" };
  if (s.startsWith("[")) {
    const end = s.indexOf("]");
    if (end === -1) return { host: s, port: "" };
    const rest = s.slice(end + 1);
    return { host: s.slice(1, end), port: rest.startsWith(":") ? rest.slice(1) : "" };
  }
  const first = s.indexOf(":");
  const last = s.lastIndexOf(":");
  if (first !== -1 && first === last) {
    return { host: s.slice(0, first).replace(/\.$/, ""), port: s.slice(first + 1) };
  }
  return { host: s.replace(/\.$/, ""), port: "" };
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const oct = Number(p);
    if (oct < 0 || oct > 255) return null;
    n = ((n << 8) | oct) >>> 0;
  }
  return n;
}

export function shouldBypassProxy(host: string, noProxy?: string): boolean {
  const { host: h, port: hPort } = splitHostPort(host);
  if (!h || h === "localhost" || h.endsWith(".localhost") || h === "127.0.0.1" || h === "::1") {
    return true;
  }
  const rawList = noProxy ?? process.env.NO_PROXY ?? process.env.no_proxy ?? "";
  for (const token of rawList.split(/[,\s]+/)) {
    const item = token.trim().toLowerCase();
    if (!item) continue;
    if (item === "*") return true;
    if (item.includes("/")) {
      const [netStr, bitsStr] = item.split("/");
      const hostIp = ipv4ToInt(h);
      const netIp = ipv4ToInt(netStr);
      const bits = Number(bitsStr);
      if (hostIp !== null && netIp !== null && Number.isInteger(bits) && bits >= 0 && bits <= 32) {
        const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
        if (((hostIp & mask) >>> 0) === ((netIp & mask) >>> 0)) return true;
      }
      continue;
    }
    const { host: eHost, port: ePort } = splitHostPort(item);
    if (ePort && hPort && ePort !== hPort) continue;
    if (ePort && !hPort) continue;
    const domain = eHost.replace(/^\*?\./, "");
    if (!domain) continue;
    if (h === domain || h.endsWith(`.${domain}`)) return true;
  }
  return false;
}

export class ProxyAwareHttpsAgent extends https.Agent {
  readonly proxyAgent: HttpsProxyAgent<string>;
  readonly directAgent: https.Agent;

  constructor(proxyUrl: string, options?: https.AgentOptions) {
    super(options);
    this.proxyAgent = new HttpsProxyAgent(proxyUrl, options);
    this.directAgent = new https.Agent(options);
  }

  addRequest(req: http.ClientRequest, options: https.RequestOptions, ...rest: unknown[]): void {
    const rawHost = String(options?.hostname || options?.host || "");
    if (shouldBypassProxy(rawHost)) {
      (this.directAgent as any).addRequest(req, options, ...rest);
      return;
    }
    (this.proxyAgent as any).addRequest(req, { ...options, secureEndpoint: true }, ...rest);
  }

  override destroy(): void {
    this.directAgent.destroy();
    this.proxyAgent.destroy();
    super.destroy();
  }
}

const proxyUrl = (
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy ||
  ""
).trim();

if (proxyUrl) {
  process.env.NODE_USE_ENV_PROXY ??= "1";
  if (URL.canParse(proxyUrl)) {
    const mergedNoProxy = ["localhost", "127.0.0.1", "::1", process.env.NO_PROXY, process.env.no_proxy]
      .filter(Boolean)
      .join(",");
    (http as any).setGlobalProxyFromEnv?.({ ...process.env, NO_PROXY: mergedNoProxy, no_proxy: mergedNoProxy });
    https.globalAgent = new ProxyAwareHttpsAgent(proxyUrl);
    const origRequest = https.request.bind(https);
    (https as any).request = (...args: any[]) => {
      const first = args[0];
      if (
        first &&
        typeof first === "object" &&
        !(first instanceof URL) &&
        first.agent === undefined &&
        typeof first.createConnection === "function" &&
        first.createConnection.name === "tlsConnect"
      ) {
        args[0] = { ...first, agent: https.globalAgent };
      }
      return (origRequest as any)(...args);
    };
    syncBuiltinESMExports();
  }
}

export const ai = new GoogleGenAI({ apiKey: env.apiKey, httpOptions: { apiVersion: "v1beta" } });

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
export const backoffMs = (attempt: number, base = 500, cap = 8000) =>
  Math.round(Math.random() * Math.min(cap, base * 2 ** attempt));
