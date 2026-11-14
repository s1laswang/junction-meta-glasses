"""Step 1 of the Gemini workforce: generate ground-truth label specs as JSON.

gemini-3.8-flash writes realistic medication boxes/bottles (incl. Nordic/Finnish
packaging, some Finnish/Swedish text) and food packages with allergen panels
(incl. tricky synonyms like arachis oil, whey, "may contain traces").

Usage: python eval/gen_specs.py [--meds 100] [--foods 50] [--batch 10]
Output: $HOLDUP_DATA/specs.jsonl
"""
from __future__ import annotations

import argparse
import random

from common import DATA, SPEC_MODEL, gen_json, log, pmap, write_jsonl

CANON_ALLERGENS = ["peanut", "tree_nuts", "milk", "egg", "gluten", "soy", "fish",
                   "crustaceans", "molluscs", "sesame", "celery", "mustard", "lupin", "sulphites"]

SPEC_SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "kind": {"type": "string", "enum": ["medication", "food"]},
                    "package": {"type": "string", "description": "box | bottle | blister | tube | jar | bag | carton | can | tin"},
                    "language": {"type": "string", "description": "en | fi | sv | fi+sv | multi"},
                    "brand": {"type": "string"},
                    "product": {"type": "string", "description": "Product name exactly as printed most prominently on the front"},
                    "ingredient": {"type": "string", "description": "Active ingredient (generic, INN, lowercase English) for meds; empty for food"},
                    "strength": {"type": "string", "description": "Strength exactly as printed, e.g. '5 mg', '500 mg/5 ml', '0.1 mg/dose'; empty for food"},
                    "form": {"type": "string", "description": "tablets, capsules, oral solution, ... or food type"},
                    "count": {"type": "string", "description": "pack size as printed, e.g. '30 tabl.' or '200 g'"},
                    "dosing": {"type": "string", "description": "Short dosing line as printed (may be in fi/sv), or empty for food"},
                    "expiry": {"type": "string", "description": "Expiry as YYYY-MM (or YYYY-MM-DD for food best-before)"},
                    "expiry_printed": {"type": "string", "description": "Expiry exactly as printed, e.g. 'EXP 03/2027', 'Käyt. viim. 2027-03', 'Parasta ennen 12.05.2026'"},
                    "allergens": {"type": "array", "items": {"type": "string", "enum": CANON_ALLERGENS}, "description": "Canonical allergens the product CONTAINS"},
                    "may_contain": {"type": "array", "items": {"type": "string", "enum": CANON_ALLERGENS}, "description": "Canonical allergens in a 'may contain traces' statement"},
                    "ingredients_text": {"type": "string", "description": "Food ingredients list as printed (allergens in bold/caps as is customary), using realistic synonyms where natural (arachis oil, whey powder, casein, semolina, tahini, albumen...). Empty for meds."},
                    "may_contain_text": {"type": "string", "description": "Trace statement as printed, or empty"},
                    "barcode": {"type": "string", "description": "13-digit EAN or empty"},
                    "colors": {"type": "string", "description": "packaging colour scheme"},
                    "front_text": {"type": "array", "items": {"type": "string"}, "description": "Every short text line printed on the visible front/main face, in order"},
                    "tricky": {"type": "string", "description": "What makes this label tricky to read or to judge (or empty)"},
                },
                "required": ["kind", "package", "language", "brand", "product", "ingredient", "strength", "form",
                             "count", "dosing", "expiry", "expiry_printed", "allergens", "may_contain",
                             "ingredients_text", "may_contain_text", "barcode", "colors", "front_text", "tricky"],
            },
        }
    },
    "required": ["items"],
}

