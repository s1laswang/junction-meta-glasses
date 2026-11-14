import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PermissionBanner,
  getPermissionBannerCopy,
  type PermissionBannerProps
} from "../src/components/PermissionBanner.tsx";
import type { PermissionStateSummary } from "../src/types.ts";

(globalThis as Record<string, unknown>).React = React;

type TestFn = (name: string, fn: () => void | Promise<void>) => Promise<void>;

interface StrictAssert {
  ok(value: unknown, message?: string): asserts value;
  equal<T>(actual: T, expected: T, message?: string): void;
  notEqual<T>(actual: T, expected: T, message?: string): void;
  deepEqual<T>(actual: T, expected: T, message?: string): void;
  match(value: string, regExp: RegExp, message?: string): void;
  doesNotMatch(value: string, regExp: RegExp, message?: string): void;
}

interface FsModule {
  readFileSync(path: URL | string, encoding: "utf8"): string;
}

const nodeTestSpec: string = "node:test";
const nodeAssertSpec: string = "node:assert/strict";
const nodeFsSpec: string = "node:fs";

const { test } = (await import(nodeTestSpec)) as { test: TestFn };
const assert: StrictAssert = ((await import(nodeAssertSpec)) as { default: StrictAssert }).default;
const { readFileSync } = (await import(nodeFsSpec)) as FsModule;

const SLASH = String.fromCharCode(47);
const LINE_COMMENT = SLASH + SLASH;
const BLOCK_COMMENT_OPEN = SLASH + "*";
const BLOCK_COMMENT_CLOSE = "*" + SLASH;
const HTML_COMMENT_OPEN = "<" + "!--";
const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);

const noop = (): void => {};

const GRANTED_PERMISSIONS: PermissionStateSummary = {
  camera: "granted",
  microphone: "granted"
};

function makeProps(overrides: Partial<PermissionBannerProps> = {}): PermissionBannerProps {
  return {
    permissions: GRANTED_PERMISSIONS,
    currentSource: "phone",
    lastError: null,
    onUseSnapshotMode: noop,
    onUseDemoProps: noop,
    onRetryPermissions: noop,
    onDismissError: noop,
    ...overrides
  };
}

function renderBanner(overrides: Partial<PermissionBannerProps> = {}): string {
  return renderToStaticMarkup(createElement(PermissionBanner, makeProps(overrides)));
}

function extractOpeningTags(html: string, tagName: string): string[] {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>`, "gi");
  return html.match(pattern) ?? [];
}

function extractOpeningTagByAttr(html: string, attrSnippet: string): string {
  const escaped = attrSnippet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<([a-z0-9]+)\\b[^>]*${escaped}[^>]*>`, "i");
  const match = pattern.exec(html);
  assert.ok(match, `Expected element matching ${attrSnippet}`);
  return match[0];
}

function getAttr(openingTag: string, attrName: string): string | null {
  const escaped = attrName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\b${escaped}="([^"]*)"`, "i");
  const match = pattern.exec(openingTag);
  return match ? match[1] : null;
}

function parseMinHeightPx(openingTag: string): number {
  const styleAttr = getAttr(openingTag, "style") ?? "";
  const match = /(?:^|;)\s*min-height\s*:\s*(\d+(?:\.\d+)?)px\b/i.exec(styleAttr);
  assert.ok(match, `Expected inline min-height in px on ${openingTag}`);
  return Number.parseFloat(match[1]);
}

function collectAllIds(html: string): string[] {
  const ids: string[] = [];
  const pattern = /\bid="([^"]+)"/gi;
  let match: RegExpExecArray | null = pattern.exec(html);
  while (match !== null) {
    ids.push(match[1]);
    match = pattern.exec(html);
  }
  return ids;
}

