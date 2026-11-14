import type {
  ChaosConfig,
  ClientMsg,
  CoachCue,
  DeviceState,
  LiveState,
  NetworkMetrics,
  PermissionStateSummary,
  Profile,
  ServerMsg,
  SessionSnapshot,
  TranscriptEntry,
  TransportMode,
  Verdict
} from "../types.ts";

export interface WsLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export type SessionCallbacks = {
  onAudioChunk?: (b64Pcm24k: string) => void;
  onInterrupted?: () => void;
  onCheckingChange?: (checking: boolean) => void;
  onVerdict?: (verdict: Verdict, mode: TransportMode) => void;
  onCoach?: (cue: CoachCue, text: string) => void;
  onStateAnnouncement?: (message: string) => void;
};

export type SessionManagerOptions = {
  sessionId: string;
  initialProfile: Profile;
  wsUrlBuilder?: (sessionId: string) => string;
  createWs?: (url: string) => WsLike;
  fetchImpl?: typeof fetch;
  callbacks?: SessionCallbacks;
  autoStopMs?: number;
  pingIntervalMs?: number;
};

const WS_OPEN = 1;
const DEFAULT_AUTO_STOP_MS = 45_000;
const DEFAULT_PING_INTERVAL_MS = 5_000;
const RECONNECT_BASE_MS = 300;
const RECONNECT_CAP_MS = 8_000;
const MAX_BUFFERED_FRAMES = 3;
const MAX_TRANSCRIPTS = 50;

function defaultWsUrlBuilder(sessionId: string): string {
  const origin =
    typeof window !== "undefined" && window.location?.origin
      ? window.location.origin
      : "http:\x2f\x2flocalhost:8787";
  const url = new URL("/live", origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("session", sessionId);
  return url.toString();
}

function defaultCreateWs(url: string): WsLike {
  return new WebSocket(url) as unknown as WsLike;
}

function defaultFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return globalThis.fetch(input, init);
}

function detectInitialOnline(): boolean {
  if (typeof window !== "undefined" && typeof navigator !== "undefined" && typeof navigator.onLine === "boolean") {
    return navigator.onLine;
  }
  return true;
}

function adaptNetworkQuality(rttMs: number): Pick<NetworkMetrics, "targetFps" | "jpegQuality"> {
  if (rttMs <= 250) {
    return { targetFps: 1, jpegQuality: 0.8 };
  }
  if (rttMs <= 600) {
    return { targetFps: 0.75, jpegQuality: 0.65 };
  }
  if (rttMs <= 1200) {
    return { targetFps: 0.5, jpegQuality: 0.5 };
  }
  return { targetFps: 0.25, jpegQuality: 0.4 };
}

function unrefTimer(timer: unknown): void {
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    const fn = (timer as { unref?: unknown }).unref;
    if (typeof fn === "function") {
      fn.call(timer);
    }
  }
}

function cloneProfile(profile: Profile): Profile {
  return {
    meds: profile.meds.map((m) => ({ ...m, schedule: [...m.schedule] })),
    allergies: [...profile.allergies],
    avoid: [...profile.avoid],
    doseLog: profile.doseLog.map((d) => ({ ...d })),
    lang: profile.lang
  };
}

function parseServerMessage(raw: unknown): ServerMsg | null {
  try {
    if (typeof raw === "string") {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && "type" in parsed) {
        return parsed as ServerMsg;
      }
      return null;
    }
    if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(raw));
      if (parsed && typeof parsed === "object" && "type" in parsed) {
        return parsed as ServerMsg;
      }
      return null;
    }
    if (raw && typeof raw === "object" && "type" in raw) {
      return raw as ServerMsg;
    }
  } catch {
    return null;
  }
  return null;
}

export class HoldUpSessionManager {
  private readonly sessionId: string;
  private profile: Profile;
  private readonly wsUrlBuilder: (sessionId: string) => string;
  private readonly createWs: (url: string) => WsLike;
  private readonly fetchImpl: typeof fetch;
  private readonly callbacks: SessionCallbacks;
  private readonly autoStopMs: number;
  private readonly pingIntervalMs: number;

