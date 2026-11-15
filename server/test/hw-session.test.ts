import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import type http from "node:http";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { env, REPO_ROOT } from "../src/env.ts";
import { getHub, getOrCreateHub, markLatest } from "../src/hub.ts";
import { startServer } from "../src/index.ts";
import { ledger } from "../src/ledger.ts";

const REAL_SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "hw-session.sh");
const REAL_HW_LOG_PATH = path.join(REPO_ROOT, "docs", "HARDWARE_LOG.md");
const SELF_TEST_PATH = path.join(REPO_ROOT, "server", "test", "hw-session.test.ts");
const EM_DASH = "\u2014";
const EN_DASH = "\u2013";
const SLASH = "/";
const STAR = "*";

const initialRealScriptBytes = fs.readFileSync(REAL_SCRIPT_PATH);
const initialRealHwLogBytes = fs.readFileSync(REAL_HW_LOG_PATH);

const origHoldupKey = process.env.HOLDUP_KEY;
const origQuiet = process.env.HOLDUP_QUIET;
const origApiKey = env.apiKey;
const origLedgerPath = env.ledgerPath;

const baseTmpDir = fs.existsSync("/tmp/opencode") ? "/tmp/opencode" : os.tmpdir();
const tmpRoot = fs.mkdtempSync(path.join(baseTmpDir, "hw-session-kit-test-"));
const sandboxRoot = path.join(tmpRoot, "sandbox-repo");
const sandboxScriptPath = path.join(sandboxRoot, "scripts", "hw-session.sh");
const sandboxHwLogPath = path.join(sandboxRoot, "docs", "HARDWARE_LOG.md");

let server: http.Server;
let serverPort = 0;
let serverBase = "";

function restoreHoldupKey() {
  if (origHoldupKey === undefined) delete process.env.HOLDUP_KEY;
  else process.env.HOLDUP_KEY = origHoldupKey;
}

function assertRepoUntouched() {
  assert.equal(
    Buffer.compare(fs.readFileSync(REAL_SCRIPT_PATH), initialRealScriptBytes),
    0,
    "scripts/hw-session.sh must remain byte-identical",
  );
  assert.equal(
    Buffer.compare(fs.readFileSync(REAL_HW_LOG_PATH), initialRealHwLogBytes),
    0,
    "docs/HARDWARE_LOG.md must remain byte-identical",
  );
}

