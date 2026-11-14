// Local verdict builders: used by the mock server and by offline barcode mode.
import type { CrossCheck, Gs1Code, LabelRead, Med, Profile, SceneItem, Verdict } from "../../../shared/types.ts";
import { expiryWords, isExpired, sameGtin } from "./gs1.ts";

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

/** Today's doses of one med, oldest first (mirrors server safety.ts dosesToday). */
export function dosesToday(p: Profile, medId: string, now = new Date()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return p.doseLog.filter((d) => d.medId === medId && d.ts >= start.getTime() && d.ts <= now.getTime()).sort((a, b) => a.ts - b.ts);
}

const hhmm = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * A saved medicine was recognised. Same rules as server/src/safety.ts: once today's doses reach the
 * number of scheduled doses it is a WARNING ("already taken today"), never a "Yes".
 * via "barcode" = offline: matched by barcode only, so the expiry date was not checked.
 */
/**
 * A saved medicine was recognised. Same rules as server/src/safety.ts: an expired pack is a WARNING,
 * and once today's doses reach the number of scheduled doses it is a WARNING ("already taken today").
 * via "barcode"    = offline EAN match: label and expiry not checked.
 * via "datamatrix" = offline exact match on the pack's GS1 code (GTIN), with the expiry from the code.
 */
export function matchVerdict(p: Profile, m: Med, opts: { via?: "barcode" | "label" | "datamatrix"; code?: Gs1Code; now?: Date } = {}): Verdict {
  const now = opts.now ?? new Date();
  const doses = dosesToday(p, m.id, now);
  const taken = doses.length;
  const perDay = Math.max(1, m.schedule.length);
  const label = `${m.name} ${m.strength}`.trim();
  const sw = m.schedule.join(" and ");
  const yours = sw ? `your ${sw} pill` : "on your list";
  const via = opts.via ?? "label";
  const code = via === "datamatrix" ? opts.code : undefined;
  const read = {
    ...emptyRead("medication"),
    product: f(m.name, 0.97),
    ingredient: f(m.ingredient, 0.93),
    strength: f(m.strength, via === "label" ? 0.95 : 0.99),
    expiry: f(code?.expiry ?? null, code?.expiry ? 1 : 0),
    barcode: f(code?.gtin ?? m.gtin ?? m.barcode ?? null, code?.gtin || m.barcode ? 0.99 : 0),
    readability: 0.92,
  };
  const reasons = [
    via === "barcode"
      ? "Matched by barcode only (offline): label and expiry not checked"
      : via === "datamatrix"
        ? "Exact match on the pack code (GS1 DataMatrix), offline"
        : "Name and strength match your list",
    `Taken today: ${taken} of ${perDay}`,
  ];
  const crossCheck: CrossCheck | undefined = code
    ? {
        source: "datamatrix",
        code,
        agrees: null,
        details: [`GTIN ${code.gtin} matches your ${m.name}`, ...(code.expiry ? [`expiry from the pack code: ${expiryWords(code.expiry)}`] : []), ...(code.batch ? [`batch ${code.batch}`] : [])],
      }
    : undefined;
  const base = { read, matchedMedId: m.id, reasons, ...(crossCheck ? { crossCheck } : {}) };

  if (code?.expiry && isExpired(code.expiry, now)) {
    return {
      ...base,
      level: "warning",
      headline: `${label}: expired ${expiryWords(code.expiry)}`,
      speech: `This is ${label}, your medicine, but the pack code says it expired in ${expiryWords(code.expiry)}. Don't take it; ask a pharmacist for a new pack.`,
      reasons: [...reasons, `Expired ${code.expiry}`],
      takenToday: taken > 0,
    };
  }
  if (taken >= perDay) {
    const last = doses[doses.length - 1];
    return {
      ...base,
      level: "warning",
      headline: `${label}: already taken today`,
      speech: `You already took ${m.name} today at ${hhmm(last.ts)}${taken > 1 ? `, ${taken} times` : ""}. Don't take another unless your plan says so.`,
      takenToday: true,
    };
  }
  const takenSpeech = taken === 0 ? "You haven't taken it today" : `You've taken ${taken} of ${perDay} doses today, last at ${hhmm(doses[taken - 1].ts)}`;
  const tail =
    via === "barcode"
      ? "; I matched the barcode offline, so I couldn't check the expiry date."
      : via === "datamatrix"
        ? `; matched exactly by the pack code offline${code?.expiry ? `, it expires ${expiryWords(code.expiry)}` : ""}.`
        : ".";
  return {
    ...base,
    level: "match",
    headline: via === "barcode" ? `${label} (barcode match)` : via === "datamatrix" ? `${label} (pack code)` : label,
    speech: `Yes, ${label}, ${yours}`.replace(", on your list", "") + `. ${takenSpeech}${tail}`,
    takenToday: taken > 0,
  };
}

