import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  FrameRing as WebFrameRing,
  captureFrame,
  normaliseSharpness,
  policyForRtt,
  shouldSend,
} from "../src/lib/frames.ts";
import { classifyError, explain, platformHint } from "../src/lib/media.ts";
import {
  CONSENT_VERSION,
  deleteAllData,
  demoProfile,
  loadConsent,
  loadProfile,
  loadSettings,
  logDose,
  saveConsent,
  saveProfile,
  saveSettings,
  sessionCode,
} from "../src/lib/storage.ts";
import {
  findByBarcode,
  findByGtin,
  matchVerdict,
  offlineUnknownBarcode,
  offlineUnknownCode,
} from "../src/lib/verdicts.ts";
import { env } from "../../server/src/env.ts";
import { Hub } from "../../server/src/hub.ts";
import { TOOLS, VERDICT_LEAD, leadFor, toolsFor } from "../../server/src/live.ts";
import { errSummary, redact, shortId } from "../../server/src/log.ts";
import {
  ALLERGEN_SAFE_CONF,
  MATCH_MIN_READABILITY,
  MATCH_NAME_MIN_CONF,
  STRENGTH_MIN_CONF,
  checkLabel,
} from "../../server/src/safety.ts";
import { SPEC, Speculator } from "../../server/src/speculate.ts";
import {
  FrameRing as ServerFrameRing,
  LABEL_SCHEMA,
  VERIFY_PROMPT,
  jpegSharpness,
  toLabelRead,
  unreadable,
  type Frame as ServerFrame,
} from "../../server/src/verify.ts";

const TEST_FILE = fileURLToPath(import.meta.url);
const TEST_DIR = path.dirname(TEST_FILE);
const REPO_DIR = path.resolve(TEST_DIR, "..", "..");

const LINE_COMMENT_TOKEN = ["\x2f", "\x2f"].join("");
const BLOCK_COMMENT_TOKEN = ["\x2f", "*"].join("");
const HTML_COMMENT_TOKEN = ["<!", "--"].join("");
const EM_DASH = String.fromCharCode(0x2014);
const ESCAPED_EM_DASH = ["\\", "u2014"].join("");
const LIVE_SECRET_PREFIXES = [
  ["AI", "za"].join(""),
  ["AQ", "."].join(""),
  ["sk", "-"].join(""),
  ["sk", "_"].join(""),
  ["ghp", "_"].join(""),
  ["github", "_pat_"].join(""),
  ["AK", "IA"].join(""),
];

function readRepoFile(relPath: string): string {
  return fs.readFileSync(path.join(REPO_DIR, relPath), "utf8");
}

function decodeHtmlEntities(raw: string): string {
  const named: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
    "&nbsp;": " ",
    "&middot;": "\u00b7",
    "&ldquo;": "\u201c",
    "&rdquo;": "\u201d",
    "&lsquo;": "\u2018",
    "&rsquo;": "\u2019",
    "&ndash;": "\u2013",
    "&times;": "\u00d7",
    "&le;": "\u2264",
    "&ge;": "\u2265",
    "&rarr;": "\u2192",
  };
  return raw
    .replace(/&#(\d+);/g, (_all, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_all, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&[a-zA-Z0-9#]+;/g, (ent) => named[ent] ?? ent);
}

function stripTags(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

function extractSlides(deckHtml: string): string[] {
  const slidePattern = new RegExp("<section\\s+class=\"slide(?:\\s+[^\"]*)?\"[\\s\\S]*?<\\x2fsection>", "g");
  return deckHtml.match(slidePattern) ?? [];
}

function findSlideByHeadingId(slides: string[], headingId: string): string {
  const slide = slides.find((s) => s.includes(`id="${headingId}"`));
  assert.ok(slide, `Expected slide with heading id="${headingId}"`);
  return slide;
}

function extractH2Sections(markdown: string): Array<{ heading: string; body: string }> {
  const lines = markdown.split("\n");
  const sections: Array<{ heading: string; startLine: number; endLine: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      if (sections.length > 0) {
        sections[sections.length - 1].endLine = i;
      }
      sections.push({
        heading: lines[i].slice(3).trim(),
        startLine: i + 1,
        endLine: lines.length,
      });
    }
  }
  return sections.map((s) => ({
    heading: s.heading,
    body: lines.slice(s.startLine, s.endLine).join("\n").trim(),
  }));
}

function parseMarkdownTableRows(sectionBody: string): string[][] {
  const tableLines = sectionBody
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|"));
  assert.ok(tableLines.length >= 3, "Expected markdown table with header, separator, and body rows");
  return tableLines.slice(2).map((row) =>
    row
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim()),
  );
}

function walkFilesUnder(absDir: string): string[] {
  const skipped = new Set(["node_modules", ".git", ".gradle", "build", "dist"]);
  const found: string[] = [];
  if (!fs.existsSync(absDir)) return found;
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    if (skipped.has(entry.name)) continue;
    const full = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      found.push(...walkFilesUnder(full));
    } else if (entry.isFile()) {
      found.push(full);
    }
  }
  return found;
}

function createMemoryStorage(): Storage {
  const store: Record<string, string> = {};
  const proto = {
    get length(): number {
      return Object.keys(store).length;
    },
    key(index: number): string | null {
      return Object.keys(store)[index] ?? null;
    },
    getItem(key: string): string | null {
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
    },
    setItem(key: string, value: string): void {
      store[key] = String(value);
    },
    removeItem(key: string): void {
      delete store[key];
    },
    clear(): void {
      for (const k of Object.keys(store)) delete store[k];
    },
  };
  for (const k of Object.keys(proto)) {
    Object.defineProperty(proto, k, { enumerable: false });
  }
  return Object.setPrototypeOf(store, proto) as unknown as Storage;
}

