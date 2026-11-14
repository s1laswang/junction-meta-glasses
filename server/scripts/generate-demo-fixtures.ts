import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { DemoScenarioId } from "../../web/src/types.ts";
import { REPO_ROOT } from "../src/env.ts";
import { ai, backoffMs, classify, sleep, unaryGate } from "../src/gemini.ts";
import { jpegSize } from "../src/verify.ts";

type Box = [number, number, number, number];

type FixtureSpec = {
  scenario: DemoScenarioId;
  file: string;
  prompt: string;
  blurBoxes?: Box[];
};

const FIXTURES: FixtureSpec[] = [
  {
    scenario: "amlodipine_match",
    file: "amlodipine.jpg",
    prompt:
      'Realistic first-person point-of-view photograph indoors in a softly blurred daylight home kitchen, unobstructed lens view. One human hand holds a clean white rectangular pharmacy medicine box steady at chest height facing straight toward the camera. Sharp dark sans-serif pharmacy print on the front of the white carton clearly reads: bold top line "Amlodipin 5 mg", second line "amlodipine", bottom left "30 tablets", bottom right "EXP 08/2027". Fingers hold the outer edges of the box without covering any text. Natural window light, authentic cardboard texture, shallow depth of field, photorealistic camera photo.',
  },
  {
    scenario: "ibuprofen_nsaid",
    file: "ibuprofen.jpg",
    prompt:
      'Realistic first-person point-of-view photograph indoors in a softly blurred Nordic home kitchen, unobstructed lens view. One human hand holds a Finnish Nordic pharmacy painkiller cardboard box facing straight toward the camera. Clean white and red pharmacy carton design with crisp legible dark and white sans-serif typography clearly printed on the front panel: bold title "Burana 400 mg", subtitle "ibuprofeeni / ibuprofen", lower corner "30 tablettia". Fingers grip the bottom edge without covering any text. Natural indoor daylight, authentic cardboard texture, soft bokeh background, photorealistic camera photo.',
  },
  {
    scenario: "blurry_strength",
    file: "blurry_amlodipine.jpg",
    prompt:
      'Realistic first-person point-of-view photograph indoors in a softly blurred home kitchen, unobstructed lens view. A human hand holds a plain white rectangular pharmacy medicine box facing the camera. Near the upper left of the white front panel, printed clearly and sharply in dark sans-serif letters, is only the title "Amlodipin" with "amlodipine" right beneath it. Below and to the right across the dosage area of the box, the person\'s wide thumb presses flat and completely covers the entire space before "mg" with a wide margin so not even a tiny edge of any digit is visible. Zero numbers, zero digits, zero tablet count, and zero expiry date appear anywhere in the image. Natural indoor lighting, realistic skin texture on the thumb, shallow depth of field, photorealistic camera photo.',
  },
  {
    scenario: "hazelnut_allergy",
    file: "hazelnut_bar.jpg",
    prompt:
      'Realistic first-person point-of-view close-up photograph indoors in a softly blurred kitchen, unobstructed lens view. One human hand holds the back wrapper of a matte granola oat snack bar facing straight toward the camera. A crisp high-contrast cream-white ingredient panel printed on the back of the wrapper clearly reads in sharp dark sans-serif text: "Granola Oat Bar", followed by "Ingredients: Rolled oats, honey, roasted hazelnuts (12%), arachis oil, cocoa." and beneath it "Best before: 14.09.2027". Fingers hold the crimped ends of the wrapper without blocking any lettering. Subtle wrapper creases, natural daylight, soft bokeh background, photorealistic camera photo.',
  },
  {
    scenario: "oat_milk_safe",
    file: "oat_milk.jpg",
    prompt:
      'Realistic first-person point-of-view photograph indoors in a softly blurred kitchen, unobstructed lens view. One human hand holds a Nordic paperboard oat drink carton turned to show its clean light-colored side ingredient panel facing straight toward the camera. Sharp dark sans-serif print on the carton panel clearly reads: "Oat Drink", followed by "Ingredients: Oat base (water, oats 10%), rapeseed oil, calcium carbonate, salt. Free from milk and soy. Best before: 03.12.2027". Fingers grip the side edges of the carton without obscuring any text. Natural daylight, matte Tetra Pak cardboard texture, shallow depth of field, photorealistic camera photo.',
  },
  {
    scenario: "expired_med",
    file: "expired_metformin.jpg",
    prompt:
      'Realistic first-person point-of-view photograph indoors in a softly blurred home kitchen, unobstructed camera view with nothing in front of the lens. One human hand holds a clean white and slate-blue rectangular pharmaceutical medicine box facing straight toward the camera. Crisp dark sans-serif typography clearly printed on the front of the carton reads: bold title "Metformin 500 mg", subtitle "metformin hydrochloride", bottom left "30 tablets", and clearly printed at bottom right "EXP 2025-04". Fingers hold the outer edges of the box without covering any text. Natural indoor daylight, authentic cardboard texture, shallow depth of field, photorealistic camera photo.',
  },
  {
    scenario: "back_of_box",
    file: "back_of_box.jpg",
    prompt:
      'Realistic first-person point-of-view photograph indoors in a softly blurred home kitchen, unobstructed camera view. One human hand holds a plain matte white rectangular medicine cardboard carton turned to its blank rear side facing straight toward the camera. Almost the entire white cardboard face is completely blank unprinted white paperboard with zero product name, zero words, zero letters, and zero strength visible anywhere. Near the bottom center of the blank white box is a flat black-and-white vertical bar barcode with the exact 13-digit number "6432100012345" printed clearly in one continuous unbroken line centered directly beneath the bars, and a small plain three-arrow triangle recycling icon with no text or numbers inside it. Natural indoor daylight, realistic cardboard texture, shallow depth of field, photorealistic camera photo.',
  },
];

