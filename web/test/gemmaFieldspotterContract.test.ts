import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF_FILE = fileURLToPath(import.meta.url);
const TEST_DIR = path.dirname(SELF_FILE);
const REPO_DIR = path.resolve(TEST_DIR, "..", "..");

const LINE_COMMENT = String.fromCharCode(47, 47);
const BLOCK_COMMENT = String.fromCharCode(47, 42);
const HTML_COMMENT = String.fromCharCode(60, 33, 45, 45);
const EM_DASH = String.fromCharCode(8212);
const ESCAPED_EM_DASH = ["\\u", "2014"].join("");

const SECRET_PREFIXES = [
  ["AIza", "Sy"].join(""),
  ["AQ.", "Ab"].join(""),
  ["sk_", "live_"].join(""),
  ["sk_", "test_"].join(""),
  ["ghp", "_"].join(""),
  ["glpat", "-"].join(""),
];

const HF_TOKEN_PATTERN = new RegExp(["hf", "_[A-Za-z0-9]{16,}"].join(""));

const EXPECTED_CLASSES = ["product", "strength", "expiry", "allergens"] as const;
type FieldClass = (typeof EXPECTED_CLASSES)[number];

type GemmaClassMetrics = {
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
};

type GemmaFieldSpotterResults = {
  model: string;
  epochs: number;
  train_seconds: number;
  n_val_images: number;
  per_class_iou50: Record<FieldClass, GemmaClassMetrics>;
  strength_visible: {
    tp: number;
    fp: number;
    fn: number;
    tn: number;
    precision: number;
    precision_ci: [number, number];
    recall: number;
    recall_ci: [number, number];
  };
  latency_ms_gpu: {
    n: number;
    p50: number;
    p95: number;
  };
};

type YoloFieldSpotterResults = {
  model: string;
  n_val_images: number;
  per_class: Record<FieldClass, { mAP50: number; mAP50_95: number }>;
  strength_visible: {
    conf: number;
    tp: number;
    fp: number;
    fn: number;
    tn: number;
    precision: number;
    precision_ci: [number, number];
    recall: number;
    recall_ci: [number, number];
  };
  latency_ms_onnx_cpu: {
    n: number;
    p50: number;
    p95: number;
  };
};

type SplitManifest = {
  images: {
    train: number;
    val: number;
  };
  boxes: {
    train: Record<FieldClass, number>;
    val: Record<FieldClass, number>;
  };
  val_src_ids: string[];
  train_src_ids?: string[];
  split: string;
};

type EvalV1Summary = {
  synthetic: {
    images_scored: number;
    dataset: {
      specs: number;
      images: number;
      renders_kept: number;
    };
  };
};

function repoPath(relPath: string): string {
  return path.join(REPO_DIR, relPath);
}

function readRepoText(relPath: string): string {
  return fs.readFileSync(repoPath(relPath), "utf8");
}

function roundHalfToEven1(val: number): number {
  const scaled = val * 10;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  if (Math.abs(diff - 0.5) < 1e-9) {
    return (floor % 2 === 0 ? floor : floor + 1) / 10;
  }
  return Math.round(scaled) / 10;
}

function wilson95Percent(k: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0.0, 0.0];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [
    roundHalfToEven1((100 * (c - h)) / d),
    roundHalfToEven1((100 * (c + h)) / d),
  ];
}

function parsePythonStringList(pySource: string, varName: string): string[] {
  const re = new RegExp(`^${varName}\\s*=\\s*\\[([^\\]]+)\\]`, "m");
  const match = pySource.match(re);
  assert.ok(match, `Expected ${varName} list in Python script`);
  return Array.from(match[1].matchAll(/"([^"]+)"/g), (m) => m[1]);
}

function extractImgIds(jsonText: string): string[] {
  const out = new Set<string>();
  const re = new RegExp('"img_id"\\s*:\\s*"([^"]+)"', "g");
  for (const m of jsonText.matchAll(re)) {
    out.add(m[1]);
  }
  return Array.from(out);
}

