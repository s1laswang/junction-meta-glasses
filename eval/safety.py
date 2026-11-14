"""Python port of the deterministic safety check (verdict = f(LabelRead, Profile)).

This is the eval's DRAFT port, written from docs/PLAN.md section 2 step 4 while
server/ has no safety module yet. When server's safety module lands, run_eval.py
prefers calling it through `npx tsx eval/safety_bridge.ts` and falls back to this port.

Levels: match | warning | unsure | info
"""
from __future__ import annotations

from normalize import canon_allergens, eq_ingredient, eq_product, eq_strength, norm_date

# NSAID-style class lists for profile.avoid entries
CLASSES = {
    "nsaid": ["ibuprofen", "naproxen", "diclofenac", "ketoprofen", "acetylsalicylic", "aspirin", "etoricoxib",
              "celecoxib", "meloxicam", "dexketoprofen"],
    "nsaids": None,
    "benzodiazepine": ["diazepam", "oxazepam", "alprazolam", "lorazepam", "temazepam", "zopiclone", "zolpidem"],
    "anticoagulant": ["warfarin", "apixaban", "rivaroxaban", "dabigatran", "edoxaban"],
}
CLASSES["nsaids"] = CLASSES["nsaid"]


def _ok(f, t):
    return f and f.get("value") not in (None, "", []) and (f.get("confidence") or 0) >= t


def verdict(read: dict, profile: dict, today=(2026, 11, 14), t: float = 0.8, t_id: float | None = None) -> dict:
    """t: confidence needed for strength/allergens/expiry; t_id: for product/ingredient identity (default t)."""
    t_id = t if t_id is None else t_id
    reasons: list[str] = []
    kind = read.get("kind")
    if kind == "unreadable" or (read.get("readability") or 0) < 0.2:
        return {"level": "unsure", "reasons": ["unreadable"]}

    level = "info"
    matched = None
    if kind == "medication" or (kind != "food" and (_ok(read.get("strength"), 0.01) or _ok(read.get("ingredient"), 0.01))):
        ing = read["ingredient"]["value"] if _ok(read.get("ingredient"), t_id) else None
        prod = read["product"]["value"] if _ok(read.get("product"), t_id) else None
        if not ing and not prod:
            return {"level": "unsure", "reasons": ["cannot identify the medicine confidently"]}
        name_hits = []
        for m in profile.get("meds", []):
            if (ing and eq_ingredient(m["ingredient"], ing)) or (prod and (eq_product(m["name"], prod) or
                                                                         eq_ingredient(m["ingredient"], prod))):
                name_hits.append(m)
        avoid_hit = None
        for a in profile.get("avoid", []):
            al = a.lower()
            members = CLASSES.get(al, [al])
            for mem in members:
                if (ing and eq_ingredient(mem, ing)) or (prod and eq_ingredient(mem, prod)):
                    avoid_hit = a
        if avoid_hit:
            level = "warning"; reasons.append(f"on avoid list: {avoid_hit}")
        elif name_hits:
            if not _ok(read.get("strength"), t):
                return {"level": "unsure", "reasons": ["strength not read confidently"]}
            same = [m for m in name_hits if eq_strength(m["strength"], read["strength"]["value"])]
            if same:
                level = "match"; matched = same[0]["id"]; reasons.append("on list, strength matches")
            else:
                level = "warning"; reasons.append("on list but strength differs")
        else:
            level = "warning"; reasons.append("not on your list")
    elif kind == "food":
        al = read.get("allergens") or {}
        if not _ok(al, t) and not (al.get("value") == [] and (al.get("confidence") or 0) >= t):
            return {"level": "unsure", "reasons": ["allergens not read confidently"]}
        hits = canon_allergens(al.get("value") or []) & canon_allergens(profile.get("allergies", []))
        if hits:
            level = "warning"; reasons.append("contains/may contain " + ",".join(sorted(hits)))
        else:
            level = "info"; reasons.append("no listed allergens found")
    # expiry
    ex = read.get("expiry")
    if _ok(ex, t):
        d = norm_date(ex["value"])
        if d and (d[0], d[1]) < today[:2]:
            level = "warning"; reasons.append("expired")
    return {"level": level, "reasons": reasons, "matchedMedId": matched}
