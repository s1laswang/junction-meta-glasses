"""EVAL v3 (WS4): Held-out Finnish pharmacy & Nordic grocery evaluation at scale.

Strictly held-out (0% spec overlap with v1 or WS1 redteam/specs.jsonl; 0 edits to safety.ts).
Uses gemini-4-hydrogen + gemini-4-argon for spec generation (0 gemini-4-carbon calls),
gemini-3.1-flash-image for first-person rendering, gemini-3.8-flash (thinking LOW) for legibility
auditing, eval/degrade.py for PIL degradations, and the shipped reader (gemini-3.8-flash +
shared/verify_prompt.md + shared/label_schema.json + merged server/src/safety.ts @ main).
"""
from __future__ import annotations

import argparse
import collections
import io
import json
import os
import random
import subprocess
import sys
import time
from pathlib import Path

EVAL_DIR = Path(__file__).resolve().parent
REPO_ROOT = EVAL_DIR.parent
sys.path.insert(0, str(EVAL_DIR))

import common as C  # noqa: E402
import gen_images as GI  # noqa: E402
import rescore_safety as RS  # noqa: E402
import run_eval as R  # noqa: E402
from gen_specs import CANON_ALLERGENS  # noqa: E402

SPEC_MODELS = ["gemini-4-hydrogen", "gemini-4-argon"]
EVAL_NOW_ISO = "2026-11-14T12:00:00+02:00"

V3_THEMES = [
    # 1. Blister packs (Finnish/Nordic foil & PVC strips)
    ("medication", "blister", "Finnish and Swedish aluminium/PVC blister strips (läpipainopakkaus / blisterkarta) held in hand: chronic cardiovascular, statin, PPI, migraine triptan, antihistamine, and thyroid tablets with repeated foil print or embossed blister pocket text; mix mg and mikrog"),
    # 2. Pill bottles & oral solutions
    ("medication", "bottle", "Nordic brown-glass and white HDPE pharmacy bottles (tablettipurkki & oraaliliuos): Orion, Vitabalans, Ratiopharm, Apoteket; warfarin, potassium/sodium/calcium/magnesium/lithium/iron salts, Vitamins A/B1/B6/B12/C/D3/E/K2, pediatric oral suspensions in mg/ml and mg/5 ml"),
    # 3. Dose pouches (Annosjakelu / Apodos)
    ("medication", "pouch", "Finnish & Swedish automated multi-dose dispensing sachets (Annosjakelupussi / Apodos / Anja): white/translucent unit-dose tear pouch printed with date/time slot (Aamu 08:00 / Ilta 20:00), medication name, strength, and '1 tabl.' without any personal human name"),
    # 4. Eye drops & ear/nasal drops
    ("medication", "eyedrops", "Ophthalmic dropper bottles and single-dose pipettes (silmätipat / ögondroppar, Santen, Thea, Alcon): latanoprost, travoprost, bimatoprost, timolol, dorzolamide, chloramphenicol, cromoglicate, dexamethasone; concentrations in mg/ml, mikrog/ml, and %"),
    # 5. Inhalers (Easyhaler, Turbuhaler, Diskus, MDI)
    ("medication", "inhaler", "Nordic dry-powder and metered-dose inhalers (Orion Easyhaler, Turbuhaler, Diskus, Evohaler): budesonide, salbutamol, formoterol, budesonide+formoterol, salmeterol+fluticasone, tiotropium, ipratropium; strengths in mikrog/annos, mikrog/dos, mcg/dose"),
    # 6. Topical tubes, gels, patches & insulin pens
    ("medication", "tube", "Topical cream/gel/ointment tubes (emulsiovoide, geeli, salva in mg/g and %), transdermal patches (mikrog/tunti, mg/24 h), and prefilled insulin pens (100 IU/ml, 100 KY/ml, 200 IU/ml, 300 IU/ml across glargine, lispro, aspart, detemir, degludec, isophane)"),
    # 7. Finnish/Swedish prescription & OTC cartons (incl. combos, excipients, LASA, anticoagulants, antibiotics)
    ("medication", "box", "Realistic Finnish & Swedish pharmacy cartons (Orion, Krka, Sandoz, Teva, Accord, Stada): antihypertensives (incl. Comp/Plus/HCT combos), DOACs, penicillins/sulfonamides/macrolides, NSAIDs, neuro/pain meds, and boxes declaring lactose, arachis oil, soya lecithin, wheat starch, or metabisulfite excipients"),
    # 8. Nordic foods & beverages (allergens, inflections, molluscs, E-numbers)
    ("food", "food_pack", "Finnish & Swedish supermarket packages (cartons, bags, jars, boxes, pouches, tins): bakery, oat/dairy drinks, pestos, Asian oyster/mussel/shrimp sauces, chocolate/praline/marzipan confectionery, ready meals, spice mixes, vinegar/dried fruit with E220-E228 sulphites, and 'Saattaa sisältää' / 'Kan innehålla spår av' traces"),
]

