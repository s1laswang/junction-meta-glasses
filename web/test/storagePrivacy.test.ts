import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Profile } from "../../shared/types.ts";
import type { Consent, Settings } from "../src/lib/storage.ts";

type StorageHarness = {
  storage: Storage;
  setThrowOnRead: (v: boolean) => void;
  setThrowOnWrite: (v: boolean) => void;
};

function createStorageHarness(): StorageHarness {
  let throwOnRead = false;
  let throwOnWrite = false;
  const proto = {
    get length(): number {
      return Object.keys(instance).length;
    },
    key(index: number): string | null {
      return Object.keys(instance)[index] ?? null;
    },
    getItem(key: string): string | null {
      if (throwOnRead) throw new Error("SecurityError");
      return Object.prototype.hasOwnProperty.call(instance, key) ? instance[key] : null;
    },
    setItem(key: string, value: string): void {
      if (throwOnWrite) throw new Error("QuotaExceededError");
      instance[key] = String(value);
    },
    removeItem(key: string): void {
      if (throwOnWrite) throw new Error("SecurityError");
      delete instance[key];
    },
    clear(): void {
      if (throwOnWrite) throw new Error("SecurityError");
      for (const k of Object.keys(instance)) delete instance[k];
    },
  };
  const instance = Object.create(proto) as Record<string, string> & Storage;
  return {
    storage: instance,
    setThrowOnRead(v: boolean) {
      throwOnRead = v;
    },
    setThrowOnWrite(v: boolean) {
      throwOnWrite = v;
    },
  };
}

type EnvOptions = {
  language?: string;
  omitNavigator?: boolean;
  origin?: string;
  search?: string;
  initialCaches?: string[];
  withCaches?: boolean;
  cachesThrows?: boolean;
};

type EnvHandles = {
  local: StorageHarness;
  session: StorageHarness;
  cacheBucketNames: Set<string>;
};

const DEFAULT_ORIGIN = ["https:", "", "holdup.example"].join("/");

function installBrowserEnv(opts: EnvOptions = {}): EnvHandles {
  const local = createStorageHarness();
  const session = createStorageHarness();
  const cacheBucketNames = new Set<string>(opts.initialCaches ?? []);
  const withCaches = opts.withCaches ?? true;
  const cachesThrows = opts.cachesThrows ?? false;

  const cacheMock = {
    async keys(): Promise<string[]> {
      if (cachesThrows) throw new Error("CacheError");
      return Array.from(cacheBucketNames);
    },
    async delete(name: string): Promise<boolean> {
      if (cachesThrows) throw new Error("CacheError");
      return cacheBucketNames.delete(name);
    },
  };

  const win: Record<string, unknown> = {
    speechSynthesis: {
      cancel() {},
      speak() {},
    },
  };

  if (withCaches) {
    win.caches = cacheMock;
    Object.defineProperty(globalThis, "caches", { value: cacheMock, configurable: true, writable: true });
  } else {
    Reflect.deleteProperty(globalThis, "caches");
  }

  Object.defineProperty(globalThis, "React", { value: React, configurable: true, writable: true });
  Object.defineProperty(globalThis, "localStorage", { value: local.storage, configurable: true, writable: true });
  Object.defineProperty(globalThis, "sessionStorage", { value: session.storage, configurable: true, writable: true });
  Object.defineProperty(globalThis, "window", { value: win, configurable: true, writable: true });
  Object.defineProperty(globalThis, "location", {
    value: { origin: opts.origin ?? DEFAULT_ORIGIN, search: opts.search ?? "" },
    configurable: true,
    writable: true,
  });

  if (opts.omitNavigator) {
    Object.defineProperty(globalThis, "navigator", { value: undefined, configurable: true, writable: true });
  } else {
    Object.defineProperty(globalThis, "navigator", {
      value: { language: opts.language ?? "en-US", vibrate: () => true },
      configurable: true,
      writable: true,
    });
  }

  return { local, session, cacheBucketNames };
}

installBrowserEnv();

const {
  CONSENT_VERSION,
  FEATURES,
  LANGS,
  defaultLang,
  deleteAllData,
  demoProfile,
  emptyMed,
  loadConsent,
  loadProfile,
  loadSettings,
  logDose,
  newMedId,
  saveConsent,
  saveProfile,
  saveSettings,
  sessionCode,
  takenToday,
} = await import("../src/lib/storage.ts");

const { Privacy } = await import("../src/screens/Privacy.tsx");

