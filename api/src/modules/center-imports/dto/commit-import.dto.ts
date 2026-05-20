import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** DTO for POST /center-imports/mappings/commit */
export class CommitImportDto {
  /**
   * The batchId JWT returned by the validate endpoint.
   * The server uses this to retrieve the pre-parsed rows from the
   * in-memory session cache and verifies it has not expired.
   */
  @ApiProperty({
    description: 'JWT batch token returned by the validate endpoint',
  })
  @IsString()
  @IsNotEmpty()
  batchId: string;
}
