import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  Repository,
  SelectQueryBuilder,
  In,
} from 'typeorm';
import { Project } from './entities/project.entity';
import { ProjectBudget } from './entities/project-budget.entity';
import { ProjectExclusion } from './entities/project-exclusion.entity';
import { ProjectBenefitCountry } from './entities/project-benefit-country.entity';
import { ProjectImplementationCountry } from './entities/project-implementation-country.entity';
import { Center } from '../reference-data/entities/center.entity';
import { Country } from '../reference-data/entities/country.entity';
import { CountryAllocationDto } from './dto/country-allocation.dto';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import {
  UnitAdminUpdateProjectDto,
  UNIT_ADMIN_EDITABLE_FIELDS,
  UnitAdminEditableField,
  PI_FIELDS_ADMIN_CENTER_ONLY,
} from './dto/unit-admin-update-project.dto';
import { ProjectQueryDto, ProjectSortField } from './dto/project-query.dto';
import { ProjectSummaryQueryDto } from './dto/project-summary-query.dto';
import { ProjectSuggestedQueryDto } from './dto/project-suggested-query.dto';
import { ProjectStatus } from './enums/project-status.enum';
import { FundingSource } from './enums/funding-source.enum';
import {
  MappingStatusFilter,
  MappingFlagFilter,
} from './enums/mapping-status-filter.enum';
import { ProjectMapping } from '../mappings/entities/project-mapping.entity';
import { MappingStatus } from '../mappings/enums/mapping-status.enum';
import { MappingTocLinkType } from '../mappings/entities/mapping-toc-link.entity';
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
/*
 * "Removed" mappings do NOT count toward "In Negotiation" — a project whose
 * only mappings are `removed` has nothing actively under negotiation, so it
 * falls through to "Unmapped" ('none'). This mirrors the single-project
 * detail view (`getConsolidatedView`), which filters removed mappings out of
 * its `mappings` array and labels the resulting empty project "Unmapped".
 * Keeping the two surfaces in lockstep avoids the list showing
 * "In Negotiation" while the project page shows "Unmapped".
 */
