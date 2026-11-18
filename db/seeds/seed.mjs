// Development / demo seed: realistic but entirely FAKE Ghanaian school data.
// Usage:  SMS_DB_URL=postgres://sms:sms@localhost:5432/mydb pnpm --filter @sms/db seed [-- --seed 20261117]
// - Runs the migrations first, then seeds in ONE transaction (all or nothing).
// - Idempotent: a marker row (settings key `dev.seed`) makes a second run a no-op.
// - Deterministic: the same --seed number produces the same people, ids and amounts.
// - Refuses to run on a database that already has students that were not created by this seed.
// - Finance rows follow the ledger rules (charges per invoice line, payments with allocations,
//   approved adjustments, reversal entries), so balances = SUM(ledger_entries.amount_pesewas).
// Never point this at a production database.
import { createCipheriv, createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import argon2 from 'argon2';
import pg from 'pg';
import { migrate } from '../tools/migrate.mjs';
import * as D from './data.mjs';

export const SEED_VERSION = 1;
export const DEFAULT_SEED = 20261117;

/** Dev-only passwords (documented in db/seeds/README.md). */
export const DEV_USERS = [
  { username: 'admin', role: 'ADMIN', password: 'Kansview-Admin-Dev-2026!', fullName: 'System Administrator' },
  { username: 'bursar', role: 'BURSAR', password: 'Kansview-Bursar-Dev-2026!', staffJob: 'Bursar' },
  { username: 'head', role: 'HEADTEACHER', password: 'Kansview-Head-Dev-2026!', staffJob: 'Headteacher' },
  { username: 'registrar', role: 'REGISTRAR', password: 'Kansview-Registrar-Dev-2026!', staffJob: 'Registrar' },
  { username: 'teacher.kg1a', role: 'TEACHER', password: 'Kansview-Teacher-Dev-2026!', classTeacherOf: 'KG1A' },
  { username: 'teacher.p1a', role: 'TEACHER', password: 'Kansview-Teacher-Dev-2026!', classTeacherOf: 'P1A' },
  { username: 'teacher.p4b', role: 'TEACHER', password: 'Kansview-Teacher-Dev-2026!', classTeacherOf: 'P4B' },
  { username: 'teacher.jhs2a', role: 'TEACHER', password: 'Kansview-Teacher-Dev-2026!', classTeacherOf: 'JHS2A' },
];

const LEVEL_COUNTS = { CRECHE: 40, NURSERY: 50, KG1: 70, KG2: 70, P1: 86, P2: 86, P3: 85, P4: 85, P5: 84, P6: 84, JHS1: 88, JHS2: 86, JHS3: 86 };
const TODAY = '2026-11-17';
const PAY_CUTOFF = '2026-11-16';
const Y1 = { name: '2025/2026', start: '2025-09-08', end: '2026-07-24', status: 'closed', terms: [
  ['2025-09-08', '2025-12-19'], ['2026-01-12', '2026-04-10'], ['2026-04-27', '2026-07-24']] };
const Y2 = { name: '2026/2027', start: '2026-09-07', end: '2027-07-23', status: 'current', terms: [
  ['2026-09-07', '2026-12-18'], ['2027-01-11', '2027-04-09'], ['2027-04-26', '2027-07-23']] };
const PROMOTION_AT = '2026-08-21T10:00:00Z';

// ---------------------------------------------------------------------------------------------
// Deterministic random numbers
// ---------------------------------------------------------------------------------------------
class Rng {
  constructor(seed) { this.s = seed >>> 0; }
  next() { // mulberry32
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(a, b) { return a + Math.floor(this.next() * (b - a + 1)); }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  chance(p) { return this.next() < p; }
  weighted(pairs) {
    const total = pairs.reduce((s, [, w]) => s + w, 0);
    let x = this.next() * total;
    for (const [v, w] of pairs) { if ((x -= w) < 0) return v; }
    return pairs[pairs.length - 1][0];
  }
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(this.next() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
    return arr;
  }
  uuid() {
    const b = Array.from({ length: 16 }, () => Math.floor(this.next() * 256));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = b.map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  digits(n) { let s = ''; for (let i = 0; i < n; i++) s += this.int(0, 9); return s; }
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------
const DAMM = [[0,3,1,7,5,9,8,6,4,2],[7,0,9,2,1,5,4,8,6,3],[4,2,0,6,8,7,1,3,5,9],[1,7,5,0,9,8,3,4,2,6],[6,1,2,3,0,4,5,9,7,8],[3,6,7,4,2,0,9,5,8,1],[5,8,6,9,7,2,0,1,3,4],[8,9,4,5,3,6,2,0,1,7],[9,4,3,8,6,1,7,2,0,5],[2,5,8,1,4,3,6,7,9,0]];
const damm = (digits) => [...digits].reduce((i, ch) => DAMM[i][Number(ch)], 0);
function studentCode(school, year, seq) {
  const yy = String(year % 100).padStart(2, '0');
  const n = String(seq).padStart(5, '0');
  return `${school}-${yy}-${n}-${damm(yy + n)}`;
}
const docNo = (prefix, n) => `${prefix}-${String(n).padStart(6, '0')}`;

const dayMs = 86400000;
const toDate = (s) => new Date(`${s}T00:00:00Z`);
const fmt = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => fmt(new Date(toDate(s).getTime() + n * dayMs));
const minDate = (a, b) => (a < b ? a : b);
const maxDate = (a, b) => (a > b ? a : b);
function nextWeekday(s) { let d = s; while ([0, 6].includes(toDate(d).getUTCDay())) d = addDays(d, 1); return d; }
function randomWeekday(r, from, to) {
  const span = Math.max(0, Math.round((toDate(to) - toDate(from)) / dayMs));
  for (let i = 0; i < 10; i++) { const d = addDays(from, r.int(0, span)); if (![0, 6].includes(toDate(d).getUTCDay())) return d; }
  return nextWeekday(from);
}
const at = (date, h, m) => `${date}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`; // Africa/Accra = UTC
const ced = (n) => n * 100; // GH₵ → pesewas
const roundTo10 = (p) => Math.max(1000, Math.round(p / 1000) * 1000);

async function insert(c, table, rows) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const size = Math.max(1, Math.floor(30000 / cols.length));
  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size);
    const params = [];
    const values = chunk.map((row) => `(${cols.map((col) => { params.push(row[col] === undefined ? null : row[col]); return `$${params.length}`; }).join(',')})`);
    await c.query(`INSERT INTO ${table} (${cols.map((x) => `"${x}"`).join(',')}) VALUES ${values.join(',')}`, params);
  }
}

function fieldCrypto() {
  const hex = process.env.SMS_SEED_FIELD_KEY;
  if (!hex) return null;
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) throw new Error('SMS_SEED_FIELD_KEY must be 64 hex characters (32 bytes)');
  let counter = 0;
  return {
    // iv(12) | tag(16) | ciphertext, like the dev FieldCrypto in apps/api. IV is derived deterministically (dev data only).
    encrypt(text) {
      const iv = createHmac('sha256', key).update(`iv:${counter++}`).digest().subarray(0, 12);
      const ci = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([ci.update(text, 'utf8'), ci.final()]);
      return Buffer.concat([iv, ci.getAuthTag(), body]);
    },
    blindIndex(text) { return createHmac('sha256', key).update(text).digest(); },
  };
}

