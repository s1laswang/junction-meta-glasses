// Robustness checks against real Gemini (each case is short). Usage: tsx scripts/robust.ts [case...]
// cases: audio fallback idle drop reconnect hud input auth snapshot
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { Modality } from "@google/genai";
import type { Profile, ServerMsg } from "../../shared/types.ts";

process.env.HOLDUP_QUIET ??= "1";
const only = process.argv.slice(2);
if (!only.length || only.includes("fallback")) process.env.LIVE_MODEL = "gemini-does-not-exist-live";
if (!only.length || only.includes("idle")) process.env.IDLE_STOP_MS = "5000";
// every case runs with an access key, so the key path is exercised everywhere
const KEY = (process.env.HOLDUP_KEY = "robust-test-key-123");
const KH = { "x-holdup-key": KEY };
const { SERVER_DIR } = await import("../src/env.ts");
const { startServer, getHub } = await import("../src/index.ts");
const { ai } = await import("../src/gemini.ts");

const jpeg = fs.readFileSync(path.join(SERVER_DIR, "fixtures", "amlodipine.jpg")).toString("base64");
const profile: Profile = {
  meds: [{ id: "aml", name: "Amlodipine", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"] }],
  allergies: ["peanut"], avoid: ["NSAIDs"], doseLog: [], lang: "en",
};
const server = await startServer(0);
const port = (server.address() as any).port;
const results: [string, boolean, string][] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Client {
  ws: WebSocket; msgs: (ServerMsg & { at: number })[] = []; t0 = Date.now(); frameTimer?: NodeJS.Timeout;
  constructor(readonly session: string) {
    this.ws = new WebSocket(`ws://localhost:${port}/live?session=${session}&key=${KEY}`);
    this.ws.on("message", (d) => this.msgs.push({ ...JSON.parse(d.toString()), at: Date.now() - this.t0 }));
  }
  open() { return new Promise<void>((r) => this.ws.once("open", () => r())); }
  send(m: unknown) { this.ws.send(JSON.stringify(m)); }
  start(frames = true, source: "phone" | "glasses" = "phone") {
    this.send({ type: "start", profile, lang: "en", voice: true, source });
    if (frames) { const f = () => this.ws.readyState === 1 && this.send({ type: "frame", data: jpeg, w: 768, h: 768, sharpness: 0.85, ts: Date.now() }); f(); this.frameTimer = setInterval(f, 1000); }
  }
  async waitFor(pred: (m: ServerMsg) => boolean, ms: number, from = 0) {
    const end = Date.now() + ms;
    while (Date.now() < end) { const i = this.msgs.slice(from).findIndex(pred); if (i >= 0) return this.msgs[from + i]; await sleep(50); }
    return undefined;
  }
  types(from = 0) { return this.msgs.slice(from).map((m) => m.type + ("live" in m ? `:${m.live}` : "")); }
  close() { clearInterval(this.frameTimer); this.ws.close(); }
}
const finalSaid = (c: Client, from = 0) => c.msgs.slice(from).filter((m): m is any => m.type === "transcript" && m.role === "assistant" && (m as any).final).map((m: any) => m.text).join(" | ");

async function tts16k(text: string): Promise<Buffer> {
  const r = await ai.models.generateContent({
    model: "gemini-3.8-flash-tts", contents: [{ role: "user", parts: [{ text: `Say: ${text}` }] }],
    config: { responseModalities: [Modality.AUDIO], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } } } },
  });
  const b = Buffer.from(r.candidates![0].content!.parts!.find((p) => p.inlineData)!.inlineData!.data!, "base64");
  const src = new Int16Array(b.buffer, b.byteOffset, b.length / 2);
  const n = Math.floor(src.length * 16000 / 24000), out = new Int16Array(n);
  for (let i = 0; i < n; i++) { const x = i * 1.5, j = Math.floor(x), f = x - j; out[i] = Math.round(src[j] * (1 - f) + (src[j + 1] ?? 0) * f); }
  return Buffer.from(out.buffer);
}
async function streamAudio(c: Client, pcm: Buffer) {
  const chunk = 3200; // 100 ms @ 16 kHz PCM16
  const silence = Buffer.alloc(chunk * 20); // 2 s of silence so VAD closes the turn
  const all = Buffer.concat([Buffer.alloc(chunk * 3), pcm, silence]);
  for (let i = 0; i < all.length; i += chunk) { c.send({ type: "audio", data: all.subarray(i, i + chunk).toString("base64") }); await sleep(100); }
}

async function run(name: string, fn: () => Promise<[boolean, string]>) {
  if (only.length && !only.includes(name)) return;
  try { const [ok, info] = await fn(); results.push([name, ok, info]); }
  catch (e) { results.push([name, false, String(e)]); }
  console.log(`${results.at(-1)![1] ? "PASS" : "FAIL"} ${name}: ${results.at(-1)![2]}`);
}

