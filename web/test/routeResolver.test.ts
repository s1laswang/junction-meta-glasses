import { DEMO_SCENARIOS } from "../src/camera/demoScenarios.ts";
import { SAMPLE_FINNISH_PHARMACY_QR, parsePharmacyQrUri } from "../src/pairing/pharmacyQr.ts";
import {
  buildScenarioShareUrl,
  resolveAppRoute,
  type AppSurface,
  type ResolvedRoute
} from "../src/routing/routeResolver.ts";
import type { DemoScenarioId, ThemeMode } from "../src/types.ts";

type TestFn = (name: string, fn: () => void | Promise<void>) => Promise<void>;

interface StrictAssert {
  ok(value: unknown, message?: string): void;
  equal<T>(actual: T, expected: T, message?: string): void;
  deepEqual<T>(actual: T, expected: T, message?: string): void;
  throws(fn: () => unknown, error?: RegExp): void;
}

const nodeTestSpec = String("node:test");
const nodeAssertSpec = String("node:assert/strict");
const test: TestFn = ((await import(nodeTestSpec)) as { test: TestFn }).test;
const assert: StrictAssert = ((await import(nodeAssertSpec)) as { default: StrictAssert }).default;

test("resolveAppRoute maps /, /hud, /hud/, and non-HUD paths to expected AppSurface and defaults", () => {
  const rootRoute: ResolvedRoute = resolveAppRoute({ pathname: "/", search: "" });
  assert.deepEqual(rootRoute, {
    surface: "pwa",
    sessionParam: null,
    initialTab: "check",
    scenarioParam: null,
    themeParam: null,
    langParam: null,
    rxPayloadUri: null,
    hudSpeak: false
  });

  const hudRoute = resolveAppRoute({ pathname: "/hud", search: "" });
  const expectedHudSurface: AppSurface = "hud";
  assert.equal(hudRoute.surface, expectedHudSurface);
  assert.equal(hudRoute.sessionParam, null);
  assert.equal(hudRoute.hudSpeak, false);

  const hudTrailingSlash = resolveAppRoute({
    pathname: "/hud/",
    search: "?session=hup-4k9m&speak=1"
  });
  assert.deepEqual(hudTrailingSlash, {
    surface: "hud",
    sessionParam: "hup-4k9m",
    initialTab: "check",
    scenarioParam: null,
    themeParam: null,
    langParam: null,
    rxPayloadUri: null,
    hudSpeak: true
  });

  for (const pwaPath of ["", "/index.html", "/check", "/hud/extra", "/hud-ws", "/hudx", "/HUD"]) {
    assert.equal(
      resolveAppRoute({ pathname: pwaPath, search: "" }).surface,
      "pwa",
      `expected pwa surface for ${pwaPath}`
    );
  }
});

test("resolveAppRoute validates session parameter boundaries and rejects malformed session ids", () => {
  const validSessions = [
    "abcd",
    "hup-4k9m",
    "bench_01-meta",
    "A".repeat(64)
  ];

  for (const session of validSessions) {
    const resolved = resolveAppRoute({
      pathname: "/hud",
      search: `?session=${encodeURIComponent(session)}`
    });
    assert.equal(resolved.sessionParam, session);
  }

  const invalidSessions = [
    "",
    "abc",
    "A".repeat(65),
    "hup 4k9m",
    "hup/4k9m",
    "hup.4k9m",
    "session$1",
    "../escape",
    " abcd "
  ];

  for (const invalid of invalidSessions) {
    const resolved = resolveAppRoute({
      pathname: "/hud",
      search: `?session=${encodeURIComponent(invalid)}`
    });
    assert.equal(resolved.sessionParam, null, `expected null for invalid session ${invalid}`);
  }
});

