// The check session controller: owns camera, mic, playback, the /live socket, snapshot and offline
// fallbacks, and device-state reactions. React subscribes through useSyncExternalStore.
import type { CoachCue, DeviceState, FeatureFlag, Gs1Code, LiveState, Profile, ServerMsg, Verdict } from "../../../shared/types.ts";
import { MicCapture, PcmPlayer } from "./audio.ts";
import { verify, health } from "./api.ts";
import { barcodeSupported, detectBarcode, detectCodes } from "./barcode.ts";
import { parseGs1 } from "./gs1.ts";
import { announce, earcon, earconForVerdict, haptic, primeSpeech, speak, stopSpeaking } from "./feedback.ts";
import { captureFrame, FrameRing, policyForRtt, shouldSend, type CapturedFrame, type FramePolicy } from "./frames.ts";
import { LiveClient, type ConnState } from "./live.ts";
import { audioRoute, classifyError, explain, getCamera, getMic, type PermState } from "./media.ts";
import { IS_MOCK, mockCtl, mockHudChannel } from "./mock.ts";
import { loadProfile, loadSettings, logDose, saveSettings, sessionCode } from "./storage.ts";
import { AuthError } from "./key.ts";
import { findByBarcode, findByGtin, matchVerdict, offlineUnknownBarcode, offlineUnknownCode } from "./verdicts.ts";

export type Mode = "live" | "snapshot" | "offline";
export type Caption = { id: number; role: "user" | "assistant" | "system"; text: string; final: boolean };
export type Banner = { tone: "info" | "warn" | "bad" | "good"; title: string; detail?: string; action?: "retry" | "settings" | "snapshot" } | null;

export type CheckState = {
  running: boolean;
  mode: Mode;
  conn: ConnState;
  connAttempt: number;
  nextRetryMs: number | null;
  serverLive: LiveState | null;
  serverDetail: string;
  model: string | null;
  session: string;
  online: boolean;
  health: "unknown" | "ok" | "down" | "unreachable";
  rtt: number | null;
  policy: FramePolicy;
  fps: number;
  framesSent: number;
  camera: "off" | "starting" | "on" | "paused" | "error";
  cameraPerm: PermState;
  cameraMsg: string;
  mic: "off" | "starting" | "on" | "error";
  micPerm: PermState;
  micMsg: string;
  micLabel: string;
  micLevel: number;
  route: string;
  source: "phone" | "glasses";
  device: DeviceState | null;
  captions: Caption[];
  cue: { cue: CoachCue; text: string; ts: number } | null;
  verdict: Verdict | null;
  verdictVia: Mode | null;
  autoStopAt: number | null;
  snapshotBusy: boolean;
  checking: boolean;
  hudConnected: boolean | null;
  authNeeded: boolean;
  speaking: boolean;
  sharpness: number;
  /** features the server reported in ready (null = not told yet / older server) */
  serverFeatures: FeatureFlag[] | null;
  /** last GS1 pack code decoded on the phone */
  lastCode: Gs1Code | null;
  banner: Banner;
  lastError: string | null;
  hidden: boolean;
};

const AUTO_STOP_MS = 45_000;
const MAX_CAPTIONS = 40;

function initial(): CheckState {
  const s = loadSettings();
  return {
    running: false,
    mode: navigator.onLine ? "live" : "offline",
    conn: "idle",
    connAttempt: 0,
    nextRetryMs: null,
    serverLive: null,
    serverDetail: "",
    model: null,
    session: sessionCode(),
    online: navigator.onLine,
    health: "unknown",
    rtt: null,
    policy: policyForRtt(null),
    fps: 0,
    framesSent: 0,
    camera: "off",
    cameraPerm: "unknown",
    cameraMsg: "",
    mic: "off",
    micPerm: "unknown",
    micMsg: "",
    micLabel: "",
    micLevel: 0,
    route: "",
    source: s.source,
    device: null,
    captions: [],
    cue: null,
    verdict: null,
    verdictVia: null,
    autoStopAt: null,
    snapshotBusy: false,
    checking: false,
    hudConnected: null,
    authNeeded: false,
    speaking: false,
    sharpness: 0,
    serverFeatures: null,
    lastCode: null,
    banner: null,
    lastError: null,
    hidden: document.visibilityState === "hidden",
  };
}

