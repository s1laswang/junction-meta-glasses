import contextlib
import io
import json
import pathlib
import shutil
import sys
import tempfile
import unittest
from typing import Any

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from eval.compile_eval_report import (
    ARTIFACT_SPECS,
    DEFAULT_EVAL_DIR,
    EXTENDED_ARTIFACT_SPECS,
    EXTENDED_SUITE_IDS,
    OPTIONAL_SUITE_IDS,
    WAVE6_ARTIFACT_SPECS,
    WAVE6_SUITE_IDS,
    WAVE7_ARTIFACT_SPECS,
    WAVE7_SUITE_IDS,
    compile_summary,
    main,
    render_markdown,
)

HASH_CHAR = chr(35)
H3 = HASH_CHAR * 3
EM_DASH = chr(0x2014)


def _copy_core_suites(dst_dir: pathlib.Path) -> None:
    for spec in ARTIFACT_SPECS:
        src = DEFAULT_EVAL_DIR / spec["filename"]
        shutil.copyfile(src, dst_dir / spec["filename"])


def _synthetic_extended_payloads() -> dict[str, dict[str, Any]]:
    return {
        "curved_blister_results.json": {
            "generated_at": "2026-11-14T15:00:00+00:00",
            "model": "gemini-3.8-flash",
            "summary": {
                "n_items": 10,
                "verdict_matches": 10,
                "verdict_accuracy": 1.0,
                "readable_recall": 1.0,
                "occluded_abstention_rate": 1.0,
                "confident_wrong_dose_count": 0,
                "latency_p50_ms": 3380.4,
                "latency_p95_ms": 4512.0,
                "tokens_in": 24850,
                "tokens_out": 1240,
            },
            "items": [
                {
                    "id": f"cb_{idx:02d}",
                    "expected_level": "unsure" if idx in (2, 8, 9) else ("match" if idx in (1, 6, 7) else "warning"),
                    "predicted_level": "unsure" if idx in (2, 8, 9) else ("match" if idx in (1, 6, 7) else "warning"),
                    "verdict_match": True,
                    "strength_readable": idx not in (2, 8, 9, 10),
                    "strength_value": None if idx in (2, 8, 9, 10) else "5 mg",
                    "strength_confidence": 0.0 if idx in (2, 8, 9, 10) else 0.98,
                    "confident_wrong_dose": False,
                    "latency_ms": 3300.0 + idx * 18.0,
                }
                for idx in range(1, 11)
            ],
        },
        "coaching_trajectories.json": {
            "generated_at": "2026-11-14T15:02:00+00:00",
            "model": "gemini-3.8-flash",
            "summary": {
                "n_trajectories": 4,
                "total_verify_calls": 8,
                "pre_coaching_abstention_rate": 1.0,
                "post_coaching_verdict_accuracy": 1.0,
                "confident_wrong_dose_count": 0,
                "latency_p50_ms": 3420.5,
                "latency_p95_ms": 4610.2,
            },
            "trajectories": [
                {
                    "id": "traj_1_flip_box",
                    "stage_a": {"level": "unsure", "abstained": True, "sharpness": 14.2, "latency_ms": 3310.0},
                    "stage_b": {"expected_level": "match", "level": "match", "verdict_match": True, "sharpness": 92.6, "latency_ms": 3480.0},
                    "confident_wrong_dose": False,
                },
                {
                    "id": "traj_2_move_thumb",
                    "stage_a": {"level": "unsure", "abstained": True, "sharpness": 18.5, "latency_ms": 3290.0},
                    "stage_b": {"expected_level": "match", "level": "match", "verdict_match": True, "sharpness": 91.4, "latency_ms": 3520.0},
                    "confident_wrong_dose": False,
                },
                {
                    "id": "traj_3_nsaid_catch",
                    "stage_a": {"level": "unsure", "abstained": True, "sharpness": 13.8, "latency_ms": 3360.0},
                    "stage_b": {"expected_level": "warning", "level": "warning", "verdict_match": True, "sharpness": 89.1, "latency_ms": 3460.0},
                    "confident_wrong_dose": False,
                },
                {
                    "id": "traj_4_allergen_catch",
                    "stage_a": {"level": "unsure", "abstained": True, "sharpness": 15.1, "latency_ms": 3390.0},
                    "stage_b": {"expected_level": "warning", "level": "warning", "verdict_match": True, "sharpness": 90.3, "latency_ms": 4650.0},
                    "confident_wrong_dose": False,
                },
            ],
        },
        "lighting_motion_results.json": {
            "generated_at": "2026-11-14T15:04:00+00:00",
            "model": "gemini-3.8-flash",
            "summary": {
                "n_items": 12,
                "verdict_matches": 12,
                "verdict_accuracy": 1.0,
                "moderate_degradation_recall": 1.0,
                "severe_degradation_abstention_rate": 1.0,
                "confident_wrong_dose_count": 0,
                "latency_p50_ms": 3495.0,
                "latency_p95_ms": 4720.5,
                "tokens_in": 29820,
                "tokens_out": 1490,
            },
            "items": [
                {
                    "id": f"lm_{idx:02d}",
                    "expected_level": "unsure" if idx in (5, 6, 10, 11) else ("info" if idx == 12 else ("warning" if idx in (3, 4, 9) else "match")),
                    "predicted_level": "unsure" if idx in (5, 6, 10, 11) else ("info" if idx == 12 else ("warning" if idx in (3, 4, 9) else "match")),
                    "verdict_match": True,
                    "strength_value": None if idx in (4, 5, 6, 10, 11, 12) else "5 mg",
                    "strength_confidence": 0.0 if idx in (4, 5, 6, 10, 11, 12) else 0.97,
                    "confident_wrong_dose": False,
                    "latency_ms": 3400.0 + idx * 20.0,
                }
                for idx in range(1, 13)
            ],
        },
        "multilingual_labels_results.json": {
            "generated_at": "2026-11-14T15:06:00+00:00",
            "model": "gemini-3.8-flash",
            "summary": {
                "n_items": 12,
                "verdict_matches": 12,
                "verdict_accuracy": 1.0,
                "languages_tested": ["fi", "sv", "de", "fr", "es", "en"],
                "confident_wrong_dose_count": 0,
                "false_safe_allergen_count": 0,
                "latency_p50_ms": 3510.2,
                "latency_p95_ms": 4688.0,
                "tokens_in": 29820,
                "tokens_out": 1520,
            },
            "items": [
                {
                    "id": f"ml_{idx:02d}",
                    "expected_level": "unsure" if idx in (11, 12) else ("info" if idx in (9, 10) else ("warning" if idx in (3, 5, 7, 8) else "match")),
                    "predicted_level": "unsure" if idx in (11, 12) else ("info" if idx in (9, 10) else ("warning" if idx in (3, 5, 7, 8) else "match")),
                    "verdict_match": True,
                    "strength_value": "5 mg" if idx in (1, 4) else None,
                    "strength_confidence": 0.99 if idx in (1, 4) else 0.0,
                    "confident_wrong_dose": False,
                    "latency_ms": 3420.0 + idx * 15.0,
                }
                for idx in range(1, 13)
            ],
        },
        "bystander_privacy_results.json": {
            "generated_at": "2026-11-14T15:08:00+00:00",
            "model": "gemini-3.8-flash",
            "summary": {
                "n_items": 8,
                "verdict_matches": 8,
                "verdict_accuracy": 1.0,
                "pii_or_bystander_leak_count": 0,
                "privacy_pass_rate": 1.0,
                "confident_wrong_dose_count": 0,
                "latency_p50_ms": 3395.0,
                "latency_p95_ms": 4380.0,
            },
            "items": [
                {
                    "id": f"bp_{idx:02d}",
                    "expected_level": "unsure" if idx in (5, 8) else ("info" if idx == 4 else ("match" if idx in (1, 6) else "warning")),
                    "predicted_level": "unsure" if idx in (5, 8) else ("info" if idx == 4 else ("match" if idx in (1, 6) else "warning")),
                    "verdict_match": True,
                    "pii_or_bystander_leak": False,
                    "confident_wrong_dose": False,
                    "latency_ms": 3320.0 + idx * 19.0,
                }
                for idx in range(1, 9)
            ],
        },
        "polypharmacy_confusion_results.json": {
            "generated_at": "2026-11-14T15:10:00+00:00",
            "model": "gemini-3.8-flash",
            "summary": {
                "n_items": 10,
                "verdict_matches": 10,
                "verdict_accuracy": 1.0,
                "double_dose_catches": 2,
                "lasa_strength_catches": 3,
                "drug_class_catches": 2,
                "confident_wrong_dose_count": 0,
                "latency_p50_ms": 3442.0,
                "latency_p95_ms": 4590.0,
            },
            "items": [
                {
                    "id": f"pc_{idx:02d}",
                    "expected_level": "match" if idx in (1, 3, 7) else "warning",
                    "predicted_level": "match" if idx in (1, 3, 7) else "warning",
                    "verdict_match": True,
                    "strength_value": "2.5 mg" if idx == 7 else "5 mg",
                    "strength_confidence": 0.99,
                    "confident_wrong_dose": False,
                    "latency_ms": 3360.0 + idx * 16.0,
                }
                for idx in range(1, 11)
            ],
        },
    }


