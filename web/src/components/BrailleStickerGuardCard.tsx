import React, { type CSSProperties } from "react";
import { normalizeLang, t, type UiLocale } from "../i18n/translations.ts";

void React;

const SLASH = String.fromCharCode(47);
const HOLDUP_RX_SCHEME = `holdup:${SLASH}${SLASH}rx`;

export type CartonPlacementZoneId =
  | "braille_front_protected"
  | "strength_ink_clear"
  | "holdup_qr_side_flap"
  | "ean_barcode_panel";

export type CartonZoneStatus = "never_cover" | "safe_qr_zone" | "optical_anchor";

export type CartonPlacementZone = {
  id: CartonPlacementZoneId;
  status: CartonZoneStatus;
  title: string;
  rule: string;
  spokenGuidance: string;
};

export type BrailleStickerGuardCardProps = {
  lang: string;
  onOpenPharmacyQr?: () => void;
  onSpeakGuidance?: (text: string) => void;
};

type LocaleCopy = {
  eyebrow: string;
  heading: string;
  subtitle: string;
  brailleProtectedPill: string;
  safeQrPill: string;
  diagramTitle: string;
  diagramDesc: string;
  diagramAriaLabel: string;
  diagramCaption: string;
  svgFrontPanelLabel: string;
  svgFrontDrugTitle: string;
  svgBrailleKeepClear: string;
  svgNoStickerTag: string;
  svgStrengthKeepClear: string;
  svgSidePanelLabel: string;
  svgDosageLabelTag: string;
  svgSafeQrTitle: string;
  svgTactileNotchTag: string;
  svgBarcodePanelLabel: string;
  svgBarcodeKeepClear: string;
  svgOfflineAnchorTag: string;
  zonesHeading: string;
  zonesListAriaLabel: string;
  statusBadges: Record<CartonZoneStatus, string>;
  spokenPreviewLabel: string;
  speakZoneButtonLabel: string;
  speakZoneButtonAria: (title: string) => string;
  actionsGroupAria: string;
  speakOverviewLabel: string;
  speakOverviewAria: string;
  overviewSpokenGuidance: string;
  openQrButtonLabel: string;
  openQrButtonAria: string;
  regulatoryNoteTitle: string;
  regulatoryNoteBody: string;
};

const ZONES_BY_LOCALE: Record<UiLocale, readonly CartonPlacementZone[]> = {
  en: [
    {
      id: "braille_front_protected",
      status: "never_cover",
      title: "Embossed Braille Front Face (Art. 56a)",
      rule:
        "Never place pharmacy dosage stickers or QR labels over Marburg Medium Braille dots on the front carton panel; keep 100% of tactile drug name and strength embossing uncovered.",
      spokenGuidance:
        "Slide your fingertips across the front of the box to read the raised Braille drug name and strength. Pharmacy stickers are kept completely off these tactile dots."
    },
    {
      id: "strength_ink_clear",
      status: "never_cover",
      title: "Printed Strength & Expiry Ink Window",
      rule:
        "Keep factory-printed milligram digits (including Nordic 2,5 mg comma decimals) and EXP dates 100% visible so thermal sticker edges or faded paper never trigger a below-80% abstention.",
      spokenGuidance:
        "Keep thumbs and stickers clear of the printed milligram numbers and expiry date on the front panel so HoldUp can verify exact dose strength above the 80 percent safety gate."
    },
    {
      id: "holdup_qr_side_flap",
      status: "safe_qr_zone",
      title: `Safe 25 mm ${HOLDUP_RX_SCHEME} Side or Back Flap`,
      rule:
        `Affix the 25 x 25 mm ${HOLDUP_RX_SCHEME}?v=1 thermal QR sticker (<= 450 bytes, zero HETU or PII) and dispensing label on an unembossed side flap or bottom-right back corner with tactile locator cue.`,
      spokenGuidance:
        "Feel the smooth unembossed side flap or bottom-right back corner for the 25 millimeter pharmacy QR sticker, then hold that side at chest height about 25 centimeters away to import your prescription."
    },
    {
      id: "ean_barcode_panel",
      status: "optical_anchor",
      title: "Factory EAN-13 & DataMatrix Barcode Panel",
      rule:
        `Leave the factory EAN-13 GTIN and 2D DataMatrix panel uncovered as a permanent optical anchor; ${HOLDUP_RX_SCHEME} links this barcode locally so offline matching works even if thermal ink fades.`,
      spokenGuidance:
        "If you have no internet connection or a paper pharmacy sticker has faded, turn the box to the uncovered factory barcode panel for instant offline matching on your device."
    }
  ],
  fi: [
    {
      id: "braille_front_protected",
      status: "never_cover",
      title: "Kohopainettu pistekirjoitus etupaneelissa (Art. 56a)",
      rule:
        "Älä koskaan liimaa annostusohjetarraa tai QR-tarraa pakkauksen etupuolen Marburg Medium -pistekirjoituksen päälle; pidä 100 % kohopisteistä vapaana sormitunnustelulle.",
      spokenGuidance:
        "Tunnustele sormenpäillä pakkauksen etupuolen kohopisteistä lääkkeen nimi ja vahvuus. Apteekkitarrat pidetään kokonaan pois pistekirjoituksen päältä."
    },
    {
      id: "strength_ink_clear",
      status: "never_cover",
      title: "Painettu vahvuus- ja kelpoisuusmerkintä",
      rule:
        "Jätä tehtaan painamat vahvuusnumerot (kuten pilkkumuoto 2,5 mg) ja EXP-päiväys 100 % näkyviin, jotta tarran reuna tai haalistuva lämpöpaperi ei estä yli 80 % varmuuskynnystä.",
      spokenGuidance:
        "Pidä sormet ja tarrat poissa painettujen milligrammanumeroiden ja viimeisen käyttöpäivän päältä, jotta HoldUp varmistaa vahvuuden turvallisesti yli 80 prosentin rajalla."
    },
    {
      id: "holdup_qr_side_flap",
      status: "safe_qr_zone",
      title: `Turvallinen 25 mm ${HOLDUP_RX_SCHEME} -sivuläppä tai tausta`,
      rule:
        `Kiinnitä 25 x 25 mm ${HOLDUP_RX_SCHEME}?v=1 -lämpötarra (<= 450 tavua, ei henkilötunnusta) ja annostusohjetarra sileälle pistekirjoituksettomalle sivuläpälle tai takapaneelin oikeaan alakulmaan.`,
      spokenGuidance:
        "Etsi sormella sileä sivuläppä tai takapaneelin oikea alakulma, jossa 25 millimetrin apteekki-QR sijaitsee, ja pidä se rinnan korkeudella noin 25 senttimetrin päässä reseptin tuontia varten."
    },
    {
      id: "ean_barcode_panel",
      status: "optical_anchor",
      title: "Tehtaan EAN-13- ja DataMatrix-viivakoodipaneeli",
      rule:
        `Jätä tehtaan EAN-13-viivakoodi ja 2D DataMatrix täysin peittämättä pysyväksi optiseksi tunnisteeksi; ${HOLDUP_RX_SCHEME} tallentaa koodin laitteelle offline-tunnistusta varten.`,
      spokenGuidance:
        "Jos verkkoyhteys puuttuu tai lämpötarra on kulunut, käännä pakkauksen peittämätön viivakoodipaneeli esiin välitöntä paikallista offline-tunnistusta varten."
    }
  ],
  sv: [
    {
      id: "braille_front_protected",
      status: "never_cover",
      title: "Präglad punktskrift på framsidan (Art. 56a)",
      rule:
        "Fäst aldrig doseringsetiketter eller QR-klistermärken över Marburg Medium-punktskriften på kartongens framsida; lämna 100 % av punkterna fria för läsning med fingertopparna.",
      spokenGuidance:
        "För fingertopparna över kartongens framsida för att läsa läkemedlets namn och styrka i upphöjd punktskrift. Apoteksetiketter placeras aldrig över punkterna."
    },
    {
      id: "strength_ink_clear",
      status: "never_cover",
      title: "Tryckt styrka och utgångsdatum i klartext",
      rule:
        "Håll fabrikstryckta milligramvärden (inklusive nordiska kommadecimaler som 2,5 mg) och EXP-datum 100 % fria så att etikettkanter eller blekt termopapper aldrig skymmer dosen.",
      spokenGuidance:
        "Håll tummar och klistermärken borta från de tryckta milligramsiffrorna och utgångsdatumet så att HoldUp kan verifiera styrkan säkert över gränsen på 80 procent."
    },
    {
      id: "holdup_qr_side_flap",
      status: "safe_qr_zone",
      title: `Säker 25 mm ${HOLDUP_RX_SCHEME}-sidoflik eller baksida`,
      rule:
        `Placera 25 x 25 mm ${HOLDUP_RX_SCHEME}?v=1-termoetiketten (<= 450 byte, noll personnummer eller PII) och doseringsetiketten på en slät sidoflik eller baksidans nedre högra hörn.`,
      spokenGuidance:
        "Känn efter den släta sidofliken eller baksidans nedre högra hörn där 25-millimeters QR-etiketten sitter, och håll den i brösthöjd cirka 25 centimeter ut för att importera receptet."
    },
    {
      id: "ean_barcode_panel",
      status: "optical_anchor",
      title: "Fabrikstryckt EAN-13- och DataMatrix-panel",
      rule:
        `Lämna kartongens EAN-13-streckkod och 2D DataMatrix helt fria som ett beständigt optiskt ankare; ${HOLDUP_RX_SCHEME} sparar streckkoden lokalt så att offline-kontroll fungerar även om termotryck bleknar.`,
      spokenGuidance:
        "Om du saknar uppkoppling eller om termoetiketten har nötts, vänd fram kartongens fria streckkodspanel för direkt lokal offline-matchning på enheten."
    }
  ]
};

