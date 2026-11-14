import { downsampleBuffer, float32ToPcm16, pcm16ToBase64, rmsLevel } from "./pcm.ts";

export type MicCaptureOptions = {
  onChunk: (base64Pcm16: string) => void;
  onLevel?: (rms: number) => void;
  chunkMs?: number;
  deviceId?: string;
};

type AudioContextCtor = new (contextOptions?: AudioContextOptions) => AudioContext;
type AudioWorkletNodeCtor = new (
  context: BaseAudioContext,
  name: string,
  options?: AudioWorkletNodeOptions
) => AudioWorkletNode;

type CaptureGlobals = {
  AudioContext?: AudioContextCtor;
  webkitAudioContext?: AudioContextCtor;
  AudioWorkletNode?: AudioWorkletNodeCtor;
  navigator?: Navigator;
  window?: {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
    AudioWorkletNode?: AudioWorkletNodeCtor;
    navigator?: Navigator;
  };
};

const TARGET_SAMPLE_RATE = 16000;
const DEFAULT_CHUNK_MS = 100;
const WORKLET_PROCESSOR_NAME = "holdup-mic-capture-processor";

const WORKLET_MODULE_SOURCE = [
  "class HoldUpMicCaptureProcessor extends AudioWorkletProcessor {",
  "  process(inputs) {",
  "    const input = inputs[0];",
  "    if (input && input.length > 0 && input[0] && input[0].length > 0) {",
  "      const frames = input[0].length;",
  "      const mono = new Float32Array(frames);",
  "      if (input.length === 1) {",
  "        mono.set(input[0]);",
  "      } else {",
  "        const channels = input.length;",
  "        for (let c = 0; c < channels; c += 1) {",
  "          const ch = input[c];",
  "          if (ch) {",
  "            for (let i = 0; i < frames; i += 1) {",
  "              mono[i] += ch[i] / channels;",
  "            }",
  "          }",
  "        }",
  "      }",
  "      this.port.postMessage(mono, [mono.buffer]);",
  "    }",
  "    return true;",
  "  }",
  "}",
  `registerProcessor("${WORKLET_PROCESSOR_NAME}", HoldUpMicCaptureProcessor);`
].join("\n");

function getMediaDevices(): MediaDevices | null {
  const g = globalThis as unknown as CaptureGlobals;
  const nav = g.navigator ?? g.window?.navigator;
  if (!nav || !nav.mediaDevices || typeof nav.mediaDevices.getUserMedia !== "function") {
    return null;
  }
  return nav.mediaDevices;
}

function getAudioContextCtor(): AudioContextCtor | null {
  const g = globalThis as unknown as CaptureGlobals;
  const Ctor =
    g.AudioContext ??
    g.webkitAudioContext ??
    g.window?.AudioContext ??
    g.window?.webkitAudioContext;
  return typeof Ctor === "function" ? Ctor : null;
}

function getAudioWorkletNodeCtor(): AudioWorkletNodeCtor | null {
  const g = globalThis as unknown as CaptureGlobals;
  const Ctor = g.AudioWorkletNode ?? g.window?.AudioWorkletNode;
  return typeof Ctor === "function" ? Ctor : null;
}

function makeUnavailableError(message: string): Error {
  const err = new Error(message);
  err.name = "NotFoundError";
  return err;
}

function stopStreamTracks(stream: MediaStream | null): void {
  if (!stream || typeof stream.getTracks !== "function") {
    return;
  }
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      void 0;
    }
  }
}

function pickScriptBufferSize(inRate: number): number {
  if (inRate <= 24000) {
    return 1024;
  }
  return 2048;
}

export class MicCapture {
  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private scriptNode: ScriptProcessorNode | null = null;
  private silentGain: GainNode | null = null;
  private isActive = false;
  private runId = 0;

  get active(): boolean {
    return this.isActive;
  }

  async start(opts: MicCaptureOptions): Promise<void> {
    this.stop();
    const currentRun = this.runId;

    const mediaDevices = getMediaDevices();
    if (!mediaDevices) {
      throw makeUnavailableError("Microphone capture API is unavailable in this environment.");
    }

    const audioConstraints: MediaTrackConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(opts.deviceId ? { deviceId: { exact: opts.deviceId } } : {})
    };

    const stream = await mediaDevices.getUserMedia({ audio: audioConstraints });
    if (currentRun !== this.runId) {
      stopStreamTracks(stream);
      return;
    }

