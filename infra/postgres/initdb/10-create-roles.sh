#!/usr/bin/env bash
# Owner: Agent H. Runs once, when the postgres data volume is first initialised (docker-entrypoint-initdb.d).
# Roles (docs/contracts/schema.md section 7 and db/migrations/0006_roles_and_grants.sql):
#   group roles (NOLOGIN, privileges granted by the migrations): sms_app, sms_audit_writer, sms_readonly
#   login users created here with passwords from Docker secret files:
#     sms_owner  - owns the database, runs migrations
#     sms_api    - used by the api and worker; member of sms_app + sms_audit_writer
#     sms_backup - REPLICATION, used by pg_basebackup; member of sms_readonly
set -euo pipefail

read_secret() { tr -d '\r\n' < "$1"; }
OWNER_PW="$(read_secret /run/secrets/db_owner_password)"
APP_PW="$(read_secret /run/secrets/db_app_password)"
BACKUP_PW="$(read_secret /run/secrets/db_backup_password)"
DB_NAME="${SMS_DB_NAME:-sms}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v owner_pw="$OWNER_PW" -v app_pw="$APP_PW" -v backup_pw="$BACKUP_PW" -v db_name="$DB_NAME" <<'SQL'
SELECT format('CREATE ROLE %I NOLOGIN', r) FROM unnest(ARRAY['sms_app','sms_audit_writer','sms_readonly']) r
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) \gexec
SELECT format('CREATE ROLE sms_owner LOGIN PASSWORD %L', :'owner_pw') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sms_owner') \gexec
SELECT format('CREATE ROLE sms_api LOGIN PASSWORD %L IN ROLE sms_app, sms_audit_writer', :'app_pw') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sms_api') \gexec
SELECT format('CREATE ROLE sms_backup LOGIN REPLICATION PASSWORD %L IN ROLE sms_readonly', :'backup_pw') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sms_backup') \gexec
SELECT format('CREATE DATABASE %I OWNER sms_owner ENCODING ''UTF8'' TEMPLATE template0', :'db_name')
  WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db_name') \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'db_name') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO sms_app, sms_audit_writer, sms_readonly', :'db_name') \gexec
-- pg-boss creates its own schema ("pgboss") the first time the worker starts, as sms_api.
SELECT format('GRANT CREATE ON DATABASE %I TO sms_app', :'db_name') \gexec
SQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$DB_NAME" <<'SQL'
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
-- Extensions used by migration 0001 (all "trusted"; pre-created so the owner never needs superuser).
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;
SQL
echo "kansview: roles and database ready"
