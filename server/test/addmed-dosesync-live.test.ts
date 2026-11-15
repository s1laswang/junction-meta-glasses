import { after, afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WebSocket } from "ws";
import type { LabelRead, Med, ServerMsg } from "../../shared/types.ts";
import { env } from "../src/env.ts";
import { ai } from "../src/gemini.ts";
import { Hub } from "../src/hub.ts";
import { LiveProxy } from "../src/live.ts";

const prevQuiet = process.env.HOLDUP_QUIET;
process.env.HOLDUP_QUIET = "1";

const tmpLedger = path.join(os.tmpdir(), `holdup-addmed-dosesync-${process.pid}-${Date.now()}.jsonl`);

type ConnectArg = {
  model: string;
  config: { sessionResumption?: { handle?: string } };
  callbacks: {
    onmessage: (m: any) => void;
    onerror: (e: any) => void;
    onclose: (e: { code: number; reason?: string }) => void;
  };
};

const f = <T>(value: T | null, confidence = 0.95) => ({ value, confidence });

const makeMedLabel = (overrides: Partial<LabelRead> = {}): LabelRead => ({
  kind: "medication",
  product: f("Emconcor 2,5 mg tabletti", 0.96),
  ingredient: f("bisoprolol fumarate", 0.96),
  strength: f("2,5 mg", 0.95),
  dosing: f("1 tablet daily", 0.9),
  expiry: f("2028-09", 0.93),
  allergens: f(null, 0),
  barcode: f(null, 0),
  readability: 0.94,
  ...overrides,
});

const AMLODIPINE_LABEL: LabelRead = makeMedLabel({
  product: f("Norvasc 5 mg"),
  ingredient: f("amlodipine", 0.96),
  strength: f("5 mg", 0.95),
  expiry: f("2028-08", 0.93),
});

const saved = {
  connect: (ai.live as any).connect,
  generate: (ai.models as any).generateContent,
  apiKey: env.apiKey,
  liveModels: [...env.liveModels],
  verifyModels: [...env.verifyModels],
  idleStopMs: env.idleStopMs,
  ledgerPath: env.ledgerPath,
};

function makeSession(arg: ConnectArg) {
  const toolResponses: any[] = [];
  const realtimeInputs: any[] = [];
  let closed = false;
  const session = {
    sendToolResponse: (r: any) => { toolResponses.push(r); },
    sendRealtimeInput: (r: any) => { realtimeInputs.push(r); },
    close: () => { closed = true; },
  };
  return { arg, toolResponses, realtimeInputs, get closed() { return closed; }, session };
}

let sessions: ReturnType<typeof makeSession>[] = [];
let currentLabel: LabelRead = makeMedLabel();
let readCalls = 0;

const sendTool = (s: ReturnType<typeof makeSession>, ...functionCalls: any[]) =>
  s.arg.callbacks.onmessage({ toolCall: { functionCalls } });

