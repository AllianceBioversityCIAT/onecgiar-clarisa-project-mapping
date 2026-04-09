import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { HttpParams } from '@angular/common/http';
import { ApiService } from '../../../core/services/api.service';
import {
  Mapping,
  MappingListResponse,
  AllocationSummary,
  CreateMappingDto,
  UpdateMappingDto,
  MappingQuery,
} from '../models/mapping.model';

/**
 * MappingsService — handles all HTTP interactions with the /api/mappings endpoint.
 *
 * Covers CRUD for mappings (program_rep scope) and the approval workflow
 * (center_rep scope), as well as allocation summary helpers used by the
 * mapping form and the project detail panel.
 */
@Injectable({ providedIn: 'root' })
export class MappingsService {
  private readonly api = inject(ApiService);

  // -----------------------------------------------------------------------
  // List / detail
  // -----------------------------------------------------------------------

  /**
   * Fetches a paginated, optionally-filtered list of mappings.
   * The API applies role-based scoping automatically:
   *  - program_rep  → own mappings only
   *  - center_rep   → mappings for their center's projects
   *  - admin        → all mappings
   */
  getMappings(query?: MappingQuery): Observable<MappingListResponse> {
    let params = new HttpParams();

    if (query) {
      if (query.status)    params = params.set('status', query.status);
      if (query.programId) params = params.set('programId', query.programId);
      if (query.projectId) params = params.set('projectId', query.projectId);
      if (query.search)    params = params.set('search', query.search);
      if (query.page != null)  params = params.set('page', String(query.page));
      if (query.limit != null) params = params.set('limit', String(query.limit));
    }

    const qs = params.toString();
    const path = qs ? `/api/mappings?${qs}` : '/api/mappings';
    return this.api.get<MappingListResponse>(path);
  }

  /**
   * Fetches a single mapping by ID, including all related entities.
   */
  getMapping(id: string): Observable<Mapping> {
    return this.api.get<Mapping>(`/api/mappings/${id}`);
  }

  // -----------------------------------------------------------------------
  // Mutations (program_rep)
  // -----------------------------------------------------------------------

  /**
   * Creates a new mapping. The programId is inferred from the authenticated user.
   * program_rep only (enforced by the API).
   */
  createMapping(dto: CreateMappingDto): Observable<Mapping> {
    return this.api.post<Mapping>('/api/mappings', dto);
  }

  /**
   * Partially updates a pending mapping. program_rep, own records only.
   */
  updateMapping(id: string, dto: UpdateMappingDto): Observable<Mapping> {
    return this.api.patch<Mapping>(`/api/mappings/${id}`, dto);
  }

  /**
   * Deletes a pending mapping. program_rep, own records only.
   */
  deleteMapping(id: string): Observable<void> {
    return this.api.delete<void>(`/api/mappings/${id}`);
  }

  // -----------------------------------------------------------------------
  // Approval workflow (center_rep)
  // -----------------------------------------------------------------------

  /**
   * Approves a pending mapping. center_rep only.
   */
  approveMapping(id: string): Observable<Mapping> {
    return this.api.post<Mapping>(`/api/mappings/${id}/approve`, {});
  }

  /**
   * Rejects a pending mapping with a mandatory reason. center_rep only.
   */
  rejectMapping(id: string, reason: string): Observable<Mapping> {
    return this.api.post<Mapping>(`/api/mappings/${id}/reject`, { reason });
  }

  // -----------------------------------------------------------------------
  // Allocation helpers
  // -----------------------------------------------------------------------

  /**
   * Returns the current allocation summary for a project.
   * Used by the mapping form to compute remaining capacity and by the
   * project detail panel to render the allocation progress bar.
   */
  getAllocationSummary(projectId: string): Observable<AllocationSummary> {
    return this.api.get<AllocationSummary>(`/api/projects/${projectId}/allocation`);
  }

  /**
   * Returns all mappings for a project, regardless of status.
   * Used by the project detail review summary panel (Wave 5).
   */
  getReviewSummary(projectId: string): Observable<Mapping[]> {
    return this.api.get<Mapping[]>(`/api/projects/${projectId}/review-summary`);
  }
}
