import { ApiProperty } from '@nestjs/swagger';

/**
 * Response DTO for the CLARISA sync operation.
 * Returns the count of records upserted per entity type.
 */
export class SyncResultDto {
  @ApiProperty({ description: 'Number of centers synced' })
  centers: number;

  @ApiProperty({ description: 'Number of programs synced' })
  programs: number;

  @ApiProperty({ description: 'Number of countries synced' })
  countries: number;

  @ApiProperty({ description: 'Number of action areas synced' })
  actionAreas: number;
}