function makeRig(id: string, features: ("scene" | "datamatrix" | "addmed" | "sonar")[] = ["addmed", "datamatrix"]) {
  const hub = new Hub(id);
  hub.features = new Set(features);
  hub.profile = {
    meds: [{ id: "aml", name: "Norvasc", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"] }],
    allergies: ["peanut"],
    avoid: ["NSAIDs"],
    doseLog: [],
    lang: "en",
  };
  const emitted: ServerMsg[] = [];
  const hudEmitted: ServerMsg[] = [];
  const waiters: { pred: (m: ServerMsg) => boolean; resolve: (m: ServerMsg) => void }[] = [];

  hub.clients.add({
    readyState: 1,
    send(raw: string) {
      const msg = JSON.parse(raw) as ServerMsg;
      emitted.push(msg);
      const i = waiters.findIndex((w) => w.pred(msg));
      if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    },
  } as unknown as WebSocket);

  hub.huds.add({
    readyState: 1,
    send(raw: string) {
      hudEmitted.push(JSON.parse(raw) as ServerMsg);
    },
  } as unknown as WebSocket);

  const proxy = new LiveProxy(hub, { lang: "en", voice: false });
  hub.live = proxy;

  const pushFrame = (data = `jpeg-frame-${Date.now()}-${Math.random()}`) => {
    hub.ring.push({ data, sharpness: 0.92, ts: Date.now(), bytes: 4096, source: "phone" });
  };

  const waitFor = (pred: (m: ServerMsg) => boolean, from = 0): Promise<ServerMsg> => {
    const hit = emitted.slice(from).find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for ServerMsg")), 2000);
      timer.unref?.();
      waiters.push({ pred, resolve: (m) => { clearTimeout(timer); resolve(m); } });
    });
  };

  const activeSession = () => {
    const s = sessions.at(-1);
    assert.ok(s, "expected connected Live session");
    return s;
  };

  const awaitToolOutput = async (s: ReturnType<typeof makeSession>, before: number) => {
    for (let i = 0; i < 20 && s.toolResponses.length === before; i++) await Promise.resolve();
    assert.ok(s.toolResponses.length > before, "expected sendToolResponse to be called");
    return s.toolResponses.at(-1)!.functionResponses[0].response.output as Record<string, any>;
  };

  const runVerify = async (callId: string, label: LabelRead, question?: string) => {
    const s = activeSession();
    currentLabel = label;
    pushFrame();
    const idx = emitted.length;
    sendTool(s, { id: callId, name: "verify_label", args: question ? { question } : {} });
    await waitFor((m) => m.type === "checking" && m.phase === "end", idx);
    return s.toolResponses.at(-1)!.functionResponses[0].response.output as Record<string, any>;
  };

  const runAddMed = async (callId: string, args: Record<string, unknown>) => {
    const s = activeSession();
    const before = s.toolResponses.length;
    sendTool(s, { id: callId, name: "add_medication", args });
    return awaitToolOutput(s, before);
  };

  const runLogDoseTool = async (callId: string, medId: string) => {
    const s = activeSession();
    const before = s.toolResponses.length;
    sendTool(s, { id: callId, name: "log_dose", args: { medId } });
    return awaitToolOutput(s, before);
  };

  return { hub, proxy, emitted, hudEmitted, activeSession, pushFrame, waitFor, runVerify, runAddMed, runLogDoseTool };
}

async function withRig(
  id: string,
  fn: (r: ReturnType<typeof makeRig>) => Promise<void>,
  features?: ("scene" | "datamatrix" | "addmed" | "sonar")[],
) {
  const r = makeRig(id, features);
  try {
    await fn(r);
  } finally {
    r.proxy.stop("test cleanup");
    r.hub.dropFrames();
  }
}

beforeEach(() => {
  sessions = [];
  readCalls = 0;
  currentLabel = makeMedLabel();
  env.apiKey = "";
  env.liveModels = ["gemini-3.8-live"];
  env.verifyModels = ["gemini-3.8-flash"];
  env.idleStopMs = 600_000;
  env.ledgerPath = tmpLedger;
  (ai.live as any).connect = async (arg: ConnectArg) => {
    const s = makeSession(arg);
    sessions.push(s);
    return s.session;
  };
  (ai.models as any).generateContent = async () => {
    readCalls++;
    return { text: JSON.stringify(currentLabel), usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 18 } };
  };
});

afterEach(() => {
  (ai.live as any).connect = saved.connect;
  (ai.models as any).generateContent = saved.generate;
  env.apiKey = saved.apiKey;
  env.liveModels = [...saved.liveModels];
  env.verifyModels = [...saved.verifyModels];
  env.idleStopMs = saved.idleStopMs;
  env.ledgerPath = saved.ledgerPath;
});

after(() => {
  if (prevQuiet === undefined) delete process.env.HOLDUP_QUIET;
  else process.env.HOLDUP_QUIET = prevQuiet;
  fs.rmSync(tmpLedger, { force: true });
});

