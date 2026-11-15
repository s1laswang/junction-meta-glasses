"""Eval harness for verify_label: runs the product's verify prompt + schema over every image
and scores per-field accuracy, abstention, confident-wrong rate, calibration, latency and
the end-to-end safety verdict.

  python eval/run_eval.py predict --set synthetic   # Gemini calls (I/O bound; login node, niced)
  python eval/run_eval.py predict --set real
  python eval/run_eval.py score                     # CPU only: metrics -> eval/out/results.json + docs/EVAL.md tables

Prompt/schema: uses shared/verify_prompt.md + shared/label_schema.json (the server's real
files) when present, else eval/draft/*. The source and a hash are recorded in results.json.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import random
import statistics
from collections import defaultdict
from pathlib import Path

from common import (DATA, EVAL_DIR, OUT, REPO, SHARED, VERIFY_MODEL, append_jsonl, gen_json, log, pmap,
                    read_jsonl)
from normalize import COMPARE, canon_allergens, eq_ingredient, eq_strength_strict
from safety import verdict as py_verdict

FIELDS = ["product", "ingredient", "strength", "dosing", "expiry", "allergens", "barcode"]
CONF_T = 0.8
REAL = EVAL_DIR / "real"


# ---------------------------------------------------------------- prompt + schema
SNAPSHOT = Path(os.environ["HOLDUP_SNAPSHOT"]) if os.environ.get("HOLDUP_SNAPSHOT") else None


def inline_refs(s, defs=None):
    """Same as server/src/verify.ts inlineRefs: inline $ref/$defs, drop $comment."""
    if defs is None:
        defs = s.get("$defs", {}) if isinstance(s, dict) else {}
    if isinstance(s, list):
        return [inline_refs(x, defs) for x in s]
    if isinstance(s, dict):
        if isinstance(s.get("$ref"), str):
            return inline_refs(defs[s["$ref"].split("/")[-1]], defs)
        return {k: inline_refs(v, defs) for k, v in s.items() if k not in ("$defs", "$comment")}
    return s


def load_prompt_schema():
    """Prefer the server's real files: repo shared/ (after merge), then a snapshot of
    origin/feat/server extracted by pipeline.sh sync, then eval/draft."""
    cands = [(SHARED, "shared")]
    if SNAPSHOT:
        cands.append((SNAPSHOT / "shared", "feat/server@" + (SNAPSHOT / "SHA").read_text().strip()[:8]
                      if (SNAPSHOT / "SHA").exists() else "snapshot"))
    cands.append((EVAL_DIR / "draft", "eval/draft"))
    for d, src in cands:
        p, s = d / "verify_prompt.md", d / "label_schema.json"
        if p.exists() and s.exists():
            break
    prompt, schema_txt = p.read_text(), s.read_text()
    h = hashlib.sha256((prompt + schema_txt).encode()).hexdigest()[:12]
    schema = inline_refs(json.loads(schema_txt))
    return prompt, schema, src, h


def safety_ts_path():
    for p in ([REPO / "server" / "src" / "safety.ts"] + ([SNAPSHOT / "server" / "src" / "safety.ts"] if SNAPSHOT else [])):
        if p.exists():
            return p
    return None


def to_label_read(j):
    """Python port of server/src/verify.ts toLabelRead (coercion applied before the safety check)."""
    def clamp(x):
        return max(0.0, min(1.0, float(x))) if isinstance(x, (int, float)) else 0.0
    def field(x, is_t):
        v = x.get("value") if isinstance(x, dict) else None
        v = v if is_t(v) else None
        c = clamp(x.get("confidence") if isinstance(x, dict) else 0)
        return {"value": v, "confidence": min(c, 0.3) if v is None else c}
    is_str = lambda v: isinstance(v, str) and v.strip() != ""
    is_arr = lambda v: isinstance(v, list) and all(isinstance(s, str) for s in v)
    if not isinstance(j, dict):
        j = {}
    kind = j.get("kind") if j.get("kind") in ("medication", "food", "other", "unreadable") else "unreadable"
    r = {"kind": kind, "product": field(j.get("product"), is_str), "ingredient": field(j.get("ingredient"), is_str),
         "strength": field(j.get("strength"), is_str), "dosing": field(j.get("dosing"), is_str),
         "expiry": field(j.get("expiry"), is_str), "allergens": field(j.get("allergens"), is_arr),
         "barcode": field(j.get("barcode"), is_str), "readability": clamp(j.get("readability"))}
    if is_str(j.get("guidance")):
        r["guidance"] = j["guidance"].strip()[:120]
    import re as _re
    if r["expiry"]["value"] and not _re.match(r"^\d{4}-\d{2}(-\d{2})?$", r["expiry"]["value"]):
        r["expiry"]["confidence"] = min(r["expiry"]["confidence"], 0.5)
    return r


USER_TEXT = os.environ.get("VERIFY_USER_TEXT", "Read this label.")
THINKING = os.environ.get("VERIFY_THINKING", "low")


def predict_one(img_bytes: bytes, prompt: str, schema: dict, mime="image/jpeg"):
    from google.genai import types

    contents = [types.Part.from_bytes(data=img_bytes, mime_type=mime), USER_TEXT]
    data, _, dt = gen_json(VERIFY_MODEL, contents, schema=schema, system=prompt, thinking=THINKING,
                           max_tokens=4096, feature="eval.verify_label", label="verify")
    return data, dt


# ---------------------------------------------------------------- datasets
def synthetic_rows():
    rows = read_jsonl(DATA / "dataset.jsonl")
    ov_path = EVAL_DIR / "gt_overrides.json"
    ov = json.loads(ov_path.read_text()) if ov_path.exists() else {}
    for r in rows:
        for f, v in (ov.get(r["spec_id"]) or {}).items():
            if not f.startswith("_") and f in r["gt"]:
                r["gt"][f]["value"] = v
                r["gt"][f]["overridden"] = True
    return rows


def real_rows():
    f = REAL / "labels.csv"
    rows = []
    if not f.exists():
        return rows
    for r in csv.DictReader(f.open()):
        fn = (r.get("file") or "").strip()
        if not fn or fn == "example.jpg" or not (REAL / fn).exists():
            continue
        gt = {}
        for k in FIELDS:
            v = (r.get(k) or "").strip()
            if k == "allergens":
                if r.get("kind") != "food":
                    gt[k] = {"value": None, "status": "excluded"}
                    continue
                if v.lower() in ("none", "-", "[]"):
                    gt[k] = {"value": [], "status": "visible"}
                elif v:
                    gt[k] = {"value": sorted(canon_allergens([x for x in v.replace(";", ",").split(",")])),
                             "status": "visible"}
                else:
                    gt[k] = {"value": None, "status": "excluded"}
            else:
                gt[k] = {"value": v or None, "status": "visible" if v else "excluded"}
        rows.append({"img_id": "real/" + fn, "file": str(REAL / fn), "kind": r.get("kind") or "other",
                     "deg": "real", "sev": 0, "gt": gt, "notes": r.get("notes", ""), "spec_id": fn})
    return rows


def preds_path(which):
    return OUT / f"preds_{which}.jsonl"


def cmd_predict(a):
    prompt, schema, src, h = load_prompt_schema()
    rows = synthetic_rows() if a.set == "synthetic" else real_rows()
    if a.limit:
        random.Random(0).shuffle(rows)
        rows = rows[: a.limit]
    pp = preds_path(a.set)
    done = {r["img_id"] for r in read_jsonl(pp) if r.get("prompt_hash") == h and not r.get("error")}
    todo = [r for r in rows if r["img_id"] not in done]
    log(f"predict {a.set}: {len(todo)} to do, {len(done)} cached; prompt={src} hash={h} model={VERIFY_MODEL}")

    def run(r):
        path = Path(r["file"]) if os.path.isabs(r["file"]) else DATA / r["file"]
        try:
            pred, dt = predict_one(path.read_bytes(), prompt, schema)
            out = {"img_id": r["img_id"], "pred": pred, "latency_s": round(dt, 3), "prompt_hash": h,
                   "prompt_src": src, "model": VERIFY_MODEL}
        except Exception as e:  # noqa: BLE001
            out = {"img_id": r["img_id"], "error": str(e)[:300], "prompt_hash": h}
        append_jsonl(pp, out)
        return out

    res = pmap(run, todo, workers=a.workers, desc=f"verify {a.set}")
    log(f"errors: {sum(1 for r in res if r.get('error'))}")


# ---------------------------------------------------------------- scoring
def gt_value(row, f):
    g = row["gt"]
    if f == "allergens" and "may_contain" in g:
        if row["kind"] != "food":
            return None, "excluded"
        v = sorted(set((g["allergens"]["value"] or []) + (g["may_contain"]["value"] or [])))
        st = g["allergens"]["status"]
        if g["may_contain"]["value"] and g["may_contain"]["status"] in ("hidden", "partial") and st == "visible":
            st = "partial"
        return v, st
    x = g.get(f) or {"value": None, "status": "excluded"}
    if f == "allergens" and row["kind"] != "food":
        return None, "excluded"
    return x["value"], x["status"]


def pred_field(pred, f):
    x = pred.get(f) if isinstance(pred, dict) else None
    if not isinstance(x, dict):
        return None, 0.0
    v = x.get("value")
    if v == "" or (isinstance(v, str) and v.strip().lower() in ("null", "none", "unknown", "n/a")):
        v = None
    return v, float(x.get("confidence") or 0.0)


def classify(row, pred, f):
    """-> dict(status, outcome in {correct, wrong, abstain}, conf) or None if unscored."""
    if row["kind"] == "food" and f in ("ingredient", "strength", "dosing"):
        return None
    if row["kind"] == "medication" and f == "allergens":
        return None
    gv, st = gt_value(row, f)
    if st == "excluded":
        return None
    pv, conf = pred_field(pred, f)
    if st != "hidden" and gv in (None, ""):
        # field doesn't exist on this item (e.g. no dosing printed): treat as hidden
        st = "hidden"
    if pv is None or (isinstance(pv, list) and f != "allergens" and not pv):
        return {"status": st, "outcome": "abstain", "conf": conf}
    if gv in (None, ""):
        return {"status": st, "outcome": "wrong", "conf": conf}  # invented a value for a field that isn't there
    ok = COMPARE[f](gv, pv) if f != "allergens" else COMPARE[f](gv, pv if isinstance(pv, list) else [pv])
    return {"status": st, "outcome": "correct" if ok else "wrong", "conf": conf}


def pct(n, d):
    return round(100.0 * n / d, 1) if d else None


def agg(items):
    """items: list of classify() outputs."""
    vis = [i for i in items if i["status"] == "visible"]
    par = [i for i in items if i["status"] == "partial"]
    hid = [i for i in items if i["status"] == "hidden"]
    answered = [i for i in items if i["outcome"] != "abstain"]
    cw = [i for i in items if i["outcome"] == "wrong" and i["conf"] >= CONF_T]
    return {
        "n": len(items), "n_visible": len(vis), "n_partial": len(par), "n_hidden": len(hid),
        "acc_visible": pct(sum(i["outcome"] == "correct" for i in vis), len(vis)),
        "abstain_visible": pct(sum(i["outcome"] == "abstain" for i in vis), len(vis)),
        "wrong_visible": pct(sum(i["outcome"] == "wrong" for i in vis), len(vis)),
        "acc_partial": pct(sum(i["outcome"] == "correct" for i in par), len(par)),
        "abstain_partial": pct(sum(i["outcome"] == "abstain" for i in par), len(par)),
        "wrong_partial": pct(sum(i["outcome"] == "wrong" for i in par), len(par)),
        "abstain_hidden": pct(sum(i["outcome"] == "abstain" for i in hid), len(hid)),
        "guess_hidden": pct(sum(i["outcome"] != "abstain" for i in hid), len(hid)),
        "wrong_hidden": pct(sum(i["outcome"] == "wrong" for i in hid), len(hid)),
        "precision_answered": pct(sum(i["outcome"] == "correct" for i in answered), len(answered)),
        "confident_wrong": len(cw),
        "confident_wrong_rate": pct(len(cw), len(items)),
        "confident_wrong_of_confident": pct(len(cw), sum(1 for i in answered if i["conf"] >= CONF_T)),
        "k": {  # raw counts, for Wilson CIs in the report
            "correct_visible": sum(i["outcome"] == "correct" for i in vis),
            "abstain_visible": sum(i["outcome"] == "abstain" for i in vis),
            "wrong_visible": sum(i["outcome"] == "wrong" for i in vis),
            "abstain_hidden": sum(i["outcome"] == "abstain" for i in hid),
            "wrong_hidden": sum(i["outcome"] == "wrong" for i in hid),
            "answered": len(answered), "correct_answered": sum(i["outcome"] == "correct" for i in answered),
            "confident": sum(1 for i in answered if i["conf"] >= CONF_T),
            "wrong_any": sum(i["outcome"] == "wrong" for i in items),
        },
    }


def wilson(k: int, n: int, z: float = 1.96):
    """95% Wilson score interval for k/n, as percentages (lo, hi)."""
    if not n:
        return None
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * ((p * (1 - p) / n + z * z / (4 * n * n)) ** 0.5) / d
    return round(100 * max(0.0, c - h), 2), round(100 * min(1.0, c + h), 2)


def bootstrap(values, stat, B=1000, seed=0):
    rng = random.Random(seed)
    if not values:
        return None
    xs = sorted(stat([rng.choice(values) for _ in values]) for _ in range(B))
    return round(xs[int(0.025 * B)], 3), round(xs[int(0.975 * B) - 1], 3)


CAL_BINS = (0, .5, .6, .7, .8, .9, .95, 1.0001)


def _ece(ans, bins=CAL_BINS):
    n = len(ans)
    if not n:
        return None
    e = 0.0
    for lo, hi in zip(bins[:-1], bins[1:]):
        b = [i for i in ans if lo <= i["conf"] < hi]
        if b:
            acc = sum(i["outcome"] == "correct" for i in b) / len(b)
            e += len(b) / n * abs(acc - statistics.mean(i["conf"] for i in b))
    return e


def calibration(items, bins=CAL_BINS):
    out = []
    ans = [i for i in items if i["outcome"] != "abstain"]
    for lo, hi in zip(bins[:-1], bins[1:]):
        b = [i for i in ans if lo <= i["conf"] < hi]
        k = sum(i["outcome"] == "correct" for i in b)
        out.append({"bin": f"[{lo:.2f},{min(hi,1):.2f}{']' if hi > 1 else ')'}", "n": len(b), "k": k,
                    "mean_conf": round(statistics.mean(i["conf"] for i in b), 3) if b else None,
                    "accuracy": pct(k, len(b)), "acc_ci": wilson(k, len(b))})
    ece = _ece(ans, bins)
    return {"bins": out, "n_answered": len(ans), "ece": round(ece, 3) if ece is not None else None,
            "ece_ci": bootstrap(ans, lambda xs: _ece(xs, bins), B=500)}


def threshold_sweep(items, ts=(0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95)):
    """If the safety check only trusts values with conf >= t: coverage on readable fields vs wrong-trusted."""
    out = []
    readable = [i for i in items if i["status"] == "visible"]
    for t in ts:
        trusted = [i for i in items if i["outcome"] != "abstain" and i["conf"] >= t]
        wrong = [i for i in trusted if i["outcome"] == "wrong"]
        cov = [i for i in readable if i["outcome"] == "correct" and i["conf"] >= t]
        out.append({"t": t, "coverage_visible": pct(len(cov), len(readable)),
                    "trusted": len(trusted), "trusted_wrong": len(wrong),
                    "trusted_wrong_rate": pct(len(wrong), len(trusted)),
                    "trusted_wrong_per_item": pct(len(wrong), len(items))})
    return out


# ---------------------------------------------------------------- safety scenarios
DECOY_MEDS = [
    {"id": "d1", "name": "Furesis", "ingredient": "furosemide", "strength": "40 mg", "schedule": ["morning"]},
    {"id": "d2", "name": "Levaxin", "ingredient": "levothyroxine", "strength": "100 mikrog", "schedule": ["morning"]},
    {"id": "d3", "name": "Primaspan", "ingredient": "acetylsalicylic acid", "strength": "100 mg", "schedule": ["morning"]},
]


def other_strength(s: str) -> str:
    import re
    m = re.search(r"(\d+(?:[.,]\d+)?)", s or "")
    if not m:
        return "999 mg"
    n = float(m.group(1).replace(",", "."))
    alt = n * 2 if n < 400 else n / 2
    alt_s = str(int(alt)) if alt == int(alt) else str(alt)
    return s[: m.start()] + alt_s + s[m.end():]


def scenarios(row):
    """Profiles to test this image against, with the scenario name."""
    g = row["gt"]
    out = []
    if row["kind"] == "medication":
        ing, st, prod = g["ingredient"]["value"], g["strength"]["value"], g["product"]["value"]
        if not ing or not st:
            return out
        base = {"allergies": [], "avoid": [], "doseLog": [], "lang": "en"}
        # decoys must not share the item's ingredient (else the user really has it on the list)
        decoys = [d for d in DECOY_MEDS if not (eq_ingredient(d["ingredient"], ing) or eq_ingredient(ing, d["ingredient"])
                                                or eq_ingredient(d["ingredient"], prod or ""))]
        out.append(("on_list_same_strength", dict(base, meds=decoys + [
            {"id": "m1", "name": prod, "ingredient": ing, "strength": st, "schedule": ["evening"]}])))
        out.append(("on_list_other_strength", dict(base, meds=decoys + [
            {"id": "m1", "name": prod, "ingredient": ing, "strength": other_strength(st), "schedule": ["evening"]}])))
        out.append(("not_on_list", dict(base, meds=decoys)))
    elif row["kind"] == "food":
        al = sorted(set((g["allergens"]["value"] or []) + ((g.get("may_contain") or {}).get("value") or [])))
        base = {"meds": DECOY_MEDS, "avoid": [], "doseLog": [], "lang": "en"}
        if al:
            out.append(("allergic_to_contained", dict(base, allergies=[al[0].replace("_", " ")])))
        absent = [a for a in ("peanut", "sesame", "fish", "egg", "milk") if a not in al]
        if absent:
            out.append(("allergic_to_absent", dict(base, allergies=[absent[0]])))
    return out


def gt_read(row, visible_only: bool):
    """Ideal LabelRead from ground truth. visible_only=False -> the true world state."""
    g = row["gt"]
    def fld(f):
        v, st = gt_value(row, f)
        if f == "allergens" and row["kind"] != "food":
            return {"value": None, "confidence": 0.0}
        if v is None or v == "" or (visible_only and st != "visible"):
            return {"value": None, "confidence": 0.0}
        if f == "allergens":
            may = set(((g.get("may_contain") or {}).get("value")) or [])
            con = set((g.get("allergens") or {}).get("value") or [])
            v = [x.replace("_", " ") for x in sorted(con)] + \
                ["may contain: " + x.replace("_", " ") for x in sorted(may - con)]
        if f == "expiry":
            v = (g.get("expiry") or {}).get("value") or v
        return {"value": v, "confidence": 1.0}
    read = {f: fld(f) for f in FIELDS}
    read["kind"] = row["kind"]
    read["readability"] = 1.0
    return read


def ts_verdicts(cases, ts_path):
    """Batch-call the server's checkLabel through npx tsx. Returns list of levels or None if unavailable."""
    import shutil
    import subprocess
    import tempfile

    tsx = os.environ.get("HOLDUP_TSX")  # path to a locally installed tsx (compute nodes have no internet)
    cmd = [tsx] if tsx and os.path.exists(tsx) else (["npx", "--yes", "tsx"] if shutil.which("npx") else None)
    if not ts_path or not cmd:
        return None
    with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as f:
        for c in cases:
            f.write(json.dumps(c, ensure_ascii=False) + "\n")
        fn = f.name
    try:
        r = subprocess.run(cmd + [str(EVAL_DIR / "safety_bridge.mts")], stdin=open(fn),
                           capture_output=True, text=True, timeout=600,
                           env=dict(os.environ, HOLDUP_SAFETY_TS=str(ts_path)))
        if r.returncode != 0:
            log("safety bridge failed:", r.stderr[-500:])
            return None
        outs = [json.loads(l) for l in r.stdout.splitlines() if l.strip()]
        return outs if len(outs) == len(cases) else None
    finally:
        os.unlink(fn)


