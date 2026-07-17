import {
  IsOptional,
  IsString,
  IsInt,
  IsEnum,
  IsIn,
  IsArray,
  IsBoolean,
  IsDateString,
  ArrayMaxSize,
  Matches,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ProjectStatus } from '../enums/project-status.enum';
import { FundingSource } from '../enums/funding-source.enum';
import {
  MappingStatusFilter,
  MappingFlagFilter,
  MAPPING_STATUSES_FILTER_VALUES,
} from '../enums/mapping-status-filter.enum';

/**
 * Subset of `ProjectQueryDto` used by the KPI summary endpoint.
 *
 * Mirrors the filter surface of the list endpoint (search, center, status,
 * funding source, fiscal year) so that the totals returned line up with
 * the rows the user is currently looking at. Pagination and sort are
 * intentionally omitted — the summary always aggregates over the full
 * filtered set.
 */
export class ProjectSummaryQueryDto {
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

  /** Filter by derived mapping status (kept in sync with the list endpoint). */
  @ApiPropertyOptional({
    enum: MappingStatusFilter,
    description:
      'Filter by derived mapping status (locked / in_negotiation / draft / none)',
  })
  @IsOptional()
  @IsEnum(MappingStatusFilter)
  mappingStatus?: MappingStatusFilter;

  /**
   * Multi-select lifecycle-status filter (OR semantics) — mirrors the list
   * endpoint so the KPI totals line up with the rows the user is browsing.
   * Accepts the lifecycle buckets AND the `MappingFlagFilter` attribute-flag
   * values — every supplied value ORs with the others. The standalone boolean
   * flag params remain the AND variants. Accepts repeated params or a CSV string.
   */
  @ApiPropertyOptional({
    enum: MAPPING_STATUSES_FILTER_VALUES,
    isArray: true,
    description:
      'Filter by one or more lifecycle buckets and/or attribute flags (OR semantics)',
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === null || value === '') return undefined;
    const arr = Array.isArray(value) ? value : String(value).split(',');
    return arr.map((v) => String(v).trim()).filter((v) => v.length > 0);
  })
  @IsArray()
  @ArrayMaxSize(10)
  @IsIn(MAPPING_STATUSES_FILTER_VALUES as string[], { each: true })
  mappingStatuses?: (MappingStatusFilter | MappingFlagFilter)[];

  /** Filter by funding source. */
  @ApiPropertyOptional({
    enum: FundingSource,
    description: 'Filter by funding source',
  })
  @IsOptional()
  @IsEnum(FundingSource)
  fundingSource?: FundingSource;

  /** Filter by exact funder name (selected from the distinct-funders list). */
  @ApiPropertyOptional({ description: 'Filter by exact funder name' })
  @IsOptional()
  @IsString()
  funder?: string;

  /**
   * Filter by one or more program IDs — totals are scoped to projects with
   * at least one non-removed mapping to ANY of the supplied programs.
   * Mirrors the list endpoint so KPI tiles always match the filtered rows.
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
   * Show only projects in active negotiation (unlocked + at least one
   * negotiating mapping). Mirrors the list endpoint flag.
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
   * Show only projects with at least one agreed mapping. Mirrors the
   * list endpoint flag so KPI tiles stay aligned with the table.
   */
  @ApiPropertyOptional({
    description:
      'Show only projects with at least one agreed mapping (agreedAllocatedPercent > 0)',
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
   * Show only ready-to-lock projects. Mirrors the list endpoint flag so
   * KPI tiles stay aligned with the table.
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
   * Show only partially-allocated projects (has mappings, allocation total
   * < 100%; excludes unmapped). Mirrors the list endpoint flag so KPI tiles
   * stay aligned with the table.
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
   * Show only projects with an active mapping missing TOC contribution
   * (no AOW, or no Output/Outcome link). Mirrors the list endpoint flag so
   * KPI tiles stay aligned with the table.
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
   * Show only projects with an agreed mapping. Program-scoped for program
   * reps (their own program only). Mirrors the list endpoint flag so KPI
   * tiles stay aligned with the table.
   */
  @ApiPropertyOptional({
    description:
      'Show only projects with an agreed mapping (program rep: their own program only)',
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    return value;
  })
  @IsBoolean()
  agreedMapping?: boolean;

  /**
   * Show only projects with a pending mapping removal request. Program-scoped
   * for program reps (their own program only). Mirrors the list endpoint flag
   * so KPI tiles stay aligned with the table.
   */
  @ApiPropertyOptional({
    description:
      'Show only projects with a pending mapping removal request (program rep: their own program only)',
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    return value;
  })
  @IsBoolean()
  removalRequested?: boolean;

  /**
   * Show only projects waiting on the current viewer to act (center rep /
   * program rep). Mirrors the list endpoint flag so KPI tiles stay aligned
   * with the table.
   */
  @ApiPropertyOptional({
    description:
      'Show only projects waiting on the current viewer to act (center rep / program rep)',
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    return value;
  })
  @IsBoolean()
  needsMyAction?: boolean;

  /**
   * Show only projects with ≥1 mapping flagged for workflow-admin
   * assistance. Mirrors the list endpoint flag so KPI tiles stay aligned
   * with the table.
   */
  @ApiPropertyOptional({
    description:
      'Show only projects with at least one mapping flagged for workflow-admin assistance',
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
   * Fiscal-year code used for `totalBudgetYear` and `mappedBudgetYear`.
   * Defaults to `FY26` in the service when omitted.
   */
  @ApiPropertyOptional({
    description:
      'Fiscal year for the budget totals (e.g. FY26). Defaults to FY26.',
    example: 'FY26',
  })
  @IsOptional()
  @IsString()
  @Matches(/^FY\d{2}$/, {
    message: 'budgetYear must match FY## (e.g. FY26)',
  })
  budgetYear?: string;

  /**
   * Date-range filters mirroring `ProjectQueryDto` so the KPI tiles align
   * with the rows returned by `GET /projects`. ISO 8601 `YYYY-MM-DD`,
   * parsed with `new Date(value)` in the service.
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
   * When true, include excluded projects in the aggregate totals (center_rep only).
   * Mirrors the `showExcluded` flag on the list endpoint so KPI tiles stay
   * consistent with the rows the user is looking at.
   */
  @ApiPropertyOptional({
    description:
      'Include excluded projects in the aggregate totals (center_rep only)',
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
}
