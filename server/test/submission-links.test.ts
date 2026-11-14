import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import assert from "node:assert/strict";

interface ExtractedLink {
  rawTarget: string;
  line: number;
}

interface ClassifiedTarget {
  kind: "empty" | "anchor" | "external" | "relative";
  target: string;
}

interface MarkdownLinksResult {
  ok: boolean;
  checkedFiles: number;
  checkedLinks: number;
  deckPresent: boolean;
  deckSlideCount: number | null;
  notices: string[];
  errors: string[];
}

interface EvalHygieneResult {
  ok: boolean;
  jsonFileCount: number;
  errors: string[];
}

interface DemoFixturesResult {
  ok: boolean;
  fixtureCount: number;
  errors: string[];
}

interface TrackedHygieneResult {
  ok: boolean;
  scannedCount: number;
  errors: string[];
}

interface SubmissionReport {
  ok: boolean;
  notices: string[];
  errors: string[];
  links: MarkdownLinksResult;
  evalHygiene: EvalHygieneResult;
  fixtures: DemoFixturesResult;
  trackedHygiene: TrackedHygieneResult;
}

interface TrackedHygieneOptions {
  trackedFiles?: string[];
}

interface SubmissionVerifierModule {
  DEFAULT_REPO_ROOT: string;
  MAX_EVAL_STRING_LENGTH: number;
  MIN_DECK_SLIDES: number;
  MIN_FIXTURE_BYTES: number;
  MAX_FIXTURE_BYTES: number;
  EXPECTED_DEMO_FIXTURES: readonly string[];
  extractMarkdownLinks(markdownText: string): ExtractedLink[];
  classifyMarkdownTarget(rawTarget: string): ClassifiedTarget;
  countDeckSlides(html: string): number;
  verifyMarkdownLinks(rootDir: string): MarkdownLinksResult;
  verifyEvalHygiene(rootDir: string): EvalHygieneResult;
  verifyDemoFixtures(rootDir: string): DemoFixturesResult;
  verifyTrackedHygiene(rootDir: string, options?: TrackedHygieneOptions): TrackedHygieneResult;
  verifySubmission(rootDir?: string, options?: TrackedHygieneOptions): SubmissionReport;
}

const TEST_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(TEST_FILE), "..", "..");
const VERIFIER_SCRIPT = path.join(REPO_ROOT, "scripts", "verify-submission.mjs");

const verifier = (await import(pathToFileURL(VERIFIER_SCRIPT).href)) as SubmissionVerifierModule;

const SLASH = String.fromCharCode(47);
const STAR = String.fromCharCode(42);
const EM_DASH = String.fromCharCode(0x2014);
const CO_AUTHORED = ["Co", "Authored", "By"].join("-");
const FAKE_API_KEY = ["AIza", "SyFakeSubmissionTestKey123456789"].join("");

const tempDirs: string[] = [];

function createTempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "holdup-sub-verify-"));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeSyntheticJpeg(byteLength: number): Buffer {
  const buf = Buffer.alloc(byteLength, 0x42);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  buf[2] = 0xff;
  buf[3] = 0xe0;
  buf[4] = 0x00;
  buf[5] = 0x10;
  buf[byteLength - 2] = 0xff;
  buf[byteLength - 1] = 0xd9;
  return buf;
}

function writeAllValidFixtures(rootDir: string, byteLength = 24 * 1024): void {
  const fixturesDir = path.join(rootDir, "web", "public", "fixtures");
  fs.mkdirSync(fixturesDir, { recursive: true });
  const payload = makeSyntheticJpeg(byteLength);
  for (const name of verifier.EXPECTED_DEMO_FIXTURES) {
    fs.writeFileSync(path.join(fixturesDir, name), payload);
  }
}

function makeDeckHtml(slideCount: number, mode: "class" | "data" | "section" = "class"): string {
  const chunks: string[] = ["<!DOCTYPE html><html><head><style>.slide { color: #fff; }</style></head><body>"];
  for (let i = 1; i <= slideCount; i++) {
    if (mode === "class") {
      chunks.push(
        `<section class="slide"><h2 class="slide-title">Slide ${i}</h2><div class="slide-footer">${i}</div></section>`,
      );
    } else if (mode === "data") {
      chunks.push(`<div data-slide="${i}"><h2>Slide ${i}</h2></div>`);
    } else {
      chunks.push(`<section><h2>Slide ${i}</h2></section>`);
    }
  }
  chunks.push("<script>const template = '<section class=\"slide\">ignored</section>';</script></body></html>");
  return chunks.join("\n");
}

