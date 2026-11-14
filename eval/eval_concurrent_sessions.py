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
from typing import Any

import aiohttp

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
FIXTURE_PATH = REPO_ROOT / "web" / "public" / "fixtures" / "amlodipine.jpg"
DEFAULT_OUT_PATH = REPO_ROOT / "eval" / "concurrent_sessions_results.json"

EXPECTED_FIXTURE_BYTES = 58414
N_CONCURRENT_SESSIONS = 25
N_CONCURRENT_WEBSOCKETS = 50
FRAMES_PER_SESSION = 10
TOTAL_FRAMES_INGESTED = N_CONCURRENT_SESSIONS * FRAMES_PER_SESSION
RING_CAPACITY = 8
BATTERY_BASE = 50

EM_DASH = chr(8212)
EN_DASH = chr(8211)
COMMENT_CHAR = chr(35)

SESSION_MED_CATALOG: list[dict[str, str]] = [
    {"brand": "Amlodipin", "ingredient": "amlodipine", "strength": "5 mg"},
    {"brand": "Metformin", "ingredient": "metformin", "strength": "500 mg"},
    {"brand": "Panadol", "ingredient": "paracetamol", "strength": "500 mg"},
    {"brand": "Emconcor", "ingredient": "bisoprolol", "strength": "5 mg"},
    {"brand": "Cardace", "ingredient": "ramipril", "strength": "5 mg"},
]

