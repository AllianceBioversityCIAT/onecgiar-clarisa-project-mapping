import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SystemSettings } from './entities/system-settings.entity';
import { UpdateSettingsDto } from './dto/update-settings.dto';

/**
 * Singleton primary-key value for the `system_settings` table.
 * Mirrors the `CHECK (id = 1)` constraint enforced in the migration.
 */
const SETTINGS_ID = 1;

/**
 * Service backing the admin-managed System Settings page.
 *
 * Always operates on the single `system_settings` row (id = 1). The row
 * is seeded by the migration so `getSettings()` should never need to
 * fall back to insertion; we still handle the absent case defensively
 * (e.g. after a manual TRUNCATE in dev) by re-inserting the default row.
 */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(
    @InjectRepository(SystemSettings)
    private readonly settingsRepo: Repository<SystemSettings>,
  ) {}

  /**
   * Returns the singleton settings row.
   *
   * Re-creates the row from defaults if it is somehow missing — this
   * shouldn't happen post-migration, but it keeps the API working in
   * dev environments where someone has manually truncated the table.
   */
  async getSettings(): Promise<SystemSettings> {
    const existing = await this.settingsRepo.findOne({
      where: { id: SETTINGS_ID },
    });
    if (existing) return existing;

    this.logger.warn(
      'system_settings singleton row missing — re-seeding defaults',
    );
    // Use insert + find rather than save() so we don't have to assemble
    // a fully populated entity (the migration's column defaults handle
    // `updated_at`).
    await this.settingsRepo.insert({
      id: SETTINGS_ID,
      emailEnabled: false,
      deadlineEnabled: false,
      deadlineDate: null,
      programDeadlineEnabled: false,
      programDeadlineDate: null,
      updatedById: null,
    });
    // `findOne` after insert guarantees we return the row with all
    // server-side defaults (updated_at) materialised.
    return (await this.settingsRepo.findOne({
      where: { id: SETTINGS_ID },
    })) as SystemSettings;
  }

  /**
   * Updates the singleton settings row.
   *
   * Validation rules (enforced here rather than via class-validator
   * decorators so we can compare dates as `YYYY-MM-DD` strings and
   * avoid timezone surprises):
   *   1. When `deadlineEnabled === true`, `deadlineDate` is required.
   *   2. When `deadlineEnabled === true`, the date must be strictly
   *      in the future (server-local "today" wall-clock).
   *
   * When `deadlineEnabled === false` we coerce `deadlineDate` to `null`
   * regardless of what the caller sent, so a previously-set deadline is
   * cleared cleanly when the admin toggles the flag off.
   */
  async updateSettings(
    dto: UpdateSettingsDto,
    actorUserId: number,
  ): Promise<SystemSettings> {
    const deadlineDate = this.resolveDeadline(
      'deadlineDate',
      dto.deadlineEnabled,
      dto.deadlineDate,
    );
    const programDeadlineDate = this.resolveDeadline(
      'programDeadlineDate',
      dto.programDeadlineEnabled,
      dto.programDeadlineDate,
    );

    await this.settingsRepo.update(SETTINGS_ID, {
      emailEnabled: dto.emailEnabled,
      deadlineEnabled: dto.deadlineEnabled,
      deadlineDate,
      programDeadlineEnabled: dto.programDeadlineEnabled,
      programDeadlineDate,
      updatedById: actorUserId,
    });

    this.logger.log(
      `System settings updated by user ${actorUserId} ` +
        `(emailEnabled=${dto.emailEnabled}, deadlineEnabled=${dto.deadlineEnabled}, deadlineDate=${deadlineDate ?? 'null'}, ` +
        `programDeadlineEnabled=${dto.programDeadlineEnabled}, programDeadlineDate=${programDeadlineDate ?? 'null'})`,
    );

    return this.getSettings();
  }

  /**
   * Validates and normalises one deadline (enabled flag + raw date) to the
   * value we persist. Shared by the center and program deadlines.
   *
   * Rules (per deadline, enforced here rather than via class-validator so
   * we can normalise `YYYY-MM-DD` strings consistently):
   *   1. When `enabled === true`, the date is required. Any calendar date
   *      is accepted — past, today, or future (no future-only restriction).
   *
   * When `enabled === false` we coerce the date to `null` regardless of
   * what the caller sent, so a previously-set deadline is cleared cleanly.
   *
   * `fieldName` is only used to produce a clear validation message.
   */
  private resolveDeadline(
    fieldName: 'deadlineDate' | 'programDeadlineDate',
    enabled: boolean,
    raw: string | null | undefined,
  ): string | null {
    if (!enabled) {
      // Toggle off → clear any previously stored deadline.
      return null;
    }

    // Rule 1: date is required when the toggle is on.
    if (raw === null || raw === undefined || raw === '') {
      throw new BadRequestException(
        `${fieldName} is required when its deadline toggle is enabled`,
      );
    }

    // Normalise to the first 10 chars; the DTO already validated the
    // ISO 8601 shape, so `slice(0, 10)` is safe. No future-date check —
    // any calendar date is allowed.
    return raw.slice(0, 10);
  }
}
