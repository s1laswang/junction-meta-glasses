#!/usr/bin/env bash
# One-command judge acceptance for HoldUp (s1laswang/junction-meta-glasses).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PATH="${HOME}/.local/bin:${PATH}"

rows=(); pass=0; fail=0; skip=0
record() {
  local st="$1" name="$2" detail="$3"
  rows+=("$st|$name|$detail")
  case "$st" in PASS) pass=$((pass+1));; FAIL) fail=$((fail+1));; SKIP) skip=$((skip+1));; esac
  printf '  [%s] %s — %s\n' "$st" "$name" "$detail"
}
say() { printf '%s\n' "$*"; }
has_env() {
  local n="$1"
  if [ -n "${!n:-}" ]; then return 0; fi
  if [ -f .env ]; then
    python3 - "$n" <<'PY'
import sys
from pathlib import Path
name = sys.argv[1]
for line in Path(".env").read_text().splitlines():
    s=line.strip()
    if not s or s.startswith("#") or "=" not in s:
        continue
    k,v=s.split("=",1)
    if k.strip()==name and v.strip().strip('"').strip("'"):
        sys.exit(0)
sys.exit(1)
PY
    return $?
  fi
  return 1
}

say "== HoldUp judge accept (junction-meta-glasses) =="
say "cwd=$ROOT"

if command -v node >/dev/null 2>&1; then
  ver=$(node -v)
  record PASS "node on PATH" "$ver (README: Node >=20)"
else
  record FAIL "node on PATH" "Node.js 20+ required"
fi
if command -v npm >/dev/null 2>&1; then
  record PASS "npm on PATH" "$(npm -v)"
else
  record FAIL "npm on PATH" "npm required"
fi

if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
    record PASS "cp .env.example .env" "created (fill GEMINI_API_KEY locally; not committed)"
  else
    record FAIL "cp .env.example .env" ".env.example missing"
  fi
else
  record PASS ".env present" "not printed"
fi

if has_env GEMINI_API_KEY; then
  record PASS "GEMINI_API_KEY" "set (value not printed)"
else
  record SKIP "GEMINI_API_KEY" "unset — live server, smoke, and eval need it; use ?mock=1"
fi

if [ "$fail" -gt 0 ]; then
  say "Prerequisites missing; stopping."
else
  say "-- npm install --"
  set +e
  npm install > /tmp/meta-accept-npm.txt 2>&1
  nec=$?
  set -e
  if [ "$nec" -eq 0 ]; then
    record PASS "npm install" "exit 0"
  else
    record FAIL "npm install" "exit $nec (see /tmp/meta-accept-npm.txt)"
  fi

  say "-- typecheck --"
  set +e
  npm run typecheck > /tmp/meta-accept-typecheck.txt 2>&1
  tec=$?
  set -e
  if [ "$tec" -eq 0 ]; then
    record PASS "npm run typecheck" "exit 0"
  else
    record FAIL "npm run typecheck" "exit $tec"
  fi

  say "-- server unit tests --"
  set +e
  npm -w server test > /tmp/meta-accept-test.txt 2>&1
  sec=$?
  set -e
  summary=$(grep -E "tests |pass |fail |duration" /tmp/meta-accept-test.txt | tail -6 | tr '\n' ' ' || true)
  if [ "$sec" -eq 0 ]; then
    record PASS "npm -w server test" "${summary:-exit 0}"
  else
    record FAIL "npm -w server test" "exit $sec ${summary}"
  fi

  say "-- mock web path --"
  set +e
  npm run dev > /tmp/meta-accept-dev.txt 2>&1 &
  dpid=$!
  set -e
  up=0
  for i in $(seq 1 40); do
    if curl -s -o /dev/null --max-time 1 http://127.0.0.1:5173/; then up=1; break; fi
    if ! kill -0 "$dpid" 2>/dev/null; then break; fi
    sleep 0.4
  done
  if [ "$up" -eq 1 ]; then
    record PASS "npm run dev starts" "http://127.0.0.1:5173 pid=$dpid"
    code=$(curl -s -o /tmp/meta-accept-mock.html -w "%{http_code}" --max-time 5 "http://127.0.0.1:5173/?mock=1" || echo 000)
    case "$code" in
      2*|3*) record PASS "GET /?mock=1" "HTTP $code" ;;
      *) record FAIL "GET /?mock=1" "HTTP $code" ;;
    esac
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://127.0.0.1:5173/hud/?mock=1" || echo 000)
    case "$code" in
      2*|3*) record PASS "GET /hud/?mock=1" "HTTP $code" ;;
      *) record FAIL "GET /hud/?mock=1" "HTTP $code" ;;
    esac
  else
    record FAIL "npm run dev starts" "did not bind :5173; $(tail -3 /tmp/meta-accept-dev.txt | tr '\n' ' ')"
  fi
  kill "$dpid" 2>/dev/null || true
  wait "$dpid" 2>/dev/null || true

  if has_env GEMINI_API_KEY; then
    record SKIP "npm -w server run smoke" "key is set but live Gemini smoke is not run inside this accept (run it by hand)"
  else
    record SKIP "npm -w server run smoke" "GEMINI_API_KEY unset"
  fi
  record SKIP "npm run tunnel / glasses / android-dat" "needs cloudflared, a phone, or Meta glasses hardware"
fi

say ""
say "==== ACCEPT TABLE ===="
printf '%-6s  %-32s  %s\n' "STATUS" "CHECK" "DETAIL"
for r in "${rows[@]}"; do
  IFS='|' read -r st name detail <<<"$r"
  printf '%-6s  %-32s  %s\n' "$st" "$name" "$detail"
done
say "PASS=$pass  FAIL=$fail  SKIP=$skip"
if [ "$fail" -gt 0 ]; then
  say "RESULT: FAIL"
  exit 1
fi
say "RESULT: PASS"
exit 0