SERVER_HARNESS_TS = """
import readline from "node:readline";
import { env } from "./server/src/env.ts";
import { getHub, startServer } from "./server/src/index.ts";
import { getOrCreateHub, hasHud, hubStats, markLatest, resetHubsForTest } from "./server/src/hub.ts";
import { toLabelRead, toProfile } from "./server/src/verify.ts";
import { checkLabel } from "./server/src/safety.ts";

process.env.HOLDUP_QUIET = "1";
env.apiKey = "";

function readMem(runGc) {
  if (runGc && typeof globalThis.gc === "function") {
    globalThis.gc();
    globalThis.gc();
  }
  const m = process.memoryUsage();
  return {
    rss_bytes: m.rss,
    heap_total_bytes: m.heapTotal,
    heap_used_bytes: m.heapUsed,
    external_bytes: m.external,
    array_buffers_bytes: m.arrayBuffers,
    heap_mb: Math.round((m.heapUsed / (1024 * 1024)) * 1000) / 1000,
    rss_mb: Math.round((m.rss / (1024 * 1024)) * 1000) / 1000,
  };
}

const srv = await startServer(0);
const addr = srv.address();
const port = typeof addr === "object" && addr ? addr.port : 0;
process.stdout.write(
  JSON.stringify({
    event: "listening",
    port,
    node_version: process.version,
    gc_exposed: typeof globalThis.gc === "function",
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
      const mem = readMem(Boolean(req.gc));
      process.stdout.write(JSON.stringify({ id, ok: true, result: { stats: hubStats(), mem } }) + "\\n");
      return;
    }
    if (cmd === "memory") {
      process.stdout.write(JSON.stringify({ id, ok: true, result: readMem(Boolean(req.gc)) }) + "\\n");
      return;
    }
    if (cmd === "ring_len") {
      const sid = String(req.session || "");
      const h = getHub(sid);
      process.stdout.write(
        JSON.stringify({
          id,
          ok: true,
          result: { session: sid, exists: Boolean(h), ring_len: h ? h.ring.length : 0 },
        }) + "\\n"
      );
      return;
    }
    if (cmd === "seed_and_emit_session") {
      const sid = String(req.session || "");
      const medId = String(req.med_id || "med_" + sid);
      const brand = String(req.brand || "Amlodipin");
      const ingredient = String(req.ingredient || "amlodipine");
      const strength = String(req.strength || "5 mg");
      const barcode = String(req.barcode || "6432100000000");
      const productLabel = brand + " " + sid;
      const profile = toProfile({
        meds: [
          {
            id: medId,
            name: productLabel,
            ingredient,
            strength,
            schedule: ["evening"],
            barcode,
            notes: "Session " + sid + " evening dose",
          },
        ],
        allergies: ["peanut"],
        avoid: ["NSAIDs"],
        doseLog: [],
        lang: "en",
      });
      const rawRead = {
        kind: "medication",
        product: { value: productLabel, confidence: 0.98 },
        ingredient: { value: ingredient, confidence: 0.98 },
        strength: { value: strength, confidence: 0.98 },
        dosing: { value: "1 tablet in the evening", confidence: 0.95 },
        expiry: { value: "2027-11", confidence: 0.96 },
        allergens: { value: null, confidence: 0.0 },
        barcode: { value: barcode, confidence: 0.96 },
        readability: 0.97,
      };
      const verdict = checkLabel(toLabelRead(rawRead), profile);
      const h = getOrCreateHub(sid);
      h.profile = profile;
      if (req.mark_latest) {
        markLatest(h);
      }
      h.emit({ type: "coach", cue: "hold_still", text: "Hold steady for " + sid });
      h.emit({ type: "verdict", verdict });
      process.stdout.write(
        JSON.stringify({
          id,
          ok: true,
          result: {
            session: sid,
            level: verdict.level,
            matched_med_id: verdict.matchedMedId ?? null,
          },
        }) + "\\n"
      );
      return;
    }
    if (cmd === "hubs_snapshot") {
      const sessions = Array.isArray(req.sessions) ? req.sessions.map(String) : [];
      const perSession = {};
      let totalBufferedFrames = 0;
      let maxRingLen = 0;
      let minRingLen = sessions.length > 0 ? 999999 : 0;
      let totalLiveClients = 0;
      let totalHudClients = 0;
      for (const sid of sessions) {
        const h = getHub(sid);
        const rLen = h ? h.ring.length : 0;
        const cLen = h ? h.clients.size : 0;
        const hLen = h ? h.huds.size : 0;
        const picked = h ? h.ring.pick(8, 300000) : [];
        totalBufferedFrames += rLen;
        if (rLen > maxRingLen) maxRingLen = rLen;
        if (rLen < minRingLen) minRingLen = rLen;
        totalLiveClients += cLen;
        totalHudClients += hLen;
        perSession[sid] = {
          exists: Boolean(h),
          ring_len: rLen,
          live_clients: cLen,
          hud_clients: hLen,
          has_hud: h ? hasHud(h) : false,
          device_battery: h && h.device ? h.device.battery : null,
          last_verdict_med_id: h && h.lastVerdict ? h.lastVerdict.matchedMedId ?? null : null,
          last_verdict_taken_today: Boolean(h && h.lastVerdict && h.lastVerdict.takenToday),
          dose_log_med_ids: h ? h.profile.doseLog.map((d) => d.medId) : [],
          ring_sharpness_values: picked.map((f) => Math.round(f.sharpness * 1000000) / 1000000),
          ring_bytes_values: picked.map((f) => f.bytes),
        };
      }
      process.stdout.write(
        JSON.stringify({
          id,
          ok: true,
          result: {
            stats: hubStats(),
            total_buffered_frames: totalBufferedFrames,
            max_ring_len: maxRingLen,
            min_ring_len: sessions.length > 0 ? minRingLen : 0,
            total_live_clients: totalLiveClients,
            total_hud_clients: totalHudClients,
            total_websockets: totalLiveClients + totalHudClients,
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
        self.gc_exposed: bool = False
        self._next_id: int = 1
        self._write_lock = asyncio.Lock()
        self._pending: dict[int, asyncio.Future[Any]] = {}
        self._stderr_chunks: list[str] = []
        self._stderr_task: asyncio.Task[None] | None = None
        self._stdout_task: asyncio.Task[None] | None = None

    async def start(self, timeout_s: float = 20.0) -> None:
        self.proc = await asyncio.create_subprocess_exec(
            self.node_bin,
            "--expose-gc",
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
                self.gc_exposed = bool(parsed.get("gc_exposed"))
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


def frame_sharpness_tag(session_idx: int, frame_idx: int) -> float:
    return round(0.15 + session_idx * 0.03 + frame_idx * 0.0005, 6)


async def warmup_server(
    http: aiohttp.ClientSession,
    base_url: str,
    ws_base: str,
    jpeg_bytes: bytes,
    harness: NodeServerHarness,
) -> None:
    live_ws = await http.ws_connect(f"{ws_base}/live?session=warmup_init")
    hud_ws = await http.ws_connect(f"{ws_base}/hud-ws?session=warmup_init")
    _ = await live_ws.receive_json(timeout=3.0)
    for _ in range(3):
        async with http.post(
            f"{base_url}/ingest/frame?session=warmup_init",
            data=jpeg_bytes,
            headers={"Content-Type": "image/jpeg"},
        ) as resp:
            await resp.read()
            if resp.status != 204:
                raise RuntimeError(f"Warmup /ingest/frame returned {resp.status}")
        async with http.post(
            f"{base_url}/ingest/state?session=warmup_init",
            json={"connected": True, "worn": True, "streaming": True, "battery": 88},
        ) as resp:
            await resp.read()
            if resp.status != 204:
                raise RuntimeError(f"Warmup /ingest/state returned {resp.status}")
        _ = await live_ws.receive_json(timeout=3.0)
        _ = await hud_ws.receive_json(timeout=3.0)
    async with http.get(f"{base_url}/api/stats") as resp:
        await resp.read()
    await hud_ws.close()
    await live_ws.close()
    await asyncio.sleep(0.03)
    await harness.call("reset", gc=True)


async def run_benchmark(out_path: pathlib.Path) -> dict[str, Any]:
    if not FIXTURE_PATH.is_file():
        raise FileNotFoundError(f"Missing fixture: {FIXTURE_PATH}")
    jpeg_bytes = FIXTURE_PATH.read_bytes()
    if len(jpeg_bytes) != EXPECTED_FIXTURE_BYTES:
        raise AssertionError(
            f"Expected {EXPECTED_FIXTURE_BYTES} bytes for amlodipine.jpg, got {len(jpeg_bytes)}"
        )

    session_ids = [f"sess_{idx:02d}" for idx in range(N_CONCURRENT_SESSIONS)]
    session_id_set = set(session_ids)

    with tempfile.TemporaryDirectory(prefix="holdup_concurrent_bench_") as tmp_dir:
        ledger_path = pathlib.Path(tmp_dir) / "ledger.jsonl"
        env_map = build_clean_server_env(ledger_path)
        node_bin = resolve_node_bin(env_map)
        harness = NodeServerHarness(node_bin, env_map)
        await harness.start()
        if not harness.gc_exposed:
            await harness.stop()
            raise RuntimeError("Expected Node --expose-gc to provide globalThis.gc")

        base_url = f"http://127.0.0.1:{harness.port}"
        ws_base = f"ws://127.0.0.1:{harness.port}"

        connector = aiohttp.TCPConnector(limit=256, force_close=False)
        timeout = aiohttp.ClientTimeout(total=30.0)

        try:
            async with aiohttp.ClientSession(
                connector=connector,
                timeout=timeout,
                trust_env=False,
            ) as http:
                await warmup_server(http, base_url, ws_base, jpeg_bytes, harness)
                mem_before = await harness.call("memory", gc=True)

                async def open_pair(idx: int) -> tuple[WebSocketRecorder, WebSocketRecorder, float]:
                    sid = session_ids[idx]
                    t0 = time.perf_counter()
                    live_ws = await http.ws_connect(f"{ws_base}/live?session={sid}")
                    live_rec = WebSocketRecorder(live_ws, f"live:{sid}")
                    hud_ws = await http.ws_connect(f"{ws_base}/hud-ws?session={sid}")
                    hud_rec = WebSocketRecorder(hud_ws, f"hud:{sid}")
                    _, hud_attach_msg, _ = await live_rec.wait_for_match(
                        lambda m: m.get("type") == "hud" and m.get("connected") is True
                    )
                    if hud_attach_msg.get("connected") is not True:
                        raise AssertionError(f"Expected initial hud connected message on {sid}")
                    dt_open_ms = round((time.perf_counter() - t0) * 1000.0, 3)
                    return live_rec, hud_rec, dt_open_ms

                opened = await asyncio.gather(*(open_pair(i) for i in range(N_CONCURRENT_SESSIONS)))
                live_recs = [row[0] for row in opened]
                hud_recs = [row[1] for row in opened]
                ws_pair_open_ms = [row[2] for row in opened]

                attached_snap = await harness.call("hubs_snapshot", sessions=session_ids)
                if (
                    attached_snap["total_live_clients"] != N_CONCURRENT_SESSIONS
                    or attached_snap["total_hud_clients"] != N_CONCURRENT_SESSIONS
                    or attached_snap["total_websockets"] != N_CONCURRENT_WEBSOCKETS
                    or attached_snap["stats"]["floatingHuds"] != 0
                ):
                    raise AssertionError(f"Unexpected post-attach socket counts: {attached_snap}")

                start_gate = asyncio.Event()
                observed_ring_lengths: list[int] = []

                async def run_single_session(idx: int) -> dict[str, Any]:
                    sid = session_ids[idx]
                    expected_battery = BATTERY_BASE + idx
                    expected_med_id = f"med_{sid}"
                    med_spec = SESSION_MED_CATALOG[idx % len(SESSION_MED_CATALOG)]
                    barcode = str(6432100000000 + idx)
                    live_rec = live_recs[idx]
                    hud_rec = hud_recs[idx]

                    frame_latencies_ms: list[float] = []
                    mid_ring_lengths: list[int] = []

                    await start_gate.wait()

                    async def blast_ten_frames() -> None:
                        for f_idx in range(FRAMES_PER_SESSION):
                            if f_idx == 0:
                                url = f"{base_url}/ingest/frame?session={sid}"
                            else:
                                sharp = frame_sharpness_tag(idx, f_idx)
                                url = f"{base_url}/ingest/frame?session={sid}&sharpness={sharp:.6f}"
                            t0 = time.perf_counter()
                            async with http.post(
                                url,
                                data=jpeg_bytes,
                                headers={"Content-Type": "image/jpeg"},
                            ) as resp:
                                await resp.read()
                                dt_ms = (time.perf_counter() - t0) * 1000.0
                                if resp.status != 204:
                                    raise RuntimeError(
                                        f"POST /ingest/frame on {sid} frame {f_idx} returned {resp.status}"
                                    )
                            frame_latencies_ms.append(round(dt_ms, 3))
                            if f_idx in (4, 7, 9):
                                r_info = await harness.call("ring_len", session=sid)
                                r_len = int(r_info["ring_len"])
                                mid_ring_lengths.append(r_len)
                                observed_ring_lengths.append(r_len)

                    async def blast_state_and_verdict_events() -> dict[str, float]:
                        state_payload = {
                            "connected": True,
                            "worn": True,
                            "streaming": True,
                            "battery": expected_battery,
                        }
                        t_state = time.perf_counter()

                        async def post_state() -> float:
                            async with http.post(
                                f"{base_url}/ingest/state?session={sid}",
                                json=state_payload,
                            ) as resp:
                                await resp.read()
                                if resp.status != 204:
                                    raise RuntimeError(
                                        f"POST /ingest/state on {sid} returned {resp.status}"
                                    )
                                return (time.perf_counter() - t_state) * 1000.0

                        dt_state_http, (t_hud_dev, _, _), (t_live_dev, _, _) = await asyncio.gather(
                            post_state(),
                            hud_rec.wait_for_match(lambda m: m.get("type") == "device"),
                            live_rec.wait_for_match(lambda m: m.get("type") == "device"),
                        )
                        state_fanout_ms = round(
                            max(
                                dt_state_http,
                                (t_hud_dev - t_state) * 1000.0,
                                (t_live_dev - t_state) * 1000.0,
                            ),
                            3,
                        )
                        state_hud_leg_ms = round((t_hud_dev - t_state) * 1000.0, 3)

                        t_emit = time.perf_counter()
                        await harness.call(
                            "seed_and_emit_session",
                            session=sid,
                            med_id=expected_med_id,
                            brand=med_spec["brand"],
                            ingredient=med_spec["ingredient"],
                            strength=med_spec["strength"],
                            barcode=barcode,
                            mark_latest=(idx in (0, 12, 24)),
                        )
                        (_, _, _), (t_hud_v1, _, _), (t_live_v1, _, _) = await asyncio.gather(
                            hud_rec.wait_for_match(lambda m: m.get("type") == "coach"),
                            hud_rec.wait_for_match(
                                lambda m: m.get("type") == "verdict"
                                and not bool((m.get("verdict") or {}).get("takenToday"))
                            ),
                            live_rec.wait_for_match(
                                lambda m: m.get("type") == "verdict"
                                and not bool((m.get("verdict") or {}).get("takenToday"))
                            ),
                        )
                        verdict_fanout_ms = round(
                            max((t_hud_v1 - t_emit) * 1000.0, (t_live_v1 - t_emit) * 1000.0),
                            3,
                        )

                        t_evt = time.perf_counter()
                        await hud_rec.ws.send_str(json.dumps({"type": "event", "name": "log_dose"}))
                        (t_hud_v2, _, _), (t_live_v2, _, _) = await asyncio.gather(
                            hud_rec.wait_for_match(
                                lambda m: m.get("type") == "verdict"
                                and bool((m.get("verdict") or {}).get("takenToday"))
                            ),
                            live_rec.wait_for_match(
                                lambda m: m.get("type") == "verdict"
                                and bool((m.get("verdict") or {}).get("takenToday"))
                            ),
                        )
                        hud_event_roundtrip_ms = round(
                            max((t_hud_v2 - t_evt) * 1000.0, (t_live_v2 - t_evt) * 1000.0),
                            3,
                        )

                        return {
                            "state_fanout_ms": state_fanout_ms,
                            "state_hud_leg_ms": state_hud_leg_ms,
                            "verdict_fanout_ms": verdict_fanout_ms,
                            "hud_event_roundtrip_ms": hud_event_roundtrip_ms,
                        }

                    _, fanout_timings = await asyncio.gather(
                        blast_ten_frames(),
                        blast_state_and_verdict_events(),
                    )
                    return {
                        "session_id": sid,
                        "session_index": idx,
                        "expected_battery": expected_battery,
                        "expected_med_id": expected_med_id,
                        "frame_latencies_ms": frame_latencies_ms,
                        "mid_ring_lengths": mid_ring_lengths,
                        **fanout_timings,
                    }

                session_tasks = [
                    asyncio.create_task(run_single_session(i)) for i in range(N_CONCURRENT_SESSIONS)
                ]
                await asyncio.sleep(0.01)
                t_blast_start = time.perf_counter()
                start_gate.set()
                raw_session_runs = await asyncio.gather(*session_tasks)
                blast_wall_ms = round((time.perf_counter() - t_blast_start) * 1000.0, 3)

                await asyncio.sleep(0.05)

                mem_peak = await harness.call("memory", gc=False)
                mem_peak_live_retained = await harness.call("memory", gc=True)
                peak_snap = await harness.call("hubs_snapshot", sessions=session_ids)
                for sid in session_ids:
                    observed_ring_lengths.append(int(peak_snap["per_session"][sid]["ring_len"]))

                t_disc_start = time.perf_counter()
                await asyncio.gather(*(rec.finish() for rec in live_recs))

                post_disc_snap: dict[str, Any] = {}
                for _ in range(40):
                    post_disc_snap = await harness.call("hubs_snapshot", sessions=session_ids)
                    if (
                        int(post_disc_snap["total_live_clients"]) == 0
                        and int(post_disc_snap["total_buffered_frames"]) == 0
                    ):
                        break
                    await asyncio.sleep(0.005)
                disconnect_wipe_ms = round((time.perf_counter() - t_disc_start) * 1000.0, 3)

                mem_after_live_close_pre_gc = await harness.call("memory", gc=False)
                await asyncio.gather(*(rec.finish() for rec in hud_recs))
                await asyncio.sleep(0.02)
                mem_after_close = await harness.call("memory", gc=True)

                async with http.get(f"{base_url}/api/stats") as resp:
                    stats_raw = await resp.read()
                    if resp.status != 200:
                        raise RuntimeError(f"GET /api/stats returned {resp.status}")
                    ledger_stats = json.loads(stats_raw.decode("utf-8"))
                gemini_calls = int(ledger_stats.get("total", -1))
                if gemini_calls != 0:
                    raise AssertionError(f"Expected 0 Gemini API calls, observed {gemini_calls}")
        finally:
            await harness.stop()

    all_ingest_ms: list[float] = []
    all_state_fanout_ms: list[float] = []
    all_verdict_fanout_ms: list[float] = []
    all_hud_event_ms: list[float] = []
    all_combined_fanout_ms: list[float] = []

    cross_session_leak_count = 0
    isolated_sessions = 0
    per_session_reports: list[dict[str, Any]] = []

    for idx, run_info in enumerate(raw_session_runs):
        sid = session_ids[idx]
        other_sids = session_id_set - {sid}
        expected_battery = BATTERY_BASE + idx
        expected_med_id = f"med_{sid}"
        expected_retained_sharpness = {
            frame_sharpness_tag(idx, f_idx) for f_idx in range(2, FRAMES_PER_SESSION)
        }

        all_ingest_ms.extend(run_info["frame_latencies_ms"])
        all_state_fanout_ms.append(run_info["state_fanout_ms"])
        all_verdict_fanout_ms.append(run_info["verdict_fanout_ms"])
        all_hud_event_ms.append(run_info["hud_event_roundtrip_ms"])
        all_combined_fanout_ms.extend(
            [
                run_info["state_fanout_ms"],
                run_info["verdict_fanout_ms"],
                run_info["hud_event_roundtrip_ms"],
            ]
        )

        session_leaks = 0
        hud_msgs = [entry[1] for entry in hud_recs[idx].messages]
        live_msgs = [entry[1] for entry in live_recs[idx].messages]

        hud_batteries: list[Any] = []
        hud_med_ids: list[Any] = []
        hud_types = [str(m.get("type") or "") for m in hud_msgs]

        if len(hud_msgs) != 4 or sorted(hud_types) != ["coach", "device", "verdict", "verdict"]:
            session_leaks += 1

        for m in hud_msgs:
            serialized = json.dumps(m)
            for foreign_sid in other_sids:
                if foreign_sid in serialized:
                    session_leaks += 1
            mtype = m.get("type")
            if mtype == "device":
                bat = (m.get("device") or {}).get("battery")
                hud_batteries.append(bat)
                if bat != expected_battery:
                    session_leaks += 1
            elif mtype == "coach":
                if sid not in str(m.get("text") or ""):
                    session_leaks += 1
            elif mtype == "verdict":
                v = m.get("verdict") or {}
                med_id = v.get("matchedMedId")
                hud_med_ids.append(med_id)
                if med_id != expected_med_id:
                    session_leaks += 1
                prod_val = str(((v.get("read") or {}).get("product") or {}).get("value") or "")
                if sid not in prod_val:
                    session_leaks += 1
            else:
                session_leaks += 1

        for m in live_msgs:
            serialized = json.dumps(m)
            for foreign_sid in other_sids:
                if foreign_sid in serialized:
                    session_leaks += 1
            mtype = m.get("type")
            if mtype == "device":
                if (m.get("device") or {}).get("battery") != expected_battery:
                    session_leaks += 1
            elif mtype == "coach":
                if sid not in str(m.get("text") or ""):
                    session_leaks += 1
            elif mtype == "verdict":
                if (m.get("verdict") or {}).get("matchedMedId") != expected_med_id:
                    session_leaks += 1
            elif mtype != "hud":
                session_leaks += 1

        peak_hub = peak_snap["per_session"][sid]
        post_hub = post_disc_snap["per_session"][sid]

        if peak_hub["device_battery"] != expected_battery:
            session_leaks += 1
        if peak_hub["dose_log_med_ids"] != [expected_med_id]:
            session_leaks += 1
        if set(peak_hub["ring_sharpness_values"]) != expected_retained_sharpness:
            session_leaks += 1

        cross_session_leak_count += session_leaks
        if session_leaks == 0:
            isolated_sessions += 1

        per_session_reports.append(
            {
                "session_id": sid,
                "expected_battery": expected_battery,
                "observed_hud_batteries": hud_batteries,
                "expected_med_id": expected_med_id,
                "observed_hud_verdict_med_ids": hud_med_ids,
                "dose_log_med_ids": peak_hub["dose_log_med_ids"],
                "frames_ingested": len(run_info["frame_latencies_ms"]),
                "mid_blast_ring_lengths": run_info["mid_ring_lengths"],
                "peak_ring_len": int(peak_hub["ring_len"]),
                "post_disconnect_ring_len": int(post_hub["ring_len"]),
                "hud_messages_count": len(hud_msgs),
                "live_messages_count": len(live_msgs),
                "ingest_p50_ms": percentile(run_info["frame_latencies_ms"], 0.50, 3),
                "ingest_p95_ms": percentile(run_info["frame_latencies_ms"], 0.95, 3),
                "state_fanout_ms": run_info["state_fanout_ms"],
                "verdict_fanout_ms": run_info["verdict_fanout_ms"],
                "hud_event_roundtrip_ms": run_info["hud_event_roundtrip_ms"],
                "cross_session_leaks": session_leaks,
                "isolated": session_leaks == 0,
            }
        )

    max_ring_len_observed = max(observed_ring_lengths) if observed_ring_lengths else 0
    post_disconnect_buffered_frames = int(post_disc_snap["total_buffered_frames"])
    isolation_pass_rate = round(isolated_sessions / float(N_CONCURRENT_SESSIONS), 4)

    if len(all_ingest_ms) != TOTAL_FRAMES_INGESTED:
        raise AssertionError(
            f"Expected {TOTAL_FRAMES_INGESTED} frame ingests, got {len(all_ingest_ms)}"
        )
    if cross_session_leak_count != 0 or isolation_pass_rate != 1.0:
        raise AssertionError(
            f"Cross-session isolation violated: leaks={cross_session_leak_count}, pass_rate={isolation_pass_rate}"
        )
    if max_ring_len_observed != RING_CAPACITY or any(x > RING_CAPACITY for x in observed_ring_lengths):
        raise AssertionError(
            f"FrameRing bound violated across 25 sessions: max_ring_len_observed={max_ring_len_observed}"
        )
    if int(peak_snap["total_buffered_frames"]) != N_CONCURRENT_SESSIONS * RING_CAPACITY:
        raise AssertionError(
            f"Expected {N_CONCURRENT_SESSIONS * RING_CAPACITY} buffered frames at peak, got {peak_snap['total_buffered_frames']}"
        )
    if post_disconnect_buffered_frames != 0:
        raise AssertionError(
            f"Expected 0 buffered frames after /live disconnect, got {post_disconnect_buffered_frames}"
        )
    if not (mem_peak["heap_used_bytes"] > mem_before["heap_used_bytes"]):
        raise AssertionError(
            f"Expected peak heap ({mem_peak['heap_mb']} MB) > baseline heap ({mem_before['heap_mb']} MB)"
        )
    if not (mem_after_close["heap_used_bytes"] < mem_peak["heap_used_bytes"]):
        raise AssertionError(
            f"Expected post-close GC heap ({mem_after_close['heap_mb']} MB) < peak heap ({mem_peak['heap_mb']} MB)"
        )

    ingest_latency = summarize_latencies(all_ingest_ms)
    fanout_latency = summarize_latencies(all_combined_fanout_ms)
    state_fanout_latency = summarize_latencies(all_state_fanout_ms)
    verdict_fanout_latency = summarize_latencies(all_verdict_fanout_ms)
    hud_event_latency = summarize_latencies(all_hud_event_ms)

    summary: dict[str, Any] = {
        "n_concurrent_sessions": N_CONCURRENT_SESSIONS,
        "n_concurrent_websockets": N_CONCURRENT_WEBSOCKETS,
        "total_frames_ingested": len(all_ingest_ms),
        "cross_session_leak_count": cross_session_leak_count,
        "isolation_pass_rate": isolation_pass_rate,
        "max_ring_len_observed": max_ring_len_observed,
        "post_disconnect_buffered_frames": post_disconnect_buffered_frames,
        "concurrent_ingest_p50_ms": ingest_latency["p50"],
        "concurrent_ingest_p95_ms": ingest_latency["p95"],
        "concurrent_fanout_p50_ms": fanout_latency["p50"],
        "concurrent_fanout_p95_ms": fanout_latency["p95"],
        "heap_mb_before": mem_before["heap_mb"],
        "heap_mb_peak": mem_peak["heap_mb"],
        "heap_mb_after_close": mem_after_close["heap_mb"],
        "gemini_api_calls": 0,
    }

    report = sanitize_obj(
        {
            "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "generated_by": "eval/eval_concurrent_sessions.py",
            "node_version": harness.node_version,
            "python_version": platform.python_version(),
            "transport": "tcp_loopback_127_0_0_1",
            "server_entrypoint": "startServer(0)",
            "gemini_api_calls": 0,
            "summary": summary,
            "concurrency_and_isolation": {
                "sessions_opened": N_CONCURRENT_SESSIONS,
                "live_websockets_opened": int(attached_snap["total_live_clients"]),
                "hud_websockets_opened": int(attached_snap["total_hud_clients"]),
                "total_websockets_opened": int(attached_snap["total_websockets"]),
                "floating_huds_count": int(attached_snap["stats"]["floatingHuds"]),
                "frames_per_session": FRAMES_PER_SESSION,
                "total_frames_ingested": len(all_ingest_ms),
                "fixture_path": "web/public/fixtures/amlodipine.jpg",
                "fixture_bytes": len(jpeg_bytes),
                "blast_wall_clock_ms": blast_wall_ms,
                "ws_pair_attach_latency_ms": summarize_latencies(ws_pair_open_ms),
                "concurrent_ingest_latency_ms": ingest_latency,
                "concurrent_fanout_combined_latency_ms": fanout_latency,
                "concurrent_state_fanout_latency_ms": state_fanout_latency,
                "concurrent_verdict_fanout_latency_ms": verdict_fanout_latency,
                "concurrent_hud_log_dose_roundtrip_ms": hud_event_latency,
                "cross_session_leak_count": cross_session_leak_count,
                "isolated_sessions": isolated_sessions,
                "isolation_pass_rate": isolation_pass_rate,
            },
            "frame_ring_and_disconnect_wipe": {
                "ring_capacity": RING_CAPACITY,
                "n_ring_length_probes": len(observed_ring_lengths),
                "max_ring_len_across_all_25": max_ring_len_observed,
                "peak_min_ring_len_across_all_25": int(peak_snap["min_ring_len"]),
                "peak_total_buffered_frames": int(peak_snap["total_buffered_frames"]),
                "frames_evicted_by_ring_bound": TOTAL_FRAMES_INGESTED - int(peak_snap["total_buffered_frames"]),
                "post_disconnect_total_buffered_frames": post_disconnect_buffered_frames,
                "post_disconnect_live_clients": int(post_disc_snap["total_live_clients"]),
                "disconnect_wipe_verified_in_ms": disconnect_wipe_ms,
                "all_25_rings_cleared_immediately": post_disconnect_buffered_frames == 0,
            },
            "memory_profile": {
                "before_sessions_gc": mem_before,
                "peak_25_sessions_200_frames": mem_peak,
                "peak_25_sessions_200_frames_live_retained": mem_peak_live_retained,
                "after_live_disconnect_pre_gc": mem_after_live_close_pre_gc,
                "after_all_close_and_gc": mem_after_close,
                "peak_delta_over_before_mb": round(mem_peak["heap_mb"] - mem_before["heap_mb"], 3),
                "reclaimed_from_peak_mb": round(mem_peak["heap_mb"] - mem_after_close["heap_mb"], 3),
            },
            "sessions": per_session_reports,
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
        description="25-session concurrent multi-user isolation, FrameRing bound, and disconnect memory wipe benchmark"
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