export class Checker {
  private s: CheckState = initial();
  private subs = new Set<() => void>();
  private live: LiveClient | null = null;
  private mic: MicCapture;
  private player = new PcmPlayer(24000);
  private cam: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private ring = new FrameRing(8);
  private lastSent: CapturedFrame | null = null;
  private sentTimes: number[] = [];
  private frameTimer: ReturnType<typeof setTimeout> | null = null;
  private barcodeTimer: ReturnType<typeof setInterval> | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private autoStopTimer: ReturnType<typeof setTimeout> | null = null;
  private healthFails = 0;
  private captionId = 0;
  private lastBarcode = "";
  private lastBarcodeAt = 0;
  private silentAudio: HTMLAudioElement | null = null;
  private routeKey = "";
  private pendingText: string | null = null;
  onProfileChange?: (p: Profile) => void;

  constructor() {
    this.mic = new MicCapture((b64, rms) => {
      this.s.micLevel = rms; // no re-render for every chunk
      if (this.s.mode === "live" && this.live?.isOpen) this.live.send({ type: "audio", data: b64 });
    });
    this.player.onPlayingChange = (p) => {
      this.set({ speaking: p });
      if (p) this.armAutoStop();
    };
    window.addEventListener("online", this.onOnline);
    window.addEventListener("offline", this.onOffline);
    document.addEventListener("visibilitychange", this.onVisibility);
    navigator.mediaDevices?.addEventListener?.("devicechange", this.onDeviceChange);
    if (IS_MOCK) {
      const ch = mockHudChannel();
      if (ch) ch.onmessage = (e: MessageEvent<{ type?: string; name?: string }>) => e.data?.type === "hud_event" && this.onHudEvent(e.data.name ?? "");
    }
    void this.checkHealth();
    this.healthTimer = setInterval(() => void this.checkHealth(), 10_000);
    void audioRoute().then((r) => {
      this.routeKey = r.input + "|" + r.output;
      this.set({ route: r.output || r.input });
    });
  }

  // ---- store plumbing ----
  subscribe = (fn: () => void) => {
    this.subs.add(fn);
    return () => void this.subs.delete(fn);
  };
  get = () => this.s;
  private set(p: Partial<CheckState>) {
    this.s = { ...this.s, ...p };
    for (const f of this.subs) f();
  }

  attachVideo(el: HTMLVideoElement | null) {
    this.video = el;
    if (el && this.cam && el.srcObject !== this.cam) {
      el.srcObject = this.cam;
      void el.play().catch(() => {});
    }
  }

  // ---- lifecycle ----
  async start() {
    if (this.s.running) return;
    // everything that needs the user gesture happens before the first await (iOS Safari)
    stopSpeaking();
    primeSpeech();
    this.mic.prime();
    const unlocked = this.player.unlock();
    this.enableMediaSession();
    earcon.start();
    haptic.start();
    this.set({ running: true, mode: "live", captions: [], cue: null, verdict: null, verdictVia: null, banner: null, lastError: null, framesSent: 0 });
    if (!navigator.onLine) this.setMode("offline", "You're offline. I can recognise your saved medicines by barcode, but I can't read new labels.");
    await unlocked;
    this.armAutoStop();
    announce("Check started. Camera and microphone on. Hold the item up in front of you.", "assertive");

    await Promise.all([this.source === "phone" ? this.startCamera() : Promise.resolve(), this.startMic()]);
    if (!this.s.running) return; // stopped while waiting for permission

    this.live = new LiveClient({
      session: this.s.session,
      mock: IS_MOCK,
      buildStart: () => ({ type: "start", profile: loadProfile(), lang: loadProfile().lang || "en", voice: loadSettings().voice, source: this.source, features: localFeatures() }),
      onMessage: (m) => this.onServer(m),
      onState: (st, info) => this.onConn(st, info),
      onRtt: (rtt) => {
        const policy = policyForRtt(rtt);
        if (policy.tier !== this.s.policy.tier) announce(policy.tier === "normal" ? "Connection is fast again." : "Slow connection. Sending fewer pictures to keep up.");
        this.set({ rtt, policy });
      },
    });
    if (this.s.mode !== "offline") this.live.start();
    this.loopFrames();
    this.startBarcodeScan(); // offline barcodes + online pack codes (DataMatrix)
  }

  async stop(reason = "Check stopped. Camera and microphone off.") {
    if (!this.s.running) return;
    this.live?.stop();
    this.live = null;
    this.stopFrames();
    this.stopBarcodeScan();
    this.stopCamera();
    await this.mic.stop();
    this.player.flush();
    if (this.autoStopTimer) clearTimeout(this.autoStopTimer);
    this.autoStopTimer = null;
    this.ring.clear();
    this.lastSent = null;
    this.silentAudio?.pause();
    try {
      if (navigator.mediaSession) navigator.mediaSession.playbackState = "paused";
    } catch {
      /* ignore */
    }
    earcon.stop();
    haptic.stop();
    this.set({ running: false, checking: false, camera: "off", mic: "off", conn: "idle", autoStopAt: null, cue: null, fps: 0, speaking: false, micLevel: 0, serverLive: null, banner: null });
    announce(reason, "assertive");
  }

