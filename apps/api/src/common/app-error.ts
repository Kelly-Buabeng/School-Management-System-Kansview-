import type { ErrorCode } from '@sms/shared';

export interface FieldError {
  field: string;
  code: string;
  message: string;
}

/**
 * The only error type domain code should throw for expected failures.
 * Rendered as RFC 9457 problem+json by ProblemFilter. `title` and `detail` are shown to school staff: plain English.
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    public readonly title: string,
    public readonly detail?: string,
    public readonly errors?: FieldError[],
    public readonly meta?: Record<string, unknown>,
  ) {
    super(detail ? `${title}: ${detail}` : title);
    this.name = 'AppError';
  }

  static notFound(what = 'record'): AppError {
    return new AppError(404, 'NOT_FOUND', `This ${what} was not found`);
  }
}
