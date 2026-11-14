#!/usr/bin/env bash
# HoldUp eval on a laptop (no Slurm). Same steps and scripts as eval/pipeline.sh, minus sbatch.
# Needs GEMINI_API_KEY in .env or the environment (specs, images and predict call Gemini).
# Usage: bash eval/local.sh setup|rules|specs|images|degrade|predict [synthetic|real]|score|all
#   QUICK=1 bash eval/local.sh all   -> small run (24 meds, 8 foods, 1 degradation type) for a first number
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
[ -f .env ] && set -a && . ./.env && set +a
DATA_ROOT=${DATA_ROOT:-$ROOT/eval/data}
export HOLDUP_DATA=${HOLDUP_DATA:-$DATA_ROOT/synthetic}
export HOLDUP_OUT=${HOLDUP_OUT:-$ROOT/eval/out}
mkdir -p "$HOLDUP_DATA" "$HOLDUP_OUT"
VENV=${VENV:-$DATA_ROOT/venv}
PY="$VENV/bin/python"
if [ -n "${QUICK:-}" ]; then MEDS=${MEDS:-24}; FOODS=${FOODS:-8}; TYPES=${TYPES:-1}; BACK=${BACK:-8}; fi
step() {
  case "$1" in
    setup) python3 -m venv "$VENV" && "$VENV/bin/pip" install -q --upgrade pip && "$VENV/bin/pip" install -q google-genai pillow numpy && "$PY" -c "import google.genai, PIL, numpy; print('venv ok')" ;;
    rules) (cd server && npx --yes tsx scripts/eval-rules.ts --json "$HOLDUP_OUT/rules.json") ;;
    specs) "$PY" eval/gen_specs.py --meds "${MEDS:-105}" --foods "${FOODS:-55}" --batch 8 --workers "${WORKERS:-8}" ;;
    images) "$PY" eval/gen_images.py --workers "${WORKERS:-8}" --back "${BACK:-40}" ;;
    degrade) "$PY" eval/degrade.py --types "${TYPES:-3}" --workers "${WORKERS:-8}" ;;
    predict) "$PY" eval/run_eval.py predict --set "${2:-synthetic}" --workers "${WORKERS:-8}" ${LIMIT:+--limit $LIMIT} ;;
    score) "$PY" eval/run_eval.py score && "$PY" eval/make_report.py --version "${VERSION:-v1}" --examples "${EXAMPLES:-}" ${NOTES:+--notes $NOTES} ;;
    all) step rules; step setup; step specs; step images; step degrade; step predict synthetic; step score ;;
    *) sed -n '2,6p' "$0"; exit 1 ;;
  esac
}
step "$@"
