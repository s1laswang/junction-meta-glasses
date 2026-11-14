import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ConversationBar,
  MAX_VISIBLE_TRANSCRIPTS,
  getQuickQuestions,
  selectRollingTranscripts,
  type ConversationBarProps
} from "../src/components/ConversationBar.tsx";
import {
  PermissionBanner,
  type PermissionBannerProps
} from "../src/components/PermissionBanner.tsx";
import type { TranscriptEntry, TransportMode } from "../src/types.ts";

type TestFn = (name: string, fn: () => void | Promise<void>) => Promise<void>;

interface StrictAssert {
  ok(value: unknown, message?: string): void;
  equal<T>(actual: T, expected: T, message?: string): void;
  notEqual<T>(actual: T, expected: T, message?: string): void;
  deepEqual<T>(actual: T, expected: T, message?: string): void;
  match(value: string, regExp: RegExp, message?: string): void;
  doesNotMatch(value: string, regExp: RegExp, message?: string): void;
}

const nodeTestSpec: string = "node:test";
const nodeAssertSpec: string = "node:assert/strict";

const { test } = (await import(nodeTestSpec)) as { test: TestFn };
const assert = ((await import(nodeAssertSpec)) as { default: StrictAssert }).default;

const EM_DASH = "\u2014";
const EN_DASH = "\u2013";
const noop = (): void => {};

function makeBasePermissionProps(
  overrides: Partial<PermissionBannerProps> = {}
): PermissionBannerProps {
  return {
    permissions: {
      camera: "granted",
      microphone: "granted"
    },
    currentSource: "phone",
    lastError: null,
    onUseSnapshotMode: noop,
    onUseDemoProps: noop,
    onRetryPermissions: noop,
    onDismissError: noop,
    ...overrides
  };
}

function makeConversationProps(
  overrides: Partial<ConversationBarProps> = {}
): ConversationBarProps {
  return {
    transcripts: [],
    mode: "live",
    disabled: false,
    lang: "en",
    onSubmitQuestion: noop,
    ...overrides
  };
}

