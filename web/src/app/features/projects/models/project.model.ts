/**
 * One fiscal-year budget line attached to a project.
 * Mirrors the project_budgets DB table and the backend ProjectBudget entity.
 */
export interface ProjectBudget {
  /** Present on existing rows (used for update diff in the backend). */
  id?: number;
  /** Fiscal year code, e.g. "FY26". */
  year: string;
  /** Budget version label, e.g. "FPC-I". */
  version: string;
  /** Account / cost category description. */
  account: string;
  /** Amount in USD. */
  amount: number;
  /** Optional external reference code (used for idempotent CSV re-import). */
  externalCode?: string;
}

/**
 * Core project entity as returned by the API.
 */
export interface Project {
  id: number;
  code: string;
  name: string;
  description: string;
  summary: string;
  results: string;
  startDate: string;
  endDate: string;
  totalBudget: number;
  remainingBudget: number;
  fundingSource: 'window3' | 'bilateral' | 'srv' | 'other';
  funder: string;
  status: 'draft' | 'active' | 'archived';
  center: { id: number; name: string; acronym: string };
  countries: { id: number; name: string; isoAlpha2: string }[];
  createdAt: string;
  updatedAt: string;

  // --- New optional fields (4.1 Project Info) ---

  /** Name of the funder of the primary center (distinct from the general funder). */
  funderPrimaryCenter?: string;
  /** Classification of the funder's institutional nature. */
  natureOfFunder?: string;
  /** Project category: Restricted or Unrestricted. */
  category?: string;
  /** Cost Sharing Percentage flag. */
  csp?: 'YES' | 'NO';
  /** Reason why CSP was not collected; only set when csp === 'NO'. */
  cspNonCollectionReason?: string;
  /** Total pledge amount (USD), distinct from totalBudget. */
  totalPledge?: number;
  /** Name of the principal investigator. */
  principalInvestigator?: string;
  /** Title of the signed contract. */
  signedContractTitle?: string;

  // --- Budget breakdown (4.3 Project Budget) ---

  /** Repeating fiscal-year budget lines for this project. */
  budgets?: ProjectBudget[];

  /**
   * Number of mappings currently flagged for workflow-admin assistance.
   * Included by the API on list responses; 0 when none are flagged.
   * Present for admin and workflow_admin; may be absent for other roles.
   */
  needsAssistanceMappingCount?: number;

  /**
   * Sum of project_budgets.amount rows for the requested fiscal year (default FY26).
   * Injected by the API on list responses only.
   */
  budget2026?: number;

  /**
   * Sum of allocation_percentage for mappings in status='agreed' only.
   * Negotiating mappings are excluded. May exceed 100 in legacy data.
   * Injected by the API on list responses only.
   */
  agreedAllocatedPercent?: number;

  /**
   * True when the project is unlocked AND has at least one mapping in
   * `negotiating` status. Drives the highlighted "Negotiation" action
   * button on the projects list. Injected by the API on list responses only.
   */
  inActiveNegotiation?: boolean;

  /**
   * Programs currently mapped to the project (excludes `removed` mappings).
   * Drives the program acronym chips in the "Programs" column on the list.
   * Injected by the API on list responses only.
   */
  mappedPrograms?: Array<{
    id: number;
    name: string;
    officialCode: string;
    status: 'draft' | 'negotiating' | 'agreed';
  }>;
}

/**
 * Paginated response envelope for the project list endpoint.
 */
export interface ProjectListResponse {
  data: Project[];
  total: number;
  page: number;
  limit: number;
}

/**
 * DTO for creating or updating a project.
 * remainingBudget and optional text fields may be omitted.
 */
export interface CreateProjectDto {
  code: string;
  name: string;
  description?: string;
  summary?: string;
  results?: string;
  startDate: string;
  endDate: string;
  totalBudget: number;
  remainingBudget?: number;
  fundingSource: string;
  funder?: string;
  /** FK to centers table — integer primary key. */
  centerId: number;
  /** FK to countries table — integer primary keys. */
  countryIds: number[];

