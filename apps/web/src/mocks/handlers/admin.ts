import { formatCedis } from '@sms/shared';
import type { ImportRow, ImportType, Role } from '@/api/types';
import { balanceOf, currentEnrolment, getDb, uid, type Db } from '../db';
import { audit, fakeFile, json, noContent, notFound, paginate, problem, r, validation } from '../http';

// ---------- SMS helpers (GSM-7 vs Unicode segments) ----------
const GSM = /^[A-Za-z0-9 \r\n@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà^{}\\[~\]|€]*$/;
export function smsSegments(text: string) {
  const gsm = GSM.test(text);
  const len = text.length;
  const single = gsm ? 160 : 70;
  const multi = gsm ? 153 : 67;
  return { encoding: gsm ? ('GSM-7' as const) : ('Unicode' as const), segments: len <= single ? 1 : Math.ceil(len / multi) };
}
const COST_PER_SEGMENT_PESEWAS = 3;

function audienceStudents(db: Db, a: { type?: string; ids?: string[] }) {
  const ids = new Set(a.ids ?? []);
  return db.students.filter((s) => {
    if (s.status !== 'active' || s.archived) return false;
    const en = currentEnrolment(db, s.id);
    const cls = db.classes.find((c) => c.id === en?.classId);
    switch (a.type) {
      case 'students':
        return ids.has(s.id);
      case 'class':
        return Boolean(cls && ids.has(cls.id));
      case 'level':
        return Boolean(cls && ids.has(cls.levelId));
      case 'defaulters':
        return balanceOf(db, s.id) > 0;
      default:
        return true;
    }
  });
}

function render(db: Db, body: string, studentId: string) {
  const s = db.students.find((x) => x.id === studentId)!;
  const link = db.links.find((l) => l.studentId === s.id && l.isPrimary) ?? db.links.find((l) => l.studentId === s.id);
  const g = db.guardians.find((x) => x.id === link?.guardianId);
  return {
    g,
    text: body
      .replace(/\{guardian_name\}/g, g ? `${g.title ?? ''} ${g.lastName}`.trim() : 'Parent')
      .replace(/\{student_name\}/g, s.firstName)
      .replace(/\{balance\}/g, formatCedis(Math.max(0, balanceOf(db, s.id))))
      .replace(/\{due_date\}/g, '30 Nov 2026')
      .replace(/\{date\}/g, new Date().toISOString().slice(0, 10)),
  };
}

const PLACEHOLDERS = ['guardian_name', 'student_name', 'balance', 'due_date', 'date', 'time', 'reason'];

