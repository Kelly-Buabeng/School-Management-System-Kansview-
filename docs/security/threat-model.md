# Threat model (STRIDE)

- Owner: Agent D (Security). Status: Phase 1 draft, reviewed at CP5.
- Scope: Kansview School Management System v1, on-premise single server (default from CR-0002), with nightly encrypted off-site backup. The cloud VM option shares the same model except for physical threats.
- Method: STRIDE per component and per data flow. Each threat lists the control and where it lives (file or document), so the CP5 reviewer can check it. Residual risks are listed at the end.

## 1. What we protect

The system holds data about **children** (about 1,000 students). A leak can harm a child (custody disputes, location of a child, medical conditions, discipline records). Under the Ghana Data Protection Act, 2012 (Act 843), the school is the data controller and must keep this data secure (the security safeguards principle of the Act; exact section references to be confirmed by a lawyer; see `data-protection/`).

| Asset | Sensitivity | Why |
|---|---|---|
| Student medical detail (allergies, chronic conditions, medication, special needs) | **Critical** | Special personal data (health) about a child. Encrypted at field level. |
| Incidents / discipline, health visits | **Critical** | Can stigmatise a child; restricted to ADMIN, HEADTEACHER and author. |
| Guardian and staff Ghana Card, SSNIT numbers | **High** | Identity theft. Encrypted, blind-indexed, masked, reveal is audited. |
| Home addresses, pickup authorisations, custody notes | **High** | Physical safety of a child (who may collect the child, where the child lives). |
| Payment records, receipts, ledger | **High** (integrity) | Money; fraud; disputes with parents. Append-only. |
| Audit log | **High** (integrity) | Evidence of who saw a child's data. Append-only, hash chain. |
| Credentials, sessions, MFA secrets, master key | **Critical** | Key to everything above. |
| Uploaded documents (birth certificates, report cards, photos) | **High** | Identity documents of children; malware carrier. |
| Backups | **Critical** | Full copy of everything. Encrypted before leaving the server. |

## 2. Actors

| Actor | Trust | Typical motive |
|---|---|---|
| Staff user acting within role | Trusted for their role only | Doing their job. |
| **Insider misuse** (curious or malicious staff, e.g. teacher looking up a child outside their class, bursar altering a receipt, ex-staff whose account was not disabled) | Partially trusted | Curiosity, fraud, custody dispute favour, revenge. **Most likely threat for a school.** |
| Parent / guardian (no account in v1) | Untrusted | Wants another family's data, wants to dispute fees. |
| Estranged parent / person without custody | Untrusted | Wants a child's location or pickup authority. |
| Student (older JHS pupil) on a staff laptop | Untrusted | Change marks, attendance, fees. |
| Opportunistic thief | Untrusted | Steals the server, a laptop or the backup disk. |
| Remote attacker | Untrusted | Ransomware, data theft, defacement if the server is exposed. |
| Supplier with access (IT contractor, SMS provider) | Partially trusted | Data mining, careless handling. |

## 3. System and data flows

```
 [Staff browser] --HTTPS (TLS 1.2+)--> [Caddy] --HTTP (docker network)--> [API (NestJS)] --SQL--> [PostgreSQL]
                                          |                                  |   \--> [File store volume]
                                          |                                  |   \--> [ClamAV clamd TCP 3310]
                                          |                                  \--enqueue--> [pg-boss in PostgreSQL]
                                          |                                                     |
                                          |                                             [Worker] --HTTPS--> [SMS provider]
                                          |                                                     \--> PDFs, exports, scans
 [Admin laptop] --SSH/console--> [Server host] --> [Backup job] --age/GPG encrypted--> [Local backup disk] --> [Off-site object store]
```

Data flows (DF):

