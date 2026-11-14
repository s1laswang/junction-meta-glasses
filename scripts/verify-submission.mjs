import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
export const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

const SLASH = String.fromCharCode(47);
const DOUBLE_SLASH = SLASH + SLASH;
const EM_DASH = String.fromCharCode(0x2014);
const HTML_COMMENT_OPEN = "<" + "!--";
const CO_AUTHORED_TOKEN = ["Co", "Authored", "By"].join("-");
const CO_AUTHORED_RE = new RegExp(CO_AUTHORED_TOKEN, "i");
const API_KEY_RE = new RegExp("AIza" + "[0-9A-Za-z_-]{20,}");
const DATA_IMAGE_B64_RE = new RegExp("^data:image" + SLASH + "[a-z0-9.+-]+;base64,", "i");
const EXTERNAL_HTTP_RE = new RegExp("https?:" + DOUBLE_SLASH, "i");
const URI_SCHEME_RE = new RegExp("^[a-zA-Z][a-zA-Z0-9+.-]*:");

export const MAX_EVAL_STRING_LENGTH = 4096;
export const MIN_DECK_SLIDES = 12;
export const MIN_FIXTURE_BYTES = 10 * 1024;
export const MAX_FIXTURE_BYTES = 200 * 1024;
export const STANDALONE_HTML_ARTIFACTS = Object.freeze([
  "deck/index.html",
  "docs/judge-handout.html",
  "docs/printable-props.html",
  "docs/architecture-poster.html",
]);
export const EXPECTED_DEMO_FIXTURES = Object.freeze([
  "amlodipine.jpg",
  "back_of_box.jpg",
  "blurry_amlodipine.jpg",
  "expired_metformin.jpg",
  "hazelnut_bar.jpg",
  "ibuprofen.jpg",
  "oat_milk.jpg",
]);

function toPosixPath(p) {
  return p.split(path.sep).join(SLASH);
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

function stripInlineCode(line) {
  return line.replace(/(`+)([^`]*?)\1/g, "code");
}

function scanInlineLinksInLine(sanitizedLine, lineNumber, out) {
  const n = sanitizedLine.length;
  let i = 0;
  while (i < n) {
    if (sanitizedLine[i] === "\\") {
      i += 2;
      continue;
    }
    const isBang = sanitizedLine[i] === "!" && sanitizedLine[i + 1] === "[";
    const openBracket = isBang ? i + 1 : sanitizedLine[i] === "[" ? i : -1;
    if (openBracket === -1) {
      i++;
      continue;
    }

    let bracketDepth = 1;
    let j = openBracket + 1;
    while (j < n && bracketDepth > 0) {
      if (sanitizedLine[j] === "\\") {
        j += 2;
        continue;
      }
      if (sanitizedLine[j] === "[") bracketDepth++;
      else if (sanitizedLine[j] === "]") bracketDepth--;
      j++;
    }

    if (bracketDepth !== 0) {
      i = openBracket + 1;
      continue;
    }

    const closeBracket = j - 1;
    if (sanitizedLine[closeBracket + 1] !== "(") {
      i = openBracket + 1;
      continue;
    }

    const openParen = closeBracket + 1;
    let k = openParen + 1;
    if (sanitizedLine[k] === "<") {
      const closeAngle = sanitizedLine.indexOf(">", k + 1);
      const closeParen = closeAngle !== -1 ? sanitizedLine.indexOf(")", closeAngle + 1) : -1;
      if (closeParen !== -1) {
        out.push({
          rawTarget: sanitizedLine.slice(openParen + 1, closeParen),
          line: lineNumber,
        });
        i = closeParen + 1;
        continue;
      }
    }

    let parenDepth = 1;
    while (k < n && parenDepth > 0) {
      if (sanitizedLine[k] === "\\") {
        k += 2;
        continue;
      }
      if (sanitizedLine[k] === "(") parenDepth++;
      else if (sanitizedLine[k] === ")") parenDepth--;
      k++;
    }

    if (parenDepth === 0) {
      const closeParen = k - 1;
      out.push({
        rawTarget: sanitizedLine.slice(openParen + 1, closeParen),
        line: lineNumber,
      });
      i = closeParen + 1;
    } else {
      i = openParen + 1;
    }
  }
}

