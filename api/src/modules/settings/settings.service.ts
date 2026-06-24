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
      updateDigestEnabled: false,
      updateDigestIntervalDays: 2,
      updateDigestWindowDays: 2,
      updateDigestEndDate: null,
      updateDigestLastRunAt: null,
      programUpdateDigestEnabled: false,
      programUpdateDigestIntervalDays: 2,
      programUpdateDigestWindowDays: 2,
      programUpdateDigestEndDate: null,
      programUpdateDigestLastRunAt: null,
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
    const digest = this.resolveUpdateDigest(dto);
    const programDigest = this.resolveProgramUpdateDigest(dto);

    // NOTE: update_digest_last_run_at / program_update_digest_last_run_at are
    // intentionally NOT included here — they are service-managed
    // (markUpdateDigestRun / markProgramUpdateDigestRun) and must never be set
    // by a PATCH from the Settings page.
    await this.settingsRepo.update(SETTINGS_ID, {
      emailEnabled: dto.emailEnabled,
      deadlineEnabled: dto.deadlineEnabled,
      deadlineDate,
      programDeadlineEnabled: dto.programDeadlineEnabled,
      programDeadlineDate,
      updateDigestEnabled: digest.enabled,
      updateDigestIntervalDays: digest.intervalDays,
      updateDigestWindowDays: digest.windowDays,
      updateDigestEndDate: digest.endDate,
      programUpdateDigestEnabled: programDigest.enabled,
      programUpdateDigestIntervalDays: programDigest.intervalDays,
      programUpdateDigestWindowDays: programDigest.windowDays,
      programUpdateDigestEndDate: programDigest.endDate,
      updatedById: actorUserId,
    });

    this.logger.log(
      `System settings updated by user ${actorUserId} ` +
        `(emailEnabled=${dto.emailEnabled}, deadlineEnabled=${dto.deadlineEnabled}, deadlineDate=${deadlineDate ?? 'null'}, ` +
        `programDeadlineEnabled=${dto.programDeadlineEnabled}, programDeadlineDate=${programDeadlineDate ?? 'null'}, ` +
        `updateDigestEnabled=${digest.enabled}, updateDigestIntervalDays=${digest.intervalDays}, ` +
        `updateDigestWindowDays=${digest.windowDays}, updateDigestEndDate=${digest.endDate ?? 'null'}, ` +
        `programUpdateDigestEnabled=${programDigest.enabled}, programUpdateDigestIntervalDays=${programDigest.intervalDays}, ` +
        `programUpdateDigestWindowDays=${programDigest.windowDays}, programUpdateDigestEndDate=${programDigest.endDate ?? 'null'})`,
    );

    return this.getSettings();
  }

  /**
   * Stamps `update_digest_last_run_at` to the supplied timestamp. Called
   * **only** by `UpdateDigestService` after a tick that actually iterated
   * centers (due or forced), so the next tick's interval check has a fresh
   * anchor. Updates only that single column — it never touches any
   * admin-managed setting, so it is safe to run from the cron without an
   * actor.
   */
  async markUpdateDigestRun(now: Date): Promise<void> {
    await this.settingsRepo.update(SETTINGS_ID, {
      updateDigestLastRunAt: now,
    });
    this.logger.log(
      `update_digest_last_run_at stamped to ${now.toISOString()}`,
    );
  }

  /**
   * Stamps `program_update_digest_last_run_at` to the supplied timestamp.
   * Called **only** by `ProgramUpdateDigestService` after a tick that
   * actually iterated programs (due or forced), so the next tick's interval
   * check has a fresh anchor. Updates only that single column — it never
   * touches any admin-managed setting, so it is safe to run from the cron
   * without an actor.
   */
  async markProgramUpdateDigestRun(now: Date): Promise<void> {
    await this.settingsRepo.update(SETTINGS_ID, {
      programUpdateDigestLastRunAt: now,
    });
    this.logger.log(
      `program_update_digest_last_run_at stamped to ${now.toISOString()}`,
    );
  }

  /**
   * Validates and normalises the "Notification of Updates" digest fields.
   *
   * Rules (enforced here so messages are domain-level and the interval /
   * window keep their last value when the toggle is off):
   *   1. When `updateDigestEnabled === true`, all of
   *      `updateDigestIntervalDays`, `updateDigestWindowDays` and
   *      `updateDigestEndDate` are required (mirrors `resolveDeadline`).
   *      Numeric ranges (1–90) were already enforced by the DTO.
   *
   * When disabled we coerce `endDate` to `null` but keep `intervalDays` /
   * `windowDays` at whatever the caller sent, else default to 2 — so the
   * cadence/window survive a toggle off→on round-trip without resetting.
   */
  private resolveUpdateDigest(dto: UpdateSettingsDto): {
    enabled: boolean;
    intervalDays: number;
    windowDays: number;
    endDate: string | null;
  } {
    if (!dto.updateDigestEnabled) {
      // Toggle off → clear the end date but preserve interval/window at the
      // caller's value (or the default 2) so re-enabling doesn't reset them.
      return {
        enabled: false,
        intervalDays: dto.updateDigestIntervalDays ?? 2,
        windowDays: dto.updateDigestWindowDays ?? 2,
        endDate: null,
      };
    }

    if (
      dto.updateDigestIntervalDays === null ||
      dto.updateDigestIntervalDays === undefined
    ) {
      throw new BadRequestException(
        'updateDigestIntervalDays is required when updateDigestEnabled is true',
      );
    }
    if (
      dto.updateDigestWindowDays === null ||
      dto.updateDigestWindowDays === undefined
    ) {
      throw new BadRequestException(
        'updateDigestWindowDays is required when updateDigestEnabled is true',
      );
    }
    if (
      dto.updateDigestEndDate === null ||
      dto.updateDigestEndDate === undefined ||
      dto.updateDigestEndDate === ''
    ) {
      throw new BadRequestException(
        'updateDigestEndDate is required when updateDigestEnabled is true',
      );
    }

    return {
      enabled: true,
      intervalDays: dto.updateDigestIntervalDays,
      windowDays: dto.updateDigestWindowDays,
      // Normalise to YYYY-MM-DD; the DTO already validated the ISO shape.
      endDate: dto.updateDigestEndDate.slice(0, 10),
    };
  }

  /**
   * Validates and normalises the **program-side** "Notification of Updates"
   * digest fields. Program twin of {@link resolveUpdateDigest}.
   *
   * Rules (enforced here so messages are domain-level and the interval /
   * window keep their last value when the toggle is off):
   *   1. When `programUpdateDigestEnabled === true`, all of
   *      `programUpdateDigestIntervalDays`, `programUpdateDigestWindowDays`
   *      and `programUpdateDigestEndDate` are required. Numeric ranges
   *      (1–90) were already enforced by the DTO.
   *
   * When disabled we coerce `endDate` to `null` but keep `intervalDays` /
   * `windowDays` at whatever the caller sent, else default to 2 — so the
   * cadence/window survive a toggle off→on round-trip without resetting.
   */
  private resolveProgramUpdateDigest(dto: UpdateSettingsDto): {
    enabled: boolean;
    intervalDays: number;
    windowDays: number;
    endDate: string | null;
  } {
    if (!dto.programUpdateDigestEnabled) {
      return {
        enabled: false,
        intervalDays: dto.programUpdateDigestIntervalDays ?? 2,
        windowDays: dto.programUpdateDigestWindowDays ?? 2,
        endDate: null,
      };
    }

    if (
      dto.programUpdateDigestIntervalDays === null ||
      dto.programUpdateDigestIntervalDays === undefined
    ) {
      throw new BadRequestException(
        'programUpdateDigestIntervalDays is required when programUpdateDigestEnabled is true',
      );
    }
    if (
      dto.programUpdateDigestWindowDays === null ||
      dto.programUpdateDigestWindowDays === undefined
    ) {
      throw new BadRequestException(
        'programUpdateDigestWindowDays is required when programUpdateDigestEnabled is true',
      );
    }
    if (
      dto.programUpdateDigestEndDate === null ||
      dto.programUpdateDigestEndDate === undefined ||
      dto.programUpdateDigestEndDate === ''
    ) {
      throw new BadRequestException(
        'programUpdateDigestEndDate is required when programUpdateDigestEnabled is true',
      );
    }

    return {
      enabled: true,
      intervalDays: dto.programUpdateDigestIntervalDays,
      windowDays: dto.programUpdateDigestWindowDays,
      // Normalise to YYYY-MM-DD; the DTO already validated the ISO shape.
      endDate: dto.programUpdateDigestEndDate.slice(0, 10),
    };
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
