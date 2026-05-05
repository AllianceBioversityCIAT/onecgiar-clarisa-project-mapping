import { Component, OnInit, inject, signal, computed } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { CommonModule, DatePipe, CurrencyPipe, TitleCasePipe } from '@angular/common';

// PrimeNG imports
import { CardModule } from 'primeng/card';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { ChipModule } from 'primeng/chip';
import { ProgressBarModule } from 'primeng/progressbar';
import { Message } from 'primeng/message';
import { DividerModule } from 'primeng/divider';
import { SkeletonModule } from 'primeng/skeleton';
import { ToastModule } from 'primeng/toast';
import { TableModule } from 'primeng/table';
import { MessageService } from 'primeng/api';

import { AnaplanBadgeComponent } from '../../../shared/components/anaplan-badge/anaplan-badge.component';
import { ProjectAuditTabComponent } from './project-audit-tab.component';
import { ProjectsService } from '../services/projects.service';
import { ProjectsExportService } from '../services/projects-export.service';
import { MappingsService } from '../../mappings/services/mappings.service';
import { AuthService } from '../../../core/services/auth.service';
import { Project } from '../models/project.model';
import { AllocationSummary, Mapping } from '../../mappings/models/mapping.model';

/**
 * ProjectDetailComponent — read-only view of a single project.
 *
 * Sections:
 *  - General Info (code, name, description)
 *  - Budget & Funding (totals, funding source, funder)
 *  - Timeline (start/end dates)
 *  - Location (countries as chips)
 *  - Center (name + acronym)
 *  - Mapping Summary placeholder (Wave 5)
 *
 * Admin users see an "Edit Project" button.
 * Program reps see a "Map to My Program" button.
 * Archived projects display a prominent warning banner.
 */