export function extractMarkdownLinks(markdownText) {
  const lines = markdownText.split(/\r?\n/);
  const links = [];
  let activeFence = null;

  for (let idx = 0; idx < lines.length; idx++) {
    const rawLine = lines[idx];
    const fenceOpen = /^\s{0,3}(`{3,}|~{3,})/.exec(rawLine);
    if (fenceOpen) {
      const marker = fenceOpen[1];
      if (!activeFence) {
        activeFence = { char: marker[0], len: marker.length };
        continue;
      }
      if (
        marker[0] === activeFence.char &&
        marker.length >= activeFence.len &&
        /^\s{0,3}(?:`{3,}|~{3,})\s*$/.test(rawLine)
      ) {
        activeFence = null;
        continue;
      }
    }
    if (activeFence) continue;

    const sanitized = stripInlineCode(rawLine);
    const refDef = /^\s{0,3}\[([^\]]+)\]:\s*(.+)$/.exec(sanitized);
    if (refDef) {
      links.push({ rawTarget: refDef[2], line: idx + 1 });
      continue;
    }

    scanInlineLinksInLine(sanitized, idx + 1, links);
  }

  return links;
}

export function classifyMarkdownTarget(rawTarget) {
  let target = rawTarget.trim();
  if (!target) {
    return { kind: "empty", target: "" };
  }

  if (target.startsWith("<")) {
    const gt = target.indexOf(">");
    target = gt >= 0 ? target.slice(1, gt).trim() : target.slice(1).trim();
  } else {
    const ws = target.search(/\s/);
    if (ws !== -1) {
      target = target.slice(0, ws);
    }
  }

  if (!target || target.startsWith("#")) {
    return { kind: "anchor", target };
  }
  if (target.startsWith(DOUBLE_SLASH) || URI_SCHEME_RE.test(target)) {
    return { kind: "external", target };
  }

  const withoutHash = target.split("#")[0];
  const withoutQuery = withoutHash.split("?")[0];
  if (!withoutQuery) {
    return { kind: "anchor", target };
  }

  let decoded = withoutQuery;
  try {
    decoded = decodeURIComponent(withoutQuery);
  } catch {
    decoded = withoutQuery;
  }

  return { kind: "relative", target: decoded };
}

export function countDeckSlides(html) {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, "");
  const withoutScripts = withoutComments
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");

  const tagRe = /<(section|div|article)\b([^>]*)>/gi;
  let classSlideCount = 0;
  let dataSlideCount = 0;
  let sectionCount = 0;

  let match;
  while ((match = tagRe.exec(withoutScripts)) !== null) {
    const tagName = match[1].toLowerCase();
    const attrs = match[2] ?? "";

    const classMatch = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
    if (classMatch) {
      const classTokens = (classMatch[1] ?? classMatch[2] ?? "").trim().split(/\s+/);
      if (classTokens.includes("slide") || classTokens.includes("deck-slide")) {
        classSlideCount++;
      }
    }

    if (/(?:^|\s)data-slide(?:\s*=|\s|$)/i.test(attrs)) {
      dataSlideCount++;
    }

    if (tagName === "section") {
      sectionCount++;
    }
  }

  if (classSlideCount > 0) return classSlideCount;
  if (dataSlideCount > 0) return dataSlideCount;
  return sectionCount;
}

