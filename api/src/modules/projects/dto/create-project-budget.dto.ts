import {
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * DTO for a single project budget line.
 *
 * Used both inside `CreateProjectDto.budgets` (nested validation) and
 * `UpdateProjectDto.budgets`. The optional `id` field lets the update
 * diff identify existing rows that should be updated rather than
 * inserted.
 */
export class CreateProjectBudgetDto {
  /**
   * Existing budget row ID. Present on update for rows that already
   * exist in the database; omitted for newly added rows.
   */
  @ApiPropertyOptional({ description: 'Existing budget row ID (update only)' })
  @IsOptional()
  @IsInt()
  id?: number;

  /** Fiscal year code, e.g. "FY26". */
  @ApiProperty({ example: 'FY26', description: 'Fiscal year code' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  year: string;

  /** Budget version label, e.g. "FPC-I". */
  @ApiProperty({ example: 'FPC-I', description: 'Budget version label' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  version: string;

  /** Account label, e.g. "Cost Sharing Percentage (CSP)". */
  @ApiProperty({
    example: 'Cost Sharing Percentage (CSP)',
    description: 'Account label (CLARISA taxonomy)',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  account: string;

  /** Budget amount. Must be >= 0. */
  @ApiProperty({ example: 125000, description: 'Budget amount (>= 0)' })
  @IsNumber()
  @Min(0)
  amount: number;

  /** External row identifier from the 4.3 CSV (for idempotent import). */
  @ApiPropertyOptional({ description: 'External row code (4.3 CSV)' })
  @IsOptional()
  @IsString()
  externalCode?: string;
}
