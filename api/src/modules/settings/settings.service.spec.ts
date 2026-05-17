/**
 * Unit tests for SettingsService.
 *
 * Repository is mocked — these tests pin the validation and coercion
 * rules that the service layer owns:
 *  1. `deadlineEnabled = true` with no date → BadRequestException.
 *  2. `deadlineEnabled = true` with a past date → BadRequestException.
 *  3. `deadlineEnabled = true` with a future date → update is issued
 *     with that date.
 *  4. `deadlineEnabled = false` with a date in the body → date is
 *     coerced to `null` in the update payload.
 *  5. `getSettings()` returns the singleton row when present.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';

import { SettingsService } from './settings.service';
import { SystemSettings } from './entities/system-settings.entity';
import { UpdateSettingsDto } from './dto/update-settings.dto';

/* ───────────────────────── Helpers ───────────────────────── */

/**
 * Returns a `YYYY-MM-DD` string offset from "today" by the given
 * number of days. Used to generate stable past / future dates that
 * don't depend on the test runner's clock skew.
 */
function isoDateOffsetFromToday(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Builds a mock entity. The repository's `findOne` is configured per
 * test to return one of these so the post-update `getSettings()` call
 * has something to hand back.
 */
function makeSettings(overrides: Partial<SystemSettings> = {}): SystemSettings {
  return {
    id: 1,
    emailEnabled: false,
    deadlineEnabled: false,
    deadlineDate: null,
    updatedAt: new Date('2026-05-17T00:00:00.000Z'),
    updatedBy: null,
    updatedById: null,
    ...overrides,
  } as SystemSettings;
}

/* ───────────────────────── Suite ───────────────────────── */

describe('SettingsService', () => {
  let service: SettingsService;
  let repo: {
    findOne: jest.Mock;
    update: jest.Mock;
    insert: jest.Mock;
  };

  beforeEach(async () => {
    // Repository stub — only the methods the service actually calls.
    repo = {
      findOne: jest.fn(),
      update: jest.fn(async () => ({ affected: 1 })),
      insert: jest.fn(async () => ({ identifiers: [{ id: 1 }] })),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SettingsService,
        { provide: getRepositoryToken(SystemSettings), useValue: repo },
      ],
    }).compile();

    service = module.get(SettingsService);
  });

  /* ----- getSettings ----- */

  describe('getSettings', () => {
    it('returns the singleton row when present', async () => {
      const expected = makeSettings({ emailEnabled: true });
      repo.findOne.mockResolvedValueOnce(expected);

      const result = await service.getSettings();

      expect(repo.findOne).toHaveBeenCalledWith({ where: { id: 1 } });
      expect(result).toBe(expected);
      // The defensive re-seed branch must NOT fire when the row exists.
      expect(repo.insert).not.toHaveBeenCalled();
    });
  });

  /* ----- updateSettings ----- */

  describe('updateSettings', () => {
    it('throws BadRequestException when deadlineEnabled is true but deadlineDate is missing', async () => {
      const dto: UpdateSettingsDto = {
        emailEnabled: false,
        deadlineEnabled: true,
        // deadlineDate intentionally omitted
      };

      await expect(service.updateSettings(dto, 42)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(service.updateSettings(dto, 42)).rejects.toThrow(
        /deadlineDate is required/i,
      );
      // No DB write should have been attempted.
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when deadlineDate is in the past', async () => {
      const dto: UpdateSettingsDto = {
        emailEnabled: false,
        deadlineEnabled: true,
        deadlineDate: isoDateOffsetFromToday(-7),
      };

      await expect(service.updateSettings(dto, 42)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(service.updateSettings(dto, 42)).rejects.toThrow(
        /must be a future date/i,
      );
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when deadlineDate equals today (not strictly future)', async () => {
      // Reinforces the "strictly future" rule: same-day deadlines are
      // rejected. This pins the boundary so a future refactor can't
      // silently downgrade `<` to `<=`.
      const dto: UpdateSettingsDto = {
        emailEnabled: false,
        deadlineEnabled: true,
        deadlineDate: isoDateOffsetFromToday(0),
      };

      await expect(service.updateSettings(dto, 42)).rejects.toThrow(
        /must be a future date/i,
      );
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('persists the deadline date when deadlineEnabled is true and the date is in the future', async () => {
      const futureDate = isoDateOffsetFromToday(30);
      const dto: UpdateSettingsDto = {
        emailEnabled: true,
        deadlineEnabled: true,
        deadlineDate: futureDate,
      };
      repo.findOne.mockResolvedValueOnce(
        makeSettings({
          emailEnabled: true,
          deadlineEnabled: true,
          deadlineDate: futureDate,
          updatedById: 42,
        }),
      );

      const result = await service.updateSettings(dto, 42);

      expect(repo.update).toHaveBeenCalledTimes(1);
      expect(repo.update).toHaveBeenCalledWith(1, {
        emailEnabled: true,
        deadlineEnabled: true,
        deadlineDate: futureDate,
        updatedById: 42,
      });
      // The return value flows through the post-update `getSettings()`.
      expect(result.deadlineDate).toBe(futureDate);
      expect(result.deadlineEnabled).toBe(true);
      expect(result.updatedById).toBe(42);
    });

    it('coerces deadlineDate to null when deadlineEnabled is false, regardless of the body', async () => {
      const dto: UpdateSettingsDto = {
        emailEnabled: false,
        deadlineEnabled: false,
        // Caller (perhaps the front-end) still sent a date — the
        // service should ignore it and persist null.
        deadlineDate: isoDateOffsetFromToday(30),
      };
      repo.findOne.mockResolvedValueOnce(
        makeSettings({
          emailEnabled: false,
          deadlineEnabled: false,
          deadlineDate: null,
          updatedById: 7,
        }),
      );

      const result = await service.updateSettings(dto, 7);

      expect(repo.update).toHaveBeenCalledTimes(1);
      expect(repo.update).toHaveBeenCalledWith(1, {
        emailEnabled: false,
        deadlineEnabled: false,
        deadlineDate: null,
        updatedById: 7,
      });
      expect(result.deadlineDate).toBeNull();
    });
  });
});
