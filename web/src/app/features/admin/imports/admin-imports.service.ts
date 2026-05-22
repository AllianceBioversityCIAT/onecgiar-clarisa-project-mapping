import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

import { environment } from '../../../../environments/environment';
import { BulkImportResponse, ImportResult } from './imports.model';

/**
 * AdminImportsService — HTTP wrapper for the Anaplan-import endpoints.
 *
 * Endpoints accept multipart requests; we drive the upload ourselves via
 * p-fileupload's customUpload mode so we can track state and surface typed
 * responses directly.
 *
 * HttpClient is injected directly (not ApiService) because we send FormData,
 * not JSON.
 */
@Injectable({ providedIn: 'root' })
export class AdminImportsService {
  private readonly http = inject(HttpClient);

  /** Base API URL from the environment (e.g. /api in production). */
  private readonly baseUrl = environment.apiUrl;

  // ---------------------------------------------------------------------------
  // Bulk endpoint (primary — used by the current Imports page)
  // ---------------------------------------------------------------------------

  /**
   * Uploads 1–10 files to the bulk import endpoint.
   *
   * The backend detects each file's type (4.1 / 4.3 / unknown), processes
   * 4.1 files before 4.3, and returns per-file results plus aggregate totals.
   *
   * @param files  Array of files selected by the user via p-fileupload.
   * @returns      Observable of BulkImportResponse from POST /admin/imports/bulk
   */
  uploadBulk(files: File[]): Observable<BulkImportResponse> {
    const fd = new FormData();
    for (const file of files) {
      fd.append('files', file, file.name);
    }
    return this.http.post<BulkImportResponse>(`${this.baseUrl}/admin/imports/bulk`, fd, {
      withCredentials: true,
    });
  }

  // ---------------------------------------------------------------------------
  // Single-file endpoints (legacy — retained for potential future use)
  // ---------------------------------------------------------------------------

  /**
   * Uploads a 4.1 Project Info file and returns the import report.
   *
   * @param file  The file selected by the user via p-fileupload.
   * @returns     Observable of ImportResult from POST /admin/imports/project-info
   */
  uploadProjectInfo(file: File): Observable<ImportResult> {
    return this.http.post<ImportResult>(
      `${this.baseUrl}/admin/imports/project-info`,
      this.buildSingleFileFormData(file),
      { withCredentials: true },
    );
  }

  /**
   * Uploads a 4.3 Project Data file and returns the import report.
   *
   * @param file  The file selected by the user via p-fileupload.
   * @returns     Observable of ImportResult from POST /admin/imports/project-data
   */
  uploadProjectData(file: File): Observable<ImportResult> {
    return this.http.post<ImportResult>(
      `${this.baseUrl}/admin/imports/project-data`,
      this.buildSingleFileFormData(file),
      { withCredentials: true },
    );
  }

  /**
   * Uploads a Location-of-Benefit country allocation file. Existing
   * benefit-country rows are replaced for every project in the file.
   *
   * @param file  CSV/XLSX with "P0 Projects: Code", "Country: Code",
   *              "Country Name", "%" columns.
   */
  uploadCountryBenefit(file: File): Observable<ImportResult> {
    return this.http.post<ImportResult>(
      `${this.baseUrl}/admin/imports/country-benefit`,
      this.buildSingleFileFormData(file),
      { withCredentials: true },
    );
  }

  /**
   * Uploads a Country-of-Implementation allocation file. Existing
   * implementation-country rows are replaced for every project in the
   * file.
   */
  uploadCountryImplementation(file: File): Observable<ImportResult> {
    return this.http.post<ImportResult>(
      `${this.baseUrl}/admin/imports/country-implementation`,
      this.buildSingleFileFormData(file),
      { withCredentials: true },
    );
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Wraps a single file in FormData using the `file` field name expected by the
   * single-file backend endpoints.
   */
  private buildSingleFileFormData(file: File): FormData {
    const fd = new FormData();
    fd.append('file', file, file.name);
    return fd;
  }
}
