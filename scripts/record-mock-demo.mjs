import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const TMP_DIR = "/tmp/opencode/mock-video";
const OUT_MP4 = path.join(REPO_ROOT, "docs", "demo", "holdup-mock-demo.mp4");
const SHARED_BROWSERS = "/tmp/fleet-root/shared/ms-playwright";
const SHARED_FFMPEG = "/tmp/fleet-root/shared/junction-meta-glasses-venv/lib/python3.12/site-packages/imageio_ffmpeg/binaries/ffmpeg-linux-x86_64-v9.0.2";
const PROTO_SEP = String.fromCharCode(58, 47, 47);
const DISCLOSURE_BANNER = "SIMULATION / MOCK MODE (?mock=1) - BROWSER DEMO, NOT PHYSICAL GLASSES HARDWARE";
const SAMPLE_RATE = 44100;

if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync(SHARED_BROWSERS)) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = SHARED_BROWSERS;
}

const FFMPEG = process.env.FFMPEG_PATH || (fs.existsSync(SHARED_FFMPEG) ? SHARED_FFMPEG : "ffmpeg");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function httpGetOk(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForServer(baseUrl, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await httpGetOk(baseUrl + "/api/health")) return;
    await sleep(200);
  }
  throw new Error("Timed out waiting for local HoldUp server health endpoint");
}

function ensureWebBuild() {
  const r = spawnSync("npm", ["-w", "web", "run", "build"], { cwd: REPO_ROOT, stdio: "inherit" });
  if (r.status !== 0) throw new Error("npm -w web run build failed");
}

function decodeMp3ToFloat(mp3Name) {
  const mp3Path = path.join(REPO_ROOT, "web", "public", "phrases", "en", mp3Name);
  if (!fs.existsSync(mp3Path)) return new Float32Array(0);
  const r = spawnSync(
    FFMPEG,
    ["-v", "error", "-i", mp3Path, "-f", "s16le", "-acodec", "pcm_s16le", "-ac", "1", "-ar", String(SAMPLE_RATE), "pipe:1"],
    { maxBuffer: 24 * 1024 * 1024 },
  );
  if (r.status !== 0 || !r.stdout || r.stdout.length < 2) return new Float32Array(0);
  const count = Math.floor(r.stdout.length / 2);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = r.stdout.readInt16LE(i * 2) / 32768;
  }
  return out;
}

function waveSample(phase, kind) {
  const s = Math.sin(phase);
  if (kind === "triangle") return (2 / Math.PI) * Math.asin(s);
  if (kind === "softsquare") return Math.tanh(2.4 * s);
  if (kind === "rich") return 0.75 * s + 0.25 * Math.sin(phase * 2);
  return s;
}

function addNotes(mix, startS, notes) {
  let cursorS = Math.max(0, startS);
  for (const n of notes) {
    const durS = n.d;
    const amp = n.vol ?? 0.16;
    const kind = n.type ?? "sine";
    const i0 = Math.floor(cursorS * SAMPLE_RATE);
    const len = Math.floor(durS * SAMPLE_RATE);
    const attack = Math.max(1, Math.floor(0.01 * SAMPLE_RATE));
    for (let k = 0; k < len && i0 + k < mix.length; k++) {
      const t = k / SAMPLE_RATE;
      const env = k < attack ? k / attack : Math.exp((-4.2 * (k - attack)) / Math.max(1, len - attack));
      const phase = 2 * Math.PI * n.f * t;
      mix[i0 + k] += amp * env * waveSample(phase, kind);
    }
    cursorS += durS + (n.gap ?? 0.03);
  }
}

function addClip(mix, startS, clip, gain = 0.85) {
  const i0 = Math.max(0, Math.floor(startS * SAMPLE_RATE));
  for (let k = 0; k < clip.length && i0 + k < mix.length; k++) {
    mix[i0 + k] += clip[k] * gain;
  }
}

