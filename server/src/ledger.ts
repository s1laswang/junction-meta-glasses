// Usage ledger: one JSON line per Gemini call (metadata only, never content) + /api/stats aggregation.
import fs from "node:fs";
import path from "node:path";
import { env } from "./env.ts";

export type LedgerLine = {
  ts: number; feature: string; model: string;
  in?: number; out?: number; thinking?: number; cached?: number;
  latency_s: number; ok: boolean; [k: string]: unknown;
};

let dirReady = false;
export function ledger(line: Omit<LedgerLine, "ts"> & { ts?: number }) {
  const row = { ts: Date.now(), ...line };
  try {
    if (!dirReady) { fs.mkdirSync(path.dirname(env.ledgerPath), { recursive: true }); dirReady = true; }
    fs.appendFile(env.ledgerPath, JSON.stringify(row) + "\n", () => {});
  } catch { /* ledger must never break the product */ }
}

/** Pull token counts from a generateContent usageMetadata (shape-tolerant). */
export function usage(u: any) {
  return {
    in: u?.promptTokenCount ?? 0,
    out: u?.candidatesTokenCount ?? u?.responseTokenCount ?? 0,
    thinking: u?.thoughtsTokenCount ?? 0,
    cached: u?.cachedContentTokenCount ?? 0,
  };
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(3);
};

export function stats() {
  let lines: LedgerLine[] = [];
  try {
    lines = fs.readFileSync(env.ledgerPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch { /* empty */ }
  const by: Record<string, LedgerLine[]> = {};
  for (const l of lines) (by[l.feature] ??= []).push(l);
  const features: Record<string, unknown> = {};
  for (const [f, ls] of Object.entries(by)) {
    const ok = ls.filter((l) => l.ok);
    const lat = ok.map((l) => l.latency_s);
    const models: Record<string, number> = {};
    for (const l of ls) models[l.model] = (models[l.model] ?? 0) + 1;
    const extra: Record<string, unknown> = {};
    if (f === "live") {
      const fa = ok.map((l) => l.first_audio_s as number).filter((x) => typeof x === "number");
      const tl = ok.flatMap((l) => (l.tool_latencies_s as number[]) ?? []);
      extra.first_audio_p50_s = pct(fa, 50); extra.first_audio_p95_s = pct(fa, 95);
      extra.tool_p50_s = pct(tl, 50); extra.tool_p95_s = pct(tl, 95);
      extra.tool_calls = ok.reduce((a, l) => a + ((l.tool_calls as number) ?? 0), 0);
    }
    features[f] = {
      calls: ls.length, ok: ok.length, errors: ls.length - ok.length,
      latency_p50_s: pct(lat, 50), latency_p95_s: pct(lat, 95),
      tokens_in: ls.reduce((a, l) => a + (l.in ?? 0), 0),
      tokens_out: ls.reduce((a, l) => a + (l.out ?? 0), 0),
      tokens_thinking: ls.reduce((a, l) => a + (l.thinking ?? 0), 0),
      models, ...extra,
    };
  }
  return { since: lines[0]?.ts ?? null, total: lines.length, features };
}
