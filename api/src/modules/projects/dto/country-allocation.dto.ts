import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsNumber, Max, Min } from 'class-validator';

/**
 * One row in a project's country allocation list (Location of Benefit
 * or Country of Implementation). The service layer enforces that the
 * sum per project ≤ 100; each row must be > 0.
 *
 * `allocationPercentage` is bounded to (0, 100] at the DTO layer so a
 * single invalid row is rejected before service-level sum validation.
 */
export class CountryAllocationDto {
  @ApiProperty({ description: 'FK to countries.id', example: 12 })
  @Type(() => Number)
  @IsInt()
  countryId: number;

  @ApiProperty({
    description: 'Share of the project attributed to this country (0, 100]',
    example: 50,
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(100)
  allocationPercentage: number;
}