function assertCleanAccessibleBanner(html: string, expectedLang: "en" | "fi" | "sv"): void {
  assert.ok(html.length > 0);
  assert.equal(html.includes("undefined"), false);
  assert.equal(html.includes("NaN"), false);
  assert.equal(html.includes("[object "), false);
  assert.equal(html.includes(HTML_COMMENT_OPEN), false);
  assert.equal(html.includes(EM_DASH), false);
  assert.equal(html.includes(EN_DASH), false);

  const rootTag = extractOpeningTagByAttr(html, 'class="permission-banner"');
  assert.equal(getAttr(rootTag, "lang"), expectedLang);

  const ids = collectAllIds(html);
  const uniqueIds = new Set(ids);
  assert.equal(uniqueIds.size, ids.length, "Expected unique element IDs");

  for (const tag of [...extractOpeningTags(html, "section"), ...extractOpeningTags(html, "div")]) {
    const labelledBy = getAttr(tag, "aria-labelledby");
    if (labelledBy !== null) {
      assert.ok(uniqueIds.has(labelledBy), `Missing heading id="${labelledBy}"`);
    }
  }

  const svgs = extractOpeningTags(html, "svg");
  assert.ok(svgs.length >= 1);
  for (const svgTag of svgs) {
    assert.equal(getAttr(svgTag, "aria-hidden"), "true");
    assert.equal(getAttr(svgTag, "focusable"), "false");
  }

  const buttonMatches = [...html.matchAll(/(<button\b[^>]*>)([\s\S]*?)<\/button>/gi)];
  assert.ok(buttonMatches.length >= 1);
  for (const btnMatch of buttonMatches) {
    const openTag = btnMatch[1];
    const innerText = btnMatch[2].replace(/<[^>]+>/g, "").trim();
    assert.equal(getAttr(openTag, "type"), "button");
    assert.ok(innerText.length > 0, "Expected non-empty button label");
    assert.ok(parseMinHeightPx(openTag) >= 56, `Expected button >= 56px: ${openTag}`);
  }
}

test("PermissionBanner defaults to English when lang is omitted and normalizes regional and unknown locales (de -> en)", () => {
  const combinedOverrides: Partial<PermissionBannerProps> = {
    permissions: { camera: "denied", microphone: "denied" },
    currentSource: "phone",
    lastError: {
      code: "live_ws_closed",
      message: "Live audio connection paused.",
      recoverable: true
    }
  };

  const defaultHtml = renderBanner(combinedOverrides);
  const explicitEnHtml = renderBanner({ ...combinedOverrides, lang: "en" });
  const regionalEnHtml = renderBanner({ ...combinedOverrides, lang: "en-US" });
  const deFallbackHtml = renderBanner({ ...combinedOverrides, lang: "de" });
  const emptyLangHtml = renderBanner({ ...combinedOverrides, lang: "" });

  assert.equal(defaultHtml, explicitEnHtml);
  assert.equal(regionalEnHtml, explicitEnHtml);
  assert.equal(deFallbackHtml, explicitEnHtml);
  assert.equal(emptyLangHtml, explicitEnHtml);

  const fiHtml = renderBanner({ ...combinedOverrides, lang: "fi" });
  const regionalFiHtml = renderBanner({ ...combinedOverrides, lang: "fi-FI" });
  const svHtml = renderBanner({ ...combinedOverrides, lang: "sv" });
  const regionalSvHtml = renderBanner({ ...combinedOverrides, lang: "sv-SE" });

  assert.equal(regionalFiHtml, fiHtml);
  assert.equal(regionalSvHtml, svHtml);
  assert.notEqual(fiHtml, explicitEnHtml);
  assert.notEqual(svHtml, explicitEnHtml);
  assert.notEqual(fiHtml, svHtml);

  for (const lang of [undefined, "en", "fi", "sv", "de"] as const) {
    assert.equal(renderBanner({ lang }), "");
    assert.equal(
      renderBanner({
        lang,
        permissions: { camera: "prompt", microphone: "prompt" }
      }),
      ""
    );
    assert.equal(
      renderBanner({
        lang,
        permissions: { camera: "denied", microphone: "granted" },
        currentSource: "demo"
      }),
      ""
    );
    assert.equal(
      renderBanner({
        lang,
        permissions: { camera: "unavailable", microphone: "granted" },
        currentSource: "glasses"
      }),
      ""
    );
  }
});

