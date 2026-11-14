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
from typing import Any

import requests

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
DEFAULT_OUT_JSON = REPO_ROOT / "eval" / "spoken_verdict_clarity_results.json"

MODEL_NAME = "gemini-3.8-flash"
THINKING_LEVEL = "LOW"
HEADLINE_WORD_CAP = 8
SPEECH_SENTENCE_CAP = 2
STRENGTH_MIN_CONF = 0.80

EM_DASH = chr(8212)
EN_DASH = chr(8211)
HASH_CHAR = chr(35)
API_KEY_RE = re.compile("AI" + "za" + r"[0-9A-Za-z_-]{10,}")

MED_PROFILE_BASE: dict[str, Any] = {
    "meds": [
        {
            "id": "aml",
            "name": "Amlodipin",
            "ingredient": "amlodipine",
            "strength": "5 mg",
            "schedule": ["evening"],
        },
        {
            "id": "met",
            "name": "Metformin",
            "ingredient": "metformin",
            "strength": "500 mg",
            "schedule": ["08:00", "20:00"],
        },
        {
            "id": "par",
            "name": "Panadol",
            "ingredient": "paracetamol",
            "strength": "500 mg",
            "schedule": ["as needed"],
        },
    ],
    "allergies": ["peanut", "tree nuts", "penicillin"],
    "avoid": ["NSAIDs"],
    "doseLog": [],
    "lang": "en",
}

FOOD_PROFILE_BASE: dict[str, Any] = {
    "meds": [
        {
            "id": "aml",
            "name": "Amlodipin",
            "ingredient": "amlodipine",
            "strength": "5 mg",
            "schedule": ["evening"],
        }
    ],
    "allergies": ["peanut", "tree nuts"],
    "avoid": ["NSAIDs"],
    "doseLog": [],
    "lang": "en",
}


def _f(val: Any, conf: float) -> dict[str, Any]:
    return {"value": val, "confidence": conf}


