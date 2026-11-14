import viteConfig, { manualChunks } from "../vite.config.ts";

type TestFn = (name: string, fn: () => void | Promise<void>) => Promise<void>;

type StrictAssert = {
  ok(value: unknown, message?: string): asserts value;
  equal<T>(actual: T, expected: T, message?: string): void;
  deepEqual<T>(actual: T, expected: T, message?: string): void;
};

type FsModule = {
  existsSync(path: URL | string): boolean;
  readFileSync(path: URL | string, encoding: "utf8"): string;
  readdirSync(path: URL | string): string[];
  statSync(path: URL | string): { size: number };
};

const nodeTestSpec: string = "node:test";
const nodeAssertSpec: string = "node:assert/strict";
const nodeFsSpec: string = "node:fs";

const { test } = (await import(nodeTestSpec)) as { test: TestFn };
const assert: StrictAssert = ((await import(nodeAssertSpec)) as { default: StrictAssert }).default;
const { existsSync, readFileSync, readdirSync, statSync } = (await import(nodeFsSpec)) as FsModule;

const SLASH = String.fromCharCode(47);
const STAR = String.fromCharCode(42);
const DOUBLE_SLASH = SLASH + SLASH;
const BLOCK_COMMENT_OPEN = SLASH + STAR;
const BLOCK_COMMENT_CLOSE = STAR + SLASH;
const LINE_COMMENT_PATTERN = new RegExp(`(^|[^:])${DOUBLE_SLASH}`);
const HTTP_BACKEND = `http:${DOUBLE_SLASH}localhost:8787`;
const WS_BACKEND = `ws:${DOUBLE_SLASH}localhost:8787`;
const EM_DASH = "\u2014";
const EN_DASH = "\u2013";

const viteConfigUrl = new URL("../vite.config.ts", import.meta.url);
const selfTestUrl = new URL("./viteConfig.test.ts", import.meta.url);
const serverIndexUrl = new URL("../../server/src/index.ts", import.meta.url);
const distAssetsUrl = new URL("../dist/assets", import.meta.url);

test("web/vite.config.ts and web/test/viteConfig.test.ts contain zero comments and zero em dashes", () => {
  assert.equal(existsSync(viteConfigUrl), true, "web/vite.config.ts must exist");
  assert.equal(existsSync(selfTestUrl), true, "web/test/viteConfig.test.ts must exist");

  const configSource = readFileSync(viteConfigUrl, "utf8");
  const selfSource = readFileSync(selfTestUrl, "utf8");

  assert.equal(configSource.includes(BLOCK_COMMENT_OPEN), false, "block comment open forbidden in vite.config.ts");
  assert.equal(configSource.includes(BLOCK_COMMENT_CLOSE), false, "block comment close forbidden in vite.config.ts");
  for (const line of configSource.split("\n")) {
    assert.equal(LINE_COMMENT_PATTERN.test(line), false, "line comment forbidden in vite.config.ts");
  }
  const strippedProtocols = configSource
    .replaceAll(`http:${DOUBLE_SLASH}`, "")
    .replaceAll(`ws:${DOUBLE_SLASH}`, "");
  assert.equal(strippedProtocols.includes(DOUBLE_SLASH), false, "unexpected double slash in vite.config.ts");
  assert.equal(configSource.includes(EM_DASH), false, "em dash forbidden in vite.config.ts");
  assert.equal(configSource.includes(EN_DASH), false, "en dash forbidden in vite.config.ts");

  assert.equal(selfSource.includes(DOUBLE_SLASH), false, "double slash forbidden in viteConfig.test.ts");
  assert.equal(selfSource.includes(BLOCK_COMMENT_OPEN), false, "block comment open forbidden in viteConfig.test.ts");
  assert.equal(selfSource.includes(BLOCK_COMMENT_CLOSE), false, "block comment close forbidden in viteConfig.test.ts");
  assert.equal(selfSource.includes(EM_DASH), false, "em dash forbidden in viteConfig.test.ts");
  assert.equal(selfSource.includes(EN_DASH), false, "en dash forbidden in viteConfig.test.ts");
});