SAFETY_IMPL = {"impl": None}


def run_safety(rows, preds, t=None, transform=None):
    """Per-(image, scenario) verdicts from the server's real safety check (TS bridge) or the Python port.
    world   = verdict on the true label (all fields, conf 1)
    visible = verdict an ideal reader would give from what is visible in this image
    pred    = verdict on the model's read (after toLabelRead coercion)"""
    meta, cases = [], []
    for r in rows:
        p = preds.get(r["img_id"])
        if not p or p.get("error"):
            continue
        pr = to_label_read(p["pred"]); pr = transform(pr) if transform else pr
        for name, prof in scenarios(r):
            meta.append({"img_id": r["img_id"], "deg": r["deg"], "sev": r["sev"], "kind": r["kind"], "scenario": name})
            cases += [{"read": gt_read(r, False), "profile": prof}, {"read": gt_read(r, True), "profile": prof},
                      {"read": pr, "profile": prof}]
    outs = None
    if t is None:
        outs = ts_verdicts(cases, safety_ts_path())
    if outs is not None:
        SAFETY_IMPL["impl"] = f"server/src/safety.ts via npx tsx (STRENGTH_MIN_CONF from the module)"
        levels = [o["level"] for o in outs]
        reasons = [o["reasons"] for o in outs]
    else:
        tt = t if t is not None else CONF_T
        SAFETY_IMPL["impl"] = SAFETY_IMPL["impl"] or "python port (eval/safety.py)"
        vs = [py_verdict(c["read"], c["profile"], t=tt) for c in cases]
        levels = [v["level"] for v in vs]
        reasons = [v["reasons"] for v in vs]
    recs = []
    for i, m in enumerate(meta):
        recs.append(dict(m, world=levels[3 * i], visible=levels[3 * i + 1], pred=levels[3 * i + 2],
                         pred_reasons=reasons[3 * i + 2][:6], world_reasons=reasons[3 * i][:3]))
    return recs


