#!/usr/bin/env bash
# Run the whole pipeline in a loop until the catalog reaches a target size.
#
#     tools/fill.sh 100          # fill to 100 published tracks
#     tools/fill.sh 100 --remote # publish to production
#
# Every stage is resumable and idempotent — expand skips items it has already
# expanded, screen skips tracks it has already analysed, transcribe skips
# tracks that already have lyrics, and publish skips tracks already uploaded.
# So this can be interrupted at any point and re-run without losing work or
# duplicating a track.
#
# Ordering matters. Expansion multiplies the candidate pool (an archive.org
# album is dozens of recordings, not one), screening is download-bound so it
# runs several workers wide, and transcription is the slowest stage per track
# so it only ever runs on tracks screening has already called voice_only.
#
# archive.org throttles hard and unpredictably. Every stage retries and
# checkpoints rather than failing the run, so the loop makes progress even
# through a bad patch — it just makes less of it that round.

set -uo pipefail
cd "$(dirname "$0")/.."

TARGET="${1:-100}"
REMOTE="${2:-}"
VENV="tools/.venv/bin/python"
SCREEN_WORKERS=4
TRANSCRIBE_WORKERS=2

published_count() {
  python3 - <<'PY'
import json, pathlib
state = pathlib.Path("tools/work/published.json")
print(len(json.loads(state.read_text())) if state.exists() else 0)
PY
}

round=0
while true; do
  round=$((round + 1))
  have=$(published_count)
  echo ""
  echo "=============================================================="
  echo " round $round — $have / $TARGET published"
  echo "=============================================================="

  if [ "$have" -ge "$TARGET" ]; then
    echo "target reached"
    break
  fi

  # 1. Multiply the candidate pool. Bounded per round so a slow metadata
  #    endpoint cannot stall the loop before any screening happens.
  echo "--- expanding albums ---"
  timeout 900 python3 tools/expand.py --limit 60 2>&1 | tail -3

  # 2. Screen, several workers wide on disjoint shards.
  echo "--- screening ---"
  for i in $(seq 0 $((SCREEN_WORKERS - 1))); do
    timeout 1800 "$VENV" tools/screen.py --shard "$i/$SCREEN_WORKERS" --limit 120 \
      > "tools/work/fill-screen-$i.log" 2>&1 &
  done
  wait
  grep -h '^  ->' tools/work/fill-screen-*.log 2>/dev/null | wc -l | xargs echo "  newly screened:"

  # 3. Transcribe whatever screening newly called voice_only.
  echo "--- transcribing ---"
  for i in $(seq 0 $((TRANSCRIBE_WORKERS - 1))); do
    timeout 1800 python3 tools/transcribe.py --shard "$i/$TRANSCRIBE_WORKERS" --limit 60 \
      > "tools/work/fill-transcribe-$i.log" 2>&1 &
  done
  wait

  # 4. Publish everything that clears every automated check.
  echo "--- publishing ---"
  python3 tools/publish.py --auto $REMOTE 2>&1 | tail -4

  after=$(published_count)
  if [ "$after" -eq "$have" ]; then
    echo "  no progress this round"
    : $((stalled = ${stalled:-0} + 1))
    # Three rounds with nothing new means the candidate pool is exhausted at
    # the current automated bar. Stop rather than spin: what is left needs
    # either more harvesting or a human ear, and neither is this script's job.
    if [ "${stalled:-0}" -ge 3 ]; then
      echo ""
      echo "stopped: three rounds with no new tracks."
      echo "The remaining candidates need either a wider harvest or human review."
      break
    fi
  else
    stalled=0
  fi
done

echo ""
echo "final: $(published_count) tracks published"
