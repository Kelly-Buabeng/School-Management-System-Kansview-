// Owner: Agent H. k6 load test: a busy school morning on the seeded school (1,000 students), 15 concurrent staff.
// Mix per iteration (with 1-3 s think time, like real people): search 40%, student profile 25%,
// payment entry 20% (unique Idempotency-Key each), attendance register save 15%.
// Thresholds: p95 < 500 ms for every action, zero failed requests.
//
//   BASE_URL=http://localhost:4300 k6 run tests/load/school-day.k6.js
//   (or: bash scripts/load-test.sh  - starts a fresh seeded stack first)
import http from 'k6/http';
import { check, sleep } from 'k6';
import { hmac } from 'k6/crypto';
import { Trend } from 'k6/metrics';

const BASE = (__ENV.BASE_URL || 'http://localhost:4300') + '/api/v1';
const VUS = Number(__ENV.VUS || 15);
const DURATION = __ENV.DURATION || '3m';

export const options = {
  scenarios: {
    school_day: { executor: 'constant-vus', vus: VUS, duration: DURATION, gracefulStop: '15s' },
  },
  thresholds: {
    http_req_failed: ['rate==0'],
    'http_req_duration{action:search}': ['p(95)<500'],
    'http_req_duration{action:profile}': ['p(95)<500'],
    'http_req_duration{action:payment}': ['p(95)<500'],
    'http_req_duration{action:attendance}': ['p(95)<500'],
    checks: ['rate==1'],
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

const paymentTrend = new Trend('payment_create_ms', true);

// Fake dev accounts from db/seeds (never real people). ADMIN/BURSAR use TOTP.
const USERS = {
  registrar: { username: 'registrar', password: 'Kansview-Registrar-Dev-2026!' },
  head: { username: 'head', password: 'Kansview-Head-Dev-2026!' },
  bursar: { username: 'bursar', password: 'Kansview-Bursar-Dev-2026!', totp: 'KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU' },
  'teacher.kg1a': { username: 'teacher.kg1a', password: 'Kansview-Teacher-Dev-2026!' },
  'teacher.p1a': { username: 'teacher.p1a', password: 'Kansview-Teacher-Dev-2026!' },
  'teacher.p4b': { username: 'teacher.p4b', password: 'Kansview-Teacher-Dev-2026!' },
  'teacher.jhs2a': { username: 'teacher.jhs2a', password: 'Kansview-Teacher-Dev-2026!' },
};
const SEARCHERS = ['registrar', 'head', 'teacher.kg1a', 'teacher.p1a', 'teacher.p4b', 'teacher.jhs2a'];
const NAMES = ['Mensah', 'Owusu', 'Kwame', 'Akosua', 'Tetteh', 'Addo', 'Abdulai', 'Esi', 'Yaw', 'Quaye', 'Agyeman', 'Dogbe', 'Ama', 'Kofi', 'KSV-2'];

function base32ToBytes(s) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of s) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const out = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return out.buffer;
}
function totp(secret) {
  const counter = Math.floor(Date.now() / 30000);
  const msg = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) { msg[i] = c & 0xff; c = Math.floor(c / 256); }
  const h = new Uint8Array(hmac('sha1', base32ToBytes(secret), msg.buffer, 'binary'));
  const o = h[h.length - 1] & 0xf;
  const code = (((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1000000;
  return String(code).padStart(6, '0');
}
function cookieFrom(res) {
  const c = res.cookies['__Host-sms_session'];
  return c && c.length ? `__Host-sms_session=${c[0].value}` : null;
}
function login(key) {
  const u = USERS[key];
  const res = http.post(`${BASE}/auth/login`, JSON.stringify({ username: u.username, password: u.password }), { headers: { 'Content-Type': 'application/json' }, tags: { action: 'setup' } });
  if (res.status !== 200) throw new Error(`login ${key} failed: ${res.status} ${res.body}`);
  let body = res.json();
  let cookie = cookieFrom(res);
  let csrf = body.user.csrfToken;
  if (body.mfaRequired) {
    const v = http.post(`${BASE}/auth/mfa/verify`, JSON.stringify({ code: totp(u.totp) }), { headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrf }, tags: { action: 'setup' } });
    if (v.status !== 200) throw new Error(`mfa ${key} failed: ${v.status} ${v.body}`);
    cookie = cookieFrom(v) || cookie;
    csrf = v.json().csrfToken;
  }
  return { cookie, csrf };
}
function hdrs(s, extra) {
  return Object.assign({ 'Content-Type': 'application/json', Cookie: s.cookie, 'X-CSRF-Token': s.csrf }, extra || {});
}
function lastSchoolDay() {
  const d = new Date();
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10); // Africa/Accra is UTC+0
}

