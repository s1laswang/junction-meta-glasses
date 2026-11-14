"""Shared helpers for the HoldUp eval: paths, Gemini client, retries, JSON IO.

Never print or log the API key. The key is read from $GEMINI_API_KEY or from the
repo-root .env (gitignored, chmod 600 on freighter).
"""
from __future__ import annotations

import base64
import json
import os
import random
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Iterable

REPO = Path(__file__).resolve().parent.parent
EVAL_DIR = REPO / "eval"
SHARED = REPO / "shared"

# Large data lives outside the repo on freighter. Override with HOLDUP_DATA.
DATA = Path(os.environ.get("HOLDUP_DATA", str(EVAL_DIR / "synthetic")))
OUT = Path(os.environ.get("HOLDUP_OUT", str(EVAL_DIR / "out")))

SPEC_MODEL = os.environ.get("SPEC_MODEL", "gemini-3.8-flash")
IMAGE_MODELS = os.environ.get(
    "IMAGE_MODELS", "gemini-3.1-flash-image,gemini-3-pro-image,nano-banana-pro-preview"
).split(",")
CHECK_MODEL = os.environ.get("CHECK_MODEL", "gemini-3.8-flash")  # 3.1-pro-preview 404s on this key
VERIFY_MODEL = os.environ.get("VERIFY_MODEL", "gemini-3.8-flash")


def load_env() -> None:
    if os.environ.get("GEMINI_API_KEY"):
        return
    cands = [Path(os.environ["HOLDUP_ENV_FILE"])] if os.environ.get("HOLDUP_ENV_FILE") else []
    for p in (*cands, REPO / ".env", Path.home() / "junction-meta-glasses" / ".env", Path.home() / "momin" / ".env"):
        if p.exists():
            for line in p.read_text().splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                if line.startswith("export "):
                    line = line[7:].strip()
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
            if os.environ.get("GEMINI_API_KEY"):
                break
    if not os.environ.get("GEMINI_API_KEY"):
        sys.exit("GEMINI_API_KEY not set (looked in env and repo .env)")


_client = None
_client_lock = threading.Lock()


def client():
    global _client
    with _client_lock:
        if _client is None:
            load_env()
            from google import genai

            _client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    return _client


def _redact(msg: str) -> str:
    key = os.environ.get("GEMINI_API_KEY")
    if key:
        msg = msg.replace(key, "***")
    return re.sub(r"key=[A-Za-z0-9_\-]+", "key=***", msg)


def is_retryable(e: Exception) -> bool:
    s = str(e)
    code = getattr(e, "code", None) or getattr(e, "status_code", None)
    if code in (408, 429, 500, 502, 503, 504):
        return True
    return any(t in s for t in ("429", "RESOURCE_EXHAUSTED", "UNAVAILABLE", "503", "500",
                                 "INTERNAL", "DEADLINE", "timed out", "Timeout",
                                 "Connection", "overloaded", "empty response"))


def with_retries(fn: Callable[[], Any], tries: int = 6, base: float = 2.0, label: str = "") -> Any:
    last = None
    for i in range(tries):
        try:
            return fn()
        except Exception as e:  # noqa: BLE001
            last = e
            if not is_retryable(e) or i == tries - 1:
                break
            sleep = base * (2 ** i) * (0.5 + random.random())
            log(f"retry {label} #{i+1} in {sleep:.1f}s: {_redact(str(e))[:160]}")
            time.sleep(min(sleep, 60))
    raise RuntimeError(_redact(f"{label}: {last}"))


_log_lock = threading.Lock()


def log(*a: Any) -> None:
    with _log_lock:
        print(time.strftime("%H:%M:%S"), *a, flush=True)


def pmap(fn: Callable[[Any], Any], items: Iterable[Any], workers: int = 8, desc: str = "") -> list:
    items = list(items)
    out: list = [None] * len(items)
    done = 0
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(fn, it): i for i, it in enumerate(items)}
        for f in as_completed(futs):
            i = futs[f]
            try:
                out[i] = f.result()
            except Exception as e:  # noqa: BLE001
                out[i] = {"error": _redact(str(e))[:500]}
            done += 1
            if done % 25 == 0 or done == len(items):
                log(f"{desc} {done}/{len(items)}")
    return out


def read_jsonl(p: Path) -> list[dict]:
    if not p.exists():
        return []
    return [json.loads(l) for l in p.read_text().splitlines() if l.strip()]


def write_jsonl(p: Path, rows: Iterable[dict]) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("w") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


def append_jsonl(p: Path, row: dict, lock=threading.Lock()) -> None:
    with lock:
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open("a") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


