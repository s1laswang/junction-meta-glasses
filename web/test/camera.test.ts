import { computeSharpness } from "../src/camera/sharpness.ts";
import { computeAdaptiveParams } from "../src/camera/adaptive.ts";
import {
  CameraController,
  classifyMediaError,
  probePermissions,
  type OffscreenCanvasLike
} from "../src/camera/cameraStream.ts";

type TestFn = (name: string, fn: () => void | Promise<void>) => Promise<void>;
type StrictAssert = {
  ok(value: unknown, message?: string): void;
  equal<T>(actual: T, expected: T, message?: string): void;
  deepEqual<T>(actual: T, expected: T, message?: string): void;
};

const nodeTestSpecifier = "node:test";
const nodeAssertSpecifier = "node:assert/strict";
const { test } = (await import(nodeTestSpecifier)) as { test: TestFn };
const assert = (await import(nodeAssertSpecifier)) as StrictAssert;

function makeGrayRgba(
  width: number,
  height: number,
  pixelFn: (x: number, y: number) => number
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const v = Math.max(0, Math.min(255, Math.round(pixelFn(x, y))));
      const idx = (y * width + x) * 4;
      out[idx] = v;
      out[idx + 1] = v;
      out[idx + 2] = v;
      out[idx + 3] = 255;
    }
  }
  return out;
}

function boxBlurRgba(
  src: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
  passes: number
): Uint8ClampedArray {
  let current = new Uint8ClampedArray(src);
  for (let p = 0; p < passes; p += 1) {
    const horiz = new Uint8ClampedArray(current.length);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let sum = 0;
        let cnt = 0;
        for (let dx = -radius; dx <= radius; dx += 1) {
          const nx = Math.max(0, Math.min(width - 1, x + dx));
          sum += current[(y * width + nx) * 4];
          cnt += 1;
        }
        const v = Math.round(sum / cnt);
        const idx = (y * width + x) * 4;
        horiz[idx] = v;
        horiz[idx + 1] = v;
        horiz[idx + 2] = v;
        horiz[idx + 3] = 255;
      }
    }
    const vert = new Uint8ClampedArray(current.length);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let sum = 0;
        let cnt = 0;
        for (let dy = -radius; dy <= radius; dy += 1) {
          const ny = Math.max(0, Math.min(height - 1, y + dy));
          sum += horiz[(ny * width + x) * 4];
          cnt += 1;
        }
        const v = Math.round(sum / cnt);
        const idx = (y * width + x) * 4;
        vert[idx] = v;
        vert[idx + 1] = v;
        vert[idx + 2] = v;
        vert[idx + 3] = 255;
      }
    }
    current = vert;
  }
  return current;
}

function makeTextLinesRgba(width: number, height: number): Uint8ClampedArray {
  return makeGrayRgba(width, height, (x, y) => {
    const inMargin = x < 16 || x >= width - 16 || y < 16 || y >= height - 16;
    if (inMargin) {
      return 240;
    }
    const lineRow = y % 12;
    const isStrokeRow = lineRow === 2 || lineRow === 3 || (lineRow >= 1 && lineRow <= 5 && x % 9 < 2);
    const hasWordGap = x % 47 >= 40;
    if (isStrokeRow && !hasWordGap) {
      return 18;
    }
    return 240;
  });
}

test("computeSharpness monotonic ordering and thresholds across small and strided frames", () => {
  assert.equal(computeSharpness(new Uint8ClampedArray(0), 0, 0), 0);
  assert.equal(computeSharpness(new Uint8ClampedArray(16), 2, 2), 0);

  for (const dim of [192, 320]) {
    const flatGray = makeGrayRgba(dim, dim, () => 128);
    const smoothGradient = makeGrayRgba(dim, dim, (x, y) => ((x + y) / (2 * dim - 2)) * 255);
    const sharpText = makeTextLinesRgba(dim, dim);
    const heavyBlur = boxBlurRgba(sharpText, dim, dim, 3, 2);
    const lightBlur = boxBlurRgba(sharpText, dim, dim, 1, 1);
    const checkerboard = makeGrayRgba(dim, dim, (x, y) => ((x + y) % 2 === 0 ? 255 : 0));

    const sFlat = computeSharpness(flatGray, dim, dim);
    const sGrad = computeSharpness(smoothGradient, dim, dim);
    const sHeavyBlur = computeSharpness(heavyBlur, dim, dim);
    const sLightBlur = computeSharpness(lightBlur, dim, dim);
    const sText = computeSharpness(sharpText, dim, dim);
    const sChecker = computeSharpness(checkerboard, dim, dim);

    assert.equal(sFlat, 0);
    assert.ok(sGrad > sFlat, `expected smoothGradient > flatGray, got ${sGrad}`);
    assert.ok(sGrad < 0.15, `expected smoothGradient < 0.15, got ${sGrad}`);
    assert.ok(sHeavyBlur < 0.15, `expected heavyBlur < 0.15, got ${sHeavyBlur}`);
    assert.ok(sText > 0.65, `expected sharpText > 0.65, got ${sText}`);
    assert.ok(sChecker > 0.65, `expected checkerboard > 0.65, got ${sChecker}`);
    assert.ok(sChecker <= 1);

    assert.ok(sFlat < sGrad);
    assert.ok(sGrad < sHeavyBlur, `expected sGrad (${sGrad}) < sHeavyBlur (${sHeavyBlur})`);
    assert.ok(sHeavyBlur < sLightBlur, `expected sHeavyBlur (${sHeavyBlur}) < sLightBlur (${sLightBlur})`);
    assert.ok(sLightBlur < sText, `expected sLightBlur (${sLightBlur}) < sText (${sText})`);
    assert.ok(sText < sChecker, `expected sText (${sText}) < sChecker (${sChecker})`);
  }
});

