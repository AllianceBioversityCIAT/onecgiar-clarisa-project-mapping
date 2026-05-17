/**
 * Unit tests for EmailsDispatchService.
 *
 * All TypeORM DataSource methods and NotificationsService are mocked —
 * no real database, no real message broker, no HTTP traffic.
 *
 * Coverage areas:
 *  1. `sendOne()`        — outcome routing for every `SendEmailResult` status,
 *                          body-format routing, `to` array wrapping, and all
 *                          backoff / terminal-failure edge cases.
 *  2. `leaseBatch()`     — SQL primitive assertions (`FOR UPDATE SKIP LOCKED`,
 *                          `ORDER BY`, `LIMIT`), UPDATE stamp, empty-batch
 *                          short-circuit.
 *  3. `clearStuckLeases()` — SQL correctness, Logger.log behaviour based on
 *                          affected row count.
 *  4. `dispatchTick()`   — orchestration order, empty-batch short-circuit,
 *                          multi-row fan-out, error isolation per row, and
 *                          outer try/catch swallowing a failing leaseBatch.
 *
 * Mocking strategy:
 *  - `DataSource` is stubbed with two entry points used by the service:
 *      a) `createQueryBuilder()` → returns a fluent UpdateQueryBuilder mock
 *         (used by `clearStuckLeases`, `markSent`, `releaseLease`).
 *      b) `transaction(cb)` → calls `cb(manager)` immediately with a mock
 *         `manager` that has `query()` wired per-test (used by `leaseBatch`).
 *  - `NotificationsService.send` is a `jest.fn()` whose return value is
 *    set per-test.
 *  - `Logger` is silenced globally so test output stays clean.
 *
 * Style matches `emails.service.spec.ts` in this directory.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { Logger } from '@nestjs/common';

import { EmailsDispatchService } from './emails-dispatch.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailBodyFormat } from './enums/email-body-format.enum';
import { EmailStatus } from './enums/email-status.enum';

/* ─────────────────────────────────────────────────────────────────────
 * Factories / helpers
 * ──────────────────────────────────────────────────────────────────── */

/**
 * Minimal representation of a leased email row as the service works
 * with it internally. Mirror the `LeasedEmail` private interface.
 */
interface LeasedEmailStub {
  id: number;
  toEmail: string;
  subject: string;
  body: string;
  bodyFormat: EmailBodyFormat;
  attempts: number;
  maxAttempts: number;
  metadata: Record<string, unknown> | null;
}

function makeLeasedRow(overrides: Partial<LeasedEmailStub> = {}): LeasedEmailStub {
  return {
    id: 1,
    toEmail: 'rep@cgiar.org',
    subject: 'Counter-proposal',
    body: '<p>Hello</p>',
    bodyFormat: EmailBodyFormat.HTML,
    attempts: 0,
    maxAttempts: 5,
    metadata: null,
    ...overrides,
  };
}

/**
 * Build a fluent UpdateQueryBuilder mock. Every chainable method
 * returns `this`; `execute()` returns `{ affected: executedAffected }`.
 *
 * We capture the calls to `set()` and `where()` / `andWhere()` so
 * individual tests can assert on the payload passed to TypeORM.
 */
function makeUpdateQb(executedAffected = 0): any {
  const qb: any = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: executedAffected }),
  };
  return qb;
}

/**
 * Build raw DB rows that the `manager.query` SELECT returns in leaseBatch.
 * mysql2 returns BIGINT UNSIGNED as strings, so id / attempts / max_attempts
 * are string-typed here (the service coerces them via Number()).
 */
function makeDbRow(overrides: Partial<{
  id: string;
  to_email: string;
  subject: string;
  body: string;
  body_format: EmailBodyFormat;
  attempts: number;
  max_attempts: number;
  metadata: null;
}> = {}): Record<string, unknown> {
  return {
    id: '1',
    to_email: 'rep@cgiar.org',
    subject: 'Counter-proposal',
    body: '<p>Hello</p>',
    body_format: EmailBodyFormat.HTML,
    attempts: 0,
    max_attempts: 5,
    metadata: null,
    ...overrides,
  };
}

/* ─────────────────────────────────────────────────────────────────────
 * Suite
 * ──────────────────────────────────────────────────────────────────── */