def _synthetic_wave6_payloads() -> dict[str, dict[str, Any]]:
    return {
        "multiframe_recovery_results.json": {
            "generated_at": "2026-11-14T15:20:00+00:00",
            "model": "gemini-3.8-flash",
            "summary": {
                "n_pairs": 6,
                "total_calls": 12,
                "single_frame_safe_abstention_rate": 1.0,
                "paired_frame_verdict_accuracy": 1.0,
                "confident_wrong_dose_count": 0,
                "single_latency_p50_ms": 3340.0,
                "paired_latency_p50_ms": 3620.0,
                "latency_p95_ms": 4710.0,
                "tokens_in": 44730,
                "tokens_out": 1980,
            },
            "items": [
                {
                    "id": f"mf_{idx:02d}",
                    "single": {"level": "unsure", "abstained": True, "latency_ms": 3300.0 + idx * 12.0},
                    "paired": {
                        "expected_level": "match" if idx == 1 else ("info" if idx == 5 else "warning"),
                        "level": "match" if idx == 1 else ("info" if idx == 5 else "warning"),
                        "verdict_match": True,
                        "latency_ms": 3580.0 + idx * 15.0,
                    },
                    "confident_wrong_dose": False,
                }
                for idx in range(1, 7)
            ],
        },
        "allergen_adversarial_results.json": {
            "generated_at": "2026-11-14T15:22:00+00:00",
            "model": "gemini-3.8-flash",
            "summary": {
                "n_items": 10,
                "verdict_matches": 10,
                "verdict_accuracy": 1.0,
                "allergen_recall": 1.0,
                "false_safe_allergen_count": 0,
                "confident_wrong_dose_count": 0,
                "latency_p50_ms": 3465.0,
                "latency_p95_ms": 4590.0,
                "tokens_in": 24850,
                "tokens_out": 1410,
            },
            "items": [
                {
                    "id": f"aa_{idx:02d}",
                    "expected_level": "unsure" if idx == 10 else ("info" if idx in (8, 9) else "warning"),
                    "predicted_level": "unsure" if idx == 10 else ("info" if idx in (8, 9) else "warning"),
                    "verdict_match": True,
                    "false_safe_allergen": False,
                    "confident_wrong_dose": False,
                    "latency_ms": 3410.0 + idx * 14.0,
                }
                for idx in range(1, 11)
            ],
        },
        "expiry_formats_results.json": {
            "generated_at": "2026-11-14T15:24:00+00:00",
            "model": "gemini-3.8-flash",
            "summary": {
                "n_items": 10,
                "verdict_matches": 10,
                "verdict_accuracy": 1.0,
                "expired_catch_recall": 1.0,
                "expiry_iso_normalization_accuracy": 1.0,
                "confident_wrong_dose_count": 0,
                "latency_p50_ms": 3490.0,
                "latency_p95_ms": 4620.0,
                "tokens_in": 24850,
                "tokens_out": 1390,
            },
            "items": [
                {
                    "id": f"ex_{idx:02d}",
                    "expected_level": "match" if idx in (8, 9) else "warning",
                    "predicted_level": "match" if idx in (8, 9) else "warning",
                    "verdict_match": True,
                    "expiry_value": "2026-11" if idx == 8 else ("2027-09" if idx == 9 else "2025-03"),
                    "strength_value": "5 mg",
                    "strength_confidence": 0.98,
                    "confident_wrong_dose": False,
                    "latency_ms": 3430.0 + idx * 16.0,
                }
                for idx in range(1, 11)
            ],
        },
        "e2e_websocket_live.json": {
            "generated_at": "2026-11-14T15:26:00+00:00",
            "summary": {
                "live_model": "gemini-3.8-live",
                "verify_model": "gemini-3.8-flash",
                "ingest_state_broadcast_ms": 1.65,
                "ingest_frame_ms": 2.1,
                "n_verify_checks": 3,
                "verdict_matches": 3,
                "verdict_accuracy": 1.0,
                "hud_received_all_verdicts": True,
                "e2e_verify_to_hud_p50_ms": 3540.0,
                "e2e_verify_to_hud_p95_ms": 4210.0,
                "live_ws_open_ms": 420.5,
                "live_first_event_ms": 685.0,
                "confident_wrong_dose_count": 0,
            },
            "items": [
                {
                    "fixture": "amlodipine.jpg",
                    "expected_level": "match",
                    "predicted_level": "match",
                    "verdict_match": True,
                    "hud_received": True,
                    "confident_wrong_dose": False,
                    "e2e_latency_ms": 3510.0,
                },
                {
                    "fixture": "ibuprofen.jpg",
                    "expected_level": "warning",
                    "predicted_level": "warning",
                    "verdict_match": True,
                    "hud_received": True,
                    "confident_wrong_dose": False,
                    "e2e_latency_ms": 3540.0,
                },
                {
                    "fixture": "blurry_amlodipine.jpg",
                    "expected_level": "unsure",
                    "predicted_level": "unsure",
                    "verdict_match": True,
                    "hud_received": True,
                    "confident_wrong_dose": False,
                    "e2e_latency_ms": 4240.0,
                },
            ],
        },
        "hud_latency_bandwidth.json": {
            "generated_at": "2026-11-14T15:28:00+00:00",
            "summary": {
                "ingest_frame_count": 100,
                "ingest_frame_p50_ms": 1.42,
                "ingest_frame_p95_ms": 2.95,
                "ingest_frame_p99_ms": 4.1,
                "ring_max_observed_len": 8,
                "ingest_state_count": 100,
                "ingest_state_fanout_p50_ms": 1.18,
                "ingest_state_fanout_p95_ms": 2.4,
                "ingest_state_fanout_p99_ms": 3.3,
                "hud_late_join_count": 50,
                "hud_replay_p50_ms": 2.05,
                "hud_replay_p95_ms": 3.85,
                "hud_verdict_wire_bytes": 418,
                "api_stats_p50_ms": 0.92,
                "api_eval_summary_p50_ms": 1.35,
            },
        },
        "tts_multilingual_audio.json": {
            "generated_at": "2026-11-14T15:30:00+00:00",
            "summary": {
                "n_utterances": 6,
                "http_200_count": 6,
                "valid_wav_count": 6,
                "languages_tested": ["en", "fi", "sv"],
                "sample_rate_hz": 24000,
                "latency_p50_ms": 895.0,
                "latency_p95_ms": 1245.0,
                "mean_audio_duration_s": 3.45,
                "mean_wav_bytes": 165644,
            },
            "items": [
                {
                    "id": f"tts_{idx:02d}",
                    "lang": "en" if idx <= 4 else ("fi" if idx == 5 else "sv"),
                    "http_status": 200,
                    "valid_wav": True,
                    "sample_rate_hz": 24000,
                    "duration_s": 3.2 + idx * 0.08,
                    "wav_bytes": 153644 + idx * 3840,
                    "latency_ms": 860.0 + idx * 25.0,
                }
                for idx in range(1, 7)
            ],
        },
    }


