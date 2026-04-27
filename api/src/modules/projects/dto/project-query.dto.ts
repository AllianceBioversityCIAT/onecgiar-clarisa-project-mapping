import {
  IsOptional,
  IsString,
  IsInt,
  IsEnum,
  IsBoolean,
  IsIn,
  IsArray,
  ArrayMaxSize,
  Matches,
  Min,
  Max,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ProjectStatus } from '../enums/project-status.enum';
import { FundingSource } from '../enums/funding-source.enum';

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
}
