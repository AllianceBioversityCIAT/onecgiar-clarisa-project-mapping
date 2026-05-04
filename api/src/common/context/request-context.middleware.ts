import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { RequestContextService } from './request-context.service';

/**
 * Express-style middleware that establishes the AsyncLocalStorage scope
 * for every incoming HTTP request.
 *
 * This must run BEFORE any guard, interceptor, or controller. It wraps
 * the entire downstream call chain (`next()`) inside
 * `RequestContextService.run({...})` so that subsequent calls to
 * `setRequestId()` and `setUserId()` actually write into a live store.
 *
 * Without this middleware the AsyncLocalStorage has no active context,
 * `getStore()` returns `undefined`, and every `set*()` call is a silent
 * no-op — which is exactly the regression that caused HTTP-driven audit
 * writes to skip with `audit.record called without request context`.
 *
 * The request ID is also seeded here (instead of inside the existing
 * `RequestIdInterceptor`) so the ID is available to early lifecycle
 * stages (guards, exception filters running on auth failures) — the
 * interceptor still sets the response header for backwards compatibility.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(private readonly contextService: RequestContextService) {}

  /**
   * Wrap the downstream pipeline in a fresh AsyncLocalStorage scope.
   *
   * @param req - Inbound Express request.
   * @param res - Outbound Express response.
   * @param next - Continuation that triggers Nest's guard/controller chain.
   */
  use(req: Request, res: Response, next: NextFunction): void {
    /*
     * Honour any caller-supplied X-Request-ID for distributed tracing
     * (matches the legacy behaviour of RequestIdInterceptor). If absent
     * we mint a fresh v4 UUID. The interceptor will overwrite this with
     * the same value later in the lifecycle — we just need *something*
     * present from the very first instruction so guards and filters
     * can log against a stable ID.
     */
    const requestId =
      (req.headers['x-request-id'] as string | undefined) || uuidv4();

    /*
     * Run the rest of the request inside a fresh storage scope. userId
     * stays undefined here — JwtAuthGuard will populate it after
     * Passport validates the token.
     */
    this.contextService.run({ requestId }, () => {
      next();
    });
  }
}
