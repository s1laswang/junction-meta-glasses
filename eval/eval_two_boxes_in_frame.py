import datetime
import io
import json
import math
import os
import pathlib
import random
import re
import shutil
import statistics
import subprocess
import tempfile
from typing import Any

from PIL import Image, ImageDraw, ImageFilter, ImageFont

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT_IMG_DIR = REPO_ROOT / "eval" / "out" / "two_boxes_in_frame"
OUT_JSON_PATH = REPO_ROOT / "eval" / "two_boxes_in_frame_results.json"

MODEL_NAME = "gemini-3.8-flash"
STRENGTH_MIN_CONF = 0.80
ALLERGEN_MIN_CONF = 0.60
API_KEY_RE = re.compile(r"AIza[0-9A-Za-z_-]{20,}")

CASES: list[dict[str, Any]] = [
    {
        "id": "tb_01",
        "scene_group": "foreground_clutter",
        "question": "Is this my evening pill?",
        "description": "Sharp held foreground Amlodipin 5 mg box filling center frame with blurred distant amber pill bottle and mug on counter",
        "expected_level": "match",
        "accepted_levels": ["match"],
        "strength_readable": True,
        "valid_strengths": ["5 mg"],
        "conflicting_doses": False,
        "has_profile_allergen": False,
        "layout": "foreground_med",
        "clutter_variant": "amber_bottle_and_mug",
        "box_angle": -1.4,
        "accent": (20, 102, 148),
        "header": "ORION PHARMA    Vnr 08 44 12",
        "title": "AMLODIPIN 5 mg",
        "sub_line": "Active ingredient: amlodipine",
        "strength_badge": "5 mg",
        "form_line": "tablets",
        "dosing_line": "1 tablet once daily in the evening",
        "pack_line": "30 tablets",
        "expiry_line": "EXP 2027-10",
    },
    {
        "id": "tb_02",
        "scene_group": "foreground_clutter",
        "question": "Is this my evening pill?",
        "description": "Sharp held foreground Burana 400 mg (ibuprofeeni) box filling center frame with blurred distant pill jar and water glass on counter",
        "expected_level": "warning",
        "accepted_levels": ["warning"],
        "strength_readable": True,
        "valid_strengths": ["400 mg"],
        "conflicting_doses": False,
        "has_profile_allergen": False,
        "layout": "foreground_med",
        "clutter_variant": "white_jar_and_glass",
        "box_angle": 1.5,
        "accent": (188, 34, 44),
        "header": "ORION PHARMA    Vnr 06 14 28",
        "title": "BURANA 400 mg",
        "sub_line": "Vaikuttava aine: ibuprofeeni (ibuprofen)",
        "strength_badge": "400 mg",
        "form_line": "tabletti",
        "dosing_line": "1 tabletti tarvittaessa kipuun",
        "pack_line": "30 tablettia",
        "expiry_line": "EXP 2027-11",
    },
    {
        "id": "tb_03",
        "scene_group": "foreground_clutter",
        "question": "Does this contain nuts?",
        "description": "Sharp held foreground Hazelnut Wafer Bar carton filling center frame with blurred distant amber bottle and tea tin on counter",
        "expected_level": "warning",
        "accepted_levels": ["warning"],
        "strength_readable": None,
        "valid_strengths": [],
        "conflicting_doses": False,
        "has_profile_allergen": True,
        "layout": "foreground_food",
        "clutter_variant": "amber_bottle_and_tin",
        "box_angle": -1.3,
        "accent": (136, 74, 30),
        "header": "NORDIC BAKERY    60 g",
        "title": "Hazelnut Wafer Bar",
        "sub_title": "Crispy Cocoa & Roasted Hazelnut Wafer",
        "ingredients_lines": [
            "Ingredients: wheat flour, roasted hazelnuts (24%),",
            "sugar, cocoa butter, skimmed milk powder, soy lecithin.",
        ],
        "allergen_lines": [
            "Allergens: contains hazelnuts (tree nuts), wheat, milk, soy.",
        ],
        "expiry_line": "Best before: 2027-09-18",
    },
    {
        "id": "tb_04",
        "scene_group": "foreground_clutter",
        "question": "Is this safe with my allergies?",
        "description": "Sharp held foreground Oat Drink carton filling center frame with blurred distant pill bottle and bowl on counter",
        "expected_level": "info",
        "accepted_levels": ["info"],
        "strength_readable": None,
        "valid_strengths": [],
        "conflicting_doses": False,
        "has_profile_allergen": False,
        "layout": "foreground_food",
        "clutter_variant": "bottle_and_bowl",
        "box_angle": 1.2,
        "accent": (42, 114, 84),
        "header": "NORDIC PLANT DAIRY    1 L",
        "title": "Oat Drink",
        "sub_title": "Original Plant-Based Oat Drink  1 L",
        "ingredients_lines": [
            "Ingredients: water, wholegrain oats (10%),",
            "rapeseed oil, sea salt.",
        ],
        "allergen_lines": [
            "Allergens: contains oats (gluten).",
        ],
        "expiry_line": "Best before: 2027-11-24",
    },
    {
        "id": "tb_05",
        "scene_group": "twin_boxes",
        "question": "Is this my evening pill?",
        "description": "Twin white boxes at equal focal plane: prominent Amlodipin 10 mg (wrong strength) beside finger-occluded second white pharmacy box",
        "expected_level": "warning",
        "accepted_levels": ["warning", "unsure"],
        "strength_readable": True,
        "valid_strengths": ["10 mg"],
        "conflicting_doses": True,
        "has_profile_allergen": False,
        "layout": "twin_aml10_plus_occluded",
        "left_box": {
            "accent": (20, 102, 148),
            "header": "ORION PHARMA  Vnr 09 22 41",
            "title": "AMLODIPIN 10 mg",
            "sub_line": "Active ingredient: amlodipine",
            "strength_badge": "10 mg",
            "form_line": "tablets",
            "dosing_line": "1 tablet once daily",
            "pack_line": "30 tablets",
            "expiry_line": "EXP 2027-10",
            "angle": -1.8,
        },
        "right_box": {
            "accent": (20, 102, 148),
            "header": "ORION PHARMA",
            "title": "AMLODIP",
            "sub_line": "tablets",
            "pack_line": "30 tablets",
            "expiry_line": "EXP 2027-10",
            "angle": 2.2,
        },
    },
    {
        "id": "tb_06",
        "scene_group": "twin_boxes",
        "question": "Can I take one of these for pain?",
        "description": "Twin white NSAID boxes held side-by-side at equal focal plane: Burana 400 mg + Ibuprofen 600 mg",
        "expected_level": "warning",
        "accepted_levels": ["warning"],
        "strength_readable": True,
        "valid_strengths": ["400 mg", "600 mg"],
        "conflicting_doses": True,
        "has_profile_allergen": False,
        "layout": "twin_nsaid_conflict",
        "left_box": {
            "accent": (188, 34, 44),
            "header": "ORION PHARMA  Vnr 06 14 28",
            "title": "BURANA 400 mg",
            "sub_line": "ibuprofeeni / ibuprofen",
            "strength_badge": "400 mg",
            "form_line": "tabletti",
            "dosing_line": "1 tabletti kipuun",
            "pack_line": "30 tablettia",
            "expiry_line": "EXP 2027-11",
            "angle": -1.7,
        },
        "right_box": {
            "accent": (156, 28, 52),
            "header": "RATIOPHARM  Vnr 11 40 92",
            "title": "IBUPROFEN 600 mg",
            "sub_line": "Active ingredient: ibuprofen",
            "strength_badge": "600 mg",
            "form_line": "tablets",
            "dosing_line": "1 tablet with water",
            "pack_line": "30 tablets",
            "expiry_line": "EXP 2027-09",
            "angle": 1.9,
        },
    },
    {
        "id": "tb_07",
        "scene_group": "twin_boxes",
        "question": "Is this my evening pill?",
        "description": "Two side-by-side unlabeled edge-on white pharmacy cartons held at equal focal plane with no visible name or strength",
        "expected_level": "unsure",
        "accepted_levels": ["unsure"],
        "strength_readable": False,
        "valid_strengths": [],
        "conflicting_doses": True,
        "has_profile_allergen": False,
        "layout": "twin_unlabeled_edges",
    },
    {
        "id": "tb_08",
        "scene_group": "twin_boxes",
        "question": "Is this my evening pill?",
        "description": "Twin white boxes held side-by-side at equal focal plane: Amlodipin + Metformin both with thumb-covered strengths",
        "expected_level": "unsure",
        "accepted_levels": ["unsure"],
        "strength_readable": False,
        "valid_strengths": [],
        "conflicting_doses": True,
        "has_profile_allergen": False,
        "layout": "twin_thumb_covered_strengths",
        "left_box": {
            "accent": (20, 102, 148),
            "header": "ORION PHARMA  Vnr 08 44 12",
            "title": "AMLODIPIN",
            "sub_line": "Active ingredient: amlodipine",
            "form_line": "tablets",
            "pack_line": "30 tablets",
            "expiry_line": "EXP 2027-10",
            "angle": -1.9,
        },
        "right_box": {
            "accent": (36, 92, 138),
            "header": "ORION PHARMA  Vnr 14 88 05",
            "title": "METFORMIN",
            "sub_line": "Active ingredient: metformin",
            "form_line": "film-coated tablets",
            "pack_line": "100 tablets",
            "expiry_line": "EXP 2027-11",
            "angle": 2.0,
        },
    },
]