  private readonly listeners = new Set<(snap: SessionSnapshot) => void>();
  private snapshot: SessionSnapshot;

  private online: boolean;
  private chaos: ChaosConfig = {
    forceWsDrop: false,
    forceOffline: false,
    simulateGlassesDoffed: false,
    simulateLowBattery: false
  };

  private rawDevice: Omit<DeviceState, "source"> = {
    connected: false,
    worn: false,
    battery: null,
    streaming: false
  };
  private hasReceivedDeviceMsg = false;

  private sessionActive = false;
  private voiceEnabled = true;
  private hasConnectedOnce = false;
  private reconnectAttempt = 0;

  private ws: WsLike | null = null;
  private wsGen = 0;

  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private autoStopInterval: ReturnType<typeof setInterval> | null = null;
  private autoStopTimeout: ReturnType<typeof setTimeout> | null = null;
  private autoStopDeadline = 0;

  private bufferedFrames: string[] = [];
  private transcriptSeq = 0;

  constructor(opts: SessionManagerOptions) {
    this.sessionId = opts.sessionId;
    this.profile = cloneProfile(opts.initialProfile);
    this.wsUrlBuilder = opts.wsUrlBuilder ?? defaultWsUrlBuilder;
    this.createWs = opts.createWs ?? defaultCreateWs;
    this.fetchImpl = opts.fetchImpl ?? defaultFetch;
    this.callbacks = opts.callbacks ?? {};
    this.autoStopMs = opts.autoStopMs ?? DEFAULT_AUTO_STOP_MS;
    this.pingIntervalMs = opts.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    this.online = detectInitialOnline();

    this.snapshot = {
      sessionId: this.sessionId,
      mode: this.online ? "live" : "offline",
      liveState: "closed",
      activeModel: null,
      checking: false,
      coach: null,
      verdict: null,
      transcripts: [],
      device: {
        connected: false,
        worn: false,
        battery: null,
        streaming: false,
        source: "phone"
      },
      hudConnected: false,
      network: {
        online: this.online,
        rttMs: null,
        targetFps: 1,
        jpegQuality: 0.8
      },
      permissions: {
        camera: "prompt",
        microphone: "prompt"
      },
      cameraActive: false,
      autoStopRemainingSec: null,
      lastError: null
    };

    this.subscribe = this.subscribe.bind(this);
    this.getSnapshot = this.getSnapshot.bind(this);
  }

