import { IsNumber, Min, Max } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * DTO for inline update of a mapping's allocation percentage.
 *
 * Accepts 0-100 inclusive. 0 is permitted so the UI can temporarily
 * zero-out a row while the user reallocates; callers that want a
 * strict >0 constraint should validate at a higher layer.
 */
export class UpdateAllocationDto {
  @ApiProperty({ example: 40, description: 'New allocation percentage (0-100)' })
  @IsNumber()
  @Min(0)
  @Max(100)
  allocationPercentage: number;
}
