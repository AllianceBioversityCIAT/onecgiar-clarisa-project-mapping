import {
  IsNumber,
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEnum,
  Min,
  Max,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Rating } from '../enums/rating.enum';

/**
 * DTO for submitting a counter-proposal on a mapping.
 *
 * Both center reps and program reps can counter-propose.
 * A justification is required to explain the proposed change.
 */
export class CounterProposeDto {
  /** Proposed new allocation percentage (1-100). */
  @ApiProperty({
    example: 55,
    description: 'Proposed allocation percentage (1-100)',
  })
  @IsNumber()
  @Min(1)
  @Max(100)
  proposedAllocation: number;

  /** Written justification for the counter-proposal (minimum 10 characters). */
  @ApiProperty({
    example:
      'Our workplan covers 55% of the deliverables based on the latest scope review.',
    description:
      'Justification for the counter-proposal (minimum 10 characters)',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MinLength(10)
  justification: string;

  /**
   * Program rep's complementarity rating for this mapping.
   *
   * Required at the SERVICE layer when role=program_rep; optional at DTO
   * level so other roles can call without these.
   */
  @ApiPropertyOptional({
    enum: Rating,
    example: Rating.HIGH,
    description:
      'Complementarity rating (required for program_rep, ignored for other roles)',
  })
  @IsOptional()
  @IsEnum(Rating)
  complementarityRating?: Rating;

  /**
   * Program rep's efficiency rating for this mapping.
   *
   * Required at the SERVICE layer when role=program_rep; optional at DTO
   * level so other roles can call without these.
   */
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