  subscribe(listener: (snap: SessionSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): SessionSnapshot {
    return this.snapshot;
  }

  getBufferedFrames(): readonly string[] {
    return [...this.bufferedFrames];
  }

  startSession(opts?: { voice?: boolean; preferredSource?: "phone" | "glasses" }): void {
    this.sessionActive = true;
    this.voiceEnabled = opts?.voice ?? true;

    if (opts?.preferredSource === "glasses" && !this.hasReceivedDeviceMsg) {
      this.rawDevice = {
        connected: true,
        worn: true,
        battery: null,
        streaming: true
      };
    }

    this.reconcileDeviceState(opts?.preferredSource);
    this.resetAutoStopTimer();

    const effectiveOnline = this.isEffectiveOnline();
    if (!effectiveOnline) {
      this.teardownWs();
      this.clearReconnectTimer();
      const prevMode = this.snapshot.mode;
      this.updateSnapshot({
        mode: "offline",
        liveState: "closed",
        activeModel: null,
        cameraActive: true,
        lastError: null,
        network: {
          ...this.snapshot.network,
          online: false,
          rttMs: null
        }
      });
      if (prevMode !== "offline") {
        this.callbacks.onStateAnnouncement?.("Offline mode active. Saved medications can still be checked by barcode.");
      }
      return;
    }

    if (this.chaos.forceWsDrop) {
      this.teardownWs();
      this.clearReconnectTimer();
      const prevMode = this.snapshot.mode;
      this.updateSnapshot({
        mode: "snapshot",
        liveState: "degraded",
        activeModel: null,
        cameraActive: true,
        lastError: null,
        network: {
          ...this.snapshot.network,
          online: true
        }
      });
      if (prevMode !== "snapshot") {
        this.callbacks.onStateAnnouncement?.("Live connection unavailable, switched to snapshot mode");
      }
      return;
    }

    this.updateSnapshot({
      cameraActive: true,
      lastError: null,
      network: {
        ...this.snapshot.network,
        online: true
      }
    });

    if (this.ws && this.ws.readyState === WS_OPEN && this.snapshot.liveState === "open") {
      this.sendClientMsg({
        type: "start",
        profile: this.profile,
        lang: this.profile.lang || "en",
        voice: this.voiceEnabled,
        source: this.snapshot.device.source
      });
      return;
    }

    if (!this.ws) {
      this.reconnectAttempt = 0;
      this.connectWs();
    }
  }

  stopSession(reason?: string): void {
    const wasActive = this.sessionActive || this.snapshot.cameraActive;
    const wasChecking = this.snapshot.checking;

    this.sessionActive = false;
    this.bufferedFrames = [];

    this.clearAutoStopTimers();
    this.clearReconnectTimer();
    this.teardownWs();

    const nextMode: TransportMode = this.isEffectiveOnline()
      ? (this.chaos.forceWsDrop ? "snapshot" : "live")
      : "offline";

    this.updateSnapshot({
      mode: nextMode,
      liveState: "closed",
      activeModel: null,
      checking: false,
      coach: null,
      cameraActive: false,
      autoStopRemainingSec: null
    });

    if (wasChecking) {
      this.callbacks.onCheckingChange?.(false);
    }

    if (reason && wasActive) {
      this.callbacks.onStateAnnouncement?.(reason);
    }
  }

  updateProfile(profile: Profile): void {
    this.profile = cloneProfile(profile);
    if (this.sessionActive && this.ws && this.ws.readyState === WS_OPEN && this.snapshot.liveState === "open") {
      this.sendClientMsg({
        type: "start",
        profile: this.profile,
        lang: this.profile.lang || "en",
        voice: this.voiceEnabled,
        source: this.snapshot.device.source
      });
    }
  }

  setPermissions(p: Partial<PermissionStateSummary>): void {
    const next: PermissionStateSummary = {
      ...this.snapshot.permissions,
      ...p
    };
    if (
      next.camera !== this.snapshot.permissions.camera ||
      next.microphone !== this.snapshot.permissions.microphone
    ) {
      this.updateSnapshot({ permissions: next });
    }
  }

  setOnline(online: boolean): void {
    if (this.online === online) {
      return;
    }
    this.online = online;
    this.reconcileTransport();
  }

  setChaos(chaos: ChaosConfig): void {
    this.chaos = { ...chaos };
    this.reconcileDeviceState();
    this.reconcileTransport();
  }

  sendAudio(b64Pcm16: string): void {
    if (
      !this.sessionActive ||
      !this.voiceEnabled ||
      !b64Pcm16 ||
      this.snapshot.mode !== "live" ||
      this.snapshot.liveState !== "open" ||
      !this.ws ||
      this.ws.readyState !== WS_OPEN
    ) {
      return;
    }
    this.sendClientMsg({ type: "audio", data: b64Pcm16 });
  }

  sendFrame(frame: { data: string; w: number; h: number; sharpness: number; ts: number }): void {
    if (!this.sessionActive || !this.snapshot.cameraActive || !frame.data) {
      return;
    }

    if (this.bufferedFrames.length >= MAX_BUFFERED_FRAMES) {
      this.bufferedFrames.shift();
    }
    this.bufferedFrames.push(frame.data);

    if (
      this.snapshot.mode === "live" &&
      this.snapshot.liveState === "open" &&
      this.ws &&
      this.ws.readyState === WS_OPEN
    ) {
      this.sendClientMsg({
        type: "frame",
        data: frame.data,
        w: frame.w,
        h: frame.h,
        sharpness: frame.sharpness,
        ts: frame.ts
      });
    }
  }

  async sendQuestion(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }

    if (this.sessionActive && this.snapshot.cameraActive) {
      this.resetAutoStopTimer();
    }

    this.appendTranscript("user", trimmed, true);

    if (!this.isEffectiveOnline() || this.snapshot.mode === "offline") {
      this.updateSnapshot({
        lastError: {
          code: "offline",
          message: "Offline mode: scan a barcode to check saved medications.",
          recoverable: true
        }
      });
      this.callbacks.onStateAnnouncement?.("Offline mode: scan a barcode to check saved medications.");
      return;
    }

    if (
      this.snapshot.mode === "live" &&
      this.snapshot.liveState === "open" &&
      this.ws &&
      this.ws.readyState === WS_OPEN
    ) {
      const sent = this.sendClientMsg({ type: "text", text: trimmed });
      if (sent) {
        return;
      }
    }

    await this.verifySnapshot([...this.bufferedFrames], trimmed);
  }

