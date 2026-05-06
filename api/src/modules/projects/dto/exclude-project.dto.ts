import { IsString, MinLength, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Request body for POST /projects/:id/exclude.
 *
 * A required `reason` (min 5 chars) is the only field — the center and actor
 * are inferred from the authenticated user's session at the service layer.
 */
export class ExcludeProjectDto {
  /**
   * Human-readable reason why this project is being excluded from the
   * center's default view. Must be at least 5 characters so the reason
   * is meaningful in the audit log and in hover tooltips.
   */
  @ApiProperty({
    description:
      "Reason for excluding the project from this center's default view (min 5 chars)",
    example: "Project is not relevant to our center's current portfolio cycle.",
    minLength: 5,
    maxLength: 1000,
  })
  @IsString()
  @MinLength(5, { message: 'Exclusion reason must be at least 5 characters' })
  @MaxLength(1000, {
    message: 'Exclusion reason must not exceed 1000 characters',
  })
  reason: string;
}
