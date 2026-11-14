// Gemini Live proxy: one LiveProxy per started phone session. Model fallback chain, session resumption on
// goAway/drops, context window compression, barge-in, tool calls (verify_label, show_cue, log_dose), auto-stop.
import fs from "node:fs";
import path from "node:path";
import {
  Behavior, FunctionResponseScheduling, Modality, Type,
  type FunctionCall, type FunctionDeclaration, type LiveServerMessage, type Session,
} from "@google/genai";
import type { CoachCue, LabelRead, Med, ServerMsg, VerdictLevel } from "../../shared/types.ts";
import { env, SERVER_DIR } from "./env.ts";
import { ai, backoffMs } from "./gemini.ts";
import type { Hub, LiveLike, LiveStats, VerifySource } from "./hub.ts";
import { ledger } from "./ledger.ts";
import { errSummary, log, shortId } from "./log.ts";
import { readLabel, toProfile } from "./verify.ts";
import { findItems } from "./find.ts";
import { MATCH_NAME_MIN_CONF, STRENGTH_MIN_CONF, checkLabel, fmtStrength, ingredientsOf, sameStrength, spokenIngredient } from "./safety.ts";

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const BASE_PROMPT = fs.readFileSync(path.join(SERVER_DIR, "src", "prompts", "live.md"), "utf8");
const CUES: CoachCue[] = ["rotate_left", "rotate_right", "closer", "farther", "more_light", "hold_still", "other_side", "ok"];
const LANGS: Record<string, string> = { en: "English", fi: "Finnish", sv: "Swedish", de: "German", es: "Spanish", fr: "French", et: "Estonian", ru: "Russian" };

export const TOOLS: FunctionDeclaration[] = [
  {
    name: "verify_label",
    description: "Read the label of the item the user is holding up, from the sharpest recent camera frames, and check it against the user's own medication list, allergies and avoid-list. Returns a verdict with a `speech` field you must say word for word. Call this for ANY question about a medicine name, strength, dose, expiry or allergens.",
    parameters: { type: Type.OBJECT, properties: { question: { type: Type.STRING, description: "The user's question, e.g. 'is this my evening pill?'" } } },
  },
  {
    name: "show_cue",
    description: "Show a short coaching cue on the user's display while you say it.",
    behavior: Behavior.NON_BLOCKING,
    parameters: {
      type: Type.OBJECT,
      properties: {
        cue: { type: Type.STRING, enum: CUES, description: "Cue code" },
        text: { type: Type.STRING, description: "The cue as you say it, max 6 words" },
      },
      required: ["cue", "text"],
    },
  },
  {
    name: "log_dose",
    description: "Log that the user just took a dose of one of their medicines (use the medId from the last verdict).",
    parameters: { type: Type.OBJECT, properties: { medId: { type: Type.STRING } }, required: ["medId"] },
  },
];

// Flag-gated tools and prompt sections. With every flag off, tools and prompt are exactly the M1 ones.
const FIND_ITEM: FunctionDeclaration = {
  name: "find_item",
  description: "Look at SEVERAL packages in view (on a table, shelf or in a drawer) and say which one is which, checked against the user's own list. Use for 'which one is my evening pill?', 'which box has no nuts?', or when more than one package is in view. Returns a `speech` to say word for word.",
  parameters: { type: Type.OBJECT, properties: { target: { type: Type.STRING, description: "What the user is looking for, e.g. 'my evening pill', 'the one without nuts'. Omit to just describe them." } } },
};
const ADD_MEDICATION: FunctionDeclaration = {
  name: "add_medication",
  description: "Propose adding the medicine the user is holding (just confirmed by verify_label with a clear name and strength) to their medication list, with the times they take it. The phone asks the user to confirm; nothing is saved until they do.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      schedule: { type: Type.ARRAY, items: { type: Type.STRING }, description: "When they take it, e.g. ['morning'], ['evening'], ['08:00','20:00'], ['as needed']" },
      name: { type: Type.STRING, description: "Optional name the user calls it" },
    },
    required: ["schedule"],
  },
};
const promptFile = (f: string) => fs.readFileSync(path.join(SERVER_DIR, "src", "prompts", f), "utf8");
const SCENE_PROMPT = promptFile("live_scene.md");
const ADDMED_PROMPT = promptFile("live_addmed.md");

