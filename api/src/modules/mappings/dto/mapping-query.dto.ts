import { IsOptional, IsString, IsInt, IsEnum, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { MappingStatus } from '../enums/mapping-status.enum';

/**
 * DTO for querying the mappings list endpoint.
 *
 * Supports filtering by status, program, project, text search,
 * and offset-based pagination.
 */
export class MappingQueryDto {
  /** Filter by mapping status. */
  @ApiPropertyOptional({ enum: MappingStatus, description: 'Filter by status' })
  @IsOptional()
  @IsEnum(MappingStatus)
  status?: MappingStatus;

  /** Filter by program ID. */
  @ApiPropertyOptional({ description: 'Filter by program ID' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  programId?: number;

  /** Filter by project ID. */
  @ApiPropertyOptional({ description: 'Filter by project ID' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  projectId?: number;

  /** Free-text search by project name. */
  @ApiPropertyOptional({ description: 'Search by project name' })
  @IsOptional()
  @IsString()
  search?: string;

  /** Page number (1-based). Defaults to 1. */
  @ApiPropertyOptional({ default: 1, minimum: 1, description: 'Page number' })
  @IsOptional()
  @Type(() => Number)
  @Min(1)
  page: number = 1;

  /** Number of items per page. Defaults to 20, max 100. */
  @ApiPropertyOptional({
    default: 20,
    minimum: 1,
    maximum: 100,
    description: 'Items per page',
  })
  @IsOptional()
  @Type(() => Number)
  @Min(1)
  @Max(100)
  limit: number = 20;
}
