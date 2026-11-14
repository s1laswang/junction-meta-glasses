import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(TEST_DIR, "..", "..");
const EM_DASH = String.fromCodePoint(0x2014);

type QaSection = {
  id: string;
  heading: string;
  question: string;
  answer: string;
  source: string;
  raw: string;
};

type ApiFeatureStats = {
  calls: number;
  ok: number;
  errors: number;
  tokens_in: number;
  tokens_out: number;
  tokens_thinking: number;
  models: Record<string, number>;
  first_audio_p50_s?: number;
  first_audio_p95_s?: number;
};

type ApiStatsSnapshot = {
  total: number;
  features: {
    live: ApiFeatureStats & {
      first_audio_p50_s: number;
      first_audio_p95_s: number;
    };
    verify: ApiFeatureStats;
    verify_spec: ApiFeatureStats;
  };
};

type EvalV1Results = {
  model: string;
  synthetic: {
    images_scored: number;
    per_field: {
      strength: {
        confident_wrong: number;
        k: {
          confident: number;
        };
      };
    };
    calibration_all: {
      ece: number;
      ece_ci: [number, number];
    };
  };
};

type SafetyRescoreResults = {
  images: number;
  verdicts_n: number;
  unsafe_reassurance_silent: {
    k: number;
    n: number;
    wilson95_pct: [number, number];
  };
};

type ModelCompareEntry = {
  fields_confident_wrong: {
    k: number;
    n: number;
    pct: number;
  };
  unsafe_reassurance: {
    k: number;
    n: number;
  };
  latency: {
    n: number;
    p50_s: number;
    p95_s: number;
  };
};

type ModelCompareResults = {
  n_images: number;
  models: {
    "gemini-3.8-flash": ModelCompareEntry;
    "gemma-4-31b-it": ModelCompareEntry;
  };
};

