#!/usr/bin/env bash
# Score the real photos in eval/real/ with the shipped reader and rules, and print a short summary.
#
#   1. Put the photos in eval/real/ (no faces, no patient names).
#   2. Add one row per photo to eval/real/labels.csv:
#        file,kind,product,ingredient,strength,expiry,allergens,notes
#      kind = medication | food. Leave a cell empty if that field is not printed on the visible side.
#      The template row "example.jpg" is skipped; name your files anything else.
#      allergens: comma-separated in quotes ("milk, hazelnut"), or "none" if the panel shows none.
#   3. bash eval/score_real.sh
#
# Needs GEMINI_API_KEY in .env. Makes one Gemini call per photo (at most 12 at a time). Results:
# eval/results/real_results.json and a table printed here. Nothing is added to docs or the deck automatically.
set -euo pipefail
cd "$(dirname "$0")/.."
PY="${PY:-/tmp/holdup-eval-venv/bin/python}"
if [ ! -x "$PY" ]; then
  echo "Creating a Python environment in /tmp/holdup-eval-venv ..."
  python3 -m venv /tmp/holdup-eval-venv && /tmp/holdup-eval-venv/bin/pip -q install google-genai pillow
  PY=/tmp/holdup-eval-venv/bin/python
fi
N=$(( $(grep -c . eval/real/labels.csv) - 1 ))
PHOTOS=$(find eval/real -maxdepth 1 -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' \) | wc -l | tr -d ' ')
echo "labels.csv rows: $N, photos found: $PHOTOS"
[ "$PHOTOS" -gt 0 ] || { echo "No photos in eval/real/ yet."; exit 1; }
WORK="${HOLDUP_REAL_OUT:-/tmp/holdup-real-out}"; mkdir -p "$WORK"
# score real photos only: an empty synthetic set keeps the run to the real rows
EMPTY="$WORK/empty-synthetic"; mkdir -p "$EMPTY"; : > "$EMPTY/dataset.jsonl"
export HOLDUP_OUT="$WORK" HOLDUP_DATA="$EMPTY" HOLDUP_TSX="$PWD/node_modules/.bin/tsx" HOLDUP_ENV_FILE="$PWD/.env"
rm -f "$WORK/preds_real.jsonl"
nice -n 10 "$PY" eval/run_eval.py predict --set real --workers 12
nice -n 10 "$PY" eval/run_eval.py score
mkdir -p eval/results
"$PY" - "$WORK/results.json" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
real = r.get("real")
if not real:
    print("No real results in", sys.argv[1]); sys.exit(1)
json.dump({"model": r.get("model"), "prompt_hash": r.get("prompt_hash"), "real": real}, open("eval/results/real_results.json", "w"), indent=1)
print(f"\nReal photos scored: {real.get('images_scored')}")
pf = real.get("per_field", {})
print(f"{'field':<11}{'n visible':>10}{'correct %':>11}{'abstain %':>11}{'wrong %':>9}{'confident-wrong':>17}")
for k in ("product", "ingredient", "strength", "expiry", "allergens"):
    f = pf.get(k)
    if f: print(f"{k:<11}{f.get('n_visible', 0):>10}{str(f.get('acc_visible')):>11}{str(f.get('abstain_visible')):>11}{str(f.get('wrong_visible')):>9}{f.get('confident_wrong', 0):>17}")
s = (real.get("safety") or {}).get("server") or {}
if s: print(f"\nEnd-to-end verdicts: {s.get('n')}  silent unsafe reassurances: {s.get('unsafe_reassurance')}  not sure: {s.get('unsure_k')}")
print("\nSaved eval/results/real_results.json. Small n: report counts, not percentages.")
PY
