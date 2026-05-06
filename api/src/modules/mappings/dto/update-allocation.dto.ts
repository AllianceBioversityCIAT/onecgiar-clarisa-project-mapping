import { IsNumber, Min, Max, IsOptional, IsEnum } from 'class-validator';
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
}
