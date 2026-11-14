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
const KQ = process.env.HOLDUP_KEY ? `key=${encodeURIComponent(process.env.HOLDUP_KEY)}` : "";
const KH: Record<string, string> = process.env.HOLDUP_KEY ? { "x-holdup-key": process.env.HOLDUP_KEY } : {};
const hud = new WebSocket(`ws://localhost:${port}/hud-ws${KQ ? "?" + KQ : ""}`);
const hudTypes: string[] = [];
hud.on("message", (d) => hudTypes.push(JSON.parse(d.toString()).type));

const session = "smoke-" + Math.random().toString(36).slice(2, 8);
const ws = new WebSocket(`ws://localhost:${port}/live?session=${session}${KQ ? "&" + KQ : ""}`);
const counts: Record<string, number> = {};
const timeline: string[] = [];
let tQuestion = 0, tFirstAudio = 0, tVerdict = 0, verdict: any, model = "", audioBytes = 0, finalAssistant = "";
let afterVerdictFinal = false;
let frameTimer: NodeJS.Timeout | undefined, tChecking = 0, firstWords = "";
// phase 2 ("Which one?" scene mode): three boxes on a table, left to right paracetamol / ibuprofen / amlodipine
const threeJpeg = fs.readFileSync(path.join(SERVER_DIR, "fixtures", "three_boxes.jpg")).toString("base64");
const doScene = process.env.SMOKE_SCENE !== "0";
let currentJpeg = jpeg, readyFeatures: string[] = [], sceneVerdict: any, tScene = 0, tSceneVerdict = 0, sceneSpoken = false, sceneSaid = "";

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
      readyFeatures = m.features ?? [];
      // ~1 fps camera, like the phone; the question comes after the item has been in view for a moment
      const sendFrame = () => ws.readyState === 1 && ws.send(JSON.stringify({ type: "frame", data: currentJpeg, w: 768, h: 768, sharpness: 0.8 + Math.random() * 0.1, ts: Date.now() }));
      sendFrame();
      frameTimer = setInterval(sendFrame, 1000);
      setTimeout(() => {
        tQuestion = Date.now();
        ws.send(JSON.stringify({ type: "text", text: question }));
        ws.send(JSON.stringify({ type: "ping", t: 42 }));
      }, Number(process.env.SMOKE_QUESTION_DELAY_MS ?? 3000));
    }
    if (m.type === "checking" && m.phase === "start" && !tChecking) tChecking = Date.now();
    if (m.type === "transcript" && m.role === "assistant" && !firstWords && tQuestion) firstWords = m.text;
    if (m.type === "audio") { audioBytes += m.data.length * 0.75; if (!tFirstAudio && tQuestion) tFirstAudio = Date.now(); }
    if (m.type === "verdict") {
      if (m.verdict.mode === "scene") { sceneVerdict = m.verdict; tSceneVerdict = Date.now(); }
      else if (!afterVerdictFinal) { verdict = m.verdict; tVerdict = Date.now(); }
    }
    if (m.type === "transcript" && m.role === "assistant" && m.final) {
      const said = m.text.toLowerCase().replace(/[^a-z0-9]/g, "");
      const keyOf = (v: any) => (v?.speech ?? "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 14);
      if (!afterVerdictFinal) {
        finalAssistant = m.text;
        // phase 1 done once the model has actually spoken the verdict (not just an ack like "Let me look.")
        if (verdict && keyOf(verdict) && said.includes(keyOf(verdict))) {
          afterVerdictFinal = true;
          if (!doScene || !readyFeatures.includes("scene")) return resolve();
          currentJpeg = threeJpeg; // put the box down; three boxes on the table now
          setTimeout(() => { tScene = Date.now(); ws.send(JSON.stringify({ type: "text", text: "Now there are three boxes on the table. Which one is my evening pill?" })); }, 2500);
        }
      } else if (sceneVerdict && keyOf(sceneVerdict) && said.includes(keyOf(sceneVerdict))) { sceneSpoken = true; sceneSaid = m.text; resolve(); }
    }
    if (m.type === "error") console.log("error msg:", m.code, m.message);
  });
  ws.on("close", () => resolve());
  setTimeout(resolve, 80_000);
});
await done;
clearInterval(frameTimer);
// give the HUD a moment, then test ingest/state fan-out
await fetch(`${base}/ingest/state`, { method: "POST", headers: { "content-type": "application/json", ...KH }, body: JSON.stringify({ connected: true, worn: true, battery: 0.8, streaming: true }) });
await new Promise((r) => setTimeout(r, 300));
ws.send(JSON.stringify({ type: "event", name: "stop" }));
await new Promise((r) => setTimeout(r, 300));

