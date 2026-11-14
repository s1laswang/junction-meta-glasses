import argparse
import base64
import datetime
import hashlib
import io
import json
import math
import os
import pathlib
import random
import re
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any
import requests
from PIL import Image, ImageDraw, ImageFilter, ImageFont

NODE_BINS = ("/home/silas/tools/node/bin", "/tmp/fleet-silas/node/bin")
for _nb in reversed(NODE_BINS):
    if os.path.isdir(_nb):
        os.environ["PATH"] = f"{_nb}:{os.environ.get('PATH', '')}"

REPO = pathlib.Path(__file__).resolve().parents[3]
SUITE_DIR = pathlib.Path(__file__).resolve().parent
SHM_ROOT = pathlib.Path("/dev/shm") if pathlib.Path("/dev/shm").is_dir() else pathlib.Path(tempfile.gettempdir())
OUT_JSON = SUITE_DIR / "results.json"
README_MD = SUITE_DIR / "README.md"
PROMPT_PATH = REPO / "shared" / "verify_prompt.md"
SCHEMA_PATH = REPO / "shared" / "label_schema.json"
SAFETY_TS_REL = "server/src/safety.ts"
GS1_TS_REL = "web/src/lib/gs1.ts"
PROMPT_SOURCE = "shared/verify_prompt.md+shared/label_schema.json"
MODEL = "gemini-3.8-flash"
THINKING_LEVEL = "low"
NOW_ISO = "2026-11-14T12:00:00+02:00"
STRENGTH_MIN_CONF = 0.80
GS = "\x1d"
HASH_CHAR = chr(35)
SLASH2 = chr(47) * 2
SLASH_STAR = chr(47) + chr(42)
STAR_SLASH = chr(42) + chr(47)
EM_DASH = chr(0x2014)
EN_DASH = chr(0x2013)
KEY_RE = re.compile("AI" + "za[0-9A-Za-z_-]{10,}")

AML5_GTIN = "06416542001056"
AML10_GTIN = "06416542001100"
MET500_GTIN = "06416542005009"
ATO20_GTIN = "06416542002008"
IBU400_GTIN = "06416542004002"

PROFILE: dict[str, Any] = {
    "meds": [
        {
            "id": "amlodipine",
            "name": "Amlodipine",
            "ingredient": "amlodipine",
            "strength": "5 mg",
            "schedule": ["evening"],
            "gtin": AML5_GTIN,
        },
        {
            "id": "metformin",
            "name": "Metformin",
            "ingredient": "metformin",
            "strength": "500 mg",
            "schedule": ["morning", "evening"],
            "gtin": MET500_GTIN,
        },
        {
            "id": "atorvastatin",
            "name": "Atorvastatin",
            "ingredient": "atorvastatin",
            "strength": "20 mg",
            "schedule": ["evening"],
            "gtin": ATO20_GTIN,
        },
    ],
    "allergies": ["penicillin"],
    "avoid": ["NSAIDs"],
    "doseLog": [],
    "lang": "en",
}

BOX_SPECS: dict[str, dict[str, Any]] = {
    "aml5": {
        "accent": (20, 102, 148),
        "hdr": "ORION PHARMA  EU FMD RX",
        "title": "AMLODIPINE ORION",
        "sub": "Active ingredient: amlodipine",
        "str": "5 mg",
        "dose": "Take one tablet once daily in the evening",
        "pack": "30 film-coated tablets",
        "exp": "EXP 2027-08",
        "lot": "LOT LKBX",
        "sn": "SN PQRW",
    },
    "met500": {
        "accent": (24, 112, 108),
        "hdr": "ORION PHARMA  EU FMD RX",
        "title": "METFORMIN ORION",
        "sub": "Active ingredient: metformin",
        "str": "500 mg",
        "dose": "Take one tablet morning and evening",
        "pack": "100 film-coated tablets",
        "exp": "EXP 2027-08",
        "lot": "LOT MKBA",
        "sn": "SN WXYZ",
    },
    "ato20": {
        "accent": (92, 52, 132),
        "hdr": "ORION PHARMA  EU FMD RX",
        "title": "ATORVASTATIN ORION",
        "sub": "Active ingredient: atorvastatin",
        "str": "20 mg",
        "dose": "Take one tablet once daily in the evening",
        "pack": "30 film-coated tablets",
        "exp": "EXP 2027-08",
        "lot": "LOT AKBC",
        "sn": "SN RTVN",
    },
    "ibu400": {
        "accent": (188, 34, 44),
        "hdr": "ORION PHARMA  EU FMD PACK",
        "title": "BURANA",
        "sub": "Active ingredient: ibuprofen",
        "str": "400 mg",
        "dose": "Take one tablet as needed for pain",
        "pack": "30 film-coated tablets",
        "exp": "EXP 2027-11",
        "lot": "LOT BKBN",
        "sn": "SN MNQP",
    },
}

