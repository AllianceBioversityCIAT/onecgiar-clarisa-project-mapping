import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { ApiService } from '../../../core/services/api.service';
import { environment } from '../../../../environments/environment';

/** A single validation error from the server. */
export interface ImportRowError {
  row: number;
  projectCode: string;
  programCode: string;
  message: string;
}

/**
 * A non-blocking validation warning from the server.
 * Warnings still allow the batch to be committed (e.g. allocation < 100%).
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
  /** Null when the upload omitted a justification (e.g. projects-export shape). */
  justification: string | null;
}

/** Preview item for a mapping that will be updated. */
export interface PreviewUpdate {
  projectCode: string;
  programCode: string;
  currentAllocation: number;
  newAllocation: number;
  complementarityRating: string;
  efficiencyRating: string;
  /** Null when the upload omitted a justification (e.g. projects-export shape). */
  justification: string | null;
}

/** Preview item for a mapping that will be removed. */
export interface PreviewRemove {
  projectCode: string;
  programCode: string;
  currentAllocation: number;
}

/**
 * A project whose detail fields (summary / description / PI) will be
 * overwritten on commit, even when its mappings are unchanged.
 */
export interface PreviewDetailUpdate {
  projectCode: string;
  /** Human-readable names of the fields that will change, e.g. ['Summary']. */
  fields: string[];
}

/**
 * A project excluded from the import because its mappings don't total
 * 100%. Non-blocking for the rest of the batch — the project simply
 * isn't imported.
 */
export interface ImportSkippedProject {
  row: number;
  projectCode: string;
  message: string;
}

/** Summary counts returned by the validate endpoint. */
export interface ImportSummary {
  toCreate: number;
  toUpdate: number;
  toRemove: number;
  /**
   * Mappings already matching the file (same allocation + ratings). Left
   * untouched on commit — counted separately, not reported as updates.
   */
  unchanged: number;
  /** Count of projects whose summary/description/PI fields will change. */
  detailsToUpdate: number;
  errors: number;
  warnings: number;
  /** Count of projects skipped for not reaching 100%. */
  skipped: number;
}

/** Full response from POST /center-imports/mappings/validate */
export interface ValidateImportResponse {
  batchId?: string;
  summary: ImportSummary;
  errors: ImportRowError[];
  warnings: ImportRowWarning[];
  skipped: ImportSkippedProject[];
  preview: {
    toCreate: PreviewCreate[];
    toUpdate: PreviewUpdate[];
    toRemove: PreviewRemove[];
    detailsToUpdate: PreviewDetailUpdate[];
  };
}

/** Result from POST /center-imports/mappings/commit */
export interface CommitResult {
  imported: number;
  removed: number;
  projectsAffected: number;
}

/**
 * Service for the center-rep bulk mappings importer.
 *
 * Thin HTTP wrapper — business logic lives on the server.
 */
@Injectable({ providedIn: 'root' })
export class CenterImportsService {
  private readonly api = inject(ApiService);
  private readonly http = inject(HttpClient);
  private readonly baseUrl = environment.apiUrl;

  /**
   * Download the pre-filled Excel template for the current user's center.
   * Uses HttpClient directly (not ApiService) because we need responseType: 'blob'.
   */
  downloadTemplate(): Observable<Blob> {
    return this.http.get(`${this.baseUrl}/center-imports/mappings/template`, {
      responseType: 'blob',
      withCredentials: true,
    });
  }

  /**
   * Upload an Excel file and receive a validation preview.
   * If errors.length === 0, the response also contains a batchId for commit.
   */
  validate(file: File): Observable<ValidateImportResponse> {
    const formData = new FormData();
    formData.append('file', file);
    return this.api.post<ValidateImportResponse>('/center-imports/mappings/validate', formData);
  }

  /**
   * Commit the import using the batchId returned by validate().
   */
  commit(batchId: string): Observable<CommitResult> {
    return this.api.post<CommitResult>('/center-imports/mappings/commit', {
      batchId,
    });
  }
}
