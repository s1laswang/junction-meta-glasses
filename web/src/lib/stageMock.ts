// /stage?mock=1 without a phone tab: a scripted loop that speaks the stage message contract
// (the same messages /hud-ws?role=stage sends). Labelled "scripted" on screen so nobody mistakes it for live.
import type { Profile, Verdict } from "../../../shared/types.ts";
import type { StageMetrics, StageMsg } from "./stage.ts";
import { matchVerdict, mockFoodNuts, mockScene, mockUnsureStrength, mockWarningIbuprofen, withCrossCheck } from "./verdicts.ts";

export type Step = [ms: number, msg: StageMsg];

const ALL = ["scene", "datamatrix", "addmed", "sonar"] as const;

export function mockMetrics(over: Partial<StageMetrics> = {}): StageMetrics {
  return {
    type: "metrics",
    model: "mock-gemini-live",
    firstAudioS: null,
    firstAudioP50S: null,
    turns: 0,
    verify: null,
    cache: { hits: 0, misses: 0 },
    features: [...ALL],
    phone: true,
    hud: true,
    source: "glasses",
    fps: 1,
    frameKb: 38.4,
    ...over,
  };
}

type Scenario = { ask: string; cues: [string, StageMsg & { type: "coach" }][]; verdict: Verdict; verifyMs: number; source: "cache" | "fresh" | "scene"; firstAudio: number };

function scenarios(p: Profile): Scenario[] {
  const amlo = p.meds.find((m) => /amlodipine/i.test(m.name)) ?? p.meds[0];
  const code = { raw: "(01)06416542005218(17)270831(10)B2417(21)A1", gtin: amlo.gtin ?? "06416542005218", expiry: "2027-08-31", batch: "B2417", serial: "A1" };
  const coach = (cue: Extract<StageMsg, { type: "coach" }>["cue"], text: string, say: string): [string, Extract<StageMsg, { type: "coach" }>] => [say, { type: "coach", cue, text }];
  return [
    {
      ask: "Is this my evening pill?",
      cues: [coach("other_side", "Turn it around", "The label is on the other side. Turn it around."), coach("closer", "A bit closer", "A bit closer."), coach("hold_still", "Hold still", "Hold still, reading.")],
      verdict: withCrossCheck(matchVerdict(p, amlo), true, [`GTIN matches your ${amlo.name}`, "expiry: code 2027-08 = print 2027-08"], code),
      verifyMs: 40,
      source: "cache",
      firstAudio: 1.1,
    },
    {
      ask: "Which one is my evening pill?",
      cues: [coach("hold_still", "Hold still", "Looking at the table.")],
      verdict: mockScene(p),
      verifyMs: 2900,
      source: "scene",
      firstAudio: 1.4,
    },
    {
      ask: "Can I take this for my headache?",
      cues: [coach("rotate_left", "Turn it left", "Turn it a little to the left."), coach("hold_still", "Hold still", "Hold still.")],
      verdict: mockWarningIbuprofen(),
      verifyMs: 0,
      source: "cache",
      firstAudio: 0.9,
    },
    {
      ask: "What strength is this one?",
      cues: [coach("closer", "A bit closer", "A bit closer."), coach("other_side", "Show the side panel", "Show me the side panel.")],
      verdict: mockUnsureStrength(),
      verifyMs: 2400,
      source: "fresh",
      firstAudio: 1.3,
    },
    {
      ask: "Does this have nuts in it?",
      cues: [coach("more_light", "More light", "It's a bit dark. Turn towards the light."), coach("hold_still", "Hold still", "Hold still.")],
      verdict: mockFoodNuts(),
      verifyMs: 60,
      source: "cache",
      firstAudio: 1.0,
    },
  ];
}

/** One full loop of the script (~70 s). Times are ms from the loop start. */
export function stageScript(p: Profile): Step[] {
  const out: Step[] = [
    [0, { type: "ready", model: "mock-gemini-live", session: "MOCK", features: [...ALL] }],
    [0, { type: "status", live: "open" }],
    [0, { type: "device", device: { connected: true, worn: true, battery: 78, streaming: true, source: "glasses" } }],
    [0, mockMetrics()],
  ];
  let t = 400;
  let hits = 0;
  let misses = 0;
  const fa: number[] = [];
  for (const sc of scenarios(p)) {
    out.push([t, { type: "transcript", role: "user", text: sc.ask, final: true }]);
    t += 900;
    for (let i = 0; i < sc.cues.length; i++) {
      const [say, cue] = sc.cues[i];
      out.push([t, cue]);
      out.push([t + 200, { type: "transcript", role: "assistant", text: say, final: true }]);
      // readiness climbs with each cue
      for (let k = 0; k < 6; k++) out.push([t + k * 250, { type: "readiness", value: Math.min(0.95, 0.15 + ((i * 6 + k) / (sc.cues.length * 6)) * 0.8) }]);
      t += 1800;
    }
    if (sc.source === "cache") hits++;
    else if (sc.source === "fresh") misses++;
    fa.push(sc.firstAudio);
    const sorted = [...fa].sort((a, b) => a - b);
    out.push([t, { type: "checking", phase: "start" }]);
    t += Math.max(500, sc.verifyMs);
    out.push([t, { type: "checking", phase: "end" }]);
    out.push([t, { type: "verdict", verdict: sc.verdict }]);
    out.push([t + 50, mockMetrics({ firstAudioS: sc.firstAudio, firstAudioP50S: sorted[Math.floor(sorted.length / 2)], turns: fa.length, verify: { ms: sc.verifyMs, source: sc.source, level: sc.verdict.level }, cache: { hits, misses } })]);
    // the assistant speaks the verdict word by word, like Live's output transcription
    const words = sc.verdict.speech.split(" ");
    for (let w = 1; w <= words.length; w++) out.push([t + 150 + w * 140, { type: "transcript", role: "assistant", text: words.slice(0, w).join(" "), final: w === words.length }]);
    t += 150 + words.length * 140 + 4500;
  }
  out.push([t, { type: "hud_event", name: "dismiss" }]);
  return out.sort((a, b) => a[0] - b[0]);
}

export const scriptLength = (s: Step[]) => (s.length ? s[s.length - 1][0] + 2000 : 0);
