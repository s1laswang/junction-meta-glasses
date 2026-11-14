// End-to-end smoke test: boots the server in-process on a free port, opens /live like the phone would,
// sends a profile, one JPEG frame and a text question, and prints the message types and timings it gets back.
// Also checks /hud-ws (no session -> follows latest), /ingest/state, /api/verify and /api/health.
// Usage: npm -w server run smoke [-- path/to/label.jpg "question"]
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import type { Profile, ServerMsg } from "../../shared/types.ts";
import { SERVER_DIR } from "../src/env.ts";
import { startServer } from "../src/index.ts";

process.env.HOLDUP_QUIET ??= "1";
const img = process.argv[2] ?? path.join(SERVER_DIR, "fixtures", "amlodipine.jpg");
const question = process.argv[3] ?? "Is this my evening pill?";
const jpeg = fs.readFileSync(img).toString("base64");
const profile: Profile = {
  meds: [
    { id: "aml", name: "Amlodipine", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"] },
    { id: "par", name: "Panadol", ingredient: "paracetamol", strength: "500 mg", schedule: ["as needed"] },
  ],
  allergies: ["peanut", "tree nuts"], avoid: ["NSAIDs"], doseLog: [], lang: "en",
};

const server = await startServer(0);
const port = (server.address() as any).port;
const base = `http://localhost:${port}`;
const t0 = Date.now();
const ms = () => Date.now() - t0;
let fail = false;

// HUD first, without session: it must get the verdict of the latest live session
const hud = new WebSocket(`ws://localhost:${port}/hud-ws`);
const hudTypes: string[] = [];
hud.on("message", (d) => hudTypes.push(JSON.parse(d.toString()).type));

const session = "smoke-" + Math.random().toString(36).slice(2, 8);
const ws = new WebSocket(`ws://localhost:${port}/live?session=${session}`);
const counts: Record<string, number> = {};
const timeline: string[] = [];
let tQuestion = 0, tFirstAudio = 0, tVerdict = 0, verdict: any, model = "", audioBytes = 0, finalAssistant = "";
let afterVerdictFinal = false;

const done = new Promise<void>((resolve) => {
  ws.on("open", () => {
    ws.send(JSON.stringify({ type: "start", profile, lang: "en", voice: true, source: "phone" }));
  });
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString()) as ServerMsg;
    counts[m.type] = (counts[m.type] ?? 0) + 1;
    if (m.type !== "audio" && !(m.type === "transcript" && !m.final)) timeline.push(`${ms()}ms ${m.type}${"live" in m ? ":" + m.live : ""}${m.type === "coach" ? ":" + m.cue : ""}${m.type === "transcript" ? ":" + m.role : ""}`);
    if (m.type === "ready") {
      model = m.model;
      ws.send(JSON.stringify({ type: "frame", data: jpeg, w: 768, h: 768, sharpness: 0.9, ts: Date.now() }));
      setTimeout(() => {
        ws.send(JSON.stringify({ type: "frame", data: jpeg, w: 768, h: 768, sharpness: 0.85, ts: Date.now() }));
        tQuestion = Date.now();
        ws.send(JSON.stringify({ type: "text", text: question }));
        ws.send(JSON.stringify({ type: "ping", t: 42 }));
      }, 1000);
    }
    if (m.type === "audio") { audioBytes += m.data.length * 0.75; if (!tFirstAudio && tQuestion) tFirstAudio = Date.now(); }
    if (m.type === "verdict") { verdict = m.verdict; tVerdict = Date.now(); }
    if (m.type === "transcript" && m.role === "assistant" && m.final) {
      finalAssistant = m.text;
      if (verdict) { afterVerdictFinal = true; resolve(); }
    }
    if (m.type === "error") console.log("error msg:", m.code, m.message);
  });
  ws.on("close", () => resolve());
  setTimeout(resolve, 45_000);
});
await done;
// give the HUD a moment, then test ingest/state fan-out
await fetch(`${base}/ingest/state`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ connected: true, worn: true, battery: 0.8, streaming: true }) });
await new Promise((r) => setTimeout(r, 300));
ws.send(JSON.stringify({ type: "event", name: "stop" }));
await new Promise((r) => setTimeout(r, 300));

console.log("\n== /live ==");
console.log("model:", model);
console.log("message counts:", JSON.stringify(counts));
console.log("timeline:\n  " + timeline.join("\n  "));
console.log(`audio received: ${(audioBytes / 1024).toFixed(0)} KiB PCM16 24 kHz (~${(audioBytes / 48000).toFixed(1)} s)`);
console.log(`question -> first audio: ${tFirstAudio ? tFirstAudio - tQuestion : "n/a"} ms; question -> verdict: ${tVerdict ? tVerdict - tQuestion : "n/a"} ms`);
if (verdict) console.log("verdict:", JSON.stringify({ level: verdict.level, headline: verdict.headline, speech: verdict.speech, matchedMedId: verdict.matchedMedId, strength: verdict.read.strength, reasons: verdict.reasons }));
console.log("assistant said (final):", finalAssistant);
console.log("== /hud-ws (no session) ==\n types:", JSON.stringify(hudTypes));

// snapshot path
const tv = Date.now();
const vr = await fetch(`${base}/api/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ frames: [jpeg], profile, question }) });
const vj: any = await vr.json();
console.log("== /api/verify ==\n", vr.status, `${Date.now() - tv} ms`, JSON.stringify({ level: vj.level, headline: vj.headline }));
const h = await (await fetch(`${base}/api/health`)).json();
console.log("== /api/health ==\n", JSON.stringify(h));

const checks = {
  ready: !!model, audio: audioBytes > 0, transcripts: (counts.transcript ?? 0) > 0, verdict: !!verdict,
  spokeAfterVerdict: afterVerdictFinal, pong: (counts.pong ?? 0) > 0,
  hudVerdict: hudTypes.includes("verdict"), hudDevice: hudTypes.includes("device"), snapshotVerdict: vr.ok && !!vj.level,
};
for (const [k, v] of Object.entries(checks)) { console.log(`${v ? "PASS" : "FAIL"} ${k}`); if (!v) fail = true; }
ws.close(); hud.close(); server.close();
process.exit(fail ? 1 : 0);
