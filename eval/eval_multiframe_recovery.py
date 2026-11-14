import argparse
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
import sys
import tempfile
from typing import Any

from PIL import Image, ImageDraw, ImageFilter, ImageFont

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT_IMG_DIR = REPO_ROOT / "eval" / "out" / "multiframe_recovery"
OUT_JSON_PATH = REPO_ROOT / "eval" / "multiframe_recovery_results.json"

MODEL_NAME = "gemini-3.8-flash"
STRENGTH_MIN_CONF = 0.80

EM_DASH = chr(0x2014)
EN_DASH = chr(0x2013)
COMMENT_CHAR = chr(35)

PAIR_SPECS: list[dict[str, Any]] = [
    {
        "id": "mf_01",
        "category": "medication_thumb_to_flap",
        "description": "AMLODIPIN ORION front with thumb covering strength -> narrow side end-flap 5 mg / EXP 2027-10",
        "question": "Is this my evening pill?",
        "expected_single_level": "unsure",
        "expected_paired_level": "match",
        "paired_strength_readable": True,
        "expected_strength": "5 mg",
        "seed": 501,
    },
    {
        "id": "mf_02",
        "category": "medication_thumb_to_wrong_strength_flap",
        "description": "AMLODIPIN ORION front with thumb covering strength -> narrow side flap 10 mg / EXP 2027-10",
        "question": "Is this my evening pill?",
        "expected_single_level": "unsure",
        "expected_paired_level": "warning",
        "paired_strength_readable": True,
        "expected_strength": "10 mg",
        "seed": 502,
    },
    {
        "id": "mf_03",
        "category": "curved_bottle_rotation_expired",
        "description": "Curved white bottle left side METFORMIN -> rotated right side 500 mg tablets / EXP 2025-02",
        "question": "Can I take this metformin?",
        "expected_single_level": "unsure",
        "expected_paired_level": "warning",
        "paired_strength_readable": True,
        "expected_strength": "500 mg",
        "seed": 503,
    },
    {
        "id": "mf_04",
        "category": "food_front_to_allergen_back",
        "description": "Nordic Crunch Granola Bar 45g front -> back fine-print with roasted hazelnuts (14%)",
        "question": "Does this contain nuts?",
        "expected_single_level": "unsure",
        "expected_paired_level": "warning",
        "paired_strength_readable": False,
        "expected_strength": None,
        "seed": 504,
    },
    {
        "id": "mf_05",
        "category": "food_front_to_safe_back",
        "description": "Nordic Barista Drink 1L front -> back ingredients water, oats (10%), rapeseed oil, sea salt",
        "question": "Is this safe with my allergies?",
        "expected_single_level": "unsure",
        "expected_paired_level": "info",
        "paired_strength_readable": False,
        "expected_strength": None,
        "seed": 505,
    },
    {
        "id": "mf_06",
        "category": "barcode_back_to_nsaid_front",
        "description": "Blank barcode back 6432100099999 -> rotated front BURANA 400 mg / ibuprofeeni",
        "question": "Can I take this for a headache?",
        "expected_single_level": "unsure",
        "expected_paired_level": "warning",
        "paired_strength_readable": True,
        "expected_strength": "400 mg",
        "seed": 506,
    },
]

TS_VERIFY_RUNNER = """
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import { FrameRing, jpegSharpness, verify } from "./server/src/verify.ts";
import { sameStrength, STRENGTH_MIN_CONF } from "./server/src/safety.ts";
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
const outPairs = [];

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

for (const item of cfg.pairs) {
  const buf1 = fs.readFileSync(item.frame1_abs);
  const buf2 = fs.readFileSync(item.frame2_abs);
  const b64_1 = buf1.toString("base64");
  const b64_2 = buf2.toString("base64");
  const sharp1 = jpegSharpness(buf1);
  const sharp2 = jpegSharpness(buf2);

  const ring = new FrameRing(8);
  const baseTs = Date.now() - 1500;
  ring.push({ data: b64_1, sharpness: sharp1, ts: baseTs, bytes: buf1.length, source: "glasses" });
  const pickedSingle = ring.pick(2, 5000, baseTs);

  const singleTag = `single_${item.id}`;
  const singleRes = await runVerifyWithRetry(
    [b64_1],
    DEMO_PROFILE,
    item.question,
    singleTag
  );

  ring.push({ data: b64_2, sharpness: sharp2, ts: baseTs + 1500, bytes: buf2.length, source: "glasses" });
  const pickedPaired = ring.pick(2, 5000, baseTs + 1500);

  const pairedTag = `paired_${item.id}`;
  const pairedRes = await runVerifyWithRetry(
    [b64_1, b64_2],
    DEMO_PROFILE,
    item.question,
    pairedTag
  );

  const pairedStrengthVal = pairedRes.verdict?.read?.strength?.value ?? null;
  const pairedStrengthMatches = item.expected_strength
    ? sameStrength(pairedStrengthVal, item.expected_strength)
    : null;

  outPairs.push({
    id: item.id,
    single_tag: singleTag,
    paired_tag: pairedTag,
    frame1_sharpness: Number(sharp1.toFixed(6)),
    frame2_sharpness: Number(sharp2.toFixed(6)),
    ring_single_picked: pickedSingle.length,
    ring_paired_picked: pickedPaired.length,
    single_model: singleRes.model,
    single_latency_ms: singleRes.latencyMs,
    single_frames: singleRes.frames,
    single_verdict: singleRes.verdict,
    paired_model: pairedRes.model,
    paired_latency_ms: pairedRes.latencyMs,
    paired_frames: pairedRes.frames,
    paired_verdict: pairedRes.verdict,
    paired_strength_matches: pairedStrengthMatches,
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
    pairs: outPairs,
    ledger_rows: ledgerRows,
  }),
  "utf8"
);
process.exit(0);
"""


def scrub_node(val: Any) -> Any:
    if isinstance(val, str):
        cleaned = val.replace(EM_DASH, " - ").replace(EN_DASH, "-")
        key_pat = "AI" + "za[0-9A-Za-z_-]{16,}"
        return re.sub(key_pat, "[REDACTED]", cleaned)
    if isinstance(val, list):
        return [scrub_node(item) for item in val]
    if isinstance(val, dict):
        return {str(k): scrub_node(v) for k, v in val.items()}
    return val


def assert_clean_output(node: Any) -> None:
    if isinstance(node, str):
        if EM_DASH in node or EN_DASH in node:
            raise AssertionError(f"Forbidden dash in output: {node[:80]}")
        if node.startswith("/9j/") or len(node) > 1200:
            raise AssertionError("Unexpected base64 or oversized string in output JSON")
        if ("AI" + "za") in node:
            raise AssertionError("Unexpected API key prefix in output JSON")
        return
    if isinstance(node, list):
        for item in node:
            assert_clean_output(item)
        return
    if isinstance(node, dict):
        for k, v in node.items():
            assert_clean_output(k)
            assert_clean_output(v)


def clamp_byte(v: float) -> int:
    if v <= 0.0:
        return 0
    if v >= 255.0:
        return 255
    return int(round(v))


