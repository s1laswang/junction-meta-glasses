// Debug: start a /live session (no frames) and print every non-audio server message for N seconds.
// Usage: LIVE_MODEL=... tsx scripts/trace.ts [seconds] ["text to send after ready"]
import WebSocket from "ws";
const { startServer } = await import("../src/index.ts");
const s = await startServer(0);
const port = (s.address() as any).port;
const ws = new WebSocket(`ws://localhost:${port}/live?session=trace-${Date.now() % 1e6}`);
const t0 = Date.now();
ws.on("message", (d) => {
  const m = JSON.parse(d.toString());
  if (m.type === "audio") return;
  console.log(`${Date.now() - t0}ms`, JSON.stringify(m).slice(0, 300));
  if (m.type === "ready" && process.argv[3]) ws.send(JSON.stringify({ type: "text", text: process.argv[3] }));
});
ws.on("open", () => ws.send(JSON.stringify({ type: "start", profile: { meds: [], allergies: [], avoid: [], doseLog: [], lang: "en" }, lang: "en", voice: true, source: "phone" })));
setTimeout(() => process.exit(0), Number(process.argv[2] ?? 9) * 1000);
