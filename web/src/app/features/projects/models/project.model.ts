/**
 * Exclusion record returned on a project list item when the caller is a
 * center_rep requesting showExcluded=true and the project is currently excluded.
 * Null on non-excluded rows or for roles that never see exclusion state.
 */
export interface ProjectExclusion {
  /** Human-readable reason entered by the user who excluded the project. */
  reason: string;
  /** ISO timestamp when the exclusion was created. */
  excludedAt: string;
  /** The user who performed the exclusion. */
  excludedBy: { id: number; firstName: string; lastName: string };
  /** Center that owns the exclusion record. Surfaced so admin viewers can
   *  target the right (project, center) pair on unexclude and show which
   *  center excluded the project in the tooltip. */
  center: { id: number; name: string; acronym: string };
}

/**
 * One row in a project's country-allocation list (Location of Benefit
 * or Country of Implementation). Sum ≤ 100 per list, each row > 0,
 * enforced by the backend.
 *
 * The country object is included on reads so the UI can render the
 * country name without a second lookup; on writes (DTOs) we only send
 * `{ countryId, allocationPercentage }`.
 */
export interface CountryAllocation {
  /** FK to countries.id — the selected country. */
  countryId: number;
  /** Hydrated country reference returned by the API for display. */
  country?: { id: number; name: string; isoAlpha2: string };
  /** Share of the project attributed to this country, in the range (0, 100]. */
  allocationPercentage: number;
}

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
  startDate: string;
  endDate: string;
  totalBudget: number;
  remainingBudget: number;
  fundingSource: 'window3' | 'bilateral' | 'srv' | 'other';
  funder: string;
  status: 'draft' | 'active' | 'archived';
  center: { id: number; name: string; acronym: string };
  /** True when the Location of Benefit list is Global — benefitCountries is empty. */
  isBenefitGlobal: boolean;
  /** True when the Country of Implementation list is Global. Independent of isBenefitGlobal. */
  isImplementationGlobal: boolean;
  /**
   * Location of Benefit — one row per country with allocation %. Sum
   * across rows is ≤ 100. Each row > 0. Empty when isBenefitGlobal is
   * true OR when no countries have been set yet.
   */
  benefitCountries: CountryAllocation[];
  /** Country of Implementation — independent of isBenefitGlobal. Same row shape. */
  implementationCountries: CountryAllocation[];
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
  /** Email of the principal investigator (Anaplan-sourced). */
  email?: string;
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
   * Role-aware negotiation "turn" for the projects-list negotiation icon:
   *   'awaiting_me'    — a live mapping needs the current viewer's action
   *   'awaiting_other' — a live round exists but it's the counterparty's turn
   *   null             — no live negotiation in scope (locked / agreed / none)
   * Center reps key off the center side; program reps off their own program;
   * other roles never get 'awaiting_me'. Injected by the API on list responses.
   */
  negotiationTurn?: 'awaiting_me' | 'awaiting_other' | null;

  /**
   * Derived per-project negotiation classification.
   *   admin_decision — has a workflow-admin final decision (always locked).
   *   locked         — negotiationLocked = true.
   *   in_negotiation — any mapping currently negotiating or agreed (round open).
   *   draft          — only draft mappings exist; nothing opened yet.
   *   none           — no non-removed mappings at all.
   * Injected by the API on list responses only.
   */
  mappingStatus?: 'locked' | 'in_negotiation' | 'draft' | 'none' | 'admin_decision';

  /**
   * Programs currently mapped to the project (excludes `removed` mappings).
   * Drives the program acronym chips in the "Programs" column on the list.
   * Injected by the API on list responses only.
   */
  mappedPrograms?: Array<{
    id: number;
    name: string;
    officialCode: string;
    status: 'draft' | 'negotiating' | 'agreed' | 'admin_decision';
  }>;

  /**
   * Present when the caller is a center_rep with showExcluded=true and this
   * project is currently excluded by their center. Null means not excluded.
   * Absent entirely for all other roles (the API never populates it).
   */
  exclusion?: ProjectExclusion | null;
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
  startDate: string;
  endDate: string;
  totalBudget: number;
  remainingBudget?: number;
  fundingSource: string;
  funder?: string;
  /** FK to centers table — integer primary key. */
  centerId: number;
  /** Location of Benefit is Global; backend ignores benefitCountries when true. */
  isBenefitGlobal?: boolean;
  /** Country of Implementation is Global; backend ignores implementationCountries when true. */
  isImplementationGlobal?: boolean;
  /** Location of Benefit allocations — `[{ countryId, allocationPercentage }]`. */
  benefitCountries?: { countryId: number; allocationPercentage: number }[];
  /** Country of Implementation allocations. Independent of isBenefitGlobal. */
  implementationCountries?: { countryId: number; allocationPercentage: number }[];

  // --- New optional fields (4.1 Project Info) ---
  funderPrimaryCenter?: string;
  natureOfFunder?: string;
  category?: string;
  csp?: 'YES' | 'NO';
  cspNonCollectionReason?: string;
  totalPledge?: number;
  principalInvestigator?: string;
  /** Principal investigator contact email. */
  email?: string;
  signedContractTitle?: string;

  // --- Budget breakdown (4.3 Project Budget) ---
  budgets?: ProjectBudget[];
}

