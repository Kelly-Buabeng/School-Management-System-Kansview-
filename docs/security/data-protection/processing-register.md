# Processing register

- Controller: Kansview school (legal name, address and DPC registration number to be filled in).
- Data protection lead: _name, phone, email_.
- Last reviewed: 2026-11-18 (draft). Review yearly and whenever a new kind of data or a new supplier is added.
- **[CONFIRM]** every lawful basis below with a lawyer. "Contract" means the school's agreement with the parent to educate the child; "legal obligation" means a duty under Ghanaian law (for example tax or education regulations); "vital interests" means protecting a child's life or health; "consent" means the parent's informed agreement, which can be withdrawn.

## 1. Data about pupils

| Data category | Examples (fields) | Purpose | Lawful basis | Who can see it in the system | Retention |
|---|---|---|---|---|---|
| Identity | Name, preferred name, date of birth, gender, nationality, student code, photo, birth certificate number | Admission, identification, registers, report cards | Contract | All staff roles (TEACHER: own classes only) | Personal fields: until **7 years after leaving**, then anonymised. Student code kept permanently |
| Contact and home | Home address | Safeguarding, emergencies, correspondence | Contract | ADMIN, HEADTEACHER, REGISTRAR | 7 years after leaving |
| Family | Guardians linked, siblings (derived), who lives with the child, who may pick up | Safeguarding, emergencies, billing | Contract; vital interests (pickups) | ADMIN, REGISTRAR full; others limited (see rbac.md) | 7 years after leaving |
| Health (**special data**) | Allergies, chronic conditions, medication notes, special needs, blood group, doctor/clinic | Keeping the child safe at school, first aid, emergencies | Vital interests; explicit consent of parent for non-urgent details **[CONFIRM]** | Full detail: ADMIN, HEADTEACHER, REGISTRAR. Alert summary: everyone with Emergency View | Deleted (blanked) at anonymisation |
| Health visits (sick bay) | Complaint, treatment, sent home | Care of the child, informing parents | Vital interests | ADMIN, HEADTEACHER, REGISTRAR; TEACHER can record for own classes | 7 years after leaving, then blanked |
| Discipline / incidents (**sensitive**) | Description, action taken, follow-up | Pastoral care, safeguarding | Contract / legitimate school interest **[CONFIRM]** | ADMIN, HEADTEACHER, the staff member who wrote it | 7 years after leaving, then blanked |
| Attendance | Present/absent/late, reason | Registers, safeguarding (absence alerts), reports | Legal obligation / contract **[CONFIRM]** | Class teacher (own classes), REGISTRAR, HEADTEACHER, ADMIN | Kept with anonymised record (notes blanked) |
| Academic | Scores, grades, positions, remarks, report cards | Education, reports to parents, promotion | Contract | Teachers (own classes), HEADTEACHER, ADMIN | Kept with anonymised record (remarks blanked) |
| Documents | Birth certificate, previous reports, transfer letters (files) | Admission evidence | Contract | ADMIN, HEADTEACHER, REGISTRAR | Archived at anonymisation; files deleted from storage by the storage retention job **[to build in v1.1]** |
| Finance | Invoices, payments, receipts, discounts, balance | Fee collection, accounting | Contract; legal obligation (accounting and tax records) | ADMIN, BURSAR, HEADTEACHER; REGISTRAR sees balance total only | **Kept** for the statutory period (see retention schedule); linked to the student code only after anonymisation |
| Emergency contact log | Who was called, when, outcome | Evidence that parents were contacted | Vital interests | ADMIN, HEADTEACHER, REGISTRAR | 7 years (append-only) |

## 2. Data about parents and guardians

| Data category | Examples | Purpose | Lawful basis | Who can see it | Retention |
|---|---|---|---|---|---|
| Identity and contact | Name, title, phone numbers, WhatsApp, email | Contacting about the child, emergencies, fee reminders | Contract | All roles (limited fields for BURSAR/TEACHER) | Until 7 years after their last child leaves, then anonymised |
| Work and address | Occupation, workplace, home and work address | Emergencies, safeguarding | Contract | ADMIN, HEADTEACHER, REGISTRAR | Same |
| Ghana Card number | Encrypted; last 4 digits shown | Verifying identity of fee payers and pickup persons | Legitimate interest / consent **[CONFIRM]** | ADMIN only, by an audited "reveal" with a reason | Same; erased at anonymisation |
| Messages sent | Phone number, message text, delivery status | Fee reminders, absence alerts, announcements | Contract | ADMIN, HEADTEACHER, senders | Message bodies blanked after 365 days |

## 3. Data about staff and system users

| Data category | Examples | Purpose | Lawful basis | Who can see it | Retention |
|---|---|---|---|---|---|
| Staff records | Name, contact, job title, employment date, emergency contacts | Employment, class assignments | Contract of employment | ADMIN, HEADTEACHER full; others limited | Employment + period required by labour/tax law **[CONFIRM]** |
| Staff identifiers | Ghana Card, SSNIT number (encrypted) | Payroll, statutory contributions | Legal obligation | ADMIN by audited reveal | Same |
| User accounts | Username, roles, password hash, MFA settings, login history | Secure access | Legitimate interest (security) / legal obligation (security safeguards) | ADMIN | Login attempts 90 days; account record while employed + 1 year |
| Audit log | Who did what, when, from which computer | Accountability, investigating misuse | Legal obligation (security safeguards) / legitimate interest | ADMIN; HEADTEACHER read-only | 7 years |

## 4. Recipients and transfers

| Recipient | Data | Why | Safeguard |
|---|---|---|---|
| SMS provider (processor) | Parent phone number, message text | Sending messages | Processor agreement; minimum content (no health data in SMS) |
| Off-site backup provider (processor) | Encrypted backup files | Disaster recovery | Encrypted before upload; provider cannot read them |
| IT support contractor (processor) | Access to server when needed | Maintenance | Processor agreement, supervised access, audit |
| Receiving school (on transfer) | Transfer letter, report summary | Continuity of education | Sent only on parent's request or as required **[CONFIRM]** |
| Ghana Education Service / authorities | Statistics, records when legally required | Legal obligation | Only what the law requires |

**Transfers outside Ghana:** the off-site backup provider may store data abroad (for example Backblaze B2 or AWS). Backups are encrypted before they leave the school and the key stays in Ghana. **[CONFIRM]** whether the Act's rules on transfers abroad still require notice to parents or DPC approval.