/** Offline: a pack code whose GTIN isn't on the list. */
export function offlineUnknownCode(code: Gs1Code): Verdict {
  return {
    level: "unsure",
    headline: "Pack code not on your list",
    speech: `I'm offline, so I can only recognise your own saved medicines. This pack code isn't one of them${code.expiry ? `; it says the pack expires ${expiryWords(code.expiry)}` : ""}. I can't read new labels until the connection is back.`,
    read: { ...emptyRead("other"), barcode: f(code.gtin ?? null, 0.99), expiry: f(code.expiry ?? null, code.expiry ? 1 : 0), readability: 0.5 },
    reasons: ["Offline: only saved medicines can be checked", `GTIN ${code.gtin ?? "unknown"} is not in your profile`],
    crossCheck: { source: "datamatrix", code, agrees: null, details: ["GTIN not in your profile"] },
  };
}

export function findByGtin(p: Profile, gtin: string) {
  return p.meds.find((m) => sameGtin(m.gtin, gtin) || sameGtin(m.barcode, gtin));
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

/** "Which one?" demo: three boxes on the table, the evening pill on the right. */
export function mockScene(p: Profile): Verdict {
  const amlo = p.meds.find((m) => /amlodipine/i.test(m.name));
  const item = (position: SceneItem["position"], level: SceneItem["level"], headline: string, product: string, strength: string, box: [number, number, number, number], matchedMedId?: string): SceneItem => ({
    position,
    level,
    headline,
    box,
    matchedMedId,
    read: { ...emptyRead("medication"), product: f(product, 0.93), strength: f(strength, 0.9), readability: 0.85 },
  });
  const items: SceneItem[] = [
    item("left", "unsure", "Paracetamol: not on your list", "Paracetamol", "500 mg", [330, 70, 760, 300]),
    item("center", "warning", "Ibuprofen: you avoid NSAIDs", "Ibuprofen", "400 mg", [300, 390, 760, 610]),
    item("right", "match", "Amlodipine 5 mg: evening pill", "Amlodipine", "5 mg", [310, 700, 770, 930], amlo?.id),
  ];
  return {
    mode: "scene",
    level: "match",
    headline: "Your evening pill: on the right",
    speech: "Your evening pill, Amlodipine 5 milligrams, is the one on the right. The middle one is ibuprofen, which you avoid, and the left one is paracetamol.",
    read: items[2].read,
    matchedMedId: amlo?.id,
    reasons: ["3 packages seen, left to right", "Right: matches your Amlodipine 5 mg", "Middle: ibuprofen is an NSAID"],
    items,
  };
}

/** A label read that the pack's DataMatrix confirms (mock: shows the double-check badge). */
export function withCrossCheck(v: Verdict, agrees: boolean | null, details: string[], code: Gs1Code): Verdict {
  return { ...v, crossCheck: { source: "datamatrix", code, agrees, details } };
}
