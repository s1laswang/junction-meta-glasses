// AudioWorklet: mono mic input at the context rate -> PCM16 16 kHz, posted in ~100 ms chunks.
// Plain JS in /public so it is served as-is and cached by the service worker.
class PcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.outRate = o.outRate || 16000;
    this.chunk = Math.round(this.outRate * ((o.chunkMs || 100) / 1000)); // samples per post
    this.ratio = sampleRate / this.outRate; // input samples per output sample
    this.pos = 0; // fractional read position into the carried-over input
    this.carry = new Float32Array(0);
    this.out = new Int16Array(this.chunk);
    this.outLen = 0;
    this.sumSq = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) return true;
    // downmix to mono
    const n = input[0].length;
    const mono = new Float32Array(this.carry.length + n);
    mono.set(this.carry, 0);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let c = 0; c < input.length; c++) s += input[c][i];
      mono[this.carry.length + i] = s / input.length;
    }
    // linear-interpolation resample (with a cheap box pre-filter when downsampling a lot)
    let pos = this.pos;
    const step = this.ratio;
    while (pos + 1 < mono.length) {
      const i = Math.floor(pos);
      const f = pos - i;
      let v = mono[i] * (1 - f) + mono[i + 1] * f;
      if (step >= 2) {
        // average the window this output sample covers to reduce aliasing
        const end = Math.min(mono.length, i + Math.floor(step));
        let acc = 0;
        let cnt = 0;
        for (let k = i; k < end; k++) { acc += mono[k]; cnt++; }
        if (cnt) v = acc / cnt;
      }
      const clamped = Math.max(-1, Math.min(1, v));
      this.sumSq += clamped * clamped;
      this.out[this.outLen++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      if (this.outLen === this.chunk) {
        const rms = Math.sqrt(this.sumSq / this.chunk);
        this.port.postMessage({ pcm: this.out.buffer, rms }, [this.out.buffer]);
        this.out = new Int16Array(this.chunk);
        this.outLen = 0;
        this.sumSq = 0;
      }
      pos += step;
    }
    const keepFrom = Math.floor(pos);
    this.carry = mono.slice(keepFrom);
    this.pos = pos - keepFrom;
    return true;
  }
}
registerProcessor("pcm-capture", PcmCapture);
