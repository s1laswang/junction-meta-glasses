# Separate-session briefs (paste one into each new Claude Code session)

Shared preamble for every session:
> Repo: ~/junction-aimo-team/junction-meta-glasses (GitHub s1laswang/junction-meta-glasses). Read README.md, docs/PLAN.md (§0 Push to 10, §0b scoring checklist), docs/TEAM.md and shared/types.ts (the contract; don't change it without the CEO). Work on your own branch and push it, never to main. The CEO session merges.
> Rules:
> - nothing heavy on the laptop; freighter only through Slurm with `--time`;
> - never touch ~/momin or other people's jobs;
> - never print or commit keys (.env);
> - main freezes Sun 06:00.

## 1. Server: DONE (merged Sat ~20:30, smoke 13/13, 44 tests). Remaining nice-to-haves: speculative pre-read for scene mode (5–7 s today), and a proposal-timeout message to the phone
The web side is done and on main: scene UI, DataMatrix client, add-med sheet, sonar. The server side is in progress on feat/server. Finish:
- **A. `find_item`** (scene mode): `server/src/find.ts`, `shared/find_prompt.md`, `shared/scene_schema.json`.
- **D. DataMatrix:** `server/src/gs1.ts`, the same parse as `web/src/lib/gs1.ts`; plus the crossCheck in safety.ts.
- **B. `add_medication`:** the `profile_add` / `profile_add_result` flow.
- **C. readiness messages.**

Everything stays behind `FEATURES`. Keep smoke 10/10 and the tests green, and add smoke checks for each feature. Optional: the `/hud-ws?role=stage` opt-in that forwards transcripts and metrics, for a /stage projector view.

## 2. Web: /stage projector view + final a11y pass (branch feat/web)
`/stage` is a 16:9 read-only view for the projector:
- left: the HUD replica;
- centre: big live captions, the coach cue and a readiness meter;
- right: model, latency, cache, double-checked badge, device state and flags;
- no camera images.

Build it against mock first. Then run axe plus a keyboard-only pass on every new surface, and test end to end once the server features land.

## 3. Eval: finish v1, then v2, the model comparison and the scene eval (branch: the eval worktree branch or results/*)
The local niced pipeline lives in .claude/worktrees/agent-a8cc554168821d622/eval (see its run_local.sh and /tmp/holdup-work/run_local.log). Finish predict → score → `docs/EVAL.md`.
- Every number carries n and a 95% CI (Wilson; rule of three for zero events).
- **No Batch API** (it fails silently on the shared key).
- Then: real photos in eval/real/ (Ivar), gemini-3.8-flash vs 3.5-flash vs gemma-4-31b-it on the same paired set, and the scene eval.
- Numbers go to Silas before any deck.

## 4. Pitch: deck v2 + docs/GEMINI.md (branch feat/pitch, start about 23:00)
- deck/index.html v2 per PLAN §0b (hook "Which one?", real user quote, live demo, trust incl. DataMatrix, proof with n and CI, adoption, ask).
- docs/GEMINI.md: explicit answers to the 4 DeepMind questions plus a ledger summary from /api/stats.
- Sync DEMO_SCRIPT with the new features.
- Make no claims the code doesn't support.

## CEO session (this one)
It merges branches, verifies (typecheck, tests, smoke), keeps PLAN.md current, and runs the 03:00 independent judge-persona score and the 06:00 freeze.
