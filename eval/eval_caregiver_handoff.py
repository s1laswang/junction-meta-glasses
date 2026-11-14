import argparse
import datetime
import json
import math
import os
import pathlib
import re
import shutil
import statistics
import subprocess
import sys
import time
import urllib.parse
from typing import Any

import requests

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
DEFAULT_OUT_JSON = REPO_ROOT / "eval" / "caregiver_handoff_results.json"

MODEL_NAME = "gemini-3.8-flash"
THINKING_LEVEL = "LOW"
LANGUAGES_TESTED = ["en", "fi", "sv"]

EM_DASH = chr(8212)
EN_DASH = chr(8211)
HASH_CHAR = chr(35)
API_KEY_RE = re.compile("AI" + "za" + r"[0-9A-Za-z_-]{10,}")
RAW_JSON_LEAK_RE = re.compile(
    r"(\{[^{}]*:[^{}]*\}|\[object Object\]|\"confidence\"\s*:|\"medId\"\s*:|\"doseLog\"\s*:|\bundefined\b|\bNaN\b)"
)

PROFILE_EN_STANDARD: dict[str, Any] = {
    "meds": [
        {
            "id": "aml",
            "name": "Amlodipin",
            "ingredient": "amlodipine",
            "strength": "5 mg",
            "schedule": ["evening"],
            "barcode": "6432100012345",
        },
        {
            "id": "met",
            "name": "Metformin",
            "ingredient": "metformin",
            "strength": "500 mg",
            "schedule": ["morning", "evening"],
            "barcode": "6432100054321",
        },
        {
            "id": "par",
            "name": "Panadol",
            "ingredient": "paracetamol",
            "strength": "500 mg",
            "schedule": ["as needed"],
            "barcode": "6432100098765",
        },
    ],
    "allergies": ["peanut", "tree nuts"],
    "avoid": ["NSAIDs"],
    "doseLog": [],
    "lang": "en",
}

PROFILE_FI_STANDARD: dict[str, Any] = {
    "meds": [
        {
            "id": "aml",
            "name": "Amlodipin Orion",
            "ingredient": "amlodipiini",
            "strength": "5 mg",
            "schedule": ["ilta"],
        },
        {
            "id": "met",
            "name": "Metforem",
            "ingredient": "metformiini",
            "strength": "500 mg",
            "schedule": ["aamu", "ilta"],
        },
        {
            "id": "par",
            "name": "Panadol",
            "ingredient": "parasetamoli",
            "strength": "500 mg",
            "schedule": ["tarvittaessa"],
        },
    ],
    "allergies": ["maapähkinä", "penisilliini"],
    "avoid": ["tulehduskipulääkkeet (NSAID)"],
    "doseLog": [],
    "lang": "fi",
}

PROFILE_SV_STANDARD: dict[str, Any] = {
    "meds": [
        {
            "id": "aml",
            "name": "Amlodipin",
            "ingredient": "amlodipin",
            "strength": "5 mg",
            "schedule": ["kväll"],
        },
        {
            "id": "met",
            "name": "Metformin",
            "ingredient": "metformin",
            "strength": "500 mg",
            "schedule": ["morgon", "kväll"],
        },
        {
            "id": "par",
            "name": "Alvedon",
            "ingredient": "paracetamol",
            "strength": "500 mg",
            "schedule": ["vid behov"],
        },
    ],
    "allergies": ["jordnötter", "trädnötter"],
    "avoid": ["inflammationshämmande värkmediciner (NSAID)"],
    "doseLog": [],
    "lang": "sv",
}

PROFILE_POLYPHARMACY: dict[str, Any] = {
    "meds": [
        {
            "id": "api",
            "name": "Eliquis",
            "ingredient": "apixaban",
            "strength": "5 mg",
            "schedule": ["morning", "evening"],
        },
        {
            "id": "bis",
            "name": "Emconcor",
            "ingredient": "bisoprolol",
            "strength": "2.5 mg",
            "schedule": ["morning"],
        },
        {
            "id": "ram",
            "name": "Cardace",
            "ingredient": "ramipril",
            "strength": "5 mg",
            "schedule": ["morning"],
        },
        {
            "id": "vitd",
            "name": "Devisol",
            "ingredient": "colecalciferol",
            "strength": "20 mcg",
            "schedule": ["noon"],
        },
        {
            "id": "ato",
            "name": "Lipitor",
            "ingredient": "atorvastatin",
            "strength": "20 mg",
            "schedule": ["bedtime"],
        },
        {
            "id": "par",
            "name": "Panadol",
            "ingredient": "paracetamol",
            "strength": "500 mg",
            "schedule": ["as needed"],
        },
    ],
    "allergies": ["penicillin", "peanut", "shellfish"],
    "avoid": ["NSAIDs", "opioids"],
    "doseLog": [],
    "lang": "en",
}


def _f(val: Any, conf: float) -> dict[str, Any]:
    return {"value": val, "confidence": conf}


