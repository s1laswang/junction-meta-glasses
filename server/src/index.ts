import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { Modality } from "@google/genai";
import type { ClientMsg, DeviceState } from "../../shared/types.ts";
import { env, REPO_ROOT } from "./env.ts";
import { ai, unaryGate } from "./gemini.ts";
import { addHud, getHub, getOrCreateHub, hubStats, hudTarget, markLatest, resolveHub, setDevice, safeSend } from "./hub.ts";
import { ledger, stats } from "./ledger.ts";
import { eleven, elevenEnabled, elevenStream, scribeToken } from "./elevenlabs.ts";
import { requireKey, wsKeyOk } from "./auth.ts";
import { parseGs1 } from "./gs1.ts";
import { LiveProxy } from "./live.ts";
import { errSummary, log, shortId } from "./log.ts";
import { jpegSharpness, toProfile, verify } from "./verify.ts";

const MAX_WS_MSG = 4 * 1024 * 1024;
// hardware-proof counters (no content): frames accepted from the glasses bridge since start
const ingest = { frames: 0, dropped: 0, lastAt: 0 };

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  // optional access key (HOLDUP_KEY); /api/health and static files stay public
  app.use(["/api", "/ingest"], requireKey);

  // ---------- health (Gemini reachability cached 30 s) ----------
  let healthCache: { at: number; ok: boolean } | undefined;
  app.get("/api/health", async (_req, res) => {
    if (!healthCache || Date.now() - healthCache.at > 30_000) {
      let ok = false;
      try {
        if (env.apiKey) { await ai.models.get({ model: env.verifyModels[0] }); ok = true; }
      } catch (e) { log("health.gemini_down", { err: errSummary(e) }); }
      healthCache = { at: Date.now(), ok };
    }
    res.json({
      ok: true,
      gemini: healthCache.ok ? "ok" : "down",
      models: { live: env.liveModels, verify: env.verifyModels, tts: env.ttsModels },
      version: env.version,
      ...hubStats(),
      // hardware proof (docs/HARDWARE_LOG.md): latest session's camera source + glasses state, no content
      glasses: (() => {
        const h = resolveHub(undefined);
        return {
          source: h?.source ?? null,
          device: h?.device ?? null,
          framesAccepted: ingest.frames,
          framesDropped: ingest.dropped,
          lastFrameAgoS: ingest.lastAt ? Math.round((Date.now() - ingest.lastAt) / 100) / 10 : null,
        };
      })(),
    });
  });

  app.get("/api/stats", (_req, res) => { res.json(stats()); });

  // ---------- snapshot verify ----------
  app.post("/api/verify", express.json({ limit: "12mb" }), async (req, res) => {
    const frames = Array.isArray(req.body?.frames) ? (req.body.frames as unknown[]).filter((f): f is string => typeof f === "string" && f.length > 100) : [];
    const hub = typeof req.body?.session === "string" && req.body.session ? getHub(req.body.session) : undefined;
    let picked: string[];
    let src: string;
    if (frames.length) {
      // without client sharpness, prefer the largest JPEGs (more detail) among the last 3
      picked = frames.slice(-3).map((f, i) => ({ f, i, s: f.length })).sort((a, b) => b.s - a.s).slice(0, 2).map((x) => x.f);
      src = "body";
    } else if (hub) {
      // snapshot mode with the glasses camera: use the session's ring buffer (2 sharpest recent frames)
      picked = hub.ring.pick(2).map((f) => f.data);
      src = "ring";
      if (!picked.length) { res.status(409).json({ type: "error", code: "no_frames", message: "no recent frames for this session", recoverable: true }); return; }
    } else {
      res.status(400).json({ type: "error", code: "bad_input", message: "frames[] (base64 JPEG) or an active session required", recoverable: true });
      return;
    }
    const profile = req.body?.profile ? toProfile(req.body.profile) : hub?.profile ?? toProfile(undefined);
    const t = Date.now();
    const r = await verify(picked, profile, typeof req.body?.question === "string" ? req.body.question : undefined, "verify", hub?.freshCode());
    log("api.verify", { level: r.verdict.level, model: r.model ?? "none", ms: Date.now() - t, n_frames: picked.length, src });
    res.json(r.verdict);
  });

  // ---------- TTS (optional; browser speechSynthesis is the fallback) ----------
  app.post("/api/tts", express.json({ limit: "64kb" }), async (req, res) => {
    const text = typeof req.body?.text === "string" ? req.body.text.slice(0, 600) : "";
    if (!text) { res.status(400).json({ type: "error", code: "bad_input", message: "text required", recoverable: true }); return; }
    for (const model of env.ttsModels) {
      const t = Date.now();
      try {
        const r = await unaryGate.run(() => ai.models.generateContent({
          model,
          contents: [{ role: "user", parts: [{ text: `Say calmly and clearly: ${text}` }] }],
          config: { responseModalities: [Modality.AUDIO], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: process.env.TTS_VOICE ?? "Kore" } } } },
        }));
        const part = r.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
        if (!part?.inlineData?.data) throw new Error("empty reply");
        const pcm = Buffer.from(part.inlineData.data, "base64");
        const rate = Number(/rate=(\d+)/.exec(part.inlineData.mimeType ?? "")?.[1] ?? 24000);
        ledger({ feature: "tts", model, latency_s: (Date.now() - t) / 1000, ok: true, in: r.usageMetadata?.promptTokenCount ?? 0, out: r.usageMetadata?.candidatesTokenCount ?? 0 });
        res.type("audio/wav").send(wav(pcm, rate));
        return;
      } catch (e) {
        ledger({ feature: "tts", model, latency_s: (Date.now() - t) / 1000, ok: false });
        log("tts.failed", { model, err: errSummary(e) });
      }
    }
    res.status(503).json({ type: "error", code: "gemini_unavailable", message: "TTS unavailable, use speechSynthesis", recoverable: true });
  });

  // ---------- ElevenLabs (optional; see server/src/elevenlabs.ts) ----------
  // Streaming TTS for snapshot-mode verdicts: opt-in (ELEVENLABS_LIVE=1) because the text names the user's medicine.
  app.post("/api/tts/eleven", express.json({ limit: "16kb" }), async (req, res) => {
    const text = typeof req.body?.text === "string" ? req.body.text.slice(0, 600) : "";
    const lang = ["en", "fi", "sv"].includes(req.body?.lang) ? req.body.lang : "en";
    if (!elevenEnabled() || !eleven.live) { res.status(404).json({ type: "error", code: "disabled", message: "ElevenLabs live TTS disabled, use /api/tts or speechSynthesis", recoverable: true }); return; }
    if (!text) { res.status(400).json({ type: "error", code: "bad_input", message: "text required", recoverable: true }); return; }
    try {
      const { body, ttfbS } = await elevenStream(text, lang);
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("X-First-Byte-S", ttfbS.toFixed(3));
      const reader = body.getReader();
      for (;;) { const n = await reader.read(); if (n.done) break; res.write(Buffer.from(n.value)); }
      res.end();
    } catch (e) {
      log("tts_eleven.failed", { err: errSummary(e) });
      if (!res.headersSent) res.status(503).json({ type: "error", code: "tts_unavailable", message: "ElevenLabs unavailable, use speechSynthesis", recoverable: true });
      else res.end();
    }
  });
  // Single-use Scribe realtime token for the browser (the API key stays here).
  app.get("/api/stt/token", async (_req, res) => {
    if (!elevenEnabled()) { res.status(404).json({ type: "error", code: "disabled", message: "ELEVENLABS_API_KEY not set", recoverable: true }); return; }
    try { res.json({ token: await scribeToken(), model: process.env.ELEVENLABS_STT_MODEL ?? "scribe_v2_realtime" }); }
    catch (e) { log("stt_token.failed", { err: errSummary(e) }); res.status(503).json({ type: "error", code: "stt_unavailable", message: "token failed", recoverable: true }); }
  });

  // ---------- glasses bridge ingest (session optional: defaults to the latest live session) ----------
  app.post("/ingest/frame", express.raw({ type: ["image/jpeg", "application/octet-stream"], limit: "6mb" }), (req, res) => {
    const buf = req.body as Buffer;
    if (!Buffer.isBuffer(buf) || buf.length < 100) { res.status(400).json({ type: "error", code: "bad_input", message: "image/jpeg body required", recoverable: true }); return; }
    const hub = resolveHub(req.query.session as string | undefined);
    if (hub && hub.source === "glasses") {
      const data = buf.toString("base64");
      const sharpness = Number(req.query.sharpness) || jpegSharpness(buf);
      hub.addFrame({ data, sharpness, ts: Date.now(), bytes: buf.length, source: "glasses" });
      (hub.live as LiveProxy | undefined)?.frame(data);
      // EU FMD DataMatrix on glasses frames (the phone decodes its own camera): throttled, self-disabling when slow
      if (hub.has("datamatrix") && hub.live?.active) void hub.dm.maybe(buf, (c) => hub.setCode(c));
      ingest.frames++; ingest.lastAt = Date.now();
    } else ingest.dropped++; // no session, or the phone chose its own camera: frame dropped (never stored)
    res.status(204).end();
  });
  app.post("/ingest/state", express.json({ limit: "16kb" }), (req, res) => {
    const b = req.body ?? {};
    // null/missing = unknown: never coerce `worn` to false (that would fire a false "glasses taken off" fallback)
    const device = {
      connected: !!b.connected,
      worn: typeof b.worn === "boolean" ? b.worn : null,
      streaming: !!b.streaming,
      battery: typeof b.battery === "number" && Number.isFinite(b.battery) ? b.battery : null,
      source: "glasses",
    } as unknown as DeviceState; // contract proposal: DeviceState.worn: boolean | null
    setDevice(device, req.query.session as string | undefined);
    res.status(204).end();
  });

  // ---------- production: serve the web build ----------
  const dist = path.join(REPO_ROOT, "web", "dist");
  if (fs.existsSync(dist)) {
    // dotfiles: "allow" so /hud/.well-known/meta-wearables-manifest.json is served (docs/HUD_SPEC.md);
    // /hud redirects to /hud/ (static's directory redirect), which serves dist/hud/index.html
    app.use(express.static(dist, {
      index: "index.html", dotfiles: "allow", maxAge: "1h",
      setHeaders: (res, file) => { if (/\.(html|json)$/.test(file)) res.setHeader("Cache-Control", "no-cache"); },
    }));
    app.use((req, res, next) => {
      if ((req.method !== "GET" && req.method !== "HEAD") || /^\/(api|ingest|live|hud-ws)\b/.test(req.path)) return next();
      const hudIndex = path.join(dist, "hud", "index.html");
      const isHud = req.path === "/hud" || req.path.startsWith("/hud/");
      res.setHeader("Cache-Control", "no-cache");
      // dotfiles "allow": the checkout itself may live under a dot-directory (e.g. .claude/worktrees)
      res.sendFile(isHud && fs.existsSync(hudIndex) ? hudIndex : path.join(dist, "index.html"), { dotfiles: "allow" });
    });
  }
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof err?.status === "number" ? err.status : 500;
    log("http.error", { status, kind: String(err?.type ?? err?.name ?? "error").slice(0, 40) });
    res.status(status).json({ type: "error", code: status === 413 ? "too_large" : status < 500 ? "bad_input" : "server_error", message: status < 500 ? "invalid request" : "server error", recoverable: true });
  });
  app.use((_req, res) => { res.status(404).json({ type: "error", code: "not_found", message: "not found", recoverable: false }); });
  return app;
}

