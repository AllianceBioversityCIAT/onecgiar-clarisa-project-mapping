import {
  IsArray,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsString,
  Max,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/**
 * A single allocation change applied to one of the project's OTHER
 * `negotiating` mappings so the round can reach exactly 100% before the
 * target mapping is agreed. Each carries its own justification, persisted
 * on the appended `COUNTER_PROPOSED` event (min 10 chars, same as a
 * standalone counter-proposal).
 */
export class RebalanceItemDto {
  @ApiProperty({ example: 12, description: 'Mapping id to rebalance' })
  @IsInt()
  @Min(1)
  mappingId: number;

  @ApiProperty({
    example: 50,
    description: 'New allocation percentage (1-100)',
  })
  @IsNumber()
  @Min(1)
  @Max(100)
  allocationPercentage: number;

  @ApiProperty({
    example: 'Rebalanced to 50% so the project totals 100% on agreement.',
    description: 'Justification for the change (min 10 chars)',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MinLength(10)
  justification: string;
}

/**
 * Body for `POST /mappings/projects/:projectId/rebalance-and-agree`.
 *
 * Atomically counter-proposes the listed `negotiating` mappings to new
 * allocations AND agrees the target mapping — used when a center-side
 * agree would otherwise leave the project off 100%. The center adjusts the
 * other in-negotiation mappings so the projected total lands on exactly
 * 100, then this endpoint applies the whole change in one transaction.
 */
export class RebalanceAndAgreeDto {
  @ApiProperty({
    example: 7,
    description: 'The mapping the center is agreeing to.',
  })
  @IsInt()
  @Min(1)
  agreeMappingId: number;

  @ApiProperty({
    type: [RebalanceItemDto],
    description:
      'Allocation changes applied to the project’s other negotiating mappings.',
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RebalanceItemDto)
  rebalances: RebalanceItemDto[];
}
