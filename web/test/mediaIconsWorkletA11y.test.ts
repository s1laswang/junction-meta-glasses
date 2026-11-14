import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { runInNewContext } from "node:vm";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CoachCue, VerdictLevel } from "../../shared/types.ts";
import {
  audioRoute,
  classifyError,
  explain,
  getCamera,
  getMic,
  mediaSupported,
  platformHint,
  queryPermission,
  type MediaProblem,
  type PermState,
} from "../src/lib/media.ts";
import { Sonar } from "../src/lib/sonar.ts";

const storageBacking = new Map<string, string>();
const localStorageShim = {
  get length() {
    return storageBacking.size;
  },
  key(index: number): string | null {
    return Array.from(storageBacking.keys())[index] ?? null;
  },
  getItem(key: string): string | null {
    return storageBacking.has(key) ? storageBacking.get(key)! : null;
  },
  setItem(key: string, value: string): void {
    storageBacking.set(key, String(value));
  },
  removeItem(key: string): void {
    storageBacking.delete(key);
  },
  clear(): void {
    storageBacking.clear();
  },
};

Object.defineProperty(globalThis, "localStorage", { value: localStorageShim, configurable: true, writable: true });
Object.defineProperty(globalThis, "React", { value: React, configurable: true, writable: true });
const { CueArrow, Icon, LEVEL_WORD, Logo, VerdictGlyph } = await import("../src/components/Icons.tsx");
const { announce, onAnnounce } = await import("../src/lib/feedback.ts");
const { Announcer } = await import("../src/components/Announcer.tsx");

type QueryResultState = "granted" | "denied" | "prompt";

const windowShim: {
  isSecureContext: boolean;
  AudioContext?: unknown;
  webkitAudioContext?: unknown;
} = {
  isSecureContext: true,
};

const documentShim: Record<string, unknown> = {};

let userAgentValue = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36";
let queryCalls: string[] = [];
let queryImpl: ((desc: { name: string }) => Promise<{ state: QueryResultState }>) | null = async () => ({
  state: "prompt",
});
let getUserMediaCalls: MediaStreamConstraints[] = [];
let getUserMediaImpl: ((constraints: MediaStreamConstraints) => Promise<MediaStream>) | null = async () =>
  ({ id: "fake-stream" } as unknown as MediaStream);
let enumerateDevicesImpl: (() => Promise<MediaDeviceInfo[]>) | null = async () => [];
let mediaDevicesPresent = true;

const navigatorShim = {
  get userAgent(): string {
    return userAgentValue;
  },
  get mediaDevices():
    | {
        getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
        enumerateDevices: () => Promise<MediaDeviceInfo[]>;
      }
    | undefined {
    if (!mediaDevicesPresent) return undefined;
    const obj: {
      getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
      enumerateDevices: () => Promise<MediaDeviceInfo[]>;
    } = {
      enumerateDevices: async () => {
        if (!enumerateDevicesImpl) throw new Error("enumerateDevices unavailable");
        return enumerateDevicesImpl();
      },
    };
    if (getUserMediaImpl) {
      obj.getUserMedia = async (constraints: MediaStreamConstraints) => {
        getUserMediaCalls.push(constraints);
        return getUserMediaImpl!(constraints);
      };
    }
    return obj;
  },
  get permissions():
    | {
        query: (desc: { name: string }) => Promise<{ state: QueryResultState }>;
      }
    | undefined {
    if (!queryImpl) return undefined;
    return {
      query: async (desc: { name: string }) => {
        queryCalls.push(desc.name);
        return queryImpl!(desc);
      },
    };
  },
};

Object.defineProperty(globalThis, "window", { value: windowShim, configurable: true, writable: true });
Object.defineProperty(globalThis, "document", { value: documentShim, configurable: true, writable: true });
Object.defineProperty(globalThis, "navigator", { value: navigatorShim, configurable: true, writable: true });

function resetMediaMocks(): void {
  windowShim.isSecureContext = true;
  delete documentShim.ontouchend;
  userAgentValue = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36";
  queryCalls = [];
  queryImpl = async () => ({ state: "prompt" });
  getUserMediaCalls = [];
  getUserMediaImpl = async () => ({ id: "fake-stream" } as unknown as MediaStream);
  enumerateDevicesImpl = async () => [];
  mediaDevicesPresent = true;
}

function makeDevice(kind: MediaDeviceKind, deviceId: string, label: string): MediaDeviceInfo {
  return {
    kind,
    deviceId,
    label,
    groupId: `grp-${deviceId}`,
    toJSON() {
      return { kind, deviceId, label, groupId: `grp-${deviceId}` };
    },
  } as MediaDeviceInfo;
}

