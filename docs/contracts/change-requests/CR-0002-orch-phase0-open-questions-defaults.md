# CR-0002: defaults for the Phase 0 open questions

- Raised by: Orchestrator, 2026-11-17. Approval of Phase 0 given without answers to the six open questions, so these defaults apply until the school says otherwise.
- Status: **Accepted (reversible)**

| # | Question | Default taken | Cost to change later |
|---|---|---|---|
| 1 | Hosting | On-premise server + nightly encrypted off-site backup. Compose files also work on a cloud VM. | Low (deployment only) |
| 2 | TEACHER role | Included, limited to assigned classes; the admin can simply not create teacher accounts. | Low |
| 3 | School code | `KSV` (setting `school_profile.school_code`, locked after the first student). | Free until the first real admission |
| 4 | SMS provider | Mock provider only, plus a provider interface and config switch (`SMS_SMS_PROVIDER`). No real adapter in v1 Phase 1. | One adapter file |
| 5 | Grading scale | Seed a common basic-school scale (A1–F9 style, 9 bands) and 30% class / 70% exam weights; both configurable per level. | Settings only |
| 6 | Branches | New naming rule (see conventions.md section 5). Feature branches are pushed to GitHub; integration branch is `claude/sweet-gauss-um4n2e`. | — |
