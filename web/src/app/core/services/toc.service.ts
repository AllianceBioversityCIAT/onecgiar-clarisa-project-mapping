import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { HttpParams } from '@angular/common/http';
import { ApiService } from './api.service';
import { TocAow, TocOutput, TocOutcome, TocLinks, UpdateTocLinksDto } from '../models/toc.model';

/**
 * TocService — fetches TOC reference data and persists per-mapping TOC links.
 *
 * Cache strategy:
 *  The service maintains a simple in-memory Map keyed by a string derived
 *  from the call parameters (programId for AOWs; programId+sorted-aowIds for
 *  outputs/outcomes). Entries are set on the first successful fetch and
 *  served from memory on subsequent identical calls. The cache lives for
 *  the lifetime of the Angular injector (root-provided), so it persists
 *  across route navigations but is cleared on full page reload.
 *
 *  This avoids re-fetching on every AOW checkbox toggle keystroke while
 *  keeping the implementation simple (no RxJS shareReplay complexity).
 *  Cache is intentionally NOT invalidated after a PATCH /toc-links because
 *  the PATCH modifies the mapping row, not the reference data.
 */
@Injectable({ providedIn: 'root' })
export class TocService {
  private readonly api = inject(ApiService);

  // Simple promise-based caches to deduplicate concurrent + repeated fetches.
  private readonly aowCache = new Map<string, Promise<TocAow[]>>();
  private readonly outputCache = new Map<string, Promise<TocOutput[]>>();
  private readonly outcomeCache = new Map<string, Promise<TocOutcome[]>>();

  // ---------------------------------------------------------------------------
  // AOWs
  // ---------------------------------------------------------------------------

  /**
   * Returns AOWs for the given program, ordered by wp_official_code.
   * Results are cached for the component lifetime.
   */
  getAows(programId: number): Promise<TocAow[]> {
    const key = String(programId);
    if (!this.aowCache.has(key)) {
      const params = new HttpParams().set('programId', String(programId));
      const req = firstValueFrom(this.api.get<TocAow[]>(`/toc/aows?${params.toString()}`)).catch(
        () => [] as TocAow[],
      );
      this.aowCache.set(key, req);
    }
    return this.aowCache.get(key)!;
  }

  // ---------------------------------------------------------------------------
  // Outputs
  // ---------------------------------------------------------------------------

  /**
   * Returns High-Level Outputs for the given program filtered to the
   * specified AOW IDs. Pass an empty array to get all outputs for the
   * program (or skip the call when no AOW is selected — see component).
   *
   * Results are cached per (programId, sorted-aowIds) combo.
   */
  getOutputs(programId: number, aowIds: number[]): Promise<TocOutput[]> {
    const sortedAowIds = [...aowIds].sort((a, b) => a - b);
    const key = `${programId}:${sortedAowIds.join(',')}`;
    if (!this.outputCache.has(key)) {
      let params = new HttpParams().set('programId', String(programId));
      if (sortedAowIds.length > 0) {
        params = params.set('aowIds', sortedAowIds.join(','));
      }
      const req = firstValueFrom(
        this.api.get<TocOutput[]>(`/toc/outputs?${params.toString()}`),
      ).catch(() => [] as TocOutput[]);
      this.outputCache.set(key, req);
    }
    return this.outputCache.get(key)!;
  }

  // ---------------------------------------------------------------------------
  // Outcomes
  // ---------------------------------------------------------------------------

  /**
   * Returns Intermediate Outcomes for the given program filtered to the
   * specified AOW IDs. Backend hardcodes the `intermediate` outcome_type filter.
   *
   * Same caching strategy as getOutputs.
   */
  getOutcomes(programId: number, aowIds: number[]): Promise<TocOutcome[]> {
    const sortedAowIds = [...aowIds].sort((a, b) => a - b);
    const key = `${programId}:${sortedAowIds.join(',')}`;
    if (!this.outcomeCache.has(key)) {
      let params = new HttpParams().set('programId', String(programId));
      if (sortedAowIds.length > 0) {
        params = params.set('aowIds', sortedAowIds.join(','));
      }
      const req = firstValueFrom(
        this.api.get<TocOutcome[]>(`/toc/outcomes?${params.toString()}`),
      ).catch(() => [] as TocOutcome[]);
      this.outcomeCache.set(key, req);
    }
    return this.outcomeCache.get(key)!;
  }

  // ---------------------------------------------------------------------------
  // Persist TOC links
  // ---------------------------------------------------------------------------

  /**
   * Persists the selected TOC links for a mapping.
   * PATCH /mappings/:id/toc-links
   * Returns the updated TocLinks bundle so callers can replace their local state.
   */
  updateTocLinks(mappingId: number, dto: UpdateTocLinksDto): Promise<TocLinks> {
    return firstValueFrom(this.api.patch<TocLinks>(`/mappings/${mappingId}/toc-links`, dto));
  }
}