export function toolsFor(features: Set<string>): FunctionDeclaration[] {
  return [...TOOLS, ...(features.has("scene") ? [FIND_ITEM] : []), ...(features.has("addmed") ? [ADD_MEDICATION] : [])];
}

// Fixed, human-written verdict openers. The safety-critical word (right one / warning / not sure) is never
// produced by model translation. In FI/SV, only the details after the opener are translated by Live.
export const VERDICT_LEAD: Record<string, Record<VerdictLevel, string>> = {
  fi: { match: "Oikea pakkaus.", warning: "Varoitus.", unsure: "En ole varma.", info: "Tieto." },
  sv: { match: "Rätt förpackning.", warning: "Varning.", unsure: "Jag är inte säker.", info: "Information." },
};
export function leadFor(lang: string, level: VerdictLevel): { lead?: string } {
  const l = VERDICT_LEAD[(lang || "en").slice(0, 2)];
  return l ? { lead: l[level] } : {};
}
export function speakInstruction(lang: string, tail: string): string {
  return VERDICT_LEAD[(lang || "en").slice(0, 2)]
    ? `First say \`lead\` exactly as written, then say \`speech\` translated faithfully into the user's language (keep names, numbers and dates exactly), then stop. ${tail}`
    : `Say \`speech\` word for word, then stop. ${tail}`;
}

function systemInstruction(hub: Hub, lang: string): string {
  const p = hub.profile;
  const meds = p.meds.map((m) => `- medId "${m.id}": ${m.name}${m.ingredient && m.ingredient !== m.name ? ` (${m.ingredient})` : ""}, taken ${m.schedule.join(", ") || "as needed"}`).join("\n");
  const extra = (hub.has("scene") ? `\n${SCENE_PROMPT}` : "") + (hub.has("addmed") ? `\n${ADDMED_PROMPT}` : "");
  return `${BASE_PROMPT}${extra}
## This user
- Language: ${LANGS[lang] ?? lang}. Speak ${LANGS[lang] ?? lang}.
- Their medicines (names only; strengths and safety are checked by verify_label):
${meds || "- none saved"}
- Allergies: ${p.allergies.join(", ") || "none saved"}
- Avoid: ${p.avoid.join(", ") || "nothing saved"}`;
}

type Opts = { lang: string; voice: boolean };

export class LiveProxy implements LiveLike {
  private session: Session | null = null;
  private gen = 0; // generation of the current Gemini socket; stale callbacks are ignored
  private modelIdx = 0;
  private model = "";
  private handle?: string;
  private resumable = false;
  private stopped = false;
  private reconnects = 0;
  private openedAt = 0;
  private openGen = -1;
  private connecting = false;
  private idleTimer?: NodeJS.Timeout;
  private lastFrameAt = Date.now();
  private cancelled = new Set<string>();
  // transcripts (cumulative per utterance)
  private userText = ""; private botText = "";
  // metrics
  private t0 = Date.now();
  private lastUserSignal = 0;
  private awaitingFirstAudio = false;
  private firstAudio: number[] = [];
  private toolLat: number[] = [];
  private toolCalls = 0;
  private modelsUsed = new Set<string>();
  private lastVerify: NonNullable<LiveStats["verify"]> | null = null;

  constructor(private hub: Hub, private opts: Opts) {
    const r = hub.resume;
    // a phone that reconnects with the same session id within 10 min resumes the same Gemini context
    if (r && Date.now() - r.at < 10 * 60_000) {
      this.handle = r.handle; this.modelIdx = Math.max(0, env.liveModels.indexOf(r.model));
    }
  }

  get active() { return !this.stopped; }
  private send(msg: ServerMsg) { this.hub.emit(msg); }

  async start() {
    this.idleTimer = setInterval(() => {
      if (!this.stopped && Date.now() - this.lastFrameAt > env.idleStopMs) {
        this.send({ type: "coach", cue: "ok", text: "Camera stopped" });
        this.stop(`auto-stopped: no camera frames for ${Math.round(env.idleStopMs / 1000)} s`);
      }
    }, 2000);
    await this.connect();
  }

