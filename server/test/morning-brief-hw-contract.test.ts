import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO_ROOT } from "../src/env.ts";

const BRIEF_PATH = path.join(REPO_ROOT, "docs", "MORNING_BRIEF.md");
const HW_SESSION_PATH = path.join(REPO_ROOT, "scripts", "hw-session.sh");
const SCORE_REAL_PATH = path.join(REPO_ROOT, "eval", "score_real.sh");
const RUN_EVAL_PATH = path.join(REPO_ROOT, "eval", "run_eval.py");
const LABELS_CSV_PATH = path.join(REPO_ROOT, "eval", "real", "labels.csv");
const HW_LOG_PATH = path.join(REPO_ROOT, "docs", "HARDWARE_LOG.md");
const USER_FEEDBACK_PATH = path.join(REPO_ROOT, "docs", "USER_FEEDBACK.md");
const USER_TEST_KIT_PATH = path.join(REPO_ROOT, "docs", "USER_TEST_KIT.md");
const HW_PROBE_PATH = path.join(REPO_ROOT, "server", "scripts", "hw-probe.ts");
const JUDGE_ACCEPT_PATH = path.join(REPO_ROOT, "scripts", "judge_accept.sh");
const SELF_TEST_PATH = path.join(REPO_ROOT, "server", "test", "morning-brief-hw-contract.test.ts");

const WATCHED_FILES = [
  BRIEF_PATH,
  HW_SESSION_PATH,
  SCORE_REAL_PATH,
  LABELS_CSV_PATH,
  HW_LOG_PATH,
  USER_FEEDBACK_PATH,
];

const initialSnapshots = new Map<string, Buffer>(
  WATCHED_FILES.map((filePath) => [filePath, fs.readFileSync(filePath)]),
);

const baseTmpDir = fs.existsSync("/tmp/opencode") ? "/tmp/opencode" : os.tmpdir();
const tmpRoot = fs.mkdtempSync(path.join(baseTmpDir, "morning-brief-contract-"));

function runExec(
  cmd: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        cwd: options.cwd ?? REPO_ROOT,
        env: options.env ?? process.env,
        timeout: 15_000,
        encoding: "utf8",
      },
      (err, stdout, stderr) => {
        const rawCode = (err as NodeJS.ErrnoException | null)?.code;
        const code = typeof rawCode === "number" ? rawCode : err ? 1 : 0;
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });
}

function countTsComments(source: string): number {
  const slash = "/";
  const star = "*";
  let count = 0;
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = i + 1 < source.length ? source[i + 1] : "";
    if (ch === slash && next === slash) {
      count += 1;
      i += 2;
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === slash && next === star) {
      count += 1;
      i += 2;
      while (i + 1 < source.length && !(source[i] === star && source[i + 1] === slash)) i += 1;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i += 1;
      while (i < source.length && source[i] !== quote) {
        i += source[i] === "\\" ? 2 : 1;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return count;
}

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  for (const [filePath, expectedBytes] of initialSnapshots.entries()) {
    assert.equal(
      Buffer.compare(fs.readFileSync(filePath), expectedBytes),
      0,
      `${path.relative(REPO_ROOT, filePath)} must remain untouched`,
    );
  }
});

test("MORNING_BRIEF.md references existing deliverables, checklists, and scripts with zero comments or em dashes in this test", () => {
  const brief = fs.readFileSync(BRIEF_PATH, "utf8");

  assert.match(brief, /make accept/);
  assert.match(brief, /SPOTTER=1 bash scripts\/hw-session\.sh start/);
  assert.match(brief, /bash scripts\/hw-session\.sh stop && bash scripts\/hw-session\.sh start/);
  assert.match(brief, /bash scripts\/hw-session\.sh probe "H1"/);
  assert.match(brief, /bash scripts\/hw-session\.sh stop/);
  assert.match(brief, /bash eval\/score_real\.sh/);

  const referencedPaths = [
    "scripts/hw-session.sh",
    "docs/HARDWARE_LOG.md",
    "eval/real",
    "eval/real/labels.csv",
    "eval/score_real.sh",
    "docs/EVAL.md",
    "docs/USER_TEST_KIT.md",
    "docs/USER_FEEDBACK.md",
    "deck/index.html",
    "docs/DEMO_SCRIPT.md",
    "GEMINI.md",
    "GEMMA.md",
    "docs/evidence/verda-fieldspotter.md",
  ];

  for (const rel of referencedPaths) {
    const abs = path.join(REPO_ROOT, rel);
    assert.equal(fs.existsSync(abs), true, `expected ${rel} referenced in MORNING_BRIEF.md to exist`);
  }

  const makefile = fs.readFileSync(path.join(REPO_ROOT, "Makefile"), "utf8");
  assert.match(makefile, /^accept:\s*\n\s+bash scripts\/judge_accept\.sh/m);
  assert.equal(fs.existsSync(JUDGE_ACCEPT_PATH), true);

  const selfSrc = fs.readFileSync(SELF_TEST_PATH, "utf8");
  assert.equal(selfSrc.includes("\u2014"), false, "test file must not contain em dashes");
  assert.equal(countTsComments(selfSrc), 0, "test file must not contain comments");
});

