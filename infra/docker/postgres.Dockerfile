# syntax=docker/dockerfile:1.7
# Owner: Agent H. PostgreSQL server: the pinned official image plus age, so archive-wal.sh can encrypt every WAL
# segment before it is written to the backup disk (CP5-05). Nothing else changes; Compose runs it as uid 999.
#   docker build -f infra/docker/postgres.Dockerfile -t kansview/sms-postgres:dev infra/docker
ARG PG_IMAGE=postgres:18.7-trixie@sha256:2ea8630df176ad090ec92136dee850397c5af8781e4bcf2e4162593691c61bbc
FROM ${PG_IMAGE}
# apt-get upgrade pulls Debian security fixes newer than the pinned base image (e.g. zlib1g CVE-2026-85091).
# gosu (built with an old Go toolchain) is removed: the entrypoint only calls it when started as root,
# and this image always runs as the postgres user.
RUN apt-get update \
 && apt-get upgrade -y --no-install-recommends \
 && apt-get install -y --no-install-recommends age \
 && rm -rf /var/lib/apt/lists/* /usr/local/bin/gosu
# Same unprivileged user Compose runs it as (uid 999); the official entrypoint works unprivileged.
USER postgres