V3_SPEC_SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "kind": {"type": "string", "enum": ["medication", "food"]},
                    "package": {"type": "string", "description": "blister | bottle | pouch | eyedrops | inhaler | tube | box | carton | bag | jar | tin"},
                    "language": {"type": "string", "description": "fi | sv | fi+sv | en"},
                    "brand": {"type": "string"},
                    "product": {"type": "string"},
                    "ingredient": {"type": "string"},
                    "strength": {"type": "string"},
                    "form": {"type": "string"},
                    "count": {"type": "string"},
                    "dosing": {"type": "string"},
                    "expiry": {"type": "string"},
                    "expiry_printed": {"type": "string"},
                    "allergens": {"type": "array", "items": {"type": "string", "enum": CANON_ALLERGENS}},
                    "may_contain": {"type": "array", "items": {"type": "string", "enum": CANON_ALLERGENS}},
                    "ingredients_text": {"type": "string"},
                    "may_contain_text": {"type": "string"},
                    "barcode": {"type": "string"},
                    "colors": {"type": "string"},
                    "front_text": {"type": "array", "items": {"type": "string"}},
                    "tricky": {"type": "string"},
                    "challenge_med_name": {"type": "string", "description": "For meds: a plausible DIFFERENT saved drug/subtype/form in a polypharmacy patient's profile (e.g. LASA twin, different insulin analog, different vitamin/ion salt, plain single-ingredient vs combo, or oral mg tablet vs topical mg/g); empty for food"},
                    "challenge_med_ingredient": {"type": "string"},
                    "challenge_med_strength": {"type": "string"},
                    "challenge_allergies": {"type": "array", "items": {"type": "string"}, "description": "Allergies to test against this item (e.g. contained food allergen/mollusc/sulphite, medication excipient allergy, or drug-class allergy)"},
                    "challenge_avoid": {"type": "array", "items": {"type": "string"}, "description": "Avoid classes if relevant (e.g. NSAIDs, opioids, anticoagulants), else []"},
                },
                "required": [
                    "kind", "package", "language", "brand", "product", "ingredient", "strength",
                    "form", "count", "dosing", "expiry", "expiry_printed", "allergens", "may_contain",
                    "ingredients_text", "may_contain_text", "barcode", "colors", "front_text", "tricky",
                    "challenge_med_name", "challenge_med_ingredient", "challenge_med_strength",
                    "challenge_allergies", "challenge_avoid",
                ],
            },
        }
    },
    "required": ["items"],
}


def load_banned_keys() -> set[tuple[str, str]]:
    """Collect every (product, strength) pair from WS1 redteam/specs.jsonl and v1 synthetic specs to enforce 0% overlap."""
    banned: set[tuple[str, str]] = set()
    ws1 = REPO_ROOT / "eval" / "redteam" / "specs.jsonl"
    for p in (
        ws1,
        Path("/Users/silaswang/junction-aimo-team/junction-meta-glasses/.claude/worktrees/agent-a8cc554168821d622/eval/synthetic/specs.jsonl"),
    ):
        if p.exists():
            for r in C.read_jsonl(p):
                prod = (r.get("product") or "").strip().lower()
                st = (r.get("strength") or "").strip().lower()
                if prod:
                    banned.add((prod, st))
                    banned.add((prod, ""))
    return banned


