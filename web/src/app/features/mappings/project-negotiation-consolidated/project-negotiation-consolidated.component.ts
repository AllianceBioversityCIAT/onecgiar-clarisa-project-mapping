import { Component, OnInit, inject, signal, computed } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

// PrimeNG
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { SkeletonModule } from 'primeng/skeleton';
import { ToastModule } from 'primeng/toast';
import { TooltipModule } from 'primeng/tooltip';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { ConfirmationService, MessageService } from 'primeng/api';

import { MappingsService } from '../services/mappings.service';
import { AuthService } from '../../../core/services/auth.service';
import { ConsolidatedView } from '../models/mapping.model';
import { ConsolidatedChatPaneComponent } from './consolidated-chat-pane.component';
import { ConsolidatedAllocationPaneComponent } from './consolidated-allocation-pane.component';

/**
 * ProjectNegotiationConsolidatedComponent — single-page negotiation UI.
 *
 * Route: /mappings/project/:projectId
 *
 * Owns the consolidated data signal and exposes reload() so child panes
 * (chat, allocation) can trigger a refresh after any mutation.
 *
 * Layout:
 *  - Project header (name, code, center, status) + Lock button (FE-4)
 *  - Locked amber banner + Reopen button (FE-4)
 *  - Two-pane body: left 55% (chat — FE-2), right 45% (allocation — FE-3)
 */
