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
const LINE_COMMENT = SLASH + SLASH;
const BLOCK_COMMENT_OPEN = SLASH + ASTERISK;
const HTML_COMMENT_OPEN = "<" + "!--";
const EM_DASH = String.fromCharCode(0x2014);
const HTTPS_PREFIX = "https:" + SLASH + SLASH;

function readRepoFile(relPath: string): string {
  return fs.readFileSync(path.join(REPO_DIR, relPath), "utf8");
}

function repoPathExistsAsFile(relPath: string): boolean {
  const full = path.join(REPO_DIR, relPath);
  if (!fs.existsSync(full)) return false;
  const st = fs.statSync(full);
  return st.isFile() && st.size > 0;
}

function extractBulletsBetween(markdown: string, startMarker: string, endMarker?: string): string[] {
  const startIdx = markdown.indexOf(startMarker);
  assert.ok(startIdx >= 0, `Expected marker "${startMarker}"`);
  const bodyStart = startIdx + startMarker.length;
  const endIdx = endMarker ? markdown.indexOf(endMarker, bodyStart) : markdown.length;
  assert.ok(endIdx > bodyStart, `Expected end marker "${endMarker ?? "EOF"}" after "${startMarker}"`);
  return markdown
    .slice(bodyStart, endIdx)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim());
}

function extractSlides(deckHtml: string): Map<number, string> {
  const byNumber = new Map<number, string>();
  const sectionMatches = deckHtml.match(/<section\s+class="slide(?:\s+[^"]*)?"[\s\S]*?<\/section>/g) ?? [];
  for (const section of sectionMatches) {
    const idMatch = /\bid="s(\d+)-h"/.exec(section);
    assert.ok(idMatch, "Every .slide section in deck/index.html must include heading id=\"sN-h\"");
    const slideNum = Number(idMatch[1]);
    assert.equal(byNumber.has(slideNum), false, `Duplicate slide heading id s${slideNum}-h`);
    byNumber.set(slideNum, section);
  }
  return byNumber;
}

function parseMarkdownTableRows(section: string): string[][] {
  const lines = section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|"));
  assert.ok(lines.length >= 3, "Expected Markdown table with header, separator, and data rows");
  return lines.slice(2).map((line) =>
    line
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim()),
  );
}

function extractHttpsUrls(text: string): string[] {
  const urlRe = new RegExp(HTTPS_PREFIX + "[^\\s);>\"']+", "g");
  return [...text.matchAll(urlRe)].map((m) => m[0].replace(/[.,;]+$/, ""));
}

function extractH2SectionByPrefix(markdown: string, prefix: string): { index: number; body: string } {
  const marker = `## ${prefix}`;
  const start = markdown.indexOf(marker);
  assert.ok(start >= 0, `Expected H2 heading starting with "${marker}"`);
  const lineEnd = markdown.indexOf("\n", start);
  const bodyStart = lineEnd >= 0 ? lineEnd + 1 : markdown.length;
  const nextH2 = markdown.indexOf("\n## ", bodyStart);
  const body = (nextH2 >= 0 ? markdown.slice(bodyStart, nextH2) : markdown.slice(bodyStart)).trim();
  return { index: start, body };
}