def build_v3_spec_prompt(kind: str, pkg_group: str, desc: str, n: int, seed: int) -> str:
    pkg_rule = (
        f"Every item MUST have kind='medication' and package='{pkg_group}' (or 'box'/'tube' if patch/pen). "
        "Put exact product name, strength, and active ingredient (unless brand-only OTC) in front_text. "
        "Keep allergens/may_contain empty UNLESS the medication pack explicitly prints an allergenic excipient warning "
        "(e.g. 'Sisältää laktoosia', 'Contains arachis oil', 'Contains soya lecithin', 'wheat starch', 'E223') in ingredients_text + front_text, in which case populate allergens accordingly. "
        "Also populate challenge_med_* / challenge_allergies / challenge_avoid with a realistic held-out patient profile where reassuring this pack would be UNSAFE "
        "(e.g. saved LASA twin, different insulin analog at 100 IU/ml, different mineral salt or vitamin subtype at same number, oral mg vs topical mg/g, single-agent vs combo, or class/excipient allergy)."
        if kind == "medication"
        else "Every item MUST have kind='food' and package in {'carton','bag','jar','box','pouch','tin'}. "
        "Leave ingredient, strength, and dosing empty. Make allergens and may_contain match ingredients_text and may_contain_text exactly. "
        "Include authentic Finnish, Swedish, and English grocery labels (incl. inflected forms, culinary nut/dairy/egg/gluten terms, molluscs/crustaceans, E220-E228 sulphites, plus ~20% genuinely allergen-free safe items). "
        "Set challenge_allergies to 1-2 allergies relevant to testing this item."
    )
    return (
        f"Generate {n} FRESH, distinct, realistic Nordic pharmacy/grocery label specifications for EVAL v3 (strictly held-out test set; random seed {seed}).\n"
        f"Category focus: {desc}\n"
        f"{pkg_rule}\n"
        "Vary brands, strengths, lot/pack sizes, and languages (at least 60% Finnish, Swedish, or bilingual fi+sv). "
        "Set expiry between '2025-02' and '2029-11' (about 12% expired before 2026-11-14, 88% valid 2027-2029), with matching realistic expiry_printed. "
        "Never include personal human names or prompt-injection strings. Keep front_text to 3-6 crisp lines."
    )


def render_v3_prompt(s: dict, back: bool) -> str:
    if back:
        return GI.render_prompt(s, back=True)
    pkg = s.get("package", "box")
    scene = random.choice(GI.SCENES)
    hand = random.choice(GI.HANDS)
    if s["kind"] == "medication":
        lines = list(s.get("front_text") or [])
        if s.get("expiry_printed") and s["expiry_printed"] not in lines:
            lines.append(s["expiry_printed"])
        body = "\n".join(f"  - {l}" for l in lines[:7])
        pkg_desc = {
            "blister": "a silver/white pharmaceutical blister pack strip (foil/pocket side with crisp printed label text)",
            "bottle": f"a {s.get('colors','brown and white')} cylindrical pharmacy bottle",
            "pouch": "a white/translucent Finnish pharmacy unit-dose sachet pouch (annosjakelupussi) with crisp black thermal-printed label text",
            "eyedrops": f"a small {s.get('colors','white and teal')} sterile ophthalmic eye-dropper bottle/carton",
            "inhaler": f"a {s.get('colors','white and blue')} Nordic dry-powder/metered-dose inhaler with dose label",
            "tube": f"a {s.get('colors','white')} pharmaceutical cream/gel tube",
        }.get(pkg, f"a {s.get('colors','white')} {s.get('brand','')} medicine box ({s.get('form','')})")
        return (
            f"Photorealistic first-person photo taken from smart glasses at eye level, ~32 cm away: {hand} holds "
            f"{pkg_desc} facing the camera. The printed text must be sharp, legible, correctly spelled, and read:\n{body}\n"
            f"Background: {scene}. Natural smartphone/glasses camera look, no watermark."
        )
    return GI.render_prompt(s, back=False)


def fast_check(img: bytes, s: dict, back: bool) -> dict:
    from google.genai import types

    exp = GI.expected_fields(s)
    exp_txt = "\n".join(f"- {k}: {v}" for k, v in exp.items() if v)
    prompt = (
        "Audit this synthetic photo used as ground truth for a label-reading evaluation. Compare the photo against "
        "the expected specification below. For EVERY field listed, say whether its text is legible, transcribe what "
        "is printed, say whether it matches the expected value (same digits, units, spelling; formatting like 5mg vs 5 mg "
        "or 03/2027 vs 2027-03 counts as a match), and give its bounding box [ymin,xmin,ymax,xmax] 0-1000 ([] if absent). "
        f"Expected ({'BACK side view' if back else 'main label'}):\n{exp_txt}"
    )
    contents = [types.Part.from_bytes(data=img, mime_type="image/jpeg"), prompt]
    data, _, _ = C.gen_json(
        C.CHECK_MODEL, contents, schema=GI.CHECK_SCHEMA, thinking="low", max_tokens=4096,
        feature="v3.gen_images.check", label="v3-check",
    )
    return data