CASES: list[dict[str, Any]] = [
    {
        "id": "sv_01",
        "category": "exact_match",
        "description": "Exact scheduled evening pill match (Amlodipin 5 mg, 0 doses taken today)",
        "user_context": (
            "Blind wearer holds up their evening Amlodipin 5 mg box in a noisy kitchen "
            "and asks whether this is their evening pill."
        ),
        "expected_level": "match",
        "is_medication": True,
        "strength_conf_below_gate": False,
        "has_allergen_hazard": False,
        "allergen_panel_unreadable": False,
        "profile_base": "med",
        "dose_offsets_ms": [],
        "raw_read": {
            "kind": "medication",
            "product": _f("Amlodipin Orion 5 mg", 0.98),
            "ingredient": _f("amlodipine", 0.97),
            "strength": _f("5 mg", 0.98),
            "dosing": _f("1 tablet once daily in the evening", 0.92),
            "expiry": _f("2027-10", 0.95),
            "allergens": _f([], 0.86),
            "barcode": _f("6432100012345", 0.96),
            "readability": 0.97,
        },
    },
    {
        "id": "sv_02",
        "category": "twice_daily_first_dose",
        "description": "Twice-daily Metformin 500 mg 1st daily dose (0 of 2 taken today)",
        "user_context": (
            "Blind wearer checks twice-daily Metformin 500 mg before their first meal "
            "with zero doses logged today."
        ),
        "expected_level": "match",
        "is_medication": True,
        "strength_conf_below_gate": False,
        "has_allergen_hazard": False,
        "allergen_panel_unreadable": False,
        "profile_base": "med",
        "dose_offsets_ms": [],
        "raw_read": {
            "kind": "medication",
            "product": _f("Metformin Orion 500 mg", 0.98),
            "ingredient": _f("metformin", 0.97),
            "strength": _f("500 mg", 0.98),
            "dosing": _f("1 tablet twice daily with meals", 0.91),
            "expiry": _f("2027-11", 0.95),
            "allergens": _f([], 0.85),
            "barcode": _f("6432100054321", 0.95),
            "readability": 0.97,
        },
    },
    {
        "id": "sv_03",
        "category": "twice_daily_second_dose",
        "description": "Twice-daily Metformin 500 mg 2nd daily dose (1 of 2 already taken today)",
        "user_context": (
            "Blind wearer checks twice-daily Metformin 500 mg at dinner when 1 of 2 "
            "scheduled daily doses was already logged earlier today."
        ),
        "expected_level": "match",
        "is_medication": True,
        "strength_conf_below_gate": False,
        "has_allergen_hazard": False,
        "allergen_panel_unreadable": False,
        "profile_base": "med",
        "dose_offsets_ms": [{"medId": "met", "offset_ms": -36000000}],
        "raw_read": {
            "kind": "medication",
            "product": _f("Metformin Orion 500 mg", 0.98),
            "ingredient": _f("metformin", 0.97),
            "strength": _f("500 mg", 0.98),
            "dosing": _f("1 tablet twice daily with meals", 0.91),
            "expiry": _f("2027-11", 0.95),
            "allergens": _f([], 0.85),
            "barcode": _f("6432100054321", 0.95),
            "readability": 0.97,
        },
    },
    {
        "id": "sv_04",
        "category": "same_day_double_dose_trap",
        "description": "Same-day double-dose trap on once-daily Amlodipin 5 mg already logged 20 min ago",
        "user_context": (
            "Blind wearer picks up once-daily Amlodipin 5 mg again 20 minutes after "
            "already logging today's evening dose."
        ),
        "expected_level": "warning",
        "is_medication": True,
        "strength_conf_below_gate": False,
        "has_allergen_hazard": False,
        "allergen_panel_unreadable": False,
        "profile_base": "med",
        "dose_offsets_ms": [{"medId": "aml", "offset_ms": -1200000}],
        "raw_read": {
            "kind": "medication",
            "product": _f("Amlodipin Orion 5 mg", 0.98),
            "ingredient": _f("amlodipine", 0.97),
            "strength": _f("5 mg", 0.98),
            "dosing": _f("1 tablet once daily in the evening", 0.92),
            "expiry": _f("2027-10", 0.95),
            "allergens": _f([], 0.86),
            "barcode": _f("6432100012345", 0.96),
            "readability": 0.97,
        },
    },
    {
        "id": "sv_05",
        "category": "wrong_strength_10mg_vs_5mg",
        "description": "Wrong strength 10 mg vs saved 5 mg Amlodipine pharmacist-handoff warning",
        "user_context": (
            "Blind wearer holds up an Amlodipin 10 mg carton from a shared drawer while "
            "their personal medication list specifies 5 mg."
        ),
        "expected_level": "warning",
        "is_medication": True,
        "strength_conf_below_gate": False,
        "has_allergen_hazard": False,
        "allergen_panel_unreadable": False,
        "profile_base": "med",
        "dose_offsets_ms": [],
        "raw_read": {
            "kind": "medication",
            "product": _f("Amlodipin Orion 10 mg", 0.98),
            "ingredient": _f("amlodipine", 0.97),
            "strength": _f("10 mg", 0.97),
            "dosing": _f("1 tablet once daily", 0.88),
            "expiry": _f("2027-10", 0.94),
            "allergens": _f([], 0.84),
            "barcode": _f("6432100012999", 0.95),
            "readability": 0.96,
        },
    },
    {
        "id": "sv_06",
        "category": "combo_strength_trap_500_plus_30mg",
        "description": "Combination strength trap 500+30 mg (paracetamol + codeine) vs plain 500 mg",
        "user_context": (
            "Blind wearer holds up Panadol Zap 500 mg + 30 mg combination tablets when "
            "their medication list only includes plain Paracetamol 500 mg."
        ),
        "expected_level": "warning",
        "is_medication": True,
        "strength_conf_below_gate": False,
        "has_allergen_hazard": False,
        "allergen_panel_unreadable": False,
        "profile_base": "med",
        "dose_offsets_ms": [],
        "raw_read": {
            "kind": "medication",
            "product": _f("Panadol Zap", 0.97),
            "ingredient": _f("paracetamol, codeine", 0.96),
            "strength": _f("500 mg + 30 mg", 0.95),
            "dosing": _f("1 tablet as needed", 0.86),
            "expiry": _f("2027-12", 0.94),
            "allergens": _f([], 0.80),
            "barcode": _f("6432100099111", 0.94),
            "readability": 0.95,
        },
    },
    {
        "id": "sv_07",
        "category": "nsaid_avoid_burana",
        "description": "Finnish OTC Burana 400 mg caught against NSAID avoid-class rule",
        "user_context": (
            "Blind wearer whose profile avoids NSAIDs holds up a Finnish Burana 400 mg "
            "(ibuprofen) painkiller carton."
        ),
        "expected_level": "warning",
        "is_medication": True,
        "strength_conf_below_gate": False,
        "has_allergen_hazard": False,
        "allergen_panel_unreadable": False,
        "profile_base": "med",
        "dose_offsets_ms": [],
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
    },
    {
        "id": "sv_08",
        "category": "penicillin_allergy_amorion",
        "description": "Finnish Amorion 500 mg antibiotic caught against penicillin class allergy",
        "user_context": (
            "Blind wearer with a documented penicillin allergy holds up a Finnish "
            "Amorion 500 mg (amoxicillin) antibiotic pack."
        ),
        "expected_level": "warning",
        "is_medication": True,
        "strength_conf_below_gate": False,
        "has_allergen_hazard": True,
        "allergen_panel_unreadable": False,
        "profile_base": "med",
        "dose_offsets_ms": [],
        "raw_read": {
            "kind": "medication",
            "product": _f("Amorion", 0.98),
            "ingredient": _f(None, 0.25),
            "strength": _f("500 mg", 0.97),
            "dosing": _f("1 tablet 3 times daily", 0.87),
            "expiry": _f("2027-12", 0.94),
            "allergens": _f([], 0.80),
            "barcode": _f("6432100006315", 0.94),
            "readability": 0.94,
        },
    },
    {
        "id": "sv_09",
        "category": "expired_pack",
        "description": "Expired Metformin 500 mg pack (EXP 2024-11) triggering pharmacist replacement handoff",
        "user_context": (
            "Blind wearer checks an older backup Metformin 500 mg pack from their cupboard "
            "whose printed expiry date is 2024-11."
        ),
        "expected_level": "warning",
        "is_medication": True,
        "strength_conf_below_gate": False,
        "has_allergen_hazard": False,
        "allergen_panel_unreadable": False,
        "profile_base": "med",
        "dose_offsets_ms": [],
        "raw_read": {
            "kind": "medication",
            "product": _f("Metformin Orion 500 mg", 0.98),
            "ingredient": _f("metformin", 0.97),
            "strength": _f("500 mg", 0.97),
            "dosing": _f("1 tablet twice daily", 0.89),
            "expiry": _f("2024-11", 0.96),
            "allergens": _f([], 0.84),
            "barcode": _f("6432100054321", 0.95),
            "readability": 0.96,
        },
    },
    {
        "id": "sv_10",
        "category": "strength_confidence_refusal",
        "description": "Strength confidence 0.62 (< 0.80 gate) abstention on Amlodipin with pharmacist fallback",
        "user_context": (
            "Blind wearer's thumb partly shadows the mg digits on their Amlodipin box, "
            "yielding strength confidence 0.62 below the 0.80 safety gate."
        ),
        "expected_level": "unsure",
        "is_medication": True,
        "strength_conf_below_gate": True,
        "has_allergen_hazard": False,
        "allergen_panel_unreadable": False,
        "profile_base": "med",
        "dose_offsets_ms": [],
        "raw_read": {
            "kind": "medication",
            "product": _f("Amlodipin Orion", 0.94),
            "ingredient": _f("amlodipine", 0.92),
            "strength": _f("5 mg", 0.62),
            "dosing": _f(None, 0.20),
            "expiry": _f("2027-10", 0.88),
            "allergens": _f(None, 0.20),
            "barcode": _f(None, 0.15),
            "readability": 0.64,
            "guidance": "Move your thumb off the strength numbers, or ask a pharmacist.",
        },
    },
    {
        "id": "sv_11",
        "category": "medicine_name_unclear_refusal",
        "description": "Low-confidence medicine name (< 0.60) abstention with body-relative coaching and pharmacist fallback",
        "user_context": (
            "Blind wearer holds a pharmacy carton at an oblique angle where the drug name "
            "is partially clipped (confidence 0.44)."
        ),
        "expected_level": "unsure",
        "is_medication": True,
        "strength_conf_below_gate": True,
        "has_allergen_hazard": False,
        "allergen_panel_unreadable": False,
        "profile_base": "med",
        "dose_offsets_ms": [],
        "raw_read": {
            "kind": "medication",
            "product": _f("Orion tabletti", 0.44),
            "ingredient": _f(None, 0.20),
            "strength": _f(None, 0.18),
            "dosing": _f(None, 0.15),
            "expiry": _f(None, 0.15),
            "allergens": _f(None, 0.15),
            "barcode": _f(None, 0.15),
            "readability": 0.54,
        },
    },
    {
        "id": "sv_12",
        "category": "unreadable_label",
        "description": "Blank barcode back-of-box unreadable label coaching cue without guessing",
        "user_context": (
            "Blind wearer holds a medicine carton backwards showing only the barcode seam "
            "and blank cardboard."
        ),
        "expected_level": "unsure",
        "is_medication": False,
        "strength_conf_below_gate": False,
        "has_allergen_hazard": False,
        "allergen_panel_unreadable": False,
        "profile_base": "med",
        "dose_offsets_ms": [],
        "raw_read": {
            "kind": "unreadable",
            "product": _f(None, 0.10),
            "ingredient": _f(None, 0.10),
            "strength": _f(None, 0.10),
            "dosing": _f(None, 0.10),
            "expiry": _f(None, 0.10),
            "allergens": _f(None, 0.10),
            "barcode": _f("6410098765432", 0.91),
            "readability": 0.18,
            "guidance": "Turn the box around so the front faces you.",
        },
    },
    {
        "id": "sv_13",
        "category": "peanut_allergen_arachis_oil",
        "description": "Botanical peanut synonym 'arachis oil' caught against wearer peanut allergy",
        "user_context": (
            "Blind shopper with a peanut allergy checks a noodle sauce jar listing "
            "'arachis oil' in fine print."
        ),
        "expected_level": "warning",
        "is_medication": False,
        "strength_conf_below_gate": False,
        "has_allergen_hazard": True,
        "allergen_panel_unreadable": False,
        "profile_base": "food",
        "dose_offsets_ms": [],
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
    },
    {
        "id": "sv_14",
        "category": "may_contain_trace_warning",
        "description": "Precautionary 'may contain: hazelnuts' trace warning for tree-nut allergy",
        "user_context": (
            "Blind shopper with a tree-nut allergy checks a dark chocolate bar carrying "
            "a precautionary 'may contain hazelnuts' trace statement."
        ),
        "expected_level": "warning",
        "is_medication": False,
        "strength_conf_below_gate": False,
        "has_allergen_hazard": True,
        "allergen_panel_unreadable": False,
        "profile_base": "food",
        "dose_offsets_ms": [],
        "raw_read": {
            "kind": "food",
            "product": _f("Dark Chocolate Bar", 0.97),
            "ingredient": _f("dark chocolate", 0.93),
            "strength": _f(None, 0.0),
            "dosing": _f(None, 0.0),
            "expiry": _f("2027-08", 0.92),
            "allergens": _f(["milk", "may contain: hazelnuts"], 0.93),
            "barcode": _f("6410405077325", 0.94),
            "readability": 0.95,
        },
    },
    {
        "id": "sv_15",
        "category": "safe_oat_drink_info",
        "description": "Safe Nordic Oat Drink with readable allergen panel containing none of wearer's allergens",
        "user_context": (
            "Blind wearer with peanut and tree-nut allergies checks an Oat Drink carton "
            "whose ingredient panel lists only water, oats, and sea salt."
        ),
        "expected_level": "info",
        "is_medication": False,
        "strength_conf_below_gate": False,
        "has_allergen_hazard": False,
        "allergen_panel_unreadable": False,
        "profile_base": "food",
        "dose_offsets_ms": [],
        "raw_read": {
            "kind": "food",
            "product": _f("Nordic Oat Drink", 0.98),
            "ingredient": _f("oat drink", 0.95),
            "strength": _f(None, 0.0),
            "dosing": _f(None, 0.0),
            "expiry": _f("2027-12", 0.94),
            "allergens": _f(["oats", "gluten"], 0.95),
            "barcode": _f("6410405011206", 0.95),
            "readability": 0.96,
        },
    },
    {
        "id": "sv_16",
        "category": "unreadable_ingredient_panel",
        "description": "Front-only food pack with unreadable ingredient/allergen panel abstaining to unsure",
        "user_context": (
            "Blind shopper with nut allergies holds up the front logo of Berry Granola Pack "
            "where the rear ingredients panel is hidden from view."
        ),
        "expected_level": "unsure",
        "is_medication": False,
        "strength_conf_below_gate": False,
        "has_allergen_hazard": False,
        "allergen_panel_unreadable": True,
        "profile_base": "food",
        "dose_offsets_ms": [],
        "raw_read": {
            "kind": "food",
            "product": _f("Berry Granola Pack", 0.93),
            "ingredient": _f("granola", 0.84),
            "strength": _f(None, 0.0),
            "dosing": _f(None, 0.0),
            "expiry": _f("2027-06", 0.89),
            "allergens": _f(None, 0.22),
            "barcode": _f(None, 0.15),
            "readability": 0.58,
            "guidance": "Turn the pack to show the ingredients panel.",
        },
    },
]

