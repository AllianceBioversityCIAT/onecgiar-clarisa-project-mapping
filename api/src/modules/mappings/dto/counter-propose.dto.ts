import {
  IsNumber,
  IsString,
  IsNotEmpty,
  Min,
  Max,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/**
 * DTO for submitting a counter-proposal on a mapping.
 *
 * Either side (center or program) may counter-propose. Ratings are
 * intentionally NOT part of this DTO — complementarity and efficiency
 * are a center-side responsibility set at create + allocation edit
 * only, and they remain unchanged across counter-proposals from either
 * party.
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
}
