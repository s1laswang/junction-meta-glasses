"""Step 2 of the Gemini workforce: render photoreal first-person photos of each spec,
then have a stronger model re-verify every render against its spec (and locate each
field's text with a bounding box) so the ground truth stays honest.

  render: gemini-3.1-flash-image (fallback gemini-3-pro-image, nano-banana-pro-preview)
  check : gemini-3.1-pro-preview (CHECK_MODEL) -> per-field legible / matches_spec / box_2d

Renders whose key fields come out garbled are re-rendered once, then dropped.
A subset of medications also gets a "back of box" render (barcode side), where the
key fields are genuinely not visible; that tests honest abstention.

Usage: python eval/gen_images.py [--limit N] [--workers 8] [--back 40]
Output: $HOLDUP_DATA/clean/<id>.jpg, $HOLDUP_DATA/clean/<id>_back.jpg, $HOLDUP_DATA/renders.jsonl
Resumable: specs already in renders.jsonl are skipped.
"""
from __future__ import annotations

import argparse
import base64
import io
import os
import random
import time

from common import (CHECK_MODEL, DATA, IMAGE_MODELS, _redact, _rest_resp, append_jsonl, client, gen_json,
                    ledger, load_env, log, part_bytes, pmap, read_jsonl, with_retries)

FIELDS = ["product", "ingredient", "strength", "dosing", "expiry", "allergens", "may_contain", "barcode"]
KEY_FIELDS = {"medication": ["product", "strength"], "food": ["product", "allergens"]}

SCENES = [
    "a kitchen counter with a window behind", "a bathroom sink with a mirror", "a dim living room with a lamp",
    "a pharmacy shopping bag on a table", "a supermarket aisle", "a bedside table at night with a reading lamp",
    "a cluttered dining table", "a hallway with cool daylight",
]
HANDS = ["an older person's left hand", "a right hand", "an older person's right hand with a ring", "a left hand",
         "a right hand wearing a knitted sleeve"]


def render_prompt(s: dict, back: bool = False) -> str:
    scene = random.choice(SCENES)
    hand = random.choice(HANDS)
    pkg = s.get("package", "box")
    if back:
        return (
            f"Photorealistic first-person photo taken from smart glasses at eye level, about 35 cm away: {hand} holds "
            f"a {s.get('colors','white')} medicine {pkg} turned so we see its BACK side. The back side shows only a "
            f"barcode with the digits '{s.get('barcode') or '6400000000000'}', recycling symbols and a small manufacturer "
            f"address block for '{s['brand']}'. The product name and strength are NOT visible from this side. "
            f"Background: {scene}. Natural phone-camera look, slight wide-angle."
        )
    if s["kind"] == "medication":
        lines = list(s.get("front_text") or [])
        for extra in (s.get("expiry_printed"),):
            if extra and extra not in lines:
                lines.append(extra)
        body = "\n".join(f"  - {l}" for l in lines)
        return (
            f"Photorealistic first-person photo taken from smart glasses at eye level, about 35 cm away: {hand} holds "
            f"a {s.get('colors','white')} {s['brand']} medicine {pkg} ({s.get('form','')}) with the main label facing "
            f"the camera. The printed label text must be crisp, correctly spelled and exactly these lines (no other "
            f"words, no invented text):\n{body}\nThe strength is printed clearly. Background: {scene}. Natural "
            f"phone-camera look, realistic packaging typography, slight wide-angle, no watermark."
        )
    lines = [s["product"]]
    if s.get("ingredients_text"):
        lines.append(s["ingredients_text"])
    if s.get("may_contain_text"):
        lines.append(s["may_contain_text"])
    if s.get("expiry_printed"):
        lines.append(s["expiry_printed"])
    body = "\n".join(f"  - {l}" for l in lines)
    return (
        f"Photorealistic first-person photo taken from smart glasses at eye level, about 30 cm away: {hand} holds a "
        f"{s.get('colors','')} {s['brand']} food {pkg} turned to show the ingredients and allergen panel. The panel "
        f"has a bold product name at the top, then the ingredients list with allergens in bold, then the trace "
        f"statement and best-before date. The text must be legible, correctly spelled and exactly:\n{body}\n"
        f"Background: {scene}. Natural phone-camera look, realistic packaging typography, no watermark."
    )


