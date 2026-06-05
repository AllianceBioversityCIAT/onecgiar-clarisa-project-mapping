import { OmitType, PartialType, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { CreateProjectDto } from './create-project.dto';

/**
 * DTO for updating an existing project (admin-only path).
 *
 * Most Anaplan-sourced fields are excluded — they are managed exclusively
 * via CSV import and must not be overwritten through the API. This
 * covers the metadata block (funderPrimaryCenter, natureOfFunder,
 * category, csp, cspNonCollectionReason, totalPledge,
 * signedContractTitle) as well as the project's structural anchors
 * (centerId, startDate, endDate) that come from the Anaplan source of
 * truth.
 *
 * Exception: `principalInvestigator` and `email` (PI contact) ARE
 * editable here by admins. They remain Anaplan-authoritative — a CSV
 * re-import overwrites any manual edit — but admins/center reps may
 * correct them between imports.
 *
 * Optional `justification` may be supplied so admin edits also write
 * an audit trail; it is required for the unit-admin path (see
 * `UnitAdminUpdateProjectDto`).
 */
export class UpdateProjectDto extends PartialType(
  OmitType(CreateProjectDto, [
    'funderPrimaryCenter',
    'natureOfFunder',
    'category',
    'csp',
    'cspNonCollectionReason',
    'totalPledge',
    // principalInvestigator + email are editable by admins on update
    // (and by center reps via the metadata endpoint). Still
    // Anaplan-authoritative — a CSV re-import overwrites manual edits.
    'signedContractTitle',
    'code',
    'centerId',
    'startDate',
    'endDate',
    'fundingSource',
    'funder',
  ] as const),
) {
  @ApiPropertyOptional({
    description: 'Reason for the edit (optional for admins)',
  })
  @IsOptional()
  @IsString()
  justification?: string;
}
