import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
const localTsx = path.join(
  REPO_ROOT,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsx.cmd" : "tsx",
);

function runCommand(label, cmd, args, extraEnv = {}, cwd = REPO_ROOT) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const ms = Date.now() - t0;
      if (code === 0) {
        console.log(`PASS ${label} (${ms} ms)`);
        resolve({ stdout, stderr, ms });
      } else {
        console.error(`FAIL ${label} (exit ${code}, ${ms} ms)`);
        if (stdout.trim()) console.error(stdout.trim());
        if (stderr.trim()) console.error(stderr.trim());
        reject(new Error(`${label} failed with exit code ${code}`));
      }
    });
  });
}

function spawnTsx(args, extraEnv = {}) {
  if (fs.existsSync(localTsx)) {
    return spawn(localTsx, args, {
      cwd: REPO_ROOT,
      env: { ...process.env, ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });
  }
  return spawn(npmCmd, ["exec", "--", "tsx", ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function verifyLiveHttpRoutes() {
  const t0 = Date.now();
  const bootCode = [
    "process.env.HOLDUP_QUIET = '1';",
    "(async () => {",
    "  const { env } = await import('./server/src/env.ts');",
    "  env.apiKey = '';",
    "  const { startServer } = await import('./server/src/index.ts');",
    "  const srv = await startServer(0);",
    "  const addr = srv.address();",
    "  const port = typeof addr === 'object' && addr ? addr.port : 0;",
    "  process.stdout.write('LISTEN:' + port + '\\n');",
    "  process.stdin.resume();",
    "  process.stdin.once('end', () => {",
    "    srv.closeAllConnections();",
    "    srv.close(() => process.exit(0));",
    "  });",
    "})().catch((err) => { console.error(err); process.exit(1); });",
  ].join("\n");

  const child = spawnTsx(["-e", bootCode], {
    GEMINI_API_KEY: "",
    HOLDUP_QUIET: "1",
  });

  let stderrBuf = "";
  child.stderr.on("data", (chunk) => {
    stderrBuf += chunk.toString();
  });

  try {
    const port = await new Promise((resolve, reject) => {
      let stdoutBuf = "";
      const timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for startServer(0) subprocess. stderr: ${stderrBuf}`));
      }, 15_000);

      child.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`startServer(0) subprocess exited early (${code}): ${stderrBuf}`));
      });
      child.stdout.on("data", (chunk) => {
        stdoutBuf += chunk.toString();
        const match = /LISTEN:(\d+)/.exec(stdoutBuf);
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      });
    });

    assert.ok(port > 0, `Expected ephemeral port > 0, got ${port}`);
    const baseUrl = `http://127.0.0.1:${port}`;

    const rootRes = await fetch(`${baseUrl}/`);
    assert.equal(rootRes.status, 200, `Expected GET / -> 200, got ${rootRes.status}`);
    assert.match(rootRes.headers.get("content-type") ?? "", /text\/html/i, "Expected GET / text/html");
    const rootHtml = await rootRes.text();
    assert.match(rootHtml, /<!doctype html>|<html/i, "Expected GET / HTML document");

    const hudRes = await fetch(`${baseUrl}/hud`);
    assert.equal(hudRes.status, 200, `Expected GET /hud -> 200, got ${hudRes.status}`);
    assert.match(hudRes.headers.get("content-type") ?? "", /text\/html/i, "Expected GET /hud text/html");
    const hudHtml = await hudRes.text();
    assert.equal(hudHtml, rootHtml, "Expected GET /hud SPA fallback to match index.html");

    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.status, 200, `Expected GET /api/health -> 200, got ${healthRes.status}`);
    assert.match(healthRes.headers.get("content-type") ?? "", /application\/json/i, "Expected GET /api/health JSON");
    const healthJson = await healthRes.json();
    assert.equal(healthJson.ok, true, "Expected GET /api/health ok: true");

    const notFoundRes = await fetch(`${baseUrl}/api/nonexistent`);
    assert.equal(notFoundRes.status, 404, `Expected GET /api/nonexistent -> 404, got ${notFoundRes.status}`);
    assert.match(notFoundRes.headers.get("content-type") ?? "", /application\/json/i, "Expected 404 JSON content-type");
    const notFoundJson = await notFoundRes.json();
    assert.equal(notFoundJson.type, "error", "Expected 404 JSON type: error");
    assert.equal(notFoundJson.code, "not_found", "Expected 404 JSON code: not_found");

    console.log(`PASS live HTTP probe (/, /hud, /api/health, /api/nonexistent) on :${port} (${Date.now() - t0} ms)`);
  } finally {
    await new Promise((resolve) => {
      if (child.exitCode !== null) {
        resolve();
        return;
      }
      const killTimer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2000);
      child.once("exit", () => {
        clearTimeout(killTimer);
        resolve();
      });
      child.stdin.end();
    });
  }
}

function runHygieneAudit() {
  const t0 = Date.now();
  const rawList = execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  const trackedFiles = rawList.split("\0").filter(Boolean);
  const candidateFiles = new Set([
    ...trackedFiles,
    "server/scripts/simulate-bridge.ts",
    "android-dat/verify-structure.mjs",
    "scripts/verify-all.mjs",
    "scripts/smoke-production.mjs",
    "scripts/verify-submission.mjs",
  ]);

  const apiKeyPattern = new RegExp("AIza" + "[0-9A-Za-z_-]{20,}");
  const emDashChar = "\u2014";
  const slash = String.fromCharCode(47);
  const star = String.fromCharCode(42);
  const blockCommentToken = slash + star;
  const lineCommentPattern = new RegExp(`(^|[^:])${slash}${slash}`);

  const strictCommentTargets = new Set([
    "server/scripts/simulate-bridge.ts",
    "android-dat/verify-structure.mjs",
    "scripts/verify-all.mjs",
    "scripts/smoke-production.mjs",
    "scripts/verify-submission.mjs",
  ]);

  const violations = [];

  for (const relPath of trackedFiles) {
    const base = path.basename(relPath);
    if (base === ".env" || (base.startsWith(".env.") && base !== ".env.example")) {
      violations.push(`Tracked .env file is forbidden: ${relPath}`);
    }
  }

  for (const relPath of candidateFiles) {
    const fullPath = path.join(REPO_ROOT, relPath);
    if (!fs.existsSync(fullPath)) continue;
    const stat = fs.statSync(fullPath);
    if (!stat.isFile()) continue;
    const buf = fs.readFileSync(fullPath);
    const text = buf.toString("utf8");

    if (apiKeyPattern.test(text)) {
      violations.push(`API key pattern matched in ${relPath}`);
    }

    const isBinary = buf.includes(0);
    if (!isBinary) {
      if (text.includes(emDashChar)) {
        violations.push(`Forbidden em-dash character in ${relPath}`);
      }
      if (strictCommentTargets.has(relPath)) {
        if (text.includes(blockCommentToken)) {
          violations.push(`Forbidden block comment token in ${relPath}`);
        }
        const lines = text.split("\n");
        for (let idx = 0; idx < lines.length; idx++) {
          if (lineCommentPattern.test(lines[idx])) {
            violations.push(`Forbidden line comment in ${relPath}:${idx + 1}`);
            break;
          }
        }
      }
    }
  }

  if (violations.length > 0) {
    for (const v of violations) {
      console.error(`FAIL hygiene: ${v}`);
    }
    throw new Error(`Hygiene audit failed with ${violations.length} violation(s)`);
  }

  console.log(`PASS hygiene audit: ${trackedFiles.length} tracked files scanned, 0 keys, 0 .env, 0 em-dashes (${Date.now() - t0} ms)`);
}

function listWorkspaceTests(workspace) {
  const testDir = path.join(REPO_ROOT, workspace, "test");
  return fs
    .readdirSync(testDir)
    .filter((name) => name.endsWith(".test.ts"))
    .sort()
    .map((name) => path.join("test", name));
}

async function main() {
  const startedAt = Date.now();
  await Promise.all([
    runCommand("typecheck", npmCmd, ["run", "typecheck"]),
    runCommand("production build", npmCmd, ["run", "build"]),
  ]);

  const tsxCmd = fs.existsSync(localTsx) ? localTsx : npmCmd;
  const tsxArgs = fs.existsSync(localTsx)
    ? ["server/scripts/simulate-bridge.ts", "--self-test"]
    : ["exec", "--", "tsx", "server/scripts/simulate-bridge.ts", "--self-test"];

  const serverTestFiles = listWorkspaceTests("server");
  const webTestFiles = listWorkspaceTests("web");
  const nodeMajor = Number(process.versions.node.split(".")[0]) || 0;
  const webRunnerFlags =
    nodeMajor >= 23
      ? ["--test-isolation=none"]
      : nodeMajor === 22
        ? ["--experimental-test-isolation=none"]
        : ["--test-concurrency=4"];

  await Promise.all([
    runCommand(
      "server tests",
      process.execPath,
      ["--import", "tsx", "--test", "--test-concurrency=4", ...serverTestFiles],
      { GEMINI_API_KEY: "", HOLDUP_QUIET: "1" },
      path.join(REPO_ROOT, "server"),
    ),
    runCommand(
      "web tests",
      process.execPath,
      ["--import", "tsx", "--test", ...webRunnerFlags, ...webTestFiles],
      {},
      path.join(REPO_ROOT, "web"),
    ),
    (async () => {
      await runCommand("simulate-bridge --self-test", tsxCmd, tsxArgs, { GEMINI_API_KEY: "", HOLDUP_QUIET: "1" });
      await runCommand("android-dat structure verifier", process.execPath, ["android-dat/verify-structure.mjs"]);
      await runCommand("smoke-production", process.execPath, ["scripts/smoke-production.mjs"], { GEMINI_API_KEY: "", HOLDUP_QUIET: "1" });
      await runCommand("submission integrity", process.execPath, ["scripts/verify-submission.mjs"]);
      await verifyLiveHttpRoutes();
    })(),
  ]);

  runHygieneAudit();

  console.log(`PASS verify-all complete (${Date.now() - startedAt} ms)`);
}

main().catch((err) => {
  console.error("FAIL verify-all:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
