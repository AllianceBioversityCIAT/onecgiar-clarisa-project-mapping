/**
 * TypeScript interfaces for the TOC (Theory of Change) admin viewer.
 *
 * These mirror the API contract exactly. The backend endpoints are:
 *   GET /admin/toc/aows?programId=&page=&limit=&search=
 *   GET /admin/toc/outcomes?programId=&aowId=&page=&limit=&search=
 *   GET /admin/toc/outputs?programId=&aowId=&page=&limit=&search=
 *   POST /admin/sync-toc
 */

// ---------------------------------------------------------------------------
// Shared paginated response envelope
// ---------------------------------------------------------------------------

export interface TocPagedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

// ---------------------------------------------------------------------------
// Embedded sub-entities
// ---------------------------------------------------------------------------

export interface TocProgram {
  id: number;
  officialCode: string;
  name: string;
}

export interface TocAowRef {
  id: number;
  acronym: string | null;
  name: string | null;
}

// ---------------------------------------------------------------------------
// AOW (Area of Work)
// ---------------------------------------------------------------------------

export interface TocAow {
  id: number;
  nodeId: string;
  clarisaTocId: string | null;
  acronym: string | null;
  wpOfficialCode: string | null;
  name: string | null;
  programId: number;
  program: TocProgram;
  syncedAt: string;
}

// ---------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------

export type OutcomeType = 'intermediate' | 'portfolio';

export interface TocOutcome {
  id: number;
  nodeId: string;
  title: string | null;
  description: string | null;
  outcomeType: OutcomeType;
  relatedNodeId: string | null;
  aowId: number | null;
  aow: TocAowRef | null;
  programId: number;
  program: TocProgram;
  syncedAt: string;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface TocOutput {
  id: number;
  nodeId: string;
  title: string | null;
  description: string | null;
  typeOfOutput: string | null;
  relatedNodeId: string | null;
  aowId: number | null;
  aow: TocAowRef | null;
  programId: number;
  program: TocProgram;
  syncedAt: string;
}

// ---------------------------------------------------------------------------
// Sync response
// ---------------------------------------------------------------------------

export interface TocSyncDetail {
  programCode: string;
  aows?: number;
  outcomes?: number;
  outputs?: number;
  error?: string;
}

export interface TocSyncResult {
  synced: number;
  failed: number;
  details: TocSyncDetail[];
}

// ---------------------------------------------------------------------------
// Query params
// ---------------------------------------------------------------------------

export interface TocListQuery {
  programId: number;
  aowId?: number;
  page?: number;
  limit?: number;
  search?: string;
}

// ---------------------------------------------------------------------------
// Dropdown option for AOW selects (used in Outcomes + Outputs filter bars)
// ---------------------------------------------------------------------------

export interface AowOption {
  label: string;
  value: number;
}
