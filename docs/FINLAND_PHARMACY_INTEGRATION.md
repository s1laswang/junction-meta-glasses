# Finnish Community Pharmacy Dispensing-Counter Pilot Specification (`docs/FINLAND_PHARMACY_INTEGRATION.md`)

**Scope:** Zero-Cloud Pharmacy Counter Deployment Blueprint for Helsinki & Nationwide Finnish Community Pharmacies  
**Target Counter Environments:** **Yliopiston Apteekki** (Itäkeskus, Mannerheimintie, and 17-branch national network) and **Suomen Apteekkariliitto** (Association of Finnish Pharmacies, >600 private community pharmacies) running **Receptum MAXX** and **Pharmadata Salix / PD3** dispensing workstations  
**Rehabilitation & Co-Design Partner:** **Näkövammaisten liitto ry** (Finnish Federation of the Visually Impaired), **Iiris Center**, Marjaniementie 74, Marjaniemi / Itäkeskus, 00930 Helsinki  
**Regulatory Boundary:** Assistive label-reading and user-owned checklist onboarding utility outside EU MDR Art. 2(1) medical-device scope (`docs/PRIVACY.md`, `docs/PILOT_PLAN.md`)

---

## 1. Architectural Rationale: Dispensing-Counter Thermal QR vs. Direct Kanta Integration

For blind, low-vision, and older polypharmacy patients in Finland (`~80,000` people with visual impairment, `>80%` aged `65+`), the sharpest real-world adoption bottleneck is **day-one medication list entry**. Asking a user with macular degeneration, diabetic retinopathy, or total blindness to type commercial drug names, comma-decimal milligram strengths (`2,5 mg`), and 13-digit barcodes onto a smartphone screen invites transcription error before the first check even begins.

At the same time, attempting to pull prescriptions directly from Finland's national e-prescription infrastructure creates an immediate **18+ month regulatory and architectural wall**. HoldUp bypasses that wall without sacrificing data accuracy by anchoring onboarding at the **pharmacy dispensing counter** during mandatory statutory medication counseling (*lääkeneuvonta*).

### 1.1 Why Direct Kanta *Reseptikeskus* HL7/FHIR Integration Takes 18+ Months

Finland's national Prescription Centre (**Kanta *Reseptikeskus***, operated by **Kela** under **THL** functional specifications, the Electronic Prescription Act *Laki sähköisestä lääkemääräyksestä* `61/2007`, and the Client Data Act *Asiakastietolaki* `703/2023`) is designed for clinical prescribing and pharmacy dispensing ERP systems, not lightweight consumer assistive readers:

1. **Class A System Classification & Accredited Security Auditing:** Any external software reading structured e-prescriptions from Kanta *Reseptikeskus* (or Kanta PHR / *Omatietovaranto* clinical interfaces) must register with **Valvira**, satisfy THL national profile specifications (HL7 v3 CDA R2 and Kanta FHIR R4 profiles), and pass a formal **information security assessment (*tietoturvallisuuden arviointi*)** performed by a **Traficom / Katakri**-accredited conformity assessment body before production credentials are issued.
2. **Mandatory Kela Joint Testing (*Yhteistestaus*) & Healthcare PKI:** Connecting to Kanta production endpoints requires multi-month scheduled joint-testing slots with Kela, smart-card professional authentication (**DVV *sosiaali- ja terveydenhuollon ammattikortti***) or strong Suomi.fi e-identification (*vahva sähköinen tunnistautuminen*), and persistent audit logging tied to the patient's Finnish personal identity code (*henkilötunnus* / HETU).
3. **Unnecessary Centralization of Special-Category Health Data:** Pulling Kanta records into a cloud backend forces the assistive app operator to become a regulated controller/processor of identifiable prescription histories under GDPR Art. 9, creating a high-value central database that HoldUp's zero-retention architecture explicitly refuses to build.

