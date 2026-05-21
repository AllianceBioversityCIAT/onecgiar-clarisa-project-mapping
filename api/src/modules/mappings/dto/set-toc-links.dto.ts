import { ArrayUnique, IsArray, IsInt, IsOptional, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Body shape for `PATCH /mappings/:id/toc-links`.
 *
 * Each id list is optional and defaults to empty — callers may send
 * any subset of the three (e.g. only outputs). The service validates
 * that every id belongs to the mapping's program and that outcomes
 * are restricted to `outcome_type='intermediate'`.
 *
 * Submitting an entirely empty payload (all three arrays empty/missing)
 * is a "clear all" operation. The agree() endpoint enforces the
 * non-empty rule — this endpoint accepts empty so the UI can reset
 * the selection before re-picking.
 */
export class SetTocLinksDto {
  /** Area-of-Work ids (`toc_aows.id`). */
  @ApiPropertyOptional({
    type: [Number],
    example: [12, 17],
    description: 'IDs of Areas of Work (toc_aows.id)',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  aowIds?: number[];

  /** Output ids (`toc_outputs.id`). */
  @ApiPropertyOptional({
    type: [Number],
    example: [205, 211],
    description: 'IDs of Outputs (toc_outputs.id)',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  outputIds?: number[];

  /** Intermediate Outcome ids (`toc_outcomes.id`, outcome_type='intermediate'). */
  @ApiPropertyOptional({
    type: [Number],
    example: [302, 305],
    description:
      'IDs of Intermediate Outcomes (toc_outcomes.id, outcome_type=intermediate only)',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  outcomeIds?: number[];
}