CASES: list[dict[str, Any]] = [
    {
        "id": "ch_01",
        "category": "safety_catch_nsaid_burana",
        "handoff_kind": "safety_catch_alert",
        "ts_function": "buildFamilyAlertLinks",
        "language": "en",
        "description": "NSAID Burana 400 mg avoid-class safety-catch alert shared via SMS and email",
        "caregiver_context": (
            "Older low-vision adult whose profile avoids NSAIDs holds up a Finnish OTC Burana 400 mg "
            "(ibuprofen) painkiller carton at 20:00 after taking morning Metformin and evening Amlodipin, "
            "then triggers 1-tap Family Share."
        ),
        "eval_now": [2026, 11, 14, 20, 0],
        "contact_phone": "+358 40 000 0101",
        "contact_email": "caregiver@example.com",
        "profile": PROFILE_EN_STANDARD,
        "dose_entries": [
            {"medId": "met", "ymdhm": [2026, 11, 14, 8, 15]},
            {"medId": "aml", "ymdhm": [2026, 11, 14, 19, 45]},
        ],
        "has_allergen_hazard": False,
        "expected_substrings": ["HoldUp Safety Catch: Burana 400 mg flagged (avoid NSAIDs)"],
        "raw_read": {
            "kind": "medication",
            "product": _f("Burana", 0.99),
            "ingredient": _f("ibuprofen", 0.97),
            "strength": _f("400 mg", 0.98),
            "dosing": _f("1 tablet up to 3 times daily", 0.89),
            "expiry": _f("2027-11", 0.95),
            "allergens": _f(["lactose"], 0.88),
            "barcode": _f("6432100040020", 0.96),
            "readability": 0.97,
        },
        "verdict_reasons": ["ibuprofen is an NSAID, on your avoid list", "not on your medication list"],
    },
    {
        "id": "ch_02",
        "category": "safety_catch_expired_metformin",
        "handoff_kind": "safety_catch_alert",
        "ts_function": "buildFamilyAlertLinks",
        "language": "en",
        "description": "Expired Metformin 500 mg (EXP 2024-11) safety-catch alert for pharmacy replacement",
        "caregiver_context": (
            "Blind adult checks a backup Metformin 500 mg pack whose printed expiry is 2024-11 at 08:30 "
            "before breakfast and shares the safety catch so family can help pick up a fresh pack at the pharmacy."
        ),
        "eval_now": [2026, 11, 14, 8, 30],
        "contact_phone": "+358 40 000 0102",
        "contact_email": "family@example.com",
        "profile": PROFILE_EN_STANDARD,
        "dose_entries": [],
        "has_allergen_hazard": False,
        "expected_substrings": ["HoldUp Safety Catch: Metformin 500 mg flagged (expired 2024-11)"],
        "raw_read": {
            "kind": "medication",
            "product": _f("Metformin", 0.98),
            "ingredient": _f("metformin", 0.97),
            "strength": _f("500 mg", 0.97),
            "dosing": _f("1 tablet twice daily", 0.89),
            "expiry": _f("2024-11", 0.96),
            "allergens": _f([], 0.84),
            "barcode": _f("6432100054321", 0.95),
            "readability": 0.96,
        },
        "verdict_reasons": ["expired 2024-11"],
    },
    {
        "id": "ch_03",
        "category": "safety_catch_same_day_double_dose",
        "handoff_kind": "safety_catch_alert",
        "ts_function": "buildFamilyAlertLinks",
        "language": "en",
        "description": "Same-day double-dose safety-catch alert on once-daily Amlodipin 5 mg already logged",
        "caregiver_context": (
            "Older adult picks up once-daily Amlodipin 5 mg a second time at 20:15 (20 minutes after "
            "already logging the evening dose at 19:55) and shares the duplicate-dose warning with their caregiver."
        ),
        "eval_now": [2026, 11, 14, 20, 15],
        "contact_phone": "+358 40 000 0103",
        "contact_email": "caregiver@example.com",
        "profile": PROFILE_EN_STANDARD,
        "dose_entries": [
            {"medId": "met", "ymdhm": [2026, 11, 14, 8, 10]},
            {"medId": "met", "ymdhm": [2026, 11, 14, 19, 40]},
            {"medId": "aml", "ymdhm": [2026, 11, 14, 19, 55]},
        ],
        "has_allergen_hazard": False,
        "expected_substrings": [
            "HoldUp Safety Catch: Amlodipin 5 mg flagged (already taken today, 1 of 1 scheduled evening dose logged)",
            "3 of 3 scheduled doses taken",
        ],
        "raw_read": {
            "kind": "medication",
            "product": _f("Amlodipin", 0.98),
            "ingredient": _f("amlodipine", 0.97),
            "strength": _f("5 mg", 0.98),
            "dosing": _f("1 tablet once daily in the evening", 0.92),
            "expiry": _f("2027-10", 0.95),
            "allergens": _f([], 0.86),
            "barcode": _f("6432100012345", 0.96),
            "readability": 0.97,
        },
        "verdict_reasons": ["already taken today (1 of 1 scheduled evening dose logged)"],
    },
    {
        "id": "ch_04",
        "category": "safety_catch_peanut_allergen",
        "handoff_kind": "safety_catch_alert",
        "ts_function": "buildFamilyAlertLinks",
        "language": "en",
        "description": "Peanut allergen botanical synonym 'arachis oil' catch shared with household caregiver",
        "caregiver_context": (
            "Blind user with a documented peanut allergy checks a Satay Stir-Fry Sauce jar listing "
            "'arachis oil' at 17:30 before dinner and sends a family alert so the jar is set aside."
        ),
        "eval_now": [2026, 11, 14, 17, 30],
        "contact_phone": "+358 40 000 0104",
        "contact_email": "partner@example.com",
        "profile": PROFILE_EN_STANDARD,
        "dose_entries": [
            {"medId": "met", "ymdhm": [2026, 11, 14, 8, 20]},
        ],
        "has_allergen_hazard": True,
        "expected_substrings": [
            "HoldUp Safety Catch: Satay Stir-Fry Sauce flagged (contains arachis oil, allergy: peanut)"
        ],
        "raw_read": {
            "kind": "food",
            "product": _f("Satay Stir-Fry Sauce", 0.96),
            "ingredient": _f("stir-fry sauce", 0.90),
            "strength": _f(None, 0.0),
            "dosing": _f(None, 0.0),
            "expiry": _f("2027-09", 0.93),
            "allergens": _f(["arachis oil", "soy"], 0.94),
            "barcode": _f("6410405091123", 0.94),
            "readability": 0.95,
        },
        "verdict_reasons": ["contains arachis oil (allergy: peanut)"],
    },
    {
        "id": "ch_05",
        "category": "adherence_all_taken",
        "handoff_kind": "daily_adherence_summary",
        "ts_function": "exportCaregiverSummary",
        "language": "en",
        "description": "Daily caregiver adherence summary when all 3 of 3 scheduled doses are logged",
        "caregiver_context": (
            "Adult child receives their parent's user-triggered evening HoldUp Caregiver Summary at 21:00 "
            "confirming all 3 scheduled daily doses were logged with timestamps."
        ),
        "eval_now": [2026, 11, 14, 21, 0],
        "contact_phone": "+358 40 000 0105",
        "contact_email": "caregiver@example.com",
        "profile": PROFILE_EN_STANDARD,
        "dose_entries": [
            {"medId": "met", "ymdhm": [2026, 11, 14, 8, 10]},
            {"medId": "met", "ymdhm": [2026, 11, 14, 19, 45]},
            {"medId": "aml", "ymdhm": [2026, 11, 14, 20, 5]},
        ],
        "has_allergen_hazard": False,
        "expected_substrings": [
            "Scheduled doses: 3 of 3 taken, 0 remaining",
            "Pending scheduled doses: none",
        ],
    },
    {
        "id": "ch_06",
        "category": "adherence_morning_overdue",
        "handoff_kind": "daily_adherence_summary",
        "ts_function": "buildFamilyAlertLinks",
        "language": "en",
        "description": "Afternoon missed-dose alert when morning Metformin 500 mg is overdue at 14:00",
        "caregiver_context": (
            "Family caregiver receives a user-triggered 14:00 update showing morning Metformin 500 mg is "
            "overdue while evening doses are still upcoming later today."
        ),
        "eval_now": [2026, 11, 14, 14, 0],
        "contact_phone": "",
        "contact_email": "",
        "profile": PROFILE_EN_STANDARD,
        "dose_entries": [
            {"medId": "met", "ymdhm": [2026, 11, 13, 8, 30]},
        ],
        "has_allergen_hazard": False,
        "expected_substrings": [
            "0 of 3 scheduled doses taken",
            "Overdue: Metformin 500 mg (morning).",
        ],
    },
    {
        "id": "ch_07",
        "category": "adherence_partial_twice_daily",
        "handoff_kind": "daily_adherence_summary",
        "ts_function": "exportCaregiverSummary",
        "language": "en",
        "description": "Midday partial twice-daily adherence summary (1 of 2 Metformin 500 mg taken, evening pending)",
        "caregiver_context": (
            "Caregiver reviews a midday plain-text summary exported at 13:30 showing 1 of 2 twice-daily "
            "Metformin 500 mg doses taken at 08:15 and evening doses pending."
        ),
        "eval_now": [2026, 11, 14, 13, 30],
        "contact_phone": "+358 40 000 0107",
        "contact_email": "family@example.com",
        "profile": PROFILE_EN_STANDARD,
        "dose_entries": [
            {"medId": "met", "ymdhm": [2026, 11, 14, 8, 15]},
        ],
        "has_allergen_hazard": False,
        "expected_substrings": [
            "Scheduled doses: 1 of 3 taken, 2 remaining",
            "Metformin 500 mg: 1 of 2 taken (08:15)",
            "Metformin 500 mg: 1 remaining (evening)",
        ],
    },
    {
        "id": "ch_08",
        "category": "adherence_empty_log",
        "handoff_kind": "daily_adherence_summary",
        "ts_function": "exportCaregiverSummary",
        "language": "en",
        "description": "Start-of-day adherence summary with empty today log (0 of 3 scheduled doses taken)",
        "caregiver_context": (
            "Morning home-care check at 07:30 exports a clean start-of-day HoldUp Caregiver Summary with "
            "zero doses logged today and all 3 scheduled doses pending."
        ),
        "eval_now": [2026, 11, 14, 7, 30],
        "contact_phone": "",
        "contact_email": "",
        "profile": PROFILE_EN_STANDARD,
        "dose_entries": [
            {"medId": "aml", "ymdhm": [2026, 11, 13, 20, 0]},
        ],
        "has_allergen_hazard": False,
        "expected_substrings": [
            "Scheduled doses: 0 of 3 taken, 3 remaining",
            "Taken today: none",
        ],
    },
    {
        "id": "ch_09",
        "category": "emergency_wallet_en",
        "handoff_kind": "emergency_wallet_card",
        "ts_function": "formatEmergencyWalletText",
        "language": "en",
        "description": "English Emergency Medication & Allergy Wallet plain-text card for pharmacist/clinic handoff",
        "caregiver_context": (
            "English-speaking blind adult presents their local HoldUp Emergency Medication & Allergy Wallet "
            "summary at a pharmacy counter to cross-check active prescriptions, allergies, and NSAID avoid rules."
        ),
        "eval_now": [2026, 11, 14, 12, 0],
        "profile": PROFILE_EN_STANDARD,
        "dose_entries": [],
        "has_allergen_hazard": False,
        "expected_substrings": [
            "HoldUp Emergency Medication & Allergy Wallet Summary",
            "Drug & Food Allergies (2): peanut, tree nuts",
            "Avoid Drug Classes & Ingredients (1): NSAIDs",
            "Not a medical device.",
        ],
    },
    {
        "id": "ch_10",
        "category": "emergency_wallet_fi",
        "handoff_kind": "emergency_wallet_card",
        "ts_function": "formatEmergencyWalletText",
        "language": "fi",
        "description": "Finnish Emergency Medication & Allergy Wallet plain-text card (Hätä- ja apteekkilääkekortti)",
        "caregiver_context": (
            "Finnish-speaking older adult in Helsinki shares their local HoldUp Hätä- ja apteekkilääkekortti "
            "plain-text summary with a community pharmacist (apteekki)."
        ),
        "eval_now": [2026, 11, 14, 12, 0],
        "profile": PROFILE_FI_STANDARD,
        "dose_entries": [],
        "has_allergen_hazard": False,
        "expected_substrings": [
            "HoldUp Hätä- ja apteekkilääkekortti (lääkkeet ja allergiat)",
            "Lääke- ja ruoka-allergiat (2): maapähkinä, penisilliini",
            "Ei lääkinnällinen laite.",
        ],
    },
    {
        "id": "ch_11",
        "category": "emergency_wallet_sv",
        "handoff_kind": "emergency_wallet_card",
        "ts_function": "formatEmergencyWalletText",
        "language": "sv",
        "description": "Swedish Emergency Medication & Allergy Wallet plain-text card (Akut läkemedels- och allergikort)",
        "caregiver_context": (
            "Swedish-speaking older adult shares their on-device HoldUp Akut läkemedels- och allergikort "
            "plain-text summary with a Nordic clinic nurse or pharmacist."
        ),
        "eval_now": [2026, 11, 14, 12, 0],
        "profile": PROFILE_SV_STANDARD,
        "dose_entries": [],
        "has_allergen_hazard": False,
        "expected_substrings": [
            "HoldUp Akut läkemedels- och allergikort",
            "Läkemedels- och matallergier (2): jordnötter, trädnötter",
            "Inte en medicinteknisk produkt.",
        ],
    },
    {
        "id": "ch_12",
        "category": "emergency_wallet_polypharmacy",
        "handoff_kind": "emergency_wallet_card",
        "ts_function": "formatEmergencyWalletText",
        "language": "en",
        "description": "6-medication polypharmacy + anticoagulant + multi-allergy Emergency Wallet card",
        "caregiver_context": (
            "Older adult managing 6 cardiovascular, anticoagulant (Eliquis/apixaban 5 mg), metabolic, and PRN "
            "medications across morning, noon, evening, bedtime, and as-needed slots plus 3 allergies and 2 "
            "avoid classes hands off their Emergency Wallet summary at an urgent clinic visit."
        ),
        "eval_now": [2026, 11, 14, 12, 0],
        "profile": PROFILE_POLYPHARMACY,
        "dose_entries": [],
        "has_allergen_hazard": False,
        "expected_substrings": [
            "Drug & Food Allergies (3): penicillin, peanut, shellfish",
            "Avoid Drug Classes & Ingredients (2): NSAIDs, opioids",
            "Active Medications (6 total, 5 scheduled):",
            "1. Eliquis | Active ingredient: apixaban | Strength: 5 mg | Schedule: morning, evening",
        ],
    },
]

