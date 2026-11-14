import datetime
import io
import json
import pathlib
import statistics
from PIL import Image

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
FIXTURES_DIR = REPO_ROOT / "web" / "public" / "fixtures"
LIVE_PROMPT_PATH = REPO_ROOT / "server" / "src" / "prompts" / "live.md"
VERIFY_PROMPT_PATH = REPO_ROOT / "shared" / "verify_prompt.md"
LABEL_SCHEMA_PATH = REPO_ROOT / "shared" / "label_schema.json"
COACHING_EVAL_PATH = REPO_ROOT / "eval" / "coaching_eval.json"
OUT_JSON_PATH = REPO_ROOT / "eval" / "unit_economics.json"

USD_TO_EUR = 0.92
CHECK_DURATION_S = 12.0
CHECKS_PER_DAY = 4
DAYS_PER_MONTH = 30
CHECKS_PER_MONTH = CHECKS_PER_DAY * DAYS_PER_MONTH
MONTHS_PER_YEAR = 12
CHECKS_PER_YEAR = CHECKS_PER_MONTH * MONTHS_PER_YEAR
TCO_YEARS = 3

UPLINK_AUDIO_HZ = 16000
DOWNLINK_AUDIO_HZ = 24000
PCM16_BYTES_PER_SAMPLE = 2
TYPICAL_ASSISTANT_SPEECH_S = 5.0
PCM_CHUNK_DURATION_S = 0.1
WS_JSON_ENVELOPE_BYTES = 38

NORMAL_FPS = 1.0
NORMAL_MAX_DIM_PX = 768
NORMAL_JPEG_QUALITY = 0.78

ADAPTIVE_FPS = 0.5
ADAPTIVE_MAX_DIM_PX = 512
ADAPTIVE_JPEG_QUALITY_PIL = 50
ADAPTIVE_RTT_TRIGGER_MS = 650

GEMINI_TOKENS_PER_FRAME = 258
GEMINI_TOKENS_PER_AUDIO_S = 32
VERIFY_SHARPEST_FRAMES = 2
VERIFY_MAX_FRAMES = 3

TOOLS_DECLARATION_EST_TOKENS = 255
COMPACT_PROFILE_EST_TOKENS = 65
LIVE_DYNAMIC_TURN_TEXT_IN_TOKENS = 220
LIVE_TOOL_CALL_TEXT_OUT_TOKENS = 55
VERIFY_QUESTION_TEXT_IN_TOKENS = 25
VERIFY_STRUCTURED_JSON_AND_LOW_THINKING_OUT_TOKENS = 200
STATIC_PROMPT_CACHE_HIT_RATIO = 0.75
DAILY_SAVED_BARCODE_LOCAL_RATIO = 0.30


