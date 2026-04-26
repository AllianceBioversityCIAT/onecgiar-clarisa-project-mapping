/**
 * ImportError — a single row-level failure returned in both single-file and
 * bulk import responses. Kept as a shared type.
 */
export interface ImportError {
  /** 1-based row number in the source file. */
  row: number;

  /** Optional machine-readable error code from the backend. */
  code?: string;

  /** Human-readable explanation of why this row failed. */
  reason: string;
}

/**
 * ImportResult — legacy shape for the two individual single-file endpoints
 * (POST /admin/imports/project-info and POST /admin/imports/project-data).
 * Retained because it may still be referenced elsewhere.
 */
export interface ImportResult {
  /** Number of new project rows created by the import. */
  created: number;

  /** Number of existing project rows updated by the import. */
  updated: number;

  /** Number of rows that were skipped (no changes needed or missing key). */
  skipped: number;

  /** Rows that could not be processed, with their position and reason. */
  errors: ImportError[];
}

/**
 * UploadState — models the lifecycle of one import card (legacy single-file flow).
 * Used as a discriminated union so the template stays exhaustive.
 */
export type UploadState =
  | { status: 'idle' }
  | { status: 'uploading' }
  | { status: 'done'; result: ImportResult }
  | { status: 'error'; message: string };

// =============================================================================
// Bulk import types — used by POST /admin/imports/bulk
// =============================================================================

/**
 * BulkFileResult — the per-file section of the bulk import response.
 * Each uploaded file gets its own entry in the `files` array.
 */
export interface BulkFileResult {
  /** Original filename as uploaded. */
  filename: string;

  /**
   * File type detected by the backend from the filename.
   * `'unknown'` means the backend could not determine the type.
   */
  type: '4.1' | '4.3' | 'unknown';

  /** Number of project rows created by this file. */
  created: number;

  /** Number of project rows updated by this file. */
  updated: number;

  /** Number of rows skipped (no changes needed or missing key). */
  skipped: number;

  /** Row-level errors encountered while processing this file. */
  errors: ImportError[];
}

/**
 * BulkImportTotals — aggregate counts across all files in a bulk upload.
 */
export interface BulkImportTotals {
  /** How many files were processed (excludes unknown-type files that were rejected). */
  filesProcessed: number;

  /** Total project rows created across all files. */
  created: number;

  /** Total project rows updated across all files. */
  updated: number;

  /** Total rows skipped across all files. */
  skipped: number;

  /** Total row-level errors across all files. */
  errors: number;
}

/**
 * BulkImportResponse — top-level response from POST /admin/imports/bulk.
 */
export interface BulkImportResponse {
  /** Per-file results in the order the backend processed them (4.1 before 4.3). */
  files: BulkFileResult[];

  /** Aggregate totals across all processed files. */
  totals: BulkImportTotals;
}

/**
 * BulkUploadState — discriminated union for the bulk import page lifecycle.
 */
export type BulkUploadState =
  | { status: 'idle' }
  | { status: 'uploading' }
  | { status: 'done'; response: BulkImportResponse }
  | { status: 'error'; message: string };
