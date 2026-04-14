import { IsInt, IsNumber, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/**
 * DTO for creating a project-to-program mapping.
 *
 * Center representatives specify the project and program explicitly.
 * The mapping is created in `draft` status.
 */
export class CreateMappingDto {
  /** ID of the project to map. */
  @ApiProperty({ description: 'ID of the project to map' })
  @Type(() => Number)
  @IsInt()
  projectId: number;

  /** ID of the program to map to the project. */
  @ApiProperty({ description: 'ID of the program to map' })
  @Type(() => Number)
  @IsInt()
  programId: number;

  /** Initial allocation percentage (1-100). */
  @ApiProperty({ example: 50, description: 'Allocation percentage (1-100)' })
  @IsNumber()
  @Min(1)
  @Max(100)
  allocationPercentage: number;
}