def render(prompt: str, model_order: list[str]) -> tuple[bytes, str]:
    try:
        from google.genai import types
    except ImportError:
        load_env()
        import requests

        last = None
        for model in model_order:
            def call_rest(model=model):
                t0 = time.time()
                r = None
                try:
                    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
                    payload = {
                        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
                        "generationConfig": {"responseModalities": ["IMAGE"], "imageConfig": {"aspectRatio": "1:1"}},
                    }
                    resp = requests.post(
                        url,
                        headers={"x-goog-api-key": os.environ["GEMINI_API_KEY"]},
                        json=payload,
                        timeout=120,
                    )
                    if resp.status_code != 200:
                        raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:240]}")
                    rj = resp.json()
                    r = _rest_resp(rj)
                    for c in rj.get("candidates") or []:
                        for p in (c.get("content") or {}).get("parts") or []:
                            inl = p.get("inlineData") or {}
                            if not p.get("thought") and inl.get("data"):
                                ledger("gen_images.render", model, r, time.time() - t0, True, None)
                                return base64.b64decode(inl["data"])
                    raise RuntimeError("empty response (no image part)")
                except Exception:
                    ledger("gen_images.render", model, r, time.time() - t0, False, None)
                    raise
            try:
                return with_retries(call_rest, tries=4, label=f"render-{model}"), model
            except Exception as e:
                last = e
                log(f"render fallback from {model}: {_redact(str(e))[:120]}")
        raise RuntimeError(f"all image models failed: {_redact(str(last))}")

    last = None
    for model in model_order:
        def call(model=model):
            t0 = time.time()
            r = None
            try:
                r = client().models.generate_content(
                    model=model, contents=prompt,
                    config=types.GenerateContentConfig(response_modalities=["IMAGE"],
                                                       image_config=types.ImageConfig(aspect_ratio="1:1")))
                for c in r.candidates or []:
                    for p in (c.content.parts if c.content else []) or []:
                        if getattr(p, "inline_data", None) and p.inline_data.data:
                            ledger("gen_images.render", model, r, time.time() - t0, True, None)
                            return p.inline_data.data
                raise RuntimeError("empty response (no image part)")
            except Exception:
                ledger("gen_images.render", model, r, time.time() - t0, False, None)
                raise
        try:
            return with_retries(call, tries=4, label=f"render-{model}"), model
        except Exception as e:  # noqa: BLE001
            last = e
            log(f"render fallback from {model}: {str(e)[:120]}")
    raise RuntimeError(f"all image models failed: {last}")


CHECK_SCHEMA = {
    "type": "object",
    "properties": {
        "fields": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "field": {"type": "string", "enum": FIELDS},
                    "legible": {"type": "boolean", "description": "A sighted person could read this field's text in the photo"},
                    "printed_text": {"type": "string", "description": "What is actually printed for this field (verbatim), or empty"},
                    "matches_spec": {"type": "boolean", "description": "The printed text carries exactly the expected value (spelling, digits, units)"},
                    "box_2d": {"type": "array", "items": {"type": "integer"}, "description": "[ymin,xmin,ymax,xmax] 0-1000 of the field text, or [] if absent"},
                    "line_count": {"type": "integer", "description": "Number of text lines inside box_2d"},
                },
                "required": ["field", "legible", "printed_text", "matches_spec", "box_2d", "line_count"],
            },
        },
        "garbled_text": {"type": "boolean", "description": "Any visible pseudo-text, misspelt or nonsensical words on the label"},
        "photo_ok": {"type": "boolean", "description": "Looks like a real photo of a hand holding the item"},
        "notes": {"type": "string"},
    },
    "required": ["fields", "garbled_text", "photo_ok", "notes"],
}


def expected_fields(s: dict) -> dict:
    exp = {
        "product": s.get("product"), "ingredient": s.get("ingredient") or None,
        "strength": s.get("strength") or None, "dosing": s.get("dosing") or None,
        "expiry": s.get("expiry_printed") or s.get("expiry"), "barcode": s.get("barcode") or None,
    }
    if s["kind"] == "food":
        exp["allergens"] = ", ".join(s.get("allergens") or []) or "(none)"
        exp["may_contain"] = ", ".join(s.get("may_contain") or []) or None
    return exp


def check(img: bytes, s: dict, back: bool) -> dict:
    exp = expected_fields(s)
    exp_txt = "\n".join(f"- {k}: {v}" for k, v in exp.items() if v)
    prompt = (
        "You are auditing a synthetic photo used as ground truth for a label-reading evaluation. Compare the photo "
        "against the expected label specification below. For EVERY field listed, say whether its text is legible in "
        "this photo, transcribe what is actually printed, say whether it matches the expected value exactly (same "
        "digits, units, spelling; formatting like '5mg' vs '5 mg' or 03/2027 vs 2027-03 counts as a match), and give "
        "its bounding box. For 'ingredient', the active substance name printed anywhere counts (any language form, e.g. "
        "'bisoprololfumar.'). For 'allergens' (food), legible means the ingredients list is readable and each expected "
        "allergen can be identified from it (synonyms like whey=milk, arachis oil=peanut are fine). If a field is not "
        "printed or not visible, legible=false and box_2d=[]. Be strict: illegible smudges or misspellings in digits are "
        f"not legible/matching.\n\nExpected ({'BACK side view' if back else 'main label'}):\n{exp_txt}"
    )
    contents = [part_bytes(img, "image/jpeg"), prompt]
    data, _, _ = gen_json(CHECK_MODEL, contents, schema=CHECK_SCHEMA, thinking="high", max_tokens=8192,
                          feature="gen_images.check", label="check")
    return data


