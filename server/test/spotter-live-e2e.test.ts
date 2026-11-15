import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WebSocket } from "ws";
import type { ServerMsg, Verdict } from "../../shared/types.ts";
import { REPO_ROOT } from "../src/env.ts";
import type { Hub } from "../src/hub.ts";
import type { FieldBox } from "../src/spotter.ts";

const SELF_PATH = fileURLToPath(import.meta.url);
const MODEL_PATH = path.join(REPO_ROOT, "web", "public", "models", "fieldspotter.onnx");
const OPEN_FIXTURE = path.join(REPO_ROOT, "server", "fixtures", "amlodipine.jpg");
const COVERED_FIXTURE = path.join(REPO_ROOT, "server", "fixtures", "amlodipine_covered.jpg");
const DM_FIXTURE = path.join(REPO_ROOT, "server", "fixtures", "dm_amlodipine.jpg");

type CommandName =
  | "warmup"
  | "fields_and_readiness"
  | "covered_cue_fanout"
  | "busy_quiet_window"
  | "verdict_reset_and_quiet"
  | "drop_frames_reset"
  | "throttle_and_corrupt_backoff"
  | "shutdown";

type WorkerRequest = { id: number; cmd: CommandName };
type WorkerResponse = { id: number; ok: boolean; result?: Record<string, unknown>; error?: string };

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type MockSocket = {
  ws: WebSocket;
  msgs: ServerMsg[];
  close: () => void;
};

