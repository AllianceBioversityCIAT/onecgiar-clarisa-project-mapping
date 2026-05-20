import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsDateString,
  IsNumber,
  IsEnum,
  IsArray,
  IsBoolean,
  IsInt,
  Min,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { FundingSource } from '../enums/funding-source.enum';
import { NatureOfFunder } from '../enums/nature-of-funder.enum';
import { ProjectCategory } from '../enums/project-category.enum';
import { CspFlag } from '../enums/csp-flag.enum';
import { CreateProjectBudgetDto } from './create-project-budget.dto';

/**
 * DTO for creating a new project.
 *
 * Validates all required and optional fields before the project
 * is persisted. The `createdBy` user is resolved from the JWT
 * token rather than from the request body.
 */
export class CreateProjectDto {
  /** Unique project code, e.g. 'S0003'. */
  @ApiProperty({ example: 'S0003', description: 'Unique project code' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  code: string;

  /** Full name of the project. */
  @ApiProperty({
    example: 'Climate Resilience Initiative',
    description: 'Project name',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  name: string;

  /** Detailed description of the project. */
  @ApiPropertyOptional({ description: 'Project description' })
  @IsOptional()
  @IsString()
  description?: string;

  /** Executive summary. */
  @ApiPropertyOptional({ description: 'Project summary' })
  @IsOptional()
  @IsString()
  summary?: string;

  /** Project start date in ISO 8601 format (YYYY-MM-DD). */
  @ApiPropertyOptional({
    example: '2026-01-01',
    description: 'Start date (ISO 8601)',
  })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  /** Project end date in ISO 8601 format (YYYY-MM-DD). */
  @ApiPropertyOptional({
    example: '2028-12-31',
    description: 'End date (ISO 8601)',
  })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  /** Total approved budget. Must be >= 0. */
  @ApiProperty({ example: 500000, description: 'Total budget (decimal, >= 0)' })
  @IsNumber()
  @Min(0)
  totalBudget: number;

  /** Remaining budget. Defaults to totalBudget if not provided. */
  @ApiPropertyOptional({
    example: 250000,
    description: 'Remaining budget (decimal, >= 0)',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  remainingBudget?: number;

  /** Funding source category. */
  @ApiPropertyOptional({ enum: FundingSource, description: 'Funding source' })
  @IsOptional()
  @IsEnum(FundingSource)
  fundingSource?: FundingSource;

  /** Name of the funding organization or donor. */
  @ApiPropertyOptional({
    example: 'Bill & Melinda Gates Foundation',
    description: 'Funder name',
  })
  @IsOptional()
  @IsString()
  funder?: string;

  /** ID of the CGIAR center this project belongs to. */
  @ApiProperty({ description: 'Center ID' })
  @Type(() => Number)
  @IsInt()
  centerId: number;

  /** IDs of countries where the project operates (Location of Benefit). */
  @ApiPropertyOptional({ type: [Number], description: 'Array of country IDs' })
  @IsOptional()
  @IsArray()
  @Type(() => Number)
  @IsInt({ each: true })
  countryIds?: number[];

  /**
   * IDs of countries where the project is implemented (Country of
   * Implementation). Independent of `countryIds` (Location of Benefit)
   * and not affected by `isGlobal`.
   */
  @ApiPropertyOptional({
    type: [Number],
    description: 'Array of country IDs for Country of Implementation',
  })
  @IsOptional()
  @IsArray()
  @Type(() => Number)
  @IsInt({ each: true })
  implementationCountryIds?: number[];

  /**
   * Whether the project has no country-specific scope (Global). When
   * true, `countryIds` are ignored by the service layer and the
   * project's countries are forced to an empty list.
   *
   * Coerced from query-string / form-data booleans ("true", "1",
   * "false", "0") to a real boolean so the flag survives both JSON
   * bodies and URL-encoded form submissions.
   */
  @ApiPropertyOptional({
    description: 'Whether the project spans all geographies (Global)',
    type: Boolean,
    default: false,
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    return value;
  })
  @IsBoolean()
  isGlobal?: boolean;

  /* ------------------------------------------------------------------ */
  /* Optional fields sourced from the 4.1 Project Info CSV. All fields  */
  /* below are optional; existing clients that do not send them remain  */
  /* fully compatible.                                                  */
  /* ------------------------------------------------------------------ */

  /** Funder of the primary CGIAR center. */
  @ApiPropertyOptional({ description: 'Funder of the primary center' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  funderPrimaryCenter?: string;

  /** Nature of the funding organization. */
  @ApiPropertyOptional({
    enum: NatureOfFunder,
    description: 'Nature of funder',
  })
  @IsOptional()
  @IsEnum(NatureOfFunder)
  natureOfFunder?: NatureOfFunder;

  /** Funding category (Restricted / Unrestricted). */
  @ApiPropertyOptional({
    enum: ProjectCategory,
    description: 'Project category',
  })
  @IsOptional()
  @IsEnum(ProjectCategory)
  category?: ProjectCategory;

  /** Whether the project collects a Cost Sharing Percentage. */
  @ApiPropertyOptional({ enum: CspFlag, description: 'CSP flag (YES/NO)' })
  @IsOptional()
  @IsEnum(CspFlag)
  csp?: CspFlag;

  /** Reason CSP is not collected — only meaningful when csp = NO. */
  @ApiPropertyOptional({ description: 'Reason CSP is not collected' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  cspNonCollectionReason?: string;

  /** Total pledged amount (distinct from totalBudget). */
  @ApiPropertyOptional({ example: 1200000, description: 'Total pledge (>= 0)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  totalPledge?: number;

  /** Principal investigator free-text name. */
  @ApiPropertyOptional({ description: 'Principal investigator' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  principalInvestigator?: string;

  /** Signed contract title (full legal title). */
  @ApiPropertyOptional({ description: 'Signed contract title' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  signedContractTitle?: string;

  /**
   * Fiscal-year budget breakdown lines. On create, all rows are
   * inserted. On update, rows with an `id` are matched and updated,
   * rows without an `id` are inserted, and pre-existing rows missing
   * from the payload are deleted — all inside a single transaction.
   */
  @ApiPropertyOptional({
    type: [CreateProjectBudgetDto],
    description: 'Budget breakdown lines',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateProjectBudgetDto)
  budgets?: CreateProjectBudgetDto[];
}
