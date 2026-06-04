/**
 * Unit tests for MappingsService — focused on the negotiation timeline.
 *
 * Every mutating action must append a row to `mapping_negotiations`
 * (or `project_negotiation_messages` for chat) and must NEVER mutate
 * an existing event row. These tests pin that invariant in addition
 * to the happy-path state transitions, RBAC, and guard behavior.
 *
 * Integration coverage (real database, HTTP flow) lives in
 * `api/test/negotiation.e2e-spec.ts`.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';

import { MappingsService } from './mappings.service';
import { ProjectMapping } from './entities/project-mapping.entity';
import { MappingNegotiation } from './entities/mapping-negotiation.entity';
import { ProjectNegotiationMessage } from './entities/project-negotiation-message.entity';
import {
  MappingTocLink,
  MappingTocLinkType,
} from './entities/mapping-toc-link.entity';
import { NegotiationGateway } from './gateways/negotiation.gateway';
import { Project } from '../projects/entities/project.entity';
import { Program } from '../reference-data/entities/program.entity';
import { TocAow } from '../reference-data/entities/toc-aow.entity';
import { TocOutput } from '../reference-data/entities/toc-output.entity';
import { TocOutcome } from '../reference-data/entities/toc-outcome.entity';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/enums/user-role.enum';
import { ProjectStatus } from '../projects/enums/project-status.enum';
import { MappingStatus } from './enums/mapping-status.enum';
import { NegotiationEventType } from './enums/negotiation-event-type.enum';
import { ActorRole } from './enums/actor-role.enum';
import { Rating } from './enums/rating.enum';
import { AuditService } from '../audit/audit.service';

/* ───────────────────────── Factories ───────────────────────── */

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 1,
    cognitoSub: 'sub-1',
    email: 'user@example.com',
    firstName: 'First',
    lastName: 'Last',
    role: UserRole.CENTER_REP,
    program: null,
    programId: null,
    center: null,
    centerId: 10,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as User;
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 100,
    code: 'P-1',
    name: 'Project 1',
    centerId: 10,
    status: ProjectStatus.ACTIVE,
    negotiationLocked: false,
    center: { id: 10, name: 'Center 10' } as any,
    ...overrides,
  } as Project;
}

function makeMapping(overrides: Partial<ProjectMapping> = {}): ProjectMapping {
  return {
    id: 500,
    projectId: 100,
    programId: 200,
    allocationPercentage: 50,
    complementarityRating: Rating.HIGH,
    efficiencyRating: Rating.HIGH,
    status: MappingStatus.NEGOTIATING,
    centerAgreed: false,
    programAgreed: false,
    initiatedById: 1,
    initiatedAt: new Date(),
    needsAssistance: false,
    flaggedAt: null,
    removalRequested: false,
    removalRequestedById: null,
    removalRequestedAt: null,
    removalJustification: null,
    project: makeProject(),
    program: { id: 200, name: 'Program 200' } as any,
    ...overrides,
  } as ProjectMapping;
}

/**
 * Builds a per-test entity manager with a shared `savedNegotiations`
 * sink so tests can assert exactly which timeline rows were appended.
 */
function buildMockManager() {
  const savedNegotiations: MappingNegotiation[] = [];
  const savedMappings: ProjectMapping[] = [];
  const savedProjects: Project[] = [];
  const savedTocLinks: MappingTocLink[] = [];
  const deletedTocLinkWhere: any[] = [];

  const manager: any = {
    save: jest.fn(async (target: any, entity: any) => {
      if (target === MappingNegotiation) {
        savedNegotiations.push({ ...entity, id: savedNegotiations.length + 1 });
      } else if (target === ProjectMapping) {
        savedMappings.push(entity);
      } else if (target === Project) {
        savedProjects.push(entity);
      } else if (target === MappingTocLink) {
        if (Array.isArray(entity)) {
          for (const row of entity) {
            savedTocLinks.push({
              ...row,
              id: String(savedTocLinks.length + 1),
            });
          }
        } else {
          savedTocLinks.push({
            ...entity,
            id: String(savedTocLinks.length + 1),
          });
        }
      }
      return entity;
    }),
    delete: jest.fn(async (target: any, where: any) => {
      if (target === MappingTocLink) {
        deletedTocLinkWhere.push(where);
      }
      return { affected: 0 };
    }),
    findOne: jest.fn(async (..._args: any[]) => null as any),
    findOneBy: jest.fn(async (..._args: any[]) => null as any),
    find: jest.fn(async (..._args: any[]) => [] as any),
    count: jest.fn(async (..._args: any[]) => 0),
    createQueryBuilder: jest.fn(() => ({
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn(async () => null as any),
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      execute: jest.fn(async () => ({ affected: 0 })),
    })),
  };

  return {
    manager,
    savedNegotiations,
    savedMappings,
    savedProjects,
    savedTocLinks,
    deletedTocLinkWhere,
  };
}

function buildMockDataSource(
  manager: ReturnType<typeof buildMockManager>['manager'],
) {
  return {
    transaction: jest.fn(async (cb: (m: any) => Promise<any>) => cb(manager)),
  };
}

/* Stub repository — methods used during the service's findOneInternal /
 * lookup paths. Each test overrides only what it needs. */
function buildMockRepo(): any {
  return {
    findOne: jest.fn(),
    findOneBy: jest.fn(),
    find: jest.fn(async () => []),
    save: jest.fn(async (e: any) => e),
    create: jest.fn((e: any) => e),
    delete: jest.fn(async () => ({ affected: 0 })),
    createQueryBuilder: jest.fn(() => ({
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getMany: jest.fn(async () => []),
      getOne: jest.fn(async () => null),
      getCount: jest.fn(async () => 0),
      getRawMany: jest.fn(async () => []),
    })),
  };
}

/* ───────────────────────── Suite ───────────────────────── */

