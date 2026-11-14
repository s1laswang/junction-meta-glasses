import React, { useState, type CSSProperties } from "react";
import { normalizeLang, t, type UiLocale } from "../i18n/translations.ts";

void React;

export type GlassesComparisonDimensionId =
  | "hands_required"
  | "physical_aiming"
  | "personal_safety"
  | "privacy_autonomy"
  | "assistive_tco";

export type GlassesComparisonRow = {
  id: GlassesComparisonDimensionId;
  dimension: string;
  holdupGlasses: string;
  smartphoneOcr: string;
  remoteVolunteerVideo: string;
  legacyOcrCamera: string;
};

export type GlassesComparisonFilter = "all" | GlassesComparisonDimensionId;

export type WhyGlassesComparisonCardProps = {
  lang: string;
  defaultSelectedDimension?: GlassesComparisonFilter;
};

type KpiId = "zero_wrong_doses" | "live_hud_p50" | "three_year_tco" | "tco_savings";

type KpiTileSpec = {
  id: KpiId;
  value: string;
  label: string;
  detail: string;
};

type LocaleCopy = {
  eyebrow: string;
  heading: string;
  subtitle: string;
  handsFreeBadge: string;
  tcoMultiplePill: string;
  kpiStripAriaLabel: string;
  kpis: readonly KpiTileSpec[];
  filterGroupAriaLabel: string;
  filterAllLabel: string;
  filterButtonLabels: Record<GlassesComparisonDimensionId, string>;
  filterButtonAria: (label: string, active: boolean) => string;
  spotlightAllTitle: string;
  spotlightAllBody: string;
  spotlightRowPrefix: string;
  tableCaption: string;
  colDimension: string;
  colHoldupGlasses: string;
  colHoldupBadge: string;
  colSmartphoneOcr: string;
  colRemoteVolunteerVideo: string;
  colLegacyOcrCamera: string;
  selectedRowBadge: string;
  rehabNoteHeading: string;
  rehabNoteBody: string;
};

const VALID_DIMENSION_IDS: readonly GlassesComparisonDimensionId[] = [
  "hands_required",
  "physical_aiming",
  "personal_safety",
  "privacy_autonomy",
  "assistive_tco"
];