test("add_medication returns unknown tool without addmed flag, and need_clear_read when missing or >= 3 min stale", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: new Date(2026, 10, 15, 9, 0, 0) });

  await withRig("am-guard-off", async ({ proxy, runAddMed }) => {
    await proxy.start();
    const res = await runAddMed("off-1", { schedule: ["morning"] });
    assert.deepEqual(res, { error: "unknown tool add_medication" });
  }, []);

  await withRig("am-guard-stale", async ({ proxy, emitted, runVerify, runAddMed }) => {
    await proxy.start();
    const noPrior = await runAddMed("a0", { schedule: ["morning"] });
    assert.equal(noPrior.ok, false);
    assert.equal(noPrior.reason, "need_clear_read");
    assert.equal(emitted.some((m) => m.type === "profile_add"), false);

    await runVerify("v1", makeMedLabel());
    assert.equal(readCalls, 1);

    t.mock.timers.tick(3 * 60_000);
    const stale = await runAddMed("a1", { schedule: ["morning"] });
    assert.equal(stale.ok, false);
    assert.equal(stale.reason, "need_clear_read");
    assert.equal(emitted.some((m) => m.type === "profile_add"), false);
  });
});

test("add_medication returns need_clear_read when kind !== medication or name/strength confidence < 0.8", () =>
  withRig("am-guard-conf", async ({ proxy, emitted, runVerify, runAddMed }) => {
    await proxy.start();

    await runVerify("vf", makeMedLabel({ kind: "food", product: f("Oat Bar", 0.98), allergens: f(["gluten"], 0.97) }));
    const foodRes = await runAddMed("af", { schedule: ["morning"] });
    assert.equal(foodRes.ok, false);
    assert.equal(foodRes.reason, "need_clear_read");

    await runVerify("vo", makeMedLabel({ kind: "other", product: f("Hand Cream", 0.96) }));
    const otherRes = await runAddMed("ao", { schedule: ["evening"] });
    assert.equal(otherRes.ok, false);
    assert.equal(otherRes.reason, "need_clear_read");

    await runVerify("vn", makeMedLabel({ product: f("Emconcor", 0.79), ingredient: f("bisoprolol", 0.79), strength: f("2.5 mg", 0.95) }));
    const lowName = await runAddMed("an", { schedule: ["morning"] });
    assert.equal(lowName.ok, false);
    assert.equal(lowName.reason, "need_clear_read");

    await runVerify("vs", makeMedLabel({ product: f("Emconcor", 0.95), ingredient: f("bisoprolol", 0.95), strength: f("2.5 mg", 0.79) }));
    const lowStrength = await runAddMed("as", { schedule: ["morning"] });
    assert.equal(lowStrength.ok, false);
    assert.equal(lowStrength.reason, "need_clear_read");

    await runVerify("vm", makeMedLabel({ product: f("Emconcor", 0.95), ingredient: f("bisoprolol", 0.95), strength: f(null, 0) }));
    const missingStrength = await runAddMed("am", { schedule: ["morning"] });
    assert.equal(missingStrength.ok, false);
    assert.equal(missingStrength.reason, "need_clear_read");

    assert.equal(emitted.some((m) => m.type === "profile_add"), false);
  }));

test("add_medication returns need_schedule on empty, missing, or whitespace-only schedule arrays", () =>
  withRig("am-guard-sched", async ({ proxy, emitted, runVerify, runAddMed }) => {
    await proxy.start();
    await runVerify("vs1", makeMedLabel());

    const emptyArr = await runAddMed("s1", { schedule: [] });
    assert.equal(emptyArr.ok, false);
    assert.equal(emptyArr.reason, "need_schedule");

    const blankArr = await runAddMed("s2", { schedule: ["", "   ", "\t\n"] });
    assert.equal(blankArr.ok, false);
    assert.equal(blankArr.reason, "need_schedule");

    const missingArr = await runAddMed("s3", {});
    assert.equal(missingArr.ok, false);
    assert.equal(missingArr.reason, "need_schedule");

    assert.equal(emitted.some((m) => m.type === "profile_add"), false);
  }));

