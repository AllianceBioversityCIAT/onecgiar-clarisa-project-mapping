import { IsInt, IsNumber, Min, Max, IsEnum } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { Rating } from '../enums/rating.enum';

/**
 * DTO for adding a program to a project via the URL-scoped alias
 * `POST /mappings/projects/:projectId/add-program`. `projectId` comes
 * from the URL, so only programId + allocationPercentage + ratings
 * are needed. Both ratings are required — ratings are a center-side
 * responsibility set at creation and on subsequent allocation edits.
 */
export class AddProgramDto {
  @ApiProperty({ description: 'ID of the program to add' })
  @Type(() => Number)
  @IsInt()
  programId: number;

  @ApiProperty({
    example: 25,
    description: 'Initial allocation percentage (1-100)',
  })
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