TS_VERIFY_RUNNER = """
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import { verify } from "./server/src/verify.ts";
import {
  allergenHits,
  avoidHits,
  checkLabel,
  ingredientsOf,
  sameStrength,
  STRENGTH_MIN_CONF,
} from "./server/src/safety.ts";
import { DEMO_PROFILE } from "./web/src/storage/profileStore.ts";

const proxyUrl = (
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy ||
  ""
).trim();

if (proxyUrl && !http.setGlobalProxyFromEnv) {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    );
    if (url.protocol !== "https:") return origFetch(input, init);
    const headers = {};
    if (init.headers) {
      const h = new Headers(init.headers);
      h.forEach((v, k) => {
        if (k.toLowerCase() !== "accept-encoding") headers[k] = v;
      });
    }
    headers["accept-encoding"] = "identity";
    const bodyBuf = init.body ? Buffer.from(init.body) : undefined;
    if (bodyBuf && !headers["content-length"]) {
      headers["content-length"] = String(bodyBuf.length);
    }
    return await new Promise((resolve, reject) => {
      const req = https.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || 443,
          path: url.pathname + url.search,
          method: init.method || "GET",
          headers,
          agent: https.globalAgent,
          signal: init.signal,
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(Buffer.from(c)));
          res.on("end", () => {
            let rawBuf = Buffer.concat(chunks);
            const enc = String(res.headers["content-encoding"] || "").toLowerCase();
            if (enc === "gzip") rawBuf = zlib.gunzipSync(rawBuf);
            else if (enc === "deflate") rawBuf = zlib.inflateSync(rawBuf);
            else if (enc === "br") rawBuf = zlib.brotliDecompressSync(rawBuf);
            const resHeaders = new Headers();
            for (const [k, v] of Object.entries(res.headers)) {
              if (k.toLowerCase() === "content-encoding" || k.toLowerCase() === "content-length") continue;
              if (Array.isArray(v)) v.forEach((x) => resHeaders.append(k, x));
              else if (typeof v === "string") resHeaders.set(k, v);
            }
            resolve(
              new Response(rawBuf, {
                status: res.statusCode || 500,
                statusText: res.statusMessage || "",
                headers: resHeaders,
              })
            );
          });
        }
      );
      req.on("error", reject);
      if (bodyBuf) req.write(bodyBuf);
      req.end();
    });
  };
}

const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const modelChain = [cfg.modelName];
const results = [];

async function runVerifyWithRetry(frames, profile, question, feature) {
  let last = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    last = await verify(frames, profile, question, feature, {
      chain: modelChain,
      timeoutMs: 35000,
    });
    if (last.model) return last;
    await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
  }
  return last;
}

for (const item of cfg.cases) {
  const buf = fs.readFileSync(item.image_abs);
  const b64 = buf.toString("base64");
  const res = await runVerifyWithRetry([b64], DEMO_PROFILE, item.question, item.id);
  const read = res.verdict.read;
  const directVerdict = checkLabel(read, DEMO_PROFILE);
  if (directVerdict.level !== res.verdict.level) {
    throw new Error(`Parity mismatch on ${item.id}: ${directVerdict.level} vs ${res.verdict.level}`);
  }
  const gotIngredients = [...ingredientsOf(read.ingredient.value, read.product.value)];
  const matchedAllergens = allergenHits(read, DEMO_PROFILE.allergies);
  const matchedAvoid = avoidHits(read, DEMO_PROFILE.avoid);
  const validStrengthHit = Array.isArray(item.valid_strengths) && item.valid_strengths.length > 0
    ? item.valid_strengths.some((vs) => sameStrength(read.strength.value, vs))
    : false;

  results.push({
    id: item.id,
    model: res.model,
    latencyMs: res.latencyMs,
    frames: res.frames,
    verdict: res.verdict,
    gotIngredients,
    matchedAllergens,
    matchedAvoid,
    validStrengthHit,
  });
}

let ledgerRows = [];
if (process.env.LEDGER_PATH && fs.existsSync(process.env.LEDGER_PATH)) {
  const lines = fs.readFileSync(process.env.LEDGER_PATH, "utf8").split("\\n").filter(Boolean);
  ledgerRows = lines.map((ln) => JSON.parse(ln));
}

fs.writeFileSync(
  cfg.outPath,
  JSON.stringify({
    strength_min_conf: STRENGTH_MIN_CONF,
    profile: DEMO_PROFILE,
    results,
    ledger_rows: ledgerRows,
  }),
  "utf8"
);
process.exit(0);
"""