function parseEnvListPrimary(envSource: string, fieldName: string): string[] {
  const fieldRe = new RegExp(`${fieldName}\\s*:\\s*list\\([^\\[]*\\[([^\\]]+)\\]`);
  const match = fieldRe.exec(envSource);
  assert.ok(match, `Expected ${fieldName}: list(..., [...]) in server/src/env.ts`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("Challenge Brief (BRIEF.md), Judging Rubric, Research Sources (docs/RESEARCH.md), GEMINI.md, and Judge Accept Contract", () => {
  const selfSource = fs.readFileSync(TEST_FILE, "utf8");
  const brief = readRepoFile("BRIEF.md");
  const research = readRepoFile("docs/RESEARCH.md");
  const privacy = readRepoFile("docs/PRIVACY.md");
  const gemini = readRepoFile("GEMINI.md");
  const deckHtml = readRepoFile("deck/index.html");
  const slides = extractSlides(deckHtml);
  const onboardingTsx = readRepoFile("web/src/screens/Onboarding.tsx");
  const devicePanelTsx = readRepoFile("web/src/components/DevicePanel.tsx");
  const hudTsx = readRepoFile("web/src/screens/Hud.tsx");
  const envTs = readRepoFile("server/src/env.ts");
  const ledgerTs = readRepoFile("server/src/ledger.ts");
  const makefile = readRepoFile("Makefile");
  const judgeAcceptSh = readRepoFile("scripts/judge_accept.sh");
  const envExample = readRepoFile(".env.example");
  const gitignore = readRepoFile(".gitignore");
  const rootPkg = JSON.parse(readRepoFile("package.json")) as { scripts?: Record<string, string> };
  const webPkg = JSON.parse(readRepoFile("web/package.json")) as { scripts?: Record<string, string> };
  const readme = readRepoFile("README.md");

  test("enforces strict test hygiene: zero code comments and zero em dashes", () => {
    assert.equal(selfSource.includes(EM_DASH), false, "Test file must contain zero em dashes");
    assert.equal(selfSource.includes(LINE_COMMENT), false, "Test file must contain zero line comments");
    assert.equal(selfSource.includes(BLOCK_COMMENT_OPEN), false, "Test file must contain zero block comments");
    assert.equal(selfSource.includes(HTML_COMMENT_OPEN), false, "Test file must contain zero HTML comments");
  });

  test("maps all 5 Meta challenge deliverables in BRIEF.md to concrete shipped repo artifacts", () => {
    assert.ok(brief.includes("Meta: AI Glasses for Everyone, Everyday (Junction 2026)"));
    assert.ok(brief.includes("beyond mirroring a phone"));
    assert.ok(brief.includes("inclusive for people of all abilities"));
    assert.ok(brief.includes("Display-first and audio-first"));
    assert.ok(brief.includes("Device Access Toolkit (DAT)"));

    const deliverables = extractBulletsBetween(brief, "**Deliverables.**", "**Judging (25% each).**");
    assert.equal(deliverables.length, 5, "BRIEF.md must list all 5 Meta challenge deliverables");

    const expectedDeliverables = [
      "functional prototype and a deck",
      "clear problem and audience",
      "plausible path to adoption or a pilot",
      "permissions, errors, performance trade-offs, connectivity, and device state changes",
      "consent and safe data practices",
    ];
    expectedDeliverables.forEach((phrase, idx) => {
      assert.ok(
        deliverables[idx].toLowerCase().includes(phrase.toLowerCase()),
        `Deliverable #${idx + 1} in BRIEF.md must include "${phrase}", got "${deliverables[idx]}"`,
      );
    });

    const requiredShippedArtifacts = [
      "deck/index.html",
      "docs/RESEARCH.md",
      "docs/PRIVACY.md",
      "web/src/screens/Onboarding.tsx",
      "web/src/components/DevicePanel.tsx",
      "web/src/screens/Hud.tsx",
      "android-dat/README.md",
      "android-dat/settings.gradle.kts",
      "android-dat/app/build.gradle.kts",
      "android-dat/app/src/main/AndroidManifest.xml",
      "android-dat/app/src/main/java/app/holdup/bridge/BridgeViewModel.kt",
      "android-dat/app/src/main/java/app/holdup/bridge/MainActivity.kt",
      "android-dat/app/src/main/java/app/holdup/bridge/Uploader.kt",
    ];
    for (const relPath of requiredShippedArtifacts) {
      assert.equal(repoPathExistsAsFile(relPath), true, `Shipped artifact must exist and be non-empty: ${relPath}`);
    }
    assert.equal(fs.statSync(path.join(REPO_DIR, "android-dat")).isDirectory(), true);

    assert.equal(slides.size, 13, "Deliverable 1: deck/index.html must ship 13 slides");
    assert.ok(
      hudTsx.includes("/hud-ws") &&
        hudTsx.includes("RIGHT ONE") &&
        hudTsx.includes("NOT SURE") &&
        hudTsx.includes("I took it") &&
        hudTsx.includes("Repeat") &&
        hudTsx.includes("Dismiss"),
      "Deliverable 1: web/src/screens/Hud.tsx must ship the Ray-Ban Display HUD with Neural Band actions",
    );
    const androidBridgeReadme = readRepoFile("android-dat/README.md");
    assert.ok(
      androidBridgeReadme.includes("/ingest/frame") && androidBridgeReadme.includes("/ingest/state"),
      "Deliverable 1: android-dat/ must document and implement /ingest/frame and /ingest/state DAT bridge endpoints",
    );

    const slide2 = slides.get(2)!;
    assert.ok(
      slide2.includes("Problem and audience") &&
        slide2.includes("Who it is for") &&
        slide2.includes("What exists today") &&
        research.includes("## Numbers used in the deck"),
      "Deliverable 2: Slide 2 and docs/RESEARCH.md must define a clear problem and audience with primary sources",
    );

    const slide11 = slides.get(12)!;
    const slide12 = slides.get(13)!;
    assert.ok(
      slide11.includes("Path to adoption") &&
        slide11.includes("Näkövammaisten liitto") &&
        slide11.includes("4-week home pilot with 20 members") &&
        slide11.includes("Pharmacies") &&
        slide11.includes("Home-care nurses") &&
        slide12.includes("20 faces in Finland"),
      "Deliverable 3: Slide 12 and Slide 13 must define a plausible pilot and adoption path",
    );

    assert.ok(
      onboardingTsx.includes("export function PermissionStep") &&
        onboardingTsx.includes("export function PermissionRecovery") &&
        onboardingTsx.includes("getUserMedia") &&
        onboardingTsx.includes("classifyError") &&
        onboardingTsx.includes("You can still use HoldUp"),
      "Deliverable 4: Onboarding.tsx must handle camera/mic permissions and plain-language recovery paths",
    );
    for (const label of [
      "Mode",
      "Camera source",
      "Camera",
      "Mic",
      "Audio route",
      "Network",
      "RTT",
      "Live socket",
      "Gemini Live",
      "Frames sent",
      "Glasses",
      "Display (HUD)",
      "Auto-stop",
      "Last error",
      "Drop connection",
      "Force snapshot",
      "Slow network",
      "Gemini down",
      "Simulate offline",
      "Glasses on",
      "Glasses off face",
      "Glasses disconnect",
      "Battery 12%",
    ]) {
      assert.ok(
        devicePanelTsx.includes(label),
        `Deliverable 4: DevicePanel.tsx must surface "${label}" for connectivity, trade-offs, errors, and device state changes`,
      );
    }

    assert.ok(
      onboardingTsx.includes("export function Consent") &&
        onboardingTsx.includes("What HoldUp captures") &&
        onboardingTsx.includes("Where it goes") &&
        onboardingTsx.includes("What stays on this phone") &&
        onboardingTsx.includes("45 seconds") &&
        onboardingTsx.includes("I agree") &&
        onboardingTsx.includes("Not now"),
      "Deliverable 5: Onboarding.tsx must present explicit 3-card privacy consent before camera or mic use",
    );
    for (const sectionHeading of [
      "## 1. What moves, and where it goes",
      "## 2. What the server writes to disk",
      "## 3. Consent, control and deletion",
      "## 4. Bystanders",
      "## 5. Third parties",
      "## 6. Known limitations",
    ]) {
      assert.ok(privacy.includes(sectionHeading), `Deliverable 5: docs/PRIVACY.md must include "${sectionHeading}"`);
    }
    assert.ok(
      privacy.includes("Nothing that contains content.") &&
        privacy.includes("deleteAllData") &&
        privacy.includes("capture LED"),
      "Deliverable 5: docs/PRIVACY.md must document zero content on disk, one-button deletion, and glasses capture LED",
    );
  });

  test("verifies all 4 judging criteria in BRIEF.md (25% each) are addressed across all 13 slides of deck/index.html", () => {
    const criteria = extractBulletsBetween(brief, "**Judging (25% each).**", "**Prize.**");
    assert.deepEqual(
      criteria,
      [
        "Creativity and use case",
        "Technical execution",
        "Real-world value and feasibility",
        "UX: input, accessibility and trust",
      ],
      "BRIEF.md must define the exact 4 Meta judging criteria (25% each)",
    );
    assert.equal(slides.size, 13, "deck/index.html must contain all 13 slides (#s1-h..#s13-h)");

    const coveredSlides = new Set<number>();
    const checkSlide = (slideNum: number, requiredTokens: string[], rubricName: string) => {
      const html = slides.get(slideNum);
      assert.ok(html, `Expected Slide ${slideNum} in deck/index.html for "${rubricName}"`);
      for (const token of requiredTokens) {
        assert.ok(
          html.includes(token),
          `Slide ${slideNum} must include "${token}" for rubric criterion "${rubricName}"`,
        );
      }
      coveredSlides.add(slideNum);
    };

    checkSlide(
      1,
      ["Which one is the evening pill?", "Three white boxes", "Meta AI glasses", "Gemini Live"],
      "Creativity and use case",
    );
    checkSlide(
      3,
      ["Why glasses, not a phone", "Beyond mirroring the phone", "Hands", "Aim", "Audio", "Display"],
      "Creativity and use case",
    );
    checkSlide(
      4,
      ["One loop: ask, coach, read, check, answer, log.", "Match", "Warning", "Not sure"],
      "Creativity and use case",
    );
    checkSlide(
      5,
      ["Live demo", "Watch it on the glasses.", "1 · Coach.", "2 · Match.", "3 · Catch.", "4 · Break it."],
      "Creativity and use case",
    );

    checkSlide(
      6,
      [
        "Ray-Ban Meta Gen 2",
        "Android DAT bridge",
        "Phone PWA (React)",
        "Ray-Ban Display HUD",
        "Server · Node + TS",
        "Gemini Live API",
        "Gemini Flash",
        "safety.ts",
      ],
      "Technical execution",
    );
    checkSlide(
      7,
      [
        "Live API, mid-session tools",
        "responseJsonSchema",
        "Speculative verify",
        "2.1 s p50",
        "3.4 s p95",
        "&lt; 5 ms",
        "/api/stats",
      ],
      "Technical execution",
    );
    checkSlide(
      10,
      [
        "Resilience",
        "snapshot mode",
        "session-resumption",
        "Offline mode",
        "1 → 0.5 → 0.33 fps",
        "phone camera",
      ],
      "Technical execution",
    );
    checkSlide(
      11,
      ["Evaluation", "1,740", "0<small>/754</small>", "0.06%", "ECE 0.022", "docs/EVAL.md"],
      "Technical execution",
    );

    checkSlide(
      2,
      ["97%", "24%", "2.8×", "1 in 5", "55,000", "Seeing AI", "Be My Eyes", "Hey Meta"],
      "Real-world value and feasibility",
    );
    checkSlide(
      12,
      ["Näkövammaisten liitto", "4-week home pilot with 20 members", "Pharmacies", "Home-care nurses", "21 markets", "Business model"],
      "Real-world value and feasibility",
    );
    checkSlide(
      13,
      ["Team and the ask", "Help us put HoldUp on 20 faces in Finland.", "20 testers", "Google DeepMind"],
      "Real-world value and feasibility",
    );

    checkSlide(
      8,
      [
        "Trust and safety",
        "Per-field confidence",
        "≥ 0.8",
        "Consent first",
        "45 s",
        "Profile lives on the phone",
        "No server storage",
        "capture LED",
        "One button deletes everything",
      ],
      "UX: input, accessibility and trust",
    );
    checkSlide(
      9,
      ["Decision support, not diagnosis", "never recommends or changes a dose", "≥ 0.95", "Rule 11, Class IIa", "3/4,730", "0.02–0.19%"],
      "UX: input, accessibility and trust",
    );

    assert.ok(
      slides.get(4)!.includes("Bluetooth play/pause tap") &&
        slides.get(6)!.includes("Neural Band") &&
        deckHtml.includes("Atkinson Hyperlegible Next") &&
        deckHtml.includes("prefers-contrast: more") &&
        deckHtml.includes("prefers-reduced-motion: reduce") &&
        deckHtml.includes('aria-live="polite"'),
      "UX: input, accessibility and trust must cover multimodal input, hyperlegible contrast/motion media queries, and screen-reader announcements",
    );

    assert.deepEqual(
      [...coveredSlides].sort((a, b) => a - b),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
      "All 13 slides of deck/index.html must map cleanly onto the 4 Meta judging criteria",
    );
  });

  test("parses all 8 rows of ## Numbers used in the deck in docs/RESEARCH.md and verifies claims, numbers, https URLs, and Slide 2 & Slide 12 parity", () => {
    const startIdx = research.indexOf("## Numbers used in the deck");
    const endIdx = research.indexOf("## Supporting numbers");
    assert.ok(startIdx >= 0 && endIdx > startIdx, "docs/RESEARCH.md must contain ## Numbers used in the deck before ## Supporting numbers");

    const rawRows = parseMarkdownTableRows(research.slice(startIdx, endIdx));
    assert.equal(rawRows.length, 8, "Expected exactly 8 rows in ## Numbers used in the deck");

    type ParsedResearchRow = {
      rowNum: number;
      claim: string;
      numberText: string;
      sourceText: string;
      notesText: string;
      urls: string[];
    };

    const parsedRows: ParsedResearchRow[] = [];
    let previousUrls: string[] = [];

    rawRows.forEach((cells, idx) => {
      assert.equal(cells.length, 5, `Row ${idx + 1} must have 5 table cells (# | Claim | Number | Source | Notes)`);
      const rowNum = Number(cells[0]);
      assert.equal(rowNum, idx + 1, `Expected sequential row number ${idx + 1}, got "${cells[0]}"`);

      const claim = cells[1];
      const numberText = cells[2];
      const sourceText = cells[3];
      const notesText = cells[4];

      assert.ok(claim.length >= 15, `Row ${rowNum} must have a substantive claim`);
      assert.ok(numberText.length >= 3, `Row ${rowNum} must have a non-empty number`);
      assert.ok(sourceText.length >= 5, `Row ${rowNum} must have a non-empty source`);

      const directUrls = extractHttpsUrls(sourceText);
      const urls =
        directUrls.length > 0
          ? directUrls
          : sourceText.toLowerCase() === "same paper"
            ? previousUrls
            : [];

      assert.ok(urls.length >= 1, `Row ${rowNum} must provide at least one valid https URL (directly or via "same paper")`);
      for (const u of urls) {
        const parsed = new URL(u);
        assert.equal(parsed.protocol, "https:", `Row ${rowNum} URL must use https: ${u}`);
        assert.ok(parsed.hostname.length > 0, `Row ${rowNum} URL must have a non-empty hostname: ${u}`);
      }
      if (directUrls.length > 0) {
        previousUrls = directUrls;
      }

      parsedRows.push({ rowNum, claim, numberText, sourceText, notesText, urls });
    });

    const row = (n: number): ParsedResearchRow => parsedRows[n - 1];

    assert.ok(row(1).numberText.includes("2.2 billion"));
    assert.ok(row(1).urls.some((u) => u.includes("who.int")));

    assert.ok(row(2).numberText.includes("55,000") && row(2).numberText.includes("45,000"));
    assert.ok(row(2).urls.some((u) => u.includes("hankeikkuna.fi")));
    assert.ok(row(2).urls.some((u) => u.includes("nkl.fi")));

    assert.ok(row(3).numberText.includes("97%") && row(3).numberText.includes("4%"));
    assert.ok(row(3).urls.some((u) => u.includes("pmc.ncbi.nlm.nih.gov/articles/PMC3404330")));

    assert.ok(row(4).numberText.includes("24%"));
    assert.ok(row(4).urls.some((u) => u.includes("pmc.ncbi.nlm.nih.gov/articles/PMC3404330")));

    assert.ok(row(5).numberText.includes("29% vs 13%") && row(5).numberText.includes("2.8"));
    assert.ok(row(5).urls.some((u) => u.includes("pmc.ncbi.nlm.nih.gov/articles/PMC3404330")));

    assert.ok(row(6).numberText.includes("21.6%") && row(6).notesText.includes("1 in 5"));
    assert.ok(row(6).urls.some((u) => u.includes("fimea.fi")));

    assert.ok(row(7).claim.includes("Braille") && row(7).sourceText.includes("Directive 2001/83/EC Art. 56a"));
    assert.ok(row(7).urls.some((u) => u.includes("legislation.gov.uk")));
    assert.ok(row(7).urls.some((u) => u.includes("fimea.fi")));

    assert.ok(row(8).numberText.includes("Be My Eyes") && row(8).numberText.includes("21 markets"));
    assert.ok(row(8).urls.some((u) => u.includes("meta.com/ai-glasses/accessibility")));
    assert.ok(row(8).urls.some((u) => u.includes("bemyeyes.com")));

    const slide2 = slides.get(2)!;
    for (const token of [
      "97%",
      "4%",
      "24%",
      "2.8",
      "29% vs 13%",
      "1 in 5",
      "21.6%",
      "55,000",
      "45,000",
      "2.2 billion",
      "Braille",
      "Directive 2001/83/EC Art. 56a",
      "docs/RESEARCH.md",
    ]) {
      assert.ok(slide2.includes(token), `Slide 2 in deck/index.html must maintain exact parity with RESEARCH.md token "${token}"`);
    }

    const slide11 = slides.get(12)!;
    for (const token of ["Be My Eyes", "21 markets", "meta.com/ai-glasses/accessibility", "docs/RESEARCH.md"]) {
      assert.ok(slide11.includes(token), `Slide 12 in deck/index.html must maintain exact parity with RESEARCH.md token "${token}"`);
    }
  });

  test("verifies GEMINI.md DeepMind sections, Usage ledger parity with server/src/ledger.ts, and primary model parity with server/src/env.ts", () => {
    const requiredSections = [
      "1. The problem and why it matters",
      "2. How Gemini is integrated",
      "3. What's innovative and technically impressive",
      "4. Why Gemini is essential",
      "Usage ledger (metadata only, no content)",
    ];

    let prevIndex = -1;
    for (const prefix of requiredSections) {
      const sec = extractH2SectionByPrefix(gemini, prefix);
      assert.ok(sec.index > prevIndex, `GEMINI.md section "## ${prefix}" must appear in canonical order`);
      assert.ok(sec.body.length >= 100, `GEMINI.md section "## ${prefix}" must contain substantive body text`);
      prevIndex = sec.index;
    }

    const liveChain = parseEnvListPrimary(envTs, "liveModels");
    const verifyChain = parseEnvListPrimary(envTs, "verifyModels");
    const ttsChain = parseEnvListPrimary(envTs, "ttsModels");

    assert.equal(liveChain[0], "gemini-3.8-live");
    assert.equal(verifyChain[0], "gemini-3.8-flash");
    assert.equal(ttsChain[0], "gemini-3.8-flash-tts");

    for (const primaryModel of [liveChain[0], verifyChain[0], ttsChain[0]]) {
      assert.ok(
        gemini.includes(primaryModel),
        `GEMINI.md must name primary shipped Gemini model "${primaryModel}" matching server/src/env.ts`,
      );
    }

    const ledgerSection = extractH2SectionByPrefix(gemini, "Usage ledger (metadata only, no content)").body;
    for (const field of ["ts", "feature", "model", "in", "out", "thinking", "cached", "latency_s", "ok"]) {
      assert.ok(ledgerSection.includes(field), `GEMINI.md Usage ledger must document field "${field}"`);
      assert.ok(ledgerTs.includes(field), `server/src/ledger.ts must implement LedgerLine field "${field}"`);
    }
    assert.ok(ledgerSection.includes("server/logs/ledger.jsonl") && ledgerSection.includes("GET /api/stats"));
    assert.ok(envTs.includes('"logs"') && envTs.includes('"ledger.jsonl"'));
    assert.ok(ledgerTs.includes("latency_p50_s") && ledgerTs.includes("latency_p95_s"));
  });

  test("verifies every repo file path cited in GEMINI.md exists on disk without hardcoding line numbers", () => {
    const citedFiles: Array<{ relPath: string; citationTokens: string[] }> = [
      { relPath: "server/src/live.ts", citationTokens: ["server/src/live.ts", "live.ts"] },
      { relPath: "server/src/verify.ts", citationTokens: ["server/src/verify.ts", "verify.ts"] },
      { relPath: "server/src/find.ts", citationTokens: ["server/src/find.ts", "find.ts"] },
      { relPath: "server/src/speculate.ts", citationTokens: ["server/src/speculate.ts"] },
      { relPath: "server/src/safety.ts", citationTokens: ["server/src/safety.ts", "safety.ts"] },
      { relPath: "shared/verify_prompt.md", citationTokens: ["shared/verify_prompt.md"] },
      { relPath: "shared/label_schema.json", citationTokens: ["shared/label_schema.json"] },
      { relPath: "shared/find_prompt.md", citationTokens: ["shared/find_prompt.md"] },
      { relPath: "eval/gen_images.py", citationTokens: ["eval/gen_images.py"] },
      { relPath: "docs/EVAL.md", citationTokens: ["docs/EVAL.md"] },
      { relPath: "eval/results/v1_results.json", citationTokens: ["eval/results/v1_results.json"] },
      { relPath: "docs/img/eval_model_compare.png", citationTokens: ["docs/img/eval_model_compare.png"] },
    ];

    const backtickSpans = [...gemini.matchAll(/`([^`]+)`/g)].map((m) => m[1].replace(/:\d+(?:-\d+)?$/, ""));
    for (const item of citedFiles) {
      assert.ok(
        item.citationTokens.some((tok) => backtickSpans.includes(tok)),
        `GEMINI.md must cite "${item.relPath}" (without relying on hardcoded line numbers)`,
      );
      assert.equal(
        repoPathExistsAsFile(item.relPath),
        true,
        `Repo file cited in GEMINI.md must exist on disk and be non-empty: ${item.relPath}`,
      );
    }
  });

  test("verifies Makefile accept target and executable keyless scripts/judge_accept.sh runbook with documented GEMINI_API_KEY skip", () => {
    assert.match(makefile, /^\.PHONY:.*\baccept\b/m, "Makefile must declare accept as .PHONY");
    assert.match(
      makefile,
      /^accept:\s*\r?\n\t(?:bash\s+)?scripts\/judge_accept\.sh\b/m,
      "Makefile accept: target must invoke scripts/judge_accept.sh",
    );

    const acceptPath = path.join(REPO_DIR, "scripts/judge_accept.sh");
    const acceptStat = fs.statSync(acceptPath);
    assert.ok((acceptStat.mode & 0o111) !== 0, "scripts/judge_accept.sh must have executable permission bits set");
    assert.ok(judgeAcceptSh.startsWith("#!/usr/bin/env bash"), "scripts/judge_accept.sh must begin with #!/usr/bin/env bash");
    assert.ok(judgeAcceptSh.includes("set -euo pipefail"), "scripts/judge_accept.sh must enable strict shell error handling");

    assert.ok(judgeAcceptSh.includes("npm run typecheck"), "scripts/judge_accept.sh must run keyless npm run typecheck");
    assert.equal(
      rootPkg.scripts?.typecheck,
      "npm -w server run typecheck && npm -w web run typecheck",
      "Root npm run typecheck must check both server and web workspaces",
    );
    assert.ok(judgeAcceptSh.includes("npm -w server test"), "scripts/judge_accept.sh must run keyless npm -w server test");

    const runsKeylessWebInAccept =
      judgeAcceptSh.includes("npm -w web test") ||
      (judgeAcceptSh.includes("/?mock=1") && judgeAcceptSh.includes("/hud/?mock=1"));
    assert.equal(
      runsKeylessWebInAccept,
      true,
      "scripts/judge_accept.sh must verify the keyless web path (/?mock=1 + /hud/?mock=1 or npm -w web test)",
    );
    assert.equal(
      webPkg.scripts?.test,
      `tsx --test test${SLASH}${ASTERISK}.test.ts`,
      "web/package.json must expose keyless tsx --test suite",
    );
    assert.ok(readme.includes("npm -w web test") && readme.includes("make accept"));

    assert.ok(
      judgeAcceptSh.includes('record SKIP "GEMINI_API_KEY"') &&
        judgeAcceptSh.includes('record SKIP "npm -w server run smoke"') &&
        judgeAcceptSh.includes("GEMINI_API_KEY unset") &&
        judgeAcceptSh.includes("?mock=1"),
      "scripts/judge_accept.sh must document SKIP for GEMINI_API_KEY and live smoke with ?mock=1 guidance",
    );
    assert.ok(
      judgeAcceptSh.includes("value not printed") && judgeAcceptSh.includes("RESULT: PASS"),
      "scripts/judge_accept.sh must never print secret values and must report RESULT: PASS on clean keyless runs",
    );
  });

  test("verifies .env.example documents GEMINI_API_KEY, HOLDUP_KEY, and ELEVENLABS_API_KEY with zero real secret values", () => {
    const documentedEnvVars = new Map<string, string>();
    for (const rawLine of envExample.split(/\r?\n/)) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      const activeMatch = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(trimmed);
      if (activeMatch) {
        documentedEnvVars.set(activeMatch[1], activeMatch[2].trim());
        continue;
      }
      const commentedMatch = /^#\s*([A-Z][A-Z0-9_]*)=(.*)$/.exec(trimmed);
      if (commentedMatch) {
        documentedEnvVars.set(commentedMatch[1], commentedMatch[2].trim());
      }
    }

    for (const secretVar of ["GEMINI_API_KEY", "HOLDUP_KEY", "ELEVENLABS_API_KEY"]) {
      assert.equal(documentedEnvVars.has(secretVar), true, `.env.example must document ${secretVar}`);
      assert.equal(
        documentedEnvVars.get(secretVar),
        "",
        `.env.example must leave secret variable ${secretVar} empty, got "${documentedEnvVars.get(secretVar)}"`,
      );
    }

    for (const [varName, val] of documentedEnvVars.entries()) {
      if (/(?:KEY|TOKEN|SECRET|PASSWORD)/.test(varName)) {
        assert.equal(val, "", `.env.example credential variable ${varName} must have an empty value`);
      }
    }

    const realSecretPatterns = [
      /AIza[0-9A-Za-z_-]{20,}/,
      /sk_[0-9A-Za-z]{20,}/,
      /sk-[0-9A-Za-z]{20,}/,
      /ghp_[0-9A-Za-z]{20,}/,
      /ya29\.[0-9A-Za-z_-]+/,
    ];
    for (const secretRe of realSecretPatterns) {
      assert.doesNotMatch(envExample, secretRe, `.env.example must contain zero real secret tokens (${String(secretRe)})`);
    }

    assert.equal(documentedEnvVars.get("LIVE_MODEL"), "gemini-3.8-live");
    assert.equal(documentedEnvVars.get("VERIFY_MODEL"), "gemini-3.8-flash");
    assert.equal(documentedEnvVars.get("PORT"), "8787");
    assert.ok(
      gitignore.includes("\n.env\n") || gitignore.startsWith(".env\n"),
      ".gitignore must ignore .env so local keys are never committed",
    );
    assert.ok(gitignore.includes("!.env.example"), ".gitignore must keep .env.example tracked");
  });
});
