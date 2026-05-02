import { OmitType } from '@nestjs/swagger';
import { ProjectQueryDto } from './project-query.dto';

/**
 * Query DTO for the Excel export endpoints.
 *
 * Extends `ProjectQueryDto` but removes pagination and sort fields —
 * exports always fetch every matching row (up to EXPORT_MAX_ROWS) in
 * default order, so these fields are irrelevant and would be confusing
 * to accept.
 */
export class ProjectExportQueryDto extends OmitType(ProjectQueryDto, [
  'page',
  'limit',
  'sortField',
  'sortOrder',
] as const) {}
