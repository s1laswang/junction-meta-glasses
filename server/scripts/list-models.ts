import http from "node:http";
import https from "node:https";
import { env } from "../src/env.ts";
import { ai } from "../src/gemini.ts";
import { errSummary } from "../src/log.ts";

const hasNativeEnvProxy = typeof (http as unknown as { setGlobalProxyFromEnv?: unknown }).setGlobalProxyFromEnv === "function";
const hasProxyEnv = Boolean(
  process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy,
);

if (!hasNativeEnvProxy && hasProxyEnv) {
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).forEach((v, k) => {
      headers[k] = v;
    });
    const mod = url.protocol === "https:" ? https : http;
    return await new Promise<Response>((resolve, reject) => {
      const req = mod.request(
        url,
        { method: init?.method ?? (input instanceof Request ? input.method : "GET"), headers },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
          res.on("end", () => {
            const respHeaders = new Headers();
            for (const [k, v] of Object.entries(res.headers)) {
              if (Array.isArray(v)) respHeaders.set(k, v.join(", "));
              else if (v !== undefined) respHeaders.set(k, v);
            }
            resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 500, statusText: res.statusMessage ?? "", headers: respHeaders }));
          });
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      if (typeof init?.body === "string" || Buffer.isBuffer(init?.body) || init?.body instanceof Uint8Array) {
        req.write(init.body);
      }
      req.end();
    });
  };
}

console.log("key present:", env.apiKey.length > 0);
const re = new RegExp(process.argv[2] ?? "live|native-audio|3\\.8|tts|3-flash|3\\.1|2\\.5-flash$");
try {
  const pager = await ai.models.list({ config: { pageSize: 1000 } });
  for await (const m of pager) {
    if (m.name && re.test(m.name)) {
      console.log(m.name, (m.supportedActions ?? []).join(","));
    }
  }
  process.exit(0);
} catch (e) {
  console.error("error:", errSummary(e));
  process.exit(1);
}