const COPY_BY_LOCALE: Record<UiLocale, LocaleCopy> = {
  en: {
    eyebrow: "EU Directive 2001/83/EC Art. 56a & Counter SOP",
    heading: "Braille Preservation & Pharmacy Sticker Guardrail",
    subtitle:
      `Co-designed dispensing-counter layout that keeps 100% of tactile Braille dots, printed dose digits, and EAN-13 barcodes clear while placing HoldUp's 25 mm ${HOLDUP_RX_SCHEME} QR on an unembossed flap.`,
    brailleProtectedPill: "100% Braille Uncovered",
    safeQrPill: `25 x 25 mm ${HOLDUP_RX_SCHEME} Flap`,
    diagramTitle: "Three-panel medication carton sticker placement diagram",
    diagramDesc:
      `Panel 1 shows protected embossed Braille dots and 2,5 mg printed strength marked never cover. Panel 2 shows the unembossed side or back flap holding the safe 25 by 25 millimeter ${HOLDUP_RX_SCHEME} QR sticker and tactile corner notch. Panel 3 shows the uncovered EAN-13 factory barcode panel for offline verification.`,
    diagramAriaLabel:
      `Three-panel pharmacy carton placement map: front panel protects embossed Braille and 2,5 mg strength ink, middle unembossed flap holds the safe 25 millimeter ${HOLDUP_RX_SCHEME} QR sticker, and right panel preserves the EAN-13 barcode`,
    diagramCaption:
      "Unfolded 3-panel prescription carton SOP: tactile Braille and printed strength stay 100% clear on the front face.",
    svgFrontPanelLabel: "1. FRONT PANEL (PROTECTED)",
    svgFrontDrugTitle: "BISOPROLOL 2,5 mg",
    svgBrailleKeepClear: "BRAILLE DOTS: NEVER COVER",
    svgNoStickerTag: "NO STICKER",
    svgStrengthKeepClear: "STRENGTH & EXP: KEEP CLEAR",
    svgSidePanelLabel: "2. SIDE / BACK FLAP (SAFE QR)",
    svgDosageLabelTag: "DOSAGE LABEL (UNEMBOSSED)",
    svgSafeQrTitle: `25 mm ${HOLDUP_RX_SCHEME}`,
    svgTactileNotchTag: "TACTILE LOCATOR",
    svgBarcodePanelLabel: "3. BARCODE PANEL (ANCHOR)",
    svgBarcodeKeepClear: "EAN-13 GTIN: KEEP CLEAR",
    svgOfflineAnchorTag: "OFFLINE BARCODE MATCH",
    zonesHeading: "4 Dispensing-Counter Carton Placement Rules",
    zonesListAriaLabel: "Four medication carton Braille and sticker placement zones",
    statusBadges: {
      never_cover: "NEVER COVER",
      safe_qr_zone: "SAFE 25 MM QR ZONE",
      optical_anchor: "OPTICAL OFFLINE ANCHOR"
    },
    spokenPreviewLabel: "Spoken audio readout",
    speakZoneButtonLabel: "Hear Zone Rule",
    speakZoneButtonAria: (title) => `Hear Zone Rule: ${title}`,
    actionsGroupAria: "Spoken placement readout and pharmacy QR import actions",
    speakOverviewLabel: "Speak Full Placement Guide",
    speakOverviewAria: "Speak full Braille-safe pharmacy sticker placement guide aloud",
    overviewSpokenGuidance:
      "HoldUp pharmacy placement rule: embossed Braille dots and printed milligram strengths on the front of the box are never covered. The 25 millimeter HoldUp QR sticker sits on the smooth side or back flap, and the factory barcode stays uncovered for offline checks.",
    openQrButtonLabel: "Open Pharmacy QR Import",
    openQrButtonAria: `Open ${HOLDUP_RX_SCHEME} Pharmacy QR scanner and import dialog`,
    regulatoryNoteTitle: "Iiris Center Co-Design & Zero-PII Counter Standard",
    regulatoryNoteBody:
      `Each 25 x 25 mm ${HOLDUP_RX_SCHEME} thermal sticker fits within 450 bytes with zero personal identity numbers (HETU) and pairs with saved EAN-13 barcodes on your phone.`
  },
  fi: {
    eyebrow: "EU-direktiivi 2001/83/EY art. 56a ja apteekkiohje",
    heading: "Pistekirjoituksen suoja ja apteekkitarran sijoitusopas",
    subtitle:
      `Yhteissuunniteltu reseptitiskin sijoitusmalli, joka jättää 100 % pistekirjoituksesta, painetusta vahvuudesta ja EAN-13-viivakoodista vapaaksi ja ohjaa 25 mm ${HOLDUP_RX_SCHEME} -tarran sileälle läpälle.`,
    brailleProtectedPill: "100 % pistekirjoitus vapaa",
    safeQrPill: `25 x 25 mm ${HOLDUP_RX_SCHEME} -läppä`,
    diagramTitle: "Kolmipaneelinen lääkepakkauksen tarransijoituskaavio",
    diagramDesc:
      `Paneeli 1 näyttää suojatut kohopisteet ja painetun 2,5 mg vahvuuden, joita ei saa koskaan peittää. Paneeli 2 näyttää sileän sivu- tai takaläpän, johon turvallinen 25 x 25 millimetrin ${HOLDUP_RX_SCHEME} QR-tarra ja tuntomerkki kiinnitetään. Paneeli 3 näyttää vapaaksi jätetyn EAN-13-viivakoodipaneelin offline-tarkistukseen.`,
    diagramAriaLabel:
      `Kolmipaneelinen apteekkipakkauksen sijoituskaavio: etupaneeli suojaa pistekirjoituksen ja 2,5 mg vahvuustekstin, sileä väliläppä sisältää 25 millimetrin ${HOLDUP_RX_SCHEME} QR-tarran ja oikea paneeli säilyttää EAN-13-viivakoodin`,
    diagramCaption:
      "Avattu 3-paneelinen reseptikotelon malli: pistekirjoitus ja painettu vahvuus pysyvät 100 % vapaina etupinnalla.",
    svgFrontPanelLabel: "1. ETUPANEELI (SUOJATTU)",
    svgFrontDrugTitle: "BISOPROLOL 2,5 mg",
    svgBrailleKeepClear: "PISTEKIRJOITUS: ÄLÄ PEITÄ",
    svgNoStickerTag: "EI TARRAA",
    svgStrengthKeepClear: "VAHVUUS & EXP: PIDÄ VAPAANA",
    svgSidePanelLabel: "2. SIVU- / TAKALÄPPÄ (QR-ALUE)",
    svgDosageLabelTag: "ANNOSTUSTARRA (SILEÄ PINTA)",
    svgSafeQrTitle: `25 mm ${HOLDUP_RX_SCHEME}`,
    svgTactileNotchTag: "TUNTOMERKKI",
    svgBarcodePanelLabel: "3. VIIVAKOODIPANEELI (ANKKURI)",
    svgBarcodeKeepClear: "EAN-13 GTIN: PIDÄ VAPAANA",
    svgOfflineAnchorTag: "OFFLINE-VIIVAKOODITÄSMÄYS",
    zonesHeading: "4 reseptitiskin sijoitussääntöä lääkepakkauksille",
    zonesListAriaLabel: "Neljä lääkepakkauksen pistekirjoitus- ja tarrasijoitusvyöhykettä",
    statusBadges: {
      never_cover: "ÄLÄ PEITÄ KOSKAAN",
      safe_qr_zone: "TURVALLINEN 25 MM QR-ALUE",
      optical_anchor: "OPTINEN OFFLINE-ANKKURI"
    },
    spokenPreviewLabel: "Puhuttava ääniohje",
    speakZoneButtonLabel: "Kuuntele vyöhykeohje",
    speakZoneButtonAria: (title) => `Kuuntele vyöhykeohje: ${title}`,
    actionsGroupAria: "Puhuttava sijoitusopas ja apteekin QR-tuontitoiminnot",
    speakOverviewLabel: "Kuuntele koko sijoitusopas",
    speakOverviewAria: "Kuuntele pistekirjoituksen suojaava apteekkitarran sijoitusopas ääneen",
    overviewSpokenGuidance:
      "HoldUp-apteekkiohje: pakkauksen etupuolen kohopisteitä ja painettua vahvuutta ei peitetä koskaan. 25 millimetrin HoldUp QR-tarra kiinnitetään sileälle sivu- tai takaläpälle, ja tehtaan viivakoodi jätetään näkyviin offline-tarkistusta varten.",
    openQrButtonLabel: "Avaa apteekin QR-tuonti",
    openQrButtonAria: `Avaa ${HOLDUP_RX_SCHEME} apteekin QR-lukija ja tuonti-ikkuna`,
    regulatoryNoteTitle: "Iiris-keskuksen yhteissuunnittelu ja HETU-vapaa tarrastandardi",
    regulatoryNoteBody:
      `Jokainen 25 x 25 mm ${HOLDUP_RX_SCHEME} -lämpötarra mahtuu 450 tavuun ilman henkilötunnusta (HETU) ja yhdistyy puhelimen tallennettuihin EAN-13-viivakoodeihin.`
  },
  sv: {
    eyebrow: "EU-direktiv 2001/83/EG art. 56a och apoteksrutin",
    heading: "Punktskriftsskydd och placeringsguide för apoteksetikett",
    subtitle:
      `Samdesignad diskrutin som lämnar 100 % av taktil punktskrift, tryckt styrka och EAN-13-streckkod fria samtidigt som HoldUps 25 mm ${HOLDUP_RX_SCHEME}-etikett fästs på en slät flik.`,
    brailleProtectedPill: "100 % punktskrift fri",
    safeQrPill: `25 x 25 mm ${HOLDUP_RX_SCHEME}-flik`,
    diagramTitle: "Trepanelsdiagram för etikettplacering på läkemedelskartong",
    diagramDesc:
      `Panel 1 visar skyddad präglad punktskrift och tryckt styrka 2,5 mg markerade täck aldrig. Panel 2 visar den släta sido- eller bakfliken med den säkra 25 gånger 25 millimeter ${HOLDUP_RX_SCHEME} QR-etiketten och taktil hörnmarkering. Panel 3 visar den fria EAN-13-streckkodspanelen för offline-verifiering.`,
    diagramAriaLabel:
      `Trepanels placeringskarta för apotekskartong: framsidan skyddar punktskrift och tryckt styrka 2,5 mg, den släta fliken bär den säkra 25 millimeter ${HOLDUP_RX_SCHEME} QR-etiketten och högra panelen bevarar EAN-13-streckkoden`,
    diagramCaption:
      "Utvikt 3-panels receptkartong: taktil punktskrift och tryckt styrka hålls 100 % fria på framsidan.",
    svgFrontPanelLabel: "1. FRAMSIDA (SKYDDAD)",
    svgFrontDrugTitle: "BISOPROLOL 2,5 mg",
    svgBrailleKeepClear: "PUNKTSKRIFT: TÄCK ALDRIG",
    svgNoStickerTag: "INGEN ETIKETT",
    svgStrengthKeepClear: "STYRKA & EXP: HÅLL FRIA",
    svgSidePanelLabel: "2. SIDO- / BAKFLIK (SÄKER QR)",
    svgDosageLabelTag: "DOSERINGSETIKETT (SLÄT YTA)",
    svgSafeQrTitle: `25 mm ${HOLDUP_RX_SCHEME}`,
    svgTactileNotchTag: "TAKTIL MARKÖR",
    svgBarcodePanelLabel: "3. STRECKKODSPANEL (ANKARE)",
    svgBarcodeKeepClear: "EAN-13 GTIN: HÅLL FRI",
    svgOfflineAnchorTag: "OFFLINE-STRECKKODSMATCH",
    zonesHeading: "4 placeringsregler vid apoteksdisken",
    zonesListAriaLabel: "Fyra zoner för punktskrift och etikettplacering på läkemedelskartong",
    statusBadges: {
      never_cover: "TÄCK ALDRIG",
      safe_qr_zone: "SÄKER 25 MM QR-ZON",
      optical_anchor: "OPTISKT OFFLINE-ANKARE"
    },
    spokenPreviewLabel: "Talad ljudvägledning",
    speakZoneButtonLabel: "Lyssna på zonregel",
    speakZoneButtonAria: (title) => `Lyssna på zonregel: ${title}`,
    actionsGroupAria: "Talad placeringsguide och åtgärder för apoteks-QR-import",
    speakOverviewLabel: "Läs upp hela placeringsguiden",
    speakOverviewAria: "Läs upp hela guiden för punktskriftssäker etikettplacering högt",
    overviewSpokenGuidance:
      "HoldUps apoteksregel: upphöjd punktskrift och tryckt milligramstyrka på kartongens framsida får aldrig täckas över. Den 25 millimeter stora HoldUp QR-etiketten fästs på den släta sido- eller bakfliken, och fabrikens streckkod lämnas fri för offline-kontroll.",
    openQrButtonLabel: "Öppna apoteks-QR-import",
    openQrButtonAria: `Öppna ${HOLDUP_RX_SCHEME} QR-skanner och importdialog för apotek`,
    regulatoryNoteTitle: "Samdesign med Iiris-centret och personnummerfri etikettstandard",
    regulatoryNoteBody:
      `Varje 25 x 25 mm ${HOLDUP_RX_SCHEME}-termoetikett ryms inom 450 byte helt utan personbeteckning (HETU) och kopplas till sparade EAN-13-streckkoder i mobilen.`
  }
};

