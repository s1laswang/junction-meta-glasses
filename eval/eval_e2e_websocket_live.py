import argparse
import datetime
import json
import math
import os
import pathlib
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
from typing import Any

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
FIXTURES_DIR = REPO_ROOT / "web" / "public" / "fixtures"
DEFAULT_OUT_PATH = REPO_ROOT / "eval" / "e2e_websocket_live.json"

EM_DASH = chr(0x2014)
EN_DASH = chr(0x2013)
COMMENT_CHAR = chr(35)

VERIFY_TRIAL_SPECS: list[dict[str, Any]] = [
    {
        "fixture": "amlodipine.jpg",
        "question": "Is this my evening pill?",
        "expected_level": "match",
        "strength_readable": True,
        "expected_strength": "5 mg",
        "reason_kind": "aml_match",
    },
    {
        "fixture": "ibuprofen.jpg",
        "question": "Can I take this for a headache?",
        "expected_level": "warning",
        "strength_readable": True,
        "expected_strength": "400 mg",
        "reason_kind": "nsaid_avoid",
    },
    {
        "fixture": "blurry_amlodipine.jpg",
        "question": "Is this my evening pill?",
        "expected_level": "unsure",
        "strength_readable": False,
        "expected_strength": None,
        "reason_kind": "occluded_abstain",
    },
]

STATE_PROBE_BATTERIES: list[float] = [0.91, 0.87, 0.83]

LIVE_TURN_SPEC: dict[str, Any] = {
    "fixture": "amlodipine.jpg",
    "question": "Is this my evening pill?",
    "expected_level": "match",
    "expected_strength": "5 mg",
}