| Integration Dimension | Direct Kanta *Reseptikeskus* HL7 / FHIR API | HoldUp Counter Auxiliary QR (`holdup://rx?v=1`) |
|---|---|---|
| **Accreditation & Lead Time** | **18+ months** (THL specs, Traficom security audit, Kela *yhteistestaus*, Valvira Class A registration) | **Immediate Day-1 pilot readiness** (local counter print utility, zero Kanta API write/read) |
| **Pharmacy ERP Modification** | Deep core ERP vendor release cycle inside **MAXX** or **Salix** Kanta connector modules | **Zero core Kanta module changes**; consumes display/print fields already in terminal memory |
| **Personal Identity (*HETU*) Exposure** | Requires Suomi.fi / HETU identity binding and statutory Kanta access logs | **Zero PII / zero HETU**; QR encodes only commercial package metadata and schedule slots |
| **Cloud Infrastructure Dependency** | Requires high-availability cloud health-data vault, HSM certificates, and VPN/PKI | **100% offline-capable**; scanned directly from thermal sticker into phone `localStorage` |
| **Counter Hardware Cost** | EUR `0` hardware, but six-figure compliance and audit engineering cost | **EUR `0` new hardware**; prints on existing **Zebra** / **Citizen** thermal dosage-label printers |

### 1.2 Leveraging Data Already in Memory on Finnish `MAXX` and `Salix` Terminals

Across **Yliopiston Apteekki** and **Suomen Apteekkariliitto** member pharmacies, virtually every dispensing counter runs **Receptum MAXX** or **Pharmadata Salix** (alongside Pharmadata PD3 / YaPre workstations) connected to a desktop direct-thermal label printer (**Zebra ZD421 / GK420d** or **Citizen CL-S521 / CL-E321**) and a 2D handheld barcode scanner.

During standard prescription dispensing (*reseptintoimitus*):

1. The pharmacist (*farmaseutti* or *proviisori*) retrieves the e-prescription in **MAXX** or **Salix**, verifies any generic substitution (*lääkevaihto*) approved with the customer at the counter, and scans the physical carton's **2D GS1 DataMatrix** (EU Falsified Medicines Directive verification via **FiMVO**) or **EAN-13** barcode.
2. At that exact moment, the dispensing workstation already holds in local RAM every structured field sourced from the national pharmaceutical product registry (**Lääketietokanta**, maintained by **Pharmaca Health Intelligence / Lääketietokeskus** and **Fimea**):
   - **Patient-approved commercial package name** (`meds[].name`, matching the physical box handed to the customer after *lääkevaihto*, e.g., `Bisoprolol Orion` rather than the originally prescribed brand if substituted).
   - **Normalized INN active substance** (`meds[].ingredient`, e.g., `bisoprololi` / `bisoprolol`, `amlodipiini` / `amlodipine`, `metformiini` / `metformin`).
   - **Unit strength normalized from Nordic comma-decimal notation** (`meds[].strength`, e.g., `2,5 mg` normalized to `2.5 mg`, `500 mg`, `20 mg`).
   - **Structured daily dosing schedule slots** (`meds[].schedule`, mapped from the pharmacist-reviewed Finnish/Swedish *annostusohje*, e.g., `1 tabletti aamuisin` -> `["morning"]`, `1 tabletti aamulla ja illalla` -> `["morning", "evening"]`).
   - **Nordic 6-digit VNR (*Pohjoismainen tuotenumero*) & commercial EAN-13 GTIN** (`meds[].barcode`, e.g., `6432100024680`, enabling deterministic `100%` offline recognition in `web/src/camera/barcode.ts`).
   - **Pharmacist counseling contraindication tags** (`avoid`, e.g., `["NSAIDs"]` when dispensing ACE inhibitors, ARBs, diuretics, or anticoagulants so OTC *tulehduskipulääkkeet* such as *Burana 400 mg* trigger immediate spoken warnings at home).
