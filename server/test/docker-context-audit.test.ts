import assert from "node:assert/strict";
import fs from "node:fs";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { env, REPO_ROOT } from "../src/env.ts";
import { ai } from "../src/gemini.ts";
import { resetHubsForTest } from "../src/hub.ts";
import { startServer } from "../src/index.ts";

process.env.HOLDUP_QUIET = "1";

const SLASH = String.fromCharCode(47);
const STAR = String.fromCharCode(42);
const HASH_CHAR = String.fromCharCode(35);
const EM_DASH = String.fromCharCode(0x2014);
const GLOBSTAR = STAR + STAR;
const GLOBSTAR_SLASH = GLOBSTAR + SLASH;
const SLASH_GLOBSTAR = SLASH + GLOBSTAR;
const SLASH_GLOBSTAR_SLASH = SLASH + GLOBSTAR + SLASH;
const TEMP_PREFIX = `holdup-docker-stage-${process.pid}-`;

const BUILD_GENERATED_ARTIFACTS = new Set(["node_modules", "web/dist"]);

interface DockerStage {
  name: string;
  lines: string[];
}

interface BuildCopySpec {
  sources: string[];
  dest: string;
}

interface RuntimeCopySpec {
  fromStage: string;
  srcPath: string;
  destPath: string;
  relPath: string;
}

interface DockerignoreRule {
  pattern: string;
  negated: boolean;
  regex: RegExp;
}

interface DockerignoreMatcher {
  rules: DockerignoreRule[];
  ignores: (relPath: string) => boolean;
}

function toPosixRel(rawPath: string): string {
  let normalized = rawPath.split(path.sep).join(SLASH).trim();
  while (normalized.startsWith(`.${SLASH}`)) {
    normalized = normalized.slice(2);
  }
  while (normalized.startsWith(SLASH)) {
    normalized = normalized.slice(1);
  }
  while (normalized.length > 1 && normalized.endsWith(SLASH)) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function escapeRegexChar(ch: string): string {
  return ".+^${}()|[]\\".includes(ch) ? `\\${ch}` : ch;
}

function compileDockerignoreRegex(rawPattern: string): RegExp {
  let pat = rawPattern;
  let out = "^";
  if (pat.startsWith(GLOBSTAR_SLASH)) {
    out += `(?:.+${SLASH})?`;
    pat = pat.slice(GLOBSTAR_SLASH.length);
  }
  let idx = 0;
  while (idx < pat.length) {
    if (pat.startsWith(SLASH_GLOBSTAR_SLASH, idx)) {
      out += `(?:${SLASH}.*)?${SLASH}`;
      idx += SLASH_GLOBSTAR_SLASH.length;
    } else if (pat.startsWith(SLASH_GLOBSTAR, idx) && idx + SLASH_GLOBSTAR.length === pat.length) {
      out += `(?:${SLASH}.*)?`;
      idx += SLASH_GLOBSTAR.length;
    } else if (pat.startsWith(GLOBSTAR, idx)) {
      out += ".*";
      idx += GLOBSTAR.length;
    } else if (pat[idx] === STAR) {
      out += `[^${SLASH}]*`;
      idx += 1;
    } else if (pat[idx] === "?") {
      out += `[^${SLASH}]`;
      idx += 1;
    } else {
      out += escapeRegexChar(pat[idx]);
      idx += 1;
    }
  }
  out += `(?:${SLASH}.*)?$`;
  return new RegExp(out);
}

function parseDockerignore(source: string): DockerignoreMatcher {
  const rules: DockerignoreRule[] = [];
  for (const rawLine of source.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith(HASH_CHAR)) continue;
    const negated = trimmed.startsWith("!");
    const body = toPosixRel(negated ? trimmed.slice(1) : trimmed);
    if (!body) continue;
    rules.push({
      pattern: body,
      negated,
      regex: compileDockerignoreRegex(body),
    });
  }
  return {
    rules,
    ignores(relPath: string): boolean {
      const target = toPosixRel(relPath);
      if (!target) return false;
      let ignored = false;
      for (const rule of rules) {
        if (rule.regex.test(target)) {
          ignored = !rule.negated;
        }
      }
      return ignored;
    },
  };
}