test("scripts/hw-session.sh and server hw:probe match every CLI subcommand, flag, and SPOTTER env var in MORNING_BRIEF.md", async () => {
  const stat = fs.statSync(HW_SESSION_PATH);
  assert.ok((stat.mode & 0o111) !== 0, "scripts/hw-session.sh must be executable");

  const syntax = await runExec("bash", ["-n", HW_SESSION_PATH]);
  assert.equal(syntax.code, 0, syntax.stderr);

  const acceptSyntax = await runExec("bash", ["-n", JUDGE_ACCEPT_PATH]);
  assert.equal(acceptSyntax.code, 0, acceptSyntax.stderr);

  const hwSessionSrc = fs.readFileSync(HW_SESSION_PATH, "utf8");
  assert.match(hwSessionSrc, /SPOTTER="\$\{SPOTTER:-0\}"/);
  assert.match(hwSessionSrc, /\bstart\)/);
  assert.match(hwSessionSrc, /\burls\)/);
  assert.match(hwSessionSrc, /\bprobe\)/);
  assert.match(hwSessionSrc, /\bstop\)/);
  assert.match(hwSessionSrc, /npm -w server run --silent hw:probe -- --base "http:\/\/localhost:\$PORT" --label "\$LABEL"/);

  const spotterTsSrc = fs.readFileSync(path.join(REPO_ROOT, "server", "src", "spotter.ts"), "utf8");
  assert.match(spotterTsSrc, /process\.env\.SPOTTER === "1"/);

  const serverPkg = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "server", "package.json"), "utf8"),
  ) as { scripts?: Record<string, string> };
  assert.equal(serverPkg.scripts?.["hw:probe"], "tsx scripts/hw-probe.ts");

  const hwProbeSrc = fs.readFileSync(HW_PROBE_PATH, "utf8");
  assert.match(hwProbeSrc, /arg\("base"/);
  assert.match(hwProbeSrc, /arg\("label"/);

  const stateDir = path.join(tmpRoot, "hw-state");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "url"), "https://brief-check.trycloudflare.com", "utf8");
  fs.writeFileSync(path.join(stateDir, "key"), "a1b2c3d4e5f6", { encoding: "utf8", mode: 0o600 });

  const childEnv: NodeJS.ProcessEnv = { ...process.env, HOLDUP_HW_STATE: stateDir };
  const urlsRes = await runExec("bash", [HW_SESSION_PATH, "urls"], { env: childEnv });
  assert.equal(urlsRes.code, 0);
  assert.match(urlsRes.stdout, /Phone \(Chrome on the Android phone\):\s+https:\/\/brief-check\.trycloudflare\.com\/\?key=a1b2c3d4e5f6/);
  assert.match(urlsRes.stdout, /Bridge app, Server URL field:\s+https:\/\/brief-check\.trycloudflare\.com\/\?key=a1b2c3d4e5f6/);
  assert.match(urlsRes.stdout, /Display Web App \(Meta AI app\):\s+https:\/\/brief-check\.trycloudflare\.com\/hud\/\?key=a1b2c3d4e5f6/);
  assert.match(urlsRes.stdout, /Projector view \(laptop browser\):\s+https:\/\/brief-check\.trycloudflare\.com\/stage\?key=a1b2c3d4e5f6/);

  const stopRes = await runExec("bash", [HW_SESSION_PATH, "stop"], { env: childEnv });
  assert.equal(stopRes.code, 0);
});

