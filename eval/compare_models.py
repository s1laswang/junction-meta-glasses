"""'Why Gemini', measured: the product's verify prompt + schema on several models over a fixed
stratified subset of the v1 synthetic set (clean + every degradation/severity + back of box).

  python eval/compare_models.py predict [--n 150] [--models ...] [--workers 12]
  python eval/compare_models.py score [--v1-preds path]   # -> eval/results/v2_model_compare.json + docs/img/eval_model_compare.png

All models run in ONE interleaved pool (<= --workers concurrent calls, shuffled order), so latency is
measured under the same network conditions. Interactive calls only (no Batch API).

Gemma on the Gemini API: no thinking config; the prompt and the schema go into the user turn and any
markdown code fence / surrounding prose is stripped from the reply. Same images, same scoring, same
server safety.ts. A call that fails or returns unparseable JSON is scored the way the product would
handle it: an unreadable read (-> "not sure"), and counted in errors.

Paired statistics (every model sees the same images): differences vs the reference model with 95%
CIs from a paired bootstrap over images (2,000 resamples; verdicts are clustered by image), and an
exact two-sided McNemar test on the discordant pairs for binary per-item outcomes.
"""
from __future__ import annotations

import argparse
import json
import math
import random
import re
import time
from collections import defaultdict
from pathlib import Path

from common import DATA, OUT, REPO, append_jsonl, client, gen_cfg, ledger, log, pmap, read_jsonl, with_retries
from run_eval import (CONF_T, USER_TEXT, classify, load_prompt_schema, quantile, run_safety, synthetic_rows,
                      to_label_read, wilson)

DEFAULT_MODELS = "gemini-3.8-flash,gemini-3.5-flash,gemma-4-31b-it"
REF = "gemini-3.8-flash"