def parse_env_file(env_path: pathlib.Path) -> dict[str, str]:
    parsed: dict[str, str] = {}
    if not env_path.is_file():
        return parsed
    comment_prefix = chr(35)
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith(comment_prefix):
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        if "=" not in line:
            continue
        key, val = line.split("=", 1)
        key = key.strip()
        val = val.strip().strip('"').strip("'")
        if key:
            parsed[key] = val
    return parsed


def build_runner_env(ledger_path: pathlib.Path) -> dict[str, str]:
    nm = REPO_ROOT / "node_modules"
    shared_nm = pathlib.Path("/tmp/fleet-silas/meta-deps/node_modules")
    if not nm.exists() and shared_nm.is_dir():
        nm.symlink_to(shared_nm)

    merged: dict[str, str] = {}
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
                    if k_s:
                        merged[k_s] = v_s
        except (OSError, subprocess.SubprocessError):
            merged.update(parse_env_file(home_env))

    for k, v in parse_env_file(repo_env).items():
        if k not in merged:
            merged[k] = v

    for k, v in os.environ.items():
        merged[k] = v

    extra_bins = ["/tmp/fleet-silas/node/bin", str(pathlib.Path.home() / ".local" / "bin")]
    path_parts = [p for p in extra_bins if os.path.isdir(p)]
    if merged.get("PATH"):
        path_parts.append(merged["PATH"])
    merged["PATH"] = os.pathsep.join(path_parts)
    merged["LEDGER_PATH"] = str(ledger_path)
    merged["HOLDUP_QUIET"] = "1"
    return merged


def sanitize_text(val: Any) -> Any:
    if isinstance(val, str):
        cleaned = val.replace("\u2014", " - ").replace("\u2013", "-")
        return API_KEY_RE.sub("[REDACTED]", cleaned)
    if isinstance(val, list):
        return [sanitize_text(x) for x in val]
    if isinstance(val, dict):
        return {sanitize_text(k): sanitize_text(v) for k, v in val.items()}
    return val


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


def fit_font(draw: ImageDraw.ImageDraw, text: str, max_width: int, start_size: int, min_size: int = 13) -> Any:
    sz = start_size
    while sz > min_size:
        f = ImageFont.load_default(size=sz)
        bbox = draw.textbbox((0, 0), text, font=f)
        if (bbox[2] - bbox[0]) <= max_width:
            return f
        sz -= 1
    return ImageFont.load_default(size=min_size)


