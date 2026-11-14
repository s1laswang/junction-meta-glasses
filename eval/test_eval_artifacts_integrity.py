import io
import json
import pathlib
import re
import tokenize
import tempfile
import unittest
from typing import Any

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
DEFAULT_EVAL_DIR = REPO_ROOT / "eval"

HASH_CHAR = chr(35)
SHEBANG_PREFIX = HASH_CHAR + "!"
EM_DASH = chr(0x2014)
API_KEY_PREFIX = "AI" + "za"
API_KEY_RE = re.compile(API_KEY_PREFIX + r"[0-9A-Za-z_-]{10,}")
DATA_IMAGE_B64_RE = re.compile(r"^data:image/[a-z0-9.+-]+;base64,", re.IGNORECASE)
JPEG_SOI_B64_PREFIX = "/9j/"
RAW_BASE64_RE = re.compile(r"^[A-Za-z0-9+/=\s]{2049,}$")
MAX_JSON_STRING_LEN = 2048

DOSE_COUNT_KEYS = ("confident_wrong_dose_count", "total_confident_wrong_dose_count")
ALLERGEN_COUNT_KEYS = ("false_safe_allergen_count", "total_false_safe_allergen_count")
ITEM_BOOL_SAFETY_KEYS = ("confident_wrong_dose", "false_safe_allergen")


def _collect_files_by_suffix(eval_dir: pathlib.Path, suffix: str) -> list[pathlib.Path]:
    found: list[pathlib.Path] = []
    for path in sorted(eval_dir.rglob(f"*{suffix}")):
        rel_parts = path.relative_to(eval_dir).parts
        if any(part == "__pycache__" or part.startswith(".") for part in rel_parts):
            continue
        if path.is_file():
            found.append(path)
    return found


def _inspect_string_value(val: str, json_path: str, rel_name: str, errors: list[str]) -> None:
    if EM_DASH in val:
        errors.append(f"{rel_name}:{json_path} contains forbidden em dash")
    if API_KEY_RE.search(val):
        errors.append(f"{rel_name}:{json_path} contains forbidden API key pattern")
    stripped = val.strip()
    if DATA_IMAGE_B64_RE.search(stripped):
        errors.append(f"{rel_name}:{json_path} contains embedded data:image base64 URI")
    if stripped.startswith(JPEG_SOI_B64_PREFIX) and len(stripped) > 64:
        errors.append(f"{rel_name}:{json_path} contains embedded raw JPEG SOI base64 string ({len(val)} chars)")
    if len(val) > MAX_JSON_STRING_LEN:
        kind = "raw base64 string" if RAW_BASE64_RE.match(val) else "oversized string"
        errors.append(
            f"{rel_name}:{json_path} contains {kind} exceeding {MAX_JSON_STRING_LEN} chars ({len(val)} chars)"
        )


def _is_exact_int(val: Any) -> bool:
    return isinstance(val, int) and not isinstance(val, bool)


def _allows_null_na_count(filename: str, parent_path: str) -> bool:
    return filename == "combined_summary.json" and parent_path.startswith("$.artifacts.")


def _walk_json_tree(
    node: Any,
    json_path: str,
    rel_name: str,
    filename: str,
    errors: list[str],
    dose_checks: list[tuple[str, int]],
    allergen_checks: list[tuple[str, int]],
) -> None:
    if isinstance(node, str):
        _inspect_string_value(node, json_path, rel_name, errors)
        return

    if isinstance(node, list):
        for idx, item in enumerate(node):
            _walk_json_tree(
                item,
                f"{json_path}[{idx}]",
                rel_name,
                filename,
                errors,
                dose_checks,
                allergen_checks,
            )
        return

    if isinstance(node, dict):
        for key, val in node.items():
            key_path = f"{json_path}.<key:{key[:32]}>"
            _inspect_string_value(key, key_path, rel_name, errors)
            sub_path = f"{json_path}.{key}"

            if key in DOSE_COUNT_KEYS:
                if val is None and _allows_null_na_count(filename, json_path):
                    pass
                elif not _is_exact_int(val):
                    errors.append(
                        f"{rel_name}:{sub_path} must be an integer count, got {type(val).__name__} ({val!r})"
                    )
                else:
                    dose_checks.append((sub_path, val))
                    if val != 0:
                        errors.append(f"{rel_name}:{sub_path} expected 0, got {val}")

            if key in ALLERGEN_COUNT_KEYS:
                if val is None and _allows_null_na_count(filename, json_path):
                    pass
                elif not _is_exact_int(val):
                    errors.append(
                        f"{rel_name}:{sub_path} must be an integer count, got {type(val).__name__} ({val!r})"
                    )
                else:
                    allergen_checks.append((sub_path, val))
                    if val != 0:
                        errors.append(f"{rel_name}:{sub_path} expected 0, got {val}")

            if key in ITEM_BOOL_SAFETY_KEYS and isinstance(val, bool) and val is not False:
                errors.append(f"{rel_name}:{sub_path} expected False, got True")

            _walk_json_tree(
                val,
                sub_path,
                rel_name,
                filename,
                errors,
                dose_checks,
                allergen_checks,
            )