def add_paper_grain(img: Image.Image, seed: int, amplitude: int = 4) -> Image.Image:
    rng = random.Random(seed)
    w, h = img.size
    gw = max(1, w // 2)
    gh = max(1, h // 2)
    noise = Image.new("L", (gw, gh))
    noise.putdata([128 + rng.randint(-amplitude * 4, amplitude * 4) for _ in range(gw * gh)])
    noise = noise.resize((w, h), Image.Resampling.BILINEAR)
    r, g, b = img.convert("RGB").split()
    alpha = 0.05
    return Image.merge(
        "RGB",
        (Image.blend(r, noise, alpha), Image.blend(g, noise, alpha), Image.blend(b, noise, alpha)),
    )


def render_counter_backdrop(seed: int, size: int = 768) -> Image.Image:
    rng = random.Random(seed)
    img = Image.new("RGB", (size, size))
    draw = ImageDraw.Draw(img)
    horizon_y = 548
    for y in range(horizon_y):
        t = y / max(1, horizon_y)
        r = clamp_byte(235 - 24 * t)
        g = clamp_byte(230 - 23 * t)
        b = clamp_byte(221 - 21 * t)
        draw.line((0, y, size, y), fill=(r, g, b))
    for y in range(horizon_y, size):
        t = (y - horizon_y) / max(1, size - horizon_y)
        streak = rng.randint(-3, 3)
        r = clamp_byte(182 - 26 * t + streak)
        g = clamp_byte(152 - 22 * t + streak)
        b = clamp_byte(118 - 18 * t + streak)
        draw.line((0, y, size, y), fill=(r, g, b))
    draw.line((0, horizon_y, size, horizon_y), fill=(134, 104, 76), width=3)

    bokeh = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    bd = ImageDraw.Draw(bokeh)
    bd.ellipse((32, 24, 218, 198), fill=(255, 250, 238, 42))
    bd.ellipse((542, 44, 738, 228), fill=(238, 246, 255, 34))
    bokeh = bokeh.filter(ImageFilter.GaussianBlur(radius=24.0))
    return Image.alpha_composite(img.convert("RGBA"), bokeh).convert("RGB")


def draw_thumb_occlusion(canvas_rgba: Image.Image, tip_x: int, tip_y: int) -> Image.Image:
    thumb_w, thumb_h = 620, 250
    layer = Image.new("RGBA", (thumb_w, thumb_h), (0, 0, 0, 0))

    shadow = Image.new("RGBA", (thumb_w, thumb_h), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.rounded_rectangle((10, 54, 590, 202), radius=72, fill=(22, 14, 10, 118))
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=13.0))
    layer = Image.alpha_composite(layer, shadow)

    td = ImageDraw.Draw(layer)
    td.rounded_rectangle(
        (0, 34, 582, 194),
        radius=78,
        fill=(214, 165, 139, 255),
        outline=(172, 124, 100, 255),
        width=3,
    )
    td.rounded_rectangle((18, 48, 558, 116), radius=34, fill=(224, 177, 152, 255))
    td.rounded_rectangle(
        (476, 54, 564, 170),
        radius=40,
        fill=(238, 208, 194, 255),
        outline=(192, 152, 132, 255),
        width=2,
    )
    td.arc((472, 56, 514, 168), start=115, end=245, fill=(246, 228, 218, 255), width=4)
    td.arc((336, 52, 374, 174), start=250, end=110, fill=(180, 132, 108, 255), width=3)
    td.arc((352, 56, 386, 170), start=255, end=105, fill=(186, 138, 114, 255), width=2)

    rotated = layer.rotate(12.0, resample=Image.Resampling.BICUBIC, expand=True)
    out = canvas_rgba.copy()
    out.alpha_composite(rotated, dest=(tip_x - 520, tip_y - 74))
    return out


def render_thumb_occluded_orion_front(
    seed: int,
    vnr_code: str,
    subtitle_line: str,
    tilt_deg: float,
) -> Image.Image:
    pad = 80
    size = 768 + 2 * pad
    bg = render_counter_backdrop(seed, size)

    box_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    x0, y0, x1, y1 = pad + 82, pad + 134, pad + 686, pad + 622
    bw, bh = x1 - x0, y1 - y0
    accent = (20, 102, 148)

    sh = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle((x0 + 12, y0 + 16, x1 + 16, y1 + 20), radius=18, fill=(24, 20, 16, 96))
    sh = sh.filter(ImageFilter.GaussianBlur(radius=12.0))
    box_layer = Image.alpha_composite(box_layer, sh)

    card = Image.new("RGB", (bw, bh), (251, 252, 254))
    card = add_paper_grain(card, seed + 11, amplitude=3)
    cd = ImageDraw.Draw(card)

    cd.rectangle((0, 0, bw, 66), fill=accent)
    cd.text(
        (28, 20),
        f"ORION PHARMA    {vnr_code}",
        fill=(248, 251, 254),
        font=ImageFont.load_default(size=23),
    )
    cd.text(
        (28, 92),
        "AMLODIPIN ORION",
        fill=(12, 18, 28),
        font=ImageFont.load_default(size=46),
        stroke_width=1,
        stroke_fill=(12, 18, 28),
    )
    cd.text(
        (28, 154),
        "tabletti",
        fill=(28, 36, 46),
        font=ImageFont.load_default(size=28),
    )
    if subtitle_line:
        cd.text(
            (28, 194),
            subtitle_line,
            fill=(48, 56, 68),
            font=ImageFont.load_default(size=24),
        )

    cd.rounded_rectangle(
        (28, 266, 256, 356),
        radius=12,
        fill=(238, 245, 252),
        outline=accent,
        width=4,
    )

    cd.text(
        (bw - 196, bh - 62),
        "98 tablettia",
        fill=(38, 46, 56),
        font=ImageFont.load_default(size=24),
    )

    mask = Image.new("L", (bw, bh), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, bw - 1, bh - 1), radius=16, fill=255)
    box_layer.paste(card, (x0, y0), mask)
    ImageDraw.Draw(box_layer).rounded_rectangle(
        (x0, y0, x1 - 1, y1 - 1),
        radius=16,
        outline=(168, 174, 184, 255),
        width=3,
    )

    rotated = box_layer.rotate(tilt_deg, resample=Image.Resampling.BICUBIC)
    composed = Image.alpha_composite(bg.convert("RGBA"), rotated)
    composed = draw_thumb_occlusion(composed, tip_x=x0 + 278, tip_y=y0 + 258)
    return composed.convert("RGB").crop((pad, pad, pad + 768, pad + 768))


