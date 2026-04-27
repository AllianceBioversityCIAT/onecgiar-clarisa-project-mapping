import { OmitType, PartialType, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { CreateProjectDto } from './create-project.dto';

/**
 * DTO for updating an existing project (admin-only path).
 *
 * Anaplan-sourced fields (funderPrimaryCenter, natureOfFunder, category,
 * csp, cspNonCollectionReason, totalPledge, principalInvestigator,
 * signedContractTitle) are excluded — they are managed exclusively
 * via CSV import and must not be overwritten through the API.
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
  ] as const),
) {
  @ApiPropertyOptional({ description: 'Reason for the edit (optional for admins)' })
  @IsOptional()
  @IsString()
  justification?: string;
}
