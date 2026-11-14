declare module "*.css" {}

type TestFn = (name: string, fn: () => void | Promise<void>) => Promise<void>;

type StrictAssert = {
  ok(value: unknown, message?: string): void;
  equal<T>(actual: T, expected: T, message?: string): void;
  deepEqual<T>(actual: T, expected: T, message?: string): void;
  match(value: string, regExp: RegExp, message?: string): void;
};

type FsModule = {
  existsSync(path: URL | string): boolean;
  readFileSync(path: URL | string, encoding: "utf8"): string;
  readdirSync(path: URL | string): string[];
};

type UrlModule = {
  pathToFileURL(path: string): URL;
};

type NodeModuleApi = {
  register(specifier: string | URL, parentURL?: string | URL): void;
};

type GlobalProcessLike = {
  cwd(): string;
  getBuiltinModule(id: string): unknown;
};

const proc = (globalThis as unknown as { process: GlobalProcessLike }).process;
const { test } = proc.getBuiltinModule("node:test") as { test: TestFn };
const assert: StrictAssert = proc.getBuiltinModule("node:assert/strict") as StrictAssert;
const { existsSync, readFileSync, readdirSync } = proc.getBuiltinModule("node:fs") as FsModule;
const { pathToFileURL } = proc.getBuiltinModule("node:url") as UrlModule;
const nodeModule = proc.getBuiltinModule("node:module") as NodeModuleApi;

const cwdPath = proc.cwd().replace(/\\/g, "/");
const webDirPath = cwdPath.endsWith("/web") ? cwdPath : `${cwdPath}/web`;
const webRootUrl = pathToFileURL(`${webDirPath}/`);

const cssLoaderSource = [
  "export async function resolve(specifier, context, nextResolve) {",
  '  if (specifier === "./pwa/registerSw.ts" && context.parentURL && context.parentURL.includes("?case=")) {',
  '    const suffix = context.parentURL.slice(context.parentURL.indexOf("?case="));',
  "    return nextResolve(specifier + suffix, context);",
  "  }",
  "  return nextResolve(specifier, context);",
  "}",
  "export async function load(url, context, nextLoad) {",
  '  if (url.endsWith(".css") || url.includes(".css?")) {',
  '    return { format: "module", shortCircuit: true, source: "" };',
  "  }",
  "  return nextLoad(url, context);",
  "}"
].join("\n");

nodeModule.register(
  `data:text/javascript,${encodeURIComponent(cssLoaderSource)}`,
  webRootUrl
);

const EM_DASH = String.fromCharCode(0x2014);
const LINE_COMMENT = "\x2f\x2f";
const BLOCK_COMMENT_OPEN = "\x2f*";
const BLOCK_COMMENT_CLOSE = "*\x2f";

const mainEntryUrl = new URL("./src/main.tsx", webRootUrl);
const selfTestUrl = new URL("./test/mainEntry.test.ts", webRootUrl);
const tokensCssUrl = new URL("./src/styles/tokens.css", webRootUrl);
const appCssUrl = new URL("./src/styles/app.css", webRootUrl);
const hudCssUrl = new URL("./src/hud/hud.css", webRootUrl);
const distAssetsUrl = new URL("./dist/assets", webRootUrl);

type MainEntryModule = {
  shouldRegisterPwaServiceWorker(pathname: string): boolean;
};