def safety_summary(recs):
    n = len(recs)
    unsafe_all = [x for x in recs if x["world"] == "warning" and x["pred"] in ("match", "info")]
    # A match that says "I couldn't read the expiry date" on an expired box is disclosed, not silent.
    caveated = [x for x in unsafe_all if any("expiry not readable" in r for r in x.get("pred_reasons") or [])
                and any(r.startswith("expired") for r in x.get("world_reasons") or [])]
    unsafe = [x for x in unsafe_all if x not in caveated]
    def cat(x):
        w = " ".join(x.get("world_reasons") or [])
        if "allergy:" in w:
            return "missed_allergen"
        if "differs" in w:
            return "wrong_strength_matched"
        if "not on your" in w:
            return "not_on_list_matched"
        if "avoid" in w:
            return "avoid_list_missed"
        if "expired" in w:
            return "expired_date_misread_or_unseen"
        return "other"
    for x in unsafe:
        x["category"] = cat(x)
    unsafe_by_cat = {}
    for x in unsafe:
        unsafe_by_cat[x["category"]] = unsafe_by_cat.get(x["category"], 0) + 1
    false_match = [x for x in recs if x["pred"] == "match" and x["world"] != "match"]
    correct = [x for x in recs if x["pred"] == x["world"]]
    unsure = [x for x in recs if x["pred"] == "unsure"]
    agree_vis = [x for x in recs if x["pred"] == x["visible"]]
    by_scen = defaultdict(list)
    for x in recs:
        by_scen[x["scenario"]].append(x)
    return {
        "n": n, "unsafe_reassurance": len(unsafe), "unsafe_reassurance_rate": pct(len(unsafe), n),
        "unsafe_ci": wilson(len(unsafe), n), "correct_k": len(correct), "unsure_k": len(unsure),
        "correct_ci": wilson(len(correct), n), "unsure_ci": wilson(len(unsure), n),
        "expired_match_with_caveat": len(caveated), "caveated_examples": caveated[:10],
        "unsafe_by_category": unsafe_by_cat,
        "false_match": len(false_match), "false_match_rate": pct(len(false_match), n),
        "verdict_correct_vs_world": pct(len(correct), n), "unsure_rate": pct(len(unsure), n),
        "agree_with_ideal_reader": pct(len(agree_vis), n),
        "by_scenario": {k: {"n": len(v), "correct": pct(sum(x["pred"] == x["world"] for x in v), len(v)),
                            "unsure": pct(sum(x["pred"] == "unsure" for x in v), len(v)),
                            "unsafe": sum(1 for x in v if x in unsafe)}
                        for k, v in sorted(by_scen.items())},
        "unsafe_examples": unsafe[:40],
    }


