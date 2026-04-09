import { ApiProperty } from '@nestjs/swagger';

/**
 * Public DTO for action area data returned by the REST API.
 * Excludes internal fields like syncedAt and timestamps.
 */
export class ActionAreaResponseDto {
  @ApiProperty({ description: 'Internal UUID' })
  id: string;

  @ApiProperty({ description: 'CLARISA identifier' })
  clarisaId: number;

  @ApiProperty({ description: 'Action area name' })
  name: string;

  @ApiProperty({ description: 'Detailed description' })
  description: string;

  @ApiProperty({ description: 'Display color' })
  color: string;
}
