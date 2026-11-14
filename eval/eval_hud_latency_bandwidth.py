import argparse
import asyncio
import base64
import datetime
import io
import json
import math
import os
import pathlib
import platform
import shutil
import statistics
import sys
import tempfile
import time
from typing import Any

import aiohttp
from PIL import Image

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
FIXTURE_PATH = REPO_ROOT / "web" / "public" / "fixtures" / "amlodipine.jpg"
DEFAULT_OUT_PATH = REPO_ROOT / "eval" / "hud_latency_bandwidth.json"

EXPECTED_FIXTURE_BYTES = 58414
INGEST_FRAME_COUNT = 100
FANOUT_ROUND_TRIPS = 100
LATE_JOIN_CONNECTIONS = 50
TELEMETRY_READ_COUNT = 50
PING_PROBE_COUNT = 20
RING_CAPACITY = 8
HUD_VERDICT_WIRE_BUDGET_BYTES = 1500
CHECK_DURATION_S = 12.0
WS_FRAME_ENVELOPE_OVERHEAD_BYTES = 64

EM_DASH = chr(8212)
EN_DASH = chr(8211)
COMMENT_CHAR = chr(35)

DEMO_PROFILE: dict[str, Any] = {
    "meds": [
        {
            "id": "aml",
            "name": "Amlodipin",
            "ingredient": "amlodipine",
            "strength": "5 mg",
            "schedule": ["evening"],
            "barcode": "6432100012345",
            "notes": "Blood pressure, 1 tablet in the evening",
        },
        {
            "id": "met",
            "name": "Metformin",
            "ingredient": "metformin",
            "strength": "500 mg",
            "schedule": ["morning", "evening"],
            "barcode": "6432100054321",
            "notes": "With meals twice daily",
        },
        {
            "id": "par",
            "name": "Panadol",
            "ingredient": "paracetamol",
            "strength": "500 mg",
            "schedule": ["as needed"],
            "barcode": "6432100098765",
            "notes": "Pain or fever",
        },
    ],
    "allergies": ["peanut", "tree nuts"],
    "avoid": ["NSAIDs"],
    "doseLog": [],
    "lang": "en",
}

CANONICAL_LABEL_READS: dict[str, dict[str, Any]] = {
    "match": {
        "kind": "medication",
        "product": {"value": "Amlodipin Orion", "confidence": 0.98},
        "ingredient": {"value": "amlodipine", "confidence": 0.98},
        "strength": {"value": "5 mg", "confidence": 0.98},
        "dosing": {"value": "1 tablet in the evening", "confidence": 0.94},
        "expiry": {"value": "2027-10", "confidence": 0.96},
        "allergens": {"value": None, "confidence": 0.0},
        "barcode": {"value": "6432100012345", "confidence": 0.95},
        "readability": 0.97,
    },
    "warning": {
        "kind": "medication",
        "product": {"value": "Burana", "confidence": 0.98},
        "ingredient": {"value": "ibuprofen", "confidence": 0.98},
        "strength": {"value": "400 mg", "confidence": 0.98},
        "dosing": {"value": "1 tablet up to 3 times daily", "confidence": 0.92},
        "expiry": {"value": "2027-11", "confidence": 0.95},
        "allergens": {"value": None, "confidence": 0.0},
        "barcode": {"value": "6432100001664", "confidence": 0.91},
        "readability": 0.96,
    },
    "unsure": {
        "kind": "medication",
        "product": {"value": "Amlodipin Orion", "confidence": 0.91},
        "ingredient": {"value": "amlodipine", "confidence": 0.89},
        "strength": {"value": None, "confidence": 0.20},
        "dosing": {"value": None, "confidence": 0.0},
        "expiry": {"value": "2027-10", "confidence": 0.84},
        "allergens": {"value": None, "confidence": 0.0},
        "barcode": {"value": None, "confidence": 0.0},
        "readability": 0.42,
        "guidance": "Move slightly closer and hold still.",
    },
    "info": {
        "kind": "food",
        "product": {"value": "Pohjan Kaura Oat Drink", "confidence": 0.96},
        "ingredient": {"value": None, "confidence": 0.0},
        "strength": {"value": None, "confidence": 0.0},
        "dosing": {"value": None, "confidence": 0.0},
        "expiry": {"value": "2027-11", "confidence": 0.93},
        "allergens": {"value": ["oats", "gluten"], "confidence": 0.95},
        "barcode": {"value": "6410405112233", "confidence": 0.92},
        "readability": 0.96,
    },
}

