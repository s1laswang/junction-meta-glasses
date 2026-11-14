# PaliGemma 2 3B (Gemma family) LoRA fine-tune for HoldUp label-field detection, plus held-out eval.
# Run from /root/meta-glasses with HF_TOKEN in the environment. bf16 on A100/H100.
import json, math, os, re, time, torch
from PIL import Image
from transformers import AutoProcessor, PaliGemmaForConditionalGeneration
from peft import LoraConfig, get_peft_model

ROOT = os.environ.get("ROOT", "/root/meta-glasses")
MODEL = os.environ.get("PG_MODEL", "google/paligemma2-3b-pt-448")
EPOCHS = float(os.environ.get("EPOCHS", "3")); BS = int(os.environ.get("BS", "8")); LR = float(os.environ.get("LR", "2e-4"))
CLASSES = ["product", "strength", "expiry", "allergens"]
dev = "cuda"
proc = AutoProcessor.from_pretrained(MODEL, token=os.environ.get("HF_TOKEN"))
model = PaliGemmaForConditionalGeneration.from_pretrained(MODEL, torch_dtype=torch.bfloat16, token=os.environ.get("HF_TOKEN")).to(dev)
for p in model.vision_tower.parameters(): p.requires_grad = False
model = get_peft_model(model, LoraConfig(r=16, lora_alpha=32, lora_dropout=0.05,
                       target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"], task_type="CAUSAL_LM"))
model.print_trainable_parameters()

def load(split): return [json.loads(l) for l in open(f"{ROOT}/pg/{split}.jsonl")]
train, val = load("train"), load("val")
def batch(rows, with_suffix=True):
    imgs = [Image.open(f"{ROOT}/yolo/{r['image']}").convert("RGB") for r in rows]
    texts = ["<image>" + r["prefix"] for r in rows]
    if with_suffix:
        return proc(text=texts, images=imgs, suffix=[r["suffix"] for r in rows], return_tensors="pt", padding="longest").to(dev, torch.bfloat16)
    return proc(text=texts, images=imgs, return_tensors="pt", padding="longest").to(dev, torch.bfloat16)

opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=LR)
steps = math.ceil(len(train) / BS) * EPOCHS
sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=LR, total_steps=int(steps), pct_start=0.05)
log = open(f"{ROOT}/pg_train.log", "a"); t0 = time.time(); step = 0
import random; random.seed(42)
model.train()
while step < steps:
    random.shuffle(train)
    for i in range(0, len(train), BS):
        if step >= steps: break
        b = batch(train[i:i + BS])
        loss = model(**b).loss
        loss.backward(); opt.step(); sched.step(); opt.zero_grad(); step += 1
        if step % 20 == 0:
            msg = f"step {step}/{int(steps)} loss {loss.item():.4f} t {time.time() - t0:.0f}s"
            print(msg, flush=True); log.write(msg + "\n"); log.flush()
model.save_pretrained(f"{ROOT}/pg_lora")
train_s = time.time() - t0

# ---------- held-out eval ----------
LOC = re.compile(r"<loc(\d{4})><loc(\d{4})><loc(\d{4})><loc(\d{4})>\s*([a-z]+)")
def parse(s): return [(m.group(5), [int(m.group(k)) / 1023 for k in range(1, 5)]) for m in LOC.finditer(s)]
def iou(a, b):
    y0, x0 = max(a[0], b[0]), max(a[1], b[1]); y1, x1 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0, y1 - y0) * max(0, x1 - x0)
    u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / u if u > 0 else 0
def wilson(k, n, z=1.96):
    if n == 0: return [0.0, 0.0]
    p = k / n; d = 1 + z * z / n; c = p + z * z / (2 * n); h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return [round(100 * (c - h) / d, 1), round(100 * (c + h) / d, 1)]
model.eval(); stats = {c: {"tp": 0, "fp": 0, "fn": 0} for c in CLASSES}; sv = {"tp": 0, "fp": 0, "fn": 0, "tn": 0}; lat = []
with torch.no_grad():
    for r in val:
        b = batch([r], with_suffix=False); n_in = b["input_ids"].shape[-1]
        torch.cuda.synchronize(); t = time.perf_counter()
        out = model.generate(**b, max_new_tokens=96, do_sample=False)
        torch.cuda.synchronize(); lat.append((time.perf_counter() - t) * 1000)
        pred = parse(proc.decode(out[0][n_in:], skip_special_tokens=False)); gt = parse(r["suffix"])
        for c in CLASSES:
            P = [bx for l, bx in pred if l == c]; G = [bx for l, bx in gt if l == c]; used = set()
            for p in P:
                j = max(range(len(G)), key=lambda k: iou(p, G[k]), default=None)
                if j is not None and j not in used and iou(p, G[j]) >= 0.5: stats[c]["tp"] += 1; used.add(j)
                else: stats[c]["fp"] += 1
            stats[c]["fn"] += len(G) - len(used)
        hs, ps = any(l == "strength" for l, _ in gt), any(l == "strength" for l, _ in pred)
        sv["tp"] += hs and ps; sv["fp"] += (not hs) and ps; sv["fn"] += hs and not ps; sv["tn"] += (not hs) and not ps
lat.sort()
res = {"model": MODEL + " + LoRA r16 (HoldUp FieldSpotter-Gemma)", "epochs": EPOCHS, "train_seconds": round(train_s), "n_val_images": len(val),
       "per_class_iou50": {c: {**s, "precision": round(100 * s["tp"] / max(1, s["tp"] + s["fp"]), 1), "recall": round(100 * s["tp"] / max(1, s["tp"] + s["fn"]), 1)} for c, s in stats.items()},
       "strength_visible": {**sv, "precision": round(100 * sv["tp"] / max(1, sv["tp"] + sv["fp"]), 1), "precision_ci": wilson(sv["tp"], sv["tp"] + sv["fp"]),
                            "recall": round(100 * sv["tp"] / max(1, sv["tp"] + sv["fn"]), 1), "recall_ci": wilson(sv["tp"], sv["tp"] + sv["fn"])},
       "latency_ms_gpu": {"n": len(lat), "p50": round(lat[len(lat) // 2], 1), "p95": round(lat[int(len(lat) * 0.95)], 1)}}
json.dump(res, open(f"{ROOT}/fieldspotter_gemma.json", "w"), indent=1); print(json.dumps(res, indent=1))