describe('EmailsDispatchService', () => {
  let service: EmailsDispatchService;

  // Mock handles
  let notificationsSendMock: jest.Mock;
  let createQueryBuilderMock: jest.Mock;
  let transactionMock: jest.Mock;
  let managerQueryMock: jest.Mock;

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
    notificationsSendMock = jest.fn();
    managerQueryMock = jest.fn();

    // By default, transaction() immediately invokes the callback with
    // the mocked manager. Tests that need specific query results override
    // managerQueryMock before calling the method under test.
    transactionMock = jest.fn().mockImplementation(async (cb: (manager: any) => any) => {
      const manager = { query: managerQueryMock };
      return cb(manager);
    });

    // Default: return a fresh UpdateQueryBuilder for every createQueryBuilder call.
    createQueryBuilderMock = jest.fn().mockReturnValue(makeUpdateQb(0));

    const mockDataSource = {
      createQueryBuilder: createQueryBuilderMock,
      transaction: transactionMock,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailsDispatchService,
        {
          provide: getDataSourceToken(),
          useValue: mockDataSource,
        },
        {
          provide: NotificationsService,
          useValue: { send: notificationsSendMock },
        },
      ],
    }).compile();

    service = module.get(EmailsDispatchService);
  });

  /* ────────────────────────────────────────────────────────────────── */
  /* sendOne() — outcome routing                                        */
  /* ────────────────────────────────────────────────────────────────── */

  describe('sendOne()', () => {
    /**
     * Capture the `set()` call payload from the nth `createQueryBuilder`
     * invocation (0-indexed). For the simple single-UPDATE paths in
     * markSent / releaseLease there is exactly one createQueryBuilder call
     * per sendOne().
     */
    function captureSetPayload(callIndex = 0): Record<string, unknown> {
      const qb = createQueryBuilderMock.mock.results[callIndex]?.value;
      expect(qb).toBeDefined();
      return qb.set.mock.calls[0][0] as Record<string, unknown>;
    }

    // ── 1. published → sent ───────────────────────────────────────

    it('result=published → UPDATE sets status=sent, bumps attempts, clears lock/error, sets sent_at', async () => {
      notificationsSendMock.mockResolvedValue({
        status: 'published',
        recipientCount: 1,
        subject: 'Counter-proposal',
      });

      const row = makeLeasedRow({ attempts: 2 });
      await service.sendOne(row);

      const payload = captureSetPayload();
      expect(payload['status']).toBe(EmailStatus.SENT);
      expect(payload['attempts']).toBe(3); // row.attempts + 1
      expect(payload['lastError']).toBeNull();
      expect(payload['lockedAt']).toBeNull();
      expect(payload['lockedBy']).toBeNull();
      // sentAt is a SQL expression function — TypeORM sends it as a function wrapper
      expect(payload['sentAt']).toBeDefined();
    });

    // ── 2. dry_run → sent (same terminal path as published) ───────

    it('result=dry_run → UPDATE sets status=sent (dry_run is treated as terminal success)', async () => {
      notificationsSendMock.mockResolvedValue({
        status: 'dry_run',
        recipientCount: 1,
        subject: 'Counter-proposal',
      });

      const row = makeLeasedRow({ attempts: 1 });
      await service.sendOne(row);

      const payload = captureSetPayload();
      expect(payload['status']).toBe(EmailStatus.SENT);
      expect(payload['attempts']).toBe(2);
      expect(payload['lastError']).toBeNull();
      expect(payload['lockedAt']).toBeNull();
      expect(payload['lockedBy']).toBeNull();
    });

    // ── 3. disabled → released back to queued, attempts NOT bumped ─

    it('result=disabled → UPDATE sets status=queued, clears lock columns, does NOT bump attempts', async () => {
      notificationsSendMock.mockResolvedValue({
        status: 'disabled',
        recipientCount: 0,
        subject: 'Counter-proposal',
      });

      const row = makeLeasedRow({ attempts: 3 });
      await service.sendOne(row);

      const payload = captureSetPayload();
      expect(payload['status']).toBe(EmailStatus.QUEUED);
      expect(payload['lockedAt']).toBeNull();
      expect(payload['lockedBy']).toBeNull();
      // The service must NOT include attempts in the release payload.
      expect(payload).not.toHaveProperty('attempts');
    });

    // ── 4. throw on non-final attempt → backoff / queued ──────────

    it('throw on attempts=0,maxAttempts=5 → status=queued, attempts=1, last_error set, next_attempt_at ~NOW+2min', async () => {
      notificationsSendMock.mockRejectedValue(new Error('AMQP timeout'));

      const row = makeLeasedRow({ attempts: 0, maxAttempts: 5 });
      const before = Date.now();
      await service.sendOne(row);
      const after = Date.now();

      const payload = captureSetPayload();
      expect(payload['status']).toBe(EmailStatus.QUEUED);
      expect(payload['attempts']).toBe(1);
      expect(typeof payload['lastError']).toBe('string');
      expect(payload['lastError']).toContain('AMQP timeout');
      expect(payload['lockedAt']).toBeNull();
      expect(payload['lockedBy']).toBeNull();

      // nextAttemptAt must be approximately NOW + 2 minutes (first backoff slot).
      const nextAttemptAt = payload['nextAttemptAt'] as Date;
      expect(nextAttemptAt).toBeInstanceOf(Date);
      const delta = nextAttemptAt.getTime() - before;
      // Allow 10 s of slop around the 120_000 ms target.
      expect(delta).toBeGreaterThanOrEqual(2 * 60_000 - 10_000);
      expect(delta).toBeLessThanOrEqual(2 * 60_000 + (after - before) + 10_000);
    });

    // ── 5. throw on last allowed attempt → terminal failed ────────

    it('throw on attempts=4,maxAttempts=5 → status=failed, attempts=5, last_error set, no next_attempt_at', async () => {
      notificationsSendMock.mockRejectedValue(new Error('broker down'));

      const row = makeLeasedRow({ attempts: 4, maxAttempts: 5 });
      await service.sendOne(row);

      const payload = captureSetPayload();
      expect(payload['status']).toBe(EmailStatus.FAILED);
      expect(payload['attempts']).toBe(5);
      expect(payload['lastError']).toContain('broker down');
      expect(payload['lockedAt']).toBeNull();
      expect(payload['lockedBy']).toBeNull();
      // nextAttemptAt must be explicitly set to null on terminal failure.
      expect(payload['nextAttemptAt']).toBeNull();
    });

    // ── 6. boundary: attempts = maxAttempts - 1 is the true last attempt

    it('attempts=maxAttempts-1 triggers terminal failed (off-by-one boundary)', async () => {
      notificationsSendMock.mockRejectedValue(new Error('timeout'));

      // maxAttempts=3, attempts=2 → newAttempts=3 >= maxAttempts → failed
      const row = makeLeasedRow({ attempts: 2, maxAttempts: 3 });
      await service.sendOne(row);

      const payload = captureSetPayload();
      expect(payload['status']).toBe(EmailStatus.FAILED);
      expect(payload['attempts']).toBe(3);
    });

    it('attempts=maxAttempts-2 still triggers backoff (one before the boundary)', async () => {
      notificationsSendMock.mockRejectedValue(new Error('timeout'));

      // maxAttempts=3, attempts=1 → newAttempts=2 < maxAttempts=3 → queued+backoff
      const row = makeLeasedRow({ attempts: 1, maxAttempts: 3 });
      await service.sendOne(row);

      const payload = captureSetPayload();
      expect(payload['status']).toBe(EmailStatus.QUEUED);
      expect(payload['attempts']).toBe(2);
      expect(payload['nextAttemptAt']).toBeInstanceOf(Date);
    });

    // ── 7. HTML body format routing ───────────────────────────────

    it('bodyFormat=html → notifications.send called with { html: body, text: undefined }', async () => {
      notificationsSendMock.mockResolvedValue({ status: 'published', recipientCount: 1, subject: 'S' });

      const row = makeLeasedRow({ body: '<p>Hi</p>', bodyFormat: EmailBodyFormat.HTML });
      await service.sendOne(row);

      const sentOptions = notificationsSendMock.mock.calls[0][0];
      expect(sentOptions.html).toBe('<p>Hi</p>');
      expect(sentOptions.text).toBeUndefined();
    });

    it('bodyFormat=text → notifications.send called with { text: body, html: undefined }', async () => {
      notificationsSendMock.mockResolvedValue({ status: 'published', recipientCount: 1, subject: 'S' });

      const row = makeLeasedRow({ body: 'plain body', bodyFormat: EmailBodyFormat.TEXT });
      await service.sendOne(row);

      const sentOptions = notificationsSendMock.mock.calls[0][0];
      expect(sentOptions.text).toBe('plain body');
      expect(sentOptions.html).toBeUndefined();
    });

    // ── 8. to is always an array ──────────────────────────────────

    it('to is always wrapped in an array containing row.toEmail', async () => {
      notificationsSendMock.mockResolvedValue({ status: 'published', recipientCount: 1, subject: 'S' });

      const row = makeLeasedRow({ toEmail: 'alice@cgiar.org' });
      await service.sendOne(row);

      const sentOptions = notificationsSendMock.mock.calls[0][0];
      expect(Array.isArray(sentOptions.to)).toBe(true);
      expect(sentOptions.to).toEqual(['alice@cgiar.org']);
    });
  });

  /* ────────────────────────────────────────────────────────────────── */
  /* leaseBatch()                                                       */
  /* ────────────────────────────────────────────────────────────────── */

  describe('leaseBatch()', () => {
    /**
     * Capture the SQL string from the nth call to managerQueryMock.
     * The service issues two raw queries per batch cycle:
     *   call 0 → SELECT … FOR UPDATE SKIP LOCKED
     *   call 1 → UPDATE … SET status='sending'
     */
    function selectSql(): string {
      return managerQueryMock.mock.calls[0][0] as string;
    }
    function updateSql(): string {
      return managerQueryMock.mock.calls[1][0] as string;
    }

    // ── 9. FOR UPDATE SKIP LOCKED primitive ───────────────────────

    it('SELECT query contains FOR UPDATE SKIP LOCKED', async () => {
      managerQueryMock.mockResolvedValueOnce([makeDbRow()]); // SELECT
      managerQueryMock.mockResolvedValueOnce(undefined);       // UPDATE

      await service.leaseBatch();

      expect(selectSql()).toMatch(/FOR UPDATE SKIP LOCKED/i);
    });

    // ── 10. ORDER BY priority ASC, queued_at ASC ──────────────────

    it('SELECT query orders by priority ASC then queued_at ASC', async () => {
      managerQueryMock.mockResolvedValueOnce([makeDbRow()]);
      managerQueryMock.mockResolvedValueOnce(undefined);

      await service.leaseBatch();

      // Allow flexible whitespace between tokens.
      expect(selectSql()).toMatch(/ORDER BY\s+priority\s+ASC,\s+queued_at\s+ASC/i);
    });

    // ── 11. UPDATE stamps status=sending with WORKER_ID ──────────

    it("UPDATE sets status='sending' and locked_by with the static WORKER_ID", async () => {
      const dbRow = makeDbRow({ id: '42' });
      managerQueryMock.mockResolvedValueOnce([dbRow]);
      managerQueryMock.mockResolvedValueOnce(undefined);

      await service.leaseBatch();

      const updateParams = managerQueryMock.mock.calls[1][1] as unknown[];
      // First bound param: the new status string.
      expect(updateParams[0]).toBe(EmailStatus.SENDING);
      // Second bound param: the worker id (must be a non-empty string).
      expect(typeof updateParams[1]).toBe('string');
      expect(String(updateParams[1]).length).toBeGreaterThan(0);
      // Third bound param: the id array must contain the coerced numeric id.
      const ids = updateParams[2] as number[];
      expect(ids).toContain(42);
    });

    // ── 12. empty SELECT → no UPDATE, return [] ───────────────────

    it('returns [] and issues no UPDATE when no rows match', async () => {
      managerQueryMock.mockResolvedValueOnce([]); // SELECT returns nothing

      const result = await service.leaseBatch();

      expect(result).toEqual([]);
      // managerQueryMock should have been called exactly once (the SELECT).
      expect(managerQueryMock).toHaveBeenCalledTimes(1);
    });

    // ── 13. LIMIT 25 (BATCH_SIZE) ─────────────────────────────────

    it('SELECT query includes LIMIT 25', async () => {
      managerQueryMock.mockResolvedValueOnce([]);

      await service.leaseBatch();

      expect(selectSql()).toMatch(/LIMIT\s+\?/i);
      // The second bound parameter in the SELECT must be 25.
      const selectParams = managerQueryMock.mock.calls[0][1] as unknown[];
      expect(selectParams[1]).toBe(25);
    });

    // Extra: verify the returned shape maps DB snake_case to camelCase

    it('maps raw DB row snake_case columns to the camelCase LeasedEmail shape', async () => {
      const dbRow = makeDbRow({
        id: '7',
        to_email: 'bob@cgiar.org',
        subject: 'Sub',
        body: 'body text',
        body_format: EmailBodyFormat.TEXT,
        attempts: 2,
        max_attempts: 10,
        metadata: null,
      });
      managerQueryMock.mockResolvedValueOnce([dbRow]);
      managerQueryMock.mockResolvedValueOnce(undefined);

      const [leased] = await service.leaseBatch();

      expect(leased.id).toBe(7);
      expect(leased.toEmail).toBe('bob@cgiar.org');
      expect(leased.bodyFormat).toBe(EmailBodyFormat.TEXT);
      expect(leased.attempts).toBe(2);
      expect(leased.maxAttempts).toBe(10);
    });
  });

  /* ────────────────────────────────────────────────────────────────── */
  /* clearStuckLeases()                                                 */
  /* ────────────────────────────────────────────────────────────────── */

  describe('clearStuckLeases()', () => {
    /**
     * Capture the set() payload from the UpdateQueryBuilder that
     * clearStuckLeases() creates.
     */
    function captureSetPayload(): Record<string, unknown> {
      const qb = createQueryBuilderMock.mock.results[0]?.value;
      return qb.set.mock.calls[0][0] as Record<string, unknown>;
    }

    function captureAndWhereCall(): [string, Record<string, unknown>] {
      const qb = createQueryBuilderMock.mock.results[0]?.value;
      return qb.andWhere.mock.calls[0] as [string, Record<string, unknown>];
    }

    function captureWhereCall(): [string, Record<string, unknown>] {
      const qb = createQueryBuilderMock.mock.results[0]?.value;
      return qb.where.mock.calls[0] as [string, Record<string, unknown>];
    }

    // ── 14. SQL releases stale leases with correct predicates ──────

    it("SET payload resets to status='queued' with null lock columns", async () => {
      // Default makeUpdateQb() returns affected=0.
      await service.clearStuckLeases();

      const payload = captureSetPayload();
      expect(payload['status']).toBe(EmailStatus.QUEUED);
      expect(payload['lockedAt']).toBeNull();
      expect(payload['lockedBy']).toBeNull();
    });

    it("WHERE clause filters on status='sending'", async () => {
      await service.clearStuckLeases();

      const [sql, params] = captureWhereCall();
      expect(sql).toContain('status');
      expect(Object.values(params)).toContain(EmailStatus.SENDING);
    });

    it('AND WHERE clause filters on locked_at older than the timeout interval', async () => {
      await service.clearStuckLeases();

      const [sql] = captureAndWhereCall();
      // The service embeds the literal INTERVAL expression in the SQL string.
      expect(sql).toMatch(/locked_at/i);
      expect(sql).toMatch(/INTERVAL\s+10\s+MINUTE/i);
    });

    // ── 15. Logger.log called when affected > 0 ───────────────────

    it('calls Logger.warn when affected rows > 0', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn');
      // Wire the UpdateQueryBuilder to report 3 affected rows.
      createQueryBuilderMock.mockReturnValueOnce(makeUpdateQb(3));

      await service.clearStuckLeases();

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('3'));
    });

    // ── 16. Logger.log NOT called when 0 rows affected ────────────

    it('does not call Logger.warn for the "stuck" message when affected = 0', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn');
      warnSpy.mockClear();
      // Default makeUpdateQb() returns affected=0; no warn expected.

      await service.clearStuckLeases();

      // The warn spy must not have been called with a "stuck" / "released" message.
      const stuckWarnCalls = warnSpy.mock.calls.filter(([msg]) =>
        typeof msg === 'string' && /stuck|released/i.test(msg),
      );
      expect(stuckWarnCalls).toHaveLength(0);
    });

    // Extra: returns the affected count so the caller can log it.

    it('returns the count of released rows', async () => {
      createQueryBuilderMock.mockReturnValueOnce(makeUpdateQb(5));

      const count = await service.clearStuckLeases();

      expect(count).toBe(5);
    });

    it('returns 0 when no rows were released', async () => {
      const count = await service.clearStuckLeases();
      expect(count).toBe(0);
    });
  });

  /* ────────────────────────────────────────────────────────────────── */
  /* dispatchTick() — orchestration                                     */
  /* ────────────────────────────────────────────────────────────────── */

  describe('dispatchTick()', () => {
    /**
     * Spy on the three instance methods so we can verify call order and
     * arguments without re-testing the implementation of each method.
     * Each spy is re-configured per test; the default resolves cleanly.
     */
    let clearSpy: jest.SpyInstance;
    let leaseSpy: jest.SpyInstance;
    let sendOneSpy: jest.SpyInstance;

    beforeEach(() => {
      clearSpy = jest.spyOn(service, 'clearStuckLeases').mockResolvedValue(0);
      leaseSpy = jest.spyOn(service, 'leaseBatch').mockResolvedValue([]);
      sendOneSpy = jest.spyOn(service, 'sendOne').mockResolvedValue(undefined);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    // ── 17. call order: clearStuckLeases → leaseBatch → sendOne ───

    it('calls clearStuckLeases before leaseBatch', async () => {
      const callOrder: string[] = [];
      clearSpy.mockImplementation(async () => { callOrder.push('clear'); return 0; });
      leaseSpy.mockImplementation(async () => { callOrder.push('lease'); return []; });

      await service.dispatchTick();

      expect(callOrder.indexOf('clear')).toBeLessThan(callOrder.indexOf('lease'));
    });

    it('calls leaseBatch before sendOne when there are rows', async () => {
      const callOrder: string[] = [];
      const row = makeLeasedRow();
      leaseSpy.mockImplementation(async () => { callOrder.push('lease'); return [row]; });
      sendOneSpy.mockImplementation(async () => { callOrder.push('send'); });

      await service.dispatchTick();

      expect(callOrder.indexOf('lease')).toBeLessThan(callOrder.indexOf('send'));
    });

    // ── 18. empty batch → no sendOne calls ────────────────────────

    it('does not call sendOne when leaseBatch returns []', async () => {
      leaseSpy.mockResolvedValue([]);

      await service.dispatchTick();

      expect(sendOneSpy).not.toHaveBeenCalled();
    });

    // ── 19. multiple rows → sendOne per row ───────────────────────

    it('calls sendOne once for each leased row', async () => {
      const rows = [makeLeasedRow({ id: 1 }), makeLeasedRow({ id: 2 }), makeLeasedRow({ id: 3 })];
      leaseSpy.mockResolvedValue(rows);

      await service.dispatchTick();

      expect(sendOneSpy).toHaveBeenCalledTimes(3);
      expect(sendOneSpy).toHaveBeenCalledWith(rows[0]);
      expect(sendOneSpy).toHaveBeenCalledWith(rows[1]);
      expect(sendOneSpy).toHaveBeenCalledWith(rows[2]);
    });

    // ── 20. throw in sendOne does NOT crash the tick ───────────────
    //
    // The dispatchTick() loop wraps each sendOne() call in its own
    // try/catch so an unexpected throw on one row doesn't strand the
    // rest of the batch in `sending` (they'd only be reclaimed after
    // the 10-minute lease timeout).

    it('tick does not reject when sendOne throws (per-row catch swallows it)', async () => {
      const rows = [makeLeasedRow({ id: 10 }), makeLeasedRow({ id: 11 }), makeLeasedRow({ id: 12 })];
      leaseSpy.mockResolvedValue(rows);

      // All rows throw to exercise the per-row catch path.
      sendOneSpy.mockRejectedValue(new Error('deliberate failure'));

      // The tick itself must not throw regardless of sendOne failures.
      await expect(service.dispatchTick()).resolves.toBeUndefined();
    });

    it('continues processing remaining rows after one sendOne throws (per-row isolation)', async () => {
      const rows = [makeLeasedRow({ id: 10 }), makeLeasedRow({ id: 11 }), makeLeasedRow({ id: 12 })];
      leaseSpy.mockResolvedValue(rows);

      sendOneSpy.mockImplementation(async (row: { id: number }) => {
        if (row.id === 11) throw new Error('deliberate failure');
      });

      await service.dispatchTick();

      // All three rows are attempted: row 11's throw is isolated to its
      // own iteration and does not skip row 12.
      expect(sendOneSpy).toHaveBeenCalledTimes(3);
    });

    it('logs an error when an individual sendOne throws but continues the loop', async () => {
      const errorSpy = jest.spyOn(Logger.prototype, 'error');
      errorSpy.mockClear();
      const rows = [makeLeasedRow({ id: 10 }), makeLeasedRow({ id: 11 })];
      leaseSpy.mockResolvedValue(rows);

      sendOneSpy.mockImplementation(async (row: { id: number }) => {
        if (row.id === 11) throw new Error('boom on 11');
      });

      await service.dispatchTick();

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Unexpected error processing email 11'),
        expect.anything(),
      );
    });

    // ── 21. throw in leaseBatch does NOT crash the tick ───────────

    it('swallows an error thrown by leaseBatch and does not rethrow', async () => {
      leaseSpy.mockRejectedValue(new Error('DB connection lost'));

      await expect(service.dispatchTick()).resolves.toBeUndefined();
    });

    it('logs the error when leaseBatch throws', async () => {
      const errorSpy = jest.spyOn(Logger.prototype, 'error');
      errorSpy.mockClear();
      leaseSpy.mockRejectedValue(new Error('DB connection lost'));

      await service.dispatchTick();

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('DB connection lost'),
        expect.anything(),
      );
    });

    // Extra: clearStuckLeases result > 0 triggers a warn log.

    it('emits a warn log when clearStuckLeases releases > 0 rows', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn');
      warnSpy.mockClear();
      clearSpy.mockResolvedValue(3);

      await service.dispatchTick();

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('3'));
    });
  });

  /* ────────────────────────────────────────────────────────────────── */
  /* Backoff schedule — index mapping                                   */
  /* ────────────────────────────────────────────────────────────────── */

  /**
   * These tests verify the BACKOFF_MINUTES schedule is applied at the
   * correct array index for each attempt number. The schedule is:
   *   [2, 5, 15, 60, 240]  (0-indexed by attempts-1)
   *
   * attempt 0 fails → newAttempts=1 → index=0 → 2 min
   * attempt 1 fails → newAttempts=2 → index=1 → 5 min
   * attempt 3 fails → newAttempts=4 → index=3 → 60 min
   * attempt 99 fails → newAttempts=100 → index clamped to 4 → 240 min
   */
  describe('backoff schedule', () => {
    const cases: Array<{ attempts: number; maxAttempts: number; expectedMinutes: number }> = [
      { attempts: 0, maxAttempts: 10, expectedMinutes: 2 },
      { attempts: 1, maxAttempts: 10, expectedMinutes: 5 },
      { attempts: 2, maxAttempts: 10, expectedMinutes: 15 },
      { attempts: 3, maxAttempts: 10, expectedMinutes: 60 },
      { attempts: 4, maxAttempts: 10, expectedMinutes: 240 },
      // Attempts beyond the array length should reuse the last entry (240).
      { attempts: 9, maxAttempts: 20, expectedMinutes: 240 },
    ];

    it.each(cases)(
      'attempts=$attempts → next_attempt_at ≈ now + $expectedMinutes min',
      async ({ attempts, maxAttempts, expectedMinutes }) => {
        notificationsSendMock.mockRejectedValue(new Error('fail'));
        createQueryBuilderMock.mockReturnValue(makeUpdateQb(0));

        const row = makeLeasedRow({ attempts, maxAttempts });
        const before = Date.now();
        await service.sendOne(row);

        const qb = createQueryBuilderMock.mock.results[0]?.value;
        const payload = qb.set.mock.calls[0][0] as Record<string, unknown>;

        const nextAttemptAt = payload['nextAttemptAt'] as Date;
        expect(nextAttemptAt).toBeInstanceOf(Date);
        const deltaMs = nextAttemptAt.getTime() - before;
        const expectedMs = expectedMinutes * 60_000;
        // Allow ±10 s tolerance around the expected backoff.
        expect(deltaMs).toBeGreaterThanOrEqual(expectedMs - 10_000);
        expect(deltaMs).toBeLessThanOrEqual(expectedMs + 10_000);
      },
    );
  });
});
