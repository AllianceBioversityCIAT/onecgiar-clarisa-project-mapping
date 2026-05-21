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
    errors: number;
    warnings: number;
  };
  /** Row-level and project-level validation errors. Empty = no hard errors. */
  errors: ImportRowError[];
  /** Non-blocking warnings — surfaced in the UI but do not prevent commit. */
  warnings: ImportRowWarning[];
  preview: {
    toCreate: PreviewCreate[];
    toUpdate: PreviewUpdate[];
    /** Warning: these active mappings are NOT in the file and will be removed on commit. */
    toRemove: PreviewRemove[];
  };
}
