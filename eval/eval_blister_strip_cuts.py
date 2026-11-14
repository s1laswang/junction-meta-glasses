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
OUT_IMG_DIR = REPO_ROOT / "eval" / "out" / "blister_strip_cuts"
OUT_JSON_PATH = REPO_ROOT / "eval" / "blister_strip_cuts_results.json"

MODEL_NAME = "gemini-3.8-flash"
EVAL_NOW_ISO = "2026-11-14T12:00:00Z"
STRENGTH_MIN_CONF = 0.80

EM_DASH = chr(0x2014)
EN_DASH = chr(0x2013)
COMMENT_CHAR = chr(35)
API_KEY_RE = re.compile("AI" + "za[0-9A-Za-z_-]{20,}")

CASE_SPECS: list[dict[str, Any]] = [
    {
        "id": "bs_01",
        "strip_condition": "intact_repeating_tiles",
        "cut_mode": "corner_scissor_trim_plus_one_popped_pocket",
        "question": "Is this my evening pill?",
        "description": "Partially popped and corner-scissor-trimmed silver blister strip with 3 intact repeating diagonal foil tiles reading Amlodipin 5 mg (amlodipiini / amlodipine) and EXP 2027-11",
        "intact_tile": True,
        "strength_readable": True,
        "expected_level": "match",
        "expected_strength": "5 mg",
        "seed": 1801,
    },
    {
        "id": "bs_02",
        "strip_condition": "intact_repeating_tiles",
        "cut_mode": "angled_left_scissor_trim_plus_popped_pocket",
        "question": "Can I take this painkiller?",
        "description": "Partially popped and scissor-trimmed silver blister strip with 3 intact repeating diagonal foil tiles reading Burana 400 mg (ibuprofeeni / ibuprofen) triggering NSAID avoid warning",
        "intact_tile": True,
        "strength_readable": True,
        "expected_level": "warning",
        "expected_strength": "400 mg",
        "seed": 1802,
    },
    {
        "id": "bs_03",
        "strip_condition": "intact_repeating_tiles",
        "cut_mode": "l_notch_scissor_cut_plus_popped_pocket",
        "question": "Is this my evening pill?",
        "description": "Scissor-notched blister foil strip with 1 popped pocket and 3 intact repeating diagonal foil tiles reading Amlodipin 10 mg triggering wrong-strength warning against 5 mg schedule",
        "intact_tile": True,
        "strength_readable": True,
        "expected_level": "warning",
        "expected_strength": "10 mg",
        "seed": 1803,
    },
    {
        "id": "bs_04",
        "strip_condition": "intact_repeating_tiles",
        "cut_mode": "bottom_left_scissor_trim_plus_popped_pocket",
        "question": "Is this my evening Metformin?",
        "description": "Partially popped and scissor-trimmed silver blister strip with 3 intact repeating tiles reading Metformin 500 mg and crimped seal EXP 2024-12 triggering expired warning",
        "intact_tile": True,
        "strength_readable": True,
        "expected_level": "warning",
        "expected_strength": "500 mg",
        "seed": 1804,
    },
    {
        "id": "bs_05",
        "strip_condition": "truncated_strength",
        "cut_mode": "all_pockets_punched_through_mg_digits",
        "question": "Is this my evening pill?",
        "description": "4-pocket metallic blister strip where every popped foil cavity punches directly through the numeric strength leaving only AMLODIPIN [foil hole] mg",
        "intact_tile": False,
        "strength_readable": False,
        "expected_level": "unsure",
        "expected_strength": None,
        "seed": 1805,
    },
    {
        "id": "bs_06",
        "strip_condition": "truncated_strength",
        "cut_mode": "single_pocket_scissor_stub",
        "question": "Is this my Metformin?",
        "description": "Scissor-trimmed single-pocket metallic foil stub where the right-hand scissor cut slices cleanly right after METFORMIN removing every strength digit",
        "intact_tile": False,
        "strength_readable": False,
        "expected_level": "unsure",
        "expected_strength": None,
        "seed": 1806,
    },
    {
        "id": "bs_07",
        "strip_condition": "truncated_strength",
        "cut_mode": "narrow_two_pocket_scissor_strip",
        "question": "What strength is this Panadol?",
        "description": "Scissor-trimmed 2-pocket Panadol foil strip where one tile has a punched foil hole over the digits (PANADOL [foil hole] mg) and the second tile is sliced off at PANADOL [scissor cut]",
        "intact_tile": False,
        "strength_readable": False,
        "expected_level": "unsure",
        "expected_strength": None,
        "seed": 1807,
    },
    {
        "id": "bs_08",
        "strip_condition": "truncated_strength",
        "cut_mode": "diagonal_scissor_stub_with_popped_cavity",
        "question": "Is this my blood pressure pill?",
        "description": "Diagonally scissor-trimmed 2-pocket Amlodipin foil stub combining AMLODIPIN [foil hole] mg on the popped pocket and AMLODIPIN [scissor cut] on the intact pocket",
        "intact_tile": False,
        "strength_readable": False,
        "expected_level": "unsure",
        "expected_strength": None,
        "seed": 1808,
    },
]