  // --- New optional fields (4.1 Project Info) ---
  funderPrimaryCenter?: string;
  natureOfFunder?: string;
  category?: string;
  csp?: 'YES' | 'NO';
  cspNonCollectionReason?: string;
  totalPledge?: number;
  principalInvestigator?: string;
  signedContractTitle?: string;

  // --- Budget breakdown (4.3 Project Budget) ---
  budgets?: ProjectBudget[];
}

/**
 * Query parameters accepted by GET /api/projects.
 */
export interface ProjectQuery {
  search?: string;
  /** Filter by center integer primary key. */
  centerId?: number;
  status?: string;
  fundingSource?: string;
  /**
   * Filter to projects with a non-removed mapping to ANY of these program
   * IDs (OR semantics). Empty / undefined applies no filter.
   */
  programIds?: number[];
  page?: number;
  limit?: number;
  /**
   * When true, returns only projects that have at least one mapping
   * flagged for workflow-admin assistance. Admin and workflow_admin only.
   */
  needsAssistance?: boolean;
  /**
   * When true, returns only projects in active negotiation: unlocked AND
   * with at least one mapping in `negotiating` status. Mirrors the
   * `inActiveNegotiation` per-row flag.
   */
  inNegotiation?: boolean;
  /**
   * When true, returns only projects with at least one agreed mapping.
   * Mirrors the "Mapped %" KPI definition.
   */
  mapped?: boolean;
  /**
   * Fiscal year used to aggregate project_budgets (e.g. 'FY26').
   * Must match regex /^FY\d{2}$/.
   */
  budgetYear?: string;
  /**
   * Column to sort by. Must be one of the values accepted by the API:
   * code | name | startDate | endDate | totalBudget | status | budget2026 | agreedAllocatedPercent
   */
  sortField?: string;
  /** Sort direction — 'ASC' or 'DESC'. */
  sortOrder?: 'ASC' | 'DESC';
  /** Filter to projects whose start_date is on or after this date (YYYY-MM-DD). */
  startDateFrom?: string;
  /** Filter to projects whose start_date is on or before this date (YYYY-MM-DD). */
  startDateTo?: string;
  /** Filter to projects whose end_date is on or after this date (YYYY-MM-DD). */
  endDateFrom?: string;
  /** Filter to projects whose end_date is on or before this date (YYYY-MM-DD). */
  endDateTo?: string;
}

/**
 * Response shape for GET /projects/summary.
 * Provides KPI-level aggregates for the current filter set.
 */
export interface ProjectsSummary {
  /** Fiscal year the budget/mapped figures are scoped to. */
  budgetYear: string;
  /** Count of projects with status='active' (ignores query.status). */
  activeProjectCount: number;
  /** Sum of totalPledge across matching projects (USD). */
  totalPledge: number;
  /** Sum of budget2026 (FY-scoped) across matching projects (USD). */
  totalBudgetYear: number;
  /** Sum of budget2026 across agreed-mapped projects (USD). */
  mappedBudgetYear: number;
  /** mappedBudgetYear / totalBudgetYear × 100, rounded to 1 dp. 0 when totalBudgetYear is 0. */
  mappedPercent: number;
}

/**
 * Number of flagged mappings on a project row, included in list responses.
 * Zero when no mappings are currently flagged for assistance.
 */
export type ProjectWithAssistance = Project & { needsAssistanceMappingCount: number };

// ---------------------------------------------------------------------------
// Unit Admin — constrained metadata edit types
// ---------------------------------------------------------------------------

/**
 * The whitelisted set of project fields that a unit_admin (PPU/PCU) may edit.
 * Mirrors the backend UNIT_ADMIN_EDITABLE_FIELDS constant — any change there
 * must be reflected here so the form gating and payload shaping stay in sync.
 *
 * Excluded: code, centerId, countryIds, status, negotiation_locked, and all
 * Anaplan-sourced fields (funderPrimaryCenter, natureOfFunder, category, csp,
 * cspNonCollectionReason, totalPledge, principalInvestigator, signedContractTitle).
 */
