// Readiness sonar: a soft, continuous sine whose pitch rises with label readiness (0..1 -> ~220..660 Hz),
// plus a gentle tick once the label is nearly readable (>= 0.8). Ducks under assistant speech, fades
// out when readiness stops arriving. Deliberately low and round: never shrill.

const MIN_HZ = 220;
const MAX_HZ = 660;
const IDLE_MS = 1500;
const TICK_MS = 700;

export class Sonar {
  private ctx: AudioContext | null = null;
  private osc: OscillatorNode | null = null;
  private gain: GainNode | null = null;
  private lp: BiquadFilterNode | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private ducked = false;
  private value = 0;
  volume = 0.35;

  /** Create/resume the context inside a user gesture (iOS). */
  unlock() {
    try {
      if (!this.ctx || this.ctx.state === "closed") this.ctx = new (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => {});
    } catch {
      this.ctx = null;
    }
  }

  private level() {
    // peak gain stays low (max ~0.09) and drops to a quarter while the assistant talks
    return Math.max(0, Math.min(1, this.volume)) * 0.09 * (this.ducked ? 0.25 : 1);
  }

  private ensure() {
    if (!this.ctx) return false;
    if (this.osc) return true;
    const c = this.ctx;
    this.osc = c.createOscillator();
    this.osc.type = "sine";
    this.osc.frequency.value = MIN_HZ;
    this.lp = c.createBiquadFilter();
    this.lp.type = "lowpass";
    this.lp.frequency.value = 1200;
    this.gain = c.createGain();
    this.gain.gain.value = 0;
    this.osc.connect(this.lp).connect(this.gain).connect(c.destination);
    this.osc.start();
    return true;
  }

  /** New readiness value 0..1. */
  set(v: number) {
    if (!this.ensure() || !this.ctx || !this.osc || !this.gain) return;
    this.value = Math.max(0, Math.min(1, v));
    const t = this.ctx.currentTime;
    this.osc.frequency.setTargetAtTime(MIN_HZ + this.value * (MAX_HZ - MIN_HZ), t, 0.12);
    this.gain.gain.setTargetAtTime(this.level(), t, 0.15);
    if (this.value >= 0.8 && !this.tickTimer) this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    if (this.value < 0.8 && this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), IDLE_MS);
  }

  private tick() {
    const c = this.ctx;
    if (!c || this.ducked) return;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = "triangle";
    o.frequency.value = 990;
    const t = c.currentTime;
    const peak = Math.max(0, Math.min(1, this.volume)) * 0.08;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    o.connect(g).connect(c.destination);
    o.start(t);
    o.stop(t + 0.09);
  }

  duck(on: boolean) {
    this.ducked = on;
    if (this.gain && this.ctx && this.osc) this.gain.gain.setTargetAtTime(this.level(), this.ctx.currentTime, 0.08);
  }

  get active() {
    return !!this.osc;
  }

  /** Fade out and release the oscillator (idle, verdict, stop). */
  stop() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.idleTimer = this.tickTimer = null;
    const osc = this.osc;
    const gain = this.gain;
    this.osc = null;
    this.gain = null;
    this.lp = null;
    if (!osc || !gain || !this.ctx) return;
    const t = this.ctx.currentTime;
    gain.gain.cancelScheduledValues(t);
    gain.gain.setTargetAtTime(0, t, 0.08);
    try {
      osc.stop(t + 0.5);
    } catch {
      /* ignore */
    }
  }
}
