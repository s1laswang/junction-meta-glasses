// Screenshots of the three layout problems the judge panel reported (mock mode). Usage: node scripts/shots.mjs [base] [outDir]
import { chromium } from "playwright";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const base = process.argv[2] ?? "http://localhost:8799";
const out = process.argv[3] ?? "/tmp/holdup-shots";
fs.mkdirSync(out, { recursive: true });
const cache = path.join(os.homedir(), "Library/Caches/ms-playwright");
const exe = fs.readdirSync(cache).filter((d) => d.startsWith("chromium-")).sort().reverse()
  .map((d) => path.join(cache, d, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing")).find((p) => fs.existsSync(p));
const browser = await chromium.launch({ headless: true, executablePath: exe, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ["camera", "microphone"] });
const page = await ctx.newPage();
await page.goto(`${base}/?mock=1`, { waitUntil: "networkidle" });
await page.evaluate(() => localStorage.setItem("holdup.consent", JSON.stringify({ version: 1, ts: Date.now() })));
await page.reload({ waitUntil: "networkidle" });
// Privacy tab: what covers the first feature switch?
await page.locator("nav.tabs button").filter({ hasText: /Privacy/ }).click();
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/privacy.png` });
const info = await page.evaluate(() => {
  const el = document.querySelector('input[aria-describedby="feat-scene"]');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const pts = [[r.left + r.width / 2, r.top + 2], [r.left + r.width / 2, r.top + r.height / 2], [r.left + r.width / 2, r.bottom - 2]];
  return { rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
    hits: pts.map(([x, y]) => { const e = document.elementFromPoint(x, y); return e ? `${e.tagName.toLowerCase()}.${(e.className || "").toString().split(" ")[0]}` : "none"; }) };
});
console.log("privacy feat-scene:", JSON.stringify(info));
// Check tab: run the mock until a verdict shows, then see whether the Start/Stop bar covers the verdict buttons
await page.locator("nav.tabs button").filter({ hasText: /Check/ }).click();
await page.waitForTimeout(300);
const start = page.getByRole("button", { name: /start/i }).first();
if (await start.count()) await start.click().catch(() => {});
await page.waitForTimeout(800);
const box = page.getByPlaceholder(/evening pill/i).first();
if (await box.count()) { await box.fill("is this my evening pill"); await page.getByRole("button", { name: /^ask$/i }).click().catch(() => {}); }
await page.waitForSelector("section.verdict", { timeout: 40000 }).catch(() => console.log("no verdict appeared"));
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/check-verdict.png` });
const cover = await page.evaluate(() => {
  const bar = document.querySelector(".bigbtn-wrap"); const res = [];
  if (!bar) return "no .bigbtn-wrap";
  const br = bar.getBoundingClientRect();
  for (const b of document.querySelectorAll("section.verdict .actions button")) {
    const r = b.getBoundingClientRect();
    res.push({ text: b.textContent.trim().slice(0, 16), top: Math.round(r.top), bottom: Math.round(r.bottom), covered: r.bottom > br.top && r.top < br.bottom });
  }
  return { barTop: Math.round(br.top), barBottom: Math.round(br.bottom), buttons: res, scrollH: document.documentElement.scrollHeight, vh: innerHeight };
});
console.log("check verdict:", JSON.stringify(cover));
// Stage view
for (const [w, h] of [[1024, 576], [1920, 1080]]) {
  const st = await (await browser.newContext({ viewport: { width: w, height: h } })).newPage();
  await st.goto(`${base}/stage?mock=1`, { waitUntil: "networkidle" });
  await st.waitForTimeout(9000);
  await st.screenshot({ path: `${out}/stage-${w}.png` });
  await st.close();
}
const stage = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
await stage.goto(`${base}/stage?mock=1`, { waitUntil: "networkidle" });
await stage.waitForTimeout(9000);
await stage.screenshot({ path: `${out}/stage.png` });
const clip = await stage.evaluate(() => [...document.querySelectorAll("*")].filter((e) => e.children.length === 0 && e.scrollWidth > e.clientWidth + 2 && getComputedStyle(e).overflow !== "visible" && e.textContent.trim().length > 3)
  .slice(0, 8).map((e) => ({ cls: (e.className || "").toString().slice(0, 40), text: e.textContent.trim().slice(0, 50), sw: e.scrollWidth, cw: e.clientWidth })));
console.log("stage clipped:", JSON.stringify(clip));
await browser.close();