test("PermissionBanner renders localized camera recovery card for denied and unavailable states across en, fi, sv, and de fallback", () => {
  const cases: ReadonlyArray<{
    lang: string | undefined;
    expectedLocale: "en" | "fi" | "sv";
    deniedHeading: string;
    unavailableHeading: string;
    deniedBadge: string;
    unavailableBadge: string;
    privacySnippet: string;
    stepsHeading: string;
    chromeMenu: string;
    safariMenu: string;
    allowWord: string;
    demoBtn: string;
    retryBtn: string;
  }> = [
    {
      lang: undefined,
      expectedLocale: "en",
      deniedHeading: "Camera access is turned off",
      unavailableHeading: "Phone camera is unavailable",
      deniedBadge: "CAMERA BLOCKED",
      unavailableBadge: "CAMERA UNAVAILABLE",
      privacySnippet:
        "HoldUp needs the camera to read medication and food labels only while you hold them up. Frames stay in memory only, are never saved on a server, and capture stops automatically after 45 seconds.",
      stepsHeading: "How to turn camera access back on:",
      chromeMenu: "Site settings",
      safariMenu: "Website Settings",
      allowWord: "Allow",
      demoBtn: "Use Demo Label Props",
      retryBtn: "Retry Camera Permission"
    },
    {
      lang: "en",
      expectedLocale: "en",
      deniedHeading: "Camera access is turned off",
      unavailableHeading: "Phone camera is unavailable",
      deniedBadge: "CAMERA BLOCKED",
      unavailableBadge: "CAMERA UNAVAILABLE",
      privacySnippet:
        "Frames stay in memory only, are never saved on a server, and capture stops automatically after 45 seconds.",
      stepsHeading: "How to turn camera access back on:",
      chromeMenu: "Site settings",
      safariMenu: "Website Settings",
      allowWord: "Allow",
      demoBtn: "Use Demo Label Props",
      retryBtn: "Retry Camera Permission"
    },
    {
      lang: "fi",
      expectedLocale: "fi",
      deniedHeading: "Kameran käyttöoikeus on pois päältä",
      unavailableHeading: "Puhelimen kamera ei ole käytettävissä",
      deniedBadge: "KAMERA ESTETTY",
      unavailableBadge: "KAMERA EI KÄYTETTÄVISSÄ",
      privacySnippet: "45 sekunnin kuluttua",
      stepsHeading: "Näin otat kameran käyttöön uudelleen:",
      chromeMenu: "Sivuston asetukset",
      safariMenu: "Verkkosivuston asetukset",
      allowWord: "Salli",
      demoBtn: "Käytä esimerkkipakkauksia",
      retryBtn: "Yritä kameran lupaa uudelleen"
    },
    {
      lang: "sv",
      expectedLocale: "sv",
      deniedHeading: "Kameraåtkomst är avstängd",
      unavailableHeading: "Telefonkameran är inte tillgänglig",
      deniedBadge: "KAMERA BLOCKERAD",
      unavailableBadge: "KAMERA EJ TILLGÄNGLIG",
      privacySnippet: "45 sekunder",
      stepsHeading: "Så aktiverar du kameraåtkomst igen:",
      chromeMenu: "Webbplatsinställningar",
      safariMenu: "Webbplatsinställningar",
      allowWord: "Tillåt",
      demoBtn: "Använd exempelpaket",
      retryBtn: "Försök kameratillstånd igen"
    },
    {
      lang: "de",
      expectedLocale: "en",
      deniedHeading: "Camera access is turned off",
      unavailableHeading: "Phone camera is unavailable",
      deniedBadge: "CAMERA BLOCKED",
      unavailableBadge: "CAMERA UNAVAILABLE",
      privacySnippet: "after 45 seconds",
      stepsHeading: "How to turn camera access back on:",
      chromeMenu: "Site settings",
      safariMenu: "Website Settings",
      allowWord: "Allow",
      demoBtn: "Use Demo Label Props",
      retryBtn: "Retry Camera Permission"
    }
  ];

  for (const c of cases) {
    for (const camStatus of ["denied", "unavailable"] as const) {
      const html = renderBanner({
        lang: c.lang,
        permissions: { camera: camStatus, microphone: "granted" },
        currentSource: "phone"
      });

      assertCleanAccessibleBanner(html, c.expectedLocale);

      const expectedHeading = camStatus === "unavailable" ? c.unavailableHeading : c.deniedHeading;
      const expectedBadge = camStatus === "unavailable" ? c.unavailableBadge : c.deniedBadge;

      assert.ok(html.includes(`<span>${expectedHeading}</span>`));
      assert.ok(
        html.includes(`data-permission-camera="${camStatus}">${expectedBadge}</span>`)
      );
      assert.ok(html.includes(c.privacySnippet));
      assert.ok(html.includes(c.stepsHeading));
      assert.ok(html.includes("Chrome"));
      assert.ok(html.includes("Safari"));
      assert.ok(html.includes("<strong>aA</strong>"));
      assert.ok(html.includes(`<strong>${c.chromeMenu}</strong>`));
      assert.ok(html.includes(`<strong>${c.safariMenu}</strong>`));
      assert.ok(html.includes(`<strong>${c.allowWord}</strong>`));
      assert.ok(html.includes(`>${c.demoBtn}</button>`));
      assert.ok(html.includes(`>${c.retryBtn}</button>`));

      const demoBtnTag = extractOpeningTagByAttr(html, 'data-action="use-demo-props"');
      const retryBtnTag = extractOpeningTagByAttr(html, 'data-action="retry-camera-permission"');
      assert.ok(parseMinHeightPx(demoBtnTag) >= 56);
      assert.ok(parseMinHeightPx(retryBtnTag) >= 56);
    }
  }
});

