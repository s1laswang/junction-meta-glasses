// WebSocket state machine for /live: connect, start, ping/pong RTT, exponential-backoff reconnect.
import type { ClientMsg, ServerMsg } from "../../../shared/types.ts";
import { MockSocket } from "./mock.ts";
import { withKey } from "./key.ts";

export type ConnState = "idle" | "connecting" | "open" | "reconnecting" | "closed";

export type SocketLike = {
  readyState: number;
  bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
};

export type LiveOptions = {
  session: string;
  mock: boolean;
  buildStart: () => ClientMsg;
  onMessage: (m: ServerMsg) => void;
  onState: (s: ConnState, info: { attempt: number; nextRetryMs: number | null; reason?: string }) => void;
  onRtt?: (rtt: number) => void;
};

const OPEN = 1;
const PING_MS = 3000;
const CONNECT_TIMEOUT_MS = 7000;
const MAX_BACKOFF_MS = 10000;

export function liveUrl(session: string) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return withKey(`${proto}//${location.host}/live?session=${encodeURIComponent(session)}`);
}

export class LiveClient {
  private ws: SocketLike | null = null;
  private want = false;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  state: ConnState = "idle";
  rtt: number | null = null;
  sentFrames = 0;
  sentAudio = 0;
  lastPongAt = 0;

  constructor(private o: LiveOptions) {}

  get isOpen() {
    return this.state === "open" && this.ws?.readyState === OPEN;
  }
  /** True when the socket is backing up (slow uplink): callers should skip frames. */
  get congested() {
    return (this.ws?.bufferedAmount ?? 0) > 512 * 1024;
  }

  start() {
    this.want = true;
    this.attempt = 0;
    this.open();
  }

  private setState(s: ConnState, nextRetryMs: number | null = null, reason?: string) {
    this.state = s;
    this.o.onState(s, { attempt: this.attempt, nextRetryMs, reason });
  }

  private open() {
    this.clearTimers();
    this.setState(this.attempt === 0 ? "connecting" : "reconnecting");
    let ws: SocketLike;
    try {
      ws = this.o.mock ? new MockSocket() : (new WebSocket(liveUrl(this.o.session)) as unknown as SocketLike);
    } catch (e) {
      this.scheduleRetry(String(e));
      return;
    }
    this.ws = ws;
    this.connectTimer = setTimeout(() => {
      if (ws.readyState !== OPEN) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        this.onDrop(ws, "Connection timed out");
      }
    }, CONNECT_TIMEOUT_MS);
    ws.onopen = () => {
      if (this.ws !== ws) return;
      if (this.connectTimer) clearTimeout(this.connectTimer);
      this.attempt = 0;
      // start must be the first message: onState("open") may flush queued text right away
      this.sendRaw(this.o.buildStart());
      this.setState("open");
      this.ping();
      this.pingTimer = setInterval(() => this.ping(), PING_MS);
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      let m: ServerMsg;
      try {
        m = JSON.parse(typeof ev.data === "string" ? ev.data : "") as ServerMsg;
      } catch {
        return; // binary or garbage: ignore
      }
      if (m.type === "pong") {
        this.rtt = Math.max(0, Date.now() - m.t);
        this.lastPongAt = Date.now();
        this.o.onRtt?.(this.rtt);
        return;
      }
      this.o.onMessage(m);
    };
    ws.onerror = () => {
      /* onclose follows */
    };
    ws.onclose = (ev) => this.onDrop(ws, ev.reason || (ev.code === 1000 ? "Closed" : `Connection lost (${ev.code})`));
  }

  private onDrop(ws: SocketLike, reason: string) {
    if (this.ws !== ws) return;
    this.ws = null;
    this.clearTimers();
    if (!this.want) {
      this.setState("closed", null, reason);
      return;
    }
    this.scheduleRetry(reason);
  }

  private scheduleRetry(reason: string) {
    const base = Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.attempt);
    const delay = Math.round(base * (0.75 + Math.random() * 0.5));
    this.attempt++;
    this.setState("reconnecting", delay, reason);
    this.retryTimer = setTimeout(() => this.open(), delay);
  }

  /** Skip the backoff wait (e.g. when the browser reports it is back online). */
  retryNow() {
    if (!this.want || this.state === "open" || this.state === "connecting") return;
    this.clearTimers();
    this.open();
  }

  /**
   * Make sure the server has a live Gemini session: re-send start (profile, lang, source) on an open
   * socket. The server creates a fresh LiveProxy when the old one ended (degraded/closed) and treats
   * it as a profile update when one is still active. If the socket isn't open, reconnect (which sends start).
   */
  resendStart() {
    if (this.isOpen) return void this.sendRaw(this.o.buildStart());
    if (!this.want) return this.start();
    this.retryNow();
  }

  private ping() {
    this.sendRaw({ type: "ping", t: Date.now() });
  }

  private sendRaw(m: ClientMsg) {
    if (!this.ws || this.ws.readyState !== OPEN) return false;
    try {
      this.ws.send(JSON.stringify(m));
      return true;
    } catch {
      return false;
    }
  }

  send(m: ClientMsg) {
    const ok = this.sendRaw(m);
    if (ok && m.type === "frame") this.sentFrames++;
    if (ok && m.type === "audio") this.sentAudio++;
    return ok;
  }

  /** Demo helper: kill the socket as if the network dropped. */
  simulateDrop() {
    const ws = this.ws;
    if (!ws) return;
    try {
      ws.close(4000, "Simulated drop");
    } catch {
      /* ignore */
    }
    this.onDrop(ws, "Simulated connection drop");
  }

  stop() {
    this.want = false;
    this.sendRaw({ type: "event", name: "stop" });
    const ws = this.ws;
    this.ws = null;
    this.clearTimers();
    try {
      ws?.close(1000, "User stopped");
    } catch {
      /* ignore */
    }
    this.setState("closed", null, "Stopped");
  }

  private clearTimers() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.retryTimer = this.pingTimer = this.connectTimer = null;
  }
}
