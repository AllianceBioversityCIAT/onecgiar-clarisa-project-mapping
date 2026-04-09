import { Controller, Get } from '@nestjs/common';
import { Public } from '../decorators/public.decorator';

/**
 * Simple health-check controller.
 *
 * Returns a JSON payload confirming the API is alive. This endpoint
 * requires no authentication and is intended for load-balancer probes,
 * container orchestrators, and uptime monitors.
 */
@Controller('health')
export class HealthController {
  /**
   * GET /api/health
   * @returns An object with status 'ok' and the current server timestamp.
   */
  @Public()
  @Get()
  check(): { status: string; timestamp: string } {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }
}
