import argparse
import array
import datetime
import io
import json
import math
import os
import pathlib
import selectors
import shutil
import statistics
import struct
import subprocess
import sys
import tempfile
import threading
import time
import wave
from typing import Any

import requests

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
DEFAULT_OUT_PATH = REPO_ROOT / "eval" / "tts_multilingual_audio.json"

MIN_DURATION_S = 0.4
MAX_DURATION_S = 20.0
EXPECTED_SAMPLE_RATE_HZ = 24000
EXPECTED_CHANNELS = 1
EXPECTED_BITS_PER_SAMPLE = 16
LANGUAGES_TESTED = ["en", "fi", "sv"]

UTTERANCE_SPECS: list[dict[str, str]] = [
    {
        "id": "tts_01_en_match_evening_pill",
        "language": "en",
        "lang_tag": "en-US",
        "verdict_level": "match",
        "scenario": "evening_pill_match_en",
        "text": "Yes, Amlodipine 5 mg, your evening pill. You haven't taken it today.",
    },
    {
        "id": "tts_02_en_warning_nsaid",
        "language": "en",
        "lang_tag": "en-US",
        "verdict_level": "warning",
        "scenario": "nsaid_avoid_warning_en",
        "text": "This is Ibuprofen 400 mg. It isn't on your medication list and your list says to avoid NSAIDs.",
    },
    {
        "id": "tts_03_en_unsure_strength_occluded",
        "language": "en",
        "lang_tag": "en-US",
        "verdict_level": "unsure",
        "scenario": "strength_occluded_unsure_en",
        "text": "It looks like Amlodipine, but I can't read the strength confidently. Turn the box so the side panel faces you, or ask a pharmacist.",
    },
    {
        "id": "tts_04_en_warning_hazelnut_allergen",
        "language": "en",
        "lang_tag": "en-US",
        "verdict_level": "warning",
        "scenario": "hazelnut_allergen_warning_en",
        "text": "Warning: Nordic Oat and Hazelnut Bar contains roasted hazelnuts and arachis oil. Your profile lists an allergy to tree nuts and peanut.",
    },
    {
        "id": "tts_05_fi_match_evening_pill",
        "language": "fi",
        "lang_tag": "fi-FI",
        "verdict_level": "match",
        "scenario": "evening_pill_confirmation_fi",
        "text": "Kyllä, tämä on Amlodipin 5 mg, sinun iltalääkkeesi. Et ole vielä ottanut sitä tänään.",
    },
    {
        "id": "tts_06_sv_match_evening_pill",
        "language": "sv",
        "lang_tag": "sv-SE",
        "verdict_level": "match",
        "scenario": "evening_pill_confirmation_sv",
        "text": "Ja, det här är Amlodipin 5 mg, din kvällsmedicin. Du har inte tagit den idag.",
    },
]

