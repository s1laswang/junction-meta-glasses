import fs from "node:fs";
import path from "node:path";
import { ThinkingLevel } from "@google/genai";
import type { Field, LabelRead, Profile, Verdict } from "../../shared/types.ts";
import { env, REPO_ROOT } from "./env.ts";
import { ai, backoffMs, classify, sleep, unaryGate } from "./gemini.ts";
import { ledger, usage } from "./ledger.ts";
import { errSummary, log } from "./log.ts";
import { parseJpegHeader, rankBase64Frames, scoreFrameOpticalQuality, type FrameOpticalQuality, type JpegHeaderInfo } from "./frameRanker.ts";
import { checkLabel } from "./safety.ts";

export { parseJpegHeader, rankBase64Frames, scoreFrameOpticalQuality, type FrameOpticalQuality, type JpegHeaderInfo };

export const VERIFY_PROMPT = fs.readFileSync(path.join(REPO_ROOT, "shared", "verify_prompt.md"), "utf8");
const RAW_SCHEMA = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "shared", "label_schema.json"), "utf8"));
function inlineRefs(s: any, defs = s.$defs ?? {}): any {
  if (Array.isArray(s)) return s.map((x) => inlineRefs(x, defs));
  if (s && typeof s === "object") {
    if (typeof s.$ref === "string") return inlineRefs(defs[s.$ref.split("/").pop()!], defs);
    const o: any = {};
    for (const [k, v] of Object.entries(s)) if (k !== "$defs" && k !== "$comment") o[k] = inlineRefs(v, defs);
    return o;
  }
  return s;
}
export const LABEL_SCHEMA = inlineRefs(RAW_SCHEMA);

export type Frame = { data: string; sharpness: number; ts: number; bytes: number; source: "phone" | "glasses" };
export class FrameRing {
  private frames: Frame[] = [];
  constructor(private size = 8) {}
  push(f: Frame) { this.frames.push(f); if (this.frames.length > this.size) this.frames.shift(); }
  clear() { this.frames = []; }
  get length() { return this.frames.length; }
  get lastTs() { return this.frames.at(-1)?.ts ?? 0; }
  pick(n = 2, windowMs = 5000, now = Date.now()): Frame[] {
    if (!this.frames.length) return [];
    let recent = this.frames.filter((f) => now - f.ts <= windowMs);
    if (recent.length < Math.min(3, this.frames.length)) recent = this.frames.slice(-3);
    return [...recent].sort((a, b) => b.sharpness - a.sharpness || b.ts - a.ts).slice(0, n);
  }
}

export function jpegSharpness(buf: Buffer): number {
  const dim = jpegSize(buf);
  const px = dim ? dim.w * dim.h : 768 * 768;
  return Math.max(0, Math.min(1, buf.length / px / 0.35));
}
export function jpegSize(buf: Buffer): { w: number; h: number } | undefined {
  const hdr = parseJpegHeader(buf);
  return hdr ? { w: hdr.w, h: hdr.h } : undefined;
}

const clamp01 = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);
function field<T>(x: any, isT: (v: unknown) => v is T): Field<T> {
  const value = x && isT(x.value) ? x.value : null;
  const conf = clamp01(x?.confidence);
  return { value, confidence: value === null ? Math.min(conf, 0.3) : conf };
}
const isStr = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");

export function unreadable(guidance = "Hold it up in front of you and keep it still."): LabelRead {
  const nf = { value: null, confidence: 0 };
  return { kind: "unreadable", product: nf, ingredient: nf, strength: nf, dosing: nf, expiry: nf, allergens: nf, barcode: nf, readability: 0, guidance };
}

export function toLabelRead(j: any): LabelRead {
  if (!j || typeof j !== "object") return unreadable();
  const kinds = ["medication", "food", "other", "unreadable"] as const;
  const read: LabelRead = {
    kind: kinds.includes(j.kind) ? j.kind : "unreadable",
    product: field(j.product, isStr), ingredient: field(j.ingredient, isStr), strength: field(j.strength, isStr),
    dosing: field(j.dosing, isStr), expiry: field(j.expiry, isStr), allergens: field(j.allergens, isStrArr),
    barcode: field(j.barcode, isStr), readability: clamp01(j.readability),
  };
  if (read.strength.value) read.strength.value = read.strength.value.replace(/(\d),(?=\d)/g, "$1.").replace(/\s+/g, " ").trim();
  if (isStr(j.guidance)) read.guidance = j.guidance.trim().slice(0, 120);
  if (read.expiry.value && !/^\d{4}-\d{2}(-\d{2})?$/.test(read.expiry.value)) read.expiry.confidence = Math.min(read.expiry.confidence, 0.5);
  return read;
}

