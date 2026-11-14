import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Med } from "../../shared/types.ts";

const store = new Map<string, string>();

const storageShim = {
  get length() {
    return store.size;
  },
  key(index: number): string | null {
    return Array.from(store.keys())[index] ?? null;
  },
  getItem(key: string): string | null {
    return store.has(key) ? store.get(key)! : null;
  },
  setItem(key: string, value: string): void {
    store.set(key, String(value));
  },
  removeItem(key: string): void {
    store.delete(key);
  },
  clear(): void {
    store.clear();
  },
};

type EnvOptions = {
  ua?: string;
  isSecureContext?: boolean;
  touchEnd?: boolean;
  hasMediaDevices?: boolean;
  permissionState?: "granted" | "denied" | "prompt" | "throw";
};

function installBrowserShims(opts: EnvOptions = {}): void {
  const ua = opts.ua ?? "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36";
  const isSecureContext = opts.isSecureContext ?? true;
  const hasMediaDevices = opts.hasMediaDevices ?? true;
  const permissionState = opts.permissionState ?? "prompt";

  const win = {
    isSecureContext,
    speechSynthesis: {
      cancel() {},
      speak() {},
    },
  };

  const nav = {
    userAgent: ua,
    language: "en-US",
    vibrate: () => true,
    mediaDevices: hasMediaDevices
      ? {
          getUserMedia: async () => ({
            getTracks: () => [{ stop() {} }],
          }),
          enumerateDevices: async () => [],
        }
      : undefined,
    permissions: {
      query: async () => {
        if (permissionState === "throw") throw new Error("unsupported");
        return { state: permissionState };
      },
    },
  };

  const doc: Record<string, unknown> = opts.touchEnd ? { ontouchend: null } : {};

  Object.defineProperty(globalThis, "React", { value: React, configurable: true, writable: true });
  Object.defineProperty(globalThis, "localStorage", { value: storageShim, configurable: true, writable: true });
  Object.defineProperty(globalThis, "window", { value: win, configurable: true, writable: true });
  Object.defineProperty(globalThis, "navigator", { value: nav, configurable: true, writable: true });
  Object.defineProperty(globalThis, "document", { value: doc, configurable: true, writable: true });
}

installBrowserShims();

const { Consent, PermissionStep, PermissionRecovery } = await import("../src/screens/Onboarding.tsx");
const { AddSheet } = await import("../src/components/AddSheet.tsx");
const { Announcer } = await import("../src/components/Announcer.tsx");
const { announce, onAnnounce } = await import("../src/lib/feedback.ts");
const { classifyError, explain, mediaSupported, platformHint, queryPermission } = await import("../src/lib/media.ts");