export function getCartonPlacementZones(lang: string): CartonPlacementZone[] {
  const locale = normalizeLang(lang);
  return ZONES_BY_LOCALE[locale].map((zone) => ({
    id: zone.id,
    status: zone.status,
    title: zone.title,
    rule: zone.rule,
    spokenGuidance: zone.spokenGuidance
  }));
}

const CARD_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-4, 16px)",
  padding: "var(--space-5, 20px)",
  borderRadius: "var(--radius-lg, 18px)",
  backgroundColor: "var(--bg-surface, #121926)",
  color: "var(--text-primary, #f8fafc)",
  border: "var(--border-width, 1.5px) solid var(--border-subtle, #2c3a52)",
  boxShadow: "var(--shadow-sm, 0 2px 8px rgba(0, 0, 0, 0.32))"
};

const STATUS_BADGE_STYLES: Record<CartonZoneStatus, CSSProperties> = {
  never_cover: {
    backgroundColor: "var(--verdict-warning-bg, #2d0e0a)",
    color: "var(--verdict-warning-fg, #ffb8ab)",
    border: "2px dashed var(--verdict-warning-border, #ff6b52)"
  },
  safe_qr_zone: {
    backgroundColor: "var(--verdict-match-bg, #06261d)",
    color: "var(--verdict-match-fg, #7ef7c8)",
    border: "2px solid var(--verdict-match-border, #2dd4a0)"
  },
  optical_anchor: {
    backgroundColor: "var(--verdict-info-bg, #0a1f38)",
    color: "var(--verdict-info-fg, #a6d4ff)",
    border: "1.5px solid var(--verdict-info-border, #4da3ff)"
  }
};

