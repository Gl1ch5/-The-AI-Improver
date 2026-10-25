# AI Improver — notes for Claude Code

OpenAI-compatible proxy. A small classifier reads the latest user message, picks 0–2 guides from `server/library/*.json`, and silently adds their text plus a critique to the main model's system prompt. Optional "advisor" mode lets the main model send its plan to a reviewer through a hidden tool.

## Layout

- `server/index.js` — HTTP server, `/v1/*` (client API) and `/api/*` (admin API), static UI.
- `server/proxy.js` — request preparation, advisor round-trip, streaming. Advisor only on a fresh user turn.
- `server/classifier.js` — classifier, cache, local heuristics, sticky guides, `catalog()`.
- `server/learner.js` — learning mode: tracks sessions by first user message, digests a quiet session, writes `learned` guides; `patternGuides()` attaches a learned guide instantly when its error text appears in the latest user/tool message.
- `server/guides.js` — loads the library; classifier, advisor and learner prompts live here.
- `server/library/*.json` — the guide library (6 categories, ~118 guides). Source of truth for guide text.
- `server/config.js` — defaults, `data/config.json`, admin password, remembered IPs.
- `public/` — dependency-free admin UI (`app.js`, `style.css`). Use relative URLs only.
- `test/proxy.test.js` — spins up the server and a fake upstream. Run `npm test`.
- `bench/run.mjs` — A/B runner over public dataset samples; results in `bench/results/`.
- `deploy/` — systemd unit, installer, nginx example. Production runs from `/opt/ai-improver`.

## Commands

- `npm test` — must pass before every commit (currently 17 tests).
- Logs: `journalctl -u ai-improver` has one `[req] {json}` line per request (routing, guides, timings, 80-char preview) and one `[learn] {json}` line per analysed session.
- `node --env-file=.env server/index.js` — run locally on port 3210.

## Conventions

- No dependencies. Node 20+, ES modules, no build step.
- Guide text is English imperative bullets, 400–900 characters, no mention of "skills", "guides", "benchmarks" or the user. Russian and English keywords. Keep ids kebab-case and unique across all categories.
- The classifier catalog is ids only, grouped by category. Keep ids descriptive; custom guides carry their hint in the catalog instead.
- Token cost matters on every request: prefer deleting text to adding it, and keep the classifier prompt short.
- Admin write endpoints require `Content-Type: application/json` (CSRF guard). Keep that when adding routes.
- Never log or echo API keys or the admin password outside `data/` and `.env`.
- `TRUST_PROXY=1` must only be set behind a proxy that overwrites `X-Forwarded-For`.

## Deployment

Live at `https://grzxk.ru/improver/` behind the shared nginx. To deploy: pull the branch into `/opt/ai-improver-src` and run `deploy/install.sh`. The installer keeps `.env` and `data/`. Built-in guides follow the shipped library unless an operator edited them (`edited: true`).

## Working on this repo

- Branch: `claude/server-side-model-enhancer-zyht23`. PR #1 targets `main`.
- Commit and push after each finished change; the session stop hook checks for uncommitted and untracked files.
- Do not rewrite history on the branch. Do not commit `data/`, `.env`, or `bench/.cache/`.
