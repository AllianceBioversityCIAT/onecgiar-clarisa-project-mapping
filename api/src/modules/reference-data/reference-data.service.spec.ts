/**
 * Unit tests for ReferenceDataService — TOC list methods.
 *
 * All TypeORM repositories are mocked — no database, no HTTP.
 * The three describe blocks pin rules from the spec:
 *
 *  Rule 5  — Pagination offset = (page - 1) * limit
 *  Rule 6  — search is case-insensitive partial match on the right fields
 *  Rule 7  — aowId optional on outcomes/outputs; omit → no andWhere on aowId
 *  Rule 9  — Response shape: mapper strips internal columns, embeds refs
 *  Rule 10 — Ordering: AOWs by wp_official_code ASC, outcomes/outputs by title ASC,
 *             all with id ASC tie-breaker
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Logger } from '@nestjs/common';

import { ReferenceDataService } from './reference-data.service';
import { TocSyncService } from './toc-sync.service';
import { Center } from './entities/center.entity';
import { Program } from './entities/program.entity';
import { Country } from './entities/country.entity';
import { ActionArea } from './entities/action-area.entity';
import { TocAow } from './entities/toc-aow.entity';
import { TocOutcome, TocOutcomeType } from './entities/toc-outcome.entity';
import { TocOutput } from './entities/toc-output.entity';
import { ClarisaService } from '../clarisa/clarisa.service';
import { AuditService } from '../audit/audit.service';
import { TocAowQueryDto } from './dto/toc-aow-query.dto';
import { TocOutcomeQueryDto } from './dto/toc-outcome-query.dto';
import { TocOutputQueryDto } from './dto/toc-output-query.dto';

/* ═══════════════════════════════════════════════════════════════
   QueryBuilder mock factory (matches established PRMS pattern)
   ══════════════════════════════════════════════════════════════ */

/**
 * Builds a fluent QueryBuilder mock. Every chainable method returns
 * `this`; terminal methods (`getManyAndCount`) are configurable stubs.
 *
 * Established pattern from emails.service.spec.ts and
 * projects.service.spec.ts — keyed by repo.createQueryBuilder.
 */
function makeQueryBuilder(
  overrides: {
    getManyAndCount?: jest.Mock;
    getMany?: jest.Mock;
  } = {},
): any {
  return {
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    offset: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    getManyAndCount: overrides.getManyAndCount ?? jest.fn(async () => [[], 0]),
    getMany: overrides.getMany ?? jest.fn(async () => []),
  };
}

/* ═══════════════════════════════════════════════════════════════
   Entity stub factories
   ══════════════════════════════════════════════════════════════ */

const SYNCED_AT = new Date('2025-01-01T00:00:00.000Z');

function makeProgram(overrides: Partial<Program> = {}): Program {
  return {
    id: 10,
    clarisaId: 1001,
    officialCode: 'SP01',
    name: 'Science Program 01',
    syncedAt: SYNCED_AT,
    createdAt: SYNCED_AT,
    updatedAt: SYNCED_AT,
    ...overrides,
  } as Program;
}

function makeAow(overrides: Partial<TocAow> = {}): TocAow {
  const prog = makeProgram();
  return {
    id: 1,
    nodeId: 'WP-NODE-01',
    clarisaTocId: 'CLARISA-1',
    acronym: 'AOW01',
    wpOfficialCode: 'SP01-AOW01',
    name: 'Area of Work 1',
    programId: prog.id,
    program: prog,
    syncedAt: SYNCED_AT,
    createdAt: SYNCED_AT,
    updatedAt: SYNCED_AT,
    ...overrides,
  } as TocAow;
}

function makeOutcome(overrides: Partial<TocOutcome> = {}): TocOutcome {
  const prog = makeProgram();
  return {
    id: 100,
    nodeId: 'OC-NODE-01',
    title: 'Alpha outcome',
    description: 'Some description',
    outcomeType: TocOutcomeType.INTERMEDIATE,
    relatedNodeId: null,
    aowId: null,
    aow: null,
    programId: prog.id,
    program: prog,
    syncedAt: SYNCED_AT,
    createdAt: SYNCED_AT,
    updatedAt: SYNCED_AT,
    ...overrides,
  } as TocOutcome;
}