// ---------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------
function givenNames(r, eth, gender) {
  const christian = D.CHRISTIAN[gender];
  switch (eth) {
    case 'akan':
    case 'fante': {
      const day = (eth === 'akan' ? D.AKAN_DAY : D.FANTE_DAY)[gender];
      return r.chance(0.6) ? [r.pick(day), r.pick(christian)] : [r.pick(christian), r.pick(day)];
    }
    case 'ewe': return r.chance(0.5) ? [r.pick(D.EWE[gender]), r.pick(christian)] : [r.pick(christian), r.pick(D.EWE[gender])];
    case 'ga': return r.chance(0.5) ? [r.pick(D.GA[gender]), r.pick(christian)] : [r.pick(christian), r.pick(D.GA[gender])];
    case 'dagbani': return r.chance(0.6) ? [r.pick(D.DAGBANI[gender]), r.chance(0.5) ? r.pick(D.MUSLIM[gender]) : null] : [r.pick(D.MUSLIM[gender]), r.pick(D.DAGBANI[gender])];
    default: return r.chance(0.6) ? [r.pick(D.HAUSA[gender]), r.chance(0.5) ? r.pick(D.MUSLIM[gender]) : null] : [r.pick(D.MUSLIM[gender]), r.pick(D.HAUSA[gender])];
  }
}
const isMuslimEth = (eth) => eth === 'dagbani' || eth === 'hausa';
const emailOf = (first, last, n) => `${`${first}.${last}`.toLowerCase().replace(/[^a-z.]/g, '')}${n}@example.com`;

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------
export async function seed(url, { seed = DEFAULT_SEED, log = console.log, skipMigrate = false } = {}) {
  if (!skipMigrate) await migrate(url, { log: () => {} });
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(84732)');
    const marker = await c.query(`SELECT value FROM app.settings WHERE key = 'dev.seed'`);
    if (marker.rows.length) {
      await c.query('COMMIT');
      log(`already seeded (${JSON.stringify(marker.rows[0].value)}); nothing to do`);
      return { skipped: true };
    }
    const existing = await c.query('SELECT count(*)::int AS n FROM app.students');
    if (existing.rows[0].n > 0) throw new Error('This database already has students that were not created by the seed. The seed only runs on an empty database.');
    const summary = await generate(c, new Rng(seed), log);
    await insert(c, 'app.settings', [{ key: 'dev.seed', value: JSON.stringify({ seed, version: SEED_VERSION, generatedFor: TODAY }), description: 'Marker: this database contains FAKE development seed data' }]);
    await c.query('REFRESH MATERIALIZED VIEW app.mv_student_balances');
    await c.query('COMMIT');
    log(`seeded: ${JSON.stringify(summary)}`);
    return { skipped: false, summary };
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await c.end();
  }
}

