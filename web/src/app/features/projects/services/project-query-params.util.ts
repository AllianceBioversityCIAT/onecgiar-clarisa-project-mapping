import { HttpParams } from '@angular/common/http';
import { ProjectQuery } from '../models/project.model';

/**
 * Builds an `HttpParams` instance from a `ProjectQuery` object.
 *
 * Extracted as a standalone utility so both `ProjectsService.getProjects()`
 * and `ProjectsExportService.exportList()` stay in perfect lockstep when
 * filter params evolve — only this file needs updating.
 *
 * Rules:
 *  - Falsy values (null, undefined, 0, '') are excluded.
 *  - Boolean flags use literal 'true'/'false' strings (not '1'/'0').
 *  - `programIds` is appended once per ID so the backend receives a
 *    proper array rather than a comma-joined string.
 *  - Pagination keys (`page`, `limit`) and sort keys (`sortField`,
 *    `sortOrder`) are included only when present — callers that need
 *    them set them; callers that do not (e.g. the export service) simply
 *    omit them from the query object they pass in.
 */
export function buildProjectQueryParams(query: Partial<ProjectQuery>): HttpParams {
  let params = new HttpParams();

  if (query.search) params = params.set('search', query.search);
  if (query.centerId) params = params.set('centerId', String(query.centerId));
  if (query.status) params = params.set('status', query.status);
  if (query.fundingSource) params = params.set('fundingSource', query.fundingSource);

  if (query.programIds?.length) {
    for (const id of query.programIds) {
      params = params.append('programIds', String(id));
    }
  }

  if (query.needsAssistance) params = params.set('needsAssistance', 'true');
  if (query.inNegotiation) params = params.set('inNegotiation', 'true');
  if (query.mapped) params = params.set('mapped', 'true');
  if (query.budgetYear) params = params.set('budgetYear', query.budgetYear);

  if (query.startDateFrom) params = params.set('startDateFrom', query.startDateFrom);
  if (query.startDateTo) params = params.set('startDateTo', query.startDateTo);
  if (query.endDateFrom) params = params.set('endDateFrom', query.endDateFrom);
  if (query.endDateTo) params = params.set('endDateTo', query.endDateTo);

  /* Pagination — optional so export callers can skip them. */
  if (query.page != null) params = params.set('page', String(query.page));
  if (query.limit != null) params = params.set('limit', String(query.limit));

  /* Sort — optional. */
  if (query.sortField) params = params.set('sortField', query.sortField);
  if (query.sortOrder) params = params.set('sortOrder', query.sortOrder);

  return params;
}
