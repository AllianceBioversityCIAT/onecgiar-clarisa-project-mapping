import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Query parameters for `GET /admin/toc/outcomes`.
 *
 * Paginated listing of TOC outcome rows (both intermediate and
 * portfolio flavours — distinguished by the `outcomeType` column
 * on the response, not by a filter here).
 *
 * Scoping:
 *  - `programId` is **required** — outcomes are always scoped to a
 *    program in the admin UI.
 *  - `aowId` is **optional** — the consumer can drill from a
 *    program-only view down to a specific AOW. The service performs
 *    no cross-FK validation: an `aowId` that belongs to a different
 *    program simply returns an empty `data` array (liberal behavior
 *    per the spec — the frontend cascade prevents this).
 *
 * `search` matches case-insensitive against `title` only.
 */
export class TocOutcomeQueryDto {
  /** Required: filter outcomes to the given program. */
  @ApiProperty({ description: 'Program id (FK to programs.id)' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  programId: number;

  /**
   * Optional: drill down to a single AOW. This is the numeric
   * `toc_aows.id` PK, NOT the `node_id` string.
   */
  @ApiPropertyOptional({
    description: 'AOW id (FK to toc_aows.id, numeric — NOT node_id)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  aowId?: number;

  /** Page number (1-based). Defaults to 1. */
  @ApiPropertyOptional({ default: 1, minimum: 1, description: 'Page number' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  /** Page size. Defaults to 25, max 100 to bound payload size. */
  @ApiPropertyOptional({
    default: 25,
    minimum: 1,
    maximum: 100,
    description: 'Items per page',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 25;

  /**
   * Free-text search applied to `title` via `LIKE '%term%'`.
   * Trimmed by the service.
   */
  @ApiPropertyOptional({
    description: 'Search term applied to title (LIKE)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;
}
