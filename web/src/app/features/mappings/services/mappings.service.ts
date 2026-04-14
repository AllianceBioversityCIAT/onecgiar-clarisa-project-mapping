import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { HttpParams } from '@angular/common/http';
import { ApiService } from '../../../core/services/api.service';
import {
  Mapping,
  MappingListResponse,
  AllocationSummary,
  CreateMappingDto,
  CounterProposeDto,
  MappingQuery,
  NegotiationThreadResponse,
} from '../models/mapping.model';

/**
 * MappingsService — handles all HTTP interactions with the /mappings endpoint.
 *
 * Covers the full negotiation lifecycle: creation by center reps,
 * counter-proposals, agreement tracking, project round locking, and reopening.
 */
@Injectable({ providedIn: 'root' })
export class MappingsService {
  private readonly api = inject(ApiService);

  // -----------------------------------------------------------------------
  // List / detail
  // -----------------------------------------------------------------------

  /** Fetches a paginated, optionally-filtered list of mappings. */
  getMappings(query?: MappingQuery): Observable<MappingListResponse> {
    let params = new HttpParams();

    if (query) {
      if (query.status) params = params.set('status', query.status);
      if (query.programId) params = params.set('programId', String(query.programId));
      if (query.projectId) params = params.set('projectId', String(query.projectId));
      if (query.search) params = params.set('search', query.search);
      if (query.page != null) params = params.set('page', String(query.page));
      if (query.limit != null) params = params.set('limit', String(query.limit));
    }

    const qs = params.toString();
    const path = qs ? `/mappings?${qs}` : '/mappings';
    return this.api.get<MappingListResponse>(path);
  }

  /** Fetches a single mapping by ID. */
  getMapping(id: number): Observable<Mapping> {
    return this.api.get<Mapping>(`/mappings/${id}`);
  }

  /** Fetches the negotiation thread (conversation history) for a mapping. */
  getNegotiationThread(mappingId: number): Observable<NegotiationThreadResponse> {
    return this.api.get<NegotiationThreadResponse>(`/mappings/${mappingId}/negotiations`);
  }

  // -----------------------------------------------------------------------
  // Creation (center_rep)
  // -----------------------------------------------------------------------

  /** Creates a new draft mapping. Center rep only. */
  createMapping(dto: CreateMappingDto): Observable<Mapping> {
    return this.api.post<Mapping>('/mappings', dto);
  }

  // -----------------------------------------------------------------------
  // Negotiation actions
  // -----------------------------------------------------------------------

  /** Opens negotiation on a draft mapping. Center rep only. */
  openNegotiation(mappingId: number): Observable<Mapping> {
    return this.api.post<Mapping>(`/mappings/${mappingId}/open`, {});
  }

  /** Submits a counter-proposal. Center rep or program rep. */
  counterPropose(mappingId: number, dto: CounterProposeDto): Observable<Mapping> {
    return this.api.post<Mapping>(`/mappings/${mappingId}/counter-propose`, dto);
  }

  /** Marks agreement on current terms. Center rep or program rep. */
  agree(mappingId: number): Observable<Mapping> {
    return this.api.post<Mapping>(`/mappings/${mappingId}/agree`, {});
  }

  /** Removes a program from negotiations. Center rep only. */
  removeProgram(mappingId: number): Observable<Mapping> {
    return this.api.post<Mapping>(`/mappings/${mappingId}/remove`, {});
  }

  // -----------------------------------------------------------------------
  // Project-level actions (center_rep)
  // -----------------------------------------------------------------------

  /** Locks the project round — all agreed mappings become locked. */
  lockProjectRound(projectId: number): Observable<Mapping[]> {
    return this.api.post<Mapping[]>(`/mappings/projects/${projectId}/lock`, {});
  }

  /** Reopens a locked project round for re-negotiation. */
  reopenProjectRound(projectId: number): Observable<Mapping[]> {
    return this.api.post<Mapping[]>(`/mappings/projects/${projectId}/reopen`, {});
  }

  // -----------------------------------------------------------------------
  // Allocation helpers
  // -----------------------------------------------------------------------

  /** Returns the current allocation summary for a project. */
  getAllocationSummary(projectId: number): Observable<AllocationSummary> {
    return this.api.get<AllocationSummary>(`/mappings/projects/${projectId}/allocation`);
  }

  /** Returns all mappings for a project (admin/center rep review). */
  getReviewSummary(projectId: number): Observable<Mapping[]> {
    return this.api.get<Mapping[]>(`/mappings/projects/${projectId}/review-summary`);
  }
}
