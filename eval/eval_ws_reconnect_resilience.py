import argparse
import asyncio
import datetime
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
import urllib.parse
from typing import Any

import aiohttp

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
FIXTURE_PATH = REPO_ROOT / "web" / "public" / "fixtures" / "amlodipine.jpg"
DEFAULT_OUT_PATH = REPO_ROOT / "eval" / "ws_reconnect_resilience.json"

EXPECTED_FIXTURE_BYTES = 58414
N_RECONNECT_CYCLES = 50
N_HOSTILE_PAYLOADS = 100
PRE_STORM_VALID_FRAMES = 5
POST_STORM_PING_PROBES = 20
OVERSIZED_FRAME_BYTES = 6 * 1024 * 1024 + 65536

EM_DASH = chr(8212)
EN_DASH = chr(8211)
COMMENT_CHAR = chr(35)

ACTIVE_PROFILE: dict[str, Any] = {
    "meds": [
        {
            "id": "aml",
            "name": "Amlodipin Orion",
            "ingredient": "amlodipine",
            "strength": "5 mg",
            "schedule": ["evening"],
            "barcode": "6432100012345",
            "notes": "1 tablet in the evening",
        }
    ],
    "allergies": ["peanut", "hazelnut"],
    "avoid": ["NSAIDs"],
    "doseLog": [],
    "lang": "en",
}

ACTIVE_LABEL_READ: dict[str, Any] = {
    "kind": "medication",
    "product": {"value": "Amlodipin Orion", "confidence": 0.98},
    "ingredient": {"value": "amlodipine", "confidence": 0.98},
    "strength": {"value": "5 mg", "confidence": 0.98},
    "dosing": {"value": "1 tablet in the evening", "confidence": 0.95},
    "expiry": {"value": "2027-10", "confidence": 0.96},
    "allergens": {"value": None, "confidence": 0.0},
    "barcode": {"value": "6432100012345", "confidence": 0.96},
    "readability": 0.97,
}

