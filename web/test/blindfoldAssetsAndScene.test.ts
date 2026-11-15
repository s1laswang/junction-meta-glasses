import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  PixelSceneController,
  PixelSceneState,
  ScenePhase,
} from "../src/lib/pixelScene.ts";

const TEST_FILE = fileURLToPath(import.meta.url);
const TEST_DIR = path.dirname(TEST_FILE);
const REPO_DIR = path.resolve(TEST_DIR, "..", "..");

const SLASH = String.fromCharCode(47);
const ASTERISK = String.fromCharCode(42);
const LINE_CMT = SLASH + SLASH;
const BLOCK_CMT = SLASH + ASTERISK;
const BLOCK_CMT_END = ASTERISK + SLASH;
const HTML_CMT = String.fromCharCode(60, 33, 45, 45);
const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);
const ESCAPED_EM_DASH = ["\\", "u2014"].join("");
const ESCAPED_EN_DASH = ["\\", "u2013"].join("");
const CHILD_PROCESS_TOKEN = ["child", "_process"].join("");
const EXEC_SYNC_TOKEN = ["exec", "Sync"].join("");
const SPAWN_SYNC_TOKEN = ["spawn", "Sync"].join("");
const DOT_GIT_TOKEN = [".", "g", "it"].join("");
const GIT_SPACE_TOKEN = ["g", "it", " "].join("");

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_SPRITE_DIR_BYTES = 1_200_000;

const ASSETS_REL = ["docs", "demo", "ASSETS.md"].join(SLASH);
const SPRITES_REL = ["web", "public", "blindfold", "sprites"].join(SLASH);
const PIXEL_SCENE_REL = ["web", "src", "lib", "pixelScene.ts"].join(SLASH);
const DEMO_REL = "DEMO.md";
const MP4_REL = ["docs", "demo", "holdup-mock-demo.mp4"].join(SLASH);

const ALL_MODES: ReadonlyArray<PixelSceneState["mode"]> = ["blindfold", "spot"];
const ALL_PHASES: ReadonlyArray<ScenePhase> = [
  "idle",
  "coaching",
  "checking",
  "match",
  "warning",
  "unsure",
];
const ALL_LANGS: ReadonlyArray<PixelSceneState["lang"]> = ["en", "fi", "sv"];

function resolveRepoPath(relPath: string): string {
  return path.join(REPO_DIR, ...relPath.split(SLASH));
}

function readRequiredUtf8(relPath: string): string {
  const fullPath = resolveRepoPath(relPath);
  assert.equal(fs.existsSync(fullPath), true, `Expected "${relPath}" to exist`);
  const stat = fs.statSync(fullPath);
  assert.equal(stat.isFile(), true, `Expected "${relPath}" to be a regular file`);
  assert.ok(stat.size > 0, `Expected "${relPath}" to have size > 0 bytes`);
  const text = fs.readFileSync(fullPath, "utf8");
  assert.ok(text.trim().length > 0, `Expected "${relPath}" to contain non-empty text`);
  return text;
}

function stripUrlSchemes(text: string): string {
  const schemeRe = new RegExp("[A-Za-z][A-Za-z0-9+.-]*:" + LINE_CMT, "g");
  return text.replace(schemeRe, "scheme:");
}

function assertMarkdownHygiene(md: string, label: string): void {
  assert.equal(md.includes(HTML_CMT), false, `${label} must contain zero HTML comments`);
  assert.equal(
    md.includes("[" + LINE_CMT + "]:"),
    false,
    `${label} must contain zero reference-style markdown comments`,
  );
  const withoutUrls = stripUrlSchemes(md);
  assert.equal(
    withoutUrls.includes(LINE_CMT),
    false,
    `${label} must contain zero line comments`,
  );
  const blockCmtRe = new RegExp(
    "(?:^|[\\s(;{])\\" + SLASH + "\\" + ASTERISK + "[\\s\\S]*?\\" + ASTERISK + "\\" + SLASH,
  );
  assert.equal(
    blockCmtRe.test(withoutUrls),
    false,
    `${label} must contain zero block comments`,
  );
  assert.equal(md.includes(EM_DASH), false, `${label} must contain zero em dashes`);
  assert.equal(md.includes(EN_DASH), false, `${label} must contain zero en dashes`);
}