function extractOpeningTagByAttr(html: string, attrSnippet: string): string {
  const escaped = attrSnippet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<([a-z0-9]+)\\b[^>]*${escaped}[^>]*>`, "i");
  const match = pattern.exec(html);
  assert.ok(match, `Expected element with attribute snippet ${attrSnippet}`);
  return match ? match[0] : "";
}

function parseMinHeightPx(tag: string): number {
  const match = /min-height:(\d+(?:\.\d+)?)px/.exec(tag);
  assert.ok(match, `Expected inline min-height in px on tag: ${tag}`);
  return match ? Number.parseFloat(match[1]) : 0;
}

test("PermissionBanner renders null when permissions are granted or prompt and lastError is null", () => {
  const grantedHtml = renderToStaticMarkup(
    createElement(PermissionBanner, makeBasePermissionProps())
  );
  assert.equal(grantedHtml, "");

  const promptHtml = renderToStaticMarkup(
    createElement(
      PermissionBanner,
      makeBasePermissionProps({
        permissions: { camera: "prompt", microphone: "prompt" }
      })
    )
  );
  assert.equal(promptHtml, "");

  const demoSourceCameraDeniedHtml = renderToStaticMarkup(
    createElement(
      PermissionBanner,
      makeBasePermissionProps({
        permissions: { camera: "denied", microphone: "granted" },
        currentSource: "demo"
      })
    )
  );
  assert.equal(demoSourceCameraDeniedHtml, "");

  const glassesSourceCameraUnavailableHtml = renderToStaticMarkup(
    createElement(
      PermissionBanner,
      makeBasePermissionProps({
        permissions: { camera: "unavailable", microphone: "granted" },
        currentSource: "glasses"
      })
    )
  );
  assert.equal(glassesSourceCameraUnavailableHtml, "");
});

test("PermissionBanner renders camera recovery card with Chrome/Safari steps and >= 56px fallback buttons when phone camera is denied or unavailable", () => {
  for (const camStatus of ["denied", "unavailable"] as const) {
    const html = renderToStaticMarkup(
      createElement(
        PermissionBanner,
        makeBasePermissionProps({
          permissions: { camera: camStatus, microphone: "granted" },
          currentSource: "phone"
        })
      )
    );

    assert.ok(html.length > 0);
    assert.match(html, /read medication and food labels only while you hold them up/);
    assert.match(html, /Chrome/);
    assert.match(html, /Safari/);
    assert.match(html, /Site settings/i);
    assert.match(html, /Website Settings/i);

    assert.ok(html.includes(">Use Demo Label Props</button>"));
    assert.ok(html.includes(">Retry Camera Permission</button>"));

    const demoBtn = extractOpeningTagByAttr(html, 'data-action="use-demo-props"');
    const retryBtn = extractOpeningTagByAttr(html, 'data-action="retry-camera-permission"');
    assert.ok(parseMinHeightPx(demoBtn) >= 56);
    assert.ok(parseMinHeightPx(retryBtn) >= 56);

    assert.equal(html.includes(EM_DASH), false);
    assert.equal(html.includes(EN_DASH), false);
  }
});

test("PermissionBanner renders microphone recovery card with Snapshot Mode reassurance and Continue Without Microphone button", () => {
  for (const micStatus of ["denied", "unavailable"] as const) {
    const html = renderToStaticMarkup(
      createElement(
        PermissionBanner,
        makeBasePermissionProps({
          permissions: { camera: "granted", microphone: micStatus },
          currentSource: "phone"
        })
      )
    );

    assert.ok(
      html.includes(
        "Microphone is off or blocked. You can still check labels using Snapshot Mode and typed or quick-tap questions"
      )
    );
    assert.ok(html.includes(">Continue Without Microphone</button>"));

    const snapshotBtn = extractOpeningTagByAttr(
      html,
      'data-action="continue-without-microphone"'
    );
    assert.ok(parseMinHeightPx(snapshotBtn) >= 56);

    assert.equal(html.includes(EM_DASH), false);
    assert.equal(html.includes(EN_DASH), false);
  }
});

test("PermissionBanner renders calm role=alert error card with lastError.message and retry/dismiss actions", () => {
  const recoverableHtml = renderToStaticMarkup(
    createElement(
      PermissionBanner,
      makeBasePermissionProps({
        lastError: {
          code: "live_ws_closed",
          message: "Live audio connection paused. Switched safely to Snapshot Mode.",
          recoverable: true
        }
      })
    )
  );

  const alertTag = extractOpeningTagByAttr(recoverableHtml, 'role="alert"');
  assert.ok(alertTag.includes('aria-atomic="true"'));
  assert.ok(
    recoverableHtml.includes(
      "Live audio connection paused. Switched safely to Snapshot Mode."
    )
  );
  assert.ok(recoverableHtml.includes("live_ws_closed"));
  assert.ok(recoverableHtml.includes(">Retry</button>"));
  assert.ok(recoverableHtml.includes(">Dismiss</button>"));

  const retryBtn = extractOpeningTagByAttr(recoverableHtml, 'data-action="retry-after-error"');
  const dismissBtn = extractOpeningTagByAttr(recoverableHtml, 'data-action="dismiss-error"');
  assert.ok(parseMinHeightPx(retryBtn) >= 56);
  assert.ok(parseMinHeightPx(dismissBtn) >= 56);

  const withoutDismissHtml = renderToStaticMarkup(
    createElement(
      PermissionBanner,
      makeBasePermissionProps({
        onDismissError: undefined,
        lastError: {
          code: "camera_busy",
          message: "Another app is currently using the camera.",
          recoverable: false
        }
      })
    )
  );
  assert.ok(withoutDismissHtml.includes('role="alert"'));
  assert.ok(withoutDismissHtml.includes("Another app is currently using the camera."));
  assert.ok(withoutDismissHtml.includes(">Retry</button>"));
  assert.equal(withoutDismissHtml.includes(">Dismiss</button>"), false);

  const combinedHtml = renderToStaticMarkup(
    createElement(
      PermissionBanner,
      makeBasePermissionProps({
        permissions: { camera: "denied", microphone: "denied" },
        currentSource: "phone",
        lastError: {
          code: "perm_blocked",
          message: "Permissions need attention.",
          recoverable: true
        }
      })
    )
  );
  assert.ok(combinedHtml.includes(">Use Demo Label Props</button>"));
  assert.ok(combinedHtml.includes(">Continue Without Microphone</button>"));
  assert.ok(combinedHtml.includes("Permissions need attention."));
  assert.equal(combinedHtml.includes(EM_DASH), false);
});

test("ConversationBar renders localized >= 48px quick-question chips in en, fi, sv with fallback to en", () => {
  const expectedEn: readonly [string, string, string, string] = [
    "Is this my evening pill?",
    "Does this contain nuts?",
    "What strength is this?",
    "Is it still in date?"
  ];
  assert.deepEqual(getQuickQuestions("en"), expectedEn);
  assert.deepEqual(getQuickQuestions("en-US"), expectedEn);
  assert.deepEqual(getQuickQuestions("de"), expectedEn);
  assert.deepEqual(getQuickQuestions(""), expectedEn);

  const fiQuestions = getQuickQuestions("fi");
  const svQuestions = getQuickQuestions("sv");
  assert.equal(fiQuestions.length, 4);
  assert.equal(svQuestions.length, 4);
  assert.notEqual(fiQuestions[0], expectedEn[0]);
  assert.notEqual(svQuestions[0], expectedEn[0]);
  assert.notEqual(fiQuestions[0], svQuestions[0]);
  assert.deepEqual(getQuickQuestions("fi-FI"), fiQuestions);
  assert.deepEqual(getQuickQuestions("sv-SE"), svQuestions);

  const enHtml = renderToStaticMarkup(
    createElement(ConversationBar, makeConversationProps({ lang: "en" }))
  );

  for (let i = 0; i < expectedEn.length; i += 1) {
    assert.ok(enHtml.includes(`>${expectedEn[i]}</button>`), `Missing chip: ${expectedEn[i]}`);
    const chipTag = extractOpeningTagByAttr(enHtml, `data-quick-index="${i}"`);
    assert.ok(parseMinHeightPx(chipTag) >= 48, `Chip ${i} tap height must be >= 48px`);
  }

  const fiHtml = renderToStaticMarkup(
    createElement(ConversationBar, makeConversationProps({ lang: "fi" }))
  );
  const svHtml = renderToStaticMarkup(
    createElement(ConversationBar, makeConversationProps({ lang: "sv" }))
  );
  const frFallbackHtml = renderToStaticMarkup(
    createElement(ConversationBar, makeConversationProps({ lang: "fr" }))
  );

  for (const q of fiQuestions) {
    assert.ok(fiHtml.includes(`>${q}</button>`));
  }
  for (const q of svQuestions) {
    assert.ok(svHtml.includes(`>${q}</button>`));
  }
  assert.equal(frFallbackHtml, enHtml);
});

test("ConversationBar renders accessible form with associated label, text input, and Ask submit across Live, Snapshot, and Local Intent modes", () => {
  const modes: readonly TransportMode[] = ["live", "snapshot", "offline"];

  for (const mode of modes) {
    const html = renderToStaticMarkup(
      createElement(ConversationBar, makeConversationProps({ mode, lang: "en" }))
    );

    assert.match(html, /<form\b[^>]*class="[^"]*\bconversation-form\b[^"]*"/);

    const labelForMatch = /<label\b[^>]*for="([^"]+)"/.exec(html);
    assert.ok(labelForMatch, `Expected <label for="..."> in mode=${mode}`);
    const inputId = labelForMatch ? labelForMatch[1] : "";
    assert.ok(inputId.length > 0);

    const inputTag = extractOpeningTagByAttr(html, `id="${inputId}"`);
    assert.ok(inputTag.includes('type="text"'));
    assert.doesNotMatch(inputTag, /\sdisabled(?:=""|\s|>)/);

    const submitTag = extractOpeningTagByAttr(html, 'type="submit"');
    assert.doesNotMatch(submitTag, /\sdisabled(?:=""|\s|>)/);
    assert.ok(html.includes(">Ask</button>"));
    assert.ok(html.includes(`data-mode="${mode}"`));
  }

  const disabledHtml = renderToStaticMarkup(
    createElement(ConversationBar, makeConversationProps({ disabled: true }))
  );
  const disabledSubmitTag = extractOpeningTagByAttr(disabledHtml, 'type="submit"');
  assert.match(disabledSubmitTag, /\sdisabled(?:=""|\s|>)/);
  assert.ok(disabledSubmitTag.includes('aria-disabled="true"'));
});

test("ConversationBar rolling transcript list exposes aria-live=polite and aria-relevant='additions text', caps to last 8 items, and shows You / HoldUp badges", () => {
  const emptyHtml = renderToStaticMarkup(
    createElement(ConversationBar, makeConversationProps({ transcripts: [] }))
  );
  const emptyRegionTag = extractOpeningTagByAttr(emptyHtml, 'role="log"');
  assert.ok(emptyRegionTag.includes('aria-live="polite"'));
  assert.ok(emptyRegionTag.includes('aria-relevant="additions text"'));

  const elevenEntries: TranscriptEntry[] = Array.from({ length: 11 }, (_, idx) => {
    const num = idx + 1;
    return {
      id: `utt-${num}`,
      role: num % 2 === 1 ? "user" : "assistant",
      text: `Utterance number ${num}`,
      final: num < 11,
      ts: 1700000000000 + num * 1000
    };
  });

  assert.equal(MAX_VISIBLE_TRANSCRIPTS, 8);
  const sliced = selectRollingTranscripts(elevenEntries);
  assert.equal(sliced.length, 8);
  assert.equal(sliced[0].id, "utt-4");
  assert.equal(sliced[7].id, "utt-11");

  const populatedHtml = renderToStaticMarkup(
    createElement(ConversationBar, makeConversationProps({ transcripts: elevenEntries }))
  );

  const regionTag = extractOpeningTagByAttr(populatedHtml, 'role="log"');
  assert.ok(regionTag.includes('aria-live="polite"'));
  assert.ok(regionTag.includes('aria-relevant="additions text"'));

  for (const omitted of [1, 2, 3]) {
    assert.equal(
      populatedHtml.includes(`Utterance number ${omitted}<`),
      false,
      `Utterance ${omitted} should be rolled off`
    );
  }
  for (const visible of [4, 5, 6, 7, 8, 9, 10, 11]) {
    assert.ok(
      populatedHtml.includes(`>Utterance number ${visible}</span>`),
      `Utterance ${visible} should be rendered`
    );
  }

  const youBadges = populatedHtml.match(/>You<\/span>/g) ?? [];
  const holdUpBadges = populatedHtml.match(/>HoldUp<\/span>/g) ?? [];
  assert.equal(youBadges.length, 4);
  assert.equal(holdUpBadges.length, 4);
  assert.ok(populatedHtml.includes(">Speaking</span>"));
});

test("PermissionBanner and ConversationBar emit zero em dashes across all states and locales", () => {
  const sampleTranscripts: TranscriptEntry[] = [
    { id: "t1", role: "user", text: "Is this my evening pill?", final: true, ts: 1 },
    { id: "t2", role: "assistant", text: "Yes, Amlodipine 5 mg.", final: false, ts: 2 }
  ];

  const htmlSamples: string[] = [
    renderToStaticMarkup(
      createElement(
        PermissionBanner,
        makeBasePermissionProps({
          permissions: { camera: "denied", microphone: "denied" },
          currentSource: "phone",
          lastError: { code: "err_1", message: "Temporary connection glitch.", recoverable: true }
        })
      )
    ),
    renderToStaticMarkup(
      createElement(
        PermissionBanner,
        makeBasePermissionProps({
          permissions: { camera: "unavailable", microphone: "unavailable" },
          currentSource: "phone",
          lastError: { code: "err_2", message: "Device busy.", recoverable: false }
        })
      )
    ),
    ...(["en", "fi", "sv"] as const).flatMap((lang) =>
      (["live", "snapshot", "offline"] as const).map((mode) =>
        renderToStaticMarkup(
          createElement(
            ConversationBar,
            makeConversationProps({ lang, mode, transcripts: sampleTranscripts })
          )
        )
      )
    )
  ];

  for (const html of htmlSamples) {
    assert.equal(html.includes(EM_DASH), false, "Output contained an em dash");
    assert.equal(html.includes(EN_DASH), false, "Output contained an en dash");
  }
});