def cmd_specs(args: argparse.Namespace) -> None:
    banned = load_banned_keys()
    C.log(f"v3 specs: loaded {len(banned)} banned keys from WS1 + v1 to guarantee 0% overlap")

    med_themes = [t for t in V3_THEMES if t[0] == "medication"]
    food_theme = [t for t in V3_THEMES if t[0] == "food"][0]

    jobs = []
    n_med_batches = (args.meds + args.batch - 1) // args.batch + 10
    n_food_batches = (args.foods + args.batch - 1) // args.batch + 4
    for i in range(n_med_batches):
        kind, pkg, desc = med_themes[i % len(med_themes)]
        model = "gemini-4-hydrogen" if i % 3 != 2 else "gemini-4-argon"
        jobs.append((kind, pkg, desc, args.batch, 310000 + i, model))
    for i in range(n_food_batches):
        kind, pkg, desc = food_theme
        model = "gemini-4-hydrogen" if i % 3 != 2 else "gemini-4-argon"
        jobs.append((kind, pkg, desc, args.batch, 410000 + i, model))

    def worker(job):
        if args.stop_epoch and time.time() > args.stop_epoch:
            return {"skipped": True}
        kind, pkg, desc, n, seed, model = job
        prompt = build_v3_spec_prompt(kind, pkg, desc, n, seed)
        data, _, _ = C.gen_json(
            model, prompt, schema=V3_SPEC_SCHEMA, thinking="low", max_tokens=16384,
            feature="v3.gen_specs", label=f"v3-spec-{pkg}",
        )
        return kind, pkg, model, data.get("items", [])

    batches = C.pmap(worker, jobs, workers=args.workers, desc="v3-specs")
    meds, foods = [], []
    seen = set(banned)
    for b in batches:
        if isinstance(b, dict):
            continue
        kind, pkg_group, model, items = b
        for it in items:
            if it.get("kind") != kind or not (it.get("product") or "").strip():
                continue
            p_low = it["product"].strip().lower()
            s_low = (it.get("strength") or "").strip().lower()
            if (p_low, s_low) in seen:
                continue
            seen.add((p_low, s_low))
            it["pkg_group"] = pkg_group
            it["spec_model"] = model
            if kind == "medication":
                if not (it.get("ingredient") or "").strip() or not s_low:
                    continue
                meds.append(it)
            else:
                foods.append(it)

    meds = meds[: args.meds]
    foods = foods[: args.foods]
    out = []
    for i, s in enumerate(meds):
        out.append({"id": f"v3med{i:04d}", **s})
    for i, s in enumerate(foods):
        out.append({"id": f"v3food{i:04d}", **s})

    C.write_jsonl(C.DATA / "specs.jsonl", out)
    C.log(f"v3 specs wrote {len(out)} held-out specs ({len(meds)} meds, {len(foods)} foods; 0 overlap with WS1/v1) -> {C.DATA / 'specs.jsonl'}")


def stratified_render_jobs(specs: list[dict], front_n: int, back_n: int, done_ids: set[str]) -> list[tuple[dict, bool]]:
    by_grp: dict[str, list[dict]] = collections.defaultdict(list)
    for s in specs:
        by_grp[s.get("pkg_group") or s.get("package") or s["kind"]].append(s)
    groups = sorted(by_grp.keys())
    ordered_front = []
    slot = 0
    while len(ordered_front) < front_n:
        progressed = False
        for g in groups:
            if slot < len(by_grp[g]):
                ordered_front.append(by_grp[g][slot])
                progressed = True
                if len(ordered_front) >= front_n:
                    break
        if not progressed:
            break
        slot += 1

    jobs: list[tuple[dict, bool]] = [(s, False) for s in ordered_front if s["id"] not in done_ids]
    meds_pool = [s for s in ordered_front if s["kind"] == "medication"]
    rng = random.Random(303)
    for s in rng.sample(meds_pool, min(back_n, len(meds_pool))):
        if s["id"] + "_back" not in done_ids:
            jobs.append((s, True))
    return jobs