test("add_medication returns already_on_list when ingredient or brand + strength matches hub.profile.meds", () =>
  withRig("am-guard-dup", async ({ hub, proxy, emitted, runVerify, runAddMed }) => {
    hub.profile.meds = [
      { id: "aml", name: "Norvasc", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"] },
      { id: "bur", name: "Burana", ingredient: "", strength: "400 mg", schedule: ["morning"] },
    ];
    await proxy.start();

    await runVerify("vd1", makeMedLabel({
      product: f("Amlodipin Orion 5 mg", 0.95),
      ingredient: f("amlodipine besilate", 0.96),
      strength: f("5mg", 0.95),
    }));
    const dupIngr = await runAddMed("d1", { schedule: ["evening"] });
    assert.equal(dupIngr.ok, false);
    assert.equal(dupIngr.reason, "already_on_list");
    assert.equal(dupIngr.speech, "Amlodipine 5 mg is already on your list.");

    await runVerify("vd2", makeMedLabel({
      product: f("Ibumax 400 mg", 0.95),
      ingredient: f("ibuprofen", 0.96),
      strength: f("0,4 g", 0.95),
    }));
    const dupBrand = await runAddMed("d2", { schedule: ["morning"] });
    assert.equal(dupBrand.ok, false);
    assert.equal(dupBrand.reason, "already_on_list");
    assert.equal(dupBrand.speech, "Burana 400 mg is already on your list.");
    assert.equal(emitted.some((m) => m.type === "profile_add"), false);

    await runVerify("vd3", makeMedLabel({
      product: f("Norvasc 10 mg", 0.95),
      ingredient: f("amlodipine", 0.96),
      strength: f("10 mg", 0.95),
    }));
    const diffStrength = await runAddMed("d3", { schedule: ["evening"] });
    assert.equal(diffStrength.ok, true);
    assert.equal(diffStrength.status, "waiting_for_user_confirmation_on_phone");
  }));

test("profile_add strips trailing strength, normalizes decimal comma, carries fresh gtin from lastItemRead, and formats schedule phrases", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: new Date(2026, 10, 15, 8, 15, 0) });

  await withRig("am-propose-fmt", async ({ hub, proxy, emitted, hudEmitted, runVerify, runAddMed }) => {
    await proxy.start();
    hub.setCode({ raw: "010643210009876517280900", gtin: "06432100098765", expiry: "2028-09" });

    await runVerify("vp1", makeMedLabel({
      product: f("Emconcor 2,5 mg tabletti", 0.96),
      ingredient: f("bisoprolol fumarate", 0.96),
      strength: f("2,5 mg", 0.95),
      expiry: f("2028-09", 0.94),
    }));

    t.mock.timers.tick(15_000);
    assert.equal(hub.freshCode(), undefined);

    const idx1 = emitted.length;
    const out1 = await runAddMed("p1", { schedule: ["08:00", "morning", "bedtime"] });
    assert.equal(out1.ok, true);
    assert.equal(out1.status, "waiting_for_user_confirmation_on_phone");

    const addMsg1 = emitted.slice(idx1).find((m): m is Extract<ServerMsg, { type: "profile_add" }> => m.type === "profile_add");
    assert.ok(addMsg1);
    assert.equal(hudEmitted.some((m) => (m as ServerMsg).type === "profile_add"), false);
    assert.equal(addMsg1.med.name, "Emconcor");
    assert.equal(addMsg1.med.ingredient, "bisoprolol");
    assert.equal(addMsg1.med.strength, "2.5 mg");
    assert.equal(addMsg1.med.gtin, "06432100098765");
    assert.deepEqual(addMsg1.med.schedule, ["08:00", "morning", "bedtime"]);
    assert.equal(
      addMsg1.speech,
      "Add Emconcor 2.5 mg, taken at 08:00, in the morning and at bedtime, to your list? Please confirm on your phone.",
    );
    assert.equal(hub.profile.meds.length, 1);

    const idx2 = emitted.length;
    await runAddMed("p2", { name: "Heart pill 2,5 mg daily", schedule: ["08:00"] });
    const addMsg2 = emitted.slice(idx2).find((m): m is Extract<ServerMsg, { type: "profile_add" }> => m.type === "profile_add");
    assert.ok(addMsg2);
    assert.equal(addMsg2.med.name, "Heart pill");
    assert.equal(addMsg2.med.strength, "2.5 mg");
    assert.equal(addMsg2.med.gtin, "06432100098765");
    assert.equal(addMsg2.speech, "Add Heart pill 2.5 mg, taken at 08:00, to your list? Please confirm on your phone.");

    await runVerify("vp2", makeMedLabel({
      product: f("Cardace 5 mg", 0.96),
      ingredient: f("ramipril", 0.96),
      strength: f("5 mg", 0.95),
    }));
    const idx3 = emitted.length;
    await runAddMed("p3", { schedule: ["bedtime"] });
    const addMsg3 = emitted.slice(idx3).find((m): m is Extract<ServerMsg, { type: "profile_add" }> => m.type === "profile_add");
    assert.ok(addMsg3);
    assert.equal(addMsg3.med.gtin, undefined);
    assert.equal(addMsg3.speech, "Add Cardace 5 mg, taken at bedtime, to your list? Please confirm on your phone.");
  });
});

