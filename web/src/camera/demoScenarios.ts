import type { DemoScenario, DemoScenarioId } from "../types.ts";

export const DEMO_SCENARIOS: DemoScenario[] = [
  {
    id: "amlodipine_match",
    title: "Amlodipine 5 mg (evening pill)",
    subtitle: "Saved evening blood-pressure medication, not taken today",
    question: "Is this my evening pill?",
    barcode: "6432100012345",
    fixtureUrl: "/fixtures/amlodipine.jpg"
  },
  {
    id: "ibuprofen_nsaid",
    title: "Ibuprofen 400 mg (NSAID warning)",
    subtitle: "Unlisted painkiller that conflicts with NSAID avoid rule",
    question: "Can I take this for a headache?",
    barcode: "6412345000400",
    fixtureUrl: "/fixtures/ibuprofen.jpg"
  },
  {
    id: "blurry_strength",
    title: "Blurry strength panel",
    subtitle: "Medication box with illegible dose strength that refuses to guess",
    question: "What strength is this pill?",
    barcode: "6432100012345",
    fixtureUrl: "/fixtures/blurry_amlodipine.jpg"
  },
  {
    id: "hazelnut_allergy",
    title: "Hazelnut snack bar (allergy catch)",
    subtitle: "Snack bar declaring hazelnuts against nut allergy profile",
    question: "Does this contain nuts?",
    barcode: "7310100555111",
    fixtureUrl: "/fixtures/hazelnut_bar.jpg"
  },
  {
    id: "oat_milk_safe",
    title: "Oat drink (nut-free check)",
    subtitle: "Oat milk with readable allergen panel and expiry date",
    question: "Is this safe with my allergies?",
    barcode: "7394376616228",
    fixtureUrl: "/fixtures/oat_milk.jpg"
  },
  {
    id: "expired_med",
    title: "Expired Metformin 500 mg",
    subtitle: "Saved medication whose printed expiry date has passed",
    question: "Is this metformin still in date?",
    barcode: "6432100054321",
    fixtureUrl: "/fixtures/expired_metformin.jpg"
  },
  {
    id: "back_of_box",
    title: "Back of pill box (coaching cue)",
    subtitle: "Barcode side facing camera to trigger turn-around coaching",
    question: "Is this my evening pill?",
    barcode: "6432100012345",
    fixtureUrl: "/fixtures/back_of_box.jpg"
  }
];

export function getDemoScenario(id: DemoScenarioId): DemoScenario {
  const found = DEMO_SCENARIOS.find((scenario) => scenario.id === id);
  if (!found) {
    throw new Error(`Unknown demo scenario: ${id}`);
  }
  return found;
}
