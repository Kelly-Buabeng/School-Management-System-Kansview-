# Upgrade procedure

Owner: Agent H. Upgrade outside school hours (evening or weekend). Budget 30 minutes plus 30 minutes of checks.

## Before

1. Read the release notes for the new version (`git log` / release page): look for "database migration",
   "configuration change" or "manual step".
2. Tell staff the system will be unavailable.
3. Check the status page is green (backups working, disk space OK).
4. Take a fresh backup and note its id:
   ```bash
   cd /opt/kansview-sms && sudo scripts/backup-now.sh
   ```

## Upgrade

```bash
cd /opt/kansview-sms
sudo git fetch --tags
sudo git checkout v1.1.0                       # the new release tag; never an untested branch
diff -u infra/.env.example infra/compose/.env   # add any new settings
cd infra/compose
sudo docker compose build --pull               # new images (base images are pinned by digest in the Dockerfiles)
sudo docker compose up -d                      # migrate runs first; api/worker start only if it succeeds
sudo docker compose ps                         # all healthy; migrate exited (0)
sudo docker compose logs migrate               # "migrations up to date"
```

Migrations are forward-only and run in a transaction each: if one fails, it rolls back, `migrate` exits non-zero and
the old database structure remains. The api will not start on a half-migrated database.

## Check

- Sign in as administrator; status page green; version shows the new number.
- Bursar: open a student balance and the payment list. Registrar: open a student and the Emergency View.
- `sudo docker compose logs --since 15m api worker | grep -i error` shows nothing unexpected.

## Roll back

If the new version misbehaves and the release had **no** database migration:
```bash
sudo git checkout <previous tag> && cd infra/compose && sudo docker compose build && sudo docker compose up -d
```
If it **had** a migration, the old code may not work with the new structure: restore the backup taken before the
upgrade, then start the old version:
```bash
sudo git checkout <previous tag>
sudo scripts/restore.sh --backup <backup id from "Before" step 4>
```
Any work done after the upgrade must then be re-entered; keep the window short and test before telling staff.

## Operating system and PostgreSQL

- Ubuntu security updates install automatically (`unattended-upgrades`); reboot monthly in the evening
  (`sudo reboot`; the stack starts by itself).
- PostgreSQL minor versions (18.x) come with a new pinned image in a release; this is a normal upgrade.
- A PostgreSQL **major** upgrade (18 → 19) needs a dump/restore or `pg_upgrade` plan written for that release. Never
  change the image tag by hand.
- Rotate the field-encryption master key with the procedure in `docs/security/` (Agent D) - add a new key id, never
  remove an old one until all data is re-encrypted, and update the recovery kit.