  async verifySnapshot(frames: string[], question?: string): Promise<Verdict | null> {
    if (!this.isEffectiveOnline()) {
      this.updateSnapshot({
        lastError: {
          code: "offline",
          message: "Cannot verify snapshot while offline.",
          recoverable: true
        }
      });
      return null;
    }

    const picked = frames.filter((f) => typeof f === "string" && f.length > 0).slice(-MAX_BUFFERED_FRAMES);
    if (picked.length === 0) {
      this.updateSnapshot({
        lastError: {
          code: "no_frames",
          message: "No camera frames captured yet. Hold the label steady and try again.",
          recoverable: true
        }
      });
      return null;
    }

    this.setCheckingState(true);

    const payload: { frames: string[]; profile: Profile; question?: string } = {
      frames: picked,
      profile: this.profile
    };
    if (question && question.trim()) {
      payload.question = question.trim();
    }

    try {
      const res = await this.fetchImpl("/api/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        let code = "verify_failed";
        let message = `Snapshot verify failed (${res.status})`;
        let recoverable = true;
        try {
          const errBody = (await res.json()) as Partial<{ code: string; message: string; recoverable: boolean }>;
          if (typeof errBody.code === "string") code = errBody.code;
          if (typeof errBody.message === "string") message = errBody.message;
          if (typeof errBody.recoverable === "boolean") recoverable = errBody.recoverable;
        } catch {
          recoverable = true;
        }
        this.setCheckingState(false);
        this.updateSnapshot({
          lastError: { code, message, recoverable }
        });
        return null;
      }

      const verdict = (await res.json()) as Verdict;
      this.setCheckingState(false);
      this.updateSnapshot({
        verdict,
        lastError: null
      });
      if (verdict.speech) {
        this.appendTranscript("assistant", verdict.speech, true);
      }
      this.callbacks.onVerdict?.(verdict, this.snapshot.mode);
      return verdict;
    } catch (err) {
      this.setCheckingState(false);
      this.updateSnapshot({
        lastError: {
          code: "network_error",
          message: err instanceof Error ? err.message : "Snapshot request failed",
          recoverable: true
        }
      });
      return null;
    }
  }

  applyLocalVerdict(verdict: Verdict): void {
    const wasChecking = this.snapshot.checking;
    this.updateSnapshot({
      verdict,
      checking: false,
      lastError: null
    });
    if (wasChecking) {
      this.callbacks.onCheckingChange?.(false);
    }
    if (verdict.speech) {
      this.appendTranscript("assistant", verdict.speech, true);
    }
    this.callbacks.onVerdict?.(verdict, this.snapshot.mode);
  }

