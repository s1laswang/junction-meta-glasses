import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SHORTCUT_LEGEND } from "../src/a11y/shortcuts.ts";
import {
  ShortcutsModal,
  bindEscapeToClose,
  getOrientationSpeech,
  playOrientationSpeech
} from "../src/components/ShortcutsModal.tsx";

type TestFn = (name: string, fn: () => void | Promise<void>) => Promise<void>;

type AssertStrict = {
  ok(value: unknown, message?: string): void;
  equal<T>(actual: T, expected: T, message?: string): void;
  notEqual<T>(actual: T, expected: T, message?: string): void;
  deepEqual<T>(actual: T, expected: T, message?: string): void;
};

const nodeTestSpec: string = "node:test";
const nodeAssertSpec: string = "node:assert/strict";

const { test } = (await import(nodeTestSpec)) as { test: TestFn };
const assert = (await import(nodeAssertSpec)) as AssertStrict;

const EM_DASH = "\u2014";
const EN_DASH = "\u2013";

function extractKbdValues(html: string): string[] {
  const keys: string[] = [];
  const pattern = /<kbd[^>]*>([^<]+)<\/kbd>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    keys.push(match[1]);
  }
  return keys;
}

function countSentences(text: string): number {
  return text
    .split(/[.!?]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0).length;
}

test("getOrientationSpeech returns distinct 2-3 sentence guidance in en, fi, sv with fallback and zero em dashes", () => {
  const en = getOrientationSpeech("en");
  const fi = getOrientationSpeech("fi");
  const sv = getOrientationSpeech("sv");

  for (const [locale, speech] of [
    ["en", en],
    ["fi", fi],
    ["sv", sv]
  ] as const) {
    assert.ok(speech.trim().length > 40, `${locale} orientation speech too short`);
    assert.equal(speech.includes(EM_DASH), false, `${locale} contained em dash`);
    assert.equal(speech.includes(EN_DASH), false, `${locale} contained en dash`);
    const sentences = countSentences(speech);
    assert.ok(
      sentences >= 2 && sentences <= 3,
      `${locale} expected 2-3 sentences, got ${sentences}`
    );
    assert.ok(speech.includes("L"), `${locale} should mention L shortcut`);
    assert.ok(speech.includes("R"), `${locale} should mention R shortcut`);
  }

  assert.notEqual(en, fi);
  assert.notEqual(en, sv);
  assert.notEqual(fi, sv);

  assert.equal(getOrientationSpeech("en-US"), en);
  assert.equal(getOrientationSpeech("fi-FI"), fi);
  assert.equal(getOrientationSpeech("FI_FI"), fi);
  assert.equal(getOrientationSpeech("sv-SE"), sv);
  assert.equal(getOrientationSpeech("sv-FI"), sv);

  assert.equal(getOrientationSpeech("de"), en);
  assert.equal(getOrientationSpeech("unknown"), en);
  assert.equal(getOrientationSpeech(""), en);
});

test("ShortcutsModal returns empty markup when closed and accessible role=dialog when open", () => {
  const closedHtml = renderToStaticMarkup(
    createElement(ShortcutsModal, {
      open: false,
      lang: "en",
      muted: false,
      onClose: () => {}
    })
  );
  assert.equal(closedHtml, "");

  const openHtml = renderToStaticMarkup(
    createElement(ShortcutsModal, {
      open: true,
      lang: "en",
      muted: false,
      onClose: () => {}
    })
  );

  assert.ok(openHtml.includes('role="dialog"'));
  assert.ok(openHtml.includes('aria-modal="true"'));
  assert.ok(openHtml.includes('aria-labelledby="shortcuts-dialog-title"'));
  assert.ok(openHtml.includes('id="shortcuts-dialog-title"'));
  assert.equal(openHtml.includes(EM_DASH), false);
  assert.equal(openHtml.includes(EN_DASH), false);
});

test("ShortcutsModal renders all 7 shortcut keys in <kbd> and localized descriptions in en, fi, sv", () => {
  const expectedKeys = SHORTCUT_LEGEND.map((item) => item.key);
  assert.deepEqual(expectedKeys, ["Space", "S", "B", "L", "R", "T", "P"]);

  const enHtml = renderToStaticMarkup(
    createElement(ShortcutsModal, {
      open: true,
      lang: "en",
      muted: false,
      onClose: () => {}
    })
  );
  const fiHtml = renderToStaticMarkup(
    createElement(ShortcutsModal, {
      open: true,
      lang: "fi",
      muted: false,
      onClose: () => {}
    })
  );
  const svHtml = renderToStaticMarkup(
    createElement(ShortcutsModal, {
      open: true,
      lang: "sv",
      muted: false,
      onClose: () => {}
    })
  );

  assert.deepEqual(extractKbdValues(enHtml), expectedKeys);
  assert.deepEqual(extractKbdValues(fiHtml), expectedKeys);
  assert.deepEqual(extractKbdValues(svHtml), expectedKeys);

  for (const item of SHORTCUT_LEGEND) {
    assert.ok(enHtml.includes(item.description), `missing en description for ${item.key}`);
  }

  assert.notEqual(enHtml, fiHtml);
  assert.notEqual(enHtml, svHtml);
  assert.notEqual(fiHtml, svHtml);

  for (const html of [enHtml, fiHtml, svHtml]) {
    assert.equal(html.includes(EM_DASH), false);
    assert.equal(html.includes(EN_DASH), false);
  }
});

