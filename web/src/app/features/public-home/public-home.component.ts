import {
  Component,
  OnInit,
  inject,
  signal,
  computed,
  ChangeDetectionStrategy,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TableModule, TableLazyLoadEvent } from 'primeng/table';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { SkeletonModule } from 'primeng/skeleton';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { ProgressSpinnerModule } from 'primeng/progressspinner';

import { PublicHomeService } from './services/public-home.service';
import {
  SnapshotSummary,
  PublishedProjectItem,
  CenterStat,
} from './models/public-home.model';

/**
 * PublicHomeComponent — publicly accessible project portfolio page.
 *
 * Rendered at /home outside the authenticated LayoutComponent shell so it
 * has no sidebar or authenticated header. It fetches data from the two public
 * endpoints under /api/published/ and presents:
 *  - A branded PRMS header with a Sign In link
 *  - Three KPI summary cards (project count, total budget, version label)
 *  - A server-side paginated / searchable / filterable p-table of projects
 */
@Component({
  selector: 'app-public-home',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterLink,
    TableModule,
    InputTextModule,
    IconFieldModule,
    InputIconModule,
    SkeletonModule,
    TagModule,
    ButtonModule,
    SelectModule,
    ProgressSpinnerModule,
  ],
  templateUrl: './public-home.component.html',
  styleUrl: './public-home.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PublicHomeComponent implements OnInit {
  private readonly publicHomeService = inject(PublicHomeService);

  // -----------------------------------------------------------------------
  // State signals
  // -----------------------------------------------------------------------

  /** Latest published snapshot metadata; null when none exists yet. */
  readonly snapshot = signal<SnapshotSummary | null>(null);

  /** Current page of published project rows. */
  readonly projects = signal<PublishedProjectItem[]>([]);

  /** Total matching records for the current query (drives p-table paginator). */
  readonly totalRecords = signal<number>(0);

  /** Controls the loading overlay on the table and skeleton cards. */
  readonly loading = signal<boolean>(false);

  /** 1-based page number currently displayed. */
  readonly page = signal<number>(1);

  /** Number of rows per page. */
  readonly rows = signal<number>(20);

  /** Current free-text search term. */
  readonly searchTerm = signal<string>('');

  /** Currently selected center acronym for filtering; empty string = all. */
  readonly selectedCenter = signal<string>('');

  /** Debounce timer handle so rapid keystrokes collapse into one request. */
  private searchDebounce: ReturnType<typeof setTimeout> | null = null;

  // -----------------------------------------------------------------------
  // Derived signals
  // -----------------------------------------------------------------------

  /**
   * Center options for the filter dropdown, derived from the snapshot's
   * projectsByCenter summary stats. Sorted alphabetically by acronym.
   */
  readonly centers = computed<CenterStat[]>(() => {
    const stats = this.snapshot()?.summaryStats?.projectsByCenter ?? [];
    return [...stats].sort((a, b) => a.acronym.localeCompare(b.acronym));
  });

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  ngOnInit(): void {
    this.loadSnapshot();
  }

  // -----------------------------------------------------------------------
  // Data loading
  // -----------------------------------------------------------------------

  /**
   * Fetches the latest snapshot. On success, immediately loads the first
   * page of projects so both pieces of data appear together.
   */
  private loadSnapshot(): void {
    this.loading.set(true);
    this.publicHomeService.getLatestSnapshot().subscribe({
      next: snapshot => {
        this.snapshot.set(snapshot);
        if (snapshot) {
          this.loadProjects();
        } else {
          this.loading.set(false);
        }
      },
      error: () => {
        this.loading.set(false);
      },
    });
  }

  /**
   * Fetches the projects page matching the current filter/search/page state.
   * Always resets loading to false in the finally path.
   */
  loadProjects(): void {
    this.loading.set(true);
    this.publicHomeService
      .getPublishedProjects({
        page: this.page(),
        limit: this.rows(),
        search: this.searchTerm(),
        center: this.selectedCenter(),
      })
      .subscribe({
        next: result => {
          this.projects.set(result.data);
          this.totalRecords.set(result.total);
          this.loading.set(false);
        },
        error: () => {
          this.projects.set([]);
          this.totalRecords.set(0);
          this.loading.set(false);
        },
      });
  }

  // -----------------------------------------------------------------------
  // Table event handlers
  // -----------------------------------------------------------------------

  /**
   * Called by p-table whenever the user pages, sorts, or changes page size.
   * Converts p-table's 0-based `first` offset to a 1-based page number.
   */
  onLazyLoad(event: TableLazyLoadEvent): void {
    const rows = event.rows ?? this.rows();
    const first = event.first ?? 0;
    this.rows.set(rows);
    this.page.set(Math.floor(first / rows) + 1);
    this.loadProjects();
  }

  /**
   * Handles the native `input` event from the search field.
   * Debounces by 400 ms to avoid hammering the API on every keystroke.
   */
  onSearchInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.searchTerm.set(value);

    if (this.searchDebounce) clearTimeout(this.searchDebounce);
    this.searchDebounce = setTimeout(() => {
      this.page.set(1);
      this.loadProjects();
    }, 400);
  }

  /**
   * Called by the center p-select (onChange).
   * `value` is the selected acronym string, or null/undefined when cleared.
   */
  onCenterFilter(value: string | null | undefined): void {
    this.selectedCenter.set(value ?? '');
    this.page.set(1);
    this.loadProjects();
  }

  // -----------------------------------------------------------------------
  // Template helpers
  // -----------------------------------------------------------------------

  /**
   * Returns a comma-separated string of country names for the countries
   * column. Used as a template helper to avoid introducing a custom pipe.
   */
  getCountryNames(countries: { name: string }[]): string {
    if (!countries?.length) return '—';
    return countries.map(c => c.name).join(', ');
  }
}
