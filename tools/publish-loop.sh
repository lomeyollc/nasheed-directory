#!/usr/bin/env bash
# Publish repeatedly until nothing new qualifies.
#
# One publish pass only handles the tracks that qualified when it started;
# screening and transcription keep adding more while it runs. Rather than
# guess when to run it again, loop until a pass adds nothing.
set -uo pipefail
cd "$(dirname "$0")/.."

count() { python3 -c "
import json, pathlib
p = pathlib.Path('tools/work/published.json')
print(len(json.loads(p.read_text())) if p.exists() else 0)"; }

for round in $(seq 1 12); do
  # Wait on the LOCK FILE, not on pgrep.
  #
  # `pgrep -f "publish.py --auto"` matched any shell command whose text merely
  # contained that string — including a monitoring one-liner running in another
  # terminal. The loop then waited forever for a publisher that did not exist,
  # printing nothing, looking exactly like a slow publish.
  #
  # publish.py already writes a pid lock and detects a stale one, so use it.
  while [ -f tools/work/publish.lock ] \
        && kill -0 "$(cat tools/work/publish.lock 2>/dev/null)" 2>/dev/null; do
    sleep 30
  done
  rm -f tools/work/publish.lock

  before=$(count)
  echo "--- round $round: $before published ---"
  python3 -u tools/publish.py --auto --remote 2>&1 | grep -E "accepted|committed|! " | tail -6
  after=$(count)
  echo "    $before -> $after"
  [ "$after" -le "$before" ] && { echo "no new tracks; stopping"; break; }
done
echo "final: $(count)"
