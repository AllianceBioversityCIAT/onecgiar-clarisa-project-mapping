import { IsInt, IsNumber, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/**
 * DTO for adding a program to a project via the URL-scoped alias
 * `POST /mappings/projects/:projectId/add-program`. `projectId` comes
 * from the URL, so only programId + allocationPercentage are needed.
 */
export class AddProgramDto {
  @ApiProperty({ description: 'ID of the program to add' })
  @Type(() => Number)
  @IsInt()
  programId: number;

  @ApiProperty({ example: 25, description: 'Initial allocation percentage (1-100)' })
  @IsNumber()
  @Min(1)
  @Max(100)
  allocationPercentage: number;
}