function assertCodeHygiene(src: string, label: string): void {
  const withoutUrls = stripUrlSchemes(src);
  assert.equal(withoutUrls.includes(LINE_CMT), false, `${label} must contain zero line comments`);
  assert.equal(src.includes(BLOCK_CMT), false, `${label} must contain zero block comments`);
  assert.equal(src.includes(BLOCK_CMT_END), false, `${label} must contain zero block comment closers`);
  assert.equal(src.includes(HTML_CMT), false, `${label} must contain zero HTML comments`);
  assert.equal(src.includes(EM_DASH), false, `${label} must contain zero em dashes`);
  assert.equal(src.includes(EN_DASH), false, `${label} must contain zero en dashes`);
}

function parsePngDimensions(buf: Buffer, label: string): { width: number; height: number } {
  assert.ok(buf.length >= 24, `${label}: PNG buffer too short (${buf.length} bytes)`);
  assert.equal(
    buf.subarray(0, 8).equals(PNG_SIGNATURE),
    true,
    `${label}: invalid 8-byte PNG signature (${buf.subarray(0, 8).toString("hex")})`,
  );
  const ihdrLen = buf.readUInt32BE(8);
  const chunkType = buf.toString("ascii", 12, 16);
  assert.equal(chunkType, "IHDR", `${label}: first PNG chunk must be IHDR, got "${chunkType}"`);
  assert.equal(ihdrLen, 13, `${label}: IHDR length must be 13, got ${ihdrLen}`);
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  assert.ok(width > 0 && height > 0, `${label}: expected positive IHDR dimensions, got ${width}x${height}`);
  return { width, height };
}

function walkDirectoryFiles(rootDir: string): Array<{ fullPath: string; size: number }> {
  const results: Array<{ fullPath: string; size: number }> = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile()) {
        const stat = fs.statSync(entryPath);
        results.push({ fullPath: entryPath, size: stat.size });
      }
    }
  }
  results.sort((a, b) => a.fullPath.localeCompare(b.fullPath));
  return results;
}

