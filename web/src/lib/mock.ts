// ?mock=1 : an in-browser fake of the HoldUp server. Speaks the real ServerMsg contract on a script,
// so the UI can be developed and demoed without the backend (and as a stage fallback).
import type { ClientMsg, DeviceState, FeatureFlag, Gs1Code, Profile, ServerMsg, Verdict } from "../../../shared/types.ts";
import { synthPcmChunks } from "./audio.ts";
import { matchVerdict, mockFoodNuts, mockScene, mockUnsureStrength, mockWarningIbuprofen, withCrossCheck } from "./verdicts.ts";
import { parseGs1, sameGtin } from "./gs1.ts";
import { demoProfile } from "./storage.ts";

const params = typeof location !== "undefined" ? new URLSearchParams(location.search) : new URLSearchParams();
export const IS_MOCK = params.get("mock") === "1";
const MOCK_AUDIO = params.get("mockaudio") === "1";

type Ctl = {
  failConnects: number; // the next N connection attempts fail
  slow: boolean; // pong delayed ~1.2 s, to show adaptive frame rate
  offline: boolean; // mock fetch fails, as if the network were gone
  geminiDown: boolean; // server reports degraded
  device: DeviceState;
  sockets: Set<MockSocket>;
};
export const mockCtl: Ctl = {
  failConnects: 0,
  slow: false,
  offline: false,
  geminiDown: false,
  device: { connected: false, worn: false, battery: null, streaming: false, source: "phone" },
  sockets: new Set(),
};

let scenarioIndex = 0;

/** Mirror to a HUD tab in the same browser (/hud?mock=1), like the server's HUD fan-out. */
export const MOCK_HUD_CHANNEL = "holdup-hud-mock";
let hudChannel: BroadcastChannel | null = null;
let lastHudStatus: ServerMsg | null = null;
let lastHudDevice: ServerMsg | null = null;
let lastHudCoach: ServerMsg | null = null;
let lastHudVerdict: Verdict | null = null;

function attachDefaultHudListener(ch: BroadcastChannel) {
  (ch as unknown as { unref?: () => void }).unref?.();
  ch.onmessage = (e: MessageEvent<{ type?: string }>) => {
    if (e.data?.type !== "hud_hello") return;
    if (lastHudStatus) ch.postMessage(lastHudStatus);
    if (lastHudDevice) ch.postMessage(lastHudDevice);
    if (lastHudCoach) ch.postMessage(lastHudCoach);
    if (lastHudVerdict) ch.postMessage({ type: "verdict", verdict: lastHudVerdict });
  };
}

function ensureHudChannel() {
  if (hudChannel || typeof BroadcastChannel === "undefined") return hudChannel;
  try {
    hudChannel = new BroadcastChannel(MOCK_HUD_CHANNEL);
    attachDefaultHudListener(hudChannel);
  } catch {
    hudChannel = null;
  }
  return hudChannel;
}

export function mockHudChannel() {
  try {
    hudChannel?.close();
    hudChannel = new BroadcastChannel(MOCK_HUD_CHANNEL);
    attachDefaultHudListener(hudChannel);
  } catch {
    hudChannel = null;
  }
  return hudChannel;
}
function toHud(m: ServerMsg) {
  if (m.type === "status") lastHudStatus = m;
  else if (m.type === "device") lastHudDevice = m;
  else if (m.type === "coach") lastHudCoach = m;
  else if (m.type === "verdict") {
    lastHudVerdict = m.verdict;
    lastHudCoach = null;
  } else return;
  ensureHudChannel()?.postMessage(m);
}

export class MockSocket {
  readyState = 0;
  bufferedAmount = 0;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private profile: Profile = demoProfile();
  private lastVerdict: Verdict | null = null;
  private running = false;
  private frames = 0;
  private features: FeatureFlag[] = ["scene", "datamatrix", "addmed", "sonar"];
  private pendingCode: Gs1Code | null = null;
  private autoTimer: ReturnType<typeof setTimeout> | null = null;
  private scenarioTimers: ReturnType<typeof setTimeout>[] = [];

