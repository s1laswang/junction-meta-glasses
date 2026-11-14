import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const TEST_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(TEST_FILE), "..", "..");
const VERIFY_ALL_SCRIPT = path.join(REPO_ROOT, "scripts", "verify-all.mjs");

const SLASH = String.fromCharCode(47);
const STAR = String.fromCharCode(42);
const EM_DASH = String.fromCharCode(0x2014);
const CO_AUTHORED = ["Co", "Authored", "By"].join("-");

const REQUIRED_VERIFY_STAGES = [
  "typecheck",
  "production build",
  "server tests",
  "web tests",
  "eval python tests",
  "simulate-bridge --self-test",
  "android-dat structure verifier",
  "smoke-production",
  "submission integrity",
  "live HTTP probe",
  "hygiene audit",
] as const;

interface SubprocessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runPythonUnittestDiscovery(pyCmd: string): Promise<SubprocessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      pyCmd,
      ["-m", "unittest", "discover", "-s", "eval", "-p", "test_*.py"],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          GEMINI_API_KEY: "",
          PYTHONDONTWRITEBYTECODE: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test("scripts/verify-all.mjs references all required verification stages across server, web, eval, and runtime gates", () => {
  assert.equal(fs.existsSync(VERIFY_ALL_SCRIPT), true, "Expected scripts/verify-all.mjs to exist");
  const src = fs.readFileSync(VERIFY_ALL_SCRIPT, "utf8");

  for (const stage of REQUIRED_VERIFY_STAGES) {
    assert.equal(
      src.includes(stage),
      true,
      `Expected scripts/verify-all.mjs to reference stage "${stage}"`,
    );
  }

  assert.match(src, /listWorkspaceTests\("server"\)/);
  assert.match(src, /listWorkspaceTests\("web"\)/);
  assert.match(src, /await\s+verifyLiveHttpRoutes\(\)/);
  assert.match(src, /runHygieneAudit\(\)/);

  for (const strictTarget of [
    "server/scripts/simulate-bridge.ts",
    "android-dat/verify-structure.mjs",
    "scripts/verify-all.mjs",
    "scripts/smoke-production.mjs",
    "scripts/verify-submission.mjs",
  ]) {
    assert.equal(
      src.includes(`"${strictTarget}"`),
      true,
      `Expected strictCommentTargets to include ${strictTarget}`,
    );
  }
});

test("scripts/verify-all.mjs resolves /venv/bin/python3 with python3 fallback and runs eval unittest discovery in parallel", () => {
  const src = fs.readFileSync(VERIFY_ALL_SCRIPT, "utf8");

  assert.equal(
    src.includes('const venvPy = "/venv/bin/python3";'),
    true,
    "Expected venvPy constant pointing to /venv/bin/python3",
  );
  assert.equal(
    src.includes('const pyCmd = fs.existsSync(venvPy) ? venvPy : "python3";'),
    true,
    "Expected pyCmd fallback from venvPy to python3",
  );

  const expectedEvalCall =
    'runCommand("eval python tests", pyCmd, ["-m", "unittest", "discover", "-s", "eval", "-p", "test_*.py"])';
  assert.equal(
    src.includes(expectedEvalCall),
    true,
    "Expected runCommand invocation for eval python tests unittest discovery",
  );

  const mainIdx = src.indexOf("async function main()");
  assert.ok(mainIdx !== -1, "Expected async function main() in scripts/verify-all.mjs");
  const mainBody = src.slice(mainIdx);
  const parallelBlocks = mainBody.split("await Promise.all([");
  assert.equal(parallelBlocks.length, 3, "Expected two Promise.all blocks inside main()");

  const secondParallelBlock = parallelBlocks[2].split("runHygieneAudit()")[0] ?? "";
  assert.equal(secondParallelBlock.includes('"server tests"'), true);
  assert.equal(secondParallelBlock.includes('"web tests"'), true);
  assert.equal(secondParallelBlock.includes(expectedEvalCall), true);
  assert.equal(secondParallelBlock.includes('"simulate-bridge --self-test"'), true);

  const evalDir = path.join(REPO_ROOT, "eval");
  const evalTestFiles = fs
    .readdirSync(evalDir)
    .filter((name) => /^test_.*\.py$/.test(name))
    .sort();
  assert.ok(evalTestFiles.length >= 3, `Expected >= 3 eval/test_*.py files, got ${evalTestFiles.length}`);
  assert.equal(evalTestFiles.includes("test_eval_artifacts_integrity.py"), true);
});

test("eval/test_*.py unittest discovery executes cleanly with exit code 0 and zero model calls", async () => {
  const venvPy = "/venv/bin/python3";
  const pyCmd = fs.existsSync(venvPy) ? venvPy : "python3";

  const result = await runPythonUnittestDiscovery(pyCmd);
  assert.equal(
    result.code,
    0,
    `Expected eval unittest discovery exit code 0, got ${String(result.code)} (signal=${String(result.signal)})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.equal(result.signal, null);

  const ranMatch = /Ran\s+(\d+)\s+tests?/i.exec(result.stderr);
  assert.ok(ranMatch, `Expected unittest count summary in stderr, got:\n${result.stderr}`);
  const testCount = Number(ranMatch[1]);
  assert.ok(testCount >= 20, `Expected >= 20 discovered Python eval tests, got ${testCount}`);
  assert.match(result.stderr, /\bOK\b/);
  assert.doesNotMatch(result.stderr, /\bFAILED\b/);
});

test("scripts/verify-all.mjs and server/test/verify-all-gate.test.ts contain zero comments, em dashes, trailers, or keys", () => {
  const blockOpen = SLASH + STAR;
  const blockClose = STAR + SLASH;
  const doubleSlash = SLASH + SLASH;
  const lineCommentRe = new RegExp(`(^|[^:])${doubleSlash}`);
  const coAuthoredRe = new RegExp(CO_AUTHORED, "i");
  const apiKeyRe = new RegExp("AIza" + "[0-9A-Za-z_-]{20,}");

  for (const filePath of [VERIFY_ALL_SCRIPT, TEST_FILE]) {
    const src = fs.readFileSync(filePath, "utf8");
    const rel = path.relative(REPO_ROOT, filePath);
    assert.equal(src.includes(blockOpen), false, `${rel} must not contain block comment open token`);
    assert.equal(src.includes(blockClose), false, `${rel} must not contain block comment close token`);
    assert.equal(src.includes(EM_DASH), false, `${rel} must not contain em dash`);
    assert.equal(coAuthoredRe.test(src), false, `${rel} must not contain trailer token`);
    assert.equal(apiKeyRe.test(src), false, `${rel} must not contain API key`);

    const lines = src.split("\n");
    for (let idx = 0; idx < lines.length; idx++) {
      assert.equal(lineCommentRe.test(lines[idx]), false, `${rel}:${idx + 1} must not contain line comment`);
    }
  }

  const selfSrc = fs.readFileSync(TEST_FILE, "utf8");
  assert.equal(selfSrc.includes(doubleSlash), false, "verify-all-gate.test.ts must not contain raw double-slash");
});
