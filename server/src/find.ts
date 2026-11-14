// "Which one?" scene mode: several packages on a surface -> one schema-constrained read per package with a box,
// each run through the same safety check as a held item, then a body-relative answer ("the box on the right").
import fs from "node:fs";
import path from "node:path";
import type { LabelRead, Med, Profile, SceneItem, ScenePosition, Verdict } from "../../shared/types.ts";
import { REPO_ROOT } from "./env.ts";
import { checkLabelText, clampHeadline, clampSpeech, fmtStrength, norm, spokenIngredient } from "./safety.ts";
import { LABEL_SCHEMA, VERIFY_PROMPT, callJson, toLabelRead, unreadable } from "./verify.ts";

export const FIND_PROMPT = fs.readFileSync(path.join(REPO_ROOT, "shared", "find_prompt.md"), "utf8") + "\n\n" + VERIFY_PROMPT;
const RAW = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "shared", "scene_schema.json"), "utf8"));
delete RAW.$comment;
RAW.properties.items.items.properties.read = LABEL_SCHEMA; // inline label_schema.json
export const SCENE_SCHEMA = RAW;

export type RawItem = { box?: [number, number, number, number]; read: LabelRead; answers: boolean };

export function toRawItems(j: any): RawItem[] {
  const arr = Array.isArray(j?.items) ? j.items.slice(0, 6) : [];
  return arr.map((it: any) => {
    const b = Array.isArray(it?.box_2d) && it.box_2d.length === 4 && it.box_2d.every((n: unknown) => typeof n === "number")
      ? (it.box_2d.map((n: number) => Math.max(0, Math.min(1000, Math.round(n)))) as [number, number, number, number]) : undefined;
    return { box: b, read: toLabelRead(it?.read), answers: it?.answers_target === true };
  });
}

// ---------- positions ----------
const ABS: ScenePosition[] = ["far_left", "left", "center", "right", "far_right"];
const RANK: Record<number, ScenePosition[]> = {
  1: ["center"], 2: ["left", "right"], 3: ["left", "center", "right"],
  4: ["far_left", "left", "right", "far_right"], 5: ABS,
};
const xCenter = (b?: [number, number, number, number]) => (b ? (b[1] + b[3]) / 2 : 500);
/** Sort left to right; relative names for 2-5 items (what people mean by "the one on the right"), absolute bins otherwise. */
export function assignPositions<T extends { box?: [number, number, number, number] }>(items: T[]): (T & { position: ScenePosition })[] {
  const sorted = [...items].sort((a, b) => xCenter(a.box) - xCenter(b.box));
  const rank = sorted.length >= 2 && sorted.length <= 5 ? RANK[sorted.length] : undefined;
  return sorted.map((it, i) => ({ ...it, position: rank ? rank[i] : ABS[Math.min(4, Math.floor(xCenter(it.box) / 200))] }));
}
const POS_PHRASE: Record<ScenePosition, string> = { far_left: "on the far left", left: "on the left", center: "in the middle", right: "on the right", far_right: "on the far right" };
const POS_ADJ: Record<ScenePosition, string> = { far_left: "far-left", left: "left", center: "middle", right: "right", far_right: "far-right" };

// ---------- per-item labels ----------
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const SCHED = ["morning", "noon", "midday", "evening", "night", "bedtime"];
const schedWord = (m: Med) => SCHED.find((w) => m.schedule.some((s) => s.toLowerCase().includes(w)));

function itemName(read: LabelRead, med?: Med): string {
  if (med) return cap(spokenIngredient(med.ingredient) || med.name);
  if (read.ingredient.value && read.ingredient.confidence >= 0.6 && read.kind === "medication") return cap(read.ingredient.value.split(",")[0].trim());
  if (read.product.value && read.product.confidence >= 0.6) return read.product.value.replace(/\d+(?:[.,]\d+)?\s*(mg|g|mcg|µg|ml|iu)\b.*$/i, "").trim();
  return read.kind === "food" ? "a food package" : "a package I can't read";
}
function itemLabel(read: LabelRead, med?: Med): string {
  const n = itemName(read, med);
  return read.strength.value && read.strength.confidence >= 0.8 && read.kind === "medication" ? `${n} ${fmtStrength(read.strength.value)}` : n;
}
/** Short status from the held-item verdict (same thresholds). */
function status(v: Verdict, med?: Med): string {
  const r = v.reasons.join(" | ").toLowerCase();
  if (v.level === "match") { const w = med && schedWord(med); return w ? `your ${w} pill` : "on your list"; }
  if (v.level === "unsure") return "can't read it clearly";
  if (v.level === "warning") {
    if (r.includes("allergy")) return "has an allergen for you";
    if (r.includes("not on your medication list")) return "not on your list";
    if (r.includes("nsaid") || r.includes("avoid list")) return "on your avoid list";
    if (r.includes("expired")) return "expired";
    if (r.includes("differs")) return "wrong strength";
    if (r.includes("taken today")) return "already taken today";
    return "check it";
  }
  return "";
}

