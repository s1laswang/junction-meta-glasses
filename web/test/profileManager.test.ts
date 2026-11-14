import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ALLERGY_PRESET_CHIPS,
  AVOID_PRESET_CHIPS,
  ProfileManager,
  SCHEDULE_SLOTS,
  addCustomListItem,
  addMedicationToProfile,
  countTodaysDosesForMed,
  formatDoseTimestamp,
  getTodaysDoseEntries,
  logDoseNowInProfile,
  removeListItem,
  removeMedicationFromProfile,
  resolveSupportedLangCode,
  togglePresetItem,
  type ProfileManagerProps
} from "../src/components/ProfileManager.tsx";
import { DEMO_PROFILE, exportCaregiverSummary } from "../src/storage/profileStore.ts";
import type { Profile } from "../src/types.ts";

type TestFn = (name: string, fn: () => void | Promise<void>) => Promise<void>;

type AssertStrict = {
  ok(value: unknown, message?: string): void;
  equal<T>(actual: T, expected: T, message?: string): void;
  notEqual<T>(actual: T, expected: T, message?: string): void;
  deepEqual<T>(actual: T, expected: T, message?: string): void;
  match(value: string, regExp: RegExp, message?: string): void;
  doesNotMatch(value: string, regExp: RegExp, message?: string): void;
};

const nodeTestSpec: string = "node:test";
const nodeAssertSpec: string = "node:assert/strict";

const { test } = (await import(nodeTestSpec)) as { test: TestFn };
const assert = (await import(nodeAssertSpec)) as AssertStrict;

const EM_DASH = "\u2014";
const EN_DASH = "\u2013";
const noop = (): void => {};

