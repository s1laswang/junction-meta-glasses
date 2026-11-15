import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { REPO_ROOT, SERVER_DIR } from "../src/env.ts";

const HW_PROBE_SCRIPT = path.join(SERVER_DIR, "scripts", "hw-probe.ts");
const HARDWARE_LOG_PATH = path.join(REPO_ROOT, "docs", "HARDWARE_LOG.md");
const HARDWARE_NOTES_PATH = path.join(REPO_ROOT, "docs", "HARDWARE_NOTES.md");
const SHOT_LIST_PATH = path.join(REPO_ROOT, "docs", "SHOT_LIST.md");
const DEMO_SCRIPT_PATH = path.join(REPO_ROOT, "docs", "DEMO_SCRIPT.md");
const SERVER_PKG_PATH = path.join(SERVER_DIR, "package.json");
const EN_DASH = "\u2013";

const initialHardwareLogBytes = fs.readFileSync(HARDWARE_LOG_PATH);

type MockReply = {
  status?: number;
  body?: unknown;
};

type RecordedRequest = {
  method: string;
  url: string;
};

let server: http.Server;
let baseUrl = "";
let healthReply: () => MockReply = () => ({ status: 200, body: { ok: true, gemini: "ok" } });
let statsReply: () => MockReply = () => ({ status: 200, body: { since: null, total: 0, features: {} } });
const recordedRequests: RecordedRequest[] = [];

function assertHardwareLogUnchanged() {
  const current = fs.readFileSync(HARDWARE_LOG_PATH);
  assert.equal(
    Buffer.compare(current, initialHardwareLogBytes),
    0,
    "docs/HARDWARE_LOG.md must remain byte-identical",
  );
}