type FieldSpotterResults = {
  n_val_images: number;
  map50_all: number;
  strength_visible: {
    tp: number;
    fp: number;
    fn: number;
    tn: number;
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
  val_src_ids: string[];
};

function readRepoFile(relPath: string): string {
  return fs.readFileSync(path.join(REPO_DIR, relPath), "utf8");
}

function formatInt(n: number): string {
  return n.toLocaleString("en-US");
}

function roundTenth(n: number): string {
  return (Math.round(n * 10) / 10).toFixed(1);
}

function splitSpokenSentences(text: string): string[] {
  return text
    .trim()
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseJudgeQa(markdown: string): Map<string, QaSection> {
  const headingRe = /^## \(([a-f])\) (.+)$/gm;
  const matches = [...markdown.matchAll(headingRe)];
  assert.equal(matches.length, 6, "docs/JUDGE_QA.md must contain exact 6 sections (a) through (f)");

  const sections = new Map<string, QaSection>();
  matches.forEach((m, idx) => {
    const id = m[1];
    const heading = m[2].trim();
    const start = (m.index ?? 0) + m[0].length;
    const end = idx + 1 < matches.length ? (matches[idx + 1].index ?? markdown.length) : markdown.length;
    const raw = markdown.slice(start, end).trim();

    const qMatch = /^\*\*Question:\*\*\s+(.+)$/m.exec(raw);
    const aMatch = /^\*\*Answer:\*\*\s+(.+)$/m.exec(raw);
    const sMatch = /^\*\*Source:\*\*\s+(.+)$/m.exec(raw);

    assert.ok(qMatch, `Section (${id}) must include a **Question:** line`);
    assert.ok(aMatch, `Section (${id}) must include an **Answer:** line`);
    assert.ok(sMatch, `Section (${id}) must include a **Source:** line`);

    sections.set(id, {
      id,
      heading,
      question: qMatch[1].trim(),
      answer: aMatch[1].trim(),
      source: sMatch[1].trim(),
      raw,
    });
  });

  return sections;
}

describe("docs/JUDGE_QA.md stage & grand jury Q&A contract", () => {
  const judgeQa = readRepoFile("docs/JUDGE_QA.md");
  const sections = parseJudgeQa(judgeQa);

  test("contains zero em dashes (U+2014) and enforces 6 sections (a)-(f) with crisp 2-sentence answers + repo source lines", () => {
    assert.equal(
      judgeQa.includes(EM_DASH),
      false,
      "docs/JUDGE_QA.md must contain zero em dashes (U+2014)",
    );

    const expectedIds = ["a", "b", "c", "d", "e", "f"];
    assert.deepEqual([...sections.keys()], expectedIds);

    for (const id of expectedIds) {
      const sec = sections.get(id)!;
      assert.ok(sec.heading.length >= 10, `Section (${id}) heading must be descriptive`);
      assert.ok(sec.question.endsWith("?"), `Section (${id}) question must end with "?"`);

      const sentences = splitSpokenSentences(sec.answer);
      assert.equal(
        sentences.length,
        2,
        `Section (${id}) answer must be exact 2 sentences, got ${sentences.length}`,
      );
      for (const sentence of sentences) {
        assert.match(sentence, /[.!?]$/, `Every sentence in section (${id}) must end with punctuation`);
        assert.ok(sentence.length >= 40, `Sentence in section (${id}) must be substantive`);
      }

      const sourceTokens = [...sec.source.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
      assert.ok(
        sourceTokens.length >= 3,
        `Section (${id}) **Source:** line must cite at least 3 backticked repo paths`,
      );
    }
  });

  test("resolves every cited repo file path and line range in docs/JUDGE_QA.md to real files on disk", () => {
    const codeSpanRe = /`([^`]+)`/g;
    const repoPathRe = new RegExp(
      "^(?:GEMINI\\.md|README\\.md|(?:docs|eval|server|web|shared|deck|android-dat|scripts)\\x2f[A-Za-z0-9_./-]+)(?::(\\d+)(?:-(\\d+))?)?$",
    );

    const allSpans = [...judgeQa.matchAll(codeSpanRe)].map((m) => m[1]);
    let verifiedCount = 0;

    for (const span of allSpans) {
      const match = repoPathRe.exec(span);
      if (!match) continue;

      const [fullRef, startStr, endStr] = match;
      const relFile = fullRef.split(":")[0];
      const absFile = path.join(REPO_DIR, relFile);

      assert.equal(fs.existsSync(absFile), true, `Cited repo file must exist: ${relFile}`);
      assert.equal(fs.statSync(absFile).isFile(), true, `Cited repo path must be a file: ${relFile}`);
      verifiedCount++;

      if (startStr !== undefined) {
        const startLine = Number.parseInt(startStr, 10);
        const endLine = endStr !== undefined ? Number.parseInt(endStr, 10) : startLine;
        const lineCount = readRepoFile(relFile).split("\n").length;

        assert.ok(startLine >= 1, `Start line must be >= 1 in ${fullRef}`);
        assert.ok(endLine >= startLine, `End line must be >= start line in ${fullRef}`);
        assert.ok(
          endLine <= lineCount,
          `Cited line range ${fullRef} exceeds file length (${lineCount} lines)`,
        );
      }
    }

    assert.ok(verifiedCount >= 30, `Expected at least 30 verified repo references, found ${verifiedCount}`);
  });

  test("section (a) & (b) match competitive, EU MDR Rule 11, pilot, and epidemiology facts in RESEARCH.md, safety.ts, and deck/index.html", () => {
    const research = readRepoFile("docs/RESEARCH.md");
    const safetyTs = readRepoFile("server/src/safety.ts");
    const deckHtml = readRepoFile("deck/index.html");

    assert.ok(research.includes("Be My Eyes"));
    assert.ok(research.includes("21 markets"));
    assert.ok(safetyTs.includes("export const STRENGTH_MIN_CONF = 0.8;"));
    assert.ok(safetyTs.includes("export const ALLERGEN_SAFE_CONF = 0.95;"));

    const secA = sections.get("a")!;
    for (const token of [
      "Seeing AI",
      "third hand",
      "OCR",
      "Be My Eyes",
      "21 markets",
      '"Hey Meta"',
      "safety.ts",
      "< 0.8",
      "< 0.95",
      "DataMatrix",
    ]) {
      assert.ok(secA.answer.includes(token), `Section (a) answer must cite ${token}`);
    }

    assert.ok(deckHtml.includes("Class IIa, Rule 11"));
    assert.ok(deckHtml.includes("4-week"));
    assert.ok(deckHtml.includes("20 members"));
    assert.ok(deckHtml.includes("Näkövammaisten liitto"));
    assert.ok(research.includes("55,000"));
    assert.ok(research.includes("45,000"));
    assert.ok(research.includes("21.6% (2025)"));
    assert.ok(research.includes("Fimea"));

    const secB = sections.get("b")!;
    for (const token of [
      "EU MDR Class IIa (Rule 11)",
      "not a certified medical device",
      "pharmacist",
      "4-week",
      "20-member",
      "Näkövammaisten liitto (NKL)",
      "prescription-pickup",
      "wellbeing services counties' home-care nurses",
      "~55,000",
      "~45,000",
      "21.6%",
      "10+ medicines",
      "Fimea 2025",
    ]) {
      assert.ok(secB.answer.includes(token), `Section (b) answer must cite ${token}`);
    }
  });

  test("section (c) cites exact Live latency, v1/v2 safety calibration, and paired Gemma 4 31B metrics from eval/results JSONs and api-stats-snapshot.json", () => {
    const stats = JSON.parse(readRepoFile("docs/evidence/api-stats-snapshot.json")) as ApiStatsSnapshot;
    const v1 = JSON.parse(readRepoFile("eval/results/v1_results.json")) as EvalV1Results;
    const v2Safety = JSON.parse(readRepoFile("eval/results/v2_safety_rescore.json")) as SafetyRescoreResults;
    const v2Compare = JSON.parse(readRepoFile("eval/results/v2_model_compare.json")) as ModelCompareResults;
    const smokeRuns = readRepoFile("docs/evidence/smoke-runs.md");

    assert.ok(smokeRuns.includes("5.8 s"));
    assert.equal(stats.features.live.ok, 26);

    const liveP50 = roundTenth(stats.features.live.first_audio_p50_s);
    const liveP95 = roundTenth(stats.features.live.first_audio_p95_s);
    assert.equal(liveP50, "2.1");
    assert.equal(liveP95, "3.4");

    const strengthWrong = v1.synthetic.per_field.strength.confident_wrong;
    const strengthConfident = v1.synthetic.per_field.strength.k.confident;
    const ruleOfThreeUpper = ((3 / strengthConfident) * 100).toFixed(1);
    assert.equal(strengthWrong, 0);
    assert.equal(strengthConfident, 754);
    assert.equal(ruleOfThreeUpper, "0.4");
    assert.equal(v1.synthetic.calibration_all.ece, 0.022);
    assert.equal(v1.synthetic.images_scored, 1740);

    const unsafeK = v2Safety.unsafe_reassurance_silent.k;
    const unsafeN = v2Safety.unsafe_reassurance_silent.n;
    const unsafePct = ((unsafeK / unsafeN) * 100).toFixed(2);
    const [ciLow, ciHigh] = v2Safety.unsafe_reassurance_silent.wilson95_pct;
    assert.equal(unsafeK, 3);
    assert.equal(unsafeN, 4730);
    assert.equal(unsafePct, "0.06");

    const flash = v2Compare.models["gemini-3.8-flash"];
    const gemma = v2Compare.models["gemma-4-31b-it"];
    assert.equal(v2Compare.n_images, 150);
    assert.equal(gemma.fields_confident_wrong.pct, 7.2);
    assert.equal(flash.fields_confident_wrong.pct, 3.6);
    assert.equal(Math.round(gemma.fields_confident_wrong.pct / flash.fields_confident_wrong.pct), 2);
    assert.equal(Math.round(gemma.latency.p50_s / flash.latency.p50_s), 9);

    const secC = sections.get("c")!;
    for (const token of [
      "gemini-3.8-live",
      "gemini-3.8-flash",
      "5.8 s",
      `p50 ${liveP50} s / p95 ${liveP95} s`,
      `n = ${stats.features.live.ok}`,
      `${strengthWrong} / ${formatInt(strengthConfident)}`,
      `${ruleOfThreeUpper}%`,
      `${v1.synthetic.calibration_all.ece}`,
      `${unsafeK} / ${formatInt(unsafeN)}`,
      `${unsafePct}%`,
      `${ciLow.toFixed(2)}-${ciHigh.toFixed(2)}%`,
      formatInt(v1.synthetic.images_scored),
      `${v2Compare.n_images}`,
      "gemma-4-31b-it",
      `${gemma.fields_confident_wrong.pct.toFixed(1)}%`,
      `${flash.fields_confident_wrong.pct.toFixed(1)}%`,
      `${gemma.unsafe_reassurance.k} / ${gemma.unsafe_reassurance.n}`,
      `${flash.unsafe_reassurance.k} / ${flash.unsafe_reassurance.n}`,
      `p50 ${roundTenth(gemma.latency.p50_s)} s`,
      `${roundTenth(flash.latency.p50_s)} s`,
    ]) {
      assert.ok(secC.answer.includes(token), `Section (c) answer must cite exact value ${token}`);
    }
  });

  test("section (d) & (e) match FieldSpotter Verda H100 evaluation JSON + ONNX binary and GS1 DataMatrix cross-check implementation", () => {
    const fsJson = JSON.parse(readRepoFile("eval/results/fieldspotter.json")) as FieldSpotterResults;
    const splitJson = JSON.parse(readRepoFile("docs/evidence/fieldspotter/split.json")) as FieldSpotterSplit;
    const verdaDoc = readRepoFile("docs/evidence/verda-fieldspotter.md");
    const onnxStat = fs.statSync(path.join(REPO_DIR, "web/public/models/fieldspotter.onnx"));

    const totalSplitImages = splitJson.images.train + splitJson.images.val;
    assert.equal(totalSplitImages, 1740);
    assert.equal(splitJson.images.train, 1392);
    assert.equal(splitJson.images.val, 348);
    assert.ok(splitJson.val_src_ids.length > 0);
    assert.ok(verdaDoc.includes("513 s"));
    assert.ok(verdaDoc.includes("0.15 GPU-hours"));
    assert.ok(verdaDoc.includes("H100 80GB"));
    assert.equal(onnxStat.size, fsJson.onnx.bytes);

    const predPos = fsJson.strength_visible.tp + fsJson.strength_visible.fp;
    const onnxMb = (onnxStat.size / 1_000_000).toFixed(1);

    const secD = sections.get("d")!;
    for (const token of [
      formatInt(totalSplitImages),
      formatInt(splitJson.images.train),
      `${splitJson.images.val}`,
      "src_id",
      "513 s",
      "~0.15",
      "Verda H100 80GB",
      `${onnxMb} MB`,
      "YOLOv8n",
      `${fsJson.strength_visible.precision.toFixed(1)}%`,
      `${fsJson.strength_visible.tp} / ${predPos}`,
      `${fsJson.strength_visible.precision_ci[0].toFixed(1)}-${fsJson.strength_visible.precision_ci[1].toFixed(1)}%`,
      `${fsJson.strength_visible.recall.toFixed(1)}%`,
      `${fsJson.map50_all.toFixed(3)}`,
      `p50 ${fsJson.latency_ms_onnx_cpu.p50.toFixed(1)} ms`,
      `p95 ${fsJson.latency_ms_onnx_cpu.p95.toFixed(1)} ms`,
      "web/public/models/fieldspotter.onnx",
      "trained, evaluated, and committed",
      "not yet wired into live coaching",
    ]) {
      assert.ok(secD.answer.includes(token), `Section (d) answer must cite ${token}`);
    }

    const serverGs1 = readRepoFile("server/src/gs1.ts");
    const webGs1 = readRepoFile("web/src/lib/gs1.ts");
    const safetyTs = readRepoFile("server/src/safety.ts");
    const verdictsTs = readRepoFile("web/src/lib/verdicts.ts");

    assert.ok(serverGs1.includes("export function parseGs1"));
    assert.ok(webGs1.includes("export function parseGs1"));
    assert.ok(safetyTs.includes("double-checked with the pack's code"));
    assert.ok(verdictsTs.includes('via === "datamatrix"'));

    const secE = sections.get("e")!;
    for (const token of [
      "server/src/gs1.ts",
      "web/src/lib/gs1.ts",
      "(01)",
      "GTIN",
      "(17)",
      "expiry",
      "(10)",
      "batch",
      "(21)",
      "serial",
      "server/src/safety.ts",
      '"double-checked with the pack\'s code"',
      "pharmacist",
      "offline",
      "web/src/lib/verdicts.ts",
    ]) {
      assert.ok(secE.answer.includes(token), `Section (e) answer must cite ${token}`);
    }
  });

  test("section (f) cites exact token counts from api-stats-snapshot.json and GDPR/privacy invariants from PRIVACY.md", () => {
    const stats = JSON.parse(readRepoFile("docs/evidence/api-stats-snapshot.json")) as ApiStatsSnapshot;
    const privacyMd = readRepoFile("docs/PRIVACY.md");

    const v = stats.features.verify;
    const vs = stats.features.verify_spec;

    assert.equal(v.calls, 12);
    assert.equal(v.tokens_in, 30852);
    assert.equal(v.tokens_out, 1672);
    assert.equal(v.tokens_thinking, 1071);
    assert.equal(v.models["gemini-3.8-flash"], 12);

    assert.equal(vs.calls, 49);
    assert.equal(vs.tokens_in, 141922);
    assert.equal(vs.tokens_out, 5976);
    assert.equal(vs.tokens_thinking, 9626);
    assert.equal(vs.models["gemini-3.8-flash"], 49);

    const avgVerifyIn = Math.round(v.tokens_in / v.calls);
    const avgVerifyOutThinking = Math.round((v.tokens_out + v.tokens_thinking) / v.calls);
    assert.equal(avgVerifyIn, 2571);
    assert.equal(avgVerifyOutThinking, 229);

    assert.ok(privacyMd.includes("three plain-language cards"));
    assert.ok(privacyMd.includes("auto-stops after 45 s"));
    assert.ok(privacyMd.includes("last 8 frames"));
    assert.ok(privacyMd.includes("localStorage"));
    assert.ok(privacyMd.includes("Delete all my data"));
    assert.ok(privacyMd.includes("data-processing agreement"));

    const secF = sections.get("f")!;
    for (const token of [
      "docs/evidence/api-stats-snapshot.json",
      formatInt(v.tokens_in),
      formatInt(v.tokens_out),
      formatInt(v.tokens_thinking),
      `${v.calls}`,
      `~${formatInt(avgVerifyIn)}`,
      `~${avgVerifyOutThinking}`,
      formatInt(vs.tokens_in),
      formatInt(vs.tokens_out),
      formatInt(vs.tokens_thinking),
      `${vs.calls}`,
      "gemini-3.8-flash",
      "sub-cent",
      "3-card",
      "45 s",
      "8",
      "redacting logger",
      "localStorage",
      "1-button delete",
      "docs/PRIVACY.md",
      "DPA",
    ]) {
      assert.ok(secF.answer.includes(token), `Section (f) answer must cite ${token}`);
    }
  });
});
