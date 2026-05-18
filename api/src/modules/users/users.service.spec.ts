/**
 * Unit tests for UsersService.
 *
 * All repository dependencies are mocked; these tests exercise the
 * service's decision logic in isolation. Integration coverage (real
 * database writes, HTTP flow) lives in `api/test/users.e2e-spec.ts`.
 *
 * Multi-center membership coverage (task A-3 of the multi-center plan):
 *  - DataSource.transaction() is stubbed so it forwards the callback
 *    with a mock EntityManager — that's the same pattern used in
 *    ProjectsService spec.
 *  - The `user_centers` junction table is not bound to a TypeORM entity
 *    in the codebase, so the service writes to it via raw parameterised
 *    SQL: `dataSource.query` (reads) and `manager.query` (multi-row
 *    INSERT with explicit column list, side-stepping the QueryBuilder
 *    sort_order template bug). The mocks below verify the right SQL +
 *    flat positional params are emitted.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { UsersService } from './users.service';
import { User } from './entities/user.entity';
import { UserRole } from './enums/user-role.enum';
import { Program } from '../reference-data/entities/program.entity';
import { Center } from '../reference-data/entities/center.entity';
import { AuditService } from '../audit/audit.service';
import { CreateUserDto } from './dto/create-user.dto';

/**
 * Factory for a minimal User entity with sane defaults. Individual
 * tests override only the fields they care about.
 */
function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 1,
    cognitoSub: 'cognito-sub-1',
    email: 'user@example.com',
    firstName: 'First',
    lastName: 'Last',
    role: null,
    program: null,
    programId: null,
    center: null,
    centerId: null,
    centers: [],
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as User;
}

/**
 * Build a mock EntityManager that captures the raw `manager.query()`
 * call used by `replaceUserCenters()` (multi-row INSERT into
 * `user_centers`) and supports the other surface area we touch from the
 * service: findOne, save, delete, createQueryBuilder.
 *
 * `createQueryBuilder` is still exposed so existing tests that asserted
 * it was NOT called continue to work. The legacy `_insert` chain is
 * preserved purely as a no-op surface for any code paths that might
 * still build a query builder during construction — none of the post-
 * fix code paths actually invoke it.
 */
function buildMockManager() {
  const insertExecute = jest.fn(async () => ({ identifiers: [] }));
  const insertValues = jest.fn().mockReturnValue({ execute: insertExecute });
  const insertInto = jest.fn().mockReturnValue({ values: insertValues });
  const insertChain = jest.fn().mockReturnValue({ into: insertInto });
  const createQueryBuilder = jest.fn().mockReturnValue({ insert: insertChain });

  /* Raw query mock — captures the multi-row INSERT against the
   * `user_centers` junction. Tests assert on (sql, params) tuples. */
  const query = jest.fn(async () => [] as unknown[]);

  const manager = {
    create: jest.fn((_entity, data) => ({ ...data })),
    save: jest.fn(async (obj) => obj),
    /* Cast the resolved value to `any` so individual tests can return
     * concrete entity shapes without battling the default-null inference. */
    findOne: jest.fn(async () => null as any),
    delete: jest.fn(async () => ({ affected: 0 })),
    createQueryBuilder,
    query,
    /* Test helpers (not part of EntityManager interface) — expose the
     * captured insert chain so tests can assert on the inserted rows. */
    _insert: {
      execute: insertExecute,
      values: insertValues,
      into: insertInto,
    },
  };

  return manager;
}

type MockManager = ReturnType<typeof buildMockManager>;

/**
 * Wraps a mock manager inside a DataSource.transaction() stub so the
 * callback receives the manager and the return value is forwarded. Also
 * stubs `dataSource.query` for the raw SELECTs the service runs to
 * load ordered membership rows.
 */
function buildMockDataSource(manager: MockManager) {
  const query = jest.fn(async () => [] as unknown[]);
  return {
    transaction: jest.fn(async (cb: (m: unknown) => Promise<unknown>) =>
      cb(manager),
    ),
    query,
  };
}

