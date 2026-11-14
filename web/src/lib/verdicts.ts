// Local verdict builders: used by the mock server and by offline barcode mode.
import type { LabelRead, Med, Profile, Verdict } from "../../../shared/types.ts";
import { takenToday } from "./storage.ts";

const f = <T,>(value: T | null, confidence: number) => ({ value, confidence });

export function emptyRead(kind: LabelRead["kind"] = "unreadable"): LabelRead {
  return {
    kind,
    product: f(null, 0),
    ingredient: f(null, 0),
    strength: f(null, 0),
    dosing: f(null, 0),
    expiry: f(null, 0),
    allergens: f(null, 0),
    barcode: f(null, 0),
    readability: 0,
  };
}

export function scheduleText(m: Med) {
  if (!m.schedule.length) return "";
  if (m.schedule.length === 1) return `your ${m.schedule[0]} pill`;
  return `taken ${m.schedule.join(" and ")}`;
}

export function matchVerdict(p: Profile, m: Med, opts: { via?: "barcode" | "label" } = {}): Verdict {
  const taken = takenToday(p, m.id);
  const sched = scheduleText(m);
  return {
    level: "match",
    headline: `${m.name} ${m.strength}`.trim(),
    speech: `Yes. ${m.name} ${m.strength}${sched ? `, ${sched}` : ""}. ${taken ? "You already logged a dose today." : "You haven't logged it today."}`,
    read: {
      ...emptyRead("medication"),
      product: f(m.name, 0.97),
      ingredient: f(m.ingredient, 0.93),
      strength: f(m.strength, opts.via === "barcode" ? 0.99 : 0.95),
      barcode: f(m.barcode ?? null, m.barcode ? 0.99 : 0),
      readability: 0.92,
    },
    matchedMedId: m.id,
    reasons: [opts.via === "barcode" ? "Barcode matches your saved medicine" : "Name and strength match your list", ...(m.schedule.length ? [`Scheduled: ${m.schedule.join(", ")}`] : [])],
    takenToday: taken,
  };
}

export function offlineUnknownBarcode(code: string): Verdict {
  return {
    level: "unsure",
    headline: "Not one of your saved barcodes",
    speech: "I'm offline, so I can only recognise your own saved medicines by barcode. This barcode isn't one of them. I can't read new labels until the connection is back.",
    read: { ...emptyRead("other"), barcode: f(code, 0.99), readability: 0.5 },
    reasons: ["Offline: only saved barcodes can be checked", `Barcode ${code} is not in your profile`],
  };
}

export function findByBarcode(p: Profile, code: string) {
  const norm = (s: string) => s.replace(/\D/g, "").replace(/^0+/, "");
  return p.meds.find((m) => m.barcode && norm(m.barcode) === norm(code));
}

// ---- scripted demo verdicts (mock mode) ---------------------------------------
export function mockWarningIbuprofen(): Verdict {
  return {
    level: "warning",
    headline: "Ibuprofen: not on your list",
    speech: "This is Ibuprofen 400 milligrams. It isn't on your list, and your list says to avoid NSAIDs.",
    read: {
      ...emptyRead("medication"),
      product: f("Ibuprofen", 0.96),
      ingredient: f("ibuprofen", 0.95),
      strength: f("400 mg", 0.94),
      dosing: f("1 tablet up to 3 times a day", 0.8),
      expiry: f("2027-08", 0.85),
      readability: 0.9,
    },
    reasons: ["Not on your medication list", "Ibuprofen is an NSAID, and you avoid NSAIDs"],
  };
}

export function mockUnsureStrength(): Verdict {
  return {
    level: "unsure",
    headline: "Can't read the strength",
    speech: "I can read Metformin, but I can't read the strength confidently. Turn the box so the side panel faces you, or ask a pharmacist.",
    read: {
      ...emptyRead("medication"),
      product: f("Metformin", 0.9),
      ingredient: f("metformin hydrochloride", 0.82),
      strength: f(null, 0.31),
      readability: 0.45,
      guidance: "Show the side panel with the strength",
    },
    reasons: ["Strength unreadable (confidence 31%)", "HoldUp never guesses a dose"],
  };
}

export function mockFoodNuts(): Verdict {
  return {
    level: "warning",
    headline: "Contains hazelnuts",
    speech: "This is a chocolate oat bar. It contains hazelnuts, and you're allergic to tree nuts. Best before March 2027.",
    read: {
      ...emptyRead("food"),
      product: f("Chocolate oat bar", 0.93),
      allergens: f(["hazelnut", "oats", "milk"], 0.92),
      expiry: f("2027-03-12", 0.88),
      readability: 0.88,
    },
    reasons: ["Allergen panel lists hazelnut", "Your allergies: tree nuts"],
  };
}
