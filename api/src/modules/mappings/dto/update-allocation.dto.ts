import {
  IsNumber,
  Min,
  Max,
  IsOptional,
  IsEnum,
  IsString,
  MinLength,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Rating } from '../enums/rating.enum';

/**
 * DTO for inline update of a mapping's allocation percentage.
 *
 * Accepts 0-100 inclusive. 0 is permitted so the UI can temporarily
 * zero-out a row while the user reallocates; callers that want a
 * strict >0 constraint should validate at a higher layer.
 *
 * Ratings are optional at the DTO level so program reps using the
 * inline editor can call without them. Required at the SERVICE layer
 * when the actor side is `center` (admin / center_rep / workflow_admin
 * acting on behalf of the center) — those callers must supply BOTH
 * ratings on every allocation edit. The service throws
 * `BadRequestException` if a center-side caller omits either rating.
 */
export class UpdateAllocationDto {
  @ApiProperty({
    example: 40,
    description: 'New allocation percentage (0-100)',
  })
  @IsNumber()
  @Min(0)
  @Max(100)
  allocationPercentage: number;

  /** Center-side complementarity rating (required for center side). */
  @ApiPropertyOptional({
    enum: Rating,
    example: Rating.HIGH,
    description:
      'Complementarity rating (required for center-side actors, ignored for program reps)',
  })
  @IsOptional()
  @IsEnum(Rating)
  complementarityRating?: Rating;

  /** Center-side efficiency rating (required for center side). */
  @ApiPropertyOptional({
    enum: Rating,
    example: Rating.MEDIUM,
    description:
      'Efficiency rating (required for center-side actors, ignored for program reps)',
  })
  @IsOptional()
  @IsEnum(Rating)
  efficiencyRating?: Rating;

  /**
   * Optional rationale for the allocation change. Required (≥10 chars) at
   * the SERVICE layer for center-side edits to DRAFT mappings — the popover
   * on the consolidated page collects this as the "Propose" justification
   * after a project reopen, and it is persisted on the appended
   * `COUNTER_PROPOSED` event so the timeline carries the reason. Ignored
   * for non-draft paths (those clear/reset agreement flags via a different
   * code path and do not carry a justification on the event).
   */
  @ApiPropertyOptional({
    example: 'Reopened round — proposing new split after revised work plan.',
    description:
      'Rationale for the allocation change. Required on draft rows for center-side actors (min 10, max 2000 chars).',
  })
  @IsOptional()
  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  justification?: string;
}
