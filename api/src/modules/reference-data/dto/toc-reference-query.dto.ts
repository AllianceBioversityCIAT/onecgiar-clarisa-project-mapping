import { IsArray, IsInt, IsOptional, Min, ArrayUnique } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Query DTO for the unpaginated `GET /toc/aows`, `/toc/outputs`,
 * `/toc/outcomes` endpoints used by the consolidated negotiation
 * page (any authenticated user — not the admin-only paginated
 * viewer).
 *
 * Datasets are small enough per program (≤ a few dozen rows per
 * table per program) that returning the entire set is cheap and
 * lets the frontend filter / dedupe in memory.
 *
 * `aowIds` is a CSV ("1,2,3") or repeated query param
 * (`?aowIds=1&aowIds=2`); both shapes normalize through the
 * `Transform` below into a deduplicated number[].
 */
export class TocReferenceQueryDto {
  /** Required — filter to a single program. */
  @ApiProperty({ description: 'Program id (FK to programs.id)' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  programId: number;

  /**
   * Optional — filter to one or more AOW ids. Accepts CSV ("1,2") or
   * repeated query params. Empty/missing means "no AOW filter".
   */
  @ApiPropertyOptional({
    type: [Number],
    description:
      'Optional AOW id filter — comma-separated list ("1,2,3") or repeated param',
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === null || value === undefined) return undefined;
    /* Repeated query params come through as string[]; CSV as a single
     * string. Normalise both to a deduplicated number[] and drop any
     * non-numeric tokens — validation below rejects negatives / zero. */
    const raw: string[] = Array.isArray(value)
      ? value
      : typeof value === 'string'
        ? value.split(',')
        : [String(value)];
    const nums = raw
      .map((v) => v.toString().trim())
      .filter((v) => v.length > 0)
      .map((v) => Number(v))
      .filter((n) => Number.isFinite(n));
    return Array.from(new Set(nums));
  })
  @IsArray()
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  aowIds?: number[];
}