await run("fallback", async () => {
  const c = new Client("rb-fallback"); await c.open(); c.start();
  const ready = await c.waitFor((m) => m.type === "ready", 15000) as any;
  c.close();
  return [!!ready && ready.model !== "gemini-does-not-exist-live", `ready model=${ready?.model}; ${c.types().filter((t) => t !== "audio").join(",")}`];
});

await run("audio", async () => {
  const pcm = await tts16k("Hey, is this my evening pill?");
  const c = new Client("rb-audio"); await c.open(); c.start();
  await c.waitFor((m) => m.type === "ready", 15000); await sleep(2500);
  const t = Date.now();
  const from = c.msgs.length;
  const speechEnd = t - c.t0 + 300 + pcm.length / 32; // ms on the client clock
  await streamAudio(c, pcm);
  const v = await c.waitFor((m) => m.type === "verdict", 20000) as any;
  await c.waitFor((m) => m.type === "transcript" && m.role === "assistant" && m.final && /amlodipine/i.test(m.text), 15000);
  const user = c.msgs.filter((m: any) => m.type === "transcript" && m.role === "user" && m.final).map((m: any) => m.text).join(" | ");
  const at = (p: (m: any) => boolean) => { const m = c.msgs.slice(from).find(p); return m ? Math.round(m.at - speechEnd) : null; };
  console.log("  after end of speech (ms):", JSON.stringify({
    first_user_transcript: at((m) => m.type === "transcript" && m.role === "user"),
    checking: at((m) => m.type === "checking"), verdict: at((m) => m.type === "verdict"),
    first_audio: at((m) => m.type === "audio"), first_assistant_text: at((m) => m.type === "transcript" && m.role === "assistant"),
  }));
  c.close();
  return [!!v && /pill/i.test(user), `user heard="${user}" verdict=${v?.verdict.level} after ${Date.now() - t} ms (incl. ${(pcm.length / 32000).toFixed(1)} s speech + 2 s silence); said="${finalSaid(c)}"`];
});

await run("idle", async () => {
  const c = new Client("rb-idle"); await c.open(); c.start(false);
  const closed = await c.waitFor((m) => m.type === "status" && m.live === "closed", 12000) as any;
  c.close();
  return [!!closed && /auto-stopped/.test(closed.detail ?? ""), `closed at ${closed?.at} ms: ${closed?.detail}`];
});

await run("drop", async () => {
  const c = new Client("rb-drop"); await c.open(); c.start();
  await c.waitFor((m) => m.type === "ready", 15000);
  c.send({ type: "text", text: "Remember the word banana. Just say OK." });
  await c.waitFor((m) => m.type === "transcript" && (m as any).final && m.role === "assistant", 15000);
  await sleep(1500);
  const before = c.msgs.length;
  (getHub("rb-drop")!.live as any).debugDrop();
  const re = await c.waitFor((m) => m.type === "ready", 15000, before) as any;
  c.send({ type: "text", text: "What word did I ask you to remember? One word." });
  await c.waitFor((m) => m.type === "transcript" && (m as any).final && m.role === "assistant", 15000, before);
  const said = finalSaid(c, before);
  c.close();
  return [!!re && /banana/i.test(said), `after drop: ${c.types(before).filter((t) => t !== "audio" && t !== "transcript").join(",")}; recalled="${said}"`];
});

await run("reconnect", async () => {
  const a = new Client("rb-reconn"); await a.open(); a.start();
  await a.waitFor((m) => m.type === "ready", 15000);
  a.send({ type: "text", text: "I keep my pills in the blue drawer. Just say OK." });
  await a.waitFor((m) => m.type === "transcript" && (m as any).final && m.role === "assistant", 15000);
  await sleep(1500);
  a.close(); await sleep(500);
  const b = new Client("rb-reconn"); await b.open(); b.start();
  await b.waitFor((m) => m.type === "ready", 15000);
  b.send({ type: "text", text: "Which colour drawer did I say I keep my pills in? One word." });
  await b.waitFor((m) => m.type === "transcript" && (m as any).final && m.role === "assistant", 15000);
  const said = finalSaid(b); b.close();
  return [/blue/i.test(said), `phone reconnected with same session id; recalled="${said}"`];
});

await run("hud", async () => {
  const c = new Client("rb-hud"); await c.open(); c.start(false);
  await c.waitFor((m) => m.type === "ready", 15000);
  // device state with unknown `worn` must stay null
  await fetch(`http://localhost:${port}/ingest/state`, { method: "POST", headers: { "content-type": "application/json", ...KH }, body: JSON.stringify({ connected: true, worn: null, battery: null, streaming: true }) });
  const hud = new WebSocket(`ws://localhost:${port}/hud-ws?key=${KEY}`); // no session -> latest
  const hudMsgs: any[] = [];
  hud.on("message", (d) => hudMsgs.push(JSON.parse(d.toString())));
  await new Promise((r) => hud.once("open", r));
  const conn = await c.waitFor((m) => m.type === "hud" && m.connected, 3000);
  hud.send(JSON.stringify({ type: "event", name: "log_dose" }));
  const ev = await c.waitFor((m) => m.type === "hud_event" && m.name === "log_dose", 3000);
  hud.close();
  const disc = await c.waitFor((m) => m.type === "hud" && !m.connected, 3000);
  const dev = hudMsgs.find((m) => m.type === "device");
  c.close();
  return [!!conn && !!ev && !!disc && dev?.device.worn === null, `hud connected=${!!conn} hud_event=${!!ev} disconnected=${!!disc} replayed device worn=${dev?.device.worn} battery=${dev?.device.battery}`];
});

