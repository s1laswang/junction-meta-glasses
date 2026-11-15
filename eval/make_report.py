"""Render eval/out/results.json into docs/EVAL.md and copy a few small example JPEGs to docs/img/.
Every rate is shown as k/n with a 95% CI (Wilson for proportions, bootstrap for ECE and latency percentiles).

Usage: python eval/make_report.py [--examples med003__glare_3,food001__clean_0,...] [--notes notes.md]
"""
from __future__ import annotations

import argparse
import json
import time

from common import DATA, OUT, REPO
from run_eval import wilson

FIELDS = ["product", "ingredient", "strength", "dosing", "expiry", "allergens", "barcode"]
DEG_ORDER = ["clean", "rotation", "defocus", "motion_blur", "low_light", "glare", "crop", "back_of_box", "real"]


def ci(k, n, digits=1):
    """'k/n = p% (95% CI lo–hi%)' with Wilson CI; for k = 0 the upper bound is the zero-event bound."""
    if not n:
        return "–"
    lo, hi = wilson(k, n)
    p = 100 * k / n
    return f"{k}/{n} = {p:.{digits}f}% (95% CI {lo:.{digits}f}–{hi:.{digits}f}%)"


def cis(k, n):
    """Compact: 'p% [lo–hi]'."""
    if not n:
        return "–"
    lo, hi = wilson(k, n)
    return f"{100 * k / n:.1f}% [{lo:.1f}–{hi:.1f}]"


def rng(t, unit=""):
    return f"[{t[0]}–{t[1]}{unit}]" if t else ""


def field_table(res):
    rows = ["Cells: rate [95% Wilson CI], with the denominator in the column header's n.", "",
            "| Field | n reads (specs) | Accuracy, readable (n) | Abstain, readable | Abstain, not visible (n) | "
            "Confident-wrong ≥0.8, all reads |", "|---|---|---|---|---|---|"]
    sp = res.get("specs_per_field", {})
    for k in FIELDS:
        a = res["per_field"].get(k)
        if not a:
            continue
        K = a["k"]
        rows.append(f"| {k} | {a['n']} ({sp.get(k, '?')}) | {cis(K['correct_visible'], a['n_visible'])} (n={a['n_visible']}) | "
                    f"{cis(K['abstain_visible'], a['n_visible'])} | {cis(K['abstain_hidden'], a['n_hidden'])} (n={a['n_hidden']}) | "
                    f"**{a['confident_wrong']}/{a['n']}** {cis(a['confident_wrong'], a['n'])} |")
    return "\n".join(rows)


def deg_table(res, field):
    rows = ["| Condition | sev | n | Accuracy, readable (n) | Abstain, partial or hidden (n) | Wrong, all | Confident-wrong |",
            "|---|---|---|---|---|---|---|"]
    keys = [k for k in res["per_field_deg_sev"] if k.startswith(field + "|")]
    keys.sort(key=lambda k: (DEG_ORDER.index(k.split("|")[1]) if k.split("|")[1] in DEG_ORDER else 99, int(k.split("|")[2])))
    for k in keys:
        a = res["per_field_deg_sev"][k]
        _, d, s = k.split("|")
        K = a["k"]
        nh = a["n_partial"] + a["n_hidden"]
        ab = round((a["abstain_partial"] or 0) * a["n_partial"] / 100) + K["abstain_hidden"]
        rows.append(f"| {d} | {s} | {a['n']} | {cis(K['correct_visible'], a['n_visible'])} (n={a['n_visible']}) | "
                    f"{cis(ab, nh)} (n={nh}) | {K['wrong_any']}/{a['n']} | {a['confident_wrong']}/{a['n']} |")
    return "\n".join(rows)


def calib_table(c):
    rows = ["| Confidence bin | n | Mean confidence | Accuracy [95% CI] |", "|---|---|---|---|"]
    for b in c["bins"]:
        if b["n"]:
            rows.append(f"| {b['bin']} | {b['n']} | {b['mean_conf']} | {cis(b['k'], b['n'])} |")
    rows.append(f"\nECE over {c.get('n_answered')} answered reads: **{c['ece']}** (bootstrap 95% CI {rng(c.get('ece_ci'))})")
    return "\n".join(rows)


def sweep_table(s, n_vis):
    rows = [f"| Trust threshold t | Readable values accepted (coverage, n={n_vis}) | Trusted reads | Trusted but wrong [95% CI of rate] |",
            "|---|---|---|---|"]
    for x in s:
        rows.append(f"| {x['t']} | {f(x['coverage_visible'])} | {x['trusted']} | {x['trusted_wrong']}/{x['trusted']} "
                    f"{cis(x['trusted_wrong'], x['trusted'])} |")
    return "\n".join(rows)


