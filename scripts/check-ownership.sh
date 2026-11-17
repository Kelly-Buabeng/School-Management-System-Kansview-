#!/usr/bin/env bash
# Usage: scripts/check-ownership.sh <AGENT_LETTER> [base-ref]
# Fails if the current branch changes files (vs base-ref, default: merge-base with the integration branch) outside the agent's paths.
# Shared files every agent may touch: apps/api/package.json, pnpm-lock.yaml (dependency additions only; Orchestrator resolves conflicts).
set -euo pipefail
agent="${1:?agent letter required (A-H or ORCH)}"
base="${2:-$(git merge-base HEAD claude/sweet-gauss-um4n2e 2>/dev/null || echo HEAD~1)}"
root="$(git rev-parse --show-toplevel)"
fail=0
while IFS= read -r file; do
  [ -z "$file" ] && continue
  case "$file" in apps/api/package.json|pnpm-lock.yaml|apps/web/package.json) continue ;; esac
  owner="" best=0
  while read -r prefix who; do
    [[ -z "$prefix" || "$prefix" == \#* ]] && continue
    if [[ "$file" == "$prefix"* ]] && (( ${#prefix} > best )); then owner="$who"; best=${#prefix}; fi
  done < "$root/OWNERSHIP"
  if [[ "$owner" != "$agent" && "$owner" != "ANY" ]]; then
    echo "OWNERSHIP VIOLATION: $file is owned by ${owner:-nobody (add to OWNERSHIP)}, changed by $agent"
    fail=1
  fi
done < <(git diff --name-only "$base"...HEAD)
[ $fail -eq 0 ] && echo "ownership ok for $agent"
exit $fail