def quantile(xs, q):
    xs = sorted(xs)
    if not xs:
        return None
    k = (len(xs) - 1) * q
    lo = int(k)
    hi = min(lo + 1, len(xs) - 1)
    return round(xs[lo] + (xs[hi] - xs[lo]) * (k - lo), 2)


def score_set(rows, preds, label):
    per_field = defaultdict(list)
    per_field_deg = defaultdict(list)
    per_field_degsev = defaultdict(list)
    wrong_examples = []
    allergen_sets = []
    field_specs = defaultdict(set)
    strength_incomplete = []
    lat = []
    errors = 0
    for r in rows:
        p = preds.get(r["img_id"])
        if not p:
            continue
        if p.get("error"):
            errors += 1
            continue
        lat.append(p["latency_s"])
        pr = to_label_read(p["pred"])
        for f in FIELDS:
            c = classify(r, pr, f)
            if c is None:
                continue
            per_field[f].append(c); field_specs[f].add(r["spec_id"])
            if f == "strength" and c["outcome"] == "correct":
                gv, _ = gt_value(r, f)
                pv, _ = pred_field(pr, f)
                if not eq_strength_strict(gv, pv):  # right numbers, but a printed equivalent/second part dropped
                    strength_incomplete.append({"img_id": r["img_id"], "gt": gv, "pred": pv, "conf": c["conf"]})
            per_field_deg[(f, r["deg"])].append(c)
            per_field_degsev[(f, r["deg"], r["sev"])].append(c)
            if c["outcome"] == "wrong" and c["conf"] >= CONF_T and len(wrong_examples) < 400:
                gv, st = gt_value(r, f)
                wrong_examples.append({"img_id": r["img_id"], "field": f, "status": st, "gt": gv,
                                       "pred": pred_field(pr, f)[0], "conf": c["conf"], "deg": r["deg"], "sev": r["sev"]})
            if f == "allergens" and c["status"] == "visible" and c["outcome"] != "abstain":
                gv, _ = gt_value(r, f)
                got = canon_allergens(pred_field(pr, f)[0] or [])
                allergen_sets.append({"missed": sorted(set(gv) - got), "extra": sorted(got - set(gv)),
                                      "img_id": r["img_id"], "conf": c["conf"]})
    allf = [c for f in FIELDS for c in per_field[f]]
    na = len(allergen_sets)
    allergen_recall = {
        "n_answered_visible": na,
        "all_allergens_found": pct(sum(not x["missed"] for x in allergen_sets), na),
        "missed_any": sum(1 for x in allergen_sets if x["missed"]),
        "all_found_ci": wilson(sum(not x["missed"] for x in allergen_sets), na),
        "missed_confident_ci": wilson(sum(1 for x in allergen_sets if x["missed"] and x["conf"] >= 0.6), na),
        "missed_any_confident": sum(1 for x in allergen_sets if x["missed"] and x["conf"] >= 0.6),
        "extra_any": sum(1 for x in allergen_sets if x["extra"]),
        "missed_examples": [x for x in allergen_sets if x["missed"]][:20],
    }
    res = {
        "label": label, "images_scored": len(lat), "errors": errors,
        "latency_s": {"n": len(lat), "p50": quantile(lat, .5), "p95": quantile(lat, .95),
                      "p50_ci": bootstrap(lat, lambda xs: quantile(xs, .5)),
                      "p95_ci": bootstrap(lat, lambda xs: quantile(xs, .95)),
                      "mean": round(statistics.mean(lat), 2) if lat else None},
        "overall": agg(allf),
        "per_field": {f: agg(v) for f, v in per_field.items()},
        "per_field_deg": {f"{f}|{d}": agg(v) for (f, d), v in sorted(per_field_deg.items())},
        "per_field_deg_sev": {f"{f}|{d}|{s}": agg(v) for (f, d, s), v in sorted(per_field_degsev.items())},
        "calibration_all": calibration(allf),
        "calibration_strength": calibration(per_field["strength"]),
        "threshold_sweep_strength": threshold_sweep(per_field["strength"]),
        "threshold_sweep_all": threshold_sweep(allf),
        "confident_wrong_examples": sorted(wrong_examples, key=lambda e: (e["field"] != "strength", e["field"])),
        "allergen_recall": allergen_recall,
        "specs_per_field": {k: len(v) for k, v in field_specs.items()}, "strength_incomplete": {"n": len(strength_incomplete), "examples": strength_incomplete[:20]},
    }
    sweeps = {}
    recs = run_safety(rows, preds, None)  # server's safety.ts if node+tsx available
    sweeps["server"] = safety_summary(recs)
    sweeps["server"]["impl"] = SAFETY_IMPL["impl"]
    sweeps["server"]["by_deg"] = {d: safety_summary([x for x in recs if x["deg"] == d]) for d in sorted({x["deg"] for x in recs})}
    for d in sweeps["server"]["by_deg"].values():
        d.pop("by_scenario", None); d.pop("unsafe_examples", None)
    # Counterfactual policies, applied to the model's read before the same safety.ts runs.
    import copy

    def food_partial_unsure(r):
        r = copy.deepcopy(r)
        if r["kind"] == "food" and (r["readability"] < 0.7 or r.get("guidance")) and r["allergens"]["value"] is not None:
            r["allergens"]["confidence"] = min(r["allergens"]["confidence"], 0.3)
        return r

    def expiry_09(r):
        r = copy.deepcopy(r)
        if r["expiry"]["value"] and r["expiry"]["confidence"] < 0.9:
            r["expiry"]["confidence"] = min(r["expiry"]["confidence"], 0.5)
        return r

    variants = {"A_food_partial_panel_unsure": food_partial_unsure, "B_expiry_trust_0.9": expiry_09,
                "A+B": lambda r: expiry_09(food_partial_unsure(r))}
    if SAFETY_IMPL["impl"] and "safety.ts" in SAFETY_IMPL["impl"]:
        for name, fn in variants.items():
            s = safety_summary(run_safety(rows, preds, None, transform=fn))
            s.pop("unsafe_examples", None); s.pop("caveated_examples", None)
            sweeps["variant " + name] = s
    res["safety"] = sweeps
    return res