function srgbChannelToLinear(channel8Bit: number): number {
  const c = channel8Bit / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(rgb: readonly [number, number, number]): number {
  return (
    0.2126 * srgbChannelToLinear(rgb[0]) +
    0.7152 * srgbChannelToLinear(rgb[1]) +
    0.0722 * srgbChannelToLinear(rgb[2])
  );
}

function contrastRatio(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function computeCrc32(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    let c = (crc ^ buf[n]!) & 0xff;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

type DecodedPng = {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  pixels: Uint8Array;
};

function decodePngRgba(bytes: Buffer): DecodedPng {
  const expectedSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.deepEqual(bytes.subarray(0, 8), expectedSig);

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let sawIhdr = false;
  let sawIend = false;
  const idatParts: Buffer[] = [];

  while (offset < bytes.length) {
    assert.ok(offset + 12 <= bytes.length);
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    assert.ok(dataEnd + 4 <= bytes.length);

    const data = bytes.subarray(dataStart, dataEnd);
    const expectedCrc = bytes.readUInt32BE(dataEnd);
    const actualCrc = computeCrc32(bytes.subarray(offset + 4, dataEnd));
    assert.equal(actualCrc, expectedCrc, `CRC mismatch in PNG chunk ${type}`);

    if (type === "IHDR") {
      assert.equal(length, 13);
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8]!;
      colorType = data[9]!;
      assert.equal(data[10], 0);
      assert.equal(data[11], 0);
      assert.equal(data[12], 0);
      sawIhdr = true;
    } else if (type === "IDAT") {
      idatParts.push(data);
    } else if (type === "IEND") {
      assert.equal(length, 0);
      sawIend = true;
      offset = dataEnd + 4;
      break;
    }

    offset = dataEnd + 4;
  }

  assert.equal(sawIhdr, true);
  assert.equal(sawIend, true);
  assert.equal(offset, bytes.length);
  assert.equal(bitDepth, 8);
  assert.equal(colorType, 6);

  const inflated = inflateSync(Buffer.concat(idatParts));
  const stride = width * 4;
  assert.equal(inflated.length, height * (stride + 1));

  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filterType = inflated[rowStart]!;
    assert.equal(filterType, 0);
    pixels.set(inflated.subarray(rowStart + 1, rowStart + 1 + stride), y * stride);
  }

  return { width, height, bitDepth, colorType, pixels };
}

function pixelAt(png: DecodedPng, x: number, y: number): [number, number, number, number] {
  const idx = (y * png.width + x) * 4;
  return [png.pixels[idx]!, png.pixels[idx + 1]!, png.pixels[idx + 2]!, png.pixels[idx + 3]!];
}

type WorkletMessage = { pcm: ArrayBuffer; rms: number };
type WorkletProcessorInstance = {
  outRate: number;
  chunk: number;
  ratio: number;
  pos: number;
  carry: Float32Array;
  out: Int16Array;
  outLen: number;
  sumSq: number;
  port: { postMessage: (msg: WorkletMessage, transfer?: Transferable[]) => void };
  process: (inputs: Array<Array<Float32Array | undefined> | undefined>) => boolean;
};
type WorkletProcessorCtor = new (options?: {
  processorOptions?: { outRate?: number; chunkMs?: number };
}) => WorkletProcessorInstance;

const WORKLET_SOURCE = readFileSync(new URL("../public/pcm-capture-worklet.js", import.meta.url), "utf8");

function loadWorkletHarness(contextSampleRate: number): {
  registeredName: string;
  Ctor: WorkletProcessorCtor;
  posted: Array<{ msg: WorkletMessage; transfer: Transferable[] | undefined }>;
} {
  let registeredName = "";
  let Registered: WorkletProcessorCtor | null = null;
  const posted: Array<{ msg: WorkletMessage; transfer: Transferable[] | undefined }> = [];

  class BaseAudioWorkletProcessor {
    port = {
      postMessage(msg: WorkletMessage, transfer?: Transferable[]) {
        posted.push({ msg, transfer });
      },
    };
  }

  runInNewContext(WORKLET_SOURCE, {
    AudioWorkletProcessor: BaseAudioWorkletProcessor,
    sampleRate: contextSampleRate,
    Float32Array,
    Int16Array,
    Math,
    registerProcessor(name: string, ctor: WorkletProcessorCtor) {
      registeredName = name;
      Registered = ctor;
    },
  });

  assert.ok(Registered, "Expected PcmCapture to call registerProcessor");
  return { registeredName, Ctor: Registered as WorkletProcessorCtor, posted };
}

function assertDecorativeSvg(markup: string, expectedWidth: number, expectedHeight: number, expectedViewBox: string): void {
  assert.match(markup, /^<svg\b[^>]*>[\s\S]*<\/svg>$/);
  assert.ok(markup.includes(`width="${expectedWidth}"`));
  assert.ok(markup.includes(`height="${expectedHeight}"`));
  assert.ok(markup.includes(`viewBox="${expectedViewBox}"`));
  assert.ok(markup.includes('aria-hidden="true"'));
  assert.ok(markup.includes('focusable="false"'));
  assert.equal(markup.includes("<title"), false);
  assert.equal(markup.includes('role="img"'), false);
}

test("mediaSupported and queryPermission enforce secure-context, getUserMedia availability, blocked mapping, and Safari/Firefox fallback", async () => {
  resetMediaMocks();
  assert.equal(mediaSupported(), true);

  getUserMediaImpl = null;
  assert.equal(mediaSupported(), false);

  mediaDevicesPresent = false;
  assert.equal(mediaSupported(), false);

  resetMediaMocks();
  windowShim.isSecureContext = false;
  assert.equal(await queryPermission("camera"), "insecure");
  assert.equal(await queryPermission("microphone"), "insecure");
  assert.deepEqual(queryCalls, []);

  resetMediaMocks();
  mediaDevicesPresent = false;
  assert.equal(await queryPermission("camera"), "unavailable");
  assert.equal(await queryPermission("microphone"), "unavailable");
  assert.deepEqual(queryCalls, []);

  resetMediaMocks();
  const stateByTarget: Record<string, QueryResultState> = {
    camera: "granted",
    microphone: "denied",
  };
  queryImpl = async ({ name }) => ({ state: stateByTarget[name] ?? "prompt" });

  assert.equal(await queryPermission("camera"), "granted");
  assert.equal(await queryPermission("microphone"), "blocked");
  assert.deepEqual(queryCalls, ["camera", "microphone"]);

  stateByTarget.camera = "prompt";
  assert.equal(await queryPermission("camera"), "prompt");

  queryImpl = async () => {
    throw new TypeError("camera permission descriptor unsupported in this browser");
  };
  assert.equal(await queryPermission("camera"), "unknown");

  queryImpl = null;
  assert.equal(await queryPermission("microphone"), "unknown");
});

test("classifyError maps all DOMException names to actionable PermState buckets with safe denied fallback", () => {
  const expectedMappings: Array<[string, PermState]> = [
    ["NotAllowedError", "denied"],
    ["PermissionDeniedError", "denied"],
    ["NotFoundError", "unavailable"],
    ["DevicesNotFoundError", "unavailable"],
    ["OverconstrainedError", "unavailable"],
    ["NotReadableError", "in-use"],
    ["TrackStartError", "in-use"],
    ["AbortError", "in-use"],
    ["SecurityError", "insecure"],
    ["InvalidStateError", "denied"],
    ["UnknownError", "denied"],
  ];

  for (const [name, expected] of expectedMappings) {
    const domLikeError = Object.assign(new Error(`Simulated ${name}`), { name });
    assert.equal(classifyError(domLikeError), expected, `Unexpected mapping for ${name}`);
  }

  assert.equal(classifyError(new Error("plain error")), "denied");
  assert.equal(classifyError({}), "denied");
  assert.equal(classifyError(null), "denied");
  assert.equal(classifyError(undefined), "denied");
  assert.equal(classifyError("string rejection"), "denied");
  assert.equal(classifyError(404), "denied");
});

test("explain produces plain-language, non-blaming camera and microphone recovery copy without technical jargon", () => {
  const problemSample: MediaProblem = {
    kind: "camera",
    state: "denied",
    message: explain("camera", "denied"),
  };
  assert.equal(
    problemSample.message,
    "You said no to the camera. That's fine. You can turn it on any time.",
  );
  assert.equal(
    explain("mic", "denied"),
    "You said no to the microphone. That's fine. You can turn it on any time.",
  );

  assert.equal(
    explain("camera", "blocked"),
    "The camera is blocked for this site in your browser settings.",
  );
  assert.equal(
    explain("mic", "blocked"),
    "The microphone is blocked for this site in your browser settings.",
  );

  assert.equal(
    explain("camera", "unavailable"),
    "This device has no camera that HoldUp can use.",
  );
  assert.equal(
    explain("mic", "unavailable"),
    "This device has no microphone that HoldUp can use.",
  );

  assert.equal(
    explain("camera", "in-use"),
    "Another app is using the camera. Close it and try again.",
  );
  assert.equal(
    explain("mic", "in-use"),
    "Another app is using the microphone. Close it and try again.",
  );

  assert.equal(
    explain("camera", "insecure"),
    "The camera needs a secure (https) connection. Open HoldUp through its https link.",
  );
  assert.equal(
    explain("mic", "insecure"),
    "The microphone needs a secure (https) connection. Open HoldUp through its https link.",
  );

  const silentStates: PermState[] = ["unknown", "prompt", "granted"];
  for (const s of silentStates) {
    assert.equal(explain("camera", s), "");
    assert.equal(explain("mic", s), "");
  }

  const problemStates: PermState[] = ["denied", "blocked", "unavailable", "in-use", "insecure"];
  for (const kind of ["camera", "mic"] as const) {
    const noun = kind === "camera" ? "camera" : "microphone";
    for (const s of problemStates) {
      const msg = explain(kind, s);
      assert.ok(msg.length >= 20 && msg.length <= 120);
      assert.ok(msg.toLowerCase().includes(noun));
      assert.ok(msg.endsWith("."));
      assert.doesNotMatch(msg, /Error|DOMException|getUserMedia|stack|errno/i);
    }
  }
});

test("getCamera and getMic request exact label-reading rear-video and mono voice-DSP constraints", async () => {
  resetMediaMocks();
  const cameraStream = { id: "rear-camera-stream" } as unknown as MediaStream;
  const micStream = { id: "mono-mic-stream" } as unknown as MediaStream;

  let nextStream = cameraStream;
  getUserMediaImpl = async () => nextStream;

  const gotCam = await getCamera();
  assert.equal(gotCam, cameraStream);
  assert.equal(getUserMediaCalls.length, 1);
  assert.deepEqual(getUserMediaCalls[0], {
    audio: false,
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 1280 },
      height: { ideal: 960 },
      frameRate: { ideal: 15, max: 30 },
    },
  });

  nextStream = micStream;
  const gotDefaultMic = await getMic();
  assert.equal(gotDefaultMic, micStream);
  assert.equal(getUserMediaCalls.length, 2);
  assert.deepEqual(getUserMediaCalls[1], {
    video: false,
    audio: {
      deviceId: undefined,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });

  await getMic("ray-ban-meta-bt-01");
  assert.equal(getUserMediaCalls.length, 3);
  assert.deepEqual(getUserMediaCalls[2], {
    video: false,
    audio: {
      deviceId: { exact: "ray-ban-meta-bt-01" },
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });

  await getMic("");
  assert.equal(getUserMediaCalls.length, 4);
  assert.equal((getUserMediaCalls[3]?.audio as MediaTrackConstraints).deviceId, undefined);
});

test("audioRoute selects default devices, strips Default prefix, detects Ray-Ban Meta and Bluetooth audio, and handles errors", async () => {
  resetMediaMocks();

  enumerateDevicesImpl = async () => [
    makeDevice("videoinput", "cam-1", "Back Triple Camera"),
    makeDevice("audioinput", "builtin-mic", "Phone Microphone"),
    makeDevice("audioinput", "default", "Default - Ray-Ban Meta Hands-Free"),
    makeDevice("audiooutput", "builtin-spk", "Phone Receiver"),
    makeDevice("audiooutput", "default", "Default - Speaker"),
  ];
  const glassesRoute = await audioRoute();
  assert.deepEqual(glassesRoute, {
    input: "Ray-Ban Meta Hands-Free",
    output: "Speaker",
    bluetooth: true,
  });

  enumerateDevicesImpl = async () => [
    makeDevice("audioinput", "mic-1", "Internal Microphone"),
    makeDevice("audiooutput", "out-1", "AirPods Pro"),
  ];
  const fallbackFirstDevice = await audioRoute();
  assert.deepEqual(fallbackFirstDevice, {
    input: "Internal Microphone",
    output: "AirPods Pro",
    bluetooth: true,
  });

  const btLabels = [
    "Bluetooth Headset",
    "RayBan Stories Audio",
    "Meta AI Glasses",
    "Handsfree Unit",
    "Galaxy Buds2",
    "JBL BT Audio",
  ];
  for (const label of btLabels) {
    enumerateDevicesImpl = async () => [makeDevice("audioinput", "default", label)];
    const r = await audioRoute();
    assert.equal(r.bluetooth, true, `Expected bluetooth=true for "${label}"`);
    assert.equal(r.input, label);
    assert.equal(r.output, "");
  }

  enumerateDevicesImpl = async () => [
    makeDevice("audioinput", "default", "Default - iPhone Microphone"),
    makeDevice("audiooutput", "default", "Default - Built-in Receiver"),
  ];
  const wiredOrBuiltin = await audioRoute();
  assert.deepEqual(wiredOrBuiltin, {
    input: "iPhone Microphone",
    output: "Built-in Receiver",
    bluetooth: false,
  });

  enumerateDevicesImpl = async () => [];
  assert.deepEqual(await audioRoute(), { input: "", output: "", bluetooth: false });

  enumerateDevicesImpl = async () => {
    throw new Error("SecurityError: enumerateDevices blocked");
  };
  assert.deepEqual(await audioRoute(), { input: "", output: "", bluetooth: false });
});

test("platformHint distinguishes iOS, iPadOS desktop-class Safari via ontouchend, Android, and desktop UAs", () => {
  resetMediaMocks();

  userAgentValue = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";
  assert.equal(platformHint(), "ios");

  userAgentValue = "Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
  assert.equal(platformHint(), "ios");

  userAgentValue = "Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X)";
  assert.equal(platformHint(), "ios");

  userAgentValue = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15";
  delete documentShim.ontouchend;
  assert.equal(platformHint(), "desktop");

  documentShim.ontouchend = null;
  assert.equal(platformHint(), "ios");
  delete documentShim.ontouchend;

  userAgentValue = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36";
  assert.equal(platformHint(), "android");

  userAgentValue = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36";
  assert.equal(platformHint(), "desktop");
});

test("VerdictGlyph and LEVEL_WORD enforce WCAG 1.4.1 non-color shape differentiation across all VerdictLevel states", () => {
  const levels: VerdictLevel[] = ["match", "warning", "unsure", "info"];
  assert.deepEqual(LEVEL_WORD, {
    match: "Match",
    warning: "Warning",
    unsure: "Not sure",
    info: "Info",
  });

  const markups = new Map<VerdictLevel, string>();
  for (const level of levels) {
    const html = renderToStaticMarkup(createElement(VerdictGlyph, { level }));
    assertDecorativeSvg(html, 72, 72, "0 0 72 72");
    assert.ok(html.includes('fill="currentColor"'));
    assert.ok(html.includes("#0b1018"));
    markups.set(level, html);

    const customSized = renderToStaticMarkup(createElement(VerdictGlyph, { level, size: 48 }));
    assertDecorativeSvg(customSized, 48, 48, "0 0 72 72");
  }

  assert.equal(new Set(markups.values()).size, 4);

  const matchSvg = markups.get("match")!;
  const warningSvg = markups.get("warning")!;
  const unsureSvg = markups.get("unsure")!;
  const infoSvg = markups.get("info")!;

  assert.match(matchSvg, /<circle cx="36" cy="36" r="32" fill="currentColor"><\/circle>/);
  assert.match(warningSvg, /<path d="M36 5l33 60H3z" fill="currentColor"/);
  assert.match(unsureSvg, /<path d="M36 3l33 33-33 33L3 36z" fill="currentColor"><\/path>/);
  assert.match(infoSvg, /<rect x="5" y="5" width="62" height="62" rx="10" fill="currentColor"><\/rect>/);
});

test("CueArrow renders pairwise-unique decorative SVGs for all 8 CoachCue states plus null framing fallback", () => {
  const cues: Array<CoachCue | null> = [
    "rotate_left",
    "rotate_right",
    "closer",
    "farther",
    "more_light",
    "hold_still",
    "other_side",
    "ok",
    null,
  ];

  const renderedByCue = new Map<CoachCue | "null", string>();
  for (const cue of cues) {
    const html = renderToStaticMarkup(createElement(CueArrow, { cue }));
    assertDecorativeSvg(html, 56, 56, "0 0 24 24");
    assert.ok(html.includes('stroke="currentColor"'));
    assert.ok(html.includes('stroke-width="2.4"'));
    assert.ok(html.includes('fill="none"'));
    renderedByCue.set(cue ?? "null", html);

    const hudSized = renderToStaticMarkup(createElement(CueArrow, { cue, size: 96 }));
    assertDecorativeSvg(hudSized, 96, 96, "0 0 24 24");
  }

  assert.equal(new Set(renderedByCue.values()).size, 9);
  assert.ok(renderedByCue.get("more_light")!.includes('<circle cx="12" cy="12" r="4"></circle>'));
  assert.ok(renderedByCue.get("ok")!.includes("M5 12.5l4.5 4.5L19 7.5"));
  assert.ok(renderedByCue.get("null")!.includes("M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4"));
});

test("Logo and all 15 Icon glyphs enforce decorative aria-hidden semantics, custom sizes, and AAA brand mark contrast", () => {
  const defaultLogo = renderToStaticMarkup(createElement(Logo, {}));
  assertDecorativeSvg(defaultLogo, 32, 32, "0 0 32 32");
  assert.ok(defaultLogo.includes('fill="#ffd23f"'));
  assert.ok(defaultLogo.includes('stroke="#0b1018"'));

  const heroLogo = renderToStaticMarkup(createElement(Logo, { size: 64 }));
  assertDecorativeSvg(heroLogo, 64, 64, "0 0 32 32");

  const brandYellow = [0xff, 0xd2, 0x3f] as const;
  const brandInk = [0x0b, 0x10, 0x18] as const;
  const logoContrast = contrastRatio(brandYellow, brandInk);
  assert.ok(logoContrast >= 13, `Expected brand mark contrast >= 13:1, got ${logoContrast.toFixed(2)}`);

  const expectedIconNames: Array<keyof typeof Icon> = [
    "camera",
    "mic",
    "cloud",
    "phone",
    "lock",
    "check",
    "x",
    "glasses",
    "wifiOff",
    "alert",
    "info",
    "list",
    "shield",
    "scan",
    "trash",
  ];

  assert.deepEqual(Object.keys(Icon).sort(), [...expectedIconNames].sort());

  const iconMarkups = new Set<string>();
  for (const name of expectedIconNames) {
    const Glyph = Icon[name];
    const defaultHtml = renderToStaticMarkup(createElement(Glyph, {}));
    assertDecorativeSvg(defaultHtml, 28, 28, "0 0 24 24");
    assert.ok(defaultHtml.includes('stroke="currentColor"'));
    assert.ok(defaultHtml.includes('stroke-width="2.2"'));
    assert.ok(defaultHtml.includes('stroke-linecap="round"'));
    assert.ok(defaultHtml.includes('stroke-linejoin="round"'));
    iconMarkups.add(defaultHtml);

    const sizedHtml = renderToStaticMarkup(createElement(Glyph, { size: 24 }));
    assertDecorativeSvg(sizedHtml, 24, 24, "0 0 24 24");
  }

  assert.equal(iconMarkups.size, expectedIconNames.length);
});

test("PWA and Ray-Ban Display HUD icon assets match Logo geometry, valid PNG CRCs, maskable bleed, and monochrome HUD spec", () => {
  const iconSvgDisk = readFileSync(new URL("../public/icons/icon.svg", import.meta.url), "utf8").trim();
  const logoMarkup = renderToStaticMarkup(createElement(Logo, {}));
  assert.ok(iconSvgDisk.includes('viewBox="0 0 32 32"'));
  assert.ok(iconSvgDisk.includes('fill="#ffd23f"'));
  assert.ok(iconSvgDisk.includes('stroke="#0b1018"'));
  assert.ok(iconSvgDisk.includes("M7 12V8h4M21 8h4v4M25 20v4h-4M11 24H7v-4"));
  assert.ok(logoMarkup.includes("M7 12V8h4M21 8h4v4M25 20v4h-4M11 24H7v-4"));

  const png192 = decodePngRgba(readFileSync(new URL("../public/icons/icon-192.png", import.meta.url)));
  assert.equal(png192.width, 192);
  assert.equal(png192.height, 192);
  assert.equal(pixelAt(png192, 0, 0)[3], 0);
  assert.deepEqual(pixelAt(png192, 96, 96), [0x0b, 0x10, 0x18, 0xff]);
  assert.deepEqual(pixelAt(png192, 24, 96), [0xff, 0xd2, 0x3f, 0xff]);

  const png512 = decodePngRgba(readFileSync(new URL("../public/icons/icon-512.png", import.meta.url)));
  assert.equal(png512.width, 512);
  assert.equal(png512.height, 512);
  assert.equal(pixelAt(png512, 0, 0)[3], 0);
  assert.deepEqual(pixelAt(png512, 256, 256), [0x0b, 0x10, 0x18, 0xff]);
  assert.deepEqual(pixelAt(png512, 64, 256), [0xff, 0xd2, 0x3f, 0xff]);

  const maskable512 = decodePngRgba(readFileSync(new URL("../public/icons/maskable-512.png", import.meta.url)));
  assert.equal(maskable512.width, 512);
  assert.equal(maskable512.height, 512);
  assert.deepEqual(pixelAt(maskable512, 0, 0), [0xff, 0xd2, 0x3f, 0xff]);
  assert.deepEqual(pixelAt(maskable512, 511, 511), [0xff, 0xd2, 0x3f, 0xff]);
  assert.deepEqual(pixelAt(maskable512, 256, 256), [0x0b, 0x10, 0x18, 0xff]);

  const hud96 = decodePngRgba(readFileSync(new URL("../public/hud/icon-96.png", import.meta.url)));
  assert.ok(hud96.width > 52 && hud96.height > 52);
  assert.equal(hud96.width, 96);
  assert.equal(hud96.height, 96);
  assert.equal(pixelAt(hud96, 0, 0)[3], 0);
  assert.deepEqual(pixelAt(hud96, 48, 48), [0x0b, 0x10, 0x18, 0xff]);

  const hudMono = decodePngRgba(readFileSync(new URL("../public/hud/icon-mono.png", import.meta.url)));
  assert.equal(hudMono.width, 128);
  assert.equal(hudMono.height, 128);
  assert.deepEqual(pixelAt(hudMono, 0, 0), [0, 0, 0, 0]);
  assert.deepEqual(pixelAt(hudMono, 16, 64), [0, 0, 0, 0]);
  assert.deepEqual(pixelAt(hudMono, 64, 64), [0xff, 0xff, 0xff, 0xff]);

  let nonTransparentMonoPixels = 0;
  for (let i = 0; i < hudMono.pixels.length; i += 4) {
    const a = hudMono.pixels[i + 3]!;
    if (a > 0) {
      nonTransparentMonoPixels++;
      assert.equal(hudMono.pixels[i], 0xff);
      assert.equal(hudMono.pixels[i + 1], 0xff);
      assert.equal(hudMono.pixels[i + 2], 0xff);
    }
  }
  assert.ok(nonTransparentMonoPixels > 500);
});

test("pcm-capture worklet handles default/custom processorOptions, empty inputs, stereo downmix, clamping, RMS, and transferable buffers", () => {
  const { registeredName, Ctor, posted } = loadWorkletHarness(48000);
  assert.equal(registeredName, "pcm-capture");

  const defaultProc = new Ctor();
  assert.equal(defaultProc.outRate, 16000);
  assert.equal(defaultProc.chunk, 1600);
  assert.equal(defaultProc.ratio, 3);

  assert.equal(defaultProc.process([]), true);
  assert.equal(defaultProc.process([[]]), true);
  assert.equal(defaultProc.process([[undefined]]), true);
  assert.equal(posted.length, 0);

  const customProc = new Ctor({ processorOptions: { outRate: 8000, chunkMs: 50 } });
  assert.equal(customProc.outRate, 8000);
  assert.equal(customProc.chunk, 400);
  assert.equal(customProc.ratio, 6);

  const left = new Float32Array(2500).fill(1.0);
  const right = new Float32Array(2500).fill(-0.5);
  assert.equal(customProc.process([[left, right]]), true);
  assert.equal(posted.length, 1);
  assert.equal(posted[0]!.msg.pcm.byteLength, 400 * 2);
  assert.equal(posted[0]!.transfer?.length, 1);
  assert.equal(posted[0]!.transfer?.[0], posted[0]!.msg.pcm);
  assert.ok(Math.abs(posted[0]!.msg.rms - 0.25) < 1e-6);

  const downmixed = new Int16Array(posted[0]!.msg.pcm);
  const expectedQuarter = Math.trunc(0.25 * 0x7fff);
  assert.ok(downmixed.every((s) => s === expectedQuarter));

  assert.equal(customProc.process([[left, right]]), true);
  assert.equal(posted.length, 2);
  assert.notEqual(posted[0]!.msg.pcm, posted[1]!.msg.pcm);
  assert.equal(posted[1]!.transfer?.length, 1);
  assert.equal(posted[1]!.transfer?.[0], posted[1]!.msg.pcm);

  posted.length = 0;
  const clipProc = new Ctor({ processorOptions: { outRate: 16000, chunkMs: 10 } });
  assert.equal(clipProc.chunk, 160);
  const posSamples = 240;
  const negSamples = 243;
  const posHalf = new Float32Array(posSamples).fill(2.5);
  const negHalf = new Float32Array(negSamples).fill(-3.0);
  const combined = new Float32Array(posSamples + negSamples);
  combined.set(posHalf, 0);
  combined.set(negHalf, posSamples);

  assert.equal(clipProc.process([[combined]]), true);
  assert.equal(posted.length, 1);
  assert.equal(posted[0]!.msg.rms, 1);
  const clippedSamples = new Int16Array(posted[0]!.msg.pcm);
  assert.equal(clippedSamples[0], 0x7fff);
  assert.equal(clippedSamples[clippedSamples.length - 1], -0x8000);
});

test("pcm-capture worklet preserves fractional carry across 44.1 kHz, 24 kHz linear interpolation, and 48 kHz box anti-alias filtering", () => {
  const h441 = loadWorkletHarness(44100);
  const proc441 = new h441.Ctor({ processorOptions: { outRate: 16000, chunkMs: 100 } });
  const totalBlocks = 100;
  const blockLen = 128;
  let phase = 0;
  const freq = 400;

  for (let b = 0; b < totalBlocks; b++) {
    const block = new Float32Array(blockLen);
    for (let i = 0; i < blockLen; i++) {
      block[i] = 0.5 * Math.sin((2 * Math.PI * freq * phase) / 44100);
      phase++;
    }
    assert.equal(proc441.process([[block]]), true);
  }

  assert.ok(h441.posted.length >= 2 && h441.posted.length <= 3);
  const totalProduced = h441.posted.length * 1600 + proc441.outLen;
  assert.ok(totalProduced >= 4640 && totalProduced <= 4800);
  assert.ok(proc441.pos >= 0 && proc441.pos < 1);
  assert.ok(proc441.carry.length <= 2);

  const expectedSineRms = 0.5 / Math.SQRT2;
  for (const item of h441.posted) {
    assert.equal(item.msg.pcm.byteLength, 3200);
    assert.ok(Math.abs(item.msg.rms - expectedSineRms) < 0.02);
  }

  const h24 = loadWorkletHarness(24000);
  const proc24 = new h24.Ctor({ processorOptions: { outRate: 16000, chunkMs: 10 } });
  assert.equal(proc24.ratio, 1.5);
  const ramp = new Float32Array(250);
  for (let i = 0; i < ramp.length; i++) {
    ramp[i] = i / 250;
  }
  proc24.process([[ramp]]);
  assert.equal(h24.posted.length, 1);
  const interpSamples = new Int16Array(h24.posted[0]!.msg.pcm);
  assert.equal(interpSamples[0], 0);
  const expectedSample1 = Math.trunc((1.5 / 250) * 0x7fff);
  const expectedSample2 = Math.trunc((3.0 / 250) * 0x7fff);
  assert.ok(Math.abs(interpSamples[1]! - expectedSample1) <= 1);
  assert.ok(Math.abs(interpSamples[2]! - expectedSample2) <= 1);

  const h48 = loadWorkletHarness(48000);
  const proc48 = new h48.Ctor({ processorOptions: { outRate: 16000, chunkMs: 10 } });
  assert.equal(proc48.ratio, 3);
  const nyquistTripletCancel = new Float32Array(486);
  for (let i = 0; i < nyquistTripletCancel.length; i += 3) {
    nyquistTripletCancel[i] = 0.9;
    nyquistTripletCancel[i + 1] = -0.9;
    nyquistTripletCancel[i + 2] = 0;
  }
  proc48.process([[nyquistTripletCancel]]);
  assert.equal(h48.posted.length, 1);
  assert.ok(h48.posted[0]!.msg.rms < 1e-6);
  const filteredOut = new Int16Array(h48.posted[0]!.msg.pcm);
  assert.ok(filteredOut.every((v) => v === 0));
});

type AudioParamEvent = {
  op: string;
  value?: number;
  time: number;
  timeConstant?: number;
};

class FakeSonarAudioParam {
  value = 0;
  events: AudioParamEvent[] = [];

  setTargetAtTime(target: number, startTime: number, timeConstant: number): void {
    this.value = target;
    this.events.push({ op: "setTargetAtTime", value: target, time: startTime, timeConstant });
  }

  setValueAtTime(value: number, startTime: number): void {
    this.value = value;
    this.events.push({ op: "setValueAtTime", value, time: startTime });
  }

  linearRampToValueAtTime(value: number, endTime: number): void {
    this.value = value;
    this.events.push({ op: "linearRampToValueAtTime", value, time: endTime });
  }

  exponentialRampToValueAtTime(value: number, endTime: number): void {
    this.value = value;
    this.events.push({ op: "exponentialRampToValueAtTime", value, time: endTime });
  }

  cancelScheduledValues(startTime: number): void {
    this.events.push({ op: "cancelScheduledValues", time: startTime });
  }
}

class FakeSonarOscillator {
  type: OscillatorType = "sine";
  frequency = new FakeSonarAudioParam();
  connectedTo: unknown[] = [];
  startedAt: number[] = [];
  stoppedAt: number[] = [];
  throwOnStop = false;

  connect<T>(dest: T): T {
    this.connectedTo.push(dest);
    return dest;
  }

  start(when = 0): void {
    this.startedAt.push(when);
  }

  stop(when = 0): void {
    if (this.throwOnStop) throw new Error("InvalidStateError");
    this.stoppedAt.push(when);
  }
}

class FakeSonarBiquadFilter {
  type: BiquadFilterType = "lowpass";
  frequency = new FakeSonarAudioParam();
  connectedTo: unknown[] = [];

  connect<T>(dest: T): T {
    this.connectedTo.push(dest);
    return dest;
  }
}

class FakeSonarGainNode {
  gain = new FakeSonarAudioParam();
  connectedTo: unknown[] = [];

  connect<T>(dest: T): T {
    this.connectedTo.push(dest);
    return dest;
  }
}

class FakeSonarAudioContext {
  static instances: FakeSonarAudioContext[] = [];
  static throwOnConstruct = false;
  static rejectOnResume = false;
  static initialState: AudioContextState = "suspended";

  state: AudioContextState = FakeSonarAudioContext.initialState;
  currentTime = 4.0;
  destination = { kind: "sonar-destination" };
  oscillators: FakeSonarOscillator[] = [];
  filters: FakeSonarBiquadFilter[] = [];
  gains: FakeSonarGainNode[] = [];
  resumeCalls = 0;

  constructor() {
    if (FakeSonarAudioContext.throwOnConstruct) {
      throw new Error("NotSupportedError: Web Audio disabled");
    }
    FakeSonarAudioContext.instances.push(this);
  }

  static reset(): void {
    FakeSonarAudioContext.instances = [];
    FakeSonarAudioContext.throwOnConstruct = false;
    FakeSonarAudioContext.rejectOnResume = false;
    FakeSonarAudioContext.initialState = "suspended";
  }

  createOscillator(): OscillatorNode {
    const o = new FakeSonarOscillator();
    this.oscillators.push(o);
    return o as unknown as OscillatorNode;
  }

  createBiquadFilter(): BiquadFilterNode {
    const f = new FakeSonarBiquadFilter();
    this.filters.push(f);
    return f as unknown as BiquadFilterNode;
  }

  createGain(): GainNode {
    const g = new FakeSonarGainNode();
    this.gains.push(g);
    return g as unknown as GainNode;
  }

  async resume(): Promise<void> {
    this.resumeCalls++;
    if (FakeSonarAudioContext.rejectOnResume) {
      throw new Error("NotAllowedError: gesture required");
    }
    if (this.state === "suspended") {
      this.state = "running";
    }
  }
}

test("Announcer renders polite status and assertive alert atomic sr-only regions and supports rapid identical message re-announcement", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const ssrHtml = renderToStaticMarkup(createElement(Announcer));
  assert.equal(
    ssrHtml,
    '<div class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>' +
      '<div class="sr-only" role="alert" aria-live="assertive" aria-atomic="true"></div>',
  );

  const announcerSrc = readFileSync(new URL("../src/components/Announcer.tsx", import.meta.url), "utf8");
  assert.ok(announcerSrc.includes('set("")'));
  assert.ok(announcerSrc.includes("setTimeout(() => set(msg), 60)"));

  let politeRegion = "";
  let assertiveRegion = "";
  const politeHistory: string[] = [];
  const assertiveHistory: string[] = [];

  const unsubMirror = onAnnounce((msg, p) => {
    if (p === "assertive") {
      assertiveRegion = "";
      assertiveHistory.push(assertiveRegion);
      setTimeout(() => {
        assertiveRegion = msg;
        assertiveHistory.push(assertiveRegion);
      }, 60);
    } else {
      politeRegion = "";
      politeHistory.push(politeRegion);
      setTimeout(() => {
        politeRegion = msg;
        politeHistory.push(politeRegion);
      }, 60);
    }
  });

  const secondaryLog: Array<{ msg: string; p: "polite" | "assertive" }> = [];
  const unsubSecondary = onAnnounce((msg, p) => secondaryLog.push({ msg, p }));

  announce("Turn box left");
  assert.equal(politeRegion, "");
  assert.equal(assertiveRegion, "");
  t.mock.timers.tick(60);
  assert.equal(politeRegion, "Turn box left");

  announce("Turn box left");
  assert.equal(politeRegion, "");
  t.mock.timers.tick(59);
  assert.equal(politeRegion, "");
  t.mock.timers.tick(1);
  assert.equal(politeRegion, "Turn box left");

  announce("Warning: contains peanuts", "assertive");
  assert.equal(assertiveRegion, "");
  assert.equal(politeRegion, "Turn box left");
  t.mock.timers.tick(60);
  assert.equal(assertiveRegion, "Warning: contains peanuts");

  announce("Warning: contains peanuts", "assertive");
  assert.equal(assertiveRegion, "");
  t.mock.timers.tick(60);
  assert.equal(assertiveRegion, "Warning: contains peanuts");

  assert.deepEqual(politeHistory, ["", "Turn box left", "", "Turn box left"]);
  assert.deepEqual(assertiveHistory, ["", "Warning: contains peanuts", "", "Warning: contains peanuts"]);

  unsubSecondary();
  announce("Camera stopped", "polite");
  t.mock.timers.tick(60);
  assert.equal(politeRegion, "Camera stopped");
  assert.equal(secondaryLog.length, 4);

  unsubMirror();
  announce("After unmount", "assertive");
  t.mock.timers.tick(60);
  assert.equal(assertiveRegion, "Warning: contains peanuts");
});

