# Convert HoldUp eval v1 synthetic set (Gemini-generated, ground-truthed) into a YOLO dataset.
# Boxes: gt.<field>.box = [ymin, xmin, ymax, xmax] in 0..1000; only fields with status visible/partial.
import json, os, random, shutil, sys
SRC = sys.argv[1]            # .../eval/synthetic
OUT = sys.argv[2]            # /tmp/fs/yolo
CLASSES = ["product", "strength", "expiry", "allergens"]
rows = [json.loads(l) for l in open(os.path.join(SRC, "dataset.jsonl"))]
srcs = sorted({r["src_id"] for r in rows})
random.Random(42).shuffle(srcs)
test_src = set(srcs[: max(1, len(srcs) // 5)])
counts = {"train": 0, "val": 0}
boxes = {"train": [0] * 4, "val": [0] * 4}
for split in ("train", "val"):
    os.makedirs(f"{OUT}/images/{split}", exist_ok=True)
    os.makedirs(f"{OUT}/labels/{split}", exist_ok=True)
for r in rows:
    split = "val" if r["src_id"] in test_src else "train"
    img = os.path.join(SRC, r["file"])
    if not os.path.exists(img):
        continue
    lines = []
    for ci, c in enumerate(CLASSES):
        g = r["gt"].get(c) or {}
        b = g.get("box") or []
        if len(b) != 4 or g.get("status") not in ("visible", "partial"):
            continue
        y0, x0, y1, x1 = [max(0, min(1000, v)) / 1000 for v in b]
        if x1 <= x0 or y1 <= y0:
            continue
        lines.append(f"{ci} {(x0 + x1) / 2:.5f} {(y0 + y1) / 2:.5f} {x1 - x0:.5f} {y1 - y0:.5f}")
        boxes[split][ci] += 1
    name = r["img_id"]
    shutil.copyfile(img, f"{OUT}/images/{split}/{name}.jpg")
    open(f"{OUT}/labels/{split}/{name}.txt", "w").write("\n".join(lines))
    counts[split] += 1
open(f"{OUT}/data.yaml", "w").write(
    f"path: {OUT}\ntrain: images/train\nval: images/val\nnames:\n" + "".join(f"  {i}: {c}\n" for i, c in enumerate(CLASSES)))
json.dump({"images": counts, "boxes": {s: dict(zip(CLASSES, v)) for s, v in boxes.items()},
           "val_src_ids": sorted(test_src), "split": "by src_id, 80/20, seed 42"}, open(f"{OUT}/split.json", "w"), indent=1)
print(json.dumps({"images": counts, "boxes": {s: dict(zip(CLASSES, v)) for s, v in boxes.items()}}))