  toggle() {
    if (this.s.running) void this.stop();
    else void this.start();
  }

  /** The big button / Space / glasses tap: the most useful action for the current mode. */
  primary() {
    if (!this.s.running) return void this.start();
    if (this.s.mode === "snapshot") return void this.snapshot();
    void this.stop();
  }

  get source() {
    return this.s.source;
  }

  // ---- camera ----
  private async startCamera() {
    this.set({ camera: "starting" });
    try {
      const stream = await getCamera();
      if (!this.s.running) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      this.cam = stream;
      stream.getVideoTracks()[0]?.addEventListener("ended", () => {
        if (this.s.running && !this.s.hidden) {
          this.set({ camera: "error", cameraMsg: "The camera stopped. Another app may have taken it." });
          announce("The camera stopped.", "assertive");
        }
      });
      if (this.video) {
        this.video.srcObject = stream;
        await this.video.play().catch(() => {});
      }
      this.set({ camera: "on", cameraPerm: "granted", cameraMsg: "" });
    } catch (e) {
      const perm = classifyError(e);
      this.set({ camera: "error", cameraPerm: perm, cameraMsg: explain("camera", perm) });
      this.set({ banner: { tone: "warn", title: "Camera not available", detail: explain("camera", perm) + " You can still ask by voice or text, or take a photo with the snapshot button.", action: perm === "denied" || perm === "blocked" ? "settings" : "snapshot" } });
      announce("Camera not available. " + explain("camera", perm), "assertive");
    }
  }
  private stopCamera() {
    this.cam?.getTracks().forEach((t) => t.stop());
    this.cam = null;
    if (this.video) this.video.srcObject = null;
  }

  // ---- mic ----
  private async startMic() {
    this.set({ mic: "starting" });
    try {
      const stream = await getMic();
      if (!this.s.running) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      await this.mic.start(stream);
      stream.getAudioTracks()[0]?.addEventListener("ended", () => {
        if (this.s.running) void this.restartMic("Microphone disconnected.");
      });
      this.set({ mic: "on", micPerm: "granted", micMsg: "", micLabel: this.mic.label });
    } catch (e) {
      const perm = classifyError(e);
      this.set({ mic: "error", micPerm: perm, micMsg: explain("mic", perm) });
      if (this.s.camera === "error")
        this.set({ banner: { tone: "warn", title: "Camera and microphone not available", detail: "Type your question below, or take a photo with your camera app. Answers are still read out.", action: perm === "denied" || perm === "blocked" ? "settings" : "snapshot" } });
      else
        this.set({ banner: { tone: "warn", title: "Microphone not available", detail: explain("mic", perm) + " Type your question below instead. Answers are still spoken.", action: perm === "denied" || perm === "blocked" ? "settings" : undefined } });
      announce("Microphone not available. You can type your question instead.", "assertive");
    }
  }
  private async restartMic(why: string) {
    announce(why + " Switching microphone.");
    await this.mic.stop(true);
    await this.startMic();
  }

  // ---- frames ----
  private loopFrames() {
    this.stopFrames();
    const tick = () => {
      if (!this.s.running) return;
      const pol = this.s.policy;
      if (this.source === "phone" && this.s.camera === "on" && this.video && !this.s.hidden) {
        const f = captureFrame(this.video, pol.longSide, pol.quality);
        if (f) {
          this.ring.push(f);
          const p: Partial<CheckState> = { sharpness: f.sharpness };
          if (this.s.mode === "live" && this.live?.isOpen && !this.live.congested && shouldSend(f, this.lastSent)) {
            if (this.live.send({ type: "frame", data: f.data, w: f.w, h: f.h, sharpness: Math.round(f.sharpness * 1000) / 1000, ts: f.ts })) {
              this.lastSent = f;
              const now = Date.now();
              this.sentTimes = [...this.sentTimes.filter((t) => now - t < 10_000), now];
              p.framesSent = this.s.framesSent + 1;
            }
          }
          const now = Date.now();
          this.sentTimes = this.sentTimes.filter((t) => now - t < 10_000);
          p.fps = Math.round((this.sentTimes.length / 10) * 10) / 10;
          p.micLevel = this.mic.level;
          this.set(p);
        }
      } else if (this.s.fps !== 0 && this.source === "glasses") {
        this.set({ fps: 0, micLevel: this.mic.level });
      }
      this.frameTimer = setTimeout(tick, Math.round(1000 / this.s.policy.fps));
    };
    this.frameTimer = setTimeout(tick, 400);
  }
  private stopFrames() {
    if (this.frameTimer) clearTimeout(this.frameTimer);
    this.frameTimer = null;
  }

