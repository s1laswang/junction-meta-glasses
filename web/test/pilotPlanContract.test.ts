import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_FILE = fileURLToPath(import.meta.url);
const TEST_DIR = path.dirname(TEST_FILE);
const REPO_DIR = path.resolve(TEST_DIR, "..", "..");
const SLASH = String.fromCharCode(47);
const ASTERISK = String.fromCharCode(42);
const LINE_COMMENT_TOKEN = SLASH + SLASH;
const BLOCK_COMMENT_TOKEN = SLASH + ASTERISK;
const HTML_COMMENT_TOKEN = "<" + "!--";
const EM_DASH = String.fromCharCode(0x2014);
const ESCAPED_EM_DASH = ["\\", "u2014"].join("");
const CHILD_PROC_TOKEN = ["child", "process"].join("_");
const EXEC_SYNC_TOKEN = ["exec", "Sync"].join("");
const SPAWN_SYNC_TOKEN = ["spawn", "Sync"].join("");

type VerifyFeatureStats = {
  calls: number;
  ok: number;
  errors: number;
  latency_p50_s: number;
  latency_p95_s: number;
  tokens_in: number;
  tokens_out: number;
  tokens_thinking: number;
  models: Record<string, number>;
};

type LiveFeatureStats = {
  calls: number;
  ok: number;
  errors: number;
  first_audio_p50_s: number;
  first_audio_p95_s: number;
  models: Record<string, number>;
};

type ApiStatsSnapshot = {
  total: number;
  features: {
    verify: VerifyFeatureStats;
    verify_spec: VerifyFeatureStats;
    live: LiveFeatureStats;
  };
};

