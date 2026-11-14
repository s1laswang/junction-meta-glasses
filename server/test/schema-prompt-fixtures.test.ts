import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Behavior, Type } from "@google/genai";
import type { CoachCue, LabelRead, Profile, Verdict, VerdictLevel } from "../../shared/types.ts";
import { env, REPO_ROOT, SERVER_DIR } from "../src/env.ts";
import { ai } from "../src/gemini.ts";
import { getOrCreateHub } from "../src/hub.ts";
import { createApp } from "../src/index.ts";
import { TOOLS } from "../src/live.ts";
import { checkLabel } from "../src/safety.ts";
import { jpegSharpness, jpegSize, LABEL_SCHEMA, VERIFY_PROMPT } from "../src/verify.ts";

const SCHEMA_PATH = path.join(REPO_ROOT, "shared", "label_schema.json");
const PROMPT_PATH = path.join(REPO_ROOT, "shared", "verify_prompt.md");
const FIXTURE_PATH = path.join(SERVER_DIR, "fixtures", "amlodipine.jpg");
const BRIDGE_PATH = path.join(REPO_ROOT, "eval", "safety_bridge.mts");
const SAFETY_TS_PATH = path.join(SERVER_DIR, "src", "safety.ts");

function collectKeys(node: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) collectKeys(item, out);
    return out;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out.add(k);
      collectKeys(v, out);
    }
  }
  return out;
}

function httpPost(
  port: number,
  reqPath: string,
  body: Buffer | string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = typeof body === "string" ? Buffer.from(body, "utf8") : body;
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: reqPath,
        method: "POST",
        headers: {
          ...headers,
          "content-length": String(payload.length),
          ...(process.env.HOLDUP_KEY ? { "x-holdup-key": process.env.HOLDUP_KEY } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

const f = <T>(value: T | null, confidence = 0.95) => ({ value, confidence });

function mkRead(partial: Partial<LabelRead>): LabelRead {
  return {
    kind: "medication",
    product: f(null, 0),
    ingredient: f(null, 0),
    strength: f(null, 0),
    dosing: f(null, 0),
    expiry: f("2027-08", 0.94),
    allergens: f<string[]>(null, 0),
    barcode: f(null, 0),
    readability: 0.93,
    ...partial,
  };
}

test("LABEL_SCHEMA recursively strips $ref, $defs, and $comment while aligning with shared/label_schema.json", () => {
  const raw = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));
  assert.equal(typeof raw.$comment, "string");
  assert.equal(typeof raw.$defs?.stringField, "object");
  assert.equal(raw.properties.product.$ref, "#/$defs/stringField");

  const inlinedKeys = collectKeys(LABEL_SCHEMA);
  assert.equal(inlinedKeys.has("$ref"), false);
  assert.equal(inlinedKeys.has("$defs"), false);
  assert.equal(inlinedKeys.has("$comment"), false);

  const expectedRequired = [
    "kind",
    "product",
    "ingredient",
    "strength",
    "dosing",
    "expiry",
    "allergens",
    "barcode",
    "readability",
  ];
  assert.equal(LABEL_SCHEMA.type, "object");
  assert.equal(LABEL_SCHEMA.required.length, 9);
  assert.deepEqual(LABEL_SCHEMA.required, expectedRequired);
  assert.deepEqual(LABEL_SCHEMA.required, raw.required);
  assert.deepEqual(Object.keys(LABEL_SCHEMA.properties), [...expectedRequired, "guidance"]);
  assert.deepEqual(Object.keys(LABEL_SCHEMA.properties), Object.keys(raw.properties));
  assert.equal(LABEL_SCHEMA.required.includes("guidance"), false);
  assert.deepEqual(LABEL_SCHEMA.properties.guidance, { type: "string" });
  assert.deepEqual(LABEL_SCHEMA.properties.kind, {
    type: "string",
    enum: ["medication", "food", "other", "unreadable"],
  });
});

test("LABEL_SCHEMA enforces [0, 1] bounds on readability and every field confidence", () => {
  const raw = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));
  assert.deepEqual(LABEL_SCHEMA.properties.readability, {
    type: "number",
    minimum: 0,
    maximum: 1,
  });

  const stringFields = ["product", "ingredient", "strength", "dosing", "expiry", "barcode"] as const;
  for (const key of stringFields) {
    const prop = LABEL_SCHEMA.properties[key];
    assert.deepEqual(prop, raw.$defs.stringField);
    assert.deepEqual(prop, {
      type: "object",
      properties: {
        value: { type: ["string", "null"] },
        confidence: { type: "number", minimum: 0, maximum: 1 },
      },
      required: ["value", "confidence"],
    });
  }
  assert.notEqual(LABEL_SCHEMA.properties.product, LABEL_SCHEMA.properties.strength);

  assert.deepEqual(LABEL_SCHEMA.properties.allergens, raw.properties.allergens);
  assert.deepEqual(LABEL_SCHEMA.properties.allergens, {
    type: "object",
    properties: {
      value: { type: ["array", "null"], items: { type: "string" } },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
    required: ["value", "confidence"],
  });
});

