import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  INITIAL_ANNOUNCEMENT_STATE,
  ScreenReaderAnnouncer,
  nextAnnouncementState
} from "../src/a11y/announcer.tsx";
import {
  SHORTCUT_LEGEND,
  bindShortcutListener,
  resolveShortcut,
  type ShortcutAction
} from "../src/a11y/shortcuts.ts";

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

function extractSlotContents(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const pattern = /data-announcer-slot="([^"]+)">([^<]*)</g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    out[match[1]] = match[2];
  }
  return out;
}

test("nextAnnouncementState alternates slots and clears inactive slot across 3 identical repeats", () => {
  const verdict = "Yes, evening pill. Amlodipine 5 mg.";
  const s0 = { slot: 0 as 0 | 1, a: "previous", b: "" };

  const s1 = nextAnnouncementState(s0, verdict);
  assert.deepEqual(s1, { slot: 1, a: "", b: verdict });
  assert.deepEqual(s0, { slot: 0, a: "previous", b: "" });

  const s2 = nextAnnouncementState(s1, verdict);
  assert.deepEqual(s2, { slot: 0, a: verdict, b: "" });

  const s3 = nextAnnouncementState(s2, verdict);
  assert.deepEqual(s3, { slot: 1, a: "", b: verdict });

  const fromInitial1 = nextAnnouncementState(INITIAL_ANNOUNCEMENT_STATE, verdict);
  assert.deepEqual(fromInitial1, { slot: 0, a: verdict, b: "" });
  const fromInitial2 = nextAnnouncementState(fromInitial1, verdict);
  assert.deepEqual(fromInitial2, { slot: 1, a: "", b: verdict });
  const fromInitial3 = nextAnnouncementState(fromInitial2, verdict);
  assert.deepEqual(fromInitial3, { slot: 0, a: verdict, b: "" });
});

test("ScreenReaderAnnouncer renders dual polite and assertive .sr-only regions driven by seq", () => {
  const emptyHtml = renderToStaticMarkup(
    createElement(ScreenReaderAnnouncer, {
      politeMessage: "",
      politeSeq: 0,
      assertiveMessage: "",
      assertiveSeq: 0
    })
  );

  const politeMatches = emptyHtml.match(/aria-live="polite"/g) ?? [];
  const assertiveMatches = emptyHtml.match(/aria-live="assertive"/g) ?? [];
  const atomicMatches = emptyHtml.match(/aria-atomic="true"/g) ?? [];
  const srOnlyMatches = emptyHtml.match(/class="sr-only"/g) ?? [];

  assert.equal(politeMatches.length, 2);
  assert.equal(assertiveMatches.length, 2);
  assert.equal(atomicMatches.length, 4);
  assert.equal(srOnlyMatches.length, 4);
  assert.deepEqual(extractSlotContents(emptyHtml), {
    "polite-a": "",
    "polite-b": "",
    "assertive-a": "",
    "assertive-b": ""
  });

  const repeatedCoach = "Hold still, reading label";
  const repeatedWarning = "Stop: Ibuprofen conflicts with blood pressure medication";

  const seq1 = extractSlotContents(
    renderToStaticMarkup(
      createElement(ScreenReaderAnnouncer, {
        politeMessage: repeatedCoach,
        politeSeq: 1,
        assertiveMessage: repeatedWarning,
        assertiveSeq: 1
      })
    )
  );
  assert.deepEqual(seq1, {
    "polite-a": repeatedCoach,
    "polite-b": "",
    "assertive-a": repeatedWarning,
    "assertive-b": ""
  });

  const seq2 = extractSlotContents(
    renderToStaticMarkup(
      createElement(ScreenReaderAnnouncer, {
        politeMessage: repeatedCoach,
        politeSeq: 2,
        assertiveMessage: repeatedWarning,
        assertiveSeq: 2
      })
    )
  );
  assert.deepEqual(seq2, {
    "polite-a": "",
    "polite-b": repeatedCoach,
    "assertive-a": "",
    "assertive-b": repeatedWarning
  });

  const seq3 = extractSlotContents(
    renderToStaticMarkup(
      createElement(ScreenReaderAnnouncer, {
        politeMessage: repeatedCoach,
        politeSeq: 3,
        assertiveMessage: repeatedWarning,
        assertiveSeq: 3
      })
    )
  );
  assert.deepEqual(seq3, {
    "polite-a": repeatedCoach,
    "polite-b": "",
    "assertive-a": repeatedWarning,
    "assertive-b": ""
  });
});

