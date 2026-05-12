import {
  IsOptional,
  IsString,
  IsInt,
  IsEnum,
  IsNumber,
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
import { MappingStatusFilter } from '../enums/mapping-status-filter.enum';

/**
 * Query DTO for `GET /projects/suggested-to-reach-target`.
 *
 * Powers the "what should I map next?" greedy suggestion. Filter surface
 * mirrors the summary endpoint so totals/scoping line up; `target` is the
 * mapped-% goal we are walking toward, defaulting to the same 90 % the
 * dashboard's KPI threshold uses.
 *
 * `status` defaults to `'active'` in the service when omitted because
 * suggestions only make sense for live projects — archived/draft rows
 * are not actionable for a center rep right now.
 */
export class ProjectSuggestedQueryDto {
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

  /**
   * Filter by project status. Defaults to `active` in the service when
   * omitted — suggestions for archived/draft projects don't make sense.
   */
  @ApiPropertyOptional({
    enum: ProjectStatus,
    description: 'Filter by status (defaults to active)',
  })
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

  /** Filter by funding source. */
  @ApiPropertyOptional({
    enum: FundingSource,
    description: 'Filter by funding source',
  })
  @IsOptional()
  @IsEnum(FundingSource)
  fundingSource?: FundingSource;

  /**
   * Filter by one or more program IDs — only projects with at least one
   * non-removed mapping to ANY of the supplied programs are eligible
   * candidates for the greedy walk.
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
   * Fiscal-year code used for the per-project budget aggregate and the
   * total/mapped denominators. Stored verbatim in `project_budgets.year`.
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
   * Mapped-% goal we are walking the suggestion list toward. Range 1..100,
   * 1-decimal precision. Defaults to `90` in the service when omitted —
   * matches the dashboard's KPI threshold.
   */
  @ApiPropertyOptional({
    description: 'Target mapped percentage to reach (1..100). Defaults to 90.',
    minimum: 1,
    maximum: 100,
    example: 90,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  target?: number;
}
