import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../src/env.ts";
import { leadFor, speakInstruction, VERDICT_LEAD } from "../src/live.ts";
import { PHRASES } from "../scripts/prerender-phrases.ts";

test("FI/SV verdicts start with a fixed, human-written opener for every level", () => {
  for (const lang of ["fi", "sv", "FI", "SV", "fi-FI", "sv-SE"]) {
    const code = lang.toLowerCase().slice(0, 2);
    for (const level of ["match", "warning", "unsure", "info"] as const) {
      const l = leadFor(lang, level).lead;
      assert.ok(l && l.length > 0, `${lang}/${level}`);
      assert.equal(l, VERDICT_LEAD[code][level]);
    }
    assert.match(speakInstruction(lang, ""), /First say `lead` exactly/);
    assert.match(speakInstruction(lang, ""), /decimal comma like 2,5 mg/);
  }
  assert.equal(leadFor("fi", "match").lead, "Oikea pakkaus.");
  assert.equal(leadFor("fi", "warning").lead, "Varoitus.");
  assert.equal(leadFor("fi", "unsure").lead, "En ole varma.");
  assert.equal(leadFor("fi", "info").lead, "Tiedoksi.");
  assert.equal(leadFor("sv-SE", "match").lead, "Rätt förpackning.");
  assert.equal(leadFor("sv-SE", "warning").lead, "Varning.");
  assert.equal(leadFor("sv-SE", "unsure").lead, "Jag är inte säker.");
  assert.equal(leadFor("sv-SE", "info").lead, "För kännedom.");
});

test("English needs no opener and keeps word-for-word speech", () => {
  assert.deepEqual(leadFor("en", "match"), {});
  assert.deepEqual(leadFor("EN-US", "warning"), {});
  assert.match(speakInstruction("en", "x"), /^Say `speech` word for word/);
});

test("prerender-phrases.ts PHRASES and web/public/phrases/manifest.json stay in exact EN/FI/SV parity", () => {
  const manifestPath = path.join(REPO_ROOT, "web", "public", "phrases", "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    phrases: Record<string, Record<string, { file: string; text: string }>>;
  };
  const expectedIds = ["offline", "back_online", "not_sure", "unknown_offline", "already_taken", "glasses_off", "camera_off"];
  assert.deepEqual(Object.keys(PHRASES), expectedIds);

  for (const id of expectedIds) {
    for (const lang of ["en", "fi", "sv"] as const) {
      const text = PHRASES[id][lang];
      assert.ok(text && text.length >= 10, `Missing ${lang}/${id}`);
      assert.equal(manifest.phrases[lang][id].text, text, `manifest.json out of sync for ${lang}/${id}`);
      assert.equal(manifest.phrases[lang][id].file, `/phrases/${lang}/${id}.mp3`);
    }
  }
});
