# Personal data breach response

A **personal data breach** is any loss, theft, or unauthorised access, change or disclosure of personal data. Examples: the server or a backup disk is stolen; a staff laptop with exported class lists is lost; a teacher shares a child's medical details in a WhatsApp group; someone signs in with a colleague's password; the audit chain check reports tampering; ransomware.

Act 843 requires the school to notify the **Data Protection Commission** and the affected people when personal data has been accessed or acquired by an unauthorised person. **[CONFIRM]** the exact notification duty and timeline with a lawyer. **School policy: tell the DPC as soon as possible and within 72 hours of finding out**, and tell affected parents without undue delay.

## 1. Contain (first hour)

| Situation | Immediate action |
|---|---|
| Stolen or misused staff account | ADMIN: **Users → [user] → Force logout**, then **Reset password** and **Reset MFA**; disable the account if misuse is suspected |
| Server or disk stolen | Report to police; restore from the encrypted off-site backup on new hardware (operations runbook). Rotate the master key and all passwords/secrets after the restore |
| Lost laptop or phone | Force logout all of that user's sessions; change their password; ask what was downloaded (check the audit log for `export` events) |
| Wrong recipient (SMS, letter, email) | Ask the recipient to delete it; record who and when |
| Suspected tampering (audit chain broken) | Do not change anything; take a database backup immediately; call the IT contractor; keep the server running for investigation |
| Ransomware | Disconnect the server from the network; do not pay; restore from the off-site backup |

## 2. Assess (within 24 hours)

The data protection lead records in the breach log:

- what happened, when, and when it was discovered;
- what data and how many people (pupils, parents, staff). Use the audit log: `GET /audit-events?studentId=…`, filter by user, action `export` / `view` / `reveal_sensitive`;
- whether the data was encrypted (medical details, Ghana Card and SSNIT numbers are encrypted in the database and backups; a stolen database without the master key does not expose them);
- the likely harm to the children and families (physical safety, custody, discrimination, fraud).

## 3. Notify

| Who | When | How |
|---|---|---|
| Proprietor / head | Immediately | Phone |
| **Data Protection Commission** | As soon as possible, policy target 72 hours **[CONFIRM]** | Use the DPC's current breach reporting channel. Include: what happened, data and number of people affected, likely consequences, measures taken, contact person |
| **Affected parents/guardians** (and staff) | Without undue delay, especially if there is a risk to a child's safety | Letter or meeting (not a group message): what happened, what data, what the school is doing, what they can do, whom to contact |
| Police | If theft or crime | Station report; keep the reference number |
| SMS/backup provider | If their service is involved | Per the processor agreement |

Do not delay notifying while still investigating details; update the DPC later if needed.

## 4. Recover and learn

- Fix the cause (training, a missing control, a lost key procedure).
- Rotate secrets that may be exposed (passwords, the SMS provider key, the master key: see `../key-management.md`).
- Run `POST /audit-events/verify` to confirm the audit chain is intact after recovery.
- Review this procedure and the threat model; record lessons in the breach log.

## Breach log template

| Field | Entry |
|---|---|
| Reference | BR-YYYY-NN |
| Discovered (date, time, by whom) | |
| What happened | |
| Data and people affected (numbers) | |
| Encrypted? | |
| Containment actions and times | |
| Risk assessment | |
| DPC notified (date, reference) | |
| Parents notified (date, method) | |
| Root cause | |
| Follow-up actions, owner, due date | |
| Closed (date, by) | |
