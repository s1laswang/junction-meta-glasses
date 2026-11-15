# HoldUp — Junction 2026 submission

**Challenge:** Meta AI Glasses for Everyone, Everyday.

**Short description:** HoldUp helps blind and low-vision users read labels hands-free. Gemini Live handles voice and camera input, while a separate structured reader and deterministic checks compare the label with the user's profile. When a field is unclear, it asks for a better view. The prototype includes a phone interface, glasses bridge, display view and a clearly labelled browser simulation.

| Deliverable | Link |
|---|---|
| Frozen source | https://github.com/s1laswang/junction-meta-glasses/tree/holdup-final-v1 |
| Presentation | [deck/index.html](../deck/index.html) — open locally or print to PDF |
| Demonstration video | [Browser simulation](https://github.com/s1laswang/junction-meta-glasses/raw/holdup-final-v1/docs/demo/holdup-mock-demo.mp4) |
| Stage instructions | [DEMO_SCRIPT.md](DEMO_SCRIPT.md) |
| Hardware procedure | [MORNING_BRIEF.md](MORNING_BRIEF.md) |
| Evaluation | [EVAL.md](EVAL.md) |
| Gemini integration | [GEMINI.md](../GEMINI.md) |

## Final software verification

The release combines the completed main branch with PRs #99 and #100: timezone-independent demo tests and Nordic label-matching fixes. A clean checkout passed TypeScript checks, 537 server tests, 456 web tests, and the production build. The deterministic rules evaluation passed 216 cases with no unsafe reassurances in that fixture set.

## Evidence limits for the submission

The existing video is a browser simulation, not a filmed glasses session. Device and real-user validation remain separate steps in the morning brief; only record them as complete when performed.

The fresh held-out evaluation uses 1,060 synthetic images: 1/536 confident strength reads was wrong, and 4/3,033 answers were silently over-reassuring. The older 0/754 strength-error result belongs to the earlier synthetic set. These measurements do not establish clinical safety or performance on real camera images.

## Run

Follow the repository README. For the keyless browser simulation, run `npm install && npm run dev` and open `http://localhost:5173/?mock=1`. The live reader requires a locally configured Gemini API key. For the glasses, follow the hardware procedure above.