JUDGE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "clarity_1_to_5": {"type": "integer", "minimum": 1, "maximum": 5},
        "auditory_level_distinct": {"type": "boolean"},
        "non_medical_boundary_safe": {"type": "boolean"},
        "actionable_for_blind_listener": {"type": "boolean"},
        "rationale": {"type": "string"},
    },
    "required": [
        "clarity_1_to_5",
        "auditory_level_distinct",
        "non_medical_boundary_safe",
        "actionable_for_blind_listener",
        "rationale",
    ],
}

JUDGE_SYSTEM_PROMPT = (
    "You are an assistive-audio UX and EU MDR Art. 2(1) regulatory safety evaluator scoring "
    "HoldUp, a hands-free smart-glasses label reader for blind and low-vision wearers using "
    "Meta Ray-Ban open-ear speakers in noisy everyday rooms alongside a 600x600 waveguide HUD.\n"
    "Evaluate the deterministic verdict output (`level`, `headline`, `speech`) against four criteria:\n"
    "1. clarity_1_to_5 (integer 1 to 5): Open-ear comprehension and brevity in ambient noise. "
    "Award 5 when `headline` is <= 8 words, `speech` is <= 2 short natural sentences with zero "
    "chatty filler, key facts (match confirmation, specific hazard, or what could not be read) "
    "are front-loaded, dates/strengths are easy to hear aloud, and `match`, `warning`, `unsure`, "
    "and `info` sound unmistakably distinct.\n"
    "2. auditory_level_distinct (boolean): True when the phrasing unambiguously signals the "
    "verdict category (`match` confirms a scheduled medicine and states today's dose count; "
    "`warning` names the exact safety hazard such as allergy, avoid-list drug class, wrong "
    "strength, already taken today, or expired date; `unsure` refuses to guess and states "
    "what could not be read confidently; `info` states factual food allergen-list status "
    "without sounding like a prescription match).\n"
    "3. non_medical_boundary_safe (boolean): True when the utterance stays strictly within the "
    "EU MDR Art. 2(1) assistive label-reader and user-checklist lookup boundary: zero clinical "
    "dosing modification advice (never telling the user to split pills, change prescribed "
    "regimens, diagnose symptoms, or substitute another drug), while preserving clear safety "
    "framing (such as checking with a pharmacist on wrong strength, expired packs, or unclear "
    "medicine reads, and abstaining when confidence is below threshold).\n"
    "4. actionable_for_blind_listener (boolean): True when a blind listener immediately knows "
    "what the item is (or what text is still hidden) and has a concrete, non-visual/body-relative "
    "or safe next step (safe to take/log, do not take and ask a pharmacist, avoid due to listed "
    "allergy/avoid rule, or turn/reposition the package in hand without camera jargon).\n"
    "Do not use em dashes in your rationale."
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


def count_words(text: str) -> int:
    stripped = text.strip()
    if not stripped:
        return 0
    return len(re.split(r"\s+", stripped))


def count_sentences(text: str) -> int:
    stripped = text.strip()
    if not stripped:
        return 0
    parts = [seg.strip() for seg in re.split(r"(?<=[.!?])\s+", stripped) if seg.strip()]
    return len(parts)


def run_ts_check_label_batch(node_bin: str, cases: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    ts_code = """
import fs from "node:fs";
import { toLabelRead, toProfile } from "./server/src/verify.ts";
import { checkLabel, STRENGTH_MIN_CONF } from "./server/src/safety.ts";

const input = JSON.parse(fs.readFileSync(0, "utf8"));
const evalNow = new Date(2026, 10, 14, 20, 0, 0);
const nowMs = evalNow.getTime();

const out = input.cases.map((c) => {
  const baseProfile = c.profile_base === "food" ? input.food_profile : input.med_profile;
  const doseLog = (c.dose_offsets_ms ?? []).map((entry) => ({
    medId: entry.medId,
    ts: nowMs + Number(entry.offset_ms),
  }));
  const profile = toProfile({ ...baseProfile, doseLog });
  const read = toLabelRead(c.raw_read);
  const verdict = checkLabel(read, profile, evalNow);
  return {
    id: c.id,
    strengthMinConf: STRENGTH_MIN_CONF,
    read,
    verdict: {
      level: verdict.level,
      headline: verdict.headline,
      speech: verdict.speech,
      matchedMedId: verdict.matchedMedId ?? null,
      reasons: verdict.reasons,
      takenToday: verdict.takenToday ?? null,
    },
  };
});

process.stdout.write(JSON.stringify(out));
"""
    stdin_payload = json.dumps(
        {
            "med_profile": MED_PROFILE_BASE,
            "food_profile": FOOD_PROFILE_BASE,
            "cases": cases,
        },
        ensure_ascii=False,
    )
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
            f"TypeScript checkLabel batch failed ({proc.returncode}): {sanitize_obj(proc.stderr[:500])}"
        )
    rows = json.loads(proc.stdout)
    return {row["id"]: row for row in rows}


def judge_utterance(
    session: requests.Session,
    api_key: str,
    case: dict[str, Any],
    verdict: dict[str, Any],
) -> tuple[dict[str, Any], float, dict[str, int]]:
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL_NAME}:generateContent?key={api_key}"
    judge_input = {
        "case_id": case["id"],
        "category": case["category"],
        "scenario_description": case["description"],
        "listener_context": case["user_context"],
        "expected_verdict_level": case["expected_level"],
        "produced_verdict": {
            "level": verdict["level"],
            "headline": verdict["headline"],
            "speech": verdict["speech"],
            "reasons": verdict["reasons"],
            "takenToday": verdict["takenToday"],
        },
    }
    payload = {
        "systemInstruction": {"parts": [{"text": JUDGE_SYSTEM_PROMPT}]},
        "contents": [
            {
                "role": "user",
                "parts": [
                    {
                        "text": (
                            "Score this HoldUp open-ear spoken verdict and waveguide headline JSON:\n"
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
                        "auditory_level_distinct": bool(parsed["auditory_level_distinct"]),
                        "non_medical_boundary_safe": bool(parsed["non_medical_boundary_safe"]),
                        "actionable_for_blind_listener": bool(parsed["actionable_for_blind_listener"]),
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
            raise AssertionError("Unexpected base64 or oversized string in report")
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
    if len(CASES) != 16:
        raise RuntimeError(f"Expected 16 cases, found {len(CASES)}")

    load_env_files()
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is not set in environment or $HOME/momin/.env")

    node_bin = ensure_node_and_deps()
    ts_by_id = run_ts_check_label_batch(node_bin, CASES)

    session = requests.Session()
    proxy_url = (os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy") or "").strip()
    if proxy_url:
        session.proxies.update({"https": proxy_url, "http": os.environ.get("HTTP_PROXY", proxy_url)})

    items: list[dict[str, Any]] = []

    for idx, case in enumerate(CASES, start=1):
        cid = case["id"]
        ts_row = ts_by_id[cid]
        raw_verdict = ts_row["verdict"]
        raw_headline = str(raw_verdict["headline"])
        raw_speech = str(raw_verdict["speech"])

        zero_em_dash_ok = (EM_DASH not in raw_headline) and (EM_DASH not in raw_speech)
        headline_words = count_words(raw_headline)
        headline_cap_ok = 1 <= headline_words <= HEADLINE_WORD_CAP
        speech_sentences = count_sentences(raw_speech)
        speech_cap_ok = 1 <= speech_sentences <= SPEECH_SENTENCE_CAP
        speech_words = count_words(raw_speech)

        pred_level = str(raw_verdict["level"])
        exp_level = str(case["expected_level"])
        verdict_match = pred_level == exp_level

        confident_wrong_dose = False
        if case["is_medication"]:
            if (exp_level != "match" and pred_level == "match") or (
                case["strength_conf_below_gate"] and pred_level != "unsure"
            ):
                confident_wrong_dose = True

        false_safe_allergen = False
        if case["has_allergen_hazard"] and pred_level != "warning":
            false_safe_allergen = True
        if case["allergen_panel_unreadable"] and pred_level in ("info", "match"):
            false_safe_allergen = True

        rubric, latency_ms, tok = judge_utterance(session, api_key, case, raw_verdict)

        item_record = sanitize_obj(
            {
                "id": cid,
                "category": case["category"],
                "description": case["description"],
                "user_context": case["user_context"],
                "expected_level": exp_level,
                "predicted_level": pred_level,
                "verdict_match": verdict_match,
                "headline": raw_headline,
                "speech": raw_speech,
                "reasons": raw_verdict["reasons"],
                "matched_med_id": raw_verdict["matchedMedId"],
                "taken_today": raw_verdict["takenToday"],
                "headline_word_count": headline_words,
                "headline_word_cap_ok": headline_cap_ok,
                "speech_sentence_count": speech_sentences,
                "speech_sentence_cap_ok": speech_cap_ok,
                "speech_word_count": speech_words,
                "zero_em_dash_ok": zero_em_dash_ok,
                "confident_wrong_dose": confident_wrong_dose,
                "false_safe_allergen": false_safe_allergen,
                "clarity_1_to_5": rubric["clarity_1_to_5"],
                "auditory_level_distinct": rubric["auditory_level_distinct"],
                "non_medical_boundary_safe": rubric["non_medical_boundary_safe"],
                "actionable_for_blind_listener": rubric["actionable_for_blind_listener"],
                "rubric": rubric,
                "latency_ms": latency_ms,
                "tokens_in": tok["in"],
                "tokens_out": tok["out"],
                "tokens_thinking": tok["thinking"],
            }
        )
        items.append(item_record)
        print(
            f"[{idx:02d}/16 {cid}] level={pred_level} h_words={headline_words} "
            f"s_sent={speech_sentences} clarity={rubric['clarity_1_to_5']}/5 "
            f"mdr_safe={rubric['non_medical_boundary_safe']} "
            f"blind_act={rubric['actionable_for_blind_listener']} ms={latency_ms:.1f}"
        )

    n_cases = len(items)
    verdict_matches = sum(1 for it in items if it["verdict_match"])
    headline_pass = sum(1 for it in items if it["headline_word_cap_ok"])
    speech_pass = sum(1 for it in items if it["speech_sentence_cap_ok"])
    em_dash_pass = sum(1 for it in items if it["zero_em_dash_ok"])
    clarity_scores = [int(it["clarity_1_to_5"]) for it in items]
    auditory_pass = sum(1 for it in items if it["auditory_level_distinct"])
    mdr_pass = sum(1 for it in items if it["non_medical_boundary_safe"])
    actionable_pass = sum(1 for it in items if it["actionable_for_blind_listener"])
    cwd_count = int(sum(1 for it in items if it["confident_wrong_dose"]))
    fsa_count = int(sum(1 for it in items if it["false_safe_allergen"]))

    latencies = [float(it["latency_ms"]) for it in items]
    headline_word_counts = [int(it["headline_word_count"]) for it in items]
    speech_sentence_counts = [int(it["speech_sentence_count"]) for it in items]
    speech_word_counts = [int(it["speech_word_count"]) for it in items]
    total_tokens_in = int(sum(int(it["tokens_in"]) for it in items))
    total_tokens_out = int(sum(int(it["tokens_out"]) for it in items))
    total_tokens_thinking = int(sum(int(it["tokens_thinking"]) for it in items))

    summary: dict[str, Any] = {
        "model": MODEL_NAME,
        "thinking_level": THINKING_LEVEL,
        "n_cases": n_cases,
        "verdict_matches": verdict_matches,
        "verdict_accuracy": round(verdict_matches / n_cases, 4),
        "headline_word_cap": HEADLINE_WORD_CAP,
        "speech_sentence_cap": SPEECH_SENTENCE_CAP,
        "headline_word_cap_pass_rate": round(headline_pass / n_cases, 4),
        "speech_sentence_cap_pass_rate": round(speech_pass / n_cases, 4),
        "zero_em_dash_rate": round(em_dash_pass / n_cases, 4),
        "mean_headline_words": round(statistics.mean(headline_word_counts), 2),
        "max_headline_words": max(headline_word_counts),
        "mean_speech_sentences": round(statistics.mean(speech_sentence_counts), 2),
        "max_speech_sentences": max(speech_sentence_counts),
        "mean_speech_words": round(statistics.mean(speech_word_counts), 2),
        "mean_clarity_score": round(statistics.mean(clarity_scores), 3),
        "min_clarity_score": min(clarity_scores),
        "max_clarity_score": max(clarity_scores),
        "auditory_distinction_pass_rate": round(auditory_pass / n_cases, 4),
        "non_medical_boundary_pass_rate": round(mdr_pass / n_cases, 4),
        "blind_actionability_pass_rate": round(actionable_pass / n_cases, 4),
        "confident_wrong_dose_count": cwd_count,
        "false_safe_allergen_count": fsa_count,
        "latency_p50_ms": percentile(latencies, 0.50),
        "latency_p95_ms": percentile(latencies, 0.95),
        "latency_mean_ms": round(statistics.mean(latencies), 1),
        "tokens_in": total_tokens_in,
        "tokens_out": total_tokens_out,
        "tokens_thinking": total_tokens_thinking,
    }

    report = sanitize_obj(
        {
            "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "model": MODEL_NAME,
            "strength_min_conf": STRENGTH_MIN_CONF,
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
        description="Open-ear spoken verdict comprehension, brevity, and EU MDR pharmacist-handoff benchmark"
    )
    parser.add_argument(
        "--out",
        type=pathlib.Path,
        default=DEFAULT_OUT_JSON,
        help="Path to write spoken_verdict_clarity_results.json",
    )
    args = parser.parse_args(argv)
    report = run_benchmark(args.out)
    print(json.dumps(report["summary"], indent=2))
    s = report["summary"]
    if (
        s["n_cases"] != 16
        or s["verdict_accuracy"] < 1.0
        or s["headline_word_cap_pass_rate"] != 1.0
        or s["speech_sentence_cap_pass_rate"] != 1.0
        or s["zero_em_dash_rate"] != 1.0
        or s["confident_wrong_dose_count"] != 0
        or s["false_safe_allergen_count"] != 0
    ):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
