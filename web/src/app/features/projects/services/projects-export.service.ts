import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

import { environment } from '../../../../environments/environment';
import { ProjectQuery } from '../models/project.model';
import { buildProjectQueryParams } from './project-query-params.util';

/**
 * Shape returned by this service's public methods.
 *
 * `filename` is parsed from `Content-Disposition` (e.g. "prms-projects-20260428-1430.xlsx").
 * It falls back to a client-generated stamp if the header is absent.
 */
export interface ExportResult {
  blob: Blob;
  filename: string;
}

/**
 * ProjectsExportService — handles Excel file downloads for projects.
 *
 * Both public methods (`exportList`, `exportProject`) use
 * `HttpClient.get` with `{ responseType: 'blob', observe: 'response' }`,
 * parse the filename from `Content-Disposition`, and trigger a browser
 * download via a temporary `<a>` element. The caller receives an
 * Observable so it can drive a loading signal.
 */
@Injectable({ providedIn: 'root' })
export class ProjectsExportService {
  private readonly http = inject(HttpClient);

  /** API base URL from the environment config — used to construct blob request URLs. */
  private readonly baseUrl = environment.apiUrl;

  /**
   * Downloads a filtered project list as an Excel workbook.
   *
   * Passes all currently-active filter params (excluding page/limit/sort)
   * to `GET /projects/export`. Returns an Observable that emits once the
   * blob is ready and the download has been triggered.
   *
   * @param query - The current filter state from the projects list page.
   */
  exportList(
    query: Omit<ProjectQuery, 'page' | 'limit' | 'sortField' | 'sortOrder'>,
  ): Observable<ExportResult> {
    const params = buildProjectQueryParams(query);
    const url = `${this.baseUrl}/projects/export`;

    return this.http
      .get(url, {
        params,
        responseType: 'blob',
        observe: 'response',
        withCredentials: true,
      })
      .pipe(
        map((response) => {
          const blob = response.body as Blob;
          const filename = this.parseFilename(
            response.headers.get('Content-Disposition'),
            `prms-projects-${this.buildTimestamp()}.xlsx`,
          );
          this.triggerDownload(blob, filename);
          return { blob, filename };
        }),
      );
  }

  /**
   * Downloads a single project detail as an Excel workbook.
   *
   * Calls `GET /projects/:id/export`. Returns an Observable that emits
   * once the blob is ready and the download has been triggered.
   *
   * @param id - Project ID.
   */
  exportProject(id: number): Observable<ExportResult> {
    const url = `${this.baseUrl}/projects/${id}/export`;

    return this.http
      .get(url, {
        responseType: 'blob',
        observe: 'response',
        withCredentials: true,
      })
      .pipe(
        map((response) => {
          const blob = response.body as Blob;
          const filename = this.parseFilename(
            response.headers.get('Content-Disposition'),
            `prms-project-${id}-${this.buildTimestamp()}.xlsx`,
          );
          this.triggerDownload(blob, filename);
          return { blob, filename };
        }),
      );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Parses the filename from a `Content-Disposition` header value.
   *
   * Handles the standard `attachment; filename="..."` form. Falls back to
   * `fallback` if the header is absent, malformed, or the filename token
   * is missing.
   *
   * @param header   - Raw Content-Disposition header string, or null.
   * @param fallback - Client-generated fallback filename.
   */
  private parseFilename(header: string | null, fallback: string): string {
    if (!header) return fallback;
    const match = /filename="?([^";]+)"?/i.exec(header);
    return match?.[1]?.trim() || fallback;
  }

  /**
   * Triggers a browser file download for the given blob.
   *
   * Creates a temporary `<a>` element with an object URL, clicks it
   * programmatically, then revokes the URL to release memory.
   *
   * @param blob     - The file content.
   * @param filename - The suggested save filename.
   */
  private triggerDownload(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    // Delay revoke slightly to let the browser initiate the download.
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }

  /**
   * Builds a client-side timestamp suffix for fallback filenames.
   * Format: YYYYMMdd-HHmm
   */
  private buildTimestamp(): string {
    const now = new Date();
    const Y = now.getFullYear();
    const M = String(now.getMonth() + 1).padStart(2, '0');
    const D = String(now.getDate()).padStart(2, '0');
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    return `${Y}${M}${D}-${h}${m}`;
  }
}
