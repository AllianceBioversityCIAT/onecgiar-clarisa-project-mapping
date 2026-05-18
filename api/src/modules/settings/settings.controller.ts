import { Body, Controller, Get, Patch } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { SettingsService } from './settings.service';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { SystemSettings } from './entities/system-settings.entity';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { User } from '../users/entities/user.entity';

/**
 * Shape returned by the GET and PATCH endpoints. We intentionally omit
 * the singleton `id` (always `1`, no caller cares) and surface the
 * fields the admin Settings page consumes.
 */
interface SettingsResponse {
  emailEnabled: boolean;
  deadlineEnabled: boolean;
  deadlineDate: string | null;
  updatedAt: Date;
  updatedBy: number | null;
}

/**
 * Maps the singleton entity to the public response shape. Centralised
 * here so GET and PATCH return exactly the same fields without each
 * controller method assembling the object inline.
 */
function toResponse(entity: SystemSettings): SettingsResponse {
  return {
    emailEnabled: entity.emailEnabled,
    deadlineEnabled: entity.deadlineEnabled,
    deadlineDate: entity.deadlineDate,
    updatedAt: entity.updatedAt,
    updatedBy: entity.updatedById,
  };
}

/**
 * REST controller for the application-wide settings managed by the
 * admin Settings page.
 *
 * - `GET  /settings` — any authenticated user (no `@Roles`, so the
 *   global `RolesGuard` allows every JWT-authenticated caller through,
 *   including users with `role = null`).
 * - `PATCH /settings` — admin only.
 *
 * Both endpoints inherit the global `JwtAuthGuard` from `AppModule`,
 * so no `@UseGuards(JwtAuthGuard)` is needed here.
 */
@ApiTags('settings')
@ApiBearerAuth('access-token')
@Controller('settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  /**
   * Returns the current application settings. Available to every
   * authenticated user so the front-end can read the deadline /
   * email toggle regardless of role.
   */
  @Get()
  @ApiOperation({ summary: 'Get current application settings' })
  @ApiResponse({ status: 200, description: 'Current settings' })
  async getSettings(): Promise<SettingsResponse> {
    const entity = await this.settingsService.getSettings();
    return toResponse(entity);
  }

  /**
   * Updates the application settings. Restricted to admin users.
   *
   * The actor's user ID is captured on the row as `updated_by` so we
   * have a minimal audit trail of who last toggled the flags.
   */
  @Patch()
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Update application settings (admin only)' })
  @ApiResponse({ status: 200, description: 'Settings updated successfully' })
  @ApiResponse({
    status: 400,
    description:
      'Validation error (e.g. deadlineEnabled is true but deadlineDate is missing or not in the future)',
  })
  @ApiResponse({ status: 403, description: 'Forbidden — requires admin role' })
  async updateSettings(
    @Body() dto: UpdateSettingsDto,
    @CurrentUser() user: User,
  ): Promise<SettingsResponse> {
    const entity = await this.settingsService.updateSettings(dto, user.id);
    return toResponse(entity);
  }
}