  /** Connect (or reconnect) walking the model chain. Uses the resumption handle when we have one. */
  private async connect(): Promise<void> {
    if (this.stopped || this.connecting) return;
    this.connecting = true;
    this.send({ type: "status", live: this.session || this.handle ? "reconnecting" : "connecting", detail: this.handle ? "resuming" : undefined });
    try {
      while (this.modelIdx < env.liveModels.length && !this.stopped) {
        const model = env.liveModels[this.modelIdx];
        const gen = ++this.gen;
        const t = Date.now();
        try {
          const s = await ai.live.connect({
            model,
            config: {
              responseModalities: [Modality.AUDIO],
              systemInstruction: systemInstruction(this.hub, this.opts.lang),
              tools: [{ functionDeclarations: toolsFor(this.hub.features) }],
              inputAudioTranscription: {},
              outputAudioTranscription: {},
              sessionResumption: this.handle ? { handle: this.handle } : {},
              contextWindowCompression: { slidingWindow: {} },
            },
            callbacks: {
              onmessage: (m) => { if (gen === this.gen) this.onMessage(m); },
              onerror: (e) => { if (gen === this.gen) log("live.ws_error", { session: shortId(this.hub.id), err: errSummary((e as any)?.message ?? e) }); },
              // only a socket that finished setup counts as a drop; a failed connect rejects connect() instead
              // (the SDK fires onclose AND rejects in that case, which would otherwise race two reconnects)
              onclose: (e) => { if (gen === this.gen && gen === this.openGen) this.onClose(e.code, String(e.reason ?? "")); },
            },
          });
          if (this.stopped) { this.gen++; s.close(); return; }
          this.session = s; this.openGen = gen; this.model = model; this.modelsUsed.add(model); this.openedAt = Date.now();
          log("live.open", { session: shortId(this.hub.id), model, ms: Date.now() - t, resumed: !!this.handle });
          this.send({ type: "ready", model, session: this.hub.id, features: [...this.hub.features] });
          this.send({ type: "status", live: "open", detail: model });
          return;
        } catch (e) {
          const msg = errSummary(e);
          log("live.connect_failed", { session: shortId(this.hub.id), model, err: msg });
          ledger({ feature: "live_connect", model, latency_s: (Date.now() - t) / 1000, ok: false });
          if (this.handle) { this.handle = undefined; continue; } // stale handle: retry same model fresh
          if (/quota|RESOURCE_EXHAUSTED|429/i.test(msg)) await new Promise((r) => setTimeout(r, backoffMs(1)));
          this.modelIdx++;
        }
      }
      if (!this.stopped) {
        this.send({ type: "status", live: "degraded", detail: "Gemini Live unavailable, use snapshot mode" });
        this.send({ type: "error", code: "gemini_unavailable", message: "Live voice is unavailable right now. Snapshot mode still works.", recoverable: true });
        this.finish("unavailable");
      }
    } finally { this.connecting = false; }
  }

  private onClose(code: number, reason: string) {
    this.session = null;
    if (this.stopped) return;
    log("live.closed_remote", { session: shortId(this.hub.id), code, err: errSummary(reason) });
    if (Date.now() - this.openedAt > 30_000) this.reconnects = 0; // it was healthy for a while
    this.reconnects++;
    if (/quota|RESOURCE_EXHAUSTED|429/i.test(reason)) {
      this.send({ type: "error", code: "quota", message: "Gemini quota reached, trying a backup model.", recoverable: true });
      this.handle = undefined; this.modelIdx++;
    } else if (code === 1007 || code === 1008) {
      this.send({ type: "error", code: "bad_input", message: "Gemini rejected the input, restarting the session.", recoverable: true });
      this.handle = undefined;
    } else if (this.reconnects > 3) {
      this.handle = undefined; this.modelIdx++; // this model keeps dropping: next in chain, fresh context
    } // else: same model, resume with the handle if we have one
    setTimeout(() => void this.connect(), backoffMs(this.reconnects, 300, 4000));
  }