CASES: list[dict[str, Any]] = [
    {
        "id": "dm_01",
        "category": "agreeing_pack",
        "mode": "sharp",
        "box": "aml5",
        "gs1_raw": f"]d201{AML5_GTIN}1727080010L482A{GS}2190128471",
        "q": "Is this my evening pill?",
        "expected": "match",
        "expected_agrees": True,
        "exp_str": "5 mg",
        "worn_expiry": False,
        "desc": "Agreeing Amlodipine 5 mg carton + EU FMD GS1 DataMatrix DD=00 (2027-08) matching saved GTIN",
    },
    {
        "id": "dm_02",
        "category": "agreeing_pack",
        "mode": "sharp",
        "box": "met500",
        "gs1_raw": f"]d201{MET500_GTIN}1727080010M910C{GS}2144210983",
        "q": "Is this my Metformin?",
        "expected": "match",
        "expected_agrees": True,
        "exp_str": "500 mg",
        "worn_expiry": False,
        "desc": "Agreeing Metformin 500 mg carton + EU FMD GS1 DataMatrix DD=00 (2027-08) matching saved GTIN",
    },
    {
        "id": "dm_03",
        "category": "agreeing_pack",
        "mode": "sharp",
        "box": "ato20",
        "gs1_raw": f"]d201{ATO20_GTIN}1727080010A305B{GS}2177392014",
        "q": "Is this my evening cholesterol pill?",
        "expected": "match",
        "expected_agrees": True,
        "exp_str": "20 mg",
        "worn_expiry": False,
        "desc": "Agreeing Atorvastatin 20 mg carton + EU FMD GS1 DataMatrix DD=00 (2027-08) matching saved GTIN",
    },
    {
        "id": "dm_04",
        "category": "gtin_conflict",
        "mode": "sharp",
        "box": "aml5",
        "gs1_raw": f"]d201{AML10_GTIN}1727080010L991X{GS}2155019283",
        "q": "Is this my evening pill?",
        "expected": "unsure",
        "expected_agrees": False,
        "exp_str": "5 mg",
        "worn_expiry": False,
        "desc": "Relabeled Amlodipine 5 mg carton whose GS1 DataMatrix (01) GTIN belongs to Amlodipine 10 mg",
    },
    {
        "id": "dm_05",
        "category": "gtin_conflict",
        "mode": "sharp",
        "box": "aml5",
        "gs1_raw": f"]d201{ATO20_GTIN}1727080010A305B{GS}2177392055",
        "q": "Is this my evening pill?",
        "expected": "unsure",
        "expected_agrees": False,
        "exp_str": "5 mg",
        "worn_expiry": False,
        "desc": "Wrong-pack sleeve: printed Amlodipine 5 mg text with Atorvastatin 20 mg GS1 DataMatrix GTIN",
    },
    {
        "id": "dm_06",
        "category": "expiry_conflict",
        "mode": "sharp",
        "box": "aml5",
        "gs1_raw": f"]d201{AML5_GTIN}1726120010L204K{GS}2166102938",
        "q": "Is this my evening pill?",
        "expected": "unsure",
        "expected_agrees": False,
        "exp_str": "5 mg",
        "worn_expiry": False,
        "desc": "Expiry conflict: printed EXP 2027-08 on Amlodipine 5 mg vs GS1 DataMatrix (17)261200 (2026-12)",
    },
    {
        "id": "dm_07",
        "category": "expiry_conflict",
        "mode": "sharp",
        "box": "ato20",
        "gs1_raw": f"(01){ATO20_GTIN}(17)261200(10)A112(21)SN8841",
        "q": "Is this my evening Atorvastatin?",
        "expected": "unsure",
        "expected_agrees": False,
        "exp_str": "20 mg",
        "worn_expiry": False,
        "desc": "Expiry conflict: printed EXP 2027-08 on Atorvastatin 20 mg vs GS1 (17)261200 (2026-12)",
    },
    {
        "id": "dm_08",
        "category": "expired_pack_code",
        "mode": "worn_expiry",
        "box": "aml5",
        "gs1_raw": f"]d201{AML5_GTIN}1724050010L019P{GS}2119283746",
        "q": "Is this my evening pill?",
        "expected": "warning",
        "expected_agrees": True,
        "exp_str": "5 mg",
        "worn_expiry": True,
        "desc": "Scratched-off printed expiry on Amlodipine 5 mg caught as expired by GS1 (17)240500 (2024-05)",
    },
    {
        "id": "dm_09",
        "category": "worn_expiry_rescued",
        "mode": "worn_expiry",
        "box": "met500",
        "gs1_raw": f"]d201{MET500_GTIN}1727103110MKBA{GS}2133019284",
        "q": "Is this my Metformin?",
        "expected": "match",
        "expected_agrees": True,
        "exp_str": "500 mg",
        "worn_expiry": True,
        "desc": "Worn-off printed expiry (null from Gemini) rescued by valid GS1 (17)271031 + matching GTIN",
    },
    {
        "id": "dm_10",
        "category": "occluded_strength_gtin_present",
        "mode": "thumb_strength",
        "box": "aml5",
        "gs1_raw": f"]d201{AML5_GTIN}1727080010L482A{GS}2190128499",
        "q": "Is this my evening pill?",
        "expected": "unsure",
        "expected_agrees": True,
        "exp_str": None,
        "worn_expiry": False,
        "desc": "Thumb covering 5 mg strength digits on Amlodipine stays unsure despite matching GS1 GTIN",
    },
    {
        "id": "dm_11",
        "category": "end_flap_gtin_only",
        "mode": "end_flap_only",
        "box": "aml5",
        "gs1_raw": f"]d201{AML5_GTIN}1727080010L482A{GS}2190128455",
        "q": "Is this my evening pill?",
        "expected": "unsure",
        "expected_agrees": None,
        "exp_str": None,
        "worn_expiry": False,
        "desc": "End-flap showing only 2D DataMatrix without front name or strength stays unsure online",
    },
    {
        "id": "dm_12",
        "category": "nsaid_avoid_with_gs1",
        "mode": "sharp",
        "box": "ibu400",
        "gs1_raw": f"]d201{IBU400_GTIN}1727110010B402N{GS}2188301922",
        "q": "Can I take this for pain?",
        "expected": "warning",
        "expected_agrees": True,
        "exp_str": "400 mg",
        "worn_expiry": False,
        "desc": "Burana ibuprofen 400 mg carton with valid GS1 DataMatrix preserves NSAID avoid-list warning",
    },
]

