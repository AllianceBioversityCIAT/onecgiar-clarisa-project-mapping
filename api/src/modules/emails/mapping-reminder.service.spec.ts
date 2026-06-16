/**
 * Unit tests for MappingReminderService.
 *
 * All TypeORM repositories, SettingsService, ProjectsService, and
 * EmailsService are mocked — no real database, no real cron, no HTTP.
 *
 * Coverage areas:
 *  1. Global gates  — deadline_enabled, deadline_date=null,
 *                     deadline passed, weekday cadence (weekly vs daily).
 *                     `email_enabled` is NOT read by the reminder service
 *                     (it gates the dispatcher only) — the dedicated case
 *                     below pins this contract.
 *  2. Per-center    — mappedPercent>=90, totalBudgetYear=0, no recipients.
 *  3. Fan-out       — multiple recipients per center, cross-center isolation.
 *  4. Idempotency   — existing same-day row prevents re-enqueue.
 *  5. Error isolation — enqueue rejection for one recipient does not abort others.
 *
 * QueryBuilder chains are stubbed via a fluent mock factory that returns
 * `this` on every builder method. The exact chain methods are derived
 * directly from the service source:
 *  - userRepository QB: innerJoin / where / andWhere / select / getMany
 *  - emailRepository QB: select / where / andWhere / limit / getRawOne
 *  - emailRepository.manager QB: select / from / innerJoin / where / andWhere / getRawOne
 *
 * Style matches emails.service.spec.ts in this directory.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Logger } from '@nestjs/common';

import { MappingReminderService } from './mapping-reminder.service';
import { Email } from './entities/email.entity';
import { EmailsService } from './emails.service';
import { User } from '../users/entities/user.entity';
import { Center } from '../reference-data/entities/center.entity';
import { SettingsService } from '../settings/settings.service';
import { ProjectsService } from '../projects/projects.service';

/* ─────────────────────────────────────────────────────────────────────
 * Factories
 * ──────────────────────────────────────────────────────────────────── */

/** Default settings: everything enabled, deadline is 2026-06-30. */
function makeSettings(
  overrides: Partial<{
    emailEnabled: boolean;
    deadlineEnabled: boolean;
    deadlineDate: string | null;
  }> = {},
) {
  return {
    emailEnabled: true,
    deadlineEnabled: true,
    deadlineDate: '2026-06-30',
    ...overrides,
  };
}

/** Default center stub. */
function makeCenter(overrides: Partial<Center> = {}): Center {
  return {
    id: 1,
    name: 'International Center for Tropical Agriculture',
    acronym: 'CIAT',
    ...overrides,
  } as Center;
}

/** Default summary: 85 % mapped, budget > 0, 10 active projects. */
function makeSummary(
  overrides: Partial<{
    mappedPercent: number;
    totalBudgetYear: number;
    activeProjectCount: number;
  }> = {},
) {
  return {
    mappedPercent: 85,
    totalBudgetYear: 5_000_000,
    activeProjectCount: 10,
    ...overrides,
  };
}

/** A minimal center_rep user as returned by resolveRecipients(). */
function makeRecipient(
  overrides: Partial<{ id: number; email: string }> = {},
): { id: number; email: string } {
  return { id: 10, email: 'rep@cgiar.org', ...overrides };
}

/**
 * Builds a fluent QueryBuilder mock for the `userRepository`.
 * The service chain is: innerJoin → where → andWhere → andWhere → select → getMany
 * All chainable methods return `this`; `getMany` is configurable.
 */
function makeUserQb(
  getManyResult: Array<{ id: number; email: string }> = [],
): any {
  const qb: any = {
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(getManyResult),
  };
  return qb;
}

/**
 * Builds a fluent QueryBuilder mock for the `emailRepository` idempotency check.
 * The service chain is: select → where → andWhere → andWhere → limit → getRawOne
 * All chainable methods return `this`; `getRawOne` is configurable.
 */
function makeEmailIdempotencyQb(getRawOneResult: object | null = null): any {
  const qb: any = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    getRawOne: jest.fn().mockResolvedValue(getRawOneResult),
  };
  return qb;
}

