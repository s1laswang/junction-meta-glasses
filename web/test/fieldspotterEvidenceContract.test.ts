import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(TEST_DIR, "..", "..");

const EXPECTED_CLASSES = ["product", "strength", "expiry", "allergens"] as const;
type FieldClass = (typeof EXPECTED_CLASSES)[number];

type FieldSpotterResults = {
  model: string;
  weights: string;
  n_val_images: number;
  map50_all: number;
  map50_95_all: number;
  precision_all: number;
  recall_all: number;
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
  latency_ms_gpu_shared_h100: {
    n: number;
    p50: number;
    p95: number;
  };
  onnx: {
    path: string;
    bytes: number;
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

function wilson95Percent(k: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0.0, 0.0];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [
    Math.round(((100 * (c - h)) / d) * 10) / 10,
    Math.round(((100 * (c + h)) / d) * 10) / 10,
  ];
}

function extractImgIds(jsonText: string): string[] {
  const out = new Set<string>();
  const re = new RegExp('"img_id"\\s*:\\s*"([^"]+)"', "g");
  for (const m of jsonText.matchAll(re)) {
    out.add(m[1]);
  }
  return Array.from(out);
}

describe("FieldSpotter glasses POV detector evidence contract", () => {
  test("web/public/models/fieldspotter.onnx exists, is a real 10-20 MB ONNX binary (not Git LFS), and embeds all 4 class names", () => {
    const onnxFile = repoPath("web/public/models/fieldspotter.onnx");
    assert.equal(fs.existsSync(onnxFile), true);
    const stat = fs.statSync(onnxFile);
    assert.equal(stat.isFile(), true);
    assert.ok(stat.size > 10_000_000 && stat.size < 20_000_000);
    assert.ok(stat.size > 10 * 1024 * 1024 && stat.size < 20 * 1024 * 1024);

    const buf = fs.readFileSync(onnxFile);
    assert.equal(buf.byteLength, stat.size);

    const headUtf8 = buf.subarray(0, 128).toString("utf8");
    assert.equal(headUtf8.startsWith("version "), false);
    assert.equal(headUtf8.includes("git-lfs"), false);
    assert.equal(headUtf8.includes("oid sha256:"), false);

    assert.equal(buf[0], 0x08);
    assert.ok(buf[1] >= 1 && buf[1] <= 32);

    const binaryText = buf.toString("latin1");
    assert.equal(binaryText.includes("pytorch"), true);
    assert.equal(binaryText.includes("images"), true);
    assert.equal(binaryText.includes("output0"), true);

    for (const clsName of EXPECTED_CLASSES) {
      assert.equal(
        binaryText.includes(clsName),
        true,
        `fieldspotter.onnx must contain class name "${clsName}"`,
      );
    }
    assert.equal(
      binaryText.includes("{0: 'product', 1: 'strength', 2: 'expiry', 3: 'allergens'}"),
      true,
    );

    const evalJson = JSON.parse(readRepoText("eval/results/fieldspotter.json")) as FieldSpotterResults;
    assert.equal(buf.byteLength, evalJson.onnx.bytes);
  });

  test("docs/evidence/fieldspotter/split.json has 1392 train + 348 val = 1740 images and zero src_id/label leakage", () => {
    const split = JSON.parse(readRepoText("docs/evidence/fieldspotter/split.json")) as SplitManifest;
    const evalV1 = JSON.parse(readRepoText("eval/results/v1_results.json")) as EvalV1Summary;

    assert.equal(split.images.train, 1392);
    assert.equal(split.images.val, 348);
    assert.equal(split.images.train + split.images.val, 1740);
    assert.equal(split.images.train + split.images.val, evalV1.synthetic.images_scored);
    assert.equal(split.images.train + split.images.val, evalV1.synthetic.dataset.images);
    assert.equal(split.split, "by src_id, 80/20, seed 42");

    assert.equal(Array.isArray(split.val_src_ids), true);
    assert.equal(split.val_src_ids.length, Math.floor(evalV1.synthetic.dataset.renders_kept / 5));
    assert.equal(split.val_src_ids.length, 42);

    const valSet = new Set(split.val_src_ids);
    assert.equal(valSet.size, split.val_src_ids.length);
    assert.deepEqual(split.val_src_ids, [...split.val_src_ids].sort());

    const srcIdPattern = new RegExp("^(food|med)\\d{3}(_back)?$");
    for (const id of split.val_src_ids) {
      assert.match(id, srcIdPattern);
    }

    if (Array.isArray(split.train_src_ids)) {
      const trainSet = new Set(split.train_src_ids);
      assert.equal(trainSet.size, split.train_src_ids.length);
      const overlap = split.train_src_ids.filter((id) => valSet.has(id));
      assert.deepEqual(overlap, []);
    }

    const makeYoloPy = readRepoText("eval/make_yolo.py");
    assert.equal(makeYoloPy.includes('srcs = sorted({r["src_id"] for r in rows})'), true);
    assert.equal(makeYoloPy.includes("random.Random(42).shuffle(srcs)"), true);
    assert.equal(makeYoloPy.includes('split = "val" if r["src_id"] in test_src else "train"'), true);

    const observedImgIds = [
      ...extractImgIds(readRepoText("eval/results/v1_results.json")),
      ...extractImgIds(readRepoText("eval/results/v2_safety_rescore.json")),
    ];
    assert.ok(observedImgIds.length > 0);

    const assignedTrainSrc = new Set<string>();
    const assignedValSrc = new Set<string>();
    const perSrcSplits = new Map<string, Set<"train" | "val">>();

    for (const imgId of observedImgIds) {
      const sepIdx = imgId.indexOf("__");
      assert.ok(sepIdx > 0, `expected <src_id>__<deg> format for ${imgId}`);
      const srcId = imgId.slice(0, sepIdx);
      const bucket: "train" | "val" = valSet.has(srcId) ? "val" : "train";
      if (bucket === "val") assignedValSrc.add(srcId);
      else assignedTrainSrc.add(srcId);
      let seen = perSrcSplits.get(srcId);
      if (!seen) {
        seen = new Set();
        perSrcSplits.set(srcId, seen);
      }
      seen.add(bucket);
    }

    const leakedSrcIds = Array.from(assignedTrainSrc).filter((id) => assignedValSrc.has(id));
    assert.deepEqual(leakedSrcIds, []);
    for (const [, buckets] of perSrcSplits) {
      assert.equal(buckets.size, 1);
    }

    for (const clsName of EXPECTED_CLASSES) {
      assert.ok(split.boxes.train[clsName] > 0);
      assert.ok(split.boxes.val[clsName] > 0);
    }
    const valBoxTotal = EXPECTED_CLASSES.reduce((sum, k) => sum + split.boxes.val[k], 0);
    assert.equal(valBoxTotal, 896);
  });

  test("docs/evidence/fieldspotter/results.csv and args.yaml record 80 deterministic training epochs without horizontal flip", () => {
    const csvLines = readRepoText("docs/evidence/fieldspotter/results.csv")
      .trim()
      .split(/\r?\n/);
    assert.equal(csvLines.length, 81);
    const header = csvLines[0].split(",");
    assert.equal(header[0], "epoch");
    assert.equal(header[1], "time");
    assert.equal(header.includes("metrics/mAP50(B)"), true);
    assert.equal(header.includes("metrics/mAP50-95(B)"), true);

    for (let i = 1; i < csvLines.length; i++) {
      const cols = csvLines[i].split(",").map((v) => Number(v.trim()));
      assert.equal(cols.length, header.length);
      assert.equal(cols[0], i);
      for (const n of cols) {
        assert.equal(Number.isFinite(n), true);
      }
    }

    const finalCols = csvLines[80].split(",").map((v) => Number(v.trim()));
    assert.equal(finalCols[0], 80);
    assert.equal(Math.round(finalCols[1]), 513);

    const argsYaml = readRepoText("docs/evidence/fieldspotter/args.yaml");
    assert.equal(argsYaml.includes("model: yolov8n.pt"), true);
    assert.equal(argsYaml.includes("epochs: 80"), true);
    assert.equal(argsYaml.includes("imgsz: 640"), true);
    assert.equal(argsYaml.includes("batch: 32"), true);
    assert.equal(argsYaml.includes("seed: 42"), true);
    assert.equal(argsYaml.includes("fliplr: 0.0"), true);
  });

  test("eval/results/fieldspotter.json metrics, Wilson 95% CIs, per-class mAP@0.5, and ONNX CPU latency match docs/evidence/verda-fieldspotter.md", () => {
    const res = JSON.parse(readRepoText("eval/results/fieldspotter.json")) as FieldSpotterResults;
    const split = JSON.parse(readRepoText("docs/evidence/fieldspotter/split.json")) as SplitManifest;
    const md = readRepoText("docs/evidence/verda-fieldspotter.md");

    assert.equal(res.n_val_images, 348);
    assert.equal(res.n_val_images, split.images.val);

    const sv = res.strength_visible;
    assert.equal(sv.conf, 0.4);
    assert.equal(sv.tp, 122);
    assert.equal(sv.fp, 4);
    assert.equal(sv.fn, 64);
    assert.equal(sv.tn, 158);
    assert.equal(sv.tp + sv.fp + sv.fn + sv.tn, res.n_val_images);

    const predPos = sv.tp + sv.fp;
    const gtPos = sv.tp + sv.fn;
    assert.equal(predPos, 126);
    assert.equal(gtPos, 186);
    assert.equal(gtPos, split.boxes.val.strength);

    const computedPrecision = Math.round(((100 * sv.tp) / predPos) * 10) / 10;
    const computedRecall = Math.round(((100 * sv.tp) / gtPos) * 10) / 10;
    assert.equal(sv.precision, 96.8);
    assert.equal(sv.precision, computedPrecision);
    assert.deepEqual(sv.precision_ci, [92.1, 98.8]);
    assert.deepEqual(sv.precision_ci, wilson95Percent(sv.tp, predPos));

    assert.equal(sv.recall, 65.6);
    assert.equal(sv.recall, computedRecall);
    assert.deepEqual(sv.recall_ci, [58.5, 72.0]);
    assert.deepEqual(sv.recall_ci, wilson95Percent(sv.tp, gtPos));

    assert.equal(md.includes(`${sv.precision}%`), true);
    assert.equal(md.includes(`${sv.tp} / ${predPos}`), true);
    assert.match(md, new RegExp(`Wilson 95% CI ${sv.precision_ci[0].toFixed(1)}[^0-9]+${sv.precision_ci[1].toFixed(1)}%`));

    assert.equal(md.includes(`${sv.recall}%`), true);
    assert.equal(md.includes(`${sv.tp} / ${gtPos}`), true);
    assert.match(md, new RegExp(`${sv.recall_ci[0].toFixed(1)}[^0-9]+${sv.recall_ci[1].toFixed(1)}%`));

    assert.equal(res.map50_all, 0.572);
    assert.equal(res.map50_95_all, 0.357);
    assert.equal(res.precision_all, 0.742);
    assert.equal(res.recall_all, 0.531);
    assert.equal(
      md.includes(`${res.map50_all.toFixed(3)} (P ${res.precision_all.toFixed(3)}, R ${res.recall_all.toFixed(3)})`),
      true,
    );

    assert.equal(res.per_class.product.mAP50, 0.663);
    assert.equal(res.per_class.strength.mAP50, 0.607);
    assert.equal(res.per_class.expiry.mAP50, 0.616);
    assert.equal(res.per_class.allergens.mAP50, 0.401);
    for (const clsName of EXPECTED_CLASSES) {
      const expectedToken = `${clsName} ${res.per_class[clsName].mAP50.toFixed(3)}`;
      assert.equal(md.includes(expectedToken), true, `verda-fieldspotter.md must include "${expectedToken}"`);
    }

    assert.equal(res.latency_ms_onnx_cpu.n, 100);
    assert.equal(res.latency_ms_onnx_cpu.p50, 34.5);
    assert.equal(res.latency_ms_onnx_cpu.p95, 35.3);
    assert.equal(md.includes(`${res.latency_ms_onnx_cpu.n} images`), true);
    assert.equal(md.includes(`p50 ${res.latency_ms_onnx_cpu.p50.toFixed(1)} ms`), true);
    assert.equal(md.includes(`p95 ${res.latency_ms_onnx_cpu.p95.toFixed(1)} ms`), true);
    const approxFps = Math.round(1000 / res.latency_ms_onnx_cpu.p50);
    assert.equal(approxFps, 29);
    assert.equal(md.includes(`${approxFps} fps`), true);

    assert.equal(res.latency_ms_gpu_shared_h100.n, 348);
    assert.equal(res.latency_ms_gpu_shared_h100.p50, 17.9);
    assert.equal(res.latency_ms_gpu_shared_h100.p95, 39.1);
    assert.equal(md.includes(`p50 ${res.latency_ms_gpu_shared_h100.p50.toFixed(1)} ms`), true);
    assert.equal(md.includes(`p95 ${res.latency_ms_gpu_shared_h100.p95.toFixed(1)} ms`), true);

    const onnxDecimalMb = (res.onnx.bytes / 1_000_000).toFixed(1);
    assert.equal(onnxDecimalMb, "12.8");
    assert.equal(md.includes(`ONNX ${onnxDecimalMb} MB`), true);
    assert.equal(md.includes("web/public/models/fieldspotter.onnx"), true);
    assert.equal(md.includes("1,392 images"), true);
    assert.equal(md.includes("348 images and 896 boxes"), true);
    assert.equal(md.includes("1,740"), true);
  });
});