def b64_encoded_bytes(raw_len: int) -> int:
    return ((raw_len + 2) // 3) * 4


def measure_fixtures() -> dict:
    fixture_paths = sorted(FIXTURES_DIR.glob("*.jpg"))
    if not fixture_paths:
        raise RuntimeError(f"No JPEG fixtures found in {FIXTURES_DIR}")

    records = []
    normal_sizes = []
    adaptive_sizes = []

    for path in fixture_paths:
        raw = path.read_bytes()
        normal_len = len(raw)
        normal_sizes.append(normal_len)

        with Image.open(io.BytesIO(raw)) as img:
            width, height = img.size
            scale = min(1.0, float(ADAPTIVE_MAX_DIM_PX) / float(max(width, height)))
            adaptive_w = max(1, round(width * scale))
            adaptive_h = max(1, round(height * scale))
            resized = (
                img.resize((adaptive_w, adaptive_h), Image.Resampling.LANCZOS)
                if (adaptive_w, adaptive_h) != (width, height)
                else img.copy()
            )
            buf = io.BytesIO()
            resized.save(buf, format="JPEG", quality=ADAPTIVE_JPEG_QUALITY_PIL)
            adaptive_len = len(buf.getvalue())
            adaptive_sizes.append(adaptive_len)

        records.append(
            {
                "file": path.name,
                "normal_dimensions": f"{width}x{height}",
                "normal_bytes": normal_len,
                "normal_kb": round(normal_len / 1000.0, 2),
                "normal_kib": round(normal_len / 1024.0, 2),
                "normal_base64_bytes": b64_encoded_bytes(normal_len),
                "adaptive_512px_q50_dimensions": f"{adaptive_w}x{adaptive_h}",
                "adaptive_512px_q50_bytes": adaptive_len,
                "adaptive_512px_q50_kb": round(adaptive_len / 1000.0, 2),
                "adaptive_512px_q50_kib": round(adaptive_len / 1024.0, 2),
                "adaptive_512px_q50_base64_bytes": b64_encoded_bytes(adaptive_len),
            }
        )

    return {
        "fixture_directory": "web/public/fixtures",
        "count": len(records),
        "normal_768px": {
            "mean_bytes": round(statistics.mean(normal_sizes), 2),
            "median_bytes": round(statistics.median(normal_sizes), 2),
            "min_bytes": min(normal_sizes),
            "max_bytes": max(normal_sizes),
            "mean_kb": round(statistics.mean(normal_sizes) / 1000.0, 2),
            "mean_kib": round(statistics.mean(normal_sizes) / 1024.0, 2),
        },
        "adaptive_512px_q50": {
            "mean_bytes": round(statistics.mean(adaptive_sizes), 2),
            "median_bytes": round(statistics.median(adaptive_sizes), 2),
            "min_bytes": min(adaptive_sizes),
            "max_bytes": max(adaptive_sizes),
            "mean_kb": round(statistics.mean(adaptive_sizes) / 1000.0, 2),
            "mean_kib": round(statistics.mean(adaptive_sizes) / 1024.0, 2),
        },
        "files": records,
    }


def measure_prompts_and_eval() -> dict:
    live_text = LIVE_PROMPT_PATH.read_text(encoding="utf-8")
    verify_text = VERIFY_PROMPT_PATH.read_text(encoding="utf-8")
    schema_text = LABEL_SCHEMA_PATH.read_text(encoding="utf-8")
    coaching_data = json.loads(COACHING_EVAL_PATH.read_text(encoding="utf-8"))

    speeches = [str(s.get("final_speech", "")) for s in coaching_data.get("scenarios", [])]
    speech_char_counts = [len(s) for s in speeches] if speeches else [0]
    speech_word_counts = [len(s.split()) for s in speeches] if speeches else [0]

    live_prompt_tokens = round(len(live_text) / 4.0)
    verify_prompt_tokens = round(len(verify_text) / 4.0)
    schema_tokens = round(len(schema_text) / 4.0)

    return {
        "live_system_prompt_file": "server/src/prompts/live.md",
        "live_system_prompt_chars": len(live_text),
        "live_system_prompt_est_tokens": live_prompt_tokens,
        "verify_prompt_file": "shared/verify_prompt.md",
        "verify_prompt_chars": len(verify_text),
        "verify_prompt_est_tokens": verify_prompt_tokens,
        "label_schema_file": "shared/label_schema.json",
        "label_schema_chars": len(schema_text),
        "label_schema_est_tokens": schema_tokens,
        "coaching_eval_file": "eval/coaching_eval.json",
        "coaching_eval_scenarios": int(coaching_data["summary"]["total_scenarios"]),
        "coaching_eval_pass_rate": float(coaching_data["summary"]["all_checks_pass_rate"]),
        "coaching_eval_mean_latency_ms": float(coaching_data["summary"]["assistant_latency_ms"]["mean"]),
        "coaching_eval_mean_speech_chars": round(statistics.mean(speech_char_counts), 1),
        "coaching_eval_mean_speech_words": round(statistics.mean(speech_word_counts), 1),
    }


def compute_mode_bandwidth(mode_name: str, fps: float, max_dim_px: int, jpeg_quality: float, frame_mean_bytes: float) -> dict:
    frame_count = round(CHECK_DURATION_S * fps)
    frames_raw_bytes = frame_count * frame_mean_bytes

    uplink_pcm_bytes_per_s = UPLINK_AUDIO_HZ * PCM16_BYTES_PER_SAMPLE
    downlink_pcm_bytes_per_s = DOWNLINK_AUDIO_HZ * PCM16_BYTES_PER_SAMPLE

    uplink_12s_bytes = CHECK_DURATION_S * uplink_pcm_bytes_per_s
    downlink_typical_bytes = TYPICAL_ASSISTANT_SPEECH_S * downlink_pcm_bytes_per_s
    downlink_ceiling_12s_bytes = CHECK_DURATION_S * downlink_pcm_bytes_per_s

    total_raw_typical_bytes = frames_raw_bytes + uplink_12s_bytes + downlink_typical_bytes
    total_raw_ceiling_12s_bytes = frames_raw_bytes + uplink_12s_bytes + downlink_ceiling_12s_bytes

    uplink_chunks = round(CHECK_DURATION_S / PCM_CHUNK_DURATION_S)
    downlink_typical_chunks = round(TYPICAL_ASSISTANT_SPEECH_S / PCM_CHUNK_DURATION_S)
    pcm_uplink_chunk_bytes = round(uplink_pcm_bytes_per_s * PCM_CHUNK_DURATION_S)
    pcm_downlink_chunk_bytes = round(downlink_pcm_bytes_per_s * PCM_CHUNK_DURATION_S)

    ws_frames_bytes = frame_count * (b64_encoded_bytes(round(frame_mean_bytes)) + WS_JSON_ENVELOPE_BYTES)
    ws_uplink_bytes = uplink_chunks * (b64_encoded_bytes(pcm_uplink_chunk_bytes) + WS_JSON_ENVELOPE_BYTES)
    ws_downlink_typical_bytes = downlink_typical_chunks * (b64_encoded_bytes(pcm_downlink_chunk_bytes) + WS_JSON_ENVELOPE_BYTES)
    ws_total_typical_bytes = ws_frames_bytes + ws_uplink_bytes + ws_downlink_typical_bytes

    server_to_gemini_verify_bytes = VERIFY_SHARPEST_FRAMES * frame_mean_bytes

    return {
        "mode": mode_name,
        "fps": fps,
        "max_dim_px": max_dim_px,
        "jpeg_quality": jpeg_quality,
        "frames_sent_in_12s": frame_count,
        "mean_frame_bytes": round(frame_mean_bytes, 2),
        "jpeg_frames_kb": round(frames_raw_bytes / 1000.0, 2),
        "jpeg_frames_kib": round(frames_raw_bytes / 1024.0, 2),
        "pcm16_16khz_uplink_12s_kb": round(uplink_12s_bytes / 1000.0, 2),
        "pcm16_16khz_uplink_12s_kib": round(uplink_12s_bytes / 1024.0, 2),
        "pcm16_24khz_downlink_typical_5s_kb": round(downlink_typical_bytes / 1000.0, 2),
        "pcm16_24khz_downlink_typical_5s_kib": round(downlink_typical_bytes / 1024.0, 2),
        "pcm16_24khz_downlink_ceiling_12s_kb": round(downlink_ceiling_12s_bytes / 1000.0, 2),
        "pcm16_24khz_downlink_ceiling_12s_kib": round(downlink_ceiling_12s_bytes / 1024.0, 2),
        "total_raw_media_typical_kb": round(total_raw_typical_bytes / 1000.0, 2),
        "total_raw_media_typical_kib": round(total_raw_typical_bytes / 1024.0, 2),
        "total_raw_media_ceiling_12s_kb": round(total_raw_ceiling_12s_bytes / 1000.0, 2),
        "total_raw_media_ceiling_12s_kib": round(total_raw_ceiling_12s_bytes / 1024.0, 2),
        "websocket_base64_wire_typical_kb": round(ws_total_typical_bytes / 1000.0, 2),
        "websocket_base64_wire_typical_kib": round(ws_total_typical_bytes / 1024.0, 2),
        "average_raw_bitrate_typical_kbps": round((total_raw_typical_bytes * 8.0) / CHECK_DURATION_S / 1000.0, 1),
        "average_raw_bitrate_ceiling_12s_kbps": round((total_raw_ceiling_12s_bytes * 8.0) / CHECK_DURATION_S / 1000.0, 1),
        "client_extra_verify_upload_kb": 0.0,
        "server_to_gemini_verify_2_frames_kb": round(server_to_gemini_verify_bytes / 1000.0, 2),
        "monthly_120_checks_raw_typical_mb": round((total_raw_typical_bytes * CHECKS_PER_MONTH) / 1_000_000.0, 2),
        "monthly_120_checks_ws_wire_typical_mb": round((ws_total_typical_bytes * CHECKS_PER_MONTH) / 1_000_000.0, 2),
    }


def compute_bandwidth_section(fixture_stats: dict) -> dict:
    normal_mean = fixture_stats["normal_768px"]["mean_bytes"]
    adaptive_mean = fixture_stats["adaptive_512px_q50"]["mean_bytes"]

    normal = compute_mode_bandwidth("normal_1fps_768px", NORMAL_FPS, NORMAL_MAX_DIM_PX, NORMAL_JPEG_QUALITY, normal_mean)
    adaptive = compute_mode_bandwidth(
        "slow_network_adaptive_0_5fps_512px",
        ADAPTIVE_FPS,
        ADAPTIVE_MAX_DIM_PX,
        ADAPTIVE_JPEG_QUALITY_PIL / 100.0,
        adaptive_mean,
    )

    snapshot_raw_bytes = VERIFY_SHARPEST_FRAMES * adaptive_mean
    snapshot_wire_bytes = VERIFY_SHARPEST_FRAMES * b64_encoded_bytes(round(adaptive_mean)) + 420

    video_reduction_pct = round(
        (1.0 - (adaptive["jpeg_frames_kb"] / normal["jpeg_frames_kb"])) * 100.0,
        1,
    )
    total_typical_reduction_pct = round(
        (1.0 - (adaptive["total_raw_media_typical_kb"] / normal["total_raw_media_typical_kb"])) * 100.0,
        1,
    )
    total_ceiling_reduction_pct = round(
        (1.0 - (adaptive["total_raw_media_ceiling_12s_kb"] / normal["total_raw_media_ceiling_12s_kb"])) * 100.0,
        1,
    )

    return {
        "units": {
            "kb_definition": "1 KB = 1,000 bytes (SI decimal kilobyte); KiB = 1,024 bytes also reported",
            "check_duration_s": CHECK_DURATION_S,
            "uplink_audio_formula": "16,000 Hz * 2 bytes (PCM16 mono) = 32.0 KB/s (384.0 KB per 12 s check)",
            "downlink_audio_formula": (
                "24,000 Hz * 2 bytes (PCM16 mono) = 48.0 KB/s; "
                "typical 5.0 s spoken coaching + verdict = 240.0 KB (continuous 12.0 s ceiling = 576.0 KB)"
            ),
            "verify_ring_buffer_note": (
                "verify_label selects the 2 sharpest recent frames from Hub.ring in server RAM, "
                "requiring 0 KB extra phone-to-server upload"
            ),
        },
        "normal_mode": normal,
        "slow_network_adaptive_mode": {
            **adaptive,
            "rtt_trigger_threshold_ms": ADAPTIVE_RTT_TRIGGER_MS,
            "video_bandwidth_reduction_vs_normal_pct": video_reduction_pct,
            "total_typical_bandwidth_reduction_vs_normal_pct": total_typical_reduction_pct,
            "total_ceiling_bandwidth_reduction_vs_normal_pct": total_ceiling_reduction_pct,
        },
        "degraded_fallbacks": {
            "snapshot_http_verify_2_adaptive_frames": {
                "raw_kb": round(snapshot_raw_bytes / 1000.0, 2),
                "json_wire_kb": round(snapshot_wire_bytes / 1000.0, 2),
                "monthly_120_checks_mb": round((snapshot_wire_bytes * CHECKS_PER_MONTH) / 1_000_000.0, 2),
                "audio_bandwidth_kb": 0.0,
                "mechanism": "POST /api/verify with 2 adaptive 512px frames + on-device browser speechSynthesis",
            },
            "offline_barcode_detector": {
                "raw_kb": 0.0,
                "monthly_120_checks_mb": 0.0,
                "mechanism": "On-device BarcodeDetector matched against localStorage Profile.meds[].barcode",
            },
        },
    }


def evaluate_tier_cost(tokens: dict, rates: dict, apply_static_cache: bool) -> dict:
    cache_discount = STATIC_PROMPT_CACHE_HIT_RATIO if apply_static_cache else 0.0

    live_static_eff = tokens["live_static_text_in"] * (
        cache_discount * rates["cached_text_in_per_1m_usd"]
        + (1.0 - cache_discount) * rates["live_text_in_per_1m_usd"]
    )
    live_dyn_cost = tokens["live_dynamic_text_in"] * rates["live_text_in_per_1m_usd"]
    live_vid_normal_cost = tokens["live_video_in_normal_1fps"] * rates["live_video_in_per_1m_usd"]
    live_vid_adaptive_cost = tokens["live_video_in_adaptive_0_5fps"] * rates["live_video_in_per_1m_usd"]
    live_aud_in_cost = tokens["live_audio_in_12s"] * rates["live_audio_in_per_1m_usd"]
    live_aud_out_cost = tokens["live_audio_out_5s"] * rates["live_audio_out_per_1m_usd"]
    live_txt_out_cost = tokens["live_tool_text_out"] * rates["live_text_out_per_1m_usd"]

    verify_static_eff = tokens["verify_static_text_in"] * (
        cache_discount * rates["cached_text_in_per_1m_usd"]
        + (1.0 - cache_discount) * rates["verify_in_per_1m_usd"]
    )
    verify_dyn_cost = (
        tokens["verify_question_text_in"] + tokens["verify_images_in_2_frames"]
    ) * rates["verify_in_per_1m_usd"]
    verify_out_cost = tokens["verify_json_and_thinking_out"] * rates["verify_out_per_1m_usd"]

    live_normal_usd = (
        live_static_eff + live_dyn_cost + live_vid_normal_cost + live_aud_in_cost + live_aud_out_cost + live_txt_out_cost
    ) / 1_000_000.0
    live_adaptive_usd = (
        live_static_eff + live_dyn_cost + live_vid_adaptive_cost + live_aud_in_cost + live_aud_out_cost + live_txt_out_cost
    ) / 1_000_000.0
    verify_usd = (verify_static_eff + verify_dyn_cost + verify_out_cost) / 1_000_000.0

    check_normal_usd = live_normal_usd + verify_usd
    check_adaptive_usd = live_adaptive_usd + verify_usd
    check_normal_eur = check_normal_usd * USD_TO_EUR
    check_adaptive_eur = check_adaptive_usd * USD_TO_EUR

    monthly_normal_usd = check_normal_usd * CHECKS_PER_MONTH
    monthly_normal_eur = check_normal_eur * CHECKS_PER_MONTH
    monthly_adaptive_eur = check_adaptive_eur * CHECKS_PER_MONTH

    annual_normal_usd = check_normal_usd * CHECKS_PER_YEAR
    annual_normal_eur = check_normal_eur * CHECKS_PER_YEAR
    annual_adaptive_eur = check_adaptive_eur * CHECKS_PER_YEAR
    annual_blended_barcode_eur = annual_normal_eur * (1.0 - DAILY_SAVED_BARCODE_LOCAL_RATIO)

    return {
        "rates_per_1m_tokens_usd": rates,
        "implicit_prompt_cache_hit_ratio": cache_discount,
        "per_check_breakdown_usd": {
            "live_session_normal_1fps": round(live_normal_usd, 6),
            "live_session_adaptive_0_5fps": round(live_adaptive_usd, 6),
            "verify_label_2_frames_flash": round(verify_usd, 6),
            "total_normal_1fps": round(check_normal_usd, 6),
            "total_adaptive_0_5fps": round(check_adaptive_usd, 6),
        },
        "per_check_eur": {
            "normal_1fps": round(check_normal_eur, 5),
            "adaptive_0_5fps": round(check_adaptive_eur, 5),
        },
        "monthly_120_checks": {
            "normal_usd": round(monthly_normal_usd, 2),
            "normal_eur": round(monthly_normal_eur, 2),
            "adaptive_eur": round(monthly_adaptive_eur, 2),
            "blended_30pct_local_barcode_eur": round(monthly_normal_eur * (1.0 - DAILY_SAVED_BARCODE_LOCAL_RATIO), 2),
        },
        "annual_1440_checks": {
            "normal_usd": round(annual_normal_usd, 2),
            "normal_eur": round(annual_normal_eur, 2),
            "adaptive_eur": round(annual_adaptive_eur, 2),
            "blended_30pct_local_barcode_eur": round(annual_blended_barcode_eur, 2),
        },
        "three_year_4320_checks_cloud_eur": {
            "normal_all_cloud": round(annual_normal_eur * TCO_YEARS, 2),
            "adaptive_all_cloud": round(annual_adaptive_eur * TCO_YEARS, 2),
            "blended_30pct_local_barcode": round(annual_blended_barcode_eur * TCO_YEARS, 2),
        },
    }


def compute_token_and_cost_section(prompt_stats: dict) -> dict:
    live_static_tokens = (
        prompt_stats["live_system_prompt_est_tokens"]
        + TOOLS_DECLARATION_EST_TOKENS
        + COMPACT_PROFILE_EST_TOKENS
    )
    verify_static_tokens = (
        prompt_stats["verify_prompt_est_tokens"]
        + prompt_stats["label_schema_est_tokens"]
    )

    tokens = {
        "live_static_text_in": live_static_tokens,
        "live_dynamic_text_in": LIVE_DYNAMIC_TURN_TEXT_IN_TOKENS,
        "live_video_in_normal_1fps": round(CHECK_DURATION_S * NORMAL_FPS) * GEMINI_TOKENS_PER_FRAME,
        "live_video_in_adaptive_0_5fps": round(CHECK_DURATION_S * ADAPTIVE_FPS) * GEMINI_TOKENS_PER_FRAME,
        "live_audio_in_12s": round(CHECK_DURATION_S * GEMINI_TOKENS_PER_AUDIO_S),
        "live_audio_out_5s": round(TYPICAL_ASSISTANT_SPEECH_S * GEMINI_TOKENS_PER_AUDIO_S),
        "live_tool_text_out": LIVE_TOOL_CALL_TEXT_OUT_TOKENS,
        "verify_static_text_in": verify_static_tokens,
        "verify_question_text_in": VERIFY_QUESTION_TEXT_IN_TOKENS,
        "verify_images_in_2_frames": VERIFY_SHARPEST_FRAMES * GEMINI_TOKENS_PER_FRAME,
        "verify_images_in_3_frames_cap": VERIFY_MAX_FRAMES * GEMINI_TOKENS_PER_FRAME,
        "verify_json_and_thinking_out": VERIFY_STRUCTURED_JSON_AND_LOW_THINKING_OUT_TOKENS,
    }
    tokens["total_input_tokens_normal_1fps"] = (
        tokens["live_static_text_in"]
        + tokens["live_dynamic_text_in"]
        + tokens["live_video_in_normal_1fps"]
        + tokens["live_audio_in_12s"]
        + tokens["verify_static_text_in"]
        + tokens["verify_question_text_in"]
        + tokens["verify_images_in_2_frames"]
    )
    tokens["total_input_tokens_adaptive_0_5fps"] = (
        tokens["total_input_tokens_normal_1fps"]
        - tokens["live_video_in_normal_1fps"]
        + tokens["live_video_in_adaptive_0_5fps"]
    )
    tokens["total_output_tokens_per_check"] = (
        tokens["live_audio_out_5s"]
        + tokens["live_tool_text_out"]
        + tokens["verify_json_and_thinking_out"]
    )
    tokens["total_tokens_per_check_normal_1fps"] = (
        tokens["total_input_tokens_normal_1fps"] + tokens["total_output_tokens_per_check"]
    )
    tokens["total_tokens_per_check_adaptive_0_5fps"] = (
        tokens["total_input_tokens_adaptive_0_5fps"] + tokens["total_output_tokens_per_check"]
    )

    tiers = {
        "gemini_flash_standard_cached": {
            "description": (
                "Published Gemini 2.5 Flash Paid Tier multimodal rates with 75% implicit prompt caching "
                "on static live.md + verify_prompt.md + label_schema.json prefixes"
            ),
            **evaluate_tier_cost(
                tokens,
                {
                    "live_text_in_per_1m_usd": 0.30,
                    "cached_text_in_per_1m_usd": 0.075,
                    "live_video_in_per_1m_usd": 0.30,
                    "live_audio_in_per_1m_usd": 1.00,
                    "live_audio_out_per_1m_usd": 4.00,
                    "live_text_out_per_1m_usd": 2.50,
                    "verify_in_per_1m_usd": 0.30,
                    "verify_out_per_1m_usd": 2.50,
                },
                apply_static_cache=True,
            ),
        },
        "gemini_flash_economy_2_0_live": {
            "description": "Published Gemini 2.0 Flash / Flash-Lite Multimodal Live Paid Tier rates",
            **evaluate_tier_cost(
                tokens,
                {
                    "live_text_in_per_1m_usd": 0.15,
                    "cached_text_in_per_1m_usd": 0.0375,
                    "live_video_in_per_1m_usd": 0.15,
                    "live_audio_in_per_1m_usd": 0.70,
                    "live_audio_out_per_1m_usd": 2.80,
                    "live_text_out_per_1m_usd": 0.60,
                    "verify_in_per_1m_usd": 0.15,
                    "verify_out_per_1m_usd": 0.60,
                },
                apply_static_cache=False,
            ),
        },
        "gemini_live_native_audio_uncached_ceiling": {
            "description": (
                "Conservative zero-cache ceiling: Gemini 2.5 Flash Native-Audio Live ($0.50 text / "
                "$1.00 image-video / $3.00 audio-in / $12.00 native audio-out) + uncached 2.5 Flash verify"
            ),
            **evaluate_tier_cost(
                tokens,
                {
                    "live_text_in_per_1m_usd": 0.50,
                    "cached_text_in_per_1m_usd": 0.50,
                    "live_video_in_per_1m_usd": 1.00,
                    "live_audio_in_per_1m_usd": 3.00,
                    "live_audio_out_per_1m_usd": 12.00,
                    "live_text_out_per_1m_usd": 2.00,
                    "verify_in_per_1m_usd": 0.30,
                    "verify_out_per_1m_usd": 2.50,
                },
                apply_static_cache=False,
            ),
        },
    }

    return {
        "usage_cadence": {
            "checks_per_day": CHECKS_PER_DAY,
            "checks_per_month": CHECKS_PER_MONTH,
            "checks_per_year": CHECKS_PER_YEAR,
            "checks_over_3_years": CHECKS_PER_YEAR * TCO_YEARS,
            "usd_to_eur_rate": USD_TO_EUR,
            "published_tokenization_rates": {
                "video_or_image_frame_tokens": GEMINI_TOKENS_PER_FRAME,
                "pcm_audio_tokens_per_second": GEMINI_TOKENS_PER_AUDIO_S,
                "text_chars_per_token_approx": 4.0,
            },
        },
        "per_check_tokens": tokens,
        "published_pricing_tiers": tiers,
    }


def compute_tco_comparison(token_cost_section: dict) -> dict:
    tiers = token_cost_section["published_pricing_tiers"]
    std_tier = tiers["gemini_flash_standard_cached"]
    econ_tier = tiers["gemini_flash_economy_2_0_live"]
    ceil_tier = tiers["gemini_live_native_audio_uncached_ceiling"]

    rayban_hw_eur = 329.00
    holdup_annual_cloud_std_eur = std_tier["annual_1440_checks"]["normal_eur"]
    holdup_annual_cloud_blended_eur = std_tier["annual_1440_checks"]["blended_30pct_local_barcode_eur"]
    holdup_annual_cloud_econ_eur = econ_tier["annual_1440_checks"]["normal_eur"]
    holdup_annual_cloud_ceil_eur = ceil_tier["annual_1440_checks"]["normal_eur"]

    holdup_3yr_std_eur = round(rayban_hw_eur + std_tier["three_year_4320_checks_cloud_eur"]["normal_all_cloud"], 2)
    holdup_3yr_blended_eur = round(
        rayban_hw_eur + std_tier["three_year_4320_checks_cloud_eur"]["blended_30pct_local_barcode"], 2
    )
    holdup_3yr_econ_eur = round(rayban_hw_eur + econ_tier["three_year_4320_checks_cloud_eur"]["normal_all_cloud"], 2)
    holdup_3yr_ceil_eur = round(rayban_hw_eur + ceil_tier["three_year_4320_checks_cloud_eur"]["normal_all_cloud"], 2)

    orcam_low_eur = 3800.00
    orcam_mid_eur = 4150.00
    orcam_high_eur = 4500.00

    aira_entry_monthly_eur = 27.00
    aira_daily_meds_monthly_eur = 65.00
    aira_3yr_entry_phone_only_eur = round(aira_entry_monthly_eur * MONTHS_PER_YEAR * TCO_YEARS, 2)
    aira_3yr_daily_phone_only_eur = round(aira_daily_meds_monthly_eur * MONTHS_PER_YEAR * TCO_YEARS, 2)
    aira_3yr_daily_with_glasses_eur = round(aira_3yr_daily_phone_only_eur + rayban_hw_eur, 2)

    total_3yr_checks = CHECKS_PER_YEAR * TCO_YEARS
    savings_vs_orcam_mid_eur = round(orcam_mid_eur - holdup_3yr_std_eur, 2)
    savings_vs_orcam_mid_pct = round((1.0 - (holdup_3yr_std_eur / orcam_mid_eur)) * 100.0, 1)
    savings_vs_aira_daily_pct = round((1.0 - (holdup_3yr_std_eur / aira_3yr_daily_phone_only_eur)) * 100.0, 1)

    pilot_users = 100
    pilot_holdup_3yr_eur = round(holdup_3yr_std_eur * pilot_users, 2)
    pilot_orcam_3yr_eur = round(orcam_mid_eur * pilot_users, 2)

    return {
        "horizon_years": TCO_YEARS,
        "total_checks_over_horizon": total_3yr_checks,
        "options": {
            "holdup_consumer_rayban_meta_gen2": {
                "label": "HoldUp + Consumer Ray-Ban Meta Gen 2",
                "hardware_upfront_eur": rayban_hw_eur,
                "annual_cloud_inference_eur": {
                    "economy_flash_live": holdup_annual_cloud_econ_eur,
                    "blended_daily_pilot_with_barcode": holdup_annual_cloud_blended_eur,
                    "standard_cached_100pct_cloud": holdup_annual_cloud_std_eur,
                    "uncached_native_audio_ceiling": holdup_annual_cloud_ceil_eur,
                },
                "three_year_tco_eur": {
                    "economy_flash_live": holdup_3yr_econ_eur,
                    "blended_daily_pilot_with_barcode": holdup_3yr_blended_eur,
                    "standard_cached_100pct_cloud": holdup_3yr_std_eur,
                    "uncached_native_audio_ceiling": holdup_3yr_ceil_eur,
                },
                "effective_monthly_tco_standard_eur": round(holdup_3yr_std_eur / (MONTHS_PER_YEAR * TCO_YEARS), 2),
                "all_in_cost_per_check_standard_eur": round(holdup_3yr_std_eur / total_3yr_checks, 4),
                "privacy_and_ux_profile": (
                    "Hands-free mainstream eyewear with zero assistive stigma; medication list stays in "
                    "on-device localStorage; zero human stranger sees prescriptions; deterministic "
                    "STRENGTH_MIN_CONF >= 0.80 safety gate refuses to guess doses"
                ),
            },
            "dedicated_assistive_camera_orcam_class": {
                "label": "Dedicated Proprietary Assistive Camera (OrCam MyEye class)",
                "hardware_upfront_eur_range": [orcam_low_eur, orcam_high_eur],
                "hardware_upfront_eur_midpoint": orcam_mid_eur,
                "annual_subscription_eur": 0.0,
                "three_year_tco_eur_range": [orcam_low_eur, orcam_high_eur],
                "three_year_tco_eur_midpoint": orcam_mid_eur,
                "effective_monthly_tco_midpoint_eur": round(orcam_mid_eur / (MONTHS_PER_YEAR * TCO_YEARS), 2),
                "all_in_cost_per_check_midpoint_eur": round(orcam_mid_eur / total_3yr_checks, 4),
                "holdup_savings_vs_midpoint_eur": savings_vs_orcam_mid_eur,
                "holdup_savings_vs_midpoint_pct": savings_vs_orcam_mid_pct,
                "holdup_cost_reduction_multiple": round(orcam_mid_eur / holdup_3yr_std_eur, 1),
                "limitations": (
                    "11x to 13x higher upfront hardware barrier; raw OCR text dump with no personal "
                    "medication schedule or allergy cross-check; no conversational body-relative "
                    "alignment coaching; specialized clip-on hardware stigma"
                ),
            },
            "human_video_volunteer_or_paid_agent_aira_class": {
                "label": "Human Video Volunteer / Paid Visual Interpreter (Aira / Be My Eyes class)",
                "paid_agent_subscription": {
                    "entry_plan_monthly_eur": aira_entry_monthly_eur,
                    "daily_meds_180min_plan_monthly_eur": aira_daily_meds_monthly_eur,
                    "three_year_tco_entry_phone_only_eur": aira_3yr_entry_phone_only_eur,
                    "three_year_tco_daily_phone_only_eur": aira_3yr_daily_phone_only_eur,
                    "three_year_tco_daily_with_glasses_eur": aira_3yr_daily_with_glasses_eur,
                    "holdup_savings_vs_daily_plan_pct": savings_vs_aira_daily_pct,
                },
                "unpaid_volunteer_video_call": {
                    "direct_subscription_eur": 0.0,
                    "intimate_disclosures_per_year": CHECKS_PER_YEAR,
                    "typical_call_setup_latency_s_range": [30, 90],
                    "privacy_and_independence_tradeoff": (
                        "Exposes private prescription boxes, patient name stickers, and home counters to "
                        "1,440 live video strangers per year; requires two hands when holding phone + pill "
                        "box; social friction at night or early morning"
                    ),
                },
            },
        },
        "rehabilitation_pilot_100_users_3yr": {
            "cohort_size_users": pilot_users,
            "holdup_plus_rayban_gen2_total_eur": pilot_holdup_3yr_eur,
            "orcam_class_midpoint_total_eur": pilot_orcam_3yr_eur,
            "public_budget_saved_eur": round(pilot_orcam_3yr_eur - pilot_holdup_3yr_eur, 2),
            "users_served_per_100_orcam_budget": int(pilot_orcam_3yr_eur // holdup_3yr_std_eur),
        },
    }


def build_report() -> dict:
    fixture_stats = measure_fixtures()
    prompt_stats = measure_prompts_and_eval()
    bandwidth = compute_bandwidth_section(fixture_stats)
    token_cost = compute_token_and_cost_section(prompt_stats)
    tco = compute_tco_comparison(token_cost)

    std_tier = token_cost["published_pricing_tiers"]["gemini_flash_standard_cached"]
    econ_tier = token_cost["published_pricing_tiers"]["gemini_flash_economy_2_0_live"]
    ceil_tier = token_cost["published_pricing_tiers"]["gemini_live_native_audio_uncached_ceiling"]
    holdup_tco = tco["options"]["holdup_consumer_rayban_meta_gen2"]
    orcam_tco = tco["options"]["dedicated_assistive_camera_orcam_class"]
    aira_tco = tco["options"]["human_video_volunteer_or_paid_agent_aira_class"]

    mean_normal_bytes = fixture_stats["normal_768px"]["mean_bytes"]
    mean_adaptive_bytes = fixture_stats["adaptive_512px_q50"]["mean_bytes"]

    headline_summary = {
        "check_duration_s": CHECK_DURATION_S,
        "normal_1fps_check_bandwidth_kb": bandwidth["normal_mode"]["total_raw_media_typical_kb"],
        "slow_network_adaptive_0_5fps_check_bandwidth_kb": bandwidth["slow_network_adaptive_mode"][
            "total_raw_media_typical_kb"
        ],
        "video_bandwidth_saved_in_adaptive_mode_pct": bandwidth["slow_network_adaptive_mode"][
            "video_bandwidth_reduction_vs_normal_pct"
        ],
        "total_bandwidth_saved_in_adaptive_mode_pct": bandwidth["slow_network_adaptive_mode"][
            "total_typical_bandwidth_reduction_vs_normal_pct"
        ],
        "per_check_gemini_cost_eur_standard": std_tier["per_check_eur"]["normal_1fps"],
        "per_check_gemini_cost_usd_standard": round(std_tier["per_check_breakdown_usd"]["total_normal_1fps"], 5),
        "monthly_120_checks_gemini_cost_eur_standard": std_tier["monthly_120_checks"]["normal_eur"],
        "annual_1440_checks_cloud_eur_pilot_band": (
            f"{econ_tier['annual_1440_checks']['normal_eur']:.2f} to "
            f"{std_tier['annual_1440_checks']['normal_eur']:.2f} EUR/year "
            f"(uncached native-audio ceiling: {ceil_tier['annual_1440_checks']['normal_eur']:.2f} EUR/year)"
        ),
        "tco_3yr_holdup_rayban_meta_gen2_eur": holdup_tco["three_year_tco_eur"]["standard_cached_100pct_cloud"],
        "tco_3yr_orcam_myeye_midpoint_eur": orcam_tco["three_year_tco_eur_midpoint"],
        "tco_3yr_aira_paid_daily_plan_eur": aira_tco["paid_agent_subscription"]["three_year_tco_daily_phone_only_eur"],
        "tco_savings_vs_orcam_midpoint_pct": orcam_tco["holdup_savings_vs_midpoint_pct"],
        "tco_cost_reduction_multiple_vs_orcam": orcam_tco["holdup_cost_reduction_multiple"],
    }

    return {
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "generated_by": "eval/unit_economics.py",
        "measured_fixture_count": fixture_stats["count"],
        "measured_fixture_mean_bytes": mean_normal_bytes,
        "measured_fixture_mean_kb": fixture_stats["normal_768px"]["mean_kb"],
        "measured_adaptive_512px_q50_mean_bytes": mean_adaptive_bytes,
        "measured_adaptive_512px_q50_mean_kb": fixture_stats["adaptive_512px_q50"]["mean_kb"],
        "headline_summary": headline_summary,
        "measured_payloads": {
            "fixtures": fixture_stats,
            "prompts_schema_and_coaching_eval": prompt_stats,
        },
        "bandwidth_per_12s_check": bandwidth,
        "token_and_cost_model": token_cost,
        "three_year_tco_comparison": tco,
    }


def main() -> None:
    report = build_report()
    serialized = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if "\u2014" in serialized or "\u2013" in serialized:
        raise ValueError("Forbidden dash character detected in generated output")
    OUT_JSON_PATH.write_text(serialized, encoding="utf-8")
    print(f"Wrote {OUT_JSON_PATH.relative_to(REPO_ROOT)}")
    print(json.dumps(report["headline_summary"], indent=2))


if __name__ == "__main__":
    main()
