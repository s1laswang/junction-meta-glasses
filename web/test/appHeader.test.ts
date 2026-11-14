import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AppHeader,
  getNextTheme,
  resolveNextTabByKey,
  resolveSupportedLangCode,
  type AppHeaderProps,
  type AppTab
} from "../src/components/AppHeader.tsx";
import type { ThemeMode, TransportMode } from "../src/types.ts";

type TestFn = (name: string, fn: () => void | Promise<void>) => Promise<void>;

type AssertStrict = {
  ok(value: unknown, message?: string): asserts value;
  equal<T>(actual: T, expected: T, message?: string): void;
  notEqual<T>(actual: T, expected: T, message?: string): void;
  deepEqual<T>(actual: T, expected: T, message?: string): void;
  match(value: string, regExp: RegExp, message?: string): void;
  doesNotMatch(value: string, regExp: RegExp, message?: string): void;
};

const nodeTestSpec: string = "node:test";
const nodeAssertSpec: string = "node:assert/strict";

const { test } = (await import(nodeTestSpec)) as { test: TestFn };
const assert: AssertStrict = (await import(nodeAssertSpec)) as AssertStrict;

const EM_DASH = "\u2014";
const EN_DASH = "\u2013";
const noop = (): void => {};

function makeProps(overrides: Partial<AppHeaderProps> = {}): AppHeaderProps {
  return {
    activeTab: "check",
    onSelectTab: noop,
    theme: "dark",
    onChangeTheme: noop,
    muted: false,
    onToggleMute: noop,
    lang: "en",
    onChangeLang: noop,
    mode: "live",
    hudConnected: false,
    medCount: 3,
    onOpenPrivacy: noop,
    onOpenShortcuts: noop,
    ...overrides
  };
}