  private onMessage(m: LiveServerMessage) {
    if (m.sessionResumptionUpdate) {
      this.resumable = !!m.sessionResumptionUpdate.resumable;
      if (m.sessionResumptionUpdate.newHandle) {
        this.handle = m.sessionResumptionUpdate.newHandle;
        this.hub.resume = { handle: this.handle, model: this.model, at: Date.now() };
      }
    }
    if (m.goAway) {
      log("live.go_away", { session: shortId(this.hub.id), left: m.goAway.timeLeft ?? "" });
      // reconnect proactively with the resumption handle; context is preserved server-side
      const old = this.session; this.gen++; this.session = null;
      try { old?.close(); } catch { /* */ }
      void this.connect();
      return;
    }
    if (m.toolCall?.functionCalls) for (const fc of m.toolCall.functionCalls) void this.onTool(fc);
    if (m.toolCallCancellation?.ids) for (const id of m.toolCallCancellation.ids) this.cancelled.add(id);

    const sc = m.serverContent;
    if (!sc) return;
    if (sc.inputTranscription?.text) {
      this.userText += sc.inputTranscription.text;
      this.lastUserSignal = Date.now(); this.awaitingFirstAudio = true;
      this.send({ type: "transcript", role: "user", text: this.userText.trim(), final: !!sc.inputTranscription.finished });
      if (sc.inputTranscription.finished) this.userText = "";
    }
    const parts = sc.modelTurn?.parts ?? [];
    for (const p of parts) {
      const d = p.inlineData;
      if (d?.data && d.mimeType?.startsWith("audio/")) {
        if (this.awaitingFirstAudio && this.lastUserSignal) {
          this.firstAudio.push((Date.now() - this.lastUserSignal) / 1000);
          this.awaitingFirstAudio = false;
          this.hub.pushMetrics();
        }
        if (this.opts.voice) this.send({ type: "audio", data: d.data });
      }
    }
    if (sc.outputTranscription?.text) {
      if (this.userText) { this.send({ type: "transcript", role: "user", text: this.userText.trim(), final: true }); this.userText = ""; }
      this.botText += sc.outputTranscription.text;
      this.send({ type: "transcript", role: "assistant", text: this.botText.trim(), final: false });
    }
    if (sc.interrupted) {
      // barge-in: the client must flush its playback queue
      this.send({ type: "interrupted" });
    }
    if (sc.turnComplete || sc.interrupted) {
      if (this.botText) this.send({ type: "transcript", role: "assistant", text: this.botText.trim(), final: true });
      if (this.userText) this.send({ type: "transcript", role: "user", text: this.userText.trim(), final: true });
      this.botText = ""; this.userText = "";
    }
  }

  private respond(fc: FunctionCall, output: Record<string, unknown>, silent = false) {
    if (fc.id && this.cancelled.delete(fc.id)) return;
    try {
      this.session?.sendToolResponse({
        functionResponses: [{ id: fc.id, name: fc.name, response: { output }, ...(silent ? { scheduling: FunctionResponseScheduling.SILENT } : {}) }],
      });
    } catch (e) { log("live.tool_response_failed", { name: fc.name ?? "", err: errSummary(e) }); }
  }