JUDGE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "clarity_1_to_5": {"type": "integer", "minimum": 1, "maximum": 5},
        "language_match": {"type": "boolean"},
        "actionable_for_caregiver": {"type": "boolean"},
        "preserves_non_medical_boundary": {"type": "boolean"},
        "privacy_minimal_no_extra_pii": {"type": "boolean"},
        "rationale": {"type": "string"},
    },
    "required": [
        "clarity_1_to_5",
        "language_match",
        "actionable_for_caregiver",
        "preserves_non_medical_boundary",
        "privacy_minimal_no_extra_pii",
        "rationale",
    ],
}

JUDGE_SYSTEM_PROMPT = (
    "You are an assistive-caregiver UX, health-privacy, and EU MDR Art. 2(1) regulatory safety evaluator "
    "scoring HoldUp, an on-device smart-glasses medication and allergen label assistant for blind, "
    "low-vision, and older adults.\n"
    "HoldUp has zero background cloud sync: users explicitly trigger plain-text SMS/email caregiver "
    "alerts, daily adherence summaries, or local Emergency Medication & Allergy Wallet exports.\n"
    "Evaluate each generated plain-text handoff artifact against five criteria:\n"
    "1. clarity_1_to_5 (integer 1 to 5): Plain-text scannability, structure, and immediate comprehension "
    "for a busy family caregiver or pharmacist. Award 5 when key facts (flagged safety catch and reason, "
    "taken vs overdue/pending scheduled doses with exact strengths, or structured allergy/avoid/medication "
    "lines) are front-loaded on clean plain-text lines with zero raw JSON, zero markup clutter, and zero "
    "ambiguity.\n"
    "2. language_match (boolean): True when the structural headings, section labels, schedule descriptions, "
    "and notices of the plain-text artifact are written in expected_language ('en' = English, 'fi' = Finnish, "
    "'sv' = Swedish), allowing printed medication brand names and INN active substance names as proper nouns.\n"
    "3. actionable_for_caregiver (boolean): True when the recipient (family caregiver or pharmacist) "
    "immediately knows what happened or what the wearer's saved schedule/allergy status is and can take a "
    "concrete safe follow-up step (check in on a flagged NSAID/expired/duplicate-dose/allergen catch, "
    "follow up on an overdue morning dose, verify daily completion, or cross-check active medications and "
    "allergies at a pharmacy counter).\n"
    "4. preserves_non_medical_boundary (boolean): True when the artifact stays strictly within the EU MDR "
    "Art. 2(1) non-medical assistive reader and user-maintained checklist/profile summary boundary: it "
    "reports factual label catches, user-logged timestamps, or user-owned profile entries (with explicit "
    "on-device/non-medical-device pharmacist confirmation notice on wallet cards) and never diagnoses "
    "diseases, prescribes treatments, or recommends changing prescribed doses.\n"
    "5. privacy_minimal_no_extra_pii (boolean): True when the plain-text payload contains only minimal "
    "task-necessary medication, strength, schedule, allergy, avoid-rule, and same-day adherence facts "
    "from the user's local profile, with zero extraneous personal identifiers (no patient full name, "
    "national ID, home address, phone/email inside message body, GPS coordinates, clinical notes, raw "
    "camera data, or cloud tracking URLs).\n"
    "Keep rationale concise (2 to 3 sentences) and do not use em dashes."
)


