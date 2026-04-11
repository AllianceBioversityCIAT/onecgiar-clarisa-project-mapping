import { ApiProperty } from '@nestjs/swagger';

/**
 * Public DTO for country data returned by the REST API.
 * Excludes internal fields like syncedAt and timestamps.
 */
export class CountryResponseDto {
  @ApiProperty({ description: 'Internal integer ID' })
  id: number;

  @ApiProperty({ description: 'CLARISA numeric code' })
  clarisaId: number;

  @ApiProperty({ description: 'ISO 3166-1 alpha-2 code' })
  isoAlpha2: string;

  @ApiProperty({ description: 'ISO 3166-1 alpha-3 code' })
  isoAlpha3: string;

  @ApiProperty({ description: 'Full country name' })
  name: string;

  @ApiProperty({ description: 'Region name' })
  region: string;
}