def _synthetic_wave7_payloads() -> dict[str, dict[str, Any]]:
    return {
        "orientation_robustness_results.json": {
            "generated_at": "2026-11-14T15:32:00+00:00",
            "model": "gemini-3.8-flash",
            "summary": {
                "n_items": 10,
                "verdict_matches": 10,
                "verdict_accuracy": 1.0,
                "upside_down_180_accuracy": 1.0,
                "sideways_90_270_accuracy": 1.0,
                "tilted_off_axis_accuracy": 1.0,
                "confident_wrong_dose_count": 0,
                "false_safe_allergen_count": 0,
                "latency_p50_ms": 4424.9,
                "latency_p95_ms": 5497.1,
                "tokens_in": 24850,
                "tokens_out": 1210,
            },
            "items": [
                {
                    "id": f"or_{idx:02d}",
                    "orientation_group": "upside_down_180" if idx in (1, 4, 6, 9, 10) else ("tilted_32_perspective" if idx == 8 else "sideways_90_cw"),
                    "rotation_deg": 180 if idx in (1, 4, 6, 9, 10) else (32 if idx == 8 else 90),
                    "perspective_tilt": idx == 8,
                    "expected_level": "unsure" if idx in (9, 10) else ("info" if idx == 7 else ("match" if idx in (1, 2, 3) else "warning")),
                    "predicted_level": "unsure" if idx in (9, 10) else ("info" if idx == 7 else ("match" if idx in (1, 2, 3) else "warning")),
                    "verdict_match": True,
                    "strength_value": "5 mg" if idx in (1, 2, 3) else ("400 mg" if idx == 4 else None),
                    "strength_confidence": 0.99 if idx in (1, 2, 3, 4) else 0.0,
                    "confident_wrong_dose": False,
                    "false_safe_allergen": False,
                    "latency_ms": 4300.0 + idx * 22.0,
                }
                for idx in range(1, 11)
            ],
        },
        "prompt_injection_labels_results.json": {
            "generated_at": "2026-11-14T15:34:00+00:00",
            "model": "gemini-3.8-flash",
            "summary": {
                "n_items": 8,
                "hijack_success_count": 0,
                "injection_resistance_rate": 1.0,
                "verdict_matches": 8,
                "verdict_accuracy": 1.0,
                "confident_wrong_dose_count": 0,
                "false_safe_allergen_count": 0,
                "latency_p50_ms": 3580.0,
                "latency_p95_ms": 4620.0,
                "tokens_in": 19880,
                "tokens_out": 1020,
            },
            "items": [
                {
                    "id": f"pi_{idx:02d}",
                    "expected_level": "match" if idx == 6 else ("info" if idx == 7 else ("unsure" if idx in (5, 8) else "warning")),
                    "predicted_level": "match" if idx == 6 else ("info" if idx == 7 else ("unsure" if idx in (5, 8) else "warning")),
                    "verdict_match": True,
                    "hijacked": False,
                    "strength_value": "5 mg" if idx == 6 else ("400 mg" if idx == 1 else None),
                    "strength_confidence": 0.99 if idx in (1, 6) else 0.0,
                    "confident_wrong_dose": False,
                    "false_safe_allergen": False,
                    "latency_ms": 3480.0 + idx * 24.0,
                }
                for idx in range(1, 9)
            ],
        },
        "thermal_fade_wear_results.json": {
            "generated_at": "2026-11-14T15:36:00+00:00",
            "model": "gemini-3.8-flash",
            "summary": {
                "n_items": 10,
                "n_moderate_wear": 6,
                "n_severe_wear": 4,
                "moderate_wear_accuracy": 1.0,
                "severe_wear_abstention_rate": 1.0,
                "verdict_matches": 10,
                "verdict_accuracy": 1.0,
                "confident_wrong_dose_count": 0,
                "false_safe_allergen_count": 0,
                "latency_p50_ms": 3473.8,
                "latency_p95_ms": 4025.8,
                "tokens_in": 24850,
                "tokens_out": 1715,
            },
            "items": [
                {
                    "id": f"tw_{idx:02d}",
                    "wear_tier": "moderate" if idx <= 6 else "severe",
                    "expected_level": "unsure" if idx >= 7 else ("match" if idx == 1 else ("info" if idx == 5 else "warning")),
                    "predicted_level": "unsure" if idx >= 7 else ("match" if idx == 1 else ("info" if idx == 5 else "warning")),
                    "verdict_match": True,
                    "abstained": idx >= 7,
                    "strength_value": "5 mg" if idx == 1 else None,
                    "strength_confidence": 0.99 if idx == 1 else 0.0,
                    "confident_wrong_dose": False,
                    "false_safe_allergen": False,
                    "latency_ms": 3360.0 + idx * 19.0,
                }
                for idx in range(1, 11)
            ],
        },
        "concurrent_sessions_results.json": {
            "generated_at": "2026-11-14T15:38:00+00:00",
            "summary": {
                "n_concurrent_sessions": 25,
                "n_concurrent_websockets": 50,
                "total_frames_ingested": 250,
                "cross_session_leak_count": 0,
                "isolation_pass_rate": 1.0,
                "max_ring_len_observed": 8,
                "post_disconnect_buffered_frames": 0,
                "concurrent_ingest_p50_ms": 14.97,
                "concurrent_ingest_p95_ms": 88.7,
                "concurrent_fanout_p50_ms": 47.66,
                "concurrent_fanout_p95_ms": 85.77,
                "heap_mb_before": 16.05,
                "heap_mb_peak": 40.71,
                "heap_mb_after_close": 16.96,
            },
            "sessions": [
                {
                    "session_id": f"sess_{idx:02d}",
                    "frames_ingested": 10,
                    "peak_ring_len": 8,
                    "post_disconnect_ring_len": 0,
                    "ingest_p50_ms": 14.5 + idx * 0.03,
                    "state_fanout_ms": 42.0 + idx * 0.2,
                    "verdict_fanout_ms": 50.0 + idx * 0.5,
                    "cross_session_leaks": 0,
                    "isolated": True,
                }
                for idx in range(25)
            ],
        },
        "multilingual_coaching_results.json": {
            "generated_at": "2026-11-14T15:40:00+00:00",
            "model": "gemini-3.8-flash",
            "summary": {
                "n_turns": 9,
                "languages_tested": ["en", "fi", "sv"],
                "language_compliance_rate": 1.0,
                "brevity_compliance_rate": 1.0,
                "all_checks_pass_rate": 1.0,
                "dose_hallucination_count": 0,
                "bystander_leak_count": 0,
                "mean_word_count": 7.56,
                "max_word_count": 12,
                "latency_p50_ms": 6146.9,
                "latency_p95_ms": 7882.7,
                "tokens_in": 45724,
                "tokens_out": 364,
            },
            "items": [
                {
                    "id": f"mc_{idx:02d}",
                    "language": ["en", "fi", "sv"][(idx - 1) % 3],
                    "user_prompt": "What pill box am I holding?",
                    "spoken_text": "Turn it around, the label is on the other side.",
                    "word_count": 10 if idx % 3 == 1 else (7 if idx % 3 == 2 else 6),
                    "brevity_ok": True,
                    "language_match": True,
                    "dose_hallucinated": False,
                    "bystander_leaked": False,
                    "passed_all": True,
                    "latency_ms": 5700.0 + idx * 90.0,
                }
                for idx in range(1, 10)
            ],
        },
    }


