// GS1 element-string parser for EU FMD pack DataMatrix codes: (01) GTIN, (17) expiry, (10) batch, (21) serial.
// Accepts raw scanner output (optional ]d2 / ]C1 prefix, FNC1 as GS \x1d) and the human form "(01)…(17)…".
// MUST behave exactly like web/src/lib/gs1.ts (same AIs, lengths, century rule, DD=00 -> YYYY-MM) so the phone
// and the server agree on every cross-check. gtinValid/gtin14 are server extras for comparisons only.
import type { Gs1Code } from "../../shared/types.ts";

const GS = "\x1d";
// fixed-length AIs (data length, without the AI); everything else is variable up to GS/end
const FIXED: Record<string, number> = { "00": 18, "01": 14, "02": 14, "11": 6, "12": 6, "13": 6, "15": 6, "16": 6, "17": 6, "20": 2 };
const VAR_MAX: Record<string, number> = { "10": 20, "21": 20, "22": 20, "240": 30, "241": 30, "710": 20, "711": 20, "712": 20, "713": 20, "714": 20 };

/** YYMMDD -> ISO. DD=00 means "end of month" -> YYYY-MM. Same rule as the web parser. */
export function gs1Date(v: string): string | undefined {
  if (!/^\d{6}$/.test(v)) return undefined;
  const yy = Number(v.slice(0, 2));
  const mm = v.slice(2, 4);
  const dd = v.slice(4, 6);
  if (Number(mm) < 1 || Number(mm) > 12) return undefined;
  const year = yy >= 51 ? 1900 + yy : 2000 + yy; // GS1 sliding century is ±50 years; packs are all 20xx
  return dd === "00" ? `${year}-${mm}` : `${year}-${mm}-${dd}`;
}

/** Parse a DataMatrix payload. Returns undefined when it carries no GS1 data. */
export function parseGs1(input: string): Gs1Code | undefined {
  if (typeof input !== "string" || !input || input.length > 400) return undefined;
  let raw = input.trim();
  const out: Gs1Code = { raw: input };
  const fields: Record<string, string> = {};
  const finish = (): Gs1Code | undefined => {
    if (fields["01"] && /^\d{14}$/.test(fields["01"])) out.gtin = fields["01"];
    if (fields["17"]) out.expiry = gs1Date(fields["17"]);
    if (!out.expiry) delete out.expiry;
    if (fields["10"]) out.batch = fields["10"];
    if (fields["21"]) out.serial = fields["21"];
    return out.gtin || out.expiry || out.batch || out.serial ? out : undefined;
  };

  if (raw.startsWith("(")) {
    for (const m of raw.matchAll(/\((\d{2,4})\)([^(]*)/g)) fields[m[1]] = m[2].trim();
    return finish();
  }
  raw = raw.replace(/^\]d2/, "").replace(/^\]C1/, "").replace(/^\x1d+/, "");
  let i = 0, guard = 0;
  while (i < raw.length && guard++ < 20) {
    if (raw[i] === GS) { i++; continue; }
    let ai = raw.slice(i, i + 2);
    if (!/^\d\d$/.test(ai)) return Object.keys(fields).length ? finish() : undefined;
    if (FIXED[ai] == null && VAR_MAX[ai] == null) {
      const ai3 = raw.slice(i, i + 3);
      if (VAR_MAX[ai3] != null) ai = ai3;
    }
    i += ai.length;
    if (FIXED[ai] != null) {
      fields[ai] = raw.slice(i, i + FIXED[ai]);
      i += FIXED[ai];
    } else {
      const end = raw.indexOf(GS, i);
      const stop = end === -1 ? raw.length : end;
      fields[ai] = raw.slice(i, Math.min(stop, i + (VAR_MAX[ai] ?? 90)));
      i = stop;
    }
  }
  return finish();
}

/** GS1 mod-10 check digit (informational; the parser, like the web one, does not reject on it). */
export function gtinValid(g: string): boolean {
  if (!/^\d{8}$|^\d{12,14}$/.test(g)) return false;
  const d = g.split("").map(Number);
  const check = d.pop()!;
  let sum = 0;
  for (let i = d.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += d[i] * w;
  return (10 - (sum % 10)) % 10 === check;
}
/** Normalise EAN-8/13 / UPC-12 / GTIN-14 to 14 digits (= web sameGtin, which ignores leading zeros). */
export const gtin14 = (g: string | null | undefined) => {
  const d = (g ?? "").replace(/\D/g, "");
  return d.length >= 8 && d.length <= 14 && /[1-9]/.test(d) ? d.padStart(14, "0") : undefined;
};