def render_orion_side_flap(
    seed: int,
    strength_text: str,
    expiry_text: str,
    lot_code: str,
    tilt_deg: float,
) -> Image.Image:
    pad = 80
    size = 768 + 2 * pad
    bg = render_counter_backdrop(seed, size)
    accent = (20, 102, 148)

    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    fx0, fy0, fx1, fy1 = pad + 242, pad + 118, pad + 562, pad + 646
    fw, fh = fx1 - fx0, fy1 - fy0

    sh = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle(
        (fx0 - 38, fy0 + 18, fx1 + 16, fy1 + 22),
        radius=16,
        fill=(22, 18, 14, 102),
    )
    sh = sh.filter(ImageFilter.GaussianBlur(radius=13.0))
    layer = Image.alpha_composite(layer, sh)

    bevel = ImageDraw.Draw(layer)
    bevel.polygon(
        [(fx0 - 46, fy0 + 18), (fx0 + 4, fy0 + 2), (fx0 + 4, fy1 - 2), (fx0 - 46, fy1 - 16)],
        fill=(224, 229, 236, 255),
        outline=(158, 164, 174, 255),
    )
    bevel.polygon(
        [(fx0 - 46, fy0 + 18), (fx0 + 4, fy0 + 2), (fx0 + 4, fy0 + 66), (fx0 - 46, fy0 + 78)],
        fill=(15, 78, 114, 255),
    )

    flap = Image.new("RGB", (fw, fh), (251, 252, 254))
    flap = add_paper_grain(flap, seed + 29, amplitude=3)
    fd = ImageDraw.Draw(flap)

    fd.rectangle((0, 0, fw, 64), fill=accent)
    fd.text(
        (24, 20),
        "ORION PHARMA",
        fill=(248, 251, 254),
        font=ImageFont.load_default(size=22),
    )
    fd.text(
        (24, 88),
        "AMLODIPIN",
        fill=(12, 18, 28),
        font=ImageFont.load_default(size=40),
        stroke_width=1,
        stroke_fill=(12, 18, 28),
    )
    fd.text(
        (24, 138),
        "ORION",
        fill=(20, 102, 148),
        font=ImageFont.load_default(size=32),
        stroke_width=1,
        stroke_fill=(20, 102, 148),
    )

    fd.rounded_rectangle(
        (24, 194, fw - 24, 294),
        radius=12,
        fill=(238, 245, 252),
        outline=accent,
        width=4,
    )
    fd.text(
        (44, 214),
        strength_text,
        fill=(10, 16, 24),
        font=ImageFont.load_default(size=54),
        stroke_width=1,
        stroke_fill=(10, 16, 24),
    )

    fd.text((24, 316), "tabletti", fill=(26, 34, 44), font=ImageFont.load_default(size=27))
    fd.text((24, 352), "amlodipiini", fill=(52, 60, 72), font=ImageFont.load_default(size=23))

    fd.rounded_rectangle(
        (22, fh - 122, fw - 22, fh - 26),
        radius=10,
        fill=(242, 244, 248),
        outline=(152, 158, 168),
        width=2,
    )
    fd.text(
        (36, fh - 108),
        expiry_text,
        fill=(12, 16, 24),
        font=ImageFont.load_default(size=31),
        stroke_width=1,
        stroke_fill=(12, 16, 24),
    )
    fd.text(
        (36, fh - 62),
        f"Lot {lot_code}",
        fill=(48, 56, 66),
        font=ImageFont.load_default(size=21),
    )

    mask = Image.new("L", (fw, fh), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, fw - 1, fh - 1), radius=14, fill=255)
    layer.paste(flap, (fx0, fy0), mask)
    ImageDraw.Draw(layer).rounded_rectangle(
        (fx0, fy0, fx1 - 1, fy1 - 1),
        radius=14,
        outline=(162, 168, 178, 255),
        width=3,
    )

    rotated = layer.rotate(tilt_deg, resample=Image.Resampling.BICUBIC)
    composed = Image.alpha_composite(bg.convert("RGBA"), rotated).convert("RGB")
    return composed.crop((pad, pad, pad + 768, pad + 768))


def sample_tex_bilinear(
    tex_bytes: bytes,
    tex_w: int,
    tex_h: int,
    u: float,
    v: float,
) -> tuple[float, float, float]:
    uc = max(0.0, min(float(tex_w - 1), u))
    vc = max(0.0, min(float(tex_h - 1), v))
    x0 = int(math.floor(uc))
    y0 = int(math.floor(vc))
    x1 = min(tex_w - 1, x0 + 1)
    y1 = min(tex_h - 1, y0 + 1)
    fx = uc - x0
    fy = vc - y0

    i00 = (y0 * tex_w + x0) * 3
    i10 = (y0 * tex_w + x1) * 3
    i01 = (y1 * tex_w + x0) * 3
    i11 = (y1 * tex_w + x1) * 3

    w00 = (1.0 - fx) * (1.0 - fy)
    w10 = fx * (1.0 - fy)
    w01 = (1.0 - fx) * fy
    w11 = fx * fy

    r = tex_bytes[i00] * w00 + tex_bytes[i10] * w10 + tex_bytes[i01] * w01 + tex_bytes[i11] * w11
    g = tex_bytes[i00 + 1] * w00 + tex_bytes[i10 + 1] * w10 + tex_bytes[i01 + 1] * w01 + tex_bytes[i11 + 1] * w11
    b = tex_bytes[i00 + 2] * w00 + tex_bytes[i10 + 2] * w10 + tex_bytes[i01 + 2] * w01 + tex_bytes[i11 + 2] * w11
    return r, g, b


def white_bottle_rgb(theta: float) -> tuple[float, float, float]:
    cos_t = math.cos(theta)
    light = max(0.0, math.cos(theta + 0.40))
    rim_spec = math.exp(-((theta + 1.06) / 0.14) ** 2) * 0.60 + math.exp(-((theta - 1.22) / 0.11) ** 2) * 0.28
    shade = 0.68 + 0.30 * light + 0.06 * cos_t
    return (
        244.0 * shade + 28.0 * rim_spec,
        246.0 * shade + 28.0 * rim_spec,
        250.0 * shade + 28.0 * rim_spec,
    )


def render_cylindrical_white_bottle(
    seed: int,
    label_tex: Image.Image,
    theta_rot_deg: float,
    label_span_deg: float = 142.0,
    radius: int = 194,
) -> Image.Image:
    canvas = render_counter_backdrop(seed, 768)
    xc = 384
    cap_r = int(radius * 0.76)
    cap_y0, cap_y1 = 96, 172
    neck_y1 = 212
    body_y0, body_y1 = neck_y1, 646
    label_y0, label_y1 = 248, 594
    sag_px = 11.0

    shadow = Image.new("RGBA", (768, 768), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).ellipse(
        (xc - radius - 22, body_y1 - 24, xc + radius + 28, body_y1 + 36),
        fill=(24, 18, 12, 116),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=14.0))
    canvas = Image.alpha_composite(canvas.convert("RGBA"), shadow).convert("RGB")
    draw = ImageDraw.Draw(canvas)

    for dx in range(-cap_r, cap_r + 1):
        s_cap = max(-0.999, min(0.999, dx / float(cap_r)))
        th = math.asin(s_cap)
        rib = 0.94 + 0.06 * math.cos(th * 28.0)
        light = 0.66 + 0.34 * max(0.0, math.cos(th + 0.44))
        cr = clamp_byte(246.0 * light * rib)
        cg = clamp_byte(248.0 * light * rib)
        cb = clamp_byte(251.0 * light * rib)
        sag_c = int(round(5.0 * (1.0 - math.cos(th))))
        draw.line((xc + dx, cap_y0 + sag_c, xc + dx, cap_y1 + sag_c), fill=(cr, cg, cb))

    draw.ellipse((xc - cap_r, cap_y0 - 10, xc + cap_r, cap_y0 + 12), fill=(250, 251, 253), outline=(176, 178, 182))

    for y in range(cap_y1, neck_y1):
        t = (y - cap_y1) / max(1, neck_y1 - cap_y1)
        cur_r = int(round(cap_r * 0.92 * (1.0 - t) + radius * t))
        for dx in range(-cur_r, cur_r + 1):
            th = math.asin(max(-0.999, min(0.999, dx / max(1.0, float(cur_r)))))
            rb, gb, bb = white_bottle_rgb(th)
            draw.point((xc + dx, y), fill=(clamp_byte(rb), clamp_byte(gb), clamp_byte(bb)))

    tex_rgb = label_tex.convert("RGB")
    tex_w, tex_h = tex_rgb.size
    tex_bytes = tex_rgb.tobytes()

    theta_rot = math.radians(theta_rot_deg)
    label_span = math.radians(label_span_deg)
    half_span = 0.5 * label_span
    label_h = float(label_y1 - label_y0)
    canvas_bytes = bytearray(canvas.tobytes())

    for dx in range(-radius, radius + 1):
        px = xc + dx
        if px < 0 or px >= 768:
            continue
        theta_mid = math.asin(max(-0.9995, min(0.9995, dx / float(radius))))
        sag = sag_px * math.cos(theta_mid)
        col_bot = int(round(body_y1 + sag))

        u_samples: list[float] = []
        in_label = True
        for off in (-0.33, 0.0, 0.33):
            th_sub = math.asin(max(-0.9995, min(0.9995, (dx + off) / float(radius))))
            phi_sub = th_sub - theta_rot
            if abs(phi_sub) > half_span:
                in_label = False
                break
            u_samples.append(((phi_sub / label_span) + 0.5) * (tex_w - 1))

        paper_shade = 0.64 + 0.36 * max(0.0, math.cos(theta_mid + 0.38))
        paper_spec = math.exp(-((theta_mid + 1.06) / 0.16) ** 2) * 24.0
        lbl_top = label_y0 + sag
        lbl_bot = label_y1 + sag

        for py in range(max(0, body_y0), min(768, col_bot)):
            if in_label and lbl_top <= py <= lbl_bot:
                v_coord = ((py - lbl_top) / max(1.0, label_h)) * (tex_h - 1)
                ar, ag, ab = 0.0, 0.0, 0.0
                for u_c in u_samples:
                    sr, sg, sb = sample_tex_bilinear(tex_bytes, tex_w, tex_h, u_c, v_coord)
                    ar += sr
                    ag += sg
                    ab += sb
                inv_n = 1.0 / len(u_samples)
                pr = (ar * inv_n) * paper_shade + paper_spec
                pg = (ag * inv_n) * paper_shade + paper_spec
                pb = (ab * inv_n) * paper_shade + paper_spec
            else:
                pr, pg, pb = white_bottle_rgb(theta_mid)
            idx = (py * 768 + px) * 3
            canvas_bytes[idx] = clamp_byte(pr)
            canvas_bytes[idx + 1] = clamp_byte(pg)
            canvas_bytes[idx + 2] = clamp_byte(pb)

    return Image.frombytes("RGB", (768, 768), bytes(canvas_bytes))


