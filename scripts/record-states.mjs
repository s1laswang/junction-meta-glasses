// Records a "states reel" of the HoldUp phone app (390x844) and Display HUD (600x600) in mock mode.
// Usage: npm run build && (PORT=8790 npm -w server run start &) && node scripts/record-states.mjs [baseUrl]
// Output: docs/evidence/states-reel.webm and docs/evidence/states-reel.md (timestamp per state).
// The caption overlay is injected by this script only; no app code is changed.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const base = process.argv[2] ?? "http://localhost:8790";
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const outDir = path.join(root, "docs/evidence");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "holdup-reel-"));
const PHONE = { width: 390, height: 844 };
const HUD = { width: 600, height: 600 };
const W = PHONE.width + HUD.width; // final canvas: phone left, HUD right

// same browser discovery as scripts/a11y-audit.mjs
const cache = path.join(os.homedir(), "Library/Caches/ms-playwright");
const exe = fs.existsSync(cache)
  ? fs.readdirSync(cache).filter((d) => d.startsWith("chromium-")).sort().reverse()
      .map((d) => path.join(cache, d, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"))
      .find((p) => fs.existsSync(p))
  : undefined;
// SwiftShader GL: without it, headless Chrome never resolves <video>.play() on a camera stream, so checks hang at "starting"
const GL = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"];
const launch = (args) => chromium.launch({ headless: true, args: [...GL, ...args], ...(exe ? { executablePath: exe } : {}) });

const states = []; // { n, name, segment, t }
const wait = (p, ms) => p.waitForTimeout(ms);

async function caption(pages, text) {
  for (const p of pages)
    await p.evaluate((t) => {
      let el = document.getElementById("__reel_caption");
      if (!el) {
        el = document.createElement("div");
        el.id = "__reel_caption";
        el.setAttribute("aria-hidden", "true");
        el.style.cssText =
          "position:fixed;left:8px;right:8px;top:8px;z-index:2147483647;pointer-events:none;background:rgba(10,10,10,.82);color:#ffd84d;font:600 15px/1.3 system-ui,sans-serif;padding:6px 10px;border-radius:8px;border:2px solid #ffd84d;text-align:center";
        document.body.appendChild(el);
      }
      el.textContent = t;
    }, text).catch(() => {});
}
function mark(seg, t0, n, name) {
  states.push({ n, name, segment: seg, t: (Date.now() - t0) / 1000 });
  console.error(`[${seg}] ${((Date.now() - t0) / 1000).toFixed(1)}s state ${n}: ${name}`);
}
const click = async (page, name, opts = {}) => {
  const b = page.getByRole("button", { name, exact: opts.exact }).first();
  await b.scrollIntoViewIfNeeded().catch(() => {});
  await b.click();
};

// ---------- segment A: consent + camera denied (no fake media UI, no permission grant) ----------
const bA = await launch([]);
const ctxA = await bA.newContext({ viewport: PHONE, recordVideo: { dir: path.join(work, "a"), size: PHONE } });
const pA = await ctxA.newPage();
const tA = Date.now();
await pA.goto(`${base}/?mock=1`, { waitUntil: "networkidle" });
await caption([pA], "1 · Consent: privacy cards before the camera turns on");
mark("A", tA, 1, "Consent");
await wait(pA, 2000);
await click(pA, /^continue$/i);
for (let i = 0; i < 2; i++) (await wait(pA, 1600), await click(pA, /^next$/i));
await wait(pA, 1600);
await click(pA, /^i agree$/i);
await pA.getByRole("heading", { name: /camera and microphone/i }).waitFor({ timeout: 10000 });
await wait(pA, 1200);
await caption([pA], "2 · Camera permission denied → recovery screen");
mark("A", tA, 2, "Camera permission denied → recovery");
await click(pA, /allow camera and microphone/i);
await pA.getByRole("heading", { name: /can't use the camera/i }).waitFor({ timeout: 10000 });
await caption([pA], "2 · Camera permission denied → recovery screen");
await wait(pA, 2500);
await pA.mouse.wheel(0, 500);
await wait(pA, 2000);
const vA = await pA.video().path();
await ctxA.close();
await bA.close();

// ---------- segment B: fake camera granted, phone + HUD in one context (mock HUD mirrors via BroadcastChannel) ----------
const bB = await launch(["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"]);
const ctxB = await bB.newContext({ viewport: PHONE, permissions: ["camera", "microphone"], recordVideo: { dir: path.join(work, "b"), size: { width: 600, height: 844 } } });
const p = await ctxB.newPage();
const tB = Date.now();
const hud = await ctxB.newPage();
const hudOffset = (Date.now() - tB) / 1000;
await hud.setViewportSize(HUD);
await p.goto(`${base}/?mock=1`, { waitUntil: "networkidle" });
await hud.goto(`${base}/hud/?mock=1`, { waitUntil: "networkidle" });
const both = [p, hud];
// if the stored consent shape didn't match, walk the cards and permission step quickly
if (await p.getByRole("button", { name: /^continue$/i }).count()) {
  await click(p, /^continue$/i);
  for (let i = 0; i < 2; i++) (await wait(p, 300), await click(p, /^next$/i));
  await wait(p, 300);
  await click(p, /^i agree$/i);
}
// the permission step may skip itself because the camera is already granted
const allow = p.getByRole("button", { name: /allow camera and microphone/i });
await allow.or(p.locator(".bigbtn")).first().waitFor({ timeout: 10000 });
if (await allow.count()) await allow.click({ timeout: 3000 }).catch(() => {});
await p.locator(".bigbtn").waitFor({ timeout: 10000 });
// open the device panel so latency (RTT) and connection state are on screen
const panel = p.locator("details.panel");
if (!(await panel.evaluate((d) => d.open))) await p.getByText("Device state").click();

// 3: live check → coaching → verdict
await caption(both, "3 · Live check → coaching → verdict (device panel: RTT)");
mark("B", tB, 3, "Live check → coaching → verdict");
await p.locator(".bigbtn").click();
await p.locator(".bigbtn").scrollIntoViewIfNeeded();
await wait(p, 6000);
await p.getByText("RTT", { exact: true }).scrollIntoViewIfNeeded();
await wait(p, 4000);
await p.locator(".viewfinder").scrollIntoViewIfNeeded().catch(() => {});
await wait(p, 5000); // verdict lands ~12 s after start
await p.getByText("RTT", { exact: true }).scrollIntoViewIfNeeded();
await wait(p, 2500);

// 4: drop connection → snapshot → auto-reconnect
await caption(both, "4 · Drop connection → snapshot mode → auto-reconnect");
mark("B", tB, 4, "Drop connection → snapshot → auto-reconnect");
await p.getByText("Live socket", { exact: true }).scrollIntoViewIfNeeded();
await click(p, /^drop connection$/i);
await wait(p, 2500);
await p.evaluate(() => window.scrollTo(0, 0));
await wait(p, 2500);
await p.getByText("Live socket", { exact: true }).scrollIntoViewIfNeeded();
await p.waitForFunction(() => /Live/.test(document.querySelector(".chip.live")?.textContent ?? ""), null, { timeout: 20000 }).catch(() => {});
await wait(p, 2500);

// 5: offline → offline barcode banner → back online
await caption(both, "5 · Offline (network cut) → offline barcode banner");
mark("B", tB, 5, "Offline → offline barcode banner → back online");
await ctxB.setOffline(true);
await p.evaluate(() => window.scrollTo(0, 0));
await wait(p, 5000);
await caption(both, "5 · Back online → reconnecting");
await ctxB.setOffline(false);
await wait(p, 6000);

// 6: glasses taken off → phone camera fallback
await caption(both, "6 · Glasses on → taken off → phone camera fallback");
mark("B", tB, 6, "Glasses taken off → phone camera fallback");
await p.getByText("Glasses", { exact: true }).scrollIntoViewIfNeeded();
await click(p, /^glasses on$/i);
await wait(p, 800);
await p.getByRole("group", { name: "Camera source" }).getByRole("button").nth(1).click();
await p.locator(".viewfinder").scrollIntoViewIfNeeded().catch(() => {});
await wait(p, 3000);
await caption(both, "6 · Glasses taken off → switched to phone camera");
await click(p, /^glasses off face$/i);
await p.locator(".viewfinder").scrollIntoViewIfNeeded().catch(() => {});
await wait(p, 4500);

// 7: "Which one?" scene verdict
await caption(both, "7 · \"Which one?\": three boxes on a table → scene verdict");
mark("B", tB, 7, "\"Which one?\" scene verdict");
const ask = p.locator("#ask");
await ask.scrollIntoViewIfNeeded();
await ask.fill("Which one is my evening pill?");
await ask.press("Enter");
await wait(p, 9000);
await p.evaluate(() => window.scrollTo(0, 0));
await wait(p, 5500);
const verdictCard = p.locator(".verdict, [class*=verdict]").first();
await verdictCard.scrollIntoViewIfNeeded().catch(() => {});
await wait(p, 3500);
const endB = (Date.now() - tB) / 1000;
await caption(both, "End of reel");
await wait(p, 800);

const vPhone = await p.video().path();
const vHud = await hud.video().path();
await ctxB.close();
await bB.close();

// ---------- stitch: [A phone | blank] then [B phone | B HUD], one 990x844 webm ----------
const durA = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", vA]).toString().trim()) || 0;
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, "states-reel.webm");
const filter = [
  `[0:v]fps=25,pad=${W}:844:0:0:color=0x111111,setsar=1[a]`,
  `[1:v]fps=25,crop=${PHONE.width}:${PHONE.height}:0:0,setsar=1[ph]`,
  `[2:v]fps=25,crop=${HUD.width}:${HUD.height}:0:0,tpad=start_duration=${hudOffset.toFixed(2)}:color=0x111111,pad=${HUD.width}:844:0:122:color=0x111111,setsar=1[hd]`,
  `[ph][hd]hstack=inputs=2:shortest=1[b]`,
  `[a][b]concat=n=2:v=1:a=0[v]`,
].join(";");
execFileSync("ffmpeg", ["-y", "-v", "error", "-i", vA, "-i", vPhone, "-i", vHud, "-filter_complex", filter, "-map", "[v]", "-c:v", "libvpx-vp9", "-b:v", "900k", "-deadline", "good", "-cpu-used", "4", "-row-mt", "1", out], { stdio: "inherit" });
const durOut = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out]).toString().trim());
const sizeMb = fs.statSync(out).size / 1e6;

