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

## Metered breakdown by path

Every latency claim in `README.md`, `GEMINI.md`, `deck/index.html` (Slide 7), `docs/PLAN.md`, and `docs/DEMO_SCRIPT.md` comes from one of the metered paths below. Earlier draft notes differed because they compared tool-cache return time against end-to-end spoken audio; the canonical user-facing headline is `live` question -> first audio (`2.1 s p50 / 3.4 s p95`, rounded from `2.088 s` and `3.445 s`).

| Path | What is timed | p50 | p95 | Sample (`n`) | Source |
|---|---|---|---|---|---|
| `live` question -> first audio | End of user question to first spoken `gemini-3.8-live` audio chunk (**canonical end-to-end headline: `2.1 s p50 / 3.4 s p95`**) | 2.09 s | 3.45 s | `n = 26` live sessions | `docs/evidence/api-stats-snapshot.json` |
| `verify_cache` speculative cache hit | `Speculator.get()` answering `verify_label` from a fresh background read (or awaiting an in-flight read) | 0.00 s (`< 5 ms`) | 1.45 s | `n = 17` ok calls | `docs/evidence/api-stats-snapshot.json` |
| `verify` HTTP snapshot (`POST /api/verify`) | Single-request snapshot fallback check on `gemini-3.8-flash` | 3.80 s | 7.36 s | `n = 12` | `docs/evidence/api-stats-snapshot.json` |
| `verify_spec` background speculative Flash read | Background `gemini-3.8-flash` label read running while the user frames the box and asks | 4.73 s | 7.33 s | `n = 48` ok calls | `docs/evidence/api-stats-snapshot.json` |
| Eval single-call `verify_label` (`gemini-3.8-flash`) | Standalone structured extraction in the synthetic evaluation harness (95% bootstrap CIs in parentheses) | 3.43 s (`3.41-3.46`) | 5.55 s (`5.42-5.83`) | `n = 1,740` | `eval/results/v1_results.json` |
