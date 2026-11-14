# FieldSpotter: our own label-field detector, trained on Verda (evidence)

**What it is:** a YOLOv8n detector that finds where the **product name, strength (dose), expiry date and allergen panel** are on a label. It's trained on HoldUp's own eval set: 1,740 Gemini-generated, ground-truthed first-person label photos (`docs/EVAL.md`) with per-field boxes on clean and degraded images. In other words, Gemini-made data is distilled into a small model that runs on a phone CPU in real time. Gemini stays the reader of record; FieldSpotter is for fast spatial coaching (where the dose is, whether it's covered or off-frame).

## Where it ran (honest labelling)
- **Training ran on Verda:** a shared H100 80GB instance (86.38.238.205) provided by the FR8 queue (`fr8/verda/README.md`, branch `justSilas-fr8`). We shared it with the team's tiebreaker run and used about 5.6 GB of GPU memory and ≤ 8 data workers.
- **Training window:** 2026-11-14 22:16:13Z → about 22:25Z (80 epochs, 513 s of training) ≈ **0.15 GPU-hours**.
- Our run slowed the co-tenant job by about 12% (FR8's measurement), so no further training was done on that box.
- Eval and ONNX export also ran on that instance. **Only the training, eval and export ran on Verda.**
- The data prep (`eval/make_yolo.py`) ran on the laptop. The dataset itself was generated earlier with Gemini (laptop, niced).
- Planned but **not done:** PaliGemma 2 (no A100 capacity, and no HF token for the gated weights).

## Setup
- **Model:** `yolov8n.pt` → fine-tuned, imgsz 640, batch 32, 80 epochs, seed 42, `fliplr=0` (label text is never mirrored). Full args: `docs/evidence/fieldspotter/args.yaml`; per-epoch metrics: `docs/evidence/fieldspotter/results.csv`.
- **Split:** by label (`src_id`), 80/20, seed 42, so no label is in both train and val (`docs/evidence/fieldspotter/split.json`). Train has 1,392 images; val has 348 images and 896 boxes.

## Results (held-out val, n = 348 images; `eval/results/fieldspotter.json`, script `eval/fs_eval.py`)
| Metric | Value |
|---|---|
| **"Strength visible" precision** (conf ≥ 0.4, image level) | **96.8%** (122 / 126; Wilson 95% CI 92.1–98.8%) |
| "Strength visible" recall | 65.6% (122 / 186; 58.5–72.0%). Conservative: when unsure it says nothing and Gemini still reads the label |
| mAP@0.5, all classes | 0.572 (P 0.742, R 0.531) |
| mAP@0.5 per class | product 0.663 · strength 0.607 · expiry 0.616 · allergens 0.401 |
| Latency, ONNX on CPU (AMD EPYC, 100 images) | **p50 34.5 ms**, p95 35.3 ms, so about 29 fps with no GPU |
| Latency, PyTorch on the shared H100 | p50 17.9 ms, p95 39.1 ms (n = 348) |
| Model size | ONNX 12.8 MB (`web/public/models/fieldspotter.onnx`), 3.1 M parameters |

## Status in the product
The model is **trained, evaluated and committed**. It isn't yet wired into the live coaching loop (that's `docs/PLAN.md` §0c, flag `spotter`). Until it is, don't claim it in the live demo.

## Path to scale (Verda)
- **Retraining:** on real wearer footage (consented) on Verda GPU instances.
- **Serving:** server-side models run in Verda auto-scaling containers. FieldSpotter itself is small enough to stay on the device, which keeps label images on the phone.
