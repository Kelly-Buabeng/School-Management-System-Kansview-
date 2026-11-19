# syntax=docker/dockerfile:1.7
# Owner: Agent H. Backup runner: same PostgreSQL major version as the server (pg_basebackup must match),
# plus age (encryption), rclone (off-site copy), curl (monitor pushes).
#   docker build -f infra/docker/backup.Dockerfile -t kansview/sms-backup:dev .
ARG PG_IMAGE=postgres:18.7-trixie@sha256:2ea8630df176ad090ec92136dee850397c5af8781e4bcf2e4162593691c61bbc
FROM ${PG_IMAGE}
# apt-get upgrade pulls Debian security fixes newer than the pinned base image (e.g. zlib1g CVE-2026-85091).
# gosu (from the base image's entrypoint, built with an old Go toolchain) is removed: this image runs as
# the postgres user with its own ENTRYPOINT/CMD and never switches users.
RUN apt-get update \
 && apt-get upgrade -y --no-install-recommends \
 && apt-get install -y --no-install-recommends age rclone curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* /usr/local/bin/gosu
COPY --chown=root:root --chmod=0755 infra/backup/bin/ /opt/kansview-backup/bin/
ENV BACKUP_ROOT=/backups FILES_DIR=/data/storage TZ=Africa/Accra \
    PGHOST=postgres PGPORT=5432 PGUSER=sms_backup PGDATABASE=sms \
    PGPASSWORD_FILE=/run/secrets/db_backup_password \
    AGE_RECIPIENTS_FILE=/run/secrets/backup_age_recipients \
    AGE_IDENTITY_FILE=/run/secrets/backup_age_identity \
    PATH=/opt/kansview-backup/bin:$PATH
# Runs as the postgres user (uid 999): the same owner as the WAL files written by archive-wal.sh.
USER postgres
WORKDIR /backups
HEALTHCHECK --interval=5m --timeout=30s --start-period=2m --retries=2 CMD ["healthcheck.sh"]
ENTRYPOINT []
CMD ["scheduler.sh"]
