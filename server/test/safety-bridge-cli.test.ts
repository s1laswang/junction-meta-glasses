import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Gs1Code, LabelRead, Profile } from "../../shared/types.ts";
import { REPO_ROOT, SERVER_DIR } from "../src/env.ts";

const BRIDGE = path.join(REPO_ROOT, "eval", "safety_bridge.mts");
const SAFETY_TS = path.join(SERVER_DIR, "src", "safety.ts");
const f = <T>(value: T | null, confidence = 0.95) => ({ value, confidence });

function mkRead(partial: Partial<LabelRead>): LabelRead {
  return {
    kind: "medication",
    product: f(null, 0),
    ingredient: f(null, 0),
    strength: f(null, 0),
    dosing: f(null, 0),
    expiry: f("2027-08"),
    allergens: f<string[]>(null, 0),
    barcode: f(null, 0),
    readability: 0.92,
    ...partial,
  };
}

const profile: Profile = {
  meds: [{ id: "aml", name: "Norvasc", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"] }],
  allergies: ["peanut"],
  avoid: ["NSAIDs"],
  doseLog: [],
  lang: "en",
};

test("safety_bridge.mts exits with code 2 when HOLDUP_SAFETY_TS is missing", () => {
  const env = { ...process.env };
  delete env.HOLDUP_SAFETY_TS;
  const res = spawnSync(process.execPath, ["--import", "tsx", BRIDGE], { input: "", env, encoding: "utf8" });
  assert.equal(res.status, 2);
});

test("safety_bridge.mts evaluates batch JSONL cases deterministically against safety.ts", () => {
  const cases = [
    { read: mkRead({ ingredient: f("amlodipine"), strength: f("5 mg") }), profile, now: "2026-11-14T20:00:00+02:00" },
    { read: mkRead({ ingredient: f("ibuprofen"), strength: f("400 mg") }), profile, now: "2026-11-14T20:00:00+02:00" },
    { read: mkRead({ ingredient: f("amlodipine"), strength: f("5 mg", 0.55) }), profile, now: "2026-11-14T20:00:00+02:00" },
    { read: mkRead({ kind: "food", product: f("Peanut bar"), allergens: f(["roasted peanuts"]) }), profile, now: "2026-11-14T20:00:00+02:00" },
  ];
  const input = cases.map((c) => JSON.stringify(c)).join("\n\n") + "\n";
  const stdout = execFileSync(process.execPath, ["--import", "tsx", BRIDGE], {
    input,
    env: { ...process.env, HOLDUP_SAFETY_TS: SAFETY_TS },
    encoding: "utf8",
  });
  const rows = stdout.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.length, 4);
  assert.equal(rows[0].level, "match");
  assert.equal(rows[0].matchedMedId, "aml");
  assert.equal(rows[1].level, "warning");
  assert.equal(rows[1].matchedMedId, null);
  assert.ok(rows[1].reasons.some((r: string) => r.includes("NSAID")));
  assert.equal(rows[2].level, "unsure");
  assert.equal(rows[3].level, "warning");
});

test("safety_bridge.mts cross-checks Gs1Code DataMatrix payloads and omits crossCheck when code is absent", () => {
  const dmProfile: Profile = {
    ...profile,
    meds: [{ id: "aml", name: "Norvasc", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"], gtin: "06432100012345" }],
  };
  const agreeCode: Gs1Code = { raw: "(01)06432100012345(17)270800", gtin: "06432100012345", expiry: "2027-08" };
  const expiredCode: Gs1Code = { raw: "(01)06432100012345(17)250500", gtin: "06432100012345", expiry: "2025-05" };
  const conflictCode: Gs1Code = { raw: "(01)06432100012345(17)280300", gtin: "06432100012345", expiry: "2028-03" };
  const cases = [
    { read: mkRead({ ingredient: f("amlodipine"), strength: f("5 mg"), expiry: f("2027-08") }), profile: dmProfile, now: "2026-11-14T20:00:00+02:00", code: agreeCode },
    { read: mkRead({ ingredient: f("amlodipine"), strength: f("5 mg"), expiry: f(null, 0) }), profile: dmProfile, now: "2026-11-14T20:00:00+02:00", code: expiredCode },
    { read: mkRead({ ingredient: f("amlodipine"), strength: f("5 mg"), expiry: f("2027-08") }), profile: dmProfile, now: "2026-11-14T20:00:00+02:00", code: conflictCode },
    { read: mkRead({ ingredient: f("amlodipine"), strength: f("5 mg"), expiry: f("2027-08") }), profile: dmProfile, now: "2026-11-14T20:00:00+02:00" },
  ];
  const input = cases.map((c) => JSON.stringify(c)).join("\n") + "\n";
  const stdout = execFileSync(process.execPath, ["--import", "tsx", BRIDGE], {
    input,
    env: { ...process.env, HOLDUP_SAFETY_TS: SAFETY_TS },
    encoding: "utf8",
  });
  const rows = stdout.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.length, 4);
  assert.equal(rows[0].level, "match");
  assert.equal(rows[0].matchedMedId, "aml");
  assert.equal(rows[0].crossCheck.source, "datamatrix");
  assert.equal(rows[0].crossCheck.agrees, true);
  assert.equal(rows[1].level, "warning");
  assert.ok(rows[1].reasons.some((r: string) => r.includes("2025-05")));
  assert.equal(rows[1].crossCheck.source, "datamatrix");
  assert.equal(rows[2].level, "unsure");
  assert.equal(rows[2].crossCheck.agrees, false);
  assert.equal("crossCheck" in rows[3], false);
});
