// Contract sanity check: every operation has a unique operationId and an x-permission.
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
const spec = parse(readFileSync(new URL('../openapi.yaml', import.meta.url), 'utf8'));
const ids = new Set();
const problems = [];
let count = 0;
for (const [path, item] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(item)) {
    if (method === 'parameters') continue;
    count++;
    if (!op.operationId) problems.push(`${method.toUpperCase()} ${path}: missing operationId`);
    else if (ids.has(op.operationId)) problems.push(`duplicate operationId ${op.operationId}`);
    ids.add(op.operationId);
    if (!op['x-permission']) problems.push(`${method.toUpperCase()} ${path}: missing x-permission`);
  }
}
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log(`openapi ok: ${count} operations`);