function execFileAsync(
  cmd: string,
  args: string[],
  envOverrides?: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        cwd: REPO_ROOT,
        env: { ...process.env, HOLDUP_KEY: "", ...envOverrides },
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

async function runProbe(
  args: string[],
  envOverrides?: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  assert.ok(args.includes("--no-write"), "every hw-probe test run must pass --no-write");
  const res = await execFileAsync(process.execPath, ["--import", "tsx", HW_PROBE_SCRIPT, ...args], envOverrides);
  assertHardwareLogUnchanged();
  return res;
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

function readProbeTableHeaderCells(): { headerCells: string[]; separatorCells: string[] } {
  const lines = initialHardwareLogBytes.toString("utf8").split(/\r?\n/);
  const headingIdx = lines.findIndex((line) => line.startsWith("## Probe rows"));
  assert.ok(headingIdx >= 0, "expected ## Probe rows heading in docs/HARDWARE_LOG.md");
  const headerCells = parseMarkdownRow(lines[headingIdx + 1] ?? "");
  const separatorCells = parseMarkdownRow(lines[headingIdx + 2] ?? "");
  return { headerCells, separatorCells };
}

const LOCAL_ORIGIN = ["http:", "", "127.0.0.1"].join("/");

before(async () => {
  server = http.createServer((req, res) => {
    const reqUrl = req.url ?? "/";
    recordedRequests.push({ method: req.method ?? "GET", url: reqUrl });
    const parsed = new URL(reqUrl, LOCAL_ORIGIN);
    let reply: MockReply = { status: 404, body: { error: "not_found" } };
    if (parsed.pathname === "/api/health") {
      reply = healthReply();
    } else if (parsed.pathname === "/api/stats") {
      reply = statsReply();
    }
    const status = reply.status ?? 200;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(reply.body ?? {}));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = ["http:", "", `127.0.0.1:${addr.port}`].join("/");
});

afterEach(() => {
  recordedRequests.length = 0;
  healthReply = () => ({ status: 200, body: { ok: true, gemini: "ok" } });
  statsReply = () => ({ status: 200, body: { since: null, total: 0, features: {} } });
  assertHardwareLogUnchanged();
});

after(async () => {
  if (server) {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  assertHardwareLogUnchanged();
});

test("hw-probe prints a 7-column Markdown row matching HARDWARE_LOG.md with 2-decimal latencies and glasses state", async () => {
  const { headerCells, separatorCells } = readProbeTableHeaderCells();
  assert.equal(headerCells.length, 7);
  assert.equal(separatorCells.length, 7);

  healthReply = () => ({
    status: 200,
    body: {
      ok: true,
      gemini: "ok",
      sessions: 2,
      latest: "sess-h4",
      glasses: {
        source: "glasses",
        device: {
          connected: true,
          worn: true,
          streaming: true,
          battery: 84,
          source: "glasses",
        },
        framesAccepted: 37,
        framesDropped: 1,
        lastFrameAgoS: 0.4,
      },
    },
  });
  statsReply = () => ({
    status: 200,
    body: {
      since: 1763150000000,
      total: 12,
      features: {
        live: {
          first_audio_p50_s: 1.846,
          first_audio_p95_s: 3.1,
        },
        verify: {
          latency_p50_s: 0.894,
          latency_p95_s: 1.5,
        },
      },
    },
  });

  const res = await runProbe(["--base", `${baseUrl}/`, "--label", "H4-match", "--no-write"]);
  assert.equal(res.code, 0);
  assert.equal(res.stderr, "");
  assert.deepEqual(recordedRequests, [
    { method: "GET", url: "/api/health" },
    { method: "GET", url: "/api/stats" },
  ]);

  const stdoutLines = res.stdout.trim().split(/\r?\n/);
  assert.equal(stdoutLines.length, 1);

  const cells = parseMarkdownRow(stdoutLines[0]);
  assert.equal(cells.length, headerCells.length);
  assert.match(cells[0], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(cells[1], "H4-match");
  assert.equal(cells[2], "ok");
  assert.equal(cells[3], "2 / sess-h4");
  assert.equal(cells[4], "glasses: true, true, true, 84; frames 37 (last 0.4 s ago)");
  assert.equal(cells[5], "1.85 / 3.10");
  assert.equal(cells[6], "0.89 / 1.50");
});

test("hw-probe URL-encodes HOLDUP_KEY as ?key= and never leaks the key in stdout or stderr across normal, --raw, and error modes", async () => {
  const secretKey = "secr3t key+plus/slash&amp=eq#hash%pct";
  const encodedKey = encodeURIComponent(secretKey);
  assert.notEqual(encodedKey, secretKey);

  healthReply = () => ({
    status: 200,
    body: {
      ok: true,
      gemini: "ok",
      sessions: 1,
      latest: "s1",
      glasses: {
        source: "glasses",
        device: { connected: true, worn: true, streaming: true, battery: 91 },
        framesAccepted: 10,
        lastFrameAgoS: 0.8,
      },
    },
  });
  statsReply = () => ({
    status: 200,
    body: {
      features: {
        live: { first_audio_p50_s: 2.1, first_audio_p95_s: 3.4 },
        verify: { latency_p50_s: 0.75, latency_p95_s: 1.2 },
      },
    },
  });

  const normalRes = await runProbe(
    ["--base", baseUrl, "--label", "H4-match", "--no-write"],
    { HOLDUP_KEY: secretKey },
  );
  assert.equal(normalRes.code, 0);
  assert.deepEqual(recordedRequests, [
    { method: "GET", url: `/api/health?key=${encodedKey}` },
    { method: "GET", url: `/api/stats?key=${encodedKey}` },
  ]);
  for (const req of recordedRequests) {
    const parsed = new URL(req.url, LOCAL_ORIGIN);
    assert.equal(parsed.searchParams.get("key"), secretKey);
  }
  for (const leaked of [secretKey, encodedKey, "secr3t"]) {
    assert.equal(normalRes.stdout.includes(leaked), false);
    assert.equal(normalRes.stderr.includes(leaked), false);
  }

  recordedRequests.length = 0;
  const rawRes = await runProbe(
    ["--base", baseUrl, "--label", "H4-match", "--no-write", "--raw"],
    { HOLDUP_KEY: secretKey },
  );
  assert.equal(rawRes.code, 0);
  assert.deepEqual(recordedRequests, [
    { method: "GET", url: `/api/health?key=${encodedKey}` },
    { method: "GET", url: `/api/stats?key=${encodedKey}` },
  ]);
  const rawPayload = JSON.parse(rawRes.stderr) as { health: Record<string, unknown>; features: string[] };
  assert.equal(rawPayload.health.gemini, "ok");
  assert.deepEqual(rawPayload.features, ["live", "verify"]);
  for (const leaked of [secretKey, encodedKey, "secr3t"]) {
    assert.equal(rawRes.stdout.includes(leaked), false);
    assert.equal(rawRes.stderr.includes(leaked), false);
  }

  recordedRequests.length = 0;
  statsReply = () => ({ status: 401, body: { code: "unauthorized" } });
  const statsErrRes = await runProbe(
    ["--base", baseUrl, "--label", "H4-match", "--no-write"],
    { HOLDUP_KEY: secretKey },
  );
  assert.equal(statsErrRes.code, 0);
  assert.ok(statsErrRes.stderr.includes("stats unavailable: /api/stats -> HTTP 401"));
  for (const leaked of [secretKey, encodedKey, "secr3t"]) {
    assert.equal(statsErrRes.stdout.includes(leaked), false);
    assert.equal(statsErrRes.stderr.includes(leaked), false);
  }

  recordedRequests.length = 0;
  healthReply = () => ({ status: 401, body: { code: "unauthorized" } });
  const healthErrRes = await runProbe(
    ["--base", baseUrl, "--label", "H4-match", "--no-write"],
    { HOLDUP_KEY: secretKey },
  );
  assert.notEqual(healthErrRes.code, 0);
  for (const leaked of [secretKey, encodedKey, "secr3t"]) {
    assert.equal(healthErrRes.stdout.includes(leaked), false);
    assert.equal(healthErrRes.stderr.includes(leaked), false);
  }
});

test("hw-probe sanitizes pipe characters in --label to slashes and defaults missing --label to probe", async () => {
  const pipedRes = await runProbe(["--base", baseUrl, "--label", "H2|H3|streaming", "--no-write"]);
  assert.equal(pipedRes.code, 0);
  const pipedCells = parseMarkdownRow(pipedRes.stdout);
  assert.equal(pipedCells.length, 7);
  assert.equal(pipedCells[1], "H2/H3/streaming");

  const defaultLabelRes = await runProbe(["--base", baseUrl, "--no-write"]);
  assert.equal(defaultLabelRes.code, 0);
  const defaultCells = parseMarkdownRow(defaultLabelRes.stdout);
  assert.equal(defaultCells.length, 7);
  assert.equal(defaultCells[1], "probe");
});

test("hw-probe degrades gracefully to en-dashes when /api/stats returns HTTP 500 or omits features", async () => {
  healthReply = () => ({ status: 200, body: { ok: true } });
  statsReply = () => ({ status: 500, body: { error: "ledger_read_failed" } });

  const stats500Res = await runProbe(["--base", baseUrl, "--label", "H6-safety-catches", "--no-write"]);
  assert.equal(stats500Res.code, 0);
  assert.ok(stats500Res.stderr.includes("stats unavailable: /api/stats -> HTTP 500"));
  const cells500 = parseMarkdownRow(stats500Res.stdout);
  assert.equal(cells500.length, 7);
  assert.equal(cells500[2], "?");
  assert.equal(cells500[3], `${EN_DASH} / ${EN_DASH}`);
  assert.equal(
    cells500[4],
    `${EN_DASH}: ${EN_DASH}, ${EN_DASH}, ${EN_DASH}, ${EN_DASH}; frames ${EN_DASH} (last ${EN_DASH} s ago)`,
  );
  assert.equal(cells500[5], `${EN_DASH} / ${EN_DASH}`);
  assert.equal(cells500[6], `${EN_DASH} / ${EN_DASH}`);

  statsReply = () => ({ status: 200, body: { total: 0 } });
  const omittedFeaturesRes = await runProbe(["--base", baseUrl, "--label", "H8-glasses-off", "--no-write"]);
  assert.equal(omittedFeaturesRes.code, 0);
  assert.equal(omittedFeaturesRes.stderr, "");
  const cellsOmitted = parseMarkdownRow(omittedFeaturesRes.stdout);
  assert.equal(cellsOmitted.length, 7);
  assert.equal(cellsOmitted[5], `${EN_DASH} / ${EN_DASH}`);
  assert.equal(cellsOmitted[6], `${EN_DASH} / ${EN_DASH}`);
});

test("hw-probe supports verify_label fallback key, verify precedence, and object sessions JSON serialization", async () => {
  healthReply = () => ({
    status: 200,
    body: {
      ok: true,
      gemini: "down",
      sessions: { active: 1, total: 3 },
      latest: "sess-obj",
      glasses: {
        source: "phone",
        device: { connected: true, worn: false, streaming: false, battery: null },
        framesAccepted: 14,
        lastFrameAgoS: null,
      },
    },
  });
  statsReply = () => ({
    status: 200,
    body: {
      features: {
        verify_label: { latency_p50_s: 1.236, latency_p95_s: 2.4 },
      },
    },
  });

  const fallbackRes = await runProbe(["--base", baseUrl, "--label", "H5-H7-hud-logged", "--no-write"]);
  assert.equal(fallbackRes.code, 0);
  const fallbackCells = parseMarkdownRow(fallbackRes.stdout);
  assert.equal(fallbackCells.length, 7);
  assert.equal(fallbackCells[2], "down");
  assert.equal(fallbackCells[3], `{"active":1,"total":3} / sess-obj`);
  assert.equal(fallbackCells[4], `phone: true, false, false, ${EN_DASH}; frames 14 (last ${EN_DASH} s ago)`);
  assert.equal(fallbackCells[5], `${EN_DASH} / ${EN_DASH}`);
  assert.equal(fallbackCells[6], "1.24 / 2.40");

  statsReply = () => ({
    status: 200,
    body: {
      features: {
        verify: { latency_p50_s: 0.71, latency_p95_s: 1.09 },
        verify_label: { latency_p50_s: 9.99, latency_p95_s: 9.99 },
      },
    },
  });
  const precedenceRes = await runProbe(["--base", baseUrl, "--label", "H5-H7-hud-logged", "--no-write"]);
  assert.equal(precedenceRes.code, 0);
  const precedenceCells = parseMarkdownRow(precedenceRes.stdout);
  assert.equal(precedenceCells[6], "0.71 / 1.09");
});

test("hw-probe exits non-zero without printing a row when /api/health returns HTTP 401 or HTTP 500", async () => {
  for (const status of [401, 500]) {
    recordedRequests.length = 0;
    healthReply = () => ({ status, body: { error: "unavailable" } });

    const res = await runProbe(["--base", baseUrl, "--label", "H10-live-recovered", "--no-write"]);
    assert.notEqual(res.code, 0);
    assert.equal(res.stdout, "");
    assert.ok(res.stderr.includes(`/api/health -> HTTP ${status}`));
    assert.deepEqual(recordedRequests, [{ method: "GET", url: "/api/health" }]);
  }
});

test("rehearsal runbook cross-check across HARDWARE_LOG.md, SHOT_LIST.md, DEMO_SCRIPT.md, and clean git state", async () => {
  const hardwareLog = fs.readFileSync(HARDWARE_LOG_PATH, "utf8");
  const hardwareNotes = fs.readFileSync(HARDWARE_NOTES_PATH, "utf8");
  const shotList = fs.readFileSync(SHOT_LIST_PATH, "utf8");
  const demoScript = fs.readFileSync(DEMO_SCRIPT_PATH, "utf8");
  const serverPkg = JSON.parse(fs.readFileSync(SERVER_PKG_PATH, "utf8")) as {
    scripts?: Record<string, string>;
  };

  assert.equal(serverPkg.scripts?.["hw:probe"], "tsx scripts/hw-probe.ts");

  for (let i = 1; i <= 10; i += 1) {
    const id = `H${i}`;
    assert.match(hardwareLog, new RegExp(`^\\|\\s*${id}\\s*\\|`, "m"), `missing ${id} row in HARDWARE_LOG.md`);
    assert.match(shotList, new RegExp(`\\b${id}\\b`), `missing ${id} in SHOT_LIST.md`);
  }

  const shotProbeMatches = [...shotList.matchAll(/npm -w server run hw:probe([^\n`]*)/g)];
  const logProbeMatches = [...hardwareLog.matchAll(/npm -w server run hw:probe([^\n`]*)/g)];
  assert.ok(shotProbeMatches.length >= 7, `expected >= 7 hw:probe invocations in SHOT_LIST.md, got ${shotProbeMatches.length}`);
  assert.ok(logProbeMatches.length >= 1, `expected >= 1 hw:probe invocation in HARDWARE_LOG.md, got ${logProbeMatches.length}`);

  const validValueFlags = new Set(["--base", "--label"]);
  const validBoolFlags = new Set(["--no-write", "--raw"]);

  for (const match of [...shotProbeMatches, ...logProbeMatches]) {
    const tail = match[1].trim();
    assert.ok(tail.startsWith("-- "), `hw:probe invocation must separate flags with '--': ${match[0]}`);
    const rest = tail.slice(3).trim();
    const tokens = [...rest.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
    const seen = new Map<string, string>();
    for (let idx = 0; idx < tokens.length; idx += 1) {
      const tok = tokens[idx];
      if (tok.startsWith("--")) {
        if (validValueFlags.has(tok)) {
          const val = tokens[idx + 1] ?? "";
          assert.ok(val.length > 0 && !val.startsWith("--"), `flag ${tok} missing value in: ${match[0]}`);
          seen.set(tok, val);
          idx += 1;
        } else {
          assert.ok(validBoolFlags.has(tok), `unsupported hw:probe flag ${tok} in: ${match[0]}`);
          seen.set(tok, "true");
        }
      }
    }
    assert.ok(seen.has("--base"), `missing --base in: ${match[0]}`);
    assert.ok(seen.has("--label"), `missing --label in: ${match[0]}`);
    assert.equal(seen.get("--label")?.includes("|"), false, `raw pipe in --label: ${match[0]}`);
  }

  assert.ok(hardwareLog.includes("164dea1b"), "HARDWARE_LOG.md must reference APK sha256 prefix 164dea1b");
  const shotShaMatch = shotList.match(/\b164dea1b[0-9a-f]{56}\b/);
  const notesShaMatch = hardwareNotes.match(/\b164dea1b[0-9a-f]{56}\b/);
  assert.ok(shotShaMatch, "SHOT_LIST.md must include full 64-hex APK sha256 starting with 164dea1b");
  assert.ok(notesShaMatch, "HARDWARE_NOTES.md must include full 64-hex APK sha256 starting with 164dea1b");
  assert.equal(shotShaMatch[0], notesShaMatch[0]);

  for (const doc of [
    { name: "HARDWARE_LOG.md", text: hardwareLog },
    { name: "SHOT_LIST.md", text: shotList },
    { name: "DEMO_SCRIPT.md", text: demoScript },
  ]) {
    assert.match(doc.text, /Amlodipine/i, `${doc.name} must mention Amlodipine`);
    assert.match(doc.text, /Ibuprofen/i, `${doc.name} must mention Ibuprofen`);
    assert.match(doc.text, /NSAID/, `${doc.name} must mention NSAID warning`);
    assert.match(doc.text, /already taken today/, `${doc.name} must mention double-dose warning`);
    assert.match(doc.text, /NOT SURE/, `${doc.name} must mention NOT SURE verdict`);
  }

  for (const doc of [
    { name: "SHOT_LIST.md", text: shotList },
    { name: "DEMO_SCRIPT.md", text: demoScript },
  ]) {
    assert.ok(doc.text.includes("/api/health"), `${doc.name} must check /api/health`);
    assert.ok(doc.text.includes("/hud/"), `${doc.name} must include /hud/ with trailing slash`);
    assert.ok(doc.text.includes("Hold it up."), `${doc.name} must verify HUD idle copy`);
    assert.ok(doc.text.includes("HOLDUP_KEY"), `${doc.name} must document HOLDUP_KEY`);
    assert.match(doc.text, /airplane mode/i, `${doc.name} must document airplane mode resilience beat`);
  }

  assertHardwareLogUnchanged();
  // The check above is what matters: this test run must not change the log. A `git diff` assertion was removed
  // here: it failed in a zip download (no .git) and whenever the hardware session had just appended real rows.
  const gitStatus = await execFileAsync("git", ["status", "--porcelain", "--", "docs/HARDWARE_LOG.md"]);
  assert.equal(gitStatus.code, 0);
  assert.equal(gitStatus.stdout, "");
});
