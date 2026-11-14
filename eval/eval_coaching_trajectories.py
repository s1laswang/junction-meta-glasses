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
DEFAULT_OUT_PATH = REPO_ROOT / "eval" / "coaching_trajectories.json"

EM_DASH = chr(0x2014)
EN_DASH = chr(0x2013)
COMMENT_CHAR = chr(35)

TRAJECTORY_SPECS: list[dict[str, Any]] = [
    {
        "id": "traj_1_flip_box",
        "description": "Flip medicine box from barcode rear panel to sharp front label",
        "coaching_cue": "Turn the package around so the front label faces you.",
        "question": "Is this my evening pill?",
        "stage_a_fixtures": ["back_of_box.jpg", "back_of_box.jpg"],
        "stage_a_expected_level": "unsure",
        "stage_b_fixtures": ["amlodipine.jpg"],
        "stage_b_expected_level": "match",
        "stage_b_strength_readable": True,
        "stage_b_expected_strength": "5 mg",
        "stage_b_reason_kind": "aml_match",
    },
    {
        "id": "traj_2_move_thumb",
        "description": "Slide thumb off occluded dose digits on front label",
        "coaching_cue": "Move your thumb slightly off the strength numbers and hold still.",
        "question": "Is this my evening pill?",
        "stage_a_fixtures": ["blurry_amlodipine.jpg", "blurry_amlodipine.jpg"],
        "stage_a_expected_level": "unsure",
        "stage_b_fixtures": ["amlodipine.jpg"],
        "stage_b_expected_level": "match",
        "stage_b_strength_readable": True,
        "stage_b_expected_strength": "5 mg",
        "stage_b_reason_kind": "aml_match",
    },
    {
        "id": "traj_3_nsaid_catch",
        "description": "Flip box from blank rear panel to Burana 400 mg and catch NSAID avoid rule",
        "coaching_cue": "Turn the package around so the front label faces you.",
        "question": "Can I take this for a headache?",
        "stage_a_fixtures": ["back_of_box.jpg"],
        "stage_a_expected_level": "unsure",
        "stage_b_fixtures": ["ibuprofen.jpg"],
        "stage_b_expected_level": "warning",
        "stage_b_strength_readable": True,
        "stage_b_expected_strength": "400 mg",
        "stage_b_reason_kind": "nsaid_avoid",
    },
    {
        "id": "traj_4_allergen_catch",
        "description": "Turn package from rear panel to granola bar ingredients and catch nut allergen",
        "coaching_cue": "Turn the package around to show the ingredients panel.",
        "question": "Does this contain nuts?",
        "stage_a_fixtures": ["back_of_box.jpg"],
        "stage_a_expected_level": "unsure",
        "stage_b_fixtures": ["hazelnut_bar.jpg"],
        "stage_b_expected_level": "warning",
        "stage_b_strength_readable": False,
        "stage_b_expected_strength": None,
        "stage_b_reason_kind": "nut_allergen",
    },
]

