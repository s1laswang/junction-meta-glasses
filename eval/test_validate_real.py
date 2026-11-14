import contextlib
import io
import json
import pathlib
import sys
import tempfile
import unittest

from PIL import Image

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from eval.validate_real_labels import (
    DEFAULT_CSV_PATH,
    DEFAULT_REAL_DIR,
    EXPECTED_COLUMNS,
    GPS_EXIF_TAG,
    evaluate_real_labels,
    main,
    strip_exif_in_place,
    validate_csv,
)


def _write_synthetic_jpeg_with_gps(path: pathlib.Path, size: tuple[int, int] = (320, 200)) -> None:
    img = Image.new("RGB", size, (235, 240, 245))
    exif = Image.Exif()
    exif[0x010F] = "SyntheticPhone"
    exif[0x0110] = "ModelX"
    exif[0x0112] = 6
    exif[0x013B] = "Patient Jane Doe"
    exif[GPS_EXIF_TAG] = {
        1: "N",
        2: (60.0, 10.0, 15.0),
        3: "E",
        4: (24.0, 56.0, 12.0),
    }
    img.save(path, format="JPEG", quality=90, exif=exif.tobytes())


class ValidateRealLabelsTest(unittest.TestCase):
    def test_repo_labels_csv_valid(self) -> None:
        summary = validate_csv(str(DEFAULT_CSV_PATH), str(DEFAULT_REAL_DIR))
        self.assertTrue(summary["header_valid"])
        self.assertEqual(summary["columns"], EXPECTED_COLUMNS)
        self.assertTrue(summary["exif_clean"])
        self.assertTrue(summary["gps_clean"])
        self.assertEqual(summary["invalid_images"], [])
        self.assertEqual(summary["row_errors"], [])
        if summary["images_present"] == 0:
            self.assertEqual(summary["status"], "ready_for_photos")
        else:
            self.assertEqual(summary["status"], "ok")

    def test_zero_rows_ready_for_photos_and_cli_exit_zero(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = pathlib.Path(tmp)
            csv_path = tmp_dir / "labels.csv"
            csv_path.write_text(",".join(EXPECTED_COLUMNS) + "\n", encoding="utf-8")

            summary = validate_csv(str(csv_path), str(tmp_dir))
            self.assertTrue(summary["header_valid"])
            self.assertEqual(summary["rows"], 0)
            self.assertEqual(summary["images_present"], 0)
            self.assertTrue(summary["exif_clean"])
            self.assertEqual(summary["status"], "ready_for_photos")

            out_buf = io.StringIO()
            with contextlib.redirect_stdout(out_buf):
                code = main(["--csv", str(csv_path), "--real-dir", str(tmp_dir)])
            self.assertEqual(code, 0)
            cli_json = json.loads(out_buf.getvalue())
            self.assertEqual(cli_json["rows"], 0)
            self.assertEqual(cli_json["images_present"], 0)
            self.assertTrue(cli_json["exif_clean"])
            self.assertEqual(cli_json["status"], "ready_for_photos")

    def test_synthetic_gps_exif_detected_and_strip_in_place(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = pathlib.Path(tmp)
            jpg_path = tmp_dir / "amlodipine_gps.jpg"
            png_path = tmp_dir / "oat_milk.png"
            _write_synthetic_jpeg_with_gps(jpg_path, size=(320, 200))
            Image.new("RGB", (240, 180), (210, 220, 200)).save(png_path, format="PNG")

            csv_path = tmp_dir / "labels.csv"
            csv_lines = [
                ",".join(EXPECTED_COLUMNS),
                "amlodipine_gps.jpg,medication,Amlodipin Orion,amlodipine,5 mg,2027-03,,front of box",
                "oat_milk.png,food,Oat Drink,oat drink,,2026-12,gluten,carton panel",
            ]
            csv_path.write_text("\n".join(csv_lines) + "\n", encoding="utf-8")

            before = validate_csv(str(csv_path), str(tmp_dir))
            self.assertTrue(before["header_valid"])
            self.assertEqual(before["rows"], 2)
            self.assertEqual(before["images_present"], 2)
            self.assertFalse(before["gps_clean"])
            self.assertFalse(before["exif_clean"])
            self.assertEqual(before["gps_leaks"], ["amlodipine_gps.jpg"])
            self.assertEqual(before["exif_leaks"], ["amlodipine_gps.jpg"])
            self.assertEqual(before["status"], "exif_dirty")

            strip_result = strip_exif_in_place(jpg_path)
            self.assertTrue(strip_result["stripped"])
            self.assertEqual((strip_result["width"], strip_result["height"]), (200, 320))

            with Image.open(jpg_path) as cleaned_img:
                cleaned_exif = cleaned_img.getexif()
                self.assertEqual(len(cleaned_exif), 0)
                self.assertNotIn(GPS_EXIF_TAG, cleaned_exif)
                self.assertEqual(cleaned_exif.get_ifd(GPS_EXIF_TAG), {})

            after = validate_csv(str(csv_path), str(tmp_dir))
            self.assertEqual(after["rows"], 2)
            self.assertEqual(after["images_present"], 2)
            self.assertTrue(after["gps_clean"])
            self.assertTrue(after["exif_clean"])
            self.assertEqual(after["gps_leaks"], [])
            self.assertEqual(after["exif_leaks"], [])
            self.assertEqual(after["status"], "ok")

    def test_invalid_header_corrupt_image_and_cli_strip_flag(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = pathlib.Path(tmp)
            bad_csv = tmp_dir / "bad.csv"
            bad_csv.write_text("filename,type\nx.jpg,medication\n", encoding="utf-8")
            bad_summary = validate_csv(str(bad_csv), str(tmp_dir))
            self.assertFalse(bad_summary["header_valid"])
            self.assertEqual(bad_summary["status"], "invalid_schema")

            out_bad = io.StringIO()
            with contextlib.redirect_stdout(out_bad):
                bad_code = main(["--csv", str(bad_csv), "--real-dir", str(tmp_dir)])
            self.assertEqual(bad_code, 1)

            corrupt_jpg = tmp_dir / "corrupt.jpg"
            corrupt_jpg.write_bytes(b"not-a-valid-jpeg")
            corrupt_csv = tmp_dir / "corrupt.csv"
            corrupt_csv.write_text(
                ",".join(EXPECTED_COLUMNS) + "\ncorrupt.jpg,medication,Test,amlodipine,5 mg,2027-03,,broken\n",
                encoding="utf-8",
            )
            corrupt_summary = validate_csv(str(corrupt_csv), str(tmp_dir))
            self.assertEqual(corrupt_summary["invalid_images"], ["corrupt.jpg"])
            self.assertEqual(corrupt_summary["status"], "invalid_data")

            fix_jpg = tmp_dir / "fixme.jpg"
            _write_synthetic_jpeg_with_gps(fix_jpg, size=(160, 120))
            fix_csv = tmp_dir / "labels.csv"
            fix_csv.write_text(
                ",".join(EXPECTED_COLUMNS) + "\nfixme.jpg,medication,Burana,ibuprofen,400 mg,2027-11,,front\n",
                encoding="utf-8",
            )
            out_fix = io.StringIO()
            with contextlib.redirect_stdout(out_fix):
                fix_code = main(["--csv", str(fix_csv), "--real-dir", str(tmp_dir), "--strip-exif"])
            self.assertEqual(fix_code, 0)
            fix_payload = json.loads(out_fix.getvalue())
            self.assertTrue(fix_payload["exif_clean"])
            self.assertEqual(fix_payload["stripped_files"], ["fixme.jpg"])
            self.assertEqual(fix_payload["status"], "ok")

    def test_optional_eval_with_mock_runner(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = pathlib.Path(tmp)
            jpg_path = tmp_dir / "pill.jpg"
            _write_synthetic_jpeg_with_gps(jpg_path, size=(200, 200))
            csv_path = tmp_dir / "labels.csv"
            csv_path.write_text(
                ",".join(EXPECTED_COLUMNS) + "\npill.jpg,medication,Amlodipin,amlodipine,5 mg,2027-08,,front\n",
                encoding="utf-8",
            )

            blocked = evaluate_real_labels(str(csv_path), str(tmp_dir), call_fn=lambda *_: ({}, 1.0))
            self.assertEqual(blocked["status"], "blocked_exif_dirty")

            strip_exif_in_place(jpg_path)

            def fake_call(model: str, mime: str, b64: str, prompt: str, schema: dict) -> tuple[dict, float]:
                self.assertEqual(model, "gemini-3.8-flash")
                self.assertEqual(mime, "image/jpeg")
                self.assertTrue(len(b64) > 20)
                self.assertIn("product", schema["properties"])
                return (
                    {
                        "kind": "medication",
                        "product": {"value": "Amlodipin", "confidence": 0.96},
                        "ingredient": {"value": "amlodipine", "confidence": 0.95},
                        "strength": {"value": "5 mg", "confidence": 0.94},
                        "dosing": {"value": None, "confidence": 0.1},
                        "expiry": {"value": "2027-08", "confidence": 0.9},
                        "allergens": {"value": None, "confidence": 0.1},
                        "barcode": {"value": None, "confidence": 0.1},
                        "readability": 0.92,
                    },
                    12.5,
                )

            eval_res = evaluate_real_labels(str(csv_path), str(tmp_dir), call_fn=fake_call)
            self.assertEqual(eval_res["status"], "ok")
            self.assertEqual(eval_res["evaluated"], 1)
            self.assertEqual(eval_res["kind_accuracy"], 1.0)
            self.assertEqual(eval_res["strength_accuracy"], 1.0)
            self.assertEqual(eval_res["confident_wrong_strength_count"], 0)


if __name__ == "__main__":
    unittest.main()