const ZONE_BORDER_STYLES: Record<CartonZoneStatus, string> = {
  never_cover: "2px dashed var(--verdict-warning-border, #ff6b52)",
  safe_qr_zone: "2px solid var(--verdict-match-border, #2dd4a0)",
  optical_anchor: "1.5px solid var(--verdict-info-border, #4da3ff)"
};

const ZONE_BUTTON_STYLE: CSSProperties = {
  width: "100%",
  minHeight: "56px",
  minWidth: "56px",
  padding: "12px 16px",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "8px",
  fontSize: "var(--text-sm, 1rem)",
  fontWeight: 800
};

const FOOTER_ACTION_BUTTON_STYLE: CSSProperties = {
  minHeight: "56px",
  minWidth: "56px",
  padding: "12px 20px",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "8px",
  fontSize: "var(--text-base, 1.125rem)",
  fontWeight: 800,
  flex: "1 1 240px"
};

const BRAILLE_CELL_X: readonly number[] = [38, 60, 82, 104, 126, 148, 170, 192];
const BARCODE_BARS: ReadonlyArray<{ x: number; w: number }> = [
  { x: 552, w: 3 },
  { x: 558, w: 2 },
  { x: 564, w: 5 },
  { x: 573, w: 2 },
  { x: 579, w: 4 },
  { x: 587, w: 2 },
  { x: 593, w: 6 },
  { x: 603, w: 2 },
  { x: 609, w: 3 },
  { x: 616, w: 5 },
  { x: 625, w: 2 },
  { x: 631, w: 4 },
  { x: 639, w: 3 },
  { x: 646, w: 6 },
  { x: 656, w: 2 },
  { x: 662, w: 4 },
  { x: 670, w: 2 },
  { x: 676, w: 5 },
  { x: 685, w: 3 },
  { x: 692, w: 2 },
  { x: 698, w: 4 },
  { x: 706, w: 3 }
];