function stripFencedCodeBlocks(md: string): string {
  const out: string[] = [];
  let inFence = false;
  for (const line of md.split(/\r?\n/)) {
    if (/^\s*(`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) {
      out.push(line);
    }
  }
  return out.join("\n");
}

function extractRelativeMarkdownLinks(md: string): string[] {
  const prose = stripFencedCodeBlocks(md);
  const linkRe = /!?\[[^\]]*\]\(([^)]+)\)/g;
  const targets: string[] = [];
  for (const match of prose.matchAll(linkRe)) {
    let raw = match[1].trim();
    if (raw.startsWith("<") && raw.includes(">")) {
      raw = raw.slice(1, raw.indexOf(">")).trim();
    } else {
      raw = raw.split(/\s+/)[0] ?? "";
    }
    if (!raw || raw.startsWith("#") || raw.startsWith(SLASH)) {
      continue;
    }
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw)) {
      continue;
    }
    const cleanPath = raw.split("#")[0].split("?")[0].trim();
    if (cleanPath.length > 0) {
      targets.push(cleanPath);
    }
  }
  return targets;
}

interface MockCanvasHarness {
  canvas: HTMLCanvasElement;
  ctx: Record<string, unknown> & { imageSmoothingEnabled: boolean };
  ops: Array<{ name: string; args: unknown[] }>;
  getSaveDepth: () => number;
}

function createMockCanvas(width = 320, height = 180): MockCanvasHarness {
  const ops: Array<{ name: string; args: unknown[] }> = [];
  const attrs = new Map<string, string>();
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  let saveDepth = 0;
  let lineDash: number[] = [];

  const record =
    (name: string, impl?: (...args: unknown[]) => unknown) =>
    (...args: unknown[]): unknown => {
      ops.push({ name, args });
      return impl ? impl(...args) : undefined;
    };

  const gradientStub = {
    addColorStop: record("addColorStop"),
  };

  const baseCtx: Record<string, unknown> & { imageSmoothingEnabled: boolean } = {
    canvas: null,
    imageSmoothingEnabled: true,
    imageSmoothingQuality: "low",
    fillStyle: "#000000",
    strokeStyle: "#000000",
    lineWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
    miterLimit: 10,
    lineDashOffset: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    shadowBlur: 0,
    shadowColor: "rgba(0,0,0,0)",
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    font: "10px monospace",
    textAlign: "start",
    textBaseline: "alphabetic",
    direction: "ltr",
    filter: "none",
    fillRect: record("fillRect"),
    strokeRect: record("strokeRect"),
    clearRect: record("clearRect"),
    drawImage: record("drawImage"),
    fillText: record("fillText"),
    strokeText: record("strokeText"),
    measureText: record("measureText", (text) => ({
      width: String(text ?? "").length * 6,
      actualBoundingBoxAscent: 8,
      actualBoundingBoxDescent: 2,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: String(text ?? "").length * 6,
      fontBoundingBoxAscent: 8,
      fontBoundingBoxDescent: 2,
    })),
    save: record("save", () => {
      saveDepth += 1;
    }),
    restore: record("restore", () => {
      if (saveDepth > 0) {
        saveDepth -= 1;
      }
    }),
    beginPath: record("beginPath"),
    closePath: record("closePath"),
    moveTo: record("moveTo"),
    lineTo: record("lineTo"),
    arc: record("arc"),
    arcTo: record("arcTo"),
    ellipse: record("ellipse"),
    rect: record("rect"),
    roundRect: record("roundRect"),
    quadraticCurveTo: record("quadraticCurveTo"),
    bezierCurveTo: record("bezierCurveTo"),
    fill: record("fill"),
    stroke: record("stroke"),
    clip: record("clip"),
    scale: record("scale"),
    translate: record("translate"),
    rotate: record("rotate"),
    transform: record("transform"),
    setTransform: record("setTransform"),
    resetTransform: record("resetTransform"),
    setLineDash: record("setLineDash", (segments) => {
      lineDash = Array.isArray(segments) ? [...(segments as number[])] : [];
    }),
    getLineDash: record("getLineDash", () => [...lineDash]),
    createLinearGradient: record("createLinearGradient", () => gradientStub),
    createRadialGradient: record("createRadialGradient", () => gradientStub),
    createConicGradient: record("createConicGradient", () => gradientStub),
    createPattern: record("createPattern", () => ({})),
    createImageData: record("createImageData", (w, h) => {
      const iw = Math.max(1, Number(w) || 1);
      const ih = Math.max(1, Number(h) || 1);
      return { width: iw, height: ih, data: new Uint8ClampedArray(iw * ih * 4) };
    }),
    getImageData: record("getImageData", (_x, _y, w, h) => {
      const iw = Math.max(1, Number(w) || 1);
      const ih = Math.max(1, Number(h) || 1);
      return { width: iw, height: ih, data: new Uint8ClampedArray(iw * ih * 4) };
    }),
    putImageData: record("putImageData"),
    isPointInPath: record("isPointInPath", () => false),
    isPointInStroke: record("isPointInStroke", () => false),
  };

  const fallbackFns = new Map<string, (...args: unknown[]) => unknown>();
  const ctx = new Proxy(baseCtx, {
    get(target, prop, receiver) {
      if (typeof prop === "symbol" || prop in target) {
        return Reflect.get(target, prop, receiver);
      }
      let fn = fallbackFns.get(prop);
      if (!fn) {
        fn = record(prop);
        fallbackFns.set(prop, fn);
      }
      return fn;
    },
    set(target, prop, value, receiver) {
      return Reflect.set(target, prop, value, receiver);
    },
  });

  const canvasObj = {
    width,
    height,
    clientWidth: width,
    clientHeight: height,
    style: {} as Record<string, string>,
    dataset: {} as Record<string, string>,
    getContext(contextId: string) {
      return contextId === "2d" ? ctx : null;
    },
    getBoundingClientRect() {
      return {
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: canvasObj.clientWidth,
        bottom: canvasObj.clientHeight,
        width: canvasObj.clientWidth,
        height: canvasObj.clientHeight,
        toJSON() {
          return {};
        },
      };
    },
    setAttribute(name: string, value: string) {
      attrs.set(name, String(value));
    },
    getAttribute(name: string) {
      return attrs.has(name) ? attrs.get(name)! : null;
    },
    hasAttribute(name: string) {
      return attrs.has(name);
    },
    removeAttribute(name: string) {
      attrs.delete(name);
    },
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      if (!listeners.has(type)) {
        listeners.set(type, new Set());
      }
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      listeners.get(type)?.delete(listener);
    },
  };

  baseCtx.canvas = canvasObj;

  return {
    canvas: canvasObj as unknown as HTMLCanvasElement,
    ctx,
    ops,
    getSaveDepth: () => saveDepth,
  };
}

interface BrowserEnvHandle {
  pendingRaf: Map<number, FrameRequestCallback>;
  getTotalRafScheduled: () => number;
  flushSingleRafStep: (timestampMs?: number) => number;
  restore: () => void;
}

function installMockBrowserEnv(): BrowserEnvHandle {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const keys = [
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "Image",
    "window",
    "document",
    "devicePixelRatio",
  ];
  for (const key of keys) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  }

  let nextRafId = 1;
  let totalRafScheduled = 0;
  const pendingRaf = new Map<number, FrameRequestCallback>();

  const requestAnimationFrameMock = (cb: FrameRequestCallback): number => {
    const id = nextRafId++;
    totalRafScheduled += 1;
    pendingRaf.set(id, cb);
    return id;
  };

  const cancelAnimationFrameMock = (id: number): void => {
    pendingRaf.delete(id);
  };

  class MockImage {
    width = 16;
    height = 16;
    naturalWidth = 16;
    naturalHeight = 16;
    complete = true;
    crossOrigin: string | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    private currentSrc = "";

    get src(): string {
      return this.currentSrc;
    }

    set src(value: string) {
      this.currentSrc = String(value);
      this.complete = true;
      if (typeof this.onload === "function") {
        this.onload();
      }
    }

    addEventListener(type: string, listener: () => void): void {
      if (type === "load") {
        this.onload = listener;
      } else if (type === "error") {
        this.onerror = listener;
      }
    }

    removeEventListener(): void {}

    decode(): Promise<void> {
      return Promise.resolve();
    }
  }

  const mediaQueryStub = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false;
    },
  });

  const docStub = {
    hidden: false,
    visibilityState: "visible",
    documentElement: { lang: "en" },
    addEventListener() {},
    removeEventListener() {},
    createElement(tag: string) {
      if (tag.toLowerCase() === "canvas") {
        return createMockCanvas(64, 64).canvas;
      }
      if (tag.toLowerCase() === "img") {
        return new MockImage();
      }
      return { style: {}, setAttribute() {}, getAttribute() { return null; } };
    },
  };

  const winStub = {
    devicePixelRatio: 1,
    requestAnimationFrame: requestAnimationFrameMock,
    cancelAnimationFrame: cancelAnimationFrameMock,
    matchMedia: mediaQueryStub,
    addEventListener() {},
    removeEventListener() {},
    document: docStub,
  };

  Object.defineProperty(globalThis, "requestAnimationFrame", {
    value: requestAnimationFrameMock,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", {
    value: cancelAnimationFrameMock,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "Image", {
    value: MockImage,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "devicePixelRatio", {
    value: 1,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "document", {
    value: docStub,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "window", {
    value: winStub,
    configurable: true,
    writable: true,
  });

  return {
    pendingRaf,
    getTotalRafScheduled: () => totalRafScheduled,
    flushSingleRafStep(timestampMs = 16.67): number {
      const snapshot = [...pendingRaf.entries()];
      pendingRaf.clear();
      for (const [, cb] of snapshot) {
        cb(timestampMs);
      }
      return snapshot.length;
    },
    restore() {
      for (const [key, desc] of saved.entries()) {
        if (desc) {
          Object.defineProperty(globalThis, key, desc);
        } else {
          Reflect.deleteProperty(globalThis, key);
        }
      }
    },
  };
}

describe("Blindfold challenge CC0 assets, pixelScene 2D canvas controller, and DEMO.md contract", () => {
  test("docs/demo/ASSETS.md exists, documents Kenney.nl and OpenGameArt CC0 1.0 packs with https URLs and authors, verifies all referenced sprites, and has zero comments or em/en dashes", () => {
    const assetsMd = readRequiredUtf8(ASSETS_REL);
    assertMarkdownHygiene(assetsMd, ASSETS_REL);

    assert.match(
      assetsMd,
      /kenney(?:\.nl)?|opengameart(?:\.org)?/i,
      "ASSETS.md must document Kenney.nl or OpenGameArt asset packs",
    );

    const httpsPackUrlRe = new RegExp(
      "https:" + LINE_CMT + "(?:www\\.)?(?:kenney\\.nl|opengameart\\.org)" + SLASH + "\\S+",
      "i",
    );
    assert.equal(
      httpsPackUrlRe.test(assetsMd),
      true,
      "ASSETS.md must include https pack URLs on kenney.nl or opengameart.org",
    );

    assert.match(
      assetsMd,
      /\b(?:author|creator|kenney\s+vleugels|kipperfalcon)\b/i,
      "ASSETS.md must document pack authors",
    );
    assert.match(
      assetsMd,
      /\bCC0\s+1\.0\b/i,
      "ASSETS.md must document the CC0 1.0 license",
    );

    const spriteRefRe = new RegExp(
      "web" + SLASH + "public" + SLASH + "blindfold" + SLASH + "sprites" + SLASH + "[A-Za-z0-9_." + SLASH + "-]+\\.png",
      "g",
    );
    const referencedSprites = new Set<string>();
    for (const match of assetsMd.matchAll(spriteRefRe)) {
      referencedSprites.add(match[0]);
    }
    assert.ok(
      referencedSprites.size > 0,
      `ASSETS.md must reference at least one sprite PNG file under ${SPRITES_REL}`,
    );

    const spritesRoot = resolveRepoPath(SPRITES_REL);
    for (const relSprite of referencedSprites) {
      const fullSpritePath = resolveRepoPath(relSprite);
      const normalized = path.resolve(fullSpritePath);
      assert.ok(
        normalized.startsWith(spritesRoot + path.sep),
        `Referenced sprite "${relSprite}" must stay inside ${SPRITES_REL}`,
      );
      assert.equal(
        fs.existsSync(normalized),
        true,
        `Referenced sprite "${relSprite}" in ASSETS.md must exist on disk`,
      );
      const stat = fs.statSync(normalized);
      assert.equal(stat.isFile(), true, `Referenced sprite "${relSprite}" must be a regular file`);
      assert.ok(stat.size > 0, `Referenced sprite "${relSprite}" must be non-empty`);
    }
  });

  test("web/public/blindfold/sprites/ contains valid PNGs with 8-byte signature and positive IHDR dimensions under the 1.2 MB budget", () => {
    const spritesDir = resolveRepoPath(SPRITES_REL);
    assert.equal(fs.existsSync(spritesDir), true, `Expected directory "${SPRITES_REL}" to exist`);
    assert.equal(
      fs.statSync(spritesDir).isDirectory(),
      true,
      `Expected "${SPRITES_REL}" to be a directory`,
    );

    const allFiles = walkDirectoryFiles(spritesDir);
    const pngFiles = allFiles.filter((f) => f.fullPath.toLowerCase().endsWith(".png"));
    assert.ok(pngFiles.length > 0, `Expected "${SPRITES_REL}" to contain PNG files`);

    const totalBytes = allFiles.reduce((sum, item) => sum + item.size, 0);
    assert.ok(totalBytes > 0, `Expected "${SPRITES_REL}" total bytes > 0, got ${totalBytes}`);
    assert.ok(
      totalBytes < MAX_SPRITE_DIR_BYTES,
      `Expected "${SPRITES_REL}" total bytes < ${MAX_SPRITE_DIR_BYTES}, got ${totalBytes}`,
    );

    for (const png of pngFiles) {
      const rel = path.relative(REPO_DIR, png.fullPath).split(path.sep).join(SLASH);
      const buf = fs.readFileSync(png.fullPath);
      const dims = parsePngDimensions(buf, rel);
      assert.ok(dims.width > 0 && dims.height > 0, `${rel}: expected positive width and height`);
    }
  });

  test("web/src/lib/pixelScene.ts satisfies the 2D canvas controller contract across modes, phases, languages, cues, reducedMotion, and destroy() with zero comments or em/en dashes", async () => {
    const sceneSrc = readRequiredUtf8(PIXEL_SCENE_REL);
    assertCodeHygiene(sceneSrc, PIXEL_SCENE_REL);

    for (const symbolName of [
      "ScenePhase",
      "PixelSceneState",
      "PixelSceneController",
      "mountPixelScene",
    ]) {
      assert.ok(
        sceneSrc.includes(symbolName),
        `${PIXEL_SCENE_REL} must declare and export ${symbolName}`,
      );
    }

    const env = installMockBrowserEnv();
    try {
      const sceneModule = (await import("../src/lib/pixelScene.ts")) as {
        mountPixelScene: (
          canvas: HTMLCanvasElement,
          initial: PixelSceneState,
        ) => PixelSceneController;
        BLINDFOLD_SPRITE_URLS?: Record<string, string>;
      };
      assert.equal(
        typeof sceneModule.mountPixelScene,
        "function",
        "mountPixelScene must be exported as a function",
      );

      if (sceneModule.BLINDFOLD_SPRITE_URLS) {
        const urls = Object.values(sceneModule.BLINDFOLD_SPRITE_URLS);
        assert.ok(urls.length > 0, "BLINDFOLD_SPRITE_URLS must be non-empty when exported");
        for (const spriteUrl of urls) {
          const relFromPublic = spriteUrl.startsWith(SLASH) ? spriteUrl.slice(1) : spriteUrl;
          const diskPath = resolveRepoPath(["web", "public", relFromPublic].join(SLASH));
          assert.equal(
            fs.existsSync(diskPath),
            true,
            `Sprite URL "${spriteUrl}" in pixelScene.ts must exist on disk at web/public/${relFromPublic}`,
          );
        }
      }

      const primary = createMockCanvas(320, 180);
      assert.equal(
        primary.ctx.imageSmoothingEnabled,
        true,
        "Mock 2D context starts with imageSmoothingEnabled=true before mount",
      );

      const initialState: PixelSceneState = {
        mode: "blindfold",
        phase: "idle",
        blindfoldOn: true,
        score: 0,
        total: 5,
        lang: "en",
      };

      const controller = sceneModule.mountPixelScene(primary.canvas, initialState);
      assert.equal(typeof controller.update, "function", "controller.update must be a function");
      assert.equal(typeof controller.renderNow, "function", "controller.renderNow must be a function");
      assert.equal(typeof controller.destroy, "function", "controller.destroy must be a function");

      controller.renderNow();
      assert.equal(
        primary.ctx.imageSmoothingEnabled,
        false,
        "mountPixelScene + renderNow must disable 2D context imageSmoothingEnabled",
      );
      assert.ok(primary.ops.length > 0, "Expected initial renderNow() to emit 2D canvas draw operations");
      assert.equal(primary.getSaveDepth(), 0, "Canvas save/restore stack must stay balanced on mount");

      let stepIndex = 0;
      for (const mode of ALL_MODES) {
        for (const blindfoldOn of [true, false]) {
          for (const lang of ALL_LANGS) {
            for (const phase of ALL_PHASES) {
              stepIndex += 1;
              const opsBefore = primary.ops.length;
              const cueText =
                phase === "coaching"
                  ? lang === "fi"
                    ? "Kaanna pakkausta vasemmalle"
                    : lang === "sv"
                      ? "Vrid forpackningen at vanster"
                      : "Turn the box slightly left"
                  : stepIndex % 2 === 0
                    ? "Hold steady"
                    : undefined;
              const pharmacistBubble =
                phase === "warning"
                  ? "Avoid NSAIDs on your profile"
                  : phase === "match"
                    ? "Amlodipine 5 mg confirmed"
                    : phase === "unsure"
                      ? "Strength unclear, check side panel"
                      : undefined;

              primary.ctx.imageSmoothingEnabled = true;
              controller.update({
                mode,
                phase,
                blindfoldOn,
                score: stepIndex % 6,
                total: 5,
                lang,
                cueText,
                pharmacistBubble,
              });
              controller.renderNow();

              assert.equal(
                primary.ctx.imageSmoothingEnabled,
                false,
                `Expected imageSmoothingEnabled === false for mode=${mode} phase=${phase} blindfoldOn=${blindfoldOn} lang=${lang}`,
              );
              assert.ok(
                primary.ops.length > opsBefore,
                `Expected canvas draw calls on renderNow() for mode=${mode} phase=${phase} blindfoldOn=${blindfoldOn} lang=${lang}`,
              );
              assert.equal(
                primary.getSaveDepth(),
                0,
                `Expected balanced save/restore for mode=${mode} phase=${phase} blindfoldOn=${blindfoldOn} lang=${lang}`,
              );
            }
          }
        }
      }

      const drawOpNames = new Set(primary.ops.map((op) => op.name));
      assert.ok(
        drawOpNames.has("fillRect") || drawOpNames.has("clearRect") || drawOpNames.has("drawImage"),
        "Expected pixelScene renderer to invoke core 2D canvas drawing primitives",
      );

      controller.destroy();
      if (env.pendingRaf.size > 0) {
        env.flushSingleRafStep(33.34);
      }
      assert.equal(
        env.pendingRaf.size,
        0,
        "Destroyed controller must not leave a continuous requestAnimationFrame loop running",
      );
      controller.destroy();

      const reduced = createMockCanvas(320, 180);
      env.pendingRaf.clear();
      const reducedController = sceneModule.mountPixelScene(reduced.canvas, {
        mode: "spot",
        phase: "checking",
        blindfoldOn: false,
        score: 2,
        total: 4,
        lang: "fi",
        cueText: "Pidetaan paikallaan",
        pharmacistBubble: "Tarkistetaan vahvuus",
        reducedMotion: true,
      });
      if (env.pendingRaf.size > 0) {
        env.flushSingleRafStep(16.67);
      }
      assert.equal(
        env.pendingRaf.size,
        0,
        "reducedMotion: true must not schedule a continuous requestAnimationFrame loop",
      );
      const reducedOpsBefore = reduced.ops.length;
      reducedController.update({ phase: "match", score: 3, pharmacistBubble: "Valmis" });
      reducedController.renderNow();
      assert.ok(
        reduced.ops.length > reducedOpsBefore,
        "reducedMotion: true controller must still render synchronously on renderNow()",
      );
      if (env.pendingRaf.size > 0) {
        env.flushSingleRafStep(33.34);
      }
      assert.equal(
        env.pendingRaf.size,
        0,
        "reducedMotion: true update() must not leak continuous requestAnimationFrame callbacks",
      );
      reducedController.destroy();

      const toggleCanvas = createMockCanvas(320, 180);
      env.pendingRaf.clear();
      const toggleController = sceneModule.mountPixelScene(toggleCanvas.canvas, {
        mode: "blindfold",
        phase: "coaching",
        blindfoldOn: true,
        score: 1,
        total: 3,
        lang: "sv",
        cueText: "Narmare",
        reducedMotion: false,
      });
      toggleController.update({ reducedMotion: true });
      if (env.pendingRaf.size > 0) {
        env.flushSingleRafStep(48);
      }
      assert.equal(
        env.pendingRaf.size,
        0,
        "Switching reducedMotion to true via update() must stop continuous rAF scheduling",
      );
      toggleController.destroy();
    } finally {
      env.restore();
    }
  });

  test("DEMO.md covers /blindfold (Round 1 + Round 2), /?mock=1, /stage?mock=1, holdup-mock-demo.mp4, ASSETS.md, offline/no-glasses disclosure, valid relative links, and zero comments or em/en dashes", () => {
    const demoMd = readRequiredUtf8(DEMO_REL);
    assertMarkdownHygiene(demoMd, DEMO_REL);

    assert.ok(
      demoMd.includes(SLASH + "blindfold"),
      "DEMO.md must cover the /blindfold route",
    );
    assert.match(demoMd, /\bRound\s*1\b/i, "DEMO.md must cover Round 1 of /blindfold");
    assert.match(demoMd, /\bRound\s*2\b/i, "DEMO.md must cover Round 2 of /blindfold");
    assert.ok(demoMd.includes(SLASH + "?mock=1"), "DEMO.md must cover /?mock=1");
    assert.ok(demoMd.includes(SLASH + "stage?mock=1"), "DEMO.md must cover /stage?mock=1");
    assert.ok(demoMd.includes(MP4_REL), `DEMO.md must reference ${MP4_REL}`);
    assert.ok(demoMd.includes(ASSETS_REL), `DEMO.md must reference ${ASSETS_REL}`);

    assert.equal(
      fs.existsSync(resolveRepoPath(MP4_REL)),
      true,
      `Expected ${MP4_REL} referenced by DEMO.md to exist on disk`,
    );
    assert.equal(
      fs.existsSync(resolveRepoPath(ASSETS_REL)),
      true,
      `Expected ${ASSETS_REL} referenced by DEMO.md to exist on disk`,
    );

    assert.match(demoMd, /\boffline\b/i, "DEMO.md must explicitly disclose offline operation");
    assert.match(
      demoMd,
      /no[- ](?:physical\s+|meta\s+|ai\s+|ray-ban\s+)?glasses|without\s+(?:physical\s+|meta\s+|ai\s+|ray-ban\s+)?glasses|no\s+(?:physical\s+)?hardware|without\s+(?:physical\s+)?hardware|not\s+physical\s+(?:glasses|hardware)/i,
      "DEMO.md must explicitly include a no-glasses / no-hardware disclosure",
    );

    const relativeLinks = extractRelativeMarkdownLinks(demoMd);
    assert.ok(
      relativeLinks.length > 0,
      "DEMO.md must contain relative markdown links to repository files",
    );
    for (const relTarget of relativeLinks) {
      const resolved = path.resolve(REPO_DIR, relTarget);
      assert.ok(
        resolved === REPO_DIR || resolved.startsWith(REPO_DIR + path.sep),
        `Relative link "${relTarget}" in DEMO.md must resolve inside the repository`,
      );
      assert.equal(
        fs.existsSync(resolved),
        true,
        `Relative markdown link "${relTarget}" in DEMO.md must point to an existing path`,
      );
    }
  });

  test("test file self-check enforces zero comments, zero em/en dashes, and zero subprocess or VCS calls", () => {
    const selfSrc = fs.readFileSync(TEST_FILE, "utf8");
    assert.equal(selfSrc.includes(LINE_CMT), false, "Test file must contain zero line comments");
    assert.equal(selfSrc.includes(BLOCK_CMT), false, "Test file must contain zero block comments");
    assert.equal(selfSrc.includes(BLOCK_CMT_END), false, "Test file must contain zero block comment closers");
    assert.equal(selfSrc.includes(HTML_CMT), false, "Test file must contain zero HTML comments");
    assert.equal(selfSrc.includes(EM_DASH), false, "Test file must contain zero U+2014 em dashes");
    assert.equal(selfSrc.includes(EN_DASH), false, "Test file must contain zero U+2013 en dashes");
    assert.equal(selfSrc.includes(ESCAPED_EM_DASH), false, "Test file must contain zero escaped em dashes");
    assert.equal(selfSrc.includes(ESCAPED_EN_DASH), false, "Test file must contain zero escaped en dashes");
    assert.equal(selfSrc.includes(CHILD_PROCESS_TOKEN), false, "Test file must not import subprocess module");
    assert.equal(selfSrc.includes(EXEC_SYNC_TOKEN), false, "Test file must not call sync command runner");
    assert.equal(selfSrc.includes(SPAWN_SYNC_TOKEN), false, "Test file must not call sync process spawner");
    assert.equal(selfSrc.includes(DOT_GIT_TOKEN), false, "Test file must not inspect VCS metadata");
    assert.equal(selfSrc.includes(GIT_SPACE_TOKEN), false, "Test file must not invoke VCS CLI");
  });
});