def to_jpeg(png: bytes, size: int = 1024) -> bytes:
    from PIL import Image

    im = Image.open(io.BytesIO(png)).convert("RGB")
    if max(im.size) > size:
        im.thumbnail((size, size))
    b = io.BytesIO()
    im.save(b, "JPEG", quality=90)
    return b.getvalue()


def gt_from_check(s: dict, chk: dict) -> dict:
    """Per-field ground truth for this render: value + visibility status + box."""
    by = {f["field"]: f for f in chk.get("fields", [])}
    gt = {}
    for f in FIELDS:
        c = by.get(f)
        val = {
            "product": s.get("product"), "ingredient": s.get("ingredient") or None,
            "strength": s.get("strength") or None, "dosing": s.get("dosing") or None,
            "expiry": s.get("expiry") or None, "barcode": s.get("barcode") or None,
            "allergens": sorted(set(s.get("allergens") or [])) if s["kind"] == "food" else None,
            "may_contain": sorted(set(s.get("may_contain") or [])) if s["kind"] == "food" else None,
        }[f]
        if c is None:
            status = "hidden"
        elif c["legible"] and c["matches_spec"]:
            status = "visible"
        elif c["legible"] and not c["matches_spec"]:
            status = "excluded"  # rendered text differs from spec: don't score this field
        else:
            status = "hidden"
        box = c.get("box_2d") if c else []
        gt[f] = {"value": val, "status": status, "box": box if box and len(box) == 4 else [],
                 "lines": (c or {}).get("line_count") or 1, "printed": (c or {}).get("printed_text", "")}
    return gt


def keep(s: dict, gt: dict, chk: dict) -> bool:
    if not chk.get("photo_ok", True):
        return False
    return all(gt[f]["status"] == "visible" for f in KEY_FIELDS[s["kind"]])


def process(s: dict, back: bool) -> dict:
    tries = []
    models = list(IMAGE_MODELS)
    for attempt in range(2):
        order = models if attempt == 0 else models[1:] + models[:1]
        png, model = render(render_prompt(s, back), order)
        img = to_jpeg(png)
        chk = check(img, s, back)
        gt = gt_from_check(s, chk)
        ok = (not back and keep(s, gt, chk)) or (back and gt["strength"]["status"] != "visible"
                                                 and gt["product"]["status"] != "visible")
        tries.append({"model": model, "ok": ok, "garbled": chk.get("garbled_text"), "notes": chk.get("notes", "")[:300]})
        if ok:
            name = f"{s['id']}_back.jpg" if back else f"{s['id']}.jpg"
            (DATA / "clean").mkdir(parents=True, exist_ok=True)
            (DATA / "clean" / name).write_bytes(img)
            row = {"id": s["id"] + ("_back" if back else ""), "spec_id": s["id"], "kind": s["kind"], "view": "back" if back else "front",
                   "file": f"clean/{name}", "render_model": model, "gt": gt, "garbled_other": chk.get("garbled_text"),
                   "tries": tries}
            append_jsonl(DATA / "renders.jsonl", row)
            return row
    row = {"id": s["id"] + ("_back" if back else ""), "spec_id": s["id"], "dropped": True, "tries": tries}
    append_jsonl(DATA / "renders_dropped.jsonl", row)
    return row


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--back", type=int, default=40, help="number of medication specs that also get a back-of-box render")
    a = ap.parse_args()
    random.seed(7)
    specs = read_jsonl(DATA / "specs.jsonl")
    if a.limit:
        specs = specs[: a.limit]
    done = {r["id"] for r in read_jsonl(DATA / "renders.jsonl")} | {r["id"] for r in read_jsonl(DATA / "renders_dropped.jsonl")}
    jobs = [(s, False) for s in specs if s["id"] not in done]
    meds = [s for s in specs if s["kind"] == "medication"]
    for s in random.sample(meds, min(a.back, len(meds))):
        if s["id"] + "_back" not in done:
            jobs.append((s, True))
    log(f"{len(jobs)} render jobs ({len(done)} already done)")
    res = pmap(lambda j: process(*j), jobs, workers=a.workers, desc="renders")
    kept = sum(1 for r in res if r and not r.get("dropped") and not r.get("error"))
    errs = [r for r in res if r and r.get("error")]
    log(f"kept {kept}/{len(jobs)}; errors {len(errs)}")
    for e in errs[:5]:
        log("error:", e["error"][:200])


if __name__ == "__main__":
    main()