  constructor() {
    ensureHudChannel();
    mockCtl.sockets.add(this);
    const fail = mockCtl.failConnects > 0 || mockCtl.offline;
    if (mockCtl.failConnects > 0) mockCtl.failConnects--;
    this.later(fail ? 900 : 250, () => {
      if (fail) {
        this.readyState = 3;
        this.onerror?.(new Event("error"));
        const closeEv =
          typeof CloseEvent !== "undefined"
            ? new CloseEvent("close", { code: 1006, reason: "Server unreachable (mock)" })
            : (Object.assign(new Event("close"), { code: 1006, reason: "Server unreachable (mock)", wasClean: false }) as CloseEvent);
        this.onclose?.(closeEv);
        mockCtl.sockets.delete(this);
        return;
      }
      this.readyState = 1;
      this.onopen?.(new Event("open"));
    });
  }

  private later(ms: number, fn: () => void) {
    this.timers.push(setTimeout(fn, ms));
  }
  private scenarioLater(ms: number, fn: () => void) {
    const h = setTimeout(fn, ms);
    this.timers.push(h);
    this.scenarioTimers.push(h);
  }
  private clearScenario() {
    if (this.autoTimer) clearTimeout(this.autoTimer);
    this.autoTimer = null;
    this.scenarioTimers.forEach(clearTimeout);
    this.scenarioTimers = [];
    this.running = false;
  }
  private emit(m: ServerMsg) {
    if (this.readyState !== 1) return;
    toHud(m);
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(m) }));
  }
  private say(text: string) {
    this.emit({ type: "transcript", role: "assistant", text, final: true });
    if (MOCK_AUDIO) for (const c of synthPcmChunks([392, 440, 494].slice(0, 1 + (text.length % 3)))) this.emit({ type: "audio", data: c });
  }

  send(data: string) {
    if (this.readyState !== 1) return;
    let m: ClientMsg;
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    switch (m.type) {
      case "start":
        this.profile = m.profile;
        this.features = m.features ?? ["scene", "datamatrix", "addmed", "sonar"];
        this.emit({ type: "ready", model: "mock-gemini-live", session: "MOCK", features: this.features });
        if (mockCtl.geminiDown) {
          this.emit({ type: "status", live: "degraded", detail: "Gemini Live is unavailable (simulated). Use snapshot mode." });
          return;
        }
        this.emit({ type: "status", live: "open", detail: "Mock server: scripted demo" });
        if (mockCtl.device.connected) this.emit({ type: "device", device: mockCtl.device });
        this.later(900, () => this.emit({ type: "transcript", role: "assistant", text: "Hi, I'm watching. Hold the box up in front of you.", final: true }));
        // the scripted demo starts by itself unless the user types/asks something first
        this.autoTimer = setTimeout(() => this.runScenario(), 1600);
        this.timers.push(this.autoTimer);
        break;
      case "ping":
        this.later(mockCtl.slow ? 1100 + Math.random() * 400 : 40 + Math.random() * 60, () => this.emit({ type: "pong", t: m.t }));
        break;
      case "profile_add_result":
        this.say(m.accepted ? `Added ${m.med?.name ?? "it"} to your list. Hold up the next box, or say stop when you're done.` : "Okay, I didn't add it.");
        break;
      case "datamatrix": {
        const code = parseGs1(m.raw);
        if (code) {
          this.pendingCode = code;
          if (this.lastVerdict && !this.running && this.lastVerdict.mode !== "scene" && this.features.includes("datamatrix")) {
            const amlo = this.profile.meds.find((med) => /amlodipin/i.test(med.name + " " + med.ingredient)) ?? demoProfile().meds[0];
            const same = !!this.lastVerdict.matchedMedId && (sameGtin(code.gtin, amlo.gtin) || sameGtin(code.gtin, amlo.barcode));
            this.lastVerdict = withCrossCheck(
              this.lastVerdict,
              same,
              same
                ? [`GTIN ${code.gtin} = your ${amlo.name}`, `expiry: code ${code.expiry ?? "?"} = print ${code.expiry ?? "?"}`]
                : [`pack code GTIN ${code.gtin} is not ${this.lastVerdict.read.product.value ?? "this product"}`],
              code,
            );
            this.emit({ type: "verdict", verdict: this.lastVerdict });
          }
        }
        break;
      }
      case "frame":
        this.frames++;
        break;
      case "text": {
        this.clearScenario();
        this.emit({ type: "transcript", role: "user", text: m.text, final: true });
        const t = m.text.toLowerCase();
        if (/\b(add|lisää|lisaa|lägg till|lagg till)\b|my medicines/.test(t) && this.features.includes("addmed")) {
          this.scenarioLater(400, () => this.runAddMed());
          break;
        }
        const pick = pickScenario(t, this.features.includes("scene"));
        this.scenarioLater(400, () => this.runScenario(pick));
        break;
      }
      case "event":
        if (m.name === "repeat" && this.lastVerdict) this.emit({ type: "verdict", verdict: this.lastVerdict });
        if (m.name === "log_dose") {
          if (this.lastVerdict?.matchedMedId) {
            this.lastVerdict = { ...this.lastVerdict, takenToday: true };
            toHud({ type: "verdict", verdict: this.lastVerdict });
            this.say("Logged. I'll remember you took it today.");
          } else {
            this.say("There's no matched medicine to log.");
          }
        }
        if (m.name === "stop") this.clear();
        break;
      case "audio":
        break;
    }
  }

  /** Readiness rising over ~7 s (sonar), as the label gets readable. */
  private rampReadiness(fromMs: number, toMs: number) {
    if (!this.features.includes("sonar")) return;
    for (let t = fromMs, i = 0; t <= toMs; t += 250, i++) {
      const v = Math.min(0.97, 0.08 + ((t - fromMs) / (toMs - fromMs)) * 0.9 + (i % 3 === 0 ? -0.04 : 0));
      this.scenarioLater(t, () => this.emit({ type: "readiness", value: Math.max(0, v) }));
    }
  }

  /** "Hold up to add": Gemini read the box and heard the schedule; the phone must confirm. */
  private runAddMed() {
    this.say("Sure. Hold up the first box and tell me when you take it.");
    this.rampReadiness(800, 5200);
    this.scenarioLater(2500, () => this.emit({ type: "transcript", role: "user", text: "I take this one in the morning.", final: true }));
    this.scenarioLater(5600, () => {
      const med = { id: "lisinopril", name: "Lisinopril", ingredient: "lisinopril", strength: "10 mg", schedule: ["morning"], gtin: "06416542005218" };
      this.emit({ type: "profile_add", proposalId: "p" + Date.now().toString(36), med, speech: "I read Lisinopril 10 milligrams, taken in the morning." });
    });
  }

  /** 0 match, 1 NSAID warning, 2 unsure strength, 3 food allergen. Cycles when not specified. */
  private runScenario(which?: number) {
    if (this.running) return;
    this.running = true;
    const n = this.features.includes("scene") ? 5 : 4;
    const idx = which ?? scenarioIndex++ % n;
    const p = this.profile;
    const amlo = p.meds.find((m) => /amlodipin/i.test(m.name + " " + m.ingredient)) ?? demoProfile().meds[0];
    const steps: [number, () => void][] = [
      [0, () => this.emit({ type: "transcript", role: "user", text: idx === 3 ? "Does this have nuts in it?" : idx === 4 ? "Which one is my evening pill?" : "Is this my evening pill?", final: true })],
      [1200, () => (this.emit({ type: "coach", cue: "other_side", text: "The label is facing away. Turn it around." }), this.say("I can see a box, but the label is on the other side. Turn it around."))],
      [3600, () => (this.emit({ type: "coach", cue: "rotate_left", text: "Turn it a little left" }), this.say("Turn it a little to the left."))],
      [5600, () => (this.emit({ type: "coach", cue: "closer", text: "A bit closer" }), this.say("A bit closer."))],
      [7400, () => (this.emit({ type: "coach", cue: "hold_still", text: "Hold still. Reading" }), this.say("Hold still, reading."))],
      [9000, () => (this.emit({ type: "coach", cue: "ok", text: "Got it" }), this.emit({ type: "checking", phase: "start" }))],
      [11800, () => this.emit({ type: "checking", phase: "end" })],
      [
        11800,
        () => {
          let v = idx === 0 ? matchVerdict(p, amlo) : idx === 1 ? mockWarningIbuprofen() : idx === 2 ? mockUnsureStrength() : idx === 3 ? mockFoodNuts() : mockScene(p);
          // a pack code the phone decoded during this check: the mock "server" cross-checks it
          const code = this.pendingCode;
          if (code && v.mode !== "scene" && this.features.includes("datamatrix")) {
            const same = !!v.matchedMedId && (sameGtin(code.gtin, amlo.gtin) || sameGtin(code.gtin, amlo.barcode));
            v = withCrossCheck(v, same, same ? [`GTIN ${code.gtin} = your ${amlo.name}`, `expiry: code ${code.expiry ?? "?"} = print ${code.expiry ?? "?"}`] : [`pack code GTIN ${code.gtin} is not ${v.read.product.value ?? "this product"}`], code);
            this.pendingCode = null;
          }
          this.lastVerdict = v;
          this.emit({ type: "verdict", verdict: v });
          this.say(v.speech);
          this.running = false;
        },
      ],
    ];
    for (const [ms, fn] of steps) this.scenarioLater(ms, fn);
    this.rampReadiness(1300, 8900);
  }

  pushDevice(d: DeviceState) {
    this.emit({ type: "device", device: d });
  }
  pushStatus(m: ServerMsg) {
    this.emit(m);
  }

  private clear() {
    this.timers.forEach(clearTimeout);
    this.timers = [];
    this.scenarioTimers = [];
    this.autoTimer = null;
    this.running = false;
  }

  close(code = 1000, reason = "") {
    if (this.readyState >= 2) return;
    this.clear();
    this.readyState = 3;
    mockCtl.sockets.delete(this);
    setTimeout(() => this.onclose?.(new CloseEvent("close", { code, reason })), 0);
  }
}

