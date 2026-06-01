import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { UsersService } from '../../users/users.service';
import { User } from '../../users/entities/user.entity';

/**
 * Payload embedded in the locally-issued JWT access token.
 *
 * Exported so {@link AuthService.issueLocalJwt} (and any future signer)
 * shares the exact same shape that {@link JwtStrategy.validate} consumes.
 */
export interface JwtPayload {
  /**
   * Internal user ID (used as the JWT `sub` claim).
   *
   * Typed as `number | string` because jsonwebtoken may serialize the
   * numeric user ID as either depending on the issuer. The strategy
   * normalizes it to a number via {@link Number} before looking up
   * the user.
   */
  sub: number | string;
  /**
   * AWS Cognito `sub` identifier.
   *
   * Nullable because admin-pre-provisioned users (created via the Users
   * admin page before they ever log in) start with `cognitoSub = null`;
   * the dev-login path can mint a JWT for such a user in development.
   * In production via the Cognito callback this will always be a real
   * Cognito sub.
   */
  cognitoSub: string | null;
  /** User role (may be null if not yet assigned by admin). */
  role: string | null;
  /**
   * Full ordered list of center IDs the user is a member of (multi-center
   * support). Sorted by `user_centers.sort_order ASC` at token-issue time
   * — index 0 is the primary center, matching `users.center_id` (and
   * `req.user.centerId`).
   *
   * Empty array (`[]`) for non-center-rep users (admin, program_rep,
   * workflow_admin, unit_admin, or users with no role yet).
   */
  centerIds: number[];

  /**
   * Full ordered list of program IDs the user is a member of
   * (multi-program support). Sorted by `user_programs.sort_order ASC`
   * at token-issue time — index 0 is the primary program, matching
   * `users.program_id` (and `req.user.programId`).
   *
   * Empty array (`[]`) for non-program-rep users (admin, center_rep,
   * workflow_admin, unit_admin, or users with no role yet).
   */
  programIds: number[];
}

/**
 * The shape attached to `req.user` after a successful JWT validation.
 *
 * Adds `centerIds` and `programIds` claims from the JWT to the loaded
 * {@link User} entity. The active-center interceptor reads `centerIds` to
 * validate `X-Active-Center`, then overlays `centerId`. The active-program
 * interceptor reads `programIds` to validate `X-Active-Program`, then
 * overlays `programId`.
 */
export type AuthenticatedUser = User & {
  centerIds: number[];
  programIds: number[];
};

/**
 * Passport strategy for validating locally-issued JWT access tokens.
 *
 * This strategy extracts the JWT from the `Authorization: Bearer <token>`
 * header, verifies it against the local JWT secret (not Cognito JWKS),
 * and loads the full user entity from the database.
 *
 * The validated user object is attached to `request.user` for downstream
 * handlers and decorators like {@link CurrentUser}. Two center-related
 * fields are exposed:
 *
 *  - `req.user.centerId` — the **primary** center (= `users.center_id`).
 *    The {@link ActiveCenterInterceptor} (task A-5) may overlay this value
 *    with the membership the user picked via the `X-Active-Center`
 *    request header. Downstream services should treat `centerId` as the
 *    "active" center for scoping (mappings, projects, exclusions, etc.).
 *  - `req.user.centerIds` — the full ordered list of memberships
 *    (sort_order ASC), pulled straight from the JWT payload. This array
 *    is **immutable per request** and is the source of truth the
 *    interceptor uses to validate the `X-Active-Center` claim.
 *
 * Staleness window: `centerIds` is sourced from the signed JWT, not from
 * a per-request DB lookup, to avoid an extra round-trip on every request.
 * If an admin reassigns a center_rep's memberships, the change is not
 * visible to the rep until their access token expires (≤15 minutes by
 * default) and they refresh. This is the documented limitation per the
 * multi-center design.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  private readonly logger = new Logger(JwtStrategy.name);

  constructor(
    configService: ConfigService,
    private readonly usersService: UsersService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.getOrThrow<string>('auth.jwtSecret'),
    });
  }

  /**
   * Validate the decoded JWT payload and return the authenticated user
   * augmented with the `centerIds` claim from the token.
   *
   * Called automatically by Passport after the token signature and
   * expiration are verified.
   *
   * Defensive handling: if a token was issued before the multi-center
   * rollout it may lack `centerIds`. In that case we synthesize the array
   * from the user's primary `centerId` (`[centerId]` when present, `[]`
   * otherwise) and log a warning. Tokens minted after task A-4 always
   * include `centerIds`.
   *
   * @param payload - The decoded JWT payload.
   * @returns The authenticated user entity plus the immutable `centerIds`
   *          claim from the token.
   * @throws UnauthorizedException if the user does not exist or is deactivated.
   */
  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    /* Normalize the JWT sub claim to a numeric user ID. */
    const userId = Number(payload.sub);
    if (!Number.isFinite(userId) || userId <= 0) {
      throw new UnauthorizedException('Invalid token subject');
    }

    const user = await this.usersService.findById(userId);

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    if (!user.isActive) {
      throw new UnauthorizedException('User account is deactivated');
    }

    /* Resolve centerIds from the JWT payload. New tokens always carry
     * the claim; older tokens predating multi-center rollout may not, so
     * fall back to the primary `centerId` to avoid breaking active sessions. */
    let centerIds: number[];
    if (Array.isArray(payload.centerIds)) {
      centerIds = payload.centerIds;
    } else {
      const fallback = user.centerId != null ? [user.centerId] : [];
      this.logger.warn(
        `JWT for user ${user.id} missing 'centerIds' claim — ` +
          `falling back to primary center [${fallback.join(',')}]`,
      );
      centerIds = fallback;
    }

    /* Resolve programIds from the JWT payload. New tokens always carry
     * the claim; older tokens predating multi-program rollout may not, so
     * fall back to the primary `programId` to avoid breaking active sessions. */
    let programIds: number[];
    if (Array.isArray(payload.programIds)) {
      programIds = payload.programIds;
    } else {
      const fallback = user.programId != null ? [user.programId] : [];
      this.logger.warn(
        `JWT for user ${user.id} missing 'programIds' claim — ` +
          `falling back to primary program [${fallback.join(',')}]`,
      );
      programIds = fallback;
    }

    /* Attach both membership arrays onto the user object. These are the
     * shapes the controller exposes via /auth/me and the interceptors
     * read to validate X-Active-Center / X-Active-Program headers. */
    (user as unknown as { centerIds: number[] }).centerIds = centerIds;
    (user as unknown as { programIds: number[] }).programIds = programIds;
    return user as AuthenticatedUser;
  }
}
