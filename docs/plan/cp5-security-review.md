# CP5: independent security review

- Reviewer: independent security reviewer. I did not write any of this code.
- Baseline: `origin/main` at `8e9e535` (after PR #29 and PR #30). Reviewed on 2026-11-19.
- Method: I read the code (API, DB migrations, infra, CI, web), ran the test suites and wrote throwaway probe tests against a real PostgreSQL 16 to confirm findings. The probes are not committed. Suggested regression tests are listed with each finding.
- Every example below uses made-up data.

## Summary verdict

**PASS WITH CONDITIONS.**

The design is sound and most controls are implemented as the threat model says. Examples: deny-by-default guard, CSRF synchroniser, server-side hashed sessions, scoped 404s, field policy, append-only finance and audit tables, gap-free receipts, maker–checker, a hardened upload pipeline, non-root read-only containers, and no high or critical dependency advisories.

I found one High issue: the mandatory TOTP for ADMIN/BURSAR can be brute-forced because the failure counter never builds up. I also found five Medium issues. Conditions:

1. **Before go-live:** fix CP5-01.
2. **Before go-live:** fix CP5-02, CP5-03, CP5-05 and CP5-06. Schedule the audit-chain job (CP5-04).
3. Lows and Infos go to the follow-up list. Each needs an owner and a target date.

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 1 |
| Medium | 5 |
| Low | 8 |
| Info | 6 |

The severities use the school's threat model. The most likely attacker is an insider, or someone who has a staff password: a shared laptop, a phished password, or a curious older pupil. The most sensitive assets are children's medical and safety data, and money.

## Findings table

| ID | Sev | Title | Where | Owner | Status |
|---|---|---|---|---|---|
| CP5-01 | High | MFA code brute force: logging in with the right password resets the failure counter, so wrong TOTP codes never lock the account | `apps/api/src/modules/auth/auth.service.ts:103-106,153-160` | D | confirmed (probe) |
| CP5-02 | Medium | No `trust proxy`: every rate limit and every audit/session IP uses Caddy's container IP, so 50 bad logins lock out the whole school for 15 min | `apps/api/src/security/request-context.ts:29-33`, `apps/api/src/bootstrap.ts`, `rate-limiter.ts:320-328` | D (+ORCH for `bootstrap.ts`, H for Caddy) | confirmed (probe + code) |
| CP5-03 | Medium | XLSX import is fully decompressed by ExcelJS **before** the zip-bomb check; a 2.2 MB file pushes API memory above its 1 GB container limit | `apps/api/src/modules/imports/imports.service.ts:186-187`, `file-reader.ts:227-233` | G | confirmed (probe) |
| CP5-04 | Medium | Daily audit-chain check and external head-hash anchor are never scheduled; deleting the newest rows (tail) cannot be detected | `apps/api/src/modules/audit/audit.service.ts:90-93`, `worker.ts`, `modules/system/maintenance.service.ts` | D (+H) | confirmed (code) |
| CP5-05 | Medium | Local backup disk holds the continuous WAL archive in **plaintext** (gzip only); the base backup is also written in plaintext to the backup disk before it is encrypted | `infra/backup/bin/archive-wal.sh:20-26`, `base-backup.sh:13-16,30-52` | H | confirmed (code) |
| CP5-06 | Medium | Self-service password reset is broken (`resetCode` vs `{{code}}`). Once fixed as written, the reset token would be stored in message bodies that ADMIN/HEADTEACHER can read | `auth.service.ts:351`, `notifications/notification.service.ts:17`, `template-engine.ts:12`, `message-dispatcher.ts:64,89`, `messages.service.ts:301,339` | D + F | mismatch confirmed (probe); exposure is latent (code) |
| CP5-07 | Low | Lockout responses reveal whether a username exists | `auth.service.ts:37-39,77,89,93` | D | confirmed (probe) |
| CP5-08 | Low | Files kept `pending` while ClamAV is down are never rescanned (`rescanPending` has no caller); imports go ahead whatever the scan result | `security/upload-pipeline.service.ts:83-87,106`, `imports.service.ts:214-219` | D (+G, H) | confirmed (grep) |
| CP5-09 | Low | Field-encryption AAD does not include table, column or row, so ciphertexts can be swapped between rows without detection | `security/field-crypto.service.ts:39,88,101` | D | confirmed (code) |
| CP5-10 | Low | Stale idempotency claim takeover can run the same request twice; `POST /messages` and `POST /adjustments` are not safe to re-run at the database level | `security/idempotency.impl.ts:58-68,87-94`, `notifications/messages.service.ts:247` | D (+F, C) | suspected (code) |
| CP5-11 | Low | `GET /files/:id` gives access to import files to anyone with `imports:read`, without the import-type restriction | `modules/files/file-access.resolver.ts:116-118` | F | confirmed (code) |
| CP5-12 | Low | Automated retention jobs are missing (idempotency purge, SMS body blanking, the retention settings) although the retention schedule describes them | `security/idempotency.impl.ts:81`, `settings/policies.ts:20-25`, `docs/security/data-protection/retention-schedule.md:15-18` | D (+F, H) | confirmed (grep) |
| CP5-13 | Low | Nest `ConsoleLogger` is used everywhere, so pino redaction never runs; 500 errors log the raw `err` (database errors can contain row data) | `apps/api/src/main.ts:31`, `common/logger.ts`, `common/problem.filter.ts:40` | ORCH | confirmed (code + test output) |
| CP5-14 | Low | Read-modify-write races: one recovery code can be used twice at the same moment; concurrent failures under-count the lockout counter | `auth.service.ts:139-145,320-323` | D | suspected (code) |
| CP5-15 | Info | Backup age **private** key stays on the server (`infra/secrets/backup_age_identity`) | `scripts/generate-secrets.sh:44` | H | confirmed (code) |
| CP5-16 | Info | Dev seed (known admin password and TOTP secret) has no technical guard against a production database | `db/seeds/seed.mjs:9`, `db/seeds/README.md:32-33` | A | confirmed (code) |
| CP5-17 | Info | Production web build ships `mockServiceWorker.js` and a `MockPanel` chunk (inert; no credentials in the bundle) | `apps/web/public/`, `apps/web/src/layout/AppLayout.tsx:15` | E | confirmed (build) |
| CP5-18 | Info | Login CSRF is possible: the public login accepts urlencoded bodies and has no CSRF token | `bootstrap.ts:16`, `auth.controller.ts:83-91` | D (+ORCH) | code |
| CP5-19 | Info | `GRANT CREATE ON DATABASE` to `sms_app` lets the app role create schemas | `infra/postgres/initdb/10-create-roles.sh` | H | code |
| CP5-20 | Info | Spreadsheet exports rely on ExcelJS writing strings as text cells; there is no explicit formula neutralisation | `modules/imports/error-report.ts:37`, `modules/finance/reports.service.ts:250` | G + C | code |

---

## Detailed findings

### CP5-01 (High): MFA code brute force, failure counter reset by password login

- **Where:** `apps/api/src/modules/auth/auth.service.ts:103-106` (successful password login sets `failed_login_count: 0, locked_until: null`), `:153-160` (MFA failures use the same counter and lock only when `(count+1) % 5 === 0`).
- **Description:** ADMIN and BURSAR must use TOTP. A wrong code calls `registerFailure`, which increments `users.failed_login_count`. But the password step (line 103) **resets that counter to 0 on every successful password login**, before MFA is checked. An attacker who knows the password can:
  1. log in (counter = 0);
  2. try 4 wrong codes (counter = 4);
  3. log in again (counter = 0);
  4. repeat.

  The account never locks. Also, `verifyMfa` never checks `locked_until`, and a lock does not revoke the user's other `mfa_pending` sessions.
- **Exploit:** An older pupil or a colleague has watched the bursar type their password. From the LAN they script `login` then 4 × `mfa/verify`. The only brake is `loginPerIp` at 50 logins per 15 min (about 200 guesses per 15 min, about 19,000 per day). With the ±1 step window, 3 of the 10^6 codes are valid at any moment, so the expected time to break in is about 2–3 weeks from one source. Because of CP5-02, that source is "the whole school", so the attack also blocks everyone else's logins. That might draw attention, but the TOTP control itself is not working as designed. Once in, the attacker can record or reverse payments, read all medical records and create users.
- **Evidence (confirmed):** A probe integration test with the real app and database: 6 rounds of login + 4 wrong codes for an ADMIN with TOTP gave statuses `200,401,401,401,401` repeated 6 times. That is **24 wrong codes checked**, ending with `failed_login_count = 4` and `locked_until = null`.
- **Fix:**
  - Count MFA failures separately (a new `mfa_failed_count`, or `login_attempts` rows with reason `wrong MFA code` within a time window) and **do not reset it on password success**, only after successful MFA.
  - Lock the account at 5 MFA failures and revoke all its `mfa_pending` sessions.
  - Check `locked_until`/`status` in `verifyMfa`.
  - Optionally move the password-step counter reset until after MFA for MFA users.
- **Suggested test:** "after 5 wrong TOTP codes spread across several logins, the account is locked and a further correct code is refused".
- **Owner:** D.

### CP5-02 (Medium): No `trust proxy`, so every client looks like Caddy

- **Where:** `apps/api/src/security/request-context.ts:29-33` (`req.ip ?? socket.remoteAddress`), `apps/api/src/bootstrap.ts` (no `app.set('trust proxy', …)`), `rate-limiter.ts:320-328`, `auth.service.ts:66-67,245`.
- **Description:** In production every request reaches the API from Caddy over the Docker network. Express's `req.ip` is therefore always Caddy's container address. So:
  - `loginPerIp` (50 per 15 min) becomes one counter **shared by the whole school**;
  - `loginPerIpUser` becomes per-username;
  - `resetPerIp` (10 per hour) is school-wide;
  - every `audit.events.ip`, `user_sessions.ip` and `login_attempts.ip` holds the same useless address. That weakens "who did this" investigations, which are the main insider-misuse detective control.
- **Exploit:** Anyone on the school Wi-Fi sends 50 failed logins with random usernames. For the next 15 minutes no staff member can sign in, including for the Emergency View. Repeat every 15 minutes. No account is needed.
- **Evidence:** The probe sent 52 logins with 52 different `X-Forwarded-For` values and got `429` from attempt 51. The limiter keys on the socket address and ignores the header (which is correct while there is no trusted proxy). In the Compose deployment the socket address is always Caddy (code reasoning: `infra/compose/docker-compose.yml`, Caddy `reverse_proxy` to `api:3000`).
- **Fix:**
  - Set `app.set('trust proxy', <Caddy's network / 1 hop>)` in `bootstrap.ts`. Trust exactly one hop, so the leftmost client-supplied XFF is not trusted.
  - Have Caddy set `X-Forwarded-For` from `{remote_host}` (it does by default).
  - Keep a global ceiling, but much higher, and add a per-username failure limit that does not depend on IP.
  - Consider CAPTCHA-free back-off instead of hard 429 for the per-IP rule.
- **Owner:** D (limiter keys, `clientIp`); ORCH (`bootstrap.ts`); H (Caddy headers).

### CP5-03 (Medium): Import parser decompresses XLSX before the zip-bomb check

- **Where:** `apps/api/src/modules/imports/imports.service.ts:186-187` calls `readImportFile` (ExcelJS `wb.xlsx.load`) and only then `storeOriginal` → `uploads.accept` → `checkXlsx`. See also `file-reader.ts:227-233` and `file-sniffer.ts:107-123`.
- **Description:** The threat model says imports are "parsed with size limits" and that zip bombs are rejected. `checkXlsx` exists and works, but the import path runs it **after** ExcelJS has inflated every part into memory. The 2,000-row limit is also only checked after the full parse.
- **Exploit:** A REGISTRAR or BURSAR (or anyone using their session) uploads a 2 MB `.xlsx` whose sheet XML inflates to about 900 MB. The API process exceeds `mem_limit: 1g` and Docker kills it. It restarts, and the attacker repeats. Everything stops while it is down, including the Emergency View.
- **Evidence (confirmed):** A probe built a 2.25 MB workbook (900 MB of sheet XML). `checkXlsx` rejects it ("compression ratio too high"). `readImportFile` on the same buffer reached a **peak RSS of 1,073 MB** in 3.8 s before ExcelJS threw "Invalid string length". A 309 KB variant reached 447 MB.
- **Fix:** Call `checkXlsx(buffer)` (or run the whole `uploads.accept`) **before** `readImportFile`. Also consider ExcelJS's streaming `WorkbookReader` with a row cap that stops reading at 2,001 rows.
- **Suggested test:** "upload of a high-ratio xlsx is rejected with 415 before parsing" (assert that `readImportFile` is not called).
- **Owner:** G.

### CP5-04 (Medium): Audit-chain verification is not scheduled; no external anchor

- **Where:** `apps/api/src/modules/audit/audit.service.ts:90-93` (`verifyAndLog()` has no caller), `apps/api/src/worker.ts`, `modules/system/maintenance.service.ts` (hourly housekeeping does not call it), `audit.module.ts:6` ("job name suggestion").
- **Description:** The threat model (4.5, 7, 8) relies on a **daily** hash-chain check and a logged daily chain-head hash. The head hash is the "external anchor" that turns the unkeyed SHA-256 chain into tamper evidence. Neither runs. The chain is unkeyed and `verify_chain` only checks links between rows that still exist, so **deleting the most recent N events** (for example the `reverse` and `export` rows of a fraud) after disabling the trigger as superuser cannot be detected. Even simple tampering is only found if someone presses "verify" by hand.
- **Exploit:** An operator with DB superuser access (the school's own IT contractor, or anyone holding `db_superuser_password`) disables `events_append_only`, deletes the last day's audit rows covering a cash reversal, and re-enables the trigger. `POST /audit-events/verify` still says intact.
- **Evidence:** `grep -rn verifyAndLog apps/api/src` finds only the definition. There is no `audit.verify-chain` job in the worker or housekeeping.
- **Fix:**
  - Schedule `verifyAndLog()` daily in the worker. Write `headHash`, `id` and the count to the log, to the backup status file and to the off-site backup metadata.
  - Show the result on `/system/status`, and alert (Uptime Kuma push) when the chain is broken or when the head id goes backwards.
  - Optionally key the chain (HMAC with a key the DB does not hold).
- **Owner:** D (job), H (status/alerting).

### CP5-05 (Medium): Plaintext WAL archive and plaintext staging on the backup disk

- **Where:** `infra/backup/bin/archive-wal.sh:20-26` (`gzip -1` only, written to `/backups/wal`), `base-backup.sh:13-16,30-52` (`pg_basebackup` writes plaintext tars into `$BASE_DIR/.partial-*/plain` on the backup disk, encrypts them, then `rm -rf`). The runbook table (`docs/operations/backup-and-recovery-runbook.md:70`) says "WAL archive (gzip)".
- **Description:** Threat model 4.7: "Backup disk … stolen → encrypted with age **before** it leaves the server". The second disk (often an external USB drive) holds about 7 days of WAL in plaintext. WAL carries full row images of every change: names, dates of birth, addresses, pickups, incidents, payments and sessions. Field-encrypted columns (medical, Ghana Card) stay encrypted. The nightly base backup also lands on that disk as plaintext for a few minutes, and is deleted with a normal `rm`, so it can be recovered from free blocks.
- **Exploit:** Someone takes the external backup drive (easier to carry off than the server). They get a week of plaintext child records without any key. This is a notifiable breach under Act 843.
- **Fix:**
  - Encrypt WAL with `age` inside `archive-wal.sh`, before it touches the disk (the public recipients file is enough there).
  - Stage `pg_basebackup` output on the encrypted system disk or tmpfs, or stream `pg_basebackup -Ft -D -` straight into `age`.
  - Update the runbook and the restore scripts to decrypt WAL.
- **Owner:** H.

### CP5-06 (Medium): Password-reset SMS broken; the fix as written would expose tokens in the delivery log

- **Where:** `auth.service.ts:351` enqueues `{ resetCode: token, minutes: 30 }`. The default template (`notification.service.ts:17`) and allow-list (`template-engine.ts:12`) use `{{code}}`. The rendered text is stored in `messages.body_rendered_preview` and `message_recipients.body` (`message-dispatcher.ts:64,89`), and both are returned by the delivery log (`messages.service.ts:301,339`) to any holder of `messages:read`. ADMIN and HEADTEACHER see all messages, because `requested_by` is null for system sends.
- **Description:**
  1. Today the SMS reads "…your password reset code is . It expires in 30 minutes…", so self-service reset can never work.
  2. When someone "fixes" this by renaming the key, the 256-bit token will sit in plaintext in two tables and be shown in the UI delivery log until message retention runs (CP5-12: it doesn't). A headteacher, or anyone with a headteacher session, could then take over any account that has no MFA (HEADTEACHER, REGISTRAR, TEACHER) within 30 minutes.

  The reset itself is otherwise strong: 256-bit token, SHA-256 at rest, 30 min, single use, all tokens burned on use, sessions revoked, 202 with the same message for every input.
- **Evidence:** Probe: `renderTemplate(defaultBody, { resetCode: 'TOKEN123', minutes: 30 })` → `"…reset code is . It expires in 30 minutes…"`, `missing: ['code']`. Storage and exposure confirmed by reading the code.
- **Fix:**
  - Use a short one-time code (or the token) under `code`, but do not persist it: render it only at send time in the worker from a reference, or store a masked body (for example `code ••••`) in `body_rendered_preview` and `message_recipients.body` for `password_reset`.
  - Exclude `kind = 'password_reset'` from the delivery-log API.
  - Add an integration test for the SMS path.
- **Owner:** D (auth) + F (notifications).

### CP5-07 (Low): Lockout responses reveal whether a username exists

- **Where:** `auth.service.ts:77` (unknown user: locked when `recentFailures + 1 > 5`, that is on the **6th** try), `:93` (real user: locked on the **5th**), `:37-39,89` (a real locked account returns `meta.lockedUntil`; an unknown one has no meta).
- **Evidence:** Probe: real user `401,401,401,401,423,423`; unknown user `401,401,401,401,401,423`; real locked body `meta: {"lockedUntil": "…"}`, unknown `undefined`. The response for a single wrong password is identical, as the existing test checks.
- **Impact:** Low. School usernames are guessable, and the first five tries already lock the real account. It does contradict the "no enumeration" control, and it reveals the lock expiry.
- **Fix:** Use `>= LOCKOUT_THRESHOLD` for unknown users, and leave out `lockedUntil` (or return a fixed value) on public responses.
- **Owner:** D.

### CP5-08 (Low): Pending files are never rescanned; imports ignore the scan

- **Where:** `upload-pipeline.service.ts:83-87` (clamd error → `pending`), `:106` (`rescanPending` has no caller), `imports.service.ts:214-219` (only `infected` is refused; rows are parsed before the scan).
- **Description:** Downloads fail closed: `pending` files return 409. That is good. But nothing rescans them, so every document or photo uploaded while clamd is down (or while the `clamav` profile was not started, although `SMS_CLAMAV_ENABLED` defaults to `true`) stays unusable for ever. Import rows are staged and can be committed whatever the scan says. The real-ClamAV EICAR check from CP2 has still not been run on the Docker stack.
- **Fix:**
  - Schedule `rescanPending()` in the worker, and warn on `/system/status` when clamd is unreachable or files have been pending for more than an hour.
  - Refuse import validate/commit while the job's file is not `clean` (or document that structured rows do not need it).
  - Run EICAR against the real `clamav` container at CP6.
- **Owner:** D (job), G (imports), H (status).

### CP5-09 (Low): Ciphertext not bound to row or column

- **Where:** `field-crypto.service.ts:39` (fixed payload AAD `sms-field-v1`), `:88,101`.
- **Description:** Nonces are random per value and the data key is random per record, so nonce reuse is not a concern. The key id is bound as AAD on the wrap. But a ciphertext copied from one row or column to another decrypts without error. For example: a student's medical notes copied to another student, a staff SSNIT number moved into a guardian's Ghana Card column, or a user's own TOTP secret copied into the ADMIN's `mfa_secret_enc`.
- **Impact:** Needs DB write access (as `sms_app` or better). That attacker can already do a lot, which is why this is Low. But integrity of medical data matters (wrong allergy shown in an emergency).
- **Fix:** Add `table:column:primary key` to the payload AAD (version byte 0x02). `rotate-keys` can re-encrypt on the next rotation.
- **Owner:** D.

### CP5-10 (Low): Stale-claim takeover can double-run; some idempotent operations are not safe to re-run

- **Where:** `idempotency.impl.ts:58-68,87-94`.
- **Description:**
  1. A request still running after 2 minutes (lock wait, slow invoice generation or import commit) can be taken over by a retry. Then `fn` runs twice at once. If the original then fails, its `catch` deletes the row by id, which is now the **retry's** claim, so a third request can claim it again.
  2. The class comment requires every wrapped operation to be safe to re-run at database level. That holds for payments (`payments.idempotency_key` UNIQUE) and for invoices (per-student lock plus an "already invoiced" check). It does not hold for `POST /messages`: a crash after commit and before the response is stored makes a retry after 2 minutes send the bulk SMS a second time (cost, and confusion for parents). It also does not hold for `POST /adjustments`, where a retry creates a second pending request; that is harmless but confusing.
- **Evidence:** Code reasoning only (not reproduced).
- **Fix:**
  - On takeover, store a claim token (`claimed_at` / a UUID) and make the final update and delete conditional on it.
  - Give `messages` and `adjustments` a unique `idempotency_key` column, as payments have.
- **Owner:** D (+F, C).

### CP5-11 (Low): File download bypasses the import-type restriction

- **Where:** `file-access.resolver.ts:116-118` maps any `import.jobs` file (original upload, dry-run report, error report) to `imports:read` only.
- **Description:** The imports module hides jobs of other types (REGISTRAR: students/guardians only; BURSAR: opening balances only). `GET /files/:id` does not apply that rule. So a BURSAR can download a students-and-guardians import file (names, phones, addresses, possibly Ghana Card numbers), and a REGISTRAR can download opening-balances files.
- **Impact:** Needs the file UUID (v7, 74 random bits, not listed to those roles). This is defence in depth.
- **Fix:** Return the job type from the lookup and apply `allowedImportTypes(user)` in the resolver (export it from G, or register the lookup from the imports module).
- **Owner:** F (+G).

### CP5-12 (Low): Retention jobs described but not implemented (Act 843 storage limitation)

- **Where:** `DbIdempotencyService.purgeExpired` has no caller. `retention.message_bodies_days`, `retention.audit_events_years` and `retention.login_attempts_days` are only defined in `settings/policies.ts:20-25`. `retention-schedule.md:15-18` names worker and daily jobs for them.
- **Description:** Idempotency records keep full response bodies (payment views with child names and amounts) for ever. SMS bodies, which contain children's names and balances, are never blanked. Login attempts are purged by housekeeping at a hard-coded 180 days that ignores the setting. Student anonymisation exists (`/students/:id/anonymise`, retention candidates); the automatic jobs do not.
- **Fix:** Add the daily jobs, or correct the retention schedule so it says what the code does and records the accepted gap in the processing register.
- **Owner:** D (idempotency, audit), F (messages), H (housekeeping).

### CP5-13 (Low): Logger redaction bypassed

- **Where:** `main.ts:31` creates the Nest app with no `logger`/`useLogger`. All modules log through `new Logger(...)` (Nest `ConsoleLogger`), so the pino `redact` paths in `common/logger.ts` never apply. `problem.filter.ts:40` logs the whole `err` for 5xx, and PostgreSQL errors can include `detail: "Failing row contains (…)"` with personal data. The integration test output shows the Nest console format.
- **Fix:** Use a pino-backed `LoggerService` (for example `app.useLogger(...)`). Log `err.code`, `constraint` and the message, but not `detail` or `where`, for database errors.
- **Owner:** ORCH.

### CP5-14 (Low): Read-modify-write races in auth

- **Where:**
  - `auth.service.ts:139-145`: recovery codes are read, filtered and written back without a lock or compare-and-set, so two concurrent requests with the same code both succeed.
  - `:320-323`: `failed_login_count` is written as the value read plus 1, so parallel wrong passwords count once.
- **Fix:** Use `UPDATE … SET failed_login_count = failed_login_count + 1 RETURNING …`. Remove a recovery code with `array_remove`, and add `WHERE <hash> = ANY(mfa_recovery_codes_hash)` so the update only succeeds if the code is still there.
- **Owner:** D.

### CP5-15 (Info): Backup decryption key stays on the server

`scripts/generate-secrets.sh:44` creates `infra/secrets/backup_age_identity` (0400) next to the running stack. Anyone with root on the server (ransomware, a remote attacker) can then decrypt the **off-site** backups, which defeats the point of an off-site encrypted copy. Recommendation: after printing and USB copy, delete it from the server (`shred`). The restore procedure should bring it back from the safe. Owner: H.

### CP5-16 (Info): Dev seed can be run against any database

`db/seeds/seed.mjs` only has a comment ("Never point this at a production database"). Its admin and bursar have published passwords and TOTP secrets (`db/seeds/README.md`, also allow-listed in `.github/gitleaks.toml`). It is not in the API image (the Dockerfile copies only `db/tools` and `db/migrations`). Recommendation: refuse to run when the target already has `school_profile` data or `SMS_NODE_ENV=production`, or ask for a `--i-know-this-is-dev` flag. Owner: A.

### CP5-17 (Info): Mock artefacts in the production bundle

`VITE_API_MODE=real` (the default for production builds) keeps MSW off. I built the bundle and grepped it: no demo passwords and no `setupWorker`. But `dist/mockServiceWorker.js` and a `MockPanel-*.js` chunk are shipped. Both are inert in real mode. Recommendation: exclude `public/mockServiceWorker.js` from production builds. Owner: E.

### CP5-18 (Info): Login CSRF

`/auth/login` is public, has no CSRF token and accepts `application/x-www-form-urlencoded` (`bootstrap.ts:16`). A malicious page can sign the victim in as the attacker. The impact is low here (the victim would then enter data under the attacker's account). Recommendation: accept JSON only on API routes (drop `urlencoded`), or require `Content-Type: application/json`. Owner: D / ORCH.

### CP5-19 (Info): App role can create schemas

`initdb/10-create-roles.sh` grants `CREATE ON DATABASE` to `sms_app` "for pg-boss", but the same script already creates `pgboss AUTHORIZATION sms_api`. The extra grant lets the app role create arbitrary schemas and objects. Recommendation: revoke it if pg-boss works with the pre-created schema. Owner: H.

### CP5-20 (Info): No explicit formula neutralisation in exports

ExcelJS writes JS strings as shared-string text cells, so a guardian named `=HYPERLINK(...)` is shown as text and is not evaluated. Import parsing takes formula **results**, not formulas. That is safe today. But if staff re-save the error report or a finance export as CSV and reopen it, the value becomes live. Recommendation: prefix cells that start with `= + - @ \t \r` with `'` in exports. Owner: G + C.

---

## Checked and found sound

- **Argon2id**: m = 19 MiB, t = 2, p = 1 (OWASP minimum), with rehash on login. Dummy verify for unknown users.
- **Password policy**: at least 12 characters, a bundled common-password list, de-leet and sequence checks, and a check against the user's own name.
- **Sessions**: 256-bit random id with only the SHA-256 stored. Idle 30 min (sliding) and absolute 12 h are enforced server-side. New id on login and again after MFA or MFA enrolment, with the old row revoked. Sessions are revoked on password change or reset, role or status change, admin MFA reset and force logout. A user cannot change their own roles or unlock themselves.
- **Cookie**: `__Host-sms_session; HttpOnly; Secure; SameSite=Strict; Path=/`, no Domain (existing test).
- **MFA gating**: `mfa_pending` and `mfa_enrolment` sessions get an empty permission set and can only reach the routes marked for that phase. ADMIN/BURSAR cannot disable MFA. TOTP replay guard; ±1 step window; recovery codes of about 59 bits each, hashed and compared in constant time.
- **Reset token**: 256-bit, hashed, 30 min, single use, every outstanding token burned on use, the same 202 for every input, rate limited.
- **Guard**: global `PermissionGuard`, deny by default. Every route declares a permission (`test:rbac-coverage` passed as part of the full suite; `contract-routes` passed). The CSRF HMAC is bound to the session hash and checked in constant time on every non-GET request. CORS is not enabled.
- **Scope and IDOR**: TEACHER scope comes from the day's active `staff_class_assignments`. 404 for out-of-scope records on students, guardians, payments, receipts, adjustments, report cards (`card()`), score sheets (`classInScope`), files (resolver plus scope) and imports (by type). All other roles are unrestricted by design. The field policy drops medical detail, addresses and finance by role, and always hides Ghana Card, SSNIT and secrets. Request schemas are strict Zod objects.
- **SQL**: no `sql.raw` or `sql.lit`. The two `sql.ref` uses take constant aliases. Search uses bound parameters and `escapeLike`. The only interpolated SQL is in the offline `rotate-keys` CLI, with a constant column list. Sort parameters are enums.
- **Uploads**: magic-byte allow-list (no SVG, HTML or XML), per-policy size limits, multer limits, Caddy 12 MB / 1 MB body caps, PDF active-content scan, XLSX zip checks (but see CP5-03), sharp re-encode with `limitInputPixels` and EXIF stripped, random storage keys, and a strict key regex in `LocalFileStore`, so there is no path traversal. Downloads are `attachment`, `nosniff`, `CSP: sandbox`, `no-store`, and only for files whose scan status is `clean`. EICAR rejected (mocked clamd).
- **PDFs**: pdfmake doc definitions built from data (no HTML or template evaluation). SMS templates have a placeholder allow-list, HTML is rejected, and rendered values are flattened and stripped of braces.
- **Crypto**: AES-256-GCM with a random data key and IV per value, key id bound on the wrap, key file 0400 enforced in production, a separate blind-index HMAC key, and a CSRF key derived separately.
- **Errors**: `ProblemFilter` returns problem+json with a request id only, never a stack trace. Helmet at the API (`default-src 'none'`, `frame-ancestors 'none'`, `no-store`). Caddy adds HSTS, a strict script CSP (`script-src 'self'`; `style-src 'unsafe-inline'` is an accepted Mantine trade-off), XFO DENY, nosniff, no-referrer, COOP/CORP, and strips `Server`.
- **Finance**:
  - `ledger_entries`, `payment_allocations`, `invoice_lines`, `audit.events` and `payment_reversals` have append-only triggers, and `sms_app` has only SELECT/INSERT on them (plus column-limited UPDATE where a status transition needs it).
  - `payments` UPDATE is limited to the reversal columns through a guarded SECURITY DEFINER function. Finance and people tables have no DELETE.
  - Receipt and reversal numbers come from a locked counter; the 500-parallel test passed at CP3.
  - Payments are idempotent by a unique key.
  - Maker–checker: a reversal approver must differ from the requester, and needs `payments:reverse_approve` (ADMIN). An adjustment approver must differ, and must be ADMIN or HEADTEACHER (refunds and write-offs ADMIN only). ADMIN has no `payments:create`.
  - The duplicate-reference override needs a reason of at least 5 characters, is stored on the payment and is audited.
- **Audit**: written in the same transaction for changes. Emergency View, medical read, Ghana Card and SSNIT reveal (with reason), file download, receipt, statement and report PDFs, and finance report exports are audited. The hash chain is linear (advisory lock) and `verify_chain` detects edits in the middle.
- **Frontend**: no `dangerouslySetInnerHTML` and no `innerHTML`. No tokens or PII in `localStorage` (`sessionStorage` is used only by the MSW mock). Production builds default to real mode.
- **Infra**:
  - Containers are non-root (`USER node`, postgres 999), `read_only`, `cap_drop: ALL`, `no-new-privileges`.
  - Secrets come from Docker secret files (0444 inside a 0700 root directory).
  - Postgres is not published, sits on an `internal: true` network, uses scram-sha-256, and `pg_hba` rejects everything else.
  - Images are pinned by digest. Caddy admin is off. Base backups and off-site copies are age-encrypted. The restore drill passed.
- **CI**: gitleaks (narrow, documented allowlist), osv-scanner, Trivy image scan, `pnpm audit --prod --audit-level high`.
- **Dependencies**: `pnpm audit --prod` on this commit: **No known vulnerabilities found**.
- **Tests**: full API suite on PostgreSQL 16: **47 files, 1,022 tests passed**.
- **Data protection**: `docs/security/data-protection/` has the retention schedule, DSR procedure, breach response, processing register, admission privacy notice and staff confidentiality guide. The code has DSR logging, SAR export (`dpa:export`, which includes the student's access log), retention candidates and anonymisation. The gaps are in CP5-12.

## Not checked (out of time or environment)

- The Docker Compose stack itself: TLS handshake and ciphers, real Caddy headers on the wire, the real ClamAV/EICAR path, container runtime checks (left for CP6).
- `S3FileStore`, the pg-boss worker job handlers (other than reading the code), WhatsApp channel (not implemented).
- Full line-by-line review of every B-module service (attendance, welfare, withdrawals, promotion, enrolment, academic setup, dashboard widget scoping). I sampled them for scope and audit calls; the existing tests cover TEACHER 404s and BURSAR medical 403.
- Timing side-channels beyond reading the code (for example the extra DB work when a reset is requested for an account that exists).
- The web app's runtime behaviour in a browser (XSS through third-party components, CSP violations under Mantine). Checked statically only.
- Legal adequacy of the Act 843 documents (needs a lawyer, as the docs say).
- Host hardening (LUKS, SSH, fail2ban, firewall). Documented by Agent H; not verifiable from the repository.