async function generate(c, r, log) {
  const crypto = fieldCrypto();
  const school = (await c.query('SELECT school_code FROM app.school_profile WHERE id = 1')).rows[0].school_code;
  await c.query(`UPDATE app.school_profile SET name = 'Kansview School', motto = 'Knowledge, Discipline, Service',
    address = 'Plot 7, Mango Street, Dzorwulu, Accra', phone = '+233200000001', email = 'office@example.com' WHERE id = 1`);
  const levels = (await c.query('SELECT id, code, name, sort_order FROM app.levels ORDER BY sort_order')).rows;
  const levelIdx = Object.fromEntries(levels.map((l, i) => [l.code, i]));

  // ---------------- staff ----------------
  const jobs = [
    ['Headteacher', 'teaching'], ['Assistant Headteacher', 'teaching'],
    ...Array.from({ length: 24 }, () => ['Class Teacher', 'teaching']),
    ...['Mathematics', 'Integrated Science', 'English Language', 'Social Studies', 'French', 'Computing'].map((s) => [`JHS ${s} Teacher`, 'teaching']),
    ['Bursar', 'non_teaching'], ['Accounts Assistant', 'non_teaching'], ['Registrar', 'non_teaching'], ['School Nurse', 'non_teaching'],
    ['IT Support Officer', 'non_teaching'], ['Driver', 'non_teaching'], ['Driver', 'non_teaching'], ['Cook', 'non_teaching'], ['Cook', 'non_teaching'],
    ['Security Officer', 'non_teaching'], ['Security Officer', 'non_teaching'], ['Cleaner', 'non_teaching'], ['Cleaner', 'non_teaching'],
  ];
  let staffPhone = 8000;
  let relPhone = 6000;
  const staff = jobs.map(([job, type], i) => {
    const eth = r.weighted(D.ETHNIC_WEIGHTS);
    const gender = job === 'Class Teacher' && i < 12 ? 'female' : r.chance(0.5) ? 'female' : 'male';
    const [first, middle] = givenNames(r, eth, gender);
    const last = r.pick(D.SURNAMES[eth]);
    const [area, city] = r.pick(D.PLACES);
    return {
      id: r.uuid(), staff_code: `${school}-ST-${String(i + 1).padStart(3, '0')}`, first_name: first, middle_names: middle, last_name: last,
      title: gender === 'male' ? 'Mr' : r.pick(['Mrs', 'Ms', 'Madam']), gender, date_of_birth: `${r.int(1966, 1999)}-${String(r.int(1, 12)).padStart(2, '0')}-${String(r.int(1, 28)).padStart(2, '0')}`,
      phone: `+23324000${staffPhone++}`, email: emailOf(first, last, ''), address: `${area}, ${city}`, staff_type: type, job_title: job,
      employment_date: `${r.int(2008, 2025)}-09-01`, status: 'active',
      ghana_card_enc: crypto ? crypto.encrypt(`GHA-${r.digits(9)}-${r.digits(1)}`) : null, ssnit_no_enc: null, user_id: null,
    };
  });
  await insert(c, 'app.staff', staff);
  await insert(c, 'app.staff_emergency_contacts', staff.map((s) => {
    const eth = r.weighted(D.ETHNIC_WEIGHTS);
    return { id: r.uuid(), staff_id: s.id, priority: 1, name: `${r.pick(D.CHRISTIAN[r.chance(0.5) ? 'male' : 'female'])} ${r.pick(D.SURNAMES[eth])}`, relationship: r.pick(['Spouse', 'Sister', 'Brother', 'Mother']), phone: `+23320000${relPhone++}` };
  }));
  const staffByJob = (job) => staff.filter((s) => s.job_title === job);
  const classTeachers = staffByJob('Class Teacher');
  const subjectTeachers = staff.filter((s) => s.job_title.startsWith('JHS '));

  // ---------------- years, terms, subjects, classes ----------------
  const years = [Y1, Y2].map((y) => ({ ...y, id: r.uuid() }));
  await insert(c, 'app.academic_years', years.map((y) => ({ id: y.id, name: y.name, start_date: y.start, end_date: y.end, status: y.status })));
  const terms = [];
  for (const y of years) y.terms.forEach(([s, e], i) => terms.push({
    id: r.uuid(), academic_year_id: y.id, number: i + 1, name: `Term ${i + 1}`, start_date: s, end_date: e,
    status: y.status === 'closed' ? 'closed' : i === 0 ? 'current' : 'planned',
  }));
  await insert(c, 'app.terms', terms);
  const y1Terms = terms.slice(0, 3);
  const y2Terms = terms.slice(3);

  const subjects = D.SUBJECTS.map(([code, name]) => ({ id: r.uuid(), code, name, is_active: true }));
  await insert(c, 'app.subjects', subjects);
  const subj = Object.fromEntries(subjects.map((s) => [s.code, s.id]));
  const subjectsFor = (code) => {
    const i = levelIdx[code];
    if (i <= 3) return ['LIT', 'NUM', 'OWOP', 'CAD', 'PE'];
    if (i <= 6) return ['ENG', 'MATH', 'SCI', 'OWOP', 'RME', 'GHL', 'CAD', 'PE'];
    if (i <= 9) return ['ENG', 'MATH', 'SCI', 'OWOP', 'RME', 'GHL', 'CAD', 'COMP', 'FRE', 'PE'];
    return ['ENG', 'MATH', 'SCI', 'SOC', 'RME', 'GHL', 'CTECH', 'COMP', 'FRE', 'PE'];
  };
  await insert(c, 'app.level_subjects', levels.flatMap((l) => subjectsFor(l.code).map((s, k) => ({ level_id: l.id, subject_id: subj[s], sort_order: k + 1 }))));

  const streamsOf = (code) => (LEVEL_COUNTS[code] > 60 ? ['A', 'B'] : [null]);
  const classes = { y1: {}, y2: {} }; // key `${code}${stream ?? ''}` → class
  const classRows = [];
  let teacherI = 0;
  const teacherOfKey = {};
  for (const l of levels) for (const st of streamsOf(l.code)) {
    const key = `${l.code}${st ?? ''}`;
    teacherOfKey[key] = classTeachers[teacherI++];
  }
  for (const [yk, y] of [['y1', years[0]], ['y2', years[1]]]) {
    for (const l of levels) for (const st of streamsOf(l.code)) {
      const key = `${l.code}${st ?? ''}`;
      const row = { id: r.uuid(), academic_year_id: y.id, level_id: l.id, stream: st, display_name: `${l.name}${st ? ` ${st}` : ''}`,
        capacity: l.code === 'CRECHE' ? 30 : 45, class_teacher_staff_id: teacherOfKey[key].id };
      classes[yk][key] = { ...row, key, levelCode: l.code };
      classRows.push(row);
    }
  }
  await insert(c, 'app.classes', classRows);
  const assignments = [];
  for (const [yk, start, end] of [['y1', Y1.start, Y1.end], ['y2', Y2.start, null]]) {
    for (const cl of Object.values(classes[yk])) {
      assignments.push({ id: r.uuid(), staff_id: cl.class_teacher_staff_id, class_id: cl.id, subject_id: null, role: 'class_teacher', start_date: start, end_date: end });
    }
    const subjCodes = ['MATH', 'SCI', 'ENG', 'SOC', 'FRE', 'COMP'];
    for (const cl of Object.values(classes[yk]).filter((x) => x.levelCode.startsWith('JHS'))) {
      subjectTeachers.forEach((t, k) => assignments.push({ id: r.uuid(), staff_id: t.id, class_id: cl.id, subject_id: subj[subjCodes[k]], role: 'subject_teacher', start_date: start, end_date: end }));
    }
  }
  await insert(c, 'app.staff_class_assignments', assignments);

  // ---------------- users ----------------
  const hashes = {};
  for (const u of DEV_USERS) hashes[u.password] ??= await argon2.hash(u.password, { type: argon2.argon2id });
  const users = DEV_USERS.map((u) => {
    const st = u.staffJob ? staffByJob(u.staffJob)[0] : u.classTeacherOf ? teacherOfKey[u.classTeacherOf] : null;
    return {
      id: r.uuid(), username: u.username, email: `${u.username}@example.com`,
      full_name: st ? `${st.title} ${st.first_name} ${st.last_name}` : u.fullName, password_hash: hashes[u.password], user_type: 'staff',
      roles: [u.role], status: 'active', must_change_password: false, password_changed_at: '2026-09-01T08:00:00Z', staff_id: st?.id ?? null,
    };
  });
  await insert(c, 'app.users', users);
  await c.query('UPDATE app.staff s SET user_id = u.id FROM app.users u WHERE u.staff_id = s.id');
  const U = Object.fromEntries(users.map((u) => [u.username, u.id]));

  // ---------------- student slots and families ----------------
  const slots = [];
  for (const l of levels) {
    const i = levelIdx[l.code];
    for (let k = 0; k < LEVEL_COUNTS[l.code]; k++) {
      let yearsIn = i === 0 ? 0 : r.chance(0.15) ? 0 : r.int(1, Math.min(i, 9));
      const repeater = yearsIn >= 1 && i >= 2 && r.chance(0.02);
      slots.push({ kind: 'current', level: i, y1Level: yearsIn >= 1 ? (repeater ? i : i - 1) : null, repeater,
        admissionYear: 2026 - yearsIn, birthYear: 2024 - i - (repeater ? 1 : 0) });
    }
  }
  for (let k = 0; k < 60; k++) slots.push({ kind: 'alumni', level: null, y1Level: 12, repeater: false, admissionYear: 2025 - r.int(0, 8), birthYear: 2011 });
  for (let k = 0; k < 8; k++) {
    const j = r.int(2, 11);
    slots.push({ kind: 'withdrawn', level: null, y1Level: j, repeater: false, admissionYear: 2025 - r.int(0, Math.min(j, 6)), birthYear: 2023 - j,
      withdrawalType: k % 2 ? 'transfer_out' : 'withdrawal', withdrawalDate: nextWeekday(addDays('2026-02-02', r.int(0, 50))) });
  }
  for (const s of slots) if (s.admissionYear <= 2025 && s.y1Level === null && s.kind === 'current') s.admissionYear = 2026; // safety

  const order = r.shuffle(slots.map((_, i) => i));
  const assigned = new Set();
  const families = [];
  for (const anchor of order) {
    if (assigned.has(anchor)) continue;
    const size = r.weighted([[1, 55], [2, 30], [3, 12], [4, 3]]);
    const members = [anchor];
    assigned.add(anchor);
    const ages = new Set([slots[anchor].birthYear]);
    for (const cand of order) {
      if (members.length >= size) break;
      if (assigned.has(cand)) continue;
      const by = slots[cand].birthYear;
      if (ages.has(by) && !r.chance(0.03)) continue; // twins are rare
      if ([...ages].some((a) => Math.abs(a - by) > 9)) continue;
      members.push(cand); assigned.add(cand); ages.add(by);
    }
    families.push({ members, eth: r.weighted(D.ETHNIC_WEIGHTS) });
  }

  // ---------------- guardians ----------------
  let gPhone = 1;
  let g2Phone = 1;
  const guardians = [];
  const links = [];
  for (const fam of families) {
    const eth = fam.eth;
    fam.surname = r.pick(D.SURNAMES[eth]);
    const [area, city] = r.pick(D.PLACES);
    fam.address = `House ${r.int(1, 120)}, ${r.pick(D.STREETS)}, ${area}, ${city}`;
    fam.behaviour = r.weighted([['good', 70], ['partial', 22], ['poor', 8]]);
    const muslim = isMuslimEth(eth);
    const mk = (gender, relationship, lastName) => {
      const [first] = givenNames(r, eth, gender);
      const card = `GHA-${r.digits(9)}-${r.digits(1)}`;
      const g = {
        id: r.uuid(), first_name: first, last_name: lastName,
        title: muslim && r.chance(0.3) ? (gender === 'male' ? 'Alhaji' : 'Hajia') : r.chance(0.04) ? 'Dr' : gender === 'male' ? 'Mr' : r.pick(['Mrs', 'Mrs', 'Ms', 'Madam']),
        phone_primary: `+23324000${String(gPhone++).padStart(4, '0')}`,
        phone_secondary: r.chance(0.4) ? `+23320000${String(g2Phone++).padStart(4, '0')}` : null,
        whatsapp_number: null, email: r.chance(0.5) ? emailOf(first, lastName, r.int(1, 99)) : null,
        occupation: r.pick(D.OCCUPATIONS), workplace: r.pick(D.WORKPLACES), home_address: fam.address, work_address: null,
        ghana_card_enc: crypto ? crypto.encrypt(card) : null, ghana_card_bidx: crypto ? crypto.blindIndex(card.replace(/-/g, '')) : null,
        ghana_card_last4: card.replace(/\D/g, '').slice(-4), relationship, gender,
      };
      g.whatsapp_number = r.chance(0.6) ? g.phone_primary : null;
      g.work_address = g.workplace === 'Self-employed' ? null : `${g.workplace}, ${r.pick(D.PLACES)[1]}`;
      return g;
    };
    const gs = [];
    if (r.chance(0.6)) {
      gs.push(mk('male', 'father', fam.surname));
      gs.push(mk('female', 'mother', r.chance(0.7) ? r.pick(D.SURNAMES[eth]) : fam.surname));
    } else {
      const rel = r.weighted([['mother', 60], ['father', 20], ['grandparent', 10], ['aunt', 7], ['uncle', 3]]);
      const gender = ['mother', 'aunt'].includes(rel) || (rel === 'grandparent' && r.chance(0.7)) ? 'female' : 'male';
      gs.push(mk(gender, rel, rel === 'father' ? fam.surname : r.pick(D.SURNAMES[eth])));
    }
    fam.guardians = gs;
    fam.primary = gs.find((g) => g.relationship === 'mother') ?? gs[0];
    fam.payer = gs.find((g) => g.relationship === 'father') ?? fam.primary;
    guardians.push(...gs);
  }
  await insert(c, 'app.guardians', guardians.map(({ relationship, gender, ...g }) => g));

  // ---------------- students ----------------
  const students = [];
  for (const fam of families) {
    for (const si of fam.members) {
      const s = slots[si];
      const gender = r.chance(0.5) ? 'female' : 'male';
      const [first, middle] = givenNames(r, fam.eth, gender);
      const dob = addDays(`${s.birthYear - 1}-09-01`, r.int(0, 364));
      const yearsIn = 2026 - s.admissionYear;
      Object.assign(s, {
        id: r.uuid(), fam, first_name: first, middle_names: middle,
        last_name: r.chance(0.85) ? fam.surname : r.pick(D.SURNAMES[fam.eth]), gender, dob,
        admission_date: s.admissionYear === 2026 ? Y2.start : s.admissionYear === 2025 ? Y1.start : nextWeekday(`${s.admissionYear}-09-0${r.int(1, 9)}`),
        preferred_name: r.chance(0.08) ? (middle ?? 'Nana') : null,
        religion: isMuslimEth(fam.eth) ? (r.chance(0.85) ? 'Muslim' : 'Christian') : r.chance(0.92) ? 'Christian' : 'Muslim',
        previous_school: (s.kind === 'current' && s.level >= 4 && yearsIn <= s.level - 3 && r.chance(0.6)) || (s.kind !== 'current' && r.chance(0.3)) ? r.pick(D.PREVIOUS_SCHOOLS) : null,
      });
      students.push(s);
    }
  }
  // codes: per admission year, in admission order
  students.sort((a, b) => a.admissionYear - b.admissionYear || a.admission_date.localeCompare(b.admission_date) || a.id.localeCompare(b.id));
  const seqByYear = {};
  for (const s of students) {
    s.seq = seqByYear[s.admissionYear] = (seqByYear[s.admissionYear] ?? 0) + 1;
    s.code = studentCode(school, s.admissionYear, s.seq);
  }

  // class placement
  const pickStream = (code) => { const st = streamsOf(code); return st.length === 1 ? st[0] : r.pick(st); };
  const byLevelY2 = {};
  for (const s of students) {
    if (s.y1Level !== null) s.y1Class = classes.y1[`${levels[s.y1Level].code}${pickStream(levels[s.y1Level].code) ?? ''}`];
    if (s.kind === 'current') (byLevelY2[s.level] ??= []).push(s);
  }
  for (const [lvl, list] of Object.entries(byLevelY2)) {
    const code = levels[lvl].code;
    const st = streamsOf(code);
    r.shuffle(list).forEach((s, k) => { s.y2Class = classes.y2[`${code}${st[k % st.length] ?? ''}`]; });
  }
  const admissionClass = (s) => (s.admissionYear === 2026 ? s.y2Class : s.admissionYear === 2025 ? s.y1Class : null);
  await insert(c, 'app.students', students.map((s) => ({
    id: s.id, student_code: s.code, admission_year: s.admissionYear, admission_seq: s.seq, first_name: s.first_name, middle_names: s.middle_names,
    last_name: s.last_name, preferred_name: s.preferred_name, date_of_birth: s.dob, gender: s.gender,
    nationality: r.chance(0.97) ? 'Ghanaian' : r.pick(['Nigerian', 'Togolese', 'Burkinabe']), home_address: s.fam.address,
    previous_school: s.previous_school, admission_date: s.admission_date, admission_class_id: admissionClass(s)?.id ?? null,
    birth_cert_no: r.chance(0.7) ? `BC/${s.birthYear}/${r.digits(6)}` : null, religion: s.religion, languages: D.LANGUAGES[s.fam.eth],
    status: s.kind === 'current' ? 'active' : s.kind === 'alumni' ? 'graduated' : s.withdrawalType === 'transfer_out' ? 'transferred_out' : 'withdrawn',
  })));
  const idRows = Object.entries(seqByYear).map(([y, n]) => ({ scope: `student:${String(Number(y) % 100).padStart(2, '0')}`, last_value: n }));
  await insert(c, 'app.id_counters', idRows);

  await insert(c, 'app.student_guardians', families.flatMap((fam) => fam.members.flatMap((si) => fam.guardians.map((g) => ({
    student_id: slots[si].id, guardian_id: g.id, relationship: g.relationship, is_primary: g === fam.primary, is_fee_payer: g === fam.payer,
    can_pick_up: true, lives_with_student: g === fam.primary || r.chance(0.85), receives_sms: g === fam.primary || r.chance(0.5),
  })))));

  // ---------------- withdrawals ----------------
  const promotionRunId = r.uuid();
  const withdrawals = [];
  let tl = 0;
  for (const s of students.filter((x) => x.kind === 'withdrawn').sort((a, b) => a.withdrawalDate.localeCompare(b.withdrawalDate))) {
    const transfer = s.withdrawalType === 'transfer_out';
    s.withdrawalId = r.uuid();
    const by = { by: 'Bursar', at: s.withdrawalDate };
    withdrawals.push({
      id: s.withdrawalId, student_id: s.id, type: s.withdrawalType,
      reason: transfer ? 'Family relocating to another town' : r.pick(['Family travelling abroad', 'Moving to a school closer to home', 'Financial reasons']),
      effective_date: s.withdrawalDate, destination_school: transfer ? r.pick(D.PREVIOUS_SCHOOLS) : null,
      clearance: JSON.stringify({ fees: { cleared: true, ...by }, books: { cleared: true, by: 'Class Teacher', at: s.withdrawalDate }, uniform: { cleared: true, by: 'Registrar', at: s.withdrawalDate }, property: { cleared: true, by: 'Registrar', at: s.withdrawalDate } }),
      status: 'completed', letter_no: transfer ? docNo('TL', ++tl) : null, completed_at: at(s.withdrawalDate, 14, 0), completed_by: U.registrar,
    });
  }
  await insert(c, 'app.withdrawals', withdrawals);

  // ---------------- enrolments, promotion, status history ----------------
  const enrolments = [];
  for (const s of students) {
    if (s.y1Class) {
      s.y1EnrolmentId = r.uuid();
      const ended = s.kind === 'withdrawn' ? s.withdrawalDate : Y1.end;
      enrolments.push({ id: s.y1EnrolmentId, student_id: s.id, class_id: s.y1Class.id, academic_year_id: years[0].id, start_date: maxDate(Y1.start, s.admission_date),
        end_date: ended, status: s.kind === 'withdrawn' ? 'withdrawn' : s.repeater ? 'repeated' : 'completed', reason: s.kind === 'withdrawn' ? 'Withdrawn' : null, promotion_run_id: null, sortKey: s.y1Class.id });
    }
    if (s.y2Class) {
      s.y2EnrolmentId = r.uuid();
      enrolments.push({ id: s.y2EnrolmentId, student_id: s.id, class_id: s.y2Class.id, academic_year_id: years[1].id, start_date: maxDate(Y2.start, s.admission_date),
        end_date: null, status: 'active', reason: null, promotion_run_id: s.y1Class ? promotionRunId : null, sortKey: s.y2Class.id });
    }
  }
  const byStudent = Object.fromEntries(students.map((s) => [s.id, s]));
  const rollGroups = {};
  for (const e of enrolments) (rollGroups[e.class_id] ??= []).push(e);
  for (const list of Object.values(rollGroups)) {
    list.sort((a, b) => { const x = byStudent[a.student_id]; const y = byStudent[b.student_id]; return x.last_name.localeCompare(y.last_name) || x.first_name.localeCompare(y.first_name) || x.id.localeCompare(y.id); });
    list.forEach((e, k) => { e.roll_number = k + 1; });
  }
  await insert(c, 'app.promotion_runs', [{ id: promotionRunId, from_academic_year_id: years[0].id, to_academic_year_id: years[1].id,
    scope: Object.values(classes.y1).map((x) => x.id), status: 'committed', committed_at: PROMOTION_AT, committed_by: U.head, arrears_policy_snapshot: 'warn', created_by: U.head }]);
  await insert(c, 'app.enrolments', enrolments.map(({ sortKey, ...e }) => e));

  const history = [];
  for (const s of students) {
    history.push({ id: r.uuid(), student_id: s.id, from_status: null, to_status: 'active', effective_date: s.admission_date, reason: 'Admitted', source: 'admission', source_ref_id: null });
    if (s.kind === 'alumni') history.push({ id: r.uuid(), student_id: s.id, from_status: 'active', to_status: 'graduated', effective_date: '2026-08-21', reason: 'Completed JHS 3', source: 'promotion', source_ref_id: promotionRunId });
    if (s.kind === 'withdrawn') history.push({ id: r.uuid(), student_id: s.id, from_status: 'active', to_status: s.withdrawalType === 'transfer_out' ? 'transferred_out' : 'withdrawn', effective_date: s.withdrawalDate, reason: 'Withdrawal completed', source: 'withdrawal', source_ref_id: s.withdrawalId });
  }
  await insert(c, 'app.student_status_history', history);

  // ---------------- medical, emergency contacts, pickups ----------------
  const medical = [];
  for (const s of students.filter((x) => x.kind === 'current')) {
    if (!r.chance(0.1)) continue;
    const alert = r.chance(0.6) ? r.pick(D.MEDICAL_ALERTS) : null;
    const minor = alert ? null : r.pick(D.MINOR_MEDICAL);
    const enc = (t) => (crypto && t ? crypto.encrypt(t) : null);
    medical.push({ student_id: s.id, blood_group: r.pick(['O+', 'O+', 'A+', 'B+', 'AB+', 'O-']),
      allergies_enc: enc(alert && /allerg/i.test(alert) ? alert : minor && /allerg/i.test(minor) ? minor : null),
      chronic_conditions_enc: enc(alert && !/allerg/i.test(alert) ? alert : null), medication_notes_enc: enc(alert && /EpiPen|inhaler|insulin/.test(alert) ? 'Medication kept at the school office' : null),
      special_needs_enc: null, doctor_name: r.chance(0.5) ? `Dr ${r.pick(D.SURNAMES.akan)}` : null, clinic_name: r.pick(['Family Health Clinic', 'Community Polyclinic', 'Mercy Medical Centre']),
      clinic_phone: '+233200009' + String(r.int(100, 999)), alert_summary: alert, has_alert: !!alert });
  }
  await insert(c, 'app.student_medical', medical);

  const contacts = [];
  const pickups = [];
  for (const s of students) {
    const fam = s.fam;
    contacts.push({ id: r.uuid(), student_id: s.id, priority: 1, guardian_id: fam.primary.id, name: null, phone: null, relationship: null, notes: null });
    const other = fam.guardians.find((g) => g !== fam.primary);
    if (other) contacts.push({ id: r.uuid(), student_id: s.id, priority: 2, guardian_id: other.id, name: null, phone: null, relationship: null, notes: null });
    else contacts.push({ id: r.uuid(), student_id: s.id, priority: 2, guardian_id: null, name: `${r.pick(D.CHRISTIAN.female)} ${r.pick(D.SURNAMES[fam.eth])}`, phone: `+23320000${relPhone++}`, relationship: r.pick(['Aunt', 'Uncle', 'Grandmother', 'Family friend']), notes: null });
    if (s.kind === 'current' && r.chance(0.15)) {
      pickups.push({ id: r.uuid(), student_id: s.id, guardian_id: null, name: `${r.pick(D.CHRISTIAN.male)} ${r.pick(D.SURNAMES[fam.eth])}`, relationship: r.pick(['Family driver', 'Uncle', 'Aunt', 'Neighbour']),
        phone: `+23320000${relPhone++}`, photo_file_id: null, id_type: 'Ghana Card', id_number_last4: r.digits(4), verification_notes: 'Check Ghana Card at the gate', valid_from: Y2.start, valid_to: Y2.end });
    }
  }
  await insert(c, 'app.emergency_contacts', contacts);
  await insert(c, 'app.authorised_pickups', pickups);

  // ---------------- finance ----------------
  const feeItemDefs = [
    ['TUITION', 'Tuition', 'tuition', false, 10], ['PTA', 'PTA dues', 'pta', false, 20], ['BOOKS', 'Books and stationery', 'books', false, 30],
    ['EXAMS', 'Examination fee', 'exams', false, 40], ['ICT', 'ICT fee', 'other', false, 45], ['FEEDING', 'Feeding', 'feeding', true, 50],
    ['TRANSPORT', 'School bus', 'transport', true, 55], ['CLUBS', 'Clubs and sports', 'extracurricular', false, 60],
  ];
  const feeItems = Object.fromEntries(feeItemDefs.map(([code, name, category, opt, prio]) => [code, { id: r.uuid(), code, name, category, is_optional: opt, is_active: true, allocation_priority: prio }]));
  await insert(c, 'app.fee_items', Object.values(feeItems));
  const tuitionFor = (i, y2) => { const base = i <= 1 ? 1200 : i <= 3 ? 1400 : i <= 6 ? 1600 : i <= 9 ? 1750 : 1950; return ced(y2 ? Math.round((base * 1.08) / 10) * 10 : base); };
  const structureLines = (i, termNo, y2) => {
    const lines = [['TUITION', tuitionFor(i, y2), false], ['PTA', ced(50), false]];
    if (termNo === 1) lines.push(['BOOKS', ced(y2 ? 190 : 180), false]);
    if (i >= 4) lines.push(['EXAMS', ced(80), false]);
    if (i >= 7) lines.push(['ICT', ced(60), false]);
    lines.push(['CLUBS', ced(40), false], ['FEEDING', ced(y2 ? 700 : 650), true], ['TRANSPORT', ced(y2 ? 800 : 750), true]);
    return lines;
  };
  const structures = [];
  const sLines = [];
  const structOf = {}; // `${termId}:${levelIdx}` → lines
  for (const t of [...y1Terms, y2Terms[0], y2Terms[1]]) {
    const y2 = y2Terms.includes(t);
    for (const l of levels) {
      const i = levelIdx[l.code];
      const id = r.uuid();
      const draft = t === y2Terms[1];
      structures.push({ id, academic_year_id: t.academic_year_id, term_id: t.id, level_id: l.id, class_id: null, name: `${l.name} – ${y2 ? Y2.name : Y1.name} Term ${t.number}`,
        status: 'draft', activated_at: null, activated_by: null, active: !draft });
      const lines = structureLines(i, t.number, y2).map(([code, amount, opt]) => ({ id: r.uuid(), fee_structure_id: id, fee_item_id: feeItems[code].id, amount_pesewas: amount, is_optional: opt, code }));
      sLines.push(...lines);
      structOf[`${t.id}:${i}`] = lines;
    }
  }
  await insert(c, 'app.fee_structures', structures.map(({ active, ...s }) => s));
  await insert(c, 'app.fee_structure_lines', sLines.map(({ code, ...l }) => l));
  for (const t of [...y1Terms, y2Terms[0]]) {
    await c.query(`UPDATE app.fee_structures SET status = 'active', activated_at = $2, activated_by = $3 WHERE term_id = $1`, [t.id, at(addDays(t.start_date, -21), 9, 0), U.bursar]);
  }

  const optional = [];
  for (const s of students) {
    s.feeding = r.chance(0.35);
    s.transport = r.chance(0.2);
  }
  const invoices = [];
  const invLines = [];
  const ledger = [];
  const reversalLedger = [];
  const payments = [];
  const allocations = [];
  const adjustments = [];
  const paymentReversals = [];
  const methodPick = () => r.weighted([['cash', 40], ['momo_mtn', 30], ['telecel_cash', 8], ['at_money', 4], ['bank_transfer', 15], ['cheque', 3]]);
  const banks = ['GCB Bank', 'Ecobank Ghana', 'Fidelity Bank', 'CalBank', 'Absa Bank Ghana', 'Stanbic Bank'];

  // adjustment plan (2026/2027 Term 1)
  const t21 = y2Terms[0];
  const currentStudents = students.filter((s) => s.kind === 'current');
  const adjPlan = new Map(); // student id → [{type, ...}]
  const addPlan = (s, a) => { if (!adjPlan.has(s.id)) adjPlan.set(s.id, []); adjPlan.get(s.id).push(a); };
  for (const fam of families) {
    const kids = fam.members.map((i) => slots[i]).filter((s) => s.kind === 'current').sort((a, b) => a.birthYear - b.birthYear);
    if (kids.length >= 3) kids.slice(1).forEach((s) => addPlan(s, { type: 'sibling_discount', bp: 1000, item: 'TUITION', status: 'approved', reason: 'Sibling discount: 3 or more children in the school' }));
  }
  const pool = r.shuffle([...currentStudents]);
  pool.slice(0, 5).forEach((s) => addPlan(s, { type: 'scholarship', bp: 5000, item: 'TUITION', status: 'approved', reason: 'Academic excellence scholarship (50% tuition)' }));
  pool.slice(5, 8).forEach((s) => addPlan(s, { type: 'waiver', item: 'PTA', status: 'approved', reason: 'PTA dues waived: parent serves on the PTA executive' }));
  pool.slice(8, 10).forEach((s) => addPlan(s, { type: 'manual_charge', amount: ced(45), status: 'approved', reason: 'Replacement of lost reading book' }));
  pool.slice(10, 13).forEach((s) => addPlan(s, { type: 'discount', amount: ced(100), item: 'TUITION', status: 'pending', reason: 'Staff child discount requested' }));
  pool.slice(13, 14).forEach((s) => addPlan(s, { type: 'bursary', amount: ced(500), item: 'TUITION', status: 'rejected', reason: 'Bursary request: family hardship', decision: 'Supporting documents not provided' }));
  const duplicateFor = new Set(pool.slice(20, 24).map((s) => s.id));

  for (const s of students) {
    const termList = [];
    if (s.y1Class) for (const t of y1Terms) {
      if (s.kind === 'withdrawn' && t.start_date > s.withdrawalDate) break;
      termList.push({ t, level: s.y1Level, cls: s.y1Class });
    }
    if (s.y2Class && s.admission_date <= t21.end_date) termList.push({ t: t21, level: s.level, cls: s.y2Class });
    let balance = 0;
    const open = []; // invoice lines with remaining
    const credits = []; // { paymentId, amount }
    const allocate = (paymentId, amount, batch) => {
      let left = amount;
      const made = [];
      for (const line of open) {
        if (left <= 0) break;
        if (line.remaining <= 0) continue;
        const a = Math.min(left, line.remaining);
        line.remaining -= a; left -= a;
        made.push({ id: r.uuid(), payment_id: paymentId, invoice_line_id: line.id, amount_pesewas: a, allocation_batch_id: batch, is_reversal: false });
      }
      if (left > 0) {
        made.push({ id: r.uuid(), payment_id: paymentId, invoice_line_id: null, amount_pesewas: left, allocation_batch_id: batch, is_reversal: false });
        credits.push({ paymentId, amount: left });
      }
      allocations.push(...made);
      return made;
    };
    for (const { t, level, cls } of termList) {
      const current = t === t21;
      const issue = nextWeekday(addDays(t.start_date, -10));
      const lines = structOf[`${t.id}:${level}`].filter((l) => !l.is_optional || (l.code === 'FEEDING' && s.feeding) || (l.code === 'TRANSPORT' && s.transport));
      if (s.feeding) optional.push({ id: r.uuid(), student_id: s.id, term_id: t.id, fee_item_id: feeItems.FEEDING.id, opted_in: true });
      if (s.transport) optional.push({ id: r.uuid(), student_id: s.id, term_id: t.id, fee_item_id: feeItems.TRANSPORT.id, opted_in: true });
      const invoiceId = r.uuid();
      const total = lines.reduce((x, l) => x + l.amount_pesewas, 0);
      invoices.push({ id: invoiceId, student_id: s.id, term_id: t.id, class_id: cls.id, issue_date: issue, due_date: addDays(t.start_date, 21),
        opening_balance_pesewas: balance, total_pesewas: total, status: 'issued', generation_batch_id: null, studentCode: s.code, created_by: U.bursar });
      const newLines = lines.map((l) => ({ id: r.uuid(), invoice_id: invoiceId, fee_item_id: l.fee_item_id, description: `${feeItems[l.code].name} – ${t.name}`,
        amount_pesewas: l.amount_pesewas, allocation_priority: feeItems[l.code].allocation_priority, created_by: U.bursar, remaining: l.amount_pesewas, code: l.code }));
      newLines.sort((a, b) => a.allocation_priority - b.allocation_priority);
      invLines.push(...newLines);
      open.push(...newLines);
      for (const l of newLines) ledger.push({ id: r.uuid(), student_id: s.id, posted_at: at(issue, 8, 0), term_id: t.id, entry_type: 'invoice_charge', amount_pesewas: l.amount_pesewas,
        invoice_line_id: l.id, payment_id: null, adjustment_id: null, reverses_entry_id: null, description: l.description, posted_by: U.bursar });
      balance += total;
      // auto-apply existing credit to the new invoice (re-allocation: negative credit row + new rows)
      for (const cr of credits.filter((x) => x.amount > 0)) {
        const batch = r.uuid();
        const amt = cr.amount;
        cr.amount = 0;
        allocations.push({ id: r.uuid(), payment_id: cr.paymentId, invoice_line_id: null, amount_pesewas: -amt, allocation_batch_id: batch, is_reversal: true });
        allocate(cr.paymentId, amt, batch);
      }
      // adjustments
      if (current) for (const a of adjPlan.get(s.id) ?? []) {
        const tuitionLine = newLines.find((l) => l.code === a.item);
        const amount = a.amount ?? (a.bp ? Math.round((tuitionLine.amount_pesewas * a.bp) / 10000 / 100) * 100 : tuitionLine.amount_pesewas);
        const adjId = r.uuid();
        const reqDate = nextWeekday(addDays(t.start_date, r.int(1, 10)));
        const decided = a.status !== 'pending';
        adjustments.push({ id: adjId, student_id: s.id, term_id: t.id, type: a.type, fee_item_id: a.item ? feeItems[a.item].id : null, amount_pesewas: amount, percent_bp: a.bp ?? null,
          reason: a.reason, status: a.status, requested_by: U.bursar, requested_at: at(reqDate, 10, 0),
          approved_by: decided ? U.head : null, approved_at: decided ? at(addDays(reqDate, 1), 11, 0) : null,
          rejected_reason: a.status === 'rejected' ? a.decision : null, decision_reason: a.decision ?? (decided ? 'Approved per school policy' : null), created_by: U.bursar });
        if (a.status === 'approved') {
          const signed = a.type === 'manual_charge' ? amount : -amount;
          ledger.push({ id: r.uuid(), student_id: s.id, posted_at: at(addDays(reqDate, 1), 11, 0), term_id: t.id, entry_type: 'adjustment', amount_pesewas: signed,
            invoice_line_id: null, payment_id: null, adjustment_id: adjId, reverses_entry_id: null, description: `${a.type.replace(/_/g, ' ')}: ${a.reason}`, posted_by: U.head });
          balance += signed;
        }
      }
      // payments
      const due = balance;
      if (due <= 0) continue;
      const behaviour = s.fam.behaviour;
      let fraction;
      if (s.kind === 'withdrawn' && t.end_date >= s.withdrawalDate) fraction = 1; // cleared before leaving
      else if (!current) fraction = behaviour === 'good' ? 1 : behaviour === 'partial' ? 0.5 + r.next() * 0.4 : r.next() * 0.4;
      else fraction = behaviour === 'good' ? (r.chance(0.7) ? 1 : 0.5) : behaviour === 'partial' ? 0.3 + r.next() * 0.4 : r.next() * 0.3;
      let toPay = fraction >= 1 ? due : Math.min(due, roundTo10(due * fraction));
      if (fraction < 0.05) continue;
      if (fraction >= 1 && behaviour === 'good' && r.chance(0.03)) toPay += ced(100); // small overpayment → credit
      const parts = toPay >= ced(800) && r.chance(0.45) ? 2 : 1;
      const lastDay = minDate(s.kind === 'withdrawn' && t.end_date >= s.withdrawalDate ? s.withdrawalDate : t.end_date, PAY_CUTOFF);
      const firstDay = maxDate(addDays(t.start_date, -7), s.admission_date);
      if (firstDay > lastDay) continue;
      const dates = Array.from({ length: parts }, () => randomWeekday(r, firstDay, lastDay)).sort();
      let remainingToPay = toPay;
      dates.forEach((d, k) => {
        const amount = k === parts - 1 ? remainingToPay : roundTo10(toPay * (0.4 + r.next() * 0.2));
        remainingToPay -= amount;
        if (amount <= 0) return;
        const method = methodPick();
        const ref = method === 'cash' ? null : method === 'cheque' ? null : method === 'bank_transfer' ? `FT${r.digits(10)}` : r.digits(11);
        const p = {
          id: r.uuid(), student_id: s.id, payer_guardian_id: s.fam.payer.id, payer_name: `${s.fam.payer.first_name} ${s.fam.payer.last_name}`, amount_pesewas: amount, method,
          reference_no: ref, bank_name: method === 'bank_transfer' || method === 'cheque' ? r.pick(banks) : null, cheque_no: method === 'cheque' ? r.digits(6) : null,
          received_at: at(d, r.int(7, 15), r.int(0, 59)), recorded_by: U.bursar, notes: null, status: 'confirmed', source: 'manual', idempotency_key: r.uuid(),
          reversed_at: null, reversed_by: null, reversal_reason: null, business_date: d,
        };
        payments.push(p);
        allocate(p.id, amount, r.uuid());
        const entry = { id: r.uuid(), student_id: s.id, posted_at: p.received_at, term_id: t.id, entry_type: 'payment', amount_pesewas: -amount, invoice_line_id: null,
          payment_id: p.id, adjustment_id: null, reverses_entry_id: null, description: `Payment (${method.replace(/_/g, ' ')})`, posted_by: U.bursar };
        ledger.push(entry);
        balance -= amount;
        // a duplicate entry recorded by mistake, then reversed the same day
        if (current && duplicateFor.has(s.id) && k === 0) {
          duplicateFor.delete(s.id);
          const dupAt = new Date(new Date(p.received_at).getTime() + 20 * 60000).toISOString().replace('.000', '');
          const dup = { ...p, id: r.uuid(), received_at: dupAt, idempotency_key: r.uuid(), notes: 'Recorded twice by mistake', duplicate_override_reason: null };
          payments.push(dup);
          const made = allocate(dup.id, amount, r.uuid());
          const dupEntry = { ...entry, id: r.uuid(), posted_at: dupAt, payment_id: dup.id };
          ledger.push(dupEntry);
          const revAt = new Date(new Date(dupAt).getTime() + 60 * 60000).toISOString().replace('.000', '');
          const revBatch = r.uuid();
          for (const m of made) {
            allocations.push({ id: r.uuid(), payment_id: dup.id, invoice_line_id: m.invoice_line_id, amount_pesewas: -m.amount_pesewas, allocation_batch_id: revBatch, is_reversal: true });
            if (m.invoice_line_id) open.find((l) => l.id === m.invoice_line_id).remaining += m.amount_pesewas;
            else credits.find((cr) => cr.paymentId === dup.id).amount -= m.amount_pesewas;
          }
          const revEntry = { id: r.uuid(), student_id: s.id, posted_at: revAt, term_id: t.id, entry_type: 'reversal', amount_pesewas: amount, invoice_line_id: null,
            payment_id: dup.id, adjustment_id: null, reverses_entry_id: dupEntry.id, description: 'Reversal: duplicate entry', posted_by: U.bursar };
          reversalLedger.push(revEntry);
          Object.assign(dup, { status: 'reversed', reversed_at: revAt, reversed_by: U.admin, reversal_reason: 'Duplicate entry: payment was recorded twice' });
          paymentReversals.push({ id: r.uuid(), payment_id: dup.id, reason: 'Duplicate entry: payment was recorded twice', status: 'approved', requested_by: U.bursar,
            requested_at: dupAt, approved_by: U.admin, approved_at: revAt, ledger_entry_id: revEntry.id, revAt });
        }
      });
    }
    s.balance = balance;
    s.y1Balance = null;
  }

  // numbers in chronological order (gap-free)
  invoices.sort((a, b) => a.issue_date.localeCompare(b.issue_date) || a.studentCode.localeCompare(b.studentCode));
  invoices.forEach((inv, k) => { inv.invoice_no = docNo('INV', k + 1); });
  payments.sort((a, b) => a.received_at.localeCompare(b.received_at) || a.id.localeCompare(b.id));
  payments.forEach((p, k) => { p.receipt_no = docNo('RCP', k + 1); });
  paymentReversals.sort((a, b) => a.revAt.localeCompare(b.revAt));
  paymentReversals.forEach((pr, k) => { pr.reversal_no = docNo('REV', k + 1); });

  // cash-ups: one closed cash-up per business day with payments
  const days = [...new Set(payments.map((p) => p.business_date))].sort();
  const varianceDays = new Set([r.pick(days), r.pick(days)]);
  const cashUps = days.map((d) => {
    const expected = {};
    for (const p of payments.filter((x) => x.business_date === d && x.status === 'confirmed')) expected[p.method] = (expected[p.method] ?? 0) + p.amount_pesewas;
    const counted = { ...expected };
    let variance = 0;
    if (varianceDays.has(d) && counted.cash) { counted.cash -= 500; variance = -500; }
    return { id: r.uuid(), business_date: d, opened_by: U.bursar, opened_at: at(d, 7, 0), closed_by: U.bursar, closed_at: at(d, 16, 30),
      expected_by_method: JSON.stringify(expected), counted_by_method: JSON.stringify(counted), variance_pesewas: variance,
      notes: variance ? 'Cash short by GH₵ 5.00; recounted twice' : null, status: 'closed' };
  });
  const cashUpByDay = Object.fromEntries(cashUps.map((x) => [x.business_date, x.id]));
  await insert(c, 'app.cash_ups', cashUps);

  await insert(c, 'app.student_optional_items', optional);
  await insert(c, 'app.invoices', invoices.map(({ studentCode, ...i }) => i));
  await insert(c, 'app.invoice_lines', invLines.map(({ remaining, code, ...l }) => l));
  await insert(c, 'app.adjustments', adjustments);
  await insert(c, 'app.payments', payments.map(({ business_date, ...p }) => ({ ...p, cash_up_id: cashUpByDay[business_date], duplicate_override_reason: p.duplicate_override_reason ?? null })));
  await insert(c, 'app.payment_allocations', allocations);
  ledger.sort((a, b) => a.posted_at.localeCompare(b.posted_at) || a.id.localeCompare(b.id));
  await insert(c, 'app.ledger_entries', ledger);
  await insert(c, 'app.ledger_entries', reversalLedger);
  await insert(c, 'app.payment_reversals', paymentReversals.map(({ revAt, ...x }) => x));

  // promotion run items (outstanding snapshot = Y1 balance from the ledger)
  const y1Bal = Object.fromEntries((await c.query(`SELECT le.student_id, sum(le.amount_pesewas)::bigint AS b FROM app.ledger_entries le WHERE le.posted_at < '2026-08-01' GROUP BY 1`)).rows.map((x) => [x.student_id, Number(x.b)]));
  const items = students.filter((s) => s.y1Class && s.kind !== 'withdrawn').map((s) => {
    const owed = y1Bal[s.id] ?? 0;
    return { id: r.uuid(), run_id: promotionRunId, student_id: s.id, from_enrolment_id: s.y1EnrolmentId,
      action: s.kind === 'alumni' ? 'graduate' : s.repeater ? 'repeat' : 'promote', target_class_id: s.y2Class?.id ?? null,
      outstanding_pesewas_snapshot: owed, arrears_flag: owed > 0, override_reason: null, created_enrolment_id: s.y2EnrolmentId ?? null, previous_status: 'active' };
  });
  await insert(c, 'app.promotion_run_items', items);

  // counters
  await c.query(`UPDATE app.doc_counters SET last_value = CASE doc_type WHEN 'invoice' THEN $1::bigint WHEN 'receipt' THEN $2::bigint WHEN 'reversal' THEN $3::bigint WHEN 'transfer_letter' THEN $4::bigint ELSE last_value END`,
    [invoices.length, payments.length, paymentReversals.length, tl]);

  const summary = {
    students: students.length, activeStudents: currentStudents.length, alumni: 60, withdrawn: 8, families: families.length, guardians: guardians.length,
    staff: staff.length, users: users.length, classes: classRows.length, invoices: invoices.length, payments: payments.length,
    adjustments: adjustments.length, ledgerEntries: ledger.length + reversalLedger.length, medical: medical.length,
  };
  log(`generated ${JSON.stringify(summary)}`);
  return summary;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.SMS_DB_URL;
  if (!url) { console.error('SMS_DB_URL is not set'); process.exit(1); }
  const i = process.argv.indexOf('--seed');
  const seedNo = i > 0 ? Number(process.argv[i + 1]) : DEFAULT_SEED;
  if (!Number.isInteger(seedNo)) { console.error('--seed must be an integer'); process.exit(1); }
  seed(url, { seed: seedNo }).catch((e) => { console.error(e.message); process.exit(1); });
}
