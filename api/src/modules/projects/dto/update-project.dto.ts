import { OmitType, PartialType, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { CreateProjectDto } from './create-project.dto';

/**
 * DTO for updating an existing project (admin-only path).
 *
 * Anaplan-sourced fields are excluded — they are managed exclusively
 * via CSV import and must not be overwritten through the API. This
 * covers the metadata block (funderPrimaryCenter, natureOfFunder,
 * category, csp, cspNonCollectionReason, totalPledge,
 * principalInvestigator, signedContractTitle) as well as the project's
 * structural anchors (centerId, startDate, endDate) that come from
 * the Anaplan source of truth.
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
    'principalInvestigator',
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