function parseDockerfileStages(source: string): DockerStage[] {
  const stages: DockerStage[] = [];
  let current: DockerStage | null = null;
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(HASH_CHAR)) continue;
    const fromMatch = /^FROM\s+\S+(?:\s+AS\s+([A-Za-z0-9_-]+))?$/i.exec(line);
    if (fromMatch) {
      current = { name: fromMatch[1] ?? `stage_${stages.length}`, lines: [] };
      stages.push(current);
      continue;
    }
    if (current) {
      current.lines.push(line);
    }
  }
  return stages;
}

function parseBuildStageCopies(stage: DockerStage): BuildCopySpec[] {
  const specs: BuildCopySpec[] = [];
  for (const line of stage.lines) {
    if (!line.startsWith("COPY ")) continue;
    const tokens = line.slice(5).trim().split(/\s+/);
    const flags = tokens.filter((t) => t.startsWith("--"));
    if (flags.some((f) => f.startsWith("--from="))) continue;
    const args = tokens.filter((t) => !t.startsWith("--"));
    assert.ok(args.length >= 2, `Expected COPY <src...> <dest> in build stage: ${line}`);
    specs.push({
      sources: args.slice(0, -1),
      dest: args[args.length - 1],
    });
  }
  return specs;
}

function parseRuntimeStageCopies(stage: DockerStage): RuntimeCopySpec[] {
  const specs: RuntimeCopySpec[] = [];
  for (const line of stage.lines) {
    if (!line.startsWith("COPY ")) continue;
    const tokens = line.slice(5).trim().split(/\s+/);
    const flags = tokens.filter((t) => t.startsWith("--"));
    const fromFlag = flags.find((f) => f.startsWith("--from="));
    assert.ok(fromFlag, `Expected every runtime COPY to specify --from=build, got: ${line}`);
    const fromStage = fromFlag.slice("--from=".length);
    const args = tokens.filter((t) => !t.startsWith("--"));
    assert.equal(args.length, 2, `Expected exact COPY --from=build <src> <dest>, got: ${line}`);
    const [srcPath, destPath] = args;
    assert.ok(srcPath.startsWith("/app/"), `Expected /app/ source prefix in runtime COPY: ${line}`);
    const srcRel = toPosixRel(srcPath.slice("/app/".length));
    const destRel = destPath.startsWith("/app/")
      ? toPosixRel(destPath.slice("/app/".length))
      : toPosixRel(destPath);
    assert.ok(srcRel.length > 0 && !srcRel.split(SLASH).includes(".."), `Unsafe srcRel in ${line}`);
    assert.equal(destRel, srcRel, `Expected runtime COPY source and destination relative paths to match: ${line}`);
    specs.push({ fromStage, srcPath, destPath, relPath: destRel });
  }
  return specs;
}

function parseRuntimeMkdirDirs(stage: DockerStage): string[] {
  const dirs: string[] = [];
  for (const line of stage.lines) {
    if (!line.startsWith("RUN ")) continue;
    const mkdirSeg = /mkdir\s+-p\s+([^&;]+)/.exec(line);
    if (!mkdirSeg) continue;
    for (const token of mkdirSeg[1].trim().split(/\s+/)) {
      if (token.startsWith("/app/")) {
        const rel = toPosixRel(token.slice("/app/".length));
        if (rel && !rel.split(SLASH).includes("..")) {
          dirs.push(rel);
        }
      }
    }
  }
  return dirs;
}

function copyFilteredFromContext(
  sourceRoot: string,
  targetRoot: string,
  relPosix: string,
  matcher: DockerignoreMatcher,
): void {
  const cleanRel = toPosixRel(relPosix);
  if (matcher.ignores(cleanRel)) return;
  const srcFull = path.join(sourceRoot, ...cleanRel.split(SLASH));
  const dstFull = path.join(targetRoot, ...cleanRel.split(SLASH));
  assert.ok(fs.existsSync(srcFull), `Missing required runtime source path on disk: ${cleanRel}`);
  const stat = fs.statSync(srcFull);
  if (stat.isDirectory()) {
    fs.mkdirSync(dstFull, { recursive: true });
    for (const entry of fs.readdirSync(srcFull)) {
      copyFilteredFromContext(sourceRoot, targetRoot, `${cleanRel}${SLASH}${entry}`, matcher);
    }
  } else if (stat.isFile()) {
    fs.mkdirSync(path.dirname(dstFull), { recursive: true });
    fs.copyFileSync(srcFull, dstFull);
  }
}

