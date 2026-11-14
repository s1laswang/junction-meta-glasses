"""'Why Gemini', measured: the product's verify prompt + schema on several models over a fixed
stratified subset of the synthetic set (clean + every degradation/severity + back of box).

  python eval/compare_models.py predict [--n 150] [--models gemini-3.8-flash,gemini-3.5-flash,gemma-4-31b-it]
  python eval/compare_models.py score          # -> eval/out/compare.json + docs/img/eval_model_compare.png

Gemma on the Gemini API has no system instruction / JSON schema mode, so for Gemma the prompt and the
schema go into the user turn and code fences are stripped from the reply. Same images, same scoring,
same server safety.ts.
"""
from __future__ import annotations

import argparse
import json
import random
import time
from collections import defaultdict

from common import DATA, OUT, REPO, append_jsonl, client, gen_cfg, ledger, log, parse_json, pmap, read_jsonl, with_retries
from run_eval import (USER_TEXT, agg, classify, load_prompt_schema, quantile, run_safety, safety_summary,
                      synthetic_rows, to_label_read)

DEFAULT_MODELS = "gemini-3.8-flash,gemini-3.5-flash,gemma-4-31b-it"


def subset(n: int) -> list[dict]:
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

    def go():
        t0 = time.time()
        r = None
        try:
            r = client().models.generate_content(model=model, contents=contents, config=cfg)
            dt = time.time() - t0
            if not r.text:
                raise RuntimeError("empty response")
            data = parse_json(r.text)
        except Exception:
            ledger("compare_models.verify", model, r, time.time() - t0, False, None if gemma else "low")
            raise
        ledger("compare_models.verify", model, r, dt, True, None if gemma else "low")
        return data, dt

    return with_retries(go, tries=4, label=f"cmp-{model}")


def path(model):
    return OUT / f"preds_compare_{model}.jsonl"


def cmd_predict(a):
    prompt, schema, src, h = load_prompt_schema()
    rows = subset(a.n)
    for model in a.models.split(","):
        done = {p["img_id"] for p in read_jsonl(path(model)) if not p.get("error") and p.get("prompt_hash") == h}
        todo = [r for r in rows if r["img_id"] not in done]
        log(f"{model}: {len(todo)} to do ({len(done)} cached), prompt {src} {h}")

        def run(r, model=model):
            try:
                pred, dt = call(model, (DATA / r["file"]).read_bytes(), prompt, schema)
                out = {"img_id": r["img_id"], "pred": pred, "latency_s": round(dt, 3), "prompt_hash": h, "model": model}
            except Exception as e:  # noqa: BLE001
                out = {"img_id": r["img_id"], "error": str(e)[:300], "prompt_hash": h, "model": model}
            append_jsonl(path(model), out)
            return out

        res = pmap(run, todo, workers=a.workers, desc=model)
        log(f"{model}: errors {sum(1 for x in res if x.get('error'))}")


def cmd_score(a):
    prompt, schema, src, h = load_prompt_schema()
    rows = subset(a.n)
    ids = {r["img_id"] for r in rows}
    out = {"n_images": len(rows), "prompt_hash": h, "models": {}}
    for model in a.models.split(","):
        preds = {p["img_id"]: p for p in read_jsonl(path(model)) if p.get("prompt_hash") == h and p["img_id"] in ids
                 and not p.get("error")}
        errs = len(ids) - len(preds)
        st, allf, lat = [], [], []
        for r in rows:
            p = preds.get(r["img_id"])
            if not p:
                continue
            lat.append(p["latency_s"])
            pr = to_label_read(p["pred"])
            for f in ("product", "ingredient", "strength", "expiry", "allergens"):
                c = classify(r, pr, f)
                if c:
                    allf.append(c)
                    if f == "strength":
                        st.append(c)
        recs = run_safety(rows, preds, None)
        s = safety_summary(recs)
        sa, aa = agg(st), agg(allf)
        out["models"][model] = {
            "answered_images": len(preds), "errors_or_unparseable": errs,
            "strength_acc_readable": sa["acc_visible"], "strength_confident_wrong": sa["confident_wrong"],
            "strength_confident_wrong_rate": sa["confident_wrong_rate"], "strength_n": sa["n"],
            "strength_abstain_hidden": sa["abstain_hidden"],
            "fields_acc_readable": aa["acc_visible"], "fields_confident_wrong_rate": aa["confident_wrong_rate"],
            "unsafe_reassurance": s["unsafe_reassurance"], "unsafe_reassurance_rate": s["unsafe_reassurance_rate"],
            "verdicts": s["n"], "verdict_correct": s["verdict_correct_vs_world"],
            "latency_p50": quantile(lat, .5), "latency_p95": quantile(lat, .95),
        }
    (OUT / "compare.json").write_text(json.dumps(out, indent=1))
    log(json.dumps(out["models"], indent=1))
    chart(out)


def chart(out):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    models = list(out["models"])
    m = out["models"]
    panels = [("Strength accuracy (readable)", "strength_acc_readable", "%", True),
              ("Strength confident-wrong", "strength_confident_wrong_rate", "%", False),
              ("Unsafe reassurance (safety.ts)", "unsafe_reassurance_rate", "%", False),
              ("Latency p50", "latency_p50", "s", False)]
    fig, axes = plt.subplots(1, 4, figsize=(13, 3.4))
    colors = ["#2a6fdb", "#7aa6ef", "#c7c7c7"]
    for ax, (title, key, unit, hi) in zip(axes, panels):
        vals = [m[x][key] or 0 for x in models]
        bars = ax.bar(range(len(models)), vals, color=colors[: len(models)])
        ax.set_title(title + ("  (higher is better)" if hi else "  (lower is better)"), fontsize=9)
        ax.set_xticks(range(len(models)))
        ax.set_xticklabels([x.replace("gemini-", "").replace("-it", "") for x in models], fontsize=8)
        for b, v in zip(bars, vals):
            ax.text(b.get_x() + b.get_width() / 2, b.get_height(), f"{v:g}{unit}", ha="center", va="bottom", fontsize=8)
        ax.spines[["top", "right"]].set_visible(False)
        ax.set_yticks([])
    fig.suptitle(f"Same verify prompt + schema, {out['n_images']} synthetic label photos (clean + degraded)", fontsize=10)
    fig.tight_layout()
    (REPO / "docs" / "img").mkdir(parents=True, exist_ok=True)
    fig.savefig(REPO / "docs" / "img" / "eval_model_compare.png", dpi=130)
    log("wrote docs/img/eval_model_compare.png")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["predict", "score"])
    ap.add_argument("--n", type=int, default=150)
    ap.add_argument("--models", default=DEFAULT_MODELS)
    ap.add_argument("--workers", type=int, default=8)
    a = ap.parse_args()
    {"predict": cmd_predict, "score": cmd_score}[a.cmd](a)


if __name__ == "__main__":
    main()
