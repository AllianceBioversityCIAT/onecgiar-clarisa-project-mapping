import { OmitType, PartialType } from '@nestjs/swagger';
import { CreateProjectDto } from './create-project.dto';

/**
 * DTO for updating an existing project.
 *
 * Anaplan-sourced fields (funderPrimaryCenter, natureOfFunder, category,
 * csp, cspNonCollectionReason, totalPledge, principalInvestigator,
 * signedContractTitle) are excluded — they are managed exclusively
 * via CSV import and must not be overwritten through the API.
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
) {}