test("Sonar handles missing or throwing AudioContext, webkitAudioContext fallback, suspended resume rejection, and closed recreation", async () => {
  FakeSonarAudioContext.reset();
  delete windowShim.AudioContext;
  delete windowShim.webkitAudioContext;

  const headlessSonar = new Sonar();
  assert.equal(headlessSonar.active, false);
  assert.doesNotThrow(() => headlessSonar.unlock());
  assert.doesNotThrow(() => headlessSonar.set(0.75));
  assert.doesNotThrow(() => headlessSonar.duck(true));
  assert.doesNotThrow(() => headlessSonar.stop());
  assert.equal(headlessSonar.active, false);

  FakeSonarAudioContext.throwOnConstruct = true;
  windowShim.AudioContext = FakeSonarAudioContext;
  const throwingSonar = new Sonar();
  assert.doesNotThrow(() => throwingSonar.unlock());
  assert.doesNotThrow(() => throwingSonar.set(0.9));
  assert.equal(throwingSonar.active, false);

  FakeSonarAudioContext.reset();
  delete windowShim.AudioContext;
  windowShim.webkitAudioContext = FakeSonarAudioContext;
  FakeSonarAudioContext.rejectOnResume = true;

  const webkitSonar = new Sonar();
  webkitSonar.unlock();
  await Promise.resolve();
  assert.equal(FakeSonarAudioContext.instances.length, 1);
  assert.equal(FakeSonarAudioContext.instances[0]!.resumeCalls, 1);

  FakeSonarAudioContext.rejectOnResume = false;
  FakeSonarAudioContext.instances[0]!.state = "closed";
  webkitSonar.unlock();
  await Promise.resolve();
  assert.equal(FakeSonarAudioContext.instances.length, 2);
  assert.equal(FakeSonarAudioContext.instances[1]!.state, "running");

  webkitSonar.stop();
  delete windowShim.webkitAudioContext;
});

