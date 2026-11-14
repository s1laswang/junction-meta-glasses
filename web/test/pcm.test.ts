import { MicCapture } from "../src/audio/micCapture.ts";
import {
  base64ToPcm16,
  downsampleBuffer,
  float32ToPcm16,
  pcm16ToBase64,
  pcm16ToFloat32,
  rmsLevel
} from "../src/audio/pcm.ts";
import { PcmPlayer, createLiveAudioBridge } from "../src/audio/player.ts";
import { classifyMediaError } from "../src/camera/cameraStream.ts";

type TestFn = (name: string, fn: () => void | Promise<void>) => Promise<void>;

type StrictAssert = {
  ok(value: unknown, message?: string): asserts value;
  equal<T>(actual: T, expected: T, message?: string): void;
  deepEqual<T>(actual: T, expected: T, message?: string): void;
  throws(block: () => unknown, error?: RegExp | ErrorConstructor): void;
  doesNotThrow(block: () => unknown, message?: string): void;
  doesNotReject(block: () => Promise<unknown>, message?: string): Promise<void>;
  rejects(block: () => Promise<unknown>, message?: string): Promise<void>;
};

const nodeTestSpec = String("node:test");
const nodeAssertSpec = String("node:assert/strict");
const { test }: { test: TestFn } = (await import(nodeTestSpec)) as { test: TestFn };
const assert: StrictAssert = ((await import(nodeAssertSpec)) as { default: StrictAssert }).default;

function generateSine(freqHz: number, sampleRate: number, durationSec: number, amplitude = 1): Float32Array {
  const length = Math.round(sampleRate * durationSec);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    out[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  }
  return out;
}

function goertzelMagnitude(samples: Float32Array, targetFreqHz: number, sampleRate: number): number {
  const n = samples.length;
  if (n === 0) {
    return 0;
  }
  const omega = (2 * Math.PI * targetFreqHz) / sampleRate;
  const coeff = 2 * Math.cos(omega);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i += 1) {
    s0 = samples[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const real = s1 - s2 * Math.cos(omega);
  const imag = s2 * Math.sin(omega);
  return (2 * Math.sqrt(real * real + imag * imag)) / n;
}

function countZeroCrossings(samples: Float32Array): number {
  let crossings = 0;
  for (let i = 1; i < samples.length; i += 1) {
    if ((samples[i - 1] < 0 && samples[i] >= 0) || (samples[i - 1] > 0 && samples[i] <= 0)) {
      crossings += 1;
    }
  }
  return crossings;
}

function peakAbs(samples: Float32Array): number {
  let max = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const abs = Math.abs(samples[i]);
    if (abs > max) {
      max = abs;
    }
  }
  return max;
}

test("PCM16 roundtrip float32ToPcm16 -> pcm16ToBase64 -> base64ToPcm16 -> pcm16ToFloat32 in browser and Buffer paths", () => {
  const len = 1600;
  const original = new Float32Array(len);
  original[0] = -1.0;
  original[1] = 0.0;
  original[2] = 1.0;
  original[3] = -0.5;
  original[4] = 0.5;
  for (let i = 5; i < len; i += 1) {
    const t = i / 16000;
    original[i] = 0.6 * Math.sin(2 * Math.PI * 440 * t) + 0.25 * Math.cos(2 * Math.PI * 1100 * t);
  }

  const pcm = float32ToPcm16(original);
  assert.equal(pcm.length, len);
  assert.equal(pcm[0], -32768);
  assert.equal(pcm[1], 0);
  assert.equal(pcm[2], 32767);

  const b64Browser = pcm16ToBase64(pcm);
  assert.ok(b64Browser.length > 0);
  const decodedBrowser = base64ToPcm16(b64Browser);
  assert.deepEqual(decodedBrowser, pcm);

  const g = globalThis as Record<string, unknown>;
  const prevBtoa = g.btoa;
  const prevAtob = g.atob;
  delete g.btoa;
  delete g.atob;
  try {
    const b64Node = pcm16ToBase64(pcm);
    assert.equal(b64Node, b64Browser);
    const decodedNode = base64ToPcm16(`  ${b64Node}\n`);
    assert.deepEqual(decodedNode, pcm);
  } finally {
    if (prevBtoa !== undefined) g.btoa = prevBtoa;
    if (prevAtob !== undefined) g.atob = prevAtob;
  }

  const reconstructed = pcm16ToFloat32(decodedBrowser);
  assert.equal(reconstructed.length, len);
  assert.equal(reconstructed[0], -1.0);
  assert.equal(reconstructed[1], 0.0);
  assert.equal(reconstructed[2], 1.0);

  for (let i = 0; i < len; i += 1) {
    const diff = Math.abs(reconstructed[i] - original[i]);
    assert.ok(diff <= 1 / 32767 + 1e-6, `sample ${i} quantization error ${diff} too high`);
  }

  assert.equal(pcm16ToBase64(new Int16Array(0)), "");
  assert.deepEqual(base64ToPcm16(""), new Int16Array(0));
  assert.deepEqual(base64ToPcm16("   "), new Int16Array(0));
});

