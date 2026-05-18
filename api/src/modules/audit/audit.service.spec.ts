import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { AuditService } from './audit.service';
import { AuditEntityType, AuditEvent } from './entities/audit-event.entity';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/enums/user-role.enum';
import { ActorRole } from '../mappings/enums/actor-role.enum';
import { RequestContextService } from '../../common/context/request-context.service';

/**
 * Pure unit tests for AuditService — no real database, no Nest HTTP layer.
 *
 * The repo is mocked because the heavy lifting we want to validate is in
 * the service itself: actor resolution, change-payload computation, error
 * swallowing, and visibility scoping. Integration tests against a live
 * MySQL belong in the e2e suite, not here.
 */
describe('AuditService', () => {
  let service: AuditService;
  let auditRepo: jest.Mocked<Repository<AuditEvent>>;
  let userRepo: jest.Mocked<Repository<User>>;
  let requestContext: jest.Mocked<RequestContextService>;

  /**
   * Build a chain-friendly QueryBuilder mock. Every method on the chain
   * returns the mock itself so tests can assert which methods were called
   * with which arguments. Terminal methods (`getManyAndCount`, `getOne`)
   * return Promises so the awaiting code resolves cleanly.
   */
  const buildQbMock = (): jest.Mocked<
    Pick<
      SelectQueryBuilder<AuditEvent>,
      | 'leftJoinAndSelect'
      | 'where'
      | 'andWhere'
      | 'orderBy'
      | 'offset'
      | 'limit'
      | 'getManyAndCount'
      | 'getOne'
    >
  > => {
    const qb: any = {};
    qb.leftJoinAndSelect = jest.fn().mockReturnValue(qb);
    qb.where = jest.fn().mockReturnValue(qb);
    qb.andWhere = jest.fn().mockReturnValue(qb);
    qb.orderBy = jest.fn().mockReturnValue(qb);
    qb.offset = jest.fn().mockReturnValue(qb);
    qb.limit = jest.fn().mockReturnValue(qb);
    qb.getManyAndCount = jest.fn().mockResolvedValue([[], 0]);
    qb.getOne = jest.fn().mockResolvedValue(null);
    return qb;
  };

  beforeEach(async () => {
    // `as any` on the mock object: TypeORM's Repository.create has a
    // multi-overload signature (zero/one/array forms) that jest.fn cannot
    // satisfy structurally. The runtime behaviour is what we need —
    // identity-passthrough so tests can inspect what was created.
    const auditRepoMock: any = {
      create: jest.fn((input: any) => input),
      save: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn(),
      query: jest.fn(),
    };
    const userRepoMock: any = {
      findOne: jest.fn(),
    };
    const requestContextMock: any = {
      getUserId: jest.fn(),
      getRequestId: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditService,
        {
          provide: getRepositoryToken(AuditEvent),
          useValue: auditRepoMock,
        },
        {
          provide: getRepositoryToken(User),
          useValue: userRepoMock,
        },
        {
          provide: RequestContextService,
          useValue: requestContextMock,
        },
      ],
    }).compile();

    service = module.get(AuditService);
    auditRepo = module.get(getRepositoryToken(AuditEvent));
    userRepo = module.get(getRepositoryToken(User));
    requestContext = module.get(RequestContextService);
  });

  // ────────────────────────────────────────────────────────────────────
  // computeChanges
  // ────────────────────────────────────────────────────────────────────

  describe('computeChanges', () => {
    it('returns null when no fields differ', () => {
      const before = { name: 'Alpha', budget: 100 };
      const after = { name: 'Alpha', budget: 100 };
      const result = service.computeChanges(before, after, ['name', 'budget']);
      expect(result).toBeNull();
    });

    it('returns only the changed fields', () => {
      const before = { name: 'Alpha', budget: 100, status: 'active' };
      const after = { name: 'Beta', budget: 100, status: 'active' };
      const result = service.computeChanges(before, after, [
        'name',
        'budget',
        'status',
      ]);
      expect(result).toEqual({
        name: { before: 'Alpha', after: 'Beta' },
      });
    });

    it('treats Date fields as equal when they share the same instant', () => {
      const t = Date.now();
      const before = { startDate: new Date(t) };
      const after = { startDate: new Date(t) };
      expect(service.computeChanges(before, after, ['startDate'])).toBeNull();
    });

    it('detects deeply different object fields', () => {
      const before = { meta: { foo: 1 } };
      const after = { meta: { foo: 2 } };
      const result = service.computeChanges(before, after, ['meta']);
      expect(result).toEqual({
        meta: { before: { foo: 1 }, after: { foo: 2 } },
      });
    });

    it('truncates fields whose serialised value exceeds 10KB', () => {
      // Build a string > 10KB so JSON.stringify of it crosses the threshold.
      const big = 'x'.repeat(11 * 1024);
      const before = { description: 'short' };
      const after = { description: big };
      const result = service.computeChanges(before, after, ['description']);
      expect(result).toEqual({
        description: { before: '<truncated>', after: '<truncated>' },
      });
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // record()
  // ────────────────────────────────────────────────────────────────────

  describe('record()', () => {
    it('skips with a warning when there is no request context and no actorOverride', async () => {
      requestContext.getUserId.mockReturnValue(undefined);
      const warnSpy = jest
        .spyOn((service as any).logger, 'warn')
        .mockImplementation(() => undefined);

      await service.record({
        entityType: AuditEntityType.PROJECT,
        entityId: 1,
        action: 'project.metadata_update',
      });

      expect(auditRepo.save).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('no actorOverride'),
      );
    });

    it('skips when the resolved user has no role assigned', async () => {
      requestContext.getUserId.mockReturnValue(42);
      userRepo.findOne.mockResolvedValue({
        id: 42,
        email: 'noone@example.com',
        firstName: 'No',
        lastName: 'One',
        role: null,
      } as User);
      const warnSpy = jest
        .spyOn((service as any).logger, 'warn')
        .mockImplementation(() => undefined);

      await service.record({
        entityType: AuditEntityType.PROJECT,
        entityId: 1,
        action: 'project.metadata_update',
      });

      expect(auditRepo.save).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('has no role assigned'),
      );
    });

    it('persists a row with denormalised actor metadata when context is present', async () => {
      requestContext.getUserId.mockReturnValue(7);
      requestContext.getRequestId.mockReturnValue('req-uuid-123');
      userRepo.findOne.mockResolvedValue({
        id: 7,
        email: 'admin@codeobia.com',
        firstName: 'Ada',
        lastName: 'Lovelace',
        role: UserRole.ADMIN,
      } as User);

      await service.record({
        entityType: AuditEntityType.PROJECT,
        entityId: 99,
        action: 'project.metadata_update',
        changes: { name: { before: 'A', after: 'B' } },
        summary: 'Edited field: name',
        justification: 'fixing typo',
      });

      expect(auditRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: AuditEntityType.PROJECT,
          entityId: 99,
          action: 'project.metadata_update',
          actorUserId: 7,
          actorRole: ActorRole.ADMIN,
          actorDisplayName: 'Ada Lovelace',
          actorEmail: 'admin@codeobia.com',
          requestId: 'req-uuid-123',
        }),
      );
      expect(auditRepo.save).toHaveBeenCalledTimes(1);
    });

    it('uses actorOverride verbatim and skips the user lookup', async () => {
      await service.record({
        entityType: AuditEntityType.SYSTEM,
        entityId: null,
        action: 'clarisa_sync.run',
        actorOverride: {
          userId: null,
          role: ActorRole.SYSTEM,
          displayName: 'CLARISA Sync',
          email: null,
        },
      });

      expect(userRepo.findOne).not.toHaveBeenCalled();
      expect(auditRepo.save).toHaveBeenCalledTimes(1);
      expect(auditRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          actorUserId: null,
          actorRole: ActorRole.SYSTEM,
          actorDisplayName: 'CLARISA Sync',
          actorEmail: null,
        }),
      );
    });

    it('swallows DB errors and logs a warning', async () => {
      requestContext.getUserId.mockReturnValue(7);
      userRepo.findOne.mockResolvedValue({
        id: 7,
        email: 'admin@codeobia.com',
        firstName: 'Ada',
        lastName: 'Lovelace',
        role: UserRole.ADMIN,
      } as User);
      auditRepo.save.mockRejectedValueOnce(new Error('connection refused'));
      const warnSpy = jest
        .spyOn((service as any).logger, 'warn')
        .mockImplementation(() => undefined);

      // Should NOT throw — the contract is that audit failures never
      // propagate to the primary request.
      await expect(
        service.record({
          entityType: AuditEntityType.PROJECT,
          entityId: 1,
          action: 'project.metadata_update',
        }),
      ).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('connection refused'),
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // query() visibility scoping
  // ────────────────────────────────────────────────────────────────────

  describe('query() visibility scoping', () => {
    /**
     * Inspect every andWhere() invocation on the QueryBuilder mock and
     * return the SQL fragments. Lets us assert exactly which scope
     * clauses were attached without coupling to argument order.
     */
    const collectAndWhereSql = (qb: any): string[] =>
      (qb.andWhere as jest.Mock).mock.calls.map(
        (call: any[]) => call[0] as string,
      );

    it('admin role applies no entity-type filter', async () => {
      const qb = buildQbMock();
      auditRepo.createQueryBuilder.mockReturnValue(qb as any);

      await service.query({}, UserRole.ADMIN, 1);

      const sqls = collectAndWhereSql(qb);
      // No scope clause should reference entityType for admins.
      expect(sqls.some((sql) => sql.includes('entityType IN'))).toBe(false);
      expect(sqls.some((sql) => sql.includes('actorUserId = :uaUserId'))).toBe(
        false,
      );
    });

    it('workflow_admin role restricts to project / mapping / snapshot entities', async () => {
      const qb = buildQbMock();
      auditRepo.createQueryBuilder.mockReturnValue(qb as any);

      await service.query({}, UserRole.WORKFLOW_ADMIN, 1);

      // Pull the call and check both the SQL and the params it bound.
      const scopeCall = (qb.andWhere as jest.Mock).mock.calls.find(
        (call) =>
          typeof call[0] === 'string' && call[0].includes('entityType IN'),
      );
      expect(scopeCall).toBeDefined();
      expect(scopeCall![1]).toEqual({
        wfaEntityTypes: [
          AuditEntityType.PROJECT,
          AuditEntityType.PROJECT_MAPPING,
          AuditEntityType.PUBLISHED_SNAPSHOT,
        ],
      });
    });

    it('unit_admin role uses the OR clause for own-actions plus project metadata', async () => {
      const qb = buildQbMock();
      auditRepo.createQueryBuilder.mockReturnValue(qb as any);

      await service.query({}, UserRole.UNIT_ADMIN, 99);

      const scopeCall = (qb.andWhere as jest.Mock).mock.calls.find(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('actorUserId = :uaUserId'),
      );
      expect(scopeCall).toBeDefined();
      expect(scopeCall![0]).toContain('audit.action LIKE :uaMetadataPrefix');
      expect(scopeCall![1]).toEqual({
        uaUserId: 99,
        uaProject: AuditEntityType.PROJECT,
        uaMetadataPrefix: 'project.metadata%',
      });
    });

    it('throws ForbiddenException for any other role (defensive)', async () => {
      const qb = buildQbMock();
      auditRepo.createQueryBuilder.mockReturnValue(qb as any);

      await expect(service.query({}, UserRole.PROGRAM_REP, 1)).rejects.toThrow(
        'Caller role is not permitted',
      );
    });
  });
});
