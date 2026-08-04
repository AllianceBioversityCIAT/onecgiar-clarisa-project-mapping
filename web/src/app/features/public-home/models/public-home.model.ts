/**
 * Models for the public home page — no auth required.
 *
 * These interfaces mirror the shapes returned by the two public endpoints:
 *   GET /published/latest
 *   GET /published/latest/projects
 */

/** A single center with its published project count, used in summary stats. */
export interface CenterStat {
  acronym: string;
  name: string;
  count: number;
  /** Σ project budget for the center. Absent on snapshots published before budgets were rolled up. */
  budget?: number;
}

/** A single program with its published project count, used in summary stats. */
export interface ProgramStat {
  code: string;
  name: string;
  count: number;
  /**
   * Σ (project budget × allocation %) across the program's mappings — the
   * only budget figure meaningful per program, since a raw project-budget
   * sum would double-count a project across its programs. Absent on
   * snapshots published before budgets were rolled up.
   */
  allocatedBudget?: number;
}

/** Aggregate breakdown included in the snapshot summary. */
export interface SnapshotSummaryStats {
  projectsByCenter: CenterStat[];
  projectsByProgram: ProgramStat[];
}

/**
 * The latest published snapshot metadata returned by GET /published/latest.
 * Null is returned by the API when no snapshot has been published yet.
 */
export interface SnapshotSummary {
  id: number;
  versionLabel: string;
  description: string | null;
  publishedAt: string;
  publishedBy: {
    firstName: string;
    lastName: string;
  };
  projectCount: number;
  totalBudget: number;
  summaryStats: SnapshotSummaryStats;
  isActive: boolean;
}

/** A Theory of Change node (AOW / Output / Intermediate Outcome). */
export interface PublishedTocNode {
  id: number;
  nodeId: string;
  title: string;
  code: string | null;
  /** Output categorization (e.g. "Knowledge product"); null otherwise. */
  type: string | null;
}

/** The TOC contribution a program committed to when agreeing the mapping. */
export interface PublishedTocContribution {
  aows: PublishedTocNode[];
  outputs: PublishedTocNode[];
  outcomes: PublishedTocNode[];
}

/**
 * A single program mapping attached to a published project row.
 *
 * `programId` / `allocatedBudget` / `status` / `toc` are absent on
 * snapshots published before the payload was extended — treat as optional
 * when rendering historical snapshots.
 */
export interface PublishedProjectMapping {
  programId?: number;
  programName: string;
  programCode: string;
  allocationPercentage: number;
  /** Project budget × allocation %, precomputed at publish time. */
  allocatedBudget?: number;
  /** `agreed` (mutual) or `admin_decision` (workflow-admin arbitration). */
  status?: string;
  complementarityRating: string | null;
  efficiencyRating: string | null;
  toc?: PublishedTocContribution;
}

/** A single country reference attached to a published project row. */
export interface PublishedProjectCountry {
  name: string;
  isoAlpha2: string;
  /** Share of the project's scope attributed to this country. */
  allocationPercentage: number;
}

/**
 * Payload fields added after the snapshot tables were first created.
 * Null on snapshots published before the `details` column existed.
 */
export interface PublishedProjectDetails {
  summary: string | null;
  category: string | null;
  natureOfFunder: string | null;
  /** True when the project benefits all geographies (so `countries` is empty by design). */
  isBenefitGlobal: boolean;
  isImplementationGlobal: boolean;
  implementationCountries: PublishedProjectCountry[];
}

/**
 * A published project row returned inside the paginated list response.
 * Contains denormalised center/country/mapping data for display-only use.
 *
 * Every project in a snapshot has a locked negotiation round — projects
 * still under negotiation are never published.
 */
export interface PublishedProjectItem {
  id: number;
  code: string;
  name: string;
  description: string | null;
  centerName: string;
  centerAcronym: string;
  /** Location of Benefit. Implementation countries live in `details`. */
  countries: PublishedProjectCountry[];
  totalBudget: number;
  fundingSource: string | null;
  funder: string | null;
  status: string;
  startDate: string | null;
  endDate: string | null;
  mappings: PublishedProjectMapping[];
  details?: PublishedProjectDetails | null;
}

/**
 * Identity of the snapshot a page of published rows was frozen from.
 *
 * Narrower than SnapshotSummary: no publisher (this names a version, not a
 * person) and no summaryStats (too heavy to repeat on every page).
 */
export interface PublishedSnapshotRef {
  id: number;
  versionLabel: string;
  description: string | null;
  publishedAt: string;
  projectCount: number;
  totalBudget: number;
}

/**
 * Paginated response envelope returned by GET /published/latest/projects.
 */
export interface PaginatedPublishedProjects {
  /** Null only when nothing has been published yet (`data` is then empty). */
  snapshot: PublishedSnapshotRef | null;
  data: PublishedProjectItem[];
  total: number;
  page: number;
  limit: number;
}

/** Query parameters accepted by the published projects list endpoint. */
export interface PublishedProjectsParams {
  page?: number;
  limit?: number;
  search?: string;
  center?: string;
}
