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
];

const MARKDOWN_LINK_DOCS = [
  "README.md",
  "BRIEF.md",
  "GEMINI.md",
  "docs/PLAN.md",
  "docs/DEMO_SCRIPT.md",
  "docs/EVAL.md",
  "docs/PRIVACY.md",
  "docs/RESEARCH.md",
  "docs/SHOT_LIST.md",
  "docs/HARDWARE_NOTES.md",
  "docs/HUD_SPEC.md",
  "docs/USER_TEST_KIT.md",
] as const;

type EvalFieldMetrics = {
  n: number;
  n_visible: number;
  acc_visible: number;
  abstain_visible: number;
  wrong_visible: number;
  confident_wrong: number;
  confident_wrong_of_confident: number;
  k: {
    confident: number;
  };
};

type EvalV1Results = {
  model: string;
  conf_threshold: number;
  synthetic: {
    images_scored: number;
    errors: number;
    latency_s: {
      n: number;
      p50: number;
      p95: number;
    };
    per_field: {
      product: EvalFieldMetrics;
      strength: EvalFieldMetrics;
    };
    calibration_all: {
      n_answered: number;
      ece: number;
      ece_ci: [number, number];
    };
    dataset: {
      specs: number;
      images: number;
      renders_kept: number;
      by_deg: {
        clean: number;
        back_of_box: number;
      };
    };
  };
};

type EvalV2SafetyRescore = {
  images: number;
  verdicts_n: number;
  unsafe_reassurance_silent: {
    k: number;
    n: number;
    wilson95_pct: [number, number];
  };
  food_reassurance_coverage: {
    n_truly_safe: number;
    said_none_of_your_allergens: number;
  };
  baseline: {
    unsafe_reassurance_silent: {
      k: number;
      n: number;
      wilson95_pct: [number, number];
    };
    food_reassurance_coverage: {
      n_truly_safe: number;
      said_none_of_your_allergens: number;
    };
  };
};

type ModelCompareEntry = {
  strength_acc_readable: { k: number; n: number; pct: number };
  strength_confident_wrong: { k: number; n: number; pct: number };
  fields_confident_wrong: { k: number; n: number; pct: number };
  unsafe_reassurance: { k: number; n: number; pct: number };
  latency: { n: number; p50_s: number; p95_s: number };
};

type EvalV2ModelCompare = {
  n_images: number;
  reference: string;
  models: {
    "gemini-3.8-flash": ModelCompareEntry;
    "gemini-3.5-flash": ModelCompareEntry;
    "gemma-4-31b-it": ModelCompareEntry;
  };
};

type FieldSpotterEval = {
  n_val_images: number;
  map50_all: number;
  strength_visible: {
    conf: number;
    tp: number;
    fp: number;
    precision: number;
    precision_ci: [number, number];
    recall: number;
  };
  onnx: {
    bytes: number;
  };
  latency_ms_onnx_cpu: {
    n: number;
    p50: number;
    p95: number;
  };
};

type FieldSpotterSplit = {
  images: {
    train: number;
    val: number;
  };
};

type AxeAuditReport = {
  tool: string;
  tags: string;
  totalViolationNodes: number;
  results: Array<{
    label: string;
    url: string;
    violations: unknown[];
    passes: number;
  }>;
};

function readRepoFile(relPath: string): string {
  return fs.readFileSync(path.join(REPO_DIR, relPath), "utf8");
}

