import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';

/**
 * Query DTO for the mapping-history Excel export.
 *
 * A single optional center filter: when present, only mappings whose
 * project belongs to that center are exported; when absent, the export
 * covers every project in the registry.
 */
export class MappingHistoryExportQueryDto {
  @ApiPropertyOptional({ description: 'Restrict the export to one center' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  centerId?: number;
}
