import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_FILE = fileURLToPath(import.meta.url);
const TEST_DIR = path.dirname(TEST_FILE);
const REPO_DIR = path.resolve(TEST_DIR, "..", "..");
const EM_DASH = String.fromCharCode(0x2014);

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
  };
  onnx: {
    bytes: number;
  };
  latency_ms_onnx_cpu: {
    p50: number;
    p95: number;
  };
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
  const rootFiles = new Set(["README.md", "BRIEF.md", "GEMINI.md", "Makefile", "package.json"]);
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

  for (const match of markdown.matchAll(/\b((?:docs|server|web|shared|eval|deck|android-dat)\/[A-Za-z0-9_./-]+)/g)) {
    const cleaned = match[1].replace(/[.,;:)]+$/, "");
    found.add(cleaned);
  }

  return [...found].sort();
}

describe("Pilot and adoption plan contract (docs/PILOT_PLAN.md)", () => {
  const pilotPlan = readRepoFile("docs/PILOT_PLAN.md");
  const research = readRepoFile("docs/RESEARCH.md");
  const evalDoc = readRepoFile("docs/EVAL.md");
  const privacyDoc = readRepoFile("docs/PRIVACY.md");
  const smokeRuns = readRepoFile("docs/evidence/smoke-runs.md");
  const verdaDoc = readRepoFile("docs/evidence/verda-fieldspotter.md");
  const deck = readRepoFile("deck/index.html");
  const selfSource = fs.readFileSync(TEST_FILE, "utf8");
  const sections = extractH2Sections(pilotPlan);
  const slides = extractSlides(deck);

  test("docs/PILOT_PLAN.md is a crisp 5-section supervised pilot runbook with zero em dashes", () => {
    assert.equal(pilotPlan.includes(EM_DASH), false, "docs/PILOT_PLAN.md must contain zero em dashes (U+2014)");
    assert.equal(selfSource.includes(EM_DASH), false, "pilotPlanContract.test.ts must contain zero em dashes (U+2014)");

    const lineCount = pilotPlan.trim().split("\n").length;
    assert.ok(lineCount >= 30 && lineCount <= 90, `Expected crisp 1-page runbook (30-90 lines), got ${lineCount}`);

    assert.equal(sections.length, 5, "docs/PILOT_PLAN.md must contain exactly 5 H2 sections");
    assert.match(sections[0].heading, /^1\.\s+Phase 0 Supervised Study.*Näkövammaisten liitto.*Iiris.*Helsinki/);
    assert.match(sections[1].heading, /^2\.\s+Pre-Pilot Security and Privacy Gate.*docs\/PRIVACY\.md/);
    assert.match(sections[2].heading, /^3\.\s+Three-Channel Rollout Workflow/);
    assert.match(sections[3].heading, /^4\.\s+Hardware, Accessibility, and Unit Economics/);
    assert.match(sections[4].heading, /^5\.\s+Measurable Pilot KPIs and Stop Rules/);

    assert.ok(pilotPlan.toLowerCase().includes("proposed pilot; user outreach in progress"));
    assert.ok(sections[0].body.includes("4-week"));
    assert.ok(sections[0].body.includes("20"));
    assert.ok(sections[0].body.includes("EU MDR"));
    assert.ok(sections[0].body.includes("Class IIa"));
    assert.ok(sections[0].body.includes("Rule 11"));
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
    ]) {
      assert.ok(sec4.includes(token), `Section 4 must include metered token/economics figure "${token}"`);
    }

    const fsJson = JSON.parse(readRepoFile("eval/results/fieldspotter.json")) as FieldSpotterResults;
    const onnxStat = fs.statSync(path.join(REPO_DIR, "web/public/models/fieldspotter.onnx"));
    assert.equal(fsJson.onnx.bytes, 12776109);
    assert.equal(onnxStat.size, fsJson.onnx.bytes);
    assert.equal((fsJson.onnx.bytes / 1_000_000).toFixed(1), "12.8");
    assert.equal(fsJson.latency_ms_onnx_cpu.p50, 34.5);
    assert.equal(fsJson.latency_ms_onnx_cpu.p95, 35.3);
    assert.equal(fsJson.strength_visible.precision, 96.8);
    assert.equal(fsJson.n_val_images, 348);
    assert.ok(verdaDoc.includes("12.8 MB") && verdaDoc.includes("34.5 ms"));
    assert.ok(sec4.includes("12.8 MB") && sec4.includes("fieldspotter.onnx") && sec4.includes("34.5 ms"));

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
    for (const evalToken of ["1,740", "0 / 754", "3 / 4,730 = 0.06%", "0.022"]) {
      assert.ok(evalDoc.includes(evalToken), `docs/EVAL.md must include "${evalToken}"`);
      assert.ok(sec5.includes(evalToken), `Section 5 must match docs/EVAL.md token "${evalToken}"`);
    }
    for (const kpiToken of ["< 0.1%", "p50 < 2.5 s", "2.1 s", "3.4 s", "n = 26", "retention", "would use daily"]) {
      assert.ok(sec5.includes(kpiToken), `Section 5 must define KPI "${kpiToken}"`);
    }
  });

  test("deck/index.html Slide 2 (#s2-h) and Slide 11 (#s11-h) align with docs/PILOT_PLAN.md and fit cleanly within 1280x720 card and bullet density bounds", () => {
    assert.equal(slides.length, 12, "Expected 12 slides in deck/index.html");
    assert.match(deck, /--W:\s*1280px;\s*--H:\s*720px;/);
    assert.match(deck, /\.slide\s*\{[^}]*padding:\s*44px\s+64px\s+58px;[^}]*gap:\s*18px;[^}]*overflow:\s*hidden;/s);
    assert.match(deck, /\.foot\s*\{[^}]*bottom:\s*20px;[^}]*font-size:\s*14px;/s);

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

    const slide11 = findSlideByHeadingId(slides, "s11-h");
    assert.equal(slide11.includes(EM_DASH), false, "Slide 11 must contain zero em dashes");
    for (const token of [
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
      "Free for users",
      "wellbeing services counties",
      "docs/RESEARCH.md",
    ]) {
      assert.ok(stripTags(slide11).includes(token), `Slide 11 must contain adoption claim "${token}"`);
    }

    const s11Eyebrow = /<p class="eyebrow">([\s\S]*?)<\/p>/.exec(slide11);
    const s11H2 = /<h2 id="s11-h">([\s\S]*?)<\/h2>/.exec(slide11);
    assert.ok(s11Eyebrow && s11H2, "Slide 11 must have .eyebrow and #s11-h");
    assert.equal(countWrappedLines(stripTags(s11Eyebrow[1]), innerW, 10.5), 1, "Slide 11 eyebrow must be single-line");
    const s11H2Lines = countWrappedLines(stripTags(s11H2[1]), 1120, 18.7);
    assert.ok(s11H2Lines >= 1 && s11H2Lines <= 2, `Slide 11 h2 must stay <= 2 lines, got ${s11H2Lines}`);

    const s11Grid3Match = /<div class="grid3">([\s\S]*?)<\/div>\s*<div class="grid2">/.exec(slide11);
    const s11Grid2Match = /<div class="grid2">([\s\S]*?)<\/div>\s*<div class="foot">/.exec(slide11);
    assert.ok(s11Grid3Match && s11Grid2Match, "Slide 11 must have .grid3 channel row and .grid2 feasibility/model row");

    const s11ChannelCards = [...s11Grid3Match[1].matchAll(/<div class="card(?:\s+hl)?">([\s\S]*?)<\/div>/g)].map(
      (m) => m[1],
    );
    assert.equal(s11ChannelCards.length, 3, "Slide 11 .grid3 must contain 3 channel cards");
    const grid3InnerW = (innerW - 2 * 20) / 3 - cardChromeX;
    const s11ChannelHeights = s11ChannelCards.map((cardHtml, idx) => {
      const h3Match = /<h3>([\s\S]*?)<\/h3>/.exec(cardHtml);
      assert.ok(h3Match, `Slide 11 channel card ${idx + 1} must have <h3>`);
      assert.equal(countWrappedLines(stripTags(h3Match[1]), grid3InnerW, 11.4), 1);
      const pTags = [...cardHtml.matchAll(/<p(?:\s+class="([^"]*)")?>([\s\S]*?)<\/p>/g)];
      assert.ok(pTags.length >= 1 && pTags.length <= 2, `Slide 11 channel card ${idx + 1} must have 1-2 paragraphs`);
      let textH = 0;
      let totalLines = 0;
      for (const p of pTags) {
        const isSmall = (p[1] ?? "").includes("small");
        const lines = countWrappedLines(stripTags(p[2]), grid3InnerW, isSmall ? 7.6 : 8.5);
        totalLines += lines;
        textH += lines * (isSmall ? 15 * 1.4 : 17 * 1.35);
      }
      assert.ok(totalLines <= 8, `Slide 11 channel card ${idx + 1} must stay <= 8 wrapped lines, got ${totalLines}`);
      return cardChromeY + 22 * 1.2 + pTags.length * 8 + textH;
    });
    const s11Grid3H = Math.max(...s11ChannelHeights);

    const s11BottomCards = [...s11Grid2Match[1].matchAll(/<div class="card">([\s\S]*?)<\/div>/g)].map((m) => m[1]);
    assert.equal(s11BottomCards.length, 2, "Slide 11 .grid2 must contain 2 cards");
    const grid2BulletW = (innerW - 24) / 2 - cardChromeX - 22;
    const s11BottomHeights = s11BottomCards.map((cardHtml, idx) => {
      const bullets = [...cardHtml.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => stripTags(m[1]));
      assert.ok(bullets.length >= 2 && bullets.length <= 4, `Slide 11 bottom card ${idx + 1} must have 2-4 bullets`);
      const perBulletLines = bullets.map((b) => countWrappedLines(b, grid2BulletW, 8.5));
      for (const lines of perBulletLines) {
        assert.ok(lines <= 2, `Each Slide 11 bottom bullet must stay <= 2 wrapped lines, got ${lines}`);
      }
      const totalLines = perBulletLines.reduce((sum, n) => sum + n, 0);
      assert.ok(totalLines <= 6, `Slide 11 bottom card ${idx + 1} must stay <= 6 wrapped lines, got ${totalLines}`);
      return cardChromeY + 22 * 1.2 + 8 + (bullets.length - 1) * 6 + totalLines * (17 * 1.35);
    });
    const s11Grid2H = Math.max(...s11BottomHeights);

    const s11FootSrc = /<div class="foot"><span class="src">([\s\S]*?)<\/span>/.exec(slide11);
    assert.ok(s11FootSrc, "Slide 11 must include .foot .src");
    const s11FootTopY = slideH - footBottom - countWrappedLines(stripTags(s11FootSrc[1]), 1000, 7.0) * (14 * 1.3);
    const s11ContentH = 16 * 1.25 + s11H2Lines * (36 * 1.1) + s11Grid3H + s11Grid2H + 3 * slideGap;
    assert.ok(s11ContentH <= maxContentH, `Slide 11 content (${s11ContentH.toFixed(1)}px) exceeds ${maxContentH}px`);
    assert.ok(padTop + s11ContentH <= s11FootTopY, "Slide 11 content must stay above .foot");
  });

  test("every repository path referenced in docs/PILOT_PLAN.md exists on disk", () => {
    const referencedPaths = extractReferencedRepoPaths(pilotPlan);
    assert.ok(referencedPaths.length >= 18, `Expected >= 18 repo path references, got ${referencedPaths.length}`);
    for (const relPath of referencedPaths) {
      const fullPath = path.join(REPO_DIR, relPath);
      assert.equal(fs.existsSync(fullPath), true, `Referenced repo path "${relPath}" must exist on disk`);
    }
  });
});
