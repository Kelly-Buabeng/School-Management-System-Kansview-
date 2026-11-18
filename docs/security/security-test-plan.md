# Security test plan (for the CP5 independent reviewer)

- Owner: Agent D. Used by the independent review agent at checkpoint CP5 (`docs/contracts/definition-of-done.md`).
- Target: the running system from `infra/` Compose on the integration branch, seeded with fake data (`db/seeds`), plus source code and images.
- Rules of engagement: test environment only, fake data only. Do not attack the shared PostgreSQL server outside the test databases.
- Severity: **Critical** (child data or money exposed / changed without authorisation, auth bypass), **High** (privilege escalation within the app, audit bypass, stored XSS), **Medium** (information leak with limited impact, missing hardening header), **Low** (best practice).
- Exit criteria for CP5: all Critical and High fixed and retested; Medium fixed or accepted in writing by the Orchestrator.

Automated tests already in the repository are listed in the last column; the reviewer should re-run them **and** test manually against the running stack.

## Test accounts

Create one user per role with the seed or `POST /users` as ADMIN: `admin1` (ADMIN), `bursar1` (BURSAR), `head1` (HEADTEACHER), `reg1` (REGISTRAR), `teacher1` (TEACHER assigned to one class only), `teacher2` (TEACHER, other class), plus `admin_bursar` (ADMIN + BURSAR).

## 1. Authentication

| ID | Test | Pass criteria | Automated |
|---|---|---|---|
| AUTH-01 | Login with wrong password for an existing user and with an unknown username | Same status (401), same `code` (`AUTH_INVALID_CREDENTIALS`), same body shape; response times within ±50 ms on median of 20 tries | `test/d/auth.int-spec.ts` |
| AUTH-02 | 5 wrong passwords then the right one | 6th attempt returns 423 `AUTH_ACCOUNT_LOCKED`; still locked with the right password for 15 min; lock lengthens on repeated lockouts | `auth.int-spec.ts` |
| AUTH-03 | Lockout cannot be used to enumerate users | Unknown username after 5 tries returns the same 423/401 pattern as a real one (or never reveals existence) | manual |
| AUTH-04 | Password policy | < 12 chars rejected; `password1234`, `Password123!`, `qwertyuiop12` rejected (breached list); a 4-word passphrase accepted; no composition rule enforced | `password-policy.spec.ts` |
| AUTH-05 | Argon2id hashes in DB | `users.password_hash` starts with `$argon2id$v=19$m=19456,t=2,p=1` or stronger | `password-hasher.spec.ts` |
| AUTH-06 | MFA mandatory for ADMIN/BURSAR | Login of an ADMIN without MFA returns `mfaEnrolmentRequired: true`; any other route (e.g. `GET /students`) returns 403 `AUTH_MFA_ENROLMENT_REQUIRED` until enrolled | `auth.int-spec.ts` |
| AUTH-07 | MFA-pending session | After password step with MFA on, all routes except `/auth/mfa/verify`, `/auth/logout`, `/auth/me` return 401/403 | `auth.int-spec.ts` |
| AUTH-08 | TOTP replay and brute force | Same code cannot be used twice within its window; MFA attempts count towards lockout | `totp.spec.ts`, manual |
| AUTH-09 | Recovery codes | Each code works once; stored hashed; regenerating invalidates old codes | `totp.spec.ts`, `auth.int-spec.ts` |
| AUTH-10 | Disable MFA as ADMIN/BURSAR | 422 refused | `auth.int-spec.ts` |
| AUTH-11 | Password reset request | Always 202 for existing and unknown accounts; rate limited | `auth.int-spec.ts` |
| AUTH-12 | Reset token single use and expiry | Second use returns 400 `AUTH_RESET_TOKEN_INVALID`; token older than 30 min rejected; only the hash in `password_reset_tokens` | `auth.int-spec.ts` |
| AUTH-13 | Password change / reset revokes other sessions | Old session cookies return 401 after change | `auth.int-spec.ts` |
| AUTH-14 | Admin-created users must change temporary password | `mustChangePassword: true`; all routes except password change, me, logout refused until changed | `users.int-spec.ts` |

## 2. Sessions

