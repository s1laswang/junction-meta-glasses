"""Render eval/out/results.json into docs/EVAL.md and copy a few small example JPEGs to docs/img/.

Usage: python eval/make_report.py [--examples med003__glare_3,food001__clean_0,...]
"""
from __future__ import annotations

import argparse
import json
import time

from common import DATA, OUT, REPO

FIELDS = ["product", "ingredient", "strength", "dosing", "expiry", "allergens", "barcode"]
DEG_ORDER = ["clean", "rotation", "defocus", "motion_blur", "low_light", "glare", "crop", "back_of_box", "real"]


def f(x, suf="%"):
    return "–" if x is None else f"{x}{suf}"


def field_table(res):
    rows = ["| Field | n | Accuracy (readable) | Abstain (readable) | Wrong (readable) | Abstain (not visible) | "
            "Confident-wrong (≥0.8) |", "|---|---|---|---|---|---|---|"]
    for k in FIELDS:
        a = res["per_field"].get(k)
        if not a:
            continue
        rows.append(f"| {k} | {a['n']} | {f(a['acc_visible'])} | {f(a['abstain_visible'])} | {f(a['wrong_visible'])} | "
                    f"{f(a['abstain_hidden'])} | **{a['confident_wrong']}** ({f(a['confident_wrong_rate'])}) |")
    return "\n".join(rows)


def deg_table(res, field):
    rows = [f"| Condition | sev | n | Accuracy (readable) | Abstain (partial/hidden) | Wrong | Confident-wrong |",
            "|---|---|---|---|---|---|---|"]
    keys = [k for k in res["per_field_deg_sev"] if k.startswith(field + "|")]
    keys.sort(key=lambda k: (DEG_ORDER.index(k.split("|")[1]) if k.split("|")[1] in DEG_ORDER else 99, int(k.split("|")[2])))
    for k in keys:
        a = res["per_field_deg_sev"][k]
        _, d, s = k.split("|")
        nh = a["n_partial"] + a["n_hidden"]
        ab = None
        if nh:
            ab = round(100 * ((a["abstain_partial"] or 0) * a["n_partial"] + (a["abstain_hidden"] or 0) * a["n_hidden"]) / 100 / nh, 1)
        wr = None
        if a["n"]:
            w = (a["wrong_visible"] or 0) * a["n_visible"] + (a["wrong_partial"] or 0) * a["n_partial"] + (a["wrong_hidden"] or 0) * a["n_hidden"]
            wr = round(w / a["n"], 1)
        rows.append(f"| {d} | {s} | {a['n']} | {f(a['acc_visible'])} | {f(ab)} (n={nh}) | {f(wr)} | {a['confident_wrong']} |")
    return "\n".join(rows)


def calib_table(c):
    rows = ["| Confidence bin | n | Mean confidence | Accuracy |", "|---|---|---|---|"]
    for b in c["bins"]:
        if b["n"]:
            rows.append(f"| {b['bin']} | {b['n']} | {b['mean_conf']} | {f(b['accuracy'])} |")
    rows.append(f"\nExpected calibration error (ECE): **{c['ece']}**")
    return "\n".join(rows)


def sweep_table(s):
    rows = ["| Trust threshold t | Readable strengths accepted (coverage) | Trusted reads | Trusted but wrong | Wrong rate among trusted |",
            "|---|---|---|---|---|"]
    for x in s:
        rows.append(f"| {x['t']} | {f(x['coverage_visible'])} | {x['trusted']} | {x['trusted_wrong']} | {f(x['trusted_wrong_rate'])} |")
    return "\n".join(rows)


def safety_table(res):
    rows = ["| Threshold | Verdicts | Correct vs truth | Unsure | **Unsafe reassurance** | False match |", "|---|---|---|---|---|---|"]
    for t, s in res["safety"].items():
        rows.append(f"| {t} | {s['n']} | {f(s['verdict_correct_vs_world'])} | {f(s['unsure_rate'])} | "
                    f"**{s['unsafe_reassurance']}** ({f(s['unsafe_reassurance_rate'])}) | {s['false_match']} |")
    return "\n".join(rows)


