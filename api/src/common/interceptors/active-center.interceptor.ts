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
interface ActiveCenterUserSlice {
  /** Primary center ID from `users.center_id` — may be overlaid by this interceptor. */
  centerId: number | null;
  /** Immutable per-request list of memberships from the JWT (sort_order ASC). */
  centerIds: number[];
  /** Role is read for logging only; the interceptor is role-agnostic. */
  role: string | null;
}

/**
 * Distinct error code emitted on every 403 thrown by this interceptor.
 *
 * This is the **stable contract** the frontend graceful-recovery flow
 * (task B-6) detects on the response body to know it should refresh
 * `/auth/me`, reset the active-center signal to the primary, and retry
 * the original request once. Renaming this constant is a breaking
 * change.
 */
export const ACTIVE_CENTER_INVALID_CODE = 'ACTIVE_CENTER_INVALID';

/**
 * Global interceptor that overlays `req.user.centerId` based on the
 * `X-Active-Center` HTTP request header (multi-center center_rep
 * support — task A-5).
 *
 * ## 8-step logic (in `intercept()`):
 *
 * 1. Pull the Express request from the execution context.
 * 2. If `req.user` is absent (public endpoints, unauthenticated paths)
 *    → pass through. There is nothing to overlay.
 * 3. Read the lowercased `x-active-center` header value from
 *    `req.headers` (Node lowercases header names automatically).
 * 4. If the header is absent (`undefined` or empty string) → pass
 *    through unchanged. `req.user.centerId` keeps the primary center
 *    that was baked into the JWT (matches the legacy single-center
 *    behavior — every existing caller still works).
 * 5. Parse the header as a base-10 integer. If the parse yields `NaN`,
 *    a negative number, or zero → throw `ForbiddenException` with the
 *    {@link ACTIVE_CENTER_INVALID_CODE} envelope.
 * 6. If `req.user.centerIds` is empty (non-center-rep roles: admin,
 *    program_rep, workflow_admin, unit_admin, or unassigned users) →
 *    PASS THROUGH SILENTLY. Locked design decision: external tooling
 *    or future API consumers should not be 403'd for sending a header
 *    the server doesn't care about. We log a debug-level note and
 *    proceed without mutating `req.user.centerId`.
 * 7. If the parsed center id is **not** a member of
 *    `req.user.centerIds` → throw `ForbiddenException` with the
 *    {@link ACTIVE_CENTER_INVALID_CODE} envelope. This is the path the
 *    frontend B-6 recovery flow detects.
 * 8. Otherwise → mutate `req.user.centerId` to the parsed value. This
 *    is the **only** runtime mutation of `req.user` performed anywhere
 *    in the pipeline. Downstream services keep using the existing
 *    equality check (`user.centerId === project.centerId`) without any
 *    change.
 *
 * ## Locked design decisions:
 *
 * - **Empty `centerIds` → silent pass-through, not 403.** Roles other
 *   than `center_rep` have no membership list to validate against; the
 *   header is meaningless to them but harmless. Punishing them would
 *   break perfectly valid clients that always send the header.
 * - **Distinct `code: 'ACTIVE_CENTER_INVALID'`** is the contract for
 *   frontend graceful recovery (B-6). The generic NestJS 403 body
 *   lacks this discriminator, so the interceptor must throw an
 *   explicit object payload.
 * - **`req.user.centerId` is the ONE mutation point.** Downstream
 *   services do not need to be aware of multi-center; they keep
 *   reading `user.centerId` as before. The header overlay is fully
 *   transparent below this interceptor.
 *
 * ## Known limitation — ≤15min JWT staleness window:
 *
 * `centerIds` is sourced from the signed JWT, not a per-request DB
 * lookup. If an admin reassigns a rep's centers, the rep's token does
 * not see the change until it expires (~15min) and refreshes. During
 * the staleness window, a stale `X-Active-Center` value will throw 403
 * with the {@link ACTIVE_CENTER_INVALID_CODE} envelope; the frontend
 * B-6 flow refreshes `/auth/me`, resets the active-center signal, and
 * retries the original request once. This is intentional — see the
 * multi-center design doc.
 *
 * ## Registration:
 *
 * Registered as `APP_INTERCEPTOR` in `app.module.ts`. NestJS guards
 * (including `JwtAuthGuard`) always run before interceptors, so
 * `req.user` is fully populated by the time `intercept()` runs.
 */
@Injectable()
export class ActiveCenterInterceptor implements NestInterceptor {
  private readonly logger = new Logger(ActiveCenterInterceptor.name);

  /**
   * Validate `X-Active-Center` and overlay `req.user.centerId` per the
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
      .getRequest<Request & { user?: ActiveCenterUserSlice }>();

    /* Step 2: No authenticated user → pass through. Public routes,
     * health checks, and pre-auth paths all fall here. */
    if (!req.user) {
      return next.handle();
    }

    /* Step 3: Read the (lowercased) header value. */
    const headerValue = req.headers['x-active-center'];
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
        `X-Active-Center rejected (unparseable): "${rawHeader}" for user ` +
          `id=${(req.user as unknown as { id?: number }).id ?? '?'}`,
      );
      throw new ForbiddenException({
        statusCode: 403,
        code: ACTIVE_CENTER_INVALID_CODE,
        message: 'Invalid X-Active-Center header',
      });
    }

    /* Step 6: Empty centerIds → silent pass-through (locked design). */
    const centerIds = Array.isArray(req.user.centerIds)
      ? req.user.centerIds
      : [];
    if (centerIds.length === 0) {
      this.logger.debug(
        `X-Active-Center=${parsed} ignored — user has no center memberships ` +
          `(role=${req.user.role ?? 'null'})`,
      );
      return next.handle();
    }

    /* Step 7: Parsed id not in membership list → 403 with distinct code. */
    if (!centerIds.includes(parsed)) {
      this.logger.debug(
        `X-Active-Center=${parsed} rejected — not in user.centerIds=[${centerIds.join(',')}]`,
      );
      throw new ForbiddenException({
        statusCode: 403,
        code: ACTIVE_CENTER_INVALID_CODE,
        message: `Active center ${parsed} is not in the user's assigned centers`,
      });
    }

    /* Step 8: Apply the overlay. This is the ONLY place req.user.centerId
     * is mutated at runtime; downstream services keep treating centerId
     * as the active center for scoping. */
    this.logger.debug(
      `Overlaying req.user.centerId: ${req.user.centerId ?? 'null'} → ${parsed} ` +
        `(centerIds=[${centerIds.join(',')}])`,
    );
    req.user.centerId = parsed;

    return next.handle();
  }
}