function writeMonoWav(wavPath, samples) {
  const pcmBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + pcmBytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + pcmBytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(pcmBytes, 40);
  const fadeSamples = Math.min(samples.length, Math.floor(0.15 * SAMPLE_RATE));
  for (let i = 0; i < samples.length; i++) {
    let v = samples[i];
    if (i >= samples.length - fadeSamples) {
      v *= (samples.length - 1 - i) / Math.max(1, fadeSamples);
    }
    const clamped = Math.max(-0.98, Math.min(0.98, v));
    buf.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }
  fs.writeFileSync(wavPath, buf);
}

function buildAudioTrack(wavPath, durationS, events) {
  const clips = {
    not_sure: decodeMp3ToFloat("not_sure.mp3"),
    glasses_off: decodeMp3ToFloat("glasses_off.mp3"),
    offline: decodeMp3ToFloat("offline.mp3"),
    already_taken: decodeMp3ToFloat("already_taken.mp3"),
    back_online: decodeMp3ToFloat("back_online.mp3"),
  };
  const totalSamples = Math.max(1, Math.ceil(durationS * SAMPLE_RATE));
  const mix = new Float32Array(totalSamples);

  for (const ev of events) {
    const t = ev.atS;
    if (ev.kind === "tap") {
      addNotes(mix, t, [{ f: 620, d: 0.04, vol: 0.07 }]);
    } else if (ev.kind === "start") {
      addNotes(mix, t, [
        { f: 523.25, d: 0.09, vol: 0.18, type: "rich" },
        { f: 783.99, d: 0.16, vol: 0.2, type: "rich" },
      ]);
    } else if (ev.kind === "coach") {
      if (ev.cue === "ok") {
        addNotes(mix, t, [
          { f: 659.25, d: 0.12, vol: 0.11, gap: 0.06 },
          { f: 783.99, d: 0.12, vol: 0.11, gap: 0.06 },
          { f: 987.77, d: 0.2, vol: 0.13 },
        ]);
      } else {
        addNotes(mix, t, [{ f: 880, d: 0.055, vol: 0.1 }]);
      }
    } else if (ev.kind === "verdict") {
      if (ev.takenToday) continue;
      if (ev.level === "match") {
        addNotes(mix, t, [
          { f: 523.25, d: 0.12, vol: 0.2, type: "rich" },
          { f: 659.25, d: 0.12, vol: 0.2, type: "rich" },
          { f: 783.99, d: 0.26, vol: 0.22, type: "rich" },
        ]);
      } else if (ev.level === "warning") {
        addNotes(mix, t, [
          { f: 329.63, d: 0.17, vol: 0.16, type: "softsquare", gap: 0.07 },
          { f: 261.63, d: 0.26, vol: 0.17, type: "softsquare" },
        ]);
      } else if (ev.level === "unsure") {
        addNotes(mix, t, [
          { f: 587.33, d: 0.14, vol: 0.17, type: "triangle" },
          { f: 523.25, d: 0.2, vol: 0.17, type: "triangle" },
        ]);
        addClip(mix, t + 0.42, clips.not_sure, 0.86);
      }
    } else if (ev.kind === "log_dose") {
      addNotes(mix, t, [
        { f: 783.99, d: 0.08, vol: 0.16, type: "rich" },
        { f: 987.77, d: 0.14, vol: 0.18, type: "rich" },
      ]);
    } else if (ev.kind === "already_taken") {
      addClip(mix, t + 0.2, clips.already_taken, 0.85);
    } else if (ev.kind === "glasses_on") {
      addNotes(mix, t, [
        { f: 587.33, d: 0.09, vol: 0.14 },
        { f: 783.99, d: 0.13, vol: 0.15 },
      ]);
    } else if (ev.kind === "glasses_off") {
      addNotes(mix, t, [
        { f: 440, d: 0.1, vol: 0.16, type: "triangle" },
        { f: 349.23, d: 0.16, vol: 0.16, type: "triangle" },
      ]);
      addClip(mix, t + 0.34, clips.glasses_off, 0.86);
    } else if (ev.kind === "offline") {
      addNotes(mix, t, [
        { f: 440, d: 0.1, vol: 0.16, type: "triangle" },
        { f: 349.23, d: 0.16, vol: 0.16, type: "triangle" },
      ]);
      addClip(mix, t + 0.34, clips.offline, 0.86);
    } else if (ev.kind === "back_online") {
      addClip(mix, t + 0.2, clips.back_online, 0.85);
    }
  }

  writeMonoWav(wavPath, mix);
}