test("float32ToPcm16 clamps saturation cleanly at -1.0 and +1.0 and handles non-finite inputs", () => {
  const samples = new Float32Array([
    -Infinity,
    -100.0,
    -1.5,
    -1.0001,
    -1.0,
    0.0,
    Number.NaN,
    1.0,
    1.0001,
    1.5,
    100.0,
    Infinity
  ]);

  const pcm = float32ToPcm16(samples);
  assert.deepEqual(
    Array.from(pcm),
    [-32768, -32768, -32768, -32768, -32768, 0, 0, 32767, 32767, 32767, 32767, 32767]
  );

  const floats = pcm16ToFloat32(pcm);
  assert.equal(floats[0], -1.0);
  assert.equal(floats[4], -1.0);
  assert.equal(floats[5], 0.0);
  assert.equal(floats[6], 0.0);
  assert.equal(floats[7], 1.0);
  assert.equal(floats[11], 1.0);
});

test("downsampleBuffer preserves sine frequency and amplitude from 48000 -> 16000 and 44100 -> 16000 and attenuates aliases", () => {
  const identityInput = generateSine(440, 16000, 0.1, 0.7);
  const identityOut = downsampleBuffer(identityInput, 16000, 16000);
  assert.equal(identityOut, identityInput);
  assert.equal(downsampleBuffer(new Float32Array(0), 48000, 16000).length, 0);
  assert.throws(() => downsampleBuffer(identityInput, 0, 16000), RangeError);
  assert.throws(() => downsampleBuffer(identityInput, 48000, -1), RangeError);

  const sine48k = generateSine(440, 48000, 1.0, 0.8);
  const down48k = downsampleBuffer(sine48k, 48000, 16000);
  assert.equal(down48k.length, 16000);

  const mag440From48k = goertzelMagnitude(down48k, 440, 16000);
  const mag200From48k = goertzelMagnitude(down48k, 200, 16000);
  const mag900From48k = goertzelMagnitude(down48k, 900, 16000);
  assert.ok(mag440From48k > 0.79 && mag440From48k < 0.81, `expected ~0.8, got ${mag440From48k}`);
  assert.ok(mag200From48k < 0.01);
  assert.ok(mag900From48k < 0.01);
  const crossings48k = countZeroCrossings(down48k);
  assert.ok(Math.abs(crossings48k - 880) <= 2, `expected ~880 zero crossings, got ${crossings48k}`);
  const peak48k = peakAbs(down48k);
  assert.ok(peak48k > 0.79 && peak48k <= 0.805);

  const composite48k = new Float32Array(48000);
  for (let i = 0; i < composite48k.length; i += 1) {
    composite48k[i] =
      0.5 * Math.sin((2 * Math.PI * 440 * i) / 48000) +
      0.5 * Math.sin((2 * Math.PI * 16000 * i) / 48000);
  }
  const filtered48k = downsampleBuffer(composite48k, 48000, 16000);
  const preservedBase = goertzelMagnitude(filtered48k, 440, 16000);
  const totalRms = rmsLevel(filtered48k);
  assert.ok(preservedBase > 0.49 && preservedBase < 0.51);
  assert.ok(Math.abs(totalRms - 0.5 / Math.SQRT2) < 0.01, `alias energy leaked into baseband: ${totalRms}`);

  const sine44k = generateSine(440, 44100, 1.0, 0.75);
  const down44k = downsampleBuffer(sine44k, 44100, 16000);
  assert.equal(down44k.length, 16000);

  const mag440From44k = goertzelMagnitude(down44k, 440, 16000);
  const mag300From44k = goertzelMagnitude(down44k, 300, 16000);
  const mag700From44k = goertzelMagnitude(down44k, 700, 16000);
  assert.ok(mag440From44k > 0.735 && mag440From44k < 0.76, `expected ~0.75, got ${mag440From44k}`);
  assert.ok(mag300From44k < 0.01);
  assert.ok(mag700From44k < 0.01);
  const crossings44k = countZeroCrossings(down44k);
  assert.ok(Math.abs(crossings44k - 880) <= 2, `expected ~880 zero crossings, got ${crossings44k}`);

  const sine8k = generateSine(440, 8000, 0.5, 0.6);
  const up16k = downsampleBuffer(sine8k, 8000, 16000);
  assert.equal(up16k.length, 8000);
  assert.ok(goertzelMagnitude(up16k, 440, 16000) > 0.55);
});

