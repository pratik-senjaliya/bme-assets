# Walkthrough video

Records the product walkthrough video shown in meetings: a 1920×1080 screen recording of the desktop web app with a
caption bar, an animated cursor, highlight boxes, chapter cards and (optionally) an English voice-over. About 13
minutes, four parts:

1. **The HOD's overview:** sign in, Today dashboard, search, the machine's page and its tabs, the register, QR labels and
   PMS stickers, Add asset, Import from Excel.
2. **The engineer's day:** My work, Due & overdue, a PMS done live (server-dated, read-only), OEM PMS, calibration.
3. **One complaint, start to finish:** the nurse raises it, the HOD assigns it, the engineer starts and resolves it
   with a spare-part cost, the nurse closes it, complaint history.
4. **Staying in control:** approvals and condemnation, consumables, suppliers, logbook, licences, reports, monthly
   report, audit pack, notifications, users and roles, setup, audit log, hospital settings, dark mode.

The last videos made (31 Oct 2026, version 1.6.1) are not in git (60–80 MB):
`BME-Assets-Walkthrough.mp4` (captions only) and `BME-Assets-Walkthrough-Voice.mp4` (captions + voice).

## Files

| File | What it does |
|---|---|
| `lines.mjs` | Every step's caption title and spoken text. Change the words here. |
| `walk.mjs` | The walkthrough itself: parts `p1a p1b p1c p2 p3 p4a p4b p4c p4d p4e`, each a few recorded segments. |
| `kit.mjs` | Browser, overlay (caption, cursor, cards, highlight), Chrome screencast recording, narration timing. |
| `build.mjs` | Frames + narration timings → one MP4 per segment (voice placed where each line started) → joined video. |
| `mklines.mjs` | Writes `out/audio/lines.tsv`, the text as it should be spoken (HOD → "H O D", PMS → "P M S", …). |
| `gen-voice.sh` | Speaks each line with Piper and writes `out/audio/durations.json`. |
| `setup.sh` / `stop.sh` | Separate demo database `bme_video` + production servers on :3100 / :4100; stop and drop it. |
| `record.sh` | Records all parts five at a time, then builds the video. |

## Making the video

Needs: the dev Postgres container (`npm run db:up`), a production build (`npm run build` from the repo root, so no
compile time shows in the video), a Chrome or Playwright Chromium, and ffmpeg (`FFMPEG=/path/to/ffmpeg` if not on the
PATH).

```bash
cd tools/walkthrough-video
PIPER_DIR=~/piper ./gen-voice.sh          # optional: voice-over (skip it for a captions-only video)
./setup.sh                                 # demo hospital in bme_video, servers on :3100 / :4100
./record.sh ~/Desktop/BME-Assets-Walkthrough-Voice.mp4
./stop.sh
```

- **Every take needs a fresh `./setup.sh`:** the walkthrough raises and closes a complaint, records a PMS, approves a
  request, gives out stock and takes a reading. A second run on the same data fails (the PMS is no longer due, the
  request is already decided). Re-recording one part: `./setup.sh`, then `node walk.mjs p2` and `node build.mjs`.
- **Dry run:** `FAST=1 node walk.mjs` drives every step with short waits and records nothing; good after a UI change.
- **Pacing:** with `out/audio/durations.json` each step lasts as long as its spoken line (+0.6 s); without it, as long
  as reading the caption takes (words ÷ 2.5 s). Actions run during the line.
- **Voice:** Piper (offline, https://github.com/rhasspy/piper, the `piper_linux_x86_64.tar.gz` release) with the
  `en_US-lessac-high` voice from `huggingface.co/rhasspy/piper-voices` (en/en_US/lessac/high). npm and PyPI downloads
  were very slow on the office network (20 KB/s) while GitHub and HuggingFace were fast, so Kokoro (`kokoro-js`, needs
  the 200 MB `onnxruntime-node`) was given up. Claude Code's auto mode will not run a downloaded binary: run
  `gen-voice.sh` yourself (`! PIPER_DIR=… ./gen-voice.sh` in Claude Code).
- **Selectors** are taken from the screens as they are (button names, `.ant-modal`, table rows by asset ID). After a
  UI change, run the dry run and fix what fails; a failing step saves `out/fail-<part>.png`.
- Demo data used: ICU Ventilator A / B, Bedside Monitor ICU-2 (the complaint), Bedside Monitor ICU-3 (the live PMS),
  ECG electrodes (give out), the DG diesel level reading, the key-field edit and condemnation requests, the condemned
  Ward Monitor. If `seedDemo.ts` changes these, change `walk.mjs`.
