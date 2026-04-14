import {
  Component,
  OnInit,
  inject,
  signal,
  computed,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { CommonModule, DatePipe, TitleCasePipe } from '@angular/common';
import {
  ReactiveFormsModule,
  FormBuilder,
  FormGroup,
  Validators,
} from '@angular/forms';
import { firstValueFrom } from 'rxjs';

// PrimeNG imports
import { CardModule } from 'primeng/card';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { DialogModule } from 'primeng/dialog';
import { TextareaModule } from 'primeng/textarea';
import { ToastModule } from 'primeng/toast';
import { DividerModule } from 'primeng/divider';
import { SkeletonModule } from 'primeng/skeleton';
import { TooltipModule } from 'primeng/tooltip';
import { InputNumberModule } from 'primeng/inputnumber';
import { SliderModule } from 'primeng/slider';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { ConfirmationService, MessageService } from 'primeng/api';

import { MappingsService } from '../services/mappings.service';
import { AuthService } from '../../../core/services/auth.service';
import { Mapping, MappingNegotiation } from '../models/mapping.model';

/**
 * MappingNegotiationComponent — conversation-thread view for a single
 * mapping's negotiation history.
 *
 * Route: /mappings/:id/negotiate
 *
 * Renders a chronological thread of negotiation events (initiated,
 * counter_proposed, agreed, reopened) with contextual action buttons
 * that adapt to the current user's role and the mapping's status.
 *
 * Action availability:
 *  - "I Agree"          — negotiating + user hasn't agreed yet
 *  - "Counter-Propose"  — negotiating + user is center_rep or program_rep for this mapping
 *  - "Open Negotiation" — draft + user is center_rep for this project's center
 *  - "Remove Program"   — draft or negotiating + user is center_rep for this project's center
 */
@Component({
  selector: 'app-mapping-negotiation',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    RouterLink,
    CardModule,
    ButtonModule,
    TagModule,
    ConfirmDialogModule,
    DialogModule,
    TextareaModule,
    ToastModule,
    DividerModule,
    SkeletonModule,
    TooltipModule,
    InputNumberModule,
    SliderModule,
    ProgressSpinnerModule,
  ],
  providers: [ConfirmationService, MessageService, DatePipe, TitleCasePipe],
  templateUrl: './mapping-negotiation.component.html',
  styleUrl: './mapping-negotiation.component.scss',
})
export class MappingNegotiationComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly fb = inject(FormBuilder);
  private readonly mappingsService = inject(MappingsService);
  readonly authService = inject(AuthService);
  private readonly confirmationService = inject(ConfirmationService);
  private readonly messageService = inject(MessageService);

  // -----------------------------------------------------------------------
  // Auth shortcuts
  // -----------------------------------------------------------------------

  readonly isCenterRep = this.authService.isCenterRep;
  readonly isProgramRep = this.authService.isProgramRep;
  readonly isAdmin = this.authService.isAdmin;
  readonly currentUser = this.authService.currentUser;

  // -----------------------------------------------------------------------
  // State signals
  // -----------------------------------------------------------------------

  /** The loaded mapping, or null while loading / on error. */
  readonly mapping = signal<Mapping | null>(null);

  /** Chronological negotiation events for the thread. */
  readonly negotiations = signal<MappingNegotiation[]>([]);

  /** True while the initial fetch or re-fetch is in flight. */
  readonly loading = signal(true);

  /** True when the API returned an error or the mapping is not found. */
  readonly error = signal(false);

  /** True while an action API call (agree, open, remove, counter-propose) is in flight. */
  readonly submitting = signal(false);

  /** Controls visibility of the inline counter-propose form. */
  readonly showCounterProposeForm = signal(false);

  /** Controls visibility of the remove-with-justification dialog. */
  readonly showRemoveDialog = signal(false);

  // -----------------------------------------------------------------------
  // Computed action-button visibility
  // -----------------------------------------------------------------------

  /**
   * True when the current user can agree to the current negotiation terms.
   * Requires: status=negotiating AND the user's agreement flag is not yet set.
   */
  readonly canAgree = computed(() => {
    const m = this.mapping();
    const user = this.currentUser();
    if (!m || m.status !== 'negotiating' || !user) return false;

    if (user.role === 'center_rep' && user.centerId === m.project.center?.id) {
      return !m.centerAgreed;
    }
    if (user.role === 'program_rep' && user.programId === m.program.id) {
      return !m.programAgreed;
    }
    return false;
  });

  /**
   * True when the current user can submit a counter-proposal.
   * Requires: status=negotiating AND user is a party to this mapping.
   */
  readonly canCounterPropose = computed(() => {
    const m = this.mapping();
    const user = this.currentUser();
    if (!m || m.status !== 'negotiating' || !user) return false;

    if (user.role === 'center_rep' && user.centerId === m.project.center?.id) return true;
    if (user.role === 'program_rep' && user.programId === m.program.id) return true;
    return false;
  });

  /**
   * True when the current user can open (start) negotiation.
   * Requires: status=draft AND user is center_rep for this project's center.
   */
  readonly canOpen = computed(() => {
    const m = this.mapping();
    const user = this.currentUser();
    if (!m || m.status !== 'draft' || !user) return false;
    return user.role === 'center_rep' && user.centerId === m.project.center?.id;
  });

  /**
   * True when the current user can remove this program mapping.
   * Requires: status=draft or negotiating AND user is a party to this mapping
   * (center rep for the center, or program rep for the program).
   * Program reps cannot remove during draft (draft isn't visible to them).
   */
  readonly canRemove = computed(() => {
    const m = this.mapping();
    const user = this.currentUser();
    if (!m || !user) return false;
    if (m.status !== 'draft' && m.status !== 'negotiating') return false;
    if (user.role === 'center_rep' && user.centerId === m.project.center?.id) return true;
    if (user.role === 'program_rep' && user.programId === m.program.id && m.status === 'negotiating') return true;
    return false;
  });

  /** Label for the remove button — differs per role. */
  readonly removeButtonLabel = computed(() => {
    const user = this.currentUser();
    return user?.role === 'program_rep' ? 'Withdraw Program' : 'Remove Program';
  });

  /**
   * Status badge severity — maps mapping status to PrimeNG tag severity.
   */
  readonly statusSeverity = computed<'info' | 'success' | 'warn' | 'danger' | 'secondary'>(() => {
    const map: Record<string, 'info' | 'success' | 'warn' | 'danger' | 'secondary'> = {
      draft:       'secondary',
      negotiating: 'warn',
      agreed:      'success',
      locked:      'info',
      removed:     'danger',
    };
    return map[this.mapping()?.status ?? ''] ?? 'secondary';
  });

  // -----------------------------------------------------------------------
  // Counter-propose form
  // -----------------------------------------------------------------------

  /**
   * Reactive form for the inline counter-proposal.
   * proposedAllocation: integer 1–100.
   * justification: required text, min 10 chars.
   */
  readonly counterProposeForm: FormGroup = this.fb.group({
    proposedAllocation: [null, [Validators.required, Validators.min(1), Validators.max(100)]],
    justification: ['', [Validators.required, Validators.minLength(10)]],
  });

  /** Reactive form for the remove justification dialog. */
  readonly removeForm: FormGroup = this.fb.group({
    justification: ['', [Validators.required, Validators.minLength(10)]],
  });

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  ngOnInit(): void {
    const raw = this.route.snapshot.paramMap.get('id');
    if (!raw) {
      this.router.navigate(['/projects']);
      return;
    }
    this.loadThread(Number(raw));
  }

  // -----------------------------------------------------------------------
  // Data loading
  // -----------------------------------------------------------------------

  /** Fetches the negotiation thread and populates state signals. */
  private loadThread(mappingId: number): void {
    this.loading.set(true);
    this.error.set(false);

    this.mappingsService.getNegotiationThread(mappingId).subscribe({
      next: ({ mapping, negotiations }) => {
        this.mapping.set(mapping);
        this.negotiations.set(negotiations);
        this.loading.set(false);
      },
      error: () => {
        this.error.set(true);
        this.loading.set(false);
        this.messageService.add({
          severity: 'error',
          summary: 'Not Found',
          detail: 'Mapping could not be loaded.',
        });
      },
    });
  }

  /** Re-fetches the thread after any mutating action. */
  private reloadThread(): void {
    const id = this.mapping()?.id;
    if (id) this.loadThread(id);
  }

  // -----------------------------------------------------------------------
  // Agree action
  // -----------------------------------------------------------------------

  /** Marks the current user as agreeing to the current allocation terms. */
  async onAgree(): Promise<void> {
    const id = this.mapping()?.id;
    if (!id) return;

    this.submitting.set(true);
    try {
      await firstValueFrom(this.mappingsService.agree(id));
      this.messageService.add({
        severity: 'success',
        summary: 'Agreed',
        detail: 'You have agreed to the current terms.',
      });
      this.reloadThread();
    } catch {
      this.messageService.add({
        severity: 'error',
        summary: 'Error',
        detail: 'Failed to record your agreement. Please try again.',
      });
    } finally {
      this.submitting.set(false);
    }
  }

  // -----------------------------------------------------------------------
  // Open negotiation action
  // -----------------------------------------------------------------------

  /** Opens a ConfirmDialog then calls the open-negotiation endpoint. */
  openNegotiationDialog(): void {
    const m = this.mapping();
    if (!m) return;

    this.confirmationService.confirm({
      header: 'Open Negotiation',
      message: `Start negotiation with ${m.program.officialCode} — ${m.program.name} for project "${m.project.name}"?`,
      icon: 'pi pi-comments',
      acceptLabel: 'Open',
      rejectLabel: 'Cancel',
      accept: () => this.doOpenNegotiation(m.id),
    });
  }

  private async doOpenNegotiation(mappingId: number): Promise<void> {
    this.submitting.set(true);
    try {
      await firstValueFrom(this.mappingsService.openNegotiation(mappingId));
      this.messageService.add({
        severity: 'success',
        summary: 'Negotiation Opened',
        detail: 'Negotiation has been started.',
      });
      this.reloadThread();
    } catch {
      this.messageService.add({
        severity: 'error',
        summary: 'Error',
        detail: 'Failed to open negotiation. Please try again.',
      });
    } finally {
      this.submitting.set(false);
    }
  }

  // -----------------------------------------------------------------------
  // Remove program action
  // -----------------------------------------------------------------------

  /** Opens the remove-with-justification dialog. */
  openRemoveDialog(): void {
    this.removeForm.reset({ justification: '' });
    this.showRemoveDialog.set(true);
  }

  /** Closes the remove dialog without submitting. */
  cancelRemove(): void {
    this.showRemoveDialog.set(false);
    this.removeForm.reset();
  }

  /** Submits the removal with the provided justification. */
  async submitRemove(): Promise<void> {
    this.removeForm.markAllAsTouched();
    if (this.removeForm.invalid) return;

    const mappingId = this.mapping()?.id;
    if (!mappingId) return;

    const justification = this.removeForm.value.justification.trim();

    this.submitting.set(true);
    try {
      await firstValueFrom(
        this.mappingsService.removeProgram(mappingId, justification),
      );
      this.messageService.add({
        severity: 'warn',
        summary: 'Removed',
        detail: 'The mapping has been removed.',
      });
      this.showRemoveDialog.set(false);
      this.removeForm.reset();
      this.reloadThread();
    } catch {
      this.messageService.add({
        severity: 'error',
        summary: 'Error',
        detail: 'Failed to remove. Please try again.',
      });
    } finally {
      this.submitting.set(false);
    }
  }

  // -----------------------------------------------------------------------
  // Counter-propose form
  // -----------------------------------------------------------------------

  /** Shows the inline counter-propose form and resets it. */
  showCounterPropose(): void {
    this.counterProposeForm.reset({
      proposedAllocation: this.mapping()?.allocationPercentage ?? null,
      justification: '',
    });
    this.showCounterProposeForm.set(true);
  }

  /** Hides the inline counter-propose form without submitting. */
  cancelCounterPropose(): void {
    this.showCounterProposeForm.set(false);
    this.counterProposeForm.reset();
  }

  /** Validates and submits the counter-proposal form. */
  async submitCounterPropose(): Promise<void> {
    this.counterProposeForm.markAllAsTouched();
    if (this.counterProposeForm.invalid) return;

    const id = this.mapping()?.id;
    if (!id) return;

    const { proposedAllocation, justification } = this.counterProposeForm.value;
    this.submitting.set(true);
    try {
      await firstValueFrom(
        this.mappingsService.counterPropose(id, {
          proposedAllocation,
          justification: justification.trim(),
        }),
      );
      this.messageService.add({
        severity: 'success',
        summary: 'Counter-Proposal Submitted',
        detail: `Proposed ${proposedAllocation}% allocation sent.`,
      });
      this.showCounterProposeForm.set(false);
      this.counterProposeForm.reset();
      this.reloadThread();
    } catch {
      this.messageService.add({
        severity: 'error',
        summary: 'Error',
        detail: 'Failed to submit counter-proposal. Please try again.',
      });
    } finally {
      this.submitting.set(false);
    }
  }

  // -----------------------------------------------------------------------
  // Template helpers
  // -----------------------------------------------------------------------

  /**
   * Returns an object describing the visual treatment of a negotiation event.
   * Used in the template to apply correct icon, colour class and label.
   */
  getEventStyle(eventType: MappingNegotiation['eventType']): {
    cssClass: string;
    icon: string;
    label: string;
  } {
    const styles: Record<
      MappingNegotiation['eventType'],
      { cssClass: string; icon: string; label: string }
    > = {
      initiated:       { cssClass: 'event--initiated',        icon: 'pi pi-flag',            label: 'Initiated Negotiation'  },
      counter_proposed: { cssClass: 'event--counter-proposed', icon: 'pi pi-sync',            label: 'Counter-Proposed'       },
      agreed:          { cssClass: 'event--agreed',           icon: 'pi pi-check-circle',    label: 'Agreed to Terms'        },
      reopened:        { cssClass: 'event--reopened',         icon: 'pi pi-refresh',         label: 'Reopened Negotiation'   },
      removed:         { cssClass: 'event--removed',          icon: 'pi pi-times-circle',    label: 'Removed'                },
    };
    return styles[eventType] ?? { cssClass: '', icon: 'pi pi-circle', label: eventType };
  }

  /**
   * Returns a human-readable role label for the actor badge.
   */
  getRoleLabel(role: 'center_rep' | 'program_rep'): string {
    return role === 'center_rep' ? 'Center Rep' : 'Program Rep';
  }

  /** Navigation helper — go back to the project detail page. */
  goBack(): void {
    const projectId = this.mapping()?.project.id;
    if (projectId) {
      this.router.navigate(['/projects', projectId]);
    } else {
      this.router.navigate(['/projects']);
    }
  }

  /**
   * Returns the agreement status label for the current-terms card.
   * Center or program agreement is shown as a checkmark or pending indicator.
   */
  getAgreementIcon(agreed: boolean): string {
    return agreed ? 'pi pi-check-circle' : 'pi pi-clock';
  }
}
