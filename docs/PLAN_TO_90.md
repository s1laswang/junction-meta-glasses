# HoldUp: plan to 90/100 (written Sun 15 Nov 05:05, submission 10:00)

## Where we are, honestly
Three independent reviews tonight scored HoldUp **68, 76 and 84**. The harshest one (68, a fresh clone at `b34c1ca`) is the one to plan against:

| Criterion | Score at `b34c1ca` | Main reason for lost points |
|---|---|---|
| Creativity | 19/25 | The signature moments exist in code but nobody has seen them on glasses |
| Technical | 16/25 | No proof it runs on glasses; 7 safety probes gave an unsafe "Yes" |
| Value and feasibility | 15/25 | Eval is synthetic, self-graded and in-sample; 0 real photos; 0 users |
| UX, accessibility, trust | 18/25 | Spoken answer not enforced; 3 small layout bugs; no real screen-reader run |

**Already fixed since that review** (all on main, `216807c`): all 7 unsafe probes (now regression tests), the red-team guards (199 → 13 unsafe on 2,264 adversarial images), deck wording ("built for" glasses until proven), per-image predictions committed. Estimated standing now: **about 73–75** on that judge's scale.

## The gap to 90, in points
| # | Item | Points | Who | When |
|---|---|---|---|---|
| 1 | **Glasses proof**: H1–H4 on real glasses, one third-person video, probe rows in `docs/HARDWARE_LOG.md`, video link on slide 5 | +5 to +7 | Silas + Momin | 08:00–09:00 |
| 2 | **Real photos**: 20–30 photos of real Finnish packs, human-labelled, scored separately | +2 to +3 | Ivar shoots, Claude scores | photos by 08:30 |
| 3 | **Live "dose finder" moment**: FieldSpotter wired into coaching ("something is covering the dose", "move it left") with a box on the HUD | +2 to +3 | Claude | tonight, cut line 07:00 |
| 4 | **Held-out safety number**: eval v3 on fresh packs (not the ones the rules were tuned on) | +1 to +2 | Gemini session (WS4), Claude merges | PR by 05:30 |
| 5 | **Spoken answer checked**: compare what Gemini said with the rule's sentence; on any mismatch of level, name or number, correct it aloud and log it | +1 | Claude | tonight |
| 6 | **Layout polish**: Stop bar over verdict buttons at 390×844, clipped stage caption, Privacy switch touch target | +1 | Claude | tonight |
| 7 | **One real person**: a low-vision user or a Meta mentor tries it for 10 minutes, one quote; one TalkBack pass on a real phone | +1 to +2 | Chintufp + Ivar | 08:00–09:30 |

Items 3–6 are code and can be done while people sleep: they take us to **about 79–82**. Items 1, 2 and 7 need people and hardware: they take us to **about 88–91**. Without item 1, 90 is out of reach.

## Overnight order (Claude, 05:10–07:45)
1. Item 6 (30 min), then item 5 (45 min), then item 3 until 07:00. Each lands behind a flag with tests; anything not solid by its cut time is left out.
2. Merge pull requests as they arrive: demo-states video (M2), liability slide (M3), eval v3 (WS4).
3. 07:15: one-command helpers for the morning (below). 07:30: fresh-clone check (typecheck, server tests twice, web tests, `server/scripts/judge-probe.ts`, live smoke).
4. 07:45: write `docs/MORNING_BRIEF.md` with results and the final checklist.

## 08:00 checklist for Silas (the +5 to +7)
1. `cd ~/junction-aimo-team/junction-meta-glasses && git pull`
2. `bash scripts/hw-session.sh` (starts the server and one tunnel with an access key, prints the three URLs to open).
3. Phone: open the printed phone URL, Profile → Load demo profile, pair the glasses as the Bluetooth headset.
4. Momin: `adb install -r /tmp/holdup-bridge-debug.apk`, paste the printed bridge URL, Connect glasses → Start streaming.
5. Run steps H1–H4 from `docs/HARDWARE_LOG.md`. After each: `bash scripts/hw-session.sh probe "H1"` (appends an evidence row).
6. Film one take from the side: box held label-away → coaching heard → "Yes, Amlodipine 5 mg" → cover the dose with a thumb → "not sure". AirDrop the clip to the laptop; Claude links it on slide 5 and restores "runs on Ray-Ban Meta".
7. Ivar: drop real-pack photos in `eval/real/` with one row each in `labels.csv`; then `bash eval/score_real.sh`.
8. 09:30: submit (Meta challenge, plus Gemini, Gemma and Verda tracks with `GEMINI.md`, `GEMMA.md`, `docs/evidence/verda-fieldspotter.md`).
