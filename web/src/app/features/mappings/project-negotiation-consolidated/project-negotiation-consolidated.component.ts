import {
  Component,
  OnInit,
  OnDestroy,
  inject,
  signal,
  computed,
  effect,
  untracked,
  DestroyRef,
  WritableSignal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Subject, firstValueFrom } from 'rxjs';
import { auditTime } from 'rxjs/operators';

// PrimeNG
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { SkeletonModule } from 'primeng/skeleton';
import { ToastModule } from 'primeng/toast';
import { TooltipModule } from 'primeng/tooltip';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { ConfirmationService, MessageService } from 'primeng/api';

import { MappingsService } from '../services/mappings.service';
import { NegotiationSocketService } from '../services/negotiation-socket.service';
import { AuthService } from '../../../core/services/auth.service';
import { ConsolidatedMapping, ConsolidatedView } from '../models/mapping.model';
import { ConsolidatedChatPaneComponent } from './consolidated-chat-pane.component';
import { ConsolidatedAllocationPaneComponent } from './consolidated-allocation-pane.component';
import { TocContributionModalComponent } from './toc-contribution/toc-contribution.component';

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
    TocContributionModalComponent,
  ],
  providers: [ConfirmationService, MessageService],
  templateUrl: './project-negotiation-consolidated.component.html',
  styleUrl: './project-negotiation-consolidated.component.scss',
})
export class ProjectNegotiationConsolidatedComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly mappingsService = inject(MappingsService);
  private readonly messageService = inject(MessageService);
  private readonly confirmationService = inject(ConfirmationService);
  private readonly authService = inject(AuthService);
  private readonly negotiationSocket = inject(NegotiationSocketService);
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    // When the active center changes while the user is on the negotiation
    // page, decide whether to stay or navigate away:
    //  - center_rep: if the project belongs to a different center, navigate
    //    to /projects with an info toast (they have no negotiation rights
    //    on another center's project).
    //  - workflow_admin / admin / others: can access any project — just
    //    reload to pick up any center-scoped changes.
    // The guard short-circuits when data() is null (initial load) so
    // the effect does not fire before ngOnInit has set the project.
    effect(() => {
      // Track BOTH active-scope signals so the effect re-runs on either
      // a center switch (center_rep) or a program switch (program_rep).
      const activeCenterId = this.authService.activeCenterId();
      this.authService.activeProgramId(); // track reactive dependency (program_rep)

      // Read data() without registering it as a reactive dependency.
      // Tracking data() here would form a loop: effect fires → reads data() →
      // fetchData() sets data() → re-triggers effect.
      const view = untracked(() => this.data());

      if (!view) return; // initial load in progress — nothing to check yet

      if (this.authService.isCenterRep()) {
        // view.project.center.id is the owning center of this project.
        if (view.project?.center?.id !== activeCenterId) {
          this.messageService.add({
            severity: 'info',
            summary: 'Center switched',
            detail: 'Returning to the projects list.',
          });
          this.router.navigate(['/projects']);
          return;
        }
      }

      // Accessible in the new scope — reload negotiation data. For
      // program_rep, the backend re-scopes the mapping list to the
      // active program; if no mapping remains the page handles the
      // empty/forbidden response gracefully.
      const id = untracked(() => this.projectId());
      if (id) this.fetchData(id);
    });
  }

  /**
   * Coalesces bursts of socket pings into a single reload. When several
   * mutations land within a short window (e.g. counter + chat in quick
   * succession), we only re-fetch the consolidated view once.
   */
  private readonly reloadPing$ = new Subject<void>();

  // -----------------------------------------------------------------------
  // Auth signals
  // -----------------------------------------------------------------------

  /**
   * True for center_rep or workflow_admin.
   * Round-level management (Start Negotiation / Lock / Reopen) is the
   * center rep's responsibility. Admin and workflow_admin are read-only on
   * the negotiation surface — the workflow admin's only action is the
   * Final Decision (which locks the round itself).
   */
  readonly canManageRound = computed(() => this.authService.isCenterRep());

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

  /** True while a start-negotiation action is in flight. */
  readonly startingNegotiation = signal(false);

  // activeTabIndex removed — no per-program tabs in the new unified feed design.

  // -----------------------------------------------------------------------
  // Computed helpers
  // -----------------------------------------------------------------------

  readonly isLocked = computed(() => this.data()?.isLocked ?? false);

  /** Whether locking is currently permitted (all agreed, no over-allocation). */
  readonly canLock = computed(() => this.data()?.canLock ?? false);

  /**
   * True when at least one active (non-removed) mapping is still in draft status.
   * Used to show the Start Negotiation button and update the lock tooltip.
   */
  readonly hasDraftMappings = computed(() =>
    (this.data()?.mappings ?? []).some((m) => m.status === 'draft'),
  );

  /** Tooltip shown on the disabled Lock button. */
  readonly lockDisabledReason = computed<string>(() => {
    if (this.isLocked()) return 'The round is already locked.';
    if (!this.data()) return 'Loading…';
    if (this.hasDraftMappings()) {
      return 'All programs must be in Agreed status before locking. Some programs are still in draft — start negotiation first.';
    }
    return 'Negotiation can only be locked when every program is in the “Agreed” state and total allocation does not exceed 100%.';
  });

  /** PrimeNG Tag severity for the project status badge. */
  readonly statusSeverity = computed<'warn' | 'contrast' | 'secondary'>(() => {
    const d = this.data();
    if (!d) return 'secondary';
    if (d.isLocked) return 'contrast';
    if (!d.mappings || d.mappings.length === 0) return 'secondary';
    return 'warn';
  });

  /** Human-readable label for the project status badge. */
  readonly statusLabel = computed<string>(() => {
    const d = this.data();
    if (!d) return '—';
    if (d.isLocked) return 'Locked';
    if (!d.mappings || d.mappings.length === 0) return 'Unmapped';
    return 'In Negotiation';
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

    // Subscribe to realtime updates for this project. The gateway pings
    // a lightweight `negotiation:updated` event after every mutation;
    // we coalesce bursts so a fast sequence of changes triggers a
    // single re-fetch instead of one per event.
    this.reloadPing$
      .pipe(auditTime(250), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.fetchData(id));

    this.negotiationSocket.updates$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((evt) => {
      if (evt.projectId === id) {
        this.reloadPing$.next();
      }
    });

    this.negotiationSocket.joinProject(id);
  }

  ngOnDestroy(): void {
    this.negotiationSocket.leaveProject();
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
   *
   * After reopen, mappings revert to 'draft' status. Program reps will not
   * see them until the center rep clicks "Start Negotiation".
   */
  confirmReopen(): void {
    const view = this.data();
    if (!view) return;

    this.confirmationService.confirm({
      header: 'Reopen Negotiation Round',
      message:
        'Reopen the negotiation round? All programs will revert to draft status. Program reps will not see them until you click Start Negotiation.',
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
  // Start Negotiation
  // -----------------------------------------------------------------------

  /**
   * Opens a confirmation dialog then bulk-promotes all draft mappings to
   * 'negotiating', making them visible to program reps.
   * Only available to center_rep / admin / workflow_admin when NOT locked
   * and there is at least one draft mapping.
   */
  confirmStartNegotiation(): void {
    this.confirmationService.confirm({
      header: 'Start Negotiation',
      message:
        'This will make all draft programs visible to program reps and open them for negotiation. Are you ready to proceed?',
      icon: 'pi pi-send',
      acceptLabel: 'Start Negotiation',
      rejectLabel: 'Cancel',
      acceptButtonStyleClass: 'p-button-primary',
      accept: () => this.executeStartNegotiation(),
    });
  }

  private executeStartNegotiation(): void {
    const id = this.projectId();
    if (!id) return;

    this.startingNegotiation.set(true);
    this.mappingsService.startNegotiationRound(id).subscribe({
      next: () => {
        this.messageService.add({
          severity: 'success',
          summary: 'Negotiation started',
          detail: 'All draft programs are now visible to program reps.',
        });
        this.reload();
      },
      error: (err) => {
        this.messageService.add({
          severity: 'error',
          summary: 'Error',
          detail: err?.error?.message ?? 'Failed to start negotiation.',
        });
        this.startingNegotiation.set(false);
      },
      complete: () => this.startingNegotiation.set(false),
    });
  }

  // -----------------------------------------------------------------------
  // TOC Contribution modal — lifted from chat pane so both allocation
  // and chat panes can open it without duplicating state.
  // -----------------------------------------------------------------------

  /**
   * Controls the single shared TOC modal instance hosted in the parent
   * template. Both child panes emit (tocOpen) events which call onTocOpen().
   */
  readonly tocModalVisible: WritableSignal<boolean> = signal(false);
  readonly tocModalMapping = signal<ConsolidatedMapping | null>(null);
  readonly tocModalMode = signal<'agree' | 'edit' | 'readonly'>('agree');

  /**
   * Unified handler for TOC modal open requests from either child pane.
   * The mode 'agree' is emitted by the chat pane when the program rep clicks
   * Agree but TOC links are missing. Modes 'edit' and 'readonly' are emitted
   * by the allocation pane row icons.
   */
  onTocOpen(event: { mapping: ConsolidatedMapping; mode: 'agree' | 'edit' | 'readonly' }): void {
    this.tocModalMapping.set(event.mapping);
    this.tocModalMode.set(event.mode);
    this.tocModalVisible.set(true);
  }

  // -----------------------------------------------------------------------
  // Navigation
  // -----------------------------------------------------------------------

  goBack(): void {
    const id = this.projectId();
    this.router.navigate(id ? ['/projects', id] : ['/projects']);
  }
}
