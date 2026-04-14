import {
  Component,
  OnInit,
  inject,
  signal,
  computed,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { CommonModule, TitleCasePipe } from '@angular/common';
import { firstValueFrom } from 'rxjs';

// PrimeNG imports
import { CardModule } from 'primeng/card';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { ProgressBarModule } from 'primeng/progressbar';
import { TableModule } from 'primeng/table';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { ToastModule } from 'primeng/toast';
import { TooltipModule } from 'primeng/tooltip';
import { SkeletonModule } from 'primeng/skeleton';
import { DividerModule } from 'primeng/divider';
import { ConfirmationService, MessageService } from 'primeng/api';

import { MappingsService } from '../services/mappings.service';
import { ProjectsService } from '../../projects/services/projects.service';
import { AuthService } from '../../../core/services/auth.service';
import { AllocationSummary, MappingStatus } from '../models/mapping.model';
import { Project } from '../../projects/models/project.model';

/**
 * ProjectNegotiationComponent — project-level view of all mappings
 * and their negotiation state for a single project.
 *
 * Route: /mappings/project/:projectId
 *
 * Shows:
 *  - Project header with name, code, center and overall status
 *  - Allocation progress bar (green at 100%, amber in-progress, red over 100%)
 *  - Mappings table with per-row negotiation actions
 *  - Project-level actions: Add Program, Lock Round, Reopen Round (center_rep only)
 */
@Component({
  selector: 'app-project-negotiation',
  standalone: true,
  imports: [
    CommonModule,
    RouterLink,
    CardModule,
    ButtonModule,
    TagModule,
    ProgressBarModule,
    TableModule,
    ConfirmDialogModule,
    ToastModule,
    TooltipModule,
    SkeletonModule,
    DividerModule,
  ],
  providers: [ConfirmationService, MessageService, TitleCasePipe],
  templateUrl: './project-negotiation.component.html',
  styleUrl: './project-negotiation.component.scss',
})
export class ProjectNegotiationComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly mappingsService = inject(MappingsService);
  private readonly projectsService = inject(ProjectsService);
  private readonly authService = inject(AuthService);
  private readonly confirmationService = inject(ConfirmationService);
  private readonly messageService = inject(MessageService);

  // -----------------------------------------------------------------------
  // Auth signals
  // -----------------------------------------------------------------------

  readonly isCenterRep = this.authService.isCenterRep;
  readonly isAdmin = this.authService.isAdmin;
  readonly isProgramRep = this.authService.isProgramRep;

  // -----------------------------------------------------------------------
  // State signals
  // -----------------------------------------------------------------------

  /** Numeric project ID extracted from the route param. */
  readonly projectId = signal<number | null>(null);

  /** Full project entity loaded from the API. */
  readonly project = signal<Project | null>(null);

  /** Allocation summary: total %, lock state, per-mapping list. */
  readonly allocationSummary = signal<AllocationSummary | null>(null);

  /** True while the initial data fetch is in flight. */
  readonly loading = signal(true);

  /** True when the API returned a non-recoverable error. */
  readonly error = signal(false);

  /** True while a lock / reopen / open-negotiation / remove action is in flight. */
  readonly actionLoading = signal(false);

  // -----------------------------------------------------------------------
  // Computed signals
  // -----------------------------------------------------------------------

  /** Whether center rep can lock the project round. */
  readonly canLock = computed(() => this.allocationSummary()?.canLock ?? false);

  /** Whether the project round is currently locked. */
  readonly isLocked = computed(() => this.allocationSummary()?.isLocked ?? false);

  /** Total percentage allocated across all active mappings. */
  readonly totalAllocated = computed(() => this.allocationSummary()?.totalAllocated ?? 0);

  /**
   * Progress bar value clamped to 100 so PrimeNG does not overflow
   * the bar visually (we still show the real number in the label).
   */
  readonly progressValue = computed(() => Math.min(this.totalAllocated(), 100));

  /**
   * CSS color class for the progress bar based on allocation state:
   *  - 100%     → green (complete)
   *  - > 100%   → red   (over-allocated)
   *  - otherwise → amber (in progress)
   */
  readonly progressSeverity = computed<'success' | 'warning' | 'danger'>(() => {
    const total = this.totalAllocated();
    if (total === 100) return 'success';
    if (total > 100) return 'danger';
    return 'warning';
  });

  /**
   * Human-readable tooltip explaining why the Lock button is disabled.
   * Empty string when locking is possible (tooltip not shown).
   */
  readonly lockDisabledReason = computed<string>(() => {
    if (this.isLocked()) return 'The round is already locked.';
    const summary = this.allocationSummary();
    if (!summary) return 'Loading allocation data…';
    if (summary.totalAllocated !== 100) {
      return `Allocation must reach 100% before locking (currently ${summary.totalAllocated}%).`;
    }
    if (!summary.isComplete) {
      return 'All mappings must be in the "agreed" state before locking.';
    }
    return '';
  });

  /** Overall project status badge derived from the allocation summary. */
  readonly projectStatusSeverity = computed<'secondary' | 'warn' | 'success' | 'contrast'>(() => {
    if (this.isLocked()) return 'contrast';
    const summary = this.allocationSummary();
    if (!summary || summary.mappings.length === 0) return 'secondary';
    if (summary.isComplete) return 'success';
    return 'warn';
  });

  readonly projectStatusLabel = computed<string>(() => {
    if (this.isLocked()) return 'Locked';
    const summary = this.allocationSummary();
    if (!summary || summary.mappings.length === 0) return 'Draft';
    if (summary.isComplete) return 'Agreed';
    return 'Negotiating';
  });

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  ngOnInit(): void {
    const raw = this.route.snapshot.paramMap.get('projectId');
    if (!raw) {
      this.router.navigate(['/projects']);
      return;
    }

    const id = Number(raw);
    this.projectId.set(id);
    this.loadData(id);
  }

  // -----------------------------------------------------------------------
  // Data loading
  // -----------------------------------------------------------------------

  /**
   * Loads the project detail and allocation summary in parallel.
   * Both are needed for the full page; a failure on either shows the error state.
   */
  private async loadData(projectId: number): Promise<void> {
    this.loading.set(true);
    this.error.set(false);

    try {
      const [project, summary] = await Promise.all([
        firstValueFrom(this.projectsService.getProject(projectId)),
        firstValueFrom(this.mappingsService.getAllocationSummary(projectId)),
      ]);

      this.project.set(project);
      this.allocationSummary.set(summary);
    } catch {
      this.error.set(true);
      this.messageService.add({
        severity: 'error',
        summary: 'Error',
        detail: 'Failed to load project negotiation data.',
      });
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Reloads only the allocation summary (used after actions that change
   * mapping state without needing a full project reload).
   */
  private async reloadSummary(): Promise<void> {
    const id = this.projectId();
    if (!id) return;

    try {
      const summary = await firstValueFrom(this.mappingsService.getAllocationSummary(id));
      this.allocationSummary.set(summary);
    } catch {
      this.messageService.add({
        severity: 'warn',
        summary: 'Warning',
        detail: 'Could not refresh allocation data.',
      });
    }
  }

  // -----------------------------------------------------------------------
  // Actions — Lock / Reopen
  // -----------------------------------------------------------------------

  /**
   * Shows a confirmation dialog then locks the project round.
   * All agreed mappings transition to "locked" status on the API side.
   */
  lockRound(): void {
    const project = this.project();
    if (!project) return;

    this.confirmationService.confirm({
      header: 'Lock Negotiation Round',
      message: `Lock the negotiation round for "${project.name}"? All agreed mappings will become locked and cannot be modified without reopening the round.`,
      icon: 'pi pi-lock',
      acceptLabel: 'Lock Round',
      rejectLabel: 'Cancel',
      acceptButtonStyleClass: 'p-button-primary',
      accept: () => {
        this.actionLoading.set(true);
        this.mappingsService.lockProjectRound(project.id).subscribe({
          next: () => {
            this.messageService.add({
              severity: 'success',
              summary: 'Round Locked',
              detail: 'The negotiation round has been locked successfully.',
            });
            this.reloadSummary().finally(() => this.actionLoading.set(false));
          },
          error: (err) => {
            this.actionLoading.set(false);
            this.messageService.add({
              severity: 'error',
              summary: 'Error',
              detail: err?.error?.message ?? 'Failed to lock the round.',
            });
          },
        });
      },
    });
  }

  /**
   * Shows a confirmation dialog then reopens a locked project round.
   * Locked mappings revert to "agreed" status, allowing re-negotiation.
   */
  reopenRound(): void {
    const project = this.project();
    if (!project) return;

    this.confirmationService.confirm({
      header: 'Reopen Negotiation Round',
      message: `Reopen the negotiation round for "${project.name}"? Locked mappings will return to "agreed" state and can be renegotiated.`,
      icon: 'pi pi-lock-open',
      acceptLabel: 'Reopen Round',
      rejectLabel: 'Cancel',
      acceptButtonStyleClass: 'p-button-warning',
      accept: () => {
        this.actionLoading.set(true);
        this.mappingsService.reopenProjectRound(project.id).subscribe({
          next: () => {
            this.messageService.add({
              severity: 'info',
              summary: 'Round Reopened',
              detail: 'The negotiation round has been reopened.',
            });
            this.reloadSummary().finally(() => this.actionLoading.set(false));
          },
          error: (err) => {
            this.actionLoading.set(false);
            this.messageService.add({
              severity: 'error',
              summary: 'Error',
              detail: err?.error?.message ?? 'Failed to reopen the round.',
            });
          },
        });
      },
    });
  }

  // -----------------------------------------------------------------------
  // Actions — per-mapping
  // -----------------------------------------------------------------------

  /**
   * Opens negotiation on a draft mapping.
   * Only available to center_rep on mappings in "draft" status.
   */
  openNegotiation(mappingId: number): void {
    this.actionLoading.set(true);
    this.mappingsService.openNegotiation(mappingId).subscribe({
      next: () => {
        this.messageService.add({
          severity: 'success',
          summary: 'Negotiation Opened',
          detail: 'The program has been invited to negotiate.',
        });
        this.reloadSummary().finally(() => this.actionLoading.set(false));
      },
      error: (err) => {
        this.actionLoading.set(false);
        this.messageService.add({
          severity: 'error',
          summary: 'Error',
          detail: err?.error?.message ?? 'Failed to open negotiation.',
        });
      },
    });
  }

  /**
   * Confirms then removes a program from the project's negotiation pool.
   * Available for draft or negotiating mappings (center_rep only).
   */
  removeMapping(mappingId: number, _programName: string): void {
    // Removal now requires a justification; handle it on the negotiation thread.
    this.router.navigate(['/mappings', mappingId, 'negotiate']);
  }

  // -----------------------------------------------------------------------
  // Navigation helpers
  // -----------------------------------------------------------------------

  /** Navigates to the negotiation thread for a specific mapping. */
  viewThread(mappingId: number): void {
    this.router.navigate(['/mappings', mappingId, 'negotiate']);
  }

  /** Navigates back to the project detail page. */
  goBack(): void {
    const projectId = this.projectId();
    if (projectId) {
      this.router.navigate(['/projects', projectId]);
    } else {
      this.router.navigate(['/projects']);
    }
  }

  // -----------------------------------------------------------------------
  // Display helpers
  // -----------------------------------------------------------------------

  /**
   * Maps a MappingStatus to a PrimeNG Tag severity value.
   *
   * Status  → Severity
   * draft        → secondary (gray)
   * negotiating  → warn (amber)
   * agreed       → success (green)
   * locked       → contrast (dark/blue)
   * removed      → danger (red)
   */
  getStatusSeverity(
    status: MappingStatus,
  ): 'secondary' | 'warn' | 'success' | 'contrast' | 'danger' {
    const map: Record<MappingStatus, 'secondary' | 'warn' | 'success' | 'contrast' | 'danger'> = {
      draft:       'secondary',
      negotiating: 'warn',
      agreed:      'success',
      locked:      'contrast',
      removed:     'danger',
    };
    return map[status] ?? 'secondary';
  }

  /**
   * Returns the human-readable label for a mapping status.
   * Capitalises the first letter for consistent display.
   */
  getStatusLabel(status: MappingStatus): string {
    return status.charAt(0).toUpperCase() + status.slice(1);
  }

  /**
   * True when the center_rep can remove a mapping.
   * Only draft and negotiating statuses are removable.
   */
  canRemoveMapping(status: MappingStatus): boolean {
    return status === 'draft' || status === 'negotiating';
  }

  /**
   * True when the center_rep can open negotiation on a mapping.
   * Only draft mappings can be moved into negotiation.
   */
  canOpenNegotiation(status: MappingStatus): boolean {
    return status === 'draft';
  }
}