test("repository submission integrity passes across docs, eval JSONs, 7 demo JPEGs, and tracked files", () => {
  const report = verifier.verifySubmission(REPO_ROOT);
  assert.equal(report.ok, true, `Unexpected submission errors: ${report.errors.join("; ")}`);
  assert.deepEqual(report.errors, []);

  assert.ok(report.links.checkedFiles >= 12);
  assert.ok(report.links.checkedLinks >= 14);
  if (!report.links.deckPresent) {
    assert.ok(
      report.notices.some((n) => n.includes("deck/index.html")),
      "Expected pending-merge notice for deck/index.html when deck directory is absent",
    );
  } else {
    assert.ok((report.links.deckSlideCount ?? 0) >= verifier.MIN_DECK_SLIDES);
    assert.equal(report.notices.length, 0);
  }

  assert.equal(report.evalHygiene.ok, true);
  assert.ok(report.evalHygiene.jsonFileCount >= 10);

  assert.equal(report.fixtures.ok, true);
  assert.equal(report.fixtures.fixtureCount, 7);

  assert.equal(report.trackedHygiene.ok, true);
  assert.ok(report.trackedHygiene.scannedCount >= 150);
});

test("Markdown link extractor ignores fenced and inline code while resolving relative links and deck slide rules", () => {
  const extHttps = ["https:", "", "wearables.developer.meta.com", "docs"].join(SLASH);
  const md = [
    "# Sample Doc",
    "Inline code `[fake](ignored.md)` and real [`deck/index.html`](deck/index.html).",
    "Nested bracket [[inner](docs/PLAN.md#overview)] and external [Meta](" + extHttps + ").",
    "```markdown",
    "[fenced-fake](does-not-exist.md)",
    "```",
    "~~~text",
    "[tilde-fake](also-missing.md)",
    "~~~",
    "[ref-plan]: docs/PRIVACY.md",
  ].join("\n");

  const extracted = verifier.extractMarkdownLinks(md);
  assert.deepEqual(
    extracted.map((item) => item.rawTarget),
    ["deck/index.html", "docs/PLAN.md#overview", extHttps, "docs/PRIVACY.md"],
  );

  assert.equal(verifier.classifyMarkdownTarget("#heading").kind, "anchor");
  assert.equal(verifier.classifyMarkdownTarget(extHttps).kind, "external");
  assert.deepEqual(verifier.classifyMarkdownTarget("docs/PLAN.md#sec-2"), {
    kind: "relative",
    target: "docs/PLAN.md",
  });

  const root = createTempRoot();
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "README.md"),
    "See [`deck/index.html`](deck/index.html) and [Plan](docs/PLAN.md).\n",
  );
  fs.writeFileSync(
    path.join(root, "docs", "PLAN.md"),
    "Companion [Privacy](PRIVACY.md) and [Props](printable-props.html).\n",
  );
  fs.writeFileSync(path.join(root, "docs", "PRIVACY.md"), "Clean privacy doc.\n");
  fs.writeFileSync(path.join(root, "docs", "printable-props.html"), "<!doctype html><title>Props</title>");

  const pendingDeckRes = verifier.verifyMarkdownLinks(root);
  assert.equal(pendingDeckRes.ok, true);
  assert.equal(pendingDeckRes.deckPresent, false);
  assert.equal(pendingDeckRes.notices.length, 1);
  assert.match(pendingDeckRes.notices[0], /deck\/index\.html/);

  fs.mkdirSync(path.join(root, "deck"), { recursive: true });
  const missingIndexRes = verifier.verifyMarkdownLinks(root);
  assert.equal(missingIndexRes.ok, false);
  assert.ok(missingIndexRes.errors.some((e) => e.includes("deck/index.html")));

  fs.writeFileSync(path.join(root, "deck", "index.html"), makeDeckHtml(11, "class"));
  const tooFewSlidesRes = verifier.verifyMarkdownLinks(root);
  assert.equal(tooFewSlidesRes.ok, false);
  assert.equal(tooFewSlidesRes.deckSlideCount, 11);
  assert.ok(tooFewSlidesRes.errors.some((e) => e.includes("11 slide(s)")));

  fs.writeFileSync(path.join(root, "deck", "index.html"), makeDeckHtml(12, "class"));
  const validDeckRes = verifier.verifyMarkdownLinks(root);
  assert.equal(validDeckRes.ok, true);
  assert.equal(validDeckRes.deckPresent, true);
  assert.equal(validDeckRes.deckSlideCount, 12);
  assert.equal(validDeckRes.notices.length, 0);

  assert.equal(verifier.countDeckSlides(makeDeckHtml(14, "data")), 14);
  assert.equal(verifier.countDeckSlides(makeDeckHtml(13, "section")), 13);
  assert.equal(
    verifier.countDeckSlides("<!-- <section class=\"slide\"></section> --><section class=\"slide\">1</section>"),
    1,
  );

  fs.writeFileSync(
    path.join(root, "docs", "PRIVACY.md"),
    "Broken [missing](MISSING.md) and traversal [escape](../../outside.md).\n",
  );
  const brokenRes = verifier.verifyMarkdownLinks(root);
  assert.equal(brokenRes.ok, false);
  assert.equal(brokenRes.errors.length, 2);
});

