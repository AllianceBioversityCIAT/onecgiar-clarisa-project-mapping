import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { ApiService } from '../../../core/services/api.service';
import {
  AowOption,
  TocAow,
  TocListQuery,
  TocOutcome,
  TocOutput,
  TocPagedResponse,
  TocSyncResult,
} from './toc.model';

/**
 * TocService — HTTP client for the /admin/toc/* REST endpoints.
 *
 * All list methods accept a TocListQuery (programId required; aowId, page,
 * limit and search optional). undefined values are stripped from the query
 * string so the backend uses its own defaults.
 *
 * loadAowOptions() is a convenience wrapper that fetches up to 100 AOWs
 * for a given program and maps them to simple { label, value } pairs
 * suitable for the AOW filter p-select.
 */
@Injectable({ providedIn: 'root' })
export class TocService {
  private readonly api = inject(ApiService);

  // ---------------------------------------------------------------------------
  // List endpoints
  // ---------------------------------------------------------------------------

  /** GET /admin/toc/aows — returns a paginated page of Areas of Work. */
  getAows(query: TocListQuery): Observable<TocPagedResponse<TocAow>> {
    const qs = this.buildParams(query);
    return this.api.get<TocPagedResponse<TocAow>>(`/admin/toc/aows?${qs}`);
  }

  /** GET /admin/toc/outcomes — returns a paginated page of Outcomes. */
  getOutcomes(query: TocListQuery): Observable<TocPagedResponse<TocOutcome>> {
    const qs = this.buildParams(query);
    return this.api.get<TocPagedResponse<TocOutcome>>(`/admin/toc/outcomes?${qs}`);
  }

  /** GET /admin/toc/outputs — returns a paginated page of Outputs. */
  getOutputs(query: TocListQuery): Observable<TocPagedResponse<TocOutput>> {
    const qs = this.buildParams(query);
    return this.api.get<TocPagedResponse<TocOutput>>(`/admin/toc/outputs?${qs}`);
  }

  // ---------------------------------------------------------------------------
  // AOW dropdown source
  // ---------------------------------------------------------------------------

  /**
   * Fetches the first 100 AOWs for a given program and returns them as
   * { label, value } pairs for p-select. 100 is well above the realistic
   * maximum (~62 AOWs spread across all 14 programs).
   */
  loadAowOptions(programId: number): Observable<TocPagedResponse<TocAow>> {
    return this.getAows({ programId, page: 1, limit: 100 });
  }

  // ---------------------------------------------------------------------------
  // Sync
  // ---------------------------------------------------------------------------

  /** POST /admin/sync-toc — triggers a full MEL TOC sync for all programs. */
  syncToc(): Observable<TocSyncResult> {
    return this.api.post<TocSyncResult>('/admin/sync-toc');
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Converts a TocListQuery into a URL query string. undefined and null
   * values are omitted so the backend uses its defaults.
   */
  private buildParams(query: TocListQuery): string {
    const params = new URLSearchParams();

    const set = (key: string, value: string | number | undefined | null): void => {
      if (value !== undefined && value !== null && value !== '') {
        params.set(key, String(value));
      }
    };

    set('programId', query.programId);
    set('aowId', query.aowId);
    set('page', query.page);
    set('limit', query.limit);
    set('search', query.search);

    return params.toString();
  }

  // ---------------------------------------------------------------------------
  // Display helpers (shared between tab components)
  // ---------------------------------------------------------------------------

  /**
   * Maps an array of TocAow to AowOption items for a p-select.
   * Returns an empty array when aows is empty or undefined.
   */
  mapAowsToOptions(aows: TocAow[]): AowOption[] {
    return aows.map((a) => ({
      label: [a.acronym, a.name].filter(Boolean).join(' — ') || a.nodeId,
      value: a.id,
    }));
  }
}
