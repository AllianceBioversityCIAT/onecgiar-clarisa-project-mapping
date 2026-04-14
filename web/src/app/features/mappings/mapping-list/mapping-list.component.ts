import { Component, OnInit, OnDestroy, inject, signal, computed } from '@angular/core';
import { RouterLink, Router, ActivatedRoute } from '@angular/router';
import { CommonModule, DatePipe, TitleCasePipe } from '@angular/common';
import { FormControl, ReactiveFormsModule, FormsModule } from '@angular/forms';
import { Subject, debounceTime, distinctUntilChanged, takeUntil } from 'rxjs';

// PrimeNG imports
import { TableModule, TableLazyLoadEvent } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { SkeletonModule } from 'primeng/skeleton';
import { ToastModule } from 'primeng/toast';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { TooltipModule } from 'primeng/tooltip';
import { MessageService } from 'primeng/api';

import { MappingsService } from '../services/mappings.service';
import { AuthService } from '../../../core/services/auth.service';
import { ReferenceDataService } from '../../../core/services/reference-data.service';
import { Mapping, MappingQuery, MappingStatus } from '../models/mapping.model';

/** Dropdown option shape for status filter. */
interface SelectOption {
  label: string;
  value: string | null;
}

/**
 * MappingListComponent — server-side paginated table of program-project mappings.
 *
 * Role-based behaviour:
 *  - center_rep — sees mappings for their center's projects; can create new mappings
 *  - program_rep — sees negotiating/agreed/locked mappings for their program
 *  - admin — sees all mappings
 *
 * Actions navigate to the negotiation thread or project overview.
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
    ToastModule,
    IconFieldModule,
    InputIconModule,
    TooltipModule,
  ],
  providers: [DatePipe, TitleCasePipe],
  templateUrl: './mapping-list.component.html',
  styleUrl: './mapping-list.component.scss',
})
export class MappingListComponent implements OnInit, OnDestroy {
  private readonly mappingsService = inject(MappingsService);
  private readonly authService = inject(AuthService);
  private readonly refData = inject(ReferenceDataService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly messageService = inject(MessageService);

  private readonly destroy$ = new Subject<void>();

  // -----------------------------------------------------------------------
  // Auth signals
  // -----------------------------------------------------------------------

  readonly isProgramRep = this.authService.isProgramRep;
  readonly isCenterRep = this.authService.isCenterRep;
  readonly isAdmin = this.authService.isAdmin;

  readonly userCenterName = computed(() => {
    const user = this.authService.currentUser();
    if (user?.role !== 'center_rep' || !user.centerId) return '';
    const center = this.refData.centers().find((c) => c.id === user.centerId);
    return center ? center.name : '';
  });

  readonly userProgramName = computed(() => {
    const user = this.authService.currentUser();
    if (user?.role !== 'program_rep' || !user.programId) return '';
    const program = this.refData.programs().find((p) => p.id === user.programId);
    return program ? program.name : '';
  });

  // -----------------------------------------------------------------------
  // Table state
  // -----------------------------------------------------------------------

  readonly mappings = signal<Mapping[]>([]);
  readonly totalRecords = signal(0);
  readonly loading = signal(true);
  readonly pageSizeOptions = [10, 20, 50];
  readonly pageSize = signal(20);
  readonly firstRow = signal(0);
  readonly skeletonRows = computed(() => Array.from({ length: this.pageSize() }));

  // -----------------------------------------------------------------------
  // Filter controls
  // -----------------------------------------------------------------------

  readonly searchControl = new FormControl<string>('');
  readonly selectedStatus = signal<string | null>(null);
  readonly selectedProjectId = signal<number | null>(null);

  readonly statusOptions: SelectOption[] = [
    { label: 'All Statuses', value: null },
    { label: 'Draft', value: 'draft' },
    { label: 'Negotiating', value: 'negotiating' },
    { label: 'Agreed', value: 'agreed' },
    { label: 'Locked', value: 'locked' },
    { label: 'Removed', value: 'removed' },
  ];

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  ngOnInit(): void {
    this.refData.loadCenters();
    this.refData.loadPrograms();

    const params = this.route.snapshot.queryParams;
    if (params['status']) {
      this.selectedStatus.set(params['status']);
    }
    if (params['projectId']) {
      this.selectedProjectId.set(Number(params['projectId']));
    }

    this.searchControl.valueChanges
      .pipe(debounceTime(300), distinctUntilChanged(), takeUntil(this.destroy$))
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

  loadMappings(): void {
    this.loading.set(true);

    const query: MappingQuery = {
      page: Math.floor(this.firstRow() / this.pageSize()) + 1,
      limit: this.pageSize(),
    };

    const search = this.searchControl.value?.trim();
    if (search) query.search = search;
    if (this.selectedStatus()) query.status = this.selectedStatus()!;
    if (this.selectedProjectId()) query.projectId = this.selectedProjectId()!;

    this.mappingsService.getMappings(query).subscribe({
      next: (response) => {
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
  // Navigation
  // -----------------------------------------------------------------------

  viewNegotiation(mappingId: number): void {
    this.router.navigate(['/mappings', mappingId, 'negotiate']);
  }

  viewProjectOverview(projectId: number): void {
    this.router.navigate(['/mappings', 'project', projectId]);
  }

  // -----------------------------------------------------------------------
  // Display helpers
  // -----------------------------------------------------------------------

  getStatusSeverity(
    status: MappingStatus,
  ): 'secondary' | 'info' | 'success' | 'contrast' | 'danger' | 'warn' {
    const map: Record<MappingStatus, 'secondary' | 'info' | 'success' | 'contrast' | 'danger' | 'warn'> = {
      draft: 'secondary',
      negotiating: 'warn',
      agreed: 'success',
      locked: 'contrast',
      removed: 'danger',
    };
    return map[status] ?? 'info';
  }

  getAgreementIcon(agreed: boolean): string {
    return agreed ? 'pi pi-check-circle' : 'pi pi-circle';
  }

  getAgreementClass(agreed: boolean): string {
    return agreed ? 'agreement-yes' : 'agreement-no';
  }
}
