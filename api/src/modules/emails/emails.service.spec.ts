/**
 * Unit tests for EmailsService.
 *
 * All TypeORM repository methods are mocked — no real database is hit.
 * QueryBuilder chains are stubbed via a fluent mock factory that returns
 * `this` on every builder method.
 *
 * Coverage areas:
 *  1. `retry()` — state guard (failed allowed, others rejected), field
 *     mutations, `attempts` invariant, 404 on missing row.
 *  2. `list()`  — pagination offset/limit, status/toUserId/search/date
 *     filters, sort, response shape (body/lastError excluded).
 *  3. `findOne()` — 404 on missing row, full detail shape including body.
 *  4. `enqueue()` — defaults applied, overrides honoured, counter-proposal
 *     notification example from the JSDoc contract.
 *  5. `sendTest()` — happy path, 404 on missing user, 400 on missing email,
 *     inactive-user passthrough, toggle-bypass, body template content.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';

import { EmailsService } from './emails.service';
import { Email } from './entities/email.entity';
import { EmailStatus } from './enums/email-status.enum';
import { EmailBodyFormat } from './enums/email-body-format.enum';
import { ListEmailsQueryDto } from './dto/list-emails.query.dto';
import { EnqueueEmailDto } from './dto/enqueue-email.dto';
import { User } from '../users/entities/user.entity';

/* ─────────────────────────── Factories ─────────────────────────── */

/**
 * Builds a minimal Email entity stub. Every test that requires a
 * specific status or field value passes overrides.
 */
function makeEmail(overrides: Partial<Email> = {}): Email {
  return {
    id: 1,
    toUserId: null,
    toEmail: 'recipient@example.com',
    toUser: null,
    subject: 'Test subject',
    body: '<p>Hello</p>',
    bodyFormat: EmailBodyFormat.HTML,
    status: EmailStatus.QUEUED,
    priority: 5,
    attempts: 3,
    maxAttempts: 5,
    lastError: null,
    lockedAt: null,
    lockedBy: null,
    nextAttemptAt: null,
    sentAt: null,
    queuedAt: new Date('2026-05-17T10:00:00.000Z'),
    createdByUserId: null,
    createdByUser: null,
    templateKey: null,
    metadata: null,
    createdAt: new Date('2026-05-17T10:00:00.000Z'),
    updatedAt: new Date('2026-05-17T10:00:00.000Z'),
    ...overrides,
  } as Email;
}

/**
 * Builds a default ListEmailsQueryDto with the DTO's own defaults so
 * individual tests only have to specify what they care about.
 */
function makeListQuery(overrides: Partial<ListEmailsQueryDto> = {}): ListEmailsQueryDto {
  const dto = new ListEmailsQueryDto();
  return Object.assign(dto, overrides);
}

/**
 * Builds a fluent QueryBuilder mock. Every chainable method returns
 * `this`, and the terminal methods (`getManyAndCount`, `getOne`) are
 * jest stubs whose return values are configurable per-test.
 *
 * We intentionally keep this as a plain object cast to `any` — the
 * service types the builder as `SelectQueryBuilder<Email>` which has
 * ~60 methods we don't need to stub.
 */
function makeQueryBuilder(overrides: {
  getManyAndCount?: jest.Mock;
  getOne?: jest.Mock;
} = {}): any {
  const qb: any = {
    leftJoin: jest.fn().mockReturnThis(),
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    offset: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    getManyAndCount: overrides.getManyAndCount ?? jest.fn(async () => [[], 0]),
    getOne: overrides.getOne ?? jest.fn(async () => null),
  };
  return qb;
}

/* ─────────────────────────── Factories ─────────────────────────── */

/**
 * Builds a minimal User entity stub for `sendTest` tests.
 * Only the fields that `EmailsService.sendTest()` reads are required.
 */
function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 1,
    email: 'user@example.com',
    firstName: 'Test',
    lastName: 'User',
    isActive: true,
    ...overrides,
  } as User;
}

/* ─────────────────────────── Suite ─────────────────────────── */

