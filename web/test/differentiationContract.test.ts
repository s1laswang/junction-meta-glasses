import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(TEST_DIR, "..", "..");
const EM_DASH = String.fromCharCode(0x2014);

function readRepoFile(relPath: string): string {
  return fs.readFileSync(path.join(REPO_DIR, relPath), "utf8");
}

function extractMarkdownH2Section(markdown: string, headingText: string): string {
  const marker = `## ${headingText}`;
  const start = markdown.indexOf(marker);
  assert.ok(start >= 0, `Expected H2 section "${marker}"`);
  const afterHeading = start + marker.length;
  const nextH2 = markdown.indexOf("\n## ", afterHeading);
  return nextH2 >= 0 ? markdown.slice(start, nextH2) : markdown.slice(start);
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

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

describe("Differentiation contract: Seeing AI, Be My Eyes, and Hey Meta", () => {
  const readme = readRepoFile("README.md");
  const deck = readRepoFile("deck/index.html");
  const gemini = readRepoFile("GEMINI.md");
  const slides = extractSlides(deck);

  test("README.md places concise differentiation section after Junction header and names all three alternatives", () => {
    const heading = 'How HoldUp differs from Seeing AI, Be My Eyes, and "Hey Meta"';
    const junctionLine = 'Junction 2026 · Meta "AI Glasses for Everyone, Everyday" · Google DeepMind "Best Use of Gemini API".';
    const junctionIdx = readme.indexOf(junctionLine);
    const diffIdx = readme.indexOf(`## ${heading}`);
    const prereqIdx = readme.indexOf("## Prerequisites");

    assert.ok(junctionIdx >= 0, "Expected Junction 2026 header line in README.md");
    assert.ok(diffIdx > junctionIdx, "Expected differentiation section right after Junction 2026 header");
    assert.ok(prereqIdx > diffIdx, "Expected differentiation section before ## Prerequisites");

    const section = extractMarkdownH2Section(readme, heading);
    assert.ok(section.includes("Seeing AI"), "README differentiation section must name Seeing AI");
    assert.ok(section.includes("Be My Eyes"), "README differentiation section must name Be My Eyes");
    assert.ok(section.includes("Hey Meta"), "README differentiation section must name Hey Meta");
    assert.ok(section.includes("safety.ts"), "README differentiation section must reference deterministic safety.ts");
    assert.ok(section.includes("0.8"), "README differentiation section must reference 0.8 strength confidence gate");
    assert.ok(section.includes("0.95"), "README differentiation section must reference 0.95 allergen confidence gate");
    assert.ok(section.includes("DataMatrix"), "README differentiation section must reference EU FMD DataMatrix cross-check");
    assert.ok(section.includes("21 markets"), "README differentiation section must respectfully note Be My Eyes across 21 markets");
    assert.equal(section.includes(EM_DASH), false, "README differentiation section must contain zero em dashes");

    assert.ok(
      readme.includes("axe-core WCAG 2.2 A+AA: 0 violations on 6 screens"),
      "README must preserve Phone PWA a11y status note",
    );
  });

  test("deck/index.html preserves all 12 slides, updates Slide 2 within 4 crisp bullets, and preserves Slide 5 and Slide 11", () => {
    assert.equal(slides.length, 12, "Expected all 12 .slide sections in deck/index.html");
    for (let n = 1; n <= 12; n++) {
      findSlideByHeadingId(slides, `s${n}-h`);
    }

    const slide2 = findSlideByHeadingId(slides, "s2-h");
    assert.ok(slide2.includes("<h3>What exists today</h3>"), "Slide 2 must contain What exists today card");
    assert.ok(slide2.includes("Seeing AI"), "Slide 2 (#s2-h) must explicitly name Seeing AI");
    assert.ok(slide2.includes("Be My Eyes"), "Slide 2 (#s2-h) must explicitly name Be My Eyes");
    assert.ok(slide2.includes("Hey Meta"), "Slide 2 (#s2-h) must explicitly name Hey Meta");
    assert.ok(slide2.includes("Braille on the box"), "Slide 2 (#s2-h) must retain Braille on the box bullet");
    assert.equal(slide2.includes(EM_DASH), false, "Slide 2 must contain zero em dashes");

    const existsCardMatch = /<h3>What exists today<\/h3>\s*<ul class="bul">([\s\S]*?)<\/ul>/.exec(slide2);
    assert.ok(existsCardMatch, "Expected <ul class=\"bul\"> inside Slide 2 What exists today card");
    const bullets = [...existsCardMatch[1].matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => stripTags(m[1]));
    assert.equal(bullets.length, 4, "Slide 2 What exists today card must stay at 4 crisp bullets for 1280x720 fit");
    for (const bullet of bullets) {
      assert.ok(
        bullet.length <= 105,
        `Slide 2 bullet must stay concise (<= 105 chars) to prevent 1280x720 overflow, got ${bullet.length}: "${bullet}"`,
      );
    }

    const slide5 = findSlideByHeadingId(slides, "s5-h");
    assert.ok(
      slide5.includes("TODO: backup video URL"),
      "Slide 5 must preserve TODO: backup video URL placeholder",
    );

    const slide11 = findSlideByHeadingId(slides, "s11-h");
    assert.ok(
      slide11.includes("Be My Eyes") && slide11.includes("21 markets"),
      "Slide 11 must preserve respectful Be My Eyes adoption reference",
    );
    assert.ok(
      slide11.includes("meta.com/ai-glasses/accessibility"),
      "Slide 11 footer must preserve Be My Eyes source citation",
    );
  });

  test("GEMINI.md Section 1 explicitly names Seeing AI, Be My Eyes, and Hey Meta with zero em dashes", () => {
    const section1 = extractMarkdownH2Section(gemini, "1. The problem and why it matters");
    assert.ok(section1.includes("Seeing AI"), "GEMINI.md Section 1 must name Seeing AI");
    assert.ok(section1.includes("Be My Eyes"), "GEMINI.md Section 1 must name Be My Eyes");
    assert.ok(section1.includes("Hey Meta"), "GEMINI.md Section 1 must name Hey Meta");
    assert.ok(section1.includes("0.8"), "GEMINI.md Section 1 must state < 0.8 dose confidence abstention");
    assert.ok(section1.includes("0.95"), "GEMINI.md Section 1 must state < 0.95 allergen confidence abstention");
    assert.ok(section1.includes("safety.ts"), "GEMINI.md Section 1 must state deterministic safety.ts check");
    assert.ok(section1.includes("DataMatrix"), "GEMINI.md Section 1 must state EU FMD DataMatrix cross-check");
    assert.equal(section1.includes(EM_DASH), false, "GEMINI.md Section 1 must contain zero em dashes");
  });
});
