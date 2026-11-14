// GS1 element-string parser for EU FMD DataMatrix codes on medicine packs.
// AIs used: (01) GTIN-14, (17) expiry YYMMDD (DD=00 means "end of month": we keep YYYY-MM), (10) batch, (21) serial.
// Accepts raw scanner output (optional "]d2" symbology prefix, FNC1 as GS \x1d) and the human-readable
// "(01)0…(17)…" form. Must stay in step with the server's parser (server/src) for cross-checks.
import type { Gs1Code } from "../../../shared/types.ts";

const GS = "\x1d";
// fixed-length AIs (data length, without the AI); everything else is variable up to GS/end
const FIXED: Record<string, number> = { "00": 18, "01": 14, "02": 14, "11": 6, "12": 6, "13": 6, "15": 6, "16": 6, "17": 6, "20": 2 };
const VAR_MAX: Record<string, number> = { "10": 20, "21": 20, "22": 20, "240": 30, "241": 30, "710": 20, "711": 20, "712": 20, "713": 20, "714": 20 };

function yymmdd(v: string): string | undefined {
  if (!/^\d{6}$/.test(v)) return undefined;
  const yy = Number(v.slice(0, 2));
  const mm = v.slice(2, 4);
  const dd = v.slice(4, 6);
  if (Number(mm) < 1 || Number(mm) > 12) return undefined;
  const year = yy >= 51 ? 1900 + yy : 2000 + yy; // GS1 sliding century is ±50 years; packs are all 20xx
  return dd === "00" ? `${year}-${mm}` : `${year}-${mm}-${dd}`;
}

export function parseGs1(input: string): Gs1Code | null {
  if (!input) return null;
  let raw = input.trim();
  const out: Gs1Code = { raw: input };
  const fields: Record<string, string> = {};

  if (raw.startsWith("(")) {
    // human-readable form
    for (const m of raw.matchAll(/\((\d{2,4})\)([^(]*)/g)) fields[m[1]] = m[2].trim();
  } else {
    raw = raw.replace(/^\]d2/, "").replace(/^\]C1/, "").replace(/^\x1d+/, "");
    let i = 0;
    let guard = 0;
    while (i < raw.length && guard++ < 20) {
      if (raw[i] === GS) {
        i++;
        continue;
      }
      let ai = raw.slice(i, i + 2);
      if (!/^\d\d$/.test(ai)) return Object.keys(fields).length ? finish() : null;
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
  }
  return finish();

  function finish(): Gs1Code | null {
    if (fields["01"] && /^\d{14}$/.test(fields["01"])) out.gtin = fields["01"];
    if (fields["17"]) out.expiry = yymmdd(fields["17"]);
    if (fields["10"]) out.batch = fields["10"];
    if (fields["21"]) out.serial = fields["21"];
    return out.gtin || out.expiry || out.batch || out.serial ? out : null;
  }
}

/** Compare GTINs / EANs ignoring leading zeros (an EAN-13 is a GTIN-14 with a leading 0). */
export function sameGtin(a?: string | null, b?: string | null) {
  if (!a || !b) return false;
  const n = (s: string) => s.replace(/\D/g, "").replace(/^0+/, "");
  return n(a) !== "" && n(a) === n(b);
}

/** The last valid day of an ISO YYYY-MM or YYYY-MM-DD expiry. */
export function expiryEnd(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return d ? new Date(y, m - 1, d, 23, 59, 59) : new Date(y, m, 0, 23, 59, 59);
}

export function isExpired(iso: string, now = new Date()) {
  return expiryEnd(iso).getTime() < now.getTime();
}

export function expiryWords(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  const month = new Date(y, m - 1, 1).toLocaleString("en-GB", { month: "long" });
  return d ? `${d} ${month} ${y}` : `${month} ${y}`;
}

/** Build a GS1 element string (used by mock mode and tests). */
export function makeGs1(c: { gtin: string; expiry: string /* YYMMDD */; batch?: string; serial?: string }) {
  return `01${c.gtin}17${c.expiry}` + (c.batch ? `10${c.batch}${GS}` : "") + (c.serial ? `21${c.serial}` : "");
}