    const AudioCtxCtor = getAudioContextCtor();
    if (!AudioCtxCtor) {
      stopStreamTracks(stream);
      throw makeUnavailableError("Web Audio API is unavailable in this environment.");
    }

    let ctx: AudioContext;
    try {
      ctx = new AudioCtxCtor();
    } catch (err) {
      stopStreamTracks(stream);
      throw err;
    }

    if (ctx.state === "suspended" && typeof ctx.resume === "function") {
      try {
        await ctx.resume();
      } catch {
        void 0;
      }
    }

    if (currentRun !== this.runId) {
      stopStreamTracks(stream);
      if (ctx.state !== "closed" && typeof ctx.close === "function") {
        void ctx.close().catch(() => {});
      }
      return;
    }

    const inRate =
      typeof ctx.sampleRate === "number" && Number.isFinite(ctx.sampleRate) && ctx.sampleRate > 0
        ? ctx.sampleRate
        : TARGET_SAMPLE_RATE;
    const chunkMs =
      opts.chunkMs !== undefined && Number.isFinite(opts.chunkMs) && opts.chunkMs > 0
        ? opts.chunkMs
        : DEFAULT_CHUNK_MS;
    const targetSamples16k = Math.max(1, Math.round((TARGET_SAMPLE_RATE * chunkMs) / 1000));
    const neededInputSamples =
      inRate >= TARGET_SAMPLE_RATE
        ? Math.ceil((targetSamples16k * inRate) / TARGET_SAMPLE_RATE)
        : Math.max(1, Math.round((targetSamples16k * inRate) / TARGET_SAMPLE_RATE));

    let rawBuffer = new Float32Array(Math.max(neededInputSamples * 4, 4096));
    let rawLength = 0;
    let pending16k = new Float32Array(targetSamples16k * 4);
    let pending16kLength = 0;
    let reportedInitialLevel = false;

    const appendToPending16k = (samples16k: Float32Array): void => {
      if (samples16k.length === 0) {
        return;
      }
      if (pending16kLength + samples16k.length > pending16k.length) {
        const grown = new Float32Array(
          Math.max(pending16k.length * 2, pending16kLength + samples16k.length)
        );
        grown.set(pending16k.subarray(0, pending16kLength), 0);
        pending16k = grown;
      }
      pending16k.set(samples16k, pending16kLength);
      pending16kLength += samples16k.length;
    };

    const handleRawFrame = (incoming: Float32Array): void => {
      if (!this.isActive || currentRun !== this.runId || incoming.length === 0) {
        return;
      }

      if (!reportedInitialLevel && opts.onLevel) {
        reportedInitialLevel = true;
        opts.onLevel(rmsLevel(incoming));
      }

      if (rawLength + incoming.length > rawBuffer.length) {
        const grown = new Float32Array(
          Math.max(rawBuffer.length * 2, rawLength + incoming.length)
        );
        grown.set(rawBuffer.subarray(0, rawLength), 0);
        rawBuffer = grown;
      }
      rawBuffer.set(incoming, rawLength);
      rawLength += incoming.length;

      while (rawLength >= neededInputSamples) {
        const block = rawBuffer.slice(0, neededInputSamples);
        const remaining = rawLength - neededInputSamples;
        if (remaining > 0) {
          rawBuffer.copyWithin(0, neededInputSamples, rawLength);
        }
        rawLength = remaining;

        const resampled = downsampleBuffer(block, inRate, TARGET_SAMPLE_RATE);
        appendToPending16k(resampled);

        while (pending16kLength >= targetSamples16k) {
          const chunk16k = pending16k.slice(0, targetSamples16k);
          const rem16k = pending16kLength - targetSamples16k;
          if (rem16k > 0) {
            pending16k.copyWithin(0, targetSamples16k, pending16kLength);
          }
          pending16kLength = rem16k;

          if (opts.onLevel) {
            reportedInitialLevel = true;
            opts.onLevel(rmsLevel(chunk16k));
          }

          const pcm16 = float32ToPcm16(chunk16k);
          const encoded = pcm16ToBase64(pcm16);
          if (encoded) {
            opts.onChunk(encoded);
          }
        }
      }
    };

    let sourceNode: MediaStreamAudioSourceNode;
    try {
      sourceNode = ctx.createMediaStreamSource(stream);
    } catch (err) {
      stopStreamTracks(stream);
      if (ctx.state !== "closed" && typeof ctx.close === "function") {
        void ctx.close().catch(() => {});
      }
      throw err;
    }

