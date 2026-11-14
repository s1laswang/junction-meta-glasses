#!/usr/bin/env bash
# Full eval run on the laptop at lowest priority (approved by Silas while freighter is unreachable).
# All stages niced to 19; at most 12 concurrent Gemini calls. Raw data stays in gitignored
# eval/synthetic/ and eval/out/.
#   HOLDUP_ENV_FILE=/path/to/.env PY=/path/to/venv/bin/python bash eval/run_local.sh [from_stage]
# Stages: specs images degrade predict score
set -euo pipefail
cd "$(dirname "$0")/.."
PY=${PY:-python3}
export HOLDUP_DATA=${HOLDUP_DATA:-$(pwd)/eval/synthetic}
export HOLDUP_OUT=${HOLDUP_OUT:-$(pwd)/eval/out}
mkdir -p "$HOLDUP_DATA" "$HOLDUP_OUT"
N="nice -n 19"
FROM=${1:-specs}
stages=(specs images degrade predict score)
run=0
for s in "${stages[@]}"; do
  [ "$s" = "$FROM" ] && run=1
  [ $run = 1 ] || continue
  echo "=== $s $(date +%H:%M:%S)"
  case $s in
    specs)   $N "$PY" eval/gen_specs.py --meds "${MEDS:-150}" --foods "${FOODS:-50}" --batch 8 --workers 8 ;;
    images)  $N "$PY" eval/gen_images.py --workers 12 --back "${BACK:-40}" ;;
    degrade) $N "$PY" eval/degrade.py --types "${TYPES:-3}" --workers 2 ;;
    predict) $N "$PY" eval/run_eval.py predict --set synthetic --workers 12
             $N "$PY" eval/run_eval.py predict --set real --workers 6 ;;
    score)   $N "$PY" eval/run_eval.py score ;;
  esac
done
echo "=== done $(date +%H:%M:%S)"