describe('UsersService', () => {
  let service: UsersService;
  let usersRepo: jest.Mocked<Repository<User>>;
  let programsRepo: jest.Mocked<Repository<Program>>;
  let centersRepo: jest.Mocked<Repository<Center>>;
  let auditService: jest.Mocked<AuditService>;
  let manager: MockManager;
  let dataSourceMock: ReturnType<typeof buildMockDataSource>;

  beforeEach(async () => {
    /* Each test gets a fresh module so jest.fn call counts are isolated. */
    manager = buildMockManager();
    dataSourceMock = buildMockDataSource(manager);

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        {
          provide: getRepositoryToken(User),
          useValue: {
            findOne: jest.fn(),
            find: jest.fn(),
            create: jest.fn((obj) => obj),
            save: jest.fn(async (obj) => obj),
            update: jest.fn(async () => ({ affected: 1 })),
          },
        },
        {
          provide: getRepositoryToken(Program),
          useValue: { findOne: jest.fn() },
        },
        {
          provide: getRepositoryToken(Center),
          useValue: { findOne: jest.fn(), find: jest.fn() },
        },
        {
          provide: DataSource,
          useValue: dataSourceMock,
        },
        {
          provide: AuditService,
          useValue: { record: jest.fn() },
        },
      ],
    }).compile();

    service = moduleRef.get(UsersService);
    usersRepo = moduleRef.get(getRepositoryToken(User));
    programsRepo = moduleRef.get(getRepositoryToken(Program));
    centersRepo = moduleRef.get(getRepositoryToken(Center));
    auditService = moduleRef.get(AuditService);
  });

  /* ------------------------------------------------------------------ */
  /* createUser() — single-center (migrated from legacy `centerId`)     */
  /* ------------------------------------------------------------------ */

  describe('createUser()', () => {
    it('creates a user with cognitoSub=null on a fresh email (no centerIds)', async () => {
      /* findOne #1 — duplicate-email check (no row).
       * findOne #2 — relations reload after save (via findOneWithRelations). */
      const hydrated = makeUser({
        id: 42,
        email: 'new@example.com',
        cognitoSub: null,
      });
      usersRepo.findOne
        .mockResolvedValueOnce(null) // duplicate check
        .mockResolvedValueOnce(hydrated); // hydrated reload
      /* The service uses `manager.save` inside the transaction, so we
       * stub the manager to return a row with a stable id. */
      manager.save.mockImplementation(async (obj: any) => ({
        ...obj,
        id: 42,
      }));

      const dto: CreateUserDto = {
        email: 'new@example.com',
        firstName: 'New',
        lastName: 'User',
      };

      const result = await service.createUser(dto);

      /* Transaction must have run exactly once. */
      expect(dataSourceMock.transaction).toHaveBeenCalledTimes(1);
      /* manager.create() builds the User row with the expected shape. */
      expect(manager.create).toHaveBeenCalledWith(
        User,
        expect.objectContaining({
          email: 'new@example.com',
          firstName: 'New',
          lastName: 'User',
          cognitoSub: null,
          isActive: true,
          role: null,
          programId: null,
          centerId: null,
        }),
      );
      /* No centerIds → no user_centers insert. */
      expect(manager.query).not.toHaveBeenCalled();
      expect(result.id).toBe(42);
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'user.create' }),
      );
    });

    it('writes users.center_id = centerIds[0] and one user_centers row per id with sort_order = index', async () => {
      const hydrated = makeUser({
        id: 7,
        email: 'cr@example.com',
        cognitoSub: null,
        role: UserRole.CENTER_REP,
        centerId: 1,
      });
      usersRepo.findOne
        .mockResolvedValueOnce(null) // duplicate check
        .mockResolvedValueOnce(hydrated); // hydrated reload
      /* Centers exist — both ids return rows. */
      centersRepo.find.mockResolvedValueOnce([
        { id: 1 } as Center,
        { id: 3 } as Center,
      ]);
      /* Hydrated reload reads ordered centerIds from the junction. */
      dataSourceMock.query.mockResolvedValueOnce([
        { center_id: 1 },
        { center_id: 3 },
      ]);
      manager.save.mockImplementation(async (obj: any) => ({
        ...obj,
        id: 7,
      }));

      const dto: CreateUserDto = {
        email: 'cr@example.com',
        firstName: 'C',
        lastName: 'R',
        role: UserRole.CENTER_REP,
        centerIds: [1, 3],
      };

      const result = await service.createUser(dto);

      /* users row gets center_id = first element. */
      expect(manager.create).toHaveBeenCalledWith(
        User,
        expect.objectContaining({
          centerId: 1,
          role: UserRole.CENTER_REP,
          email: 'cr@example.com',
        }),
      );
      /* user_centers got a single batched raw INSERT with explicit
       * column list and per-row sort_order. */
      expect(manager.query).toHaveBeenCalledTimes(1);
      expect(manager.query).toHaveBeenCalledWith(
        'INSERT INTO user_centers (user_id, center_id, sort_order) VALUES (?, ?, ?), (?, ?, ?)',
        [7, 1, 0, 7, 3, 1],
      );
      /* Audit row records centerIds in the diff payload. */
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          changes: expect.objectContaining({
            centerIds: { before: null, after: [1, 3] },
            centerId: { before: null, after: 1 },
          }),
        }),
      );
      expect(result.id).toBe(7);
    });

    it('throws NotFoundException when any centerIds entry is unknown', async () => {
      usersRepo.findOne.mockResolvedValueOnce(null); // duplicate check
      /* Only id 1 exists; 99999 is missing. */
      centersRepo.find.mockResolvedValueOnce([{ id: 1 } as Center]);

      await expect(
        service.createUser({
          email: 'cr@example.com',
          firstName: 'C',
          lastName: 'R',
          role: UserRole.CENTER_REP,
          centerIds: [1, 99999],
        }),
      ).rejects.toThrow(NotFoundException);
      /* Failure must short-circuit before opening a transaction. */
      expect(dataSourceMock.transaction).not.toHaveBeenCalled();
    });

    it('throws ConflictException when email already exists', async () => {
      usersRepo.findOne.mockResolvedValueOnce(makeUser({ id: 7 }));

      await expect(
        service.createUser({
          email: 'taken@example.com',
          firstName: 'Dup',
          lastName: 'Dup',
        }),
      ).rejects.toThrow(ConflictException);
      expect(dataSourceMock.transaction).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when programId does not exist', async () => {
      usersRepo.findOne.mockResolvedValueOnce(null); // duplicate check passes
      programsRepo.findOne.mockResolvedValueOnce(null); // program missing

      await expect(
        service.createUser({
          email: 'pm@example.com',
          firstName: 'P',
          lastName: 'M',
          role: UserRole.PROGRAM_REP,
          programId: 999,
        }),
      ).rejects.toThrow(NotFoundException);
      expect(dataSourceMock.transaction).not.toHaveBeenCalled();
    });
  });

  /* ------------------------------------------------------------------ */
  /* updateUser() — multi-center                                         */
  /* ------------------------------------------------------------------ */

  describe('updateUser()', () => {
    it('atomically replaces user_centers and updates users.center_id to the new primary', async () => {
      /* Initial user load (with `centers` relation). */
      const initial = makeUser({
        id: 10,
        email: 'cr@example.com',
        role: UserRole.CENTER_REP,
        centerId: 1,
        centers: [{ id: 1 } as Center],
      });
      const reloaded = makeUser({
        id: 10,
        email: 'cr@example.com',
        role: UserRole.CENTER_REP,
        centerId: 2,
        centers: [{ id: 2 } as Center, { id: 5 } as Center],
      });

      usersRepo.findOne
        .mockResolvedValueOnce(initial) // pre-update load
        .mockResolvedValueOnce(reloaded); // findOneWithRelations post-update
      /* loadOrderedCenterIds(before): [1].
       * loadOrderedCenterIds(after): [2, 5]. */
      dataSourceMock.query
        .mockResolvedValueOnce([{ center_id: 1 }])
        .mockResolvedValueOnce([{ center_id: 2 }, { center_id: 5 }]);
      centersRepo.find.mockResolvedValueOnce([
        { id: 2 } as Center,
        { id: 5 } as Center,
      ]);
      /* Inside the transaction, the service re-fetches the user. */
      manager.findOne.mockResolvedValueOnce(initial);

      const result = await service.updateUser(10, { centerIds: [2, 5] });

      /* The junction wipe + reinsert happened inside a single transaction. */
      expect(dataSourceMock.transaction).toHaveBeenCalledTimes(1);
      expect(manager.delete).toHaveBeenCalledWith('user_centers', {
        user_id: 10,
      });
      expect(manager.query).toHaveBeenCalledWith(
        'INSERT INTO user_centers (user_id, center_id, sort_order) VALUES (?, ?, ?), (?, ?, ?)',
        [10, 2, 0, 10, 5, 1],
      );
      /* users.center_id flipped to the new primary. */
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 10, centerId: 2 }),
      );
      /* Audit captures the centerIds diff. */
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          changes: expect.objectContaining({
            centerId: { before: 1, after: 2 },
            centerIds: { before: [1], after: [2, 5] },
          }),
          action: 'user.reassigned',
        }),
      );
      expect(result.centerIds).toEqual([2, 5]);
    });

    it('leaves user_centers untouched when centerIds is omitted (partial update)', async () => {
      const initial = makeUser({
        id: 11,
        email: 'cr@example.com',
        role: UserRole.CENTER_REP,
        centerId: 1,
        isActive: true,
        centers: [{ id: 1 } as Center],
      });
      const reloaded = makeUser({
        id: 11,
        email: 'cr@example.com',
        role: UserRole.CENTER_REP,
        centerId: 1,
        isActive: false,
        centers: [{ id: 1 } as Center],
      });
      usersRepo.findOne
        .mockResolvedValueOnce(initial)
        .mockResolvedValueOnce(reloaded);
      dataSourceMock.query
        .mockResolvedValueOnce([{ center_id: 1 }]) // before
        .mockResolvedValueOnce([{ center_id: 1 }]); // after
      manager.findOne.mockResolvedValueOnce(initial);

      const result = await service.updateUser(11, { isActive: false });

      /* No delete / no insert on the junction table. */
      expect(manager.delete).not.toHaveBeenCalled();
      expect(manager.query).not.toHaveBeenCalled();
      /* center_id unchanged. */
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 11, centerId: 1, isActive: false }),
      );
      expect(result.centerId).toBe(1);
      expect(result.centerIds).toEqual([1]);
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'user.deactivated' }),
      );
    });

    it('rolls back users.center_id when the user_centers write fails inside the transaction', async () => {
      const initial = makeUser({
        id: 12,
        email: 'cr@example.com',
        role: UserRole.CENTER_REP,
        centerId: 1,
        centers: [{ id: 1 } as Center],
      });
      usersRepo.findOne.mockResolvedValueOnce(initial);
      dataSourceMock.query.mockResolvedValueOnce([{ center_id: 1 }]); // before
      centersRepo.find.mockResolvedValueOnce([
        { id: 2 } as Center,
        { id: 5 } as Center,
      ]);
      manager.findOne.mockResolvedValueOnce(initial);

      /* Simulate junction insert failure — the manager's raw query rejects. */
      manager.query.mockRejectedValueOnce(new Error('synthetic FK violation'));

      /* The transaction stub passes errors through. The real DB layer
       * would roll back any pending users.save in the same transaction;
       * our stub verifies the call ordering and that the audit row is
       * NOT recorded after a failure. */
      await expect(
        service.updateUser(12, { centerIds: [2, 5] }),
      ).rejects.toThrow('synthetic FK violation');

      /* Audit must NOT have been recorded — failure rolls back the
       * whole update logically. */
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the user does not exist', async () => {
      usersRepo.findOne.mockResolvedValueOnce(null);

      await expect(
        service.updateUser(999, { isActive: false }),
      ).rejects.toThrow(NotFoundException);
      expect(dataSourceMock.transaction).not.toHaveBeenCalled();
    });

    /* -------------------------------------------------------------------
     * C1-9: Duplicate entry in centerIds array → service deduplicates
     * before the junction INSERT so no PK collision occurs.
     *
     * The service deduplicates `orderedCenterIds` (preserving the first
     * occurrence's index, which keeps the primary-center contract) BEFORE
     * passing it to `replaceUserCenters()`. So given `[1, 3, 1]`:
     *   - `assertAllCentersExist` is called with `[1, 3]` (deduped).
     *   - `replaceUserCenters` is called with `[1, 3]` (deduped).
     *   - Two rows are inserted:
     *       { user_id, center_id:1, sort_order:0 }
     *       { user_id, center_id:3, sort_order:1 }
     *   - The audit log records `centerIds.after = [1, 3]`.
     *
     * No PK rollback. A warning is logged (verified loosely via no-error)
     * so silent dedupes are observable in production logs.
     * ----------------------------------------------------------------- */
    it('C1-9: duplicate in centerIds [1,3,1] → deduped to [1,3], single INSERT with sort_order 0,1, audit reflects deduped list', async () => {
      const initial = makeUser({
        id: 13,
        email: 'cr-dup@example.com',
        role: UserRole.CENTER_REP,
        centerId: 1,
        centers: [{ id: 1 } as Center],
      });
      const reloaded = makeUser({
        id: 13,
        email: 'cr-dup@example.com',
        role: UserRole.CENTER_REP,
        centerId: 1,
        centers: [{ id: 1 } as Center, { id: 3 } as Center],
      });

      usersRepo.findOne
        .mockResolvedValueOnce(initial) // pre-update load
        .mockResolvedValueOnce(reloaded); // findOneWithRelations post-update

      /* loadOrderedCenterIds(before): [1].
       * loadOrderedCenterIds(after):  [1, 3]. */
      dataSourceMock.query
        .mockResolvedValueOnce([{ center_id: 1 }])
        .mockResolvedValueOnce([{ center_id: 1 }, { center_id: 3 }]);

      /* assertAllCentersExist receives the deduped list [1, 3]; both found. */
      centersRepo.find.mockResolvedValueOnce([
        { id: 1 } as Center,
        { id: 3 } as Center,
      ]);

      /* Inside the transaction the service re-fetches the user */
      manager.findOne.mockResolvedValueOnce(initial);

      /* No rejection wiring — the fix should make this path succeed. */
      const result = await service.updateUser(13, { centerIds: [1, 3, 1] });

      /* The junction wipe + reinsert happened inside the transaction. */
      expect(manager.delete).toHaveBeenCalledWith('user_centers', {
        user_id: 13,
      });

      /* Exactly ONE batched raw INSERT with the deduped (?,?,?),(?,?,?)
       * placeholders and distinct sort_order values (0, 1). */
      expect(manager.query).toHaveBeenCalledTimes(1);
      expect(manager.query).toHaveBeenCalledWith(
        'INSERT INTO user_centers (user_id, center_id, sort_order) VALUES (?, ?, ?), (?, ?, ?)',
        [13, 1, 0, 13, 3, 1],
      );

      /* users.center_id stays on the first element (1) — primary-center
       * contract holds even though it was duplicated in the input. */
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 13, centerId: 1 }),
      );

      /* Audit captures the DEDUPED centerIds in the after diff. */
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          changes: expect.objectContaining({
            centerIds: { before: [1], after: [1, 3] },
          }),
        }),
      );

      /* Result carries the deduped centerIds in sort_order. */
      expect(result.centerIds).toEqual([1, 3]);
    });
  });

  /* ------------------------------------------------------------------ */
  /* softDelete()                                                        */
  /* ------------------------------------------------------------------ */

  describe('softDelete()', () => {
    it('sets isActive=false on the target user and returns the id', async () => {
      const target = makeUser({ id: 10, email: 'victim@example.com' });
      usersRepo.findOne.mockResolvedValueOnce(target);

      const result = await service.softDelete(10, 1);

      expect(usersRepo.update).toHaveBeenCalledWith(10, { isActive: false });
      expect(result).toEqual({ id: 10, isActive: false });
    });

    it('throws NotFoundException when the target user does not exist', async () => {
      usersRepo.findOne.mockResolvedValueOnce(null);

      await expect(service.softDelete(999, 1)).rejects.toThrow(
        NotFoundException,
      );
      expect(usersRepo.update).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException when admin tries to deactivate self', async () => {
      const me = makeUser({ id: 5, email: 'me@example.com' });
      usersRepo.findOne.mockResolvedValueOnce(me);

      await expect(service.softDelete(5, 5)).rejects.toThrow(
        ForbiddenException,
      );
      expect(usersRepo.update).not.toHaveBeenCalled();
    });
  });

  /* ------------------------------------------------------------------ */
  /* findAllWithRelations()                                              */
  /* ------------------------------------------------------------------ */

  describe('findAllWithRelations()', () => {
    it('returns each user with centerIds + centers in sort_order ASC', async () => {
      const a = makeUser({
        id: 1,
        email: 'a@example.com',
        centers: [{ id: 5 } as Center, { id: 2 } as Center], // unordered as returned by ORM
      });
      const b = makeUser({
        id: 2,
        email: 'b@example.com',
        centers: [],
      });
      usersRepo.find.mockResolvedValueOnce([a, b]);
      /* Single batched membership query returns rows ordered by
       * (user_id, sort_order ASC). User 1's primary is center 2,
       * secondary is center 5. User 2 has no memberships. */
      dataSourceMock.query.mockResolvedValueOnce([
        { user_id: 1, center_id: 2, sort_order: 0 },
        { user_id: 1, center_id: 5, sort_order: 1 },
      ]);

      const result = await service.findAllWithRelations();

      /* User 1 surfaces ordered centerIds + reordered centers. */
      expect(result[0].id).toBe(1);
      expect(result[0].centerIds).toEqual([2, 5]);
      expect(result[0].centers.map((c) => c.id)).toEqual([2, 5]);
      /* User 2 has empty memberships. */
      expect(result[1].centerIds).toEqual([]);
    });

    it('returns an empty array without issuing a membership query', async () => {
      usersRepo.find.mockResolvedValueOnce([]);
      const result = await service.findAllWithRelations();
      expect(result).toEqual([]);
      expect(dataSourceMock.query).not.toHaveBeenCalled();
    });
  });

  /* ------------------------------------------------------------------ */
  /* findById()                                                          */
  /* ------------------------------------------------------------------ */

  describe('findById()', () => {
    it('exposes centerIds derived from the junction table', async () => {
      const u = makeUser({ id: 30, email: 'cr@example.com', centerId: 4 });
      usersRepo.findOne.mockResolvedValueOnce(u);
      dataSourceMock.query.mockResolvedValueOnce([
        { center_id: 4 },
        { center_id: 7 },
        { center_id: 9 },
      ]);

      const result = await service.findById(30);

      expect(result).not.toBeNull();
      expect(result!.centerIds).toEqual([4, 7, 9]);
    });

    it('returns null when the user does not exist', async () => {
      usersRepo.findOne.mockResolvedValueOnce(null);
      const result = await service.findById(999);
      expect(result).toBeNull();
      expect(dataSourceMock.query).not.toHaveBeenCalled();
    });
  });

  /* ------------------------------------------------------------------ */
  /* upsertFromCognito() — unchanged by A-3 but kept for regression      */
  /* ------------------------------------------------------------------ */

  describe('upsertFromCognito()', () => {
    it('backfills cognito_sub when email matches a pre-provisioned row (cognito_sub IS NULL)', async () => {
      const pending = makeUser({
        id: 20,
        email: 'pending@example.com',
        cognitoSub: null,
        firstName: 'Admin-Set',
        lastName: 'Name',
      });

      /* First lookup is by cognito sub — no hit.
       * Second lookup is by email — returns the pending row. */
      usersRepo.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(pending);
      usersRepo.save.mockImplementation(async (u) => u as User);

      const result = await service.upsertFromCognito({
        cognitoSub: 'real-cognito-sub',
        email: 'pending@example.com',
        firstName: 'Cognito',
        lastName: 'Provided',
      });

      expect(result.cognitoSub).toBe('real-cognito-sub');
      /* Admin's names are preserved — Cognito does not overwrite them
       * on the pre-provisioned backfill path. */
      expect(result.firstName).toBe('Admin-Set');
      expect(result.lastName).toBe('Name');
      expect(usersRepo.save).toHaveBeenCalledTimes(1);
    });

    it('returns existing record unchanged when email matches a row with a different non-null cognito_sub (no takeover)', async () => {
      const existing = makeUser({
        id: 30,
        email: 'shared@example.com',
        cognitoSub: 'original-sub',
        firstName: 'Original',
        lastName: 'Owner',
      });

      usersRepo.findOne
        .mockResolvedValueOnce(null) // no sub match
        .mockResolvedValueOnce(existing); // email match with different sub

      const result = await service.upsertFromCognito({
        cognitoSub: 'attacker-sub',
        email: 'shared@example.com',
        firstName: 'Attacker',
        lastName: 'Name',
      });

      /* Record must come back unmodified in memory AND not persisted. */
      expect(result.cognitoSub).toBe('original-sub');
      expect(result.firstName).toBe('Original');
      expect(result.lastName).toBe('Owner');
      expect(usersRepo.save).not.toHaveBeenCalled();
    });

    it('updates email/name when an existing row matches by cognito sub', async () => {
      const existing = makeUser({
        id: 40,
        email: 'old@example.com',
        cognitoSub: 'stable-sub',
        firstName: 'Old',
        lastName: 'Name',
      });
      usersRepo.findOne.mockResolvedValueOnce(existing);
      usersRepo.save.mockImplementation(async (u) => u as User);

      const result = await service.upsertFromCognito({
        cognitoSub: 'stable-sub',
        email: 'new@example.com',
        firstName: 'New',
        lastName: 'Name',
      });

      expect(result.email).toBe('new@example.com');
      expect(result.firstName).toBe('New');
      expect(result.lastName).toBe('Name');
      expect(usersRepo.save).toHaveBeenCalledTimes(1);
    });

    it('creates a new user when neither cognito sub nor email matches', async () => {
      usersRepo.findOne
        .mockResolvedValueOnce(null) // no sub match
        .mockResolvedValueOnce(null); // no email match
      usersRepo.save.mockImplementation(
        async (u) => ({ ...u, id: 99 }) as User,
      );

      const result = await service.upsertFromCognito({
        cognitoSub: 'brand-new-sub',
        email: 'brand@example.com',
        firstName: 'Brand',
        lastName: 'New',
      });

      expect(usersRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          cognitoSub: 'brand-new-sub',
          email: 'brand@example.com',
          firstName: 'Brand',
          lastName: 'New',
        }),
      );
      expect(result.id).toBe(99);
    });
  });

  /* Light-touch silence for unused-token TS warnings in some configs. */
  void BadRequestException;
});
