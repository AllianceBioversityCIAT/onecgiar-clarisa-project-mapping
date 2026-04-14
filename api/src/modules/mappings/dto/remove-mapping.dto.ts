import { IsString, IsNotEmpty, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/**
 * DTO for removing a program from the negotiation.
 *
 * Both center rep and program rep can remove the mapping;
 * a justification is required to explain the reason.
 */
export class RemoveMappingDto {
  /** Written justification for removing the program (minimum 10 characters). */
  @ApiProperty({
    example: 'Program scope no longer aligns with project deliverables.',
    description: 'Justification for removal (minimum 10 characters)',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MinLength(10)
  justification: string;
}
