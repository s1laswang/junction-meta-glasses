# Convert the HoldUp YOLO split into PaliGemma detection JSONL.
# PaliGemma box format: <locYmin><locXmin><locYmax><locXmax> label, coordinates binned to 0..1023, joined by " ; ".
import json, os, sys
YOLO = sys.argv[1]            # /tmp/fs/yolo (images/{train,val}, labels/{train,val})
OUT = sys.argv[2]             # output dir
CLASSES = ["product", "strength", "expiry", "allergens"]
PREFIX = "detect " + " ; ".join(CLASSES)
def loc(v):  # v in 0..1
    return f"<loc{max(0, min(1023, round(v * 1023))):04d}>"
os.makedirs(OUT, exist_ok=True)
for split in ("train", "val"):
    n = 0
    with open(f"{OUT}/{split}.jsonl", "w") as f:
        for name in sorted(os.listdir(f"{YOLO}/labels/{split}")):
            objs = []
            for line in open(f"{YOLO}/labels/{split}/{name}").read().split("\n"):
                if not line.strip():
                    continue
                c, cx, cy, w, h = line.split()
                cx, cy, w, h = map(float, (cx, cy, w, h))
                y0, x0, y1, x1 = cy - h / 2, cx - w / 2, cy + h / 2, cx + w / 2
                objs.append(f"{loc(y0)}{loc(x0)}{loc(y1)}{loc(x1)} {CLASSES[int(c)]}")
            f.write(json.dumps({"image": f"images/{split}/{name[:-4]}.jpg", "prefix": PREFIX,
                                "suffix": " ; ".join(objs)}) + "\n")
            n += 1
    print(split, n)
