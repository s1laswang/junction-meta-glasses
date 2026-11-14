import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "../src/env.ts";
import { PHRASES } from "../scripts/prerender-phrases.ts";
import { cuePhraseId, verdictPhraseId } from "../../web/src/lib/phrases.ts";
import type { CoachCue, Verdict } from "../../shared/types.ts";

const EXPECTED_IDS = [
  "offline",
  "back_online",
  "not_sure",
  "unknown_offline",
  "already_taken",
  "glasses_off",
  "camera_off",
  "cue_closer",
  "cue_further",
  "cue_rotate",
  "cue_tilt",
  "cue_more_light",
  "cue_steady",
  "cue_reading",
];

const LANGS = ["en", "fi", "sv"];

test("PHRASES covers all 14 safety and coaching IDs in en, fi, sv with zero em dashes", () => {
  for (const id of EXPECTED_IDS) {
    assert.ok(PHRASES[id], `missing phrase id ${id}`);
    for (const lang of LANGS) {
      const text = PHRASES[id][lang];
      assert.equal(typeof text, "string", `missing ${lang} text for ${id}`);
      assert.ok(text.length >= 6, `short ${lang} text for ${id}`);
      assert.equal(text.includes("\u2014"), false, `em dash in ${lang}/${id}`);
    }
  }
});

test("cuePhraseId maps every CoachCue and verdictPhraseId maps safety verdicts", () => {
  const cues: CoachCue[] = ["rotate_left", "rotate_right", "closer", "farther", "more_light", "hold_still", "other_side", "ok"];
  for (const c of cues) {
    const id = cuePhraseId(c);
    assert.ok(id && PHRASES[id], `unmapped cue ${c} -> ${id}`);
  }
  assert.equal(cuePhraseId("hold_still", "Hold still, reading"), "cue_reading");
  assert.equal(cuePhraseId("ok", "Camera stopped"), "camera_off");

  const baseRead = {} as Verdict["read"];
  const unsure: Verdict = { level: "unsure", headline: "Can't read strength", speech: "I'm not sure.", reasons: [], read: baseRead };
  assert.equal(verdictPhraseId(unsure, "snapshot"), "not_sure");
  const taken: Verdict = { level: "warning", headline: "Amlodipine already taken today", speech: "You already took Amlodipine today.", reasons: [], read: baseRead };
  assert.equal(verdictPhraseId(taken, "offline"), "already_taken");
  const unknownOff: Verdict = { level: "unsure", headline: "Not one of your saved barcodes", speech: "Not saved.", reasons: [], read: baseRead };
  assert.equal(verdictPhraseId(unknownOff, "offline"), "unknown_offline");
});

test("web/public/phrases/manifest.json and all 42 EN/FI/SV audio clips exist with valid audio headers under 2 MB", () => {
  const pubDir = path.join(REPO_ROOT, "web", "public");
  const phrasesDir = path.join(pubDir, "phrases");
  const manifestPath = path.join(phrasesDir, "manifest.json");
  assert.equal(fs.existsSync(manifestPath), true, "manifest.json must exist");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    model: string;
    generated: string;
    phrases: Record<string, Record<string, { file: string; text: string }>>;
  };
  assert.ok(manifest.model.length > 0);
  let count = 0;
  let totalBytes = 0;
  for (const lang of LANGS) {
    assert.ok(manifest.phrases[lang], `manifest missing lang ${lang}`);
    for (const id of EXPECTED_IDS) {
      const entry = manifest.phrases[lang][id];
      assert.ok(entry, `manifest missing ${lang}/${id}`);
      assert.equal(entry.text, PHRASES[id][lang]);
      const rel = entry.file.replace(/^\//, "");
      const diskPath = path.join(pubDir, rel);
      assert.equal(fs.existsSync(diskPath), true, `missing clip ${diskPath}`);
      const buf = fs.readFileSync(diskPath);
      assert.ok(buf.length > 1024, `clip too small: ${diskPath} (${buf.length} B)`);
      totalBytes += buf.length;
      if (diskPath.endsWith(".wav")) {
        assert.equal(buf.subarray(0, 4).toString("ascii"), "RIFF");
        assert.equal(buf.subarray(8, 12).toString("ascii"), "WAVE");
      } else {
        const isId3 = buf.subarray(0, 3).toString("ascii") === "ID3";
        const isSync = buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0;
        assert.equal(isId3 || isSync, true, `invalid mp3 header in ${diskPath}`);
      }
      count++;
    }
  }
  assert.equal(count, 42);
  const manifestBytes = fs.statSync(manifestPath).size;
  assert.ok(totalBytes + manifestBytes < 2 * 1024 * 1024, `phrases total ${totalBytes + manifestBytes} B exceeds 2 MB`);
});