export type ReadOpts = {
  generateFn?: (model: string, parts: any[], signal: AbortSignal) => Promise<{ text?: string; usageMetadata?: any }>;
  chain?: string[];
  sleepFn?: (ms: number) => Promise<unknown>;
  timeoutMs?: number;
};
export type ReadResult = { read: LabelRead; model: string | null; latencyMs: number; attempts: number };

export async function readLabel(frames: string[], question?: string, feature = "verify", opts?: ReadOpts): Promise<ReadResult> {
  const t0 = Date.now();
  if (!frames.length) return { read: unreadable(), model: null, latencyMs: 0, attempts: 0 };
  const parts: any[] = frames.map((data) => ({ inlineData: { mimeType: "image/jpeg", data } }));
  parts.push({ text: question?.trim() ? `The person asked: "${question.trim().slice(0, 300)}"` : "Read this label." });

  const chain = opts?.chain ?? env.verifyModels;
  const sleepFn = opts?.sleepFn ?? sleep;
  const timeoutMs = opts?.timeoutMs ?? env.verifyTimeoutMs;
  const generateFn = opts?.generateFn ?? ((model: string, p: any[], signal: AbortSignal) => ai.models.generateContent({
    model,
    contents: [{ role: "user", parts: p }],
    config: {
      systemInstruction: VERIFY_PROMPT,
      responseMimeType: "application/json",
      responseJsonSchema: LABEL_SCHEMA,
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      maxOutputTokens: 4096,
      abortSignal: signal,
    },
  }));
  let attempts = 0, mi = 0, retried = false;
  while (mi < chain.length && attempts < 4) {
    const model = chain[mi];
    attempts++;
    const ta = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await unaryGate.run(() => generateFn(model, parts, ctrl.signal));
      const text = res.text;
      if (!text?.trim()) throw new Error("empty reply");
      const read = toLabelRead(JSON.parse(text));
      ledger({ feature, model, ...usage(res.usageMetadata), latency_s: (Date.now() - ta) / 1000, ok: true, n_frames: frames.length });
      return { read, model, latencyMs: Date.now() - t0, attempts };
    } catch (e) {
      const kind = e instanceof SyntaxError ? "bad_json" : classify(e);
      ledger({ feature, model, latency_s: (Date.now() - ta) / 1000, ok: false, error: kind });
      log("verify.attempt_failed", { model, kind, err: errSummary(e) });
      if (kind === "quota") await sleepFn(backoffMs(attempts));
      if (!retried && mi === 0 && (kind === "timeout" || kind === "empty" || kind === "server" || kind === "network" || kind === "bad_json")) retried = true;
      else mi++;
    } finally { clearTimeout(timer); }
  }
  return { read: unreadable("I couldn't reach the reader. Try again in a moment."), model: null, latencyMs: Date.now() - t0, attempts };
}

export type VerifyResult = { verdict: Verdict; model: string | null; latencyMs: number; frames: number };
export async function verify(frames: string[], profile: Profile, question?: string, feature = "verify", opts?: ReadOpts): Promise<VerifyResult> {
  const r = await readLabel(frames.slice(0, 3), question, feature, opts);
  const verdict = checkLabel(r.read, profile);
  if (!r.model) { verdict.level = "unsure"; verdict.reasons.push("reader unavailable"); }
  return { verdict, model: r.model, latencyMs: r.latencyMs, frames: Math.min(3, frames.length) };
}

export function emptyProfile(): Profile {
  return { meds: [], allergies: [], avoid: [], doseLog: [], lang: "en" };
}
export function toProfile(p: any): Profile {
  const s = (x: unknown, max = 120) => (typeof x === "string" ? x.slice(0, max) : "");
  const arr = (x: unknown) => (Array.isArray(x) ? x : []);
  return {
    meds: arr(p?.meds).slice(0, 50).map((m: any, i: number) => ({
      id: s(m?.id, 64) || `med${i}`, name: s(m?.name), ingredient: s(m?.ingredient), strength: s(m?.strength, 40),
      schedule: arr(m?.schedule).map((x) => s(x, 40)).filter(Boolean).slice(0, 8),
      ...(m?.barcode ? { barcode: s(m.barcode, 32) } : {}), ...(m?.notes ? { notes: s(m.notes, 200) } : {}),
    })),
    allergies: arr(p?.allergies).map((x) => s(x, 60)).filter(Boolean).slice(0, 30),
    avoid: arr(p?.avoid).map((x) => s(x, 60)).filter(Boolean).slice(0, 30),
    doseLog: arr(p?.doseLog).filter((d: any) => typeof d?.ts === "number" && Number.isFinite(d.ts)).map((d: any) => ({ medId: s(d.medId, 64), ts: d.ts })).slice(-500),
    lang: s(p?.lang, 16) || "en",
  };
}
