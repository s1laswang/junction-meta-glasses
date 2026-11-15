import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Checker, levelWord } from "../src/lib/checker.ts";
import { earcon, haptic, onAnnounce } from "../src/lib/feedback.ts";
import { policyForRtt } from "../src/lib/frames.ts";
import {
  demoProfile,
  loadProfile,
  loadSettings,
  logDose,
  saveProfile,
  saveSettings,
  takenToday,
} from "../src/lib/storage.ts";
import {
  TOOLS,
  VERDICT_LEAD,
  leadFor,
  speakInstruction,
  toolsFor,
} from "../../server/src/live.ts";
import {
  STRENGTH_MIN_CONF,
  checkLabel,
  spokenIngredient,
} from "../../server/src/safety.ts";
import {
  FrameRing as ServerFrameRing,
  LABEL_SCHEMA,
  PICK_SAME_ITEM_MS,
  toLabelRead,
  unreadable,
  type Frame as ServerFrame,
} from "../../server/src/verify.ts";

const TEST_FILE = fileURLToPath(import.meta.url);
const TEST_DIR = path.dirname(TEST_FILE);
const REPO_DIR = path.resolve(TEST_DIR, "..", "..");

const SLASH = String.fromCharCode(47);
const ASTERISK = String.fromCharCode(42);
const DOUBLE_SLASH = SLASH + SLASH;
const LINE_COMMENT_TOKEN = DOUBLE_SLASH;
const BLOCK_COMMENT_TOKEN = SLASH + ASTERISK;
const HTML_COMMENT_TOKEN = "<" + "!--";
const EM_DASH = String.fromCharCode(8212);
const ESCAPED_EM_DASH = ["\\", "u2014"].join("");
const SECRET_PREFIXES = [
  ["AI", "za"].join(""),
  ["AQ", "."].join(""),
  ["sk", "-"].join(""),
  ["sk", "_"].join(""),
  ["ghp", "_"].join(""),
  ["github", "_pat_"].join(""),
  ["AK", "IA"].join(""),
  ["ya29", "."].join(""),
];

const EXPECTED_APK_SHA256 = "164dea1bb474fbdbcb7bdeccd3270ccc42c46c2c1c5683f2a9bd2b894a3bfe20";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readRepoFile(relPath: string): string {
  return fs.readFileSync(path.join(REPO_DIR, relPath), "utf8");
}