function StatusBadgeIcon({ status }: { status: CartonZoneStatus }) {
  const iconStyle: CSSProperties = { width: "16px", height: "16px", flexShrink: 0 };

  if (status === "never_cover") {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        style={iconStyle}
      >
        <circle cx="12" cy="12" r="9" />
        <line x1="6.3" y1="6.3" x2="17.7" y2="17.7" />
      </svg>
    );
  }

  if (status === "safe_qr_zone") {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        style={iconStyle}
      >
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <path d="M14 16.5l2.2 2.2 4.5-4.7" />
      </svg>
    );
  }

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={iconStyle}
    >
      <path d="M4 5v14" />
      <path d="M8 5v14" />
      <path d="M12 5v14" />
      <path d="M16 5v14" />
      <path d="M20 5v14" />
    </svg>
  );
}

function ActionIcon({ kind }: { kind: "speaker" | "qr" | "shield" }) {
  const iconStyle: CSSProperties = { width: "18px", height: "18px", flexShrink: 0 };

  if (kind === "speaker") {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.3"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        style={iconStyle}
      >
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
        <path d="M15.5 8.5a5 5 0 0 1 0 7" />
        <path d="M18.8 5.8a9 9 0 0 1 0 12.4" />
      </svg>
    );
  }

  if (kind === "qr") {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.3"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        style={iconStyle}
      >
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="3" height="3" />
        <rect x="18" y="18" width="3" height="3" />
      </svg>
    );
  }

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={iconStyle}
    >
      <path d="M12 2L4 5.5v6.1c0 5.1 3.4 9.8 8 10.9 4.6-1.1 8-5.8 8-10.9V5.5L12 2z" />
      <path d="M8.5 12.3l2.4 2.4 4.8-5" />
    </svg>
  );
}

