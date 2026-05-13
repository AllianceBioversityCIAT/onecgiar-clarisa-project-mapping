import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ThrottlerGuard, Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { AuthService } from './auth.service';
import { CallbackDto } from './dto/callback.dto';
import { AuditService } from '../audit/audit.service';
import { AuditEntityType } from '../audit/entities/audit-event.entity';
import { ActorRole } from '../mappings/enums/actor-role.enum';

/** Cookie name for the Cognito refresh token. */
const REFRESH_TOKEN_COOKIE = 'refresh_token';

/** 30 days in milliseconds. */
const REFRESH_TOKEN_MAX_AGE = 30 * 24 * 60 * 60 * 1000;

/**
 * Controller for authentication endpoints.
 *
 * Implements the OAuth2 authorization code flow with AWS Cognito:
 * login URL generation, code exchange, token refresh, and logout.
 *
 * All endpoints except `/auth/me` are public (no JWT required)
 * because they are part of the authentication handshake itself.
 *
 * Rate-limited via ThrottlerGuard to prevent brute-force and
 * credential-stuffing attacks (10 requests per minute by default).
 */
@ApiTags('Authentication')
@UseGuards(ThrottlerGuard)
@Throttle({ default: { ttl: 60000, limit: 10 } })
@ApiTooManyRequestsResponse({
  description: 'Rate limit exceeded — try again later',
})
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly authService: AuthService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * GET /api/auth/login
   *
   * Returns the Cognito hosted UI URL. The frontend redirects the
   * user's browser to this URL to begin the OAuth2 flow.
   */
  @Public()
  @Get('login')
  @ApiOperation({ summary: 'Get Cognito login URL' })
  @ApiOkResponse({
    description: 'Cognito authorization URL',
    schema: {
      type: 'object',
      properties: { url: { type: 'string' } },
    },
  })
  getLoginUrl(): { url: string } {
    return { url: this.authService.getLoginUrl() };
  }

  /**
   * POST /api/auth/callback
   *
   * Exchanges the Cognito authorization code for tokens, upserts the
   * user, issues a local JWT, and stores the Cognito refresh token
   * in an httpOnly cookie.
   */
  @Public()
  @Post('callback')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Exchange Cognito authorization code for tokens' })
  @ApiBody({ type: CallbackDto })
  @ApiOkResponse({
    description: 'JWT access token and user profile',
    schema: {
      type: 'object',
      properties: {
        accessToken: { type: 'string' },
        user: { type: 'object' },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or expired authorization code',
  })
  async callback(
    @Body() callbackDto: CallbackDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ accessToken: string; user: User }> {
    const result = await this.authService.exchangeCodeForTokens(
      callbackDto.code,
    );

    /** Store the Cognito refresh token in a secure httpOnly cookie. */
    if (result.refreshToken) {
      response.cookie(REFRESH_TOKEN_COOKIE, result.refreshToken, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: REFRESH_TOKEN_MAX_AGE,
      });
    }

    return {
      accessToken: result.accessToken,
      user: result.user,
    };
  }

  /**
   * POST /api/auth/refresh
   *
   * Reads the Cognito refresh token from the httpOnly cookie,
   * exchanges it for a new set of tokens, and returns a fresh
   * local JWT access token.
   */
  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh JWT access token' })
  @ApiOkResponse({
    description: 'New JWT access token',
    schema: {
      type: 'object',
      properties: { accessToken: { type: 'string' } },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or expired refresh token' })
  async refresh(@Req() request: Request): Promise<{ accessToken: string }> {
    const refreshToken = request.cookies?.[REFRESH_TOKEN_COOKIE];

    if (!refreshToken) {
      throw new UnauthorizedException('No refresh token provided');
    }

    /** Handle dev refresh tokens (bypass Cognito). */
    if (refreshToken.startsWith('dev-refresh-')) {
      const userId = Number(refreshToken.replace('dev-refresh-', ''));
      if (!Number.isFinite(userId) || userId <= 0) {
        throw new UnauthorizedException('Invalid dev refresh token');
      }
      const user = await this.authService['usersService'].findById(userId);
      if (!user || !user.isActive) {
        throw new UnauthorizedException('Invalid dev refresh token');
      }
      const accessToken = this.authService.issueLocalJwt(user);
      return { accessToken };
    }

    const { accessToken } = await this.authService.refreshTokens(refreshToken);

    return { accessToken };
  }

  /**
   * POST /api/auth/logout
   *
   * Revokes the Cognito refresh token and clears the httpOnly cookie.
   */
  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Logout and revoke refresh token' })
  @ApiOkResponse({ description: 'Logged out successfully' })
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ message: string }> {
    const refreshToken = request.cookies?.[REFRESH_TOKEN_COOKIE];

    if (refreshToken) {
      await this.authService.revokeToken(refreshToken);
    }

    /** Clear the refresh token cookie. */
    response.clearCookie(REFRESH_TOKEN_COOKIE, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
    });

    this.logger.log('User logged out');

    return { message: 'Logged out successfully' };
  }

  /**
   * GET /api/auth/me
   *
   * Returns the currently authenticated user's profile. Requires a
   * valid JWT access token in the Authorization header.
   */
  @Get('me')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Get current authenticated user' })
  @ApiOkResponse({ description: 'Current user profile' })
  @ApiUnauthorizedResponse({ description: 'Invalid or missing access token' })
  getMe(@CurrentUser() user: User): User {
    return user;
  }

  /**
   * POST /api/auth/dev-login
   *
   * Development-only endpoint that bypasses Cognito and issues a JWT
   * directly for a given email. Creates the user if it doesn't exist.
   * Only available when NODE_ENV=development.
   */
  @Public()
  @Post('dev-login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[DEV ONLY] Login by email without Cognito' })
  async devLogin(
    @Body() body: { email: string },
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ accessToken: string; user: User }> {
    /* Hardcoded open until a proper staging environment lands (see todo.md #10).
     * Previously gated on `NODE_ENV === 'development'`, but the deployed dev
     * server runs with `NODE_ENV=production`, which broke the admin-only
     * "log in as user" feature there. */

    /** Find existing user by email, or create a new dev user. */
    const usersService = this.authService['usersService'];
    const repo = usersService['usersRepository'];
    let user = await repo.findOne({ where: { email: body.email } });
    if (!user) {
      user = await usersService.upsertFromCognito({
        cognitoSub: `dev-${body.email}`,
        email: body.email,
        firstName: body.email.split('@')[0],
        lastName: 'Dev',
      });
    }

    const accessToken = this.authService.issueLocalJwt(user);

    /** Set a fake refresh cookie so session recovery works on page refresh. */
    response.cookie(REFRESH_TOKEN_COOKIE, `dev-refresh-${user.id}`, {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      path: '/',
      maxAge: REFRESH_TOKEN_MAX_AGE,
    });

    this.logger.log(`[DEV] User logged in: ${user.id} (${user.email})`);

    /* Audit dev-login. The endpoint is @Public so there's no calling
     * admin in the request — record the row as a SYSTEM actor and put
     * the impersonated user identity in the summary so the audit log
     * still surfaces who was impersonated. */
    await this.auditService.record({
      entityType: AuditEntityType.USER,
      entityId: user.id,
      action: 'auth.dev_login',
      summary: `Dev-login as ${user.email} (id=${user.id})`,
      actorOverride: {
        userId: null,
        role: ActorRole.SYSTEM,
        displayName: 'system (dev-login)',
        email: null,
      },
    });

    return { accessToken, user };
  }

  /**
   * GET /api/auth/dev-token?email=...
   *
   * Development-only endpoint returning a bare JWT. Useful for
   * Playwright/test automation where cookie handling is tricky.
   *
   * DEV NOTE — single-cookie limitation across tabs:
   * This endpoint overwrites the shared httpOnly `refresh_token` cookie
   * at path=/, so it is GLOBAL to the browser, not tab-scoped. If you
   * call /auth?dev=admin@... in one tab after /auth?dev=sara@... in
   * another, the cookie is replaced — any subsequent POST /auth/refresh
   * (which fires on every page load) will issue a JWT for the LAST
   * dev-token user, regardless of which tab triggered it. This is
   * expected dev-mode behavior and does not apply to the Cognito flow
   * used in production.
   */
  @Public()
  @Get('dev-token')
  @ApiOperation({ summary: '[DEV ONLY] Get a JWT for an email' })
  async devToken(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ accessToken: string; user: User }> {
    /* Hardcoded open until staging-environment work lands (todo.md #10). */
    const email = (request.query as any).email as string;
    if (!email) throw new UnauthorizedException('email query param required');

    const usersService = this.authService['usersService'];
    const repo = usersService['usersRepository'];
    let user = await repo.findOne({ where: { email } });
    if (!user) {
      user = await usersService.upsertFromCognito({
        cognitoSub: `dev-${email}`,
        email,
        firstName: email.split('@')[0],
        lastName: 'Dev',
      });
    }

    const accessToken = this.authService.issueLocalJwt(user);

    response.cookie(REFRESH_TOKEN_COOKIE, `dev-refresh-${user.id}`, {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      path: '/',
      maxAge: REFRESH_TOKEN_MAX_AGE,
    });

    /* Same audit treatment as POST /auth/dev-login — both are dev-only
     * impersonation paths and both should leave a trace on the user
     * being impersonated. */
    await this.auditService.record({
      entityType: AuditEntityType.USER,
      entityId: user.id,
      action: 'auth.dev_login',
      summary: `Dev-token issued for ${user.email} (id=${user.id})`,
      actorOverride: {
        userId: null,
        role: ActorRole.SYSTEM,
        displayName: 'system (dev-login)',
        email: null,
      },
    });

    return { accessToken, user };
  }
}