  // ---- source switch ----
  async setSource(src: "phone" | "glasses", why?: string) {
    if (src === this.s.source) return;
    saveSettings({ ...loadSettings(), source: src });
    this.set({ source: src });
    if (this.live?.isOpen) this.live.send({ type: "source", source: src });
    if (src === "glasses") {
      this.stopCamera();
      this.set({ camera: "off", sharpness: 0 });
      announce(why ?? "Using the glasses camera. The phone camera is off.", "assertive");
    } else {
      announce(why ?? "Using the phone camera.", "assertive");
      if (this.s.running) await this.startCamera();
    }
  }

  // ---- server messages ----
  private onServer(m: ServerMsg) {
    switch (m.type) {
      case "ready":
        this.set({ model: m.model, session: m.session || this.s.session, serverFeatures: m.features ?? null });
        break;
      case "audio":
        if (loadSettings().voice) this.player.enqueue(m.data);
        break;
      case "transcript":
        if (m.role === "user" && m.text.trim()) {
          // barge-in: the user is talking, stop the assistant mid-sentence
          this.player.flush();
          stopSpeaking();
          this.armAutoStop();
        }
        // the assistant is still talking: don't auto-stop mid-answer (QA #11)
        if (m.role === "assistant") this.armAutoStop();
        this.addCaption(m.role, m.text, m.final);
        break;
      case "coach":
        this.set({ cue: { cue: m.cue, text: m.text, ts: Date.now() } });
        if (m.cue === "ok") earcon.ok();
        else earcon.coach();
        haptic.coach(m.cue);
        // with spoken answers off, the screen reader is the only voice: read the cue
        if (!loadSettings().voice) announce(m.text);
        this.armAutoStop();
        break;
      case "verdict":
        this.showVerdict(m.verdict, "live");
        break;
      case "status":
        this.onServerStatus(m.live, m.detail ?? "");
        break;
      case "device":
        this.onDevice(m.device);
        break;
      case "error":
        this.set({ lastError: `${m.code}: ${m.message}` });
        if (!m.recoverable) {
          this.set({ banner: { tone: "bad", title: friendlyError(m.code), detail: m.message + " Switched to snapshot mode.", action: "snapshot" } });
          this.setMode("snapshot", "The live assistant had a problem. Switched to snapshot mode.");
        } else {
          announce(friendlyError(m.code));
        }
        break;
      case "interrupted":
        this.player.flush();
        break;
      case "checking":
        if (m.phase === "start") {
          this.set({ checking: true, cue: null });
          earcon.checking();
          announce("Checking…");
        } else this.set({ checking: false });
        break;
      case "hud":
        if (m.connected !== this.s.hudConnected) announce(m.connected ? "Display connected." : "Display disconnected.");
        this.set({ hudConnected: m.connected });
        break;
      case "hud_event":
        this.onHudEvent(m.name);
        break;
      case "dose_logged": {
        // the user logged a dose by voice (Gemini log_dose tool): mirror it into the on-device log, no echo
        const p = logDose(loadProfile(), m.medId);
        this.onProfileChange?.(p);
        const v = this.s.verdict;
        if (v?.matchedMedId === m.medId) this.set({ verdict: { ...v, takenToday: true } });
        earcon.ok();
        break;
      }
    }
  }

  private onServerStatus(live: LiveState, detail: string) {
    this.set({ serverLive: live, serverDetail: detail });
    if (live === "closed" && /auto-stop/i.test(detail)) {
      speak("No label for 45 seconds. I've turned the camera off.");
      void this.stop("Stopped automatically after 45 seconds without a label. Camera off.");
      return;
    }
    if (live === "degraded" || live === "closed") {
      this.setMode("snapshot", `Live assistant unavailable${detail ? ": " + detail : ""}. Switched to snapshot mode.`);
    } else if (live === "reconnecting") {
      this.set({ banner: { tone: "warn", title: "Reconnecting to Gemini", detail } });
      announce("Reconnecting to the assistant.");
    } else if (live === "open" && this.s.mode === "snapshot" && this.live?.isOpen) {
      this.setMode("live", "Live assistant is back.");
    }
  }

