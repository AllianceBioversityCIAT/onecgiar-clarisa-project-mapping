import { ApiProperty } from '@nestjs/swagger';

/**
 * Per-program outcome of a TOC sync run.
 *
 * Either the four counts are populated (success path) or `error`
 * is set (skip path — typically `not_found` for 404 responses).
 */
export class TocSyncProgramDetail {
  @ApiProperty({ description: 'Program official code (e.g. "SP01")' })
  programCode: string;

  @ApiProperty({
    description: 'AOWs upserted for this program',
    required: false,
  })
  aows?: number;

  @ApiProperty({
    description: 'Outcomes (intermediate + portfolio) upserted',
    required: false,
  })
  outcomes?: number;

  @ApiProperty({
    description: 'Outputs upserted for this program',
    required: false,
  })
  outputs?: number;

  @ApiProperty({
    description:
      'Skip reason — populated when the program was skipped (e.g. `not_found`)',
    required: false,
  })
  error?: string;
}

/**
 * Response DTO for the TOC sync operation.
 *
 * `synced` and `failed` are program-level counts; per-program detail
 * (including per-entity upsert counts) is in `details`.
 */
export class TocSyncResultDto {
  @ApiProperty({ description: 'Number of programs synced successfully' })
  synced: number;

  @ApiProperty({ description: 'Number of programs that failed (e.g. 404)' })
  failed: number;

  @ApiProperty({
    description: 'Per-program outcome of the sync run',
    type: [TocSyncProgramDetail],
  })
  details: TocSyncProgramDetail[];
}