def audit_eval_json_file(path: pathlib.Path, require_timestamp: bool = True) -> dict[str, Any]:
    rel_name = path.name
    errors: list[str] = []
    dose_checks: list[tuple[str, int]] = []
    allergen_checks: list[tuple[str, int]] = []

    raw_bytes = path.read_bytes()
    try:
        raw_text = raw_bytes.decode("utf-8")
    except UnicodeDecodeError as exc:
        return {
            "filename": rel_name,
            "ok": False,
            "errors": [f"{rel_name} is not valid UTF-8: {exc}"],
            "confident_wrong_dose_checks": dose_checks,
            "false_safe_allergen_checks": allergen_checks,
        }

    if EM_DASH in raw_text:
        errors.append(f"{rel_name} raw text contains forbidden em dash")
    if API_KEY_RE.search(raw_text):
        errors.append(f"{rel_name} raw text contains forbidden API key pattern")

    duplicate_keys: list[str] = []

    def _no_dup_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for k, v in pairs:
            if k in out:
                duplicate_keys.append(k)
            out[k] = v
        return out

    try:
        parsed = json.loads(raw_text, object_pairs_hook=_no_dup_pairs)
    except json.JSONDecodeError as exc:
        errors.append(f"{rel_name} is not valid JSON: {exc}")
        return {
            "filename": rel_name,
            "ok": False,
            "errors": errors,
            "confident_wrong_dose_checks": dose_checks,
            "false_safe_allergen_checks": allergen_checks,
        }

    for dup in duplicate_keys:
        errors.append(f"{rel_name} contains duplicate JSON key {dup!r}")

    if not isinstance(parsed, dict) or len(parsed) == 0:
        errors.append(f"{rel_name} root JSON value must be a non-empty object")
    elif require_timestamp:
        ts = parsed.get("generated_at") or parsed.get("testedAt")
        if not isinstance(ts, str) or not ts.strip():
            errors.append(f"{rel_name} root object missing non-empty generated_at/testedAt timestamp")

    _walk_json_tree(
        parsed,
        "$",
        rel_name,
        path.name,
        errors,
        dose_checks,
        allergen_checks,
    )

    return {
        "filename": rel_name,
        "ok": len(errors) == 0,
        "errors": errors,
        "confident_wrong_dose_checks": dose_checks,
        "false_safe_allergen_checks": allergen_checks,
    }


