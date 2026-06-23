/**
 * Unit tests for ProgramMappingReminderService.
 *
 * All TypeORM repositories, SettingsService, and EmailsService are mocked —
 * no real database, no real cron, no HTTP.
 *
 * Coverage areas:
 *  1. Global gates  — programDeadlineEnabled, programDeadlineDate=null,
 *                     deadline passed. Daily cadence: a run proceeds on any
 *                     weekday (no Monday throttle, unlike the center reminder).
 *  2. Per-program   — no pending mappings (skip), no recipients (skip).
 *  3. Fan-out       — multiple recipients per program, cross-program isolation.
 *  4. Idempotency   — existing same-day row prevents re-enqueue.
 *  5. Error isolation — enqueue rejection for one recipient does not abort others.
 *
 * QueryBuilder chains are stubbed via fluent mocks (return `this` on every
 * builder method), derived directly from the service source:
 *  - userRepository QB:    innerJoin / where / andWhere / select / getMany
 *  - emailRepository QB:   select / where / andWhere / limit / getRawOne
 *  - emailRepository.manager QB: select / from / innerJoin / where / andWhere / getRawOne
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Logger } from '@nestjs/common';

import { ProgramMappingReminderService } from './program-mapping-reminder.service';
import { Email } from './entities/email.entity';
import { EmailsService } from './emails.service';
import { User } from '../users/entities/user.entity';
import { Program } from '../reference-data/entities/program.entity';
import { SettingsService } from '../settings/settings.service';

/* ─────────────────────────── Factories ─────────────────────────── */

/** Default settings: program deadline enabled, far in the future. */
function makeSettings(
  overrides: Partial<{
    programDeadlineEnabled: boolean;
    programDeadlineDate: string | null;
  }> = {},
) {
  return {
    emailEnabled: true,
    deadlineEnabled: true,
    deadlineDate: '2026-06-30',
    programDeadlineEnabled: true,
    programDeadlineDate: '2026-07-06',
    ...overrides,
  };
}

/** Default program stub. */
function makeProgram(overrides: Partial<Program> = {}): Program {
  return {
    id: 1,
    name: 'Sustainable Farming Initiative',
    officialCode: 'INIT-01',
    ...overrides,
  } as Program;
}

/** A minimal program_rep recipient as returned by resolveRecipients(). */
function makeRecipient(
  overrides: Partial<{ id: number; email: string }> = {},
): { id: number; email: string } {
  return { id: 10, email: 'progrep@cgiar.org', ...overrides };
}

/** Fluent QB mock for `userRepository` (resolveRecipients). */
function makeUserQb(
  getManyResult: Array<{ id: number; email: string }> = [],
): any {
  return {
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(getManyResult),
  };
}

/** Fluent QB mock for `emailRepository` idempotency check. */
function makeEmailIdempotencyQb(getRawOneResult: object | null = null): any {
  return {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    getRawOne: jest.fn().mockResolvedValue(getRawOneResult),
  };
}

/** Fluent QB mock for the pending-mapping count (manager.createQueryBuilder). */
function makeCountQb(pending: number): any {
  return {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getRawOne: jest.fn().mockResolvedValue({ pending: String(pending) }),
  };
}

/* ─────────────────────────── Suite ─────────────────────────── */

