import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

type AudioParamOp = {
  method:
    | "setTargetAtTime"
    | "setValueAtTime"
    | "linearRampToValueAtTime"
    | "exponentialRampToValueAtTime"
    | "cancelScheduledValues";
  value?: number;
  time: number;
  timeConstant?: number;
};

class TestAudioParam {
  value: number;
  ops: AudioParamOp[] = [];

  constructor(initial = 0) {
    this.value = initial;
  }

  setTargetAtTime(target: number, startTime: number, timeConstant: number): void {
    this.value = target;
    this.ops.push({ method: "setTargetAtTime", value: target, time: startTime, timeConstant });
  }

  setValueAtTime(value: number, startTime: number): void {
    this.value = value;
    this.ops.push({ method: "setValueAtTime", value, time: startTime });
  }

  linearRampToValueAtTime(value: number, endTime: number): void {
    this.value = value;
    this.ops.push({ method: "linearRampToValueAtTime", value, time: endTime });
  }

  exponentialRampToValueAtTime(value: number, endTime: number): void {
    this.value = value;
    this.ops.push({ method: "exponentialRampToValueAtTime", value, time: endTime });
  }

  cancelScheduledValues(startTime: number): void {
    this.ops.push({ method: "cancelScheduledValues", time: startTime });
  }
}

class TestAudioBuffer {
  numberOfChannels: number;
  length: number;
  sampleRate: number;
  duration: number;
  private channels: Float32Array[];

  constructor(numberOfChannels: number, length: number, sampleRate: number) {
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }

  getChannelData(channel: number): Float32Array {
    const data = this.channels[channel];
    if (!data) throw new RangeError("Channel out of range");
    return data;
  }
}

class TestGainNode {
  gain = new TestAudioParam(1);
  connectedTo: unknown[] = [];
  disconnectCount = 0;

  connect<T>(dest: T): T {
    this.connectedTo.push(dest);
    return dest;
  }

  disconnect(): void {
    this.disconnectCount++;
  }
}

class TestOscillatorNode {
  type: OscillatorType = "sine";
  frequency = new TestAudioParam(440);
  connectedTo: unknown[] = [];
  startedAt: number[] = [];
  stoppedAt: number[] = [];

  connect<T>(dest: T): T {
    this.connectedTo.push(dest);
    return dest;
  }

  start(when = 0): void {
    this.startedAt.push(when);
  }

  stop(when = 0): void {
    this.stoppedAt.push(when);
  }
}

class TestBiquadFilterNode {
  type: BiquadFilterType = "lowpass";
  frequency = new TestAudioParam(1200);
  connectedTo: unknown[] = [];

  connect<T>(dest: T): T {
    this.connectedTo.push(dest);
    return dest;
  }
}

class TestBufferSourceNode {
  buffer: TestAudioBuffer | null = null;
  onended: (() => void) | null = null;
  connectedTo: unknown[] = [];
  startedAt: number[] = [];
  stopCount = 0;
  disconnectCount = 0;

  connect<T>(dest: T): T {
    this.connectedTo.push(dest);
    return dest;
  }

  start(when = 0): void {
    this.startedAt.push(when);
  }

  stop(): void {
    this.stopCount++;
  }

  disconnect(): void {
    this.disconnectCount++;
  }
}

class TestMediaStreamSourceNode {
  stream: MediaStream;
  connectedTo: unknown[] = [];
  disconnectCount = 0;

  constructor(stream: MediaStream) {
    this.stream = stream;
  }

  connect<T>(dest: T): T {
    this.connectedTo.push(dest);
    return dest;
  }

  disconnect(): void {
    this.disconnectCount++;
  }
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

const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));
const WORKLET_SOURCE = readFileSync(join(PUBLIC_DIR, "pcm-capture-worklet.js"), "utf8");

function createWorkletHarness(contextSampleRate: number): {
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

  assert.ok(Registered, "Expected pcm-capture-worklet.js to call registerProcessor");
  return { registeredName, Ctor: Registered as WorkletProcessorCtor, posted };
}

class TestAudioWorkletNode {
  static instances: TestAudioWorkletNode[] = [];
  static workletSampleRate = 8000;

  context: TestAudioContext;
  name: string;
  options: AudioWorkletNodeOptions | undefined;
  connectedTo: unknown[] = [];
  disconnectCount = 0;
  private proc: WorkletProcessorInstance;
  port = {
    onmessage: null as ((ev: MessageEvent<WorkletMessage>) => void) | null,
    closeCount: 0,
    close() {
      this.closeCount++;
    },
  };

  constructor(context: TestAudioContext, name: string, options?: AudioWorkletNodeOptions) {
    this.context = context;
    this.name = name;
    this.options = options;
    const harness = createWorkletHarness(TestAudioWorkletNode.workletSampleRate);
    this.proc = new harness.Ctor({
      processorOptions: options?.processorOptions as { outRate?: number; chunkMs?: number } | undefined,
    });
    this.proc.port.postMessage = (msg: WorkletMessage) => {
      this.port.onmessage?.({ data: msg } as MessageEvent<WorkletMessage>);
    };
    TestAudioWorkletNode.instances.push(this);
  }

  static reset(sampleRate = 8000): void {
    TestAudioWorkletNode.instances = [];
    TestAudioWorkletNode.workletSampleRate = sampleRate;
  }

  connect<T>(dest: T): T {
    this.connectedTo.push(dest);
    return dest;
  }

  disconnect(): void {
    this.disconnectCount++;
  }

  pushQuantum(samples: Float32Array): boolean {
    return this.proc.process([[samples]]);
  }

  emitDirectChunk(pcm: ArrayBuffer, rms: number): void {
    this.port.onmessage?.({ data: { pcm, rms } } as MessageEvent<WorkletMessage>);
  }
}

class TestAudioContext {
  static instances: TestAudioContext[] = [];
  static initialState: AudioContextState = "suspended";

  state: AudioContextState = TestAudioContext.initialState;
  currentTime = 5.0;
  destination = { kind: "audio-destination" };
  gains: TestGainNode[] = [];
  oscillators: TestOscillatorNode[] = [];
  filters: TestBiquadFilterNode[] = [];
  sources: TestBufferSourceNode[] = [];
  mediaSources: TestMediaStreamSourceNode[] = [];
  buffers: TestAudioBuffer[] = [];
  addModuleCalls: string[] = [];
  resumeCount = 0;
  closeCount = 0;