function extractOpeningTagByAttr(html: string, attrSnippet: string): string {
  const escaped = attrSnippet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<([a-z0-9]+)\\b[^>]*${escaped}[^>]*>`, "i");
  const match = pattern.exec(html);
  assert.ok(match, `Expected element with attribute snippet ${attrSnippet}`);
  return match ? match[0] : "";
}

test("ProfileManager renders local privacy banner, optional >=56px Import Pharmacy QR button, and 8-language selector", () => {
  const summaryText = exportCaregiverSummary(DEMO_PROFILE);

  const withImportProps: ProfileManagerProps = {
    profile: { ...DEMO_PROFILE, lang: "fi" },
    onChange: noop,
    onResetDemo: noop,
    onUndoLastDose: noop,
    caregiverSummaryText: summaryText,
    onOpenPharmacyImport: noop
  };
  const htmlWithImport = renderToStaticMarkup(createElement(ProfileManager, withImportProps));

  assert.ok(
    htmlWithImport.includes("Stored on this device only. Never saved on any server.")
  );
  assert.ok(htmlWithImport.includes(">Import Pharmacy QR</button>"));
  const importBtn = extractOpeningTagByAttr(
    htmlWithImport,
    'data-action="open-pharmacy-import"'
  );
  assert.ok(importBtn.includes("min-height:56px"));

  for (const code of ["en", "fi", "sv", "de", "es", "fr", "et", "ru"] as const) {
    assert.ok(
      htmlWithImport.includes(`<option value="${code}"`),
      `Missing language option ${code}`
    );
  }
  assert.match(htmlWithImport, /<option value="fi" selected=""/);
  assert.match(htmlWithImport, /<label for="[^"]+"[^>]*>Spoken &amp; Display Language<\/label>/);

  const htmlWithoutImport = renderToStaticMarkup(
    createElement(ProfileManager, {
      profile: DEMO_PROFILE,
      onChange: noop,
      onResetDemo: noop,
      onUndoLastDose: noop,
      caregiverSummaryText: summaryText
    })
  );
  assert.equal(htmlWithoutImport.includes("Import Pharmacy QR"), false);
  assert.equal(htmlWithImport.includes(EM_DASH), false);
  assert.equal(htmlWithoutImport.includes(EM_DASH), false);
});

test("ProfileManager renders all DEMO_PROFILE medications, schedule badges, barcodes, actions, and Add Medication form", () => {
  const html = renderToStaticMarkup(
    createElement(ProfileManager, {
      profile: DEMO_PROFILE,
      onChange: noop,
      onResetDemo: noop,
      onUndoLastDose: noop,
      caregiverSummaryText: exportCaregiverSummary(DEMO_PROFILE),
      onOpenPharmacyImport: noop
    })
  );

  assert.ok(html.includes("3 medications"));

  assert.ok(html.includes("Amlodipin"));
  assert.ok(html.includes("amlodipine"));
  assert.ok(html.includes("5 mg"));
  assert.ok(html.includes("6432100012345"));

  assert.ok(html.includes("Metformin"));
  assert.ok(html.includes("metformin"));
  assert.ok(html.includes("500 mg"));
  assert.ok(html.includes("6432100054321"));

  assert.ok(html.includes("Panadol"));
  assert.ok(html.includes("paracetamol"));
  assert.ok(html.includes("6432100098765"));

  const logAmlBtn = extractOpeningTagByAttr(
    html,
    'data-action="log-dose-now" data-med-id="aml"'
  );
  const removeAmlBtn = extractOpeningTagByAttr(
    html,
    'data-action="remove-medication" data-med-id="aml"'
  );
  assert.ok(logAmlBtn.includes("min-height:56px"));
  assert.ok(removeAmlBtn.includes("min-height:56px"));
  assert.ok(html.includes(">Log Dose Now</button>"));
  assert.ok(html.includes(">Remove</button>"));

  assert.ok(html.includes(">Add Medication</h3>"));
  assert.ok(html.includes(">Medication name</label>"));
  assert.ok(html.includes(">Active ingredient</label>"));
  assert.ok(html.includes(">Strength</label>"));
  assert.ok(html.includes('placeholder="5 mg"'));
  assert.ok(html.includes(">Barcode digits (optional)</label>"));

  for (const slot of SCHEDULE_SLOTS) {
    const checkboxTag = extractOpeningTagByAttr(html, `value="${slot}"`);
    assert.ok(checkboxTag.includes('type="checkbox"'), `Missing checkbox type for ${slot}`);
    assert.ok(checkboxTag.includes('name="schedule"'), `Missing schedule name for ${slot}`);
  }

  const submitAddBtn = extractOpeningTagByAttr(html, 'data-action="submit-add-medication"');
  assert.ok(submitAddBtn.includes("min-height:56px"));
});

test("ProfileManager renders removable allergy and avoid pills plus all preset quick-add chips with aria-pressed", () => {
  const html = renderToStaticMarkup(
    createElement(ProfileManager, {
      profile: DEMO_PROFILE,
      onChange: noop,
      onResetDemo: noop,
      onUndoLastDose: noop,
      caregiverSummaryText: exportCaregiverSummary(DEMO_PROFILE)
    })
  );

  assert.ok(html.includes('aria-label="Remove allergy peanut"'));
  assert.ok(html.includes('aria-label="Remove allergy tree nuts"'));
  assert.ok(html.includes('aria-label="Remove avoid rule NSAIDs"'));

  const expectedAllergyPresets = [
    "Peanut",
    "Tree nuts",
    "Milk / Lactose",
    "Gluten / Wheat",
    "Egg",
    "Soy",
    "Sesame",
    "Shellfish",
    "Penicillin"
  ];
  assert.deepEqual(
    ALLERGY_PRESET_CHIPS.map((c) => c.label),
    expectedAllergyPresets
  );

  for (const label of expectedAllergyPresets) {
    const tag = extractOpeningTagByAttr(html, `data-preset-allergy="${label}"`);
    assert.ok(tag.includes("min-height:56px"));
    const shouldBePressed = label === "Peanut" || label === "Tree nuts";
    assert.ok(
      tag.includes(`aria-pressed="${String(shouldBePressed)}"`),
      `Expected aria-pressed=${String(shouldBePressed)} for ${label}`
    );
  }

  const expectedAvoidPresets = [
    "NSAIDs",
    "Aspirin",
    "Anticoagulants",
    "Beta blockers",
    "ACE inhibitors",
    "Statins"
  ];
  assert.deepEqual(
    AVOID_PRESET_CHIPS.map((c) => c.label),
    expectedAvoidPresets
  );

  for (const label of expectedAvoidPresets) {
    const tag = extractOpeningTagByAttr(html, `data-preset-avoid="${label}"`);
    assert.ok(tag.includes("min-height:56px"));
    const shouldBePressed = label === "NSAIDs";
    assert.ok(
      tag.includes(`aria-pressed="${String(shouldBePressed)}"`),
      `Expected aria-pressed=${String(shouldBePressed)} for ${label}`
    );
  }
});

test("ProfileManager renders reverse-chronological Today's Dose Log, HH:MM timestamps, and action buttons", () => {
  const emptyHtml = renderToStaticMarkup(
    createElement(ProfileManager, {
      profile: DEMO_PROFILE,
      onChange: noop,
      onResetDemo: noop,
      onUndoLastDose: noop,
      caregiverSummaryText: "Caregiver summary line"
    })
  );
  assert.ok(emptyHtml.includes("No doses logged yet today."));
  const disabledUndoBtn = extractOpeningTagByAttr(emptyHtml, 'data-action="undo-last-dose"');
  assert.match(disabledUndoBtn, /\sdisabled(?:=""|\s|>)/);
  assert.ok(disabledUndoBtn.includes('aria-disabled="true"'));

  const now = new Date();
  const baseDay = new Date(now);
  baseDay.setHours(0, 0, 0, 0);
  const firstTs = baseDay.getTime() + 60_000;
  const secondTs = baseDay.getTime() + 120_000;
  const yesterdayTs = baseDay.getTime() - 3_600_000;

  const populatedProfile: Profile = {
    ...DEMO_PROFILE,
    doseLog: [
      { medId: "par", ts: yesterdayTs },
      { medId: "met", ts: firstTs },
      { medId: "aml", ts: secondTs }
    ]
  };

  const populatedHtml = renderToStaticMarkup(
    createElement(ProfileManager, {
      profile: populatedProfile,
      onChange: noop,
      onResetDemo: noop,
      onUndoLastDose: noop,
      caregiverSummaryText: "HoldUp Caregiver Summary Preview"
    })
  );

  assert.ok(populatedHtml.includes("2 doses today"));
  const expectedFirstTime = formatDoseTimestamp(firstTs);
  const expectedSecondTime = formatDoseTimestamp(secondTs);
  assert.match(expectedFirstTime, /^\d{2}:\d{2}$/);
  assert.match(expectedSecondTime, /^\d{2}:\d{2}$/);

  const listStart = populatedHtml.indexOf('class="profile-dose-log-list"');
  assert.ok(listStart >= 0, "Expected dose log list in SSR markup");
  const listSlice = populatedHtml.slice(listStart);

  const amlIdx = listSlice.indexOf("Amlodipin 5 mg");
  const metIdx = listSlice.indexOf("Metformin 500 mg");
  assert.ok(amlIdx >= 0, "Expected Amlodipin 5 mg in dose log");
  assert.ok(metIdx >= 0, "Expected Metformin 500 mg in dose log");
  assert.ok(amlIdx < metIdx, "Expected newest dose (Amlodipin) before older dose (Metformin)");
  assert.equal(listSlice.includes("Panadol 500 mg"), false);
  assert.ok(listSlice.includes(expectedFirstTime));
  assert.ok(listSlice.includes(expectedSecondTime));

  const enabledUndoBtn = extractOpeningTagByAttr(populatedHtml, 'data-action="undo-last-dose"');
  const copySummaryBtn = extractOpeningTagByAttr(
    populatedHtml,
    'data-action="copy-caregiver-summary"'
  );
  const resetDemoBtn = extractOpeningTagByAttr(
    populatedHtml,
    'data-action="reset-demo-profile"'
  );
  assert.ok(enabledUndoBtn.includes('aria-disabled="false"'));
  assert.ok(enabledUndoBtn.includes("min-height:56px"));
  assert.ok(copySummaryBtn.includes("min-height:56px"));
  assert.ok(resetDemoBtn.includes("min-height:56px"));

  assert.ok(populatedHtml.includes(">Undo Last Dose</button>"));
  assert.ok(populatedHtml.includes(">Copy Caregiver Summary</button>"));
  assert.ok(populatedHtml.includes(">Reset to Demo Profile</button>"));
  assert.ok(populatedHtml.includes("HoldUp Caregiver Summary Preview"));
});

test("ProfileManager pure state helpers mutate immutably and emit zero em dashes across all states", () => {
  assert.equal(resolveSupportedLangCode("sv-SE"), "sv");
  assert.equal(resolveSupportedLangCode("RU"), "ru");
  assert.equal(resolveSupportedLangCode("ja"), "en");

  assert.equal(addMedicationToProfile(DEMO_PROFILE, { name: "", ingredient: "", strength: "5 mg", schedule: [] }), null);
  assert.equal(addMedicationToProfile(DEMO_PROFILE, { name: "Burana", ingredient: "ibuprofen", strength: "", schedule: [] }), null);

  const withBis = addMedicationToProfile(DEMO_PROFILE, {
    name: "Emconcor",
    ingredient: "bisoprolol",
    strength: "2.5 mg",
    schedule: ["morning"],
    barcode: "6432-1000-24680"
  });
  assert.ok(withBis !== null);
  if (!withBis) {
    throw new Error("Expected added medication profile");
  }
  assert.equal(DEMO_PROFILE.meds.length, 3);
  assert.equal(withBis.meds.length, 4);
  const created = withBis.meds[3];
  assert.equal(created.barcode, "6432100024680");
  assert.deepEqual(created.schedule, ["morning"]);

  const fixedDay = new Date(2026, 10, 14, 15, 0, 0);
  const morningTs = new Date(2026, 10, 14, 8, 5, 0).getTime();
  const logged = logDoseNowInProfile(withBis, created.id, morningTs);
  assert.equal(countTodaysDosesForMed(logged, created.id, fixedDay), 1);

  const entries = getTodaysDoseEntries(logged, fixedDay);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].medName, "Emconcor");
  assert.equal(entries[0].timeText, "08:05");

  const afterRemove = removeMedicationFromProfile(logged, created.id);
  assert.equal(afterRemove.meds.length, 3);
  const orphanEntries = getTodaysDoseEntries(afterRemove, fixedDay);
  assert.equal(orphanEntries[0].medName, created.id);

  const milkPreset = ALLERGY_PRESET_CHIPS.find((p) => p.label === "Milk / Lactose")!;
  const toggledMilkOn = togglePresetItem(DEMO_PROFILE.allergies, milkPreset);
  assert.equal(toggledMilkOn.added, true);
  assert.ok(toggledMilkOn.next.includes("milk"));

  const toggledMilkOff = togglePresetItem(toggledMilkOn.next, milkPreset);
  assert.equal(toggledMilkOff.added, false);
  assert.equal(toggledMilkOff.next.includes("milk"), false);

  const addedCustom = addCustomListItem(DEMO_PROFILE.avoid, "Grapefruit");
  assert.equal(addedCustom.added, true);
  assert.equal(addCustomListItem(addedCustom.next, "grapefruit").added, false);
  assert.equal(removeListItem(addedCustom.next, "GRAPEFRUIT").includes("Grapefruit"), false);

  const emptyProfile: Profile = {
    meds: [],
    allergies: [],
    avoid: [],
    doseLog: [],
    lang: "sv"
  };
  const emptyStateHtml = renderToStaticMarkup(
    createElement(ProfileManager, {
      profile: emptyProfile,
      onChange: noop,
      onResetDemo: noop,
      onUndoLastDose: noop,
      caregiverSummaryText: "",
      onOpenPharmacyImport: noop
    })
  );
  assert.equal(emptyStateHtml.includes(EM_DASH), false);
  assert.equal(emptyStateHtml.includes(EN_DASH), false);
});
