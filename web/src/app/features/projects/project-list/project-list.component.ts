import { Component, OnInit, OnDestroy, inject, signal, computed } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CommonModule, CurrencyPipe, DatePipe } from '@angular/common';
import { FormControl, ReactiveFormsModule, FormsModule } from '@angular/forms';
import { Subject, debounceTime, distinctUntilChanged, takeUntil } from 'rxjs';

// PrimeNG imports
import { TableModule, TableLazyLoadEvent } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { MultiSelectModule } from 'primeng/multiselect';
import { TagModule } from 'primeng/tag';
import { SkeletonModule } from 'primeng/skeleton';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { ToastModule } from 'primeng/toast';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { TooltipModule } from 'primeng/tooltip';
import { CardModule } from 'primeng/card';
import { CheckboxModule } from 'primeng/checkbox';
import { ConfirmationService, MessageService } from 'primeng/api';

import { ProjectsService } from '../services/projects.service';
import { ReferenceDataService } from '../../../core/services/reference-data.service';
import { AuthService } from '../../../core/services/auth.service';
import { Project, ProjectQuery, ProjectsSuggestion, ProjectsSummary } from '../models/project.model';
import { Center, Program } from '../../../core/models/reference-data.model';

/** Dropdown option shape used by PrimeNG Dropdown. */
interface SelectOption {
  label: string;
  /** number for entity IDs (center); string for enum values (status, fundingSource); null for "All" options. */
  value: number | string | null;
}

/**
 * ProjectListComponent — server-side paginated and filterable projects table.
 *
 * Filter toolbar provides:
 *  - Debounced text search
 *  - Center filter (populated from ReferenceDataService; admin-only)
 *  - Status filter (All / Draft / Active / Archived) — defaults to 'active'
 *  - Funding Source filter (All / Window 3 / Bilateral / SRV / Other)
 *
 * KPI strip above the toolbar shows summary aggregates (activeProjectCount,
 * totalPledge, totalBudgetYear, mappedPercent) scoped to the same filters.
 *
 * Admin-only actions (Edit, Archive) are conditionally shown via isAdmin signal.
 */
@Component({
  selector: 'app-project-list',
  standalone: true,
  imports: [
    CommonModule,
    RouterLink,
    ReactiveFormsModule,
    FormsModule,
    TableModule,
    ButtonModule,
    InputTextModule,
    SelectModule,
    MultiSelectModule,
    TagModule,
    SkeletonModule,
    ConfirmDialogModule,
    ToastModule,
    IconFieldModule,
    InputIconModule,
    TooltipModule,
    CardModule,
    CheckboxModule,
  ],
  providers: [DatePipe, CurrencyPipe],
  templateUrl: './project-list.component.html',
  styleUrl: './project-list.component.scss',
})
export class ProjectListComponent implements OnInit, OnDestroy {
  private readonly projectsService = inject(ProjectsService);
  private readonly refData = inject(ReferenceDataService);
  private readonly authService = inject(AuthService);
  private readonly confirmationService = inject(ConfirmationService);
  private readonly messageService = inject(MessageService);

  private readonly destroy$ = new Subject<void>();

  // -----------------------------------------------------------------------
  // Auth signals
  // -----------------------------------------------------------------------

  /** Exposes admin status for template binding. */
  readonly isAdmin = this.authService.isAdmin;
  readonly isCenterRep = this.authService.isCenterRep;
  /** Workflow_admin only — used to show the flagged-mappings badge column. */
  readonly isWorkflowAdmin = this.authService.isWorkflowAdmin;

  /** Center name for the subtitle (center_rep only). */
  readonly userCenterName = computed(() => {
    const user = this.authService.currentUser();
    if (user?.role !== 'center_rep' || !user.centerId) return '';
    const center = this.refData.centers().find((c) => c.id === user.centerId);
    return center ? center.name : '';
  });

  // -----------------------------------------------------------------------
  // Table state
  // -----------------------------------------------------------------------

  /** Current page of project data. */
  readonly projects = signal<Project[]>([]);

  /** Total number of records matching the current filter (used by p-table paginator). */
  readonly totalRecords = signal(0);

  /** True while an API call is in flight. */
  readonly loading = signal(true);