| ID | Test | Pass criteria | Automated |
|---|---|---|---|
| SES-01 | Cookie flags | `__Host-sms_session`; `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, no `Domain` | `auth.int-spec.ts` |
| SES-02 | Session fixation | Set a cookie before login → after login the id is different; id changes again after MFA verify | `auth.int-spec.ts` |
| SES-03 | Idle timeout | No request for 30 min → 401 `AUTH_SESSION_EXPIRED` | `session.service.spec.ts`, `auth.int-spec.ts` (clock) |
| SES-04 | Absolute timeout | Active use for 12 h → 401 | same |
| SES-05 | Logout | Cookie cleared and the old cookie value returns 401 | `auth.int-spec.ts` |
| SES-06 | Force logout by ADMIN | All of the target user's sessions return 401 immediately | `users.int-spec.ts` |
| SES-07 | Session ids not stored in clear | `user_sessions.id` is a SHA-256 hash, not the cookie value | `auth.int-spec.ts` |
| SES-08 | Role change takes effect | Removing a role revokes the user's sessions | `users.int-spec.ts` |

## 3. Authorisation (RBAC, IDOR, field rules)

| ID | Test | Pass criteria | Automated |
|---|---|---|---|
| RBAC-01 | Every route declares a permission | `pnpm --filter @sms/api test:rbac-coverage` passes; no route without metadata | `test/d/rbac-coverage.int-spec.ts` |
| RBAC-02 | Role × permission matrix matches `rbac.md` | Matrix test passes; reviewer spot-checks 20 cells by calling real endpoints with each role | `security/permissions.spec.ts` |
| RBAC-03 | Per-role privilege escalation | For each role, call every endpoint the role must not reach → 403 (never 200/500) | per-module int-specs + manual script |
| RBAC-04 | IDOR on every `/:id` route | TEACHER1 requesting a student of TEACHER2's class → 404 on profile, guardians, attendance, scores, emergency view, documents | B's int-specs + manual |
| RBAC-05 | Field rules | BURSAR `GET /students/{id}` has no medical, no address; TEACHER has no address; REGISTRAR sees balance total only; incidents visible only to ADMIN, HEADTEACHER, author | `field-policy.spec.ts` + manual |
| RBAC-06 | Ghana Card | Non-reveal responses show `ghanaCardLast4` only; reveal requires ADMIN + reason and writes `reveal_sensitive` audit | B's tests + manual |
| RBAC-07 | Self-escalation | A non-ADMIN cannot call `/users/*`; an ADMIN cannot remove their own last ADMIN role or unlock themselves | `users.int-spec.ts` |
| RBAC-08 | Separation of duties | ADMIN (without BURSAR) gets 403 on `POST /payments`; adjustment approver must differ from requester | C's tests |
| RBAC-09 | Mass assignment | Add `roles`, `status`, `studentCode`, `createdBy`, `id` to request bodies → 400 (unknown field) | per-module tests + manual |

## 4. Input handling and web vulnerabilities

| ID | Test | Pass criteria |
|---|---|---|
| WEB-01 | SQL injection in search, filters, sort | No SQL errors, no extra rows; sort values outside the allow-list → 400 |
| WEB-02 | Stored XSS in names, notes, remarks, template bodies | Rendered as text in the web app and PDFs; CSP blocks inline script |
| WEB-03 | CSRF | Any non-GET without `X-CSRF-Token` or with a token from another session → 403 `CSRF_INVALID` (automated in `auth.int-spec.ts`) |
| WEB-04 | CORS | `Origin: https://evil.example` gets no `Access-Control-Allow-Origin` |
| WEB-05 | SSRF | No endpoint fetches a user-supplied URL (code review: grep for `fetch(`, `http.request` with user input) |
| WEB-06 | Security headers | `Strict-Transport-Security`, `Content-Security-Policy` (no `unsafe-inline` for scripts), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` / `frame-ancestors 'none'`, `Permissions-Policy`, no `X-Powered-By` |
| WEB-07 | Error leakage | Force errors (bad UUID, huge body, malformed JSON) → problem+json without stack trace or SQL |
| WEB-08 | Request size | JSON body > 1 MB → 413; upload > policy size → 413 `FILE_TOO_LARGE` |
| WEB-09 | Idempotency | Same `Idempotency-Key` + same body → same response, one record; same key + different body → 422 `IDEMPOTENCY_KEY_REUSED` (`idempotency.int-spec.ts`) |

## 5. Uploads

| ID | Test | Pass criteria | Automated |
|---|---|---|---|
| UP-01 | EICAR test file (as `.pdf`, `.jpg`, renamed) with ClamAV on | Rejected (or quarantined, `scan_status=infected`), never downloadable | `upload-pipeline.spec.ts` (mocked clamd) + manual on stack |
| UP-02 | SVG, HTML, XML, JS renamed to `.png` / `.pdf` | 415 `FILE_TYPE_NOT_ALLOWED` | `file-sniffer.spec.ts` |
| UP-03 | Polyglot (valid JPEG with HTML/PHP/JS appended; PDF+ZIP) | Image re-encoded (payload gone) or rejected; PDF with trailing ZIP/JS rejected | `upload-pipeline.spec.ts` |
| UP-04 | PDF with `/JavaScript`, `/JS`, `/Launch`, `/EmbeddedFile`, `/XFA`, `/OpenAction` with JS | Rejected | `file-sniffer.spec.ts` |
| UP-05 | Oversized file and decompression bomb image (e.g. 50 000 × 50 000 PNG) | Rejected without exhausting memory | `upload-pipeline.spec.ts` |
| UP-06 | EXIF/GPS in a JPEG | Stored file has no EXIF | `upload-pipeline.spec.ts` |
| UP-07 | File name with `../`, NUL, very long, RTL override | Stored under random key; download name sanitised | `upload-pipeline.spec.ts` |
| UP-08 | Download of `pending` / `infected` file | 404 / 409 `FILE_NOT_READY` | F's tests |
| UP-09 | Download headers | `Content-Disposition: attachment`, `nosniff`, `Content-Security-Policy: sandbox` | F's tests |
| UP-10 | Zip bomb as XLSX import | Rejected by size/ratio limits | G's tests |

## 6. Rate limiting and lockout

| ID | Test | Pass criteria |
|---|---|---|
| RL-01 | 20 login attempts per minute from one IP for one username | 429 with `Retry-After` after the limit (`rate-limiter.spec.ts`, `auth.int-spec.ts`) |
| RL-02 | Password spraying: many usernames from one IP | Per-IP limit applies (429) |
| RL-03 | Password reset requests | Limited per IP and per account; still 202-shaped body when not limited |
| RL-04 | Search and exports | 429 above the configured limit |

## 7. Audit and integrity

| ID | Test | Pass criteria | Automated |
|---|---|---|---|
| AUD-01 | `UPDATE audit.events SET ...` and `DELETE` as the app role and as owner | Both fail (trigger) | `test/d/audit.int-spec.ts` |
| AUD-02 | Hash chain verification | `POST /audit-events/verify` returns intact; after a superuser disables the trigger and edits a row, verification reports the first broken id | `audit.int-spec.ts` |
| AUD-03 | Always-audited actions (rbac.md list) | Each produces exactly one event with actor, session, IP, request id, student id where relevant | per-module tests |
| AUD-04 | Audit masks sensitive values | No Ghana Card, password, MFA secret, medical text, full phone number in `changes` | `masking.spec.ts` |
| AUD-05 | Audit in same transaction | Business change rolled back ⇒ no audit row; audit insert failure ⇒ business change rolled back | `audit.int-spec.ts` |
| AUD-06 | Ledger tampering | `UPDATE`/`DELETE` on `ledger_entries`, `payments` (except status guard) fail | A's and C's tests |
| AUD-07 | Login success and failure audited | `login` / `login_failed` events present | `auth.int-spec.ts` |

## 8. Cryptography and secrets

| ID | Test | Pass criteria | Automated |
|---|---|---|---|
| CRY-01 | Encrypted columns in a dump | `pg_dump` shows no plaintext medical text, Ghana Card or MFA secrets | manual |
| CRY-02 | Round-trip and tamper | Decrypt(Encrypt(x)) = x; flipping one byte fails authentication | `field-crypto.service.spec.ts` |
| CRY-03 | Key rotation | After adding a new master key and running `rotate-keys`, all rows use the new key id and decrypt; old key can be retired | `field-crypto.service.spec.ts`, `rotate-keys.int-spec.ts` |
| CRY-04 | Blind index | Same normalised value → same index; uses a key separate from the encryption key | `field-crypto.service.spec.ts` |
| CRY-05 | Secrets in repository and images | gitleaks and Trivy clean; no `.env`, keys or real data committed | CI (Agent H) |
| CRY-06 | Master key file permissions | `0400`, owned by the container user; startup refuses world-readable key file in production | `field-crypto.service.spec.ts` |

## 9. Dependencies and infrastructure

| ID | Test | Pass criteria |
|---|---|---|
| DEP-01 | `pnpm audit --prod`, osv-scanner | No High/Critical |
| DEP-02 | Container images (Trivy) | No High/Critical with a fix available; non-root users; read-only root FS |
| INF-01 | Exposed ports | Only 80/443 on the host; PostgreSQL 5432 and clamd 3310 not reachable from the LAN |
| INF-02 | Backup encryption | Backup file is not readable without the age/GPG key; master key not in the backup |

## 10. Data protection (Act 843) checks

| ID | Test | Pass criteria |
|---|---|---|
| DPA-01 | Subject access export | Contains all data about the student (profile, guardians links, enrolments, attendance, scores, finance, medical, documents list, audit "who viewed"); audited as `export` |
| DPA-02 | Anonymise | Requires typed confirmation of the student code; personal fields replaced; `student_code` and finance totals kept; `retention_actions` row written; irreversible; audited |
| DPA-03 | Retention candidates | Students who left more than the configured period ago appear; active students never appear |
| DPA-04 | DSR due date | New request has `due_at = received_at + 21 days` (policy to confirm with the Data Protection Commission) |
