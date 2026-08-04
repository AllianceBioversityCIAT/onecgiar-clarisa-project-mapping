/**
 * Shape of a single mapping entry stored as JSON inside a PublishedProject row.
 * This is NOT a database entity — it describes the embedded JSON structure.
 */

/**
 * A single Theory of Change node (AOW / Output / Intermediate Outcome)
 * frozen into a published mapping.
 *
 * Denormalised on purpose: the live `toc_*` tables are re-synced from the
 * MEL TOC API and rows can disappear between syncs, so a snapshot that
 * only stored `tocId` would rot. Titles and codes are copied verbatim.
 */
export interface PublishedTocNode {
  /** PK in the source `toc_aows` / `toc_outputs` / `toc_outcomes` table. */
  id: number;
  /** Stable per-program graph identifier (`node_id`). */
  nodeId: string;
  /** Display label — AOW `name`, Output/Outcome `title`. */
  title: string;
  /** Official code where the node has one (AOWs only today). */
  code: string | null;
  /** Output categorization (e.g. "Knowledge product"); null for AOWs/outcomes. */
  type: string | null;
}

/** The TOC contribution a program committed to when agreeing the mapping. */
export interface PublishedTocContribution {
  aows: PublishedTocNode[];
  outputs: PublishedTocNode[];
  /** Intermediate outcomes only — portfolio EOIs are never linked. */
  outcomes: PublishedTocNode[];
}

export interface PublishedMappingData {
  /** Source `programs.id`, so consumers can group across snapshots. */
  programId: number;
  programName: string;
  programCode: string;
  allocationPercentage: number;
  /**
   * The project's total budget weighted by this program's share
   * (`totalBudget * allocationPercentage / 100`), rounded to cents.
   * Precomputed so public consumers never re-derive it inconsistently.
   */
  allocatedBudget: number;
  /**
   * How the mapping reached its terminal state: `agreed` (mutual
   * agreement) or `admin_decision` (workflow-admin final decision).
   */
  status: string;
  complementarityRating: string | null;
  efficiencyRating: string | null;
  /** TOC links attached to this mapping at snapshot time. */
  toc: PublishedTocContribution;
}