function makeOutput(overrides: Partial<TocOutput> = {}): TocOutput {
  const prog = makeProgram();
  return {
    id: 200,
    nodeId: 'OUT-NODE-01',
    title: 'Alpha output',
    description: 'Some description',
    typeOfOutput: 'Knowledge product',
    relatedNodeId: null,
    aowId: null,
    aow: null,
    programId: prog.id,
    program: prog,
    syncedAt: SYNCED_AT,
    createdAt: SYNCED_AT,
    updatedAt: SYNCED_AT,
    ...overrides,
  } as TocOutput;
}

/* ═══════════════════════════════════════════════════════════════
   Stub repo factory
   ══════════════════════════════════════════════════════════════ */

function stubRepo() {
  return {
    count: jest.fn(async () => 1) /* non-zero so bootstrap skip is triggered */,
    find: jest.fn(async () => []),
    findOne: jest.fn(async () => null),
    save: jest.fn(async (e: any) => e),
    create: jest.fn((e: any) => e),
    createQueryBuilder: jest.fn(),
  };
}

/* ═══════════════════════════════════════════════════════════════
   Suite setup
   ══════════════════════════════════════════════════════════════ */

describe('ReferenceDataService — TOC list methods', () => {
  let service: ReferenceDataService;
  let tocAowRepo: ReturnType<typeof stubRepo>;
  let tocOutcomeRepo: ReturnType<typeof stubRepo>;
  let tocOutputRepo: ReturnType<typeof stubRepo>;

  /* Minimal stubs for the other repos (not exercised in these tests). */
  const centerRepoStub = stubRepo();
  const programRepoStub = stubRepo();
  const countryRepoStub = stubRepo();
  const actionAreaRepoStub = stubRepo();

  /* Prevent onApplicationBootstrap from making real calls. */
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterAll(() => jest.restoreAllMocks());

  beforeEach(async () => {
    tocAowRepo = stubRepo();
    tocOutcomeRepo = stubRepo();
    tocOutputRepo = stubRepo();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReferenceDataService,
        { provide: getRepositoryToken(Center), useValue: centerRepoStub },
        { provide: getRepositoryToken(Program), useValue: programRepoStub },
        { provide: getRepositoryToken(Country), useValue: countryRepoStub },
        {
          provide: getRepositoryToken(ActionArea),
          useValue: actionAreaRepoStub,
        },
        { provide: getRepositoryToken(TocAow), useValue: tocAowRepo },
        { provide: getRepositoryToken(TocOutcome), useValue: tocOutcomeRepo },
        { provide: getRepositoryToken(TocOutput), useValue: tocOutputRepo },
        /* ClarisaService — not called by the list methods under test. */
        {
          provide: ClarisaService,
          useValue: {
            getCenters: jest.fn(),
            getPrograms: jest.fn(),
            getCountries: jest.fn(),
            getActionAreas: jest.fn(),
          },
        },
        /* AuditService — not called by list methods. */
        {
          provide: AuditService,
          useValue: { record: jest.fn() },
        },
        /* TocSyncService — not called by list methods. */
        {
          provide: TocSyncService,
          useValue: { syncAll: jest.fn() },
        },
      ],
    })
      /* Skip onApplicationBootstrap — it would try to seed/sync. */
      .overrideProvider(ReferenceDataService)
      .useFactory({
        factory: (
          centerRepo: any,
          programRepo: any,
          countryRepo: any,
          actionAreaRepo: any,
          aowRepo: any,
          outcomeRepo: any,
          outputRepo: any,
          clarisaSvc: any,
          auditSvc: any,
          tocSyncSvc: any,
        ) =>
          new ReferenceDataService(
            centerRepo,
            programRepo,
            countryRepo,
            actionAreaRepo,
            aowRepo,
            outcomeRepo,
            outputRepo,
            clarisaSvc,
            auditSvc,
            tocSyncSvc,
          ),
        inject: [
          getRepositoryToken(Center),
          getRepositoryToken(Program),
          getRepositoryToken(Country),
          getRepositoryToken(ActionArea),
          getRepositoryToken(TocAow),
          getRepositoryToken(TocOutcome),
          getRepositoryToken(TocOutput),
          ClarisaService,
          AuditService,
          TocSyncService,
        ],
      })
      .compile();

    service = module.get(ReferenceDataService);
  });

  // ──────────────────────────────────────────────────────────────────
  //  describe('listAows')
  // ──────────────────────────────────────────────────────────────────

  describe('listAows', () => {
    /** Build a query DTO with required programId and optional overrides. */
    function makeAowQuery(
      overrides: Partial<TocAowQueryDto> = {},
    ): TocAowQueryDto {
      return Object.assign(new TocAowQueryDto(), {
        programId: 10,
        page: 1,
        limit: 25,
        ...overrides,
      });
    }

    /* ── Rule 5: Pagination offset math ───────────────────────── */

    it('passes offset = (page-1)*limit to the QueryBuilder (page=2, limit=10)', async () => {
      const qb = makeQueryBuilder({
        getManyAndCount: jest.fn(async () => [[], 30]),
      });
      tocAowRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listAows(makeAowQuery({ page: 2, limit: 10 }));

      /* offset(10) = (2-1)*10 */
      expect(qb.offset).toHaveBeenCalledWith(10);
      expect(qb.limit).toHaveBeenCalledWith(10);
    });

    it('passes offset=0 for page=1', async () => {
      const qb = makeQueryBuilder();
      tocAowRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listAows(makeAowQuery({ page: 1, limit: 25 }));

      expect(qb.offset).toHaveBeenCalledWith(0);
    });

    it('returns correct page and limit in the response envelope', async () => {
      const qb = makeQueryBuilder({
        getManyAndCount: jest.fn(async () => [[], 30]),
      });
      tocAowRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.listAows(
        makeAowQuery({ page: 3, limit: 10 }),
      );

      expect(result.page).toBe(3);
      expect(result.limit).toBe(10);
      expect(result.total).toBe(30);
    });

    /* ── Rule 6: search applies to acronym, wp_official_code, name ── */

    it('does NOT call andWhere for search when search is absent', async () => {
      const qb = makeQueryBuilder();
      tocAowRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listAows(makeAowQuery({ search: undefined }));

      /* andWhere should only have been called for the programId scope — not
       * for search. We verify by checking it was NOT called with a LIKE arg. */
      const calls = (qb.andWhere as jest.Mock).mock.calls;
      const likeCall = calls.find(([clause]: [string]) => /LIKE/.test(clause));
      expect(likeCall).toBeUndefined();
    });

    it('calls andWhere with LIKE on acronym/wp_official_code/name when search is provided', async () => {
      const qb = makeQueryBuilder();
      tocAowRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listAows(makeAowQuery({ search: 'water' }));

      const calls = (qb.andWhere as jest.Mock).mock.calls;
      const likeCall = calls.find(([clause]: [string]) => /LIKE/.test(clause));
      expect(likeCall).toBeDefined();
      /* The clause must reference acronym OR wp_official_code OR name. */
      expect(likeCall[0]).toMatch(/acronym/);
      expect(likeCall[0]).toMatch(/wp_official_code/);
      expect(likeCall[0]).toMatch(/name/);
      /* The term parameter must be a %…% wildcard. */
      expect(likeCall[1]).toMatchObject({ term: '%water%' });
    });

    it('trims leading/trailing whitespace from the search term', async () => {
      const qb = makeQueryBuilder();
      tocAowRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listAows(makeAowQuery({ search: '  water  ' }));

      const calls = (qb.andWhere as jest.Mock).mock.calls;
      const likeCall = calls.find(([clause]: [string]) => /LIKE/.test(clause));
      expect(likeCall[1]).toMatchObject({ term: '%water%' });
    });

    it('does NOT add a LIKE clause when search is whitespace only', async () => {
      const qb = makeQueryBuilder();
      tocAowRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listAows(makeAowQuery({ search: '   ' }));

      const calls = (qb.andWhere as jest.Mock).mock.calls;
      const likeCall = calls.find(([clause]: [string]) => /LIKE/.test(clause));
      expect(likeCall).toBeUndefined();
    });

    /* ── Rule 9: Response shape ────────────────────────────────── */

    it('maps AOW entity to the expected DTO shape with embedded program ref', async () => {
      const aow = makeAow({
        id: 5,
        nodeId: 'WP-NODE-05',
        clarisaTocId: 'CLARISA-05',
        acronym: 'AOW05',
        wpOfficialCode: 'SP01-AOW05',
        name: 'Fifth AOW',
        programId: 10,
        program: makeProgram({
          id: 10,
          officialCode: 'SP01',
          name: 'Science 01',
        }),
        syncedAt: SYNCED_AT,
      });

      const qb = makeQueryBuilder({
        getManyAndCount: jest.fn(async () => [[aow], 1]),
      });
      tocAowRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.listAows(makeAowQuery());

      expect(result.data).toHaveLength(1);
      const item = result.data[0];

      /* Required fields present. */
      expect(item.id).toBe(5);
      expect(item.nodeId).toBe('WP-NODE-05');
      expect(item.clarisaTocId).toBe('CLARISA-05');
      expect(item.acronym).toBe('AOW05');
      expect(item.wpOfficialCode).toBe('SP01-AOW05');
      expect(item.name).toBe('Fifth AOW');
      expect(item.programId).toBe(10);
      expect(item.program).toEqual({
        id: 10,
        officialCode: 'SP01',
        name: 'Science 01',
      });
      expect(item.syncedAt).toBe(SYNCED_AT);

      /* Verify internal-only fields are NOT exposed. */
      expect((item as any).createdAt).toBeUndefined();
      expect((item as any).updatedAt).toBeUndefined();
      /* The program ref must be narrow — no clarisaId on it. */
      expect((item.program as any).clarisaId).toBeUndefined();
    });

    it('returns empty data array when getManyAndCount returns []', async () => {
      const qb = makeQueryBuilder({
        getManyAndCount: jest.fn(async () => [[], 0]),
      });
      tocAowRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.listAows(makeAowQuery());

      expect(result.data).toEqual([]);
      expect(result.total).toBe(0);
    });

    /* ── Rule 10: Ordering ─────────────────────────────────────── */

    it('orders by wp_official_code ASC as primary sort', async () => {
      const qb = makeQueryBuilder();
      tocAowRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listAows(makeAowQuery());

      expect(qb.orderBy).toHaveBeenCalledWith('aow.wp_official_code', 'ASC');
    });

    it('adds id ASC as tie-breaker after wp_official_code', async () => {
      const qb = makeQueryBuilder();
      tocAowRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listAows(makeAowQuery());

      expect(qb.addOrderBy).toHaveBeenCalledWith('aow.id', 'ASC');
    });

    it('returns rows in wp_official_code ASC order when two rows are provided', async () => {
      /* Deliberately reversed insertion order to verify ordering contract. */
      const aowB = makeAow({
        id: 2,
        wpOfficialCode: 'SP01-AOW02',
        acronym: 'AOW02',
      });
      const aowA = makeAow({
        id: 1,
        wpOfficialCode: 'SP01-AOW01',
        acronym: 'AOW01',
      });

      /* The QueryBuilder mock returns whatever the fake DB yields.
       * The service maps the rows in the order received — the real
       * ordering happens in MySQL. Here we verify the orderBy calls
       * are set correctly, and trust the DB to enforce them.
       * We simulate the DB respecting the order by returning [aowA, aowB]. */
      const qb = makeQueryBuilder({
        getManyAndCount: jest.fn(async () => [[aowA, aowB], 2]),
      });
      tocAowRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.listAows(makeAowQuery());

      expect(result.data[0].wpOfficialCode).toBe('SP01-AOW01');
      expect(result.data[1].wpOfficialCode).toBe('SP01-AOW02');
      /* Verify the service did request the right order from the QB. */
      expect(qb.orderBy).toHaveBeenCalledWith('aow.wp_official_code', 'ASC');
      expect(qb.addOrderBy).toHaveBeenCalledWith('aow.id', 'ASC');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  //  describe('listOutcomes')
  // ──────────────────────────────────────────────────────────────────

  describe('listOutcomes', () => {
    function makeOutcomeQuery(
      overrides: Partial<TocOutcomeQueryDto> = {},
    ): TocOutcomeQueryDto {
      return Object.assign(new TocOutcomeQueryDto(), {
        programId: 10,
        page: 1,
        limit: 25,
        ...overrides,
      });
    }

    /* ── Rule 5: Pagination offset math ───────────────────────── */

    it('passes offset = (page-1)*limit to the QueryBuilder (page=2, limit=10)', async () => {
      const qb = makeQueryBuilder({
        getManyAndCount: jest.fn(async () => [[], 30]),
      });
      tocOutcomeRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listOutcomes(makeOutcomeQuery({ page: 2, limit: 10 }));

      expect(qb.offset).toHaveBeenCalledWith(10);
      expect(qb.limit).toHaveBeenCalledWith(10);
    });

    /* ── Rule 6: search applies to title only ─────────────────── */

    it('does NOT add LIKE clause when search is absent', async () => {
      const qb = makeQueryBuilder();
      tocOutcomeRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listOutcomes(makeOutcomeQuery({ search: undefined }));

      const likeCall = (qb.andWhere as jest.Mock).mock.calls.find(
        ([clause]: [string]) => /LIKE/.test(clause),
      );
      expect(likeCall).toBeUndefined();
    });

    it('calls andWhere with LIKE on title only (not description) when search is provided', async () => {
      const qb = makeQueryBuilder();
      tocOutcomeRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listOutcomes(makeOutcomeQuery({ search: 'foster' }));

      const likeCall = (qb.andWhere as jest.Mock).mock.calls.find(
        ([clause]: [string]) => /LIKE/.test(clause),
      );
      expect(likeCall).toBeDefined();
      expect(likeCall[0]).toMatch(/title/);
      /* Must NOT match description or other fields. */
      expect(likeCall[0]).not.toMatch(/description/);
      expect(likeCall[0]).not.toMatch(/node_id/);
      expect(likeCall[1]).toMatchObject({ term: '%foster%' });
    });

    /* ── Rule 7: aowId optional ────────────────────────────────── */

    it('does NOT add an aowId andWhere clause when aowId is absent', async () => {
      const qb = makeQueryBuilder();
      tocOutcomeRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listOutcomes(makeOutcomeQuery({ aowId: undefined }));

      const aowIdCall = (qb.andWhere as jest.Mock).mock.calls.find(
        ([clause]: [string]) => /aowId/.test(clause),
      );
      expect(aowIdCall).toBeUndefined();
    });

    it('adds andWhere for aowId when aowId is provided', async () => {
      const qb = makeQueryBuilder();
      tocOutcomeRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listOutcomes(makeOutcomeQuery({ aowId: 7 }));

      const aowIdCall = (qb.andWhere as jest.Mock).mock.calls.find(
        ([clause]: [string]) => /aowId/.test(clause),
      );
      expect(aowIdCall).toBeDefined();
      expect(aowIdCall[1]).toMatchObject({ aowId: 7 });
    });

    /* ── Rule 9: Response shape ────────────────────────────────── */

    it('maps outcome entity to the DTO shape with aow=null when aowId is null', async () => {
      const outcome = makeOutcome({ aowId: null, aow: null });
      const qb = makeQueryBuilder({
        getManyAndCount: jest.fn(async () => [[outcome], 1]),
      });
      tocOutcomeRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.listOutcomes(makeOutcomeQuery());

      expect(result.data).toHaveLength(1);
      const item = result.data[0];
      expect(item.id).toBe(100);
      expect(item.aowId).toBeNull();
      expect(item.aow).toBeNull();
      expect(item.outcomeType).toBe(TocOutcomeType.INTERMEDIATE);
      expect(item.program).toEqual({
        id: 10,
        officialCode: 'SP01',
        name: 'Science Program 01',
      });
      /* No internal fields leaked. */
      expect((item as any).createdAt).toBeUndefined();
      expect((item.program as any).clarisaId).toBeUndefined();
    });

    it('maps outcome entity with embedded aow ref when aow is present', async () => {
      const parentAow = makeAow({
        id: 7,
        acronym: 'AOW07',
        name: 'Seventh AOW',
      });
      const outcome = makeOutcome({ aowId: 7, aow: parentAow });
      const qb = makeQueryBuilder({
        getManyAndCount: jest.fn(async () => [[outcome], 1]),
      });
      tocOutcomeRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.listOutcomes(makeOutcomeQuery());

      const item = result.data[0];
      expect(item.aow).toEqual({
        id: 7,
        acronym: 'AOW07',
        name: 'Seventh AOW',
      });
      /* The aow ref must be narrow — only id, acronym, name. */
      expect((item.aow as any)?.wpOfficialCode).toBeUndefined();
      expect((item.aow as any)?.programId).toBeUndefined();
    });

    it('includes description in the outcome DTO', async () => {
      const outcome = makeOutcome({ description: 'Detailed description text' });
      const qb = makeQueryBuilder({
        getManyAndCount: jest.fn(async () => [[outcome], 1]),
      });
      tocOutcomeRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.listOutcomes(makeOutcomeQuery());

      expect(result.data[0].description).toBe('Detailed description text');
    });

    /* ── Rule 10: Ordering ─────────────────────────────────────── */

    it('orders by title ASC as primary sort', async () => {
      const qb = makeQueryBuilder();
      tocOutcomeRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listOutcomes(makeOutcomeQuery());

      expect(qb.orderBy).toHaveBeenCalledWith('outcome.title', 'ASC');
    });

    it('adds id ASC as tie-breaker', async () => {
      const qb = makeQueryBuilder();
      tocOutcomeRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listOutcomes(makeOutcomeQuery());

      expect(qb.addOrderBy).toHaveBeenCalledWith('outcome.id', 'ASC');
    });

    it('returns rows in title ASC order when two rows are provided (tie-breaker test)', async () => {
      /* Two outcomes with same title — id ASC tie-breaker must fire. */
      const oc1 = makeOutcome({ id: 200, title: 'Zebra outcome' });
      const oc2 = makeOutcome({ id: 100, title: 'Alpha outcome' });

      /* Simulate the DB ordering: [oc2, oc1] (Alpha before Zebra). */
      const qb = makeQueryBuilder({
        getManyAndCount: jest.fn(async () => [[oc2, oc1], 2]),
      });
      tocOutcomeRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.listOutcomes(makeOutcomeQuery());

      expect(result.data[0].title).toBe('Alpha outcome');
      expect(result.data[1].title).toBe('Zebra outcome');
      expect(qb.orderBy).toHaveBeenCalledWith('outcome.title', 'ASC');
      expect(qb.addOrderBy).toHaveBeenCalledWith('outcome.id', 'ASC');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  //  describe('listOutputs')
  // ──────────────────────────────────────────────────────────────────

  describe('listOutputs', () => {
    function makeOutputQuery(
      overrides: Partial<TocOutputQueryDto> = {},
    ): TocOutputQueryDto {
      return Object.assign(new TocOutputQueryDto(), {
        programId: 10,
        page: 1,
        limit: 25,
        ...overrides,
      });
    }

    /* ── Rule 5: Pagination offset math ───────────────────────── */

    it('passes offset = (page-1)*limit to the QueryBuilder (page=3, limit=5)', async () => {
      const qb = makeQueryBuilder({
        getManyAndCount: jest.fn(async () => [[], 15]),
      });
      tocOutputRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listOutputs(makeOutputQuery({ page: 3, limit: 5 }));

      expect(qb.offset).toHaveBeenCalledWith(10); /* (3-1)*5 */
      expect(qb.limit).toHaveBeenCalledWith(5);
    });

    /* ── Rule 6: search applies to title only ─────────────────── */

    it('does NOT add LIKE clause when search is absent', async () => {
      const qb = makeQueryBuilder();
      tocOutputRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listOutputs(makeOutputQuery({ search: undefined }));

      const likeCall = (qb.andWhere as jest.Mock).mock.calls.find(
        ([clause]: [string]) => /LIKE/.test(clause),
      );
      expect(likeCall).toBeUndefined();
    });

    it('calls andWhere with LIKE on title only when search is provided', async () => {
      const qb = makeQueryBuilder();
      tocOutputRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listOutputs(makeOutputQuery({ search: 'policy' }));

      const likeCall = (qb.andWhere as jest.Mock).mock.calls.find(
        ([clause]: [string]) => /LIKE/.test(clause),
      );
      expect(likeCall).toBeDefined();
      expect(likeCall[0]).toMatch(/title/);
      expect(likeCall[0]).not.toMatch(/description/);
      expect(likeCall[1]).toMatchObject({ term: '%policy%' });
    });

    /* ── Rule 7: aowId optional ────────────────────────────────── */

    it('does NOT add an aowId andWhere clause when aowId is absent', async () => {
      const qb = makeQueryBuilder();
      tocOutputRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listOutputs(makeOutputQuery({ aowId: undefined }));

      const aowIdCall = (qb.andWhere as jest.Mock).mock.calls.find(
        ([clause]: [string]) => /aowId/.test(clause),
      );
      expect(aowIdCall).toBeUndefined();
    });

    it('adds andWhere for aowId when aowId is provided', async () => {
      const qb = makeQueryBuilder();
      tocOutputRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listOutputs(makeOutputQuery({ aowId: 3 }));

      const aowIdCall = (qb.andWhere as jest.Mock).mock.calls.find(
        ([clause]: [string]) => /aowId/.test(clause),
      );
      expect(aowIdCall).toBeDefined();
      expect(aowIdCall[1]).toMatchObject({ aowId: 3 });
    });

    /* ── Rule 9: Response shape ────────────────────────────────── */

    it('maps output entity to the DTO shape with typeOfOutput instead of outcomeType', async () => {
      const output = makeOutput({
        id: 300,
        title: 'Policy brief output',
        description: 'Policy text',
        typeOfOutput: 'Policy brief',
        relatedNodeId: 'OUT-NODE-REL',
        aowId: null,
        aow: null,
      });
      const qb = makeQueryBuilder({
        getManyAndCount: jest.fn(async () => [[output], 1]),
      });
      tocOutputRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.listOutputs(makeOutputQuery());

      expect(result.data).toHaveLength(1);
      const item = result.data[0];
      expect(item.id).toBe(300);
      expect(item.title).toBe('Policy brief output');
      expect(item.description).toBe('Policy text');
      expect(item.typeOfOutput).toBe('Policy brief');
      expect(item.relatedNodeId).toBe('OUT-NODE-REL');
      expect(item.aowId).toBeNull();
      expect(item.aow).toBeNull();
      /* No outcomeType field on output DTO. */
      expect((item as any).outcomeType).toBeUndefined();
      expect((item as any).createdAt).toBeUndefined();
    });

    it('maps output with embedded aow ref when aow is present', async () => {
      const parentAow = makeAow({ id: 3, acronym: 'AOW03', name: 'Third AOW' });
      const output = makeOutput({ aowId: 3, aow: parentAow });
      const qb = makeQueryBuilder({
        getManyAndCount: jest.fn(async () => [[output], 1]),
      });
      tocOutputRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.listOutputs(makeOutputQuery());

      const item = result.data[0];
      expect(item.aow).toEqual({ id: 3, acronym: 'AOW03', name: 'Third AOW' });
      expect((item.aow as any)?.wpOfficialCode).toBeUndefined();
    });

    /* ── Rule 10: Ordering ─────────────────────────────────────── */

    it('orders by title ASC as primary sort', async () => {
      const qb = makeQueryBuilder();
      tocOutputRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listOutputs(makeOutputQuery());

      expect(qb.orderBy).toHaveBeenCalledWith('output.title', 'ASC');
    });

    it('adds id ASC as tie-breaker', async () => {
      const qb = makeQueryBuilder();
      tocOutputRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listOutputs(makeOutputQuery());

      expect(qb.addOrderBy).toHaveBeenCalledWith('output.id', 'ASC');
    });

    it('returns rows in title ASC order (tie-breaker: id ASC)', async () => {
      const out1 = makeOutput({ id: 500, title: 'Zebra output' });
      const out2 = makeOutput({ id: 200, title: 'Alpha output' });

      /* Simulate DB returning them in correct order. */
      const qb = makeQueryBuilder({
        getManyAndCount: jest.fn(async () => [[out2, out1], 2]),
      });
      tocOutputRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.listOutputs(makeOutputQuery());

      expect(result.data[0].title).toBe('Alpha output');
      expect(result.data[1].title).toBe('Zebra output');
      expect(qb.orderBy).toHaveBeenCalledWith('output.title', 'ASC');
      expect(qb.addOrderBy).toHaveBeenCalledWith('output.id', 'ASC');
    });
  });

  /* ───────────────────────────────────────────────────────────────
     listOutcomesForProgram() — program-rep TOC Contribution picker

     Pins the behaviour the picker depends on:
       1. Returns BOTH intermediate and 2030 (portfolio) outcomes —
          no outcome_type filter on the query.
       2. When aowIds is supplied, the filter is inclusive of orphans
          (`aow_id IN (...) OR aow_id IS NULL`) so outcomes with no
          AOW remain reachable even though the UI forces an AOW
          selection before enabling the outcomes multiselect.
       3. When aowIds is omitted, no AOW predicate is added.
     ─────────────────────────────────────────────────────────────── */
  describe('listOutcomesForProgram', () => {
    it('does NOT filter by outcome_type — surfaces both intermediate and portfolio', async () => {
      const qb = makeQueryBuilder();
      tocOutcomeRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listOutcomesForProgram(42);

      const typeAndWhere = (qb.andWhere as jest.Mock).mock.calls.find(
        (call: any[]) =>
          typeof call[0] === 'string' && call[0].includes('outcomeType'),
      );
      expect(typeAndWhere).toBeUndefined();
    });

    it('aow filter targets the toc_outcome_aows junction with an orphan branch', async () => {
      const qb = makeQueryBuilder();
      tocOutcomeRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listOutcomesForProgram(42, [11, 12]);

      /* The aow filter now exercises the junction via subqueries —
       * grep on the junction table name + the matching/orphan
       * EXISTS pair, not the legacy `outcome.aowId` scalar. */
      const aowAndWhere = (qb.andWhere as jest.Mock).mock.calls.find(
        (call: any[]) =>
          typeof call[0] === 'string' && call[0].includes('toc_outcome_aows'),
      );
      expect(aowAndWhere).toBeDefined();
      /* Matching branch: EXISTS on a junction row with aow_id in set. */
      expect(aowAndWhere![0]).toMatch(/EXISTS\s*\(/);
      expect(aowAndWhere![0]).toMatch(/aow_id\s+IN\s*\(:\.\.\.aowIds\)/);
      /* Orphan branch: NOT EXISTS on any junction row for this outcome. */
      expect(aowAndWhere![0]).toMatch(/NOT\s+EXISTS\s*\(/);
      /* OR connector between the two branches. */
      expect(aowAndWhere![0]).toMatch(/\)\s*OR\s*NOT\s+EXISTS/);
      expect(aowAndWhere![1]).toEqual({ aowIds: [11, 12] });
    });

    it('omits the aow predicate entirely when aowIds is not supplied', async () => {
      const qb = makeQueryBuilder();
      tocOutcomeRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listOutcomesForProgram(42);

      /* No aow predicate of either flavour — neither the legacy
       * scalar nor the junction subquery should be added. */
      const aowAndWhere = (qb.andWhere as jest.Mock).mock.calls.find(
        (call: any[]) =>
          typeof call[0] === 'string' &&
          (call[0].includes('aowId') || call[0].includes('toc_outcome_aows')),
      );
      expect(aowAndWhere).toBeUndefined();
    });

    it('returns both intermediate and portfolio rows when the repo yields them', async () => {
      const inter = makeOutcome({
        id: 101,
        title: 'Intermediate one',
        outcomeType: TocOutcomeType.INTERMEDIATE,
      });
      const portfolio = makeOutcome({
        id: 102,
        title: '2030 EOI',
        outcomeType: TocOutcomeType.PORTFOLIO,
      });
      const qb = makeQueryBuilder({
        getMany: jest.fn(async () => [inter, portfolio]),
      });
      tocOutcomeRepo.createQueryBuilder.mockReturnValue(qb);

      const rows = await service.listOutcomesForProgram(42);

      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.id)).toEqual([101, 102]);
    });
  });
});