SERVER_HARNESS_TS = """
import readline from "node:readline";
import { env } from "./server/src/env.ts";
import { getHub, startServer } from "./server/src/index.ts";
import { getOrCreateHub, hubStats, markLatest, resetHubsForTest } from "./server/src/hub.ts";
import { jpegSharpness, jpegSize, toLabelRead, toProfile } from "./server/src/verify.ts";
import { checkLabel } from "./server/src/safety.ts";
import { computeAdaptiveParams } from "./web/src/camera/adaptive.ts";

process.env.HOLDUP_QUIET = "1";
env.apiKey = "";

const srv = await startServer(0);
const addr = srv.address();
const port = typeof addr === "object" && addr ? addr.port : 0;
process.stdout.write(JSON.stringify({ event: "listening", port, node_version: process.version }) + "\\n");

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch (err) {
    process.stdout.write(JSON.stringify({ id: null, ok: false, error: String(err) }) + "\\n");
    return;
  }
  try {
    const { id, cmd } = req;
    if (cmd === "reset") {
      resetHubsForTest();
      process.stdout.write(JSON.stringify({ id, ok: true, result: hubStats() }) + "\\n");
      return;
    }
    if (cmd === "ring_info") {
      const h = getHub(String(req.session || ""));
      const top = h ? h.ring.pick(1, 60000)[0] : undefined;
      process.stdout.write(
        JSON.stringify({
          id,
          ok: true,
          result: {
            exists: Boolean(h),
            length: h ? h.ring.length : 0,
            clients: h ? h.clients.size : 0,
            lastBytes: top ? top.bytes : null,
            lastSharpness: top ? top.sharpness : null,
          },
        }) + "\\n"
      );
      return;
    }
    if (cmd === "sharpness_batch") {
      const items = Array.isArray(req.items) ? req.items : [];
      const out = items.map((entry) => {
        const buf = Buffer.from(String(entry.b64), "base64");
        return {
          key: entry.key,
          bytes: buf.length,
          size: jpegSize(buf) ?? null,
          sharpness: jpegSharpness(buf),
        };
      });
      process.stdout.write(JSON.stringify({ id, ok: true, result: out }) + "\\n");
      return;
    }
    if (cmd === "adaptive_matrix") {
      const probes = Array.isArray(req.probes) ? req.probes : [];
      const out = probes.map((p) => ({
        label: p.label,
        rtt_ms: p.rtt_ms,
        online: p.online !== false,
        params: computeAdaptiveParams(p.rtt_ms, p.online !== false),
      }));
      process.stdout.write(JSON.stringify({ id, ok: true, result: out }) + "\\n");
      return;
    }
    if (cmd === "seed_hud_replay") {
      const session = String(req.session || "bench-latejoin");
      const profile = toProfile(req.profile);
      const reads = req.reads || {};
      const verdicts = {};
      const verdictWireBytes = {};
      for (const [k, rawRead] of Object.entries(reads)) {
        const v = checkLabel(toLabelRead(rawRead), profile);
        verdicts[k] = v;
        verdictWireBytes[k] = Buffer.byteLength(JSON.stringify({ type: "verdict", verdict: v }), "utf8");
      }
      const h = getOrCreateHub(session);
      markLatest(h);
      h.emit({ type: "status", live: "open" });
      h.emit({ type: "coach", cue: "hold_still", text: "Hold it steady so I can read the strength." });
      h.emit({ type: "verdict", verdict: verdicts.match });
      process.stdout.write(
        JSON.stringify({
          id,
          ok: true,
          result: {
            session,
            verdict_levels: Object.fromEntries(Object.entries(verdicts).map(([k, v]) => [k, v.level])),
            verdict_wire_bytes_by_level: verdictWireBytes,
          },
        }) + "\\n"
      );
      return;
    }
    if (cmd === "shutdown") {
      srv.closeAllConnections();
      srv.close(() => {
        process.stdout.write(JSON.stringify({ id, ok: true, result: { closed: true } }) + "\\n");
        process.exit(0);
      });
      setTimeout(() => process.exit(0), 300).unref();
      return;
    }
    process.stdout.write(JSON.stringify({ id, ok: false, error: "unknown_cmd" }) + "\\n");
  } catch (err) {
    process.stdout.write(JSON.stringify({ id: req?.id ?? null, ok: false, error: String(err) }) + "\\n");
  }
});
"""


def sanitize_obj(val: Any) -> Any:
    if isinstance(val, str):
        return val.replace(EM_DASH, " - ").replace(EN_DASH, "-")
    if isinstance(val, list):
        return [sanitize_obj(x) for x in val]
    if isinstance(val, dict):
        return {sanitize_obj(k): sanitize_obj(v) for k, v in val.items()}
    return val


def assert_clean_output(node: Any) -> None:
    if isinstance(node, str):
        if EM_DASH in node or EN_DASH in node:
            raise AssertionError(f"Forbidden dash in JSON string: {node[:80]}")
        if node.startswith("/9j/") or len(node) > 1200:
            raise AssertionError("Unexpected base64 or oversized string in JSON output")
        return
    if isinstance(node, list):
        for item in node:
            assert_clean_output(item)
        return
    if isinstance(node, dict):
        for k, v in node.items():
            assert_clean_output(k)
            assert_clean_output(v)


def percentile(vals: list[float], q: float, digits: int = 3) -> float:
    if not vals:
        return 0.0
    xs = sorted(vals)
    if len(xs) == 1:
        return round(xs[0], digits)
    pos = (len(xs) - 1) * q
    lo = int(math.floor(pos))
    hi = int(math.ceil(pos))
    if lo == hi:
        return round(xs[lo], digits)
    frac = pos - lo
    return round(xs[lo] * (1.0 - frac) + xs[hi] * frac, digits)


def summarize_latencies(vals: list[float], digits: int = 3) -> dict[str, float]:
    if not vals:
        return {"p50": 0.0, "p95": 0.0, "p99": 0.0, "mean": 0.0, "min": 0.0, "max": 0.0}
    return {
        "p50": percentile(vals, 0.50, digits),
        "p95": percentile(vals, 0.95, digits),
        "p99": percentile(vals, 0.99, digits),
        "mean": round(statistics.mean(vals), digits),
        "min": round(min(vals), digits),
        "max": round(max(vals), digits),
    }


