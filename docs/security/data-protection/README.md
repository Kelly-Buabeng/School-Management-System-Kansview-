# Data protection pack (Ghana Data Protection Act, 2012 (Act 843))

- Owner: Agent D (Security). Audience: head teacher, school administrator, proprietor.
- Status: **draft for the school**. These documents describe how the system and the school handle personal data. They are **not legal advice**. Every item marked **[CONFIRM]** must be checked by a Ghanaian lawyer or with the Data Protection Commission (DPC) before go-live.

| Document | Use it for |
|---|---|
| [processing-register.md](processing-register.md) | What personal data the school holds, why, the lawful basis, who sees it, how long it is kept |
| [privacy-notice-admission.md](privacy-notice-admission.md) | Plain-English notice printed on (or attached to) the admission form |
| [retention-schedule.md](retention-schedule.md) | How long each kind of record is kept and what happens after |
| [data-subject-requests.md](data-subject-requests.md) | What to do when a parent asks to see, correct, delete or stop use of data |
| [breach-response.md](breach-response.md) | What to do if data is lost, stolen or seen by the wrong person |
| [staff-confidentiality.md](staff-confidentiality.md) | Rules every staff user agrees to before getting an account |

## The school's role

The school (the proprietor or the legal entity that runs Kansview) is the **data controller**: it decides why and how pupils', parents' and staff data is used. Suppliers who handle data for the school (the IT support contractor, the SMS provider, the off-site backup provider) are **data processors** and need a written agreement that they only act on the school's instructions and keep the data secure. **[CONFIRM]** the wording of processor agreements with a lawyer.

## Registration with the Data Protection Commission

Act 843 requires data controllers to **register with the Data Protection Commission** before processing personal data, and to renew the registration periodically. Action for the school:

1. Check whether Kansview is already registered (the DPC keeps a register of data controllers).
2. If not, register before going live with this system. Have ready: the school's legal name and address, the name of the person responsible for data protection (see below), the purposes listed in the processing register, the categories of data, who data is shared with, and the security measures (the threat model summary is a good source).
3. Put the renewal date in the school calendar. **[CONFIRM]** the current renewal period and fee with the DPC.

## Data protection lead

Name one person (usually the head teacher or administrator) as the **data protection lead**. They:

- keep this pack up to date and review it once a year;
- log and answer data subject requests (in the system: **Data protection → Requests**);
- lead the breach response;
- review the audit log monthly ("who looked at which child", exports, reveals of Ghana Card numbers);
- make sure every new staff user has read and signed the confidentiality rules.

**[CONFIRM]** whether the school must formally appoint a Data Protection Supervisor under the Act and register that person with the DPC.

## The data protection principles, and how the system supports them

Act 843 sets out principles for processing. The table maps each one to what the school does and what the system enforces. **[CONFIRM]** the principle names against the Act's current text.

| Principle | School practice | System control |
|---|---|---|
| Accountability | Data protection lead, this pack, annual review | Audit log of every change and every sensitive view (`audit.events`, hash chain) |
| Lawfulness of processing | Lawful basis recorded per data category (processing register) | Only fields needed for the school's work exist in the database |
| Specification of purpose | Purposes stated in the privacy notice | No marketing features; exports are audited |
| Compatibility of further processing | New uses are checked by the lead first | — |
| Quality of information | Parents asked to check details each year | Edit history; correction requests logged as data subject requests |
| Openness | Privacy notice on the admission form | — |
| Data security safeguards | Staff rules, locked server room, encrypted backups | See `../threat-model.md`: roles, MFA, encryption of medical and ID data, audit, lockout |
| Data subject participation | Requests answered within the policy deadline | Data subject request log with due dates, subject access export, anonymisation |

## Children's data

Most data in the system is about children. The school treats it with extra care:

- Data is collected from and explained to the **parent or guardian**, who gives any consent needed on the child's behalf. **[CONFIRM]** the Act's rules on consent for processing data of children under 18.
- Health information (allergies, conditions, medication) is **special (sensitive) personal data**. It is collected only to keep the child safe, is encrypted in the database, and is visible in full only to ADMIN, HEADTEACHER and REGISTRAR. Other staff see a short alert ("Severe peanut allergy, carries EpiPen") in Emergency View.
- Photos of children are used only for identification inside the system (and on the pupil's own records). Use on the website or social media needs separate written consent from the parent (outside this system).