export function setup() {
  const sessions = {};
  for (const k of Object.keys(USERS)) sessions[k] = login(k);
  const reg = sessions.registrar;
  const studentIds = [];
  for (let page = 1; page <= 10; page++) {
    const r = http.get(`${BASE}/students?page=${page}&pageSize=100`, { headers: hdrs(reg), tags: { action: 'setup' } });
    for (const s of r.json().data) studentIds.push(s.id);
  }
  const years = http.get(`${BASE}/academic-years`, { headers: hdrs(reg), tags: { action: 'setup' } }).json();
  const year = years.find((y) => y.status === 'current');
  const classes = http.get(`${BASE}/classes?academicYearId=${year.id}`, { headers: hdrs(reg), tags: { action: 'setup' } }).json();
  const date = lastSchoolDay();
  const registers = [];
  for (const c of classes.slice(0, 12)) {
    const r = http.get(`${BASE}/classes/${c.id}/attendance?date=${date}`, { headers: hdrs(reg), tags: { action: 'setup' } });
    if (r.status === 200) registers.push({ classId: c.id, records: r.json().records.map((x) => ({ studentId: x.studentId, status: 'present' })) });
  }
  if (studentIds.length < 900) throw new Error(`expected the 1,000-student seed, found ${studentIds.length}`);
  return { sessions, studentIds, registers, date };
}

const pick = (a) => a[Math.floor(Math.random() * a.length)];

export default function (data) {
  const roll = Math.random();
  if (roll < 0.4) {
    const who = SEARCHERS[(__VU + __ITER) % SEARCHERS.length];
    const q = pick(NAMES);
    const r = http.get(`${BASE}/search?q=${encodeURIComponent(q)}`, { headers: hdrs(data.sessions[who]), tags: { action: 'search' } });
    check(r, { 'search 200': (x) => x.status === 200 });
  } else if (roll < 0.65) {
    const id = pick(data.studentIds);
    const s = data.sessions[Math.random() < 0.5 ? 'registrar' : 'head'];
    const r = http.get(`${BASE}/students/${id}`, { headers: hdrs(s), tags: { action: 'profile' } });
    check(r, { 'profile 200': (x) => x.status === 200 });
  } else if (roll < 0.85) {
    const id = pick(data.studentIds);
    const key = `load-${__VU}-${__ITER}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const body = { studentId: id, amountPesewas: 100 + Math.floor(Math.random() * 900), method: 'cash', receivedAt: new Date().toISOString(), payerName: 'Load Test Payer' };
    const r = http.post(`${BASE}/payments`, JSON.stringify(body), { headers: hdrs(data.sessions.bursar, { 'Idempotency-Key': key }), tags: { action: 'payment' } });
    paymentTrend.add(r.timings.duration);
    check(r, { 'payment 201': (x) => x.status === 201 });
  } else if (data.registers.length) {
    const reg = pick(data.registers);
    const records = reg.records.map((x) => ({ studentId: x.studentId, status: Math.random() < 0.05 ? 'absent' : 'present' }));
    const r = http.put(`${BASE}/classes/${reg.classId}/attendance?date=${data.date}`, JSON.stringify({ records }), { headers: hdrs(data.sessions.registrar), tags: { action: 'attendance' } });
    check(r, { 'attendance 200': (x) => x.status === 200 });
  }
  sleep(1 + Math.random() * 2);
}
