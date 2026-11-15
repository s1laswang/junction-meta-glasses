// /stage projector view: reducer rules (mirror the HUD), badge text, mock script contract, rendered markup.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Verdict } from "../../shared/types.ts";
import { COACH_MS, HUD_CUE_MS, STAGE_MSG_TYPES, crossCheckBadge, fmtMs, fmtSeconds, initialStage, stageReduce, wornText, type StageState } from "../src/lib/stage.ts";
import { mockMetrics, scriptLength, stageScript } from "../src/lib/stageMock.ts";
import { demoProfile } from "../src/lib/storage.ts";
import { matchVerdict, mockScene, mockWarningIbuprofen, withCrossCheck } from "../src/lib/verdicts.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
Object.defineProperty(globalThis, "React", { value: React, configurable: true, writable: true });
// Hud.tsx (imported by Stage.tsx) reads location at module load
if (typeof (globalThis as { location?: unknown }).location === "undefined") {
  Object.defineProperty(globalThis, "location", { value: new URL("http://localhost/stage"), configurable: true, writable: true });
}
const { StageView } = await import("../src/screens/Stage.tsx");

const p = demoProfile();
const code = { raw: "x", gtin: "06416542002149", expiry: "2027-08" };

test("reducer mirrors the HUD: a verdict clears the cue, cues expire (HUD 3 s, centre 6 s), Dismiss clears the replica only", () => {
  let s = initialStage();
  s = stageReduce(s, { type: "coach", cue: "closer", text: "A bit closer" }, 1000);
  assert.equal(s.hudCue?.text, "A bit closer");
  assert.equal(s.coach?.cue, "closer");
  s = stageReduce(s, { type: "tick" }, 1000 + HUD_CUE_MS);
  assert.equal(s.hudCue, null, "HUD cue expires like Hud.tsx");
  assert.ok(s.coach, "the centre cue lasts longer");
  s = stageReduce(s, { type: "tick" }, 1000 + COACH_MS);
  assert.equal(s.coach, null);

  s = stageReduce(s, { type: "coach", cue: "hold_still", text: "Hold still" }, 9000);
  const v = matchVerdict(p, p.meds[0]);
  s = stageReduce(s, { type: "verdict", verdict: v }, 9100);
  assert.equal(s.hudCue, null);
  assert.equal(s.coach, null);
  assert.equal(s.hudVerdict, v);
  s = stageReduce(s, { type: "hud_event", name: "dismiss" });
  assert.equal(s.hudVerdict, null, "Dismiss on the glasses clears the replica");
  assert.equal(s.lastVerdict, v, "…but the badge still shows the last check");
  assert.equal(stageReduce(s, { type: "hud_event", name: "repeat" }), s);
});

test("reducer: captions per role, checking, readiness clamp, ready/metrics feed model and flags", () => {
  let s = initialStage();
  s = stageReduce(s, { type: "transcript", role: "user", text: "is this", final: false }, 1);
  s = stageReduce(s, { type: "transcript", role: "user", text: "is this my pill", final: true }, 2);
  s = stageReduce(s, { type: "transcript", role: "assistant", text: "Turn it", final: false }, 3);
  assert.equal(s.user?.text, "is this my pill");
  assert.equal(s.assistant?.final, false);
  s = stageReduce(s, { type: "interrupted" });
  assert.equal(s.assistant?.final, true);
  s = stageReduce(s, { type: "checking", phase: "start" }, 5);
  assert.equal(s.checking, true);
  s = stageReduce(s, { type: "checking", phase: "end" });
  assert.equal(s.checking, false);
  assert.equal(stageReduce(s, { type: "readiness", value: 1.7 }).readiness, 1);
  s = stageReduce(s, { type: "ready", model: "gemini-3.8-live", session: "x", features: ["scene"] });
  assert.equal(s.model, "gemini-3.8-live");
  assert.deepEqual(s.features, ["scene"]);
  s = stageReduce(s, mockMetrics({ model: "gemini-3.1-flash-live-preview", features: ["scene", "sonar"] }));
  assert.equal(s.model, "gemini-3.1-flash-live-preview");
  assert.deepEqual(s.features, ["scene", "sonar"]);
});

test("double-checked badge: agree / disagree / nothing to compare / no code / no check, never colour alone", () => {
  const v = matchVerdict(p, p.meds[0]);
  assert.deepEqual(crossCheckBadge(null).tone, "none");
  assert.equal(crossCheckBadge(v).text, "No pack code this check");
  assert.equal(crossCheckBadge(mockScene(p)).text, "Scene: no pack code");
  const ok = crossCheckBadge(withCrossCheck(v, true, ["GTIN matches"], code));
  assert.equal(ok.tone, "ok");
  assert.equal(ok.glyph, "✓");
  assert.match(ok.text, /Double-checked/);
  const bad = crossCheckBadge(withCrossCheck(v, false, ["expiry differs"], code));
  assert.equal(bad.glyph, "!");
  assert.match(bad.text, /disagree/);
  assert.equal(crossCheckBadge(withCrossCheck(v, null, [], code)).glyph, "?");
});

