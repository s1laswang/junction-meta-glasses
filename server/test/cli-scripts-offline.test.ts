import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { env, REPO_ROOT, SERVER_DIR } from "../src/env.ts";

const REAL_REPO_ROOT = fs.realpathSync(REPO_ROOT);
const REAL_SERVER_DIR = fs.realpathSync(SERVER_DIR);
const GEMINI_MODULE_HREF = pathToFileURL(path.join(REAL_SERVER_DIR, "src", "gemini.ts")).href;
const ONNX_MODEL_PATH = path.join(REAL_REPO_ROOT, "web", "public", "models", "fieldspotter.onnx");
const WORKSPACE_LEDGER_PATH = path.join(REAL_SERVER_DIR, "logs", "ledger.jsonl");
const TMP_BASE = fs.existsSync("/dev/shm") ? "/dev/shm" : os.tmpdir();

const origLedgerPath = env.ledgerPath;
after(() => {
  env.ledgerPath = origLedgerPath;
});

const FIXTURE_AMLODIPINE = path.join(REAL_SERVER_DIR, "fixtures", "amlodipine.jpg");
const FIXTURE_AMLODIPINE_COVERED = path.join(REAL_SERVER_DIR, "fixtures", "amlodipine_covered.jpg");
const FIXTURE_THREE_BOXES = path.join(REAL_SERVER_DIR, "fixtures", "three_boxes.jpg");

const ONE_BY_ONE_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function withTempDir<T>(fn: (tmpDir: string) => Promise<T>): Promise<T> {
  const tmpDir = fs.mkdtempSync(path.join(TMP_BASE, "holdup-cli-offline-"));
  return Promise.resolve()
    .then(() => fn(tmpDir))
    .finally(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      assert.equal(fs.existsSync(tmpDir), false);
    });
}

type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

function runNode(args: string[], envOverrides: Record<string, string>): Promise<RunResult> {
  assert.ok(envOverrides.LEDGER_PATH, "LEDGER_PATH override is required");
  assert.notEqual(path.resolve(envOverrides.LEDGER_PATH), WORKSPACE_LEDGER_PATH);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: REAL_REPO_ROOT,
      env: {
        ...process.env,
        GEMINI_API_KEY: "",
        GOOGLE_GENERATIVE_AI_API_KEY: "",
        ELEVENLABS_API_KEY: "",
        HOLDUP_QUIET: "1",
        ...envOverrides,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`child process timed out: ${args.join(" ")}`));
    }, 30_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

type StubSpec =
  | { mode: "json"; payload: unknown; promptTokens?: number; candidateTokens?: number }
  | { mode: "raw"; response: unknown }
  | { mode: "error"; status: number; message: string };

type CapturedCall = {
  model: string;
  contents: unknown;
  responseMimeType: string | null;
  hasSchema: boolean;
  aspectRatio: string | null;
};

const PRELOAD_SOURCE = [
  'import fs from "node:fs";',
  'globalThis.fetch = async () => { throw new Error("unexpected_network_fetch_in_offline_cli_test"); };',
  "const geminiHref = process.env.HOLDUP_TEST_GEMINI_HREF;",
  "const stubFile = process.env.HOLDUP_TEST_STUB_FILE;",
  "const captureFile = process.env.HOLDUP_TEST_CAPTURE_FILE;",
  "const { ai } = await import(geminiHref);",
  "ai.models.generateContent = async (req) => {",
  "  if (captureFile) {",
  "    const entry = {",
  "      model: req?.model ?? null,",
  "      contents: req?.contents ?? null,",
  "      responseMimeType: req?.config?.responseMimeType ?? null,",
  "      hasSchema: Boolean(req?.config?.responseJsonSchema),",
  "      aspectRatio: req?.config?.imageConfig?.aspectRatio ?? null,",
  "    };",
  '    fs.appendFileSync(captureFile, JSON.stringify(entry) + "\\n");',
  "  }",
  '  const spec = JSON.parse(fs.readFileSync(stubFile, "utf8"));',
  '  if (spec.mode === "error") {',
  "    const err = new Error(spec.message);",
  "    Object.assign(err, { status: spec.status });",
  "    throw err;",
  "  }",
  '  if (spec.mode === "raw") {',
  "    return spec.response;",
  "  }",
  "  return {",
  "    text: JSON.stringify(spec.payload),",
  "    usageMetadata: {",
  "      promptTokenCount: spec.promptTokens ?? 100,",
  "      candidatesTokenCount: spec.candidateTokens ?? 40,",
  "    },",
  "  };",
  "};",
].join("\n");

