#!/usr/bin/env bash
# Usage: scripts/check-ownership.sh <AGENT_LETTER|auto> [base-ref]
# Fails if the current branch changes files (vs base-ref) outside the agent's paths in /OWNERSHIP.
#   base-ref default: merge-base with origin/main (falls back to main, then HEAD~1).
#   AGENT "auto": derive the agent from the branch name prefix (BRANCH_NAME env or the current branch), see map below.
# Shared files every agent may touch: apps/api/package.json, apps/web/package.json, pnpm-lock.yaml (dependency additions).
set -euo pipefail
agent="${1:?agent letter required (A-H, ORCH or auto)}"
root="$(git rev-parse --show-toplevel)"

if [[ "$agent" == "auto" ]]; then
  branch="${BRANCH_NAME:-$(git rev-parse --abbrev-ref HEAD)}"
  case "$branch" in
    database-*) agent=A ;;
    backend-core-*|students-*|promotion-*|attendance-*) agent=B ;;
    finance-*) agent=C ;;
    security-*|auth-*) agent=D ;;
    frontend-*|web-*) agent=E ;;
    notifications-*|documents-*) agent=F ;;
    imports-*) agent=G ;;
    devops-*|e2e-*|system-*) agent=H ;;
    contracts-*|scaffold-*|devtools-*|docs-*|orchestrator-*) agent=ORCH ;;
    *) echo "ownership: cannot tell the owner of branch '$branch' from its name; run with an explicit agent letter" >&2; exit 2 ;;
  esac
  echo "ownership: branch '$branch' -> agent $agent"
fi

if [[ -n "${2:-}" ]]; then
  base="$(git merge-base HEAD "$2")"
else
  base="$(git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main 2>/dev/null || git rev-parse HEAD~1)"
fi

# The Orchestrator may change anything.
if [[ "$agent" == "ORCH" ]]; then echo "ownership ok for ORCH"; exit 0; fi

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
done < <(git diff --name-only "$base" HEAD)
[ $fail -eq 0 ] && echo "ownership ok for $agent"
exit $fail