/**
 * Builds a fluent QueryBuilder mock for the raw count query used by
 * `countProjectsWithAnyAgreedMapping`. The service calls this on
 * `emailRepository.manager.createQueryBuilder()`.
 * Chain: select → from → innerJoin → where → andWhere → getRawOne
 */
function makeCountQb(count: number = 0): any {
  const qb: any = {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getRawOne: jest.fn().mockResolvedValue({ count: String(count) }),
  };
  return qb;
}

/* ─────────────────────────────────────────────────────────────────────
 * Suite
 * ──────────────────────────────────────────────────────────────────── */

describe('MappingReminderService', () => {
  let service: MappingReminderService;

  // Mock handles — reconfigured in beforeEach and individual tests.
  let settingsGetMock: jest.Mock;
  let centerFindMock: jest.Mock;
  let getSummaryMock: jest.Mock;
  let enqueueMock: jest.Mock;
  let emailCreateQbMock: jest.Mock;
  let userCreateQbMock: jest.Mock;
  let managerCreateQbMock: jest.Mock;

  // Silence all Logger output so test stdout stays clean.
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
    // --- settings defaults ---
    settingsGetMock = jest.fn().mockResolvedValue(makeSettings());

    // --- center repo: one center by default ---
    centerFindMock = jest.fn().mockResolvedValue([makeCenter()]);

    // --- projects service: 85 % mapped, budget > 0, 10 active ---
    getSummaryMock = jest.fn().mockResolvedValue(makeSummary());

    // --- emails service enqueue: succeeds by default ---
    enqueueMock = jest.fn().mockResolvedValue({ id: 99 });

    // --- email repo idempotency QB: no prior row by default (alreadyReminded=false) ---
    emailCreateQbMock = jest.fn().mockReturnValue(makeEmailIdempotencyQb(null));

    // --- user repo QB: one recipient by default ---
    userCreateQbMock = jest.fn().mockReturnValue(makeUserQb([makeRecipient()]));

    // --- manager QB for countProjectsWithAnyAgreedMapping: 5 mapped by default ---
    managerCreateQbMock = jest.fn().mockReturnValue(makeCountQb(5));

    const emailRepoMock = {
      createQueryBuilder: emailCreateQbMock,
      manager: {
        createQueryBuilder: managerCreateQbMock,
      },
    };

    const userRepoMock = {
      createQueryBuilder: userCreateQbMock,
    };

    const centerRepoMock = {
      find: centerFindMock,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MappingReminderService,
        { provide: getRepositoryToken(Email), useValue: emailRepoMock },
        { provide: getRepositoryToken(User), useValue: userRepoMock },
        { provide: getRepositoryToken(Center), useValue: centerRepoMock },
        {
          provide: SettingsService,
          useValue: { getSettings: settingsGetMock },
        },
        {
          provide: ProjectsService,
          useValue: { getSummary: getSummaryMock },
        },
        {
          provide: EmailsService,
          useValue: { enqueue: enqueueMock },
        },
      ],
    }).compile();

    service = module.get(MappingReminderService);
  });

  /* ─────────────────────────────────────────────────────────────────── */
  /* Case 1: email_enabled = false — generation still runs                */
  /*                                                                      */
  /* The dispatcher (EmailsDispatchService) is the sole owner of the      */
  /* `system_settings.email_enabled` kill switch. The reminder generator  */
  /* deliberately ignores it so rows are always enqueued on schedule;     */
  /* they pile up in `emails` with status='queued' and publish            */
  /* automatically once email sending is re-enabled. This pins that      */
  /* contract so a future refactor can't silently re-introduce the gate. */
  /* ─────────────────────────────────────────────────────────────────── */

  it('still enqueues reminders when email_enabled=false (dispatcher is the kill switch)', async () => {
    // Monday, 10 days to deadline — all OTHER gates pass; only the
    // (now-removed) email_enabled gate would have stopped this.
    settingsGetMock.mockResolvedValueOnce(
      makeSettings({
        emailEnabled: false,
        deadlineEnabled: true,
        deadlineDate: '2026-06-11',
      }),
    );

    await service.runTick(new Date('2026-06-01T09:00:00Z'));

    // The generator MUST fetch centers and enqueue at least the
    // default single recipient configured in beforeEach.
    expect(centerFindMock).toHaveBeenCalled();
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        toUserId: 10,
        toEmail: 'rep@cgiar.org',
        templateKey: 'center_mapping_reminder',
      }),
    );
  });

  /* ─────────────────────────────────────────────────────────────────── */
  /* Case 2: deadline_enabled = false                                    */
  /* ─────────────────────────────────────────────────────────────────── */

  it('returns early when deadline_enabled=false', async () => {
    settingsGetMock.mockResolvedValueOnce(
      makeSettings({ emailEnabled: true, deadlineEnabled: false }),
    );

    await service.runTick(new Date('2026-06-01T09:00:00Z'));

    expect(enqueueMock).not.toHaveBeenCalled();
    expect(centerFindMock).not.toHaveBeenCalled();
  });

  /* ─────────────────────────────────────────────────────────────────── */
  /* Case 3: deadline_date = null                                        */
  /* ─────────────────────────────────────────────────────────────────── */

  it('returns early when deadline_date is null', async () => {
    settingsGetMock.mockResolvedValueOnce(
      makeSettings({
        emailEnabled: true,
        deadlineEnabled: true,
        deadlineDate: null,
      }),
    );

    await service.runTick(new Date('2026-06-01T09:00:00Z'));

    expect(enqueueMock).not.toHaveBeenCalled();
    expect(centerFindMock).not.toHaveBeenCalled();
  });

  /* ─────────────────────────────────────────────────────────────────── */
  /* Case 4: deadline is yesterday                                       */
  /* ─────────────────────────────────────────────────────────────────── */

  it('returns early when deadline date is in the past (yesterday)', async () => {
    // now = 2026-06-02, deadline = 2026-06-01 → daysUntilDeadline = -1
    settingsGetMock.mockResolvedValueOnce(
      makeSettings({ deadlineDate: '2026-06-01' }),
    );

    await service.runTick(new Date('2026-06-02T09:00:00Z'));

    expect(enqueueMock).not.toHaveBeenCalled();
    expect(centerFindMock).not.toHaveBeenCalled();
  });

  /* ─────────────────────────────────────────────────────────────────── */
  /* Case 5: daysUntilDeadline=10, today=Tuesday → weekday gate fires   */
  /* ─────────────────────────────────────────────────────────────────── */

  it('skips enqueue on a non-Monday Tuesday when daysUntilDeadline=10 (weekly cadence)', async () => {
    // 2026-06-02 is a Tuesday (UTC day=2), deadline 2026-06-12 → 10 days out
    settingsGetMock.mockResolvedValueOnce(
      makeSettings({ deadlineDate: '2026-06-12' }),
    );

    await service.runTick(new Date('2026-06-02T09:00:00Z'));

    expect(enqueueMock).not.toHaveBeenCalled();
    // Centers are NOT fetched when the weekday gate fires before the centers loop
    expect(centerFindMock).not.toHaveBeenCalled();
  });

  /* ─────────────────────────────────────────────────────────────────── */
  /* Case 6: daysUntilDeadline=10, today=Monday → enqueue fires         */
  /* ─────────────────────────────────────────────────────────────────── */

  it('enqueues for eligible recipients on a Monday with 10 days until deadline', async () => {
    // 2026-06-01 is a Monday (UTC day=1), deadline 2026-06-11 → 10 days out
    settingsGetMock.mockResolvedValueOnce(
      makeSettings({ deadlineDate: '2026-06-11' }),
    );

    await service.runTick(new Date('2026-06-01T09:00:00Z'));

    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });

  /* ─────────────────────────────────────────────────────────────────── */
  /* Case 7: daysUntilDeadline=2, today=Wednesday → daily window fires  */
  /* ─────────────────────────────────────────────────────────────────── */

  it('enqueues on a Wednesday when only 2 days remain (daily window)', async () => {
    // 2026-06-10 is a Wednesday (UTC day=3), deadline 2026-06-12 → 2 days out
    settingsGetMock.mockResolvedValueOnce(
      makeSettings({ deadlineDate: '2026-06-12' }),
    );

    await service.runTick(new Date('2026-06-10T09:00:00Z'));

    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });

  /* ─────────────────────────────────────────────────────────────────── */
  /* Case 8: center has mappedPercent=92 — skip that center only        */
  /* ─────────────────────────────────────────────────────────────────── */

  it('skips center at 92% but still processes other centers below threshold', async () => {
    // Two centers: one at 92%, one at 85%.
    const centerAt92 = makeCenter({ id: 1, acronym: 'CIAT' });
    const centerAt85 = makeCenter({ id: 2, acronym: 'IRRI' });
    centerFindMock.mockResolvedValueOnce([centerAt92, centerAt85]);

    getSummaryMock
      .mockResolvedValueOnce(makeSummary({ mappedPercent: 92 })) // CIAT → skip
      .mockResolvedValueOnce(makeSummary({ mappedPercent: 85 })); // IRRI → process

    // Both QBs need to work for the second center (user + idempotency + count)
    userCreateQbMock.mockReturnValueOnce(
      makeUserQb([makeRecipient({ id: 20, email: 'rep@irri.org' })]),
    );
    managerCreateQbMock.mockReturnValueOnce(makeCountQb(4));
    emailCreateQbMock.mockReturnValueOnce(makeEmailIdempotencyQb(null)); // not yet reminded

    // Monday, 10 days to deadline
    settingsGetMock.mockResolvedValueOnce(
      makeSettings({ deadlineDate: '2026-06-11' }),
    );
    await service.runTick(new Date('2026-06-01T09:00:00Z'));

    // enqueue called exactly once (for the 85% center's recipient)
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({ toUserId: 20 }),
    );
  });

  /* ─────────────────────────────────────────────────────────────────── */
  /* Case 9: center has totalBudgetYear=0 — skip                        */
  /* ─────────────────────────────────────────────────────────────────── */

  it('skips a center with totalBudgetYear=0 (no portfolio to map)', async () => {
    getSummaryMock.mockResolvedValueOnce(
      makeSummary({
        mappedPercent: 0,
        totalBudgetYear: 0,
        activeProjectCount: 0,
      }),
    );
    // Monday, far from deadline
    settingsGetMock.mockResolvedValueOnce(
      makeSettings({ deadlineDate: '2026-06-11' }),
    );

    await service.runTick(new Date('2026-06-01T09:00:00Z'));

    expect(enqueueMock).not.toHaveBeenCalled();
  });

  /* ─────────────────────────────────────────────────────────────────── */
  /* Case 10: center has no active reps — skip                          */
  /* ─────────────────────────────────────────────────────────────────── */

  it('skips a center with no active center_rep recipients', async () => {
    userCreateQbMock.mockReturnValueOnce(makeUserQb([])); // empty recipients
    settingsGetMock.mockResolvedValueOnce(
      makeSettings({ deadlineDate: '2026-06-11' }),
    );

    await service.runTick(new Date('2026-06-01T09:00:00Z'));

    expect(enqueueMock).not.toHaveBeenCalled();
  });

  /* ─────────────────────────────────────────────────────────────────── */
  /* Case 11: idempotency — same-day row already exists for recipient   */
  /* ─────────────────────────────────────────────────────────────────── */

  it('skips enqueue when an existing same-day reminder row exists for a recipient', async () => {
    // Two recipients: user 10 already reminded, user 11 not yet reminded.
    userCreateQbMock.mockReturnValueOnce(
      makeUserQb([
        makeRecipient({ id: 10, email: 'rep1@cgiar.org' }),
        makeRecipient({ id: 11, email: 'rep2@cgiar.org' }),
      ]),
    );

    // idempotency check: first call returns a row (already reminded),
    // second call returns null (not yet reminded).
    emailCreateQbMock
      .mockReturnValueOnce(makeEmailIdempotencyQb({ id: 42 })) // recipient 10 → skip
      .mockReturnValueOnce(makeEmailIdempotencyQb(null)); // recipient 11 → enqueue

    managerCreateQbMock.mockReturnValueOnce(makeCountQb(5));
    settingsGetMock.mockResolvedValueOnce(
      makeSettings({ deadlineDate: '2026-06-11' }),
    );

    await service.runTick(new Date('2026-06-01T09:00:00Z'));

    // Only recipient 11 should have been enqueued.
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({ toUserId: 11 }),
    );
  });

  /* ─────────────────────────────────────────────────────────────────── */
  /* Case 12: two centers — 85% + 92%                                   */
  /* ─────────────────────────────────────────────────────────────────── */

  it('enqueues only for the 85% center when the other is at 92%', async () => {
    const center85 = makeCenter({ id: 1, acronym: 'CIAT' });
    const center92 = makeCenter({ id: 2, acronym: 'IRRI' });
    centerFindMock.mockResolvedValueOnce([center85, center92]);

    getSummaryMock
      .mockResolvedValueOnce(makeSummary({ mappedPercent: 85 })) // CIAT → process
      .mockResolvedValueOnce(makeSummary({ mappedPercent: 92 })); // IRRI → skip

    userCreateQbMock.mockReturnValueOnce(
      makeUserQb([makeRecipient({ id: 10, email: 'ciat@cgiar.org' })]),
    );
    managerCreateQbMock.mockReturnValueOnce(makeCountQb(5));
    emailCreateQbMock.mockReturnValueOnce(makeEmailIdempotencyQb(null));

    settingsGetMock.mockResolvedValueOnce(
      makeSettings({ deadlineDate: '2026-06-11' }),
    );

    await service.runTick(new Date('2026-06-01T09:00:00Z'));

    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({ toUserId: 10 }),
    );
  });

  /* ─────────────────────────────────────────────────────────────────── */
  /* Case 13: fan-out — one center with 3 active reps                   */
  /* ─────────────────────────────────────────────────────────────────── */

  it('calls enqueue exactly 3 times when a center has 3 active recipients', async () => {
    const three = [
      makeRecipient({ id: 10, email: 'a@cgiar.org' }),
      makeRecipient({ id: 11, email: 'b@cgiar.org' }),
      makeRecipient({ id: 12, email: 'c@cgiar.org' }),
    ];
    userCreateQbMock.mockReturnValueOnce(makeUserQb(three));

    // None already reminded
    emailCreateQbMock
      .mockReturnValueOnce(makeEmailIdempotencyQb(null))
      .mockReturnValueOnce(makeEmailIdempotencyQb(null))
      .mockReturnValueOnce(makeEmailIdempotencyQb(null));

    managerCreateQbMock.mockReturnValueOnce(makeCountQb(3));
    settingsGetMock.mockResolvedValueOnce(
      makeSettings({ deadlineDate: '2026-06-11' }),
    );

    await service.runTick(new Date('2026-06-01T09:00:00Z'));

    expect(enqueueMock).toHaveBeenCalledTimes(3);
    const calledUserIds = enqueueMock.mock.calls.map(
      (call: [{ toUserId: number }]) => call[0].toUserId,
    );
    expect(calledUserIds).toEqual(expect.arrayContaining([10, 11, 12]));
  });

  /* ─────────────────────────────────────────────────────────────────── */
  /* Case 14: enqueue throws for recipient A, continues for B           */
  /* ─────────────────────────────────────────────────────────────────── */

  it('logs an error and continues to the next recipient when enqueue throws', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error');

    const two = [
      makeRecipient({ id: 20, email: 'fail@cgiar.org' }),
      makeRecipient({ id: 21, email: 'ok@cgiar.org' }),
    ];
    userCreateQbMock.mockReturnValueOnce(makeUserQb(two));

    // Neither already reminded
    emailCreateQbMock
      .mockReturnValueOnce(makeEmailIdempotencyQb(null))
      .mockReturnValueOnce(makeEmailIdempotencyQb(null));

    managerCreateQbMock.mockReturnValueOnce(makeCountQb(5));
    settingsGetMock.mockResolvedValueOnce(
      makeSettings({ deadlineDate: '2026-06-11' }),
    );

    // First call throws, second succeeds
    enqueueMock
      .mockRejectedValueOnce(new Error('SMTP connection refused'))
      .mockResolvedValueOnce({ id: 88 });

    await service.runTick(new Date('2026-06-01T09:00:00Z'));

    // Second enqueue still called despite first failure
    expect(enqueueMock).toHaveBeenCalledTimes(2);
    expect(enqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({ toUserId: 21 }),
    );

    // Error logged for the failing recipient
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('20'),
      expect.anything(),
    );
  });

  /* ─────────────────────────────────────────────────────────────────── */
  /* Enqueue payload shape                                               */
  /* ─────────────────────────────────────────────────────────────────── */

  it('passes templateKey and metadata with centerId + mappedPercent + reminderDate to enqueue', async () => {
    // Monday, 10 days to deadline; single center, single recipient
    settingsGetMock.mockResolvedValueOnce(
      makeSettings({ deadlineDate: '2026-06-11' }),
    );
    centerFindMock.mockResolvedValueOnce([
      makeCenter({ id: 7, acronym: 'CIAT' }),
    ]);
    getSummaryMock.mockResolvedValueOnce(makeSummary({ mappedPercent: 72 }));
    userCreateQbMock.mockReturnValueOnce(
      makeUserQb([makeRecipient({ id: 99, email: 'ciat@cgiar.org' })]),
    );
    managerCreateQbMock.mockReturnValueOnce(makeCountQb(4));
    emailCreateQbMock.mockReturnValueOnce(makeEmailIdempotencyQb(null));

    await service.runTick(new Date('2026-06-01T09:00:00Z'));

    expect(enqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        toUserId: 99,
        toEmail: 'ciat@cgiar.org',
        templateKey: 'center_mapping_reminder',
        metadata: expect.objectContaining({
          centerId: 7,
          mappedPercent: 72,
          reminderDate: '2026-06-01',
        }),
      }),
    );
  });

  /* ─────────────────────────────────────────────────────────────────── */
  /* Case 13: force=true bypasses the weekly cadence (manual admin run)  */
  /*                                                                      */
  /* Mirrors Case 5 (Tuesday, 10 days out → weekly gate would skip) but  */
  /* passes { force: true }. The throttle must be ignored and the tick   */
  /* must reach the centers loop and enqueue.                            */
  /* ─────────────────────────────────────────────────────────────────── */

  it('force=true bypasses the weekly cadence and enqueues on a non-Monday far from the deadline', async () => {
    // 2026-06-02 is a Tuesday (UTC day=2), deadline 2026-06-12 → 10 days out.
    settingsGetMock.mockResolvedValueOnce(
      makeSettings({ deadlineDate: '2026-06-12' }),
    );

    const result = await service.runTick(new Date('2026-06-02T09:00:00Z'), {
      force: true,
    });

    expect(centerFindMock).toHaveBeenCalled();
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual(
      expect.objectContaining({
        ran: true,
        enqueued: 1,
        centersTotal: 1,
        centersEnqueued: 1,
        shortCircuit: null,
      }),
    );
  });

  /* ─────────────────────────────────────────────────────────────────── */
  /* Case 14: force does NOT bypass the deadline gate                    */
  /*                                                                      */
  /* A manual run still respects the hard gates: when the deadline is    */
  /* not enabled the tick short-circuits with shortCircuit and ran=false */
  /* and enqueues nothing, even with force=true.                         */
  /* ─────────────────────────────────────────────────────────────────── */

  it('force=true still short-circuits (ran=false) when the deadline is not enabled', async () => {
    settingsGetMock.mockResolvedValueOnce(
      makeSettings({ deadlineEnabled: false }),
    );

    const result = await service.runTick(new Date('2026-06-01T09:00:00Z'), {
      force: true,
    });

    expect(enqueueMock).not.toHaveBeenCalled();
    expect(centerFindMock).not.toHaveBeenCalled();
    expect(result.ran).toBe(false);
    expect(result.enqueued).toBe(0);
    expect(result.shortCircuit).toBe('deadline_disabled');
  });

  /* ─────────────────────────────────────────────────────────────────── */
  /* Case 15: weekly-cadence short-circuit summary (non-forced run)      */
  /* ─────────────────────────────────────────────────────────────────── */

  it('returns a weekly_cadence summary when a non-forced run is throttled', async () => {
    // Tuesday, 10 days out — same conditions as Case 5, asserting the result.
    settingsGetMock.mockResolvedValueOnce(
      makeSettings({ deadlineDate: '2026-06-12' }),
    );

    const result = await service.runTick(new Date('2026-06-02T09:00:00Z'));

    expect(result.ran).toBe(false);
    expect(result.shortCircuit).toBe('weekly_cadence');
    expect(enqueueMock).not.toHaveBeenCalled();
  });
});