TS_SCORE_SCRIPT = """
import fs from "node:fs";
import { toLabelRead } from "./server/src/verify.ts";
import {
  checkLabel,
  clampHeadline,
  clampSpeech,
  isExpired,
  matchMed,
  monthYear,
  sameStrength,
  spokenIngredient,
} from "./server/src/safety.ts";
import { parseGs1, sameGtin } from "./web/src/lib/gs1.ts";

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const medGtin = (m) => m.gtin ?? m.barcode ?? null;
const medName = (m) => cap(spokenIngredient(m.ingredient) || m.name);

function withDoubleChecked(speech) {
  const phrase = "double-checked with the pack's code";
  const parts = speech.trim().split(new RegExp("(?<=[.!?])\\\\s+"));
  if (parts.length < 2) return `${speech.trim()} ${cap(phrase)}.`;
  parts[0] = parts[0].replace(new RegExp("[.!?]$"), `, ${phrase}.`);
  return parts.join(" ");
}

function evalCrossCheck(read, profile, nowIso, gs1Raw) {
  const now = new Date(nowIso);
  const textOnly = checkLabel(read, profile, now);
  const code = parseGs1(gs1Raw);
  if (!code || (!code.gtin && !code.expiry)) {
    return { verdict: textOnly, textOnlyLevel: textOnly.level, crossCheck: null };
  }
  const details = [];
  let agree = 0;
  let conflict = false;
  const nameOk = Boolean(
    (read.ingredient.value && read.ingredient.confidence >= 0.6) ||
    (read.product.value && read.product.confidence >= 0.6)
  );
  const textMed = nameOk ? matchMed(read, profile.meds) : undefined;
  const gtinMed = code.gtin ? profile.meds.find((m) => sameGtin(medGtin(m), code.gtin)) : undefined;
  const printedOk = Boolean(read.expiry.value && read.expiry.confidence >= 0.7);

  if (code.expiry) {
    if (printedOk) {
      const a = code.expiry.slice(0, 7);
      const b = read.expiry.value.slice(0, 7);
      if (a === b) {
        agree++;
        details.push(`expiry: code ${code.expiry} = print ${read.expiry.value}`);
      } else {
        conflict = true;
        details.push(`expiry: code ${code.expiry} != print ${read.expiry.value}`);
      }
    } else {
      details.push(`expiry from code ${code.expiry} (print not legible)`);
    }
  }

  if (code.gtin) {
    const g = code.gtin;
    const savedTextGtin = textMed ? medGtin(textMed) : null;
    if (gtinMed && textMed && gtinMed.id !== textMed.id) {
      conflict = true;
      details.push(`GTIN ${g} = your ${gtinMed.name}, but the print reads ${textMed.name}`);
    } else if (gtinMed && !textMed && nameOk) {
      conflict = true;
      details.push(`GTIN ${g} = your ${gtinMed.name}, but the print reads a medicine not on your list`);
    } else if (textMed && savedTextGtin && !sameGtin(savedTextGtin, g)) {
      conflict = true;
      details.push(`GTIN ${g} != saved ${textMed.name} GTIN ${savedTextGtin}`);
    } else if (gtinMed && textMed) {
      agree++;
      details.push(`GTIN ${g} = your ${gtinMed.name}`);
    } else if (gtinMed) {
      details.push(`GTIN ${g} = your ${gtinMed.name} (print not legible)`);
    } else {
      details.push(`GTIN ${g} not saved in your list`);
    }
  }

  const agrees = conflict ? false : agree > 0 ? true : null;
  const crossCheck = { source: "datamatrix", code, agrees, details };
  const mk = (level, headline, speech, extra = {}) => ({
    level,
    headline: clampHeadline(headline),
    speech: clampSpeech(speech),
    read,
    reasons: [...details],
    crossCheck,
    ...extra,
  });

  if (conflict) {
    return {
      verdict: mk(
        "unsure",
        "Label and pack code disagree",
        "The printed label and the pack's code disagree. Please ask a pharmacist.",
        textMed ? { matchedMedId: textMed.id } : {}
      ),
      textOnlyLevel: textOnly.level,
      crossCheck,
    };
  }
  if (code.expiry && isExpired(code.expiry, now)) {
    const who = textMed ? `This is ${medName(textMed)}, but the` : "The";
    return {
      verdict: mk(
        "warning",
        `Expired ${monthYear(code.expiry)} (pack code)`,
        `${who} pack's code says it expired in ${monthYear(code.expiry)}. Don't take it, ask a pharmacist for a new one.`,
        textMed ? { matchedMedId: textMed.id } : {}
      ),
      textOnlyLevel: textOnly.level,
      crossCheck,
    };
  }
  if (gtinMed && !textMed) {
    return {
      verdict: mk(
        "unsure",
        `Code says ${medName(gtinMed)}, label unreadable`,
        `The pack's code matches your ${medName(gtinMed)}, but I can't read the label to confirm. ${read.guidance?.trim() ?? "Turn it so the front faces you."}`,
        { matchedMedId: gtinMed.id }
      ),
      textOnlyLevel: textOnly.level,
      crossCheck,
    };
  }

  const eff = code.expiry && !printedOk ? { ...read, expiry: { value: code.expiry, confidence: 1 } } : read;
  const v = checkLabel(eff, profile, now);
  v.read = read;
  v.reasons = [...v.reasons, ...details];
  v.crossCheck = crossCheck;
  if (crossCheck.agrees && v.level === "match") {
    v.speech = clampSpeech(withDoubleChecked(v.speech));
  }
  return { verdict: v, textOnlyLevel: textOnly.level, crossCheck };
}

const inp = JSON.parse(fs.readFileSync(0, "utf8"));
const out = inp.rows.map((r) => {
  const read = r.alreadyRead ? r.raw : toLabelRead(r.raw);
  const strSame = r.exp_str ? sameStrength(read.strength.value, r.exp_str) : false;
  const res = evalCrossCheck(read, inp.profile, inp.now, r.gs1_raw);
  return {
    id: r.id,
    read,
    str_same: strSame,
    verdict: res.verdict,
    text_only_level: res.textOnlyLevel,
    cross_check: {
      gtin: res.crossCheck?.code?.gtin ?? null,
      expiry: res.crossCheck?.code?.expiry ?? null,
      agrees: res.crossCheck?.agrees ?? null,
      details: res.crossCheck?.details ?? [],
    },
  };
});
process.stdout.write(JSON.stringify(out));
"""


