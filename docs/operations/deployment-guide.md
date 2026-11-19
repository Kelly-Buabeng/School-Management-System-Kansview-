# Deployment guide

Owner: Agent H. For the person who installs and looks after the Kansview School Management System server.
Written for a technically confident helper (an IT technician or a teacher who is good with computers).

> **Local development is different.** Developers run `./dev.sh` at the repository root (one command: database,
> migrations, seed, API, worker and web app). `infra/compose/docker-compose.dev.yml` only gives a PostgreSQL 18
> container for developers who want the production database version. Neither is for the school's server.

## 1. What runs where

One server runs everything with Docker Compose (`infra/compose/docker-compose.yml`):

| Service | What it does | Always on? |
|---|---|---|
| `caddy` | Web address, HTTPS certificate, security headers, serves the web app, forwards `/api` | yes |
| `api` | The application (staff sign in here) | yes |
| `worker` | Background jobs: SMS sending, PDFs, housekeeping (old sessions and reset tokens) | yes |
| `migrate` | Updates the database structure, then stops | runs at each start |
| `postgres` | PostgreSQL 18 database | yes |
| `backup` | Nightly encrypted backup, WAL archive check, off-site copy, disk check | yes |
| `clamav` | Virus scanning of uploads (profile `clamav`) | recommended on 8 GB |
| `uptime-kuma` | Monitoring dashboard and alerts (profile `monitoring`) | recommended |

Two layouts are supported with the same files:

- **A. On-premise mini server (recommended, CR-0002).** Works when the internet is down. Needs a UPS.
- **B. Cloud VM.** No hardware to look after, but staff cannot work during an internet outage.

### Hardware (A)

- 4 CPU cores, 8 GB RAM, 256 GB SSD for the system, **a second disk (SSD or HDD, ≥ 500 GB) for backups**.
  2 cores / 4 GB works with ClamAV off (`SMS_CLAMAV_ENABLED=false`, no `clamav` profile; lower `shared_buffers` to 1GB in
  `infra/postgres/postgresql.conf`).
- UPS with at least 30 minutes and a USB data cable (for automatic clean shutdown, section 8).
- Wired network connection to the school router.

### Cloud VM (B)

Same size (4 vCPU / 8 GB), Ubuntu 24.04 LTS, a second volume attached for backups, provider snapshots enabled
as an extra layer, a public DNS name pointing at the VM.

## 2. Install the operating system

1. Ubuntu Server 24.04 LTS. During installation choose **"Use an entire disk" + "Encrypt the LVM group with LUKS"**
   (full-disk encryption). Write the LUKS passphrase into the recovery kit (runbook section "Recovery kit").
   - On-premise: someone must type the passphrase after every power cut, *or* enable automatic unlock with the
     TPM (`sudo systemd-cryptenroll --tpm2-device=auto /dev/<disk>`). TPM unlock protects a stolen disk, not a stolen
     whole server; choose with the proprietor and record the decision.
   - Cloud: use the provider's encrypted volumes (on by default at most providers) in addition.
2. Encrypt the backup disk too:
   ```bash
   sudo cryptsetup luksFormat /dev/sdb          # passphrase -> recovery kit
   sudo cryptsetup open /dev/sdb sms-backup
   sudo mkfs.ext4 -L sms-backup /dev/mapper/sms-backup
   echo 'sms-backup /dev/sdb none luks,discard' | sudo tee -a /etc/crypttab   # or a key file on the encrypted system disk
   echo 'LABEL=sms-backup /srv/sms-backup ext4 defaults,nofail 0 2' | sudo tee -a /etc/fstab
   sudo mkdir -p /srv/sms-backup && sudo mount -a
   ```
3. Time zone and clock (receipts, attendance and audit times depend on it):
   ```bash
   sudo timedatectl set-timezone Africa/Accra
   sudo timedatectl set-ntp true          # systemd-timesyncd; check with: timedatectl status
   ```
   On the LAN with no internet, the clock drifts slowly; the router can usually act as an NTP server, otherwise check the
   time monthly.