TS_VERIFY_RUNNER = """
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import { verify } from "./server/src/verify.ts";
import { checkLabel, sameStrength, STRENGTH_MIN_CONF } from "./server/src/safety.ts";
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
const evalNow = new Date(cfg.evalNowIso);
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
  const directVerdict = checkLabel(read, DEMO_PROFILE, evalNow);
  const parity = directVerdict.level === res.verdict.level;
  if (!parity) {
    throw new Error(`Parity mismatch on ${item.id}: ${directVerdict.level} vs ${res.verdict.level}`);
  }
  const strengthMatchesExpected = item.expected_strength
    ? sameStrength(read.strength.value, item.expected_strength)
    : null;

  results.push({
    id: item.id,
    model: res.model,
    latencyMs: res.latencyMs,
    frames: res.frames,
    verdict: directVerdict,
    verifyLevel: res.verdict.level,
    parity,
    strengthMatchesExpected,
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


def scrub_node(val: Any) -> Any:
    if isinstance(val, str):
        cleaned = val.replace(EM_DASH, " - ").replace(EN_DASH, "-")
        return API_KEY_RE.sub("[REDACTED]", cleaned)
    if isinstance(val, list):
        return [scrub_node(item) for item in val]
    if isinstance(val, dict):
        return {str(k): scrub_node(v) for k, v in val.items()}
    return val


def assert_clean_output(node: Any) -> None:
    if isinstance(node, str):
        if EM_DASH in node or EN_DASH in node:
            raise AssertionError(f"Forbidden dash in output: {node[:80]}")
        if API_KEY_RE.search(node):
            raise AssertionError("API key pattern found in output JSON")
        if node.startswith("/9j/") or node.startswith("data:image/") or len(node) > 1200:
            raise AssertionError("Unexpected base64 or oversized string in output JSON")
        return
    if isinstance(node, list):
        for item in node:
            assert_clean_output(item)
        return
    if isinstance(node, dict):
        for k, v in node.items():
            assert_clean_output(k)
            assert_clean_output(v)


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


def clamp_byte(v: float) -> int:
    if v <= 0.0:
        return 0
    if v >= 255.0:
        return 255
    return int(round(v))


def render_table_backdrop(seed: int, size: int = 768) -> Image.Image:
    rng = random.Random(seed)
    buf = bytearray(size * size * 3)
    row_grain = [rng.uniform(-3.5, 3.5) for _ in range(size)]
    for y in range(size):
        t_y = y / float(size - 1)
        g_row = row_grain[y] + 2.4 * math.sin(y / 13.0)
        for x in range(size):
            t_x = x / float(size - 1)
            dx = t_x - 0.5
            dy = t_y - 0.5
            vignette = -24.0 * (dx * dx + dy * dy)
            wood_wave = 3.2 * math.sin((y * 0.85 + 14.0 * math.sin(x / 95.0)) / 9.0)
            base_r = 166.0 - 18.0 * t_y + g_row + wood_wave + vignette
            base_g = 138.0 - 16.0 * t_y + g_row * 0.9 + wood_wave * 0.85 + vignette
            base_b = 108.0 - 13.0 * t_y + g_row * 0.75 + wood_wave * 0.65 + vignette
            idx = (y * size + x) * 3
            buf[idx] = clamp_byte(base_r)
            buf[idx + 1] = clamp_byte(base_g)
            buf[idx + 2] = clamp_byte(base_b)
    bg = Image.frombytes("RGB", (size, size), bytes(buf))
    bokeh = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    bd = ImageDraw.Draw(bokeh)
    bd.ellipse((24, 18, 250, 214), fill=(255, 248, 234, 34))
    bd.ellipse((520, 36, 742, 244), fill=(236, 244, 255, 28))
    bokeh = bokeh.filter(ImageFilter.GaussianBlur(radius=28.0))
    return Image.alpha_composite(bg.convert("RGBA"), bokeh).convert("RGB")


def create_foil_sheet(
    w: int,
    h: int,
    pockets: list[tuple[float, float]],
    rx: float,
    ry: float,
    seed: int,
    col_splits: list[int],
    row_splits: list[int],
) -> Image.Image:
    rng = random.Random(seed)
    buf = bytearray(w * h * 3)
    brush_row = [rng.uniform(-3.0, 3.0) for _ in range(h)]

    for y in range(h):
        b_row = brush_row[y]
        for x in range(w):
            aniso = 14.0 * math.sin((x * 0.68 + y * 0.62) / 68.0) + 7.0 * math.cos((x * 0.31 - y * 0.84) / 43.0)
            knurl = 3.0 if ((x % 5 == 0) or (y % 5 == 0)) else -1.0

            pocket_delta = 0.0
            for cx, cy in pockets:
                ndx = (x - cx) / rx
                ndy = (y - cy) / ry
                d2 = ndx * ndx + ndy * ndy
                if d2 < 1.16:
                    if d2 > 0.88:
                        pocket_delta = -11.0
                    else:
                        dome = math.sqrt(max(0.0, 1.0 - d2))
                        pocket_delta = 10.0 * dome - 4.0 * ndx - 3.5 * ndy
                    knurl *= 0.3
                    break

            luma = 212.0 + aniso + knurl + b_row + pocket_delta + rng.uniform(-1.5, 1.5)
            idx = (y * w + x) * 3
            buf[idx] = clamp_byte(luma - 2.0)
            buf[idx + 1] = clamp_byte(luma)
            buf[idx + 2] = clamp_byte(luma + 4.0)

    foil = Image.frombytes("RGB", (w, h), bytes(buf))
    draw = ImageDraw.Draw(foil)
    for x_sep in col_splits:
        for y_dash in range(8, h - 8, 12):
            draw.line((x_sep, y_dash, x_sep, min(h - 6, y_dash + 6)), fill=(146, 152, 162), width=2)
    for y_sep in row_splits:
        for x_dash in range(8, w - 8, 12):
            draw.line((x_dash, y_sep, min(w - 6, x_dash + 6), y_sep), fill=(146, 152, 162), width=2)
    return foil


def stamp_foil_tile(
    foil_rgba: Image.Image,
    anchor_xy: tuple[int, int],
    main_line: str,
    sub_line: str | None,
    ink_rgb: tuple[int, int, int],
    angle_deg: float,
    main_size: int = 31,
    sub_size: int = 20,
) -> Image.Image:
    f_main = ImageFont.load_default(size=main_size)
    f_sub = ImageFont.load_default(size=sub_size)
    probe = ImageDraw.Draw(Image.new("RGBA", (8, 8)))
    w_main = int(math.ceil(probe.textlength(main_line, font=f_main)))
    w_sub = int(math.ceil(probe.textlength(sub_line, font=f_sub))) if sub_line else 0
    tile_w = max(w_main, w_sub) + 32
    tile_h = main_size + (sub_size + 10 if sub_line else 0) + 28

    tile = Image.new("RGBA", (tile_w, tile_h), (0, 0, 0, 0))
    td = ImageDraw.Draw(tile)

    td.text(
        (16, 12),
        main_line,
        fill=(*ink_rgb, 248),
        font=f_main,
        stroke_width=1,
        stroke_fill=(*ink_rgb, 248),
    )
    if sub_line:
        td.text(
            (18, 16 + main_size + 4),
            sub_line,
            fill=(*ink_rgb, 232),
            font=f_sub,
        )

    rot = tile.rotate(angle_deg, resample=Image.Resampling.BICUBIC, expand=True)
    rw, rh = rot.size
    ax, ay = anchor_xy
    paste_x = ax - rw // 2
    paste_y = ay - rh // 2

    layer = Image.new("RGBA", foil_rgba.size, (0, 0, 0, 0))
    layer.paste(rot, (paste_x, paste_y), rot)
    return Image.alpha_composite(foil_rgba, layer)


def draw_crimped_expiry_band(
    foil_rgba: Image.Image,
    box_rect: tuple[int, int, int, int],
    text: str,
    alert: bool = False,
) -> Image.Image:
    out = foil_rgba.copy()
    draw = ImageDraw.Draw(out)
    x0, y0, x1, y1 = box_rect
    draw.rounded_rectangle(box_rect, radius=6, fill=(226, 230, 236, 238), outline=(136, 142, 152, 245), width=2)
    for rx in range(x0 + 6, x1 - 4, 6):
        draw.line((rx, y0 + 2, rx, y0 + 6), fill=(168, 174, 184, 210), width=1)
        draw.line((rx, y1 - 6, rx, y1 - 2), fill=(168, 174, 184, 210), width=1)
    f_exp = ImageFont.load_default(size=25)
    ink = (142, 20, 24, 252) if alert else (20, 26, 36, 248)
    draw.text(
        (x0 + 14, y0 + 9),
        text,
        fill=ink,
        font=f_exp,
        stroke_width=1,
        stroke_fill=ink,
    )
    return out


def punch_popped_pocket(
    foil_rgba: Image.Image,
    cx: float,
    cy: float,
    rx: float,
    ry: float,
    seed: int,
) -> Image.Image:
    rng = random.Random(seed)
    out = foil_rgba.copy()
    draw = ImageDraw.Draw(out)

    draw.ellipse(
        (cx - rx * 1.04, cy - ry * 1.04, cx + rx * 1.04, cy + ry * 1.04),
        fill=(84, 90, 100, 255),
        outline=(128, 134, 144, 255),
        width=3,
    )

    cavity_pts: list[tuple[float, float]] = []
    flap_pts: list[tuple[float, float]] = []
    n_verts = 18
    for k in range(n_verts):
        ang = (2.0 * math.pi * k) / n_verts
        jag = rng.uniform(0.76, 1.06)
        px = cx + rx * 0.86 * jag * math.cos(ang)
        py = cy + ry * 0.86 * jag * math.sin(ang)
        cavity_pts.append((px, py))
        curl = rng.uniform(7.0, 16.0) if (k % 2 == 0) else rng.uniform(2.0, 6.0)
        flap_pts.append((px + curl * math.cos(ang), py + 0.82 * curl * math.sin(ang)))

    draw.polygon(flap_pts, fill=(240, 244, 250, 255), outline=(124, 130, 142, 255))
    draw.polygon(cavity_pts, fill=(22, 26, 34, 255), outline=(92, 98, 110, 255))
    draw.arc(
        (cx - rx * 0.62, cy - ry * 0.58, cx + rx * 0.62, cy + ry * 0.58),
        start=22,
        end=196,
        fill=(68, 74, 88, 255),
        width=2,
    )
    return out


def cut_and_mount_foil(
    foil_rgba: Image.Image,
    polygon_pts: list[tuple[float, float]],
    scissor_edges: list[tuple[tuple[float, float], tuple[float, float]]],
    seed: int,
    tilt_deg: float,
) -> Image.Image:
    w, h = foil_rgba.size
    mask = Image.new("L", (w, h), 0)
    md = ImageDraw.Draw(mask)
    md.polygon(polygon_pts, fill=255)

    trimmed = foil_rgba.copy()
    td = ImageDraw.Draw(trimmed)
    td.polygon(polygon_pts, outline=(128, 134, 144, 255))
    for p0, p1 in scissor_edges:
        td.line((p0[0], p0[1], p1[0], p1[1]), fill=(248, 250, 253, 255), width=4)
        td.line((p0[0], p0[1], p1[0], p1[1]), fill=(88, 94, 106, 255), width=1)

    spec = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    spd = ImageDraw.Draw(spec)
    spd.ellipse((-30, -24, int(w * 0.36), int(h * 0.34)), fill=(255, 255, 255, 48))
    spec = spec.filter(ImageFilter.GaussianBlur(radius=20.0))
    trimmed = Image.alpha_composite(trimmed, spec)
    trimmed.putalpha(mask)

    rotated = trimmed.rotate(tilt_deg, resample=Image.Resampling.BICUBIC, expand=True)
    rw, rh = rotated.size
    ox = (768 - rw) // 2
    oy = (768 - rh) // 2

    bg = render_table_backdrop(seed, 768).convert("RGBA")
    shadow = Image.new("RGBA", (768, 768), (0, 0, 0, 0))
    alpha_ch = rotated.getchannel("A")
    shadow_patch = Image.new("RGBA", (rw, rh), (18, 14, 10, 128))
    shadow_patch.putalpha(alpha_ch)
    shadow.paste(shadow_patch, (ox + 12, oy + 16), shadow_patch)
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=13.0))

    comp = Image.alpha_composite(bg, shadow)
    comp.paste(rotated, (ox, oy), rotated)
    return comp.convert("RGB")


def standard_six_pockets(w: int = 612, h: int = 444) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    for r_idx in range(2):
        for c_idx in range(3):
            out.append(((c_idx + 0.5) * (w / 3.0), (r_idx + 0.5) * (h / 2.0)))
    return out


def render_case(spec: dict[str, Any]) -> Image.Image:
    cid = spec["id"]
    seed = int(spec["seed"])

    if cid == "bs_01":
        w, h = 624, 452
        pockets = standard_six_pockets(w, h)
        foil = create_foil_sheet(w, h, pockets, 64.0, 40.0, seed, [208, 416], [226]).convert("RGBA")
        ink = (14, 28, 56)
        for ax, ay in [(148, 102), (384, 118), (356, 304)]:
            foil = stamp_foil_tile(foil, (ax, ay), "Amlodipin 5 mg", "amlodipiini / amlodipine", ink, 13.0)
        foil = stamp_foil_tile(foil, (104, 334), "Amlodipin", "amlodipine", ink, 13.0)
        foil = stamp_foil_tile(foil, (544, 76), "Amlod", None, ink, 13.0)
        foil = draw_crimped_expiry_band(foil, (414, 396, 606, 438), "EXP 2027-11", alert=False)
        foil = punch_popped_pocket(foil, pockets[3][0], pockets[3][1], 60.0, 38.0, seed + 11)
        poly = [(14, 0), (426, 0), (w, 184), (w, h - 14), (w - 14, h), (14, h), (0, h - 14), (0, 14)]
        cuts = [((426, 0), (w, 184))]
        return cut_and_mount_foil(foil, poly, cuts, seed, tilt_deg=-3.2)

    if cid == "bs_02":
        w, h = 624, 452
        pockets = standard_six_pockets(w, h)
        foil = create_foil_sheet(w, h, pockets, 64.0, 40.0, seed, [208, 416], [226]).convert("RGBA")
        ink = (128, 16, 28)
        for ax, ay in [(342, 116), (484, 236), (344, 356)]:
            foil = stamp_foil_tile(foil, (ax, ay), "Burana 400 mg", "ibuprofeeni / ibuprofen", ink, -11.0)
        foil = stamp_foil_tile(foil, (104, 112), "Burana", "ibuprofen", ink, -11.0)
        foil = stamp_foil_tile(foil, (88, 336), "Bura", None, ink, -11.0)
        foil = draw_crimped_expiry_band(foil, (414, 14, 606, 56), "EXP 2027-10", alert=False)
        foil = punch_popped_pocket(foil, pockets[0][0], pockets[0][1], 60.0, 38.0, seed + 21)
        poly = [(14, 0), (w - 14, 0), (w, 14), (w, h - 14), (w - 14, h), (196, h), (0, 216), (0, 14)]
        cuts = [((0, 216), (196, h))]
        return cut_and_mount_foil(foil, poly, cuts, seed, tilt_deg=3.4)

    if cid == "bs_03":
        w, h = 624, 452
        pockets = standard_six_pockets(w, h)
        foil = create_foil_sheet(w, h, pockets, 64.0, 40.0, seed, [208, 416], [226]).convert("RGBA")
        ink = (12, 44, 68)
        for ax, ay in [(148, 98), (336, 176), (272, 316)]:
            foil = stamp_foil_tile(foil, (ax, ay), "Amlodipin 10 mg", "amlodipiini / amlodipine", ink, 12.0)
        foil = stamp_foil_tile(foil, (520, 112), "Amlodipin", "amlodipine", ink, 12.0)
        foil = draw_crimped_expiry_band(foil, (18, 396, 208, 438), "EXP 2027-09", alert=False)
        foil = punch_popped_pocket(foil, pockets[2][0], pockets[2][1], 60.0, 38.0, seed + 31)
        poly = [
            (14, 0),
            (w - 14, 0),
            (w, 14),
            (w, 226),
            (416, 226),
            (416, h),
            (14, h),
            (0, h - 14),
            (0, 14),
        ]
        cuts = [((w, 226), (416, 226)), ((416, 226), (416, h))]
        return cut_and_mount_foil(foil, poly, cuts, seed, tilt_deg=-2.8)

    if cid == "bs_04":
        w, h = 624, 452
        pockets = standard_six_pockets(w, h)
        foil = create_foil_sheet(w, h, pockets, 64.0, 40.0, seed, [208, 416], [226]).convert("RGBA")
        ink = (16, 32, 70)
        for ax, ay in [(164, 98), (366, 210), (356, 336)]:
            foil = stamp_foil_tile(
                foil,
                (ax, ay),
                "Metformin 500 mg",
                "metformin  EXP 2024-12",
                ink,
                -10.0,
                main_size=30,
                sub_size=19,
            )
        foil = stamp_foil_tile(foil, (520, 112), "Metformin", "metformin", ink, -10.0, main_size=30, sub_size=19)
        foil = draw_crimped_expiry_band(foil, (404, 394, 606, 438), "EXP 2024-12", alert=True)
        foil = punch_popped_pocket(foil, pockets[2][0], pockets[2][1], 60.0, 38.0, seed + 41)
        poly = [(14, 0), (w - 14, 0), (w, 14), (w, h - 14), (w - 14, h), (198, h), (0, 228), (0, 14)]
        cuts = [((0, 228), (198, h))]
        return cut_and_mount_foil(foil, poly, cuts, seed, tilt_deg=2.9)

    if cid == "bs_05":
        w, h = 604, 416
        pockets = [(186.0, 104.0), (478.0, 104.0), (186.0, 312.0), (478.0, 312.0)]
        foil = create_foil_sheet(w, h, pockets, 54.0, 35.0, seed, [302], [208]).convert("RGBA")
        ink = (16, 28, 54)
        for idx_p, (px, py) in enumerate(pockets):
            foil = stamp_foil_tile(
                foil,
                (int(px) - 24, int(py) + 6),
                "AMLODIPIN                mg",
                "amlodipine tablets",
                ink,
                11.0,
                main_size=24,
                sub_size=18,
            )
            foil = punch_popped_pocket(foil, px + 26.0, py - 6.0, 44.0, 29.0, seed + 50 + idx_p)
        poly = [(14, 0), (536, 0), (w, 68), (w, h - 14), (w - 14, h), (14, h), (0, h - 14), (0, 14)]
        cuts = [((536, 0), (w, 68))]
        return cut_and_mount_foil(foil, poly, cuts, seed, tilt_deg=-3.4)

    if cid == "bs_06":
        w, h = 336, 292
        pockets = [(136.0, 148.0)]
        foil = create_foil_sheet(w, h, pockets, 64.0, 42.0, seed, [252], [258]).convert("RGBA")
        ink = (16, 34, 68)
        foil = stamp_foil_tile(
            foil,
            (182, 86),
            "METFORMIN",
            "metformiini",
            ink,
            9.0,
            main_size=34,
            sub_size=21,
        )
        foil = stamp_foil_tile(
            foil,
            (172, 208),
            "METFORMIN",
            "metformin",
            ink,
            9.0,
            main_size=34,
            sub_size=21,
        )
        poly = [(18, 16), (274, 22), (258, 274), (14, 268)]
        cuts = [
            ((18, 16), (274, 22)),
            ((274, 22), (258, 274)),
            ((258, 274), (14, 268)),
            ((14, 268), (18, 16)),
        ]
        return cut_and_mount_foil(foil, poly, cuts, seed, tilt_deg=-5.2)

    if cid == "bs_07":
        w, h = 548, 248
        pockets = [(178.0, 124.0), (402.0, 124.0)]
        foil = create_foil_sheet(w, h, pockets, 56.0, 36.0, seed, [296], []).convert("RGBA")
        ink = (14, 48, 36)
        foil = stamp_foil_tile(
            foil,
            (164, 128),
            "PANADOL                mg",
            "paracetamol",
            ink,
            11.0,
            main_size=26,
            sub_size=19,
        )
        foil = punch_popped_pocket(foil, 198.0, 118.0, 45.0, 30.0, seed + 71)
        foil = stamp_foil_tile(
            foil,
            (422, 122),
            "PANADOL",
            "paracetamol",
            ink,
            11.0,
            main_size=33,
            sub_size=20,
        )
        poly = [(14, 18), (496, 12), (476, 232), (18, 228)]
        cuts = [
            ((14, 18), (496, 12)),
            ((496, 12), (476, 232)),
            ((476, 232), (18, 228)),
        ]
        return cut_and_mount_foil(foil, poly, cuts, seed, tilt_deg=4.4)

    if cid == "bs_08":
        w, h = 516, 356
        pockets = [(174.0, 114.0), (332.0, 246.0)]
        foil = create_foil_sheet(w, h, pockets, 56.0, 36.0, seed, [264], [178]).convert("RGBA")
        ink = (16, 28, 56)
        foil = stamp_foil_tile(
            foil,
            (166, 118),
            "AMLODIPIN                mg",
            "amlodipiini",
            ink,
            11.0,
            main_size=25,
            sub_size=19,
        )
        foil = punch_popped_pocket(foil, 206.0, 108.0, 45.0, 30.0, seed + 81)
        foil = stamp_foil_tile(
            foil,
            (374, 248),
            "AMLODIPIN",
            "amlodipine",
            ink,
            11.0,
            main_size=33,
            sub_size=20,
        )
        poly = [(14, 14), (344, 14), (478, 268), (442, 342), (14, 342)]
        cuts = [((344, 14), (478, 268)), ((478, 268), (442, 342))]
        return cut_and_mount_foil(foil, poly, cuts, seed, tilt_deg=-4.0)

    raise ValueError(f"Unknown case id: {cid}")


def save_jpeg(img: Image.Image, out_path: pathlib.Path) -> int:
    if img.size != (768, 768):
        raise RuntimeError(f"Expected 768x768 image for {out_path.name}, got {img.size}")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="JPEG", quality=90)
    raw = buf.getvalue()
    out_path.write_bytes(raw)
    return len(raw)


def percentile(vals: list[float], q: float) -> float:
    xs = sorted(vals)
    if not xs:
        return 0.0
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

    rendered_records: list[dict[str, Any]] = []
    for spec in CASE_SPECS:
        img = render_case(spec)
        img_path = OUT_IMG_DIR / f'{spec["id"]}.jpg'
        jpeg_bytes = save_jpeg(img, img_path)
        rendered_records.append(
            {
                "spec": spec,
                "image_abs": str(img_path),
                "image_rel": str(img_path.relative_to(REPO_ROOT)),
                "jpeg_bytes": jpeg_bytes,
            }
        )

    if render_only:
        return {"rendered": len(rendered_records), "out_dir": str(OUT_IMG_DIR.relative_to(REPO_ROOT))}

    with tempfile.TemporaryDirectory(prefix="holdup_bs_eval_") as tmp_dir:
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
            "evalNowIso": EVAL_NOW_ISO,
            "outPath": str(raw_out_path),
            "cases": [
                {
                    "id": r["spec"]["id"],
                    "question": r["spec"]["question"],
                    "image_abs": r["image_abs"],
                    "expected_strength": r["spec"]["expected_strength"],
                }
                for r in rendered_records
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
                f"TypeScript verify() runner failed ({proc.returncode}): {scrub_node(proc.stderr[:500])}"
            )

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

    ts_by_id = {row["id"]: row for row in ts_out["results"]}
    items_out: list[dict[str, Any]] = []

    for rec in rendered_records:
        spec = rec["spec"]
        cid = spec["id"]
        tr = ts_by_id[cid]
        read_obj, verdict_compact = compact_verdict(tr["verdict"])

        pred_level = verdict_compact["level"]
        exp_level = str(spec["expected_level"])
        verdict_match = pred_level == exp_level

        s_field = read_obj.get("strength") or {}
        s_val = s_field.get("value")
        s_conf = round(float(s_field.get("confidence") or 0.0), 4)
        intact_tile = bool(spec["intact_tile"])
        strength_matches_exp = bool(tr.get("strengthMatchesExpected"))

        if intact_tile:
            strength_correct: bool | None = bool(
                s_val is not None and s_conf >= min_conf and strength_matches_exp
            )
            confident_wrong_dose = bool(
                (s_conf >= min_conf and (s_val is None or not strength_matches_exp))
                or (exp_level != "match" and pred_level == "match")
            )
            intact_tile_correct: bool | None = bool(
                verdict_match and strength_correct and not confident_wrong_dose
            )
            abstained: bool | None = None
        else:
            strength_correct = None
            intact_tile_correct = None
            confident_wrong_dose = bool(
                (s_val is not None and s_conf >= min_conf)
                or pred_level == "match"
            )
            abstained = bool(pred_level == "unsure" and not confident_wrong_dose)

        false_safe_allergen = False
        tok = tokens_by_feature.get(cid, {"in": 0, "out": 0, "thinking": 0})
        lat_ms = round(float(tr["latencyMs"]), 1)

        item_row = {
            "id": cid,
            "strip_condition": spec["strip_condition"],
            "cut_mode": spec["cut_mode"],
            "question": spec["question"],
            "description": spec["description"],
            "image_path": rec["image_rel"],
            "width": 768,
            "height": 768,
            "jpeg_bytes": rec["jpeg_bytes"],
            "intact_tile": intact_tile,
            "strength_readable": bool(spec["strength_readable"]),
            "expected_level": exp_level,
            "predicted_level": pred_level,
            "verdict_match": verdict_match,
            "expected_strength": spec["expected_strength"],
            "strength_value": s_val,
            "strength_confidence": s_conf,
            "strength_correct": strength_correct,
            "intact_tile_correct": intact_tile_correct,
            "abstained": abstained,
            "confident_wrong_dose": confident_wrong_dose,
            "false_safe_allergen": false_safe_allergen,
            "verify_checklabel_parity": bool(tr.get("parity")),
            "latency_ms": lat_ms,
            "tokens_in": tok["in"],
            "tokens_out": tok["out"],
            "tokens_thinking": tok["thinking"],
            "model": tr["model"],
            "read": read_obj,
            "verdict": verdict_compact,
        }
        items_out.append(item_row)
        print(
            f"[{cid}] exp={exp_level} pred={pred_level} match={verdict_match} "
            f"strength={s_val} (conf={s_conf:.2f}) cwd={confident_wrong_dose} ms={lat_ms:.1f}"
        )

    n_items = len(items_out)
    intact_items = [it for it in items_out if it["intact_tile"]]
    truncated_items = [it for it in items_out if not it["intact_tile"]]

    n_intact_tile = len(intact_items)
    n_truncated_strength = len(truncated_items)
    intact_tile_matches = sum(1 for it in intact_items if it["intact_tile_correct"])
    truncated_abstained_count = sum(1 for it in truncated_items if it["abstained"])
    verdict_matches = sum(1 for it in items_out if it["verdict_match"])
    cwd_count = int(sum(1 for it in items_out if it["confident_wrong_dose"]))
    fsa_count = int(sum(1 for it in items_out if it["false_safe_allergen"]))

    latencies = [float(it["latency_ms"]) for it in items_out]
    total_tokens_in = int(sum(int(it["tokens_in"]) for it in items_out))
    total_tokens_out = int(sum(int(it["tokens_out"]) for it in items_out))
    total_tokens_thinking = int(sum(int(it["tokens_thinking"]) for it in items_out))

    summary: dict[str, Any] = {
        "model": MODEL_NAME,
        "thinking_level": "LOW",
        "n_items": n_items,
        "n_intact_tile": n_intact_tile,
        "n_truncated_strength": n_truncated_strength,
        "intact_tile_matches": intact_tile_matches,
        "intact_tile_accuracy": round(intact_tile_matches / n_intact_tile, 4) if n_intact_tile else 0.0,
        "truncated_abstained_count": truncated_abstained_count,
        "truncated_abstention_rate": round(truncated_abstained_count / n_truncated_strength, 4) if n_truncated_strength else 0.0,
        "verdict_matches": verdict_matches,
        "verdict_accuracy": round(verdict_matches / n_items, 4) if n_items else 0.0,
        "confident_wrong_dose_count": cwd_count,
        "false_safe_allergen_count": fsa_count,
        "latency_p50_ms": percentile(latencies, 0.50),
        "latency_p95_ms": percentile(latencies, 0.95),
        "latency_mean_ms": round(statistics.mean(latencies), 1) if latencies else 0.0,
        "tokens_in": total_tokens_in,
        "tokens_out": total_tokens_out,
        "tokens_thinking": total_tokens_thinking,
    }

    report = scrub_node(
        {
            "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "eval_now_iso": EVAL_NOW_ISO,
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
        description="Scissor-cut and popped-pocket metallic blister foil ambiguity benchmark"
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