  sendEvent(name: "log_dose" | "repeat" | "stop"): void {
    if (name === "stop") {
      if (this.ws && this.ws.readyState === WS_OPEN) {
        this.sendClientMsg({ type: "event", name: "stop" });
      }
      this.stopSession("Stopped by user");
      return;
    }

    if (
      this.snapshot.mode === "live" &&
      this.snapshot.liveState === "open" &&
      this.ws &&
      this.ws.readyState === WS_OPEN
    ) {
      this.sendClientMsg({ type: "event", name });
      return;
    }

    if (name === "repeat" && this.snapshot.verdict) {
      this.callbacks.onVerdict?.(this.snapshot.verdict, this.snapshot.mode);
    }
  }

  private isEffectiveOnline(): boolean {
    return this.online && !this.chaos.forceOffline;
  }

  private connectWs(): void {
    if (!this.sessionActive || !this.isEffectiveOnline() || this.chaos.forceWsDrop) {
      return;
    }

    this.clearReconnectTimer();
    this.teardownWs();

    const gen = ++this.wsGen;
    const nextLiveState: LiveState =
      this.hasConnectedOnce || this.reconnectAttempt > 0 || this.snapshot.mode === "snapshot"
        ? "reconnecting"
        : "connecting";

    this.updateSnapshot({ liveState: nextLiveState });

    let sock: WsLike;
    try {
      const url = this.wsUrlBuilder(this.sessionId);
      sock = this.createWs(url);
    } catch {
      this.enterSnapshotFallback(true);
      return;
    }

    this.ws = sock;

    sock.onopen = () => {
      if (gen !== this.wsGen || !this.sessionActive) {
        return;
      }
      this.sendClientMsg({
        type: "start",
        profile: this.profile,
        lang: this.profile.lang || "en",
        voice: this.voiceEnabled,
        source: this.snapshot.device.source
      });
      this.startPingTimer(gen);
    };

    sock.onmessage = (ev) => {
      if (gen !== this.wsGen) {
        return;
      }
      const msg = parseServerMessage(ev.data);
      if (msg) {
        this.handleServerMessage(msg);
      }
    };

    sock.onerror = () => {
      if (gen !== this.wsGen) {
        return;
      }
      this.teardownWs();
      if (!this.sessionActive || !this.isEffectiveOnline()) {
        return;
      }
      this.enterSnapshotFallback(!this.chaos.forceWsDrop);
    };

    sock.onclose = () => {
      if (gen !== this.wsGen) {
        return;
      }
      this.teardownWs();
      if (!this.sessionActive) {
        this.updateSnapshot({ liveState: "closed" });
        return;
      }
      if (!this.isEffectiveOnline()) {
        return;
      }
      this.enterSnapshotFallback(!this.chaos.forceWsDrop);
    };
  }

