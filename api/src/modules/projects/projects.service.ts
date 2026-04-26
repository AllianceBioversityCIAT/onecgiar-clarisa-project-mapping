import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, In } from 'typeorm';
import { Project } from './entities/project.entity';
import { ProjectBudget } from './entities/project-budget.entity';
import { Center } from '../reference-data/entities/center.entity';
import { Country } from '../reference-data/entities/country.entity';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { ProjectQueryDto, ProjectSortField } from './dto/project-query.dto';
import { ProjectSummaryQueryDto } from './dto/project-summary-query.dto';
import { ProjectSuggestedQueryDto } from './dto/project-suggested-query.dto';
import { ProjectStatus } from './enums/project-status.enum';
import { ProjectMapping } from '../mappings/entities/project-mapping.entity';
import { MappingStatus } from '../mappings/enums/mapping-status.enum';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/enums/user-role.enum';

/**
 * Default fiscal year used for the per-project budget aggregate when the
 * caller omits `budgetYear`. Stored verbatim in `project_budgets.year`.
 */
const DEFAULT_BUDGET_YEAR = 'FY26';

/**
 * Maps the validated `sortField` enum value to its concrete SQL ordering
 * target. Entity columns use the raw `project.<snake_case>` form (per the
 * CLAUDE.md QueryBuilder rule); the two derived values (`budget2026`,
 * `agreedAllocatedPercent`) reference the SQL aliases attached to the
 * leftJoin'd subqueries.
 */
const SORT_FIELD_TO_SQL: Record<ProjectSortField, string> = {
  code: 'project.code',
  name: 'project.name',
  startDate: 'project.start_date',
  endDate: 'project.end_date',
  totalBudget: 'project.total_budget',
  totalPledge: 'project.total_pledge',
  status: 'project.status',
  budget2026: 'budget_year',
  agreedAllocatedPercent: 'agreed_percent',
};

/**
 * Shape of a single row returned by `findAll`. Extends the hydrated `Project`
 * entity with the three derived counters that come from the join subqueries
 * and the workflow-admin assistance flag.
 */
export type ProjectListItem = Project & {
  needsAssistanceMappingCount: number;
  budget2026: number;
  agreedAllocatedPercent: number;
};

/**
 * Default mapped-% goal for `getSuggestedToReachTarget` when the caller
 * omits `target`. Matches the dashboard's "≥ 90 %" KPI threshold.
 */
const DEFAULT_SUGGESTION_TARGET = 90;

/**
 * Hard cap on the candidate set the greedy walk inspects. A center
 * realistically needs ≤ 50 projects to push their mapped-% to target;
 * the cap simply protects the SUM/loop from runaway result sets if a
 * future filter combination produces an unexpectedly large candidate
 * pool.
 */
const SUGGESTION_CANDIDATE_LIMIT = 1000;

/**
 * Response shape for `GET /projects/suggested-to-reach-target`.
 *
 * Contains the inputs (echoed for round-tripping), the current and
 * projected mapped totals, and the ordered list of project IDs the
 * greedy algorithm picked. The frontend uses `projectIds` to highlight
 * rows on the projects table.
 */
export interface ProjectSuggestionResult {
  /** Echoed fiscal-year code (verbatim from `project_budgets.year`). */
  budgetYear: string;
  /** Echoed target percentage, rounded to 1 dp. */
  target: number;
  /** SUM(project_budgets.amount) over the scoped/filtered set. */
  totalBudgetYear: number;
  /** Already-committed budget = SUM(budget × agreed_pct / 100) over the scoped set. */
  currentMappedBudget: number;
  /** currentMappedBudget / totalBudgetYear * 100, 1 dp; 0 when totalBudgetYear is 0. */
  currentMappedPercent: number;
  /** Projected committed budget after applying the suggested rows at 100 %. */
  projectedMappedBudget: number;
  /** Projected mapped %, 1 dp. */
  projectedMappedPercent: number;
  /** Absolute budget amount equal to `totalBudgetYear * target / 100`. */
  targetAmount: number;
  /** Chosen project IDs, ordered by their unmapped-budget contribution DESC. */
  projectIds: number[];
  /** projectIds.length, exposed for convenience. */
  suggestionCount: number;
  /** True when no suggestion is needed because the goal is already met. */
  alreadyAtTarget: boolean;
}

/**
 * Aggregate response shape for `GET /projects/summary`.
 */