def scen_table(s):
    rows = ["| Scenario | n | Correct | Unsure | Unsafe |", "|---|---|---|---|---|"]
    for k, v in s["by_scenario"].items():
        rows.append(f"| {k} | {v['n']} | {f(v['correct'])} | {f(v['unsure'])} | {v['unsafe']} |")
    return "\n".join(rows)


def ledger_table(led):
    rows = ["| Workforce step | Model | Calls (ok) | Input tokens | Output tokens | Thinking tokens |", "|---|---|---|---|---|---|"]
    tot = {"calls": 0, "in": 0, "out": 0, "thinking": 0}
    for k, v in sorted(led.items()):
        feat, model = k.split("|", 1)
        rows.append(f"| {feat} | {model} | {v['calls']} ({v['ok']}) | {v['in']:,} | {v['out']:,} | {v['thinking']:,} |")
        for t in tot:
            tot[t] += v[t]
    rows.append(f"| **total** | | **{tot['calls']}** | **{tot['in']:,}** | **{tot['out']:,}** | **{tot['thinking']:,}** |")
    return "\n".join(rows)


def copy_examples(ids):
    from PIL import Image

    out = []
    (REPO / "docs" / "img").mkdir(parents=True, exist_ok=True)
    for i in ids:
        src = DATA / "images" / f"{i}.jpg"
        if not src.exists():
            continue
        im = Image.open(src).convert("RGB")
        im.thumbnail((480, 480))
        dst = REPO / "docs" / "img" / f"eval_{i}.jpg"
        im.save(dst, "JPEG", quality=72)
        out.append((i, f"img/eval_{i}.jpg"))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--examples", default="")
    ap.add_argument("--version", default="v1")
    ap.add_argument("--notes", default="", help="markdown file with hand-written findings to splice in")
    a = ap.parse_args()
    R = json.loads((OUT / "results.json").read_text())
    syn = R.get("synthetic")
    real = R.get("real")
    md = [f"# HoldUp eval ({a.version})", "",
          f"_Generated {time.strftime('%Y-%m-%d %H:%M')} by `eval/make_report.py` from `eval/out/results.json`._", "",
          f"Model under test: `{R['model']}` (thinking `{R['thinking']}`), prompt + schema from `{R['prompt_src']}` "
          f"(hash `{R['prompt_hash']}`). Confident = confidence ≥ {R['conf_threshold']}. Safety rules: {R['safety_impl']}.", ""]
    if a.notes:
        md += [open(a.notes).read(), ""]
    if syn:
        d = syn.get("dataset", {})
        s8 = syn["safety"].get("0.8", {})
        st = syn["per_field"].get("strength", {})
        md += ["## Headline (synthetic set)", "",
               f"- **{d.get('images')} images** from {d.get('specs')} Gemini-generated label specs "
               f"({d.get('renders_kept')} renders kept, {d.get('renders_dropped')} dropped as garbled).",
               f"- Strength: **{f(st.get('acc_visible'))} accurate when readable**, **{st.get('confident_wrong')} confident-wrong "
               f"reads out of {st.get('n')}** ({f(st.get('confident_wrong_rate'))}); abstains on {f(st.get('abstain_hidden'))} "
               f"of strengths that are not visible.",
               f"- End-to-end safety verdict (t=0.8): **{s8.get('unsafe_reassurance')} unsafe reassurances in {s8.get('n')} "
               f"verdicts** ({f(s8.get('unsafe_reassurance_rate'))}); correct {f(s8.get('verdict_correct_vs_world'))}, "
               f"unsure {f(s8.get('unsure_rate'))}.",
               f"- Latency per verify call: p50 {syn['latency_s']['p50']} s, p95 {syn['latency_s']['p95']} s.", "",
               "### Dataset", "", "| Condition | Images |", "|---|---|"]
        md += [f"| {k} | {v} |" for k, v in d.get("by_deg", {}).items()]
        md += ["", "### Per-field accuracy (all conditions)", "", field_table(syn), "",
               "_Readable_ = the field is legible in the image per the render check and the degradation model. "
               "_Not visible_ = cropped, under glare, too blurred, or on the back of the box; the honest answer is null.", "",
               "### Strength by degradation and severity", "", deg_table(syn, "strength"), "",
               "### Allergens by degradation and severity", "", deg_table(syn, "allergens"), "",
               "### Calibration: strength", "", calib_table(syn["calibration_strength"]), "",
               "### Calibration: all fields", "", calib_table(syn["calibration_all"]), "",
               "### Choosing the 'unsure' threshold for strength", "", sweep_table(syn["threshold_sweep_strength"]), "",
               "### End-to-end safety verdict", "",
               "Each image is checked against 2–3 profiles: the item on the list at the same strength, on the list at a "
               "different strength, not on the list (medicines); allergic to an allergen it contains, or to one it doesn't (food). "
               "_Unsafe reassurance_ = the true verdict is a warning (wrong strength, not your med, allergen, expired) but the "
               "system says match/no-allergen.", "", safety_table(syn), "", "Per scenario at t=0.8:", "", scen_table(s8), ""]
        ex = syn.get("confident_wrong_examples", [])
        if ex:
            md += ["### Confident-wrong examples", "", "| Image | Field | GT status | Truth | Read | Conf |", "|---|---|---|---|---|---|"]
            md += [f"| {e['img_id']} | {e['field']} | {e['status']} | {e['gt']} | {e['pred']} | {e['conf']} |" for e in ex[:25]]
            md += [""]
    if real:
        md += ["## Real photos", "", f"{real['images_scored']} photos. Latency p50 {real['latency_s']['p50']} s.", "",
               field_table(real), "", safety_table(real), ""]
    else:
        md += ["## Real photos", "", "_Pending: photos land in `eval/real/` with `labels.csv` (v2)._", ""]
    if a.examples:
        exs = copy_examples([x for x in a.examples.split(",") if x])
        if exs:
            md += ["## Example images", ""] + [f"![{i}]({p})" for i, p in exs] + [""]
    if R.get("ledger"):
        md += ["## Gemini as a workforce: calls and tokens", "", ledger_table(R["ledger"]), ""]
    md += ["## Method", "",
           "1. `eval/gen_specs.py`: gemini-3.8-flash writes ground-truth label specs (medicine boxes and bottles incl. "
           "Finnish/Swedish packs; food packs with allergen synonyms and trace statements).",
           "2. `eval/gen_images.py`: gemini-3.1-flash-image renders a first-person photo of a hand holding each item (fallback "
           "gemini-3-pro-image, nano-banana-pro-preview); a separate check call (gemini-3.8-flash, thinking high, given the "
           "spec) marks each field legible/matching and returns its bounding box. Renders with garbled key fields are "
           "re-rendered once, then dropped; mismatched minor fields are excluded from scoring. A subset gets a back-of-box render.",
           "3. `eval/degrade.py` (Slurm, CPU): motion blur, defocus, rotation, partial crop, glare, low light at 3 severities; "
           "each field's ground-truth status (readable / partial / not visible) is updated from its bounding box.",
           "4. `eval/run_eval.py`: runs the product's verify prompt and schema on each 768 px frame (one frame per call), "
           "scores fields with normalisation (units, dates, allergen synonyms), and runs the safety rules.", "",
           "Caveats: the render check uses the same model family as the model under test (gemini-3.1-pro-preview is not "
           "available on our key), so 'readable' labels lean on Gemini's own reading of the clean render; a bias toward "
           "easier ground truth is possible. Degradation visibility is a heuristic from text height and box overlap. "
           "Real photos (v2) are the check on both."]
    (REPO / "docs" / "EVAL.md").write_text("\n".join(md) + "\n")
    print("wrote docs/EVAL.md")


if __name__ == "__main__":
    main()