4. Updates: `sudo apt update && sudo apt full-upgrade -y`, then `sudo apt install -y unattended-upgrades docker.io
   docker-compose-v2 age git ufw nut` (or Docker's own repository for the newest Docker Engine).
   `sudo systemctl enable --now docker` so the system starts after every power cut.
5. Firewall:
   ```bash
   sudo ufw default deny incoming
   sudo ufw default allow outgoing
   sudo ufw allow 22/tcp      # SSH (on-premise: only from the office network, e.g. 'from 192.168.1.0/24')
   sudo ufw allow 80/tcp
   sudo ufw allow 443/tcp
   sudo ufw enable
   ```
   Docker publishes only ports 80 and 443 (and Uptime Kuma on 127.0.0.1:3001). The database is never published.
   SSH: key-only login (`PasswordAuthentication no` in `/etc/ssh/sshd_config`).

## 3. First-run steps

```bash
sudo git clone <repository URL> /opt/kansview-sms && cd /opt/kansview-sms
git checkout <release tag>                      # e.g. v1.0.0, never an untested branch

# 1. secrets (passwords, encryption keys) -> infra/secrets/  (run as root)
sudo scripts/generate-secrets.sh
#    MAKE THE RECOVERY KIT NOW (runbook). Without it, backups cannot be opened.

# 2. backup disk folders (postgres container user is uid 999, the api reads status files)
sudo install -d -o 999 -g 999 -m 0750 /srv/sms-backup /srv/sms-backup/{base,wal,offsite-staging}
sudo install -d -o 999 -g 999 -m 0755 /srv/sms-backup/status
sudo chmod 0755 /srv/sms-backup

# 3. settings
cp infra/.env.example infra/compose/.env
nano infra/compose/.env       # SMS_DOMAIN, SMS_TLS, SMS_BACKUP_DIR, RCLONE_REMOTE (section 5)

# 4. build and start
cd infra/compose
sudo docker compose build
sudo docker compose --profile clamav --profile monitoring up -d
sudo docker compose ps        # all "healthy"; migrate "exited (0)"
```

5. Open `https://<SMS_DOMAIN>` and sign in with the first administrator account (created by the Orchestrator's
   first-admin procedure in the user manual), enrol MFA, then create staff accounts.
6. Take the first backup at once and check it: `sudo scripts/backup-now.sh`.
7. Set up monitoring (monitoring guide) and do a restore drill within the first month.

### Addresses and certificates

- **LAN (A):** pick a name such as `sms.kansview.lan`. Make the school router's DNS answer it with the server's fixed
  IP (DHCP reservation). Keep `SMS_TLS=internal`: Caddy runs its own certificate authority. Install its root
  certificate once on every staff laptop and phone so the browser trusts it:
  ```bash
  sudo docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./kansview-root.crt
  ```
  (Windows: double-click → Install → "Trusted Root Certification Authorities"; Android: Settings → Security →
  Install certificate → CA; iPhone: open the file, then Settings → General → About → Certificate Trust Settings.)
  The `caddy_data` volume holds this CA: if it is lost, devices must trust a new one.
- **Cloud (B):** `SMS_DOMAIN=sms.example.edu.gh`, `SMS_TLS=<admin e-mail>`. Ports 80 and 443 must be reachable from the
  internet for Let's Encrypt.

### Security headers

Caddy sends HSTS (1 year), a strict Content-Security-Policy (scripts only from the server itself; inline `<style>`
allowed because the UI library needs it, see `SMS_CSP_STYLE_SRC`), `X-Frame-Options: DENY`, `nosniff`,
`Referrer-Policy: no-referrer`, a restrictive `Permissions-Policy` (camera only for the app itself), request-size
limits (1 MB for normal requests, 12 MB for uploads) and long caching only for content-hashed files.

### Client IP addresses

The API is reached only through Caddy. Caddy replaces any `X-Forwarded-For` header with the address it saw, and
the API trusts exactly that one hop (`SMS_TRUST_PROXY: "1"` in `docker-compose.yml`). Login and reset rate limits,
audit events, sessions and login attempts therefore record each staff device's own address. Do not publish the
`api` container's port or put another proxy in front of Caddy without changing both settings (Caddy
`trusted_proxies` and `SMS_TRUST_PROXY`). Check: `infra/caddy/test/client-ip-test.sh` (needs `caddy`, `node`, `curl`).