3. When the workstation spools the standard Finnish thermal patient dosage sticker (*annostusohjetarra*, typically `70 x 35 mm` or `80 x 40 mm` direct-thermal stock), a local print-hook or standalone offline browser/ZPL utility prints an auxiliary **`25 x 25 mm` ISO/IEC 18004 QR code** (`holdup://rx?v=1&data=...`) either on a peel-away side tab of the thermal label roll or as a trailing `25 x 25 mm` companion sticker.

### 1.3 Empirical Grounding from HoldUp's Nordic Pharmacy Sticker Benchmark

HoldUp's automated evaluation suite (`eval/nordic_stickers_results.json`, run on `gemini-3.8-flash` at `thinking_level: "LOW"` across `n_items = 10` Nordic prescription and grocery test cases with median latency `3660.5 ms` and p95 `5638.1 ms`) directly shaped two physical counter rules in this specification:

- **Nordic Comma-Decimal Strength Parity (`10/10` verdict accuracy, `comma_decimal_matched = true`):** Case `ns_03` (`BISOPROLOL ORION 2,5 mg` printed comma-decimal box checked against a `2.5 mg` profile) matched cleanly at `0.98` strength confidence with `0` confident-wrong doses (`confident_wrong_dose_count = 0`). Both `web/src/pairing/pharmacyQr.ts` and `server/src/safety.ts` normalize comma-decimals (`2,5 mg` -> `2.5 mg`) deterministically.
- **Thermal Sticker Occlusion & Fade Protection (`100%` `occluded_abstention_rate = 1.0`):**
  - In `ns_08`, a white Finnish pharmacy *annostusohjetarra* affixed directly over the printed strength digits caused HoldUp to abstain safely (`strength.value = null`, `Verdict.level = "unsure"`).
  - In `ns_09`, a faded low-contrast direct-thermal sticker where printed strength became illegible also abstained safely (`strength.confidence = 0.1`, `Verdict.level = "unsure"`).
  - **Resulting Counter Rule:** Dispensing staff never place either the *annostusohjetarra* or the `25 x 25 mm` `holdup://rx` QR sticker over the carton's printed strength, expiry date, EAN-13 barcode, or mandatory **Braille embossing** (EU Directive 2001/83/EC Art. 56a / Fimea labeling regulation). Furthermore, because `holdup://rx` stores the carton's factory-printed EAN-13 GTIN in phone `localStorage`, offline barcode verification (`web/src/camera/barcode.ts`) remains `100%` functional even if a thermal paper sticker scuffs or fades months later.

---

## 2. `holdup://rx` `v1` Wire Schema, Byte Budget & Zero-Server Privacy Contract

The pharmacy counter QR payload matches `web/src/pairing/pharmacyQr.ts` (`encodePharmacyQrUri`, `parsePharmacyQrUri`, `mergePharmacyPayload`), `web/src/pairing/qrScanner.ts` (`classifyScannedCode` -> `kind: "pharmacy_rx"`), and `web/src/components/PharmacyImportModal.tsx` without a single custom server endpoint.

### 2.1 Accepted URI Envelopes (`parsePharmacyQrUri`)

`parsePharmacyQrUri(raw: string)` (`web/src/pairing/pharmacyQr.ts`) accepts three deterministic UTF-8 input forms up to `MAX_RAW_URI_LENGTH = 16384` characters and rejects any unknown version (`v !== 1`), duplicate `data` parameters, embedded URL credentials, or malformed Base64URL/UTF-8 sequences by returning `null`:

1. **Primary Custom Scheme (Default Counter Sticker):**
   ```text
   holdup://rx?v=1&data=<base64url-utf8-json>
   ```
2. **HTTPS Universal-Link Envelope (Optional PWA Deep-Link Fallback):**
   ```text
   https://<pwa-host>/rx?v=1&data=<base64url-utf8-json>
   ```
3. **Raw Compact JSON Object (Counter Clipboard / Automated Test Input):**
   ```json
   {"v":1,"pharmacy":"Yliopiston Apteekki Itäkeskus","meds":[{"id":"bis","name":"Bisoprolol Orion","ingredient":"bisoprolol","strength":"2.5 mg","schedule":["morning"],"barcode":"6432100024680","notes":"1 tabletti aamuisin"}],"avoid":["NSAIDs"]}
   ```