const fmt = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
const rows = states.map((s) => `| ${s.n} | ${s.name} | ${fmt(s.segment === "A" ? s.t : durA + s.t)} |`);
const md = `# HoldUp states reel

\`states-reel.webm\` (${fmt(durOut)}, ${sizeMb.toFixed(1)} MB, ${W}x844). Left: phone app at 390x844 (\`/?mock=1\`). Right: Display HUD at 600x600 (\`/hud/?mock=1\`), same browser context, so the mock HUD mirror shows the same check.
The yellow caption bar is injected by \`scripts/record-states.mjs\`; it is not part of the app. Everything runs in **mock mode** (scripted server, no Gemini calls), with Chromium's fake camera.

| # | State | Starts at |
|---|---|---|
${rows.join("\n")}

How each state is produced:
1. Consent: fresh profile, the welcome screen and three privacy cards, then "I agree".
2. Camera denied: a browser without camera permission (headless Chromium dismisses the prompt), so "Allow camera and microphone" fails and the recovery screen appears.
3. Live check: the big button starts the mock Live session; it coaches (turn around, left, closer, hold still) and gives a verdict. The device panel is open, with RTT and the live socket state.
4. "Drop connection" (device panel demo control): snapshot mode, then the socket reconnects by itself.
5. \`context.setOffline(true)\`: the offline banner (saved medicines by barcode only), then \`setOffline(false)\`: "Back online", reconnecting.
6. "Glasses on" + glasses camera source, then "Glasses off face": the source flips to the phone camera.
7. Typed "Which one is my evening pill?": the "Which one?" scene verdict.

Regenerate: \`npm run build && (PORT=8790 npm -w server run start &) && node scripts/record-states.mjs http://localhost:8790\`
Generated ${new Date().toISOString()}.
`;
fs.writeFileSync(path.join(outDir, "states-reel.md"), md);
fs.rmSync(work, { recursive: true, force: true });
console.log(JSON.stringify({ out, seconds: durOut, mb: +sizeMb.toFixed(2), segmentA: durA, segmentB: endB, states }, null, 2));