export function mockSetDevice(d: Partial<DeviceState>) {
  mockCtl.device = { ...mockCtl.device, ...d };
  let sent = false;
  for (const s of mockCtl.sockets) {
    if (s.readyState === 1) {
      s.pushDevice(mockCtl.device);
      sent = true;
    }
  }
  if (!sent) toHud({ type: "device", device: mockCtl.device });
}
export function mockSetGeminiDown(down: boolean) {
  mockCtl.geminiDown = down;
  const m: ServerMsg = down ? { type: "status", live: "degraded", detail: "Gemini Live is unavailable (simulated)" } : { type: "status", live: "open", detail: "Gemini Live is back" };
  let sent = false;
  for (const s of mockCtl.sockets) {
    if (s.readyState === 1) {
      s.pushStatus(m);
      sent = true;
    }
  }
  if (!sent) toHud(m);
}

export function pickScenario(text: string, allowScene = true): number | undefined {
  const t = text.toLowerCase();
  if ((/which|table|three|mikä näistä|mika naista|kumpi|kolme|pöydä|poyda|vilken av|på bordet|pa bordet|\btre\b/.test(t)) && allowScene) return 4;
  if (/nut|allerg|food|bar|pähkin|pahkin|mante|nöt|notter|mandel/.test(t)) return 3;
  if (/ibu|burana|ibumax|nsaid|pain|särky|kipu|smärt|värk/.test(t)) return 1;
  if (/strength|metformin|vahvuus|styrka/.test(t)) return 2;
  if (/evening|amlo|pill|ilta|kväll|kvall/.test(t)) return 0;
  return undefined;
}

// ---- mock HTTP -------------------------------------------------------------------
export async function mockFetch(path: string, body?: unknown): Promise<unknown> {
  await new Promise((r) => setTimeout(r, 500 + Math.random() * 500));
  if (mockCtl.offline) throw new TypeError("Failed to fetch (mock offline)");
  if (path === "/api/health") return { ok: true, gemini: mockCtl.geminiDown ? "down" : "ok", models: { live: "mock-gemini-live", verify: "mock-flash" }, version: "mock" };
  if (path === "/api/verify") {
    const b = (body ?? {}) as { profile?: Profile; question?: string };
    const p = b.profile ?? demoProfile();
    const amlo = p.meds.find((m) => /amlodipin/i.test(m.name + " " + m.ingredient)) ?? demoProfile().meds[0];
    const picked = b.question ? pickScenario(b.question, false) : undefined;
    const i = picked ?? scenarioIndex++ % 3;
    const v = i === 0 ? matchVerdict(p, amlo) : i === 1 ? mockWarningIbuprofen() : i === 3 ? mockFoodNuts() : mockUnsureStrength();
    toHud({ type: "verdict", verdict: v });
    return v;
  }
  throw new Error("mock: unknown path " + path);
}
