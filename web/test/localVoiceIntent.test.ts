import {
  normalizeIntentPhrase,
  parseLocalIntent,
  type LocalCommandIntent
} from "../src/session/localVoiceIntent.ts";

type TestFn = (name: string, fn: () => void | Promise<void>) => Promise<void>;

interface StrictAssert {
  ok(value: unknown, message?: string): void;
  equal<T>(actual: T, expected: T, message?: string): void;
  notEqual<T>(actual: T, expected: T, message?: string): void;
  deepEqual<T>(actual: T, expected: T, message?: string): void;
}

const nodeTestSpec: string = "node:test";
const nodeAssertSpec: string = "node:assert/strict";
const { test } = (await import(nodeTestSpec)) as { test: TestFn };
const { default: assert } = (await import(nodeAssertSpec)) as { default: StrictAssert };

test("parseLocalIntent matches log_dose phrases across EN, FI, and SV with case, punctuation, and diacritic variations", () => {
  const phrases = [
    "i took it",
    "I took it.",
    "  I TOOK IT!! ",
    "took it",
    "log dose",
    "Log dose!",
    "mark as taken",
    "I've taken it.",
    "Please log dose",
    "otin sen",
    "Otin sen!",
    "otin laakkeen",
    "otin lääkkeen",
    "OTIN LÄÄKKEEN.",
    "otin la\u0308a\u0308kkeen",
    "Otin sen, kiitos.",
    "kirjaa annos",
    "Kirjaa otettu annos",
    "Annos otettu",
    "Lääke otettu",
    "jag tog den",
    "Jag tog den!",
    "Jag tog den, tack",
    "logga dos",
    "Registrera tagen dos",
    "Dosen tagen"
  ];

  for (const phrase of phrases) {
    const intent: LocalCommandIntent = parseLocalIntent(phrase);
    assert.deepEqual(intent, { kind: "log_dose" }, `Expected log_dose for: ${phrase}`);
  }
});

test("parseLocalIntent matches repeat phrases across EN, FI, and SV", () => {
  const phrases = [
    "repeat",
    "Repeat!",
    "say again",
    "say that again",
    "Say that again, please.",
    "Repeat last answer",
    "toista",
    "Toista, kiitos",
    "sano uudelleen",
    "Toista viimeisin vastaus",
    "upprepa",
    "säg igen",
    "sag igen",
    "SÄG IGEN!",
    "Snälla upprepa"
  ];

  for (const phrase of phrases) {
    assert.deepEqual(parseLocalIntent(phrase), { kind: "repeat" }, `Expected repeat for: ${phrase}`);
  }
});

test("parseLocalIntent matches stop phrases across EN, FI, and SV", () => {
  const phrases = [
    "stop",
    "STOP!",
    "stop camera",
    "Stop camera.",
    "cancel",
    "Stop check",
    "lopeta",
    "Lopeta tarkistus",
    "pysäytä kamera",
    "pysayta kamera",
    "PYSÄYTÄ KAMERA!",
    "stoppa",
    "Stoppa kontroll",
    "avbryt",
    "Avbryt!"
  ];

  for (const phrase of phrases) {
    assert.deepEqual(parseLocalIntent(phrase), { kind: "stop" }, `Expected stop for: ${phrase}`);
  }
});

test("parseLocalIntent matches scan_barcode phrases across EN, FI, and SV", () => {
  const phrases = [
    "scan barcode",
    "Scan barcode!",
    "check barcode",
    "Scan barcode offline",
    "lue viivakoodi",
    "Lue viivakoodi.",
    "Lue viivakoodi ilman verkkoa",
    "skanna streckkod",
    "Skanna streckkod offline",
    "läs streckkod"
  ];

  for (const phrase of phrases) {
    assert.deepEqual(
      parseLocalIntent(phrase),
      { kind: "scan_barcode" },
      `Expected scan_barcode for: ${phrase}`
    );
  }
});

test("parseLocalIntent classifies medication questions and negations as question, NEVER log_dose", () => {
  const questions = [
    "Did I take my evening pill?",
    "did i take it today?",
    "did i take it today",
    "Can I take this?",
    "can i take this",
    "Have I taken my pill?",
    "have i taken it",
    "Should I stop taking this?",
    "Took it?",
    "I took it?",
    "I didn't take it",
    "I have not taken it",
    "Olenko ottanut iltalääkkeen?",
    "olenko ottanut iltalaakkeen",
    "onko tama otettu?",
    "Onko tämä otettu?",
    "onko tama otettu",
    "onko annos otettu",
    "is the dose taken",
    "är dosen tagen",
    "Otinko sen?",
    "otinko sen",
    "Otinko lääkkeen",
    "Otin sen?",
    "Voinko ottaa tämän?",
    "En ottanut sitä",
    "Har jag tagit min kvällsmedicin?",
    "har jag tagit den",
    "Tog jag den?",
    "tog jag den",
    "Jag tog den?",
    "Kan jag ta den här?",
    "Jag tog inte den",
    "Is this my evening pill?",
    "Does this contain nuts?",
    "Where is the barcode?"
  ];

  for (const q of questions) {
    const result = parseLocalIntent(`  ${q}  `);
    assert.notEqual(result.kind, "log_dose", `Must never classify as log_dose: ${q}`);
    assert.deepEqual(result, { kind: "question", text: q }, `Expected question for: ${q}`);
  }
});

test("normalizeIntentPhrase folds Nordic diacritics and handles empty or whitespace input safely", () => {
  assert.equal(normalizeIntentPhrase("  Pysäytä kamera! "), "pysayta kamera");
  assert.equal(normalizeIntentPhrase("Säg igen, tack!"), "sag igen");
  assert.equal(normalizeIntentPhrase("ÅÄÖ åäö æø"), "aao aao aeo");
  assert.deepEqual(parseLocalIntent(""), { kind: "question", text: "" });
  assert.deepEqual(parseLocalIntent("   "), { kind: "question", text: "" });
  assert.deepEqual(parseLocalIntent("???"), { kind: "question", text: "???" });
});