function roundToDecimals(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function stripFencedCodeBlocks(markdown: string): string {
  return markdown.replace(/```[\s\S]*?```/g, "");
}

function decodeHtmlText(fragment: string): string {
  const withoutComments = fragment.replace(new RegExp(`${HTML_COMMENT}[\\s\\S]*?-->`, "g"), "");
  const withoutInlineTags = withoutComments.replace(/<\/?(?:small|b|strong|i|em|code|span|q|sub|sup)\b[^>]*>/gi, "");
  const withoutTags = withoutInlineTags.replace(/<[^>]+>/g, " ");
  const entities: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
    "&nbsp;": " ",
    "&middot;": "\u00b7",
    "&ndash;": "\u2013",
    "&times;": "\u00d7",
    "&ldquo;": "\u201c",
    "&rdquo;": "\u201d",
    "&lsquo;": "\u2018",
    "&rsquo;": "\u2019",
  };
  return withoutTags
    .replace(/&[a-zA-Z0-9#]+;/g, (ent) => entities[ent] ?? ent)
    .replace(/\s+/g, " ")
    .trim();
}

function extractSlides(deckHtml: string): string[] {
  const withoutComments = deckHtml.replace(new RegExp(`${HTML_COMMENT}[\\s\\S]*?-->`, "g"), "");
  return withoutComments.match(/<section\s+class="slide(?:\s+[^"]*)?"[\s\S]*?<\/section>/g) ?? [];
}

function findSlideText(slides: string[], headingId: string): string {
  const slide = slides.find((item) => item.includes(`id="${headingId}"`));
  assert.ok(slide, `Expected slide with heading id="${headingId}" in deck/index.html`);
  return decodeHtmlText(slide);
}

function collectMarkdownFiles(dirAbsPath: string): string[] {
  const collected: string[] = [];
  for (const entry of fs.readdirSync(dirAbsPath, { withFileTypes: true })) {
    const fullPath = path.join(dirAbsPath, entry.name);
    if (entry.isDirectory()) {
      collected.push(...collectMarkdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      collected.push(path.relative(REPO_DIR, fullPath).split(path.sep).join("/"));
    }
  }
  return collected.sort();
}

function readExportedConstNumber(tsSource: string, constName: string): number {
  const re = new RegExp(`export\\s+const\\s+${constName}\\s*=\\s*([0-9]+(?:\\.[0-9]+)?)\\s*;`);
  const match = re.exec(tsSource);
  assert.ok(match, `Expected exported numeric constant ${constName} in server/src/safety.ts`);
  return Number(match[1]);
}

function isPlannedFutureCapturePath(repoRelPosix: string): boolean {
  return repoRelPosix === "docs/USER_FEEDBACK.md" || repoRelPosix.startsWith("docs/img/hw/");
}

function extractMarkdownTargets(markdown: string): string[] {
  const stripped = stripFencedCodeBlocks(markdown);
  const targets: string[] = [];
  const inlineRe = /!?\[([^\]]*)\]\(([^)]+)\)/g;
  for (const match of stripped.matchAll(inlineRe)) {
    const token = match[2].trim().replace(/^<|>$/g, "").split(/\s+/)[0] ?? "";
    if (token.length > 0) targets.push(token);
  }
  const refDefRe = /^\s*\[[^\]]+\]:\s*(\S+)/gm;
  for (const match of stripped.matchAll(refDefRe)) {
    const token = match[1].trim().replace(/^<|>$/g, "");
    if (token.length > 0) targets.push(token);
  }
  return targets;
}