function decodeHtml(html: string): string {
  return html
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

test("defaultLang resolves en, fi, and sv from browser locale and falls back to en otherwise", () => {
  assert.deepEqual(
    LANGS.map((l) => l.code),
    ["en", "fi", "sv"],
  );

  installBrowserEnv({ language: "en-GB" });
  assert.equal(defaultLang(), "en");

  installBrowserEnv({ language: "fi-FI" });
  assert.equal(defaultLang(), "fi");

  installBrowserEnv({ language: "SV-SE" });
  assert.equal(defaultLang(), "sv");

  installBrowserEnv({ language: "de-DE" });
  assert.equal(defaultLang(), "en");

  installBrowserEnv({ language: "" });
  assert.equal(defaultLang(), "en");

  installBrowserEnv({ omitNavigator: true });
  assert.equal(defaultLang(), "en");
});

test("demoProfile returns three Nordic demo meds, allergies, NSAID avoid rule, empty doseLog, and fresh copies without persisting", () => {
  installBrowserEnv({ language: "fi-FI" });
  const first = demoProfile();
  const second = demoProfile();

  assert.equal(first.lang, "fi");
  assert.equal(first.meds.length, 3);
  assert.deepEqual(
    first.meds.map((m) => ({ id: m.id, name: m.name, strength: m.strength, gtin: m.gtin })),
    [
      { id: "amlodipine", name: "Amlodipine", strength: "5 mg", gtin: "06416542002149" },
      { id: "metformin", name: "Metformin", strength: "500 mg", gtin: "06416542003375" },
      { id: "atorvastatin", name: "Atorvastatin", strength: "20 mg", gtin: "06416542004860" },
    ],
  );
  assert.deepEqual(first.allergies, ["tree nuts", "peanut"]);
  assert.deepEqual(first.avoid, ["NSAIDs"]);
  assert.deepEqual(first.doseLog, []);
  assert.equal(localStorage.getItem("holdup.profile"), null);

  first.allergies.push("milk");
  first.meds[0].strength = "10 mg";
  assert.deepEqual(second.allergies, ["tree nuts", "peanut"]);
  assert.equal(second.meds[0].strength, "5 mg");
});

test("loadProfile falls back to demoProfile when empty and saveProfile round-trips custom profile in localStorage only", () => {
  installBrowserEnv({ language: "sv-SE" });
  const fallback = loadProfile();
  assert.equal(fallback.lang, "sv");
  assert.equal(fallback.meds.length, 3);
  assert.equal(localStorage.getItem("holdup.profile"), null);

  const custom: Profile = {
    lang: "fi",
    meds: [
      {
        id: "bisoprolol-a1b2",
        name: "Bisoprolol Orion",
        ingredient: "bisoprolol",
        strength: "2.5 mg",
        schedule: ["morning"],
        barcode: "6432100012345",
        gtin: "06432100012345",
        notes: "Heart rate",
      },
    ],
    allergies: ["sesame"],
    avoid: ["grapefruit"],
    doseLog: [{ medId: "bisoprolol-a1b2", ts: 1763100000000 }],
  };

  saveProfile(custom);
  assert.deepEqual(Object.keys(localStorage), ["holdup.profile"]);
  assert.deepEqual(loadProfile(), custom);
});

test("corrupted JSON, null payloads, outdated consent version, partial settings, and blocked storage never throw", () => {
  const { local } = installBrowserEnv({ language: "en-US" });

  localStorage.setItem("holdup.profile", "{corrupted-json");
  localStorage.setItem("holdup.consent", "not-valid-json[");
  localStorage.setItem("holdup.settings", "{truncated:");

  const profileAfterCorrupt = loadProfile();
  assert.equal(profileAfterCorrupt.meds.length, 3);
  assert.equal(profileAfterCorrupt.meds[0].id, "amlodipine");
  assert.equal(loadConsent(), null);

  const defaultSettings = loadSettings();
  assert.deepEqual(defaultSettings, {
    source: "phone",
    voice: true,
    haptics: true,
    earcons: true,
    showPanel: false,
    features: { scene: true, datamatrix: true, addmed: true, sonar: true },
    sonarVolume: 0.35,
    quiet: false,
  });

  localStorage.setItem("holdup.profile", "null");
  assert.equal(loadProfile().meds.length, 3);

  localStorage.setItem("holdup.consent", JSON.stringify({ version: CONSENT_VERSION + 1, ts: 1763150000000 }));
  assert.equal(loadConsent(), null);
  localStorage.setItem("holdup.consent", JSON.stringify({ version: 0, ts: 1763150000000 }));
  assert.equal(loadConsent(), null);

  localStorage.setItem("holdup.settings", JSON.stringify({ quiet: true, features: { sonar: false } }));
  const mergedSettings = loadSettings();
  assert.equal(mergedSettings.quiet, true);
  assert.equal(mergedSettings.voice, true);
  assert.deepEqual(mergedSettings.features, { scene: true, datamatrix: true, addmed: true, sonar: false });

  local.setThrowOnRead(true);
  assert.equal(loadProfile().meds.length, 3);
  assert.equal(loadConsent(), null);
  assert.equal(loadSettings().sonarVolume, 0.35);
  assert.match(sessionCode(), /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);

  local.setThrowOnRead(false);
  local.setThrowOnWrite(true);
  assert.doesNotThrow(() => saveProfile(demoProfile()));
  assert.doesNotThrow(() => saveConsent());
  assert.doesNotThrow(() => saveSettings(defaultSettings));
  assert.match(sessionCode(), /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);
});

test("saveConsent and loadConsent store versioned timestamp under holdup.consent", () => {
  installBrowserEnv();
  assert.equal(CONSENT_VERSION, 1);
  assert.equal(loadConsent(), null);

  const before = Date.now();
  saveConsent();
  const after = Date.now();

  const stored = loadConsent();
  assert.ok(stored !== null);
  assert.equal(stored.version, CONSENT_VERSION);
  assert.ok(stored.ts >= before && stored.ts <= after);
});

test("logDose and takenToday persist doses immutably, respect local midnight boundary, and cap doseLog at 200 entries", () => {
  installBrowserEnv();
  const base = demoProfile();
  assert.equal(takenToday(base, "amlodipine"), false);

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const yesterdayProfile: Profile = {
    ...base,
    doseLog: [{ medId: "amlodipine", ts: startOfToday.getTime() - 1 }],
  };
  assert.equal(takenToday(yesterdayProfile, "amlodipine"), false);

  const midnightProfile: Profile = {
    ...base,
    doseLog: [{ medId: "amlodipine", ts: startOfToday.getTime() }],
  };
  assert.equal(takenToday(midnightProfile, "amlodipine"), true);
  assert.equal(takenToday(midnightProfile, "metformin"), false);

  const logged = logDose(base, "amlodipine");
  assert.equal(base.doseLog.length, 0);
  assert.equal(logged.doseLog.length, 1);
  assert.equal(logged.doseLog[0].medId, "amlodipine");
  assert.equal(takenToday(logged, "amlodipine"), true);
  assert.equal(takenToday(loadProfile(), "amlodipine"), true);

  const overfull: Profile = {
    ...base,
    doseLog: Array.from({ length: 205 }, (_, idx) => ({ medId: `med-${idx}`, ts: 1763000000000 + idx })),
  };
  const capped = logDose(overfull, "atorvastatin");
  assert.equal(capped.doseLog.length, 200);
  assert.equal(capped.doseLog[0].medId, "med-6");
  assert.equal(capped.doseLog[199].medId, "atorvastatin");
  assert.equal(loadProfile().doseLog.length, 200);
});

test("newMedId, emptyMed, and sessionCode obey formatting and unambiguous alphabet rules", () => {
  installBrowserEnv();

  const idA = newMedId("  Amlodipine Besilate 5 mg! ");
  assert.match(idA, /^amlodipine-besilate-5-mg-[a-z0-9]{4}$/);

  const idFallback = newMedId("!!!");
  assert.match(idFallback, /^med-[a-z0-9]{4}$/);

  assert.deepEqual(emptyMed(), { id: "", name: "", ingredient: "", strength: "", schedule: [] });

  const generated = sessionCode();
  assert.match(generated, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);
  assert.ok(!/[0O1I]/.test(generated));
  assert.equal(localStorage.getItem("holdup.session"), generated);
  assert.equal(sessionCode(), generated);

  Object.defineProperty(globalThis, "location", {
    value: { origin: DEFAULT_ORIGIN, search: "?session=k7p9" },
    configurable: true,
    writable: true,
  });
  assert.equal(sessionCode(), "K7P9");
  assert.equal(localStorage.getItem("holdup.session"), generated);
});

test("deleteAllData wipes every holdup.* localStorage key, sessionStorage, and CacheStorage while preserving non-HoldUp keys", async () => {
  const { local, cacheBucketNames } = installBrowserEnv({
    initialCaches: ["holdup-shell-v1", "holdup-runtime-v1"],
  });

  const populated = logDose(demoProfile(), "amlodipine");
  saveProfile(populated);
  saveConsent();
  saveSettings({ ...loadSettings(), quiet: true, sonarVolume: 0.7 });
  sessionCode();
  localStorage.setItem("holdup.hud.speak", "1");
  localStorage.setItem("holdup.key", "demo-secret");
  localStorage.setItem("other.origin.key", "keep-this");
  sessionStorage.setItem("holdup.ephemeral", "active");
  sessionStorage.setItem("tab.state", "1");

  assert.equal(cacheBucketNames.size, 2);

  await deleteAllData();

  const remainingKeys = Object.keys(localStorage);
  assert.deepEqual(remainingKeys, ["other.origin.key"]);
  assert.equal(localStorage.getItem("holdup.profile"), null);
  assert.equal(localStorage.getItem("holdup.consent"), null);
  assert.equal(localStorage.getItem("holdup.settings"), null);
  assert.equal(localStorage.getItem("holdup.session"), null);
  assert.equal(localStorage.getItem("holdup.hud.speak"), null);
  assert.equal(localStorage.getItem("holdup.key"), null);
  assert.equal(localStorage.getItem("other.origin.key"), "keep-this");
  assert.equal(sessionStorage.length, 0);
  assert.equal(cacheBucketNames.size, 0);

  assert.equal(loadConsent(), null);
  assert.deepEqual(loadProfile().doseLog, []);
  assert.equal(loadSettings().quiet, false);

  installBrowserEnv({ withCaches: false });
  saveConsent();
  await deleteAllData();
  assert.equal(loadConsent(), null);

  installBrowserEnv({ cachesThrows: true });
  local.setThrowOnWrite(true);
  await assert.doesNotReject(() => deleteAllData());
});

test("Privacy SSR markup discloses check-only camera and mic, memory-only Gemini zero-retention, phone-only storage, and delete-all irreversibility", () => {
  installBrowserEnv({ origin: DEFAULT_ORIGIN });

  const html = renderToStaticMarkup(
    createElement(Privacy, {
      consent: null,
      onWithdraw: () => {},
      onReviewConsent: () => {},
      onDeleteAll: () => {},
    }),
  );
  const text = decodeHtml(html);

  for (const [id, title] of [
    ["data-h", "Your data"],
    ["feat-h", "Features"],
    ["fb-h", "Feedback"],
    ["hud-h", "Ray-Ban Display"],
    ["del-h", "Delete everything"],
  ] as const) {
    assert.ok(html.includes(`aria-labelledby="${id}"`));
    assert.ok(html.includes(`<h2 id="${id}">${title}</h2>`));
  }

  assert.ok(text.includes("Camera and microphone"));
  assert.ok(
    text.includes(
      "On only during a check. Pictures (at most one per second) and your voice go over an encrypted connection to Google's Gemini AI to read the label. HoldUp keeps them in memory only and never saves them.",
    ),
  );

  assert.ok(text.includes("On this phone only"));
  assert.ok(
    text.includes(
      "Your medicine list, allergies, avoid list, dose log and settings. They are sent along with a check so the answer is about you, and are not kept on the server.",
    ),
  );

  assert.ok(text.includes("Not given. The camera stays off."));
  assert.ok(html.includes('<button class="btn small primary">Review and agree</button>'));
  assert.ok(!text.includes("Withdraw consent"));

  assert.ok(text.includes(`${DEFAULT_ORIGIN}/hud`));

  assert.ok(
    text.includes(
      "Removes your medicines, allergies, dose log, settings and consent from this phone, and clears the offline copy of the app. This can't be undone.",
    ),
  );
  assert.match(html, /<button class="btn danger"><svg[^>]*aria-hidden="true"[^>]*focusable="false"[^>]*>.*<\/svg> Delete all my data<\/button>/);

  assert.ok(text.includes("HoldUp is not a medical device. When it isn't sure, it says so. Ask a pharmacist about anything uncertain."));
});

test("Privacy SSR markup reflects active consent timestamp with Withdraw consent and mirrors stored feature and feedback switch settings", () => {
  installBrowserEnv({ origin: DEFAULT_ORIGIN });
  const customSettings: Settings = {
    source: "glasses",
    voice: false,
    haptics: false,
    earcons: true,
    showPanel: true,
    features: { scene: true, datamatrix: false, addmed: true, sonar: true },
    sonarVolume: 0.8,
    quiet: true,
  };
  saveSettings(customSettings);

  const consent: Consent = { version: CONSENT_VERSION, ts: 1763150400000 };
  const htmlWithSonar = renderToStaticMarkup(
    createElement(Privacy, {
      consent,
      onWithdraw: () => {},
      onReviewConsent: () => {},
      onDeleteAll: () => {},
    }),
  );
  const textWithSonar = decodeHtml(htmlWithSonar);

  assert.ok(textWithSonar.includes(`You agreed on ${new Date(consent.ts).toLocaleString()}.`));
  assert.ok(!textWithSonar.includes("Not given. The camera stays off."));
  assert.ok(htmlWithSonar.includes('<button class="btn small">Withdraw consent</button>'));
  assert.ok(!textWithSonar.includes("Review and agree"));

  for (const f of FEATURES) {
    assert.ok(htmlWithSonar.includes(`aria-describedby="feat-${f.flag}"`));
    assert.ok(htmlWithSonar.includes(`id="feat-${f.flag}"`));
    assert.ok(textWithSonar.includes(f.label));
    assert.ok(textWithSonar.includes(f.help));
  }

  const switchMatches = htmlWithSonar.match(/role="switch"/g) ?? [];
  assert.equal(switchMatches.length, 8);

  assert.match(htmlWithSonar, /<input type="checkbox" role="switch" aria-describedby="feat-scene" checked=""\/>/);
  assert.match(htmlWithSonar, /<input type="checkbox" role="switch" aria-describedby="feat-datamatrix"\/>/);
  assert.match(htmlWithSonar, /<input type="checkbox" role="switch" aria-describedby="feat-addmed" checked=""\/>/);
  assert.match(htmlWithSonar, /<input type="checkbox" role="switch" aria-describedby="feat-sonar" checked=""\/>/);
  assert.match(htmlWithSonar, /Quiet mode \(no readiness tone, softer sounds\)<input type="checkbox" role="switch" checked=""\/>/);
  assert.match(htmlWithSonar, /Spoken answers<input type="checkbox" role="switch"\/>/);
  assert.match(htmlWithSonar, /Sounds \(earcons\)<input type="checkbox" role="switch" checked=""\/>/);
  assert.match(htmlWithSonar, /Vibration<input type="checkbox" role="switch"\/>/);

  assert.ok(textWithSonar.includes("Readiness tone volume: 80%"));
  assert.ok(htmlWithSonar.includes('id="sonar-vol"'));
  assert.ok(htmlWithSonar.includes('aria-valuetext="80 percent"'));

  saveSettings({ ...customSettings, features: { ...customSettings.features, sonar: false } });
  const htmlWithoutSonar = renderToStaticMarkup(
    createElement(Privacy, {
      consent,
      onWithdraw: () => {},
      onReviewConsent: () => {},
      onDeleteAll: () => {},
    }),
  );
  assert.ok(!htmlWithoutSonar.includes('id="sonar-vol"'));
});

test("Privacy end-to-end consent, dose log, deleteAllData reset, and confirmation and assertive withdraw contracts", async () => {
  installBrowserEnv({ origin: DEFAULT_ORIGIN, initialCaches: ["holdup-pwa-v1"] });
  saveConsent();
  logDose(demoProfile(), "metformin");
  saveSettings({ ...loadSettings(), sonarVolume: 0.9, quiet: true });

  const beforeHtml = renderToStaticMarkup(
    createElement(Privacy, {
      consent: loadConsent(),
      onWithdraw: () => {},
      onReviewConsent: () => {},
      onDeleteAll: () => {},
    }),
  );
  assert.ok(decodeHtml(beforeHtml).includes("Withdraw consent"));
  assert.ok(decodeHtml(beforeHtml).includes("Readiness tone volume: 90%"));
  assert.equal(takenToday(loadProfile(), "metformin"), true);

  await deleteAllData();

  const afterHtml = renderToStaticMarkup(
    createElement(Privacy, {
      consent: loadConsent(),
      onWithdraw: () => {},
      onReviewConsent: () => {},
      onDeleteAll: () => {},
    }),
  );
  const afterText = decodeHtml(afterHtml);
  assert.ok(afterText.includes("Not given. The camera stays off."));
  assert.ok(afterText.includes("Review and agree"));
  assert.ok(afterText.includes("Readiness tone volume: 35%"));
  assert.equal(takenToday(loadProfile(), "metformin"), false);

  const privacySrc = readFileSync(new URL("../src/screens/Privacy.tsx", import.meta.url), "utf8");
  assert.ok(privacySrc.includes('confirm("Delete all your HoldUp data from this phone? This can\'t be undone.")'));
  assert.ok(privacySrc.includes('announce("Consent withdrawn. The camera will stay off.", "assertive")'));
});