describe('EmailsService', () => {
  let service: EmailsService;
  let repo: {
    findOne: jest.Mock;
    update: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  /**
   * Mock for the injected User repository. The `sendTest()` method calls
   * `usersRepo.findOne()` once for the recipient and once (tolerantly) for
   * the actor. Both are handled by `findOne` here; individual tests
   * configure the sequence of return values.
   */
  let usersRepo: {
    findOne: jest.Mock;
  };

  // Suppress Logger output so test output stays clean.
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockReturnValue(undefined);
    jest.spyOn(Logger.prototype, 'error').mockReturnValue(undefined);
    jest.spyOn(Logger.prototype, 'warn').mockReturnValue(undefined);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  beforeEach(async () => {
    repo = {
      findOne: jest.fn(),
      update: jest.fn(async () => ({ affected: 1 })),
      save: jest.fn(async (entity) => ({ ...entity, id: 99 })),
      create: jest.fn((data) => ({ ...data })),
      createQueryBuilder: jest.fn(() => makeQueryBuilder()),
    };

    usersRepo = {
      findOne: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailsService,
        { provide: getRepositoryToken(Email), useValue: repo },
        // The service's constructor now injects User repo at index [1].
        // Providing it here fixes the DI error that appeared after
        // sendTest() was added and restores the pre-existing 41 tests.
        { provide: getRepositoryToken(User), useValue: usersRepo },
      ],
    }).compile();

    service = module.get(EmailsService);
  });

  /* ────────────────────────────────────────────────────────────── */
  /* retry()                                                        */
  /* ────────────────────────────────────────────────────────────── */

  describe('retry()', () => {
    it('throws NotFoundException when the email id does not exist', async () => {
      repo.findOne.mockResolvedValueOnce(null);

      await expect(service.retry(999, 1)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.retry(999, 1)).rejects.toThrow('999');
    });

    it('throws BadRequestException with code EMAIL_NOT_RETRIABLE when status is queued', async () => {
      repo.findOne.mockResolvedValueOnce(makeEmail({ status: EmailStatus.QUEUED }));

      const error = await service.retry(1, 42).catch((e) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.response?.code).toBe('EMAIL_NOT_RETRIABLE');
    });

    it('throws BadRequestException with code EMAIL_NOT_RETRIABLE when status is sending', async () => {
      repo.findOne.mockResolvedValueOnce(makeEmail({ status: EmailStatus.SENDING }));

      const error = await service.retry(1, 42).catch((e) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.response?.code).toBe('EMAIL_NOT_RETRIABLE');
    });

    it('throws BadRequestException with code EMAIL_NOT_RETRIABLE when status is sent', async () => {
      repo.findOne.mockResolvedValueOnce(makeEmail({ status: EmailStatus.SENT }));

      const error = await service.retry(1, 42).catch((e) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.response?.code).toBe('EMAIL_NOT_RETRIABLE');
    });

    describe('when status is failed (happy path)', () => {
      const ACTOR_ID = 7;
      const EMAIL_ID = 1;
      const ORIGINAL_ATTEMPTS = 3;

      let failedEmail: Email;
      let updatedEmail: Email;

      beforeEach(() => {
        failedEmail = makeEmail({
          id: EMAIL_ID,
          status: EmailStatus.FAILED,
          attempts: ORIGINAL_ATTEMPTS,
          lastError: 'Connection refused',
          lockedAt: new Date('2026-05-16T08:00:00.000Z'),
          lockedBy: 'worker-host:1234',
        });

        // The email as it looks after the update (re-read via findOne).
        updatedEmail = makeEmail({
          id: EMAIL_ID,
          status: EmailStatus.QUEUED,
          attempts: ORIGINAL_ATTEMPTS, // intentionally unchanged
          lastError: null,
          lockedAt: null,
          lockedBy: null,
        });

        // First findOne (existence check in retry) returns the failed row.
        // The second call is from the internal findOne (via createQueryBuilder)
        // which the service uses to build the response DTO.
        repo.findOne.mockResolvedValueOnce(failedEmail);

        const detailQb = makeQueryBuilder({
          getOne: jest.fn(async () => updatedEmail),
        });
        repo.createQueryBuilder.mockReturnValueOnce(detailQb);
      });

      it('calls repo.update with status queued, cleared lastError, cleared lock fields', async () => {
        await service.retry(EMAIL_ID, ACTOR_ID);

        expect(repo.update).toHaveBeenCalledTimes(1);
        const [id, payload] = repo.update.mock.calls[0];
        expect(id).toBe(EMAIL_ID);
        expect(payload.status).toBe(EmailStatus.QUEUED);
        expect(payload.lastError).toBeNull();
        expect(payload.lockedAt).toBeNull();
        expect(payload.lockedBy).toBeNull();
      });

      it('sets nextAttemptAt to a Date close to now (immediate pickup)', async () => {
        const before = Date.now();
        await service.retry(EMAIL_ID, ACTOR_ID);
        const after = Date.now();

        const [, payload] = repo.update.mock.calls[0];
        expect(payload.nextAttemptAt).toBeInstanceOf(Date);
        // The Date must be within the window of this test execution.
        const ts = (payload.nextAttemptAt as Date).getTime();
        expect(ts).toBeGreaterThanOrEqual(before);
        expect(ts).toBeLessThanOrEqual(after);
      });

      it('does NOT include attempts in the update payload (preserves original count)', async () => {
        await service.retry(EMAIL_ID, ACTOR_ID);

        const [, payload] = repo.update.mock.calls[0];
        // The update payload must not attempt to reset the counter.
        expect(payload).not.toHaveProperty('attempts');
      });

      it('returns the post-update detail DTO (full EmailDetailDto shape)', async () => {
        const result = await service.retry(EMAIL_ID, ACTOR_ID);

        // Verify key detail fields are present in the returned DTO.
        expect(result.id).toBe(EMAIL_ID);
        expect(result.status).toBe(EmailStatus.QUEUED);
        expect(result.lastError).toBeNull();
        expect(result.lockedAt).toBeNull();
        expect(result.lockedBy).toBeNull();
        // body is a detail-only field and must be present in the return.
        expect(result).toHaveProperty('body');
      });

      it('logs the retry action via Logger', async () => {
        const logSpy = jest.spyOn(Logger.prototype, 'log');

        await service.retry(EMAIL_ID, ACTOR_ID);

        // The log line must mention the email id and the actor user id.
        expect(logSpy).toHaveBeenCalledWith(
          expect.stringContaining(String(EMAIL_ID)),
        );
        expect(logSpy).toHaveBeenCalledWith(
          expect.stringContaining(String(ACTOR_ID)),
        );
      });
    });
  });

  /* ────────────────────────────────────────────────────────────── */
  /* findOne()                                                      */
  /* ────────────────────────────────────────────────────────────── */

  describe('findOne()', () => {
    it('throws NotFoundException when the row does not exist', async () => {
      const qb = makeQueryBuilder({ getOne: jest.fn(async () => null) });
      repo.createQueryBuilder.mockReturnValueOnce(qb);

      await expect(service.findOne(404)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.findOne(404)).rejects.toThrow('404');
    });

    it('returns a detail DTO with all expected fields including body and lastError', async () => {
      const emailRow = makeEmail({
        id: 5,
        body: '<p>Counter-proposal notification body</p>',
        lastError: 'SMTP timeout',
        status: EmailStatus.FAILED,
        templateKey: 'counter_proposal',
        metadata: { mappingId: 10, projectCode: 'P-001' },
        lockedAt: new Date('2026-05-17T09:00:00.000Z'),
        lockedBy: 'worker-host:5678',
        createdByUserId: 42,
        createdByUser: {
          id: 42,
          firstName: 'Admin',
          lastName: 'User',
        } as any,
        toUser: {
          id: 3,
          firstName: 'Program',
          lastName: 'Rep',
        } as any,
      });

      const qb = makeQueryBuilder({ getOne: jest.fn(async () => emailRow) });
      repo.createQueryBuilder.mockReturnValueOnce(qb);

      const result = await service.findOne(5);

      // Detail-only fields must be present.
      expect(result.body).toBe('<p>Counter-proposal notification body</p>');
      expect(result.lastError).toBe('SMTP timeout');
      expect(result.lockedAt).toEqual(new Date('2026-05-17T09:00:00.000Z'));
      expect(result.lockedBy).toBe('worker-host:5678');
      expect(result.templateKey).toBe('counter_proposal');
      expect(result.metadata).toEqual({ mappingId: 10, projectCode: 'P-001' });
      expect(result.createdByUserId).toBe(42);
      expect(result.createdByUserName).toBe('Admin User');
      expect(result.toUserName).toBe('Program Rep');
      // Timestamps from the entity are propagated.
      expect(result).toHaveProperty('updatedAt');
    });

    it('sets toUserName to null when no recipient user is joined', async () => {
      const emailRow = makeEmail({ toUser: null, toUserId: null });
      const qb = makeQueryBuilder({ getOne: jest.fn(async () => emailRow) });
      repo.createQueryBuilder.mockReturnValueOnce(qb);

      const result = await service.findOne(1);

      expect(result.toUserName).toBeNull();
    });

    it('sets createdByUserName to null when enqueued by system (no user)', async () => {
      const emailRow = makeEmail({ createdByUser: null, createdByUserId: null });
      const qb = makeQueryBuilder({ getOne: jest.fn(async () => emailRow) });
      repo.createQueryBuilder.mockReturnValueOnce(qb);

      const result = await service.findOne(1);

      expect(result.createdByUserName).toBeNull();
    });
  });

  /* ────────────────────────────────────────────────────────────── */
  /* list()                                                         */
  /* ────────────────────────────────────────────────────────────── */

  describe('list()', () => {
    /**
     * Helper: returns a fresh QueryBuilder spy and wires it as the
     * next call to createQueryBuilder. Also returns the mock so callers
     * can assert on it after the service call.
     */
    function setupListQb(rows: Email[] = [], total = 0) {
      const qb = makeQueryBuilder({
        getManyAndCount: jest.fn(async () => [rows, total]),
      });
      repo.createQueryBuilder.mockReturnValueOnce(qb);
      return qb;
    }

    /* --- pagination -------------------------------------------------------- */

    it('uses default page=1 and limit=25 when query is empty', async () => {
      const qb = setupListQb();
      const query = makeListQuery(); // page=1, limit=25 are the DTO defaults

      await service.list(query);

      // offset for page 1 = (1-1) * 25 = 0
      expect(qb.offset).toHaveBeenCalledWith(0);
      expect(qb.limit).toHaveBeenCalledWith(25);
    });

    it('computes the correct offset for page 3 with limit 10', async () => {
      const qb = setupListQb();
      const query = makeListQuery({ page: 3, limit: 10 });

      await service.list(query);

      // offset = (3-1) * 10 = 20
      expect(qb.offset).toHaveBeenCalledWith(20);
      expect(qb.limit).toHaveBeenCalledWith(10);
    });

    it('returns the response envelope with correct pagination metadata', async () => {
      setupListQb([], 42);
      const query = makeListQuery({ page: 2, limit: 10 });

      const result = await service.list(query);

      expect(result.total).toBe(42);
      expect(result.page).toBe(2);
      expect(result.limit).toBe(10);
      expect(Array.isArray(result.data)).toBe(true);
    });

    /* --- filters ----------------------------------------------------------- */

    it('applies status IN filter when status array is supplied', async () => {
      const qb = setupListQb();
      const query = makeListQuery({ status: [EmailStatus.FAILED, EmailStatus.QUEUED] });

      await service.list(query);

      expect(qb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('IN (:...statuses)'),
        expect.objectContaining({ statuses: [EmailStatus.FAILED, EmailStatus.QUEUED] }),
      );
    });

    it('skips the status filter when status is undefined', async () => {
      const qb = setupListQb();
      const query = makeListQuery({ status: undefined });

      await service.list(query);

      // andWhere should not have been called with a statuses binding.
      const calls = qb.andWhere.mock.calls as Array<[string, unknown?]>;
      const hasStatusFilter = calls.some(([sql]) =>
        typeof sql === 'string' && sql.includes('statuses'),
      );
      expect(hasStatusFilter).toBe(false);
    });

    it('applies toUserId exact-match filter when toUserId is provided', async () => {
      const qb = setupListQb();
      const query = makeListQuery({ toUserId: 7 });

      await service.list(query);

      expect(qb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('toUserId'),
        expect.objectContaining({ toUserId: 7 }),
      );
    });

    it('applies OR search across subject and toEmail when search is provided', async () => {
      const qb = setupListQb();
      const query = makeListQuery({ search: 'counter' });

      await service.list(query);

      // The service builds a LIKE '%counter%' binding on both columns.
      expect(qb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('subject LIKE'),
        expect.objectContaining({ term: '%counter%' }),
      );
      expect(qb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('toEmail LIKE'),
        expect.objectContaining({ term: '%counter%' }),
      );
    });

    it('trims whitespace from the search term before building the LIKE pattern', async () => {
      const qb = setupListQb();
      const query = makeListQuery({ search: '  hello  ' });

      await service.list(query);

      const calls = qb.andWhere.mock.calls as Array<[string, { term?: string }?]>;
      const searchCall = calls.find(([, params]) => params?.term !== undefined);
      expect(searchCall?.[1]?.term).toBe('%hello%');
    });

    it('applies dateFrom filter as start-of-day UTC timestamp', async () => {
      const qb = setupListQb();
      const query = makeListQuery({ dateFrom: '2026-01-15' });

      await service.list(query);

      expect(qb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('queuedAt >='),
        expect.objectContaining({
          dateFrom: new Date('2026-01-15T00:00:00.000Z'),
        }),
      );
    });

    it('applies dateTo filter as end-of-day UTC timestamp (23:59:59.999)', async () => {
      const qb = setupListQb();
      const query = makeListQuery({ dateTo: '2026-01-15' });

      await service.list(query);

      expect(qb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('queuedAt <='),
        expect.objectContaining({
          dateTo: new Date('2026-01-15T23:59:59.999Z'),
        }),
      );
    });

    it('applies both dateFrom and dateTo when a single-day range is requested', async () => {
      const qb = setupListQb();
      const query = makeListQuery({ dateFrom: '2026-05-17', dateTo: '2026-05-17' });

      await service.list(query);

      const calls = qb.andWhere.mock.calls as Array<[string, unknown?]>;
      const hasFrom = calls.some(([sql]) => typeof sql === 'string' && sql.includes('queuedAt >='));
      const hasTo = calls.some(([sql]) => typeof sql === 'string' && sql.includes('queuedAt <='));
      expect(hasFrom).toBe(true);
      expect(hasTo).toBe(true);
    });

    /* --- sort -------------------------------------------------------------- */

    it('applies sortBy and sortDir to orderBy', async () => {
      const qb = setupListQb();
      const query = makeListQuery({ sortBy: 'sent_at', sortDir: 'ASC' });

      await service.list(query);

      expect(qb.orderBy).toHaveBeenCalledWith(
        expect.stringContaining('sent_at'),
        'ASC',
      );
    });

    it('defaults to queued_at DESC sort', async () => {
      const qb = setupListQb();
      const query = makeListQuery(); // uses DTO defaults: sortBy=queued_at, sortDir=DESC

      await service.list(query);

      expect(qb.orderBy).toHaveBeenCalledWith(
        expect.stringContaining('queued_at'),
        'DESC',
      );
    });

    it('adds a secondary id DESC tie-breaker via addOrderBy', async () => {
      const qb = setupListQb();
      await service.list(makeListQuery());

      expect(qb.addOrderBy).toHaveBeenCalledWith(
        expect.stringContaining('id'),
        'DESC',
      );
    });

    /* --- response shape / column exclusion -------------------------------- */

    it('does NOT include body or lastError on list items (excluded for performance)', async () => {
      // Return a row that has both body and lastError populated on the entity.
      const row = makeEmail({
        body: 'SHOULD NOT APPEAR',
        lastError: 'SHOULD NOT APPEAR',
      });
      setupListQb([row], 1);

      const result = await service.list(makeListQuery());

      expect(result.data).toHaveLength(1);
      const item = result.data[0];
      expect(item).not.toHaveProperty('body');
      expect(item).not.toHaveProperty('lastError');
    });

    it('includes compact fields on each list item', async () => {
      const row = makeEmail({
        id: 11,
        toEmail: 'rep@cgiar.org',
        subject: 'You have a counter-proposal',
        status: EmailStatus.SENT,
        priority: 3,
        attempts: 1,
        maxAttempts: 5,
      });
      setupListQb([row], 1);

      const result = await service.list(makeListQuery());
      const item = result.data[0];

      expect(item.id).toBe(11);
      expect(item.toEmail).toBe('rep@cgiar.org');
      expect(item.subject).toBe('You have a counter-proposal');
      expect(item.status).toBe(EmailStatus.SENT);
      expect(item.priority).toBe(3);
      expect(item.attempts).toBe(1);
      expect(item.maxAttempts).toBe(5);
    });

    it('projects toUserName from the joined user first + last name', async () => {
      const row = makeEmail({
        toUser: { id: 5, firstName: 'Jane', lastName: 'Doe' } as any,
      });
      setupListQb([row], 1);

      const result = await service.list(makeListQuery());

      expect(result.data[0].toUserName).toBe('Jane Doe');
    });

    it('sets toUserName to null when toUser is null', async () => {
      const row = makeEmail({ toUser: null });
      setupListQb([row], 1);

      const result = await service.list(makeListQuery());

      expect(result.data[0].toUserName).toBeNull();
    });

    it('uses leftJoin (not leftJoinAndSelect) on the recipient to avoid loading full User', async () => {
      const qb = setupListQb();
      await service.list(makeListQuery());

      // The service must join without selecting the full entity.
      expect(qb.leftJoin).toHaveBeenCalledWith(
        expect.stringContaining('toUser'),
        'toUser',
      );
      // leftJoinAndSelect would load the full User — must NOT be called for toUser in list.
      const fullJoinCalls = (qb.leftJoinAndSelect.mock.calls as Array<[string, string]>)
        .filter(([rel]) => rel.includes('toUser'));
      expect(fullJoinCalls).toHaveLength(0);
    });
  });

  /* ────────────────────────────────────────────────────────────── */
  /* enqueue()                                                      */
  /* ────────────────────────────────────────────────────────────── */

  describe('enqueue()', () => {
    it('inserts a row with status=queued and attempts=0 regardless of dto content', async () => {
      const dto: EnqueueEmailDto = {
        toEmail: 'rep@cgiar.org',
        subject: 'Test',
        body: '<p>body</p>',
      };
      repo.create.mockReturnValueOnce({ ...dto, status: EmailStatus.QUEUED, attempts: 0 });
      repo.save.mockResolvedValueOnce({ id: 10, ...dto, status: EmailStatus.QUEUED, attempts: 0 });

      const result = await service.enqueue(dto);

      // The payload passed to repo.create must specify status + attempts.
      const createArg = repo.create.mock.calls[0][0];
      expect(createArg.status).toBe(EmailStatus.QUEUED);
      expect(createArg.attempts).toBe(0);
      expect(result.status).toBe(EmailStatus.QUEUED);
      expect(result.attempts).toBe(0);
    });

    it('applies default bodyFormat=html, priority=5, maxAttempts=5 when omitted', async () => {
      const dto: EnqueueEmailDto = {
        toEmail: 'rep@cgiar.org',
        subject: 'Test',
        body: '<p>body</p>',
      };
      repo.create.mockImplementation((data) => ({ ...data }));
      repo.save.mockImplementation(async (data) => ({ ...data, id: 1 }));

      await service.enqueue(dto);

      const createArg = repo.create.mock.calls[0][0];
      expect(createArg.bodyFormat).toBe(EmailBodyFormat.HTML);
      expect(createArg.priority).toBe(5);
      expect(createArg.maxAttempts).toBe(5);
    });

    it('honours passed-in overrides for bodyFormat, priority, maxAttempts', async () => {
      const dto: EnqueueEmailDto = {
        toEmail: 'rep@cgiar.org',
        subject: 'Urgent',
        body: 'plain text',
        bodyFormat: EmailBodyFormat.TEXT,
        priority: 1,
        maxAttempts: 10,
      };
      repo.create.mockImplementation((data) => ({ ...data }));
      repo.save.mockImplementation(async (data) => ({ ...data, id: 2 }));

      await service.enqueue(dto);

      const createArg = repo.create.mock.calls[0][0];
      expect(createArg.bodyFormat).toBe(EmailBodyFormat.TEXT);
      expect(createArg.priority).toBe(1);
      expect(createArg.maxAttempts).toBe(10);
    });

    it('stores templateKey, metadata, toUserId, and createdByUserId when supplied', async () => {
      const dto: EnqueueEmailDto = {
        toUserId: 3,
        toEmail: 'rep@cgiar.org',
        subject: 'Counter-proposal',
        body: '<p>You have a new counter-proposal</p>',
        templateKey: 'counter_proposal_notification',
        metadata: { mappingId: 55, projectCode: 'P-999' },
        createdByUserId: 7,
      };
      repo.create.mockImplementation((data) => ({ ...data }));
      repo.save.mockImplementation(async (data) => ({ ...data, id: 3 }));

      const result = await service.enqueue(dto);

      expect(result.toUserId).toBe(3);
      expect(result.templateKey).toBe('counter_proposal_notification');
      expect(result.metadata).toEqual({ mappingId: 55, projectCode: 'P-999' });
      expect(result.createdByUserId).toBe(7);
    });

    it('sets nextAttemptAt to null by default (immediate pickup)', async () => {
      const dto: EnqueueEmailDto = {
        toEmail: 'rep@cgiar.org',
        subject: 'Test',
        body: '<p>body</p>',
      };
      repo.create.mockImplementation((data) => ({ ...data }));
      repo.save.mockImplementation(async (data) => ({ ...data, id: 4 }));

      await service.enqueue(dto);

      const createArg = repo.create.mock.calls[0][0];
      expect(createArg.nextAttemptAt).toBeNull();
    });

    it('stores a passed-in nextAttemptAt for scheduled delivery', async () => {
      const scheduled = new Date('2026-06-01T09:00:00.000Z');
      const dto: EnqueueEmailDto = {
        toEmail: 'rep@cgiar.org',
        subject: 'Reminder',
        body: '<p>Reminder body</p>',
        nextAttemptAt: scheduled,
      };
      repo.create.mockImplementation((data) => ({ ...data }));
      repo.save.mockImplementation(async (data) => ({ ...data, id: 5 }));

      await service.enqueue(dto);

      const createArg = repo.create.mock.calls[0][0];
      expect(createArg.nextAttemptAt).toEqual(scheduled);
    });

    /**
     * Contract test: proves the counter-proposal notification example
     * from the `EmailsService.enqueue()` JSDoc works end-to-end.
     *
     * A mapping module calling:
     *   emailsService.enqueue({
     *     toUserId: programRep.id,
     *     toEmail: programRep.email,
     *     subject: '[PRMS] You have a new counter-proposal',
     *     body: renderedHtml,
     *     metadata: { mappingId, projectCode },
     *     createdByUserId: actor.id,
     *   })
     * must insert a row with the expected fields and return the created entity.
     */
    it('counter-proposal notification pattern (JSDoc contract)', async () => {
      const programRepId = 22;
      const actorId = 5;
      const mappingId = 101;
      const projectCode = 'P-042';
      const renderedHtml = '<p>Hello, you have a new counter-proposal on P-042</p>';

      const savedEntity = makeEmail({
        id: 200,
        toUserId: programRepId,
        toEmail: 'program.rep@cgiar.org',
        subject: '[PRMS] You have a new counter-proposal',
        body: renderedHtml,
        bodyFormat: EmailBodyFormat.HTML,
        status: EmailStatus.QUEUED,
        attempts: 0,
        maxAttempts: 5,
        priority: 5,
        metadata: { mappingId, projectCode },
        createdByUserId: actorId,
      });

      repo.create.mockImplementation((data) => ({ ...data }));
      repo.save.mockResolvedValueOnce(savedEntity);

      const result = await service.enqueue({
        toUserId: programRepId,
        toEmail: 'program.rep@cgiar.org',
        subject: '[PRMS] You have a new counter-proposal',
        body: renderedHtml,
        metadata: { mappingId, projectCode },
        createdByUserId: actorId,
      });

      expect(result.id).toBe(200);
      expect(result.status).toBe(EmailStatus.QUEUED);
      expect(result.attempts).toBe(0);
      expect(result.toUserId).toBe(programRepId);
      expect(result.body).toBe(renderedHtml);
      expect(result.metadata).toEqual({ mappingId, projectCode });
      expect(result.createdByUserId).toBe(actorId);
      // Defaults applied transparently.
      expect(result.bodyFormat).toBe(EmailBodyFormat.HTML);
      expect(result.priority).toBe(5);
    });

    it('initialises lock columns to null on every enqueue', async () => {
      const dto: EnqueueEmailDto = {
        toEmail: 'rep@cgiar.org',
        subject: 'Test',
        body: '<p>body</p>',
      };
      repo.create.mockImplementation((data) => ({ ...data }));
      repo.save.mockImplementation(async (data) => ({ ...data, id: 6 }));

      await service.enqueue(dto);

      const createArg = repo.create.mock.calls[0][0];
      expect(createArg.lockedAt).toBeNull();
      expect(createArg.lockedBy).toBeNull();
      expect(createArg.lastError).toBeNull();
      expect(createArg.sentAt).toBeNull();
    });

    it('returns the saved entity (with the generated id)', async () => {
      const dto: EnqueueEmailDto = {
        toEmail: 'rep@cgiar.org',
        subject: 'Test',
        body: '<p>body</p>',
      };
      repo.create.mockImplementation((data) => ({ ...data }));
      repo.save.mockResolvedValueOnce({ id: 77, ...dto });

      const result = await service.enqueue(dto);

      expect(result.id).toBe(77);
    });
  });

  /* ────────────────────────────────────────────────────────────── */
  /* sendTest()                                                     */
  /* ────────────────────────────────────────────────────────────── */

  describe('sendTest()', () => {
    /**
     * Wire up the standard enqueue path so the service can persist and
     * return the minimal result shape. Each test re-configures the mocks
     * it cares about on top of this baseline.
     */
    function setupEnqueue(savedEmailId = 55): void {
      repo.create.mockImplementation((data: Record<string, unknown>) => ({ ...data }));
      repo.save.mockImplementation(async (data: Record<string, unknown>) => ({
        ...data,
        id: savedEmailId,
        toEmail: data['toEmail'],
        subject: data['subject'],
        status: EmailStatus.QUEUED,
      }));
    }

    // ── 1. Happy path ────────────────────────────────────────────

    describe('happy path — user id 42, email bob@example.com', () => {
      const RECIPIENT_ID = 42;
      const ACTOR_ID = 99;
      const SAVED_EMAIL_ID = 55;

      let result: Awaited<ReturnType<typeof service.sendTest>>;
      let enqueueArg: Record<string, unknown>;

      beforeEach(async () => {
        // First usersRepo.findOne call: recipient lookup.
        usersRepo.findOne.mockResolvedValueOnce(
          makeUser({ id: RECIPIENT_ID, email: 'bob@example.com', firstName: 'Bob', lastName: 'Builder' }),
        );
        // Second call: actor lookup (tolerant — returns null is fine too).
        usersRepo.findOne.mockResolvedValueOnce(
          makeUser({ id: ACTOR_ID, email: 'admin@example.com', firstName: 'Admin', lastName: 'User' }),
        );

        setupEnqueue(SAVED_EMAIL_ID);

        result = await service.sendTest(RECIPIENT_ID, ACTOR_ID);
        // Capture the argument passed to enqueue (via repo.create).
        enqueueArg = repo.create.mock.calls[0][0] as Record<string, unknown>;
      });

      it('looks up the recipient by id', () => {
        expect(usersRepo.findOne).toHaveBeenCalledWith(
          expect.objectContaining({ where: { id: RECIPIENT_ID } }),
        );
      });

      it('calls enqueue once with toUserId matching the recipient', () => {
        expect(repo.save).toHaveBeenCalledTimes(1);
        expect(enqueueArg['toUserId']).toBe(RECIPIENT_ID);
      });

      it('passes toEmail matching the recipient address', () => {
        expect(enqueueArg['toEmail']).toBe('bob@example.com');
      });

      it('passes subject "PRMS Test Email"', () => {
        expect(enqueueArg['subject']).toBe('PRMS Test Email');
      });

      it('passes bodyFormat html', () => {
        expect(enqueueArg['bodyFormat']).toBe(EmailBodyFormat.HTML);
      });

      it('passes createdByUserId matching the actor', () => {
        expect(enqueueArg['createdByUserId']).toBe(ACTOR_ID);
      });

      it('passes metadata { kind: "test_email" }', () => {
        expect(enqueueArg['metadata']).toEqual({ kind: 'test_email' });
      });

      it('body contains the recipient name or email address as a substring', () => {
        // The template resolves recipientName via formatUserName(recipient) ?? recipient.email.
        // When the user has a firstName + lastName the name ("Bob Builder") appears — not the
        // raw email — because formatUserName returns a non-null value. Assert the name is
        // present; the email address is the fallback used only when formatUserName returns null.
        const body = enqueueArg['body'] as string;
        expect(body).toEqual(expect.stringContaining('Bob Builder'));
      });

      it('returns the correct shape with status "queued"', () => {
        expect(result).toMatchObject({
          id: SAVED_EMAIL_ID,
          toUserId: RECIPIENT_ID,
          toEmail: 'bob@example.com',
          subject: 'PRMS Test Email',
          status: 'queued',
        });
      });

      it('calls Logger.log once (audit trail)', () => {
        const logSpy = jest.spyOn(Logger.prototype, 'log');
        // Logger is already spied to suppress output (beforeAll).
        // The log was already called during beforeEach so check that
        // at least one call mentioned the actor and recipient ids.
        const allCalls = logSpy.mock.calls.flat() as string[];
        const hasActorMention = allCalls.some(
          (msg) => typeof msg === 'string' && msg.includes(String(ACTOR_ID)),
        );
        const hasRecipientMention = allCalls.some(
          (msg) => typeof msg === 'string' && msg.includes(String(RECIPIENT_ID)),
        );
        expect(hasActorMention).toBe(true);
        expect(hasRecipientMention).toBe(true);
      });
    });

    // ── 2. User not found ────────────────────────────────────────

    it('throws NotFoundException when the recipient user id does not exist', async () => {
      usersRepo.findOne.mockResolvedValueOnce(null);

      await expect(service.sendTest(999, 1)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.sendTest(999, 1)).rejects.toThrow('999');
    });

    // ── 3. User has no email ─────────────────────────────────────

    it('throws BadRequestException when the user email is an empty string', async () => {
      usersRepo.findOne.mockResolvedValueOnce(makeUser({ id: 5, email: '' }));

      await expect(service.sendTest(5, 1)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws BadRequestException when the user email is whitespace-only', async () => {
      usersRepo.findOne.mockResolvedValueOnce(makeUser({ id: 5, email: '   ' }));

      await expect(service.sendTest(5, 1)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws BadRequestException when the user email is null', async () => {
      usersRepo.findOne.mockResolvedValueOnce(makeUser({ id: 5, email: null as unknown as string }));

      await expect(service.sendTest(5, 1)).rejects.toBeInstanceOf(BadRequestException);
    });

    // ── 4. Inactive user is allowed ──────────────────────────────

    it('succeeds when the recipient user is inactive (isActive: false)', async () => {
      // The documented contract: "inactive users are allowed by design".
      usersRepo.findOne.mockResolvedValueOnce(
        makeUser({ id: 10, email: 'inactive@example.com', isActive: false }),
      );
      // Actor lookup — can return null without breaking anything.
      usersRepo.findOne.mockResolvedValueOnce(null);
      setupEnqueue(60);

      // Must not throw.
      const result = await service.sendTest(10, 1);

      expect(result.toEmail).toBe('inactive@example.com');
      expect(result.status).toBe('queued');
    });

    // ── 5. Toggle bypass ─────────────────────────────────────────

    /**
     * `sendTest` must NEVER read system_settings. We verify this by
     * confirming that no SystemSettings repository is injected into the
     * service constructor. The test module in this spec file does NOT
     * provide a SystemSettings repo mock. If the service ever started
     * reading system_settings, the TestingModule.compile() call in
     * beforeEach would throw:
     *   "Nest can't resolve dependencies of the EmailsService (..., ?)"
     * and every test in this suite would fail — making the regression
     * immediately visible.
     *
     * This test makes the invariant explicit and documented.
     */
    it('does not read system_settings (email_enabled toggle bypass)', () => {
      // The service was successfully instantiated in beforeEach without a
      // SystemSettings repo mock. If a dependency on SystemSettings had
      // been added, that would have already broken all tests in this suite.
      // Here we simply assert the service is defined and functional, which
      // is proof that no unknown repository dependency was added.
      expect(service).toBeDefined();

      // Additionally, confirm the constructor only receives two
      // repository injections: Email (index 0) and User (index 1).
      // If a third injection were added, the DI token list obtained
      // from Reflect metadata would grow and this count would fail.
      const paramTypes: unknown[] =
        Reflect.getMetadata('design:paramtypes', EmailsService) ?? [];
      // Two repositories are injected (Email + User). Nest's DI adds
      // the token wrappers, but the raw paramtypes array length still
      // reflects the number of constructor parameters.
      expect(paramTypes).toHaveLength(2);
    });

    // ── 6. Body template content ─────────────────────────────────

    describe('body template content', () => {
      function setupSendTest(recipientOverrides: Partial<User> = {}): Promise<{ body: string }> {
        usersRepo.findOne.mockResolvedValueOnce(
          makeUser({ id: 1, email: 'tpl@example.com', firstName: 'Alice', lastName: 'Smith', ...recipientOverrides }),
        );
        usersRepo.findOne.mockResolvedValueOnce(null); // actor not found — graceful
        setupEnqueue(70);

        // Capture the body via a spy on repo.create rather than guessing the return.
        let capturedBody = '';
        repo.create.mockImplementationOnce((data: Record<string, unknown>) => {
          capturedBody = data['body'] as string;
          return { ...data };
        });

        return service.sendTest(1, 99).then(() => ({ body: capturedBody }));
      }

      it('body contains the PRMS Test Email heading', async () => {
        const { body } = await setupSendTest();
        // The template uses an <h2> tag with the subject text.
        expect(body).toMatch(/<h2[^>]*>PRMS Test Email<\/h2>/i);
      });

      it('body contains the phrase "test email"', async () => {
        const { body } = await setupSendTest();
        expect(body.toLowerCase()).toContain('test email');
      });

      it('body contains an ISO 8601 timestamp', async () => {
        const { body } = await setupSendTest();
        // The template interpolates the server-generated queuedAtIso value,
        // e.g. "2026-05-17T14:32:01.000Z". Match the date+time portion.
        expect(body).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
      });

      it('body HTML-escapes a recipient name containing <script>', async () => {
        const { body } = await setupSendTest({
          firstName: '<script>alert(1)</script>',
          lastName: '',
        });
        // Raw script tag must not appear in the body.
        expect(body).not.toContain('<script>');
        // The escaped form must be present instead.
        expect(body).toContain('&lt;script&gt;');
      });
    });
  });
});