describe('ProgramMappingReminderService', () => {
  let service: ProgramMappingReminderService;

  let settingsGetMock: jest.Mock;
  let programFindMock: jest.Mock;
  let enqueueMock: jest.Mock;
  let emailCreateQbMock: jest.Mock;
  let userCreateQbMock: jest.Mock;
  let managerCreateQbMock: jest.Mock;

  // A Tuesday well before the 2026-07-06 deadline — proves the daily cadence
  // proceeds on a non-Monday (the center reminder would throttle here).
  const TUESDAY_BEFORE_DEADLINE = new Date('2026-06-23T09:05:00.000Z');

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockReturnValue(undefined);
    jest.spyOn(Logger.prototype, 'error').mockReturnValue(undefined);
    jest.spyOn(Logger.prototype, 'warn').mockReturnValue(undefined);
    jest.spyOn(Logger.prototype, 'debug').mockReturnValue(undefined);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  beforeEach(async () => {
    settingsGetMock = jest.fn().mockResolvedValue(makeSettings());
    programFindMock = jest.fn().mockResolvedValue([makeProgram()]);
    enqueueMock = jest.fn().mockResolvedValue({ id: 99 });
    emailCreateQbMock = jest.fn().mockReturnValue(makeEmailIdempotencyQb(null));
    userCreateQbMock = jest.fn().mockReturnValue(makeUserQb([makeRecipient()]));
    // Default: one mapping pending the program's response.
    managerCreateQbMock = jest.fn().mockReturnValue(makeCountQb(1));

    const emailRepoMock = {
      createQueryBuilder: emailCreateQbMock,
      manager: { createQueryBuilder: managerCreateQbMock },
    };
    const userRepoMock = { createQueryBuilder: userCreateQbMock };
    const programRepoMock = { find: programFindMock };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProgramMappingReminderService,
        { provide: getRepositoryToken(Email), useValue: emailRepoMock },
        { provide: getRepositoryToken(User), useValue: userRepoMock },
        { provide: getRepositoryToken(Program), useValue: programRepoMock },
        { provide: SettingsService, useValue: { getSettings: settingsGetMock } },
        { provide: EmailsService, useValue: { enqueue: enqueueMock } },
      ],
    }).compile();

    service = module.get(ProgramMappingReminderService);
  });

  /* ----- global gates ----- */

  it('short-circuits when the program deadline is disabled', async () => {
    settingsGetMock.mockResolvedValueOnce(
      makeSettings({ programDeadlineEnabled: false }),
    );

    const result = await service.runTick(TUESDAY_BEFORE_DEADLINE);

    expect(result.shortCircuit).toBe('deadline_disabled');
    expect(result.enqueued).toBe(0);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('short-circuits when the program deadline date is null', async () => {
    settingsGetMock.mockResolvedValueOnce(
      makeSettings({ programDeadlineDate: null }),
    );

    const result = await service.runTick(TUESDAY_BEFORE_DEADLINE);

    expect(result.shortCircuit).toBe('deadline_disabled');
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('short-circuits when the program deadline has already passed', async () => {
    const afterDeadline = new Date('2026-07-10T09:05:00.000Z');

    const result = await service.runTick(afterDeadline);

    expect(result.shortCircuit).toBe('deadline_passed');
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('proceeds on a non-Monday (daily cadence — no weekly throttle)', async () => {
    const result = await service.runTick(TUESDAY_BEFORE_DEADLINE);

    expect(result.ran).toBe(true);
    expect(result.enqueued).toBe(1);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });

  /* ----- per-program stop conditions ----- */

  it('skips a program with no mappings awaiting a response', async () => {
    managerCreateQbMock.mockReturnValue(makeCountQb(0));

    const result = await service.runTick(TUESDAY_BEFORE_DEADLINE);

    expect(result.enqueued).toBe(0);
    expect(result.programsSkipped).toBe(1);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('skips a program with no active recipients', async () => {
    userCreateQbMock.mockReturnValue(makeUserQb([]));

    const result = await service.runTick(TUESDAY_BEFORE_DEADLINE);

    expect(result.enqueued).toBe(0);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  /* ----- enqueue + metadata ----- */

  it('enqueues one HTML email per recipient with the program template key + reminderDate', async () => {
    userCreateQbMock.mockReturnValue(
      makeUserQb([
        makeRecipient({ id: 10, email: 'a@cgiar.org' }),
        makeRecipient({ id: 11, email: 'b@cgiar.org' }),
      ]),
    );

    const result = await service.runTick(TUESDAY_BEFORE_DEADLINE);

    expect(result.enqueued).toBe(2);
    expect(enqueueMock).toHaveBeenCalledTimes(2);
    const firstArg = enqueueMock.mock.calls[0][0];
    expect(firstArg.templateKey).toBe('program_mapping_reminder');
    expect(firstArg.metadata.reminderDate).toBe('2026-06-23');
    expect(firstArg.metadata.programId).toBe(1);
    expect(firstArg.subject).toContain('Sustainable Farming Initiative');
  });

  /* ----- idempotency ----- */

  it('does not re-enqueue a recipient already reminded today', async () => {
    emailCreateQbMock.mockReturnValue(makeEmailIdempotencyQb({ id: 1 }));

    const result = await service.runTick(TUESDAY_BEFORE_DEADLINE);

    expect(result.enqueued).toBe(0);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  /* ----- error isolation ----- */

  it('continues to the next recipient when one enqueue rejects', async () => {
    userCreateQbMock.mockReturnValue(
      makeUserQb([
        makeRecipient({ id: 10, email: 'a@cgiar.org' }),
        makeRecipient({ id: 11, email: 'b@cgiar.org' }),
      ]),
    );
    enqueueMock
      .mockRejectedValueOnce(new Error('smtp down'))
      .mockResolvedValueOnce({ id: 100 });

    const result = await service.runTick(TUESDAY_BEFORE_DEADLINE);

    // One failed, one succeeded — the failure did not abort the loop.
    expect(enqueueMock).toHaveBeenCalledTimes(2);
    expect(result.enqueued).toBe(1);
  });
});