test("rmsLevel computes accurate 0..1 VU levels and clamps extremes", () => {
  assert.equal(rmsLevel(new Float32Array(0)), 0);
  assert.equal(rmsLevel(new Float32Array(256)), 0);

  const halfDc = new Float32Array(128).fill(0.5);
  assert.ok(Math.abs(rmsLevel(halfDc) - 0.5) < 1e-6);

  const negFullDc = new Float32Array(128).fill(-1.0);
  assert.equal(rmsLevel(negFullDc), 1);

  const sine = generateSine(250, 16000, 0.2, 0.6);
  const expectedSineRms = 0.6 / Math.SQRT2;
  assert.ok(Math.abs(rmsLevel(sine) - expectedSineRms) < 0.005);

  const overloaded = new Float32Array([2.5, -3.0, Infinity, -Infinity]);
  assert.equal(rmsLevel(overloaded), 1);

  const withNan = new Float32Array([Number.NaN, Number.NaN]);
  assert.equal(rmsLevel(withNan), 0);
});

test("PcmPlayer schedules 24 kHz chunks gaplessly, flushes instantly on barge-in, resumes, and disposes", async () => {
  const g = globalThis as Record<string, unknown>;
  const prevAudioCtx = g.AudioContext;
  const prevWindow = g.window;

  const scheduled: Array<{
    startAt: number;
    duration: number;
    sampleRate: number;
    stopped: boolean;
    disconnected: boolean;
    triggerEnded: () => void;
  }> = [];
  let resumeCalls = 0;
  let closeCalls = 0;

  class MockAudioContext {
    state = "suspended";
    currentTime = 1.0;
    destination = {};

    async resume(): Promise<void> {
      resumeCalls += 1;
      this.state = "running";
    }

    async close(): Promise<void> {
      closeCalls += 1;
      this.state = "closed";
    }

    createBuffer(channels: number, length: number, sampleRate: number) {
      assert.equal(channels, 1);
      const data = new Float32Array(length);
      return {
        length,
        sampleRate,
        duration: length / sampleRate,
        getChannelData(ch: number) {
          assert.equal(ch, 0);
          return data;
        }
      };
    }

    createBufferSource() {
      const record = {
        startAt: -1,
        duration: 0,
        sampleRate: 0,
        stopped: false,
        disconnected: false,
        triggerEnded: () => {}
      };
      const node = {
        buffer: null as { duration: number; sampleRate: number } | null,
        onended: null as (() => void) | null,
        connect() {},
        disconnect() {
          record.disconnected = true;
        },
        start(when = 0) {
          record.startAt = when;
          record.duration = node.buffer?.duration ?? 0;
          record.sampleRate = node.buffer?.sampleRate ?? 0;
        },
        stop() {
          record.stopped = true;
        }
      };
      record.triggerEnded = () => {
        node.onended?.();
      };
      scheduled.push(record);
      return node;
    }
  }

  g.AudioContext = MockAudioContext;
  delete g.window;

  try {
    const player = new PcmPlayer();
    assert.equal(player.playing, false);

    await player.resume();
    assert.equal(resumeCalls, 1);

    const chunk100ms = pcm16ToBase64(float32ToPcm16(generateSine(440, 24000, 0.1, 0.5)));
    player.enqueue(chunk100ms);
    player.enqueue(chunk100ms);
    player.enqueue(chunk100ms);

    assert.equal(player.playing, true);
    assert.equal(scheduled.length, 3);
    assert.equal(scheduled[0].sampleRate, 24000);
    assert.ok(Math.abs(scheduled[0].startAt - 1.02) < 1e-6);
    assert.ok(Math.abs(scheduled[1].startAt - 1.12) < 1e-6);
    assert.ok(Math.abs(scheduled[2].startAt - 1.22) < 1e-6);

    player.flush();
    assert.equal(player.playing, false);
    assert.ok(scheduled.every((s) => s.stopped && s.disconnected));

    player.enqueue(chunk100ms);
    assert.equal(scheduled.length, 4);
    assert.ok(Math.abs(scheduled[3].startAt - 1.02) < 1e-6);
    assert.equal(player.playing, true);

    scheduled[3].triggerEnded();
    assert.equal(player.playing, false);

    player.dispose();
    assert.equal(closeCalls, 1);
    player.enqueue(chunk100ms);
    assert.equal(scheduled.length, 4);
  } finally {
    delete g.AudioContext;
    if (prevAudioCtx !== undefined) g.AudioContext = prevAudioCtx;
    if (prevWindow !== undefined) g.window = prevWindow;
  }
});