`encodeBase64UrlUtf8` serializes the sanitized `PharmacyRxPayload` JSON as UTF-8 bytes (preserving Finnish and Swedish characters `ä`, `ö`, `å` without double-escaping) and encodes them using RFC 4648 §5 URL-safe Base64 (`+` -> `-`, `/` -> `_`, trailing `=` stripped). `decodeBase64UrlUtf8` validates strict `TextDecoder("utf-8", { fatal: true })` decoding on the client.

### 2.2 Exact `v1` JSON Schema & Sanitization Bounds (`PharmacyRxPayload`)

Every field parsed by `validatePayloadObject` and `sanitizeRxMed` in `web/src/pairing/pharmacyQr.ts` enforces hard length caps, control-character stripping (`[\u0000-\u001F\u007F]+`), and structural invariants before reaching UI state:

| JSON Path | Type | Required | Bound in `pharmacyQr.ts` | Normalization & Dispensing Source (`MAXX` / `Salix`) |
|---|---|---|---|---|
| `v` | `1` | Yes | Exact literal `1` | Schema version lock; any other integer/string returns `null`. |
| `pharmacy` | `string` | No | `MAX_PHARMACY_LENGTH = 120` | Dispensing branch label (e.g., `"Yliopiston Apteekki Itäkeskus"`). Displayed in `PharmacyImportModal` preview banner. |
| `meds` | `Med[]` | Yes | `1 .. MAX_MEDS` (`50`) | Non-empty array of dispensed medications; if any element fails `sanitizeRxMed`, the entire payload is rejected (`null`). |
| `meds[].id` | `string` | No | `MAX_ID_LENGTH = 64` | Short slug (e.g., `"bis"`). If omitted, `deriveMedId()` generates `<ingredient\|name>-<strength>` normalized to ASCII `[a-z0-9-]` (`<= 48` chars). |
| `meds[].name` | `string` | Cond. | `MAX_NAME_LENGTH = 120` | Dispensed commercial package name on the carton (e.g., `"Bisoprolol Orion"`). At least one of `name` or `ingredient` must be non-empty. |
| `meds[].ingredient` | `string` | Cond. | `MAX_INGREDIENT_LENGTH = 120` | Active substance INN (e.g., `"bisoprolol"` or Finnish `"bisoprololi"`). Canonicalized during merge via `INN_ALIASES`. |
| `meds[].strength` | `string` | Yes | `MAX_STRENGTH_LENGTH = 64` | Must contain at least one digit (`/\d/`). `normalizeStrength()` converts comma decimals (`2,5 mg` -> `2.5 mg`) and inserts canonical unit spacing (`500mg` -> `500 mg`). |
| `meds[].schedule` | `string[]` | No | `<= MAX_SCHEDULE_ITEMS` (`12`), each `<= 48` chars | Daily intake slots (`"morning"`, `"noon"`, `"evening"`, `"night"`, or `"08:00"`). Defaults to `[]` if omitted. |
| `meds[].barcode` | `string` | No | `MAX_BARCODE_LENGTH = 32` | `sanitizeBarcode()` strips all non-digits (`\D+`). Stores the commercial 13-digit EAN-13 GTIN (or 6-digit Nordic VNR when no GTIN exists); `canonicalBarcode()` zero-pads 12-digit UPCs to 13 digits. |
| `meds[].notes` | `string` | No | `MAX_NOTES_LENGTH = 240` | Short patient-facing dosing text from *annostusohje* (e.g., `"1 tabletti aamuisin"`), never containing patient name or HETU. |
| `allergies` | `string[]` | No | `<= MAX_LIST_ITEMS` (`50`), each `<= 80` chars | Optional patient-confirmed allergen tags merged case-insensitively into `Profile.allergies`. |
| `avoid` | `string[]` | No | `<= MAX_LIST_ITEMS` (`50`), each `<= 80` chars | Optional pharmacist-flagged drug-class avoid tags (e.g., `["NSAIDs"]`, `["penicillins"]`, `["statins"]`) merged into `Profile.avoid`. |

