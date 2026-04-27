import { IsOptional, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Query parameters for `GET /projects/:id/audit`.
 *
 * Offset-based pagination over the project_audit_events table — the audit
 * surface is small per project (one row per changed field per edit), so a
 * cursor scheme would be overkill. Limits are kept tighter than the
 * projects list endpoint because the typical UI consumer is a small
 * "history" tab, not a full data grid.
 */
export class ProjectAuditQueryDto {
  /** Page number (1-based). Defaults to 1. */
  @ApiPropertyOptional({ default: 1, minimum: 1, description: 'Page number' })
  @IsOptional()
  @Type(() => Number)
  @Min(1)
  page: number = 1;

  /** Number of items per page. Defaults to 50, max 100. */
  @ApiPropertyOptional({
    default: 50,
    minimum: 1,
    maximum: 100,
    description: 'Items per page',
  })
  @IsOptional()
  @Type(() => Number)
  @Min(1)
  @Max(100)
  limit: number = 50;
}
