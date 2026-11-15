// Turns FieldSpotter boxes into short spoken coaching cues. Pure and deterministic (unit-tested), and conservative
// on purpose: a wrong cue costs trust, a missing cue costs nothing because Gemini still coaches and reads.
import type { CoachCue } from "../../shared/types.ts";
import type { FieldBox } from "./spotter.ts";

export type SpotCue = { kind: "covered" | "other_side" | "edge"; cue: CoachCue; text: string };
export const COACH = {
  strong: 0.6,        // a strength box at or above this counts as "the dose is in view"
  product: 0.5,       // the product name is in view
  seenFrames: 2,      // frames in a row before we believe the dose was in view
  lostFrames: 2,      // frames in a row without it before we say it is covered
  sharpDrop: 0.2,     // a sharpness drop this large means motion, not a covered label
  otherSideMs: 3000,  // product visible but no dose for this long -> "turn the box"
  edge: 15,           // box within this many 0..1000 units of the frame edge counts as cut off
  minGapMs: 3000,     // between any two cues
  sameKindMs: 8000,   // between two cues of the same kind
};

const best = (fields: FieldBox[], label: FieldBox["label"]) => fields.filter((f) => f.label === label).sort((a, b) => b.score - a.score)[0];

export class SpotCoach {
  private streak = 0; private had = false; private lost = 0; private sharpAtSeen = 0;
  private productOnlySince = 0; private edgeStreak = 0;
  private lastCueAt = 0; private lastKindAt: Record<string, number> = {};
  /** No cues before this time (the caller sets it while a check runs or the assistant is speaking). */
  quietUntil = 0;

  reset() { this.streak = 0; this.had = false; this.lost = 0; this.productOnlySince = 0; this.edgeStreak = 0; }

  /** Feed one detection result; returns a cue to speak, or undefined. */
  push(fields: FieldBox[], sharp: number, now: number): SpotCue | undefined {
    const s = best(fields, "strength"), p = best(fields, "product");
    let cue: SpotCue | undefined;
    if (s && s.score >= COACH.strong) {
      this.streak++; this.lost = 0; this.productOnlySince = 0;
      if (this.streak >= COACH.seenFrames) { this.had = true; this.sharpAtSeen = sharp; }
      const [y0, x0, y1, x1] = s.box;
      const dir = x0 < COACH.edge ? "to the right" : x1 > 1000 - COACH.edge ? "to the left" : y0 < COACH.edge ? "down" : y1 > 1000 - COACH.edge ? "up" : "";
      this.edgeStreak = dir ? this.edgeStreak + 1 : 0;
      if (dir && this.edgeStreak >= 2) cue = { kind: "edge", cue: "hold_still", text: `Move it a little ${dir}. The dose is at the edge.` };
    } else {
      this.streak = 0; this.edgeStreak = 0;
      const productHere = !!p && p.score >= COACH.product;
      if (!productHere) { this.had = false; this.lost = 0; this.productOnlySince = 0; }
      else if (this.had) {
        // the dose was in view and the product still is: something is in front of the dose, unless the frame just blurred
        if (sharp >= this.sharpAtSeen - COACH.sharpDrop) this.lost++; else this.lost = 0;
        if (this.lost >= COACH.lostFrames) { cue = { kind: "covered", cue: "hold_still", text: "Something is covering the dose. Move your thumb." }; this.had = false; this.lost = 0; }
      } else {
        this.productOnlySince ||= now;
        if (now - this.productOnlySince >= COACH.otherSideMs) { cue = { kind: "other_side", cue: "other_side", text: "Turn the box. The dose is on another side." }; this.productOnlySince = now; }
      }
    }
    if (!cue) return undefined;
    if (now < this.quietUntil || now - this.lastCueAt < COACH.minGapMs || now - (this.lastKindAt[cue.kind] ?? 0) < COACH.sameKindMs) return undefined;
    this.lastCueAt = now; this.lastKindAt[cue.kind] = now;
    return cue;
  }
}