test("PermissionBanner renders localized microphone recovery card with Snapshot Mode notice across en, fi, sv, and de fallback", () => {
  const cases: ReadonlyArray<{
    lang: string | undefined;
    expectedLocale: "en" | "fi" | "sv";
    heading: string;
    deniedBadge: string;
    unavailableBadge: string;
    bodySnippet: string;
    btnLabel: string;
  }> = [
    {
      lang: undefined,
      expectedLocale: "en",
      heading: "Voice input is paused",
      deniedBadge: "MIC BLOCKED",
      unavailableBadge: "MIC UNAVAILABLE",
      bodySnippet:
        "Microphone is off or blocked. You can still check labels using Snapshot Mode and typed or quick-tap questions.",
      btnLabel: "Continue Without Microphone"
    },
    {
      lang: "en",
      expectedLocale: "en",
      heading: "Voice input is paused",
      deniedBadge: "MIC BLOCKED",
      unavailableBadge: "MIC UNAVAILABLE",
      bodySnippet: "Snapshot Mode and typed or quick-tap questions.",
      btnLabel: "Continue Without Microphone"
    },
    {
      lang: "fi",
      expectedLocale: "fi",
      heading: "Ääniohjaus on tauolla",
      deniedBadge: "MIKROFONI ESTETTY",
      unavailableBadge: "MIKROFONI EI KÄYTETTÄVISSÄ",
      bodySnippet: "yksittäiskuvatilassa (Snapshot Mode)",
      btnLabel: "Jatka ilman mikrofonia"
    },
    {
      lang: "sv",
      expectedLocale: "sv",
      heading: "Röstinmatning är pausad",
      deniedBadge: "MIKROFON BLOCKERAD",
      unavailableBadge: "MIKROFON EJ TILLGÄNGLIG",
      bodySnippet: "stillbildsläge (Snapshot Mode)",
      btnLabel: "Fortsätt utan mikrofon"
    },
    {
      lang: "de",
      expectedLocale: "en",
      heading: "Voice input is paused",
      deniedBadge: "MIC BLOCKED",
      unavailableBadge: "MIC UNAVAILABLE",
      bodySnippet: "Snapshot Mode and typed or quick-tap questions.",
      btnLabel: "Continue Without Microphone"
    }
  ];

  for (const c of cases) {
    for (const micStatus of ["denied", "unavailable"] as const) {
      const html = renderBanner({
        lang: c.lang,
        permissions: { camera: "granted", microphone: micStatus },
        currentSource: "phone"
      });

      assertCleanAccessibleBanner(html, c.expectedLocale);

      const expectedBadge = micStatus === "unavailable" ? c.unavailableBadge : c.deniedBadge;
      assert.ok(html.includes(`<span>${c.heading}</span>`));
      assert.ok(
        html.includes(`data-permission-microphone="${micStatus}">${expectedBadge}</span>`)
      );
      assert.ok(html.includes(c.bodySnippet));
      assert.ok(html.includes(`>${c.btnLabel}</button>`));

      const snapshotBtnTag = extractOpeningTagByAttr(
        html,
        'data-action="continue-without-microphone"'
      );
      assert.ok(parseMinHeightPx(snapshotBtnTag) >= 56);
    }
  }
});