function withMockBrowserStorage(run: (ctx: { local: Storage; session: Storage; cachesSet: Set<string> }) => Promise<void> | void) {
  return async () => {
    const g = globalThis as Record<string, unknown>;
    const savedKeys = ["localStorage", "sessionStorage", "window", "caches", "location", "navigator"] as const;
    const prev = new Map<string, { had: boolean; value: unknown }>();
    for (const k of savedKeys) {
      prev.set(k, { had: k in g, value: g[k] });
    }

    const local = createMemoryStorage();
    const session = createMemoryStorage();
    const cachesSet = new Set<string>(["holdup-shell-v1", "holdup-assets-v1"]);
    const cacheMock = {
      async keys() {
        return [...cachesSet];
      },
      async delete(name: string) {
        return cachesSet.delete(name);
      },
    };
    const origin = ["https:", "", "holdup.example"].join("\x2f");

    Object.defineProperty(globalThis, "localStorage", { value: local, configurable: true, writable: true });
    Object.defineProperty(globalThis, "sessionStorage", { value: session, configurable: true, writable: true });
    Object.defineProperty(globalThis, "window", { value: { caches: cacheMock }, configurable: true, writable: true });
    Object.defineProperty(globalThis, "caches", { value: cacheMock, configurable: true, writable: true });
    Object.defineProperty(globalThis, "location", { value: { origin, search: "" }, configurable: true, writable: true });
    Object.defineProperty(globalThis, "navigator", { value: { language: "en-US" }, configurable: true, writable: true });

    try {
      await run({ local, session, cachesSet });
    } finally {
      for (const [k, entry] of prev.entries()) {
        if (entry.had) {
          Object.defineProperty(globalThis, k, { value: entry.value, configurable: true, writable: true });
        } else {
          Reflect.deleteProperty(globalThis, k);
        }
      }
    }
  };
}

function makeServerFrame(idx: number, sharpness = 0.75, source: "phone" | "glasses" = "phone"): ServerFrame {
  return {
    data: Buffer.alloc(96, idx + 1).toString("base64"),
    sharpness,
    ts: 100_000 + idx * 100,
    bytes: 96,
    source,
  };
}

