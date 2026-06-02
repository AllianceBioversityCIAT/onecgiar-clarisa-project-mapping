import {
  Injectable,
  Logger,
  UnauthorizedException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import * as jwksRsa from 'jwks-rsa';
import * as jsonwebtoken from 'jsonwebtoken';
import { UsersService } from '../users/users.service';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/enums/user-role.enum';
import { JwtPayload } from './strategies/jwt.strategy';

/**
 * Decoded claims from a Cognito ID token.
 */
interface CognitoIdTokenClaims {
  sub: string;
  email: string;
  given_name?: string;
  family_name?: string;
  name?: string;
}

/**
 * Response shape from the Cognito `/oauth2/token` endpoint.
 */
interface CognitoTokenResponse {
  access_token: string;
  id_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
}

/**
 * Result of a successful code exchange or token refresh.
 */
export interface AuthTokenResult {
  /** Locally-issued JWT access token for API authentication. */
  accessToken: string;
  /** The authenticated user entity. */
  user: User;
  /** Cognito refresh token (only present on initial code exchange). */
  refreshToken?: string;
}

/**
 * Service handling all authentication flows with AWS Cognito.
 *
 * Cognito is used strictly for **authentication** (login / token issuance).
 * Role management is handled internally by administrators. This service:
 *
 * 1. Constructs the Cognito login URL for the OAuth2 authorization code flow.
 * 2. Exchanges authorization codes for tokens and upserts the user locally.
 * 3. Issues locally-signed JWT access tokens containing user ID and role.
 * 4. Handles token refresh and revocation via the Cognito token endpoints.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  private readonly cognitoApi: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;
  /** Lazily initialized once we know the issuer from the first token. */
  private jwksClient: jwksRsa.JwksClient | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
    private readonly httpService: HttpService,
    private readonly usersService: UsersService,
  ) {
    this.cognitoApi = this.configService.getOrThrow<string>('auth.cognitoApi');
    this.clientId = this.configService.getOrThrow<string>(
      'auth.cognitoClientId',
    );
    this.clientSecret = this.configService.getOrThrow<string>(
      'auth.cognitoClientSecret',
    );
    this.redirectUri = this.configService.getOrThrow<string>(
      'auth.cognitoRedirectUri',
    );
  }

  /**
   * Get or create the JWKS client. The JWKS URI is derived from the
   * Cognito issuer (`iss` claim in ID tokens), NOT the hosted UI domain.
   * Format: https://cognito-idp.{region}.amazonaws.com/{userPoolId}
   */
  private getJwksClient(issuer: string): jwksRsa.JwksClient {
    if (!this.jwksClient) {
      this.jwksClient = new jwksRsa.JwksClient({
        jwksUri: `${issuer}/.well-known/jwks.json`,
        cache: true,
        cacheMaxAge: 600000, // 10 minutes
        rateLimit: true,
      });
      this.logger.log(`JWKS client initialized with issuer: ${issuer}`);
    }
    return this.jwksClient;
  }

  /**
   * Build the Cognito hosted UI authorization URL.
   *
   * The frontend redirects the user to this URL to initiate the
   * OAuth2 authorization code flow.
   *
   * @returns The fully-qualified Cognito authorization URL.
   */
  getLoginUrl(): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      response_type: 'code',
      scope: 'openid email profile',
      redirect_uri: this.redirectUri,
    });

    return `${this.cognitoApi}/oauth2/authorize?${params.toString()}`;
  }

  /**
   * Exchange a Cognito authorization code for tokens, upsert the user,
   * and issue a local JWT access token.
   *
   * @param code - The authorization code from the Cognito redirect.
   * @returns The local JWT, the user entity, and the Cognito refresh token.
   * @throws UnauthorizedException if the code is invalid or the ID token fails verification.
   */
  async exchangeCodeForTokens(code: string): Promise<AuthTokenResult> {
    const cognitoTokens = await this.fetchCognitoTokens('authorization_code', {
      code,
    });

    const claims = await this.verifyAndDecodeCognitoIdToken(
      cognitoTokens.id_token,
    );

    const user = await this.usersService.upsertFromCognito({
      cognitoSub: claims.sub,
      email: claims.email,
      firstName: claims.given_name || claims.name || '',
      lastName: claims.family_name || '',
    });

    const accessToken = await this.issueLocalJwt(user);

    this.logger.log(`User logged in: ${user.id} (${user.email})`);

    return {
      accessToken,
      user,
      refreshToken: cognitoTokens.refresh_token,
    };
  }

  /**
   * Refresh authentication using a Cognito refresh token.
   *
   * Calls the Cognito token endpoint with `grant_type=refresh_token`,
   * verifies the new ID token, looks up the user, and issues a fresh
   * local JWT.
   *
   * @param refreshToken - The Cognito refresh token (from httpOnly cookie).
   * @returns A new local JWT access token and the user entity.
   * @throws UnauthorizedException if the refresh token is expired or revoked.
   */
  async refreshTokens(
    refreshToken: string,
  ): Promise<{ accessToken: string; user: User }> {
    const cognitoTokens = await this.fetchCognitoTokens('refresh_token', {
      refresh_token: refreshToken,
    });

    const claims = await this.verifyAndDecodeCognitoIdToken(
      cognitoTokens.id_token,
    );

    const user = await this.usersService.findByCognitoSub(claims.sub);

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    if (!user.isActive) {
      throw new UnauthorizedException('User account is deactivated');
    }

    const accessToken = await this.issueLocalJwt(user);

    this.logger.log(`Token refreshed for user: ${user.id}`);

    return { accessToken, user };
  }

  /**
   * Revoke a Cognito refresh token.
   *
   * Posts to the Cognito `/oauth2/revoke` endpoint to invalidate the
   * refresh token, preventing further use.
   *
   * @param refreshToken - The Cognito refresh token to revoke.
   */
  async revokeToken(refreshToken: string): Promise<void> {
    try {
      const params = new URLSearchParams({
        token: refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret,
      });

      await firstValueFrom(
        this.httpService.post(
          `${this.cognitoApi}/oauth2/revoke`,
          params.toString(),
          {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
          },
        ),
      );

      this.logger.log('Cognito refresh token revoked');
    } catch (error) {
      /* Best-effort revocation — log but do not fail the logout flow. */
      this.logger.warn(
        `Failed to revoke Cognito token: ${error.message || error}`,
      );
    }
  }

  /**
   * POST to the Cognito `/oauth2/token` endpoint.
   *
   * @param grantType    - Either 'authorization_code' or 'refresh_token'.
   * @param extraParams  - Additional form parameters specific to the grant type.
   * @returns The parsed Cognito token response.
   * @throws UnauthorizedException on 4xx responses from Cognito.
   * @throws InternalServerErrorException on unexpected errors.
   */
  private async fetchCognitoTokens(
    grantType: string,
    extraParams: Record<string, string>,
  ): Promise<CognitoTokenResponse> {
    try {
      const params = new URLSearchParams({
        grant_type: grantType,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: this.redirectUri,
        ...extraParams,
      });

      const response = await firstValueFrom(
        this.httpService.post<CognitoTokenResponse>(
          `${this.cognitoApi}/oauth2/token`,
          params.toString(),
          {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
          },
        ),
      );

      return response.data;
    } catch (error) {
      const status = error.response?.status;
      const message = error.response?.data?.error || error.message;

      this.logger.error(
        `Cognito token exchange failed (${grantType}): ${message}`,
      );

      if (status && status >= 400 && status < 500) {
        throw new UnauthorizedException(
          'Authentication failed — invalid or expired code',
        );
      }

      throw new InternalServerErrorException(
        'Authentication service unavailable',
      );
    }
  }

  /**
   * Verify a Cognito-issued ID token using the JWKS endpoint and
   * return the decoded claims.
   *
   * @param idToken - The raw JWT ID token string from Cognito.
   * @returns Decoded ID token claims (sub, email, name fields).
   * @throws UnauthorizedException if the token is invalid or verification fails.
   */
  private async verifyAndDecodeCognitoIdToken(
    idToken: string,
  ): Promise<CognitoIdTokenClaims> {
    try {
      const decoded = jsonwebtoken.decode(idToken, {
        complete: true,
      });

      if (!decoded || !decoded.header.kid) {
        throw new UnauthorizedException('Invalid ID token format');
      }

      /**
       * Extract the issuer from the token payload to build the JWKS URI.
       * Cognito ID tokens have `iss` = https://cognito-idp.{region}.amazonaws.com/{poolId}
       * The JWKS lives at {iss}/.well-known/jwks.json
       */
      const payload = decoded.payload as Record<string, unknown>;
      const issuer = payload.iss as string;

      if (!issuer || !issuer.includes('cognito-idp')) {
        throw new UnauthorizedException(
          'ID token issuer is not a valid Cognito user pool',
        );
      }

      const jwksClient = this.getJwksClient(issuer);
      const signingKey = await jwksClient.getSigningKey(decoded.header.kid);
      const publicKey = signingKey.getPublicKey();

      const verified = jsonwebtoken.verify(idToken, publicKey, {
        algorithms: ['RS256'],
        issuer,
      }) as CognitoIdTokenClaims;

      return verified;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }

      this.logger.error(`ID token verification failed: ${error.message}`);
      throw new UnauthorizedException('Invalid or expired ID token');
    }
  }

  /**
   * Issue a locally-signed JWT access token for API authentication.
   *
   * The token contains the user's internal ID (as `sub`), Cognito sub,
   * role, and the ordered `centerIds` array (multi-center, task A-4 of
   * the multi-center plan). It expires after 15 minutes.
   *
   * `centerIds` resolution:
   *  - Only meaningful for `center_rep` users. For every other role
   *    (admin / program_rep / workflow_admin / unit_admin / null) we
   *    deliberately emit `[]` — even if the row happens to have a legacy
   *    `center_id` value — so the active-center interceptor (A-5) can
   *    treat a non-empty array as the sole authorization signal.
   *  - For center reps we re-read the user via
   *    {@link UsersService.findById}, which loads memberships from the
   *    `user_centers` junction sorted by `sort_order ASC`. Index 0 is
   *    the primary (matches `users.center_id`).
   *  - Defensive fallback: if a center_rep has `users.center_id` set but
   *    the junction returns an empty list (should not happen post
   *    migration A-1 but is possible after manual DB edits), we synthesize
   *    `[centerId]` so the rep is not locked out, and log a warning. We
   *    never throw here — the auth path stays resilient.
   *
   * @param user - The authenticated user entity. The relation may be
   *               lazy/unloaded; this method does its own ordered lookup.
   * @returns A signed JWT string.
   */
  /** Expose for dev-login bypass. */
  async issueLocalJwt(user: User): Promise<string> {
    const [centerIds, programIds] = await Promise.all([
      this.resolveCenterIdsForToken(user),
      this.resolveProgramIdsForToken(user),
    ]);

    const payload: JwtPayload = {
      sub: user.id,
      cognitoSub: user.cognitoSub,
      role: user.role,
      centerIds,
      programIds,
    };

    return this.jwtService.sign(payload);
  }

  /**
   * Compute the `centerIds` claim to embed in a freshly-issued JWT.
   *
   * See {@link issueLocalJwt} for the full set of rules; in short:
   *  - Non-center-rep ⇒ `[]` (defensive — ignore any legacy `centerId`).
   *  - Center rep     ⇒ ordered memberships from `user_centers`, with
   *                     a fallback to `[user.centerId]` if the junction
   *                     is unexpectedly empty.
   */
  private async resolveCenterIdsForToken(user: User): Promise<number[]> {
    /* Only center reps get a non-empty list. */
    if (user.role !== UserRole.CENTER_REP) {
      return [];
    }

    /* findById returns UserWithMemberships with centerIds already ordered
     * by user_centers.sort_order ASC. */
    const withCenters = await this.usersService.findById(user.id);
    const ordered = withCenters?.centerIds ?? [];

    if (ordered.length === 0 && user.centerId != null) {
      /* Defensive: a center_rep row exists but no membership rows.
       * Should not happen post migration, but if the DB was hand-edited
       * we still want the rep to log in against their primary center. */
      this.logger.warn(
        `Center rep ${user.id} (${user.email}) has center_id=` +
          `${user.centerId} but zero user_centers rows — issuing token ` +
          `with [${user.centerId}] as a defensive fallback.`,
      );
      return [user.centerId];
    }

    return ordered;
  }

  /**
   * Compute the `programIds` claim to embed in a freshly-issued JWT.
   *
   *  - Non-program-rep ⇒ `[]` (defensive — ignore any legacy `programId`).
   *  - Program rep     ⇒ ordered memberships from `user_programs`, with
   *                      a fallback to `[user.programId]` if the junction
   *                      is unexpectedly empty.
   */
  private async resolveProgramIdsForToken(user: User): Promise<number[]> {
    /* Only program reps get a non-empty list. */
    if (user.role !== UserRole.PROGRAM_REP) {
      return [];
    }

    /* findById returns UserWithMemberships with programIds already ordered
     * by user_programs.sort_order ASC. */
    const withPrograms = await this.usersService.findById(user.id);
    const ordered = withPrograms?.programIds ?? [];

    if (ordered.length === 0 && user.programId != null) {
      /* Defensive: a program_rep row exists but no membership rows.
       * Should not happen post migration, but if the DB was hand-edited
       * we still want the rep to log in against their primary program. */
      this.logger.warn(
        `Program rep ${user.id} (${user.email}) has program_id=` +
          `${user.programId} but zero user_programs rows — issuing token ` +
          `with [${user.programId}] as a defensive fallback.`,
      );
      return [user.programId];
    }

    return ordered;
  }
}
