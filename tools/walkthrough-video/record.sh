#!/bin/bash
# Records every segment, five at a time (each part has its own logins and data), then builds the video.
# Usage: ./record.sh <output.mp4>     Needs setup.sh run just before; voice optional (gen-voice.sh).
set -e
HERE=$(cd "$(dirname "$0")" && pwd); OUT=${VIDEO_OUT:-$HERE/out}; cd "$HERE"
rm -rf "$OUT/seg" "$OUT"/part-*.mp4
node walk.mjs p1a p1b p1c > "$OUT/r1.log" 2>&1 & node walk.mjs p2 > "$OUT/r2.log" 2>&1 &
node walk.mjs p3 > "$OUT/r3.log" 2>&1 & node walk.mjs p4a p4b > "$OUT/r4.log" 2>&1 &
node walk.mjs p4c p4d p4e > "$OUT/r5.log" 2>&1 &
wait
grep -hE "segment|FAIL" "$OUT"/r?.log | sort
if grep -q FAIL "$OUT"/r?.log; then echo "a part failed: see $OUT/r?.log and $OUT/fail-*.png; run ./setup.sh again before retrying"; exit 1; fi
node build.mjs "${1:-$OUT/walkthrough.mp4}"
