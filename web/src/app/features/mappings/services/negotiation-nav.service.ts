import { Injectable, signal } from '@angular/core';

/**
 * NegotiationNavService — in-memory "Prev / Next project" navigation cohort.
 *
 * Holds the ordered list of project ids the user was browsing (the FULL
 * filtered/sorted set across all pages, not just the current page) when they
 * clicked into a project's negotiation page. Populated by list-style views
 * (projects list, dashboard "My Negotiations") right before/at navigation
 * time, and read by the negotiation page to render Prev/Next controls.
 *
 * Intentionally NOT persisted to the URL or localStorage — a hard refresh
 * loses the cohort, at which point `hasNav()` returns false and the
 * negotiation page hides the Prev/Next control entirely. Navigation never
 * wraps around (no next after the last id, no prev before the first).
 */
@Injectable({ providedIn: 'root' })
export class NegotiationNavService {
  /** Ordered ids of every project in the source list, across all pages. */
  readonly cohort = signal<number[]>([]);

  /** Human-readable label for where this cohort came from (UI subtitle). */
  readonly sourceLabel = signal<string>('');

  /** Replaces the current cohort. Call this right before/at navigation time. */
  setCohort(ids: number[], sourceLabel = ''): void {
    this.cohort.set(ids);
    this.sourceLabel.set(sourceLabel);
  }

  /** Clears the cohort — e.g. on logout or when leaving the list context. */
  clear(): void {
    this.cohort.set([]);
    this.sourceLabel.set('');
  }

  /** Index of `id` within the cohort, or -1 if absent. */
  indexOf(id: number): number {
    return this.cohort().indexOf(id);
  }

  /** True when `id` is in the cohort AND there's more than one project to navigate between. */
  hasNav(id: number): boolean {
    return this.cohort().length > 1 && this.indexOf(id) !== -1;
  }

  /** Id of the previous project, or null if `id` is absent/first. */
  prevId(id: number): number | null {
    const idx = this.indexOf(id);
    if (idx <= 0) return null;
    return this.cohort()[idx - 1];
  }

  /** Id of the next project, or null if `id` is absent/last. */
  nextId(id: number): number | null {
    const idx = this.indexOf(id);
    if (idx === -1 || idx === this.cohort().length - 1) return null;
    return this.cohort()[idx + 1];
  }

  /** 1-based position of `id` within the cohort, plus the total count. Null if absent. */
  position(id: number): { index: number; total: number } | null {
    const idx = this.indexOf(id);
    if (idx === -1) return null;
    return { index: idx + 1, total: this.cohort().length };
  }
}
