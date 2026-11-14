import argparse
import asyncio
import datetime
import gzip
import json
import math
import os
import pathlib
import platform
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from typing import Any

import aiohttp

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
DEFAULT_OUT_PATH = REPO_ROOT / "eval" / "production_footprint.json"

N_COLD_BOOTS = 5
N_CONCURRENT_REQUESTS = 200
MAX_RAW_JS_CHUNK_BYTES = 500_000
MAX_TOTAL_GZIP_JS_CSS_BYTES = 250_000

EM_DASH = chr(8212)
EN_DASH = chr(8211)
COMMENT_CHAR = chr(35)
HEX_BLACK = COMMENT_CHAR + "000000"

BURST_ROUTES: tuple[str, ...] = (
    "/",
    "/hud",
    "/deck/",
    "/api/health",
    "/api/stats",
    "/api/eval-summary",
    "/.well-known/meta-wearables-manifest.json",
)

DECK_ASSET_REL_PATHS: tuple[str, ...] = (
    "deck/index.html",
    "deck/deck.css",
    "deck/deck.js",
)

PRINTABLE_HTML_REL_PATHS: tuple[str, ...] = (
    "docs/printable-props.html",
    "docs/judge-handout.html",
    "docs/architecture-poster.html",
)

PWA_SHELL_REL_PATHS: tuple[str, ...] = (
    "web/dist/sw.js",
    "web/dist/manifest.webmanifest",
    "web/dist/.well-known/meta-wearables-manifest.json",
    "web/dist/icon.svg",
)

COLD_START_BOOT_TS = """
import { env } from "./server/src/env.ts";
import { startServer } from "./server/src/index.ts";

process.env.HOLDUP_QUIET = "1";
env.apiKey = "";

const srv = await startServer(0);
const addr = srv.address();
const port = typeof addr === "object" && addr ? addr.port : 0;
process.stdout.write("LISTEN:" + String(port) + "\\n");

process.stdin.resume();
process.stdin.once("data", () => {
  srv.closeAllConnections();
  srv.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 250).unref();
});
"""