## 4. Configuration reference (infra/compose/.env)

See `infra/.env.example` for every variable with comments. Secrets are never in `.env`: they are files in
`infra/secrets/` (see its README) mounted as Docker secrets. The api connects as `sms_api` (a login member of the
`sms_app` role, never a superuser); migrations run as `sms_owner`; backups as `sms_backup` (replication + read-only).
pg-boss keeps its queue in the `pgboss` schema, created at first start and owned by `sms_api`.

## 5. Off-site backups

1. Create a bucket at an S3-compatible provider (Backblaze B2, Wasabi, AWS S3, Cloudflare R2). Turn on object lock /
   versioning if offered, so a mistake cannot delete old copies.
2. Create an access key limited to that bucket.
3. Put the rclone configuration in `infra/secrets/rclone.conf` (root-only):
   ```ini
   [offsite]
   type = s3
   provider = Other          # or AWS, Wasabi, Cloudflare ...
   access_key_id = <key id>
   secret_access_key = <secret>
   endpoint = <provider endpoint>
   ```
4. In `.env`: `RCLONE_REMOTE=offsite:<bucket-name>`; then `sudo docker compose up -d backup`.
Everything sent off-site is already encrypted with the backup key; the provider never sees school data.

## 6. Auto-start, logs and housekeeping

- Every long-running service has `restart: unless-stopped`; Docker starts at boot, so the system comes back after a
  power cut without anyone logging in. PostgreSQL recovers itself from its WAL; payments shown as "Saved" are kept.
- Container logs: JSON files rotated by Docker (10 MB × 5 per service). Read with `sudo docker compose logs --tail 200 api`.
- The worker deletes expired sessions (30 days after expiry), used/expired password-reset tokens (after 7 days) and,
  once the database provides `app.purge_login_attempts` (CR-0009), login attempts older than 180 days.

## 7. Upgrades

See `upgrade-procedure.md`.

## 8. UPS and clean shutdown (on-premise)

A clean shutdown protects the disks and avoids a long recovery. With a USB UPS and Network UPS Tools (NUT):

```bash
sudo apt install nut
# /etc/nut/nut.conf
MODE=standalone
# /etc/nut/ups.conf
[ups]
  driver = usbhid-ups
  port = auto
  desc = "Server UPS"
# /etc/nut/upsd.users
[upsmon]
  password = <random>
  upsmon primary
# /etc/nut/upsmon.conf
MONITOR ups@localhost 1 upsmon <random> primary
SHUTDOWNCMD "/sbin/shutdown -h +0"
FINALDELAY 5
sudo systemctl enable --now nut-server nut-monitor
upsc ups@localhost battery.charge      # test
```

NUT shuts the server down when the battery is low. systemd stops Docker, Docker stops each container with its
`stop_grace_period` (PostgreSQL gets 120 s to write a checkpoint). In the BIOS set **"Restore on AC power loss: Power
On"** so the server starts again by itself when power returns.

## 9. Ports and paths summary

| What | Where |
|---|---|
| Web | `https://<SMS_DOMAIN>` (host ports 80/443 → Caddy 8080/8443) |
| Uptime Kuma | `http://127.0.0.1:3001` on the server (SSH tunnel: `ssh -L 3001:127.0.0.1:3001 admin@server`) |
| Backups | `/srv/sms-backup` (second disk) |
| Database | Docker volume `kansview-sms_pgdata` (never exposed on the network) |
| Uploaded files | Docker volume `kansview-sms_storage` |
| Secrets | `/opt/kansview-sms/infra/secrets/` (root only) |