### 2.3 Finnish INN Alias & Unit-Scale Canonicalization (`mergePharmacyPayload`)

Refill pickups in Finland frequently involve **generic substitution (*lääkevaihto*)**: a patient whose profile stores `"Bisoprolol Actavis"` (`2.5 mg`) may receive `"Bisoprolol Orion"` (`2,5 mg`, new EAN-13 barcode) three months later. If each refill created a duplicate entry, daily dose tracking (`doseLog`) and schedule checks would fragment.

`mergePharmacyPayload(profile, payload)` prevents duplicate entries through deterministic two-tier matching (`isSameMedication`):

1. **Exact Barcode Match (`canonicalBarcode`):** Matches immediately when both existing and incoming records share the same normalized EAN-13 / VNR digit string.
2. **Canonical INN + Scaled Strength Match (`canonicalIngredientKey` + `canonicalStrengthKey`):**
   - Maps Finnish pharmaceutical substance names to international INNs via `INN_ALIASES` (`amlodipin` / `amlodipiini` -> `amlodipine`, `atorvastatiini` -> `atorvastatin`, `bisoprololi` -> `bisoprolol`, `ibuprofeeni` -> `ibuprofen`, `levotyroksiini` -> `levothyroxine`, `metformiini` -> `metformin`, `naprokseeni` -> `naproxen`, `parasetamoli` / `acetaminophen` -> `paracetamol`, `ramipriili` -> `ramipril`, `simvastatiini` -> `simvastatin`, `varfariini` -> `warfarin`).
   - Scales metric and Nordic units via `UNIT_SCALE` (`g` -> `1000 mg`, `mcg` / `ug` / `µg` / `mikrog` / `microgram` -> `0.001 mg`, Finnish `ky` *kansainvälinen yksikkö* -> `iu`, `ml` -> `ml`, `%` -> `%`) after normalizing comma decimals (`2,5` -> `2.5`).
   - When a refill matches an existing medication (`updated += 1`), `mergePharmacyPayload` **preserves the existing `Med.id`** so all historical `profile.doseLog` timestamps remain linked, updates `name` and `barcode` to the newly dispensed generic carton, and performs a case-insensitive set union (`unionCaseInsensitive`) on `allergies` and `avoid`.

### 2.4 Byte-Size Budget (`<= 450` Bytes) & Optical Geometry on `25 x 25 mm` Thermal Labels

To ensure reliable, single-glance recognition at a natural **25 cm** chest-to-hand holding distance on both smartphone cameras and Ray-Ban Meta's `720 x 1280` first-person camera (`web/src/pairing/qrScanner.ts`), counter stickers enforce a **`<= 450` ASCII-byte URI budget** per `25 x 25 mm` label:

