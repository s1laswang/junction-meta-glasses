Transdermal Patch Release-Rate Safety Suite (`transdermal_patch_rates`)
=======================================================================

Evaluates HoldUp end-to-end across 12 transdermal patch and medicated plaster safety scenarios for blind and low-vision patients using real `gemini-3.8-flash` (`shared/verify_prompt.md` + `shared/label_schema.json`) piped through deterministic `server/src/safety.ts` (`eval/safety_bridge.mts`). Covers `mg/24 h`, `mcg/24 h`, `mikrog/24 h`, `mcg/h`, `mg/h`, and total-patch-content `mg` cartons, glare/sticker release-rate abstentions, topical NSAID and opioid avoid-list traps, expired patch boxes, `doseLog` double-application prevention, bilingual FI/SV cartons, and unreadable foil-pouch backs. Synthetic PIL JPEGs render only inside `TemporaryDirectory(dir=temp_root())` (`/dev/shm` by default); zero image files or encoded image payloads are committed.

Reproduce
---------

Live evaluation (requires `GEMINI_API_KEY`, capped at `<= 3` concurrent workers):

```bash
TMPDIR=/dev/shm PATH="/home/silas/tools/node/bin:$PATH" /tmp/fleet-silas/canary-venv/bin/python eval/suites/transdermal_patch_rates/run.py --workers 3
```

Offline verification of cached `results.json` + PIL rendering + `server/src/safety.ts` parity (plain `python3`, no `google-genai` needed):

```bash
TMPDIR=/dev/shm PATH="/home/silas/tools/node/bin:$PATH" python3 eval/suites/transdermal_patch_rates/run.py --check
TMPDIR=/dev/shm PATH="/home/silas/tools/node/bin:$PATH" python3 eval/suites/transdermal_patch_rates/run.py --verify-cached
```

Results Summary (`gemini-3.8-flash`)
------------------------------------

| Metric | Value | 95% Interval / Bound |
|---|---|---|
| Cases (`n`) | `12` (`0` errors, `0` timeouts) | - |
| Evaluation clock (`eval_now_iso`) | `2026-11-14T19:30:00+02:00` (morning patch logged at `08:15+02:00`) | - |
| Verdict pass rate | `12/12` (`1.0`) | Wilson 95% CI `[0.7575, 1.0]` |
| Confident-wrong dose (`conf >= 0.8`) | `0/12` (`0.0`) | Wilson 95% CI `[0.0, 0.2425]`, rule-of-three upper `0.25` |
| False match count | `0/12` (`0.0`) | Wilson 95% CI `[0.0, 0.2425]`, rule-of-three upper `0.25` |
| Latency (`latency_s`) | `p50 = 3.266 s`, `p95 = 4.733 s`, `mean = 3.601 s` | - |
| Cached artifact size | `10,052` bytes (`< 15 KB`) | - |

Scenarios Covered (12 Cases)
----------------------------

- **Matching vs wrong release-rate and total-content patches (4):**
  - `tp_01` (`match`): Daily `EXELON 4.6 mg/24 h` (`rivastigmine`, `EXP 2027-11`) matching `4.6 mg/24 h` prescription (`matches riv`, `taken today: 0/1`).
  - `tp_02` (`warning`): Step-up `EXELON 9.5 mg/24 h` carton against `4.6 mg/24 h` prescription (`strength 9.5 mg/24 h differs from your 4.6 mg/24 h`).
  - `tp_03` (`match`): Weekly `NORSPAN 5 mcg/h` (`buprenorphine`, `EXP 2027-10`) matching `5 mcg/h` prescription (`matches bup`, `taken today: 0/1`).
  - `tp_04` (`warning`): Total-matrix-content `BUPRENORPHINE 10 mg` carton against `5 mcg/h` hourly-rate prescription (`strength 10 mg differs from your 5 mcg/h`).
- **Glare-washed and sticker-obscured release-rate abstentions (2):**
  - `tp_05` (`unsure`): Overhead specular bathroom glare washing out the `mg/24 h` release-rate panel on `EXELON` (`strength_read = null`, `strength_conf = 0.0`, `strength not readable`).
  - `tp_06` (`unsure`): Pharmacy skin-rotation sticker (`ROTATE SKIN SITE`) covering the `mcg/h` release-rate box on `NORSPAN` (`strength_read = null`, `strength_conf = 0.0`, `strength not readable`).
- **Topical NSAID and opioid avoid-list patch traps (2):**
  - `tp_07` (`warning`): Topical NSAID `KETOPROFEN 20 mg` medicated plaster against `avoid: ["NSAIDs"]` (`ketoprofen is an NSAID, on your avoid list`, `not on your medication list`).
  - `tp_08` (`warning`): High-potency opioid `DUROGESIC 25 mcg/h` (`fentanyl`) transdermal patch against `avoid: ["NSAIDs", "opioids"]` (`fentanyl is an opioid, on your avoid list`, `not on your medication list`).
- **Expired carton and same-day double-application traps (2):**
  - `tp_09` (`warning`): Spare `ESTRADOT 50 mcg/24 h` (`estradiol`) carton with past expiry `EXP 04/2025` (`expired 2025-04`).
  - `tp_10` (`warning`): Daily `MINITRAN 0.2 mg/h` (`glyceryl trinitrate`) transdermal patch already applied and logged in `doseLog` at `08:15` today (`matches nit`, `taken today: 1/1`).
- **Nordic FI/SV bilingual carton and foil-pouch back abstention (2):**
  - `tp_11` (`match`): Bilingual Finnish/Swedish `ESTRADOT 50 mikrog/24 h` (`Vaikuttava aine: estradioli / Aktiv substans: estradiol`, `depotlaastari / depotplåster`, `Käyt. viim. / Utg.dat. 09.2027`) matching `50 mcg/24 h` (`matches est`, `taken today: 0/1`).
  - `tp_12` (`unsure`): Sealed foil transdermal pouch viewed from the back showing only heat/disposal warnings and `Lot K9142` (`product = null`, `ingredient = null`, `strength = null`, `label not readable`).