  /** Rows per page options shown in the paginator. */
  readonly pageSizeOptions = [10, 20, 50];

  /** Current page size — defaults to 20. */
  readonly pageSize = signal(20);

  /** Current page offset (zero-based first-row index for p-table). */
  readonly firstRow = signal(0);

  // -----------------------------------------------------------------------
  // Sort state
  // -----------------------------------------------------------------------

  /**
   * Active sort field — must match one of the API-accepted field names:
   * code | name | startDate | endDate | totalBudget | status | budget2026 | agreedAllocatedPercent
   * Null means no explicit sort (backend default order applies).
   */
  readonly sortField = signal<string | null>(null);

  /**
   * Active sort direction. 1 = ASC, -1 = DESC (PrimeNG convention).
   * Stored as numeric to match what TableLazyLoadEvent provides.
   */
  readonly sortOrder = signal<1 | -1>(1);

  // -----------------------------------------------------------------------
  // KPI summary state
  // -----------------------------------------------------------------------

  /** KPI aggregates returned by GET /projects/summary. Null until first load. */
  readonly summary = signal<ProjectsSummary | null>(null);

  /** True while the summary API call is in flight. */
  readonly summaryLoading = signal(false);

  /**
   * CSS class for the Mapped % KPI tile.
   * Reused by the per-row badge in the Mapped % column.
   */
  readonly mappedClass = computed<'kpi-good' | 'kpi-warn' | 'kpi-zero'>(() => {
    const s = this.summary();
    if (!s) return 'kpi-zero';
    if (s.mappedPercent >= 90) return 'kpi-good';
    if (s.mappedPercent > 0) return 'kpi-warn';
    return 'kpi-zero';
  });

  // -----------------------------------------------------------------------
  // Suggestion state — 5th KPI tile
  // -----------------------------------------------------------------------

  /** Suggested-projects payload from the API. Null until first load. */
  readonly suggestion = signal<ProjectsSuggestion | null>(null);

  /** True while the suggestion API call is in flight. */
  readonly suggestionLoading = signal(false);

  /**
   * Toggle controlling whether the table is filtered to suggested rows only.
   * When true, only rows whose id is in suggestedIds() are shown.
   */
  readonly suggestedOnly = signal(false);

  /**
   * Fast Set lookup of suggested project IDs.
   * Used both for row highlighting and for the suggestedOnly filter.
   */
  readonly suggestedIds = computed(() => new Set(this.suggestion()?.projectIds ?? []));

  /**
   * Projects to display in the table.
   * When suggestedOnly is active, filtered client-side to rows in suggestedIds.
   * Otherwise returns the full current page from the API.
   */
  readonly displayedProjects = computed(() => {
    if (this.suggestedOnly()) {
      return this.projects().filter((p) => this.suggestedIds().has(p.id));
    }
    return this.projects();
  });

  // -----------------------------------------------------------------------
  // What-if calculator state — #8
  // -----------------------------------------------------------------------

  /**
   * Set of project IDs the user has checked in the what-if calculator.
   * Persists across pagination — a project ticked on page 1 remains
   * selected while the user browses to other pages.
   */
  readonly selectedIds = signal<Set<number>>(new Set());

  /**
   * Per-project budget cache for the what-if calculation.
   * Populated whenever a page is loaded from the API so that the calculator
   * can retrieve budget2026 and agreedAllocatedPercent for projects that are
   * no longer visible in the current page.
   */
  private readonly selectedBudgetCache = new Map<
    number,
    { budget2026: number; agreedAllocatedPercent: number; code: string; name: string }
  >();

  /**
   * Toggle row selection for a single project.
   * Creates a new Set to trigger signal reactivity.
   */
  readonly toggleRowSelection = (id: number): void => {
    const next = new Set(this.selectedIds());
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    this.selectedIds.set(next);
  };

  /** Returns true when the given project ID is currently selected. */
  readonly isRowSelected = (id: number): boolean => this.selectedIds().has(id);