def render_metformin_bottle_left(seed: int) -> Image.Image:
    tex_w, tex_h = 960, 660
    tex = Image.new("RGB", (tex_w, tex_h), (252, 251, 247))
    draw = ImageDraw.Draw(tex)
    accent = (32, 92, 162)
    draw.rectangle((0, 0, tex_w - 1, tex_h - 1), outline=(194, 190, 182), width=6)
    draw.rectangle((6, 6, tex_w - 7, 96), fill=accent)
    draw.text((54, 28), "NORDIC RX PHARMACY", fill=(250, 252, 254), font=ImageFont.load_default(size=34))
    draw.text(
        (54, 134),
        "METFORMIN",
        fill=(12, 18, 28),
        font=ImageFont.load_default(size=78),
        stroke_width=1,
        stroke_fill=(12, 18, 28),
    )
    draw.line((54, 246, 760, 246), fill=(208, 204, 196), width=3)
    draw.text((54, 276), "Active substance: metformin", fill=(24, 30, 40), font=ImageFont.load_default(size=44))
    draw.text((54, 344), "Film-coated oral tablets", fill=(42, 50, 62), font=ImageFont.load_default(size=40))
    draw.text((54, 412), "Rotate bottle for strength & date", fill=(74, 82, 94), font=ImageFont.load_default(size=34))
    return render_cylindrical_white_bottle(seed, tex, theta_rot_deg=48.0)


def render_metformin_bottle_right(seed: int) -> Image.Image:
    tex_w, tex_h = 960, 660
    tex = Image.new("RGB", (tex_w, tex_h), (252, 251, 247))
    draw = ImageDraw.Draw(tex)
    accent = (32, 92, 162)
    draw.rectangle((0, 0, tex_w - 1, tex_h - 1), outline=(194, 190, 182), width=6)
    draw.rectangle((6, 6, tex_w - 7, 96), fill=accent)
    draw.text((140, 28), "NORDIC RX PHARMACY", fill=(250, 252, 254), font=ImageFont.load_default(size=34))
    draw.text((140, 122), "metformin HCl", fill=(36, 44, 56), font=ImageFont.load_default(size=42))
    draw.rounded_rectangle(
        (140, 188, 520, 304),
        radius=16,
        fill=(238, 245, 252),
        outline=accent,
        width=5,
    )
    draw.text(
        (170, 204),
        "500 mg",
        fill=(10, 16, 24),
        font=ImageFont.load_default(size=76),
        stroke_width=1,
        stroke_fill=(10, 16, 24),
    )
    draw.text(
        (140, 334),
        "500 mg tablets",
        fill=(16, 22, 32),
        font=ImageFont.load_default(size=48),
        stroke_width=1,
        stroke_fill=(16, 22, 32),
    )
    draw.text((140, 404), "Take with meals", fill=(36, 44, 56), font=ImageFont.load_default(size=40))
    draw.rounded_rectangle(
        (136, 488, 636, 588),
        radius=12,
        fill=(252, 240, 238),
        outline=(184, 42, 42),
        width=4,
    )
    draw.text(
        (164, 510),
        "EXP 2025-02",
        fill=(162, 22, 22),
        font=ImageFont.load_default(size=52),
        stroke_width=1,
        stroke_fill=(162, 22, 22),
    )
    return render_cylindrical_white_bottle(seed, tex, theta_rot_deg=-22.0)


def render_granola_bar_front(seed: int) -> Image.Image:
    pad = 80
    size = 768 + 2 * pad
    bg = render_counter_backdrop(seed, size)

    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    x0, y0, x1, y1 = pad + 92, pad + 214, pad + 676, pad + 558
    bw, bh = x1 - x0, y1 - y0
    accent = (148, 82, 28)

    sh = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle(
        (x0 - 18, y0 + 14, x1 + 32, y1 + 18),
        radius=16,
        fill=(24, 18, 12, 98),
    )
    sh = sh.filter(ImageFilter.GaussianBlur(radius=12.0))
    layer = Image.alpha_composite(layer, sh)

    ld = ImageDraw.Draw(layer)
    for crimp_x in (x0 - 22, x1):
        ld.rectangle((crimp_x, y0 + 8, crimp_x + 22, y1 - 8), fill=(224, 214, 196, 255), outline=(176, 164, 146, 255))
        for ry in range(y0 + 14, y1 - 12, 10):
            ld.line((crimp_x + 3, ry, crimp_x + 19, ry), fill=(186, 174, 156, 255), width=2)

    pack = Image.new("RGB", (bw, bh), (250, 244, 232))
    pack = add_paper_grain(pack, seed + 41, amplitude=4)
    pd = ImageDraw.Draw(pack)

    pd.rectangle((0, 0, bw, 68), fill=accent)
    pd.text((28, 20), "NORDIC CRUNCH", fill=(252, 248, 240), font=ImageFont.load_default(size=25))
    pd.text(
        (28, 92),
        "Nordic Crunch",
        fill=(48, 26, 12),
        font=ImageFont.load_default(size=46),
        stroke_width=1,
        stroke_fill=(48, 26, 12),
    )
    pd.text(
        (28, 150),
        "Granola Bar 45g",
        fill=(84, 46, 18),
        font=ImageFont.load_default(size=40),
        stroke_width=1,
        stroke_fill=(84, 46, 18),
    )
    pd.text((28, 214), "Crispy Baked Snack Bar", fill=(72, 58, 44), font=ImageFont.load_default(size=25))
    pd.text(
        (28, bh - 48),
        "See back of wrapper for ingredients",
        fill=(94, 80, 66),
        font=ImageFont.load_default(size=21),
    )

    mask = Image.new("L", (bw, bh), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, bw - 1, bh - 1), radius=12, fill=255)
    layer.paste(pack, (x0, y0), mask)
    ld.rounded_rectangle((x0, y0, x1 - 1, y1 - 1), radius=12, outline=(168, 152, 132, 255), width=3)

    rotated = layer.rotate(-1.8, resample=Image.Resampling.BICUBIC)
    composed = Image.alpha_composite(bg.convert("RGBA"), rotated).convert("RGB")
    return composed.crop((pad, pad, pad + 768, pad + 768))


