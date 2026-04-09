import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsDateString,
  IsNumber,
  IsEnum,
  IsArray,
  IsUUID,
  Min,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { FundingSource } from '../enums/funding-source.enum';

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
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @IsNotEmpty()
  code: string;

  /** Full name of the project. */
  @ApiProperty({ example: 'Climate Resilience Initiative', description: 'Project name' })
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
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

  /** Key results or expected outcomes. */
  @ApiPropertyOptional({ description: 'Project results' })
  @IsOptional()
  @IsString()
  results?: string;

  /** Project start date in ISO 8601 format (YYYY-MM-DD). */
  @ApiPropertyOptional({ example: '2026-01-01', description: 'Start date (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  /** Project end date in ISO 8601 format (YYYY-MM-DD). */
  @ApiPropertyOptional({ example: '2028-12-31', description: 'End date (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  /** Total approved budget. Must be >= 0. */
  @ApiProperty({ example: 500000, description: 'Total budget (decimal, >= 0)' })
  @IsNumber()
  @Min(0)
  totalBudget: number;

  /** Remaining budget. Defaults to totalBudget if not provided. */
  @ApiPropertyOptional({ example: 250000, description: 'Remaining budget (decimal, >= 0)' })
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
  @ApiPropertyOptional({ example: 'Bill & Melinda Gates Foundation', description: 'Funder name' })
  @IsOptional()
  @IsString()
  funder?: string;

  /** UUID of the CGIAR center this project belongs to. */
  @ApiProperty({ description: 'Center UUID' })
  @IsUUID()
  centerId: string;

  /** UUIDs of countries where the project operates. */
  @ApiPropertyOptional({ type: [String], description: 'Array of country UUIDs' })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  countryIds?: string[];
}
