import {
  Component,
  OnInit,
  OnDestroy,
  inject,
  signal,
  computed,
} from '@angular/core';
import { RouterLink, Router, ActivatedRoute } from '@angular/router';
import { CommonModule, DatePipe, TitleCasePipe } from '@angular/common';
import { FormControl, ReactiveFormsModule, FormsModule } from '@angular/forms';
import {
  Subject,
  debounceTime,
  distinctUntilChanged,
  takeUntil,
} from 'rxjs';

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

import { MappingsService } from '../services/mappings.service';
import { AuthService } from '../../../core/services/auth.service';
import { ReferenceDataService } from '../../../core/services/reference-data.service';
import { Mapping, MappingQuery } from '../models/mapping.model';

/** Dropdown option shape for status filter. */
interface SelectOption {
  label: string;
  value: string | null;
}

/**
 * MappingListComponent — server-side paginated table of program-project mappings.
 *
 * Role-based behaviour:
 *  - program_rep  — sees own submissions; Edit/Delete actions on pending items
 *  - center_rep   — sees mappings for their center's projects; Review action on pending items
 *  - admin        — sees all mappings; no action buttons
 *
 * Filter toolbar: status Select + debounced text search by project name.
 * Status badges via PrimeNG Tag: pending=info, approved=success, rejected=danger.
 */
