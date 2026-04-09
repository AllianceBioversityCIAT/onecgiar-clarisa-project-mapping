import { IsUUID, IsNumber, IsOptional, IsEnum, Min, Max } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Rating } from '../enums/rating.enum';

/**
 * DTO for creating a project-to-program mapping.
 *
 * The `programId` is derived from the authenticated user's profile
 * (must be a program representative) and is NOT included in the
 * request body.
 */
export class CreateMappingDto {
  /** UUID of the project to map. */
  @ApiProperty({ description: 'UUID of the project to map' })
  @IsUUID()
  projectId: string;

  /** Percentage of the project allocated to this program (1–100). */
  @ApiProperty({ example: 50, description: 'Allocation percentage (1–100)' })
  @IsNumber()
  @Min(1)
  @Max(100)
  allocationPercentage: number;

  /** Complementarity rating for this mapping. */
  @ApiPropertyOptional({ enum: Rating, description: 'Complementarity rating' })
  @IsOptional()
  @IsEnum(Rating)
  complementarityRating?: Rating;

  /** Efficiency rating for this mapping. */
  @ApiPropertyOptional({ enum: Rating, description: 'Efficiency rating' })
  @IsOptional()
  @IsEnum(Rating)
  efficiencyRating?: Rating;
}