test("MicCapture captures 16 kHz ~100 ms chunks via AudioWorklet and falls back to ScriptProcessorNode", async () => {
  const g = globalThis as Record<string, unknown>;
  const prevAudioCtx = g.AudioContext;
  const prevWorkletNode = g.AudioWorkletNode;
  const prevNavDesc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const prevCreateUrl = URL.createObjectURL;
  const prevRevokeUrl = URL.revokeObjectURL;

  const requestedConstraints: MediaStreamConstraints[] = [];
  let tracksStopped = 0;
  let createdBlobUrls = 0;
  let revokedBlobUrls = 0;
  let failWorklet = false;
  let scriptProcessorCreated = false;
  let latestWorkletOnMessage: ((ev: { data: unknown }) => void) | null = null;
  let latestScriptProcess: ((ev: { inputBuffer: { numberOfChannels: number; getChannelData(ch: number): Float32Array } }) => void) | null = null;
  let closedContexts = 0;

  URL.createObjectURL = () => {
    createdBlobUrls += 1;
    return "blob:holdup-worklet-test";
  };
  URL.revokeObjectURL = () => {
    revokedBlobUrls += 1;
  };

  class MockWorkletNode {
    port = {
      onmessage: null as ((ev: { data: unknown }) => void) | null
    };
    constructor() {
      queueMicrotask(() => {
        latestWorkletOnMessage = this.port.onmessage;
      });
    }
    connect() {
      latestWorkletOnMessage = this.port.onmessage;
    }
    disconnect() {}
  }

  class MockCaptureAudioContext {
    state = "running";
    sampleRate = 48000;
    destination = {};
    audioWorklet = {
      async addModule(): Promise<void> {
        if (failWorklet) {
          throw new Error("AudioWorklet blocked by CSP");
        }
      }
    };

    createMediaStreamSource() {
      return {
        connect() {},
        disconnect() {}
      };
    }

    createGain() {
      return {
        gain: { value: 1 },
        connect() {},
        disconnect() {}
      };
    }

    createScriptProcessor() {
      scriptProcessorCreated = true;
      const node = {
        onaudioprocess: null as typeof latestScriptProcess,
        connect() {
          latestScriptProcess = node.onaudioprocess;
        },
        disconnect() {}
      };
      return node;
    }

    async close(): Promise<void> {
      closedContexts += 1;
      this.state = "closed";
    }
  }

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: {
      mediaDevices: {
        async getUserMedia(constraints: MediaStreamConstraints) {
          requestedConstraints.push(constraints);
          return {
            getTracks() {
              return [
                {
                  stop() {
                    tracksStopped += 1;
                  }
                }
              ];
            }
          };
        }
      }
    }
  });
  g.AudioContext = MockCaptureAudioContext;
  g.AudioWorkletNode = MockWorkletNode;

  try {
    const mic = new MicCapture();
    assert.equal(mic.active, false);

    const chunks: string[] = [];
    const levels: number[] = [];
    await mic.start({
      deviceId: "glasses-bt-hfp",
      onChunk: (b64) => chunks.push(b64),
      onLevel: (rms) => levels.push(rms)
    });

    assert.equal(mic.active, true);
    assert.equal(createdBlobUrls, 1);
    assert.equal(revokedBlobUrls, 1);
    assert.equal(scriptProcessorCreated, false);
    assert.deepEqual(requestedConstraints[0], {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        deviceId: { exact: "glasses-bt-hfp" }
      }
    });

    const onWorkletMessage = latestWorkletOnMessage as ((ev: { data: unknown }) => void) | null;
    assert.ok(onWorkletMessage !== null);
    const fullSine48k = generateSine(440, 48000, 0.12, 0.5);
    for (let offset = 0; offset + 128 <= fullSine48k.length; offset += 128) {
      onWorkletMessage({ data: fullSine48k.slice(offset, offset + 128) });
    }

    assert.equal(chunks.length, 1);
    const decoded16k = base64ToPcm16(chunks[0]);
    assert.equal(decoded16k.length, 1600);
    assert.ok(levels.length >= 1);
    assert.ok(levels.every((lvl) => lvl >= 0 && lvl <= 1));

    mic.stop();
    assert.equal(mic.active, false);
    assert.equal(tracksStopped, 1);
    assert.equal(closedContexts, 1);

    failWorklet = true;
    const fallbackChunks: string[] = [];
    await mic.start({
      onChunk: (b64) => fallbackChunks.push(b64)
    });

    assert.equal(scriptProcessorCreated, true);
    assert.deepEqual(requestedConstraints[1], {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    const onScriptProcess = latestScriptProcess as ((ev: {
      inputBuffer: { numberOfChannels: number; getChannelData(ch: number): Float32Array };
    }) => void) | null;
    assert.ok(onScriptProcess !== null);

    const frame2048 = generateSine(440, 48000, 2048 / 48000, 0.4);
    for (let k = 0; k < 3; k += 1) {
      onScriptProcess({
        inputBuffer: {
          numberOfChannels: 1,
          getChannelData: () => frame2048
        }
      });
    }

    assert.equal(fallbackChunks.length, 1);
    assert.equal(base64ToPcm16(fallbackChunks[0]).length, 1600);

    mic.stop();
    assert.equal(tracksStopped, 2);
    assert.equal(closedContexts, 2);
  } finally {
    URL.createObjectURL = prevCreateUrl;
    URL.revokeObjectURL = prevRevokeUrl;
    delete g.AudioContext;
    delete g.AudioWorkletNode;
    if (prevAudioCtx !== undefined) g.AudioContext = prevAudioCtx;
    if (prevWorkletNode !== undefined) g.AudioWorkletNode = prevWorkletNode;
    if (prevNavDesc) {
      Object.defineProperty(globalThis, "navigator", prevNavDesc);
    } else {
      delete g.navigator;
    }
  }
});

