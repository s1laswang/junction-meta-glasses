"""Field normalisation and comparison for scoring label reads."""
from __future__ import annotations

import difflib
import re
import unicodedata

CANON = ["peanut", "tree_nuts", "milk", "egg", "gluten", "soy", "fish", "crustaceans", "molluscs", "sesame",
         "celery", "mustard", "lupin", "sulphites"]

# Synonym table (en/fi/sv + ingredient words). Substring match on a lowercased, accent-folded string.
ALLERGEN_SYNONYMS: dict[str, list[str]] = {
    "peanut": ["peanut", "arachis", "groundnut", "maapähkinä", "maapahkina", "jordnöt", "jordnot", "monkey nut"],
    "tree_nuts": ["tree nut", "nuts", "almond", "hazelnut", "walnut", "cashew", "pecan", "pistachio", "macadamia",
                  "brazil nut", "pähkinä", "pahkina", "manteli", "hasselpähkinä", "cashewpähkinä", "nötter", "notter",
                  "mandel", "hasselnöt", "hasselnot", "valnöt", "praline", "marzipan", "nougat"],
    "milk": ["milk", "whey", "casein", "caseinate", "lactose", "butter", "cream", "cheese", "yoghurt", "yogurt",
             "maito", "hera", "kerma", "voi", "juusto", "laktoosi", "kaseiini", "mjölk", "mjolk", "vassle", "grädde",
             "smör", "ost", "ghee", "kefir", "skyr", "rahka", "dairy"],
    "egg": ["egg", "albumen", "albumin", "ovalbumin", "lysozyme", "muna", "kanamuna", "ägg", "agg", "mayonnaise"],
    "gluten": ["gluten", "wheat", "rye", "barley", "spelt", "semolina", "durum", "kamut", "oat", "malt", "couscous",
               "bulgur", "vehnä", "vehna", "ruis", "ohra", "kaura", "spelttivehnä", "gluteeni", "vete", "råg", "rag",
               "korn", "havre", "dinkel", "farro", "seitan", "graham"],
    "soy": ["soy", "soya", "soja", "edamame", "tofu", "miso", "tempeh", "lecithin (soy", "soijа", "soija"],
    "fish": ["fish", "anchov", "cod", "salmon", "tuna", "surimi", "kala", "lohi", "turska", "fisk", "lax", "torsk",
             "sardine", "mackerel", "herring", "silli", "sill", "fish sauce"],
    "crustaceans": ["crustacean", "shrimp", "prawn", "crab", "lobster", "krill", "katkarapu", "rapu", "äyriäi",
                    "ayriai", "räka", "raka", "kräft", "hummer", "krabba"],
    "molluscs": ["mollusc", "mollusk", "mussel", "oyster", "squid", "octopus", "clam", "scallop", "snail",
                 "nilviäi", "nilviai", "simpukka", "blötdjur", "blotdjur", "musslor", "bläckfisk"],
    "sesame": ["sesame", "sesam", "seesami", "tahini", "tahina", "gomasio"],
    "celery": ["celery", "celeriac", "selleri", "selleri", "celeri"],
    "mustard": ["mustard", "sinappi", "senap", "dijon"],
    "lupin": ["lupin", "lupine", "lupiini", "lupin"],
    "sulphites": ["sulphite", "sulfite", "sulphur dioxide", "sulfur dioxide", "e220", "e221", "e222", "e223", "e224",
                  "e226", "e227", "e228", "metabisulph", "metabisulf", "sulfiitti", "rikkidioksidi", "svaveldioxid"],
}


def fold(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "").lower()
    return "".join(c for c in s if not unicodedata.combining(c))


def canon_allergens(items) -> set[str]:
    out = set()
    for it in items or []:
        t = fold(str(it)).replace("_", " ")
        for k, syns in ALLERGEN_SYNONYMS.items():
            if k.replace("_", " ") in t or any(fold(s) in t for s in syns):
                out.add(k)
    # "nuts" alone also matches "peanuts"; don't infer tree nuts from a peanut-only string
    if "peanut" in out and "tree_nuts" in out:
        joined = " ".join(fold(str(i)) for i in items or [])
        if not re.search(r"(tree nut|almond|hazel|walnut|cashew|pecan|pistach|macadam|brazil|manteli|mandel|"
                         r"hassel|valnot|praline|marzipan|nougat|(?<!maa)pahkina|(?<!jord)notter|(?<!pea)nuts)", joined):
            out.discard("tree_nuts")
    return out


