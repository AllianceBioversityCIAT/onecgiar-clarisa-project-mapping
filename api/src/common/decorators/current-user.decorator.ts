import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * Shape of `request.user` after a successful JWT validation.
 *
 * Re-declared here (rather than imported from the auth module) so this
 * decorator stays in `common/` without depending on a feature module —
 * keeps the dependency graph one-directional. The canonical type is
 * `AuthenticatedUser` in `modules/auth/strategies/jwt.strategy.ts`; the
 * two are structurally identical.
 *
 * Fields populated by the JWT strategy:
 *  - All columns of the `User` entity (id, email, role, centerId, ...).
 *    `centerId` is the user's PRIMARY center (= `users.center_id`); it
 *    may be overlaid by the {@link ActiveCenterInterceptor} (task A-5)
 *    when the caller passes a valid `X-Active-Center` header.
 *  - `centerIds: number[]` — full ordered list of memberships
 *    (sort_order ASC) from the signed JWT. Empty for non-center-rep
 *    users. Source of truth for validating the active-center claim.
 *
 * Consumers should import the full type from `auth/strategies/jwt.strategy`
 * when they need stricter typing (e.g. `import type { AuthenticatedUser }
 * from '...jwt.strategy'`). This minimal type is provided so the
 * decorator's generic default is still useful.
 */
export interface AuthenticatedUserPayload {
  id: number;
  email: string;
  role: string | null;
  centerId: number | null;
  centerIds: number[];
  /* Plus the rest of the User entity. */
  [key: string]: unknown;
}

/**
 * Custom parameter decorator that extracts the authenticated user
 * from the current HTTP request.
 *
 * The user object is expected to be attached to `request.user` by
 * an authentication guard (e.g., a JWT/Cognito guard). After task A-4
 * (multi-center support), `request.user` always carries a `centerIds`
 * array alongside the legacy primary `centerId`.
 *
 * @example
 * ```ts
 * @Get('profile')
 * getProfile(@CurrentUser() user: User & { centerIds: number[] }) {
 *   return user;
 * }
 * ```
 */
export const CurrentUser = createParamDecorator(
  (data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);