  private handleServerMessage(msg: ServerMsg): void {
    switch (msg.type) {
      case "ready": {
        const prevMode = this.snapshot.mode;
        this.reconnectAttempt = 0;
        this.hasConnectedOnce = true;
        this.updateSnapshot({
          mode: "live",
          liveState: "open",
          activeModel: msg.model,
          lastError: null
        });
        if (prevMode !== "live") {
          this.callbacks.onStateAnnouncement?.("Live connection restored");
        }
        return;
      }

      case "audio": {
        if (msg.data) {
          this.callbacks.onAudioChunk?.(msg.data);
        }
        return;
      }

      case "transcript": {
        this.upsertServerTranscript(msg.role, msg.text, msg.final);
        return;
      }

      case "coach": {
        this.updateSnapshot({
          coach: { cue: msg.cue, text: msg.text }
        });
        this.callbacks.onCoach?.(msg.cue, msg.text);
        return;
      }

      case "verdict": {
        const wasChecking = this.snapshot.checking;
        this.updateSnapshot({
          verdict: msg.verdict,
          checking: false,
          lastError: null
        });
        if (wasChecking) {
          this.callbacks.onCheckingChange?.(false);
        }
        this.callbacks.onVerdict?.(msg.verdict, this.snapshot.mode);
        return;
      }

      case "status": {
        if (msg.live === "degraded") {
          if (this.isEffectiveOnline()) {
            const prevMode = this.snapshot.mode;
            this.updateSnapshot({
              mode: "snapshot",
              liveState: "degraded"
            });
            if (prevMode !== "snapshot") {
              this.callbacks.onStateAnnouncement?.("Live voice unavailable, switched to snapshot mode");
            }
          }
          return;
        }
        if (msg.live === "open") {
          this.updateSnapshot({
            mode: "live",
            liveState: "open"
          });
          return;
        }
        this.updateSnapshot({ liveState: msg.live });
        return;
      }

      case "device": {
        this.hasReceivedDeviceMsg = true;
        this.rawDevice = {
          connected: msg.device.connected,
          worn: msg.device.worn,
          battery: msg.device.battery,
          streaming: msg.device.streaming
        };
        this.reconcileDeviceState();
        return;
      }

      case "error": {
        const patch: Partial<SessionSnapshot> = {
          lastError: {
            code: msg.code,
            message: msg.message,
            recoverable: msg.recoverable
          }
        };
        const shouldDegrade = msg.code === "gemini_unavailable" && this.isEffectiveOnline();
        const prevMode = this.snapshot.mode;
        if (shouldDegrade) {
          patch.mode = "snapshot";
          patch.liveState = "degraded";
        }
        this.updateSnapshot(patch);
        if (shouldDegrade && prevMode !== "snapshot") {
          this.callbacks.onStateAnnouncement?.("Live voice unavailable, switched to snapshot mode");
        }
        return;
      }

      case "pong": {
        const rttMs = Math.max(0, Date.now() - msg.t);
        const adapted = adaptNetworkQuality(rttMs);
        this.updateSnapshot({
          network: {
            ...this.snapshot.network,
            rttMs,
            targetFps: adapted.targetFps,
            jpegQuality: adapted.jpegQuality
          }
        });
        return;
      }

      case "interrupted": {
        this.callbacks.onInterrupted?.();
        return;
      }

      case "checking": {
        const isChecking = msg.phase === "start";
        this.setCheckingState(isChecking);
        return;
      }

      case "hud": {
        this.updateSnapshot({ hudConnected: Boolean(msg.connected) });
        return;
      }
    }
  }