SERVER_HARNESS_TS = """
import readline from "node:readline";
import { env } from "./server/src/env.ts";
import { getHub, startServer } from "./server/src/index.ts";
import { getOrCreateHub, hasHud, hubStats, markLatest, resetHubsForTest } from "./server/src/hub.ts";
import { toLabelRead, toProfile } from "./server/src/verify.ts";
import { checkLabel } from "./server/src/safety.ts";

process.env.HOLDUP_QUIET = "1";
env.apiKey = "";

const trackedSessionIds = new Set();
const origRandomUUID = globalThis.crypto.randomUUID.bind(globalThis.crypto);
globalThis.crypto.randomUUID = () => {
  const id = origRandomUUID();
  trackedSessionIds.add(id);
  return id;
};

let unhandledErrors = 0;
process.on("unhandledRejection", () => {
  unhandledErrors += 1;
});
process.on("uncaughtException", () => {
  unhandledErrors += 1;
});

const srv = await startServer(0);
const addr = srv.address();
const port = typeof addr === "object" && addr ? addr.port : 0;
process.stdout.write(
  JSON.stringify({
    event: "listening",
    port,
    node_version: process.version,
  }) + "\\n"
);

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
      trackedSessionIds.clear();
      process.stdout.write(
        JSON.stringify({ id, ok: true, result: { stats: hubStats(), unhandled_errors: unhandledErrors } }) + "\\n"
      );
      return;
    }
    if (cmd === "seed_active_session") {
      const sid = String(req.session || "sess_resilience");
      trackedSessionIds.add(sid);
      const profile = toProfile(req.profile);
      const verdict = checkLabel(toLabelRead(req.read), profile);
      const h = getOrCreateHub(sid);
      h.profile = profile;
      markLatest(h);
      h.emit({ type: "status", live: "open" });
      h.emit({ type: "coach", cue: "hold_still", text: "Hold steady so I can verify the strength." });
      h.emit({ type: "verdict", verdict });
      process.stdout.write(
        JSON.stringify({
          id,
          ok: true,
          result: {
            session: sid,
            verdict_level: verdict.level,
            matched_med_id: verdict.matchedMedId ?? null,
          },
        }) + "\\n"
      );
      return;
    }
    if (cmd === "inspect_state") {
      const extra = Array.isArray(req.sessions) ? req.sessions.map(String) : [];
      const allIds = Array.from(new Set([...trackedSessionIds, ...extra]));
      let totalBufferedFrames = 0;
      let totalLiveClients = 0;
      let totalSessionHudClients = 0;
      const perSession = {};
      for (const sid of allIds) {
        const h = getHub(sid);
        if (!h) {
          perSession[sid] = { exists: false, ring_len: 0, live_clients: 0, hud_clients: 0 };
          continue;
        }
        totalBufferedFrames += h.ring.length;
        totalLiveClients += h.clients.size;
        totalSessionHudClients += h.huds.size;
        perSession[sid] = {
          exists: true,
          ring_len: h.ring.length,
          live_clients: h.clients.size,
          hud_clients: h.huds.size,
          has_hud: hasHud(h),
          device_battery: h.device ? h.device.battery : null,
          last_verdict_level: h.lastVerdict ? h.lastVerdict.level : null,
          last_verdict_med_id: h.lastVerdict ? h.lastVerdict.matchedMedId ?? null : null,
          last_verdict_taken_today: Boolean(h.lastVerdict && h.lastVerdict.takenToday),
          dose_log_len: h.profile.doseLog.length,
          meds_len: h.profile.meds.length,
        };
      }
      const st = hubStats();
      process.stdout.write(
        JSON.stringify({
          id,
          ok: true,
          result: {
            stats: st,
            tracked_id_count: allIds.length,
            total_buffered_frames: totalBufferedFrames,
            total_live_clients: totalLiveClients,
            total_session_hud_clients: totalSessionHudClients,
            total_leaked_hud_refs: totalSessionHudClients + st.floatingHuds,
            unhandled_errors: unhandledErrors,
            per_session: perSession,
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
        self._write_lock = asyncio.Lock()
        self._pending: dict[int, asyncio.Future[Any]] = {}
        self._stderr_chunks: list[str] = []
        self._stderr_task: asyncio.Task[None] | None = None
        self._stdout_task: asyncio.Task[None] | None = None

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

        async def demux_stdout() -> None:
            assert self.proc is not None and self.proc.stdout is not None
            while True:
                raw = await self.proc.stdout.readline()
                if not raw:
                    for fut in list(self._pending.values()):
                        if not fut.done():
                            fut.set_exception(RuntimeError("Node harness stdout closed unexpectedly"))
                    self._pending.clear()
                    break
                text = raw.decode("utf-8", errors="replace").strip()
                if not text:
                    continue
                try:
                    msg = json.loads(text)
                except json.JSONDecodeError:
                    continue
                req_id = msg.get("id")
                if isinstance(req_id, int) and req_id in self._pending:
                    fut = self._pending.pop(req_id)
                    if not fut.done():
                        if msg.get("ok"):
                            fut.set_result(msg.get("result"))
                        else:
                            fut.set_exception(RuntimeError(f"Node RPC failed: {msg.get('error')}"))

        self._stdout_task = asyncio.create_task(demux_stdout())

    def is_alive(self) -> bool:
        return self.proc is not None and self.proc.returncode is None

    async def call(self, cmd: str, **kwargs: Any) -> Any:
        if self.proc is None or self.proc.stdin is None:
            raise RuntimeError("Node harness is not running")
        loop = asyncio.get_running_loop()
        async with self._write_lock:
            req_id = self._next_id
            self._next_id += 1
            fut: asyncio.Future[Any] = loop.create_future()
            self._pending[req_id] = fut
            payload = {"id": req_id, "cmd": cmd, **kwargs}
            self.proc.stdin.write((json.dumps(payload) + "\n").encode("utf-8"))
            await self.proc.stdin.drain()
        return await asyncio.wait_for(fut, timeout=15.0)

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
        for task in (self._stdout_task, self._stderr_task):
            if task is not None:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass


class WebSocketRecorder:
    def __init__(self, ws: aiohttp.ClientWebSocketResponse, label: str) -> None:
        self.ws = ws
        self.label = label
        self.messages: list[tuple[float, dict[str, Any], int]] = []
        self.queue: asyncio.Queue[tuple[float, dict[str, Any], int]] = asyncio.Queue()
        self.task: asyncio.Task[None] = asyncio.create_task(self._reader())

    async def _reader(self) -> None:
        try:
            async for msg in self.ws:
                t_arr = time.perf_counter()
                if msg.type == aiohttp.WSMsgType.TEXT:
                    raw_text = str(msg.data)
                    parsed = json.loads(raw_text)
                    entry = (t_arr, parsed, len(raw_text.encode("utf-8")))
                    self.messages.append(entry)
                    self.queue.put_nowait(entry)
                elif msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                    break
        except asyncio.CancelledError:
            raise
        except Exception:
            pass

    async def wait_for_match(
        self,
        predicate: Any,
        timeout_s: float = 10.0,
    ) -> tuple[float, dict[str, Any], int]:
        deadline = time.monotonic() + timeout_s
        deferred: list[tuple[float, dict[str, Any], int]] = []
        try:
            while True:
                remaining = max(0.05, deadline - time.monotonic())
                item = await asyncio.wait_for(self.queue.get(), timeout=remaining)
                if predicate(item[1]):
                    return item
                deferred.append(item)
        finally:
            for d in deferred:
                self.queue.put_nowait(d)

    async def finish(self) -> None:
        if not self.ws.closed:
            await self.ws.close()
        try:
            await asyncio.wait_for(self.task, timeout=2.0)
        except asyncio.TimeoutError:
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass


async def warmup_server(
    http: aiohttp.ClientSession,
    base_url: str,
    ws_base: str,
    jpeg_bytes: bytes,
    harness: NodeServerHarness,
) -> None:
    live_ws = await http.ws_connect(f"{ws_base}/live?session=warmup_res")
    hud_ws = await http.ws_connect(f"{ws_base}/hud-ws?session=warmup_res")
    _ = await live_ws.receive_json(timeout=3.0)
    for _ in range(2):
        async with http.post(
            f"{base_url}/ingest/frame?session=warmup_res",
            data=jpeg_bytes,
            headers={"Content-Type": "image/jpeg"},
        ) as resp:
            await resp.read()
            if resp.status != 204:
                raise RuntimeError(f"Warmup /ingest/frame returned {resp.status}")
        async with http.post(
            f"{base_url}/ingest/state?session=warmup_res",
            json={"connected": True, "worn": True, "streaming": True, "battery": 90},
        ) as resp:
            await resp.read()
            if resp.status != 204:
                raise RuntimeError(f"Warmup /ingest/state returned {resp.status}")
        _ = await live_ws.receive_json(timeout=3.0)
        _ = await hud_ws.receive_json(timeout=3.0)
    await hud_ws.close()
    await live_ws.close()
    await asyncio.sleep(0.03)
    await harness.call("reset")


async def bench_hud_flap_reconnect_storm(
    http: aiohttp.ClientSession,
    base_url: str,
    ws_base: str,
    harness: NodeServerHarness,
) -> dict[str, Any]:
    session_id = "sess_flap"
    live_ws = await http.ws_connect(f"{ws_base}/live?session={session_id}")
    live_rec = WebSocketRecorder(live_ws, f"live:{session_id}")

    seeded = await harness.call(
        "seed_active_session",
        session=session_id,
        profile=ACTIVE_PROFILE,
        read=ACTIVE_LABEL_READ,
    )
    if seeded.get("verdict_level") != "match" or seeded.get("matched_med_id") != "aml":
        raise AssertionError(f"Unexpected seeded verdict state: {seeded}")

    async with http.post(
        f"{base_url}/ingest/state?session={session_id}",
        json={"connected": True, "worn": True, "streaming": True, "battery": 86},
    ) as resp:
        await resp.read()
        if resp.status != 204:
            raise RuntimeError(f"Seed /ingest/state failed with {resp.status}")

    await live_rec.wait_for_match(lambda m: m.get("type") == "device")

    expected_sequence = ["status", "device", "coach", "verdict"]
    reconnect_total_ms: list[float] = []
    handshake_ms: list[float] = []
    replay_drain_ms: list[float] = []
    close_handshake_ms: list[float] = []
    complete_cycles = 0
    wire_bytes_per_cycle = 0
    zero_code_cycles = 0
    explicit_session_cycles = 0

    t_flap_wall_start = time.perf_counter()
    try:
        for cycle in range(N_RECONNECT_CYCLES):
            use_explicit = (cycle % 2) == 1
            url = f"{ws_base}/hud-ws?session={session_id}" if use_explicit else f"{ws_base}/hud-ws"
            if use_explicit:
                explicit_session_cycles += 1
            else:
                zero_code_cycles += 1

            t0 = time.perf_counter()
            hud_ws = await http.ws_connect(url)
            t_open = time.perf_counter()

            seen_types: list[str] = []
            cycle_bytes = 0
            payload_valid = True
            try:
                for _ in range(4):
                    msg = await hud_ws.receive(timeout=3.0)
                    if msg.type != aiohttp.WSMsgType.TEXT:
                        payload_valid = False
                        break
                    raw_text = str(msg.data)
                    cycle_bytes += len(raw_text.encode("utf-8"))
                    parsed = json.loads(raw_text)
                    mtype = str(parsed.get("type") or "")
                    seen_types.append(mtype)
                    if mtype == "status" and parsed.get("live") != "open":
                        payload_valid = False
                    elif mtype == "device":
                        dev = parsed.get("device") or {}
                        if dev.get("battery") != 86 or dev.get("worn") is not True:
                            payload_valid = False
                    elif mtype == "coach" and parsed.get("cue") != "hold_still":
                        payload_valid = False
                    elif mtype == "verdict":
                        v = parsed.get("verdict") or {}
                        if v.get("level") != "match" or v.get("matchedMedId") != "aml":
                            payload_valid = False
                t_replayed = time.perf_counter()
            finally:
                t_close_start = time.perf_counter()
                await hud_ws.close()
                t_closed = time.perf_counter()

            if seen_types == expected_sequence and payload_valid:
                complete_cycles += 1
            wire_bytes_per_cycle = cycle_bytes
            handshake_ms.append(round((t_open - t0) * 1000.0, 3))
            replay_drain_ms.append(round((t_replayed - t_open) * 1000.0, 3))
            reconnect_total_ms.append(round((t_replayed - t0) * 1000.0, 3))
            close_handshake_ms.append(round((t_closed - t_close_start) * 1000.0, 3))

        health_json: dict[str, Any] = {}
        snap_after_flaps: dict[str, Any] = {}
        for _ in range(30):
            async with http.get(f"{base_url}/api/health") as resp:
                raw_h = await resp.read()
                if resp.status != 200:
                    raise RuntimeError(f"GET /api/health returned {resp.status}")
                health_json = json.loads(raw_h.decode("utf-8"))
            snap_after_flaps = await harness.call("inspect_state", sessions=[session_id])
            if (
                int(health_json.get("floatingHuds", -1)) == 0
                and int(snap_after_flaps["total_leaked_hud_refs"]) == 0
            ):
                break
            await asyncio.sleep(0.005)
    finally:
        await live_rec.finish()

    flap_wall_ms = round((time.perf_counter() - t_flap_wall_start) * 1000.0, 3)

    await asyncio.sleep(0.02)
    await harness.call("reset")

    floating_huds_in_health = int(health_json.get("floatingHuds", -1))
    session_huds_after = int(snap_after_flaps["total_session_hud_clients"])
    total_leaked_hud_refs = int(snap_after_flaps["total_leaked_hud_refs"])
    completeness_rate = round(complete_cycles / float(N_RECONNECT_CYCLES), 4)

    if complete_cycles != N_RECONNECT_CYCLES or completeness_rate != 1.0:
        raise AssertionError(
            f"Expected {N_RECONNECT_CYCLES}/{N_RECONNECT_CYCLES} complete 4-msg replays, got {complete_cycles}"
        )
    if not health_json.get("ok") or floating_huds_in_health != 0 or total_leaked_hud_refs != 0:
        raise AssertionError(
            f"Leaked HUD references after flap storm: health={health_json}, snap={snap_after_flaps}"
        )

    return {
        "n_reconnect_cycles": N_RECONNECT_CYCLES,
        "zero_code_latest_attach_cycles": zero_code_cycles,
        "explicit_session_attach_cycles": explicit_session_cycles,
        "expected_4_msg_sequence": expected_sequence,
        "complete_4_msg_replays": complete_cycles,
        "replay_completeness_rate": completeness_rate,
        "replay_wire_bytes_per_cycle": wire_bytes_per_cycle,
        "flap_total_wall_ms": flap_wall_ms,
        "replay_reconnect_latency_ms": summarize_latencies(reconnect_total_ms),
        "ws_handshake_latency_ms": summarize_latencies(handshake_ms),
        "replay_drain_latency_ms": summarize_latencies(replay_drain_ms),
        "ws_close_latency_ms": summarize_latencies(close_handshake_ms),
        "api_health_after_flap": {
            "ok": bool(health_json.get("ok")),
            "floatingHuds": floating_huds_in_health,
            "sessions": int(health_json.get("sessions", 0)),
        },
        "session_hud_refs_after_flap": session_huds_after,
        "leaked_hud_refs": total_leaked_hud_refs,
        "samples_ms": reconnect_total_ms,
    }


async def bench_hostile_payload_storm(
    http: aiohttp.ClientSession,
    base_url: str,
    ws_base: str,
    jpeg_bytes: bytes,
    harness: NodeServerHarness,
) -> dict[str, Any]:
    session_id = "sess_storm"
    live_ws = await http.ws_connect(f"{ws_base}/live?session={session_id}")
    live_rec = WebSocketRecorder(live_ws, f"live:{session_id}")
    hud_ws = await http.ws_connect(f"{ws_base}/hud-ws?session={session_id}")
    hud_rec = WebSocketRecorder(hud_ws, f"hud:{session_id}")

    await live_rec.wait_for_match(lambda m: m.get("type") == "hud" and m.get("connected") is True)

    await harness.call(
        "seed_active_session",
        session=session_id,
        profile=ACTIVE_PROFILE,
        read=ACTIVE_LABEL_READ,
    )
    async with http.post(
        f"{base_url}/ingest/state?session={session_id}",
        json={"connected": True, "worn": True, "streaming": True, "battery": 86},
    ) as resp:
        await resp.read()
        if resp.status != 204:
            raise RuntimeError(f"Pre-storm /ingest/state failed with {resp.status}")

    for _ in range(3):
        await hud_rec.wait_for_match(lambda m: m.get("type") in ("coach", "verdict", "device"))
        await live_rec.wait_for_match(lambda m: m.get("type") in ("coach", "verdict", "device"))

    for idx in range(PRE_STORM_VALID_FRAMES):
        async with http.post(
            f"{base_url}/ingest/frame?session={session_id}&sharpness={0.5 + idx * 0.05:.3f}",
            data=jpeg_bytes,
            headers={"Content-Type": "image/jpeg"},
        ) as resp:
            await resp.read()
            if resp.status != 204:
                raise RuntimeError(f"Pre-storm valid frame {idx} failed with {resp.status}")

    pre_snap = await harness.call("inspect_state", sessions=[session_id])
    if int(pre_snap["per_session"][session_id]["ring_len"]) != PRE_STORM_VALID_FRAMES:
        raise AssertionError(f"Expected {PRE_STORM_VALID_FRAMES} pre-storm buffered frames, got {pre_snap}")

    live_msg_baseline_idx = len(live_rec.messages)
    hud_msg_baseline_idx = len(hud_rec.messages)

    oversized_jpeg = b"\xff\xd8\xff\xe0" + (b"\x5a" * (OVERSIZED_FRAME_BYTES - 6)) + b"\xff\xd9"

    binary_payloads: list[bytes] = [
        b"\x00",
        b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01",
        b"\xff\xfe\xfd\xfc\x80\x81",
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR",
        bytes(range(64)),
        b"\x00" * 512,
        b"\xde\xad\xbe\xef" * 128,
        b"RIFF\x24\x00\x00\x00WAVEfmt ",
        b"\xc3\x28\xa0\xa1",
        b"\xf0\x28\x8c\xbc",
        b"\x7fELF\x02\x01\x01\x00",
        b"PK\x03\x04\x14\x00\x00\x00",
        b"\x1f\x8b\x08\x00\x00\x00\x00\x00",
        b"\xff" * 1024,
        b"\x01\x02\x03\x04\x05\x06\x07\x08",
        jpeg_bytes[:2048],
    ]

    live_truncated_json_payloads: list[str] = [
        "{",
        '{"type":',
        '{"type":"ping","t":',
        '{"type":"frame","data":"unterminated',
        "[1, 2, 3",
        "undefined",
        "NaN",
        '{"type":"event",}',
        "{bad_key: 1}",
        "\x00{\"type\":\"ping\"}",
    ]

    hud_truncated_json_payloads: list[str] = [
        "{",
        '{"type":"event","name":',
        "[broken",
        "not-json-at-all",
    ]

    http_truncated_state_payloads: list[bytes] = [
        b"{",
        b'{"connected": true, "battery":',
        b"[unclosed",
        b'{"worn": tru',
    ]

    live_unknown_and_malformed_msgs: list[tuple[str, str]] = [
        (json.dumps({"type": "exec", "cmd": "id"}), "unknown message type"),
        (json.dumps({"type": "__proto__", "pollute": 1}), "unknown message type"),
        (json.dumps({"type": "constructor"}), "unknown message type"),
        (json.dumps({"type": "verdict", "verdict": {"level": "match"}}), "unknown message type"),
        (json.dumps({"type": "device", "device": {"battery": 1}}), "unknown message type"),
        (json.dumps({"type": "hud", "connected": False}), "unknown message type"),
        (json.dumps({}), "unknown message type"),
        ("null", "unknown message type"),
        ("42", "unknown message type"),
        (json.dumps(["ping"]), "unknown message type"),
        (json.dumps({"type": "frame", "data": "tiny"}), "frame.data must be base64 JPEG"),
        (json.dumps({"type": "frame", "data": ""}), "frame.data must be base64 JPEG"),
        (json.dumps({"type": "frame", "data": 123456}), "frame.data must be base64 JPEG"),
        (json.dumps({"type": "frame"}), "frame.data must be base64 JPEG"),
        (json.dumps({"type": "text", "text": "Is this my evening pill?"}), "send start first"),
        (json.dumps({"type": "text", "text": "Read strength before start"}), "send start first"),
    ]

    undersized_frame_specs: list[tuple[bytes, str]] = [
        (b"", "image/jpeg"),
        (b"x", "image/jpeg"),
        (b"\xff\xd8\xff\xd9", "image/jpeg"),
        (b"short_jpeg_payload_under_100_bytes", "image/jpeg"),
        (b"a" * 50, "image/jpeg"),
        (b"b" * 99, "image/jpeg"),
        (b"\x00" * 64, "application/octet-stream"),
        (b"c" * 99, "application/octet-stream"),
        (b"plain text frame body " * 10, "text/plain"),
        (json.dumps({"frame": "not_raw"}).encode("utf-8"), "application/json"),
        (b"form=1&bad=2" * 20, "application/x-www-form-urlencoded"),
        (b"tiny_octets", "application/octet-stream"),
    ]

    invalid_http_sessions: list[str] = [
        "ghost_unregistered_01",
        "ghost_unregistered_02",
        "ab",
        "../etc/passwd",
        "sess" + ("x" * 80),
        "sess space bad",
        "sess;drop_table",
        "<script>alert(1)</script>",
    ]

    invalid_ws_sessions: list[str] = [
        "x",
        "abc",
        "../../etc/shadow",
        "overlong_" + ("y" * 75),
        "bad space id",
        "null%00byte",
        "semi;colon",
        "slash/inside",
    ]

    unauthorized_hud_payloads: list[dict[str, Any]] = [
        {"type": "event", "name": "wipe_all_data"},
        {"type": "event", "name": "stop"},
        {"type": "event", "name": "start"},
        {"type": "event", "name": "__proto__"},
        {"type": "event", "name": "constructor"},
        {"type": "event", "name": "toString"},
        {"type": "event", "name": "override_verdict"},
        {"type": "event", "name": ""},
        {"type": "event", "name": 9999},
        {"type": "event", "name": None},
        {"type": "start", "profile": {"meds": []}, "lang": "fi", "voice": False, "source": "glasses"},
        {"type": "verdict", "verdict": {"level": "warning", "headline": "Spoof", "speech": "Spoof", "reasons": []}},
        {"type": "coach", "cue": "ok", "text": "Spoofed coach cue"},
        {"type": "device", "device": {"connected": False, "worn": False, "battery": 1, "streaming": False, "source": "phone"}},
        {"type": "frame", "data": "A" * 256, "w": 64, "h": 64, "sharpness": 0.9, "ts": 1},
        {"type": "ping", "t": 777},
    ]

    total_planned = (
        len(binary_payloads)
        + len(live_truncated_json_payloads)
        + len(hud_truncated_json_payloads)
        + len(http_truncated_state_payloads)
        + len(live_unknown_and_malformed_msgs)
        + len(undersized_frame_specs)
        + 6
        + len(invalid_http_sessions)
        + len(invalid_ws_sessions)
        + len(unauthorized_hud_payloads)
    )
    if total_planned != N_HOSTILE_PAYLOADS:
        raise AssertionError(f"Expected exactly {N_HOSTILE_PAYLOADS} hostile payloads, planned {total_planned}")

    live_send_lock = asyncio.Lock()
    hud_send_lock = asyncio.Lock()
    category_counts: dict[str, dict[str, int]] = {
        "live_ws_binary_frames": {"sent": 0, "graceful": 0},
        "truncated_malformed_json": {"sent": 0, "graceful": 0},
        "live_ws_unknown_and_malformed_types": {"sent": 0, "graceful": 0},
        "ingest_frame_oversized_undersized": {"sent": 0, "graceful": 0},
        "invalid_session_params": {"sent": 0, "graceful": 0},
        "unauthorized_hud_ws_events": {"sent": 0, "graceful": 0},
    }

    expected_live_error_messages: dict[str, int] = {
        "send JSON text frames": len(binary_payloads),
        "invalid JSON": len(live_truncated_json_payloads),
        "unknown message type": 10,
        "frame.data must be base64 JPEG": 4,
        "send start first": 2,
    }
    expected_total_live_errors = sum(expected_live_error_messages.values())

    start_gate = asyncio.Event()
    op_latencies_ms: list[float] = []

    async def send_live_binary(payload: bytes) -> None:
        await start_gate.wait()
        t0 = time.perf_counter()
        async with live_send_lock:
            await live_ws.send_bytes(payload)
        op_latencies_ms.append(round((time.perf_counter() - t0) * 1000.0, 3))
        category_counts["live_ws_binary_frames"]["sent"] += 1

    async def send_live_truncated(raw_str: str) -> None:
        await start_gate.wait()
        t0 = time.perf_counter()
        async with live_send_lock:
            await live_ws.send_str(raw_str)
        op_latencies_ms.append(round((time.perf_counter() - t0) * 1000.0, 3))
        category_counts["truncated_malformed_json"]["sent"] += 1

    async def send_hud_truncated(raw_str: str) -> None:
        await start_gate.wait()
        t0 = time.perf_counter()
        async with hud_send_lock:
            await hud_ws.send_str(raw_str)
        op_latencies_ms.append(round((time.perf_counter() - t0) * 1000.0, 3))
        category_counts["truncated_malformed_json"]["sent"] += 1
        if not hud_ws.closed:
            category_counts["truncated_malformed_json"]["graceful"] += 1

    async def send_http_truncated_state(raw_body: bytes) -> None:
        await start_gate.wait()
        t0 = time.perf_counter()
        async with http.post(
            f"{base_url}/ingest/state?session={session_id}",
            data=raw_body,
            headers={"Content-Type": "application/json"},
        ) as resp:
            await resp.read()
            status = resp.status
        op_latencies_ms.append(round((time.perf_counter() - t0) * 1000.0, 3))
        category_counts["truncated_malformed_json"]["sent"] += 1
        if status == 400:
            category_counts["truncated_malformed_json"]["graceful"] += 1

    async def send_live_unknown_or_bad(raw_json: str) -> None:
        await start_gate.wait()
        t0 = time.perf_counter()
        async with live_send_lock:
            await live_ws.send_str(raw_json)
        op_latencies_ms.append(round((time.perf_counter() - t0) * 1000.0, 3))
        category_counts["live_ws_unknown_and_malformed_types"]["sent"] += 1

    async def send_undersized_frame(body: bytes, content_type: str) -> None:
        await start_gate.wait()
        t0 = time.perf_counter()
        async with http.post(
            f"{base_url}/ingest/frame?session={session_id}",
            data=body,
            headers={"Content-Type": content_type},
        ) as resp:
            raw = await resp.read()
            status = resp.status
        op_latencies_ms.append(round((time.perf_counter() - t0) * 1000.0, 3))
        category_counts["ingest_frame_oversized_undersized"]["sent"] += 1
        if status == 400:
            parsed = json.loads(raw.decode("utf-8"))
            if parsed.get("type") == "error" and parsed.get("code") == "bad_input":
                category_counts["ingest_frame_oversized_undersized"]["graceful"] += 1

    async def send_oversized_frame() -> None:
        await start_gate.wait()
        t0 = time.perf_counter()
        status = 0
        conn_closed_early = False
        try:
            async with http.post(
                f"{base_url}/ingest/frame?session={session_id}",
                data=oversized_jpeg,
                headers={"Content-Type": "image/jpeg", "Expect": "100-continue"},
            ) as resp:
                await resp.read()
                status = resp.status
        except aiohttp.ClientConnectionError:
            conn_closed_early = True
        op_latencies_ms.append(round((time.perf_counter() - t0) * 1000.0, 3))
        category_counts["ingest_frame_oversized_undersized"]["sent"] += 1
        if status == 413 or conn_closed_early:
            category_counts["ingest_frame_oversized_undersized"]["graceful"] += 1

    async def send_invalid_session_http(bad_sid: str) -> None:
        await start_gate.wait()
        q = urllib.parse.quote(bad_sid, safe="")
        t0 = time.perf_counter()
        async with http.post(
            f"{base_url}/ingest/frame?session={q}",
            data=jpeg_bytes,
            headers={"Content-Type": "image/jpeg"},
        ) as resp:
            await resp.read()
            status = resp.status
        op_latencies_ms.append(round((time.perf_counter() - t0) * 1000.0, 3))
        category_counts["invalid_session_params"]["sent"] += 1
        if status == 204:
            category_counts["invalid_session_params"]["graceful"] += 1

    async def send_invalid_session_ws(bad_sid: str, idx: int) -> None:
        await start_gate.wait()
        q = urllib.parse.quote(bad_sid, safe="")
        t0 = time.perf_counter()
        ws = await http.ws_connect(f"{ws_base}/live?session={q}")
        try:
            tok = 9000 + idx
            await ws.send_str(json.dumps({"type": "ping", "t": tok}))
            pong = await ws.receive_json(timeout=5.0)
            ok = pong.get("type") == "pong" and pong.get("t") == tok
        finally:
            await ws.close()
        op_latencies_ms.append(round((time.perf_counter() - t0) * 1000.0, 3))
        category_counts["invalid_session_params"]["sent"] += 1
        if ok:
            category_counts["invalid_session_params"]["graceful"] += 1

    async def send_unauthorized_hud(payload: dict[str, Any]) -> None:
        await start_gate.wait()
        t0 = time.perf_counter()
        async with hud_send_lock:
            await hud_ws.send_str(json.dumps(payload))
        op_latencies_ms.append(round((time.perf_counter() - t0) * 1000.0, 3))
        category_counts["unauthorized_hud_ws_events"]["sent"] += 1
        if not hud_ws.closed:
            category_counts["unauthorized_hud_ws_events"]["graceful"] += 1

    tasks: list[asyncio.Task[None]] = []
    for bp in binary_payloads:
        tasks.append(asyncio.create_task(send_live_binary(bp)))
    for tj in live_truncated_json_payloads:
        tasks.append(asyncio.create_task(send_live_truncated(tj)))
    for htj in hud_truncated_json_payloads:
        tasks.append(asyncio.create_task(send_hud_truncated(htj)))
    for htb in http_truncated_state_payloads:
        tasks.append(asyncio.create_task(send_http_truncated_state(htb)))
    for raw_json, _ in live_unknown_and_malformed_msgs:
        tasks.append(asyncio.create_task(send_live_unknown_or_bad(raw_json)))
    for body, ctype in undersized_frame_specs:
        tasks.append(asyncio.create_task(send_undersized_frame(body, ctype)))
    for _ in range(6):
        tasks.append(asyncio.create_task(send_oversized_frame()))
    for bsid in invalid_http_sessions:
        tasks.append(asyncio.create_task(send_invalid_session_http(bsid)))
    for idx, bsid in enumerate(invalid_ws_sessions):
        tasks.append(asyncio.create_task(send_invalid_session_ws(bsid, idx)))
    for up in unauthorized_hud_payloads:
        tasks.append(asyncio.create_task(send_unauthorized_hud(up)))

    await asyncio.sleep(0.01)
    t_storm_start = time.perf_counter()
    start_gate.set()
    await asyncio.gather(*tasks)

    deadline = time.monotonic() + 8.0
    while len(live_rec.messages) - live_msg_baseline_idx < expected_total_live_errors:
        if time.monotonic() >= deadline:
            break
        await asyncio.sleep(0.005)
    storm_wall_ms = round((time.perf_counter() - t_storm_start) * 1000.0, 3)

    await asyncio.sleep(0.03)

    observed_live_errors: dict[str, int] = {}
    for _, msg_obj, _ in live_rec.messages[live_msg_baseline_idx:]:
        if msg_obj.get("type") == "error" and msg_obj.get("code") == "bad_input" and msg_obj.get("recoverable") is True:
            etext = str(msg_obj.get("message") or "")
            observed_live_errors[etext] = observed_live_errors.get(etext, 0) + 1

    category_counts["live_ws_binary_frames"]["graceful"] = min(
        len(binary_payloads),
        observed_live_errors.get("send JSON text frames", 0),
    )
    category_counts["truncated_malformed_json"]["graceful"] += min(
        len(live_truncated_json_payloads),
        observed_live_errors.get("invalid JSON", 0),
    )
    category_counts["live_ws_unknown_and_malformed_types"]["graceful"] = (
        min(10, observed_live_errors.get("unknown message type", 0))
        + min(4, observed_live_errors.get("frame.data must be base64 JPEG", 0))
        + min(2, observed_live_errors.get("send start first", 0))
    )

    hud_unexpected_msgs = len(hud_rec.messages) - hud_msg_baseline_idx
    mid_snap = await harness.call(
        "inspect_state",
        sessions=[session_id, *invalid_http_sessions, *invalid_ws_sessions],
    )
    active_mid = mid_snap["per_session"][session_id]

    state_intact_after_storm = (
        hud_unexpected_msgs == 0
        and int(active_mid["ring_len"]) == PRE_STORM_VALID_FRAMES
        and int(active_mid["dose_log_len"]) == 0
        and int(active_mid["meds_len"]) == 1
        and active_mid["device_battery"] == 86
        and active_mid["last_verdict_level"] == "match"
        and active_mid["last_verdict_med_id"] == "aml"
        and active_mid["last_verdict_taken_today"] is False
    )
    if not state_intact_after_storm:
        category_counts["unauthorized_hud_ws_events"]["graceful"] = 0

    for bad_sid in [*invalid_http_sessions, *invalid_ws_sessions]:
        if mid_snap["per_session"].get(bad_sid, {}).get("exists"):
            category_counts["invalid_session_params"]["graceful"] = 0

    while not live_rec.queue.empty():
        live_rec.queue.get_nowait()

    ping_samples_ms: list[float] = []
    for idx in range(POST_STORM_PING_PROBES):
        tok = 50000 + idx
        t_ping = time.perf_counter()
        await live_ws.send_str(json.dumps({"type": "ping", "t": tok}))
        _, pong_msg, _ = await live_rec.wait_for_match(
            lambda m, expected=tok: m.get("type") == "pong" and m.get("t") == expected,
            timeout_s=3.0,
        )
        dt_ping = round((time.perf_counter() - t_ping) * 1000.0, 3)
        if pong_msg.get("t") != tok:
            raise AssertionError(f"Post-storm pong token mismatch: {pong_msg}")
        ping_samples_ms.append(dt_ping)

    await hud_rec.finish()
    await live_rec.finish()

    post_snap: dict[str, Any] = {}
    for _ in range(40):
        post_snap = await harness.call("inspect_state", sessions=[session_id])
        if (
            int(post_snap["total_live_clients"]) == 0
            and int(post_snap["total_buffered_frames"]) == 0
            and int(post_snap["total_leaked_hud_refs"]) == 0
        ):
            break
        await asyncio.sleep(0.005)

    async with http.get(f"{base_url}/api/health") as resp:
        raw_health = await resp.read()
        if resp.status != 200:
            raise RuntimeError(f"Post-storm GET /api/health returned {resp.status}")
        post_health = json.loads(raw_health.decode("utf-8"))

    async with http.get(f"{base_url}/api/stats") as resp:
        raw_stats = await resp.read()
        if resp.status != 200:
            raise RuntimeError(f"Post-storm GET /api/stats returned {resp.status}")
        ledger_stats = json.loads(raw_stats.decode("utf-8"))

    total_sent = sum(v["sent"] for v in category_counts.values())
    total_graceful = sum(v["graceful"] for v in category_counts.values())
    graceful_rate = round(total_graceful / float(N_HOSTILE_PAYLOADS), 4)
    unhandled_errors = int(post_snap["unhandled_errors"])
    server_crash_count = (0 if harness.is_alive() else 1) + unhandled_errors
    post_storm_buffered_frames = int(post_snap["total_buffered_frames"])
    ping_summary = summarize_latencies(ping_samples_ms)
    gemini_calls = int(ledger_stats.get("total", -1))

    if total_sent != N_HOSTILE_PAYLOADS or total_graceful != N_HOSTILE_PAYLOADS or graceful_rate != 1.0:
        raise AssertionError(
            f"Expected {N_HOSTILE_PAYLOADS}/{N_HOSTILE_PAYLOADS} graceful rejections, got {category_counts} (errors={observed_live_errors})"
        )
    if server_crash_count != 0:
        raise AssertionError(f"Server crash or unhandled error observed: {server_crash_count}")
    if post_storm_buffered_frames != 0:
        raise AssertionError(f"Expected 0 post-storm buffered frames, got {post_storm_buffered_frames}")
    if not post_health.get("ok") or int(post_health.get("floatingHuds", -1)) != 0:
        raise AssertionError(f"Unhealthy post-storm /api/health: {post_health}")
    if gemini_calls != 0:
        raise AssertionError(f"Expected 0 Gemini API calls, observed {gemini_calls}")

    return {
        "n_hostile_payloads": total_sent,
        "graceful_rejections": total_graceful,
        "graceful_rejection_rate": graceful_rate,
        "server_crash_count": server_crash_count,
        "unhandled_exception_or_rejection_count": unhandled_errors,
        "storm_wall_clock_ms": storm_wall_ms,
        "hostile_op_latency_ms": summarize_latencies(op_latencies_ms),
        "categories": category_counts,
        "live_ws_error_frames_verified": observed_live_errors,
        "active_session_integrity_preserved_under_storm": state_intact_after_storm,
        "pre_disconnect_valid_frames_retained": int(active_mid["ring_len"]),
        "post_storm_ping_pong": {
            "n_probes": POST_STORM_PING_PROBES,
            "first_probe_ms": ping_samples_ms[0],
            "latency_ms": ping_summary,
            "samples_ms": ping_samples_ms,
        },
        "post_storm_buffered_frames": post_storm_buffered_frames,
        "post_storm_leaked_hud_refs": int(post_snap["total_leaked_hud_refs"]),
        "post_storm_api_health": {
            "ok": bool(post_health.get("ok")),
            "floatingHuds": int(post_health.get("floatingHuds", -1)),
            "sessions": int(post_health.get("sessions", 0)),
        },
        "gemini_api_calls": gemini_calls,
    }


async def run_benchmark(out_path: pathlib.Path) -> dict[str, Any]:
    if not FIXTURE_PATH.is_file():
        raise FileNotFoundError(f"Missing fixture: {FIXTURE_PATH}")
    jpeg_bytes = FIXTURE_PATH.read_bytes()
    if len(jpeg_bytes) != EXPECTED_FIXTURE_BYTES:
        raise AssertionError(
            f"Expected {EXPECTED_FIXTURE_BYTES} bytes for amlodipine.jpg, got {len(jpeg_bytes)}"
        )

    with tempfile.TemporaryDirectory(prefix="holdup_ws_resilience_") as tmp_dir:
        ledger_path = pathlib.Path(tmp_dir) / "ledger.jsonl"
        env_map = build_clean_server_env(ledger_path)
        node_bin = resolve_node_bin(env_map)
        harness = NodeServerHarness(node_bin, env_map)
        await harness.start()

        base_url = f"http://127.0.0.1:{harness.port}"
        ws_base = f"ws://127.0.0.1:{harness.port}"

        connector = aiohttp.TCPConnector(limit=128, force_close=False)
        timeout = aiohttp.ClientTimeout(total=30.0)

        try:
            async with aiohttp.ClientSession(
                connector=connector,
                timeout=timeout,
                trust_env=False,
            ) as http:
                await warmup_server(http, base_url, ws_base, jpeg_bytes, harness)
                flap_res = await bench_hud_flap_reconnect_storm(http, base_url, ws_base, harness)
                storm_res = await bench_hostile_payload_storm(http, base_url, ws_base, jpeg_bytes, harness)
        finally:
            await harness.stop()

    ping_after_ms = storm_res["post_storm_ping_pong"]["latency_ms"]["p50"]

    summary: dict[str, Any] = {
        "n_reconnect_cycles": flap_res["n_reconnect_cycles"],
        "replay_completeness_rate": flap_res["replay_completeness_rate"],
        "replay_reconnect_p50_ms": flap_res["replay_reconnect_latency_ms"]["p50"],
        "replay_reconnect_p95_ms": flap_res["replay_reconnect_latency_ms"]["p95"],
        "n_hostile_payloads": storm_res["n_hostile_payloads"],
        "graceful_rejection_rate": storm_res["graceful_rejection_rate"],
        "server_crash_count": storm_res["server_crash_count"],
        "ping_pong_after_storm_ms": ping_after_ms,
        "post_storm_buffered_frames": storm_res["post_storm_buffered_frames"],
        "leaked_hud_refs_in_health": flap_res["api_health_after_flap"]["floatingHuds"],
        "gemini_api_calls": storm_res["gemini_api_calls"],
    }

    report = sanitize_obj(
        {
            "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "generated_by": "eval/eval_ws_reconnect_resilience.py",
            "node_version": harness.node_version,
            "python_version": platform.python_version(),
            "transport": "tcp_loopback_127_0_0_1",
            "server_entrypoint": "startServer(0)",
            "gemini_api_calls": 0,
            "summary": summary,
            "hud_flap_reconnect_benchmark": flap_res,
            "hostile_payload_storm_benchmark": storm_res,
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
    if EM_DASH in self_text or EN_DASH in self_text:
        raise AssertionError("Forbidden dash character detected in benchmark script")

    parser = argparse.ArgumentParser(
        description="WebSocket reconnect storm, hostile payload backpressure, and 4-message HUD state-replay latency benchmark"
    )
    parser.add_argument(
        "--out",
        type=pathlib.Path,
        default=DEFAULT_OUT_PATH,
        help="Output JSON path",
    )
    args = parser.parse_args(argv)
    report = asyncio.run(run_benchmark(args.out))
    print(json.dumps(report["summary"], indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
