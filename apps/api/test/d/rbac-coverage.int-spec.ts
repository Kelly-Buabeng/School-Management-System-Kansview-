/**
 * CI gate `test:rbac-coverage`.
 * Boots the real AppModule, enumerates every registered HTTP route through Nest's module container and reflection,
 * and fails if any route lacks a permission declaration (@RequirePermission / @Public / @Access), declares an unknown
 * permission, or declares a different permission from the route's `x-permission` in packages/contracts/openapi.yaml.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RequestMethod, type INestApplication } from '@nestjs/common';
import { MetadataScanner, ModulesContainer } from '@nestjs/core';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { parse } from 'yaml';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { createTestApp } from '../support/test-app';
import { PERMISSION_KEY } from '../../src/security/decorators';
import { PERMISSIONS } from '../../src/security/permissions';

interface RouteInfo {
  controller: string;
  handler: string;
  method: string;
  path: string;
  permission: string | undefined;
}

const SPECIAL = new Set(['public', 'self', 'mfa-pending-session', 'owner-of-export', 'inherits-from-owning-record']);

let tdb: TestDatabase;
let app: INestApplication;
let routes: RouteInfo[] = [];

function joinPath(...parts: Array<string | undefined>): string {
  const p = parts.filter((x) => x !== undefined && x !== '' && x !== '/').map((x) => x!.replace(/^\/+|\/+$/g, '')).join('/');
  return `/${p}`.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

beforeAll(async () => {
  tdb = await createTestDatabase('d_rbac');
  ({ app } = await createTestApp(tdb.url));
  const container = app.get(ModulesContainer);
  const scanner = new MetadataScanner();
  for (const mod of container.values()) {
    for (const wrapper of mod.controllers.values()) {
      const instance = wrapper.instance as object | undefined;
      const metatype = wrapper.metatype as (new (...a: unknown[]) => unknown) | undefined;
      if (!instance || !metatype) continue;
      const proto = Object.getPrototypeOf(instance) as Record<string, unknown>;
      const ctrlPathMeta = Reflect.getMetadata(PATH_METADATA, metatype) as string | string[] | undefined;
      const ctrlPaths = Array.isArray(ctrlPathMeta) ? ctrlPathMeta : [ctrlPathMeta ?? ''];
      for (const name of scanner.getAllMethodNames(proto)) {
        const handler = proto[name] as (...a: unknown[]) => unknown;
        const pathMeta = Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        if (pathMeta === undefined || method === undefined) continue; // not a route handler
        const permission = (Reflect.getMetadata(PERMISSION_KEY, handler) ?? Reflect.getMetadata(PERMISSION_KEY, metatype)) as string | undefined;
        for (const cp of ctrlPaths) {
          for (const hp of Array.isArray(pathMeta) ? pathMeta : [pathMeta]) {
            routes.push({ controller: metatype.name, handler: name, method: RequestMethod[method], path: joinPath(cp, hp), permission });
          }
        }
      }
    }
  }
});

afterAll(async () => {
  await app?.close();
  await tdb?.drop();
});

describe('RBAC coverage', () => {
  it('found the registered routes', () => {
    expect(routes.length).toBeGreaterThan(5);
    expect(routes.some((r) => r.path === '/auth/login' && r.method === 'POST')).toBe(true);
  });

  it('every route declares a permission (@RequirePermission, @Public or @Access)', () => {
    const missing = routes.filter((r) => !r.permission).map((r) => `${r.method} ${r.path} (${r.controller}.${r.handler})`);
    expect(missing, `Routes without a permission declaration:\n${missing.join('\n')}`).toEqual([]);
  });

  it('every declared permission exists in the catalogue', () => {
    const known = new Set<string>([...PERMISSIONS, ...SPECIAL]);
    const bad = routes.filter((r) => r.permission && !known.has(r.permission)).map((r) => `${r.method} ${r.path}: ${r.permission}`);
    expect(bad).toEqual([]);
  });

  it('routes that are in openapi.yaml declare the same x-permission', () => {
    const spec = parse(readFileSync(join(__dirname, '../../../../packages/contracts/openapi.yaml'), 'utf8')) as { paths: Record<string, Record<string, { 'x-permission'?: string }>> };
    const mismatches: string[] = [];
    for (const r of routes) {
      const op = spec.paths[r.path]?.[r.method.toLowerCase()];
      if (!op) continue; // extra routes are allowed (additive); they still need a permission (checked above)
      if (op['x-permission'] !== r.permission) mismatches.push(`${r.method} ${r.path}: code=${r.permission} spec=${op['x-permission']}`);
    }
    expect(mismatches, mismatches.join('\n')).toEqual([]);
  });

  it('public routes are only the ones the contract marks public', () => {
    const publicRoutes = routes.filter((r) => r.permission === 'public').map((r) => `${r.method} ${r.path}`).sort();
    const allowed = new Set(['POST /auth/login', 'POST /auth/password/reset-request', 'POST /auth/password/reset', 'GET /health/live', 'GET /health/ready']);
    expect(publicRoutes.filter((r) => !allowed.has(r))).toEqual([]);
  });
});
