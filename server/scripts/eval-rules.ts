// Rules-layer eval (no API key, no network, deterministic): feeds the server's own checkLabel()
// (server/src/safety.ts) with label reads that a perfect or a degraded reader could produce, and counts
// UNSAFE REASSURANCES: a "match" verdict when the world truth says the box is NOT safe to take as-is
// (wrong strength, not on the list, NSAID on the avoid list, allergen, expired, already taken), or when the
// strength was not read confidently. This measures the deterministic safety layer only. Model accuracy
// (confident-wrong reads, calibration) comes from eval/run_eval.py -> docs/EVAL.md.
// Usage (from server/): npx tsx scripts/eval-rules.ts [--json out.json]
import fs from "node:fs";
import type { LabelRead, Profile } from "../../shared/types.ts";
import { checkLabel, STRENGTH_MIN_CONF } from "../src/safety.ts";

const NOW = new Date(2026, 10, 15, 9, 0);
const f = <T>(value: T | null, confidence = 0.95) => ({ value, confidence });
const base = (p: Partial<LabelRead>): LabelRead => ({
  kind: "medication", product: f(null, 0), ingredient: f(null, 0), strength: f(null, 0), dosing: f(null, 0),
  expiry: f("2028-06", 0.9), allergens: f<string[]>(null, 0), barcode: f(null, 0), readability: 0.9, ...p,
});
// Same shape as the demo profile (README: 3 medicines, nut allergies, avoid NSAIDs).
const profile = (taken: string[] = []): Profile => ({
  meds: [
    { id: "aml", name: "Amlodipine", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"] },
    { id: "met", name: "Metformin", ingredient: "metformin", strength: "500 mg", schedule: ["08:00", "20:00"] },
    { id: "ato", name: "Atorvastatin", ingredient: "atorvastatin", strength: "20 mg", schedule: ["evening"] },
  ],
  allergies: ["tree nuts", "peanut"], avoid: ["NSAIDs"],
  doseLog: taken.map((medId) => ({ medId, ts: NOW.getTime() - 3600_000 })), lang: "en",
} as Profile);

type Case = { family: string; read: LabelRead; prof: Profile; safe: boolean; strengthConf: number };
const cases: Case[] = [];
const confs = [0.3, 0.5, 0.7, 0.79, 0.8, 0.85, 0.9, 0.95, 0.99];
const meds = [["amlodipine", "5 mg", ["2.5 mg", "10 mg"], "aml"], ["metformin", "500 mg", ["850 mg", "1000 mg"], "met"], ["atorvastatin", "20 mg", ["10 mg", "40 mg"], "ato"]] as const;
for (const [ing, good, wrong, id] of meds) {
  for (const c of confs) {
    // correct box, nothing taken: safe only if the strength was read confidently
    cases.push({ family: "correct_box", read: base({ ingredient: f(ing), strength: f(good, c) }), prof: profile(), safe: true, strengthConf: c });
    for (const w of wrong) cases.push({ family: "wrong_strength", read: base({ ingredient: f(ing), strength: f(w, c) }), prof: profile(), safe: false, strengthConf: c });
    cases.push({ family: "strength_missing", read: base({ ingredient: f(ing), strength: f<string>(null, c * 0.2) }), prof: profile(), safe: false, strengthConf: c * 0.2 });
    cases.push({ family: "expired", read: base({ ingredient: f(ing), strength: f(good, c), expiry: f("2024-11", 0.9) }), prof: profile(), safe: false, strengthConf: c });
    cases.push({ family: "already_taken", read: base({ ingredient: f(ing), strength: f(good, c) }), prof: profile(id === "met" ? ["met", "met"] : [id]), safe: false, strengthConf: c });
  }
}
for (const c of confs) {
  for (const [p, i, s] of [["Burana", "ibuprofen", "400 mg"], ["Aspirin", "acetylsalicylic acid", "500 mg"], ["Naprometin", "naproxen", "250 mg"]])
    cases.push({ family: "nsaid_avoid", read: base({ product: f(p), ingredient: f(i), strength: f(s, c) }), prof: profile(), safe: false, strengthConf: c });
  cases.push({ family: "not_on_list", read: base({ product: f("Panadol"), ingredient: f("paracetamol"), strength: f("500 mg", c) }), prof: profile(), safe: false, strengthConf: c });
  cases.push({ family: "food_allergen", read: base({ kind: "food", product: f("Hazelnut bar"), allergens: f(["hazelnut"], c) }), prof: profile(), safe: false, strengthConf: c });
  cases.push({ family: "unreadable", read: base({ kind: "unreadable", readability: 0.1 }), prof: profile(), safe: false, strengthConf: 0 });
}

const by: Record<string, { n: number; match: number; unsafe: number; unsure: number; warning: number }> = {};
const unsafeEx: unknown[] = [];
let unsafe = 0, correctMatch = 0, correctEligible = 0;
for (const k of cases) {
  const v = checkLabel(k.read, k.prof, NOW);
  const b = (by[k.family] ??= { n: 0, match: 0, unsafe: 0, unsure: 0, warning: 0 });
  b.n++; if (v.level === "match") b.match++; if (v.level === "unsure") b.unsure++; if (v.level === "warning") b.warning++;
  const reassuring = v.level === "match";
  const shouldBeSafe = k.safe && k.strengthConf >= STRENGTH_MIN_CONF;
  if (reassuring && !shouldBeSafe) { unsafe++; b.unsafe++; if (unsafeEx.length < 10) unsafeEx.push({ family: k.family, conf: k.strengthConf, speech: v.speech }); }
  if (shouldBeSafe) { correctEligible++; if (reassuring) correctMatch++; }
}
const out = { n: cases.length, unsafe_reassurance: unsafe, unsafe_reassurance_rate: unsafe / cases.length,
  match_recall_on_safe_confident: correctEligible ? correctMatch / correctEligible : null, by_family: by, unsafe_examples: unsafeEx,
  strength_min_conf: STRENGTH_MIN_CONF, impl: "server/src/safety.ts checkLabel", now: NOW.toISOString() };
console.log(`rules eval: ${out.n} cases, unsafe reassurances ${unsafe} (${(100 * out.unsafe_reassurance_rate).toFixed(1)}%), ` +
  `match recall on safe+confident reads ${(100 * (out.match_recall_on_safe_confident ?? 0)).toFixed(1)}% (${correctMatch}/${correctEligible})`);
for (const [k, b] of Object.entries(by)) console.log(`  ${k.padEnd(17)} n=${String(b.n).padStart(3)} match=${b.match} warning=${b.warning} unsure=${b.unsure} unsafe=${b.unsafe}`);
for (const e of unsafeEx) console.log("  UNSAFE:", JSON.stringify(e));
const j = process.argv.indexOf("--json");
if (j > 0 && process.argv[j + 1]) fs.writeFileSync(process.argv[j + 1], JSON.stringify(out, null, 2));
process.exitCode = unsafe === 0 ? 0 : 1;
