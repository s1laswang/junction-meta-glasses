import argparse
import base64
import csv
import io
import json
import os
import pathlib
import sys
import time
from typing import Any, Callable

import requests
from PIL import Image, ImageOps

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
DEFAULT_REAL_DIR = REPO_ROOT / "eval" / "real"
DEFAULT_CSV_PATH = DEFAULT_REAL_DIR / "labels.csv"
VERIFY_PROMPT_PATH = REPO_ROOT / "shared" / "verify_prompt.md"
LABEL_SCHEMA_PATH = REPO_ROOT / "shared" / "label_schema.json"

EXPECTED_COLUMNS = [
    "file",
    "kind",
    "product",
    "ingredient",
    "strength",
    "expiry",
    "allergens",
    "notes",
]
ALLOWED_KINDS = {"medication", "food", "other", "unreadable"}
ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png"}
GPS_EXIF_TAG = 0x8825
EXIF_IFD_TAG = 0x8769
BENIGN_EXIF_TAGS = {
    0x0112,
    0x011A,
    0x011B,
    0x0128,
    0x0213,
    EXIF_IFD_TAG,
    0xA001,
    0xA002,
    0xA003,
}
PNG_PII_KEYS = {
    "author",
    "comment",
    "copyright",
    "creation time",
    "description",
    "disclaimer",
    "software",
    "source",
    "title",
    "warning",
    "xml:com.adobe.xmp",
    "xmp",
}
MODEL_NAME = "gemini-3.8-flash"


def inspect_image(img_path: str | os.PathLike[str]) -> dict[str, Any]:
    path = pathlib.Path(img_path)
    try:
        with Image.open(path) as img:
            fmt = (img.format or "").upper()
            if fmt not in ("JPEG", "PNG"):
                return {
                    "file": path.name,
                    "valid": False,
                    "error": f"unsupported_format:{fmt or 'unknown'}",
                }
            width, height = img.size
            if not (isinstance(width, int) and isinstance(height, int) and width > 0 and height > 0):
                return {
                    "file": path.name,
                    "valid": False,
                    "error": "invalid_dimensions",
                }
            img.load()
            exif = img.getexif()
            gps_ifd = exif.get_ifd(GPS_EXIF_TAG)
            has_gps = (GPS_EXIF_TAG in exif) or bool(gps_ifd)
            sub_exif = exif.get_ifd(EXIF_IFD_TAG)
            non_benign_top = [int(k) for k in exif.keys() if int(k) not in BENIGN_EXIF_TAGS]
            non_benign_sub = [int(k) for k in sub_exif.keys() if int(k) not in BENIGN_EXIF_TAGS]
            png_meta_leaks = [
                str(k)
                for k in img.info.keys()
                if str(k).strip().lower() in PNG_PII_KEYS
            ]
            has_exif_pii = has_gps or bool(non_benign_top) or bool(non_benign_sub) or bool(png_meta_leaks)
            return {
                "file": path.name,
                "valid": True,
                "format": fmt,
                "width": width,
                "height": height,
                "has_gps": has_gps,
                "has_exif_pii": has_exif_pii,
            }
    except (OSError, ValueError, SyntaxError) as exc:
        return {
            "file": path.name,
            "valid": False,
            "error": str(exc),
        }


def strip_exif_in_place(img_path: str | os.PathLike[str]) -> dict[str, Any]:
    path = pathlib.Path(img_path)
    with Image.open(path) as loaded:
        fmt = (loaded.format or "").upper()
        if fmt not in ("JPEG", "PNG"):
            raise ValueError(f"Unsupported image format for EXIF stripping: {fmt or 'unknown'}")
        had_exif = bool(loaded.getexif()) or ("exif" in loaded.info)
        transposed = ImageOps.exif_transpose(loaded)
        if fmt == "JPEG" and transposed.mode not in ("RGB", "L"):
            transposed = transposed.convert("RGB")
        elif transposed.mode == "P":
            transposed = transposed.convert("RGBA")
        clean = Image.frombytes(transposed.mode, transposed.size, transposed.tobytes())
        width, height = clean.size

    buf = io.BytesIO()
    if fmt == "JPEG":
        clean.save(buf, format="JPEG", quality=92)
    else:
        clean.save(buf, format="PNG")
    path.write_bytes(buf.getvalue())
    return {
        "path": str(path),
        "format": fmt,
        "width": width,
        "height": height,
        "stripped": had_exif,
    }


