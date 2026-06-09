import {
  IsOptional,
  IsString,
  IsInt,
  IsEnum,
  IsBoolean,
  IsIn,
  IsArray,
  IsDateString,
  IsNumber,
  ArrayMaxSize,
  Matches,
  Min,
  Max,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ProjectStatus } from '../enums/project-status.enum';
import { FundingSource } from '../enums/funding-source.enum';
import { MappingStatusFilter } from '../enums/mapping-status-filter.enum';

/**
 * Whitelisted sort fields for the projects list endpoint. Mapping to raw SQL
 * columns is performed in the service layer — only fields listed here are
 * accepted by the validator. Adding a field here is the only safe place to
 * extend the sort surface; arbitrary user-provided strings must never reach
 * the QueryBuilder's `orderBy()`.
 */
export const PROJECT_SORT_FIELDS = [
  'code',
  'name',
  'startDate',
  'endDate',
  'totalBudget',
  'totalPledge',
  'status',
  'budget2026',
  'agreedAllocatedPercent',
] as const;

export type ProjectSortField = (typeof PROJECT_SORT_FIELDS)[number];

/**
 * DTO for querying the projects list endpoint.
 *
 * Supports text search, filtering by center/status/funding source,
 * and offset-based pagination.
 */
export class ProjectQueryDto {
  /** Free-text search across code, name, and description. */
  @ApiPropertyOptional({
    description: 'Search term (matches code, name, description)',
  })
  @IsOptional()
  @IsString()
  search?: string;

