import {
  IsOptional,
  IsString,
  IsInt,
  IsEnum,
  IsBoolean,
  Min,
  Max,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ProjectStatus } from '../enums/project-status.enum';
import { FundingSource } from '../enums/funding-source.enum';

/**
 * DTO for querying the projects list endpoint.
 *
 * Supports text search, filtering by center/status/funding source,
 * and offset-based pagination.
 */
export class ProjectQueryDto {
  /** Free-text search across code, name, and description. */
  @ApiPropertyOptional({
    description: 'Search term (matches code, name, description)',
  })
  @IsOptional()
  @IsString()
  search?: string;

  /** Filter by center ID. */
  @ApiPropertyOptional({ description: 'Filter by center ID' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  centerId?: number;

  /** Filter by project status. */
  @ApiPropertyOptional({ enum: ProjectStatus, description: 'Filter by status' })
  @IsOptional()
  @IsEnum(ProjectStatus)
  status?: ProjectStatus;

  /** Filter by funding source. */
  @ApiPropertyOptional({
    enum: FundingSource,
    description: 'Filter by funding source',
  })
  @IsOptional()
  @IsEnum(FundingSource)
  fundingSource?: FundingSource;

  /** Filter by program ID (reserved for future use when project-program mapping exists). */
  @ApiPropertyOptional({ description: 'Filter by program ID (future use)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  programId?: number;

  /**
   * Filter to only projects that have at least one mapping flagged
   * `needs_assistance`. Admin / workflow_admin only — non-privileged
   * roles get a 403.
   */
  @ApiPropertyOptional({
    description:
      'Show only projects with at least one mapping flagged for workflow-admin assistance (admin/workflow_admin only)',
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    return value;
  })
  @IsBoolean()
  needsAssistance?: boolean;

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
