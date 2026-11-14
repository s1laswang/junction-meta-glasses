# HoldUp hardware proof log

Purpose: evidence, for the Technical execution criterion, that HoldUp runs on **real Meta glasses**. Every row needs a time (Helsinki), who saw it, the device, a pass or fail, and an evidence file. Evidence files go in `docs/img/hw/` (photos, screen recordings) or are pasted inline (probe output).
Machine-readable rows come from `npm -w server run hw:probe -- --base https://<tunnel> --label "<step>"`, which reads `/api/health` (Gemini, session, and the new `glasses` block: camera source, device state, glasses frames accepted) and `/api/stats` (latency) and appends a row to this file.

## Setup used
| Field | Value |
|---|---|
| Date and time (Helsinki) | |
| Glasses model and firmware (Meta AI → Devices) | Ray-Ban Meta Gen 2 / Ray-Ban Display, fw V… |
| Meta AI app version | |
| Phone (model, Android version) | |
| HoldUp Bridge APK sha256 | `164dea1b…` (HARDWARE_NOTES, Sat 19:03) or a new build |
| Server commit (`git rev-parse --short HEAD`) | |
| Tunnel URL (no key) | https://….trycloudflare.com |
| Network (venue Wi-Fi / hotspot) | |

## Checklist (test slot 1 and the Sun 06:30 re-run)
| # | Step | Pass when | Evidence to capture | Result | Time | Who |
|---|---|---|---|---|---|---|
| H1 | Meta CameraAccess sample streams | live glasses video in the sample app | phone screen recording, 5 s | | | |
| H2 | HoldUp Bridge streams to the server | "Frames sent" rises, last HTTP 204, worn/battery shown | bridge screenshot + probe row | | | |
| H3 | Phone app uses the glasses camera | "Using glasses camera"; the device panel shows connected, worn, battery | phone screenshot + probe row | | | |
| H4 | Label facing away → coaching → MATCH, heard in the glasses speakers | coaching cue, then "Yes, Amlodipine 5 mg…" | **third-person video** (the wearer, the box and the phone mirror in one shot) + probe row with first-audio time | | | |
| H5 | "I took it", then the same box again | a WARNING: "already taken today" | video | | | |
| H6 | Ibuprofen → WARNING (NSAID); strength taped over → NOT SURE | the matching cards | video | | | |
| H7 | Display HUD shows the verdict on the lens; Neural Band "I took it" logs a dose | the card on the lens; the dose appears in the phone's log | photo through the lens (phone camera held against the lens) + the phone's dose log | | | |
| H8 | Glasses off → phone camera | alert earcon + the source switches | video + probe row (`worn:false`) | | | |
| H9 | Phone camera + airplane mode (Bluetooth on) → offline barcode | "You're offline…", then a barcode verdict | video | | | |
| H10 | Airplane mode off → back to live | "Live assistant connected" within ~10 s | video | | | |

## Probe rows (appended by `hw:probe`)
| Time (Helsinki) | Label | Gemini | Sessions / latest | Camera source: connected, worn, streaming, battery; glasses frames | live first-audio p50 / p95 s | verify p50 / p95 s |
|---|---|---|---|---|---|---|