| Counter Sticker Profile | UTF-8 JSON Bytes | Base64URL Bytes | Full `holdup://rx` URI Bytes | ISO/IEC 18004 QR Version & ECC | Grid (+`4`-mod Quiet Zone) | Module Pitch on `25 x 25 mm` | Printer Dots (`203` / `300 dpi`) |
|---|---|---|---|---|---|---|---|
| **Minimal 1-Med Carton Sticker** (`Bisoprolol 2.5 mg`, `morning`, EAN-13) | `144 B` | `192 B` | **`213 B`** | **Version 10-M** (`213 B` cap) or **10-L** (`271 B` cap) | `57 x 57` (`65 x 65`) | **`0.385 mm`** | `3.07` / `4.54` dots |
| **Full 1-Med Counseling Sticker** (`Yliopiston Apteekki Itäkeskus`, `Bisoprolol Orion 2.5 mg`, Finnish note, `avoid: ["NSAIDs"]`) | `243 B` | `324 B` | **`345 B`** | **Version 12-L** (`367 B` cap) or **14-M** (`362 B` cap) | `65 x 65` (`73 x 73`) to `73 x 73` (`81 x 81`) | **`0.342 - 0.309 mm`** | `2.74 - 2.47` / `4.04 - 3.65` dots |
| **Compact 2-Med Pickup Sticker** (`YA Helsinki`, `Bisoprolol 2.5 mg` + `Atorvastatin 20 mg`, both EAN-13s) | `300 B` | `400 B` | **`421 B`** | **Version 13-L** (`425 B` cap) or **14-L** (`458 B` cap) | `69 x 69` (`77 x 77`) to `73 x 73` (`81 x 81`) | **`0.325 - 0.309 mm`** | `2.59 - 2.47` / `3.83 - 3.65` dots |
| **Multi-Med Paper Summary QR** (e.g., `SAMPLE_FINNISH_PHARMACY_QR` = `2` verbose meds or `3+` polypharmacy meds) | `385 - 449 B` | `514 - 599 B` | **`535 - 620 B`** | Printed on **`45 x 45 mm`** paper *yhteenveto* sheet (or `1` `25 x 25 mm` sticker per box) | `>= 77 x 77` | `>= 0.45 mm` on `45 mm` sheet | `>= 3.6` / `>= 5.3` dots |

**Why `<= 450` bytes on `25 x 25 mm` works on every Finnish pharmacy printer:**
- Standard `203 dpi` (`8 dots/mm`) Zebra GK420d / ZD421 and Citizen CL-S521 thermal heads print cleanly without thermal dot-bloom when each QR module spans **`>= 2` integer printer dots (`>= 0.250 mm`)**, while `300 dpi` (`11.8 dots/mm`) heads render **`3 - 4` integer dots per module**. Across **QR Versions 10 to 14** (`57 x 57` to `73 x 73` modules plus a mandatory `4`-module white quiet zone on all four sides), module pitch stays between **`0.309 mm` and `0.385 mm`**, comfortably above the `0.250 mm` thermal bloom floor and resolving `>= 3` camera pixels per module at a **25 cm** working distance.
- For polypharmacy pickups of `3` or more cartons, printing **one `25 x 25 mm` `holdup://rx` sticker per carton** (`213 - 345` bytes each, QR Version 10-12) keeps every carton individually scannable while `mergePharmacyPayload()` accumulates the complete regimen locally.
- Note on client-side SVG preview vs. counter ZPL printing: HoldUp's in-browser QR renderer (`web/src/pairing/qrSvg.ts`) intentionally targets short pairing links up to `Version 10-L` (`271` bytes), whereas Zebra ZPL II (`^BQN,2,3`) and Citizen Windows/CUPS counter drivers natively rasterize ISO/IEC 18004 Versions `1` through `40` directly in printer firmware:

```zpl
^XA
^CI28
^PW200
^LL200
^FO16,16^BQN,2,3^FDLA,holdup://rx?v=1&data=eyJ2IjoxLCJwaGFybWFjeSI6IllsaW9waXN0b24gQXB0ZWVra2kgSXTDpGtlc2t1cyIsIm1lZHMiOlt7ImlkIjoiYmlzIiwibmFtZSI6IkJpc29wcm9sb2wgT3Jpb24iLCJpbmdyZWRpZW50IjoiYmlzb3Byb2xvbCIsInN0cmVuZ3RoIjoiMi41IG1nIiwic2NoZWR1bGUiOlsibW9ybmluZyJdLCJiYXJjb2RlIjoiNjQzMjEwMDAyNDY4MCIsIm5vdGVzIjoiMSB0YWJsZXR0aSBhYW11aXNpbiJ9XSwiYXZvaWQiOlsiTlNBSURzIl19^FS
^XZ
```

### 2.5 End-to-End Zero-Server Privacy Guarantee

