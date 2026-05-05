import { IsOptional, IsEnum } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Rating } from '../enums/rating.enum';

/**
 * DTO for marking agreement on a mapping's current terms.
 *
 * Body is optional for admin / center_rep / workflow_admin / unit_admin —
 * those roles call `POST /mappings/:id/agree` without payload.
 *
 * Required at the SERVICE layer when role=program_rep; optional at DTO
 * level so other roles can call without these. The service throws
 * `BadRequestException` if a program rep submits without both ratings.
 */
export class AgreeDto {
  /** Program rep's complementarity rating for this mapping. */
  @ApiPropertyOptional({
    enum: Rating,
    example: Rating.HIGH,
    description:
      'Complementarity rating (required for program_rep, ignored for other roles)',
  })
  @IsOptional()
  @IsEnum(Rating)
  complementarityRating?: Rating;

  /** Program rep's efficiency rating for this mapping. */
  @ApiPropertyOptional({
    enum: Rating,
    example: Rating.MEDIUM,
    description:
      'Efficiency rating (required for program_rep, ignored for other roles)',
  })
  @IsOptional()
  @IsEnum(Rating)
  efficiencyRating?: Rating;
}