export function verifyMarkdownLinks(rootDir) {
  const errors = [];
  const notices = [];
  const mdFiles = [];

  const readmePath = path.join(rootDir, "README.md");
  if (!fs.existsSync(readmePath) || !fs.statSync(readmePath).isFile()) {
    errors.push("README.md is missing at repository root");
  } else {
    mdFiles.push(readmePath);
  }

  const docsDir = path.join(rootDir, "docs");
  if (!fs.existsSync(docsDir) || !fs.statSync(docsDir).isDirectory()) {
    errors.push("docs directory is missing");
  } else {
    const docEntries = fs
      .readdirSync(docsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort();
    if (docEntries.length === 0) {
      errors.push("docs directory contains zero .md files");
    }
    for (const name of docEntries) {
      mdFiles.push(path.join(docsDir, name));
    }
  }

  const deckDir = path.join(rootDir, "deck");
  const deckIndexPath = path.join(deckDir, "index.html");
  const deckPresent = fs.existsSync(deckDir) && fs.statSync(deckDir).isDirectory();
  let deckSlideCount = null;
  let notifiedPendingDeck = false;

  if (deckPresent) {
    if (!fs.existsSync(deckIndexPath) || !fs.statSync(deckIndexPath).isFile()) {
      errors.push("deck directory is present but deck/index.html is missing");
    } else {
      const deckHtml = fs.readFileSync(deckIndexPath, "utf8");
      deckSlideCount = countDeckSlides(deckHtml);
      if (deckSlideCount < MIN_DECK_SLIDES) {
        errors.push(`deck/index.html has ${deckSlideCount} slide(s), expected >= ${MIN_DECK_SLIDES}`);
      }
    }
  }

  let checkedLinks = 0;

  for (const mdPath of mdFiles) {
    const relMd = toPosixPath(path.relative(rootDir, mdPath));
    const content = fs.readFileSync(mdPath, "utf8");
    const extracted = extractMarkdownLinks(content);

    for (const { rawTarget, line } of extracted) {
      const classified = classifyMarkdownTarget(rawTarget);
      if (classified.kind === "empty") {
        errors.push(`${relMd}:${line} has empty Markdown link target`);
        continue;
      }
      if (classified.kind !== "relative") {
        continue;
      }

      checkedLinks++;
      const resolved = classified.target.startsWith(SLASH)
        ? path.resolve(rootDir, classified.target.slice(1))
        : path.resolve(path.dirname(mdPath), classified.target);
      const relTarget = path.relative(rootDir, resolved);

      if (!relTarget || relTarget.startsWith("..") || path.isAbsolute(relTarget)) {
        errors.push(`${relMd}:${line} relative link "${rawTarget}" escapes repository root`);
        continue;
      }

      const relTargetPosix = toPosixPath(relTarget);
      if (relTargetPosix === "deck/index.html" && !deckPresent) {
        if (!notifiedPendingDeck) {
          notices.push("deck/index.html allowed pending merge (deck directory not present yet)");
          notifiedPendingDeck = true;
        }
        continue;
      }

      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        errors.push(`${relMd}:${line} broken relative link "${rawTarget}" -> ${relTargetPosix}`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    checkedFiles: mdFiles.length,
    checkedLinks,
    deckPresent,
    deckSlideCount,
    notices,
    errors,
  };
}

function collectJsonFilesRecursive(dir, out = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "__pycache__" || entry.name.startsWith(".")) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsonFilesRecursive(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      out.push(full);
    }
  }
  return out;
}

function inspectJsonStrings(value, relFile, jsonPath, errors) {
  if (typeof value === "string") {
    if (value.length > MAX_EVAL_STRING_LENGTH) {
      errors.push(
        `${relFile} contains oversized string (${value.length} > ${MAX_EVAL_STRING_LENGTH} chars) at ${jsonPath}`,
      );
    }
    if (DATA_IMAGE_B64_RE.test(value)) {
      errors.push(`${relFile} contains embedded data:image base64 blob at ${jsonPath}`);
    }
    if (API_KEY_RE.test(value)) {
      errors.push(`${relFile} contains forbidden API key pattern at ${jsonPath}`);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      inspectJsonStrings(value[i], relFile, `${jsonPath}[${i}]`, errors);
    }
    return;
  }

  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k.length > MAX_EVAL_STRING_LENGTH) {
        errors.push(`${relFile} contains oversized key (${k.length} > ${MAX_EVAL_STRING_LENGTH} chars) at ${jsonPath}`);
      }
      if (API_KEY_RE.test(k)) {
        errors.push(`${relFile} contains forbidden API key pattern in key at ${jsonPath}`);
      }
      inspectJsonStrings(v, relFile, `${jsonPath}.${k}`, errors);
    }
  }
}