TS_RUNNER_CODE = """
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { performance } from "node:perf_hooks";
import zlib from "node:zlib";
import WebSocket from "ws";
import { startServer, getHub } from "./server/src/index.ts";
import { resetHubsForTest } from "./server/src/hub.ts";
import { FrameRing } from "./server/src/verify.ts";
import { STRENGTH_MIN_CONF, sameStrength } from "./server/src/safety.ts";
import { DEMO_PROFILE } from "./web/src/storage/profileStore.ts";

const proxyUrl = (
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy ||
  ""
).trim();

if (proxyUrl && !http.setGlobalProxyFromEnv) {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    );
    if (url.protocol !== "https:") return origFetch(input, init);
    const headers = {};
    if (init.headers) {
      const h = new Headers(init.headers);
      h.forEach((v, k) => {
        if (k.toLowerCase() !== "accept-encoding") headers[k] = v;
      });
    }
    headers["accept-encoding"] = "identity";
    const bodyBuf = init.body ? Buffer.from(init.body) : undefined;
    if (bodyBuf && !headers["content-length"]) {
      headers["content-length"] = String(bodyBuf.length);
    }
    return await new Promise((resolve, reject) => {
      const req = https.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || 443,
          path: url.pathname + url.search,
          method: init.method || "GET",
          headers,
          agent: https.globalAgent,
          signal: init.signal,
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(Buffer.from(c)));
          res.on("end", () => {
            let rawBuf = Buffer.concat(chunks);
            const enc = String(res.headers["content-encoding"] || "").toLowerCase();
            if (enc === "gzip") rawBuf = zlib.gunzipSync(rawBuf);
            else if (enc === "deflate") rawBuf = zlib.inflateSync(rawBuf);
            else if (enc === "br") rawBuf = zlib.brotliDecompressSync(rawBuf);
            const resHeaders = new Headers();
            for (const [k, v] of Object.entries(res.headers)) {
              if (k.toLowerCase() === "content-encoding" || k.toLowerCase() === "content-length") continue;
              if (Array.isArray(v)) v.forEach((x) => resHeaders.append(k, x));
              else if (typeof v === "string") resHeaders.set(k, v);
            }
            resolve(
              new Response(rawBuf, {
                status: res.statusCode || 500,
                statusText: res.statusMessage || "",
                headers: resHeaders,
              })
            );
          });
        }
      );
      req.on("error", reject);
      if (bodyBuf) req.write(bodyBuf);
      req.end();
    });
  };
}

const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const fixturesDir = cfg.fixturesDir;
const sessionId = "bench1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const roundMs = (v) => Number(v.toFixed(2));

function waitOpen(ws, label, timeoutMs = 8000) {
  const t0 = performance.now();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`WS open timeout: ${label}`)), timeoutMs);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve(roundMs(performance.now() - t0));
    });
    ws.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitJsonMsg(ws, predicate, label, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMsg);
      reject(new Error(`WS message timeout (${label})`));
    }, timeoutMs);
    function onMsg(raw) {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off("message", onMsg);
        resolve({ at: performance.now(), msg });
      }
    }
    ws.on("message", onMsg);
  });
}

function closeWsClean(ws, timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch {}
      resolve(false);
    }, timeoutMs);
    ws.once("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
    try { ws.close(); } catch {
      clearTimeout(timer);
      resolve(false);
    }
  });
}

resetHubsForTest();

const tBoot0 = performance.now();
const server = await startServer(0);
const serverBootMs = roundMs(performance.now() - tBoot0);
const addr = server.address();
const port = typeof addr === "object" && addr ? addr.port : 0;
const httpBase = `http://127.0.0.1:${port}`;
const wsBase = `ws://127.0.0.1:${port}`;

const tHealth0 = performance.now();
const healthRes = await fetch(`${httpBase}/api/health`);
const healthJson = await healthRes.json();
const healthCheckMs = roundMs(performance.now() - tHealth0);

const hudWs = new WebSocket(`${wsBase}/hud-ws`);
const hudConnectMs = await waitOpen(hudWs, "hud-ws");

const liveWs = new WebSocket(`${wsBase}/live?session=${sessionId}`);
const liveConnectMs = await waitOpen(liveWs, "live-ws");

const pongWait = waitJsonMsg(liveWs, (m) => m.type === "pong" && m.t === 101, "live pong", 5000);
const tPing0 = performance.now();
liveWs.send(JSON.stringify({ type: "ping", t: 101 }));
const pongRes = await pongWait;
const livePingPongMs = roundMs(pongRes.at - tPing0);

let liveConnectingAt = null;
const onStatusConnecting = (raw) => {
  try {
    const m = JSON.parse(raw.toString());
    if (m.type === "status" && m.live === "connecting" && liveConnectingAt === null) {
      liveConnectingAt = performance.now();
    }
  } catch {}
};
liveWs.on("message", onStatusConnecting);

const readyWait = waitJsonMsg(liveWs, (m) => m.type === "ready", "live ready", 30000);
const liveOpenWait = waitJsonMsg(liveWs, (m) => m.type === "status" && m.live === "open", "live status open", 30000);
const hudOpenWait = waitJsonMsg(hudWs, (m) => m.type === "status" && m.live === "open", "hud status open", 30000);
const hudAttachWait = waitJsonMsg(liveWs, (m) => m.type === "hud" && m.connected === true, "hud connected", 10000);

const tLiveStart0 = performance.now();
liveWs.send(
  JSON.stringify({
    type: "start",
    profile: structuredClone(DEMO_PROFILE),
    lang: "en",
    voice: true,
    source: "glasses",
  })
);

const [readyEvt, liveOpenEvt, hudOpenEvt, hudAttachEvt] = await Promise.all([
  readyWait,
  liveOpenWait,
  hudOpenWait,
  hudAttachWait,
]);
liveWs.off("message", onStatusConnecting);

const startupConnectingMs = liveConnectingAt !== null ? roundMs(liveConnectingAt - tLiveStart0) : null;
const startupReadyMs = roundMs(readyEvt.at - tLiveStart0);
const startupStatusOpenMs = roundMs(liveOpenEvt.at - tLiveStart0);
const startupHudStatusOpenMs = roundMs(hudOpenEvt.at - tLiveStart0);
const startupHudAttachMs = roundMs(hudAttachEvt.at - tLiveStart0);
const liveModelConnected = String(readyEvt.msg.model || liveOpenEvt.msg.detail || "");

const hub = getHub(sessionId);
if (!hub || !(hub.ring instanceof FrameRing)) {
  throw new Error("Expected active Hub with FrameRing(8) for bench1");
}

const stateProbes = [];
for (let i = 0; i < cfg.stateBatteries.length; i++) {
  const battery = cfg.stateBatteries[i];
  const hudDeviceWait = waitJsonMsg(
    hudWs,
    (m) => m.type === "device" && m.device && m.device.battery === battery,
    `hud device probe ${i}`,
    5000
  );
  const liveDeviceWait = waitJsonMsg(
    liveWs,
    (m) => m.type === "device" && m.device && m.device.battery === battery,
    `live device probe ${i}`,
    5000
  );
  const tState0 = performance.now();
  const httpPromise = fetch(`${httpBase}/ingest/state`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      connected: true,
      worn: true,
      streaming: true,
      battery,
    }),
  }).then((res) => ({ status: res.status, at: performance.now() }));

  const [httpDone, hudEvt, liveEvt] = await Promise.all([httpPromise, hudDeviceWait, liveDeviceWait]);
  stateProbes.push({
    probe_index: i + 1,
    battery,
    http_status: httpDone.status,
    http_ms: roundMs(httpDone.at - tState0),
    hud_ws_broadcast_ms: roundMs(hudEvt.at - tState0),
    live_ws_broadcast_ms: roundMs(liveEvt.at - tState0),
    hud_matched: hudEvt.msg.device.source === "glasses" && hudEvt.msg.device.streaming === true,
    live_matched: liveEvt.msg.device.source === "glasses" && liveEvt.msg.device.streaming === true,
  });
}

hub.ring.clear();
const liveTurnBuf = fs.readFileSync(path.join(fixturesDir, cfg.liveTurn.fixture));
const tLiveFrame0 = performance.now();
const liveFrameRes = await fetch(`${httpBase}/ingest/frame`, {
  method: "POST",
  headers: { "content-type": "image/jpeg" },
  body: liveTurnBuf,
});
const liveFrameIngestMs = roundMs(performance.now() - tLiveFrame0);
if (liveFrameRes.status !== 204) {
  throw new Error(`Expected 204 from /ingest/frame before live turn, got ${liveFrameRes.status}`);
}
await sleep(980);
await fetch(`${httpBase}/ingest/frame`, {
  method: "POST",
  headers: { "content-type": "image/jpeg" },
  body: liveTurnBuf,
});

let tTurn0 = 0;
let firstAudioAt = null;
let firstCoachAt = null;
let hudFirstCoachAt = null;
let firstTranscriptAt = null;
let turnDoneAt = null;
let coachCue = null;
let coachText = null;
let audioChunks = 0;
let pcm16Bytes = 0;
let lastAudioAt = 0;
let checkingActive = false;
let usedVerifyTool = false;
let liveTurnVerdict = null;
let liveTurnVerdictAt = null;
const finalAssistantParts = [];

const liveTurnPromise = new Promise((resolve, reject) => {
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(hardTimer);
    clearInterval(idlePoll);
    clearInterval(framePump);
    liveWs.off("message", onLiveMsg);
    hudWs.off("message", onHudMsg);
    turnDoneAt = performance.now();
    resolve(null);
  };
  const hardTimer = setTimeout(() => {
    if (audioChunks > 0 || firstCoachAt !== null) {
      finish();
      return;
    }
    settled = true;
    clearInterval(idlePoll);
    clearInterval(framePump);
    liveWs.off("message", onLiveMsg);
    hudWs.off("message", onHudMsg);
    reject(new Error("Live turn timed out without audio or coaching events"));
  }, 32000);

  const framePump = setInterval(() => {
    if (!settled && !checkingActive && liveTurnVerdict === null) {
      fetch(`${httpBase}/ingest/frame`, {
        method: "POST",
        headers: { "content-type": "image/jpeg" },
        body: liveTurnBuf,
      }).catch(() => {});
    }
  }, 1000);

  const idlePoll = setInterval(() => {
    if (
      !checkingActive &&
      audioChunks > 0 &&
      lastAudioAt > 0 &&
      performance.now() - lastAudioAt > 2500 &&
      (!usedVerifyTool || liveTurnVerdict !== null)
    ) {
      finish();
    }
  }, 200);

  function onHudMsg(raw) {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === "coach" && hudFirstCoachAt === null) {
      hudFirstCoachAt = performance.now();
    }
  }

  function onLiveMsg(raw) {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    const now = performance.now();
    if (m.type === "audio" && typeof m.data === "string") {
      if (firstAudioAt === null) firstAudioAt = now;
      lastAudioAt = now;
      audioChunks += 1;
      pcm16Bytes += Buffer.from(m.data, "base64").length;
      return;
    }
    if (m.type === "coach") {
      if (firstCoachAt === null) {
        firstCoachAt = now;
        coachCue = m.cue ?? null;
        coachText = m.text ?? null;
      }
      return;
    }
    if (m.type === "checking") {
      if (m.phase === "start") {
        checkingActive = true;
        usedVerifyTool = true;
      } else if (m.phase === "end") {
        checkingActive = false;
      }
      return;
    }
    if (m.type === "verdict") {
      liveTurnVerdict = m.verdict;
      liveTurnVerdictAt = now;
      return;
    }
    if (m.type === "transcript" && m.role === "assistant") {
      if (firstTranscriptAt === null) firstTranscriptAt = now;
      if (m.final) {
        finalAssistantParts.push(String(m.text || ""));
        if (!checkingActive && audioChunks > 0 && liveTurnVerdict !== null) {
          setTimeout(finish, 150);
        }
      }
    }
  }

  hudWs.on("message", onHudMsg);
  liveWs.on("message", onLiveMsg);

  tTurn0 = performance.now();
  liveWs.send(JSON.stringify({ type: "text", text: cfg.liveTurn.question }));
});

await liveTurnPromise;

const liveClosedWait = waitJsonMsg(
  liveWs,
  (m) => m.type === "status" && m.live === "closed",
  "live status closed",
  6000
);
liveWs.send(JSON.stringify({ type: "event", name: "stop" }));
await liveClosedWait;
await sleep(100);

const verifyTrials = [];
for (const spec of cfg.verifySpecs) {
  hub.ring.clear();
  const buf = fs.readFileSync(path.join(fixturesDir, spec.fixture));

  const tCycle0 = performance.now();
  const ingestRes = await fetch(`${httpBase}/ingest/frame`, {
    method: "POST",
    headers: { "content-type": "image/jpeg" },
    body: buf,
  });
  const tIngestDone = performance.now();
  if (ingestRes.status !== 204) {
    throw new Error(`Expected 204 from /ingest/frame for ${spec.fixture}, got ${ingestRes.status}`);
  }

  const ringLen = hub.ring.length;
  const picked = hub.ring.pick(2);
  const tPickDone = performance.now();
  if (!picked.length) {
    throw new Error(`FrameRing.pick(2) returned empty for ${spec.fixture}`);
  }

  const hudVerdictWait = waitJsonMsg(
    hudWs,
    (m) => m.type === "verdict" && m.verdict && typeof m.verdict.level === "string",
    `hud verdict ${spec.fixture}`,
    30000
  );

  const tVerify0 = performance.now();
  const verifyHttpPromise = fetch(`${httpBase}/api/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      frames: picked.map((f) => f.data),
      profile: structuredClone(DEMO_PROFILE),
      question: spec.question,
    }),
  }).then(async (res) => {
    const body = await res.json();
    return { status: res.status, at: performance.now(), verdict: body };
  });

  const [verifyHttp, hudVerdictEvt] = await Promise.all([verifyHttpPromise, hudVerdictWait]);
  if (verifyHttp.status !== 200) {
    throw new Error(`/api/verify failed for ${spec.fixture} with status ${verifyHttp.status}`);
  }

  const strengthVal = verifyHttp.verdict?.read?.strength?.value ?? null;
  const strengthSame = spec.expected_strength
    ? sameStrength(strengthVal, spec.expected_strength)
    : null;

  verifyTrials.push({
    fixture: spec.fixture,
    question: spec.question,
    expected_level: spec.expected_level,
    strength_readable: spec.strength_readable,
    expected_strength: spec.expected_strength,
    reason_kind: spec.reason_kind,
    strength_same: strengthSame,
    bytes: buf.length,
    ring_length: ringLen,
    ring_picked_count: picked.length,
    ring_source: picked[0].source,
    ring_sharpness: Number(picked[0].sharpness.toFixed(6)),
    ingest_frame_ms: roundMs(tIngestDone - tCycle0),
    ring_pick_ms: roundMs(tPickDone - tIngestDone),
    api_verify_http_ms: roundMs(verifyHttp.at - tVerify0),
    verify_to_hud_ws_ms: roundMs(hudVerdictEvt.at - tVerify0),
    e2e_frame_to_hud_verdict_ms: roundMs(hudVerdictEvt.at - tCycle0),
    http_verdict: verifyHttp.verdict,
    hud_verdict: hudVerdictEvt.msg.verdict,
  });
}

const statsRes = await fetch(`${httpBase}/api/stats`);
const ledgerStats = await statsRes.json();

const liveClosedOk = await closeWsClean(liveWs);
const hudClosedOk = await closeWsClean(hudWs);
resetHubsForTest();
await new Promise((resolve) => server.close(() => resolve(null)));

const firstAudioMs = firstAudioAt !== null ? roundMs(firstAudioAt - tTurn0) : null;
const firstCoachMs = firstCoachAt !== null ? roundMs(firstCoachAt - tTurn0) : null;
const hudFirstCoachMs = hudFirstCoachAt !== null ? roundMs(hudFirstCoachAt - tTurn0) : null;
const firstTranscriptMs = firstTranscriptAt !== null ? roundMs(firstTranscriptAt - tTurn0) : null;
const candidateEvents = [firstAudioMs, firstCoachMs].filter((x) => typeof x === "number");
const firstEventMs = candidateEvents.length ? Math.min(...candidateEvents) : null;

const liveStrengthSame = cfg.liveTurn.expected_strength
  ? sameStrength(liveTurnVerdict?.read?.strength?.value ?? null, cfg.liveTurn.expected_strength)
  : null;

const outPayload = {
  session_id: sessionId,
  strength_min_conf: STRENGTH_MIN_CONF,
  profile: DEMO_PROFILE,
  transport: {
    port,
    server_boot_ms: serverBootMs,
    health_check_ms: healthCheckMs,
    health_ok: Boolean(healthJson?.ok && healthJson?.gemini === "ok"),
    models_configured: healthJson?.models ?? null,
    hud_ws_connect_ms: hudConnectMs,
    live_ws_connect_ms: liveConnectMs,
    live_ws_ping_pong_ms: livePingPongMs,
    clean_shutdown: Boolean(liveClosedOk && hudClosedOk),
  },
  state_probes: stateProbes,
  live_session: {
    model: liveModelConnected,
    startup_to_connecting_ms: startupConnectingMs,
    startup_to_hud_attached_ms: startupHudAttachMs,
    startup_to_ready_ms: startupReadyMs,
    startup_to_status_open_ms: startupStatusOpenMs,
    startup_to_hud_status_open_ms: startupHudStatusOpenMs,
    pre_turn_ingest_frame_ms: liveFrameIngestMs,
    turn_fixture: cfg.liveTurn.fixture,
    turn_question: cfg.liveTurn.question,
    first_audio_chunk_ms: firstAudioMs,
    first_coach_event_ms: firstCoachMs,
    hud_first_coach_event_ms: hudFirstCoachMs,
    first_transcript_delta_ms: firstTranscriptMs,
    first_event_ms: firstEventMs,
    turn_complete_ms: turnDoneAt !== null ? roundMs(turnDoneAt - tTurn0) : null,
    coach_cue: coachCue,
    coach_text: coachText,
    audio_chunks: audioChunks,
    pcm16_bytes: pcm16Bytes,
    pcm16_duration_s: Number((pcm16Bytes / 48000).toFixed(3)),
    assistant_transcript: finalAssistantParts.join(" ").trim(),
    used_verify_tool: usedVerifyTool,
    live_strength_same: liveStrengthSame,
    live_verdict_ms: liveTurnVerdictAt !== null ? roundMs(liveTurnVerdictAt - tTurn0) : null,
    live_verdict: liveTurnVerdict,
  },
  verify_trials: verifyTrials,
  ledger_stats: ledgerStats,
};

fs.writeFileSync(cfg.outFile, JSON.stringify(outPayload), "utf8");
process.exit(0);
"""