function CartonPlacementDiagram({ copy }: { copy: LocaleCopy }) {
  const titleId = "braille-carton-diagram-title";
  const descId = "braille-carton-diagram-desc";

  return (
    <figure
      className="braille-carton-diagram-figure"
      style={{
        margin: 0,
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        padding: "var(--space-4, 16px)",
        borderRadius: "var(--radius-md, 12px)",
        backgroundColor: "var(--bg-elevated, #1a2333)",
        border: "1.5px solid var(--border-subtle, #2c3a52)"
      }}
    >
      <svg
        role="img"
        aria-label={copy.diagramAriaLabel}
        aria-labelledby={`${titleId} ${descId}`}
        viewBox="0 0 760 236"
        className="braille-carton-diagram-svg"
        data-carton-diagram="three-panel"
        style={{
          width: "100%",
          height: "auto",
          display: "block",
          borderRadius: "var(--radius-sm, 8px)"
        }}
      >
        <title id={titleId}>{copy.diagramTitle}</title>
        <desc id={descId}>{copy.diagramDesc}</desc>

        <rect
          x="2"
          y="2"
          width="756"
          height="232"
          rx="12"
          fill="var(--bg-app, #0b0f17)"
          stroke="var(--border-strong, #6980a3)"
          strokeWidth="2"
        />

        <g data-carton-panel="front">
          <rect
            x="16"
            y="16"
            width="236"
            height="204"
            rx="8"
            fill="var(--bg-surface, #121926)"
            stroke="var(--border-strong, #6980a3)"
            strokeWidth="1.8"
          />
          <text
            x="28"
            y="36"
            fill="var(--accent, #5cc0ff)"
            fontSize="11"
            fontWeight="800"
            fontFamily="var(--font-sans, sans-serif)"
          >
            {copy.svgFrontPanelLabel}
          </text>
          <text
            x="28"
            y="58"
            fill="var(--text-primary, #f8fafc)"
            fontSize="15"
            fontWeight="800"
            fontFamily="var(--font-sans, sans-serif)"
          >
            {copy.svgFrontDrugTitle}
          </text>

          <g data-diagram-zone="braille_front_protected">
            <rect
              x="26"
              y="68"
              width="216"
              height="68"
              rx="6"
              fill="var(--verdict-warning-bg, #2d0e0a)"
              stroke="var(--verdict-warning-border, #ff6b52)"
              strokeWidth="2"
              strokeDasharray="6 4"
            />
            {BRAILLE_CELL_X.map((cellX, idx) => (
              <g key={cellX} data-braille-cell={String(idx + 1)}>
                <circle cx={cellX} cy="86" r="3" fill="var(--verdict-warning-fg, #ffb8ab)" />
                <circle
                  cx={cellX + 8}
                  cy="86"
                  r="3"
                  fill={idx % 2 === 0 ? "var(--verdict-warning-fg, #ffb8ab)" : "none"}
                  stroke="var(--verdict-warning-fg, #ffb8ab)"
                  strokeWidth="1.2"
                />
                <circle
                  cx={cellX}
                  cy="96"
                  r="3"
                  fill={idx % 3 !== 1 ? "var(--verdict-warning-fg, #ffb8ab)" : "none"}
                  stroke="var(--verdict-warning-fg, #ffb8ab)"
                  strokeWidth="1.2"
                />
                <circle cx={cellX + 8} cy="96" r="3" fill="var(--verdict-warning-fg, #ffb8ab)" />
                <circle
                  cx={cellX}
                  cy="106"
                  r="3"
                  fill={idx % 2 === 1 ? "var(--verdict-warning-fg, #ffb8ab)" : "none"}
                  stroke="var(--verdict-warning-fg, #ffb8ab)"
                  strokeWidth="1.2"
                />
              </g>
            ))}
            <text
              x="34"
              y="126"
              fill="var(--verdict-warning-fg, #ffb8ab)"
              fontSize="10.5"
              fontWeight="800"
              fontFamily="var(--font-mono, monospace)"
            >
              {copy.svgBrailleKeepClear}
            </text>
          </g>

          <g data-diagram-zone="strength_ink_clear">
            <rect
              x="26"
              y="146"
              width="216"
              height="62"
              rx="6"
              fill="var(--verdict-warning-bg, #2d0e0a)"
              stroke="var(--verdict-warning-border, #ff6b52)"
              strokeWidth="2"
              strokeDasharray="6 4"
            />
            <text
              x="34"
              y="170"
              fill="var(--text-primary, #f8fafc)"
              fontSize="15"
              fontWeight="800"
              fontFamily="var(--font-mono, monospace)"
            >
              2,5 mg | EXP 2027-08
            </text>
            <text
              x="34"
              y="196"
              fill="var(--verdict-warning-fg, #ffb8ab)"
              fontSize="10.5"
              fontWeight="800"
              fontFamily="var(--font-mono, monospace)"
            >
              {copy.svgStrengthKeepClear}
            </text>
            <text
              x="166"
              y="56"
              fill="var(--verdict-warning-fg, #ffb8ab)"
              fontSize="10"
              fontWeight="800"
              fontFamily="var(--font-mono, monospace)"
            >
              {copy.svgNoStickerTag}
            </text>
          </g>
        </g>

        <line
          x1="262"
          y1="20"
          x2="262"
          y2="216"
          stroke="var(--border-strong, #6980a3)"
          strokeWidth="1.5"
          strokeDasharray="4 4"
        />

        <g data-carton-panel="side_flap" data-diagram-zone="holdup_qr_side_flap">
          <rect
            x="272"
            y="16"
            width="236"
            height="204"
            rx="8"
            fill="var(--bg-surface, #121926)"
            stroke="var(--verdict-match-border, #2dd4a0)"
            strokeWidth="2.2"
          />
          <path
            d="M484 16 A12 12 0 0 0 508 40"
            fill="none"
            stroke="var(--verdict-match-fg, #7ef7c8)"
            strokeWidth="2.4"
          />
          <text
            x="284"
            y="36"
            fill="var(--verdict-match-fg, #7ef7c8)"
            fontSize="11"
            fontWeight="800"
            fontFamily="var(--font-sans, sans-serif)"
          >
            {copy.svgSidePanelLabel}
          </text>

          <rect
            x="284"
            y="48"
            width="212"
            height="48"
            rx="6"
            fill="var(--bg-elevated, #1a2333)"
            stroke="var(--border-strong, #6980a3)"
            strokeWidth="1.5"
          />
          <text
            x="294"
            y="68"
            fill="var(--text-primary, #f8fafc)"
            fontSize="11"
            fontWeight="700"
            fontFamily="var(--font-sans, sans-serif)"
          >
            {copy.svgDosageLabelTag}
          </text>
          <text
            x="294"
            y="85"
            fill="var(--text-secondary, #d8e1ee)"
            fontSize="10.5"
            fontFamily="var(--font-mono, monospace)"
          >
            1 tabl. morning (0 HETU)
          </text>

          <rect
            x="284"
            y="106"
            width="212"
            height="102"
            rx="8"
            fill="var(--verdict-match-bg, #06261d)"
            stroke="var(--verdict-match-border, #2dd4a0)"
            strokeWidth="2.2"
          />
          <rect x="296" y="118" width="76" height="76" rx="4" fill="#ffffff" />
          <rect x="302" y="124" width="18" height="18" fill="#000000" />
          <rect x="305" y="127" width="12" height="12" fill="#ffffff" />
          <rect x="308" y="130" width="6" height="6" fill="#000000" />
          <rect x="348" y="124" width="18" height="18" fill="#000000" />
          <rect x="351" y="127" width="12" height="12" fill="#ffffff" />
          <rect x="354" y="130" width="6" height="6" fill="#000000" />
          <rect x="302" y="170" width="18" height="18" fill="#000000" />
          <rect x="305" y="173" width="12" height="12" fill="#ffffff" />
          <rect x="308" y="176" width="6" height="6" fill="#000000" />
          <rect x="326" y="148" width="8" height="8" fill="#000000" />
          <rect x="338" y="158" width="10" height="10" fill="#000000" />
          <rect x="352" y="172" width="12" height="12" fill="#000000" />

          <circle cx="480" cy="124" r="6" fill="var(--verdict-match-fg, #7ef7c8)" />
          <text
            x="382"
            y="148"
            fill="var(--verdict-match-fg, #7ef7c8)"
            fontSize="12"
            fontWeight="800"
            fontFamily="var(--font-mono, monospace)"
          >
            {copy.svgSafeQrTitle}
          </text>
          <text
            x="382"
            y="168"
            fill="var(--text-primary, #f8fafc)"
            fontSize="11"
            fontWeight="700"
            fontFamily="var(--font-mono, monospace)"
          >
            25 x 25 mm | &lt;= 450 B
          </text>
          <text
            x="382"
            y="188"
            fill="var(--verdict-match-fg, #7ef7c8)"
            fontSize="10"
            fontWeight="800"
            fontFamily="var(--font-mono, monospace)"
          >
            {copy.svgTactileNotchTag}
          </text>
        </g>

        <line
          x1="518"
          y1="20"
          x2="518"
          y2="216"
          stroke="var(--border-strong, #6980a3)"
          strokeWidth="1.5"
          strokeDasharray="4 4"
        />

        <g data-carton-panel="barcode_panel" data-diagram-zone="ean_barcode_panel">
          <rect
            x="528"
            y="16"
            width="216"
            height="204"
            rx="8"
            fill="var(--bg-surface, #121926)"
            stroke="var(--verdict-info-border, #4da3ff)"
            strokeWidth="2"
          />
          <text
            x="540"
            y="36"
            fill="var(--verdict-info-fg, #a6d4ff)"
            fontSize="11"
            fontWeight="800"
            fontFamily="var(--font-sans, sans-serif)"
          >
            {copy.svgBarcodePanelLabel}
          </text>

          <rect
            x="542"
            y="54"
            width="188"
            height="92"
            rx="6"
            fill="#ffffff"
          />
          {BARCODE_BARS.map((bar) => (
            <rect key={bar.x} x={bar.x} y="64" width={bar.w} height="58" fill="#000000" />
          ))}
          <text
            x="566"
            y="138"
            fill="#000000"
            fontSize="12"
            fontWeight="800"
            fontFamily="var(--font-mono, monospace)"
          >
            6 432100 024680
          </text>

          <rect
            x="542"
            y="156"
            width="188"
            height="52"
            rx="6"
            fill="var(--verdict-info-bg, #0a1f38)"
            stroke="var(--verdict-info-border, #4da3ff)"
            strokeWidth="1.6"
          />
          <text
            x="552"
            y="176"
            fill="var(--verdict-info-fg, #a6d4ff)"
            fontSize="10.5"
            fontWeight="800"
            fontFamily="var(--font-mono, monospace)"
          >
            {copy.svgBarcodeKeepClear}
          </text>
          <text
            x="552"
            y="196"
            fill="var(--text-primary, #f8fafc)"
            fontSize="10.5"
            fontWeight="700"
            fontFamily="var(--font-mono, monospace)"
          >
            {copy.svgOfflineAnchorTag}
          </text>
        </g>
      </svg>

      <figcaption
        className="braille-carton-diagram-caption"
        style={{
          fontSize: "var(--text-xs, 0.875rem)",
          lineHeight: 1.4,
          color: "var(--text-secondary, #d8e1ee)"
        }}
      >
        {copy.diagramCaption}
      </figcaption>
    </figure>
  );
}

