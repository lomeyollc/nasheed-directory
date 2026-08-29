#!/usr/bin/env bash
# Poll archive.org until its API answers again, then resume expansion.
#
# archive.org rate-limits sustained harvesting by dropping requests to its main
# host entirely — connections to archive.org time out while the ia*.us.archive.org
# download servers keep serving 200s. The block is not tied to User-Agent and
# does not respond to backoff within a run; it simply has to expire.
#
# Expansion is the only stage that needs the blocked host, and it is the stage
# that multiplies the candidate pool most, so it is worth resuming the moment
# the block lifts rather than on the next time someone looks.
set -uo pipefail
cd "$(dirname "$0")/.."

while true; do
  if curl -sS -m 15 -o /dev/null "https://archive.org/metadata/nasa" 2>/dev/null; then
    echo "$(date '+%H:%M:%S') archive.org is answering — resuming expansion"
    python3 tools/expand.py >> tools/work/expand-resumed.log 2>&1
    echo "$(date '+%H:%M:%S') expansion pass finished"
    sleep 300
  else
    echo "$(date '+%H:%M:%S') still blocked"
    sleep 600
  fi
done
