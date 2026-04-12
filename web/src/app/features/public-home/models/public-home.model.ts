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
}

/** A single program with its published project count, used in summary stats. */
export interface ProgramStat {
  code: string;
  name: string;
  count: number;
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

/** A single program mapping attached to a published project row. */
export interface PublishedProjectMapping {
  programName: string;
  programCode: string;
  allocationPercentage: number;
  complementarityRating: string | null;
  efficiencyRating: string | null;
}

/** A single country reference attached to a published project row. */
export interface PublishedProjectCountry {
  name: string;
  isoAlpha2: string;
}

/**
 * A published project row returned inside the paginated list response.
 * Contains denormalised center/country/mapping data for display-only use.
 */
export interface PublishedProjectItem {
  id: number;
  code: string;
  name: string;
  description: string | null;
  centerName: string;
  centerAcronym: string;
  countries: PublishedProjectCountry[];
  totalBudget: number;
  fundingSource: string | null;
  funder: string | null;
  status: string;
  startDate: string | null;
  endDate: string | null;
  mappings: PublishedProjectMapping[];
}

/**
 * Paginated response envelope returned by GET /published/latest/projects.
 */
export interface PaginatedPublishedProjects {
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
