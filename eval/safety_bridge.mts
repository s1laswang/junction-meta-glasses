process.env.TZ = "Europe/Helsinki";
import { pathToFileURL } from "node:url";
import readline from "node:readline";

const p = process.env.HOLDUP_SAFETY_TS;
if (!p) { console.error("HOLDUP_SAFETY_TS not set"); process.exit(2); }
const { checkLabel } = await import(pathToFileURL(p).href);

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const out: string[] = [];
for await (const line of rl) {
  if (!line.trim()) continue;
  const c = JSON.parse(line);
  try {
    const v = checkLabel(c.read, c.profile, c.now ? new Date(c.now) : new Date("2026-11-14T12:00:00+02:00"), c.code);
    const row: Record<string, unknown> = { level: v.level, reasons: v.reasons, matchedMedId: v.matchedMedId ?? null };
    if ("code" in c || v.crossCheck !== undefined) row.crossCheck = v.crossCheck ?? null;
    out.push(JSON.stringify(row));
  } catch (e) {
    out.push(JSON.stringify({ level: "error", reasons: [String(e)], matchedMedId: null }));
  }
}
process.stdout.write(out.join("\n") + "\n");
