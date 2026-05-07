import { IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * DTO for declining a program rep's removal request.
 *
 * Center / admin / workflow_admin send this when they want the mapping to
 * stay in negotiation. A short reason is optional — when provided it is
 * stored on the `removal_declined` audit event so the program rep can see
 * why their request was rejected.
 */
export class DeclineRemovalDto {
  /** Optional reason shown to the program rep (max 500 chars). */
  @ApiPropertyOptional({
    example: 'Allocation is still needed; please continue negotiation.',
    description: 'Optional reason for declining the removal request',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
