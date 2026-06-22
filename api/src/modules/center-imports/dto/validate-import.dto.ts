/**
 * Represents a single parsed row from the uploaded Excel file.
 * Used internally by the service — not exposed as a request DTO
 * (the request is a multipart file upload, not JSON).
 */
export interface ParsedImportRow {
  /** 1-based row number in the Excel sheet (for error reporting). */
  rowNumber: number;
  projectCode: string;
  /** Resolved DB id after validation. */
  projectId?: number;
  programCode: string;
  /** Resolved DB id after validation. */
  programId?: number;
  allocationPercentage: number;
  complementarityRating: string;
  efficiencyRating: string;
  /** Null when omitted (e.g. projects-export upload has no Justification column). */
  justification: string | null;
  /**
   * Project-level overlay carried alongside each slot row of the same
   * project. Only the projects-export shape populates these; the legacy
   * Mappings sheet leaves them undefined. On commit, the first row per
   * project drives the project overwrite (all rows for the same project
   * carry identical values).
   *
   * - `null` = blank cell → leave the existing project value untouched.
   * - non-null string = overwrite `project.description` / `project.summary`.
   */
  projectDescription?: string | null;
  projectSummary?: string | null;
  /**
   * Principal-investigator overlays, same semantics as description/summary:
   * `null` = blank cell → leave the existing project value untouched;
   * non-null string = overwrite `project.principalInvestigator` / `project.email`.
   * Only the projects-export shape populates these (appended end columns).
   */
  projectPrincipalInvestigator?: string | null;
  projectPrincipalInvestigatorEmail?: string | null;
  /**
   * True for a synthetic per-project row emitted when the projects-export
   * carries Description/Summary/PI edits for a project that has NO program
   * slots. The row exists only to carry the detail overlay through to
   * commit. It is excluded from every mapping concern — the cap check, the
   * 100% allocation gate, create/update classification, and removal
   * detection — so a detail-only edit never touches the project's mappings
   * or negotiation state.
   */
  detailOnly?: boolean;
}

/** A single validation error tied to a specific row. */
export interface ImportRowError {
  row: number;
  projectCode: string;
  programCode: string;
  message: string;
}

/**
 * A non-blocking validation warning tied to a specific row.
 * Warnings still allow a batchId to be issued — the commit endpoint accepts them.
 * Example: a project whose allocations sum to less than 100%.
 */
export interface ImportRowWarning {
  row: number;
  projectCode: string;
  programCode: string;
  message: string;
}

/**
 * A project whose rows were excluded from the import. The project does
 * not meet a hard precondition (currently: its mappings do not total
 * 100%), so none of its rows are created/updated/removed — but the rest
 * of the batch still proceeds. Surfaced to the user as an error-level
 * notice that the project was skipped.
 */
export interface ImportSkippedProject {
  row: number;
  projectCode: string;
  message: string;
}

/** Preview item for a mapping that will be created. */
export interface PreviewCreate {
  projectCode: string;
  programCode: string;
  allocationPercentage: number;
  complementarityRating: string;
  efficiencyRating: string;
  justification: string | null;
}

/** Preview item for a mapping that will have its values updated. */
export interface PreviewUpdate {
  projectCode: string;
  programCode: string;
  currentAllocation: number;
  newAllocation: number;
  complementarityRating: string;
  efficiencyRating: string;
  justification: string | null;
}

/** Preview item for a mapping that will be removed (active in DB but not in file). */
export interface PreviewRemove {
  projectCode: string;
  programCode: string;
  currentAllocation: number;
}

/**
 * Preview item for a project whose detail fields (summary / description /
 * principal investigator) will be overwritten on commit — independent of
 * whether any of its mappings change. Surfaced so a summary-only re-import
 * (mappings all "unchanged") still shows that something will happen.
 */
export interface PreviewDetailUpdate {
  projectCode: string;
  /** Human-readable names of the fields that will change, e.g. ['Summary']. */
  fields: string[];
}

/** Full response shape for POST /center-imports/mappings/validate */
export interface ValidateImportResponse {
  /**
   * Present when there are no hard errors. Warnings (e.g. sum < 100%) do NOT
   * block the batchId — the commit endpoint accepts a batch with warnings.
   */
  batchId?: string;
  summary: {
    toCreate: number;
    toUpdate: number;
    toRemove: number;
    /**
     * Mappings already matching the file (same allocation + ratings). These
     * are left completely untouched on commit — no negotiation state reset —
     * so they are reported separately rather than as updates.
     */
    unchanged: number;
    /** Count of projects whose summary/description/PI fields will change. */
    detailsToUpdate: number;
    errors: number;
    warnings: number;
    /** Count of projects excluded because they don't total 100%. */
    skipped: number;
  };
  /** Row-level and project-level validation errors. Empty = no hard errors. */
  errors: ImportRowError[];
  /** Non-blocking warnings — surfaced in the UI but do not prevent commit. */
  warnings: ImportRowWarning[];
  /**
   * Projects excluded from the import because they don't reach 100%
   * allocation. Non-blocking for the rest of the batch — the listed
   * projects simply aren't imported.
   */
  skipped: ImportSkippedProject[];
  preview: {
    toCreate: PreviewCreate[];
    toUpdate: PreviewUpdate[];
    /** Warning: these active mappings are NOT in the file and will be removed on commit. */
    toRemove: PreviewRemove[];
    /** Projects whose summary/description/PI fields will be overwritten. */
    detailsToUpdate: PreviewDetailUpdate[];
  };
}