export const UNIT_ADMIN_EDITABLE_FIELDS = [
  'name',
  'description',
  'summary',
  'results',
  'funder',
  'fundingSource',
  'startDate',
  'endDate',
  'totalBudget',
  'remainingBudget',
] as const;

/** Union of the editable field name strings. */
export type UnitAdminEditableField = (typeof UNIT_ADMIN_EDITABLE_FIELDS)[number];

/**
 * Request body shape for PATCH /api/projects/:id/metadata.
 * All metadata fields are optional, but `justification` is required (min 5 chars).
 */
export interface UnitAdminUpdateProjectPayload {
  name?: string;
  description?: string;
  summary?: string;
  results?: string;
  funder?: string;
  fundingSource?: 'window3' | 'bilateral' | 'srv' | 'other';
  startDate?: string;
  endDate?: string;
  totalBudget?: number;
  remainingBudget?: number;
  /** Required by the backend — min 5 chars, explains why the change was made. */
  justification: string;
}

// ---------------------------------------------------------------------------
// Project audit event types
// ---------------------------------------------------------------------------

/**
 * A single row from the project_audit_events table, as returned by
 * GET /api/projects/:id/audit.
 *
 * One row is written per changed field per edit; editing 3 fields produces
 * 3 rows sharing the same `createdAt` timestamp.
 */
export interface ProjectAuditEvent {
  id: number;
  projectId: number;
  actorUserId: number;
  /** Joined user record — always present on API responses. */
  actorUser: {
    id: number;
    email: string;
    firstName: string;
    lastName: string;
    role: string;
  };
  actorRole: 'admin' | 'center_rep' | 'program_rep' | 'workflow_admin' | 'unit_admin';
  eventType: 'field_edited' | 'snapshot_republished';
  /** Camel-case field name, e.g. 'name', 'totalBudget'. Null for snapshot events. */
  fieldName: string | null;
  /** Previous value, JSON-encoded. Type depends on the field. */
  valueBefore: unknown;
  /** New value, JSON-encoded. Type depends on the field. */
  valueAfter: unknown;
  /** Free-text reason given by the editor. */
  justification: string | null;
  /** ISO datetime string, most-recent-first. */
  createdAt: string;
}

/**
 * Paginated response from GET /api/projects/:id/audit.
 */
export interface ProjectAuditResponse {
  data: ProjectAuditEvent[];
  total: number;
  page: number;
  limit: number;
}

/**
 * Response shape for GET /projects/suggested-to-reach-target.
 * Returns a ranked list of project IDs whose mapping would push the
 * agreed-mapped % closest to (or past) the target threshold.
 */
export interface ProjectsSuggestion {
  /** Fiscal year the calculation is scoped to (e.g. "FY26"). */
  budgetYear: string;
  /** Target percentage threshold supplied in the request (e.g. 90). */
  target: number;
  /** Sum of FY-scoped budget across all eligible projects (USD). */
  totalBudgetYear: number;
  /** Sum of budget for already-agreed-mapped projects (USD). */
  currentMappedBudget: number;
  /** currentMappedBudget / totalBudgetYear × 100, rounded to 1 dp. */
  currentMappedPercent: number;
  /** Projected mapped budget after adding the suggested projects. */
  projectedMappedBudget: number;
  /** Projected mapped %, rounded to 1 dp. */
  projectedMappedPercent: number;
  /** Budget amount required to reach the target. */
  targetAmount: number;
  /**
   * Ordered list of project IDs whose mapping would collectively push the
   * mapped % to the target. Ordered by unmapped budget contribution descending.
   * Empty when alreadyAtTarget is true.
   */
  projectIds: number[];
  /** Number of projects in projectIds. */
  suggestionCount: number;
  /** True when currentMappedPercent is already >= target; projectIds will be empty. */
  alreadyAtTarget: boolean;
}
