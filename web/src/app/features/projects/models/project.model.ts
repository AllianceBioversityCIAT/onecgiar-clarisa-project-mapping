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
  page?: number;
  limit?: number;
}