test("profile_add expires after 60s via MockTimers when unanswered and ignores late resolveProposal", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: new Date(2026, 10, 15, 8, 0, 0) });

  await withRig("am-expire-60s", async ({ hub, proxy, emitted, runVerify, runAddMed }) => {
    await proxy.start();
    await runVerify("ve1", makeMedLabel());
    const idx = emitted.length;
    await runAddMed("ae1", { schedule: ["morning"] });
    const addMsg = emitted.slice(idx).find((m): m is Extract<ServerMsg, { type: "profile_add" }> => m.type === "profile_add");
    assert.ok(addMsg);

    const rtIdx = sessions[0].realtimeInputs.length;
    t.mock.timers.tick(59_999);
    assert.equal(sessions[0].realtimeInputs.slice(rtIdx).length, 0);

    t.mock.timers.tick(1);
    const expiryNotes = sessions[0].realtimeInputs.slice(rtIdx);
    assert.equal(expiryNotes.length, 1);
    assert.match(expiryNotes[0].text, /No confirmation came from the phone within a minute, so Emconcor was not saved/);
    assert.equal(hub.profile.meds.length, 1);

    proxy.resolveProposal(addMsg.proposalId, true);
    assert.equal(hub.profile.meds.length, 1);
    assert.equal(sessions[0].realtimeInputs.slice(rtIdx).length, 1);
  });
});

test("resolveProposal(id, false) declines without mutating profile and clears the 60s expiry timer", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: new Date(2026, 10, 15, 8, 0, 0) });

  await withRig("am-decline", async ({ hub, proxy, emitted, runVerify, runAddMed }) => {
    await proxy.start();
    await runVerify("vdec", makeMedLabel());
    const idx = emitted.length;
    await runAddMed("adec", { name: "Emconcor 2,5 mg", schedule: ["morning"] });
    const addMsg = emitted.slice(idx).find((m): m is Extract<ServerMsg, { type: "profile_add" }> => m.type === "profile_add");
    assert.ok(addMsg);

    const rtIdx = sessions[0].realtimeInputs.length;
    proxy.resolveProposal("unknown-proposal-id", true);
    assert.equal(hub.profile.meds.length, 1);
    assert.equal(sessions[0].realtimeInputs.slice(rtIdx).length, 0);

    proxy.resolveProposal(addMsg.proposalId, false);
    assert.equal(hub.profile.meds.length, 1);
    const notes = sessions[0].realtimeInputs.slice(rtIdx);
    assert.equal(notes.length, 1);
    assert.match(notes[0].text, /The user declined: Emconcor was not added/);

    t.mock.timers.tick(60_000);
    assert.equal(sessions[0].realtimeInputs.slice(rtIdx).length, 1);
  });
});

