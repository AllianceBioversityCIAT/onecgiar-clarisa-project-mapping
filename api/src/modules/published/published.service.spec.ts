import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { PublishedService } from './published.service';
import { PublishedSnapshot } from './entities/published-snapshot.entity';
import { PublishedProject } from './entities/published-project.entity';
import { Project } from '../projects/entities/project.entity';
import { ProjectMapping } from '../mappings/entities/project-mapping.entity';
import { ProjectStatus } from '../projects/enums/project-status.enum';
import { MappingStatus } from '../mappings/enums/mapping-status.enum';
import { MappingsService } from '../mappings/mappings.service';
import { AuditService } from '../audit/audit.service';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/enums/user-role.enum';

/**
 * Unit tests for the snapshot builder — no database.
 *
 * What matters here is the *selection rule* (only locked projects, only
 * settled mappings) and the *payload contract* the public endpoints hand
 * to unauthenticated consumers. Both were previously untested, and both
 * are easy to regress: the lock predicate is one `andWhere` away from
 * publishing mid-negotiation allocations to the world.
 */
describe('PublishedService', () => {
  let service: PublishedService;
  let projectQb: any;
  let mappingQb: any;
  let managerMock: any;
  let snapshotRepo: any;
  let publishedProjectRepo: any;
  let publishedProjectsQb: any;
  let mappingsService: jest.Mocked<
    Pick<MappingsService, 'hydrateTocLinksForMappings'>
  >;

  const actor = { id: 7, role: UserRole.ADMIN } as User;

  /** Chain-friendly SELECT QueryBuilder mock; every call returns itself. */
  const buildSelectQb = (rows: unknown[]): any => {
    const qb: any = {};
    qb.leftJoinAndSelect = jest.fn().mockReturnValue(qb);
    qb.where = jest.fn().mockReturnValue(qb);
    qb.andWhere = jest.fn().mockReturnValue(qb);
    qb.getMany = jest.fn().mockResolvedValue(rows);
    return qb;
  };

  /** Minimal locked, active project with one benefit country. */
  const buildProject = (overrides: Partial<Project> = {}): any => ({
    id: 1,
    code: 'P-001',
    name: 'Locked project',
    description: 'desc',
    summary: 'exec summary',
    category: 'Restricted',
    natureOfFunder: 'Foundation',
    isBenefitGlobal: false,
    isImplementationGlobal: true,
    status: ProjectStatus.ACTIVE,
    totalBudget: '1000.00',
    fundingSource: 'window3',
    funder: 'Some funder',
    startDate: null,
    endDate: null,
    negotiationLocked: true,
    center: { name: 'Alliance', acronym: 'ABC' },
    benefitCountries: [
      {
        allocationPercentage: '100.00',
        country: { name: 'Kenya', isoAlpha2: 'KE' },
      },
    ],
    implementationCountries: [],
    ...overrides,
  });

  const buildMapping = (overrides: Record<string, unknown> = {}): any => ({
    id: 11,
    projectId: 1,
    programId: 55,
    allocationPercentage: '40.00',
    status: MappingStatus.AGREED,
    complementarityRating: 'high',
    efficiencyRating: 'medium',
    program: { name: 'Program A', officialCode: 'SP01' },
    ...overrides,
  });

  /**
   * Runs createSnapshot with the given fixtures and returns the rows the
   * service handed to `manager.save(PublishedProject, ...)`.
   */
  const publish = async (projects: any[], mappings: any[]) => {
    projectQb.getMany.mockResolvedValue(projects);
    mappingQb.getMany.mockResolvedValue(mappings);
    await service.createSnapshot(actor, { versionLabel: 'v1' });

    const projectSave = managerMock.save.mock.calls.find(
      (call: unknown[]) => call[0] === PublishedProject,
    );
    const snapshotSave = managerMock.save.mock.calls.find(
      (call: unknown[]) => call[0] === PublishedSnapshot,
    );
    return {
      publishedProjects: (projectSave?.[1] ?? []) as any[],
      snapshot: snapshotSave?.[1] as any,
    };
  };

  beforeEach(async () => {
    projectQb = buildSelectQb([]);
    mappingQb = buildSelectQb([]);

    snapshotRepo = { find: jest.fn().mockResolvedValue([]), findOne: jest.fn() };
    publishedProjectsQb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      offset: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    publishedProjectRepo = {
      createQueryBuilder: jest.fn(() => publishedProjectsQb),
    };

    /* Transaction manager: create() is identity-passthrough so tests can
     * inspect the exact payload the service built. */
    managerMock = {
      createQueryBuilder: jest.fn(() => {
        const qb: any = {};
        qb.update = jest.fn().mockReturnValue(qb);
        qb.set = jest.fn().mockReturnValue(qb);
        qb.where = jest.fn().mockReturnValue(qb);
        qb.execute = jest.fn().mockResolvedValue(undefined);
        return qb;
      }),
      create: jest.fn((_entity: unknown, input: unknown) => input),
      save: jest.fn((_entity: unknown, input: any) =>
        Promise.resolve(Array.isArray(input) ? input : { id: 99, ...input }),
      ),
      findOneOrFail: jest.fn().mockResolvedValue({
        id: 99,
        versionLabel: 'v1',
        projectCount: 0,
      }),
    };

    const dataSourceMock: any = {
      transaction: jest.fn((cb: (m: unknown) => unknown) => cb(managerMock)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PublishedService,
        {
          provide: getRepositoryToken(PublishedSnapshot),
          useValue: snapshotRepo as unknown as Repository<PublishedSnapshot>,
        },
        {
          provide: getRepositoryToken(PublishedProject),
          useValue:
            publishedProjectRepo as unknown as Repository<PublishedProject>,
        },
        {
          provide: getRepositoryToken(Project),
          useValue: { createQueryBuilder: jest.fn(() => projectQb) },
        },
        {
          provide: getRepositoryToken(ProjectMapping),
          useValue: { createQueryBuilder: jest.fn(() => mappingQb) },
        },
        { provide: DataSource, useValue: dataSourceMock },
        { provide: AuditService, useValue: { record: jest.fn() } },
        {
          provide: MappingsService,
          useValue: {
            hydrateTocLinksForMappings: jest.fn().mockResolvedValue(new Map()),
          },
        },
      ],
    }).compile();

    service = module.get<PublishedService>(PublishedService);
    mappingsService = module.get(MappingsService);
  });

  describe('project selection', () => {
    it('publishes only projects whose negotiation round is locked', async () => {
      await publish([], []);

      expect(projectQb.where).toHaveBeenCalledWith('project.status = :status', {
        status: ProjectStatus.ACTIVE,
      });
      expect(projectQb.andWhere).toHaveBeenCalledWith(
        'project.negotiationLocked = :locked',
        { locked: true },
      );
    });

    it('counts only locked projects in the snapshot totals', async () => {
      const { snapshot } = await publish(
        [buildProject(), buildProject({ id: 2, code: 'P-002' })],
        [],
      );

      expect(snapshot.projectCount).toBe(2);
      expect(snapshot.totalBudget).toBe(2000);
    });

    it('skips the mapping query entirely when nothing is locked', async () => {
      const { publishedProjects } = await publish([], []);

      expect(mappingQb.getMany).not.toHaveBeenCalled();
      expect(publishedProjects).toEqual([]);
    });
  });

  describe('mapping selection', () => {
    it('includes agreed AND admin_decision mappings', async () => {
      await publish([buildProject()], []);

      expect(mappingQb.andWhere).toHaveBeenCalledWith(
        'mapping.status IN (:...statuses)',
        { statuses: [MappingStatus.AGREED, MappingStatus.ADMIN_DECISION] },
      );
    });

    it('carries an admin_decision mapping into the payload', async () => {
      const { publishedProjects } = await publish(
        [buildProject()],
        [buildMapping({ status: MappingStatus.ADMIN_DECISION })],
      );

      expect(publishedProjects[0].mappings).toHaveLength(1);
      expect(publishedProjects[0].mappings[0].status).toBe(
        MappingStatus.ADMIN_DECISION,
      );
    });
  });

  describe('payload', () => {
    it('precomputes each program share of the project budget', async () => {
      const { publishedProjects, snapshot } = await publish(
        [buildProject()],
        [
          buildMapping({ id: 11, allocationPercentage: '40.00' }),
          buildMapping({
            id: 12,
            allocationPercentage: '60.00',
            program: { name: 'Program B', officialCode: 'SP02' },
          }),
        ],
      );

      const [a, b] = publishedProjects[0].mappings;
      expect(a.allocatedBudget).toBe(400);
      expect(b.allocatedBudget).toBe(600);
      expect(a.programId).toBe(55);

      /* Per-program rollup uses the allocated share, never the raw
       * project budget — otherwise a 2-program project double-counts. */
      const byProgram = snapshot.summaryStats.projectsByProgram;
      expect(byProgram).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'SP01', allocatedBudget: 400 }),
          expect.objectContaining({ code: 'SP02', allocatedBudget: 600 }),
        ]),
      );
    });

    it('embeds the TOC contribution captured on each mapping', async () => {
      mappingsService.hydrateTocLinksForMappings.mockResolvedValue(
        new Map([
          [
            11,
            {
              aows: [
                {
                  id: 3,
                  nodeId: 'n-3',
                  name: 'Inclusive Delivery',
                  acronym: 'AOW03',
                  wpOfficialCode: 'SP01-AOW03',
                },
              ],
              outputs: [
                {
                  id: 8,
                  nodeId: 'n-8',
                  title: 'Output title',
                  typeOfOutput: 'Knowledge product',
                },
              ],
              outcomes: [{ id: 9, nodeId: 'n-9', title: 'Outcome title' }],
            } as any,
          ],
        ]),
      );

      const { publishedProjects } = await publish(
        [buildProject()],
        [buildMapping()],
      );

      const toc = publishedProjects[0].mappings[0].toc;
      expect(toc.aows).toEqual([
        {
          id: 3,
          nodeId: 'n-3',
          title: 'Inclusive Delivery',
          code: 'SP01-AOW03',
          type: null,
        },
      ]);
      expect(toc.outputs[0]).toMatchObject({
        title: 'Output title',
        type: 'Knowledge product',
      });
      expect(toc.outcomes[0]).toMatchObject({ title: 'Outcome title' });
    });

    it('emits empty TOC arrays for mappings with no links', async () => {
      const { publishedProjects } = await publish(
        [buildProject()],
        [buildMapping()],
      );

      expect(publishedProjects[0].mappings[0].toc).toEqual({
        aows: [],
        outputs: [],
        outcomes: [],
      });
    });

    it('captures the details block the original payload was missing', async () => {
      const { publishedProjects } = await publish(
        [
          buildProject({
            implementationCountries: [
              {
                allocationPercentage: '60.00',
                country: { name: 'Peru', isoAlpha2: 'PE' },
              },
            ],
          } as any),
        ],
        [],
      );

      expect(publishedProjects[0].details).toEqual({
        summary: 'exec summary',
        category: 'Restricted',
        natureOfFunder: 'Foundation',
        isBenefitGlobal: false,
        isImplementationGlobal: true,
        implementationCountries: [
          { name: 'Peru', isoAlpha2: 'PE', allocationPercentage: 60 },
        ],
      });
    });

    it('keeps Location of Benefit on the top-level countries column', async () => {
      const { publishedProjects } = await publish([buildProject()], []);

      expect(publishedProjects[0].countries).toEqual([
        { name: 'Kenya', isoAlpha2: 'KE', allocationPercentage: 100 },
      ]);
    });
  });

  /*
   * Both endpoints below are @Public(). The snapshot list joins the
   * publisher's `User` row, so an entity returned as-is would serialise
   * that account — email included — to anonymous callers.
   */
  describe('public read payloads', () => {
    const buildSnapshotRow = (overrides: Record<string, unknown> = {}): any => ({
      id: 3,
      versionLabel: 'v3',
      description: 'Third release',
      publishedAt: new Date('2026-08-04T10:00:00Z'),
      projectCount: 12,
      totalBudget: 4200,
      isActive: true,
      summaryStats: { projectsByCenter: [], projectsByProgram: [] },
      createdByRole: 'admin',
      publishedBy: {
        id: 7,
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'ada@cgiar.org',
        role: UserRole.ADMIN,
        centerId: 4,
      },
      ...overrides,
    });

    it('reduces the publisher to a display name on the snapshot list', async () => {
      snapshotRepo.find.mockResolvedValue([buildSnapshotRow()]);

      const [row] = await service.listSnapshots();

      expect(row.publishedBy).toEqual({
        firstName: 'Ada',
        lastName: 'Lovelace',
      });
      /* Nothing that identifies the account may survive the mapping. */
      expect(JSON.stringify(row)).not.toContain('ada@cgiar.org');
      expect(row).not.toHaveProperty('summaryStats');
      expect(row).not.toHaveProperty('createdByRole');
    });

    it('tolerates a snapshot whose publisher account is gone', async () => {
      snapshotRepo.find.mockResolvedValue([
        buildSnapshotRow({ publishedBy: null }),
      ]);

      const [row] = await service.listSnapshots();

      expect(row.publishedBy).toBeNull();
      expect(row.versionLabel).toBe('v3');
    });

    it('reduces the publisher to a display name on the latest snapshot', () => {
      const summary = service.toSnapshotSummary(buildSnapshotRow());

      expect(summary.publishedBy).toEqual({
        firstName: 'Ada',
        lastName: 'Lovelace',
      });
      /* /published/latest is unauthenticated — the account must not leak. */
      expect(JSON.stringify(summary)).not.toContain('ada@cgiar.org');
      expect(JSON.stringify(summary)).not.toContain(UserRole.ADMIN);
      expect(summary).not.toHaveProperty('publishedById');
      /* The home page's rollups still have to ride along. */
      expect(summary.summaryStats).toEqual({
        projectsByCenter: [],
        projectsByProgram: [],
      });
      expect(summary.isActive).toBe(true);
    });

    it('tolerates a latest snapshot whose publisher account is gone', () => {
      const summary = service.toSnapshotSummary(
        buildSnapshotRow({ publishedBy: null }),
      );

      expect(summary.publishedBy).toBeNull();
      expect(summary.versionLabel).toBe('v3');
    });

    it('stamps every projects page with the snapshot it was read from', async () => {
      const result = await service.getPublishedProjects(buildSnapshotRow(), {
        page: 2,
        limit: 10,
      } as any);

      expect(result.snapshot).toEqual({
        id: 3,
        versionLabel: 'v3',
        description: 'Third release',
        publishedAt: new Date('2026-08-04T10:00:00Z'),
        projectCount: 12,
        totalBudget: 4200,
      });
      expect(result.page).toBe(2);
      /* The page-level ref must stay lean — it repeats on every request. */
      expect(result.snapshot).not.toHaveProperty('publishedBy');
      expect(result.snapshot).not.toHaveProperty('summaryStats');
    });

    it('scopes the projects query to that snapshot id', async () => {
      await service.getPublishedProjects(buildSnapshotRow(), {
        page: 1,
        limit: 20,
      } as any);

      expect(publishedProjectsQb.where).toHaveBeenCalledWith(
        'pp.snapshotId = :snapshotId',
        { snapshotId: 3 },
      );
    });
  });
});
