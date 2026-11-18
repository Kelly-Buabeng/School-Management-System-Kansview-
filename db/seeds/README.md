# Development seed data (FAKE)

`db/seeds/seed.mjs` fills an empty database with realistic but **entirely fake** data for a Ghanaian basic school.
None of the names, phone numbers, Ghana Card numbers or addresses belong to real people. Never run it against
production.

## Run it

```bash
createdb -h localhost -U sms sms_dev                         # any empty database
SMS_DB_URL=postgres://sms:sms@localhost:5432/sms_dev pnpm --filter @sms/db seed
# another data set:  ... pnpm --filter @sms/db seed -- --seed 7
```

- Runs the migrations first, then seeds in **one transaction** (all or nothing, about 5 seconds).
- **Idempotent**: it writes a marker setting `dev.seed`. A second run does nothing.
- **Deterministic**: the same `--seed` number (default `20261117`) gives the same people, ids, amounts and receipt numbers.
  Ciphertexts differ between runs because encryption uses random IVs.
- Refuses to run on a database that already has students that the seed did not create.
- **Encryption key**: MFA secrets, Ghana Card numbers and medical notes are encrypted in the API's field-crypto format.
  The seed uses `SMS_MASTER_KEY_FILE` if it is set. If not, it creates `db/.dev-master.key` (git-ignored, mode 600) and
  prints the path. **Start the API with the same `SMS_MASTER_KEY_FILE`**, or it cannot decrypt these values and the MFA
  sign-in fails.

## Dev sign-ins (development only)

Passwords are hashed with Argon2id (m=19456, t=2, p=1), the same settings as the API's `PasswordHasher`.
`must_change_password` is false.

| Username | Role | Password | Linked staff | MFA |
|---|---|---|---|---|
| `admin` | ADMIN | `Kansview-Admin-Dev-2026!` | none | TOTP secret `JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP`; recovery codes `kans-devr-ec01`, `kans-devr-ec02`, `kans-devr-ec03` |
| `bursar` | BURSAR | `Kansview-Bursar-Dev-2026!` | the Bursar | TOTP secret `KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU`; recovery codes `kans-devr-ec11`, `kans-devr-ec12`, `kans-devr-ec13` |
| `head` | HEADTEACHER | `Kansview-Head-Dev-2026!` | the Headteacher | not enrolled |
| `registrar` | REGISTRAR | `Kansview-Registrar-Dev-2026!` | the Registrar | not enrolled |
| `teacher.kg1a`, `teacher.p1a`, `teacher.p4b`, `teacher.jhs2a` | TEACHER | `Kansview-Teacher-Dev-2026!` | class teacher of KG 1 A, Primary 1 A, Primary 4 B, JHS 2 A | not enrolled |

To get TOTP codes, add the secret to any authenticator app (SHA-1, 6 digits, 30 s), or run
`node -e "console.log(require('otplib').authenticator.generate('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'))"` from `apps/api`.
Each recovery code works once per database.

## What is generated (default seed)

| Area | Content |
|---|---|
| School | Profile `KSV` "Kansview School", 13 levels (reference migration), 14 subjects with subjects per level |
| Years | 2025/2026 (closed, 3 closed terms) and 2026/2027 (current; Term 1 current, Terms 2–3 planned) |
| Classes | 24 per year. Creche and Nursery have one class each; KG 1 to JHS 3 have streams A and B. Each class has a class teacher, and JHS classes also have 6 subject teachers |
| Staff | 45: Headteacher, assistant head, 24 class teachers, 6 JHS subject teachers, and 13 non-teaching staff |
| Students | 1,000 active (Creche 40 … JHS 86 per level), 60 alumni (last year's JHS 3, graduated by the committed promotion run) and 8 withdrawn or transferred out (completed withdrawals, transfer letters `TL-…`) |
| Families | About 660 families: 55% have one child, 30% two, 12% three, 3% four. Siblings are linked through shared guardians (`v_sibling_links`). There are about 1,050 guardians (mother and father, or a single guardian, grandparent, aunt or uncle) |
| Names | Akan and Fante day names (Kwame, Akosua, Yaw, Esi, Ekow …), Ewe, Ga, Dagbani and Hausa names, with Christian or Muslim second names. Surnames include Mensah, Owusu, Agyeman, Tetteh, Quaye, Addo, Dogbe, Amegah, Abdulai, Iddrisu and more |
| Contact | Phones only in the fake ranges `+23324000xxxx` (guardians, staff) and `+23320000xxxx` (second numbers, relatives, pickups). E-mails use `@example.com`. Addresses are in Accra, Tema and Kumasi |
| Safety | Each student has 2 emergency contacts. About 15% have an authorised pickup. About 10% have medical records; about 60% of those have an alert summary (allergy, asthma, sickle cell …) |
| Enrolment | Full history: 2025/26 enrolments are closed (completed, repeated or withdrawn) and 2026/27 enrolments are open, with roll numbers. One committed promotion run with items and arrears snapshots |
| Finance | 8 fee items. Fee structures per level for the 3 terms of 2025/26 and Term 1 of 2026/27 (all active); Term 2 of 2026/27 is still a draft. Feeding and transport are opt-ins. Invoices `INV-…` for every term attended. About 5,100 payments `RCP-…` (cash, MTN MoMo, Telecel Cash, AT Money, bank transfer, cheque) with oldest-first allocations; overpayments become credit, which is re-allocated to the next invoice. Adjustments: sibling discounts, scholarships, waivers, manual charges (approved by the headteacher), plus pending and rejected requests. 4 same-day duplicate payments are reversed (`REV-…`, `payment_reversals`). One closed cash-up per business day |

The finance rows follow the API's ledger rules: one `invoice_charge` per invoice line, a negative `payment` entry per
receipt, approved adjustments only, and reversal entries that negate the original. Descriptions and `term_id` follow
`FinanceStore`. So every student's balance is `SUM(ledger_entries.amount_pesewas)`. `db/tests/seed.test.ts` checks
this against Agent C's `LedgerService`, and checks that the API's field crypto, TOTP and Argon2 settings read the seeded
data.