def load_env_files() -> None:
    home_env = pathlib.Path.home() / "momin" / ".env"
    repo_env = REPO_ROOT / ".env"
    if home_env.is_file():
        try:
            proc = subprocess.run(
                ["bash", "-c", 'set -a; . "$1"; env -0', "bash", str(home_env)],
                capture_output=True,
                check=True,
                timeout=5,
            )
            for chunk in proc.stdout.split(b"\x00"):
                if b"=" in chunk:
                    k_b, v_b = chunk.split(b"=", 1)
                    k_s = k_b.decode("utf-8", errors="ignore").strip()
                    v_s = v_b.decode("utf-8", errors="ignore")
                    if k_s and k_s not in os.environ:
                        os.environ[k_s] = v_s
        except (OSError, subprocess.SubprocessError):
            pass

    for env_path in (home_env, repo_env):
        if not env_path.is_file():
            continue
        for raw_line in env_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith(HASH_CHAR):
                continue
            if line.startswith("export "):
                line = line[7:].strip()
            if "=" not in line:
                continue
            key, val = line.split("=", 1)
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = val


def ensure_node_and_deps() -> str:
    nm = REPO_ROOT / "node_modules"
    shared_nm = pathlib.Path("/tmp/fleet-silas/meta-deps/node_modules")
    if not nm.exists() and shared_nm.is_dir():
        nm.symlink_to(shared_nm)

    extra_paths = [
        "/tmp/fleet-silas/node/bin",
        str(pathlib.Path.home() / ".local" / "bin"),
        os.environ.get("PATH", ""),
    ]
    merged_path = ":".join(p for p in extra_paths if p)
    os.environ["PATH"] = merged_path
    node_bin = shutil.which("node", path=merged_path)
    if not node_bin:
        raise RuntimeError("node executable not found on PATH")
    return node_bin