def parse_json(text: str) -> Any:
    text = (text or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
        text = re.sub(r"\n?```$", "", text)
    return json.loads(text)


LEDGER = OUT / "ledger.jsonl"


def ledger(feature: str, model: str, resp: Any, latency: float, ok: bool, thinking: str | None) -> None:
    """One JSON line per Gemini call: {ts, feature, model, in, out, thinking, cached, latency_s, ok}."""
    um = getattr(resp, "usage_metadata", None)
    row = {
        "ts": round(time.time(), 3), "feature": feature, "model": model,
        "in": getattr(um, "prompt_token_count", None) if um else None,
        "out": getattr(um, "candidates_token_count", None) if um else None,
        "thinking": getattr(um, "thoughts_token_count", None) if um else None,
        "thinking_level": thinking,
        "cached": getattr(um, "cached_content_token_count", None) if um else None,
        "latency_s": round(latency, 3), "ok": ok,
    }
    append_jsonl(LEDGER, row)


def _rest_resp(rj: dict) -> SimpleNamespace:
    um = rj.get("usageMetadata") or {}
    return SimpleNamespace(
        usage_metadata=SimpleNamespace(
            prompt_token_count=um.get("promptTokenCount"),
            candidates_token_count=um.get("candidatesTokenCount"),
            thoughts_token_count=um.get("thoughtsTokenCount"),
            cached_content_token_count=um.get("cachedContentTokenCount"),
        )
    )


def part_bytes(data: bytes, mime: str = "image/jpeg") -> Any:
    try:
        from google.genai import types

        return types.Part.from_bytes(data=data, mime_type=mime)
    except ImportError:
        return {"inlineData": {"mimeType": mime, "data": base64.b64encode(data).decode("ascii")}}


def gen_cfg(schema: dict | None = None, system: str | None = None, thinking: str | None = "low",
            max_tokens: int = 4096, json_out: bool = True, extra: dict | None = None):
    from google.genai import types

    cfg: dict[str, Any] = {"max_output_tokens": max_tokens}
    if json_out:
        cfg["response_mime_type"] = "application/json"
    if schema is not None:
        cfg["response_json_schema"] = schema
    if system:
        cfg["system_instruction"] = system
    if thinking:
        cfg["thinking_config"] = types.ThinkingConfig(thinking_level=thinking)
    if extra:
        cfg.update(extra)
    return types.GenerateContentConfig(**cfg)


def gen_json(model: str, contents: Any, schema: dict | None = None, system: str | None = None,
             thinking: str | None = "low", max_tokens: int = 8192, feature: str = "",
             label: str = "") -> Any:
    """generateContent with JSON output; returns (parsed, raw_text, latency_s).

    Temperature is left at the model default (team playbook)."""
    try:
        cfg = gen_cfg(schema, system, thinking, max_tokens)
    except ImportError:
        load_env()
        import requests

        parts = (
            [{"text": contents}]
            if isinstance(contents, str)
            else [{"text": x} if isinstance(x, str) else x for x in contents]
        )
        gcfg: dict[str, Any] = {"maxOutputTokens": max_tokens, "responseMimeType": "application/json"}
        if schema is not None:
            gcfg["responseJsonSchema"] = schema
        if thinking:
            gcfg["thinkingConfig"] = {"thinkingLevel": thinking}
        payload: dict[str, Any] = {"contents": [{"role": "user", "parts": parts}], "generationConfig": gcfg}
        if system:
            payload["systemInstruction"] = {"parts": [{"text": system}]}

        def call_rest():
            t0 = time.time()
            r = None
            try:
                url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
                resp = requests.post(
                    url,
                    headers={"x-goog-api-key": os.environ["GEMINI_API_KEY"]},
                    json=payload,
                    timeout=120,
                )
                dt = time.time() - t0
                if resp.status_code != 200:
                    raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:240]}")
                rj = resp.json()
                r = _rest_resp(rj)
                cands = rj.get("candidates") or []
                cparts = ((cands[0].get("content") or {}).get("parts") or []) if cands else []
                txt = "".join(p.get("text", "") for p in cparts if not p.get("thought"))
                if not txt:
                    raise RuntimeError("empty response")
                parsed = parse_json(txt)
            except Exception:
                ledger(feature or label, model, r, time.time() - t0, False, thinking)
                raise
            ledger(feature or label, model, r, dt, True, thinking)
            return parsed, txt, dt

        return with_retries(call_rest, label=label or model)

    def call():
        t0 = time.time()
        r = None
        try:
            r = client().models.generate_content(model=model, contents=contents, config=cfg)
            dt = time.time() - t0
            txt = r.text
            if not txt:
                raise RuntimeError("empty response")
            parsed = parse_json(txt)
        except Exception:
            ledger(feature or label, model, r, time.time() - t0, False, thinking)
            raise
        ledger(feature or label, model, r, dt, True, thinking)
        return parsed, txt, dt

    return with_retries(call, label=label or model)
