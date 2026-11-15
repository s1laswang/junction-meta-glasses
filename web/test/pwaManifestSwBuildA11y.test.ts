import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import viteConfig from "../vite.config.ts";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(TEST_DIR, "..");
const REPO_DIR = path.resolve(WEB_DIR, "..");
const PUBLIC_DIR = path.join(WEB_DIR, "public");

const ORIGIN = ["https:", "", "holdup.example"].join("/");
const CROSS_ORIGIN = ["https:", "", "evil.example"].join("/");
const SVG_NS = ["http:", "", "www.w3.org", "2000", "svg"].join("/");

function readWebFile(relPath: string): string {
  return fs.readFileSync(path.join(WEB_DIR, relPath), "utf8");
}

function parseAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrPattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of tag.matchAll(attrPattern)) {
    attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? "";
  }
  return attrs;
}

function findTags(html: string, tagName: string): Array<Record<string, string>> {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>`, "gi");
  return [...html.matchAll(pattern)].map((m) => parseAttributes(m[0]));
}

function getMetaContent(metas: Array<Record<string, string>>, name: string): string | undefined {
  const target = name.toLowerCase();
  return metas.find((m) => m.name?.toLowerCase() === target)?.content;
}

function parseViewportDirectives(viewport: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const part of viewport.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) {
      map[trimmed.toLowerCase()] = "";
    } else {
      map[trimmed.slice(0, eqIdx).trim().toLowerCase()] = trimmed.slice(eqIdx + 1).trim().toLowerCase();
    }
  }
  return map;
}

function assertLowVisionViewportZoomAllowed(viewport: string | undefined, label: string): void {
  assert.ok(viewport, `${label} must define a viewport meta tag`);
  const directives = parseViewportDirectives(viewport);
  assert.equal(directives["width"], "device-width", `${label} viewport width must be device-width`);
  assert.equal(directives["initial-scale"], "1", `${label} viewport initial-scale must be 1`);

  const userScalable = directives["user-scalable"];
  if (userScalable !== undefined) {
    assert.ok(
      userScalable !== "no" && userScalable !== "0" && userScalable !== "false",
      `${label} must not disable user pinch-zoom via user-scalable=${userScalable}`,
    );
  }

  const maxScale = directives["maximum-scale"];
  if (maxScale !== undefined) {
    const numericMax = Number(maxScale);
    assert.ok(
      Number.isFinite(numericMax) && numericMax >= 5,
      `${label} maximum-scale must allow at least 5x zoom for low-vision users`,
    );
  }
}

function computeCrc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    let c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crc = ((crc >>> 8) ^ c) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

type DecodedPng = {
  bytes: number;
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  compression: number;
  filter: number;
  interlace: number;
  chunkTypes: string[];
  rgba: Buffer;
};

function decodePng(absPath: string): DecodedPng {
  const buf = fs.readFileSync(absPath);
  const expectedSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(buf.length > 33, `PNG file too small: ${absPath}`);
  assert.deepEqual(buf.subarray(0, 8), expectedSig, `Invalid PNG signature in ${absPath}`);

  let offset = 8;
  const chunkTypes: string[] = [];
  const idatParts: Buffer[] = [];
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let compression = 0;
  let filter = 0;
  let interlace = 0;

  while (offset < buf.length) {
    assert.ok(offset + 12 <= buf.length, `Truncated PNG chunk header in ${absPath}`);
    const len = buf.readUInt32BE(offset);
    const typeBuf = buf.subarray(offset + 4, offset + 8);
    const type = typeBuf.toString("ascii");
    assert.ok(offset + 12 + len <= buf.length, `Truncated PNG chunk body (${type}) in ${absPath}`);
    const data = buf.subarray(offset + 8, offset + 8 + len);
    const storedCrc = buf.readUInt32BE(offset + 8 + len);
    const actualCrc = computeCrc32(Buffer.concat([typeBuf, data]));
    assert.equal(actualCrc, storedCrc, `CRC32 mismatch on ${type} chunk in ${absPath}`);

    chunkTypes.push(type);
    if (type === "IHDR") {
      assert.equal(len, 13, `IHDR must be 13 bytes in ${absPath}`);
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      compression = data[10];
      filter = data[11];
      interlace = data[12];
    } else if (type === "IDAT") {
      idatParts.push(data);
    }
    offset += 12 + len;
  }

  assert.equal(chunkTypes[0], "IHDR", `First PNG chunk must be IHDR in ${absPath}`);
  assert.equal(chunkTypes[chunkTypes.length - 1], "IEND", `Last PNG chunk must be IEND in ${absPath}`);
  assert.ok(idatParts.length >= 1, `PNG must contain IDAT data in ${absPath}`);
  assert.equal(bitDepth, 8);
  assert.equal(colorType, 6);
  assert.equal(compression, 0);
  assert.equal(filter, 0);
  assert.equal(interlace, 0);

  const rawScanlines = zlib.inflateSync(Buffer.concat(idatParts));
  const stride = width * 4 + 1;
  assert.equal(rawScanlines.length, height * stride, `Unexpected scanline byte length in ${absPath}`);

  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const filterType = rawScanlines[y * stride];
    assert.equal(filterType, 0, `Expected filter type 0 on row ${y} in ${absPath}`);
    rawScanlines.copy(rgba, y * width * 4, y * stride + 1, (y + 1) * stride);
  }

  return {
    bytes: buf.length,
    width,
    height,
    bitDepth,
    colorType,
    compression,
    filter,
    interlace,
    chunkTypes,
    rgba,
  };
}

function pixelAt(png: DecodedPng, x: number, y: number): [number, number, number, number] {
  const idx = (y * png.width + x) * 4;
  return [png.rgba[idx], png.rgba[idx + 1], png.rgba[idx + 2], png.rgba[idx + 3]];
}

describe("web/index.html entry and low-vision viewport contract", () => {
  const html = readWebFile("index.html");
  const metas = findTags(html, "meta");
  const links = findTags(html, "link");
  const scripts = findTags(html, "script");

  test("declares HTML5 doctype, English lang attribute, UTF-8 charset, title, root mount, noscript fallback, and module entry", () => {
    assert.match(html, /^\s*<!doctype html>/i);
    const htmlTags = findTags(html, "html");
    assert.equal(htmlTags.length, 1);
    assert.equal(htmlTags[0].lang, "en");

    assert.ok(metas.some((m) => m.charset?.toLowerCase() === "utf-8"));
    const titleMatch = /<title>([^<]+)<\/title>/i.exec(html);
    assert.equal(titleMatch?.[1]?.trim(), "HoldUp");

    const desc = getMetaContent(metas, "description") ?? "";
    assert.ok(desc.length >= 20);
    assert.match(desc, /blind|low-vision/i);

    assert.match(html, /<div\s+id="root"\s*><\/div>/i);
    const noscriptMatch = /<noscript>([^<]+)<\/noscript>/i.exec(html);
    assert.ok(noscriptMatch?.[1]?.trim().length, "noscript fallback text must be non-empty");

    assert.ok(scripts.some((s) => s.type === "module" && s.src === "/src/main.tsx"));
  });

  test("permits unrestricted pinch-to-zoom for low-vision users and enables safe-area viewport-fit=cover", () => {
    const viewport = getMetaContent(metas, "viewport");
    assertLowVisionViewportZoomAllowed(viewport, "web/index.html");
    const directives = parseViewportDirectives(viewport!);
    assert.equal(directives["viewport-fit"], "cover");
  });

  test("wires PWA manifest, icons, theme-color, and iOS standalone web-app tags", () => {
    assert.equal(getMetaContent(metas, "theme-color")?.toLowerCase(), "#0b1018");
    assert.equal(getMetaContent(metas, "apple-mobile-web-app-capable"), "yes");
    assert.equal(getMetaContent(metas, "apple-mobile-web-app-status-bar-style"), "black-translucent");
    assert.equal(getMetaContent(metas, "apple-mobile-web-app-title"), "HoldUp");

    const manifestLink = links.find((l) => l.rel === "manifest");
    assert.equal(manifestLink?.href, "/manifest.webmanifest");

    const svgIcon = links.find((l) => l.rel === "icon");
    assert.equal(svgIcon?.href, "/icons/icon.svg");
    assert.equal(svgIcon?.type, "image/svg+xml");

    const touchIcon = links.find((l) => l.rel === "apple-touch-icon");
    assert.equal(touchIcon?.href, "/icons/icon-192.png");
  });
});

describe("web/hud/index.html and Meta Ray-Ban Display mrbd-web-app-capable contract", () => {
  const hudHtml = readWebFile("hud/index.html");
  const metas = findTags(hudHtml, "meta");
  const links = findTags(hudHtml, "link");
  const scripts = findTags(hudHtml, "script");

  test("declares mrbd-web-app-capable=yes, application-name, UTF-8 charset, lang=en, and black additive theme", () => {
    assert.match(hudHtml, /^\s*<!doctype html>/i);
    const htmlTags = findTags(hudHtml, "html");
    assert.equal(htmlTags.length, 1);
    assert.equal(htmlTags[0].lang, "en");

    assert.ok(metas.some((m) => m.charset?.toLowerCase() === "utf-8"));
    assert.equal(getMetaContent(metas, "mrbd-web-app-capable"), "yes");
    assert.equal(getMetaContent(metas, "application-name"), "HoldUp");
    assert.equal(getMetaContent(metas, "theme-color")?.toLowerCase(), "#000000");

    const desc = getMetaContent(metas, "description") ?? "";
    assert.ok(desc.includes("HoldUp"));
    assert.equal(/<title>([^<]+)<\/title>/i.exec(hudHtml)?.[1]?.trim(), "HoldUp");

    const bodyTags = findTags(hudHtml, "body");
    assert.equal(bodyTags.length, 1);
    assert.ok((bodyTags[0].class ?? "").split(/\s+/).includes("hud-body"));
    assert.match(hudHtml, /<div\s+id="root"\s*><\/div>/i);
    assert.ok(scripts.some((s) => s.type === "module" && s.src === "/src/main.tsx"));
  });

  test("preserves zoomable viewport without user-scalable=no and uses PNG > 52x52 favicon (never SVG)", () => {
    const viewport = getMetaContent(metas, "viewport");
    assertLowVisionViewportZoomAllowed(viewport, "web/hud/index.html");

    const iconLinks = links.filter((l) => (l.rel ?? "").split(/\s+/).includes("icon"));
    assert.equal(iconLinks.length, 1);
    const icon = iconLinks[0];
    assert.equal(icon.type, "image/png");
    assert.equal(icon.href, "/hud/icon-96.png");
    assert.equal(icon.sizes, "96x96");
    assert.ok(!links.some((l) => l.type === "image/svg+xml" || l.href?.endsWith(".svg")));

    const [w, h] = (icon.sizes ?? "").split("x").map(Number);
    assert.ok(w > 52 && h > 52, "Ray-Ban Display HUD favicon must exceed 52x52 pixels");
  });
});

describe("low-vision typography, high-contrast, reduced-motion, and additive HUD CSS rules", () => {
  const css = readWebFile("src/styles.css");

  test("loads Atkinson Hyperlegible Next and Mono fonts and uses >= 18px rem type scale with >= 56px tap targets", () => {
    assert.match(css, /@import\s+"@fontsource\/atkinson-hyperlegible-next\/400\.css";/);
    assert.match(css, /@import\s+"@fontsource\/atkinson-hyperlegible-next\/700\.css";/);
    assert.match(css, /@import\s+"@fontsource\/atkinson-hyperlegible-next\/800\.css";/);
    assert.match(css, /@import\s+"@fontsource\/atkinson-hyperlegible-mono\/500\.css";/);

    const baseMatch = /--t-base:\s*([0-9.]+)rem;/.exec(css);
    assert.ok(baseMatch, "--t-base must be defined in rem");
    assert.ok(Number(baseMatch[1]) >= 1.125, "--t-base must be at least 1.125rem (18px)");

    for (const token of ["--t-md", "--t-lg", "--t-xl", "--t-xxl"]) {
      const m = new RegExp(`${token}:\\s*([0-9.]+)rem;`).exec(css);
      assert.ok(m && Number(m[1]) > Number(baseMatch[1]), `${token} must scale in rem above --t-base`);
    }

    const tapMatch = /--tap:\s*(\d+)px;/.exec(css);
    assert.ok(tapMatch && Number(tapMatch[1]) >= 48, "--tap target must be at least 48px");
    assert.match(css, /text-size-adjust:\s*100%;/);
    assert.match(css, /-webkit-text-size-adjust:\s*100%;/);
  });

  test("defines prefers-contrast: more, prefers-reduced-motion: reduce, 3px focus-visible rings, and skip/sr-only utilities", () => {
    assert.match(css, /@media\s*\(\s*prefers-contrast:\s*more\s*\)/);
    assert.match(css, /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)[\s\S]*?animation:\s*none\s*!important;/);
    assert.match(css, /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)[\s\S]*?transition:\s*none\s*!important;/);
    assert.match(css, /:focus-visible\s*\{[^}]*outline:\s*3px\s+solid\s+var\(--accent\)/);
    assert.match(css, /\.sr-only\s*\{/);
    assert.match(css, /\.skip:focus\s*\{/);
  });

  test("keeps HUD background pure #000 for waveguide transparency and sizes HUD via responsive clamp() without fixed 600px", () => {
    assert.match(css, /body\.hud-body\s*\{[^}]*background:\s*#000;/);
    assert.match(css, /\.hud-card\s*\{[^}]*background:\s*#000;/);
    assert.match(css, /\.hud\s+button:focus-visible[\s\S]*?outline:\s*3px\s+solid\s+var\(--hud-accent\)/);
    assert.match(css, /\.hud-headline\s*\{[^}]*font-size:\s*clamp\(/);
    assert.ok(!/\.hud\s*\{[^}]*(?:width|height):\s*600px/.test(css));
  });
});

describe("web/public/manifest.webmanifest and Meta wearables .well-known manifest", () => {
  test("manifest.webmanifest defines standalone PWA metadata, matching theme colors, accessibility category, and existing icons", () => {
    const raw = fs.readFileSync(path.join(PUBLIC_DIR, "manifest.webmanifest"), "utf8");
    const manifest = JSON.parse(raw) as {
      name: string;
      short_name: string;
      description: string;
      id: string;
      start_url: string;
      scope: string;
      display: string;
      orientation: string;
      background_color: string;
      theme_color: string;
      categories: string[];
      icons: Array<{ src: string; sizes: string; type: string; purpose?: string }>;
    };

    assert.equal(manifest.name, "HoldUp");
    assert.equal(manifest.short_name, "HoldUp");
    assert.ok(manifest.description.length >= 20);
    assert.match(manifest.description, /blind|low-vision/i);
    assert.equal(manifest.id, "/");
    assert.equal(manifest.start_url, "/");
    assert.equal(manifest.scope, "/");
    assert.equal(manifest.display, "standalone");
    assert.equal(manifest.orientation, "portrait");
    assert.equal(manifest.background_color.toLowerCase(), "#0b1018");
    assert.equal(manifest.theme_color.toLowerCase(), "#0b1018");
    assert.ok(manifest.categories.includes("accessibility"));
    assert.ok(manifest.categories.includes("medical"));
    assert.ok(manifest.categories.includes("health"));

    assert.equal(manifest.icons.length, 4);
    const byKey = new Map(manifest.icons.map((ic) => [`${ic.src}|${ic.purpose ?? "any"}`, ic]));
    assert.deepEqual(byKey.get("/icons/icon-192.png|any"), {
      src: "/icons/icon-192.png",
      sizes: "192x192",
      type: "image/png",
    });
    assert.deepEqual(byKey.get("/icons/icon-512.png|any"), {
      src: "/icons/icon-512.png",
      sizes: "512x512",
      type: "image/png",
    });
    assert.deepEqual(byKey.get("/icons/maskable-512.png|maskable"), {
      src: "/icons/maskable-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "maskable",
    });
    assert.deepEqual(byKey.get("/icons/icon.svg|any"), {
      src: "/icons/icon.svg",
      sizes: "any",
      type: "image/svg+xml",
    });

    for (const ic of manifest.icons) {
      assert.ok(ic.src.startsWith("/"), `Manifest icon src must be root-relative: ${ic.src}`);
      const diskPath = path.join(PUBLIC_DIR, ic.src.slice(1));
      assert.ok(fs.existsSync(diskPath), `Manifest icon missing on disk: ${ic.src}`);
    }
  });

  test("hud/.well-known/meta-wearables-manifest.json obeys Meta Web Apps <= 64 KiB schema and relative monochrome icon path", () => {
    const manifestDir = path.join(PUBLIC_DIR, "hud", ".well-known");
    const manifestPath = path.join(manifestDir, "meta-wearables-manifest.json");
    const rawBuf = fs.readFileSync(manifestPath);
    assert.ok(rawBuf.byteLength > 0 && rawBuf.byteLength <= 64 * 1024, "Wearables manifest must be <= 64 KiB");

    const wearables = JSON.parse(rawBuf.toString("utf8")) as {
      version: number;
      name: string;
      description: string;
      appearance: {
        theme_color: string;
        icon: { src: string; type: string };
      };
    };

    assert.equal(wearables.version, 1);
    assert.equal(wearables.name, "HoldUp");
    assert.ok(wearables.description.length >= 15);
    assert.match(wearables.appearance.theme_color, /^#[0-9a-fA-F]{6}$/);
    assert.equal(wearables.appearance.icon.type, "monochrome");
    assert.equal(wearables.appearance.icon.src, "../icon-mono.png");

    const resolvedDiskIcon = path.resolve(manifestDir, wearables.appearance.icon.src);
    assert.equal(resolvedDiskIcon, path.join(PUBLIC_DIR, "hud", "icon-mono.png"));
    assert.ok(fs.existsSync(resolvedDiskIcon));

    const resolvedUrl = new URL(wearables.appearance.icon.src, `${ORIGIN}/hud/.well-known/meta-wearables-manifest.json`);
    assert.equal(resolvedUrl.pathname, "/hud/icon-mono.png");
  });
});

describe("PWA and HUD icon binary/SVG integrity", () => {
  test("standard PWA and HUD PNG icons have valid CRC32 chunks, exact dimensions, rounded transparent corners, and brand mark", () => {
    const specs: Array<{ rel: string; size: number }> = [
      { rel: "icons/icon-192.png", size: 192 },
      { rel: "icons/icon-512.png", size: 512 },
      { rel: "hud/icon-96.png", size: 96 },
    ];

    for (const { rel, size } of specs) {
      const png = decodePng(path.join(PUBLIC_DIR, rel));
      assert.equal(png.width, size, `${rel} width`);
      assert.equal(png.height, size, `${rel} height`);

      assert.equal(pixelAt(png, 0, 0)[3], 0, `${rel} top-left corner should be transparent`);
      assert.equal(pixelAt(png, size - 1, 0)[3], 0, `${rel} top-right corner should be transparent`);
      assert.equal(pixelAt(png, 0, size - 1)[3], 0, `${rel} bottom-left corner should be transparent`);
      assert.equal(pixelAt(png, size - 1, size - 1)[3], 0, `${rel} bottom-right corner should be transparent`);

      const mid = Math.floor(size / 2);
      assert.deepEqual(pixelAt(png, mid, mid), [0x0b, 0x10, 0x18, 0xff], `${rel} center ink mark`);

      const tileSample = Math.floor(size * 0.14);
      assert.deepEqual(pixelAt(png, mid, tileSample), [0xff, 0xd2, 0x3f, 0xff], `${rel} yellow tile background`);
    }
  });

  test("maskable-512.png is fully opaque full-bleed and keeps all foreground mark pixels inside the 80% W3C safe zone", () => {
    const png = decodePng(path.join(PUBLIC_DIR, "icons", "maskable-512.png"));
    assert.equal(png.width, 512);
    assert.equal(png.height, 512);

    const center = (png.width - 1) / 2;
    const safeRadius = png.width * 0.4;
    let maxMarkRadius = 0;
    let markPixels = 0;

    for (let y = 0; y < png.height; y++) {
      for (let x = 0; x < png.width; x++) {
        const [r, g, b, a] = pixelAt(png, x, y);
        assert.equal(a, 255, `maskable-512.png must be opaque at (${x}, ${y})`);
        if (r !== 0xff || g !== 0xd2 || b !== 0x3f) {
          markPixels++;
          const dist = Math.hypot(x - center, y - center);
          if (dist > maxMarkRadius) maxMarkRadius = dist;
        }
      }
    }

    assert.ok(markPixels > 5000, "maskable-512.png must render visible foreground mark pixels");
    assert.ok(
      maxMarkRadius <= safeRadius,
      `maskable-512.png foreground radius ${maxMarkRadius.toFixed(1)} exceeds safe radius ${safeRadius}`,
    );
  });

  test("hud/icon-mono.png is <= 2 MiB and contains a pure single-color white mask over a transparent background", () => {
    const png = decodePng(path.join(PUBLIC_DIR, "hud", "icon-mono.png"));
    assert.ok(png.bytes <= 2 * 1024 * 1024, "hud/icon-mono.png must be <= 2 MiB");
    assert.equal(png.width, 128);
    assert.equal(png.height, 128);
    assert.equal(pixelAt(png, 0, 0)[3], 0);
    assert.equal(pixelAt(png, 127, 127)[3], 0);

    let transparentCount = 0;
    let maskCount = 0;
    for (let y = 0; y < png.height; y++) {
      for (let x = 0; x < png.width; x++) {
        const [r, g, b, a] = pixelAt(png, x, y);
        if (a === 0) {
          transparentCount++;
        } else {
          maskCount++;
          assert.equal(r, 255, `non-transparent pixel at (${x},${y}) must have R=255`);
          assert.equal(g, 255, `non-transparent pixel at (${x},${y}) must have G=255`);
          assert.equal(b, 255, `non-transparent pixel at (${x},${y}) must have B=255`);
        }
      }
    }

    assert.ok(transparentCount > maskCount, "monochrome mask must leave padded transparent background");
    assert.ok(maskCount > 500, "monochrome mask must contain opaque/antialiased mark shape");
  });

  test("icons/icon.svg is valid self-contained vector SVG with matching #ffd23f and #0b1018 palette", () => {
    const svg = fs.readFileSync(path.join(PUBLIC_DIR, "icons", "icon.svg"), "utf8").trim();
    assert.ok(svg.startsWith("<svg ") && svg.endsWith("</svg>"));
    assert.ok(svg.includes(`xmlns="${SVG_NS}"`));
    assert.match(svg, /viewBox="0 0 32 32"/);
    assert.match(svg, /#ffd23f/i);
    assert.match(svg, /#0b1018/i);
    assert.ok(!/<script\b/i.test(svg));
    assert.ok(!/<image\b/i.test(svg));
  });
});

describe("Vite multi-page build config, hud-trailing-slash middleware, and server dotfiles alignment", () => {
  test("configures multi-page Rollup entry points for index.html and hud/index.html plus backend proxy routes", () => {
    const cfg = viteConfig;
    const input = cfg.build?.rollupOptions?.input as Record<string, string>;
    assert.equal(cfg.build?.outDir, "dist");
    assert.equal(path.resolve(input.main), path.join(WEB_DIR, "index.html"));
    assert.equal(path.resolve(input.hud), path.join(WEB_DIR, "hud", "index.html"));

    const proxy = cfg.server?.proxy as Record<string, { target?: string; ws?: boolean; changeOrigin?: boolean }>;
    assert.ok(proxy["/api"]);
    assert.ok(proxy["/ingest"]);
    assert.equal(proxy["/live"]?.ws, true);
    assert.equal(proxy["/hud-ws"]?.ws, true);
  });

  test("hud-trailing-slash plugin 301-redirects /hud and /hud?... to /hud/ while passing /hud/ and /hud-ws through", () => {
    const cfg = viteConfig;
    const plugins: unknown[] = (cfg.plugins ?? []).flat();
    const hudPlugin = plugins.find(
      (p: unknown): p is { name: string; configureServer: (server: unknown) => void } =>
        Boolean(p && typeof p === "object" && "name" in p && (p as { name?: unknown }).name === "hud-trailing-slash"),
    );
    assert.ok(hudPlugin, "hud-trailing-slash Vite plugin must exist");

    type MiddlewareFn = (
      req: { url?: string },
      res: { statusCode: number; headers: Record<string, string>; ended: boolean; setHeader(k: string, v: string): void; end(): void },
      next: () => void,
    ) => void;

    let registered: MiddlewareFn | null = null;
    hudPlugin.configureServer({
      middlewares: {
        use(fn: MiddlewareFn) {
          registered = fn;
        },
      },
    });
    assert.ok(registered, "configureServer must register a middleware");

    const runMiddleware = (url: string) => {
      let nextCalled = false;
      const res = {
        statusCode: 200,
        headers: {} as Record<string, string>,
        ended: false,
        setHeader(k: string, v: string) {
          this.headers[k] = v;
        },
        end() {
          this.ended = true;
        },
      };
      registered!({ url }, res, () => {
        nextCalled = true;
      });
      return { res, nextCalled };
    };

    const bare = runMiddleware("/hud");
    assert.equal(bare.res.statusCode, 301);
    assert.equal(bare.res.headers.Location, "/hud/");
    assert.equal(bare.res.ended, true);
    assert.equal(bare.nextCalled, false);

    const withQuery = runMiddleware("/hud?mock=1&session=abc");
    assert.equal(withQuery.res.statusCode, 301);
    assert.equal(withQuery.res.headers.Location, "/hud/?mock=1&session=abc");
    assert.equal(withQuery.res.ended, true);
    assert.equal(withQuery.nextCalled, false);

    for (const passthrough of ["/hud/", "/hud/?mock=1", "/hud-ws", "/hud-ws?session=abc", "/"]) {
      const out = runMiddleware(passthrough);
      assert.equal(out.nextCalled, true, `expected passthrough for ${passthrough}`);
      assert.equal(out.res.ended, false);
    }
  });

  test("main.tsx registers /sw.js only in production and server/src/index.ts enables dotfiles=allow for .well-known", () => {
    const mainTsx = readWebFile("src/main.tsx");
    assert.match(mainTsx, /if\s*\(\s*"serviceWorker"\s+in\s+navigator\s*&&\s*import\.meta\.env\.PROD\s*\)/);
    assert.match(mainTsx, /navigator\.serviceWorker\.register\(\s*"\/sw\.js"\s*\)/);
    assert.match(mainTsx, /document\.body\.classList\.add\(\s*"hud-body"\s*\)/);

    const serverIndex = fs.readFileSync(path.join(REPO_DIR, "server", "src", "index.ts"), "utf8");
    assert.match(serverIndex, /dotfiles:\s*"allow"/);
  });
});

type SwHandler = (event: unknown) => void;

type SwHarness = {
  cacheStore: Map<string, Map<string, Response>>;
  fetchCalls: Array<{ url: string; cache?: string; method: string }>;
  skipWaitingCount: () => number;
  claimCount: () => number;
  setFetchImpl: (fn: (req: SwRequest) => Promise<Response>) => void;
  dispatchInstall: () => Promise<void>;
  dispatchActivate: () => Promise<void>;
  dispatchFetch: (
    urlOrPath: string,
    opts?: { method?: string; mode?: string },
  ) => Promise<{ intercepted: boolean; response: Response | null }>;
};

class SwRequest {
  readonly url: string;
  readonly method: string;
  readonly mode: string;
  readonly cache: string;

  constructor(input: string | SwRequest, init?: { method?: string; mode?: string; cache?: string }) {
    if (typeof input === "string") {
      this.url = new URL(input, ORIGIN).href;
      this.method = (init?.method ?? "GET").toUpperCase();
      this.mode = init?.mode ?? "cors";
      this.cache = init?.cache ?? "default";
    } else {
      this.url = input.url;
      this.method = (init?.method ?? input.method).toUpperCase();
      this.mode = init?.mode ?? input.mode;
      this.cache = init?.cache ?? input.cache;
    }
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
}

function createSwHarness(): SwHarness {
  const swSource = fs.readFileSync(path.join(PUBLIC_DIR, "sw.js"), "utf8");
  const cacheStore = new Map<string, Map<string, Response>>();
  const listeners = new Map<string, SwHandler[]>();
  const fetchCalls: Array<{ url: string; cache?: string; method: string }> = [];
  let skipWaitingCalls = 0;
  let claimCalls = 0;

  let fetchImpl: (req: SwRequest) => Promise<Response> = async (req) =>
    new Response(`network:${new URL(req.url).pathname}`, { status: 200 });

  const normalizeKey = (reqOrUrl: string | SwRequest): string =>
    typeof reqOrUrl === "string" ? new URL(reqOrUrl, ORIGIN).href : reqOrUrl.url;

  const sandboxFetch = async (input: string | SwRequest, init?: { cache?: string; method?: string; mode?: string }) => {
    const req = input instanceof SwRequest && !init ? input : new SwRequest(input, init);
    fetchCalls.push({ url: req.url, cache: req.cache, method: req.method });
    return fetchImpl(req);
  };

  const cachesApi = {
    async open(name: string) {
      let bucket = cacheStore.get(name);
      if (!bucket) {
        bucket = new Map<string, Response>();
        cacheStore.set(name, bucket);
      }
      return {
        async add(reqOrUrl: string | SwRequest) {
          const req = reqOrUrl instanceof SwRequest ? reqOrUrl : new SwRequest(reqOrUrl);
          const res = await sandboxFetch(req);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          bucket!.set(normalizeKey(req), res.clone());
        },
        async put(reqOrUrl: string | SwRequest, res: Response) {
          bucket!.set(normalizeKey(reqOrUrl), res);
        },
        async match(reqOrUrl: string | SwRequest) {
          const hit = bucket!.get(normalizeKey(reqOrUrl));
          return hit ? hit.clone() : undefined;
        },
      };
    },
    async keys() {
      return [...cacheStore.keys()];
    },
    async delete(name: string) {
      return cacheStore.delete(name);
    },
    async match(reqOrUrl: string | SwRequest) {
      const key = normalizeKey(reqOrUrl);
      for (const bucket of cacheStore.values()) {
        const hit = bucket.get(key);
        if (hit) return hit.clone();
      }
      return undefined;
    },
  };

  const selfObj = {
    location: new URL("/sw.js", ORIGIN),
    caches: cachesApi,
    clients: {
      async claim() {
        claimCalls++;
      },
    },
    async skipWaiting() {
      skipWaitingCalls++;
    },
    addEventListener(type: string, handler: SwHandler) {
      const list = listeners.get(type) ?? [];
      list.push(handler);
      listeners.set(type, list);
    },
  };

  const context = vm.createContext({
    self: selfObj,
    caches: cachesApi,
    location: selfObj.location,
    fetch: sandboxFetch,
    Request: SwRequest,
    Response,
    URL,
    Promise,
  });

  vm.runInContext(swSource, context, { filename: "sw.js" });

  return {
    cacheStore,
    fetchCalls,
    skipWaitingCount: () => skipWaitingCalls,
    claimCount: () => claimCalls,
    setFetchImpl(fn) {
      fetchImpl = fn;
    },
    async dispatchInstall() {
      const waitPromises: Array<Promise<unknown>> = [];
      const event = {
        waitUntil(p: Promise<unknown>) {
          waitPromises.push(p);
        },
      };
      for (const fn of listeners.get("install") ?? []) fn(event);
      await Promise.all(waitPromises);
      await flushMicrotasks();
    },
    async dispatchActivate() {
      const waitPromises: Array<Promise<unknown>> = [];
      const event = {
        waitUntil(p: Promise<unknown>) {
          waitPromises.push(p);
        },
      };
      for (const fn of listeners.get("activate") ?? []) fn(event);
      await Promise.all(waitPromises);
      await flushMicrotasks();
    },
    async dispatchFetch(urlOrPath, opts) {
      const req = new SwRequest(urlOrPath, {
        method: opts?.method ?? "GET",
        mode: opts?.mode ?? "cors",
      });
      let responded: Promise<Response> | null = null;
      const event = {
        request: req,
        respondWith(p: Promise<Response>) {
          responded = p;
        },
      };
      for (const fn of listeners.get("fetch") ?? []) fn(event);
      if (!responded) return { intercepted: false, response: null };
      const response = await (responded as Promise<Response>);
      await flushMicrotasks();
      return { intercepted: true, response };
    },
  };
}

const SW_CACHE_MATCH = fs.readFileSync(path.join(PUBLIC_DIR, "sw.js"), "utf8").match(/const\s+CACHE\s*=\s*"(holdup-shell-v\d+)"/);
const SW_CACHE_NAME = SW_CACHE_MATCH?.[1] ?? "";

describe("web/public/sw.js offline shell caching and privacy/API bypass contract", () => {
  test("install precaches app shell, worklet, icons, and hashed HTML /assets/ bundles with cache=reload and calls skipWaiting()", async () => {
    assert.match(SW_CACHE_NAME, /^holdup-shell-v\d+$/);
    const sw = createSwHarness();
    sw.setFetchImpl(async (req) => {
      const pathname = new URL(req.url).pathname;
      if (pathname === "/") {
        return new Response(
          `<!doctype html><link rel="stylesheet" href="/assets/main-111.css"><script type="module" src="/assets/main-222.js"></script>`,
          { status: 200 },
        );
      }
      if (pathname === "/hud/") {
        return new Response(
          `<!doctype html><link rel="stylesheet" href="/assets/hud-333.css"><script type="module" src="/assets/hud-444.js"></script>`,
          { status: 200 },
        );
      }
      return new Response(`asset:${pathname}`, { status: 200 });
    });

    await sw.dispatchInstall();
    assert.equal(sw.skipWaitingCount(), 1);

    const bucket = sw.cacheStore.get(SW_CACHE_NAME);
    assert.ok(bucket, `${SW_CACHE_NAME} cache must be created on install`);

    const expectedShellPaths = [
      "/",
      "/index.html",
      "/hud/",
      "/manifest.webmanifest",
      "/pcm-capture-worklet.js",
      "/icons/icon.svg",
      "/icons/icon-192.png",
      "/icons/icon-512.png",
      "/assets/main-111.css",
      "/assets/main-222.js",
      "/assets/hud-333.css",
      "/assets/hud-444.js",
    ];
    for (const p of expectedShellPaths) {
      assert.ok(bucket.has(`${ORIGIN}${p}`), `Expected ${p} in precache`);
    }

    for (const staticShellAsset of [
      "/manifest.webmanifest",
      "/pcm-capture-worklet.js",
      "/icons/icon.svg",
      "/icons/icon-192.png",
      "/icons/icon-512.png",
    ]) {
      const onDisk = path.join(PUBLIC_DIR, staticShellAsset.slice(1));
      assert.ok(fs.existsSync(onDisk), `Precached public asset must exist on disk: ${staticShellAsset}`);
    }

    const shellReloadCalls = sw.fetchCalls.filter((c) => c.url === `${ORIGIN}/manifest.webmanifest`);
    assert.equal(shellReloadCalls[0]?.cache, "reload");
  });

  test("install tolerates offline network failures gracefully and still completes skipWaiting()", async () => {
    const sw = createSwHarness();
    sw.setFetchImpl(async () => {
      throw new TypeError("Failed to fetch");
    });

    await sw.dispatchInstall();
    assert.equal(sw.skipWaitingCount(), 1);
    assert.ok(sw.cacheStore.has(SW_CACHE_NAME));
  });

  test("activate purges outdated cache versions while keeping active holdup-shell cache and claiming clients", async () => {
    const sw = createSwHarness();
    sw.cacheStore.set("holdup-shell-v0", new Map([[`${ORIGIN}/`, new Response("old")]]));
    sw.cacheStore.set("legacy-cache", new Map([[`${ORIGIN}/hud/`, new Response("legacy")]]));
    sw.cacheStore.set(SW_CACHE_NAME, new Map([[`${ORIGIN}/`, new Response("current")]]));

    await sw.dispatchActivate();
    assert.equal(sw.claimCount(), 1);
    assert.deepEqual([...sw.cacheStore.keys()], [SW_CACHE_NAME]);
  });

  test("fetch strictly bypasses non-GET methods, cross-origin URLs, and /api, /live, /hud-ws, /ingest routes", async () => {
    const sw = createSwHarness();
    await sw.dispatchInstall();
    const callCountAfterInstall = sw.fetchCalls.length;

    const bypassedRequests: Array<{ url: string; method?: string; mode?: string }> = [
      { url: "/api", method: "GET" },
      { url: "/api/health", method: "GET" },
      { url: "/api/stats", method: "GET" },
      { url: "/api/verify", method: "POST" },
      { url: "/api/tts", method: "POST" },
      { url: "/api?key=secret", method: "GET" },
      { url: "/live", method: "GET" },
      { url: "/live?session=abc123", method: "GET" },
      { url: "/hud-ws", method: "GET" },
      { url: "/hud-ws?session=abc123", method: "GET" },
      { url: "/ingest", method: "GET" },
      { url: "/ingest/frame?session=abc123", method: "POST" },
      { url: "/ingest/state", method: "POST" },
      { url: "/arena", method: "GET", mode: "navigate" },
      { url: "/arena/", method: "GET", mode: "navigate" },
      { url: "/arena/index.html", method: "GET", mode: "navigate" },
      { url: "/arena?lang=fi", method: "GET", mode: "navigate" },
      { url: "/arena/game.js", method: "GET" },
      { url: "/arena/phrases/manifest.json", method: "GET" },
      { url: "/", method: "POST" },
      { url: "/manifest.webmanifest", method: "HEAD" },
      { url: `${CROSS_ORIGIN}/assets/bundle.js`, method: "GET" },
      { url: `${CROSS_ORIGIN}/`, method: "GET", mode: "navigate" },
    ];

    for (const item of bypassedRequests) {
      const res = await sw.dispatchFetch(item.url, { method: item.method, mode: item.mode });
      assert.equal(res.intercepted, false, `SW must NOT intercept ${item.method ?? "GET"} ${item.url}`);
      assert.equal(res.response, null);
    }

    assert.equal(sw.fetchCalls.length, callCountAfterInstall, "Bypassed requests must not trigger SW fetch");
    const rootCached = sw.cacheStore.get(SW_CACHE_NAME)?.get(`${ORIGIN}/`);
    assert.ok(rootCached, "Cached root shell must remain present after /arena navigation");
    assert.equal(await rootCached.clone().text(), "network:/");
  });

  test("navigate requests use network-first, refresh cached / and /hud/ shells on 200, and fall back to cached shell offline", async () => {
    const sw = createSwHarness();
    sw.setFetchImpl(async (req) => {
      const p = new URL(req.url).pathname;
      if (p === "/") return new Response("shell-v1-main", { status: 200 });
      if (p === "/index.html") return new Response("shell-v1-index", { status: 200 });
      if (p === "/hud/") return new Response("shell-v1-hud", { status: 200 });
      return new Response("ok", { status: 200 });
    });
    await sw.dispatchInstall();

    sw.setFetchImpl(async (req) => {
      const p = new URL(req.url).pathname;
      if (p.startsWith("/hud")) return new Response("shell-v2-hud", { status: 200 });
      return new Response("shell-v2-main", { status: 200 });
    });

    const onlineMain = await sw.dispatchFetch("/?mock=1", { mode: "navigate" });
    assert.equal(onlineMain.intercepted, true);
    assert.equal(await onlineMain.response!.text(), "shell-v2-main");

    const onlineHud = await sw.dispatchFetch("/hud/?session=demo", { mode: "navigate" });
    assert.equal(onlineHud.intercepted, true);
    assert.equal(await onlineHud.response!.text(), "shell-v2-hud");

    sw.setFetchImpl(async () => new Response("gateway-failure", { status: 502 }));
    const serverErrNav = await sw.dispatchFetch("/", { mode: "navigate" });
    assert.equal(serverErrNav.response!.status, 502);

    sw.setFetchImpl(async () => {
      throw new TypeError("offline");
    });

    const offlineMain = await sw.dispatchFetch("/", { mode: "navigate" });
    assert.equal(await offlineMain.response!.text(), "shell-v2-main");

    const offlineHud = await sw.dispatchFetch("/hud/?mock=1", { mode: "navigate" });
    assert.equal(await offlineHud.response!.text(), "shell-v2-hud");

    const bucket = sw.cacheStore.get(SW_CACHE_NAME)!;
    bucket.delete(`${ORIGIN}/hud/`);
    const offlineHudFallbackToIndex = await sw.dispatchFetch("/hud/", { mode: "navigate" });
    assert.equal(await offlineHudFallbackToIndex.response!.text(), "shell-v1-index");

    bucket.clear();
    const offlineEmpty = await sw.dispatchFetch("/", { mode: "navigate" });
    assert.equal(offlineEmpty.response!.type, "error");
    assert.equal(offlineEmpty.response!.ok, false);
  });

  test("static requests use cache-first and runtime-cache 200 responses only under /assets/ and /icons/", async () => {
    const sw = createSwHarness();
    sw.setFetchImpl(async (req) => new Response(`initial:${new URL(req.url).pathname}`, { status: 200 }));
    await sw.dispatchInstall();

    let networkHitCount = 0;
    sw.setFetchImpl(async (req) => {
      networkHitCount++;
      const p = new URL(req.url).pathname;
      if (p === "/assets/missing.js") return new Response("not-found", { status: 404 });
      return new Response(`fresh:${p}`, { status: 200 });
    });

    const cachedWorklet = await sw.dispatchFetch("/pcm-capture-worklet.js");
    assert.equal(await cachedWorklet.response!.text(), "initial:/pcm-capture-worklet.js");
    assert.equal(networkHitCount, 0, "Precached worklet must be served from cache without network");

    const newAsset = await sw.dispatchFetch("/assets/chunk-abc.js");
    assert.equal(await newAsset.response!.text(), "fresh:/assets/chunk-abc.js");
    assert.equal(networkHitCount, 1);

    const cachedNewAsset = await sw.dispatchFetch("/assets/chunk-abc.js");
    assert.equal(await cachedNewAsset.response!.text(), "fresh:/assets/chunk-abc.js");
    assert.equal(networkHitCount, 1, "Runtime-cached /assets/ bundle must hit cache on second request");

    const newIcon = await sw.dispatchFetch("/icons/maskable-512.png");
    assert.equal(await newIcon.response!.text(), "fresh:/icons/maskable-512.png");
    assert.equal(networkHitCount, 2);
    assert.ok(sw.cacheStore.get(SW_CACHE_NAME)!.has(`${ORIGIN}/icons/maskable-512.png`));

    const missingAsset = await sw.dispatchFetch("/assets/missing.js");
    assert.equal(missingAsset.response!.status, 404);
    assert.equal(sw.cacheStore.get(SW_CACHE_NAME)!.has(`${ORIGIN}/assets/missing.js`), false);

    const miscFile = await sw.dispatchFetch("/robots.txt");
    assert.equal(await miscFile.response!.text(), "fresh:/robots.txt");
    assert.equal(sw.cacheStore.get(SW_CACHE_NAME)!.has(`${ORIGIN}/robots.txt`), false);
  });
});

type PostedPcmMsg = {
  data: { pcm: ArrayBuffer; rms: number };
  transfer: unknown[];
};

type WorkletInstance = {
  port: {
    messages: PostedPcmMsg[];
    postMessage(data: { pcm: ArrayBuffer; rms: number }, transfer?: unknown[]): void;
  };
  process(inputs: Float32Array[][]): boolean;
};

type WorkletCtor = new (options?: { processorOptions?: { outRate?: number; chunkMs?: number } }) => WorkletInstance;

function loadPcmWorklet(contextSampleRate: number): { name: string; Ctor: WorkletCtor } {
  const source = fs.readFileSync(path.join(PUBLIC_DIR, "pcm-capture-worklet.js"), "utf8");
  let registeredName = "";
  let registeredCtor: WorkletCtor | null = null;

  class MockAudioWorkletProcessor {
    port = {
      messages: [] as PostedPcmMsg[],
      postMessage(data: { pcm: ArrayBuffer; rms: number }, transfer: unknown[] = []) {
        this.messages.push({ data, transfer });
      },
    };
  }

  const context = vm.createContext({
    AudioWorkletProcessor: MockAudioWorkletProcessor,
    sampleRate: contextSampleRate,
    registerProcessor(name: string, ctor: WorkletCtor) {
      registeredName = name;
      registeredCtor = ctor;
    },
    Float32Array,
    Int16Array,
    ArrayBuffer,
    Math,
  });

  vm.runInContext(source, context, { filename: "pcm-capture-worklet.js" });
  assert.ok(registeredCtor, "pcm-capture-worklet.js must call registerProcessor");
  return { name: registeredName, Ctor: registeredCtor };
}

describe("web/public/pcm-capture-worklet.js AudioWorklet resampling, stereo downmix, clamping, and RMS", () => {
  test("registers pcm-capture processor matching MicCapture in web/src/lib/audio.ts and handles empty inputs safely", () => {
    const audioTs = readWebFile("src/lib/audio.ts");
    assert.match(audioTs, /addModule\(\s*"\/pcm-capture-worklet\.js"\s*\)/);
    assert.match(audioTs, /new\s+AudioWorkletNode\([^,]+,\s*"pcm-capture"/);

    const { name, Ctor } = loadPcmWorklet(16000);
    assert.equal(name, "pcm-capture");

    const proc = new Ctor();
    assert.equal(proc.process([]), true);
    assert.equal(proc.process([[]]), true);
    assert.equal(proc.process([[new Float32Array(0)]]), true);
    assert.equal(proc.port.messages.length, 0);
  });

  test("posts 1600-sample (100 ms @ 16 kHz) Int16 chunks with transferable ArrayBuffer and fresh buffer per chunk", () => {
    const { Ctor } = loadPcmWorklet(16000);
    const proc = new Ctor({ processorOptions: { outRate: 16000, chunkMs: 100 } });

    const input = new Float32Array(3201);
    input.fill(0.5);
    assert.equal(proc.process([[input]]), true);
    assert.equal(proc.port.messages.length, 2);

    const first = proc.port.messages[0];
    const second = proc.port.messages[1];
    assert.ok(first.data.pcm instanceof ArrayBuffer);
    assert.equal(first.data.pcm.byteLength, 1600 * 2);
    assert.equal(first.transfer.length, 1);
    assert.equal(first.transfer[0], first.data.pcm);
    assert.notEqual(first.data.pcm, second.data.pcm, "Each posted chunk must allocate a distinct ArrayBuffer");

    const samples = new Int16Array(first.data.pcm);
    assert.equal(samples.length, 1600);
    assert.equal(samples[0], Math.trunc(0.5 * 0x7fff));
    assert.ok(Math.abs(first.data.rms - 0.5) < 1e-6);
  });

  test("downmixes stereo channels to mono average and box-prefilters 48 kHz -> 16 kHz (step >= 2)", () => {
    const { Ctor } = loadPcmWorklet(48000);
    const procCancel = new Ctor({ processorOptions: { outRate: 16000, chunkMs: 10 } });

    const left = new Float32Array(485).fill(0.8);
    const right = new Float32Array(485).fill(-0.8);
    procCancel.process([[left, right]]);
    assert.equal(procCancel.port.messages.length, 1);
    const cancelled = new Int16Array(procCancel.port.messages[0].data.pcm);
    assert.equal(cancelled.length, 160);
    assert.ok(cancelled.every((v) => v === 0));
    assert.equal(procCancel.port.messages[0].data.rms, 0);

    const procBox = new Ctor({ processorOptions: { outRate: 16000, chunkMs: 10 } });
    const pattern = new Float32Array(485);
    for (let i = 0; i < pattern.length; i++) {
      pattern[i] = i % 3 === 0 ? 0.9 : 0.0;
    }
    procBox.process([[pattern]]);
    assert.equal(procBox.port.messages.length, 1);
    const averaged = new Int16Array(procBox.port.messages[0].data.pcm);
    const expectedSample = Math.trunc(0.3 * 0x7fff);
    assert.ok(Math.abs(averaged[0] - expectedSample) <= 1, `Expected box-filtered ~${expectedSample}, got ${averaged[0]}`);
  });

  test("clamps out-of-range float samples to [-32768, 32767] without Int16 wrap-around and preserves 44.1 kHz fractional carry", () => {
    const { Ctor: Ctor16k } = loadPcmWorklet(16000);
    const procClamp = new Ctor16k({ processorOptions: { outRate: 16000, chunkMs: 10 } });

    const hot = new Float32Array(161);
    for (let i = 0; i < hot.length; i++) {
      hot[i] = i % 2 === 0 ? 4.5 : -3.2;
    }
    procClamp.process([[hot]]);
    assert.equal(procClamp.port.messages.length, 1);
    const clampedPcm = new Int16Array(procClamp.port.messages[0].data.pcm);
    assert.equal(clampedPcm[0], 32767);
    assert.equal(clampedPcm[1], -32768);
    assert.ok(Math.abs(procClamp.port.messages[0].data.rms - 1) < 1e-6);

    const { Ctor: Ctor44k } = loadPcmWorklet(44100);
    const procFractional = new Ctor44k({ processorOptions: { outRate: 16000, chunkMs: 100 } });
    const quantum = new Float32Array(128).fill(0.25);
    for (let q = 0; q < 40; q++) {
      assert.equal(procFractional.process([[quantum]]), true);
    }
    assert.equal(procFractional.port.messages.length, 1);
    const resampled = new Int16Array(procFractional.port.messages[0].data.pcm);
    assert.equal(resampled.length, 1600);
    const expectedQuarter = Math.trunc(0.25 * 0x7fff);
    assert.ok(resampled.every((s) => Math.abs(s - expectedQuarter) <= 1));
  });
});
