import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { HttpParams } from '@angular/common/http';
import { ApiService } from '../../../core/services/api.service';
import {
  Project,
  ProjectListResponse,
  CreateProjectDto,
  ProjectQuery,
} from '../models/project.model';

/**
 * ProjectsService — handles all HTTP interactions with the /api/projects endpoint.
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
      if (query.search)       params = params.set('search', query.search);
      if (query.centerId)     params = params.set('centerId', query.centerId);
      if (query.status)       params = params.set('status', query.status);
      if (query.fundingSource) params = params.set('fundingSource', query.fundingSource);
      if (query.page != null) params = params.set('page', String(query.page));
      if (query.limit != null) params = params.set('limit', String(query.limit));
    }

    const queryString = params.toString();
    const path = queryString ? `/api/projects?${queryString}` : '/api/projects';
    return this.api.get<ProjectListResponse>(path);
  }

  /**
   * Fetches a single project by ID, including center, countries,
   * and mapping summary populated by the API.
   */
  getProject(id: string): Observable<Project> {
    return this.api.get<Project>(`/api/projects/${id}`);
  }

  /**
   * Creates a new project. Admin only (enforced by the API).
   */
  createProject(dto: CreateProjectDto): Observable<Project> {
    return this.api.post<Project>('/api/projects', dto);
  }

  /**
   * Partially updates an existing project. Admin only.
   * Only the fields included in the partial DTO are updated.
   */
  updateProject(id: string, dto: Partial<CreateProjectDto>): Observable<Project> {
    return this.api.patch<Project>(`/api/projects/${id}`, dto);
  }

  /**
   * Soft-deletes (archives) a project by ID. Admin only.
   */
  archiveProject(id: string): Observable<void> {
    return this.api.delete<void>(`/api/projects/${id}`);
  }
}