def subset(n: int) -> list[dict]:
    """Fixed (seed 42) stratified sample: an equal share per (kind, degradation, severity) cell, then fill."""
    rows = synthetic_rows()
    rng = random.Random(42)
    strata = defaultdict(list)
    for r in rows:
        strata[(r["kind"], r["deg"], r["sev"])].append(r)
    keys = sorted(strata)
    per = max(1, n // len(keys))
    out = []
    for k in keys:
        rng.shuffle(strata[k])
        out += strata[k][:per]
    rest = [r for k in keys for r in strata[k][per:]]
    rng.shuffle(rest)
    out += rest[: max(0, n - len(out))]
    return out[:n]


def parse_reply(text: str):
    """JSON object from a model reply: strips ```json fences and any prose around the object."""
    t = (text or "").strip()
    m = re.search(r"```(?:json|JSON)?\s*\n?(.*?)```", t, re.S)
    if m:
        t = m.group(1).strip()
    try:
        return json.loads(t)
    except json.JSONDecodeError:
        i, j = t.find("{"), t.rfind("}")
        if i >= 0 and j > i:
            return json.loads(t[i: j + 1])
        raise


def call(model: str, img: bytes, prompt: str, schema: dict):
    from google.genai import types

    gemma = model.startswith("gemma")
    if gemma:
        contents = [types.Part.from_bytes(data=img, mime_type="image/jpeg"),
                    f"{prompt}\n\nReturn ONLY a JSON object matching this JSON schema:\n{json.dumps(schema)}\n\n{USER_TEXT}"]
        cfg = gen_cfg(None, None, thinking=None, max_tokens=4096, json_out=False)
    else:
        contents = [types.Part.from_bytes(data=img, mime_type="image/jpeg"), USER_TEXT]
        cfg = gen_cfg(schema, prompt, thinking="low", max_tokens=4096)
    raw = {"text": None}

    def go():
        t0 = time.time()
        r = None
        try:
            r = client().models.generate_content(model=model, contents=contents, config=cfg)
            dt = time.time() - t0
            raw["text"] = r.text
            if not r.text:
                raise RuntimeError("empty response")
            data = parse_reply(r.text)
        except Exception:
            ledger("compare_models.verify", model, r, time.time() - t0, False, None if gemma else "low")
            raise
        ledger("compare_models.verify", model, r, dt, True, None if gemma else "low")
        return data, dt

    try:
        return with_retries(go, tries=4, label=f"cmp-{model}")
    except Exception as e:  # keep a snippet of the unparseable reply for the error log
        raise RuntimeError(f"{e} | reply: {(raw['text'] or '')[:200]!r}") from None


def path(model):
    return OUT / f"preds_compare_{model}.jsonl"


def cmd_predict(a):
    prompt, schema, src, h = load_prompt_schema()
    rows = subset(a.n)
    tasks = []
    for model in a.models.split(","):
        done = {p["img_id"] for p in read_jsonl(path(model)) if not p.get("error") and p.get("prompt_hash") == h}
        todo = [r for r in rows if r["img_id"] not in done]
        log(f"{model}: {len(todo)} to do ({len(done)} cached), prompt {src} {h}")
        tasks += [(model, r) for r in todo]
    random.Random(7).shuffle(tasks)

    def run(t):
        model, r = t
        try:
            pred, dt = call(model, (DATA / r["file"]).read_bytes(), prompt, schema)
            out = {"img_id": r["img_id"], "pred": pred, "latency_s": round(dt, 3), "prompt_hash": h, "model": model,
                   "ts": round(time.time(), 1)}
        except Exception as e:  # noqa: BLE001
            out = {"img_id": r["img_id"], "error": str(e)[:500], "prompt_hash": h, "model": model}
        append_jsonl(path(model), out)
        return out

    res = pmap(run, tasks, workers=min(a.workers, 12), desc="compare")
    errs = defaultdict(int)
    for x in res:
        if x and x.get("error"):
            errs[x.get("model")] += 1
    log(f"errors by model: {dict(errs)}")


# ---------------------------------------------------------------- scoring
def is_unsafe(x):
    """Silent unsafe reassurance: true label warrants a warning, app says match/info (a match that says
    'I couldn't read the expiry date' on an expired box is disclosed, not silent; same rule as run_eval)."""
    cav = any("expiry not readable" in r for r in x["pred_reasons"]) and any(r.startswith("expired") for r in x["world_reasons"])
    return x["world"] == "warning" and x["pred"] in ("match", "info") and not cav


def item_outcomes(rows, preds):
    """Per-image outcome dicts for one model. preds: img_id -> pred record (missing/error -> unreadable)."""
    per = {}
    for r in rows:
        p = preds.get(r["img_id"])
        ok = bool(p) and not p.get("error")
        pr = to_label_read(p["pred"] if ok else {})
        o = {"lat": p.get("latency_s") if ok else None, "err": not ok}
        c = classify(r, pr, "strength")
        if c:
            o["st_vis"] = c["status"] == "visible"
            o["st_correct"] = c["outcome"] == "correct"
            o["st_cw"] = c["outcome"] == "wrong" and c["conf"] >= CONF_T
        fs = [classify(r, pr, f) for f in ("product", "ingredient", "strength", "expiry", "allergens")]
        fs = [c for c in fs if c]
        o["f_n"] = len(fs)
        o["f_cw"] = sum(c["outcome"] == "wrong" and c["conf"] >= CONF_T for c in fs)
        per[r["img_id"]] = o
    fake = {r["img_id"]: (preds[r["img_id"]] if r["img_id"] in preds and not preds[r["img_id"]].get("error")
                          else {"img_id": r["img_id"], "pred": {}, "latency_s": None}) for r in rows}
    for x in run_safety(rows, fake):
        o = per[x["img_id"]]
        o.setdefault("verdicts", []).append({"unsafe": is_unsafe(x), "correct": x["pred"] == x["world"],
                                             "unsure": x["pred"] == "unsure", "scenario": x["scenario"]})
    return per


METRICS = {
    # name: (per-image numerator fn, per-image denominator fn)
    "strength_acc_readable": (lambda o: int(o.get("st_vis", False) and o["st_correct"]), lambda o: int(o.get("st_vis", False))),
    "strength_confident_wrong": (lambda o: int(o.get("st_cw", False)), lambda o: int("st_cw" in o)),
    "fields_confident_wrong": (lambda o: o["f_cw"], lambda o: o["f_n"]),
    "unsafe_reassurance": (lambda o: sum(v["unsafe"] for v in o.get("verdicts", [])), lambda o: len(o.get("verdicts", []))),
    "verdict_correct": (lambda o: sum(v["correct"] for v in o.get("verdicts", [])), lambda o: len(o.get("verdicts", []))),
    "unsure": (lambda o: sum(v["unsure"] for v in o.get("verdicts", [])), lambda o: len(o.get("verdicts", []))),
}


def rate_ci(k, n):
    """Wilson 95% (percent); for zero events also the rule-of-three upper bound."""
    d = {"k": k, "n": n, "pct": round(100 * k / n, 2) if n else None, "wilson95_pct": wilson(k, n)}
    if n and k == 0:
        d["rule_of_three_upper_pct"] = round(300 / n, 2)
    return d


def mcnemar_exact(b, c):
    """Two-sided exact binomial test on discordant pairs b, c."""
    n = b + c
    if n == 0:
        return 1.0
    k = min(b, c)
    p = sum(math.comb(n, i) for i in range(0, k + 1)) / 2 ** n
    return round(min(1.0, 2 * p), 4)


def binary_units(per, metric):
    """Per-unit 0/1 outcomes keyed so models can be paired (image-level for strength, verdict-level for safety)."""
    out = {}
    for img, o in per.items():
        if metric == "strength_acc_readable" and o.get("st_vis"):
            out[img] = int(o["st_correct"])
        elif metric == "strength_confident_wrong" and "st_cw" in o:
            out[img] = int(o["st_cw"])
        elif metric in ("unsafe_reassurance", "verdict_correct", "unsure"):
            key = {"unsafe_reassurance": "unsafe", "verdict_correct": "correct", "unsure": "unsure"}[metric]
            for v in o.get("verdicts", []):
                out[(img, v["scenario"])] = int(v[key])
    return out


def paired(per_a, per_b, imgs, metric, B=2000, seed=1):
    num, den = METRICS[metric]

    def diff(sample):
        na = sum(num(per_a[i]) for i in sample); da = sum(den(per_a[i]) for i in sample)
        nb = sum(num(per_b[i]) for i in sample); db = sum(den(per_b[i]) for i in sample)
        return (100 * nb / db if db else 0) - (100 * na / da if da else 0)
    rng = random.Random(seed)
    boots = sorted(diff([rng.choice(imgs) for _ in imgs]) for _ in range(B))
    d = {"diff_pp": round(diff(imgs), 2), "ci95_pp": [round(boots[int(0.025 * B)], 2), round(boots[int(0.975 * B) - 1], 2)]}
    ua, ub = binary_units(per_a, metric), binary_units(per_b, metric)
    if ua:
        keys = set(ua) & set(ub)
        b = sum(1 for k in keys if ua[k] == 1 and ub[k] == 0)
        c = sum(1 for k in keys if ua[k] == 0 and ub[k] == 1)
        d.update({"discordant_ref_only": b, "discordant_model_only": c, "mcnemar_exact_p": mcnemar_exact(b, c)})
    return d


def latency(per, imgs, B=2000, seed=2):
    lat = [per[i]["lat"] for i in imgs if per[i]["lat"] is not None]
    rng = random.Random(seed)
    bs = sorted(quantile([rng.choice(lat) for _ in lat], .5) for _ in range(B)) if lat else []
    return {"n": len(lat), "p50_s": quantile(lat, .5), "p95_s": quantile(lat, .95),
            "p50_ci95_s": [bs[int(.025 * B)], bs[int(.975 * B) - 1]] if bs else None}


def paired_latency(per_a, per_b, imgs, B=2000, seed=3):
    both = [i for i in imgs if per_a[i]["lat"] is not None and per_b[i]["lat"] is not None]
    d = [per_b[i]["lat"] - per_a[i]["lat"] for i in both]
    rng = random.Random(seed)
    bs = sorted(quantile([rng.choice(d) for _ in d], .5) for _ in range(B)) if d else []
    return {"n_pairs": len(both), "median_diff_s": quantile(d, .5),
            "ci95_s": [bs[int(.025 * B)], bs[int(.975 * B) - 1]] if bs else None,
            "model_slower_on": sum(x > 0 for x in d)}


def summarize(per, imgs):
    s = {}
    for m, (num, den) in METRICS.items():
        s[m] = rate_ci(sum(num(per[i]) for i in imgs), sum(den(per[i]) for i in imgs))
    s["latency"] = latency(per, imgs)
    s["errors_or_unparseable"] = sum(per[i]["err"] for i in imgs)
    return s


def load_preds(p: Path, h: str, ids: set) -> dict:
    preds = {}
    for x in read_jsonl(p):
        if x.get("prompt_hash", h) == h and x["img_id"] in ids and (x["img_id"] not in preds or not x.get("error")):
            preds[x["img_id"]] = x
    return preds


def cmd_score(a):
    prompt, schema, src, h = load_prompt_schema()
    rows = subset(a.n)
    ids = [r["img_id"] for r in rows]
    models = a.models.split(",")
    pers = {m: item_outcomes(rows, load_preds(path(m), h, set(ids))) for m in models}
    out = {"what": "paired comparison, same prompt/schema/safety.ts, fixed stratified subset of the v1 synthetic set",
           "prompt_hash": h, "prompt_src": src, "n_images": len(rows), "subset_seed": 42,
           "subset_by_kind": {k: sum(r["kind"] == k for r in rows) for k in sorted({r["kind"] for r in rows})},
           "subset_by_deg": {d: sum(r["deg"] == d for r in rows) for d in sorted({r["deg"] for r in rows})},
           "reference": REF, "models": {}, "paired_vs_reference": {}}
    for m in models:
        out["models"][m] = summarize(pers[m], ids)
        allrec = [x for x in read_jsonl(path(m)) if x["img_id"] in set(ids) and x.get("prompt_hash", h) == h]
        ok_ids = {x["img_id"] for x in allrec if not x.get("error")}
        out["models"][m]["calls_retried_after_error"] = sum(1 for x in allrec if x.get("error") and x["img_id"] in ok_ids)
        out["models"][m]["errors_examples"] = [x["error"][:240] for x in allrec if x.get("error") and x["img_id"] not in ok_ids][:5]
    for m in models:
        if m == REF:
            continue
        out["paired_vs_reference"][m] = {met: paired(pers[REF], pers[m], ids, met) for met in METRICS}
        out["paired_vs_reference"][m]["latency"] = paired_latency(pers[REF], pers[m], ids)
    if a.v1_preds and Path(a.v1_preds).exists():  # test-retest: v1's reference-model reads of the same images
        v1 = item_outcomes(rows, load_preds(Path(a.v1_preds), h, set(ids)))
        out["test_retest_" + REF] = {"v1_run": summarize(v1, ids),
                                     "v2_minus_v1": {met: paired(v1, pers[REF], ids, met) for met in METRICS}}
        out["test_retest_" + REF]["v1_run"].pop("latency")
    dest = Path(a.out)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(out, indent=1))
    log(f"wrote {dest}")
    chart(out)