test("resolveProposal(id, true, edited) sanitizes via toProfile, preserves gtin, and makes subsequent verify_label match", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: new Date(2026, 10, 15, 8, 30, 0) });

  await withRig("am-accept-edit", async ({ hub, proxy, emitted, runVerify, runAddMed }) => {
    await proxy.start();
    const gtin = "06432100055555";
    hub.setCode({ raw: `01${gtin}17280900`, gtin, expiry: "2028-09" });

    const beforeOut = await runVerify("va0", makeMedLabel());
    assert.equal(beforeOut.level, "warning");
    assert.equal(beforeOut.matchedMedId, null);

    const idx = emitted.length;
    await runAddMed("aa1", { schedule: ["morning"] });
    const addMsg = emitted.slice(idx).find((m): m is Extract<ServerMsg, { type: "profile_add" }> => m.type === "profile_add");
    assert.ok(addMsg);
    assert.equal(addMsg.med.gtin, gtin);

    const edited = {
      id: addMsg.med.id,
      name: "Emconcor Morning",
      ingredient: "bisoprolol",
      strength: "2.5 mg",
      schedule: ["morning", "", 99, "x".repeat(65), "12:00", "14:00", "16:00", "18:00", "20:00", "22:00", "23:30"],
      notes: "z".repeat(250),
    } as unknown as Med;

    const rtIdx = sessions[0].realtimeInputs.length;
    proxy.resolveProposal(addMsg.proposalId, true, edited);

    assert.equal(hub.profile.meds.length, 2);
    const savedMed = hub.profile.meds.find((m) => m.id === addMsg.med.id);
    assert.ok(savedMed);
    assert.equal(savedMed.name, "Emconcor Morning");
    assert.equal(savedMed.gtin, gtin);
    assert.equal(savedMed.schedule.length, 8);
    assert.equal(savedMed.schedule[0], "morning");
    assert.equal(savedMed.schedule[1], "x".repeat(40));
    assert.equal(savedMed.notes?.length, 200);

    const confirmNotes = sessions[0].realtimeInputs.slice(rtIdx);
    assert.equal(confirmNotes.length, 1);
    assert.match(confirmNotes[0].text, /Saved on the phone: Emconcor Morning 2\.5 mg/);

    t.mock.timers.tick(60_000);
    assert.equal(sessions[0].realtimeInputs.slice(rtIdx).length, 1);

    hub.setCode({ raw: `01${gtin}17280900`, gtin, expiry: "2028-09" });
    const vIdx = emitted.length;
    const afterOut = await runVerify("va2", makeMedLabel());
    assert.equal(afterOut.level, "match");
    assert.equal(afterOut.matchedMedId, addMsg.med.id);
    assert.equal(afterOut.takenToday, false);

    const verdictMsg = emitted.slice(vIdx).find((m): m is Extract<ServerMsg, { type: "verdict" }> => m.type === "verdict");
    assert.ok(verdictMsg);
    assert.equal(verdictMsg.verdict.level, "match");
    assert.equal(verdictMsg.verdict.matchedMedId, addMsg.med.id);
    assert.equal(verdictMsg.verdict.crossCheck?.agrees, true);

    const dupNow = await runAddMed("aa2", { schedule: ["morning"] });
    assert.equal(dupNow.ok, false);
    assert.equal(dupNow.reason, "already_on_list");
  });
});

test("resolveProposal(id, true) without edits saves proposed med, updates matching id in-place, and skips expiry text if stopped", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: new Date(2026, 10, 15, 10, 0, 0) });

  await withRig("am-accept-direct", async ({ hub, proxy, emitted, activeSession, runVerify, runAddMed }) => {
    await proxy.start();

    await runVerify("vd0", makeMedLabel({
      product: f(null, 0),
      ingredient: f("ramipril", 0.94),
      strength: f("5 mg", 0.95),
    }));
    const idx1 = emitted.length;
    await runAddMed("ad1", {
      schedule: ["  morning  ", "afternoon", "evening", "night", "noon", "midday", "08.30", "as needed", "extra-9"],
    });
    const add1 = emitted.slice(idx1).find((m): m is Extract<ServerMsg, { type: "profile_add" }> => m.type === "profile_add");
    assert.ok(add1);
    assert.equal(add1.med.name, "Ramipril");
    assert.equal(add1.med.ingredient, "ramipril");
    assert.equal(add1.med.schedule.length, 8);
    assert.equal(add1.med.schedule[0], "morning");
    assert.match(add1.speech, /in the morning, in the afternoon, in the evening, at night, at noon, at midday, at 08\.30 and as needed/);

    proxy.resolveProposal(add1.proposalId, true);
    assert.equal(hub.profile.meds.length, 2);
    assert.equal(hub.profile.meds[1].id, add1.med.id);

    await runVerify("vd1", makeMedLabel({
      product: f("Devisol 20 mcg", 0.95),
      ingredient: f(null, 0),
      strength: f("20 mcg", 0.95),
    }));
    const idx2 = emitted.length;
    await runAddMed("ad2", { schedule: ["morning"] });
    const add2 = emitted.slice(idx2).find((m): m is Extract<ServerMsg, { type: "profile_add" }> => m.type === "profile_add");
    assert.ok(add2);
    assert.equal(add2.med.name, "Devisol");
    assert.equal(add2.med.ingredient, "devisol");

    proxy.resolveProposal(add2.proposalId, true, {
      id: add1.med.id,
      name: "Ramipril Updated",
      ingredient: "ramipril",
      strength: "5 mg",
      schedule: ["evening"],
    });
    assert.equal(hub.profile.meds.length, 2);
    assert.equal(hub.profile.meds[1].name, "Ramipril Updated");

    const idx3 = emitted.length;
    await runAddMed("ad3", { schedule: ["morning"] });
    const add3 = emitted.slice(idx3).find((m): m is Extract<ServerMsg, { type: "profile_add" }> => m.type === "profile_add");
    assert.ok(add3);
    const s = activeSession();
    const rtBeforeStop = s.realtimeInputs.length;
    proxy.stop("session ended");
    t.mock.timers.tick(60_000);
    assert.equal(s.realtimeInputs.slice(rtBeforeStop).length, 0);
  });
});