def _safe_resolve_in_dir(real_root: pathlib.Path, file_entry: str) -> pathlib.Path | None:
    rel = pathlib.Path(file_entry)
    if not file_entry or rel.is_absolute():
        return None
    resolved = (real_root / rel).resolve()
    if not resolved.is_relative_to(real_root):
        return None
    return resolved


def validate_csv(csv_path: str | os.PathLike[str], real_dir: str | os.PathLike[str]) -> dict[str, Any]:
    cpath = pathlib.Path(csv_path)
    rdir = pathlib.Path(real_dir)
    real_root = rdir.resolve()

    if not cpath.is_file():
        return {
            "csv_path": str(cpath),
            "real_dir": str(rdir),
            "header_valid": False,
            "columns": [],
            "expected_columns": list(EXPECTED_COLUMNS),
            "rows": 0,
            "images_present": 0,
            "images_missing": 0,
            "exif_clean": True,
            "gps_clean": True,
            "gps_leaks": [],
            "exif_leaks": [],
            "invalid_images": [],
            "missing_files": [],
            "row_errors": ["csv_not_found"],
            "image_details": [],
            "status": "invalid_schema",
        }

    with cpath.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.reader(handle)
        first_row = next(reader, None)
        if first_row is None:
            return {
                "csv_path": str(cpath),
                "real_dir": str(rdir),
                "header_valid": False,
                "columns": [],
                "expected_columns": list(EXPECTED_COLUMNS),
                "rows": 0,
                "images_present": 0,
                "images_missing": 0,
                "exif_clean": True,
                "gps_clean": True,
                "gps_leaks": [],
                "exif_leaks": [],
                "invalid_images": [],
                "missing_files": [],
                "row_errors": ["empty_csv"],
                "image_details": [],
                "status": "invalid_schema",
            }

        columns = [cell.strip() for cell in first_row]
        header_valid = columns == EXPECTED_COLUMNS
        if not header_valid:
            return {
                "csv_path": str(cpath),
                "real_dir": str(rdir),
                "header_valid": False,
                "columns": columns,
                "expected_columns": list(EXPECTED_COLUMNS),
                "rows": 0,
                "images_present": 0,
                "images_missing": 0,
                "exif_clean": True,
                "gps_clean": True,
                "gps_leaks": [],
                "exif_leaks": [],
                "invalid_images": [],
                "missing_files": [],
                "row_errors": ["header_mismatch"],
                "image_details": [],
                "status": "invalid_schema",
            }

        rows = 0
        images_present = 0
        images_missing = 0
        gps_leaks: list[str] = []
        exif_leaks: list[str] = []
        invalid_images: list[str] = []
        missing_files: list[str] = []
        row_errors: list[str] = []
        image_details: list[dict[str, Any]] = []

        for line_idx, raw_row in enumerate(reader, start=2):
            if not any(cell.strip() for cell in raw_row):
                continue
            rows += 1
            if len(raw_row) != len(EXPECTED_COLUMNS):
                row_errors.append(f"line_{line_idx}:column_count_{len(raw_row)}")
                continue

            record = {col: raw_row[i].strip() for i, col in enumerate(EXPECTED_COLUMNS)}
            file_val = record["file"]
            kind_val = record["kind"]

            if not file_val:
                row_errors.append(f"line_{line_idx}:empty_file")
                continue

            if kind_val not in ALLOWED_KINDS:
                row_errors.append(f"line_{line_idx}:invalid_kind:{kind_val}")

            resolved_img = _safe_resolve_in_dir(real_root, file_val)
            if resolved_img is None:
                row_errors.append(f"line_{line_idx}:unsafe_file_path:{file_val}")
                invalid_images.append(file_val)
                continue

            ext = resolved_img.suffix.lower()
            if ext not in ALLOWED_EXTENSIONS:
                row_errors.append(f"line_{line_idx}:unsupported_extension:{file_val}")
                invalid_images.append(file_val)
                continue

            if not resolved_img.is_file():
                images_missing += 1
                missing_files.append(file_val)
                continue

            images_present += 1
            info = inspect_image(resolved_img)
            info["file"] = file_val
            image_details.append(info)
            if not info["valid"]:
                invalid_images.append(file_val)
                continue
            if info["has_gps"]:
                gps_leaks.append(file_val)
            if info["has_exif_pii"]:
                exif_leaks.append(file_val)

    gps_clean = len(gps_leaks) == 0
    exif_clean = gps_clean and len(exif_leaks) == 0

    if row_errors or invalid_images:
        status = "invalid_data"
    elif not exif_clean:
        status = "exif_dirty"
    elif rows == 0 or images_present == 0:
        status = "ready_for_photos"
    else:
        status = "ok"

    return {
        "csv_path": str(cpath),
        "real_dir": str(rdir),
        "header_valid": True,
        "columns": columns,
        "expected_columns": list(EXPECTED_COLUMNS),
        "rows": rows,
        "images_present": images_present,
        "images_missing": images_missing,
        "exif_clean": exif_clean,
        "gps_clean": gps_clean,
        "gps_leaks": gps_leaks,
        "exif_leaks": exif_leaks,
        "invalid_images": invalid_images,
        "missing_files": missing_files,
        "row_errors": row_errors,
        "image_details": image_details,
        "status": status,
    }


