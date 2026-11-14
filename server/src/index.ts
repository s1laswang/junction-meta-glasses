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
import { addHud, getHub, getOrCreateHub, hasHud, hubStats, hudTarget, markLatest, resolveHub, setDevice, safeSend } from "./hub.ts";
import { ledger, stats } from "./ledger.ts";
import { LiveProxy } from "./live.ts";
import { errSummary, log, shortId } from "./log.ts";
import { jpegSharpness, toProfile, verify } from "./verify.ts";

const MAX_WS_MSG = 4 * 1024 * 1024;

export function createApp(opts?: { repoRoot?: string }) {
  const root = opts?.repoRoot ?? REPO_ROOT;
  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    next();
  });
  app.use("/api", (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });

  let healthCache: { at: number; ok: boolean } | undefined;
  app.get("/api/health", async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
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
    });
  });

  app.get("/api/stats", (_req, res) => { res.setHeader("Cache-Control", "no-store"); res.json(stats()); });

  const evalSummaryFile = path.join(root, "eval", "combined_summary.json");
  let evalCache: { at: number; summary: Record<string, unknown> } | undefined;
  app.get("/api/eval-summary", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const now = Date.now();
    if (evalCache && now - evalCache.at <= 10_000) {
      res.json({ ok: true, summary: evalCache.summary });
      return;
    }
    try {
      if (!fs.existsSync(evalSummaryFile)) {
        evalCache = undefined;
        res.json({ ok: false, summary: null });
        return;
      }
      const parsed: unknown = JSON.parse(fs.readFileSync(evalSummaryFile, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        evalCache = undefined;
        res.json({ ok: false, summary: null });
        return;
      }
      const rec = parsed as Record<string, any>;
      const inv = rec.safety_invariants && typeof rec.safety_invariants === "object" ? rec.safety_invariants : {};
      const existingHm = rec.headline_metrics && typeof rec.headline_metrics === "object" && !Array.isArray(rec.headline_metrics) ? rec.headline_metrics : {};
      const summary: Record<string, unknown> = {
        ...rec,
        headline_metrics: {
          ...(typeof inv.strength_min_conf === "number" ? { never_guess_strength_min_conf: inv.strength_min_conf } : {}),
          overall_verdict_accuracy: rec.overall_verdict_accuracy ?? null,
          total_confident_wrong_dose_count: rec.total_confident_wrong_dose_count ?? null,
          occluded_abstention_rate: rec.occluded_abstention_rate ?? null,
          total_label_cases_evaluated: rec.total_label_cases_evaluated ?? 0,
          ...existingHm,
        },
      };
      evalCache = { at: now, summary };
      res.json({ ok: true, summary });
    } catch (e) {
      evalCache = undefined;
      log("eval_summary.read_failed", { err: errSummary(e) });
      res.json({ ok: false, summary: null });
    }
  });

  app.post("/api/verify", express.json({ limit: "12mb" }), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const frames = Array.isArray(req.body?.frames) ? (req.body.frames as unknown[]).filter((f): f is string => typeof f === "string" && f.length > 100) : [];
    if (!frames.length) { res.status(400).json({ type: "error", code: "bad_input", message: "frames[] (base64 JPEG) required", recoverable: true }); return; }
    const sessionParam = typeof req.body?.session === "string" ? req.body.session : undefined;
    const picked = frames.slice(-3).map((f, i) => ({ f, i, s: jpegSharpness(Buffer.from(f, "base64")) || f.length * 1e-9 })).sort((a, b) => b.s - a.s).slice(0, 2).map((x) => x.f);
    const t = Date.now();
    const r = await verify(picked, toProfile(req.body?.profile), typeof req.body?.question === "string" ? req.body.question : undefined);
    const hub = resolveHub(sessionParam);
    if (hub) hub.emit({ type: "verdict", verdict: r.verdict }, { clients: false });
    log("api.verify", { level: r.verdict.level, model: r.model ?? "none", ms: Date.now() - t, n_frames: picked.length });
    res.json(r.verdict);
  });

  app.post("/api/tts", express.json({ limit: "64kb" }), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
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

  app.post("/ingest/frame", express.raw({ type: ["image/jpeg", "application/octet-stream"], limit: "6mb" }), (req, res) => {
    const buf = req.body as Buffer;
    if (!Buffer.isBuffer(buf) || buf.length < 100) { res.status(400).json({ type: "error", code: "bad_input", message: "image/jpeg body required", recoverable: true }); return; }
    const hub = resolveHub(req.query.session as string | undefined);
    if (hub) {
      const data = buf.toString("base64");
      const sharpness = Number(req.query.sharpness) || jpegSharpness(buf);
      hub.ring.push({ data, sharpness, ts: Date.now(), bytes: buf.length, source: "glasses" });
      (hub.live as LiveProxy | undefined)?.frame(data);
    }
    res.status(204).end();
  });
  app.post("/ingest/state", express.json({ limit: "16kb" }), (req, res) => {
    const b = req.body ?? {};
    const device: DeviceState = {
      connected: !!b.connected, worn: !!b.worn, streaming: !!b.streaming,
      battery: typeof b.battery === "number" ? b.battery : null, source: "glasses",
    };
    setDevice(device, req.query.session as string | undefined);
    res.status(204).end();
  });

  app.use("/deck", express.static(path.join(root, "deck"), { index: "index.html", maxAge: "1h" }));
  const propsHtml = path.join(root, "docs", "printable-props.html");
  app.get("/printable-props.html", (_req, res, next) => {
    if (!fs.existsSync(propsHtml)) { next(); return; }
    res.sendFile(propsHtml);
  });
  const handoutHtml = path.join(root, "docs", "judge-handout.html");
  app.get("/judge-handout.html", (_req, res, next) => {
    if (!fs.existsSync(handoutHtml)) { next(); return; }
    res.sendFile(handoutHtml);
  });
  const posterHtml = path.join(root, "docs", "architecture-poster.html");
  app.get("/architecture-poster.html", (_req, res, next) => {
    if (!fs.existsSync(posterHtml)) { next(); return; }
    res.sendFile(posterHtml);
  });

  const dist = path.join(root, "web", "dist");
  app.use(express.static(dist, { index: "index.html", maxAge: "1h", dotfiles: "allow" }));
  app.use((req, res, next) => {
    if (req.method !== "GET" || /^\/(api|ingest|live|hud-ws|deck)\b/.test(req.path) || /\.html$/i.test(req.path)) return next();
    const indexHtml = path.join(dist, "index.html");
    if (!fs.existsSync(indexHtml)) return next();
    res.sendFile(indexHtml);
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

function onLive(ws: WebSocket, sessionParam: string | null) {
  const id = sessionParam && /^[\w-]{4,64}$/.test(sessionParam) ? sessionParam : crypto.randomUUID();
  const hub = getOrCreateHub(id);
  hub.clients.add(ws);
  if (hub.device || hasHud(hub)) hub.replayClient(ws);
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
        const proxy = new LiveProxy(hub, { lang: hub.profile.lang || "en", voice: msg.voice !== false });
        hub.live = proxy;
        markLatest(hub);
        if (msg.source === "phone" || msg.source === "glasses") {
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
        hub.ring.push({ data: msg.data, sharpness: sharp, ts: Date.now(), bytes: Math.round(msg.data.length * 0.75), source: "phone" });
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
      default:
        err("bad_input", "unknown message type");
    }
  });
  ws.on("close", () => {
    hub.clients.delete(ws);
    log("ws.live.close", { session: shortId(id), remaining: hub.clients.size });
    if (hub.clients.size === 0) {
      hub.live?.stop("client disconnected");
      hub.ring.clear();
    }
  });
  ws.on("error", () => {});
}

function onHud(ws: WebSocket, sessionParam: string | null) {
  addHud(ws, sessionParam);
  log("ws.hud.connect", { session: sessionParam ? shortId(sessionParam) : "latest" });
  ws.on("message", (raw) => {
    try {
      const m = JSON.parse(raw.toString());
      if (m?.type !== "event") return;
      const hub = hudTarget(sessionParam);
      if (!hub) return;
      const live = hub.live as LiveProxy | undefined;
      if (live?.active && (m.name === "repeat" || m.name === "log_dose")) {
        live.handleEvent(m.name);
      } else if (m.name === "log_dose" && hub.lastVerdict?.matchedMedId) {
        hub.profile.doseLog.push({ medId: hub.lastVerdict.matchedMedId, ts: Date.now() });
        hub.emit({ type: "verdict", verdict: { ...hub.lastVerdict, takenToday: true } });
      } else if (m.name === "repeat" && hub.lastVerdict) {
        hub.emit({ type: "verdict", verdict: hub.lastVerdict });
      }
    } catch {}
  });
  ws.on("error", () => {});
}

export function startServer(port = env.port, opts?: { repoRoot?: string }): Promise<http.Server> {
  const app = createApp(opts);
  const server = http.createServer(app);
  const wssLive = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_MSG });
  const wssHud = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    const session = url.searchParams.get("session");
    if (url.pathname === "/live") wssLive.handleUpgrade(req, socket, head, (ws) => onLive(ws, session));
    else if (url.pathname === "/hud-ws") wssHud.handleUpgrade(req, socket, head, (ws) => onHud(ws, session));
    else socket.destroy();
  });
  return new Promise((resolve) => server.listen(port, () => {
    log("server.listening", { port: (server.address() as any)?.port ?? port, gemini_key: !!env.apiKey, live: env.liveModels[0], verify: env.verifyModels[0] });
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