export function BrailleStickerGuardCard(props: BrailleStickerGuardCardProps) {
  const { lang, onOpenPharmacyQr, onSpeakGuidance } = props;
  const locale = normalizeLang(lang);
  const copy = COPY_BY_LOCALE[locale];
  const zones = getCartonPlacementZones(locale);
  const disclaimerText = t(locale, "notMedicalDevice");

  const hasOpenQr = typeof onOpenPharmacyQr === "function";
  const hasSpeak = typeof onSpeakGuidance === "function";
  const hasFooterActions = hasSpeak || hasOpenQr;

  const headingId = "braille-sticker-guard-heading";
  const zonesHeadingId = "braille-sticker-zones-heading";

  return (
    <section
      aria-labelledby={headingId}
      lang={locale}
      className="card braille-sticker-guard-card"
      data-zone-count={String(zones.length)}
      style={CARD_STYLE}
    >
      <header
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: "var(--space-3, 12px)"
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "6px",
            flex: "1 1 320px"
          }}
        >
          <p
            style={{
              margin: 0,
              fontSize: "var(--text-xs, 0.875rem)",
              fontWeight: 700,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              color: "var(--accent, #5cc0ff)"
            }}
          >
            {copy.eyebrow}
          </p>

          <h2
            id={headingId}
            style={{
              margin: 0,
              fontSize: "var(--text-lg, 1.25rem)",
              lineHeight: 1.28,
              fontWeight: 800,
              color: "var(--text-primary, #f8fafc)"
            }}
          >
            {copy.heading}
          </h2>

          <p
            style={{
              margin: 0,
              fontSize: "var(--text-sm, 1rem)",
              lineHeight: 1.45,
              color: "var(--text-secondary, #d8e1ee)"
            }}
          >
            {copy.subtitle}
          </p>
        </div>

        <div
          role="status"
          aria-live="polite"
          className="braille-guard-status-pills"
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "8px"
          }}
        >
          <span
            className="badge braille-protected-pill"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              padding: "6px 12px",
              borderRadius: "var(--radius-pill, 9999px)",
              fontSize: "var(--text-xs, 0.875rem)",
              fontWeight: 800,
              ...STATUS_BADGE_STYLES.safe_qr_zone
            }}
          >
            <StatusBadgeIcon status="safe_qr_zone" />
            <span>{copy.brailleProtectedPill}</span>
          </span>

          <span
            className="pill braille-safe-qr-pill"
            style={{
              padding: "6px 12px",
              borderRadius: "var(--radius-pill, 9999px)",
              backgroundColor: "var(--bg-elevated, #1a2333)",
              color: "var(--text-primary, #f8fafc)",
              border: "var(--border-width, 1.5px) solid var(--border-strong, #6980a3)",
              fontSize: "var(--text-xs, 0.875rem)",
              fontWeight: 700,
              fontFamily: "var(--font-mono, monospace)"
            }}
          >
            {copy.safeQrPill}
          </span>
        </div>
      </header>

      <CartonPlacementDiagram copy={copy} />

      <div
        role="group"
        aria-labelledby={zonesHeadingId}
        className="braille-zones-section"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-3, 12px)"
        }}
      >
        <h3
          id={zonesHeadingId}
          style={{
            margin: 0,
            fontSize: "var(--text-base, 1.125rem)",
            fontWeight: 800,
            lineHeight: 1.3,
            color: "var(--text-primary, #f8fafc)"
          }}
        >
          {copy.zonesHeading}
        </h3>

        <ul
          aria-label={copy.zonesListAriaLabel}
          className="braille-placement-zone-grid"
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))",
            gap: "var(--space-3, 12px)"
          }}
        >
          {zones.map((zone, idx) => {
            const stepLabel = String(idx + 1).padStart(2, "0");

            return (
              <li
                key={zone.id}
                data-zone-id={zone.id}
                data-zone-status={zone.status}
                className={`braille-zone-card braille-zone-${zone.id}`}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                  gap: "12px",
                  padding: "var(--space-4, 16px)",
                  borderRadius: "var(--radius-md, 12px)",
                  backgroundColor: "var(--bg-elevated, #1a2333)",
                  border: ZONE_BORDER_STYLES[zone.status]
                }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "8px"
                    }}
                  >
                    <span
                      className="badge braille-zone-status-badge"
                      data-status-badge={zone.status}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "6px",
                        padding: "4px 10px",
                        borderRadius: "var(--radius-pill, 9999px)",
                        fontSize: "0.78rem",
                        fontWeight: 800,
                        letterSpacing: "0.03em",
                        ...STATUS_BADGE_STYLES[zone.status]
                      }}
                    >
                      <StatusBadgeIcon status={zone.status} />
                      <span>{copy.statusBadges[zone.status]}</span>
                    </span>

                    <span
                      aria-hidden="true"
                      style={{
                        fontFamily: "var(--font-mono, monospace)",
                        fontSize: "var(--text-xs, 0.875rem)",
                        fontWeight: 800,
                        color: "var(--text-muted, #b5c2d6)"
                      }}
                    >
                      {stepLabel}
                    </span>
                  </div>

                  <h4
                    id={`braille-zone-title-${zone.id}`}
                    style={{
                      margin: 0,
                      fontSize: "var(--text-base, 1.125rem)",
                      fontWeight: 800,
                      lineHeight: 1.3,
                      color: "var(--text-primary, #f8fafc)"
                    }}
                  >
                    {zone.title}
                  </h4>

                  <p
                    className="braille-zone-rule"
                    style={{
                      margin: 0,
                      fontSize: "var(--text-sm, 1rem)",
                      lineHeight: 1.45,
                      color: "var(--text-secondary, #d8e1ee)"
                    }}
                  >
                    {zone.rule}
                  </p>

                  <p
                    aria-label={`${copy.spokenPreviewLabel}: ${zone.title}`}
                    className="braille-zone-spoken-guidance"
                    style={{
                      margin: 0,
                      padding: "10px 12px",
                      borderRadius: "var(--radius-sm, 8px)",
                      backgroundColor: "var(--bg-surface, #121926)",
                      border: "1px solid var(--border-subtle, #2c3a52)",
                      fontSize: "var(--text-xs, 0.875rem)",
                      lineHeight: 1.45,
                      color: "var(--text-primary, #f8fafc)"
                    }}
                  >
                    {`"${zone.spokenGuidance}"`}
                  </p>
                </div>

                {hasSpeak ? (
                  <button
                    type="button"
                    className="btn btn-secondary braille-speak-zone-btn"
                    data-action="speak-zone-guidance"
                    data-zone-id={zone.id}
                    aria-label={copy.speakZoneButtonAria(zone.title)}
                    onClick={() => onSpeakGuidance(zone.spokenGuidance)}
                    style={ZONE_BUTTON_STYLE}
                  >
                    <ActionIcon kind="speaker" />
                    <span>{copy.speakZoneButtonLabel}</span>
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>

      {hasFooterActions ? (
        <div
          role="group"
          aria-label={copy.actionsGroupAria}
          className="braille-sticker-guard-actions"
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "var(--space-3, 12px)"
          }}
        >
          {hasSpeak ? (
            <button
              type="button"
              className="btn btn-secondary braille-speak-overview-btn"
              data-action="speak-overview-guidance"
              aria-label={copy.speakOverviewAria}
              onClick={() => onSpeakGuidance(copy.overviewSpokenGuidance)}
              style={FOOTER_ACTION_BUTTON_STYLE}
            >
              <ActionIcon kind="speaker" />
              <span>{copy.speakOverviewLabel}</span>
            </button>
          ) : null}

          {hasOpenQr ? (
            <button
              type="button"
              className="btn btn-primary braille-open-pharmacy-qr-btn"
              data-action="open-pharmacy-qr"
              aria-label={copy.openQrButtonAria}
              onClick={() => onOpenPharmacyQr()}
              style={FOOTER_ACTION_BUTTON_STYLE}
            >
              <ActionIcon kind="qr" />
              <span>{copy.openQrButtonLabel}</span>
            </button>
          ) : null}
        </div>
      ) : null}

      <div
        role="note"
        className="braille-regulatory-boundary-note"
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: "12px",
          padding: "var(--space-4, 16px)",
          borderRadius: "var(--radius-md, 12px)",
          backgroundColor: "var(--verdict-info-bg, #0a1f38)",
          color: "var(--verdict-info-fg, #a6d4ff)",
          border: "var(--border-width, 1.5px) solid var(--verdict-info-border, #4da3ff)"
        }}
      >
        <ActionIcon kind="shield" />
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <strong
            style={{
              fontSize: "var(--text-sm, 1rem)",
              fontWeight: 800,
              lineHeight: 1.35
            }}
          >
            {copy.regulatoryNoteTitle}
          </strong>
          <p
            style={{
              margin: 0,
              fontSize: "var(--text-xs, 0.875rem)",
              lineHeight: 1.45,
              color: "var(--text-primary, #f8fafc)"
            }}
          >
            {copy.regulatoryNoteBody} {disclaimerText}
          </p>
        </div>
      </div>
    </section>
  );
}

export default BrailleStickerGuardCard;