SERVER_BOOT_JS = "\n".join(
    [
        'import http from "node:http";',
        'import https from "node:https";',
        'import "./server/src/gemini.ts";',
        'import { startServer } from "./server/src/index.ts";',
        'const hasNativeEnvProxy = typeof http.setGlobalProxyFromEnv === "function";',
        "const hasProxyEnv = Boolean(",
        "  process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy",
        ");",
        "if (!hasNativeEnvProxy && hasProxyEnv) {",
        "  globalThis.fetch = async (input, init) => {",
        '    const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);',
        "    const headers = {};",
        "    new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).forEach((v, k) => {",
        "      headers[k] = v;",
        "    });",
        '    const mod = url.protocol === "https:" ? https : http;',
        "    return await new Promise((resolve, reject) => {",
        '      if (init?.signal?.aborted) { reject(new Error("AbortError")); return; }',
        "      const req = mod.request(",
        '        url, { method: init?.method ?? (input instanceof Request ? input.method : "GET"), headers },',
        "        (res) => {",
        "          const chunks = [];",
        "          res.on(\"data\", (c) => chunks.push(Buffer.from(c)));",
        "          res.on(\"end\", () => {",
        "            const respHeaders = new Headers();",
        "            for (const [k, v] of Object.entries(res.headers)) {",
        '              if (Array.isArray(v)) respHeaders.set(k, v.join(", "));',
        "              else if (v !== undefined) respHeaders.set(k, v);",
        "            }",
        "            resolve(new Response(Buffer.concat(chunks), {",
        '              status: res.statusCode ?? 500, statusText: res.statusMessage ?? "", headers: respHeaders,',
        "            }));",
        "          });",
        '          res.on("error", reject);',
        "        }",
        "      );",
        '      if (init?.signal) init.signal.addEventListener("abort", () => req.destroy(new Error("AbortError")), { once: true });',
        '      req.on("error", reject);',
        '      if (typeof init?.body === "string" || Buffer.isBuffer(init?.body) || init?.body instanceof Uint8Array) {',
        "        req.write(init.body);",
        "      }",
        "      req.end();",
        "    });",
        "  };",
        "}",
        "const srv = await startServer(0);",
        "const addr = srv.address();",
        'const port = typeof addr === "object" && addr ? addr.port : 0;',
        'process.stdout.write("HOLDUP_PORT=" + String(port) + "\\n");',
        "const stop = () => { srv.closeAllConnections?.(); srv.close(() => process.exit(0)); setTimeout(() => process.exit(0), 500).unref(); };",
        'process.on("SIGTERM", stop);',
        'process.on("SIGINT", stop);',
    ]
)


def sanitize_obj(val: Any) -> Any:
    if isinstance(val, str):
        return val.replace("\u2014", " - ").replace("\u2013", "-")
    if isinstance(val, list):
        return [sanitize_obj(item) for item in val]
    if isinstance(val, dict):
        return {sanitize_obj(k): sanitize_obj(v) for k, v in val.items()}
    return val


def parse_env_file(env_path: pathlib.Path) -> dict[str, str]:
    parsed: dict[str, str] = {}
    if not env_path.is_file():
        return parsed
    comment_prefix = chr(35)
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith(comment_prefix):
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        if "=" not in line:
            continue
        key, val = line.split("=", 1)
        key = key.strip()
        val = val.strip().strip('"').strip("'")
        if key:
            parsed[key] = val
    return parsed


def build_server_env(ledger_path: pathlib.Path) -> dict[str, str]:
    merged: dict[str, str] = {}
    home_env = pathlib.Path.home() / "momin" / ".env"
    repo_env = REPO_ROOT / ".env"

    if home_env.is_file():
        try:
            proc = subprocess.run(
                ["bash", "-c", 'set -a; . "$1"; env -0', "bash", str(home_env)],
                capture_output=True,
                check=True,
                timeout=5,
            )
            for chunk in proc.stdout.split(b"\x00"):
                if b"=" in chunk:
                    k_bytes, v_bytes = chunk.split(b"=", 1)
                    k_str = k_bytes.decode("utf-8", errors="ignore")
                    v_str = v_bytes.decode("utf-8", errors="ignore")
                    if k_str:
                        merged[k_str] = v_str
        except (OSError, subprocess.SubprocessError):
            merged.update(parse_env_file(home_env))

    for k, v in parse_env_file(repo_env).items():
        if k not in merged:
            merged[k] = v

    for k, v in os.environ.items():
        merged[k] = v

    extra_bins = [
        "/tmp/fleet-silas/node/bin",
        str(pathlib.Path.home() / ".local" / "bin"),
    ]
    path_parts = [p for p in extra_bins if os.path.isdir(p)]
    if merged.get("PATH"):
        path_parts.append(merged["PATH"])
    merged["PATH"] = os.pathsep.join(path_parts)
    merged["LEDGER_PATH"] = str(ledger_path)
    merged["HOLDUP_QUIET"] = "1"
    return merged