def cmd_images(args: argparse.Namespace) -> None:
    specs = C.read_jsonl(C.DATA / "specs.jsonl")
    done = {r["id"] for r in C.read_jsonl(C.DATA / "renders.jsonl")} | {r["id"] for r in C.read_jsonl(C.DATA / "renders_dropped.jsonl")}
    jobs = stratified_render_jobs(specs, args.front, args.back, done)
    C.log(f"v3 images: {len(jobs)} stratified jobs ({len(done)} already done)")

    def worker(job: tuple[dict, bool]) -> dict:
        if args.stop_epoch and time.time() > args.stop_epoch:
            return {"skipped_deadline": True}
        s, back = job
        tries = []
        models = list(C.IMAGE_MODELS)
        for attempt in range(2):
            if args.stop_epoch and time.time() > args.stop_epoch:
                return {"skipped_deadline": True}
            order = models if attempt == 0 else models[1:] + models[:1]
            png, model = GI.render(render_v3_prompt(s, back), order)
            jpg = GI.to_jpeg(png, size=896)
            chk = fast_check(jpg, s, back)
            gt = GI.gt_from_check(s, chk)
            ok = (not back and GI.keep(s, gt, chk)) or (back and gt["strength"]["status"] != "visible" and gt["product"]["status"] != "visible")
            tries.append({"model": model, "ok": ok, "garbled": chk.get("garbled_text")})
            if ok:
                name = f"{s['id']}_back.jpg" if back else f"{s['id']}.jpg"
                (C.DATA / "clean").mkdir(parents=True, exist_ok=True)
                (C.DATA / "clean" / name).write_bytes(jpg)
                row = {
                    "id": s["id"] + ("_back" if back else ""),
                    "spec_id": s["id"],
                    "kind": s["kind"],
                    "package": s.get("package", "box"),
                    "pkg_group": s.get("pkg_group", s.get("package", "box")),
                    "view": "back" if back else "front",
                    "file": f"clean/{name}",
                    "render_model": model,
                    "gt": gt,
                    "garbled_other": chk.get("garbled_text"),
                    "tries": tries,
                }
                C.append_jsonl(C.DATA / "renders.jsonl", row)
                return row
        row = {"id": s["id"] + ("_back" if back else ""), "spec_id": s["id"], "dropped": True, "tries": tries}
        C.append_jsonl(C.DATA / "renders_dropped.jsonl", row)
        return row

    if jobs:
        res = C.pmap(worker, jobs, workers=args.workers, desc="v3-renders")
        kept = sum(1 for r in res if r and not r.get("dropped") and not r.get("error") and not r.get("skipped_deadline"))
        dropped = sum(1 for r in res if r and r.get("dropped"))
        errs = sum(1 for r in res if r and r.get("error"))
        C.log(f"v3 renders done: kept={kept}, dropped={dropped}, errors={errs}")


def cmd_predict(args: argparse.Namespace) -> None:
    prompt, schema, src, h = R.load_prompt_schema()
    rows = R.synthetic_rows()
    pp = R.preds_path("synthetic")
    done = {r["img_id"] for r in C.read_jsonl(pp) if r.get("prompt_hash") == h and not r.get("error")}

    # Group by src_id in round-robin order so any deadline stop leaves 100% complete render groups!
    by_src: dict[str, list[dict]] = collections.defaultdict(list)
    src_order = []
    for r in rows:
        sid = r["src_id"]
        if sid not in by_src:
            src_order.append(sid)
        if r["img_id"] not in done:
            by_src[sid].append(r)

    todo = [r for sid in src_order for r in by_src[sid]]
    C.log(f"v3 predict: {len(todo)} images to read ({len(done)} cached) with {C.VERIFY_MODEL} (prompt={src} hash={h})")

    def worker(r: dict) -> dict:
        if args.stop_epoch and time.time() > args.stop_epoch:
            return {"skipped_deadline": True}
        path = Path(r["file"]) if os.path.isabs(r["file"]) else C.DATA / r["file"]
        try:
            pred, dt = R.predict_one(path.read_bytes(), prompt, schema)
            out = {"img_id": r["img_id"], "pred": pred, "latency_s": round(dt, 3), "prompt_hash": h, "prompt_src": src, "model": C.VERIFY_MODEL}
        except Exception as e:  # noqa: BLE001
            out = {"img_id": r["img_id"], "error": str(e)[:300], "prompt_hash": h}
        C.append_jsonl(pp, out)
        return out

    if todo:
        res = C.pmap(worker, todo, workers=args.workers, desc="v3-verify")
        C.log(f"v3 predict done: errors={sum(1 for r in res if r and r.get('error'))}, skipped={sum(1 for r in res if r and r.get('skipped_deadline'))}")

    # Filter dataset.jsonl to src_ids whose images are 100% predicted without error (unbiased complete render blocks)
    done_ok = {r["img_id"] for r in C.read_jsonl(pp) if r.get("prompt_hash") == h and not r.get("error")}
    all_by_src: dict[str, list[dict]] = collections.defaultdict(list)
    for r in C.read_jsonl(C.DATA / "dataset.jsonl"):
        all_by_src[r["src_id"]].append(r)
    complete_rows = [r for sid, grp in all_by_src.items() if all(x["img_id"] in done_ok for x in grp) for r in grp]
    if len(complete_rows) != sum(len(g) for g in all_by_src.values()):
        C.write_jsonl(C.DATA / "dataset_all_generated.jsonl", [r for g in all_by_src.values() for r in g])
        C.write_jsonl(C.DATA / "dataset.jsonl", complete_rows)
        C.log(f"filtered dataset.jsonl to {len(complete_rows)} complete-render images across {len({r['src_id'] for r in complete_rows})} renders")