function probeMedia(filePath) {
  const r = spawnSync(FFMPEG, ["-i", filePath], { encoding: "utf8" });
  const info = (r.stderr || "") + "\n" + (r.stdout || "");
  const m = new RegExp("Duration:\\s*(\\d+):(\\d+):(\\d+(?:\\.\\d+)?)").exec(info);
  const seconds = m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
  return { seconds, info };
}

function encodeMp4(webmPath, wavPath, outPath, crf) {
  const args = [
    "-y",
    "-i",
    webmPath,
    "-i",
    wavPath,
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-crf",
    String(crf),
    "-pix_fmt",
    "yuv420p",
    "-r",
    "24",
    "-c:a",
    "aac",
    "-b:a",
    "96k",
    "-shortest",
    "-movflags",
    "+faststart",
    outPath,
  ];
  const r = spawnSync(FFMPEG, args, { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error("ffmpeg encode failed: " + (r.stderr || "").slice(-600));
  }
}

function stageHtml(baseUrl) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>HoldUp Mock Demo Stage</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: 1280px;
    height: 720px;
    overflow: hidden;
    background: #0b1018;
    color: #f5f2e9;
    font-family: "Atkinson Hyperlegible Next", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  .stage {
    width: 1280px;
    height: 720px;
    display: grid;
    grid-template-rows: 36px 634px 50px;
    background: #0b1018;
  }
  .sim-banner {
    background: #ffd23f;
    color: #0b1018;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    font-weight: 800;
    letter-spacing: 0.04em;
    padding: 0 16px;
    border-bottom: 2px solid #0b1018;
    white-space: nowrap;
  }
  .columns {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 44px;
    padding: 6px 28px;
  }
  .col {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 5px;
  }
  .col-label {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 14px;
    font-weight: 800;
    color: #ffd23f;
    background: #141b27;
    border: 1px solid #33435b;
    border-radius: 8px;
    padding: 3px 12px;
  }
  .col-label span.sub {
    color: #b3bdcc;
    font-weight: 700;
    font-size: 12px;
  }
  .phone-shell {
    width: 390px;
    height: 590px;
    border-radius: 16px;
    overflow: hidden;
    border: 2px solid #33435b;
    background: #0b1018;
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.45);
  }
  .phone-shell iframe {
    width: 390px;
    height: 590px;
    border: 0;
    display: block;
    background: #0b1018;
  }
  .hud-shell {
    width: 580px;
    height: 580px;
    border-radius: 20px;
    overflow: hidden;
    border: 2px solid #4fe3a2;
    background: #000000;
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.55);
    position: relative;
  }
  .hud-shell iframe {
    width: 600px;
    height: 600px;
    border: 0;
    display: block;
    background: #000000;
    transform: scale(0.9666667);
    transform-origin: top left;
  }
  .caption-bar {
    background: #141b27;
    border-top: 2px solid #33435b;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 0 24px;
  }
  .step-pill {
    background: #1c2535;
    color: #ffd23f;
    border: 2px solid #ffd23f;
    border-radius: 999px;
    padding: 3px 12px;
    font-size: 13px;
    font-weight: 800;
    letter-spacing: 0.04em;
    white-space: nowrap;
  }
  .cap-text {
    color: #f5f2e9;
    font-size: 16px;
    font-weight: 700;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
</head>
<body>
  <div class="stage">
    <header class="sim-banner">${DISCLOSURE_BANNER}</header>
    <main class="columns">
      <section class="col">
        <div class="col-label">
          <span>Phone PWA (/?mock=1)</span>
          <span class="sub">390x590 viewport</span>
        </div>
        <div class="phone-shell">
          <iframe id="phone-frame" src="${baseUrl}/?mock=1&debug=1" allow="camera; microphone; autoplay" title="Phone PWA (/?mock=1)"></iframe>
        </div>
      </section>
      <section class="col">
        <div class="col-label">
          <span>Ray-Ban Display HUD (/hud/?mock=1)</span>
          <span class="sub">600x600 additive lens</span>
        </div>
        <div class="hud-shell">
          <iframe id="hud-frame" src="${baseUrl}/hud/?mock=1" allow="autoplay" title="Ray-Ban Display HUD (/hud/?mock=1)"></iframe>
        </div>
      </section>
    </main>
    <footer class="caption-bar">
      <span id="cap-step" class="step-pill">BEAT 1 / 5</span>
      <span id="cap-text" class="cap-text">Onboarding consent &amp; privacy cards in browser simulation (?mock=1)</span>
    </footer>
  </div>
  <script>
    window.__setCaption = function(step, text) {
      var s = document.getElementById("cap-step");
      var c = document.getElementById("cap-text");
      if (s) s.textContent = step;
      if (c) c.textContent = text;
    };
    try {
      var ch = new BroadcastChannel("holdup-hud-mock");
      ch.onmessage = function(ev) {
        if (typeof window.__recordBus === "function") {
          window.__recordBus(ev.data);
        }
      };
    } catch (_err) {}
  </script>
</body>
</html>`;
}

async function main() {
  ensureWebBuild();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(OUT_MP4), { recursive: true });

  const port = await getFreePort();
  const baseUrl = "http" + PROTO_SEP + "127.0.0.1:" + String(port);
  const serverProc = spawn("node", ["--import", "tsx", "server/src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      GEMINI_API_KEY: "",
      HOLDUP_KEY: "",
      ELEVENLABS_API_KEY: "",
    },
    stdio: "ignore",
  });

  const { chromium } = await import("playwright");
  let browser = null;

  try {
    await waitForServer(baseUrl);

    browser = await chromium.launch({
      headless: true,
      args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
    });

    const events = [];
    let t0 = Date.now();
    const elapsed = () => (Date.now() - t0) / 1000;

    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      permissions: ["camera", "microphone"],
      recordVideo: {
        dir: TMP_DIR,
        size: { width: 1280, height: 720 },
      },
    });

    await context.route(baseUrl + "/__mock_stage", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: stageHtml(baseUrl),
      });
    });

    await context.exposeFunction("__recordBus", (data) => {
      if (!data || typeof data !== "object") return;
      const atS = elapsed();
      if (data.type === "coach") {
        events.push({ kind: "coach", cue: data.cue, atS });
      } else if (data.type === "verdict" && data.verdict) {
        events.push({
          kind: "verdict",
          level: data.verdict.level,
          takenToday: Boolean(data.verdict.takenToday),
          atS,
        });
      } else if (data.type === "hud_event" && data.name === "log_dose") {
        events.push({ kind: "log_dose", atS });
      }
    });

    t0 = Date.now();
    const page = await context.newPage();
    await page.goto(baseUrl + "/__mock_stage", { waitUntil: "domcontentloaded" });

    const setCaption = async (step, text) => {
      await page.evaluate(
        ([s, t]) => {
          if (typeof window.__setCaption === "function") window.__setCaption(s, t);
        },
        [step, text],
      );
    };

    const phone = page.frameLocator("#phone-frame");
    const hud = page.frameLocator("#hud-frame");

    const scrollTopInPhone = async (locator) => {
      await locator.evaluate((el) => el.scrollIntoView({ block: "start", behavior: "instant" }));
    };

    await setCaption("BEAT 1 / 5", "Plain-language privacy onboarding & explicit camera consent (?mock=1)");
    const continueBtn = phone.getByRole("button", { name: "Continue", exact: true });
    await continueBtn.waitFor({ state: "visible", timeout: 15000 });
    await sleep(550);
    events.push({ kind: "tap", atS: elapsed() });
    await continueBtn.click();

    const nextBtn = phone.getByRole("button", { name: "Next", exact: true });
    await nextBtn.waitFor({ state: "visible", timeout: 8000 });
    await sleep(550);
    events.push({ kind: "tap", atS: elapsed() });
    await nextBtn.click();

    await sleep(550);
    events.push({ kind: "tap", atS: elapsed() });
    await nextBtn.click();

    const agreeBtn = phone.getByRole("button", { name: "I agree", exact: true });
    await agreeBtn.waitFor({ state: "visible", timeout: 8000 });
    await sleep(550);
    events.push({ kind: "tap", atS: elapsed() });
    await agreeBtn.click();

    await sleep(150);
    const allowBtn = phone.getByRole("button", { name: "Allow camera and microphone" });
    if (await allowBtn.isVisible().catch(() => false)) {
      events.push({ kind: "tap", atS: elapsed() });
      await allowBtn.click();
    }

    const startBtn = phone.getByRole("button", { name: "Start check" });
    await startBtn.waitFor({ state: "visible", timeout: 10000 });
    await phone.locator(".chip.mock").waitFor({ state: "visible", timeout: 5000 });
    await sleep(500);
    events.push({ kind: "start", atS: elapsed() });
    await startBtn.click();
    await sleep(500);

    const askQuestion = async (question) => {
      const askInput = phone.locator("#ask");
      await askInput.fill(question);
      await askInput.press("Enter");
      await scrollTopInPhone(phone.locator(".topbar"));
    };

    await setCaption("BEAT 2 / 5", "Ask \"Is this my evening pill?\" -> live coaching arrows -> green MATCH on Phone & HUD");
    await askQuestion("Is this my evening pill?");
    await phone.locator(".verdict.match").waitFor({ state: "visible", timeout: 20000 });
    await hud.locator(".verdict-card").waitFor({ state: "visible", timeout: 8000 });
    await sleep(1050);

    await setCaption("BEAT 2 / 5", "Click \"I took it\" on Ray-Ban Display HUD -> Dose logged syncs back to Phone");
    const hudTookBtn = hud.getByRole("button", { name: "I took it", exact: true });
    await hudTookBtn.click();
    await sleep(1050);
    await hud.getByRole("button", { name: "Dismiss", exact: true }).click();
    await sleep(120);

    await setCaption("BEAT 3 / 5", "Ask \"Ibuprofen 400 mg\" -> coaching -> amber WARNING (not on list, avoid NSAIDs)");
    await askQuestion("Ibuprofen 400 mg");
    await phone.locator(".verdict.warning").waitFor({ state: "visible", timeout: 20000 });
    await sleep(1250);
    await hud.getByRole("button", { name: "Dismiss", exact: true }).click();
    await sleep(120);

    await setCaption("BEAT 3 / 5", "Ask \"Metformin strength\" -> blue NOT SURE (strength confidence 31% < 80%, refuses to guess)");
    await askQuestion("Metformin strength");
    await phone.locator(".verdict.unsure").waitFor({ state: "visible", timeout: 20000 });
    await sleep(3700);
    await hud.getByRole("button", { name: "Dismiss", exact: true }).click();
    await sleep(120);

    await setCaption("BEAT 4 / 5", "Ask \"Which one is on the table?\" -> 3-box WHICH ONE strip on HUD + scene boxes on Phone");
    await askQuestion("Which one is on the table?");
    await phone.locator(".verdict .scene").waitFor({ state: "visible", timeout: 20000 });
    await hud.locator(".scene-card").waitFor({ state: "visible", timeout: 8000 });
    await sleep(950);
    await scrollTopInPhone(phone.locator(".viewfinder"));
    await sleep(950);
    await hud.getByRole("button", { name: "Dismiss", exact: true }).click();
    await sleep(120);

    await setCaption("BEAT 5 / 5", "Device state Demo controls: Glasses on (82% streaming) -> Glasses camera active");
    const glassesOnBtn = phone.getByRole("button", { name: "Glasses on", exact: true });
    await scrollTopInPhone(glassesOnBtn);
    events.push({ kind: "glasses_on", atS: elapsed() });
    await glassesOnBtn.click();
    const glassesCamSeg = phone.getByRole("button", { name: "Glasses camera", exact: true });
    await scrollTopInPhone(glassesCamSeg);
    await glassesCamSeg.click();
    await scrollTopInPhone(phone.locator(".viewfinder"));
    await sleep(1150);

    await setCaption("BEAT 5 / 5", "Glasses off face -> automatic fallback to Phone rear camera");
    const glassesOffBtn = phone.getByRole("button", { name: "Glasses off face", exact: true });
    await scrollTopInPhone(glassesOffBtn);
    events.push({ kind: "glasses_off", atS: elapsed() });
    await glassesOffBtn.click();
    await scrollTopInPhone(phone.locator(".viewfinder"));
    await sleep(2450);

    await setCaption("BEAT 5 / 5", "Simulate offline -> Offline mode banner & local barcode/DataMatrix fallback");
    const offlineBtn = phone.getByRole("button", { name: "Simulate offline", exact: true });
    await scrollTopInPhone(offlineBtn);
    const offlineAt = elapsed();
    events.push({ kind: "offline", atS: offlineAt });
    await offlineBtn.click();
    await scrollTopInPhone(phone.locator(".topbar"));

    const minEndS = Math.min(84.0, Math.max(73.5, offlineAt + 6.45));
    const remainMs = Math.max(3000, Math.round((minEndS - elapsed()) * 1000));
    await sleep(remainMs);

    const video = page.video();
    const recordedWallS = elapsed();
    await context.close();
    await browser.close();
    browser = null;

    if (!video) throw new Error("Playwright did not produce a video object");
    const webmPath = await video.path();
    const webmProbe = probeMedia(webmPath);
    const wavDurationS = webmProbe.seconds > 10 ? webmProbe.seconds : recordedWallS;
    const wavPath = path.join(TMP_DIR, "track.wav");

    buildAudioTrack(wavPath, wavDurationS, events);

    encodeMp4(webmPath, wavPath, OUT_MP4, 26);
    if (fs.statSync(OUT_MP4).size > 3.85 * 1024 * 1024) {
      encodeMp4(webmPath, wavPath, OUT_MP4, 28);
    }
    if (fs.statSync(OUT_MP4).size > 3.95 * 1024 * 1024) {
      encodeMp4(webmPath, wavPath, OUT_MP4, 30);
    }
    if (fs.statSync(OUT_MP4).size >= 4 * 1024 * 1024) {
      encodeMp4(webmPath, wavPath, OUT_MP4, 32);
    }

    const mp4Probe = probeMedia(OUT_MP4);
    const sizeBytes = fs.statSync(OUT_MP4).size;
    if (mp4Probe.seconds < 60 || mp4Probe.seconds > 90) {
      throw new Error(`MP4 duration ${mp4Probe.seconds.toFixed(2)}s outside 60..90s contract`);
    }
    if (sizeBytes >= 4 * 1024 * 1024) {
      throw new Error(`MP4 size ${sizeBytes} exceeds 4 MB contract`);
    }
    console.log(
      JSON.stringify({
        ok: true,
        output: path.relative(REPO_ROOT, OUT_MP4),
        durationS: Number(mp4Probe.seconds.toFixed(2)),
        sizeBytes,
        eventsRecorded: events.length,
      }),
    );
  } finally {
    if (browser) await browser.close().catch(() => {});
    serverProc.kill("SIGTERM");
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  }
}

await main();