test("createLiveAudioBridge is safe in headless Node without window, AudioContext, or navigator", async () => {
  const g = globalThis as Record<string, unknown>;
  const prevWindow = g.window;
  const prevAudioCtx = g.AudioContext;
  const prevWebkitAudioCtx = g.webkitAudioContext;
  const prevNavDesc = Object.getOwnPropertyDescriptor(globalThis, "navigator");

  delete g.window;
  delete g.AudioContext;
  delete g.webkitAudioContext;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: undefined
  });

  try {
    const bridge = createLiveAudioBridge({ onMicLevel: () => {} });
    const sampleB64 = pcm16ToBase64(new Int16Array([0, 1200, -1200, 0]));

    assert.doesNotThrow(() => bridge.enqueuePcm24k?.(sampleB64));
    assert.doesNotThrow(() => bridge.flushPlayback?.());
    await assert.doesNotReject(async () => {
      await bridge.resumePlayback?.();
    });
    assert.doesNotThrow(() => bridge.stopMic?.());

    let caughtErr: unknown = null;
    try {
      await bridge.startMic?.(() => {});
    } catch (err) {
      caughtErr = err;
    }
    assert.ok(caughtErr !== null);
    assert.equal(classifyMediaError(caughtErr).status, "unavailable");

    assert.doesNotThrow(() => bridge.dispose());
    await assert.doesNotReject(async () => {
      await bridge.startMic?.(() => {});
      await bridge.resumePlayback?.();
    });
    assert.doesNotThrow(() => {
      bridge.enqueuePcm24k?.(sampleB64);
      bridge.flushPlayback?.();
      bridge.stopMic?.();
      bridge.dispose();
    });
  } finally {
    if (prevWindow !== undefined) g.window = prevWindow;
    if (prevAudioCtx !== undefined) g.AudioContext = prevAudioCtx;
    if (prevWebkitAudioCtx !== undefined) g.webkitAudioContext = prevWebkitAudioCtx;
    if (prevNavDesc) {
      Object.defineProperty(globalThis, "navigator", prevNavDesc);
    } else {
      delete g.navigator;
    }
  }
});
