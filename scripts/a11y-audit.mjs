// axe-core WCAG 2.2 AA audit of the phone app and the Display HUD (mock mode, no Gemini needed).
// Usage: npm run build && (npm -w server run start &) && node scripts/a11y-audit.mjs [baseUrl] > docs/evidence/a11y-axe.json
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const base = process.argv[2] ?? "http://localhost:8787";
const cache = path.join(os.homedir(), "Library/Caches/ms-playwright");
const exe = fs.existsSync(cache)
  ? fs.readdirSync(cache).filter((d) => d.startsWith("chromium-")).sort().reverse()
      .map((d) => path.join(cache, d, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"))
      .find((p) => fs.existsSync(p))
  : undefined;

const browser = await chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : {}) });
const results = [];
async function audit(page, label) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  results.push({
    label, url: page.url(),
    violations: r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length })),
    passes: r.passes.length, incomplete: r.incomplete.length,
  });
}

// phone app at 390x844, walking through onboarding with the visible primary buttons
const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
await phone.goto(`${base}/?mock=1`, { waitUntil: "networkidle" });
await audit(phone, "phone: first screen");
for (let i = 1; i <= 5; i++) {
  const btn = phone.getByRole("button", { name: /agree|continue|next|get started|start|load demo/i }).first();
  if (!(await btn.count())) break;
  await btn.click().catch(() => {});
  await phone.waitForTimeout(600);
  await audit(phone, `phone: after step ${i}`);
}
for (const tab of ["Profile", "Privacy"]) {
  const t = phone.getByRole("button", { name: new RegExp(`^${tab}`, "i") }).or(phone.getByRole("link", { name: new RegExp(`^${tab}`, "i") })).or(phone.getByRole("tab", { name: new RegExp(`^${tab}`, "i") })).first();
  if (await t.count()) { await t.click().catch(() => {}); await phone.waitForTimeout(500); await audit(phone, `phone: ${tab}`); }
}

// HUD at the Ray-Ban Display size
const hud = await (await browser.newContext({ viewport: { width: 600, height: 600 } })).newPage();
await hud.goto(`${base}/hud/?mock=1`, { waitUntil: "networkidle" });
await hud.waitForTimeout(4500); // let the mock cycle show a verdict
await audit(hud, "hud: verdict");

await browser.close();
const total = results.reduce((n, r) => n + r.violations.reduce((m, v) => m + v.nodes, 0), 0);
console.log(JSON.stringify({ tool: "axe-core via @axe-core/playwright", tags: "WCAG 2.0/2.1/2.2 A+AA", base, when: new Date().toISOString(), totalViolationNodes: total, results }, null, 2));