  private onDevice(d: DeviceState) {
    const prev = this.s.device;
    this.set({ device: d });
    // worn/battery can be null (unknown): only a definite false means the glasses camera is unusable
    const unusable = d.connected === false || d.worn === false;
    if (this.s.source === "glasses" && unusable) {
      const why = d.connected === false ? "Glasses disconnected." : "Glasses taken off.";
      void this.setSource("phone", `${why} Switched to the phone camera.`);
      earcon.alert();
    } else if (prev && prev.connected !== d.connected) {
      announce(d.connected ? "Glasses connected." : "Glasses disconnected.");
    }
    if (d.battery != null && d.battery <= 15 && (prev?.battery ?? 100) > 15) announce(`Glasses battery low: ${d.battery} percent.`, "assertive");
  }

  private onConn(st: ConnState, info: { attempt: number; nextRetryMs: number | null; reason?: string }) {
    this.set({ conn: st, connAttempt: info.attempt, nextRetryMs: info.nextRetryMs });
    if (!this.s.running) return;
    if (st === "open") {
      if (this.pendingText && this.live) {
        this.live.send({ type: "text", text: this.pendingText });
        this.pendingText = null;
      }
      if (this.s.mode !== "offline") {
        if (this.s.mode === "snapshot" && this.s.serverLive !== "degraded") this.setMode("live", "Reconnected. Live assistant is back.");
        else if (this.s.banner?.title.startsWith("Connection")) this.set({ banner: null });
      }
    } else if (st === "reconnecting") {
      if (this.s.mode === "live" && info.attempt >= 2) {
        this.setMode("snapshot", "Connection lost. Switched to snapshot mode. I'll keep trying to reconnect.");
      } else if (this.s.mode === "live") {
        this.set({ banner: { tone: "warn", title: "Connection lost, reconnecting", detail: info.reason } });
        announce("Connection lost. Reconnecting.");
      }
    }
  }

  private setMode(mode: Mode, message?: string) {
    if (this.s.mode === mode) return;
    const prev = this.s.mode;
    this.set({ mode });
    if (mode === "live") {
      this.set({ banner: { tone: "good", title: "Live assistant connected" } });
      setTimeout(() => this.s.banner?.tone === "good" && this.set({ banner: null }), 4000);
    } else if (mode === "snapshot") {
      this.player.flush();
      this.set({ banner: { tone: "warn", title: "Snapshot mode", detail: "Live coaching is paused. Hold the label steady and press Check label. Answers are read out by your phone.", action: "snapshot" } });
    } else {
      this.player.flush();
      if (this.source === "glasses") void this.setSource("phone", "Offline: the glasses camera needs the server. Switched to the phone camera for barcode checks.");
      this.set({ banner: { tone: "info", title: "Offline mode", detail: barcodeSupported ? "No internet. I can still recognise your own saved medicines by their barcode. I can't read new labels until you're back online." : "No internet, and this browser can't scan barcodes. I can't check labels until you're back online." } });
      if (this.s.running) this.startBarcodeScan();
    }
    if (message || prev !== mode) {
      earcon.alert();
      announce(message ?? `Now in ${mode} mode.`, "assertive");
      if (this.s.running && mode !== "live") speak(message ?? `Now in ${mode} mode.`);
    }
  }

  // ---- verdicts ----
  private showVerdict(v: Verdict, via: Mode) {
    this.set({ verdict: v, verdictVia: via, cue: null, checking: false });
    earconForVerdict(v.level);
    haptic.verdict(v.level);
    announce(`${levelWord(v.level)}. ${v.headline}. ${v.speech}`, "assertive");
    // Gemini speaks verdicts itself in live mode; elsewhere the phone reads them out
    if (via !== "live" || IS_MOCK) speak(v.speech, { interrupt: false });
    this.armAutoStop();
  }

  dismissVerdict() {
    this.set({ verdict: null });
  }

  private onHudEvent(name: string) {
    if (name === "log_dose") this.logDose(true);
    else if (name === "repeat") this.repeat(true);
    else if (name === "dismiss") this.dismissVerdict();
  }

  /** The server only forwards HUD events as hud_event (contract Sat 16:40); the phone always sends the event to /live. */
  repeat(_fromHud = false) {
    const v = this.s.verdict;
    if (this.s.mode === "live" && this.live?.isOpen && !IS_MOCK) {
      this.live.send({ type: "event", name: "repeat" });
    } else if (v) speak(v.speech);
    if (v) announce(v.speech, "assertive");
  }