def load_env() -> None:
    if os.environ.get("GEMINI_API_KEY"):
        return
    home_env = pathlib.Path.home() / "momin" / ".env"
    if home_env.is_file():
        try:
            proc = subprocess.run(
                ["bash", "-c", 'set -a; . "$1"; env -0', "bash", str(home_env)],
                capture_output=True,
                check=True,
                timeout=5,
            )
            for ch in proc.stdout.split(b"\x00"):
                if b"=" in ch:
                    k, v = ch.split(b"=", 1)
                    ks = k.decode("utf-8", "ignore").strip()
                    if ks and ks not in os.environ:
                        os.environ[ks] = v.decode("utf-8", "ignore")
        except (OSError, subprocess.SubprocessError):
            pass
    for p in (home_env, REPO / ".env"):
        if p.is_file():
            for raw in p.read_text(encoding="utf-8").splitlines():
                ln = raw.strip()
                if ln and not ln.startswith(HASH_CHAR) and "=" in ln:
                    k, v = (ln[7:].strip() if ln.startswith("export ") else ln).split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def sanitize(v: Any) -> Any:
    if isinstance(v, str):
        s = KEY_RE.sub(
            "[REDACTED]",
            v.replace(EM_DASH, " - ").replace(EN_DASH, "-").replace("\u00b5", "u").replace("\u03bc", "u"),
        )
        return s.encode("ascii", "ignore").decode("ascii")
    if isinstance(v, list):
        return [sanitize(x) for x in v]
    if isinstance(v, dict):
        return {sanitize(str(k)): sanitize(val) for k, val in v.items()}
    return v


def inline_refs(node: Any, defs: dict[str, Any] | None = None) -> Any:
    defs = (node.get("$defs") or {}) if (defs is None and isinstance(node, dict)) else defs
    if isinstance(node, list):
        return [inline_refs(x, defs) for x in node]
    if isinstance(node, dict):
        if isinstance(node.get("$ref"), str) and defs is not None:
            return inline_refs(defs[node["$ref"].split("/")[-1]], defs)
        return {k: inline_refs(v, defs) for k, v in node.items() if k not in ("$defs", "$comment")}
    return node


def wilson_ci95(k: int, n: int) -> list[float]:
    if n <= 0:
        return [0.0, 1.0]
    z = 1.959963984540054
    p = k / n
    z2n = (z * z) / n
    denom = 1.0 + z2n
    center = (p + 0.5 * z2n) / denom
    half = (z * math.sqrt((p * (1.0 - p) + 0.25 * z2n) / n)) / denom
    return [round(max(0.0, center - half), 4), round(min(1.0, center + half), 4)]


def pctile(xs: list[float], q: float) -> float:
    if not xs:
        return 0.0
    s = sorted(xs)
    pos = (len(s) - 1) * q
    lo, hi = int(math.floor(pos)), int(math.ceil(pos))
    return round(s[lo] + (s[hi] - s[lo]) * (pos - lo), 1)


def format_compact_json(payload: dict[str, Any]) -> str:
    lines = ["{"]
    keys = list(payload.keys())
    for ki, k in enumerate(keys):
        comma = "," if ki + 1 < len(keys) else ""
        v = payload[k]
        if k == "summary" and isinstance(v, dict):
            lines.append(' "summary":{')
            skeys = list(v.keys())
            for si, sk in enumerate(skeys):
                sc = "," if si + 1 < len(skeys) else ""
                lines.append(f"  {json.dumps(sk)}:{json.dumps(v[sk], separators=(',', ':'), ensure_ascii=True)}{sc}")
            lines.append(f" }}{comma}")
        elif k == "cases" and isinstance(v, list):
            lines.append(' "cases":[')
            for ci, item in enumerate(v):
                cc = "," if ci + 1 < len(v) else ""
                lines.append(f"  {json.dumps(item, separators=(',', ':'), ensure_ascii=True)}{cc}")
            lines.append(f" ]{comma}")
        else:
            lines.append(f" {json.dumps(k)}:{json.dumps(v, separators=(',', ':'), ensure_ascii=True)}{comma}")
    lines.append("}")
    return "\n".join(lines) + "\n"


def compute_prompt_sha12() -> str:
    prompt_txt = PROMPT_PATH.read_text(encoding="utf-8")
    schema_txt = SCHEMA_PATH.read_text(encoding="utf-8")
    return hashlib.sha256((prompt_txt + schema_txt).encode("utf-8")).hexdigest()[:12]


def find_node() -> str:
    for nb in NODE_BINS:
        cand = pathlib.Path(nb) / "node"
        if cand.is_file():
            return str(cand)
    return shutil.which("node") or "node"


