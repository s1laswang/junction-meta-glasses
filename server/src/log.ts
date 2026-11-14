const DENY = /^(text|data|transcript|image|frame|frames|audio|profile|speech|headline|question|args|prompt|body|key|apikey|api_key|value)$/i;

export type LogMeta = Record<string, string | number | boolean | null | undefined>;

export function redact(meta: LogMeta = {}): LogMeta {
  const out: LogMeta = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined) continue;
    if (DENY.test(k)) { out[k] = "[redacted]"; continue; }
    if (typeof v === "string") {
      out[k] = v.length > (k === "err" ? 160 : 48) ? `[redacted:${v.length}ch]` : v.replace(/AIza[0-9A-Za-z_-]{10,}/g, "[key]");
    } else out[k] = v;
  }
  return out;
}

export function log(event: string, meta?: LogMeta) {
  if (process.env.HOLDUP_QUIET) return;
  const m = redact(meta);
  const tail = Object.entries(m).map(([k, v]) => `${k}=${v}`).join(" ");
  console.log(`${new Date().toISOString().slice(11, 23)} ${event}${tail ? " " + tail : ""}`);
}

export const shortId = (id: string) => id.slice(0, 8);

export function errSummary(e: unknown): string {
  const s = e instanceof Error ? e.message : String(e);
  return s.replace(/AIza[0-9A-Za-z_-]{10,}/g, "[key]").replace(/\s+/g, " ").slice(0, 160);
}
