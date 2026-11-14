import { after, afterEach, beforeEach, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type WebSocket from "ws";
import type { LabelRead, Med, ServerMsg } from "../../shared/types.ts";
import { ALL_FEATURES, env } from "../src/env.ts";
import { ai } from "../src/gemini.ts";
import { parseGs1 } from "../src/gs1.ts";
import { Hub } from "../src/hub.ts";
import { LiveProxy } from "../src/live.ts";
import { SPEC } from "../src/speculate.ts";

const originalQuiet = process.env.HOLDUP_QUIET;
process.env.HOLDUP_QUIET = "1";

type ConnectArg = {
  model: string;
  config: {
    tools?: { functionDeclarations?: { name?: string }[] }[];
    systemInstruction?: string;
    sessionResumption?: { handle?: string };
  };
  callbacks: {
    onmessage: (m: any) => void;
    onerror: (e: any) => void;
    onclose: (e: { code: number; reason?: string }) => void;
  };
};

const f = <T>(value: T | null, confidence = 0.95) => ({ value, confidence });

const makeRead = (overrides: Partial<LabelRead> = {}): LabelRead => ({
  kind: "medication",
  product: f("Glucophage 500 mg"),
  ingredient: f("metformin hydrochloride", 0.96),
  strength: f("500 mg", 0.95),
  dosing: f("1 tablet twice daily", 0.9),
  expiry: f("2028-06", 0.93),
  allergens: f<string[]>(null, 0),
  barcode: f(null, 0),
  readability: 0.93,
  ...overrides,
});

const AML_GTIN = "09501101530003";
const MET_GTIN = "06410045012349";
const CUSTOM_GTIN = "06410045099994";
const CUSTOM_EAN13 = "6410045099994";

const shmRoot = fs.existsSync("/dev/shm") ? "/dev/shm" : os.tmpdir();

const saved = {
  connect: (ai.live as any).connect,
  generate: (ai.models as any).generateContent,
  liveModels: [...env.liveModels],
  verifyModels: [...env.verifyModels],
  features: [...env.features],
  idleStopMs: env.idleStopMs,
  ledgerPath: env.ledgerPath,
  debounce: SPEC.debounceMs,
  minGap: SPEC.minGapMs,
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
let tempDirs: string[] = [];

const sendTool = (s: ReturnType<typeof makeSession>, ...functionCalls: any[]) =>
  s.arg.callbacks.onmessage({ toolCall: { functionCalls } });

async function flushMicrotasks(turns = 8) {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

function makeRig(
  id: string,
  opts: {
    lang?: string;
    features?: Iterable<string>;
    meds?: Med[];
    allergies?: string[];
    avoid?: string[];
  } = {},
) {
  const hub = new Hub(id);
  const lang = opts.lang ?? "en";
  hub.profile = {
    meds: opts.meds ?? [
      { id: "aml", name: "Amlodipine", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"], gtin: AML_GTIN },
    ],
    allergies: opts.allergies ?? ["penicillin", "lactose", "peanut"],
    avoid: opts.avoid ?? ["NSAIDs", "tramadol"],
    doseLog: [],
    lang,
  };
  hub.features = new Set(opts.features ?? ["addmed", "datamatrix"]) as Hub["features"];
  const emitted: ServerMsg[] = [];
  hub.clients.add({
    readyState: 1,
    send(raw: string) {
      emitted.push(JSON.parse(raw) as ServerMsg);
    },
  } as unknown as WebSocket);
  const proxy = new LiveProxy(hub, { lang, voice: true });
  hub.live = proxy;
  return { hub, proxy, emitted };
}

async function withRig(
  id: string,
  opts: Parameters<typeof makeRig>[1],
  fn: (r: ReturnType<typeof makeRig>) => Promise<void>,
) {
  const r = makeRig(id, opts);
  try {
    await fn(r);
  } finally {
    r.proxy.stop("test done");
    r.hub.dropFrames();
  }
}

async function verifyAndPropose(
  r: ReturnType<typeof makeRig>,
  s: ReturnType<typeof makeSession>,
  read: LabelRead,
  args: Record<string, unknown>,
  tag: string,
) {
  (ai.models as any).generateContent = async () => ({
    text: JSON.stringify(read),
    usageMetadata: {},
  });
  r.hub.ring.push({ data: `frame-${tag}`, sharpness: 0.93, ts: Date.now(), bytes: 4096, source: "phone" });
  sendTool(s, { id: `v-${tag}`, name: "verify_label", args: {} });
  await flushMicrotasks();
  const before = r.emitted.length;
  sendTool(s, { id: `am-${tag}`, name: "add_medication", args });
  await flushMicrotasks();
  const output = s.toolResponses.at(-1)!.functionResponses[0].response.output as Record<string, any>;
  const newMsgs = r.emitted.slice(before);
  return { output, newMsgs };
}

beforeEach(() => {
  sessions = [];
  const dir = fs.mkdtempSync(path.join(shmRoot, "holdup-addmed-guards-"));
  tempDirs.push(dir);
  env.ledgerPath = path.join(dir, "ledger.jsonl");
  env.liveModels = ["gemini-3.8-live"];
  env.verifyModels = ["gemini-3.8-flash"];
  env.features = [...ALL_FEATURES];
  env.idleStopMs = 45_000;
  SPEC.debounceMs = 60_000;
  SPEC.minGapMs = 60_000;
  (ai.live as any).connect = async (arg: ConnectArg) => {
    const s = makeSession(arg);
    sessions.push(s);
    return s.session;
  };
  (ai.models as any).generateContent = async () => ({
    text: JSON.stringify(makeRead()),
    usageMetadata: {},
  });
});

afterEach(() => {
  (ai.live as any).connect = saved.connect;
  (ai.models as any).generateContent = saved.generate;
  env.liveModels = [...saved.liveModels];
  env.verifyModels = [...saved.verifyModels];
  env.features = [...saved.features];
  env.idleStopMs = saved.idleStopMs;
  env.ledgerPath = saved.ledgerPath;
  SPEC.debounceMs = saved.debounce;
  SPEC.minGapMs = saved.minGap;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

after(() => {
  if (originalQuiet === undefined) delete process.env.HOLDUP_QUIET;
  else process.env.HOLDUP_QUIET = originalQuiet;
});

test("add_medication refuses code_conflict when DataMatrix expiry or GTIN disagrees with printed label", () =>
  withRig("guard-code-conflict", {}, async (r) => {
    await r.proxy.start();
    const s = sessions[0];

    const mismatchExpiry = parseGs1(`(01)${MET_GTIN}(17)290100(10)LOT1`);
    assert.ok(mismatchExpiry);
    r.hub.setCode(mismatchExpiry);
    const res1 = await verifyAndPropose(
      r,
      s,
      makeRead({ product: f("Glucophage 500 mg"), ingredient: f("metformin", 0.96), expiry: f("2027-08", 0.94) }),
      { schedule: ["morning"] },
      "exp-conflict",
    );
    assert.deepEqual(res1.output, {
      ok: false,
      reason: "code_conflict",
      speech: "The printed label and the pack's code disagree. Please ask a pharmacist before adding it.",
    });
    assert.equal(res1.newMsgs.some((m) => m.type === "profile_add"), false);
    assert.equal(r.hub.profile.meds.length, 1);

    const wrongMedGtin = parseGs1(`(01)${AML_GTIN}(17)280600(10)LOT2`);
    assert.ok(wrongMedGtin);
    r.hub.setCode(wrongMedGtin);
    const res2 = await verifyAndPropose(
      r,
      s,
      makeRead({ product: f("Glucophage 500 mg"), ingredient: f("metformin", 0.96), expiry: f("2028-06", 0.94) }),
      { schedule: ["morning"] },
      "gtin-conflict",
    );
    assert.equal(res2.output.ok, false);
    assert.equal(res2.output.reason, "code_conflict");
    assert.equal(res2.newMsgs.some((m) => m.type === "profile_add"), false);

    const agreeCode = parseGs1(`(01)${MET_GTIN}(17)280600(10)LOT3`);
    assert.ok(agreeCode);
    r.hub.setCode(agreeCode);
    const res3 = await verifyAndPropose(
      r,
      s,
      makeRead({ product: f("Glucophage 500 mg"), ingredient: f("metformin", 0.96), expiry: f("2028-06", 0.94) }),
      { schedule: ["morning"] },
      "agree-box1",
    );
    assert.equal(res3.output.ok, true);
    const addBox1 = res3.newMsgs.find((m) => m.type === "profile_add");
    assert.ok(addBox1 && addBox1.type === "profile_add");
    r.proxy.resolveProposal(addBox1.proposalId, true);
    assert.equal(r.hub.lastCode, undefined);

    const res4 = await verifyAndPropose(
      r,
      s,
      makeRead({ product: f("Emconcor 2.5 mg"), ingredient: f("bisoprolol", 0.96), strength: f("2.5 mg", 0.95), expiry: f("2027-08", 0.92) }),
      { schedule: ["morning"] },
      "box2-without-dm",
    );
    assert.equal(res4.output.ok, true);
    assert.equal(res4.newMsgs.some((m) => m.type === "profile_add"), true);
  }));

test("add_medication refuses allergy_warning for penicillin drug class and lactose/peanut excipients", () =>
  withRig("guard-allergy", { allergies: ["penicillin", "lactose", "peanut"] }, async (r) => {
    await r.proxy.start();
    const s = sessions[0];

    const penRes = await verifyAndPropose(
      r,
      s,
      makeRead({
        product: f("Amorion 500 mg"),
        ingredient: f("amoxicillin trihydrate", 0.96),
        strength: f("500 mg", 0.95),
      }),
      { schedule: ["morning", "evening"] },
      "penicillin",
    );
    assert.deepEqual(penRes.output, {
      ok: false,
      reason: "allergy_warning",
      speech: "Warning: this medicine matches your penicillin allergy (amoxicillin). Please check with a pharmacist before adding it.",
    });
    assert.equal(penRes.newMsgs.some((m) => m.type === "profile_add"), false);

    const excipientLactose = await verifyAndPropose(
      r,
      s,
      makeRead({
        product: f("Bisoprolol Orion 5 mg"),
        ingredient: f("bisoprolol fumarate", 0.96),
        strength: f("5 mg", 0.95),
        allergens: f(["lactose monohydrate"], 0.91),
      }),
      { schedule: ["morning"] },
      "lactose",
    );
    assert.deepEqual(excipientLactose.output, {
      ok: false,
      reason: "allergy_warning",
      speech: "Warning: this medicine matches your lactose allergy (lactose monohydrate). Please check with a pharmacist before adding it.",
    });
    assert.equal(excipientLactose.newMsgs.some((m) => m.type === "profile_add"), false);

    const excipientPeanut = await verifyAndPropose(
      r,
      s,
      makeRead({
        product: f("Devisol 20 mikrog"),
        ingredient: f("colecalciferol", 0.95),
        strength: f("20 mikrog", 0.95),
        allergens: f(["arachis oil (peanut oil)"], 0.9),
      }),
      { schedule: ["morning"] },
      "peanut-oil",
    );
    assert.equal(excipientPeanut.output.ok, false);
    assert.equal(excipientPeanut.output.reason, "allergy_warning");
    assert.match(excipientPeanut.output.speech, /peanut allergy \(arachis oil \(peanut oil\)\)/i);
    assert.equal(excipientPeanut.newMsgs.some((m) => m.type === "profile_add"), false);
  }));

test("add_medication refuses avoid_warning for Burana/NSAIDs class and direct avoid entry", () =>
  withRig("guard-avoid", { avoid: ["NSAIDs", "tramadol"] }, async (r) => {
    await r.proxy.start();
    const s = sessions[0];

    const buranaBrandOnly = await verifyAndPropose(
      r,
      s,
      makeRead({
        product: f("Burana 400 mg", 0.96),
        ingredient: f(null, 0),
        strength: f("400 mg", 0.95),
      }),
      { schedule: ["as needed"] },
      "burana",
    );
    assert.deepEqual(buranaBrandOnly.output, {
      ok: false,
      reason: "avoid_warning",
      speech: "Warning: ibuprofen is an NSAID, on your avoid list. Please check with a pharmacist before adding it.",
    });
    assert.equal(buranaBrandOnly.newMsgs.some((m) => m.type === "profile_add"), false);

    const directAvoid = await verifyAndPropose(
      r,
      s,
      makeRead({
        product: f("Tramal 50 mg", 0.95),
        ingredient: f("tramadol hydrochloride", 0.96),
        strength: f("50 mg", 0.95),
      }),
      { schedule: ["evening"] },
      "tramadol",
    );
    assert.deepEqual(directAvoid.output, {
      ok: false,
      reason: "avoid_warning",
      speech: "Warning: tramadol is on your avoid list. Please check with a pharmacist before adding it.",
    });
    assert.equal(directAvoid.newMsgs.some((m) => m.type === "profile_add"), false);
  }));

test("add_medication refuses expired printed date and expired DataMatrix codeExpiry while allowing low-confidence printed date", () =>
  withRig("guard-expired", {}, async (r) => {
    await r.proxy.start();
    const s = sessions[0];

    const printedExp = await verifyAndPropose(
      r,
      s,
      makeRead({
        product: f("Glucophage 500 mg"),
        ingredient: f("metformin", 0.96),
        strength: f("500 mg", 0.95),
        expiry: f("2024-05", 0.92),
      }),
      { schedule: ["morning"] },
      "printed-exp",
    );
    assert.deepEqual(printedExp.output, {
      ok: false,
      reason: "expired",
      speech: "This pack is expired. Please check an in-date pack before adding it to your list.",
    });
    assert.equal(printedExp.newMsgs.some((m) => m.type === "profile_add"), false);

    const dmExpired = parseGs1(`(01)${MET_GTIN}(17)240500(10)OLD1`);
    assert.ok(dmExpired);
    r.hub.setCode(dmExpired);
    const codeExp = await verifyAndPropose(
      r,
      s,
      makeRead({
        product: f("Glucophage 500 mg"),
        ingredient: f("metformin", 0.96),
        strength: f("500 mg", 0.95),
        expiry: f(null, 0),
      }),
      { schedule: ["morning"] },
      "dm-exp",
    );
    assert.deepEqual(codeExp.output, {
      ok: false,
      reason: "expired",
      speech: "This pack is expired. Please check an in-date pack before adding it to your list.",
    });
    assert.equal(codeExp.newMsgs.some((m) => m.type === "profile_add"), false);

    r.hub.dropFrames();
    const lowConfExp = await verifyAndPropose(
      r,
      s,
      makeRead({
        product: f("Glucophage 500 mg"),
        ingredient: f("metformin", 0.96),
        strength: f("500 mg", 0.95),
        expiry: f("2024-05", 0.55),
      }),
      { schedule: ["morning"] },
      "lowconf-exp",
    );
    assert.equal(lowConfExp.output.ok, true);
    assert.equal(lowConfExp.newMsgs.some((m) => m.type === "profile_add"), true);
  }));

test("add_medication catches brand-only Norvasc duplicate, combo Exforge duplicate, and saved GTIN/barcode duplicate", () =>
  withRig(
    "guard-duplicates",
    {
      meds: [
        { id: "aml", name: "Amlodipine", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"] },
        { id: "exf", name: "Amlodipine / Valsartan", ingredient: "amlodipine / valsartan", strength: "5 mg/160 mg", schedule: ["morning"] },
      ],
    },
    async (r) => {
      await r.proxy.start();
      const s = sessions[0];

      const brandOnlyDup = await verifyAndPropose(
        r,
        s,
        makeRead({
          product: f("Norvasc 5 mg", 0.96),
          ingredient: f(null, 0),
          strength: f("5 mg", 0.95),
        }),
        { schedule: ["evening"] },
        "norvasc-brand-only",
      );
      assert.deepEqual(brandOnlyDup.output, {
        ok: false,
        reason: "already_on_list",
        speech: "Amlodipine 5 mg is already on your list.",
      });
      assert.equal(brandOnlyDup.newMsgs.some((m) => m.type === "profile_add"), false);

      const exforgeBrandOnlyDup = await verifyAndPropose(
        r,
        s,
        makeRead({
          product: f("Exforge 5 mg / 160 mg", 0.96),
          ingredient: f(null, 0),
          strength: f("5 mg / 160 mg", 0.95),
        }),
        { schedule: ["morning"] },
        "exforge-brand-only",
      );
      assert.equal(exforgeBrandOnlyDup.output.ok, false);
      assert.equal(exforgeBrandOnlyDup.output.reason, "already_on_list");
      assert.equal(exforgeBrandOnlyDup.newMsgs.some((m) => m.type === "profile_add"), false);

      const exforgeIngrDup = await verifyAndPropose(
        r,
        s,
        makeRead({
          product: f("Exforge 5 mg / 160 mg", 0.96),
          ingredient: f("amlodipine besilate / valsartan", 0.96),
          strength: f("5 mg / 160 mg", 0.95),
        }),
        { schedule: ["morning"] },
        "exforge-ingr",
      );
      assert.equal(exforgeIngrDup.output.ok, false);
      assert.equal(exforgeIngrDup.output.reason, "already_on_list");

      const exforgeDiffStrength = await verifyAndPropose(
        r,
        s,
        makeRead({
          product: f("Exforge 10 mg / 160 mg", 0.96),
          ingredient: f("amlodipine besilate / valsartan", 0.96),
          strength: f("10 mg / 160 mg", 0.95),
        }),
        { schedule: ["morning"] },
        "exforge-10-160",
      );
      assert.equal(exforgeDiffStrength.output.ok, true);
      const exforgeAdd = exforgeDiffStrength.newMsgs.find((m) => m.type === "profile_add");
      assert.ok(exforgeAdd && exforgeAdd.type === "profile_add");
      assert.equal(exforgeAdd.med.name, "Exforge");
      assert.equal(exforgeAdd.med.ingredient, "amlodipine / valsartan");
      assert.equal(exforgeAdd.med.strength, "10 mg / 160 mg");

      const customCode = parseGs1(`(01)${CUSTOM_GTIN}(17)280600(10)B1`);
      assert.ok(customCode);
      r.hub.setCode(customCode);
      (ai.models as any).generateContent = async () => ({
        text: JSON.stringify(makeRead({
          product: f("UnmappedBrand 20 mg", 0.95),
          ingredient: f(null, 0),
          strength: f("20 mg", 0.95),
          expiry: f("2028-06", 0.93),
        })),
        usageMetadata: {},
      });
      r.hub.ring.push({ data: "frame-gtin-dup", sharpness: 0.94, ts: Date.now(), bytes: 4096, source: "phone" });
      sendTool(s, { id: "v-gtin-dup", name: "verify_label", args: {} });
      await flushMicrotasks();

      r.hub.profile.meds.push({
        id: "custom-ean",
        name: "My Heart Pill",
        ingredient: "custominn",
        strength: "20 mg",
        schedule: ["morning"],
        barcode: CUSTOM_EAN13,
      });
      sendTool(s, { id: "am-gtin-dup", name: "add_medication", args: { schedule: ["morning"] } });
      await flushMicrotasks();
      const gtinDupOut = s.toolResponses.at(-1)!.functionResponses[0].response.output;
      assert.equal(gtinDupOut.ok, false);
      assert.equal(gtinDupOut.reason, "already_on_list");
    },
  ));

test("add_medication strips Nordic 100 mikrog and combo strength tails without double strength and strips combo salt suffixes", () =>
  withRig("guard-nordic-combo-strip", { meds: [] }, async (r) => {
    await r.proxy.start();
    const s = sessions[0];

    const thyroxinRes = await verifyAndPropose(
      r,
      s,
      makeRead({
        product: f("Thyroxin 100 mikrog", 0.96),
        ingredient: f("levothyroxine sodium", 0.96),
        strength: f("100 mikrog", 0.95),
      }),
      { schedule: ["morning"] },
      "thyroxin",
    );
    assert.equal(thyroxinRes.output.ok, true);
    const thyroxinMsg = thyroxinRes.newMsgs.find((m) => m.type === "profile_add");
    assert.ok(thyroxinMsg && thyroxinMsg.type === "profile_add");
    assert.equal(thyroxinMsg.med.name, "Thyroxin");
    assert.equal(thyroxinMsg.med.ingredient, "levothyroxine");
    assert.equal(thyroxinMsg.med.strength, "100 mikrog");
    assert.equal(thyroxinMsg.speech, "Add Thyroxin 100 mikrog, taken in the morning, to your list? Please confirm on your phone.");
    assert.equal(thyroxinMsg.speech.includes("100 mikrog 100 mikrog"), false);

    const argNameRes = await verifyAndPropose(
      r,
      s,
      makeRead({
        product: f("Thyroxin 100 mikrogrammaa tabletti", 0.96),
        ingredient: f("levothyroxine sodium", 0.96),
        strength: f("100 mikrog", 0.95),
      }),
      { schedule: ["morning"], name: "Thyroxin 100 mikrog" },
      "thyroxin-arg",
    );
    assert.equal(argNameRes.output.ok, true);
    const argNameMsg = argNameRes.newMsgs.find((m) => m.type === "profile_add");
    assert.ok(argNameMsg && argNameMsg.type === "profile_add");
    assert.equal(argNameMsg.med.name, "Thyroxin");
    assert.equal(argNameMsg.speech.includes("100 mikrog 100 mikrog"), false);

    const comboSaltRes = await verifyAndPropose(
      r,
      s,
      makeRead({
        product: f("Losatrix Comp 50 mg / 12,5 mg kalvopäällysteinen tabletti", 0.96),
        ingredient: f("Losartan potassium + Hydrochlorothiazide", 0.95),
        strength: f("50 mg / 12,5 mg", 0.95),
      }),
      { schedule: ["morning"] },
      "combo-salt",
    );
    assert.equal(comboSaltRes.output.ok, true);
    const comboSaltMsg = comboSaltRes.newMsgs.find((m) => m.type === "profile_add");
    assert.ok(comboSaltMsg && comboSaltMsg.type === "profile_add");
    assert.equal(comboSaltMsg.med.name, "Losatrix Comp");
    assert.equal(comboSaltMsg.med.ingredient, "losartan / hydrochlorothiazide");
    assert.equal(comboSaltMsg.med.strength, "50 mg / 12.5 mg");
  }));

test("stop() clears pending 60s proposal timers so stopped sessions never leak timers or send post-stop text", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: Date.parse("2026-11-14T12:00:00Z") });

  const rActive = makeRig("proposal-timer-active", { meds: [] });
  try {
    await rActive.proxy.start();
    const sActive = sessions[0];
    const propActive = await verifyAndPropose(
      rActive,
      sActive,
      makeRead({ product: f("Glucophage 500 mg"), ingredient: f("metformin hydrochloride", 0.96), strength: f("500 mg", 0.95) }),
      { schedule: ["morning"] },
      "active-timeout",
    );
    assert.equal(propActive.output.ok, true);
    const activeAdd = propActive.newMsgs.find((m) => m.type === "profile_add");
    assert.ok(activeAdd && activeAdd.type === "profile_add");

    t.mock.timers.tick(30_000);
    rActive.proxy.frame("keepalive-active");
    t.mock.timers.tick(29_999);
    assert.equal(
      sActive.realtimeInputs.some((x) => typeof x.text === "string" && x.text.includes("No confirmation came from the phone")),
      false,
    );

    t.mock.timers.tick(1);
    assert.equal(
      sActive.realtimeInputs.some((x) => typeof x.text === "string" && x.text.includes("No confirmation came from the phone within a minute, so Glucophage was not saved")),
      true,
    );
    rActive.proxy.resolveProposal(activeAdd.proposalId, true);
    assert.equal(rActive.hub.profile.meds.length, 0);
  } finally {
    rActive.proxy.stop("cleanup active");
    rActive.hub.dropFrames();
  }

  const rStopped = makeRig("proposal-timer-stopped", { meds: [] });
  try {
    await rStopped.proxy.start();
    const sStopped = sessions[1];
    const prop1 = await verifyAndPropose(
      rStopped,
      sStopped,
      makeRead({ product: f("Glucophage 500 mg"), ingredient: f("metformin", 0.96), strength: f("500 mg", 0.95) }),
      { schedule: ["morning"] },
      "stop-1",
    );
    const prop2 = await verifyAndPropose(
      rStopped,
      sStopped,
      makeRead({ product: f("Thyroxin 100 mikrog"), ingredient: f("levothyroxine sodium", 0.96), strength: f("100 mikrog", 0.95) }),
      { schedule: ["morning"] },
      "stop-2",
    );
    const add1 = prop1.newMsgs.find((m) => m.type === "profile_add");
    const add2 = prop2.newMsgs.find((m) => m.type === "profile_add");
    assert.ok(add1 && add1.type === "profile_add");
    assert.ok(add2 && add2.type === "profile_add");

    t.mock.timers.tick(5_000);
    const inputsBeforeStop = sStopped.realtimeInputs.length;
    rStopped.proxy.stop("stopped by user");
    assert.equal(rStopped.proxy.active, false);

    t.mock.timers.tick(120_000);
    assert.equal(sStopped.realtimeInputs.length, inputsBeforeStop);
    rStopped.proxy.resolveProposal(add1.proposalId, true);
    rStopped.proxy.resolveProposal(add2.proposalId, true);
    assert.equal(rStopped.hub.profile.meds.length, 0);
    assert.equal(sStopped.realtimeInputs.length, inputsBeforeStop);
  } finally {
    rStopped.proxy.stop("cleanup stopped");
    rStopped.hub.dropFrames();
  }
});