def sanitize_obj(obj: Any) -> Any:
    if isinstance(obj, str):
        cleaned = obj.replace(EM_DASH, " - ").replace(EN_DASH, "-")
        return API_KEY_RE.sub("[REDACTED]", cleaned)
    if isinstance(obj, list):
        return [sanitize_obj(x) for x in obj]
    if isinstance(obj, dict):
        return {sanitize_obj(str(k)): sanitize_obj(v) for k, v in obj.items()}
    return obj


def percentile(vals: list[float], q: float) -> float:
    if not vals:
        return 0.0
    xs = sorted(vals)
    if len(xs) == 1:
        return round(xs[0], 1)
    pos = (len(xs) - 1) * q
    lo = int(math.floor(pos))
    hi = int(math.ceil(pos))
    if lo == hi:
        return round(xs[lo], 1)
    frac = pos - lo
    return round(xs[lo] * (1.0 - frac) + xs[hi] * frac, 1)


def validate_sms_uri(sms_href: str, expected_phone: str, expected_body: str) -> bool:
    if not sms_href.startswith("sms:"):
        return False
    if any(ch in sms_href for ch in (" ", "\n", "\r", "\t")):
        return False
    rest = sms_href[4:]
    if "?body=" not in rest:
        return False
    phone_part, encoded_body = rest.split("?body=", 1)
    clean_expected_phone = re.sub(r"[^\d+]", "", expected_phone.strip())
    if phone_part != clean_expected_phone:
        return False
    if not re.fullmatch(r"\+?\d*", phone_part):
        return False
    decoded_body = urllib.parse.unquote(encoded_body)
    return decoded_body == expected_body


def validate_mailto_uri(
    mailto_href: str,
    expected_email: str,
    expected_subject: str,
    expected_body: str,
) -> bool:
    if not mailto_href.startswith("mailto:"):
        return False
    if any(ch in mailto_href for ch in (" ", "\n", "\r", "\t")):
        return False
    rest = mailto_href[7:]
    if "?" not in rest:
        return False
    email_part, query_part = rest.split("?", 1)
    clean_expected_email = re.sub(r"\s+", "", expected_email.strip())
    if email_part != clean_expected_email:
        return False
    if not query_part.startswith("subject=") or "&body=" not in query_part:
        return False
    subj_enc, body_enc = query_part[len("subject=") :].split("&body=", 1)
    return (
        urllib.parse.unquote(subj_enc) == expected_subject
        and urllib.parse.unquote(body_enc) == expected_body
    )