  /**
   * Toggle selection for all currently displayed rows.
   * If all are already selected, deselects them; otherwise selects all.
   */
  readonly toggleSelectAllVisible = (): void => {
    const visible = this.displayedProjects().map((p) => p.id);
    const allSelected = visible.every((id) => this.selectedIds().has(id));
    const next = new Set(this.selectedIds());
    if (allSelected) {
      visible.forEach((id) => next.delete(id));
    } else {
      visible.forEach((id) => next.add(id));
    }
    this.selectedIds.set(next);
  };

  /**
   * Tri-state computed for the master checkbox header cell.
   * 'none' — nothing selected; 'some' — partially selected (indeterminate);
   * 'all' — every visible row is selected.
   */
  readonly allVisibleSelectedState = computed<'none' | 'some' | 'all'>(() => {
    const visible = this.displayedProjects();
    if (!visible.length) return 'none';
    const sel = this.selectedIds();
    const count = visible.filter((p) => sel.has(p.id)).length;
    if (count === 0) return 'none';
    if (count === visible.length) return 'all';
    return 'some';
  });

  /**
   * What-if running totals for the current selection.
   *
   * Short-circuit: if the selection is exactly the full suggested set,
   * use the backend's authoritative projection directly (avoids cache gaps
   * when the user clicks "Use suggested set" before paging through all rows).
   *
   * Otherwise, compute from selectedBudgetCache. Each selected project
   * contributes its UNMAPPED FY26 budget:
   *   budget2026 × (100 − agreedAllocatedPercent) / 100
   * clamped at 0 for over-100% legacy data.
   *
   * Note: projects selected before their page has been loaded will be absent
   * from the cache and therefore omitted from the local estimate. This is only
   * possible via the "Use suggested set" path (handled by the short-circuit)
   * and is documented in the tile via an info tooltip.
   */
  readonly whatIf = computed(() => {
    const sel = this.selectedIds();
    const sum = this.summary();
    const sug = this.suggestion();

    const empty = {
      addedBudget: 0,
      projectedMappedBudget: 0,
      projectedMappedPercent: 0,
      deltaPercent: 0,
      count: sel.size,
    };

    if (!sum) return empty;

    // Short-circuit: if the user clicked "Use suggested set" and the selection
    // matches the full suggested set, return the backend's authoritative numbers.
    if (
      sug &&
      !sug.alreadyAtTarget &&
      sug.projectIds.length > 0 &&
      sel.size === sug.projectIds.length &&
      sug.projectIds.every((id) => sel.has(id))
    ) {
      return {
        addedBudget: sug.projectedMappedBudget - sug.currentMappedBudget,
        projectedMappedBudget: sug.projectedMappedBudget,
        projectedMappedPercent: sug.projectedMappedPercent,
        deltaPercent: sug.projectedMappedPercent - sug.currentMappedPercent,
        count: sel.size,
      };
    }

    // Compute from cache — uses budget data seen in the current browser session.
    let addedBudget = 0;
    for (const id of sel) {
      const entry = this.selectedBudgetCache.get(id);
      if (!entry) continue;
      const unmappedFraction = Math.max(0, (100 - entry.agreedAllocatedPercent) / 100);
      addedBudget += entry.budget2026 * unmappedFraction;
    }

    // Use the backend's authoritative mappedBudgetYear (avoids rounding
    // errors from re-deriving it as mappedPercent × totalBudgetYear).
    const projectedMappedBudget = sum.mappedBudgetYear + addedBudget;
    const projectedMappedPercent =
      sum.totalBudgetYear > 0
        ? Math.round((projectedMappedBudget / sum.totalBudgetYear) * 1000) / 10
        : 0;
    const deltaPercent = projectedMappedPercent - sum.mappedPercent;

    return { addedBudget, projectedMappedBudget, projectedMappedPercent, deltaPercent, count: sel.size };
  });

  /**
   * True when the user has selected projects that the cache does not know
   * about yet (i.e. their page has never been loaded). Shown as an info
   * tooltip in the what-if tile to warn about potential underestimation.
   */
  readonly hasUncachedSelections = computed(() => {
    const sel = this.selectedIds();
    const sug = this.suggestion();
    // The suggested-set short-circuit is accurate, so suppress the warning there.
    if (
      sug &&
      !sug.alreadyAtTarget &&
      sel.size === sug.projectIds.length &&
      sug.projectIds.every((id) => sel.has(id))
    ) {
      return false;
    }
    for (const id of sel) {
      if (!this.selectedBudgetCache.has(id)) return true;
    }
    return false;
  });