function synthesizeMinimalWebDist(sourceRoot: string, distTarget: string, matcher: DockerignoreMatcher): void {
  fs.mkdirSync(distTarget, { recursive: true });
  const webIndexSrc = path.join(sourceRoot, "web", "index.html");
  if (fs.existsSync(webIndexSrc) && !matcher.ignores("web/index.html")) {
    fs.copyFileSync(webIndexSrc, path.join(distTarget, "index.html"));
  } else {
    const fallbackHtml =
      "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><link rel=\"manifest\" href=\"/manifest.webmanifest\"><title>HoldUp</title></head><body><div id=\"root\"></div></body></html>";
    fs.writeFileSync(path.join(distTarget, "index.html"), fallbackHtml, "utf8");
  }

  const copyPublicRel = (publicSubPath: string): void => {
    const repoRel = `web/public/${publicSubPath}`;
    if (matcher.ignores(repoRel)) return;
    const src = path.join(sourceRoot, "web", "public", ...publicSubPath.split(SLASH));
    if (!fs.existsSync(src)) return;
    const dst = path.join(distTarget, ...publicSubPath.split(SLASH));
    const st = fs.statSync(src);
    if (st.isDirectory()) {
      fs.mkdirSync(dst, { recursive: true });
      for (const child of fs.readdirSync(src)) {
        copyPublicRel(`${publicSubPath}/${child}`);
      }
    } else if (st.isFile()) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
  };

  for (const asset of [
    "manifest.webmanifest",
    "sw.js",
    "icon.svg",
    ".well-known/meta-wearables-manifest.json",
    "fixtures/amlodipine.jpg",
  ]) {
    copyPublicRel(asset);
  }
}

function stageCleanRuntimeDir(
  sourceRoot: string,
  cleanStageDir: string,
  runtimeCopies: RuntimeCopySpec[],
  runtimeMkdirs: string[],
  matcher: DockerignoreMatcher,
  opts?: { forceMinimalDist?: boolean; includeServerSourceTree?: boolean },
): { usedBuiltDist: boolean } {
  let usedBuiltDist = false;
  const includeServerTree = opts?.includeServerSourceTree ?? true;

  for (const copySpec of runtimeCopies) {
    assert.equal(copySpec.fromStage, "build");
    const rel = copySpec.relPath;
    if (rel === "node_modules") {
      const hostNodeModules = path.join(sourceRoot, "node_modules");
      if (fs.existsSync(hostNodeModules)) {
        fs.symlinkSync(hostNodeModules, path.join(cleanStageDir, "node_modules"), "dir");
      }
      continue;
    }
    if (rel === "web/dist") {
      const hostBuiltDist = path.join(sourceRoot, "web", "dist");
      const hostBuiltIndex = path.join(hostBuiltDist, "index.html");
      const targetDist = path.join(cleanStageDir, "web", "dist");
      if (!opts?.forceMinimalDist && fs.existsSync(hostBuiltIndex)) {
        fs.mkdirSync(path.dirname(targetDist), { recursive: true });
        fs.cpSync(hostBuiltDist, targetDist, { recursive: true });
        usedBuiltDist = true;
      } else {
        synthesizeMinimalWebDist(sourceRoot, targetDist, matcher);
      }
      continue;
    }
    if (rel === "server" && !includeServerTree) {
      copyFilteredFromContext(sourceRoot, cleanStageDir, "server/package.json", matcher);
      continue;
    }
    copyFilteredFromContext(sourceRoot, cleanStageDir, rel, matcher);
  }

  for (const dirRel of runtimeMkdirs) {
    fs.mkdirSync(path.join(cleanStageDir, ...dirRel.split(SLASH)), { recursive: true });
  }

  return { usedBuiltDist };
}

async function closeHttpServer(srv: http.Server | null): Promise<void> {
  if (!srv) return;
  srv.closeAllConnections();
  await new Promise<void>((resolve) => srv.close(() => resolve()));
}

