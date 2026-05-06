import {
  IsOptional,
  IsString,
  IsInt,
  IsEnum,
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

  /** Filter by funding source. */
  @ApiPropertyOptional({
    enum: FundingSource,
    description: 'Filter by funding source',
  })
  @IsOptional()
  @IsEnum(FundingSource)
  fundingSource?: FundingSource;

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