function readRepoBytes(relPath: string): Buffer {
  return fs.readFileSync(path.join(REPO_DIR, relPath));
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

function extractSlides(deckHtml: string): Map<string, string> {
  const slideRe = new RegExp("<section\\s+class=\"slide(?:\\s+[^\"]*)?\"[\\s\\S]*?<\\x2fsection>", "g");
  const matches = deckHtml.match(slideRe) ?? [];
  const byId = new Map<string, string>();
  for (const section of matches) {
    const idMatch = /\bid="(s\d+-h)"/.exec(section);
    assert.ok(idMatch, "Every .slide section in deck/index.html must carry heading id=\"sN-h\"");
    byId.set(idMatch[1], section);
  }
  return byId;
}

function findSlideByHeading(
  slides: Map<string, string>,
  expectedEyebrow: string,
  expectedHeadingSnippet: string,
): { id: string; html: string } {
  const eyebrowRe = new RegExp("<p class=\"eyebrow\">([\\s\\S]*?)<\\x2fp>");
  const headingRe = new RegExp("<h[12]\\s+id=\"(s\\d+-h)\">([\\s\\S]*?)<\\x2fh[12]>");
  const matches: Array<{ id: string; html: string }> = [];
  for (const [id, section] of slides.entries()) {
    const eyebrowMatch = eyebrowRe.exec(section);
    const headingMatch = headingRe.exec(section);
    const eyebrowText = eyebrowMatch ? stripTags(eyebrowMatch[1]) : "";
    const headingText = headingMatch ? stripTags(headingMatch[2]) : "";
    if (eyebrowText.includes(expectedEyebrow) && headingText.includes(expectedHeadingSnippet)) {
      matches.push({ id, html: section });
    }
  }
  assert.equal(
    matches.length,
    1,
    `Expected unique slide with eyebrow "${expectedEyebrow}" and heading "${expectedHeadingSnippet}", found ${matches.length}`,
  );
  return matches[0];
}

function parsePngHeader(buf: Buffer): { width: number; height: number; bitDepth: number; colorType: number } {
  assert.ok(buf.length >= 33, `Expected PNG buffer >= 33 bytes, got ${buf.length}`);
  assert.equal(buf.subarray(0, 8).equals(PNG_SIGNATURE), true, "PNG must begin with canonical 8-byte signature");
  const ihdrLen = buf.readUInt32BE(8);
  const ihdrType = buf.subarray(12, 16).toString("ascii");
  assert.equal(ihdrLen, 13, "PNG IHDR chunk data length must be 13 bytes");
  assert.equal(ihdrType, "IHDR", "First PNG chunk after signature must be IHDR");
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf[24],
    colorType: buf[25],
  };
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

type BrowserMockContext = {
  local: Storage;
  session: Storage;
  vibrations: Array<number | number[]>;
  oscillatorFreqs: number[];
  mediaHandlers: Map<string, () => void>;
};

function withBrowserEnv(run: (ctx: BrowserMockContext) => Promise<void> | void) {
  return async () => {
    const g = globalThis as Record<string, unknown>;
    const savedKeys = [
      "localStorage",
      "sessionStorage",
      "window",
      "document",
      "location",
      "navigator",
      "MediaMetadata",
      "Audio",
      "fetch",
    ] as const;
    const prev = new Map<string, { had: boolean; value: unknown }>();
    for (const k of savedKeys) {
      prev.set(k, { had: k in g, value: g[k] });
    }

    const local = createMemoryStorage();
    const session = createMemoryStorage();
    const vibrations: Array<number | number[]> = [];
    const oscillatorFreqs: number[] = [];
    const mediaHandlers = new Map<string, () => void>();
    const origin = "https:" + DOUBLE_SLASH + "holdup.example";

    class FakeAudioContext {
      state = "running";
      currentTime = 0;
      destination = {};
      async resume() {}
      async close() {}
      createOscillator() {
        const freqObj = { value: 0 };
        return {
          type: "sine",
          frequency: freqObj,
          connect(node: unknown) {
            return node;
          },
          start() {
            oscillatorFreqs.push(freqObj.value);
          },
          stop() {},
        };
      }
      createGain() {
        return {
          gain: {
            value: 1,
            setValueAtTime() {},
            linearRampToValueAtTime() {},
            exponentialRampToValueAtTime() {},
          },
          connect() {},
        };
      }
    }

    class FakeMediaMetadata {
      title: string;
      artist: string;
      album: string;
      constructor(init: { title?: string; artist?: string; album?: string } = {}) {
        this.title = init.title ?? "";
        this.artist = init.artist ?? "";
        this.album = init.album ?? "";
      }
    }

    class FakeAudio {
      src: string;
      loop = false;
      constructor(src = "") {
        this.src = src;
      }
      async play() {}
      pause() {}
    }

    const winMock = {
      AudioContext: FakeAudioContext,
      addEventListener() {},
      removeEventListener() {},
      speechSynthesis: {
        cancel() {},
        speak() {},
      },
    };

    const docMock = {
      visibilityState: "visible",
      addEventListener() {},
      removeEventListener() {},
    };

    const navMock = {
      language: "en-US",
      onLine: true,
      vibrate(pattern: number | number[]) {
        vibrations.push(pattern);
        return true;
      },
      mediaDevices: {
        addEventListener() {},
        removeEventListener() {},
        async enumerateDevices() {
          return [];
        },
        async getUserMedia() {
          return {
            getTracks: () => [],
            getVideoTracks: () => [],
            getAudioTracks: () => [],
          };
        },
      },
      mediaSession: {
        metadata: null as unknown,
        playbackState: "none",
        setActionHandler(action: string, handler: (() => void) | null) {
          if (handler) mediaHandlers.set(action, handler);
          else mediaHandlers.delete(action);
        },
      },
    };

    const fetchMock = async () => ({
      ok: true,
      status: 200,
      async json() {
        return { ok: true, gemini: "ok" };
      },
    });

    Object.defineProperty(globalThis, "localStorage", { value: local, configurable: true, writable: true });
    Object.defineProperty(globalThis, "sessionStorage", { value: session, configurable: true, writable: true });
    Object.defineProperty(globalThis, "window", { value: winMock, configurable: true, writable: true });
    Object.defineProperty(globalThis, "document", { value: docMock, configurable: true, writable: true });
    Object.defineProperty(globalThis, "location", {
      value: { origin, search: "", pathname: SLASH, hash: "", host: "holdup.example", protocol: "https:" },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "navigator", { value: navMock, configurable: true, writable: true });
    Object.defineProperty(globalThis, "MediaMetadata", { value: FakeMediaMetadata, configurable: true, writable: true });
    Object.defineProperty(globalThis, "Audio", { value: FakeAudio, configurable: true, writable: true });
    Object.defineProperty(globalThis, "fetch", { value: fetchMock, configurable: true, writable: true });

    try {
      await run({ local, session, vibrations, oscillatorFreqs, mediaHandlers });
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

function makeServerFrame(ts: number, sharpness: number, source: "phone" | "glasses" = "glasses"): ServerFrame {
  return {
    data: Buffer.alloc(96, Math.round(sharpness * 100)).toString("base64"),
    sharpness,
    ts,
    bytes: 96,
    source,
  };
}

describe("Deck Slides 1, 3, 4, Adoption, Team+Ask + docs/HUD_SPEC.md & docs/HARDWARE_NOTES.md code-parity contract", () => {
  const deckHtml = readRepoFile("deck/index.html");
  const readmeMd = readRepoFile("README.md");
  const briefMd = readRepoFile("BRIEF.md");
  const hudSpecMd = readRepoFile("docs/HUD_SPEC.md");
  const hardwareNotesMd = readRepoFile("docs/HARDWARE_NOTES.md");
  const filmingMd = readRepoFile("docs/FILMING_0630.md");
  const pilotPlanMd = readRepoFile("docs/PILOT_PLAN.md");
  const webCheckerSrc = readRepoFile("web/src/lib/checker.ts");
  const webFeedbackSrc = readRepoFile("web/src/lib/feedback.ts");
  const webLiveScreenSrc = readRepoFile("web/src/screens/Live.tsx");
  const webHudSrc = readRepoFile("web/src/screens/Hud.tsx");
  const webHudHtml = readRepoFile("web/hud/index.html");
  const webViteConfigSrc = readRepoFile("web/vite.config.ts");
  const serverIndexSrc = readRepoFile("server/src/index.ts");
  const serverLiveSrc = readRepoFile("server/src/live.ts");
  const serverVerifySrc = readRepoFile("server/src/verify.ts");
  const serverSafetySrc = readRepoFile("server/src/safety.ts");
  const rawLabelSchemaJson = readRepoFile("shared/label_schema.json");
  const androidLibsToml = readRepoFile("android-dat/gradle/libs.versions.toml");
  const androidSettingsGradle = readRepoFile("android-dat/settings.gradle.kts");
  const androidAppGradle = readRepoFile("android-dat/app/build.gradle.kts");
  const androidManifestXml = readRepoFile("android-dat/app/src/main/AndroidManifest.xml");
  const androidBridgeVmKt = readRepoFile("android-dat/app/src/main/java/app/holdup/bridge/BridgeViewModel.kt");
  const androidUploaderKt = readRepoFile("android-dat/app/src/main/java/app/holdup/bridge/Uploader.kt");
  const androidMainActivityKt = readRepoFile("android-dat/app/src/main/java/app/holdup/bridge/MainActivity.kt");
  const androidStreamingServiceKt = readRepoFile("android-dat/app/src/main/java/app/holdup/bridge/StreamingService.kt");
  const androidReadmeMd = readRepoFile("android-dat/README.md");

  const slides = extractSlides(deckHtml);

  test(
    "Slide 3 (#s3-h Why glasses, not a phone) 4 pillars and Beyond mirroring the phone match multimodal glasses/phone code",
    withBrowserEnv(async () => {
      const slide3 = slides.get("s3-h");
      assert.ok(slide3, "Expected Slide 3 (#s3-h) in deck/index.html");
      assert.equal(slide3.includes(EM_DASH), false, "Slide 3 must contain zero em dashes");

      const eyebrowMatch = new RegExp("<p class=\"eyebrow\">([\\s\\S]*?)<\\x2fp>").exec(slide3);
      const h2Match = new RegExp("<h2 id=\"s3-h\">([\\s\\S]*?)<\\x2fh2>").exec(slide3);
      assert.ok(eyebrowMatch && h2Match, "Slide 3 must contain .eyebrow and #s3-h");
      assert.equal(stripTags(eyebrowMatch[1]), "Why glasses, not a phone");
      assert.equal(stripTags(h2Match[1]), "The camera is already looking at what your hands are holding.");

      const grid4Match = new RegExp("<div class=\"grid4\">([\\s\\S]*?)<\\x2fdiv>\\s*<div class=\"card hl\">").exec(slide3);
      assert.ok(grid4Match, "Slide 3 must contain a .grid4 pillar grid followed by .card.hl");
      const pillarCardRe = new RegExp("<div class=\"card\">([\\s\\S]*?)<\\x2fdiv>", "g");
      const pillarCards = [...grid4Match[1].matchAll(pillarCardRe)].map((m) => m[1]);
      assert.equal(pillarCards.length, 4, "Slide 3 must render all 4 glasses pillars");

      const parsedPillars = pillarCards.map((cardHtml) => {
        const svgPresent = cardHtml.includes("<svg");
        const h3 = new RegExp("<h3>([\\s\\S]*?)<\\x2fh3>").exec(cardHtml);
        const p = new RegExp("<p>([\\s\\S]*?)<\\x2fp>").exec(cardHtml);
        assert.ok(svgPresent && h3 && p, "Each Slide 3 pillar card must include <svg>, <h3>, and <p>");
        return { title: stripTags(h3[1]), body: stripTags(p[1]) };
      });

      assert.deepEqual(
        parsedPillars.map((p) => p.title),
        ["Hands", "Aim", "Audio", "Display"],
      );
      assert.ok(parsedPillars[0].body.includes("Both hands stay on the box") && parsedPillars[0].body.includes("No third hand for a phone"));
      assert.ok(parsedPillars[1].body.includes("First-person view") && parsedPillars[1].body.includes("coach"));
      assert.ok(parsedPillars[2].body.includes("Open-ear speakers and mic on your face"));
      assert.ok(parsedPillars[3].body.includes("On Ray-Ban Display") && parsedPillars[3].body.includes("Shape + word + colour"));

      const beyondMatch = new RegExp("<div class=\"card hl\">\\s*<h3>([\\s\\S]*?)<\\x2fh3>\\s*<p class=\"body\">([\\s\\S]*?)<\\x2fp>\\s*<\\x2fdiv>").exec(slide3);
      assert.ok(beyondMatch, "Slide 3 must contain the highlighted Beyond mirroring the phone card");
      assert.equal(stripTags(beyondMatch[1]), "Beyond mirroring the phone");
      const beyondBody = stripTags(beyondMatch[2]);
      for (const expectedPhrase of [
        "continuous first-person stream",
        "one personal question",
        "built for",
        "Ray-Ban Meta",
        "camera via the Device Access Toolkit",
        "the bridge APK compiles and its tests pass",
        "Ray-Ban Display",
        "HUD Web App + Neural Band",
        "Today the full loop runs on the phone camera",
        "with the glasses as a Bluetooth headset",
        "docs/HARDWARE_LOG.md",
      ]) {
        assert.ok(beyondBody.includes(expectedPhrase), `Slide 3 Beyond mirroring card must include "${expectedPhrase}"`);
      }
      assert.equal(
        beyondBody.toLowerCase().includes("it runs on ray-ban meta"),
        false,
        "Slide 3 must not claim unverified on-glasses execution",
      );

      assert.match(webCheckerSrc, /source:\s*"phone"\s*\|\s*"glasses"/);
      assert.match(webCheckerSrc, /async\s+setSource\(\s*src:\s*"phone"\s*\|\s*"glasses"/);
      assert.match(webCheckerSrc, /this\.source\s*===\s*"phone"\s*\?\s*this\.startCamera\(\)\s*:\s*Promise\.resolve\(\)/);
      assert.match(webCheckerSrc, /const\s+unusable\s*=\s*d\.connected\s*===\s*false\s*\|\|\s*d\.worn\s*===\s*false/);
      assert.match(webCheckerSrc, /if\s*\(this\.s\.source\s*===\s*"glasses"\s*&&\s*unusable\)\s*\{[\s\S]*?this\.setSource\("phone",\s*msg\)/);
      assert.ok(webLiveScreenSrc.includes("Phone camera") && webLiveScreenSrc.includes("Glasses camera"));
      assert.ok(webLiveScreenSrc.includes("Using glasses camera"));

      const announcements: string[] = [];
      const unsubscribeAnnounce = onAnnounce((msg) => announcements.push(msg));
      const checker = new Checker();
      try {
        assert.equal(checker.source, "phone");
        await checker.setSource("glasses");
        assert.equal(checker.source, "glasses");
        assert.equal(loadSettings().source, "glasses");
        assert.ok(announcements.some((a) => a.includes("Using the glasses camera")));
        await checker.setSource("phone");
        assert.equal(checker.source, "phone");
        assert.equal(loadSettings().source, "phone");
        assert.ok(announcements.some((a) => a.includes("Using the phone camera")));
      } finally {
        unsubscribeAnnounce();
        checker.dispose();
      }

      assert.match(webHudSrc, /match:\s*\{\s*glyph:\s*"✓",\s*word:\s*"RIGHT ONE",\s*color:\s*"#66BB6A"\s*\}/);
      assert.match(webHudSrc, /warning:\s*\{\s*glyph:\s*"⚠",\s*word:\s*"CHECK",\s*color:\s*"#FFCA28"\s*\}/);
      assert.match(webHudSrc, /unsure:\s*\{\s*glyph:\s*"\?",\s*word:\s*"NOT SURE",\s*color:\s*"#4FC3F7"\s*\}/);
      assert.equal(/ArrowUp|ArrowDown|ArrowLeft|ArrowRight/.test(webHudSrc), false, "Hud.tsx must leave Arrow keys to Chromium spatial navigation");
      assert.ok(androidBridgeVmKt.includes("import com.meta.wearable.dat.camera.Camera"));
      assert.ok(androidBridgeVmKt.includes("import com.meta.wearable.dat.core.Wearables"));
      assert.ok(androidUploaderKt.includes('"/ingest/frame"') && androidUploaderKt.includes('"/ingest/state"'));
    }),
  );

  test(
    "Slide 4 (#s4-h) 6 loop steps (01 Ask .. 06 Log) match mediaSession tap, ~1 fps cues/earcons/haptics, 1.5 s 2-frame schema read, and FI/SV deterministic openers",
    withBrowserEnv(async ({ vibrations, oscillatorFreqs, mediaHandlers }) => {
      const slide4 = slides.get("s4-h");
      assert.ok(slide4, "Expected Slide 4 (#s4-h) in deck/index.html");
      assert.equal(slide4.includes(EM_DASH), false, "Slide 4 must contain zero em dashes");

      const h2Match = new RegExp("<h2 id=\"s4-h\">([\\s\\S]*?)<\\x2fh2>").exec(slide4);
      assert.ok(h2Match);
      assert.equal(stripTags(h2Match[1]), "One loop: ask, coach, read, check, answer, log.");

      const olMatch = new RegExp("<ol class=\"loop\">([\\s\\S]*?)<\\x2fol>").exec(slide4);
      assert.ok(olMatch, "Slide 4 must contain <ol class=\"loop\">");
      const stepRe = new RegExp("<li class=\"step\">\\s*<span class=\"n\">([\\s\\S]*?)<\\x2fspan>\\s*<h3>([\\s\\S]*?)<\\x2fh3>\\s*<p>([\\s\\S]*?)<\\x2fp>\\s*<\\x2fli>", "g");
      const steps = [...olMatch[1].matchAll(stepRe)].map((m) => ({
        num: stripTags(m[1]),
        title: stripTags(m[2]),
        body: stripTags(m[3]),
      }));
      assert.equal(steps.length, 6, "Slide 4 must list all 6 product loop steps");
      assert.deepEqual(
        steps.map((s) => `${s.num} ${s.title}`),
        ["01 Ask", "02 Coach", "03 Read", "04 Check", "05 Answer", "06 Log"],
      );

      assert.ok(
        steps[0].body.includes("Is this my evening pill?") &&
          steps[0].body.includes("voice") &&
          steps[0].body.includes("typed text") &&
          steps[0].body.includes("big button") &&
          steps[0].body.includes("Bluetooth play/pause tap"),
      );
      assert.match(webCheckerSrc, /new\s+MicCapture\(/);
      assert.match(webCheckerSrc, /this\.live\.send\(\{\s*type:\s*"audio",\s*data:\s*b64\s*\}\)/);
      assert.match(webCheckerSrc, /sendText\(text:\s*string\)\s*\{[\s\S]*?this\.live\.send\(\{\s*type:\s*"text",\s*text:\s*t\s*\}\)/);
      assert.match(webCheckerSrc, /navigator\.mediaSession\.setActionHandler\("play",\s*act\)/);
      assert.match(webCheckerSrc, /navigator\.mediaSession\.setActionHandler\("pause",\s*act\)/);
      assert.ok(webLiveScreenSrc.includes('placeholder="Is this my evening pill?"'));
      assert.ok(webLiveScreenSrc.includes("bigbtn") && webLiveScreenSrc.includes("MediaPlayPause"));

      const checker = new Checker();
      try {
        const enableMs = (checker as unknown as { enableMediaSession: () => void }).enableMediaSession.bind(checker);
        enableMs();
        assert.equal(typeof mediaHandlers.get("play"), "function", "Checker must bind mediaSession play handler");
        assert.equal(typeof mediaHandlers.get("pause"), "function", "Checker must bind mediaSession pause handler");
        assert.equal(typeof mediaHandlers.get("stop"), "function", "Checker must bind mediaSession stop handler");
      } finally {
        checker.dispose();
      }

      assert.ok(
        steps[1].body.includes("~1 frame/s") &&
          steps[1].body.includes("one physical cue at a time") &&
          steps[1].body.includes("Cue arrow on screen and HUD") &&
          steps[1].body.includes("earcon") &&
          steps[1].body.includes("vibration"),
      );
      assert.equal(policyForRtt(null).fps, 1, "Default phone frame policy must target 1 fps");
      assert.match(serverLiveSrc, /Date\.now\(\)\s*-\s*this\.lastVideoAt\s*<\s*900/);
      assert.match(serverLiveSrc, /name:\s*"show_cue"[\s\S]*?behavior:\s*Behavior\.NON_BLOCKING/);
      assert.ok(webLiveScreenSrc.includes("<CueArrow") && webHudSrc.includes("<CueArrow"));
      assert.match(webCheckerSrc, /case\s*"coach":[\s\S]*?earcon\.coach\(\)[\s\S]*?haptic\.coach\(m\.cue\)/);
      assert.match(webFeedbackSrc, /navigator\.vibrate\?\.\(p\)/);

      saveSettings({ ...loadSettings(), earcons: true, haptics: true });
      earcon.coach();
      haptic.coach("rotate_left");
      haptic.verdict("warning");
      assert.ok(oscillatorFreqs.includes(880), "earcon.coach() must schedule 880 Hz coaching tone");
      assert.deepEqual(vibrations[0], [30, 40, 30], "haptic.coach('rotate_left') must vibrate distinct directional pattern");
      assert.deepEqual(vibrations[1], [300, 120, 300, 120, 300], "haptic.verdict('warning') must vibrate urgent warning pattern");

      assert.ok(
        steps[2].body.includes("verify_label") &&
          steps[2].body.includes("up to 2 sharpest frames") &&
          steps[2].body.includes("1.5 s") &&
          steps[2].body.includes("confidence for every field") &&
          steps[2].body.includes("null when not legible"),
      );
      assert.equal(PICK_SAME_ITEM_MS, 1500, "PICK_SAME_ITEM_MS in server/src/verify.ts must equal 1500 ms (1.5 s)");
      assert.match(serverVerifySrc, /pick\(\s*n\s*=\s*2,\s*windowMs\s*=\s*5000,\s*now\s*=\s*Date\.now\(\),\s*sameItemMs\s*=\s*PICK_SAME_ITEM_MS\s*\)/);

      const ring = new ServerFrameRing();
      ring.push(makeServerFrame(1000, 0.99));
      ring.push(makeServerFrame(3000, 0.55));
      ring.push(makeServerFrame(3600, 0.91));
      ring.push(makeServerFrame(4200, 0.78));
      const pickedBurst = ring.pick();
      assert.equal(pickedBurst.length, 2, "FrameRing.pick() must pick up to 2 sharpest frames within 1.5 s");
      assert.deepEqual(
        pickedBurst.map((f) => f.ts),
        [3600, 4200],
        "FrameRing.pick() must exclude frames older than 1500 ms before the newest frame",
      );

      const glassesRing = new ServerFrameRing();
      glassesRing.push(makeServerFrame(1000, 0.88, "glasses"));
      glassesRing.push(makeServerFrame(2600, 0.72, "glasses"));
      assert.equal(glassesRing.pick().length, 1, "At ~1 fps with >1.5 s spacing, FrameRing.pick() returns the single latest frame");

      const rawSchema = JSON.parse(rawLabelSchemaJson) as {
        required: string[];
        properties: Record<string, unknown>;
        $defs: { stringField: { required: string[]; properties: { value: { type: string[] }; confidence: { type: string; minimum: number; maximum: number } } } };
      };
      assert.deepEqual(rawSchema.$defs.stringField.required, ["value", "confidence"]);
      assert.deepEqual(rawSchema.$defs.stringField.properties.value.type, ["string", "null"]);
      assert.equal(rawSchema.$defs.stringField.properties.confidence.minimum, 0);
      assert.equal(rawSchema.$defs.stringField.properties.confidence.maximum, 1);

      const inlinedProps = (LABEL_SCHEMA as { properties: Record<string, { required?: string[]; properties?: { value?: { type?: string[] }; confidence?: { minimum?: number; maximum?: number } } }> }).properties;
      for (const fieldKey of ["product", "ingredient", "strength", "dosing", "expiry", "allergens", "barcode"]) {
        const f = inlinedProps[fieldKey];
        assert.ok(f, `LABEL_SCHEMA must define "${fieldKey}"`);
        assert.deepEqual(f.required, ["value", "confidence"], `LABEL_SCHEMA.${fieldKey} must require value and confidence`);
        assert.ok(f.properties?.value?.type?.includes("null"), `LABEL_SCHEMA.${fieldKey}.value must allow null when illegible`);
        assert.equal(f.properties?.confidence?.minimum, 0);
        assert.equal(f.properties?.confidence?.maximum, 1);
      }
      const emptyCoerced = toLabelRead({});
      assert.equal(emptyCoerced.strength.value, null);
      assert.equal(emptyCoerced.strength.confidence, 0);
      assert.equal(unreadable().kind, "unreadable");

      assert.equal(TOOLS.some((t) => t.name === "verify_label"), true);
      assert.equal(toolsFor(new Set()).some((t) => t.name === "log_dose"), true);

      assert.ok(
        steps[3].body.includes("Deterministic rules") &&
          steps[3].body.includes("on-device profile") &&
          steps[3].body.includes("medicines, strengths, schedule, allergies, avoid list, expiry, today's doses"),
      );
      assert.equal(serverSafetySrc.includes("@google"), false, "safety.ts must remain model-free");

      assert.ok(
        steps[4].body.includes("The checker writes the sentence") &&
          steps[4].body.includes("checks what was said") &&
          steps[4].body.includes("repeats the checked sentence") &&
          steps[4].body.includes("FI/SV: fixed openers, details translated") &&
          steps[4].body.includes("deterministic"),
      );
      assert.equal(VERDICT_LEAD.fi.match, "Oikea pakkaus.");
      assert.equal(VERDICT_LEAD.fi.warning, "Varoitus.");
      assert.equal(VERDICT_LEAD.fi.unsure, "En ole varma.");
      assert.equal(VERDICT_LEAD.sv.match, "Rätt förpackning.");
      assert.equal(VERDICT_LEAD.sv.warning, "Varning.");
      assert.equal(VERDICT_LEAD.sv.unsure, "Jag är inte säker.");
      assert.deepEqual(leadFor("fi-FI", "match"), { lead: "Oikea pakkaus." });
      assert.deepEqual(leadFor("fi", "warning"), { lead: "Varoitus." });
      assert.deepEqual(leadFor("fi", "unsure"), { lead: "En ole varma." });
      assert.deepEqual(leadFor("sv-SE", "match"), { lead: "Rätt förpackning." });
      assert.deepEqual(leadFor("sv", "warning"), { lead: "Varning." });
      assert.deepEqual(leadFor("sv", "unsure"), { lead: "Jag är inte säker." });
      assert.deepEqual(leadFor("en-US", "match"), {});
      assert.equal(speakInstruction("en", "Stop."), "Say `speech` word for word, then stop. Stop.");
      const expectedNordicInstruction =
        "First say `lead` exactly as written, then say the rest of `speech` translated faithfully into the user's language (do not repeat the opener; keep medicine names, numbers and dates exact, using a decimal comma like 2,5 mg when speaking numbers), then stop. Stop.";
      assert.equal(speakInstruction("fi", "Stop."), expectedNordicInstruction);
      assert.equal(speakInstruction("sv", "Stop."), expectedNordicInstruction);

      assert.ok(
        steps[5].body.includes("I took it") &&
          steps[5].body.includes("saves the dose on the phone") &&
          steps[5].body.includes("You already took it today."),
      );
    }),
  );

  test(
    "Slide 4 (#s4-h) 3 spoken verdict <q> quotes and Step 06 double-dose warning match real checkLabel() + demoProfile() word-for-word",
    withBrowserEnv(async () => {
      const slide4 = slides.get("s4-h");
      assert.ok(slide4, "Expected Slide 4 (#s4-h)");

      const vrowRe = new RegExp("<div class=\"vrow\\s+(match|warning|unsure)\"[^>]*>[\\s\\S]*?<span class=\"w\">([\\s\\S]*?)<\\x2fspan><q>([\\s\\S]*?)<\\x2fq><\\x2fdiv>", "g");
      const vrows = [...slide4.matchAll(vrowRe)].map((m) => ({
        level: m[1] as "match" | "warning" | "unsure",
        word: stripTags(m[2]),
        quote: stripTags(m[3]),
      }));
      assert.equal(vrows.length, 3, "Slide 4 must display all 3 spoken verdict rows (match, warning, unsure)");
      assert.deepEqual(
        vrows.map((r) => [r.level, r.word]),
        [
          ["match", levelWord("match")],
          ["warning", levelWord("warning")],
          ["unsure", levelWord("unsure")],
        ],
      );

      assert.equal(spokenIngredient("amlodipine besilate"), "amlodipine");
      const footMatch = new RegExp("<div class=\"foot\">([\\s\\S]*?)<\\x2fdiv>").exec(slide4);
      assert.ok(footMatch && stripTags(footMatch[1]).includes("server/src/safety.ts") && stripTags(footMatch[1]).includes("amlodipine besilate"));

      const eveningNow = new Date(2026, 10, 15, 20, 0, 0, 0);
      const morningNow = new Date(2026, 10, 15, 8, 30, 0, 0);
      const validExpiry = "2027-08";

      const profile = demoProfile();
      saveProfile(profile);
      assert.equal(takenToday(profile, "amlodipine"), false);

      const amlodipineRead = toLabelRead({
        kind: "medication",
        product: { value: "Amlodipine 5 mg", confidence: 0.96 },
        ingredient: { value: "amlodipine besilate", confidence: 0.95 },
        strength: { value: "5 mg", confidence: 0.95 },
        expiry: { value: validExpiry, confidence: 0.92 },
        readability: 0.92,
      });
      const matchVerdictOut = checkLabel(amlodipineRead, profile, eveningNow);
      assert.equal(matchVerdictOut.level, "match");
      assert.equal(matchVerdictOut.matchedMedId, "amlodipine");
      assert.equal(matchVerdictOut.takenToday, false);
      assert.equal(
        matchVerdictOut.speech,
        "Yes, Amlodipine 5 mg, your evening pill. You haven't taken it today.",
      );
      assert.equal(matchVerdictOut.speech, vrows[0].quote, "Slide 4 Match <q> must match checkLabel() word-for-word");

      const morningMatchOut = checkLabel(amlodipineRead, profile, morningNow);
      assert.equal(morningMatchOut.level, "match");
      assert.equal(
        morningMatchOut.speech,
        "Yes, Amlodipine 5 mg, your evening pill, but it's only morning now. You haven't taken it today.",
      );

      const loggedProfile = logDose(profile, "amlodipine");
      assert.equal(takenToday(loggedProfile, "amlodipine"), true);
      assert.equal(loadProfile().doseLog.length, 1);
      const loggedEveningProfile = {
        ...loggedProfile,
        doseLog: [{ medId: "amlodipine", ts: eveningNow.getTime() }],
      };
      const afterLogNow = new Date(2026, 10, 15, 20, 5, 0, 0);
      const secondCheckAfterLog = checkLabel(amlodipineRead, loggedEveningProfile, afterLogNow);
      assert.equal(secondCheckAfterLog.level, "warning");
      assert.equal(secondCheckAfterLog.takenToday, true);
      assert.ok(secondCheckAfterLog.headline.includes("already taken"), "Post-log headline must warn already taken");
      assert.equal(
        secondCheckAfterLog.speech,
        "This is Amlodipine 5 mg, your evening pill. You already took it today.",
      );

      const ibuprofenRead = toLabelRead({
        kind: "medication",
        product: { value: "Ibuprofen 400 mg", confidence: 0.96 },
        ingredient: { value: "ibuprofen", confidence: 0.95 },
        strength: { value: "400 mg", confidence: 0.95 },
        expiry: { value: validExpiry, confidence: 0.92 },
        readability: 0.92,
      });
      const warningVerdictOut = checkLabel(ibuprofenRead, profile, eveningNow);
      assert.equal(warningVerdictOut.level, "warning");
      assert.equal(
        warningVerdictOut.speech,
        "This is Ibuprofen 400 mg. It isn't on your medication list and your list says to avoid NSAIDs.",
      );
      assert.equal(warningVerdictOut.speech, vrows[1].quote, "Slide 4 Warning <q> must match checkLabel() word-for-word");

      assert.equal(STRENGTH_MIN_CONF, 0.8);
      const metforminLowConfRead = toLabelRead({
        kind: "medication",
        product: { value: "Metformin", confidence: 0.95 },
        ingredient: { value: "metformin", confidence: 0.94 },
        strength: { value: "500 mg", confidence: 0.55 },
        readability: 0.85,
      });
      assert.ok(metforminLowConfRead.strength.confidence < STRENGTH_MIN_CONF);
      const unsureVerdictOut = checkLabel(metforminLowConfRead, profile, eveningNow);
      assert.equal(unsureVerdictOut.level, "unsure");
      assert.ok(unsureVerdictOut.speech.includes("can't read the strength confidently"));
      assert.ok(unsureVerdictOut.speech.includes("or ask a pharmacist"));
      assert.equal(
        unsureVerdictOut.speech,
        "It looks like Metformin, but I can't read the strength confidently. Turn the box so the side panel faces you, or ask a pharmacist.",
      );
      assert.equal(unsureVerdictOut.speech, vrows[2].quote, "Slide 4 Not sure <q> must match checkLabel() word-for-word");
    }),
  );

  test("docs/HUD_SPEC.md matches web/hud/index.html, meta-wearables-manifest.json, PNG headers, server /hud routing, and Hud.tsx controls", () => {
    for (const specToken of [
      "mrbd-web-app-capable",
      "icon-96.png",
      "user-scalable=no",
      "meta-wearables-manifest.json",
      "../icon-mono.png",
      "monochrome",
      "64 KiB",
      'dotfiles: "allow"',
      "RIGHT ONE",
      "CHECK",
      "NOT SURE",
      "Repeat",
      "I took it",
      "Dismiss",
    ]) {
      assert.ok(hudSpecMd.includes(specToken), `docs/HUD_SPEC.md must document "${specToken}"`);
    }

    assert.match(webHudHtml, /<meta\s+name="mrbd-web-app-capable"\s+content="yes"\s*\/?>/);
    assert.match(webHudHtml, /<meta\s+name="application-name"\s+content="HoldUp"\s*\/?>/);
    assert.match(webHudHtml, /<meta\s+name="viewport"\s+content="width=device-width,\s*initial-scale=1"\s*\/?>/);
    assert.match(webHudHtml, /<link\s+rel="icon"\s+type="image\/png"\s+sizes="96x96"\s+href="\/hud\/icon-96\.png"\s*\/?>/);
    assert.equal(webHudHtml.toLowerCase().includes("user-scalable=no"), false, "web/hud/index.html must never set user-scalable=no");
    assert.equal(webHudHtml.toLowerCase().includes("maximum-scale=1"), false, "web/hud/index.html must never lock zoom with maximum-scale=1");

    const manifestRelPath = "web/public/hud/.well-known/meta-wearables-manifest.json";
    const manifestBytes = readRepoBytes(manifestRelPath);
    assert.ok(manifestBytes.length > 0 && manifestBytes.length <= 64 * 1024, `Wearables manifest must be <= 64 KiB, got ${manifestBytes.length} B`);
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
      version: number;
      name: string;
      description?: string;
      appearance?: { theme_color?: string; icon?: { src?: string; type?: string } };
    };
    assert.equal(manifest.version, 1);
    assert.equal(manifest.name, "HoldUp");
    assert.ok((manifest.description ?? "").length >= 10);
    assert.equal(manifest.appearance?.icon?.src, "../icon-mono.png");
    assert.equal(manifest.appearance?.icon?.type, "monochrome");

    const resolvedMonoPath = path.resolve(
      path.dirname(path.join(REPO_DIR, manifestRelPath)),
      manifest.appearance!.icon!.src!,
    );
    assert.equal(resolvedMonoPath, path.join(REPO_DIR, "web/public/hud/icon-mono.png"));

    const iconMonoBytes = readRepoBytes("web/public/hud/icon-mono.png");
    const icon96Bytes = readRepoBytes("web/public/hud/icon-96.png");
    assert.ok(iconMonoBytes.length <= 2 * 1024 * 1024, "icon-mono.png must stay <= 2 MiB");
    const monoHeader = parsePngHeader(iconMonoBytes);
    const icon96Header = parsePngHeader(icon96Bytes);
    assert.ok(monoHeader.width >= 64 && monoHeader.height >= 64, "icon-mono.png must be >= 64x64");
    assert.equal(monoHeader.colorType, 6, "icon-mono.png must have RGBA alpha channel for monochrome mask");
    assert.equal(icon96Header.width, 96, "icon-96.png width must be 96 px (> 52 px)");
    assert.equal(icon96Header.height, 96, "icon-96.png height must be 96 px (> 52 px)");

    assert.match(serverIndexSrc, /express\.static\(\s*dist\s*,\s*\{[\s\S]*?dotfiles:\s*"allow"/);
    assert.match(serverIndexSrc, /const\s+isHud\s*=\s*req\.path\s*===\s*"\/hud"\s*\|\|\s*req\.path\.startsWith\("\/hud\/"\)/);
    assert.match(serverIndexSrc, /res\.sendFile\([\s\S]*?\{\s*dotfiles:\s*"allow"\s*\}\)/);
    assert.match(webViteConfigSrc, /if\s*\(req\.url\s*===\s*"\/hud"\s*\|\|\s*req\.url\?\.startsWith\("\/hud\?"\)\)/);
    assert.match(webViteConfigSrc, /res\.setHeader\("Location",\s*req\.url\.replace\("\/hud",\s*"\/hud\/"\)\)/);
    assert.match(webViteConfigSrc, /hud:\s*resolve\(root,\s*"hud\/index\.html"\)/);

    for (const badgeWord of ["RIGHT ONE", "CHECK", "NOT SURE"]) {
      assert.ok(webHudSrc.includes(`word: "${badgeWord}"`), `Hud.tsx must define "${badgeWord}" level badge`);
    }
    for (const [buttonLabel, actionName] of [
      ["Repeat", "repeat"],
      ["I took it", "log_dose"],
      ["Dismiss", "dismiss"],
    ] as const) {
      const btnRe = new RegExp(`<button[^>]*onClick=\\{\\(\\)\\s*=>\\s*act\\("${actionName}"\\)\\}[^>]*>\\s*${buttonLabel}\\s*<\\x2fbutton>`);
      assert.match(webHudSrc, btnRe, `Hud.tsx must wire native <button>${buttonLabel}</button> to act("${actionName}")`);
    }
    assert.match(serverIndexSrc, /!?\["log_dose",\s*"repeat",\s*"dismiss"\]\.includes\(m\.name\)/);
  });

  test("docs/HARDWARE_NOTES.md matches android-dat Gradle/Manifest/Kotlin sources and prebuilt APK sha256 parity with docs/FILMING_0630.md", () => {
    const deepLinkPrefix = "holdupbridge:" + DOUBLE_SLASH + "connect";

    assert.match(androidLibsToml, /^mwdat\s*=\s*"1\.0\.1"\s*$/m);
    assert.match(androidLibsToml, /^agp\s*=\s*"8\.11\.1"\s*$/m);
    assert.match(androidLibsToml, /^kotlin\s*=\s*"2\.2\.21"\s*$/m);
    assert.match(androidLibsToml, /mwdat-core\s*=\s*\{\s*group\s*=\s*"com\.meta\.wearable",\s*name\s*=\s*"mwdat-core",\s*version\.ref\s*=\s*"mwdat"\s*\}/);
    assert.match(androidLibsToml, /mwdat-camera\s*=\s*\{\s*group\s*=\s*"com\.meta\.wearable",\s*name\s*=\s*"mwdat-camera",\s*version\.ref\s*=\s*"mwdat"\s*\}/);
    assert.ok(hardwareNotesMd.includes("1.0.1") && hardwareNotesMd.includes("com.meta.wearable:mwdat-*:1.0.1"));
    assert.ok(androidSettingsGradle.includes("mavenCentral()"));

    assert.match(androidAppGradle, /applicationId\s*=\s*"app\.holdup\.bridge"/);
    assert.match(androidAppGradle, /minSdk\s*=\s*31\b/);
    assert.match(androidAppGradle, /targetSdk\s*=\s*36\b/);
    assert.match(androidAppGradle, /localProperties\.getProperty\("mwdat_application_id",\s*"0"\)/);
    assert.match(androidAppGradle, /localProperties\.getProperty\("mwdat_client_token",\s*"0"\)/);
    assert.ok(hardwareNotesMd.includes("minSdk 31") && hardwareNotesMd.includes("app.holdup.bridge"));
    assert.ok(hardwareNotesMd.includes("mwdat_application_id=0") && hardwareNotesMd.includes("mwdat_client_token=0"));

    assert.match(androidManifestXml, /android:name="com\.meta\.wearable\.mwdat\.APPLICATION_ID"[\s\S]*?android:value="\$\{mwdat_application_id\}"/);
    assert.match(androidManifestXml, /android:name="com\.meta\.wearable\.mwdat\.CLIENT_TOKEN"[\s\S]*?android:value="\$\{mwdat_client_token\}"/);
    assert.match(androidManifestXml, /<action\s+android:name="android\.intent\.action\.VIEW"\s*\/>[\s\S]*?<data\s+android:scheme="holdupbridge"\s*\/>/);
    assert.match(androidManifestXml, /android:name="\.StreamingService"[\s\S]*?android:foregroundServiceType="connectedDevice"/);
    assert.ok(androidStreamingServiceKt.includes("FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE"));
    assert.ok(androidMainActivityKt.includes("viewModel.handleDeepLink(i.data)"));
    assert.match(androidBridgeVmKt, /uri\.scheme\s*!=\s*"holdupbridge"\s*\|\|\s*uri\.host\s*!=\s*"connect"/);
    assert.ok(hardwareNotesMd.includes(deepLinkPrefix), `docs/HARDWARE_NOTES.md must document ${deepLinkPrefix}`);
    assert.ok(androidReadmeMd.includes(deepLinkPrefix), `android-dat/README.md must document ${deepLinkPrefix}`);

    assert.match(androidBridgeVmKt, /STREAM_FPS\s*=\s*2\b/);
    assert.match(androidBridgeVmKt, /FRAME_INTERVAL_MS\s*=\s*1_000L\b/);
    assert.match(androidBridgeVmKt, /StreamConfiguration\(\s*videoQuality\s*=\s*VideoQuality\.HIGH,\s*frameRate\s*=\s*STREAM_FPS\s*\)/);
    assert.match(androidUploaderKt, /endpoint\(\s*server,\s*"\/ingest\/frame",\s*session\s*\),\s*"image\/jpeg"/);
    assert.match(androidUploaderKt, /endpoint\(\s*server,\s*"\/ingest\/state",\s*session\s*\),\s*"application\/json"/);
    assert.ok(
      hardwareNotesMd.includes("VideoQuality.HIGH") &&
        hardwareNotesMd.includes("2 fps") &&
        hardwareNotesMd.includes("/ingest/frame") &&
        hardwareNotesMd.includes("/ingest/state"),
    );

    const shaRe = /\b[a-f0-9]{64}\b/g;
    const hwHashes = [...hardwareNotesMd.matchAll(shaRe)].map((m) => m[0]);
    const filmingHashes = [...filmingMd.matchAll(shaRe)].map((m) => m[0]);
    assert.ok(hwHashes.length >= 2, "docs/HARDWARE_NOTES.md must record the prebuilt APK sha256 in install steps and Findings log");
    assert.ok(filmingHashes.length >= 1, "docs/FILMING_0630.md must record the prebuilt APK sha256");
    for (const h of [...hwHashes, ...filmingHashes]) {
      assert.equal(h, EXPECTED_APK_SHA256, "APK sha256 must match across docs/HARDWARE_NOTES.md and docs/FILMING_0630.md");
    }
  });

  test("Slide 1, Adoption, Team+Ask and docs/PILOT_PLAN.md maintain team, repo, Junction tracks, and 20-tester Finnish NKL pilot parity across 12- or 13-slide deck plus strict test hygiene", () => {
    assert.ok(
      slides.size === 12 || slides.size === 13,
      `Expected 12 or 13 slides in deck/index.html, got ${slides.size}`,
    );
    for (let n = 1; n <= slides.size; n++) {
      assert.ok(slides.has(`s${n}-h`), `Expected slide heading #s${n}-h in ${slides.size}-slide deck/index.html`);
    }
    const navCountMatch = new RegExp("<span\\s+id=\"count\"[^>]*>([\\s\\S]*?)<\\x2fspan>").exec(deckHtml);
    assert.ok(navCountMatch, "Expected #count span in deck/index.html");
    assert.equal(navCountMatch[1].trim(), `1 ${SLASH} ${slides.size}`);

    const slide1 = slides.get("s1-h");
    const adoptionSlide = findSlideByHeading(slides, "Path to adoption", "Pilot with the people who already help");
    const teamAskSlide = findSlideByHeading(slides, "Team and the ask", "Help us put HoldUp on 20 faces in Finland.");
    assert.ok(slide1, "Expected Slide 1 (#s1-h) in deck/index.html");
    assert.notEqual(adoptionSlide.id, teamAskSlide.id, "Adoption and Team+Ask must be distinct slides");
    assert.equal(slide1.includes(EM_DASH), false, "Slide 1 must contain zero em dashes");
    assert.equal(adoptionSlide.html.includes(EM_DASH), false, `Adoption slide (#${adoptionSlide.id}) must contain zero em dashes`);
    assert.equal(teamAskSlide.html.includes(EM_DASH), false, `Team+Ask slide (#${teamAskSlide.id}) must contain zero em dashes`);

    const slide1Text = stripTags(slide1);
    const adoptionText = stripTags(adoptionSlide.html);
    const teamAskText = stripTags(teamAskSlide.html);

    const expectedTeamMembers = [
      "Silas Wang",
      "Momin AlDahdouh",
      "Ivar Akerholm",
      "Vaishnav Rane",
    ];
    for (const member of expectedTeamMembers) {
      assert.ok(slide1Text.includes(member), `Slide 1 (#s1-h) footer must name "${member}"`);
      assert.ok(teamAskText.includes(member), `Team+Ask slide (#${teamAskSlide.id}) Team card must name "${member}"`);
    }

    const teamCardMatch = new RegExp("<h3>Team<\\x2fh3>\\s*<ul class=\"bul\">([\\s\\S]*?)<\\x2ful>").exec(teamAskSlide.html);
    assert.ok(teamCardMatch, `Team+Ask slide (#${teamAskSlide.id}) must contain <h3>Team</h3> bullet list`);
    const teamBullets = [...teamCardMatch[1].matchAll(new RegExp("<li>([\\s\\S]*?)<\\x2fli>", "g"))].map((m) => stripTags(m[1]));
    assert.ok(teamBullets.length >= 4, `Team+Ask slide (#${teamAskSlide.id}) Team card must include bullets for all 4 human teammates`);
    for (const member of expectedTeamMembers) {
      assert.ok(teamBullets.some((b) => b.startsWith(`${member}:`)), `Team+Ask slide (#${teamAskSlide.id}) Team card must describe role for "${member}"`);
    }

    const repoSlug = ["github.com", "s1laswang", "junction-meta-glasses"].join(SLASH);
    assert.ok(teamAskText.includes(repoSlug), `Team+Ask slide (#${teamAskSlide.id}) must display ${repoSlug}`);
    assert.ok(readmeMd.includes(repoSlug), `README.md must display ${repoSlug}`);
    assert.ok(hardwareNotesMd.includes(repoSlug), `docs/HARDWARE_NOTES.md must display ${repoSlug}`);

    assert.ok(slide1Text.includes("Junction 2026") && slide1Text.includes("Meta AI glasses") && slide1Text.includes("Gemini"));
    assert.ok(
      teamAskText.includes("Junction 2026") &&
        teamAskText.includes("Meta") &&
        teamAskText.includes("AI Glasses for Everyone, Everyday") &&
        teamAskText.includes("Google DeepMind") &&
        teamAskText.includes("Best Use of Gemini API"),
    );
    assert.ok(
      readmeMd.includes('Meta "AI Glasses for Everyone, Everyday"') &&
        readmeMd.includes('Google DeepMind "Best Use of Gemini API"'),
    );
    assert.ok(briefMd.includes("Meta: AI Glasses for Everyone, Everyday (Junction 2026)"));

    const askCardMatch = new RegExp("<h3>The ask<\\x2fh3>\\s*<ul class=\"bul\">([\\s\\S]*?)<\\x2ful>").exec(teamAskSlide.html);
    assert.ok(askCardMatch, `Team+Ask slide (#${teamAskSlide.id}) must contain <h3>The ask</h3> bullet list`);
    const askText = stripTags(askCardMatch[1]);
    assert.ok(teamAskText.includes("Help us put HoldUp on 20 faces in Finland."));
    assert.ok(askText.includes("Meta:") && askText.includes("Device Access Toolkit") && askText.includes("Display Web Apps") && askText.includes("20 testers"));
    assert.ok(askText.includes("Google DeepMind:") && askText.includes("Gemini API credits") && askText.includes("Live API capacity in the EU"));
    assert.ok(askText.includes("Everyone:") && askText.includes("Näkövammaisten liitto") && askText.includes("pharmacy chain") && askText.includes("wellbeing services county"));

    assert.ok(
      adoptionText.includes("Näkövammaisten liitto") &&
        adoptionText.includes("Finnish Federation of the Visually Impaired") &&
        adoptionText.includes("4-week home pilot with 20 members") &&
        adoptionText.includes("Pharmacies") &&
        adoptionText.includes("Home-care nurses"),
    );
    assert.ok(
      pilotPlanMd.includes("Näkövammaisten liitto") &&
        pilotPlanMd.includes("Finnish Federation of the Visually Impaired") &&
        pilotPlanMd.includes("4-week") &&
        pilotPlanMd.includes("**20**") &&
        pilotPlanMd.includes("hyvinvointialueet"),
    );

    const selfSource = fs.readFileSync(TEST_FILE, "utf8");
    assert.equal(selfSource.includes(LINE_COMMENT_TOKEN), false, "Test file must contain zero line comments");
    assert.equal(selfSource.includes(BLOCK_COMMENT_TOKEN), false, "Test file must contain zero block comments");
    assert.equal(selfSource.includes(HTML_COMMENT_TOKEN), false, "Test file must contain zero HTML comments");
    assert.equal(selfSource.includes(EM_DASH), false, "Test file must contain zero U+2014 em dashes");
    assert.equal(selfSource.includes(ESCAPED_EM_DASH), false, "Test file must contain zero escaped u2014 sequences");
    for (const prefix of SECRET_PREFIXES) {
      assert.equal(selfSource.includes(prefix), false, `Test file must contain zero secret prefixes (${prefix})`);
    }
  });
});