test("Dockerfile COPY --from=build manifest and .dockerignore inclusion/exclusion invariants hold on disk", () => {
  const dockerfileRaw = fs.readFileSync(path.join(REPO_ROOT, "Dockerfile"), "utf8");
  const dockerignoreRaw = fs.readFileSync(path.join(REPO_ROOT, ".dockerignore"), "utf8");

  const stages = parseDockerfileStages(dockerfileRaw);
  assert.deepEqual(
    stages.map((s) => s.name),
    ["build", "runtime"],
  );

  const [buildStage, runtimeStage] = stages;
  const buildCopies = parseBuildStageCopies(buildStage);
  const runtimeCopies = parseRuntimeStageCopies(runtimeStage);
  const matcher = parseDockerignore(dockerignoreRaw);

  const runtimeRelPaths = runtimeCopies.map((c) => c.relPath);
  for (const requiredRuntimeArtifact of [
    "package.json",
    "shared",
    "server",
    "web/package.json",
    "web/dist",
    "docs",
    "deck",
    "eval/combined_summary.json",
  ]) {
    assert.ok(
      runtimeRelPaths.includes(requiredRuntimeArtifact),
      `Dockerfile runtime stage missing COPY --from=build for ${requiredRuntimeArtifact}`,
    );
  }

  for (const copySpec of runtimeCopies) {
    if (BUILD_GENERATED_ARTIFACTS.has(copySpec.relPath)) continue;
    assert.equal(
      matcher.ignores(copySpec.relPath),
      false,
      `.dockerignore must not exclude runtime artifact ${copySpec.relPath}`,
    );
    assert.equal(
      fs.existsSync(path.join(REPO_ROOT, ...copySpec.relPath.split(SLASH))),
      true,
      `Expected runtime artifact ${copySpec.relPath} to exist in workspace`,
    );
  }

  for (const buildSpec of buildCopies) {
    for (const src of buildSpec.sources) {
      if (src.includes(STAR)) continue;
      const cleanSrc = toPosixRel(src);
      assert.equal(
        matcher.ignores(cleanSrc),
        false,
        `.dockerignore must not exclude build-stage COPY input ${cleanSrc}`,
      );
      assert.equal(
        fs.existsSync(path.join(REPO_ROOT, ...cleanSrc.split(SLASH))),
        true,
        `Expected build-stage COPY input ${cleanSrc} to exist on disk`,
      );
    }
  }

  for (const requiredIncludedAsset of [
    "package.json",
    "shared/types.ts",
    "shared/label_schema.json",
    "shared/verify_prompt.md",
    "server/package.json",
    "server/src/index.ts",
    "server/src/prompts/live.md",
    "web/package.json",
    "web/index.html",
    "web/public/manifest.webmanifest",
    "web/public/sw.js",
    "web/public/icon.svg",
    "web/public/.well-known/meta-wearables-manifest.json",
    "web/public/fixtures/amlodipine.jpg",
    "deck/index.html",
    "deck/deck.css",
    "deck/deck.js",
    "docs/printable-props.html",
    "docs/judge-handout.html",
    "eval/combined_summary.json",
    ".env.example",
  ]) {
    assert.equal(
      matcher.ignores(requiredIncludedAsset),
      false,
      `.dockerignore must NOT exclude ${requiredIncludedAsset}`,
    );
  }

  for (const requiredExcludedPath of [
    ".env",
    ".env.local",
    ".env.production",
    ".git",
    ".git/HEAD",
    ".git/config",
    "eval/out",
    "eval/out/summary.json",
    "eval/synthetic",
    "eval/real/sample.jpg",
    "server/logs",
    "server/logs/ledger.jsonl",
  ]) {
    assert.equal(
      matcher.ignores(requiredExcludedPath),
      true,
      `.dockerignore MUST exclude ${requiredExcludedPath}`,
    );
  }
});

