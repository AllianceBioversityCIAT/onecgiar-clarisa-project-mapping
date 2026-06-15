import {
  Component,
  OnInit,
  OnDestroy,
  inject,
  signal,
  computed,
  effect,
  untracked,
  NgZone,
  ChangeDetectorRef,
  ViewChild,
} from '@angular/core';
import { RouterLink, ActivatedRoute, Router } from '@angular/router';
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
import { DialogModule } from 'primeng/dialog';
import { Dialog } from 'primeng/dialog';
import { Textarea } from 'primeng/textarea';
import { ToastModule } from 'primeng/toast';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { TooltipModule } from 'primeng/tooltip';
import { CardModule } from 'primeng/card';
import { CheckboxModule } from 'primeng/checkbox';
import { DatePickerModule } from 'primeng/datepicker';
import { ConfirmationService, MessageService } from 'primeng/api';

import { ProjectsService } from '../services/projects.service';
import { ProjectsExportService } from '../services/projects-export.service';
import { ReferenceDataService } from '../../../core/services/reference-data.service';
import { AuthService } from '../../../core/services/auth.service';
import { CenterImportsDialogComponent } from '../../mappings/center-imports/center-imports-dialog.component';
import {
  Project,
  ProjectQuery,
  ProjectsSuggestion,
  ProjectsSummary,
} from '../models/project.model';
import { Center, Program } from '../../../core/models/reference-data.model';

/** Dropdown option shape used by PrimeNG Dropdown. */
interface SelectOption {
  label: string;
  /** number for entity IDs (center); string for enum values (status, fundingSource); null for "All" options. */
  value: number | string | null;
}

/**
 * Full set of funding-source dropdown values (excluding the "All Sources"
 * sentinel). The `fundingOptions` computed narrows this to the values present
 * under the user's other active filters, so unused sources (e.g. SRV when no
 * visible project uses it) are hidden.
 */
const FUNDING_SOURCE_BASE_OPTIONS: SelectOption[] = [
  { label: 'Window 3', value: 'window3' },
  { label: 'Bilateral', value: 'bilateral' },
  { label: 'SRV', value: 'srv' },
  { label: 'Other', value: 'other' },
];

/**
 * Full set of mapping-status dropdown values (excluding the "All Mapping
 * Statuses" sentinel), in display order. The `mappingStatusOptions` computed
 * narrows this to the buckets that match at least one project under the
 * user's other active filters.
 */
const MAPPING_STATUS_BASE_OPTIONS: SelectOption[] = [
  { label: 'In Negotiation', value: 'in_negotiation' },
  { label: 'Negotiating (active)', value: 'negotiating' },
  { label: 'Ready to lock', value: 'ready_to_lock' },
  { label: 'Not reached 100%', value: 'partially_allocated' },
  { label: 'Missing TOC contribution', value: 'missing_toc' },
  { label: 'Draft', value: 'draft' },
  { label: 'Locked - Solved by negotiation', value: 'locked' },
  { label: 'Locked - Solved by admin decision', value: 'admin_decision' },
  { label: 'Unmapped', value: 'none' },
];

/**
 * One active filter rendered as a removable chip in the active-filters bar.
 * `key` is a stable identity for @for tracking; `label` is the human-readable
 * "<facet>: <value>" text; `clear` removes just this filter and reloads.
 */
interface ActiveFilter {
  key: string;
  label: string;
  clear: () => void;
}