export function verifyEvalHygiene(rootDir) {
  const errors = [];
  const evalDir = path.join(rootDir, "eval");

  if (!fs.existsSync(evalDir) || !fs.statSync(evalDir).isDirectory()) {
    return {
      ok: false,
      jsonFileCount: 0,
      errors: ["eval directory is missing"],
    };
  }

  const jsonFiles = collectJsonFilesRecursive(evalDir);
  if (jsonFiles.length === 0) {
    errors.push("eval directory contains zero .json files");
  }

  const combinedPath = path.join(evalDir, "combined_summary.json");
  let sawCombinedSummary = false;

  for (const fullPath of jsonFiles) {
    const relFile = toPosixPath(path.relative(rootDir, fullPath));
    const raw = fs.readFileSync(fullPath, "utf8");

    if (API_KEY_RE.test(raw)) {
      errors.push(`${relFile} matches forbidden Google API key pattern`);
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${relFile} is not valid JSON: ${msg}`);
      continue;
    }

    inspectJsonStrings(parsed, relFile, "$", errors);

    if (path.resolve(fullPath) === path.resolve(combinedPath)) {
      sawCombinedSummary = true;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        errors.push("eval/combined_summary.json root value must be a JSON object");
      } else {
        if (parsed.total_confident_wrong_dose_count !== 0) {
          errors.push(
            `eval/combined_summary.json expected total_confident_wrong_dose_count === 0, got ${String(parsed.total_confident_wrong_dose_count)}`,
          );
        }
        if (parsed.total_false_safe_allergen_count !== 0) {
          errors.push(
            `eval/combined_summary.json expected total_false_safe_allergen_count === 0, got ${String(parsed.total_false_safe_allergen_count)}`,
          );
        }
      }
    }
  }

  if (!sawCombinedSummary) {
    errors.push("eval/combined_summary.json is missing");
  }

  return {
    ok: errors.length === 0,
    jsonFileCount: jsonFiles.length,
    errors,
  };
}

export function verifyDemoFixtures(rootDir) {
  const errors = [];
  const fixturesDir = path.join(rootDir, "web", "public", "fixtures");

  if (!fs.existsSync(fixturesDir) || !fs.statSync(fixturesDir).isDirectory()) {
    return {
      ok: false,
      fixtureCount: 0,
      errors: ["web/public/fixtures directory is missing"],
    };
  }

  const actualJpgs = fs
    .readdirSync(fixturesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".jpg"))
    .map((entry) => entry.name)
    .sort();

  for (const expectedName of EXPECTED_DEMO_FIXTURES) {
    if (!actualJpgs.includes(expectedName)) {
      errors.push(`Missing expected demo fixture JPEG: web/public/fixtures/${expectedName}`);
    }
  }

  if (actualJpgs.length !== EXPECTED_DEMO_FIXTURES.length) {
    errors.push(
      `Expected ${EXPECTED_DEMO_FIXTURES.length} demo fixture JPEGs in web/public/fixtures, found ${actualJpgs.length}`,
    );
  }

  for (const name of actualJpgs) {
    const fullPath = path.join(fixturesDir, name);
    const relFile = toPosixPath(path.relative(rootDir, fullPath));
    const buf = fs.readFileSync(fullPath);

    if (buf.length < MIN_FIXTURE_BYTES || buf.length > MAX_FIXTURE_BYTES) {
      errors.push(
        `${relFile} byte size ${buf.length} is outside [${MIN_FIXTURE_BYTES}, ${MAX_FIXTURE_BYTES}]`,
      );
    }

    const hasSoi = buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8;
    const hasEoi = buf.length >= 4 && buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9;
    if (!hasSoi) {
      errors.push(`${relFile} is missing JPEG FFD8 SOI marker`);
    }
    if (!hasEoi) {
      errors.push(`${relFile} is missing JPEG FFD9 EOI marker`);
    }
  }

  return {
    ok: errors.length === 0,
    fixtureCount: actualJpgs.length,
    errors,
  };
}

export function verifyTrackedHygiene(rootDir, options = {}) {
  const errors = [];
  let trackedList;

  if (Array.isArray(options.trackedFiles)) {
    trackedList = [...options.trackedFiles];
  } else {
    let rawList = "";
    try {
      rawList = execFileSync("git", ["ls-files", "-z"], {
        cwd: rootDir,
        encoding: "utf8",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        scannedCount: 0,
        errors: [`git ls-files failed in ${rootDir}: ${msg}`],
      };
    }
    const candidateSet = new Set(rawList.split("\0").filter(Boolean));
    for (const selfCandidate of [
      "scripts/verify-submission.mjs",
      "server/test/submission-links.test.ts",
    ]) {
      if (fs.existsSync(path.join(rootDir, selfCandidate))) {
        candidateSet.add(selfCandidate);
      }
    }
    trackedList = [...candidateSet].sort();
  }

  if (trackedList.length === 0) {
    return {
      ok: false,
      scannedCount: 0,
      errors: ["Zero tracked files found to scan"],
    };
  }

  let scannedCount = 0;

  for (const relPath of trackedList) {
    const fullPath = path.join(rootDir, relPath);
    if (!fs.existsSync(fullPath)) continue;
    const stat = fs.statSync(fullPath);
    if (!stat.isFile()) continue;

    scannedCount++;
    const buf = fs.readFileSync(fullPath);
    if (buf.includes(0)) {
      continue;
    }

    const text = buf.toString("utf8");
    if (text.includes(EM_DASH)) {
      errors.push(`${relPath} contains forbidden em-dash character`);
    }
    if (CO_AUTHORED_RE.test(text)) {
      errors.push(`${relPath} contains forbidden ${CO_AUTHORED_TOKEN} string`);
    }
  }

  return {
    ok: errors.length === 0,
    scannedCount,
    errors,
  };
}

export function verifyStandaloneHtml(rootDir) {
  const errors = [];
  const checkedFiles = [];

  for (const relPath of STANDALONE_HTML_ARTIFACTS) {
    const fullPath = path.join(rootDir, ...relPath.split(SLASH));
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      continue;
    }

    checkedFiles.push(relPath);
    const html = fs.readFileSync(fullPath, "utf8");

    const commentIdx = html.indexOf(HTML_COMMENT_OPEN);
    if (commentIdx !== -1) {
      errors.push(`${relPath}:${lineNumberAt(html, commentIdx)} contains forbidden HTML comment`);
    }

    const emDashIdx = html.indexOf(EM_DASH);
    if (emDashIdx !== -1) {
      errors.push(`${relPath}:${lineNumberAt(html, emDashIdx)} contains forbidden em-dash character`);
    }

    const maskedHtml = html
      .replace(/(<script\b(?:"[^"]*"|'[^']*'|[^>"'])*>)([\s\S]*?)(<\/script>)/gi, (_, open, body, close) => {
        return open + body.replace(/[^\n]/g, " ") + close;
      })
      .replace(/(<style\b(?:"[^"]*"|'[^']*'|[^>"'])*>)([\s\S]*?)(<\/style>)/gi, (_, open, body, close) => {
        return open + body.replace(/[^\n]/g, " ") + close;
      });

    const assetTagRe = /<(script|link|img)\b((?:"[^"]*"|'[^']*'|[^>"'])*)>/gi;
    let match;
    while ((match = assetTagRe.exec(maskedHtml)) !== null) {
      const tagName = match[1].toLowerCase();
      const attrs = match[2] ?? "";
      if (EXTERNAL_HTTP_RE.test(attrs)) {
        errors.push(
          `${relPath}:${lineNumberAt(maskedHtml, match.index)} contains forbidden external <${tagName}> URL`,
        );
      }
    }
  }

  return {
    ok: errors.length === 0,
    checkedCount: checkedFiles.length,
    checkedFiles,
    errors,
  };
}

export function verifySubmission(rootDir = DEFAULT_REPO_ROOT, options = {}) {
  const links = verifyMarkdownLinks(rootDir);
  const standaloneHtml = verifyStandaloneHtml(rootDir);
  const evalHygiene = verifyEvalHygiene(rootDir);
  const fixtures = verifyDemoFixtures(rootDir);
  const trackedHygiene = verifyTrackedHygiene(rootDir, options);

  const notices = [...links.notices];
  const errors = [
    ...links.errors,
    ...standaloneHtml.errors,
    ...evalHygiene.errors,
    ...fixtures.errors,
    ...trackedHygiene.errors,
  ];

  return {
    ok: errors.length === 0,
    notices,
    errors,
    links,
    standaloneHtml,
    evalHygiene,
    fixtures,
    trackedHygiene,
  };
}

function resolveCliRoot(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root" && argv[i + 1]) {
      return path.resolve(argv[i + 1]);
    }
  }
  return DEFAULT_REPO_ROOT;
}

function isExecutedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(SCRIPT_PATH);
  } catch {
    return path.resolve(process.argv[1]) === SCRIPT_PATH;
  }
}

if (isExecutedDirectly()) {
  const t0 = Date.now();
  const rootDir = resolveCliRoot(process.argv.slice(2));
  const report = verifySubmission(rootDir);

  for (const notice of report.notices) {
    console.log(`NOTICE ${notice}`);
  }

  if (!report.ok) {
    for (const err of report.errors) {
      console.error(`FAIL submission check: ${err}`);
    }
    process.exit(1);
  }

  const deckDetail = report.links.deckPresent
    ? `deck=${report.links.deckSlideCount} slides`
    : "deck=pending-merge";
  console.log(
    `PASS submission integrity (${Date.now() - t0} ms): ${report.links.checkedFiles} docs (${report.links.checkedLinks} relative links, ${deckDetail}), ${report.standaloneHtml.checkedCount} standalone HTML files, ${report.evalHygiene.jsonFileCount} eval JSONs, ${report.fixtures.fixtureCount} JPEG fixtures, ${report.trackedHygiene.scannedCount} tracked files clean`,
  );
}