function createMockSocket(): MockSocket {
  const emitter = new EventEmitter();
  const msgs: ServerMsg[] = [];
  const raw = Object.assign(emitter, {
    readyState: 1,
    send(payload: string) {
      msgs.push(JSON.parse(payload) as ServerMsg);
    },
  });
  return {
    ws: raw as unknown as WebSocket,
    msgs,
    close() {
      raw.readyState = 3;
      emitter.emit("close", 1000);
    },
  };
}

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 6000, stepMs = 15): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const val = fn();
    if (val !== undefined) return val;
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs}ms`);
    await delay(stepMs);
  }
}

async function runChildWorker(): Promise<void> {
  const unhandled: string[] = [];
  let geminiCalls = 0;

  process.on("unhandledRejection", (reason) => {
    unhandled.push(reason instanceof Error ? reason.stack ?? reason.message : String(reason));
  });
  process.on("uncaughtException", (err) => {
    unhandled.push(err instanceof Error ? err.stack ?? err.message : String(err));
  });

  const geminiMod = await import("../src/gemini.ts");
  (geminiMod.ai.models as unknown as { generateContent: () => Promise<never> }).generateContent = async () => {
    geminiCalls++;
    throw new Error("Forbidden Gemini API call in keyless FieldSpotter test");
  };

  const spotterMod = await import("../src/spotter.ts");
  const hubMod = await import("../src/hub.ts");
  const specMod = await import("../src/speculate.ts");
  const verifyMod = await import("../src/verify.ts");

  const openBuf = fs.readFileSync(OPEN_FIXTURE);
  const openB64 = openBuf.toString("base64");
  const coveredBuf = fs.readFileSync(COVERED_FIXTURE);
  const coveredB64 = coveredBuf.toString("base64");
  const dmBuf = fs.readFileSync(DM_FIXTURE);
  const dmB64 = dmBuf.toString("base64");

  function prepareHub(id: string, getBusy: () => boolean = () => false): Hub {
    const hub = hubMod.getOrCreateHub(id);
    hub.spec = new specMod.Speculator(hub.ring, () => false);
    hub.spec.onRead = () => hub.updateReadiness();
    hub.features = new Set(["sonar"]);
    hub.live = {
      active: true,
      get busy() {
        return getBusy();
      },
      handleEvent() {},
      stop() {},
    };
    hubMod.markLatest(hub);
    return hub;
  }

  async function feedAndWaitFields(
    hub: Hub,
    phone: MockSocket,
    data: string,
    bytes: number,
    sharpness: number,
    minTotalMs = 460,
  ): Promise<Extract<ServerMsg, { type: "fields" }>> {
    const beforeCount = phone.msgs.filter((m) => m.type === "fields").length;
    const startedAt = Date.now();
    hub.addFrame({ data, sharpness, ts: startedAt, bytes, source: "phone" });
    const fieldsMsg = await waitFor(() => {
      const all = phone.msgs.filter((m): m is Extract<ServerMsg, { type: "fields" }> => m.type === "fields");
      return all.length > beforeCount ? all[all.length - 1] : undefined;
    });
    await delay(15);
    const remaining = minTotalMs - (Date.now() - startedAt);
    if (remaining > 0) await delay(remaining);
    return fieldsMsg;
  }

  function assertCleanRuntime() {
    assert.equal(geminiCalls, 0, "expected zero Gemini API calls");
    assert.deepEqual(unhandled, [], "expected zero unhandled rejections or exceptions");
  }

  async function handleCommand(cmd: CommandName): Promise<Record<string, unknown>> {
    if (cmd === "warmup") {
      assert.equal(process.env.SPOTTER, "1");
      assert.equal(spotterMod.spotterAvailable(), true);
      const warm = await spotterMod.detect(openBuf);
      assert.ok(warm.fields.length > 0);
      assertCleanRuntime();
      return { available: spotterMod.spotterAvailable(), warmFields: warm.fields.length };
    }

    if (cmd === "fields_and_readiness") {
      assert.equal(spotterMod.spotterAvailable(), true);
      const hub = prepareHub("spotter-e2e-a");
      const phone1 = createMockSocket();
      const phone2 = createMockSocket();
      const hudBound = createMockSocket();
      const hudFloating = createMockSocket();
      const stageBound = createMockSocket();
      const stageFloating = createMockSocket();

      try {
        hub.clients.add(phone1.ws);
        hub.clients.add(phone2.ws);
        hubMod.addHud(hudBound.ws, hub.id);
        hubMod.addHud(hudFloating.ws);
        hubMod.addStage(stageBound.ws, hub.id);
        hubMod.addStage(stageFloating.ws);

        for (const s of [phone1, phone2, hudBound, hudFloating, stageBound, stageFloating]) {
          s.msgs.length = 0;
        }

        const firstOpen = await feedAndWaitFields(hub, phone1, openB64, openBuf.length, 0.9, 460);
        const strengthScore = Math.max(0, ...firstOpen.fields.filter((f) => f.label === "strength").map((f) => f.score));
        const openProductScore = Math.max(0, ...firstOpen.fields.filter((f) => f.label === "product").map((f) => f.score));
        assert.ok(strengthScore >= 0.5, `expected strength >= 0.5, got ${strengthScore}`);
        assert.ok(openProductScore >= 0.5, `expected product >= 0.5, got ${openProductScore}`);
        for (const f of firstOpen.fields) {
          assert.equal(f.box.length, 4);
          assert.ok(f.box.every((coord) => coord >= 0 && coord <= 1000));
        }

        assert.equal(phone2.msgs.filter((m) => m.type === "fields").length, 1);
        assert.equal(hudBound.msgs.filter((m) => m.type === "fields").length, 0);
        assert.equal(hudFloating.msgs.filter((m) => m.type === "fields").length, 0);
        assert.equal(stageBound.msgs.filter((m) => m.type === "fields").length, 0);
        assert.equal(stageFloating.msgs.filter((m) => m.type === "fields").length, 0);

        let highReadiness = phone1.msgs
          .filter((m): m is Extract<ServerMsg, { type: "readiness" }> => m.type === "readiness")
          .find((m) => m.value > 0.55);
        if (!highReadiness) {
          await feedAndWaitFields(hub, phone1, openB64, openBuf.length, 0.9, 460);
          highReadiness = phone1.msgs
            .filter((m): m is Extract<ServerMsg, { type: "readiness" }> => m.type === "readiness")
            .find((m) => m.value > 0.55);
        }
        assert.ok(highReadiness && highReadiness.value > 0.55, "expected readiness > 0.55 when strength >= 0.5");

        const stageHigh = stageBound.msgs
          .filter((m): m is Extract<ServerMsg, { type: "readiness" }> => m.type === "readiness")
          .find((m) => m.value > 0.55);
        assert.ok(stageHigh && stageHigh.value > 0.55, "expected stage to receive readiness > 0.55");
        assert.equal(hudBound.msgs.filter((m) => m.type === "readiness").length, 0);
        assert.equal(hudFloating.msgs.filter((m) => m.type === "readiness").length, 0);

        const phoneReadinessBeforeCap = phone1.msgs.filter((m) => m.type === "readiness").length;
        const covFieldsMsg = await feedAndWaitFields(hub, phone1, coveredB64, coveredBuf.length, 0.98, 300);
        const covStrength = Math.max(0, ...covFieldsMsg.fields.filter((f) => f.label === "strength").map((f) => f.score));
        const covProduct = Math.max(0, ...covFieldsMsg.fields.filter((f) => f.label === "product").map((f) => f.score));
        assert.ok(covStrength < 0.5, `expected covered strength < 0.5, got ${covStrength}`);
        assert.ok(covProduct >= 0.5, `expected covered product >= 0.5, got ${covProduct}`);

        let postCoverReadiness = phone1.msgs
          .filter((m): m is Extract<ServerMsg, { type: "readiness" }> => m.type === "readiness")
          .slice(phoneReadinessBeforeCap);
        if (postCoverReadiness.length === 0) {
          await delay(270);
          hub.updateReadiness(0.98);
          postCoverReadiness = phone1.msgs
            .filter((m): m is Extract<ServerMsg, { type: "readiness" }> => m.type === "readiness")
            .slice(phoneReadinessBeforeCap);
        }
        assert.ok(postCoverReadiness.length >= 1, "expected readiness update after covered frame");
        const cappedVal = postCoverReadiness[postCoverReadiness.length - 1].value;
        assert.ok(cappedVal <= 0.55, `expected capped readiness <= 0.55, got ${cappedVal}`);

        assert.equal(hudBound.msgs.filter((m) => m.type === "fields").length, 0);
        assert.equal(hudFloating.msgs.filter((m) => m.type === "fields").length, 0);
        assert.equal(stageBound.msgs.filter((m) => m.type === "fields").length, 0);
        assert.equal(stageFloating.msgs.filter((m) => m.type === "fields").length, 0);

        assertCleanRuntime();
        return { openReadiness: highReadiness.value, cappedReadiness: cappedVal, strengthScore, covProduct };
      } finally {
        hub.clients.delete(phone1.ws);
        hub.clients.delete(phone2.ws);
        phone1.close();
        phone2.close();
        hudBound.close();
        hudFloating.close();
        stageBound.close();
        stageFloating.close();
      }
    }

    if (cmd === "covered_cue_fanout") {
      const hub = prepareHub("spotter-e2e-b");
      const phone = createMockSocket();
      const hud = createMockSocket();
      const stage = createMockSocket();

      try {
        hub.clients.add(phone.ws);
        hubMod.addHud(hud.ws, hub.id);
        hubMod.addStage(stage.ws, hub.id);
        phone.msgs.length = 0;
        hud.msgs.length = 0;
        stage.msgs.length = 0;

        await feedAndWaitFields(hub, phone, openB64, openBuf.length, 0.85, 460);
        assert.equal(phone.msgs.filter((m) => m.type === "coach").length, 0);

        await feedAndWaitFields(hub, phone, openB64, openBuf.length, 0.85, 460);
        assert.equal(phone.msgs.filter((m) => m.type === "coach").length, 0);

        await feedAndWaitFields(hub, phone, coveredB64, coveredBuf.length, 0.82, 460);
        assert.equal(phone.msgs.filter((m) => m.type === "coach").length, 0);

        await feedAndWaitFields(hub, phone, coveredB64, coveredBuf.length, 0.82, 20);

        const expectedCoach: ServerMsg = {
          type: "coach",
          cue: "hold_still",
          text: "Something is covering the dose. Move your thumb.",
          say: true,
        };

        assert.deepEqual(phone.msgs.filter((m) => m.type === "coach"), [expectedCoach]);
        assert.deepEqual(hud.msgs.filter((m) => m.type === "coach"), [expectedCoach]);
        assert.deepEqual(stage.msgs.filter((m) => m.type === "coach"), [expectedCoach]);
        assert.deepEqual(hub.lastCoach, expectedCoach);
        assert.equal(hud.msgs.filter((m) => m.type === "fields").length, 0);
        assert.equal(stage.msgs.filter((m) => m.type === "fields").length, 0);

        assertCleanRuntime();
        return { coachText: expectedCoach.text };
      } finally {
        hub.clients.delete(phone.ws);
        phone.close();
        hud.close();
        stage.close();
      }
    }

    if (cmd === "busy_quiet_window") {
      let busyFlag = false;
      const hubBusy = prepareHub("spotter-e2e-c-busy", () => busyFlag);
      const phoneBusy = createMockSocket();
      const hudBusy = createMockSocket();
      const stageBusy = createMockSocket();

      try {
        hubBusy.clients.add(phoneBusy.ws);
        hubMod.addHud(hudBusy.ws, hubBusy.id);
        hubMod.addStage(stageBusy.ws, hubBusy.id);
        phoneBusy.msgs.length = 0;
        hudBusy.msgs.length = 0;
        stageBusy.msgs.length = 0;

        assert.equal(hubBusy.spotCoach.quietUntil, 0);
        await feedAndWaitFields(hubBusy, phoneBusy, openB64, openBuf.length, 0.85, 460);
        await feedAndWaitFields(hubBusy, phoneBusy, openB64, openBuf.length, 0.85, 460);
        await feedAndWaitFields(hubBusy, phoneBusy, coveredB64, coveredBuf.length, 0.82, 460);
        assert.equal(hubBusy.spotCoach.quietUntil, 0);

        busyFlag = true;
        const busyBefore = Date.now();
        await feedAndWaitFields(hubBusy, phoneBusy, coveredB64, coveredBuf.length, 0.82, 20);
        const busyAfter = Date.now();

        assert.ok(
          hubBusy.spotCoach.quietUntil >= busyBefore + 2450 && hubBusy.spotCoach.quietUntil <= busyAfter + 2550,
          `expected quietUntil near +2500ms, got delta ${hubBusy.spotCoach.quietUntil - busyBefore}`,
        );
        assert.equal(phoneBusy.msgs.filter((m) => m.type === "coach").length, 0);
        assert.equal(hudBusy.msgs.filter((m) => m.type === "coach").length, 0);
        assert.equal(stageBusy.msgs.filter((m) => m.type === "coach").length, 0);
        assertCleanRuntime();
        return { quietDeltaMs: hubBusy.spotCoach.quietUntil - busyBefore };
      } finally {
        hubBusy.clients.delete(phoneBusy.ws);
        phoneBusy.close();
        hudBusy.close();
        stageBusy.close();
      }
    }

    if (cmd === "verdict_reset_and_quiet") {
      const hubVerdict = prepareHub("spotter-e2e-c-verdict");
      const phoneVerdict = createMockSocket();
      const hudVerdict = createMockSocket();
      const stageVerdict = createMockSocket();

      try {
        hubVerdict.clients.add(phoneVerdict.ws);
        hubMod.addHud(hudVerdict.ws, hubVerdict.id);
        hubMod.addStage(stageVerdict.ws, hubVerdict.id);
        phoneVerdict.msgs.length = 0;
        hudVerdict.msgs.length = 0;
        stageVerdict.msgs.length = 0;

        await feedAndWaitFields(hubVerdict, phoneVerdict, openB64, openBuf.length, 0.85, 460);
        await feedAndWaitFields(hubVerdict, phoneVerdict, openB64, openBuf.length, 0.85, 460);

        const sampleVerdict: Verdict = {
          level: "match",
          headline: "Amlodipine 5 mg",
          speech: "Yes, Amlodipine 5 milligrams.",
          reasons: ["matches profile"],
          read: verifyMod.unreadable(),
        };
        const resetBefore = Date.now();
        hubVerdict.emit({ type: "verdict", verdict: sampleVerdict });
        const resetAfter = Date.now();

        assert.ok(
          hubVerdict.spotCoach.quietUntil >= resetBefore + 5950 &&
            hubVerdict.spotCoach.quietUntil <= resetAfter + 6050,
          `expected post-verdict quietUntil near +6000ms, got delta ${hubVerdict.spotCoach.quietUntil - resetBefore}`,
        );

        hubVerdict.spotCoach.quietUntil = 0;
        await feedAndWaitFields(hubVerdict, phoneVerdict, coveredB64, coveredBuf.length, 0.82, 460);
        await feedAndWaitFields(hubVerdict, phoneVerdict, coveredB64, coveredBuf.length, 0.82, 460);
        assert.equal(
          phoneVerdict.msgs.filter((m) => m.type === "coach").length,
          0,
          "verdict must reset spotCoach so prior seen streak does not fire covered cue",
        );

        const verdictBefore = Date.now();
        hubVerdict.emit({ type: "verdict", verdict: sampleVerdict });
        const verdictAfter = Date.now();
        assert.ok(
          hubVerdict.spotCoach.quietUntil >= verdictBefore + 5950 &&
            hubVerdict.spotCoach.quietUntil <= verdictAfter + 6050,
        );

        await feedAndWaitFields(hubVerdict, phoneVerdict, openB64, openBuf.length, 0.85, 460);
        await feedAndWaitFields(hubVerdict, phoneVerdict, openB64, openBuf.length, 0.85, 460);
        await feedAndWaitFields(hubVerdict, phoneVerdict, coveredB64, coveredBuf.length, 0.82, 460);
        await feedAndWaitFields(hubVerdict, phoneVerdict, coveredB64, coveredBuf.length, 0.82, 20);
        if (Date.now() < hubVerdict.spotCoach.quietUntil) {
          assert.equal(phoneVerdict.msgs.filter((m) => m.type === "coach").length, 0);
          assert.equal(hudVerdict.msgs.filter((m) => m.type === "coach").length, 0);
          assert.equal(stageVerdict.msgs.filter((m) => m.type === "coach").length, 0);
        }
        assertCleanRuntime();
        return { postVerdictWindowMs: hubVerdict.spotCoach.quietUntil - verdictBefore };
      } finally {
        hubVerdict.clients.delete(phoneVerdict.ws);
        phoneVerdict.close();
        hudVerdict.close();
        stageVerdict.close();
      }
    }

    if (cmd === "drop_frames_reset") {
      const hubDrop = prepareHub("spotter-e2e-c-drop");
      const phoneDrop = createMockSocket();
      const hudDrop = createMockSocket();
      const stageDrop = createMockSocket();

      try {
        hubDrop.clients.add(phoneDrop.ws);
        hubMod.addHud(hudDrop.ws, hubDrop.id);
        hubMod.addStage(stageDrop.ws, hubDrop.id);
        phoneDrop.msgs.length = 0;
        hudDrop.msgs.length = 0;
        stageDrop.msgs.length = 0;

        await feedAndWaitFields(hubDrop, phoneDrop, openB64, openBuf.length, 0.85, 460);
        await feedAndWaitFields(hubDrop, phoneDrop, openB64, openBuf.length, 0.85, 460);
        assert.ok(hubDrop.lastFields && hubDrop.lastFields.fields.length > 0);
        assert.equal(hubDrop.ring.length, 2);

        hubDrop.dropFrames();
        assert.equal(hubDrop.lastFields, undefined);
        assert.equal(hubDrop.ring.length, 0);

        await feedAndWaitFields(hubDrop, phoneDrop, coveredB64, coveredBuf.length, 0.82, 460);
        await feedAndWaitFields(hubDrop, phoneDrop, coveredB64, coveredBuf.length, 0.82, 460);
        assert.equal(
          phoneDrop.msgs.filter((m) => m.type === "coach").length,
          0,
          "dropFrames must reset spotCoach so covered frames alone do not fire covered cue",
        );

        await feedAndWaitFields(hubDrop, phoneDrop, openB64, openBuf.length, 0.85, 460);
        await feedAndWaitFields(hubDrop, phoneDrop, openB64, openBuf.length, 0.85, 460);
        await feedAndWaitFields(hubDrop, phoneDrop, coveredB64, coveredBuf.length, 0.82, 460);
        await feedAndWaitFields(hubDrop, phoneDrop, coveredB64, coveredBuf.length, 0.82, 20);
        assert.equal(phoneDrop.msgs.filter((m) => m.type === "coach").length, 1);
        assertCleanRuntime();
        return { recoveredCoach: true };
      } finally {
        hubDrop.clients.delete(phoneDrop.ws);
        phoneDrop.close();
        hudDrop.close();
        stageDrop.close();
      }
    }

    if (cmd === "throttle_and_corrupt_backoff") {
      assert.equal(spotterMod.SPOT.minGapMs, 400);
      assert.equal(spotterMod.SPOT.backoffMs, 5000);

      let st = new spotterMod.SpotThrottle();
      assert.equal(st.runs, 0);
      assert.equal(st.totalMs, 0);

      let hits: { fields: FieldBox[]; ms: number }[] = [];
      let elapsedAfterRun1 = spotterMod.SPOT.minGapMs;

      for (let attempt = 0; attempt < 4; attempt++) {
        st = new spotterMod.SpotThrottle();
        hits = [];
        let firstResolve!: () => void;
        const firstDone = new Promise<void>((resolve) => {
          firstResolve = resolve;
        });

        const run1Start = Date.now();
        st.maybe(dmB64, (fields, ms) => {
          hits.push({ fields, ms });
          firstResolve();
        });
        st.maybe(openB64, (fields, ms) => {
          hits.push({ fields, ms });
        });
        await delay(15);
        st.maybe(openB64, (fields, ms) => {
          hits.push({ fields, ms });
        });

        await firstDone;
        await delay(10);

        assert.equal(hits.length, 1, "concurrent in-flight calls must be gated");
        assert.equal(st.runs, 1);
        assert.ok(hits[0].ms >= 0);
        assert.equal(st.totalMs, hits[0].ms);

        elapsedAfterRun1 = Date.now() - run1Start;
        if (elapsedAfterRun1 < spotterMod.SPOT.minGapMs - 20) break;
      }

      assert.ok(
        elapsedAfterRun1 < spotterMod.SPOT.minGapMs - 20,
        `expected dm fixture detection faster than minGapMs, took ${elapsedAfterRun1}ms`,
      );

      let minGapHits = 0;
      st.maybe(openB64, () => {
        minGapHits++;
      });
      await delay(spotterMod.SPOT.minGapMs - elapsedAfterRun1 + 40);
      assert.equal(minGapHits, 0, "call inside SPOT.minGapMs (400ms) must be suppressed");
      assert.equal(st.runs, 1);

      let secondResolve!: () => void;
      const secondDone = new Promise<void>((resolve) => {
        secondResolve = resolve;
      });
      st.maybe(openB64, (fields, ms) => {
        hits.push({ fields, ms });
        secondResolve();
      });
      await secondDone;
      await delay(10);

      assert.equal(hits.length, 2);
      assert.equal(st.runs, 2);
      assert.ok(hits[1].fields.some((f) => f.label === "strength" && f.score >= 0.6));
      assert.equal(st.totalMs, hits[0].ms + hits[1].ms);
      assert.ok(st.totalMs > 0);

      await delay(spotterMod.SPOT.minGapMs + 40);

      const corruptB64 = Buffer.from([0xff, 0xd8, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05]).toString("base64");
      let corruptHits = 0;
      st.maybe(corruptB64, () => {
        corruptHits++;
      });
      await delay(80);
      const afterCorruptSettled = Date.now();

      assert.equal(corruptHits, 0);
      assert.equal(st.runs, 2);
      assert.equal(st.totalMs, hits[0].ms + hits[1].ms);
      assertCleanRuntime();

      await delay(spotterMod.SPOT.minGapMs + 60);
      let backoffBlockedHits = 0;
      st.maybe(openB64, () => {
        backoffBlockedHits++;
      });
      await delay(260);
      assert.equal(backoffBlockedHits, 0, "calls inside SPOT.backoffMs (5000ms) after corrupt JPEG must be suppressed");
      assert.equal(st.runs, 2);

      const waitOutBackoff = afterCorruptSettled + spotterMod.SPOT.backoffMs + 80 - Date.now();
      if (waitOutBackoff > 0) await delay(waitOutBackoff);

      let thirdResolve!: () => void;
      const thirdDone = new Promise<void>((resolve) => {
        thirdResolve = resolve;
      });
      st.maybe(openB64, (fields, ms) => {
        hits.push({ fields, ms });
        thirdResolve();
      });
      await thirdDone;
      await delay(10);

      assert.equal(st.runs, 3);
      assert.equal(st.totalMs, hits[0].ms + hits[1].ms + hits[2].ms);
      assertCleanRuntime();
      return { runs: st.runs, totalMs: st.totalMs };
    }

    return { shutdown: true };
  }

  process.on("message", (raw: unknown) => {
    const req = raw as WorkerRequest;
    if (!req || typeof req.id !== "number") return;
    if (req.cmd === "shutdown") {
      process.send?.({ id: req.id, ok: true, result: { shutdown: true } } satisfies WorkerResponse, () => {
        process.exit(0);
      });
      return;
    }
    void handleCommand(req.cmd)
      .then((result) => {
        process.send?.({ id: req.id, ok: true, result } satisfies WorkerResponse);
      })
      .catch((err) => {
        const error = err instanceof Error ? err.stack ?? err.message : String(err);
        process.send?.({ id: req.id, ok: false, error } satisfies WorkerResponse);
      });
  });

  process.send?.({ id: 0, ok: true, result: { ready: true } } satisfies WorkerResponse);
}

if (process.env.SPOTTER_CHILD_MODE === "1") {
  await runChildWorker();
} else {
  let child: ChildProcess | undefined;
  let seq = 1;
  const pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  let stderrBuf = "";

  async function ensureWorker(): Promise<void> {
    if (child) return;
    assert.equal(fs.existsSync(MODEL_PATH), true, "fieldspotter.onnx must exist");
    assert.equal(fs.existsSync(OPEN_FIXTURE), true, "amlodipine.jpg must exist");
    assert.equal(fs.existsSync(COVERED_FIXTURE), true, "amlodipine_covered.jpg must exist");
    assert.equal(fs.existsSync(DM_FIXTURE), true, "dm_amlodipine.jpg must exist");

    const proc = spawn(process.execPath, ["--import", "tsx", SELF_PATH], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        SPOTTER: "1",
        SPOTTER_CHILD_MODE: "1",
        GEMINI_API_KEY: "",
        HOLDUP_KEY: "",
        LEDGER_PATH: "/dev/null",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    child = proc;

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8");
    });

    await new Promise<void>((resolve, reject) => {
      const onReady = (raw: unknown) => {
        const msg = raw as WorkerResponse;
        if (msg && msg.id === 0 && msg.ok) {
          proc.off("message", onReady);
          resolve();
        }
      };
      proc.on("message", onReady);
      proc.once("error", reject);
      proc.once("exit", (code) => {
        reject(new Error(`SPOTTER worker exited early (${code}): ${stderrBuf}`));
      });
    });

    proc.on("message", (raw: unknown) => {
      const msg = raw as WorkerResponse;
      const waiter = pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      if (msg.ok) waiter.resolve(msg.result ?? {});
      else waiter.reject(new Error(msg.error ?? "worker command failed"));
    });

    proc.on("exit", (code) => {
      for (const [, waiter] of pending) {
        waiter.reject(new Error(`SPOTTER worker exited (${code}): ${stderrBuf}`));
      }
      pending.clear();
    });
  }

  async function callWorker(cmd: CommandName): Promise<Record<string, unknown>> {
    await ensureWorker();
    const id = seq++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child!.send({ id, cmd } satisfies WorkerRequest);
    });
  }

  before(async () => {
    const res = await callWorker("warmup");
    assert.equal(res.available, true);
  });

  after(async () => {
    if (!child) return;
    const proc = child;
    child = undefined;
    try {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          proc.kill();
          resolve();
        }, 1500);
        proc.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        proc.send({ id: seq++, cmd: "shutdown" } satisfies WorkerRequest);
      });
    } catch {
      proc.kill();
    }
  });

  test("Hub.addFrame() with SPOTTER=1 emits fields to phone clients only and updates readiness uncapped vs product-capped", async () => {
    const res = await callWorker("fields_and_readiness");
    assert.ok(typeof res.openReadiness === "number" && res.openReadiness > 0.55);
    assert.ok(typeof res.cappedReadiness === "number" && res.cappedReadiness <= 0.55);
    assert.ok(typeof res.strengthScore === "number" && res.strengthScore >= 0.5);
    assert.ok(typeof res.covProduct === "number" && res.covProduct >= 0.5);
  });

  test("Hub.addFrame() two open then two covered sharp frames emit spoken hold_still covered-dose cue to phone, HUD, and stage", async () => {
    const res = await callWorker("covered_cue_fanout");
    assert.equal(res.coachText, "Something is covering the dose. Move your thumb.");
  });

  test("live.busy === true pushes spotCoach.quietUntil forward (+2500ms) and suppresses cues while checking or speaking", async () => {
    const res = await callWorker("busy_quiet_window");
    assert.ok(typeof res.quietDeltaMs === "number" && res.quietDeltaMs >= 2450);
  });

  test("hub.emit verdict resets spotCoach and enforces the 6000ms post-verdict quiet window", async () => {
    const res = await callWorker("verdict_reset_and_quiet");
    assert.ok(typeof res.postVerdictWindowMs === "number" && res.postVerdictWindowMs >= 5950);
  });

  test("hub.dropFrames() clears lastFields and ring and resets spotCoach", async () => {
    const res = await callWorker("drop_frames_reset");
    assert.equal(res.recoveredCoach, true);
  });

  test("SpotThrottle gates concurrent in-flight runs, enforces SPOT.minGapMs, tracks runs/totalMs, and backs off on corrupt JPEG", async () => {
    const res = await callWorker("throttle_and_corrupt_backoff");
    assert.equal(res.runs, 3);
    assert.ok(typeof res.totalMs === "number" && res.totalMs > 0);
  });
}