def b64_len(raw_len: int) -> int:
    return ((raw_len + 2) // 3) * 4


def build_clean_server_env(ledger_path: pathlib.Path) -> dict[str, str]:
    merged = dict(os.environ)
    extra_bins = [
        "/tmp/fleet-silas/node/bin",
        str(pathlib.Path.home() / ".local" / "bin"),
    ]
    path_parts = [p for p in extra_bins if os.path.isdir(p)]
    if merged.get("PATH"):
        path_parts.append(merged["PATH"])
    merged["PATH"] = os.pathsep.join(path_parts)
    merged["GEMINI_API_KEY"] = ""
    merged["HOLDUP_QUIET"] = "1"
    merged["LEDGER_PATH"] = str(ledger_path)
    for proxy_key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        merged.pop(proxy_key, None)
    return merged


def resolve_node_bin(env_map: dict[str, str]) -> str:
    node_bin = shutil.which("node", path=env_map.get("PATH"))
    if not node_bin and pathlib.Path("/tmp/fleet-silas/node/bin/node").is_file():
        node_bin = "/tmp/fleet-silas/node/bin/node"
    if not node_bin:
        raise RuntimeError("node binary not found")
    return node_bin


class NodeServerHarness:
    def __init__(self, node_bin: str, env_map: dict[str, str]) -> None:
        self.node_bin = node_bin
        self.env_map = env_map
        self.proc: asyncio.subprocess.Process | None = None
        self.port: int = 0
        self.node_version: str = ""
        self._next_id: int = 1
        self._stderr_chunks: list[str] = []
        self._stderr_task: asyncio.Task[None] | None = None

    async def start(self, timeout_s: float = 20.0) -> None:
        self.proc = await asyncio.create_subprocess_exec(
            self.node_bin,
            "--import",
            "tsx",
            "--input-type=module",
            "-e",
            SERVER_HARNESS_TS,
            cwd=str(REPO_ROOT),
            env=self.env_map,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        assert self.proc.stdout is not None
        assert self.proc.stderr is not None

        async def drain_stderr() -> None:
            assert self.proc is not None and self.proc.stderr is not None
            while True:
                line = await self.proc.stderr.readline()
                if not line:
                    break
                self._stderr_chunks.append(line.decode("utf-8", errors="replace").rstrip("\n"))

        self._stderr_task = asyncio.create_task(drain_stderr())

        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            remaining = max(0.1, deadline - time.monotonic())
            raw = await asyncio.wait_for(self.proc.stdout.readline(), timeout=remaining)
            if not raw:
                break
            text = raw.decode("utf-8", errors="replace").strip()
            if not text:
                continue
            try:
                parsed = json.loads(text)
            except json.JSONDecodeError:
                continue
            if parsed.get("event") == "listening":
                self.port = int(parsed["port"])
                self.node_version = str(parsed.get("node_version") or "")
                break

        if self.port <= 0:
            await self.stop()
            tail = "\n".join(self._stderr_chunks[-20:])
            raise RuntimeError(f"Failed to start HoldUp server via startServer(0). stderr:\n{tail}")

    async def call(self, cmd: str, **kwargs: Any) -> Any:
        if self.proc is None or self.proc.stdin is None or self.proc.stdout is None:
            raise RuntimeError("Node harness is not running")
        req_id = self._next_id
        self._next_id += 1
        payload = {"id": req_id, "cmd": cmd, **kwargs}
        self.proc.stdin.write((json.dumps(payload) + "\n").encode("utf-8"))
        await self.proc.stdin.drain()
        while True:
            raw = await asyncio.wait_for(self.proc.stdout.readline(), timeout=10.0)
            if not raw:
                tail = "\n".join(self._stderr_chunks[-20:])
                raise RuntimeError(f"Node harness EOF on {cmd}. stderr:\n{tail}")
            text = raw.decode("utf-8", errors="replace").strip()
            if not text:
                continue
            try:
                msg = json.loads(text)
            except json.JSONDecodeError:
                continue
            if msg.get("id") == req_id:
                if not msg.get("ok"):
                    raise RuntimeError(f"Node RPC {cmd} failed: {msg.get('error')}")
                return msg.get("result")

    async def stop(self) -> None:
        if self.proc is None:
            return
        if self.proc.returncode is None:
            try:
                await asyncio.wait_for(self.call("shutdown"), timeout=3.0)
            except Exception:
                pass
        if self.proc.returncode is None:
            self.proc.terminate()
            try:
                await asyncio.wait_for(self.proc.wait(), timeout=3.0)
            except asyncio.TimeoutError:
                self.proc.kill()
                await self.proc.wait()
        if self._stderr_task is not None:
            self._stderr_task.cancel()
            try:
                await self._stderr_task
            except asyncio.CancelledError:
                pass


def encode_resized_jpeg(raw_bytes: bytes, max_dim: int, quality_float: float) -> tuple[bytes, int, int]:
    pil_quality = max(5, min(95, int(round(quality_float * 100.0))))
    with Image.open(io.BytesIO(raw_bytes)) as img:
        w0, h0 = img.size
        scale = min(1.0, float(max_dim) / float(max(w0, h0)))
        w = max(1, int(round(w0 * scale)))
        h = max(1, int(round(h0 * scale)))
        work = img.resize((w, h), Image.Resampling.LANCZOS) if (w, h) != (w0, h0) else img.copy()
        buf = io.BytesIO()
        work.save(buf, format="JPEG", quality=pil_quality)
        return buf.getvalue(), w, h


async def warmup_loopback(http: aiohttp.ClientSession, base_url: str, ws_base: str, jpeg_bytes: bytes, harness: NodeServerHarness) -> None:
    live_ws = await http.ws_connect(f"{ws_base}/live?session=warmup01")
    hud_ws = await http.ws_connect(f"{ws_base}/hud-ws?session=warmup01")
    _ = await live_ws.receive_json(timeout=2.0)
    for _ in range(3):
        async with http.post(
            f"{base_url}/ingest/frame?session=warmup01",
            data=jpeg_bytes,
            headers={"Content-Type": "image/jpeg"},
        ) as resp:
            if resp.status != 204:
                raise RuntimeError(f"Warmup /ingest/frame failed: {resp.status}")
        async with http.post(
            f"{base_url}/ingest/state?session=warmup01",
            json={"connected": True, "worn": True, "streaming": True, "battery": 90},
        ) as resp:
            if resp.status != 204:
                raise RuntimeError(f"Warmup /ingest/state failed: {resp.status}")
        await live_ws.receive_json(timeout=2.0)
        await hud_ws.receive_json(timeout=2.0)
    async with http.get(f"{base_url}/api/stats") as resp:
        await resp.read()
    await hud_ws.close()
    await live_ws.close()
    await asyncio.sleep(0.02)
    await harness.call("reset")


async def bench_ingest_frame(
    http: aiohttp.ClientSession,
    base_url: str,
    ws_base: str,
    jpeg_bytes: bytes,
    harness: NodeServerHarness,
) -> dict[str, Any]:
    session_id = "bench-ingest"
    live_ws = await http.ws_connect(f"{ws_base}/live?session={session_id}")
    latencies_ms: list[float] = []
    ring_lengths: list[int] = []
    sharpness_observed: float | None = None

    try:
        for idx in range(1, INGEST_FRAME_COUNT + 1):
            t0 = time.perf_counter()
            async with http.post(
                f"{base_url}/ingest/frame?session={session_id}",
                data=jpeg_bytes,
                headers={"Content-Type": "image/jpeg"},
            ) as resp:
                await resp.read()
                dt_ms = (time.perf_counter() - t0) * 1000.0
                if resp.status != 204:
                    raise RuntimeError(f"POST /ingest/frame step {idx} returned HTTP {resp.status}")

            latencies_ms.append(round(dt_ms, 3))
            info = await harness.call("ring_info", session=session_id)
            cur_len = int(info["length"])
            expected_len = min(idx, RING_CAPACITY)
            if cur_len != expected_len or cur_len > RING_CAPACITY:
                raise AssertionError(
                    f"FrameRing bound violated at step {idx}: observed={cur_len}, expected={expected_len}"
                )
            if int(info["lastBytes"] or 0) != len(jpeg_bytes):
                raise AssertionError(f"Unexpected stored frame byte count: {info['lastBytes']}")
            ring_lengths.append(cur_len)
            if sharpness_observed is None and info.get("lastSharpness") is not None:
                sharpness_observed = round(float(info["lastSharpness"]), 6)
    finally:
        await live_ws.close()

    len_after_close = -1
    for _ in range(25):
        info_after = await harness.call("ring_info", session=session_id)
        len_after_close = int(info_after["length"])
        if len_after_close == 0 and int(info_after["clients"]) == 0:
            break
        await asyncio.sleep(0.005)

    if len_after_close != 0:
        raise AssertionError(f"Expected FrameRing to clear on /live disconnect, got length={len_after_close}")

    await harness.call("reset")

    with Image.open(io.BytesIO(jpeg_bytes)) as img:
        w, h = img.size

    return {
        "endpoint": "POST /ingest/frame",
        "fixture": "web/public/fixtures/amlodipine.jpg",
        "fixture_bytes": len(jpeg_bytes),
        "fixture_dimensions": f"{w}x{h}",
        "n_requests": INGEST_FRAME_COUNT,
        "jpeg_sharpness_score": sharpness_observed,
        "latency_ms": summarize_latencies(latencies_ms),
        "frame_ring": {
            "capacity": RING_CAPACITY,
            "observed_lengths_first_12": ring_lengths[:12],
            "min_observed_len": min(ring_lengths),
            "max_observed_len": max(ring_lengths),
            "final_len_at_100": ring_lengths[-1],
            "bounded_le_8_all_100": all(x <= RING_CAPACITY for x in ring_lengths),
            "len_after_live_ws_close": len_after_close,
        },
        "samples_ms": latencies_ms,
    }


async def bench_state_fanout(
    http: aiohttp.ClientSession,
    base_url: str,
    ws_base: str,
    harness: NodeServerHarness,
) -> dict[str, Any]:
    session_id = "bench-fanout"
    live_ws = await http.ws_connect(f"{ws_base}/live?session={session_id}")
    hud_ws = await http.ws_connect(f"{ws_base}/hud-ws?session={session_id}")

    init_hud_msg = await live_ws.receive_json(timeout=2.0)
    if init_hud_msg.get("type") != "hud" or init_hud_msg.get("connected") is not True:
        raise AssertionError(f"Unexpected initial /live HUD attach frame: {init_hud_msg}")

    fanout_e2e_ms: list[float] = []
    hud_leg_ms: list[float] = []
    live_leg_ms: list[float] = []
    http_post_ms: list[float] = []
    device_wire_bytes = 0

    try:
        for idx in range(FANOUT_ROUND_TRIPS):
            expected_battery = 15 + (idx % 85)
            expected_streaming = (idx % 2) == 0
            state_body = {
                "connected": True,
                "worn": True,
                "streaming": expected_streaming,
                "battery": expected_battery,
            }

            t0 = time.perf_counter()

            async def do_post() -> tuple[int, float]:
                async with http.post(f"{base_url}/ingest/state?session={session_id}", json=state_body) as resp:
                    await resp.read()
                    return resp.status, (time.perf_counter() - t0) * 1000.0

            async def recv_ws(ws: aiohttp.ClientWebSocketResponse) -> tuple[dict[str, Any], int, float]:
                msg = await ws.receive(timeout=3.0)
                t_arr = (time.perf_counter() - t0) * 1000.0
                if msg.type != aiohttp.WSMsgType.TEXT:
                    raise RuntimeError(f"Expected TEXT WebSocket frame, got {msg.type}")
                raw_text = str(msg.data)
                return json.loads(raw_text), len(raw_text.encode("utf-8")), t_arr

            (status_code, dt_http), (live_msg, live_bytes, dt_live), (hud_msg, hud_bytes, dt_hud) = (
                await asyncio.gather(do_post(), recv_ws(live_ws), recv_ws(hud_ws))
            )

            dt_total = max(dt_http, dt_live, dt_hud)
            if status_code != 204:
                raise RuntimeError(f"POST /ingest/state step {idx + 1} returned HTTP {status_code}")

            for label, payload in (("live", live_msg), ("hud", hud_msg)):
                dev = payload.get("device") or {}
                if (
                    payload.get("type") != "device"
                    or dev.get("battery") != expected_battery
                    or dev.get("streaming") != expected_streaming
                    or dev.get("source") != "glasses"
                ):
                    raise AssertionError(f"Fan-out mismatch on {label} at step {idx + 1}: {payload}")

            device_wire_bytes = hud_bytes
            if live_bytes != hud_bytes:
                raise AssertionError(f"Wire byte mismatch between /live ({live_bytes}) and /hud-ws ({hud_bytes})")

            http_post_ms.append(round(dt_http, 3))
            live_leg_ms.append(round(dt_live, 3))
            hud_leg_ms.append(round(dt_hud, 3))
            fanout_e2e_ms.append(round(dt_total, 3))
    finally:
        await hud_ws.close()
        await live_ws.close()

    await asyncio.sleep(0.01)
    await harness.call("reset")

    return {
        "flow": "POST /ingest/state -> /hud-ws + /live",
        "n_round_trips": FANOUT_ROUND_TRIPS,
        "all_100_matched_expected_state": True,
        "device_wire_bytes": device_wire_bytes,
        "end_to_end_fanout_ms": summarize_latencies(fanout_e2e_ms),
        "hud_ws_delivery_ms": summarize_latencies(hud_leg_ms),
        "live_ws_delivery_ms": summarize_latencies(live_leg_ms),
        "http_ingest_post_ms": summarize_latencies(http_post_ms),
        "samples_ms": fanout_e2e_ms,
    }


async def bench_hud_late_join_replay(
    http: aiohttp.ClientSession,
    base_url: str,
    ws_base: str,
    harness: NodeServerHarness,
) -> dict[str, Any]:
    session_id = "bench-latejoin"
    seeded = await harness.call(
        "seed_hud_replay",
        session=session_id,
        profile=DEMO_PROFILE,
        reads=CANONICAL_LABEL_READS,
    )
    verdict_levels = seeded["verdict_levels"]
    for key in ("match", "warning", "unsure", "info"):
        if verdict_levels.get(key) != key:
            raise AssertionError(f"Expected canonical {key} verdict, got {verdict_levels.get(key)}")

    async with http.post(
        f"{base_url}/ingest/state?session={session_id}",
        json={"connected": True, "worn": True, "streaming": True, "battery": 84},
    ) as resp:
        await resp.read()
        if resp.status != 204:
            raise RuntimeError(f"Seed POST /ingest/state failed with HTTP {resp.status}")

    expected_sequence = ["status", "device", "coach", "verdict"]
    connect_to_replay_ms: list[float] = []
    handshake_ms: list[float] = []
    drain_ms: list[float] = []
    wire_sizes_by_type: dict[str, int] = {}

    for idx in range(LATE_JOIN_CONNECTIONS):
        t0 = time.perf_counter()
        hud_ws = await http.ws_connect(f"{ws_base}/hud-ws")
        t_open = time.perf_counter()

        seen_types: list[str] = []
        try:
            for _ in range(4):
                msg = await hud_ws.receive(timeout=3.0)
                if msg.type != aiohttp.WSMsgType.TEXT:
                    raise RuntimeError(f"Unexpected WS message type on late-join step {idx + 1}: {msg.type}")
                raw_text = str(msg.data)
                parsed = json.loads(raw_text)
                mtype = str(parsed.get("type") or "")
                seen_types.append(mtype)
                wire_sizes_by_type[mtype] = len(raw_text.encode("utf-8"))
            t_done = time.perf_counter()
        finally:
            await hud_ws.close()

        if seen_types != expected_sequence:
            raise AssertionError(
                f"Late-join step {idx + 1} replay order mismatch: got {seen_types}, expected {expected_sequence}"
            )

        handshake_ms.append(round((t_open - t0) * 1000.0, 3))
        drain_ms.append(round((t_done - t_open) * 1000.0, 3))
        connect_to_replay_ms.append(round((t_done - t0) * 1000.0, 3))

    await harness.call("reset")

    verdict_wire_bytes = wire_sizes_by_type["verdict"]
    by_level_bytes: dict[str, int] = {
        str(k): int(v) for k, v in seeded["verdict_wire_bytes_by_level"].items()
    }
    if by_level_bytes["match"] != verdict_wire_bytes:
        raise AssertionError(
            f"Server vs client verdict wire bytes mismatch: {by_level_bytes['match']} != {verdict_wire_bytes}"
        )
    max_verdict_bytes = max(by_level_bytes.values())
    if max_verdict_bytes >= HUD_VERDICT_WIRE_BUDGET_BYTES:
        raise AssertionError(
            f"HUD verdict wire payload {max_verdict_bytes} bytes exceeded 1.5 KB ({HUD_VERDICT_WIRE_BUDGET_BYTES} B) budget"
        )

    total_replay_bytes = sum(wire_sizes_by_type[k] for k in expected_sequence)

    return {
        "endpoint": "WS /hud-ws (zero-code latest session attach)",
        "n_connections": LATE_JOIN_CONNECTIONS,
        "expected_replay_sequence": expected_sequence,
        "all_50_received_exact_sequence": True,
        "connect_to_replay_complete_ms": summarize_latencies(connect_to_replay_ms),
        "ws_handshake_ms": summarize_latencies(handshake_ms),
        "post_handshake_replay_drain_ms": summarize_latencies(drain_ms),
        "wire_payload_bytes": {
            "status_bytes": wire_sizes_by_type["status"],
            "device_bytes": wire_sizes_by_type["device"],
            "coach_bytes": wire_sizes_by_type["coach"],
            "verdict_bytes": verdict_wire_bytes,
            "total_4_msg_replay_bytes": total_replay_bytes,
            "total_4_msg_replay_kb": round(total_replay_bytes / 1000.0, 3),
            "verdict_kb": round(verdict_wire_bytes / 1000.0, 3),
            "verdict_kib": round(verdict_wire_bytes / 1024.0, 3),
            "verdict_budget_bytes": HUD_VERDICT_WIRE_BUDGET_BYTES,
            "verdict_under_1_5_kb": max_verdict_bytes < HUD_VERDICT_WIRE_BUDGET_BYTES,
            "verdict_by_level_bytes": by_level_bytes,
            "max_verdict_bytes_across_levels": max_verdict_bytes,
        },
        "samples_ms": connect_to_replay_ms,
    }


async def bench_telemetry_endpoints(
    http: aiohttp.ClientSession,
    base_url: str,
) -> dict[str, Any]:
    stats_ms: list[float] = []
    stats_wire_bytes = 0
    ledger_total_calls = -1

    for idx in range(TELEMETRY_READ_COUNT):
        t0 = time.perf_counter()
        async with http.get(f"{base_url}/api/stats") as resp:
            raw = await resp.read()
            dt_ms = (time.perf_counter() - t0) * 1000.0
            if resp.status != 200:
                raise RuntimeError(f"GET /api/stats step {idx + 1} returned HTTP {resp.status}")
            parsed = json.loads(raw.decode("utf-8"))
        stats_wire_bytes = len(raw)
        ledger_total_calls = int(parsed.get("total", -1))
        stats_ms.append(round(dt_ms, 3))

    if ledger_total_calls != 0:
        raise AssertionError(f"Expected 0 Gemini ledger calls, observed total={ledger_total_calls}")

    eval_ms: list[float] = []
    eval_wire_bytes = 0
    eval_ok_all = True

    for idx in range(TELEMETRY_READ_COUNT):
        t0 = time.perf_counter()
        async with http.get(f"{base_url}/api/eval-summary") as resp:
            raw = await resp.read()
            dt_ms = (time.perf_counter() - t0) * 1000.0
            if resp.status != 200:
                raise RuntimeError(f"GET /api/eval-summary step {idx + 1} returned HTTP {resp.status}")
            parsed = json.loads(raw.decode("utf-8"))
        eval_wire_bytes = len(raw)
        if not parsed.get("ok") or not isinstance(parsed.get("summary"), dict):
            eval_ok_all = False
        eval_ms.append(round(dt_ms, 3))

    if not eval_ok_all:
        raise AssertionError("GET /api/eval-summary did not return ok=true with summary payload")

    return {
        "api_stats": {
            "endpoint": "GET /api/stats",
            "n_requests": TELEMETRY_READ_COUNT,
            "wire_bytes": stats_wire_bytes,
            "ledger_total_calls": ledger_total_calls,
            "latency_ms": summarize_latencies(stats_ms),
            "samples_ms": stats_ms,
        },
        "api_eval_summary": {
            "endpoint": "GET /api/eval-summary",
            "n_requests": TELEMETRY_READ_COUNT,
            "wire_bytes": eval_wire_bytes,
            "wire_kb": round(eval_wire_bytes / 1000.0, 3),
            "cold_first_read_ms": eval_ms[0],
            "warm_cached_p50_ms": percentile(eval_ms[1:], 0.50, 3),
            "latency_ms": summarize_latencies(eval_ms),
            "samples_ms": eval_ms,
        },
    }


async def bench_adaptive_payloads_and_rtt(
    http: aiohttp.ClientSession,
    ws_base: str,
    jpeg_bytes: bytes,
    harness: NodeServerHarness,
) -> dict[str, Any]:
    live_ws = await http.ws_connect(f"{ws_base}/live?session=bench-rtt")
    rtt_samples_ms: list[float] = []
    try:
        for idx in range(PING_PROBE_COUNT):
            token = 1000 + idx
            t0 = time.perf_counter()
            await live_ws.send_str(json.dumps({"type": "ping", "t": token}))
            reply = await live_ws.receive_json(timeout=2.0)
            dt_ms = (time.perf_counter() - t0) * 1000.0
            if reply.get("type") != "pong" or reply.get("t") != token:
                raise AssertionError(f"Unexpected /live pong reply: {reply}")
            rtt_samples_ms.append(round(dt_ms, 3))
    finally:
        await live_ws.close()

    await asyncio.sleep(0.01)
    await harness.call("reset")

    rtt_summary = summarize_latencies(rtt_samples_ms)
    probes = [
        {"label": "loopback_measured", "rtt_ms": rtt_summary["p50"], "online": True},
        {"label": "normal_lt_250ms", "rtt_ms": 120, "online": True},
        {"label": "medium_250_to_650ms", "rtt_ms": 420, "online": True},
        {"label": "slow_gt_650ms", "rtt_ms": 820, "online": True},
        {"label": "offline", "rtt_ms": None, "online": False},
    ]
    matrix = await harness.call("adaptive_matrix", probes=probes)
    params_by_label = {row["label"]: row["params"] for row in matrix}

    tier_defs = [
        ("normal_lt_250ms", params_by_label["normal_lt_250ms"]),
        ("medium_250_to_650ms", params_by_label["medium_250_to_650ms"]),
        ("slow_gt_650ms", params_by_label["slow_gt_650ms"]),
    ]

    encoded_batch: list[dict[str, str]] = [
        {"key": "raw_fixture_768", "b64": base64.b64encode(jpeg_bytes).decode("ascii")}
    ]
    tier_raw_map: dict[str, tuple[bytes, int, int]] = {}
    for label, p in tier_defs:
        re_bytes, rw, rh = encode_resized_jpeg(jpeg_bytes, int(p["maxDim"]), float(p["jpegQuality"]))
        tier_raw_map[label] = (re_bytes, rw, rh)
        encoded_batch.append({"key": label, "b64": base64.b64encode(re_bytes).decode("ascii")})

    sharp_rows = await harness.call("sharpness_batch", items=encoded_batch)
    sharp_by_key = {row["key"]: float(row["sharpness"]) for row in sharp_rows}

    tiers_out: dict[str, Any] = {}
    for label, p in tier_defs:
        re_bytes, rw, rh = tier_raw_map[label]
        fps = float(p["targetFps"])
        frames_12s = int(round(CHECK_DURATION_S * fps))
        raw_12s_bytes = frames_12s * len(re_bytes)
        ws_frame_wire_bytes = b64_len(len(re_bytes)) + WS_FRAME_ENVELOPE_OVERHEAD_BYTES
        tiers_out[label] = {
            "target_fps": fps,
            "interval_ms": int(p["intervalMs"]),
            "max_dim_px": int(p["maxDim"]),
            "jpeg_quality": float(p["jpegQuality"]),
            "encoded_dimensions": f"{rw}x{rh}",
            "jpeg_bytes": len(re_bytes),
            "jpeg_kb": round(len(re_bytes) / 1000.0, 3),
            "ws_frame_json_wire_bytes": ws_frame_wire_bytes,
            "server_jpeg_sharpness": round(sharp_by_key[label], 6),
            "frames_in_12s_check": frames_12s,
            "video_12s_raw_kb": round(raw_12s_bytes / 1000.0, 3),
            "video_12s_ws_wire_kb": round((frames_12s * ws_frame_wire_bytes) / 1000.0, 3),
        }

    tiers_out["offline"] = {
        "target_fps": float(params_by_label["offline"]["targetFps"]),
        "interval_ms": int(params_by_label["offline"]["intervalMs"]),
        "max_dim_px": int(params_by_label["offline"]["maxDim"]),
        "jpeg_quality": float(params_by_label["offline"]["jpegQuality"]),
        "frames_in_12s_check": 0,
        "video_12s_raw_kb": 0.0,
        "video_12s_ws_wire_kb": 0.0,
    }

    norm_12s_kb = tiers_out["normal_lt_250ms"]["video_12s_raw_kb"]
    slow_12s_kb = tiers_out["slow_gt_650ms"]["video_12s_raw_kb"]
    reduction_pct = round((1.0 - (slow_12s_kb / norm_12s_kb)) * 100.0, 1) if norm_12s_kb > 0 else 0.0

    return {
        "source_module": "web/src/camera/adaptive.ts",
        "loopback_live_ping_pong_rtt": {
            "n_probes": PING_PROBE_COUNT,
            "latency_ms": rtt_summary,
            "selected_adaptive_params": params_by_label["loopback_measured"],
            "samples_ms": rtt_samples_ms,
        },
        "raw_fixture_server_jpeg_sharpness": round(sharp_by_key["raw_fixture_768"], 6),
        "video_12s_reduction_slow_vs_normal_pct": reduction_pct,
        "tiers": tiers_out,
    }


async def run_all(out_path: pathlib.Path) -> dict[str, Any]:
    if not FIXTURE_PATH.is_file():
        raise FileNotFoundError(f"Missing fixture: {FIXTURE_PATH}")
    jpeg_bytes = FIXTURE_PATH.read_bytes()
    if len(jpeg_bytes) != EXPECTED_FIXTURE_BYTES:
        raise AssertionError(
            f"Expected {EXPECTED_FIXTURE_BYTES} bytes for amlodipine.jpg, got {len(jpeg_bytes)}"
        )

    with tempfile.TemporaryDirectory(prefix="holdup_hud_bench_") as tmp_dir:
        ledger_path = pathlib.Path(tmp_dir) / "ledger.jsonl"
        env_map = build_clean_server_env(ledger_path)
        node_bin = resolve_node_bin(env_map)
        harness = NodeServerHarness(node_bin, env_map)
        await harness.start()

        base_url = f"http://127.0.0.1:{harness.port}"
        ws_base = f"ws://127.0.0.1:{harness.port}"

        connector = aiohttp.TCPConnector(limit=64, force_close=False)
        timeout = aiohttp.ClientTimeout(total=15.0)

        try:
            async with aiohttp.ClientSession(
                connector=connector,
                timeout=timeout,
                trust_env=False,
            ) as http:
                await warmup_loopback(http, base_url, ws_base, jpeg_bytes, harness)
                ingest_res = await bench_ingest_frame(http, base_url, ws_base, jpeg_bytes, harness)
                fanout_res = await bench_state_fanout(http, base_url, ws_base, harness)
                late_join_res = await bench_hud_late_join_replay(http, base_url, ws_base, harness)
                telemetry_res = await bench_telemetry_endpoints(http, base_url)
                adaptive_res = await bench_adaptive_payloads_and_rtt(http, ws_base, jpeg_bytes, harness)
        finally:
            await harness.stop()

    summary: dict[str, Any] = {
        "ingest_frame_n": ingest_res["n_requests"],
        "ingest_frame_bytes": ingest_res["fixture_bytes"],
        "ingest_frame_p50_ms": ingest_res["latency_ms"]["p50"],
        "ingest_frame_p95_ms": ingest_res["latency_ms"]["p95"],
        "ingest_frame_p99_ms": ingest_res["latency_ms"]["p99"],
        "ingest_frame_mean_ms": ingest_res["latency_ms"]["mean"],
        "jpeg_sharpness_score": ingest_res["jpeg_sharpness_score"],
        "ring_capacity": ingest_res["frame_ring"]["capacity"],
        "ring_max_observed_len": ingest_res["frame_ring"]["max_observed_len"],
        "ring_bounded_invariant_ok": ingest_res["frame_ring"]["bounded_le_8_all_100"],
        "ring_len_after_disconnect": ingest_res["frame_ring"]["len_after_live_ws_close"],
        "ingest_state_fanout_n": fanout_res["n_round_trips"],
        "ingest_state_fanout_p50_ms": fanout_res["end_to_end_fanout_ms"]["p50"],
        "ingest_state_fanout_p95_ms": fanout_res["end_to_end_fanout_ms"]["p95"],
        "ingest_state_fanout_p99_ms": fanout_res["end_to_end_fanout_ms"]["p99"],
        "ingest_state_fanout_mean_ms": fanout_res["end_to_end_fanout_ms"]["mean"],
        "hud_ws_leg_p50_ms": fanout_res["hud_ws_delivery_ms"]["p50"],
        "hud_ws_leg_p95_ms": fanout_res["hud_ws_delivery_ms"]["p95"],
        "hud_ws_leg_p99_ms": fanout_res["hud_ws_delivery_ms"]["p99"],
        "live_ws_leg_p50_ms": fanout_res["live_ws_delivery_ms"]["p50"],
        "live_ws_leg_p95_ms": fanout_res["live_ws_delivery_ms"]["p95"],
        "live_ws_leg_p99_ms": fanout_res["live_ws_delivery_ms"]["p99"],
        "hud_late_join_n": late_join_res["n_connections"],
        "hud_late_join_replay_p50_ms": late_join_res["connect_to_replay_complete_ms"]["p50"],
        "hud_late_join_replay_p95_ms": late_join_res["connect_to_replay_complete_ms"]["p95"],
        "hud_late_join_replay_p99_ms": late_join_res["connect_to_replay_complete_ms"]["p99"],
        "hud_late_join_replay_mean_ms": late_join_res["connect_to_replay_complete_ms"]["mean"],
        "hud_verdict_wire_bytes": late_join_res["wire_payload_bytes"]["verdict_bytes"],
        "hud_verdict_wire_kb": late_join_res["wire_payload_bytes"]["verdict_kb"],
        "hud_verdict_max_wire_bytes_across_levels": late_join_res["wire_payload_bytes"][
            "max_verdict_bytes_across_levels"
        ],
        "hud_verdict_under_1_5_kb": late_join_res["wire_payload_bytes"]["verdict_under_1_5_kb"],
        "hud_full_replay_wire_bytes": late_join_res["wire_payload_bytes"]["total_4_msg_replay_bytes"],
        "api_stats_n": telemetry_res["api_stats"]["n_requests"],
        "api_stats_p50_ms": telemetry_res["api_stats"]["latency_ms"]["p50"],
        "api_stats_p95_ms": telemetry_res["api_stats"]["latency_ms"]["p95"],
        "api_stats_p99_ms": telemetry_res["api_stats"]["latency_ms"]["p99"],
        "api_eval_summary_n": telemetry_res["api_eval_summary"]["n_requests"],
        "api_eval_summary_p50_ms": telemetry_res["api_eval_summary"]["latency_ms"]["p50"],
        "api_eval_summary_p95_ms": telemetry_res["api_eval_summary"]["latency_ms"]["p95"],
        "api_eval_summary_p99_ms": telemetry_res["api_eval_summary"]["latency_ms"]["p99"],
        "live_ping_rtt_p50_ms": adaptive_res["loopback_live_ping_pong_rtt"]["latency_ms"]["p50"],
        "live_ping_rtt_p95_ms": adaptive_res["loopback_live_ping_pong_rtt"]["latency_ms"]["p95"],
        "adaptive_tier_768_q78_bytes": adaptive_res["tiers"]["normal_lt_250ms"]["jpeg_bytes"],
        "adaptive_tier_640_q64_bytes": adaptive_res["tiers"]["medium_250_to_650ms"]["jpeg_bytes"],
        "adaptive_tier_512_q50_bytes": adaptive_res["tiers"]["slow_gt_650ms"]["jpeg_bytes"],
        "adaptive_12s_video_reduction_pct": adaptive_res["video_12s_reduction_slow_vs_normal_pct"],
        "gemini_api_calls": telemetry_res["api_stats"]["ledger_total_calls"],
    }

    report = sanitize_obj(
        {
            "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "generated_by": "eval/eval_hud_latency_bandwidth.py",
            "node_version": harness.node_version,
            "python_version": platform.python_version(),
            "transport": "tcp_loopback_127_0_0_1",
            "server_entrypoint": "startServer(0)",
            "gemini_api_calls": 0,
            "summary": summary,
            "ingest_frame_benchmark": ingest_res,
            "state_fanout_benchmark": fanout_res,
            "hud_late_join_replay_benchmark": late_join_res,
            "telemetry_endpoints_benchmark": telemetry_res,
            "adaptive_quality_and_rtt": adaptive_res,
        }
    )

    assert_clean_output(report)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return report


def main(argv: list[str] | None = None) -> int:
    self_text = pathlib.Path(__file__).read_text(encoding="utf-8")
    if COMMENT_CHAR in self_text:
        raise AssertionError("Forbidden comment character detected in benchmark script")

    parser = argparse.ArgumentParser(
        description="Deterministic TCP loopback Hub ingest, /hud-ws fan-out, late-join replay, and adaptive payload benchmark"
    )
    parser.add_argument(
        "--out",
        type=pathlib.Path,
        default=DEFAULT_OUT_PATH,
        help="Output JSON path",
    )
    args = parser.parse_args(argv)
    report = asyncio.run(run_all(args.out))
    print(json.dumps(report["summary"], indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