test("resolveAppRoute validates scenario, tab, theme, speak, and lang query parameters", () => {
  for (const scenario of DEMO_SCENARIOS) {
    const resolved = resolveAppRoute({
      pathname: "/",
      search: `?scenario=${scenario.id}`
    });
    assert.equal(resolved.scenarioParam, scenario.id);
  }

  for (const badScenario of ["", "unknown_scenario", "amlodipine", "AMLODIPINE_MATCH", "toString", "constructor"]) {
    const resolved = resolveAppRoute({
      pathname: "/",
      search: `?scenario=${encodeURIComponent(badScenario)}`
    });
    assert.equal(resolved.scenarioParam, null, `expected null for scenario ${badScenario}`);
  }

  const validTabs: Array<ResolvedRoute["initialTab"]> = ["check", "profile", "device"];
  for (const tab of validTabs) {
    assert.equal(
      resolveAppRoute({ pathname: "/", search: `?tab=${tab}` }).initialTab,
      tab
    );
  }

  for (const badTab of ["", "settings", "hud", "PROFILE", "toString", "__proto__"]) {
    assert.equal(
      resolveAppRoute({ pathname: "/", search: `?tab=${encodeURIComponent(badTab)}` }).initialTab,
      "check",
      `expected default check tab for ${badTab}`
    );
  }

  const validThemes: ThemeMode[] = ["dark", "light", "high-contrast"];
  for (const theme of validThemes) {
    assert.equal(
      resolveAppRoute({ pathname: "/", search: `?theme=${theme}` }).themeParam,
      theme
    );
  }

  for (const badTheme of ["", "contrast", "high_contrast", "DARK", "toString", "constructor"]) {
    assert.equal(
      resolveAppRoute({ pathname: "/", search: `?theme=${encodeURIComponent(badTheme)}` }).themeParam,
      null,
      `expected null for theme ${badTheme}`
    );
  }

  assert.equal(resolveAppRoute({ pathname: "/hud", search: "?speak=1" }).hudSpeak, true);
  assert.equal(resolveAppRoute({ pathname: "/hud", search: "?speak=true" }).hudSpeak, true);
  assert.equal(resolveAppRoute({ pathname: "/hud", search: "?speak=TRUE" }).hudSpeak, true);
  assert.equal(resolveAppRoute({ pathname: "/hud", search: "speak=1" }).hudSpeak, true);
  assert.equal(resolveAppRoute({ pathname: "/hud", search: "?speak=0" }).hudSpeak, false);
  assert.equal(resolveAppRoute({ pathname: "/hud", search: "?speak=false" }).hudSpeak, false);
  assert.equal(resolveAppRoute({ pathname: "/hud", search: "?speak=yes" }).hudSpeak, false);
  assert.equal(resolveAppRoute({ pathname: "/hud", search: "?speak=" }).hudSpeak, false);

  assert.equal(resolveAppRoute({ pathname: "/", search: "?lang=fi" }).langParam, "fi");
  assert.equal(resolveAppRoute({ pathname: "/", search: "?lang=SV" }).langParam, "sv");
  assert.equal(resolveAppRoute({ pathname: "/", search: "?lang=fi_fi" }).langParam, "fi-FI");
  assert.equal(resolveAppRoute({ pathname: "/", search: "?lang=en-US" }).langParam, "en-US");
  assert.equal(resolveAppRoute({ pathname: "/", search: "?lang=zh-hant-tw" }).langParam, "zh-Hant-TW");

  for (const badLang of ["", "x", "invalid", "english", "123", "<script>", "fi-toolongregion"]) {
    assert.equal(
      resolveAppRoute({ pathname: "/", search: `?lang=${encodeURIComponent(badLang)}` }).langParam,
      null,
      `expected null for lang ${badLang}`
    );
  }
});