def inline_schema_refs(node: Any, defs: dict[str, Any] | None = None) -> Any:
    if defs is None and isinstance(node, dict):
        defs = node.get("$defs") or {}
    if isinstance(node, list):
        return [inline_schema_refs(item, defs) for item in node]
    if isinstance(node, dict):
        ref = node.get("$ref")
        if isinstance(ref, str) and defs is not None:
            ref_key = ref.rsplit("/", 1)[-1]
            return inline_schema_refs(defs[ref_key], defs)
        cleaned: dict[str, Any] = {}
        for k, v in node.items():
            if k in ("$defs", "$comment"):
                continue
            cleaned[k] = inline_schema_refs(v, defs)
        return cleaned
    return node


def load_env_fallback() -> None:
    if os.environ.get("GEMINI_API_KEY"):
        return
    comment_prefix = chr(35)
    for env_path in (pathlib.Path.home() / "momin" / ".env", REPO_ROOT / ".env"):
        if not env_path.is_file():
            continue
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
            if key and key not in os.environ:
                os.environ[key] = val


def _normalize_text(val: Any) -> str:
    if not isinstance(val, str):
        return ""
    return " ".join(val.lower().replace(",", ".").split())


def _default_gemini_call(model: str, mime_type: str, b64_image: str, prompt_text: str, schema: dict[str, Any]) -> tuple[dict[str, Any], float]:
    load_env_fallback()
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is not set")
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
    payload = {
        "systemInstruction": {"parts": [{"text": prompt_text}]},
        "contents": [
            {
                "role": "user",
                "parts": [
                    {"inlineData": {"mimeType": mime_type, "data": b64_image}},
                    {"text": "Read this label."},
                ],
            }
        ],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseJsonSchema": schema,
            "thinkingConfig": {"thinkingLevel": "LOW"},
            "maxOutputTokens": 2048,
        },
    }
    t0 = time.perf_counter()
    resp = requests.post(url, json=payload, timeout=45)
    elapsed_ms = round((time.perf_counter() - t0) * 1000.0, 1)
    if resp.status_code != 200:
        raise RuntimeError(f"Gemini HTTP {resp.status_code}: {resp.text[:300]}")
    body = resp.json()
    cands = body.get("candidates") or []
    parts = (cands[0].get("content") or {}).get("parts") or [] if cands else []
    raw_json = ""
    for part in parts:
        if "text" in part and not part.get("thought") and part["text"].strip():
            raw_json = part["text"]
            break
    if not raw_json:
        raise RuntimeError("Empty Gemini structured output")
    return json.loads(raw_json), elapsed_ms