  audioWorklet = {
    addModule: async (url: string): Promise<void> => {
      this.addModuleCalls.push(url);
    },
  };

  constructor() {
    TestAudioContext.instances.push(this);
  }

  static reset(): void {
    TestAudioContext.instances = [];
    TestAudioContext.initialState = "suspended";
    TestAudioWorkletNode.reset(8000);
  }

  createGain(): GainNode {
    const g = new TestGainNode();
    this.gains.push(g);
    return g as unknown as GainNode;
  }

  createOscillator(): OscillatorNode {
    const o = new TestOscillatorNode();
    this.oscillators.push(o);
    return o as unknown as OscillatorNode;
  }

  createBiquadFilter(): BiquadFilterNode {
    const f = new TestBiquadFilterNode();
    this.filters.push(f);
    return f as unknown as BiquadFilterNode;
  }

  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer {
    const b = new TestAudioBuffer(channels, length, sampleRate);
    this.buffers.push(b);
    return b as unknown as AudioBuffer;
  }

  createBufferSource(): AudioBufferSourceNode {
    const s = new TestBufferSourceNode();
    this.sources.push(s);
    return s as unknown as AudioBufferSourceNode;
  }

  createMediaStreamSource(stream: MediaStream): MediaStreamAudioSourceNode {
    const m = new TestMediaStreamSourceNode(stream);
    this.mediaSources.push(m);
    return m as unknown as MediaStreamAudioSourceNode;
  }

  async resume(): Promise<void> {
    this.resumeCount++;
    if (this.state !== "closed") this.state = "running";
  }

  async close(): Promise<void> {
    this.closeCount++;
    this.state = "closed";
  }
}

const windowShim: {
  AudioContext: typeof TestAudioContext;
} = {
  AudioContext: TestAudioContext,
};

const playedAudioUrls: string[] = [];
let rejectAudioPlay = false;

class TestHtmlAudio {
  src: string;
  currentTime = 0;
  paused = true;

  constructor(src = "") {
    this.src = src;
  }

  async play(): Promise<void> {
    if (rejectAudioPlay) throw new Error("Playback blocked");
    this.paused = false;
    playedAudioUrls.push(this.src);
  }

  pause(): void {
    this.paused = true;
  }
}

const PHRASES_DIR = join(PUBLIC_DIR, "phrases");
const MANIFEST_RAW = readFileSync(join(PHRASES_DIR, "manifest.json"), "utf8");

Object.defineProperty(globalThis, "window", { value: windowShim, configurable: true, writable: true });
Object.defineProperty(globalThis, "AudioContext", { value: TestAudioContext, configurable: true, writable: true });
Object.defineProperty(globalThis, "AudioWorkletNode", {
  value: TestAudioWorkletNode,
  configurable: true,
  writable: true,
});
Object.defineProperty(globalThis, "Audio", { value: TestHtmlAudio, configurable: true, writable: true });
Object.defineProperty(globalThis, "fetch", {
  value: async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    if (url === "/phrases/manifest.json") {
      return {
        ok: true,
        status: 200,
        json: async () => JSON.parse(MANIFEST_RAW),
      } as unknown as Response;
    }
    return { ok: false, status: 404 } as unknown as Response;
  },
  configurable: true,
  writable: true,
});

const { MicCapture, PcmPlayer, base64ToBytes, bytesToBase64, synthPcmChunks } = await import("../src/lib/audio.ts");
const { Sonar } = await import("../src/lib/sonar.ts");
const { cuePhraseId, playPhrase, sayPhrase, stopPhrase, verdictPhraseId } = await import("../src/lib/phrases.ts");

function makeGlassesMicStream(label = "Ray-Ban Meta Hands-Free"): {
  stream: MediaStream;
  stopCalls: () => number;
} {
  let stops = 0;
  const track = {
    label,
    readyState: "live" as MediaStreamTrackState,
    stop() {
      stops++;
      this.readyState = "ended";
    },
  };
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
  return { stream, stopCalls: () => stops };
}

function concatEmittedSamples(
  posted: Array<{ msg: WorkletMessage }>,
  tail?: Int16Array,
): Int16Array {
  const chunkSamples = posted.reduce((acc, item) => acc + item.msg.pcm.byteLength / 2, 0);
  const total = chunkSamples + (tail ? tail.length : 0);
  const out = new Int16Array(total);
  let offset = 0;
  for (const item of posted) {
    const view = new Int16Array(item.msg.pcm);
    out.set(view, offset);
    offset += view.length;
  }
  if (tail && tail.length > 0) out.set(tail, offset);
  return out;
}

function dftBinMagnitude(samples: Int16Array, bin: number): number {
  const n = samples.length;
  let re = 0;
  let im = 0;
  const omega = (2 * Math.PI * bin) / n;
  for (let t = 0; t < n; t++) {
    const x = samples[t]!;
    const angle = omega * t;
    re += x * Math.cos(angle);
    im -= x * Math.sin(angle);
  }
  return Math.hypot(re, im) / (n / 2);
}

function findDominantDftBin(samples: Int16Array, sampleRate: number): {
  peakBin: number;
  peakHz: number;
  peakMag: number;
  secondMag: number;
  magnitudes: Float64Array;
} {
  const halfBins = Math.floor(samples.length / 2);
  const magnitudes = new Float64Array(halfBins + 1);
  let peakBin = 1;
  let peakMag = -1;
  for (let k = 1; k <= halfBins; k++) {
    const mag = dftBinMagnitude(samples, k);
    magnitudes[k] = mag;
    if (mag > peakMag) {
      peakMag = mag;
      peakBin = k;
    }
  }
  let secondMag = 0;
  for (let k = 1; k <= halfBins; k++) {
    if (Math.abs(k - peakBin) <= 1) continue;
    if (magnitudes[k]! > secondMag) secondMag = magnitudes[k]!;
  }
  return {
    peakBin,
    peakHz: (peakBin * sampleRate) / samples.length,
    peakMag,
    secondMag,
    magnitudes,
  };
}

type ParsedWav = {
  audioFormat: number;
  numChannels: number;
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bitsPerSample: number;
  samples: Int16Array;
  durationSec: number;
  rms: number;
  peak: number;
  minSample: number;
  maxSample: number;
  acStdDev: number;
};