async function runStubbedScript(
  tmpDir: string,
  scriptName: string,
  scriptArgs: string[],
  stub: StubSpec,
  extraEnv: Record<string, string> = {},
): Promise<{ res: RunResult; calls: CapturedCall[]; ledgerRows: Record<string, unknown>[] }> {
  const runId = `${scriptName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const preloadPath = path.join(tmpDir, `${runId}-preload.mjs`);
  const stubPath = path.join(tmpDir, `${runId}-stub.json`);
  const capturePath = path.join(tmpDir, `${runId}-capture.jsonl`);
  const ledgerPath = path.join(tmpDir, `${runId}-ledger.jsonl`);

  fs.writeFileSync(preloadPath, PRELOAD_SOURCE, "utf8");
  fs.writeFileSync(stubPath, JSON.stringify(stub), "utf8");

  const scriptPath = path.join(REAL_SERVER_DIR, "scripts", scriptName);
  const res = await runNode(
    ["--import", "tsx", "--import", pathToFileURL(preloadPath).href, scriptPath, ...scriptArgs],
    {
      LEDGER_PATH: ledgerPath,
      HOLDUP_TEST_GEMINI_HREF: GEMINI_MODULE_HREF,
      HOLDUP_TEST_STUB_FILE: stubPath,
      HOLDUP_TEST_CAPTURE_FILE: capturePath,
      ...extraEnv,
    },
  );

  const calls: CapturedCall[] = fs.existsSync(capturePath)
    ? fs
        .readFileSync(capturePath, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as CapturedCall)
    : [];

  const ledgerRows: Record<string, unknown>[] = fs.existsSync(ledgerPath)
    ? fs
        .readFileSync(ledgerPath, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : [];

  return { res, calls, ledgerRows };
}

type ParsedSpotBox = {
  label: string;
  score: number;
  box: [number, number, number, number];
};

function parseSpotTryLine(line: string): {
  file: string;
  w: number;
  h: number;
  p50Ms: number;
  boxes: ParsedSpotBox[];
} {
  const m = /^(\S+) (\d+)x(\d+) p50 (\d+) ms (\[.*\])$/.exec(line.trim());
  assert.ok(m, `unexpected spot-try output line: ${line}`);
  const rawBoxes = JSON.parse(m[5]) as unknown[];
  assert.ok(Array.isArray(rawBoxes));
  const boxes = rawBoxes.map((entry) => {
    assert.equal(typeof entry, "string");
    const bm = /^(product|strength|expiry|allergens) (\d+(?:\.\d+)?) \[(\d+),(\d+),(\d+),(\d+)\]$/.exec(
      entry as string,
    );
    assert.ok(bm, `unexpected spot-try box entry: ${String(entry)}`);
    const score = Number(bm[2]);
    const ymin = Number(bm[3]);
    const xmin = Number(bm[4]);
    const ymax = Number(bm[5]);
    const xmax = Number(bm[6]);
    assert.ok(score >= 0.4 && score <= 1, `score out of range: ${score}`);
    for (const coord of [ymin, xmin, ymax, xmax]) {
      assert.ok(Number.isInteger(coord) && coord >= 0 && coord <= 1000, `coord out of range: ${coord}`);
    }
    assert.ok(ymin <= ymax && xmin <= xmax, `inverted box bounds: ${String(entry)}`);
    return { label: bm[1], score, box: [ymin, xmin, ymax, xmax] as [number, number, number, number] };
  });
  return {
    file: m[1],
    w: Number(m[2]),
    h: Number(m[3]),
    p50Ms: Number(m[4]),
    boxes,
  };
}

test("spot-try.ts runs offline with fieldspotter.onnx on explicit fixtures and distinguishes full vs covered dose boxes", async () => {
  assert.equal(fs.existsSync(ONNX_MODEL_PATH), true);
  await withTempDir(async (tmpDir) => {
    const scriptPath = path.join(REAL_SERVER_DIR, "scripts", "spot-try.ts");
    const res = await runNode(
      ["--import", "tsx", scriptPath, FIXTURE_AMLODIPINE, FIXTURE_AMLODIPINE_COVERED],
      { LEDGER_PATH: path.join(tmpDir, "ledger.jsonl") },
    );
    assert.equal(res.code, 0, `spot-try.ts failed: ${res.stderr}`);
    const lines = res.stdout.trim().split(/\r?\n/).filter(Boolean);
    assert.equal(lines.length, 2);

    const clear = parseSpotTryLine(lines[0]);
    assert.equal(clear.file, "amlodipine.jpg");
    assert.equal(clear.w, 768);
    assert.equal(clear.h, 768);
    assert.ok(Number.isInteger(clear.p50Ms) && clear.p50Ms >= 0);
    const clearProduct = clear.boxes.find((b) => b.label === "product");
    const clearStrength = clear.boxes.find((b) => b.label === "strength");
    assert.ok(clearProduct && clearProduct.score >= 0.75, "expected product box on amlodipine.jpg");
    assert.ok(clearStrength && clearStrength.score >= 0.75, "expected strength box on amlodipine.jpg");

    const covered = parseSpotTryLine(lines[1]);
    assert.equal(covered.file, "amlodipine_covered.jpg");
    assert.equal(covered.w, 768);
    assert.equal(covered.h, 768);
    assert.ok(Number.isInteger(covered.p50Ms) && covered.p50Ms >= 0);
    const coveredProduct = covered.boxes.find((b) => b.label === "product");
    const coveredHighStrength = covered.boxes.find((b) => b.label === "strength" && b.score >= 0.8);
    assert.ok(coveredProduct && coveredProduct.score >= 0.7, "expected product box on amlodipine_covered.jpg");
    assert.equal(coveredHighStrength, undefined, "expected no high-confidence strength box on amlodipine_covered.jpg");

    const defaultRes = await runNode(["--import", "tsx", scriptPath], {
      LEDGER_PATH: path.join(tmpDir, "ledger-default.jsonl"),
    });
    assert.equal(defaultRes.code, 0, `spot-try.ts default failed: ${defaultRes.stderr}`);
    const defaultLines = defaultRes.stdout.trim().split(/\r?\n/).filter(Boolean);
    assert.equal(defaultLines.length, 3);
    const parsedDefaults = defaultLines.map(parseSpotTryLine);
    assert.deepEqual(
      parsedDefaults.map((d) => `${d.file}:${d.w}x${d.h}`),
      ["amlodipine.jpg:768x768", "three_boxes.jpg:768x768", "dm_amlodipine.jpg:660x100"],
    );
  });
});

test("spot-time.ts runs offline and reports non-negative integer timings for jpeg decode, letterbox, and threads 1, 2, 4", async () => {
  assert.equal(fs.existsSync(ONNX_MODEL_PATH), true);
  await withTempDir(async (tmpDir) => {
    const scriptPath = path.join(REAL_SERVER_DIR, "scripts", "spot-time.ts");
    const res = await runNode(["--import", "tsx", scriptPath], {
      LEDGER_PATH: path.join(tmpDir, "ledger.jsonl"),
    });
    assert.equal(res.code, 0, `spot-time.ts failed: ${res.stderr}`);

    const lines = res.stdout.trim().split(/\r?\n/).filter(Boolean);
    assert.equal(lines.length, 5, `expected 5 timing lines, got: ${res.stdout}`);

    const expectedPatterns: RegExp[] = [
      /^jpeg decode ms (\d+)$/,
      /^letterbox ms (\d+)$/,
      /^inference ms \(threads=1\) (\d+)$/,
      /^inference ms \(threads=2\) (\d+)$/,
      /^inference ms \(threads=4\) (\d+)$/,
    ];

    for (let i = 0; i < expectedPatterns.length; i++) {
      const match = expectedPatterns[i].exec(lines[i]);
      assert.ok(match, `line ${i} did not match ${String(expectedPatterns[i])}: "${lines[i]}"`);
      const ms = Number(match[1]);
      assert.ok(Number.isInteger(ms) && ms >= 0, `expected non-negative integer ms on line ${i}, got ${ms}`);
    }
  });
});

test("verify-file.ts handles evening match, morning wrong-slot warning, and keyless reader failure without network calls", async () => {
  await withTempDir(async (tmpDir) => {
    const amlodipineRead = {
      kind: "medication",
      product: { value: "Amlodipin Orion", confidence: 0.96 },
      ingredient: { value: "amlodipine", confidence: 0.97 },
      strength: { value: "5 mg", confidence: 0.95 },
      dosing: { value: null, confidence: 0 },
      expiry: { value: "2028-06", confidence: 0.92 },
      allergens: { value: null, confidence: 0 },
      barcode: { value: null, confidence: 0 },
      readability: 0.94,
    };

    const evening = await runStubbedScript(
      tmpDir,
      "verify-file.ts",
      [FIXTURE_AMLODIPINE, "--", "Is this my evening pill?"],
      { mode: "json", payload: amlodipineRead, promptTokens: 140, candidateTokens: 52 },
    );
    assert.equal(evening.res.code, 0, `verify-file.ts evening failed: ${evening.res.stderr}`);
    const eveningOut = JSON.parse(evening.res.stdout.trim()) as {
      model: string | null;
      ms: number;
      level: string;
      headline: string;
      speech: string;
      strength: { value: string | null; confidence: number };
      product: { value: string | null; confidence: number };
      readability: number;
    };
    assert.equal(eveningOut.model, "gemini-3.8-flash");
    assert.ok(typeof eveningOut.ms === "number" && eveningOut.ms >= 0);
    assert.equal(eveningOut.level, "match");
    assert.equal(eveningOut.headline, "Yes: Amlodipine 5 mg, your evening pill");
    assert.ok(eveningOut.speech.startsWith("Yes, Amlodipine 5 mg, your evening pill"));
    assert.ok(eveningOut.speech.includes("You haven't taken it today."));
    assert.deepEqual(eveningOut.strength, { value: "5 mg", confidence: 0.95 });
    assert.deepEqual(eveningOut.product, { value: "Amlodipin Orion", confidence: 0.96 });
    assert.equal(eveningOut.readability, 0.94);

    assert.equal(evening.calls.length, 1);
    assert.equal(evening.calls[0].model, "gemini-3.8-flash");
    assert.equal(evening.calls[0].responseMimeType, "application/json");
    assert.equal(evening.calls[0].hasSchema, true);
    const eveningParts = (evening.calls[0].contents as { parts: Record<string, unknown>[] }[])[0].parts;
    assert.equal(eveningParts.length, 2);
    assert.equal((eveningParts[0].inlineData as { mimeType: string }).mimeType, "image/jpeg");
    assert.equal(eveningParts[1].text, 'The person asked: "Is this my evening pill?"');
    assert.equal(evening.ledgerRows.length, 1);
    assert.equal(evening.ledgerRows[0].feature, "verify");
    assert.equal(evening.ledgerRows[0].ok, true);
    assert.equal(evening.ledgerRows[0].n_frames, 1);

    const morning = await runStubbedScript(
      tmpDir,
      "verify-file.ts",
      [FIXTURE_AMLODIPINE, "--", "Is this my morning pill?"],
      { mode: "json", payload: amlodipineRead },
    );
    assert.equal(morning.res.code, 0, `verify-file.ts morning failed: ${morning.res.stderr}`);
    const morningOut = JSON.parse(morning.res.stdout.trim()) as {
      model: string | null;
      level: string;
      headline: string;
      speech: string;
      strength: { value: string | null; confidence: number };
      product: { value: string | null; confidence: number };
    };
    assert.equal(morningOut.model, "gemini-3.8-flash");
    assert.equal(morningOut.level, "warning");
    assert.equal(morningOut.headline, "Amlodipine: not your morning pill");
    assert.match(morningOut.speech, /evening medicine, not your morning one/i);
    assert.deepEqual(morningOut.strength, { value: "5 mg", confidence: 0.95 });
    assert.deepEqual(morningOut.product, { value: "Amlodipin Orion", confidence: 0.96 });

    const failing = await runStubbedScript(
      tmpDir,
      "verify-file.ts",
      [FIXTURE_AMLODIPINE, FIXTURE_AMLODIPINE_COVERED],
      { mode: "error", status: 400, message: "API key not valid" },
      { GEMINI_API_KEY: "" },
    );
    assert.equal(failing.res.code, 0, `verify-file.ts failing-reader exited non-zero: ${failing.res.stderr}`);
    const failOut = JSON.parse(failing.res.stdout.trim()) as {
      model: string | null;
      level: string;
      headline: string;
      speech: string;
      strength: { value: string | null; confidence: number };
      product: { value: string | null; confidence: number };
      readability: number;
      guidance?: string;
    };
    assert.equal(failOut.model, null);
    assert.equal(failOut.level, "unsure");
    assert.equal(failOut.headline, "Can't read the label yet");
    assert.deepEqual(failOut.strength, { value: null, confidence: 0 });
    assert.deepEqual(failOut.product, { value: null, confidence: 0 });
    assert.equal(failOut.readability, 0);
    assert.equal(failOut.guidance, "I couldn't reach the reader. Try again in a moment.");
    assert.equal(failing.calls.length, 3);
    const failParts = (failing.calls[0].contents as { parts: Record<string, unknown>[] }[])[0].parts;
    assert.equal(failParts.length, 3);
    assert.equal(failParts[2].text, "Read this label.");
    assert.equal(failing.ledgerRows.length, 3);
    for (const row of failing.ledgerRows) {
      assert.equal(row.feature, "verify");
      assert.equal(row.ok, false);
      assert.equal(row.error, "bad_request");
    }
  });
});

test("find-file.ts outputs JSON scene summary and left-to-right spatial item lines for three_boxes.jpg", async () => {
  await withTempDir(async (tmpDir) => {
    const scenePayload = {
      items: [
        {
          box_2d: [215, 690, 745, 940],
          answers_target: true,
          read: {
            kind: "medication",
            product: { value: "Amlodipin Orion", confidence: 0.96 },
            ingredient: { value: "amlodipine", confidence: 0.98 },
            strength: { value: "5 mg", confidence: 0.96 },
            dosing: { value: null, confidence: 0 },
            expiry: { value: "2028-06", confidence: 0.91 },
            allergens: { value: null, confidence: 0 },
            barcode: { value: null, confidence: 0 },
            readability: 0.95,
          },
        },
        {
          box_2d: [220, 60, 740, 310],
          answers_target: false,
          read: {
            kind: "medication",
            product: { value: "Panadol", confidence: 0.95 },
            ingredient: { value: "paracetamol", confidence: 0.96 },
            strength: { value: "500 mg", confidence: 0.95 },
            dosing: { value: null, confidence: 0 },
            expiry: { value: "2027-12", confidence: 0.9 },
            allergens: { value: null, confidence: 0 },
            barcode: { value: null, confidence: 0 },
            readability: 0.93,
          },
        },
        {
          box_2d: [210, 370, 750, 630],
          answers_target: false,
          read: {
            kind: "medication",
            product: { value: "Burana", confidence: 0.96 },
            ingredient: { value: "ibuprofen", confidence: 0.97 },
            strength: { value: "400 mg", confidence: 0.95 },
            dosing: { value: null, confidence: 0 },
            expiry: { value: "2027-09", confidence: 0.9 },
            allergens: { value: null, confidence: 0 },
            barcode: { value: null, confidence: 0 },
            readability: 0.94,
          },
        },
      ],
    };

    const { res, calls, ledgerRows } = await runStubbedScript(
      tmpDir,
      "find-file.ts",
      [FIXTURE_THREE_BOXES, "which one is my evening pill?"],
      { mode: "json", payload: scenePayload },
    );
    assert.equal(res.code, 0, `find-file.ts failed: ${res.stderr}`);

    const lines = res.stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
    assert.equal(lines.length, 4, `expected 1 summary + 3 item lines, got: ${res.stdout}`);

    const summary = JSON.parse(lines[0]) as {
      model: string | null;
      ms: number;
      level: string;
      headline: string;
      speech: string;
    };
    assert.equal(summary.model, "gemini-3.8-flash");
    assert.ok(typeof summary.ms === "number" && summary.ms >= 0);
    assert.equal(summary.level, "match");
    assert.equal(summary.headline, "Evening pill: box on the right");
    assert.equal(
      summary.speech,
      "Your evening pill is the box on the right. The middle one is Ibuprofen 400 mg, not on your list.",
    );

    assert.equal(
      lines[1],
      '  left match "Paracetamol 500 mg: on list" [220,60,740,310] name=paracetamol@0.96 strength=500 mg@0.95 readability=0.93',
    );
    assert.equal(
      lines[2],
      '  center warning "Ibuprofen 400 mg: not on list" [210,370,750,630] name=ibuprofen@0.97 strength=400 mg@0.95 readability=0.94',
    );
    assert.equal(
      lines[3],
      '  right match "Amlodipine 5 mg: evening pill" [215,690,745,940] name=amlodipine@0.98 strength=5 mg@0.96 readability=0.95',
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].responseMimeType, "application/json");
    assert.equal(calls[0].hasSchema, true);
    const parts = (calls[0].contents as { parts: Record<string, unknown>[] }[])[0].parts;
    assert.equal(parts.length, 2);
    assert.equal((parts[0].inlineData as { mimeType: string }).mimeType, "image/jpeg");
    assert.equal(parts[1].text, 'The person asked: "which one is my evening pill?"');
    assert.equal(ledgerRows.length, 1);
    assert.equal(ledgerRows[0].feature, "find");
    assert.equal(ledgerRows[0].ok, true);

    const untargeted = await runStubbedScript(
      tmpDir,
      "find-file.ts",
      [FIXTURE_THREE_BOXES],
      { mode: "json", payload: scenePayload },
    );
    assert.equal(untargeted.res.code, 0, `find-file.ts untargeted failed: ${untargeted.res.stderr}`);
    const untargetedLines = untargeted.res.stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
    assert.equal(untargetedLines.length, 4);
    const untargetedSummary = JSON.parse(untargetedLines[0]) as { level: string; headline: string };
    assert.equal(untargetedSummary.level, "info");
    assert.equal(untargetedSummary.headline, "3 packages seen");
    const untargetedParts = (untargeted.calls[0].contents as { parts: Record<string, unknown>[] }[])[0].parts;
    assert.equal(untargetedParts[1].text, "Describe which package is which.");

    const failedFind = await runStubbedScript(
      tmpDir,
      "find-file.ts",
      [FIXTURE_THREE_BOXES, "which one is my evening pill?"],
      { mode: "error", status: 400, message: "API key not valid" },
    );
    assert.equal(failedFind.res.code, 0);
    const failedLines = failedFind.res.stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
    assert.equal(failedLines.length, 1);
    const failedSummary = JSON.parse(failedLines[0]) as { model: string | null; level: string; speech: string };
    assert.equal(failedSummary.model, null);
    assert.equal(failedSummary.level, "unsure");
    assert.match(failedSummary.speech, /couldn't check the table/i);
  });
});

test("make-fixture.ts writes decoded PNG when inlineData is returned and exits 1 when candidates are empty", async () => {
  await withTempDir(async (tmpDir) => {
    const outPng = path.join(tmpDir, "synthetic-box.png");
    const promptText = "Finnish pharmacy box of Amlodipine 5 mg on wooden table";

    const okRun = await runStubbedScript(
      tmpDir,
      "make-fixture.ts",
      [outPng, promptText],
      {
        mode: "raw",
        response: {
          candidates: [
            {
              content: {
                parts: [
                  { text: "generated fixture" },
                  { inlineData: { data: ONE_BY_ONE_PNG_B64, mimeType: "image/png" } },
                ],
              },
            },
          ],
        },
      },
    );
    assert.equal(okRun.res.code, 0, `make-fixture.ts failed: ${okRun.res.stderr}`);
    assert.equal(okRun.res.stdout.trim(), `wrote ${outPng} image/png`);
    assert.equal(fs.existsSync(outPng), true);

    const written = fs.readFileSync(outPng);
    assert.deepEqual(Buffer.compare(written, Buffer.from(ONE_BY_ONE_PNG_B64, "base64")), 0);
    assert.deepEqual([...written.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(written.readUInt32BE(16), 1);
    assert.equal(written.readUInt32BE(20), 1);

    assert.equal(okRun.calls.length, 1);
    assert.equal(okRun.calls[0].model, "gemini-3.1-flash-image");
    assert.equal(okRun.calls[0].contents, promptText);
    assert.equal(okRun.calls[0].aspectRatio, "1:1");

    const missingOut = path.join(tmpDir, "should-not-exist.png");
    const emptyRun = await runStubbedScript(
      tmpDir,
      "make-fixture.ts",
      [missingOut, promptText],
      { mode: "raw", response: { candidates: [] } },
      { IMAGE_MODEL: "custom-image-model-test" },
    );
    assert.equal(emptyRun.res.code, 1);
    assert.equal(emptyRun.res.stdout.trim(), "no image returned");
    assert.equal(fs.existsSync(missingOut), false);
    assert.equal(emptyRun.calls.length, 1);
    assert.equal(emptyRun.calls[0].model, "custom-image-model-test");

    const textOnlyOut = path.join(tmpDir, "text-only-should-not-exist.png");
    const textOnlyRun = await runStubbedScript(
      tmpDir,
      "make-fixture.ts",
      [textOnlyOut, promptText],
      {
        mode: "raw",
        response: { candidates: [{ content: { parts: [{ text: "refused image generation" }] } }] },
      },
    );
    assert.equal(textOnlyRun.res.code, 1);
    assert.equal(textOnlyRun.res.stdout.trim(), "no image returned");
    assert.equal(fs.existsSync(textOnlyOut), false);
  });
});