test("eval JSON hygiene rejects invalid JSON, API keys, > 4096 char blobs, and non-zero safety counts", () => {
  const root = createTempRoot();
  const evalDir = path.join(root, "eval");
  fs.mkdirSync(evalDir, { recursive: true });

  fs.writeFileSync(
    path.join(evalDir, "combined_summary.json"),
    JSON.stringify({
      total_confident_wrong_dose_count: 0,
      total_false_safe_allergen_count: 0,
      note: "x".repeat(verifier.MAX_EVAL_STRING_LENGTH),
    }),
  );

  const cleanRes = verifier.verifyEvalHygiene(root);
  assert.equal(cleanRes.ok, true);
  assert.equal(cleanRes.jsonFileCount, 1);

  fs.writeFileSync(path.join(evalDir, "syntax_err.json"), "{ invalid json ");
  const badJsonRes = verifier.verifyEvalHygiene(root);
  assert.equal(badJsonRes.ok, false);
  assert.ok(badJsonRes.errors.some((e) => e.includes("syntax_err.json")));
  fs.unlinkSync(path.join(evalDir, "syntax_err.json"));

  fs.writeFileSync(
    path.join(evalDir, "leaked_key.json"),
    JSON.stringify({ debug: `token=${FAKE_API_KEY}` }),
  );
  const keyRes = verifier.verifyEvalHygiene(root);
  assert.equal(keyRes.ok, false);
  assert.ok(keyRes.errors.some((e) => e.includes("leaked_key.json") && e.includes("API key")));
  fs.unlinkSync(path.join(evalDir, "leaked_key.json"));

  const dataUri = ["data:image", "jpeg;base64,QUJDRA=="].join(SLASH);
  fs.writeFileSync(
    path.join(evalDir, "blob.json"),
    JSON.stringify({
      oversized: "A".repeat(verifier.MAX_EVAL_STRING_LENGTH + 1),
      inlineThumb: dataUri,
    }),
  );
  const blobRes = verifier.verifyEvalHygiene(root);
  assert.equal(blobRes.ok, false);
  assert.ok(blobRes.errors.some((e) => e.includes("oversized string")));
  assert.ok(blobRes.errors.some((e) => e.includes("data:image")));
  fs.unlinkSync(path.join(evalDir, "blob.json"));

  fs.writeFileSync(
    path.join(evalDir, "combined_summary.json"),
    JSON.stringify({
      total_confident_wrong_dose_count: 1,
      total_false_safe_allergen_count: 2,
    }),
  );
  const unsafeRes = verifier.verifyEvalHygiene(root);
  assert.equal(unsafeRes.ok, false);
  assert.ok(unsafeRes.errors.some((e) => e.includes("total_confident_wrong_dose_count")));
  assert.ok(unsafeRes.errors.some((e) => e.includes("total_false_safe_allergen_count")));
});