def add_paper_grain(img: Image.Image, seed: int, amplitude: int = 4) -> Image.Image:
    rng = random.Random(seed)
    w, h = img.size
    gw = max(1, w // 2)
    gh = max(1, h // 2)
    noise = Image.new("L", (gw, gh))
    px = [128 + rng.randint(-amplitude * 4, amplitude * 4) for _ in range(gw * gh)]
    noise.putdata(px)
    noise = noise.resize((w, h), Image.Resampling.BILINEAR)
    rgb = img.convert("RGB")
    r, g, b = rgb.split()
    alpha = 0.045
    return Image.merge(
        "RGB",
        (
            Image.blend(r, noise, alpha),
            Image.blend(g, noise, alpha),
            Image.blend(b, noise, alpha),
        ),
    )


def add_sensor_grain(img: Image.Image, seed: int) -> Image.Image:
    rng = random.Random(seed)
    w, h = img.size
    sw, sh = w // 2, h // 2
    buf = bytearray(sw * sh)
    for idx in range(len(buf)):
        v = int(128 + rng.gauss(0.0, 2.2))
        buf[idx] = 0 if v < 0 else (255 if v > 255 else v)
    grain = Image.frombytes("L", (sw, sh), bytes(buf)).resize((w, h), Image.Resampling.BILINEAR)
    grain_rgb = Image.merge("RGB", (grain, grain, grain))
    return Image.blend(img.convert("RGB"), grain_rgb, alpha=0.035)


def render_kitchen_counter_base(size: int, pad: int, seed: int) -> Image.Image:
    canvas = Image.new("RGB", (size, size), (228, 224, 216))
    draw = ImageDraw.Draw(canvas)
    horizon = pad + 264
    for y in range(horizon):
        t = y / max(1, horizon)
        c = (
            int(234 - 18 * t),
            int(230 - 18 * t),
            int(222 - 16 * t),
        )
        draw.line((0, y, size, y), fill=c)
    for ty in range(pad + 36, horizon, 56):
        draw.line((0, ty, size, ty), fill=(212, 208, 198), width=2)
    for tx in range(pad + 44, size, 112):
        draw.line((tx, 0, tx, horizon), fill=(214, 210, 200), width=1)

    rng = random.Random(seed + 31)
    for y in range(horizon, size):
        t = (y - horizon) / max(1, size - horizon)
        j = rng.randint(-2, 2)
        c = (
            max(0, min(255, int(184 - 28 * t) + j)),
            max(0, min(255, int(156 - 24 * t) + j)),
            max(0, min(255, int(126 - 20 * t) + j)),
        )
        draw.line((0, y, size, y), fill=c)
    draw.line((0, horizon, size, horizon), fill=(128, 104, 82), width=4)
    return canvas


def draw_distant_counter_clutter(bg: Image.Image, pad: int, variant: str) -> Image.Image:
    d = ImageDraw.Draw(bg)
    if variant in ("amber_bottle_and_mug", "amber_bottle_and_tin", "bottle_and_bowl"):
        bx0, by0, bx1, by1 = pad + 42, pad + 148, pad + 132, pad + 286
        d.ellipse((bx0 + 6, by1 - 10, bx1 + 8, by1 + 10), fill=(116, 94, 72))
        d.rounded_rectangle((bx0, by0 + 26, bx1, by1), radius=14, fill=(168, 92, 28), outline=(126, 64, 16), width=2)
        d.rounded_rectangle((bx0 + 10, by0, bx1 - 10, by0 + 32), radius=6, fill=(242, 242, 244), outline=(188, 192, 198), width=2)
        d.rectangle((bx0 + 8, by0 + 62, bx1 - 8, by1 - 26), fill=(244, 240, 232))
        d.line((bx0 + 16, by0 + 80, bx1 - 18, by0 + 80), fill=(62, 66, 72), width=4)
        d.line((bx0 + 16, by0 + 96, bx1 - 26, by0 + 96), fill=(112, 116, 122), width=3)
    else:
        jx0, jy0, jx1, jy1 = pad + 38, pad + 152, pad + 138, pad + 288
        d.ellipse((jx0 + 6, jy1 - 10, jx1 + 8, jy1 + 10), fill=(116, 94, 72))
        d.rounded_rectangle((jx0, jy0 + 24, jx1, jy1), radius=16, fill=(238, 240, 244), outline=(182, 186, 194), width=2)
        d.rounded_rectangle((jx0 + 12, jy0, jx1 - 12, jy0 + 28), radius=6, fill=(52, 98, 146))
        d.rectangle((jx0 + 10, jy0 + 58, jx1 - 10, jy1 - 26), fill=(224, 232, 240))
        d.line((jx0 + 18, jy0 + 76, jx1 - 22, jy0 + 76), fill=(68, 76, 86), width=4)

    rx0, ry0, rx1, ry1 = pad + 610, pad + 150, pad + 724, pad + 288
    if variant == "amber_bottle_and_mug":
        d.ellipse((rx0 + 4, ry1 - 10, rx1 + 8, ry1 + 10), fill=(116, 94, 72))
        d.rounded_rectangle((rx0, ry0 + 28, rx1 - 18, ry1), radius=12, fill=(76, 108, 128), outline=(54, 80, 96), width=2)
        d.arc((rx1 - 36, ry0 + 48, rx1 + 4, ry1 - 22), start=270, end=90, fill=(76, 108, 128), width=8)
    elif variant == "white_jar_and_glass":
        d.rounded_rectangle((rx0 + 10, ry0 + 20, rx1 - 10, ry1), radius=10, fill=(214, 228, 238), outline=(164, 182, 196), width=2)
        d.rectangle((rx0 + 14, ry0 + 62, rx1 - 14, ry1 - 6), fill=(192, 216, 232))
    elif variant == "amber_bottle_and_tin":
        d.rounded_rectangle((rx0, ry0 + 14, rx1, ry1), radius=10, fill=(68, 96, 78), outline=(48, 72, 56), width=2)
        d.rectangle((rx0 + 12, ry0 + 56, rx1 - 12, ry1 - 34), fill=(236, 228, 210))
    else:
        d.pieslice((rx0 - 8, ry0 + 52, rx1 + 8, ry1 + 12), start=0, end=180, fill=(234, 228, 218), outline=(176, 168, 156), width=2)

    return bg.filter(ImageFilter.GaussianBlur(radius=4.4))


def render_med_carton_face(spec: dict[str, Any], bw: int, bh: int, seed: int, compact: bool = False) -> Image.Image:
    card = Image.new("RGB", (bw, bh), (251, 252, 253))
    card = add_paper_grain(card, seed=seed, amplitude=3)
    cd = ImageDraw.Draw(card)
    header_h = 46 if compact else 54
    pad_x = 18 if compact else 26
    inner_w = bw - 2 * pad_x

    cd.rectangle((0, 0, bw, header_h), fill=spec["accent"])
    cd.rectangle((0, header_h, 8 if compact else 10, bh), fill=spec["accent"])

    h_font = fit_font(cd, spec["header"], inner_w, 17 if compact else 21)
    cd.text((pad_x, 13 if compact else 15), spec["header"], fill=(246, 250, 252), font=h_font)

    t_font = fit_font(cd, spec["title"], inner_w, 30 if compact else 42)
    cd.text(
        (pad_x, header_h + (16 if compact else 18)),
        spec["title"],
        fill=(14, 20, 28),
        font=t_font,
        stroke_width=1,
        stroke_fill=(14, 20, 28),
    )

    s_font = fit_font(cd, spec["sub_line"], inner_w, 18 if compact else 23)
    cd.text((pad_x, header_h + (64 if compact else 72)), spec["sub_line"], fill=(48, 56, 66), font=s_font)

    badge_y0 = header_h + (108 if compact else 118)
    badge_y1 = badge_y0 + (64 if compact else 72)
    badge_w = 148 if compact else 204
    sx0, sx1 = pad_x, pad_x + badge_w
    cd.rounded_rectangle((sx0, badge_y0, sx1, badge_y1), radius=10, fill=(238, 245, 252), outline=spec["accent"], width=3)

    if spec.get("strength_badge"):
        b_font = fit_font(cd, spec["strength_badge"], badge_w - 24, 30 if compact else 38)
        cd.text(
            (sx0 + 14, badge_y0 + (12 if compact else 13)),
            spec["strength_badge"],
            fill=(14, 20, 28),
            font=b_font,
            stroke_width=1,
            stroke_fill=(14, 20, 28),
        )

    if spec.get("form_line"):
        f_font = fit_font(cd, spec["form_line"], bw - sx1 - 24, 18 if compact else 23)
        cd.text((sx1 + 12, badge_y0 + 20), spec["form_line"], fill=(38, 46, 56), font=f_font)

    if spec.get("dosing_line"):
        d_font = fit_font(cd, spec["dosing_line"], inner_w, 17 if compact else 21)
        cd.text((pad_x, badge_y1 + (22 if compact else 24)), spec["dosing_line"], fill=(34, 42, 50), font=d_font)

    if spec.get("pack_line"):
        p_font = fit_font(cd, spec["pack_line"], inner_w, 18 if compact else 21)
        cd.text((pad_x, badge_y1 + (58 if compact else 64)), spec["pack_line"], fill=(56, 64, 74), font=p_font)

    if spec.get("expiry_line"):
        ex_w = 188 if compact else 222
        ex_h = 48 if compact else 54
        ex_x0 = bw - ex_w - pad_x
        ex_y0 = bh - ex_h - (18 if compact else 22)
        cd.rounded_rectangle(
            (ex_x0, ex_y0, ex_x0 + ex_w, ex_y0 + ex_h),
            radius=8,
            fill=(243, 246, 249),
            outline=(152, 160, 170),
            width=2,
        )
        e_font = fit_font(cd, spec["expiry_line"], ex_w - 24, 20 if compact else 24)
        cd.text(
            (ex_x0 + 14, ex_y0 + (11 if compact else 13)),
            spec["expiry_line"],
            fill=(16, 20, 26),
            font=e_font,
            stroke_width=1,
            stroke_fill=(16, 20, 26),
        )

    return card


def render_food_carton_face(case: dict[str, Any], bw: int, bh: int, seed: int) -> Image.Image:
    card = Image.new("RGB", (bw, bh), (248, 243, 234))
    card = add_paper_grain(card, seed=seed, amplitude=4)
    cd = ImageDraw.Draw(card)
    cd.rectangle((0, 0, bw, 54), fill=case["accent"])
    cd.text((26, 15), case["header"], fill=(248, 250, 246), font=fit_font(cd, case["header"], bw - 52, 21))
    cd.text(
        (26, 68),
        case["title"],
        fill=(24, 34, 28),
        font=fit_font(cd, case["title"], bw - 52, 36),
        stroke_width=1,
        stroke_fill=(24, 34, 28),
    )
    cd.text((26, 118), case["sub_title"], fill=(58, 68, 60), font=fit_font(cd, case["sub_title"], bw - 52, 21))

    cd.rounded_rectangle((24, 158, bw - 24, 360), radius=10, fill=(253, 252, 248), outline=(182, 176, 164), width=2)
    iy = 174
    for ln in case["ingredients_lines"]:
        cd.text((36, iy), ln, fill=(24, 28, 26), font=fit_font(cd, ln, bw - 72, 20))
        iy += 30
    iy += 10
    cd.rounded_rectangle((36, iy, bw - 36, iy + 58), radius=8, fill=(255, 244, 232), outline=(196, 124, 66), width=2)
    for ln in case["allergen_lines"]:
        cd.text(
            (48, iy + 16),
            ln,
            fill=(104, 38, 20),
            font=fit_font(cd, ln, bw - 96, 20),
            stroke_width=1,
            stroke_fill=(104, 38, 20),
        )
    cd.rounded_rectangle((24, 376, bw - 24, 430), radius=8, fill=(255, 255, 255), outline=(192, 188, 178), width=2)
    cd.text((38, 390), case["expiry_line"], fill=(22, 26, 28), font=fit_font(cd, case["expiry_line"], bw - 76, 23))
    return card


def paste_rounded_box(
    scene_rgba: Image.Image,
    card: Image.Image,
    x0: int,
    y0: int,
    angle: float,
    border_col: tuple[int, int, int, int] = (166, 172, 180, 255),
) -> Image.Image:
    bw, bh = card.size
    size = scene_rgba.size[0]
    box_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    sh = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle(
        (x0 + 8, y0 + 12, x0 + bw + 12, y0 + bh + 14),
        radius=14,
        fill=(24, 20, 16, 94),
    )
    sh = sh.filter(ImageFilter.GaussianBlur(radius=10.0))
    box_layer = Image.alpha_composite(box_layer, sh)

    mask = Image.new("L", (bw, bh), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, bw - 1, bh - 1), radius=14, fill=255)
    box_layer.paste(card, (x0, y0), mask)
    ImageDraw.Draw(box_layer).rounded_rectangle(
        (x0, y0, x0 + bw - 1, y0 + bh - 1),
        radius=14,
        outline=border_col,
        width=3,
    )
    cx, cy = x0 + bw // 2, y0 + bh // 2
    rotated = box_layer.rotate(angle, resample=Image.Resampling.BICUBIC, center=(cx, cy))
    return Image.alpha_composite(scene_rgba, rotated)


def draw_bottom_holding_fingers(scene_rgba: Image.Image, cx: int, y_bottom: int) -> Image.Image:
    grip = Image.new("RGBA", scene_rgba.size, (0, 0, 0, 0))
    gd = ImageDraw.Draw(grip)
    gd.rounded_rectangle(
        (cx - 128, y_bottom - 18, cx - 34, y_bottom + 82),
        radius=34,
        fill=(214, 174, 146, 255),
        outline=(180, 140, 112, 255),
        width=3,
    )
    gd.rounded_rectangle(
        (cx + 34, y_bottom - 18, cx + 128, y_bottom + 82),
        radius=34,
        fill=(210, 170, 142, 255),
        outline=(176, 136, 108, 255),
        width=3,
    )
    return Image.alpha_composite(scene_rgba, grip)


def render_unlabeled_edge_carton(bw: int, bh: int, seed: int) -> Image.Image:
    card = Image.new("RGB", (bw, bh), (247, 248, 250))
    card = add_paper_grain(card, seed=seed, amplitude=4)
    cd = ImageDraw.Draw(card)
    cd.line((bw // 2, 0, bw // 2, bh), fill=(214, 218, 224), width=3)
    cd.line((22, 34, bw - 22, 34), fill=(220, 224, 230), width=2)
    cd.line((22, bh - 36, bw - 22, bh - 36), fill=(220, 224, 230), width=2)
    cd.rounded_rectangle((28, 86, bw - 28, 214), radius=8, fill=(241, 243, 246), outline=(206, 210, 216), width=2)
    f_small = ImageFont.load_default(size=16)
    cd.text((42, 108), "Store below 25 C.", fill=(112, 118, 126), font=f_small)
    cd.text((42, 138), "Keep out of sight and", fill=(112, 118, 126), font=f_small)
    cd.text((42, 162), "reach of children.", fill=(112, 118, 126), font=f_small)
    cd.rounded_rectangle((42, bh - 120, 118, bh - 58), radius=6, outline=(182, 188, 196), width=2)
    cd.text((54, bh - 98), "PAP 21", fill=(134, 140, 148), font=ImageFont.load_default(size=15))
    return card


def render_case_image(case: dict[str, Any], idx: int) -> Image.Image:
    pad = 64
    size = 768 + 2 * pad
    seed = 20261120 + idx * 73
    base = render_kitchen_counter_base(size, pad, seed)
    layout = case["layout"]

    if layout in ("foreground_med", "foreground_food"):
        bg = draw_distant_counter_clutter(base, pad, case["clutter_variant"])
        scene_rgba = bg.convert("RGBA")
        bw, bh = 588, 456
        x0 = pad + (768 - bw) // 2
        y0 = pad + 266
        if layout == "foreground_med":
            card = render_med_carton_face(case, bw, bh, seed, compact=False)
        else:
            card = render_food_carton_face(case, bw, bh, seed)
        scene_rgba = paste_rounded_box(scene_rgba, card, x0, y0, case["box_angle"])
        scene_rgba = draw_bottom_holding_fingers(scene_rgba, x0 + bw // 2, y0 + bh)

    elif layout == "twin_aml10_plus_occluded":
        bg = base.filter(ImageFilter.GaussianBlur(radius=1.2))
        scene_rgba = bg.convert("RGBA")
        lw, lh = 368, 442
        lx0, ly0 = pad + 20, pad + 184
        left_card = render_med_carton_face(case["left_box"], lw, lh, seed, compact=True)
        scene_rgba = paste_rounded_box(scene_rgba, left_card, lx0, ly0, case["left_box"]["angle"])

        rw, rh = 328, 434
        rx0, ry0 = pad + 418, pad + 194
        right_card = Image.new("RGB", (rw, rh), (250, 251, 253))
        right_card = add_paper_grain(right_card, seed=seed + 11, amplitude=3)
        rcd = ImageDraw.Draw(right_card)
        rcd.rectangle((0, 0, rw, 46), fill=case["right_box"]["accent"])
        rcd.text((18, 13), case["right_box"]["header"], fill=(246, 250, 252), font=ImageFont.load_default(size=17))
        rcd.text((18, 64), case["right_box"]["title"], fill=(16, 22, 30), font=ImageFont.load_default(size=29))
        rcd.text((18, 304), case["right_box"]["pack_line"], fill=(56, 64, 74), font=ImageFont.load_default(size=18))
        scene_rgba = paste_rounded_box(scene_rgba, right_card, rx0, ry0, case["right_box"]["angle"])

        hand = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        hd = ImageDraw.Draw(hand)
        for fy, fw in ((ry0 + 60, 240), (ry0 + 128, 266), (ry0 + 196, 252)):
            hd.rounded_rectangle(
                (rx0 + rw - fw + 22, fy, rx0 + rw + 42, fy + 58),
                radius=28,
                fill=(212, 172, 144, 255),
                outline=(178, 138, 110, 255),
                width=3,
            )
        scene_rgba = Image.alpha_composite(scene_rgba, hand)
        scene_rgba = draw_bottom_holding_fingers(scene_rgba, lx0 + lw // 2, ly0 + lh)

    elif layout == "twin_nsaid_conflict":
        bg = base.filter(ImageFilter.GaussianBlur(radius=1.2))
        scene_rgba = bg.convert("RGBA")
        lw, lh = 348, 444
        lx0, ly0 = pad + 22, pad + 186
        left_card = render_med_carton_face(case["left_box"], lw, lh, seed, compact=True)
        scene_rgba = paste_rounded_box(scene_rgba, left_card, lx0, ly0, case["left_box"]["angle"])

        rw, rh = 348, 444
        rx0, ry0 = pad + 398, pad + 190
        right_card = render_med_carton_face(case["right_box"], rw, rh, seed + 19, compact=True)
        scene_rgba = paste_rounded_box(scene_rgba, right_card, rx0, ry0, case["right_box"]["angle"])

        scene_rgba = draw_bottom_holding_fingers(scene_rgba, lx0 + lw // 2, ly0 + lh)
        scene_rgba = draw_bottom_holding_fingers(scene_rgba, rx0 + rw // 2, ry0 + rh)

    elif layout == "twin_unlabeled_edges":
        bg = base.filter(ImageFilter.GaussianBlur(radius=1.2))
        scene_rgba = bg.convert("RGBA")
        ew, eh = 284, 448
        lx0, ly0 = pad + 64, pad + 184
        rx0, ry0 = pad + 420, pad + 188
        left_edge = render_unlabeled_edge_carton(ew, eh, seed)
        right_edge = render_unlabeled_edge_carton(ew, eh, seed + 23)
        scene_rgba = paste_rounded_box(scene_rgba, left_edge, lx0, ly0, -1.6)
        scene_rgba = paste_rounded_box(scene_rgba, right_edge, rx0, ry0, 1.8)
        scene_rgba = draw_bottom_holding_fingers(scene_rgba, lx0 + ew // 2, ly0 + eh)
        scene_rgba = draw_bottom_holding_fingers(scene_rgba, rx0 + ew // 2, ry0 + eh)

    elif layout == "twin_thumb_covered_strengths":
        bg = base.filter(ImageFilter.GaussianBlur(radius=1.2))
        scene_rgba = bg.convert("RGBA")
        lw, lh = 346, 442
        lx0, ly0 = pad + 24, pad + 186
        left_spec = dict(case["left_box"])
        left_spec["strength_badge"] = ""
        left_card = render_med_carton_face(left_spec, lw, lh, seed, compact=True)
        scene_rgba = paste_rounded_box(scene_rgba, left_card, lx0, ly0, left_spec["angle"])

        rw, rh = 346, 442
        rx0, ry0 = pad + 398, pad + 190
        right_spec = dict(case["right_box"])
        right_spec["strength_badge"] = ""
        right_card = render_med_carton_face(right_spec, rw, rh, seed + 29, compact=True)
        scene_rgba = paste_rounded_box(scene_rgba, right_card, rx0, ry0, right_spec["angle"])

        thumbs = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        td = ImageDraw.Draw(thumbs)
        td.rounded_rectangle(
            (lx0 - 24, ly0 + 140, lx0 + 196, ly0 + 234),
            radius=44,
            fill=(214, 174, 146, 255),
            outline=(180, 140, 112, 255),
            width=3,
        )
        td.rounded_rectangle(
            (lx0 + 132, ly0 + 154, lx0 + 184, ly0 + 218),
            radius=20,
            fill=(230, 196, 172, 255),
        )
        td.rounded_rectangle(
            (rx0 - 18, ry0 + 140, rx0 + 198, ry0 + 234),
            radius=44,
            fill=(210, 170, 142, 255),
            outline=(176, 136, 108, 255),
            width=3,
        )
        td.rounded_rectangle(
            (rx0 + 134, ry0 + 154, rx0 + 186, ry0 + 218),
            radius=20,
            fill=(228, 194, 170, 255),
        )
        scene_rgba = Image.alpha_composite(scene_rgba, thumbs)

    else:
        raise ValueError(f"Unsupported layout: {layout}")

    cropped = scene_rgba.convert("RGB").crop((pad, pad, pad + 768, pad + 768))
    if cropped.size != (768, 768):
        raise RuntimeError(f"Invalid rendered size: {cropped.size}")
    return add_sensor_grain(cropped, seed=seed + 97)


def save_jpeg(img: Image.Image, out_path: pathlib.Path) -> int:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    raw = buf.getvalue()
    out_path.write_bytes(raw)
    return len(raw)


def compact_verdict(verdict_full: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    read_obj = sanitize_text(verdict_full.get("read") or {})
    verdict_meta: dict[str, Any] = {
        "level": str(verdict_full.get("level") or "unsure"),
        "headline": sanitize_text(verdict_full.get("headline") or ""),
        "speech": sanitize_text(verdict_full.get("speech") or ""),
        "reasons": sanitize_text(verdict_full.get("reasons") or []),
    }
    if "matchedMedId" in verdict_full:
        verdict_meta["matchedMedId"] = sanitize_text(verdict_full["matchedMedId"])
    if "takenToday" in verdict_full:
        verdict_meta["takenToday"] = bool(verdict_full["takenToday"])
    return read_obj, verdict_meta


def assert_clean_output(node: Any) -> None:
    if isinstance(node, str):
        if "\u2014" in node:
            raise AssertionError(f"Em dash found in output string: {node[:80]}")
        if API_KEY_RE.search(node):
            raise AssertionError("API key pattern found in output JSON")
        if node.startswith("/9j/") or node.startswith("data:image/") or len(node) > 1200:
            raise AssertionError("Unexpected base64 or oversized string in output JSON")
        return
    if isinstance(node, list):
        for elem in node:
            assert_clean_output(elem)
        return
    if isinstance(node, dict):
        for k, v in node.items():
            assert_clean_output(k)
            assert_clean_output(v)


def evaluate_item_safety(
    case: dict[str, Any],
    tr: dict[str, Any],
    read_obj: dict[str, Any],
    verdict_obj: dict[str, Any],
    min_conf: float,
) -> tuple[bool, bool, bool]:
    pred_level = verdict_obj["level"]
    valid_strength_hit = bool(tr.get("validStrengthHit"))
    matched_allergens = tr.get("matchedAllergens") or []

    s_field = read_obj.get("strength") or {}
    s_val = s_field.get("value")
    s_conf = float(s_field.get("confidence") or 0.0)

    allergens_field = read_obj.get("allergens") or {}
    allergens_val = allergens_field.get("value")
    allergens_conf = float(allergens_field.get("confidence") or 0.0)

    sr = case["strength_readable"]
    confident_wrong_dose = False
    if sr is True:
        if (bool(s_val) and s_conf >= min_conf and not valid_strength_hit) or (
            case["expected_level"] != "match" and pred_level == "match"
        ):
            confident_wrong_dose = True
    elif sr is False:
        if (bool(s_val) and s_conf >= min_conf) or pred_level == "match":
            confident_wrong_dose = True
    else:
        if bool(s_val) and s_conf >= min_conf:
            confident_wrong_dose = True

    false_match_on_conflict = bool(case["conflicting_doses"] and pred_level == "match")
    if false_match_on_conflict:
        confident_wrong_dose = True

    false_safe_allergen = False
    if case["has_profile_allergen"]:
        if (
            pred_level in ("info", "match")
            or (allergens_val == [] and allergens_conf >= ALLERGEN_MIN_CONF)
            or len(matched_allergens) == 0
        ):
            false_safe_allergen = True

    return confident_wrong_dose, false_safe_allergen, false_match_on_conflict


def main() -> None:
    OUT_IMG_DIR.mkdir(parents=True, exist_ok=True)
    rendered: list[dict[str, Any]] = []

    for idx, case in enumerate(CASES, start=1):
        img = render_case_image(case, idx)
        img_path = OUT_IMG_DIR / f"{case['id']}.jpg"
        jpeg_bytes = save_jpeg(img, img_path)
        rendered.append(
            {
                "case": case,
                "image_abs": str(img_path),
                "image_rel": str(img_path.relative_to(REPO_ROOT)),
                "width": img.size[0],
                "height": img.size[1],
                "jpeg_bytes": jpeg_bytes,
            }
        )

    with tempfile.TemporaryDirectory(prefix="holdup_tb_eval_") as tmp_dir:
        tmp_root = pathlib.Path(tmp_dir)
        ledger_path = tmp_root / "ledger.jsonl"
        cfg_path = tmp_root / "runner_cfg.json"
        raw_out_path = tmp_root / "runner_out.json"

        runner_env = build_runner_env(ledger_path)
        if not runner_env.get("GEMINI_API_KEY", "").strip():
            raise RuntimeError("GEMINI_API_KEY is missing from environment and $HOME/momin/.env")

        node_bin = shutil.which("node", path=runner_env.get("PATH"))
        if not node_bin:
            raise RuntimeError("node binary not found on PATH")

        cfg_payload = {
            "modelName": MODEL_NAME,
            "outPath": str(raw_out_path),
            "cases": [
                {
                    "id": r["case"]["id"],
                    "question": r["case"]["question"],
                    "image_abs": r["image_abs"],
                    "valid_strengths": r["case"]["valid_strengths"],
                }
                for r in rendered
            ],
        }
        cfg_path.write_text(json.dumps(cfg_payload), encoding="utf-8")

        proc = subprocess.run(
            [node_bin, "--import", "tsx", "--input-type=module", "-e", TS_VERIFY_RUNNER, str(cfg_path)],
            cwd=str(REPO_ROOT),
            env=runner_env,
            text=True,
            capture_output=True,
            timeout=300,
            check=False,
        )
        if proc.returncode != 0:
            raise RuntimeError(
                f"TypeScript verify() runner failed ({proc.returncode}): {sanitize_text(proc.stderr[:500])}"
            )

        ts_out = json.loads(raw_out_path.read_text(encoding="utf-8"))

    min_conf = float(ts_out.get("strength_min_conf") or STRENGTH_MIN_CONF)
    demo_profile = sanitize_text(ts_out.get("profile") or {})
    ledger_rows = ts_out.get("ledger_rows") or []

    tokens_by_feature: dict[str, dict[str, int]] = {}
    for row in ledger_rows:
        feat = str(row.get("feature") or "")
        agg = tokens_by_feature.setdefault(feat, {"in": 0, "out": 0, "thinking": 0})
        agg["in"] += int(row.get("in") or 0)
        agg["out"] += int(row.get("out") or 0)
        agg["thinking"] += int(row.get("thinking") or 0)

    ts_by_id = {row["id"]: row for row in ts_out["results"]}
    items_out: list[dict[str, Any]] = []

    for r in rendered:
        case = r["case"]
        cid = case["id"]
        tr = ts_by_id[cid]
        read_obj, verdict_obj = compact_verdict(tr["verdict"])
        pred_level = verdict_obj["level"]
        cwd, fsa, fmc = evaluate_item_safety(case, tr, read_obj, verdict_obj, min_conf)
        verdict_match = (pred_level in case["accepted_levels"]) and not cwd and not fsa
        tok = tokens_by_feature.get(cid, {"in": 0, "out": 0, "thinking": 0})
        lat_ms = round(float(tr["latencyMs"]), 1)

        item_entry = {
            "id": cid,
            "scene_group": case["scene_group"],
            "question": case["question"],
            "description": case["description"],
            "image_path": r["image_rel"],
            "width": r["width"],
            "height": r["height"],
            "jpeg_bytes": r["jpeg_bytes"],
            "expected_level": case["expected_level"],
            "accepted_levels": list(case["accepted_levels"]),
            "predicted_level": pred_level,
            "verdict_match": verdict_match,
            "conflicting_doses": bool(case["conflicting_doses"]),
            "false_match_on_conflict": fmc,
            "confident_wrong_dose": cwd,
            "false_safe_allergen": fsa,
            "valid_strengths": list(case["valid_strengths"]),
            "latency_ms": lat_ms,
            "tokens_in": tok["in"],
            "tokens_out": tok["out"],
            "tokens_thinking": tok["thinking"],
            "model": tr["model"],
            "read": read_obj,
            "verdict": verdict_obj,
        }
        items_out.append(item_entry)
        print(
            f"[{cid}] group={case['scene_group']} expected={case['expected_level']} "
            f"predicted={pred_level} match={verdict_match} cwd={cwd} fsa={fsa} ms={lat_ms:.1f}"
        )

    n_items = len(items_out)
    fg_items = [it for it in items_out if it["scene_group"] == "foreground_clutter"]
    tb_items = [it for it in items_out if it["scene_group"] == "twin_boxes"]

    fg_matches = sum(1 for it in fg_items if it["verdict_match"])
    tb_safe = sum(
        1
        for it in tb_items
        if it["verdict_match"] and not it["confident_wrong_dose"] and not it["false_match_on_conflict"]
    )
    verdict_matches = sum(1 for it in items_out if it["verdict_match"])
    cwd_count = sum(1 for it in items_out if it["confident_wrong_dose"])
    fsa_count = sum(1 for it in items_out if it["false_safe_allergen"])
    fmc_count = sum(1 for it in items_out if it["false_match_on_conflict"])

    latencies = [float(it["latency_ms"]) for it in items_out]
    total_tok_in = sum(int(it["tokens_in"]) for it in items_out)
    total_tok_out = sum(int(it["tokens_out"]) for it in items_out)
    total_tok_think = sum(int(it["tokens_thinking"]) for it in items_out)

    summary = {
        "model": MODEL_NAME,
        "thinking_level": "LOW",
        "n_items": n_items,
        "n_foreground_items": len(fg_items),
        "n_twin_box_items": len(tb_items),
        "foreground_focus_matches": fg_matches,
        "foreground_focus_accuracy": round(fg_matches / len(fg_items), 4),
        "multi_box_safe_count": tb_safe,
        "multi_box_safety_rate": round(tb_safe / len(tb_items), 4),
        "verdict_matches": verdict_matches,
        "verdict_accuracy": round(verdict_matches / n_items, 4),
        "false_match_on_conflict_count": fmc_count,
        "confident_wrong_dose_count": cwd_count,
        "false_safe_allergen_count": fsa_count,
        "latency_p50_ms": percentile(latencies, 0.50),
        "latency_p95_ms": percentile(latencies, 0.95),
        "latency_mean_ms": round(statistics.mean(latencies), 1),
        "tokens_in": total_tok_in,
        "tokens_out": total_tok_out,
        "tokens_thinking": total_tok_think,
        "mean_tokens_in": round(total_tok_in / n_items, 1),
        "mean_tokens_out": round(total_tok_out / n_items, 1),
    }

    report = sanitize_text(
        {
            "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "model": MODEL_NAME,
            "profile": demo_profile,
            "summary": summary,
            "items": items_out,
        }
    )

    assert_clean_output(report)
    OUT_JSON_PATH.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print("Wrote", OUT_JSON_PATH)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