    let silentGain: GainNode | null = null;
    if (typeof ctx.createGain === "function") {
      try {
        silentGain = ctx.createGain();
        silentGain.gain.value = 0;
        silentGain.connect(ctx.destination);
      } catch {
        silentGain = null;
      }
    }
    const sinkNode: AudioNode = silentGain ?? ctx.destination;

    let attachedViaWorklet = false;
    const WorkletNodeCtor = getAudioWorkletNodeCtor();

    if (
      ctx.audioWorklet &&
      typeof ctx.audioWorklet.addModule === "function" &&
      WorkletNodeCtor &&
      typeof Blob !== "undefined" &&
      typeof URL !== "undefined" &&
      typeof URL.createObjectURL === "function"
    ) {
      const blob = new Blob([WORKLET_MODULE_SOURCE], { type: "application/javascript" });
      const blobUrl = URL.createObjectURL(blob);
      try {
        await ctx.audioWorklet.addModule(blobUrl);
        if (currentRun !== this.runId) {
          stopStreamTracks(stream);
          try {
            sourceNode.disconnect();
            silentGain?.disconnect();
          } catch {
            void 0;
          }
          if (ctx.state !== "closed" && typeof ctx.close === "function") {
            void ctx.close().catch(() => {});
          }
          return;
        }
        const workletNode = new WorkletNodeCtor(ctx, WORKLET_PROCESSOR_NAME);
        workletNode.port.onmessage = (event: MessageEvent<unknown>) => {
          const payload = event.data;
          if (payload instanceof Float32Array) {
            handleRawFrame(payload);
          } else if (payload instanceof ArrayBuffer) {
            handleRawFrame(new Float32Array(payload));
          }
        };
        sourceNode.connect(workletNode);
        workletNode.connect(sinkNode);
        this.workletNode = workletNode;
        attachedViaWorklet = true;
      } catch {
        attachedViaWorklet = false;
      } finally {
        if (typeof URL.revokeObjectURL === "function") {
          try {
            URL.revokeObjectURL(blobUrl);
          } catch {
            void 0;
          }
        }
      }
    }

    if (!attachedViaWorklet) {
      if (typeof ctx.createScriptProcessor !== "function") {
        try {
          sourceNode.disconnect();
          silentGain?.disconnect();
        } catch {
          void 0;
        }
        stopStreamTracks(stream);
        if (ctx.state !== "closed" && typeof ctx.close === "function") {
          void ctx.close().catch(() => {});
        }
        throw makeUnavailableError("Neither AudioWorklet nor ScriptProcessorNode is available.");
      }

      const scriptNode = ctx.createScriptProcessor(pickScriptBufferSize(inRate), 1, 1);
      scriptNode.onaudioprocess = (event: AudioProcessingEvent) => {
        if (event.inputBuffer && event.inputBuffer.numberOfChannels > 0) {
          const channel = event.inputBuffer.getChannelData(0);
          const copy = new Float32Array(channel.length);
          copy.set(channel);
          handleRawFrame(copy);
        }
      };
      sourceNode.connect(scriptNode);
      scriptNode.connect(sinkNode);
      this.scriptNode = scriptNode;
    }

    this.stream = stream;
    this.audioCtx = ctx;
    this.sourceNode = sourceNode;
    this.silentGain = silentGain;
    this.isActive = true;
  }

  stop(): void {
    this.runId += 1;
    this.isActive = false;

    if (this.workletNode) {
      try {
        this.workletNode.port.onmessage = null;
      } catch {
        void 0;
      }
      try {
        this.workletNode.disconnect();
      } catch {
        void 0;
      }
      this.workletNode = null;
    }

    if (this.scriptNode) {
      this.scriptNode.onaudioprocess = null;
      try {
        this.scriptNode.disconnect();
      } catch {
        void 0;
      }
      this.scriptNode = null;
    }

    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch {
        void 0;
      }
      this.sourceNode = null;
    }

    if (this.silentGain) {
      try {
        this.silentGain.disconnect();
      } catch {
        void 0;
      }
      this.silentGain = null;
    }

    if (this.stream) {
      stopStreamTracks(this.stream);
      this.stream = null;
    }

    if (this.audioCtx) {
      const ctx = this.audioCtx;
      this.audioCtx = null;
      if (ctx.state !== "closed" && typeof ctx.close === "function") {
        try {
          void ctx.close().catch(() => {});
        } catch {
          void 0;
        }
      }
    }
  }
}