console.log("\n== /live ==");
console.log("model:", model);
console.log("message counts:", JSON.stringify(counts));
console.log("timeline:\n  " + timeline.join("\n  "));
console.log(`audio received: ${(audioBytes / 1024).toFixed(0)} KiB PCM16 24 kHz (~${(audioBytes / 48000).toFixed(1)} s)`);
console.log(`question -> first audio: ${tFirstAudio ? tFirstAudio - tQuestion : "n/a"} ms; -> checking: ${tChecking ? tChecking - tQuestion : "n/a"} ms; -> verdict: ${tVerdict ? tVerdict - tQuestion : "n/a"} ms`);
console.log("first assistant words:", JSON.stringify(firstWords));
console.log(JSON.stringify({ metric: "smoke", model, first_audio_ms: tFirstAudio ? tFirstAudio - tQuestion : null, checking_ms: tChecking ? tChecking - tQuestion : null, verdict_ms: tVerdict ? tVerdict - tQuestion : null, disclaimer: /medical advice|healthcare professional/i.test(finalAssistant) }));
if (verdict) console.log("verdict:", JSON.stringify({ level: verdict.level, headline: verdict.headline, speech: verdict.speech, matchedMedId: verdict.matchedMedId, strength: verdict.read.strength, reasons: verdict.reasons }));
console.log("assistant said (final):", finalAssistant);
console.log("== /hud-ws (no session) ==\n types:", JSON.stringify(hudTypes));
console.log("features:", JSON.stringify(readyFeatures), "readiness msgs:", counts.readiness ?? 0);
if (sceneVerdict) {
  console.log("== scene ==", `question -> scene verdict ${tSceneVerdict - tScene} ms`, JSON.stringify({ level: sceneVerdict.level, headline: sceneVerdict.headline, speech: sceneVerdict.speech }));
  for (const i of sceneVerdict.items ?? []) console.log("  ", i.position, i.level, i.headline);
  console.log("assistant said (scene):", sceneSaid);
}
const sceneShape = (sceneVerdict?.items ?? []).map((i: any) => `${i.position}:${i.level}:${/amlodipine/i.test(i.headline) ? "aml" : /ibuprofen/i.test(i.headline) ? "ibu" : /paracetamol/i.test(i.headline) ? "par" : "?"}`).join(",");

// snapshot path
const tv = Date.now();
const vr = await fetch(`${base}/api/verify`, { method: "POST", headers: { "content-type": "application/json", ...KH }, body: JSON.stringify({ frames: [jpeg], profile, question }) });
const vj: any = await vr.json();
console.log("== /api/verify ==\n", vr.status, `${Date.now() - tv} ms`, JSON.stringify({ level: vj.level, headline: vj.headline }));
const h = await (await fetch(`${base}/api/health`)).json();
console.log("== /api/health ==\n", JSON.stringify(h));

const checks = {
  ready: !!model, checking: (counts.checking ?? 0) >= 2, audio: audioBytes > 0, transcripts: (counts.transcript ?? 0) > 0, verdict: !!verdict,
  spokeAfterVerdict: afterVerdictFinal, pong: (counts.pong ?? 0) > 0,
  hudVerdict: hudTypes.includes("verdict"), hudDevice: hudTypes.includes("device"), snapshotVerdict: vr.ok && !!vj.level,
} as Record<string, boolean>;
if (doScene && readyFeatures.includes("scene")) {
  checks.sceneVerdict = sceneShape === "left:match:par,center:warning:ibu,right:match:aml" && sceneVerdict.level === "match" && /on the right/.test(sceneVerdict.speech);
  checks.sceneSpoken = sceneSpoken;
}
if (readyFeatures.includes("sonar")) checks.readiness = (counts.readiness ?? 0) > 0;
for (const [k, v] of Object.entries(checks)) { console.log(`${v ? "PASS" : "FAIL"} ${k}`); if (!v) fail = true; }
ws.close(); hud.close(); server.close();
process.exit(fail ? 1 : 0);