def parse_env_file(env_path: pathlib.Path) -> dict[str, str]:
    parsed: dict[str, str] = {}
    if not env_path.is_file():
        return parsed
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith(COMMENT_CHAR):
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


def build_runner_env(ledger_path: pathlib.Path) -> dict[str, str]:
    deps_nm = pathlib.Path("/tmp/fleet-silas/meta-deps/node_modules")
    local_nm = REPO_ROOT / "node_modules"
    if not local_nm.exists() and deps_nm.is_dir():
        local_nm.symlink_to(deps_nm)

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


def sanitize_obj(val: Any) -> Any:
    if isinstance(val, str):
        cleaned = val.replace(EM_DASH, " - ").replace(EN_DASH, "-")
        return re.sub(r"AIza[0-9A-Za-z_-]{10,}", "[REDACTED_KEY]", cleaned)
    if isinstance(val, list):
        return [sanitize_obj(item) for item in val]
    if isinstance(val, dict):
        return {sanitize_obj(str(k)): sanitize_obj(v) for k, v in val.items()}
    return val


def assert_clean_json(node: Any) -> None:
    if isinstance(node, str):
        if EM_DASH in node:
            raise AssertionError(f"Em dash found in output string: {node[:80]}")
        if node.startswith("/9j/") or len(node) > 1200:
            raise AssertionError("Unexpected base64 or oversized string found in output JSON")
        return
    if isinstance(node, list):
        for elem in node:
            assert_clean_json(elem)
        return
    if isinstance(node, dict):
        for k, v in node.items():
            assert_clean_json(k)
            assert_clean_json(v)


