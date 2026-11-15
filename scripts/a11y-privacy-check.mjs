// Quick axe check of the Privacy and Profile tabs plus a Stop-bar overlap check at 390x844 (mock mode).
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const base = process.argv[2] ?? "http://localhost:8799";
const cache = path.join(os.homedir(), "Library/Caches/ms-playwright");
const exe = fs.readdirSync(cache).filter((d) => d.startsWith("chromium-")).sort().reverse()
  .map((d) => path.join(cache, d, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing")).find((p) => fs.existsSync(p));
const browser = await chromium.launch({ headless: true, executablePath: exe });
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
await page.goto(`${base}/?mock=1`, { waitUntil: "networkidle" });
await page.evaluate((v) => localStorage.setItem("holdup.consent", JSON.stringify({ version: v, ts: Date.now() })), Number(process.env.CV ?? 1));
await page.reload({ waitUntil: "networkidle" });
for (let i = 0; i < 6; i++) { const b = page.getByRole("button", { name: /agree|continue|next|get started|load demo/i }).first(); if (!(await b.count())) break; await b.click().catch(() => {}); await page.waitForTimeout(400); }
const tabs = await page.locator("nav button, nav a, [role=tab]").allInnerTexts();
console.log("tabs:", JSON.stringify(tabs));
for (const name of ["Privacy", "Profile"]) {
  const t = page.locator("nav button, nav a, [role=tab]").filter({ hasText: new RegExp(name, "i") }).first();
  if (!(await t.count())) { console.log("no tab", name); continue; }
  await t.click(); await page.waitForTimeout(500);
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  for (const v of r.violations) console.log(name, v.id, v.impact, v.nodes.map((n) => n.target.join(" ") + " :: " + (n.failureSummary || "").replace(/\s+/g, " ").slice(0, 300)).slice(0, 2).join(" | "));
  if (!r.violations.length) console.log(name, "0 violations");
}
await browser.close();
