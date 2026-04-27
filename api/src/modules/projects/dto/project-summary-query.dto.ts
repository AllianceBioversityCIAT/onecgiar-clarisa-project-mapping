import {
  IsOptional,
  IsString,
  IsInt,
  IsEnum,
  IsArray,
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
}
