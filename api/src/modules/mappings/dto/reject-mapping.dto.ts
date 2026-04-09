import { IsString, IsNotEmpty, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/**
 * DTO for rejecting a project-to-program mapping.
 *
 * Requires a reason with at least 10 characters to ensure
 * meaningful feedback for the program representative.
 */
export class RejectMappingDto {
  /** Reason for rejecting the mapping (minimum 10 characters). */
  @ApiProperty({
    example: 'The allocation does not align with center priorities for this project.',
    description: 'Rejection reason (minimum 10 characters)',
  })
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @IsNotEmpty()
  @MinLength(10)
  reason: string;
}