test("computeAdaptiveParams across RTT tiers and offline state", () => {
  assert.deepEqual(computeAdaptiveParams(null, true), {
    targetFps: 1.0,
    intervalMs: 1000,
    jpegQuality: 0.78,
    maxDim: 768
  });

  assert.deepEqual(computeAdaptiveParams(100), {
    targetFps: 1.0,
    intervalMs: 1000,
    jpegQuality: 0.78,
    maxDim: 768
  });

  assert.deepEqual(computeAdaptiveParams(250), {
    targetFps: 0.75,
    intervalMs: 1333,
    jpegQuality: 0.64,
    maxDim: 640
  });

  assert.deepEqual(computeAdaptiveParams(400), {
    targetFps: 0.75,
    intervalMs: 1333,
    jpegQuality: 0.64,
    maxDim: 640
  });

  assert.deepEqual(computeAdaptiveParams(650), {
    targetFps: 0.75,
    intervalMs: 1333,
    jpegQuality: 0.64,
    maxDim: 640
  });

  assert.deepEqual(computeAdaptiveParams(900), {
    targetFps: 0.5,
    intervalMs: 2000,
    jpegQuality: 0.5,
    maxDim: 512
  });

  assert.deepEqual(computeAdaptiveParams(100, false), {
    targetFps: 0,
    intervalMs: 2000,
    jpegQuality: 0.6,
    maxDim: 512
  });

  assert.deepEqual(computeAdaptiveParams(null, false), {
    targetFps: 0,
    intervalMs: 2000,
    jpegQuality: 0.6,
    maxDim: 512
  });
});

test("classifyMediaError maps DOM media errors to PermissionStatusKind", () => {
  const denied1 = classifyMediaError({ name: "NotAllowedError", message: "Permission dismissed" });
  assert.equal(denied1.status, "denied");
  assert.ok(denied1.message.length > 0);

  const denied2 = classifyMediaError({ name: "PermissionDeniedError" });
  assert.equal(denied2.status, "denied");
  assert.ok(denied2.message.length > 0);

  const notFound = classifyMediaError({ name: "NotFoundError" });
  assert.equal(notFound.status, "unavailable");
  assert.ok(notFound.message.length > 0);

  const overconstrained = classifyMediaError({ name: "OverconstrainedError" });
  assert.equal(overconstrained.status, "unavailable");
  assert.ok(overconstrained.message.length > 0);

  const notReadable = classifyMediaError({ name: "NotReadableError" });
  assert.equal(notReadable.status, "unavailable");
  assert.ok(notReadable.message.length > 0);

  const unknownErr = classifyMediaError(new Error("boom"));
  assert.equal(unknownErr.status, "unavailable");
  assert.ok(unknownErr.message.length > 0);
});

test("probePermissions queries navigator.permissions safely", async () => {
  const prevDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        permissions: {
          query: async ({ name }: { name: string }) => ({
            state: name === "camera" ? "granted" : "denied"
          })
        },
        mediaDevices: {
          getUserMedia: async () => ({})
        }
      }
    });
    const summary = await probePermissions();
    assert.deepEqual(summary, { camera: "granted", microphone: "denied" });

    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        permissions: {
          query: async () => {
            throw new TypeError("unsupported permission name");
          }
        },
        mediaDevices: {
          getUserMedia: async () => ({})
        }
      }
    });
    const fallbackPrompt = await probePermissions();
    assert.deepEqual(fallbackPrompt, { camera: "prompt", microphone: "prompt" });
  } finally {
    if (prevDescriptor) {
      Object.defineProperty(globalThis, "navigator", prevDescriptor);
    }
  }
});

