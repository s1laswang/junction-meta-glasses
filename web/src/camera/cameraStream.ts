import type { PermissionStateSummary, PermissionStatusKind } from "../types.ts";
import { computeSharpness } from "./sharpness.ts";

export type CapturedFrame = {
  data: string;
  w: number;
  h: number;
  sharpness: number;
  ts: number;
};

export type StartCameraResult =
  | { ok: true }
  | { ok: false; status: PermissionStatusKind; message: string };

export type CaptureFrameOptions = {
  maxDim?: number;
  jpegQuality?: number;
};

export type OffscreenCanvas2DContext = {
  drawImage(
    image: HTMLVideoElement | HTMLImageElement,
    dx: number,
    dy: number,
    dw: number,
    dh: number
  ): void;
  getImageData(sx: number, sy: number, sw: number, sh: number): { data: Uint8ClampedArray };
};

export type OffscreenCanvasLike = {
  width: number;
  height: number;
  getContext(
    contextId: "2d",
    options?: CanvasRenderingContext2DSettings
  ): OffscreenCanvas2DContext | null;
  toDataURL(type?: string, quality?: number): string;
};

export function classifyMediaError(err: unknown): { status: PermissionStatusKind; message: string } {
  const name =
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    typeof (err as { name: unknown }).name === "string"
      ? (err as { name: string }).name
      : "";

  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return {
      status: "denied",
      message: "Camera access was denied. Enable camera permission in browser settings and try again."
    };
  }

  if (name === "SecurityError") {
    return {
      status: "denied",
      message: "Camera access requires a secure HTTPS connection or localhost."
    };
  }

  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return {
      status: "unavailable",
      message: "No camera was found on this device."
    };
  }

  if (name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError") {
    return {
      status: "unavailable",
      message: "Requested camera resolution or facing mode is not supported on this device."
    };
  }

  if (name === "NotReadableError" || name === "TrackStartError") {
    return {
      status: "unavailable",
      message: "Camera could not be started because it may be in use by another app."
    };
  }

  if (name === "AbortError") {
    return {
      status: "unavailable",
      message: "Camera startup was interrupted before video could begin."
    };
  }

  return {
    status: "unavailable",
    message: "Camera is unavailable right now."
  };
}

async function queryPermissionState(name: "camera" | "microphone"): Promise<PermissionStatusKind> {
  if (typeof navigator === "undefined") {
    return "unavailable";
  }

  const fallback: PermissionStatusKind =
    navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === "function"
      ? "prompt"
      : "unavailable";

  if (!navigator.permissions || typeof navigator.permissions.query !== "function") {
    return fallback;
  }

  try {
    const status = await navigator.permissions.query({ name: name as PermissionName });
    if (status.state === "granted" || status.state === "denied" || status.state === "prompt") {
      return status.state;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

export async function probePermissions(): Promise<PermissionStateSummary> {
  const [camera, microphone] = await Promise.all([
    queryPermissionState("camera"),
    queryPermissionState("microphone")
  ]);
  return { camera, microphone };
}

function defaultCreateCanvas(): OffscreenCanvasLike | null {
  if (typeof document === "undefined" || typeof document.createElement !== "function") {
    return null;
  }
  return document.createElement("canvas");
}

function getSourceDimensions(
  source: HTMLVideoElement | HTMLImageElement
): { w: number; h: number } | null {
  if ("videoWidth" in source) {
    if (typeof source.readyState === "number" && source.readyState < 2) {
      return null;
    }
    const w = source.videoWidth;
    const h = source.videoHeight;
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
      return null;
    }
    return { w, h };
  }

  if ("complete" in source && source.complete === false) {
    return null;
  }

  const w = source.naturalWidth || source.width;
  const h = source.naturalHeight || source.height;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return null;
  }
  return { w, h };
}

export class CameraController {
  private stream: MediaStream | null = null;
  private videoEl: HTMLVideoElement | null = null;
  private canvas: OffscreenCanvasLike | null = null;
  private ctx: OffscreenCanvas2DContext | null = null;
  private readonly createCanvas: () => OffscreenCanvasLike | null;

  constructor(createCanvas: () => OffscreenCanvasLike | null = defaultCreateCanvas) {
    this.createCanvas = createCanvas;
  }

  get active(): boolean {
    return this.stream !== null;
  }

  async startPhoneCamera(videoEl: HTMLVideoElement): Promise<StartCameraResult> {
    this.stop();

    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== "function"
    ) {
      return {
        ok: false,
        status: "unavailable",
        message: "Camera API is unavailable in this browser or requires HTTPS."
      };
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false
      });

      videoEl.playsInline = true;
      videoEl.muted = true;
      if (typeof videoEl.setAttribute === "function") {
        videoEl.setAttribute("playsinline", "true");
      }
      videoEl.srcObject = stream;
      this.stream = stream;
      this.videoEl = videoEl;

      if (typeof videoEl.play === "function") {
        try {
          await videoEl.play();
        } catch {
          void 0;
        }
      }

      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        ...classifyMediaError(err)
      };
    }
  }

  stop(): void {
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.stop();
      }
      this.stream = null;
    }

    if (this.videoEl) {
      const existing = this.videoEl.srcObject;
      if (
        existing &&
        typeof existing === "object" &&
        "getTracks" in existing &&
        typeof (existing as MediaStream).getTracks === "function"
      ) {
        for (const track of (existing as MediaStream).getTracks()) {
          track.stop();
        }
      }
      this.videoEl.srcObject = null;
      this.videoEl = null;
    }
  }

  captureFrame(
    source: HTMLVideoElement | HTMLImageElement,
    opts?: CaptureFrameOptions
  ): CapturedFrame | null {
    const dims = getSourceDimensions(source);
    if (!dims) {
      return null;
    }

    const rawMaxDim = opts?.maxDim ?? 768;
    const maxDim = Number.isFinite(rawMaxDim) && rawMaxDim > 0 ? Math.round(rawMaxDim) : 768;
    const rawQuality = opts?.jpegQuality ?? 0.78;
    const quality = Number.isFinite(rawQuality) ? Math.max(0.05, Math.min(1, rawQuality)) : 0.78;

    const scale = Math.min(1, maxDim / Math.max(dims.w, dims.h));
    const w = Math.max(1, Math.round(dims.w * scale));
    const h = Math.max(1, Math.round(dims.h * scale));

    if (!this.canvas) {
      this.canvas = this.createCanvas();
    }
    const canvas = this.canvas;
    if (!canvas) {
      return null;
    }

    if (canvas.width !== w) {
      canvas.width = w;
    }
    if (canvas.height !== h) {
      canvas.height = h;
    }

    if (!this.ctx) {
      this.ctx = canvas.getContext("2d", { willReadFrequently: true });
    }
    const ctx = this.ctx;
    if (!ctx) {
      return null;
    }

    try {
      ctx.drawImage(source, 0, 0, w, h);
      const imageData = ctx.getImageData(0, 0, w, h);
      const sharpness = computeSharpness(imageData.data, w, h);
      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      const jpegPrefix = "data:image/jpeg;base64,";
      let data = "";
      if (dataUrl.startsWith(jpegPrefix)) {
        data = dataUrl.slice(jpegPrefix.length);
      } else {
        const comma = dataUrl.indexOf(",");
        if (comma !== -1) {
          data = dataUrl.slice(comma + 1);
        }
      }
      if (!data) {
        return null;
      }
      return {
        data,
        w,
        h,
        sharpness,
        ts: Date.now()
      };
    } catch {
      return null;
    }
  }
}
