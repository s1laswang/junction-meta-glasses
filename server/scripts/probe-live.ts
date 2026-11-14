import fs from "node:fs";
import path from "node:path";
import { Behavior, Modality, Type, type LiveServerMessage, type Session } from "@google/genai";
import { env } from "../src/env.ts";
import { ai } from "../src/gemini.ts";
import { errSummary } from "../src/log.ts";

type ProbeResult = {
  model: string;
  ok: boolean;
  connectMs: number | null;
  firstAudioMs: number | null;
  kinds: string[];
  error?: string;
};

type ProbeReport = {
  testedAt: string;
  results: ProbeResult[];
};

function sanitizeErr(raw: unknown): string {
  return errSummary(raw).replace(/[\u2014\u2013]/g, "-");
}

const argv = process.argv.slice(2);
let outPath = "";
let timeoutMs = Number(process.env.PROBE_TIMEOUT_MS ?? 15000);
const modelArgs: string[] = [];

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--out" && argv[i + 1]) {
    outPath = argv[++i];
  } else if (arg.startsWith("--out=")) {
    outPath = arg.slice("--out=".length);
  } else if (arg === "--timeout" && argv[i + 1]) {
    const parsed = Number(argv[++i]);
    if (Number.isFinite(parsed) && parsed > 0) timeoutMs = parsed;
  } else if (arg.startsWith("--timeout=")) {
    const parsed = Number(arg.slice("--timeout=".length));
    if (Number.isFinite(parsed) && parsed > 0) timeoutMs = parsed;
  } else if (!arg.startsWith("-")) {
    modelArgs.push(arg);
  }
}

const models = modelArgs.length ? modelArgs : env.liveModels;
const mode = process.env.PROBE_MODE ?? "realtime";

async function probe(model: string): Promise<ProbeResult> {
  const t0 = Date.now();
  const kinds: string[] = [];
  let connectMs: number | null = null;
  let firstAudioMs: number | null = null;
  let tSend = 0;
  let wsErr = "";
  let closing = false;
  let timedOut = false;
  let session: Session | null = null;
  let finishTurn!: () => void;
  const turnFinished = new Promise<void>((resolve) => {
    finishTurn = resolve;
  });

  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`probe timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    const connectPromise = ai.live.connect({
      model,
      config: {
        responseModalities: [Modality.AUDIO],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        sessionResumption: {},
        contextWindowCompression: { slidingWindow: {} },
        systemInstruction: "You are terse. Answer in one short sentence.",
        tools: [
          {
            functionDeclarations: [
              {
                name: "show_cue",
                description: "show a cue",
                behavior: Behavior.NON_BLOCKING,
                parameters: {
                  type: Type.OBJECT,
                  properties: { text: { type: Type.STRING } },
                },
              },
            ],
          },
        ],
      },
      callbacks: {
        onmessage: (m: LiveServerMessage) => {
          const record = m as unknown as Record<string, unknown>;
          const k = Object.keys(record).filter((x) => record[x] !== undefined);
          if (m.serverContent) {
            const sc = m.serverContent as unknown as Record<string, unknown>;
            k.push(...Object.keys(sc).filter((x) => sc[x] !== undefined).map((x) => `sc.${x}`));
          }
          if (m.serverContent?.modelTurn?.parts?.some((p) => p.inlineData) && firstAudioMs === null) {
            firstAudioMs = Date.now() - (tSend || t0);
          }
          if (k.length) kinds.push(k.join("+"));
          if (m.serverContent?.turnComplete) finishTurn();
        },
        onerror: (e: unknown) => {
          const msg = (e as { message?: unknown })?.message ?? e;
          if (!wsErr) wsErr = sanitizeErr(msg);
          finishTurn();
        },
        onclose: (e: { code?: number; reason?: string }) => {
          if (!closing && firstAudioMs === null && !wsErr) {
            const reason = String(e?.reason ?? "").trim();
            wsErr = sanitizeErr(reason ? `closed ${e?.code ?? 0}: ${reason}` : `closed ${e?.code ?? 0}`);
          }
          finishTurn();
        },
      },
    });
    connectPromise.then(
      (s) => {
        if (timedOut || closing) {
          try { s.close(); } catch {}
        }
      },
      () => {},
    );

    session = await Promise.race([connectPromise, timeoutPromise]);
    connectMs = Date.now() - t0;
    tSend = Date.now();
    if (mode === "client") {
      session.sendClientContent({
        turns: [{ role: "user", parts: [{ text: "Say hello in five words." }] }],
        turnComplete: true,
      });
    } else {
      session.sendRealtimeInput({ text: "Say hello in five words." });
    }
    await Promise.race([turnFinished, timeoutPromise]);
    const ok = firstAudioMs !== null;
    const uniqueKinds = [...new Set(kinds)];
    if (!ok) {
      return {
        model,
        ok: false,
        connectMs,
        firstAudioMs: null,
        kinds: uniqueKinds,
        error: wsErr || "no audio received before turn ended",
      };
    }
    return {
      model,
      ok: true,
      connectMs,
      firstAudioMs,
      kinds: uniqueKinds,
    };
  } catch (e: unknown) {
    return {
      model,
      ok: false,
      connectMs,
      firstAudioMs,
      kinds: [...new Set(kinds)],
      error: sanitizeErr(e),
    };
  } finally {
    if (timer) clearTimeout(timer);
    closing = true;
    try { session?.close(); } catch {}
  }
}

const results: ProbeResult[] = [];
for (const m of models) {
  results.push(await probe(m));
}

const report: ProbeReport = {
  testedAt: new Date().toISOString(),
  results,
};

const serialized = JSON.stringify(report, null, 2);
if (outPath) {
  const dest = path.resolve(process.cwd(), outPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, `${serialized}\n`, "utf8");
}
console.log(serialized);
process.exit(0);