test("ShortcutsModal includes Meta Ray-Ban & Neural Band instructions and >= 56px Orientation and Close buttons", () => {
  const unmutedHtml = renderToStaticMarkup(
    createElement(ShortcutsModal, {
      open: true,
      lang: "en",
      muted: false,
      onClose: () => {}
    })
  );

  assert.ok(unmutedHtml.includes("Meta Ray-Ban &amp; Neural Band Controls"));
  assert.ok(unmutedHtml.includes("Capture button / voice ask"));
  assert.ok(unmutedHtml.includes("Thumb swipe left/right"));
  assert.ok(unmutedHtml.includes("Left / Right"));
  assert.ok(unmutedHtml.includes("Index pinch to confirm"));
  assert.ok(unmutedHtml.includes("Pinch / Enter"));
  assert.ok(unmutedHtml.includes("System back"));
  assert.ok(unmutedHtml.includes("Back / Escape"));

  assert.ok(unmutedHtml.includes("Play Spoken Orientation"));
  assert.ok(unmutedHtml.includes(">Close</button>"));

  const minHeightMatches = unmutedHtml.match(/min-height:56px/g) ?? [];
  assert.ok(minHeightMatches.length >= 2, "both Play Spoken Orientation and Close must be >= 56px");
  assert.ok(unmutedHtml.includes('aria-disabled="false"'));

  const mutedHtml = renderToStaticMarkup(
    createElement(ShortcutsModal, {
      open: true,
      lang: "en",
      muted: true,
      onClose: () => {}
    })
  );
  assert.ok(mutedHtml.includes('aria-disabled="true"'));
  assert.ok(mutedHtml.includes("disabled"));
});

test("bindEscapeToClose closes on Escape and playOrientationSpeech respects muted and preferServerTts=false", async () => {
  let captured: ((ev: KeyboardEvent) => void) | null = null;
  const host = {
    addEventListener(_type: "keydown", fn: (ev: KeyboardEvent) => void) {
      captured = fn;
    },
    removeEventListener(_type: "keydown", fn: (ev: KeyboardEvent) => void) {
      if (captured === fn) {
        captured = null;
      }
    }
  };

  let closedCount = 0;
  let preventedCount = 0;
  const detach = bindEscapeToClose(() => {
    closedCount += 1;
  }, { enabled: true, host });

  const emitKey = (key: string, defaultPrevented = false) => {
    captured?.({
      key,
      defaultPrevented,
      preventDefault() {
        preventedCount += 1;
      }
    } as unknown as KeyboardEvent);
  };

  assert.notEqual(captured, null);

  emitKey("Enter");
  assert.equal(closedCount, 0);

  emitKey("Escape", true);
  assert.equal(closedCount, 0);
  assert.equal(preventedCount, 0);

  emitKey("Escape");
  assert.equal(closedCount, 1);
  assert.equal(preventedCount, 1);

  detach();
  assert.equal(captured, null);

  const g = globalThis as Record<string, unknown>;
  const prevWindow = g.window;
  const prevFetch = g.fetch;
  const spoken: Array<{ text: string; lang: string }> = [];
  let fetchCalled = 0;

  class MockUtterance {
    text: string;
    lang = "";
    voice: unknown = null;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(text = "") {
      this.text = text;
    }
  }

  g.fetch = async () => {
    fetchCalled += 1;
    throw new Error("server TTS should not be called when preferServerTts is false");
  };
  g.window = {
    navigator: { onLine: true },
    SpeechSynthesisUtterance: MockUtterance,
    speechSynthesis: {
      speaking: false,
      cancel() {},
      getVoices() {
        return [];
      },
      speak(u: MockUtterance) {
        spoken.push({ text: u.text, lang: u.lang });
        u.onend?.();
      }
    }
  };

  try {
    await playOrientationSpeech("fi", true);
    assert.equal(spoken.length, 0);
    assert.equal(fetchCalled, 0);

    await playOrientationSpeech("fi", false);
    assert.equal(fetchCalled, 0);
    assert.equal(spoken.length, 1);
    assert.deepEqual(spoken[0], {
      text: getOrientationSpeech("fi"),
      lang: "fi-FI"
    });

    await playOrientationSpeech("sv", false);
    assert.equal(spoken.length, 2);
    assert.deepEqual(spoken[1], {
      text: getOrientationSpeech("sv"),
      lang: "sv-SE"
    });
  } finally {
    delete g.window;
    delete g.fetch;
    if (prevWindow !== undefined) g.window = prevWindow;
    if (prevFetch !== undefined) g.fetch = prevFetch;
  }
});