test("CameraController startPhoneCamera, stop, and captureFrame", async () => {
  const prevDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let stoppedCount = 0;
  let capturedConstraints: unknown = null;

  try {
    const fakeStream = {
      getTracks: () => [
        {
          stop: () => {
            stoppedCount += 1;
          }
        }
      ]
    } as unknown as MediaStream;

    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        mediaDevices: {
          getUserMedia: async (constraints: unknown) => {
            capturedConstraints = constraints;
            return fakeStream;
          }
        }
      }
    });

    let lastQuality: number | undefined;
    let lastMime: string | undefined;

    const fakeCanvas: OffscreenCanvasLike = {
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage: () => {},
        getImageData: (_sx, _sy, sw, sh) => ({
          data: makeTextLinesRgba(sw, sh)
        })
      }),
      toDataURL: (type, quality) => {
        lastMime = type;
        lastQuality = quality;
        return "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD=";
      }
    };

    const controller = new CameraController(() => fakeCanvas);
    const fakeVideo = {
      playsInline: false,
      muted: false,
      srcObject: null,
      videoWidth: 1280,
      videoHeight: 720,
      readyState: 4,
      play: async () => {}
    } as unknown as HTMLVideoElement;

    const started = await controller.startPhoneCamera(fakeVideo);
    assert.deepEqual(started, { ok: true });
    assert.equal(fakeVideo.playsInline, true);
    assert.equal(fakeVideo.srcObject, fakeStream);
    assert.deepEqual(capturedConstraints, {
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    });

    const frame = controller.captureFrame(fakeVideo, { maxDim: 640, jpegQuality: 0.64 });
    assert.ok(frame !== null);
    if (!frame) {
      throw new Error("Expected captured frame");
    }
    assert.equal(frame.w, 640);
    assert.equal(frame.h, 360);
    assert.equal(frame.data, "/9j/4AAQSkZJRgABAQAAAQABAAD=");
    assert.ok(!frame.data.startsWith("data:"));
    assert.ok(frame.sharpness > 0.65);
    assert.equal(lastMime, "image/jpeg");
    assert.equal(lastQuality, 0.64);
    assert.ok(frame.ts > 0);

    const propImage = {
      complete: true,
      naturalWidth: 1024,
      naturalHeight: 768,
      width: 1024,
      height: 768
    } as unknown as HTMLImageElement;
    const propFrame = controller.captureFrame(propImage);
    assert.ok(propFrame !== null);
    if (!propFrame) {
      throw new Error("Expected prop frame");
    }
    assert.equal(propFrame.w, 768);
    assert.equal(propFrame.h, 576);
    assert.equal(lastQuality, 0.78);

    const loadingImage = {
      complete: false,
      naturalWidth: 1024,
      naturalHeight: 768
    } as unknown as HTMLImageElement;
    assert.equal(controller.captureFrame(loadingImage), null);

    const unreadyVideo = {
      videoWidth: 1280,
      videoHeight: 720,
      readyState: 1
    } as unknown as HTMLVideoElement;
    assert.equal(controller.captureFrame(unreadyVideo), null);

    controller.stop();
    assert.ok(stoppedCount >= 1);
    assert.equal(fakeVideo.srcObject, null);

    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        mediaDevices: {
          getUserMedia: async () => {
            const err = new Error("User denied");
            err.name = "NotAllowedError";
            throw err;
          }
        }
      }
    });
    const deniedResult = await controller.startPhoneCamera(fakeVideo);
    assert.equal(deniedResult.ok, false);
    if (!deniedResult.ok) {
      assert.equal(deniedResult.status, "denied");
      assert.ok(deniedResult.message.length > 0);
    }
  } finally {
    if (prevDescriptor) {
      Object.defineProperty(globalThis, "navigator", prevDescriptor);
    }
  }
});

test("computeSharpness 768x768 strided benchmark stays well within frame budget", () => {
  const big = makeTextLinesRgba(768, 768);
  for (let w = 0; w < 3; w += 1) {
    computeSharpness(big, 768, 768);
  }
  const runs = 10;
  const t0 = performance.now();
  let last = 0;
  for (let i = 0; i < runs; i += 1) {
    last = computeSharpness(big, 768, 768);
  }
  const avgMs = (performance.now() - t0) / runs;
  assert.ok(last > 0.65);
  assert.ok(avgMs < 25, `expected avgMs < 25ms, got ${avgMs.toFixed(2)}ms`);
});