function setupSandboxRepo() {
  fs.mkdirSync(path.join(sandboxRoot, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(sandboxRoot, "docs"), { recursive: true });
  fs.mkdirSync(path.join(sandboxRoot, "server", "scripts"), { recursive: true });
  fs.mkdirSync(path.join(sandboxRoot, "server", "src"), { recursive: true });

  fs.copyFileSync(REAL_SCRIPT_PATH, sandboxScriptPath);
  fs.chmodSync(sandboxScriptPath, 0o755);
  fs.copyFileSync(REAL_HW_LOG_PATH, sandboxHwLogPath);

  fs.copyFileSync(
    path.join(REPO_ROOT, "server", "scripts", "hw-probe.ts"),
    path.join(sandboxRoot, "server", "scripts", "hw-probe.ts"),
  );
  fs.cpSync(path.join(REPO_ROOT, "server", "src"), path.join(sandboxRoot, "server", "src"), {
    recursive: true,
  });

  const rootPkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as Record<
    string,
    unknown
  >;
  const sandboxRootPkg = {
    ...rootPkg,
    workspaces: ["server"],
    scripts: {
      ...(rootPkg.scripts as Record<string, string>),
      build: 'node -e ""',
    },
  };
  fs.writeFileSync(path.join(sandboxRoot, "package.json"), JSON.stringify(sandboxRootPkg, null, 2));

  fs.copyFileSync(
    path.join(REPO_ROOT, "server", "package.json"),
    path.join(sandboxRoot, "server", "package.json"),
  );
  fs.copyFileSync(
    path.join(REPO_ROOT, "server", "tsconfig.json"),
    path.join(sandboxRoot, "server", "tsconfig.json"),
  );

  fs.symlinkSync(path.join(REPO_ROOT, "shared"), path.join(sandboxRoot, "shared"));

  const nodeModulesCandidates = [
    path.join(REPO_ROOT, "node_modules"),
    ...(process.env.NODE_PATH ? process.env.NODE_PATH.split(path.delimiter) : []),
    "/tmp/fleet-root/shared/junction-meta-glasses-venv/npm-ws/node_modules",
  ];
  const resolvedNodeModules = nodeModulesCandidates.find((p) => p && fs.existsSync(p));
  assert.ok(resolvedNodeModules, "expected shared or workspace node_modules for sandbox execution");
  fs.symlinkSync(fs.realpathSync(resolvedNodeModules), path.join(sandboxRoot, "node_modules"));
}

function runScript(
  scriptPath: string,
  args: string[],
  envOverrides: Record<string, string | undefined> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv.HOLDUP_KEY;
  delete childEnv.HOLDUP_HW_STATE;
  delete childEnv.PORT;
  delete childEnv.SPOTTER;

  const sandboxBin = path.join(sandboxRoot, "node_modules", ".bin");
  childEnv.PATH = `${sandboxBin}${path.delimiter}${childEnv.PATH ?? ""}`;

  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete childEnv[k];
    else childEnv[k] = v;
  }

  return new Promise((resolve) => {
    execFile(
      "bash",
      [scriptPath, ...args],
      {
        cwd: path.dirname(path.dirname(scriptPath)),
        env: childEnv,
        timeout: 30_000,
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

function parseMarkdownRow(line: string): string[] {
  const trimmed = line.trim();
  assert.ok(trimmed.startsWith("|"), `expected Markdown row to start with |: ${trimmed}`);
  assert.ok(trimmed.endsWith("|"), `expected Markdown row to end with |: ${trimmed}`);
  return trimmed
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

function countTsComments(source: string): number {
  let count = 0;
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = i + 1 < source.length ? source[i + 1] : "";
    if (ch === SLASH && next === SLASH) {
      count += 1;
      i += 2;
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === SLASH && next === STAR) {
      count += 1;
      i += 2;
      while (i + 1 < source.length && !(source[i] === STAR && source[i + 1] === SLASH)) i += 1;
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

function secretVariants(secret: string): string[] {
  const enc1 = encodeURIComponent(secret);
  const enc2 = encodeURIComponent(enc1);
  const plus1 = enc1.replace(/%20/g, "+");
  const plus2 = encodeURIComponent(plus1);
  return Array.from(new Set([secret, enc1, enc2, plus1, plus2].filter((s) => s.length > 0)));
}

async function getFreePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

before(async () => {
  process.env.HOLDUP_QUIET = "1";
  env.apiKey = "";
  env.ledgerPath = path.join(tmpRoot, "ledger.jsonl");
  delete process.env.HOLDUP_KEY;

  setupSandboxRepo();

  ledger({
    feature: "live",
    model: "gemini-3.8-live",
    latency_s: 3.9,
    first_audio_s: 1.88,
    ok: true,
  });
  ledger({
    feature: "verify",
    model: "gemini-3.8-flash",
    latency_s: 0.79,
    ok: true,
  });

  server = await startServer(0);
  const addr = server.address() as AddressInfo;
  serverPort = addr.port;
  serverBase = `http://localhost:${serverPort}`;
});

afterEach(() => {
  restoreHoldupKey();
  env.apiKey = "";
  const hub = getHub("hw-kit-smoke");
  if (hub) {
    hub.dropFrames();
    hub.live = undefined;
    hub.device = undefined;
    hub.source = "phone";
  }
  fs.copyFileSync(REAL_HW_LOG_PATH, sandboxHwLogPath);
  const dotEnv = path.join(sandboxRoot, ".env");
  if (fs.existsSync(dotEnv)) fs.rmSync(dotEnv, { force: true });
  assertRepoUntouched();
});

after(async () => {
  try {
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    restoreHoldupKey();
    env.apiKey = origApiKey;
    env.ledgerPath = origLedgerPath;
    if (origQuiet === undefined) delete process.env.HOLDUP_QUIET;
    else process.env.HOLDUP_QUIET = origQuiet;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    assertRepoUntouched();
  }
});

test("scripts/hw-session.sh satisfies executable permissions, bash -n syntax check, and usage output on help/unknown args; test file has zero comments or em dashes", async () => {
  const stat = fs.statSync(REAL_SCRIPT_PATH);
  assert.ok((stat.mode & 0o111) !== 0, "scripts/hw-session.sh must be executable");

  const shSrc = fs.readFileSync(REAL_SCRIPT_PATH, "utf8");
  assert.ok(shSrc.startsWith("#!/usr/bin/env bash\n"));
  assert.ok(shSrc.includes("set -euo pipefail"));

  const syntaxExit = await new Promise<number>((resolve) => {
    execFile("bash", ["-n", REAL_SCRIPT_PATH], { cwd: REPO_ROOT }, (err) => resolve(err ? 1 : 0));
  });
  assert.equal(syntaxExit, 0, "bash -n scripts/hw-session.sh must pass");

  const stateDir = path.join(tmpRoot, "state-usage");
  for (const args of [[], ["help"], ["--help"], ["unknown"]]) {
    const res = await runScript(REAL_SCRIPT_PATH, args, { HOLDUP_HW_STATE: stateDir });
    assert.equal(res.code, 1);
    assert.match(res.stdout, /bash scripts\/hw-session\.sh start/);
    assert.match(res.stdout, /bash scripts\/hw-session\.sh urls/);
    assert.match(res.stdout, /bash scripts\/hw-session\.sh probe "H1"/);
    assert.match(res.stdout, /bash scripts\/hw-session\.sh stop/);
    assert.match(res.stdout, /SPOTTER=1/);
  }

  const selfSrc = fs.readFileSync(SELF_TEST_PATH, "utf8");
  assert.equal(selfSrc.includes(EM_DASH), false, "hw-session.test.ts must not contain em dashes");
  assert.equal(countTsComments(selfSrc), 0, "hw-session.test.ts must not contain comments");
});

test("urls subcommand fails cleanly before start and prints Phone, Bridge, Display /hud/ (trailing slash), Projector /stage, and public /api/health URLs when state is populated", async () => {
  const stateDir = path.join(tmpRoot, "state-urls");

  const missingRes = await runScript(REAL_SCRIPT_PATH, ["urls"], { HOLDUP_HW_STATE: stateDir });
  assert.equal(missingRes.code, 1);
  assert.match(missingRes.stdout, /No tunnel URL yet\. Run: bash scripts\/hw-session\.sh start/);

  const tunnelUrl = "https://holdup-0800.trycloudflare.com";
  const keyVal = "f4e3d2c1b0a9";
  fs.writeFileSync(path.join(stateDir, "url"), tunnelUrl, "utf8");
  fs.writeFileSync(path.join(stateDir, "key"), keyVal, { encoding: "utf8", mode: 0o600 });

  const okRes = await runScript(REAL_SCRIPT_PATH, ["urls"], { HOLDUP_HW_STATE: stateDir });
  assert.equal(okRes.code, 0);
  assert.equal(okRes.stderr, "");
  assert.ok(okRes.stdout.includes(`${tunnelUrl}/?key=${keyVal}`));
  assert.match(okRes.stdout, /Phone \(Chrome on the Android phone\):\s+https:\/\/holdup-0800\.trycloudflare\.com\/\?key=f4e3d2c1b0a9/);
  assert.match(okRes.stdout, /Bridge app, Server URL field:\s+https:\/\/holdup-0800\.trycloudflare\.com\/\?key=f4e3d2c1b0a9/);
  assert.match(okRes.stdout, /Display Web App \(Meta AI app\):\s+https:\/\/holdup-0800\.trycloudflare\.com\/hud\/\?key=f4e3d2c1b0a9/);
  assert.match(okRes.stdout, /Projector view \(laptop browser\):\s+https:\/\/holdup-0800\.trycloudflare\.com\/stage\?key=f4e3d2c1b0a9/);
  assert.match(okRes.stdout, /Health:\s+https:\/\/holdup-0800\.trycloudflare\.com\/api\/health\b/);
  assert.equal(okRes.stdout.includes("/api/health?key="), false);
});

test("start enforces .env, port-in-use, cloudflared, and Already-running guardrails", async () => {
  const stateDir = path.join(tmpRoot, "state-guards");

  const noEnvRes = await runScript(sandboxScriptPath, ["start"], {
    HOLDUP_HW_STATE: stateDir,
    PORT: String(serverPort),
  });
  assert.equal(noEnvRes.code, 1);
  assert.match(noEnvRes.stdout, /No \.env here\. Copy \.env\.example to \.env/);

  fs.writeFileSync(path.join(sandboxRoot, ".env"), "GEMINI_API_KEY=\n", "utf8");

  const portBusyRes = await runScript(sandboxScriptPath, ["start"], {
    HOLDUP_HW_STATE: stateDir,
    PORT: String(serverPort),
  });
  assert.equal(portBusyRes.code, 1);
  assert.match(portBusyRes.stdout, new RegExp(`Port ${serverPort} is in use by another program`));

  const freePort = await getFreePort();
  const emptyBin = path.join(tmpRoot, "no-cloudflared-bin");
  fs.mkdirSync(emptyBin, { recursive: true });
  for (const cmd of ["bash", "dirname", "mkdir", "cat", "kill", "lsof", "seq", "grep", "head", "cut", "printf", "sed"]) {
    const found = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]
      .map((d) => path.join(d, cmd))
      .find((p) => fs.existsSync(p));
    if (found) fs.symlinkSync(found, path.join(emptyBin, cmd));
  }

  const noCloudflaredRes = await new Promise<{ code: number; stdout: string }>((resolve) => {
    execFile(
      path.join(emptyBin, "bash"),
      [sandboxScriptPath, "start"],
      {
        cwd: sandboxRoot,
        env: { PATH: emptyBin, HOLDUP_HW_STATE: stateDir, PORT: String(freePort) },
        encoding: "utf8",
      },
      (err, stdout) => resolve({ code: err ? 1 : 0, stdout: String(stdout ?? "") }),
    );
  });
  assert.equal(noCloudflaredRes.code, 1);
  assert.match(noCloudflaredRes.stdout, /cloudflared is not installed/);

  const dummy = spawn(process.execPath, ["-e", "setInterval(() => {}, 10000)"], { stdio: "ignore" });
  try {
    fs.writeFileSync(path.join(stateDir, "server.pid"), String(dummy.pid), "utf8");
    fs.writeFileSync(path.join(stateDir, "url"), "https://already-up.trycloudflare.com", "utf8");
    fs.writeFileSync(path.join(stateDir, "key"), "keepkey001122", "utf8");

    const alreadyRes = await runScript(sandboxScriptPath, ["start"], {
      HOLDUP_HW_STATE: stateDir,
      PORT: String(serverPort),
    });
    assert.equal(alreadyRes.code, 0);
    assert.match(alreadyRes.stdout, /Already running\./);
    assert.ok(alreadyRes.stdout.includes("https://already-up.trycloudflare.com/hud/?key=keepkey001122"));
  } finally {
    try {
      dummy.kill("SIGKILL");
    } catch {}
  }
});

test("probe reads HOLDUP_KEY from HOLDUP_HW_STATE/key, authenticates /api/stats without 401, appends 7-col Markdown row to sandbox HARDWARE_LOG.md, and leaks zero secrets", async () => {
  const secretKey = "s3cr3t+probe/key&0800=ok";
  process.env.HOLDUP_KEY = secretKey;

  const hub = getOrCreateHub("hw-kit-smoke");
  hub.source = "glasses";
  markLatest(hub);

  const statePost = await fetch(`${serverBase}/ingest/state?key=${encodeURIComponent(secretKey)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ connected: true, worn: true, streaming: true, battery: 91 }),
  });
  assert.equal(statePost.status, 204);

  const unauthStats = await fetch(`${serverBase}/api/stats`);
  assert.equal(unauthStats.status, 401);

  const stateDir = path.join(tmpRoot, "state-probe-auth");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "key"), secretKey, { encoding: "utf8", mode: 0o600 });

  const probeRes = await runScript(sandboxScriptPath, ["probe", "H4|coach->match"], {
    HOLDUP_HW_STATE: stateDir,
    PORT: String(serverPort),
  });

  assert.equal(probeRes.code, 0, `probe failed: ${probeRes.stderr}`);
  assert.equal(probeRes.stderr.includes("401"), false, `unexpected 401 on stderr: ${probeRes.stderr}`);
  assert.equal(probeRes.stderr.includes("stats unavailable"), false, `unexpected stats error: ${probeRes.stderr}`);
  assert.match(probeRes.stderr, /appended to docs\/HARDWARE_LOG\.md/);

  const stdoutLines = probeRes.stdout.trim().split(/\r?\n/);
  assert.equal(stdoutLines.length, 1);
  const cells = parseMarkdownRow(stdoutLines[0]);
  assert.equal(cells.length, 7);
  assert.match(cells[0], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(cells[1], "H4/coach->match");
  assert.match(cells[2], /^(ok|down)$/);
  assert.equal(cells[3], "1 / hw-kit-s");
  assert.match(cells[4], /^glasses: true, true, true, 91; frames \d+/);
  assert.equal(cells[5], "1.88 / 1.88");
  assert.equal(cells[6], "0.79 / 0.79");

  const sandboxLogLines = fs.readFileSync(sandboxHwLogPath, "utf8").trimEnd().split(/\r?\n/);
  assert.equal(sandboxLogLines[sandboxLogLines.length - 1], stdoutLines[0]);

  for (const variant of [...secretVariants(secretKey), "s3cr3t"]) {
    assert.equal(probeRes.stdout.includes(variant), false, `probe stdout leaked ${variant}`);
    assert.equal(probeRes.stderr.includes(variant), false, `probe stderr leaked ${variant}`);
    assert.equal(
      fs.readFileSync(sandboxHwLogPath, "utf8").includes(variant),
      false,
      `sandbox HARDWARE_LOG.md leaked ${variant}`,
    );
  }

  const unauthStateDir = path.join(tmpRoot, "state-probe-nokey");
  fs.mkdirSync(unauthStateDir, { recursive: true });
  const unauthProbe = await runScript(sandboxScriptPath, ["probe", "H1-unauth"], {
    HOLDUP_HW_STATE: unauthStateDir,
    PORT: String(serverPort),
  });
  assert.equal(unauthProbe.code, 0);
  assert.match(unauthProbe.stderr, /stats unavailable: \/api\/stats -> HTTP 401/);
  const unauthCells = parseMarkdownRow(unauthProbe.stdout);
  assert.equal(unauthCells[5], `${EN_DASH} / ${EN_DASH}`);
  assert.equal(unauthCells[6], `${EN_DASH} / ${EN_DASH}`);
});

test("start -> urls -> probe -> stop full lifecycle works with stubbed cloudflared and SPOTTER=1", async () => {
  const stateDir = path.join(tmpRoot, "state-full-lifecycle");
  const fakeBin = path.join(tmpRoot, "fake-cloudflared-bin");
  fs.mkdirSync(fakeBin, { recursive: true });

  const fakeCloudflared = path.join(fakeBin, "cloudflared");
  fs.writeFileSync(
    fakeCloudflared,
    [
      "#!/usr/bin/env bash",
      'echo "2026-11-15T06:00:00Z INF |  https://morning-0800-demo.trycloudflare.com  |"',
      "sleep 30",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o755 },
  );

  const dotenvSecret = "dotenv_lifecycle_key_88";
  fs.writeFileSync(
    path.join(sandboxRoot, ".env"),
    `GEMINI_API_KEY=\nHOLDUP_KEY=${dotenvSecret}\n`,
    "utf8",
  );

  const livePort = await getFreePort();
  const customPath = `${fakeBin}${path.delimiter}${path.join(sandboxRoot, "node_modules", ".bin")}${path.delimiter}${process.env.PATH ?? ""}`;

  try {
    const startRes = await runScript(sandboxScriptPath, ["start"], {
      HOLDUP_HW_STATE: stateDir,
      PORT: String(livePort),
      SPOTTER: "1",
      PATH: customPath,
    });
    assert.equal(startRes.code, 0, `start failed: stdout=${startRes.stdout}\nstderr=${startRes.stderr}`);
    assert.match(startRes.stdout, /Server and tunnel are up \(dose finder: on\)/);
    assert.ok(startRes.stdout.includes(`https://morning-0800-demo.trycloudflare.com/?key=${dotenvSecret}`));
    assert.ok(startRes.stdout.includes(`https://morning-0800-demo.trycloudflare.com/hud/?key=${dotenvSecret}`));
    assert.ok(startRes.stdout.includes(`https://morning-0800-demo.trycloudflare.com/stage?key=${dotenvSecret}`));

    const keyMode = fs.statSync(path.join(stateDir, "key")).mode & 0o777;
    assert.equal(keyMode, 0o600, `expected 0600 on $STATE/key, got 0o${keyMode.toString(8)}`);
    assert.equal(fs.readFileSync(path.join(stateDir, "key"), "utf8"), dotenvSecret);
    assert.equal(fs.readFileSync(path.join(stateDir, "url"), "utf8"), "https://morning-0800-demo.trycloudflare.com");

    const srvPid = Number(fs.readFileSync(path.join(stateDir, "server.pid"), "utf8").trim());
    const tunPid = Number(fs.readFileSync(path.join(stateDir, "tunnel.pid"), "utf8").trim());
    assert.ok(srvPid > 0 && pidAlive(srvPid), "expected started server pid to be alive");
    assert.ok(tunPid > 0 && pidAlive(tunPid), "expected started tunnel pid to be alive");

    const unauthCheck = await fetch(`http://localhost:${livePort}/api/stats`);
    assert.equal(unauthCheck.status, 401);

    const probeRes = await runScript(sandboxScriptPath, ["probe", "H1"], {
      HOLDUP_HW_STATE: stateDir,
      PORT: String(livePort),
      PATH: customPath,
    });
    assert.equal(probeRes.code, 0);
    assert.equal(probeRes.stderr.includes("401"), false);
    const rowCells = parseMarkdownRow(probeRes.stdout);
    assert.equal(rowCells.length, 7);
    assert.equal(rowCells[1], "H1");
    assert.equal(probeRes.stdout.includes(dotenvSecret), false);
    assert.equal(probeRes.stderr.includes(dotenvSecret), false);

    const stopRes = await runScript(sandboxScriptPath, ["stop"], {
      HOLDUP_HW_STATE: stateDir,
      PATH: customPath,
    });
    assert.equal(stopRes.code, 0);
    assert.match(stopRes.stdout, /Stopped tunnel/);
    assert.match(stopRes.stdout, /Stopped server/);
    assert.equal(fs.existsSync(path.join(stateDir, "server.pid")), false);
    assert.equal(fs.existsSync(path.join(stateDir, "tunnel.pid")), false);

    for (let i = 0; i < 20 && (pidAlive(srvPid) || pidAlive(tunPid)); i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(pidAlive(srvPid), false, "stop must terminate server pid");
    assert.equal(pidAlive(tunPid), false, "stop must terminate tunnel pid");

    const idempotentStop = await runScript(sandboxScriptPath, ["stop"], {
      HOLDUP_HW_STATE: stateDir,
      PATH: customPath,
    });
    assert.equal(idempotentStop.code, 0);
    assert.equal(idempotentStop.stdout.trim(), "");
  } finally {
    await runScript(sandboxScriptPath, ["stop"], {
      HOLDUP_HW_STATE: stateDir,
      PATH: customPath,
    });
  }
});

test("probe defaults missing label argument to probe and stop terminates parent + child pids cleanly", async () => {
  const secretKey = "default_label_key_42";
  process.env.HOLDUP_KEY = secretKey;

  const stateDir = path.join(tmpRoot, "state-default-label");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "key"), secretKey, { encoding: "utf8", mode: 0o600 });

  const probeRes = await runScript(sandboxScriptPath, ["probe"], {
    HOLDUP_HW_STATE: stateDir,
    PORT: String(serverPort),
  });
  assert.equal(probeRes.code, 0);
  assert.equal(probeRes.stderr.includes("401"), false);
  const cells = parseMarkdownRow(probeRes.stdout);
  assert.equal(cells.length, 7);
  assert.equal(cells[1], "probe");
  assert.equal(probeRes.stdout.includes(secretKey), false);

  const parentProc = spawn(
    process.execPath,
    [
      "-e",
      'const { spawn } = require("node:child_process"); const c = spawn(process.execPath, ["-e", "setInterval(()=>{},10000)"], { stdio: "ignore" }); console.log(c.pid); setInterval(()=>{},10000);',
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  const parentPid = parentProc.pid!;
  const childPid = await new Promise<number>((resolve) => {
    parentProc.stdout.once("data", (d) => resolve(Number(String(d).trim())));
  });
  try {
    assert.ok(parentPid > 0 && pidAlive(parentPid));
    assert.ok(childPid > 0 && pidAlive(childPid));
    fs.writeFileSync(path.join(stateDir, "server.pid"), String(parentPid), "utf8");

    const stopRes = await runScript(REAL_SCRIPT_PATH, ["stop"], { HOLDUP_HW_STATE: stateDir });
    assert.equal(stopRes.code, 0);
    assert.match(stopRes.stdout, new RegExp(`Stopped server \\(${parentPid}\\)\\.`));
    assert.equal(fs.existsSync(path.join(stateDir, "server.pid")), false);

    for (let i = 0; i < 20 && (pidAlive(parentPid) || pidAlive(childPid)); i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(pidAlive(parentPid), false);
    assert.equal(pidAlive(childPid), false);
  } finally {
    try {
      process.kill(childPid, "SIGKILL");
    } catch {}
    try {
      parentProc.kill("SIGKILL");
    } catch {}
  }
});

