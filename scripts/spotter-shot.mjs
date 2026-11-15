// End-to-end look at the dose finder: real server (SPOTTER=1), Chrome's fake camera fed with a label image.
// Usage: SPOTTER=1 PORT=8799 npm -w server run start &   then   node scripts/spotter-shot.mjs [base] [image.jpg]
import { chromium } from "playwright";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const base = process.argv[2] ?? "http://localhost:8799";
const image = process.argv[3] ?? "server/fixtures/amlodipine.jpg";
const out = "/tmp/holdup-shots"; fs.mkdirSync(out, { recursive: true });
const mjpeg = path.join(os.tmpdir(), "holdup-fake-camera.mjpeg");
// One image: a one-frame MJPEG loops as the camera feed. Two images (argv[4]): about 6 s of the first, then
// about 10 s of the second (Chrome plays the file at ~30 fps), e.g. dose visible, then dose covered by a thumb.
const second = process.argv[4];
if (second) {
  const a = fs.readFileSync(image), b = fs.readFileSync(second);
  fs.writeFileSync(mjpeg, Buffer.concat([...Array(180).fill(a), ...Array(300).fill(b)]));
} else fs.copyFileSync(image, mjpeg);
const cache = path.join(os.homedir(), "Library/Caches/ms-playwright");
const exe = fs.readdirSync(cache).filter((d) => d.startsWith("chromium-")).sort().reverse()
  .map((d) => path.join(cache, d, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing")).find((p) => fs.existsSync(p));
const browser = await chromium.launch({ headless: true, executablePath: exe, args: [
  "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required",
  "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${mjpeg}`] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ["camera", "microphone"] });
const page = await ctx.newPage();
const seen = { fields: 0, coach: [], say: [] };
page.on("websocket", (ws) => ws.on("framereceived", (f) => {
  try { const m = JSON.parse(f.payload); if (m.type === "fields") seen.fields++; if (m.type === "coach") { seen.coach.push(m.text); if (m.say) seen.say.push(m.text); } } catch {}
}));
await page.goto(`${base}/`, { waitUntil: "networkidle" });
await page.evaluate(() => localStorage.setItem("holdup.consent", JSON.stringify({ version: 1, ts: Date.now() })));
await page.reload({ waitUntil: "networkidle" });
const allow = page.getByRole("button", { name: /allow camera and microphone/i });
if (await allow.count()) await allow.click().catch(() => {});
await page.locator(".bigbtn").waitFor({ timeout: 15000 });
await page.locator(".bigbtn").click();
await page.waitForTimeout(second ? 20000 : 9000);
await page.screenshot({ path: `${out}/spotter-live.png` });
const boxes = await page.locator(".field-box").evaluateAll((els) => els.map((e) => e.className + " " + e.textContent));
console.log(JSON.stringify({ fieldsMessages: seen.fields, boxesOnScreen: boxes, coach: seen.coach, spokenCues: seen.say }));
await page.locator(".bigbtn").click().catch(() => {});
await browser.close();
