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
 * Ratings are optional at the DTO level so admin / center_rep /
 * workflow_admin / unit_admin can call this endpoint without them.
 * Required at the SERVICE layer when role=program_rep; the service
 * throws `BadRequestException` if a program rep omits either rating.
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

  /** Program rep's complementarity rating for this mapping. */
  @ApiPropertyOptional({
    enum: Rating,
    example: Rating.HIGH,
    description:
      'Complementarity rating (required for program_rep, ignored for other roles)',
  })
  @IsOptional()
  @IsEnum(Rating)
  complementarityRating?: Rating;

  /** Program rep's efficiency rating for this mapping. */
  @ApiPropertyOptional({
    enum: Rating,
    example: Rating.MEDIUM,
    description:
      'Efficiency rating (required for program_rep, ignored for other roles)',
  })
  @IsOptional()
  @IsEnum(Rating)
  efficiencyRating?: Rating;
}