test("web/src/main.tsx imports tokens.css, app.css, hud.css, registerServiceWorker, and App with zero comments and zero em dashes", () => {
  assert.equal(existsSync(mainEntryUrl), true, "expected web/src/main.tsx to exist");
  const mainSource = readFileSync(mainEntryUrl, "utf8");
  const selfSource = readFileSync(selfTestUrl, "utf8");

  assert.equal(mainSource.includes(LINE_COMMENT), false, "line comments must not appear in main.tsx");
  assert.equal(mainSource.includes(BLOCK_COMMENT_OPEN), false, "block comments must not appear in main.tsx");
  assert.equal(mainSource.includes(BLOCK_COMMENT_CLOSE), false, "block comment closers must not appear in main.tsx");
  assert.equal(mainSource.includes(EM_DASH), false, "em dashes must not appear in main.tsx");

  assert.equal(selfSource.includes(LINE_COMMENT), false, "line comments must not appear in mainEntry.test.ts");
  assert.equal(selfSource.includes(BLOCK_COMMENT_OPEN), false, "block comments must not appear in mainEntry.test.ts");
  assert.equal(selfSource.includes(EM_DASH), false, "em dashes must not appear in mainEntry.test.ts");

  const tokensImportIdx = mainSource.indexOf('import "./styles/tokens.css";');
  const appImportIdx = mainSource.indexOf('import "./styles/app.css";');
  const hudImportIdx = mainSource.indexOf('import "./hud/hud.css";');

  assert.ok(tokensImportIdx >= 0, "main.tsx must import ./styles/tokens.css");
  assert.ok(appImportIdx >= 0, "main.tsx must import ./styles/app.css");
  assert.ok(hudImportIdx >= 0, "main.tsx must import ./hud/hud.css");
  assert.ok(tokensImportIdx < appImportIdx, "tokens.css must be imported before app.css");
  assert.ok(appImportIdx < hudImportIdx, "app.css must be imported before hud.css");

  assert.match(mainSource, /import\s*\{[^}]*\bregisterServiceWorker\b[^}]*\}\s*from\s*["']\.\/pwa\/registerSw\.ts["']/);
  assert.match(mainSource, /import\s*\{[^}]*\bApp\b[^}]*\}\s*from\s*["']\.\/App\.tsx["']/);
  assert.match(mainSource, /import\s*\{[^}]*\bStrictMode\b[^}]*\}\s*from\s*["']react["']/);
  assert.match(mainSource, /import\s*\{[^}]*\bcreateRoot\b[^}]*\}\s*from\s*["']react-dom\/client["']/);
  assert.ok(mainSource.includes('document.getElementById("root")'), 'main.tsx must target document.getElementById("root")');
});

test("shouldRegisterPwaServiceWorker skips /hud and /hud/ and enables PWA service worker registration on non-HUD routes", async () => {
  const baseSpecifier: string = new URL("./src/main.tsx", webRootUrl).href;
  const mainMod = (await import(baseSpecifier)) as MainEntryModule;
  assert.equal(typeof mainMod.shouldRegisterPwaServiceWorker, "function");

  assert.equal(mainMod.shouldRegisterPwaServiceWorker("/hud"), false);
  assert.equal(mainMod.shouldRegisterPwaServiceWorker("/hud/"), false);
  assert.equal(mainMod.shouldRegisterPwaServiceWorker(" /hud "), false);
  assert.equal(mainMod.shouldRegisterPwaServiceWorker(" /hud/ "), false);

  assert.equal(mainMod.shouldRegisterPwaServiceWorker("/"), true);
  assert.equal(mainMod.shouldRegisterPwaServiceWorker(""), true);
  assert.equal(mainMod.shouldRegisterPwaServiceWorker("/index.html"), true);
  assert.equal(mainMod.shouldRegisterPwaServiceWorker("/check"), true);
  assert.equal(mainMod.shouldRegisterPwaServiceWorker("/hud/extra"), true);

  const g = globalThis as Record<string, unknown>;
  const prevWindow = g.window;
  const prevDocument = g.document;
  const prevNavDesc = Object.getOwnPropertyDescriptor(globalThis, "navigator");

  const registerCalls: Array<{ scriptUrl: string; options: unknown }> = [];
  const queriedRootIds: string[] = [];

  try {
    Object.defineProperty(globalThis, "navigator", {
      value: {
        serviceWorker: {
          register(scriptUrl: string, options?: unknown) {
            registerCalls.push({ scriptUrl, options });
            return Promise.resolve({});
          }
        }
      },
      configurable: true,
      writable: true
    });

    g.document = {
      readyState: "complete",
      getElementById(id: string) {
        queriedRootIds.push(id);
        return null;
      }
    };

    g.window = {
      location: { pathname: "/hud" },
      addEventListener: () => {}
    };

    await import(`${baseSpecifier}?case=hud`);
    assert.equal(registerCalls.length, 0, "must not register service worker on /hud");
    assert.deepEqual(queriedRootIds, ["root"]);

    g.window = {
      location: { pathname: "/hud/" },
      addEventListener: () => {}
    };

    await import(`${baseSpecifier}?case=hud-slash`);
    assert.equal(registerCalls.length, 0, "must not register service worker on /hud/");
    assert.deepEqual(queriedRootIds, ["root", "root"]);

    g.window = {
      location: { pathname: "/" },
      addEventListener: () => {}
    };

    await import(`${baseSpecifier}?case=pwa`);
    assert.equal(registerCalls.length, 1, "must register service worker on /");
    assert.equal(registerCalls[0].scriptUrl, "/sw.js");
    assert.deepEqual(registerCalls[0].options, { scope: "/" });
    assert.deepEqual(queriedRootIds, ["root", "root", "root"]);
  } finally {
    if (prevWindow !== undefined) {
      g.window = prevWindow;
    } else {
      delete g.window;
    }
    if (prevDocument !== undefined) {
      g.document = prevDocument;
    } else {
      delete g.document;
    }
    if (prevNavDesc) {
      Object.defineProperty(globalThis, "navigator", prevNavDesc);
    } else {
      delete g.navigator;
    }
  }
});

