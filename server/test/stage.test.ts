// /hud-ws?role=stage (projector view): opt-in extra fan-out without changing the HUD's behaviour.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import { WebSocket } from "ws";
import { startServer } from "../src/index.ts";
import { getHub, markLatest } from "../src/hub.ts";

let server: http.Server;
let base = "";
const open: WebSocket[] = [];

async function boot() {
  if (server) return;
  server = await startServer(0);
  base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
after(() => {
  for (const w of open) w.terminate();
  server?.close();
});

/** Connect and record every JSON message (and the close code). */
function connect(path: string) {
  const ws = new WebSocket(base + path);
  open.push(ws);
  const msgs: any[] = [];
  let closeCode: number | undefined;
  ws.on("message", (d) => msgs.push(JSON.parse(d.toString())));
  const closed = new Promise<number>((r) => ws.on("close", (c) => { closeCode = c; r(c); }));
  const opened = new Promise<void>((r, j) => { ws.once("open", () => r()); ws.once("error", j); });
  return { ws, msgs, opened, closed, get closeCode() { return closeCode; } };
}
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const types = (m: any[]) => m.map((x) => x.type);

test("stage gets transcripts, checking, readiness and metrics; the HUD stays verdict/coach/status/device only", async () => {
  await boot();
  const phone = connect("/live?session=stage-test-1");
  await phone.opened;
  await tick();
  const hub = getHub("stage-test-1")!;
  assert.ok(hub, "the phone socket created the hub");
  markLatest(hub);
  await tick();
  phone.msgs.length = 0;

  const stage = connect("/hud-ws?role=stage");
  await stage.opened;
  await tick();
  // a stage alone must not make the phone show "HUD connected"
  assert.equal(phone.msgs.filter((m) => m.type === "hud" && m.connected).length, 0, "stage is not counted as a HUD");
  const join = stage.msgs.find((m) => m.type === "metrics");
  assert.ok(join, "a late stage gets a metrics snapshot on join");
  assert.equal(join.phone, true);
  assert.equal(join.hud, false);
  assert.deepEqual(join.cache, { hits: 0, misses: 0 });
  assert.equal(join.firstAudioS, null);

  const hud = connect("/hud-ws");
  await hud.opened;
  await tick();
  assert.ok(phone.msgs.some((m) => m.type === "hud" && m.connected === true), "a real HUD still flips HUD connected");
  stage.msgs.length = 0; hud.msgs.length = 0;

  hub.emit({ type: "transcript", role: "user", text: "is this my evening pill", final: true });
  hub.emit({ type: "checking", phase: "start" });
  hub.emit({ type: "coach", cue: "closer", text: "A bit closer" });
  hub.emit({ type: "readiness", value: 0.7 }, { hud: false });
  hub.emit({ type: "audio", data: "AAAA" });
  hub.emit({ type: "checking", phase: "end" });
  hub.emit({ type: "verdict", verdict: { level: "info", headline: "x", speech: "x", reasons: [], read: {} as any } });
  await tick();

  assert.deepEqual(types(hud.msgs), ["coach", "verdict"], "HUD fan-out is unchanged");
  assert.deepEqual(types(stage.msgs).filter((t) => t !== "metrics"), ["transcript", "checking", "coach", "readiness", "checking", "verdict"]);
  assert.ok(!stage.msgs.some((m) => m.type === "audio" || m.type === "frame"), "never audio or frames to the stage");
  assert.equal(stage.msgs[0].text, "is this my evening pill");
});

test("the stage is read-only: its events never reach the phone, a HUD's still do", async () => {
  await boot();
  const phone = connect("/live?session=stage-test-2");
  await phone.opened;
  await tick();
  markLatest(getHub("stage-test-2")!);
  const stage = connect("/hud-ws?role=stage&session=stage-test-2");
  const hud = connect("/hud-ws?session=stage-test-2");
  await Promise.all([stage.opened, hud.opened]);
  await tick();
  phone.msgs.length = 0;
  stage.ws.send(JSON.stringify({ type: "event", name: "log_dose" }));
  await tick();
  assert.equal(phone.msgs.filter((m) => m.type === "hud_event").length, 0);
  hud.ws.send(JSON.stringify({ type: "event", name: "repeat" }));
  await tick();
  assert.deepEqual(phone.msgs.filter((m) => m.type === "hud_event"), [{ type: "hud_event", name: "repeat" }]);
  assert.deepEqual(stage.msgs.filter((m) => m.type === "hud_event"), [{ type: "hud_event", name: "repeat" }], "the stage mirrors HUD button events");
});

test("metrics follow frames (fps, size) and are only re-sent on change", async () => {
  await boot();
  const phone = connect("/live?session=stage-test-3");
  await phone.opened;
  await tick();
  const hub = getHub("stage-test-3")!;
  markLatest(hub);
  const stage = connect("/hud-ws?role=stage&session=stage-test-3");
  await stage.opened;
  await tick();
  stage.msgs.length = 0;
  const now = Date.now();
  // addFrame is what the /live frame path and /ingest/frame call
  for (let i = 0; i < 5; i++) hub.addFrame({ data: "x", sharpness: 0.1, ts: now, bytes: 20480, source: "phone" });
  hub.pushMetrics();
  hub.pushMetrics(); // unchanged: not sent twice
  await tick();
  const m = stage.msgs.filter((x) => x.type === "metrics");
  assert.equal(m.length, 1);
  assert.equal(m[0].fps, 1);
  assert.equal(m[0].frameKb, 20);
  assert.equal(m[0].source, "phone");
});

test("HOLDUP_KEY: a stage without the key is closed with 4401, with it it connects", async () => {
  await boot();
  process.env.HOLDUP_KEY = "stage-test-key";
  try {
    const bad = connect("/hud-ws?role=stage");
    assert.equal(await bad.closed, 4401);
    assert.equal(bad.msgs.length, 0, "nothing leaks before the close");
    const good = connect("/hud-ws?role=stage&key=stage-test-key");
    await good.opened;
    await tick();
    assert.equal(good.closeCode, undefined);
  } finally {
    delete process.env.HOLDUP_KEY;
  }
});

test("a typed question is captioned on the stage only (Live doesn't transcribe text input); the phone gets no echo", async () => {
  await boot();
  const phone = connect("/live?session=stage-test-5");
  await phone.opened;
  await tick();
  const hub = getHub("stage-test-5")!;
  markLatest(hub);
  const typed: string[] = [];
  // a fake Live session: no Gemini needed
  hub.live = { active: true, text: (t: string) => typed.push(t), handleEvent() {}, stop() {} } as any;
  const stage = connect("/hud-ws?role=stage");
  const hud = connect("/hud-ws");
  await Promise.all([stage.opened, hud.opened]);
  await tick();
  phone.msgs.length = 0; stage.msgs.length = 0; hud.msgs.length = 0;
  phone.ws.send(JSON.stringify({ type: "text", text: "  Is this my evening pill?  " }));
  await tick();
  assert.deepEqual(typed, ["  Is this my evening pill?  "], "the model still gets the text unchanged");
  assert.deepEqual(stage.msgs.filter((m) => m.type === "transcript"), [{ type: "transcript", role: "user", text: "Is this my evening pill?", final: true }]);
  assert.equal(phone.msgs.filter((m) => m.type === "transcript").length, 0);
  assert.equal(hud.msgs.length, 0);
  hub.live = undefined;
});
