import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { HttpParams } from '@angular/common/http';
import { ApiService } from '../../../core/services/api.service';
import {
  Mapping,
  MappingListResponse,
  AllocationSummary,
  ConsolidatedView,
  ConsolidatedEvent,
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

  /** Removes a program from negotiations with a justification. Center rep or program rep. */
  removeProgram(mappingId: number, justification: string): Observable<Mapping> {
    return this.api.post<Mapping>(`/mappings/${mappingId}/remove`, { justification });
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

  /**
   * Updates the allocation percentage for a single mapping.
   * PATCH /api/mappings/:id/allocation — body { allocationPercentage }
   */
  updateAllocation(mappingId: number, allocationPercentage: number): Observable<Mapping> {
    return this.api.patch<Mapping>(`/mappings/${mappingId}/allocation`, { allocationPercentage });
  }

  /**
   * Adds a program to an existing project's negotiation round.
   * POST /api/mappings/projects/:projectId/add-program
   */
  addProgram(projectId: number, programId: number, allocationPercentage: number): Observable<Mapping> {
    return this.api.post<Mapping>(`/mappings/projects/${projectId}/add-program`, {
      programId,
      allocationPercentage,
    });
  }

  /** Returns the current allocation summary for a project. */
  getAllocationSummary(projectId: number): Observable<AllocationSummary> {
    return this.api.get<AllocationSummary>(`/mappings/projects/${projectId}/allocation`);
  }

  /** Returns all mappings for a project (admin/center rep review). */
  getReviewSummary(projectId: number): Observable<Mapping[]> {
    return this.api.get<Mapping[]>(`/mappings/projects/${projectId}/review-summary`);
  }

  /**
   * Returns the consolidated negotiation view for a project.
   * Used by ProjectNegotiationConsolidatedComponent as its single data source.
   *
   * GET /api/mappings/projects/:projectId/consolidated
   */
  getConsolidatedNegotiation(projectId: number): Observable<ConsolidatedView> {
    return this.api.get<ConsolidatedView>(`/mappings/projects/${projectId}/consolidated`);
  }

  /**
   * Posts a free-text chat message to the project-level activity feed.
   *
   * POST /api/mappings/projects/:projectId/chat
   * Body: { message: string }
   * Returns: ConsolidatedEvent of kind 'message'
   */
  postChatMessage(projectId: number, message: string): Observable<ConsolidatedEvent> {
    return this.api.post<ConsolidatedEvent>(`/mappings/projects/${projectId}/chat`, { message });
  }
}
