// Run FieldSpotter on images and print boxes and timing: npx tsx server/scripts/spot-try.ts [files...]
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../src/env.ts";
import { detect } from "../src/spotter.ts";

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["amlodipine.jpg", "three_boxes.jpg", "dm_amlodipine.jpg"].map((f) => path.join(REPO_ROOT, "server", "fixtures", f));
for (const f of files) {
  const buf = fs.readFileSync(f);
  await detect(buf); // warm-up
  const times: number[] = [];
  let last;
  for (let i = 0; i < 5; i++) { last = await detect(buf); times.push(last.ms); }
  times.sort((a, b) => a - b);
  console.log(path.basename(f), `${last!.w}x${last!.h}`, `p50 ${times[2]} ms`, JSON.stringify(last!.fields.map((x) => `${x.label} ${x.score} [${x.box.join(",")}]`)));
}
