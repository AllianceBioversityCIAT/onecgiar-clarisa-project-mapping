/**
 * Shape of the `details` JSON column on `published_projects`.
 *
 * Everything added to the snapshot payload after the original
 * `CreatePublishedSnapshotTables` migration lives here rather than as new
 * scalar columns — the snapshot is a write-once, read-whole artifact, so
 * the query surface (`code` / `name` / `centerName` / `centerAcronym`)
 * never needs to grow. Keeping additions in one JSON blob means new
 * published fields cost zero migrations from here on.
 *
 * Nullable on the column: rows written before the `details` column
 * existed have no value, and consumers must tolerate that.
 */

/** A country attributed to the project, with its share of the scope. */
export interface PublishedCountryData {
  name: string;
  isoAlpha2: string;
  allocationPercentage: number;
}

export interface PublishedProjectDetails {
  /** Executive summary — distinct from the longer `description` column. */
  summary: string | null;
  /** Funding category (Restricted / Unrestricted). */
  category: string | null;
  /** Nature of the funder (bilateral donor, foundation, …). */
  natureOfFunder: string | null;
  /**
   * True when the project benefits all geographies. Mutually exclusive
   * with a non-empty `countries` list on the row — without this flag a
   * global project is indistinguishable from one with no countries set.
   */
  isBenefitGlobal: boolean;
  /** Same flag for the Country of Implementation list. */
  isImplementationGlobal: boolean;
  /**
   * Country of Implementation. The top-level `countries` column holds
   * Location of Benefit only, which the original snapshot captured;
   * implementation was added to the model later.
   */
  implementationCountries: PublishedCountryData[];
}
