// Takes desktop (1366×768) and phone (360×780) screenshots of the main screens in mock mode.
// Usage: pnpm build && pnpm preview &  then  node e2e/screenshots.mjs [outDir] [filter]
import { chromium } from '@playwright/test';

const out = process.argv[2] ?? 'docs/screenshots';
const filter = process.argv[3] ?? '';
const BASE = 'http://localhost:4173';

const SCREENS = [
  { name: '01-sign-in', user: null, path: '/login' },
  { name: '04-dashboard', user: 'admin', path: '/' },
  { name: '05-students', user: 'bursar', path: '/students' },
  { name: '06-guardian', user: 'bursar', path: 'guardian' },
  { name: '07-record-payment', user: 'bursar', path: 'pay' },
  { name: '08-fee-setup', user: 'bursar', path: '/finance/fees' },
  { name: '09-receipt', user: 'bursar', path: 'receipt' },
  { name: '10-promotion', user: 'admin', path: 'promotion' },
  { name: '11-emergency', user: 'registrar', path: 'emergency' },
  { name: '12-bulk-message', user: 'head', path: '/messages?kind=emergency' },
  { name: '13-attendance', user: 'teacher', path: '/attendance' },
  { name: '14-student-profile', user: 'registrar', path: 'student' },
];
const MFA = new Set(['admin', 'bursar']);

async function signIn(page, user) {
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Username').fill(user);
  await page.getByLabel('Password').fill('password123');
  await page.getByRole('button', { name: 'Sign in' }).click();
  if (MFA.has(user)) {
    await page.getByText('Enter your security code').waitFor();
    await page.keyboard.type('123456');
    await page.getByRole('button', { name: 'Continue' }).click();
  }
  await page.locator('#main').waitFor();
}

async function openKwame(page, suffix = '') {
  await page.goto(`${BASE}/students?q=Kwame%20Agyei`);
  await page.getByRole('link', { name: /Kwame Agyei Mensah/ }).first().click();
  await page.waitForURL(/\/students\/[^/]+$/);
  if (suffix) await page.goto(page.url() + suffix);
}

async function go(page, s) {
  switch (s.path) {
    case 'guardian':
      await page.goto(`${BASE}/guardians?q=Owusu`);
      await page.getByRole('link', { name: /Akosua Owusu/ }).first().click();
      await page.getByText('Linked children').waitFor();
      break;
    case 'pay':
      await openKwame(page);
      await page.goto(page.url().replace(/\/students\/([^/]+)$/, '/finance/payments/new?studentId=$1'));
      await page.getByText('What is this payment for?').waitFor();
      await page.waitForTimeout(600);
      break;
    case 'receipt':
      await page.goto(`${BASE}/finance/payments`);
      await page.getByRole('link', { name: /^RCP-/ }).first().click();
      await page.getByText('Official fee receipt').waitFor();
      break;
    case 'promotion':
      await page.goto(`${BASE}/promotion`);
      await page.getByText('Class to promote').first().waitFor();
      break;
    case 'emergency':
      await openKwame(page, '/emergency');
      await page.getByText('Call in this order').waitFor();
      break;
    case 'student':
      await openKwame(page);
      break;
    default:
      await page.goto(`${BASE}${s.path}`);
  }
  await page.waitForFunction(() => !/Loading|Searching/.test(document.body.innerText), null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(400);
}

const browser = await chromium.launch();
for (const s of SCREENS.filter((x) => x.name.includes(filter))) {
  for (const [label, viewport] of [['desktop', { width: 1366, height: 768 }], ['phone', { width: 360, height: 780 }]]) {
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    try {
      if (s.user) await signIn(page, s.user);
      await go(page, s);
      await page.screenshot({ path: `${out}/${s.name}-${label}.png`, fullPage: label === 'phone' });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      console.log(`${s.name}-${label}${overflow > 0 ? `  (horizontal overflow ${overflow}px)` : ''}`);
    } catch (e) {
      console.log(`FAILED ${s.name}-${label}: ${String(e.message).split('\n')[0]}`);
    }
    await ctx.close();
  }
}
await browser.close();
