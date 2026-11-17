import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { ZodError } from 'zod';
import { AppError } from './app-error';

const slug = (code: string) => code.toLowerCase().replace(/_/g, '-');

/** Renders every error as application/problem+json. Never leaks stack traces. */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger('ProblemFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse();
    const req = ctx.getRequest();
    const requestId: string = req?.id ?? req?.headers?.['x-request-id'] ?? 'unknown';

    let status = 500;
    let body: Record<string, unknown>;

    if (exception instanceof AppError) {
      status = exception.status;
      body = { code: exception.code, title: exception.title, detail: exception.detail, errors: exception.errors, meta: exception.meta };
    } else if (exception instanceof ZodError) {
      status = 400;
      body = {
        code: 'VALIDATION_FAILED',
        title: 'Some fields need attention',
        errors: exception.issues.map((i) => ({ field: i.path.join('.'), code: i.code.toUpperCase(), message: i.message })),
      };
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const code = status === 404 ? 'NOT_FOUND' : status === 413 ? 'FILE_TOO_LARGE' : status === 429 ? 'RATE_LIMITED' : status === 401 ? 'UNAUTHENTICATED' : status === 403 ? 'FORBIDDEN' : 'VALIDATION_FAILED';
      body = { code, title: status === 404 ? 'Not found' : exception.message };
    } else {
      body = { code: 'INTERNAL_ERROR', title: 'Something went wrong. Please try again, and tell the administrator if it keeps happening.' };
    }

    if (status >= 500) {
      this.logger.error({ requestId, err: exception, path: req?.url, method: req?.method }, 'unhandled error');
    } else {
      this.logger.warn({ requestId, code: body.code, status, path: req?.url, method: req?.method }, 'request failed');
    }

    res
      .status(status)
      .type('application/problem+json')
      .send({ type: `https://sms.local/errors/${slug(String(body.code))}`, status, requestId, ...body });
  }
}