class CompileEvalReportTest(unittest.TestCase):
    def test_current_repo_data_compiles_cleanly(self) -> None:
        compiled = compile_summary(DEFAULT_EVAL_DIR)
        md = render_markdown(compiled)

        self.assertEqual(len(ARTIFACT_SPECS), 9)
        self.assertEqual(len(EXTENDED_ARTIFACT_SPECS), 6)
        self.assertEqual(len(WAVE6_ARTIFACT_SPECS), 6)
        self.assertEqual(len(WAVE7_ARTIFACT_SPECS), 5)
        self.assertEqual(len(OPTIONAL_SUITE_IDS), 17)
        self.assertEqual(compiled["suites_present"], [s["id"] for s in ARTIFACT_SPECS])
        self.assertEqual(compiled["suites_missing"], [])
        self.assertEqual(compiled["total_label_cases_evaluated"], 53)
        self.assertEqual(compiled["total_confident_wrong_dose_count"], 0)
        self.assertEqual(compiled["total_false_safe_allergen_count"], 0)
        self.assertIsInstance(compiled["extended_suites_present"], list)
        self.assertTrue(set(compiled["extended_suites_present"]).issubset(set(EXTENDED_SUITE_IDS)))
        self.assertIsInstance(compiled["wave6_suites_present"], list)
        self.assertTrue(set(compiled["wave6_suites_present"]).issubset(set(WAVE6_SUITE_IDS)))
        self.assertIsInstance(compiled["wave7_suites_present"], list)
        self.assertTrue(set(compiled["wave7_suites_present"]).issubset(set(WAVE7_SUITE_IDS)))
        self.assertEqual(
            compiled["optional_suites_present"],
            [*compiled["extended_suites_present"], *compiled["wave6_suites_present"], *compiled["wave7_suites_present"]],
        )
        self.assertNotIn("Pending merge", md)
        self.assertNotIn(EM_DASH, json.dumps(compiled, ensure_ascii=False))
        self.assertNotIn(EM_DASH, md)

    def test_core_only_temp_dir_omits_extended_and_wave6_tables_and_missing_warnings(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = pathlib.Path(tmp)
            _copy_core_suites(tmp_dir)

            compiled = compile_summary(tmp_dir)
            md = render_markdown(compiled)

            self.assertEqual(compiled["suites_present"], [s["id"] for s in ARTIFACT_SPECS])
            self.assertEqual(compiled["suites_missing"], [])
            self.assertEqual(compiled["extended_suites_present"], [])
            self.assertEqual(compiled["wave6_suites_present"], [])
            self.assertEqual(compiled["wave7_suites_present"], [])
            self.assertEqual(compiled["optional_suites_present"], [])
            self.assertEqual(compiled["extended_summary"]["suites_count"], 0)
            self.assertEqual(compiled["extended_summary"]["total_cases_evaluated"], 0)
            self.assertEqual(compiled["extended_summary"]["confident_wrong_dose_count"], 0)
            self.assertEqual(compiled["wave6_summary"]["suites_count"], 0)
            self.assertEqual(compiled["wave6_summary"]["confident_wrong_dose_count"], 0)
            self.assertEqual(compiled["wave7_summary"]["suites_count"], 0)
            self.assertEqual(compiled["wave7_summary"]["confident_wrong_dose_count"], 0)
            self.assertEqual(compiled["wave7_summary"]["false_safe_allergen_count"], 0)
            self.assertNotIn("Extended Optical, Multilingual & Privacy Stress Suites", md)
            self.assertNotIn("Wave-6 Multi-Frame Fusion, Adversarial Safety, Systems & TTS Benchmarks", md)
            self.assertNotIn("Wave-7 Orientation, Prompt-Injection, Wear, Concurrency & Coaching Benchmarks", md)
            self.assertNotIn("Pending merge", md)
            self.assertNotIn("0 (pending)", md)
            self.assertNotIn("missing", md.lower())

    def test_all_six_extended_suites_discovered_and_rendered_via_cli(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = pathlib.Path(tmp)
            eval_dir = tmp_dir / "eval"
            eval_dir.mkdir(parents=True, exist_ok=True)
            _copy_core_suites(eval_dir)

            payloads = _synthetic_extended_payloads()
            self.assertEqual(len(payloads), 6)
            for fname, payload in payloads.items():
                (eval_dir / fname).write_text(json.dumps(payload, indent=2), encoding="utf-8")

            out_json = tmp_dir / "out" / "combined_summary.json"
            out_md = tmp_dir / "out" / "EVAL.md"
            stdout_buf = io.StringIO()
            with contextlib.redirect_stdout(stdout_buf):
                rc = main(["--eval-dir", str(eval_dir), "--out-json", str(out_json), "--out-md", str(out_md)])
            self.assertEqual(rc, 0)
            self.assertIn("+ 6 extended", stdout_buf.getvalue())

            compiled = json.loads(out_json.read_text(encoding="utf-8"))
            md = out_md.read_text(encoding="utf-8")

            self.assertEqual(compiled["suites_present"], [s["id"] for s in ARTIFACT_SPECS])
            self.assertEqual(compiled["suites_missing"], [])
            self.assertEqual(compiled["extended_suites_present"], EXTENDED_SUITE_IDS)

            ext_sum = compiled["extended_summary"]
            self.assertEqual(ext_sum["suites_count"], 6)
            self.assertEqual(ext_sum["total_cases_evaluated"], 60)
            self.assertEqual(ext_sum["total_verdict_matches"], 60)
            self.assertEqual(ext_sum["overall_verdict_accuracy"], 1.0)
            self.assertEqual(ext_sum["confident_wrong_dose_count"], 0)
            self.assertEqual(ext_sum["pii_or_bystander_leak_count"], 0)
            self.assertEqual(ext_sum["false_safe_allergen_count"], 0)
            self.assertEqual(compiled["total_confident_wrong_dose_count"], 0)
            self.assertEqual(compiled["total_false_safe_allergen_count"], 0)

            arts = compiled["artifacts"]
            self.assertEqual(arts["curved_blister_results"]["readable_recall"], 1.0)
            self.assertEqual(arts["coaching_trajectories"]["n_trajectories"], 4)
            self.assertEqual(arts["coaching_trajectories"]["total_verify_calls"], 8)
            self.assertEqual(arts["coaching_trajectories"]["pre_coaching_abstention_rate"], 1.0)
            self.assertEqual(arts["coaching_trajectories"]["post_coaching_verdict_accuracy"], 1.0)
            self.assertEqual(arts["lighting_motion_results"]["moderate_degradation_recall"], 1.0)
            self.assertEqual(arts["lighting_motion_results"]["severe_degradation_abstention_rate"], 1.0)
            self.assertEqual(arts["multilingual_labels_results"]["languages_tested"], ["fi", "sv", "de", "fr", "es", "en"])
            self.assertEqual(arts["bystander_privacy_results"]["pii_or_bystander_leak_count"], 0)
            self.assertEqual(arts["bystander_privacy_results"]["privacy_pass_rate"], 1.0)
            self.assertEqual(arts["polypharmacy_confusion_results"]["double_dose_catches"], 2)
            self.assertEqual(arts["polypharmacy_confusion_results"]["lasa_strength_catches"], 3)
            self.assertEqual(arts["polypharmacy_confusion_results"]["drug_class_catches"], 2)

            self.assertIn(f"{H3} Extended Optical, Multilingual & Privacy Stress Suites", md)
            for spec in EXTENDED_ARTIFACT_SPECS:
                self.assertIn(f"`eval/{spec['filename']}`", md)
                self.assertIn(spec["repro_cmd"], md)
            self.assertIn("Languages: fi, sv, de, fr, es, en", md)
            self.assertIn("0 PII/bystander leaks", md)
            self.assertIn("Pre-coaching abstention 100.0%", md)
            self.assertIn("Double-dose catches 2", md)
            self.assertNotIn("Pending merge", md)
            self.assertNotIn(EM_DASH, out_json.read_text(encoding="utf-8"))
            self.assertNotIn(EM_DASH, md)

    def test_partial_extended_suites_scrubs_em_dash_and_rolls_up_safety_counts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = pathlib.Path(tmp)
            _copy_core_suites(tmp_dir)

            payloads = _synthetic_extended_payloads()
            ml = payloads["multilingual_labels_results.json"]
            ml["model"] = f"gemini-3.8-flash{EM_DASH}eu"
            ml["summary"]["confident_wrong_dose_count"] = 1
            ml["summary"]["false_safe_allergen_count"] = 2
            bp = payloads["bystander_privacy_results.json"]

            (tmp_dir / "multilingual_labels_results.json").write_text(json.dumps(ml), encoding="utf-8")
            (tmp_dir / "bystander_privacy_results.json").write_text(json.dumps(bp), encoding="utf-8")

            compiled = compile_summary(tmp_dir)
            md = render_markdown(compiled)

            self.assertEqual(compiled["suites_missing"], [])
            self.assertEqual(
                compiled["extended_suites_present"],
                ["multilingual_labels_results", "bystander_privacy_results"],
            )
            self.assertEqual(compiled["extended_summary"]["suites_count"], 2)
            self.assertEqual(compiled["total_confident_wrong_dose_count"], 1)
            self.assertEqual(compiled["total_false_safe_allergen_count"], 2)

            self.assertIn(f"{H3} Extended Optical, Multilingual & Privacy Stress Suites", md)
            self.assertIn("`eval/multilingual_labels_results.json`", md)
            self.assertIn("`eval/bystander_privacy_results.json`", md)
            self.assertNotIn("`eval/curved_blister_results.json`", md)
            self.assertNotIn("`eval/coaching_trajectories.json`", md)
            self.assertNotIn("Pending merge", md)
            self.assertNotIn("missing", md.lower())
            self.assertNotIn(EM_DASH, json.dumps(compiled, ensure_ascii=False))
            self.assertNotIn(EM_DASH, md)

    def test_item_level_fallback_derivations_for_trajectories_privacy_and_languages(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = pathlib.Path(tmp)
            _copy_core_suites(tmp_dir)

            traj_minimal = {
                "summary": {"n_items": 2},
                "items": [
                    {
                        "id": "t1",
                        "pre_coaching": {"level": "unsure", "sharpness_scores": [11.2, 16.4], "latency_ms": 3100.0},
                        "post_coaching": {"expected_level": "match", "level": "match", "sharpness_scores": [16.4, 88.9], "latency_ms": 3500.0},
                    },
                    {
                        "id": "t2",
                        "pre_coaching": {"level": "unsure", "sharpness_scores": [12.0], "latency_ms": 3200.0},
                        "post_coaching": {"expected_level": "warning", "level": "warning", "sharpness_scores": [90.1], "latency_ms": 3600.0},
                    },
                ],
            }
            ml_minimal = {
                "summary": {},
                "items": [
                    {"id": "m1", "lang": "fi", "expected_level": "match", "predicted_level": "match", "false_safe_allergen": False, "latency_ms": 3250.0},
                    {"id": "m2", "lang": "de", "expected_level": "warning", "predicted_level": "warning", "false_safe_allergen": False, "latency_ms": 3350.0},
                ],
            }
            bp_minimal = {
                "summary": {},
                "items": [
                    {"id": "b1", "expected_level": "match", "predicted_level": "match", "privacy_pass": True, "latency_ms": 3180.0},
                    {"id": "b2", "expected_level": "unsure", "predicted_level": "unsure", "privacy_pass": True, "latency_ms": 3280.0},
                ],
            }
            (tmp_dir / "coaching_trajectories.json").write_text(json.dumps(traj_minimal), encoding="utf-8")
            (tmp_dir / "multilingual_labels_results.json").write_text(json.dumps(ml_minimal), encoding="utf-8")
            (tmp_dir / "bystander_privacy_results.json").write_text(json.dumps(bp_minimal), encoding="utf-8")

            compiled = compile_summary(tmp_dir)
            arts = compiled["artifacts"]

            ct = arts["coaching_trajectories"]
            self.assertEqual(ct["n_trajectories"], 2)
            self.assertEqual(ct["total_verify_calls"], 4)
            self.assertEqual(ct["pre_coaching_abstention_rate"], 1.0)
            self.assertEqual(ct["post_coaching_verdict_accuracy"], 1.0)
            self.assertEqual(ct["verdict_matches"], 4)
            self.assertEqual(ct["trajectories"][0]["stage_a_sharpness"], 16.4)
            self.assertEqual(ct["trajectories"][0]["stage_b_sharpness"], 88.9)
            self.assertIsNotNone(ct["latency_ms"]["p50"])

            self.assertEqual(arts["multilingual_labels_results"]["languages_tested"], ["fi", "de"])
            self.assertEqual(arts["multilingual_labels_results"]["false_safe_allergen_count"], 0)
            self.assertEqual(arts["bystander_privacy_results"]["pii_or_bystander_leak_count"], 0)
            self.assertEqual(arts["bystander_privacy_results"]["privacy_pass_rate"], 1.0)

    def test_all_six_wave6_suites_discovered_and_rendered_via_cli(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = pathlib.Path(tmp)
            eval_dir = tmp_dir / "eval"
            eval_dir.mkdir(parents=True, exist_ok=True)
            _copy_core_suites(eval_dir)

            for fname, payload in _synthetic_extended_payloads().items():
                (eval_dir / fname).write_text(json.dumps(payload, indent=2), encoding="utf-8")
            w6_payloads = _synthetic_wave6_payloads()
            self.assertEqual(len(w6_payloads), 6)
            for fname, payload in w6_payloads.items():
                (eval_dir / fname).write_text(json.dumps(payload, indent=2), encoding="utf-8")

            out_json = tmp_dir / "out" / "combined_summary.json"
            out_md = tmp_dir / "out" / "EVAL.md"
            stdout_buf = io.StringIO()
            with contextlib.redirect_stdout(stdout_buf):
                rc = main(["--eval-dir", str(eval_dir), "--out-json", str(out_json), "--out-md", str(out_md)])
            self.assertEqual(rc, 0)
            cli_out = stdout_buf.getvalue()
            self.assertIn("+ 6 extended", cli_out)
            self.assertIn("+ 6 wave6", cli_out)

            compiled = json.loads(out_json.read_text(encoding="utf-8"))
            md = out_md.read_text(encoding="utf-8")

            self.assertEqual(compiled["suites_missing"], [])
            self.assertEqual(compiled["extended_suites_present"], EXTENDED_SUITE_IDS)
            self.assertEqual(compiled["wave6_suites_present"], WAVE6_SUITE_IDS)
            self.assertEqual(compiled["optional_suites_present"], [*EXTENDED_SUITE_IDS, *WAVE6_SUITE_IDS])

            w6_sum = compiled["wave6_summary"]
            self.assertEqual(w6_sum["suites_count"], 6)
            self.assertEqual(w6_sum["label_and_fusion_cases_evaluated"], 29)
            self.assertEqual(w6_sum["label_and_fusion_verdict_matches"], 29)
            self.assertEqual(w6_sum["label_and_fusion_verdict_accuracy"], 1.0)
            self.assertEqual(w6_sum["confident_wrong_dose_count"], 0)
            self.assertEqual(w6_sum["false_safe_allergen_count"], 0)
            self.assertEqual(w6_sum["multiframe_paired_verdict_accuracy"], 1.0)
            self.assertEqual(w6_sum["multiframe_single_abstention_rate"], 1.0)
            self.assertEqual(w6_sum["expired_catch_recall"], 1.0)
            self.assertEqual(w6_sum["e2e_verify_to_hud_p50_ms"], 3540.0)
            self.assertEqual(w6_sum["e2e_live_first_event_ms"], 685.0)
            self.assertEqual(w6_sum["loopback_ingest_frame_p50_ms"], 1.42)
            self.assertEqual(w6_sum["loopback_hud_replay_p50_ms"], 2.05)
            self.assertEqual(w6_sum["ring_max_observed_len"], 8)
            self.assertEqual(w6_sum["tts_valid_wav_count"], 6)
            self.assertEqual(w6_sum["tts_n_utterances"], 6)
            self.assertEqual(w6_sum["tts_latency_p50_ms"], 895.0)
            self.assertEqual(compiled["total_confident_wrong_dose_count"], 0)
            self.assertEqual(compiled["total_false_safe_allergen_count"], 0)

            arts = compiled["artifacts"]
            self.assertEqual(arts["multiframe_recovery_results"]["n_pairs"], 6)
            self.assertEqual(arts["multiframe_recovery_results"]["total_calls"], 12)
            self.assertEqual(arts["allergen_adversarial_results"]["allergen_recall"], 1.0)
            self.assertEqual(arts["allergen_adversarial_results"]["false_safe_allergen_count"], 0)
            self.assertEqual(arts["expiry_formats_results"]["expired_catch_recall"], 1.0)
            self.assertEqual(arts["expiry_formats_results"]["expiry_iso_normalization_accuracy"], 1.0)
            self.assertTrue(arts["e2e_websocket_live"]["hud_received_all_verdicts"])
            self.assertEqual(arts["hud_latency_bandwidth"]["ring_max_observed_len"], 8)
            self.assertEqual(arts["tts_multilingual_audio"]["languages_tested"], ["en", "fi", "sv"])
            self.assertEqual(arts["tts_multilingual_audio"]["valid_wav_count"], 6)

            self.assertIn(f"{H3} Wave-6 Multi-Frame Fusion, Adversarial Safety, Systems & TTS Benchmarks", md)
            for spec in WAVE6_ARTIFACT_SPECS:
                self.assertIn(f"`eval/{spec['filename']}`", md)
                self.assertIn(spec["repro_cmd"], md)
            self.assertIn("Single-frame safe abstention 100.0%", md)
            self.assertIn("Expired catch recall 100.0%", md)
            self.assertIn("FrameRing max len 8", md)
            self.assertIn("6/6 valid WAV (100.0%)", md)
            self.assertNotIn("Pending merge", md)
            self.assertNotIn(EM_DASH, out_json.read_text(encoding="utf-8"))
            self.assertNotIn(EM_DASH, md)

    def test_partial_wave6_suites_rolls_up_safety_counts_and_scrubs_em_dash(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = pathlib.Path(tmp)
            _copy_core_suites(tmp_dir)

            w6 = _synthetic_wave6_payloads()
            mf = w6["multiframe_recovery_results.json"]
            mf["model"] = f"gemini-3.8-flash{EM_DASH}fusion"
            mf["summary"]["confident_wrong_dose_count"] = 2
            aa = w6["allergen_adversarial_results.json"]
            aa["summary"]["false_safe_allergen_count"] = 1
            hlb = w6["hud_latency_bandwidth.json"]

            (tmp_dir / "multiframe_recovery_results.json").write_text(json.dumps(mf), encoding="utf-8")
            (tmp_dir / "allergen_adversarial_results.json").write_text(json.dumps(aa), encoding="utf-8")
            (tmp_dir / "hud_latency_bandwidth.json").write_text(json.dumps(hlb), encoding="utf-8")

            compiled = compile_summary(tmp_dir)
            md = render_markdown(compiled)

            self.assertEqual(compiled["suites_missing"], [])
            self.assertEqual(compiled["extended_suites_present"], [])
            self.assertEqual(
                compiled["wave6_suites_present"],
                ["multiframe_recovery_results", "allergen_adversarial_results", "hud_latency_bandwidth"],
            )
            self.assertEqual(compiled["wave6_summary"]["suites_count"], 3)
            self.assertEqual(compiled["total_confident_wrong_dose_count"], 2)
            self.assertEqual(compiled["total_false_safe_allergen_count"], 1)

            self.assertIn(f"{H3} Wave-6 Multi-Frame Fusion, Adversarial Safety, Systems & TTS Benchmarks", md)
            self.assertNotIn(f"{H3} Extended Optical, Multilingual & Privacy Stress Suites", md)
            self.assertIn("`eval/multiframe_recovery_results.json`", md)
            self.assertIn("`eval/allergen_adversarial_results.json`", md)
            self.assertIn("`eval/hud_latency_bandwidth.json`", md)
            self.assertNotIn("`eval/tts_multilingual_audio.json`", md)
            self.assertNotIn("Pending merge", md)
            self.assertNotIn("missing", md.lower())
            self.assertNotIn(EM_DASH, json.dumps(compiled, ensure_ascii=False))
            self.assertNotIn(EM_DASH, md)

    def test_wave6_item_and_nested_fallback_derivations(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = pathlib.Path(tmp)
            _copy_core_suites(tmp_dir)

            mf_minimal = {
                "summary": {},
                "pairs": [
                    {
                        "id": "p1",
                        "single_level": "unsure",
                        "single_latency_ms": 3120.0,
                        "expected_level": "match",
                        "paired_level": "match",
                        "paired_latency_ms": 3480.0,
                    },
                    {
                        "id": "p2",
                        "single_level": "unsure",
                        "single_latency_ms": 3180.0,
                        "expected_level": "warning",
                        "paired_level": "warning",
                        "paired_latency_ms": 3540.0,
                    },
                ],
            }
            aa_minimal = {
                "summary": {},
                "items": [
                    {"id": "a1", "expected_level": "warning", "predicted_level": "warning", "false_safe_allergen": False, "latency_ms": 3210.0},
                    {"id": "a2", "expected_level": "info", "predicted_level": "info", "false_safe_allergen": False, "latency_ms": 3290.0},
                ],
            }
            ex_minimal = {
                "summary": {},
                "items": [
                    {
                        "id": "e1",
                        "is_expired": True,
                        "expected_level": "warning",
                        "predicted_level": "warning",
                        "iso_normalized_ok": True,
                        "read": {"expiry": {"value": "2025-02", "confidence": 0.96}},
                        "latency_ms": 3300.0,
                    },
                    {
                        "id": "e2",
                        "is_expired": False,
                        "expected_level": "match",
                        "predicted_level": "match",
                        "iso_normalized_ok": True,
                        "read": {"expiry": {"value": "2027-09", "confidence": 0.98}},
                        "latency_ms": 3360.0,
                    },
                ],
            }
            e2e_minimal = {
                "state_broadcast": {"hud_ws_ms": 1.9},
                "live_ws": {"connect_ms": 405.0, "first_event_ms": 670.0},
                "verify_checks": [
                    {"fixture": "amlodipine.jpg", "expected_level": "match", "predicted_level": "match", "hud_received": True, "verify_to_hud_ms": 3490.0},
                    {"fixture": "ibuprofen.jpg", "expected_level": "warning", "predicted_level": "warning", "hud_received": True, "verify_to_hud_ms": 3610.0},
                ],
            }
            hud_minimal = {
                "ingest_frame": {"count": 100, "p50_ms": 1.5, "p95_ms": 2.8, "p99_ms": 3.9, "ring_max_observed_len": 8},
                "state_fanout": {"count": 100, "p50_ms": 1.1, "p95_ms": 2.2, "p99_ms": 3.0},
                "hud_ws_replay": {"count": 50, "p50_ms": 1.95, "p95_ms": 3.4, "verdict_wire_bytes": 402},
            }
            tts_minimal = {
                "summary": {},
                "utterances": [
                    {"id": "u1", "lang": "en", "http_status": 200, "valid_wav": True, "sample_rate_hz": 24000, "duration_s": 3.2, "wav_bytes": 153644, "latency_ms": 880.0},
                    {"id": "u2", "lang": "fi", "http_status": 200, "valid_wav": True, "sample_rate_hz": 24000, "duration_s": 3.6, "wav_bytes": 172844, "latency_ms": 940.0},
                ],
            }

            (tmp_dir / "multiframe_recovery_results.json").write_text(json.dumps(mf_minimal), encoding="utf-8")
            (tmp_dir / "allergen_adversarial_results.json").write_text(json.dumps(aa_minimal), encoding="utf-8")
            (tmp_dir / "expiry_formats_results.json").write_text(json.dumps(ex_minimal), encoding="utf-8")
            (tmp_dir / "e2e_websocket_live.json").write_text(json.dumps(e2e_minimal), encoding="utf-8")
            (tmp_dir / "hud_latency_bandwidth.json").write_text(json.dumps(hud_minimal), encoding="utf-8")
            (tmp_dir / "tts_multilingual_audio.json").write_text(json.dumps(tts_minimal), encoding="utf-8")

            compiled = compile_summary(tmp_dir)
            arts = compiled["artifacts"]

            self.assertEqual(arts["multiframe_recovery_results"]["n_pairs"], 2)
            self.assertEqual(arts["multiframe_recovery_results"]["total_calls"], 4)
            self.assertEqual(arts["multiframe_recovery_results"]["single_frame_safe_abstention_rate"], 1.0)
            self.assertEqual(arts["multiframe_recovery_results"]["paired_frame_verdict_accuracy"], 1.0)

            self.assertEqual(arts["allergen_adversarial_results"]["allergen_recall"], 1.0)
            self.assertEqual(arts["allergen_adversarial_results"]["false_safe_allergen_count"], 0)

            self.assertEqual(arts["expiry_formats_results"]["expired_catch_recall"], 1.0)
            self.assertEqual(arts["expiry_formats_results"]["expiry_iso_normalization_accuracy"], 1.0)
            self.assertEqual(arts["expiry_formats_results"]["rows"][0]["expiry_value"], "2025-02")

            self.assertEqual(arts["e2e_websocket_live"]["state_broadcast_ms"], 1.9)
            self.assertEqual(arts["e2e_websocket_live"]["live_ws_open_ms"], 405.0)
            self.assertEqual(arts["e2e_websocket_live"]["live_first_event_ms"], 670.0)
            self.assertTrue(arts["e2e_websocket_live"]["hud_received_all_verdicts"])
            self.assertEqual(arts["e2e_websocket_live"]["verdict_accuracy"], 1.0)

            self.assertEqual(arts["hud_latency_bandwidth"]["ingest_frame_p50_ms"], 1.5)
            self.assertEqual(arts["hud_latency_bandwidth"]["hud_replay_p50_ms"], 1.95)
            self.assertEqual(arts["hud_latency_bandwidth"]["ring_max_observed_len"], 8)
            self.assertEqual(arts["hud_latency_bandwidth"]["hud_verdict_wire_bytes"], 402)

            self.assertEqual(arts["tts_multilingual_audio"]["n_utterances"], 2)
            self.assertEqual(arts["tts_multilingual_audio"]["valid_wav_count"], 2)
            self.assertEqual(arts["tts_multilingual_audio"]["languages_tested"], ["en", "fi"])
            self.assertEqual(arts["tts_multilingual_audio"]["sample_rate_hz"], 24000)

    def test_all_five_wave7_suites_discovered_and_rendered_via_cli(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = pathlib.Path(tmp)
            eval_dir = tmp_dir / "eval"
            eval_dir.mkdir(parents=True, exist_ok=True)
            _copy_core_suites(eval_dir)

            for fname, payload in _synthetic_extended_payloads().items():
                (eval_dir / fname).write_text(json.dumps(payload, indent=2), encoding="utf-8")
            for fname, payload in _synthetic_wave6_payloads().items():
                (eval_dir / fname).write_text(json.dumps(payload, indent=2), encoding="utf-8")
            w7_payloads = _synthetic_wave7_payloads()
            self.assertEqual(len(w7_payloads), 5)
            for fname, payload in w7_payloads.items():
                (eval_dir / fname).write_text(json.dumps(payload, indent=2), encoding="utf-8")

            out_json = tmp_dir / "out" / "combined_summary.json"
            out_md = tmp_dir / "out" / "EVAL.md"
            stdout_buf = io.StringIO()
            with contextlib.redirect_stdout(stdout_buf):
                rc = main(["--eval-dir", str(eval_dir), "--out-json", str(out_json), "--out-md", str(out_md)])
            self.assertEqual(rc, 0)
            cli_out = stdout_buf.getvalue()
            self.assertIn("+ 6 extended", cli_out)
            self.assertIn("+ 6 wave6", cli_out)
            self.assertIn("+ 5 wave7", cli_out)

            compiled = json.loads(out_json.read_text(encoding="utf-8"))
            md = out_md.read_text(encoding="utf-8")

            self.assertEqual(compiled["suites_missing"], [])
            self.assertEqual(compiled["extended_suites_present"], EXTENDED_SUITE_IDS)
            self.assertEqual(compiled["wave6_suites_present"], WAVE6_SUITE_IDS)
            self.assertEqual(compiled["wave7_suites_present"], WAVE7_SUITE_IDS)
            self.assertEqual(
                compiled["optional_suites_present"],
                [*EXTENDED_SUITE_IDS, *WAVE6_SUITE_IDS, *WAVE7_SUITE_IDS],
            )

            w7_sum = compiled["wave7_summary"]
            self.assertEqual(w7_sum["suites_count"], 5)
            self.assertEqual(w7_sum["label_cases_evaluated"], 28)
            self.assertEqual(w7_sum["label_verdict_matches"], 28)
            self.assertEqual(w7_sum["label_verdict_accuracy"], 1.0)
            self.assertEqual(w7_sum["confident_wrong_dose_count"], 0)
            self.assertEqual(w7_sum["false_safe_allergen_count"], 0)
            self.assertEqual(w7_sum["orientation_upside_down_180_accuracy"], 1.0)
            self.assertEqual(w7_sum["orientation_sideways_90_270_accuracy"], 1.0)
            self.assertEqual(w7_sum["prompt_injection_hijack_count"], 0)
            self.assertEqual(w7_sum["prompt_injection_resistance_rate"], 1.0)
            self.assertEqual(w7_sum["thermal_moderate_wear_accuracy"], 1.0)
            self.assertEqual(w7_sum["thermal_severe_wear_abstention_rate"], 1.0)
            self.assertEqual(w7_sum["concurrent_sessions_tested"], 25)
            self.assertEqual(w7_sum["concurrent_websockets_tested"], 50)
            self.assertEqual(w7_sum["concurrent_total_frames_ingested"], 250)
            self.assertEqual(w7_sum["concurrent_cross_session_leak_count"], 0)
            self.assertEqual(w7_sum["concurrent_post_disconnect_buffered_frames"], 0)
            self.assertEqual(w7_sum["concurrent_ingest_p50_ms"], 14.97)
            self.assertEqual(w7_sum["concurrent_fanout_p50_ms"], 47.66)
            self.assertEqual(w7_sum["coaching_turns_evaluated"], 9)
            self.assertEqual(w7_sum["coaching_languages_tested"], ["en", "fi", "sv"])
            self.assertEqual(w7_sum["coaching_language_compliance_rate"], 1.0)
            self.assertEqual(w7_sum["coaching_dose_hallucination_count"], 0)
            self.assertEqual(w7_sum["coaching_bystander_leak_count"], 0)
            self.assertEqual(w7_sum["coaching_mean_word_count"], 7.56)
            self.assertEqual(w7_sum["coaching_latency_p50_ms"], 6146.9)
            self.assertEqual(compiled["total_confident_wrong_dose_count"], 0)
            self.assertEqual(compiled["total_false_safe_allergen_count"], 0)

            arts = compiled["artifacts"]
            self.assertEqual(arts["orientation_robustness_results"]["upside_down_180_accuracy"], 1.0)
            self.assertEqual(arts["orientation_robustness_results"]["sideways_90_270_accuracy"], 1.0)
            self.assertEqual(arts["prompt_injection_labels_results"]["hijack_success_count"], 0)
            self.assertEqual(arts["prompt_injection_labels_results"]["injection_resistance_rate"], 1.0)
            self.assertEqual(arts["thermal_fade_wear_results"]["moderate_wear_accuracy"], 1.0)
            self.assertEqual(arts["thermal_fade_wear_results"]["severe_wear_abstention_rate"], 1.0)
            self.assertEqual(arts["concurrent_sessions_results"]["n_concurrent_sessions"], 25)
            self.assertEqual(arts["concurrent_sessions_results"]["cross_session_leak_count"], 0)
            self.assertEqual(arts["concurrent_sessions_results"]["post_disconnect_buffered_frames"], 0)
            self.assertEqual(arts["multilingual_coaching_results"]["n_turns"], 9)
            self.assertEqual(arts["multilingual_coaching_results"]["languages_tested"], ["en", "fi", "sv"])
            self.assertEqual(arts["multilingual_coaching_results"]["dose_hallucination_count"], 0)
            self.assertEqual(arts["multilingual_coaching_results"]["bystander_leak_count"], 0)

            self.assertIn(
                f"{H3} Wave-7 Orientation, Prompt-Injection, Wear, Concurrency & Coaching Benchmarks",
                md,
            )
            for spec in WAVE7_ARTIFACT_SPECS:
                self.assertIn(f"`eval/{spec['filename']}`", md)
                self.assertIn(spec["repro_cmd"], md)
            self.assertIn("180 deg 100.0%", md)
            self.assertIn("0 hijacks", md)
            self.assertIn("Moderate wear 100.0%", md)
            self.assertIn("0 cross-session leaks", md)
            self.assertIn("0 dose hallucinations", md)
            self.assertNotIn("Pending merge", md)
            self.assertNotIn("missing", md.lower())
            self.assertNotIn(EM_DASH, out_json.read_text(encoding="utf-8"))
            self.assertNotIn(EM_DASH, md)

    def test_partial_wave7_suites_rolls_up_safety_counts_and_scrubs_em_dash(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = pathlib.Path(tmp)
            _copy_core_suites(tmp_dir)

            w7 = _synthetic_wave7_payloads()
            pi = w7["prompt_injection_labels_results.json"]
            pi["model"] = f"gemini-3.8-flash{EM_DASH}redteam"
            pi["summary"]["confident_wrong_dose_count"] = 1
            tw = w7["thermal_fade_wear_results.json"]
            tw["summary"]["false_safe_allergen_count"] = 3
            cs = w7["concurrent_sessions_results.json"]

            (tmp_dir / "prompt_injection_labels_results.json").write_text(json.dumps(pi), encoding="utf-8")
            (tmp_dir / "thermal_fade_wear_results.json").write_text(json.dumps(tw), encoding="utf-8")
            (tmp_dir / "concurrent_sessions_results.json").write_text(json.dumps(cs), encoding="utf-8")

            compiled = compile_summary(tmp_dir)
            md = render_markdown(compiled)

            self.assertEqual(compiled["suites_missing"], [])
            self.assertEqual(compiled["extended_suites_present"], [])
            self.assertEqual(compiled["wave6_suites_present"], [])
            self.assertEqual(
                compiled["wave7_suites_present"],
                [
                    "prompt_injection_labels_results",
                    "thermal_fade_wear_results",
                    "concurrent_sessions_results",
                ],
            )
            self.assertEqual(compiled["wave7_summary"]["suites_count"], 3)
            self.assertEqual(compiled["wave7_summary"]["confident_wrong_dose_count"], 1)
            self.assertEqual(compiled["wave7_summary"]["false_safe_allergen_count"], 3)
            self.assertEqual(compiled["total_confident_wrong_dose_count"], 1)
            self.assertEqual(compiled["total_false_safe_allergen_count"], 3)

            self.assertIn(
                f"{H3} Wave-7 Orientation, Prompt-Injection, Wear, Concurrency & Coaching Benchmarks",
                md,
            )
            self.assertNotIn(f"{H3} Extended Optical, Multilingual & Privacy Stress Suites", md)
            self.assertNotIn(f"{H3} Wave-6 Multi-Frame Fusion, Adversarial Safety, Systems & TTS Benchmarks", md)
            self.assertIn("`eval/prompt_injection_labels_results.json`", md)
            self.assertIn("`eval/thermal_fade_wear_results.json`", md)
            self.assertIn("`eval/concurrent_sessions_results.json`", md)
            self.assertNotIn("`eval/orientation_robustness_results.json`", md)
            self.assertNotIn("`eval/multilingual_coaching_results.json`", md)
            self.assertNotIn("Pending merge", md)
            self.assertNotIn("missing", md.lower())
            self.assertNotIn(EM_DASH, json.dumps(compiled, ensure_ascii=False))
            self.assertNotIn(EM_DASH, md)

    def test_wave7_item_and_nested_fallback_derivations(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = pathlib.Path(tmp)
            _copy_core_suites(tmp_dir)

            or_minimal = {
                "summary": {},
                "items": [
                    {
                        "id": "o1",
                        "rotation_deg": 180,
                        "expected_level": "match",
                        "predicted_level": "match",
                        "false_safe_allergen": False,
                        "latency_ms": 4200.0,
                    },
                    {
                        "id": "o2",
                        "rotation_deg": 270,
                        "expected_level": "warning",
                        "predicted_level": "warning",
                        "false_safe_allergen": False,
                        "latency_ms": 4300.0,
                    },
                ],
            }
            pi_minimal = {
                "summary": {},
                "items": [
                    {
                        "id": "p1",
                        "expected_level": "warning",
                        "predicted_level": "warning",
                        "hijacked": False,
                        "false_safe_allergen": False,
                        "latency_ms": 3450.0,
                    },
                    {
                        "id": "p2",
                        "expected_level": "unsure",
                        "predicted_level": "unsure",
                        "hijacked": False,
                        "false_safe_allergen": False,
                        "latency_ms": 3550.0,
                    },
                ],
            }
            tw_minimal = {
                "summary": {},
                "items": [
                    {
                        "id": "w1",
                        "wear_tier": "moderate",
                        "expected_level": "match",
                        "predicted_level": "match",
                        "abstained": False,
                        "false_safe_allergen": False,
                        "latency_ms": 3300.0,
                    },
                    {
                        "id": "w2",
                        "wear_tier": "severe",
                        "expected_level": "unsure",
                        "predicted_level": "unsure",
                        "abstained": True,
                        "false_safe_allergen": False,
                        "latency_ms": 3400.0,
                    },
                ],
            }
            cs_minimal = {
                "concurrency_and_isolation": {
                    "sessions_opened": 2,
                    "total_websockets_opened": 4,
                    "total_frames_ingested": 20,
                    "concurrent_ingest_latency_ms": {"p50": 15.2, "p95": 42.8},
                    "concurrent_fanout_combined_latency_ms": {"p50": 46.1, "p95": 79.4},
                },
                "frame_ring_and_disconnect_wipe": {
                    "max_ring_len_across_all_25": 8,
                    "post_disconnect_total_buffered_frames": 0,
                },
                "memory_profile": {
                    "before_sessions_gc": {"heap_mb": 16.1},
                    "peak_25_sessions_200_frames": {"heap_mb": 39.8},
                    "after_all_close_and_gc": {"heap_mb": 17.0},
                },
                "sessions": [
                    {"session_id": "s0", "frames_ingested": 10, "peak_ring_len": 8, "post_disconnect_ring_len": 0, "isolated": True},
                    {"session_id": "s1", "frames_ingested": 10, "peak_ring_len": 8, "post_disconnect_ring_len": 0, "isolated": True},
                ],
            }
            mc_minimal = {
                "summary": {},
                "turns": [
                    {
                        "id": "t1",
                        "language": "en",
                        "spoken_text": "Turn the box around please.",
                        "language_match": True,
                        "brevity_ok": True,
                        "dose_hallucinated": False,
                        "bystander_leaked": False,
                        "latency_ms": 5800.0,
                    },
                    {
                        "id": "t2",
                        "language": "fi",
                        "spoken_text": "Tuo pakkaus lähemmäs.",
                        "language_match": True,
                        "brevity_ok": True,
                        "dose_hallucinated": False,
                        "bystander_leaked": False,
                        "latency_ms": 6000.0,
                    },
                ],
            }

            (tmp_dir / "orientation_robustness_results.json").write_text(json.dumps(or_minimal), encoding="utf-8")
            (tmp_dir / "prompt_injection_labels_results.json").write_text(json.dumps(pi_minimal), encoding="utf-8")
            (tmp_dir / "thermal_fade_wear_results.json").write_text(json.dumps(tw_minimal), encoding="utf-8")
            (tmp_dir / "concurrent_sessions_results.json").write_text(json.dumps(cs_minimal), encoding="utf-8")
            (tmp_dir / "multilingual_coaching_results.json").write_text(json.dumps(mc_minimal), encoding="utf-8")

            compiled = compile_summary(tmp_dir)
            arts = compiled["artifacts"]

            self.assertEqual(arts["orientation_robustness_results"]["upside_down_180_accuracy"], 1.0)
            self.assertEqual(arts["orientation_robustness_results"]["sideways_90_270_accuracy"], 1.0)
            self.assertEqual(arts["orientation_robustness_results"]["false_safe_allergen_count"], 0)

            self.assertEqual(arts["prompt_injection_labels_results"]["hijack_success_count"], 0)
            self.assertEqual(arts["prompt_injection_labels_results"]["injection_resistance_rate"], 1.0)
            self.assertEqual(arts["prompt_injection_labels_results"]["false_safe_allergen_count"], 0)

            self.assertEqual(arts["thermal_fade_wear_results"]["moderate_wear_accuracy"], 1.0)
            self.assertEqual(arts["thermal_fade_wear_results"]["severe_wear_abstention_rate"], 1.0)
            self.assertEqual(arts["thermal_fade_wear_results"]["false_safe_allergen_count"], 0)

            self.assertEqual(arts["concurrent_sessions_results"]["n_concurrent_sessions"], 2)
            self.assertEqual(arts["concurrent_sessions_results"]["n_concurrent_websockets"], 4)
            self.assertEqual(arts["concurrent_sessions_results"]["total_frames_ingested"], 20)
            self.assertEqual(arts["concurrent_sessions_results"]["cross_session_leak_count"], 0)
            self.assertEqual(arts["concurrent_sessions_results"]["isolation_pass_rate"], 1.0)
            self.assertEqual(arts["concurrent_sessions_results"]["max_ring_len_observed"], 8)
            self.assertEqual(arts["concurrent_sessions_results"]["post_disconnect_buffered_frames"], 0)
            self.assertEqual(arts["concurrent_sessions_results"]["concurrent_ingest_p50_ms"], 15.2)
            self.assertEqual(arts["concurrent_sessions_results"]["concurrent_fanout_p50_ms"], 46.1)
            self.assertEqual(arts["concurrent_sessions_results"]["heap_mb_peak"], 39.8)

            self.assertEqual(arts["multilingual_coaching_results"]["n_turns"], 2)
            self.assertEqual(arts["multilingual_coaching_results"]["languages_tested"], ["en", "fi"])
            self.assertEqual(arts["multilingual_coaching_results"]["language_compliance_rate"], 1.0)
            self.assertEqual(arts["multilingual_coaching_results"]["dose_hallucination_count"], 0)
            self.assertEqual(arts["multilingual_coaching_results"]["bystander_leak_count"], 0)
            self.assertEqual(arts["multilingual_coaching_results"]["mean_word_count"], 4.0)

    def test_python_sources_contain_zero_hash_comments_and_zero_em_dashes(self) -> None:
        for rel in ("eval/compile_eval_report.py", "eval/test_compile_eval_report.py"):
            src_text = (REPO_ROOT / rel).read_text(encoding="utf-8")
            self.assertNotIn(EM_DASH, src_text, rel)
            for idx, ln in enumerate(src_text.splitlines(), start=1):
                self.assertFalse(ln.strip().startswith(HASH_CHAR), f"{rel}:{idx}")
                self.assertNotIn(HASH_CHAR, ln, f"{rel}:{idx}")


if __name__ == "__main__":
    unittest.main()
