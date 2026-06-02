import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { Request } from 'express';

/**
 * Minimal shape the interceptor needs from `req.user`. Decoupled from
 * the full `AuthenticatedUser` type (defined in
 * `api/src/modules/auth/strategies/jwt.strategy.ts`) to avoid a circular
 * import between `common/` and `modules/auth/`. The fields below mirror
 * what {@link JwtStrategy.validate} attaches.
 */
interface ActiveProgramUserSlice {
  /** Primary program ID from `users.program_id` — may be overlaid by this interceptor. */
  programId: number | null;
  /** Immutable per-request list of memberships from the JWT (sort_order ASC). */
  programIds: number[];
  /** Role is read for logging only; the interceptor is role-agnostic. */
  role: string | null;
}

/**
 * Distinct error code emitted on every 403 thrown by this interceptor.
 *
 * This is the **stable contract** the frontend graceful-recovery flow
 * detects on the response body to know it should refresh `/auth/me`,
 * reset the active-program signal to the primary, and retry the original
 * request once. Renaming this constant is a breaking change.
 */
export const ACTIVE_PROGRAM_INVALID_CODE = 'ACTIVE_PROGRAM_INVALID';

/**
 * Global interceptor that overlays `req.user.programId` based on the
 * `X-Active-Program` HTTP request header (multi-program program_rep
 * support — mirrors ActiveCenterInterceptor).
 *
 * ## 8-step logic (in `intercept()`):
 *
 * 1. Pull the Express request from the execution context.
 * 2. If `req.user` is absent (public endpoints, unauthenticated paths)
 *    → pass through. There is nothing to overlay.
 * 3. Read the lowercased `x-active-program` header value from
 *    `req.headers` (Node lowercases header names automatically).
 * 4. If the header is absent (`undefined` or empty string) → pass
 *    through unchanged. `req.user.programId` keeps the primary program
 *    that was baked into the JWT (matches the legacy single-program
 *    behavior — every existing caller still works).
 * 5. Parse the header as a base-10 integer. If the parse yields `NaN`,
 *    a negative number, or zero → throw `ForbiddenException` with the
 *    {@link ACTIVE_PROGRAM_INVALID_CODE} envelope.
 * 6. If `req.user.programIds` is empty (non-program-rep roles: admin,
 *    center_rep, workflow_admin, unit_admin, or unassigned users) →
 *    PASS THROUGH SILENTLY. Locked design decision: external tooling or
 *    future API consumers should not be 403'd for sending a header the
 *    server doesn't care about. We log a debug-level note and proceed
 *    without mutating `req.user.programId`.
 * 7. If the parsed program id is **not** a member of
 *    `req.user.programIds` → throw `ForbiddenException` with the
 *    {@link ACTIVE_PROGRAM_INVALID_CODE} envelope. This is the path the
 *    frontend recovery flow detects.
 * 8. Otherwise → mutate `req.user.programId` to the parsed value. This
 *    is the only runtime mutation of `req.user.programId` performed
 *    anywhere in the pipeline. Downstream services keep using the
 *    existing equality check (`user.programId === mapping.programId`)
 *    without any change.
 *
 * ## Locked design decisions:
 *
 * - **Empty `programIds` → silent pass-through, not 403.** Roles other
 *   than `program_rep` have no membership list to validate against; the
 *   header is meaningless to them but harmless.
 * - **Distinct `code: 'ACTIVE_PROGRAM_INVALID'`** is the contract for
 *   frontend graceful recovery. The generic NestJS 403 body lacks this
 *   discriminator, so the interceptor must throw an explicit object payload.
 * - **`req.user.programId` is the ONE mutation point.** Downstream
 *   services do not need to be aware of multi-program; they keep
 *   reading `user.programId` as before. The header overlay is fully
 *   transparent below this interceptor.
 *
 * ## Known limitation — ≤15min JWT staleness window:
 *
 * `programIds` is sourced from the signed JWT, not a per-request DB
 * lookup. If an admin reassigns a rep's programs, the rep's token does
 * not see the change until it expires (~15min) and refreshes. During
 * the staleness window, a stale `X-Active-Program` value will throw 403
 * with the {@link ACTIVE_PROGRAM_INVALID_CODE} envelope; the frontend
 * recovery flow refreshes `/auth/me`, resets the active-program signal,
 * and retries the original request once. This is intentional — see the
 * multi-program design.
 *
 * ## Registration:
 *
 * Registered as `APP_INTERCEPTOR` in `app.module.ts` after
 * `ActiveCenterInterceptor`. NestJS guards (including `JwtAuthGuard`)
 * always run before interceptors, so `req.user` is fully populated by
 * the time `intercept()` runs.
 */