  logDose(_fromHud = false) {
    const v = this.s.verdict;
    if (!v?.matchedMedId) return announce("There is no matched medicine to log.", "assertive");
    const p = logDose(loadProfile(), v.matchedMedId);
    this.onProfileChange?.(p);
    // always tell the server, so its in-memory profile knows (else a 2nd check says "not taken today")
    if (this.live?.isOpen) this.live.send({ type: "event", name: "log_dose" });
    const med = p.meds.find((m) => m.id === v.matchedMedId);
    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const msg = `Logged ${med?.name ?? "dose"} at ${time}. Saved on this phone only.`;
    this.set({ verdict: { ...v, takenToday: true } });
    earcon.ok();
    announce(msg, "assertive");
    if (this.s.mode !== "live" || IS_MOCK) speak(msg);
  }

  sendText(text: string) {
    const t = text.trim();
    if (!t) return;
    this.armAutoStop();
    if (this.s.mode === "live") {
      if (this.live?.isOpen) this.live.send({ type: "text", text: t });
      else this.pendingText = t; // sent as soon as the socket opens
      if (!IS_MOCK) this.addCaption("user", t, true);
    } else if (this.s.mode === "snapshot") {
      this.addCaption("user", t, true);
      void this.snapshot(undefined, t);
    } else {
      this.addCaption("user", t, true);
      this.addCaption("system", "Offline: I can only check your saved medicines by barcode right now.", true);
    }
  }

  // ---- snapshot mode (HTTP verify) ----
  async snapshot(extra?: CapturedFrame, question?: string) {
    if (this.s.snapshotBusy) return;
    primeSpeech();
    // glasses camera: the bridge frames live on the server, so verify by session with no frames (QA #3)
    const useServerFrames = !extra && this.source === "glasses";
    const frames = extra ? [extra] : useServerFrames ? [] : this.ring.sharpest(2);
    if (!frames.length && !useServerFrames) {
      announce("I don't have a picture yet. Hold the label up to the camera, or take a photo.", "assertive");
      speak("I don't have a picture yet. Hold the label up to the camera, or take a photo.");
      return;
    }
    this.set({ snapshotBusy: true });
    announce("Checking the label.", "polite");
    earcon.coach();
    try {
      const v = await verify(
        frames.map((f) => f.data),
        loadProfile(),
        { question, session: this.s.session },
      );
      this.showVerdict(v, "snapshot");
    } catch (e) {
      if (e instanceof AuthError) return this.needKey();
      const offline = !navigator.onLine || e instanceof TypeError;
      const msg = offline ? "I couldn't reach the server. Check your connection." : `The check failed: ${(e as Error).message}`;
      this.set({ lastError: String(e), banner: { tone: "bad", title: "Snapshot failed", detail: msg, action: "retry" } });
      announce(msg, "assertive");
      speak(msg);
      if (offline) this.setMode("offline", "You're offline. I can still recognise your saved medicines by barcode.");
    } finally {
      this.set({ snapshotBusy: false });
    }
  }

  // ---- offline mode (barcode) ----
/** Feature on for this check: switched on in settings and offered by the server (when it said). */
  feature(f: FeatureFlag) {
    return loadSettings().features[f] !== false && (this.s.serverFeatures == null || this.s.serverFeatures.includes(f));
  }

  /**
   * Code scanner on the phone camera, at most 2 decodes/s. Offline: saved medicines by barcode, or exactly by
   * the pack's GS1 DataMatrix GTIN. Online (flag datamatrix): decoded pack codes go to /live for the cross-check.
   */
  private startBarcodeScan() {
    if (this.barcodeTimer || !barcodeSupported) return;
    let busy = false;
    this.barcodeTimer = setInterval(async () => {
      if (busy || !this.s.running || !this.video || this.s.camera !== "on" || this.s.hidden) return;
      const offline = this.s.mode === "offline";
      if (!offline && !(this.s.mode === "live" && this.live?.isOpen && this.feature("datamatrix"))) return;
      busy = true;
      try {
        const codes = await detectCodes(this.video);
        const pick = codes.find((c) => c.format === "data_matrix") ?? codes[0];
        if (pick) this.onCode(pick.rawValue, pick.format);
      } finally {
        busy = false;
      }
    }, 500);
  }

