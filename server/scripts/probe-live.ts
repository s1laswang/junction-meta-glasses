// Probe which Live models accept an AUDIO session with our key. Prints timings + message kinds only.
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { GoogleGenAI, Modality } from "@google/genai";

config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.env"), quiet: true });
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY!, httpOptions: { apiVersion: "v1beta" } });
const models = process.argv.slice(2).length ? process.argv.slice(2) : ["gemini-3.8-live", "gemini-3.1-flash-live-preview", "gemini-2.5-flash-native-audio-latest"];
const mode = process.env.PROBE_MODE ?? "realtime"; // realtime | client

async function probe(model: string) {
  const t0 = Date.now();
  const kinds: string[] = [];
  let firstAudio = 0;
  let done!: () => void;
  const finished = new Promise<void>((r) => (done = r));
  try {
    const s = await ai.live.connect({
      model,
      config: {
        responseModalities: [Modality.AUDIO],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        sessionResumption: {},
        contextWindowCompression: { slidingWindow: {} },
        systemInstruction: "You are terse. Answer in one short sentence.",
        tools: [{ functionDeclarations: [{ name: "show_cue", description: "show a cue", behavior: "NON_BLOCKING" as any, parameters: { type: "OBJECT" as any, properties: { text: { type: "STRING" as any } } } }] }],
      },
      callbacks: {
        onmessage: (m) => {
          const k = Object.keys(m).filter((x) => (m as any)[x] !== undefined);
          if (m.serverContent) k.push(...Object.keys(m.serverContent).map((x) => "sc." + x));
          if (m.serverContent?.modelTurn?.parts?.some((p) => p.inlineData) && !firstAudio) firstAudio = Date.now() - t0;
          kinds.push(k.join("+"));
          if (m.serverContent?.turnComplete) done();
        },
        onerror: (e) => { console.log(model, "onerror", (e as any).message); done(); },
        onclose: (e) => { console.log(model, "onclose", e.code, e.reason); done(); },
      },
    });
    const tConn = Date.now() - t0;
    if (mode === "client") s.sendClientContent({ turns: [{ role: "user", parts: [{ text: "Say hello in five words." }] }], turnComplete: true });
    else s.sendRealtimeInput({ text: "Say hello in five words." });
    await Promise.race([finished, new Promise((r) => setTimeout(r, 15000))]);
    s.close();
    console.log(JSON.stringify({ model, ok: firstAudio > 0, connectMs: tConn, firstAudioMs: firstAudio, kinds: [...new Set(kinds)] }));
  } catch (e: any) {
    console.log(JSON.stringify({ model, ok: false, error: String(e?.message ?? e).slice(0, 300) }));
  }
}
for (const m of models) await probe(m);
process.exit(0);
