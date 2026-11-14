#!/usr/bin/env bash
# HoldUp eval pipeline on FR8 freighter.
#
# Compute nodes have NO internet, so:
#   - Gemini calls (specs, renders, verify sweep) run on the LOGIN node as one niced,
#     concurrency-capped (<=16/model) I/O-bound process.
#   - CPU work (PIL degradations, scoring) runs in Slurm jobs with --time set.
#
# Usage (on freighter, from ~/junction-meta-glasses):
#   bash eval/pipeline.sh setup          # venv with google-genai + pillow + numpy
#   bash eval/pipeline.sh specs          # login node, ~15 calls
#   bash eval/pipeline.sh images         # login node, ~2 calls per render
#   bash eval/pipeline.sh degrade        # sbatch (CPU)
#   bash eval/pipeline.sh predict [synthetic|real]   # login node
#   bash eval/pipeline.sh score          # sbatch (CPU) -> eval/out/results.json + docs/EVAL.md
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
DATA_ROOT=/data/silas/junction-meta-glasses
if ! mkdir -p "$DATA_ROOT" 2>/dev/null || [ ! -w "$DATA_ROOT" ]; then DATA_ROOT=$HOME/data/junction-meta-glasses; mkdir -p "$DATA_ROOT"; fi
export HOLDUP_DATA=${HOLDUP_DATA:-$DATA_ROOT/synthetic}
export HOLDUP_OUT=${HOLDUP_OUT:-$ROOT/eval/out}
mkdir -p "$HOLDUP_DATA" "$HOLDUP_OUT" "$DATA_ROOT/logs"
VENV=${VENV:-$DATA_ROOT/venv}
PY="$VENV/bin/python"
NICE="nice -n 15"

case "${1:-}" in
  setup)
    python3 -m venv "$VENV"
    "$VENV/bin/pip" install -q --upgrade pip
    "$VENV/bin/pip" install -q google-genai pillow numpy
    "$PY" -c "import google.genai, PIL, numpy; print('venv ok', google.genai.__version__)"
    ;;
  specs)  $NICE "$PY" eval/gen_specs.py --meds "${MEDS:-105}" --foods "${FOODS:-55}" --batch 8 --workers 8 ;;
  images) $NICE "$PY" eval/gen_images.py --workers "${WORKERS:-12}" --back "${BACK:-40}" ;;
  degrade)
    sbatch --wait -p normal --time=00:30:00 --cpus-per-task=8 --mem=16G -J holdup-degrade \
      -o "$DATA_ROOT/logs/%x-%j.out" --export=ALL --wrap "$PY eval/degrade.py --types ${TYPES:-3} --workers 8"
    tail -3 "$(ls -t "$DATA_ROOT"/logs/holdup-degrade-*.out | head -1)"
    ;;
  predict) $NICE "$PY" eval/run_eval.py predict --set "${2:-synthetic}" --workers "${WORKERS:-12}" ;;
  score)
    sbatch --wait -p normal --time=00:20:00 --cpus-per-task=2 --mem=4G -J holdup-score \
      -o "$DATA_ROOT/logs/%x-%j.out" --export=ALL \
      --wrap "$PY eval/run_eval.py score && $PY eval/make_report.py --version ${VERSION:-v1} --examples '${EXAMPLES:-}' ${NOTES:+--notes $NOTES}"
    tail -5 "$(ls -t "$DATA_ROOT"/logs/holdup-score-*.out | head -1)"
    ;;
  *) sed -n '2,20p' "$0"; exit 1 ;;
esac