def render_granola_bar_back(seed: int) -> Image.Image:
    pad = 80
    size = 768 + 2 * pad
    bg = render_counter_backdrop(seed, size)

    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    x0, y0, x1, y1 = pad + 82, pad + 186, pad + 686, pad + 584
    bw, bh = x1 - x0, y1 - y0
    accent = (148, 82, 28)

    sh = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle(
        (x0 - 18, y0 + 14, x1 + 32, y1 + 18),
        radius=16,
        fill=(24, 18, 12, 98),
    )
    sh = sh.filter(ImageFilter.GaussianBlur(radius=12.0))
    layer = Image.alpha_composite(layer, sh)

    ld = ImageDraw.Draw(layer)
    for crimp_x in (x0 - 22, x1):
        ld.rectangle((crimp_x, y0 + 8, crimp_x + 22, y1 - 8), fill=(224, 214, 196, 255), outline=(176, 164, 146, 255))
        for ry in range(y0 + 14, y1 - 12, 10):
            ld.line((crimp_x + 3, ry, crimp_x + 19, ry), fill=(186, 174, 156, 255), width=2)

    pack = Image.new("RGB", (bw, bh), (251, 248, 241))
    pack = add_paper_grain(pack, seed + 53, amplitude=3)
    pd = ImageDraw.Draw(pack)

    pd.rectangle((0, 0, bw, 58), fill=accent)
    pd.text(
        (24, 16),
        "NORDIC CRUNCH  -  Granola Bar 45g",
        fill=(252, 248, 240),
        font=ImageFont.load_default(size=23),
    )
    pd.rounded_rectangle(
        (22, 76, bw - 22, 238),
        radius=10,
        fill=(255, 255, 255),
        outline=(176, 168, 154),
        width=2,
    )
    pd.text(
        (36, 94),
        "Ingredients: rolled oats, honey,",
        fill=(14, 18, 20),
        font=ImageFont.load_default(size=27),
        stroke_width=1,
        stroke_fill=(14, 18, 20),
    )
    pd.text(
        (36, 134),
        "roasted hazelnuts (14%), cocoa.",
        fill=(14, 18, 20),
        font=ImageFont.load_default(size=27),
        stroke_width=1,
        stroke_fill=(14, 18, 20),
    )
    pd.text(
        (36, 184),
        "Allergens: contains hazelnuts (tree nuts), oats.",
        fill=(124, 34, 16),
        font=ImageFont.load_default(size=23),
        stroke_width=1,
        stroke_fill=(124, 34, 16),
    )

    pd.rounded_rectangle(
        (22, 258, bw - 22, 318),
        radius=8,
        fill=(248, 246, 240),
        outline=(176, 168, 154),
        width=2,
    )
    pd.text(
        (36, 274),
        "Best before: 2027-09",
        fill=(20, 24, 28),
        font=ImageFont.load_default(size=26),
    )

    mask = Image.new("L", (bw, bh), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, bw - 1, bh - 1), radius=12, fill=255)
    layer.paste(pack, (x0, y0), mask)
    ld.rounded_rectangle((x0, y0, x1 - 1, y1 - 1), radius=12, outline=(168, 152, 132, 255), width=3)

    rotated = layer.rotate(1.6, resample=Image.Resampling.BICUBIC)
    composed = Image.alpha_composite(bg.convert("RGBA"), rotated).convert("RGB")
    return composed.crop((pad, pad, pad + 768, pad + 768))


def render_barista_carton_front(seed: int) -> Image.Image:
    pad = 80
    size = 768 + 2 * pad
    bg = render_counter_backdrop(seed, size)

    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    x0, y0, x1, y1 = pad + 174, pad + 98, pad + 594, pad + 686
    cw, ch = x1 - x0, y1 - y0
    accent = (36, 102, 94)

    sh = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle((x0 + 12, y0 + 16, x1 + 18, y1 + 20), radius=16, fill=(22, 18, 14, 96))
    sh = sh.filter(ImageFilter.GaussianBlur(radius=12.0))
    layer = Image.alpha_composite(layer, sh)

    ImageDraw.Draw(layer).rounded_rectangle(
        (x0 + cw // 2 - 48, y0 - 28, x0 + cw // 2 + 48, y0 + 8),
        radius=8,
        fill=(242, 244, 242, 255),
        outline=(168, 174, 170, 255),
        width=2,
    )

    carton = Image.new("RGB", (cw, ch), (246, 248, 245))
    carton = add_paper_grain(carton, seed + 61, amplitude=3)
    cd = ImageDraw.Draw(carton)

    cd.rectangle((0, 0, cw, 74), fill=accent)
    cd.text((28, 24), "NORDIC BARISTA", fill=(246, 250, 248), font=ImageFont.load_default(size=24))
    cd.text(
        (28, 108),
        "Nordic Barista",
        fill=(14, 28, 26),
        font=ImageFont.load_default(size=44),
        stroke_width=1,
        stroke_fill=(14, 28, 26),
    )
    cd.text(
        (28, 168),
        "Drink 1L",
        fill=(24, 62, 56),
        font=ImageFont.load_default(size=42),
        stroke_width=1,
        stroke_fill=(24, 62, 56),
    )
    cd.text((28, 236), "Foamable Cafe Edition", fill=(54, 68, 64), font=ImageFont.load_default(size=25))
    cd.rounded_rectangle((28, 300, 146, 368), radius=10, fill=(232, 242, 238), outline=accent, width=3)
    cd.text((54, 316), "1L", fill=(16, 36, 32), font=ImageFont.load_default(size=36), stroke_width=1, stroke_fill=(16, 36, 32))
    cd.text(
        (28, ch - 56),
        "See back panel for ingredients",
        fill=(78, 90, 86),
        font=ImageFont.load_default(size=21),
    )

    mask = Image.new("L", (cw, ch), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, cw - 1, ch - 1), radius=16, fill=255)
    layer.paste(carton, (x0, y0), mask)
    ImageDraw.Draw(layer).rounded_rectangle((x0, y0, x1 - 1, y1 - 1), radius=16, outline=(162, 170, 166, 255), width=3)

    rotated = layer.rotate(1.4, resample=Image.Resampling.BICUBIC)
    composed = Image.alpha_composite(bg.convert("RGBA"), rotated).convert("RGB")
    return composed.crop((pad, pad, pad + 768, pad + 768))