function parseWavPcm16(bytes: Buffer): ParsedWav {
  assert.ok(bytes.length > 44, "WAV buffer too short");
  assert.equal(bytes.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(bytes.readUInt32LE(4), bytes.length - 8);
  assert.equal(bytes.subarray(8, 12).toString("ascii"), "WAVE");

  let offset = 12;
  let fmt: {
    audioFormat: number;
    numChannels: number;
    sampleRate: number;
    byteRate: number;
    blockAlign: number;
    bitsPerSample: number;
  } | null = null;
  let dataChunk: Buffer | null = null;

  while (offset + 8 <= bytes.length) {
    const id = bytes.subarray(offset, offset + 4).toString("ascii");
    const size = bytes.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    const bodyEnd = bodyStart + size;
    assert.ok(bodyEnd <= bytes.length, `Chunk ${id} exceeds file bounds`);

    if (id === "fmt ") {
      assert.ok(size >= 16);
      fmt = {
        audioFormat: bytes.readUInt16LE(bodyStart),
        numChannels: bytes.readUInt16LE(bodyStart + 2),
        sampleRate: bytes.readUInt32LE(bodyStart + 4),
        byteRate: bytes.readUInt32LE(bodyStart + 8),
        blockAlign: bytes.readUInt16LE(bodyStart + 12),
        bitsPerSample: bytes.readUInt16LE(bodyStart + 14),
      };
    } else if (id === "data") {
      dataChunk = bytes.subarray(bodyStart, bodyEnd);
    }

    offset = bodyEnd + (size % 2);
  }

  assert.ok(fmt, "Missing fmt chunk");
  assert.ok(dataChunk, "Missing data chunk");
  assert.equal(dataChunk.length % 2, 0, "PCM16 data chunk must have even byte count");
  const sampleCount = dataChunk.length / 2;
  assert.ok(sampleCount > 0);

  const samples = new Int16Array(sampleCount);
  let sum = 0;
  let sumSq = 0;
  let peak = 0;
  let minSample = 32767;
  let maxSample = -32768;

  for (let i = 0; i < sampleCount; i++) {
    const s = dataChunk.readInt16LE(i * 2);
    samples[i] = s;
    sum += s;
    sumSq += s * s;
    const abs = Math.abs(s);
    if (abs > peak) peak = abs;
    if (s < minSample) minSample = s;
    if (s > maxSample) maxSample = s;
  }

  const mean = sum / sampleCount;
  const variance = Math.max(0, sumSq / sampleCount - mean * mean);

  return {
    ...fmt,
    samples,
    durationSec: sampleCount / fmt.sampleRate,
    rms: Math.sqrt(sumSq / sampleCount),
    peak,
    minSample,
    maxSample,
    acStdDev: Math.sqrt(variance),
  };
}

type ParsedMp3 = {
  byteLength: number;
  hasId3v2: boolean;
  id3Bytes: number;
  frameCount: number;
  sampleRate: number;
  bitrateKbps: number;
  durationSec: number;
};

const MPEG_V1_L3_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const MPEG_V2_L3_KBPS = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const MPEG_V1_SR = [44100, 48000, 32000, 0];
const MPEG_V2_SR = [22050, 24000, 16000, 0];
const MPEG_V25_SR = [11025, 12000, 8000, 0];

function parseMp3Structure(bytes: Buffer): ParsedMp3 {
  assert.ok(bytes.length >= 4096, `Expected non-trivial MP3 byte size >= 4096, got ${bytes.length}`);

  let offset = 0;
  let hasId3v2 = false;
  let id3Bytes = 0;

  if (bytes.subarray(0, 3).toString("ascii") === "ID3") {
    hasId3v2 = true;
    const verMajor = bytes[3]!;
    const verRev = bytes[4]!;
    const flags = bytes[5]!;
    assert.ok(verMajor < 0xff && verRev < 0xff, "Invalid ID3v2 version");
    for (let i = 6; i < 10; i++) {
      assert.equal(bytes[i]! & 0x80, 0, "ID3v2 synchsafe size byte had MSB set");
    }
    const tagSize =
      ((bytes[6]! & 0x7f) << 21) |
      ((bytes[7]! & 0x7f) << 14) |
      ((bytes[8]! & 0x7f) << 7) |
      (bytes[9]! & 0x7f);
    const footerBytes = flags & 0x10 ? 10 : 0;
    id3Bytes = 10 + tagSize + footerBytes;
    offset = id3Bytes;
  }

  let frameCount = 0;
  let firstSampleRate = 0;
  let firstBitrateKbps = 0;
  let durationSec = 0;

  while (offset < bytes.length) {
    if (offset + 128 === bytes.length && bytes.subarray(offset, offset + 3).toString("ascii") === "TAG") {
      offset += 128;
      break;
    }
    assert.ok(offset + 4 <= bytes.length, `Truncated MPEG frame header at ${offset}`);
    const b0 = bytes[offset]!;
    const b1 = bytes[offset + 1]!;
    const b2 = bytes[offset + 2]!;
    assert.equal(b0, 0xff, `Missing MPEG sync byte 0xff at ${offset}`);
    assert.equal(b1 & 0xe0, 0xe0, `Missing MPEG 11-bit frame sync at ${offset}`);

    const versionBits = (b1 >> 3) & 0x03;
    const layerBits = (b1 >> 1) & 0x03;
    assert.notEqual(versionBits, 1, "Reserved MPEG version bits");
    assert.equal(layerBits, 1, "Expected MPEG Layer III audio frame");

    const brIndex = (b2 >> 4) & 0x0f;
    const srIndex = (b2 >> 2) & 0x03;
    const padding = (b2 >> 1) & 0x01;

    const isMpeg1 = versionBits === 3;
    const bitrateKbps = isMpeg1 ? MPEG_V1_L3_KBPS[brIndex]! : MPEG_V2_L3_KBPS[brIndex]!;
    const sampleRate =
      versionBits === 3 ? MPEG_V1_SR[srIndex]! : versionBits === 2 ? MPEG_V2_SR[srIndex]! : MPEG_V25_SR[srIndex]!;
    assert.ok(bitrateKbps > 0, `Invalid MPEG bitrate index ${brIndex}`);
    assert.ok(sampleRate > 0, `Invalid MPEG sample rate index ${srIndex}`);

    const samplesPerFrame = isMpeg1 ? 1152 : 576;
    const frameLength = Math.floor(((samplesPerFrame / 8) * (bitrateKbps * 1000)) / sampleRate) + padding;
    assert.ok(frameLength >= 24 && offset + frameLength <= bytes.length, `MPEG frame out of bounds at ${offset}`);

    if (frameCount === 0) {
      firstSampleRate = sampleRate;
      firstBitrateKbps = bitrateKbps;
    } else {
      assert.equal(sampleRate, firstSampleRate, "Unexpected mid-clip sample rate switch");
    }

    frameCount++;
    durationSec += samplesPerFrame / sampleRate;
    offset += frameLength;
  }

  assert.equal(offset, bytes.length, "Expected MPEG frames to align cleanly with EOF");
  return {
    byteLength: bytes.length,
    hasId3v2,
    id3Bytes,
    frameCount,
    sampleRate: firstSampleRate,
    bitrateKbps: firstBitrateKbps,
    durationSec,
  };
}

function verify8kHzSineUpsampling(freqHz: number): void {
  const renderQuanta = 50;
  const quantumSize = 128;
  const totalInputSamples = renderQuanta * quantumSize;
  const amplitude = 0.8;

  const quantumHarness = createWorkletHarness(8000);
  assert.equal(quantumHarness.registeredName, "pcm-capture");
  const proc = new quantumHarness.Ctor({ processorOptions: { outRate: 16000, chunkMs: 100 } });
  assert.equal(proc.outRate, 16000);
  assert.equal(proc.chunk, 1600);
  assert.equal(proc.ratio, 0.5);

  const monolithicInput = new Float32Array(totalInputSamples);
  for (let n = 0; n < totalInputSamples; n++) {
    monolithicInput[n] = amplitude * Math.sin((2 * Math.PI * freqHz * n) / 8000);
  }

  for (let q = 0; q < renderQuanta; q++) {
    const slice = monolithicInput.subarray(q * quantumSize, (q + 1) * quantumSize);
    assert.equal(slice.length, 128);
    assert.equal(proc.process([[slice]]), true);
  }

  assert.equal(quantumHarness.posted.length, 7);
  for (const entry of quantumHarness.posted) {
    assert.equal(entry.msg.pcm.byteLength, 3200);
    assert.equal(new Int16Array(entry.msg.pcm).length, 1600);
    assert.equal(entry.transfer?.length, 1);
    assert.equal(entry.transfer?.[0], entry.msg.pcm);
    assert.ok(entry.msg.rms > 0.5 && entry.msg.rms < 0.6);
  }

  assert.equal(proc.carry.length, 1);
  assert.equal(proc.pos, 0);
  assert.equal(proc.outLen, 1598);

  const totalUpsampled = quantumHarness.posted.length * 1600 + proc.outLen;
  assert.equal(totalUpsampled, 12798);
  assert.equal(totalUpsampled, 2 * (totalInputSamples - proc.carry.length));

  const singleHarness = createWorkletHarness(8000);
  const singleProc = new singleHarness.Ctor({ processorOptions: { outRate: 16000, chunkMs: 100 } });
  assert.equal(singleProc.process([[monolithicInput]]), true);

  const quantumStream = concatEmittedSamples(quantumHarness.posted, proc.out.subarray(0, proc.outLen));
  const monolithicStream = concatEmittedSamples(singleHarness.posted, singleProc.out.subarray(0, singleProc.outLen));
  assert.equal(quantumStream.length, monolithicStream.length);
  assert.deepEqual(quantumStream, monolithicStream);

  const smoothLipschitzBound = Math.ceil(amplitude * 32768 * ((2 * Math.PI * freqHz) / 16000)) + 2;
  let maxFirstDiff = 0;
  for (let i = 1; i < quantumStream.length; i++) {
    const diff = Math.abs(quantumStream[i]! - quantumStream[i - 1]!);
    if (diff > maxFirstDiff) maxFirstDiff = diff;
  }
  assert.ok(
    maxFirstDiff <= smoothLipschitzBound,
    `Expected smooth first-difference <= ${smoothLipschitzBound} for ${freqHz} Hz, got ${maxFirstDiff}`,
  );

  for (let q = 0; q < renderQuanta - 1; q++) {
    const seamIndex = 254 + q * 256;
    const beforeSeamDiff = Math.abs(quantumStream[seamIndex]! - quantumStream[seamIndex - 1]!);
    const acrossSeamDiff = Math.abs(quantumStream[seamIndex + 1]! - quantumStream[seamIndex]!);
    assert.ok(beforeSeamDiff <= smoothLipschitzBound);
    assert.ok(acrossSeamDiff <= smoothLipschitzBound);
  }

  proc.process([[new Float32Array([0])]]);
  assert.equal(quantumHarness.posted.length, 8);
  assert.equal(proc.outLen, 0);
  assert.equal(quantumHarness.posted.length * 1600, 2 * totalInputSamples);
}

test("8 kHz Bluetooth HFP -> 16 kHz PCM16 upsampling across 50 x 128-sample render quanta at 440 Hz conserves samples and eliminates seam clicks", () => {
  verify8kHzSineUpsampling(440);
});

test("8 kHz Bluetooth HFP -> 16 kHz PCM16 upsampling across 50 x 128-sample render quanta at 1000 Hz conserves samples, eliminates seam clicks, and downmixes dual channels", () => {
  verify8kHzSineUpsampling(1000);

  const stereoHfp = createWorkletHarness(8000);
  const proc = new stereoHfp.Ctor({ processorOptions: { outRate: 16000, chunkMs: 100 } });
  let n = 0;
  for (let q = 0; q < 50; q++) {
    const left = new Float32Array(128);
    const right = new Float32Array(128);
    for (let i = 0; i < 128; i++) {
      const s = Math.sin((2 * Math.PI * 1000 * n++) / 8000);
      left[i] = 0.9 * s;
      right[i] = 0.3 * s;
    }
    proc.process([[left, right]]);
  }
  assert.equal(stereoHfp.posted.length, 7);
  const expectedRms = (0.6 / Math.SQRT2) * Math.cos((Math.PI * 1000) / 16000);
  assert.ok(Math.abs(stereoHfp.posted[0]!.msg.rms - expectedRms) < 0.02);
});

test("8 kHz -> 16 kHz upsampler preserves 440 Hz, 1000 Hz, and dual-tone fundamental frequencies via 1600-point DFT peak check", () => {
  const amplitude = 0.8;

  for (const [freqHz, expectedBin, minSpuriousRatio] of [
    [440, 44, 100],
    [1000, 100, 20],
  ] as const) {
    const harness = createWorkletHarness(8000);
    const proc = new harness.Ctor({ processorOptions: { outRate: 16000, chunkMs: 100 } });

    let sampleIndex = 0;
    for (let q = 0; q < 50; q++) {
      const block = new Float32Array(128);
      for (let i = 0; i < 128; i++) {
        block[i] = amplitude * Math.sin((2 * Math.PI * freqHz * sampleIndex++) / 8000);
      }
      proc.process([[block]]);
    }

    assert.equal(harness.posted.length, 7);
    const expectedPassbandMag = amplitude * 32767 * Math.cos((Math.PI * freqHz) / 16000) ** 2;

    for (const chunkIdx of [0, 3, 6]) {
      const chunk = new Int16Array(harness.posted[chunkIdx]!.msg.pcm);
      assert.equal(chunk.length, 1600);
      const spectrum = findDominantDftBin(chunk, 16000);
      assert.equal(spectrum.peakBin, expectedBin);
      assert.equal(spectrum.peakHz, freqHz);
      assert.ok(
        Math.abs(spectrum.peakMag - expectedPassbandMag) / expectedPassbandMag < 0.02,
        `Expected ${freqHz} Hz DFT magnitude near ${expectedPassbandMag.toFixed(1)}, got ${spectrum.peakMag.toFixed(1)}`,
      );
      assert.ok(
        spectrum.peakMag / spectrum.secondMag > minSpuriousRatio,
        `Expected ${freqHz} Hz peak-to-spurious ratio > ${minSpuriousRatio}, got ${(spectrum.peakMag / spectrum.secondMag).toFixed(2)}`,
      );
    }
  }

  const dualHarness = createWorkletHarness(8000);
  const dualProc = new dualHarness.Ctor({ processorOptions: { outRate: 16000, chunkMs: 100 } });
  let phase = 0;
  for (let q = 0; q < 50; q++) {
    const block = new Float32Array(128);
    for (let i = 0; i < 128; i++) {
      block[i] =
        0.4 * Math.sin((2 * Math.PI * 440 * phase) / 8000) +
        0.4 * Math.sin((2 * Math.PI * 1000 * phase) / 8000);
      phase++;
    }
    dualProc.process([[block]]);
  }

  const dualChunk = new Int16Array(dualHarness.posted[2]!.msg.pcm);
  const rankedBins: Array<{ bin: number; mag: number }> = [];
  for (let k = 1; k <= 800; k++) {
    rankedBins.push({ bin: k, mag: dftBinMagnitude(dualChunk, k) });
  }
  rankedBins.sort((a, b) => b.mag - a.mag);
  const topTwoHz = [rankedBins[0]!.bin * 10, rankedBins[1]!.bin * 10].sort((a, b) => a - b);
  assert.deepEqual(topTwoHz, [440, 1000]);
  assert.ok(rankedBins[1]!.mag / rankedBins[2]!.mag > 20);
});

test("16 kHz wideband HFP (sampleRate = 16000) performs 1:1 bit-exact pass-through without box-filter attenuation", () => {
  const wbHarness = createWorkletHarness(16000);
  const wbProc = new wbHarness.Ctor({ processorOptions: { outRate: 16000, chunkMs: 100 } });
  assert.equal(wbProc.ratio, 1);
  assert.equal(wbProc.chunk, 1600);

  const wbQuanta = 26;
  const wbTotal = wbQuanta * 128;
  const wbInput = new Float32Array(wbTotal);
  const expectedPcm16 = new Int16Array(wbTotal);

  for (let i = 0; i < wbTotal; i++) {
    const sample =
      0.45 * Math.sin((2 * Math.PI * 440 * i) / 16000) +
      0.25 * Math.sin((2 * Math.PI * 1000 * i) / 16000) +
      0.2 * Math.sin((2 * Math.PI * 3400 * i) / 16000);
    wbInput[i] = sample;
    const clamped = Math.max(-1, Math.min(1, wbInput[i]!));
    expectedPcm16[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }

  for (let q = 0; q < wbQuanta; q++) {
    wbProc.process([[wbInput.subarray(q * 128, (q + 1) * 128)]]);
  }

  assert.equal(wbHarness.posted.length, 2);
  assert.equal(wbProc.carry.length, 1);
  assert.equal(wbProc.pos, 0);
  assert.equal(wbProc.outLen, wbTotal - 3200 - 1);

  const wbEmitted = concatEmittedSamples(wbHarness.posted, wbProc.out.subarray(0, wbProc.outLen));
  assert.equal(wbEmitted.length, wbTotal - 1);
  assert.deepEqual(wbEmitted, expectedPcm16.subarray(0, wbTotal - 1));
});

test("48 kHz anti-alias box filter (step = 3 >= 2) attenuates 12 kHz above-Nyquist tone vs unattenuated 500 Hz voice tone", () => {
  function run48kTone(freqHz: number): { chunk: Int16Array; rms: number } {
    const h48 = createWorkletHarness(48000);
    const p48 = new h48.Ctor({ processorOptions: { outRate: 16000, chunkMs: 100 } });
    assert.equal(p48.ratio, 3);
    let idx = 0;
    for (let q = 0; q < 50; q++) {
      const blk = new Float32Array(128);
      for (let i = 0; i < 128; i++) {
        blk[i] = 0.8 * Math.sin((2 * Math.PI * freqHz * idx++) / 48000);
      }
      p48.process([[blk]]);
    }
    assert.equal(h48.posted.length, 1);
    return {
      chunk: new Int16Array(h48.posted[0]!.msg.pcm),
      rms: h48.posted[0]!.msg.rms,
    };
  }

  const voice500 = run48kTone(500);
  const aboveNyquist12k = run48kTone(12000);
  const boxNull16k = run48kTone(16000);

  const idealRms = 0.8 / Math.SQRT2;
  assert.ok(Math.abs(voice500.rms - idealRms) < 0.01, `Expected 500 Hz voice RMS near ${idealRms}, got ${voice500.rms}`);

  const voiceSpectrum = findDominantDftBin(voice500.chunk, 16000);
  assert.equal(voiceSpectrum.peakHz, 500);

  const attenuationRatio = voice500.rms / aboveNyquist12k.rms;
  assert.ok(
    attenuationRatio > 2.8 && attenuationRatio < 3.1,
    `Expected 12 kHz box-filtered RMS attenuation ~3x vs 500 Hz voice tone, got ${attenuationRatio.toFixed(3)}x`,
  );

  const aliased4kMag = dftBinMagnitude(aboveNyquist12k.chunk, 400);
  assert.ok(
    aliased4kMag < voiceSpectrum.peakMag * 0.36,
    `Expected aliased 4 kHz bin (${aliased4kMag.toFixed(1)}) < 0.36x voice 500 Hz peak (${voiceSpectrum.peakMag.toFixed(1)})`,
  );

  assert.ok(boxNull16k.rms < voice500.rms * 0.08);

  const alignedNullHarness = createWorkletHarness(48000);
  const alignedNullProc = new alignedNullHarness.Ctor({ processorOptions: { outRate: 16000, chunkMs: 100 } });
  const alignedNullBuf = new Float32Array(4803);
  for (let i = 0; i < alignedNullBuf.length; i++) {
    alignedNullBuf[i] = 0.8 * Math.sin((2 * Math.PI * 16000 * i) / 48000);
  }
  alignedNullProc.process([[alignedNullBuf]]);
  assert.equal(alignedNullHarness.posted.length, 1);
  assert.ok(alignedNullHarness.posted[0]!.msg.rms < 1e-9);
});

test("MicCapture on Ray-Ban Meta 8 kHz HFP stream round-trips 16 kHz PCM16 base64 chunks bit-exactly via base64ToBytes", async () => {
  TestAudioContext.reset();

  const capturedChunks: Array<{ b64: string; rms: number }> = [];
  const mic = new MicCapture((b64, rms) => capturedChunks.push({ b64, rms }));

  mic.prime();
  const { stream, stopCalls } = makeGlassesMicStream("Ray-Ban Meta Hands-Free");
  await mic.start(stream);
  assert.equal(mic.active, true);
  assert.equal(mic.label, "Ray-Ban Meta Hands-Free");
  assert.equal(TestAudioWorkletNode.instances.length, 1);

  const micCtx = TestAudioContext.instances[0]!;
  assert.deepEqual(micCtx.addModuleCalls, ["/pcm-capture-worklet.js"]);
  assert.equal(micCtx.gains.length, 1);
  assert.equal(micCtx.gains[0]!.gain.value, 0);

  const workletNode = TestAudioWorkletNode.instances[0]!;
  assert.equal(workletNode.name, "pcm-capture");
  assert.deepEqual(workletNode.options, { processorOptions: { outRate: 16000, chunkMs: 100 } });

  const refHarness = createWorkletHarness(8000);
  const refProc = new refHarness.Ctor({ processorOptions: { outRate: 16000, chunkMs: 100 } });

  let hfpSample = 0;
  for (let q = 0; q < 50; q++) {
    const quantum = new Float32Array(128);
    for (let i = 0; i < 128; i++) {
      quantum[i] = 0.75 * Math.sin((2 * Math.PI * 440 * hfpSample++) / 8000);
    }
    workletNode.pushQuantum(quantum);
    refProc.process([[quantum]]);
  }

  assert.equal(capturedChunks.length, 7);
  assert.equal(mic.chunks, 7);
  for (let c = 0; c < 7; c++) {
    const decodedBytes = base64ToBytes(capturedChunks[c]!.b64);
    const expectedBytes = new Uint8Array(refHarness.posted[c]!.msg.pcm);
    assert.equal(decodedBytes.byteLength, 3200);
    assert.deepEqual(decodedBytes, expectedBytes);
    assert.equal(capturedChunks[c]!.rms, refHarness.posted[c]!.msg.rms);
  }

  const extremePcm = new Int16Array([-32768, -16384, -1, 0, 1, 16384, 32767, -21845, 21845]);
  workletNode.emitDirectChunk(extremePcm.buffer.slice(0), 0.625);
  assert.equal(capturedChunks.length, 8);
  const roundTrippedExtremes = base64ToBytes(capturedChunks[7]!.b64);
  assert.deepEqual(roundTrippedExtremes, new Uint8Array(extremePcm.buffer));

  await mic.stop(false);
  assert.equal(stopCalls(), 1);
  assert.equal(mic.active, false);
});

test("PcmPlayer 24 kHz playback triggers onPlayingChange(true) -> Sonar.duck(true) dropping gain to 0.25x and suppressing 990 Hz ticks at readiness >= 0.85", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  TestAudioContext.reset();

  const player = new PcmPlayer(24000);
  const sonar = new Sonar();
  const playingStates: boolean[] = [];
  player.onPlayingChange = (playing) => {
    playingStates.push(playing);
    sonar.duck(playing);
  };

  t.after(async () => {
    sonar.stop();
    await player.close();
  });

  await player.unlock();
  sonar.unlock();

  const playerCtx = TestAudioContext.instances[0]!;
  const sonarCtx = TestAudioContext.instances[1]!;

  sonar.volume = 0.4;
  sonarCtx.currentTime = 10.0;
  sonar.set(0.88);
  assert.equal(sonar.active, true);

  const mainOsc = sonarCtx.oscillators[0]!;
  const mainGain = sonarCtx.gains[0]!;
  const unduckedGain = 0.4 * 0.09;
  assert.ok(Math.abs(mainOsc.frequency.value - (220 + 0.88 * 440)) < 1e-9);
  assert.ok(Math.abs(mainGain.gain.value - unduckedGain) < 1e-9);

  t.mock.timers.tick(700);
  assert.equal(sonarCtx.oscillators.length, 2);
  assert.equal(sonarCtx.oscillators[1]!.type, "triangle");
  assert.equal(sonarCtx.oscillators[1]!.frequency.value, 990);

  playerCtx.currentTime = 20.0;
  sonarCtx.currentTime = 10.7;

  const assistantChunks24k = synthPcmChunks([440, 554.37, 659.25], 180, 24000);
  assert.equal(assistantChunks24k.length, 3);
  for (const b64 of assistantChunks24k) {
    player.enqueue(b64);
  }

  assert.equal(player.playing, true);
  assert.deepEqual(playingStates, [true]);
  assert.equal(playerCtx.buffers.length, 3);
  for (const buf of playerCtx.buffers) {
    assert.equal(buf.sampleRate, 24000);
    assert.equal(buf.length, 4320);
  }
  assert.ok(Math.abs(playerCtx.sources[0]!.startedAt[0]! - 20.06) < 1e-9);
  assert.ok(Math.abs(playerCtx.sources[1]!.startedAt[0]! - 20.24) < 1e-9);
  assert.ok(Math.abs(playerCtx.sources[2]!.startedAt[0]! - 20.42) < 1e-9);

  assert.ok(
    Math.abs(mainGain.gain.value - unduckedGain * 0.25) < 1e-9,
    `Expected Sonar gain to drop to 0.25x (${unduckedGain * 0.25}), got ${mainGain.gain.value}`,
  );
  assert.equal(mainGain.gain.ops.at(-1)?.timeConstant, 0.08);

  sonar.set(0.85);
  assert.ok(Math.abs(mainGain.gain.value - unduckedGain * 0.25) < 1e-9);
  t.mock.timers.tick(700);
  sonar.set(0.91);
  t.mock.timers.tick(700);
  sonar.set(0.96);
  t.mock.timers.tick(700);
  assert.equal(
    sonarCtx.oscillators.length,
    2,
    "Expected 990 Hz readiness ticks to stay suppressed while PcmPlayer is speaking",
  );
});

test("Barge-in player.flush() and natural playback completion trigger onPlayingChange(false) -> Sonar.duck(false) immediately", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  TestAudioContext.reset();

  const player = new PcmPlayer(24000);
  const sonar = new Sonar();
  const playingStates: boolean[] = [];
  player.onPlayingChange = (playing) => {
    playingStates.push(playing);
    sonar.duck(playing);
  };

  t.after(async () => {
    sonar.stop();
    await player.close();
  });

  await player.unlock();
  sonar.unlock();

  const playerCtx = TestAudioContext.instances[0]!;
  const sonarCtx = TestAudioContext.instances[1]!;

  sonar.volume = 0.4;
  const unduckedGain = 0.4 * 0.09;
  sonar.set(0.9);
  const mainGain = sonarCtx.gains[0]!;

  for (const b64 of synthPcmChunks([440, 523.25], 180, 24000)) {
    player.enqueue(b64);
  }
  assert.equal(player.playing, true);
  assert.deepEqual(playingStates, [true]);
  assert.ok(Math.abs(mainGain.gain.value - unduckedGain * 0.25) < 1e-9);

  sonarCtx.currentTime = 12.8;
  player.flush();

  assert.equal(player.playing, false);
  assert.deepEqual(playingStates, [true, false]);
  for (const src of playerCtx.sources) {
    assert.equal(src.stopCount, 1);
    assert.equal(src.disconnectCount, 1);
    assert.equal(src.onended, null);
  }

  assert.ok(
    Math.abs(mainGain.gain.value - unduckedGain) < 1e-9,
    `Expected Sonar gain restored to 1.0x (${unduckedGain}) after barge-in flush, got ${mainGain.gain.value}`,
  );
  assert.equal(mainGain.gain.ops.at(-1)?.timeConstant, 0.08);

  t.mock.timers.tick(700);
  assert.equal(sonarCtx.oscillators.length, 2);
  assert.equal(sonarCtx.oscillators[1]!.frequency.value, 990);

  const followUp = bytesToBase64(new Int16Array(2400).fill(4096).buffer);
  playerCtx.currentTime = 30.0;
  player.enqueue(followUp);
  player.enqueue(followUp);
  assert.deepEqual(playingStates, [true, false, true]);
  assert.ok(Math.abs(mainGain.gain.value - unduckedGain * 0.25) < 1e-9);

  playerCtx.sources[2]!.onended?.();
  assert.equal(player.playing, true);
  assert.ok(Math.abs(mainGain.gain.value - unduckedGain * 0.25) < 1e-9);

  playerCtx.sources[3]!.onended?.();
  assert.equal(player.playing, false);
  assert.deepEqual(playingStates, [true, false, true, false]);
  assert.ok(Math.abs(mainGain.gain.value - unduckedGain) < 1e-9);
});