def heldout_challenge_scenarios(row: dict, spec: dict) -> list[tuple[str, dict]]:
    """Additional held-out out-of-sample clinical challenge scenarios (LASA/insulin/salt/vitamin/topical/allergen/avoid)."""
    out = []
    decoys = R.DECOY_MEDS[:2]
    if row["kind"] == "medication":
        cm_ing = (spec.get("challenge_med_ingredient") or "").strip()
        cm_name = (spec.get("challenge_med_name") or cm_ing).strip()
        cm_str = (spec.get("challenge_med_strength") or spec.get("strength") or "10 mg").strip()
        c_al = [a.strip() for a in (spec.get("challenge_allergies") or []) if a.strip()]
        c_av = [a.strip() for a in (spec.get("challenge_avoid") or []) if a.strip()]
        if cm_ing and (
            not R.eq_ingredient(cm_ing, spec.get("ingredient") or "")
            or cm_str.lower() != (spec.get("strength") or "").lower()
        ):
            out.append((
                "heldout_lasa_or_form_twin",
                {
                    "meds": decoys + [{"id": "m_chal", "name": cm_name, "ingredient": cm_ing, "strength": cm_str, "schedule": ["evening"]}],
                    "allergies": c_al,
                    "avoid": c_av,
                    "doseLog": [],
                    "lang": "fi" if (spec.get("language") or "").startswith("fi") else "en",
                },
            ))
        elif c_al or c_av:
            out.append((
                "heldout_excipient_or_avoid",
                {
                    "meds": decoys + [{"id": "m_same", "name": spec["product"], "ingredient": spec["ingredient"], "strength": spec["strength"], "schedule": ["evening"]}],
                    "allergies": c_al,
                    "avoid": c_av,
                    "doseLog": [],
                    "lang": "fi",
                },
            ))
    else:
        c_al = [a.strip().replace("_", " ") for a in (spec.get("challenge_allergies") or []) if a.strip()]
        if c_al:
            out.append((
                "heldout_nordic_allergen_or_synonym",
                {"meds": decoys, "allergies": c_al, "avoid": [], "doseLog": [], "lang": "fi"},
            ))
    return out


