import { TocLinks } from '../../../core/models/toc.model';

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
  /** True when a program-rep removal request is pending the center's decision. */
  removalRequested: boolean;
  /**
   * True when the mapping's Theory of Change contribution links satisfy the
   * program-side agree gate (≥1 AOW AND (≥1 Output OR ≥1 Intermediate
   * Outcome)). Set by the list endpoint; may be undefined on payloads that
   * don't compute it.
   */
  tocComplete?: boolean;
  /**
   * Hydrated TOC contribution links. Returned by GET /mappings/:id;
   * absent on list payloads that don't hydrate it.
   */
  tocLinks?: TocLinks;
  initiatedBy: { id: number; firstName: string; lastName: string };
  initiatedAt: string;
  createdAt: string;
  updatedAt: string;
}

/** Possible mapping statuses in the negotiation workflow. */
export type MappingStatus = 'draft' | 'negotiating' | 'agreed' | 'removed' | 'admin_decision';

/**
 * Rating values used by program reps when agreeing or counter-proposing.
 * 'high' / 'medium' / 'low' map to complementarity and efficiency dimensions.
 */
export type Rating = 'high' | 'medium' | 'low';

/** Ordered options for PrimeNG p-select rating dropdowns. */
export const RATING_OPTIONS: { label: string; value: Rating }[] = [
  { label: 'High', value: 'high' },
  { label: 'Medium', value: 'medium' },
  { label: 'Low', value: 'low' },
];

/**
 * A single event in the negotiation conversation thread.
 */
export interface MappingNegotiation {
  id: number;
  mappingId: number;
  actor: { id: number; firstName: string; lastName: string };
  actorRole: 'center_rep' | 'program_rep';
  eventType: 'initiated' | 'counter_proposed' | 'agreed' | 'reopened' | 'removed';
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
    complementarityRating: Rating | null;
    efficiencyRating: Rating | null;
  }[];
}

/**
 * DTO for POST /api/mappings (center rep creates a mapping).
 * Both ratings are required — ratings are a center-side responsibility
 * set at create + allocation edit only.
 */
export interface CreateMappingDto {
  projectId: number;
  programId: number;
  allocationPercentage: number;
  complementarityRating: Rating;
  efficiencyRating: Rating;
}

/**
 * DTO for POST /api/mappings/:id/counter-propose. Ratings are not
 * collected here — they are a center-side responsibility set at
 * create + allocation edit only.
 */
export interface CounterProposeDto {
  proposedAllocation: number;
  justification: string;
}

// ---------------------------------------------------------------------------
// Consolidated negotiation view — GET /api/mappings/projects/:id/consolidated
// ---------------------------------------------------------------------------

/**
 * A single unified event in the project-level activity feed.
 *
 * `kind === 'mapping'` — a negotiation action (agree, counter-propose, etc.)
 * `kind === 'message'` — a free-text chat message posted by a user
 */
export interface ConsolidatedEvent {
  id: number;
  kind: 'mapping' | 'message';
  mappingId: number | null;
  programName: string | null;
  actorId: number;
  actorRole: 'center_rep' | 'program_rep' | 'admin';
  actorName: string;
  /** The actor's own program (program reps only) — full name for tooltips. */
  actorProgramName?: string | null;
  /** Official code of the actor's program (compact tag label). */
  actorProgramCode?: string | null;
  eventType: string; // negotiation event type OR 'message'
  proposedPercentage: number | null;
  message: string | null;
  createdAt: string;
}

/**
 * Per-program mapping record within the consolidated view.
 * No per-mapping thread — events are unified in ConsolidatedView.events.
 */
export interface ConsolidatedMapping {
  id: number;
  programId: number;
  programName: string;
  allocationPercentage: number;
  status: MappingStatus;
  centerAgreed: boolean;
  programAgreed: boolean;
  /** True when a workflow admin has been asked to assist with this mapping. */
  needsAssistance: boolean;
  /** ISO timestamp of when the flag was raised; null when not flagged. */
  flaggedAt: string | null;
  /** Complementarity rating set by the center on create / allocation edit (null = not set on legacy rows). */
  complementarityRating: Rating | null;
  /** Efficiency rating set by the center on create / allocation edit (null = not set on legacy rows). */
  efficiencyRating: Rating | null;
  /** True when a program-rep removal request is pending the center's decision. */
  removalRequested: boolean;
  /** Program rep who raised the request; null when no request is pending. */
  removalRequestedById: number | null;
  /** ISO timestamp when the request was raised; null when no request is pending. */
  removalRequestedAt: string | null;
  /** Program rep's stated reason; null when no request is pending. */
  removalJustification: string | null;
  /**
   * TOC contribution links set by the program rep.
   * Present on every ConsolidatedMapping row (backend always hydrates it;
   * empty arrays when no links have been saved yet).
   */
  tocLinks: TocLinks;
}

/**
 * Full response from GET /api/mappings/projects/:id/consolidated.
 *
 * Contains the project header, lock state, allocation totals,
 * the mapping list, and the unified chronological event feed.
 */
export interface ConsolidatedView {
  project: {
    id: number;
    code: string;
    name: string;
    center: { id: number; name: string };
  };
  isLocked: boolean;
  canLock: boolean;
  totalAllocated: number;
  unallocated: number;
  mappings: ConsolidatedMapping[];
  events: ConsolidatedEvent[];
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