def render_barista_carton_back(seed: int) -> Image.Image:
    pad = 80
    size = 768 + 2 * pad
    bg = render_counter_backdrop(seed, size)

    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    x0, y0, x1, y1 = pad + 144, pad + 98, pad + 624, pad + 686
    cw, ch = x1 - x0, y1 - y0
    accent = (36, 102, 94)

    sh = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle((x0 + 12, y0 + 16, x1 + 18, y1 + 20), radius=16, fill=(22, 18, 14, 96))
    sh = sh.filter(ImageFilter.GaussianBlur(radius=12.0))
    layer = Image.alpha_composite(layer, sh)

    ImageDraw.Draw(layer).rounded_rectangle(
        (x0 + cw // 2 - 48, y0 - 28, x0 + cw // 2 + 48, y0 + 8),
        radius=8,
        fill=(242, 244, 242, 255),
        outline=(168, 174, 170, 255),
        width=2,
    )

    carton = Image.new("RGB", (cw, ch), (248, 250, 247))
    carton = add_paper_grain(carton, seed + 71, amplitude=3)
    cd = ImageDraw.Draw(carton)

    cd.rectangle((0, 0, cw, 70), fill=accent)
    cd.text(
        (26, 22),
        "NORDIC BARISTA DRINK  -  1L",
        fill=(246, 250, 248),
        font=ImageFont.load_default(size=23),
    )

    cd.rounded_rectangle(
        (24, 98, cw - 24, 272),
        radius=12,
        fill=(255, 255, 255),
        outline=(164, 172, 168),
        width=2,
    )
    cd.text(
        (38, 118),
        "Ingredients: water, oats (10%),",
        fill=(12, 18, 16),
        font=ImageFont.load_default(size=26),
        stroke_width=1,
        stroke_fill=(12, 18, 16),
    )
    cd.text(
        (38, 160),
        "rapeseed oil, sea salt.",
        fill=(12, 18, 16),
        font=ImageFont.load_default(size=26),
        stroke_width=1,
        stroke_fill=(12, 18, 16),
    )
    cd.text(
        (38, 214),
        "Allergens: contains oats (gluten).",
        fill=(22, 54, 48),
        font=ImageFont.load_default(size=23),
        stroke_width=1,
        stroke_fill=(22, 54, 48),
    )

    cd.rounded_rectangle(
        (24, 300, cw - 24, 372),
        radius=10,
        fill=(255, 255, 255),
        outline=(164, 172, 168),
        width=2,
    )
    cd.text(
        (38, 320),
        "Best before 2027-11",
        fill=(12, 18, 18),
        font=ImageFont.load_default(size=28),
        stroke_width=1,
        stroke_fill=(12, 18, 18),
    )

    mask = Image.new("L", (cw, ch), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, cw - 1, ch - 1), radius=16, fill=255)
    layer.paste(carton, (x0, y0), mask)
    ImageDraw.Draw(layer).rounded_rectangle((x0, y0, x1 - 1, y1 - 1), radius=16, outline=(162, 170, 166, 255), width=3)

    rotated = layer.rotate(-1.3, resample=Image.Resampling.BICUBIC)
    composed = Image.alpha_composite(bg.convert("RGBA"), rotated).convert("RGB")
    return composed.crop((pad, pad, pad + 768, pad + 768))


def render_barcode_back_box(seed: int, barcode_digits: str) -> Image.Image:
    pad = 80
    size = 768 + 2 * pad
    bg = render_counter_backdrop(seed, size)

    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    x0, y0, x1, y1 = pad + 88, pad + 146, pad + 680, pad + 618
    bw, bh = x1 - x0, y1 - y0

    sh = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle((x0 + 12, y0 + 16, x1 + 16, y1 + 20), radius=18, fill=(24, 20, 16, 94))
    sh = sh.filter(ImageFilter.GaussianBlur(radius=12.0))
    layer = Image.alpha_composite(layer, sh)

    card = Image.new("RGB", (bw, bh), (249, 250, 252))
    card = add_paper_grain(card, seed + 83, amplitude=3)
    cd = ImageDraw.Draw(card)

    cd.rectangle((0, 0, bw, 14), fill=(186, 34, 44))
    cd.line((36, bh // 2 - 44, bw - 36, bh // 2 - 44), fill=(228, 230, 234), width=2)

    bx0, by0, bx1, by1 = bw // 2 - 156, bh - 208, bw // 2 + 156, bh - 46
    cd.rounded_rectangle((bx0, by0, bx1, by1), radius=8, fill=(255, 255, 255), outline=(196, 200, 206), width=2)

    rng = random.Random(seed + 909)
    cur_x = bx0 + 24
    while cur_x < bx1 - 26:
        bar_w = rng.choice((2, 3, 5))
        gap_w = rng.choice((2, 3, 4))
        if cur_x + bar_w < bx1 - 24:
            cd.rectangle((cur_x, by0 + 16, cur_x + bar_w, by1 - 48), fill=(14, 16, 20))
        cur_x += bar_w + gap_w

    cd.text(
        (bx0 + 48, by1 - 40),
        barcode_digits,
        fill=(12, 16, 20),
        font=ImageFont.load_default(size=28),
        stroke_width=1,
        stroke_fill=(12, 16, 20),
    )

    mask = Image.new("L", (bw, bh), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, bw - 1, bh - 1), radius=16, fill=255)
    layer.paste(card, (x0, y0), mask)
    ImageDraw.Draw(layer).rounded_rectangle((x0, y0, x1 - 1, y1 - 1), radius=16, outline=(170, 176, 184, 255), width=3)

    rotated = layer.rotate(-2.1, resample=Image.Resampling.BICUBIC)
    composed = Image.alpha_composite(bg.convert("RGBA"), rotated).convert("RGB")
    return composed.crop((pad, pad, pad + 768, pad + 768))


def render_burana_front_box(seed: int) -> Image.Image:
    pad = 80
    size = 768 + 2 * pad
    bg = render_counter_backdrop(seed, size)

    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    x0, y0, x1, y1 = pad + 88, pad + 146, pad + 680, pad + 618
    bw, bh = x1 - x0, y1 - y0
    accent = (186, 34, 44)

    sh = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle((x0 + 12, y0 + 16, x1 + 16, y1 + 20), radius=18, fill=(24, 20, 16, 94))
    sh = sh.filter(ImageFilter.GaussianBlur(radius=12.0))
    layer = Image.alpha_composite(layer, sh)

    card = Image.new("RGB", (bw, bh), (252, 252, 254))
    card = add_paper_grain(card, seed + 97, amplitude=3)
    cd = ImageDraw.Draw(card)

    cd.rectangle((0, 0, bw, 68), fill=accent)
    cd.text(
        (28, 22),
        "ORION PHARMA    Vnr 01 66 40",
        fill=(252, 248, 248),
        font=ImageFont.load_default(size=23),
    )
    cd.text(
        (28, 94),
        "BURANA",
        fill=(164, 22, 32),
        font=ImageFont.load_default(size=54),
        stroke_width=1,
        stroke_fill=(164, 22, 32),
    )
    cd.text(
        (28, 162),
        "Vaikuttava aine: ibuprofeeni",
        fill=(24, 30, 38),
        font=ImageFont.load_default(size=26),
    )

    cd.rounded_rectangle(
        (28, 214, 268, 306),
        radius=12,
        fill=(254, 242, 242),
        outline=accent,
        width=4,
    )
    cd.text(
        (48, 232),
        "400 mg",
        fill=(14, 18, 24),
        font=ImageFont.load_default(size=50),
        stroke_width=1,
        stroke_fill=(14, 18, 24),
    )
    cd.text((288, 244), "tabletti", fill=(28, 34, 42), font=ImageFont.load_default(size=28))
    cd.text((28, bh - 68), "30 tablettia", fill=(42, 48, 58), font=ImageFont.load_default(size=24))
    cd.text(
        (bw - 216, bh - 68),
        "EXP 2027-11",
        fill=(20, 26, 34),
        font=ImageFont.load_default(size=25),
        stroke_width=1,
        stroke_fill=(20, 26, 34),
    )

    mask = Image.new("L", (bw, bh), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, bw - 1, bh - 1), radius=16, fill=255)
    layer.paste(card, (x0, y0), mask)
    ImageDraw.Draw(layer).rounded_rectangle((x0, y0, x1 - 1, y1 - 1), radius=16, outline=(170, 176, 184, 255), width=3)

    rotated = layer.rotate(2.0, resample=Image.Resampling.BICUBIC)
    composed = Image.alpha_composite(bg.convert("RGBA"), rotated).convert("RGB")
    return composed.crop((pad, pad, pad + 768, pad + 768))