type EvalV1Results = {
  model: string;
  conf_threshold: number;
  synthetic: {
    images_scored: number;
    errors: number;
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

type EvalV2SafetyRescore = {
  images: number;
  verdicts_n: number;
  unsafe_reassurance_silent: {
    k: number;
    n: number;
    wilson95_pct: [number, number];
  };
};

type FieldSpotterResults = {
  n_val_images: number;
  strength_visible: {
    precision: number;
    recall: number;
  };
  onnx: {
    bytes: number;
  };
  latency_ms_onnx_cpu: {
    p50: number;
    p95: number;
  };
};

type FieldSpotterGemmaResults = {
  n_val_images: number;
  strength_visible: {
    precision: number;
    recall: number;
  };
};

type RedteamV1Results = {
  counts: {
    families: number;
    specs_total: number;
    verified_clean_renders: number;
    images_evaluated: number;
  };
  overall_current_safety_ts: {
    n: number;
    unsafe_k: number;
    unsafe_rate_pct: number;
    unsafe_wilson95_pct: [number, number];
  };
  overall_baseline_safety_ts: {
    n: number;
    unsafe_k: number;
    unsafe_rate_pct: number;
  };
  fixtures_written: number;
};

function readRepoFile(relPath: string): string {
  return fs.readFileSync(path.join(REPO_DIR, relPath), "utf8");
}

function extractH2Sections(markdown: string): Array<{ heading: string; body: string }> {
  const lines = markdown.split("\n");
  const sections: Array<{ heading: string; startLine: number; endLine: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      if (sections.length > 0) {
        sections[sections.length - 1].endLine = i;
      }
      sections.push({
        heading: lines[i].slice(3).trim(),
        startLine: i + 1,
        endLine: lines.length,
      });
    }
  }
  return sections.map((s) => ({
    heading: s.heading,
    body: lines.slice(s.startLine, s.endLine).join("\n").trim(),
  }));
}

function decodeHtmlEntities(raw: string): string {
  const named: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
    "&nbsp;": " ",
    "&middot;": "\u00b7",
    "&ldquo;": "\u201c",
    "&rdquo;": "\u201d",
    "&lsquo;": "\u2018",
    "&rsquo;": "\u2019",
    "&ndash;": "\u2013",
    "&times;": "\u00d7",
  };
  return raw
    .replace(/&#(\d+);/g, (_all, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_all, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&[a-zA-Z0-9#]+;/g, (ent) => named[ent] ?? ent);
}

function stripTags(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

function extractSlides(deckHtml: string): string[] {
  const matches = deckHtml.match(/<section\s+class="slide(?:\s+[^"]*)?"[\s\S]*?<\/section>/g);
  return matches ?? [];
}

function findSlideByHeadingId(slides: string[], headingId: string): string {
  const slide = slides.find((s) => s.includes(`id="${headingId}"`));
  assert.ok(slide, `Expected slide with heading id="${headingId}"`);
  return slide;
}

function countWrappedLines(text: string, maxWidthPx: number, pxPerChar: number): number {
  const maxChars = Math.floor(maxWidthPx / pxPerChar);
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  let lines = 1;
  let lineLen = 0;
  for (const word of words) {
    const nextLen = lineLen === 0 ? word.length : lineLen + 1 + word.length;
    if (lineLen > 0 && nextLen > maxChars) {
      lines++;
      lineLen = word.length;
    } else {
      lineLen = nextLen;
    }
  }
  return lines;
}

function extractReferencedRepoPaths(markdown: string): string[] {
  const prefixes = ["docs/", "server/", "web/", "shared/", "eval/", "deck/", "android-dat/", "scripts/"];
  const rootFiles = new Set(["README.md", "BRIEF.md", "GEMINI.md", "GEMMA.md", "Makefile", "package.json"]);
  const found = new Set<string>();

  for (const match of markdown.matchAll(/`([^`\n]+)`/g)) {
    const token = match[1].trim().split(/[:#]/)[0];
    if (rootFiles.has(token) || prefixes.some((p) => token.startsWith(p))) {
      found.add(token);
    }
  }

  for (const match of markdown.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1].trim().split("#")[0];
    if (rootFiles.has(target) || prefixes.some((p) => target.startsWith(p))) {
      found.add(target);
    }
  }

  for (const match of markdown.matchAll(/\b((?:docs|server|web|shared|eval|deck|android-dat|scripts)\/[A-Za-z0-9_./-]+)/g)) {
    const cleaned = match[1].replace(/[.,;:)]+$/, "");
    found.add(cleaned);
  }

  return [...found].sort();
}

describe("Pilot and adoption plan contract (docs/PILOT_PLAN.md)", () => {
  const pilotPlan = readRepoFile("docs/PILOT_PLAN.md");
  const research = readRepoFile("docs/RESEARCH.md");
  const evalDoc = readRepoFile("docs/EVAL.md");
  const gemmaDoc = readRepoFile("GEMMA.md");
  const privacyDoc = readRepoFile("docs/PRIVACY.md");
  const langQaDoc = readRepoFile("docs/LANG_QA.md");
  const simUserDoc = readRepoFile("docs/SIM_USER_TESTS.md");
  const userFeedbackDoc = readRepoFile("docs/USER_FEEDBACK.md");
  const userTestKitDoc = readRepoFile("docs/USER_TEST_KIT.md");
  const morningBriefDoc = readRepoFile("docs/MORNING_BRIEF.md");
  const liveSrc = readRepoFile("server/src/live.ts");
  const safetySrc = readRepoFile("server/src/safety.ts");
  const checkerSrc = readRepoFile("web/src/lib/checker.ts");
  const liveScreenSrc = readRepoFile("web/src/screens/Live.tsx");
  const onboardingSrc = readRepoFile("web/src/screens/Onboarding.tsx");
  const smokeRuns = readRepoFile("docs/evidence/smoke-runs.md");
  const verdaDoc = readRepoFile("docs/evidence/verda-fieldspotter.md");
  const deck = readRepoFile("deck/index.html");
  const selfSource = fs.readFileSync(TEST_FILE, "utf8");
  const sections = extractH2Sections(pilotPlan);
  const slides = extractSlides(deck);

  test("docs/PILOT_PLAN.md is a crisp 5-section supervised pilot runbook with honest non-CE and abstention wording plus zero comments and em dashes", () => {
    assert.equal(pilotPlan.includes(EM_DASH), false, "docs/PILOT_PLAN.md must contain zero em dashes (U+2014)");
    assert.equal(pilotPlan.includes(ESCAPED_EM_DASH), false, "docs/PILOT_PLAN.md must contain zero escaped em dashes");
    assert.equal(pilotPlan.includes(HTML_COMMENT_TOKEN), false, "docs/PILOT_PLAN.md must contain zero HTML comments");
    assert.equal(selfSource.includes(EM_DASH), false, "pilotPlanContract.test.ts must contain zero em dashes (U+2014)");
    assert.equal(selfSource.includes(ESCAPED_EM_DASH), false, "pilotPlanContract.test.ts must contain zero escaped em dashes");
    assert.equal(selfSource.includes(LINE_COMMENT_TOKEN), false, "pilotPlanContract.test.ts must contain zero line comments");
    assert.equal(selfSource.includes(BLOCK_COMMENT_TOKEN), false, "pilotPlanContract.test.ts must contain zero block comments");
    assert.equal(selfSource.includes(HTML_COMMENT_TOKEN), false, "pilotPlanContract.test.ts must contain zero HTML comments");
    assert.equal(selfSource.includes(CHILD_PROC_TOKEN), false, "pilotPlanContract.test.ts must remain zip-safe without subprocess imports");
    assert.equal(selfSource.includes(EXEC_SYNC_TOKEN), false, "pilotPlanContract.test.ts must remain zip-safe without sync shell execution");
    assert.equal(selfSource.includes(SPAWN_SYNC_TOKEN), false, "pilotPlanContract.test.ts must remain zip-safe without sync process spawning");

    const lineCount = pilotPlan.trim().split("\n").length;
    assert.ok(lineCount >= 30 && lineCount <= 90, `Expected crisp 1-page runbook (30-90 lines), got ${lineCount}`);

    assert.equal(sections.length, 5, "docs/PILOT_PLAN.md must contain exactly 5 H2 sections");
    assert.match(sections[0].heading, /^1\.\s+Phase 0 Supervised Study.*Näkövammaisten liitto.*Iiris.*Helsinki/);
    assert.match(sections[1].heading, /^2\.\s+Pre-Pilot Security and Privacy Gate.*docs\/PRIVACY\.md/);
    assert.match(sections[2].heading, /^3\.\s+Three-Channel Rollout Workflow/);
    assert.match(sections[3].heading, /^4\.\s+Hardware, Accessibility, and Unit Economics/);
    assert.match(sections[4].heading, /^5\.\s+Measurable Pilot KPIs and Stop Rules/);

    assert.ok(pilotPlan.toLowerCase().includes("proposed pilot; user outreach in progress"));
    assert.equal(
      pilotPlan.toLowerCase().includes("never guesses a dose"),
      false,
      "docs/PILOT_PLAN.md must not contain the 'never guesses a dose' overclaim",
    );
    assert.equal(
      pilotPlan.toLowerCase().includes("runs today on consumer ray-ban meta"),
      false,
      "docs/PILOT_PLAN.md must not overclaim unverified on-glasses execution",
    );
    assert.ok(
      onboardingSrc.includes("HoldUp is a research prototype, not a CE-marked medical device."),
      "Onboarding.tsx must state the non-CE research prototype disclosure",
    );
    assert.ok(sections[0].body.includes("4-week"));
    assert.ok(sections[0].body.includes("20"));
    assert.ok(sections[0].body.includes("EU MDR"));
    assert.ok(sections[0].body.includes("Class IIa"));
    assert.ok(sections[0].body.includes("Rule 11"));
    assert.ok(sections[0].body.includes("Decision support, not diagnosis."));
    assert.ok(sections[0].body.includes("web/src/screens/Onboarding.tsx"));
    assert.ok(sections[0].body.includes("research prototype, not CE-marked"));
    assert.ok(sections[0].body.includes("HoldUp is a research prototype, not a CE-marked medical device"));
    assert.ok(sections[0].body.includes("HoldUp abstains whenever a dose or allergen read falls below threshold"));
    assert.ok(sections[0].body.includes("assistive information aid"));
    assert.ok(sections[0].body.includes("Not sure"));
    assert.ok(sections[0].body.includes("< 0.8"));
    assert.ok(sections[0].body.includes("< 0.95"));
    assert.ok(sections[0].body.includes("ask a pharmacist"));
  });

  test("Section 2 closes every pre-pilot security and privacy limitation listed in docs/PRIVACY.md section 5 and section 6", () => {
    const privacySections = extractH2Sections(privacyDoc);
    const privacySec5 = privacySections.find((s) => s.heading.startsWith("5."));
    const privacySec6 = privacySections.find((s) => s.heading.startsWith("6."));
    assert.ok(privacySec5 && privacySec6, "Expected sections 5 and 6 in docs/PRIVACY.md");

    assert.ok(privacySec6.body.includes("No authentication"));
    assert.ok(privacySec6.body.includes("per-user token"));
    assert.ok(privacySec6.body.includes("10 minutes"));
    assert.ok(privacySec6.body.includes("5 MB"));
    assert.ok(privacySec5.body.includes("paid, billing-enabled project with a data-processing agreement"));
    assert.ok(privacySec6.body.includes("Oikea pakkaus."));

    const sec2 = sections[1].body;
    assert.ok(sec2.includes("per-user cryptographic pairing token"));
    assert.ok(sec2.includes("web/src/lib/checker.ts"));
    assert.ok(sec2.includes("android-dat/"));
    assert.ok(sec2.includes("/hud/"));
    assert.ok(sec2.includes("immediately when the phone WebSocket disconnects"));
    assert.ok(sec2.includes("10 minutes"));
    assert.ok(sec2.includes("5 MB"));
    assert.ok(sec2.includes("paid, billing-enabled Google Cloud / Gemini API project"));
    assert.ok(sec2.includes("EU Data Processing Agreement (DPA)"));
    assert.ok(sec2.includes("Oikea pakkaus."));
    assert.ok(sec2.includes("Jag är inte säker."));
    assert.ok(sec2.includes("Tiedoksi."));
    assert.ok(sec2.includes("För kännedom."));
    assert.ok(sec2.includes("docs/LANG_QA.md"));
    assert.ok(sec2.includes("does not replace human native Finnish and Swedish pharmacist sign-off before Phase 0"));
  });

  test("Section 2 item 4 and Section 4 enforce LANG_QA.md clinical gate, SIM_USER_TESTS.md simulated UX regression gate, and $0.003 Slide 12 parity", () => {
    for (const langToken of [
      "MODEL-REVIEWED",
      "n = 30",
      "17 / 30",
      "14 / 14",
      "1169/2011",
      "Tiedoksi.",
      "För kännedom.",
      "2,5 mg",
    ]) {
      assert.ok(langQaDoc.includes(langToken), `docs/LANG_QA.md must include "${langToken}"`);
      assert.ok(sections[1].body.includes(langToken), `Section 2 must match docs/LANG_QA.md token "${langToken}"`);
    }

    for (const liveToken of [
      "Oikea pakkaus.",
      "Varoitus.",
      "En ole varma.",
      "Tiedoksi.",
      "Rätt förpackning.",
      "Varning.",
      "Jag är inte säker.",
      "För kännedom.",
      "2,5 mg",
    ]) {
      assert.ok(liveSrc.includes(liveToken), `server/src/live.ts must include "${liveToken}"`);
      assert.ok(sections[1].body.includes(liveToken), `Section 2 must cite server/src/live.ts token "${liveToken}"`);
    }

    const allergensBlockMatch = /const ALLERGENS:\s*Record<string,\s*string\[\]>\s*=\s*\{([\s\S]*?)\n\};/.exec(safetySrc);
    assert.ok(allergensBlockMatch, "Expected ALLERGENS map in server/src/safety.ts");
    const allergenGroupLines = allergensBlockMatch[1]
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    assert.equal(allergenGroupLines.length, 14, "Expected 14 EU 1169/2011 allergen groups in server/src/safety.ts");
    for (const inflectedTerm of ["maapahkinaa", "pahkinan", "jordnotter", "hasselnotter"]) {
      assert.ok(safetySrc.includes(inflectedTerm), `server/src/safety.ts must include inflected allergen "${inflectedTerm}"`);
    }

    for (const simToken of ["n = 40", "100% SIMULATED", "80 / 80", "40 / 40", "UX-01", "UX-02", "UX-03", "UX-04", "UX-05"]) {
      assert.ok(simUserDoc.includes(simToken), `docs/SIM_USER_TESTS.md must include "${simToken}"`);
    }
    assert.ok(simUserDoc.includes("zero (`n = 0`) real blind or low-vision human user sessions"));
    assert.ok(userFeedbackDoc.includes("PENDING REAL SESSION") && userFeedbackDoc.includes("never invent a quote"));
    assert.ok(userTestKitDoc.includes("docs/USER_FEEDBACK.md"));
    assert.ok(checkerSrc.includes("AUTO_STOP_WARN_MS = 35_000") && checkerSrc.includes("pendingDm"));
    assert.ok(liveScreenSrc.includes('"Escape"') && liveScreenSrc.includes("dismissVerdict()"));

    const sec4 = sections[3].body;
    for (const sec4SimToken of [
      "docs/SIM_USER_TESTS.md",
      "n = 40",
      "100% SIMULATED",
      "80 / 80",
      "`0` real human sessions claimed",
      "docs/USER_FEEDBACK.md",
      "docs/USER_TEST_KIT.md",
      "UX-01",
      "UX-05",
      "web/test/simUserUxFixes.test.ts",
      "35 s",
      "Escape",
      "DataMatrix",
    ]) {
      assert.ok(sec4.includes(sec4SimToken), `Section 4 must include simulated UX regression token "${sec4SimToken}"`);
    }

    assert.ok(morningBriefDoc.includes("$0.003 per label read"), "docs/MORNING_BRIEF.md must state $0.003 per label read");
    const slide12Text = stripTags(findSlideByHeadingId(slides, "s12-h"));
    assert.ok(
      slide12Text.includes("About $0.003 per label read on Gemini Flash (metered; Live audio extra)."),
      "Slide 12 (#s12-h) must state the metered ~$0.003 per label read figure",
    );
    for (const costToken of [
      "~$0.003",
      "$0.003 per label read",
      "About $0.003 per label read on Gemini Flash (metered; Live audio extra).",
      "docs/MORNING_BRIEF.md",
    ]) {
      assert.ok(sec4.includes(costToken), `Section 4 must include unit-economics parity token "${costToken}"`);
    }
  });

  test("Sections 3, 4, and 5 maintain exact metric parity with docs/RESEARCH.md, docs/EVAL.md, api-stats-snapshot.json, and fieldspotter.json", () => {
    for (const token of [
      "55,000",
      "45,000",
      "2.2 billion",
      "97%",
      "24%",
      "2.8",
      "21.6%",
      "Directive 2001/83/EC Art. 56a",
      "Be My Eyes",
      "21 markets",
    ]) {
      assert.ok(research.includes(token), `docs/RESEARCH.md must contain "${token}"`);
      assert.ok(pilotPlan.includes(token), `docs/PILOT_PLAN.md must match docs/RESEARCH.md token "${token}"`);
    }

    assert.ok(sections[2].body.includes("hyvinvointialueet"));
    assert.ok(sections[2].body.includes("EU FMD GS1 DataMatrix"));
    assert.ok(sections[2].body.includes("< 30 s"));
    assert.ok(sections[2].body.includes("dose log"));

    const stats = JSON.parse(readRepoFile("docs/evidence/api-stats-snapshot.json")) as ApiStatsSnapshot;
    assert.equal(stats.features.verify.calls, 12);
    assert.equal(stats.features.verify.tokens_in, 30852);
    assert.equal(stats.features.verify.tokens_out, 1672);
    assert.equal(stats.features.verify.tokens_thinking, 1071);
    assert.equal(stats.features.verify.models["gemini-3.8-flash"], 12);

    const avgVerifyIn = Math.round(stats.features.verify.tokens_in / stats.features.verify.calls);
    const avgVerifyOutPlusThinking = Math.round(
      (stats.features.verify.tokens_out + stats.features.verify.tokens_thinking) / stats.features.verify.calls,
    );
    assert.equal(avgVerifyIn, 2571);
    assert.equal(avgVerifyOutPlusThinking, 229);

    const avgSpecIn = Math.round(stats.features.verify_spec.tokens_in / stats.features.verify_spec.calls);
    const avgSpecOutPlusThinking = Math.round(
      (stats.features.verify_spec.tokens_out + stats.features.verify_spec.tokens_thinking) /
        stats.features.verify_spec.calls,
    );
    assert.equal(avgSpecIn, 2896);
    assert.equal(avgSpecOutPlusThinking, 318);

    const sec4 = sections[3].body;
    assert.ok(
      sec4.includes(
        "HoldUp is built for consumer Ray-Ban Meta smart glasses (Android DAT bridge APK compiled and unit-tested; today the full loop runs on the phone camera with the glasses as a Bluetooth headset while the on-glasses run is logged in docs/HARDWARE_LOG.md",
      ),
      "Section 4 must state the honest 'built for consumer Ray-Ban Meta smart glasses' hardware status",
    );
    for (const token of [
      "30,852",
      "1,672",
      "1,071",
      "12",
      "2,571",
      "~229",
      "gemini-3.8-flash",
      "sub-cent",
      "free for users",
      "EN/FI/SV",
      "docs/HARDWARE_LOG.md",
      "scripts/a11y-privacy-check.mjs",
    ]) {
      assert.ok(sec4.includes(token), `Section 4 must include figure/reference "${token}"`);
    }

    const fsJson = JSON.parse(readRepoFile("eval/results/fieldspotter.json")) as FieldSpotterResults;
    const fsGemmaJson = JSON.parse(readRepoFile("eval/results/fieldspotter_gemma.json")) as FieldSpotterGemmaResults;
    const onnxStat = fs.statSync(path.join(REPO_DIR, "web/public/models/fieldspotter.onnx"));
    assert.equal(fsJson.onnx.bytes, 12776109);
    assert.equal(onnxStat.size, fsJson.onnx.bytes);
    assert.equal((fsJson.onnx.bytes / 1_000_000).toFixed(1), "12.8");
    assert.equal(fsJson.latency_ms_onnx_cpu.p50, 34.5);
    assert.equal(fsJson.latency_ms_onnx_cpu.p95, 35.3);
    assert.equal(fsJson.strength_visible.precision, 96.8);
    assert.equal(fsJson.strength_visible.recall, 65.6);
    assert.equal(fsJson.n_val_images, 348);
    assert.equal(fsGemmaJson.n_val_images, 348);
    assert.equal(fsGemmaJson.strength_visible.recall, 91.4);
    assert.equal(fsGemmaJson.strength_visible.precision, 89.9);
    assert.ok(verdaDoc.includes("12.8 MB") && verdaDoc.includes("34.5 ms"));
    assert.ok(gemmaDoc.includes("PaliGemma 2 3B") && gemmaDoc.includes("91.4%") && gemmaDoc.includes("89.9%"));
    for (const detectorToken of [
      "12.8 MB",
      "fieldspotter.onnx",
      "34.5 ms",
      "96.8%",
      "65.6%",
      "n = 348",
      "PaliGemma 2 3B LoRA",
      "GEMMA.md",
      "eval/results/fieldspotter_gemma.json",
      "91.4%",
      "89.9%",
    ]) {
      assert.ok(sec4.includes(detectorToken), `Section 4 must include detector comparison token "${detectorToken}"`);
    }

    const redteamJson = JSON.parse(readRepoFile("eval/results/redteam_v1.json")) as RedteamV1Results;
    assert.equal(redteamJson.counts.families, 32);
    assert.equal(redteamJson.counts.specs_total, 2048);
    assert.equal(redteamJson.counts.verified_clean_renders, 566);
    assert.equal(redteamJson.counts.images_evaluated, 2264);
    assert.equal(redteamJson.overall_baseline_safety_ts.unsafe_k, 199);
    assert.equal(redteamJson.overall_baseline_safety_ts.unsafe_rate_pct, 8.79);
    assert.equal(redteamJson.overall_current_safety_ts.unsafe_k, 13);
    assert.equal(redteamJson.overall_current_safety_ts.unsafe_rate_pct, 0.57);
    assert.deepEqual(redteamJson.overall_current_safety_ts.unsafe_wilson95_pct, [0.34, 0.98]);
    assert.equal(redteamJson.fixtures_written, 199);
    for (const rtToken of [
      "32-family",
      "2,264",
      "2,048",
      "566",
      "eval/results/redteam_v1.json",
      "199 / 2,264 = 8.79%",
      "13 / 2,264 = 0.57%",
      "0.34-0.98%",
      "in-sample",
      "server/test/safety-redteam-ws1.test.ts",
    ]) {
      assert.ok(sec4.includes(rtToken), `Section 4 must include WS1 red-team token "${rtToken}"`);
    }

    const evalV1 = JSON.parse(readRepoFile("eval/results/v1_results.json")) as EvalV1Results;
    const evalV2 = JSON.parse(readRepoFile("eval/results/v2_safety_rescore.json")) as EvalV2SafetyRescore;
    assert.equal(evalV1.synthetic.images_scored, 1740);
    assert.equal(evalV1.synthetic.per_field.strength.confident_wrong, 0);
    assert.equal(evalV1.synthetic.per_field.strength.k.confident, 754);
    assert.equal(evalV2.unsafe_reassurance_silent.k, 3);
    assert.equal(evalV2.unsafe_reassurance_silent.n, 4730);
    assert.equal(((evalV2.unsafe_reassurance_silent.k / evalV2.unsafe_reassurance_silent.n) * 100).toFixed(2), "0.06");

    assert.equal(stats.features.live.ok, 26);
    assert.equal((Math.round(stats.features.live.first_audio_p50_s * 10) / 10).toFixed(1), "2.1");
    assert.equal((Math.round(stats.features.live.first_audio_p95_s * 10) / 10).toFixed(1), "3.4");
    assert.ok(smokeRuns.includes("2.09 s") && smokeRuns.includes("3.45 s"));

    const sec5 = sections[4].body;
    for (const evalToken of [
      "1,740",
      "0 / 754",
      "1 / 536 = 0.19%",
      "1,060",
      "3 / 4,730 = 0.06%",
      "4 / 3,033 = 0.13%",
      "14 / 4,041 = 0.35%",
      "0.022",
    ]) {
      assert.ok(evalDoc.includes(evalToken), `docs/EVAL.md must include "${evalToken}"`);
      assert.ok(sec5.includes(evalToken), `Section 5 must match docs/EVAL.md token "${evalToken}"`);
    }
    for (const kpiToken of ["< 0.1%", "p50 < 2.5 s", "2.1 s", "3.4 s", "n = 26", "retention", "would use daily"]) {
      assert.ok(sec5.includes(kpiToken), `Section 5 must define KPI "${kpiToken}"`);
    }
  });

  test("deck/index.html 13-slide parity across Slide 2 (#s2-h), Slide 3 (#s3-h), Slide 9 (#s9-h), Slide 12 (#s12-h), and Slide 13 (#s13-h) aligns with docs/PILOT_PLAN.md and 1280x720 bounds", () => {
    assert.equal(slides.length, 13, "Expected 13 slides in deck/index.html");
    for (let n = 1; n <= 13; n++) {
      findSlideByHeadingId(slides, `s${n}-h`);
    }
    const navCountMatch = /<span\s+id="count"[^>]*>([\s\S]*?)<\/span>/.exec(deck);
    assert.ok(navCountMatch && navCountMatch[1].trim() === `1 ${SLASH} 13`, "Expected #count to read 1 / 13");
    assert.match(deck, /--W:\s*1280px;\s*--H:\s*720px;/);
    assert.match(deck, /\.slide\s*\{[^}]*padding:\s*44px\s+64px\s+58px;[^}]*gap:\s*18px;[^}]*overflow:\s*hidden;/s);
    assert.match(deck, /\.foot\s*\{[^}]*bottom:\s*20px;[^}]*font-size:\s*14px;/s);

    const slide3 = findSlideByHeadingId(slides, "s3-h");
    assert.equal(slide3.includes(EM_DASH), false, "Slide 3 (#s3-h) must contain zero em dashes");
    const slide3Text = stripTags(slide3);
    for (const s3Token of [
      "It is built for Ray-Ban Meta",
      "camera via the Device Access Toolkit; the bridge APK compiles and its tests pass",
      "Today the full loop runs on the phone camera, with the glasses as a Bluetooth headset",
      "docs/HARDWARE_LOG.md",
    ]) {
      assert.ok(slide3Text.includes(s3Token), `Slide 3 (#s3-h) must include "${s3Token}"`);
    }

    const slide9 = findSlideByHeadingId(slides, "s9-h");
    assert.equal(slide9.includes(EM_DASH), false, "Slide 9 (#s9-h) must contain zero em dashes");
    const slide9Text = stripTags(slide9);
    for (const s9Token of [
      "Liability and regulation",
      "Decision support, not diagnosis.",
      "Rule 11, Class IIa",
      "supervised study",
      "Näkövammaisten liitto",
      "before any CE marking",
      "ask a pharmacist",
      "0.06%",
      "3/4,730",
    ]) {
      assert.ok(slide9Text.includes(s9Token), `Slide 9 (#s9-h) must include "${s9Token}"`);
    }

    const slide13 = findSlideByHeadingId(slides, "s13-h");
    assert.equal(slide13.includes(EM_DASH), false, "Slide 13 (#s13-h) must contain zero em dashes");
    const slide13Text = stripTags(slide13);
    for (const s13Token of [
      "Team and the ask",
      "Help us put HoldUp on 20 faces in Finland.",
      "Device Access Toolkit",
      "Display Web Apps",
      "20 testers",
      "Gemini API credits",
      "Live API capacity in the EU",
      "Näkövammaisten liitto",
      "pharmacy chain",
      "wellbeing services county",
    ]) {
      assert.ok(slide13Text.includes(s13Token), `Slide 13 (#s13-h) must include "${s13Token}"`);
    }

    const slideW = 1280;
    const slideH = 720;
    const padTop = 44;
    const padX = 64;
    const padBottom = 58;
    const slideGap = 18;
    const footBottom = 20;
    const innerW = slideW - 2 * padX;
    const maxContentH = slideH - padTop - padBottom;
    const cardChromeX = 2 * 2 + 2 * 20;
    const cardChromeY = 2 * 2 + 2 * 16;

    const slide2 = findSlideByHeadingId(slides, "s2-h");
    assert.equal(slide2.includes(EM_DASH), false, "Slide 2 must contain zero em dashes");

    const s2Eyebrow = /<p class="eyebrow">([\s\S]*?)<\/p>/.exec(slide2);
    const s2H2 = /<h2 id="s2-h">([\s\S]*?)<\/h2>/.exec(slide2);
    assert.ok(s2Eyebrow && s2H2, "Slide 2 must have .eyebrow and #s2-h");
    assert.equal(countWrappedLines(stripTags(s2Eyebrow[1]), innerW, 10.5), 1, "Slide 2 eyebrow must be single-line");
    assert.equal(countWrappedLines(stripTags(s2H2[1]), 1120, 18.7), 1, "Slide 2 h2 must be single-line");

    const s2StatCards = [...slide2.matchAll(/<div class="card stat">([\s\S]*?)<\/div>/g)].map((m) => m[1]);
    assert.equal(s2StatCards.length, 4, "Slide 2 .grid4 must contain 4 .card.stat cards");
    const statInnerW = (innerW - 3 * 18) / 4 - cardChromeX;
    const s2StatHeights = s2StatCards.map((cardHtml) => {
      const pTags = [...cardHtml.matchAll(/<p(?:\s+class="([^"]*)")?>([\s\S]*?)<\/p>/g)];
      assert.equal(pTags.length, 3, "Each Slide 2 .card.stat must have 3 <p> elements");
      const bodyLines = countWrappedLines(stripTags(pTags[1][2]), statInnerW, 7.8);
      const srcLines = countWrappedLines(stripTags(pTags[2][2]), statInnerW, 6.2);
      assert.ok(bodyLines <= 4, `Slide 2 .stat body must stay <= 4 lines, got ${bodyLines}`);
      assert.ok(srcLines <= 2, `Slide 2 .stat source must stay <= 2 lines, got ${srcLines}`);
      return cardChromeY + 2 * 8 + 48 + bodyLines * (16 * 1.33) + srcLines * (13 * 1.33);
    });
    const s2Grid4H = Math.max(...s2StatHeights);

    const whoMatch = /<h3>Who it is for<\/h3>\s*<ul class="bul">([\s\S]*?)<\/ul>/.exec(slide2);
    const existsMatch = /<h3>What exists today<\/h3>\s*<ul class="bul">([\s\S]*?)<\/ul>/.exec(slide2);
    assert.ok(whoMatch && existsMatch, "Slide 2 must contain Who it is for and What exists today lists");
    const whoBullets = [...whoMatch[1].matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => stripTags(m[1]));
    const existsBullets = [...existsMatch[1].matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => stripTags(m[1]));
    assert.equal(whoBullets.length, 3, "Slide 2 Who it is for must have 3 bullets");
    assert.equal(existsBullets.length, 4, "Slide 2 What exists today must have 4 bullets");

    const whoBulletW = ((innerW - 24) * 1.1) / 2.1 - cardChromeX - 22;
    const existsBulletW = ((innerW - 24) * 1.0) / 2.1 - cardChromeX - 22;
    const whoLines = whoBullets.reduce((sum, b) => sum + countWrappedLines(b, whoBulletW, 8.5), 0);
    const existsPerBulletLines = existsBullets.map((b) => countWrappedLines(b, existsBulletW, 8.5));
    const existsLines = existsPerBulletLines.reduce((sum, n) => sum + n, 0);
    assert.ok(whoLines <= 8, `Slide 2 Who it is for must stay <= 8 wrapped lines, got ${whoLines}`);
    for (const lines of existsPerBulletLines) {
      assert.ok(lines <= 2, `Each Slide 2 What exists today bullet must stay <= 2 lines, got ${lines}`);
    }
    assert.ok(existsLines <= 8, `Slide 2 What exists today must stay <= 8 wrapped lines, got ${existsLines}`);

    const s2Grid2H = Math.max(
      cardChromeY + 22 * 1.2 + 8 + (whoBullets.length - 1) * 6 + whoLines * (17 * 1.35),
      cardChromeY + 22 * 1.2 + 8 + (existsBullets.length - 1) * 6 + existsLines * (17 * 1.35),
    );
    const s2FootSrc = /<div class="foot"><span class="src">([\s\S]*?)<\/span>/.exec(slide2);
    assert.ok(s2FootSrc, "Slide 2 must include .foot .src");
    const s2FootTopY = slideH - footBottom - countWrappedLines(stripTags(s2FootSrc[1]), 1000, 7.0) * (14 * 1.3);
    const s2ContentH = 16 * 1.25 + 36 * 1.1 + s2Grid4H + s2Grid2H + 3 * slideGap;
    assert.ok(s2ContentH <= maxContentH, `Slide 2 content (${s2ContentH.toFixed(1)}px) exceeds ${maxContentH}px`);
    assert.ok(padTop + s2ContentH <= s2FootTopY, "Slide 2 content must stay above .foot");

    const slide12 = findSlideByHeadingId(slides, "s12-h");
    assert.equal(slide12.includes(EM_DASH), false, "Slide 12 (#s12-h) must contain zero em dashes");
    for (const token of [
      "Path to adoption",
      "Pilot with the people who already help, on shipping glasses.",
      "Built for shipping hardware.",
      "Näkövammaisten liitto",
      "4-week",
      "20 members",
      "target 0",
      "would use daily",
      "Proposed pilot; user outreach in progress",
      "Pharmacies",
      "Not sure",
      "Home-care nurses",
      "dose log",
      "Be My Eyes",
      "21 markets",
      "PWA",
      "About $0.003 per label read on Gemini Flash (metered; Live audio extra).",
      "Free for users",
      "wellbeing services counties",
      "docs/RESEARCH.md",
    ]) {
      assert.ok(stripTags(slide12).includes(token), `Slide 12 (#s12-h) must contain adoption claim "${token}"`);
    }

    const s12Eyebrow = /<p class="eyebrow">([\s\S]*?)<\/p>/.exec(slide12);
    const s12H2 = /<h2 id="s12-h">([\s\S]*?)<\/h2>/.exec(slide12);
    assert.ok(s12Eyebrow && s12H2, "Slide 12 must have .eyebrow and #s12-h");
    assert.equal(countWrappedLines(stripTags(s12Eyebrow[1]), innerW, 10.5), 1, "Slide 12 eyebrow must be single-line");
    const s12H2Lines = countWrappedLines(stripTags(s12H2[1]), 1120, 18.7);
    assert.ok(s12H2Lines >= 1 && s12H2Lines <= 2, `Slide 12 h2 must stay <= 2 lines, got ${s12H2Lines}`);

    const s12Grid3Match = /<div class="grid3">([\s\S]*?)<\/div>\s*<div class="grid2">/.exec(slide12);
    const s12Grid2Match = /<div class="grid2">([\s\S]*?)<\/div>\s*<div class="foot">/.exec(slide12);
    assert.ok(s12Grid3Match && s12Grid2Match, "Slide 12 must have .grid3 channel row and .grid2 feasibility/model row");

    const s12ChannelCards = [...s12Grid3Match[1].matchAll(/<div class="card(?:\s+hl)?">([\s\S]*?)<\/div>/g)].map(
      (m) => m[1],
    );
    assert.equal(s12ChannelCards.length, 3, "Slide 12 .grid3 must contain 3 channel cards");
    const grid3InnerW = (innerW - 2 * 20) / 3 - cardChromeX;
    const s12ChannelHeights = s12ChannelCards.map((cardHtml, idx) => {
      const h3Match = /<h3>([\s\S]*?)<\/h3>/.exec(cardHtml);
      assert.ok(h3Match, `Slide 12 channel card ${idx + 1} must have <h3>`);
      assert.equal(countWrappedLines(stripTags(h3Match[1]), grid3InnerW, 11.4), 1);
      const pTags = [...cardHtml.matchAll(/<p(?:\s+class="([^"]*)")?>([\s\S]*?)<\/p>/g)];
      assert.ok(pTags.length >= 1 && pTags.length <= 2, `Slide 12 channel card ${idx + 1} must have 1-2 paragraphs`);
      let textH = 0;
      let totalLines = 0;
      for (const p of pTags) {
        const isSmall = (p[1] ?? "").includes("small");
        const lines = countWrappedLines(stripTags(p[2]), grid3InnerW, isSmall ? 7.6 : 8.5);
        totalLines += lines;
        textH += lines * (isSmall ? 15 * 1.4 : 17 * 1.35);
      }
      assert.ok(totalLines <= 8, `Slide 12 channel card ${idx + 1} must stay <= 8 wrapped lines, got ${totalLines}`);
      return cardChromeY + 22 * 1.2 + pTags.length * 8 + textH;
    });
    const s12Grid3H = Math.max(...s12ChannelHeights);

    const s12BottomCards = [...s12Grid2Match[1].matchAll(/<div class="card">([\s\S]*?)<\/div>/g)].map((m) => m[1]);
    assert.equal(s12BottomCards.length, 2, "Slide 12 .grid2 must contain 2 cards");
    const grid2BulletW = (innerW - 24) / 2 - cardChromeX - 22;
    const s12BottomHeights = s12BottomCards.map((cardHtml, idx) => {
      const bullets = [...cardHtml.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => stripTags(m[1]));
      assert.ok(bullets.length >= 2 && bullets.length <= 4, `Slide 12 bottom card ${idx + 1} must have 2-4 bullets`);
      const perBulletLines = bullets.map((b) => countWrappedLines(b, grid2BulletW, 8.5));
      for (const lines of perBulletLines) {
        assert.ok(lines <= 2, `Each Slide 12 bottom bullet must stay <= 2 wrapped lines, got ${lines}`);
      }
      const totalLines = perBulletLines.reduce((sum, n) => sum + n, 0);
      assert.ok(totalLines <= 6, `Slide 12 bottom card ${idx + 1} must stay <= 6 wrapped lines, got ${totalLines}`);
      return cardChromeY + 22 * 1.2 + 8 + (bullets.length - 1) * 6 + totalLines * (17 * 1.35);
    });
    const s12Grid2H = Math.max(...s12BottomHeights);

    const s12FootSrc = /<div class="foot"><span class="src">([\s\S]*?)<\/span>/.exec(slide12);
    assert.ok(s12FootSrc, "Slide 12 must include .foot .src");
    const s12FootTopY = slideH - footBottom - countWrappedLines(stripTags(s12FootSrc[1]), 1000, 7.0) * (14 * 1.3);
    const s12ContentH = 16 * 1.25 + s12H2Lines * (36 * 1.1) + s12Grid3H + s12Grid2H + 3 * slideGap;
    assert.ok(s12ContentH <= maxContentH, `Slide 12 content (${s12ContentH.toFixed(1)}px) exceeds ${maxContentH}px`);
    assert.ok(padTop + s12ContentH <= s12FootTopY, "Slide 12 content must stay above .foot");
  });

  test("every repository path referenced in docs/PILOT_PLAN.md exists on disk", () => {
    const referencedPaths = extractReferencedRepoPaths(pilotPlan);
    assert.ok(referencedPaths.length >= 25, `Expected >= 25 repo path references, got ${referencedPaths.length}`);
    for (const requiredRef of [
      "docs/LANG_QA.md",
      "docs/MORNING_BRIEF.md",
      "docs/SIM_USER_TESTS.md",
      "docs/USER_FEEDBACK.md",
      "docs/USER_TEST_KIT.md",
      "web/public/phrases/manifest.json",
      "web/test/simUserUxFixes.test.ts",
    ]) {
      assert.ok(referencedPaths.includes(requiredRef), `Expected docs/PILOT_PLAN.md to reference "${requiredRef}"`);
    }
    for (const relPath of referencedPaths) {
      const fullPath = path.join(REPO_DIR, relPath);
      assert.equal(fs.existsSync(fullPath), true, `Referenced repo path "${relPath}" must exist on disk`);
    }
  });
});
