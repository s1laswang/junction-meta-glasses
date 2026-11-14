import type { CoachCue, VerdictLevel } from "../types.ts";

export type UiLocale = "en" | "fi" | "sv";

export const SUPPORTED_LANGUAGES: readonly { code: string; label: string; nativeLabel: string }[] = [
  { code: "en", label: "English", nativeLabel: "English" },
  { code: "fi", label: "Finnish", nativeLabel: "Suomi" },
  { code: "sv", label: "Swedish", nativeLabel: "Svenska" },
  { code: "de", label: "German", nativeLabel: "Deutsch" },
  { code: "es", label: "Spanish", nativeLabel: "Español" },
  { code: "fr", label: "French", nativeLabel: "Français" },
  { code: "et", label: "Estonian", nativeLabel: "Eesti" },
  { code: "ru", label: "Russian", nativeLabel: "Русский" }
];

export type UiKey =
  | "appTitle"
  | "tagline"
  | "startCheck"
  | "stopCheck"
  | "snapshotCheck"
  | "scanBarcodeOffline"
  | "logDose"
  | "doseLogged"
  | "repeatAnswer"
  | "checkingLabel"
  | "cameraOn"
  | "cameraOff"
  | "glassesStreaming"
  | "autoStopIn"
  | "tabCheck"
  | "tabProfile"
  | "tabDevice"
  | "privacyButton"
  | "consentTitle"
  | "consentAccept"
  | "deleteAllData"
  | "verdictMatch"
  | "verdictWarning"
  | "verdictUnsure"
  | "verdictInfo"
  | "confidenceTitle"
  | "typeQuestionPlaceholder"
  | "askButton"
  | "quickEveningPill"
  | "quickAllergens"
  | "quickExpiry"
  | "quickStrength"
  | "modeLive"
  | "modeSnapshot"
  | "modeOffline"
  | "notMedicalDevice";

const UI_STRINGS: Record<UiLocale, Record<UiKey, string>> = {
  en: {
    appTitle: "HoldUp",
    tagline: "Hold it up. Know it is the right one.",
    startCheck: "Start label check",
    stopCheck: "Stop check",
    snapshotCheck: "Check single photo",
    scanBarcodeOffline: "Scan barcode offline",
    logDose: "Log dose taken",
    doseLogged: "Dose logged",
    repeatAnswer: "Repeat last answer",
    checkingLabel: "Checking label, hold still",
    cameraOn: "Camera active",
    cameraOff: "Camera off",
    glassesStreaming: "Glasses camera streaming",
    autoStopIn: "Auto-stops in",
    tabCheck: "Check",
    tabProfile: "My profile",
    tabDevice: "Device and status",
    privacyButton: "Privacy and consent",
    consentTitle: "Before we use your camera and microphone",
    consentAccept: "I understand, continue",
    deleteAllData: "Delete all data from this device",
    verdictMatch: "Confirmed match",
    verdictWarning: "Safety warning",
    verdictUnsure: "Uncertain read",
    verdictInfo: "Label details",
    confidenceTitle: "Read confidence by field",
    typeQuestionPlaceholder: "Type a question about the label",
    askButton: "Ask",
    quickEveningPill: "Is this my evening pill?",
    quickAllergens: "Does this contain my allergens?",
    quickExpiry: "Has this expired?",
    quickStrength: "What strength is this?",
    modeLive: "Live voice and camera",
    modeSnapshot: "Snapshot fallback",
    modeOffline: "Offline barcode mode",
    notMedicalDevice: "Not a medical device. Always confirm uncertain labels with a pharmacist."
  },
  fi: {
    appTitle: "HoldUp",
    tagline: "Nosta pakkaus esiin. Tiedä, että se on oikea.",
    startCheck: "Aloita etiketin tarkistus",
    stopCheck: "Lopeta tarkistus",
    snapshotCheck: "Tarkista yksittäinen kuva",
    scanBarcodeOffline: "Lue viivakoodi ilman verkkoa",
    logDose: "Kirjaa otettu annos",
    doseLogged: "Annos kirjattu",
    repeatAnswer: "Toista viimeisin vastaus",
    checkingLabel: "Tarkistetaan etikettiä, pidä paikallaan",
    cameraOn: "Kamera päällä",
    cameraOff: "Kamera pois päältä",
    glassesStreaming: "Lasien kamera lähettää kuvaa",
    autoStopIn: "Automaattinen pysäytys",
    tabCheck: "Tarkistus",
    tabProfile: "Omat tiedot",
    tabDevice: "Laite ja tila",
    privacyButton: "Tietosuoja ja suostumus",
    consentTitle: "Ennen kameran ja mikrofonin käyttöä",
    consentAccept: "Ymmärrän, jatka",
    deleteAllData: "Poista kaikki tiedot tältä laitteelta",
    verdictMatch: "Vahvistettu osuma",
    verdictWarning: "Turvallisuusvaroitus",
    verdictUnsure: "Epävarma lukutulos",
    verdictInfo: "Etiketin tiedot",
    confidenceTitle: "Lukuvarmuus kentittäin",
    typeQuestionPlaceholder: "Kirjoita kysymys etiketistä",
    askButton: "Kysy",
    quickEveningPill: "Onko tämä iltalääkkeeni?",
    quickAllergens: "Sisältääkö tämä allergeenejani?",
    quickExpiry: "Onko tämä vanhentunut?",
    quickStrength: "Mikä vahvuus tämä on?",
    modeLive: "Reaaliaikainen ääni ja kamera",
    modeSnapshot: "Yksittäiskuvatila",
    modeOffline: "Offline-viivakooditila",
    notMedicalDevice: "Ei lääkinnällinen laite. Varmista epävarmat pakkaukset aina apteekista."
  },
  sv: {
    appTitle: "HoldUp",
    tagline: "Håll upp förpackningen. Var säker på att det är rätt.",
    startCheck: "Starta etikettkontroll",
    stopCheck: "Stoppa kontroll",
    snapshotCheck: "Kontrollera enskild bild",
    scanBarcodeOffline: "Skanna streckkod offline",
    logDose: "Registrera tagen dos",
    doseLogged: "Dos registrerad",
    repeatAnswer: "Upprepa senaste svaret",
    checkingLabel: "Kontrollerar etiketten, håll stilla",
    cameraOn: "Kamera på",
    cameraOff: "Kamera av",
    glassesStreaming: "Glasögonkameran strömmar",
    autoStopIn: "Automatiskt stopp om",
    tabCheck: "Kontroll",
    tabProfile: "Min profil",
    tabDevice: "Enhet och status",
    privacyButton: "Integritet och samtycke",
    consentTitle: "Innan vi använder kamera och mikrofon",
    consentAccept: "Jag förstår, fortsätt",
    deleteAllData: "Radera all data från den här enheten",
    verdictMatch: "Bekräftad träff",
    verdictWarning: "Säkerhetsvarning",
    verdictUnsure: "Osäker avläsning",
    verdictInfo: "Etikettinformation",
    confidenceTitle: "Avläsningssäkerhet per fält",
    typeQuestionPlaceholder: "Skriv en fråga om etiketten",
    askButton: "Fråga",
    quickEveningPill: "Är det här min kvällsmedicin?",
    quickAllergens: "Innehåller den här mina allergener?",
    quickExpiry: "Har utgångsdatumet passerat?",
    quickStrength: "Vilken styrka är det här?",
    modeLive: "Direkt röst och kamera",
    modeSnapshot: "Stillbildsläge",
    modeOffline: "Offline-streckkodsläge",
    notMedicalDevice: "Inte en medicinteknisk produkt. Kontrollera alltid osäkra etiketter med apotekspersonal."
  }
};

