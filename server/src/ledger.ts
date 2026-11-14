import fs from "node:fs";
import path from "node:path";
import { env } from "./env.ts";

export type LedgerLine = {
  ts: number; feature: string; model: string;
  in?: number; out?: number; thinking?: number; cached?: number;
  latency_s: number; ok: boolean; [k: string]: unknown;
};

export function ledger(line: Omit<LedgerLine, "ts"> & { ts?: number }, filePath = env.ledgerPath) {
  const row = { ...line, ts: line.ts ?? Date.now() };
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(row) + "\n");
  } catch {}
}

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

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function isLedgerLine(v: unknown): v is LedgerLine {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.ts === "number" && Number.isFinite(r.ts) &&
    typeof r.feature === "string" && r.feature.length > 0 &&
    typeof r.model === "string" &&
    typeof r.latency_s === "number" && Number.isFinite(r.latency_s) &&
    typeof r.ok === "boolean"
  );
}

export function stats(filePath = env.ledgerPath) {
  const lines: LedgerLine[] = [];
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    for (const entry of raw.split("\n")) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isLedgerLine(parsed)) lines.push(parsed);
      } catch {}
    }
  } catch {}
  const by = new Map<string, LedgerLine[]>();
  for (const l of lines) {
    const group = by.get(l.feature);
    if (group) group.push(l);
    else by.set(l.feature, [l]);
  }
  const features: Record<string, unknown> = {};
  for (const [f, ls] of by.entries()) {
    const ok = ls.filter((l) => l.ok);
    const lat = ok.map((l) => l.latency_s);
    const models: Record<string, number> = {};
    for (const l of ls) models[l.model] = (Object.hasOwn(models, l.model) ? models[l.model] : 0) + 1;
    const extra: Record<string, unknown> = {};
    if (f === "live") {
      const fa = ok.map((l) => l.first_audio_s).filter((x): x is number => typeof x === "number" && Number.isFinite(x));
      const tl = ok
        .flatMap((l) => (Array.isArray(l.tool_latencies_s) ? l.tool_latencies_s : []))
        .filter((x): x is number => typeof x === "number" && Number.isFinite(x));
      extra.first_audio_p50_s = pct(fa, 50); extra.first_audio_p95_s = pct(fa, 95);
      extra.tool_p50_s = pct(tl, 50); extra.tool_p95_s = pct(tl, 95);
      extra.tool_calls = ok.reduce((a, l) => a + num(l.tool_calls), 0);
    }
    features[f] = {
      calls: ls.length, ok: ok.length, errors: ls.length - ok.length,
      latency_p50_s: pct(lat, 50), latency_p95_s: pct(lat, 95),
      tokens_in: ls.reduce((a, l) => a + num(l.in), 0),
      tokens_out: ls.reduce((a, l) => a + num(l.out), 0),
      tokens_thinking: ls.reduce((a, l) => a + num(l.thinking), 0),
      models, ...extra,
    };
  }
  return { since: lines[0]?.ts ?? null, total: lines.length, features };
}