def run_ts_handoff_batch(node_bin: str, cases: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    ts_code = """
import fs from "node:fs";
import { toLabelRead, toProfile } from "./server/src/verify.ts";
import { checkLabel } from "./server/src/safety.ts";
import { buildFamilyAlertLinks } from "./web/src/storage/caregiverSchedule.ts";
import { exportCaregiverSummary } from "./web/src/storage/profileStore.ts";
import { formatEmergencyWalletText } from "./web/src/components/EmergencyMedCard.tsx";

const input = JSON.parse(fs.readFileSync(0, "utf8"));

function makeLocalDate(parts) {
  return new Date(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], 0, 0);
}

const out = input.cases.map((c) => {
  const evalNow = makeLocalDate(c.eval_now);
  const doseLog = (c.dose_entries ?? []).map((entry) => ({
    medId: entry.medId,
    ts: makeLocalDate(entry.ymdhm).getTime(),
  }));
  const profile = {
    ...c.profile,
    doseLog,
    lang: c.language,
  };

  let safetyVerdictLevel = null;
  let lastVerdict = null;
  if (c.raw_read) {
    const checked = checkLabel(toLabelRead(c.raw_read), toProfile(profile), evalNow);
    safetyVerdictLevel = checked.level;
    lastVerdict = {
      ...checked,
      reasons: Array.isArray(c.verdict_reasons) ? c.verdict_reasons : checked.reasons,
    };
  }

  const links = buildFamilyAlertLinks(profile, {
    contactPhone: c.contact_phone ?? "",
    contactEmail: c.contact_email ?? "",
    lastVerdict,
    now: evalNow,
  });

  if (c.ts_function === "buildFamilyAlertLinks") {
    const handoffText = c.handoff_kind === "daily_adherence_summary"
      ? `${links.headline}\\n${links.body}`
      : links.body;
    return {
      id: c.id,
      ts_function: c.ts_function,
      safety_verdict_level: safetyVerdictLevel,
      headline: links.headline,
      body: links.body,
      handoff_text: handoffText,
      sms_href: links.smsHref,
      mailto_href: links.mailtoHref,
    };
  }

  if (c.ts_function === "exportCaregiverSummary") {
    const summaryText = exportCaregiverSummary(profile, evalNow);
    return {
      id: c.id,
      ts_function: c.ts_function,
      safety_verdict_level: null,
      headline: links.headline,
      body: links.body,
      handoff_text: summaryText,
      sms_href: links.smsHref,
      mailto_href: links.mailtoHref,
    };
  }

  if (c.ts_function === "formatEmergencyWalletText") {
    const walletText = formatEmergencyWalletText(profile, c.language);
    return {
      id: c.id,
      ts_function: c.ts_function,
      safety_verdict_level: null,
      headline: links.headline,
      body: links.body,
      handoff_text: walletText,
      sms_href: links.smsHref,
      mailto_href: links.mailtoHref,
    };
  }

  throw new Error(`Unsupported ts_function: ${String(c.ts_function)}`);
});

process.stdout.write(JSON.stringify(out));
"""
    stdin_payload = json.dumps({"cases": cases}, ensure_ascii=False)
    proc = subprocess.run(
        [node_bin, "--import", "tsx", "--input-type=module", "-e", ts_code],
        input=stdin_payload,
        text=True,
        capture_output=True,
        cwd=str(REPO_ROOT),
        env=os.environ.copy(),
        timeout=60,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"TypeScript handoff batch failed ({proc.returncode}): {sanitize_obj(proc.stderr[:500])}"
        )
    rows = json.loads(proc.stdout)
    return {row["id"]: row for row in rows}


def judge_handoff(
    session: requests.Session,
    api_key: str,
    case: dict[str, Any],
    handoff_text: str,
    alert_headline: str | None,
) -> tuple[dict[str, Any], float, dict[str, int]]:
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL_NAME}:generateContent?key={api_key}"
    judge_input: dict[str, Any] = {
        "case_id": case["id"],
        "category": case["category"],
        "handoff_kind": case["handoff_kind"],
        "generator_function": case["ts_function"],
        "expected_language": case["language"],
        "scenario_description": case["description"],
        "recipient_context": case["caregiver_context"],
        "plain_text_handoff": handoff_text,
    }
    if alert_headline is not None:
        judge_input["alert_subject_headline"] = alert_headline

    payload = {
        "systemInstruction": {"parts": [{"text": JUDGE_SYSTEM_PROMPT}]},
        "contents": [
            {
                "role": "user",
                "parts": [
                    {
                        "text": (
                            "Score this HoldUp plain-text caregiver or emergency wallet handoff artifact:\n"
                            + json.dumps(judge_input, ensure_ascii=False, indent=2)
                        )
                    }
                ],
            }
        ],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseJsonSchema": JUDGE_SCHEMA,
            "thinkingConfig": {"thinkingLevel": THINKING_LEVEL},
            "maxOutputTokens": 1024,
        },
    }

    last_err = ""
    for attempt in range(4):
        t0 = time.perf_counter()
        try:
            resp = session.post(url, json=payload, timeout=45)
            elapsed_ms = (time.perf_counter() - t0) * 1000.0
            if resp.status_code == 200:
                body = resp.json()
                cands = body.get("candidates") or []
                parts = (cands[0].get("content") or {}).get("parts") or [] if cands else []
                json_text = ""
                for part in parts:
                    if "text" in part and not part.get("thought") and part["text"].strip():
                        json_text = part["text"].strip()
                        break
                if json_text:
                    parsed = json.loads(json_text)
                    usage_meta = body.get("usageMetadata") or {}
                    tok = {
                        "in": int(usage_meta.get("promptTokenCount") or 0),
                        "out": int(
                            usage_meta.get("candidatesTokenCount")
                            or usage_meta.get("responseTokenCount")
                            or 0
                        ),
                        "thinking": int(usage_meta.get("thoughtsTokenCount") or 0),
                    }
                    cleaned = {
                        "clarity_1_to_5": int(parsed["clarity_1_to_5"]),
                        "language_match": bool(parsed["language_match"]),
                        "actionable_for_caregiver": bool(parsed["actionable_for_caregiver"]),
                        "preserves_non_medical_boundary": bool(
                            parsed["preserves_non_medical_boundary"]
                        ),
                        "privacy_minimal_no_extra_pii": bool(
                            parsed["privacy_minimal_no_extra_pii"]
                        ),
                        "rationale": str(sanitize_obj(parsed.get("rationale") or "")).strip(),
                    }
                    return cleaned, round(elapsed_ms, 1), tok
                last_err = "Empty non-thought JSON output"
                time.sleep(0.8 * (attempt + 1))
                continue
            last_err = f"HTTP {resp.status_code}: {sanitize_obj(resp.text[:300])}"
            if resp.status_code in (429, 500, 502, 503, 504):
                time.sleep(1.2 * (2 ** attempt))
                continue
            raise RuntimeError(last_err)
        except (requests.RequestException, json.JSONDecodeError, KeyError, ValueError) as exc:
            last_err = sanitize_obj(str(exc))
            time.sleep(1.2 * (2 ** attempt))
    raise RuntimeError(f"Gemini rubric judge failed after retries: {last_err}")