const ROWS_BY_LOCALE: Record<UiLocale, readonly GlassesComparisonRow[]> = {
  en: [
    {
      id: "hands_required",
      dimension: "Hands required during check",
      holdupGlasses:
        "0 hands on device: both hands stay free at chest height to rotate a curved pill bottle, steady a blister strip, or hold a mobility cane and water glass.",
      smartphoneOcr:
        "3-hand problem: 1 hand must hold and blind-aim the phone at 30 cm while 2 hands are needed to steady and turn the package.",
      remoteVolunteerVideo:
        "1 hand occupied holding and aiming the phone camera throughout a 30 to 90 s live call connection and label inspection.",
      legacyOcrCamera:
        "0 hands on camera via magnetic temple clip-on, but requires manual touch or pointing gestures on specialized hardware."
    },
    {
      id: "physical_aiming",
      dimension: "Physical aiming & framing",
      holdupGlasses:
        "~1 fps body-relative Gemini Live voice coaching (turn left, closer, tilt glare) + FrameRing.pick multi-frame sharpness selection.",
      smartphoneOcr:
        "Blind single-shot roulette: dumps raw unprioritized text or stays silent when aimed at a rear barcode, blank flap, or foil glare.",
      remoteVolunteerVideo:
        "Verbal directions from a remote human only after a 30 to 90 s call-setup wait over compressed mobile video.",
      legacyOcrCamera:
        "Single-beep snapshot capture with zero conversational 3D rotation coaching or multi-frame foil glare recovery."
    },
    {
      id: "personal_safety",
      dimension: "Personal safety context",
      holdupGlasses:
        "STRENGTH_MIN_CONF = 0.80 never-guess gate + deterministic local schedule, 49 Nordic/INN brands, 10 avoid classes, EU-14 allergens & expiry check.",
      smartphoneOcr:
        "Raw unverified OCR: zero prescription schedule or allergy rules, reading partial or blurred digits aloud without a 0.80 confidence gate.",
      remoteVolunteerVideo:
        "Uncalibrated human reading over live video with zero persistent doseLog, duplicate-dose guard, or automatic INN synonym lookup.",
      legacyOcrCamera:
        "Raw offline OCR text dump only: zero personal medication schedule, drug-class avoid rules, allergen matching, or dose confidence gate."
    },
    {
      id: "privacy_autonomy",
      dimension: "Privacy & everyday autonomy",
      holdupGlasses:
        "On-device localStorage profile + RAM-only 8-frame ring + private open-ear HFP audio + #000000 Ray-Ban Display waveguide + hardware Capture LED.",
      smartphoneOcr:
        "Phone speaker or earbuds; holding a rear camera up in pharmacies and grocery aisles draws unwanted public attention.",
      remoteVolunteerVideo:
        "Exposes private prescriptions, patient name stickers, and home counters to 1,440 live remote video calls/yr with strangers.",
      legacyOcrCamera:
        "Offline processing, but zero personal profile storage, audio-only output without a #000000 waveguide card, and visible medical-device stigma."
    },
    {
      id: "assistive_tco",
      dimension: "3-year assistive TCO (4,320 checks)",
      holdupGlasses:
        "EUR 341.68 total 3-yr TCO (EUR 329.00 mainstream Ray-Ban Meta Gen 2 + EUR 12.68 Gemini Flash cloud at EUR 0.00294/check = 91.8% savings, 12.1x lower).",
      smartphoneOcr:
        "EUR 0 incremental app fee on an existing phone, but fails hands-free framing, active coaching, and deterministic dose-safety requirements.",
      remoteVolunteerVideo:
        "EUR 2,340.00 over 3 years on paid daily Aira plan (EUR 65/mo), or unpaid volunteer queues with 1,440 privacy disclosures/yr.",
      legacyOcrCamera:
        "EUR 4,150.00 3-yr TCO midpoint (EUR 3,800 to EUR 4,500 OrCam MyEye class hardware; HoldUp saves EUR 3,808.32 or 91.8%)."
    }
  ],
  fi: [
    {
      id: "hands_required",
      dimension: "Tarvittavat kädet tarkistuksessa",
      holdupGlasses:
        "0 kättä laitteella: molemmat kädet pysyvät vapaina rinnan korkeudella lääkepurkin kääntämiseen, läpipainoliuskan tukemiseen tai kepin ja vesilasin pitelyyn.",
      smartphoneOcr:
        "3 käden ongelma: 1 käsi pitää ja tähtää puhelinta sokkona 30 cm päässä samalla kun pakkauksen kääntö vaatii 2 kättä.",
      remoteVolunteerVideo:
        "1 käsi varattuna puhelimen kameran pitelyyn ja suuntaamiseen 30-90 s videopuhelun yhdistämisen ja tarkistuksen ajan.",
      legacyOcrCamera:
        "0 kättä kameralla sankakiinnikkeellä, mutta vaatii erillisen erikoislaitteen kosketus- tai osoituseleet."
    },
    {
      id: "physical_aiming",
      dimension: "Fyysinen suuntaus ja rajaus",
      holdupGlasses:
        "~1 fps kehoon suhteutettu Gemini Live -puheohjaus (käännä vasemmalle, lähemmäs, kallista kiiltoa) + FrameRing.pick terävimpien ruutujen valinta.",
      smartphoneOcr:
        "Sokea kertakuvausruletti: lukee suodattamatonta raakatekstiä tai vaikenee viivakoodin, tyhjän läpän tai foliokiillon kohdalla.",
      remoteVolunteerVideo:
        "Etähenkilön suulliset ohjeet vasta 30-90 s yhdistämisodotuksen jälkeen pakatun mobiilivideon yli.",
      legacyOcrCamera:
        "Yksittäisen äänimerkin kertakuva ilman keskustelevaa 3D-kääntöohjausta tai moniruutuista heijastuksen korjausta."
    },
    {
      id: "personal_safety",
      dimension: "Henkilökohtainen lääke- ja allergiaturva",
      holdupGlasses:
        "STRENGTH_MIN_CONF = 0.80 ei-arvauksia-raja + deterministinen aikataulu, 49 pohjoismaista/INN-nimeä, 10 välttöluokkaa, EU-14-allergeenit ja kestoaika.",
      smartphoneOcr:
        "Varmistamaton raaka-OCR: ei reseptiaikataulua tai allergiasääntöjä ja lukee sumeat osanumerot ilman 0.80 varmuusrajaa.",
      remoteVolunteerVideo:
        "Kalibroimaton ihmistulkinta live-videosta ilman pysyvää doseLog-kirjausta, tupla-annossuojaa tai automaattista INN-tarkistusta.",
      legacyOcrCamera:
        "Pelkkä paikallinen raaka-OCR: ei omaa lääkeaikataulua, lääkeluokkien välttösääntöjä, allergeenitarkistusta tai vahvuuden varmuusrajaa."
    },
    {
      id: "privacy_autonomy",
      dimension: "Tietosuoja ja arjen omatoimisuus",
      holdupGlasses:
        "Laitteen localStorage-profiili + vain RAM-muistin 8 ruudun puskuri + yksityinen avoimen korvan HFP-ääni + #000000 Ray-Ban Display -valojohde + kuvaus-LED.",
      smartphoneOcr:
        "Puhelimen kaiutin tai kuulokkeet; takakameran suuntaaminen apteekissa ja ruokakaupassa herättää ei-toivottua huomiota.",
      remoteVolunteerVideo:
        "Paljastaa reseptipakkaukset, potilastarrat ja kodin pöydät vieraille ihmisille 1,440 etävideopuhelussa vuodessa.",
      legacyOcrCamera:
        "Paikallinen käsittely, mutta ei omaa profiilia, vain ääni ilman #000000 valojohdekorttia ja näkyvä apuvälinelaitteen leima."
    },
    {
      id: "assistive_tco",
      dimension: "3 vuoden kokonaiskustannus (4,320 tarkistusta)",
      holdupGlasses:
        "EUR 341.68 3 v kokonaiskustannus (EUR 329.00 tavalliset Ray-Ban Meta Gen 2 -lasit + EUR 12.68 Gemini Flash -pilvi EUR 0.00294/kerta = 91.8% säästö, 12.1x edullisempi).",
      smartphoneOcr:
        "EUR 0 lisämaksu nykyisellä puhelimella, mutta ei täytä kädet vapaana -rajausta, ohjausta eikä determinististä annosturvaa.",
      remoteVolunteerVideo:
        "EUR 2,340.00 3 vuodessa maksullisella Aira-päivätilauksella (EUR 65/kk), tai vapaaehtoisjonot ja 1,440 tietosuojapaljastusta vuodessa.",
      legacyOcrCamera:
        "EUR 4,150.00 3 v keskihinta (EUR 3,800 - EUR 4,500 OrCam MyEye -luokan laite; HoldUp säästää EUR 3,808.32 eli 91.8%)."
    }
  ],
  sv: [
    {
      id: "hands_required",
      dimension: "Händer som krävs vid kontroll",
      holdupGlasses:
        "0 händer på enheten: båda händerna är fria i brösthöjd för att vrida en rund pillerburk, hålla en blisterkarta stadigt eller bära käpp och vattenglas.",
      smartphoneOcr:
        "3-handsproblemet: 1 hand måste hålla och rikta mobilen i blindo på 30 cm avstånd medan 2 händer behövs för förpackningen.",
      remoteVolunteerVideo:
        "1 hand upptagen med att hålla och rikta mobilkameran under 30 till 90 s samtalsetablering och etikettavläsning.",
      legacyOcrCamera:
        "0 händer på kameran via magnetiskt bågfäste, men kräver manuella tryck eller pekgester på specialiserad hårdvara."
    },
    {
      id: "physical_aiming",
      dimension: "Fysisk riktning och inramning",
      holdupGlasses:
        "~1 fps kroppsrelativ Gemini Live-röstguidning (vrid vänster, närmare, vinkla bort blänk) + FrameRing.pick val av skarpaste bildrutor.",
      smartphoneOcr:
        "Blind enbildsroulette: läser ostrukturerad råtext eller tystnar mot streckkod, tom flik eller folieblänk.",
      remoteVolunteerVideo:
        "Muntliga instruktioner från en person på distans först efter 30 till 90 s väntetid över komprimerad mobilvideo.",
      legacyOcrCamera:
        "Enkel bildtagning med ljudpip utan dialogbaserad 3D-vridningsguidning eller flerbildshantering av blänk."
    },
    {
      id: "personal_safety",
      dimension: "Personlig läkemedels- och allergisäkerhet",
      holdupGlasses:
        "STRENGTH_MIN_CONF = 0.80 gissa-aldrig-spärr + deterministiskt schema, 49 nordiska/INN-namn, 10 undvikandeklasser, EU-14-allergener och utgångsdatum.",
      smartphoneOcr:
        "Overifierad rå-OCR: saknar receptschema och allergiregler samt läser suddiga delsiffror utan 0.80 säkerhetsspärr.",
      remoteVolunteerVideo:
        "Okalibrerad mänsklig avläsning via livevideo utan sparad doseLog, dubbeldosspärr eller automatisk INN-kontroll.",
      legacyOcrCamera:
        "Endast lokal råtext-OCR: saknar personligt läkemedelsschema, läkemedelsklassregler, allergenmatchning och styrkespärr."
    },
    {
      id: "privacy_autonomy",
      dimension: "Integritet och självständighet i vardagen",
      holdupGlasses:
        "Lokal localStorage-profil på enheten + 8-bildrutors RAM-buffert + privat öppet-öra HFP-ljud + #000000 Ray-Ban Display-vågledare + hårdvaru-LED.",
      smartphoneOcr:
        "Mobilhögtalare eller hörlurar; att rikta bakkameran i apotek och matbutiker skapar oönskad uppmärksamhet.",
      remoteVolunteerVideo:
        "Exponerar privata recept, namnetiketter och hemmabänkar i 1,440 live-videosamtal/år med främmande personer.",
      legacyOcrCamera:
        "Offlinebearbetning, men ingen personlig profil, enbart ljud utan #000000 vågledarkort och synligt medicintekniskt stigma."
    },
    {
      id: "assistive_tco",
      dimension: "3-årig totalkostnad TCO (4,320 kontroller)",
      holdupGlasses:
        "EUR 341.68 total 3-års TCO (EUR 329.00 vanliga Ray-Ban Meta Gen 2 + EUR 12.68 Gemini Flash-moln vid EUR 0.00294/kontroll = 91.8% besparing, 12.1x lägre).",
      smartphoneOcr:
        "EUR 0 extra appavgift på befintlig mobil, men klarar varken handsfree-inramning, aktiv guidning eller deterministisk dossäkerhet.",
      remoteVolunteerVideo:
        "EUR 2,340.00 över 3 år med betald daglig Aira-plan (EUR 65/mån), eller volontärköer med 1,440 integritetsexponeringar/år.",
      legacyOcrCamera:
        "EUR 4,150.00 3-års TCO mittpunkt (EUR 3,800 till EUR 4,500 OrCam MyEye-hårdvara; HoldUp sparar EUR 3,808.32 eller 91.8%)."
    }
  ]
};