/** HUD-length status (the item headline is <= 6 words). */
function shortStatus(v: Verdict, med?: Med): string {
  const s = status(v, med);
  return ({ "can't read it clearly": "unclear", "has an allergen for you": "allergen", "not on your list": "not on list",
    "on your avoid list": "avoid", "already taken today": "taken today", "on your list": "on list" } as Record<string, string>)[s]
    ?? s.replace(/^your /, "");
}

type Scored = SceneItem & { v: Verdict; med?: Med; label: string; answers: boolean };

// ---------- the answer ----------
export function buildSceneVerdict(raw: RawItem[], profile: Profile, target?: string, now = new Date()): Verdict {
  const placed = assignPositions(raw);
  const items: Scored[] = placed.map((it) => {
    const v = checkLabelText(it.read, profile, now);
    const med = v.matchedMedId ? profile.meds.find((m) => m.id === v.matchedMedId) : undefined;
    const label = itemLabel(it.read, med);
    const st = shortStatus(v, med);
    return {
      position: it.position, box: it.box, level: v.level, read: it.read,
      headline: clampHeadline(st ? `${label}: ${st}` : label).split(/\s+/).slice(0, 6).join(" "),
      ...(v.level === "match" && v.matchedMedId ? { matchedMedId: v.matchedMedId } : {}),
      v, med, label, answers: it.answers,
    };
  });
  const out = (level: Verdict["level"], headline: string, speech: string, best?: Scored): Verdict => ({
    mode: "scene", level, headline: clampHeadline(headline), speech: clampSpeech(speech),
    read: best?.read ?? items[0]?.read ?? unreadable(),
    ...(level === "match" && best?.matchedMedId ? { matchedMedId: best.matchedMedId } : {}),
    reasons: items.map((i) => `${i.position}: ${i.headline} (${i.level})`),
    items: items.map(({ position, box, level, headline, matchedMedId, read }) => ({ position, ...(box ? { box } : {}), level, headline, ...(matchedMedId ? { matchedMedId } : {}), read })),
  });

  if (!items.length) return out("unsure", "Can't see any packages", "I can't make out any packages yet. Step back a little so they're all in view.");

  const others = (best?: Scored) => items.filter((i) => i !== best);
  const warnLine = (best?: Scored) => {
    const w = others(best).find((i) => i.level === "warning");
    return w ? ` The ${POS_ADJ[w.position]} one is ${w.label}, ${status(w.v, w.med)}.` : "";
  };
  const seeList = (xs: Scored[]) => xs.slice(0, 3).map((i) => `${i.label} ${POS_PHRASE[i.position]}`);
  const joinAnd = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
  const noun = (i: Scored) => (i.read.kind === "food" ? "pack" : "box");

  const t = norm(target);
  // ---- no target: describe ----
  if (!t) {
    const mine = items.find((i) => i.level === "match");
    const s1 = `I see ${items.length} packages: ${joinAnd(seeList(items))}.`;
    const s2 = mine ? ` ${cap(status(mine.v, mine.med))} is the ${noun(mine)} ${POS_PHRASE[mine.position]}.` : warnLine();
    return out("info", `${items.length} packages seen`, s1 + s2, mine);
  }

  // ---- "which one has no nuts / is safe for me" (food) ----
  if (/\b(no|without|free|safe)\b|nut-free|allerg/.test(t) && !SCHED.some((w) => t.includes(w))) {
    const safe = items.filter((i) => i.read.kind === "food" && i.level === "info");
    const bad = items.filter((i) => i.level === "warning");
    if (safe.length === 1) {
      const s = safe[0];
      const badLine = bad[0] ? ` The ${POS_ADJ[bad[0].position]} one ${bad[0].v.speech.match(/(may contain|contains) [^.]+/)?.[0] ?? "has an allergen for you"}.` : "";
      return out("info", `${cap(POS_ADJ[s.position])} one: none of your allergens`, `The ${noun(s)} ${POS_PHRASE[s.position]}, ${s.label}, lists none of your allergens.${badLine}`, s);
    }
    if (safe.length > 1) return out("info", "Several look free of your allergens", `${cap(joinAnd(safe.map((s) => `the ${POS_ADJ[s.position]}`)))} ones list none of your allergens.${warnLine()}`, safe[0]);
    return out(bad.length ? "warning" : "unsure", "None clearly free of your allergens",
      `I can't find one that's clearly free of ${joinAnd(profile.allergies) || "your allergens"}.${bad[0] ? ` The ${POS_ADJ[bad[0].position]} one ${bad[0].v.speech.match(/(may contain|contains) [^.]+/)?.[0] ?? "has an allergen for you"}.` : " Pick one up so I can read its ingredients."}`, bad[0]);
  }

  // ---- medicine target: schedule word, a med name, or generic "my pill" ----
  const sw = SCHED.find((w) => t.includes(w));
  const named = profile.meds.filter((m) => [m.name, spokenIngredient(m.ingredient)].some((n) => n && t.includes(norm(n))));
  const wanted = sw ? profile.meds.filter((m) => schedWord(m) === sw || m.schedule.some((s) => s.toLowerCase().includes(sw))) : named.length ? named : profile.meds;
  const desc = sw ? `your ${sw} pill` : named.length === 1 ? `your ${cap(spokenIngredient(named[0].ingredient) || named[0].name)}` : "your medicine";
  const ids = new Set(wanted.map((m) => m.id));
  const cands = items.filter((i) => i.v.matchedMedId && ids.has(i.v.matchedMedId));
  const best = cands.find((i) => i.level === "match") ?? cands.find((i) => i.level === "warning") ?? cands[0];

  if (best?.level === "match") {
    return out("match", `${cap(desc.replace(/^your /, ""))}: box ${POS_PHRASE[best.position]}`,
      `${cap(desc)} is the ${noun(best)} ${POS_PHRASE[best.position]}.${warnLine(best)}`, best);
  }
  if (best?.level === "warning") {
    return out("warning", `${cap(POS_ADJ[best.position])} box: ${status(best.v, best.med)}`,
      `${cap(desc)} is the ${noun(best)} ${POS_PHRASE[best.position]}, but it's ${status(best.v, best.med).replace(/^already /, "already ")}. Pick it up so I can check it.`, best);
  }
  // only a guess (unsure read of a saved med, or the model's hint): never a match
  const guess = best ?? items.find((i) => i.answers && i.level !== "warning");
  if (guess) {
    return out("unsure", `Maybe the ${POS_ADJ[guess.position]} one, not sure`,
      `I think it's the one ${POS_PHRASE[guess.position]}. Pick it up so I can check the label.`, guess);
  }
  return out(items.some((i) => i.level === "warning") ? "warning" : "info", `Can't see ${desc.replace(/^your /, "your ")}`,
    `I can't see ${desc} here. I see ${joinAnd(seeList(items))}.`);
}

export async function findItems(frames: string[], profile: Profile, target?: string, feature = "find") {
  const parts: any[] = frames.slice(0, 2).map((data) => ({ inlineData: { mimeType: "image/jpeg", data } }));
  parts.push({ text: target?.trim() ? `The person asked: "${target.trim().slice(0, 200)}"` : "Describe which package is which." });
  const r = await callJson(feature, FIND_PROMPT, SCENE_SCHEMA, parts, parts.length - 1, toRawItems, 12_000);
  if (!r.value) {
    const v = buildSceneVerdict([], profile, target);
    v.speech = "I couldn't check the table just now. Pick one up and I'll read it.";
    v.reasons.push("reader unavailable");
    return { verdict: v, model: null as string | null, latencyMs: r.latencyMs };
  }
  return { verdict: buildSceneVerdict(r.value, profile, target), model: r.model, latencyMs: r.latencyMs };
}