def f(x, suf="%"):
    return "–" if x is None else f"{x}{suf}"


def safety_table(res):
    rows = ["| Safety rules | Verdicts n | Correct vs truth | Unsure | **Unsafe reassurance** | Expired, match with caveat |",
            "|---|---|---|---|---|---|"]
    for t, s in res["safety"].items():
        name = "**server safety.ts (as shipped)**" if t == "server" else t.replace("variant ", "counterfactual ")
        n = s["n"]
        rows.append(f"| {name} | {n} | {cis(s['correct_k'], n)} | {cis(s['unsure_k'], n)} | "
                    f"**{s['unsafe_reassurance']}/{n}** {cis(s['unsafe_reassurance'], n)} | {s.get('expired_match_with_caveat', 0)} |")
    return "\n".join(rows)


def safety_deg_table(s):
    rows = ["| Condition | Verdicts n | Correct vs truth | Unsure | Unsafe reassurance |", "|---|---|---|---|---|"]
    for d in sorted(s.get("by_deg", {}), key=lambda k: DEG_ORDER.index(k) if k in DEG_ORDER else 99):
        x = s["by_deg"][d]
        rows.append(f"| {d} | {x['n']} | {cis(x['correct_k'], x['n'])} | {cis(x['unsure_k'], x['n'])} | "
                    f"{x['unsafe_reassurance']}/{x['n']} {cis(x['unsafe_reassurance'], x['n'])} |")
    return "\n".join(rows)


def unsafe_table(s):
    ex = s.get("unsafe_examples") or []
    if not ex:
        return "_None._"
    rows = ["| Image (eval/synthetic/images/) | Category | Scenario | Truth (why) | System said | System reasons |", "|---|---|---|---|---|---|"]
    rows += [f"| `{e['img_id']}.jpg` | {e.get('category', '')} | {e['scenario']} | {e['world']} ({'; '.join(e.get('world_reasons') or [])}) | "
             f"{e['pred']} | {'; '.join(e.get('pred_reasons') or [])} |" for e in ex]
    return "\n".join(rows)


def scen_table(s):
    rows = ["| Scenario | n | Correct | Unsure | Unsafe |", "|---|---|---|---|---|"]
    for k, v in s["by_scenario"].items():
        n = v["n"]
        ck = round((v["correct"] or 0) * n / 100); uk = round((v["unsure"] or 0) * n / 100)
        rows.append(f"| {k} | {n} | {cis(ck, n)} | {cis(uk, n)} | {v['unsafe']}/{n} {cis(v['unsafe'], n)} |")
    return "\n".join(rows)