def cmd_score(a):
    prompt, schema, src, h = load_prompt_schema()
    results = {"model": VERIFY_MODEL, "prompt_src": src, "prompt_hash": h, "conf_threshold": CONF_T,
               "thinking": THINKING, "safety_impl": "python port (eval/safety.py)"}
    for which, rows in (("synthetic", synthetic_rows()), ("real", real_rows())):
        preds = {}
        for p in read_jsonl(preds_path(which)):
            if p.get("prompt_hash") == (a.hash or h):
                if p["img_id"] not in preds or not p.get("error"):
                    preds[p["img_id"]] = p
        if not preds:
            continue
        results[which] = score_set(rows, preds, which)
        if which == "synthetic":
            results[which]["dataset"] = {
                "specs": len({r["spec_id"] for r in rows}),
                "images": len(rows),
                "by_deg": {d: sum(1 for r in rows if r["deg"] == d) for d in sorted({r["deg"] for r in rows})},
                "by_kind": {k: sum(1 for r in rows if r["kind"] == k) for k in sorted({r["kind"] for r in rows})},
            }
            ren = read_jsonl(DATA / "renders.jsonl")
            drop = read_jsonl(DATA / "renders_dropped.jsonl")
            results[which]["dataset"]["renders_kept"] = len(ren)
            results[which]["dataset"]["renders_dropped"] = len(drop)
    results["safety_impl"] = SAFETY_IMPL["impl"]
    led = read_jsonl(OUT / "ledger.jsonl")
    by = defaultdict(lambda: {"calls": 0, "ok": 0, "in": 0, "out": 0, "thinking": 0})
    for l in led:
        k = f"{l['feature']}|{l['model']}"
        by[k]["calls"] += 1; by[k]["ok"] += 1 if l["ok"] else 0
        for t in ("in", "out", "thinking"):
            by[k][t] += l.get(t) or 0
    results["ledger"] = dict(by)
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "results.json").write_text(json.dumps(results, indent=1, ensure_ascii=False))
    log(f"wrote {OUT/'results.json'}")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("predict")
    p.add_argument("--set", choices=["synthetic", "real"], default="synthetic")
    p.add_argument("--workers", type=int, default=12)
    p.add_argument("--limit", type=int, default=0)
    s = sub.add_parser("score")
    s.add_argument("--hash", default=None, help="score predictions made with this prompt hash")
    a = ap.parse_args()
    {"predict": cmd_predict, "score": cmd_score}[a.cmd](a)


if __name__ == "__main__":
    main()
