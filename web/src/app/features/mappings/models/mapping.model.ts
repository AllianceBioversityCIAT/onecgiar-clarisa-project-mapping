/**
 * Core mapping entity as returned by the API.
 *
 * A mapping represents a center rep's assignment of a program to a project
 * with an allocation percentage. The center and program negotiate the
 * allocation until both agree, then the center locks the project round.
 */
export interface Mapping {
  id: number;
  project: {
    id: number;
    code: string;
    name: string;
    center?: { id: number; name: string; acronym?: string };
  };
  program: {
    id: number;
    officialCode: string;
    name: string;
  };
  allocationPercentage: number;
  complementarityRating: 'high' | 'medium' | 'low' | null;
  efficiencyRating: 'high' | 'medium' | 'low' | null;
  status: MappingStatus;
  centerAgreed: boolean;
  programAgreed: boolean;
  initiatedBy: { id: number; firstName: string; lastName: string };
  initiatedAt: string;
  createdAt: string;
  updatedAt: string;
}

/** Possible mapping statuses in the negotiation workflow. */
export type MappingStatus =
  | 'draft'
  | 'negotiating'
  | 'agreed'
  | 'locked'
  | 'removed';

/**
 * A single event in the negotiation conversation thread.
 */
export interface MappingNegotiation {
  id: number;
  mappingId: number;
  actor: { id: number; firstName: string; lastName: string };
  actorRole: 'center_rep' | 'program_rep';
  eventType: 'initiated' | 'counter_proposed' | 'agreed' | 'reopened';
  proposedAllocation: number | null;
  justification: string | null;
  createdAt: string;
}

/**
 * Response from GET /api/mappings/:id/negotiations.
 */
export interface NegotiationThreadResponse {
  mapping: Mapping;
  negotiations: MappingNegotiation[];
}

/**
 * Paginated response envelope for GET /api/mappings.
 */
export interface MappingListResponse {
  data: Mapping[];
  total: number;
  page: number;
  limit: number;
}

/**
 * Allocation summary for a project — returned by GET /api/mappings/projects/:id/allocation.
 */
export interface AllocationSummary {
  totalAllocated: number;
  remaining: number;
  isComplete: boolean;
  isLocked: boolean;
  canLock: boolean;
  mappings: {
    id: number;
    programId: number;
    programName: string;
    allocation: number;
    status: MappingStatus;
    centerAgreed: boolean;
    programAgreed: boolean;
  }[];
}

/**
 * DTO for POST /api/mappings (center rep creates a mapping).
 */
export interface CreateMappingDto {
  projectId: number;
  programId: number;
  allocationPercentage: number;
}

/**
 * DTO for POST /api/mappings/:id/counter-propose.
 */
export interface CounterProposeDto {
  proposedAllocation: number;
  justification: string;
}

/**
 * Query parameters accepted by GET /api/mappings.
 */
export interface MappingQuery {
  status?: string;
  programId?: number;
  projectId?: number;
  search?: string;
  page?: number;
  limit?: number;
}