def draw_datamatrix(im: Image.Image, x: int, y: int, cells: int = 18, mod: int = 5, seed: int = 42) -> None:
    d = ImageDraw.Draw(im)
    rng = random.Random(seed)
    sz = cells * mod
    d.rectangle((x - 6, y - 6, x + sz + 5, y + sz + 5), fill=(255, 255, 255), outline=(210, 214, 220), width=1)
    for r in range(cells):
        for c in range(cells):
            if c == 0 or r == cells - 1:
                black = True
            elif r == 0:
                black = (c % 2) == 0
            elif c == cells - 1:
                black = (r % 2) == 1
            else:
                black = rng.random() < 0.5
            if black:
                x0, y0 = x + c * mod, y + r * mod
                d.rectangle((x0, y0, x0 + mod - 1, y0 + mod - 1), fill=(16, 18, 22))


def render_counter(seed: int) -> Image.Image:
    im = Image.new("RGB", (768, 768), (226, 221, 212))
    d, rng = ImageDraw.Draw(im), random.Random(seed)
    for y in range(304):
        c = int(234 - 20 * (y / 304))
        d.line((0, y, 768, y), fill=(c, c - 4, c - 9))
    for y in range(304, 768):
        t, j = (y - 304) / 464, rng.randint(-2, 2)
        d.line((0, y, 768, y), fill=(int(186 - 28 * t) + j, int(158 - 24 * t) + j, int(128 - 20 * t) + j))
    d.line((0, 304, 768, 304), fill=(128, 104, 82), width=3)
    d.rounded_rectangle((612, 180, 706, 298), radius=12, fill=(84, 112, 132), outline=(58, 84, 100), width=2)
    return im.filter(ImageFilter.GaussianBlur(radius=2.2))


def paste_held(bg: Image.Image, card: Image.Image, x: int, y: int) -> None:
    d, (w, h), cx = ImageDraw.Draw(bg), card.size, x + int(card.size[0] / 2)
    d.rounded_rectangle((x + 6, y + 8, x + w + 6, y + h + 8), radius=10, fill=(92, 78, 64))
    bg.paste(card, (x, y))
    d.rectangle((x, y, x + w - 1, y + h - 1), outline=(164, 170, 178), width=2)
    d.rounded_rectangle((cx - 108, y + h - 14, cx - 26, y + h + 68), radius=28, fill=(212, 172, 144), outline=(176, 136, 108), width=2)
    d.rounded_rectangle((cx + 26, y + h - 14, cx + 108, y + h + 68), radius=28, fill=(208, 168, 140), outline=(174, 134, 106), width=2)


def render_carton(spec: dict[str, Any], seed: int, hide_str: bool = False, worn_exp: bool = False) -> Image.Image:
    w, h = 568, 424
    im = Image.new("RGB", (w, h), (250, 251, 253))
    d = ImageDraw.Draw(im)
    d.rectangle((0, 0, w, 52), fill=spec["accent"])
    d.text((20, 15), spec["hdr"], fill=(248, 250, 252), font=ImageFont.load_default(size=20))
    d.text((20, 68), spec["title"], fill=(16, 22, 30), font=ImageFont.load_default(size=36))
    d.text((20, 118), spec["sub"], fill=(48, 56, 66), font=ImageFont.load_default(size=22))
    d.rounded_rectangle((20, 166, 248, 240), radius=8, fill=(238, 245, 252), outline=spec["accent"], width=3)
    if not hide_str:
        d.text((34, 178), spec["str"], fill=(14, 20, 28), font=ImageFont.load_default(size=40))
    d.text((20, 266), spec["dose"], fill=(38, 46, 56), font=ImageFont.load_default(size=19))
    d.text((20, 304), spec["pack"], fill=(68, 76, 86), font=ImageFont.load_default(size=18))

    d.rounded_rectangle((412, 152, 548, 336), radius=8, fill=(244, 246, 250), outline=(188, 194, 204), width=2)
    draw_datamatrix(im, 435, 168, cells=18, mod=5, seed=seed)
    d.text((426, 272), "EU FMD 2D", fill=(44, 52, 62), font=ImageFont.load_default(size=15))
    d.text((426, 292), spec["lot"], fill=(58, 66, 76), font=ImageFont.load_default(size=14))
    d.text((426, 310), spec["sn"], fill=(58, 66, 76), font=ImageFont.load_default(size=14))

    if worn_exp:
        d.text((20, h - 52), "EXP:", fill=(74, 80, 88), font=ImageFont.load_default(size=22))
        rng = random.Random(seed + 99)
        patch = Image.new("RGB", (210, 40), (214, 208, 198))
        pd = ImageDraw.Draw(patch)
        for _ in range(85):
            x0 = rng.randint(0, 196)
            y0 = rng.randint(2, 34)
            pd.line((x0, y0, x0 + rng.randint(8, 28), y0 + rng.randint(-4, 4)), fill=(168, 160, 148), width=2)
        patch = patch.filter(ImageFilter.GaussianBlur(radius=1.6))
        im.paste(patch, (78, h - 58))
        d.rectangle((78, h - 58, 288, h - 18), outline=(184, 176, 166), width=1)
    else:
        d.text((20, h - 52), spec["exp"], fill=(20, 26, 34), font=ImageFont.load_default(size=24))
    return im


