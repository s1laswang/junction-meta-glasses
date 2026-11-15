# HoldUp × Gemma: FieldSpotter-Gemma (Google DeepMind "Best Use of Gemma")

## Problem
Blind and low-vision people can't see *where* the dose is printed on a medicine box, or whether their thumb is covering it. HoldUp's Gemini reader (see `GEMINI.md`) answers "is this my evening pill?". Before it can answer, though, the user has to get the strength field in front of the camera. That's a spatial coaching problem, and it needs a fast, local, open model that knows what a dose field looks like.

## How we use Gemma
**PaliGemma 2 3B** (`google/paligemma2-3b-pt-448`, Gemma family) is LoRA-fine-tuned (r = 16, about 23.8 M trainable parameters, 0.78%) as a **label-field detector**. Prompt: `detect product ; strength ; expiry ; allergens`. It answers with PaliGemma location tokens, one box per field.

**Training data distilled from Gemini.**
- The data is the 1,740 Gemini-generated, ground-truthed first-person label photos from our eval (`docs/EVAL.md`): Gemini wrote 172 label specs, Gemini image models rendered them, Gemini Flash checked legibility and marked a box for every field, and PIL degraded them (blur, glare, crop, rotation, low light, back of box).
- The split is by label (no label in both sets): 1,392 train and 348 held-out images.
- **Gemini made the data and Gemma learned from it.**

**Where it ran:** a Verda A100-SXM4-80GB (instance f4378173, FIN-03), shared through the team's FR8 queue.
- Training: 2026-11-14 23:35:34Z → 2026-11-15 00:12:18Z, about 29 min for 2 epochs (1,392 steps at batch 2), plus eval. Peak about 15.5 GB GPU memory, with gradient checkpointing and a hard memory cap.
- A first attempt at batch 8 ran out of memory and was relaunched.
- Scripts: `eval/pg_data.py` (data conversion) and `eval/pg_train.py` (training + held-out eval). Results: `eval/results/fieldspotter_gemma.json`. The LoRA adapter (91 MB) is kept out of git.

## Results (held-out, n = 348 images, 95% Wilson CIs)
| | **PaliGemma 2 3B + LoRA (Gemma)** | YOLOv8n (same data, also trained on Verda) |
|---|---|---|
| "Strength visible": precision | 89.9% (84.8–93.5) | **96.8%** (92.1–98.8) |
| "Strength visible": recall | **91.4%** (86.5–94.6) | 65.6% (58.5–72.0) |
| Box precision / recall at IoU ≥ 0.5: strength | 52.4% / 53.2% | mAP@0.5 0.607 |
| Box precision / recall at IoU ≥ 0.5: expiry | 59.1% / 56.8% | mAP@0.5 0.616 |
| Box precision / recall at IoU ≥ 0.5: allergens | 41.2% / 33.7% | mAP@0.5 0.401 |
| Latency per image | 1.43 s p50 (shared A100, greedy decode) | **34.5 ms** on CPU (ONNX) |

**What this says, honestly:**
- **Gemma finds the dose far more often.** "Is the dose in view?" recall is 91% vs 66%, at slightly lower precision. As a "can you see the dose yet?" signal, it misses about a quarter as many cases as YOLO.
- **YOLO draws tighter boxes and is about 40× faster.** It's the right model for real-time (≥ 5 fps) "your thumb is on it" boxes.
- The two models complement each other:
  - YOLOv8n handles real-time boxes on the phone;
  - Gemma gives a high-recall "dose visible?" check about once a second;
  - Gemini reads the label and decides.
- **Not yet in the product.** Neither detector is wired into the live coaching loop yet (`docs/PLAN.md` §0c, flag `spotter`). These are trained and evaluated models, not a shipped feature.

## Innovation
- **Distillation from Gemini into Gemma, measured.** A frontier model creates and labels the data; an open model learns a narrow, safety-relevant perception skill from it, and is evaluated on held-out labels with confidence intervals.
- **A safety-shaped role.** The open model never decides anything about a medicine. It only helps the user get the right part of the label into view, and Gemini plus deterministic rules still own the verdict.

## Real-world value and path
- **The open weights can run where the cloud can't.** Next steps are a quantised PaliGemma 2 or Gemma 3n on the phone for offline "where's the dose" coaching, plus retraining on consented real wearer footage.
- **Cost:** 2 epochs, about 0.5 GPU-hours on a shared A100.