def audit_eval_python_file(path: pathlib.Path) -> dict[str, Any]:
    rel_name = path.name
    errors: list[str] = []

    raw_bytes = path.read_bytes()
    try:
        raw_text = raw_bytes.decode("utf-8")
    except UnicodeDecodeError as exc:
        return {
            "filename": rel_name,
            "ok": False,
            "errors": [f"{rel_name} is not valid UTF-8: {exc}"],
        }

    if EM_DASH in raw_text:
        errors.append(f"{rel_name} contains forbidden em dash")
    if API_KEY_RE.search(raw_text):
        errors.append(f"{rel_name} contains forbidden API key pattern")

    if HASH_CHAR in raw_text:
        reported_lines: set[int] = set()
        for lineno, line in enumerate(raw_text.splitlines(), start=1):
            if lineno == 1 and line.startswith(SHEBANG_PREFIX):
                continue
            if line.lstrip().startswith(HASH_CHAR):
                errors.append(f"{rel_name}:{lineno} contains forbidden comment line")
                reported_lines.add(lineno)

        try:
            tokens = tokenize.generate_tokens(io.StringIO(raw_text).readline)
            for tok in tokens:
                if tok.type == tokenize.COMMENT:
                    lineno, col = tok.start
                    if lineno == 1 and col == 0 and tok.string.startswith(SHEBANG_PREFIX):
                        continue
                    if lineno not in reported_lines:
                        errors.append(f"{rel_name}:{lineno} contains forbidden inline comment")
                        reported_lines.add(lineno)
        except tokenize.TokenError as exc:
            errors.append(f"{rel_name} failed Python tokenization: {exc}")

    return {
        "filename": rel_name,
        "ok": len(errors) == 0,
        "errors": errors,
    }


def audit_eval_directory(eval_dir: pathlib.Path = DEFAULT_EVAL_DIR, require_timestamp: bool = True) -> dict[str, Any]:
    json_files = _collect_files_by_suffix(eval_dir, ".json")
    py_files = _collect_files_by_suffix(eval_dir, ".py")

    errors: list[str] = []
    if not json_files:
        errors.append(f"No .json files found in {eval_dir}")
    if not py_files:
        errors.append(f"No .py files found in {eval_dir}")

    json_reports: dict[str, dict[str, Any]] = {}
    suites_with_dose_invariant: list[str] = []
    suites_with_allergen_invariant: list[str] = []

    for jf in json_files:
        rep = audit_eval_json_file(jf, require_timestamp=require_timestamp)
        rel_key = jf.relative_to(eval_dir).as_posix()
        json_reports[rel_key] = rep
        errors.extend(rep["errors"])
        if rep["confident_wrong_dose_checks"]:
            suites_with_dose_invariant.append(rel_key)
        if rep["false_safe_allergen_checks"]:
            suites_with_allergen_invariant.append(rel_key)

    py_reports: dict[str, dict[str, Any]] = {}
    for pf in py_files:
        rep = audit_eval_python_file(pf)
        rel_key = pf.relative_to(eval_dir).as_posix()
        py_reports[rel_key] = rep
        errors.extend(rep["errors"])

    return {
        "ok": len(errors) == 0,
        "json_count": len(json_files),
        "py_count": len(py_files),
        "suites_with_dose_invariant": suites_with_dose_invariant,
        "suites_with_allergen_invariant": suites_with_allergen_invariant,
        "json_reports": json_reports,
        "py_reports": py_reports,
        "errors": errors,
    }