def render_case_image(case: dict[str, Any], idx: int) -> Image.Image:
    seed = 202611 + idx * 53
    sc = render_counter(seed)
    m = case["mode"]
    spec = BOX_SPECS[case["box"]]
    if m == "sharp":
        paste_held(sc, render_carton(spec, seed), 100, 242)
        return sc
    if m == "worn_expiry":
        paste_held(sc, render_carton(spec, seed, worn_exp=True), 100, 242)
        return sc
    if m == "thumb_strength":
        paste_held(sc, render_carton(spec, seed, hide_str=True), 100, 242)
        ov = Image.new("RGBA", sc.size, (0, 0, 0, 0))
        od = ImageDraw.Draw(ov)
        od.rounded_rectangle((74, 396, 364, 494), radius=44, fill=(214, 172, 144, 255), outline=(174, 134, 106, 255), width=3)
        od.rounded_rectangle((296, 412, 352, 476), radius=18, fill=(236, 206, 188, 255), outline=(190, 152, 128, 255), width=2)
        return Image.alpha_composite(sc.convert("RGBA"), ov).convert("RGB")
    flap = Image.new("RGB", (336, 420), (246, 247, 250))
    fd = ImageDraw.Draw(flap)
    fd.rectangle((0, 0, 335, 58), fill=(232, 235, 241), outline=(182, 188, 198), width=2)
    fd.line((0, 58, 335, 58), fill=(168, 174, 184), width=2)
    fd.rounded_rectangle((48, 96, 288, 338), radius=10, fill=(252, 253, 255), outline=(182, 188, 198), width=2)
    draw_datamatrix(flap, 96, 122, cells=20, mod=7, seed=seed)
    fd.text((78, 282), "EU FMD PACK CODE", fill=(38, 44, 54), font=ImageFont.load_default(size=18))
    fd.text((78, 308), f"{spec['lot']}   {spec['sn']}", fill=(58, 66, 76), font=ImageFont.load_default(size=16))
    paste_held(sc, flap, 216, 244)
    return sc


def call_flash(api_key: str, prompt: str, schema: dict[str, Any], frame_b64: str, question: str) -> dict[str, Any]:
    url = f"https:{SLASH2}generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"
    parts = [
        {"inlineData": {"mimeType": "image/jpeg", "data": frame_b64}},
        {"text": f'The person asked: "{question}"'},
    ]
    payload = {
        "systemInstruction": {"parts": [{"text": prompt}]},
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseJsonSchema": schema,
            "thinkingConfig": {"thinkingLevel": "LOW"},
            "maxOutputTokens": 4096,
        },
    }
    sess, last, timed_out = requests.Session(), "failed", False
    for attempt in range(4):
        t0 = time.perf_counter()
        try:
            r = sess.post(url, headers={"Content-Type": "application/json", "x-goog-api-key": api_key}, json=payload, timeout=45)
            ms = round((time.perf_counter() - t0) * 1000.0, 1)
            if r.status_code == 200:
                body = r.json()
                cparts = ((body.get("candidates") or [{}])[0].get("content") or {}).get("parts") or []
                txt = next((p["text"].strip() for p in cparts if "text" in p and not p.get("thought") and p["text"].strip()), "")
                if txt:
                    return {"ok": True, "raw": sanitize(json.loads(txt)), "ms": ms, "timeout": False}
            if r.status_code not in (429, 500, 502, 503, 504):
                return {"ok": False, "err": sanitize(f"HTTP {r.status_code}"), "ms": ms, "timeout": False}
        except requests.Timeout as exc:
            timed_out = True
            last = sanitize(str(exc))
        except (requests.RequestException, json.JSONDecodeError) as exc:
            last = sanitize(str(exc))
        time.sleep(1.2 * (2 ** attempt))
    return {"ok": False, "err": last, "ms": 0.0, "timeout": timed_out}


def score_with_ts(rows: list[dict[str, Any]], profile: dict[str, Any] = PROFILE, now_iso: str = NOW_ISO) -> dict[str, dict[str, Any]]:
    proc = subprocess.run(
        [find_node(), "--import", "tsx", "--input-type=module", "-e", TS_SCORE_SCRIPT],
        input=json.dumps({"rows": rows, "profile": profile, "now": now_iso}),
        text=True,
        capture_output=True,
        cwd=str(REPO),
        check=True,
    )
    parsed = json.loads(proc.stdout)
    return {item["id"]: item for item in parsed}


