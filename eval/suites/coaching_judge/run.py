from __future__ import annotations
import pathlib, sys

EVAL_DIR = pathlib.Path(__file__).resolve().parents[2]
sys.dont_write_bytecode = True
if str(EVAL_DIR) not in sys.path:
    sys.path.insert(0, str(EVAL_DIR))

from judge_coaching import main

if __name__ == "__main__":
    raise SystemExit(main())
