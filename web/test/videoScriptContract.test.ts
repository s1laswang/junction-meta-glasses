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

const FORBIDDEN_SUBPROCESS_TOKENS = [
  ["child_", "process"].join(""),
  ["exec", "Sync"].join(""),
  ["spawn", "Sync"].join(""),
  ["execFile", "Sync"].join(""),
  ["git ", "diff"].join(""),
  ["git ", "status"].join(""),
  ["git ", "log"].join(""),
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

type EvalV3Results = {
  version: string;
  evaluation_split: string;
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
  };
};

type EvalV3HeldoutSafety = {
  version: string;
  evaluation_split: string;
  images_scored: number;
  standard_eval_scenarios: {
    merged_main_safety_ts: {
      n: number;
      unsafe_k: number;
      unsafe_rate_pct: number;
      unsafe_wilson95_pct: [number, number];
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

describe("2-minute Junction video script, WebVTT captions, stage-honesty, and held-out v3 parity contract", () => {
  test("validates docs/VIDEO_SCRIPT.md <= 50 lines, 6 timecoded beats (0:00..2:00), table schema, Slide 5 link, and relative markdown targets", () => {
    const videoScript = readRepoFile("docs/VIDEO_SCRIPT.md");
    const deckHtml = readRepoFile("deck/index.html");

    const trimmed = videoScript.endsWith("\n") ? videoScript.slice(0, -1) : videoScript;
    const lines = trimmed.split(/\r?\n/);
    assert.ok(lines.length >= 25, `Expected substantive docs/VIDEO_SCRIPT.md, got ${lines.length} lines`);
    assert.ok(lines.length <= 50, `docs/VIDEO_SCRIPT.md must be <= 50 lines, got ${lines.length}`);

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
    assert.ok(videoScript.includes("MORNING_BRIEF.md"));
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
    assert.ok(targets.length >= 8, "Expected relative markdown links in docs/VIDEO_SCRIPT.md");
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

  test("enforces Source Asset Inventory parity: H1..H10, 08:00 Morning Brief step 5 side-angle clip, committed simulation reels, H8-before-H9 order, and /tmp ffmpeg outputs", () => {
    const videoScript = readRepoFile("docs/VIDEO_SCRIPT.md");
    const morningBrief = readRepoFile("docs/MORNING_BRIEF.md");
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

    assert.ok(morningBrief.includes("5. **Film one take from the side"), "Expected step 5 side-angle take in docs/MORNING_BRIEF.md");
    assert.ok(morningBrief.includes('"built for"'), "Expected \"built for\" stage-honesty note in docs/MORNING_BRIEF.md");

    const invStart = videoScript.indexOf("## Source Asset Inventory");
    const beatsStart = videoScript.indexOf("## Six Timecoded Beats");
    assert.ok(invStart > 0 && beatsStart > invStart, "Expected Source Asset Inventory before Six Timecoded Beats");
    const inventorySlice = videoScript.slice(invStart, beatsStart);

    assert.ok(inventorySlice.includes("08:00"), "Expected 08:00 Morning Brief reference in Source Asset Inventory");
    assert.ok(inventorySlice.includes("docs/MORNING_BRIEF.md") && inventorySlice.includes("step 5"));
    assert.ok(inventorySlice.includes('"built for"'), "Expected \"built for\" wording note until step 5 is filmed");
    assertMonotonicIndices(
      inventorySlice,
      ["Backwards box", "coaching", '"Yes, Amlodipine 5 mg"', "thumb over dose", '"not sure"'],
      "Morning Brief step 5 single-take side-angle flow in Source Asset Inventory",
    );

    for (const simReelRel of ["docs/demo/holdup-mock-demo.mp4", "docs/evidence/states-reel.webm"]) {
      const fullSimPath = path.join(REPO_DIR, simReelRel);
      assert.equal(fs.existsSync(fullSimPath), true, `Expected committed simulation reel ${simReelRel} on disk`);
      assert.ok(fs.statSync(fullSimPath).size > 0, `Expected non-empty simulation reel ${simReelRel}`);
      assert.ok(inventorySlice.includes(simReelRel), `Source Asset Inventory must document ${simReelRel}`);
    }
    assert.ok(
      /simulation\s*\/\s*mock/i.test(inventorySlice),
      "Source Asset Inventory must explicitly label committed reels as simulation/mock",
    );
    assert.ok(
      inventorySlice.includes("pending"),
      "Source Asset Inventory must state simulation reels apply while H1-H10 hardware clips are pending",
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

  test("enforces MORNING_BRIEF.md stage-honesty rules: zero overclaiming and exact >= 0.8 abstention wording in VIDEO_SCRIPT.md and video-captions.vtt", () => {
    const morningBrief = readRepoFile("docs/MORNING_BRIEF.md");
    const videoScript = readRepoFile("docs/VIDEO_SCRIPT.md");
    const vtt = readRepoFile("docs/video-captions.vtt");

    assert.ok(morningBrief.includes("## Say these carefully on stage"), "Expected stage-honesty section in docs/MORNING_BRIEF.md");
    assert.ok(morningBrief.includes("It only states a dose it can read clearly"), "Expected dose-honesty rule in docs/MORNING_BRIEF.md");

    const forbiddenOverclaims = [
      "zero dose guessing",
      "zero guessing",
      "never makes mistakes",
      "zero mistakes",
      "100% safe",
    ];
    for (const phrase of forbiddenOverclaims) {
      assert.equal(
        videoScript.toLowerCase().includes(phrase),
        false,
        `docs/VIDEO_SCRIPT.md must not overclaim "${phrase}"`,
      );
      assert.equal(
        vtt.toLowerCase().includes(phrase),
        false,
        `docs/video-captions.vtt must not overclaim "${phrase}"`,
      );
    }

    for (const honestPhrase of ["only states a dose at confidence >= 0.8", "abstains below 0.8"]) {
      assert.ok(
        videoScript.includes(honestPhrase),
        `docs/VIDEO_SCRIPT.md must include exact honest wording "${honestPhrase}"`,
      );
      assert.ok(
        vtt.includes(honestPhrase),
        `docs/video-captions.vtt must include exact honest wording "${honestPhrase}"`,
      );
    }

    assert.ok(videoScript.toLowerCase().includes("synthetic"), "docs/VIDEO_SCRIPT.md must explicitly call evals synthetic");
    assert.ok(vtt.toLowerCase().includes("synthetic"), "docs/video-captions.vtt must explicitly call evals synthetic");
    assert.ok(videoScript.toLowerCase().includes("prototype"), "docs/VIDEO_SCRIPT.md must call FieldSpotter a prototype");
    assert.ok(vtt.toLowerCase().includes("prototype"), "docs/video-captions.vtt must call FieldSpotter a prototype");
  });

  test("dynamically cross-checks v1, v2, held-out v3, live-fidelity, $0.003 cost, latency, FieldSpotter, and safety.ts across Beat 6 and Cues 17-18", () => {
    const videoScript = readRepoFile("docs/VIDEO_SCRIPT.md");
    const vtt = readRepoFile("docs/video-captions.vtt");
    const researchDoc = readRepoFile("docs/RESEARCH.md");
    const safetyTs = readRepoFile("server/src/safety.ts");
    const fidelityTs = readRepoFile("server/src/fidelity.ts");
    const fidelityDoc = readRepoFile("docs/evidence/live-fidelity.md");
    const deckHtml = readRepoFile("deck/index.html");
    const v1 = JSON.parse(readRepoFile("eval/results/v1_results.json")) as EvalV1Results;
    const v2 = JSON.parse(readRepoFile("eval/results/v2_safety_rescore.json")) as EvalV2SafetyRescore;
    const v3 = JSON.parse(readRepoFile("eval/results/v3_results.json")) as EvalV3Results;
    const v3Safety = JSON.parse(readRepoFile("eval/results/v3_heldout_safety.json")) as EvalV3HeldoutSafety;
    const fsEval = JSON.parse(readRepoFile("eval/results/fieldspotter.json")) as FieldSpotterEval;
    const stats = JSON.parse(readRepoFile("docs/evidence/api-stats-snapshot.json")) as ApiStatsSnapshot;

    const beat6Start = videoScript.indexOf("1:40-2:00");
    const postProdStart = videoScript.indexOf("## Post-Production Assembly");
    assert.ok(beat6Start > 0 && postProdStart > beat6Start, "Expected Beat 6 (1:40-2:00) section");
    const beat6Slice = videoScript.slice(beat6Start, postProdStart);

    const cues = parseWebVtt(vtt);
    const cue17 = cues.find((c) => c.id === "17");
    const cue18 = cues.find((c) => c.id === "18");
    assert.ok(cue17 && cue18, "Expected WebVTT Cue 17 and Cue 18");
    assert.equal(cue17.startRaw, "01:40.000");
    assert.equal(cue18.endRaw, "02:00.000");
    const cues17And18 = `${cue17.text}\n${cue18.text}`;

    for (const researchFact of ["55,000", "45,000", "97%", "n = 314", "21.6%", "1 in 5"]) {
      assert.ok(researchDoc.includes(researchFact), `Expected "${researchFact}" in docs/RESEARCH.md`);
      assert.ok(videoScript.includes(researchFact), `Expected "${researchFact}" in docs/VIDEO_SCRIPT.md`);
    }

    const strengthGate = readExportedConstNumber(safetyTs, "STRENGTH_MIN_CONF");
    const allergenGate = readExportedConstNumber(safetyTs, "ALLERGEN_SAFE_CONF");
    assert.equal(strengthGate, 0.8);
    assert.equal(allergenGate, 0.95);
    assert.ok(videoScript.includes(`< ${strengthGate}`), `Expected "< ${strengthGate}" strength gate`);
    assert.ok(videoScript.includes(`>= ${strengthGate}`), `Expected ">= ${strengthGate}" strength gate`);
    assert.ok(videoScript.includes(`< ${allergenGate}`), `Expected "< ${allergenGate}" allergen gate`);

    const liveSessions = stats.features.live.ok;
    const p50Audio = roundToDecimals(stats.features.live.first_audio_p50_s, 1).toFixed(1);
    const p95Audio = roundToDecimals(stats.features.live.first_audio_p95_s, 1).toFixed(1);
    assert.equal(liveSessions, 26);
    assert.equal(p50Audio, "2.1");
    assert.equal(p95Audio, "3.4");
    assert.ok(beat6Slice.includes(`${p50Audio} s`) && beat6Slice.includes(`${p95Audio} s`) && beat6Slice.includes(`n = ${liveSessions}`));
    assert.ok(beat6Slice.includes("5.8 s"), "Expected 5.8 s pre-speculative baseline in Beat 6");
    assert.ok(cues17And18.includes(`${p50Audio} s`) && cues17And18.includes(`${p95Audio} s`) && cues17And18.includes(`${liveSessions} live sessions`));

    assert.ok(fidelityTs.includes("export function speechFidelity("), "Expected speechFidelity export in server/src/fidelity.ts");
    const fidelityRow = /^\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|/m.exec(fidelityDoc);
    assert.ok(fidelityRow, "Expected measured table row in docs/evidence/live-fidelity.md");
    const checkedVerdicts = Number(fidelityRow[1]);
    const correctedVerdicts = Number(fidelityRow[3]);
    assert.equal(checkedVerdicts, 16);
    assert.equal(correctedVerdicts, 1);
    assert.ok(beat6Slice.includes("server/src/fidelity.ts") && beat6Slice.includes("docs/evidence/live-fidelity.md"));
    assert.ok(
      beat6Slice.includes(`\`${checkedVerdicts}\` live verdicts checked, \`${correctedVerdicts}\` auto-corrected`),
      "Expected spoken-answer fidelity counts in Beat 6",
    );
    assert.ok(
      cues17And18.includes(`${checkedVerdicts} live verdicts checked, ${correctedVerdicts} auto-corrected`),
      "Expected spoken-answer fidelity counts in Cues 17-18",
    );

    const v1ImagesFmt = formatThousands(v1.synthetic.images_scored);
    const v1CwStrength = v1.synthetic.per_field.strength.confident_wrong;
    const v1ConfStrength = v1.synthetic.per_field.strength.k.confident;
    const upperBoundPct = roundToDecimals((3 / v1ConfStrength) * 100, 1).toFixed(1);
    const eceStr = v1.synthetic.calibration_all.ece.toFixed(3);
    assert.equal(v1ImagesFmt, "1,740");
    assert.equal(`${v1CwStrength} / ${v1ConfStrength}`, "0 / 754");
    assert.ok(beat6Slice.includes(v1ImagesFmt) && beat6Slice.includes(`${v1CwStrength} / ${v1ConfStrength}`));
    assert.ok(beat6Slice.includes(`${upperBoundPct}%`) && beat6Slice.includes(eceStr));
    assert.ok(cues17And18.includes(v1ImagesFmt) && cues17And18.includes(`${v1CwStrength} / ${v1ConfStrength}`));

    const unsafeK = v2.unsafe_reassurance_silent.k;
    const unsafeN = formatThousands(v2.unsafe_reassurance_silent.n);
    const unsafePct = roundToDecimals((unsafeK / v2.unsafe_reassurance_silent.n) * 100, 2).toFixed(2);
    const ciLow = v2.unsafe_reassurance_silent.wilson95_pct[0].toFixed(2);
    const ciHigh = v2.unsafe_reassurance_silent.wilson95_pct[1].toFixed(2);
    const baseK = v2.baseline.unsafe_reassurance_silent.k;
    const baseN = formatThousands(v2.baseline.unsafe_reassurance_silent.n);
    const basePct = roundToDecimals((baseK / v2.baseline.unsafe_reassurance_silent.n) * 100, 2).toFixed(2);
    assert.equal(`${unsafeK} / ${unsafeN} = ${unsafePct}%`, "3 / 4,730 = 0.06%");
    assert.ok(beat6Slice.includes(`${unsafeK} / ${unsafeN} = ${unsafePct}%`));
    assert.ok(beat6Slice.includes(`${ciLow}-${ciHigh}%`) && beat6Slice.includes(`${baseK} / ${baseN} = ${basePct}%`));
    assert.ok(cues17And18.includes(`${unsafeK} / ${unsafeN}`) && cues17And18.includes(`${unsafePct}%`));

    assert.ok(v3.evaluation_split.includes("held-out") && v3Safety.evaluation_split.includes("held-out"));
    assert.equal(v3.synthetic.images_scored, v3Safety.images_scored);
    const v3ImagesFmt = formatThousands(v3.synthetic.images_scored);
    const v3Cw = v3.synthetic.per_field.strength.confident_wrong;
    const v3Conf = v3.synthetic.per_field.strength.k.confident;
    const v3CwPct = roundToDecimals((v3Cw / v3Conf) * 100, 2).toFixed(2);
    const v3UnsafeK = v3Safety.standard_eval_scenarios.merged_main_safety_ts.unsafe_k;
    const v3UnsafeN = formatThousands(v3Safety.standard_eval_scenarios.merged_main_safety_ts.n);
    const v3UnsafePct = v3Safety.standard_eval_scenarios.merged_main_safety_ts.unsafe_rate_pct.toFixed(2);
    const v3CiLow = v3Safety.standard_eval_scenarios.merged_main_safety_ts.unsafe_wilson95_pct[0].toFixed(2);
    const v3CiHigh = v3Safety.standard_eval_scenarios.merged_main_safety_ts.unsafe_wilson95_pct[1].toFixed(2);

    assert.equal(v3ImagesFmt, "1,060");
    assert.equal(`${v3Cw} / ${v3Conf}`, "1 / 536");
    assert.equal(v3CwPct, "0.19");
    assert.equal(`${v3UnsafeK} / ${v3UnsafeN}`, "4 / 3,033");
    assert.equal(v3UnsafePct, "0.13");
    assert.equal(`${v3CiLow}-${v3CiHigh}%`, "0.05-0.34%");

    assert.ok(beat6Slice.includes("eval/results/v3_results.json") && beat6Slice.includes("eval/results/v3_heldout_safety.json"));
    for (const v3Token of [v3ImagesFmt, `${v3Cw} / ${v3Conf}`, `${v3CwPct}%`, `${v3UnsafeK} / ${v3UnsafeN}`, `${v3UnsafePct}%`, "held-out"]) {
      assert.ok(beat6Slice.includes(v3Token), `Expected held-out v3 token "${v3Token}" in Beat 6`);
      assert.ok(cues17And18.includes(v3Token), `Expected held-out v3 token "${v3Token}" in Cues 17-18`);
    }
    assert.ok(beat6Slice.includes(`${v3CiLow}-${v3CiHigh}%`), "Expected held-out v3 Wilson CI in Beat 6");

    const s12Start = deckHtml.indexOf('id="s12-h"');
    const s13Start = deckHtml.indexOf('id="s13-h"');
    assert.ok(s12Start > 0 && s13Start > s12Start, "Expected Slide 12 (#s12-h) in deck/index.html");
    const slide12Slice = deckHtml.slice(s12Start, s13Start);
    const costMatch = /\$([0-9]+\.[0-9]+)\s+per label read/i.exec(slide12Slice);
    assert.ok(costMatch, "Expected measured cost per label read on Slide 12 of deck/index.html");
    const costUsd = costMatch[1];
    assert.equal(costUsd, "0.003");
    assert.ok(beat6Slice.includes(`~$${costUsd}`) && beat6Slice.includes("per label read") && beat6Slice.includes("Slide 12"));
    assert.ok(cues17And18.includes(`~$${costUsd} per label read`), "Expected ~$0.003 per label read in Cues 17-18");

    const onnxMb = roundToDecimals(fsEval.onnx.bytes / 1_000_000, 1).toFixed(1);
    const fsPrec = fsEval.strength_visible.precision.toFixed(1);
    const fsValN = fsEval.n_val_images;
    const fsCpuP50 = fsEval.latency_ms_onnx_cpu.p50.toFixed(1);
    assert.equal(onnxMb, "12.8");
    assert.equal(fsPrec, "96.8");
    assert.equal(fsValN, 348);
    assert.equal(fsCpuP50, "34.5");
    assert.ok(beat6Slice.includes(`${onnxMb} MB`) && beat6Slice.includes(`${fsPrec}%`));
    assert.ok(beat6Slice.includes(`n = ${fsValN}`) && beat6Slice.includes(`${fsCpuP50} ms`));
    assert.ok(cues17And18.includes(`${onnxMb} MB`) && cues17And18.includes(`${fsPrec}%`));
  });

  test("parses docs/video-captions.vtt as valid W3C WebVTT covering 00:00.000..02:00.000 with 18 contiguous non-overlapping cues, speakers, and audio descriptions", () => {
    const vtt = readRepoFile("docs/video-captions.vtt");
    assert.ok(vtt.startsWith("WEBVTT\n\n"), "docs/video-captions.vtt must start with WEBVTT header and blank line");

    const cues = parseWebVtt(vtt);
    assert.equal(cues.length, 18, `Expected 18 WebVTT cues (1..18), got ${cues.length}`);
    assert.equal(cues[0]?.startRaw, "00:00.000", "First cue must start at 00:00.000");
    assert.equal(cues[0]?.startMs, 0);
    assert.equal(cues[cues.length - 1]?.endRaw, "02:00.000", "Final cue must end at 02:00.000");
    assert.equal(cues[cues.length - 1]?.endMs, 120_000);

    for (let i = 0; i < cues.length; i++) {
      const cue = cues[i];
      assert.equal(cue.id, String(i + 1), `Expected sequential cue id ${i + 1}`);
      assert.ok(cue.startMs >= 0 && cue.endMs <= 120_000, `Cue ${i + 1} outside [0, 120000] ms`);
      assert.ok(cue.startMs < cue.endMs, `Cue ${i + 1} must satisfy start < end (${cue.startRaw} --> ${cue.endRaw})`);
      if (i > 0) {
        const prev = cues[i - 1];
        assert.equal(
          cue.startMs,
          prev.endMs,
          `Cue ${i + 1} (${cue.startRaw}) must be contiguous and non-overlapping with previous cue ending at ${prev.endRaw}`,
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

  test("enforces zero comments, zero em dashes, zero leaked secrets, and zero git/subprocess calls (zip-safe)", () => {
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

    const selfSource = readRepoFile("web/test/videoScriptContract.test.ts");
    for (const forbidden of FORBIDDEN_SUBPROCESS_TOKENS) {
      assert.equal(
        selfSource.includes(forbidden),
        false,
        `web/test/videoScriptContract.test.ts must stay zip-safe without "${forbidden}"`,
      );
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
