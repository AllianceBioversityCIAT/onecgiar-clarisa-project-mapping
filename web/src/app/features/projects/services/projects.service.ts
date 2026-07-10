import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { ApiService } from '../../../core/services/api.service';
import {
  Project,
  ProjectExclusion,
  ProjectListResponse,
  CreateProjectDto,
  ProjectQuery,
  ProjectsSummary,
  ProjectsSuggestion,
  ProjectFilterOptions,
  UnitAdminUpdateProjectPayload,
} from '../models/project.model';
import { buildProjectQueryParams } from './project-query-params.util';

/**
 * ProjectsService — handles all HTTP interactions with the /projects endpoint.
 *
 * Every method returns an Observable so callers can compose, cancel,
 * or transform the stream as needed.
 */
@Injectable({ providedIn: 'root' })
export class ProjectsService {
  private readonly api = inject(ApiService);

  /**
   * Fetches a paginated, filtered list of projects.
   * All query parameters are optional; omitted keys are not sent to the API.
   */
  getProjects(query?: ProjectQuery): Observable<ProjectListResponse> {
    const params = query ? buildProjectQueryParams(query) : undefined;
    const queryString = params?.toString();
    const path = queryString ? `/projects?${queryString}` : '/projects';
    return this.api.get<ProjectListResponse>(path);
  }

  /**
   * Fetches the ordered ids of EVERY project matching the current
   * filter/sort — across all pages, not just the current one. Powers the
   * in-memory "Prev / Next project" navigation cohort on the negotiation
   * page (see NegotiationNavService). Pagination params are irrelevant here
   * since the backend returns the full matching id set; sort params are
   * still honored so the order matches what the user saw in the list.
   */
  getProjectIds(query?: ProjectQuery): Observable<number[]> {
    const params = query ? buildProjectQueryParams(query) : undefined;
    const queryString = params?.toString();
    const path = queryString ? `/projects/ids?${queryString}` : '/projects/ids';
    return this.api.get<{ ids: number[] }>(path).pipe(map((res) => res.ids));
  }

  /**
   * Fetches a single project by ID, including center, countries,
   * and mapping summary populated by the API.
   */
  getProject(id: number): Observable<Project> {
    return this.api.get<Project>(`/projects/${id}`);
  }

  /**
   * Creates a new project. Admin only (enforced by the API).
   */
  createProject(dto: CreateProjectDto): Observable<Project> {
    return this.api.post<Project>('/projects', dto);
  }

  /**
   * Partially updates an existing project. Admin only.
   * Only the fields included in the partial DTO are updated.
   */
  updateProject(id: number, dto: Partial<CreateProjectDto>): Observable<Project> {
    return this.api.patch<Project>(`/projects/${id}`, dto);
  }

  /**
   * Fetches KPI summary aggregates for the current filter set.
   * Accepts the same filter params as getProjects but without pagination
   * or sort, so the backend counts across all matching projects.
   *
   * @param query Subset of ProjectQuery — page, limit, sortField, sortOrder are excluded.
   */
  getSummary(
    query: Omit<ProjectQuery, 'page' | 'limit' | 'sortField' | 'sortOrder'>,
  ): Observable<ProjectsSummary> {
    const params = buildProjectQueryParams(query);
    const queryString = params.toString();
    const path = queryString ? `/projects/summary?${queryString}` : '/projects/summary';
    return this.api.get<ProjectsSummary>(path);
  }

  /**
   * Fetches suggested projects that, when mapped, would push the agreed-mapped
   * percentage to the given target.
   *
   * Accepts the same filter params as getSummary (no pagination/sort) plus an
   * optional `target` percentage (defaults to 90 on the backend).
   *
   * @param query Filter params plus optional target percentage.
   */
  getSuggested(
    query: Omit<ProjectQuery, 'page' | 'limit' | 'sortField' | 'sortOrder'> & {
      target?: number;
    },
  ): Observable<ProjectsSuggestion> {
    /* Build base filter params then append the suggestion-specific `target`. */
    let params = buildProjectQueryParams(query);
    if (query.target != null) params = params.set('target', String(query.target));
    const queryString = params.toString();
    const path = queryString
      ? `/projects/suggested-to-reach-target?${queryString}`
      : '/projects/suggested-to-reach-target';
    return this.api.get<ProjectsSuggestion>(path);
  }

  /**
   * Fetches the distinct, alphabetically-sorted funder names used to
   * populate the funder filter dropdown on the projects list.
   */
  getFunders(): Observable<string[]> {
    return this.api.get<string[]>('/projects/funders');
  }

  /**
   * Fetches the context-aware option values for every projects-list filter
   * dropdown, given the caller's other active filters. Accepts the same
   * filter params as `getProjects` (pagination/sort ignored). Powers the
   * "only show what's there" dropdowns — each facet reflects the values
   * present under all OTHER active filters.
   */
  getFilterOptions(
    query: Omit<ProjectQuery, 'page' | 'limit' | 'sortField' | 'sortOrder'>,
  ): Observable<ProjectFilterOptions> {
    const params = buildProjectQueryParams(query);
    const queryString = params.toString();
    const path = queryString
      ? `/projects/filter-options?${queryString}`
      : '/projects/filter-options';
    return this.api.get<ProjectFilterOptions>(path);
  }

  /**
   * Soft-deletes (archives) a project by ID. Admin only.
   */
  archiveProject(id: number): Observable<void> {
    return this.api.delete<void>(`/projects/${id}`);
  }

  /**
   * Partially updates the whitelisted metadata fields on a project.
   * Used exclusively by unit_admin (PPU/PCU) and admin via the constrained
   * PATCH /projects/:id/metadata endpoint.
   *
   * A required `justification` is included in the payload so the backend
   * can write an audit row attributing who changed what and why.
   */
  updateMetadata(id: number, payload: UnitAdminUpdateProjectPayload): Observable<Project> {
    return this.api.patch<Project>(`/projects/${id}/metadata`, payload);
  }

  /**
   * Excludes a project from the acting center's default view.
   *
   * Available to center_rep (own center only) and admin.
   * Returns the newly created exclusion record.
   * 409 when the project is already excluded for that center.
   *
   * @param id     Project primary key.
   * @param reason Mandatory reason string (min 5 chars, enforced by the API).
   */
  excludeProject(id: number, reason: string): Observable<ProjectExclusion> {
    return this.api.post<ProjectExclusion>(`/projects/${id}/exclude`, { reason });
  }

  /**
   * Removes an existing exclusion, restoring the project to the center's
   * default view.
   *
   * 404 when no exclusion exists for the (project, center) pair — callers
   * should treat that as "already unexcluded".
   *
   * @param id       Project primary key.
   * @param centerId Admin-only override naming which center's exclusion
   *                 row to remove. Required when an admin is unexcluding a
   *                 project that was excluded by a center other than its
   *                 owning center; ignored by the API for center reps.
   */
  unexcludeProject(id: number, centerId?: number): Observable<{ message: string }> {
    const qs = typeof centerId === 'number' ? `?centerId=${centerId}` : '';
    return this.api.post<{ message: string }>(`/projects/${id}/unexclude${qs}`, {});
  }
}