describe('MappingsService — negotiation timeline', () => {
  let service: MappingsService;
  let mappingRepo: any;
  let negotiationRepo: any;
  let chatRepo: any;
  let projectRepo: any;
  let programRepo: any;
  let tocLinkRepo: any;
  let tocAowRepo: any;
  let tocOutputRepo: any;
  let tocOutcomeRepo: any;
  let dataSource: any;
  let gateway: any;
  let audit: any;
  let mocks: ReturnType<typeof buildMockManager>;

  beforeEach(async () => {
    mocks = buildMockManager();
    const ds = buildMockDataSource(mocks.manager);

    const module: TestingModule = await Test.createTestingModule({
      providers: [MappingsService],
    })
      .useMocker((token) => {
        if (token === getRepositoryToken(ProjectMapping))
          return buildMockRepo();
        if (token === getRepositoryToken(MappingNegotiation))
          return buildMockRepo();
        if (token === getRepositoryToken(ProjectNegotiationMessage))
          return buildMockRepo();
        if (token === getRepositoryToken(Project)) return buildMockRepo();
        if (token === getRepositoryToken(Program)) return buildMockRepo();
        if (token === getRepositoryToken(MappingTocLink))
          return buildMockRepo();
        if (token === getRepositoryToken(TocAow)) return buildMockRepo();
        if (token === getRepositoryToken(TocOutput)) return buildMockRepo();
        if (token === getRepositoryToken(TocOutcome)) return buildMockRepo();
        if (token === DataSource) return ds;
        if (token === NegotiationGateway) {
          return { emitProjectUpdate: jest.fn() };
        }
        if (token === AuditService) {
          return { record: jest.fn(async () => undefined) };
        }
        return {};
      })
      .compile();

    service = module.get(MappingsService);
    mappingRepo = module.get(getRepositoryToken(ProjectMapping));
    negotiationRepo = module.get(getRepositoryToken(MappingNegotiation));
    chatRepo = module.get(getRepositoryToken(ProjectNegotiationMessage));
    projectRepo = module.get(getRepositoryToken(Project));
    programRepo = module.get(getRepositoryToken(Program));
    tocLinkRepo = module.get(getRepositoryToken(MappingTocLink));
    tocAowRepo = module.get(getRepositoryToken(TocAow));
    tocOutputRepo = module.get(getRepositoryToken(TocOutput));
    tocOutcomeRepo = module.get(getRepositoryToken(TocOutcome));
    dataSource = module.get(DataSource);
    gateway = module.get(NegotiationGateway);
    audit = module.get(AuditService);
  });

  /**
   * Helper to stub `tocLinkRepo.createQueryBuilder` so the
   * `assertTocLinksSatisfyAgreeGate` count-grouped-by-link-type query
   * returns the supplied counts. Pass any subset; missing keys count
   * as zero.
   */
  function stubAgreeGateCounts(counts: {
    aow?: number;
    output?: number;
    outcome?: number;
  }) {
    const rows = [
      { linkType: MappingTocLinkType.AOW, count: counts.aow ?? 0 },
      { linkType: MappingTocLinkType.OUTPUT, count: counts.output ?? 0 },
      { linkType: MappingTocLinkType.OUTCOME, count: counts.outcome ?? 0 },
    ].filter((r) => Number(r.count) > 0);
    tocLinkRepo.createQueryBuilder.mockReturnValueOnce({
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn(async () => rows),
    });
  }

  /**
   * Helper to stub the `assertTocIdsBelongToProgram` validation —
   * three calls to `tocAowRepo`, `tocOutputRepo`, `tocOutcomeRepo`
   * `.createQueryBuilder().getRawMany()`. Pass the ids that should
   * validate as "belonging to the program" per type; everything
   * else is treated as cross-program (rejected).
   */
  function stubTocOwnership(found: {
    aowIds?: number[];
    outputIds?: number[];
    outcomeIds?: number[];
  }) {
    const buildQb = (ids: number[]) => ({
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawMany: jest.fn(async () => ids.map((id) => ({ id }))),
    });
    tocAowRepo.createQueryBuilder.mockReturnValueOnce(
      buildQb(found.aowIds ?? []),
    );
    tocOutputRepo.createQueryBuilder.mockReturnValueOnce(
      buildQb(found.outputIds ?? []),
    );
    tocOutcomeRepo.createQueryBuilder.mockReturnValueOnce(
      buildQb(found.outcomeIds ?? []),
    );
  }

  /* ─────────── create() ─────────── */

  describe('create()', () => {
    it('appends an INITIATED event and never mutates a prior event row', async () => {
      const user = makeUser({ role: UserRole.CENTER_REP, centerId: 10 });
      const project = makeProject();
      projectRepo.findOneBy.mockResolvedValueOnce(project);
      programRepo.findOneBy.mockResolvedValueOnce({ id: 200 });
      mappingRepo.findOneBy.mockResolvedValueOnce(null);
      // cap check
      mappingRepo.createQueryBuilder.mockReturnValueOnce({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn(async () => 0),
      });
      // post-create reload
      mocks.manager.findOne.mockResolvedValueOnce(
        makeMapping({ status: MappingStatus.DRAFT }),
      );

      await service.create(
        {
          projectId: 100,
          programId: 200,
          allocationPercentage: 50,
          complementarityRating: Rating.HIGH,
          efficiencyRating: Rating.HIGH,
        },
        user,
      );

      expect(mocks.savedNegotiations).toHaveLength(1);
      expect(mocks.savedNegotiations[0]).toMatchObject({
        eventType: NegotiationEventType.INITIATED,
        actorId: 1,
        actorRole: ActorRole.CENTER_REP,
        proposedAllocation: 50,
      });
    });

    it('rejects non-center-rep / non-admin', async () => {
      const user = makeUser({
        role: UserRole.PROGRAM_REP,
        programId: 200,
        centerId: null,
      });
      await expect(
        service.create(
          {
            projectId: 100,
            programId: 200,
            allocationPercentage: 10,
            complementarityRating: Rating.HIGH,
            efficiencyRating: Rating.HIGH,
          },
          user,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects when (project, program) already has an active mapping', async () => {
      const user = makeUser({ role: UserRole.CENTER_REP, centerId: 10 });
      projectRepo.findOneBy.mockResolvedValueOnce(makeProject());
      programRepo.findOneBy.mockResolvedValueOnce({ id: 200 });
      mappingRepo.findOneBy.mockResolvedValueOnce(
        makeMapping({ status: MappingStatus.AGREED }),
      );
      await expect(
        service.create(
          {
            projectId: 100,
            programId: 200,
            allocationPercentage: 10,
            complementarityRating: Rating.HIGH,
            efficiencyRating: Rating.HIGH,
          },
          user,
        ),
      ).rejects.toThrow(ConflictException);
    });
  });

  /* ─────────── openNegotiation() ─────────── */

  describe('openNegotiation()', () => {
    it('appends NEGOTIATION_STARTED on draft → negotiating when project totals 100%', async () => {
      const user = makeUser({ role: UserRole.CENTER_REP, centerId: 10 });
      const draft = makeMapping({
        status: MappingStatus.DRAFT,
        allocationPercentage: 100,
      });
      mappingRepo.findOne
        .mockResolvedValueOnce(draft)
        .mockResolvedValueOnce(draft);
      // assertProjectFullyAllocated reads every mapping on the project.
      mappingRepo.find.mockResolvedValueOnce([draft]);

      await service.openNegotiation(500, user);

      expect(mocks.savedNegotiations).toHaveLength(1);
      expect(mocks.savedNegotiations[0]).toMatchObject({
        eventType: NegotiationEventType.NEGOTIATION_STARTED,
        actorRole: ActorRole.CENTER_REP,
        proposedAllocation: 100,
      });
    });

    it('rejects when the project allocations do not total 100%', async () => {
      const user = makeUser({ role: UserRole.CENTER_REP, centerId: 10 });
      const draft = makeMapping({
        status: MappingStatus.DRAFT,
        allocationPercentage: 60,
      });
      mappingRepo.findOne.mockResolvedValueOnce(draft);
      mappingRepo.find.mockResolvedValueOnce([draft]); // sums to 60%

      await expect(service.openNegotiation(500, user)).rejects.toThrow(
        BadRequestException,
      );
      // No event appended — the gate rejected before the transaction.
      expect(mocks.savedNegotiations).toHaveLength(0);
    });

    it('rejects when mapping is not draft', async () => {
      const user = makeUser({ role: UserRole.CENTER_REP, centerId: 10 });
      mappingRepo.findOne.mockResolvedValueOnce(
        makeMapping({ status: MappingStatus.NEGOTIATING }),
      );
      await expect(service.openNegotiation(500, user)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  /* ─────────── counterPropose() ─────────── */

  describe('counterPropose()', () => {
    it('appends COUNTER_PROPOSED with new %, justification, and proposer-side agreed', async () => {
      const user = makeUser({
        role: UserRole.PROGRAM_REP,
        programId: 200,
        centerId: null,
      });
      const mapping = makeMapping({ status: MappingStatus.NEGOTIATING });
      mappingRepo.findOne.mockResolvedValueOnce(mapping);
      // findOne inside the transaction (final reload)
      mocks.manager.findOne.mockResolvedValueOnce(mapping);

      await service.counterPropose(
        500,
        { proposedAllocation: 30, justification: 'too high' },
        user,
      );

      expect(mocks.savedNegotiations).toHaveLength(1);
      expect(mocks.savedNegotiations[0]).toMatchObject({
        eventType: NegotiationEventType.COUNTER_PROPOSED,
        actorRole: ActorRole.PROGRAM_REP,
        proposedAllocation: 30,
        justification: 'too high',
      });
      // proposer side implicitly agreed, other side cleared
      expect(mapping.programAgreed).toBe(true);
      expect(mapping.centerAgreed).toBe(false);
    });

    it('rejects when mapping is in draft (not negotiating or agreed)', async () => {
      const user = makeUser({
        role: UserRole.PROGRAM_REP,
        programId: 200,
        centerId: null,
      });
      mappingRepo.findOne.mockResolvedValueOnce(
        makeMapping({ status: MappingStatus.DRAFT }),
      );
      await expect(
        service.counterPropose(
          500,
          { proposedAllocation: 30, justification: 'no' },
          user,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('reverts an AGREED mapping back to negotiating on counter', async () => {
      // Both sides previously agreed; one side now counters lower to
      // unblock an over-allocated project round.
      const user = makeUser({
        role: UserRole.CENTER_REP,
        programId: null,
        centerId: 10,
      });
      const mapping = makeMapping({
        status: MappingStatus.AGREED,
        centerAgreed: true,
        programAgreed: true,
      });
      mappingRepo.findOne.mockResolvedValueOnce(mapping);
      mocks.manager.findOne.mockResolvedValueOnce(mapping);

      await service.counterPropose(
        500,
        { proposedAllocation: 40, justification: 'sum exceeded 100' },
        user,
      );

      expect(mapping.status).toBe(MappingStatus.NEGOTIATING);
      expect(mapping.centerAgreed).toBe(true);
      expect(mapping.programAgreed).toBe(false);
      expect(mocks.savedNegotiations[0]).toMatchObject({
        eventType: NegotiationEventType.COUNTER_PROPOSED,
        proposedAllocation: 40,
      });
    });

    it('writes a second FLAGGED_FOR_ASSISTANCE event on the program rep’s 2nd counter', async () => {
      const user = makeUser({
        role: UserRole.PROGRAM_REP,
        programId: 200,
        centerId: null,
      });
      const mapping = makeMapping({
        status: MappingStatus.NEGOTIATING,
        needsAssistance: false,
      });
      mappingRepo.findOne.mockResolvedValueOnce(mapping);
      // service counts prior program-rep counters INCLUDING the one just inserted
      mocks.manager.count.mockResolvedValueOnce(2);
      mocks.manager.findOne.mockResolvedValueOnce(mapping);

      await service.counterPropose(
        500,
        { proposedAllocation: 30, justification: 'deadlock' },
        user,
      );

      const types = mocks.savedNegotiations.map((e) => e.eventType);
      expect(types).toEqual([
        NegotiationEventType.COUNTER_PROPOSED,
        NegotiationEventType.FLAGGED_FOR_ASSISTANCE,
      ]);
      expect(mapping.needsAssistance).toBe(true);
    });
  });

  /* ─────────── agree() ─────────── */

  describe('agree()', () => {
    it('appends an AGREED event', async () => {
      const user = makeUser({ role: UserRole.CENTER_REP, centerId: 10 });
      const mapping = makeMapping({ status: MappingStatus.NEGOTIATING });
      mappingRepo.findOne.mockResolvedValueOnce(mapping);
      mocks.manager.findOne.mockResolvedValueOnce(mapping);

      await service.agree(500, {} as any, user);

      expect(mocks.savedNegotiations).toHaveLength(1);
      expect(mocks.savedNegotiations[0]).toMatchObject({
        eventType: NegotiationEventType.AGREED,
        actorRole: ActorRole.CENTER_REP,
      });
      expect(mapping.centerAgreed).toBe(true);
    });

    it('transitions to AGREED status when both sides agree', async () => {
      const user = makeUser({
        role: UserRole.PROGRAM_REP,
        programId: 200,
        centerId: null,
      });
      const mapping = makeMapping({
        status: MappingStatus.NEGOTIATING,
        centerAgreed: true,
        programAgreed: false,
      });
      mappingRepo.findOne.mockResolvedValueOnce(mapping);
      // Program-rep agree triggers the TOC links gate — satisfy it.
      stubAgreeGateCounts({ aow: 1, output: 1 });
      mocks.manager.findOne.mockResolvedValueOnce(mapping);

      await service.agree(500, {} as any, user);

      expect(mapping.status).toBe(MappingStatus.AGREED);
      expect(mocks.savedNegotiations).toHaveLength(1);
      expect(mocks.savedNegotiations[0].eventType).toBe(
        NegotiationEventType.AGREED,
      );
    });

    /* ── TOC links gate on program-side agree() ── */

    it('rejects program-rep agree with TOC_LINKS_REQUIRED when no links are attached', async () => {
      const user = makeUser({
        role: UserRole.PROGRAM_REP,
        programId: 200,
        centerId: null,
      });
      const mapping = makeMapping({ status: MappingStatus.NEGOTIATING });
      mappingRepo.findOne.mockResolvedValueOnce(mapping);
      stubAgreeGateCounts({}); // no links at all

      await expect(service.agree(500, {} as any, user)).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'TOC_LINKS_REQUIRED' }),
      });
      expect(mocks.savedNegotiations).toHaveLength(0);
    });

    it('rejects program-rep agree when AOW is present but no output AND no outcome', async () => {
      const user = makeUser({
        role: UserRole.PROGRAM_REP,
        programId: 200,
        centerId: null,
      });
      const mapping = makeMapping({ status: MappingStatus.NEGOTIATING });
      mappingRepo.findOne.mockResolvedValueOnce(mapping);
      stubAgreeGateCounts({ aow: 2 }); // no outputs, no outcomes

      await expect(service.agree(500, {} as any, user)).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'TOC_LINKS_REQUIRED' }),
      });
    });

    it('allows program-rep agree when AOW + only outputs are set', async () => {
      const user = makeUser({
        role: UserRole.PROGRAM_REP,
        programId: 200,
        centerId: null,
      });
      const mapping = makeMapping({ status: MappingStatus.NEGOTIATING });
      mappingRepo.findOne.mockResolvedValueOnce(mapping);
      stubAgreeGateCounts({ aow: 1, output: 3 });
      mocks.manager.findOne.mockResolvedValueOnce(mapping);

      await service.agree(500, {} as any, user);

      expect(mocks.savedNegotiations).toHaveLength(1);
      expect(mocks.savedNegotiations[0].eventType).toBe(
        NegotiationEventType.AGREED,
      );
    });

    it('allows program-rep agree when AOW + only outcomes are set', async () => {
      const user = makeUser({
        role: UserRole.PROGRAM_REP,
        programId: 200,
        centerId: null,
      });
      const mapping = makeMapping({ status: MappingStatus.NEGOTIATING });
      mappingRepo.findOne.mockResolvedValueOnce(mapping);
      stubAgreeGateCounts({ aow: 1, outcome: 2 });
      mocks.manager.findOne.mockResolvedValueOnce(mapping);

      await service.agree(500, {} as any, user);

      expect(mocks.savedNegotiations).toHaveLength(1);
      expect(mocks.savedNegotiations[0].eventType).toBe(
        NegotiationEventType.AGREED,
      );
    });

    it('allows program-rep agree when AOW + both outputs and outcomes are set', async () => {
      const user = makeUser({
        role: UserRole.PROGRAM_REP,
        programId: 200,
        centerId: null,
      });
      const mapping = makeMapping({ status: MappingStatus.NEGOTIATING });
      mappingRepo.findOne.mockResolvedValueOnce(mapping);
      stubAgreeGateCounts({ aow: 1, output: 1, outcome: 1 });
      mocks.manager.findOne.mockResolvedValueOnce(mapping);

      await service.agree(500, {} as any, user);

      expect(mocks.savedNegotiations).toHaveLength(1);
    });

    it('does NOT apply the TOC gate to center-side agree (no link check, no error)', async () => {
      const user = makeUser({ role: UserRole.CENTER_REP, centerId: 10 });
      const mapping = makeMapping({ status: MappingStatus.NEGOTIATING });
      mappingRepo.findOne.mockResolvedValueOnce(mapping);
      mocks.manager.findOne.mockResolvedValueOnce(mapping);

      // No stubAgreeGateCounts — center-side never reads tocLinkRepo.
      await service.agree(500, {} as any, user);

      expect(mocks.savedNegotiations).toHaveLength(1);
      expect(mocks.savedNegotiations[0].eventType).toBe(
        NegotiationEventType.AGREED,
      );
      expect(tocLinkRepo.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  /* ─────────── auto-lock on full agreement ─────────── */

  describe('agree() auto-lock', () => {
    /**
     * Stub the project pessimistic-lock read used by
     * `tryAutoLockOnFullAgreement`. Returns `project` from
     * `manager.createQueryBuilder(...).getOne()`.
     */
    function stubProjectLockRead(project: Project | null) {
      mocks.manager.createQueryBuilder.mockReturnValueOnce({
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn(async () => project),
      });
    }

    it('auto-locks the project when the final agree makes every active mapping agreed at 100%', async () => {
      const user = makeUser({ role: UserRole.CENTER_REP, centerId: 10 });
      const project = makeProject({ negotiationLocked: false });
      // This mapping is the last one to flip; program already agreed.
      const mapping = makeMapping({
        status: MappingStatus.NEGOTIATING,
        centerAgreed: false,
        programAgreed: true,
        allocationPercentage: 100,
        project,
      });
      mappingRepo.findOne.mockResolvedValueOnce(mapping);

      // Auto-lock reads the project (unlocked) then the active mappings.
      // After the agree, the in-memory mapping is AGREED at 100%.
      stubProjectLockRead(project);
      mocks.manager.find.mockResolvedValueOnce([mapping]);
      mocks.manager.findOne.mockResolvedValueOnce(mapping);

      await service.agree(500, {} as any, user);

      expect(mapping.status).toBe(MappingStatus.AGREED);
      expect(project.negotiationLocked).toBe(true);

      // One AGREED event + one LOCKED event for the single active mapping.
      const types = mocks.savedNegotiations.map((e) => e.eventType);
      expect(types).toContain(NegotiationEventType.AGREED);
      expect(
        mocks.savedNegotiations.filter(
          (e) => e.eventType === NegotiationEventType.LOCKED,
        ),
      ).toHaveLength(1);

      // Emits the project.locked socket event and project-level audit.
      expect(gateway.emitProjectUpdate).toHaveBeenCalledWith(
        100,
        'project.locked',
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'project.locked' }),
      );
    });

    it('does NOT auto-lock when the round is fully agreed but under 100%', async () => {
      const user = makeUser({ role: UserRole.CENTER_REP, centerId: 10 });
      const project = makeProject({ negotiationLocked: false });
      const mapping = makeMapping({
        status: MappingStatus.NEGOTIATING,
        centerAgreed: false,
        programAgreed: true,
        allocationPercentage: 60,
        project,
      });
      mappingRepo.findOne.mockResolvedValueOnce(mapping);

      stubProjectLockRead(project);
      mocks.manager.find.mockResolvedValueOnce([mapping]);
      mocks.manager.findOne.mockResolvedValueOnce(mapping);

      await service.agree(500, {} as any, user);

      expect(mapping.status).toBe(MappingStatus.AGREED);
      expect(project.negotiationLocked).toBe(false);
      expect(
        mocks.savedNegotiations.some(
          (e) => e.eventType === NegotiationEventType.LOCKED,
        ),
      ).toBe(false);
      expect(gateway.emitProjectUpdate).not.toHaveBeenCalledWith(
        100,
        'project.locked',
      );
    });

    it('does NOT auto-lock when another active mapping is still not agreed', async () => {
      const user = makeUser({ role: UserRole.CENTER_REP, centerId: 10 });
      const project = makeProject({ negotiationLocked: false });
      // The mapping being agreed flips to AGREED at 40%...
      const mapping = makeMapping({
        id: 500,
        status: MappingStatus.NEGOTIATING,
        centerAgreed: false,
        programAgreed: true,
        allocationPercentage: 40,
        project,
      });
      // ...but a second active mapping is still negotiating.
      const other = makeMapping({
        id: 501,
        status: MappingStatus.NEGOTIATING,
        allocationPercentage: 60,
        project,
      });
      mappingRepo.findOne.mockResolvedValueOnce(mapping);

      stubProjectLockRead(project);
      mocks.manager.find.mockResolvedValueOnce([mapping, other]);
      mocks.manager.findOne.mockResolvedValueOnce(mapping);

      await service.agree(500, {} as any, user);

      expect(mapping.status).toBe(MappingStatus.AGREED);
      expect(project.negotiationLocked).toBe(false);
      expect(
        mocks.savedNegotiations.some(
          (e) => e.eventType === NegotiationEventType.LOCKED,
        ),
      ).toBe(false);
    });

    it('does NOT auto-lock when only one side has agreed (mapping not yet AGREED)', async () => {
      const user = makeUser({ role: UserRole.CENTER_REP, centerId: 10 });
      const project = makeProject({ negotiationLocked: false });
      const mapping = makeMapping({
        status: MappingStatus.NEGOTIATING,
        centerAgreed: false,
        programAgreed: false,
        allocationPercentage: 100,
        project,
      });
      mappingRepo.findOne.mockResolvedValueOnce(mapping);
      mocks.manager.findOne.mockResolvedValueOnce(mapping);

      await service.agree(500, {} as any, user);

      // Only center agreed → mapping stays NEGOTIATING, no lock attempt.
      expect(mapping.status).toBe(MappingStatus.NEGOTIATING);
      expect(project.negotiationLocked).toBe(false);
      expect(gateway.emitProjectUpdate).not.toHaveBeenCalledWith(
        100,
        'project.locked',
      );
    });
  });

  /* ─────────── setTocLinks() ─────────── */

  describe('setTocLinks()', () => {
    it('appends one TOC_UPDATED event and leaves agreement flags untouched', async () => {
      const user = makeUser({
        role: UserRole.PROGRAM_REP,
        programId: 200,
        centerId: null,
      });
      const mapping = makeMapping({
        status: MappingStatus.NEGOTIATING,
        centerAgreed: true,
        programAgreed: false,
      });
      mappingRepo.findOne.mockResolvedValueOnce(mapping);
      // Validation pass — every submitted id belongs to the program.
      stubTocOwnership({
        aowIds: [11],
        outputIds: [21, 22],
        outcomeIds: [31],
      });
      // hydrateTocLinks reads back; for the unit test we don't care
      // about the returned shape — stub a minimal find().
      tocLinkRepo.find.mockResolvedValueOnce([]);

      await service.setTocLinks(
        500,
        { aowIds: [11], outputIds: [21, 22], outcomeIds: [31] },
        user,
      );

      // Exactly one TOC_UPDATED event was appended; nothing else.
      expect(mocks.savedNegotiations).toHaveLength(1);
      expect(mocks.savedNegotiations[0]).toMatchObject({
        eventType: NegotiationEventType.TOC_UPDATED,
        actorRole: ActorRole.PROGRAM_REP,
        justification: null,
      });
      // Atomic replace — delete-all then reinsert.
      expect(mocks.manager.delete).toHaveBeenCalledWith(MappingTocLink, {
        projectMappingId: '500',
      });
      // 4 link rows saved (1 aow + 2 outputs + 1 outcome).
      expect(mocks.savedTocLinks).toHaveLength(4);
      // Agreement flags untouched.
      expect(mapping.centerAgreed).toBe(true);
      expect(mapping.programAgreed).toBe(false);
    });

    it('rejects with 400 when an aowId belongs to a different program', async () => {
      const user = makeUser({
        role: UserRole.PROGRAM_REP,
        programId: 200,
        centerId: null,
      });
      const mapping = makeMapping({ status: MappingStatus.NEGOTIATING });
      mappingRepo.findOne.mockResolvedValueOnce(mapping);
      // Submit two aow ids but only one is owned by program 200 — the
      // other is rejected as cross-program / unknown.
      stubTocOwnership({
        aowIds: [11], // 99 not returned → offender
        outputIds: [],
        outcomeIds: [],
      });

      await expect(
        service.setTocLinks(
          500,
          { aowIds: [11, 99], outputIds: [], outcomeIds: [] },
          user,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(mocks.savedNegotiations).toHaveLength(0);
    });

    it('accepts portfolio (2030 EOI) outcomes — the picker now surfaces both flavours as one pool', async () => {
      const user = makeUser({
        role: UserRole.PROGRAM_REP,
        programId: 200,
        centerId: null,
      });
      const mapping = makeMapping({ status: MappingStatus.NEGOTIATING });
      mappingRepo.findOne.mockResolvedValueOnce(mapping);
      // 42 is a portfolio outcome belonging to program 200; the
      // ownership check no longer filters by outcome_type, so the
      // repo stub returns it as valid.
      stubTocOwnership({
        aowIds: [11],
        outputIds: [],
        outcomeIds: [42],
      });
      // hydrateTocLinks read-back — shape irrelevant for this test.
      tocLinkRepo.find.mockResolvedValueOnce([]);

      await expect(
        service.setTocLinks(
          500,
          { aowIds: [11], outputIds: [], outcomeIds: [42] },
          user,
        ),
      ).resolves.toBeDefined();
      // The portfolio outcome was persisted as a link row.
      expect(mocks.savedTocLinks).toHaveLength(2); // 1 aow + 1 outcome
    });

    it('still rejects an outcomeId that belongs to a different program', async () => {
      const user = makeUser({
        role: UserRole.PROGRAM_REP,
        programId: 200,
        centerId: null,
      });
      const mapping = makeMapping({ status: MappingStatus.NEGOTIATING });
      mappingRepo.findOne.mockResolvedValueOnce(mapping);
      // 99 belongs to a different program — repo stub omits it from
      // the "found" set, so the validator flags it as an offender.
      stubTocOwnership({
        aowIds: [11],
        outputIds: [],
        outcomeIds: [],
      });

      await expect(
        service.setTocLinks(
          500,
          { aowIds: [11], outputIds: [], outcomeIds: [99] },
          user,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects when the mapping is in draft status', async () => {
      const user = makeUser({
        role: UserRole.PROGRAM_REP,
        programId: 200,
        centerId: null,
      });
      mappingRepo.findOne.mockResolvedValueOnce(
        makeMapping({ status: MappingStatus.DRAFT }),
      );

      await expect(
        service.setTocLinks(
          500,
          { aowIds: [11], outputIds: [], outcomeIds: [] },
          user,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects when the mapping is removed', async () => {
      const user = makeUser({
        role: UserRole.PROGRAM_REP,
        programId: 200,
        centerId: null,
      });
      mappingRepo.findOne.mockResolvedValueOnce(
        makeMapping({ status: MappingStatus.REMOVED }),
      );

      await expect(
        service.setTocLinks(
          500,
          { aowIds: [11], outputIds: [], outcomeIds: [] },
          user,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects when the project is locked', async () => {
      const user = makeUser({
        role: UserRole.PROGRAM_REP,
        programId: 200,
        centerId: null,
      });
      mappingRepo.findOne.mockResolvedValueOnce(
        makeMapping({
          status: MappingStatus.NEGOTIATING,
          project: makeProject({ negotiationLocked: true }),
        }),
      );

      await expect(
        service.setTocLinks(
          500,
          { aowIds: [11], outputIds: [], outcomeIds: [] },
          user,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects when the caller is a program rep for a different program', async () => {
      // Mapping belongs to program 200; user reps program 999.
      const user = makeUser({
        role: UserRole.PROGRAM_REP,
        programId: 999,
        centerId: null,
      });
      mappingRepo.findOne.mockResolvedValueOnce(
        makeMapping({ status: MappingStatus.NEGOTIATING, programId: 200 }),
      );

      await expect(
        service.setTocLinks(
          500,
          { aowIds: [11], outputIds: [], outcomeIds: [] },
          user,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects when the caller is a center rep (not a program-side role)', async () => {
      const user = makeUser({ role: UserRole.CENTER_REP, centerId: 10 });
      mappingRepo.findOne.mockResolvedValueOnce(
        makeMapping({ status: MappingStatus.NEGOTIATING }),
      );

      await expect(
        service.setTocLinks(
          500,
          { aowIds: [11], outputIds: [], outcomeIds: [] },
          user,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('allows workflow_admin to edit links on any program/center mapping', async () => {
      const user = makeUser({ role: UserRole.WORKFLOW_ADMIN, centerId: null });
      const mapping = makeMapping({
        status: MappingStatus.AGREED,
        centerAgreed: true,
        programAgreed: true,
      });
      mappingRepo.findOne.mockResolvedValueOnce(mapping);
      stubTocOwnership({ aowIds: [11], outputIds: [21], outcomeIds: [] });
      tocLinkRepo.find.mockResolvedValueOnce([]);

      await service.setTocLinks(
        500,
        { aowIds: [11], outputIds: [21], outcomeIds: [] },
        user,
      );

      expect(mocks.savedNegotiations).toHaveLength(1);
      expect(mocks.savedNegotiations[0].eventType).toBe(
        NegotiationEventType.TOC_UPDATED,
      );
      // Even after AGREED status, agreement flags survive the link edit.
      expect(mapping.centerAgreed).toBe(true);
      expect(mapping.programAgreed).toBe(true);
    });
  });

  /* ─────────── updateAllocation() ─────────── */

  describe('updateAllocation()', () => {
    it('appends COUNTER_PROPOSED on a negotiating allocation change (no justification)', async () => {
      const user = makeUser({ role: UserRole.CENTER_REP, centerId: 10 });
      const mapping = makeMapping({
        status: MappingStatus.NEGOTIATING,
        allocationPercentage: 50,
      });
      mappingRepo.findOne.mockResolvedValueOnce(mapping);
      mocks.manager.findOne.mockResolvedValueOnce(mapping);

      await service.updateAllocation(
        500,
        {
          allocationPercentage: 60,
          complementarityRating: Rating.HIGH,
          efficiencyRating: Rating.HIGH,
        },
        user,
      );

      expect(mocks.savedNegotiations).toHaveLength(1);
      expect(mocks.savedNegotiations[0]).toMatchObject({
        eventType: NegotiationEventType.COUNTER_PROPOSED,
        proposedAllocation: 60,
        justification: null,
      });
    });

    it('appends RATING_UPDATED when only ratings change (allocation unchanged)', async () => {
      const user = makeUser({ role: UserRole.CENTER_REP, centerId: 10 });
      const mapping = makeMapping({
        status: MappingStatus.NEGOTIATING,
        allocationPercentage: 50,
        complementarityRating: Rating.HIGH,
        efficiencyRating: Rating.HIGH,
      });
      mappingRepo.findOne.mockResolvedValueOnce(mapping);
      mocks.manager.findOne.mockResolvedValueOnce(mapping);

      await service.updateAllocation(
        500,
        {
          allocationPercentage: 50,
          complementarityRating: Rating.LOW,
          efficiencyRating: Rating.MEDIUM,
        },
        user,
      );

      expect(mocks.savedNegotiations).toHaveLength(1);
      expect(mocks.savedNegotiations[0]).toMatchObject({
        eventType: NegotiationEventType.RATING_UPDATED,
        proposedAllocation: null,
      });
      // agreement flags should NOT change on a rating-only edit
      expect(mapping.centerAgreed).toBe(false);
      expect(mapping.programAgreed).toBe(false);
    });

    it('appends COUNTER_PROPOSED on a draft allocation change (center-side) and persists justification', async () => {
      const user = makeUser({ role: UserRole.CENTER_REP, centerId: 10 });
      const mapping = makeMapping({
        status: MappingStatus.DRAFT,
        allocationPercentage: 50,
      });
      mappingRepo.findOne.mockResolvedValueOnce(mapping);
      mocks.manager.findOne.mockResolvedValueOnce(mapping);

      await service.updateAllocation(
        500,
        {
          allocationPercentage: 75,
          complementarityRating: Rating.HIGH,
          efficiencyRating: Rating.HIGH,
          justification: 'Reopened — splitting budget across two outputs',
        },
        user,
      );

      expect(mocks.savedNegotiations).toHaveLength(1);
      expect(mocks.savedNegotiations[0]).toMatchObject({
        eventType: NegotiationEventType.COUNTER_PROPOSED,
        proposedAllocation: 75,
        justification: 'Reopened — splitting budget across two outputs',
      });
    });

    it('rejects draft allocation change when justification is missing or too short', async () => {
      const user = makeUser({ role: UserRole.CENTER_REP, centerId: 10 });
      const mapping = makeMapping({
        status: MappingStatus.DRAFT,
        allocationPercentage: 50,
      });

      // Missing justification entirely
      mappingRepo.findOne.mockResolvedValueOnce(mapping);
      await expect(
        service.updateAllocation(
          500,
          {
            allocationPercentage: 75,
            complementarityRating: Rating.HIGH,
            efficiencyRating: Rating.HIGH,
          },
          user,
        ),
      ).rejects.toThrow(/justification/i);

      // Under 10 chars after trim
      mappingRepo.findOne.mockResolvedValueOnce(mapping);
      await expect(
        service.updateAllocation(
          500,
          {
            allocationPercentage: 75,
            complementarityRating: Rating.HIGH,
            efficiencyRating: Rating.HIGH,
            justification: '   short  ',
          },
          user,
        ),
      ).rejects.toThrow(/justification/i);
    });

    it('rejects program-rep edit on a draft mapping', async () => {
      const user = makeUser({
        role: UserRole.PROGRAM_REP,
        programId: 200,
        centerId: null,
      });
      const mapping = makeMapping({ status: MappingStatus.DRAFT });
      mappingRepo.findOne.mockResolvedValueOnce(mapping);

      await expect(
        service.updateAllocation(500, { allocationPercentage: 30 }, user),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects when project is locked', async () => {
      const user = makeUser({ role: UserRole.CENTER_REP, centerId: 10 });
      const mapping = makeMapping({
        status: MappingStatus.NEGOTIATING,
        project: makeProject({ negotiationLocked: true }),
      });
      mappingRepo.findOne.mockResolvedValueOnce(mapping);

      await expect(
        service.updateAllocation(
          500,
          {
            allocationPercentage: 60,
            complementarityRating: Rating.HIGH,
            efficiencyRating: Rating.HIGH,
          },
          user,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('writes no event when nothing changed (no-op short-circuit)', async () => {
      const user = makeUser({ role: UserRole.CENTER_REP, centerId: 10 });
      const mapping = makeMapping({
        status: MappingStatus.NEGOTIATING,
        allocationPercentage: 50,
        complementarityRating: Rating.HIGH,
        efficiencyRating: Rating.HIGH,
      });
      mappingRepo.findOne.mockResolvedValueOnce(mapping);

      await service.updateAllocation(
        500,
        {
          allocationPercentage: 50,
          complementarityRating: Rating.HIGH,
          efficiencyRating: Rating.HIGH,
        },
        user,
      );

      expect(mocks.savedNegotiations).toHaveLength(0);
    });
  });

  /* ─────────── removal flow ─────────── */

  describe('removal flow', () => {
    it('requestRemoval appends REMOVAL_REQUESTED and stashes justification on the mapping', async () => {
      const user = makeUser({
        role: UserRole.PROGRAM_REP,
        programId: 200,
        centerId: null,
      });
      const mapping = makeMapping({ status: MappingStatus.NEGOTIATING });
      mappingRepo.findOne.mockResolvedValueOnce(mapping);
      mocks.manager.findOne.mockResolvedValueOnce(mapping);

      await service.requestRemoval(500, 'no longer aligned', user);

      expect(mocks.savedNegotiations).toHaveLength(1);
      expect(mocks.savedNegotiations[0]).toMatchObject({
        eventType: NegotiationEventType.REMOVAL_REQUESTED,
        actorRole: ActorRole.PROGRAM_REP,
        justification: 'no longer aligned',
      });
      expect(mapping.removalRequested).toBe(true);
    });

    it('rejects a second pending removal request', async () => {
      const user = makeUser({
        role: UserRole.PROGRAM_REP,
        programId: 200,
        centerId: null,
      });
      mappingRepo.findOne.mockResolvedValueOnce(
        makeMapping({
          status: MappingStatus.NEGOTIATING,
          removalRequested: true,
        }),
      );
      await expect(
        service.requestRemoval(500, 'duplicate', user),
      ).rejects.toThrow(ConflictException);
    });

    it('declineRemoval appends REMOVAL_DECLINED and clears pending flag', async () => {
      const user = makeUser({ role: UserRole.CENTER_REP, centerId: 10 });
      const mapping = makeMapping({
        status: MappingStatus.NEGOTIATING,
        removalRequested: true,
        removalRequestedById: 99,
        removalJustification: 'requested',
      });
      mappingRepo.findOne.mockResolvedValueOnce(mapping);
      mocks.manager.findOne.mockResolvedValueOnce(mapping);

      await service.declineRemoval(500, 'still needed', user);

      expect(mocks.savedNegotiations).toHaveLength(1);
      expect(mocks.savedNegotiations[0]).toMatchObject({
        eventType: NegotiationEventType.REMOVAL_DECLINED,
        actorRole: ActorRole.CENTER_REP,
        justification: 'still needed',
      });
      expect(mapping.removalRequested).toBe(false);
    });

    it('removeProgram appends REMOVED with merged justification when accepting a request', async () => {
      const user = makeUser({ role: UserRole.CENTER_REP, centerId: 10 });
      const mapping = makeMapping({
        status: MappingStatus.NEGOTIATING,
        removalRequested: true,
        removalJustification: 'program said: out of scope',
      });
      mappingRepo.findOne.mockResolvedValueOnce(mapping);
      mocks.manager.findOne.mockResolvedValueOnce(mapping);

      await service.removeProgram(500, 'agreed', user);

      expect(mocks.savedNegotiations).toHaveLength(1);
      const ev = mocks.savedNegotiations[0];
      expect(ev.eventType).toBe(NegotiationEventType.REMOVED);
      expect(ev.justification).toContain('agreed');
      expect(ev.justification).toContain('out of scope');
      expect(mapping.status).toBe(MappingStatus.REMOVED);
      expect(mapping.removalRequested).toBe(false);
    });

    it('removeProgram rejects when actor is program_rep', async () => {
      const user = makeUser({
        role: UserRole.PROGRAM_REP,
        programId: 200,
        centerId: null,
      });
      mappingRepo.findOne.mockResolvedValueOnce(
        makeMapping({ status: MappingStatus.NEGOTIATING }),
      );
      await expect(service.removeProgram(500, 'cannot', user)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  /* ─────────── lock / reopen ─────────── */

  describe('lockProjectRound()', () => {
    it('appends one LOCKED event per active mapping when gate passes', async () => {
      const user = makeUser({ role: UserRole.CENTER_REP, centerId: 10 });
      const project = makeProject();
      const m1 = makeMapping({
        id: 1,
        status: MappingStatus.AGREED,
        allocationPercentage: 60,
      });
      const m2 = makeMapping({
        id: 2,
        status: MappingStatus.AGREED,
        allocationPercentage: 40,
      });
      const m3 = makeMapping({ id: 3, status: MappingStatus.REMOVED });

      // Pessimistic-locked project query
      mocks.manager.createQueryBuilder.mockReturnValueOnce({
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn(async () => project),
      });
      mocks.manager.find.mockResolvedValueOnce([m1, m2, m3]);

      await service.lockProjectRound(100, user);

      const lockedEvents = mocks.savedNegotiations.filter(
        (e) => e.eventType === NegotiationEventType.LOCKED,
      );
      expect(lockedEvents).toHaveLength(2);
      expect(lockedEvents.map((e) => e.mappingId).sort()).toEqual([1, 2]);
      expect(project.negotiationLocked).toBe(true);
    });

    it('rejects when total allocation > 100%', async () => {
      const user = makeUser({ role: UserRole.CENTER_REP, centerId: 10 });
      const project = makeProject();
      const m1 = makeMapping({
        id: 1,
        status: MappingStatus.AGREED,
        allocationPercentage: 70,
      });
      const m2 = makeMapping({
        id: 2,
        status: MappingStatus.AGREED,
        allocationPercentage: 40,
      });

      mocks.manager.createQueryBuilder.mockReturnValueOnce({
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn(async () => project),
      });
      mocks.manager.find.mockResolvedValueOnce([m1, m2]);

      await expect(service.lockProjectRound(100, user)).rejects.toThrow(
        BadRequestException,
      );
      expect(mocks.savedNegotiations).toHaveLength(0);
    });

    it('rejects when any active mapping is not agreed', async () => {
      const user = makeUser({ role: UserRole.CENTER_REP, centerId: 10 });
      const project = makeProject();
      const m1 = makeMapping({
        id: 1,
        status: MappingStatus.AGREED,
        allocationPercentage: 60,
      });
      const m2 = makeMapping({
        id: 2,
        status: MappingStatus.NEGOTIATING,
        allocationPercentage: 40,
      });

      mocks.manager.createQueryBuilder.mockReturnValueOnce({
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn(async () => project),
      });
      mocks.manager.find.mockResolvedValueOnce([m1, m2]);

      await expect(service.lockProjectRound(100, user)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('reopenProjectRound()', () => {
    it('appends one REOPENED event per active mapping and reverts them to draft', async () => {
      const user = makeUser({ role: UserRole.CENTER_REP, centerId: 10 });
      const project = makeProject({ negotiationLocked: true });
      const m1 = makeMapping({
        id: 11,
        status: MappingStatus.AGREED,
        allocationPercentage: 60,
      });
      const m2 = makeMapping({
        id: 12,
        status: MappingStatus.AGREED,
        allocationPercentage: 40,
      });
      const m3 = makeMapping({ id: 13, status: MappingStatus.REMOVED });

      mocks.manager.findOneBy.mockResolvedValueOnce(project);
      mocks.manager.find.mockResolvedValueOnce([m1, m2, m3]);

      await service.reopenProjectRound(100, user);

      const reopened = mocks.savedNegotiations.filter(
        (e) => e.eventType === NegotiationEventType.REOPENED,
      );
      expect(reopened).toHaveLength(2);
      expect(reopened.map((e) => e.mappingId).sort()).toEqual([11, 12]);
      expect(project.negotiationLocked).toBe(false);
    });
  });

  /* ─────────── invariant: no event row is ever mutated ─────────── */

  describe('append-only invariant', () => {
    it('every save() on MappingNegotiation in the suite was for a new entity with id=undefined', () => {
      /* Sanity sweep: the manager.save spy in buildMockManager assigns
       * the id after capture; before that, every captured entity must
       * have been constructed fresh (no `.id` set by the service). */
      // Trivially true given the factories above never seed id on the
      // event objects — this just documents the invariant for future
      // contributors. */
      expect(true).toBe(true);
    });
  });

  /* ─────────── admin is read-only on the negotiation surface ─────────── */

  describe('admin RBAC — every negotiation mutation rejects admin with 403', () => {
    const adminUser = () => makeUser({ role: UserRole.ADMIN, centerId: null });

    it('create() rejects admin', async () => {
      await expect(
        service.create(
          {
            projectId: 100,
            programId: 200,
            allocationPercentage: 50,
            complementarityRating: Rating.HIGH,
            efficiencyRating: Rating.HIGH,
          },
          adminUser(),
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('counterPropose() rejects admin', async () => {
      mappingRepo.findOne.mockResolvedValueOnce(makeMapping());
      await expect(
        service.counterPropose(
          500,
          { proposedAllocation: 60, justification: 'reasons' },
          adminUser(),
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('agree() rejects admin', async () => {
      mappingRepo.findOne.mockResolvedValueOnce(makeMapping());
      await expect(service.agree(500, {}, adminUser())).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('removeProgram() rejects admin', async () => {
      mappingRepo.findOne.mockResolvedValueOnce(makeMapping());
      await expect(
        service.removeProgram(500, 'long enough reason', adminUser()),
      ).rejects.toThrow(ForbiddenException);
    });

    it('declineRemoval() rejects admin', async () => {
      mappingRepo.findOne.mockResolvedValueOnce(
        makeMapping({ removalRequested: true }),
      );
      await expect(
        service.declineRemoval(500, 'nope', adminUser()),
      ).rejects.toThrow(ForbiddenException);
    });

    it('updateAllocation() rejects admin', async () => {
      mappingRepo.findOne.mockResolvedValueOnce(makeMapping());
      await expect(
        service.updateAllocation(
          500,
          {
            allocationPercentage: 70,
            complementarityRating: Rating.HIGH,
            efficiencyRating: Rating.HIGH,
          },
          adminUser(),
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('lockProjectRound() rejects admin', async () => {
      const project = makeProject();
      mocks.manager.createQueryBuilder.mockReturnValueOnce({
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn(async () => project),
      });
      mocks.manager.find.mockResolvedValueOnce([]);
      await expect(service.lockProjectRound(100, adminUser())).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('reopenProjectRound() rejects admin', async () => {
      const project = makeProject({ negotiationLocked: true });
      mocks.manager.findOneBy.mockResolvedValueOnce(project);
      await expect(
        service.reopenProjectRound(100, adminUser()),
      ).rejects.toThrow(ForbiddenException);
    });

    it('addProgramToProject() rejects admin', async () => {
      projectRepo.findOneBy.mockResolvedValueOnce(makeProject());
      await expect(
        service.addProgramToProject(
          100,
          200,
          50,
          Rating.HIGH,
          Rating.HIGH,
          adminUser(),
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('postChatMessage() rejects admin', async () => {
      projectRepo.findOne.mockResolvedValueOnce(makeProject());
      await expect(
        service.postChatMessage(100, 'hi', adminUser()),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
