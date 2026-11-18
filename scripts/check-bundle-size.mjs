#!/usr/bin/env node
// Owner: Agent H. Bundle budget: fails when the JavaScript a browser must download before the first screen
// (entry <script type="module"> + <link rel="modulepreload"> in dist/index.html) exceeds the budget, gzip-compressed.
// Usage: node scripts/check-bundle-size.mjs [distDir=apps/web/dist] [budgetKB=250]
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const dist = resolve(process.argv[2] ?? 'apps/web/dist');
const budgetKB = Number(process.argv[3] ?? process.env.BUNDLE_BUDGET_KB ?? 250);
const indexPath = join(dist, 'index.html');
if (!existsSync(indexPath)) {
  console.error(`bundle-size: ${indexPath} not found. Build the web app first (pnpm --filter @sms/web build).`);
  process.exit(2);
}
const html = readFileSync(indexPath, 'utf8');
const refs = new Set();
for (const m of html.matchAll(/<script[^>]*type="module"[^>]*src="([^"]+)"/g)) refs.add(m[1]);
for (const m of html.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="([^"]+)"/g)) refs.add(m[1]);
for (const m of html.matchAll(/<link[^>]*href="([^"]+)"[^>]*rel="modulepreload"/g)) refs.add(m[1]);
if (refs.size === 0) {
  console.error('bundle-size: no module scripts found in index.html');
  process.exit(2);
}
let total = 0;
const rows = [];
for (const ref of refs) {
  const file = join(dist, ref.replace(/^\//, ''));
  const gz = gzipSync(readFileSync(file), { level: 9 }).length;
  total += gz;
  rows.push([ref, gz]);
}
rows.sort((a, b) => b[1] - a[1]);
for (const [ref, gz] of rows) console.log(`${(gz / 1024).toFixed(1).padStart(8)} KB  ${ref}`);
const totalKB = total / 1024;
console.log(`${totalKB.toFixed(1).padStart(8)} KB  initial JS (gzip), budget ${budgetKB} KB`);
if (totalKB > budgetKB) {
  console.error(`bundle-size: OVER BUDGET by ${(totalKB - budgetKB).toFixed(1)} KB. Lazy-load more screens (React.lazy) or drop heavy dependencies.`);
  process.exit(1);
}
console.log('bundle-size: ok');
