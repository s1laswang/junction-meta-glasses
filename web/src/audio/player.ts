import type { AudioStreamBridge } from "../session/useHoldUpController.ts";
import { MicCapture } from "./micCapture.ts";
import { base64ToPcm16, pcm16ToFloat32 } from "./pcm.ts";

type AudioContextCtor = new (contextOptions?: AudioContextOptions) => AudioContext;

type PlaybackGlobals = {
  AudioContext?: AudioContextCtor;
  webkitAudioContext?: AudioContextCtor;
  window?: {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
};

const PLAYBACK_SAMPLE_RATE = 24000;
const JITTER_HEADROOM_SEC = 0.02;

function getAudioContextCtor(): AudioContextCtor | null {
  const g = globalThis as unknown as PlaybackGlobals;
  const Ctor =
    g.AudioContext ??
    g.webkitAudioContext ??
    g.window?.AudioContext ??
    g.window?.webkitAudioContext;
  return typeof Ctor === "function" ? Ctor : null;
}

export class PcmPlayer {
  private ctx: AudioContext | null = null;
  private ctxCtor: AudioContextCtor | null = null;
  private nextStartTime = 0;
  private readonly activeSources = new Set<AudioBufferSourceNode>();
  private disposed = false;

  get playing(): boolean {
    return this.activeSources.size > 0;
  }

  private ensureContext(): AudioContext | null {
    if (this.disposed) {
      return null;
    }
    const Ctor = getAudioContextCtor();
    if (!Ctor) {
      return null;
    }
    if (!this.ctx || this.ctxCtor !== Ctor || this.ctx.state === "closed") {
      try {
        this.ctx = new Ctor();
        this.ctxCtor = Ctor;
        this.nextStartTime = 0;
      } catch {
        return null;
      }
    }
    return this.ctx;
  }

  enqueue(base64Pcm24k: string): void {
    if (this.disposed || !base64Pcm24k) {
      return;
    }
    const pcm16 = base64ToPcm16(base64Pcm24k);
    if (pcm16.length === 0) {
      return;
    }
    const floatSamples = pcm16ToFloat32(pcm16);
    const ctx = this.ensureContext();
    if (!ctx) {
      return;
    }

    if (ctx.state === "suspended" && typeof ctx.resume === "function") {
      try {
        void ctx.resume().catch(() => {});
      } catch {
        void 0;
      }
    }

    try {
      const buffer = ctx.createBuffer(1, floatSamples.length, PLAYBACK_SAMPLE_RATE);
      if (typeof buffer.getChannelData === "function") {
        buffer.getChannelData(0).set(floatSamples);
      } else if (typeof buffer.copyToChannel === "function") {
        buffer.copyToChannel(new Float32Array(floatSamples), 0);
      }

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);

      const startAt = Math.max(ctx.currentTime + JITTER_HEADROOM_SEC, this.nextStartTime);
      const duration =
        typeof buffer.duration === "number" && Number.isFinite(buffer.duration) && buffer.duration > 0
          ? buffer.duration
          : floatSamples.length / PLAYBACK_SAMPLE_RATE;
      this.nextStartTime = startAt + duration;

      this.activeSources.add(source);
      source.onended = () => {
        this.activeSources.delete(source);
        try {
          source.disconnect();
        } catch {
          void 0;
        }
        if (this.activeSources.size === 0) {
          this.nextStartTime = 0;
        }
      };

      source.start(startAt);
    } catch {
      return;
    }
  }

  flush(): void {
    const sources = Array.from(this.activeSources);
    this.activeSources.clear();
    this.nextStartTime = 0;

    for (const source of sources) {
      source.onended = null;
      try {
        source.stop(0);
      } catch {
        try {
          source.stop();
        } catch {
          void 0;
        }
      }
      try {
        source.disconnect();
      } catch {
        void 0;
      }
    }
  }

  async resume(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const ctx = this.ensureContext();
    if (!ctx) {
      return;
    }
    if (ctx.state !== "running" && typeof ctx.resume === "function") {
      try {
        await ctx.resume();
      } catch {
        return;
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.flush();
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx && ctx.state !== "closed" && typeof ctx.close === "function") {
      try {
        void ctx.close().catch(() => {});
      } catch {
        void 0;
      }
    }
  }
}

export function createLiveAudioBridge(opts?: {
  onMicLevel?: (rms: number) => void;
  deviceId?: string;
}): AudioStreamBridge & { dispose: () => void } {
  const mic = new MicCapture();
  const player = new PcmPlayer();
  let disposed = false;

  return {
    startMic: async (onChunk: (b64: string) => void): Promise<void> => {
      if (disposed) {
        return;
      }
      await mic.start({
        onChunk,
        onLevel: opts?.onMicLevel,
        deviceId: opts?.deviceId
      });
    },
    stopMic: (): void => {
      mic.stop();
    },
    enqueuePcm24k: (b64: string): void => {
      if (disposed) {
        return;
      }
      player.enqueue(b64);
    },
    flushPlayback: (): void => {
      player.flush();
    },
    resumePlayback: async (): Promise<void> => {
      if (disposed) {
        return;
      }
      await player.resume();
    },
    dispose: (): void => {
      disposed = true;
      mic.stop();
      player.dispose();
    }
  };
}