UNIT_MAP = {
    "mcg": "ug", "µg": "ug", "μg": "ug", "microg": "ug", "mikrog": "ug", "mikrogrammaa": "ug", "mikrogram": "ug",
    "microgram": "ug", "micrograms": "ug", "ug": "ug",
    "mg": "mg", "milligram": "mg", "milligrams": "mg", "milligrammaa": "mg",
    "g": "g", "gram": "g", "grams": "g", "ml": "ml", "l": "l", "iu": "iu", "ie": "iu", "ky": "iu", "%": "%",
    "mmol": "mmol", "mg/ml": "mg/ml",
}
NUM_UNIT = re.compile(r"(\d+(?:[.,]\d+)?)\s*(mikrogrammaa|mikrogram|micrograms|microgram|milligrammaa|milligrams|"
                      r"milligram|microg|mikrog|mcg|µg|μg|ug|mg|ml|mmol|iu|ie|ky|g|l|%)(?![a-z])", re.I)


def strength_tokens(s: str) -> list[tuple[float, str]]:
    s = fold(s).replace("µ", "u").replace("μ", "u")
    toks = []
    for num, unit in NUM_UNIT.findall(s):
        toks.append((float(num.replace(",", ".")), UNIT_MAP.get(unit.lower(), unit.lower())))
    return toks


def eq_strength(gt: str, pred: str) -> bool:
    g, p = strength_tokens(gt), strength_tokens(pred)
    if not g:
        return norm_text(gt) == norm_text(pred)
    return g == p[: len(g)] and len(p) <= len(g) + 1


def norm_text(s: str) -> str:
    s = fold(s)
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def eq_product(gt: str, pred: str) -> bool:
    g, p = norm_text(gt), norm_text(pred)
    if not g or not p:
        return False
    # ignore strength/count tokens
    strip = lambda x: re.sub(r"\b\d+([.,]\d+)?\s*(mg|ug|g|ml|mikrog|tabl|kpl|x)?\b", "", x).strip()
    g2, p2 = strip(g), strip(p)
    if g2 and (g2 in p2 or (p2 and p2 in g2 and len(p2) >= 0.6 * len(g2))):
        return True
    return difflib.SequenceMatcher(None, g2, p2).ratio() >= 0.8


def eq_ingredient(gt: str, pred: str) -> bool:
    g, p = norm_text(gt), norm_text(pred)
    if not g or not p:
        return False
    parts = [x for x in re.split(r"\s*(?:,|\+|/| and | ja | och )\s*", g) if x]
    def has(part):
        stem = part[: max(5, len(part) - 3)]  # tolerate salt/language suffixes (bisoprololfumar., -iini)
        return stem in p or difflib.SequenceMatcher(None, part, p).ratio() >= 0.85
    return all(has(x) for x in parts)


MONTHS = {"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6, "jul": 7, "aug": 8, "sep": 9, "oct": 10,
          "nov": 11, "dec": 12}


def norm_date(s: str) -> tuple[int, int, int | None] | None:
    if not s:
        return None
    t = fold(s)
    m = re.search(r"(20\d\d)[-/. ](\d{1,2})(?:[-/. ](\d{1,2}))?", t)
    if m:
        return int(m.group(1)), int(m.group(2)), int(m.group(3)) if m.group(3) else None
    m = re.search(r"(\d{1,2})[./-](\d{1,2})[./-](20\d\d|\d\d)\b", t)
    if m:
        y = int(m.group(3)); y = y + 2000 if y < 100 else y
        return y, int(m.group(2)), int(m.group(1))
    m = re.search(r"(\d{1,2})\s*[/.-]\s*(20\d\d|\d\d)\b", t)
    if m:
        y = int(m.group(2)); y = y + 2000 if y < 100 else y
        return y, int(m.group(1)), None
    m = re.search(r"([a-z]{3})[a-z]*\s*(20\d\d)", t)
    if m and m.group(1) in MONTHS:
        return int(m.group(2)), MONTHS[m.group(1)], None
    return None


def eq_expiry(gt: str, pred: str) -> bool:
    g, p = norm_date(gt), norm_date(pred)
    if not g or not p:
        return False
    if g[:2] != p[:2]:
        return False
    return g[2] is None or p[2] is None or g[2] == p[2]


def eq_dosing(gt: str, pred: str) -> bool:
    g, p = norm_text(gt), norm_text(pred)
    if not g or not p:
        return False
    if g in p or p in g:
        return True
    return difflib.SequenceMatcher(None, g, p).ratio() >= 0.7


def eq_barcode(gt: str, pred: str) -> bool:
    return re.sub(r"\D", "", gt or "") == re.sub(r"\D", "", pred or "") != ""


def eq_allergens(gt: list[str], pred) -> bool:
    return canon_allergens(pred) == set(gt or [])


COMPARE = {"product": eq_product, "ingredient": eq_ingredient, "strength": eq_strength, "dosing": eq_dosing,
           "expiry": eq_expiry, "barcode": eq_barcode, "allergens": eq_allergens}