@Component({
  selector: 'app-mapping-list',
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
  providers: [ConfirmationService, MessageService, DatePipe, TitleCasePipe],
  templateUrl: './mapping-list.component.html',
  styleUrl: './mapping-list.component.scss',
})
export class MappingListComponent implements OnInit, OnDestroy {
  private readonly mappingsService = inject(MappingsService);
  private readonly authService = inject(AuthService);
  private readonly refData = inject(ReferenceDataService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly confirmationService = inject(ConfirmationService);
  private readonly messageService = inject(MessageService);

  private readonly destroy$ = new Subject<void>();

  // -----------------------------------------------------------------------
  // Auth signals
  // -----------------------------------------------------------------------

  readonly isProgramRep = this.authService.isProgramRep;
  readonly isCenterRep = this.authService.isCenterRep;
  readonly isAdmin = this.authService.isAdmin;

  /** Center name for the subtitle (center_rep only). */
  readonly userCenterName = computed(() => {
    const user = this.authService.currentUser();
    if (user?.role !== 'center_rep' || !user.centerId) return '';
    const center = this.refData.centers().find(c => c.id === user.centerId);
    return center ? center.name : '';
  });

  /** Program name for the subtitle (program_rep only). */
  readonly userProgramName = computed(() => {
    const user = this.authService.currentUser();
    if (user?.role !== 'program_rep' || !user.programId) return '';
    const program = this.refData.programs().find(p => p.id === user.programId);
    return program ? program.name : '';
  });

  // -----------------------------------------------------------------------
  // Table state
  // -----------------------------------------------------------------------

  /** Current page of mapping data. */
  readonly mappings = signal<Mapping[]>([]);

  /** Total records matching current filter (used by p-table paginator). */
  readonly totalRecords = signal(0);

  /** True while an API call is in flight. */
  readonly loading = signal(true);

  /** Rows per page options. */
  readonly pageSizeOptions = [10, 20, 50];

  /** Current page size — defaults to 20. */
  readonly pageSize = signal(20);

  /** Current page offset (zero-based first-row index for p-table). */
  readonly firstRow = signal(0);

  /** Skeleton row array mirrors pageSize while loading. */
  readonly skeletonRows = computed(() =>
    Array.from({ length: this.pageSize() }),
  );

  // -----------------------------------------------------------------------
  // Filter controls
  // -----------------------------------------------------------------------

  /** Debounced text search control bound to the search input. */
  readonly searchControl = new FormControl<string>('');

  /** Currently selected status filter value. */
  readonly selectedStatus = signal<string | null>(null);

  /** Project ID filter (set via query param from dashboard). */
  readonly selectedProjectId = signal<string | null>(null);

  readonly statusOptions: SelectOption[] = [
    { label: 'All Statuses', value: null },
    { label: 'Pending',      value: 'pending' },
    { label: 'Approved',     value: 'approved' },
    { label: 'Rejected',     value: 'rejected' },
  ];

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  ngOnInit(): void {
    // Load reference data for center/program name resolution (subtitle).
    this.refData.loadCenters();
    this.refData.loadPrograms();

    // Read query params to pre-apply filters (e.g. from dashboard links).
    const params = this.route.snapshot.queryParams;
    if (params['status']) {
      this.selectedStatus.set(params['status']);
    }
    if (params['projectId']) {
      this.selectedProjectId.set(params['projectId']);
    }

    // Wire the search input with debounce — resets to page 1 on each keystroke.
    this.searchControl.valueChanges
      .pipe(
        debounceTime(300),
        distinctUntilChanged(),
        takeUntil(this.destroy$),
      )
      .subscribe(() => {
        this.firstRow.set(0);
        this.loadMappings();
      });

    this.loadMappings();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  // -----------------------------------------------------------------------
  // Data loading
  // -----------------------------------------------------------------------

  /**
   * Builds a MappingQuery from current filter/pagination state
   * and fetches the matching page from the API.
   */
  loadMappings(): void {
    this.loading.set(true);

    const query: MappingQuery = {
      page:  Math.floor(this.firstRow() / this.pageSize()) + 1,
      limit: this.pageSize(),
    };

    const search = this.searchControl.value?.trim();
    if (search) query.search = search;
    if (this.selectedStatus()) query.status = this.selectedStatus()!;
    if (this.selectedProjectId()) query.projectId = this.selectedProjectId()!;

    this.mappingsService.getMappings(query).subscribe({
      next: response => {
        this.mappings.set(response.data);
        this.totalRecords.set(response.total);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.messageService.add({
          severity: 'error',
          summary: 'Error',
          detail: 'Failed to load mappings. Please try again.',
        });
      },
    });
  }

  /**
   * Called by p-table's (onLazyLoad) event on page/sort change.
   */
  onLazyLoad(event: TableLazyLoadEvent): void {
    this.firstRow.set(event.first ?? 0);
    this.pageSize.set(event.rows ?? 20);
    this.loadMappings();
  }

  // -----------------------------------------------------------------------
  // Filter handlers
  // -----------------------------------------------------------------------

  onStatusChange(value: string | null): void {
    this.selectedStatus.set(value);
    this.firstRow.set(0);
    this.loadMappings();
  }

  // -----------------------------------------------------------------------
  // Actions
  // -----------------------------------------------------------------------

  /**
   * Navigates to the mapping edit form.
   */
  editMapping(id: string): void {
    this.router.navigate(['/mappings', id, 'edit']);
  }

  /**
   * Opens a ConfirmDialog before deleting a pending mapping.
   * On acceptance calls the API and refreshes the list.
   */
  confirmDelete(mapping: Mapping): void {
    this.confirmationService.confirm({
      header: 'Delete Mapping',
      message: `Delete the mapping for "${mapping.project.name}" to ${mapping.program.name}? This action cannot be undone.`,
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Delete',
      rejectLabel: 'Cancel',
      acceptButtonStyleClass: 'p-button-danger',
      accept: () => {
        this.mappingsService.deleteMapping(mapping.id).subscribe({
          next: () => {
            this.messageService.add({
              severity: 'success',
              summary: 'Deleted',
              detail: 'Mapping deleted successfully.',
            });
            this.loadMappings();
          },
          error: () => {
            this.messageService.add({
              severity: 'error',
              summary: 'Error',
              detail: 'Failed to delete mapping.',
            });
          },
        });
      },
    });
  }

  // -----------------------------------------------------------------------
  // Display helpers
  // -----------------------------------------------------------------------

  /**
   * Maps a mapping status to a PrimeNG Tag severity.
   */
  getStatusSeverity(status: Mapping['status']): 'info' | 'success' | 'danger' {
    const map: Record<Mapping['status'], 'info' | 'success' | 'danger'> = {
      pending:  'info',
      approved: 'success',
      rejected: 'danger',
    };
    return map[status] ?? 'info';
  }

  /**
   * Humanises a complementarity/efficiency rating for display.
   */
  getRatingLabel(rating: string | null): string {
    if (!rating) return '—';
    return rating.charAt(0).toUpperCase() + rating.slice(1);
  }
}