TS_RUNNER_CODE = """
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import zlib from "node:zlib";
import { getOrCreateHub, resetHubsForTest } from "./server/src/hub.ts";
import { FrameRing, jpegSharpness, jpegSize, verify } from "./server/src/verify.ts";
import { STRENGTH_MIN_CONF, sameStrength } from "./server/src/safety.ts";
import { stats as ledgerStats } from "./server/src/ledger.ts";
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
const specs = cfg.specs;

const fixtureCache = new Map();
const b64ToFixture = new Map();
const fixtureMeta = {};

function loadFixture(name) {
  let entry = fixtureCache.get(name);
  if (!entry) {
    const buf = fs.readFileSync(path.join(fixturesDir, name));
    const data = buf.toString("base64");
    const sharpness = jpegSharpness(buf);
    const dim = jpegSize(buf) ?? { w: 768, h: 768 };
    entry = { name, buf, data, bytes: buf.length, sharpness, width: dim.w, height: dim.h };
    fixtureCache.set(name, entry);
    b64ToFixture.set(data, name);
    fixtureMeta[name] = {
      bytes: buf.length,
      width: dim.w,
      height: dim.h,
      jpeg_sharpness: Number(sharpness.toFixed(6)),
    };
  }
  return entry;
}

function summarizeFrame(f) {
  return {
    fixture: b64ToFixture.get(f.data) ?? "unknown",
    sharpness: Number(f.sharpness.toFixed(6)),
    bytes: f.bytes,
    source: f.source,
    ts: f.ts,
  };
}

resetHubsForTest();
const trajectories = [];

for (const spec of specs) {
  const hub = getOrCreateHub(spec.id);
  if (!(hub.ring instanceof FrameRing)) {
    throw new Error("Expected hub.ring to be an instance of FrameRing");
  }
  hub.profile = structuredClone(DEMO_PROFILE);
  const ringTrace = [];

  const stageANow = Date.now();
  const stageACount = spec.stage_a_fixtures.length;
  spec.stage_a_fixtures.forEach((fname, idx) => {
    const fx = loadFixture(fname);
    const frameObj = {
      data: fx.data,
      sharpness: fx.sharpness,
      ts: stageANow - (stageACount - 1 - idx) * 900,
      bytes: fx.bytes,
      source: "glasses",
    };
    hub.ring.push(frameObj);
    ringTrace.push(summarizeFrame(frameObj));
  });

  const ringLengthA = hub.ring.length;
  const ringFramesA = [...ringTrace];
  const pickedA = hub.ring.pick(2);
  const verifyA = await verify(
    pickedA.map((f) => f.data),
    hub.profile,
    spec.question,
    "verify_live"
  );

  const stageBNow = Date.now();
  const stageBCount = spec.stage_b_fixtures.length;
  spec.stage_b_fixtures.forEach((fname, idx) => {
    const fx = loadFixture(fname);
    const frameObj = {
      data: fx.data,
      sharpness: fx.sharpness,
      ts: stageBNow - (stageBCount - 1 - idx) * 900,
      bytes: fx.bytes,
      source: "glasses",
    };
    hub.ring.push(frameObj);
    ringTrace.push(summarizeFrame(frameObj));
  });

  const ringLengthB = hub.ring.length;
  const ringFramesB = [...ringTrace];
  const pickedB = hub.ring.pick(2);
  const verifyB = await verify(
    pickedB.map((f) => f.data),
    hub.profile,
    spec.question,
    "verify_live"
  );

  const strengthValB = verifyB.verdict?.read?.strength?.value ?? null;
  const strengthSameB = spec.stage_b_expected_strength
    ? sameStrength(strengthValB, spec.stage_b_expected_strength)
    : null;

  trajectories.push({
    id: spec.id,
    description: spec.description,
    coaching_cue: spec.coaching_cue,
    question: spec.question,
    stage_a_raw: {
      pushed_fixtures: spec.stage_a_fixtures,
      ring_length: ringLengthA,
      ring_frames: ringFramesA,
      picked_frames: pickedA.map(summarizeFrame),
      expected_level: spec.stage_a_expected_level,
      model: verifyA.model,
      latency_ms: verifyA.latencyMs,
      frames_verified: verifyA.frames,
      verdict: verifyA.verdict,
    },
    stage_b_raw: {
      pushed_fixtures: spec.stage_b_fixtures,
      ring_length: ringLengthB,
      ring_frames: ringFramesB,
      picked_frames: pickedB.map(summarizeFrame),
      expected_level: spec.stage_b_expected_level,
      strength_readable: spec.stage_b_strength_readable,
      expected_strength: spec.stage_b_expected_strength,
      reason_kind: spec.stage_b_reason_kind,
      strength_same: strengthSameB,
      model: verifyB.model,
      latency_ms: verifyB.latencyMs,
      frames_verified: verifyB.frames,
      verdict: verifyB.verdict,
    },
  });
}

const outPayload = {
  strength_min_conf: STRENGTH_MIN_CONF,
  profile: DEMO_PROFILE,
  fixture_sharpness: fixtureMeta,
  ledger_stats: ledgerStats(),
  trajectories,
};

fs.writeFileSync(cfg.outFile, JSON.stringify(outPayload), "utf8");
resetHubsForTest();
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
        return round(xs[0], 1)
    pos = (len(xs) - 1) * q
    lo = int(math.floor(pos))
    hi = int(math.ceil(pos))
    if lo == hi:
        return round(xs[lo], 1)
    frac = pos - lo
    return round(xs[lo] * (1.0 - frac) + xs[hi] * frac, 1)


def check_stage_b_reason(reason_kind: str, verdict: dict[str, Any]) -> bool:
    reasons = [str(r).lower() for r in (verdict.get("reasons") or [])]
    joined = " | ".join(reasons)
    matched_id = verdict.get("matchedMedId")
    if reason_kind == "aml_match":
        return matched_id == "aml" and "matches aml" in joined
    if reason_kind == "nsaid_avoid":
        return "nsaid" in joined
    if reason_kind == "nut_allergen":
        return "allergy:" in joined
    return False


def run_trajectories(out_path: pathlib.Path) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="holdup_coaching_traj_") as tmp_dir:
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
            "specs": TRAJECTORY_SPECS,
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
            err_tail = (proc.stderr or proc.stdout or "")[-1200:]
            raise RuntimeError(f"TS trajectory runner failed (exit {proc.returncode}):\n{err_tail}")

        raw_data = sanitize_obj(json.loads(raw_out_path.read_text(encoding="utf-8")))

    strength_min_conf = float(raw_data["strength_min_conf"])
    profile = raw_data["profile"]
    fixture_sharpness = raw_data["fixture_sharpness"]
    ledger_stats = raw_data["ledger_stats"]

    processed_trajectories: list[dict[str, Any]] = []
    stage_a_latencies: list[float] = []
    stage_b_latencies: list[float] = []
    all_latencies: list[float] = []
    confident_wrong_dose_count = 0
    pre_abstentions = 0
    post_matches = 0
    sharp_first_count = 0

    for item in raw_data["trajectories"]:
        sa = item["stage_a_raw"]
        sb = item["stage_b_raw"]

        verdict_a = sa["verdict"]
        read_a = verdict_a.get("read") or {}
        strength_a = read_a.get("strength") or {}
        strength_val_a = strength_a.get("value")
        strength_conf_a = round(float(strength_a.get("confidence") or 0.0), 4)
        pred_level_a = str(verdict_a.get("level") or "")
        exp_level_a = str(sa["expected_level"])

        cwd_a = strength_conf_a >= strength_min_conf or pred_level_a == "match"
        abstained_a = bool(sa["model"]) and pred_level_a == "unsure" and not cwd_a
        if abstained_a:
            pre_abstentions += 1
        if cwd_a:
            confident_wrong_dose_count += 1

        lat_a = round(float(sa["latency_ms"]), 1)
        stage_a_latencies.append(lat_a)
        all_latencies.append(lat_a)

        stage_a_record = {
            "pushed_fixtures": sa["pushed_fixtures"],
            "ring_length": sa["ring_length"],
            "ring_frames": sa["ring_frames"],
            "picked_frames": sa["picked_frames"],
            "expected_level": exp_level_a,
            "predicted_level": pred_level_a,
            "abstained": abstained_a,
            "strength_value": strength_val_a,
            "strength_confidence": strength_conf_a,
            "confident_wrong_dose": cwd_a,
            "model": sa["model"],
            "frames_verified": sa["frames_verified"],
            "latency_ms": lat_a,
            "verdict": verdict_a,
        }

        verdict_b = sb["verdict"]
        read_b = verdict_b.get("read") or {}
        strength_b = read_b.get("strength") or {}
        raw_strength_b = strength_b.get("value")
        strength_val_b = str(raw_strength_b) if isinstance(raw_strength_b, str) and raw_strength_b.strip() else None
        strength_conf_b = round(float(strength_b.get("confidence") or 0.0), 4)
        pred_level_b = str(verdict_b.get("level") or "")
        exp_level_b = str(sb["expected_level"])

        strength_readable_b = bool(sb["strength_readable"])
        strength_same_b = sb["strength_same"]
        if strength_readable_b:
            strength_ok_b: bool | None = (
                bool(strength_val_b)
                and strength_conf_b >= strength_min_conf
                and bool(strength_same_b)
            )
            cwd_b = (
                (strength_conf_b >= strength_min_conf and not bool(strength_same_b))
                or (exp_level_b != "match" and pred_level_b == "match")
            )
        else:
            strength_ok_b = None
            cwd_b = (
                strength_conf_b >= strength_min_conf
                or (exp_level_b != "match" and pred_level_b == "match")
            )

        if cwd_b:
            confident_wrong_dose_count += 1

        picked_b = sb["picked_frames"]
        target_sharp_fixture = sb["pushed_fixtures"][0]
        sharp_selected_first = bool(picked_b) and picked_b[0]["fixture"] == target_sharp_fixture
        mixed_ring_preserved = sb["ring_length"] == (len(sa["pushed_fixtures"]) + len(sb["pushed_fixtures"]))
        if sharp_selected_first:
            sharp_first_count += 1

        reason_ok_b = check_stage_b_reason(str(sb["reason_kind"]), verdict_b)
        verdict_match_b = (
            pred_level_b == exp_level_b
            and reason_ok_b
            and (True if strength_ok_b is None else bool(strength_ok_b))
        )
        if verdict_match_b:
            post_matches += 1

        lat_b = round(float(sb["latency_ms"]), 1)
        stage_b_latencies.append(lat_b)
        all_latencies.append(lat_b)

        stage_b_record = {
            "pushed_fixtures": sb["pushed_fixtures"],
            "ring_length": sb["ring_length"],
            "mixed_ring_preserved": mixed_ring_preserved,
            "ring_frames": sb["ring_frames"],
            "picked_frames": picked_b,
            "sharp_post_coaching_selected_first": sharp_selected_first,
            "expected_level": exp_level_b,
            "predicted_level": pred_level_b,
            "verdict_match": verdict_match_b,
            "reason_check_ok": reason_ok_b,
            "strength_readable": strength_readable_b,
            "expected_strength": sb["expected_strength"],
            "strength_value": strength_val_b,
            "strength_confidence": strength_conf_b,
            "strength_correct": strength_ok_b,
            "confident_wrong_dose": cwd_b,
            "model": sb["model"],
            "frames_verified": sb["frames_verified"],
            "latency_ms": lat_b,
            "verdict": verdict_b,
        }

        processed_trajectories.append(
            {
                "id": item["id"],
                "description": item["description"],
                "coaching_cue": item["coaching_cue"],
                "question": item["question"],
                "stage_a": stage_a_record,
                "stage_b": stage_b_record,
                "trajectory_passed": (
                    abstained_a
                    and not cwd_a
                    and mixed_ring_preserved
                    and sharp_selected_first
                    and verdict_match_b
                    and not cwd_b
                ),
            }
        )

    n_traj = len(processed_trajectories)
    verify_feature = ((ledger_stats.get("features") or {}).get("verify_live") or {})
    models_map = verify_feature.get("models") if isinstance(verify_feature.get("models"), dict) else {}
    primary_model = next(iter(models_map.keys()), "gemini-3.8-flash")

    summary = {
        "model": primary_model,
        "n_trajectories": n_traj,
        "n_verify_calls": n_traj * 2,
        "ring_capacity": 8,
        "pick_top_n": 2,
        "strength_min_conf": strength_min_conf,
        "pre_coaching_abstentions": pre_abstentions,
        "pre_coaching_abstention_rate": round(pre_abstentions / n_traj, 4) if n_traj else 0.0,
        "post_coaching_verdict_matches": post_matches,
        "post_coaching_verdict_accuracy": round(post_matches / n_traj, 4) if n_traj else 0.0,
        "post_coaching_sharp_selected_first_count": sharp_first_count,
        "post_coaching_sharp_selected_first_rate": round(sharp_first_count / n_traj, 4) if n_traj else 0.0,
        "confident_wrong_dose_count": confident_wrong_dose_count,
        "stage_a_latency_p50_ms": percentile(stage_a_latencies, 0.50),
        "stage_a_latency_p95_ms": percentile(stage_a_latencies, 0.95),
        "stage_a_latency_mean_ms": round(statistics.mean(stage_a_latencies), 1) if stage_a_latencies else None,
        "stage_b_latency_p50_ms": percentile(stage_b_latencies, 0.50),
        "stage_b_latency_p95_ms": percentile(stage_b_latencies, 0.95),
        "stage_b_latency_mean_ms": round(statistics.mean(stage_b_latencies), 1) if stage_b_latencies else None,
        "latency_p50_ms": percentile(all_latencies, 0.50),
        "latency_p95_ms": percentile(all_latencies, 0.95),
        "latency_mean_ms": round(statistics.mean(all_latencies), 1) if all_latencies else None,
        "tokens_in": verify_feature.get("tokens_in", 0),
        "tokens_out": verify_feature.get("tokens_out", 0),
        "tokens_thinking": verify_feature.get("tokens_thinking", 0),
        "ledger_stats": ledger_stats,
    }

    report = sanitize_obj(
        {
            "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "pipeline": "Hub.ring (FrameRing(8)) -> pick(2) -> verify() (gemini-3.8-flash) -> checkLabel()",
            "profile_summary": {
                "meds": [
                    f"{m['name']} {m['strength']} ({'/'.join(m['schedule'])})"
                    for m in profile["meds"]
                ],
                "allergies": list(profile["allergies"]),
                "avoid": list(profile["avoid"]),
            },
            "fixture_sharpness": fixture_sharpness,
            "summary": summary,
            "trajectories": processed_trajectories,
        }
    )

    assert_clean_json(report)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Multi-step physical hand-coaching trajectory benchmark on FrameRing + live verify()"
    )
    parser.add_argument(
        "--out",
        type=pathlib.Path,
        default=DEFAULT_OUT_PATH,
        help="Path to write coaching_trajectories.json",
    )
    args = parser.parse_args(argv)
    report = run_trajectories(args.out)
    print(json.dumps(report["summary"], indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