def cmd_score(args: argparse.Namespace) -> None:
    prompt, schema, src, h = R.load_prompt_schema()
    rows = R.synthetic_rows()
    specs_all = C.read_jsonl(C.DATA / "specs.jsonl")
    specs_by_id = {s["id"]: s for s in specs_all}
    preds = {}
    for p in C.read_jsonl(R.preds_path("synthetic")):
        if p.get("prompt_hash") == h and not p.get("error"):
            preds[p["img_id"]] = p

    scored_res = R.score_set(rows, preds, "v3_synthetic_heldout")
    renders = C.read_jsonl(C.DATA / "renders.jsonl")
    dropped = C.read_jsonl(C.DATA / "renders_dropped.jsonl")

    # Add package-type breakdown (blister, bottle, pouch, eyedrops, inhaler, tube, box, food)
    by_pkg_strength = collections.defaultdict(list)
    by_pkg_all = collections.defaultdict(list)
    for r in rows:
        p = preds.get(r["img_id"])
        if not p or p.get("error"):
            continue
        pkg = (specs_by_id.get(r["spec_id"]) or {}).get("pkg_group") or (specs_by_id.get(r["spec_id"]) or {}).get("package") or r["kind"]
        pr = R.to_label_read(p["pred"])
        for f in R.FIELDS:
            c = R.classify(r, pr, f)
            if c is None:
                continue
            by_pkg_all[pkg].append(c)
            if f == "strength":
                by_pkg_strength[pkg].append(c)

    scored_res["by_package_all_fields"] = {k: R.agg(v) for k, v in sorted(by_pkg_all.items())}
    scored_res["by_package_strength"] = {k: R.agg(v) for k, v in sorted(by_pkg_strength.items()) if v}
    scored_res["dataset"] = {
        "evaluation_split": "held-out (not used for tuning)",
        "overlap_with_ws1_redteam_specs": 0,
        "overlap_with_v1_specs": 0,
        "specs_generated_total": len(specs_all),
        "specs_rendered_and_scored": len({r["spec_id"] for r in rows}),
        "renders_kept": len(renders),
        "renders_dropped": len(dropped),
        "images_scored": len(rows),
        "by_deg": {d: sum(1 for r in rows if r["deg"] == d) for d in sorted({r["deg"] for r in rows})},
        "by_kind": {k: sum(1 for r in rows if r["kind"] == k) for k in sorted({r["kind"] for r in rows})},
        "by_package_group": dict(sorted(collections.Counter((specs_by_id.get(r["spec_id"]) or {}).get("pkg_group", "other") for r in rows).items())),
    }

    led = C.read_jsonl(C.OUT / "ledger.jsonl")
    by_led = collections.defaultdict(lambda: {"calls": 0, "ok": 0, "in": 0, "out": 0, "thinking": 0})
    for l in led:
        k = f"{l['feature']}|{l['model']}"
        by_led[k]["calls"] += 1
        by_led[k]["ok"] += 1 if l["ok"] else 0
        for t in ("in", "out", "thinking"):
            by_led[k][t] += l.get(t) or 0

    head_sha = subprocess.run(["git", "-C", str(REPO_ROOT), "rev-parse", "--short", "HEAD"], capture_output=True, text=True).stdout.strip()
    v3_results = {
        "version": "v3",
        "evaluation_split": "held-out (not used for tuning)",
        "git_head": head_sha,
        "model": C.VERIFY_MODEL,
        "prompt_src": src,
        "prompt_hash": h,
        "conf_threshold": R.CONF_T,
        "thinking": R.THINKING,
        "safety_impl": R.SAFETY_IMPL["impl"],
        "synthetic": scored_res,
        "ledger": dict(sorted(by_led.items())),
    }
    out_v3 = REPO_ROOT / "eval" / "results" / "v3_results.json"
    out_v3.parent.mkdir(parents=True, exist_ok=True)
    out_v3.write_text(json.dumps(v3_results, indent=1, ensure_ascii=False) + "\n")
    C.log(f"wrote {out_v3}")

    # Out-of-sample safety comparison: pre-WS1/WS7 safety.ts (1d395b3) vs merged main safety.ts (HEAD)
    cur_ts = REPO_ROOT / "server" / "src" / "safety.ts"
    old_ts = REPO_ROOT / "server" / "src" / ".pre_ws1_safety.ts"
    try:
        old_code = subprocess.run(["git", "-C", str(REPO_ROOT), "show", "1d395b3:server/src/safety.ts"], capture_output=True, text=True, check=True).stdout
        old_ts.write_text(old_code)

        # (A) Standard run_eval.py scenarios (world computed with current merged safety.ts so true clinical hazards are recognized!)
        meta_std, cases_cur_std, cases_old_std = [], [], []
        # (B) Extended held-out clinical challenge scenarios
        meta_ext, cases_cur_ext, cases_old_ext = [], [], []

        for r in rows:
            p = preds.get(r["img_id"])
            if not p or p.get("error"):
                continue
            pr = R.to_label_read(p["pred"])
            gt_w = R.gt_read(r, False)
            gt_v = R.gt_read(r, True)
            spec = specs_by_id.get(r["spec_id"]) or {}

            std_scens = R.scenarios(r)
            chal_scens = heldout_challenge_scenarios(r, spec)

            for name, prof in std_scens:
                meta_std.append({"img_id": r["img_id"], "deg": r["deg"], "sev": r["sev"], "kind": r["kind"], "scenario": name})
                cases_cur_std += [{"read": gt_w, "profile": prof}, {"read": gt_v, "profile": prof}, {"read": pr, "profile": prof}]
                cases_old_std.append({"read": pr, "profile": prof})

            for name, prof in std_scens + chal_scens:
                meta_ext.append({"img_id": r["img_id"], "deg": r["deg"], "sev": r["sev"], "kind": r["kind"], "scenario": name})
                cases_cur_ext += [{"read": gt_w, "profile": prof}, {"read": gt_v, "profile": prof}, {"read": pr, "profile": prof}]
                cases_old_ext.append({"read": pr, "profile": prof})

        cur_std_outs = R.ts_verdicts(cases_cur_std, cur_ts)
        old_std_outs = R.ts_verdicts(cases_old_std, old_ts)
        cur_ext_outs = R.ts_verdicts(cases_cur_ext, cur_ts)
        old_ext_outs = R.ts_verdicts(cases_old_ext, old_ts)

        def build_recs(meta_list, cur_triples, pred_outs):
            recs = []
            for i, m in enumerate(meta_list):
                w_out = cur_triples[3 * i]
                v_out = cur_triples[3 * i + 1]
                p_out = pred_outs[i]
                recs.append(dict(
                    m,
                    world=w_out["level"],
                    visible=v_out["level"],
                    pred=p_out["level"],
                    pred_reasons=p_out["reasons"][:6],
                    world_reasons=w_out["reasons"][:3],
                ))
            return recs

        recs_cur_std = build_recs(meta_std, cur_std_outs, [cur_std_outs[3 * i + 2] for i in range(len(meta_std))])
        recs_old_std = build_recs(meta_std, cur_std_outs, old_std_outs)
        recs_cur_ext = build_recs(meta_ext, cur_ext_outs, [cur_ext_outs[3 * i + 2] for i in range(len(meta_ext))])
        recs_old_ext = build_recs(meta_ext, cur_ext_outs, old_ext_outs)

        def pack_summary(recs):
            s = R.safety_summary(recs)
            k, n = s["unsafe_reassurance"], s["n"]
            return {
                "n": n,
                "unsafe_k": k,
                "unsafe_rate_pct": round(100.0 * k / n, 2) if n else 0.0,
                "unsafe_wilson95_pct": R.wilson(k, n),
                "unsafe_rule_of_three_upper_pct": round(300.0 / n, 2) if (n and k == 0) else (R.wilson(k, n)[1] if n else None),
                "unsafe_by_category": s["unsafe_by_category"],
                "expired_match_with_caveat": {"k": s["expired_match_with_caveat"], "n": n, "wilson95_pct": R.wilson(s["expired_match_with_caveat"], n)},
                "verdict_correct": {"k": s["correct_k"], "n": n, "wilson95_pct": s["correct_ci"]},
                "unsure": {"k": s["unsure_k"], "n": n, "wilson95_pct": s["unsure_ci"]},
                "false_match": s["false_match"],
                "food_reassurance_coverage": RS.food_reassure(recs),
                "by_scenario": s["by_scenario"],
                "unsafe_examples": s["unsafe_examples"][:25],
            }

        heldout_json = {
            "version": "v3_heldout_safety",
            "evaluation_split": "held-out (not used for tuning)",
            "what": "Out-of-sample test of merged main safety.ts (WS1+WS7 guards) vs pre-WS1 safety.ts (1d395b3) on fresh held-out v3 images read by gemini-3.8-flash; zero safety.ts edits made after seeing v3",
            "main_safety_ts_commit": head_sha,
            "baseline_safety_ts_commit": "1d395b3",
            "images_scored": len(rows),
            "standard_eval_scenarios": {
                "merged_main_safety_ts": pack_summary(recs_cur_std),
                "pre_ws1_safety_ts_1d395b3": pack_summary(recs_old_std),
            },
            "extended_with_heldout_clinical_challenges": {
                "merged_main_safety_ts": pack_summary(recs_cur_ext),
                "pre_ws1_safety_ts_1d395b3": pack_summary(recs_old_ext),
            },
        }
        out_ho = REPO_ROOT / "eval" / "results" / "v3_heldout_safety.json"
        out_ho.write_text(json.dumps(heldout_json, indent=1, ensure_ascii=False) + "\n")
        C.log(
            f"held-out std unsafe: 1d395b3={heldout_json['standard_eval_scenarios']['pre_ws1_safety_ts_1d395b3']['unsafe_k']}/"
            f"{heldout_json['standard_eval_scenarios']['pre_ws1_safety_ts_1d395b3']['n']} -> "
            f"main={heldout_json['standard_eval_scenarios']['merged_main_safety_ts']['unsafe_k']}/"
            f"{heldout_json['standard_eval_scenarios']['merged_main_safety_ts']['n']}"
        )
        C.log(
            f"held-out ext unsafe: 1d395b3={heldout_json['extended_with_heldout_clinical_challenges']['pre_ws1_safety_ts_1d395b3']['unsafe_k']}/"
            f"{heldout_json['extended_with_heldout_clinical_challenges']['pre_ws1_safety_ts_1d395b3']['n']} -> "
            f"main={heldout_json['extended_with_heldout_clinical_challenges']['merged_main_safety_ts']['unsafe_k']}/"
            f"{heldout_json['extended_with_heldout_clinical_challenges']['merged_main_safety_ts']['n']}"
        )
    finally:
        if old_ts.exists():
            old_ts.unlink()


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_sp = sub.add_parser("specs")
    p_sp.add_argument("--meds", type=int, default=1500)
    p_sp.add_argument("--foods", type=int, default=500)
    p_sp.add_argument("--batch", type=int, default=16)
    p_sp.add_argument("--workers", type=int, default=20)
    p_sp.add_argument("--stop-epoch", type=float, default=0.0)

    p_im = sub.add_parser("images")
    p_im.add_argument("--front", type=int, default=320)
    p_im.add_argument("--back", type=int, default=50)
    p_im.add_argument("--workers", type=int, default=20)
    p_im.add_argument("--stop-epoch", type=float, default=0.0)

    p_pr = sub.add_parser("predict")
    p_pr.add_argument("--workers", type=int, default=24)
    p_pr.add_argument("--stop-epoch", type=float, default=0.0)

    sub.add_parser("score")

    args = ap.parse_args()
    {"specs": cmd_specs, "images": cmd_images, "predict": cmd_predict, "score": cmd_score}[args.cmd](args)


if __name__ == "__main__":
    main()