  private async onTool(fc: FunctionCall) {
    const t = Date.now();
    this.toolCalls++;
    const args = (fc.args ?? {}) as Record<string, unknown>;
    log("live.tool", { session: shortId(this.hub.id), name: fc.name ?? "" });
    try {
      if (fc.name === "show_cue") {
        const cue = CUES.includes(args.cue as CoachCue) ? (args.cue as CoachCue) : "hold_still";
        this.send({ type: "coach", cue, text: String(args.text ?? "").slice(0, 60) });
        this.respond(fc, { shown: true }, true);
      } else if (fc.name === "log_dose") {
        const medId = String(args.medId ?? "");
        const r = this.logDose(medId);
        // the dose log lives on the phone: mirror voice-logged doses there
        if (r.ok) this.send({ type: "dose_logged", medId, ts: Date.now() });
        this.respond(fc, r);
      } else if (fc.name === "verify_label") {
        const question = typeof args.question === "string" ? args.question : undefined;
        this.send({ type: "checking", phase: "start" });
        try {
          // 1) speculative cache / in-flight read, 2) otherwise a fresh read of the sharpest recent frames
          const spec = await this.hub.spec.get();
          let read = spec?.read, model = spec?.model ?? null, source: string = spec?.source ?? "fresh";
          if (!read) {
            const frames = this.hub.ring.pick(2);
            if (!frames.length) {
              this.respond(fc, { level: "unsure", speech: "I can't see anything yet. Hold the item up in front of your face." });
              return;
            }
            this.send({ type: "coach", cue: "hold_still", text: "Hold still, reading…" });
            const r = await readLabel(frames.map((f) => f.data), question, "verify_live");
            read = r.read; model = r.model;
          }
          if (fc.id && this.cancelled.has(fc.id)) { this.cancelled.delete(fc.id); return; }
          if (this.stopped) return;
          const v = checkLabel(read, this.hub.profile, new Date(), this.hub.freshCode());
          if (!model) { v.level = "unsure"; v.reasons.push("reader unavailable"); }
          this.send({ type: "verdict", verdict: v });
          this.respond(fc, {
            level: v.level, speech: v.speech, headline: v.headline, matchedMedId: v.matchedMedId ?? null,
            guidance: v.read.guidance ?? null, takenToday: v.takenToday ?? null,
            ...leadFor(this.opts.lang, v.level),
            instruction: speakInstruction(this.opts.lang, "No disclaimer, add nothing."),
          });
          log("live.verify_done", { session: shortId(this.hub.id), level: v.level, model: model ?? "none", source, ms: Date.now() - t, dm: !!v.crossCheck });
          this.lastVerify = { ms: Date.now() - t, source: source as VerifySource, level: v.level, at: Date.now() };
          this.hub.pushMetrics();
          this.lastItemRead = { read, at: Date.now(), gtin: this.hub.freshCode()?.gtin };
        } finally {
          this.send({ type: "checking", phase: "end" });
        }
      } else if (fc.name === "find_item" && this.hub.has("scene")) {
        const target = typeof args.target === "string" ? args.target : undefined;
        const frames = this.hub.ring.pick(2, 4000);
        if (!frames.length) {
          this.respond(fc, { level: "unsure", speech: "I can't see the table yet. Point your head at the items." });
          return;
        }
        this.send({ type: "checking", phase: "start" });
        try {
          const r = await findItems(frames.map((f) => f.data), this.hub.profile, target, "find_live");
          if (fc.id && this.cancelled.has(fc.id)) { this.cancelled.delete(fc.id); return; }
          if (this.stopped) return;
          const v = r.verdict;
          this.send({ type: "verdict", verdict: v });
          this.respond(fc, {
            mode: "scene", level: v.level, speech: v.speech,
            items: (v.items ?? []).map((i) => ({ position: i.position, level: i.level, headline: i.headline })),
            ...leadFor(this.opts.lang, v.level),
            instruction: speakInstruction(this.opts.lang, "If they pick one up, call verify_label."),
          });
          log("live.find_done", { session: shortId(this.hub.id), level: v.level, model: r.model ?? "none", ms: r.latencyMs, n_items: v.items?.length ?? 0 });
          this.lastVerify = { ms: Date.now() - t, source: "scene", level: v.level, at: Date.now() };
          this.hub.pushMetrics();
        } finally {
          this.send({ type: "checking", phase: "end" });
        }
      } else if (fc.name === "add_medication" && this.hub.has("addmed")) {
        this.respond(fc, this.proposeMed(args));
      } else {
        this.respond(fc, { error: `unknown tool ${fc.name}` });
      }
    } catch (e) {
      log("live.tool_failed", { name: fc.name ?? "", err: errSummary(e) });
      this.respond(fc, { level: "unsure", speech: "Sorry, I couldn't check that. Please try again." });
    } finally {
      if (fc.name !== "show_cue") this.toolLat.push((Date.now() - t) / 1000);
    }
  }

  // ---------- hold up to add (flag addmed) ----------
  private lastItemRead?: { read: LabelRead; at: number; gtin?: string };
  private proposals = new Map<string, { med: Med; timer: NodeJS.Timeout }>();