test("tokens.css, app.css, and hud.css exist, are non-empty, define :root, high-contrast, and .hud-root rules, and contain zero em dashes", () => {
  for (const [label, url] of [
    ["tokens.css", tokensCssUrl],
    ["app.css", appCssUrl],
    ["hud.css", hudCssUrl]
  ] as const) {
    assert.equal(existsSync(url), true, `expected ${label} to exist`);
  }

  const tokensCss = readFileSync(tokensCssUrl, "utf8");
  const appCss = readFileSync(appCssUrl, "utf8");
  const hudCss = readFileSync(hudCssUrl, "utf8");

  assert.ok(tokensCss.trim().length > 0, "tokens.css must be non-empty");
  assert.ok(appCss.trim().length > 0, "app.css must be non-empty");
  assert.ok(hudCss.trim().length > 0, "hud.css must be non-empty");

  assert.ok(tokensCss.includes(":root"), "tokens.css must contain :root");
  assert.ok(
    tokensCss.includes('[data-theme="high-contrast"]'),
    'tokens.css must contain [data-theme="high-contrast"]'
  );
  assert.ok(appCss.includes(".app-shell"), "app.css must contain .app-shell");
  assert.ok(hudCss.includes(".hud-root"), "hud.css must contain .hud-root");
  assert.ok(hudCss.includes("#000000"), "hud.css must enforce pure #000000 waveguide background");

  assert.equal(tokensCss.includes(EM_DASH), false, "tokens.css must contain zero em dashes");
  assert.equal(appCss.includes(EM_DASH), false, "app.css must contain zero em dashes");
  assert.equal(hudCss.includes(EM_DASH), false, "hud.css must contain zero em dashes");

  if (existsSync(distAssetsUrl)) {
    const cssBundles = readdirSync(distAssetsUrl).filter((file) => file.endsWith(".css"));
    if (cssBundles.length > 0) {
      const combinedBundle = cssBundles
        .map((file) => readFileSync(new URL(`./dist/assets/${file}`, webRootUrl), "utf8"))
        .join("\n");
      assert.ok(combinedBundle.includes(":root"), "compiled CSS bundle must contain :root");
      assert.match(combinedBundle, /\[data-theme=["']?high-contrast["']?\]/);
      assert.ok(combinedBundle.includes(".hud-root"), "compiled CSS bundle must contain .hud-root");
      assert.equal(combinedBundle.includes(EM_DASH), false, "compiled CSS bundle must contain zero em dashes");
    }
  }
});
