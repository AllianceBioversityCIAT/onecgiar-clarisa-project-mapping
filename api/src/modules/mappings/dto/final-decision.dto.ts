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
 * One mapping's final allocation in a workflow-admin decision.
 */
export class FinalDecisionItemDto {
  @ApiProperty({ example: 7, description: 'Mapping id (non-removed)' })
  @IsInt()
  @Min(1)
  mappingId: number;

  @ApiProperty({
    example: 60,
    description: 'Final allocation percentage (0-100)',
  })
  @IsNumber()
  @Min(0)
  @Max(100)
  allocationPercentage: number;
}

/**
 * Body for `POST /mappings/projects/:projectId/final-decision`.
 *
 * Workflow-admin-only. After reading the negotiation history the admin
 * imposes a final allocation for every non-removed mapping on the project.
 * The decision overrides whatever was previously agreed/negotiated: each
 * mapping moves to `admin_decision` status (agreed-equivalent) and the
 * project is locked in the same transaction. A single shared justification
 * is recorded on every appended `ADMIN_DECISION` event.
 *
 * The `decisions` list must cover EVERY non-removed mapping exactly once,
 * and the allocations must sum to exactly 100%.
 */
export class FinalDecisionDto {
  @ApiProperty({
    type: [FinalDecisionItemDto],
    description: 'Final allocation for every non-removed mapping on the project.',
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FinalDecisionItemDto)
  decisions: FinalDecisionItemDto[];

  @ApiProperty({
    example:
      'Final decision after review: 60/40 split reflects the agreed scope in the thread.',
    description: 'Reason for the decision, recorded on every mapping (min 10).',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MinLength(10)
  justification: string;
}