def percentile(vals: list[float], q: float) -> float | None:
    if not vals:
        return None
    xs = sorted(vals)
    if len(xs) == 1:
        return round(xs[0], 2)
    pos = (len(xs) - 1) * q
    lo = int(math.floor(pos))
    hi = int(math.ceil(pos))
    if lo == hi:
        return round(xs[lo], 2)
    frac = pos - lo
    return round(xs[lo] * (1.0 - frac) + xs[hi] * frac, 2)


def check_reason_kind(reason_kind: str, verdict: dict[str, Any]) -> bool:
    reasons = [str(r).lower() for r in (verdict.get("reasons") or [])]
    joined = " | ".join(reasons)
    matched_id = verdict.get("matchedMedId")
    if reason_kind == "aml_match":
        return matched_id == "aml" and "matches aml" in joined
    if reason_kind == "nsaid_avoid":
        return "nsaid" in joined
    if reason_kind == "occluded_abstain":
        return verdict.get("level") == "unsure"
    return False


def run_benchmark(out_path: pathlib.Path) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="holdup_e2e_ws_live_") as tmp_dir:
        tmp_root = pathlib.Path(tmp_dir)
        ledger_path = tmp_root / "ledger.jsonl"
        cfg_path = tmp_root / "runner_cfg.json"
        raw_out_path = tmp_root / "runner_out.json"

        runner_env = build_runner_env(ledger_path)
        if not runner_env.get("GEMINI_API_KEY"):
            raise RuntimeError("GEMINI_API_KEY is missing from environment and $HOME/momin/.env")

        node_bin = shutil.which("node", path=runner_env.get("PATH"))
        if not node_bin:
            raise RuntimeError("node binary not found on PATH")

        cfg_payload = {
            "fixturesDir": str(FIXTURES_DIR),
            "verifySpecs": VERIFY_TRIAL_SPECS,
            "stateBatteries": STATE_PROBE_BATTERIES,
            "liveTurn": LIVE_TURN_SPEC,
            "outFile": str(raw_out_path),
        }
        cfg_path.write_text(json.dumps(cfg_payload), encoding="utf-8")

        proc = subprocess.run(
            [node_bin, "--import", "tsx", "--input-type=module", "-e", TS_RUNNER_CODE, str(cfg_path)],
            cwd=str(REPO_ROOT),
            env=runner_env,
            capture_output=True,
            text=True,
            timeout=240,
        )
        if proc.returncode != 0:
            err_tail = (proc.stderr or proc.stdout or "")[-1600:]
            raise RuntimeError(f"TS e2e WebSocket runner failed (exit {proc.returncode}):\n{err_tail}")

        raw_data = sanitize_obj(json.loads(raw_out_path.read_text(encoding="utf-8")))

    strength_min_conf = float(raw_data["strength_min_conf"])
    profile = raw_data["profile"]
    transport = raw_data["transport"]
    state_probes = raw_data["state_probes"]
    live_session = raw_data["live_session"]
    ledger_stats = raw_data["ledger_stats"]

    confident_wrong_dose_count = 0

    live_verdict = live_session.get("live_verdict")
    live_cwd = False
    if isinstance(live_verdict, dict):
        lv_read = live_verdict.get("read") or {}
        lv_strength = lv_read.get("strength") or {}
        lv_conf = float(lv_strength.get("confidence") or 0.0)
        lv_level = str(live_verdict.get("level") or "")
        lv_same = bool(live_session.get("live_strength_same"))
        exp_lv_level = str(LIVE_TURN_SPEC.get("expected_level") or "match")
        live_cwd = (lv_conf >= strength_min_conf and not lv_same) or (
            exp_lv_level != "match" and lv_level == "match"
        )
        if live_cwd:
            confident_wrong_dose_count += 1
    live_session["confident_wrong_dose"] = live_cwd

    processed_trials: list[dict[str, Any]] = []
    verdict_levels: dict[str, str] = {}
    verdict_matches = 0
    hud_received_count = 0

    ingest_frame_ms_list: list[float] = []
    api_verify_ms_list: list[float] = []
    verify_to_hud_ms_list: list[float] = []
    e2e_frame_to_hud_ms_list: list[float] = []

    for item in raw_data["verify_trials"]:
        http_v = item["http_verdict"]
        hud_v = item["hud_verdict"]
        read_obj = http_v.get("read") or {}
        strength_obj = read_obj.get("strength") or {}
        raw_strength = strength_obj.get("value")
        strength_val = str(raw_strength) if isinstance(raw_strength, str) and raw_strength.strip() else None
        strength_conf = round(float(strength_obj.get("confidence") or 0.0), 4)

        pred_level = str(http_v.get("level") or "")
        hud_level = str(hud_v.get("level") or "")
        exp_level = str(item["expected_level"])
        verdict_levels[item["fixture"]] = pred_level

        hud_received = (
            bool(hud_level)
            and hud_level == pred_level
            and str(hud_v.get("headline") or "") == str(http_v.get("headline") or "")
        )
        if hud_received:
            hud_received_count += 1

        strength_readable = bool(item["strength_readable"])
        strength_same = item["strength_same"]
        if strength_readable:
            strength_ok: bool | None = (
                bool(strength_val)
                and strength_conf >= strength_min_conf
                and bool(strength_same)
            )
            cwd = (
                (strength_conf >= strength_min_conf and not bool(strength_same))
                or (exp_level != "match" and pred_level == "match")
            )
        else:
            strength_ok = None
            cwd = (
                strength_conf >= strength_min_conf
                or (exp_level != "match" and pred_level == "match")
            )

        if cwd:
            confident_wrong_dose_count += 1

        reason_ok = check_reason_kind(str(item["reason_kind"]), http_v)
        v_match = (
            pred_level == exp_level
            and reason_ok
            and (True if strength_ok is None else bool(strength_ok))
        )
        if v_match:
            verdict_matches += 1

        inf_ms = float(item["ingest_frame_ms"])
        apv_ms = float(item["api_verify_http_ms"])
        vth_ms = float(item["verify_to_hud_ws_ms"])
        e2e_ms = float(item["e2e_frame_to_hud_verdict_ms"])

        ingest_frame_ms_list.append(inf_ms)
        api_verify_ms_list.append(apv_ms)
        verify_to_hud_ms_list.append(vth_ms)
        e2e_frame_to_hud_ms_list.append(e2e_ms)

        processed_trials.append(
            {
                "fixture": item["fixture"],
                "question": item["question"],
                "bytes": item["bytes"],
                "ring_length": item["ring_length"],
                "ring_picked_count": item["ring_picked_count"],
                "ring_source": item["ring_source"],
                "ring_sharpness": item["ring_sharpness"],
                "ingest_frame_ms": inf_ms,
                "ring_pick_ms": item["ring_pick_ms"],
                "api_verify_http_ms": apv_ms,
                "verify_to_hud_ws_ms": vth_ms,
                "e2e_frame_to_hud_verdict_ms": e2e_ms,
                "expected_level": exp_level,
                "predicted_level": pred_level,
                "hud_verdict_level": hud_level,
                "hud_received_verdict": hud_received,
                "verdict_match": v_match,
                "reason_check_ok": reason_ok,
                "strength_readable": strength_readable,
                "expected_strength": item["expected_strength"],
                "strength_value": strength_val,
                "strength_confidence": strength_conf,
                "strength_correct": strength_ok,
                "confident_wrong_dose": cwd,
                "verdict": http_v,
            }
        )

    n_trials = len(processed_trials)
    hud_all_3 = hud_received_count == n_trials and n_trials == 3

    state_http_vals = [float(p["http_ms"]) for p in state_probes]
    state_hud_vals = [float(p["hud_ws_broadcast_ms"]) for p in state_probes]
    state_live_vals = [float(p["live_ws_broadcast_ms"]) for p in state_probes]

    verify_feature = ((ledger_stats.get("features") or {}).get("verify") or {})
    verify_models_map = verify_feature.get("models") if isinstance(verify_feature.get("models"), dict) else {}
    verify_model_used = next(iter(verify_models_map.keys()), "gemini-3.8-flash")

    aml_trial = next((t for t in processed_trials if t["fixture"] == "amlodipine.jpg"), None)

    summary = {
        "session_id": raw_data["session_id"],
        "live_model": live_session["model"],
        "verify_model": verify_model_used,
        "strength_min_conf": strength_min_conf,
        "server_boot_ms": transport["server_boot_ms"],
        "hud_ws_connect_ms": transport["hud_ws_connect_ms"],
        "live_ws_connect_ms": transport["live_ws_connect_ms"],
        "live_ws_ping_pong_ms": transport["live_ws_ping_pong_ms"],
        "ingest_state_n_probes": len(state_probes),
        "ingest_state_http_p50_ms": percentile(state_http_vals, 0.50),
        "ingest_state_to_hud_ws_p50_ms": percentile(state_hud_vals, 0.50),
        "ingest_state_to_hud_ws_mean_ms": round(statistics.mean(state_hud_vals), 2) if state_hud_vals else None,
        "ingest_state_to_live_ws_p50_ms": percentile(state_live_vals, 0.50),
        "ingest_state_to_live_ws_mean_ms": round(statistics.mean(state_live_vals), 2) if state_live_vals else None,
        "ingest_frame_to_ring_p50_ms": percentile(ingest_frame_ms_list, 0.50),
        "ingest_frame_to_ring_mean_ms": round(statistics.mean(ingest_frame_ms_list), 2) if ingest_frame_ms_list else None,
        "api_verify_http_p50_ms": percentile(api_verify_ms_list, 0.50),
        "verify_to_hud_ws_p50_ms": percentile(verify_to_hud_ms_list, 0.50),
        "verify_to_hud_ws_p95_ms": percentile(verify_to_hud_ms_list, 0.95),
        "verify_to_hud_ws_mean_ms": round(statistics.mean(verify_to_hud_ms_list), 2) if verify_to_hud_ms_list else None,
        "e2e_frame_to_hud_verdict_p50_ms": percentile(e2e_frame_to_hud_ms_list, 0.50),
        "e2e_frame_to_hud_verdict_p95_ms": percentile(e2e_frame_to_hud_ms_list, 0.95),
        "e2e_frame_to_hud_verdict_mean_ms": round(statistics.mean(e2e_frame_to_hud_ms_list), 2) if e2e_frame_to_hud_ms_list else None,
        "amlodipine_frame_to_hud_verdict_ms": aml_trial["e2e_frame_to_hud_verdict_ms"] if aml_trial else None,
        "n_verify_trials": n_trials,
        "verify_verdict_levels": verdict_levels,
        "verify_verdict_matches": verdict_matches,
        "verify_verdict_accuracy": round(verdict_matches / n_trials, 4) if n_trials else 0.0,
        "hud_received_all_3": hud_all_3,
        "hud_received_all_verdicts": hud_all_3,
        "live_startup_to_ready_ms": live_session["startup_to_ready_ms"],
        "live_startup_to_status_open_ms": live_session["startup_to_status_open_ms"],
        "live_startup_to_hud_status_open_ms": live_session["startup_to_hud_status_open_ms"],
        "live_turn_first_audio_chunk_ms": live_session["first_audio_chunk_ms"],
        "live_turn_first_coach_event_ms": live_session["first_coach_event_ms"],
        "live_turn_first_event_ms": live_session["first_event_ms"],
        "live_turn_complete_ms": live_session["turn_complete_ms"],
        "live_turn_audio_chunks": live_session["audio_chunks"],
        "live_turn_pcm16_bytes": live_session["pcm16_bytes"],
        "live_turn_pcm16_duration_s": live_session["pcm16_duration_s"],
        "confident_wrong_dose_count": confident_wrong_dose_count,
        "clean_shutdown": transport["clean_shutdown"],
        "ledger_stats": ledger_stats,
    }

    report = sanitize_obj(
        {
            "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "pipeline": "DAT /ingest/* + WS /live?session=bench1 (gemini-3.8-live) + HTTP /api/verify (gemini-3.8-flash) -> session-less WS /hud-ws",
            "session_id": raw_data["session_id"],
            "hud_received_all_3": hud_all_3,
            "hud_received_all_verdicts": hud_all_3,
            "confident_wrong_dose_count": confident_wrong_dose_count,
            "profile_summary": {
                "meds": [
                    f"{m['name']} {m['strength']} ({'/'.join(m['schedule'])})"
                    for m in profile["meds"]
                ],
                "allergies": list(profile["allergies"]),
                "avoid": list(profile["avoid"]),
            },
            "summary": summary,
            "transport_setup": transport,
            "ingest_state_broadcast": state_probes,
            "live_websocket_session": live_session,
            "ingest_frame_verify_hud_trials": processed_trials,
        }
    )

    assert_clean_json(report)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="End-to-end live WebSocket, DAT ingest, and /hud-ws wire latency benchmark"
    )
    parser.add_argument(
        "--out",
        type=pathlib.Path,
        default=DEFAULT_OUT_PATH,
        help="Path to write e2e_websocket_live.json",
    )
    args = parser.parse_args(argv)
    report = run_benchmark(args.out)
    print(json.dumps(report["summary"], indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
