import { IsInt, IsNumber, Min, Max, IsEnum } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { Rating } from '../enums/rating.enum';

/**
 * DTO for creating a project-to-program mapping.
 *
 * Center representatives specify the project and program explicitly.
 * The mapping is created in `draft` status. Both rating fields are
 * required — ratings are a center-side responsibility set at creation
 * and on subsequent allocation edits.
 */
export class CreateMappingDto {
  /** ID of the project to map. */
  @ApiProperty({ description: 'ID of the project to map' })
  @Type(() => Number)
  @IsInt()
  projectId: number;

  /** ID of the program to map to the project. */
  @ApiProperty({ description: 'ID of the program to map' })
  @Type(() => Number)
  @IsInt()
  programId: number;

  /** Initial allocation percentage (1-100). */
  @ApiProperty({ example: 50, description: 'Allocation percentage (1-100)' })
  @IsNumber()
  @Min(1)
  @Max(100)
  allocationPercentage: number;

  /** Center-set complementarity rating (required). */
  @ApiProperty({
    enum: Rating,
    example: Rating.HIGH,
    description: 'Complementarity rating (required, center-set)',
  })
  @IsEnum(Rating)
  complementarityRating: Rating;

  /** Center-set efficiency rating (required). */
  @ApiProperty({
    enum: Rating,
    example: Rating.MEDIUM,
    description: 'Efficiency rating (required, center-set)',
  })
  @IsEnum(Rating)
  efficiencyRating: Rating;
}
