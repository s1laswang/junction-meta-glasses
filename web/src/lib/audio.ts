// Mic capture (PCM16 mono 16 kHz, ~100 ms base64 chunks) and gapless PCM16 24 kHz playback.

export function bytesToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH) as unknown as number[]);
  return btoa(bin);
}
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

type AC = typeof AudioContext;
const AudioCtx: AC | undefined = typeof window !== "undefined" ? window.AudioContext ?? (window as unknown as { webkitAudioContext?: AC }).webkitAudioContext : undefined;

export class MicCapture {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private src: MediaStreamAudioSourceNode | null = null;
  stream: MediaStream | null = null;
  level = 0;
  chunks = 0;

  constructor(private onChunk: (b64: string, rms: number) => void) {}

  get active() {
    return !!this.node && !!this.stream?.getAudioTracks().some((t) => t.readyState === "live");
  }
  get label() {
    return this.stream?.getAudioTracks()[0]?.label ?? "";
  }

  private moduleLoaded = false;

  /** Create/resume the capture context synchronously inside a user gesture (iOS Safari needs this). */
  prime() {
    if (!AudioCtx) return;
    if (!this.ctx || this.ctx.state === "closed") {
      this.ctx = new AudioCtx();
      this.moduleLoaded = false;
    }
    if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => {});
  }

  async start(stream: MediaStream) {
    await this.stop(true);
    if (!AudioCtx) throw new Error("Web Audio is not available in this browser");
    this.stream = stream;
    this.prime();
    if (!this.ctx) throw new Error("Web Audio is not available in this browser");
    if (!this.moduleLoaded) {
      await this.ctx.audioWorklet.addModule("/pcm-capture-worklet.js");
      this.moduleLoaded = true;
    }
    this.src = this.ctx.createMediaStreamSource(stream);
    this.node = new AudioWorkletNode(this.ctx, "pcm-capture", { processorOptions: { outRate: 16000, chunkMs: 100 } });
    this.node.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => {
      this.level = e.data.rms;
      this.chunks++;
      this.onChunk(bytesToBase64(e.data.pcm), e.data.rms);
    };
    this.src.connect(this.node);
    // the worklet has no output we want to hear; keep it pulled without routing mic to speakers
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    this.node.connect(sink).connect(this.ctx.destination);
    if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => {});
  }

  /** keepContext: reuse the AudioContext for a quick mic swap (no user gesture needed). */
  async stop(keepContext = false) {
    try {
      this.src?.disconnect();
      this.node?.disconnect();
      this.node?.port.close();
    } catch {
      /* ignore */
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.node = null;
    this.src = null;
    this.level = 0;
    if (keepContext) return;
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx && ctx.state !== "closed") await ctx.close().catch(() => {});
  }
}

/** Gapless queue of PCM16 mono chunks. flush() drops everything queued (barge-in). */
export class PcmPlayer {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private nextTime = 0;
  private sources = new Set<AudioBufferSourceNode>();
  onPlayingChange?: (playing: boolean) => void;
  private wasPlaying = false;

  constructor(private rate = 24000) {}

  /** Must be called from a user gesture on iOS. */
  async unlock() {
    if (!AudioCtx) return;
    if (!this.ctx) {
      this.ctx = new AudioCtx();
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => {});
  }

  get context() {
    return this.ctx;
  }
  get playing() {
    return this.sources.size > 0;
  }

  enqueue(b64: string) {
    if (!this.ctx || !this.gain) return;
    const bytes = base64ToBytes(b64);
    const samples = Math.floor(bytes.byteLength / 2);
    if (!samples) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, samples * 2);
    const buf = this.ctx.createBuffer(1, samples, this.rate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < samples; i++) ch[i] = view.getInt16(i * 2, true) / 0x8000;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);
    const now = this.ctx.currentTime;
    // small lead on the first chunk absorbs jitter; afterwards chunks butt together exactly
    if (this.nextTime < now + 0.02) this.nextTime = now + 0.06;
    src.start(this.nextTime);
    this.nextTime += buf.duration;
    this.sources.add(src);
    src.onended = () => {
      this.sources.delete(src);
      this.emit();
    };
    this.emit();
  }

  flush() {
    for (const s of this.sources) {
      try {
        s.onended = null;
        s.stop();
        s.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.sources.clear();
    this.nextTime = 0;
    this.emit();
  }

  private emit() {
    const p = this.playing;
    if (p !== this.wasPlaying) {
      this.wasPlaying = p;
      this.onPlayingChange?.(p);
    }
  }

  async close() {
    this.flush();
    const ctx = this.ctx;
    this.ctx = null;
    this.gain = null;
    if (ctx && ctx.state !== "closed") await ctx.close().catch(() => {});
  }
}

/** Synthesised PCM16 24 kHz test chunks (used by the mock server to exercise the playback path). */
export function synthPcmChunks(freqs: number[], msEach = 180, rate = 24000): string[] {
  const out: string[] = [];
  for (const f of freqs) {
    const n = Math.round((rate * msEach) / 1000);
    const pcm = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      const env = Math.min(1, i / 400, (n - i) / 400);
      pcm[i] = Math.round(Math.sin((2 * Math.PI * f * i) / rate) * env * 0.18 * 0x7fff);
    }
    out.push(bytesToBase64(pcm.buffer));
  }
  return out;
}
