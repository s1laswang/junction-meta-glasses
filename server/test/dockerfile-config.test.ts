import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "../src/env.ts";

const HASH_CHAR = "\x23";
const EM_DASH = "\u2014";
const API_KEY_PREFIX = "AI" + "za";

type StageBlock = {
  name: string;
  header: string;
  lines: string[];
  body: string;
};

function parseDockerfileStages(source: string): StageBlock[] {
  const stages: StageBlock[] = [];
  let current: StageBlock | null = null;

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const fromMatch = /^FROM\s+\S+\s+AS\s+([A-Za-z0-9_-]+)$/.exec(line);
    if (fromMatch) {
      current = {
        name: fromMatch[1],
        header: line,
        lines: [],
        body: "",
      };
      stages.push(current);
      continue;
    }
    if (current) {
      current.lines.push(line);
      current.body = current.lines.join("\n");
    }
  }

  return stages;
}

test("Dockerfile uses multi-stage build and non-root runtime with healthcheck, static/eval artifacts, zero comments, and zero secrets", () => {
  const dockerfilePath = path.join(REPO_ROOT, "Dockerfile");
  const source = fs.readFileSync(dockerfilePath, "utf8");

  assert.equal(source.includes(HASH_CHAR), false, "Dockerfile must contain zero hash comments");
  assert.equal(source.includes(EM_DASH), false, "Dockerfile must contain zero em dashes");
  assert.equal(source.includes(API_KEY_PREFIX), false, "Dockerfile must contain zero API keys");
  assert.equal(/GEMINI_API_KEY=\S/.test(source), false, "Dockerfile must never bake GEMINI_API_KEY");

  const stages = parseDockerfileStages(source);
  assert.deepEqual(
    stages.map((s) => s.name),
    ["build", "runtime"],
  );

  const [buildStage, runtimeStage] = stages;
  assert.match(buildStage.header, /^FROM node:\d+-slim AS build$/);
  assert.ok(buildStage.lines.includes("WORKDIR /app"));

  const installIdx = buildStage.lines.findIndex((l) => l.startsWith("RUN npm install"));
  const copyServerIdx = buildStage.lines.findIndex((l) => l === "COPY server ./server");
  const buildRunIdx = buildStage.lines.findIndex((l) => l === "RUN npm run typecheck && npm run build");

  assert.ok(installIdx > 0, "expected npm install step in build stage");
  assert.ok(copyServerIdx > installIdx, "source COPY should follow npm install for layer caching");
  assert.ok(buildRunIdx > copyServerIdx, "typecheck and build should run after source COPY");

  for (const expectedBuildCopy of [
    "COPY package.json package-lock.json* ./",
    "COPY server/package.json ./server/",
    "COPY web/package.json ./web/",
    "COPY shared ./shared",
    "COPY server ./server",
    "COPY web ./web",
    "COPY docs ./docs",
    "COPY deck ./deck",
    "COPY eval/combined_summary.json ./eval/combined_summary.json",
  ]) {
    assert.ok(
      buildStage.lines.includes(expectedBuildCopy),
      `expected build stage line: ${expectedBuildCopy}`,
    );
  }

  const copyDeckBuildIdx = buildStage.lines.indexOf("COPY deck ./deck");
  assert.ok(copyDeckBuildIdx > installIdx && copyDeckBuildIdx < buildRunIdx);

  assert.match(runtimeStage.header, /^FROM node:\d+-slim AS runtime$/);
  assert.ok(runtimeStage.lines.includes("WORKDIR /app"));
  assert.ok(runtimeStage.lines.includes("ENV NODE_ENV=production"));
  assert.ok(runtimeStage.lines.includes("ENV PORT=8080"));
  assert.ok(runtimeStage.lines.includes("EXPOSE 8080"));

  for (const expectedRuntimeCopy of [
    "COPY --from=build --chown=node:node /app/node_modules ./node_modules",
    "COPY --from=build --chown=node:node /app/package.json ./package.json",
    "COPY --from=build --chown=node:node /app/shared ./shared",
    "COPY --from=build --chown=node:node /app/server ./server",
    "COPY --from=build --chown=node:node /app/web/package.json ./web/package.json",
    "COPY --from=build --chown=node:node /app/web/dist ./web/dist",
    "COPY --from=build --chown=node:node /app/docs ./docs",
    "COPY --from=build --chown=node:node /app/deck ./deck",
    "COPY --from=build --chown=node:node /app/eval/combined_summary.json ./eval/combined_summary.json",
  ]) {
    assert.ok(
      runtimeStage.lines.includes(expectedRuntimeCopy),
      `expected runtime stage line: ${expectedRuntimeCopy}`,
    );
  }

  const mkdirIdx = runtimeStage.lines.findIndex(
    (l) => l.startsWith("RUN mkdir -p") && l.includes("/app/server/logs") && l.includes("/app/deck"),
  );
  const userNodeIdx = runtimeStage.lines.findIndex((l) => l === "USER node");
  assert.ok(mkdirIdx !== -1, "expected runtime mkdir for /app/server/logs and /app/deck");
  assert.ok(userNodeIdx > mkdirIdx, "USER node must be set after runtime directory setup");
  assert.equal(
    runtimeStage.lines.slice(userNodeIdx + 1).some((l) => /^USER\s+/i.test(l)),
    false,
    "runtime stage must remain non-root USER node",
  );

  const healthcheckLine = runtimeStage.lines.find((l) => l.startsWith("HEALTHCHECK "));
  assert.ok(healthcheckLine, "expected HEALTHCHECK instruction in runtime stage");
  assert.match(healthcheckLine, /http:\x2f\x2f127\.0\.0\.1:8080\/api\/health/);

  assert.ok(runtimeStage.lines.includes('CMD ["npm", "-w", "server", "run", "start"]'));
});

