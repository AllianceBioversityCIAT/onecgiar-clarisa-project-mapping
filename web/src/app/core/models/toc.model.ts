/**
 * TOC (Theory of Change) data models.
 *
 * These types mirror the backend entities in toc_aows, toc_outputs, toc_outcomes.
 * All three are fetched via the /toc/* endpoints and composed in the
 * TocContributionComponent to let program reps link their mapping to
 * specific TOC nodes.
 */

/** An Area of Work (AOW) from the MEL TOC API. */
export interface TocAow {
  id: number;
  /** Full node ID from the WP graph (e.g. "SP01-WP1"). */
  nodeId: string;
  /** Short code in SP01-AOW03 format (used as the primary option label). */
  wpOfficialCode: string;
  /** Human-readable acronym (e.g. "AgroEcology"). */
  acronym: string;
  /** Full display name. */
  name: string;
  programId: number;
}

/** A High-Level Output (HLO) from the MEL TOC API. */
export interface TocOutput {
  id: number;
  nodeId: string;
  title: string;
  typeOfOutput: string | null;
  /** FK to toc_aows; null when the AOW couldn't be resolved. */
  aowId: number | null;
  programId: number;
}

/** An Intermediate Outcome (IOC) from the MEL TOC API. */
export interface TocOutcome {
  id: number;
  nodeId: string;
  title: string;
  /** FK to toc_aows; null when the AOW couldn't be resolved. */
  aowId: number | null;
  programId: number;
}

/**
 * The resolved TOC link bundle attached to a mapping in the consolidated view.
 * Shape matches what the backend returns on every ConsolidatedMapping row.
 */
export interface TocLinks {
  aows: TocAow[];
  outputs: TocOutput[];
  outcomes: TocOutcome[];
}

/**
 * Body for PATCH /mappings/:id/toc-links.
 */
export interface UpdateTocLinksDto {
  aowIds: number[];
  outputIds: number[];
  outcomeIds: number[];
}