test("Sonar maps clamped readiness 0..1 to 220..660 Hz through 1200 Hz lowpass filter and ducks gain to 0.25x during speech", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  FakeSonarAudioContext.reset();
  windowShim.AudioContext = FakeSonarAudioContext;

  const sonar = new Sonar();
  t.after(() => {
    sonar.stop();
    delete windowShim.AudioContext;
  });

  sonar.unlock();
  const ctx = FakeSonarAudioContext.instances[0]!;
  ctx.currentTime = 2.5;

  sonar.set(-0.4);
  assert.equal(sonar.active, true);
  assert.equal(ctx.oscillators.length, 1);
  assert.equal(ctx.filters.length, 1);
  assert.equal(ctx.gains.length, 1);

  const osc = ctx.oscillators[0]!;
  const lp = ctx.filters[0]!;
  const gain = ctx.gains[0]!;

  assert.equal(osc.type, "sine");
  assert.equal(lp.type, "lowpass");
  assert.equal(lp.frequency.value, 1200);
  assert.deepEqual(osc.connectedTo, [lp]);
  assert.deepEqual(lp.connectedTo, [gain]);
  assert.deepEqual(gain.connectedTo, [ctx.destination]);
  assert.equal(osc.startedAt.length, 1);

  const freqEvents = osc.frequency.events;
  assert.equal(freqEvents[freqEvents.length - 1]?.value, 220);
  assert.equal(freqEvents[freqEvents.length - 1]?.timeConstant, 0.12);

  const expectedNormalGain = 0.35 * 0.09;
  assert.ok(Math.abs(gain.gain.value - expectedNormalGain) < 1e-9);

  sonar.set(0.5);
  assert.equal(freqEvents[freqEvents.length - 1]?.value, 440);

  sonar.set(1.8);
  assert.equal(freqEvents[freqEvents.length - 1]?.value, 660);

  ctx.currentTime = 3.0;
  sonar.duck(true);
  const duckedEvent = gain.gain.events[gain.gain.events.length - 1]!;
  assert.ok(Math.abs((duckedEvent.value ?? 0) - expectedNormalGain * 0.25) < 1e-9);
  assert.equal(duckedEvent.timeConstant, 0.08);
  assert.equal(duckedEvent.time, 3.0);

  sonar.duck(false);
  const unduckedEvent = gain.gain.events[gain.gain.events.length - 1]!;
  assert.ok(Math.abs((unduckedEvent.value ?? 0) - expectedNormalGain) < 1e-9);

  sonar.volume = 5;
  sonar.set(0.25);
  assert.equal(freqEvents[freqEvents.length - 1]?.value, 330);
  assert.ok(Math.abs(gain.gain.value - 0.09) < 1e-9);

  sonar.volume = -2;
  sonar.set(0.25);
  assert.equal(gain.gain.value, 0);
});

