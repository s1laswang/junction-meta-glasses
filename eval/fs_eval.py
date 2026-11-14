# FieldSpotter held-out eval: mAP per class (ultralytics val), "strength visible" image-level precision/recall with
# Wilson 95% CIs, and per-image latency for the PyTorch model (GPU) and the ONNX export (CPU).
import json, math, os, sys, time, glob
from ultralytics import YOLO
ROOT = "/root/meta-glasses"
W = f"{ROOT}/runs/fieldspotter/weights/best.pt"
def wilson(k, n, z=1.96):
    if n == 0: return [0.0, 0.0]
    p = k / n; d = 1 + z * z / n; c = p + z * z / (2 * n); h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return [round(100 * (c - h) / d, 1), round(100 * (c + h) / d, 1)]
m = YOLO(W)
v = m.val(data=f"{ROOT}/yolo/data.yaml", split="val", imgsz=640, batch=16, workers=4, device=0, verbose=False, plots=False)
names = m.names
per_class = {names[i]: {"mAP50": round(float(v.box.ap50[j]), 3), "mAP50_95": round(float(v.box.ap[j]), 3)}
             for j, i in enumerate(v.box.ap_class_index)}
out = {"model": "YOLOv8n (ultralytics), fine-tuned", "weights": W, "n_val_images": 348,
       "map50_all": round(float(v.box.map50), 3), "map50_95_all": round(float(v.box.map), 3),
       "precision_all": round(float(v.box.mp), 3), "recall_all": round(float(v.box.mr), 3), "per_class": per_class}
# image-level "strength visible" at conf >= 0.4 vs ground truth label file
imgs = sorted(glob.glob(f"{ROOT}/yolo/images/val/*.jpg"))
tp = fp = fn = tn = 0; lat = []
SID = [k for k, n in names.items() if n == "strength"][0]
for p in imgs:
    gt = open(p.replace("/images/", "/labels/").replace(".jpg", ".txt")).read().split("\n")
    has = any(l.startswith(f"{SID} ") for l in gt)
    t = time.perf_counter(); r = m.predict(p, imgsz=640, conf=0.4, device=0, verbose=False)[0]; lat.append((time.perf_counter() - t) * 1000)
    pred = any(int(c) == SID for c in r.boxes.cls.tolist())
    tp += has and pred; fp += (not has) and pred; fn += has and (not pred); tn += (not has) and (not pred)
lat.sort()
out["strength_visible"] = {"conf": 0.4, "tp": tp, "fp": fp, "fn": fn, "tn": tn,
    "precision": round(100 * tp / max(1, tp + fp), 1), "precision_ci": wilson(tp, tp + fp),
    "recall": round(100 * tp / max(1, tp + fn), 1), "recall_ci": wilson(tp, tp + fn)}
out["latency_ms_gpu_shared_h100"] = {"n": len(lat), "p50": round(lat[len(lat) // 2], 1), "p95": round(lat[int(len(lat) * 0.95)], 1)}
onnx = m.export(format="onnx", imgsz=640, simplify=True, dynamic=False)
out["onnx"] = {"path": onnx, "bytes": os.path.getsize(onnx)}
mo = YOLO(onnx, task="detect"); lo = []
for p in imgs[:100]:
    t = time.perf_counter(); mo.predict(p, imgsz=640, device="cpu", verbose=False); lo.append((time.perf_counter() - t) * 1000)
lo.sort(); out["latency_ms_onnx_cpu"] = {"n": len(lo), "p50": round(lo[len(lo) // 2], 1), "p95": round(lo[int(len(lo) * 0.95)], 1)}
json.dump(out, open(f"{ROOT}/fieldspotter.json", "w"), indent=1)
print(json.dumps(out, indent=1))
