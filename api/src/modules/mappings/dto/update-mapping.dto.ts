import { IsNumber, IsOptional, IsEnum, Min, Max } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Rating } from '../enums/rating.enum';

/**
 * DTO for updating an existing project-to-program mapping.
 *
 * Only the submitter can update a mapping, and only while it
 * is in `pending` or `rejected` status.
 */
export class UpdateMappingDto {
  /** Updated allocation percentage (1–100). */
  @ApiPropertyOptional({ example: 30, description: 'Allocation percentage (1–100)' })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  allocationPercentage?: number;

  /** Updated complementarity rating. */
  @ApiPropertyOptional({ enum: Rating, description: 'Complementarity rating' })
  @IsOptional()
  @IsEnum(Rating)
  complementarityRating?: Rating;

  /** Updated efficiency rating. */
  @ApiPropertyOptional({ enum: Rating, description: 'Efficiency rating' })
  @IsOptional()
  @IsEnum(Rating)
  efficiencyRating?: Rating;
}