test("All workspace artifacts copied by Dockerfile exist on disk and eval/combined_summary.json parses cleanly", () => {
  const requiredPaths = [
    "package.json",
    "server/package.json",
    "web/package.json",
    "shared/types.ts",
    "shared/label_schema.json",
    "shared/verify_prompt.md",
    "server/src/index.ts",
    "web/index.html",
    "docs/printable-props.html",
    "docs/DEPLOY.md",
    "deck/index.html",
    "deck/deck.css",
    "deck/deck.js",
    "eval/combined_summary.json",
  ];

  for (const relPath of requiredPaths) {
    assert.equal(
      fs.existsSync(path.join(REPO_ROOT, relPath)),
      true,
      `expected ${relPath} to exist for Docker build context`,
    );
  }

  const evalSummaryRaw = fs.readFileSync(path.join(REPO_ROOT, "eval", "combined_summary.json"), "utf8");
  const evalSummary = JSON.parse(evalSummaryRaw) as Record<string, unknown>;
  assert.equal(typeof evalSummary, "object");
  assert.notEqual(evalSummary, null);
  assert.ok(Object.keys(evalSummary).length > 0);
});

test(".dockerignore excludes .env, .git, node_modules, eval/synthetic, eval/out, and server/logs while keeping !.env.example", () => {
  const dockerignoreSource = fs.readFileSync(path.join(REPO_ROOT, ".dockerignore"), "utf8");
  assert.equal(dockerignoreSource.includes(EM_DASH), false);

  const rules = dockerignoreSource
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith(HASH_CHAR));

  for (const requiredRule of [
    ".env",
    ".env.*",
    "!.env.example",
    ".git",
    "node_modules",
    "eval/synthetic",
    "eval/out",
    "server/logs",
  ]) {
    assert.ok(rules.includes(requiredRule), `expected .dockerignore to include ${requiredRule}`);
  }

  const envIdx = rules.indexOf(".env");
  const envWildcardIdx = rules.indexOf(".env.*");
  const allowEnvExampleIdx = rules.indexOf("!.env.example");
  assert.ok(
    allowEnvExampleIdx > envIdx && allowEnvExampleIdx > envWildcardIdx,
    "!.env.example must appear after .env and .env.* exclusions",
  );

  for (const mustRemainIncluded of [
    "docs",
    "docs/printable-props.html",
    "deck",
    "deck/index.html",
    "deck/deck.css",
    "deck/deck.js",
    "eval",
    "eval/combined_summary.json",
    "shared",
    "server",
    "web",
  ]) {
    assert.equal(
      rules.includes(mustRemainIncluded),
      false,
      `.dockerignore must not exclude ${mustRemainIncluded}`,
    );
  }
});