describe("Cross-repo docs, deck, and evidence parity contract", () => {
  test("resolves relative markdown links across all 12 core root and docs markdown files to existing repo paths", () => {
    const verifiedTargets = new Set<string>();
    let checkedCount = 0;

    for (const docRelPath of MARKDOWN_LINK_DOCS) {
      const docAbsPath = path.join(REPO_DIR, docRelPath);
      assert.equal(fs.existsSync(docAbsPath), true, `Expected markdown doc ${docRelPath} to exist`);
      const content = fs.readFileSync(docAbsPath, "utf8");
      assert.ok(content.trim().length > 0, `Expected ${docRelPath} to be non-empty`);

      for (const rawTarget of extractMarkdownTargets(content)) {
        if (rawTarget.startsWith("#") || /^(?:https?:|mailto:)/i.test(rawTarget)) {
          continue;
        }

        const pathOnly = rawTarget.split("#")[0]?.split("?")[0]?.trim() ?? "";
        if (pathOnly.length === 0) {
          continue;
        }

        const resolvedAbs = path.resolve(path.dirname(docAbsPath), pathOnly);
        const repoRelPosix = path.relative(REPO_DIR, resolvedAbs).split(path.sep).join("/");
        assert.equal(
          repoRelPosix.startsWith(".."),
          false,
          `${docRelPath} link "${rawTarget}" escapes repository root (${repoRelPosix})`,
        );

        if (isPlannedFutureCapturePath(repoRelPosix)) {
          continue;
        }

        assert.equal(
          fs.existsSync(resolvedAbs),
          true,
          `${docRelPath} links to missing repo file "${rawTarget}" (resolved to ${repoRelPosix})`,
        );
        verifiedTargets.add(repoRelPosix);
        checkedCount++;
      }
    }

    assert.ok(checkedCount >= 18, `Expected at least 18 relative markdown links checked, got ${checkedCount}`);
    assert.equal(verifiedTargets.has("GEMINI.md"), true);
    assert.equal(verifiedTargets.has("shared/types.ts"), true);
    assert.equal(verifiedTargets.has("docs/HARDWARE_NOTES.md"), true);
    assert.equal(verifiedTargets.has("docs/img/eval_model_compare.png"), true);
  });

  test("verifies eval/results/v1_results.json ground truth matches Deck Slides 7 & 10, GEMINI.md, docs/EVAL.md, and docs/DEMO_SCRIPT.md", () => {
    const v1 = JSON.parse(readRepoFile("eval/results/v1_results.json")) as EvalV1Results;

    assert.equal(v1.model, "gemini-3.8-flash");
    assert.equal(v1.conf_threshold, 0.8);
    assert.equal(v1.synthetic.images_scored, 1740);
    assert.equal(v1.synthetic.errors, 0);
    assert.equal(v1.synthetic.dataset.specs, 172);
    assert.equal(v1.synthetic.dataset.renders_kept, 210);
    assert.equal(v1.synthetic.dataset.by_deg.clean, 170);
    assert.equal(v1.synthetic.dataset.by_deg.back_of_box, 40);

    assert.equal(v1.synthetic.per_field.strength.confident_wrong, 0);
    assert.equal(v1.synthetic.per_field.strength.k.confident, 754);
    assert.equal(roundToDecimals((3 / v1.synthetic.per_field.strength.k.confident) * 100, 1), 0.4);

    assert.equal(v1.synthetic.per_field.product.confident_wrong, 42);
    assert.equal(v1.synthetic.per_field.product.k.confident, 1173);
    assert.equal(v1.synthetic.per_field.product.confident_wrong_of_confident, 3.6);

    assert.equal(v1.synthetic.per_field.strength.n_visible, 926);
    assert.equal(v1.synthetic.per_field.strength.wrong_visible, 0);
    assert.equal(v1.synthetic.per_field.strength.acc_visible, 83.2);
    assert.equal(v1.synthetic.per_field.strength.abstain_visible, 16.8);

    assert.equal(v1.synthetic.calibration_all.ece, 0.022);
    assert.deepEqual(v1.synthetic.calibration_all.ece_ci, [0.018, 0.028]);

    assert.equal(v1.synthetic.latency_s.n, 1740);
    assert.equal(v1.synthetic.latency_s.p50, 3.43);
    assert.equal(v1.synthetic.latency_s.p95, 5.55);
    assert.equal(roundToDecimals(v1.synthetic.latency_s.p50, 1), 3.4);
    assert.equal(roundToDecimals(v1.synthetic.latency_s.p95, 1), 5.6);

    const deckSlides = extractSlides(readRepoFile("deck/index.html"));
    const slide7 = findSlideText(deckSlides, "s7-h");
    const slide10 = findSlideText(deckSlides, "s11-h");
    const geminiDoc = readRepoFile("GEMINI.md");
    const evalDoc = readRepoFile("docs/EVAL.md");
    const demoScript = readRepoFile("docs/DEMO_SCRIPT.md");

    for (const token of [
      "1,740",
      "172 Gemini-written labels",
      "210 renders (170 front, 40 back)",
      "0 API errors",
      "0/754",
      "0.8",
      "0.4%",
      "42/1,173",
      "3.6%",
      "0% wrong strength when readable",
      "n=926",
      "0.022",
      "0.018",
      "0.028",
    ]) {
      assert.ok(slide10.includes(token), `Deck Slide 10 (#s11-h) must include "${token}"`);
    }

    for (const token of ["3.4 s p50", "5.6 s p95", "1,740"]) {
      assert.ok(slide7.includes(token), `Deck Slide 7 (#s7-h) must include "${token}"`);
    }

    for (const token of [
      "1,740",
      "0 of 754",
      "0.4%",
      "0.022",
      "0.018",
      "0.028",
      "p50 3.43 s, p95 5.55 s",
    ]) {
      assert.ok(geminiDoc.includes(token), `GEMINI.md must include "${token}"`);
    }

    for (const token of [
      "1,740 images, 0 API errors",
      "0 / 754",
      "0.4%",
      "n = 926",
      "83.2%",
      "16.8%",
      "0.0% wrong",
      "42 / 1,173 = 3.6%",
      "0.022",
      "0.018",
      "0.028",
      "p50 3.43 s",
      "p95 5.55 s",
    ]) {
      assert.ok(evalDoc.includes(token), `docs/EVAL.md must include "${token}"`);
    }

    assert.ok(demoScript.includes("1,740 test images"));
    assert.ok(demoScript.includes("Out of 754 confident strength reads, zero were wrong"));
  });

  test("verifies eval/results/v2_safety_rescore.json unsafe-reassurance and safe-food parity across deck and docs", () => {
    const v2Rescore = JSON.parse(readRepoFile("eval/results/v2_safety_rescore.json")) as EvalV2SafetyRescore;

    assert.equal(v2Rescore.images, 1740);
    assert.equal(v2Rescore.verdicts_n, 4730);
    assert.equal(v2Rescore.unsafe_reassurance_silent.k, 3);
    assert.equal(v2Rescore.unsafe_reassurance_silent.n, 4730);
    assert.equal(
      roundToDecimals(
        (v2Rescore.unsafe_reassurance_silent.k / v2Rescore.unsafe_reassurance_silent.n) * 100,
        2,
      ),
      0.06,
    );
    assert.deepEqual(v2Rescore.unsafe_reassurance_silent.wilson95_pct, [0.02, 0.19]);

    assert.equal(v2Rescore.baseline.unsafe_reassurance_silent.k, 49);
    assert.equal(v2Rescore.baseline.unsafe_reassurance_silent.n, 4730);
    assert.equal(
      roundToDecimals(
        (v2Rescore.baseline.unsafe_reassurance_silent.k / v2Rescore.baseline.unsafe_reassurance_silent.n) * 100,
        1,
      ),
      1.0,
    );
    assert.equal(
      roundToDecimals(
        (v2Rescore.baseline.unsafe_reassurance_silent.k / v2Rescore.baseline.unsafe_reassurance_silent.n) * 100,
        2,
      ),
      1.04,
    );
    assert.deepEqual(v2Rescore.baseline.unsafe_reassurance_silent.wilson95_pct, [0.78, 1.37]);

    assert.equal(v2Rescore.food_reassurance_coverage.n_truly_safe, 130);
    assert.equal(v2Rescore.food_reassurance_coverage.said_none_of_your_allergens, 44);
    assert.equal(roundToDecimals((44 / 130) * 100, 1), 33.8);
    assert.equal(Math.round((44 / 130) * 100), 34);

    assert.equal(v2Rescore.baseline.food_reassurance_coverage.n_truly_safe, 130);
    assert.equal(v2Rescore.baseline.food_reassurance_coverage.said_none_of_your_allergens, 88);
    assert.equal(roundToDecimals((88 / 130) * 100, 1), 67.7);
    assert.equal(Math.round((88 / 130) * 100), 68);

    const slide10 = findSlideText(extractSlides(readRepoFile("deck/index.html")), "s11-h");
    const geminiDoc = readRepoFile("GEMINI.md");
    const evalDoc = readRepoFile("docs/EVAL.md");
    const demoScript = readRepoFile("docs/DEMO_SCRIPT.md");

    for (const token of ["0.06%", "3/4,730", "0.02", "0.19%", "49 = 1.0%", "34% vs 68%"]) {
      assert.ok(slide10.includes(token), `Deck Slide 10 (#s11-h) must include "${token}"`);
    }

    for (const token of ["1.0% (49/4,730)", "0.06% (3/4,730", "0.02", "0.19%"]) {
      assert.ok(geminiDoc.includes(token), `GEMINI.md must include "${token}"`);
    }

    for (const token of [
      "49 / 4,730 (1.04%)",
      "49 = 1.0%",
      "3 / 4,730 = 0.06%",
      "0.02",
      "0.19%",
      "n = 130",
      "88 = 67.7%",
      "44 = 33.8%",
    ]) {
      assert.ok(evalDoc.includes(token), `docs/EVAL.md must include "${token}"`);
    }

    assert.ok(demoScript.includes("3 in 4,730"));
    assert.ok(demoScript.includes("down from 49"));
  });

  test("verifies eval/results/v2_model_compare.json and docs/img/eval_model_compare.png parity with Slide 7, GEMINI.md, and docs/EVAL.md", () => {
    const v2Compare = JSON.parse(readRepoFile("eval/results/v2_model_compare.json")) as EvalV2ModelCompare;

    assert.equal(v2Compare.n_images, 150);
    assert.equal(v2Compare.reference, "gemini-3.8-flash");
    const flash38 = v2Compare.models["gemini-3.8-flash"];
    const flash35 = v2Compare.models["gemini-3.5-flash"];
    const gemma31b = v2Compare.models["gemma-4-31b-it"];

    assert.equal(flash38.strength_confident_wrong.k, 0);
    assert.equal(flash35.strength_confident_wrong.k, 0);
    assert.equal(gemma31b.strength_confident_wrong.k, 0);
    assert.equal(flash38.strength_acc_readable.k, 46);
    assert.equal(flash38.strength_acc_readable.n, 59);
    assert.equal(gemma31b.strength_acc_readable.k, 46);
    assert.equal(gemma31b.strength_acc_readable.n, 59);

    assert.equal(flash38.fields_confident_wrong.k, 19);
    assert.equal(flash38.fields_confident_wrong.n, 528);
    assert.equal(flash38.fields_confident_wrong.pct, 3.6);
    assert.equal(gemma31b.fields_confident_wrong.k, 38);
    assert.equal(gemma31b.fields_confident_wrong.n, 528);
    assert.equal(gemma31b.fields_confident_wrong.pct, 7.2);

    assert.equal(flash38.unsafe_reassurance.k, 0);
    assert.equal(flash38.unsafe_reassurance.n, 377);
    assert.equal(gemma31b.unsafe_reassurance.k, 2);
    assert.equal(gemma31b.unsafe_reassurance.n, 377);

    assert.equal(roundToDecimals(flash38.latency.p50_s, 1), 3.2);
    assert.equal(roundToDecimals(gemma31b.latency.p50_s, 1), 27.8);
    assert.equal(Math.round(gemma31b.latency.p50_s / flash38.latency.p50_s), 9);

    const slide7 = findSlideText(extractSlides(readRepoFile("deck/index.html")), "s7-h");
    const geminiDoc = readRepoFile("GEMINI.md");
    const evalDoc = readRepoFile("docs/EVAL.md");

    for (const token of ["150 paired images", "0 confident-wrong strengths", "7.2% vs 3.6%", "2/377"]) {
      assert.ok(slide7.includes(token), `Deck Slide 7 (#s7-h) must include "${token}"`);
    }
    assert.match(slide7, /~9\s*[x\u00d7]\s*slower/i);

    for (const token of [
      "150 paired images",
      "gemma-4-31b-it",
      "46/59",
      "7.2% vs 3.6%",
      "2/377",
      "27.8 s vs 3.2 s",
      "docs/img/eval_model_compare.png",
    ]) {
      assert.ok(geminiDoc.includes(token), `GEMINI.md must include "${token}"`);
    }
    assert.match(geminiDoc, /~9\s*[x\u00d7]\s*slower/i);

    for (const token of [
      "n = 150 images",
      "gemma-4-31b-it",
      "19 = 3.6%",
      "38 = 7.2%",
      "n = 377",
      "2 = 0.53%",
      "3.2 s",
      "27.8 s",
    ]) {
      assert.ok(evalDoc.includes(token), `docs/EVAL.md must include "${token}"`);
    }
    assert.match(evalDoc, /9\s*[x\u00d7]\s*slower/i);

    const chartPath = path.join(REPO_DIR, "docs/img/eval_model_compare.png");
    assert.equal(fs.existsSync(chartPath), true, "docs/img/eval_model_compare.png must exist");
    const pngBytes = fs.readFileSync(chartPath);
    assert.ok(pngBytes.length >= 10_000, `Expected non-trivial PNG size, got ${pngBytes.length} bytes`);
    assert.deepEqual(
      [...pngBytes.subarray(0, 8)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      "docs/img/eval_model_compare.png must start with valid PNG magic bytes",
    );
  });

  test("verifies FieldSpotter ONNX binary size, split counts, and latency/precision parity with verda-fieldspotter.md", () => {
    const fieldSpotter = JSON.parse(readRepoFile("eval/results/fieldspotter.json")) as FieldSpotterEval;
    const split = JSON.parse(readRepoFile("docs/evidence/fieldspotter/split.json")) as FieldSpotterSplit;
    const verdaDoc = readRepoFile("docs/evidence/verda-fieldspotter.md");
    const onnxPath = path.join(REPO_DIR, "web/public/models/fieldspotter.onnx");

    assert.equal(fs.existsSync(onnxPath), true, "web/public/models/fieldspotter.onnx must exist");
    const onnxStat = fs.statSync(onnxPath);
    assert.equal(fieldSpotter.onnx.bytes, 12776109);
    assert.equal(onnxStat.size, fieldSpotter.onnx.bytes);
    assert.equal(onnxStat.size, 12776109);
    assert.equal(roundToDecimals(onnxStat.size / 1_000_000, 1), 12.8);

    assert.equal(split.images.train, 1392);
    assert.equal(split.images.val, 348);
    assert.equal(split.images.train + split.images.val, 1740);
    assert.equal(fieldSpotter.n_val_images, split.images.val);

    assert.equal(fieldSpotter.strength_visible.tp, 122);
    assert.equal(fieldSpotter.strength_visible.fp, 4);
    assert.equal(fieldSpotter.strength_visible.precision, 96.8);
    assert.deepEqual(fieldSpotter.strength_visible.precision_ci, [92.1, 98.8]);
    assert.equal(fieldSpotter.latency_ms_onnx_cpu.n, 100);
    assert.equal(fieldSpotter.latency_ms_onnx_cpu.p50, 34.5);
    assert.equal(fieldSpotter.latency_ms_onnx_cpu.p95, 35.3);

    for (const token of [
      "1,740",
      "1,392",
      "348",
      "96.8%",
      "122 / 126",
      "p50 34.5 ms",
      "p95 35.3 ms",
      "12.8 MB",
      "web/public/models/fieldspotter.onnx",
    ]) {
      assert.ok(verdaDoc.includes(token), `docs/evidence/verda-fieldspotter.md must include "${token}"`);
    }

    assert.equal(fs.existsSync(path.join(REPO_DIR, "docs/evidence/fieldspotter/args.yaml")), true);
    assert.equal(fs.existsSync(path.join(REPO_DIR, "docs/evidence/fieldspotter/results.csv")), true);
  });

  test("verifies docs/evidence/a11y-axe.json reports 0 WCAG 2.2 A+AA violations across all audited screens matching README.md", () => {
    const axe = JSON.parse(readRepoFile("docs/evidence/a11y-axe.json")) as AxeAuditReport;
    const readme = readRepoFile("README.md");

    assert.match(axe.tags, /WCAG.*2\.2.*A\+AA/);
    assert.equal(axe.totalViolationNodes, 0);
    assert.ok(axe.results.length >= 6, `Expected at least 6 audited screens, got ${axe.results.length}`);

    for (const screen of axe.results) {
      assert.equal(
        screen.violations.length,
        0,
        `Audited screen "${screen.label}" must have 0 WCAG 2.2 A+AA violations`,
      );
      assert.ok(screen.passes > 0, `Audited screen "${screen.label}" must record positive rule passes`);
    }

    assert.ok(readme.includes("docs/evidence/a11y-axe.json"));
    assert.ok(
      readme.includes(`axe-core WCAG 2.2 A+AA: 0 violations on ${axe.results.length} screens`),
      `README.md must match ${axe.results.length} audited screens with 0 WCAG 2.2 A+AA violations`,
    );
  });

  test("verifies deterministic server/src/safety.ts confidence gates match README.md, GEMINI.md, Deck Slide 8, and docs/EVAL.md", () => {
    const safetyTs = readRepoFile("server/src/safety.ts");
    const strengthMinConf = readExportedConstNumber(safetyTs, "STRENGTH_MIN_CONF");
    const matchNameMinConf = readExportedConstNumber(safetyTs, "MATCH_NAME_MIN_CONF");
    const allergenSafeConf = readExportedConstNumber(safetyTs, "ALLERGEN_SAFE_CONF");
    const allergenSafeReadability = readExportedConstNumber(safetyTs, "ALLERGEN_SAFE_READABILITY");

    assert.equal(strengthMinConf, 0.8);
    assert.equal(matchNameMinConf, 0.8);
    assert.equal(allergenSafeConf, 0.95);
    assert.equal(allergenSafeReadability, 0.8);

    const readme = readRepoFile("README.md");
    const geminiDoc = readRepoFile("GEMINI.md");
    const evalDoc = readRepoFile("docs/EVAL.md");
    const slide8 = findSlideText(extractSlides(readRepoFile("deck/index.html")), "s8-h");

    assert.ok(readme.includes("safety.ts"));
    assert.ok(readme.includes(String(strengthMinConf)));
    assert.ok(readme.includes(String(allergenSafeConf)));

    assert.ok(geminiDoc.includes("safety.ts"));
    assert.ok(geminiDoc.includes(`< ${strengthMinConf}`));
    assert.ok(geminiDoc.includes(`< ${allergenSafeConf}`));

    assert.ok(slide8.includes("safety.ts"));
    assert.match(slide8, new RegExp(`confidence\\s*(?:>=|\u2265)\\s*${strengthMinConf}`));
    assert.match(slide8, new RegExp(`confident name\\s*\\((?:>=|\u2265)\\s*${matchNameMinConf}\\)`));

    assert.ok(evalDoc.includes("server/src/safety.ts"));
    assert.match(evalDoc, new RegExp(`conf(?:idence)?\\s*(?:>=|\u2265)\\s*${strengthMinConf}`));
    assert.match(evalDoc, new RegExp(`(?:allergen\\s+)?conf(?:idence)?\\s*(?:>=|\u2265)\\s*${allergenSafeConf}`));
    assert.match(evalDoc, new RegExp(`readability\\s*(?:>=|\u2265)\\s*${allergenSafeReadability}`));
  });

  test("enforces zero leaked live secret prefixes across deck/index.html, GEMINI.md, and all docs markdown files plus strict test-file hygiene", () => {
    const docsMarkdownFiles = collectMarkdownFiles(path.join(REPO_DIR, "docs"));
    assert.ok(
      docsMarkdownFiles.length >= 14,
      `Expected at least 14 markdown files under docs/, got ${docsMarkdownFiles.length}`,
    );

    const secretScanTargets = ["deck/index.html", "GEMINI.md", "README.md", "BRIEF.md", ...docsMarkdownFiles];
    for (const relPath of secretScanTargets) {
      const content = readRepoFile(relPath);
      for (const secretPrefix of SECRET_PREFIXES) {
        assert.equal(
          content.includes(secretPrefix),
          false,
          `${relPath} must not contain live secret prefix "${secretPrefix}"`,
        );
      }
    }

    const selfSource = fs.readFileSync(SELF_FILE, "utf8");
    assert.equal(selfSource.includes(LINE_COMMENT), false, "Self-check: zero line comments");
    assert.equal(selfSource.includes(BLOCK_COMMENT), false, "Self-check: zero block comments");
    assert.equal(selfSource.includes(HTML_COMMENT), false, "Self-check: zero HTML comments");
    assert.equal(selfSource.includes(EM_DASH), false, "Self-check: zero em dashes");
    assert.equal(selfSource.includes(ESCAPED_EM_DASH), false, "Self-check: zero escaped em dashes");
  });
});