test("web/vite.config.ts proxies /api, /ingest, /deck, handouts, and WebSocket routes to :8787 on port 5173", () => {
  assert.ok(Array.isArray(viteConfig.plugins) && viteConfig.plugins.length > 0, "expected Vite plugins");
  assert.equal(viteConfig.server?.port, 5173);

  const proxy = viteConfig.server?.proxy as Record<string, unknown> | undefined;
  assert.ok(proxy, "expected server.proxy configuration");

  assert.equal(proxy["/api"], HTTP_BACKEND);
  assert.equal(proxy["/ingest"], HTTP_BACKEND);
  assert.equal(proxy["/deck"], HTTP_BACKEND);
  assert.equal(proxy["/printable-props.html"], HTTP_BACKEND);
  assert.equal(proxy["/judge-handout.html"], HTTP_BACKEND);
  assert.deepEqual(proxy["/live"], { target: WS_BACKEND, ws: true });
  assert.deepEqual(proxy["/hud-ws"], { target: WS_BACKEND, ws: true });
});

test("web/vite.config.ts manualChunks splits node_modules into vendor chunk and leaves app modules in default chunks", () => {
  const output = viteConfig.build?.rollupOptions?.output;
  assert.ok(output && !Array.isArray(output), "expected single rollupOptions.output object");
  assert.equal(typeof output.manualChunks, "function");
  assert.equal(output.manualChunks, manualChunks);

  const chunkFn = output.manualChunks as (id: string) => string | undefined;

  const vendorIds = [
    "/workspace/node_modules/react/index.js",
    "/workspace/node_modules/react-dom/client.js",
    "/workspace/node_modules/scheduler/index.js",
    "/tmp/fleet-silas/meta-deps/node_modules/react/cjs/react.production.js",
    "C:\\repo\\node_modules\\react\\index.js",
    "C:\\repo\\node_modules\\react-dom\\client.js",
    "node_modules/react/jsx-runtime.js",
    "\0/workspace/node_modules/react/index.js?commonjs-es-import"
  ];

  for (const id of vendorIds) {
    assert.equal(chunkFn(id), "vendor", `expected vendor chunk for ${id}`);
  }

  const appIds = [
    "/workspace/web/src/main.tsx",
    "/workspace/web/src/App.tsx",
    "/workspace/web/src/hud/HudApp.tsx",
    "/workspace/shared/types.ts",
    "C:\\repo\\web\\src\\App.tsx",
    "/workspace/web/src/node_modules_helper.ts",
    ""
  ];

  for (const id of appIds) {
    assert.equal(chunkFn(id), undefined, `expected undefined chunk for ${id}`);
  }
});

test("dev proxy routes match server/src/index.ts backend endpoints and built JS chunks stay under 500 kB", () => {
  assert.equal(existsSync(serverIndexUrl), true, "server/src/index.ts must exist");
  const serverSource = readFileSync(serverIndexUrl, "utf8");
  const proxy = viteConfig.server?.proxy as Record<string, unknown>;

  for (const routePrefix of [
    "/api/",
    "/ingest/",
    "/deck",
    "/printable-props.html",
    "/judge-handout.html",
    "/live",
    "/hud-ws"
  ]) {
    assert.ok(serverSource.includes(`"${routePrefix}`), `server/src/index.ts must serve ${routePrefix}`);
  }

  assert.deepEqual(
    Object.keys(proxy).sort(),
    ["/api", "/deck", "/hud-ws", "/ingest", "/judge-handout.html", "/live", "/printable-props.html"]
  );

  if (existsSync(distAssetsUrl)) {
    const jsFiles = readdirSync(distAssetsUrl).filter((file) => file.endsWith(".js"));
    if (jsFiles.some((file) => file.startsWith("vendor-"))) {
      assert.ok(jsFiles.some((file) => file.startsWith("index-")), "expected index-*.js chunk alongside vendor-*.js");
      for (const file of jsFiles) {
        const sizeBytes = statSync(new URL(`../dist/assets/${file}`, import.meta.url)).size;
        assert.ok(sizeBytes > 0 && sizeBytes < 500_000, `expected ${file} < 500 kB, got ${sizeBytes} bytes`);
      }
    }
  }
});