test(".env.example contains placeholder configuration keys and zero real AIza keys", () => {
  const envExampleSource = fs.readFileSync(path.join(REPO_ROOT, ".env.example"), "utf8");
  assert.equal(envExampleSource.includes(API_KEY_PREFIX), false, ".env.example must never contain AIza keys");
  assert.equal(envExampleSource.includes(EM_DASH), false);

  const entries = new Map<string, string>();
  for (const rawLine of envExampleSource.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith(HASH_CHAR)) continue;
    const eqIdx = trimmed.indexOf("=");
    assert.ok(eqIdx > 0, `expected KEY=VALUE entry in .env.example, got: ${trimmed}`);
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    entries.set(key, value);
  }

  assert.equal(entries.has("GEMINI_API_KEY"), true, "expected GEMINI_API_KEY= placeholder in .env.example");
  assert.equal(entries.get("GEMINI_API_KEY"), "", "GEMINI_API_KEY must be empty in .env.example");

  const liveModelVal = entries.get("GEMINI_LIVE_MODEL") ?? entries.get("LIVE_MODEL");
  const verifyModelVal = entries.get("GEMINI_VERIFY_MODEL") ?? entries.get("VERIFY_MODEL");
  assert.ok(liveModelVal && liveModelVal.length > 0, "expected live model placeholder in .env.example");
  assert.ok(verifyModelVal && verifyModelVal.length > 0, "expected verify model placeholder in .env.example");

  const portVal = entries.get("PORT");
  assert.ok(portVal && /^\d+$/.test(portVal), "expected numeric PORT in .env.example");
});

test("Root, server, and web package.json files expose dev, build, start, typecheck, tunnel, and test scripts", () => {
  type PkgJson = {
    name?: string;
    private?: boolean;
    type?: string;
    workspaces?: string[];
    engines?: { node?: string };
    scripts?: Record<string, string>;
  };

  const rootPkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as PkgJson;
  const serverPkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "server", "package.json"), "utf8")) as PkgJson;
  const webPkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "web", "package.json"), "utf8")) as PkgJson;

  assert.equal(rootPkg.private, true);
  assert.deepEqual(rootPkg.workspaces, ["server", "web"]);
  assert.ok(rootPkg.engines?.node, "expected engines.node constraint in root package.json");

  assert.ok(rootPkg.scripts, "expected scripts in root package.json");
  for (const requiredRootScript of ["dev", "build", "start", "typecheck", "tunnel"]) {
    assert.equal(
      typeof rootPkg.scripts[requiredRootScript],
      "string",
      `expected root package.json script: ${requiredRootScript}`,
    );
    assert.ok(rootPkg.scripts[requiredRootScript].length > 0);
  }

  assert.match(rootPkg.scripts.build, /npm -w web run build/);
  assert.match(rootPkg.scripts.start, /npm -w server run start/);
  assert.match(rootPkg.scripts.typecheck, /npm -w server run typecheck/);
  assert.match(rootPkg.scripts.typecheck, /npm -w web run typecheck/);
  assert.match(rootPkg.scripts.tunnel, /cloudflared tunnel/);

  assert.equal(serverPkg.type, "module");
  assert.ok(serverPkg.scripts);
  for (const requiredServerScript of ["dev", "start", "typecheck", "test", "smoke"]) {
    assert.equal(
      typeof serverPkg.scripts[requiredServerScript],
      "string",
      `expected server/package.json script: ${requiredServerScript}`,
    );
  }

  assert.equal(webPkg.type, "module");
  assert.ok(webPkg.scripts);
  for (const requiredWebScript of ["dev", "build", "typecheck", "test"]) {
    assert.equal(
      typeof webPkg.scripts[requiredWebScript],
      "string",
      `expected web/package.json script: ${requiredWebScript}`,
    );
  }
});