const COPY_BY_LOCALE: Record<UiLocale, LocaleCopy> = {
  en: {
    eyebrow: "First-Person AI Glasses vs Phone & Legacy Assistive Tech",
    heading: "Why First-Person Meta AI Glasses Beat Smartphone & Legacy OCR",
    subtitle:
      "A nose-bridge camera aligned with natural two-handed proprioception goes beyond mirroring a phone: both hands stay free, Gemini Live coaches alignment at ~1 fps, local rules block uncertain doses, and 3-year TCO drops by 91.8%.",
    handsFreeBadge: "0 Hands on Device (Both Hands Free)",
    tcoMultiplePill: "12.1x Lower 3-Yr TCO vs OrCam",
    kpiStripAriaLabel: "Verified HoldUp safety, latency, and 3-year unit economics summary",
    kpis: [
      {
        id: "zero_wrong_doses",
        value: "0",
        label: "Confident-wrong doses",
        detail: "Across 252 real-model reads gated by STRENGTH_MIN_CONF = 0.80"
      },
      {
        id: "live_hud_p50",
        value: "2.74 s",
        label: "Live glass-to-HUD p50",
        detail: "2,738.8 ms E2E frame-to-waveguide verdict p50 (582 ms first audio)"
      },
      {
        id: "three_year_tco",
        value: "EUR 341.68",
        label: "3-yr assistive TCO",
        detail: "EUR 329.00 Ray-Ban Meta Gen 2 + EUR 12.68 cloud (4,320 checks)"
      },
      {
        id: "tco_savings",
        value: "91.8%",
        label: "3-yr TCO savings",
        detail: "Saves EUR 3,808.32 vs EUR 4,150.00 OrCam (85.4% vs EUR 2,340.00 Aira)"
      }
    ],
    filterGroupAriaLabel: "Spotlight an everyday comparison dimension",
    filterAllLabel: "All 5 Dimensions",
    filterButtonLabels: {
      hands_required: "1. Hands Free",
      physical_aiming: "2. Aiming",
      personal_safety: "3. Safety Gate",
      privacy_autonomy: "4. Privacy",
      assistive_tco: "5. 3-Yr TCO"
    },
    filterButtonAria: (label, active) =>
      active ? `${label} spotlight active` : `Spotlight ${label} row in comparison table`,
    spotlightAllTitle: "Showing all 5 everyday dimensions across 4 assistive approaches",
    spotlightAllBody:
      "Select any dimension button above to highlight a specific workflow, clinical safety, privacy, or public procurement comparison row.",
    spotlightRowPrefix: "Glasses advantage",
    tableCaption:
      "5-dimension assistive comparison: HoldUp on Meta AI Glasses versus Smartphone OCR Apps, Remote Human Video, and Dedicated OCR Cameras (OrCam)",
    colDimension: "Everyday Dimension",
    colHoldupGlasses: "HoldUp on Meta AI Glasses",
    colHoldupBadge: "1ST-PERSON POV",
    colSmartphoneOcr: "Smartphone OCR Apps",
    colRemoteVolunteerVideo: "Remote Human Video",
    colLegacyOcrCamera: "Dedicated OCR Cameras (OrCam)",
    selectedRowBadge: "SPOTLIGHT",
    rehabNoteHeading: "Public Vision-Rehabilitation Leverage (100 Wearers / 3 Years)",
    rehabNoteBody:
      "Equipping 100 low-vision residents with HoldUp + Ray-Ban Meta Gen 2 costs EUR 34,168 vs EUR 415,000 for OrCam-class readers, saving EUR 380,832 or serving 1,214 wearers on the same 100-device public rehabilitation budget."
  },
  fi: {
    eyebrow: "Ensimmäisen persoonan AI-lasit vs puhelin ja perinteiset apuvälineet",
    heading: "Miksi Meta AI -lasit voittavat älypuhelimen ja perinteiset OCR-kamerat",
    subtitle:
      "Nenäsiltaan sijoitettu kamera vapauttaa molemmat kädet luonnolliselle rintakorkeudelle: Gemini Live ohjaa rajausta ~1 fps nopeudella, paikallinen turvasääntö estää arvaukset ja 3 vuoden kustannus laskee 91.8%.",
    handsFreeBadge: "0 kättä laitteella (molemmat kädet vapaana)",
    tcoMultiplePill: "12.1x edullisempi 3 v TCO kuin OrCam",
    kpiStripAriaLabel: "Varmennettu yhteenveto HoldUpin turvallisuudesta, viiveestä ja 3 vuoden kustannuksista",
    kpis: [
      {
        id: "zero_wrong_doses",
        value: "0",
        label: "Väärää varmaa annoslukua",
        detail: "252 oikean mallin tarkistuksessa STRENGTH_MIN_CONF = 0.80 -rajalla"
      },
      {
        id: "live_hud_p50",
        value: "2.74 s",
        label: "Lasista HUD-näyttöön p50",
        detail: "2,738.8 ms E2E kehyksestä HUD-päätökseen p50 (582 ms ensiääni)"
      },
      {
        id: "three_year_tco",
        value: "EUR 341.68",
        label: "3 v kokonaiskustannus",
        detail: "EUR 329.00 Ray-Ban Meta Gen 2 + EUR 12.68 pilvi (4,320 tarkistusta)"
      },
      {
        id: "tco_savings",
        value: "91.8%",
        label: "3 v kustannussäästö",
        detail: "Säästää EUR 3,808.32 vs EUR 4,150.00 OrCam (85.4% vs EUR 2,340.00 Aira)"
      }
    ],
    filterGroupAriaLabel: "Korosta arjen vertailu-ulottuvuus",
    filterAllLabel: "Kaikki 5 ulottuvuutta",
    filterButtonLabels: {
      hands_required: "1. Kädet vapaana",
      physical_aiming: "2. Suuntaus",
      personal_safety: "3. Turvaraja",
      privacy_autonomy: "4. Tietosuoja",
      assistive_tco: "5. 3 v TCO"
    },
    filterButtonAria: (label, active) =>
      active ? `${label} korostettuna` : `Korosta rivi ${label} vertailutaulukossa`,
    spotlightAllTitle: "Näytetään kaikki 5 arjen ulottuvuutta 4 ratkaisun välillä",
    spotlightAllBody:
      "Valitse yllä oleva painike korostaaksesi tietyn ergonomia-, lääketurva-, tietosuoja- tai hankintakustannusrivin.",
    spotlightRowPrefix: "Lasien etu",
    tableCaption:
      "5 ulottuvuuden apuvälinevertailu: HoldUp Meta AI -laseilla verrattuna älypuhelimen OCR-sovelluksiin, etävideotukeen ja erillisiin OCR-kameroihin (OrCam)",
    colDimension: "Arjen ulottuvuus",
    colHoldupGlasses: "HoldUp Meta AI -laseilla",
    colHoldupBadge: "1. PERSOONAN KUVA",
    colSmartphoneOcr: "Älypuhelimen OCR-sovellukset",
    colRemoteVolunteerVideo: "Etävideotuki",
    colLegacyOcrCamera: "Erilliset OCR-kamerat (OrCam)",
    selectedRowBadge: "KOROSTE",
    rehabNoteHeading: "Julkisen näönkuntoutuksen vaikuttavuus (100 käyttäjää / 3 vuotta)",
    rehabNoteBody:
      "100 heikkonäköisen asukkaan varustaminen HoldUp + Ray-Ban Meta Gen 2 -paketilla maksaa EUR 34,168 vs EUR 415,000 OrCam-luokan laitteilla, säästäen EUR 380,832 eli palvellen 1,214 käyttäjää samalla 100 laitteen budjetilla."
  },
  sv: {
    eyebrow: "AI-glasögon i förstapersonsvy mot mobil och äldre hjälpmedel",
    heading: "Varför Meta AI-glasögon slår mobilappar och dedikerade OCR-kameror",
    subtitle:
      "En kamera vid näsryggen i linje med händernas naturliga läge gör mer än att spegla en mobil: båda händerna är fria, Gemini Live guidar i ~1 fps, lokala regler stoppar osäkra doser och 3-års TCO minskar med 91.8%.",
    handsFreeBadge: "0 händer på enheten (båda händerna fria)",
    tcoMultiplePill: "12.1x lägre 3-års TCO mot OrCam",
    kpiStripAriaLabel: "Verifierad sammanfattning av HoldUps säkerhet, svarstid och 3-åriga ekonomi",
    kpis: [
      {
        id: "zero_wrong_doses",
        value: "0",
        label: "Säkra feldosavläsningar",
        detail: "Över 252 skarpa modellkörningar bakom STRENGTH_MIN_CONF = 0.80"
      },
      {
        id: "live_hud_p50",
        value: "2.74 s",
        label: "Glasögon till HUD p50",
        detail: "2,738.8 ms E2E bildruta-till-HUD-beslut p50 (582 ms första ljud)"
      },
      {
        id: "three_year_tco",
        value: "EUR 341.68",
        label: "3-års totalkostnad TCO",
        detail: "EUR 329.00 Ray-Ban Meta Gen 2 + EUR 12.68 moln (4,320 kontroller)"
      },
      {
        id: "tco_savings",
        value: "91.8%",
        label: "3-års kostnadsbesparing",
        detail: "Sparar EUR 3,808.32 mot EUR 4,150.00 OrCam (85.4% mot EUR 2,340.00 Aira)"
      }
    ],
    filterGroupAriaLabel: "Markera en vardagsdimension i jämförelsen",
    filterAllLabel: "Alla 5 dimensioner",
    filterButtonLabels: {
      hands_required: "1. Händer fria",
      physical_aiming: "2. Inramning",
      personal_safety: "3. Säkerhetsspärr",
      privacy_autonomy: "4. Integritet",
      assistive_tco: "5. 3-års TCO"
    },
    filterButtonAria: (label, active) =>
      active ? `${label} markerad` : `Markera raden ${label} i jämförelsetabellen`,
    spotlightAllTitle: "Visar alla 5 vardagsdimensioner över 4 hjälpmedelslösningar",
    spotlightAllBody:
      "Välj en dimensionsknapp ovan för att framhäva en specifik rad för ergonomi, läkemedelssäkerhet, integritet eller upphandlingskostnad.",
    spotlightRowPrefix: "Glasögonfördel",
    tableCaption:
      "5-dimensionell hjälpmedelsjämförelse: HoldUp på Meta AI-glasögon jämfört med mobil-OCR, mänsklig videoassistans och dedikerade OCR-kameror (OrCam)",
    colDimension: "Vardagsdimension",
    colHoldupGlasses: "HoldUp på Meta AI-glasögon",
    colHoldupBadge: "1:A-PERSONSVY",
    colSmartphoneOcr: "Mobilappar med OCR",
    colRemoteVolunteerVideo: "Mänsklig videoassistans",
    colLegacyOcrCamera: "Dedikerade OCR-kameror (OrCam)",
    selectedRowBadge: "FOKUS",
    rehabNoteHeading: "Utväxling för offentlig synrehabilitering (100 bärare / 3 år)",
    rehabNoteBody:
      "Att utrusta 100 synskadade invånare med HoldUp + Ray-Ban Meta Gen 2 kostar EUR 34,168 mot EUR 415,000 för OrCam-klassens läsare, vilket sparar EUR 380,832 eller når 1,214 användare på samma budget för 100 enheter."
  }
};

