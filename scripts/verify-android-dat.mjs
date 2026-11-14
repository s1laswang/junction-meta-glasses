import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
export const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

const SLASH = String.fromCharCode(47);
const STAR = String.fromCharCode(42);
const LINE_COMMENT = SLASH + SLASH;
const BLOCK_COMMENT_OPEN = SLASH + STAR;
const BLOCK_COMMENT_CLOSE = STAR + SLASH;
const XML_COMMENT_OPEN = "<" + "!--";
const XML_COMMENT_CLOSE = "--" + ">";
const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);
const API_KEY_RE = new RegExp("AIza" + "[0-9A-Za-z_-]{20,}");
const GHP_TOKEN_RE = new RegExp("gh" + "p_[0-9A-Za-z]{20,}");

export const MIN_MAIN_KT_FILES = 7;
export const MIN_TEST_KT_FILES = 5;
export const MIN_LOCALIZED_STRING_KEYS = 19;

function collectFiles(dir, predicate, out = []) {
  if (!fs.existsSync(dir)) {
    return out;
  }
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (
      entry.name === ".gradle" ||
      entry.name === "build" ||
      entry.name === ".idea" ||
      entry.name === "node_modules"
    ) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, predicate, out);
    } else if (entry.isFile() && predicate(entry.name, full)) {
      out.push(full);
    }
  }
  return out;
}

export function extractAndroidStringMap(xmlSource) {
  const map = new Map();
  const itemRe = /<string\s+name="([A-Za-z_][A-Za-z0-9_]*)"[^>]*>([\s\S]*?)<\/string>/g;
  let match;
  while ((match = itemRe.exec(xmlSource)) !== null) {
    map.set(match[1], match[2].trim());
  }
  return map;
}

export function extractPlaceholders(value) {
  const matches = value.match(/%\d+\$[sd]/g) ?? [];
  return [...matches].sort();
}