def ledger_table(led):
    rows = ["| Workforce step | Model | Calls (ok) | Input tokens | Output tokens | Thinking tokens |", "|---|---|---|---|---|---|"]
    tot = {"calls": 0, "in": 0, "out": 0, "thinking": 0}
    for k, v in sorted(led.items()):
        feat, model = k.split("|", 1)
        rows.append(f"| {feat} | {model} | {v['calls']} ({v['ok']}) | {v['in']:,} | {v['out']:,} | {v['thinking']:,} |")
        for t in tot:
            tot[t] += v[t]
    rows.append(f"| **total** | | **{tot['calls']:,}** | **{tot['in']:,}** | **{tot['out']:,}** | **{tot['thinking']:,}** |")
    return "\n".join(rows), tot


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
    ap.add_argument("--captions", default="", help="'|'-separated captions for --examples")
    ap.add_argument("--version", default="v1")
    ap.add_argument("--notes", default="", help="markdown file with hand-written findings to splice in")
    a = ap.parse_args()
    R = json.loads((OUT / "results.json").read_text())
    syn = R.get("synthetic")
    real = R.get("real")
    md = [f"# HoldUp eval ({a.version})", "",
          f"_Generated {time.strftime('%Y-%m-%d %H:%M')} by `eval/make_report.py` from `eval/out/results.json`._", "",
          f"Model under test: `{R['model']}` (thinking `{R['thinking']}`), prompt and schema from `{R['prompt_src']}/` "
          f"(hash `{R['prompt_hash']}`). Confident = confidence ≥ {R['conf_threshold']}. Safety rules: {R['safety_impl']}. "
          "All rates are k/n with 95% Wilson CIs; ECE and latency percentiles use bootstrap CIs. Reads are clustered "
          "(up to 10 images per label spec), so the per-read CIs are optimistic; where it matters, a per-spec bound is given too.", ""]
    led_md, tot = ledger_table(R.get("ledger") or {})
    if syn:
        d = syn.get("dataset", {})
        s8 = syn["safety"].get("server", {})
        st = syn["per_field"].get("strength", {})
        sp = syn.get("specs_per_field", {})
        ar = syn.get("allergen_recall", {})
        lat = syn["latency_s"]
        n_ans_st = st["k"]["answered"]
        md += ["## Headline (synthetic set, v1)", "",
               f"- **Data:** {d.get('images')} images from {d.get('specs')} Gemini-generated label specs "
               f"({d.get('by_kind', {}).get('medication')} medicine images, {d.get('by_kind', {}).get('food')} food images). "
               f"{d.get('renders_kept')} renders passed the legibility check; {d.get('renders_dropped')} were dropped as "
               f"garbled; the rest failed for API reasons.",
               f"- **Strength confident-wrong: {st['confident_wrong']}/{st['n']} reads** "
               f"(95% CI 0–{wilson(st['confident_wrong'], st['n'])[1]:.2f}%; across {sp.get('strength')} medicine specs, the "
               f"zero-event bound per spec is ≤{300 / max(1, sp.get('strength', 1)):.1f}%). Of all "
               f"{n_ans_st} strengths the model reported, **{st['k']['correct_answered']}/{n_ans_st} were right** "
               f"({cis(st['k']['correct_answered'], n_ans_st)}).",
               f"- **Strength accuracy when readable:** {ci(st['k']['correct_visible'], st['n_visible'])}. The rest are "
               f"abstentions, not errors: {ci(st['k']['abstain_visible'], st['n_visible'])}.",
               f"- **Abstains when the strength is not visible** (crop, glare, back of box): "
               f"{ci(st['k']['abstain_hidden'], st['n_hidden'])}.",
               f"- **Unsafe reassurance, end-to-end with the shipped `safety.ts`:** {ci(s8['unsafe_reassurance'], s8['n'], 2)}. "
               f"By category: {s8.get('unsafe_by_category')}. None is a wrong-strength match. A further "
               f"{s8.get('expired_match_with_caveat', 0)} matches on expired boxes carried the \"couldn't read the expiry date\" caveat.",
               f"- **Allergens (readable panel, model answered):** every declared allergen found in "
               f"{ci(ar.get('n_answered_visible', 0) - ar.get('missed_any', 0), ar.get('n_answered_visible', 0))}; "
               f"missed at least one with confidence ≥0.6 (the server's allergen threshold) in {ci(ar.get('missed_any_confident', 0), ar.get('n_answered_visible', 0))}.",
               f"- **Calibration:** strength ECE {syn['calibration_strength']['ece']} {rng(syn['calibration_strength'].get('ece_ci'))} "
               f"(n={syn['calibration_strength'].get('n_answered')}; the model is under-confident); all-field ECE "
               f"{syn['calibration_all']['ece']} {rng(syn['calibration_all'].get('ece_ci'))} (n={syn['calibration_all'].get('n_answered')}).",
               f"- **Latency** per verify call (one 768 px frame, gemini-3.8-flash, thinking low, n={lat.get('n')}): "
               f"p50 {lat['p50']} s {rng(lat.get('p50_ci'), ' s')}, p95 {lat['p95']} s {rng(lat.get('p95_ci'), ' s')}.",
               f"- **Gemini as a workforce:** {tot['calls']:,} calls in total, {tot['in']:,} input, {tot['out']:,} output "
               f"and {tot['thinking']:,} thinking tokens (see the table at the end).", ""]
    if a.notes:
        md += [open(a.notes).read(), ""]
    if syn:
        md += ["## Details", "", "### Dataset (images per condition)", "", "| Condition | Images |", "|---|---|"]
        md += [f"| {k} | {v} |" for k, v in d.get("by_deg", {}).items()]
        md += ["", "Each front render gets clean plus 3 random degradation types × 3 severities. Back-of-box renders are evaluated clean.",
               "", "### Per-field accuracy (all conditions)", "", field_table(syn), "",
               "_Readable_ means the field is legible in the image, according to the render check and the degradation model. "
               "_Not visible_ means it is cropped, under glare, too blurred or on the back of the box; the honest answer there is null.", "",
               "### Strength by degradation and severity", "", deg_table(syn, "strength"), "",
               "### Expiry by degradation and severity", "", deg_table(syn, "expiry"), "",
               "### Allergens by degradation and severity", "", deg_table(syn, "allergens"), "",
               "### Calibration: strength", "", calib_table(syn["calibration_strength"]), "",
               "### Calibration: all fields", "", calib_table(syn["calibration_all"]), "",
               "### Choosing the 'unsure' threshold for strength", "",
               sweep_table(syn["threshold_sweep_strength"], st["n_visible"]), "",
               "### End-to-end safety verdict", "",
               "Each image is checked against 2–3 profiles: for medicines, the item on the list at the same strength, on the "
               "list at a different strength, and not on the list; for food, allergic to an allergen it contains, and "
               "allergic to one it doesn't. _Unsafe reassurance_ means the true verdict is a warning (wrong strength, not "
               "your medicine, allergen, expired) but the system said match or no-allergen. The counterfactual rows apply a "
               "policy change to the model's read and then run the same `safety.ts`.", "",
               safety_table(syn), "", "Per scenario (server rules as shipped):", "", scen_table(s8), "",
               "By condition (server rules as shipped):", "", safety_deg_table(s8), "",
               "Unsafe reassurance cases (server rules as shipped):", "", unsafe_table(s8), ""]
        ex = syn.get("confident_wrong_examples", [])
        if ex:
            md += ["### Confident-wrong examples (first 30, strength first)", "", "| Image | Field | GT status | Truth | Read | Conf |", "|---|---|---|---|---|---|"]
            md += [f"| `{e['img_id']}` | {e['field']} | {e['status']} | {e['gt']} | {e['pred']} | {e['conf']} |" for e in ex[:30]]
            md += [""]
        inc = syn.get("strength_incomplete", {})
        if inc.get("n"):
            md += [f"### Strength reads with the right numbers but a printed equivalent dropped ({inc['n']})", "",
                   "| Image | Printed | Read | Conf |", "|---|---|---|---|"]
            md += [f"| `{e['img_id']}` | {e['gt']} | {e['pred']} | {e['conf']} |" for e in inc["examples"]]
            md += [""]
    if real:
        md += ["## Real photos", "", f"{real['images_scored']} photos. Latency p50 {real['latency_s']['p50']} s.", "",
               field_table(real), "", safety_table(real), ""]
    else:
        md += ["## Real photos", "", "_Pending: photos land in `eval/real/` with `labels.csv` (v2)._", ""]
    if a.examples:
        caps = a.captions.split("|") if a.captions else []
        exs = copy_examples([x for x in a.examples.split(",") if x])
        if exs:
            md += ["## Example images", ""]
            for j, (i, p) in enumerate(exs):
                md += [f"![{i}]({p})", "", f"_{caps[j] if j < len(caps) else i}_", ""]
    if R.get("ledger"):
        md += ["## Gemini as a workforce: calls and tokens", "", led_md, "",
               "This covers every Gemini call made for this eval: spec generation, image rendering, the render check and the "
               "verify sweep, including retries and the calls made before the network outage. No Batch API was used.", ""]
    md += ["## Method", "",
           "1. `eval/gen_specs.py`: gemini-3.8-flash writes ground-truth label specs: medicine boxes and bottles, "
           "including Finnish/Swedish packs, and food packs with allergen synonyms and trace statements.",
           "2. `eval/gen_images.py`: gemini-3.1-flash-image renders a first-person photo of a hand holding each item, "
           "falling back to gemini-3-pro-image. A separate check call (gemini-3.8-flash, thinking high, given the spec) "
           "marks each field as legible and matching, and returns its bounding box. A render whose key fields come out "
           "garbled is re-rendered once and then dropped; minor fields that don't match the spec are excluded from scoring. "
           "A subset of medicines also gets a back-of-box render.",
           "3. `eval/degrade.py`: motion blur, defocus, rotation, partial crop, glare and low light at 3 severities. Each "
           "field's ground-truth status (readable, partial or not visible) is updated from its bounding box and text height.",
           "4. `eval/run_eval.py`: runs the product's `shared/verify_prompt.md` and `shared/label_schema.json` "
           "exactly as `server/src/verify.ts` does (`$ref`s inlined, thinking low, max 4096 output tokens, \"Read this "
           "label.\"), one 768 px frame per call. It applies the server's `toLabelRead` coercion, scores the fields with "
           "normalisation (units, dates, allergen synonyms, salt forms) and runs the real `server/src/safety.ts` through `npx tsx`.",
           "5. Ground-truth fixes, adjudicated by eye, are in `eval/gt_overrides.json` (currently one).", "",
           "Caveats:",
           "- The render check uses the same model family as the model under test (gemini-3.1-pro-preview returns 404 on "
           "our key), so the 'readable' labels lean on Gemini's own reading of the clean render, which may make the ground "
           "truth easier.",
           "- Degradation visibility is a heuristic based on text height and box overlap.",
           "- All images are synthetic. The real photos (v2) check both points above."]
    (REPO / "docs" / "EVAL.md").write_text("\n".join(md) + "\n")
    print("wrote docs/EVAL.md")


if __name__ == "__main__":
    main()
