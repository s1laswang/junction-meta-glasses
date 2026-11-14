// Run verify (read + safety check) on local JPEGs with a demo profile. Usage: tsx scripts/verify-file.ts a.jpg [b.jpg] [-- "question"]
import fs from "node:fs";
import type { Profile } from "../../shared/types.ts";
import { verify } from "../src/verify.ts";

const args = process.argv.slice(2);
const qi = args.indexOf("--");
const files = qi >= 0 ? args.slice(0, qi) : args;
const question = qi >= 0 ? args[qi + 1] : undefined;
const profile: Profile = {
  meds: [{ id: "aml", name: "Amlodipine", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"] }],
  allergies: ["peanut", "tree nuts"], avoid: ["NSAIDs"], doseLog: [], lang: "en",
};
const r = await verify(files.map((f) => fs.readFileSync(f).toString("base64")), profile, question);
const v = r.verdict;
console.log(JSON.stringify({ model: r.model, ms: r.latencyMs, level: v.level, headline: v.headline, speech: v.speech, strength: v.read.strength, product: v.read.product, readability: v.read.readability, guidance: v.read.guidance }));
