import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { ProjectsService } from './projects.service';
import { Project } from './entities/project.entity';
import { ProjectBudget } from './entities/project-budget.entity';
import { Center } from '../reference-data/entities/center.entity';
import { Country } from '../reference-data/entities/country.entity';
import { NatureOfFunder } from './enums/nature-of-funder.enum';
import { ProjectCategory } from './enums/project-category.enum';
import { CspFlag } from './enums/csp-flag.enum';
import { FundingSource } from './enums/funding-source.enum';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';

/**
 * Builds a minimal mock entity manager that forwards calls to
 * the jest.fn stubs supplied by each test.
 */
function buildMockManager(overrides: Record<string, jest.Mock> = {}) {
  return {
    create: overrides.create ?? jest.fn((entity, data) => ({ ...data })),
    save: overrides.save ?? jest.fn(async (entity, obj) => obj ?? entity),
    findOne: overrides.findOne ?? jest.fn(async () => null),
    findOneBy: overrides.findOneBy ?? jest.fn(async () => null),
    findBy: overrides.findBy ?? jest.fn(async () => []),
    remove: overrides.remove ?? jest.fn(async () => undefined),
    delete: overrides.delete ?? jest.fn(async () => ({ affected: 0 })),
  };
}

/**
 * Wraps a mock manager inside a DataSource.transaction() stub so that
 * the callback receives the manager and the return value is forwarded.
 */
function buildMockDataSource(manager: ReturnType<typeof buildMockManager>) {
  return {
    transaction: jest.fn(async (cb: (m: unknown) => Promise<unknown>) =>
      cb(manager),
    ),
  };
}