/**
 * Query parameters accepted by GET /api/projects.
 */
/**
 * Available option values for each context-aware filter dropdown on the
 * projects list, returned by `GET /projects/filter-options`. Each list
 * reflects the values present under the user's OTHER active filters, so the
 * dropdowns only offer choices that would actually return projects.
 */
export interface ProjectFilterOptions {
  /** Funding-source enum values present (window3 | bilateral | srv | other). */
  fundingSources: string[];
  /** Owning-center IDs present. */
  centerIds: number[];
  /** Program IDs with at least one non-removed mapping present. */
  programIds: number[];
  /** Non-empty funder names present, alphabetically sorted. */
  funders: string[];
  /** Mapping-status dropdown values that match at least one project. */
  mappingStatuses: string[];
}

export interface ProjectQuery {
  search?: string;
  /** Filter by center integer primary key. */
  centerId?: number;
  status?: string;
  fundingSource?: string;
  /** Filter by funder name (substring match). */
  funder?: string;
  /**
   * Filter to projects with a non-removed mapping to ANY of these program
   * IDs (OR semantics). Empty / undefined applies no filter.
   */
  programIds?: number[];
  page?: number;
  limit?: number;
  /**
   * When true, returns only projects that have at least one mapping
   * flagged for workflow-admin assistance.
   */
  needsAssistance?: boolean;
  /**
   * When true, returns only projects in active negotiation: unlocked AND
   * with at least one mapping in `negotiating` status. Mirrors the
   * `inActiveNegotiation` per-row flag.
   */
  inNegotiation?: boolean;
  /**
   * When true, returns only actively-negotiating projects: unlocked AND at
   * least one mapping in `negotiating` status. STRICT definition matching
   * the dashboard "Negotiating" tile (distinct from the looser
   * `inNegotiation`). Powers the dashboard "Negotiating" card click-through.
   */
  negotiating?: boolean;
  /**
   * When true, returns only projects with at least one agreed mapping.
   * Mirrors the "Mapped %" KPI definition.
   */
  mapped?: boolean;
  /**
   * When true, returns only "ready to lock" projects: unlocked, with at
   * least one mapping, where every non-removed mapping is agreed. Sub-state
   * of inNegotiation; powers the dashboard "Ready to lock" card click-through.
   */
  readyToLock?: boolean;
  /**
   * When true, returns only "partially allocated" projects: at least one
   * non-removed mapping exists but the allocation total is under 100%.
   * Excludes fully-unmapped projects. Orthogonal to the mapping-status
   * buckets; lets the center find projects to top up to 100%.
   */
  partiallyAllocated?: boolean;
  /**
   * When true, returns only projects with at least one active (non-removed)
   * mapping whose TOC contribution is not yet filled (no AOW link, or no
   * Output/Outcome link). Mirrors the program-side agree gate; lets reps
   * find mappings that still need TOC links before they can be agreed.
   */
  missingTocContribution?: boolean;
  /**
   * When true, returns only projects with at least one `agreed` mapping.
   * Program-scoped: for a program rep the match considers only their own
   * program's mapping; admin/center see any program's agreed mapping.
   */
  agreedMapping?: boolean;
  /**
   * When true, returns only projects waiting on the current viewer to act.
   * Role-aware: center rep — a live round the center still owes a response on
   * (or a removal request to resolve); program rep — their mapping awaits
   * their response or is missing TOC data. No-op for admin/no-role.
   */
  needsMyAction?: boolean;
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
  /**
   * When true, include excluded projects in the list response (center_rep only).
   * Excluded rows carry an `exclusion` field with reason, date, and actor.
   * Ignored for all other roles.
   */
  showExcluded?: boolean;

