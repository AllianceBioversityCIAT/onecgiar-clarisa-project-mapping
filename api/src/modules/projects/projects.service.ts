import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository, In } from 'typeorm';
import { Project } from './entities/project.entity';
import { ProjectBudget } from './entities/project-budget.entity';
import { ProjectExclusion } from './entities/project-exclusion.entity';
import { Center } from '../reference-data/entities/center.entity';
import { Country } from '../reference-data/entities/country.entity';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import {
  UnitAdminUpdateProjectDto,
  UNIT_ADMIN_EDITABLE_FIELDS,
  UnitAdminEditableField,
} from './dto/unit-admin-update-project.dto';
import { ProjectQueryDto, ProjectSortField } from './dto/project-query.dto';
import { ProjectSummaryQueryDto } from './dto/project-summary-query.dto';
import { ProjectSuggestedQueryDto } from './dto/project-suggested-query.dto';
import { ProjectStatus } from './enums/project-status.enum';
import { MappingStatusFilter } from './enums/mapping-status-filter.enum';
import { ProjectMapping } from '../mappings/entities/project-mapping.entity';
import { MappingStatus } from '../mappings/enums/mapping-status.enum';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/enums/user-role.enum';
import { AuditService } from '../audit/audit.service';
import {
  AuditEntityType,
  AuditEvent,
  AuditEventChanges,
} from '../audit/entities/audit-event.entity';

/**
 * Default fiscal year used for the per-project budget aggregate when the
 * caller omits `budgetYear`. Stored verbatim in `project_budgets.year`.
 */
const DEFAULT_BUDGET_YEAR = 'FY26';

/**
 * Derived per-project mapping-status SQL expression. Returns one of the four
 * `MappingStatusFilter` values, evaluated in priority order:
 *   1. project is locked            -> 'locked'
 *   2. any non-removed mapping is `negotiating`/`agreed`  -> 'in_negotiation'
 *   3. any mapping is `draft` (and none of the above)     -> 'draft'
 *   4. otherwise (no non-removed mappings)                -> 'none'
 *
 * Reused for both `addSelect()` (so the hydrated row carries the bucket) and
 * `andWhere()` (so the filter and the displayed value are computed by the
 * same expression). Bound parameters are attached to the QueryBuilder once,
 * via `setParameters`, so this fragment can be inlined safely.
 */
