// Hardware-proof probe: reads /api/health and /api/stats from a running HoldUp server and appends one
// Markdown row to docs/HARDWARE_LOG.md (and prints it). No secrets are written: the access key is read
// from HOLDUP_KEY and sent as ?key=, never logged.
// Usage: npm -w server run hw:probe -- --base https://<tunnel> --label "H4 coach->match"
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../src/env.ts";

const arg = (k: string, d = "") => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] ?? d : d; };
const base = (arg("base", `http://localhost:${process.env.PORT ?? 8787}`)).replace(/\/$/, "");
const label = arg("label", "probe").replace(/\|/g, "/");
const key = process.env.HOLDUP_KEY ? `?key=${encodeURIComponent(process.env.HOLDUP_KEY)}` : "";

async function get(p: string): Promise<any> {
  const r = await fetch(`${base}${p}${key}`);
  if (!r.ok) throw new Error(`${p} -> HTTP ${r.status}`);
  return r.json();
}

const fmt = (x: unknown) => (typeof x === "number" ? x.toFixed(2) : "–");
const pick = (o: any, ...ks: string[]) => ks.map((k) => o?.[k]).find((v) => v !== undefined);

const health = await get("/api/health");
let st: any = {};
try { st = await get("/api/stats"); } catch (e) { console.error(`stats unavailable: ${(e as Error).message}`); }
const live = st.features?.live ?? {};
const ver = pick(st.features ?? {}, "verify", "verify_label") ?? {};
const g = health.glasses ?? {};
const dev = g.device ?? {};
const sessions = health.sessions ?? "–";
const latest = health.latest ?? "–";
const now = new Date().toLocaleString("sv-SE", { timeZone: "Europe/Helsinki" });
const row = `| ${now} | ${label} | ${health.gemini ?? "?"} | ${typeof sessions === "object" ? JSON.stringify(sessions) : sessions} / ${latest} | ` +
  `${g.source ?? "–"}: ${dev.connected ?? "–"}, ${dev.worn ?? "–"}, ${dev.streaming ?? "–"}, ${dev.battery ?? "–"}; frames ${g.framesAccepted ?? "–"} (last ${g.lastFrameAgoS ?? "–"} s ago) | ` +
  `${fmt(live.first_audio_p50_s)} / ${fmt(live.first_audio_p95_s)} | ${fmt(ver.latency_p50_s)} / ${fmt(ver.latency_p95_s)} |`;
console.log(row);
if (!process.argv.includes("--no-write")) {
  const f = path.join(REPO_ROOT, "docs", "HARDWARE_LOG.md");
  fs.appendFileSync(f, row + "\n");
  console.error(`appended to ${path.relative(REPO_ROOT, f)}`);
}
if (process.argv.includes("--raw")) console.error(JSON.stringify({ health, features: Object.keys(st.features ?? {}) }, null, 2));
