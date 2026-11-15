// Screenshot deck slides at 1280x720 and report overflow: node scripts/deck-shots.mjs [slideNumbers...]
import { chromium } from "playwright";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { pathToFileURL } from "node:url";
const out = "/tmp/holdup-shots"; fs.mkdirSync(out, { recursive: true });
const cache = path.join(os.homedir(), "Library/Caches/ms-playwright");
const exe = fs.readdirSync(cache).filter((d) => d.startsWith("chromium-")).sort().reverse()
  .map((d) => path.join(cache, d, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing")).find((p) => fs.existsSync(p));
const browser = await chromium.launch({ headless: true, executablePath: exe });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
const url = pathToFileURL(path.resolve("deck/index.html")).href;
await page.goto(url, { waitUntil: "networkidle" });
const total = await page.locator("section.slide").count();
const want = process.argv.slice(2).map(Number).filter(Boolean);
const report = [];
for (let n = 1; n <= total; n++) {
  await page.goto(`${url}#${n}`); await page.reload({ waitUntil: "networkidle" }); await page.waitForTimeout(250);
  const h = await page.locator("section.slide").nth(n - 1).evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
  report.push(`${n}:${h.scroll}/${h.client}${h.scroll > h.client + 1 ? " OVERFLOW" : ""}`);
  if (want.includes(n)) await page.screenshot({ path: `${out}/deck-${n}.png` });
}
console.log(report.join("  "));
await browser.close();