@Component({
  selector: 'app-project-detail',
  standalone: true,
  imports: [
    CommonModule,
    RouterLink,
    CardModule,
    ButtonModule,
    TagModule,
    ChipModule,
    ProgressBarModule,
    Message,
    DividerModule,
    SkeletonModule,
    ToastModule,
    TableModule,
    AnaplanBadgeComponent,
    ProjectAuditTabComponent,
  ],
  providers: [MessageService, DatePipe, CurrencyPipe, TitleCasePipe],
  templateUrl: './project-detail.component.html',
  styleUrl: './project-detail.component.scss',
})
export class ProjectDetailComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly projectsService = inject(ProjectsService);
  private readonly exportService = inject(ProjectsExportService);
  private readonly mappingsService = inject(MappingsService);
  private readonly authService = inject(AuthService);
  private readonly messageService = inject(MessageService);

  // -----------------------------------------------------------------------
  // Auth
  // -----------------------------------------------------------------------

  readonly isAdmin = this.authService.isAdmin;
  readonly isProgramRep = this.authService.isProgramRep;
  readonly isCenterRep = this.authService.isCenterRep;
  readonly isUnitAdmin = this.authService.isUnitAdmin;
  readonly isWorkflowAdmin = this.authService.isWorkflowAdmin;

  /**
   * True when the current user is allowed to see the Edit History panel.
   * Visible to admin, unit_admin, and workflow_admin.
   */
  readonly canViewAuditHistory = computed(
    () => this.isAdmin() || this.isUnitAdmin() || this.isWorkflowAdmin(),
  );

  // -----------------------------------------------------------------------
  // State
  // -----------------------------------------------------------------------

  /** The loaded project, or null while loading / on error. */
  readonly project = signal<Project | null>(null);

  /** True while the project API call is in flight. */
  readonly loading = signal(true);

  /** True when the API returned an error or the project is not found. */
  readonly error = signal(false);

  /** Allocation summary for the review panel. */
  readonly allocationSummary = signal<AllocationSummary | null>(null);

  /** All mappings for this project, used in the review summary table. */
  readonly reviewMappings = signal<Mapping[]>([]);

  /** True while the allocation/review data is being fetched. */
  readonly loadingReview = signal(false);

  /** Expanded rows for the review summary table (rejected rows show reason). */
  readonly expandedRows = signal<Record<string, boolean>>({});

  // -----------------------------------------------------------------------
  // Derived
  // -----------------------------------------------------------------------

  readonly isArchived = computed(() => this.project()?.status === 'archived');

  readonly statusSeverity = computed<'success' | 'warn' | 'secondary'>(() => {
    const map: Record<string, 'success' | 'warn' | 'secondary'> = {
      active: 'success',
      draft: 'warn',
      archived: 'secondary',
    };
    return map[this.project()?.status ?? ''] ?? 'secondary';
  });

  readonly fundingLabel = computed(() => {
    const map: Record<string, string> = {
      window3: 'Window 3',
      bilateral: 'Bilateral',
      srv: 'SRV',
      other: 'Other',
    };
    return map[this.project()?.fundingSource ?? ''] ?? '';
  });

  /**
   * Sum of all budget line amounts for the footer row of the budget breakdown table.
   * Returns 0 when the project has no budgets.
   */
  readonly budgetTotal = computed(() =>
    /* MySQL decimal columns deserialize as strings through TypeORM, so we
     * coerce via Number() before summing — otherwise the reducer falls back
     * to string concatenation and breaks the CurrencyPipe downstream. */
    (this.project()?.budgets ?? []).reduce((sum, b) => sum + Number(b.amount ?? 0), 0),
  );

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  ngOnInit(): void {
    const raw = this.route.snapshot.paramMap.get('id');
    if (!raw) {
      this.router.navigate(['/projects']);
      return;
    }
    // Route params are always strings — coerce to integer before service calls.
    this.loadProject(Number(raw));
  }

  // -----------------------------------------------------------------------
  // Data loading
  // -----------------------------------------------------------------------

  private loadProject(id: number): void {
    this.loading.set(true);
    this.error.set(false);

    this.projectsService.getProject(id).subscribe({
      next: (project) => {
        this.project.set(project);
        this.loading.set(false);
        // Load allocation and review data in the background after the project loads.
        this.loadReviewData(id);
      },
      error: () => {
        this.error.set(true);
        this.loading.set(false);
        this.messageService.add({
          severity: 'error',
          summary: 'Not Found',
          detail: 'Project could not be loaded.',
        });
      },
    });
  }

  /**
   * Loads the allocation summary and full review mappings for the given project.
   * Called after the project detail is successfully loaded.
   */
  private loadReviewData(projectId: number): void {
    this.loadingReview.set(true);

    // Fetch both in parallel; failures are silently swallowed so the
    // main project detail view remains usable even without review data.
    Promise.all([
      this.mappingsService
        .getAllocationSummary(projectId)
        .toPromise()
        .catch(() => null),
      this.mappingsService
        .getReviewSummary(projectId)
        .toPromise()
        .catch(() => null),
    ]).then(([summary, mappings]) => {
      if (summary) this.allocationSummary.set(summary);
      if (mappings) this.reviewMappings.set(mappings.filter((m) => m.status !== 'removed'));
      this.loadingReview.set(false);
    });
  }

  // -----------------------------------------------------------------------
  // Review summary helpers
  // -----------------------------------------------------------------------

  /**
   * Maps a mapping status to a PrimeNG Tag severity.
   */
  getMappingStatusSeverity(status: string): 'info' | 'success' | 'danger' {
    const map: Record<string, 'info' | 'success' | 'danger'> = {
      pending: 'info',
      approved: 'success',
      rejected: 'danger',
    };
    return map[status] ?? 'info';
  }

  /** high → success (green), medium → warn (amber), low → danger (red). */
  getRatingSeverity(
    r: 'high' | 'medium' | 'low' | null | undefined,
  ): 'success' | 'warn' | 'danger' | 'info' {
    if (r === 'high') return 'success';
    if (r === 'medium') return 'warn';
    if (r === 'low') return 'danger';
    return 'info';
  }

  // -----------------------------------------------------------------------
  // Export
  // -----------------------------------------------------------------------

  /** True while an Excel export request is in flight for this project. */
  readonly exportLoading = signal(false);

  /**
   * Downloads the current project as a multi-sheet Excel workbook.
   *
   * Shows a success toast when the download starts and error toasts for
   * 429 (throttled) or unexpected failures.
   */
  exportProject(): void {
    const project = this.project();
    if (!project || this.exportLoading()) return;

    this.exportLoading.set(true);

    this.exportService.exportProject(project.id).subscribe({
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
  // Navigation helpers
  // -----------------------------------------------------------------------

  /** Navigates back to the project list. */
  goBack(): void {
    this.router.navigate(['/projects']);
  }
}