def evaluate_real_labels(
    csv_path: str | os.PathLike[str],
    real_dir: str | os.PathLike[str],
    model: str = MODEL_NAME,
    call_fn: Callable[[str, str, str, str, dict[str, Any]], tuple[dict[str, Any], float]] | None = None,
) -> dict[str, Any]:
    validation = validate_csv(csv_path, real_dir)
    if not validation["header_valid"]:
        return {"model": model, "evaluated": 0, "status": "invalid_schema", "items": []}
    if not validation["exif_clean"]:
        return {"model": model, "evaluated": 0, "status": "blocked_exif_dirty", "items": []}
    if validation["images_present"] == 0:
        return {"model": model, "evaluated": 0, "status": "ready_for_photos", "items": []}

    prompt_text = VERIFY_PROMPT_PATH.read_text(encoding="utf-8")
    raw_schema = json.loads(LABEL_SCHEMA_PATH.read_text(encoding="utf-8"))
    schema = inline_schema_refs(raw_schema)
    runner = call_fn or _default_gemini_call

    cpath = pathlib.Path(csv_path)
    real_root = pathlib.Path(real_dir).resolve()
    items: list[dict[str, Any]] = []
    kind_matches = 0
    strength_total = 0
    strength_matches = 0
    confident_wrong_strength = 0

    with cpath.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            file_val = (row.get("file") or "").strip()
            resolved = _safe_resolve_in_dir(real_root, file_val)
            if resolved is None or not resolved.is_file():
                continue
            mime_type = "image/png" if resolved.suffix.lower() == ".png" else "image/jpeg"
            b64_data = base64.b64encode(resolved.read_bytes()).decode("ascii")
            pred, latency_ms = runner(model, mime_type, b64_data, prompt_text, schema)

            expected_kind = (row.get("kind") or "").strip()
            pred_kind = str(pred.get("kind") or "")
            kind_ok = pred_kind == expected_kind
            if kind_ok:
                kind_matches += 1

            expected_strength = _normalize_text(row.get("strength") or "")
            pred_strength_field = pred.get("strength") or {}
            pred_strength_val = _normalize_text(pred_strength_field.get("value"))
            pred_strength_conf = float(pred_strength_field.get("confidence") or 0.0)

            strength_ok = True
            if expected_strength:
                strength_total += 1
                strength_ok = pred_strength_val == expected_strength
                if strength_ok:
                    strength_matches += 1
                elif pred_strength_val and pred_strength_conf >= 0.7:
                    confident_wrong_strength += 1

            items.append(
                {
                    "file": file_val,
                    "expected_kind": expected_kind,
                    "predicted_kind": pred_kind,
                    "kind_match": kind_ok,
                    "strength_match": strength_ok,
                    "latency_ms": latency_ms,
                }
            )

    total = len(items)
    return {
        "model": model,
        "evaluated": total,
        "kind_accuracy": round(kind_matches / total, 4) if total else 0.0,
        "strength_accuracy": round(strength_matches / strength_total, 4) if strength_total else None,
        "confident_wrong_strength_count": confident_wrong_strength,
        "status": "ok",
        "items": items,
    }


def strip_directory_images(csv_path: str | os.PathLike[str], real_dir: str | os.PathLike[str]) -> list[str]:
    cpath = pathlib.Path(csv_path)
    real_root = pathlib.Path(real_dir).resolve()
    if not cpath.is_file():
        return []
    stripped_files: list[str] = []
    with cpath.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.reader(handle)
        header = next(reader, None)
        if not header or [c.strip() for c in header] != EXPECTED_COLUMNS:
            return []
        for raw_row in reader:
            if not raw_row or not raw_row[0].strip():
                continue
            file_val = raw_row[0].strip()
            resolved = _safe_resolve_in_dir(real_root, file_val)
            if resolved is not None and resolved.is_file() and resolved.suffix.lower() in ALLOWED_EXTENSIONS:
                strip_exif_in_place(resolved)
                stripped_files.append(file_val)
    return stripped_files


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Validate HoldUp real label photos and strip EXIF PII")
    parser.add_argument("--csv", default=None, help="Path to labels.csv")
    parser.add_argument("--real-dir", default=None, help="Path to directory containing label photos")
    parser.add_argument("--strip-exif", action="store_true", help="Strip EXIF metadata in place on present photos")
    parser.add_argument("--eval", action="store_true", help="Run optional gemini-3.8-flash evaluation when photos exist")
    args = parser.parse_args(argv)

    csv_path = pathlib.Path(args.csv) if args.csv else DEFAULT_CSV_PATH
    if args.real_dir:
        real_dir = pathlib.Path(args.real_dir)
    elif args.csv:
        real_dir = csv_path.parent
    else:
        real_dir = DEFAULT_REAL_DIR

    stripped: list[str] = []
    if args.strip_exif:
        stripped = strip_directory_images(csv_path, real_dir)

    summary = validate_csv(str(csv_path), str(real_dir))
    if args.strip_exif:
        summary["stripped_files"] = stripped
    if args.eval:
        summary["eval"] = evaluate_real_labels(str(csv_path), str(real_dir))

    print(json.dumps(summary, indent=2))

    if not summary["header_valid"]:
        return 1
    if not summary["exif_clean"] or summary["invalid_images"] or summary["row_errors"]:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