  /**
   * Filter by derived mapping-lifecycle status.
   * admin_decision — has a workflow-admin final decision (always locked).
   * locked         — round has been locked by the center rep.
   * in_negotiation — open round with at least one negotiating/agreed mapping.
   * draft          — only draft mappings (nothing opened yet).
   * none           — no non-removed mappings.
   */
  mappingStatus?: 'locked' | 'in_negotiation' | 'draft' | 'none' | 'admin_decision';

  /**
   * Multi-select mapping-status filter — returns projects that fall into ANY
   * of the supplied buckets (OR semantics). Supersedes `mappingStatus` for the
   * projects-list dropdown. Vocabulary is the full dropdown set, adding the
   * four orthogonal predicate buckets (`negotiating`, `ready_to_lock`,
   * `partially_allocated`, `missing_toc`) on top of the five CASE buckets.
   */
  mappingStatuses?: string[];

  /**
   * When true, the server applies the greedy suggestion algorithm and returns
   * only the suggested projects (paginated). `total` will equal
   * `suggestionCount`. Default ordering is by greedy contribution.
   */
  suggestedOnly?: boolean;

  /**
   * Agreed-allocated % target the suggestion algorithm aims to reach.
   * Defaults to 90 on the server when omitted.
   */
  suggestionTarget?: number;

  /**
   * Fiscal year used by the suggestion algorithm (e.g. 'FY26').
   * Defaults to 'FY26' on the server when omitted.
   */
  suggestionBudgetYear?: string;
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
  /** Sum of budget2026 tied up in `negotiating` (not yet agreed) mappings (USD). */
  inNegotiationBudgetYear: number;
  /** inNegotiationBudgetYear / totalBudgetYear × 100, 1 dp. 0 when total is 0. */
  inNegotiationPercent: number;
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
 * Excluded: code, centerId, startDate, endDate, status, negotiation_locked,
 * and all other Anaplan-sourced fields. Anaplan-owned data is immutable for
 * every role, super-admin included. Both country allocation lists and their
 * Global flags are editable so center reps can correct the geographic scope
 * with a justification.
 */
export const UNIT_ADMIN_EDITABLE_FIELDS = [
  'name',
  'description',
  'summary',
  'totalBudget',
  'remainingBudget',
  'isBenefitGlobal',
  'isImplementationGlobal',
  'benefitCountries',
  'implementationCountries',
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
  totalBudget?: number;
  remainingBudget?: number;
  /** Location of Benefit is Global — when true, backend clears benefitCountries. */
  isBenefitGlobal?: boolean;
  /** Country of Implementation is Global — independent of isBenefitGlobal. */
  isImplementationGlobal?: boolean;
  /** Location of Benefit allocations — ignored when isBenefitGlobal=true. */
  benefitCountries?: { countryId: number; allocationPercentage: number }[];
  /** Country of Implementation allocations — ignored when isImplementationGlobal=true. */
  implementationCountries?: { countryId: number; allocationPercentage: number }[];
  /**
   * Principal investigator name. Editable by admin / center_rep only
   * (NOT unit_admin). Anaplan-authoritative — overwritten on the next
   * CSV import.
   */
  principalInvestigator?: string;
  /** Principal investigator contact email. Same role rules as principalInvestigator. */
  email?: string;
  /** Required by the backend — min 5 chars, explains why the change was made. */
  justification: string;
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