  private onCode(raw: string, format: string, force = false) {
    if (!force && raw === this.lastBarcode && Date.now() - this.lastBarcodeAt < 8000) return;
    this.lastBarcode = raw;
    this.lastBarcodeAt = Date.now();
    const gs1 = format === "data_matrix" || /^(\]d2|\x1d|\(01\)|01\d{14})/.test(raw) ? parseGs1(raw) : null;
    const dm = this.feature("datamatrix") && !!gs1;
    if (dm) this.set({ lastCode: gs1 });
    if (this.s.mode === "offline") {
      const p = loadProfile();
      if (dm && gs1?.gtin) {
        const med = findByGtin(p, gs1.gtin);
        this.showVerdict(med ? matchVerdict(p, med, { via: "datamatrix", code: gs1 }) : offlineUnknownCode(gs1), "offline");
      } else {
        const med = findByBarcode(p, raw);
        this.showVerdict(med ? matchVerdict(p, med, { via: "barcode" }) : offlineUnknownBarcode(raw), "offline");
      }
      return;
    }
    if (dm && this.live?.isOpen) {
      this.live.send({ type: "datamatrix", raw, ts: Date.now() });
      earcon.coach();
      announce(`Pack code read${gs1?.expiry ? `, expiry ${gs1.expiry}` : ""}. Double-checking the label.`);
    }
  }

  /** Demo / test: behave as if the camera decoded this code. */
  injectCode(raw: string) {
    this.onCode(raw, "data_matrix", true);
  }
  private stopBarcodeScan() {
    if (this.barcodeTimer) clearInterval(this.barcodeTimer);
    this.barcodeTimer = null;
  }

  /** Barcode check of an arbitrary image (offline mode with a photo). */
  async offlineCheckImage(file: File) {
    if (!barcodeSupported) return announce("This browser can't read barcodes.", "assertive");
    const bmp = await createImageBitmap(file);
    const code = await detectBarcode(bmp);
    bmp.close();
    const p = loadProfile();
    if (!code) {
      const msg = "I couldn't find a barcode in that photo. Try the side of the box with the stripes.";
      announce(msg, "assertive");
      speak(msg);
      return;
    }
    const med = findByBarcode(p, code);
    this.showVerdict(med ? matchVerdict(p, med, { via: "barcode" }) : offlineUnknownBarcode(code), "offline");
  }

  // ---- network ----
  private onOnline = () => {
    this.set({ online: true });
    announce("Back online. Reconnecting.");
    void this.checkHealth();
    if (this.s.mode === "offline") {
      if (this.live?.isOpen) this.setMode("live", "Back online. Live assistant connected.");
      else this.set({ mode: "snapshot", banner: { tone: "warn", title: "Back online", detail: "Reconnecting to the live assistant. Snapshot checks work meanwhile.", action: "snapshot" } }); // until the socket proves itself
    }
    this.ensureLive();
  };

  private ensureLive() {
    if (!this.s.running || !this.live) return;
    if (this.live.state === "idle" || this.live.state === "closed") this.live.start();
    else this.live.retryNow();
  }
  private onOffline = () => {
    this.set({ online: false });
    this.setMode("offline", "You're offline. I can still recognise your saved medicines by barcode, but I can't read new labels.");
  };

  async checkHealth() {
    try {
      const h = await health();
      this.healthFails = 0;
      this.set({ health: h.gemini === "down" ? "down" : "ok", authNeeded: false });
      if (this.s.mode === "offline" && navigator.onLine && (!IS_MOCK || !mockCtl.offline)) {
        this.set({ online: true });
        this.setMode(this.live?.isOpen ? "live" : "snapshot", "Connection is back.");
        this.ensureLive();
      }
    } catch (e) {
      if (e instanceof AuthError) return this.needKey();
      this.healthFails++;
      this.set({ health: "unreachable" });
      if (this.healthFails >= 2 && !this.live?.isOpen && this.s.mode !== "offline") {
        this.setMode("offline", "I can't reach the HoldUp server. Offline mode: I can recognise your saved medicines by barcode.");
      }
    }
  }

  /** The server wants an access key (HOLDUP_KEY) we don't have or that is wrong. */
  private needKey() {
    if (this.s.authNeeded) return;
    this.set({ authNeeded: true, health: "unreachable" });
    if (this.s.running) void this.stop("Check stopped: this HoldUp server needs an access key.");
    announce("Access key needed. This HoldUp server only accepts people with its link.", "assertive");
  }

  /** After the user entered a key. */
  async retryKey() {
    this.set({ authNeeded: false });
    await this.checkHealth();
  }

  // ---- device / visibility ----
  private onVisibility = async () => {
    const hidden = document.visibilityState === "hidden";
    this.set({ hidden });
    if (!this.s.running || this.source !== "phone") return;
    if (hidden) {
      this.stopCamera();
      this.set({ camera: "paused" });
    } else if (this.s.camera === "paused") {
      await this.startCamera();
      announce("Welcome back. Camera resumed.");
    }
  };

  private onDeviceChange = async () => {
    const r = await audioRoute();
    const key = r.input + "|" + r.output;
    if (key === this.routeKey) return;
    this.routeKey = key;
    const name = r.output || r.input || "phone speaker";
    this.set({ route: name });
    announce(`Audio now through ${name}.`, "assertive");
    if (this.s.running && this.s.mic === "on" && !this.mic.active) await this.restartMic("Microphone changed.");
  };

  // ---- auto-stop ----
  private armAutoStop() {
    if (!this.s.running) return;
    if (this.autoStopTimer) clearTimeout(this.autoStopTimer);
    const at = Date.now() + AUTO_STOP_MS;
    this.set({ autoStopAt: at });
    this.autoStopTimer = setTimeout(() => {
      speak("No label for 45 seconds. I've turned the camera off.");
      void this.stop("Stopped automatically after 45 seconds without a label. Camera off.");
    }, AUTO_STOP_MS);
  }

  // ---- media session: a Bluetooth play/pause (e.g. a glasses tap) triggers the primary action ----
  private enableMediaSession() {
    if (!("mediaSession" in navigator)) return;
    try {
      if (!this.silentAudio) {
        this.silentAudio = new Audio(silentWavUrl());
        this.silentAudio.loop = true;
      }
      void this.silentAudio.play().catch(() => {});
      navigator.mediaSession.metadata = new MediaMetadata({ title: "HoldUp check", artist: "Tap to check or stop", album: "HoldUp" });
      const act = () => this.primary();
      navigator.mediaSession.setActionHandler("play", act);
      navigator.mediaSession.setActionHandler("pause", act);
      try {
        navigator.mediaSession.setActionHandler("stop", () => void this.stop());
      } catch {
        /* not supported */
      }
      navigator.mediaSession.playbackState = "playing";
    } catch {
      /* ignore */
    }
  }

  // ---- demo helpers (device panel) ----
  simulateDrop() {
    this.live?.simulateDrop();
    if (IS_MOCK) mockCtl.failConnects = 2;
  }
  toggleSnapshotMode() {
    if (this.s.mode === "snapshot") this.backToLive();
    else this.setMode("snapshot", "Snapshot mode on.");
  }

  /** Leave snapshot mode: always re-send start so a degraded/closed server session is recreated. (QA #2) */
  backToLive() {
    if (!this.s.running) return;
    this.set({ serverLive: this.s.serverLive === "degraded" || this.s.serverLive === "closed" ? "connecting" : this.s.serverLive });
    this.setMode("live", "Back to live mode. Reconnecting to the assistant.");
    this.live?.resendStart();
  }

  /** The profile changed during a check: the server's safety check uses the profile from start. (QA #7) */
  profileChanged() {
    if (this.s.running && this.live?.isOpen && this.s.mode === "live") this.live.resendStart();
  }

  private addCaption(role: Caption["role"], text: string, final: boolean) {
    const caps = [...this.s.captions];
    const last = caps[caps.length - 1];
    if (last && last.role === role && !last.final) {
      // server transcripts are cumulative per utterance: replace the open line until final
      caps[caps.length - 1] = { ...last, text, final };
    } else {
      caps.push({ id: ++this.captionId, role, text, final });
    }
    this.set({ captions: caps.slice(-MAX_CAPTIONS) });
  }

  dispose() {
    void this.stop();
    window.removeEventListener("online", this.onOnline);
    window.removeEventListener("offline", this.onOffline);
    document.removeEventListener("visibilitychange", this.onVisibility);
    navigator.mediaDevices?.removeEventListener?.("devicechange", this.onDeviceChange);
    if (this.healthTimer) clearInterval(this.healthTimer);
    void this.player.close();
  }
}

export function levelWord(l: Verdict["level"]) {
  return l === "match" ? "Match" : l === "warning" ? "Warning" : l === "unsure" ? "Not sure" : "Info";
}

function friendlyError(code: string) {
  switch (code) {
    case "gemini_unavailable":
      return "The AI service is unavailable";
    case "quota":
      return "The AI service is busy (quota reached)";
    case "bad_input":
      return "The server couldn't use that input";
    default:
      return "Something went wrong";
  }
}

let silentUrl = "";
function silentWavUrl() {
  if (silentUrl) return silentUrl;
  const rate = 8000;
  const n = rate; // 1 s
  const buf = new ArrayBuffer(44 + n);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF");
  v.setUint32(4, 36 + n, true);
  w(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate, true);
  v.setUint16(32, 1, true);
  v.setUint16(34, 8, true);
  w(36, "data");
  v.setUint32(40, n, true);
  for (let i = 0; i < n; i++) v.setUint8(44 + i, 128);
  silentUrl = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
  return silentUrl;
}

/** Feature flags switched on in this phone's settings (sent as start.features). */
export function localFeatures(): FeatureFlag[] {
  const f = loadSettings().features;
  return (Object.keys(f) as FeatureFlag[]).filter((k) => f[k]);
}