const CUE_STRINGS: Record<UiLocale, Record<CoachCue, string>> = {
  en: {
    rotate_left: "Turn it to your left",
    rotate_right: "Turn it to your right",
    closer: "Bring it a bit closer",
    farther: "Move it a little farther away",
    more_light: "Move to better light or reduce glare",
    hold_still: "Hold steady for a moment",
    other_side: "Turn it around to the other side",
    ok: "Label in view"
  },
  fi: {
    rotate_left: "Käännä pakkausta vasemmalle",
    rotate_right: "Käännä pakkausta oikealle",
    closer: "Tuo hieman lähemmäs",
    farther: "Vie hieman kauemmas",
    more_light: "Siirry parempaan valoon tai vähennä heijastusta",
    hold_still: "Pidä hetki paikallaan",
    other_side: "Käännä toinen puoli esiin",
    ok: "Etiketti näkyvissä"
  },
  sv: {
    rotate_left: "Vrid förpackningen åt vänster",
    rotate_right: "Vrid förpackningen åt höger",
    closer: "För den lite närmare",
    farther: "Håll den lite längre bort",
    more_light: "Flytta till bättre ljus eller minska blänk",
    hold_still: "Håll stilla ett ögonblick",
    other_side: "Vänd fram andra sidan",
    ok: "Etiketten syns tydligt"
  }
};

const VERDICT_KEY_BY_LEVEL: Record<VerdictLevel, UiKey> = {
  match: "verdictMatch",
  warning: "verdictWarning",
  unsure: "verdictUnsure",
  info: "verdictInfo"
};

export function normalizeLang(lang: string): UiLocale {
  const base = (lang ?? "").trim().toLowerCase().split(/[-_]/)[0];
  if (base === "fi" || base === "sv" || base === "en") {
    return base;
  }
  return "en";
}

export function t(lang: string, key: UiKey): string {
  const locale = normalizeLang(lang);
  return UI_STRINGS[locale][key] ?? UI_STRINGS.en[key] ?? String(key);
}

export function cueLabel(lang: string, cue: CoachCue): string {
  const locale = normalizeLang(lang);
  return CUE_STRINGS[locale][cue] ?? CUE_STRINGS.en[cue] ?? String(cue);
}

export function verdictLevelLabel(lang: string, level: VerdictLevel): string {
  const key = VERDICT_KEY_BY_LEVEL[level];
  return key ? t(lang, key) : String(level);
}