| ID | From → To | Data |
|---|---|---|
| DF1 | Browser → Caddy | Credentials, session cookie, CSRF token, all personal data, uploads |
| DF2 | Caddy → API | Same, plain HTTP inside the host's private Docker network |
| DF3 | API ↔ PostgreSQL | All records, sessions, audit |
| DF4 | API ↔ File store | Uploaded files, generated PDFs and exports |
| DF5 | API/Worker → clamd | Uploaded file bytes (INSTREAM) |
| DF6 | Worker → SMS provider | Guardian phone numbers, message text (fee reminders, absence alerts) |
| DF7 | Backup → local disk → off-site | Full database + WAL + file store, encrypted |
| DF8 | Admin laptop → server | Shell access, `.env`, master key file, restore operations |

## 4. STRIDE per component

Legend: **S** spoofing, **T** tampering, **R** repudiation, **I** information disclosure, **D** denial of service, **E** elevation of privilege.

### 4.1 Browser (staff laptop or phone)

| # | Threat | Control |
|---|---|---|
| S | Session cookie stolen by XSS and replayed | Cookie `__Host-sms_session`, `HttpOnly; Secure; SameSite=Strict; Path=/`. Strict CSP (no inline script, `default-src 'self'`). React escapes output. Session bound to server-side row that can be revoked. |
| S | Password guessed or reused from another breach | Min 12 characters, offline check against bundled common/breached password list, Argon2id, lockout after 5 failures (15 min, progressive), MFA (mandatory for ADMIN and BURSAR). `apps/api/src/security/password-policy.ts`, `auth.service.ts`. |
| S | Shared staff laptop left signed in | Idle timeout 30 min, absolute 12 h, logout button revokes the server session. Admin can force logout. |
| T | CSRF: another site makes the browser post a payment | SameSite=Strict cookie **and** synchroniser token in `X-CSRF-Token` checked on every non-GET route (`security/permission.guard.ts`). CORS not enabled (same origin only). |
| T | Student edits page HTML to submit hidden fields (mass assignment) | Strict Zod request schemas (`z.strictObject`) reject unknown fields. Server decides permissions, never the UI. |
| I | Data left in browser storage on a shared laptop | No personal data in `localStorage`; API responses `Cache-Control: no-store`. Downloads via `Content-Disposition: attachment`. |
| I | Shoulder surfing, phone left unlocked during Emergency View | Ghana Card masked by default; medical detail behind a separate permission; Emergency View shows alert summary only. Staff confidentiality guidance (`data-protection/staff-confidentiality.md`). |
| R | User denies having viewed or changed a record | Audit event per view of sensitive data and per change, with user, session, IP, request id. |
| E | Teacher opens another class's student by guessing an id | Object-level scope (`ScopeService`): out-of-scope ids return **404**. UUIDv7 ids are not secret but are not enough on their own. |

### 4.2 Caddy (reverse proxy)

| # | Threat | Control |
|---|---|---|
| S | Fake server on the LAN intercepts logins (rogue Wi-Fi) | HTTPS everywhere; internal CA root installed on staff devices for LAN mode, Let's Encrypt in cloud mode. HSTS. HTTP only redirects. |
| T | TLS downgrade / weak ciphers | Caddy defaults (TLS 1.2+, modern ciphers). |
| I | Headers leak server version | `-Server` header removed; Helmet in the API as a second layer. |
| I | Directory listing / serving backup or `.env` files | Caddy serves only the built web app directory and proxies `/api/*`. No file server on other paths. Uploaded files never under the web root. |
| D | Request floods, slowloris | Caddy timeouts, request body limit (10 MB for upload routes, 1 MB JSON in the API), API rate limits. On a LAN the realistic DoS is accidental, not malicious. |
| E | Admin endpoints exposed to the internet in cloud mode | Only 80/443 published. PostgreSQL, clamd and the API port are bound to the Docker network only. |

### 4.3 API (NestJS)