test("resolveAppRoute validates holdup://rx URIs and raw base64 payloads and rejects hostile rx values", () => {
  const fromFullUri = resolveAppRoute({
    pathname: "/",
    search: `?rx=${encodeURIComponent(SAMPLE_FINNISH_PHARMACY_QR)}`
  });
  assert.equal(fromFullUri.rxPayloadUri, SAMPLE_FINNISH_PHARMACY_QR);
  assert.ok(fromFullUri.rxPayloadUri && parsePharmacyQrUri(fromFullUri.rxPayloadUri) !== null);

  const rawDataToken = SAMPLE_FINNISH_PHARMACY_QR.split("data=")[1];
  assert.ok(rawDataToken);

  const fromBase64Token = resolveAppRoute({
    pathname: "/",
    search: `?rx=${encodeURIComponent(rawDataToken)}`
  });
  assert.equal(fromBase64Token.rxPayloadUri, SAMPLE_FINNISH_PHARMACY_QR);
  assert.deepEqual(
    parsePharmacyQrUri(fromBase64Token.rxPayloadUri ?? ""),
    parsePharmacyQrUri(SAMPLE_FINNISH_PHARMACY_QR)
  );

  const paddedStandardBase64 = btoa('{"v":1,"pharmacy":"Test+Pharmacy/1"}');
  const fromPaddedBase64 = resolveAppRoute({
    pathname: "/",
    search: `?rx=${encodeURIComponent(paddedStandardBase64)}`
  });
  assert.ok(fromPaddedBase64.rxPayloadUri?.startsWith("holdup://rx?v=1&data="));

  const fromHttpsRx = resolveAppRoute({
    pathname: "/",
    search: `?rx=${encodeURIComponent(`https://holdup.example.fi/rx?v=1&data=${rawDataToken}`)}`
  });
  assert.equal(fromHttpsRx.rxPayloadUri, SAMPLE_FINNISH_PHARMACY_QR);

  const invalidRxValues = [
    "",
    "   ",
    "javascript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
    `http://holdup.example.fi/rx?v=1&data=${rawDataToken}`,
    `holdup://pairing?v=1&data=${rawDataToken}`,
    `holdup://rx?v=2&data=${rawDataToken}`,
    `holdup://rx?v=1&data=${rawDataToken}&data=${rawDataToken}`,
    "holdup://rx?v=1&data=",
    "holdup://rx?v=1&data=%%%bad%%%",
    "abc",
    "abcde",
    "ab==",
    "not valid base64!",
    "A".repeat(20_000)
  ];

  for (const badRx of invalidRxValues) {
    const resolved = resolveAppRoute({
      pathname: "/",
      search: `?rx=${encodeURIComponent(badRx)}`
    });
    assert.equal(resolved.rxPayloadUri, null, `expected null for rx ${badRx.slice(0, 32)}`);
  }
});

test("buildScenarioShareUrl generates canonical share links that roundtrip cleanly through resolveAppRoute", () => {
  assert.equal(
    buildScenarioShareUrl("https://holdup.example.com", "amlodipine_match"),
    "https://holdup.example.com/?scenario=amlodipine_match"
  );

  assert.equal(
    buildScenarioShareUrl("https://holdup.example.com/", "hazelnut_allergy"),
    "https://holdup.example.com/?scenario=hazelnut_allergy"
  );

  assert.equal(
    buildScenarioShareUrl("http://localhost:5173/hud?session=hup-4k9m", "ibuprofen_nsaid"),
    "http://localhost:5173/?scenario=ibuprofen_nsaid"
  );

  for (const scenario of DEMO_SCENARIOS) {
    const urlText = buildScenarioShareUrl("https://holdup.fi", scenario.id);
    const parsed = new URL(urlText);
    const resolved = resolveAppRoute({ pathname: parsed.pathname, search: parsed.search });
    assert.equal(resolved.surface, "pwa");
    assert.equal(resolved.scenarioParam, scenario.id);
  }

  assert.throws(
    () => buildScenarioShareUrl("https://holdup.fi", "not_a_scenario" as DemoScenarioId),
    /Unknown demo scenario/
  );

  assert.throws(
    () => buildScenarioShareUrl("javascript:alert(1)", "amlodipine_match"),
    /Unsupported share URL protocol/
  );
});