test("All 21 pre-rendered EN/FI/SV coaching .wav clips have valid RIFF/WAVE mono PCM16 headers, duration in [0.25s, 4.5s], RMS > 300, and peak < 32767", () => {
  const manifest = JSON.parse(MANIFEST_RAW) as {
    model: string;
    phrases: Record<string, Record<string, { file: string; text: string }>>;
  };

  const langs = ["en", "fi", "sv"] as const;
  const expectedCueIds = [
    "cue_closer",
    "cue_further",
    "cue_rotate",
    "cue_tilt",
    "cue_more_light",
    "cue_steady",
    "cue_reading",
  ] as const;

  assert.deepEqual(Object.keys(manifest.phrases).sort(), [...langs].sort());

  let verifiedWavCount = 0;
  for (const lang of langs) {
    const langMap = manifest.phrases[lang]!;
    assert.ok(langMap, `Missing language ${lang} in phrases manifest`);

    for (const cueId of expectedCueIds) {
      const entry = langMap[cueId];
      assert.ok(entry, `Missing coaching clip ${lang}/${cueId} in manifest`);
      assert.equal(entry.file, `/phrases/${lang}/${cueId}.wav`);
      assert.ok(entry.text.trim().length >= 5, `Empty phrase text for ${lang}/${cueId}`);

      const diskPath = join(PUBLIC_DIR, entry.file);
      assert.equal(existsSync(diskPath), true, `Missing WAV file on disk: ${entry.file}`);

      const wav = parseWavPcm16(readFileSync(diskPath));
      assert.equal(wav.audioFormat, 1, `${entry.file}: expected uncompressed PCM format 1`);
      assert.equal(wav.numChannels, 1, `${entry.file}: expected mono (1 channel)`);
      assert.equal(wav.bitsPerSample, 16, `${entry.file}: expected 16-bit PCM`);
      assert.ok(wav.sampleRate >= 8000, `${entry.file}: unexpected sampleRate ${wav.sampleRate}`);
      assert.equal(wav.blockAlign, 2, `${entry.file}: expected blockAlign 2`);
      assert.equal(wav.byteRate, wav.sampleRate * 2, `${entry.file}: byteRate mismatch`);
      assert.ok(
        wav.durationSec >= 0.25 && wav.durationSec <= 4.5,
        `${entry.file}: duration ${wav.durationSec.toFixed(3)}s outside [0.25s, 4.5s]`,
      );
      assert.ok(wav.rms > 300, `${entry.file}: silent or near-silent RMS ${wav.rms.toFixed(1)}`);
      assert.ok(wav.acStdDev > 300, `${entry.file}: flat/DC signal stdDev ${wav.acStdDev.toFixed(1)}`);
      assert.ok(wav.peak < 32767, `${entry.file}: clipped peak ${wav.peak}`);
      assert.ok(wav.minSample > -32768 && wav.maxSample < 32767, `${entry.file}: rail clipping detected`);

      verifiedWavCount++;
    }
  }

  assert.equal(verifiedWavCount, 21);
});