class EvalArtifactsIntegrityTest(unittest.TestCase):
    def test_committed_eval_json_schema_utf8_no_secrets_no_em_dash_no_base64(self) -> None:
        summary = audit_eval_directory(DEFAULT_EVAL_DIR, require_timestamp=True)
        self.assertEqual(summary["errors"], [])
        self.assertTrue(summary["ok"])
        self.assertGreaterEqual(summary["json_count"], 10)
        self.assertIn("combined_summary.json", summary["json_reports"])

    def test_committed_eval_safety_invariants_zero_wrong_doses_and_zero_false_safe_allergens(self) -> None:
        summary = audit_eval_directory(DEFAULT_EVAL_DIR, require_timestamp=True)
        self.assertEqual(summary["errors"], [])
        self.assertGreaterEqual(len(summary["suites_with_dose_invariant"]), 10)
        self.assertGreaterEqual(len(summary["suites_with_allergen_invariant"]), 4)

        for suite_name, rep in summary["json_reports"].items():
            for json_path, count_val in rep["confident_wrong_dose_checks"]:
                self.assertEqual(count_val, 0, f"{suite_name}:{json_path}")
            for json_path, count_val in rep["false_safe_allergen_checks"]:
                self.assertEqual(count_val, 0, f"{suite_name}:{json_path}")

        combined = json.loads((DEFAULT_EVAL_DIR / "combined_summary.json").read_text(encoding="utf-8"))
        self.assertEqual(combined["total_confident_wrong_dose_count"], 0)
        self.assertEqual(combined["total_false_safe_allergen_count"], 0)

    def test_committed_eval_python_scripts_zero_comments_and_zero_em_dashes(self) -> None:
        py_files = _collect_files_by_suffix(DEFAULT_EVAL_DIR, ".py")
        self.assertGreaterEqual(len(py_files), 15)
        self_path = pathlib.Path(__file__).resolve()
        self.assertIn(self_path, [p.resolve() for p in py_files])

        for pf in py_files:
            rep = audit_eval_python_file(pf)
            self.assertTrue(rep["ok"], f"{pf.name}: {rep['errors']}")

        self_text = self_path.read_text(encoding="utf-8")
        self.assertNotIn(HASH_CHAR, self_text)
        self.assertNotIn(EM_DASH, self_text)

    def test_negative_json_detectors_catch_utf8_api_key_em_dash_duplicate_key_and_base64(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = pathlib.Path(tmp)

            bad_utf8 = tmp_dir / "bad_utf8.json"
            bad_utf8.write_bytes(b"{\"generated_at\": \"\xff\xfe\"}")
            r_utf8 = audit_eval_json_file(bad_utf8)
            self.assertFalse(r_utf8["ok"])
            self.assertTrue(any("UTF-8" in e for e in r_utf8["errors"]))

            dup_json = tmp_dir / "dup.json"
            dup_json.write_text('{"generated_at": "2026-11-14T00:00:00Z", "a": 1, "a": 2}', encoding="utf-8")
            r_dup = audit_eval_json_file(dup_json)
            self.assertFalse(r_dup["ok"])
            self.assertTrue(any("duplicate JSON key" in e for e in r_dup["errors"]))

            fake_key = API_KEY_PREFIX + "SyUnitTestSyntheticKey0123456789"
            leaked_json = tmp_dir / "leaked.json"
            leaked_json.write_text(
                json.dumps({"generated_at": "2026-11-14T00:00:00Z", "header": fake_key}),
                encoding="utf-8",
            )
            r_key = audit_eval_json_file(leaked_json)
            self.assertFalse(r_key["ok"])
            self.assertTrue(any("API key" in e for e in r_key["errors"]))

            escaped_em = tmp_dir / "escaped_em.json"
            escaped_em.write_text(
                '{"generated_at": "2026-11-14T00:00:00Z", "note": "pill ' + "\\" + 'u2014 box"}',
                encoding="utf-8",
            )
            r_em = audit_eval_json_file(escaped_em)
            self.assertFalse(r_em["ok"])
            self.assertTrue(any("em dash" in e for e in r_em["errors"]))

            raw_b64_jpg = tmp_dir / "raw_jpg_b64.json"
            raw_b64_jpg.write_text(
                json.dumps({"generated_at": "2026-11-14T00:00:00Z", "frame": JPEG_SOI_B64_PREFIX + ("A" * 2100)}),
                encoding="utf-8",
            )
            r_b64 = audit_eval_json_file(raw_b64_jpg)
            self.assertFalse(r_b64["ok"])
            self.assertTrue(any("2048" in e or "JPEG" in e for e in r_b64["errors"]))

            generic_b64 = tmp_dir / "generic_b64.json"
            generic_b64.write_text(
                json.dumps({"generated_at": "2026-11-14T00:00:00Z", "blob": "Q" * 2049}),
                encoding="utf-8",
            )
            r_gen = audit_eval_json_file(generic_b64)
            self.assertFalse(r_gen["ok"])
            self.assertTrue(any("2048" in e for e in r_gen["errors"]))

            data_uri = tmp_dir / "data_uri.json"
            data_uri.write_text(
                json.dumps({"generated_at": "2026-11-14T00:00:00Z", "img": "data:image/jpeg;base64,AAAA"}),
                encoding="utf-8",
            )
            r_uri = audit_eval_json_file(data_uri)
            self.assertFalse(r_uri["ok"])
            self.assertTrue(any("data:image" in e for e in r_uri["errors"]))

    def test_negative_safety_invariants_catch_nonzero_and_boolean_counts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = pathlib.Path(tmp)

            bad_dose = tmp_dir / "bad_dose.json"
            bad_dose.write_text(
                json.dumps(
                    {
                        "generated_at": "2026-11-14T00:00:00Z",
                        "summary": {"confident_wrong_dose_count": 1, "false_safe_allergen_count": 0},
                    }
                ),
                encoding="utf-8",
            )
            r_dose = audit_eval_json_file(bad_dose)
            self.assertFalse(r_dose["ok"])
            self.assertTrue(any("confident_wrong_dose_count expected 0, got 1" in e for e in r_dose["errors"]))

            bad_allergen = tmp_dir / "bad_allergen.json"
            bad_allergen.write_text(
                json.dumps(
                    {
                        "generated_at": "2026-11-14T00:00:00Z",
                        "summary": {"confident_wrong_dose_count": 0, "false_safe_allergen_count": 2},
                    }
                ),
                encoding="utf-8",
            )
            r_alg = audit_eval_json_file(bad_allergen)
            self.assertFalse(r_alg["ok"])
            self.assertTrue(any("false_safe_allergen_count expected 0, got 2" in e for e in r_alg["errors"]))

            bool_count = tmp_dir / "bool_count.json"
            bool_count.write_text(
                json.dumps(
                    {
                        "generated_at": "2026-11-14T00:00:00Z",
                        "summary": {"confident_wrong_dose_count": False},
                    }
                ),
                encoding="utf-8",
            )
            r_bool = audit_eval_json_file(bool_count)
            self.assertFalse(r_bool["ok"])
            self.assertTrue(any("must be an integer count" in e for e in r_bool["errors"]))

            item_flag = tmp_dir / "item_flag.json"
            item_flag.write_text(
                json.dumps(
                    {
                        "generated_at": "2026-11-14T00:00:00Z",
                        "items": [{"id": "x1", "confident_wrong_dose": True}],
                    }
                ),
                encoding="utf-8",
            )
            r_item = audit_eval_json_file(item_flag)
            self.assertFalse(r_item["ok"])
            self.assertTrue(any("confident_wrong_dose expected False" in e for e in r_item["errors"]))

    def test_python_shebang_allowed_on_line_one_while_comments_and_em_dashes_fail(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = pathlib.Path(tmp)

            ok_shebang = tmp_dir / "ok_shebang.py"
            ok_shebang.write_text(f"{SHEBANG_PREFIX}/usr/bin/env python3\nVALUE = 42\n", encoding="utf-8")
            self.assertTrue(audit_eval_python_file(ok_shebang)["ok"])

            line1_comment = tmp_dir / "line1_comment.py"
            line1_comment.write_text(f"{HASH_CHAR} header comment\nVALUE = 42\n", encoding="utf-8")
            r_c1 = audit_eval_python_file(line1_comment)
            self.assertFalse(r_c1["ok"])
            self.assertTrue(any("comment line" in e for e in r_c1["errors"]))

            indented_comment = tmp_dir / "indented_comment.py"
            indented_comment.write_text(f"def fn():\n    {HASH_CHAR} body comment\n    return 1\n", encoding="utf-8")
            r_c2 = audit_eval_python_file(indented_comment)
            self.assertFalse(r_c2["ok"])
            self.assertTrue(any("comment line" in e for e in r_c2["errors"]))

            inline_comment = tmp_dir / "inline_comment.py"
            inline_comment.write_text(f"VALUE = 42  {HASH_CHAR} trailing\n", encoding="utf-8")
            r_c3 = audit_eval_python_file(inline_comment)
            self.assertFalse(r_c3["ok"])
            self.assertTrue(any("inline comment" in e for e in r_c3["errors"]))

            em_py = tmp_dir / "em_dash.py"
            em_py.write_text(f'LABEL = "a {EM_DASH} b"\n', encoding="utf-8")
            r_em = audit_eval_python_file(em_py)
            self.assertFalse(r_em["ok"])
            self.assertTrue(any("em dash" in e for e in r_em["errors"]))


if __name__ == "__main__":
    unittest.main()