  // -----------------------------------------------------------------------
  // Filter controls
  // -----------------------------------------------------------------------

  readonly searchControl = new FormControl<string>('');

  readonly selectedCenter = signal<number | null>(null);
  /** Defaults to 'active' so the list opens pre-filtered to active projects. */
  readonly selectedStatus = signal<string | null>('active');
  readonly selectedFundingSource = signal<string | null>(null);
  /**
   * Selected programs for the multi-select filter. Empty array means no
   * filter; the value is sent verbatim to the API which uses OR semantics
   * across the supplied IDs.
   */
  readonly selectedPrograms = signal<number[]>([]);

  /** Skeleton row count — mirrors p-table rows while loading. */
  readonly skeletonRows = computed(() => Array.from({ length: this.pageSize() }));

  // -----------------------------------------------------------------------
  // Dropdown options
  // -----------------------------------------------------------------------

  readonly statusOptions: SelectOption[] = [
    { label: 'All Statuses', value: null },
    { label: 'Draft', value: 'draft' },
    { label: 'Active', value: 'active' },
    { label: 'Archived', value: 'archived' },
  ];

  readonly fundingOptions: SelectOption[] = [
    { label: 'All Sources', value: null },
    { label: 'Window 3', value: 'window3' },
    { label: 'Bilateral', value: 'bilateral' },
    { label: 'SRV', value: 'srv' },
    { label: 'Other', value: 'other' },
  ];

  /** Center dropdown options derived from reference data signal. */
  readonly centerOptions = computed<SelectOption[]>(() => [
    { label: 'All Centers', value: null },
    ...this.refData.centers().map((c: Center) => ({
      label: `${c.acronym} — ${c.name}`,
      value: c.id,
    })),
  ]);

