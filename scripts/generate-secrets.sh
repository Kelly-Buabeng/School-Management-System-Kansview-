#!/usr/bin/env bash
# Owner: Agent H. Creates the Docker secret files in infra/secrets/ for a new installation.
# Existing files are NEVER overwritten (re-running is safe). Usage: scripts/generate-secrets.sh [secrets-dir]
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
dir="${1:-$root/infra/secrets}"
command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }
command -v age-keygen >/dev/null || { echo "age-keygen is required (apt install age)" >&2; exit 1; }
umask 077
mkdir -p "$dir"
chmod 700 "$dir"

mk() { # make <name> <command producing the value>
  local f="$dir/$1"; shift
  if [[ -s "$f" ]]; then echo "keep     $f"; return; fi
  "$@" > "$f"
  echo "created  $f"
}
pw() { openssl rand -base64 33 | tr -d '/+=\n' | cut -c1-40; }
key32() { openssl rand -base64 32; }
empty() { :; }

mk db_superuser_password pw
mk db_owner_password pw
mk db_app_password pw
mk db_backup_password pw
mk master_key key32
mk session_key key32
if [[ ! -s "$dir/backup_age_identity" ]]; then
  age-keygen -o "$dir/backup_age_identity" 2>/dev/null
  age-keygen -y "$dir/backup_age_identity" > "$dir/backup_age_recipients"
  echo "created  $dir/backup_age_identity (+ backup_age_recipients)"
else
  echo "keep     $dir/backup_age_identity"
  [[ -s "$dir/backup_age_recipients" ]] || age-keygen -y "$dir/backup_age_identity" > "$dir/backup_age_recipients"
fi
for f in rclone.conf backup_push_url offsite_push_url disk_push_url; do
  [[ -e "$dir/$f" ]] || { : > "$dir/$f"; echo "created  $dir/$f (empty: fill in to enable)"; }
done
# Containers run as unprivileged users and read their bind-mounted copy; the folder itself stays root-only.
chmod 0444 "$dir"/* 2>/dev/null || true
chmod 0400 "$dir/backup_age_identity"
cat <<'MSG'

NEXT: make the RECOVERY KIT now (see docs/operations/backup-and-recovery-runbook.md, "Recovery kit"):
  print backup_age_identity and master_key, seal them in an envelope for the school safe,
  and copy the whole secrets folder to an encrypted USB stick kept off the premises.
Without backup_age_identity the backups cannot be opened; without master_key medical/Ghana Card data cannot be read.
MSG
