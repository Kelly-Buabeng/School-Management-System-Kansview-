import { z } from 'zod';

export const PageQuery = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type PageQuery = z.infer<typeof PageQuery>;

export interface Page<T> {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
}

export function pageOffset(q: PageQuery): { limit: number; offset: number } {
  return { limit: q.pageSize, offset: (q.page - 1) * q.pageSize };
}
