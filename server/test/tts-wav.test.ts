import assert from "node:assert/strict";
import fs from "node:fs";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { env, REPO_ROOT } from "../src/env.ts";
import { ai } from "../src/gemini.ts";
import { resetHubsForTest } from "../src/hub.ts";
import { startServer } from "../src/index.ts";
import { stats } from "../src/ledger.ts";
import {
  ALLOWED_TTS_VOICES,
  buildTtsPrompt,
  buildWav,
  normalizeTtsLang,
  parsePcmSampleRate,
  resolveTtsVoice,
  sanitizeTtsText,
  synthesizeTts,
} from "../src/tts.ts";

process.env.HOLDUP_QUIET = "1";

const tempLedger = path.join(os.tmpdir(), `holdup-tts-wav-${process.pid}.jsonl`);

let server: http.Server;
let baseUrl = "";
let prevApiKey = "";
let prevLedger = "";
let origGenerateContent: typeof ai.models.generateContent;
let mockGenerateImpl: ((params: Record<string, any>) => Promise<any>) | null = null;
let generateCalls = 0;

before(async () => {
  process.env.HOLDUP_QUIET = "1";
  prevApiKey = env.apiKey;
  env.apiKey = "";
  prevLedger = env.ledgerPath;
  env.ledgerPath = tempLedger;
  origGenerateContent = ai.models.generateContent.bind(ai.models);
  (ai.models as any).generateContent = async (params: Record<string, any>) => {
    generateCalls++;
    if (!mockGenerateImpl) throw new Error("unexpected generateContent call");
    return mockGenerateImpl(params);
  };
  resetHubsForTest();
  server = await startServer(0);
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

beforeEach(() => {
  mockGenerateImpl = null;
  generateCalls = 0;
  try {
    fs.rmSync(tempLedger, { force: true });
  } catch {}
});

after(async () => {
  (ai.models as any).generateContent = origGenerateContent;
  env.apiKey = prevApiKey;
  env.ledgerPath = prevLedger;
  resetHubsForTest();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try {
    fs.rmSync(tempLedger, { force: true });
  } catch {}
});

test("sanitizeTtsText strips control bytes, collapses whitespace, rejects blank strings, and caps length at 600", () => {
  assert.equal(sanitizeTtsText(undefined), "");
  assert.equal(sanitizeTtsText(null), "");
  assert.equal(sanitizeTtsText(42), "");
  assert.equal(sanitizeTtsText("   \n\t\r  "), "");
  assert.equal(sanitizeTtsText("\u0000\u0007\u001f"), "");
  assert.equal(sanitizeTtsText("  Amlodipine\u0000   5 mg.\n\tEvening pill.  "), "Amlodipine 5 mg. Evening pill.");
  const overlong = "x".repeat(750);
  assert.equal(sanitizeTtsText(overlong).length, 600);
});

test("resolveTtsVoice, normalizeTtsLang, and buildTtsPrompt enforce allowlisted voices and multilingual prompts", () => {
  for (const v of ALLOWED_TTS_VOICES) {
    assert.equal(resolveTtsVoice(v.toLowerCase()), v);
  }
  assert.equal(resolveTtsVoice("hostile-voice; drop table", "Kore"), "Kore");
  assert.equal(resolveTtsVoice(undefined, "aoede"), "Aoede");
  assert.equal(resolveTtsVoice(123, "bogus"), "Kore");

  assert.equal(normalizeTtsLang("fi-FI"), "fi");
  assert.equal(normalizeTtsLang("SV_se"), "sv");
  assert.equal(normalizeTtsLang("en-US"), "en");
  assert.equal(normalizeTtsLang("../etc"), "en");

  assert.equal(buildTtsPrompt("Hold still."), "Say calmly and clearly: Hold still.");
  assert.equal(buildTtsPrompt("Hold still.", "en-GB"), "Say calmly and clearly: Hold still.");
  assert.equal(buildTtsPrompt("Pidä paikallaan.", "fi-FI"), "Say calmly and clearly in Finnish: Pidä paikallaan.");
  assert.equal(buildTtsPrompt("Håll stilla.", "sv"), "Say calmly and clearly in Swedish: Håll stilla.");
  assert.equal(buildTtsPrompt("Unknown code.", "zz"), "Say calmly and clearly: Unknown code.");
});

test("parsePcmSampleRate and buildWav produce byte-exact PCM16LE RIFF headers and align odd PCM lengths", () => {
  assert.equal(parsePcmSampleRate("audio/L16;codec=pcm;rate=24000"), 24000);
  assert.equal(parsePcmSampleRate("audio/pcm;rate=16000"), 16000);
  assert.equal(parsePcmSampleRate("audio/pcm;rate=0"), 24000);
  assert.equal(parsePcmSampleRate("audio/pcm;rate=999999"), 24000);
  assert.equal(parsePcmSampleRate(undefined), 24000);

  const oddPcm = Buffer.from([0x10, 0x20, 0x30, 0x40, 0x50]);
  const wav = buildWav(oddPcm, 16000);
  assert.equal(wav.length, 44 + 4);
  assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(wav.readUInt32LE(4), 36 + 4);
  assert.equal(wav.subarray(8, 12).toString("ascii"), "WAVE");
  assert.equal(wav.subarray(12, 16).toString("ascii"), "fmt ");
  assert.equal(wav.readUInt32LE(16), 16);
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt32LE(28), 32000);
  assert.equal(wav.readUInt16LE(32), 2);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.subarray(36, 40).toString("ascii"), "data");
  assert.equal(wav.readUInt32LE(40), 4);
  assert.deepEqual(wav.subarray(44), Buffer.from([0x10, 0x20, 0x30, 0x40]));
});

