#!/usr/bin/env bash
# Owner: Agent H. Runs once, when the postgres data volume is first initialised (docker-entrypoint-initdb.d).
# Creates the login roles named in docs/contracts/schema.md section 7 with passwords from Docker secret files,
# and the application database owned by sms_owner. Table-level grants (e.g. no UPDATE/DELETE on finance and audit
# tables for sms_app) are applied by Agent A's migrations, which must only GRANT to these existing roles.
set -euo pipefail

read_secret() { tr -d '\r\n' < "$1"; }
OWNER_PW="$(read_secret /run/secrets/db_owner_password)"
APP_PW="$(read_secret /run/secrets/db_app_password)"
BACKUP_PW="$(read_secret /run/secrets/db_backup_password)"
DB_NAME="${SMS_DB_NAME:-sms}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v owner_pw="$OWNER_PW" -v app_pw="$APP_PW" -v backup_pw="$BACKUP_PW" -v db_name="$DB_NAME" <<'SQL'
SELECT format('CREATE ROLE sms_owner LOGIN PASSWORD %L', :'owner_pw') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sms_owner') \gexec
SELECT format('CREATE ROLE sms_app LOGIN PASSWORD %L', :'app_pw') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sms_app') \gexec
SELECT 'CREATE ROLE sms_readonly NOLOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sms_readonly') \gexec
SELECT 'CREATE ROLE sms_audit_writer NOLOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sms_audit_writer') \gexec
SELECT format('CREATE ROLE sms_backup LOGIN REPLICATION PASSWORD %L', :'backup_pw') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sms_backup') \gexec
GRANT sms_readonly TO sms_backup;
SELECT format('CREATE DATABASE %I OWNER sms_owner ENCODING ''UTF8'' TEMPLATE template0', :'db_name')
  WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db_name') \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'db_name') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO sms_app, sms_readonly, sms_backup', :'db_name') \gexec
SQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$DB_NAME" -v db_name="$DB_NAME" <<'SQL'
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
-- pg-boss creates its own schema ("pgboss") at worker start-up as the app role; allow schema creation.
GRANT CREATE ON DATABASE :"db_name" TO sms_app;
SQL
echo "kansview: roles and database ready"
