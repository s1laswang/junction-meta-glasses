// Run scene mode on a local JPEG: tsx scripts/find-file.ts fixtures/three_boxes.jpg "which one is my evening pill?"
import fs from "node:fs";
import type { Profile } from "../../shared/types.ts";
import { findItems } from "../src/find.ts";

const [file, target] = process.argv.slice(2);
const profile: Profile = {
  meds: [
    { id: "aml", name: "Amlodipine", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"] },
    { id: "par", name: "Panadol", ingredient: "paracetamol", strength: "500 mg", schedule: ["as needed"] },
  ],
  allergies: ["peanut", "tree nuts"], avoid: ["NSAIDs"], doseLog: [], lang: "en",
};
const r = await findItems([fs.readFileSync(file).toString("base64")], profile, target);
const v = r.verdict;
console.log(JSON.stringify({ model: r.model, ms: r.latencyMs, level: v.level, headline: v.headline, speech: v.speech }));
for (const i of v.items ?? []) console.log(" ", i.position, i.level, JSON.stringify(i.headline), JSON.stringify(i.box), `name=${i.read.ingredient.value ?? i.read.product.value}@${i.read.ingredient.confidence} strength=${i.read.strength.value}@${i.read.strength.confidence} readability=${i.read.readability}`);