describe("Deck Slides 6, 8, 9 and docs/PRIVACY.md code-parity contract", () => {
  const deckHtml = readRepoFile("deck/index.html");
  const privacyMd = readRepoFile("docs/PRIVACY.md");
  const gitignore = readRepoFile(".gitignore");
  const serverIndexSrc = readRepoFile("server/src/index.ts");
  const serverLiveSrc = readRepoFile("server/src/live.ts");
  const serverVerifySrc = readRepoFile("server/src/verify.ts");
  const serverSpeculateSrc = readRepoFile("server/src/speculate.ts");
  const serverSafetySrc = readRepoFile("server/src/safety.ts");
  const serverHubSrc = readRepoFile("server/src/hub.ts");
  const serverEnvSrc = readRepoFile("server/src/env.ts");
  const serverLogSrc = readRepoFile("server/src/log.ts");
  const serverLedgerSrc = readRepoFile("server/src/ledger.ts");
  const livePromptMd = readRepoFile("server/src/prompts/live.md");
  const webFramesSrc = readRepoFile("web/src/lib/frames.ts");
  const webAudioSrc = readRepoFile("web/src/lib/audio.ts");
  const webWorkletSrc = readRepoFile("web/public/pcm-capture-worklet.js");
  const webCheckerSrc = readRepoFile("web/src/lib/checker.ts");
  const webLiveSrc = readRepoFile("web/src/lib/live.ts");
  const webStorageSrc = readRepoFile("web/src/lib/storage.ts");
  const webBarcodeSrc = readRepoFile("web/src/lib/barcode.ts");
  const webMediaSrc = readRepoFile("web/src/lib/media.ts");
  const webOnboardingSrc = readRepoFile("web/src/screens/Onboarding.tsx");
  const webHudSrc = readRepoFile("web/src/screens/Hud.tsx");
  const webHudHtml = readRepoFile("web/hud/index.html");
  const hudSpecMd = readRepoFile("docs/HUD_SPEC.md");
  const androidReadme = readRepoFile("android-dat/README.md");
  const androidBridgeVmSrc = readRepoFile("android-dat/app/src/main/java/app/holdup/bridge/BridgeViewModel.kt");
  const androidUploaderSrc = readRepoFile("android-dat/app/src/main/java/app/holdup/bridge/Uploader.kt");
  const androidYuvTestSrc = readRepoFile("android-dat/app/src/test/java/app/holdup/bridge/YuvJpegTest.kt");

  const slides = extractSlides(deckHtml);
  const privacySections = extractH2Sections(privacyMd);

  test("Slide 6 (#s6-h) architecture SVG server routes, 5 Live tools, FrameRing(8), Speculator, safety.ts, HUD replay, and 3-model chains match shipped server code", () => {
    const slide6 = findSlideByHeadingId(slides, "s6-h");
    const svgMatch = new RegExp("<svg\\b[^>]*>[\\s\\S]*?<\\x2fsvg>").exec(slide6);
    assert.ok(svgMatch, "Slide 6 must contain an architecture <svg>");
    const svgHtml = svgMatch[0];

    const titleMatch = new RegExp("<title[^>]*>([\\s\\S]*?)<\\x2ftitle>").exec(svgHtml);
    const descMatch = new RegExp("<desc[^>]*>([\\s\\S]*?)<\\x2fdesc>").exec(svgHtml);
    assert.ok(titleMatch && descMatch, "Slide 6 SVG must include <title> and <desc>");
    const svgDesc = stripTags(descMatch[1]);
    const textPattern = new RegExp("<text\\b[^>]*>([\\s\\S]*?)<\\x2ftext>", "g");
    const svgTextNodes = [...svgHtml.matchAll(textPattern)].map((m) => stripTags(m[1]));
    const svgJoined = svgTextNodes.join(" | ");

    assert.ok(svgDesc.includes("Android DAT bridge"));
    assert.ok(svgDesc.includes("Bluetooth (HFP, 8 kHz mono)"));
    assert.ok(svgDesc.includes("Gemini Live"));
    assert.ok(svgDesc.includes("verify_label"));
    assert.ok(svgDesc.includes("deterministic safety check"));
    assert.ok(svgDesc.includes("Ray-Ban Display HUD"));

    for (const expectedLabel of [
      "/live Live proxy, 5 tools",
      "Frame ring (8, memory only)",
      "Speculative verify cache",
      "verify_label reader",
      "safety.ts rules, no model",
      "/hud-ws fan-out + replay",
      "/ingest glasses frames, state",
      "/api/verify snapshot mode",
      "/api/stats usage ledger",
      "Redacting logger: no content",
      "gemini-3.8-live",
      "+ 2 fallback models",
      "gemini-3.8-flash",
      "confidence · 2 fallbacks",
      "Gemini TTS",
    ]) {
      assert.ok(svgJoined.includes(expectedLabel), `Slide 6 SVG text must include "${expectedLabel}"`);
    }

    assert.equal(TOOLS.length, 3);
    const allTools = toolsFor(new Set(["scene", "addmed"])).map((t) => t.name);
    assert.equal(allTools.length, 5, "Live proxy must expose 5 tools when scene and addmed flags are active");
    assert.deepEqual(
      [...allTools].sort(),
      ["add_medication", "find_item", "log_dose", "show_cue", "verify_label"],
    );

    const ring = new ServerFrameRing();
    for (let i = 0; i < 12; i++) ring.push(makeServerFrame(i));
    assert.equal(ring.length, 8, "Server FrameRing default capacity must be 8");
    ring.clear();
    assert.equal(ring.length, 0);
    assert.equal(serverVerifySrc.includes("writeFile"), false, "verify.ts must never write frames to disk");

    const hub = new Hub("contract-s6");
    assert.ok(hub.spec instanceof Speculator, "Hub must wire a Speculator instance");
    assert.ok(SPEC.freshMs > 0 && SPEC.stableMs >= SPEC.freshMs && SPEC.minGapMs >= 1000);
    for (let i = 0; i < 11; i++) hub.addFrame(makeServerFrame(i));
    assert.equal(hub.ring.length, 8, "Hub.ring must cap memory frames at 8");
    assert.ok(serverSpeculateSrc.includes("class Speculator"));
    assert.ok(serverLiveSrc.includes("this.hub.spec.get()"));

    assert.equal(serverSafetySrc.includes("@google"), false, "safety.ts must not import Gemini SDK");
    assert.equal(serverSafetySrc.includes("fetch("), false, "safety.ts must not perform network calls");
    assert.equal(typeof checkLabel, "function");
    assert.ok(LABEL_SCHEMA && typeof LABEL_SCHEMA === "object");

    const fanoutReceived: string[] = [];
    const replayReceived: string[] = [];
    const liveHudSocket = {
      readyState: 1,
      send(payload: string) {
        fanoutReceived.push(JSON.parse(payload).type);
      },
      on() {},
    };
    const lateHudSocket = {
      readyState: 1,
      send(payload: string) {
        replayReceived.push(JSON.parse(payload).type);
      },
      on() {},
    };
    hub.huds.add(liveHudSocket as never);
    hub.emit({ type: "status", live: "open", detail: "gemini-3.8-live" });
    hub.emit({
      type: "device",
      device: { connected: true, worn: true, battery: 82, streaming: true, source: "glasses" },
    });
    hub.emit({ type: "coach", cue: "closer", text: "Move closer" });
    hub.emit({ type: "verdict", verdict: checkLabel(unreadable(), demoProfile()) });
    assert.deepEqual(fanoutReceived, ["status", "device", "coach", "verdict"]);
    hub.replay(lateHudSocket as never);
    assert.deepEqual(replayReceived, ["status", "device", "verdict"]);
    hub.dropFrames();
    assert.equal(hub.ring.length, 0);

    for (const routePattern of [
      new RegExp("url\\.pathname\\s*===\\s*\"\\x2flive\""),
      new RegExp("url\\.pathname\\s*===\\s*\"\\x2fhud-ws\""),
      new RegExp("app\\.post\\(\"\\x2fingest\\x2fframe\""),
      new RegExp("app\\.post\\(\"\\x2fingest\\x2fstate\""),
      new RegExp("app\\.post\\(\"\\x2fapi\\x2fverify\""),
      new RegExp("app\\.get\\(\"\\x2fapi\\x2fstats\""),
      new RegExp("app\\.post\\(\"\\x2fapi\\x2ftts\""),
    ]) {
      assert.match(serverIndexSrc, routePattern, `server/src/index.ts must register route matching ${String(routePattern)}`);
    }

    assert.match(
      serverEnvSrc,
      /\["gemini-3\.8-live",\s*"gemini-3\.1-flash-live-preview",\s*"gemini-2\.5-flash-native-audio-latest"\]/,
    );
    assert.match(
      serverEnvSrc,
      /\["gemini-3\.8-flash",\s*"gemini-3\.5-flash",\s*"gemini-3-flash-preview"\]/,
    );
    assert.match(serverEnvSrc, /\["gemini-3\.8-flash-tts",\s*"gemini-2\.5-flash-preview-tts"\]/);
    if (!process.env.LIVE_MODELS) {
      assert.equal(env.liveModels.length, 3, "Default liveModels fallback chain must have 3 models");
      assert.ok(env.liveModels.includes("gemini-3.8-live"));
    }
    if (!process.env.VERIFY_MODELS) {
      assert.equal(env.verifyModels.length, 3, "Default verifyModels fallback chain must have 3 models");
      assert.ok(env.verifyModels.includes("gemini-3.8-flash"));
    }
  });

  test("Slide 6 (#s6-h) client architecture matches 768 px phone frames, 16 kHz PCM16 mic, 720x1280 DAT bridge, and 600x600 HUD", () => {
    const slide6 = findSlideByHeadingId(slides, "s6-h");
    const slideText = stripTags(slide6);

    for (const clientClaim of [
      "Ray-Ban Meta Gen 2",
      "capture LED on",
      "Ray-Ban Display HUD",
      "Web App at /hud/",
      "600×600",
      "Repeat",
      "I took it",
      "Dismiss",
      "Android DAT bridge",
      "720×1280 @ 2 fps in",
      "JPEG ≤ 1 fps out",
      "Phone PWA (React)",
      "Mic PCM16 16 kHz",
      "768 px + sharpness score",
    ]) {
      assert.ok(slideText.includes(clientClaim), `Slide 6 must include client architecture claim "${clientClaim}"`);
    }

    assert.match(webFramesSrc, /captureFrame\s*\(\s*video:\s*HTMLVideoElement,\s*longSide\s*=\s*768,\s*quality\s*=\s*0\.7\s*\)/);
    assert.equal(policyForRtt(null).longSide, 768);
    assert.equal(normaliseSharpness(0), 0);
    assert.equal(normaliseSharpness(150), 0.5);
    assert.equal(captureFrame({ readyState: 0, videoWidth: 0, videoHeight: 0 } as HTMLVideoElement), null);
    assert.ok(jpegSharpness(Buffer.alloc(256, 0x42)) > 0);

    const webRing = new WebFrameRing();
    for (let i = 0; i < 10; i++) {
      webRing.push({ data: `f-${i}`, w: 768, h: 576, sharpness: (i + 1) / 20, raw: 150, ts: Date.now() });
    }
    assert.equal(webRing.sharpest(20, 60_000).length, 8);

    assert.match(webWorkletSrc, /outRate\s*=\s*o\.outRate\s*\|\|\s*16000/);
    assert.match(webWorkletSrc, /new\s+Int16Array/);
    assert.match(webWorkletSrc, /registerProcessor\(\s*"pcm-capture"/);
    assert.match(webAudioSrc, new RegExp("addModule\\(\\s*\"\\x2fpcm-capture-worklet\\.js\"\\s*\\)"));
    assert.match(webAudioSrc, /processorOptions:\s*\{\s*outRate:\s*16000,\s*chunkMs:\s*100\s*\}/);
    assert.match(serverLiveSrc, new RegExp("mimeType:\\s*\"audio\\x2fpcm;rate=16000\""));

    assert.ok(androidReadme.includes("720×1280") && androidReadme.includes("VideoQuality.HIGH"));
    assert.match(androidBridgeVmSrc, /VideoQuality\.HIGH/);
    assert.match(androidBridgeVmSrc, /STREAM_FPS\s*=\s*2/);
    assert.match(androidBridgeVmSrc, /FRAME_INTERVAL_MS\s*=\s*1_000L/);
    assert.match(androidBridgeVmSrc, /JPEG_QUALITY\s*=\s*80/);
    assert.match(androidBridgeVmSrc, /YuvJpeg\.encode\(/);
    assert.match(androidUploaderSrc, new RegExp("endpoint\\(server,\\s*\"\\x2fingest\\x2fframe\",\\s*session\\),\\s*\"image\\x2fjpeg\""));
    assert.match(androidUploaderSrc, new RegExp("endpoint\\(server,\\s*\"\\x2fingest\\x2fstate\",\\s*session\\)"));
    assert.match(androidUploaderSrc, /val\s+connected:\s*Boolean/);
    assert.match(androidUploaderSrc, /val\s+worn:\s*Boolean\?/);
    assert.match(androidUploaderSrc, /val\s+battery:\s*Int\?/);
    assert.match(androidUploaderSrc, /val\s+streaming:\s*Boolean/);
    assert.match(androidYuvTestSrc, /720,\s*1280/);

    assert.match(webHudHtml, /name="mrbd-web-app-capable"\s+content="yes"/);
    assert.ok(hudSpecMd.includes("600 × 600") || hudSpecMd.includes("600×600"));
    const wearablesManifest = JSON.parse(readRepoFile("web/public/hud/.well-known/meta-wearables-manifest.json")) as {
      version: number;
      name: string;
    };
    assert.equal(wearablesManifest.version, 1);
    assert.equal(wearablesManifest.name, "HoldUp");
    assert.match(serverIndexSrc, /dotfiles:\s*"allow"/);
    for (const hudControl of ["Repeat", "I took it", "Dismiss"]) {
      assert.ok(webHudSrc.includes(hudControl), `Hud.tsx must render "${hudControl}" button`);
    }
    for (const hudAction of ['act("repeat")', 'act("log_dose")', 'act("dismiss")']) {
      assert.ok(webHudSrc.includes(hudAction), `Hud.tsx must wire ${hudAction}`);
    }
  });

  test(
    "Slide 8 (#s8-h) and docs/PRIVACY.md Section 1 11-row table match storage keys, 200-dose cap, 8-frame ring, glasses source gate, MAX_CAPTIONS=40, and 10-min GC",
    withMockBrowserStorage(async ({ local, session, cachesSet }) => {
      assert.equal(privacySections.length, 6, "docs/PRIVACY.md must contain Sections 1 through 6");
      assert.match(privacySections[0].heading, /^1\.\s+What moves, and where it goes/);
      assert.match(privacySections[1].heading, /^2\.\s+What the server writes to disk/);
      assert.match(privacySections[2].heading, /^3\.\s+Consent, control and deletion/);
      assert.match(privacySections[3].heading, /^4\.\s+Bystanders/);
      assert.match(privacySections[4].heading, /^5\.\s+Third parties/);
      assert.match(privacySections[5].heading, /^6\.\s+Known limitations/);

      const sec1Rows = parseMarkdownTableRows(privacySections[0].body);
      assert.equal(sec1Rows.length, 11, "docs/PRIVACY.md Section 1 table must have all 11 data-flow rows");

      const expectedRowTopics = [
        "Camera frames** (phone)",
        "Camera frames** (glasses",
        "Microphone audio",
        "Typed questions",
        "Transcripts and captions",
        "Profile",
        "Dose log",
        "Verdicts",
        "Spoken answer text",
        "Consent record",
        "Settings, session code, HUD",
      ];
      expectedRowTopics.forEach((topic, idx) => {
        assert.ok(
          sec1Rows[idx][0].includes(topic),
          `Row ${idx + 1} of docs/PRIVACY.md Section 1 must cover "${topic}", got "${sec1Rows[idx][0]}"`,
        );
      });

      assert.ok(sec1Rows[0][1].includes("768 px") && sec1Rows[0][3].includes("last 8 frames"));
      assert.match(serverHubSrc, /ring\s*=\s*new\s+FrameRing\(8\)/);
      assert.match(serverIndexSrc, /ws\.on\("close"[\s\S]*?if\s*\(hub\.clients\.size\s*===\s*0\)\s*\{[\s\S]*?hub\.dropFrames\(\)/);

      assert.ok(sec1Rows[1][4].includes('hub.source === "glasses"'));
      assert.match(serverIndexSrc, /if\s*\(hub\s*&&\s*hub\.source\s*===\s*"glasses"\)/);
      assert.match(serverIndexSrc, /else\s+ingest\.dropped\+\+/);

      assert.ok(sec1Rows[2][1].includes("16 kHz PCM") && sec1Rows[2][1].includes("100 ms"));
      assert.ok(sec1Rows[3][4].includes("live.ts") && sec1Rows[3][4].includes("verify.ts"));

      assert.ok(sec1Rows[4][3].includes("40 lines") && sec1Rows[4][4].includes("MAX_CAPTIONS"));
      assert.match(webCheckerSrc, /MAX_CAPTIONS\s*=\s*40\b/);
      assert.match(webCheckerSrc, /caps\.slice\(-MAX_CAPTIONS\)/);

      assert.ok(sec1Rows[5][3].includes("holdup.profile") && sec1Rows[5][3].includes("10 minutes"));
      const sysInstMatch = /function\s+systemInstruction\s*\([\s\S]*?\n\}/.exec(serverLiveSrc);
      assert.ok(sysInstMatch, "Expected systemInstruction() in server/src/live.ts");
      const sysInstBody = sysInstMatch[0];
      assert.ok(sysInstBody.includes("m.name") && sysInstBody.includes("m.ingredient") && sysInstBody.includes("m.schedule"));
      assert.ok(sysInstBody.includes("p.allergies") && sysInstBody.includes("p.avoid"));
      assert.equal(sysInstBody.includes("m.strength"), false, "systemInstruction must not send medicine strengths");
      assert.equal(sysInstBody.includes("m.barcode"), false, "systemInstruction must not send barcodes");
      assert.equal(sysInstBody.includes("m.notes"), false, "systemInstruction must not send notes");
      assert.equal(sysInstBody.includes("doseLog"), false, "systemInstruction must not send doseLog");
      assert.match(serverVerifySrc, /export\s+async\s+function\s+readLabel\s*\(\s*frames:\s*string\[\],\s*question\?:\s*string,\s*feature\s*=/);
      assert.match(serverHubSrc, /now\s*-\s*h\.touchedAt\s*>\s*10\s*\*\s*60_000/);
      assert.match(serverHubSrc, /h\.dropFrames\(\);\s*hubs\.delete\(id\);/);

      assert.ok(sec1Rows[6][3].includes("200 entries"));
      assert.match(webStorageSrc, /const\s+PREFIX\s*=\s*"holdup\."/);
      const seedProfile = demoProfile();
      saveProfile(seedProfile);
      saveConsent();
      saveSettings(loadSettings());
      const generatedSession = sessionCode();
      assert.match(generatedSession, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);
      local.setItem("holdup.hud.speak", "0");

      for (const expectedKey of [
        "holdup.profile",
        "holdup.consent",
        "holdup.settings",
        "holdup.session",
        "holdup.hud.speak",
      ]) {
        assert.notEqual(local.getItem(expectedKey), null, `Expected localStorage key "${expectedKey}"`);
      }
      assert.equal(loadConsent()?.version, CONSENT_VERSION);

      const overfullProfile = {
        ...seedProfile,
        doseLog: Array.from({ length: 205 }, (_, i) => ({ medId: "amlodipine", ts: 1_700_000_000_000 + i })),
      };
      const cappedProfile = logDose(overfullProfile, "metformin");
      assert.equal(cappedProfile.doseLog.length, 200, "logDose must cap phone doseLog at 200 entries");
      assert.equal(loadProfile().doseLog.length, 200);

      local.setItem("unrelated.key", "keep");
      session.setItem("ephemeral", "1");
      assert.equal(cachesSet.size, 2);
      await deleteAllData();
      for (const wipedKey of [
        "holdup.profile",
        "holdup.consent",
        "holdup.settings",
        "holdup.session",
        "holdup.hud.speak",
      ]) {
        assert.equal(local.getItem(wipedKey), null, `deleteAllData must wipe "${wipedKey}"`);
      }
      assert.equal(local.getItem("unrelated.key"), "keep");
      assert.equal(session.length, 0);
      assert.equal(cachesSet.size, 0);

      assert.ok(sec1Rows[7][4].includes("hub.ts") && sec1Rows[7][4].includes("lastVerdict"));
      assert.ok(sec1Rows[8][4].includes("/api/tts"));
      assert.ok(sec1Rows[9][3].includes("holdup.consent"));
      assert.ok(
        sec1Rows[10][3].includes("holdup.settings") &&
          sec1Rows[10][3].includes("holdup.session") &&
          sec1Rows[10][3].includes("holdup.hud.speak"),
      );

      const slide8 = findSlideByHeadingId(slides, "s8-h");
      const slide8Text = stripTags(slide8);
      for (const claim of [
        "Honest answers",
        "Privacy by design",
        "confidence ≥ 0.8",
        "safety.ts",
        "arachis oil → peanut",
        "whey → milk",
        "EU MDR",
        "Class IIa, Rule 11",
        "three plain cards",
        "auto-stop after 45 s",
        "localStorage",
        "8 frames in a memory ring",
        "ignore people and never describe faces",
        "capture LED",
        "One button deletes everything",
        "docs/PRIVACY.md",
      ]) {
        assert.ok(slide8Text.includes(claim), `Slide 8 (#s8-h) must include "${claim}"`);
      }

      assert.equal(STRENGTH_MIN_CONF, 0.8);
      assert.equal(MATCH_NAME_MIN_CONF, 0.8);
      assert.equal(MATCH_MIN_READABILITY, 0.5);
      assert.equal(ALLERGEN_SAFE_CONF, 0.95);

      const lowStrengthRead = toLabelRead({
        kind: "medication",
        product: { value: "Amlodipine", confidence: 0.96 },
        ingredient: { value: "amlodipine", confidence: 0.95 },
        strength: { value: "5 mg", confidence: 0.79 },
        readability: 0.9,
      });
      assert.equal(checkLabel(lowStrengthRead, seedProfile).level, "unsure");

      const nsaidRead = toLabelRead({
        kind: "medication",
        product: { value: "Burana", confidence: 0.96 },
        ingredient: { value: "ibuprofen", confidence: 0.95 },
        strength: { value: "400 mg", confidence: 0.95 },
        readability: 0.92,
      });
      assert.equal(checkLabel(nsaidRead, seedProfile).level, "warning");

      const synonymFoodRead = toLabelRead({
        kind: "food",
        product: { value: "Snack Bar", confidence: 0.95 },
        allergens: { value: ["arachis oil"], confidence: 0.9 },
        readability: 0.9,
      });
      assert.equal(checkLabel(synonymFoodRead, seedProfile).level, "warning");
    }),
  );

  test("docs/PRIVACY.md Sections 2-6 match redacting logger, 5 MB ledger rotation, 3 consent cards, 45 s auto-stop, bystander rules, and HUD speak default", () => {
    assert.equal(shortId("1234567890abcdef"), "12345678");
    assert.equal(redact({ note: "x".repeat(48) }).note, "x".repeat(48));
    assert.equal(redact({ note: "x".repeat(49) }).note, "[redacted:49ch]");

    const requiredDeniedKeys = [
      "text",
      "transcript",
      "frame",
      "audio",
      "profile",
      "speech",
      "headline",
      "question",
      "prompt",
      "key",
    ];
    for (const deniedKey of requiredDeniedKeys) {
      assert.ok(
        privacySections[1].body.includes(`\`${deniedKey}\``),
        `docs/PRIVACY.md Section 2 must list "${deniedKey}" in the logger deny-list`,
      );
      assert.equal(redact({ [deniedKey]: "sensitive" })[deniedKey], "[redacted]");
      assert.equal(redact({ [deniedKey.toUpperCase()]: "sensitive" })[deniedKey.toUpperCase()], "[redacted]");
    }

    const fakeGeminiSecret = ["AI", "zaSyFakeKeyForRedactionTest12345"].join("");
    const fakeElevenSecret = ["sk", "_fakeElevenKeyForRedactionTest12345"].join("");
    assert.equal(redact({ status: `failed ${fakeGeminiSecret}` }).status, "failed [key]");
    assert.equal(errSummary(new Error(`bad auth ${fakeElevenSecret}`)), "bad auth [key]");
    assert.match(serverLogSrc, /v\.length\s*>\s*\(k\s*===\s*"err"\s*\?\s*160\s*:\s*48\)/);

    assert.match(serverLedgerSrc, /LEDGER_MAX_BYTES\s*=\s*5\s*\*\s*1024\s*\*\s*1024/);
    assert.match(serverLedgerSrc, /fs\.renameSync\(target,\s*target\s*\+\s*"\.1"\)/);
    assert.ok(privacySections[5].body.includes("5 MB"));
    assert.match(gitignore, new RegExp("(^|\\n)server\\x2flogs\\x2f(\\s|$)"));

    const cardTitles = [...webOnboardingSrc.matchAll(/title:\s*"([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(cardTitles, ["What HoldUp captures", "Where it goes", "What stays on this phone"]);
    assert.ok(webOnboardingSrc.includes("Not now"));

    assert.match(webCheckerSrc, /AUTO_STOP_MS\s*=\s*45_000\b/);
    assert.match(webCheckerSrc, /onVisibility\s*=\s*async\s*\(\)\s*=>[\s\S]*?document\.visibilityState\s*===\s*"hidden"/);
    assert.match(serverEnvSrc, /idleStopMs:\s*Number\(process\.env\.IDLE_STOP_MS\s*\?\?\s*45000\)/);
    if (!process.env.IDLE_STOP_MS) {
      assert.equal(env.idleStopMs, 45000);
    }
    assert.match(serverLiveSrc, /Date\.now\(\)\s*-\s*this\.lastFrameAt\s*>\s*env\.idleStopMs/);

    assert.ok(privacySections[3].body.includes('"I only help with labels"'));
    assert.match(livePromptMd, /Ignore people and faces completely;\s*if asked about a person,\s*say you only help with labels\./i);
    assert.match(VERIFY_PROMPT, /Ignore people,\s*faces,\s*hands and the background\.\s*Never describe a person\./);

    assert.match(webHudSrc, /const\s+SPEAK_KEY\s*=\s*"holdup\.hud\.speak"/);
    assert.match(webHudSrc, /localStorage\.getItem\(SPEAK_KEY\)\s*===\s*"1"/);
    assert.ok(webHudSrc.includes('Speak {speakOn ? "on" : "off"}'));

    assert.ok(privacySections[4].body.includes("not confirmed"));
    assert.ok(privacySections[5].body.includes("Oikea pakkaus.") && privacySections[5].body.includes("Varoitus.") && privacySections[5].body.includes("En ole varma."));
    assert.equal(VERDICT_LEAD.fi.match, "Oikea pakkaus.");
    assert.equal(VERDICT_LEAD.fi.warning, "Varoitus.");
    assert.equal(VERDICT_LEAD.fi.unsure, "En ole varma.");
    assert.equal(VERDICT_LEAD.sv.match, "Rätt förpackning.");
    assert.equal(leadFor("fi-FI", "match").lead, "Oikea pakkaus.");
    assert.deepEqual(leadFor("en-US", "match"), {});
  });

  test("Slide 9 (#s9-h) 9-row degradation ladder matches shipped server and web resilience mechanisms", () => {
    const slide9 = findSlideByHeadingId(slides, "s9-h");
    const tbodyMatch = new RegExp("<tbody>([\\s\\S]*?)<\\x2ftbody>").exec(slide9);
    assert.ok(tbodyMatch, "Slide 9 (#s9-h) must contain a <tbody> degradation table");

    const trPattern = new RegExp("<tr>([\\s\\S]*?)<\\x2ftr>", "g");
    const tdPattern = new RegExp("<td>([\\s\\S]*?)<\\x2ftd>", "g");
    const rows = [...tbodyMatch[1].matchAll(trPattern)].map((tr) =>
      [...tr[1].matchAll(tdPattern)].map((td) => stripTags(td[1])),
    );
    assert.equal(rows.length, 9, "Slide 9 (#s9-h) must have exactly 9 resilience rows");

    assert.equal(rows[0][0], "Gemini Live error or quota");
    assert.ok(rows[0][1].includes("3-model Live chain") && rows[0][1].includes("snapshot mode"));
    assert.match(serverLiveSrc, /while\s*\(this\.modelIdx\s*<\s*env\.liveModels\.length\s*&&\s*!this\.stopped\)/);
    assert.match(serverLiveSrc, /live:\s*"degraded",\s*detail:\s*"Gemini Live unavailable, use snapshot mode"/);
    assert.match(webCheckerSrc, /if\s*\(live\s*===\s*"degraded"\s*\|\|\s*live\s*===\s*"closed"\)\s*\{\s*this\.setMode\("snapshot"/);

    assert.equal(rows[1][0], "Gemini socket drop");
    assert.ok(rows[1][1].includes("session-resumption handle"));
    assert.match(serverLiveSrc, /sessionResumption:\s*this\.handle\s*\?\s*\{\s*handle:\s*this\.handle\s*\}\s*:\s*\{\}/);
    assert.match(serverLiveSrc, /if\s*\(m\.sessionResumptionUpdate\.newHandle\)\s*\{\s*this\.handle\s*=\s*m\.sessionResumptionUpdate\.newHandle/);

    assert.equal(rows[2][0], "Phone connection drop");
    assert.ok(rows[2][1].includes("Backoff with jitter") && rows[2][1].includes("two failed tries") && rows[2][1].includes("back to live automatically"));
    assert.match(webLiveSrc, /Math\.min\(MAX_BACKOFF_MS,\s*500\s*\*\s*2\s*\*\*\s*this\.attempt\)/);
    assert.match(webLiveSrc, /0\.75\s*\+\s*Math\.random\(\)\s*\*\s*0\.5/);
    assert.match(webCheckerSrc, /if\s*\(this\.s\.mode\s*===\s*"live"\s*&&\s*info\.attempt\s*>=\s*2\)\s*\{\s*this\.setMode\("snapshot"/);
    assert.match(webCheckerSrc, /if\s*\(this\.s\.mode\s*===\s*"snapshot"\s*&&\s*this\.s\.serverLive\s*!==\s*"degraded"\)\s*this\.setMode\("live"/);

    assert.equal(rows[3][0], "No internet at all");
    assert.ok(rows[3][1].includes("Offline mode") && rows[3][1].includes("saved medicines") && rows[3][1].includes("barcode"));
    assert.match(webBarcodeSrc, /export\s+async\s+function\s+detectBarcode/);
    assert.match(webBarcodeSrc, /export\s+async\s+function\s+detectCodes/);
    const profile = demoProfile();
    const matchedByEan = findByBarcode(profile, "6416542002149");
    assert.ok(matchedByEan && matchedByEan.id === "amlodipine");
    const matchedByGtin = findByGtin(profile, "06416542003375");
    assert.ok(matchedByGtin && matchedByGtin.id === "metformin");
    const offlineMatch = matchVerdict(profile, matchedByEan, { via: "barcode" });
    assert.equal(offlineMatch.level, "match");
    assert.ok(offlineMatch.headline.includes("barcode match"));
    const unknownBarcodeVerdict = offlineUnknownBarcode("9999999999999");
    assert.equal(unknownBarcodeVerdict.level, "unsure");
    assert.ok(unknownBarcodeVerdict.speech.includes("I can't read new labels"));
    const unknownGs1Verdict = offlineUnknownCode({ raw: "0199999999999999", gtin: "99999999999999" });
    assert.equal(unknownGs1Verdict.level, "unsure");

    assert.equal(rows[4][0], "Slow network");
    assert.ok(rows[4][1].includes("1 → 0.5 → 0.33 fps"));
    assert.equal(typeof policyForRtt, "function");
    assert.deepEqual(policyForRtt(null), { fps: 1, quality: 0.7, longSide: 768, tier: "normal" });
    assert.deepEqual(policyForRtt(0), { fps: 1, quality: 0.7, longSide: 768, tier: "normal" });
    assert.deepEqual(policyForRtt(250), { fps: 1, quality: 0.7, longSide: 768, tier: "normal" });
    assert.deepEqual(policyForRtt(699), { fps: 1, quality: 0.7, longSide: 768, tier: "normal" });
    assert.deepEqual(policyForRtt(700), { fps: 0.5, quality: 0.6, longSide: 768, tier: "slow" });
    assert.deepEqual(policyForRtt(1100), { fps: 0.5, quality: 0.6, longSide: 768, tier: "slow" });
    assert.deepEqual(policyForRtt(1499), { fps: 0.5, quality: 0.6, longSide: 768, tier: "slow" });
    assert.deepEqual(policyForRtt(1500), { fps: 0.33, quality: 0.5, longSide: 640, tier: "very-slow" });
    assert.deepEqual(policyForRtt(3000), { fps: 0.33, quality: 0.5, longSide: 640, tier: "very-slow" });
    assert.equal(
      shouldSend(
        { data: "x", w: 768, h: 576, sharpness: 0.2, raw: 40, ts: 1500 },
        { data: "y", w: 768, h: 576, sharpness: 0.8, raw: 300, ts: 1000 },
      ),
      false,
    );
    assert.match(webLiveSrc, /get\s+congested\(\)\s*\{\s*return\s*\(this\.ws\?\.bufferedAmount\s*\?\?\s*0\)\s*>\s*512\s*\*\s*1024;/);
    assert.match(webCheckerSrc, /!this\.live\.congested/);

    assert.equal(rows[5][0], "Reader fails");
    assert.ok(rows[5][1].includes("One retry, then 2 fallback models") && rows[5][1].includes("Not sure"));
    assert.match(serverVerifySrc, /while\s*\(mi\s*<\s*chain\.length\s*&&\s*attempts\s*<\s*4\)/);
    assert.match(serverVerifySrc, /if\s*\(!retried\s*&&\s*mi\s*===\s*0\b/);
    assert.match(serverVerifySrc, /if\s*\(!r\.model\)\s*\{\s*verdict\.level\s*=\s*"unsure";\s*verdict\.reasons\.push\("reader unavailable"\);\s*\}/);
    assert.equal(checkLabel(unreadable(), profile).level, "unsure");

    assert.equal(rows[6][0], "Glasses off or disconnected");
    assert.ok(rows[6][1].includes("switches to the phone camera") && rows[6][1].includes("≤ 15%"));
    assert.match(webCheckerSrc, /const\s+unusable\s*=\s*d\.connected\s*===\s*false\s*\|\|\s*d\.worn\s*===\s*false/);
    assert.match(webCheckerSrc, /void\s+this\.setSource\("phone",\s*msg\)/);
    assert.match(webCheckerSrc, /speakPhrase\("glasses_off",\s*msg\)/);
    assert.match(webCheckerSrc, /d\.battery\s*!=\s*null\s*&&\s*d\.battery\s*<=\s*15/);

    assert.equal(rows[7][0], "Permission denied");
    assert.ok(rows[7][1].includes("per-platform steps") && rows[7][1].includes("photo and typed-question paths"));
    assert.equal(classifyError({ name: "NotAllowedError" }), "denied");
    assert.equal(classifyError({ name: "NotFoundError" }), "unavailable");
    assert.equal(classifyError({ name: "NotReadableError" }), "in-use");
    assert.equal(classifyError({ name: "SecurityError" }), "insecure");
    assert.ok(explain("camera", "denied").includes("camera"));
    assert.ok(explain("mic", "blocked").includes("microphone"));
    assert.ok(explain("camera", "insecure").includes("https"));
    assert.match(webMediaSrc, /export\s+function\s+platformHint\(\):\s*"ios"\s*\|\s*"android"\s*\|\s*"desktop"/);

    const g = globalThis as Record<string, unknown>;
    const prevNav = g.navigator;
    const prevDoc = g.document;
    try {
      Object.defineProperty(globalThis, "document", { value: {}, configurable: true, writable: true });
      Object.defineProperty(globalThis, "navigator", {
        value: { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" },
        configurable: true,
        writable: true,
      });
      assert.equal(platformHint(), "ios");
      Object.defineProperty(globalThis, "navigator", {
        value: { userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9)" },
        configurable: true,
        writable: true,
      });
      assert.equal(platformHint(), "android");
      Object.defineProperty(globalThis, "navigator", {
        value: { userAgent: "Mozilla/5.0 (X11; Linux x86_64)" },
        configurable: true,
        writable: true,
      });
      assert.equal(platformHint(), "desktop");
    } finally {
      if (prevNav === undefined) Reflect.deleteProperty(globalThis, "navigator");
      else Object.defineProperty(globalThis, "navigator", { value: prevNav, configurable: true, writable: true });
      if (prevDoc === undefined) Reflect.deleteProperty(globalThis, "document");
      else Object.defineProperty(globalThis, "document", { value: prevDoc, configurable: true, writable: true });
    }
    assert.ok(webOnboardingSrc.includes('plat === "ios"') && webOnboardingSrc.includes('plat === "android"'));
    assert.ok(webOnboardingSrc.includes("Take a photo of the label") && webOnboardingSrc.includes("Type your question"));

    assert.equal(rows[8][0], "Audio route changes");
    assert.ok(rows[8][1].includes("Audio now through") && rows[8][1].includes("microphone restarts"));
    assert.match(webCheckerSrc, /addEventListener\?\.\("devicechange",\s*this\.onDeviceChange\)/);
    assert.match(webCheckerSrc, /announce\(`Audio now through \$\{name\}\.`/);
    assert.match(webCheckerSrc, /this\.restartMic\("Microphone changed\."\)/);
  });

  test("every backticked repo path in docs/PRIVACY.md resolves cleanly and zero comments, em dashes, or secret prefixes appear", () => {
    const repoPrefixes = ["docs/", "server/", "web/", "shared/", "eval/", "deck/", "android-dat/", "scripts/"];
    const sourceTreeFiles = [
      ...walkFilesUnder(path.join(REPO_DIR, "server", "src")),
      ...walkFilesUnder(path.join(REPO_DIR, "web", "src")),
      ...walkFilesUnder(path.join(REPO_DIR, "shared")),
      ...walkFilesUnder(path.join(REPO_DIR, "android-dat", "app", "src")),
    ];

    const backtickTokens = [...privacyMd.matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim());
    const explicitRepoPaths = backtickTokens.filter((tok) => repoPrefixes.some((p) => tok.startsWith(p)));
    const shortFileNames = backtickTokens.filter(
      (tok) => !tok.includes("\x2f") && /^[A-Za-z0-9_-]+\.(?:ts|tsx|js|mjs|md|kt|json)$/.test(tok),
    );

    assert.ok(explicitRepoPaths.length >= 10, `Expected >= 10 backticked repo paths in docs/PRIVACY.md, got ${explicitRepoPaths.length}`);
    assert.ok(
      explicitRepoPaths.some((p) => p.includes("Uploader.kt") && (p.includes("\u2026") || p.includes("..."))),
      "Expected docs/PRIVACY.md to include the android-dat ellipsis path to Uploader.kt",
    );

    const ellipsisSplitPattern = new RegExp("(?:\u2026|\\.\\.\\.)\\x2f?");
    for (const rawPath of explicitRepoPaths) {
      if (rawPath.includes("\u2026") || rawPath.includes("...")) {
        const [prefixPart, suffixPart] = rawPath.split(ellipsisSplitPattern);
        const searchRoot = path.join(REPO_DIR, prefixPart);
        const matches = walkFilesUnder(searchRoot).filter((abs) =>
          abs.split(path.sep).join("\x2f").endsWith(`\x2f${suffixPart}`),
        );
        assert.ok(matches.length >= 1, `Ellipsis repo path "${rawPath}" must resolve to an existing file on disk`);
      } else if (rawPath === "server/logs/ledger.jsonl") {
        assert.match(gitignore, new RegExp("(^|\\n)server\\x2flogs\\x2f(\\s|$)"));
        assert.equal(
          path.resolve(REPO_DIR, rawPath),
          path.resolve(REPO_DIR, "server", "logs", "ledger.jsonl"),
        );
        assert.equal(fs.existsSync(path.join(REPO_DIR, "server")), true);
      } else {
        const abs = path.join(REPO_DIR, rawPath);
        assert.equal(fs.existsSync(abs), true, `Backticked repo path "${rawPath}" must exist on disk`);
        assert.equal(fs.statSync(abs).isFile(), true, `Backticked repo path "${rawPath}" must be a file`);
      }
    }

    for (const baseName of shortFileNames) {
      const matches = sourceTreeFiles.filter((abs) => path.basename(abs) === baseName);
      assert.ok(matches.length >= 1, `Backticked file "${baseName}" in docs/PRIVACY.md must exist in source tree`);
    }

    const selfSource = fs.readFileSync(TEST_FILE, "utf8");
    for (const [label, content] of [
      ["docs/PRIVACY.md", privacyMd],
      ["web/test/privacyArchitectureResilienceContract.test.ts", selfSource],
    ] as const) {
      assert.equal(content.includes(LINE_COMMENT_TOKEN), false, `${label} must contain zero line comment markers`);
      assert.equal(content.includes(BLOCK_COMMENT_TOKEN), false, `${label} must contain zero block comment markers`);
      assert.equal(content.includes(HTML_COMMENT_TOKEN), false, `${label} must contain zero HTML comment markers`);
      assert.equal(content.includes(EM_DASH), false, `${label} must contain zero U+2014 em dashes`);
      assert.equal(content.includes(ESCAPED_EM_DASH), false, `${label} must contain zero escaped u2014 sequences`);
      for (const prefix of LIVE_SECRET_PREFIXES) {
        assert.equal(content.includes(prefix), false, `${label} must contain zero live secret prefixes (${prefix})`);
      }
    }
  });
});
