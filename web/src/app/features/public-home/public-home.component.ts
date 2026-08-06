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
import { Router, RouterLink } from '@angular/router';
import { TableModule, TableLazyLoadEvent } from 'primeng/table';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { SkeletonModule } from 'primeng/skeleton';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { DialogModule } from 'primeng/dialog';
import { TooltipModule } from 'primeng/tooltip';

import { HeaderComponent } from '../../layout/header/header.component';
import { PublicHomeService } from './services/public-home.service';
import {
  SnapshotSummary,
  PublishedProjectItem,
  PublishedProjectMapping,
  PublishedProjectCountry,
  PublishedVersion,
  CenterStat,
  ProgramStat,
} from './models/public-home.model';

/**
 * PublicHomeComponent — publicly accessible project portfolio page.
 *
 * Rendered at /home outside the authenticated LayoutComponent shell so it
 * has no sidebar or authenticated header. It fetches data from the public
 * endpoints under /api/published/ and presents:
 *  - A branded PRMS header with a Sign In link
 *  - The active version stamp, with the full version history in a dialog
 *  - KPI summary cards (projects, budget, centers, programs)
 *  - The snapshot's per-center and per-program breakdowns
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
    DialogModule,
    TooltipModule,
    HeaderComponent,
  ],
  templateUrl: './public-home.component.html',
  styleUrl: './public-home.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PublicHomeComponent implements OnInit {
  private readonly publicHomeService = inject(PublicHomeService);
  private readonly router = inject(Router);

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

  /** Every published version, newest first. Loaded once alongside the snapshot. */
  readonly versions = signal<PublishedVersion[]>([]);

  /** Controls the version-history dialog. */
  readonly versionsDialogVisible = signal<boolean>(false);

  /** Collapsible state of the per-center / per-program breakdown panels. */
  readonly breakdownExpanded = signal<boolean>(false);

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

  /** Per-center breakdown, largest portfolio first. */
  readonly centerBreakdown = computed<CenterStat[]>(() => {
    const stats = this.snapshot()?.summaryStats?.projectsByCenter ?? [];
    return [...stats].sort((a, b) => b.count - a.count || a.acronym.localeCompare(b.acronym));
  });

  /** Per-program breakdown, largest portfolio first. */
  readonly programBreakdown = computed<ProgramStat[]>(() => {
    const stats = this.snapshot()?.summaryStats?.projectsByProgram ?? [];
    return [...stats].sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
  });

  /** Distinct centers represented in the published portfolio. */
  readonly centerCount = computed<number>(() => this.centerBreakdown().length);

  /** Distinct programs/accelerators represented in the published portfolio. */
  readonly programCount = computed<number>(() => this.programBreakdown().length);

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  ngOnInit(): void {
    this.loadSnapshot();
    this.loadVersions();
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
      next: (snapshot) => {
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
   * Fetches the version index for the history dialog. Failure is silent —
   * the history is supplementary, and the portfolio still renders without it.
   */
  private loadVersions(): void {
    this.publicHomeService.listVersions().subscribe({
      next: (versions) => this.versions.set(versions),
      error: () => this.versions.set([]),
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
        next: (result) => {
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
    return countries.map((c) => c.name).join(', ');
  }

  /**
   * Country label for the list column. A globally-scoped project has an
   * empty country list by design, so the flag has to be read before falling
   * back to the em dash — otherwise "global" reads as "nothing recorded".
   */
  countriesLabel(project: PublishedProjectItem): string {
    if (project.details?.isBenefitGlobal) return 'Global';
    return this.getCountryNames(project.countries);
  }

  /** Whether the row's benefit scope is global (drives the chip styling). */
  isGlobal(project: PublishedProjectItem): boolean {
    return !!project.details?.isBenefitGlobal;
  }

  /** Format a funding source enum value (`window3` → `Window 3`). */
  formatFundingSource(value: string | null | undefined): string {
    if (!value) return '—';
    return value
      .replace(/_/g, ' ')
      .replace(/([a-z])(\d)/g, '$1 $2')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Compact `2024 – 2027` timeline label for the list column. */
  timelineLabel(project: PublishedProjectItem): string {
    const year = (value: string | null) => (value ? new Date(value).getFullYear() : null);
    const start = year(project.startDate);
    const end = year(project.endDate);
    if (!start && !end) return '—';
    return `${start ?? '?'} – ${end ?? '?'}`;
  }

  /**
   * Tooltip for a program chip: the full program name plus the budget share
   * the snapshot precomputed for it (absent on pre-extension snapshots).
   */
  mappingTooltip(mapping: PublishedProjectMapping): string {
    const parts = [mapping.programName];
    if (mapping.allocatedBudget != null) {
      parts.push(
        `${mapping.allocationPercentage}% — ${mapping.allocatedBudget.toLocaleString('en-US', {
          style: 'currency',
          currency: 'USD',
          maximumFractionDigits: 0,
        })}`,
      );
    }
    if (mapping.status === 'admin_decision') parts.push('Set by workflow-admin decision');
    return parts.join('\n');
  }

  /**
   * Hover text for the countries cell — each country with its share of the
   * project's scope, which the truncated cell itself has no room for.
   */
  countriesTooltip(project: PublishedProjectItem): string {
    if (project.details?.isBenefitGlobal) return 'Benefits all geographies';
    const countries: PublishedProjectCountry[] = project.countries ?? [];
    if (!countries.length) return 'No countries recorded';
    return countries
      .map((c) => (c.allocationPercentage ? `${c.name} (${c.allocationPercentage}%)` : c.name))
      .join('\n');
  }

  /**
   * Publisher display name, or '' when there is nothing to show — the
   * account may be gone, or carry no first/last name at all, and
   * "published by <blank>" reads worse than omitting the attribution.
   */
  publisherName(person: { firstName: string; lastName: string } | null): string {
    if (!person) return '';
    return `${person.firstName ?? ''} ${person.lastName ?? ''}`.trim();
  }

  /** Opens the published-version history dialog. */
  showVersions(): void {
    this.versionsDialogVisible.set(true);
  }

  /** Toggles the per-center / per-program breakdown panels. */
  toggleBreakdown(): void {
    this.breakdownExpanded.update((expanded) => !expanded);
  }

  /** Navigate to the public project detail page. */
  viewProject(project: PublishedProjectItem): void {
    this.router.navigate(['/home/project', project.id]);
  }
}