export const adminHandlers = [
  // ---------- users ----------
  r.get('/users', 'users:read', ({ query }) => {
    const db = getDb();
    return json(paginate(db.users.map(({ password, failedLogins, staffId, mustChangePassword, ...u }) => (void password, void failedLogins, void staffId, void mustChangePassword, u)), query));
  }),
  r.post('/users', 'users:create', async ({ user, body }) => {
    const db = getDb();
    const b = await body<{ username?: string; fullName?: string; roles?: Role[] }>();
    const errors: { field: string; message: string }[] = [];
    if (!b.username?.match(/^[a-z0-9._-]{3,30}$/)) errors.push({ field: 'username', message: 'Use 3–30 lower-case letters or numbers' });
    if (db.users.some((u) => u.username === b.username)) errors.push({ field: 'username', message: 'That username is taken' });
    if (!b.fullName?.trim()) errors.push({ field: 'fullName', message: 'Enter the full name' });
    if (!b.roles?.length) errors.push({ field: 'roles', message: 'Choose at least one role' });
    if (errors.length) return validation(errors);
    const temp = `Temp-${Math.random().toString(36).slice(2, 8)}`;
    const u = { id: uid(), username: b.username!, password: temp, fullName: b.fullName!.trim(), roles: b.roles!, mfaEnabled: false, mustChangePassword: true, status: 'active' as const, failedLogins: 0, lastLoginAt: null };
    db.users.push(u);
    audit(user, 'create', 'user', `Created user ${u.username} (${u.roles.join(', ')})`);
    return json({ id: u.id, username: u.username, fullName: u.fullName, roles: u.roles, status: u.status, mfaEnabled: false, temporaryPassword: temp }, 201);
  }),
  r.patch<{ id: string }>('/users/{id}', 'users:update', async ({ user, params, body }) => {
    const u = getDb().users.find((x) => x.id === params.id);
    if (!u) return notFound('user');
    const b = await body<{ roles?: Role[]; status?: 'active' | 'disabled' }>();
    if (u.id === user.id && b.roles && !b.roles.includes('ADMIN')) return problem(422, 'VALIDATION_FAILED', 'You cannot remove your own administrator role.');
    if (b.roles) u.roles = b.roles;
    if (b.status) u.status = b.status;
    audit(user, 'update', 'user', `Changed user ${u.username}: ${JSON.stringify(b)}`);
    return json({ id: u.id, username: u.username, fullName: u.fullName, roles: u.roles, status: u.status, mfaEnabled: u.mfaEnabled, lastLoginAt: u.lastLoginAt });
  }),
  ...(['force-logout', 'unlock', 'reset-mfa'] as const).map((action) =>
    r.post<{ id: string }>(`/users/{id}/${action}`, 'users:update', ({ user, params }) => {
      const u = getDb().users.find((x) => x.id === params.id);
      if (!u) return notFound('user');
      if (action === 'unlock') { u.status = 'active'; u.failedLogins = 0; }
      if (action === 'reset-mfa') u.mfaEnabled = false;
      audit(user, 'update', 'user', `${action.replace('-', ' ')} for ${u.username}`);
      return noContent();
    }),
  ),
  r.post<{ id: string }>('/users/{id}/reset-password', 'users:update', ({ user, params }) => {
    const u = getDb().users.find((x) => x.id === params.id);
    if (!u) return notFound('user');
    u.password = `Temp-${Math.random().toString(36).slice(2, 8)}`;
    u.mustChangePassword = true;
    audit(user, 'update', 'user', `Reset password for ${u.username}`);
    return json({ temporaryPassword: u.password });
  }),

  // ---------- audit ----------
  r.get('/audit-events', 'audit:read', ({ query }) => {
    const action = query.get('action');
    const q = (query.get('q') ?? '').toLowerCase();
    const list = getDb().audit.filter((e) => (!action || e.action === action) && (!q || `${e.actorName} ${e.summary}`.toLowerCase().includes(q)));
    return json(paginate(list, query));
  }),
  r.post('/audit-events/verify', 'audit:read', () => json({ intact: true, checkedEvents: getDb().audit.length })),

  // ---------- messages ----------
  r.get('/message-templates', 'templates:read', () => json({ data: getDb().templates })),
  r.patch<{ id: string }>('/message-templates/{id}', 'templates:update', async ({ user, params, body }) => {
    const t = getDb().templates.find((x) => x.id === params.id);
    if (!t) return notFound('template');
    const b = await body<{ body?: string; name?: string }>();
    const bad = [...(b.body ?? '').matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).filter((p) => !PLACEHOLDERS.includes(p));
    if (bad.length) return problem(422, 'TEMPLATE_PLACEHOLDER_INVALID', `Unknown placeholder: {${bad[0]}}`, { detail: `Allowed: ${PLACEHOLDERS.map((p) => `{${p}}`).join(', ')}` });
    Object.assign(t, b);
    audit(user, 'update', 'template', `Changed template ${t.name}`);
    return json(t);
  }),
  r.post('/messages/preview', 'messages:send', async ({ user, body }) => {
    const db = getDb();
    const b = await body<{ body?: string; templateId?: string; audience?: { type?: string; ids?: string[] }; kind?: string }>();
    const text = b.body || db.templates.find((t) => t.id === b.templateId)?.body || '';
    const studs = audienceStudents(db, b.audience ?? {});
    const samples = studs.slice(0, 3).map((s) => render(db, text, s.id).text);
    const seg = smsSegments(samples[0] ?? text);
    const privileged = user.roles.includes('ADMIN') || user.roles.includes('HEADTEACHER');
    return json({ recipientCount: studs.length, segmentsPerMessage: seg.segments, encoding: seg.encoding, estimatedCostPesewas: studs.length * seg.segments * COST_PER_SEGMENT_PESEWAS, samples, needsApproval: b.kind !== 'emergency' && !privileged && studs.length > db.policies.bulkApprovalThreshold });
  }),
  r.get('/messages', 'messages:read', ({ user, perms }) => {
    const db = getDb();
    const own = !(user.roles.includes('ADMIN') || user.roles.includes('HEADTEACHER')) && !perms.has('messages:bulk_approve');
    return json({ data: db.messages.filter((m) => !own || m.createdBy === user.fullName || m.status === 'awaiting_approval').map(({ body, ...m }) => (void body, m)) });
  }),
  r.post(
    '/messages',
    'messages:send',
    async ({ user, perms, body }) => {
      const db = getDb();
      const b = await body<{ kind?: string; channel?: string; templateId?: string; body?: string; audience?: { type?: string; ids?: string[] } }>();
      const text = b.body || db.templates.find((t) => t.id === b.templateId)?.body || '';
      if (!text.trim()) return validation([{ field: 'body', message: 'Write the message' }]);
      if (b.kind === 'emergency' && !perms.has('messages:emergency')) return problem(403, 'FORBIDDEN', 'Only the administrator or headteacher can send emergency messages.');
      if (b.audience?.type !== 'students' && !perms.has('messages:bulk')) return problem(403, 'FORBIDDEN', 'You can only message individual parents.');
      const studs = audienceStudents(db, b.audience ?? {});
      const privileged = user.roles.includes('ADMIN') || user.roles.includes('HEADTEACHER');
      const needsApproval = b.kind !== 'emergency' && !privileged && studs.length > db.policies.bulkApprovalThreshold;
      const id = uid();
      const labels: Record<string, string> = { school: 'Whole school', defaulters: 'Parents who owe fees', class: 'Class', level: 'Level', students: 'Selected students', guardians: 'Selected parents' };
      db.messages.unshift({ id, kind: (b.kind ?? 'announcement') as 'announcement', body: text, bodyPreview: text.slice(0, 60) + (text.length > 60 ? '…' : ''), audienceLabel: labels[b.audience?.type ?? 'school'] ?? 'Custom', status: needsApproval ? 'awaiting_approval' : 'sent', createdAt: new Date().toISOString(), createdBy: user.fullName, recipientCount: studs.length, delivered: needsApproval ? 0 : Math.max(0, studs.length - 1), failed: needsApproval || !studs.length ? 0 : 1 });
      db.recipients.set(
        id,
        studs.map((s, i) => {
          const { g } = render(db, text, s.id);
          return { id: uid(), guardianName: g ? `${g.firstName} ${g.lastName}` : '—', phone: g?.phonePrimary ?? '', studentName: s.firstName + ' ' + s.lastName, status: needsApproval ? 'queued' : i === 0 ? 'failed' : 'delivered', error: !needsApproval && i === 0 ? 'Handset unreachable' : undefined, updatedAt: new Date().toISOString() };
        }),
      );
      audit(user, 'create', 'message', `${needsApproval ? 'Submitted for approval' : 'Sent'}: ${b.kind} to ${studs.length} recipients`);
      return json({ id, status: needsApproval ? 'awaiting_approval' : 'queued', recipientCount: studs.length }, 202);
    },
    { idempotent: true },
  ),
  r.get<{ id: string }>('/messages/{id}', 'messages:read', ({ params }) => {
    const m = getDb().messages.find((x) => x.id === params.id);
    return m ? json(m) : notFound('message');
  }),
  r.post<{ id: string }>('/messages/{id}/approve', 'messages:bulk_approve', ({ user, params }) => {
    const db = getDb();
    const m = db.messages.find((x) => x.id === params.id);
    if (!m) return notFound('message');
    if (m.createdBy === user.fullName) return problem(403, 'ADJUSTMENT_SELF_APPROVAL', 'Someone else must approve a message you wrote.');
    m.status = 'sent';
    m.delivered = m.recipientCount;
    for (const rc of db.recipients.get(m.id) ?? []) rc.status = 'delivered';
    audit(user, 'approve', 'message', `Approved bulk message to ${m.recipientCount}`);
    return json(m);
  }),
  r.get<{ id: string }>('/messages/{id}/recipients', 'messages:read', ({ params }) => json({ data: getDb().recipients.get(params.id) ?? [] })),
  r.post<{ id: string }>('/messages/{id}/retry-failed', 'messages:send', ({ params }) => {
    const db = getDb();
    const m = db.messages.find((x) => x.id === params.id);
    if (!m) return notFound('message');
    for (const rc of db.recipients.get(m.id) ?? []) if (rc.status === 'failed') { rc.status = 'queued'; rc.error = undefined; }
    m.failed = 0;
    return new Response(null, { status: 202 });
  }),

  // ---------- imports ----------
  r.get<{ type: string }>('/imports/templates/{type}', 'imports:create', ({ params }) => fakeFile(`${params.type}-template.xlsx`, 'mock template')),
  r.get('/imports', 'imports:read', () => json({ data: getDb().imports })),
  r.post('/imports', 'imports:create', async ({ user, request }) => {
    const db = getDb();
    const form = await request.formData();
    const file = form.get('file');
    const type = String(form.get('type') ?? '') as ImportType;
    if (!(file instanceof File)) return validation([{ field: 'file', message: 'Choose a file' }]);
    if (!/\.(xlsx|csv)$/i.test(file.name)) return problem(415, 'FILE_TYPE_NOT_ALLOWED', 'Upload the Excel template (.xlsx) or a .csv file.');
    if (type === 'opening_balances' && !user.roles.some((ro) => ro === 'BURSAR' || ro === 'ADMIN')) return problem(403, 'FORBIDDEN', 'Only the bursar or administrator can import opening balances.');
    const job = { id: uid(), type, fileName: file.name, status: 'uploaded' as const, totals: { rows: 0, valid: 0, warnings: 0, errors: 0, duplicates: 0 }, createdAt: new Date().toISOString(), createdBy: user.fullName };
    db.imports.unshift(job);
    audit(user, 'create', 'import', `Uploaded ${file.name}`);
    return json(job, 201);
  }),
  r.get<{ id: string }>('/imports/{id}', 'imports:read', ({ params }) => {
    const j = getDb().imports.find((x) => x.id === params.id);
    return j ? json(j) : notFound('import');
  }),
  r.post<{ id: string }>('/imports/{id}/validate', 'imports:create', ({ params }) => {
    const db = getDb();
    const j = db.imports.find((x) => x.id === params.id);
    if (!j) return notFound('import');
    const existing = db.students[0]!;
    const rows: ImportRow[] = [
      { rowNumber: 2, status: 'valid', data: { firstName: 'Kojo', lastName: 'Antwi', dateOfBirth: '2020-04-11', class: 'KG 2', guardianPhone: '024 000 7001' }, messages: [] },
      { rowNumber: 3, status: 'valid', data: { firstName: 'Afua', lastName: 'Sarpong', dateOfBirth: '2019-12-01', class: 'Basic 1A', guardianPhone: '024 000 7002' }, messages: [] },
      { rowNumber: 4, status: 'warning', data: { firstName: 'Yaa', lastName: 'Bonsu', dateOfBirth: '12/03/2019', class: 'Basic 1B', guardianPhone: '0240007003' }, messages: ['Date read as 12 March 2019 — check it is not 3 December'] },
      { rowNumber: 5, status: 'error', data: { firstName: '', lastName: 'Ansah', dateOfBirth: '2018-07-07', class: 'Basic 2', guardianPhone: '12345' }, messages: ['First name is missing', 'Guardian phone 12345 is not a valid Ghana number'] },
      { rowNumber: 6, status: 'duplicate', data: { firstName: existing.firstName, lastName: existing.lastName, dateOfBirth: existing.dateOfBirth, class: 'Basic 2', guardianPhone: '024 000 0100' }, messages: [`Looks like ${existing.firstName} ${existing.lastName} (${existing.studentCode}) already in the system`], resolution: null, duplicateOf: { id: existing.id, label: `${existing.firstName} ${existing.lastName} (${existing.studentCode})` } },
      { rowNumber: 7, status: 'error', data: { firstName: 'Kwesi', lastName: 'Addo', dateOfBirth: '2031-01-01', class: 'JHS 4', guardianPhone: '024 000 7005' }, messages: ['Date of birth is in the future', 'Class "JHS 4" does not exist'] },
    ];
    db.importRows.set(j.id, rows);
    j.status = 'validated';
    j.totals = { rows: rows.length, valid: 2, warnings: 1, errors: 2, duplicates: 1 };
    return json(j, 202);
  }),
  r.get<{ id: string }>('/imports/{id}/rows', 'imports:read', ({ params, query }) => {
    const status = query.get('status');
    const rows = getDb().importRows.get(params.id) ?? [];
    return json(paginate(rows.filter((x) => !status || x.status === status), query));
  }),
  r.patch<{ id: string; rowNumber: string }>('/imports/{id}/rows/{rowNumber}', 'imports:create', async ({ params, body }) => {
    const row = (getDb().importRows.get(params.id) ?? []).find((x) => x.rowNumber === Number(params.rowNumber));
    if (!row) return notFound('row');
    const b = await body<{ resolution?: ImportRow['resolution'] }>();
    row.resolution = b.resolution ?? null;
    return json(row);
  }),
  r.get<{ id: string }>('/imports/{id}/error-report.xlsx', 'imports:read', ({ params }) => fakeFile(`import-${params.id.slice(-6)}-errors.xlsx`, 'mock error report')),
  r.post<{ id: string }>(
    '/imports/{id}/commit',
    'imports:commit',
    ({ user, params }) => {
      const db = getDb();
      const j = db.imports.find((x) => x.id === params.id);
      if (!j) return notFound('import');
      if (j.status !== 'validated') return problem(409, 'IMPORT_INVALID_STATE', 'Check the file before importing.');
      const rows = db.importRows.get(j.id) ?? [];
      const unresolved = rows.filter((x) => x.status === 'duplicate' && !x.resolution);
      if (unresolved.length) return problem(409, 'IMPORT_INVALID_STATE', `Decide what to do with ${unresolved.length} possible duplicate(s) first.`);
      const n = rows.filter((x) => x.status === 'valid' || x.status === 'warning' || (x.status === 'duplicate' && x.resolution !== 'skip')).length;
      j.status = 'committed';
      j.totals.committed = n;
      audit(user, 'create', 'import', `Imported ${n} rows from ${j.fileName}`);
      return json(j, 202);
    },
    { idempotent: true },
  ),
];