const MAPPING_STATUS_SQL = `(
  CASE
    WHEN EXISTS (
      SELECT 1 FROM project_mappings pm_ms_admin
      WHERE pm_ms_admin.project_id = project.id
        AND pm_ms_admin.status = :mappingStatusAdminDecision
    ) THEN :mappingStatusAdminDecisionFilter
    WHEN project.negotiation_locked = 1 THEN :mappingStatusLocked
    WHEN EXISTS (
      SELECT 1 FROM project_mappings pm_ms
      WHERE pm_ms.project_id = project.id
        AND pm_ms.status IN (
          :mappingStatusNegotiating,
          :mappingStatusAgreed
        )
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
 * Predicate (not a CASE branch) identifying "ready to lock" projects:
 * unlocked, at least one non-removed mapping, EVERY non-removed mapping
 * `agreed`, AND the non-removed allocation total = 100% (within ±0.01 for
 * decimal safety). The only remaining action is the manual Lock click. This is
 * a sub-state of `in_negotiation`, so it is applied as a standalone WHERE
 * clause rather than a `MAPPING_STATUS_SQL` CASE bucket. Mirrors the
 * `readyToLockProjects` dashboard count so the projects-list filter and the
 * dashboard tile always agree.
 *
 * (A round normally auto-locks the instant it becomes fully agreed at 100%, so
 * this bucket mainly surfaces Signalling-imported rounds that were created
 * agreed-at-100% without passing through the auto-lock path.)
 */
const READY_TO_LOCK_SQL = `(
  project.negotiation_locked = 0
  AND EXISTS (
    SELECT 1 FROM project_mappings pm_rtl_any
    WHERE pm_rtl_any.project_id = project.id
      AND pm_rtl_any.status != :readyToLockRemoved
  )
  AND NOT EXISTS (
    SELECT 1 FROM project_mappings pm_rtl_pending
    WHERE pm_rtl_pending.project_id = project.id
      AND pm_rtl_pending.status NOT IN (:readyToLockAgreed, :readyToLockRemoved)
  )
  AND (
    SELECT COALESCE(SUM(pm_rtl_sum.allocation_percentage), 0)
    FROM project_mappings pm_rtl_sum
    WHERE pm_rtl_sum.project_id = project.id
      AND pm_rtl_sum.status != :readyToLockRemoved
  ) BETWEEN 99.99 AND 100.01
)`;

/**
 * Predicate (not a CASE branch) identifying "partially allocated" projects:
 * at least one non-removed mapping exists, but the SUM of their allocation
 * percentages is under 100. This is an allocation-total axis, orthogonal to
 * the negotiation-state buckets in `MAPPING_STATUS_SQL` — a partially
 * allocated project can be in any state (draft/negotiating/locked), so it is
 * applied as a standalone WHERE clause rather than a CASE bucket. Crucially
 * it EXCLUDES fully-unmapped projects (the EXISTS guard): those have no
 * mappings to top up, so they are not what "hasn't reached 100%" means here.
 * The center uses this to find projects they still need to allocate up to
 * 100% (as opposed to starting from scratch on unmapped ones).
 */
const PARTIALLY_ALLOCATED_SQL = `(
  EXISTS (
    SELECT 1 FROM project_mappings pm_pa_any
    WHERE pm_pa_any.project_id = project.id
      AND pm_pa_any.status != :partiallyAllocatedRemoved
  )
  AND (
    SELECT COALESCE(SUM(pm_pa_sum.allocation_percentage), 0)
    FROM project_mappings pm_pa_sum
    WHERE pm_pa_sum.project_id = project.id
      AND pm_pa_sum.status != :partiallyAllocatedRemoved
  ) < 100
)`;

/**
 * Predicate (not a CASE branch) identifying projects with at least one
 * active mapping whose TOC contribution is incomplete. Mirrors the
 * program-side agree gate (`assertTocLinksSatisfyAgreeGate` in
 * MappingsService): a mapping's TOC contribution is "filled" when it has
 * ≥1 `aow` link AND (≥1 `output` link OR ≥1 `outcome` link) in
 * `mapping_toc_links`. Note the gate counts ANY outcome link type
 * (intermediate or portfolio) — it does NOT join `toc_outcomes`, so this
 * predicate matches the gate exactly rather than the narrower
 * intermediate-only surfacing list.
 *
 * The project matches when it has ≥1 non-removed mapping that fails this
 * "filled" test — i.e. any active mapping still needs its TOC contribution.
 * Applied as a standalone WHERE clause (orthogonal to the negotiation-state
 * buckets in `MAPPING_STATUS_SQL`), like `partiallyAllocated`/`readyToLock`.
 *
 * `programScoped` narrows the inner mapping subquery to a single program
 * (`:missingTocProgramId`). A program rep can only fill TOC data on their
 * own mapping, so their filter must match projects where THEIR mapping is
 * incomplete — not a co-mapped program's. Unscoped (admin/center) keeps the
 * project-wide "any active mapping" semantics.
 *
 * Mappings with a pending removal request (`removal_requested = 1`) never
 * count: nobody fills TOC data on a mapping that may be about to be removed
 * (and the dashboard's tocMissing rule skips them too). If the center
 * declines the request the flag clears and the mapping re-enters this
 * predicate.
 *
 * `editableOnly` further restricts the subquery to mappings whose TOC links
 * the program rep can actually edit: `negotiating` / `agreed` /
 * `admin_decision` (mirrors the `setTocLinks` state gate — drafts reject,
 * and locked projects are intentionally editable, so there is no lock
 * guard). Used by the `needsMyAction` filter so it mirrors the dashboard
 * "Action Needed" panel.
 */
const missingTocContributionSql = (
  programScoped: boolean,
  editableOnly = false,
): string => `(
  EXISTS (
    SELECT 1 FROM project_mappings pm_toc
    WHERE pm_toc.project_id = project.id
      AND pm_toc.status != :missingTocRemoved
      AND pm_toc.removal_requested = 0${
        programScoped
          ? '\n      AND pm_toc.program_id = :missingTocProgramId'
          : ''
      }${
        editableOnly
          ? '\n      AND pm_toc.status IN (:...missingTocEditableStatuses)'
          : ''
      }
      AND NOT (
        EXISTS (
          SELECT 1 FROM mapping_toc_links mtl_aow
          WHERE mtl_aow.project_mapping_id = pm_toc.id
            AND mtl_aow.link_type = :missingTocAow
        )
        AND EXISTS (
          SELECT 1 FROM mapping_toc_links mtl_out
          WHERE mtl_out.project_mapping_id = pm_toc.id
            AND mtl_out.link_type IN (:missingTocOutput, :missingTocOutcome)
        )
      )
  )
)`;

/**
 * "Agreed" attribute-flag predicate — the project has ≥1 mapping in `agreed`
 * status. Orthogonal to the lifecycle buckets in `MAPPING_STATUS_SQL`, like
 * the other flag predicates.
 *
 * `programScoped` narrows the inner subquery to a single program
 * (`:agreedMappingProgramId`): a program rep's "Agreed" filter must reflect
 * whether THEIR mapping is agreed, not a co-mapped program's. Unscoped
 * (admin/center) matches any program's agreed mapping.
 */
const agreedMappingSql = (programScoped: boolean): string => `EXISTS (
  SELECT 1
  FROM project_mappings pm_agreed
  WHERE pm_agreed.project_id = project.id
    AND pm_agreed.status = :agreedMappingStatus${
      programScoped
        ? '\n    AND pm_agreed.program_id = :agreedMappingProgramId'
        : ''
    }
)`;

/**
 * "Removal requested" attribute-flag predicate — the project has ≥1
 * non-removed mapping with a pending program-rep removal request
 * (`removal_requested = 1`; the flag is cleared when the center accepts or
 * declines, so pending is the only state it captures). Orthogonal to the
 * lifecycle buckets, like the other flag predicates.
 *
 * `programScoped` narrows the inner subquery to a single program
 * (`:removalRequestedProgramId`): a program rep's chip reflects THEIR own
 * pending request, not a co-mapped program's. Unscoped (admin/center)
 * matches any program's pending request on the project.
 */
const removalRequestedSql = (programScoped: boolean): string => `EXISTS (
  SELECT 1
  FROM project_mappings pm_removal
  WHERE pm_removal.project_id = project.id
    AND pm_removal.status != :removalRequestedRemoved
    AND pm_removal.removal_requested = 1${
      programScoped
        ? '\n    AND pm_removal.program_id = :removalRequestedProgramId'
        : ''
    }
)`;

/**
 * "Actively negotiating" attribute-flag predicate — unlocked project with at
 * least one mapping in `negotiating` status. STRICT definition matching the
 * dashboard "Negotiating" tile. Shares the `:negotiatingFilterStatus` param
 * name (same constant value) with the standalone `negotiating=true` boolean
 * filter so the two can coexist in one query without a binding conflict.
 */
const NEGOTIATING_ACTIVE_SQL = `(
  project.negotiation_locked = 0
  AND EXISTS (
    SELECT 1 FROM project_mappings pm_negotiating_or
    WHERE pm_negotiating_or.project_id = project.id
      AND pm_negotiating_or.status = :negotiatingFilterStatus
  )
)`;

/**
 * "Needs assistance" attribute-flag predicate — the project has ≥1 mapping
 * flagged for workflow-admin assistance (auto-set after a program rep's 2nd
 * counter-proposal). Standalone WHERE clause, orthogonal to the lifecycle
 * buckets in `MAPPING_STATUS_SQL`, like the other flag predicates above.
 */
const NEEDS_ASSISTANCE_SQL = `EXISTS (
  SELECT 1
  FROM project_mappings pm_flag
  WHERE pm_flag.project_id = project.id
    AND pm_flag.needs_assistance = 1
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
   * Role-aware negotiation "turn" for the projects-list negotiation icon:
   *  - `'awaiting_me'`    — a live mapping needs THIS viewer's action
   *  - `'awaiting_other'` — a live round exists but it's the counterparty's turn
   *  - `null`             — no live negotiation in the viewer's scope (locked,
   *                         fully agreed/ready-to-lock, or unmapped)
   *
   * Center side (center_rep / workflow_admin) is awaiting itself when any
   * negotiating mapping still lacks the center's confirmation (`center_agreed
   * = 0`) or a program has requested a removal the center must resolve. A
   * program_rep is awaiting itself when their OWN program's negotiating
   * mapping still lacks `program_agreed`. Other roles never get `'awaiting_me'`
   * (they have no side to act on). Mirrors the dashboard's per-mapping
   * `!myAgreedFlag` rule so the list and dashboard never disagree.
   */
  negotiationTurn: 'awaiting_me' | 'awaiting_other' | null;
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
 * Identifies which projects-list filter dropdown a facet query is computing
 * options for. Passed to `applyFacetScopeAndFilters` so that facet's OWN
 * filter is omitted while every other active filter is still applied — the
 * standard "a facet stays self-selectable" rule for context-aware dropdowns.
 */
export type ProjectFacetKey =
  | 'center'
  | 'fundingSource'
  | 'funder'
  | 'programs'
  | 'mappingStatus';

/**
 * Available option values for each context-aware projects-list filter
 * dropdown, computed from the projects the caller can currently see under
 * the OTHER active filters. Powers "only show what's there" dropdowns: a
 * value is offered only when at least one project would match it given every
 * other active filter (each facet ignores its own current selection so the
 * user can still switch within it).
 */
export interface ProjectFilterOptions {
  /** Distinct `funding_source` values present. */
  fundingSources: FundingSource[];
  /** Distinct owning-center IDs present. */
  centerIds: number[];
  /** Distinct program IDs with ≥1 non-removed mapping present. */
  programIds: number[];
  /** Distinct non-empty funder names present, alphabetically sorted. */
  funders: string[];
  /**
   * Mapping-status dropdown values that match ≥1 project — the
   * `MappingStatusFilter` buckets plus the derived `negotiating` /
   * `ready_to_lock` / `partially_allocated` / `missing_toc` sub-states.
   */
  mappingStatuses: string[];
}

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
  /**
   * SUM(budget * negotiating_alloc / 100) — funding tied up in mappings still
   * in `negotiating` status (live, not yet agreed). Lets a center see in-flight
   * progress toward the 90% target alongside the committed (`mappedBudgetYear`)
   * figure. Excludes private `draft` rows.
   */
  inNegotiationBudgetYear: number;
  /** inNegotiationBudgetYear / totalBudgetYear * 100, 1 dp. 0 when total is 0. */
  inNegotiationPercent: number;
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
   * Canonicalises a decimal(10,2) value for diff + audit purposes.
   * TypeORM hydrates MySQL decimal columns as strings ("380351.00")
   * while DTOs carry numbers (380351) — a strict compare between the
   * two always reports a change, which polluted the audit trail with
   * false budget edits. Both sides funnel through Number → toFixed(2)
   * so the comparison is type-free and the audit payload stores the
   * canonical string form (decimals stay strings in audit JSON to
   * avoid IEEE 754 precision loss). null/undefined/'' collapse to
   * null; non-numeric garbage falls back to the raw string so a bad
   * value still surfaces as a change rather than crashing the diff.
   */
  private toCanonicalDecimal(value: unknown): string | null {
    if (value === null || value === undefined || value === '') return null;
    const num = Number(value);
    return Number.isFinite(num) ? num.toFixed(2) : String(value);
  }

  /**
   * Validates an incoming country-allocation list:
   *   - rejects 0-allocation rows (the DTO enforces > 0, but a raw API
   *     call could bypass class-validator);
   *   - rejects duplicate country IDs;
   *   - rejects sums > 100;
   *   - rejects rows whose countryId does not exist in `countries`.
   *
   * Returns a normalized `{ countryId, allocationPercentage }[]` for
   * the caller to persist. An empty / undefined input yields an empty
   * array (the caller decides whether that is allowed — e.g. when the
   * matching Global flag is true).
   */
  private async resolveCountryAllocations(
    allocations: CountryAllocationDto[] | undefined,
    manager: EntityManager,
    fieldLabel: string,
  ): Promise<Array<{ countryId: number; allocationPercentage: number }>> {
    if (!allocations || allocations.length === 0) return [];

    const seen = new Set<number>();
    let sum = 0;
    for (const row of allocations) {
      if (seen.has(row.countryId)) {
        throw new BadRequestException(
          `${fieldLabel}: country ${row.countryId} appears more than once`,
        );
      }
      seen.add(row.countryId);
      if (
        row.allocationPercentage === null ||
        row.allocationPercentage === undefined ||
        row.allocationPercentage <= 0
      ) {
        throw new BadRequestException(
          `${fieldLabel}: each row's allocation must be greater than 0`,
        );
      }
      sum += Number(row.allocationPercentage);
    }
    /* Allow a tiny FP tolerance so values like 33.33 + 33.33 + 33.34
     * (= 100.00 exactly) and 33.33 * 3 (= 99.99 as float) both pass
     * the "≤ 100" check without false positives. */
    if (sum - 100 > 0.001) {
      throw new BadRequestException(
        `${fieldLabel}: allocations sum to ${sum.toFixed(2)}%, must be ≤ 100`,
      );
    }

    const ids = Array.from(seen);
    const found = await manager.findBy(Country, { id: In(ids) });
    if (found.length !== ids.length) {
      throw new NotFoundException(
        `${fieldLabel}: one or more country IDs are invalid`,
      );
    }

    return allocations.map((row) => ({
      countryId: row.countryId,
      allocationPercentage: Number(row.allocationPercentage),
    }));
  }

  /**
   * Replaces a project's country-allocation rows on one of the two
   * junction tables (Location of Benefit or Country of Implementation).
   * Deletes existing rows then inserts the new set. Safe to call with
   * an empty `rows` array (clears the relation).
   */
  private async replaceCountryAllocations(
    projectId: number,
    table: typeof ProjectBenefitCountry | typeof ProjectImplementationCountry,
    rows: Array<{ countryId: number; allocationPercentage: number }>,
    manager: EntityManager,
  ): Promise<void> {
    await manager.delete(table, { projectId });
    if (rows.length === 0) return;
    const entities = rows.map((row) =>
      manager.create(table, {
        projectId,
        countryId: row.countryId,
        allocationPercentage: row.allocationPercentage,
      }),
    );
    await manager.save(table, entities);
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
      'startDate',
      'endDate',
      'totalBudget',
      'remainingBudget',
      'fundingSource',
      'funder',
      'centerId',
      'isBenefitGlobal',
      'isImplementationGlobal',
      'principalInvestigator',
      'email',
    ];

    /* Money columns are decimal(10,2) — diffed via toCanonicalDecimal()
     * because TypeORM hydrates them as strings while DTOs carry numbers. */
    const DECIMAL_FIELDS: ReadonlySet<string> = new Set([
      'totalBudget',
      'remainingBudget',
    ]);

    /* Nullable text columns where the edit form submits '' for an empty
     * input. '' collapses to null before diff + apply so null↔'' never
     * audits as a change and an untouched empty field never overwrites
     * NULL in the DB with an empty string. */
    const NULLABLE_TEXT_FIELDS: ReadonlySet<string> = new Set([
      'description',
      'summary',
      'fundingSource',
      'funder',
      'principalInvestigator',
      'email',
    ]);

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
      let normalisedIncoming =
        (field === 'startDate' || field === 'endDate') &&
        typeof incoming === 'string'
          ? new Date(incoming)
          : incoming;

      /* Collapse empty-string submissions to null on nullable text columns. */
      if (
        NULLABLE_TEXT_FIELDS.has(field) &&
        typeof normalisedIncoming === 'string' &&
        normalisedIncoming.trim() === ''
      ) {
        normalisedIncoming = null;
      }

      const current = (project as unknown as Record<string, unknown>)[field];

      /* Decimal money fields: compare + audit through the canonical
       * 2-dp string so the DB's string hydration never registers as a
       * change against the DTO's number. */
      if (DECIMAL_FIELDS.has(field)) {
        const beforeCanonical = this.toCanonicalDecimal(current);
        const afterCanonical = this.toCanonicalDecimal(normalisedIncoming);
        if (beforeCanonical === afterCanonical) continue;

        changesPayload[field] = {
          before: beforeCanonical,
          after: afterCanonical,
        };
        changedFields.push(field);
        (project as unknown as Record<string, unknown>)[field] =
          normalisedIncoming ?? null;
        continue;
      }

      if (this.valuesAreEqual(current, normalisedIncoming)) continue;

      /* Dates serialise to ISO strings; everything else flows through
       * verbatim. */
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

    /* Per-table Global wins: when a Global flag is true, the matching
     * country-allocation list is forced to empty regardless of what
     * the caller sent. Mutually exclusive at the persistence layer. */
    const isBenefitGlobal = dto.isBenefitGlobal === true;
    const isImplementationGlobal = dto.isImplementationGlobal === true;

    /* Persist project + budget lines + country allocations atomically.
     * The transaction guarantees that a partial failure inserting any
     * child row rolls back the project itself. */
    const savedId = await this.dataSource.transaction(async (manager) => {
      /* Validate + resolve country allocations up front so any rejection
       * happens before the project row hits the DB. */
      const benefitRows = isBenefitGlobal
        ? []
        : await this.resolveCountryAllocations(
            dto.benefitCountries,
            manager,
            'Location of Benefit',
          );
      const implementationRows = isImplementationGlobal
        ? []
        : await this.resolveCountryAllocations(
            dto.implementationCountries,
            manager,
            'Country of Implementation',
          );

      const project = manager.create(Project, {
        code: dto.code,
        name: dto.name,
        description: dto.description ?? null,
        summary: dto.summary ?? null,
        startDate: dto.startDate ? new Date(dto.startDate) : null,
        endDate: dto.endDate ? new Date(dto.endDate) : null,
        totalBudget: dto.totalBudget,
        remainingBudget: dto.remainingBudget ?? dto.totalBudget,
        fundingSource: dto.fundingSource ?? null,
        funder: dto.funder ?? null,
        centerId: dto.centerId,
        createdById: userId,
        isBenefitGlobal,
        isImplementationGlobal,
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

      /* Persist allocations on the two junction tables now that we
       * have the generated project ID. */
      await this.replaceCountryAllocations(
        saved.id,
        ProjectBenefitCountry,
        benefitRows,
        manager,
      );
      await this.replaceCountryAllocations(
        saved.id,
        ProjectImplementationCountry,
        implementationRows,
        manager,
      );

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
      'startDate',
      'endDate',
      'totalBudget',
      'remainingBudget',
      'fundingSource',
      'funder',
      'status',
      'centerId',
      'isBenefitGlobal',
      'isImplementationGlobal',
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
   * Builds the role-aware `negotiation_turn` derived-column SQL used by
   * `findAll` to colour the projects-list negotiation icon by whose turn it
   * is. Returns `'awaiting_me'` / `'awaiting_other'` / `NULL` per project.
   *
   * The rule mirrors the dashboard's per-mapping `!myAgreedFlag` badge
   * (dashboard.component "needs my response"). A freshly-launched round reads
   * as awaiting the PROGRAM: launching (or any center-side proposal/draft
   * edit) sets `center_agreed = 1`, so the center has implicitly agreed to
   * its own terms and the program is who must respond. The per-side rules:
   *  - **center_rep**: awaiting itself when any `negotiating` mapping still
   *    lacks the center's confirmation (`center_agreed = 0`) OR a program has
   *    requested a removal the center must resolve (`removal_requested = 1`);
   *    otherwise, if a round is live, it's the program's turn.
   *  - **program_rep**: scoped to their own program — awaiting itself when
   *    their `negotiating` mapping still lacks `program_agreed`; otherwise, if
   *    their mapping is live, it's the center's turn.
   *  - **admin / workflow_admin / no role**: no side to act on, so never
   *    `'awaiting_me'` — a live round simply reads as `'awaiting_other'`.
   *
   * `NULL` whenever the project is locked or has no live negotiation in the
   * viewer's scope. Parameter names are prefixed `turn*` to avoid clashing
   * with the other addSelect/filter params bound on the same QueryBuilder.
   */
  private buildNegotiationTurnSelect(user?: User): {
    sql: string;
    params: Record<string, unknown>;
  } {
    const params: Record<string, unknown> = {
      turnNegotiating: MappingStatus.NEGOTIATING,
      turnRemoved: MappingStatus.REMOVED,
    };

    if (user?.role === UserRole.CENTER_REP) {
      return {
        sql: `(
          CASE
            WHEN project.negotiation_locked = 1 THEN NULL
            WHEN EXISTS (
              SELECT 1 FROM project_mappings pm_turn_me
              WHERE pm_turn_me.project_id = project.id
                AND (
                  (pm_turn_me.status = :turnNegotiating AND pm_turn_me.center_agreed = 0)
                  OR (pm_turn_me.removal_requested = 1 AND pm_turn_me.status != :turnRemoved)
                )
            ) THEN 'awaiting_me'
            WHEN EXISTS (
              SELECT 1 FROM project_mappings pm_turn_any
              WHERE pm_turn_any.project_id = project.id
                AND pm_turn_any.status = :turnNegotiating
            ) THEN 'awaiting_other'
            ELSE NULL
          END
        )`,
        params,
      };
    }

    if (user?.role === UserRole.PROGRAM_REP && user.programId) {
      params.turnProgramId = user.programId;
      return {
        sql: `(
          CASE
            WHEN project.negotiation_locked = 1 THEN NULL
            WHEN EXISTS (
              SELECT 1 FROM project_mappings pm_turn_me
              WHERE pm_turn_me.project_id = project.id
                AND pm_turn_me.program_id = :turnProgramId
                AND pm_turn_me.status = :turnNegotiating
                AND pm_turn_me.program_agreed = 0
                AND pm_turn_me.removal_requested = 0
            ) THEN 'awaiting_me'
            WHEN EXISTS (
              SELECT 1 FROM project_mappings pm_turn_any
              WHERE pm_turn_any.project_id = project.id
                AND pm_turn_any.program_id = :turnProgramId
                AND pm_turn_any.status = :turnNegotiating
            ) THEN 'awaiting_other'
            ELSE NULL
          END
        )`,
        params,
      };
    }

    /* Admin / workflow_admin / no role: no side to act on — a live round
     * just reads as the counterparty's turn (active, not "yours"). */
    return {
      sql: `(
        CASE
          WHEN project.negotiation_locked = 0
            AND EXISTS (
              SELECT 1 FROM project_mappings pm_turn_any
              WHERE pm_turn_any.project_id = project.id
                AND pm_turn_any.status = :turnNegotiating
            ) THEN 'awaiting_other'
          ELSE NULL
        END
      )`,
      params,
    };
  }

  /**
   * Builds the "waiting on the current viewer to act" predicate used by the
   * `needsMyAction` filter, reusing the same turn rule as the projects-list
   * negotiation icon ({@link buildNegotiationTurnSelect}).
   *
   *  - **center rep** — the round is on the center (`negotiation_turn` reads
   *    `awaiting_me`: a `negotiating` mapping still needs center confirmation,
   *    or a program removal request must be resolved).
   *  - **program rep** — their mapping awaits their response (`awaiting_me`)
   *    OR their mapping is still missing TOC contribution data. Mirrors the
   *    dashboard "Action Needed" panel exactly.
   *
   * Returns `null` for admin / workflow_admin / no-role — they have no side to
   * act on, so the flag is a no-op (and the chip is never surfaced for them).
   */
  private needsMyActionPredicate(
    user?: User,
  ): { sql: string; params: Record<string, unknown> } | null {
    const isCenter = user?.role === UserRole.CENTER_REP;
    const isProgram =
      user?.role === UserRole.PROGRAM_REP && user.programId != null;
    if (!isCenter && !isProgram) return null;

    const turn = this.buildNegotiationTurnSelect(user);
    const params: Record<string, unknown> = { ...turn.params };
    let sql = `(${turn.sql}) = 'awaiting_me'`;

    // Program reps can also owe TOC contribution data on their own mapping —
    // fold that in so the filter matches the dashboard's Action Needed list.
    // `editableOnly`: TOC links are editable on negotiating/agreed/
    // admin_decision mappings — including locked projects — so all of those
    // count as a to-do; drafts (uneditable) and pending-removal mappings
    // don't.
    if (isProgram) {
      sql = `(${sql} OR ${missingTocContributionSql(true, true)})`;
      params.missingTocRemoved = MappingStatus.REMOVED;
      params.missingTocEditableStatuses = [
        MappingStatus.NEGOTIATING,
        MappingStatus.AGREED,
        MappingStatus.ADMIN_DECISION,
      ];
      params.missingTocAow = MappingTocLinkType.AOW;
      params.missingTocOutput = MappingTocLinkType.OUTPUT;
      params.missingTocOutcome = MappingTocLinkType.OUTCOME;
      params.missingTocProgramId = user!.programId;
    }
    return { sql, params };
  }

  /**
   * Applies the standalone `needsMyAction=true` boolean filter. No-op for
   * roles with no side to act on (admin/no-role) — see
   * {@link needsMyActionPredicate}. Shared by `findAll`, the facet scope
   * builder, and `getSummary`.
   */
  private applyNeedsMyActionFilter(
    qb: SelectQueryBuilder<Project>,
    user?: User,
  ): void {
    const predicate = this.needsMyActionPredicate(user);
    // For a role with no actionable side, matching nothing is the honest
    // result ("projects awaiting YOU" is empty when you're not a party).
    if (!predicate) {
      qb.andWhere('1 = 0');
      return;
    }
    qb.andWhere(predicate.sql, predicate.params);
  }

  /**
   * Applies the multi-select lifecycle-status filter to `qb`: a project matches
   * when its derived bucket is ANY of the selected lifecycle states (OR
   * semantics), via a single `IN` over the shared `MAPPING_STATUS_SQL`
   * expression. This is the multi-value counterpart to the legacy single-value
   * `mappingStatus` filter and is the source of truth for the projects-list
   * lifecycle dropdown.
   *
   * The array may also carry `MappingFlagFilter` attribute-flag values
   * (`negotiating`, `ready_to_lock`, `partially_allocated`, `missing_toc`,
   * `needs_assistance`). A flag supplied here ORs with the selected lifecycle
   * buckets and with the other supplied flags — this is the OR variant of each
   * predicate. The standalone boolean query params (`readyToLock`,
   * `partiallyAllocated`, ...) remain the AND variants that stack on top, so a
   * caller can still express "(locked OR ready_to_lock) AND missing_toc".
   *
   * Self-contained: it binds every param it references, so it is safe to call
   * from `findAll`, the filter-options facet builder, `getSummary`, and the
   * export/suggestion builder without relying on any pre-bound parameters.
   * Flag param names intentionally match the standalone AND blocks (same
   * constant values) so both can coexist in one query. No-op when the array is
   * empty/undefined, so the legacy scalar `mappingStatus` filter keeps working
   * unchanged.
   */
  private applyMappingStatusesFilter(
    qb: SelectQueryBuilder<Project>,
    statuses: (MappingStatusFilter | MappingFlagFilter)[] | undefined,
    programScopeId?: number,
    user?: User,
  ): void {
    if (!statuses?.length) return;

    const bucketValues = Object.values(MappingStatusFilter) as string[];
    const buckets = [
      ...new Set(statuses.filter((s) => bucketValues.includes(s))),
    ];
    const flags = new Set(
      statuses.filter((s) =>
        (Object.values(MappingFlagFilter) as string[]).includes(s),
      ) as MappingFlagFilter[],
    );

    const predicates: string[] = [];
    const params: Record<string, unknown> = {};

    if (buckets.length) {
      predicates.push(`${MAPPING_STATUS_SQL} IN (:...mappingStatusBuckets)`);
      Object.assign(params, {
        mappingStatusBuckets: buckets,
        mappingStatusLocked: MappingStatusFilter.LOCKED,
        mappingStatusInNegotiation: MappingStatusFilter.IN_NEGOTIATION,
        mappingStatusDraftFilter: MappingStatusFilter.DRAFT,
        mappingStatusNone: MappingStatusFilter.NONE,
        mappingStatusAdminDecisionFilter: MappingStatusFilter.ADMIN_DECISION,
        mappingStatusNegotiating: MappingStatus.NEGOTIATING,
        mappingStatusAgreed: MappingStatus.AGREED,
        mappingStatusDraft: MappingStatus.DRAFT,
        mappingStatusAdminDecision: MappingStatus.ADMIN_DECISION,
      });
    }
    if (flags.has(MappingFlagFilter.NEGOTIATING)) {
      predicates.push(NEGOTIATING_ACTIVE_SQL);
      params.negotiatingFilterStatus = MappingStatus.NEGOTIATING;
    }
    if (flags.has(MappingFlagFilter.READY_TO_LOCK)) {
      predicates.push(READY_TO_LOCK_SQL);
      params.readyToLockRemoved = MappingStatus.REMOVED;
      params.readyToLockAgreed = MappingStatus.AGREED;
    }
    if (flags.has(MappingFlagFilter.PARTIALLY_ALLOCATED)) {
      predicates.push(PARTIALLY_ALLOCATED_SQL);
      params.partiallyAllocatedRemoved = MappingStatus.REMOVED;
    }
    if (flags.has(MappingFlagFilter.MISSING_TOC)) {
      const programScoped = programScopeId != null;
      predicates.push(missingTocContributionSql(programScoped));
      params.missingTocRemoved = MappingStatus.REMOVED;
      params.missingTocAow = MappingTocLinkType.AOW;
      params.missingTocOutput = MappingTocLinkType.OUTPUT;
      params.missingTocOutcome = MappingTocLinkType.OUTCOME;
      if (programScoped) params.missingTocProgramId = programScopeId;
    }
    if (flags.has(MappingFlagFilter.NEEDS_ASSISTANCE)) {
      predicates.push(NEEDS_ASSISTANCE_SQL);
    }
    if (flags.has(MappingFlagFilter.AGREED)) {
      const programScoped = programScopeId != null;
      predicates.push(agreedMappingSql(programScoped));
      params.agreedMappingStatus = MappingStatus.AGREED;
      if (programScoped) params.agreedMappingProgramId = programScopeId;
    }
    if (flags.has(MappingFlagFilter.REMOVAL_REQUESTED)) {
      const programScoped = programScopeId != null;
      predicates.push(removalRequestedSql(programScoped));
      params.removalRequestedRemoved = MappingStatus.REMOVED;
      if (programScoped) params.removalRequestedProgramId = programScopeId;
    }
    if (flags.has(MappingFlagFilter.NEEDS_MY_ACTION)) {
      const predicate = this.needsMyActionPredicate(user);
      // Admin/no-role have no actionable side — the flag matches nothing
      // rather than silently widening the OR to everything.
      predicates.push(predicate ? predicate.sql : '1 = 0');
      if (predicate) Object.assign(params, predicate.params);
    }

    if (!predicates.length) return;
    qb.andWhere(`(${predicates.join(' OR ')})`, params);
  }

  /**
   * Program id the missing-TOC filter must scope to, or `undefined` for
   * project-wide matching. A program rep can only fill TOC data on their own
   * mapping, so their "Missing TOC" filter/facet must consider only their
   * program's mapping — not a co-mapped program's incomplete one. Admin and
   * center reps keep the project-wide "any active mapping" semantics.
   */
  private missingTocProgramScope(user?: User): number | undefined {
    return user?.role === UserRole.PROGRAM_REP
      ? (user.programId ?? undefined)
      : undefined;
  }

  /**
   * Applies the standalone `missingTocContribution=true` boolean filter,
   * program-scoped for program reps (see {@link missingTocProgramScope}).
   * Shared by `findAll`, the facet scope builder, and `getSummary` so all
   * three agree on which projects "Missing TOC" matches.
   */
  private applyMissingTocContributionFilter(
    qb: SelectQueryBuilder<Project>,
    user?: User,
  ): void {
    const programScopeId = this.missingTocProgramScope(user);
    qb.andWhere(missingTocContributionSql(programScopeId != null), {
      missingTocRemoved: MappingStatus.REMOVED,
      missingTocAow: MappingTocLinkType.AOW,
      missingTocOutput: MappingTocLinkType.OUTPUT,
      missingTocOutcome: MappingTocLinkType.OUTCOME,
      ...(programScopeId != null
        ? { missingTocProgramId: programScopeId }
        : {}),
    });
  }

  /**
   * Applies the standalone `agreedMapping=true` boolean filter, program-scoped
   * for program reps (see {@link missingTocProgramScope} — same program scope).
   * Shared by `findAll`, the facet scope builder, and `getSummary`.
   */
  private applyAgreedMappingFilter(
    qb: SelectQueryBuilder<Project>,
    user?: User,
  ): void {
    const programScopeId = this.missingTocProgramScope(user);
    qb.andWhere(agreedMappingSql(programScopeId != null), {
      agreedMappingStatus: MappingStatus.AGREED,
      ...(programScopeId != null
        ? { agreedMappingProgramId: programScopeId }
        : {}),
    });
  }

  /**
   * Applies the standalone `removalRequested=true` boolean filter,
   * program-scoped for program reps (see {@link missingTocProgramScope} —
   * same program scope). Shared by `findAll`, the facet scope builder, and
   * `getSummary`.
   */
  private applyRemovalRequestedFilter(
    qb: SelectQueryBuilder<Project>,
    user?: User,
  ): void {
    const programScopeId = this.missingTocProgramScope(user);
    qb.andWhere(removalRequestedSql(programScopeId != null), {
      removalRequestedRemoved: MappingStatus.REMOVED,
      ...(programScopeId != null
        ? { removalRequestedProgramId: programScopeId }
        : {}),
    });
  }

  /**
   * Adds the two aggregate subquery joins shared by `findAll` and
   * `findAllIds`:
   *   - `alloc`: SUM(agreed allocation %) per project (status=agreed only).
   *   - `pby`:   SUM(project_budgets.amount) for the given fiscal year.
   * plus the `agreed_percent` / `budget_year` select aliases that the sort
   * whitelist (`SORT_FIELD_TO_SQL`) targets for the `budget2026` /
   * `agreedAllocatedPercent` sort fields. Factored out so the paginated list
   * and the id-only navigation query order rows on identical expressions and
   * can never drift.
   */
  private addSortAggregateJoins(
    qb: SelectQueryBuilder<Project>,
    budgetYear: string,
  ): void {
    qb.leftJoin(
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
  }

  /**
   * Applies the projects-list ORDER BY to `qb`. Shared by `findAll` and
   * `findAllIds` so the paged list and the id-only navigation list order rows
   * identically (row n of one lines up with `ids[n]` of the other).
   *
   * Sort whitelist — class-validator's `@IsIn` already rejects unknown
   * `sortField` values with 400; `SORT_FIELD_TO_SQL` is the only path from a
   * validated field name to a SQL column, so untrusted strings can never reach
   * `orderBy()`. When `suggestedOnly` is active and no explicit sort was
   * requested, the greedy contribution-DESC ranking is preserved via
   * `FIELD(project.id, ...ids)`. Otherwise the default is newest-first.
   */
  private applyListSort(
    qb: SelectQueryBuilder<Project>,
    query: ProjectQueryDto,
    suggestedProjectIds: number[] | null,
  ): void {
    if (query.sortField) {
      const sqlColumn = SORT_FIELD_TO_SQL[query.sortField];
      qb.orderBy(sqlColumn, query.sortOrder ?? 'ASC');
    } else if (suggestedProjectIds && suggestedProjectIds.length > 0) {
      qb.orderBy(`FIELD(project.id, ${suggestedProjectIds.join(',')})`, 'ASC');
    } else {
      qb.orderBy('project.created_at', 'DESC');
    }
  }

  /**
   * Resolves the server-side suggestion gate shared by `findAll` and
   * `findAllIds`. Returns `null` when `suggestedOnly` is not requested (no
   * narrowing), otherwise the ordered project-id list the greedy walk picked
   * (which may be empty — callers short-circuit on that, since an `IN ()`
   * narrowing would be invalid SQL). Carries over every filter the list query
   * understands so the candidate pool matches what the user is browsing.
   */
  private async resolveSuggestedProjectIds(
    query: ProjectQueryDto,
    user?: User,
  ): Promise<number[] | null> {
    if (query.suggestedOnly !== true) return null;

    const budgetYear = query.budgetYear ?? DEFAULT_BUDGET_YEAR;
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

    this.logger.log(
      `Suggestion gate: picked ${suggestion.projectIds.length} project(s) ` +
        `for target ${suggestion.target}% / budgetYear ${suggBudgetYear}.`,
    );

    return suggestion.projectIds;
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
    const budgetYear = query.budgetYear ?? DEFAULT_BUDGET_YEAR;

    /* Server-side suggestion gate (shared with findAllIds). When
     * `suggestedOnly=true`, the greedy walk's ordered project ids become the
     * only extra WHERE constraint below — pagination and sorting keep working
     * unchanged. Empty suggestion → short-circuit with an empty page (an
     * `IN ()` narrowing would be syntactically invalid). */
    const suggestedProjectIds = await this.resolveSuggestedProjectIds(
      query,
      user,
    );
    if (suggestedProjectIds !== null && suggestedProjectIds.length === 0) {
      return {
        data: [],
        total: 0,
        page: query.page,
        limit: query.limit,
      };
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
        mappingStatusAdminDecisionFilter: MappingStatusFilter.ADMIN_DECISION,
        mappingStatusNegotiating: MappingStatus.NEGOTIATING,
        mappingStatusAgreed: MappingStatus.AGREED,
        mappingStatusDraft: MappingStatus.DRAFT,
        mappingStatusAdminDecision: MappingStatus.ADMIN_DECISION,
      })
      /* The agreed-% (`alloc`) and FY-budget (`pby`) aggregate joins plus
       * their `agreed_percent` / `budget_year` sort aliases are added after
       * this chain via addSortAggregateJoins() — shared verbatim with
       * findAllIds so both order rows on identical expressions. */
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

    /* Role-aware "whose turn is it" for the projects-list negotiation icon.
     * Built outside the fluent chain because the SQL + params depend on the
     * viewer's role (center side vs their own program vs observer). */
    const negotiationTurn = this.buildNegotiationTurnSelect(user);
    qb.addSelect(negotiationTurn.sql, 'negotiation_turn').setParameters(
      negotiationTurn.params,
    );

    /* Shared alloc-% + FY-budget subquery joins (also used by findAllIds) so
     * the sort aliases `agreed_percent` / `budget_year` resolve identically. */
    this.addSortAggregateJoins(qb, budgetYear);

    /* Center reps only see projects belonging to their center.
     *
     * NOTE: user.centerId reflects the active center — possibly overlaid
     * by ActiveCenterInterceptor from the X-Active-Center header. For a
     * multi-center rep, the list is scoped to whichever center is
     * currently active; the exclusion sub-queries below also key off the
     * same active center, so excluded rows in that center are hidden. */
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

    if (query.funder) {
      qb.andWhere('project.funder = :funder', { funder: query.funder });
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

    /* Restrict to projects with at least one flagged mapping. */
    if (query.needsAssistance === true) {
      qb.andWhere(NEEDS_ASSISTANCE_SQL);
    }

    /* Restrict to projects with an active negotiation. Must match the derived
     * `MAPPING_STATUS_SQL` definition of `in_negotiation`: project unlocked AND
     * at least one mapping in negotiating / agreed. Removed mappings are
     * deliberately EXCLUDED — a project whose only active rows are removed
     * classifies as "Unmapped" (or "Draft" if it also has a draft), so counting
     * `removed` here would pull those projects into the chip result while the
     * list/detail label them otherwise. Keep this in lockstep with
     * `MAPPING_STATUS_SQL`. */
    if (query.inNegotiation === true) {
      qb.andWhere('project.negotiation_locked = 0').andWhere(
        `EXISTS (
          SELECT 1
          FROM project_mappings pm_neg_filter
          WHERE pm_neg_filter.project_id = project.id
            AND pm_neg_filter.status IN (
              :inNegFilterNegotiating,
              :inNegFilterAgreed
            )
        )`,
        {
          inNegFilterNegotiating: MappingStatus.NEGOTIATING,
          inNegFilterAgreed: MappingStatus.AGREED,
        },
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

    /* Restrict to actively-negotiating projects — unlocked AND at least one
     * mapping in `negotiating` status. This is the STRICT definition that
     * matches the dashboard "Negotiating" tile (which counts only
     * status='negotiating'), as opposed to the looser `inNegotiation` chip
     * (which also counts agreed/removed). Powers the dashboard card
     * click-through so the list row count equals the tile number. */
    if (query.negotiating === true) {
      qb.andWhere('project.negotiation_locked = 0').andWhere(
        `EXISTS (
          SELECT 1
          FROM project_mappings pm_negotiating_filter
          WHERE pm_negotiating_filter.project_id = project.id
            AND pm_negotiating_filter.status = :negotiatingFilterStatus
        )`,
        { negotiatingFilterStatus: MappingStatus.NEGOTIATING },
      );
    }

    /* Restrict to "ready to lock" projects — unlocked, has mappings, every
     * non-removed mapping agreed. Sub-state of in_negotiation, so it is a
     * standalone predicate (see READY_TO_LOCK_SQL) rather than a CASE
     * bucket. Powers the dashboard "Ready to lock" card click-through. */
    if (query.readyToLock === true) {
      qb.andWhere(READY_TO_LOCK_SQL, {
        readyToLockRemoved: MappingStatus.REMOVED,
        readyToLockAgreed: MappingStatus.AGREED,
      });
    }

    /* Restrict to "partially allocated" projects — has at least one
     * non-removed mapping but the allocation total is under 100%.
     * Standalone predicate (see PARTIALLY_ALLOCATED_SQL) because it is an
     * allocation-total axis orthogonal to the mapping-status buckets;
     * excludes fully-unmapped projects. */
    if (query.partiallyAllocated === true) {
      qb.andWhere(PARTIALLY_ALLOCATED_SQL, {
        partiallyAllocatedRemoved: MappingStatus.REMOVED,
      });
    }

    /* Restrict to projects with at least one active mapping whose TOC
     * contribution is not yet filled. Mirrors the program-side agree gate
     * (see missingTocContributionSql). Standalone predicate, orthogonal
     * to the mapping-status buckets. Program-scoped for program reps. */
    if (query.missingTocContribution === true) {
      this.applyMissingTocContributionFilter(qb, user);
    }

    /* Restrict to projects with an agreed mapping. Program-scoped for
     * program reps (their own program's mapping only). Standalone AND
     * predicate, orthogonal to the mapping-status buckets. */
    if (query.agreedMapping === true) {
      this.applyAgreedMappingFilter(qb, user);
    }

    /* Restrict to projects with a pending program-rep removal request.
     * Program-scoped for program reps. Standalone AND predicate. */
    if (query.removalRequested === true) {
      this.applyRemovalRequestedFilter(qb, user);
    }

    /* Restrict to projects waiting on the current viewer to act (center /
     * program rep). No-op-to-empty for roles with no actionable side. */
    if (query.needsMyAction === true) {
      this.applyNeedsMyActionFilter(qb, user);
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

    /* Multi-select mapping-status filter (OR across the selected buckets).
     * Supersedes the scalar/boolean filters above for the dropdown; the
     * scalar ones stay for backward-compatible dashboard deep-links. */
    this.applyMappingStatusesFilter(
      qb,
      query.mappingStatuses,
      this.missingTocProgramScope(user),
      user,
    );

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

    /* Sort — shared with findAllIds via applyListSort so the paged list and
     * the id-only navigation list order rows identically. */
    this.applyListSort(qb, query, suggestedProjectIds);

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
            negotiation_turn?: string | null;
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

      /* Normalise the raw CASE output to one of the valid bucket strings.
       * The SQL always returns one of them, but typing the raw column as
       * `string | null` keeps the cast honest if the row was somehow null.
       * Validate against the enum's own values (not a hand-listed subset)
       * so newly-added buckets like `admin_decision` can't silently fall
       * through to NONE and render as "Unmapped" in the list column. */
      const rawMappingStatus = rawRow?.mapping_status;
      const mappingStatus: MappingStatusFilter = (
        Object.values(MappingStatusFilter) as string[]
      ).includes(rawMappingStatus ?? '')
        ? (rawMappingStatus as MappingStatusFilter)
        : MappingStatusFilter.NONE;

      const rawTurn = rawRow?.negotiation_turn;
      const negotiationTurn: 'awaiting_me' | 'awaiting_other' | null =
        rawTurn === 'awaiting_me' || rawTurn === 'awaiting_other'
          ? rawTurn
          : null;

      return Object.assign(entity, {
        needsAssistanceMappingCount: toNumber(
          rawRow?.needs_assistance_mapping_count,
        ),
        agreedAllocatedPercent: toNumber(rawRow?.agreed_percent),
        budget2026: toNumber(rawRow?.budget_year),
        inActiveNegotiation: toNumber(rawRow?.in_active_negotiation) === 1,
        negotiationTurn,
        mappingStatus,
        mappedPrograms: parsePrograms(rawRow?.mapped_programs),
        exclusion,
      });
    });

    return { data, total, page: query.page, limit: query.limit };
  }

  /**
   * Returns the ordered list of project ids matching a filter, ignoring
   * pagination. Powers the frontend's "next/previous project" navigation on
   * the negotiation page: it needs every matching id in the SAME order the
   * paged list renders them, so `ids[n]` lines up with row n of `findAll`
   * across the WHOLE filtered set (not just one page).
   *
   * Reuses the exact same role-scoping + filter predicates as `findAll` via
   * `applyFacetScopeAndFilters` (no facet excluded → every filter applied),
   * the same suggestion gate (`resolveSuggestedProjectIds`), the same
   * sort-aggregate joins (`addSortAggregateJoins`), and the same ORDER BY
   * (`applyListSort`). Only the id column is materialised (plus the two
   * aggregate aliases the sort whitelist may target), and no display-only
   * subselects/joins are added, so this stays a single lightweight query.
   *
   * @param query - Same search/filter/sort params as `GET /projects`
   *                (pagination fields are ignored).
   * @returns Ordered project ids across the whole filtered set.
   */
  async findAllIds(query: ProjectQueryDto, user?: User): Promise<number[]> {
    const budgetYear = query.budgetYear ?? DEFAULT_BUDGET_YEAR;

    /* Same suggestion gate as findAll; empty suggestion → no matches. */
    const suggestedProjectIds = await this.resolveSuggestedProjectIds(
      query,
      user,
    );
    if (suggestedProjectIds !== null && suggestedProjectIds.length === 0) {
      return [];
    }

    const qb = this.projectRepository.createQueryBuilder('project');

    /* Sort-aggregate joins first so orderBy on the `agreed_percent` /
     * `budget_year` aliases resolves (parity with findAll). */
    this.addSortAggregateJoins(qb, budgetYear);

    /* Same role-scoping + every filter predicate as findAll. Passing no
     * `exclude` facet applies the full filter set (each filter binds its own
     * params, so nothing else needs pre-binding here). */
    this.applyFacetScopeAndFilters(qb, query, user);

    /* Suggestion narrowing — intersect with the greedy id set (findAll does
     * the same as its final WHERE constraint). */
    if (suggestedProjectIds && suggestedProjectIds.length > 0) {
      qb.andWhere('project.id IN (:...suggestedIds)', {
        suggestedIds: suggestedProjectIds,
      });
    }

    /* Identical ORDER BY to the paged list. */
    this.applyListSort(qb, query, suggestedProjectIds);

    /* Materialise only the id (plus the two aggregate aliases the sort may
     * target — re-added because .select() resets the select list). */
    const rows = await qb
      .select('project.id', 'id')
      .addSelect('COALESCE(alloc.agreedPercent, 0)', 'agreed_percent')
      .addSelect('COALESCE(pby.amount, 0)', 'budget_year')
      .getRawMany<{ id: number | string }>();

    return rows.map((row) => Number(row.id));
  }

  /**
   * Returns the distinct, non-empty `funder` values across all projects,
   * sorted alphabetically. Powers the funder filter dropdown on the
   * projects list. Not center-scoped — the dropdown should offer every
   * funder so any role can filter by it.
   */
  async getDistinctFunders(): Promise<string[]> {
    const rows = await this.projectRepository
      .createQueryBuilder('project')
      .select('DISTINCT project.funder', 'funder')
      .where('project.funder IS NOT NULL')
      .andWhere("project.funder <> ''")
      .orderBy('project.funder', 'ASC')
      .getRawMany<{ funder: string }>();
    return rows.map((r) => r.funder);
  }

  /**
   * Returns the values that should populate each context-aware projects-list
   * filter dropdown, given the caller's other active filters. For each facet
   * (funding source, center, programs, funder, mapping status) it runs a
   * distinct/aggregate query that applies every active filter EXCEPT that
   * facet's own selection — so a dropdown only offers values that would
   * actually return at least one project, while staying self-selectable.
   *
   * Mirrors `findAll`'s visibility scoping and filter predicates (via the
   * shared `applyFacetScopeAndFilters` helper) so the options can never offer
   * a value the list would then show as empty.
   */
  async getFilterOptions(
    query: ProjectQueryDto,
    user?: User,
  ): Promise<ProjectFilterOptions> {
    /* Fresh base QueryBuilder with the scope + all filters EXCEPT `exclude`. */
    const baseFor = (exclude: ProjectFacetKey): SelectQueryBuilder<Project> => {
      const qb = this.projectRepository.createQueryBuilder('project');
      this.applyFacetScopeAndFilters(qb, query, user, exclude);
      return qb;
    };

    /* Funding sources present under every OTHER active filter. Raw selects
     * use the snake_case column name (per the findAll raw-select convention);
     * andWhere keeps the camelCase property name that TypeORM maps. */
    const fundingPromise = baseFor('fundingSource')
      .select('DISTINCT project.funding_source', 'value')
      .andWhere('project.fundingSource IS NOT NULL')
      .getRawMany<{ value: string }>();

    /* Owning centers present. */
    const centerPromise = baseFor('center')
      .select('DISTINCT project.center_id', 'value')
      .andWhere('project.centerId IS NOT NULL')
      .getRawMany<{ value: number }>();

    /* Programs with ≥1 non-removed mapping on a matching project. The
     * INNER JOIN multiplies rows per mapping, but DISTINCT collapses them. */
    const programsPromise = baseFor('programs')
      .innerJoin(
        ProjectMapping,
        'pm_facet',
        'pm_facet.project_id = project.id AND pm_facet.status != :facetProgRemoved',
        { facetProgRemoved: MappingStatus.REMOVED },
      )
      .select('DISTINCT pm_facet.program_id', 'value')
      .getRawMany<{ value: number }>();

    /* Funder names present, alphabetically sorted. */
    const fundersPromise = baseFor('funder')
      .select('DISTINCT project.funder', 'value')
      .andWhere('project.funder IS NOT NULL')
      .andWhere("project.funder <> ''")
      .orderBy('project.funder', 'ASC')
      .getRawMany<{ value: string }>();

    /* Mapping-status buckets that match ≥1 project (single aggregate row). */
    const mappingStatusPromise = this.computeAvailableMappingStatuses(
      query,
      user,
    );

    const [funding, centers, programs, funders, mappingStatuses] =
      await Promise.all([
        fundingPromise,
        centerPromise,
        programsPromise,
        fundersPromise,
        mappingStatusPromise,
      ]);

    return {
      fundingSources: funding.map((r) => r.value as FundingSource),
      centerIds: centers.map((r) => Number(r.value)),
      programIds: programs.map((r) => Number(r.value)),
      funders: funders.map((r) => r.value),
      mappingStatuses,
    };
  }

  /**
   * Computes which mapping-status dropdown values match ≥1 project under the
   * caller's other active filters (the mapping-status dropdown's own
   * selection is excluded). One aggregate row with a presence flag per
   * bucket: the five mutually-exclusive `MAPPING_STATUS_SQL` buckets plus the
   * four orthogonal sub-state predicates (negotiating / ready-to-lock /
   * partially-allocated / missing-TOC), reusing the exact same SQL the list
   * filter uses so options and rows can never disagree.
   */
  private async computeAvailableMappingStatuses(
    query: ProjectQueryDto,
    user?: User,
  ): Promise<string[]> {
    const qb = this.projectRepository.createQueryBuilder('project');
    this.applyFacetScopeAndFilters(qb, query, user, 'mappingStatus');

    // Role-aware "needs my action" predicate — null for admin/no-role, in
    // which case the facet count is a constant 0 (chip never surfaced).
    const needsMyActionFacet = this.needsMyActionPredicate(user);

    qb.select(
      `MAX(CASE WHEN ${MAPPING_STATUS_SQL} = :mappingStatusLocked THEN 1 ELSE 0 END)`,
      'has_locked',
    )
      .addSelect(
        `MAX(CASE WHEN ${MAPPING_STATUS_SQL} = :mappingStatusInNegotiation THEN 1 ELSE 0 END)`,
        'has_in_negotiation',
      )
      .addSelect(
        `MAX(CASE WHEN ${MAPPING_STATUS_SQL} = :mappingStatusDraftFilter THEN 1 ELSE 0 END)`,
        'has_draft',
      )
      .addSelect(
        `MAX(CASE WHEN ${MAPPING_STATUS_SQL} = :mappingStatusNone THEN 1 ELSE 0 END)`,
        'has_none',
      )
      .addSelect(
        `MAX(CASE WHEN ${MAPPING_STATUS_SQL} = :mappingStatusAdminDecisionFilter THEN 1 ELSE 0 END)`,
        'has_admin_decision',
      )
      .addSelect(
        `MAX(CASE WHEN ${READY_TO_LOCK_SQL} THEN 1 ELSE 0 END)`,
        'has_ready_to_lock',
      )
      .addSelect(
        `MAX(CASE WHEN ${PARTIALLY_ALLOCATED_SQL} THEN 1 ELSE 0 END)`,
        'has_partially_allocated',
      )
      .addSelect(
        // Program-scoped for program reps so the facet count matches what
        // the "Missing TOC" filter actually returns for them.
        `MAX(CASE WHEN ${missingTocContributionSql(this.missingTocProgramScope(user) != null)} THEN 1 ELSE 0 END)`,
        'has_missing_toc',
      )
      .addSelect(
        `MAX(CASE WHEN ${NEEDS_ASSISTANCE_SQL} THEN 1 ELSE 0 END)`,
        'has_needs_assistance',
      )
      .addSelect(
        `MAX(CASE WHEN project.negotiation_locked = 0 AND EXISTS (
          SELECT 1 FROM project_mappings pm_neg_strict
          WHERE pm_neg_strict.project_id = project.id
            AND pm_neg_strict.status = :facetNegotiatingStrict
        ) THEN 1 ELSE 0 END)`,
        'has_negotiating',
      )
      .addSelect(
        // Program-scoped for program reps so the facet count matches the
        // "Agreed" filter's result set for them.
        `MAX(CASE WHEN ${agreedMappingSql(this.missingTocProgramScope(user) != null)} THEN 1 ELSE 0 END)`,
        'has_agreed',
      )
      .addSelect(
        // Program-scoped for program reps so the facet count matches the
        // "Removal requested" filter's result set for them.
        `MAX(CASE WHEN ${removalRequestedSql(this.missingTocProgramScope(user) != null)} THEN 1 ELSE 0 END)`,
        'has_removal_requested',
      )
      .addSelect(
        // Role-aware; constant 0 for admin/no-role so the chip stays hidden.
        needsMyActionFacet
          ? `MAX(CASE WHEN ${needsMyActionFacet.sql} THEN 1 ELSE 0 END)`
          : `0`,
        'has_needs_my_action',
      )
      .setParameters({
        /* MAPPING_STATUS_SQL CASE branches — the filter-enum params double as
         * the comparison targets above (e.g. :mappingStatusLocked = 'locked'). */
        mappingStatusAdminDecision: MappingStatus.ADMIN_DECISION,
        mappingStatusAdminDecisionFilter: MappingStatusFilter.ADMIN_DECISION,
        mappingStatusLocked: MappingStatusFilter.LOCKED,
        mappingStatusNegotiating: MappingStatus.NEGOTIATING,
        mappingStatusAgreed: MappingStatus.AGREED,
        mappingStatusRemoved: MappingStatus.REMOVED,
        mappingStatusInNegotiation: MappingStatusFilter.IN_NEGOTIATION,
        mappingStatusDraft: MappingStatus.DRAFT,
        mappingStatusDraftFilter: MappingStatusFilter.DRAFT,
        mappingStatusNone: MappingStatusFilter.NONE,
        /* READY_TO_LOCK_SQL */
        readyToLockRemoved: MappingStatus.REMOVED,
        readyToLockAgreed: MappingStatus.AGREED,
        /* PARTIALLY_ALLOCATED_SQL */
        partiallyAllocatedRemoved: MappingStatus.REMOVED,
        /* missingTocContributionSql */
        missingTocRemoved: MappingStatus.REMOVED,
        missingTocAow: MappingTocLinkType.AOW,
        missingTocOutput: MappingTocLinkType.OUTPUT,
        missingTocOutcome: MappingTocLinkType.OUTCOME,
        /* Program scope for the program-rep facet count (see addSelect
         * above). Bound unconditionally — harmless when the SQL omits the
         * placeholder for admin/center reps. */
        missingTocProgramId: this.missingTocProgramScope(user) ?? null,
        /* agreedMappingSql — status + optional program scope (bound
         * unconditionally; harmless when the SQL omits the placeholder). */
        agreedMappingStatus: MappingStatus.AGREED,
        agreedMappingProgramId: this.missingTocProgramScope(user) ?? null,
        /* removalRequestedSql — non-removed guard + optional program scope
         * (bound unconditionally; harmless when the SQL omits it). */
        removalRequestedRemoved: MappingStatus.REMOVED,
        removalRequestedProgramId: this.missingTocProgramScope(user) ?? null,
        /* strict negotiating predicate */
        facetNegotiatingStrict: MappingStatus.NEGOTIATING,
        /* needsMyAction predicate params (turn* / missingToc*) — empty for
         * admin/no-role where the count is a constant 0. */
        ...(needsMyActionFacet?.params ?? {}),
      });

    const row = await qb.getRawOne<Record<string, number | string | null>>();
    if (!row) return [];

    const on = (v: number | string | null | undefined): boolean =>
      Number(v) === 1;
    /* Pushed in the same order as the dropdown so the frontend filter is a
     * straight membership test. */
    const present: string[] = [];
    if (on(row.has_in_negotiation)) present.push('in_negotiation');
    if (on(row.has_negotiating)) present.push('negotiating');
    if (on(row.has_ready_to_lock)) present.push('ready_to_lock');
    if (on(row.has_partially_allocated)) present.push('partially_allocated');
    if (on(row.has_missing_toc)) present.push('missing_toc');
    if (on(row.has_needs_assistance)) present.push('needs_assistance');
    if (on(row.has_agreed)) present.push('agreed');
    if (on(row.has_removal_requested)) present.push('removal_requested');
    if (on(row.has_needs_my_action)) present.push('needs_my_action');
    if (on(row.has_draft)) present.push('draft');
    if (on(row.has_locked)) present.push('locked');
    if (on(row.has_admin_decision)) present.push('admin_decision');
    if (on(row.has_none)) present.push('none');
    return present;
  }

  /**
   * Applies the projects-list visibility scoping and filter predicates to an
   * already-created `project` QueryBuilder, skipping the one facet named by
   * `exclude` so that facet's dropdown stays self-selectable. Mirrors the
   * predicates in `findAll` (kept in lockstep the same way `getSummary` /
   * `getSuggestedToReachTarget` mirror them); the server-side suggestion
   * narrowing is intentionally NOT replicated here — it is a list-only knob.
   */
  private applyFacetScopeAndFilters(
    qb: SelectQueryBuilder<Project>,
    query: ProjectQueryDto,
    user: User | undefined,
    exclude?: ProjectFacetKey,
  ): void {
    /* ---- Role-based visibility scoping — ALWAYS applied ---- */
    if (user?.role === UserRole.CENTER_REP && user.centerId) {
      qb.andWhere('project.centerId = :userCenterId', {
        userCenterId: user.centerId,
      });
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

    if (user?.role === UserRole.ADMIN && query.showExcluded) {
      qb.andWhere(
        `EXISTS (
          SELECT 1 FROM project_exclusions pe_excl_admin
          WHERE pe_excl_admin.project_id = project.id
        )`,
      );
    }

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

    /* ---- Free-text search — always ---- */
    if (query.search) {
      qb.andWhere(
        '(project.code LIKE :search OR project.name LIKE :search OR project.description LIKE :search)',
        { search: `%${query.search}%` },
      );
    }

    /* ---- Center dropdown — skipped when computing the center facet ---- */
    if (query.centerId && exclude !== 'center') {
      qb.andWhere('project.centerId = :centerId', { centerId: query.centerId });
    }

    /* ---- Project status — always ---- */
    if (query.status) {
      qb.andWhere('project.status = :status', { status: query.status });
    }

    /* ---- Funding source — skipped for its own facet ---- */
    if (query.fundingSource && exclude !== 'fundingSource') {
      qb.andWhere('project.fundingSource = :fundingSource', {
        fundingSource: query.fundingSource,
      });
    }

    /* ---- Funder — skipped for its own facet ---- */
    if (query.funder && exclude !== 'funder') {
      qb.andWhere('project.funder = :funder', { funder: query.funder });
    }

    /* ---- Programs — skipped for its own facet ---- */
    if (query.programIds?.length && exclude !== 'programs') {
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

    /* ---- Negotiation-state chips (inNegotiation / mapped) — always; these
     * are a SEPARATE control from the mapping-status dropdown, so they
     * constrain every facet including the mapping-status facet. ---- */
    if (query.inNegotiation === true) {
      qb.andWhere('project.negotiation_locked = 0').andWhere(
        `EXISTS (
          SELECT 1
          FROM project_mappings pm_neg_filter
          WHERE pm_neg_filter.project_id = project.id
            AND pm_neg_filter.status IN (
              :inNegFilterNegotiating,
              :inNegFilterAgreed
            )
        )`,
        {
          inNegFilterNegotiating: MappingStatus.NEGOTIATING,
          inNegFilterAgreed: MappingStatus.AGREED,
        },
      );
    }

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

    /* ---- Mapping-status dropdown group — the single dropdown drives ALL of
     * these params, so the whole group is skipped when computing its own
     * facet options. ---- */
    if (exclude !== 'mappingStatus') {
      if (query.negotiating === true) {
        qb.andWhere('project.negotiation_locked = 0').andWhere(
          `EXISTS (
            SELECT 1
            FROM project_mappings pm_negotiating_filter
            WHERE pm_negotiating_filter.project_id = project.id
              AND pm_negotiating_filter.status = :negotiatingFilterStatus
          )`,
          { negotiatingFilterStatus: MappingStatus.NEGOTIATING },
        );
      }

      if (query.readyToLock === true) {
        qb.andWhere(READY_TO_LOCK_SQL, {
          readyToLockRemoved: MappingStatus.REMOVED,
          readyToLockAgreed: MappingStatus.AGREED,
        });
      }

      if (query.partiallyAllocated === true) {
        qb.andWhere(PARTIALLY_ALLOCATED_SQL, {
          partiallyAllocatedRemoved: MappingStatus.REMOVED,
        });
      }

      if (query.missingTocContribution === true) {
        this.applyMissingTocContributionFilter(qb, user);
      }

      if (query.agreedMapping === true) {
        this.applyAgreedMappingFilter(qb, user);
      }

      if (query.removalRequested === true) {
        this.applyRemovalRequestedFilter(qb, user);
      }

      if (query.needsMyAction === true) {
        this.applyNeedsMyActionFilter(qb, user);
      }

      if (query.needsAssistance === true) {
        qb.andWhere(NEEDS_ASSISTANCE_SQL);
      }

      if (query.mappingStatus) {
        /* All CASE-branch params bound inline — this builder has no
         * addSelect to pre-bind them (unlike findAll). */
        qb.andWhere(`${MAPPING_STATUS_SQL} = :mappingStatusFilter`, {
          mappingStatusFilter: query.mappingStatus,
          mappingStatusAdminDecision: MappingStatus.ADMIN_DECISION,
          mappingStatusAdminDecisionFilter: MappingStatusFilter.ADMIN_DECISION,
          mappingStatusLocked: MappingStatusFilter.LOCKED,
          mappingStatusNegotiating: MappingStatus.NEGOTIATING,
          mappingStatusAgreed: MappingStatus.AGREED,
          mappingStatusRemoved: MappingStatus.REMOVED,
          mappingStatusInNegotiation: MappingStatusFilter.IN_NEGOTIATION,
          mappingStatusDraft: MappingStatus.DRAFT,
          mappingStatusDraftFilter: MappingStatusFilter.DRAFT,
          mappingStatusNone: MappingStatusFilter.NONE,
        });
      }

      /* Multi-select mapping-status filter — the dropdown drives this too, so
       * it lives inside the same `exclude` guard as the scalar/boolean group. */
      this.applyMappingStatusesFilter(
        qb,
        query.mappingStatuses,
        this.missingTocProgramScope(user),
        user,
      );
    }

    /* ---- Date-range filters — always. Bind raw YYYY-MM-DD strings (not JS
     * Dates) per the mysql2 DATE-column timezone gotcha. ---- */
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
        /* Parallel to `alloc` but for mappings still in `negotiating` status,
         * so the summary reports in-flight allocation alongside the agreed
         * total. Separate join (not a status IN (...)) so the two buckets
         * stay independently summable. */
        .leftJoin(
          (sub) =>
            sub
              .select('m.project_id', 'projectId')
              .addSelect(
                'COALESCE(SUM(m.allocation_percentage), 0)',
                'negotiatingPercent',
              )
              .from(ProjectMapping, 'm')
              .where('m.status = :negotiatingStatus', {
                negotiatingStatus: MappingStatus.NEGOTIATING,
              })
              .groupBy('m.project_id'),
          'allocNeg',
          'allocNeg.projectId = project.id',
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

      /* Center reps only see projects belonging to their center.
       * NOTE: user.centerId here is the active center (possibly overlaid
       * by ActiveCenterInterceptor) — KPI tiles always match the list
       * for whichever center the rep currently has active. */
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

      if (query.funder) {
        qb.andWhere('project.funder = :funder', { funder: query.funder });
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
      /* In-negotiation filter — same predicate as findAll. Includes
       * negotiating / agreed / removed to match `MAPPING_STATUS_SQL` so
       * the KPI tiles stay in lockstep with the project list. */
      if (query.inNegotiation === true) {
        qb.andWhere('project.negotiation_locked = 0').andWhere(
          `EXISTS (
            SELECT 1
            FROM project_mappings pm_neg_filter
            WHERE pm_neg_filter.project_id = project.id
              AND pm_neg_filter.status IN (
                :inNegFilterNegotiating,
                :inNegFilterAgreed,
                :inNegFilterRemoved
              )
          )`,
          {
            inNegFilterNegotiating: MappingStatus.NEGOTIATING,
            inNegFilterAgreed: MappingStatus.AGREED,
            inNegFilterRemoved: MappingStatus.REMOVED,
          },
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
      /* Ready-to-lock filter — same predicate as findAll so KPI tiles
       * stay in lockstep with the project list when the card is clicked. */
      if (query.readyToLock === true) {
        qb.andWhere(READY_TO_LOCK_SQL, {
          readyToLockRemoved: MappingStatus.REMOVED,
          readyToLockAgreed: MappingStatus.AGREED,
        });
      }
      /* Partially-allocated filter — same predicate as findAll so KPI
       * tiles stay in lockstep with the project list. */
      if (query.partiallyAllocated === true) {
        qb.andWhere(PARTIALLY_ALLOCATED_SQL, {
          partiallyAllocatedRemoved: MappingStatus.REMOVED,
        });
      }
      /* Missing-TOC-contribution filter — same predicate as findAll so KPI
       * tiles stay in lockstep with the project list. */
      if (query.missingTocContribution === true) {
        this.applyMissingTocContributionFilter(qb, user);
      }

      if (query.agreedMapping === true) {
        this.applyAgreedMappingFilter(qb, user);
      }

      if (query.removalRequested === true) {
        this.applyRemovalRequestedFilter(qb, user);
      }

      if (query.needsMyAction === true) {
        this.applyNeedsMyActionFilter(qb, user);
      }
      /* Needs-assistance filter — same predicate as findAll so KPI tiles
       * stay in lockstep with the project list. */
      if (query.needsAssistance === true) {
        qb.andWhere(NEEDS_ASSISTANCE_SQL);
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
          mappingStatusAdminDecisionFilter: MappingStatusFilter.ADMIN_DECISION,
          mappingStatusNegotiating: MappingStatus.NEGOTIATING,
          mappingStatusAgreed: MappingStatus.AGREED,
          mappingStatusDraft: MappingStatus.DRAFT,
          mappingStatusRemoved: MappingStatus.REMOVED,
          mappingStatusAdminDecision: MappingStatus.ADMIN_DECISION,
        });
        qb.andWhere(`${MAPPING_STATUS_SQL} = :mappingStatusFilter`, {
          mappingStatusFilter: query.mappingStatus,
        });
      }
      /* Multi-select mapping-status filter — same helper as findAll so the
       * KPI tiles stay in lockstep with the rows the user is browsing. */
      this.applyMappingStatusesFilter(
        qb,
        query.mappingStatuses,
        this.missingTocProgramScope(user),
        user,
      );
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
      )
      .addSelect(
        'COALESCE(SUM(COALESCE(pby.amount, 0) * COALESCE(allocNeg.negotiatingPercent, 0) / 100), 0)',
        'inNegotiationBudgetYear',
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
        inNegotiationBudgetYear: string | number | null;
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
    const inNegotiationBudgetYear = toNumber(sumRow?.inNegotiationBudgetYear);
    const activeProjectCount = Math.trunc(
      toNumber(activeRow?.activeProjectCount),
    );

    /* Avoid divide-by-zero. Round to 1 decimal place. */
    const mappedPercent =
      totalBudgetYear > 0
        ? Math.round((mappedBudgetYear / totalBudgetYear) * 1000) / 10
        : 0;
    const inNegotiationPercent =
      totalBudgetYear > 0
        ? Math.round((inNegotiationBudgetYear / totalBudgetYear) * 1000) / 10
        : 0;

    return {
      budgetYear,
      activeProjectCount,
      totalBudgetYear,
      totalPledge,
      mappedBudgetYear,
      mappedPercent,
      inNegotiationBudgetYear,
      inNegotiationPercent,
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
        /* Negotiating allocation per project — so the suggestion baseline
         * counts in-flight (not yet agreed) mapping as progress toward the
         * target, consistent with the "total mapped" headline. Without this
         * a center that has mapped almost everything but agreed little reads
         * as far-from-target and gets nonsensical suggestions. */
        .leftJoin(
          (sub) =>
            sub
              .select('m.project_id', 'projectId')
              .addSelect(
                'COALESCE(SUM(m.allocation_percentage), 0)',
                'negotiatingPercent',
              )
              .from(ProjectMapping, 'm')
              .where('m.status = :negotiatingStatusBase', {
                negotiatingStatusBase: MappingStatus.NEGOTIATING,
              })
              .groupBy('m.project_id'),
          'allocNeg',
          'allocNeg.projectId = project.id',
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

      /* Center reps only see projects belonging to their center.
       * NOTE: user.centerId is the active center (overlaid by
       * ActiveCenterInterceptor when X-Active-Center is set). */
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

      if (query.funder) {
        qb.andWhere('project.funder = :funder', { funder: query.funder });
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
          mappingStatusAdminDecisionFilter: MappingStatusFilter.ADMIN_DECISION,
          mappingStatusNegotiating: MappingStatus.NEGOTIATING,
          mappingStatusAgreed: MappingStatus.AGREED,
          mappingStatusDraft: MappingStatus.DRAFT,
          mappingStatusRemoved: MappingStatus.REMOVED,
          mappingStatusAdminDecision: MappingStatus.ADMIN_DECISION,
        });
        qb.andWhere(`${MAPPING_STATUS_SQL} = :mappingStatusFilter`, {
          mappingStatusFilter: query.mappingStatus,
        });
      }
      /* Multi-select mapping-status filter — same helper as findAll/getSummary
       * so the candidate pool reflects the list the user is browsing. */
      this.applyMappingStatusesFilter(
        qb,
        query.mappingStatuses,
        this.missingTocProgramScope(user),
        user,
      );
      qb.andWhere('project.status = :status', { status });
      return qb;
    };

    /* ---------- 1. Totals. ---------- */
    /* "Mapped" here means budget already allocated to programs — agreed
     * AND in-negotiation — matching the "total mapped" headline. A center
     * whose budget is mapped but still under negotiation has done the
     * mapping work; the target is about allocation, not agreement, so it
     * counts toward the goal and toward the already-at-target early-exit. */
    const sumQb = buildBaseQuery()
      .select('COALESCE(SUM(COALESCE(pby.amount, 0)), 0)', 'totalBudgetYear')
      .addSelect(
        `COALESCE(SUM(
           COALESCE(pby.amount, 0)
           * (COALESCE(alloc.agreedPercent, 0) + COALESCE(allocNeg.negotiatingPercent, 0))
           / 100
         ), 0)`,
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
      .leftJoinAndSelect('project.benefitCountries', 'benefitCountries')
      .leftJoinAndSelect('benefitCountries.country', 'benefitCountry')
      .leftJoinAndSelect(
        'project.implementationCountries',
        'implementationCountries',
      )
      .leftJoinAndSelect(
        'implementationCountries.country',
        'implementationCountry',
      )
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

    /* Load project + budgets so we have the existing state before the
     * diff runs. Country allocations are deleted-and-rewritten per
     * relation, so we don't need to eager-load them here. Everything
     * happens inside a single transaction. */
    await this.dataSource.transaction(async (manager) => {
      const project = await manager.findOne(Project, {
        where: { id },
        relations: ['budgets'],
      });

      if (!project) {
        throw new NotFoundException(`Project with ID "${id}" not found`);
      }

      /* Strip Anaplan-sourced fields — these are managed exclusively via CSV
       * import and must not be overwritten through the update endpoint. This
       * is a defence-in-depth measure; the DTO already omits these fields,
       * but a raw API call bypassing class-validator could still sneak them
       * through, so we delete them from the object before applying updates. */
      /* principalInvestigator + email are intentionally NOT stripped —
       * admins may edit the PI contact on update (Anaplan still wins on
       * the next import). The rest stay import-only. */
      const ANAPLAN_FIELDS = [
        'funderPrimaryCenter',
        'natureOfFunder',
        'category',
        'csp',
        'cspNonCollectionReason',
        'totalPledge',
        'signedContractTitle',
      ] as const;
      for (const key of ANAPLAN_FIELDS) {
        delete (dto as any)[key];
      }

      /* Per-table Global wins: if the caller turns a Global flag ON,
       * the matching list is cleared. If the caller turns it OFF or
       * leaves it alone and sends a list, we replace the list. If
       * neither flag nor list is sent, we leave the relation alone. */
      const effBenefitGlobal =
        dto.isBenefitGlobal === undefined
          ? project.isBenefitGlobal
          : dto.isBenefitGlobal === true;
      const effImplGlobal =
        dto.isImplementationGlobal === undefined
          ? project.isImplementationGlobal
          : dto.isImplementationGlobal === true;

      if (effBenefitGlobal) {
        await this.replaceCountryAllocations(
          id,
          ProjectBenefitCountry,
          [],
          manager,
        );
      } else if (dto.benefitCountries !== undefined) {
        const rows = await this.resolveCountryAllocations(
          dto.benefitCountries,
          manager,
          'Location of Benefit',
        );
        await this.replaceCountryAllocations(
          id,
          ProjectBenefitCountry,
          rows,
          manager,
        );
      }

      if (effImplGlobal) {
        await this.replaceCountryAllocations(
          id,
          ProjectImplementationCountry,
          [],
          manager,
        );
      } else if (dto.implementationCountries !== undefined) {
        const rows = await this.resolveCountryAllocations(
          dto.implementationCountries,
          manager,
          'Country of Implementation',
        );
        await this.replaceCountryAllocations(
          id,
          ProjectImplementationCountry,
          rows,
          manager,
        );
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
      /* Country allocations are deleted-and-rewritten per relation; no
       * need to eager-load them here. */
      const project = await manager.findOne(Project, { where: { id } });
      if (!project) {
        throw new NotFoundException(`Project with ID "${id}" not found`);
      }

      /* Center-scoping: a center_rep may only edit projects belonging
       * to their own center. Admin and unit_admin are unrestricted —
       * they can edit any project regardless of center.
       *
       * NOTE: user.centerId is the active center (possibly overlaid by
       * ActiveCenterInterceptor). A multi-center rep editing a project
       * via X-Active-Center: 3 must have project.centerId === 3. The
       * interceptor has already validated that 3 is in user.centerIds. */
      if (
        user?.role === UserRole.CENTER_REP &&
        user.centerId !== project.centerId
      ) {
        throw new ForbiddenException(
          'You may only edit projects belonging to your own center',
        );
      }

      /* PI fields (name + email) are editable on this endpoint only by
       * admin and center_rep — NOT unit_admin. unit_admin shares the
       * whitelist for the other metadata fields, so reject the PI keys
       * explicitly for that role rather than widening their reach. */
      if (user?.role === UserRole.UNIT_ADMIN) {
        const dtoRecord = dto as unknown as Record<string, unknown>;
        for (const field of PI_FIELDS_ADMIN_CENTER_ONLY) {
          if (dtoRecord[field] !== undefined) {
            throw new ForbiddenException(
              `Field "${field}" is not editable by unit_admin`,
            );
          }
        }
      }

      /* Defense-in-depth: only accept keys explicitly listed in the
       * whitelist (plus the always-allowed `justification`). Any other
       * scalar present on the dto is rejected with a 400 naming the
       * offending field — better than silently dropping it.
       *
       * Country allocation lists are whitelisted but handled separately
       * below as relations, not scalars — they do not flow into
       * `applyEdits`. */
      const whitelist = new Set<string>(UNIT_ADMIN_EDITABLE_FIELDS);
      const filtered: Partial<Record<UnitAdminEditableField, unknown>> = {};
      let touched = false;

      for (const [key, value] of Object.entries(dto)) {
        if (key === 'justification') continue;
        if (!whitelist.has(key)) {
          throw new BadRequestException(
            `Field "${key}" is not editable by unit_admin`,
          );
        }
        if (value === undefined) continue;
        touched = true;
        /* Country relations are handled below, not by applyEdits. */
        if (key === 'benefitCountries' || key === 'implementationCountries')
          continue;
        (filtered as Record<string, unknown>)[key] = value;
      }

      if (!touched) {
        throw new BadRequestException('No editable fields provided');
      }

      /* Per-table Global wins — mirrors the admin-update logic so both
       * endpoints stay consistent. Global flags themselves are scalars
       * and flow through `applyEdits` for audit. */
      const effBenefitGlobal =
        dto.isBenefitGlobal === undefined
          ? project.isBenefitGlobal
          : dto.isBenefitGlobal === true;
      const effImplGlobal =
        dto.isImplementationGlobal === undefined
          ? project.isImplementationGlobal
          : dto.isImplementationGlobal === true;

      if (effBenefitGlobal) {
        await this.replaceCountryAllocations(
          id,
          ProjectBenefitCountry,
          [],
          manager,
        );
      } else if (dto.benefitCountries !== undefined) {
        const rows = await this.resolveCountryAllocations(
          dto.benefitCountries,
          manager,
          'Location of Benefit',
        );
        await this.replaceCountryAllocations(
          id,
          ProjectBenefitCountry,
          rows,
          manager,
        );
      }

      if (effImplGlobal) {
        await this.replaceCountryAllocations(
          id,
          ProjectImplementationCountry,
          [],
          manager,
        );
      } else if (dto.implementationCountries !== undefined) {
        const rows = await this.resolveCountryAllocations(
          dto.implementationCountries,
          manager,
          'Country of Implementation',
        );
        await this.replaceCountryAllocations(
          id,
          ProjectImplementationCountry,
          rows,
          manager,
        );
      }

      /* Hand off to the shared applier — it computes the per-field diff
       * and persists the project (including the country relations we
       * just mutated). Audit emission happens post-commit via
       * auditService.record() to keep audit failures from rolling back
       * the user's primary edit. negotiation_locked is intentionally not
       * consulted here: that gate is exactly what unit_admin exists to
       * bypass. */
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
