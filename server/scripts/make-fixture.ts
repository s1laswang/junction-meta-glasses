// One-off: generate a synthetic medicine-box photo for the smoke test (server/fixtures/*.jpg).
// Usage: tsx scripts/make-fixture.ts <out.png> "<prompt>"
import fs from "node:fs";
import { ai } from "../src/gemini.ts";

const [out, prompt] = process.argv.slice(2);
const r = await ai.models.generateContent({
  model: process.env.IMAGE_MODEL ?? "gemini-3.1-flash-image",
  contents: prompt,
  config: { imageConfig: { aspectRatio: "1:1" } } as any,
});
const part = r.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
if (!part?.inlineData?.data) { console.log("no image returned"); process.exit(1); }
fs.writeFileSync(out, Buffer.from(part.inlineData.data, "base64"));
console.log("wrote", out, part.inlineData.mimeType);