/**
 * ProjectListComponent — server-side paginated and filterable projects table.
 *
 * Filter toolbar provides:
 *  - Debounced text search
 *  - Center filter (populated from ReferenceDataService; admin-only)
 *  - Status filter (All / Active / Archived) — defaults to 'active'
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
    DialogModule,
    Textarea,
    ToastModule,
    IconFieldModule,
    InputIconModule,
    TooltipModule,
    CardModule,
    CheckboxModule,
    DatePickerModule,
    CenterImportsDialogComponent,
  ],
  providers: [DatePipe, CurrencyPipe, ConfirmationService],
  templateUrl: './project-list.component.html',
  styleUrl: './project-list.component.scss',
})
export class ProjectListComponent implements OnInit, OnDestroy {
  private readonly projectsService = inject(ProjectsService);
  private readonly exportService = inject(ProjectsExportService);
  private readonly refData = inject(ReferenceDataService);
  private readonly authService = inject(AuthService);
  private readonly confirmationService = inject(ConfirmationService);
  private readonly messageService = inject(MessageService);
  private readonly ngZone = inject(NgZone);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  /** Reference to the exclude dialog — used for imperative show/hide so
   * Angular's change detection cycle is guaranteed to run. */
  @ViewChild('excludeDialog') private excludeDialogRef?: Dialog;

  private readonly destroy$ = new Subject<void>();

  constructor() {
    // Re-fetch projects, KPI summary, and suggestions whenever the active
    // center OR active program changes. The effect fires on first
    // subscription too, so the three explicit load calls that were in
    // ngOnInit are removed — this is the single source of truth for the
    // initial and subsequent loads. firstRow is reset to page 1 on each
    // switch so the user always lands on the first page of the new scope.
    effect(() => {
      this.authService.activeCenterId(); // track reactive dependency (center_rep)
      this.authService.activeProgramId(); // track reactive dependency (program_rep)
      // Wrap the body in untracked() so signal reads inside the load
      // methods (firstRow, pageSize, sortField, sortOrder, filter
      // signals, etc.) do NOT become dependencies of this effect.
      // Otherwise sorting/paginating/filtering would re-trigger the
      // full triple-load and loop indefinitely once the response sets
      // any signal those load methods also read.
      untracked(() => {
        // On the FIRST run, preserve the page/sort/filters restored from the
        // URL by applyQueryParamFilters() (ngOnInit runs before this effect's
        // first change-detection pass). Only reset to page 1 on a later
        // active-center / active-program SWITCH, where landing on page 1 of
        // the new scope is the desired behaviour.
        if (this.initialLoadDone) {
          this.firstRow.set(0);
        }
        this.initialLoadDone = true;
        this.clearSelection();
        this.loadProjects();
        this.loadSummary();
        this.loadSuggestion();
      });
    });
  }

  /**
   * False until the constructor effect's first run completes. Guards the
   * page-reset so a URL-restored page survives the initial load but still
   * resets on subsequent center/program switches. See the effect above.
   */
  private initialLoadDone = false;

  /**
   * Pushes the current filter / sort / pagination state into the URL as
   * query params (one new history entry per committed change), so the
   * browser Back button and the detail page's "Back" restore the full list
   * state. No-ops when the URL already matches — which covers the initial
   * load right after `applyQueryParamFilters()` restored from the URL, so
   * the restore doesn't immediately push a duplicate entry.
   *
   * We PUSH (not `replaceUrl`) deliberately: Angular's router does not
   * reliably restore a `replaceUrl`-updated URL on Back in this app — the
   * address bar changes but `goBack()` returns the entry's original
   * (pre-filter) URL, dropping sort/page. A real push is the only thing
   * Back restores. Cost: one Back stop per change; mitigated by the
   * debounced search (one push per settled term) and the match guard.
   */
  private syncUrlFromState(): void {
    const qp = this.buildQueryParamsFromState();
    if (this.queryParamsMatchUrl(qp)) return; // nothing changed → no push
    this.router.navigate([], { relativeTo: this.route, queryParams: qp });
  }

  /**
   * True when the live URL's query params already equal `qp` (treating
   * absent and null/'' as equivalent). Lets `syncUrlFromState` no-op when
   * there's nothing to write.
   */
  private queryParamsMatchUrl(qp: Record<string, string | number | null>): boolean {
    const current = this.route.snapshot.queryParamMap;
    const keys = new Set([...current.keys, ...Object.keys(qp)]);
    for (const key of keys) {
      const want = qp[key];
      const wantStr = want === null || want === undefined ? '' : String(want);
      const haveStr = current.get(key) ?? '';
      if (wantStr !== haveStr) return false;
    }
    return true;
  }

  /**
   * Serialises the current filter / sort / pagination signals into a flat
   * query-param object. Only non-default values are emitted (others are set
   * to `null` so Angular strips them from the URL), keeping the address bar
   * clean. This is the inverse of `applyQueryParamFilters()` — keep the two
   * in sync when adding a new filter.
   */
  private buildQueryParamsFromState(): Record<string, string | number | null> {
    const ms = this.selectedMappingStatus();
    const sd = this.startDateRange();
    const ed = this.endDateRange();
    return {
      search: this.searchTerm() || null,
      center: this.selectedCenter() ?? null,
      mappingStatus: ms ?? null,
      funding: this.selectedFundingSource() ?? null,
      funder: this.selectedFunder() ?? null,
      programs: this.selectedPrograms().length ? this.selectedPrograms().join(',') : null,
      negState: this.negotiationStateFilter() ?? null,
      excluded: this.showExcluded() ? 'true' : null,
      suggested: this.suggestedOnly() ? 'true' : null,
      startFrom: sd?.[0] instanceof Date ? this.toLocalDateString(sd[0]) : null,
      startTo: sd?.[1] instanceof Date ? this.toLocalDateString(sd[1]) : null,
      endFrom: ed?.[0] instanceof Date ? this.toLocalDateString(ed[0]) : null,
      endTo: ed?.[1] instanceof Date ? this.toLocalDateString(ed[1]) : null,
      sortField: this.sortField() ?? null,
      sortOrder: this.sortField() ? (this.sortOrder() === 1 ? 'ASC' : 'DESC') : null,
      page: this.firstRow() > 0 ? Math.floor(this.firstRow() / this.pageSize()) + 1 : null,
      pageSize: this.pageSize() !== 20 ? this.pageSize() : null,
    };
  }

  // -----------------------------------------------------------------------
  // Auth signals
  // -----------------------------------------------------------------------

  /** Exposes admin status for template binding. */
  readonly isAdmin = this.authService.isAdmin;
  readonly isCenterRep = this.authService.isCenterRep;
  /** Program-rep only — drives the program-specific KPI tile variant. */
  readonly isProgramRep = this.authService.isProgramRep;
  /** Workflow_admin only — used to show the flagged-mappings badge column. */
  readonly isWorkflowAdmin = this.authService.isWorkflowAdmin;

  /**
   * Whether the cross-center "Center" column + filter are shown.
   * Hidden for center_rep (their list is already scoped to their own center);
   * shown for every other authenticated viewer, including no-role users.
   */
  readonly showCenterFilter = computed(() => !this.isCenterRep());

  /**
   * Whether the "Suggested to reach 90%" tile, what-if selection tile,
   * row checkboxes, and "Use suggested set" button are shown. These are
   * planning tools for the roles that actually create mappings (admin
   * and center_rep). Hidden for everyone else, including no-role users.
   */
  readonly canPlanMappings = computed(() => this.isAdmin() || this.isCenterRep());

  /**
   * Whether the Import button is visible.
   * Only center_rep and workflow_admin can bulk-import mappings.
   */
  readonly canImport = computed(() => this.isCenterRep() || this.isWorkflowAdmin());

  /** Controls the import dialog visibility. */
  readonly showImportDialog = signal(false);

  /**
   * Center name for the subtitle (center_rep only).
   *
   * Multi-center reps: resolves to the currently active center (changes when
   * the user switches via the header switcher). Single-center reps fall back
   * to the primary center. This uses authService.activeCenter() which already
   * implements both cases, so the caption always stays in sync with the data.
   */
  readonly userCenterName = computed(() => {
    if (!this.isCenterRep()) return '';
    // activeCenter() resolves the active center for multi-center reps and
    // falls back to the primary center for single-center reps.
    const active = this.authService.activeCenter();
    if (active) return active.name;
    // Final fallback: look up primary centerId in reference data.
    const user = this.authService.currentUser();
    if (!user?.centerId) return '';
    const center = this.refData.centers().find((c) => c.id === user.centerId);
    return center ? center.name : '';
  });

  /**
   * Program name for the subtitle (program_rep only).
   *
   * Mirrors {@link userCenterName} — multi-program reps see the currently
   * active program (which updates when they pick a different one via the
   * header switcher); single-program reps see their sole program.
   */
  readonly userProgramName = computed(() => {
    if (!this.isProgramRep()) return '';
    const active = this.authService.activeProgram();
    if (active) return active.name;
    const user = this.authService.currentUser();
    if (!user?.programId) return '';
    const program = this.refData.programs().find((p) => p.id === user.programId);
    return program ? program.name : '';
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
  readonly pageSizeOptions = [10, 20, 50, 100];

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
   * Filtering is server-side — this just passes through the current page.
   * suggestedIds() is still used for the per-row ⭐ highlight icon.
   */
  readonly displayedProjects = computed(() => this.projects());

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
   * Tracks how the current selection was populated.
   * 'suggested' — set via useSuggestedSet(); 'manual' — any other interaction.
   * Used to detect when the suggestion has refreshed after a bulk-select.
   */
  readonly selectionSource = signal<'manual' | 'suggested'>('manual');

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
    this.selectionSource.set('manual');
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
    this.selectionSource.set('manual');
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

    return {
      addedBudget,
      projectedMappedBudget,
      projectedMappedPercent,
      deltaPercent,
      count: sel.size,
    };
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

  /**
   * True when the selection was populated via "Use suggested set" but the
   * suggestion has since been refreshed (e.g. the user changed a filter
   * after clicking the button, causing loadSuggestion to re-run).
   * Detected by: source === 'suggested' AND the current selectedIds set no
   * longer exactly matches suggestion.projectIds.
   */
  readonly staleSuggestion = computed(() => {
    if (this.selectionSource() !== 'suggested') return false;
    const sel = this.selectedIds();
    const sug = this.suggestion();
    if (!sug || !sel.size) return false;
    return sel.size !== sug.projectIds.length || !sug.projectIds.every((id) => sel.has(id));
  });

  /**
   * True when the current selection is exactly the suggested set — i.e. the
   * user clicked "Use suggested set" and hasn't changed the selection since.
   * Drives the suggest button's toggle state (label/icon flip to "Clear
   * suggested set" and the button renders as active rather than outlined).
   */
  readonly suggestedSetActive = computed(() => {
    const sel = this.selectedIds();
    const sug = this.suggestion();
    if (!sug || !sug.projectIds.length || !sel.size) return false;
    return sel.size === sug.projectIds.length && sug.projectIds.every((id) => sel.has(id));
  });

  // -----------------------------------------------------------------------
  // Filter controls
  // -----------------------------------------------------------------------

  readonly searchControl = new FormControl<string>('');

  /**
   * Signal mirror of the (debounced) search term. The FormControl is not a
   * signal, so this lets the `activeFilters` computed react to search
   * changes. Updated in the valueChanges subscription in ngOnInit.
   */
  readonly searchTerm = signal<string>('');

  readonly selectedCenter = signal<number | null>(null);
  /** Selected mapping status filter — null means show all. */
  readonly selectedMappingStatus = signal<
    | 'locked'
    | 'in_negotiation'
    | 'negotiating'
    | 'ready_to_lock'
    | 'partially_allocated'
    | 'missing_toc'
    | 'draft'
    | 'admin_decision'
    | 'none'
    | null
  >(null);
  readonly selectedFundingSource = signal<string | null>(null);

  /** Selected funder (exact value chosen from the funder dropdown). */
  readonly selectedFunder = signal<string | null>(null);

  /** Distinct funder names loaded from the API, for the funder dropdown. */
  readonly funders = signal<string[]>([]);

  /**
   * Context-aware filter-dropdown option sets from `GET /projects/filter-options`,
   * recomputed whenever the active filters change. Each holds the values
   * present under the user's OTHER active filters; the matching option
   * computeds narrow their dropdown to these (always keeping the current
   * selection visible). `null` means "not loaded yet" → show the full list,
   * which avoids a flash of empty dropdowns before the first response.
   */
  readonly availableFundingSources = signal<string[] | null>(null);
  readonly availableCenterIds = signal<number[] | null>(null);
  readonly availableProgramIds = signal<number[] | null>(null);
  readonly availableMappingStatuses = signal<string[] | null>(null);

  /**
   * Selected programs for the multi-select filter. Empty array means no
   * filter; the value is sent verbatim to the API which uses OR semantics
   * across the supplied IDs.
   */
  readonly selectedPrograms = signal<number[]>([]);

  /**
   * Negotiation-state quick filter — null = all, true = only projects in
   * active negotiation, 'mapped' = only projects with at least one agreed
   * mapping. Mutually exclusive so the toolbar stays simple.
   */
  readonly negotiationStateFilter = signal<'in-negotiation' | 'mapped' | null>(null);

  /**
   * Whether to show excluded projects in the list (center_rep only).
   * When false (default), excluded projects are hidden. When true, they
   * appear with an "Excluded" badge and an Unexclude action.
   */
  readonly showExcluded = signal(false);

  // -----------------------------------------------------------------------
  // Exclude dialog state (center_rep + admin)
  // -----------------------------------------------------------------------

  /**
   * Controls visibility of the exclude-project reason dialog.
   * Stored as a plain boolean (not a Signal) so PrimeNG's non-signal
   * [visible] @Input setter triggers properly through Angular's default CD.
   */
  excludeDialogVisible = false;

  /** The project currently being excluded (set when dialog opens). */
  private projectToExclude: Project | null = null;

  /** Reason text typed into the exclude dialog. */
  readonly excludeReason = signal('');

  /** True while the exclude/unexclude API call is in flight. */
  readonly excludeLoading = signal(false);

  /** Selected [from, to] range for the project start_date filter. */
  readonly startDateRange = signal<Date[] | null>(null);

  /** Selected [from, to] range for the project end_date filter. */
  readonly endDateRange = signal<Date[] | null>(null);

  /** True when at least one date range filter is active. */
  readonly hasDateFilter = computed(() => !!(this.startDateRange() || this.endDateRange()));

  /**
   * All currently-active filters as removable chips. Drives the
   * active-filters bar so a user always sees what's narrowing the list
   * (e.g. after arriving from a dashboard card click) and can clear any
   * one of them. Each entry carries its own `clear` closure.
   *
   * Note: `status` is intentionally excluded — it defaults to 'active' and
   * lives in its own always-visible dropdown, so surfacing it as a
   * removable chip would be noise.
   */
  readonly activeFilters = computed<ActiveFilter[]>(() => {
    const filters: ActiveFilter[] = [];

    const search = this.searchTerm();
    if (search) {
      filters.push({
        key: 'search',
        label: `Search: "${search}"`,
        clear: () => {
          this.searchControl.setValue('');
          this.searchTerm.set('');
          this.onFilterChange();
        },
      });
    }

    const centerId = this.selectedCenter();
    if (centerId != null) {
      const center = this.refData.centers().find((c) => c.id === centerId);
      filters.push({
        key: 'center',
        label: `Center: ${center ? (center.acronym ?? center.name) : centerId}`,
        clear: () => {
          this.selectedCenter.set(null);
          this.onFilterChange();
        },
      });
    }

    const ms = this.selectedMappingStatus();
    if (ms) {
      const opt = this.mappingStatusOptions().find((o) => o.value === ms);
      filters.push({
        key: 'mappingStatus',
        label: `Status: ${opt?.label ?? ms}`,
        clear: () => {
          this.selectedMappingStatus.set(null);
          this.onFilterChange();
        },
      });
    }

    const funding = this.selectedFundingSource();
    if (funding) {
      const opt = this.fundingOptions().find((o) => o.value === funding);
      filters.push({
        key: 'funding',
        label: `Funding: ${opt?.label ?? funding}`,
        clear: () => {
          this.selectedFundingSource.set(null);
          this.onFilterChange();
        },
      });
    }

    const funder = this.selectedFunder();
    if (funder) {
      filters.push({
        key: 'funder',
        label: `Funder: ${funder}`,
        clear: () => {
          this.selectedFunder.set(null);
          this.onFilterChange();
        },
      });
    }

    const programIds = this.selectedPrograms();
    if (programIds.length) {
      const programs = this.refData.programs();
      const names = programIds
        .map((id) => programs.find((p) => p.id === id)?.officialCode ?? String(id))
        .join(', ');
      filters.push({
        key: 'programs',
        label: `Programs: ${names}`,
        clear: () => {
          this.selectedPrograms.set([]);
          this.onFilterChange();
        },
      });
    }

    const negState = this.negotiationStateFilter();
    if (negState) {
      filters.push({
        key: 'negState',
        label: negState === 'in-negotiation' ? 'In negotiation' : 'Mapped',
        clear: () => {
          this.negotiationStateFilter.set(null);
          this.onFilterChange();
        },
      });
    }

    if (this.hasDateFilter()) {
      filters.push({
        key: 'dates',
        label: 'Date range',
        clear: () => this.clearDateFilters(),
      });
    }

    if (this.showExcluded()) {
      filters.push({
        key: 'showExcluded',
        label: 'Including excluded',
        clear: () => {
          this.showExcluded.set(false);
          this.onFilterChange();
        },
      });
    }

    if (this.suggestedOnly()) {
      filters.push({
        key: 'suggested',
        label: 'Suggested set',
        clear: () => {
          this.suggestedOnly.set(false);
          this.onFilterChange();
        },
      });
    }

    return filters;
  });

  /** Skeleton row count — mirrors p-table rows while loading. */
  readonly skeletonRows = computed(() => Array.from({ length: this.pageSize() }));

  // -----------------------------------------------------------------------
  // Dropdown options
  // -----------------------------------------------------------------------

  /**
   * Mapping-status dropdown options, narrowed to the buckets that match at
   * least one project under the other active filters (plus the current
   * selection, so it stays visible/clearable even when its own result set is
   * empty). Falls back to the full list until the first filter-options load.
   */
  readonly mappingStatusOptions = computed<SelectOption[]>(() => {
    const available = this.availableMappingStatuses();
    const selected = this.selectedMappingStatus();
    const visible =
      available == null
        ? MAPPING_STATUS_BASE_OPTIONS
        : MAPPING_STATUS_BASE_OPTIONS.filter(
            (o) => available.includes(o.value as string) || o.value === selected,
          );
    return [{ label: 'All Mapping Statuses', value: null }, ...visible];
  });

  /**
   * Funding-source dropdown options, narrowed to the sources present under
   * the other active filters (plus the current selection). This is what hides
   * unused sources such as SRV when no visible project uses them.
   */
  readonly fundingOptions = computed<SelectOption[]>(() => {
    const available = this.availableFundingSources();
    const selected = this.selectedFundingSource();
    const visible =
      available == null
        ? FUNDING_SOURCE_BASE_OPTIONS
        : FUNDING_SOURCE_BASE_OPTIONS.filter(
            (o) => available.includes(o.value as string) || o.value === selected,
          );
    return [{ label: 'All Sources', value: null }, ...visible];
  });

  /**
   * Funder dropdown options derived from the distinct-funders signal (already
   * scoped to the other active filters by the backend). The current selection
   * is always kept so it stays visible even if it drops out of the set.
   * Leading "All Funders" sentinel (value null) clears the filter.
   */
  readonly funderOptions = computed<SelectOption[]>(() => {
    const funders = this.funders();
    const selected = this.selectedFunder();
    const names =
      selected && !funders.includes(selected)
        ? [...funders, selected].sort((a, b) => a.localeCompare(b))
        : funders;
    return [
      { label: 'All Funders', value: null },
      ...names.map((f) => ({ label: f, value: f })),
    ];
  });

  /**
   * Center dropdown options, narrowed to the centers that own at least one
   * project under the other active filters (plus the current selection).
   */
  readonly centerOptions = computed<SelectOption[]>(() => {
    const available = this.availableCenterIds();
    const selected = this.selectedCenter();
    const centers = this.refData.centers();
    const visible =
      available == null
        ? centers
        : centers.filter((c) => available.includes(c.id) || c.id === selected);
    return [
      { label: 'All Centers', value: null },
      ...visible.map((c: Center) => ({
        label: `${c.acronym} — ${c.name}`,
        value: c.id,
      })),
    ];
  });

  /**
   * Program options for the multi-select filter, narrowed to the programs
   * with at least one mapping under the other active filters (plus any
   * currently-selected programs). Sorted by official_code so the list reads in
   * the canonical CGIAR order. No "All" sentinel — an empty selection means
   * "no filter" implicitly.
   */
  readonly programOptions = computed(() => {
    const available = this.availableProgramIds();
    const selected = new Set(this.selectedPrograms());
    const programs = this.refData
      .programs()
      .slice()
      .sort((a: Program, b: Program) =>
        (a.officialCode ?? '').localeCompare(b.officialCode ?? ''),
      );
    const visible =
      available == null
        ? programs
        : programs.filter((p) => available.includes(p.id) || selected.has(p.id));
    return visible.map((p: Program) => ({
      label: `${p.officialCode} — ${p.name}`,
      value: p.id,
    }));
  });

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  ngOnInit(): void {
    // Load reference data for the center and program dropdowns (cached).
    // The context-aware filter options (incl. funders) are loaded by the
    // first loadProjects() call below, so no separate funders fetch here.
    this.refData.loadCenters();
    this.refData.loadPrograms();

    // Wire the search input with debounce — reset to page 1 on each keystroke.
    // Also clear the what-if selection so stale rows from the previous filter
    // set don't remain ticked under a different result set.
    this.searchControl.valueChanges
      .pipe(debounceTime(300), distinctUntilChanged(), takeUntil(this.destroy$))
      .subscribe(() => {
        this.searchTerm.set(this.searchControl.value?.trim() ?? '');
        this.firstRow.set(0);
        this.clearSelection();
        this.loadProjects();
        this.loadSummary();
        this.loadSuggestion();
      });

    // Apply any deep-link filter from query params (e.g. dashboard stat
    // cards link here with ?inNegotiation=true / ?readyToLock=true /
    // ?mappingStatus=locked). Set the matching filter signals BEFORE the
    // constructor effect's first run — that run reads these signals (via
    // untracked) when building the initial load, so the list lands
    // pre-filtered and its count matches the card the user clicked.
    this.applyQueryParamFilters();

    // Initial load is driven by the effect() in the constructor which tracks
    // activeCenterId. That load calls syncUrlFromState(), which no-ops here
    // because the URL already matches the just-restored state (so the restore
    // doesn't push a duplicate history entry).
  }

  /**
   * Reads the route's query params once and maps the known deep-link filter
   * keys onto the local filter signals. Mirrors the dashboard card links:
   *   - negotiating=true    → mapping-status "Negotiating (active)" (strict)
   *   - readyToLock=true    → mapping-status "Ready to lock"
   *   - mappingStatus=<v>   → mapping-status dropdown (locked / draft / none / in_negotiation)
   *   - inNegotiation=true  → "In negotiation" chip (loose)
   *   - mapped=true         → "Mapped" chip
   * Unknown or absent params leave the defaults untouched. The mapping-status
   * keys are mutually exclusive (one dropdown), so they share an if/else.
   */
  private applyQueryParamFilters(): void {
    const qp = this.route.snapshot.queryParamMap;

    // --- Legacy dashboard deep-link keys (boolean flags) -------------------
    // These are how the dashboard stat cards link in. They take precedence
    // for mapping status when present, and stay supported indefinitely.
    if (qp.get('negotiating') === 'true') {
      this.selectedMappingStatus.set('negotiating');
    } else if (qp.get('readyToLock') === 'true') {
      this.selectedMappingStatus.set('ready_to_lock');
    } else if (qp.get('missingTocContribution') === 'true') {
      this.selectedMappingStatus.set('missing_toc');
    } else {
      // Rich key written by our own URL-sync effect (full enum incl.
      // negotiating / ready_to_lock / partially_allocated / missing_toc),
      // plus the original dashboard `mappingStatus` deep-link values.
      const ms = qp.get('mappingStatus');
      if (
        ms === 'locked' ||
        ms === 'in_negotiation' ||
        ms === 'negotiating' ||
        ms === 'ready_to_lock' ||
        ms === 'partially_allocated' ||
        ms === 'missing_toc' ||
        ms === 'draft' ||
        ms === 'admin_decision' ||
        ms === 'none'
      ) {
        this.selectedMappingStatus.set(ms);
      }
    }

    if (qp.get('inNegotiation') === 'true') {
      this.negotiationStateFilter.set('in-negotiation');
    } else if (qp.get('mapped') === 'true') {
      this.negotiationStateFilter.set('mapped');
    } else {
      const negState = qp.get('negState');
      if (negState === 'in-negotiation' || negState === 'mapped') {
        this.negotiationStateFilter.set(negState);
      }
    }

    // --- Full state restored from our own URL-sync effect -----------------
    const search = qp.get('search');
    if (search) {
      this.searchTerm.set(search);
      // setValue with emitEvent:false so the debounced valueChanges
      // subscription doesn't fire a duplicate reset-and-reload on restore.
      this.searchControl.setValue(search, { emitEvent: false });
    }

    const center = this.toIntOrNull(qp.get('center'));
    if (center != null) this.selectedCenter.set(center);

    const funding = qp.get('funding');
    if (funding) this.selectedFundingSource.set(funding);

    const funder = qp.get('funder');
    if (funder) this.selectedFunder.set(funder);

    const programs = qp.get('programs');
    if (programs) {
      const ids = programs
        .split(',')
        .map((s) => Number(s))
        .filter((n) => Number.isFinite(n));
      if (ids.length) this.selectedPrograms.set(ids);
    }

    if (qp.get('excluded') === 'true' && (this.isCenterRep() || this.isAdmin())) {
      this.showExcluded.set(true);
    }

    if (qp.get('suggested') === 'true') this.suggestedOnly.set(true);

    // Date ranges — only set a range when at least one bound is present.
    const startFrom = this.parseDateParam(qp.get('startFrom'));
    const startTo = this.parseDateParam(qp.get('startTo'));
    if (startFrom || startTo) this.startDateRange.set([startFrom as Date, startTo as Date]);
    const endFrom = this.parseDateParam(qp.get('endFrom'));
    const endTo = this.parseDateParam(qp.get('endTo'));
    if (endFrom || endTo) this.endDateRange.set([endFrom as Date, endTo as Date]);

    // Sort — only apply when a field is present (p-table reads these signals).
    const sortField = qp.get('sortField');
    if (sortField) {
      this.sortField.set(sortField);
      this.sortOrder.set(qp.get('sortOrder') === 'DESC' ? -1 : 1);
    }

    // Pagination — restore the page offset and page size.
    const pageSize = this.toIntOrNull(qp.get('pageSize'));
    if (pageSize && this.pageSizeOptions.includes(pageSize)) this.pageSize.set(pageSize);
    const page = this.toIntOrNull(qp.get('page'));
    if (page && page > 1) this.firstRow.set((page - 1) * this.pageSize());
  }

  /** Parse a query-param into a positive integer, or null if absent/invalid. */
  private toIntOrNull(value: string | null): number | null {
    if (!value) return null;
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  /**
   * Parse a YYYY-MM-DD query-param into a local-midnight Date, or null.
   * Mirrors `toLocalDateString` so a round-trip through the URL doesn't shift
   * the calendar day across timezones.
   */
  private parseDateParam(value: string | null): Date | null {
    if (!value) return null;
    const parts = value.split('-').map((p) => Number(p));
    if (parts.length !== 3 || parts.some((p) => !Number.isFinite(p))) return null;
    const [y, m, d] = parts;
    return new Date(y, m - 1, d);
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
    | 'search'
    | 'centerId'
    | 'mappingStatus'
    | 'fundingSource'
    | 'funder'
    | 'programIds'
    | 'needsAssistance'
    | 'inNegotiation'
    | 'negotiating'
    | 'mapped'
    | 'readyToLock'
    | 'partiallyAllocated'
    | 'missingTocContribution'
    | 'startDateFrom'
    | 'startDateTo'
    | 'endDateFrom'
    | 'endDateTo'
    | 'showExcluded'
    | 'suggestedOnly'
    | 'suggestionTarget'
    | 'suggestionBudgetYear'
  > {
    const params: Pick<
      ProjectQuery,
      | 'search'
      | 'centerId'
      | 'mappingStatus'
      | 'fundingSource'
      | 'funder'
      | 'programIds'
      | 'needsAssistance'
      | 'inNegotiation'
      | 'negotiating'
      | 'mapped'
      | 'readyToLock'
      | 'partiallyAllocated'
      | 'missingTocContribution'
      | 'startDateFrom'
      | 'startDateTo'
      | 'endDateFrom'
      | 'endDateTo'
      | 'showExcluded'
      | 'suggestedOnly'
      | 'suggestionTarget'
      | 'suggestionBudgetYear'
    > = {};

    const search = this.searchControl.value?.trim();
    if (search) params.search = search;
    if (this.selectedCenter()) params.centerId = this.selectedCenter()!;
    /* 'ready_to_lock' and 'negotiating' are backend flags, not mappingStatus
     * enum values — translate them to their own params so the projects-list
     * counts match the dashboard "Ready to lock" / "Negotiating" tiles.
     * Every other value maps 1:1 to the mappingStatus filter. */
    const mappingStatus = this.selectedMappingStatus();
    if (mappingStatus === 'ready_to_lock') {
      params.readyToLock = true;
    } else if (mappingStatus === 'negotiating') {
      params.negotiating = true;
    } else if (mappingStatus === 'partially_allocated') {
      params.partiallyAllocated = true;
    } else if (mappingStatus === 'missing_toc') {
      params.missingTocContribution = true;
    } else if (mappingStatus) {
      params.mappingStatus = mappingStatus;
    }
    if (this.selectedFundingSource()) params.fundingSource = this.selectedFundingSource()!;
    if (this.selectedFunder()) params.funder = this.selectedFunder()!;
    if (this.selectedPrograms().length) params.programIds = this.selectedPrograms();
    if (this.negotiationStateFilter() === 'in-negotiation') params.inNegotiation = true;
    if (this.negotiationStateFilter() === 'mapped') params.mapped = true;
    /* Pass showExcluded for center_rep and admin (the only roles that see
     * the toggle). Backend treats it as "filter to excluded only" for both. */
    if ((this.isCenterRep() || this.isAdmin()) && this.showExcluded()) params.showExcluded = true;

    const sd = this.startDateRange();
    if (sd?.[0] instanceof Date) params.startDateFrom = this.toLocalDateString(sd[0]);
    if (sd?.[1] instanceof Date) params.startDateTo = this.toLocalDateString(sd[1]);
    const ed = this.endDateRange();
    if (ed?.[0] instanceof Date) params.endDateFrom = this.toLocalDateString(ed[0]);
    if (ed?.[1] instanceof Date) params.endDateTo = this.toLocalDateString(ed[1]);

    /* Suggestion server-side filter — pass through when the toggle is active. */
    if (this.suggestedOnly()) {
      params.suggestedOnly = true;
      const target = this.suggestion()?.target;
      if (target != null) params.suggestionTarget = target;
      const budgetYear = this.suggestion()?.budgetYear;
      if (budgetYear) params.suggestionBudgetYear = budgetYear;
    }

    return params;
  }

  /**
   * Format a Date as YYYY-MM-DD using local components.
   * Why: toISOString() converts to UTC, which shifts the calendar day back
   * for users in negative offsets when the picker emits local-midnight dates.
   */
  private toLocalDateString(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  /**
   * Builds a ProjectQuery from current filter/pagination/sort state and
   * fetches the matching page from the API.
   */
  loadProjects(): void {
    this.loading.set(true);

    // Reflect the now-settled filter/sort/page state in the URL. loadProjects
    // is the single funnel every filter/sort/page change routes through (after
    // firstRow/pageSize/sort signals are already set), so syncing here pushes
    // exactly ONE history entry per committed change — no intermediate pushes
    // from individual signal writes, which is why this lives here rather than
    // in a reactive effect. The pushed entry is what the browser Back button
    // and the detail page's "Back" restore to.
    this.syncUrlFromState();

    // Refresh the context-aware dropdown options for the current filter set.
    // This is the single funnel for every filter change; the call dedupes
    // internally so pure pagination/sort changes don't refetch the facets.
    this.loadFilterOptions();

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
   * Fetches KPI summary aggregates for the whole portfolio.
   *
   * Intentionally ignores toolbar filters (search, center, funding, programs,
   * dates, mapping-status, in-negotiation, mapped, showExcluded) so the
   * Mapped % tile reflects the portfolio scope, not the currently visible
   * filtered rows. The backend still applies role scoping (center reps see
   * only their active center; program reps only projects mapped to their
   * program) and always excludes per-center excluded projects.
   */
  loadSummary(): void {
    this.summaryLoading.set(true);

    const query: Omit<ProjectQuery, 'page' | 'limit' | 'sortField' | 'sortOrder'> = {
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
   *
   * Like loadSummary, this runs against the whole portfolio (role-scoped on
   * the backend, excluded projects always filtered out) and intentionally
   * ignores the toolbar filters. The suggestion + what-if tiles measure
   * progress against the full portfolio target, so applying user filters
   * here would let the displayed % drift away from the real mapping goal.
   * Non-fatal on error.
   */
  loadSuggestion(): void {
    /* Skip the API call for roles that can't plan mappings — the
     * suggestion tile and what-if UI are hidden for them, so the
     * response would never be rendered. */
    if (!this.canPlanMappings()) {
      this.suggestionLoading.set(false);
      this.suggestion.set(null);
      return;
    }
    this.suggestionLoading.set(true);

    const query = {
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
   * Tracks the filter inputs the dropdown options were last fetched for, so
   * pure pagination/sort changes (which route through loadProjects but don't
   * affect the facets) don't trigger a redundant filter-options request.
   */
  private lastFacetFilterKey: string | null = null;

  /**
   * Refreshes the context-aware filter-dropdown options for the current
   * filter set. Each facet's options reflect every OTHER active filter, so
   * the dropdowns only offer values that would actually return projects.
   *
   * Deduplicated by a key over the filter params: when only page/sort/limit
   * changed (facets are independent of those) the request is skipped. The
   * active center/program are folded into the key because they scope the
   * backend via the X-Active-Center header (not a query param) — without
   * them, switching active center would reuse the previous center's options.
   * Non-fatal on failure — leaves the available sets untouched so the
   * dropdowns degrade to showing the full list.
   */
  private loadFilterOptions(): void {
    const params = this.buildFilterParams();
    /* Drop the suggestion knobs before computing facets. The facet endpoint
     * does NOT apply the greedy "Suggested set" narrowing (it's a list-only
     * filter); sending it would let the dropdowns offer values — e.g. a funder
     * outside the suggested pool — that intersect the suggested-ID set to an
     * empty list, breaking the "only show what's there" contract. Stripping
     * them also keeps the dedup key honest (toggling Suggested set doesn't
     * change the facets). */
    delete params.suggestedOnly;
    delete params.suggestionTarget;
    delete params.suggestionBudgetYear;

    const key = JSON.stringify({
      params,
      activeCenter: this.authService.activeCenterId(),
      activeProgram: this.authService.activeProgramId(),
    });
    if (key === this.lastFacetFilterKey) return;
    this.lastFacetFilterKey = key;

    this.projectsService.getFilterOptions(params).subscribe({
      next: (opts) => {
        this.availableFundingSources.set(opts.fundingSources ?? []);
        this.availableCenterIds.set(opts.centerIds ?? []);
        this.availableProgramIds.set(opts.programIds ?? []);
        this.funders.set(opts.funders ?? []);
        this.availableMappingStatuses.set(opts.mappingStatuses ?? []);
      },
      error: () => {
        /* Non-fatal — keep the previous option sets (dropdowns still work).
         * Clear the cached key so the next load retries instead of being
         * deduped away after a transient first-load failure. */
        this.lastFacetFilterKey = null;
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
    this.selectionSource.set('manual');
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
    this.selectionSource.set('suggested');
    this.selectedIds.set(next);
  }

  /**
   * Single click handler for the suggest button. When the suggested set is
   * already applied (`suggestedSetActive`), clicking clears it; otherwise it
   * applies the suggested set. This makes the button a visible on/off toggle
   * so users can un-pick the suggestion from the same control they used to
   * apply it.
   */
  toggleSuggestedSet(): void {
    if (this.suggestedSetActive()) {
      this.clearSelection();
    } else {
      this.useSuggestedSet();
    }
  }

  /**
   * Toggles the suggestedOnly filter on/off.
   * Flips the signal then triggers a server-side fetch so the API applies
   * the greedy suggestion algorithm against the current filter set.
   * Resets to page 1 so the user always lands on the first result page.
   */
  toggleSuggestedOnly(): void {
    this.suggestedOnly.update((v) => !v);
    this.firstRow.set(0);
    this.loadProjects();
  }

  /**
   * Called by p-table's (onLazyLoad) event whenever the page or sort changes.
   * Sort changes reset to page 1; page changes keep the current sort.
   */
  onLazyLoad(event: TableLazyLoadEvent): void {
    const newSortField = (event.sortField as string) ?? null;
    const newSortOrder = (event.sortOrder as 1 | -1) ?? 1;

    // p-table emits onLazyLoad once on init. With sort/page restored from the
    // URL (and primed into the table via [sortField]/[sortOrder]/[first]),
    // that first event echoes the current state — so skip it to avoid (a)
    // clobbering the restored sort/page and (b) firing a duplicate load on top
    // of the one the constructor effect already kicks off. After the first
    // real interaction this guard is off and every change flows through.
    if (!this.lazyLoadInitDone) {
      this.lazyLoadInitDone = true;
      const sameSort =
        newSortField === this.sortField() && newSortOrder === this.sortOrder();
      const samePage = (event.first ?? 0) === this.firstRow();
      if (sameSort && samePage) return;
    }

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

  /** False until p-table's first (init) onLazyLoad has been handled. */
  private lazyLoadInitDone = false;

  // -----------------------------------------------------------------------
  // Filter handlers
  // -----------------------------------------------------------------------

  /**
   * Called when any dropdown filter changes — reset to page 1, clear the
   * what-if selection (stale rows from the old filter set shouldn't persist),
   * and reload the table. KPI summary and suggestion tiles intentionally
   * stay pinned to the portfolio scope, so they don't reload on filter changes.
   */
  onFilterChange(): void {
    this.firstRow.set(0);
    this.clearSelection();
    this.loadProjects();
  }

  onCenterChange(value: number | null): void {
    this.selectedCenter.set(value);
    this.onFilterChange();
  }

  onMappingStatusChange(
    value:
      | 'locked'
      | 'in_negotiation'
      | 'negotiating'
      | 'ready_to_lock'
      | 'partially_allocated'
      | 'missing_toc'
      | 'draft'
      | 'admin_decision'
      | 'none'
      | null,
  ): void {
    this.selectedMappingStatus.set(value);
    this.onFilterChange();
  }

  onFundingChange(value: string | null): void {
    this.selectedFundingSource.set(value);
    this.onFilterChange();
  }

  onFunderChange(value: string | null): void {
    this.selectedFunder.set(value);
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

  /**
   * Toggle a negotiation-state filter chip. Clicking the active chip
   * clears the filter; clicking another chip switches to it (mutually
   * exclusive — "in negotiation" and "mapped" are independent buckets).
   */
  toggleNegotiationFilter(value: 'in-negotiation' | 'mapped'): void {
    this.negotiationStateFilter.update((current) => (current === value ? null : value));
    this.onFilterChange();
  }

  onStartDateRangeChange(value: Date[] | null): void {
    this.startDateRange.set(value);
    this.onFilterChange();
  }

  onEndDateRangeChange(value: Date[] | null): void {
    this.endDateRange.set(value);
    this.onFilterChange();
  }

  clearDateFilters(): void {
    this.startDateRange.set(null);
    this.endDateRange.set(null);
    this.onFilterChange();
  }

  /**
   * Clear every active filter at once (the "Clear all" button in the
   * active-filters bar). Resets all filter signals to their defaults and
   * reloads. `status` is left untouched — it has its own dropdown and is
   * not represented in the active-filters bar.
   */
  clearAllFilters(): void {
    this.searchControl.setValue('');
    this.searchTerm.set('');
    this.selectedCenter.set(null);
    this.selectedMappingStatus.set(null);
    this.selectedFundingSource.set(null);
    this.selectedFunder.set(null);
    this.selectedPrograms.set([]);
    this.negotiationStateFilter.set(null);
    this.startDateRange.set(null);
    this.endDateRange.set(null);
    this.showExcluded.set(false);
    this.suggestedOnly.set(false);
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

  /**
   * PrimeNG severity for the per-row negotiation icon, by whose turn it is:
   *   awaiting_me    → 'warn'  (amber, needs your action — also pulses)
   *   awaiting_other → 'info'  (blue, live but waiting on the other side)
   *   null/none      → 'secondary' (grey outline, no live negotiation)
   */
  negotiationIconSeverity(project: Project): 'warn' | 'info' | 'secondary' {
    if (project.negotiationTurn === 'awaiting_me') return 'warn';
    if (project.negotiationTurn === 'awaiting_other') return 'info';
    return 'secondary';
  }

  /** Tooltip for the per-row negotiation icon, matching the severity states. */
  negotiationIconTooltip(project: Project): string {
    if (project.negotiationTurn === 'awaiting_me') {
      return 'Negotiation — needs your action';
    }
    if (project.negotiationTurn === 'awaiting_other') {
      return 'Negotiation — waiting for the other side';
    }
    return 'Negotiation';
  }

  // -----------------------------------------------------------------------
  // Actions
  // -----------------------------------------------------------------------

  /**
   * Maps a derived mapping status to a PrimeNG Tag severity value for the
   * row badge in the projects list table.
   */
  getMappingStatusSeverity(
    ms: Project['mappingStatus'],
  ): 'success' | 'info' | 'warn' | 'secondary' {
    /* Color logic by user-perceived state, not by intuition about
     * "locked = red". Locked means the round is settled and fully
     * agreed — that's a positive outcome, so green/success. The
     * in-progress and not-yet-started buckets warm up from blue
     * (active) to amber (needs action), and "none" is neutral. */
    const map: Record<
      NonNullable<Project['mappingStatus']>,
      'success' | 'info' | 'warn' | 'secondary'
    > = {
      locked: 'success',
      admin_decision: 'success',
      in_negotiation: 'info',
      draft: 'warn',
      none: 'secondary',
    };
    return ms ? (map[ms] ?? 'secondary') : 'secondary';
  }

  /**
   * Returns the human-readable label for a derived mapping status value.
   */
  getMappingStatusLabel(ms: Project['mappingStatus']): string {
    const map: Record<NonNullable<Project['mappingStatus']>, string> = {
      locked: 'Locked - Solved by negotiation',
      admin_decision: 'Locked - Solved by admin decision',
      in_negotiation: 'In Negotiation',
      draft: 'Draft',
      none: 'Unmapped',
    };
    return ms ? (map[ms] ?? ms) : '—';
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

  // -----------------------------------------------------------------------
  // Export
  // -----------------------------------------------------------------------

  /** True while an Excel export request is in flight. */
  readonly exportLoading = signal(false);

  /**
   * Triggers a filtered Excel export using the current filter state.
   *
   * Passes the same filters as the table (no pagination/sort — the backend
   * exports all matching rows up to the server-side cap). Disabled when
   * the current result set is empty so users can't export a blank file.
   *
   * Shows a success toast when the download starts, and an error toast
   * for 400 (cap exceeded), 429 (throttled), or unexpected failures.
   */
  exportList(): void {
    if (this.exportLoading()) return;
    this.exportLoading.set(true);

    const query = {
      ...this.buildFilterParams(),
      budgetYear: 'FY26' as const,
    };

    this.exportService.exportList(query).subscribe({
      next: ({ filename }) => {
        this.exportLoading.set(false);
        this.messageService.add({
          severity: 'success',
          summary: 'Export started',
          detail: `Downloading ${filename}`,
          life: 4_000,
        });
      },
      error: (err: unknown) => {
        this.exportLoading.set(false);
        const status = (err as { status?: number })?.status;
        if (status === 429) {
          this.messageService.add({
            severity: 'warn',
            summary: 'Please wait',
            detail: 'Too many export requests. Try again in a minute.',
            life: 6_000,
          });
        } else if (status === 400) {
          const msg =
            (err as { error?: { message?: string } })?.error?.message ??
            'Filter matches too many projects. Please narrow your filters.';
          this.messageService.add({
            severity: 'error',
            summary: 'Export limit exceeded',
            detail: msg,
            life: 8_000,
          });
        } else {
          this.messageService.add({
            severity: 'error',
            summary: 'Export failed',
            detail: 'Could not generate the Excel file. Please try again.',
            life: 6_000,
          });
        }
      },
    });
  }

  // -----------------------------------------------------------------------
  // Exclusion actions (center_rep + admin)
  // -----------------------------------------------------------------------

  /**
   * Opens the exclude dialog for a project.
   *
   * Sets the form state then triggers PrimeNG Dialog's imperative show() method
   * so that the overlay renders within Angular's zone regardless of how the
   * button click was dispatched (including Playwright automation). Signal-only
   * binding via [visible] can miss the CD cycle when clicked outside NgZone.
   */
  openExcludeDialog(project: Project): void {
    this.projectToExclude = project;
    this.excludeReason.set('');
    this.excludeDialogVisible = true;
  }

  /** Closes the exclude dialog without submitting. */
  cancelExcludeDialog(): void {
    this.excludeDialogVisible = false;
    this.projectToExclude = null;
  }

  /**
   * Submits the exclusion. Validates reason length (min 5 chars) before
   * calling the API. On success, refreshes the project list and KPI strip.
   */
  submitExclude(): void {
    const project = this.projectToExclude;
    const reason = this.excludeReason().trim();

    if (!project || reason.length < 5) return;
    if (this.excludeLoading()) return;

    this.excludeLoading.set(true);
    this.projectsService.excludeProject(project.id, reason).subscribe({
      next: () => {
        this.excludeLoading.set(false);
        this.excludeDialogVisible = false;
        this.projectToExclude = null;
        this.messageService.add({
          severity: 'success',
          summary: 'Project excluded',
          detail: `"${project.name}" has been excluded from your center's view.`,
        });
        this.loadProjects();
        this.loadSummary();
      },
      error: (err: unknown) => {
        this.excludeLoading.set(false);
        const status = (err as { status?: number })?.status;
        this.messageService.add({
          severity: 'error',
          summary: 'Exclusion failed',
          detail:
            status === 409
              ? 'This project is already excluded.'
              : 'Failed to exclude the project. Please try again.',
        });
      },
    });
  }

  /**
   * Removes the exclusion for a project, restoring it to the center's
   * default view.
   */
  unexclude(project: Project): void {
    if (this.excludeLoading()) return;
    this.excludeLoading.set(true);

    /* Admin viewers see exclusions from any center, so we pass the exact
     * center id from the exclusion record to target the right row. Center
     * reps don't need it — the API uses their own centerId. */
    const targetCenterId =
      this.isAdmin() && project.exclusion ? project.exclusion.center.id : undefined;

    this.projectsService.unexcludeProject(project.id, targetCenterId).subscribe({
      next: () => {
        this.excludeLoading.set(false);
        this.messageService.add({
          severity: 'success',
          summary: 'Project restored',
          detail: `"${project.name}" is visible in your center's view again.`,
        });
        this.loadProjects();
        this.loadSummary();
      },
      error: () => {
        this.excludeLoading.set(false);
        this.messageService.add({
          severity: 'error',
          summary: 'Error',
          detail: 'Failed to restore the project. Please try again.',
        });
      },
    });
  }

  /**
   * Toggles the Show Excluded filter. Triggers a fresh data load so the
   * table immediately reflects the new visibility scope. KPI tiles stay
   * pinned to the portfolio scope and always exclude excluded projects,
   * so they don't reload here.
   */
  toggleShowExcluded(): void {
    this.showExcluded.update((v) => !v);
    this.firstRow.set(0);
    this.loadProjects();
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