def resolve_node_bin(env_map: dict[str, str]) -> str:
    node_bin = shutil.which("node", path=env_map.get("PATH"))
    if not node_bin:
        raise RuntimeError("node binary not found on PATH")
    return node_bin


def start_holdup_server(
    node_bin: str, server_env: dict[str, str], startup_timeout_s: float = 25.0
) -> tuple[subprocess.Popen[str], int, list[str]]:
    proc = subprocess.Popen(
        [node_bin, "--import", "tsx", "--input-type=module", "-e", SERVER_BOOT_JS],
        cwd=str(REPO_ROOT),
        env=server_env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    assert proc.stdout is not None
    assert proc.stderr is not None

    stderr_lines: list[str] = []

    def drain_stderr() -> None:
        assert proc.stderr is not None
        for line in proc.stderr:
            stderr_lines.append(line.rstrip("\n"))

    stderr_thread = threading.Thread(target=drain_stderr, daemon=True)
    stderr_thread.start()

    sel = selectors.DefaultSelector()
    sel.register(proc.stdout, selectors.EVENT_READ)
    deadline = time.monotonic() + startup_timeout_s
    port: int | None = None

    try:
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                break
            events = sel.select(timeout=0.25)
            if not events:
                continue
            line = proc.stdout.readline()
            if not line:
                continue
            stripped = line.strip()
            if stripped.startswith("HOLDUP_PORT="):
                port = int(stripped.split("=", 1)[1])
                break
    finally:
        sel.close()

    if not port or port <= 0:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
        err_tail = "\n".join(stderr_lines[-20:])
        raise RuntimeError(f"Failed to boot HoldUp server via startServer(0). stderr:\n{err_tail}")

    def drain_stdout() -> None:
        assert proc.stdout is not None
        for _ in proc.stdout:
            pass

    stdout_thread = threading.Thread(target=drain_stdout, daemon=True)
    stdout_thread.start()
    return proc, port, stderr_lines


def stop_holdup_server(proc: subprocess.Popen[str]) -> None:
    if proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=3)


def percentile(vals: list[float], q: float) -> float | None:
    if not vals:
        return None
    xs = sorted(vals)
    if len(xs) == 1:
        return round(xs[0], 1)
    pos = (len(xs) - 1) * q
    lo = int(math.floor(pos))
    hi = int(math.ceil(pos))
    if lo == hi:
        return round(xs[lo], 1)
    frac = pos - lo
    return round(xs[lo] * (1.0 - frac) + xs[hi] * frac, 1)