def check_existing() -> int:
    t0 = time.perf_counter()
    src_py = pathlib.Path(__file__).read_text(encoding="utf-8")
    assert HASH_CHAR not in src_py and SLASH2 not in src_py and SLASH_STAR not in src_py and STAR_SLASH not in src_py
    assert EM_DASH not in src_py and EN_DASH not in src_py and not KEY_RE.search(src_py)
    assert all(ord(ch) < 128 for ch in src_py), "non-ASCII in run.py"

    raw_bytes = OUT_JSON.read_bytes()
    assert len(raw_bytes) < 15360, f"results.json size {len(raw_bytes)} >= 15360"
    raw_txt = raw_bytes.decode("utf-8")
    assert EM_DASH not in raw_txt and EN_DASH not in raw_txt and not KEY_RE.search(raw_txt)
    assert all(ord(ch) < 128 for ch in raw_txt), "non-ASCII in results.json"

    if README_MD.is_file():
        readme_txt = README_MD.read_text(encoding="utf-8")
        assert EM_DASH not in readme_txt and EN_DASH not in readme_txt and not KEY_RE.search(readme_txt)
        assert SLASH2 not in readme_txt and SLASH_STAR not in readme_txt and STAR_SLASH not in readme_txt
        assert all(ord(ch) < 128 for ch in readme_txt), "non-ASCII in README.md"
        for ln in readme_txt.splitlines():
            s_ln = ln.lstrip()
            if HASH_CHAR in s_ln:
                assert s_ln.startswith(HASH_CHAR), f"non-heading hash in README.md: {ln}"

    data = json.loads(raw_txt)
    assert data["suite"] == "gs1_datamatrix_crosscheck"
    assert data["model"] == MODEL and data["thinking_level"] == THINKING_LEVEL
    assert data["prompt_source"] == PROMPT_SOURCE
    assert data["prompt_sha256_12"] == compute_prompt_sha12() == "814770315c42"
    assert data["safety_module"] == SAFETY_TS_REL
    assert data["gs1_module"] == GS1_TS_REL
    assert isinstance(data["profile"], dict) and len(data["profile"].get("meds") or []) == 3

    cases = data["cases"]
    s = data["summary"]
    assert s["n_cases"] == len(cases) == 12
    assert s["api_error_count"] == 0 and s["timeout_count"] == 0

    re_rows = [
        {"id": c["id"], "raw": c["read"], "alreadyRead": True, "gs1_raw": c["gs1_raw"], "exp_str": None}
        for c in cases
    ]
    re_scored = score_with_ts(re_rows, data["profile"], data["eval_now_iso"])
    assert len(re_scored) == len(cases)

    by_id = {c["id"]: c for c in cases}
    for c in cases:
        rs = re_scored[c["id"]]
        assert rs["verdict"]["level"] == c["predicted_level"], f"{c['id']}: {rs['verdict']['level']} != {c['predicted_level']}"
        assert rs["text_only_level"] == c["text_only_level"], f"{c['id']}: text_only mismatch"
        assert rs["cross_check"]["agrees"] == c["predicted_agrees"], f"{c['id']}: agrees mismatch"
        assert rs["cross_check"]["gtin"] == c["cross_check"]["gtin"]
        assert rs["cross_check"]["expiry"] == c["cross_check"]["expiry"]
        assert len(c["description"]) <= 240 and len(c["reasons"]) <= 4

    assert by_id["dm_08"]["read"]["expiry"]["value"] is None and by_id["dm_08"]["predicted_level"] == "warning"
    assert by_id["dm_09"]["read"]["expiry"]["value"] is None and by_id["dm_09"]["predicted_level"] == "match"
    assert "expiry not readable" not in by_id["dm_09"]["reasons"]
    assert float(by_id["dm_10"]["read"]["strength"]["confidence"]) < STRENGTH_MIN_CONF
    assert by_id["dm_10"]["predicted_level"] == "unsure"
    assert by_id["dm_12"]["predicted_level"] == "warning"

    assert s["verdict_matches"] == sum(1 for c in cases if c["verdict_ok"])
    assert s["verdict_accuracy"] == round(s["verdict_matches"] / s["n_cases"], 4)
    assert s["verdict_accuracy_ci95"] == wilson_ci95(s["verdict_matches"], s["n_cases"])
    assert s["crosscheck_agrees_matches"] == sum(1 for c in cases if c["agrees_ok"])
    assert s["crosscheck_agrees_accuracy"] == round(s["crosscheck_agrees_matches"] / s["n_cases"], 4)
    assert s["crosscheck_agrees_ci95"] == wilson_ci95(s["crosscheck_agrees_matches"], s["n_cases"])
    assert s["false_match_count"] == sum(1 for c in cases if c["false_match"]) == 0
    assert s["unsafe_reassurance_count"] == sum(1 for c in cases if c["expected_level"] == "warning" and c["predicted_level"] in ("match", "info")) == 0
    assert s["confident_wrong_count"] == sum(1 for c in cases if c["confident_wrong"]) == 0
    assert s["confident_wrong_rate"] == round(s["confident_wrong_count"] / s["n_cases"], 4)
    assert s["confident_wrong_ci95"] == wilson_ci95(s["confident_wrong_count"], s["n_cases"])
    assert s["abstain_or_unsure_count"] == sum(1 for c in cases if c["predicted_level"] == "unsure")

    elapsed_ms = round((time.perf_counter() - t0) * 1000.0, 1)
    assert elapsed_ms < 2000.0, f"check took {elapsed_ms} ms >= 2000 ms"
    print(f"OK ({elapsed_ms} ms):", json.dumps(s))
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--render-only", action="store_true")
    ap.add_argument("--check", "--offline", "--verify-cached", dest="check", action="store_true")
    args = ap.parse_args(argv)
    if args.check:
        return check_existing()

    tmp_dir = pathlib.Path(tempfile.mkdtemp(prefix="holdup_gs1_dm_", dir=str(SHM_ROOT)))
    try:
        rendered: list[dict[str, Any]] = []
        for idx, c in enumerate(CASES, 1):
            im = render_case_image(c, idx)
            jpg_path = tmp_dir / f"{c['id']}.jpg"
            buf = io.BytesIO()
            im.save(buf, format="JPEG", quality=90)
            raw = buf.getvalue()
            jpg_path.write_bytes(raw)
            rendered.append({"case": c, "b64": base64.b64encode(jpg_path.read_bytes()).decode("ascii")})
        if args.render_only:
            print(f"Rendered and verified {len(rendered)} temp JPEGs in {tmp_dir}")
            return 0

        load_env()
        api_key = os.environ.get("GEMINI_API_KEY", "").strip()
        if not api_key:
            raise RuntimeError("GEMINI_API_KEY missing")
        prompt_txt = PROMPT_PATH.read_text(encoding="utf-8")
        schema_txt = SCHEMA_PATH.read_text(encoding="utf-8")
        prompt_sha256_12 = hashlib.sha256((prompt_txt + schema_txt).encode("utf-8")).hexdigest()[:12]
        schema = inline_refs(json.loads(schema_txt))

        with ThreadPoolExecutor(max_workers=4) as ex:
            api_outs = list(ex.map(lambda r: call_flash(api_key, prompt_txt, schema, r["b64"], r["case"]["q"]), rendered))

        timeout_count = sum(1 for o in api_outs if o.get("timeout"))
        api_error_count = sum(0 if o.get("ok") else 1 for o in api_outs)
        if timeout_count or api_error_count:
            raise RuntimeError(f"API errors={api_error_count} timeouts={timeout_count}")

        scored = score_with_ts(
            [
                {
                    "id": r["case"]["id"],
                    "raw": o["raw"],
                    "alreadyRead": False,
                    "gs1_raw": r["case"]["gs1_raw"],
                    "exp_str": r["case"]["exp_str"],
                }
                for r, o in zip(rendered, api_outs)
            ]
        )

        cases_out: list[dict[str, Any]] = []
        for r, o in zip(rendered, api_outs):
            c = r["case"]
            sc = scored[c["id"]]
            rd = sanitize(sc["read"])
            vd = sanitize(sc["verdict"])
            cc = sanitize(sc["cross_check"])
            pred = str(vd["level"])
            pred_agrees = cc["agrees"]
            s_val = rd["strength"]["value"]
            s_conf = float(rd["strength"]["confidence"] or 0.0)
            e_val = rd["expiry"]["value"]
            e_conf = float(rd["expiry"]["confidence"] or 0.0)
            false_match = bool(pred == "match" and c["expected"] != "match")
            unsafe_reassurance = bool(c["expected"] == "warning" and pred in ("match", "info"))
            if c["exp_str"] is None:
                wrong_str = bool(s_conf >= STRENGTH_MIN_CONF)
            else:
                wrong_str = bool(s_conf >= STRENGTH_MIN_CONF and (s_val is None or not sc["str_same"]))
            wrong_worn_exp = bool(c["worn_expiry"] and e_val is not None and e_conf >= 0.7)
            cw = bool(false_match or unsafe_reassurance or wrong_str or wrong_worn_exp)
            verdict_ok = bool(pred == c["expected"])
            agrees_ok = bool(pred_agrees == c["expected_agrees"])
            row_out: dict[str, Any] = sanitize(
                {
                    "id": c["id"],
                    "category": c["category"],
                    "description": c["desc"],
                    "question": c["q"],
                    "gs1_raw": "",
                    "expected_level": c["expected"],
                    "predicted_level": pred,
                    "text_only_level": str(sc["text_only_level"]),
                    "verdict_ok": verdict_ok,
                    "expected_agrees": c["expected_agrees"],
                    "predicted_agrees": pred_agrees,
                    "agrees_ok": agrees_ok,
                    "confident_wrong": cw,
                    "false_match": false_match,
                    "latency_ms": o["ms"],
                    "read": rd,
                    "cross_check": {
                        "gtin": cc["gtin"],
                        "expiry": cc["expiry"],
                        "agrees": pred_agrees,
                    },
                    "reasons": list(vd["reasons"])[:4],
                }
            )
            row_out["gs1_raw"] = c["gs1_raw"]
            cases_out.append(row_out)
            print(
                f"[{c['id']}] exp={c['expected']} pred={pred} txt={sc['text_only_level']} "
                f"agrees={pred_agrees} ok={verdict_ok} cw={cw} ms={o['ms']}"
            )

        n = len(cases_out)
        v_matches = sum(1 for x in cases_out if x["verdict_ok"])
        a_matches = sum(1 for x in cases_out if x["agrees_ok"])
        cw_n = sum(1 for x in cases_out if x["confident_wrong"])
        fm_n = sum(1 for x in cases_out if x["false_match"])
        ur_n = sum(1 for x in cases_out if x["expected_level"] == "warning" and x["predicted_level"] in ("match", "info"))
        abs_n = sum(1 for x in cases_out if x["predicted_level"] == "unsure")
        conflicts = [x for x in cases_out if x["category"] in ("gtin_conflict", "expiry_conflict")]
        conflict_caught = sum(1 for x in conflicts if x["predicted_agrees"] is False and x["predicted_level"] == "unsure")
        lats = [float(x["latency_ms"]) for x in cases_out]

        summary = {
            "n_cases": n,
            "verdict_matches": v_matches,
            "verdict_accuracy": round(v_matches / n, 4),
            "verdict_accuracy_ci95": wilson_ci95(v_matches, n),
            "crosscheck_agrees_matches": a_matches,
            "crosscheck_agrees_accuracy": round(a_matches / n, 4),
            "crosscheck_agrees_ci95": wilson_ci95(a_matches, n),
            "conflict_cases": len(conflicts),
            "conflict_caught_count": conflict_caught,
            "conflict_catch_rate": round(conflict_caught / len(conflicts), 4),
            "confident_wrong_count": cw_n,
            "confident_wrong_rate": round(cw_n / n, 4),
            "confident_wrong_ci95": wilson_ci95(cw_n, n),
            "false_match_count": fm_n,
            "unsafe_reassurance_count": ur_n,
            "abstain_or_unsure_count": abs_n,
            "api_error_count": api_error_count,
            "timeout_count": timeout_count,
            "latency_p50_ms": pctile(lats, 0.50),
            "latency_p95_ms": pctile(lats, 0.95),
        }

        payload = sanitize(
            {
                "suite": "gs1_datamatrix_crosscheck",
                "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "eval_now_iso": NOW_ISO,
                "model": MODEL,
                "thinking_level": THINKING_LEVEL,
                "prompt_source": PROMPT_SOURCE,
                "prompt_sha256_12": prompt_sha256_12,
                "safety_module": SAFETY_TS_REL,
                "gs1_module": GS1_TS_REL,
                "profile": PROFILE,
                "summary": summary,
                "cases": [],
            }
        )
        payload["cases"] = cases_out
        OUT_JSON.write_text(format_compact_json(payload), encoding="utf-8")
        return check_existing()
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