function parseResultsTable(md: string): {
  headers: [string, string, string];
  rows: Map<string, { gemma: string; yolo: string }>;
} {
  const tableLines = md
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|") && l.endsWith("|"));
  assert.ok(tableLines.length >= 8, `Expected at least 8 markdown table lines in GEMMA.md, got ${tableLines.length}`);

  const splitCells = (line: string): string[] =>
    line
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim());

  const headerCells = splitCells(tableLines[0]);
  assert.equal(headerCells.length, 3);

  const rows = new Map<string, { gemma: string; yolo: string }>();
  for (let i = 2; i < tableLines.length; i++) {
    const cells = splitCells(tableLines[i]);
    assert.equal(cells.length, 3, `Expected 3 columns in GEMMA.md table row: ${tableLines[i]}`);
    rows.set(cells[0], {
      gemma: cells[1].replaceAll("**", ""),
      yolo: cells[2].replaceAll("**", ""),
    });
  }

  return {
    headers: [headerCells[0], headerCells[1].replaceAll("**", ""), headerCells[2].replaceAll("**", "")],
    rows,
  };
}

function collectFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFilesRecursive(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

describe("FieldSpotter-Gemma DeepMind Best Use of Gemma evidence contract", () => {
  test("GEMMA.md, eval/pg_data.py, eval/pg_train.py, and fieldspotter_gemma.json agree on google/paligemma2-3b-pt-448, LoRA r = 16, and detection prompt", () => {
    const gemmaMd = readRepoText("GEMMA.md");
    const pgDataPy = readRepoText("eval/pg_data.py");
    const pgTrainPy = readRepoText("eval/pg_train.py");
    const gemmaJson = JSON.parse(readRepoText("eval/results/fieldspotter_gemma.json")) as GemmaFieldSpotterResults;

    const dataClasses = parsePythonStringList(pgDataPy, "CLASSES");
    const trainClasses = parsePythonStringList(pgTrainPy, "CLASSES");
    assert.deepEqual(dataClasses, [...EXPECTED_CLASSES]);
    assert.deepEqual(trainClasses, [...EXPECTED_CLASSES]);

    assert.equal(pgDataPy.includes('PREFIX = "detect " + " ; ".join(CLASSES)'), true);
    const expectedPrompt = `detect ${dataClasses.join(" ; ")}`;
    assert.equal(expectedPrompt, "detect product ; strength ; expiry ; allergens");
    assert.equal(gemmaMd.includes(`\`${expectedPrompt}\``), true);

    assert.equal(pgDataPy.includes("round(v * 1023)"), true);
    assert.equal(pgTrainPy.includes("int(m.group(k)) / 1023"), true);
    assert.equal(gemmaMd.includes("PaliGemma location tokens"), true);

    const modelDefaultMatch = pgTrainPy.match(/MODEL\s*=\s*os\.environ\.get\(\s*"PG_MODEL"\s*,\s*"([^"]+)"\s*\)/);
    assert.ok(modelDefaultMatch, "eval/pg_train.py must define PG_MODEL default");
    const modelId = modelDefaultMatch[1];
    assert.equal(modelId, "google/paligemma2-3b-pt-448");
    assert.equal(gemmaMd.includes(`\`${modelId}\``), true);
    assert.equal(gemmaMd.includes("PaliGemma 2 3B"), true);
    assert.equal(gemmaJson.model, `${modelId} + LoRA r16 (HoldUp FieldSpotter-Gemma)`);

    const loraRankMatch = pgTrainPy.match(/LoraConfig\(\s*r\s*=\s*(\d+)\s*,\s*lora_alpha\s*=\s*(\d+)\s*,\s*lora_dropout\s*=\s*([0-9.]+)/);
    assert.ok(loraRankMatch, "eval/pg_train.py must configure LoraConfig(r=..., lora_alpha=..., lora_dropout=...)");
    const loraRank = Number(loraRankMatch[1]);
    assert.equal(loraRank, 16);
    assert.equal(Number(loraRankMatch[2]), 32);
    assert.equal(Number(loraRankMatch[3]), 0.05);
    assert.equal(gemmaMd.includes(`r = ${loraRank}`), true);
    assert.equal(gemmaMd.includes("23.8 M trainable parameters, 0.78%"), true);

    for (const proj of ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]) {
      assert.equal(pgTrainPy.includes(`"${proj}"`), true, `pg_train.py target_modules must include ${proj}`);
    }
    assert.equal(pgTrainPy.includes("vision_tower"), true);
    assert.equal(pgTrainPy.includes("multi_modal_projector"), true);
    assert.equal(pgTrainPy.includes('os.environ.get("HF_TOKEN")'), true);

    const citedPaths = [
      "GEMINI.md",
      "docs/EVAL.md",
      "eval/pg_data.py",
      "eval/pg_train.py",
      "eval/results/fieldspotter_gemma.json",
      "docs/PLAN.md",
    ];
    for (const rel of citedPaths) {
      assert.equal(gemmaMd.includes(rel), true, `GEMMA.md must reference ${rel}`);
      assert.equal(fs.existsSync(repoPath(rel)), true, `Referenced artifact ${rel} must exist`);
    }
  });

  test("split.json and eval v1 dataset provenance match GEMMA.md (1,392 train + 348 held-out = 1,740 images with zero label ID overlap)", () => {
    const gemmaMd = readRepoText("GEMMA.md");
    const split = JSON.parse(readRepoText("docs/evidence/fieldspotter/split.json")) as SplitManifest;
    const evalV1 = JSON.parse(readRepoText("eval/results/v1_results.json")) as EvalV1Summary;
    const makeYoloPy = readRepoText("eval/make_yolo.py");

    assert.equal(split.images.train, 1392);
    assert.equal(split.images.val, 348);
    const totalImages = split.images.train + split.images.val;
    assert.equal(totalImages, 1740);
    assert.equal(totalImages, evalV1.synthetic.images_scored);
    assert.equal(totalImages, evalV1.synthetic.dataset.images);
    assert.equal(evalV1.synthetic.dataset.specs, 172);
    assert.equal(split.split, "by src_id, 80/20, seed 42");

    assert.equal(gemmaMd.includes(totalImages.toLocaleString("en-US")), true);
    assert.equal(gemmaMd.includes(`${evalV1.synthetic.dataset.specs} label specs`), true);
    assert.equal(
      gemmaMd.includes(`${split.images.train.toLocaleString("en-US")} train and ${split.images.val} held-out images`),
      true,
    );
    assert.equal(gemmaMd.includes("no label in both sets"), true);

    assert.equal(Array.isArray(split.val_src_ids), true);
    assert.equal(split.val_src_ids.length, 42);
    assert.equal(split.val_src_ids.length, Math.floor(evalV1.synthetic.dataset.renders_kept / 5));

    const valSet = new Set(split.val_src_ids);
    assert.equal(valSet.size, split.val_src_ids.length);
    assert.deepEqual(split.val_src_ids, [...split.val_src_ids].sort());

    if (Array.isArray(split.train_src_ids)) {
      const trainSet = new Set(split.train_src_ids);
      assert.equal(trainSet.size, split.train_src_ids.length);
      const directOverlap = split.train_src_ids.filter((id) => valSet.has(id));
      assert.deepEqual(directOverlap, []);
    }

    assert.equal(makeYoloPy.includes('srcs = sorted({r["src_id"] for r in rows})'), true);
    assert.equal(makeYoloPy.includes("random.Random(42).shuffle(srcs)"), true);
    assert.equal(makeYoloPy.includes('split = "val" if r["src_id"] in test_src else "train"'), true);

    const observedImgIds = [
      ...extractImgIds(readRepoText("eval/results/v1_results.json")),
      ...extractImgIds(readRepoText("eval/results/v2_safety_rescore.json")),
      ...extractImgIds(readRepoText("eval/results/v2_model_compare.json")),
    ];
    assert.ok(observedImgIds.length > 0);

    const trainSrcIds = new Set<string>();
    const valSrcIds = new Set<string>();
    const splitsBySrc = new Map<string, Set<"train" | "val">>();

    for (const imgId of observedImgIds) {
      const sep = imgId.indexOf("__");
      assert.ok(sep > 0, `Expected <src_id>__<deg> image ID, got ${imgId}`);
      const srcId = imgId.slice(0, sep);
      const bucket: "train" | "val" = valSet.has(srcId) ? "val" : "train";
      if (bucket === "val") valSrcIds.add(srcId);
      else trainSrcIds.add(srcId);
      let seen = splitsBySrc.get(srcId);
      if (!seen) {
        seen = new Set();
        splitsBySrc.set(srcId, seen);
      }
      seen.add(bucket);
    }

    assert.ok(trainSrcIds.size > 0);
    assert.ok(valSrcIds.size > 0);
    const overlappingLabelIds = Array.from(trainSrcIds).filter((id) => valSrcIds.has(id));
    assert.deepEqual(overlappingLabelIds, []);
    for (const [, buckets] of splitsBySrc) {
      assert.equal(buckets.size, 1);
    }
  });

  test("held-out n = 348 strength-visible precision, recall, and recomputed 95% Wilson CIs in fieldspotter_gemma.json and fieldspotter.json match GEMMA.md", () => {
    const gemmaMd = readRepoText("GEMMA.md");
    const gemmaJson = JSON.parse(readRepoText("eval/results/fieldspotter_gemma.json")) as GemmaFieldSpotterResults;
    const yoloJson = JSON.parse(readRepoText("eval/results/fieldspotter.json")) as YoloFieldSpotterResults;
    const split = JSON.parse(readRepoText("docs/evidence/fieldspotter/split.json")) as SplitManifest;

    assert.equal(gemmaJson.n_val_images, 348);
    assert.equal(yoloJson.n_val_images, 348);
    assert.equal(gemmaJson.n_val_images, split.images.val);
    assert.equal(gemmaMd.includes(`held-out, n = ${gemmaJson.n_val_images} images, 95% Wilson CIs`), true);

    const gSv = gemmaJson.strength_visible;
    assert.equal(gSv.tp, 170);
    assert.equal(gSv.fp, 19);
    assert.equal(gSv.fn, 16);
    assert.equal(gSv.tn, 143);
    assert.equal(gSv.tp + gSv.fp + gSv.fn + gSv.tn, gemmaJson.n_val_images);
    assert.equal(gSv.tp + gSv.fn, split.boxes.val.strength);

    const gPredPos = gSv.tp + gSv.fp;
    const gGtPos = gSv.tp + gSv.fn;
    assert.equal(gPredPos, 189);
    assert.equal(gGtPos, 186);

    assert.equal(gSv.precision, 89.9);
    assert.equal(gSv.precision, roundHalfToEven1((100 * gSv.tp) / gPredPos));
    assert.deepEqual(gSv.precision_ci, [84.8, 93.5]);
    assert.deepEqual(gSv.precision_ci, wilson95Percent(gSv.tp, gPredPos));

    assert.equal(gSv.recall, 91.4);
    assert.equal(gSv.recall, roundHalfToEven1((100 * gSv.tp) / gGtPos));
    assert.deepEqual(gSv.recall_ci, [86.5, 94.6]);
    assert.deepEqual(gSv.recall_ci, wilson95Percent(gSv.tp, gGtPos));

    const ySv = yoloJson.strength_visible;
    assert.equal(ySv.tp, 122);
    assert.equal(ySv.fp, 4);
    assert.equal(ySv.fn, 64);
    assert.equal(ySv.tn, 158);
    assert.equal(ySv.tp + ySv.fp + ySv.fn + ySv.tn, yoloJson.n_val_images);
    assert.equal(ySv.tp + ySv.fn, gGtPos);
    assert.equal(ySv.fp + ySv.tn, gSv.fp + gSv.tn);

    const yPredPos = ySv.tp + ySv.fp;
    const yGtPos = ySv.tp + ySv.fn;
    assert.equal(yPredPos, 126);
    assert.equal(yGtPos, 186);

    assert.equal(ySv.precision, 96.8);
    assert.equal(ySv.precision, roundHalfToEven1((100 * ySv.tp) / yPredPos));
    assert.deepEqual(ySv.precision_ci, [92.1, 98.8]);
    assert.deepEqual(ySv.precision_ci, wilson95Percent(ySv.tp, yPredPos));

    assert.equal(ySv.recall, 65.6);
    assert.equal(ySv.recall, roundHalfToEven1((100 * ySv.tp) / yGtPos));
    assert.deepEqual(ySv.recall_ci, [58.5, 72.0]);
    assert.deepEqual(ySv.recall_ci, wilson95Percent(ySv.tp, yGtPos));

    const table = parseResultsTable(gemmaMd);
    assert.equal(table.headers[1], "PaliGemma 2 3B + LoRA (Gemma)");
    assert.equal(table.headers[2], "YOLOv8n (same data, also trained on Verda)");

    const precRow = table.rows.get('"Strength visible": precision');
    assert.ok(precRow);
    assert.match(
      precRow.gemma,
      new RegExp(`^${gSv.precision.toFixed(1)}% \\(${gSv.precision_ci[0].toFixed(1)}[^0-9.]+${gSv.precision_ci[1].toFixed(1)}\\)$`),
    );
    assert.match(
      precRow.yolo,
      new RegExp(`^${ySv.precision.toFixed(1)}% \\(${ySv.precision_ci[0].toFixed(1)}[^0-9.]+${ySv.precision_ci[1].toFixed(1)}\\)$`),
    );

    const recRow = table.rows.get('"Strength visible": recall');
    assert.ok(recRow);
    assert.match(
      recRow.gemma,
      new RegExp(`^${gSv.recall.toFixed(1)}% \\(${gSv.recall_ci[0].toFixed(1)}[^0-9.]+${gSv.recall_ci[1].toFixed(1)}\\)$`),
    );
    assert.match(
      recRow.yolo,
      new RegExp(`^${ySv.recall.toFixed(1)}% \\(${ySv.recall_ci[0].toFixed(1)}[^0-9.]+${ySv.recall_ci[1].toFixed(1)}\\)$`),
    );

    assert.equal(
      gemmaMd.includes(`recall is ${Math.round(gSv.recall)}% vs ${Math.round(ySv.recall)}%`),
      true,
    );
    assert.equal(ySv.fn / gSv.fn, 4);
    assert.equal(gemmaMd.includes("misses about a quarter as many cases as YOLO"), true);
  });

  test("per-field IoU >= 0.5 box precision/recall, YOLOv8n mAP@0.5, and p50 latency cross-verify across JSON artifacts and GEMMA.md", () => {
    const gemmaMd = readRepoText("GEMMA.md");
    const pgTrainPy = readRepoText("eval/pg_train.py");
    const gemmaJson = JSON.parse(readRepoText("eval/results/fieldspotter_gemma.json")) as GemmaFieldSpotterResults;
    const yoloJson = JSON.parse(readRepoText("eval/results/fieldspotter.json")) as YoloFieldSpotterResults;
    const split = JSON.parse(readRepoText("docs/evidence/fieldspotter/split.json")) as SplitManifest;

    assert.equal(pgTrainPy.includes("iou(p, G[j]) >= 0.5"), true);
    assert.equal(pgTrainPy.includes("do_sample=False"), true);

    for (const clsName of EXPECTED_CLASSES) {
      const stats = gemmaJson.per_class_iou50[clsName];
      assert.equal(stats.tp + stats.fn, split.boxes.val[clsName], `${clsName} tp+fn must equal split.boxes.val.${clsName}`);
      assert.equal(stats.precision, roundHalfToEven1((100 * stats.tp) / (stats.tp + stats.fp)));
      assert.equal(stats.recall, roundHalfToEven1((100 * stats.tp) / (stats.tp + stats.fn)));
    }

    assert.equal(gemmaJson.per_class_iou50.product.precision, 51.3);
    assert.equal(gemmaJson.per_class_iou50.product.recall, 46.3);
    assert.equal(gemmaJson.per_class_iou50.strength.precision, 52.4);
    assert.equal(gemmaJson.per_class_iou50.strength.recall, 53.2);
    assert.equal(gemmaJson.per_class_iou50.expiry.precision, 59.1);
    assert.equal(gemmaJson.per_class_iou50.expiry.recall, 56.8);
    assert.equal(gemmaJson.per_class_iou50.allergens.precision, 41.2);
    assert.equal(gemmaJson.per_class_iou50.allergens.recall, 33.7);

    assert.equal(yoloJson.per_class.strength.mAP50, 0.607);
    assert.equal(yoloJson.per_class.expiry.mAP50, 0.616);
    assert.equal(yoloJson.per_class.allergens.mAP50, 0.401);

    const table = parseResultsTable(gemmaMd);
    const tableClasses = ["strength", "expiry", "allergens"] as const;
    for (const clsName of tableClasses) {
      const row = table.rows.get(`Box precision / recall at IoU \u2265 0.5: ${clsName}`);
      assert.ok(row, `Missing GEMMA.md table row for ${clsName}`);
      const gCls = gemmaJson.per_class_iou50[clsName];
      const yCls = yoloJson.per_class[clsName];
      assert.equal(row.gemma, `${gCls.precision.toFixed(1)}% / ${gCls.recall.toFixed(1)}%`);
      assert.equal(row.yolo, `mAP@0.5 ${yCls.mAP50.toFixed(3)}`);
    }

    assert.equal(gemmaJson.latency_ms_gpu.n, 348);
    assert.equal(gemmaJson.latency_ms_gpu.p50, 1426.7);
    assert.equal(gemmaJson.latency_ms_gpu.p95, 1484.1);
    assert.ok(gemmaJson.latency_ms_gpu.p95 >= gemmaJson.latency_ms_gpu.p50);

    assert.equal(yoloJson.latency_ms_onnx_cpu.n, 100);
    assert.equal(yoloJson.latency_ms_onnx_cpu.p50, 34.5);
    assert.equal(yoloJson.latency_ms_onnx_cpu.p95, 35.3);
    assert.ok(yoloJson.latency_ms_onnx_cpu.p95 >= yoloJson.latency_ms_onnx_cpu.p50);

    const gemmaP50Seconds = (gemmaJson.latency_ms_gpu.p50 / 1000).toFixed(2);
    assert.equal(gemmaP50Seconds, "1.43");

    const latencyRow = table.rows.get("Latency per image");
    assert.ok(latencyRow);
    assert.equal(latencyRow.gemma, `${gemmaP50Seconds} s p50 (shared A100, greedy decode)`);
    assert.equal(latencyRow.yolo, `${yoloJson.latency_ms_onnx_cpu.p50.toFixed(1)} ms on CPU (ONNX)`);

    const speedupRatio = gemmaJson.latency_ms_gpu.p50 / yoloJson.latency_ms_onnx_cpu.p50;
    assert.ok(speedupRatio >= 38 && speedupRatio <= 45);
    assert.equal(gemmaMd.includes("about 40\u00d7 faster"), true);
  });

  test("Verda A100 training log provenance in pg_train_log.txt and honest product/safety disclosure in GEMMA.md are internally consistent", () => {
    const gemmaMd = readRepoText("GEMMA.md");
    const pgTrainPy = readRepoText("eval/pg_train.py");
    const logText = readRepoText("docs/evidence/fieldspotter/pg_train_log.txt");
    const gemmaJson = JSON.parse(readRepoText("eval/results/fieldspotter_gemma.json")) as GemmaFieldSpotterResults;
    const split = JSON.parse(readRepoText("docs/evidence/fieldspotter/split.json")) as SplitManifest;
    const planMd = readRepoText("docs/PLAN.md");
    const safetyTs = readRepoText("server/src/safety.ts");

    assert.equal(gemmaJson.epochs, 2.0);
    assert.equal(gemmaJson.train_seconds, 1766);

    const batchSize = 2;
    const totalSteps = Math.ceil(split.images.train / batchSize) * gemmaJson.epochs;
    assert.equal(totalSteps, 1392);
    assert.equal(Math.round(gemmaJson.train_seconds / 60), 29);

    assert.equal(
      gemmaMd.includes(
        `about ${Math.round(gemmaJson.train_seconds / 60)} min for ${gemmaJson.epochs} epochs (${totalSteps.toLocaleString("en-US")} steps at batch ${batchSize})`,
      ),
      true,
    );
    assert.equal(gemmaMd.includes("Verda A100-SXM4-80GB (instance f4378173, FIN-03)"), true);
    assert.equal(gemmaMd.includes("Peak about 15.5 GB GPU memory, with gradient checkpointing and a hard memory cap"), true);
    assert.equal(pgTrainPy.includes("gradient_checkpointing_enable"), true);
    assert.equal(pgTrainPy.includes("set_per_process_memory_fraction"), true);

    const tsMatch = gemmaMd.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z)\s*[^\d]+\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z)/);
    assert.ok(tsMatch, "GEMMA.md must record start and end UTC timestamps");
    assert.equal(tsMatch[1], "2026-11-14 23:35:34Z");
    assert.equal(tsMatch[2], "2026-11-15 00:12:18Z");
    const startMs = Date.parse(tsMatch[1].replace(" ", "T"));
    const endMs = Date.parse(tsMatch[2].replace(" ", "T"));
    assert.equal(Number.isFinite(startMs), true);
    assert.equal(Number.isFinite(endMs), true);
    const windowSeconds = (endMs - startMs) / 1000;
    assert.equal(windowSeconds, 2204);
    assert.ok(windowSeconds > gemmaJson.train_seconds);

    const logLines = logText.trim().split(/\r?\n/);
    const expectedLogCount = Math.floor(totalSteps / 20);
    assert.equal(logLines.length, expectedLogCount);
    assert.equal(logLines.length, 69);

    const losses: number[] = [];
    let prevElapsed = 0;
    const lineRe = new RegExp(`^step (\\d+)\\/${totalSteps} loss (\\d+\\.\\d{4}) t (\\d+)s$`);
    for (let i = 0; i < logLines.length; i++) {
      const m = logLines[i].match(lineRe);
      assert.ok(m, `Unexpected pg_train_log.txt format at line ${i + 1}: ${logLines[i]}`);
      const stepNum = Number(m[1]);
      const lossVal = Number(m[2]);
      const elapsedSec = Number(m[3]);
      assert.equal(stepNum, (i + 1) * 20);
      assert.ok(Number.isFinite(lossVal) && lossVal > 0 && lossVal < 10);
      assert.ok(elapsedSec > prevElapsed, `Elapsed seconds must strictly increase at step ${stepNum}`);
      losses.push(lossVal);
      prevElapsed = elapsedSec;
    }

    assert.equal(prevElapsed, 1750);
    assert.ok(prevElapsed < gemmaJson.train_seconds);
    assert.ok(gemmaJson.train_seconds - prevElapsed <= 60);

    const earlyMeanLoss = losses.slice(0, 10).reduce((a, b) => a + b, 0) / 10;
    const lateMeanLoss = losses.slice(-10).reduce((a, b) => a + b, 0) / 10;
    assert.ok(earlyMeanLoss > 2.4);
    assert.ok(lateMeanLoss < 1.3);
    assert.ok(lateMeanLoss < earlyMeanLoss * 0.55);

    assert.equal(gemmaMd.includes("The LoRA adapter (91 MB) is kept out of git."), true);
    const trackedFiles = collectFilesRecursive(REPO_DIR);
    const adapterWeights = trackedFiles.filter(
      (f) => f.endsWith(".safetensors") || f.endsWith("adapter_model.bin"),
    );
    assert.deepEqual(adapterWeights, []);

    assert.equal(gemmaMd.includes("Not yet in the product."), true);
    assert.equal(gemmaMd.includes("Neither detector is wired into the live coaching loop yet"), true);
    assert.equal(gemmaMd.includes("`docs/PLAN.md` \u00a70c, flag `spotter`"), true);
    assert.equal(gemmaMd.includes("trained and evaluated models, not a shipped feature"), true);
    assert.equal(planMd.includes("## 0c. FieldSpotter"), true);
    assert.equal(planMd.includes("flag `spotter`"), true);

    assert.equal(gemmaMd.includes("A safety-shaped role."), true);
    assert.equal(gemmaMd.includes("The open model never decides anything about a medicine."), true);
    assert.equal(gemmaMd.includes("Gemini reads the label and decides."), true);
    assert.equal(gemmaMd.includes("Gemini plus deterministic rules still own the verdict."), true);
    assert.equal(safetyTs.includes("export const STRENGTH_MIN_CONF = 0.8"), true);
    assert.equal(safetyTs.includes("export const ALLERGEN_SAFE_CONF = 0.95"), true);
  });

  test("enforces zero comments, zero em dashes, and zero leaked secrets in gemmaFieldspotterContract.test.ts and Gemma artifacts", () => {
    const gemmaArtifacts = [
      "GEMMA.md",
      "eval/results/fieldspotter_gemma.json",
      "docs/evidence/fieldspotter/pg_train_log.txt",
      "eval/pg_data.py",
      "eval/pg_train.py",
    ];

    for (const relPath of gemmaArtifacts) {
      const content = readRepoText(relPath);
      for (const prefix of SECRET_PREFIXES) {
        assert.equal(content.includes(prefix), false, `${relPath} must not contain secret prefix ${prefix}`);
      }
      assert.equal(HF_TOKEN_PATTERN.test(content), false, `${relPath} must not contain a HuggingFace token`);
    }

    const gemmaMd = readRepoText("GEMMA.md");
    assert.equal(gemmaMd.includes(EM_DASH), false, "GEMMA.md must have zero em dashes");

    const selfSource = fs.readFileSync(SELF_FILE, "utf8");
    assert.equal(selfSource.includes(LINE_COMMENT), false, "Self-check: zero line comments");
    assert.equal(selfSource.includes(BLOCK_COMMENT), false, "Self-check: zero block comments");
    assert.equal(selfSource.includes(HTML_COMMENT), false, "Self-check: zero HTML comments");
    assert.equal(selfSource.includes(EM_DASH), false, "Self-check: zero em dashes");
    assert.equal(selfSource.includes(ESCAPED_EM_DASH), false, "Self-check: zero escaped em dashes");
    for (const prefix of SECRET_PREFIXES) {
      assert.equal(selfSource.includes(prefix), false, `Self-check: zero secret prefix ${prefix}`);
    }
    assert.equal(HF_TOKEN_PATTERN.test(selfSource), false, "Self-check: zero HuggingFace tokens");
  });
});