test("synthesizeTts aborts hung primary model, rejects 1-byte truncated PCM, and succeeds on fallback model", async () => {
  const modelsTried: string[] = [];
  const res = await synthesizeTts(
    { text: "Amlodipiini 5 mg.", lang: "fi", voice: "puck" },
    {
      chain: ["tts-hung", "tts-truncated", "tts-good"],
      timeoutMs: 25,
      generateFn: async (model, prompt, voice, signal) => {
        modelsTried.push(model);
        assert.equal(voice, "Puck");
        assert.equal(prompt, "Say calmly and clearly in Finnish: Amlodipiini 5 mg.");
        if (model === "tts-hung") {
          return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
          });
        }
        if (model === "tts-truncated") {
          return {
            candidates: [
              { content: { parts: [{ inlineData: { data: Buffer.from([0xff]).toString("base64"), mimeType: "audio/pcm;rate=24000" } }] } },
            ],
          };
        }
        const validPcm = Buffer.alloc(480, 0x01);
        return {
          candidates: [
            { content: { parts: [{ inlineData: { data: validPcm.toString("base64"), mimeType: "audio/pcm;rate=24000" } }] } },
          ],
          usageMetadata: { promptTokenCount: 14, candidatesTokenCount: 60 },
        };
      },
    },
  );

  assert.deepEqual(modelsTried, ["tts-hung", "tts-truncated", "tts-good"]);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.model, "tts-good");
    assert.equal(res.voice, "Puck");
    assert.equal(res.sampleRate, 24000);
    assert.equal(res.wav.length, 44 + 480);
  }
  const summary = stats(tempLedger);
  const ttsStats = summary.features.tts as Record<string, any>;
  assert.equal(ttsStats.calls, 3);
  assert.equal(ttsStats.ok, 1);
  assert.equal(ttsStats.errors, 2);
});

test("POST /api/tts rejects whitespace-only input with 0 model calls and synthesizes multilingual WAV with fallback", async () => {
  const blankRes = await fetch(`${baseUrl}/api/tts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "   \n\t  " }),
  });
  assert.equal(blankRes.status, 400);
  assert.equal(blankRes.headers.get("cache-control"), "no-store");
  const blankBody = (await blankRes.json()) as Record<string, unknown>;
  assert.equal(blankBody.code, "bad_input");
  assert.equal(generateCalls, 0);

  let capturedPrompt = "";
  let capturedVoice = "";
  mockGenerateImpl = async (params) => {
    capturedPrompt = String(params.contents[0].parts[0].text);
    capturedVoice = String(params.config.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName);
    const pcm = Buffer.alloc(320, 0x02).toString("base64");
    return {
      candidates: [{ content: { parts: [{ inlineData: { data: pcm, mimeType: "audio/pcm;rate=24000" } }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 40 },
    };
  };

  const svRes = await fetch(`${baseUrl}/api/tts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Amlodipin 5 mg, kvällstablett.", lang: "sv-SE", voice: "Aoede" }),
  });
  assert.equal(svRes.status, 200);
  assert.equal(svRes.headers.get("cache-control"), "no-store");
  assert.match(svRes.headers.get("content-type") ?? "", /audio\/wav/i);
  assert.equal(capturedPrompt, "Say calmly and clearly in Swedish: Amlodipin 5 mg, kvällstablett.");
  assert.equal(capturedVoice, "Aoede");
  const wavBuf = Buffer.from(await svRes.arrayBuffer());
  assert.equal(wavBuf.length, 44 + 320);
  assert.equal(wavBuf.subarray(0, 4).toString("ascii"), "RIFF");
});

test("server/src/tts.ts and server/test/tts-wav.test.ts contain zero comments, em dashes, trailers, or API keys", () => {
  const slash = String.fromCharCode(47);
  const star = String.fromCharCode(42);
  const blockToken = slash + star;
  const lineCommentRe = new RegExp(`(^|[^:])${slash}${slash}`);
  const emDash = String.fromCharCode(0x2014);
  const coAuthoredRe = new RegExp(["Co", "Authored", "By"].join("-"), "i");
  const apiKeyRe = new RegExp("AIza" + "[0-9A-Za-z_-]{20,}");

  for (const rel of ["server/src/tts.ts", "server/test/tts-wav.test.ts"]) {
    const text = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
    assert.equal(text.includes(blockToken), false, `Forbidden block comment token in ${rel}`);
    assert.equal(text.includes(emDash), false, `Forbidden em dash in ${rel}`);
    assert.equal(coAuthoredRe.test(text), false, `Forbidden co-authored token in ${rel}`);
    assert.equal(apiKeyRe.test(text), false, `Forbidden API key pattern in ${rel}`);
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      assert.equal(lineCommentRe.test(lines[i]), false, `Forbidden line comment in ${rel}:${i + 1}`);
    }
  }
});