@Component({
  selector: 'app-project-negotiation-consolidated',
  standalone: true,
  imports: [
    RouterLink,
    ButtonModule,
    TagModule,
    SkeletonModule,
    ToastModule,
    TooltipModule,
    ConfirmDialogModule,
    ConsolidatedChatPaneComponent,
    ConsolidatedAllocationPaneComponent,
  ],
  providers: [ConfirmationService, MessageService],
  templateUrl: './project-negotiation-consolidated.component.html',
  styleUrl: './project-negotiation-consolidated.component.scss',
})
export class ProjectNegotiationConsolidatedComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly mappingsService = inject(MappingsService);
  private readonly messageService = inject(MessageService);
  private readonly confirmationService = inject(ConfirmationService);
  private readonly authService = inject(AuthService);

  // -----------------------------------------------------------------------
  // Auth signals
  // -----------------------------------------------------------------------

  /**
   * True for admin, center_rep, or workflow_admin.
   * All three can lock, reopen, add programs, and act on any mapping negotiation.
   */
  readonly isCenterRepOrAdmin = computed(
    () =>
      this.authService.isCenterRep() ||
      this.authService.isAdmin() ||
      this.authService.isWorkflowAdmin(),
  );

  // -----------------------------------------------------------------------
  // State
  // -----------------------------------------------------------------------

  /** Numeric project ID from the route param. */
  readonly projectId = signal<number | null>(null);

  /**
   * Consolidated API response. Null while loading or on error.
   * Passed into child panes via @Input().
   */
  readonly data = signal<ConsolidatedView | null>(null);

  /** True while the API call is in flight. */
  readonly loading = signal(true);

  /** True when the API returned a non-recoverable error. */
  readonly error = signal(false);

  /** True while a lock/reopen action is in flight. */
  readonly lockLoading = signal(false);

  // activeTabIndex removed — no per-program tabs in the new unified feed design.

  // -----------------------------------------------------------------------
  // Computed helpers
  // -----------------------------------------------------------------------

  readonly isLocked = computed(() => this.data()?.isLocked ?? false);

  /** Whether locking is currently permitted (all agreed, no over-allocation). */
  readonly canLock = computed(() => this.data()?.canLock ?? false);

  /** Tooltip shown on the disabled Lock button. */
  readonly lockDisabledReason = computed<string>(() => {
    if (this.isLocked()) return 'The round is already locked.';
    if (!this.data()) return 'Loading…';
    return 'Negotiation can only be locked when every program is in the “Agreed” state and total allocation does not exceed 100%.';
  });

  /** PrimeNG Tag severity for the project status badge. */
  readonly statusSeverity = computed<'warn' | 'contrast' | 'secondary'>(() => {
    const d = this.data();
    if (!d) return 'secondary';
    return d.isLocked ? 'contrast' : 'warn';
  });

  /** Human-readable label for the project status badge. */
  readonly statusLabel = computed<string>(() => {
    const d = this.data();
    if (!d) return '—';
    return d.isLocked ? 'Locked' : 'In Negotiation';
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
    this.fetchData(id);
  }

  // -----------------------------------------------------------------------
  // Data loading
  // -----------------------------------------------------------------------

  /**
   * Fetches the consolidated negotiation view from the API.
   * Called on init and by reload() after any child action.
   */
  private async fetchData(projectId: number): Promise<void> {
    this.loading.set(true);
    this.error.set(false);

    try {
      const view = await firstValueFrom(this.mappingsService.getConsolidatedNegotiation(projectId));
      this.data.set(view);
    } catch {
      this.error.set(true);
      this.messageService.add({
        severity: 'error',
        summary: 'Error',
        detail: 'Failed to load negotiation data. Please try again.',
      });
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Public reload hook exposed to child panes.
   * Called after any mutation (agree, counter-propose, remove, allocation edit, add program).
   */
  reload(): void {
    const id = this.projectId();
    if (id) {
      this.fetchData(id);
    }
  }

  // -----------------------------------------------------------------------
  // FE-4 — Lock / Reopen
  // -----------------------------------------------------------------------

  /**
   * Opens a confirmation dialog then locks the project round.
   * Only available to center_rep / admin when canLock is true.
   */
  confirmLock(): void {
    const view = this.data();
    if (!view) return;

    this.confirmationService.confirm({
      header: 'Lock Negotiation Round',
      message: `Lock the negotiation round for "${view.project.name}"? All agreed mappings will become locked and cannot be changed without reopening.`,
      icon: 'pi pi-lock',
      acceptLabel: 'Lock Round',
      rejectLabel: 'Cancel',
      acceptButtonStyleClass: 'p-button-primary',
      accept: () => this.executeLock(),
    });
  }

  private executeLock(): void {
    const id = this.projectId();
    if (!id) return;

    this.lockLoading.set(true);
    this.mappingsService.lockProjectRound(id).subscribe({
      next: () => {
        this.messageService.add({
          severity: 'success',
          summary: 'Round Locked',
          detail: 'The negotiation round has been locked.',
        });
        this.reload();
      },
      error: (err) => {
        this.messageService.add({
          severity: 'error',
          summary: 'Error',
          detail: err?.error?.message ?? 'Failed to lock the round.',
        });
        this.lockLoading.set(false);
      },
      complete: () => this.lockLoading.set(false),
    });
  }

  /**
   * Opens a confirmation dialog then reopens the locked project round.
   * Only available to center_rep / admin when the round is locked.
   */
  confirmReopen(): void {
    const view = this.data();
    if (!view) return;

    this.confirmationService.confirm({
      header: 'Reopen Negotiation Round',
      message: `Reopen the negotiation round for "${view.project.name}"? All agreed programs will revert to negotiating and both sides will need to re-confirm before the project can be locked again.`,
      icon: 'pi pi-lock-open',
      acceptLabel: 'Reopen Round',
      rejectLabel: 'Cancel',
      acceptButtonStyleClass: 'p-button-warning',
      accept: () => this.executeReopen(),
    });
  }

  private executeReopen(): void {
    const id = this.projectId();
    if (!id) return;

    this.lockLoading.set(true);
    this.mappingsService.reopenProjectRound(id).subscribe({
      next: () => {
        this.messageService.add({
          severity: 'info',
          summary: 'Round Reopened',
          detail: 'The negotiation round has been reopened.',
        });
        this.reload();
      },
      error: (err) => {
        this.messageService.add({
          severity: 'error',
          summary: 'Error',
          detail: err?.error?.message ?? 'Failed to reopen the round.',
        });
        this.lockLoading.set(false);
      },
      complete: () => this.lockLoading.set(false),
    });
  }

  // -----------------------------------------------------------------------
  // Navigation
  // -----------------------------------------------------------------------

  goBack(): void {
    const id = this.projectId();
    this.router.navigate(id ? ['/projects', id] : ['/projects']);
  }
}