export function auditAndroidDatBridge(repoRoot = DEFAULT_REPO_ROOT) {
  const androidDir = path.join(repoRoot, "android-dat");
  const errors = [];

  if (!fs.existsSync(androidDir) || !fs.statSync(androidDir).isDirectory()) {
    return {
      ok: false,
      mainKtCount: 0,
      testKtCount: 0,
      stringKeyCount: 0,
      errors: ["android-dat directory is missing"]
    };
  }

  const verifyStructurePath = path.join(androidDir, "verify-structure.mjs");
  if (!fs.existsSync(verifyStructurePath)) {
    errors.push("android-dat/verify-structure.mjs is missing");
  } else {
    try {
      execFileSync(process.execPath, [verifyStructurePath, "--root", androidDir], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      errors.push(`verify-structure.mjs failed: ${detail}`);
    }
  }

  const mainJavaDir = path.join(
    androidDir,
    "app",
    "src",
    "main",
    "java",
    "app",
    "holdup",
    "bridge"
  );
  const testJavaDir = path.join(
    androidDir,
    "app",
    "src",
    "test",
    "java",
    "app",
    "holdup",
    "bridge"
  );

  const mainKtFiles = collectFiles(mainJavaDir, (name) => name.endsWith(".kt"));
  const testKtFiles = collectFiles(testJavaDir, (name) => name.endsWith("Test.kt"));

  if (mainKtFiles.length < MIN_MAIN_KT_FILES) {
    errors.push(
      `Expected >= ${MIN_MAIN_KT_FILES} main Kotlin files, found ${mainKtFiles.length}`
    );
  }
  if (testKtFiles.length < MIN_TEST_KT_FILES) {
    errors.push(
      `Expected >= ${MIN_TEST_KT_FILES} JUnit4 Test.kt suites, found ${testKtFiles.length}`
    );
  }

  for (const ktPath of [...mainKtFiles, ...testKtFiles]) {
    const rel = path.relative(repoRoot, ktPath);
    const src = fs.readFileSync(ktPath, "utf8");
    if (src.includes(EM_DASH) || src.includes(EN_DASH)) {
      errors.push(`${rel}: contains forbidden em or en dash`);
    }
    if (API_KEY_RE.test(src) || GHP_TOKEN_RE.test(src)) {
      errors.push(`${rel}: contains forbidden credential token`);
    }
  }

  for (const testPath of testKtFiles) {
    const rel = path.relative(repoRoot, testPath);
    const src = fs.readFileSync(testPath, "utf8");
    if (!/@Test\b/.test(src)) {
      errors.push(`${rel}: missing @Test annotation`);
    }
  }

  const resDir = path.join(androidDir, "app", "src", "main", "res");
  const enStringsPath = path.join(resDir, "values", "strings.xml");
  const fiStringsPath = path.join(resDir, "values-fi", "strings.xml");
  const svStringsPath = path.join(resDir, "values-sv", "strings.xml");

  let stringKeyCount = 0;
  if (
    !fs.existsSync(enStringsPath) ||
    !fs.existsSync(fiStringsPath) ||
    !fs.existsSync(svStringsPath)
  ) {
    errors.push("Missing localized strings.xml across values, values-fi, or values-sv");
  } else {
    const enXml = fs.readFileSync(enStringsPath, "utf8");
    const fiXml = fs.readFileSync(fiStringsPath, "utf8");
    const svXml = fs.readFileSync(svStringsPath, "utf8");

    for (const [label, xml] of [
      ["values/strings.xml", enXml],
      ["values-fi/strings.xml", fiXml],
      ["values-sv/strings.xml", svXml]
    ]) {
      if (xml.includes(XML_COMMENT_OPEN) || xml.includes(XML_COMMENT_CLOSE)) {
        errors.push(`${label}: contains forbidden XML comment`);
      }
      if (xml.includes(EM_DASH) || xml.includes(EN_DASH)) {
        errors.push(`${label}: contains forbidden em or en dash`);
      }
    }

    const enMap = extractAndroidStringMap(enXml);
    const fiMap = extractAndroidStringMap(fiXml);
    const svMap = extractAndroidStringMap(svXml);
    stringKeyCount = enMap.size;

    if (enMap.size < MIN_LOCALIZED_STRING_KEYS) {
      errors.push(
        `Expected >= ${MIN_LOCALIZED_STRING_KEYS} TalkBack/UI string keys, found ${enMap.size}`
      );
    }

    for (const [key, enVal] of enMap.entries()) {
      if (!enVal) {
        errors.push(`values/strings.xml key '${key}' is empty`);
      }
      const fiVal = fiMap.get(key);
      const svVal = svMap.get(key);
      if (!fiVal) {
        errors.push(`values-fi/strings.xml missing or empty key '${key}'`);
      }
      if (!svVal) {
        errors.push(`values-sv/strings.xml missing or empty key '${key}'`);
      }
      const expectedSlots = extractPlaceholders(enVal);
      if (fiVal && extractPlaceholders(fiVal).join(",") !== expectedSlots.join(",")) {
        errors.push(`values-fi/strings.xml placeholder mismatch for '${key}'`);
      }
      if (svVal && extractPlaceholders(svVal).join(",") !== expectedSlots.join(",")) {
        errors.push(`values-sv/strings.xml placeholder mismatch for '${key}'`);
      }
    }
  }

  const selfSrc = fs.readFileSync(SCRIPT_PATH, "utf8");
  if (
    selfSrc.includes(LINE_COMMENT) ||
    selfSrc.includes(BLOCK_COMMENT_OPEN) ||
    selfSrc.includes(BLOCK_COMMENT_CLOSE) ||
    selfSrc.includes(EM_DASH) ||
    selfSrc.includes(EN_DASH)
  ) {
    errors.push("scripts/verify-android-dat.mjs failed self-hygiene check");
  }

  return {
    ok: errors.length === 0,
    mainKtCount: mainKtFiles.length,
    testKtCount: testKtFiles.length,
    stringKeyCount,
    errors
  };
}

function resolveCliRoot(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--root" && argv[i + 1]) {
      return path.resolve(argv[i + 1]);
    }
  }
  return DEFAULT_REPO_ROOT;
}

function isExecutedDirectly() {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(SCRIPT_PATH);
  } catch {
    return path.resolve(process.argv[1]) === SCRIPT_PATH;
  }
}

if (isExecutedDirectly()) {
  const startedAt = Date.now();
  const rootDir = resolveCliRoot(process.argv.slice(2));
  const report = auditAndroidDatBridge(rootDir);
  if (!report.ok) {
    for (const err of report.errors) {
      console.error(`FAIL verify-android-dat: ${err}`);
    }
    process.exit(1);
  }
  console.log(
    `PASS verify-android-dat: ${report.mainKtCount} main Kotlin files, ${report.testKtCount} JUnit4 suites, ${report.stringKeyCount} EN/FI/SV TalkBack strings (${Date.now() - startedAt} ms)`
  );
}
