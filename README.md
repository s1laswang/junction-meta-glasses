# HoldUp: hold it up, know it's the right one

Hands-free label assistant for blind and low-vision people on **Meta AI glasses**, powered by **Gemini Live**.
Hold up a medicine box or a food package. HoldUp coaches you until the label is readable, reads it with per-field confidence, checks it against *your* medication list and allergies (stored on your device only), and tells you whether it's the right one. It never guesses a dose.

Junction 2026 · Meta "AI Glasses for Everyone, Everyday" · Google DeepMind "Best Use of Gemini API".

## Run (one command)
```bash
cp .env.example .env   # add GEMINI_API_KEY
npm install && npm run dev
```
Open http://localhost:5173 on the laptop. For a phone or the glasses you need HTTPS: run `npm run tunnel` and open the printed `https://…trycloudflare.com` URL (production build: `npm start`).

## Docs
- [docs/PLAN.md](docs/PLAN.md): idea, architecture, demo script, hardware plan, timeline
- [docs/TEAM.md](docs/TEAM.md): roles, interfaces, milestones