  /** Build a Med from the last confident held-item read + the spoken schedule and ask the phone to confirm. */
  private proposeMed(args: Record<string, unknown>): Record<string, unknown> {
    const lr = this.lastItemRead;
    const read = lr && Date.now() - lr.at < 3 * 60_000 ? lr.read : undefined;
    const nameConf = read ? Math.max(read.ingredient.value ? read.ingredient.confidence : 0, read.product.value ? read.product.confidence : 0) : 0;
    if (!read || read.kind !== "medication" || nameConf < MATCH_NAME_MIN_CONF || !read.strength.value || read.strength.confidence < STRENGTH_MIN_CONF) {
      return { ok: false, reason: "need_clear_read", instruction: "Call verify_label first and coach until the name and strength are read clearly. Do not add anything yet." };
    }
    const schedule = (Array.isArray(args.schedule) ? args.schedule : []).filter((s): s is string => typeof s === "string" && !!s.trim()).map((s) => s.trim().slice(0, 40)).slice(0, 8);
    if (!schedule.length) return { ok: false, reason: "need_schedule", instruction: "Ask the user when they take it, then call add_medication again." };
    const ingredient = read.ingredient.value && read.ingredient.confidence >= MATCH_NAME_MIN_CONF ? spokenIngredient(read.ingredient.value.toLowerCase()) : "";
    const noStrength = (s: string) => s.replace(/\d+(?:[.,]\d+)?\s*(mg|g|mcg|µg|ml|iu)\b.*$/i, "").trim();
    const product = read.product.value && read.product.confidence >= MATCH_NAME_MIN_CONF ? noStrength(read.product.value) : "";
    const name = (typeof args.name === "string" && noStrength(args.name).slice(0, 60)) || product || cap(ingredient);
    const strength = fmtStrength(read.strength.value.replace(/(\d),(\d)/g, "$1.$2"));
    const dup = this.hub.profile.meds.find((m) => (ingredient && ingredientsOf(m.ingredient, m.name).has(ingredient)) && sameStrength(m.strength, strength));
    if (dup) return { ok: false, reason: "already_on_list", speech: `${cap(spokenIngredient(dup.ingredient) || dup.name)} ${dup.strength} is already on your list.` };
    const med: Med = {
      id: `${(ingredient || name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "med"}-${Math.random().toString(36).slice(2, 6)}`,
      name, ingredient: ingredient || name.toLowerCase(), strength, schedule,
      ...(lr?.gtin ? { gtin: lr.gtin } : {}),
    };
    const proposalId = crypto.randomUUID();
    const phrase = (s: string) => /^\d{1,2}[:.]\d{2}$/.test(s) ? `at ${s}` : /^(morning|afternoon|evening)$/i.test(s) ? `in the ${s.toLowerCase()}`
      : /^(night|bedtime|noon|midday)$/i.test(s) ? `at ${s.toLowerCase()}` : s;
    const ws = schedule.map(phrase);
    const when = ws.length === 1 ? ws[0] : `${ws.slice(0, -1).join(", ")} and ${ws.at(-1)}`;
    const speech = `Add ${name} ${strength}, taken ${when}, to your list? Please confirm on your phone.`;
    const timer = setTimeout(() => {
      if (!this.proposals.delete(proposalId) || this.stopped) return;
      this.text(`(No confirmation came from the phone within a minute, so ${name} was not saved. Tell the user in a few words.)`);
    }, 60_000);
    timer.unref?.();
    this.proposals.set(proposalId, { med, timer });
    this.send({ type: "profile_add", proposalId, med, speech });
    log("live.profile_add", { session: shortId(this.hub.id), has_gtin: !!med.gtin });
    return { ok: true, status: "waiting_for_user_confirmation_on_phone", speech: "Please confirm on your phone.",
      instruction: "Say briefly that they should confirm on their phone. Nothing is saved yet; you'll be told when they confirm or decline." };
  }

  /** The phone's answer to profile_add. Only an explicit accept adds the med to the session profile. */
  resolveProposal(proposalId: string, accepted: boolean, edited?: unknown) {
    const p = this.proposals.get(proposalId);
    if (!p) return;
    clearTimeout(p.timer);
    this.proposals.delete(proposalId);
    if (!accepted) { this.text(`(The user declined: ${p.med.name} was not added. Acknowledge in a few words.)`); return; }
    const med = edited ? toProfile({ meds: [edited] }).meds[0] ?? p.med : p.med;
    if (!med.gtin && p.med.gtin) med.gtin = p.med.gtin;
    const list = this.hub.profile.meds;
    const i = list.findIndex((m) => m.id === med.id);
    if (i >= 0) list[i] = med; else list.push(med);
    log("live.profile_add_accepted", { session: shortId(this.hub.id) });
    this.text(`(Saved on the phone: ${med.name} ${med.strength}, taken ${med.schedule.join(", ")}, is now on the user's list. Confirm in a few words.)`);
  }