  private enterSnapshotFallback(scheduleReconnect: boolean): void {
    const prevMode = this.snapshot.mode;
    const wasChecking = this.snapshot.checking;
    const nextLiveState: LiveState = scheduleReconnect ? "reconnecting" : "degraded";

    this.updateSnapshot({
      mode: "snapshot",
      liveState: nextLiveState,
      activeModel: null,
      checking: false
    });

    if (wasChecking) {
      this.callbacks.onCheckingChange?.(false);
    }

    if (prevMode !== "snapshot") {
      this.callbacks.onStateAnnouncement?.("Connection interrupted, switched to snapshot mode");
    }

    if (scheduleReconnect && this.sessionActive && this.isEffectiveOnline() && !this.chaos.forceWsDrop) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    const delayMs = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.sessionActive && this.isEffectiveOnline() && !this.chaos.forceWsDrop) {
        this.connectWs();
      }
    }, delayMs);
    unrefTimer(this.reconnectTimer);
  }

  private reconcileTransport(): void {
    const effectiveOnline = this.isEffectiveOnline();

    if (!effectiveOnline) {
      this.clearReconnectTimer();
      this.teardownWs();
      const prevMode = this.snapshot.mode;
      const wasChecking = this.snapshot.checking;
      this.updateSnapshot({
        mode: "offline",
        liveState: "closed",
        activeModel: null,
        checking: false,
        network: {
          ...this.snapshot.network,
          online: false,
          rttMs: null
        }
      });
      if (wasChecking) {
        this.callbacks.onCheckingChange?.(false);
      }
      if (prevMode !== "offline") {
        this.callbacks.onStateAnnouncement?.("Offline mode active. Saved medications can still be checked by barcode.");
      }
      return;
    }

    if (!this.sessionActive) {
      const prevMode = this.snapshot.mode;
      const nextMode: TransportMode = this.chaos.forceWsDrop ? "snapshot" : "live";
      const nextLiveState: LiveState = this.chaos.forceWsDrop ? "degraded" : "closed";
      this.updateSnapshot({
        mode: nextMode,
        liveState: nextLiveState,
        network: {
          ...this.snapshot.network,
          online: true
        }
      });
      if (prevMode === "offline") {
        this.callbacks.onStateAnnouncement?.("Network connection restored");
      } else if (prevMode !== nextMode && nextMode === "snapshot") {
        this.callbacks.onStateAnnouncement?.("Live connection dropped, switched to snapshot mode");
      }
      return;
    }

    if (this.chaos.forceWsDrop) {
      this.clearReconnectTimer();
      this.teardownWs();
      const prevMode = this.snapshot.mode;
      const wasChecking = this.snapshot.checking;
      this.updateSnapshot({
        mode: "snapshot",
        liveState: "degraded",
        activeModel: null,
        checking: false,
        network: {
          ...this.snapshot.network,
          online: true
        }
      });
      if (wasChecking) {
        this.callbacks.onCheckingChange?.(false);
      }
      if (prevMode !== "snapshot") {
        this.callbacks.onStateAnnouncement?.("Live connection dropped, switched to snapshot mode");
      }
      return;
    }

    if (this.ws) {
      if (!this.snapshot.network.online) {
        this.updateSnapshot({
          network: {
            ...this.snapshot.network,
            online: true
          }
        });
      }
      return;
    }

    const wasOffline = this.snapshot.mode === "offline";
    this.updateSnapshot({
      mode: "snapshot",
      liveState: "reconnecting",
      network: {
        ...this.snapshot.network,
        online: true
      }
    });
    if (wasOffline) {
      this.callbacks.onStateAnnouncement?.("Network connection restored, reconnecting live session");
    }
    this.reconnectAttempt = 0;
    this.connectWs();
  }

  private reconcileDeviceState(preferredSource?: "phone" | "glasses"): void {
    const prevSource = this.snapshot.device.source;
    const connected = this.rawDevice.connected;
    const worn = this.rawDevice.worn && !this.chaos.simulateGlassesDoffed;
    const battery = this.chaos.simulateLowBattery
      ? (this.rawDevice.battery !== null ? Math.min(this.rawDevice.battery, 10) : 10)
      : this.rawDevice.battery;
    const streaming = this.rawDevice.streaming;
    const lowBattery = battery !== null && battery < 15;
    const glassesHealthy = connected && worn && streaming && !lowBattery;

    let nextSource: "phone" | "glasses" = preferredSource ?? prevSource;
    let announcement: string | null = null;

    if (glassesHealthy) {
      nextSource = "glasses";
    } else if (prevSource === "glasses" || preferredSource === "glasses") {
      nextSource = "phone";
      if (prevSource === "glasses") {
        if (!connected) {
          announcement = "Glasses disconnected, switching to phone camera";
        } else if (!worn) {
          announcement = "Glasses taken off, switching to phone camera";
        } else if (lowBattery) {
          announcement = "Glasses battery low, switching to phone camera";
        } else {
          announcement = "Glasses camera unavailable, switching to phone camera";
        }
      }
    }

    const nextDevice: DeviceState = {
      connected,
      worn,
      battery,
      streaming,
      source: nextSource
    };

    const cur = this.snapshot.device;
    if (
      cur.connected !== nextDevice.connected ||
      cur.worn !== nextDevice.worn ||
      cur.battery !== nextDevice.battery ||
      cur.streaming !== nextDevice.streaming ||
      cur.source !== nextDevice.source
    ) {
      this.updateSnapshot({ device: nextDevice });
    }

    if (announcement) {
      this.callbacks.onStateAnnouncement?.(announcement);
    }
  }

  private startPingTimer(gen: number): void {
    this.clearPingTimer();
    this.pingTimer = setInterval(() => {
      if (gen !== this.wsGen || !this.ws || this.ws.readyState !== WS_OPEN) {
        return;
      }
      this.sendClientMsg({ type: "ping", t: Date.now() });
    }, this.pingIntervalMs);
    unrefTimer(this.pingTimer);
  }

  private resetAutoStopTimer(): void {
    this.clearAutoStopTimers();
    const initialSec = Math.max(1, Math.ceil(this.autoStopMs / 1000));
    this.autoStopDeadline = Date.now() + this.autoStopMs;
    this.updateSnapshot({
      cameraActive: true,
      autoStopRemainingSec: initialSec
    });

    this.autoStopInterval = setInterval(() => {
      if (!this.sessionActive || !this.snapshot.cameraActive) {
        this.clearAutoStopTimers();
        return;
      }
      const remainingSec = Math.max(0, Math.ceil((this.autoStopDeadline - Date.now()) / 1000));
      if (remainingSec <= 0) {
        this.stopSession("Auto-stopped after 45s");
        return;
      }
      if (this.snapshot.autoStopRemainingSec !== remainingSec) {
        this.updateSnapshot({ autoStopRemainingSec: remainingSec });
      }
    }, 1000);
    unrefTimer(this.autoStopInterval);

    this.autoStopTimeout = setTimeout(() => {
      if (this.sessionActive && this.snapshot.cameraActive) {
        this.stopSession("Auto-stopped after 45s");
      }
    }, this.autoStopMs);
    unrefTimer(this.autoStopTimeout);
  }

  private setCheckingState(checking: boolean): void {
    const changed = this.snapshot.checking !== checking;
    if (changed) {
      this.updateSnapshot({ checking });
      this.callbacks.onCheckingChange?.(checking);
    }
  }

  private appendTranscript(role: "user" | "assistant", text: string, final: boolean): void {
    const entry: TranscriptEntry = {
      id: `t-${++this.transcriptSeq}`,
      role,
      text,
      final,
      ts: Date.now()
    };
    const next = [...this.snapshot.transcripts, entry].slice(-MAX_TRANSCRIPTS);
    this.updateSnapshot({ transcripts: next });
  }

  private upsertServerTranscript(role: "user" | "assistant", text: string, final: boolean): void {
    const list = [...this.snapshot.transcripts];
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].role === role) {
        if (!list[i].final) {
          list[i] = {
            ...list[i],
            text,
            final,
            ts: Date.now()
          };
          this.updateSnapshot({ transcripts: list });
          return;
        }
        break;
      }
    }
    this.appendTranscript(role, text, final);
  }

  private sendClientMsg(msg: ClientMsg): boolean {
    if (!this.ws || this.ws.readyState !== WS_OPEN) {
      return false;
    }
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch {
      this.teardownWs();
      if (this.sessionActive && this.isEffectiveOnline()) {
        this.enterSnapshotFallback(!this.chaos.forceWsDrop);
      }
      return false;
    }
  }

  private teardownWs(): void {
    this.wsGen += 1;
    this.clearPingTimer();
    const sock = this.ws;
    this.ws = null;
    if (sock) {
      sock.onopen = null;
      sock.onmessage = null;
      sock.onclose = null;
      sock.onerror = null;
      try {
        sock.close();
      } catch {
        return;
      }
    }
  }

  private clearPingTimer(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearAutoStopTimers(): void {
    if (this.autoStopInterval !== null) {
      clearInterval(this.autoStopInterval);
      this.autoStopInterval = null;
    }
    if (this.autoStopTimeout !== null) {
      clearTimeout(this.autoStopTimeout);
      this.autoStopTimeout = null;
    }
  }

  private updateSnapshot(patch: Partial<SessionSnapshot>): void {
    this.snapshot = {
      ...this.snapshot,
      ...patch
    };
    for (const listener of [...this.listeners]) {
      listener(this.snapshot);
    }
  }
}