def render_pair_images(spec: dict[str, Any]) -> tuple[Image.Image, Image.Image]:
    pid = spec["id"]
    seed = int(spec["seed"])

    if pid == "mf_01":
        f1 = render_thumb_occluded_orion_front(
            seed=seed,
            vnr_code="Vnr 08 44 12",
            subtitle_line="Vaikuttava aine: amlodipiini",
            tilt_deg=-1.8,
        )
        f2 = render_orion_side_flap(
            seed=seed,
            strength_text="5 mg",
            expiry_text="EXP 2027-10",
            lot_code="2410A",
            tilt_deg=1.6,
        )
        return f1, f2

    if pid == "mf_02":
        f1 = render_thumb_occluded_orion_front(
            seed=seed,
            vnr_code="Vnr 08 44 38",
            subtitle_line="",
            tilt_deg=1.9,
        )
        f2 = render_orion_side_flap(
            seed=seed,
            strength_text="10 mg",
            expiry_text="EXP 2027-10",
            lot_code="2411B",
            tilt_deg=-1.5,
        )
        return f1, f2

    if pid == "mf_03":
        return render_metformin_bottle_left(seed), render_metformin_bottle_right(seed)

    if pid == "mf_04":
        return render_granola_bar_front(seed), render_granola_bar_back(seed)

    if pid == "mf_05":
        return render_barista_carton_front(seed), render_barista_carton_back(seed)

    if pid == "mf_06":
        return render_barcode_back_box(seed, "6432100099999"), render_burana_front_box(seed)

    raise ValueError(f"Unknown pair id: {pid}")


def save_jpeg(img: Image.Image, out_path: pathlib.Path) -> int:
    if img.size != (768, 768):
        raise RuntimeError(f"Expected 768x768 image for {out_path.name}, got {img.size}")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="JPEG", quality=90)
    raw = buf.getvalue()
    out_path.write_bytes(raw)
    return len(raw)


def parse_env_file(env_path: pathlib.Path) -> dict[str, str]:
    parsed: dict[str, str] = {}
    if not env_path.is_file():
        return parsed
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith(COMMENT_CHAR):
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        if k:
            parsed[k] = v
    return parsed


def build_runner_env(ledger_path: pathlib.Path) -> dict[str, str]:
    deps_nm = pathlib.Path("/tmp/fleet-silas/meta-deps/node_modules")
    local_nm = REPO_ROOT / "node_modules"
    if not local_nm.exists() and deps_nm.is_dir():
        local_nm.symlink_to(deps_nm)

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