BURST_SERVER_HARNESS_TS = """
import readline from "node:readline";
import { env } from "./server/src/env.ts";
import { startServer } from "./server/src/index.ts";
import { hubStats, resetHubsForTest } from "./server/src/hub.ts";

process.env.HOLDUP_QUIET = "1";
env.apiKey = "";

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
    if (cmd === "inspect") {
      process.stdout.write(
        JSON.stringify({
          id,
          ok: true,
          result: {
            stats: hubStats(),
            unhandled_errors: unhandledErrors,
            rss_bytes: process.memoryUsage().rss,
            heap_used_bytes: process.memoryUsage().heapUsed,
          },
        }) + "\\n"
      );
      return;
    }
    if (cmd === "reset") {
      resetHubsForTest();
      process.stdout.write(
        JSON.stringify({ id, ok: true, result: { stats: hubStats(), unhandled_errors: unhandledErrors } }) + "\\n"
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


def resolve_npm_bin(env_map: dict[str, str]) -> str:
    npm_bin = shutil.which("npm", path=env_map.get("PATH"))
    if not npm_bin and pathlib.Path("/tmp/fleet-silas/node/bin/npm").is_file():
        npm_bin = "/tmp/fleet-silas/node/bin/npm"
    if not npm_bin:
        raise RuntimeError("npm binary not found")
    return npm_bin


def ensure_production_dist(env_map: dict[str, str]) -> bool:
    dist_index = REPO_ROOT / "web" / "dist" / "index.html"
    dist_assets = REPO_ROOT / "web" / "dist" / "assets"
    has_js = dist_assets.is_dir() and any(dist_assets.glob("*.js"))
    if dist_index.is_file() and has_js:
        return False
    npm_bin = resolve_npm_bin(env_map)
    subprocess.run(
        [npm_bin, "run", "build"],
        cwd=str(REPO_ROOT),
        env=env_map,
        check=True,
    )
    if not dist_index.is_file():
        raise RuntimeError("Expected web/dist/index.html after npm run build")
    return True


def gzip9_bytes_len(raw_bytes: bytes) -> int:
    return len(gzip.compress(raw_bytes, compresslevel=9, mtime=0))


def describe_asset(rel_posix: str, role: str | None = None) -> dict[str, Any]:
    full_path = REPO_ROOT / rel_posix
    if not full_path.is_file():
        raise FileNotFoundError(f"Expected production asset missing: {rel_posix}")
    raw = full_path.read_bytes()
    raw_len = len(raw)
    gz_len = gzip9_bytes_len(raw)
    savings_pct = round((1.0 - (gz_len / float(raw_len))) * 100.0, 2) if raw_len > 0 else 0.0
    entry: dict[str, Any] = {
        "path": rel_posix,
        "raw_bytes": raw_len,
        "gzip_bytes": gz_len,
        "raw_kb": round(raw_len / 1000.0, 3),
        "gzip_kb": round(gz_len / 1000.0, 3),
        "gzip_savings_pct": savings_pct,
    }
    if role is not None:
        entry["role"] = role
    return entry


def measure_production_bundle_assets() -> dict[str, Any]:
    index_entry = describe_asset("web/dist/index.html", role="spa_and_hud_entry_html")

    assets_dir = REPO_ROOT / "web" / "dist" / "assets"
    if not assets_dir.is_dir():
        raise FileNotFoundError("Missing web/dist/assets directory")

    js_paths = sorted(assets_dir.glob("*.js"), key=lambda p: p.name)
    css_paths = sorted(assets_dir.glob("*.css"), key=lambda p: p.name)
    if not js_paths:
        raise AssertionError("Expected at least one JS chunk in web/dist/assets")
    if not css_paths:
        raise AssertionError("Expected at least one CSS chunk in web/dist/assets")

    js_entries: list[dict[str, Any]] = []
    for jp in js_paths:
        rel_p = jp.relative_to(REPO_ROOT).as_posix()
        role = "vendor_js" if jp.name.startswith("vendor-") else "app_js"
        item = describe_asset(rel_p, role=role)
        item["under_500kb_raw_budget"] = item["raw_bytes"] < MAX_RAW_JS_CHUNK_BYTES
        js_entries.append(item)

    css_entries: list[dict[str, Any]] = []
    hud_css_raw = 0
    hud_css_gzip = 0
    for cp in css_paths:
        rel_p = cp.relative_to(REPO_ROOT).as_posix()
        is_hud = cp.name.startswith("hud-")
        role = "hud_waveguide_css" if is_hud else "app_css"
        item = describe_asset(rel_p, role=role)
        if is_hud:
            hud_css_raw = item["raw_bytes"]
            hud_css_gzip = item["gzip_bytes"]
        css_entries.append(item)

    max_raw_js_bytes = max(item["raw_bytes"] for item in js_entries)
    all_js_under_budget = all(item["raw_bytes"] < MAX_RAW_JS_CHUNK_BYTES for item in js_entries)
    if not all_js_under_budget:
        raise AssertionError(
            f"Raw JS chunk exceeded {MAX_RAW_JS_CHUNK_BYTES} byte budget: max={max_raw_js_bytes}"
        )

    total_raw_js = sum(item["raw_bytes"] for item in js_entries)
    total_gzip_js = sum(item["gzip_bytes"] for item in js_entries)
    total_raw_css = sum(item["raw_bytes"] for item in css_entries)
    total_gzip_css = sum(item["gzip_bytes"] for item in css_entries)
    total_raw_js_css = total_raw_js + total_raw_css
    total_gzip_js_css = total_gzip_js + total_gzip_css
    gzip_under_budget = total_gzip_js_css < MAX_TOTAL_GZIP_JS_CSS_BYTES
    if not gzip_under_budget:
        raise AssertionError(
            f"Total gzipped JS+CSS {total_gzip_js_css} exceeded {MAX_TOTAL_GZIP_JS_CSS_BYTES} byte budget"
        )

    pwa_shell_entries = [describe_asset(rel_p) for rel_p in PWA_SHELL_REL_PATHS]
    deck_entries = [describe_asset(rel_p) for rel_p in DECK_ASSET_REL_PATHS]
    printable_entries = [describe_asset(rel_p) for rel_p in PRINTABLE_HTML_REL_PATHS]

    deck_total_raw = sum(x["raw_bytes"] for x in deck_entries)
    deck_total_gzip = sum(x["gzip_bytes"] for x in deck_entries)
    printable_total_raw = sum(x["raw_bytes"] for x in printable_entries)
    printable_total_gzip = sum(x["gzip_bytes"] for x in printable_entries)

    return {
        "budgets": {
            "max_raw_js_chunk_budget_bytes": MAX_RAW_JS_CHUNK_BYTES,
            "observed_max_raw_js_chunk_bytes": max_raw_js_bytes,
            "all_raw_js_chunks_under_500kb": all_js_under_budget,
            "max_total_gzip_js_css_budget_bytes": MAX_TOTAL_GZIP_JS_CSS_BYTES,
            "observed_total_gzip_js_css_bytes": total_gzip_js_css,
            "total_gzip_js_css_under_250kb": gzip_under_budget,
        },
        "web_dist_index_html": index_entry,
        "web_dist_js_chunks": js_entries,
        "web_dist_css_chunks": css_entries,
        "web_dist_totals": {
            "js_chunk_count": len(js_entries),
            "css_chunk_count": len(css_entries),
            "hud_waveguide_css_raw_bytes": hud_css_raw,
            "hud_waveguide_css_gzip_bytes": hud_css_gzip,
            "total_raw_js_bytes": total_raw_js,
            "total_gzip_js_bytes": total_gzip_js,
            "total_raw_css_bytes": total_raw_css,
            "total_gzip_css_bytes": total_gzip_css,
            "total_raw_js_css_bytes": total_raw_js_css,
            "total_gzip_js_css_bytes": total_gzip_js_css,
            "total_raw_js_css_kb": round(total_raw_js_css / 1000.0, 3),
            "total_gzip_js_css_kb": round(total_gzip_js_css / 1000.0, 3),
            "total_raw_index_plus_js_css_bytes": index_entry["raw_bytes"] + total_raw_js_css,
            "total_gzip_index_plus_js_css_bytes": index_entry["gzip_bytes"] + total_gzip_js_css,
        },
        "pwa_and_wearables_shell": pwa_shell_entries,
        "deck_assets": {
            "files": deck_entries,
            "total_raw_bytes": deck_total_raw,
            "total_gzip_bytes": deck_total_gzip,
            "total_raw_kb": round(deck_total_raw / 1000.0, 3),
            "total_gzip_kb": round(deck_total_gzip / 1000.0, 3),
        },
        "printable_html_sheets": {
            "files": printable_entries,
            "total_raw_bytes": printable_total_raw,
            "total_gzip_bytes": printable_total_gzip,
            "total_raw_kb": round(printable_total_raw / 1000.0, 3),
            "total_gzip_kb": round(printable_total_gzip / 1000.0, 3),
        },
    }


async def measure_single_cold_boot(
    boot_idx: int,
    node_bin: str,
    env_map: dict[str, str],
) -> dict[str, Any]:
    stderr_lines: list[str] = []
    t_spawn = time.perf_counter()
    proc = await asyncio.create_subprocess_exec(
        node_bin,
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        COLD_START_BOOT_TS,
        cwd=str(REPO_ROOT),
        env=env_map,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    assert proc.stdout is not None
    assert proc.stderr is not None
    assert proc.stdin is not None

    async def drain_err() -> None:
        assert proc.stderr is not None
        while True:
            ln = await proc.stderr.readline()
            if not ln:
                break
            stderr_lines.append(ln.decode("utf-8", errors="replace").rstrip("\n"))

    err_task = asyncio.create_task(drain_err())
    port = 0
    t_listen = t_spawn
    health_status = 0
    health_ok = False
    t_health_done = t_spawn

    try:
        deadline = time.monotonic() + 20.0
        while time.monotonic() < deadline:
            remaining = max(0.1, deadline - time.monotonic())
            raw_line = await asyncio.wait_for(proc.stdout.readline(), timeout=remaining)
            if not raw_line:
                break
            txt = raw_line.decode("utf-8", errors="replace").strip()
            if txt.startswith("LISTEN:"):
                t_listen = time.perf_counter()
                port = int(txt.split(":", 1)[1].strip())
                break

        if port <= 0:
            tail = "\n".join(stderr_lines[-20:])
            raise RuntimeError(f"Cold boot {boot_idx} failed to emit LISTEN:<port>. stderr:\n{tail}")

        connector = aiohttp.TCPConnector(limit=4, force_close=True)
        timeout = aiohttp.ClientTimeout(total=10.0)
        async with aiohttp.ClientSession(
            connector=connector,
            timeout=timeout,
            trust_env=False,
        ) as http:
            async with http.get(f"http://127.0.0.1:{port}/api/health") as resp:
                body = await resp.read()
                t_health_done = time.perf_counter()
                health_status = resp.status
                parsed = json.loads(body.decode("utf-8"))
                health_ok = bool(parsed.get("ok") is True)

        if health_status != 200 or not health_ok:
            raise AssertionError(
                f"Cold boot {boot_idx} GET /api/health returned status={health_status}, ok={health_ok}"
            )
    finally:
        if proc.returncode is None:
            try:
                proc.stdin.write(b"stop\n")
                await proc.stdin.drain()
            except Exception:
                pass
            try:
                await asyncio.wait_for(proc.wait(), timeout=3.0)
            except asyncio.TimeoutError:
                proc.terminate()
                try:
                    await asyncio.wait_for(proc.wait(), timeout=2.0)
                except asyncio.TimeoutError:
                    proc.kill()
                    await proc.wait()
        err_task.cancel()
        try:
            await err_task
        except asyncio.CancelledError:
            pass

    exit_code = int(proc.returncode if proc.returncode is not None else -1)
    if exit_code != 0:
        raise AssertionError(f"Cold boot {boot_idx} exited with non-zero code {exit_code}")

    spawn_to_listen_ms = round((t_listen - t_spawn) * 1000.0, 3)
    first_health_ms = round((t_health_done - t_listen) * 1000.0, 3)
    total_cold_ms = round((t_health_done - t_spawn) * 1000.0, 3)

    return {
        "boot_index": boot_idx,
        "port": port,
        "spawn_to_listen_ms": spawn_to_listen_ms,
        "first_health_200_ms": first_health_ms,
        "total_cold_start_ms": total_cold_ms,
        "health_http_status": health_status,
        "exit_code": exit_code,
    }


async def bench_cold_starts(node_bin: str, env_map: dict[str, str]) -> dict[str, Any]:
    boots: list[dict[str, Any]] = []
    for idx in range(1, N_COLD_BOOTS + 1):
        row = await measure_single_cold_boot(idx, node_bin, env_map)
        boots.append(row)

    totals_ms = [row["total_cold_start_ms"] for row in boots]
    listen_ms = [row["spawn_to_listen_ms"] for row in boots]
    health_ms = [row["first_health_200_ms"] for row in boots]

    return {
        "n_cold_boots": N_COLD_BOOTS,
        "cold_starts_ms": totals_ms,
        "total_cold_start_latency_ms": summarize_latencies(totals_ms),
        "spawn_to_listen_latency_ms": summarize_latencies(listen_ms),
        "first_health_200_latency_ms": summarize_latencies(health_ms),
        "all_5_boots_succeeded": len(boots) == N_COLD_BOOTS,
        "boots": boots,
    }


class BurstServerHarness:
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
            BURST_SERVER_HARNESS_TS,
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
            raise RuntimeError(f"Failed to boot burst server via startServer(0). stderr:\n{tail}")

        async def demux_stdout() -> None:
            assert self.proc is not None and self.proc.stdout is not None
            while True:
                raw = await self.proc.stdout.readline()
                if not raw:
                    for fut in list(self._pending.values()):
                        if not fut.done():
                            fut.set_exception(RuntimeError("Burst harness stdout closed unexpectedly"))
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
            raise RuntimeError("Burst server harness is not running")
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


async def bench_concurrent_single_origin_burst(
    node_bin: str,
    env_map: dict[str, str],
) -> dict[str, Any]:
    expected_index_len = len((REPO_ROOT / "web" / "dist" / "index.html").read_bytes())
    expected_deck_len = len((REPO_ROOT / "deck" / "index.html").read_bytes())

    harness = BurstServerHarness(node_bin, env_map)
    await harness.start()
    base_url = f"http://127.0.0.1:{harness.port}"

    connector = aiohttp.TCPConnector(limit=256, force_close=False)
    timeout = aiohttp.ClientTimeout(total=30.0)

    try:
        async with aiohttp.ClientSession(
            connector=connector,
            timeout=timeout,
            trust_env=False,
        ) as http:
            for warm_route in BURST_ROUTES:
                async with http.get(f"{base_url}{warm_route}") as resp:
                    await resp.read()
                    if resp.status != 200:
                        raise RuntimeError(f"Warmup GET {warm_route} returned {resp.status}")

            start_gate = asyncio.Event()

            async def fire_one(req_idx: int) -> dict[str, Any]:
                route = BURST_ROUTES[req_idx % len(BURST_ROUTES)]
                await start_gate.wait()
                t0 = time.perf_counter()
                async with http.get(f"{base_url}{route}") as resp:
                    raw = await resp.read()
                    dt_ms = round((time.perf_counter() - t0) * 1000.0, 3)
                    status = resp.status
                    powered_by = resp.headers.get("x-powered-by")
                    cache_ctl = resp.headers.get("cache-control") or ""
                    ctype = resp.headers.get("content-type") or ""

                payload_valid = status == 200 and powered_by is None
                wrong_dose_val = 0
                false_safe_val = 0

                if payload_valid:
                    if route in ("/", "/hud"):
                        payload_valid = ("text/html" in ctype.lower()) and (len(raw) == expected_index_len)
                    elif route == "/deck/":
                        payload_valid = ("text/html" in ctype.lower()) and (len(raw) == expected_deck_len)
                    elif route == "/api/health":
                        parsed = json.loads(raw.decode("utf-8"))
                        payload_valid = ("no-store" in cache_ctl.lower()) and (parsed.get("ok") is True)
                    elif route == "/api/stats":
                        parsed = json.loads(raw.decode("utf-8"))
                        payload_valid = ("no-store" in cache_ctl.lower()) and (int(parsed.get("total", -1)) == 0)
                    elif route == "/api/eval-summary":
                        parsed = json.loads(raw.decode("utf-8"))
                        s_obj = parsed.get("summary") or {}
                        hm = s_obj.get("headline_metrics") or {}
                        wrong_dose_val = int(s_obj.get("total_confident_wrong_dose_count", -1))
                        false_safe_val = int(s_obj.get("total_false_safe_allergen_count", -1))
                        payload_valid = (
                            ("no-store" in cache_ctl.lower())
                            and (parsed.get("ok") is True)
                            and (wrong_dose_val == 0)
                            and (false_safe_val == 0)
                            and (hm.get("never_guess_strength_min_conf") == 0.8)
                        )
                    elif route == "/.well-known/meta-wearables-manifest.json":
                        parsed = json.loads(raw.decode("utf-8"))
                        payload_valid = (
                            parsed.get("name") == "HoldUp"
                            and parsed.get("start_url") == "/hud"
                            and parsed.get("display") == "standalone"
                            and parsed.get("background_color") == HEX_BLACK
                        )

                return {
                    "req_idx": req_idx,
                    "route": route,
                    "status": status,
                    "payload_valid": payload_valid,
                    "wire_bytes": len(raw),
                    "latency_ms": dt_ms,
                    "wrong_dose_val": wrong_dose_val,
                    "false_safe_val": false_safe_val,
                }

            tasks = [asyncio.create_task(fire_one(i)) for i in range(N_CONCURRENT_REQUESTS)]
            await asyncio.sleep(0.01)
            t_burst = time.perf_counter()
            start_gate.set()
            results = await asyncio.gather(*tasks)
            burst_wall_ms = round((time.perf_counter() - t_burst) * 1000.0, 3)

            post_inspect = await harness.call("inspect")
            async with http.get(f"{base_url}/api/stats") as resp:
                stats_body = await resp.read()
                if resp.status != 200:
                    raise RuntimeError(f"Post-burst GET /api/stats returned {resp.status}")
                ledger_stats = json.loads(stats_body.decode("utf-8"))
            async with http.get(f"{base_url}/api/health") as resp:
                health_body = await resp.read()
                if resp.status != 200:
                    raise RuntimeError(f"Post-burst GET /api/health returned {resp.status}")
                post_health = json.loads(health_body.decode("utf-8"))

            alive_after = harness.is_alive()
    finally:
        await harness.stop()

    unhandled_errors = int(post_inspect.get("unhandled_errors", 0))
    server_crash_count = (0 if alive_after and post_health.get("ok") is True else 1) + unhandled_errors
    gemini_calls = int(ledger_stats.get("total", -1))

    all_latencies_ms = [r["latency_ms"] for r in results]
    http_200_count = sum(1 for r in results if r["status"] == 200 and r["payload_valid"])
    http_200_rate = round(http_200_count / float(N_CONCURRENT_REQUESTS), 4)
    wrong_dose_observed = sum(
        1 for r in results if r["route"] == "/api/eval-summary" and r["wrong_dose_val"] != 0
    )
    false_safe_observed = sum(
        1 for r in results if r["route"] == "/api/eval-summary" and r["false_safe_val"] != 0
    )

    route_latencies: dict[str, Any] = {}
    for route in BURST_ROUTES:
        r_rows = [r for r in results if r["route"] == route]
        r_lats = [r["latency_ms"] for r in r_rows]
        r_200 = sum(1 for r in r_rows if r["status"] == 200 and r["payload_valid"])
        r_bytes = r_rows[0]["wire_bytes"] if r_rows else 0
        route_latencies[route] = {
            "n_requests": len(r_rows),
            "http_200_count": r_200,
            "http_200_success_rate": round(r_200 / float(len(r_rows)), 4) if r_rows else 0.0,
            "wire_bytes": r_bytes,
            "latency_ms": summarize_latencies(r_lats),
            "samples_ms": r_lats,
        }

    if http_200_count != N_CONCURRENT_REQUESTS or http_200_rate != 1.0:
        raise AssertionError(
            f"Expected {N_CONCURRENT_REQUESTS}/{N_CONCURRENT_REQUESTS} HTTP 200 valid responses, got {http_200_count}"
        )
    if server_crash_count != 0:
        raise AssertionError(f"Expected 0 server crashes, observed {server_crash_count}")
    if wrong_dose_observed != 0 or false_safe_observed != 0:
        raise AssertionError(
            f"Safety count invariant failed: wrong_dose={wrong_dose_observed}, false_safe={false_safe_observed}"
        )
    if gemini_calls != 0:
        raise AssertionError(f"Expected 0 Gemini API calls, observed {gemini_calls}")

    throughput_rps = round((N_CONCURRENT_REQUESTS / (burst_wall_ms / 1000.0)), 2) if burst_wall_ms > 0 else 0.0

    return {
        "node_version": harness.node_version,
        "n_concurrent_requests": N_CONCURRENT_REQUESTS,
        "routes_tested": list(BURST_ROUTES),
        "http_200_count": http_200_count,
        "http_200_success_rate": http_200_rate,
        "burst_wall_clock_ms": burst_wall_ms,
        "throughput_rps": throughput_rps,
        "overall_latency_ms": summarize_latencies(all_latencies_ms),
        "server_crash_count": server_crash_count,
        "unhandled_exception_or_rejection_count": unhandled_errors,
        "confident_wrong_dose_count": wrong_dose_observed,
        "false_safe_allergen_count": false_safe_observed,
        "gemini_api_calls": gemini_calls,
        "post_burst_rss_mb": round(int(post_inspect["rss_bytes"]) / (1024.0 * 1024.0), 3),
        "post_burst_heap_mb": round(int(post_inspect["heap_used_bytes"]) / (1024.0 * 1024.0), 3),
        "route_latencies": route_latencies,
    }


async def run_benchmark(out_path: pathlib.Path) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="holdup_prod_footprint_") as tmp_dir:
        ledger_path = pathlib.Path(tmp_dir) / "ledger.jsonl"
        env_map = build_clean_server_env(ledger_path)
        node_bin = resolve_node_bin(env_map)
        built_fresh = ensure_production_dist(env_map)

        bundle_assets = measure_production_bundle_assets()
        cold_res = await bench_cold_starts(node_bin, env_map)
        burst_res = await bench_concurrent_single_origin_burst(node_bin, env_map)

    summary: dict[str, Any] = {
        "cold_start_boots": cold_res["n_cold_boots"],
        "cold_start_p50_ms": cold_res["total_cold_start_latency_ms"]["p50"],
        "cold_start_p95_ms": cold_res["total_cold_start_latency_ms"]["p95"],
        "cold_start_mean_ms": cold_res["total_cold_start_latency_ms"]["mean"],
        "cold_start_listen_p50_ms": cold_res["spawn_to_listen_latency_ms"]["p50"],
        "max_raw_js_chunk_bytes": bundle_assets["budgets"]["observed_max_raw_js_chunk_bytes"],
        "raw_js_chunk_budget_bytes": MAX_RAW_JS_CHUNK_BYTES,
        "all_raw_js_chunks_under_500kb": bundle_assets["budgets"]["all_raw_js_chunks_under_500kb"],
        "total_raw_js_css_bytes": bundle_assets["web_dist_totals"]["total_raw_js_css_bytes"],
        "total_gzip_js_css_bytes": bundle_assets["web_dist_totals"]["total_gzip_js_css_bytes"],
        "gzip_js_css_budget_bytes": MAX_TOTAL_GZIP_JS_CSS_BYTES,
        "total_gzip_js_css_under_250kb": bundle_assets["budgets"]["total_gzip_js_css_under_250kb"],
        "hud_waveguide_css_raw_bytes": bundle_assets["web_dist_totals"]["hud_waveguide_css_raw_bytes"],
        "hud_waveguide_css_gzip_bytes": bundle_assets["web_dist_totals"]["hud_waveguide_css_gzip_bytes"],
        "index_html_raw_bytes": bundle_assets["web_dist_index_html"]["raw_bytes"],
        "index_html_gzip_bytes": bundle_assets["web_dist_index_html"]["gzip_bytes"],
        "deck_total_raw_bytes": bundle_assets["deck_assets"]["total_raw_bytes"],
        "deck_total_gzip_bytes": bundle_assets["deck_assets"]["total_gzip_bytes"],
        "printable_sheets_total_raw_bytes": bundle_assets["printable_html_sheets"]["total_raw_bytes"],
        "printable_sheets_total_gzip_bytes": bundle_assets["printable_html_sheets"]["total_gzip_bytes"],
        "n_concurrent_requests": burst_res["n_concurrent_requests"],
        "n_routes_tested": len(BURST_ROUTES),
        "http_200_count": burst_res["http_200_count"],
        "http_200_success_rate": burst_res["http_200_success_rate"],
        "burst_wall_clock_ms": burst_res["burst_wall_clock_ms"],
        "throughput_rps": burst_res["throughput_rps"],
        "latency_p50_ms": burst_res["overall_latency_ms"]["p50"],
        "latency_p95_ms": burst_res["overall_latency_ms"]["p95"],
        "latency_p99_ms": burst_res["overall_latency_ms"]["p99"],
        "latency_mean_ms": burst_res["overall_latency_ms"]["mean"],
        "server_crash_count": burst_res["server_crash_count"],
        "confident_wrong_dose_count": burst_res["confident_wrong_dose_count"],
        "false_safe_allergen_count": burst_res["false_safe_allergen_count"],
        "gemini_api_calls": burst_res["gemini_api_calls"],
    }

    report = sanitize_obj(
        {
            "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "generated_by": "eval/eval_production_footprint.py",
            "node_version": burst_res["node_version"],
            "python_version": platform.python_version(),
            "transport": "tcp_loopback_127_0_0_1",
            "server_entrypoint": "startServer(0)",
            "built_dist_during_run": built_fresh,
            "gemini_api_calls": 0,
            "summary": summary,
            "bundle_assets": bundle_assets,
            "cold_starts_ms": cold_res["cold_starts_ms"],
            "cold_start_benchmark": cold_res,
            "route_latencies": burst_res["route_latencies"],
            "concurrent_burst_benchmark": {
                "n_concurrent_requests": burst_res["n_concurrent_requests"],
                "routes_tested": burst_res["routes_tested"],
                "http_200_count": burst_res["http_200_count"],
                "http_200_success_rate": burst_res["http_200_success_rate"],
                "burst_wall_clock_ms": burst_res["burst_wall_clock_ms"],
                "throughput_rps": burst_res["throughput_rps"],
                "overall_latency_ms": burst_res["overall_latency_ms"],
                "server_crash_count": burst_res["server_crash_count"],
                "unhandled_exception_or_rejection_count": burst_res["unhandled_exception_or_rejection_count"],
                "confident_wrong_dose_count": burst_res["confident_wrong_dose_count"],
                "false_safe_allergen_count": burst_res["false_safe_allergen_count"],
                "post_burst_rss_mb": burst_res["post_burst_rss_mb"],
                "post_burst_heap_mb": burst_res["post_burst_heap_mb"],
                "gemini_api_calls": burst_res["gemini_api_calls"],
            },
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
        description="Cold-start server boot, production asset byte-budget, and 200-request single-origin HTTP throughput benchmark"
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