function extractOpeningTagByAttr(html: string, attrToken: string): string {
  const escaped = attrToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<([a-z0-9]+)\\b[^>]*${escaped}[^>]*>`, "i");
  const match = pattern.exec(html);
  assert.ok(match, `Expected element with attribute ${attrToken}`);
  return match[0];
}

function extractOptionValues(html: string): string[] {
  const values: string[] = [];
  const pattern = /<option\b[^>]*value="([^"]+)"[^>]*>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    values.push(match[1]);
  }
  return values;
}

test("AppHeader renders skip-to-main link at the very top, accessible glasses+shield SVG mark, and HoldUp title", () => {
  const html = renderToStaticMarkup(createElement(AppHeader, makeProps()));

  assert.ok(
    html.startsWith('<a href="#main-content" class="skip-link">Skip to main check</a>'),
    "Skip link must be the very first element in AppHeader output"
  );
  assert.match(html, /<header\b[^>]*class="app-header"/);
  assert.match(html, /<svg\b[^>]*role="img"[^>]*aria-label="HoldUp smart glasses and safety shield mark"/);
  assert.match(html, /<h1\b[^>]*>HoldUp<\/h1>/);
  assert.equal(html.includes(EM_DASH), false);
  assert.equal(html.includes(EN_DASH), false);
});

test("AppHeader renders Primary sections nav tablist, updates aria-selected/tabindex per activeTab, and reflects medCount", () => {
  const tabs: readonly AppTab[] = ["check", "profile", "device"];

  for (const currentTab of tabs) {
    const html = renderToStaticMarkup(
      createElement(AppHeader, makeProps({ activeTab: currentTab, medCount: 4 }))
    );

    assert.match(html, /<nav\b[^>]*class="app-nav"[^>]*aria-label="Primary sections"/);
    assert.match(html, /<div\b[^>]*role="tablist"[^>]*aria-label="Primary sections"/);
    assert.ok(html.includes("<span>Live Check</span>"));
    assert.ok(html.includes("<span>My Meds &amp; Allergies (4)</span>"));
    assert.ok(html.includes("<span>Device &amp; Resilience</span>"));

    for (const candidate of tabs) {
      const tabTag = extractOpeningTagByAttr(html, `data-tab="${candidate}"`);
      assert.ok(tabTag.includes('role="tab"'));
      assert.ok(tabTag.includes(`id="tab-${candidate}"`));
      assert.ok(tabTag.includes(`aria-controls="panel-${candidate}"`));
      assert.ok(tabTag.includes("min-height:var(--tap-min, 56px)"));

      if (candidate === currentTab) {
        assert.ok(tabTag.includes('aria-selected="true"'), `${candidate} should be selected`);
        assert.ok(tabTag.includes('tabindex="0"'), `${candidate} should have tabindex=0`);
      } else {
        assert.ok(tabTag.includes('aria-selected="false"'), `${candidate} should not be selected`);
        assert.ok(tabTag.includes('tabindex="-1"'), `${candidate} should have tabindex=-1`);
      }
    }
  }

  const clampedHtml = renderToStaticMarkup(
    createElement(AppHeader, makeProps({ medCount: -3 }))
  );
  assert.ok(clampedHtml.includes("<span>My Meds &amp; Allergies (0)</span>"));

  assert.equal(resolveNextTabByKey("check", "ArrowRight"), "profile");
  assert.equal(resolveNextTabByKey("profile", "ArrowRight"), "device");
  assert.equal(resolveNextTabByKey("device", "ArrowRight"), "check");
  assert.equal(resolveNextTabByKey("check", "ArrowLeft"), "device");
  assert.equal(resolveNextTabByKey("device", "Home"), "check");
  assert.equal(resolveNextTabByKey("check", "End"), "device");
  assert.equal(resolveNextTabByKey("check", "Enter"), null);
});

test("AppHeader renders LIVE, SNAPSHOT, and OFFLINE mode pills and toggles HUD Connected indicator", () => {
  const modeCases: ReadonlyArray<[TransportMode, string]> = [
    ["live", "LIVE"],
    ["snapshot", "SNAPSHOT"],
    ["offline", "OFFLINE"]
  ];

  for (const [mode, label] of modeCases) {
    const disconnectedHtml = renderToStaticMarkup(
      createElement(AppHeader, makeProps({ mode, hudConnected: false }))
    );
    const modeTag = extractOpeningTagByAttr(disconnectedHtml, `data-mode="${mode}"`);
    assert.ok(modeTag.includes("app-mode-pill"));
    assert.ok(disconnectedHtml.includes(`<span>${label}</span>`));
    assert.equal(disconnectedHtml.includes("HUD Connected"), false);
    assert.equal(disconnectedHtml.includes('data-hud-connected="true"'), false);
    if (mode === "live") {
      assert.ok(disconnectedHtml.includes('class="privacy-live-dot"'));
    }

    const connectedHtml = renderToStaticMarkup(
      createElement(AppHeader, makeProps({ mode, hudConnected: true }))
    );
    const hudTag = extractOpeningTagByAttr(connectedHtml, 'data-hud-connected="true"');
    assert.ok(hudTag.includes("app-hud-pill"));
    assert.ok(hudTag.includes('aria-label="Ray-Ban Display HUD connected"'));
    assert.ok(connectedHtml.includes("<span>HUD Connected</span>"));
  }
});

test("AppHeader renders mute aria-pressed, theme switcher, 8-language select, shortcuts, privacy, and /hud link", () => {
  const unmutedHtml = renderToStaticMarkup(
    createElement(AppHeader, makeProps({ muted: false, theme: "dark", lang: "en" }))
  );
  const unmutedBtn = extractOpeningTagByAttr(unmutedHtml, 'data-action="toggle-mute"');
  assert.ok(unmutedBtn.includes('aria-pressed="false"'));
  assert.ok(unmutedBtn.includes('aria-label="Mute audio and earcons"'));
  assert.ok(unmutedHtml.includes("<span>Audio On</span>"));

  const mutedHtml = renderToStaticMarkup(
    createElement(AppHeader, makeProps({ muted: true, theme: "high-contrast", lang: "de", onOpenShortcuts: undefined }))
  );
  const mutedBtn = extractOpeningTagByAttr(mutedHtml, 'data-action="toggle-mute"');
  assert.ok(mutedBtn.includes('aria-pressed="true"'));
  assert.ok(mutedBtn.includes('aria-label="Mute audio and earcons"'));
  assert.ok(mutedHtml.includes("<span>Muted</span>"));

  assert.equal(getNextTheme("dark"), "light");
  assert.equal(getNextTheme("light"), "high-contrast");
  assert.equal(getNextTheme("high-contrast"), "dark");

  const themeBtn = extractOpeningTagByAttr(mutedHtml, 'data-action="cycle-theme"');
  assert.ok(themeBtn.includes('data-theme="high-contrast"'));
  assert.ok(themeBtn.includes("Switch visual theme, current High Contrast, next Dark"));
  assert.ok(mutedHtml.includes("<span>Theme: High Contrast</span>"));

  assert.deepEqual(extractOptionValues(unmutedHtml), [
    "en",
    "fi",
    "sv",
    "de",
    "es",
    "fr",
    "et",
    "ru"
  ]);
  assert.match(mutedHtml, /<option value="de" selected="">Deutsch \(DE\)<\/option>/);
  assert.equal(resolveSupportedLangCode("fi-FI"), "fi");
  assert.equal(resolveSupportedLangCode("SV_SE"), "sv");
  assert.equal(resolveSupportedLangCode("et"), "et");
  assert.equal(resolveSupportedLangCode("ja-JP"), "en");

  const shortcutsBtn = extractOpeningTagByAttr(mutedHtml, 'data-action="open-shortcuts"');
  assert.ok(shortcutsBtn.includes('aria-label="Keyboard and Neural Band shortcuts"'));

  const privacyBtn = extractOpeningTagByAttr(mutedHtml, 'data-action="open-privacy"');
  assert.ok(privacyBtn.includes('aria-label="Privacy and consent"'));

  const hudLink = extractOpeningTagByAttr(mutedHtml, 'data-action="open-hud"');
  assert.ok(hudLink.includes('href="/hud"'));
  assert.ok(hudLink.includes('target="_blank"'));
  assert.ok(hudLink.includes('rel="noopener"'));
  assert.ok(hudLink.includes('aria-label="Open 600x600 Ray-Ban Display /hud waveguide window in new tab"'));

  for (const action of [
    "cycle-theme",
    "select-lang",
    "toggle-mute",
    "open-shortcuts",
    "open-privacy",
    "open-hud"
  ]) {
    const tag = extractOpeningTagByAttr(mutedHtml, `data-action="${action}"`);
    assert.ok(tag.includes("min-height:var(--tap-min, 56px)"), `${action} must enforce >= 48px touch height`);
    assert.ok(tag.includes("aria-label="), `${action} must provide explicit aria-label`);
  }
});

test("AppHeader localizes cleanly across en, fi, sv and emits zero em dashes across all state combinations", () => {
  const enHtml = renderToStaticMarkup(
    createElement(AppHeader, makeProps({ lang: "en", hudConnected: true, medCount: 2 }))
  );
  const fiHtml = renderToStaticMarkup(
    createElement(AppHeader, makeProps({ lang: "fi", hudConnected: true, medCount: 2 }))
  );
  const svHtml = renderToStaticMarkup(
    createElement(AppHeader, makeProps({ lang: "sv", hudConnected: true, medCount: 2 }))
  );

  assert.notEqual(enHtml, fiHtml);
  assert.notEqual(enHtml, svHtml);
  assert.notEqual(fiHtml, svHtml);

  assert.ok(fiHtml.startsWith('<a href="#main-content" class="skip-link">Siirry tarkistukseen</a>'));
  assert.ok(fiHtml.includes("<span>HUD yhdistetty</span>"));
  assert.ok(fiHtml.includes("<span>Reaaliaikainen tarkistus</span>"));
  assert.ok(fiHtml.includes("<span>Lääkkeet ja allergiat (2)</span>"));
  assert.ok(fiHtml.includes("<span>Laite ja toimintavarmuus</span>"));
  assert.ok(fiHtml.includes('aria-label="Tietosuoja ja suostumus"'));
  assert.ok(fiHtml.includes("<span>Avaa /hud-näyttö</span>"));

  assert.ok(svHtml.startsWith('<a href="#main-content" class="skip-link">Hoppa till kontrollen</a>'));
  assert.ok(svHtml.includes("<span>HUD ansluten</span>"));
  assert.ok(svHtml.includes("<span>Direktkontroll</span>"));
  assert.ok(svHtml.includes("<span>Mina läkemedel och allergier (2)</span>"));
  assert.ok(svHtml.includes("<span>Enhet och driftsäkerhet</span>"));
  assert.ok(svHtml.includes('aria-label="Integritet och samtycke"'));
  assert.ok(svHtml.includes("<span>Öppna /hud-vy</span>"));

  const fiRegional = renderToStaticMarkup(
    createElement(AppHeader, makeProps({ lang: "fi-FI", hudConnected: true, medCount: 2 }))
  );
  assert.equal(fiRegional, fiHtml);

  const locales = ["en", "fi", "sv", "de", "es", "fr", "et", "ru"];
  const themes: readonly ThemeMode[] = ["dark", "light", "high-contrast"];
  const modes: readonly TransportMode[] = ["live", "snapshot", "offline"];
  const tabs: readonly AppTab[] = ["check", "profile", "device"];

  for (const lang of locales) {
    for (const theme of themes) {
      for (const mode of modes) {
        for (const activeTab of tabs) {
          for (const muted of [false, true]) {
            for (const hudConnected of [false, true]) {
              const html = renderToStaticMarkup(
                createElement(
                  AppHeader,
                  makeProps({ lang, theme, mode, activeTab, muted, hudConnected })
                )
              );
              assert.equal(html.includes(EM_DASH), false, `Em dash found for ${lang}/${theme}/${mode}`);
              assert.equal(html.includes(EN_DASH), false, `En dash found for ${lang}/${theme}/${mode}`);
            }
          }
        }
      }
    }
  }
});