await run("input", async () => {
  const c = new Client("rb-input"); await c.open();
  c.ws.send("not json"); c.send({ type: "nope" }); c.send({ type: "text", text: "hi" }); c.send({ type: "event", name: "log_dose" });
  c.send({ type: "frame", data: "short" });
  c.start(false); await c.waitFor((m) => m.type === "ready", 15000);
  c.send({ type: "event", name: "log_dose" });
  await sleep(500);
  const errs = c.msgs.filter((m) => m.type === "error").map((m: any) => m.code);
  const r1 = await fetch(`http://localhost:${port}/ingest/frame?session=does-not-exist`, { method: "POST", headers: { "content-type": "image/jpeg", ...KH }, body: Buffer.from(jpeg, "base64") });
  const r2 = await fetch(`http://localhost:${port}/api/verify`, { method: "POST", headers: { "content-type": "application/json", ...KH }, body: "{bad" });
  c.send({ type: "event", name: "stop" });
  const closed = await c.waitFor((m) => m.type === "status" && m.live === "closed", 3000);
  c.close();
  return [errs.length >= 4 && r1.status === 204 && r2.status === 400 && !!closed, `errors=${errs.join(",")} ingest(unknown)=${r1.status} verify(bad json)=${r2.status} stop->closed=${!!closed}`];
});

await run("auth", async () => {
  const base = `http://localhost:${port}`;
  const st = async (p: string, init: RequestInit = {}) => (await fetch(base + p, init)).status;
  const json = { "content-type": "application/json" };
  const checks: Record<string, boolean> = {
    health_public: (await st("/api/health")) === 200,
    stats_nokey_401: (await st("/api/stats")) === 401,
    stats_wrongkey_401: (await st("/api/stats?key=nope")) === 401,
    stats_query_200: (await st(`/api/stats?key=${KEY}`)) === 200,
    stats_header_200: (await st("/api/stats", { headers: KH })) === 200,
    verify_nokey_401: (await st("/api/verify", { method: "POST", headers: json, body: "{}" })) === 401,
    ingest_state_nokey_401: (await st("/ingest/state", { method: "POST", headers: json, body: "{}" })) === 401,
    ingest_frame_nokey_401: (await st("/ingest/frame", { method: "POST", headers: { "content-type": "image/jpeg" }, body: Buffer.from(jpeg, "base64") })) === 401,
  };
  const wsClose = (p: string) => new Promise<number>((r) => {
    const w = new WebSocket(`ws://localhost:${port}${p}`);
    w.on("close", (code) => r(code)); w.on("error", () => r(-1));
  });
  checks.live_nokey_4401 = (await wsClose("/live?session=rb-auth")) === 4401;
  checks.hud_wrongkey_4401 = (await wsClose("/hud-ws?key=wrong")) === 4401;
  const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  return [!failed.length, failed.length ? `failed: ${failed.join(",")}` : `${Object.keys(checks).length} checks ok`];
});

await run("snapshot", async () => {
  // glasses mode: frames only arrive via /ingest/frame; snapshot verify uses the session ring buffer
  const c = new Client("rb-snap"); await c.open(); c.start(false, "glasses");
  await c.waitFor((m) => m.type === "ready", 15000);
  const post = (p: string, body: string | Buffer, type: string) => fetch(`http://localhost:${port}${p}`, { method: "POST", headers: { "content-type": type, ...KH }, body });
  const fr = await post("/ingest/frame?session=rb-snap", Buffer.from(jpeg, "base64"), "image/jpeg");
  const t = Date.now();
  const v = await post("/api/verify", JSON.stringify({ session: "rb-snap", question: "is this my evening pill?" }), "application/json");
  const vj: any = await v.json();
  const ms = Date.now() - t;
  const none = await post("/api/verify", JSON.stringify({ profile }), "application/json");
  const unknown = await post("/api/verify", JSON.stringify({ session: "no-such-session" }), "application/json");
  c.close();
  return [fr.status === 204 && v.status === 200 && vj.level === "match" && none.status === 400 && unknown.status === 400,
    `ingest=${fr.status} verify(session, no frames)=${v.status} ${vj.level} in ${ms} ms (hub profile used); no frames+no session=${none.status}; unknown session=${unknown.status}`];
});

server.close();
const failed = results.filter((r) => !r[1]).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
