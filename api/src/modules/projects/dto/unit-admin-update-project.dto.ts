import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MaxWords } from '../../../common/decorators/max-words.decorator';
import { CountryAllocationDto } from './country-allocation.dto';

/**
 * Whitelist of project metadata fields a `unit_admin` (PPU/PCU) may
 * edit, including on locked projects. Single source of truth — the
 * service-layer filter and the DTO both reference this list.
 *
 * Excludes: `code` (Anaplan join key), `centerId`, `startDate`,
 * `endDate`, `status`, `negotiationLocked`, all other Anaplan-sourced
 * fields, and `project_budgets` (annual breakdown — sourced from 4.3
 * import). Both country lists and their independent Global flags are
 * editable here so center reps can correct geographic scope with a
 * justification.
 */
export const UNIT_ADMIN_EDITABLE_FIELDS = [
  'name',
  'description',
  'summary',
  'totalBudget',
  'remainingBudget',
  'isBenefitGlobal',
  'isImplementationGlobal',
  'benefitCountries',
  'implementationCountries',
  // Principal Investigator name + contact email. Editable here so admins
  // and center reps can correct PI details; gated to those two roles in
  // the service (unit_admin may NOT edit them). Still Anaplan-authoritative
  // — a CSV re-import overwrites manual edits.
  'principalInvestigator',
  'email',
] as const;

export type UnitAdminEditableField =
  (typeof UNIT_ADMIN_EDITABLE_FIELDS)[number];

/**
 * Subset of {@link UNIT_ADMIN_EDITABLE_FIELDS} that `unit_admin` may NOT
 * edit — only `admin` and `center_rep` (own center). Enforced in
 * `ProjectsService.unitAdminUpdate`.
 */
export const PI_FIELDS_ADMIN_CENTER_ONLY = [
  'principalInvestigator',
  'email',
] as const;

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

  @ApiPropertyOptional({ description: 'Project description (max. 5000 words)' })
  @IsOptional()
  @IsString()
  @MaxWords(5000)
  description?: string;

  @ApiPropertyOptional({ description: 'Project summary (max. 150 words)' })
  @IsOptional()
  @IsString()
  @MaxWords(150)
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

  @ApiPropertyOptional({
    description:
      'Location of Benefit is Global. Mutually exclusive with benefitCountries — when true, the list is cleared.',
  })
  @IsOptional()
  @IsBoolean()
  isBenefitGlobal?: boolean;

  @ApiPropertyOptional({
    description:
      'Country of Implementation is Global. Mutually exclusive with implementationCountries.',
  })
  @IsOptional()
  @IsBoolean()
  isImplementationGlobal?: boolean;

  @ApiPropertyOptional({
    description:
      'Country allocations for Location of Benefit. Ignored when isBenefitGlobal=true.',
    type: [CountryAllocationDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CountryAllocationDto)
  benefitCountries?: CountryAllocationDto[];

  @ApiPropertyOptional({
    description:
      'Country allocations for Country of Implementation. Ignored when isImplementationGlobal=true.',
    type: [CountryAllocationDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CountryAllocationDto)
  implementationCountries?: CountryAllocationDto[];

  @ApiPropertyOptional({
    description:
      'Principal investigator name (admin / center_rep only). Anaplan-authoritative — overwritten on the next CSV import.',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MaxLength(255)
  principalInvestigator?: string;

  @ApiPropertyOptional({
    description:
      'Principal investigator contact email (admin / center_rep only). Anaplan-authoritative — overwritten on the next CSV import.',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @ValidateIf((_o, v) => v !== '' && v !== null)
  @IsEmail()
  @MaxLength(255)
  email?: string;

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