  /**
   * Program options for the multi-select filter.
   * Sorted by official_code so the list reads in the canonical CGIAR order.
   * No "All" sentinel — an empty selection means "no filter" implicitly.
   */
  readonly programOptions = computed(() =>
    this.refData
      .programs()
      .slice()
      .sort((a: Program, b: Program) =>
        (a.officialCode ?? '').localeCompare(b.officialCode ?? ''),
      )
      .map((p: Program) => ({
        label: `${p.officialCode} — ${p.name}`,
        value: p.id,
      })),
  );

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  ngOnInit(): void {
    // Load reference data for the center and program dropdowns (cached).
    this.refData.loadCenters();
    this.refData.loadPrograms();

    // Wire the search input with debounce — reset to page 1 on each keystroke.
    // Also clear the what-if selection so stale rows from the previous filter
    // set don't remain ticked under a different result set.
    this.searchControl.valueChanges
      .pipe(debounceTime(300), distinctUntilChanged(), takeUntil(this.destroy$))
      .subscribe(() => {
        this.firstRow.set(0);
        this.clearSelection();
        this.loadProjects();
        this.loadSummary();
        this.loadSuggestion();
      });

    // Initial load — table, KPI strip, and suggestion tile.
    this.loadProjects();
    this.loadSummary();
    this.loadSuggestion();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  // -----------------------------------------------------------------------
  // Data loading
  // -----------------------------------------------------------------------

  /**
   * Builds the shared filter object (search, status, funding, center) that
   * both loadProjects and loadSummary consume. This is the single source of
   * truth for the filter state so both calls stay in sync.
   */
  private buildFilterParams(): Pick<
    ProjectQuery,
    'search' | 'centerId' | 'status' | 'fundingSource' | 'programIds' | 'needsAssistance'
  > {
    const params: Pick<
      ProjectQuery,
      'search' | 'centerId' | 'status' | 'fundingSource' | 'programIds' | 'needsAssistance'
    > = {};

    const search = this.searchControl.value?.trim();
    if (search) params.search = search;
    if (this.selectedCenter()) params.centerId = this.selectedCenter()!;
    if (this.selectedStatus()) params.status = this.selectedStatus()!;
    if (this.selectedFundingSource()) params.fundingSource = this.selectedFundingSource()!;
    if (this.selectedPrograms().length) params.programIds = this.selectedPrograms();

    return params;
  }

  /**
   * Builds a ProjectQuery from current filter/pagination/sort state and
   * fetches the matching page from the API.
   */
  loadProjects(): void {
    this.loading.set(true);

    const query: ProjectQuery = {
      ...this.buildFilterParams(),
      page: Math.floor(this.firstRow() / this.pageSize()) + 1,
      limit: this.pageSize(),
      budgetYear: 'FY26',
    };

    // Append sort params when an active sort is set.
    const field = this.sortField();
    if (field) {
      query.sortField = field;
      query.sortOrder = this.sortOrder() === 1 ? 'ASC' : 'DESC';
    }

    this.projectsService.getProjects(query).subscribe({
      next: (response) => {
        this.projects.set(response.data);
        this.totalRecords.set(response.total);
        // Populate the what-if budget cache for every loaded row so that
        // cross-page selections can still compute their contribution.
        this.cacheLoadedBudgets(response.data);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.messageService.add({
          severity: 'error',
          summary: 'Error',
          detail: 'Failed to load projects. Please try again.',
        });
      },
    });
  }

  /**
   * Fetches KPI summary aggregates using the same filters as the table
   * (excluding pagination and sort — the backend aggregates all matching rows).
   */
  loadSummary(): void {
    this.summaryLoading.set(true);

    const query: Omit<ProjectQuery, 'page' | 'limit' | 'sortField' | 'sortOrder'> = {
      ...this.buildFilterParams(),
      budgetYear: 'FY26',
    };

    this.projectsService.getSummary(query).subscribe({
      next: (data) => {
        this.summary.set(data);
        this.summaryLoading.set(false);
      },
      error: () => {
        // Non-fatal — the table still works; just hide the strip.
        this.summaryLoading.set(false);
      },
    });
  }

  /**
   * Fetches suggested projects that would push the agreed-mapped % to 90%.
   * Uses the same filter set as loadSummary. Non-fatal on error.
   */
  loadSuggestion(): void {
    this.suggestionLoading.set(true);

    const query = {
      ...this.buildFilterParams(),
      budgetYear: 'FY26',
      target: 90,
    };

    this.projectsService.getSuggested(query).subscribe({
      next: (data) => {
        this.suggestion.set(data);
        this.suggestionLoading.set(false);
      },
      error: () => {
        // Non-fatal — hide the tile gracefully.
        this.suggestionLoading.set(false);
      },
    });
  }

  /**
   * Populates the what-if budget cache for every project row loaded from the
   * API. Always refreshes existing entries so stale data is replaced when
   * a project's budget changes between page visits.
   */
  private cacheLoadedBudgets(rows: Project[]): void {
    for (const row of rows) {
      if (row.budget2026 != null) {
        this.selectedBudgetCache.set(row.id, {
          budget2026: row.budget2026 ?? 0,
          agreedAllocatedPercent: row.agreedAllocatedPercent ?? 0,
          code: row.code,
          name: row.name,
        });
      }
    }
  }

  /**
   * Clears the what-if selection.
   * Called automatically on filter/search changes so that selections made
   * under one filter set don't bleed into a different result set.
   */
  clearSelection(): void {
    this.selectedIds.set(new Set());
  }

  /**
   * Bulk-adds all suggested project IDs to the what-if selection.
   * The what-if computed will short-circuit to the backend's authoritative
   * projection when the selection exactly matches the suggestion set.
   *
   * Projects in the suggestion set that haven't been paged through yet
   * won't be in the local cache, but the short-circuit handles that case
   * precisely and accurately.
   */
  useSuggestedSet(): void {
    const sug = this.suggestion();
    if (!sug || sug.alreadyAtTarget || !sug.projectIds.length) return;
    const next = new Set(sug.projectIds);
    this.selectedIds.set(next);
  }

  /**
   * Toggles the suggestedOnly filter on/off.
   * Turning it on narrows the displayed rows to those in suggestedIds().
   * Turning it off restores the full page.
   */
  toggleSuggestedOnly(): void {
    this.suggestedOnly.update((v) => !v);
  }

  /**
   * Called by p-table's (onLazyLoad) event whenever the page or sort changes.
   * Sort changes reset to page 1; page changes keep the current sort.
   */
  onLazyLoad(event: TableLazyLoadEvent): void {
    const newSortField = (event.sortField as string) ?? null;
    const newSortOrder = (event.sortOrder as 1 | -1) ?? 1;

    // Detect a sort change (field or direction flipped).
    const sortChanged = newSortField !== this.sortField() || newSortOrder !== this.sortOrder();

    this.sortField.set(newSortField);
    this.sortOrder.set(newSortOrder);

    if (sortChanged) {
      // Sort change — reset to first page.
      this.firstRow.set(0);
    } else {
      this.firstRow.set(event.first ?? 0);
      this.pageSize.set(event.rows ?? 20);
    }

    this.loadProjects();
  }

  // -----------------------------------------------------------------------
  // Filter handlers
  // -----------------------------------------------------------------------

  /**
   * Called when any dropdown filter changes — reset to page 1, clear the
   * what-if selection (stale rows from the old filter set shouldn't persist),
   * and refresh all three API calls.
   */
  onFilterChange(): void {
    this.firstRow.set(0);
    this.clearSelection();
    this.loadProjects();
    this.loadSummary();
    this.loadSuggestion();
  }

  onCenterChange(value: number | null): void {
    this.selectedCenter.set(value);
    this.onFilterChange();
  }

  onStatusChange(value: string | null): void {
    this.selectedStatus.set(value);
    this.onFilterChange();
  }

  onFundingChange(value: string | null): void {
    this.selectedFundingSource.set(value);
    this.onFilterChange();
  }

  /**
   * Multi-select Programs filter handler. Receives the full array of
   * currently-selected program IDs from PrimeNG's onChange event.
   */
  onProgramsChange(value: number[] | null): void {
    this.selectedPrograms.set(value ?? []);
    this.onFilterChange();
  }

  // -----------------------------------------------------------------------
  // Per-row mapped % badge helper
  // -----------------------------------------------------------------------

  /**
   * Returns the CSS class for a per-row Mapped % badge based on the value.
   * Mirrors the tile-level mappedClass logic so both stay consistent.
   */
  getMappedClass(percent: number): 'kpi-good' | 'kpi-warn' | 'kpi-zero' {
    if (percent >= 90) return 'kpi-good';
    if (percent > 0) return 'kpi-warn';
    return 'kpi-zero';
  }

  // -----------------------------------------------------------------------
  // Actions
  // -----------------------------------------------------------------------

  /**
   * Maps a project status string to a PrimeNG Tag severity value.
   */
  getStatusSeverity(status: Project['status']): 'success' | 'warn' | 'secondary' {
    const map: Record<Project['status'], 'success' | 'warn' | 'secondary'> = {
      active: 'success',
      draft: 'warn',
      archived: 'secondary',
    };
    return map[status] ?? 'secondary';
  }

  /** Humanises a funding source enum value for display. */
  getFundingLabel(source: Project['fundingSource']): string {
    const map: Record<Project['fundingSource'], string> = {
      window3: 'Window 3',
      bilateral: 'Bilateral',
      srv: 'SRV',
      other: 'Other',
    };
    return map[source] ?? source;
  }

  /**
   * Opens a PrimeNG ConfirmDialog before archiving a project.
   * On acceptance, calls the service and refreshes the list.
   */
  confirmArchive(project: Project): void {
    this.confirmationService.confirm({
      header: 'Archive Project',
      message: `Archive "${project.name}"? It will no longer appear in active listings.`,
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Archive',
      rejectLabel: 'Cancel',
      acceptButtonStyleClass: 'p-button-danger',
      accept: () => {
        this.projectsService.archiveProject(project.id).subscribe({
          next: () => {
            this.messageService.add({
              severity: 'success',
              summary: 'Archived',
              detail: `"${project.name}" has been archived.`,
            });
            this.loadProjects();
            this.loadSummary();
          },
          error: () => {
            this.messageService.add({
              severity: 'error',
              summary: 'Error',
              detail: 'Failed to archive project. Please try again.',
            });
          },
        });
      },
    });
  }
}
