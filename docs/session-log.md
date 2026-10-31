# Session log

What each working session (Claude Code on the laptop, claude.ai/code, the Claude mobile app) did, decided and left
open, newest first. It carries context from one session to the next: the code and `git log` say *what* changed, this
says *why*, what was agreed with the team, and what is still pending.

**Every session:** read `CLAUDE.md`, then the latest entries here. Before finishing (or before pushing), add an entry at
the top: date, branch, what was done, decisions, open items. Keep each entry short; move anything lasting into
`CLAUDE.md` (Status), `CHANGELOG.md` or the docs in `docs/`. Never write passwords or other secrets here.

## Open items (keep this list current)

- Open decisions from the reviews: failed calibration due date, super admin creating admins, block vs warn duplicate
  complaints (see `CLAUDE.md` Status, review round 3).
- PDFs in Gujarati/Hindi need Noto Sans Gujarati / Devanagari fonts added (known limit, `reports.export.ts`).
- Walkthrough video: the voice is English (Piper `en_US-lessac-high`). Gujarati or Hindi narration, a shorter cut
  (e.g. 3–5 min for management) or a different voice were offered and not yet asked for.
- `tools/walkthrough-video` was made portable after the videos were recorded (fixed ids replaced by lookups, paths
  from the environment); it is syntax-checked but has not been run end to end since. Do a `FAST=1` dry run first.

## 2026-10-31 · branch `walkthrough-video` (merged into `main`) · Walkthrough video for meetings

- Made the product walkthrough video for stakeholder meetings, like the earlier Site Diary walkthrough: 1920×1080
  recording of the desktop web app (not phones, as asked), production build (no dev-server compile time), full demo
  hospital, captions on every step. Two files on the laptop's Desktop: `BME-Assets-Walkthrough.mp4` (13 min, captions)
  and `BME-Assets-Walkthrough-Voice.mp4` (12 min 45 s, captions + English voice-over). Not in git (too large).
- Covers every module in four parts (HOD overview, engineer's day, one complaint end to end, HOD control); the full
  list is in `tools/walkthrough-video/README.md`.
- The tooling is now in `tools/walkthrough-video/` (scripts, narration text, how to re-make it).
- Decisions: recorded against a separate database `bme_video` with its own servers on :3100 / :4100 so the working
  `bme` database was never touched (dropped again afterwards). `prisma migrate reset` is refused when an AI runs it,
  so the scripts use `migrate deploy` on a new, empty database instead. Voice by Piper because npm/PyPI downloads were
  ~20 KB/s on this network (GitHub and HuggingFace fast); Kokoro was dropped.
- Added this session log and the "keep the log" rule in `CLAUDE.md`, so sessions on other devices start with context.
- No app code or API changed; version stays 1.6.1.
