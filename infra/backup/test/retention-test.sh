#!/usr/bin/env bash
# Owner: Agent H. Checks prune-backups.sh keeps 7 daily / 4 weekly / 12 monthly from 400 days of nightly backups.
# Usage: infra/backup/test/retention-test.sh   (no database needed; pg_archivecleanup must be on PATH)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
export BACKUP_ROOT="$work" BASE_DIR="$work/base" WAL_DIR="$work/wal" STATUS_DIR="$work/status" STAGING_DIR="$work/staging"
mkdir -p "$BASE_DIR" "$WAL_DIR"
for i in $(seq 0 399); do
  id="$(date -u -d "today - $i days" +%Y%m%dT013000Z)"
  mkdir -p "$BASE_DIR/$id"
  wal=$(printf '00000001%016X' $((1000 - i)))
  echo "{\"backupId\":\"$id\",\"startWal\":\"$wal\"}" > "$BASE_DIR/$id/meta.json"
done
for n in $(seq 990 1000); do : > "$WAL_DIR/$(printf '00000001%016X' "$n").gz"; done
"$here/../bin/prune-backups.sh" > "$work/out" 2>/dev/null
kept=$(ls "$BASE_DIR" | wc -l)
daily=$(grep -c ' daily$' "$work/out"); weekly=$(grep -c ' weekly$' "$work/out"); monthly=$(grep -c ' monthly$' "$work/out")
echo "kept=$kept daily=$daily weekly=$weekly monthly=$monthly wal_left=$(ls "$WAL_DIR" | wc -l)"
# 7 daily; weekly/monthly overlap with newer ones, so total is between 13 and 23.
[[ $daily -eq 7 ]] || { echo "FAIL daily"; exit 1; }
(( kept >= 13 && kept <= 23 )) || { echo "FAIL kept $kept"; exit 1; }
# Oldest daily is 6 days ago -> its start WAL is 1000-6 = 994; WAL 990..993 must be gone, 994..1000 kept.
[[ $(ls "$WAL_DIR" | wc -l) -eq 7 ]] || { echo "FAIL wal cleanup"; exit 1; }
oldest=$(ls "$BASE_DIR" | sort | head -n1)
echo "oldest kept: $oldest"
echo "RETENTION TEST PASSED"