  /** Filter by center ID. */
  @ApiPropertyOptional({ description: 'Filter by center ID' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  centerId?: number;

  /** Filter by project status. */
  @ApiPropertyOptional({ enum: ProjectStatus, description: 'Filter by status' })
  @IsOptional()
  @IsEnum(ProjectStatus)
  status?: ProjectStatus;

  /**
   * Filter by the derived per-project negotiation classification. Computed
   * server-side from `projects.negotiation_locked` plus the statuses of the
   * project's non-removed `project_mappings`. See `MappingStatusFilter` for
   * the priority rules — buckets are mutually exclusive.
   */
  @ApiPropertyOptional({
    enum: MappingStatusFilter,
    description:
      'Filter by derived mapping status (locked / in_negotiation / draft / none)',
  })
  @IsOptional()
  @IsEnum(MappingStatusFilter)
  mappingStatus?: MappingStatusFilter;

  /** Filter by funding source. */
  @ApiPropertyOptional({
    enum: FundingSource,
    description: 'Filter by funding source',
  })
  @IsOptional()
  @IsEnum(FundingSource)
  fundingSource?: FundingSource;

  /** Filter by program ID (reserved for future use when project-program mapping exists). */
  @ApiPropertyOptional({ description: 'Filter by program ID (future use)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  programId?: number;

  /**
   * Filter by one or more program IDs — returns projects with at least one
   * non-removed mapping to ANY of the supplied programs (OR semantics).
   *
   * Accepts repeated `programIds=` query params (Nest's default array
   * binding) or a single CSV string `programIds=1,2,3`. The transformer
   * below normalises both shapes to `number[]` before validation runs.
   */
  @ApiPropertyOptional({
    description:
      'Filter by one or more program IDs (projects with a non-removed mapping to any of them)',
    type: [Number],
    isArray: true,
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === null || value === '') return undefined;
    const arr = Array.isArray(value) ? value : String(value).split(',');
    return arr
      .map((v) => parseInt(String(v).trim(), 10))
      .filter((n) => Number.isFinite(n));
  })
  @IsArray()
  @ArrayMaxSize(50)
  @IsInt({ each: true })
  programIds?: number[];

  /**
   * Filter to only projects that have at least one mapping flagged
   * `needs_assistance`. Admin / workflow_admin only — non-privileged
   * roles get a 403.
   */
  @ApiPropertyOptional({
    description:
      'Show only projects with at least one mapping flagged for workflow-admin assistance (admin/workflow_admin only)',
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    return value;
  })
  @IsBoolean()
  needsAssistance?: boolean;

  /**
   * Show only projects currently in active negotiation: project is unlocked
   * AND has at least one mapping in `negotiating` status. Mirrors the
   * `inActiveNegotiation` per-row flag.
   */
  @ApiPropertyOptional({
    description:
      'Show only projects with an active negotiation (unlocked + at least one negotiating mapping)',
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    return value;
  })
  @IsBoolean()
  inNegotiation?: boolean;

  /**
   * Show only actively-negotiating projects: unlocked AND at least one
   * mapping in `negotiating` status. STRICT definition matching the
   * dashboard "Negotiating" tile, distinct from the looser `inNegotiation`
   * (which also counts agreed/removed). Powers the dashboard card link.
   */
  @ApiPropertyOptional({
    description:
      'Show only actively-negotiating projects (unlocked + at least one mapping in negotiating status)',
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    return value;
  })
  @IsBoolean()
  negotiating?: boolean;

  /**
   * Show only projects that have at least one agreed mapping. Mirrors the
   * "Mapped %" KPI definition (status='agreed' counts toward the goal,
   * negotiating mappings do not).
   */
  @ApiPropertyOptional({
    description:
      'Show only projects with at least one agreed mapping (i.e. agreedAllocatedPercent > 0)',
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    return value;
  })
  @IsBoolean()
  mapped?: boolean;

  /**
   * Show only "ready to lock" projects: unlocked, with at least one mapping,
   * where every non-removed mapping is agreed (mirrors the lock guard).
   * Sub-state of inNegotiation; powers the dashboard "Ready to lock" card.
   */
  @ApiPropertyOptional({
    description:
      'Show only ready-to-lock projects (unlocked, has mappings, every non-removed mapping agreed)',
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    return value;
  })
  @IsBoolean()
  readyToLock?: boolean;

  /**
   * Show only "partially allocated" projects: at least one non-removed
   * mapping exists but the allocation total is under 100%. Excludes
   * fully-unmapped projects (nothing to top up). Orthogonal to the
   * mapping-status buckets — a partially allocated project can be in any
   * negotiation state. Lets the center find projects to allocate up to 100%.
   */
  @ApiPropertyOptional({
    description:
      'Show only partially-allocated projects (has mappings, allocation total < 100%); excludes unmapped',
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    return value;
  })
  @IsBoolean()
  partiallyAllocated?: boolean;

  /**
   * Show only projects with at least one active (non-removed) mapping whose
   * TOC contribution is not yet filled. Mirrors the program-side agree gate:
   * a mapping is "filled" when it has ≥1 AOW link AND (≥1 Output OR ≥1
   * Outcome link). Lets reps find mappings that still need TOC links before
   * they can be agreed.
   */
  @ApiPropertyOptional({
    description:
      'Show only projects with an active mapping missing TOC contribution (no AOW, or no Output/Outcome link)',
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    return value;
  })
  @IsBoolean()
  missingTocContribution?: boolean;

  /**
   * Fiscal-year code used to compute the per-row `budget2026` aggregate.
   * Stored verbatim in `project_budgets.year` (e.g. `FY26`, `FY27`).
   * Defaults to `FY26` in the service when omitted.
   */
  @ApiPropertyOptional({
    description:
      'Fiscal year for the budget aggregate (e.g. FY26). Defaults to FY26.',
    example: 'FY26',
  })
  @IsOptional()
  @IsString()
  @Matches(/^FY\d{2}$/, {
    message: 'budgetYear must match FY## (e.g. FY26)',
  })
  budgetYear?: string;

  /**
   * Lower bound (inclusive) for `start_date`. Accepts ISO 8601
   * `YYYY-MM-DD`. Kept as a raw string here; the service parses it with
   * `new Date(value)` before binding so we don't break the existing
   * Date-binding pattern used by other date filters in the codebase.
   */
  @ApiPropertyOptional({
    description: 'Filter projects with start_date on or after this ISO date',
    example: '2024-01-01',
  })
  @IsOptional()
  @IsDateString()
  startDateFrom?: string;

  /** Upper bound (inclusive) for `start_date`. ISO 8601 `YYYY-MM-DD`. */
  @ApiPropertyOptional({
    description: 'Filter projects with start_date on or before this ISO date',
    example: '2024-12-31',
  })
  @IsOptional()
  @IsDateString()
  startDateTo?: string;

  /** Lower bound (inclusive) for `end_date`. ISO 8601 `YYYY-MM-DD`. */
  @ApiPropertyOptional({
    description: 'Filter projects with end_date on or after this ISO date',
    example: '2024-01-01',
  })
  @IsOptional()
  @IsDateString()
  endDateFrom?: string;

  /** Upper bound (inclusive) for `end_date`. ISO 8601 `YYYY-MM-DD`. */
  @ApiPropertyOptional({
    description: 'Filter projects with end_date on or before this ISO date',
    example: '2024-12-31',
  })
  @IsOptional()
  @IsDateString()
  endDateTo?: string;

  /**
   * Server-side sort field. Restricted to the whitelist defined in
   * `PROJECT_SORT_FIELDS` so untrusted input never reaches the SQL
   * layer. Maps to raw columns in the service.
   */
  @ApiPropertyOptional({
    description: 'Field to sort by',
    enum: PROJECT_SORT_FIELDS,
  })
  @IsOptional()
  @IsIn(PROJECT_SORT_FIELDS as unknown as string[])
  sortField?: ProjectSortField;

  /** Server-side sort direction. */
  @ApiPropertyOptional({
    description: 'Sort direction',
    enum: ['ASC', 'DESC'],
  })
  @IsOptional()
  @IsIn(['ASC', 'DESC'])
  sortOrder?: 'ASC' | 'DESC';

  /** Page number (1-based). Defaults to 1. */
  @ApiPropertyOptional({ default: 1, minimum: 1, description: 'Page number' })
  @IsOptional()
  @Type(() => Number)
  @Min(1)
  page: number = 1;

  /** Number of items per page. Defaults to 20, max 100. */
  @ApiPropertyOptional({
    default: 20,
    minimum: 1,
    maximum: 100,
    description: 'Items per page',
  })
  @IsOptional()
  @Type(() => Number)
  @Min(1)
  @Max(100)
  limit: number = 20;

  /**
   * When true, include excluded projects in the result set (center_rep only).
   * Excluded rows are returned with `exclusion` metadata attached.
   * Ignored for all other roles — they always see every project.
   */
  @ApiPropertyOptional({
    description:
      'Include excluded projects in the list (center_rep only). Excluded rows carry an `exclusion` field.',
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    return value;
  })
  @IsBoolean()
  showExcluded?: boolean;

  /**
   * When true, restricts the list to projects picked by the server-side
   * "suggested to reach target" greedy walk. The service runs
   * `getSuggestedToReachTarget` with the current filter scope (search,
   * centerId, programIds, fundingSource, mappingStatus, role visibility,
   * exclusions, etc.) and limits the result set to the returned
   * `projectIds`. Pagination and sorting then operate normally on that
   * narrowed pool. Default ordering preserves the suggestion's
   * contribution-DESC ranking when no explicit sortField is supplied.
   *
   * Reuses the existing `budgetYear` field (same FY semantics) and adds
   * `suggestionTarget` for the goal percentage. Empty suggestion → the
   * endpoint short-circuits and returns `{ data: [], total: 0 }`.
   */
  @ApiPropertyOptional({
    description:
      'Restrict results to the server-side suggestion projectIds (greedy walk to reach `suggestionTarget`%)',
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    return value;
  })
  @IsBoolean()
  suggestedOnly?: boolean;

  /**
   * Mapped-% goal the greedy walk targets when `suggestedOnly=true`.
   * Range 1..100. Defaults to 90 in the service (matches the dashboard
   * KPI threshold) when omitted. Ignored when `suggestedOnly` is false.
   */
  @ApiPropertyOptional({
    description:
      'Target mapped percentage for the suggestion walk (1..100). Defaults to 90. Only used when suggestedOnly=true.',
    minimum: 1,
    maximum: 100,
    example: 90,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  suggestionTarget?: number;

  /**
   * Fiscal-year override for the suggestion walk when `suggestedOnly=true`.
   * Alias for `budgetYear` — kept separate so the suggestion's FY can be
   * pinned even when the list's own FY filter is in use for something else.
   * Falls back to `budgetYear`, then to the service default ('FY26').
   */
  @ApiPropertyOptional({
    description:
      'Budget year for the suggestion walk (FY##). Defaults to budgetYear, then to FY26. Only used when suggestedOnly=true.',
    example: 'FY26',
  })
  @IsOptional()
  @Matches(/^FY\d{2}$/, {
    message: 'suggestionBudgetYear must match FY## (e.g. FY26)',
  })
  suggestionBudgetYear?: string;
}