const MAPPING_STATUS_SQL = `(
  CASE
    WHEN project.negotiation_locked = 1 THEN :mappingStatusLocked
    WHEN EXISTS (
      SELECT 1 FROM project_mappings pm_ms
      WHERE pm_ms.project_id = project.id
        AND pm_ms.status IN (:mappingStatusNegotiating, :mappingStatusAgreed)
    ) THEN :mappingStatusInNegotiation
    WHEN EXISTS (
      SELECT 1 FROM project_mappings pm_ms_draft
      WHERE pm_ms_draft.project_id = project.id
        AND pm_ms_draft.status = :mappingStatusDraft
    ) THEN :mappingStatusDraftFilter
    ELSE :mappingStatusNone
  END
)`;

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
  /**
   * True when the project is unlocked AND has at least one mapping in
   * `negotiating` status. Drives the highlighted "Negotiation" action button
   * on the projects list.
   */
  inActiveNegotiation: boolean;
  /**
   * Derived per-project negotiation classification used by the projects list
   * filter and the "Mapping Status" column. Computed server-side from
   * `negotiation_locked` plus the statuses of the project's non-removed
   * mappings — see `MAPPING_STATUS_SQL` for the priority rules.
   */
  mappingStatus: MappingStatusFilter;
  /**
   * Programs currently mapped to the project (excludes `removed` mappings).
   * Surfaces program acronym chips with hover tooltips on the projects list.
   * Empty array when no programs are mapped.
   */
  mappedPrograms: Array<{
    id: number;
    name: string;
    officialCode: string;
    status: MappingStatus;
  }>;
  /**
   * Present only when the caller is a center_rep with `showExcluded=true`
   * and the project is currently excluded by their center. Null/absent
   * for non-excluded rows or roles that never see exclusion state.
   */
  exclusion?: {
    reason: string;
    excludedAt: Date;
    excludedBy: { id: number; firstName: string; lastName: string };
    /* The center that owns this exclusion record. Important for admin
     * viewers because admins see exclusions from any center and need to
     * target the right (project, center) pair when calling unexclude. */
    center: { id: number; name: string; acronym: string };
  } | null;
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
    @InjectRepository(ProjectExclusion)
    private readonly exclusionRepository: Repository<ProjectExclusion>,
    @InjectRepository(Center)
    private readonly centerRepository: Repository<Center>,
    @InjectRepository(Country)
    private readonly countryRepository: Repository<Country>,
    private readonly dataSource: DataSource,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Returns true when two scalar values represent the same stored value
   * for diff purposes. Dates compare by ISO string, primitives compare
   * by `===`, and null/undefined are treated as equal so a null DB value
   * matched against a missing dto value does not produce a spurious
   * audit row.
   */
  private valuesAreEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a == null && b == null) return true;
    if (a == null || b == null) return false;
    if (a instanceof Date || b instanceof Date) {
      const aIso =
        a instanceof Date
          ? a.toISOString()
          : new Date(a as string).toISOString();
      const bIso =
        b instanceof Date
          ? b.toISOString()
          : new Date(b as string).toISOString();
      return aIso === bIso;
    }
    return a === b;
  }

  /**
   * Field-by-field diff applier for project edits. Computes the delta
   * between the loaded project and the dto, mutates the entity in place
   * with the new values, persists the project, and returns the diff
   * payload (or null when nothing scalar changed) so the caller can
   * decide which audit `action` label to record.
   *
   * The dto is treated as a partial: undefined values are ignored,
   * unchanged values are skipped, and `justification` itself never
   * appears as an audited field. Both the admin and unit-admin code
   * paths route through here so diff semantics stay identical.
   *
   * Audit writes happen at the caller (outside the transaction by
   * design — `AuditService.record()` swallows its own errors so a
   * failing audit insert never rolls back the user's primary edit).
   *
   * @param project The hydrated project entity (already loaded inside
   *                the transaction). Mutated in place with the new
   *                values before being saved.
   * @param dto     The incoming partial — only its scalar whitelisted
   *                keys are inspected. Relations (countries, budgets)
   *                are handled by the caller before this runs.
   * @param manager The active transaction `EntityManager`.
   * @returns Object with the saved project and a diff payload keyed by
   *          field name. `changes` is null when no scalar field changed.
   */
  private async applyEdits(
    project: Project,
    dto: Partial<Record<string, unknown>>,
    manager: EntityManager,
  ): Promise<{
    saved: Project;
    changes: AuditEventChanges | null;
    changedFields: string[];
  }> {
    /* The set of scalar fields we ever audit. This is a superset of the
     * unit-admin whitelist plus the additional fields admins may edit
     * (code, centerId). Anything not in this list is never diffed by
     * applyEdits — the caller handles relations (countries, budgets)
     * separately and outside the audit trail per the plan. */
    const AUDITABLE_FIELDS: readonly string[] = [
      'code',
      'name',
      'description',
      'summary',
      'results',
      'startDate',
      'endDate',
      'totalBudget',
      'remainingBudget',
      'fundingSource',
      'funder',
      'centerId',
    ];

    /* Compute the diff. We capture old/new pairs so the caller can
     * format a single AuditEventChanges payload after the project
     * save succeeds. */
    const changesPayload: AuditEventChanges = {};
    const changedFields: string[] = [];

    for (const field of AUDITABLE_FIELDS) {
      if (!(field in dto)) continue;
      const incoming = (dto as Record<string, unknown>)[field];
      if (incoming === undefined) continue;

      /* Coerce date strings to Date so the comparison matches the entity
       * column type. Dates are stored on the entity as `Date | null`. */
      const normalisedIncoming =
        (field === 'startDate' || field === 'endDate') &&
        typeof incoming === 'string'
          ? new Date(incoming)
          : incoming;

      const current = (project as unknown as Record<string, unknown>)[field];
      if (this.valuesAreEqual(current, normalisedIncoming)) continue;

      /* Dates serialise to ISO strings; everything else (including
       * decimal money fields kept as strings) flows through verbatim. */
      const beforeForAudit =
        current instanceof Date ? current.toISOString() : (current ?? null);
      const afterForAudit =
        normalisedIncoming instanceof Date
          ? normalisedIncoming.toISOString()
          : (normalisedIncoming ?? null);

      changesPayload[field] = {
        before: beforeForAudit,
        after: afterForAudit,
      };
      changedFields.push(field);

      /* Apply the change to the entity. `?? null` collapses undefined
       * to null so nullable columns clear correctly when the caller
       * passes an explicit null. */
      (project as unknown as Record<string, unknown>)[field] =
        normalisedIncoming ?? null;
    }

    /* Persist the project even if no fields changed — the caller may
     * have mutated relations (countries, budgets) that need flushing.
     * Audit rows are only written for actual scalar changes. */
    const saved = await manager.save(Project, project);

    if (changedFields.length > 0) {
      /* Log success WITHOUT field values — they may include sensitive
       * data such as budget figures. Field names + counts are safe. */
      this.logger.log(
        `Project ${saved.id} scalar edits applied; ` +
          `${changedFields.length} field(s) changed`,
      );
    }

    return {
      saved,
      changes: changedFields.length > 0 ? changesPayload : null,
      changedFields,
    };
  }

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

    /* Audit the create. We snapshot the persisted entity (post-save so
     * generated columns like id/createdAt are populated) and project the
     * fields that matter into a `changes`-shaped payload (`before: null`
     * + `after: value`) so the audit log renders symmetrically with
     * project.update events.
     *
     * AuditService.record() never throws — failures here are swallowed
     * and warned, so a flaky audit table can never break a project
     * create. */
    const created = await this.findOne(savedId);
    const snapshotFields: ReadonlyArray<keyof Project> = [
      'code',
      'name',
      'description',
      'summary',
      'results',
      'startDate',
      'endDate',
      'totalBudget',
      'remainingBudget',
      'fundingSource',
      'funder',
      'status',
      'centerId',
    ];
    const snapshotChanges: AuditEventChanges = {};
    for (const field of snapshotFields) {
      const value = created[field];
      snapshotChanges[field as string] = {
        before: null,
        after: value instanceof Date ? value.toISOString() : (value ?? null),
      };
    }

    await this.auditService.record({
      entityType: AuditEntityType.PROJECT,
      entityId: created.id,
      action: 'project.create',
      summary: `Created project ${created.code}`,
      changes: snapshotChanges,
    });

    return created;
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

    /* Server-side suggestion gate. When `suggestedOnly=true`, run the
     * same greedy walk that powers `GET /projects/suggested-to-reach-target`,
     * carrying over every filter the list query understands so the
     * suggestion candidate pool matches what the user is browsing. The
     * resulting `projectIds` then become the only additional WHERE
     * constraint applied to the list query — pagination and sorting
     * keep working unchanged.
     *
     * Empty suggestion → short-circuit with an empty page; running the
     * list query with `IN ()` would be syntactically invalid and an
     * extra round-trip we don't need. */
    let suggestedProjectIds: number[] | null = null;
    if (query.suggestedOnly === true) {
      const suggBudgetYear = query.suggestionBudgetYear ?? budgetYear;
      const suggDto: ProjectSuggestedQueryDto = {
        search: query.search,
        centerId: query.centerId,
        status: query.status,
        mappingStatus: query.mappingStatus,
        fundingSource: query.fundingSource,
        programIds: query.programIds,
        budgetYear: suggBudgetYear,
        target: query.suggestionTarget,
      };
      const suggestion = await this.getSuggestedToReachTarget(suggDto, user);
      suggestedProjectIds = suggestion.projectIds;

      this.logger.log(
        `findAll suggestedOnly: picked ${suggestedProjectIds.length} project(s) ` +
          `for target ${suggestion.target}% / budgetYear ${suggBudgetYear}.`,
      );

      if (suggestedProjectIds.length === 0) {
        return {
          data: [],
          total: 0,
          page: query.page,
          limit: query.limit,
        };
      }
    }

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
      /* Flag rows where negotiation is currently active — at least one
       * mapping is in `negotiating` status and the project itself is not
       * locked. Used by the projects table to highlight the "Negotiation"
       * action button so reviewers can spot in-flight rounds at a glance. */
      .addSelect(
        `(
          CASE
            WHEN project.negotiation_locked = 0
              AND EXISTS (
                SELECT 1
                FROM project_mappings pm_neg
                WHERE pm_neg.project_id = project.id
                  AND pm_neg.status = :negotiatingStatus
              )
            THEN 1 ELSE 0
          END
        )`,
        'in_active_negotiation',
      )
      .setParameter('negotiatingStatus', MappingStatus.NEGOTIATING)
      /* Derive the per-project mapping-status bucket (locked /
       * in_negotiation / draft / none). Same SQL expression is reused for
       * the optional `mappingStatus` filter below so the rendered value
       * and the filter never drift. */
      .addSelect(MAPPING_STATUS_SQL, 'mapping_status')
      .setParameters({
        mappingStatusLocked: MappingStatusFilter.LOCKED,
        mappingStatusInNegotiation: MappingStatusFilter.IN_NEGOTIATION,
        mappingStatusDraftFilter: MappingStatusFilter.DRAFT,
        mappingStatusNone: MappingStatusFilter.NONE,
        mappingStatusNegotiating: MappingStatus.NEGOTIATING,
        mappingStatusAgreed: MappingStatus.AGREED,
        mappingStatusDraft: MappingStatus.DRAFT,
      })
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
      .addSelect('COALESCE(pby.amount, 0)', 'budget_year')
      /* Aggregate the list of mapped programs per project as JSON. Returns a
       * JSON array of {id, name, officialCode, status} objects for every
       * non-removed mapping, so the UI can render program acronym chips with
       * tooltips (and badge negotiating mappings differently from agreed).
       * MySQL 8's JSON_ARRAYAGG is order-undefined; we sort client-side. */
      .addSelect(
        `(
          SELECT JSON_ARRAYAGG(
            JSON_OBJECT(
              'id', p.id,
              'name', p.name,
              'officialCode', p.official_code,
              'status', pm_prog_list.status
            )
          )
          FROM project_mappings pm_prog_list
          INNER JOIN programs p ON p.id = pm_prog_list.program_id
          WHERE pm_prog_list.project_id = project.id
            AND pm_prog_list.status != :progListRemovedStatus
        )`,
        'mapped_programs',
      )
      .setParameter('progListRemovedStatus', MappingStatus.REMOVED);

    /* Center reps only see projects belonging to their center */
    if (user?.role === UserRole.CENTER_REP && user.centerId) {
      qb.andWhere('project.centerId = :userCenterId', {
        userCenterId: user.centerId,
      });

      /* showExcluded=true → ONLY excluded projects (filter view).
       * showExcluded=false/absent → hide excluded (default view).
       * Correlated EXISTS/NOT EXISTS is cheaper than LEFT JOIN + IS NULL
       * at typical exclusion counts. */
      if (query.showExcluded) {
        qb.andWhere(
          `EXISTS (
            SELECT 1 FROM project_exclusions pe_excl
            WHERE pe_excl.project_id = project.id
              AND pe_excl.center_id = :excludingCenterId
          )`,
          { excludingCenterId: user.centerId },
        );
      } else {
        qb.andWhere(
          `NOT EXISTS (
            SELECT 1 FROM project_exclusions pe_excl
            WHERE pe_excl.project_id = project.id
              AND pe_excl.center_id = :excludingCenterId
          )`,
          { excludingCenterId: user.centerId },
        );
      }
    }

    /* Admins can also view excluded projects across all centers via
     * showExcluded=true, which restricts the list to projects with at least
     * one exclusion record (any center). Default admin view is unfiltered. */
    if (user?.role === UserRole.ADMIN && query.showExcluded) {
      qb.andWhere(
        `EXISTS (
          SELECT 1 FROM project_exclusions pe_excl_admin
          WHERE pe_excl_admin.project_id = project.id
        )`,
      );
    }

    /* Program reps only see projects with a non-removed mapping to their
     * program. Mirrors the ownership check used in mappings.service.ts
     * (assertCanChat) so visibility and action permissions stay aligned. */
    if (user?.role === UserRole.PROGRAM_REP && user.programId) {
      qb.andWhere(
        `EXISTS (
          SELECT 1
          FROM project_mappings pm_prog
          WHERE pm_prog.project_id = project.id
            AND pm_prog.program_id = :userProgramId
            AND pm_prog.status != :removedStatus
        )`,
        {
          userProgramId: user.programId,
          removedStatus: MappingStatus.REMOVED,
        },
      );
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

    /* Filter by one or more programs — projects with a non-removed mapping
     * to ANY selected program. Mirrors the program-rep visibility filter
     * above, but driven by the user-supplied list rather than the user's
     * own programId. Empty arrays are treated as "no filter" so an
     * unselected MultiSelect doesn't accidentally hide every row. */
    if (query.programIds?.length) {
      qb.andWhere(
        `EXISTS (
          SELECT 1
          FROM project_mappings pm_filter
          WHERE pm_filter.project_id = project.id
            AND pm_filter.program_id IN (:...filterProgramIds)
            AND pm_filter.status != :filterRemovedStatus
        )`,
        {
          filterProgramIds: query.programIds,
          filterRemovedStatus: MappingStatus.REMOVED,
        },
      );
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

    /* Restrict to projects with an active negotiation: project unlocked AND
     * at least one mapping in `negotiating`. Mirrors the per-row
     * `inActiveNegotiation` flag exactly so the toolbar toggle and the
     * highlighted button stay in lockstep. */
    if (query.inNegotiation === true) {
      qb.andWhere('project.negotiation_locked = 0').andWhere(
        `EXISTS (
          SELECT 1
          FROM project_mappings pm_neg_filter
          WHERE pm_neg_filter.project_id = project.id
            AND pm_neg_filter.status = :inNegFilterStatus
        )`,
        { inNegFilterStatus: MappingStatus.NEGOTIATING },
      );
    }

    /* Restrict to projects with at least one agreed mapping. Mirrors the
     * "Mapped %" KPI definition (status='agreed' counts; negotiating
     * mappings do not) so the filter and the KPI tile use the same lens. */
    if (query.mapped === true) {
      qb.andWhere(
        `EXISTS (
          SELECT 1
          FROM project_mappings pm_agreed_filter
          WHERE pm_agreed_filter.project_id = project.id
            AND pm_agreed_filter.status = :mappedFilterStatus
        )`,
        { mappedFilterStatus: MappingStatus.AGREED },
      );
    }

    /* Filter by the derived per-project mapping-status bucket. Uses the
     * same SQL expression that powers the `mapping_status` addSelect so
     * the filter and the displayed value can never disagree. Parameters
     * for the CASE branches are already bound at the top of this query
     * builder; we only bind the caller's chosen bucket here. */
    if (query.mappingStatus) {
      qb.andWhere(`${MAPPING_STATUS_SQL} = :mappingStatusFilter`, {
        mappingStatusFilter: query.mappingStatus,
      });
    }

    /* Date-range filters on start_date / end_date. Bounds are inclusive on
     * both sides; the DTO's @IsDateString already rejects malformed input.
     * Bind the raw YYYY-MM-DD string (not a JS Date) — the mysql2 driver
     * applies a timezone offset to Date objects bound against DATE columns,
     * which shifts the calendar day. */
    if (query.startDateFrom) {
      qb.andWhere('project.start_date >= :startDateFrom', {
        startDateFrom: query.startDateFrom,
      });
    }
    if (query.startDateTo) {
      qb.andWhere('project.start_date <= :startDateTo', {
        startDateTo: query.startDateTo,
      });
    }
    if (query.endDateFrom) {
      qb.andWhere('project.end_date >= :endDateFrom', {
        endDateFrom: query.endDateFrom,
      });
    }
    if (query.endDateTo) {
      qb.andWhere('project.end_date <= :endDateTo', {
        endDateTo: query.endDateTo,
      });
    }

    /* Suggestion narrowing — applied last so it intersects with every
     * other filter above. The IDs are ordered by contribution DESC and
     * become the only remaining knob that distinguishes the result set
     * from the broader candidate pool. */
    if (suggestedProjectIds && suggestedProjectIds.length > 0) {
      qb.andWhere('project.id IN (:...suggestedIds)', {
        suggestedIds: suggestedProjectIds,
      });
    }

    /* Sort whitelist — class-validator's @IsIn already rejects unknown
     * values with 400; the lookup table is the only path from validated
     * field name to SQL column, so untrusted strings can never reach
     * orderBy(). Default keeps the original behaviour.
     *
     * When `suggestedOnly` is active and the caller did not request an
     * explicit sort, preserve the greedy algorithm's contribution-DESC
     * ranking by ordering rows via `FIELD(project.id, ...ids)`. An
     * explicit sortField still wins so users can re-sort the narrowed
     * suggestion list by name/budget/etc. */
    if (query.sortField) {
      const sqlColumn = SORT_FIELD_TO_SQL[query.sortField];
      qb.orderBy(sqlColumn, query.sortOrder ?? 'ASC');
    } else if (suggestedProjectIds && suggestedProjectIds.length > 0) {
      qb.orderBy(`FIELD(project.id, ${suggestedProjectIds.join(',')})`, 'ASC');
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

    /* When showExcluded is requested, load exclusion records for the current
     * page so we can attach them to each excluded row. Center reps see only
     * their own center's exclusions; admins see exclusions from any center
     * (one row per project; if a project is excluded by multiple centers we
     * surface the most recent record). We only fetch the IDs in the current
     * page to keep the lookup O(page size). */
    let exclusionMap = new Map<number, ProjectExclusion>();
    if (query.showExcluded) {
      const pageIds = entities.map((e) => e.id).filter(Boolean);
      if (pageIds.length) {
        const exclusionWhere =
          user?.role === UserRole.CENTER_REP && user.centerId
            ? { centerId: user.centerId }
            : user?.role === UserRole.ADMIN
              ? {}
              : null;
        if (exclusionWhere !== null) {
          const exclusions = await this.exclusionRepository.find({
            where: exclusionWhere,
            relations: ['excludedBy', 'center'],
            order: { excludedAt: 'DESC' },
          });
          for (const exc of exclusions) {
            if (
              pageIds.includes(exc.projectId) &&
              !exclusionMap.has(exc.projectId)
            ) {
              exclusionMap.set(exc.projectId, exc);
            }
          }
        }
      }
    }

    const data: ProjectListItem[] = entities.map((entity, idx) => {
      const rawRow = raw[idx] as
        | {
            needs_assistance_mapping_count?: string | number | null;
            agreed_percent?: string | number | null;
            budget_year?: string | number | null;
            in_active_negotiation?: string | number | null;
            mapping_status?: string | null;
            mapped_programs?: string | unknown[] | null;
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

      /* JSON_ARRAYAGG can return a JSON string or a parsed array depending on
       * the driver. Normalize to an array, deduplicate by program id (a
       * project can have at most one non-removed mapping per program but
       * defensive code is cheap), and sort by official code for stable UI. */
      const parsePrograms = (
        value: unknown,
      ): ProjectListItem['mappedPrograms'] => {
        if (!value) return [];
        let parsed: unknown = value;
        if (typeof value === 'string') {
          try {
            parsed = JSON.parse(value);
          } catch {
            return [];
          }
        }
        if (!Array.isArray(parsed)) return [];
        const seen = new Set<number>();
        const programs: ProjectListItem['mappedPrograms'] = [];
        for (const row of parsed) {
          if (!row || typeof row !== 'object') continue;
          const r = row as Record<string, unknown>;
          const id = toNumber(r.id);
          if (!id || seen.has(id)) continue;
          seen.add(id);
          programs.push({
            id,
            name: String(r.name ?? ''),
            officialCode: String(r.officialCode ?? ''),
            status: r.status as MappingStatus,
          });
        }
        programs.sort((a, b) => a.officialCode.localeCompare(b.officialCode));
        return programs;
      };

      /* Attach exclusion info when showExcluded is active and the project
       * is in the exclusion map for this center. Null for non-excluded rows
       * so the frontend can distinguish "excluded" vs "not excluded". */
      const exc = exclusionMap.get(entity.id) ?? null;
      const exclusion: ProjectListItem['exclusion'] = exc
        ? {
            reason: exc.reason,
            excludedAt: exc.excludedAt,
            excludedBy: {
              id: exc.excludedBy.id,
              firstName: exc.excludedBy.firstName,
              lastName: exc.excludedBy.lastName,
            },
            center: {
              id: exc.center.id,
              name: exc.center.name,
              acronym: exc.center.acronym,
            },
          }
        : null;

      /* Normalise the raw CASE output to one of the four valid bucket
       * strings. The SQL always returns one of them, but typing the raw
       * column as `string | null` keeps the cast honest if the row was
       * somehow null. */
      const rawMappingStatus = rawRow?.mapping_status;
      const mappingStatus: MappingStatusFilter =
        rawMappingStatus === MappingStatusFilter.LOCKED ||
        rawMappingStatus === MappingStatusFilter.IN_NEGOTIATION ||
        rawMappingStatus === MappingStatusFilter.DRAFT
          ? (rawMappingStatus as MappingStatusFilter)
          : MappingStatusFilter.NONE;

      return Object.assign(entity, {
        needsAssistanceMappingCount: toNumber(
          rawRow?.needs_assistance_mapping_count,
        ),
        agreedAllocatedPercent: toNumber(rawRow?.agreed_percent),
        budget2026: toNumber(rawRow?.budget_year),
        inActiveNegotiation: toNumber(rawRow?.in_active_negotiation) === 1,
        mappingStatus,
        mappedPrograms: parsePrograms(rawRow?.mapped_programs),
        exclusion,
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
        qb.andWhere('project.centerId = :sumUserCenterId', {
          sumUserCenterId: user.centerId,
        });

        /* showExcluded=true → ONLY excluded projects in KPI totals.
         * showExcluded=false/absent → exclude them. Mirrors findAll so tiles
         * always match the filtered list. */
        if (query.showExcluded) {
          qb.andWhere(
            `EXISTS (
              SELECT 1 FROM project_exclusions pe_sum
              WHERE pe_sum.project_id = project.id
                AND pe_sum.center_id = :sumExcludingCenterId
            )`,
            { sumExcludingCenterId: user.centerId },
          );
        } else {
          qb.andWhere(
            `NOT EXISTS (
              SELECT 1 FROM project_exclusions pe_sum
              WHERE pe_sum.project_id = project.id
                AND pe_sum.center_id = :sumExcludingCenterId
            )`,
            { sumExcludingCenterId: user.centerId },
          );
        }
      }

      /* Admin showExcluded → restrict KPI tiles to projects with at least
       * one exclusion record (any center), matching findAll. */
      if (user?.role === UserRole.ADMIN && query.showExcluded) {
        qb.andWhere(
          `EXISTS (
            SELECT 1 FROM project_exclusions pe_sum_admin
            WHERE pe_sum_admin.project_id = project.id
          )`,
        );
      }

      /* Program reps only see projects with a non-removed mapping to their
       * program. Mirrors findAll's scoping so the KPI tiles match the
       * filtered list rows the user is browsing. */
      if (user?.role === UserRole.PROGRAM_REP && user.programId) {
        qb.andWhere(
          `EXISTS (
            SELECT 1
            FROM project_mappings pm_prog
            WHERE pm_prog.project_id = project.id
              AND pm_prog.program_id = :userProgramId
              AND pm_prog.status != :removedStatus
          )`,
          {
            userProgramId: user.programId,
            removedStatus: MappingStatus.REMOVED,
          },
        );
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
      /* Multi-program filter — same EXISTS shape as findAll so totals
       * match the rows the user is browsing. */
      if (query.programIds?.length) {
        qb.andWhere(
          `EXISTS (
            SELECT 1
            FROM project_mappings pm_filter
            WHERE pm_filter.project_id = project.id
              AND pm_filter.program_id IN (:...filterProgramIds)
              AND pm_filter.status != :filterRemovedStatus
          )`,
          {
            filterProgramIds: query.programIds,
            filterRemovedStatus: MappingStatus.REMOVED,
          },
        );
      }
      /* In-negotiation filter — same predicate as findAll. */
      if (query.inNegotiation === true) {
        qb.andWhere('project.negotiation_locked = 0').andWhere(
          `EXISTS (
            SELECT 1
            FROM project_mappings pm_neg_filter
            WHERE pm_neg_filter.project_id = project.id
              AND pm_neg_filter.status = :inNegFilterStatus
          )`,
          { inNegFilterStatus: MappingStatus.NEGOTIATING },
        );
      }
      /* Mapped filter — at least one agreed mapping. */
      if (query.mapped === true) {
        qb.andWhere(
          `EXISTS (
            SELECT 1
            FROM project_mappings pm_agreed_filter
            WHERE pm_agreed_filter.project_id = project.id
              AND pm_agreed_filter.status = :mappedFilterStatus
          )`,
          { mappedFilterStatus: MappingStatus.AGREED },
        );
      }
      /* Mapping-status filter — reuse the same derived-column SQL as
       * findAll so KPI tiles always agree with the rendered rows. The
       * CASE references enum strings via :mappingStatus<X> bind
       * parameters; set them once here so the andWhere can refer to
       * them by name. */
      if (query.mappingStatus) {
        qb.setParameters({
          mappingStatusLocked: MappingStatusFilter.LOCKED,
          mappingStatusInNegotiation: MappingStatusFilter.IN_NEGOTIATION,
          mappingStatusDraftFilter: MappingStatusFilter.DRAFT,
          mappingStatusNone: MappingStatusFilter.NONE,
          mappingStatusNegotiating: MappingStatus.NEGOTIATING,
          mappingStatusAgreed: MappingStatus.AGREED,
          mappingStatusDraft: MappingStatus.DRAFT,
        });
        qb.andWhere(`${MAPPING_STATUS_SQL} = :mappingStatusFilter`, {
          mappingStatusFilter: query.mappingStatus,
        });
      }
      /* Date-range filters — identical predicates to findAll so the
       * KPI tiles always match the rows the user is browsing. Bind raw
       * YYYY-MM-DD strings; mysql2 shifts JS Dates by tz offset. */
      if (query.startDateFrom) {
        qb.andWhere('project.start_date >= :startDateFrom', {
          startDateFrom: query.startDateFrom,
        });
      }
      if (query.startDateTo) {
        qb.andWhere('project.start_date <= :startDateTo', {
          startDateTo: query.startDateTo,
        });
      }
      if (query.endDateFrom) {
        qb.andWhere('project.end_date >= :endDateFrom', {
          endDateFrom: query.endDateFrom,
        });
      }
      if (query.endDateTo) {
        qb.andWhere('project.end_date <= :endDateTo', {
          endDateTo: query.endDateTo,
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
        qb.andWhere('project.centerId = :suggUserCenterId', {
          suggUserCenterId: user.centerId,
        });

        /* Suggestion candidates exclude hidden projects — a project the
         * center chose to hide is unlikely to be a useful mapping target. */
        qb.andWhere(
          `NOT EXISTS (
            SELECT 1 FROM project_exclusions pe_sugg
            WHERE pe_sugg.project_id = project.id
              AND pe_sugg.center_id = :suggExcludingCenterId
          )`,
          { suggExcludingCenterId: user.centerId },
        );
      }

      /* Program reps only see projects with a non-removed mapping to their
       * program. Suggestions for projects outside the program rep's scope
       * would not be actionable. */
      if (user?.role === UserRole.PROGRAM_REP && user.programId) {
        qb.andWhere(
          `EXISTS (
            SELECT 1
            FROM project_mappings pm_prog
            WHERE pm_prog.project_id = project.id
              AND pm_prog.program_id = :userProgramId
              AND pm_prog.status != :removedStatus
          )`,
          {
            userProgramId: user.programId,
            removedStatus: MappingStatus.REMOVED,
          },
        );
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
      /* Multi-program filter — same EXISTS shape as findAll/getSummary. */
      if (query.programIds?.length) {
        qb.andWhere(
          `EXISTS (
            SELECT 1
            FROM project_mappings pm_filter
            WHERE pm_filter.project_id = project.id
              AND pm_filter.program_id IN (:...filterProgramIds)
              AND pm_filter.status != :filterRemovedStatus
          )`,
          {
            filterProgramIds: query.programIds,
            filterRemovedStatus: MappingStatus.REMOVED,
          },
        );
      }
      /* Mapping-status filter — kept in sync with findAll/getSummary so
       * the suggestion candidate pool reflects the same scope the user
       * is browsing on the list. */
      if (query.mappingStatus) {
        qb.setParameters({
          mappingStatusLocked: MappingStatusFilter.LOCKED,
          mappingStatusInNegotiation: MappingStatusFilter.IN_NEGOTIATION,
          mappingStatusDraftFilter: MappingStatusFilter.DRAFT,
          mappingStatusNone: MappingStatusFilter.NONE,
          mappingStatusNegotiating: MappingStatus.NEGOTIATING,
          mappingStatusAgreed: MappingStatus.AGREED,
          mappingStatusDraft: MappingStatus.DRAFT,
        });
        qb.andWhere(`${MAPPING_STATUS_SQL} = :mappingStatusFilter`, {
          mappingStatusFilter: query.mappingStatus,
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
  async findOne(
    id: number,
    requestingUser?: User,
  ): Promise<
    Project & {
      exclusion?: {
        reason: string;
        excludedAt: Date;
        excludedBy: { id: number; firstName: string; lastName: string };
        center: { id: number; name: string; acronym: string };
      } | null;
    }
  > {
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

    /* For center reps (and admins), attach the exclusion record if one
     * exists so the detail page can render the exclusion banner without
     * a second API call. The centerId used is the center rep's own center;
     * for admins it is the project's owning center (mirroring exclude()). */
    if (
      requestingUser?.role === UserRole.CENTER_REP ||
      requestingUser?.role === UserRole.ADMIN
    ) {
      const centerId =
        requestingUser.role === UserRole.ADMIN
          ? project.centerId
          : (requestingUser.centerId ?? 0);

      if (centerId) {
        const exc = await this.exclusionRepository.findOne({
          where: { projectId: id, centerId },
          relations: ['excludedBy', 'center'],
        });

        return Object.assign(project, {
          exclusion: exc
            ? {
                reason: exc.reason,
                excludedAt: exc.excludedAt,
                excludedBy: {
                  id: exc.excludedBy.id,
                  firstName: exc.excludedBy.firstName,
                  lastName: exc.excludedBy.lastName,
                },
                center: {
                  id: exc.center.id,
                  name: exc.center.name,
                  acronym: exc.center.acronym,
                },
              }
            : null,
        });
      }
    }

    return Object.assign(project, { exclusion: null });
  }

  /**
   * Updates an existing project on the admin path.
   *
   * Handles partial updates including country relation replacement when
   * `countryIds` is provided and a full diff/insert/delete of the
   * `project_budgets` child table when `budgets` is provided. Scalar
   * field changes are routed through `applyEdits`, which writes one
   * `project_audit_events` row per actual change. Country and budget
   * mutations are intentionally NOT audited at this layer — the plan
   * limits the audit trail to scalar metadata for v1.
   *
   * `user` is optional today so the existing controller call site
   * (which does not yet pass it — that's task B2) keeps compiling. When
   * omitted, scalar changes are still applied but no audit rows are
   * written; logged at warn level so the gap is visible during dev.
   *
   * @param id - Project ID.
   * @param dto - Validated update payload (partial).
   * @param user - Authenticated user (drives the audit trail).
   * @returns The updated project with relations loaded.
   * @throws NotFoundException if the project does not exist.
   * @throws ConflictException if updating the code to one that already exists.
   */
  async update(
    id: number,
    dto: UpdateProjectDto,
    user?: User,
  ): Promise<Project> {
    /* Capture diff results from inside the transaction so the audit
     * event can be recorded after commit (AuditService.record() does
     * its own try/catch — keeping it outside the TX guards the user's
     * primary write against an audit-side failure). */
    let auditChanges: AuditEventChanges | null = null;
    let auditChangedFields: string[] = [];

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

      /* Resolve countries if provided. Country list changes are not
       * recorded as audit events in v1. */
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

      /* Budget diff: update rows with a matching id, insert new rows with
       * no id, and delete existing rows that are missing from the payload.
       * When dto.budgets is undefined we leave the budget collection
       * untouched (consistent with countries/countryIds semantics).
       * Budget edits are NOT routed through applyEdits — they're a child
       * collection, not a scalar field, and the plan keeps them out of
       * the audit trail in v1. */
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

      /* Scalar field changes + diff capture. The diff is collected here
       * but the audit event is recorded after the transaction commits
       * (see below) so an audit-side failure cannot roll back the edit. */
      const result = await this.applyEdits(
        project,
        dto as Partial<Record<string, unknown>>,
        manager,
      );
      auditChanges = result.changes;
      auditChangedFields = result.changedFields;

      if (!user) {
        this.logger.warn(
          `Project ${id} updated without an authenticated actor — ` +
            `audit row skipped (controller has not been migrated to ` +
            `pass req.user yet)`,
        );
      }
    });

    /* Record the audit event post-commit. Skip when no scalar field
     * actually changed (computeChanges-equivalent null result) so we
     * don't litter the log with empty diffs from relation-only edits. */
    if (user && auditChanges) {
      await this.auditService.record({
        entityType: AuditEntityType.PROJECT,
        entityId: id,
        action: 'project.update',
        changes: auditChanges,
        justification: dto.justification ?? null,
        summary: `Edited project: ${auditChangedFields.join(', ')}`,
      });
    }

    return this.findOne(id);
  }

  /**
   * Unit-admin (PPU/PCU) project metadata update.
   *
   * Edits a strictly whitelisted subset of scalar fields on any project,
   * regardless of `negotiation_locked`. Defense-in-depth filters the
   * payload to `UNIT_ADMIN_EDITABLE_FIELDS` even though the DTO already
   * restricts the shape — this guards against future drift between the
   * DTO and the constant if the two are edited independently.
   *
   * Every successful edit writes one `project_audit_events` row per
   * changed field with the supplied justification.
   *
   * @param id - Project ID.
   * @param dto - Validated unit-admin payload; `justification` required.
   * @param user - Authenticated user (must be `unit_admin` or `admin`;
   *               role gating is enforced at the controller).
   * @returns The updated project with relations loaded.
   * @throws NotFoundException if the project does not exist.
   * @throws BadRequestException if no whitelisted field changed, or if
   *         the dto contains a non-whitelisted scalar.
   */
  async unitAdminUpdate(
    id: number,
    dto: UnitAdminUpdateProjectDto,
    user: User,
  ): Promise<Project> {
    /* Capture diff results from inside the transaction so the audit
     * event can be recorded after commit. */
    let auditChanges: AuditEventChanges | null = null;
    let auditChangedFields: string[] = [];

    await this.dataSource.transaction(async (manager) => {
      const project = await manager.findOne(Project, { where: { id } });
      if (!project) {
        throw new NotFoundException(`Project with ID "${id}" not found`);
      }

      /* Defense-in-depth: only accept keys explicitly listed in the
       * whitelist (plus the always-allowed `justification`). Any other
       * scalar present on the dto is rejected with a 400 naming the
       * offending field — better than silently dropping it. */
      const whitelist = new Set<string>(UNIT_ADMIN_EDITABLE_FIELDS);
      const filtered: Partial<Record<UnitAdminEditableField, unknown>> = {};

      for (const [key, value] of Object.entries(dto)) {
        if (key === 'justification') continue;
        if (!whitelist.has(key)) {
          throw new BadRequestException(
            `Field "${key}" is not editable by unit_admin`,
          );
        }
        if (value !== undefined) {
          (filtered as Record<string, unknown>)[key] = value;
        }
      }

      if (Object.keys(filtered).length === 0) {
        throw new BadRequestException('No editable fields provided');
      }

      /* Hand off to the shared applier — it computes the per-field diff
       * and persists the project. Audit emission happens post-commit
       * via auditService.record() to keep audit failures from rolling
       * back the user's primary edit. negotiation_locked is intentionally
       * not consulted here: that gate is exactly what unit_admin exists
       * to bypass. */
      const result = await this.applyEdits(
        project,
        filtered as Partial<Record<string, unknown>>,
        manager,
      );
      auditChanges = result.changes;
      auditChangedFields = result.changedFields;
    });

    /* Always record an audit event for the unit_admin path — even when
     * no field changed, the call carried a justification and represents
     * an intentional review. The `changes` payload is null in that case
     * so the row still serves as a "metadata reviewed" trace. The user's
     * primary write has already committed; record() never throws. */
    if (auditChangedFields.length > 0) {
      await this.auditService.record({
        entityType: AuditEntityType.PROJECT,
        entityId: id,
        action: 'project.metadata_update',
        changes: auditChanges,
        justification: dto.justification,
        summary: `Edited metadata: ${auditChangedFields.join(', ')}`,
      });
    }

    return this.findOne(id);
  }

  /**
   * Retrieves a paginated audit history for a project.
   *
   * Transitional shape (Phase A.3 → B.6): delegates to AuditService.query
   * scoped to `entityType=project` + `entityId=:projectId`. The response
   * shape returns `AuditEvent[]` directly under `data` — Phase B.6 will
   * adapt the frontend Activity tab to consume the unified shape, at
   * which point this controller route will be removed in favour of the
   * generic `/audit?entityType=project&entityId=...` endpoint.
   *
   * Project existence is verified up front so a 404 cleanly distinguishes
   * "project not found" from "project has no audit history yet" (which is
   * a valid empty result for projects that have never been edited under
   * the new audit-trail regime).
   *
   * @param projectId  - Project ID.
   * @param page       - 1-based page number (validated upstream by the DTO).
   * @param limit      - Page size (validated upstream by the DTO).
   * @param callerRole - Authenticated caller's role (for visibility scoping).
   * @param callerUserId - Authenticated caller's user id.
   * @returns Paginated envelope matching the convention used by `findAll`.
   * @throws NotFoundException if the project does not exist.
   */
  async getAuditHistory(
    projectId: number,
    page: number,
    limit: number,
    callerRole: UserRole,
    callerUserId: number,
  ): Promise<{
    data: AuditEvent[];
    total: number;
    page: number;
    limit: number;
  }> {
    /* Existence check — keeps the 404 contract explicit. A simple
     * findOneBy is enough; we only need to confirm the row exists. */
    const project = await this.projectRepository.findOneBy({ id: projectId });
    if (!project) {
      throw new NotFoundException(`Project with ID "${projectId}" not found`);
    }

    const { items, total } = await this.auditService.query(
      {
        entityType: AuditEntityType.PROJECT,
        entityId: projectId,
        page,
        limit,
        sort: 'created_at',
        direction: 'desc',
      },
      callerRole,
      callerUserId,
    );

    return { data: items, total, page, limit };
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

    const previousStatus = project.status;
    project.status = ProjectStatus.ARCHIVED;
    await this.projectRepository.save(project);
    this.logger.log(`Project "${project.code}" (${id}) archived`);

    /* Record an archive event so the audit log shows the lifecycle
     * transition. The status diff doubles as a useful "before vs after"
     * for the UI. AuditService.record() never throws — best-effort. */
    await this.auditService.record({
      entityType: AuditEntityType.PROJECT,
      entityId: id,
      action: 'project.archive',
      summary: `Archived project ${project.code}`,
      changes: {
        status: { before: previousStatus, after: ProjectStatus.ARCHIVED },
      },
    });
  }
}