  private logDose(medId: string) {
    const med = this.hub.profile.meds.find((m) => m.id === medId);
    if (!med) return { ok: false, error: "unknown medId" };
    this.hub.profile.doseLog.push({ medId, ts: Date.now() });
    if (this.hub.lastVerdict?.matchedMedId === medId) {
      this.hub.lastVerdict = { ...this.hub.lastVerdict, takenToday: true };
      this.hub.emit({ type: "verdict", verdict: this.hub.lastVerdict }, { clients: false });
    }
    return { ok: true, med: med.name };
  }

  // ---------- client input ----------
  audio(data: string) {
    try { this.session?.sendRealtimeInput({ audio: { data, mimeType: "audio/pcm;rate=16000" } }); } catch { /* socket closing */ }
  }
  private lastVideoAt = 0;
  frame(data: string) {
    this.lastFrameAt = Date.now();
    // Live only needs ~1 fps for coaching; the ring buffer keeps every frame for verify_label.
    if (Date.now() - this.lastVideoAt < 900) return;
    this.lastVideoAt = Date.now();
    try { this.session?.sendRealtimeInput({ video: { data, mimeType: "image/jpeg" } }); } catch { /* */ }
  }
  text(text: string) {
    this.lastUserSignal = Date.now(); this.awaitingFirstAudio = true;
    try { this.session?.sendRealtimeInput({ text: text.slice(0, 1000) }); } catch { /* */ }
  }
  handleEvent(name: string) {
    if (name === "stop") return this.stop("stopped by user");
    if (name === "repeat") {
      if (this.hub.lastVerdict) this.send({ type: "verdict", verdict: this.hub.lastVerdict });
      this.text("(The user pressed Repeat. Repeat your last answer briefly, word for word.)");
      return;
    }
    if (name === "log_dose") {
      const id = this.hub.lastVerdict?.matchedMedId;
      if (!id) {
        this.send({ type: "error", code: "bad_input", message: "No matched medicine to log yet.", recoverable: true });
        return;
      }
      const r = this.logDose(id);
      if (r.ok) this.text(`(The user just logged a dose of ${r.med}. Confirm in three or four words.)`);
    }
  }

  /** Test hook: drop the Gemini socket as if the network failed (exercises resume/reconnect). */
  debugDrop() {
    try { (this.session as any)?.conn?.close?.(); } catch { /* */ }
  }
  get currentModel() { return this.model; }
  /** For the /stage projector: numbers only. */
  stats(): LiveStats {
    const sorted = [...this.firstAudio].sort((a, b) => a - b);
    return {
      model: this.model || null,
      firstAudioS: this.firstAudio.at(-1) ?? null,
      firstAudioP50S: sorted[Math.floor(sorted.length / 2)] ?? null,
      turns: this.firstAudio.length,
      verify: this.lastVerify,
    };
  }

  stop(reason: string) {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.idleTimer);
    this.gen++;
    try { this.session?.close(); } catch { /* */ }
    this.session = null;
    this.send({ type: "status", live: "closed", detail: reason });
    this.finish(reason);
  }

  private finish(reason: string) {
    this.stopped = true;
    clearInterval(this.idleTimer);
    const sorted = [...this.firstAudio].sort((a, b) => a - b);
    ledger({
      feature: "live", model: [...this.modelsUsed].join(",") || "none", latency_s: (Date.now() - this.t0) / 1000,
      ok: this.modelsUsed.size > 0, duration_s: (Date.now() - this.t0) / 1000,
      first_audio_s: this.firstAudio[0] ?? null, first_audio_p50_s: sorted[Math.floor(sorted.length / 2)] ?? null,
      turns: this.firstAudio.length, tool_calls: this.toolCalls, tool_latencies_s: this.toolLat, reason: reason.slice(0, 40),
    });
    log("live.end", { session: shortId(this.hub.id), reason: reason.slice(0, 40), tools: this.toolCalls });
  }
}