function wav(pcm: Buffer, rate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// ---------- WebSockets ----------
function onLive(ws: WebSocket, sessionParam: string | null) {
  const id = sessionParam && /^[\w-]{4,64}$/.test(sessionParam) ? sessionParam : crypto.randomUUID();
  const hub = getOrCreateHub(id);
  hub.clients.add(ws);
  log("ws.live.connect", { session: shortId(id) });
  const err = (code: string, message: string) => safeSend(ws, JSON.stringify({ type: "error", code, message, recoverable: true }));

  ws.on("message", (raw, isBinary) => {
    if (isBinary) return err("bad_input", "send JSON text frames");
    let msg: ClientMsg;
    try { msg = JSON.parse(raw.toString()); } catch { return err("bad_input", "invalid JSON"); }
    const live = hub.live as LiveProxy | undefined;
    switch (msg?.type) {
      case "start": {
        hub.profile = toProfile(msg.profile);
        if (msg.lang) hub.profile.lang = String(msg.lang).slice(0, 16);
        if (live?.active) { log("ws.live.profile_update", { session: shortId(id) }); return; }
        // feature flags: server FEATURES intersected with what the phone asked for (all, if it didn't say)
        const want = Array.isArray(msg.features) ? new Set<string>(msg.features) : null;
        hub.features = new Set(env.features.filter((f) => !want || want.has(f)));
        const proxy = new LiveProxy(hub, { lang: hub.profile.lang || "en", voice: msg.voice !== false });
        hub.live = proxy;
        markLatest(hub);
        if (msg.source === "phone" || msg.source === "glasses") {
          hub.source = msg.source;
          hub.emit({ type: "device", device: { ...(hub.device ?? { connected: msg.source === "glasses", worn: msg.source === "glasses", battery: null, streaming: false }), source: msg.source } }, { clients: false });
        }
        void proxy.start();
        return;
      }
      case "audio":
        if (typeof msg.data === "string") live?.audio(msg.data);
        return;
      case "frame": {
        if (typeof msg.data !== "string" || msg.data.length < 100) return err("bad_input", "frame.data must be base64 JPEG");
        const sharp = typeof msg.sharpness === "number" ? Math.max(0, Math.min(1, msg.sharpness)) : jpegSharpness(Buffer.from(msg.data, "base64"));
        hub.addFrame({ data: msg.data, sharpness: sharp, ts: Date.now(), bytes: Math.round(msg.data.length * 0.75), source: "phone" });
        live?.frame(msg.data);
        return;
      }
      case "text":
        if (typeof msg.text === "string" && msg.text.trim()) {
          if (live?.active) live.text(msg.text);
          else err("bad_input", "send start first");
        }
        return;
      case "event":
        if (live) live.handleEvent(msg.name);
        return;
      case "ping":
        safeSend(ws, JSON.stringify({ type: "pong", t: msg.t }));
        return;
      case "datamatrix": {
        if (!hub.has("datamatrix") || typeof msg.raw !== "string") return;
        const code = parseGs1(msg.raw);
        if (code) { hub.setCode(code); log("dm_decoded", { n: 1, src: "phone" }); } // never log the code itself
        return;
      }
      case "profile_add_result":
        if (typeof msg.proposalId === "string") live?.resolveProposal(msg.proposalId, msg.accepted === true, msg.med);
        return;
      case "source":
        if (msg.source === "phone" || msg.source === "glasses") {
          hub.source = msg.source;
          if (hub.device) hub.emit({ type: "device", device: { ...hub.device, source: msg.source } }, { clients: false });
          log("ws.live.source", { session: shortId(id), source: msg.source });
        }
        return;
      default:
        err("bad_input", "unknown message type");
    }
  });
  ws.on("close", () => {
    hub.clients.delete(ws);
    log("ws.live.close", { session: shortId(id), remaining: hub.clients.size });
    if (hub.clients.size === 0) {
      hub.live?.stop("client disconnected");
      hub.dropFrames(); // privacy: frames never outlive the session
    }
  });
  ws.on("error", () => { /* close follows */ });
}

function onHud(ws: WebSocket, sessionParam: string | null) {
  addHud(ws, sessionParam);
  log("ws.hud.connect", { session: sessionParam ? shortId(sessionParam) : "latest" });
  ws.on("message", (raw) => {
    try {
      const m = JSON.parse(raw.toString());
      if (m?.type !== "event" || !["log_dose", "repeat", "dismiss"].includes(m.name)) return;
      const hub = hudTarget(sessionParam);
      if (!hub) return;
      // Contract (Sat 16:40): forward to the phone, which owns the dose log and decides what to do
      // (it sends {type:"event"} back on /live for repeat / log_dose).
      const s = JSON.stringify({ type: "hud_event", name: m.name });
      for (const c of hub.clients) safeSend(c, s);
      log("ws.hud.event", { session: shortId(hub.id), name: m.name });
    } catch { /* ignore */ }
  });
  ws.on("error", () => { /* */ });
}

export function startServer(port = env.port): Promise<http.Server> {
  const app = createApp();
  const server = http.createServer(app);
  const wssLive = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_MSG });
  const wssHud = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    const session = url.searchParams.get("session");
    if ((url.pathname === "/live" || url.pathname === "/hud-ws") && !wsKeyOk(req, url)) {
      // complete the handshake so the client sees a proper close code (4401) instead of a network error
      const wss = url.pathname === "/live" ? wssLive : wssHud;
      wss.handleUpgrade(req, socket, head, (ws) => ws.close(4401, "unauthorized"));
      return;
    }
    if (url.pathname === "/live") wssLive.handleUpgrade(req, socket, head, (ws) => onLive(ws, session));
    else if (url.pathname === "/hud-ws") wssHud.handleUpgrade(req, socket, head, (ws) => onHud(ws, session));
    else socket.destroy();
  });
  return new Promise((resolve) => server.listen(port, () => {
    log("server.listening", { port: (server.address() as any)?.port ?? port, gemini_key: !!env.apiKey, access_key: !!process.env.HOLDUP_KEY, live: env.liveModels[0], verify: env.verifyModels[0] });
    resolve(server);
  }));
}

process.on("unhandledRejection", (e) => log("unhandled_rejection", { err: errSummary(e) }));
process.on("uncaughtException", (e) => log("uncaught_exception", { err: errSummary(e) }));

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!env.apiKey) log("server.warning_no_gemini_key");
  void startServer();
}
export { getHub };
