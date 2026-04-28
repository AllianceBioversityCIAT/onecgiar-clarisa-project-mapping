import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { HttpParams } from '@angular/common/http';
import { ApiService } from '../../../core/services/api.service';
import {
  Project,
  ProjectListResponse,
  CreateProjectDto,
  ProjectQuery,
  ProjectsSummary,
  ProjectsSuggestion,
  UnitAdminUpdateProjectPayload,
  ProjectAuditResponse,
} from '../models/project.model';

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
    let params = new HttpParams();

    if (query) {
      if (query.search) params = params.set('search', query.search);
      if (query.centerId) params = params.set('centerId', String(query.centerId));
      if (query.status) params = params.set('status', query.status);
      if (query.fundingSource) params = params.set('fundingSource', query.fundingSource);
      // Multi-select programs — append once per ID so the backend sees an array.
      if (query.programIds?.length) {
        for (const id of query.programIds) {
          params = params.append('programIds', String(id));
        }
      }
      if (query.page != null) params = params.set('page', String(query.page));
      if (query.limit != null) params = params.set('limit', String(query.limit));
      // Backend returns 403 for non-admin/workflow_admin — callers must guard accordingly
      if (query.needsAssistance) params = params.set('needsAssistance', 'true');
      if (query.inNegotiation) params = params.set('inNegotiation', 'true');
      if (query.mapped) params = params.set('mapped', 'true');
      if (query.budgetYear) params = params.set('budgetYear', query.budgetYear);
      if (query.sortField) params = params.set('sortField', query.sortField);
      if (query.sortOrder) params = params.set('sortOrder', query.sortOrder);
      if (query.startDateFrom) params = params.set('startDateFrom', query.startDateFrom);
      if (query.startDateTo) params = params.set('startDateTo', query.startDateTo);
      if (query.endDateFrom) params = params.set('endDateFrom', query.endDateFrom);
      if (query.endDateTo) params = params.set('endDateTo', query.endDateTo);
    }

    const queryString = params.toString();
    const path = queryString ? `/projects?${queryString}` : '/projects';
    return this.api.get<ProjectListResponse>(path);
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
    if (query.budgetYear) params = params.set('budgetYear', query.budgetYear);
    if (query.target != null) params = params.set('target', String(query.target));

    const queryString = params.toString();
    const path = queryString
      ? `/projects/suggested-to-reach-target?${queryString}`
      : '/projects/suggested-to-reach-target';
    return this.api.get<ProjectsSuggestion>(path);
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
   * Fetches the paginated audit history for a single project.
   * Accessible to admin, unit_admin, and workflow_admin.
   *
   * Rows are ordered most-recent-first by the API. Default limit is 50
   * (not the 20 used by the projects list) to reduce round-trips on the
   * audit tab — most projects will have <50 edits.
   */
  getAuditHistory(id: number, page = 1, limit = 50): Observable<ProjectAuditResponse> {
    const params = new HttpParams().set('page', String(page)).set('limit', String(limit));
    return this.api.get<ProjectAuditResponse>(`/projects/${id}/audit?${params.toString()}`);
  }
}