def assert_clean_report(node: Any) -> None:
    if isinstance(node, str):
        if EM_DASH in node:
            raise AssertionError(f"Forbidden em dash found in string: {node[:80]}")
        if API_KEY_RE.search(node):
            raise AssertionError("Forbidden API key pattern found in report")
        if node.startswith("data:image/") or node.startswith("/9j/") or len(node) > 1800:
            raise AssertionError(f"Unexpected base64 or oversized string ({len(node)} chars)")
        return
    if isinstance(node, list):
        for elem in node:
            assert_clean_report(elem)
        return
    if isinstance(node, dict):
        for k, v in node.items():
            assert_clean_report(k)
            assert_clean_report(v)


def run_benchmark(out_path: pathlib.Path) -> dict[str, Any]:
    if len(CASES) != 12:
        raise RuntimeError(f"Expected 12 cases, found {len(CASES)}")

    load_env_files()
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is not set in environment or $HOME/momin/.env")

    node_bin = ensure_node_and_deps()
    ts_by_id = run_ts_handoff_batch(node_bin, CASES)

    session = requests.Session()
    proxy_url = (os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy") or "").strip()
    if proxy_url:
        session.proxies.update(
            {"https": proxy_url, "http": os.environ.get("HTTP_PROXY", proxy_url)}
        )

    items: list[dict[str, Any]] = []

    for idx, case in enumerate(CASES, start=1):
        cid = case["id"]
        ts_row = ts_by_id[cid]
        handoff_text = str(ts_row["handoff_text"])
        raw_headline = str(ts_row["headline"])
        raw_body = str(ts_row["body"])
        sms_href = str(ts_row["sms_href"])
        mailto_href = str(ts_row["mailto_href"])

        zero_em_dash_ok = (
            (EM_DASH not in handoff_text)
            and (EM_DASH not in raw_headline)
            and (EM_DASH not in sms_href)
            and (EM_DASH not in mailto_href)
        )
        zero_raw_json_leak_ok = (
            ("{" not in handoff_text)
            and ("}" not in handoff_text)
            and (RAW_JSON_LEAK_RE.search(handoff_text) is None)
        )

        contact_phone = str(case.get("contact_phone", ""))
        contact_email = str(case.get("contact_email", ""))
        sms_uri_valid = validate_sms_uri(sms_href, contact_phone, raw_body)
        mailto_uri_valid = validate_mailto_uri(
            mailto_href, contact_email, raw_headline, raw_body
        )
        uri_encoding_valid = sms_uri_valid and mailto_uri_valid

        expected_substrings_ok = all(
            sub in handoff_text for sub in case.get("expected_substrings", [])
        )

        safety_level = ts_row.get("safety_verdict_level")
        confident_wrong_dose = False
        false_safe_allergen = False
        if case["handoff_kind"] == "safety_catch_alert":
            if safety_level != "warning" or not expected_substrings_ok:
                if case["has_allergen_hazard"]:
                    false_safe_allergen = True
                else:
                    confident_wrong_dose = True
        elif case["handoff_kind"] == "daily_adherence_summary":
            if not expected_substrings_ok:
                confident_wrong_dose = True
        elif case["handoff_kind"] == "emergency_wallet_card":
            meds = case["profile"]["meds"]
            allergies = case["profile"]["allergies"]
            if not expected_substrings_ok or not all(
                str(m["strength"]) in handoff_text for m in meds
            ):
                confident_wrong_dose = True
            if not all(str(a) in handoff_text for a in allergies):
                false_safe_allergen = True

        alert_subject = (
            raw_headline if case["ts_function"] == "buildFamilyAlertLinks" else None
        )
        rubric, latency_ms, tok = judge_handoff(
            session=session,
            api_key=api_key,
            case=case,
            handoff_text=handoff_text,
            alert_headline=alert_subject,
        )

        line_count = len([ln for ln in handoff_text.splitlines() if ln.strip()])
        char_count = len(handoff_text)

        item_record: dict[str, Any] = {
            "id": cid,
            "category": case["category"],
            "handoff_kind": case["handoff_kind"],
            "ts_function": case["ts_function"],
            "language": case["language"],
            "description": case["description"],
            "caregiver_context": case["caregiver_context"],
            "handoff_text": handoff_text,
            "line_count": line_count,
            "char_count": char_count,
            "expected_substrings_ok": expected_substrings_ok,
            "zero_em_dash_ok": zero_em_dash_ok,
            "zero_raw_json_leak_ok": zero_raw_json_leak_ok,
            "sms_uri_valid": sms_uri_valid,
            "mailto_uri_valid": mailto_uri_valid,
            "uri_encoding_valid": uri_encoding_valid,
            "confident_wrong_dose": confident_wrong_dose,
            "false_safe_allergen": false_safe_allergen,
            "clarity_1_to_5": rubric["clarity_1_to_5"],
            "language_match": rubric["language_match"],
            "actionable_for_caregiver": rubric["actionable_for_caregiver"],
            "preserves_non_medical_boundary": rubric["preserves_non_medical_boundary"],
            "privacy_minimal_no_extra_pii": rubric["privacy_minimal_no_extra_pii"],
            "rubric": rubric,
            "latency_ms": latency_ms,
            "tokens_in": tok["in"],
            "tokens_out": tok["out"],
            "tokens_thinking": tok["thinking"],
        }
        if case["ts_function"] == "buildFamilyAlertLinks":
            item_record["alert_headline"] = raw_headline
            item_record["sms_href"] = sms_href
            item_record["mailto_href"] = mailto_href
            if safety_level is not None:
                item_record["safety_verdict_level"] = safety_level

        items.append(sanitize_obj(item_record))
        print(
            f"[{idx:02d}/12 {cid}] fn={case['ts_function']} lang={case['language']} "
            f"clarity={rubric['clarity_1_to_5']}/5 lang_ok={rubric['language_match']} "
            f"act={rubric['actionable_for_caregiver']} "
            f"mdr={rubric['preserves_non_medical_boundary']} "
            f"priv={rubric['privacy_minimal_no_extra_pii']} "
            f"uri_ok={uri_encoding_valid} ms={latency_ms:.1f}"
        )

    n_cases = len(items)
    em_dash_pass = sum(1 for it in items if it["zero_em_dash_ok"])
    json_leak_pass = sum(1 for it in items if it["zero_raw_json_leak_ok"])
    sms_pass = sum(1 for it in items if it["sms_uri_valid"])
    mailto_pass = sum(1 for it in items if it["mailto_uri_valid"])
    uri_pass = sum(1 for it in items if it["uri_encoding_valid"])
    substring_pass = sum(1 for it in items if it["expected_substrings_ok"])

    lang_pass = sum(1 for it in items if it["language_match"])
    actionable_pass = sum(1 for it in items if it["actionable_for_caregiver"])
    mdr_pass = sum(1 for it in items if it["preserves_non_medical_boundary"])
    privacy_pass = sum(1 for it in items if it["privacy_minimal_no_extra_pii"])
    clarity_scores = [int(it["clarity_1_to_5"]) for it in items]

    cwd_count = int(sum(1 for it in items if it["confident_wrong_dose"]))
    fsa_count = int(sum(1 for it in items if it["false_safe_allergen"]))

    latencies = [float(it["latency_ms"]) for it in items]
    total_tokens_in = int(sum(int(it["tokens_in"]) for it in items))
    total_tokens_out = int(sum(int(it["tokens_out"]) for it in items))
    total_tokens_thinking = int(sum(int(it["tokens_thinking"]) for it in items))

    observed_langs = [lang for lang in LANGUAGES_TESTED if any(it["language"] == lang for it in items)]

    by_handoff_kind: dict[str, dict[str, Any]] = {}
    for kind in ("safety_catch_alert", "daily_adherence_summary", "emergency_wallet_card"):
        sub = [it for it in items if it["handoff_kind"] == kind]
        by_handoff_kind[kind] = {
            "n_cases": len(sub),
            "mean_clarity_score": round(
                statistics.mean(int(it["clarity_1_to_5"]) for it in sub), 3
            ),
            "caregiver_actionability_rate": round(
                sum(1 for it in sub if it["actionable_for_caregiver"]) / len(sub), 4
            ),
            "non_medical_boundary_pass_rate": round(
                sum(1 for it in sub if it["preserves_non_medical_boundary"]) / len(sub), 4
            ),
            "privacy_minimal_pass_rate": round(
                sum(1 for it in sub if it["privacy_minimal_no_extra_pii"]) / len(sub), 4
            ),
        }

    summary: dict[str, Any] = {
        "model": MODEL_NAME,
        "thinking_level": THINKING_LEVEL,
        "n_cases": n_cases,
        "languages_tested": observed_langs,
        "zero_em_dash_rate": round(em_dash_pass / n_cases, 4),
        "zero_raw_json_leak_rate": round(json_leak_pass / n_cases, 4),
        "sms_uri_valid_rate": round(sms_pass / n_cases, 4),
        "mailto_uri_valid_rate": round(mailto_pass / n_cases, 4),
        "uri_encoding_pass_rate": round(uri_pass / n_cases, 4),
        "expected_content_pass_rate": round(substring_pass / n_cases, 4),
        "language_match_rate": round(lang_pass / n_cases, 4),
        "caregiver_actionability_rate": round(actionable_pass / n_cases, 4),
        "non_medical_boundary_pass_rate": round(mdr_pass / n_cases, 4),
        "privacy_minimal_pass_rate": round(privacy_pass / n_cases, 4),
        "mean_clarity_score": round(statistics.mean(clarity_scores), 3),
        "min_clarity_score": min(clarity_scores),
        "max_clarity_score": max(clarity_scores),
        "confident_wrong_dose_count": cwd_count,
        "false_safe_allergen_count": fsa_count,
        "latency_p50_ms": percentile(latencies, 0.50),
        "latency_p95_ms": percentile(latencies, 0.95),
        "latency_mean_ms": round(statistics.mean(latencies), 1),
        "tokens_in": total_tokens_in,
        "tokens_out": total_tokens_out,
        "tokens_thinking": total_tokens_thinking,
        "by_handoff_kind": by_handoff_kind,
    }

    report = sanitize_obj(
        {
            "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "model": MODEL_NAME,
            "summary": summary,
            "items": items,
        }
    )

    assert_clean_report(report)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Caregiver family alert, adherence summary, and emergency wallet handoff benchmark"
    )
    parser.add_argument(
        "--out",
        type=pathlib.Path,
        default=DEFAULT_OUT_JSON,
        help="Path to write caregiver_handoff_results.json",
    )
    args = parser.parse_args(argv)
    report = run_benchmark(args.out)
    print(json.dumps(report["summary"], indent=2))
    s = report["summary"]
    if (
        s["n_cases"] != 12
        or s["languages_tested"] != ["en", "fi", "sv"]
        or s["zero_em_dash_rate"] != 1.0
        or s["zero_raw_json_leak_rate"] != 1.0
        or s["uri_encoding_pass_rate"] != 1.0
        or s["expected_content_pass_rate"] != 1.0
        or s["confident_wrong_dose_count"] != 0
        or s["false_safe_allergen_count"] != 0
    ):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
