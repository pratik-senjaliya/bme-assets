#!/bin/bash
# Speaks every narration line with Piper (offline TTS, https://github.com/rhasspy/piper) and writes durations.json,
# which the recorder uses to wait for each line. PIPER_DIR holds the `piper/` folder from the release tarball and the
# voice files en_US-lessac-high.onnx(.json) from huggingface.co/rhasspy/piper-voices.
set -e
HERE=$(cd "$(dirname "$0")" && pwd); OUT=${VIDEO_OUT:-$HERE/out}; A=$OUT/audio
P=${PIPER_DIR:?set PIPER_DIR to the folder with piper/ and en_US-lessac-high.onnx}
VOICE=${PIPER_VOICE:-en_US-lessac-high}
node "$HERE/mklines.mjs"
echo "{" > "$A/durations.json.tmp"; first=1
while IFS=$'\t' read -r id text; do
  echo "$text" | "$P/piper/piper" --model "$P/$VOICE.onnx" --length_scale 1.05 --sentence_silence 0.25 --output_file "$A/$id.wav" 2>/dev/null
  d=$(python3 -c "import wave;w=wave.open('$A/$id.wav');print(round(w.getnframes()/w.getframerate(),2))")
  [ $first = 1 ] && first=0 || echo "," >> "$A/durations.json.tmp"
  printf '"%s": %s' "$id" "$d" >> "$A/durations.json.tmp"
  echo "$id ${d}s"
done < "$A/lines.tsv"
echo "}" >> "$A/durations.json.tmp"; mv "$A/durations.json.tmp" "$A/durations.json"
echo "Voice ready: $(ls "$A"/*.wav | wc -l) lines"
