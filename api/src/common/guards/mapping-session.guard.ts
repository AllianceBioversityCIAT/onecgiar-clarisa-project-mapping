import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { SettingsService } from '../../modules/settings/settings.service';
import {
  MAPPING_SESSION_CLOSED_CODE,
  MAPPING_SESSION_CLOSED_MESSAGE,
} from '../constants/mapping-session.constants';
import { MAPPING_SESSION_EXEMPT_KEY } from '../decorators/mapping-session-exempt.decorator';

/**
 * HTTP verbs that never change state. Everything else on a guarded
 * controller is treated as a mutation and blocked once the session closes.
 */
const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Freezes the mapping/negotiation surface once an admin has concluded the
 * annual mapping session (`system_settings.mapping_session_closed`).
 *
 * Applied at the controller level (`@UseGuards(MappingSessionGuard)`) rather
 * than per-endpoint so a newly added mutation is covered by default — the
 * method check is the opt-out, not an allow-list someone has to remember to
 * extend. The single deliberate hole is `@MappingSessionExempt()`, which
 * TOC contribution carries (see that decorator's docs).
 *
 * Deliberately role-blind: center reps, program reps AND the workflow admin
 * are all stopped. "Concluded" means the round is over for every negotiating
 * party; the admin re-opens the session from the Settings page if something
 * still needs fixing. Reads stay open so everyone can still consult the
 * agreed portfolio.
 *
 * Runs after `JwtAuthGuard`/`RolesGuard` (controller guards execute after the
 * global ones), so an unauthenticated or wrongly-roled caller still gets the
 * usual 401/403 instead of this notice.
 */
@Injectable()
export class MappingSessionGuard implements CanActivate {
  private readonly logger = new Logger(MappingSessionGuard.name);

  constructor(
    private readonly settingsService: SettingsService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

    if (READ_ONLY_METHODS.has(request.method)) return true;

    // Explicitly exempted route (TOC contribution) — writable year-round.
    const exempt = this.reflector.getAllAndOverride<boolean>(
      MAPPING_SESSION_EXEMPT_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (exempt) return true;

    const closed = await this.settingsService.isMappingSessionClosed();
    if (!closed) return true;

    this.logger.warn(
      `Blocked ${request.method} ${request.originalUrl} — mapping session is closed`,
    );

    // Object payload so the front end can branch on `code` while still
    // showing `message` verbatim to the user.
    throw new ForbiddenException({
      statusCode: HttpStatus.FORBIDDEN,
      code: MAPPING_SESSION_CLOSED_CODE,
      message: MAPPING_SESSION_CLOSED_MESSAGE,
    });
  }
}