test("PermissionBanner renders role=alert connection/device error card for recoverable and non-recoverable errors across en, fi, sv, and de fallback", () => {
  const cases: ReadonlyArray<{
    lang: string | undefined;
    expectedLocale: "en" | "fi" | "sv";
    heading: string;
    recoverableGuidance: string;
    unrecoverableGuidance: string;
    retryLabel: string;
    dismissLabel: string;
  }> = [
    {
      lang: undefined,
      expectedLocale: "en",
      heading: "Connection or device notice",
      recoverableGuidance:
        "Fallback protection is active. You can retry now or dismiss this notice.",
      unrecoverableGuidance:
        "Please check your device settings or network connection and retry.",
      retryLabel: "Retry",
      dismissLabel: "Dismiss"
    },
    {
      lang: "en",
      expectedLocale: "en",
      heading: "Connection or device notice",
      recoverableGuidance:
        "Fallback protection is active. You can retry now or dismiss this notice.",
      unrecoverableGuidance:
        "Please check your device settings or network connection and retry.",
      retryLabel: "Retry",
      dismissLabel: "Dismiss"
    },
    {
      lang: "fi",
      expectedLocale: "fi",
      heading: "Yhteys- tai laiteilmoitus",
      recoverableGuidance:
        "Varatila on käytössä. Voit yrittää nyt uudelleen tai sulkea tämän ilmoituksen.",
      unrecoverableGuidance:
        "Tarkista laitteen asetukset tai verkkoyhteys ja yritä uudelleen.",
      retryLabel: "Yritä uudelleen",
      dismissLabel: "Sulje"
    },
    {
      lang: "sv",
      expectedLocale: "sv",
      heading: "Anslutnings- eller enhetsmeddelande",
      recoverableGuidance:
        "Reservskydd är aktivt. Du kan försöka igen nu eller stänga det här meddelandet.",
      unrecoverableGuidance:
        "Kontrollera enhetens inställningar eller nätverksanslutningen och försök igen.",
      retryLabel: "Försök igen",
      dismissLabel: "Stäng"
    },
    {
      lang: "de",
      expectedLocale: "en",
      heading: "Connection or device notice",
      recoverableGuidance:
        "Fallback protection is active. You can retry now or dismiss this notice.",
      unrecoverableGuidance:
        "Please check your device settings or network connection and retry.",
      retryLabel: "Retry",
      dismissLabel: "Dismiss"
    }
  ];

  for (const c of cases) {
    const recoverableHtml = renderBanner({
      lang: c.lang,
      lastError: {
        code: "live_ws_closed",
        message: "Live stream shifted to Snapshot Mode.",
        recoverable: true
      }
    });

    assertCleanAccessibleBanner(recoverableHtml, c.expectedLocale);
    const recAlertTag = extractOpeningTagByAttr(recoverableHtml, 'role="alert"');
    assert.equal(getAttr(recAlertTag, "aria-atomic"), "true");
    assert.ok((getAttr(recAlertTag, "class") ?? "").includes("verdict-info"));
    assert.ok(recoverableHtml.includes(`<span>${c.heading}</span>`));
    assert.ok(recoverableHtml.includes('data-error-code="live_ws_closed">live_ws_closed</span>'));
    assert.ok(recoverableHtml.includes("Live stream shifted to Snapshot Mode."));
    assert.ok(recoverableHtml.includes(c.recoverableGuidance));
    assert.equal(recoverableHtml.includes(c.unrecoverableGuidance), false);
    assert.ok(recoverableHtml.includes(`>${c.retryLabel}</button>`));
    assert.ok(recoverableHtml.includes(`>${c.dismissLabel}</button>`));

    const retryBtnTag = extractOpeningTagByAttr(recoverableHtml, 'data-action="retry-after-error"');
    const dismissBtnTag = extractOpeningTagByAttr(recoverableHtml, 'data-action="dismiss-error"');
    assert.ok(parseMinHeightPx(retryBtnTag) >= 56);
    assert.ok(parseMinHeightPx(dismissBtnTag) >= 56);

    const unrecoverableNoDismissHtml = renderBanner({
      lang: c.lang,
      onDismissError: undefined,
      lastError: {
        code: "camera_busy",
        message: "Camera hardware is busy.",
        recoverable: false
      }
    });

    assertCleanAccessibleBanner(unrecoverableNoDismissHtml, c.expectedLocale);
    const unrecAlertTag = extractOpeningTagByAttr(unrecoverableNoDismissHtml, 'role="alert"');
    assert.equal(getAttr(unrecAlertTag, "aria-atomic"), "true");
    assert.ok((getAttr(unrecAlertTag, "class") ?? "").includes("verdict-unsure"));
    assert.ok(unrecoverableNoDismissHtml.includes('data-error-code="camera_busy">camera_busy</span>'));
    assert.ok(unrecoverableNoDismissHtml.includes("Camera hardware is busy."));
    assert.ok(unrecoverableNoDismissHtml.includes(c.unrecoverableGuidance));
    assert.equal(unrecoverableNoDismissHtml.includes(c.recoverableGuidance), false);
    assert.ok(unrecoverableNoDismissHtml.includes(`>${c.retryLabel}</button>`));
    assert.equal(unrecoverableNoDismissHtml.includes('data-action="dismiss-error"'), false);
  }
});

