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
import { TagModule } from 'primeng/tag';
import { SkeletonModule } from 'primeng/skeleton';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { ToastModule } from 'primeng/toast';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { TooltipModule } from 'primeng/tooltip';
import { ConfirmationService, MessageService } from 'primeng/api';

import { ProjectsService } from '../services/projects.service';
import { ReferenceDataService } from '../../../core/services/reference-data.service';
import { AuthService } from '../../../core/services/auth.service';
import { Project, ProjectQuery } from '../models/project.model';
import { Center } from '../../../core/models/reference-data.model';

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
 *  - Center filter (populated from ReferenceDataService)
 *  - Status filter (All / Draft / Active / Archived)
 *  - Funding Source filter (All / Window 3 / Bilateral / SRV / Other)
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
    TagModule,
    SkeletonModule,
    ConfirmDialogModule,
    ToastModule,
    IconFieldModule,
    InputIconModule,
    TooltipModule,
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
  // Filter controls
  // -----------------------------------------------------------------------

  readonly searchControl = new FormControl<string>('');

  readonly selectedCenter = signal<number | null>(null);
  readonly selectedStatus = signal<string | null>(null);
  readonly selectedFundingSource = signal<string | null>(null);

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

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  ngOnInit(): void {
    // Load reference data for the center dropdown (if not already cached).
    this.refData.loadCenters();

    // Wire the search input with debounce — reset to page 1 on each keystroke.
    this.searchControl.valueChanges
      .pipe(debounceTime(300), distinctUntilChanged(), takeUntil(this.destroy$))
      .subscribe(() => {
        this.firstRow.set(0);
        this.loadProjects();
      });

    // Initial load
    this.loadProjects();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  // -----------------------------------------------------------------------
  // Data loading
  // -----------------------------------------------------------------------

  /**
   * Builds a ProjectQuery from current filter/pagination state and
   * fetches the matching page from the API.
   */
  loadProjects(): void {
    this.loading.set(true);

    const query: ProjectQuery = {
      page: Math.floor(this.firstRow() / this.pageSize()) + 1,
      limit: this.pageSize(),
    };

    const search = this.searchControl.value?.trim();
    if (search) query.search = search;
    if (this.selectedCenter()) query.centerId = this.selectedCenter()!;
    if (this.selectedStatus()) query.status = this.selectedStatus()!;
    if (this.selectedFundingSource()) query.fundingSource = this.selectedFundingSource()!;

    this.projectsService.getProjects(query).subscribe({
      next: (response) => {
        this.projects.set(response.data);
        this.totalRecords.set(response.total);
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
   * Called by p-table's (onLazyLoad) event whenever the page or sort changes.
   */
  onLazyLoad(event: TableLazyLoadEvent): void {
    this.firstRow.set(event.first ?? 0);
    this.pageSize.set(event.rows ?? 20);
    this.loadProjects();
  }

  // -----------------------------------------------------------------------
  // Filter handlers
  // -----------------------------------------------------------------------

  /** Called when any dropdown filter changes — reset to page 1. */
  onFilterChange(): void {
    this.firstRow.set(0);
    this.loadProjects();
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
