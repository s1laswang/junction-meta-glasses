// Lists Gemini models relevant to HoldUp (never prints the key).
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.env"), quiet: true });
const k = process.env.GEMINI_API_KEY ?? "";
console.log("key present:", k.length > 0);
const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", { headers: { "x-goog-api-key": k } });
const j: any = await r.json();
console.log("status", r.status);
const re = new RegExp(process.argv[2] ?? "live|native-audio|3\\.8|tts|3-flash|3\\.1|2\\.5-flash$");
for (const m of j.models ?? []) if (re.test(m.name)) console.log(m.name, (m.supportedGenerationMethods ?? []).join(","));