test("Clean-room Dockerfile runtime stage boots startServer(0) with GEMINI_API_KEY='' and serves all production routes end-to-end", async () => {
  const dockerfileRaw = fs.readFileSync(path.join(REPO_ROOT, "Dockerfile"), "utf8");
  const dockerignoreRaw = fs.readFileSync(path.join(REPO_ROOT, ".dockerignore"), "utf8");
  const stages = parseDockerfileStages(dockerfileRaw);
  const runtimeStage = stages[stages.length - 1];
  const runtimeCopies = parseRuntimeStageCopies(runtimeStage);
  const runtimeMkdirs = parseRuntimeMkdirDirs(runtimeStage);
  const matcher = parseDockerignore(dockerignoreRaw);

  const cleanStageDir = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  let server: http.Server | null = null;

  const prevApiKey = env.apiKey;
  const prevEnvKey = process.env.GEMINI_API_KEY;
  const prevLedgerPath = env.ledgerPath;
  const origModelsGet = ai.models.get.bind(ai.models);
  const origGenerateContent = ai.models.generateContent.bind(ai.models);
  let modelCalls = 0;

  try {
    stageCleanRuntimeDir(REPO_ROOT, cleanStageDir, runtimeCopies, runtimeMkdirs, matcher);

    for (const forbiddenRel of [
      ".env",
      ".git",
      "Dockerfile",
      ".dockerignore",
      "README.md",
      "android-dat",
      "scripts",
      "eval/out",
      "eval/synthetic",
      "web/src",
    ]) {
      assert.equal(
        fs.existsSync(path.join(cleanStageDir, ...forbiddenRel.split(SLASH))),
        false,
        `Clean runtime stage must not contain non-runtime path ${forbiddenRel}`,
      );
    }

    assert.deepEqual(
      fs.readdirSync(path.join(cleanStageDir, "eval")).sort(),
      ["combined_summary.json"],
      "Clean runtime stage eval/ directory must contain only combined_summary.json",
    );
    assert.deepEqual(
      fs.readdirSync(path.join(cleanStageDir, "web")).sort(),
      ["dist", "package.json"],
      "Clean runtime stage web/ directory must contain only dist and package.json",
    );
    assert.equal(fs.existsSync(path.join(cleanStageDir, "server", "logs")), true);
    assert.deepEqual(fs.readdirSync(path.join(cleanStageDir, "server", "logs")), []);

    for (const runtimeInternalAsset of [
      "package.json",
      "shared/types.ts",
      "shared/label_schema.json",
      "shared/verify_prompt.md",
      "server/package.json",
      "server/src/index.ts",
      "server/src/prompts/live.md",
      "web/dist/index.html",
      "web/dist/.well-known/meta-wearables-manifest.json",
      "web/dist/fixtures/amlodipine.jpg",
      "deck/index.html",
      "docs/printable-props.html",
      "docs/judge-handout.html",
      "eval/combined_summary.json",
    ]) {
      assert.equal(
        fs.existsSync(path.join(cleanStageDir, ...runtimeInternalAsset.split(SLASH))),
        true,
        `Clean runtime stage missing required file ${runtimeInternalAsset}`,
      );
    }

    process.env.GEMINI_API_KEY = "";
    env.apiKey = "";
    env.ledgerPath = path.join(cleanStageDir, "server", "logs", "ledger.jsonl");
    (ai.models as unknown as Record<string, unknown>).get = async () => {
      modelCalls++;
      throw new Error("Unexpected ai.models.get call in clean-room audit");
    };
    (ai.models as unknown as Record<string, unknown>).generateContent = async () => {
      modelCalls++;
      throw new Error("Unexpected ai.models.generateContent call in clean-room audit");
    };
    resetHubsForTest();

    server = await startServer(0, { repoRoot: cleanStageDir });
    const { port } = server.address() as AddressInfo;
    assert.ok(port > 0);
    const baseUrl = `http://127.0.0.1:${port}`;

    const expectedIndexHtml = fs.readFileSync(path.join(cleanStageDir, "web", "dist", "index.html"), "utf8");
    const expectedDeckHtml = fs.readFileSync(path.join(REPO_ROOT, "deck", "index.html"), "utf8");
    const expectedPropsHtml = fs.readFileSync(path.join(REPO_ROOT, "docs", "printable-props.html"), "utf8");
    const expectedHandoutHtml = fs.readFileSync(path.join(REPO_ROOT, "docs", "judge-handout.html"), "utf8");
    const expectedWearables = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "web", "public", ".well-known", "meta-wearables-manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    const expectedFixtureBytes = fs.readFileSync(
      path.join(REPO_ROOT, "web", "public", "fixtures", "amlodipine.jpg"),
    );

    const rootRes = await fetch(`${baseUrl}/`);
    assert.equal(rootRes.status, 200);
    assert.equal(rootRes.headers.get("x-powered-by"), null);
    assert.match(rootRes.headers.get("content-type") ?? "", /text\/html/i);
    assert.match(rootRes.headers.get("cache-control") ?? "", /max-age=3600/i);
    const rootHtml = await rootRes.text();
    assert.equal(rootHtml, expectedIndexHtml);
    assert.match(rootHtml, /manifest\.webmanifest/i);

    const hudRes = await fetch(`${baseUrl}/hud`);
    assert.equal(hudRes.status, 200);
    assert.equal(hudRes.headers.get("x-powered-by"), null);
    assert.match(hudRes.headers.get("content-type") ?? "", /text\/html/i);
    assert.equal(await hudRes.text(), expectedIndexHtml);

    const deckRes = await fetch(`${baseUrl}/deck/`);
    assert.equal(deckRes.status, 200);
    assert.equal(deckRes.headers.get("x-powered-by"), null);
    assert.match(deckRes.headers.get("content-type") ?? "", /text\/html/i);
    assert.match(deckRes.headers.get("cache-control") ?? "", /max-age=3600/i);
    assert.equal(await deckRes.text(), expectedDeckHtml);

    const propsRes = await fetch(`${baseUrl}/printable-props.html`);
    assert.equal(propsRes.status, 200);
    assert.equal(propsRes.headers.get("x-powered-by"), null);
    assert.match(propsRes.headers.get("content-type") ?? "", /text\/html/i);
    const propsBody = await propsRes.text();
    assert.equal(propsBody, expectedPropsHtml);
    assert.match(propsBody, /Amlodipin 5 mg/);
    assert.match(propsBody, /<svg[^>]*class="barcode-svg"/i);

    const handoutRes = await fetch(`${baseUrl}/judge-handout.html`);
    assert.equal(handoutRes.status, 200);
    assert.equal(handoutRes.headers.get("x-powered-by"), null);
    assert.match(handoutRes.headers.get("content-type") ?? "", /text\/html/i);
    const handoutBody = await handoutRes.text();
    assert.equal(handoutBody, expectedHandoutHtml);
    assert.match(handoutBody, /STRENGTH_MIN_CONF = 0\.80/);

    const wearablesRes = await fetch(`${baseUrl}/.well-known/meta-wearables-manifest.json`);
    assert.equal(wearablesRes.status, 200);
    assert.equal(wearablesRes.headers.get("x-powered-by"), null);
    assert.match(wearablesRes.headers.get("content-type") ?? "", /application\/json/i);
    assert.match(wearablesRes.headers.get("cache-control") ?? "", /max-age=3600/i);
    const wearablesBody = (await wearablesRes.json()) as Record<string, unknown>;
    assert.deepEqual(wearablesBody, expectedWearables);
    assert.equal(wearablesBody.name, "HoldUp");
    assert.equal(wearablesBody.start_url, "/hud");
    assert.equal(wearablesBody.display, "standalone");
    assert.equal(wearablesBody.background_color, "#000000");

    const fixtureRes = await fetch(`${baseUrl}/fixtures/amlodipine.jpg`);
    assert.equal(fixtureRes.status, 200);
    assert.equal(fixtureRes.headers.get("x-powered-by"), null);
    assert.match(fixtureRes.headers.get("content-type") ?? "", /^image\/jpeg\b/i);
    assert.match(fixtureRes.headers.get("cache-control") ?? "", /max-age=3600/i);
    const fixtureBuf = Buffer.from(await fixtureRes.arrayBuffer());
    assert.equal(fixtureBuf.length, expectedFixtureBytes.length);
    assert.equal(fixtureBuf[0], 0xff);
    assert.equal(fixtureBuf[1], 0xd8);
    assert.equal(fixtureBuf[fixtureBuf.length - 2], 0xff);
    assert.equal(fixtureBuf[fixtureBuf.length - 1], 0xd9);
    assert.equal(fixtureBuf.equals(expectedFixtureBytes), true);

    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    assert.equal(healthRes.headers.get("x-powered-by"), null);
    assert.equal(healthRes.headers.get("cache-control"), "no-store");
    assert.match(healthRes.headers.get("content-type") ?? "", /application\/json/i);
    const healthRaw = await healthRes.text();
    assert.doesNotMatch(healthRaw, /AIza[0-9A-Za-z_-]{20,}/);
    const healthJson = JSON.parse(healthRaw) as Record<string, unknown>;
    assert.equal(healthJson.ok, true);
    assert.equal(healthJson.gemini, "down");
    const models = healthJson.models as Record<string, unknown>;
    assert.ok(Array.isArray(models?.live) && models.live.length > 0);
    assert.ok(Array.isArray(models?.verify) && models.verify.length > 0);
    assert.ok(Array.isArray(models?.tts) && models.tts.length > 0);

    const statsRes = await fetch(`${baseUrl}/api/stats`);
    assert.equal(statsRes.status, 200);
    assert.equal(statsRes.headers.get("x-powered-by"), null);
    assert.equal(statsRes.headers.get("cache-control"), "no-store");
    assert.match(statsRes.headers.get("content-type") ?? "", /application\/json/i);
    const statsJson = (await statsRes.json()) as Record<string, unknown>;
    assert.equal(statsJson.total, 0);
    assert.deepEqual(statsJson.features, {});

    const evalRes = await fetch(`${baseUrl}/api/eval-summary`);
    assert.equal(evalRes.status, 200);
    assert.equal(evalRes.headers.get("x-powered-by"), null);
    assert.equal(evalRes.headers.get("cache-control"), "no-store");
    assert.match(evalRes.headers.get("content-type") ?? "", /application\/json/i);
    const evalJson = (await evalRes.json()) as {
      ok: boolean;
      summary: {
        headline_metrics?: Record<string, unknown>;
        safety_invariants?: Record<string, unknown>;
        total_confident_wrong_dose_count?: unknown;
      } | null;
    };
    assert.equal(evalJson.ok, true);
    assert.notEqual(evalJson.summary, null);
    assert.equal(evalJson.summary?.headline_metrics?.never_guess_strength_min_conf, 0.8);
    assert.equal(evalJson.summary?.safety_invariants?.strength_min_conf, 0.8);
    assert.equal(evalJson.summary?.total_confident_wrong_dose_count, 0);

    const unknownRes = await fetch(`${baseUrl}/api/unknown`);
    assert.equal(unknownRes.status, 404);
    assert.equal(unknownRes.headers.get("x-powered-by"), null);
    assert.equal(unknownRes.headers.get("cache-control"), "no-store");
    assert.match(unknownRes.headers.get("content-type") ?? "", /application\/json/i);
    assert.deepEqual(await unknownRes.json(), {
      type: "error",
      code: "not_found",
      message: "not found",
      recoverable: false,
    });

    assert.equal(modelCalls, 0);
  } finally {
    resetHubsForTest();
    (ai.models as unknown as Record<string, unknown>).get = origModelsGet;
    (ai.models as unknown as Record<string, unknown>).generateContent = origGenerateContent;
    env.apiKey = prevApiKey;
    env.ledgerPath = prevLedgerPath;
    if (prevEnvKey === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = prevEnvKey;
    }
    await closeHttpServer(server);
    fs.rmSync(cleanStageDir, { recursive: true, force: true });
  }

  assert.equal(fs.existsSync(cleanStageDir), false, "Expected cleanStageDir to be removed in finally");
});