def chart(out):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import matplotlib.ticker  # noqa: F401

    ink, ink2, grid, surface = "#0b0b0b", "#52514e", "#e4e3df", "#fcfcfb"
    colors = ["#2a78d6", "#eb6834", "#1baf7a"]  # reference categorical slots 1-3, validated
    models = list(out["models"])
    M = out["models"]
    panels = [("Strength read correctly\n(readable strength, higher is better)", "strength_acc_readable"),
              ("Confident-wrong strength\n(conf ≥ 0.8, lower is better)", "strength_confident_wrong"),
              ("Silent unsafe reassurance\n(image × profile, lower is better)", "unsafe_reassurance"),
              ("Verify latency p50\n(seconds, lower is better)", "latency")]
    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 9})
    fig, axes = plt.subplots(1, 4, figsize=(13, 3.3), facecolor=surface)
    ys = list(range(len(models)))[::-1]
    for pi, (ax, (title, key)) in enumerate(zip(axes, panels)):
        ax.set_facecolor(surface)
        for y, m, col in zip(ys, models, colors):
            d = M[m][key]
            if key == "latency":
                v, (lo, hi), lab = d["p50_s"], d["p50_ci95_s"], f"{d['p50_s']:.1f} s"
            else:
                v, (lo, hi) = d["pct"], d["wilson95_pct"]
                lab = f"{d['k']}/{d['n']}  {v:.1f}%"
            ax.plot([lo, hi], [y, y], color=col, lw=2, solid_capstyle="round", zorder=2)
            ax.scatter([v], [y], s=64, color=col, edgecolor=surface, linewidth=2, zorder=3)
            ax.annotate(lab, (hi, y), xytext=(6, 0), textcoords="offset points", va="center", fontsize=8, color=ink)
        ax.set_title(title, fontsize=9, color=ink, loc="left")
        ax.set_yticks(ys)
        ax.set_yticklabels([m.replace("-it", "") for m in models] if pi == 0 else [], color=ink2)
        ax.tick_params(axis="y", length=0)
        ax.tick_params(axis="x", colors=ink2, labelsize=8)
        ax.grid(axis="x", color=grid, lw=0.8)
        ax.set_axisbelow(True)
        for s in ("top", "right", "left"):
            ax.spines[s].set_visible(False)
        ax.spines["bottom"].set_color(grid)
        lo, hi = ax.get_xlim()
        ax.set_xlim(lo if key == "strength_acc_readable" else 0, hi + (hi - lo) * 0.55)
        ax.set_ylim(-0.6, len(models) - 0.4)
        ax.xaxis.set_major_formatter(matplotlib.ticker.FuncFormatter(
            (lambda x, _: f"{x:g} s") if key == "latency" else (lambda x, _: f"{x:g}%")))
    fig.suptitle(f"Same verify prompt, schema and safety.ts on {out['n_images']} synthetic label photos "
                 f"(paired; dot = estimate, line = 95% CI)", fontsize=10, color=ink, x=0.01, y=0.98, ha="left")
    fig.tight_layout(rect=(0, 0, 1, 0.95))
    (REPO / "docs" / "img").mkdir(parents=True, exist_ok=True)
    fig.savefig(REPO / "docs" / "img" / "eval_model_compare.png", dpi=150, facecolor=surface)
    log("wrote docs/img/eval_model_compare.png")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["predict", "score"])
    ap.add_argument("--n", type=int, default=150)
    ap.add_argument("--models", default=DEFAULT_MODELS)
    ap.add_argument("--workers", type=int, default=12)
    ap.add_argument("--v1-preds", default=None, help="v1 preds_synthetic.jsonl for a test-retest check of the reference model")
    ap.add_argument("--out", default=str(REPO / "eval" / "results" / "v2_model_compare.json"))
    a = ap.parse_args()
    {"predict": cmd_predict, "score": cmd_score}[a.cmd](a)


if __name__ == "__main__":
    main()