export function getGlassesComparisonDimensions(lang: string): GlassesComparisonRow[] {
  const locale = normalizeLang(lang);
  return ROWS_BY_LOCALE[locale].map((row) => ({
    id: row.id,
    dimension: row.dimension,
    holdupGlasses: row.holdupGlasses,
    smartphoneOcr: row.smartphoneOcr,
    remoteVolunteerVideo: row.remoteVolunteerVideo,
    legacyOcrCamera: row.legacyOcrCamera
  }));
}

function normalizeInitialFilter(raw?: GlassesComparisonFilter): GlassesComparisonFilter {
  if (!raw || raw === "all") {
    return "all";
  }
  return VALID_DIMENSION_IDS.includes(raw) ? raw : "all";
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

const KPI_GRID_STYLE: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
  gap: "var(--space-3, 12px)"
};

const FILTER_BUTTON_STYLE: CSSProperties = {
  minHeight: "56px",
  minWidth: "56px",
  padding: "10px 14px",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "6px",
  fontSize: "var(--text-xs, 0.875rem)",
  fontWeight: 800,
  flex: "1 1 132px"
};

function ComparisonIcon({
  kind
}: {
  kind:
    | "glasses"
    | "zero_wrong_doses"
    | "live_hud_p50"
    | "three_year_tco"
    | "tco_savings"
    | GlassesComparisonDimensionId;
}) {
  const iconStyle: CSSProperties = { width: "18px", height: "18px", flexShrink: 0 };

  if (kind === "glasses" || kind === "hands_required") {
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
        <rect x="2.5" y="9" width="7.5" height="6" rx="2" />
        <rect x="14" y="9" width="7.5" height="6" rx="2" />
        <path d="M10 11.5h4" />
        <path d="M2.5 11L4.5 7" />
        <path d="M21.5 11L19.5 7" />
      </svg>
    );
  }

  if (kind === "physical_aiming" || kind === "live_hud_p50") {
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
        <path d="M4 8V5a1 1 0 0 1 1-1h3" />
        <path d="M16 4h3a1 1 0 0 1 1 1v3" />
        <path d="M20 16v3a1 1 0 0 1-1 1h-3" />
        <path d="M8 20H5a1 1 0 0 1-1-1v-3" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    );
  }

  if (kind === "personal_safety" || kind === "zero_wrong_doses") {
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

  if (kind === "privacy_autonomy") {
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
        <rect x="5" y="11" width="14" height="10" rx="2" />
        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
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
      <polyline points="22 17 13.5 8.5 8.5 13.5 2 7" />
      <polyline points="16 17 22 17 22 11" />
    </svg>
  );
}