function decodeHtml(html: string): string {
  return html
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

test("Consent renders main.onb, focusable h1 HoldUp, tagline, privacy lead-in, and primary Continue button", () => {
  const html = renderToStaticMarkup(createElement(Consent, { onAgree: () => {}, onNotNow: () => {} }));
  const text = decodeHtml(html);

  assert.ok(html.startsWith('<main class="onb">'));
  assert.ok(html.includes('<h1 tabindex="-1">HoldUp</h1>'));
  assert.ok(html.includes('<p class="hero-tag">'));
  assert.ok(text.includes("Hold it up. Know it's the right one."));
  assert.ok(text.includes("First, three short things about your privacy."));
  assert.ok(html.includes('<button class="btn primary wide">Continue</button>'));
  assert.ok(html.includes('aria-hidden="true"'));
  assert.ok(html.includes('focusable="false"'));
  assert.ok(!text.includes("I agree"));
});

test("Consent cards cover 45-second auto-stop, memory-only Gemini processing, face/bystander ignore, phone-only storage, 1-button delete, and non-medical pharmacist guidance", () => {
  const src = readFileSync(new URL("../src/screens/Onboarding.tsx", import.meta.url), "utf8");

  assert.ok(src.includes("What HoldUp captures"));
  assert.ok(src.includes("turns off by itself after 45 seconds without a label"));
  assert.ok(src.includes("CAMERA ON sign and a sound"));
  assert.ok(src.includes("No pictures are taken in the background, ever."));

  assert.ok(src.includes("Where it goes"));
  assert.ok(src.includes("Google's Gemini AI"));
  assert.ok(src.includes("HoldUp handles them in memory and does not store your pictures, audio or what you said."));
  assert.ok(src.includes("People in view are ignored. HoldUp never describes faces."));

  assert.ok(src.includes("What stays on this phone"));
  assert.ok(src.includes("Your medicine list, allergies and dose log are saved only on this phone."));
  assert.ok(src.includes("You can delete everything with one button in Privacy."));
  assert.ok(src.includes("HoldUp is not a medical device. It never guesses a dose, and when it isn't sure it tells you to ask a pharmacist."));
});

test("Consent step cards wire ARIA progressbar attributes and explicit I agree, Not now, Next, and Back controls", () => {
  const src = readFileSync(new URL("../src/screens/Onboarding.tsx", import.meta.url), "utf8");

  assert.ok(src.includes('role="progressbar"'));
  assert.ok(src.includes('aria-label="Privacy explanation"'));
  assert.ok(src.includes("aria-valuemin={1}"));
  assert.ok(src.includes("aria-valuemax={CARDS.length}"));
  assert.ok(src.includes("aria-valuenow={i + 1}"));
  assert.ok(src.includes("I agree"));
  assert.ok(src.includes("Not now"));
  assert.ok(src.includes("Next"));
  assert.ok(src.includes("Back"));
});

test("PermissionStep explains camera and mic in context before prompting and offers Allow camera and microphone plus Not now", () => {
  installBrowserShims();
  const html = renderToStaticMarkup(createElement(PermissionStep, { onDone: () => {} }));
  const text = decodeHtml(html);

  assert.ok(html.startsWith('<main class="onb">'));
  assert.ok(html.includes('<h1 tabindex="-1">Camera and microphone</h1>'));
  assert.ok(text.includes("To read a label, HoldUp needs to see it and hear your question. Your phone will ask you to allow both."));
  assert.ok(text.includes("The camera is only on during a check, and you'll always hear and see when it is."));
  assert.ok(text.includes('The microphone lets you ask "is this my evening pill?" without touching the screen.'));
  assert.ok(html.includes('aria-busy="false">Allow camera and microphone</button>'));
  assert.ok(html.includes('<button class="btn wide">Not now</button>'));
});

test("media.ts classifyError, explain, mediaSupported, queryPermission, and platformHint handle all states and platforms", async () => {
  assert.equal(classifyError({ name: "NotAllowedError" }), "denied");
  assert.equal(classifyError({ name: "PermissionDeniedError" }), "denied");
  assert.equal(classifyError({ name: "NotFoundError" }), "unavailable");
  assert.equal(classifyError({ name: "DevicesNotFoundError" }), "unavailable");
  assert.equal(classifyError({ name: "OverconstrainedError" }), "unavailable");
  assert.equal(classifyError({ name: "NotReadableError" }), "in-use");
  assert.equal(classifyError({ name: "TrackStartError" }), "in-use");
  assert.equal(classifyError({ name: "AbortError" }), "in-use");
  assert.equal(classifyError({ name: "SecurityError" }), "insecure");
  assert.equal(classifyError({}), "denied");
  assert.equal(classifyError(null), "denied");

  assert.equal(explain("camera", "denied"), "You said no to the camera. That's fine. You can turn it on any time.");
  assert.equal(explain("mic", "denied"), "You said no to the microphone. That's fine. You can turn it on any time.");
  assert.equal(explain("camera", "blocked"), "The camera is blocked for this site in your browser settings.");
  assert.equal(explain("mic", "unavailable"), "This device has no microphone that HoldUp can use.");
  assert.equal(explain("camera", "in-use"), "Another app is using the camera. Close it and try again.");
  assert.equal(explain("camera", "insecure"), "The camera needs a secure (https) connection. Open HoldUp through its https link.");
  assert.equal(explain("camera", "granted"), "");
  assert.equal(explain("mic", "unknown"), "");

  installBrowserShims({ ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1" });
  assert.equal(platformHint(), "ios");

  installBrowserShims({ ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15", touchEnd: true });
  assert.equal(platformHint(), "ios");

  installBrowserShims({ ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15", touchEnd: false });
  assert.equal(platformHint(), "desktop");

  installBrowserShims({ ua: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36" });
  assert.equal(platformHint(), "android");

  installBrowserShims({ ua: "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0" });
  assert.equal(platformHint(), "desktop");

  installBrowserShims({ isSecureContext: false });
  assert.equal(await queryPermission("camera"), "insecure");

  installBrowserShims({ hasMediaDevices: false });
  assert.equal(mediaSupported(), false);
  assert.equal(await queryPermission("camera"), "unavailable");

  installBrowserShims({ permissionState: "granted" });
  assert.equal(mediaSupported(), true);
  assert.equal(await queryPermission("camera"), "granted");

  installBrowserShims({ permissionState: "denied" });
  assert.equal(await queryPermission("microphone"), "blocked");

  installBrowserShims({ permissionState: "prompt" });
  assert.equal(await queryPermission("camera"), "prompt");

  installBrowserShims({ permissionState: "throw" });
  assert.equal(await queryPermission("camera"), "unknown");
});

test("PermissionRecovery renders focusable camera-denied h1 and photo/typing fallback card when camera is denied", () => {
  installBrowserShims();
  const html = renderToStaticMarkup(
    createElement(PermissionRecovery, {
      result: { camera: "denied", mic: "granted" },
      onRetry: () => {},
      onContinue: () => {},
    }),
  );
  const text = decodeHtml(html);

  assert.ok(text.includes('<h1 tabindex="-1">HoldUp can\'t use the camera yet</h1>'));
  assert.ok(text.includes("You said no to the camera. That's fine. You can turn it on any time."));
  assert.ok(!text.includes("You said no to the microphone."));
  assert.ok(html.includes('<section class="card stack" aria-labelledby="without">'));
  assert.ok(html.includes('<h2 id="without">You can still use HoldUp</h2>'));
  assert.ok(
    text.includes(
      "Take a photo of the label with your phone's camera app button, or type what the box says. HoldUp checks it against your list and reads the answer out.",
    ),
  );
  assert.ok(text.includes("Try again"));
  assert.ok(text.includes("Continue without the camera"));
});

test("PermissionRecovery renders focusable mic-only h1 and typed-question fallback card when only mic is denied", () => {
  installBrowserShims();
  const html = renderToStaticMarkup(
    createElement(PermissionRecovery, {
      result: { camera: "granted", mic: "denied" },
      onRetry: () => {},
      onContinue: () => {},
    }),
  );
  const text = decodeHtml(html);

  assert.ok(text.includes('<h1 tabindex="-1">HoldUp can\'t use the microphone yet</h1>'));
  assert.ok(text.includes("You said no to the microphone. That's fine. You can turn it on any time."));
  assert.ok(!text.includes("You said no to the camera."));
  assert.ok(html.includes('<h2 id="without">You can still use HoldUp</h2>'));
  assert.ok(text.includes("Type your question instead of speaking. Answers are still read out loud."));
  assert.ok(text.includes("Continue without the microphone"));
});

test("PermissionRecovery renders combined camera-or-microphone h1 and Continue without them when both are denied", () => {
  installBrowserShims();
  const html = renderToStaticMarkup(
    createElement(PermissionRecovery, {
      result: { camera: "denied", mic: "blocked" },
      onRetry: () => {},
      onContinue: () => {},
    }),
  );
  const text = decodeHtml(html);

  assert.ok(text.includes('<h1 tabindex="-1">HoldUp can\'t use the camera or microphone yet</h1>'));
  assert.ok(text.includes("You said no to the camera. That's fine. You can turn it on any time."));
  assert.ok(text.includes("The microphone is blocked for this site in your browser settings."));
  assert.ok(html.includes('<h2 id="without">You can still use HoldUp</h2>'));
  assert.ok(text.includes("Take a photo of the label with your phone's camera app button"));
  assert.ok(text.includes("Continue without them"));
});

test("PermissionRecovery omits #howto browser permission steps when result.camera is insecure HTTP", () => {
  installBrowserShims();
  for (const result of [
    { camera: "insecure" as const, mic: "insecure" as const },
    { camera: "insecure" as const, mic: "denied" as const },
  ]) {
    const html = renderToStaticMarkup(
      createElement(PermissionRecovery, {
        result,
        onRetry: () => {},
        onContinue: () => {},
      }),
    );
    const text = decodeHtml(html);

    assert.ok(!html.includes('id="howto"'));
    assert.ok(!html.includes('aria-labelledby="howto"'));
    assert.ok(text.includes("The camera needs a secure (https) connection. Open HoldUp through its https link."));
    assert.ok(html.includes('<h2 id="without">You can still use HoldUp</h2>'));
  }
});

test("PermissionRecovery renders platform-specific #howto steps for ios Safari, android Chrome, and other browsers", () => {
  const deniedBoth = { camera: "blocked" as const, mic: "denied" as const };

  installBrowserShims({ ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1" });
  const iosHtml = renderToStaticMarkup(createElement(PermissionRecovery, { result: deniedBoth, onRetry: () => {}, onContinue: () => {} }));
  const iosText = decodeHtml(iosHtml);
  assert.ok(iosHtml.includes('<section class="card stack" aria-labelledby="howto">'));
  assert.ok(iosHtml.includes('<h2 id="howto">How to turn it on</h2>'));
  assert.ok(iosText.includes("Safari's address bar"));
  assert.ok(iosText.includes('Choose "Website Settings".'));
  assert.ok(iosText.includes("Settings app, then Apps, Safari"));
  assert.ok(!iosText.includes("in Chrome"));

  installBrowserShims({ ua: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36" });
  const androidHtml = renderToStaticMarkup(createElement(PermissionRecovery, { result: deniedBoth, onRetry: () => {}, onContinue: () => {} }));
  const androidText = decodeHtml(androidHtml);
  assert.ok(androidHtml.includes('<h2 id="howto">How to turn it on</h2>'));
  assert.ok(androidText.includes("left of the web address in Chrome"));
  assert.ok(androidText.includes('Tap "Permissions".'));
  assert.ok(androidText.includes("Turn on Camera and Microphone."));
  assert.ok(!androidText.includes("Safari"));

  installBrowserShims({ ua: "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0" });
  const otherHtml = renderToStaticMarkup(createElement(PermissionRecovery, { result: deniedBoth, onRetry: () => {}, onContinue: () => {} }));
  const otherText = decodeHtml(otherHtml);
  assert.ok(otherHtml.includes('<h2 id="howto">How to turn it on</h2>'));
  assert.ok(otherText.includes("Click the icon to the left of the web address."));
  assert.ok(otherText.includes('Set Camera and Microphone to "Allow".'));
  assert.ok(otherText.includes('Reload the page if asked, then press "Try again".'));
  assert.ok(!otherText.includes("Safari"));
  assert.ok(!otherText.includes("in Chrome"));
});

test("AddSheet renders dialog.addsheet with aria-labelledby and aria-describedby, explicit consent copy, and omits duplicate Ingredient row", () => {
  const med: Med = {
    id: "aml",
    name: "Amlodipine",
    ingredient: "amlodipine",
    strength: "5 mg",
    schedule: ["evening"],
  };
  const html = renderToStaticMarkup(
    createElement(AddSheet, {
      med,
      speech: "Add Amlodipine 5 mg for the evening?",
      expiresAt: Date.now() + 60_000,
      onAnswer: () => {},
    }),
  );
  const text = decodeHtml(html);

  assert.ok(html.startsWith('<dialog class="addsheet" aria-labelledby="add-h" aria-describedby="add-d">'));
  assert.ok(html.includes('<h2 id="add-h" class="add-title">Add Amlodipine 5 mg, evening, to your list?</h2>'));
  assert.ok(html.includes('<div id="add-d"'));
  assert.ok(text.includes("Add Amlodipine 5 mg for the evening?"));
  assert.ok(text.includes("Nothing is saved unless you press Add. It's saved on this phone only."));
  assert.ok(html.includes("<dt>Name</dt><dd>Amlodipine</dd>"));
  assert.ok(!html.includes("<dt>Ingredient</dt>"));
  assert.ok(html.includes("<dt>Strength</dt><dd>5 mg</dd>"));
  assert.ok(html.includes("<dt>When</dt><dd>evening</dd>"));
  assert.ok(!html.includes("<dt>Pack code</dt>"));
  assert.ok(text.includes("Add"));
  assert.ok(text.includes("Cancel"));
});

test("AddSheet includes Ingredient and Pack code gtin when distinct or present and formats multi-time or empty schedules", () => {
  const branded: Med = {
    id: "norvasc",
    name: "Norvasc",
    ingredient: "amlodipine",
    strength: "5 mg",
    schedule: ["morning", "evening"],
    gtin: "06416542002149",
  };
  const html = renderToStaticMarkup(
    createElement(AddSheet, {
      med: branded,
      speech: "Add Norvasc 5 mg?",
      expiresAt: Date.now() + 45_000,
      onAnswer: () => {},
    }),
  );

  assert.ok(html.includes('<h2 id="add-h" class="add-title">Add Norvasc 5 mg, morning and evening, to your list?</h2>'));
  assert.ok(html.includes("<dt>Ingredient</dt><dd>amlodipine</dd>"));
  assert.ok(html.includes("<dt>Pack code</dt><dd>06416542002149</dd>"));
  assert.ok(html.includes("<dt>When</dt><dd>morning and evening</dd>"));

  const unscheduledHtml = renderToStaticMarkup(
    createElement(AddSheet, {
      med: { id: "vitd", name: "Colecalciferol", ingredient: "Colecalciferol", strength: "20 mcg", schedule: [] },
      speech: "Add Colecalciferol 20 mcg?",
      expiresAt: Date.now() + 30_000,
      onAnswer: () => {},
    }),
  );
  assert.ok(unscheduledHtml.includes("Add Colecalciferol 20 mcg, no fixed time, to your list?"));
  assert.ok(!unscheduledHtml.includes("<dt>Ingredient</dt>"));
  assert.ok(unscheduledHtml.includes("<dt>When</dt><dd>no fixed time</dd>"));
});

test("AddSheet marks countdown paragraph aria-live=off so screen readers are not interrupted every second", () => {
  const med: Med = {
    id: "aml",
    name: "Amlodipine",
    ingredient: "amlodipine",
    strength: "5 mg",
    schedule: ["evening"],
  };
  const html = renderToStaticMarkup(
    createElement(AddSheet, {
      med,
      speech: "Add Amlodipine 5 mg?",
      expiresAt: Date.now() + 59_000,
      onAnswer: () => {},
    }),
  );

  assert.match(html, /<p[^>]*aria-live="off"[^>]*>Double-tap anywhere to add · closes without adding in \d+ s<\/p>/);
});

test("Announcer renders both sr-only polite status and assertive alert atomic live regions", () => {
  const html = renderToStaticMarkup(createElement(Announcer));
  const announcerSrc = readFileSync(new URL("../src/components/Announcer.tsx", import.meta.url), "utf8");

  assert.ok(html.includes('<div class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>'));
  assert.ok(html.includes('<div class="sr-only" role="alert" aria-live="assertive" aria-atomic="true"></div>'));
  assert.ok(announcerSrc.includes('set("")'));
  assert.ok(announcerSrc.includes("setTimeout(() => set(msg), 60)"));
});

test("feedback.ts onAnnounce and announce deliver polite and assertive messages and unsubscribe cleanly", () => {
  const receivedA: Array<{ msg: string; politeness: "polite" | "assertive" }> = [];
  const receivedB: Array<{ msg: string; politeness: "polite" | "assertive" }> = [];

  const unsubA = onAnnounce((msg, politeness) => {
    receivedA.push({ msg, politeness });
  });
  const unsubB = onAnnounce((msg, politeness) => {
    receivedB.push({ msg, politeness });
  });

  announce("Checking label");
  announce("Warning: wrong strength", "assertive");

  assert.deepEqual(receivedA, [
    { msg: "Checking label", politeness: "polite" },
    { msg: "Warning: wrong strength", politeness: "assertive" },
  ]);
  assert.deepEqual(receivedB, receivedA);

  unsubA();
  announce("Camera stopped", "polite");

  assert.equal(receivedA.length, 2);
  assert.deepEqual(receivedB, [
    { msg: "Checking label", politeness: "polite" },
    { msg: "Warning: wrong strength", politeness: "assertive" },
    { msg: "Camera stopped", politeness: "polite" },
  ]);

  unsubB();
  announce("Ignored after unsubscribe", "assertive");
  assert.equal(receivedB.length, 3);
});
