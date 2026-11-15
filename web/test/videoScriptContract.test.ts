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

type EvalV1Results = {
  conf_threshold: number;
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
  baseline: {
    unsafe_reassurance_silent: {
      k: number;
      n: number;
    };
  };
};

type FieldSpotterEval = {
  n_val_images: number;
  strength_visible: {
    precision: number;
  };
  onnx: {
    bytes: number;
  };
  latency_ms_onnx_cpu: {
    p50: number;
  };
};

type ApiStatsSnapshot = {
  features: {
    live: {
      ok: number;
      first_audio_p50_s: number;
      first_audio_p95_s: number;
    };
  };
};

type WebVttCue = {
  id?: string;
  startRaw: string;
  endRaw: string;
  startMs: number;
  endMs: number;
  text: string;
};

function readRepoFile(relPath: string): string {
  return fs.readFileSync(path.join(REPO_DIR, relPath), "utf8");
}

function roundToDecimals(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function formatThousands(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function extractChecklistIds(text: string): string[] {
  const matches = text.match(/\bH(?:10|[1-9])\b/g) ?? [];
  return [...new Set(matches)].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

function extractHwPaths(text: string): string[] {
  const matches = text.match(/docs\/img\/hw\/[A-Za-z0-9._-]+/g) ?? [];
  return [...new Set(matches)].sort();
}

function extractFencedCodeBlocks(markdown: string): string[] {
  const re = /```[^\n]*\n([\s\S]*?)```/g;
  return [...markdown.matchAll(re)].map((m) => m[1]);
}

function stripFencedCodeBlocks(markdown: string): string {
  return markdown.replace(/```[\s\S]*?```/g, "");
}

function extractMarkdownTargets(markdown: string): string[] {
  const stripped = stripFencedCodeBlocks(markdown);
  const targets: string[] = [];
  const inlineRe = /!?\[([^\]]*)\]\(([^)]+)\)/g;
  for (const match of stripped.matchAll(inlineRe)) {
    const token = match[2].trim().replace(/^<|>$/g, "").split(/\s+/)[0] ?? "";
    if (token.length > 0) targets.push(token);
  }
  return targets;
}

function assertMonotonicIndices(text: string, tokens: string[], context: string): void {
  let prev = -1;
  for (const token of tokens) {
    const next = text.indexOf(token, prev + 1);
    assert.ok(next > prev, `${context}: expected "${token}" after index ${prev}`);
    prev = next;
  }
}

function readExportedConstNumber(tsSource: string, constName: string): number {
  const re = new RegExp(`export\\s+const\\s+${constName}\\s*=\\s*([0-9]+(?:\\.[0-9]+)?)\\s*;`);
  const match = re.exec(tsSource);
  assert.ok(match, `Expected exported numeric constant ${constName} in server/src/safety.ts`);
  return Number(match[1]);
}

function parseVttTimestampMs(raw: string): number {
  const match = /^(\d{2}):(\d{2})\.(\d{3})$/.exec(raw);
  assert.ok(match, `Invalid MM:SS.mmm WebVTT timestamp: "${raw}"`);
  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  const millis = Number(match[3]);
  assert.ok(seconds < 60, `WebVTT seconds out of range in "${raw}"`);
  return (minutes * 60 + seconds) * 1000 + millis;
}

function parseWebVtt(vttContent: string): WebVttCue[] {
  const normalized = vttContent.replace(/\r\n/g, "\n").trimEnd();
  const blocks = normalized.split(/\n{2,}/);
  assert.ok(blocks.length >= 2, "Expected WEBVTT header block and cue blocks");
  assert.equal(blocks[0]?.trim(), "WEBVTT", "First WebVTT block must be exact WEBVTT header");

  const cues: WebVttCue[] = [];
  const timingRe = /^(\d{2}:\d{2}\.\d{3}) --> (\d{2}:\d{2}\.\d{3})$/;

  for (let i = 1; i < blocks.length; i++) {
    const lines = blocks[i].split("\n").map((l) => l.trimEnd());
    assert.ok(lines.length >= 2, `Cue block ${i} must have timing and payload lines`);
    let lineIdx = 0;
    let cueId: string | undefined;
    if (!timingRe.test(lines[0] ?? "")) {
      cueId = lines[0]?.trim();
      assert.ok(cueId && cueId.length > 0, `Cue block ${i} identifier must be non-empty`);
      lineIdx = 1;
    }
    const timingLine = lines[lineIdx] ?? "";
    const timingMatch = timingRe.exec(timingLine);
    assert.ok(timingMatch, `Invalid WebVTT timing line in block ${i}: "${timingLine}"`);
    const startRaw = timingMatch[1];
    const endRaw = timingMatch[2];
    const startMs = parseVttTimestampMs(startRaw);
    const endMs = parseVttTimestampMs(endRaw);
    const payloadLines = lines.slice(lineIdx + 1).filter((l) => l.trim().length > 0);
    assert.ok(payloadLines.length >= 1, `Cue block ${i} must have non-empty caption text`);
    cues.push({
      id: cueId,
      startRaw,
      endRaw,
      startMs,
      endMs,
      text: payloadLines.join("\n"),
    });
  }

  return cues;
}

describe("2-minute Junction video script, WebVTT captions, and evidence parity contract", () => {
  test("validates docs/VIDEO_SCRIPT.md <= 140 lines, 6 timecoded beats (0:00..2:00), table schema, Slide 5 link, and ?mock=1 fallback", () => {
    const videoScript = readRepoFile("docs/VIDEO_SCRIPT.md");
    const deckHtml = readRepoFile("deck/index.html");

    const trimmed = videoScript.endsWith("\n") ? videoScript.slice(0, -1) : videoScript;
    const lines = trimmed.split(/\r?\n/);
    assert.ok(lines.length >= 25, `Expected substantive docs/VIDEO_SCRIPT.md, got ${lines.length} lines`);
    assert.ok(lines.length <= 140, `docs/VIDEO_SCRIPT.md must be <= 140 lines, got ${lines.length}`);

    for (const colHeader of [
      "Timecode",
      "Visual / Source Clip",
      "Spoken Audio (Open-Ear Glasses + Narrator)",
      "Captions & On-Screen Card",
    ]) {
      assert.ok(videoScript.includes(colHeader), `Expected table column "${colHeader}" in docs/VIDEO_SCRIPT.md`);
    }

    assertMonotonicIndices(
      videoScript,
      ["0:00-0:15", "0:15-0:30", "0:30-1:00", "1:00-1:20", "1:20-1:40", "1:40-2:00"],
      "Six timecoded beats from 0:00 to 2:00",
    );

    assert.ok(deckHtml.includes('id="s5-h"'), "Expected Slide 5 (#s5-h) in deck/index.html");
    assert.ok(videoScript.includes("#s5-h") && videoScript.includes("deck/index.html"));
    assert.ok(videoScript.includes("DEMO_SCRIPT.md"));
    assert.ok(videoScript.includes("docs/video-captions.vtt"));
    assert.ok(videoScript.includes("?mock=1") && videoScript.includes("/hud/?mock=1"));

    for (const token of [
      "localStorage",
      "45 s",
      "8",
      "Amlodipine 5 mg",
      "✓ RIGHT ONE",
      "600x600",
      "Neural Band",
      "I took it",
      "Ibuprofen 400 mg",
      "avoid NSAIDs",
      "or ask a pharmacist",
      "(01)",
      "(17)",
      "DataMatrix",
      "Näkövammaisten liitto",
      "4-week",
      "20-member",
      "wellbeing services counties",
      "Class IIa",
      "Rule 11",
    ]) {
      assert.ok(videoScript.includes(token), `docs/VIDEO_SCRIPT.md must include "${token}"`);
    }

    const docDir = path.join(REPO_DIR, "docs");
    const targets = extractMarkdownTargets(videoScript);
    assert.ok(targets.length >= 4, "Expected relative markdown links in docs/VIDEO_SCRIPT.md");
    for (const target of targets) {
      if (target.startsWith("#")) continue;
      const cleanPath = target.split("#")[0]?.split("?")[0] ?? "";
      if (!cleanPath) continue;
      const resolved = path.resolve(docDir, cleanPath);
      const rel = path.relative(REPO_DIR, resolved).split(path.sep).join("/");
      assert.equal(rel.startsWith(".."), false, `Link "${target}" must stay inside repository`);
      if (!rel.startsWith("docs/img/hw/")) {
        assert.equal(fs.existsSync(resolved), true, `Link "${target}" must resolve to existing file (${rel})`);
      }
    }
  });

  test("enforces H1..H10 and docs/img/hw/ parity with FILMING_0630.md and SHOT_LIST.md, H8-before-H9 order, and /tmp ffmpeg outputs", () => {
    const videoScript = readRepoFile("docs/VIDEO_SCRIPT.md");
    const filming0630 = readRepoFile("docs/FILMING_0630.md");
    const shotList = readRepoFile("docs/SHOT_LIST.md");
    const hardwareLog = readRepoFile("docs/HARDWARE_LOG.md");

    const expectedIds = ["H1", "H2", "H3", "H4", "H5", "H6", "H7", "H8", "H9", "H10"];
    const logTableIds = [...hardwareLog.matchAll(/^\|\s*(H(?:10|[1-9]))\s*\|/gm)].map((m) => m[1]);
    assert.deepEqual(logTableIds, expectedIds);
    assert.deepEqual(extractChecklistIds(filming0630), expectedIds);
    assert.deepEqual(extractChecklistIds(shotList), expectedIds);
    assert.deepEqual(extractChecklistIds(videoScript), expectedIds);

    const expectedHwFiles = extractHwPaths(shotList);
    assert.equal(expectedHwFiles.length, 10, "Expected 10 hardware capture paths in docs/SHOT_LIST.md");
    assert.deepEqual(extractHwPaths(filming0630), expectedHwFiles);
    assert.deepEqual(
      extractHwPaths(videoScript),
      expectedHwFiles,
      "docs/VIDEO_SCRIPT.md must reference the exact 10 docs/img/hw/ captures from SHOT_LIST.md and FILMING_0630.md",
    );

    const beat5Start = videoScript.indexOf("1:20-1:40");
    const beat6Start = videoScript.indexOf("1:40-2:00");
    assert.ok(beat5Start > 0 && beat6Start > beat5Start, "Expected Beat 5 (1:20-1:40) before Beat 6 (1:40-2:00)");
    const beat5Slice = videoScript.slice(beat5Start, beat6Start);
    assertMonotonicIndices(
      beat5Slice,
      [
        "H8",
        "docs/img/hw/H8-glasses-off-fallback.mp4",
        "H9",
        "Airplane mode ON",
        "H10",
        "Airplane mode OFF",
        "worn: false",
        "Phone camera",
        "You're offline",
        "Live assistant connected",
      ],
      "Beat 5 H8-online-before-H9-airplane-then-H10-reconnect ordering",
    );

    const codeBlocks = extractFencedCodeBlocks(videoScript);
    assert.ok(codeBlocks.length >= 1, "Expected copy-paste ffmpeg bash block in docs/VIDEO_SCRIPT.md");
    const ffmpegBlock = codeBlocks.join("\n");
    assert.ok(ffmpegBlock.includes("loudnorm=I=-16:TP=-1.5:LRA=11"), "Expected -16 LUFS loudnorm filter");
    assert.ok(ffmpegBlock.includes("-i docs/video-captions.vtt"), "Expected WebVTT subtitle input in ffmpeg mux");
    assert.ok(ffmpegBlock.includes("-c:s mov_text"), "Expected mov_text soft-subtitle mux codec");
    assert.ok(ffmpegBlock.includes("/tmp/holdup-demo-final.mp4"), "Expected /tmp/holdup-demo-final.mp4 final target");

    for (const rawLine of ffmpegBlock.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line.startsWith("ffmpeg ")) continue;
      const tokens = line.split(/\s+/);
      const outputTarget = tokens[tokens.length - 1] ?? "";
      assert.ok(
        outputTarget.startsWith("/tmp/") && outputTarget.endsWith(".mp4"),
        `Every ffmpeg output target must write to /tmp/<file>.mp4, got "${outputTarget}"`,
      );
    }

    const redirectMatches = [...ffmpegBlock.matchAll(/>\s*([^\s]+)/g)].map((m) => m[1]);
    for (const target of redirectMatches) {
      assert.ok(target.startsWith("/tmp/"), `Shell redirect target must stay under /tmp/, got "${target}"`);
    }
  });

  test("dynamically cross-checks all research, latency, eval, FieldSpotter, and safety.ts numbers in VIDEO_SCRIPT.md", () => {
    const videoScript = readRepoFile("docs/VIDEO_SCRIPT.md");
    const researchDoc = readRepoFile("docs/RESEARCH.md");
    const safetyTs = readRepoFile("server/src/safety.ts");
    const v1 = JSON.parse(readRepoFile("eval/results/v1_results.json")) as EvalV1Results;
    const v2 = JSON.parse(readRepoFile("eval/results/v2_safety_rescore.json")) as EvalV2SafetyRescore;
    const fsEval = JSON.parse(readRepoFile("eval/results/fieldspotter.json")) as FieldSpotterEval;
    const stats = JSON.parse(readRepoFile("docs/evidence/api-stats-snapshot.json")) as ApiStatsSnapshot;

    for (const researchFact of ["55,000", "45,000", "97%", "n = 314", "21.6%", "1 in 5"]) {
      assert.ok(researchDoc.includes(researchFact), `Expected "${researchFact}" in docs/RESEARCH.md`);
      assert.ok(videoScript.includes(researchFact), `Expected "${researchFact}" in docs/VIDEO_SCRIPT.md`);
    }

    const strengthGate = readExportedConstNumber(safetyTs, "STRENGTH_MIN_CONF");
    const allergenGate = readExportedConstNumber(safetyTs, "ALLERGEN_SAFE_CONF");
    assert.equal(strengthGate, 0.8);
    assert.equal(allergenGate, 0.95);
    assert.ok(videoScript.includes(`< ${strengthGate}`), `Expected "< ${strengthGate}" strength gate`);
    assert.ok(videoScript.includes(`< ${allergenGate}`), `Expected "< ${allergenGate}" allergen gate`);

    const liveSessions = stats.features.live.ok;
    const p50Audio = roundToDecimals(stats.features.live.first_audio_p50_s, 1).toFixed(1);
    const p95Audio = roundToDecimals(stats.features.live.first_audio_p95_s, 1).toFixed(1);
    assert.equal(liveSessions, 26);
    assert.equal(p50Audio, "2.1");
    assert.equal(p95Audio, "3.4");
    assert.ok(videoScript.includes(`${p50Audio} s`), `Expected "${p50Audio} s" p50 first-audio latency`);
    assert.ok(videoScript.includes(`${p95Audio} s`), `Expected "${p95Audio} s" p95 first-audio latency`);
    assert.ok(videoScript.includes(`n = ${liveSessions}`), `Expected "n = ${liveSessions}" live sessions`);
    assert.ok(videoScript.includes("5.8 s"), "Expected 5.8 s pre-speculative baseline");

    const imagesFmt = formatThousands(v1.synthetic.images_scored);
    const cwStrength = v1.synthetic.per_field.strength.confident_wrong;
    const confStrength = v1.synthetic.per_field.strength.k.confident;
    const upperBoundPct = roundToDecimals((3 / confStrength) * 100, 1).toFixed(1);
    const eceStr = v1.synthetic.calibration_all.ece.toFixed(3);
    assert.equal(imagesFmt, "1,740");
    assert.equal(`${cwStrength} / ${confStrength}`, "0 / 754");
    assert.equal(upperBoundPct, "0.4");
    assert.equal(eceStr, "0.022");
    assert.ok(videoScript.includes(imagesFmt), `Expected "${imagesFmt}" synthetic images`);
    assert.ok(videoScript.includes(`${cwStrength} / ${confStrength}`), `Expected "${cwStrength} / ${confStrength}"`);
    assert.ok(videoScript.includes(`${upperBoundPct}%`), `Expected "${upperBoundPct}%" 95% upper bound`);
    assert.ok(videoScript.includes(eceStr), `Expected ECE "${eceStr}"`);

    const unsafeK = v2.unsafe_reassurance_silent.k;
    const unsafeN = formatThousands(v2.unsafe_reassurance_silent.n);
    const unsafePct = roundToDecimals((unsafeK / v2.unsafe_reassurance_silent.n) * 100, 2).toFixed(2);
    const ciLow = v2.unsafe_reassurance_silent.wilson95_pct[0].toFixed(2);
    const ciHigh = v2.unsafe_reassurance_silent.wilson95_pct[1].toFixed(2);
    const baseK = v2.baseline.unsafe_reassurance_silent.k;
    const baseN = formatThousands(v2.baseline.unsafe_reassurance_silent.n);
    const basePct = roundToDecimals((baseK / v2.baseline.unsafe_reassurance_silent.n) * 100, 2).toFixed(2);
    assert.equal(`${unsafeK} / ${unsafeN} = ${unsafePct}%`, "3 / 4,730 = 0.06%");
    assert.equal(`${ciLow}-${ciHigh}%`, "0.02-0.19%");
    assert.equal(`${baseK} / ${baseN} = ${basePct}%`, "49 / 4,730 = 1.04%");
    assert.ok(videoScript.includes(`${unsafeK} / ${unsafeN} = ${unsafePct}%`));
    assert.ok(videoScript.includes(`${ciLow}-${ciHigh}%`));
    assert.ok(videoScript.includes(`${baseK} / ${baseN} = ${basePct}%`));

    const onnxMb = roundToDecimals(fsEval.onnx.bytes / 1_000_000, 1).toFixed(1);
    const fsPrec = fsEval.strength_visible.precision.toFixed(1);
    const fsValN = fsEval.n_val_images;
    const fsCpuP50 = fsEval.latency_ms_onnx_cpu.p50.toFixed(1);
    assert.equal(onnxMb, "12.8");
    assert.equal(fsPrec, "96.8");
    assert.equal(fsValN, 348);
    assert.equal(fsCpuP50, "34.5");
    assert.ok(videoScript.includes(`${onnxMb} MB`), `Expected "${onnxMb} MB" ONNX size`);
    assert.ok(videoScript.includes(`${fsPrec}%`), `Expected "${fsPrec}%" FieldSpotter precision`);
    assert.ok(videoScript.includes(`n = ${fsValN}`), `Expected "n = ${fsValN}" validation split`);
    assert.ok(videoScript.includes(`${fsCpuP50} ms`), `Expected "${fsCpuP50} ms" ONNX CPU p50`);
  });

  test("parses docs/video-captions.vtt as valid W3C WebVTT covering 00:00.000..02:00.000 with >= 14 monotonic cues, speakers, and audio descriptions", () => {
    const vtt = readRepoFile("docs/video-captions.vtt");
    assert.ok(vtt.startsWith("WEBVTT\n\n"), "docs/video-captions.vtt must start with WEBVTT header and blank line");

    const cues = parseWebVtt(vtt);
    assert.ok(cues.length >= 14, `Expected >= 14 WebVTT cues, got ${cues.length}`);
    assert.equal(cues[0]?.startRaw, "00:00.000", "First cue must start at 00:00.000");
    assert.equal(cues[0]?.startMs, 0);
    assert.equal(cues[cues.length - 1]?.endRaw, "02:00.000", "Final cue must end at 02:00.000");
    assert.equal(cues[cues.length - 1]?.endMs, 120_000);

    for (let i = 0; i < cues.length; i++) {
      const cue = cues[i];
      assert.ok(cue.startMs >= 0 && cue.endMs <= 120_000, `Cue ${i + 1} outside [0, 120000] ms`);
      assert.ok(cue.startMs < cue.endMs, `Cue ${i + 1} must satisfy start < end (${cue.startRaw} --> ${cue.endRaw})`);
      if (i > 0) {
        const prev = cues[i - 1];
        assert.ok(
          cue.startMs >= prev.endMs,
          `Cue ${i + 1} (${cue.startRaw}) overlaps previous cue ending at ${prev.endRaw}`,
        );
      }
    }

    const joinedText = cues.map((c) => c.text).join("\n");
    assert.ok(joinedText.includes("[Narrator]"), "Expected [Narrator] speaker prefix in WebVTT cues");
    assert.ok(joinedText.includes("[Glasses]"), "Expected [Glasses] speaker prefix in WebVTT cues");

    const adCues = cues.filter((c) => c.text.includes("[Audio description:"));
    assert.ok(adCues.length >= 6, `Expected >= 6 [Audio description: ...] cues, got ${adCues.length}`);
    const adJoined = adCues.map((c) => c.text).join("\n");

    for (const visualBeat of [
      "Three white medicine boxes",
      "MATCH",
      "RIGHT ONE",
      "WARNING",
      "CHECK",
      "NOT SURE",
      "Glasses doffed",
      "Phone camera",
    ]) {
      assert.ok(
        adJoined.includes(visualBeat),
        `Expected "[Audio description: ...]" cues to describe "${visualBeat}"`,
      );
    }
  });

  test("enforces zero comments, zero em dashes, and zero leaked secrets across all 3 files", () => {
    const targets = [
      "docs/VIDEO_SCRIPT.md",
      "docs/video-captions.vtt",
      "web/test/videoScriptContract.test.ts",
    ] as const;

    for (const relPath of targets) {
      const content = readRepoFile(relPath);
      assert.equal(content.includes(LINE_COMMENT), false, `${relPath} must contain zero line comments`);
      assert.equal(content.includes(BLOCK_COMMENT), false, `${relPath} must contain zero block comments`);
      assert.equal(content.includes(HTML_COMMENT), false, `${relPath} must contain zero HTML comments`);
      assert.equal(content.includes(EM_DASH), false, `${relPath} must contain zero em dashes`);
      assert.equal(content.includes(ESCAPED_EM_DASH), false, `${relPath} must contain zero escaped em dashes`);

      for (const secretPrefix of SECRET_PREFIXES) {
        assert.equal(
          content.includes(secretPrefix),
          false,
          `${relPath} must not contain secret prefix "${secretPrefix}"`,
        );
      }
    }

    for (const block of extractFencedCodeBlocks(readRepoFile("docs/VIDEO_SCRIPT.md"))) {
      for (const rawLine of block.split(/\r?\n/)) {
        const trimmedLine = rawLine.trim();
        if (!trimmedLine) continue;
        assert.equal(
          trimmedLine.startsWith("#"),
          false,
          `docs/VIDEO_SCRIPT.md fenced bash block must not contain shell comments: "${trimmedLine}"`,
        );
      }
    }
  });
});