def parse_wav_buffer(raw: bytes) -> dict[str, Any]:
    wav_bytes = len(raw)
    if wav_bytes < 44:
        return {
            "wav_bytes": wav_bytes,
            "header": None,
            "n_samples": 0,
            "audio_duration_s": 0.0,
            "rms_pcm16": 0.0,
            "rms_normalized": 0.0,
            "rms_dbfs": -96.0,
            "peak_pcm16": 0,
            "peak_dbfs": -96.0,
            "non_zero_sample_ratio": 0.0,
            "riff_wave_fmt_data_ok": False,
            "pcm16_mono_24khz_ok": False,
        }

    riff_magic = raw[0:4].decode("latin1")
    riff_chunk_size = struct.unpack_from("<I", raw, 4)[0]
    wave_magic = raw[8:12].decode("latin1")

    saw_fmt = False
    saw_data = False
    fmt_magic = ""
    data_magic = ""
    fmt_chunk_size = 0
    audio_format = 0
    channels = 0
    sample_rate_hz = 0
    byte_rate = 0
    block_align = 0
    bits_per_sample = 0
    pcm_bytes = b""

    offset = 12
    chunks_well_formed = True
    while offset + 8 <= wav_bytes:
        chunk_id = raw[offset : offset + 4].decode("latin1")
        chunk_size = struct.unpack_from("<I", raw, offset + 4)[0]
        payload_start = offset + 8
        payload_end = payload_start + chunk_size
        if payload_end > wav_bytes:
            chunks_well_formed = False
            break
        if chunk_id == "fmt ":
            saw_fmt = True
            fmt_magic = chunk_id
            fmt_chunk_size = chunk_size
            if chunk_size >= 16:
                (
                    audio_format,
                    channels,
                    sample_rate_hz,
                    byte_rate,
                    block_align,
                    bits_per_sample,
                ) = struct.unpack_from("<HHIIHH", raw, payload_start)
        elif chunk_id == "data":
            saw_data = True
            data_magic = chunk_id
            pcm_bytes = raw[payload_start:payload_end]
        offset = payload_end + (chunk_size % 2)

    stdlib_wave_ok = False
    try:
        with wave.open(io.BytesIO(raw), "rb") as wf:
            stdlib_wave_ok = (
                wf.getnchannels() == channels
                and wf.getsampwidth() * 8 == bits_per_sample
                and wf.getframerate() == sample_rate_hz
                and wf.getcomptype() == "NONE"
            )
    except wave.Error:
        stdlib_wave_ok = False

    pcm_data_bytes = len(pcm_bytes)
    riff_wave_fmt_data_ok = bool(
        riff_magic == "RIFF"
        and wave_magic == "WAVE"
        and riff_chunk_size == wav_bytes - 8
        and chunks_well_formed
        and saw_fmt
        and fmt_chunk_size >= 16
        and saw_data
        and pcm_data_bytes > 0
        and pcm_data_bytes % 2 == 0
        and stdlib_wave_ok
    )

    pcm16_mono_24khz_ok = bool(
        audio_format == 1
        and channels == EXPECTED_CHANNELS
        and sample_rate_hz == EXPECTED_SAMPLE_RATE_HZ
        and bits_per_sample == EXPECTED_BITS_PER_SAMPLE
        and block_align == EXPECTED_CHANNELS * (EXPECTED_BITS_PER_SAMPLE // 8)
        and byte_rate == EXPECTED_SAMPLE_RATE_HZ * EXPECTED_CHANNELS * (EXPECTED_BITS_PER_SAMPLE // 8)
    )

    n_samples = 0
    audio_duration_s = 0.0
    rms_pcm16 = 0.0
    rms_normalized = 0.0
    rms_dbfs = -96.0
    peak_pcm16 = 0
    peak_dbfs = -96.0
    non_zero_sample_ratio = 0.0

    if pcm_data_bytes >= 2 and pcm_data_bytes % 2 == 0 and sample_rate_hz > 0:
        samples = array.array("h")
        samples.frombytes(pcm_bytes)
        if sys.byteorder != "little":
            samples.byteswap()
        n_samples = len(samples)
        if n_samples > 0:
            audio_duration_s = round(n_samples / float(sample_rate_hz * max(1, channels)), 4)
            sum_sq = sum(int(s) * int(s) for s in samples)
            rms_raw = math.sqrt(sum_sq / float(n_samples))
            rms_pcm16 = round(rms_raw, 2)
            rms_normalized = round(rms_raw / 32768.0, 6)
            if rms_raw > 0.0:
                rms_dbfs = round(20.0 * math.log10(rms_raw / 32768.0), 2)
            peak_pcm16 = max(abs(int(s)) for s in samples)
            if peak_pcm16 > 0:
                peak_dbfs = round(20.0 * math.log10(peak_pcm16 / 32768.0), 2)
            non_zero_count = sum(1 for s in samples if s != 0)
            non_zero_sample_ratio = round(non_zero_count / float(n_samples), 4)

    return {
        "wav_bytes": wav_bytes,
        "header": {
            "riff_magic": riff_magic,
            "riff_chunk_size": riff_chunk_size,
            "wave_magic": wave_magic,
            "fmt_magic": fmt_magic,
            "fmt_chunk_size": fmt_chunk_size,
            "audio_format": audio_format,
            "channels": channels,
            "sample_rate_hz": sample_rate_hz,
            "byte_rate": byte_rate,
            "block_align": block_align,
            "bits_per_sample": bits_per_sample,
            "data_magic": data_magic,
            "pcm_data_bytes": pcm_data_bytes,
        },
        "n_samples": n_samples,
        "audio_duration_s": audio_duration_s,
        "rms_pcm16": rms_pcm16,
        "rms_normalized": rms_normalized,
        "rms_dbfs": rms_dbfs,
        "peak_pcm16": peak_pcm16,
        "peak_dbfs": peak_dbfs,
        "non_zero_sample_ratio": non_zero_sample_ratio,
        "riff_wave_fmt_data_ok": riff_wave_fmt_data_ok,
        "pcm16_mono_24khz_ok": pcm16_mono_24khz_ok,
    }


def read_ledger_rows(ledger_path: pathlib.Path) -> list[dict[str, Any]]:
    if not ledger_path.is_file():
        return []
    rows: list[dict[str, Any]] = []
    for line in ledger_path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        try:
            parsed = json.loads(stripped)
            if isinstance(parsed, dict):
                rows.append(parsed)
        except json.JSONDecodeError:
            continue
    return rows


def assert_clean_json_output(node: Any) -> None:
    if isinstance(node, (bytes, bytearray)):
        raise AssertionError("Raw bytes forbidden in JSON output")
    if isinstance(node, str):
        if "\u2014" in node:
            raise AssertionError(f"Forbidden em dash in output string: {node[:80]}")
        if node.startswith("UklGR") or len(node) > 1200:
            raise AssertionError("Forbidden raw WAV base64 or oversized string in JSON output")
        return
    if isinstance(node, list):
        for elem in node:
            assert_clean_json_output(elem)
        return
    if isinstance(node, dict):
        for k, v in node.items():
            assert_clean_json_output(k)
            assert_clean_json_output(v)


def run_benchmark(out_path: pathlib.Path) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="holdup_tts_eval_") as tmp_dir:
        ledger_path = pathlib.Path(tmp_dir) / "ledger.jsonl"
        server_env = build_server_env(ledger_path)
        if not server_env.get("GEMINI_API_KEY"):
            raise RuntimeError("GEMINI_API_KEY is missing from environment and $HOME/momin/.env")
        node_bin = resolve_node_bin(server_env)

        proc, port, _stderr_lines = start_holdup_server(node_bin, server_env)
        base_url = f"http://127.0.0.1:{port}"

        http_session = requests.Session()
        http_session.trust_env = False

        try:
            health_resp = http_session.get(f"{base_url}/api/health", timeout=15)
            if health_resp.status_code != 200:
                raise RuntimeError(f"GET /api/health returned HTTP {health_resp.status_code}")
            health_json = sanitize_obj(health_resp.json())
            configured_tts_models = (health_json.get("models") or {}).get("tts") or []

            items: list[dict[str, Any]] = []
            latencies: list[float] = []
            prev_ledger_len = len(read_ledger_rows(ledger_path))

            for spec in UTTERANCE_SPECS:
                resp: requests.Response | None = None
                latency_ms = 0.0
                attempts = 0
                for attempt in range(3):
                    attempts = attempt + 1
                    t0 = time.perf_counter()
                    resp = http_session.post(
                        f"{base_url}/api/tts",
                        json={"text": spec["text"]},
                        timeout=60,
                    )
                    latency_ms = round((time.perf_counter() - t0) * 1000.0, 1)
                    if resp.status_code == 200:
                        break
                    if resp.status_code in (429, 500, 502, 503, 504) and attempt < 2:
                        time.sleep(1.5 * (attempt + 1))
                        continue
                    break

                assert resp is not None
                raw_wav = resp.content if resp.status_code == 200 else b""
                content_type = resp.headers.get("Content-Type") or ""
                cache_control = resp.headers.get("Cache-Control")

                ledger_rows = read_ledger_rows(ledger_path)
                new_rows = [
                    r for r in ledger_rows[prev_ledger_len:] if r.get("feature") == "tts"
                ]
                prev_ledger_len = len(ledger_rows)

                ok_rows = [r for r in new_rows if r.get("ok") is True]
                used_model = str(ok_rows[-1].get("model")) if ok_rows else None
                tok_in = int(ok_rows[-1].get("in") or 0) if ok_rows else 0
                tok_out = int(ok_rows[-1].get("out") or 0) if ok_rows else 0
                failed_models = [str(r.get("model")) for r in new_rows if not r.get("ok")]

                wav_info = parse_wav_buffer(raw_wav)
                http_200 = resp.status_code == 200
                content_type_ok = content_type.lower().startswith("audio/wav")
                cache_control_lower = (cache_control or "").lower()
                cache_control_no_store = "no-store" in cache_control_lower
                cache_not_public = "public" not in cache_control_lower
                non_zero_rms_ok = bool(
                    wav_info["rms_pcm16"] > 0.0 and wav_info["non_zero_sample_ratio"] > 0.01
                )
                duration_in_bounds_ok = bool(
                    MIN_DURATION_S <= wav_info["audio_duration_s"] <= MAX_DURATION_S
                )

                valid_wav = bool(
                    http_200
                    and content_type_ok
                    and cache_not_public
                    and wav_info["riff_wave_fmt_data_ok"]
                    and wav_info["pcm16_mono_24khz_ok"]
                    and non_zero_rms_ok
                    and duration_in_bounds_ok
                )

                latencies.append(latency_ms)
                item_record = {
                    "id": spec["id"],
                    "language": spec["language"],
                    "lang_tag": spec["lang_tag"],
                    "verdict_level": spec["verdict_level"],
                    "scenario": spec["scenario"],
                    "text": spec["text"],
                    "char_count": len(spec["text"]),
                    "word_count": len(spec["text"].split()),
                    "attempts": attempts,
                    "http_status": resp.status_code,
                    "content_type": content_type,
                    "cache_control": cache_control,
                    "latency_ms": latency_ms,
                    "model": used_model,
                    "fallback_failed_models": failed_models,
                    "tokens_in": tok_in,
                    "tokens_out": tok_out,
                    "wav_bytes": wav_info["wav_bytes"],
                    "n_samples": wav_info["n_samples"],
                    "audio_duration_s": wav_info["audio_duration_s"],
                    "rms_pcm16": wav_info["rms_pcm16"],
                    "rms_normalized": wav_info["rms_normalized"],
                    "rms_dbfs": wav_info["rms_dbfs"],
                    "peak_pcm16": wav_info["peak_pcm16"],
                    "peak_dbfs": wav_info["peak_dbfs"],
                    "non_zero_sample_ratio": wav_info["non_zero_sample_ratio"],
                    "wav_header": wav_info["header"],
                    "checks": {
                        "http_200": http_200,
                        "content_type_audio_wav": content_type_ok,
                        "cache_control_no_store": cache_control_no_store,
                        "riff_wave_fmt_data_ok": wav_info["riff_wave_fmt_data_ok"],
                        "pcm16_mono_24khz_ok": wav_info["pcm16_mono_24khz_ok"],
                        "non_zero_rms_ok": non_zero_rms_ok,
                        "duration_in_bounds_ok": duration_in_bounds_ok,
                    },
                    "valid_wav": valid_wav,
                }
                items.append(item_record)
                print(
                    f"[{spec['id']}] lang={spec['language']} status={resp.status_code} "
                    f"model={used_model} valid_wav={valid_wav} "
                    f"dur={wav_info['audio_duration_s']:.2f}s bytes={wav_info['wav_bytes']} "
                    f"rms={wav_info['rms_pcm16']:.1f} latency_ms={latency_ms:.1f}"
                )

            stats_resp = http_session.get(f"{base_url}/api/stats", timeout=10)
            if stats_resp.status_code != 200:
                raise RuntimeError(f"GET /api/stats returned HTTP {stats_resp.status_code}")
            server_stats = sanitize_obj(stats_resp.json())
        finally:
            http_session.close()
            stop_holdup_server(proc)

    n_utterances = len(items)
    http_200_count = sum(1 for it in items if it["http_status"] == 200)
    valid_wav_count = sum(1 for it in items if it["valid_wav"])
    cache_no_store_count = sum(1 for it in items if it["checks"]["cache_control_no_store"])

    durations = [it["audio_duration_s"] for it in items if it["valid_wav"]]
    wav_sizes = [it["wav_bytes"] for it in items if it["valid_wav"]]
    rms_vals = [it["rms_pcm16"] for it in items if it["valid_wav"]]
    active_models = sorted({it["model"] for it in items if it["model"]})

    by_language: dict[str, dict[str, Any]] = {}
    for lang in LANGUAGES_TESTED:
        lang_items = [it for it in items if it["language"] == lang]
        lang_lats = [it["latency_ms"] for it in lang_items]
        lang_durs = [it["audio_duration_s"] for it in lang_items if it["valid_wav"]]
        by_language[lang] = {
            "n_utterances": len(lang_items),
            "valid_wav_count": sum(1 for it in lang_items if it["valid_wav"]),
            "latency_mean_ms": round(statistics.mean(lang_lats), 1) if lang_lats else None,
            "mean_audio_duration_s": round(statistics.mean(lang_durs), 3) if lang_durs else None,
        }

    summary: dict[str, Any] = {
        "n_utterances": n_utterances,
        "http_200_count": http_200_count,
        "valid_wav_count": valid_wav_count,
        "languages_tested": list(LANGUAGES_TESTED),
        "latency_p50_ms": percentile(latencies, 0.50),
        "latency_p95_ms": percentile(latencies, 0.95),
        "latency_mean_ms": round(statistics.mean(latencies), 1) if latencies else None,
        "mean_audio_duration_s": round(statistics.mean(durations), 3) if durations else 0.0,
        "total_audio_duration_s": round(sum(durations), 3),
        "mean_wav_bytes": round(statistics.mean(wav_sizes), 1) if wav_sizes else 0.0,
        "total_wav_bytes": sum(wav_sizes),
        "mean_rms_pcm16": round(statistics.mean(rms_vals), 2) if rms_vals else 0.0,
        "min_rms_pcm16": round(min(rms_vals), 2) if rms_vals else 0.0,
        "sample_rate_hz": EXPECTED_SAMPLE_RATE_HZ,
        "channels": EXPECTED_CHANNELS,
        "bits_per_sample": EXPECTED_BITS_PER_SAMPLE,
        "voice": server_env.get("TTS_VOICE", "Kore"),
        "configured_tts_models": configured_tts_models,
        "synthesized_by_models": active_models,
        "tokens_in": sum(it["tokens_in"] for it in items),
        "tokens_out": sum(it["tokens_out"] for it in items),
        "cache_control_no_store_count": cache_no_store_count,
        "by_language": by_language,
        "server_stats": server_stats,
    }

    report = sanitize_obj(
        {
            "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "endpoint": "POST /api/tts",
            "summary": summary,
            "items": items,
        }
    )

    assert_clean_json_output(report)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Multilingual spoken safety verdict POST /api/tts WAV synthesis benchmark"
    )
    parser.add_argument(
        "--out",
        type=pathlib.Path,
        default=DEFAULT_OUT_PATH,
        help="Path to write tts_multilingual_audio.json",
    )
    args = parser.parse_args(argv)

    report = run_benchmark(args.out)
    print(json.dumps(report["summary"], indent=2))
    if report["summary"]["valid_wav_count"] != len(UTTERANCE_SPECS):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