1. **Zero Cloud Generation at the Counter:** The `holdup://rx` URI is assembled in RAM on the pharmacy counter workstation (via local print template or offline static HTML utility) and sent straight over USB/Ethernet to the counter's thermal label printer. No HoldUp server is contacted by the pharmacy.
2. **Zero PII on Physical Packaging:** Because `PharmacyRxPayload` omits patient name, *henkilötunnus* (HETU), home address, prescribing physician, diagnosis code (ICD-10), and Kanta OID, a discarded `holdup://rx` sticker discloses zero personal identity beyond the commercial medication carton it is attached to.
3. **100% Client-Side Decode, Trilingual Preview & LocalStorage Persistence:**
   - When `detectAndClassifyFromSource()` (`web/src/pairing/qrScanner.ts`) detects a `holdup://rx` QR code (or the user pastes/scans inside `PharmacyImportModal.tsx`), `parsePharmacyQrUri()` and `preparePharmacyImport()` execute purely inside browser JavaScript.
   - `PharmacyImportModal` (`web/src/components/PharmacyImportModal.tsx`) announces the preview in Finnish (`fi`), Swedish (`sv`), or English (`en`) via an `aria-live="polite"` status region, labeling each item as **`Uusi` / `Ny` / `New`** or **`Päivitys` / `Uppdatering` / `Refill update`** before any state changes.
   - Only after explicit user confirmation (`Lisää laitteeni lääkelistalle` / `Add to My On-Device Medications`) does `saveProfile()` write to phone `localStorage` (`holdup.profile` in `web/src/storage/profileStore.ts`). Zero HTTP requests or WebSocket frames are emitted during import, and 1-tap `wipeAllLocalData()` erases all local medications, allergies, and `doseLog` entries instantaneously.

---

## 3. Co-Design Rollout with Näkövammaisten liitto (Iiris Center) & Loaner Kits

Technical elegance at the printer is useless if a blind or 78-year-old low-vision customer cannot locate the QR sticker by touch, hear confirmation in their native language, or trial smart glasses before public reimbursement approval. HoldUp's rollout is co-designed around **Näkövammaisten liitto ry** (Finnish Federation of the Visually Impaired) at **Iiris Center** (Marjaniementie 74, Marjaniemi / Itäkeskus, 00930 Helsinki), located within step-free metro/tram/tactile-paving distance of **Yliopiston Apteekki Itäkeskus**.

### 3.1 Physical Tactile & Braille-Safe Counter SOP (Co-Designed with Iiris Specialists)

Working with Näkövammaisten liitto's ICT and assistive-technology specialists (*digi- ja apuvälineneuvonta*) and rehabilitation counselors (*kuntoutusohjaajat*), dispensing pharmacists follow a 4-step **under-45-second** physical placement protocol:

1. **Strict Pharmaceutical Braille & Strength Non-Occlusion Check:** Under EU Directive 2001/83/EC Art. 56a and Fimea package-labeling rules, outer prescription cartons carry embossed **Marburg Medium Braille** for product name and strength. Before placing any sticker, the pharmacist locates the embossed Braille dots by sight/touch and selects an unembossed end-flap or back panel that leaves **all Braille dots, printed strength numerals, expiry date (`EXP`), and factory EAN-13 barcode `100%` uncovered**.
2. **Tactile Locator Cue for Blind Orientation:** The `25 x 25 mm` `holdup://rx` sticker is applied flush with the **bottom-right corner of the non-Braille back panel** (or mounted on a stiff `55 x 85 mm` companion card with a standardized **top-right semi-circular tactile notch** and single raised silicone locator bumpon adjacent to the QR). A blind user (`Cohort A`) simply faces the notched/bumpon side toward their chest at `~25 cm` so the Ray-Ban Meta temple camera captures the QR squarely on the first frame.
3. **In-Counter Live Verification Scan (`< 15 s`):** During *lääkeneuvonta*, the customer (or assisting rehabilitation specialist) scans the newly affixed sticker once before leaving the counter, hears the spoken Finnish/Swedish read-back over the glasses' private Bluetooth HFP open-ear speaker, and confirms on-device storage.
4. **Pharmacist Counseling Hotline Escalation:** Every pilot profile pre-populates the partner pharmacy's licensed *lääkeneuvonta* telephone desk as a 1-tap `tel:` voice fallback whenever HoldUp returns `Verdict.level === "unsure"` (such as an occluded or scuffed box) or `Verdict.level === "warning"` (strength mismatch, expired pack, or NSAID avoid-class conflict).