MED_THEMES = [
    "Finnish pharmacy boxes (Orion, Teva, Sandoz, Krka, Accord, Ratiopharm) for common chronic meds: amlodipine, ramipril, bisoprolol, atorvastatin, simvastatin, metformin, levothyroxine; Finnish+Swedish text",
    "Over-the-counter pain and fever: ibuprofen (Burana, Ibumax), paracetamol (Panadol, Pamol), naproxen, acetylsalicylic acid (Disperin, Aspirin); mix English and Finnish",
    "Look-alike/sound-alike pairs that a blind user could confuse: same ingredient different strengths (e.g. amlodipine 5 mg vs 10 mg, levothyroxine 50 vs 100 microg), or similar names (hydroxyzine vs hydralazine)",
    "Elderly polypharmacy: warfarin (Marevan), apixaban, clopidogrel, furosemide, digoxin, tamsulosin, donepezil, mirtazapine, zopiclone, melatonin; small print",
    "Liquids and non-tablet forms: oral solutions in mg/ml, eye drops, nasal spray, inhaler doses (microg/dose), creams in %; bottles and tubes",
    "Swedish-language and pan-Nordic packs (Apotek, Apoteket), English UK pharmacy boxes (Boots, Lloyds), and German/EU packs with multiple languages",
    "Supplements and vitamins that look like medicine: vitamin D3 (Devisol, D-Pearls), B12, iron, calcium+D, omega-3, magnesium; strengths in microg/IU/mg",
    "Allergy and stomach meds: cetirizine, loratadine, desloratadine, omeprazole, esomeprazole, pantoprazole, loperamide; blister packs and boxes with combo strengths",
    "Antibiotics and short courses: amoxicillin, phenoxymethylpenicillin (V-Pen Mega), doxycycline, nitrofurantoin; dosing instructions with times per day; pharmacy sticker style",
    "Mental health and neuro: sertraline, escitalopram, quetiapine, pregabalin, gabapentin, lamotrigine; combination strengths like 'x mg/y mg'",
]
FOOD_THEMES = [
    "Finnish supermarket snacks and bakery (Fazer, Panda, Valio, Oululainen, Pirkka, Kotimaista): chocolate, rye bread, biscuits; Finnish+Swedish allergen panels",
    "Plant-based and 'free-from' products: oat drinks (Oatly), vegan spreads, gluten-free bread; with tricky 'may contain' traces of nuts/sesame",
    "Products where allergens hide behind synonyms: arachis oil (peanut), whey/casein/lactose (milk), albumen (egg), semolina/spelt/durum (gluten), tahini (sesame), surimi (fish), lecithin (soy)",
    "Ready meals, sauces, soups and spice mixes: celery, mustard, sulphites, crustaceans; long ingredient lists in small print",
    "Imported and multilingual items (UK, Sweden, Germany, Asia): nut butters, pesto, satay sauce, granola, protein bars",
]


def build_prompt(kind: str, theme: str, n: int, seed: int) -> str:
    common = (
        f"Generate {n} distinct, realistic product label specifications as ground truth for evaluating a label reader "
        f"for blind and low-vision users in Finland. Theme for this batch: {theme}. Random seed {seed}: vary brands, "
        "colours, packaging, languages and expiry dates (between 2025-06 and 2029-12; include a few already expired). "
        "Everything you put in front_text must be short and exactly what is printed (an image model will render it). "
        "Use real generic names and plausible (real or realistic) brand names. Do not include any personal names. "
    )
    if kind == "medication":
        return common + (
            "All items are kind='medication'. The front face must show product name, strength and form; "
            "put strength exactly as on a real pack. Keep allergens/may_contain empty and ingredients_text empty. "
            "About a third should have some Finnish or Swedish text (e.g. 'tabletti, kalvopäällysteinen', '30 tabl.', "
            "'1 tabletti kerran päivässä'). Include dosing as printed (pharmacy sticker style is fine)."
        )
    return common + (
        "All items are kind='food'. Leave ingredient and strength empty and dosing empty. The allergens list must "
        "exactly match what ingredients_text implies (canonical names); may_contain must match may_contain_text. "
        "Make the allergen panel realistic and include tricky synonyms where natural. Some items should contain no "
        "major allergens but carry a 'may contain' statement; a few should be allergen-free. front_text is the front of pack."
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--meds", type=int, default=100)
    ap.add_argument("--foods", type=int, default=50)
    ap.add_argument("--batch", type=int, default=10)
    ap.add_argument("--workers", type=int, default=8)  # <=16 per model (shared key)
    a = ap.parse_args()

    jobs = []
    for i in range((a.meds + a.batch - 1) // a.batch):
        jobs.append(("medication", MED_THEMES[i % len(MED_THEMES)], a.batch, random.randint(0, 10**6)))
    for i in range((a.foods + a.batch - 1) // a.batch):
        jobs.append(("food", FOOD_THEMES[i % len(FOOD_THEMES)], a.batch, random.randint(0, 10**6)))

    def run(job):
        kind, theme, n, seed = job
        data, _, _ = gen_json(SPEC_MODEL, build_prompt(kind, theme, n, seed), schema=SPEC_SCHEMA,
                              thinking="low", max_tokens=16384, feature="gen_specs", label=f"spec-{kind}")
        return [dict(it, theme=theme) for it in data["items"] if it.get("kind") == kind]

    batches = pmap(run, jobs, workers=a.workers, desc="spec batches")
    specs, seen = [], set()
    for b in batches:
        if isinstance(b, dict):
            log("batch failed:", b.get("error"))
            continue
        for it in b:
            key = (it["product"].lower(), it.get("strength", "").lower())
            if key in seen:
                continue
            seen.add(key)
            specs.append(it)
    meds = [s for s in specs if s["kind"] == "medication"][: a.meds]
    foods = [s for s in specs if s["kind"] == "food"][: a.foods]
    out = []
    for i, s in enumerate(meds):
        out.append({"id": f"med{i:03d}", **s})
    for i, s in enumerate(foods):
        out.append({"id": f"food{i:03d}", **s})
    write_jsonl(DATA / "specs.jsonl", out)
    log(f"wrote {len(out)} specs ({len(meds)} meds, {len(foods)} foods) to {DATA/'specs.jsonl'}")


if __name__ == "__main__":
    main()