test("getPermissionBannerCopy and multi-card banners preserve 3 decorative SVGs, 5 >= 56px buttons, zero comments, and zero em/en dashes", () => {
  const enCopy = getPermissionBannerCopy();
  const fiCopy = getPermissionBannerCopy("fi");
  const svCopy = getPermissionBannerCopy("sv");

  assert.equal(getPermissionBannerCopy("en"), enCopy);
  assert.equal(getPermissionBannerCopy("de"), enCopy);
  assert.equal(getPermissionBannerCopy("fi-FI"), fiCopy);
  assert.equal(getPermissionBannerCopy("sv-SE"), svCopy);
  assert.notEqual(enCopy.cameraPrivacyBody, fiCopy.cameraPrivacyBody);
  assert.notEqual(enCopy.cameraPrivacyBody, svCopy.cameraPrivacyBody);
  assert.notEqual(fiCopy.cameraPrivacyBody, svCopy.cameraPrivacyBody);

  for (const [lang, expectedLocale] of [
    [undefined, "en"],
    ["en", "en"],
    ["fi", "fi"],
    ["sv", "sv"],
    ["de", "en"]
  ] as const) {
    const fullHtml = renderBanner({
      lang,
      permissions: { camera: "unavailable", microphone: "unavailable" },
      currentSource: "phone",
      lastError: {
        code: "net_offline",
        message: "Network offline.",
        recoverable: false
      }
    });

    assertCleanAccessibleBanner(fullHtml, expectedLocale);
    assert.equal(extractOpeningTags(fullHtml, "svg").length, 3);
    assert.equal(extractOpeningTags(fullHtml, "button").length, 5);
  }

  const componentSource = readFileSync(
    new URL("../src/components/PermissionBanner.tsx", import.meta.url),
    "utf8"
  );
  const testSource = readFileSync(
    new URL("./permissionBannerI18nA11y.test.ts", import.meta.url),
    "utf8"
  );

  for (const [label, source] of [
    ["PermissionBanner.tsx", componentSource],
    ["permissionBannerI18nA11y.test.ts", testSource]
  ] as const) {
    assert.equal(source.includes(LINE_COMMENT), false, `${label}: unexpected line comment`);
    assert.equal(source.includes(BLOCK_COMMENT_OPEN), false, `${label}: unexpected block comment`);
    assert.equal(source.includes(BLOCK_COMMENT_CLOSE), false, `${label}: unexpected block close`);
    assert.equal(source.includes(EM_DASH), false, `${label}: unexpected em dash`);
    assert.equal(source.includes(EN_DASH), false, `${label}: unexpected en dash`);
  }
});
