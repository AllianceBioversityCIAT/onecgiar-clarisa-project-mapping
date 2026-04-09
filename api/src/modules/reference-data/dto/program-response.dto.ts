import { ApiProperty } from '@nestjs/swagger';

/**
 * Public DTO for program data returned by the REST API.
 * Excludes internal fields like syncedAt and timestamps.
 */
export class ProgramResponseDto {
  @ApiProperty({ description: 'Internal UUID' })
  id: string;

  @ApiProperty({ description: 'CLARISA identifier' })
  clarisaId: number;

  @ApiProperty({ description: 'Official code (e.g. "INIT-01")' })
  officialCode: string;

  @ApiProperty({ description: 'Full program name' })
  name: string;
}