test("formatters and glasses state wording", () => {
  assert.equal(fmtMs(40), "40 ms");
  assert.equal(fmtMs(2900), "2.9 s");
  assert.equal(fmtMs(null), "–");
  assert.equal(fmtSeconds(12.4), "12 s");
  assert.equal(wornText(null), "Not connected");
  assert.equal(wornText({ connected: true, worn: null, battery: 50, streaming: true, source: "glasses" }), "Connected", "unknown worn is not 'taken off'");
  assert.equal(wornText({ connected: true, worn: false, battery: 50, streaming: true, source: "glasses" }), "Taken off");
});

test("mock script speaks only stage message types, in time order, with a double-check and a scene", () => {
  const script = stageScript(p);
  assert.ok(script.length > 50);
  for (let i = 1; i < script.length; i++) assert.ok(script[i][0] >= script[i - 1][0]);
  for (const [, m] of script) assert.ok(STAGE_MSG_TYPES.has(m.type), m.type);
  assert.ok(!script.some(([, m]) => (m.type as string) === "audio" || (m.type as string) === "frame"));
  const verdicts = script.filter(([, m]) => m.type === "verdict").map(([, m]) => (m as { verdict: Verdict }).verdict);
  assert.ok(verdicts.some((v) => v.crossCheck?.agrees === true));
  assert.ok(verdicts.some((v) => v.mode === "scene" && (v.items?.length ?? 0) >= 3));
  assert.ok(scriptLength(script) > 30_000);
});

function render(s: StageState, extra: Partial<{ conn: "open" | "retry" | "connecting"; keyNeeded: boolean; driver: "script" | "phone" | "server" }> = {}) {
  return renderToStaticMarkup(createElement(StageView, { s, conn: "open", keyNeeded: false, driver: "server", ...extra }));
}

test("StageView: HUD replica uses the HUD's own card, no camera images, labelled landmarks, mock is labelled", () => {
  let s = initialStage();
  s = stageReduce(s, { type: "verdict", verdict: withCrossCheck(mockWarningIbuprofen(), true, ["GTIN ok"], code) });
  s = stageReduce(s, mockMetrics({ firstAudioS: 1.2, verify: { ms: 40, source: "cache", level: "warning" }, cache: { hits: 3, misses: 1 } }));
  const html = render(s);
  assert.match(html, /class="hud-card verdict-card/);
  assert.match(html, /Ibuprofen: not on your list/);
  assert.doesNotMatch(html, /<(img|video|canvas)\b/, "never camera images");
  assert.match(html, /<h1[^>]*>HoldUp stage view<\/h1>/);
  for (const h of ["On the glasses", "Conversation", "Under the hood"]) assert.match(html, new RegExp(`<h2[^>]*>${h}</h2>`));
  assert.match(html, /Double-checked with the pack&#x27;s code/);
  assert.match(html, /3 hit · 1 miss/);
  assert.match(html, /40 ms/);
  assert.match(html, /role="meter"/);
  assert.doesNotMatch(html, /<button/, "read-only: nothing to press");
  assert.doesNotMatch(html, /SCRIPTED/);
  assert.match(render(s, { driver: "script" }), /SCRIPTED \(mock\)/);
  assert.match(render(initialStage(), { keyNeeded: true, conn: "retry" }), /Access key needed/);
  const stale = render(s, { conn: "retry" });
  assert.match(stale, /verdict-card stale/, "a dropped link marks the replica's verdict as old, like the HUD");
});

test("main.tsx routes /stage to a lazily loaded Stage; the HUD stays the HUD", () => {
  const main = readFileSync(resolve(HERE, "../src/main.tsx"), "utf8");
  assert.match(main, /path\.endsWith\("\/stage"\)/);
  assert.match(main, /lazy\(\(\) => import\("\.\/screens\/Stage\.tsx"\)/);
  assert.match(main, /isHud \?\s*\(\s*<Hud \/>/);
});

test("mock phone mirrors captions, checking and metrics to the stage channel (never audio)", async () => {
  const mock = await import("../src/lib/mock.ts");
  const hudSide = mock.mockHudChannel();
  const got: { type: string }[] = [];
  const stageSide = new BroadcastChannel(mock.MOCK_STAGE_CHANNEL);
  stageSide.onmessage = (e) => got.push(e.data);
  const sock = new mock.MockSocket();
  await new Promise((r) => setTimeout(r, 320));
  sock.send(JSON.stringify({ type: "start", profile: p, lang: "en", voice: true, source: "phone" }));
  sock.send(JSON.stringify({ type: "text", text: "is this my evening pill" }));
  await new Promise((r) => setTimeout(r, 1700));
  sock.close();
  stageSide.close();
  hudSide?.close(); // the HUD channel isn't unref'd: close it or the test process stays alive
  const types = new Set(got.map((m) => m.type));
  for (const t of ["ready", "status", "metrics", "transcript"]) assert.ok(types.has(t), `stage got ${t}`);
  assert.ok(!types.has("audio"));
});
