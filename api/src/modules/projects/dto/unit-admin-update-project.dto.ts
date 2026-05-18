import {
  IsNumber,
  IsOptional,
  IsString,
  Min,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Whitelist of project metadata fields a `unit_admin` (PPU/PCU) may
 * edit, including on locked projects. Single source of truth — the
 * service-layer filter and the DTO both reference this list.
 *
 * Excludes: `code` (Anaplan join key), `centerId`, `startDate`,
 * `endDate`, `countryIds`, `status`, `negotiationLocked`, all other
 * Anaplan-sourced fields, and `project_budgets` (annual breakdown —
 * sourced from 4.3 import). Anaplan-owned data is immutable for every
 * role, super-admin included.
 */
export const UNIT_ADMIN_EDITABLE_FIELDS = [
  'name',
  'description',
  'summary',
  'totalBudget',
  'remainingBudget',
] as const;

export type UnitAdminEditableField =
  (typeof UNIT_ADMIN_EDITABLE_FIELDS)[number];

/**
 * DTO for `PATCH /projects/:id/metadata`. Stricter than
 * `UpdateProjectDto` — only the whitelist fields are accepted, and
 * `justification` is required (≥ 5 chars) so the audit trail captures
 * a reason for every edit.
 */
export class UnitAdminUpdateProjectDto {
  @ApiPropertyOptional({ description: 'Project name' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ description: 'Project description' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ description: 'Project summary' })
  @IsOptional()
  @IsString()
  summary?: string;

  @ApiPropertyOptional({ description: 'Total budget (>= 0)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  totalBudget?: number;

  @ApiPropertyOptional({ description: 'Remaining budget (>= 0)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  remainingBudget?: number;

  /**
   * Required reason for the edit, written to every audit row produced
   * by this PATCH. Min 5 chars to discourage empty / blank reasons.
   */
  @ApiProperty({
    description: 'Reason for the edit (required, min 5 chars)',
    example: 'Donor name correction per 2026-04 contract amendment',
  })
  @IsString()
  @MinLength(5)
  justification: string;
}
