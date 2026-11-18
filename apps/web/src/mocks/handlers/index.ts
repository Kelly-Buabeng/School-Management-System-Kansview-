import { http, HttpResponse } from 'msw';
import { authHandlers } from './auth';
import { studentHandlers } from './students';
import { financeHandlers } from './finance';
import { schoolHandlers } from './school';
import { adminHandlers } from './admin';
import { BASE, problem } from '../http';

export const handlers = [
  ...authHandlers,
  ...financeHandlers, // before students: /payments/duplicate-check must win over /payments/:id
  ...studentHandlers,
  ...schoolHandlers,
  ...adminHandlers,
  // Anything else under /api/v1 that the mock does not implement yet answers like the real stubs do.
  http.all(`${BASE}/*`, ({ request }) =>
    request.method === 'GET' && new URL(request.url).pathname.endsWith('/health/live')
      ? HttpResponse.json({ ok: true })
      : problem(501, 'NOT_IMPLEMENTED', 'This part is not available in the demo yet.'),
  ),
];