const PYTHON_BIN = fs.existsSync("/venv/bin/python3") ? "/venv/bin/python3" : "python3";

const PYTHON_RESIZE = [
  "import io, json, sys",
  "from PIL import Image, ImageFilter, ImageOps",
  "boxes = json.loads(sys.argv[1])",
  "raw = sys.stdin.buffer.read()",
  "im = ImageOps.exif_transpose(Image.open(io.BytesIO(raw))).convert('RGB')",
  "w, h = im.size",
  "if w != h:",
  "    s = min(w, h)",
  "    left = int((w - s) / 2)",
  "    top = int((h - s) / 2)",
  "    im = im.crop((left, top, left + s, top + s))",
  "im = im.resize((768, 768), Image.Resampling.LANCZOS)",
  "for x1, y1, x2, y2 in boxes:",
  "    patch = im.crop((x1, y1, x2, y2))",
  "    for _ in range(3):",
  "        patch = patch.filter(ImageFilter.GaussianBlur(radius=16))",
  "    im.paste(patch, (x1, y1))",
  "out = b''",
  "for q in (82, 78, 74, 70, 66):",
  "    buf = io.BytesIO()",
  "    im.save(buf, format='JPEG', quality=q, optimize=True)",
  "    out = buf.getvalue()",
  "    if len(out) < 158000:",
  "        break",
  "sys.stdout.buffer.write(out)",
].join("\n");

function toSquareJpeg(raw: Buffer, blurBoxes: Box[] = []): Buffer {
  const res = spawnSync(PYTHON_BIN, ["-c", PYTHON_RESIZE, JSON.stringify(blurBoxes)], {
    input: raw,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.status !== 0 || !res.stdout?.length) {
    throw new Error(`python resize failed: ${res.stderr?.toString() ?? "unknown error"}`);
  }
  return Buffer.from(res.stdout);
}

async function generateRawImage(prompt: string): Promise<Buffer> {
  const model = process.env.IMAGE_MODEL ?? "gemini-3.1-flash-image";
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await unaryGate.run(() =>
        ai.models.generateContent({
          model,
          contents: prompt,
          config: { imageConfig: { aspectRatio: "1:1" } } as any,
        })
      );
      const part = r.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
      if (!part?.inlineData?.data) throw new Error("empty reply from image model");
      return Buffer.from(part.inlineData.data, "base64");
    } catch (e) {
      lastErr = e;
      const kind = classify(e);
      if (kind === "bad_request" || kind === "not_found") throw e;
      await sleep(backoffMs(attempt, 800, 10000));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function buildFixture(spec: FixtureSpec, outDir: string): Promise<void> {
  const raw = await generateRawImage(spec.prompt);
  const jpeg = toSquareJpeg(raw, spec.blurBoxes ?? []);
  const dim = jpegSize(jpeg);
  if (!dim || dim.w !== 768 || dim.h !== 768) {
    throw new Error(`invalid dimensions for ${spec.file}: ${JSON.stringify(dim)}`);
  }
  if (jpeg.length <= 5000 || jpeg.length >= 160000) {
    throw new Error(`unexpected byte size for ${spec.file}: ${jpeg.length}`);
  }
  const dest = path.join(outDir, spec.file);
  fs.writeFileSync(dest, jpeg);
  console.log(`wrote ${path.relative(REPO_ROOT, dest)} ${dim.w}x${dim.h} ${jpeg.length}B`);
}

const outDir = path.join(REPO_ROOT, "web", "public", "fixtures");
fs.mkdirSync(outDir, { recursive: true });

const filter = new Set(process.argv.slice(2));
const selected = filter.size
  ? FIXTURES.filter((f) => filter.has(f.file) || filter.has(f.scenario))
  : FIXTURES;

if (!selected.length) {
  console.error("no matching fixture specs");
  process.exit(1);
}

await Promise.all(selected.map((spec) => buildFixture(spec, outDir)));
