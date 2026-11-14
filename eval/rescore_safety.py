"""Re-score the end-to-end safety verdict on EXISTING predictions with the current server/src/safety.ts.
No model calls. Optionally compares record-by-record against a baseline safety.ts (e.g. the one v1 ran with).

  HOLDUP_DATA=... HOLDUP_OUT=<dir with preds_synthetic.jsonl> HOLDUP_TSX=.../tsx \
    python eval/rescore_safety.py [--baseline /path/to/old/server/src/safety.ts] [--out eval/results/v2_safety_rescore.json]

"Unsafe reassurance" = the true label warrants a warning but the app says match/info, excluding a match that
explicitly says "I couldn't read the expiry date" on an expired box (reported separately as disclosed).
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import subprocess
from pathlib import Path

import run_eval as R
from common import REPO, log, read_jsonl


def is_unsafe(x):
    return x["world"] == "warning" and x["pred"] in ("match", "info")


def is_caveated(x):
    return any("expiry not readable" in r for r in x["pred_reasons"]) and any(r.startswith("expired") for r in x["world_reasons"])


def silent(x):
    return is_unsafe(x) and not is_caveated(x)


def run_with(ts_path: Path, rows, preds):
    R.safety_ts_path = lambda: ts_path
    recs = R.run_safety(rows, preds)
    if not R.SAFETY_IMPL["impl"] or "safety.ts" not in R.SAFETY_IMPL["impl"]:
        raise SystemExit("safety.ts bridge unavailable (set HOLDUP_TSX); refusing to fall back to the python port")
    return recs


def food_reassure(recs):
    f = [x for x in recs if x["scenario"] == "allergic_to_absent" and x["world"] == "info"]
    return {"n_truly_safe": len(f), "said_none_of_your_allergens": sum(x["pred"] == "info" for x in f),
            "ci": R.wilson(sum(x["pred"] == "info" for x in f), len(f))}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--baseline", default=None, help="old safety.ts to compare against")
    ap.add_argument("--baseline-label", default="baseline safety.ts")
    ap.add_argument("--out", default=str(REPO / "eval" / "results" / "v2_safety_rescore.json"))
    a = ap.parse_args()
    rows = R.synthetic_rows()
    preds = {}
    for p in read_jsonl(R.preds_path("synthetic")):
        if p["img_id"] not in preds or not p.get("error"):
            preds[p["img_id"]] = p
    cur_ts = REPO / "server" / "src" / "safety.ts"
    cur = run_with(cur_ts, rows, preds)
    s = R.safety_summary(cur)
    sha = subprocess.run(["git", "-C", str(REPO), "log", "-1", "--format=%h", "--", "server/src/safety.ts"],
                         capture_output=True, text=True).stdout.strip()
    k, n = s["unsafe_reassurance"], s["n"]
    out = {
        "what": "v1 predictions (gemini-3.8-flash, prompt 814770315c42) re-scored with current safety.ts; no new model calls",
        "safety_ts_commit": sha, "images": len({x['img_id'] for x in cur}), "verdicts_n": n,
        "unsafe_reassurance_silent": {"k": k, "n": n, "rate_pct": R.pct(k, n), "wilson95_pct": R.wilson(k, n),
                                      "by_category": s["unsafe_by_category"]},
        "expired_match_with_expiry_caveat": {"k": s["expired_match_with_caveat"], "n": n,
                                             "wilson95_pct": R.wilson(s["expired_match_with_caveat"], n)},
        "verdict_correct_vs_world": {"k": s["correct_k"], "n": n, "wilson95_pct": s["correct_ci"]},
        "unsure": {"k": s["unsure_k"], "n": n, "wilson95_pct": s["unsure_ci"]},
        "false_match": s["false_match"],
        "by_scenario": s["by_scenario"],
        "food_reassurance_coverage": food_reassure(cur),
        "unsafe_examples": [x for x in cur if silent(x)],
    }
    if a.baseline:
        base = run_with(Path(a.baseline), rows, preds)
        bs = R.safety_summary(base)
        tr = collections.Counter()
        for x, y in zip(base, cur):
            assert (x["img_id"], x["scenario"]) == (y["img_id"], y["scenario"])
            if silent(x) and not silent(y):
                tr[f"fixed: {x['kind']} {x['scenario']} {x['pred']}->{y['pred']}"] += 1
            if silent(y) and not silent(x):
                tr[f"NEW: {y['kind']} {y['scenario']} {x['pred']}->{y['pred']}"] += 1
            if x["pred"] != y["pred"]:
                tr[f"verdict changed: {x['kind']} {x['scenario']} {x['pred']}->{y['pred']}"] += 1
        out["baseline"] = {"safety_ts": a.baseline_label, "unsafe_reassurance_silent": {
            "k": bs["unsafe_reassurance"], "n": bs["n"], "wilson95_pct": bs["unsafe_ci"], "by_category": bs["unsafe_by_category"]},
            "verdict_correct_k": bs["correct_k"], "unsure_k": bs["unsure_k"],
            "food_reassurance_coverage": food_reassure(base), "transitions": dict(tr.most_common())}
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps(out, indent=1, ensure_ascii=False))
    log(f"unsafe (silent) {k}/{n} {R.wilson(k, n)}%  -> {a.out}")


if __name__ == "__main__":
    main()
