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
    let deadlineDate: string | null;

    if (dto.deadlineEnabled) {
      // Rule 1: date is required when the toggle is on.
      const raw = dto.deadlineDate;
      if (raw === null || raw === undefined || raw === '') {
        throw new BadRequestException(
          'deadlineDate is required when deadlineEnabled is true',
        );
      }

      // Normalise to the first 10 chars; the DTO already validated the
      // ISO 8601 shape, so `slice(0, 10)` is safe.
      const dateOnly = raw.slice(0, 10);

      // Rule 2: must be strictly in the future. We compare as
      // `YYYY-MM-DD` strings (lexicographic order matches calendar
      // order for ISO dates) so we never accidentally do a UTC vs
      // local-time off-by-one comparison.
      const todayStr = this.getTodayLocalIsoDate();
      if (dateOnly <= todayStr) {
        throw new BadRequestException('deadlineDate must be a future date');
      }

      deadlineDate = dateOnly;
    } else {
      // Toggle off → clear any previously stored deadline.
      deadlineDate = null;
    }

    await this.settingsRepo.update(SETTINGS_ID, {
      emailEnabled: dto.emailEnabled,
      deadlineEnabled: dto.deadlineEnabled,
      deadlineDate,
      updatedById: actorUserId,
    });

    this.logger.log(
      `System settings updated by user ${actorUserId} ` +
        `(emailEnabled=${dto.emailEnabled}, deadlineEnabled=${dto.deadlineEnabled}, deadlineDate=${deadlineDate ?? 'null'})`,
    );

    return this.getSettings();
  }

  /**
   * Returns today's date in the server's local timezone as a
   * `YYYY-MM-DD` string. Used by the "future date" validation so we
   * compare apples-to-apples with the caller-supplied date string.
   */
  private getTodayLocalIsoDate(): string {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
}