| # | Threat | Control |
|---|---|---|
| S | Request without a session reaches a handler | Global `PermissionGuard`, deny by default. A route without `@RequirePermission` / `@Public` / `@Access` is refused **and** fails the CI gate `test:rbac-coverage` (`apps/api/test/d/rbac-coverage.int-spec.ts`). |
| S | Session fixation | New session id generated on login and again after MFA; old row revoked. Session ids are 256-bit random, only the SHA-256 hash is stored. |
| S | MFA bypass by calling other routes while MFA pending | MFA-pending sessions may only call `mfa-pending-session` routes (verify, logout, me). ADMIN/BURSAR without MFA may only call enrolment routes until enrolled. |
| S | User enumeration via login / reset timing or messages | Same message and status for unknown user and wrong password; dummy Argon2 verification for unknown users; reset request always returns 202. |
| T | SQL injection | Kysely parameterised queries only; raw SQL uses `sql` template tags with bound values. |
| T | Changing someone else's record (IDOR on PATCH) | Scoped repositories; out of scope = 404. |
| T | Replay of a payment POST creates a second payment | `Idempotency-Key` stored in `idempotency_records` in the same transaction; reused key with different body = 422. |
| T | Editing ledger / payments / audit | DB triggers forbid UPDATE/DELETE; app DB role has no UPDATE/DELETE grant on those tables; corrections are reversal rows. |
| R | Staff deny an action | `AuditService` writes the event in the **same transaction** as the change, so there is no change without an audit row. Hash chain detects later edits by a DB superuser. |
| I | Over-sharing in responses (bursar sees medical) | `FieldPolicy` drops fields per role before serialisation; separate permissions for medical and Ghana Card reveal. |
| I | Stack traces and SQL errors in responses | `ProblemFilter` returns problem+json with request id only. |
| I | Secrets or personal data in logs | Pino redaction; audit masks sensitive values (`security/masking.ts`); no request bodies logged. |
| I | Errors reveal whether a record exists outside scope | Out of scope = 404, the same as not found. |
| D | Password hashing used as a CPU DoS | Rate limit per IP and per IP+username on login (before hashing). Argon2id parameters sized for the 2 vCPU server (`19 MiB, t=2, p=1`, OWASP minimum). |
| D | Large or many uploads fill the disk | Per-type size limits, request body limits, disk-space alert (Agent H). |
| D | Expensive search/export abused | Rate limits on search and exports; exports async with 24 h expiry. |
| E | Role escalation: a user edits their own roles | `users:update` only for ADMIN; a user cannot change their own roles or unlock themselves; role changes always audited and revoke sessions of the changed user. |
| E | Bursar records and approves the same adjustment / ADMIN records payments | Maker–checker enforced in finance (DB `CHECK approved_by <> requested_by`) and in the RBAC matrix (ADMIN has no `payments:create`). |

### 4.4 Worker (pg-boss jobs: SMS, PDFs, exports, scans, chain verification)

| # | Threat | Control |
|---|---|---|
| S | Forged job inserted to send SMS to all parents | Only the API and worker DB roles can insert into `pgboss`; bulk messages above 50 recipients need ADMIN approval recorded on the message row. |
| T | Job payload tampered | Jobs carry ids only; the worker re-reads the record and its approval state from the database. |
| I | Export files readable by other users | Exports stored in the file store with random keys, downloadable only by the owner (`owner-of-export`), expire after 24 h. |
| D | Poison job loops forever | pg-boss retry limit (max 5) with backoff, dead-letter. |
| E | Template injection in SMS (placeholders) | Placeholder allow-list per template (Agent F). |

### 4.5 PostgreSQL

| # | Threat | Control |
|---|---|---|
| S | Network access to the DB from the LAN | Port not published; only the Docker network; strong generated password; `scram-sha-256`. |
| T | DBA or attacker with SQL access edits receipts or audit | Append-only triggers, no grants, audit hash chain verified daily (job `audit.verify-chain`) and on demand (`POST /audit-events/verify`). A superuser can still disable triggers; the hash chain detects edits **after** the fact unless they recompute the whole chain. Daily chain head hash written to the log/backup gives an external anchor. |
| I | Database dump stolen (from a backup or SQL injection) | Field encryption (AES-256-GCM envelope) for medical text, Ghana Card, SSNIT, MFA secrets. Master key **not** in the database or the backup. Full-disk encryption on the server. |
| D | Power cut corrupts data | `fsync`, `full_page_writes`, `synchronous_commit` on; UPS; WAL archiving (Agent H). |
| E | App role escalates to owner | Separate roles: `sms_owner` (migrations only), `sms_app`, `sms_audit_writer`, `sms_readonly`. |