test("Minimal web/dist fixture fallback and .dockerignore secret/log exclusion guard work when unbuilt", async () => {
  const dockerfileRaw = fs.readFileSync(path.join(REPO_ROOT, "Dockerfile"), "utf8");
  const dockerignoreRaw = fs.readFileSync(path.join(REPO_ROOT, ".dockerignore"), "utf8");
  const stages = parseDockerfileStages(dockerfileRaw);
  const runtimeStage = stages[stages.length - 1];
  const runtimeCopies = parseRuntimeStageCopies(runtimeStage);
  const runtimeMkdirs = parseRuntimeMkdirDirs(runtimeStage);
  const matcher = parseDockerignore(dockerignoreRaw);

  const syntheticCtx = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  const cleanStageDir = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  let server: http.Server | null = null;
  const prevApiKey = env.apiKey;
  const prevEnvKey = process.env.GEMINI_API_KEY;

  try {
    fs.mkdirSync(path.join(syntheticCtx, ".git"), { recursive: true });
    fs.writeFileSync(path.join(syntheticCtx, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
    fs.writeFileSync(path.join(syntheticCtx, ".env"), "GEMINI_API_KEY=redacted\n", "utf8");
    fs.mkdirSync(path.join(syntheticCtx, "eval", "out"), { recursive: true });
    fs.writeFileSync(path.join(syntheticCtx, "eval", "out", "leak.json"), "{}", "utf8");
    fs.mkdirSync(path.join(syntheticCtx, "server", "logs"), { recursive: true });
    fs.writeFileSync(path.join(syntheticCtx, "server", "logs", "leak.jsonl"), "{}\n", "utf8");
    fs.mkdirSync(path.join(syntheticCtx, "server", "src"), { recursive: true });
    fs.writeFileSync(path.join(syntheticCtx, "server", "src", "keep.ts"), "export const ok = 1;\n", "utf8");

    copyFilteredFromContext(syntheticCtx, cleanStageDir, ".git", matcher);
    copyFilteredFromContext(syntheticCtx, cleanStageDir, ".env", matcher);
    copyFilteredFromContext(syntheticCtx, cleanStageDir, "eval/out", matcher);
    copyFilteredFromContext(syntheticCtx, cleanStageDir, "server", matcher);

    assert.equal(fs.existsSync(path.join(cleanStageDir, ".git")), false);
    assert.equal(fs.existsSync(path.join(cleanStageDir, ".env")), false);
    assert.equal(fs.existsSync(path.join(cleanStageDir, "eval", "out")), false);
    assert.equal(fs.existsSync(path.join(cleanStageDir, "server", "logs")), false);
    assert.equal(fs.existsSync(path.join(cleanStageDir, "server", "src", "keep.ts")), true);

    fs.rmSync(path.join(cleanStageDir, "server"), { recursive: true, force: true });

    const staged = stageCleanRuntimeDir(REPO_ROOT, cleanStageDir, runtimeCopies, runtimeMkdirs, matcher, {
      forceMinimalDist: true,
      includeServerSourceTree: false,
    });
    assert.equal(staged.usedBuiltDist, false);

    process.env.GEMINI_API_KEY = "";
    env.apiKey = "";
    server = await startServer(0, { repoRoot: cleanStageDir });
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;

    const rootRes = await fetch(`${baseUrl}/`);
    assert.equal(rootRes.status, 200);
    assert.match(rootRes.headers.get("content-type") ?? "", /text\/html/i);
    const rootHtml = await rootRes.text();
    assert.match(rootHtml, /id="root"/);

    const hudRes = await fetch(`${baseUrl}/hud`);
    assert.equal(hudRes.status, 200);
    assert.equal(await hudRes.text(), rootHtml);

    const wearablesRes = await fetch(`${baseUrl}/.well-known/meta-wearables-manifest.json`);
    assert.equal(wearablesRes.status, 200);
    assert.match(wearablesRes.headers.get("content-type") ?? "", /application\/json/i);
    assert.equal(((await wearablesRes.json()) as Record<string, unknown>).start_url, "/hud");

    const fixRes = await fetch(`${baseUrl}/fixtures/amlodipine.jpg`);
    assert.equal(fixRes.status, 200);
    assert.match(fixRes.headers.get("content-type") ?? "", /^image\/jpeg\b/i);
    await fixRes.arrayBuffer();
  } finally {
    env.apiKey = prevApiKey;
    if (prevEnvKey === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = prevEnvKey;
    }
    await closeHttpServer(server);
    fs.rmSync(syntheticCtx, { recursive: true, force: true });
    fs.rmSync(cleanStageDir, { recursive: true, force: true });
  }

  assert.equal(fs.existsSync(syntheticCtx), false);
  assert.equal(fs.existsSync(cleanStageDir), false);
});

test("docker-context-audit.test.ts has zero comments, zero em dashes, zero keys, and zero leaked temp dirs", () => {
  const selfPath = path.join(REPO_ROOT, "server", "test", "docker-context-audit.test.ts");
  const text = fs.readFileSync(selfPath, "utf8");
  const blockOpen = SLASH + STAR;
  const blockClose = STAR + SLASH;
  const lineCommentRe = new RegExp(`(^|[^:])${SLASH}${SLASH}`);
  const coAuthoredRe = new RegExp(["Co", "Authored", "By"].join("-"), "i");
  const apiKeyRe = new RegExp("AIza" + "[0-9A-Za-z_-]{20,}");

  assert.equal(text.includes(blockOpen), false, "Forbidden block comment open token");
  assert.equal(text.includes(blockClose), false, "Forbidden block comment close token");
  assert.equal(text.includes(EM_DASH), false, "Forbidden em dash character");
  assert.equal(coAuthoredRe.test(text), false, "Forbidden co-author trailer");
  assert.equal(apiKeyRe.test(text), false, "Forbidden API key pattern");

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    assert.equal(lineCommentRe.test(lines[i]), false, `Forbidden line comment at line ${i + 1}`);
  }

  const leaked = fs.readdirSync(os.tmpdir()).filter((entry) => entry.startsWith(TEMP_PREFIX));
  assert.deepEqual(leaked, [], "Expected zero leaked temp directories in os.tmpdir()");
});