def compact_verdict(verdict_full: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    read_obj = scrub_node(verdict_full.get("read") or {})
    verdict_meta: dict[str, Any] = {
        "level": str(verdict_full.get("level") or "unsure"),
        "headline": scrub_node(verdict_full.get("headline") or ""),
        "speech": scrub_node(verdict_full.get("speech") or ""),
        "reasons": scrub_node(verdict_full.get("reasons") or []),
    }
    if "matchedMedId" in verdict_full:
        verdict_meta["matchedMedId"] = scrub_node(verdict_full["matchedMedId"])
    if "takenToday" in verdict_full:
        verdict_meta["takenToday"] = bool(verdict_full["takenToday"])
    return read_obj, verdict_meta


def run_benchmark(render_only: bool = False) -> dict[str, Any]:
    OUT_IMG_DIR.mkdir(parents=True, exist_ok=True)
    rendered_pairs: list[dict[str, Any]] = []

    for spec in PAIR_SPECS:
        img1, img2 = render_pair_images(spec)
        f1_path = OUT_IMG_DIR / f'{spec["id"]}_f1.jpg'
        f2_path = OUT_IMG_DIR / f'{spec["id"]}_f2.jpg'
        b1 = save_jpeg(img1, f1_path)
        b2 = save_jpeg(img2, f2_path)
        rendered_pairs.append(
            {
                "spec": spec,
                "frame1_abs": str(f1_path),
                "frame2_abs": str(f2_path),
                "frame1_rel": str(f1_path.relative_to(REPO_ROOT)),
                "frame2_rel": str(f2_path.relative_to(REPO_ROOT)),
                "frame1_bytes": b1,
                "frame2_bytes": b2,
            }
        )

    if render_only:
        return {
            "rendered_pairs": len(rendered_pairs),
            "rendered_images": len(rendered_pairs) * 2,
            "out_dir": str(OUT_IMG_DIR.relative_to(REPO_ROOT)),
        }

    with tempfile.TemporaryDirectory(prefix="holdup_multiframe_") as tmp_dir:
        tmp_root = pathlib.Path(tmp_dir)
        ledger_path = tmp_root / "ledger.jsonl"
        cfg_path = tmp_root / "runner_cfg.json"
        raw_out_path = tmp_root / "runner_out.json"

        runner_env = build_runner_env(ledger_path)
        if not runner_env.get("GEMINI_API_KEY"):
            raise RuntimeError("GEMINI_API_KEY is missing from environment and $HOME/momin/.env")

        node_bin = shutil.which("node", path=runner_env.get("PATH"))
        if not node_bin:
            raise RuntimeError("node binary not found on PATH")

        cfg_payload = {
            "modelName": MODEL_NAME,
            "outPath": str(raw_out_path),
            "pairs": [
                {
                    "id": rp["spec"]["id"],
                    "question": rp["spec"]["question"],
                    "expected_strength": rp["spec"]["expected_strength"],
                    "frame1_abs": rp["frame1_abs"],
                    "frame2_abs": rp["frame2_abs"],
                }
                for rp in rendered_pairs
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
            raise RuntimeError(f"TypeScript verify() runner failed ({proc.returncode}): {scrub_node(proc.stderr[:500])}")

        ts_out = json.loads(raw_out_path.read_text(encoding="utf-8"))

    min_conf = float(ts_out.get("strength_min_conf") or STRENGTH_MIN_CONF)
    demo_profile = scrub_node(ts_out.get("profile") or {})
    ledger_rows = ts_out.get("ledger_rows") or []

    tokens_by_feature: dict[str, dict[str, int]] = {}
    for row in ledger_rows:
        feat = str(row.get("feature") or "")
        agg = tokens_by_feature.setdefault(feat, {"in": 0, "out": 0, "thinking": 0})
        agg["in"] += int(row.get("in") or 0)
        agg["out"] += int(row.get("out") or 0)
        agg["thinking"] += int(row.get("thinking") or 0)

    ts_by_id = {row["id"]: row for row in ts_out["pairs"]}
    items_out: list[dict[str, Any]] = []
    single_cwd_total = 0
    paired_cwd_total = 0

    for rp in rendered_pairs:
        spec = rp["spec"]
        pid = spec["id"]
        tr = ts_by_id[pid]

        s_read, s_verdict = compact_verdict(tr["single_verdict"])
        p_read, p_verdict = compact_verdict(tr["paired_verdict"])

        s_level = s_verdict["level"]
        p_level = p_verdict["level"]
        exp_single = str(spec["expected_single_level"])
        exp_paired = str(spec["expected_paired_level"])

        s_strength_field = s_read.get("strength") or {}
        s_sval = s_strength_field.get("value")
        s_sconf = round(float(s_strength_field.get("confidence") or 0.0), 4)

        p_strength_field = p_read.get("strength") or {}
        p_sval = p_strength_field.get("value")
        p_sconf = round(float(p_strength_field.get("confidence") or 0.0), 4)

        single_cwd = bool(
            (s_sval is not None and s_sconf >= min_conf)
            or s_sconf >= min_conf
            or s_level == "match"
            or (pid == "mf_04" and s_level == "info")
        )
        single_abstained = bool(s_level == exp_single and not single_cwd)

        paired_sr = bool(spec["paired_strength_readable"])
        if paired_sr:
            paired_strength_ok = bool(
                p_sval is not None
                and p_sconf >= min_conf
                and bool(tr["paired_strength_matches"])
            )
            paired_cwd = bool(
                (p_sconf >= min_conf and (p_sval is None or not bool(tr["paired_strength_matches"])))
                or (exp_paired != "match" and p_level == "match")
            )
        else:
            paired_strength_ok = None
            paired_cwd = bool(
                (p_sval is not None and p_sconf >= min_conf)
                or (exp_paired != "match" and p_level == "match")
                or (pid == "mf_04" and p_level == "info")
            )

        paired_match = p_level == exp_paired
        pair_cwd = bool(single_cwd or paired_cwd)
        if single_cwd:
            single_cwd_total += 1
        if paired_cwd:
            paired_cwd_total += 1

        s_tok = tokens_by_feature.get(tr["single_tag"], {"in": 0, "out": 0, "thinking": 0})
        p_tok = tokens_by_feature.get(tr["paired_tag"], {"in": 0, "out": 0, "thinking": 0})

        row_out = {
            "id": pid,
            "category": spec["category"],
            "description": spec["description"],
            "question": spec["question"],
            "frame1_path": rp["frame1_rel"],
            "frame2_path": rp["frame2_rel"],
            "width": 768,
            "height": 768,
            "frame1_bytes": rp["frame1_bytes"],
            "frame2_bytes": rp["frame2_bytes"],
            "frame1_sharpness": tr["frame1_sharpness"],
            "frame2_sharpness": tr["frame2_sharpness"],
            "ring_single_picked": tr["ring_single_picked"],
            "ring_paired_picked": tr["ring_paired_picked"],
            "expected_single_level": exp_single,
            "predicted_single_level": s_level,
            "single_safe_abstained": single_abstained,
            "expected_paired_level": exp_paired,
            "predicted_paired_level": p_level,
            "paired_verdict_match": paired_match,
            "expected_strength": spec["expected_strength"],
            "paired_strength_value": p_sval,
            "paired_strength_confidence": p_sconf,
            "paired_strength_correct": paired_strength_ok,
            "single_confident_wrong_dose": single_cwd,
            "paired_confident_wrong_dose": paired_cwd,
            "confident_wrong_dose": pair_cwd,
            "single": {
                "model": tr["single_model"],
                "frames": tr["single_frames"],
                "latency_ms": round(float(tr["single_latency_ms"]), 1),
                "tokens_in": s_tok["in"],
                "tokens_out": s_tok["out"],
                "tokens_thinking": s_tok["thinking"],
                "read": s_read,
                "verdict": s_verdict,
            },
            "paired": {
                "model": tr["paired_model"],
                "frames": tr["paired_frames"],
                "latency_ms": round(float(tr["paired_latency_ms"]), 1),
                "tokens_in": p_tok["in"],
                "tokens_out": p_tok["out"],
                "tokens_thinking": p_tok["thinking"],
                "read": p_read,
                "verdict": p_verdict,
            },
        }
        items_out.append(row_out)
        print(
            f'[{pid}] single={s_level} (exp={exp_single}, abstained={single_abstained}, {tr["single_latency_ms"]:.0f}ms) '
            f'-> paired={p_level} (exp={exp_paired}, match={paired_match}, strength={p_sval}, {tr["paired_latency_ms"]:.0f}ms) '
            f"cwd={pair_cwd}"
        )

    n_pairs = len(items_out)
    total_calls = n_pairs * 2
    single_abstentions = sum(1 for it in items_out if it["single_safe_abstained"])
    paired_matches = sum(1 for it in items_out if it["paired_verdict_match"])
    med_items = [it for it in items_out if it["expected_strength"] is not None]
    med_hits = sum(1 for it in med_items if it["paired_strength_correct"])

    single_lats = [float(it["single"]["latency_ms"]) for it in items_out]
    paired_lats = [float(it["paired"]["latency_ms"]) for it in items_out]

    single_tok_in = sum(int(it["single"]["tokens_in"]) for it in items_out)
    paired_tok_in = sum(int(it["paired"]["tokens_in"]) for it in items_out)
    total_tok_in = single_tok_in + paired_tok_in
    total_tok_out = sum(int(it["single"]["tokens_out"]) + int(it["paired"]["tokens_out"]) for it in items_out)
    total_tok_think = sum(
        int(it["single"]["tokens_thinking"]) + int(it["paired"]["tokens_thinking"]) for it in items_out
    )

    summary: dict[str, Any] = {
        "model": MODEL_NAME,
        "thinking_level": "LOW",
        "n_pairs": n_pairs,
        "total_calls": total_calls,
        "single_frame_abstentions": single_abstentions,
        "single_frame_safe_abstention_rate": round(single_abstentions / n_pairs, 4) if n_pairs else 0.0,
        "paired_frame_verdict_matches": paired_matches,
        "paired_frame_verdict_accuracy": round(paired_matches / n_pairs, 4) if n_pairs else 0.0,
        "paired_strength_recall": round(med_hits / len(med_items), 4) if med_items else 0.0,
        "confident_wrong_dose_count": single_cwd_total + paired_cwd_total,
        "single_latency_p50_ms": percentile(single_lats, 0.50),
        "single_latency_p95_ms": percentile(single_lats, 0.95),
        "single_latency_mean_ms": round(statistics.mean(single_lats), 1) if single_lats else 0.0,
        "paired_latency_p50_ms": percentile(paired_lats, 0.50),
        "paired_latency_p95_ms": percentile(paired_lats, 0.95),
        "paired_latency_mean_ms": round(statistics.mean(paired_lats), 1) if paired_lats else 0.0,
        "tokens_in": total_tok_in,
        "tokens_out": total_tok_out,
        "tokens_thinking": total_tok_think,
        "single_tokens_in": single_tok_in,
        "paired_tokens_in": paired_tok_in,
    }

    report = scrub_node(
        {
            "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "model": MODEL_NAME,
            "profile_summary": {
                "meds": [
                    f"{m['name']} {m['strength']} ({'/'.join(m['schedule'])})"
                    for m in demo_profile.get("meds", [])
                ],
                "allergies": list(demo_profile.get("allergies", [])),
                "avoid": list(demo_profile.get("avoid", [])),
            },
            "summary": summary,
            "items": items_out,
        }
    )

    assert_clean_output(report)
    OUT_JSON_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Multi-frame complementary partial-view fusion benchmark"
    )
    parser.add_argument("--render-only", action="store_true", help="Render 768x768 JPEGs without API calls")
    args = parser.parse_args(argv)

    res = run_benchmark(render_only=args.render_only)
    if args.render_only:
        print(json.dumps(res, indent=2))
    else:
        print(json.dumps(res["summary"], indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