### 4.6 File store (local volume)

| # | Threat | Control |
|---|---|---|
| T | Malware uploaded (e.g. infected PDF from a parent's phone) | Magic-byte allow-list, size limits, PDF sanity (no JavaScript, Launch, EmbeddedFile, XFA), image re-encode with sharp (strips EXIF/GPS and polyglot payloads), ClamAV INSTREAM scan when enabled; files stay `pending` and cannot be downloaded until `clean`; infected files quarantined. `security/upload-pipeline.service.ts`. |
| T | Path traversal via file name | Storage key is random (`randomUUID`), original name stored only as metadata and sanitised on download. |
| I | Stored XSS via SVG/HTML upload served inline | SVG, HTML, XML and unknown types rejected. Downloads always `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox`. |
| I | File ids guessed | Download goes through the owning record's permission (`inherits-from-owning-record`) and scope check. |
| D | Zip bomb / decompression bomb | XLSX import parsed with size limits (Agent G); images limited by `sharp` `limitInputPixels`; ZIP containers other than XLSX rejected. |

### 4.7 Backups

| # | Threat | Control |
|---|---|---|
| I | Backup disk or off-site bucket stolen | Encrypted with age/GPG **before** it leaves the server; the decryption key is held offline by the head and the administrator (sealed envelope in the school safe). |
| I | Master key in the backup | `SMS_MASTER_KEY_FILE` is excluded from the database backup; a separate offline copy is kept with the backup key. Losing it means encrypted fields are unrecoverable: documented in the runbook. |
| T | Backup replaced with a doctored one | Checksums; restore drill verifies the audit chain and receipt sequence (CP6). |
| D | Ransomware encrypts the server and the attached backup disk | Off-site copy with object lock / versioning where the provider supports it; backup credentials are write-only (cannot delete). |

### 4.8 SMS provider (v1: mock; later a Ghana provider)

| # | Threat | Control |
|---|---|---|
| I | Provider sees phone numbers and message text | Minimum content: no medical, no amounts beyond the reminder, no child's full name where not needed. Data processing agreement with the provider before go-live (Act 843 processor obligations). |
| S | Fake delivery reports | Webhooks (v2) authenticated; v1 polls only. |
| I | API key leaked | Key in a secret file, not in Git; provider IP allow-list if available. |

### 4.9 Admin laptop and the server host

| # | Threat | Control |
|---|---|---|
| S | Admin laptop compromised, attacker gets SSH | SSH keys only (no passwords), key with passphrase, fail2ban, SSH only from the LAN. |
| I | `.env` or master key copied to a USB stick | Secrets in `/etc/sms/secrets` with `0400` root-only permissions, mounted as Docker secrets. Written procedure (Agent H runbook). |
| E | Admin uses the DB superuser for daily work | Runbook: day-to-day admin is through the app; DB shell only for restore. |

## 5. Children's data focus

1. **Minimum necessary**: TEACHER sees only students in classes assigned to them today (`staff_class_assignments` with `start_date <= today` and `end_date` null or `>= today`), without home address. BURSAR sees billing fields only.
2. **Medical** is in a separate table and permission. Emergency View shows the short alert summary to anyone with `emergency_view:read`, and every opening is audited (`emergency_view`).
3. **"Who looked at this child?"** Every audit event that concerns a student stores `student_id`, so the head can answer a parent's question quickly (`GET /audit-events?studentId=`).
4. **Pickups and custody**: pickup list changes are audited; only REGISTRAR/ADMIN may change them.
5. **Photos**: re-encoded, metadata stripped (GPS location of a child's home in EXIF is a real risk).
6. **Retention and anonymisation**: records past their retention period appear in `/retention/candidates`; anonymisation keeps the permanent student code and finance totals only (`data-protection/retention-schedule.md`).

## 6. On-premise server theft

Scenario: someone carries away the mini server (or its disk) at night.

| Layer | Effect |
|---|---|
| Full-disk encryption (LUKS) with a passphrase entered at boot, or TPM + PIN (Agent H) | Disk is unreadable without the passphrase. **Trade-off:** after a power cut someone must type the passphrase; documented in the runbook. If the school chooses unattended boot (TPM only), the next layers matter more. |
| Master key in a separate file (`SMS_MASTER_KEY_FILE`) on the encrypted disk | Field-encrypted columns stay protected if only a DB dump leaks. |
| Encrypted off-site backup | The school can restore on new hardware (CP6, RTO 4 h). |
| Breach procedure | Theft of the server is a personal-data breach: follow `data-protection/breach-response.md` (notify the Data Protection Commission and affected parents). |
| Physical | Server in a locked cabinet, in a locked room, UPS in the same cabinet. |

## 7. Insider misuse scenarios

| Scenario | Prevention | Detection |
|---|---|---|
| Teacher browses other classes' children | Scope 404 | Audit `view` events; head reviews monthly. |
| Bursar takes cash and does not record it / records less | Cash-up with counted vs expected, gap-free receipts, receipts printed for parents | Reconciliation report; parents hold receipts. |
| Bursar reverses a payment after pocketing cash | Reversal after cash-up close needs ADMIN approval; reversed receipts keep their number | Reversal report, audit `reverse`. |
| Admin creates a fake user to hide actions | Role changes audited; user list review | Audit `create user`; chain verification. |
| Staff export a class list with phone numbers for private business | `students:export` limited; exports always audited | Audit `export` events. |
| Leaver keeps access | Admin disables account, force logout revokes all sessions immediately | User list "last login" column. |
| DB administrator edits audit rows | Triggers + no grants | Daily hash-chain verification fails loudly. |

## 8. Residual risks (accepted unless the school decides otherwise)

| Risk | Why accepted | Mitigation |
|---|---|---|
| A database superuser can disable triggers and rewrite history including the hash chain | Single-server deployment; the operator is the school's own admin | External anchor: daily chain head hash logged and included in backups; restore drill compares. |
| Unattended reboot vs disk encryption | Power cuts are frequent | School chooses; documented. |
| SMS content passes through a third party | Needed for the service | Minimal content; processing agreement. |
| Staff phones used for Emergency View | Needed for emergencies | Session timeouts, no data cached offline, MFA where possible. |
| Rate limiter is in memory (single API process) | One server, one API process | If the API is ever scaled out, move limiter to PostgreSQL (`login_attempts` already drives lockout). |
| No WAF | Small LAN deployment | Strict input validation, CSP, rate limits. |

## 9. Control index (where to look)

| Control | Location |
|---|---|
| Permission guard, CSRF, MFA-pending handling | `apps/api/src/security/permission.guard.ts`, `login-phase.decorator.ts`, CSRF in `session.service.ts` |
| Sessions | `apps/api/src/security/session.service.ts`, `session-resolver.impl.ts` |
| Password policy and hashing | `apps/api/src/security/password-policy.ts`, `password-hasher.ts` |
| TOTP and recovery codes | `apps/api/src/security/totp.ts` |
| Field encryption, blind index, key rotation | `apps/api/src/security/field-crypto.service.ts`, `apps/api/src/security/cli/rotate-keys.ts` |
| Upload pipeline and ClamAV | `apps/api/src/security/upload-pipeline.service.ts`, `clamav.ts`, `file-sniffer.ts` |
| Audit writer, masking, chain verification | `apps/api/src/security/audit.service.impl.ts`, `masking.ts`, `apps/api/src/modules/audit/` |
| Rate limiting | `apps/api/src/security/rate-limiter.ts` (login, MFA, password reset; search/export limits are defined in `RATE_LIMITS` for modules to call) |
| Scope and field policy | `apps/api/src/security/scope.service.impl.ts`, `field-policy.impl.ts` |
| Security test plan | `docs/security/security-test-plan.md` |
| Data protection (Act 843) | `docs/security/data-protection/` |
| Idempotency | `apps/api/src/security/idempotency.impl.ts` |
| Security headers | `apps/api/src/security/security-headers.ts` |
| Key management | `docs/security/key-management.md` |