@Injectable()
export class ActiveProgramInterceptor implements NestInterceptor {
  private readonly logger = new Logger(ActiveProgramInterceptor.name);

  /**
   * Validate `X-Active-Program` and overlay `req.user.programId` per the
   * 8-step logic documented on the class above.
   *
   * Validation is fully synchronous (no DB lookup) — `ForbiddenException`
   * is thrown directly from `intercept()` before the observable is
   * returned, so the standard Nest exception-handling pipeline catches
   * it and routes to {@link AllExceptionsFilter}.
   *
   * @param context - The Nest execution context (HTTP route).
   * @param next - The handler chain continuation.
   * @returns The downstream observable (unchanged on every non-error path).
   */
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    /* Step 1: Pull the Express request. */
    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: ActiveProgramUserSlice }>();

    /* Step 2: No authenticated user → pass through. Public routes,
     * health checks, and pre-auth paths all fall here. */
    if (!req.user) {
      return next.handle();
    }

    /* Step 3: Read the (lowercased) header value. */
    const headerValue = req.headers['x-active-program'];
    const rawHeader = Array.isArray(headerValue) ? headerValue[0] : headerValue;

    /* Step 4: Header absent (undefined / empty string) → pass through. */
    if (rawHeader === undefined || rawHeader === '') {
      return next.handle();
    }

    /* Step 5: Parse as int. Reject non-numeric, NaN, <= 0. */
    const parsed = Number.parseInt(rawHeader, 10);
    if (
      !Number.isFinite(parsed) ||
      parsed <= 0 ||
      String(parsed) !== rawHeader.trim()
    ) {
      this.logger.debug(
        `X-Active-Program rejected (unparseable): "${rawHeader}" for user ` +
          `id=${(req.user as unknown as { id?: number }).id ?? '?'}`,
      );
      throw new ForbiddenException({
        statusCode: 403,
        code: ACTIVE_PROGRAM_INVALID_CODE,
        message: 'Invalid X-Active-Program header',
      });
    }

    /* Step 6: Empty programIds → silent pass-through (locked design). */
    const programIds = Array.isArray(req.user.programIds)
      ? req.user.programIds
      : [];
    if (programIds.length === 0) {
      this.logger.debug(
        `X-Active-Program=${parsed} ignored — user has no program memberships ` +
          `(role=${req.user.role ?? 'null'})`,
      );
      return next.handle();
    }

    /* Step 7: Parsed id not in membership list → 403 with distinct code. */
    if (!programIds.includes(parsed)) {
      this.logger.debug(
        `X-Active-Program=${parsed} rejected — not in user.programIds=[${programIds.join(',')}]`,
      );
      throw new ForbiddenException({
        statusCode: 403,
        code: ACTIVE_PROGRAM_INVALID_CODE,
        message: `Active program ${parsed} is not in the user's assigned programs`,
      });
    }

    /* Step 8: Apply the overlay. This is the ONLY place req.user.programId
     * is mutated at runtime; downstream services keep treating programId
     * as the active program for scoping. */
    this.logger.debug(
      `Overlaying req.user.programId: ${req.user.programId ?? 'null'} → ${parsed} ` +
        `(programIds=[${programIds.join(',')}])`,
    );
    req.user.programId = parsed;

    return next.handle();
  }
}