test("VERIFY_PROMPT matches shared/verify_prompt.md and enforces core clinical and privacy rules", () => {
  const rawPrompt = fs.readFileSync(PROMPT_PATH, "utf8");
  assert.equal(VERIFY_PROMPT, rawPrompt);

  assert.match(VERIFY_PROMPT, /set `value` to null and `confidence` to 0\.3 or less/);
  assert.match(VERIFY_PROMPT, /Never complete a word you can't fully read/);
  assert.match(VERIFY_PROMPT, /the field is null with confidence 0\.3 or less/);
  assert.match(VERIFY_PROMPT, /Never infer the strength from the product or brand name\./);
  assert.match(VERIFY_PROMPT, /set strength to null with confidence 0\.3 or less/);
  assert.match(VERIFY_PROMPT, /Confidence is per field, 0 to 1/);
  assert.match(VERIFY_PROMPT, /0\.95\+/);
  assert.match(VERIFY_PROMPT, /0\.8 = legible/);
  assert.match(VERIFY_PROMPT, /0\.5 = partly legible/);
  assert.match(VERIFY_PROMPT, /0\.3 or less = guess/);
  assert.match(VERIFY_PROMPT, /Ignore people, faces, hands and the background\. Never describe a person\./);
  assert.match(VERIFY_PROMPT, /normalised to ISO: "YYYY-MM-DD" if the day is printed, otherwise "YYYY-MM"/);
  assert.ok(VERIFY_PROMPT.includes('prefix with "may contain: "'));
  assert.ok(VERIFY_PROMPT.includes('"may contain: almond"'));

  const guidanceLine = VERIFY_PROMPT.split("\n").find((line) => line.startsWith("- `guidance`:"));
  assert.ok(guidanceLine);
  assert.match(guidanceLine, /ONE short physical instruction, max 10 words/);
  assert.match(guidanceLine, /Do not mention the camera or the frames\./);

  const examples = [...guidanceLine.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(examples.length >= 5);
  for (const ex of examples) {
    const wordCount = ex.trim().split(/\s+/).length;
    assert.ok(wordCount <= 10, `guidance example exceeds 10 words: ${ex}`);
    assert.equal(/\b(camera|frames?)\b/i.test(ex), false, `guidance example mentions camera/frames: ${ex}`);
  }

  for (const fieldName of Object.keys(LABEL_SCHEMA.properties)) {
    assert.ok(VERIFY_PROMPT.includes(`- \`${fieldName}\`:`), `VERIFY_PROMPT missing field bullet for ${fieldName}`);
  }
});

test("TOOLS in live.ts declares verify_label, non-blocking show_cue with all 8 CoachCue values, and log_dose", () => {
  assert.ok(TOOLS.length >= 3);

  const verifyTool = TOOLS.find((t) => t.name === "verify_label");
  assert.ok(verifyTool);
  assert.equal(verifyTool.behavior, undefined);
  assert.equal(verifyTool.parameters?.type, Type.OBJECT);
  assert.equal(verifyTool.parameters?.properties?.question?.type, Type.STRING);

  const expectedCues: CoachCue[] = [
    "rotate_left",
    "rotate_right",
    "closer",
    "farther",
    "more_light",
    "hold_still",
    "other_side",
    "ok",
  ];
  const showCueTool = TOOLS.find((t) => t.name === "show_cue");
  assert.ok(showCueTool);
  assert.equal(showCueTool.behavior, Behavior.NON_BLOCKING);
  assert.equal(showCueTool.parameters?.type, Type.OBJECT);
  assert.deepEqual(showCueTool.parameters?.required, ["cue", "text"]);
  assert.equal(showCueTool.parameters?.properties?.cue?.type, Type.STRING);
  assert.deepEqual(showCueTool.parameters?.properties?.cue?.enum, expectedCues);
  assert.equal(showCueTool.parameters?.properties?.text?.type, Type.STRING);

  const logDoseTool = TOOLS.find((t) => t.name === "log_dose");
  assert.ok(logDoseTool);
  assert.equal(logDoseTool.parameters?.type, Type.OBJECT);
  assert.deepEqual(logDoseTool.parameters?.required, ["medId"]);
  assert.equal(logDoseTool.parameters?.properties?.medId?.type, Type.STRING);
});

test("amlodipine.jpg parses valid dimensions via jpegSize() and sharpness in (0, 1] via jpegSharpness()", () => {
  const buf = fs.readFileSync(FIXTURE_PATH);
  assert.ok(buf.length > 100);
  assert.equal(buf[0], 0xff);
  assert.equal(buf[1], 0xd8);

  const size = jpegSize(buf);
  assert.ok(size);
  assert.equal(Number.isInteger(size.w) && size.w > 0, true);
  assert.equal(Number.isInteger(size.h) && size.h > 0, true);

  const sharp = jpegSharpness(buf);
  assert.equal(Number.isFinite(sharp), true);
  assert.ok(sharp > 0 && sharp <= 1);
  assert.equal(jpegSize(Buffer.from([0x89, 0x50, 0x4e, 0x47])), undefined);
});

test("amlodipine.jpg flows through POST /ingest/frame -> hub.ring -> POST /api/verify with stubbed Gemini config", async () => {
  const buf = fs.readFileSync(FIXTURE_PATH);
  const expectedBase64 = buf.toString("base64");
  const expectedSharpness = jpegSharpness(buf);

  const sessionId = `fixture-flow-${process.pid}-${Date.now()}`;
  const hub = getOrCreateHub(sessionId);
  hub.dropFrames();
  hub.source = "phone";
  hub.profile = {
    meds: [{ id: "aml", name: "Norvasc", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"] }],
    allergies: ["peanut"],
    avoid: ["NSAIDs"],
    doseLog: [],
    lang: "en",
  };

  const prevLedgerPath = env.ledgerPath;
  const tmpLedger = path.join(os.tmpdir(), `holdup-schema-fixture-${process.pid}-${Date.now()}.jsonl`);
  env.ledgerPath = tmpLedger;

  const modelsObj = ai.models as unknown as { generateContent: (arg: any) => Promise<any> };
  const origGenerateContent = modelsObj.generateContent;
  const capturedCalls: any[] = [];

  const server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;

  try {
    modelsObj.generateContent = async (params: any) => {
      capturedCalls.push(params);
      return {
        text: JSON.stringify({
          kind: "medication",
          product: { value: "Amlodipin Orion", confidence: 0.97 },
          ingredient: { value: "amlodipine", confidence: 0.98 },
          strength: { value: "5 mg", confidence: 0.96 },
          dosing: { value: "1 tablet once daily", confidence: 0.91 },
          expiry: { value: "2027-08", confidence: 0.94 },
          allergens: { value: [], confidence: 0.89 },
          barcode: { value: "6432100012345", confidence: 0.93 },
          readability: 0.95,
        }),
        usageMetadata: { promptTokenCount: 280, candidatesTokenCount: 92, thoughtsTokenCount: 10 },
      };
    };

    const droppedIngest = await httpPost(
      port,
      `/ingest/frame?session=${encodeURIComponent(sessionId)}`,
      buf,
      { "content-type": "image/jpeg" },
    );
    assert.equal(droppedIngest.status, 204);
    assert.equal(hub.ring.length, 0);

    hub.source = "glasses";

    const ingestRes = await httpPost(
      port,
      `/ingest/frame?session=${encodeURIComponent(sessionId)}`,
      buf,
      { "content-type": "image/jpeg" },
    );
    assert.equal(ingestRes.status, 204);
    assert.equal(hub.ring.length, 1);

    const ringPicked = hub.ring.pick(2);
    assert.equal(ringPicked.length, 1);
    assert.equal(ringPicked[0].source, "glasses");
    assert.equal(ringPicked[0].bytes, buf.length);
    assert.equal(ringPicked[0].sharpness, expectedSharpness);
    assert.equal(ringPicked[0].data, expectedBase64);

    const verifyRes = await httpPost(
      port,
      "/api/verify",
      JSON.stringify({ session: sessionId, question: "Is this my evening pill?" }),
      { "content-type": "application/json" },
    );
    assert.equal(verifyRes.status, 200);
    assert.equal(capturedCalls.length, 1);

    const call = capturedCalls[0];
    assert.equal(call.config.systemInstruction, VERIFY_PROMPT);
    assert.equal(call.config.responseMimeType, "application/json");
    assert.equal(call.config.responseJsonSchema, LABEL_SCHEMA);
    assert.deepEqual(call.config.responseJsonSchema, LABEL_SCHEMA);

    const parts = call.contents[0].parts as any[];
    assert.equal(parts.length, 2);
    assert.deepEqual(parts[0], { inlineData: { mimeType: "image/jpeg", data: expectedBase64 } });
    assert.match(String(parts[1].text), /Is this my evening pill\?/);

    const verdict = JSON.parse(verifyRes.body) as Verdict;
    assert.equal(verdict.level, "match");
    assert.equal(verdict.matchedMedId, "aml");
    assert.equal(verdict.takenToday, false);
    assert.equal(verdict.read.ingredient.value, "amlodipine");
    assert.equal(verdict.read.strength.value, "5 mg");
  } finally {
    modelsObj.generateContent = origGenerateContent;
    env.ledgerPath = prevLedgerPath;
    hub.dropFrames();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try { fs.unlinkSync(tmpLedger); } catch {}
  }
});

test("eval/safety_bridge.mts maintains 100% batch parity with checkLabel() across 29 diverse clinical cases", () => {
  const baseProfile: Profile = {
    meds: [
      { id: "aml", name: "Norvasc", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"] },
      { id: "hydral", name: "Apresoline", ingredient: "hydralazine", strength: "25 mg", schedule: ["morning"] },
      { id: "lamo", name: "Lamictal", ingredient: "lamotrigine", strength: "100 mg", schedule: ["morning"] },
      { id: "met", name: "Glucophage", ingredient: "metformin", strength: "500 mg", schedule: ["08:00", "20:00"] },
      { id: "levo", name: "Thyroxin", ingredient: "levothyroxine", strength: "100 mcg", schedule: ["morning"] },
      { id: "vitd", name: "Devisol", ingredient: "cholecalciferol", strength: "1000 IU", schedule: ["morning"] },
      { id: "warf", name: "Marevan", ingredient: "warfarin", strength: "3 mg", schedule: ["evening"] },
      { id: "amoxclav", name: "Bioclavid", ingredient: "amoxicillin, clavulanic acid", strength: "875 mg + 125 mg", schedule: ["08:00", "20:00"] },
      { id: "para_susp", name: "Panadol Mixt", ingredient: "paracetamol", strength: "500 mg/5 ml", schedule: ["morning"] },
    ],
    allergies: ["nut allergy", "tree nuts"],
    avoid: ["tulehduskipulaake"],
    doseLog: [],
    lang: "fi",
  };

  const lactoseProfile: Profile = { ...baseProfile, allergies: ["lactose"] };
  const localCheckNow = new Date(2026, 10, 14, 18, 0, 0);
  const dose1Ts = new Date(2026, 10, 14, 8, 15, 0).getTime();
  const dose2Ts = new Date(2026, 10, 14, 13, 30, 0).getTime();
  const oneDoseProfile: Profile = { ...baseProfile, doseLog: [{ medId: "met", ts: dose1Ts }] };
  const twoDoseProfile: Profile = { ...baseProfile, doseLog: [{ medId: "met", ts: dose1Ts }, { medId: "met", ts: dose2Ts }] };

  const cases: { name: string; read: LabelRead; profile: Profile; now?: string; expectedLevel: VerdictLevel }[] = [
    {
      name: "lasa_hydralazine_vs_hydroxyzine",
      read: mkRead({ product: f("Atarax"), ingredient: f("hydroxyzine"), strength: f("25 mg") }),
      profile: baseProfile,
      now: "2026-11-14T12:00:00+02:00",
      expectedLevel: "warning",
    },
    {
      name: "lasa_lamotrigine_vs_lamivudine",
      read: mkRead({ product: f("Epivir"), ingredient: f("lamivudine"), strength: f("100 mg") }),
      profile: baseProfile,
      now: "2026-11-14T12:00:00+02:00",
      expectedLevel: "warning",
    },
    {
      name: "lasa_metformin_vs_metronidazole",
      read: mkRead({ product: f("Trikozol"), ingredient: f("metronidazole"), strength: f("500 mg") }),
      profile: baseProfile,
      now: "2026-11-14T12:00:00+02:00",
      expectedLevel: "warning",
    },
    {
      name: "lasa_amlodipine_vs_amiloride",
      read: mkRead({ product: f("Amiloride"), ingredient: f("amiloride"), strength: f("5 mg") }),
      profile: baseProfile,
      now: "2026-11-14T12:00:00+02:00",
      expectedLevel: "warning",
    },
    {
      name: "1000x_mcg_vs_mg_levothyroxine",
      read: mkRead({ product: f("Thyroxin"), ingredient: f("levothyroxine"), strength: f("100 mg") }),
      profile: baseProfile,
      now: "2026-11-14T12:00:00+02:00",
      expectedLevel: "warning",
    },
    {
      name: "nordic_comma_decimal_0_1mg_equals_100mcg",
      read: mkRead({ product: f("Thyroxin"), ingredient: f("levothyroxine"), strength: f("0,1 mg") }),
      profile: baseProfile,
      now: "2026-11-14T12:00:00+02:00",
      expectedLevel: "match",
    },
    {
      name: "10x_decimal_amlodipine_0_5mg_vs_5mg",
      read: mkRead({ product: f("Norvasc"), ingredient: f("amlodipine"), strength: f("0.5 mg") }),
      profile: baseProfile,
      now: "2026-11-14T12:00:00+02:00",
      expectedLevel: "warning",
    },
    {
      name: "nordic_mikrog_and_finnish_inn_levotyroksiini",
      read: mkRead({ product: f("Thyroxin 100 mikrog"), ingredient: f("levotyroksiini"), strength: f("100 mikrog") }),
      profile: baseProfile,
      now: "2026-11-14T12:00:00+02:00",
      expectedLevel: "match",
    },
    {
      name: "nordic_ky_unit_vitamin_d",
      read: mkRead({ product: f("Devisol"), ingredient: f("colecalciferol"), strength: f("1000 KY") }),
      profile: baseProfile,
      now: "2026-11-14T12:00:00+02:00",
      expectedLevel: "match",
    },
    {
      name: "nordic_brand_burana_finnish_nsaid_avoid",
      read: mkRead({ product: f("Burana 400 mg"), ingredient: f("ibuprofeeni"), strength: f("400 mg") }),
      profile: baseProfile,
      now: "2026-11-14T12:00:00+02:00",
      expectedLevel: "warning",
    },
    {
      name: "nordic_brand_primaspan_finnish_asa_avoid",
      read: mkRead({ product: f("Primaspan 100 mg"), ingredient: f("asetyylisalisyylihappo"), strength: f("100 mg") }),
      profile: baseProfile,
      now: "2026-11-14T12:00:00+02:00",
      expectedLevel: "warning",
    },
    {
      name: "nordic_brand_marevan_finnish_varfariini",
      read: mkRead({ product: f("Marevan 3 mg"), ingredient: f("varfariini"), strength: f("3 mg") }),
      profile: baseProfile,
      now: "2026-11-14T12:00:00+02:00",
      expectedLevel: "match",
    },
    {
      name: "combo_strength_amoxclav_match",
      read: mkRead({ product: f("Bioclavid"), ingredient: f("amoxicillin, clavulanic acid"), strength: f("875 mg + 125 mg") }),
      profile: baseProfile,
      now: "2026-11-14T12:00:00+02:00",
      expectedLevel: "match",
    },
    {
      name: "combo_strength_amoxclav_wrong_primary_dose",
      read: mkRead({ product: f("Bioclavid"), ingredient: f("amoxicillin, clavulanic acid"), strength: f("500 mg + 125 mg") }),
      profile: baseProfile,
      now: "2026-11-14T12:00:00+02:00",
      expectedLevel: "warning",
    },
    {
      name: "liquid_concentration_paracetamol_500mg_per_5ml",
      read: mkRead({ product: f("Panadol Mixt"), ingredient: f("paracetamol"), strength: f("500 mg/5 ml") }),
      profile: baseProfile,
      now: "2026-11-14T12:00:00+02:00",
      expectedLevel: "match",
    },
    {
      name: "food_allergen_finnish_maapahkina_vs_nut_allergy",
      read: mkRead({ kind: "food", product: f("Välipalapatukka"), allergens: f(["kaura", "maapähkinä"]) }),
      profile: baseProfile,
      now: "2026-11-14T12:00:00+02:00",
      expectedLevel: "warning",
    },
    {
      name: "food_may_contain_almond_vs_tree_nuts",
      read: mkRead({ kind: "food", product: f("Kaurakeksi"), allergens: f(["oats", "may contain: almond"]) }),
      profile: baseProfile,
      now: "2026-11-14T12:00:00+02:00",
      expectedLevel: "warning",
    },
    {
      name: "med_excipient_lactose_warning",
      read: mkRead({ product: f("Amlodipin Orion"), ingredient: f("amlodipine"), strength: f("5 mg"), allergens: f(["lactose"]) }),
      profile: lactoseProfile,
      now: "2026-11-14T12:00:00+02:00",
      expectedLevel: "warning",
    },
    {
      name: "food_clear_allergen_panel_safe_info",
      read: mkRead({ kind: "food", product: f("Oatly Oat Drink Barista"), allergens: f(["oats", "gluten"]), expiry: f("2027-03-10") }),
      profile: baseProfile,
      now: "2026-11-14T12:00:00+02:00",
      expectedLevel: "info",
    },
    {
      name: "boundary_expiry_current_month_valid",
      read: mkRead({ ingredient: f("amlodipine"), strength: f("5 mg"), expiry: f("2026-11") }),
      profile: baseProfile,
      now: "2026-11-15T12:00:00Z",
      expectedLevel: "match",
    },
    {
      name: "boundary_expiry_previous_month_expired_default_now",
      read: mkRead({ ingredient: f("amlodipine"), strength: f("5 mg"), expiry: f("2026-10") }),
      profile: baseProfile,
      expectedLevel: "warning",
    },
    {
      name: "boundary_expiry_next_day_valid",
      read: mkRead({ ingredient: f("amlodipine"), strength: f("5 mg"), expiry: f("2026-11-16") }),
      profile: baseProfile,
      now: "2026-11-15T12:00:00Z",
      expectedLevel: "match",
    },
    {
      name: "boundary_expiry_prior_day_expired",
      read: mkRead({ ingredient: f("amlodipine"), strength: f("5 mg"), expiry: f("2026-11-13") }),
      profile: baseProfile,
      now: "2026-11-15T12:00:00Z",
      expectedLevel: "warning",
    },
    {
      name: "multi_dose_schedule_1_of_2_taken_match",
      read: mkRead({ ingredient: f("metformin"), strength: f("500 mg") }),
      profile: oneDoseProfile,
      now: localCheckNow.toISOString(),
      expectedLevel: "match",
    },
    {
      name: "multi_dose_schedule_2_of_2_taken_warning",
      read: mkRead({ ingredient: f("metformin"), strength: f("500 mg") }),
      profile: twoDoseProfile,
      now: localCheckNow.toISOString(),
      expectedLevel: "warning",
    },
    {
      name: "low_confidence_strength_0_79_abstains",
      read: mkRead({ ingredient: f("amlodipine", 0.96), strength: f("5 mg", 0.79) }),
      profile: baseProfile,
      now: "2026-11-14T12:00:00+02:00",
      expectedLevel: "unsure",
    },
    {
      name: "low_confidence_name_0_75_abstains",
      read: mkRead({ ingredient: f("amlodipine", 0.75), strength: f("5 mg", 0.95) }),
      profile: baseProfile,
      now: "2026-11-14T12:00:00+02:00",
      expectedLevel: "unsure",
    },
    {
      name: "low_confidence_food_allergens_null_abstains",
      read: mkRead({ kind: "food", product: f("Suklaakeksi", 0.93), allergens: f<string[]>(null, 0.2) }),
      profile: baseProfile,
      now: "2026-11-14T12:00:00+02:00",
      expectedLevel: "unsure",
    },
    {
      name: "unreadable_label_abstains",
      read: mkRead({ kind: "unreadable", readability: 0.12, guidance: "Move it closer to your face." }),
      profile: baseProfile,
      now: "2026-11-14T12:00:00+02:00",
      expectedLevel: "unsure",
    },
  ];

  assert.equal(cases.length, 29);

  const jsonl = cases
    .map((c, idx) => {
      const payload = c.now ? { read: c.read, profile: c.profile, now: c.now } : { read: c.read, profile: c.profile };
      return idx % 5 === 0 ? `${JSON.stringify(payload)}\n` : JSON.stringify(payload);
    })
    .join("\n") + "\n";

  const res = spawnSync(process.execPath, ["--import", "tsx", BRIDGE_PATH], {
    input: jsonl,
    env: { ...process.env, TMPDIR: os.tmpdir(), HOLDUP_SAFETY_TS: SAFETY_TS_PATH },
    encoding: "utf8",
  });
  assert.equal(res.status, 0, res.stderr);

  const rows = res.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(rows.length, cases.length);

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const evalDate = c.now ? new Date(c.now) : new Date("2026-11-14T12:00:00+02:00");
    const direct = checkLabel(c.read, c.profile, evalDate);
    const expected = {
      level: direct.level,
      reasons: direct.reasons,
      matchedMedId: direct.matchedMedId ?? null,
    };
    assert.deepEqual(rows[i], expected, `bridge mismatch on case ${c.name}`);
    assert.equal(rows[i].level, c.expectedLevel, `unexpected clinical level on case ${c.name}`);
  }
});

test("eval/safety_bridge.mts emits error verdict for invalid read object without aborting subsequent lines", () => {
  const profile: Profile = {
    meds: [{ id: "aml", name: "Norvasc", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"] }],
    allergies: ["peanut"],
    avoid: ["NSAIDs"],
    doseLog: [],
    lang: "en",
  };
  const now = "2026-11-14T20:00:00+02:00";

  const lines = [
    JSON.stringify({ read: mkRead({ ingredient: f("amlodipine"), strength: f("5 mg") }), profile, now }),
    JSON.stringify({ read: {}, profile, now }),
    JSON.stringify({ read: null, profile, now }),
    JSON.stringify({ read: mkRead({ product: f("Burana 400 mg"), ingredient: f("ibuprofen"), strength: f("400 mg") }), profile, now }),
  ].join("\n") + "\n";

  const res = spawnSync(process.execPath, ["--import", "tsx", BRIDGE_PATH], {
    input: lines,
    env: { ...process.env, TMPDIR: os.tmpdir(), HOLDUP_SAFETY_TS: SAFETY_TS_PATH },
    encoding: "utf8",
  });
  assert.equal(res.status, 0, res.stderr);

  const rows = res.stdout.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.length, 4);
  assert.equal(rows[0].level, "match");
  assert.equal(rows[0].matchedMedId, "aml");

  assert.equal(rows[1].level, "error");
  assert.equal(rows[1].matchedMedId, null);
  assert.equal(Array.isArray(rows[1].reasons) && rows[1].reasons.length === 1, true);

  assert.equal(rows[2].level, "error");
  assert.equal(rows[2].matchedMedId, null);
  assert.equal(Array.isArray(rows[2].reasons) && rows[2].reasons.length === 1, true);

  assert.equal(rows[3].level, "warning");
  assert.equal(rows[3].matchedMedId, null);
  assert.ok(rows[3].reasons.some((r: string) => r.includes("NSAID")));

  const envWithoutPath: NodeJS.ProcessEnv = { ...process.env, TMPDIR: os.tmpdir() };
  delete envWithoutPath.HOLDUP_SAFETY_TS;
  const missingEnvRes = spawnSync(process.execPath, ["--import", "tsx", BRIDGE_PATH], {
    input: "",
    env: envWithoutPath,
    encoding: "utf8",
  });
  assert.equal(missingEnvRes.status, 2);
});