test("All 21 pre-rendered EN/FI/SV safety .mp3 clips have valid ID3/MPEG Layer III frame sync, non-trivial byte sizes, and complete manifest routing", async () => {
  const manifest = JSON.parse(MANIFEST_RAW) as {
    phrases: Record<string, Record<string, { file: string; text: string }>>;
  };

  const langs = ["en", "fi", "sv"] as const;
  const expectedSafetyIds = [
    "offline",
    "back_online",
    "not_sure",
    "unknown_offline",
    "already_taken",
    "glasses_off",
    "camera_off",
  ] as const;

  let verifiedMp3Count = 0;
  let totalClipCount = 0;

  for (const lang of langs) {
    const filesOnDisk = readdirSync(join(PHRASES_DIR, lang)).sort();
    assert.equal(filesOnDisk.length, 14, `Expected 14 clips in phrases/${lang}`);
    totalClipCount += filesOnDisk.length;

    const langMap = manifest.phrases[lang]!;
    assert.equal(Object.keys(langMap).length, 14);

    for (const safetyId of expectedSafetyIds) {
      const entry = langMap[safetyId];
      assert.ok(entry, `Missing safety clip ${lang}/${safetyId} in manifest`);
      assert.equal(entry.file, `/phrases/${lang}/${safetyId}.mp3`);
      assert.ok(entry.text.trim().length >= 8, `Phrase text too short for ${lang}/${safetyId}`);

      const diskPath = join(PUBLIC_DIR, entry.file);
      assert.equal(existsSync(diskPath), true, `Missing MP3 file on disk: ${entry.file}`);

      const mp3 = parseMp3Structure(readFileSync(diskPath));
      assert.ok(mp3.byteLength >= 4096, `${entry.file}: byteLength ${mp3.byteLength} too small`);
      assert.ok(mp3.frameCount >= 20, `${entry.file}: expected >= 20 MPEG frames, got ${mp3.frameCount}`);
      assert.ok(
        mp3.durationSec >= 0.5 && mp3.durationSec <= 12.0,
        `${entry.file}: duration ${mp3.durationSec.toFixed(3)}s outside [0.5s, 12.0s]`,
      );

      verifiedMp3Count++;
    }
  }

  assert.equal(verifiedMp3Count, 21);
  assert.equal(totalClipCount, 42);

  assert.equal(cuePhraseId("closer"), "cue_closer");
  assert.equal(cuePhraseId("farther"), "cue_further");
  assert.equal(cuePhraseId("rotate_left"), "cue_rotate");
  assert.equal(cuePhraseId("rotate_right"), "cue_rotate");
  assert.equal(cuePhraseId("other_side"), "cue_tilt");
  assert.equal(cuePhraseId("more_light"), "cue_more_light");
  assert.equal(cuePhraseId("hold_still", "Hold still"), "cue_steady");
  assert.equal(cuePhraseId("hold_still", "Reading the label"), "cue_reading");
  assert.equal(cuePhraseId("ok", "Camera stopped"), "camera_off");
  assert.equal(cuePhraseId("ok", "Got it"), "cue_reading");

  const emptyRead = {
    kind: "unreadable" as const,
    product: { value: null, confidence: 0 },
    ingredient: { value: null, confidence: 0 },
    strength: { value: null, confidence: 0 },
    dosing: { value: null, confidence: 0 },
    expiry: { value: null, confidence: 0 },
    allergens: { value: null, confidence: 0 },
    barcode: { value: null, confidence: 0 },
    readability: 0,
  };

  assert.equal(
    verdictPhraseId({
      level: "unsure",
      headline: "Not sure",
      speech: "I'm not sure.",
      takenToday: false,
      reasons: [],
      read: emptyRead,
    }),
    "not_sure",
  );
  assert.equal(
    verdictPhraseId({
      level: "warning",
      headline: "Amlodipine already taken today",
      speech: "You already took this today.",
      takenToday: true,
      reasons: [],
      read: emptyRead,
    }),
    "already_taken",
  );
  assert.equal(
    verdictPhraseId(
      {
        level: "unsure",
        headline: "Pack code not on your list",
        speech: "Unknown offline.",
        takenToday: false,
        reasons: [],
        read: emptyRead,
      },
      "offline",
    ),
    "unknown_offline",
  );

  playedAudioUrls.length = 0;
  rejectAudioPlay = false;
  assert.equal(await playPhrase("cue_closer", "fi"), true);
  assert.equal(await playPhrase("not_sure", "sv"), true);
  assert.equal(await playPhrase("glasses_off", "en"), true);
  assert.deepEqual(playedAudioUrls, [
    "/phrases/fi/cue_closer.wav",
    "/phrases/sv/not_sure.mp3",
    "/phrases/en/glasses_off.mp3",
  ]);

  const fallbackSpoken: string[] = [];
  rejectAudioPlay = true;
  await sayPhrase("offline", "fi", (txt) => fallbackSpoken.push(txt), "Fallback offline text");
  assert.deepEqual(fallbackSpoken, ["Fallback offline text"]);
  stopPhrase();
  rejectAudioPlay = false;
});