test("demo fixture JPEG check enforces all 7 filenames, FFD8 SOI, FFD9 EOI, and 10 KB..200 KB bounds", () => {
  const root = createTempRoot();
  writeAllValidFixtures(root, 32 * 1024);

  const okRes = verifier.verifyDemoFixtures(root);
  assert.equal(okRes.ok, true);
  assert.equal(okRes.fixtureCount, 7);

  const fixturesDir = path.join(root, "web", "public", "fixtures");
  const amlPath = path.join(fixturesDir, "amlodipine.jpg");
  const ibuPath = path.join(fixturesDir, "ibuprofen.jpg");

  fs.writeFileSync(amlPath, makeSyntheticJpeg(verifier.MIN_FIXTURE_BYTES - 1));
  fs.writeFileSync(ibuPath, makeSyntheticJpeg(verifier.MAX_FIXTURE_BYTES + 1));
  const sizeRes = verifier.verifyDemoFixtures(root);
  assert.equal(sizeRes.ok, false);
  assert.equal(sizeRes.errors.length, 2);

  const badMarkers = makeSyntheticJpeg(20 * 1024);
  badMarkers[0] = 0x89;
  badMarkers[1] = 0x50;
  badMarkers[badMarkers.length - 1] = 0x00;
  fs.writeFileSync(amlPath, badMarkers);
  fs.writeFileSync(ibuPath, makeSyntheticJpeg(20 * 1024));
  const markerRes = verifier.verifyDemoFixtures(root);
  assert.equal(markerRes.ok, false);
  assert.ok(markerRes.errors.some((e) => e.includes("FFD8")));
  assert.ok(markerRes.errors.some((e) => e.includes("FFD9")));

  fs.unlinkSync(amlPath);
  const missingRes = verifier.verifyDemoFixtures(root);
  assert.equal(missingRes.ok, false);
  assert.ok(missingRes.errors.some((e) => e.includes("amlodipine.jpg")));
});

test("tracked hygiene catches em dashes and co-author trailers while ignoring binary files, and CLI exits accurately", () => {
  const root = createTempRoot();
  fs.writeFileSync(path.join(root, "clean.md"), "Plain ASCII punctuation - no forbidden tokens.\n");
  const binaryBuf = Buffer.from([0xff, 0xd8, 0x00, 0x10, 0xe2, 0x80, 0x94, 0xff, 0xd9]);
  fs.writeFileSync(path.join(root, "image.bin"), binaryBuf);

  const cleanHygiene = verifier.verifyTrackedHygiene(root, {
    trackedFiles: ["clean.md", "image.bin"],
  });
  assert.equal(cleanHygiene.ok, true);
  assert.equal(cleanHygiene.scannedCount, 2);

  fs.writeFileSync(path.join(root, "emdash.md"), `Bad punctuation ${EM_DASH} in prose.\n`);
  fs.writeFileSync(path.join(root, "trailer.txt"), `${CO_AUTHORED}: Bot <bot@example.com>\n`);

  const dirtyHygiene = verifier.verifyTrackedHygiene(root, {
    trackedFiles: ["clean.md", "image.bin", "emdash.md", "trailer.txt"],
  });
  assert.equal(dirtyHygiene.ok, false);
  assert.ok(dirtyHygiene.errors.some((e) => e.includes("emdash.md")));
  assert.ok(dirtyHygiene.errors.some((e) => e.includes("trailer.txt")));

  const cliOut = execFileSync(process.execPath, [VERIFIER_SCRIPT], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.match(cliOut, /PASS submission integrity/);

  assert.throws(
    () => {
      execFileSync(process.execPath, [VERIFIER_SCRIPT, "--root", root], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        stdio: "pipe",
      });
    },
    (err: unknown) => {
      const e = err as { status?: number; stderr?: string };
      return e.status === 1 && typeof e.stderr === "string" && e.stderr.includes("FAIL submission check");
    },
  );
});

test("verify-submission.mjs and submission-links.test.ts contain zero comments, em dashes, trailers, or keys", () => {
  const lineComment = SLASH + SLASH;
  const blockComment = SLASH + STAR;
  const apiKeyRe = new RegExp("AIza" + "[0-9A-Za-z_-]{20,}");
  const coAuthoredRe = new RegExp(CO_AUTHORED, "i");

  for (const filePath of [VERIFIER_SCRIPT, TEST_FILE]) {
    const src = fs.readFileSync(filePath, "utf8");
    const label = path.relative(REPO_ROOT, filePath);
    assert.equal(src.includes(lineComment), false, `${label} must not contain line comment token`);
    assert.equal(src.includes(blockComment), false, `${label} must not contain block comment token`);
    assert.equal(src.includes(EM_DASH), false, `${label} must not contain em dash`);
    assert.equal(coAuthoredRe.test(src), false, `${label} must not contain trailer token`);
    assert.equal(apiKeyRe.test(src), false, `${label} must not contain API key`);
  }
});
