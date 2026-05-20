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
 * Query parameters for `GET /admin/toc/aows`.
 *
 * Paginated listing of AOW rows scoped to a single program. The
 * `programId` filter is **required** — there is no global "list all
 * AOWs" use case in the admin viewer, and forcing the scope keeps
 * the result set bounded.
 *
 * `search` matches case-insensitive against `acronym`,
 * `wp_official_code`, or `name` (LIKE `%term%`).
 *
 * All numeric params arrive as strings on a GET request — the
 * `@Type(() => Number)` casts before validation.
 */
export class TocAowQueryDto {
  /** Required: filter AOWs to the given program. */
  @ApiProperty({ description: 'Program id (FK to programs.id)' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  programId: number;

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
   * Free-text search applied to acronym / wp_official_code / name
   * via `LIKE '%term%'`. Trimmed by the service so leading or
   * trailing whitespace doesn't surprise the user.
   */
  @ApiPropertyOptional({
    description:
      'Search term applied to acronym, wp_official_code, name (LIKE, OR)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;
}