test("log_dose tool emits dose_logged to phone, updates HUD verdict takenToday without echoing verdict to phone, and makes next verify_label warn already taken today", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: new Date(2026, 10, 15, 19, 0, 0) });

  await withRig("dose-sync-tool", async ({ hub, proxy, emitted, hudEmitted, runVerify, runLogDoseTool }) => {
    await proxy.start();

    const firstVerify = await runVerify("dv1", AMLODIPINE_LABEL);
    assert.equal(firstVerify.level, "match");
    assert.equal(firstVerify.matchedMedId, "aml");
    assert.equal(firstVerify.takenToday, false);
    assert.equal(hub.lastVerdict?.takenToday, false);

    const badPhoneIdx = emitted.length;
    const badHudIdx = hudEmitted.length;
    const badDose = await runLogDoseTool("dl-bad", "missing-med");
    assert.deepEqual(badDose, { ok: false, error: "unknown medId" });
    assert.equal(emitted.slice(badPhoneIdx).length, 0);
    assert.equal(hudEmitted.slice(badHudIdx).length, 0);

    const phoneIdx = emitted.length;
    const hudIdx = hudEmitted.length;
    const okDose = await runLogDoseTool("dl-ok", "aml");
    assert.deepEqual(okDose, { ok: true, med: "Norvasc" });
    assert.equal(hub.profile.doseLog.length, 1);
    assert.equal(hub.profile.doseLog[0].medId, "aml");
    assert.equal(hub.lastVerdict?.takenToday, true);

    const phoneMsgs = emitted.slice(phoneIdx);
    assert.equal(phoneMsgs.length, 1);
    assert.equal(phoneMsgs[0].type, "dose_logged");
    if (phoneMsgs[0].type === "dose_logged") assert.equal(phoneMsgs[0].medId, "aml");
    assert.equal(phoneMsgs.some((m) => m.type === "verdict"), false);

    const hudMsgs = hudEmitted.slice(hudIdx);
    assert.equal(hudMsgs.length, 1);
    assert.equal(hudMsgs[0].type, "verdict");
    if (hudMsgs[0].type === "verdict") {
      assert.equal(hudMsgs[0].verdict.matchedMedId, "aml");
      assert.equal(hudMsgs[0].verdict.takenToday, true);
    }

    const secondIdx = emitted.length;
    const secondVerify = await runVerify("dv2", AMLODIPINE_LABEL);
    assert.equal(secondVerify.level, "warning");
    assert.equal(secondVerify.matchedMedId, "aml");
    assert.equal(secondVerify.takenToday, true);
    assert.match(String(secondVerify.headline), /already taken today/i);

    const warnMsg = emitted.slice(secondIdx).find((m): m is Extract<ServerMsg, { type: "verdict" }> => m.type === "verdict");
    assert.ok(warnMsg);
    assert.equal(warnMsg.verdict.level, "warning");
    assert.match(warnMsg.verdict.headline, /already taken today/i);
    assert.equal(warnMsg.verdict.takenToday, true);
  });
});