### 3.2 Iiris Center Assistive-Technology Loaner Kits (*Kokeilupaketit*)

Before a resident applies for permanent public assistive-device funding, Finnish vision rehabilitation practice relies on structured home-trial loaners. HoldUp packages **reusable Assistive-Technology Loaner Kits** managed at Iiris Center's *apuvälineneuvonta* desk:

| Loaner Kit Component | Specification | Rehabilitation Purpose |
|---|---|---|
| **Wearable Hardware** | `1x` Ray-Ban Meta Gen 2 (Cohort A audio-first) or `1x` Ray-Ban Display + Neural Band (Cohort B low-vision HUD), updated to firmware `V128+` | Zero-stigma hands-free camera + open-ear HFP audio + optional `600 x 600` high-contrast waveguide card (`/hud`). |
| **Pre-Configured Bridge Handset (Optional)** | Android 12+ loaner phone with `HoldUp Bridge` (`android-dat`, DAT SDK `1.0.1`) + Chrome PWA pinned, or participant's own iOS/Android phone with TalkBack / VoiceOver verified | Eliminates Developer Mode setup friction during 2-to-4-week home trials; supports immediate phone-camera fallback if glasses battery drops `< 15%`. |
| **Tactile Practice Pack** | `4` empty training cartons (`Amlodipin 5 mg`, `Amlodipin 10 mg`, `Bisoprolol 2,5 mg`, `Burana 400 mg`) fitted with Braille-safe `holdup://rx` `25 x 25 mm` stickers + tactile notched card | Allows safe, zero-clinical-risk rehearsal of aiming cues (`rotate_left`, `closer`, `other_side`), duplicate-dose warnings, and offline airplane-mode EAN-13 scans with a *kuntoutusohjaaja* before home use. |
| **Accessible Quick-Start Guide** | Trilingual (`fi` / `sv` / `en`) 18pt high-contrast matte print booklet, Grade-1 Finnish Braille summary sheet, and audio QR link | Covers explicit check start/stop, `CAMERA ON` hardware capture LED bystander etiquette, 45-second auto-stop, and 1-tap `wipeAllLocalData()` reset on kit return. |
| **Return & Sanitization Checklist** | Ultrasonic frame wipe, firmware/battery check, and verified `wipeAllLocalData()` + `android-dat` session reset | Guarantees zero residual medication or `doseLog` state between consecutive loaner borrowers at Iiris Center. |

### 3.3 Public Adoption & Reimbursement Bridge (*Apuvälinepalvelut* & Kela)

Integrating the Iiris Center loaner workflow with **Yliopiston Apteekki** / **Suomen Apteekkariliitto** counter stickers creates a closed-loop evidence trail for Finland's two statutory assistive-technology funding channels (`docs/PILOT_PLAN.md` §6):

1. **Wellbeing Services Counties & HUS *Apuvälinekeskus* (*Terveydenhuoltolaki* `1326/2010` §29):** Documented home-trial functional gains from an Iiris Center loaner kit support municipal / regional medical-rehabilitation electronic reading-aid handovers (*lääkinnällisen kuntoutuksen apuvälineet*) at **60-75% lower per-user hardware cost** than legacy EUR `2,500 - 4,500` proprietary OCR devices.
2. **Kela Work & Study Assistive Devices (*Laki Kansaneläkelaitoksen kuntoutusetuuksista* `566/2005`):** Working-age blind and low-vision adults trial the kit with an Iiris rehabilitation counselor to substantiate individual Kela assistive-technology applications, while pharmacies nationwide can enable `holdup://rx` thermal sticker printing on existing **MAXX** and **Salix** counters with zero Kanta regulatory delay.
