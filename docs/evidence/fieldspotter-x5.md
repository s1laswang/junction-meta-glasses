# FieldSpotter x5 Dataset (8,000 Box-Labelled First-Person Images)

**Purpose:** 5x scale-up training and held-out validation dataset for retraining HoldUp's on-device YOLOv8n label-field detector (`FieldSpotter`, `docs/evidence/verda-fieldspotter.md`) on Verda GPUs.

## Dataset Location and Layout

- **Local dataset path (kept out of git):** `~/carbon/out/fieldspotter-x5/` (`/Users/silaswang/carbon/out/fieldspotter-x5/`, `379.9 MB` JPEG + YOLO labels)
- **Committed manifest:** `eval/results/fieldspotter_x5_manifest.json`
- **Generator script:** `eval/fs_x5_gen.py`
- **YOLO layout (matches `eval/make_yolo.py` and `eval/fs_eval.py`):**
  - `data.yaml` (`0: product`, `1: strength`, `2: expiry`, `3: allergens`)
  - `split.json` (80/20 split by `spec_id`, seed 42; strictly isolated across multi-box composites so zero `src_id`s cross between `train` and `val`)
  - `images/{train,val}/*.jpg` (`640x640` RGB JPEG)
  - `labels/{train,val}/*.txt` (normalized `cls cx cy w h`)
  - `checksums.sha256` (`16,000` SHA-256 entries covering all 8,000 JPEGs and 8,000 `.txt` label files; root SHA-256 `8aa25ec222bd052124bc28125f66ee8d3339915e291dfd14774aacc37ec916c3`)

## Counts by Split and Class

| Split | Images | `product` (0) | `strength` (1) | `expiry` (2) | `allergens` (3) | Total Boxes |
|---|---:|---:|---:|---:|---:|---:|
| `train` | 6,341 | 6,713 | 4,736 | 6,458 | 1,632 | 19,539 |
| `val` | 1,659 | 1,756 | 1,258 | 1,680 | 433 | 5,127 |
| **Total** | **8,000** | **8,469** | **5,994** | **8,138** | **2,065** | **24,666** |

## Counts by First-Person Condition

| Condition | Images | Key Geometry / Coaching Signal |
|---|---:|---|
| `partial_view_crop` | 1,724 | Off-frame edge crops (top/bottom/left/right) with exact cropped-window `[0..1]` box reprojection |
| `multiple_boxes` | 1,293 | 2-box and 3-box tabletop scenes with all visible packs' boxes projected (strictly split-isolated) |
| `glasses_pov_wide_tilt` | 864 | Wide-FOV eye-level perspective + head tilt (`+-10..16 deg`) with 2D affine corner box projection |
| `thumb_over_dose_full` | 863 | Skin-toned thumb covering `>= 85%` of `strength` (`strength` box suppressed to train covered-dose detection) |
| `motion_blur` | 862 | Directional head/hand blur at 2 severities with line-height visibility gating |
| `clean_glasses_pov` | 432 | Clean smart-glasses eye-level view (`~32 cm`) |
| `thumb_over_dose_partial` | 432 | Thumb covering `~38%` of `strength` with clipped remaining visible box |
| `finger_grip_edge` | 431 | Finger gripping package margin without occluding dose digits |
| `low_light` | 431 | Dim indoor lighting + sensor noise |
| `specular_glare` | 431 | Overhead lamp reflection hotspot on label surface |
| `back_of_box` | 237 | Barcode / manufacturer reverse views (`0` foreground boxes; hard negatives) |

## Provenance and Honesty Notes

- **Synthetic data:** Specs (`1,714` total across blister strips, cylindrical bottles, unit-dose pouches, eye drops, inhalers, tubes, pharmacy cartons, and Nordic grocery allergen panels) and `box_2d` audits ran on `gemini-4-hydrogen` and `gemini-4-argon` (**0 `gemini-4-carbon` calls**); base renders (`526` verified, `472` unique sampled into the 8,000-image cap) ran on `gemini-3.1-flash-image`.
- **Verda retrain command:** Copy `~/carbon/out/fieldspotter-x5/` to `/root/meta-glasses/yolo` on the Verda GPU instance, verify `sha256sum -c checksums.sha256`, train `yolov8n.pt` (`imgsz=640, batch=32, epochs=80, seed=42, fliplr=0`), and evaluate with `eval/fs_eval.py`.