test("handleEvent covers log_dose missing matchedMedId error, HUD-only verdict sync, repeat replay, and stop", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: new Date(2026, 10, 15, 19, 30, 0) });

  await withRig("dose-sync-events", async ({ hub, proxy, emitted, hudEmitted, activeSession, runVerify }) => {
    await proxy.start();
    const s = activeSession();

    let phoneIdx = emitted.length;
    let hudIdx = hudEmitted.length;
    let rtIdx = s.realtimeInputs.length;
    proxy.handleEvent("repeat");
    assert.equal(emitted.slice(phoneIdx).length, 0);
    assert.equal(hudEmitted.slice(hudIdx).length, 0);
    assert.equal(s.realtimeInputs.slice(rtIdx).length, 1);
    assert.match(s.realtimeInputs[rtIdx].text, /The user pressed Repeat/);

    phoneIdx = emitted.length;
    hudIdx = hudEmitted.length;
    proxy.handleEvent("log_dose");
    assert.deepEqual(emitted.slice(phoneIdx), [
      { type: "error", code: "bad_input", message: "No matched medicine to log yet.", recoverable: true },
    ]);
    assert.equal(hudEmitted.slice(hudIdx).length, 0);
    assert.equal(hub.profile.doseLog.length, 0);

    await runVerify("ev-unlisted", makeMedLabel({
      product: f("Zyrtec 10 mg", 0.96),
      ingredient: f("cetirizine", 0.96),
      strength: f("10 mg", 0.95),
    }));
    assert.equal(hub.lastVerdict?.matchedMedId, undefined);

    phoneIdx = emitted.length;
    proxy.handleEvent("log_dose");
    assert.deepEqual(emitted.slice(phoneIdx), [
      { type: "error", code: "bad_input", message: "No matched medicine to log yet.", recoverable: true },
    ]);
    assert.equal(hub.profile.doseLog.length, 0);

    await runVerify("ev-match", AMLODIPINE_LABEL);
    assert.equal(hub.lastVerdict?.matchedMedId, "aml");
    assert.equal(hub.lastVerdict?.takenToday, false);

    phoneIdx = emitted.length;
    hudIdx = hudEmitted.length;
    rtIdx = s.realtimeInputs.length;
    proxy.handleEvent("log_dose");

    assert.equal(hub.profile.doseLog.length, 1);
    assert.equal(hub.profile.doseLog[0].medId, "aml");
    assert.equal(hub.lastVerdict?.takenToday, true);
    assert.equal(emitted.slice(phoneIdx).length, 0);
    assert.equal(hudEmitted.slice(hudIdx).length, 1);
    const syncedHud = hudEmitted[hudIdx];
    assert.equal(syncedHud.type, "verdict");
    if (syncedHud.type === "verdict") assert.equal(syncedHud.verdict.takenToday, true);
    assert.equal(sessions[0].realtimeInputs.slice(rtIdx).length, 1);
    assert.match(sessions[0].realtimeInputs[rtIdx].text, /The user just logged a dose of Norvasc/);

    phoneIdx = emitted.length;
    hudIdx = hudEmitted.length;
    rtIdx = sessions[0].realtimeInputs.length;
    proxy.handleEvent("repeat");

    assert.equal(emitted.slice(phoneIdx).length, 1);
    const repeatedPhone = emitted[phoneIdx];
    assert.equal(repeatedPhone.type, "verdict");
    if (repeatedPhone.type === "verdict") assert.equal(repeatedPhone.verdict.takenToday, true);
    assert.equal(hudEmitted.slice(hudIdx).length, 1);
    assert.equal(hudEmitted[hudIdx].type, "verdict");
    assert.equal(sessions[0].realtimeInputs.slice(rtIdx).length, 1);
    assert.match(sessions[0].realtimeInputs[rtIdx].text, /The user pressed Repeat/);

    const nextVerify = await runVerify("ev-after", AMLODIPINE_LABEL);
    assert.equal(nextVerify.level, "warning");
    assert.match(String(nextVerify.headline), /already taken today/i);
    assert.equal(nextVerify.takenToday, true);

    phoneIdx = emitted.length;
    hudIdx = hudEmitted.length;
    proxy.handleEvent("stop");

    assert.equal(proxy.active, false);
    assert.equal(sessions[0].closed, true);
    assert.deepEqual(emitted.slice(phoneIdx), [{ type: "status", live: "closed", detail: "stopped by user" }]);
    assert.deepEqual(hudEmitted.slice(hudIdx), [{ type: "status", live: "closed", detail: "stopped by user" }]);
  });
});