test("Sonar fires 700 ms 990 Hz readiness ticks only at >= 0.8 when unducked and auto-stops after 1500 ms idle", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  FakeSonarAudioContext.reset();
  windowShim.AudioContext = FakeSonarAudioContext;

  const sonar = new Sonar();
  t.after(() => {
    sonar.stop();
    delete windowShim.AudioContext;
  });

  sonar.unlock();
  const ctx = FakeSonarAudioContext.instances[0]!;
  ctx.currentTime = 10.0;

  sonar.set(0.79);
  assert.equal(ctx.oscillators.length, 1);
  t.mock.timers.tick(700);
  assert.equal(ctx.oscillators.length, 1);

  sonar.set(0.8);
  t.mock.timers.tick(700);
  assert.equal(ctx.oscillators.length, 2);
  const tickOsc1 = ctx.oscillators[1]!;
  const tickGain1 = ctx.gains[1]!;
  assert.equal(tickOsc1.type, "triangle");
  assert.equal(tickOsc1.frequency.value, 990);
  assert.deepEqual(tickOsc1.startedAt, [10.0]);
  assert.deepEqual(tickOsc1.stoppedAt, [10.09]);
  assert.equal(tickGain1.gain.events[0]?.op, "setValueAtTime");
  assert.ok(Math.abs((tickGain1.gain.events[1]?.value ?? 0) - 0.35 * 0.08) < 1e-9);

  sonar.duck(true);
  sonar.set(0.92);
  t.mock.timers.tick(700);
  assert.equal(ctx.oscillators.length, 2);

  sonar.duck(false);
  sonar.set(0.92);
  t.mock.timers.tick(700);
  assert.equal(ctx.oscillators.length, 3);

  sonar.set(0.6);
  t.mock.timers.tick(700);
  assert.equal(ctx.oscillators.length, 3);
  assert.equal(sonar.active, true);

  sonar.set(0.65);
  t.mock.timers.tick(1499);
  assert.equal(sonar.active, true);

  const mainOsc = ctx.oscillators[0]!;
  const mainGain = ctx.gains[0]!;
  mainOsc.throwOnStop = true;
  ctx.currentTime = 15.0;

  t.mock.timers.tick(1);
  assert.equal(sonar.active, false);
  const gainOps = mainGain.gain.events;
  assert.equal(gainOps[gainOps.length - 2]?.op, "cancelScheduledValues");
  assert.equal(gainOps[gainOps.length - 1]?.op, "setTargetAtTime");
  assert.equal(gainOps[gainOps.length - 1]?.value, 0);
  assert.equal(gainOps[gainOps.length - 1]?.timeConstant, 0.08);
});