/** Factory for a minimal Project entity with sane defaults. */
function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 1,
    code: 'TEST-001',
    name: 'Test Project',
    description: null,
    summary: null,
    startDate: null,
    endDate: null,
    totalBudget: 0,
    remainingBudget: 0,
    fundingSource: null,
    funder: null,
    status: 'active' as any,
    centerId: 1,
    createdById: 1,
    center: {} as any,
    createdBy: {} as any,
    benefitCountries: [],
    implementationCountries: [],
    isBenefitGlobal: false,
    isImplementationGlobal: false,
    budgets: [],
    funderPrimaryCenter: null,
    natureOfFunder: null,
    category: null,
    csp: null,
    cspNonCollectionReason: null,
    totalPledge: null,
    principalInvestigator: null,
    signedContractTitle: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('ProjectsService', () => {
  let service: ProjectsService;
  let projectRepo: jest.Mocked<Repository<Project>>;
  let centerRepo: jest.Mocked<Repository<Center>>;
  let countryRepo: jest.Mocked<Repository<Country>>;

  /* ------------------------------------------------------------------ */
  /* create() tests                                                       */
  /* ------------------------------------------------------------------ */

  describe('create()', () => {
    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [ProjectsService],
      })
        .useMocker((token) => {
          if (token === getRepositoryToken(Project)) {
            return { findOneBy: jest.fn(async () => null) };
          }
          if (token === getRepositoryToken(Center)) {
            return {
              findOneBy: jest.fn(async () => ({ id: 1 }) as Center),
            };
          }
          if (token === getRepositoryToken(Country)) {
            return { findBy: jest.fn(async () => []) };
          }
          if (token === DataSource) {
            /* Manager is reset per-test via module ref. Return a simple
             * passthrough — individual tests override via jest.spyOn. */
            return { transaction: jest.fn() };
          }
          return {};
        })
        .compile();

      service = module.get(ProjectsService);
      projectRepo = module.get(getRepositoryToken(Project));
      centerRepo = module.get(getRepositoryToken(Center));
      countryRepo = module.get(getRepositoryToken(Country));
    });

    it('persists all 8 optional project-info fields when provided', async () => {
      /* Arrange */
      const dto: CreateProjectDto = {
        code: 'TEST-INFO-01',
        name: 'Info Fields Project',
        totalBudget: 100000,
        centerId: 1,
        funderPrimaryCenter: 'BMGF',
        natureOfFunder: NatureOfFunder.FOUNDATION,
        category: ProjectCategory.RESTRICTED,
        csp: CspFlag.NO,
        cspNonCollectionReason: 'Not applicable for this grant',
        totalPledge: 200000,
        principalInvestigator: 'DOE, JANE',
        signedContractTitle: 'Grant Agreement 2026-001',
      };

      const savedProject = makeProject({
        code: dto.code,
        funderPrimaryCenter: 'BMGF',
        natureOfFunder: NatureOfFunder.FOUNDATION,
        category: ProjectCategory.RESTRICTED,
        csp: CspFlag.NO,
        cspNonCollectionReason: 'Not applicable for this grant',
        totalPledge: 200000,
        principalInvestigator: 'DOE, JANE',
        signedContractTitle: 'Grant Agreement 2026-001',
      });

      const manager = buildMockManager({
        create: jest.fn((_, data) => ({ ...data, id: 42 })),
        save: jest.fn(async (obj) => ({ ...obj, id: 42 })),
        findOneBy: jest.fn(async () => null),
        findBy: jest.fn(async () => []),
      });
      const dataSource = module_get_datasource();
      (dataSource.transaction as jest.Mock).mockImplementation(async (cb) => {
        const result = await cb(manager);
        return result;
      });

      jest.spyOn(service as any, 'findOne').mockResolvedValue(savedProject);

      /* Act */
      const result = await service.create(dto, 1);

      /* Assert — the manager.create call should receive all 8 fields */
      expect(manager.create).toHaveBeenCalledWith(
        Project,
        expect.objectContaining({
          funderPrimaryCenter: 'BMGF',
          natureOfFunder: NatureOfFunder.FOUNDATION,
          category: ProjectCategory.RESTRICTED,
          csp: CspFlag.NO,
          cspNonCollectionReason: 'Not applicable for this grant',
          totalPledge: 200000,
          principalInvestigator: 'DOE, JANE',
          signedContractTitle: 'Grant Agreement 2026-001',
        }),
      );
      expect(result).toMatchObject({ code: 'TEST-INFO-01' });
    });

    it('attaches budget lines via cascade when budgets array is provided', async () => {
      const dto: CreateProjectDto = {
        code: 'TEST-BUDGET-01',
        name: 'Budget Lines Project',
        totalBudget: 500000,
        centerId: 1,
        budgets: [
          {
            year: 'FY25',
            version: 'FPC-I',
            account: 'Staff Costs',
            amount: 100000,
          },
          { year: 'FY25', version: 'FPC-I', account: 'Travel', amount: 25000 },
          {
            year: 'FY26',
            version: 'FPC-II',
            account: 'Staff Costs',
            amount: 120000,
          },
        ],
      };

      const createdBudgets: ProjectBudget[] = [];
      const manager = buildMockManager({
        create: jest.fn((entity, data) => {
          const obj = { ...data };
          if (entity === ProjectBudget)
            createdBudgets.push(obj as ProjectBudget);
          return obj;
        }),
        save: jest.fn(async (obj) => ({ ...obj, id: 1 })),
        findOneBy: jest.fn(async () => null),
        findBy: jest.fn(async () => []),
      });
      const dataSource = module_get_datasource();
      (dataSource.transaction as jest.Mock).mockImplementation(async (cb) =>
        cb(manager),
      );

      const savedProject = makeProject({
        code: dto.code,
        budgets: createdBudgets as any,
      });
      jest.spyOn(service as any, 'findOne').mockResolvedValue(savedProject);

      await service.create(dto, 1);

      /* Three ProjectBudget rows should have been created */
      expect(createdBudgets).toHaveLength(3);
      expect(createdBudgets[0]).toMatchObject({
        year: 'FY25',
        account: 'Staff Costs',
        amount: 100000,
      });
      expect(createdBudgets[2]).toMatchObject({
        year: 'FY26',
        account: 'Staff Costs',
        amount: 120000,
      });
    });

    it('throws NotFoundException when center does not exist', async () => {
      (centerRepo.findOneBy as jest.Mock).mockResolvedValue(null);

      await expect(
        service.create(
          { code: 'X', name: 'X', totalBudget: 0, centerId: 999 },
          1,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws ConflictException on duplicate project code', async () => {
      (projectRepo.findOneBy as jest.Mock).mockResolvedValue(makeProject());

      await expect(
        service.create(
          { code: 'TEST-001', name: 'Dup', totalBudget: 0, centerId: 1 },
          1,
        ),
      ).rejects.toThrow(ConflictException);
    });

    /* Helper to retrieve the DataSource mock from the NestJS DI container.
     * Declared as a closure so each `it` can access the same module. */
    function module_get_datasource(): ReturnType<typeof buildMockDataSource> {
      return (service as any).dataSource as ReturnType<
        typeof buildMockDataSource
      >;
    }
  });

  /* ------------------------------------------------------------------ */
  /* update() budget diff tests                                           */
  /* ------------------------------------------------------------------ */

  describe('update() budget diff', () => {
    let dataSourceMock: ReturnType<typeof buildMockDataSource>;
    let manager: ReturnType<typeof buildMockManager>;

    /** Wires up a fresh module with fully controlled manager/dataSource stubs. */
    async function buildModule(
      existingProject: Project,
      managerOverrides: Record<string, jest.Mock> = {},
    ) {
      manager = buildMockManager({
        findOne: jest.fn(async () => existingProject),
        ...managerOverrides,
      });
      dataSourceMock = buildMockDataSource(manager);

      const module: TestingModule = await Test.createTestingModule({
        providers: [ProjectsService],
      })
        .useMocker((token) => {
          if (token === getRepositoryToken(Project))
            return { findOneBy: jest.fn() };
          if (token === getRepositoryToken(Center))
            return { findOneBy: jest.fn() };
          if (token === getRepositoryToken(Country))
            return { findBy: jest.fn() };
          if (token === DataSource) return dataSourceMock;
          return {};
        })
        .compile();

      service = module.get(ProjectsService);
      jest.spyOn(service as any, 'findOne').mockResolvedValue(existingProject);
    }

    it('empty budgets array clears all existing budget lines', async () => {
      const existing = makeProject({
        budgets: [
          {
            id: 10,
            year: 'FY25',
            version: 'v1',
            account: 'Staff',
            amount: 1000,
          } as ProjectBudget,
          {
            id: 11,
            year: 'FY25',
            version: 'v1',
            account: 'Travel',
            amount: 500,
          } as ProjectBudget,
        ],
      });
      await buildModule(existing);

      const dto: UpdateProjectDto = { budgets: [] };
      await service.update(1, dto);

      /* Both rows should have been passed to delete() by ID */
      expect(manager.delete).toHaveBeenCalledWith(
        ProjectBudget,
        expect.arrayContaining([10, 11]),
      );
    });

    it('rows without id are inserted as new budget lines', async () => {
      const existing = makeProject({ budgets: [] });
      await buildModule(existing);

      const dto: UpdateProjectDto = {
        budgets: [
          {
            year: 'FY26',
            version: 'FPC-I',
            account: 'Equipment',
            amount: 8000,
          },
        ],
      };
      await service.update(1, dto);

      expect(manager.create).toHaveBeenCalledWith(
        ProjectBudget,
        expect.objectContaining({
          year: 'FY26',
          account: 'Equipment',
          amount: 8000,
        }),
      );
      expect(manager.save).toHaveBeenCalledWith(
        ProjectBudget,
        expect.objectContaining({ year: 'FY26' }),
      );
    });

    it('rows with matching id are updated in place', async () => {
      const budget = {
        id: 20,
        year: 'FY25',
        version: 'v1',
        account: 'Staff',
        amount: 1000,
        externalCode: null,
      } as ProjectBudget;
      const existing = makeProject({ budgets: [budget] });
      await buildModule(existing);

      const dto: UpdateProjectDto = {
        budgets: [
          {
            id: 20,
            year: 'FY26',
            version: 'v2',
            account: 'Staff Updated',
            amount: 1500,
          },
        ],
      };
      await service.update(1, dto);

      /* The existing row should have been mutated and saved */
      expect(budget.year).toBe('FY26');
      expect(budget.version).toBe('v2');
      expect(budget.account).toBe('Staff Updated');
      expect(budget.amount).toBe(1500);
      expect(manager.save).toHaveBeenCalledWith(ProjectBudget, budget);
    });

    it('rows absent from incoming list are deleted', async () => {
      const keep = {
        id: 30,
        year: 'FY25',
        version: 'v1',
        account: 'Keep',
        amount: 500,
      } as ProjectBudget;
      const del = {
        id: 31,
        year: 'FY25',
        version: 'v1',
        account: 'Delete',
        amount: 200,
      } as ProjectBudget;
      const existing = makeProject({ budgets: [keep, del] });
      await buildModule(existing);

      /* Only `keep` (id=30) in the incoming payload */
      const dto: UpdateProjectDto = {
        budgets: [
          { id: 30, year: 'FY25', version: 'v1', account: 'Keep', amount: 500 },
        ],
      };
      await service.update(1, dto);

      expect(manager.delete).toHaveBeenCalledWith(
        ProjectBudget,
        expect.arrayContaining([31]),
      );
      /* `keep` (id 30) should not be in the delete call */
      const deletedIds = manager.delete.mock.calls[0][1] as number[];
      expect(deletedIds).not.toContain(30);
    });

    it('transaction rolls back on save error — findOne is not called after failure', async () => {
      const existing = makeProject({ budgets: [] });
      manager = buildMockManager({
        findOne: jest.fn(async () => existing),
        save: jest.fn(async () => {
          throw new Error('DB write failed');
        }),
      });
      dataSourceMock = buildMockDataSource(manager);

      const module: TestingModule = await Test.createTestingModule({
        providers: [ProjectsService],
      })
        .useMocker((token) => {
          if (token === getRepositoryToken(Project))
            return { findOneBy: jest.fn() };
          if (token === getRepositoryToken(Center))
            return { findOneBy: jest.fn() };
          if (token === getRepositoryToken(Country))
            return { findBy: jest.fn() };
          if (token === DataSource) return dataSourceMock;
          return {};
        })
        .compile();

      service = module.get(ProjectsService);
      const findOneSpy = jest.spyOn(service as any, 'findOne');

      await expect(
        service.update(1, {
          budgets: [{ year: 'FY26', version: 'v1', account: 'X', amount: 0 }],
        }),
      ).rejects.toThrow('DB write failed');

      /* findOne (the post-transaction reload) must NOT have been called */
      expect(findOneSpy).not.toHaveBeenCalled();
    });

    it('update() without budgets key leaves existing budget lines untouched', async () => {
      const budget = {
        id: 40,
        year: 'FY25',
        version: 'v1',
        account: 'Staff',
        amount: 1000,
      } as ProjectBudget;
      const existing = makeProject({ budgets: [budget] });
      await buildModule(existing);

      /* dto has no `budgets` key at all — should not touch budgets */
      const dto: UpdateProjectDto = { name: 'Updated Name' };
      await service.update(1, dto);

      expect(manager.delete).not.toHaveBeenCalled();
      /* save should only be called for the project entity, not for ProjectBudget */
      const budgetSaveCalls = manager.save.mock.calls.filter(
        (args) => args[0] === ProjectBudget,
      );
      expect(budgetSaveCalls).toHaveLength(0);
    });
  });

  /* ------------------------------------------------------------------ */
  /* findOne() ordering test                                              */
  /* ------------------------------------------------------------------ */

  describe('findOne()', () => {
    it('queries budgets ordered by year asc then account asc', async () => {
      const queryBuilder: any = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        getOne: jest.fn(async () => makeProject()),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [ProjectsService],
      })
        .useMocker((token) => {
          if (token === getRepositoryToken(Project)) {
            return {
              createQueryBuilder: jest.fn(() => queryBuilder),
            };
          }
          if (token === getRepositoryToken(Center)) return {};
          if (token === getRepositoryToken(Country)) return {};
          if (token === DataSource) return { transaction: jest.fn() };
          return {};
        })
        .compile();

      service = module.get(ProjectsService);
      await service.findOne(1);

      /* Verify the ORDER BY chain targets year ASC then account ASC */
      expect(queryBuilder.orderBy).toHaveBeenCalledWith('budgets.year', 'ASC');
      expect(queryBuilder.addOrderBy).toHaveBeenCalledWith(
        'budgets.account',
        'ASC',
      );
      /* budgets relation must be joined */
      expect(queryBuilder.leftJoinAndSelect).toHaveBeenCalledWith(
        'project.budgets',
        'budgets',
      );
    });

    it('throws NotFoundException when project does not exist', async () => {
      const queryBuilder: any = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        getOne: jest.fn(async () => null),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [ProjectsService],
      })
        .useMocker((token) => {
          if (token === getRepositoryToken(Project)) {
            return { createQueryBuilder: jest.fn(() => queryBuilder) };
          }
          if (token === getRepositoryToken(Center)) return {};
          if (token === getRepositoryToken(Country)) return {};
          if (token === DataSource) return { transaction: jest.fn() };
          return {};
        })
        .compile();

      service = module.get(ProjectsService);
      await expect(service.findOne(9999)).rejects.toThrow(NotFoundException);
    });
  });
});