export function WhyGlassesComparisonCard(props: WhyGlassesComparisonCardProps) {
  const { lang, defaultSelectedDimension } = props;
  const locale = normalizeLang(lang);
  const copy = COPY_BY_LOCALE[locale];
  const rows = getGlassesComparisonDimensions(locale);
  const disclaimerText = t(locale, "notMedicalDevice");

  const [selectedDimension, setSelectedDimension] = useState<GlassesComparisonFilter>(() =>
    normalizeInitialFilter(defaultSelectedDimension)
  );

  const spotlightRow =
    selectedDimension === "all"
      ? null
      : (rows.find((row) => row.id === selectedDimension) ?? null);

  const headingId = "why-glasses-comparison-heading";
  const tableCaptionId = "why-glasses-comparison-table-caption";

  return (
    <section
      aria-labelledby={headingId}
      lang={locale}
      className="card why-glasses-comparison-card"
      data-selected-dimension={selectedDimension}
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
            flex: "1 1 340px"
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
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "8px"
          }}
        >
          <span
            role="status"
            className="badge why-glasses-handsfree-badge"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              padding: "6px 12px",
              borderRadius: "var(--radius-pill, 9999px)",
              backgroundColor: "var(--verdict-match-bg, #06261d)",
              color: "var(--verdict-match-fg, #7ef7c8)",
              border: "2px solid var(--verdict-match-border, #2dd4a0)",
              fontSize: "var(--text-xs, 0.875rem)",
              fontWeight: 800
            }}
          >
            <ComparisonIcon kind="glasses" />
            <span>{copy.handsFreeBadge}</span>
          </span>

          <span
            className="pill why-glasses-tco-pill"
            style={{
              padding: "6px 12px",
              borderRadius: "var(--radius-pill, 9999px)",
              backgroundColor: "var(--verdict-info-bg, #0a1f38)",
              color: "var(--verdict-info-fg, #a6d4ff)",
              border: "var(--border-width, 1.5px) solid var(--verdict-info-border, #4da3ff)",
              fontSize: "var(--text-xs, 0.875rem)",
              fontWeight: 800
            }}
          >
            {copy.tcoMultiplePill}
          </span>
        </div>
      </header>

      <ul
        aria-label={copy.kpiStripAriaLabel}
        className="why-glasses-kpi-strip"
        style={KPI_GRID_STYLE}
      >
        {copy.kpis.map((kpi) => {
          const isMatchTone = kpi.id === "zero_wrong_doses" || kpi.id === "tco_savings";
          return (
            <li
              key={kpi.id}
              data-kpi-id={kpi.id}
              className={`why-glasses-kpi-tile why-glasses-kpi-${kpi.id}`}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "6px",
                padding: "var(--space-4, 16px)",
                borderRadius: "var(--radius-md, 12px)",
                backgroundColor: "var(--bg-elevated, #1a2333)",
                border: isMatchTone
                  ? "1.5px solid var(--verdict-match-border, #2dd4a0)"
                  : "var(--border-width, 1.5px) solid var(--border-subtle, #2c3a52)"
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "8px"
                }}
              >
                <strong
                  className="why-glasses-kpi-value"
                  style={{
                    fontFamily: "var(--font-mono, monospace)",
                    fontSize: "var(--text-xl, 1.5rem)",
                    fontWeight: 800,
                    lineHeight: 1.15,
                    fontVariantNumeric: "tabular-nums",
                    color: isMatchTone
                      ? "var(--verdict-match-fg, #7ef7c8)"
                      : "var(--text-primary, #f8fafc)"
                  }}
                >
                  {kpi.value}
                </strong>

                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: "34px",
                    height: "34px",
                    borderRadius: "var(--radius-sm, 8px)",
                    backgroundColor: isMatchTone
                      ? "var(--verdict-match-bg, #06261d)"
                      : "var(--verdict-info-bg, #0a1f38)",
                    color: isMatchTone
                      ? "var(--verdict-match-fg, #7ef7c8)"
                      : "var(--verdict-info-fg, #a6d4ff)",
                    border: isMatchTone
                      ? "1.5px solid var(--verdict-match-border, #2dd4a0)"
                      : "1.5px solid var(--verdict-info-border, #4da3ff)"
                  }}
                >
                  <ComparisonIcon kind={kpi.id} />
                </span>
              </div>

              <span
                className="why-glasses-kpi-label"
                style={{
                  fontSize: "var(--text-sm, 1rem)",
                  fontWeight: 800,
                  lineHeight: 1.3,
                  color: "var(--text-primary, #f8fafc)"
                }}
              >
                {kpi.label}
              </span>

              <p
                className="why-glasses-kpi-detail"
                style={{
                  margin: 0,
                  fontSize: "var(--text-xs, 0.875rem)",
                  lineHeight: 1.4,
                  color: "var(--text-secondary, #d8e1ee)"
                }}
              >
                {kpi.detail}
              </p>
            </li>
          );
        })}
      </ul>

      <div
        role="group"
        aria-label={copy.filterGroupAriaLabel}
        className="why-glasses-filter-group"
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "8px"
        }}
      >
        <button
          type="button"
          data-action="spotlight-dimension"
          data-dimension-filter="all"
          aria-pressed={selectedDimension === "all"}
          aria-label={copy.filterButtonAria(copy.filterAllLabel, selectedDimension === "all")}
          className={`btn ${selectedDimension === "all" ? "btn-primary" : "btn-secondary"} why-glasses-filter-btn`}
          onClick={() => setSelectedDimension("all")}
          style={FILTER_BUTTON_STYLE}
        >
          <span>{copy.filterAllLabel}</span>
        </button>

        {VALID_DIMENSION_IDS.map((dimId) => {
          const btnLabel = copy.filterButtonLabels[dimId];
          const isActive = selectedDimension === dimId;
          return (
            <button
              key={dimId}
              type="button"
              data-action="spotlight-dimension"
              data-dimension-filter={dimId}
              aria-pressed={isActive}
              aria-label={copy.filterButtonAria(btnLabel, isActive)}
              className={`btn ${isActive ? "btn-primary" : "btn-secondary"} why-glasses-filter-btn`}
              onClick={() => setSelectedDimension(dimId)}
              style={FILTER_BUTTON_STYLE}
            >
              <ComparisonIcon kind={dimId} />
              <span>{btnLabel}</span>
            </button>
          );
        })}
      </div>

      <div
        role="status"
        aria-live="polite"
        className="why-glasses-spotlight-banner"
        data-spotlight-active={spotlightRow ? spotlightRow.id : "all"}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "4px",
          padding: "12px 16px",
          borderRadius: "var(--radius-md, 12px)",
          backgroundColor: spotlightRow
            ? "var(--verdict-match-bg, #06261d)"
            : "var(--bg-elevated, #1a2333)",
          color: spotlightRow
            ? "var(--verdict-match-fg, #7ef7c8)"
            : "var(--text-primary, #f8fafc)",
          border: spotlightRow
            ? "2px solid var(--verdict-match-border, #2dd4a0)"
            : "var(--border-width, 1.5px) solid var(--border-subtle, #2c3a52)"
        }}
      >
        <strong
          style={{
            fontSize: "var(--text-sm, 1rem)",
            fontWeight: 800,
            lineHeight: 1.35
          }}
        >
          {spotlightRow
            ? `${copy.spotlightRowPrefix}: ${spotlightRow.dimension}`
            : copy.spotlightAllTitle}
        </strong>
        <p
          style={{
            margin: 0,
            fontSize: "var(--text-xs, 0.875rem)",
            lineHeight: 1.45,
            color: "var(--text-primary, #f8fafc)"
          }}
        >
          {spotlightRow ? spotlightRow.holdupGlasses : copy.spotlightAllBody}
        </p>
      </div>

      <div
        role="region"
        aria-labelledby={tableCaptionId}
        tabIndex={0}
        className="why-glasses-table-region"
        style={{
          width: "100%",
          overflowX: "auto",
          borderRadius: "var(--radius-md, 12px)",
          border: "var(--border-width, 1.5px) solid var(--border-strong, #6980a3)",
          backgroundColor: "var(--bg-surface, #121926)"
        }}
      >
        <table
          className="why-glasses-comparison-table"
          style={{
            width: "100%",
            minWidth: "780px",
            borderCollapse: "collapse",
            textAlign: "left"
          }}
        >
          <caption
            id={tableCaptionId}
            style={{
              padding: "12px 16px",
              textAlign: "left",
              fontSize: "var(--text-xs, 0.875rem)",
              fontWeight: 700,
              color: "var(--text-secondary, #d8e1ee)",
              backgroundColor: "var(--bg-elevated, #1a2333)",
              borderBottom: "var(--border-width, 1.5px) solid var(--border-subtle, #2c3a52)"
            }}
          >
            {copy.tableCaption}
          </caption>

          <thead>
            <tr
              style={{
                backgroundColor: "var(--bg-elevated, #1a2333)",
                borderBottom: "2px solid var(--border-strong, #6980a3)"
              }}
            >
              <th
                scope="col"
                data-col="dimension"
                style={{
                  padding: "12px 14px",
                  width: "17%",
                  fontSize: "var(--text-xs, 0.875rem)",
                  fontWeight: 800,
                  color: "var(--text-primary, #f8fafc)",
                  verticalAlign: "bottom"
                }}
              >
                {copy.colDimension}
              </th>

              <th
                scope="col"
                data-col="holdupGlasses"
                style={{
                  padding: "12px 14px",
                  width: "25%",
                  fontSize: "var(--text-xs, 0.875rem)",
                  fontWeight: 800,
                  backgroundColor: "var(--verdict-match-bg, #06261d)",
                  color: "var(--verdict-match-fg, #7ef7c8)",
                  borderLeft: "2px solid var(--verdict-match-border, #2dd4a0)",
                  borderRight: "2px solid var(--verdict-match-border, #2dd4a0)",
                  verticalAlign: "bottom"
                }}
              >
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-start",
                    gap: "4px"
                  }}
                >
                  <span
                    className="badge"
                    style={{
                      padding: "2px 8px",
                      borderRadius: "var(--radius-sm, 8px)",
                      backgroundColor: "var(--bg-surface, #121926)",
                      color: "var(--verdict-match-fg, #7ef7c8)",
                      border: "1.5px solid var(--verdict-match-border, #2dd4a0)",
                      fontSize: "0.72rem",
                      fontWeight: 800,
                      letterSpacing: "0.04em"
                    }}
                  >
                    {copy.colHoldupBadge}
                  </span>
                  <span>{copy.colHoldupGlasses}</span>
                </div>
              </th>

              <th
                scope="col"
                data-col="smartphoneOcr"
                style={{
                  padding: "12px 14px",
                  width: "19%",
                  fontSize: "var(--text-xs, 0.875rem)",
                  fontWeight: 800,
                  color: "var(--text-primary, #f8fafc)",
                  verticalAlign: "bottom"
                }}
              >
                {copy.colSmartphoneOcr}
              </th>

              <th
                scope="col"
                data-col="remoteVolunteerVideo"
                style={{
                  padding: "12px 14px",
                  width: "19%",
                  fontSize: "var(--text-xs, 0.875rem)",
                  fontWeight: 800,
                  color: "var(--text-primary, #f8fafc)",
                  verticalAlign: "bottom"
                }}
              >
                {copy.colRemoteVolunteerVideo}
              </th>

              <th
                scope="col"
                data-col="legacyOcrCamera"
                style={{
                  padding: "12px 14px",
                  width: "20%",
                  fontSize: "var(--text-xs, 0.875rem)",
                  fontWeight: 800,
                  color: "var(--text-primary, #f8fafc)",
                  verticalAlign: "bottom"
                }}
              >
                {copy.colLegacyOcrCamera}
              </th>
            </tr>
          </thead>

          <tbody>
            {rows.map((row, index) => {
              const isHighlighted = selectedDimension === row.id;
              const isLastRow = index === rows.length - 1;
              const rowBorderBottom = isHighlighted
                ? "2px solid var(--accent, #5cc0ff)"
                : isLastRow
                  ? "none"
                  : "1px solid var(--border-subtle, #2c3a52)";

              return (
                <tr
                  key={row.id}
                  data-dimension-id={row.id}
                  data-highlighted={isHighlighted ? "true" : "false"}
                  className={`why-glasses-row why-glasses-row-${row.id}${isHighlighted ? " is-highlighted" : ""}`}
                  style={{
                    backgroundColor: isHighlighted
                      ? "var(--bg-elevated, #1a2333)"
                      : "var(--bg-surface, #121926)",
                    borderTop: isHighlighted ? "2px solid var(--accent, #5cc0ff)" : undefined,
                    borderBottom: rowBorderBottom
                  }}
                >
                  <th
                    scope="row"
                    data-row-header={row.id}
                    style={{
                      padding: "14px",
                      fontSize: "var(--text-sm, 1rem)",
                      fontWeight: 800,
                      lineHeight: 1.35,
                      color: "var(--text-primary, #f8fafc)",
                      verticalAlign: "top"
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "flex-start",
                        gap: "6px"
                      }}
                    >
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "8px"
                        }}
                      >
                        <span style={{ color: "var(--accent, #5cc0ff)", display: "inline-flex" }}>
                          <ComparisonIcon kind={row.id} />
                        </span>
                        <span>{row.dimension}</span>
                      </span>

                      {isHighlighted ? (
                        <span
                          className="badge why-glasses-row-spotlight-badge"
                          style={{
                            padding: "2px 8px",
                            borderRadius: "var(--radius-sm, 8px)",
                            backgroundColor: "var(--verdict-info-bg, #0a1f38)",
                            color: "var(--verdict-info-fg, #a6d4ff)",
                            border: "1.5px solid var(--verdict-info-border, #4da3ff)",
                            fontSize: "0.72rem",
                            fontWeight: 800,
                            letterSpacing: "0.04em"
                          }}
                        >
                          {copy.selectedRowBadge}
                        </span>
                      ) : null}
                    </div>
                  </th>

                  <td
                    data-col="holdupGlasses"
                    style={{
                      padding: "14px",
                      fontSize: "var(--text-xs, 0.875rem)",
                      fontWeight: 700,
                      lineHeight: 1.45,
                      backgroundColor: "var(--verdict-match-bg, #06261d)",
                      color: "var(--verdict-match-fg, #7ef7c8)",
                      borderLeft: "2px solid var(--verdict-match-border, #2dd4a0)",
                      borderRight: "2px solid var(--verdict-match-border, #2dd4a0)",
                      verticalAlign: "top"
                    }}
                  >
                    {row.holdupGlasses}
                  </td>

                  <td
                    data-col="smartphoneOcr"
                    style={{
                      padding: "14px",
                      fontSize: "var(--text-xs, 0.875rem)",
                      lineHeight: 1.45,
                      color: "var(--text-secondary, #d8e1ee)",
                      verticalAlign: "top"
                    }}
                  >
                    {row.smartphoneOcr}
                  </td>

                  <td
                    data-col="remoteVolunteerVideo"
                    style={{
                      padding: "14px",
                      fontSize: "var(--text-xs, 0.875rem)",
                      lineHeight: 1.45,
                      color: "var(--text-secondary, #d8e1ee)",
                      verticalAlign: "top"
                    }}
                  >
                    {row.remoteVolunteerVideo}
                  </td>

                  <td
                    data-col="legacyOcrCamera"
                    style={{
                      padding: "14px",
                      fontSize: "var(--text-xs, 0.875rem)",
                      lineHeight: 1.45,
                      color: "var(--text-secondary, #d8e1ee)",
                      verticalAlign: "top"
                    }}
                  >
                    {row.legacyOcrCamera}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div
        role="note"
        className="why-glasses-rehab-note"
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
        <ComparisonIcon kind="tco_savings" />
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <strong
            style={{
              fontSize: "var(--text-sm, 1rem)",
              fontWeight: 800,
              lineHeight: 1.35
            }}
          >
            {copy.rehabNoteHeading}
          </strong>
          <p
            style={{
              margin: 0,
              fontSize: "var(--text-xs, 0.875rem)",
              lineHeight: 1.45,
              color: "var(--text-primary, #f8fafc)"
            }}
          >
            {copy.rehabNoteBody} {disclaimerText}
          </p>
        </div>
      </div>
    </section>
  );
}

export default WhyGlassesComparisonCard;
