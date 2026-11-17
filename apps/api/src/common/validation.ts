import type { z } from 'zod';

/**
 * Parse and validate a request body/query with a strict Zod schema (unknown keys rejected → no mass assignment).
 * Throws ZodError, rendered as 400 VALIDATION_FAILED by ProblemFilter.
 * Prefer schemas generated from the OpenAPI spec; hand-written schemas must use z.strictObject.
 */
export function parseWith<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  return schema.parse(input);
}
