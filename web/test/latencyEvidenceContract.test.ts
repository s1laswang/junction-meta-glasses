import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(TEST_DIR, "..", "..");

type FeatureStats = {
  calls: number;
  ok: number;
  errors: number;
  latency_p50_s: number | null;
  latency_p95_s: number | null;
  first_audio_p50_s?: number;
  first_audio_p95_s?: number;
};

type ApiStatsSnapshot = {
  total: number;
  features: {
    live: FeatureStats & {
      first_audio_p50_s: number;
      first_audio_p95_s: number;
    };
    verify_cache: FeatureStats;
    verify: FeatureStats;
    verify_spec: FeatureStats;
  };
};

type EvalV1Results = {
  model: string;
  synthetic: {
    latency_s: {
      n: number;
      p50: number;
      p95: number;
      p50_ci: [number, number];
      p95_ci: [number, number];
    };
  };
};

function readRepoFile(relPath: string): string {
  return fs.readFileSync(path.join(REPO_DIR, relPath), "utf8");
}

function roundToTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

describe("latency evidence and cross-document contract", () => {
  test("api-stats-snapshot.json and eval/results/v1_results.json match metered latency breakdown", () => {
    const rawStats = readRepoFile("docs/evidence/api-stats-snapshot.json");
    const stats = JSON.parse(rawStats) as ApiStatsSnapshot;

    assert.equal(stats.features.live.ok, 26);
    assert.equal(stats.features.live.first_audio_p50_s, 2.088);
    assert.equal(stats.features.live.first_audio_p95_s, 3.445);
    assert.equal(Math.round(stats.features.live.first_audio_p50_s * 10) / 10, 2.1);
    assert.equal(Math.round(stats.features.live.first_audio_p95_s * 10) / 10, 3.4);
    assert.equal(roundToTenth(stats.features.live.first_audio_p50_s), 2.1);
    assert.equal(roundToTenth(stats.features.live.first_audio_p95_s), 3.4);

    assert.equal(stats.features.verify_cache.ok, 17);
    assert.equal(stats.features.verify_cache.latency_p50_s, 0);
    assert.equal(stats.features.verify_cache.latency_p95_s, 1.452);

    assert.equal(stats.features.verify.ok, 12);
    assert.equal(stats.features.verify.latency_p50_s, 3.795);
    assert.equal(stats.features.verify.latency_p95_s, 7.358);

    assert.equal(stats.features.verify_spec.ok, 48);
    assert.equal(stats.features.verify_spec.latency_p50_s, 4.725);
    assert.equal(stats.features.verify_spec.latency_p95_s, 7.33);

    const evalV1 = JSON.parse(readRepoFile("eval/results/v1_results.json")) as EvalV1Results;
    assert.equal(evalV1.model, "gemini-3.8-flash");
    assert.equal(evalV1.synthetic.latency_s.n, 1740);
    assert.equal(evalV1.synthetic.latency_s.p50, 3.43);
    assert.equal(evalV1.synthetic.latency_s.p95, 5.55);

    const smokeRuns = readRepoFile("docs/evidence/smoke-runs.md");
    for (const token of [
      "2.09 s",
      "3.45 s",
      "0.00 s",
      "1.45 s",
      "3.80 s",
      "7.36 s",
      "4.73 s",
      "7.33 s",
      "3.43 s",
      "5.55 s",
    ]) {
      assert.ok(smokeRuns.includes(token), `docs/evidence/smoke-runs.md must include ${token}`);
    }
  });

  test("zero stale latency strings remain across docs, deck, and evidence files", () => {
    const targetFiles = [
      "README.md",
      "GEMINI.md",
      "deck/index.html",
      "docs/PLAN.md",
      "docs/DEMO_SCRIPT.md",
      "docs/EVAL.md",
      "docs/evidence/smoke-runs.md",
    ];
    const staleTokens = [
      "0.8-1.8",
      "0.8\u20131.8",
      "0.8-3.3",
      "0.8\u20133.3",
      "stays under 1.5 s",
    ];

    for (const relPath of targetFiles) {
      const content = readRepoFile(relPath);
      for (const stale of staleTokens) {
        assert.equal(
          content.includes(stale),
          false,
          `${relPath} must not contain stale latency string "${stale}"`,
        );
      }
    }
  });

  test("README.md, GEMINI.md, deck/index.html, and docs/PLAN.md cite canonical 2.1 s / 3.4 s (n=26) latency", () => {
    const canonicalFiles = [
      "README.md",
      "GEMINI.md",
      "deck/index.html",
      "docs/PLAN.md",
    ];
    const sampleSizePattern = new RegExp("\\bn\\s*=\\s*26\\b");

    for (const relPath of canonicalFiles) {
      const content = readRepoFile(relPath);
      assert.ok(content.includes("2.1 s"), `${relPath} must cite p50 2.1 s`);
      assert.ok(content.includes("3.4 s"), `${relPath} must cite p95 3.4 s`);
      assert.match(content, sampleSizePattern, `${relPath} must cite n = 26 sample size`);
    }

    const demoScript = readRepoFile("docs/DEMO_SCRIPT.md");
    assert.ok(
      demoScript.includes("median 2.1 seconds over 26 live runs"),
      "docs/DEMO_SCRIPT.md must cite median 2.1 seconds over 26 live runs",
    );
  });
});