test("resolveShortcut maps all 7 accessible keys accurately in both cases", () => {
  const cases: Array<[string, ShortcutAction]> = [
    [" ", "toggle_check"],
    ["s", "snapshot_verify"],
    ["S", "snapshot_verify"],
    ["b", "offline_barcode"],
    ["B", "offline_barcode"],
    ["l", "log_dose"],
    ["L", "log_dose"],
    ["r", "repeat"],
    ["R", "repeat"],
    ["t", "cycle_theme"],
    ["T", "cycle_theme"],
    ["p", "open_privacy"],
    ["P", "open_privacy"]
  ];

  for (const [key, expected] of cases) {
    assert.equal(resolveShortcut({ key }), expected, `key=${JSON.stringify(key)}`);
    assert.equal(
      resolveShortcut({ key, targetTagName: "DIV" }),
      expected,
      `DIV target key=${JSON.stringify(key)}`
    );
  }

  assert.equal(resolveShortcut({ key: "Enter" }), null);
  assert.equal(resolveShortcut({ key: "Escape" }), null);
  assert.equal(resolveShortcut({ key: "Tab" }), null);
  assert.equal(resolveShortcut({ key: "x" }), null);
  assert.equal(resolveShortcut({ key: "" }), null);
});

test("resolveShortcut ignores form fields, contentEditable, modifiers, and BUTTON/A Spacebar", () => {
  const allKeys = [" ", "s", "S", "b", "B", "l", "L", "r", "R", "t", "T", "p", "P"];
  const formTags = ["INPUT", "input", "TEXTAREA", "textarea", "SELECT", "select"];

  for (const tag of formTags) {
    for (const key of allKeys) {
      assert.equal(resolveShortcut({ key, targetTagName: tag }), null, `${tag}:${key}`);
      assert.equal(resolveShortcut({ key, target: { tagName: tag } }), null, `dom-${tag}:${key}`);
    }
  }

  for (const key of allKeys) {
    assert.equal(resolveShortcut({ key, isContentEditable: true }), null);
    assert.equal(resolveShortcut({ key, target: { isContentEditable: true } }), null);
    assert.equal(resolveShortcut({ key, target: { contentEditable: "true" } }), null);
    assert.equal(resolveShortcut({ key, ctrlKey: true }), null);
    assert.equal(resolveShortcut({ key, metaKey: true }), null);
    assert.equal(resolveShortcut({ key, altKey: true }), null);
    assert.equal(resolveShortcut({ key, defaultPrevented: true }), null);
  }

  assert.equal(resolveShortcut({ key: " ", targetTagName: "BUTTON" }), null);
  assert.equal(resolveShortcut({ key: " ", targetTagName: "button" }), null);
  assert.equal(resolveShortcut({ key: " ", targetTagName: "A" }), null);
  assert.equal(resolveShortcut({ key: " ", targetTagName: "a" }), null);
  assert.equal(resolveShortcut({ key: " ", target: { tagName: "BUTTON" } }), null);

  assert.equal(resolveShortcut({ key: "r", targetTagName: "BUTTON" }), "repeat");
  assert.equal(resolveShortcut({ key: "l", targetTagName: "A" }), "log_dose");
});

test("SHORTCUT_LEGEND covers all 7 actions and bindShortcutListener prevents default and cleans up", () => {
  const actions = new Set(SHORTCUT_LEGEND.map((item) => item.action));
  assert.deepEqual(
    [...actions],
    [
      "toggle_check",
      "snapshot_verify",
      "offline_barcode",
      "log_dose",
      "repeat",
      "cycle_theme",
      "open_privacy"
    ]
  );
  for (const item of SHORTCUT_LEGEND) {
    assert.ok(item.key.length > 0);
    assert.ok(item.description.length > 0);
    assert.equal(item.description.includes("\u2014"), false);
  }

  let captured: ((ev: KeyboardEvent) => void) | null = null;
  const host = {
    addEventListener(_type: "keydown", fn: (ev: KeyboardEvent) => void) {
      captured = fn;
    },
    removeEventListener(_type: "keydown", fn: (ev: KeyboardEvent) => void) {
      if (captured === fn) captured = null;
    }
  };

  const fired: ShortcutAction[] = [];
  let prevented = 0;
  const detach = bindShortcutListener((action) => fired.push(action), { host });
  assert.notEqual(captured, null);

  const emit = (partial: Record<string, unknown>) => {
    captured?.({
      key: "",
      repeat: false,
      preventDefault() {
        prevented += 1;
      },
      ...partial
    } as unknown as KeyboardEvent);
  };

  emit({ key: "r" });
  emit({ key: " ", target: { tagName: "BODY" } });
  emit({ key: " ", target: { tagName: "BUTTON" } });
  emit({ key: "s", repeat: true });
  emit({ key: "p", ctrlKey: true });

  assert.deepEqual(fired, ["repeat", "toggle_check"]);
  assert.equal(prevented, 2);

  detach();
  assert.equal(captured, null);
});