export interface ProjectsSummary {
  /** The fiscal year these totals are computed for, echoed back. */
  budgetYear: string;
  /** Count of active projects in the filtered scope (always status=active). */
  activeProjectCount: number;
  /** SUM(project_budgets.amount) for the chosen FY across the filtered set. */
  totalBudgetYear: number;
  /** SUM(projects.total_pledge) across the filtered set. */
  totalPledge: number;
  /** SUM(budget * agreed_alloc / 100) — committed funding only. */
  mappedBudgetYear: number;
  /** mappedBudgetYear / totalBudgetYear * 100, 1 dp. 0 when totalBudgetYear is 0. */
  mappedPercent: number;
}

/**
 * Service handling all project-related business logic.
 *
 * Manages CRUD operations, pagination, search, and filtering
 * for the projects domain.
 */
@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);

  constructor(
    @InjectRepository(Project)
    private readonly projectRepository: Repository<Project>,
    @InjectRepository(Center)
    private readonly centerRepository: Repository<Center>,
    @InjectRepository(Country)
    private readonly countryRepository: Repository<Country>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Creates a new project.
   *
   * Resolves the center and optional countries by their IDs,
   * then persists the project with the authenticated user as creator.
   *
   * @param dto - Validated creation payload.
   * @param userId - ID of the authenticated user creating the project.
   * @returns The newly created project with relations loaded.
   * @throws NotFoundException if the specified center does not exist.
   * @throws ConflictException if a project with the same code already exists.
   */
  async create(dto: CreateProjectDto, userId: number): Promise<Project> {
    /* Verify center exists */
    const center = await this.centerRepository.findOneBy({ id: dto.centerId });
    if (!center) {
      throw new NotFoundException(`Center with ID "${dto.centerId}" not found`);
    }

    /* Check for duplicate project code */
    const existing = await this.projectRepository.findOneBy({ code: dto.code });
    if (existing) {
      throw new ConflictException(
        `Project with code "${dto.code}" already exists`,
      );
    }

    /* Resolve countries if provided */
    let countries: Country[] = [];
    if (dto.countryIds?.length) {
      countries = await this.countryRepository.findBy({
        id: In(dto.countryIds),
      });
      if (countries.length !== dto.countryIds.length) {
        throw new NotFoundException('One or more country IDs are invalid');
      }
    }

    /* Persist project + budget lines atomically. The transaction guarantees
     * that a partial failure inserting budget rows rolls back the project
     * itself, preventing an orphaned project with no budget breakdown. */
    const savedId = await this.dataSource.transaction(async (manager) => {
      const project = manager.create(Project, {
        code: dto.code,
        name: dto.name,
        description: dto.description ?? null,
        summary: dto.summary ?? null,
        results: dto.results ?? null,
        startDate: dto.startDate ? new Date(dto.startDate) : null,
        endDate: dto.endDate ? new Date(dto.endDate) : null,
        totalBudget: dto.totalBudget,
        remainingBudget: dto.remainingBudget ?? dto.totalBudget,
        fundingSource: dto.fundingSource ?? null,
        funder: dto.funder ?? null,
        centerId: dto.centerId,
        createdById: userId,
        countries,
        /* Optional 4.1 Project Info fields. */
        funderPrimaryCenter: dto.funderPrimaryCenter ?? null,
        natureOfFunder: dto.natureOfFunder ?? null,
        category: dto.category ?? null,
        csp: dto.csp ?? null,
        cspNonCollectionReason: dto.cspNonCollectionReason ?? null,
        totalPledge: dto.totalPledge ?? null,
        principalInvestigator: dto.principalInvestigator ?? null,
        signedContractTitle: dto.signedContractTitle ?? null,
      });

      /* Attach budget lines via cascade — TypeORM will insert them in the
       * same transaction once the project has its generated ID. */
      if (dto.budgets?.length) {
        project.budgets = dto.budgets.map((b) =>
          manager.create(ProjectBudget, {
            year: b.year,
            version: b.version,
            account: b.account,
            amount: b.amount,
            externalCode: b.externalCode ?? null,
          }),
        );
      }

      const saved = await manager.save(project);
      this.logger.log(`Project "${saved.code}" created with ID ${saved.id}`);
      return saved.id;
    });

    return this.findOne(savedId);
  }

  /**
   * Retrieves a paginated list of projects with optional search and filters.
   *
   * Uses QueryBuilder for efficient filtering, search, and pagination.
   * Results are ordered by creation date descending (newest first).
   *
   * @param query - Search, filter, and pagination parameters.
   * @returns Paginated result with data array and metadata.
   */
  async findAll(
    query: ProjectQueryDto,
    user?: User,
  ): Promise<{
    data: ProjectListItem[];
    total: number;
    page: number;
    limit: number;
  }> {
    /* Authorize the needsAssistance filter up front — only workflow_admin
     * may use it, since this is the workflow admin's triage queue.
     * Throwing here keeps the error close to the permission check rather
     * than letting it bubble through SQL. */
    if (
      query.needsAssistance === true &&
      user?.role !== UserRole.WORKFLOW_ADMIN
    ) {
      throw new ForbiddenException(
        'Only workflow admins can filter by needsAssistance',
      );
    }

    const budgetYear = query.budgetYear ?? DEFAULT_BUDGET_YEAR;

    const qb = this.projectRepository
      .createQueryBuilder('project')
      .leftJoinAndSelect('project.center', 'center')
      /* Always expose a derived count of flagged mappings on each project
       * so the UI can badge rows that need workflow-admin attention. The
       * correlated subquery keeps this cheap (a single COUNT per row,
       * served by IDX_project_mappings_project_needs_assistance). */
      .addSelect(
        `(
          SELECT COUNT(*)
          FROM project_mappings pm_count
          WHERE pm_count.project_id = project.id
            AND pm_count.needs_assistance = 1
        )`,
        'needs_assistance_mapping_count',
      )
      /* Aggregate the agreed allocation % per project. Only mappings whose
       * status is `agreed` are counted toward the 90 % goal — in-flight
       * `negotiating` mappings are deliberately excluded so the UI's
       * "Mapped %" reflects committed funding only. The subquery groups
       * by project_id so the join stays 1:1 with the project row. */
      .leftJoin(
        (sub) =>
          sub
            .select('m.project_id', 'projectId')
            .addSelect(
              'COALESCE(SUM(m.allocation_percentage), 0)',
              'agreedPercent',
            )
            .from(ProjectMapping, 'm')
            .where('m.status = :agreedStatus', {
              agreedStatus: MappingStatus.AGREED,
            })
            .groupBy('m.project_id'),
        'alloc',
        'alloc.projectId = project.id',
      )
      /* Aggregate fiscal-year budget per project. The `idx_pb_year_version`
       * index on `project_budgets(year, version)` keeps this cheap. */
      .leftJoin(
        (sub) =>
          sub
            .select('pb.project_id', 'projectId')
            .addSelect('COALESCE(SUM(pb.amount), 0)', 'amount')
            .from(ProjectBudget, 'pb')
            .where('pb.year = :budgetYear', { budgetYear })
            .groupBy('pb.project_id'),
        'pby',
        'pby.projectId = project.id',
      )
      .addSelect('COALESCE(alloc.agreedPercent, 0)', 'agreed_percent')
      .addSelect('COALESCE(pby.amount, 0)', 'budget_year');

    /* Center reps only see projects belonging to their center */
    if (user?.role === UserRole.CENTER_REP && user.centerId) {
      qb.andWhere('project.centerId = :userCenterId', {
        userCenterId: user.centerId,
      });
    }

    /* Free-text search across code, name, and description */
    if (query.search) {
      qb.andWhere(
        '(project.code LIKE :search OR project.name LIKE :search OR project.description LIKE :search)',
        { search: `%${query.search}%` },
      );
    }

    /* Filter by center (admin/other roles can still use the dropdown filter) */
    if (query.centerId) {
      qb.andWhere('project.centerId = :centerId', { centerId: query.centerId });
    }

    /* Filter by status */
    if (query.status) {
      qb.andWhere('project.status = :status', { status: query.status });
    }

    /* Filter by funding source */
    if (query.fundingSource) {
      qb.andWhere('project.fundingSource = :fundingSource', {
        fundingSource: query.fundingSource,
      });
    }

    /* Restrict to projects with at least one flagged mapping. Admin /
     * workflow_admin only; the auth guard above already enforced that. */
    if (query.needsAssistance === true) {
      qb.andWhere(
        `EXISTS (
          SELECT 1
          FROM project_mappings pm_flag
          WHERE pm_flag.project_id = project.id
            AND pm_flag.needs_assistance = 1
        )`,
      );
    }

    /* Sort whitelist — class-validator's @IsIn already rejects unknown
     * values with 400; the lookup table is the only path from validated
     * field name to SQL column, so untrusted strings can never reach
     * orderBy(). Default keeps the original behaviour. */
    if (query.sortField) {
      const sqlColumn = SORT_FIELD_TO_SQL[query.sortField];
      qb.orderBy(sqlColumn, query.sortOrder ?? 'ASC');
    } else {
      qb.orderBy('project.created_at', 'DESC');
    }

    /* Pagination — offset/limit (not skip/take) per the CLAUDE.md
     * QueryBuilder rule. */
    const offset = (query.page - 1) * query.limit;
    qb.offset(offset).limit(query.limit);

    /* getRawAndEntities lets us merge the addSelect-ed count back onto
     * each hydrated entity. getCount() is a separate cheap query so we
     * don't lose the offset/limit pagination. */
    const [{ entities, raw }, total] = await Promise.all([
      qb.getRawAndEntities(),
      qb.getCount(),
    ]);

    const data: ProjectListItem[] = entities.map((entity, idx) => {
      const rawRow = raw[idx] as
        | {
            needs_assistance_mapping_count?: string | number | null;
            agreed_percent?: string | number | null;
            budget_year?: string | number | null;
          }
        | undefined;

      /* Helper: parse a raw aggregate cell into a finite number, defaulting
       * to 0. Decimal columns come back from MySQL as strings, so we always
       * route through parseFloat/Number rather than trusting the JS coerce. */
      const toNumber = (value: unknown): number => {
        if (value === null || value === undefined) return 0;
        const n = typeof value === 'number' ? value : parseFloat(String(value));
        return Number.isFinite(n) ? n : 0;
      };

      return Object.assign(entity, {
        needsAssistanceMappingCount: toNumber(
          rawRow?.needs_assistance_mapping_count,
        ),
        agreedAllocatedPercent: toNumber(rawRow?.agreed_percent),
        budget2026: toNumber(rawRow?.budget_year),
      });
    });

    return { data, total, page: query.page, limit: query.limit };
  }

  /**
   * Computes aggregate KPI totals across the filtered projects set.
   *
   * Powers the 4 KPI tiles on the projects dashboard. Filters mirror the
   * list endpoint so the totals always match the rows the user is looking
   * at; pagination is intentionally omitted because the tiles must reflect
   * the full scope, not the current page.
   *
   * `activeProjectCount` is always computed against `status = 'active'`
   * regardless of `query.status` — the tile label is "Active projects",
   * so even when the user is browsing archived projects we still surface
   * the active count for context.
   *
   * `mappedPercent` uses agreed mappings only, matching the per-row metric
   * exposed by `findAll`.
   *
   * @param query - Filter parameters (no pagination, no sort).
   * @param user - Authenticated user; drives center-rep scoping.
   */
  async getSummary(
    query: ProjectSummaryQueryDto,
    user?: User,
  ): Promise<ProjectsSummary> {
    const budgetYear = query.budgetYear ?? DEFAULT_BUDGET_YEAR;

    /* Build the base QueryBuilder with the same join surface as findAll
     * so totals and per-row values come from identical source data. */
    const buildBaseQuery = () => {
      const qb = this.projectRepository
        .createQueryBuilder('project')
        .leftJoin(
          (sub) =>
            sub
              .select('m.project_id', 'projectId')
              .addSelect(
                'COALESCE(SUM(m.allocation_percentage), 0)',
                'agreedPercent',
              )
              .from(ProjectMapping, 'm')
              .where('m.status = :agreedStatus', {
                agreedStatus: MappingStatus.AGREED,
              })
              .groupBy('m.project_id'),
          'alloc',
          'alloc.projectId = project.id',
        )
        .leftJoin(
          (sub) =>
            sub
              .select('pb.project_id', 'projectId')
              .addSelect('COALESCE(SUM(pb.amount), 0)', 'amount')
              .from(ProjectBudget, 'pb')
              .where('pb.year = :budgetYear', { budgetYear })
              .groupBy('pb.project_id'),
          'pby',
          'pby.projectId = project.id',
        );

      /* Center reps only see projects belonging to their center */
      if (user?.role === UserRole.CENTER_REP && user.centerId) {
        qb.andWhere('project.centerId = :userCenterId', {
          userCenterId: user.centerId,
        });
      }

      /* Apply the shared filter set. */
      if (query.search) {
        qb.andWhere(
          '(project.code LIKE :search OR project.name LIKE :search OR project.description LIKE :search)',
          { search: `%${query.search}%` },
        );
      }
      if (query.centerId) {
        qb.andWhere('project.centerId = :centerId', {
          centerId: query.centerId,
        });
      }
      if (query.fundingSource) {
        qb.andWhere('project.fundingSource = :fundingSource', {
          fundingSource: query.fundingSource,
        });
      }
      return qb;
    };

    /* Sum query: total budget, total pledge, mapped budget. Uses
     * `query.status` if provided so the totals follow the user's status
     * filter (matches what's in the table). */
    const sumQb = buildBaseQuery();
    if (query.status) {
      sumQb.andWhere('project.status = :status', { status: query.status });
    }
    sumQb
      .select('COALESCE(SUM(COALESCE(pby.amount, 0)), 0)', 'totalBudgetYear')
      .addSelect(
        'COALESCE(SUM(COALESCE(project.total_pledge, 0)), 0)',
        'totalPledge',
      )
      .addSelect(
        'COALESCE(SUM(COALESCE(pby.amount, 0) * COALESCE(alloc.agreedPercent, 0) / 100), 0)',
        'mappedBudgetYear',
      );

    /* Active count: always force status=active regardless of query.status.
     * This is a separate small COUNT that ignores the user's status
     * filter, since the tile label is "Active projects". Other filters
     * (search, center, funding) still apply. */
    const activeQb = buildBaseQuery().andWhere(
      'project.status = :activeStatus',
      { activeStatus: ProjectStatus.ACTIVE },
    );
    activeQb.select('COUNT(*)', 'activeProjectCount');

    const [sumRow, activeRow] = await Promise.all([
      sumQb.getRawOne<{
        totalBudgetYear: string | number | null;
        totalPledge: string | number | null;
        mappedBudgetYear: string | number | null;
      }>(),
      activeQb.getRawOne<{ activeProjectCount: string | number | null }>(),
    ]);

    /* Decimal columns come back as strings — always parseFloat. */
    const toNumber = (value: unknown): number => {
      if (value === null || value === undefined) return 0;
      const n = typeof value === 'number' ? value : parseFloat(String(value));
      return Number.isFinite(n) ? n : 0;
    };

    const totalBudgetYear = toNumber(sumRow?.totalBudgetYear);
    const totalPledge = toNumber(sumRow?.totalPledge);
    const mappedBudgetYear = toNumber(sumRow?.mappedBudgetYear);
    const activeProjectCount = Math.trunc(
      toNumber(activeRow?.activeProjectCount),
    );

    /* Avoid divide-by-zero. Round to 1 decimal place. */
    const mappedPercent =
      totalBudgetYear > 0
        ? Math.round((mappedBudgetYear / totalBudgetYear) * 1000) / 10
        : 0;

    return {
      budgetYear,
      activeProjectCount,
      totalBudgetYear,
      totalPledge,
      mappedBudgetYear,
      mappedPercent,
    };
  }

  /**
   * Greedy "what should I map next?" suggestion.
   *
   * Walks all eligible candidate projects ordered by their unmapped FY
   * budget contribution descending, accumulating until the projected
   * mapped budget meets/exceeds the target. Returns the chosen IDs so
   * the frontend can highlight the rows.
   *
   * Eligibility (per business rules):
   *  - `budget2026 > 0` (project actually contributes to the FY budget),
   *  - no `negotiating` mappings (in-flight work would conflict with a
   *    new center-rep action),
   *  - `agreedPercent < 100` (room left to map).
   *
   * `currentMappedBudget` and `totalBudgetYear` use the same definitions
   * as `getSummary` so the two endpoints never disagree on what the
   * "current mapped %" is. Only the *suggestion candidate filter* is
   * stricter (excludes projects with negotiating mappings).
   *
   * The greedy walk runs in JS rather than SQL — the candidate set is
   * bounded by `SUGGESTION_CANDIDATE_LIMIT` and the math is trivial; a
   * SQL implementation (running window sum) would be far harder to
   * maintain and offer no measurable speedup at this scale.
   *
   * @param query - Filter/scope/target inputs.
   * @param user  - Authenticated user; drives center-rep scoping.
   */
  async getSuggestedToReachTarget(
    query: ProjectSuggestedQueryDto,
    user?: User,
  ): Promise<ProjectSuggestionResult> {
    const budgetYear = query.budgetYear ?? DEFAULT_BUDGET_YEAR;
    /* Round target to 1 dp up front so the echoed value and the
     * computed targetAmount stay consistent. */
    const target =
      Math.round((query.target ?? DEFAULT_SUGGESTION_TARGET) * 10) / 10;
    /* Default to "active" when no status was supplied — suggestions for
     * archived/draft projects are not actionable for a center rep. The
     * caller can still pass any explicit status to override. */
    const status = query.status ?? ProjectStatus.ACTIVE;

    /* ---------- Helpers ---------- */
    const toNumber = (value: unknown): number => {
      if (value === null || value === undefined) return 0;
      const n = typeof value === 'number' ? value : parseFloat(String(value));
      return Number.isFinite(n) ? n : 0;
    };

    /* Round a number to 1 decimal place (used for the % outputs). */
    const round1 = (n: number): number => Math.round(n * 10) / 10;

    /* Build the shared base QueryBuilder with the same alloc + pby
     * subqueries as findAll/getSummary so the totals come from
     * identical source data. */
    const buildBaseQuery = () => {
      const qb = this.projectRepository
        .createQueryBuilder('project')
        .leftJoin(
          (sub) =>
            sub
              .select('m.project_id', 'projectId')
              .addSelect(
                'COALESCE(SUM(m.allocation_percentage), 0)',
                'agreedPercent',
              )
              .from(ProjectMapping, 'm')
              .where('m.status = :agreedStatus', {
                agreedStatus: MappingStatus.AGREED,
              })
              .groupBy('m.project_id'),
          'alloc',
          'alloc.projectId = project.id',
        )
        .leftJoin(
          (sub) =>
            sub
              .select('pb.project_id', 'projectId')
              .addSelect('COALESCE(SUM(pb.amount), 0)', 'amount')
              .from(ProjectBudget, 'pb')
              .where('pb.year = :budgetYear', { budgetYear })
              .groupBy('pb.project_id'),
          'pby',
          'pby.projectId = project.id',
        );

      /* Center reps only see projects belonging to their center. */
      if (user?.role === UserRole.CENTER_REP && user.centerId) {
        qb.andWhere('project.centerId = :userCenterId', {
          userCenterId: user.centerId,
        });
      }

      /* Shared filter set — identical to findAll/getSummary. */
      if (query.search) {
        qb.andWhere(
          '(project.code LIKE :search OR project.name LIKE :search OR project.description LIKE :search)',
          { search: `%${query.search}%` },
        );
      }
      if (query.centerId) {
        qb.andWhere('project.centerId = :centerId', {
          centerId: query.centerId,
        });
      }
      if (query.fundingSource) {
        qb.andWhere('project.fundingSource = :fundingSource', {
          fundingSource: query.fundingSource,
        });
      }
      qb.andWhere('project.status = :status', { status });
      return qb;
    };

    /* ---------- 1. Totals (same definitions as getSummary). ---------- */
    const sumQb = buildBaseQuery()
      .select('COALESCE(SUM(COALESCE(pby.amount, 0)), 0)', 'totalBudgetYear')
      .addSelect(
        'COALESCE(SUM(COALESCE(pby.amount, 0) * COALESCE(alloc.agreedPercent, 0) / 100), 0)',
        'mappedBudgetYear',
      );

    const sumRow = await sumQb.getRawOne<{
      totalBudgetYear: string | number | null;
      mappedBudgetYear: string | number | null;
    }>();

    const totalBudgetYear = toNumber(sumRow?.totalBudgetYear);
    const currentMappedBudget = toNumber(sumRow?.mappedBudgetYear);
    const currentMappedPercent =
      totalBudgetYear > 0
        ? round1((currentMappedBudget / totalBudgetYear) * 100)
        : 0;
    const targetAmount = (totalBudgetYear * target) / 100;

    /* ---------- 2. Early-exit when goal already met. ---------- */
    if (currentMappedBudget >= targetAmount) {
      this.logger.log(
        `Suggestion: target ${target}% already reached (${currentMappedPercent}%). ` +
          `Returning empty list.`,
      );
      return {
        budgetYear,
        target,
        totalBudgetYear,
        currentMappedBudget,
        currentMappedPercent,
        projectedMappedBudget: currentMappedBudget,
        projectedMappedPercent: currentMappedPercent,
        targetAmount,
        projectIds: [],
        suggestionCount: 0,
        alreadyAtTarget: true,
      };
    }

    /* ---------- 3. Eligible candidates ordered by contribution DESC. ---------- */
    const candidatesQb = buildBaseQuery()
      /* Anti-join: skip projects with at least one negotiating mapping.
       * `LEFT JOIN ... WHERE neg.project_id IS NULL` is the standard
       * MySQL anti-join idiom; the inner subquery is grouped so the
       * join stays 1:1 with the project row. */
      .leftJoin(
        (sub) =>
          sub
            .select('m.project_id', 'projectId')
            .from(ProjectMapping, 'm')
            .where('m.status = :negotiatingStatus', {
              negotiatingStatus: MappingStatus.NEGOTIATING,
            })
            .groupBy('m.project_id'),
        'neg',
        'neg.projectId = project.id',
      )
      .andWhere('neg.projectId IS NULL')
      .andWhere('COALESCE(pby.amount, 0) > 0')
      .andWhere('COALESCE(alloc.agreedPercent, 0) < 100')
      .select('project.id', 'id')
      .addSelect('COALESCE(pby.amount, 0)', 'budget')
      .addSelect('COALESCE(alloc.agreedPercent, 0)', 'agreedPercent')
      .addSelect(
        'COALESCE(pby.amount, 0) * (100 - COALESCE(alloc.agreedPercent, 0)) / 100',
        'unmappedContribution',
      )
      /* Tie-break by id ASC so the result is deterministic when two
       * projects produce the same contribution (e.g. equal budget and
       * equal already-mapped %). */
      .orderBy('unmappedContribution', 'DESC')
      .addOrderBy('project.id', 'ASC')
      .limit(SUGGESTION_CANDIDATE_LIMIT);

    const candidates = await candidatesQb.getRawMany<{
      id: number | string;
      budget: string | number | null;
      agreedPercent: string | number | null;
      unmappedContribution: string | number | null;
    }>();

    /* ---------- 4. Greedy walk. ---------- */
    const projectIds: number[] = [];
    let running = currentMappedBudget;
    for (const row of candidates) {
      if (running >= targetAmount) break;
      const id =
        typeof row.id === 'number' ? row.id : parseInt(String(row.id), 10);
      if (!Number.isFinite(id)) continue;
      const contribution = toNumber(row.unmappedContribution);
      projectIds.push(id);
      running += contribution;
    }

    const projectedMappedBudget = running;
    const projectedMappedPercent =
      totalBudgetYear > 0
        ? round1((projectedMappedBudget / totalBudgetYear) * 100)
        : 0;

    this.logger.log(
      `Suggestion: target ${target}% (amount ${targetAmount.toFixed(2)}); ` +
        `current ${currentMappedPercent}% (${currentMappedBudget.toFixed(2)}); ` +
        `picked ${projectIds.length} project(s); ` +
        `projected ${projectedMappedPercent}%.`,
    );

    return {
      budgetYear,
      target,
      totalBudgetYear,
      currentMappedBudget,
      currentMappedPercent,
      projectedMappedBudget,
      projectedMappedPercent,
      targetAmount,
      projectIds,
      suggestionCount: projectIds.length,
      alreadyAtTarget: false,
    };
  }

  /**
   * Retrieves a single project by ID with all relations loaded.
   *
   * @param id - Project ID.
   * @returns The project with center, countries, and createdBy relations.
   * @throws NotFoundException if the project does not exist.
   */
  async findOne(id: number): Promise<Project> {
    /* QueryBuilder lets us leftJoinAndSelect the budgets collection and
     * apply an ORDER BY to the joined rows (year asc, then account asc)
     * for a deterministic presentation order in the detail view. */
    const project = await this.projectRepository
      .createQueryBuilder('project')
      .leftJoinAndSelect('project.center', 'center')
      .leftJoinAndSelect('project.countries', 'countries')
      .leftJoinAndSelect('project.createdBy', 'createdBy')
      .leftJoinAndSelect('project.budgets', 'budgets')
      .where('project.id = :id', { id })
      .orderBy('budgets.year', 'ASC')
      .addOrderBy('budgets.account', 'ASC')
      .getOne();

    if (!project) {
      throw new NotFoundException(`Project with ID "${id}" not found`);
    }

    return project;
  }

  /**
   * Updates an existing project.
   *
   * Handles partial updates including country relation replacement
   * when `countryIds` is provided.
   *
   * @param id - Project ID.
   * @param dto - Validated update payload (partial).
   * @returns The updated project with relations loaded.
   * @throws NotFoundException if the project does not exist.
   * @throws ConflictException if updating the code to one that already exists.
   */
  async update(id: number, dto: UpdateProjectDto): Promise<Project> {
    /* Load project with both countries and budgets so we have the full
     * existing state before the diff runs. Everything happens inside a
     * single transaction to ensure consistent multi-row writes. */
    await this.dataSource.transaction(async (manager) => {
      const project = await manager.findOne(Project, {
        where: { id },
        relations: ['countries', 'budgets'],
      });

      if (!project) {
        throw new NotFoundException(`Project with ID "${id}" not found`);
      }

      /* Validate unique code if being changed */
      if (dto.code && dto.code !== project.code) {
        const existing = await manager.findOneBy(Project, { code: dto.code });
        if (existing) {
          throw new ConflictException(
            `Project with code "${dto.code}" already exists`,
          );
        }
      }

      /* Validate center if being changed */
      if (dto.centerId) {
        const center = await manager.findOneBy(Center, { id: dto.centerId });
        if (!center) {
          throw new NotFoundException(
            `Center with ID "${dto.centerId}" not found`,
          );
        }
      }

      /* Strip Anaplan-sourced fields — these are managed exclusively via CSV
       * import and must not be overwritten through the update endpoint. This
       * is a defence-in-depth measure; the DTO already omits these fields,
       * but a raw API call bypassing class-validator could still sneak them
       * through, so we delete them from the object before applying updates. */
      const ANAPLAN_FIELDS = [
        'funderPrimaryCenter',
        'natureOfFunder',
        'category',
        'csp',
        'cspNonCollectionReason',
        'totalPledge',
        'principalInvestigator',
        'signedContractTitle',
      ] as const;
      for (const key of ANAPLAN_FIELDS) {
        delete (dto as any)[key];
      }

      /* Resolve countries if provided */
      if (dto.countryIds !== undefined) {
        if (dto.countryIds.length) {
          const countries = await manager.findBy(Country, {
            id: In(dto.countryIds),
          });
          if (countries.length !== dto.countryIds.length) {
            throw new NotFoundException('One or more country IDs are invalid');
          }
          project.countries = countries;
        } else {
          project.countries = [];
        }
      }

      /* Apply scalar field updates — existing fields. */
      if (dto.code !== undefined) project.code = dto.code;
      if (dto.name !== undefined) project.name = dto.name;
      if (dto.description !== undefined)
        project.description = dto.description ?? null;
      if (dto.summary !== undefined) project.summary = dto.summary ?? null;
      if (dto.results !== undefined) project.results = dto.results ?? null;
      if (dto.startDate !== undefined)
        project.startDate = dto.startDate ? new Date(dto.startDate) : null;
      if (dto.endDate !== undefined)
        project.endDate = dto.endDate ? new Date(dto.endDate) : null;
      if (dto.totalBudget !== undefined) project.totalBudget = dto.totalBudget;
      if (dto.remainingBudget !== undefined)
        project.remainingBudget = dto.remainingBudget;
      if (dto.fundingSource !== undefined)
        project.fundingSource = dto.fundingSource ?? null;
      if (dto.funder !== undefined) project.funder = dto.funder ?? null;
      if (dto.centerId !== undefined) project.centerId = dto.centerId;

      /* Budget diff: update rows with a matching id, insert new rows with
       * no id, and delete existing rows that are missing from the payload.
       * When dto.budgets is undefined we leave the budget collection
       * untouched (consistent with countries/countryIds semantics). */
      if (dto.budgets !== undefined) {
        const existingBudgets = project.budgets ?? [];
        const incomingById = new Map<number, (typeof dto.budgets)[number]>();
        const toInsert: (typeof dto.budgets)[number][] = [];

        for (const row of dto.budgets) {
          if (row.id != null) {
            incomingById.set(row.id, row);
          } else {
            toInsert.push(row);
          }
        }

        /* Delete existing rows that are no longer in the payload.
         * manager.remove() nullifies FK columns before deleting, which
         * violates the NOT NULL constraint on project_id. Use manager.delete()
         * with explicit IDs instead — it issues a direct DELETE statement
         * without the nullification step. */
        const toDelete = existingBudgets
          .filter((b) => !incomingById.has(b.id))
          .map((b) => b.id);
        if (toDelete.length) {
          await manager.delete(ProjectBudget, toDelete);
        }

        /* Update existing rows in place. */
        for (const existing of existingBudgets) {
          const match = incomingById.get(existing.id);
          if (!match) continue;
          existing.year = match.year;
          existing.version = match.version;
          existing.account = match.account;
          existing.amount = match.amount;
          existing.externalCode = match.externalCode ?? null;
          await manager.save(ProjectBudget, existing);
        }

        /* Insert brand new rows. */
        for (const row of toInsert) {
          const created = manager.create(ProjectBudget, {
            projectId: project.id,
            year: row.year,
            version: row.version,
            account: row.account,
            amount: row.amount,
            externalCode: row.externalCode ?? null,
          });
          await manager.save(ProjectBudget, created);
        }

        /* Detach the in-memory budgets collection from the project so the
         * final parent save() does NOT cascade back through the now-stale
         * array and overwrite (or nullify) rows we just hand-managed above.
         * The actual child rows in DB are already in their correct state. */
        (project as { budgets?: ProjectBudget[] }).budgets = undefined;
      }

      await manager.save(Project, project);
      this.logger.log(`Project "${project.code}" (${id}) updated`);
    });

    return this.findOne(id);
  }

  /**
   * Archives a project by setting its status to 'archived'.
   *
   * This is a soft-delete operation; the project record remains
   * in the database for audit and historical reference.
   *
   * @param id - Project ID.
   * @throws NotFoundException if the project does not exist.
   */
  async archive(id: number): Promise<void> {
    const project = await this.projectRepository.findOneBy({ id });

    if (!project) {
      throw new NotFoundException(`Project with ID "${id}" not found`);
    }

    project.status = ProjectStatus.ARCHIVED;
    await this.projectRepository.save(project);
    this.logger.log(`Project "${project.code}" (${id}) archived`);
  }
}
