# Live smoke runs against real Gemini (evidence for latency claims)

- **When and where:** Sat 14 Nov 2026, about 23:08 Helsinki, on main `d53c205` (box-swap fix included), demo laptop on venue Wi-Fi.
- **Command:** `npm start`, then `npm -w server run smoke` three times. The smoke test opens a real `gemini-3.8-live` session, sends a synthetic amlodipine box at 1 fps and asks "Is this my evening pill?". It also checks scene mode, HUD fan-out, snapshot verify and readiness.

| Run | Question → first audio | Question → verdict | Checks |
|---|---|---|---|
| 1 | 2,063 ms | 1,024 ms | 13/13 PASS |
| 2 | 2,176 ms | 1,252 ms | 13/13 PASS |
| 3 | 932 ms | 1,077 ms | 13/13 PASS |
| earlier run (same evening) | 2,148 ms | 715 ms | 13/13 PASS |

**Server ledger** (`docs/evidence/api-stats-snapshot.json`, `GET /api/stats` after these runs, metadata only):
- Live sessions: n = 26. Question → first audio p50 **2.09 s**, p95 **3.45 s**.
- `verify_spec` (background reads): p50 4.7 s, p95 7.3 s.
- The cache answers the tool call at p50 0 s.

These counts include the robustness-test sessions. The 3 `fake` cache rows come from unit tests that share the ledger file.

**Baseline before speculative verify** (Sat about 15:45): 5.8 s from question to first audio, in a single smoke run. That run was before the ledger existed, so there is no committed record of it.
