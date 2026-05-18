import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

/**
 * Global exception filter that catches every unhandled exception and
 * returns a structured JSON error response.
 *
 * Response shape:
 * ```json
 * {
 *   "statusCode": 500,
 *   "message": "Internal server error",
 *   "timestamp": "2026-04-09T12:00:00.000Z",
 *   "path": "/api/some-endpoint"
 * }
 * ```
 *
 * Error details (stack trace, raw message) are logged via the NestJS
 * Logger but never leaked to the API consumer.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  /**
   * Handle the caught exception and write a safe response.
   * @param exception - The thrown error or HttpException.
   * @param host - The arguments host providing access to request/response.
   */
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();

    let statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    /**
     * Optional discriminator forwarded from `HttpException` payload bodies.
     *
     * Some endpoints throw `new ForbiddenException({ code: '...', ... })`
     * to expose a stable machine-readable error code (e.g. the
     * `ACTIVE_CENTER_INVALID` envelope consumed by the frontend
     * graceful-recovery flow). The filter preserves this field on the
     * outgoing response so clients can branch on it without parsing
     * free-text messages.
     */
    let code: string | undefined;

    if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      const exceptionResponse = exception.getResponse();
      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else if (exceptionResponse && typeof exceptionResponse === 'object') {
        const responseObj = exceptionResponse as Record<string, unknown>;
        message = (responseObj.message as string) || exception.message;
        /* Forward a `code` discriminator when the caller supplied one
         * (typed as string only — defensive guard for non-string values). */
        if (typeof responseObj.code === 'string') {
          code = responseObj.code;
        }
      } else {
        message = exception.message;
      }
    }

    /** Log full error details for debugging (never sent to the client). */
    this.logger.error(
      `${request.method} ${request.url} ${statusCode} — ${message}`,
      exception instanceof Error ? exception.stack : String(exception),
    );

    response.status(statusCode).json({
      statusCode,
      ...(code ? { code } : {}),
      message,
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }
}
