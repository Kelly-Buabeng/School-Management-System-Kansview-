// Owner: Agent H. Contract test: routes registered in NestJS vs. paths/methods in packages/contracts/openapi.yaml.
// FAILS when a route exists in code but not in the spec (undocumented API surface, possibly unguarded by review).
// PRINTS (does not fail) spec operations not implemented yet, so progress is visible during Phase 1.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { RequestMethod } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { parse } from 'yaml';
import { createTestDatabase, type TestDatabase } from './support/test-db';
import { createTestApp } from './support/test-app';

const SPEC_PATH = join(__dirname, '../../../packages/contracts/openapi.yaml');
const GLOBAL_PREFIX = '/api/v1';
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/** `/students/:id/guardians/:guardianId` and `/students/{id}/guardians/{guardianId}` → `/students/{}/guardians/{}` */
export function normalisePath(p: string): string {
  const withSlash = ('/' + p).replace(/\/+/g, '/').replace(/\/$/, '') || '/';
  return withSlash.replace(/:[A-Za-z0-9_]+/g, '{}').replace(/\{[^}]+\}/g, '{}');
}

function specOperations(): Set<string> {
  const spec = parse(readFileSync(SPEC_PATH, 'utf8')) as { paths: Record<string, Record<string, unknown>> };
  const ops = new Set<string>();
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const m of HTTP_METHODS) if (item[m]) ops.add(`${m.toUpperCase()} ${normalisePath(path)}`);
  }
  return ops;
}

function codeOperations(app: INestApplication): Map<string, string> {
  const discovery = app.get(DiscoveryService);
  const scanner = app.get(MetadataScanner);
  const reflector = app.get(Reflector);
  const ops = new Map<string, string>(); // op -> Controller.handler
  for (const wrapper of discovery.getControllers()) {
    const { instance, metatype } = wrapper;
    if (!instance || !metatype) continue;
    const ctrlPaths = ([] as string[]).concat(reflector.get<string | string[]>(PATH_METADATA, metatype) ?? '');
    const proto = Object.getPrototypeOf(instance) as Record<string, unknown>;
    for (const name of scanner.getAllMethodNames(proto)) {
      const handler = proto[name] as object;
      const routePaths = Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined;
      if (routePaths === undefined) continue; // not a route handler
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod;
      const verb = RequestMethod[method];
      for (const cp of ctrlPaths) {
        for (const rp of ([] as string[]).concat(routePaths)) {
          const full = normalisePath(`${cp}/${rp}`);
          if (verb === 'ALL') {
            for (const m of HTTP_METHODS) ops.set(`${m.toUpperCase()} ${full}`, `${metatype.name}.${name}`);
          } else {
            ops.set(`${verb} ${full}`, `${metatype.name}.${name}`);
          }
        }
      }
    }
  }
  return ops;
}

describe('contract: Nest routes match openapi.yaml', () => {
  let db: TestDatabase;
  let app: INestApplication;

  beforeAll(async () => {
    db = await createTestDatabase('sms_t_h');
    ({ app } = await createTestApp(db.url));
  });
  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  it('normalises both path styles the same way', () => {
    expect(normalisePath('students/:id/guardians/:guardianId')).toBe('/students/{}/guardians/{}');
    expect(normalisePath('/students/{id}/guardians/{guardianId}')).toBe('/students/{}/guardians/{}');
    expect(normalisePath('health/')).toBe('/health');
  });

  it('every route registered in code is documented in the OpenAPI spec', () => {
    const spec = specOperations();
    const code = codeOperations(app);
    expect(code.size).toBeGreaterThan(0);

    const undocumented = [...code.entries()].filter(([op]) => !spec.has(op)).map(([op, h]) => `${op}  (${h})`).sort();
    const notImplemented = [...spec].filter((op) => !code.has(op)).sort();

    const implemented = spec.size - notImplemented.length;
    // Visible progress report in the test output (global prefix shown for readability).
    console.info(
      `[contract-routes] ${implemented}/${spec.size} spec operations implemented.` +
        (notImplemented.length ? `\nNot implemented yet (${notImplemented.length}):\n  ` + notImplemented.map((o) => o.replace(' ', ` ${GLOBAL_PREFIX}`)).join('\n  ') : ''),
    );
    if (undocumented.length) {
      console.error(`[contract-routes] Routes in code but NOT in openapi.yaml (add them via a change request or remove them):\n  ${undocumented.join('\n  ')}`);
    }
    expect(undocumented, 'routes in code but not in packages/contracts/openapi.yaml').toEqual([]);
  });
});
