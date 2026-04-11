import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { UsersService } from '../../users/users.service';
import { User } from '../../users/entities/user.entity';

/**
 * Payload embedded in the locally-issued JWT access token.
 */
interface JwtPayload {
  /**
   * Internal user ID (used as the JWT `sub` claim).
   *
   * Typed as `number | string` because jsonwebtoken may serialize the
   * numeric user ID as either depending on the issuer. The strategy
   * normalizes it to a number via {@link Number} before looking up
   * the user.
   */
  sub: number | string;
  /** AWS Cognito `sub` identifier. */
  cognitoSub: string;
  /** User role (may be null if not yet assigned by admin). */
  role: string | null;
}

/**
 * Passport strategy for validating locally-issued JWT access tokens.
 *
 * This strategy extracts the JWT from the `Authorization: Bearer <token>`
 * header, verifies it against the local JWT secret (not Cognito JWKS),
 * and loads the full user entity from the database.
 *
 * The validated user object is attached to `request.user` for downstream
 * handlers and decorators like {@link CurrentUser}.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
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
   * Validate the decoded JWT payload and return the associated user.
   *
   * Called automatically by Passport after the token signature and
   * expiration are verified.
   *
   * @param payload - The decoded JWT payload.
   * @returns The authenticated {@link User} entity.
   * @throws UnauthorizedException if the user does not exist or is deactivated.
   */
  async validate(payload: JwtPayload): Promise<User> {
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

    return user;
  }
}
