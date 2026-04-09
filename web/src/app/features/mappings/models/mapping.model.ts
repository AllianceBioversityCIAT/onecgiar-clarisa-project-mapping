/**
 * Core mapping entity as returned by the API.
 *
 * A mapping represents a program_rep's assertion that their program
 * contributes to a given project, along with optional qualitative ratings.
 * The center_rep for the project's center approves or rejects each mapping.
 */
export interface Mapping {
  id: string;
  project: {
    id: string;
    code: string;
    name: string;
    center?: { id: string; name: string };
  };
  program: {
    id: string;
    officialCode: string;
    name: string;
  };
  allocationPercentage: number;
  complementarityRating: 'high' | 'medium' | 'low' | null;
  efficiencyRating: 'high' | 'medium' | 'low' | null;
  status: 'pending' | 'approved' | 'rejected';
  rejectionReason: string | null;
  submittedBy: { id: string; firstName: string; lastName: string };
  reviewedBy: { id: string; firstName: string; lastName: string } | null;
  submittedAt: string;
  reviewedAt: string | null;
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
 * Allocation summary for a project — returned by GET /api/projects/:id/allocation.
 *
 * Used by the mapping form (to show remaining capacity) and the project
 * detail panel (to render the progress bar and per-program breakdown).
 */
export interface AllocationSummary {
  totalAllocated: number;
  remaining: number;
  isComplete: boolean;
  mappings: {
    programId: string;
    programName: string;
    allocation: number;
    status: string;
  }[];
}

/**
 * DTO for POST /api/mappings.
 * programId is inferred server-side from the authenticated user.
 */
export interface CreateMappingDto {
  projectId: string;
  allocationPercentage: number;
  complementarityRating?: string;
  efficiencyRating?: string;
}

/**
 * DTO for PATCH /api/mappings/:id.
 * All fields are optional — only supplied fields are updated.
 */
export interface UpdateMappingDto {
  allocationPercentage?: number;
  complementarityRating?: string;
  efficiencyRating?: string;
}

/**
 * Query parameters accepted by GET /api/mappings.
 */
export interface MappingQuery {
  status?: string;
  programId?: string;
  projectId?: string;
  search?: string;
  page?: number;
  limit?: number;
}
