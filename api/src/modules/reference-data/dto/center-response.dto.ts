import { ApiProperty } from '@nestjs/swagger';

/**
 * Public DTO for center data returned by the REST API.
 * Excludes internal fields like syncedAt and timestamps.
 */
export class CenterResponseDto {
  @ApiProperty({ description: 'Internal integer ID' })
  id: number;

  @ApiProperty({ description: 'CLARISA identifier' })
  clarisaId: number;

  @ApiProperty({ description: 'Short code (e.g. "CENTER-01")' })
  code: string;

  @ApiProperty({ description: 'Full center name' })
  name: string;

  @ApiProperty({ description: 'Standard acronym (e.g. "CIAT")' })
  acronym: string;
}