test("eval/score_real.sh and eval/real/labels.csv match eval/run_eval.py real CLI flags and fail safely when sandbox has no photos", async () => {
  const stat = fs.statSync(SCORE_REAL_PATH);
  assert.ok((stat.mode & 0o111) !== 0, "eval/score_real.sh must be executable");

  const syntax = await runExec("bash", ["-n", SCORE_REAL_PATH]);
  assert.equal(syntax.code, 0, syntax.stderr);

  const scoreRealSrc = fs.readFileSync(SCORE_REAL_PATH, "utf8");
  assert.match(scoreRealSrc, /eval\/run_eval\.py predict --set real --workers 12/);
  assert.match(scoreRealSrc, /eval\/run_eval\.py score\b/);

  const csvLines = fs.readFileSync(LABELS_CSV_PATH, "utf8").trim().split(/\r?\n/);
  assert.ok(csvLines.length >= 1);
  assert.equal(csvLines[0], "file,kind,product,ingredient,strength,expiry,allergens,notes");

  const predictHelp = await runExec("python3", [RUN_EVAL_PATH, "predict", "--help"]);
  assert.equal(predictHelp.code, 0, predictHelp.stderr);
  assert.match(predictHelp.stdout, /--set \{synthetic,real\}/);
  assert.match(predictHelp.stdout, /--workers WORKERS/);

  const scoreHelp = await runExec("python3", [RUN_EVAL_PATH, "score", "--help"]);
  assert.equal(scoreHelp.code, 0, scoreHelp.stderr);
  assert.match(scoreHelp.stdout, /--hash HASH/);

  const pyWhich = await runExec("bash", ["-c", "command -v python3"]);
  assert.equal(pyWhich.code, 0);
  const pythonBin = pyWhich.stdout.trim();

  const sandboxRepo = path.join(tmpRoot, "score-sandbox");
  fs.mkdirSync(path.join(sandboxRepo, "eval", "real"), { recursive: true });
  fs.copyFileSync(SCORE_REAL_PATH, path.join(sandboxRepo, "eval", "score_real.sh"));
  fs.writeFileSync(
    path.join(sandboxRepo, "eval", "real", "labels.csv"),
    "file,kind,product,ingredient,strength,expiry,allergens,notes\nexample.jpg,medication,Amlodipin Orion,amlodipine,5 mg,2027-03,,front of box\n",
    "utf8",
  );

  const emptyRun = await runExec("bash", [path.join(sandboxRepo, "eval", "score_real.sh")], {
    cwd: sandboxRepo,
    env: {
      ...process.env,
      PY: pythonBin,
      HOLDUP_REAL_OUT: path.join(tmpRoot, "real-out"),
    },
  });
  assert.equal(emptyRun.code, 1);
  assert.match(emptyRun.stdout, /labels\.csv rows: 1, photos found: 0/);
  assert.match(emptyRun.stdout, /No photos in eval\/real\/ yet\./);
});

test("docs/HARDWARE_LOG.md and docs/USER_FEEDBACK.md define H1-H4 steps, 7-column probe schema, and ethical consent structure", () => {
  const hwLog = fs.readFileSync(HW_LOG_PATH, "utf8");
  for (const step of ["H1", "H2", "H3", "H4"]) {
    assert.match(hwLog, new RegExp(`^\\|\\s*${step}\\s*\\|`, "m"), `expected step ${step} in HARDWARE_LOG.md`);
  }
  assert.match(
    hwLog,
    /\|\s*Time \(Helsinki\)\s*\|\s*Label\s*\|\s*Gemini\s*\|\s*Sessions \/ latest\s*\|\s*Camera source: connected, worn, streaming, battery; glasses frames\s*\|\s*live first-audio p50 \/ p95 s\s*\|\s*verify p50 \/ p95 s\s*\|/,
  );

  const feedback = fs.readFileSync(USER_FEEDBACK_PATH, "utf8");
  assert.match(feedback, /USER_TEST_KIT\.md/);
  assert.match(feedback, /PRIVACY\.md/);
  assert.match(feedback, /Pre-Session Verbal Consent Checklist/);
  assert.equal(fs.existsSync(USER_TEST_KIT_PATH), true);
  assert.equal(fs.existsSync(path.join(REPO_ROOT, "docs", "PRIVACY.md")), true);
});
