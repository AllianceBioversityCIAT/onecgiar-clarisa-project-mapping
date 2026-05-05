import { Component, input, output, signal, computed, inject, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe, TitleCasePipe } from '@angular/common';

// PrimeNG
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { InputNumberModule } from 'primeng/inputnumber';
import { SelectModule } from 'primeng/select';
import { TooltipModule } from 'primeng/tooltip';
import { DialogModule } from 'primeng/dialog';
import { Popover, PopoverModule } from 'primeng/popover';
import { AvatarModule } from 'primeng/avatar';
import { MessageService } from 'primeng/api';

import { AuthService } from '../../../core/services/auth.service';
import { MappingsService } from '../services/mappings.service';
import { ReferenceDataService } from '../../../core/services/reference-data.service';
import {
  ConsolidatedMapping,
  ConsolidatedView,
  MappingStatus,
  Rating,
  RATING_OPTIONS,
} from '../models/mapping.model';

/**
 * ConsolidatedAllocationPaneComponent — right pane of the consolidated negotiation view.
 *
 * Shows the per-program allocation table. Each row has inline action buttons:
 *  - Agree (all authorized users on that mapping)
 *  - Counter-Propose (opens a p-popover with % + message form)
 *  - Remove Program (center rep / admin / workflow_admin only — opens a remove dialog)
 *  - Edit Allocation (program_rep only — opens a p-dialog with allocation %, complementarity
 *    rating, and efficiency rating fields; all three are required before saving)
 *
 * Rating chips (complementarity and efficiency) are rendered on their own sub-row
 * beneath the allocation %, and only appear when at least one rating is set.
 */
@Component({
  selector: 'app-consolidated-allocation-pane',
  standalone: true,
  imports: [
    FormsModule,
    TitleCasePipe,
    ButtonModule,
    TagModule,
    InputNumberModule,
    SelectModule,
    TooltipModule,
    DialogModule,
    PopoverModule,
    AvatarModule,
  ],
  providers: [DatePipe],
  template: `
    <!-- Totals / Add Program toolbar -->
    <div class="list-toolbar">
      <div class="list-toolbar__totals" [class]="unallocatedStateClass()">
        <span class="list-toolbar__label">Unallocated</span>
        <span class="list-toolbar__value">{{ data().unallocated }}%</span>
      </div>

      @if (canAddProgram()) {
        <p-button
          label="Add"
          icon="pi pi-plus"
          size="small"
          severity="primary"
          (onClick)="openAddDialog()"
        />
      }
    </div>

    <!-- Program list -->
    @if (activeMappings().length === 0) {
      <div class="list-empty">
        <i class="pi pi-inbox list-empty__icon"></i>
        <p>No program mappings yet.</p>
      </div>
    } @else {
      <ul class="program-list" role="list">
        @for (row of activeMappings(); track row.id) {
          <li class="program-row" [class.program-row--agreed]="row.status === 'agreed'">
            <p-avatar
              [label]="getProgramInitials(row.programName)"
              shape="circle"
              [styleClass]="'program-row__avatar program-row__avatar--' + row.status"
            />

            <div class="program-row__content">
              <div class="program-row__top">
                <span class="program-row__name">{{ row.programName }}</span>
                <p-tag
                  [value]="getStatusLabel(row.status)"
                  [severity]="getStatusSeverity(row.status)"
                  styleClass="program-row__status"
                />
                <!-- Needs Assistance flag — shown on non-agreed mappings only.
                     Defensive: backend clears the flag at agreement time, but we
                     also suppress it in the agreed state to avoid a brief blink. -->
                @if (row.needsAssistance && row.status !== 'agreed') {
                  <p-tag
                    severity="warn"
                    value="Needs Assistance"
                    styleClass="program-row__assist-badge"
                    [pTooltip]="
                      row.flaggedAt
                        ? 'Flagged on ' +
                          (datePipe.transform(row.flaggedAt, 'MMM d, y, h:mm a') ?? '')
                        : 'Flagged for workflow-admin review'
                    "
                    tooltipPosition="top"
                  />
                }
              </div>

              <!-- Bottom row: allocation % on the left, action buttons on the right -->
              <div class="program-row__bottom">
                <span class="program-row__pct">{{ row.allocationPercentage }}%</span>

                <!-- Action buttons — only shown when the round is unlocked -->
                @if (!isLocked()) {
                  <div class="program-row__actions">
                    <!-- Pencil is program_rep only; opens the edit-allocation dialog -->
                    @if (canEditRow(row)) {
                      <p-button
                        icon="pi pi-pencil"
                        size="small"
                        severity="secondary"
                        [text]="true"
                        [rounded]="true"
                        (onClick)="openEditDialog(row)"
                        pTooltip="Edit allocation"
                        tooltipPosition="top"
                      />
                    }

                    @if (canRemoveRow(row)) {
                      <p-button
                        icon="pi pi-trash"
                        size="small"
                        severity="danger"
                        [text]="true"
                        [rounded]="true"
                        [loading]="actionLoading()"
                        (onClick)="confirmRemove(row)"
                        pTooltip="Remove Program"
                        tooltipPosition="top"
                      />
                    }
                  </div>
                }
              </div>

              <!-- Rating chips row — only rendered when at least one rating is set -->
              @if (row.complementarityRating || row.efficiencyRating) {
                <div class="program-row__chips">
                  @if (row.complementarityRating) {
                    <p-tag
                      [severity]="ratingSeverity(row.complementarityRating)"
                      [value]="'Complementarity: ' + (row.complementarityRating | titlecase)"
                      styleClass="program-row__rating-chip"
                    />
                  }
                  @if (row.efficiencyRating) {
                    <p-tag
                      [severity]="ratingSeverity(row.efficiencyRating)"
                      [value]="'Efficiency: ' + (row.efficiencyRating | titlecase)"
                      styleClass="program-row__rating-chip"
                    />
                  }
                </div>
              }
            </div>
          </li>
        }
      </ul>
    }

    <!-- ----------------------------------------------------------------
         Counter-Propose popover (anchored via ViewChild counterPopoverRef)
         ---------------------------------------------------------------- -->
    <p-popover #counterPopover styleClass="counter-popover">
      @if (counterTarget()) {
        <div class="counter-form">
          <p class="counter-form__heading">Counter-Propose — {{ counterTarget()!.programName }}</p>
          <label class="counter-form__label">Proposed Allocation (%)</label>
          <p-inputnumber
            [(ngModel)]="counterPct"
            [min]="0"
            [max]="100"
            [step]="0.01"
            [maxFractionDigits]="2"
            styleClass="counter-form__input"
            placeholder="e.g. 35"
          />
          <label class="counter-form__label">Message (optional)</label>
          <textarea
            [(ngModel)]="counterMessage"
            rows="3"
            placeholder="Explain your proposal…"
            class="counter-form__textarea"
          ></textarea>

          <!-- Rating selects — program_rep only -->
          @if (isProgramRep()) {
            <label class="counter-form__label counter-form__label--required">
              Complementarity Rating
            </label>
            <p-select
              [(ngModel)]="counterComplementarityRating"
              [options]="ratingOptions"
              optionLabel="label"
              optionValue="value"
              placeholder="Select rating"
              appendTo="body"
              styleClass="counter-form__select"
            />
            <label class="counter-form__label counter-form__label--required">
              Efficiency Rating
            </label>
            <p-select
              [(ngModel)]="counterEfficiencyRating"
              [options]="ratingOptions"
              optionLabel="label"
              optionValue="value"
              placeholder="Select rating"
              appendTo="body"
              styleClass="counter-form__select"
            />
          }

          <div class="counter-form__btns">
            <p-button
              label="Save"
              icon="pi pi-check"
              size="small"
              [loading]="actionLoading()"
              [disabled]="isCounterSubmitDisabled()"
              (onClick)="submitCounter(counterPopoverRef)"
            />
            <p-button
              label="Cancel"
              icon="pi pi-times"
              size="small"
              severity="secondary"
              [outlined]="true"
              (onClick)="counterPopoverRef.hide()"
            />
          </div>
        </div>
      }
    </p-popover>

    <!-- ----------------------------------------------------------------
         Remove Program dialog
         ---------------------------------------------------------------- -->
    @if (removeDialogVisible()) {
      <div class="remove-dialog-overlay" (click)="cancelRemove()">
        <div class="remove-dialog" (click)="$event.stopPropagation()">
          <h3 class="remove-dialog__title">
            <i class="pi pi-trash"></i>
            Remove Program
          </h3>
          <p class="remove-dialog__subtitle">
            Removing <strong>{{ removingMapping()?.programName }}</strong> from this project. Please
            provide a justification.
          </p>
          <textarea
            [(ngModel)]="removeJustification"
            rows="4"
            placeholder="Reason for removing this program…"
            class="remove-dialog__textarea"
          ></textarea>
          <div class="remove-dialog__btns">
            <p-button
              label="Remove"
              icon="pi pi-trash"
              severity="danger"
              [disabled]="!removeJustification.trim()"
              [loading]="actionLoading()"
              (onClick)="submitRemove()"
            />
            <p-button
              label="Cancel"
              icon="pi pi-times"
              severity="secondary"
              [outlined]="true"
              (onClick)="cancelRemove()"
            />
          </div>
        </div>
      </div>
    }

    <!-- ----------------------------------------------------------------
         Add Program dialog
         ---------------------------------------------------------------- -->
    <p-dialog
      header="Add Program"
      [(visible)]="addDialogVisible"
      [modal]="true"
      [style]="{ width: '480px' }"
      [closable]="true"
      styleClass="add-program-dialog"
    >
      <div class="add-program-form">
        <label class="form-label">Program</label>
        <p-select
          [(ngModel)]="addProgramId"
          [options]="availablePrograms()"
          optionLabel="name"
          optionValue="id"
          placeholder="Select a program"
          [filter]="true"
          filterPlaceholder="Search programs…"
          appendTo="body"
          styleClass="form-select"
        />

        <label class="form-label">Initial Allocation (%)</label>
        <p-inputnumber
          [(ngModel)]="addPct"
          [min]="0"
          [max]="100"
          [step]="0.01"
          [maxFractionDigits]="2"
          placeholder="e.g. 25"
          styleClass="form-input"
        />
      </div>

      <ng-template #footer>
        <p-button
          label="Cancel"
          severity="secondary"
          [outlined]="true"
          (onClick)="closeAddDialog()"
        />
        <p-button
          label="Add Program"
          icon="pi pi-plus"
          [disabled]="!addProgramId || addPct === null"
          [loading]="actionLoading()"
          (onClick)="submitAddProgram()"
        />
      </ng-template>
    </p-dialog>

    <!-- ----------------------------------------------------------------
         Edit Allocation dialog.
         - program_rep: requires allocation % + both ratings (negotiation edit).
         - center_rep / admin / workflow_admin: only allowed on draft rows;
           ratings are hidden because drafts are pre-negotiation.
         ---------------------------------------------------------------- -->
    <p-dialog
      [header]="'Edit Mapping — ' + (editTarget()?.programName ?? '')"
      [(visible)]="editDialogVisible"
      [modal]="true"
      [style]="{ width: '440px' }"
      [closable]="true"
      (onHide)="closeEditDialog()"
      styleClass="edit-allocation-dialog"
    >
      <div class="edit-allocation-form">
        <label class="form-label form-label--required">Allocation (%)</label>
        <p-inputnumber
          [(ngModel)]="editPct"
          [min]="0"
          [max]="100"
          [step]="0.01"
          [maxFractionDigits]="2"
          placeholder="e.g. 25"
          styleClass="form-input"
        />

        @if (isProgramRep()) {
          <label class="form-label form-label--required">Complementarity Rating</label>
          <p-select
            [(ngModel)]="editComplementarityRating"
            [options]="ratingOptions"
            optionLabel="label"
            optionValue="value"
            placeholder="Select rating"
            appendTo="body"
            styleClass="form-select"
          />

          <label class="form-label form-label--required">Efficiency Rating</label>
          <p-select
            [(ngModel)]="editEfficiencyRating"
            [options]="ratingOptions"
            optionLabel="label"
            optionValue="value"
            placeholder="Select rating"
            appendTo="body"
            styleClass="form-select"
          />
        }
      </div>

      <ng-template #footer>
        <p-button
          label="Cancel"
          severity="secondary"
          [outlined]="true"
          (onClick)="closeEditDialog()"
        />
        <p-button
          label="Save"
          icon="pi pi-check"
          [disabled]="editPct === null || (isProgramRep() && (!editComplementarityRating || !editEfficiencyRating))"
          [loading]="actionLoading()"
          (onClick)="submitEditDialog()"
        />
      </ng-template>
    </p-dialog>

    <!-- ----------------------------------------------------------------
         Agree dialog — program_rep only, collects ratings before agreeing
         ---------------------------------------------------------------- -->
    <p-dialog
      header="Agree on Mapping"
      [(visible)]="agreeDialogVisible"
      [modal]="true"
      [style]="{ width: '420px' }"
      [closable]="true"
      (onHide)="cancelAgreeDialog()"
      styleClass="agree-rating-dialog"
    >
      <div class="agree-rating-form">
        <p class="agree-rating-form__hint">Please rate this mapping before agreeing.</p>

        <label class="form-label form-label--required">Complementarity Rating</label>
        <p-select
          [(ngModel)]="agreeComplementarityRating"
          [options]="ratingOptions"
          optionLabel="label"
          optionValue="value"
          placeholder="Select rating"
          appendTo="body"
          styleClass="agree-rating-form__select"
        />

        <label class="form-label form-label--required">Efficiency Rating</label>
        <p-select
          [(ngModel)]="agreeEfficiencyRating"
          [options]="ratingOptions"
          optionLabel="label"
          optionValue="value"
          placeholder="Select rating"
          appendTo="body"
          styleClass="agree-rating-form__select"
        />
      </div>

      <ng-template #footer>
        <p-button
          label="Cancel"
          severity="secondary"
          [outlined]="true"
          (onClick)="cancelAgreeDialog()"
        />
        <p-button
          label="Agree"
          icon="pi pi-check"
          severity="success"
          [disabled]="!agreeComplementarityRating || !agreeEfficiencyRating"
          [loading]="agreeLoadingId() !== null"
          (onClick)="submitAgreeDialog()"
        />
      </ng-template>
    </p-dialog>
  `,
  styleUrl: './consolidated-allocation-pane.component.scss',
})
export class ConsolidatedAllocationPaneComponent {
  private readonly authService = inject(AuthService);
  private readonly mappingsService = inject(MappingsService);
  private readonly referenceData = inject(ReferenceDataService);
  private readonly messageService = inject(MessageService);
  protected readonly datePipe = inject(DatePipe);

  // -----------------------------------------------------------------------
  // Inputs / Outputs
  // -----------------------------------------------------------------------

  /** Full consolidated view from the parent. */
  readonly data = input.required<ConsolidatedView>();

  /** Whether the project round is locked. */
  readonly isLocked = input<boolean>(false);

  /** Numeric project ID (needed for add-program). */
  readonly projectId = input.required<number>();

  /** Emits when an action completes so the parent reloads data. */
  readonly reload = output<void>();

  // -----------------------------------------------------------------------
  // Local state
  // -----------------------------------------------------------------------

  /** Reference to the counter-propose popover component. */
  @ViewChild('counterPopover') counterPopoverRef!: Popover;

  /** Generic action loading (add program, remove program, counter-propose, edit allocation). */
  readonly actionLoading = signal(false);

  /** Tracks which mapping is currently being agreed (shows spinner on that row). */
  readonly agreeLoadingId = signal<number | null>(null);

  /**
   * Edit Allocation dialog state (program_rep only).
   * editTarget holds the row being edited; the three form fields are plain properties
   * because they are only read on explicit submit (no reactive chain needed).
   */
  readonly editDialogVisible = signal(false);
  readonly editTarget = signal<ConsolidatedMapping | null>(null);
  editPct: number | null = null;
  editComplementarityRating: Rating | null = null;
  editEfficiencyRating: Rating | null = null;

  /** The mapping currently targeted by the counter-propose popover. */
  readonly counterTarget = signal<ConsolidatedMapping | null>(null);
  counterPct: number | null = null;
  counterMessage = '';

  /** Remove dialog state. */
  readonly removeDialogVisible = signal(false);
  readonly removingMapping = signal<ConsolidatedMapping | null>(null);
  removeJustification = '';

  /** Add Program dialog state. */
  addDialogVisible = false;
  addProgramId: number | null = null;
  addPct: number | null = null;

  /**
   * Agree dialog state — only shown to program_rep.
   * Holds the mapping being agreed and the two required ratings.
   */
  readonly agreeDialogVisible = signal(false);
  readonly agreeDialogMapping = signal<ConsolidatedMapping | null>(null);
  agreeComplementarityRating: Rating | null = null;
  agreeEfficiencyRating: Rating | null = null;

  /**
   * Rating selections inside the counter-propose popover.
   * Only rendered / validated when the current user is a program_rep.
   */
  counterComplementarityRating: Rating | null = null;
  counterEfficiencyRating: Rating | null = null;

  // -----------------------------------------------------------------------
  // Derived
  // -----------------------------------------------------------------------

  private readonly isCenterRep = this.authService.isCenterRep;
  private readonly isAdmin = this.authService.isAdmin;
  /** workflow_admin has the same cross-center negotiation rights as center_rep + admin. */
  private readonly isWorkflowAdmin = this.authService.isWorkflowAdmin;
  protected readonly isProgramRep = this.authService.isProgramRep;
  private readonly user = this.authService.currentUser;

  /** Rating options exposed to the template for p-select dropdowns. */
  readonly ratingOptions = RATING_OPTIONS;

  /** Non-removed mappings shown in the table. */
  readonly activeMappings = computed(() =>
    this.data().mappings.filter((m) => m.status !== 'removed'),
  );

  /** CSS state class for the unallocated totals pill. */
  readonly unallocatedStateClass = computed<string>(() => {
    const u = this.data().unallocated;
    if (u === 0) return 'list-toolbar__totals--ok';
    if (u > 0) return 'list-toolbar__totals--warn';
    return 'list-toolbar__totals--over';
  });

  /** Two-letter initials from a program name for the avatar fallback. */
  getProgramInitials(name: string): string {
    if (!name) return '?';
    const parts = name.trim().split(/\s+/);
    const first = parts[0]?.[0] ?? '';
    const second = parts[1]?.[0] ?? parts[0]?.[1] ?? '';
    return (first + second).toUpperCase();
  }

  /** Whether the current user can add a program. */
  readonly canAddProgram = computed(
    () => (this.isCenterRep() || this.isAdmin() || this.isWorkflowAdmin()) && !this.isLocked(),
  );

  /**
   * Programs available for addition — all programs from the reference service
   * minus those already mapped to this project.
   */
  readonly availablePrograms = computed(() => {
    const mapped = new Set(this.data().mappings.map((m) => m.programId));
    return this.referenceData.programs().filter((p) => !mapped.has(p.id));
  });

  // -----------------------------------------------------------------------
  // RBAC helpers
  // -----------------------------------------------------------------------

  /**
   * Returns true when the current user can Agree / Counter-Propose on a row.
   * Center rep / admin / workflow_admin: any non-locked row.
   * Program rep: only the row mapped to their own program.
   */
  canActOnRow(mapping: ConsolidatedMapping): boolean {
    if (this.isLocked()) return false;
    if (mapping.status === 'removed') return false;
    if (this.isCenterRep() || this.isAdmin() || this.isWorkflowAdmin()) return true;
    const u = this.user();
    return !!u && u.role === 'program_rep' && u.programId === mapping.programId;
  }

  /**
   * Returns true when the current user can open the edit-allocation dialog for a row.
   * - program_rep: can edit their own mapping during negotiation (rating fields required).
   * - center_rep / admin / workflow_admin: can edit a row only while it is in draft
   *   (pre-negotiation tweaking before Start Negotiation). Once negotiating, the
   *   center side uses Counter-Propose instead.
   */
  canEditRow(mapping: ConsolidatedMapping): boolean {
    if (this.isLocked()) return false;
    if (mapping.status === 'removed') return false;
    if (this.isProgramRep()) {
      return this.canActOnRow(mapping);
    }
    if (this.isCenterRep() || this.isAdmin() || this.isWorkflowAdmin()) {
      return mapping.status === 'draft';
    }
    return false;
  }

  /**
   * Returns true when the current user can remove a program row.
   * Center rep / admin / workflow_admin only; not for locked or already-removed rows.
   */
  canRemoveRow(mapping: ConsolidatedMapping): boolean {
    if (this.isLocked()) return false;
    if (!this.isCenterRep() && !this.isAdmin() && !this.isWorkflowAdmin()) return false;
    return mapping.status !== 'removed';
  }

  // -----------------------------------------------------------------------
  // Action — Agree
  // -----------------------------------------------------------------------

  /**
   * Entry point for the Agree button on each mapping row.
   *
   * - program_rep: opens the rating dialog first, agreement is submitted
   *   only after both ratings are provided (via submitAgreeDialog).
   * - all other roles: calls the API directly with no ratings.
   */
  agreeMapping(mapping: ConsolidatedMapping): void {
    if (this.isProgramRep()) {
      // Open the rating dialog — actual submission happens in submitAgreeDialog.
      this.agreeDialogMapping.set(mapping);
      this.agreeComplementarityRating = null;
      this.agreeEfficiencyRating = null;
      this.agreeDialogVisible.set(true);
    } else {
      this.sendAgree(mapping.id);
    }
  }

  /** Called by the Agree dialog footer for program_rep. */
  submitAgreeDialog(): void {
    const mapping = this.agreeDialogMapping();
    if (!mapping || !this.agreeComplementarityRating || !this.agreeEfficiencyRating) return;

    this.agreeDialogVisible.set(false);
    this.sendAgree(mapping.id, {
      complementarityRating: this.agreeComplementarityRating,
      efficiencyRating: this.agreeEfficiencyRating,
    });
  }

  cancelAgreeDialog(): void {
    this.agreeDialogVisible.set(false);
    this.agreeDialogMapping.set(null);
    this.agreeComplementarityRating = null;
    this.agreeEfficiencyRating = null;
  }

  /** Internal: posts to /agree with an optional ratings payload. */
  private sendAgree(
    mappingId: number,
    dto?: { complementarityRating?: Rating; efficiencyRating?: Rating },
  ): void {
    this.agreeLoadingId.set(mappingId);
    this.mappingsService.agree(mappingId, dto).subscribe({
      next: () => {
        this.messageService.add({
          severity: 'success',
          summary: 'Agreed',
          detail: 'You have agreed to the current allocation terms.',
        });
        this.reload.emit();
      },
      error: (err) => {
        this.messageService.add({
          severity: 'error',
          summary: 'Error',
          detail: err?.error?.message ?? 'Failed to submit agreement.',
        });
        this.agreeLoadingId.set(null);
      },
      complete: () => this.agreeLoadingId.set(null),
    });
  }

  // -----------------------------------------------------------------------
  // Action — Counter-Propose (popover)
  // -----------------------------------------------------------------------

  openCounterPopover(event: MouseEvent, mapping: ConsolidatedMapping): void {
    this.counterTarget.set(mapping);
    this.counterPct = null;
    this.counterMessage = '';
    this.counterComplementarityRating = null;
    this.counterEfficiencyRating = null;
    // Show the popover anchored to the clicked button element.
    this.counterPopoverRef.show(event);
  }

  /**
   * Whether the counter-propose Save button should be disabled.
   * For program_rep: both ratings are also required.
   * For other roles: only allocation % is required.
   */
  isCounterSubmitDisabled(): boolean {
    if (this.counterPct === null) return true;
    if (this.isProgramRep()) {
      return !this.counterComplementarityRating || !this.counterEfficiencyRating;
    }
    return false;
  }

  submitCounter(popover: Popover): void {
    const mapping = this.counterTarget();
    const pct = this.counterPct;
    if (!mapping || pct === null || pct < 0 || pct > 100) {
      this.messageService.add({
        severity: 'warn',
        summary: 'Invalid',
        detail: 'Please enter an allocation between 0 and 100.',
      });
      return;
    }

    // Build the DTO; program_rep must include ratings.
    const dto = this.isProgramRep()
      ? {
          proposedAllocation: pct,
          justification: this.counterMessage.trim(),
          complementarityRating: this.counterComplementarityRating ?? undefined,
          efficiencyRating: this.counterEfficiencyRating ?? undefined,
        }
      : {
          proposedAllocation: pct,
          justification: this.counterMessage.trim(),
        };

    this.actionLoading.set(true);
    this.mappingsService.counterPropose(mapping.id, dto).subscribe({
      next: () => {
        popover.hide();
        this.counterTarget.set(null);
        this.messageService.add({
          severity: 'success',
          summary: 'Counter-Proposal Submitted',
          detail: `Proposed ${pct}% sent.`,
        });
        this.reload.emit();
      },
      error: (err) => {
        this.messageService.add({
          severity: 'error',
          summary: 'Error',
          detail: err?.error?.message ?? 'Failed to submit counter-proposal.',
        });
        this.actionLoading.set(false);
      },
      complete: () => this.actionLoading.set(false),
    });
  }

  // -----------------------------------------------------------------------
  // Action — Remove Program
  // -----------------------------------------------------------------------

  confirmRemove(mapping: ConsolidatedMapping): void {
    this.removingMapping.set(mapping);
    this.removeJustification = '';
    this.removeDialogVisible.set(true);
  }

  cancelRemove(): void {
    this.removeDialogVisible.set(false);
    this.removingMapping.set(null);
    this.removeJustification = '';
  }

  submitRemove(): void {
    const mapping = this.removingMapping();
    if (!mapping || !this.removeJustification.trim()) return;

    this.actionLoading.set(true);
    this.mappingsService.removeProgram(mapping.id, this.removeJustification.trim()).subscribe({
      next: () => {
        this.removeDialogVisible.set(false);
        this.removingMapping.set(null);
        this.removeJustification = '';
        this.messageService.add({
          severity: 'info',
          summary: 'Program Removed',
          detail: `${mapping.programName} has been removed from this project.`,
        });
        this.reload.emit();
      },
      error: (err) => {
        this.messageService.add({
          severity: 'error',
          summary: 'Error',
          detail: err?.error?.message ?? 'Failed to remove program.',
        });
        this.actionLoading.set(false);
      },
      complete: () => this.actionLoading.set(false),
    });
  }

  // -----------------------------------------------------------------------
  // Edit Allocation dialog — program_rep only
  // -----------------------------------------------------------------------

  /**
   * Opens the edit-allocation dialog pre-populated from the given mapping row.
   * Ratings pre-fill when the row already has values; null means the user must pick.
   */
  openEditDialog(mapping: ConsolidatedMapping): void {
    this.editTarget.set(mapping);
    this.editPct = mapping.allocationPercentage;
    this.editComplementarityRating = mapping.complementarityRating ?? null;
    this.editEfficiencyRating = mapping.efficiencyRating ?? null;
    this.editDialogVisible.set(true);
  }

  closeEditDialog(): void {
    this.editDialogVisible.set(false);
    this.editTarget.set(null);
    this.editPct = null;
    this.editComplementarityRating = null;
    this.editEfficiencyRating = null;
  }

  submitEditDialog(): void {
    const mapping = this.editTarget();
    const pct = this.editPct;

    if (!mapping || pct === null || pct < 0 || pct > 100) {
      this.messageService.add({
        severity: 'warn',
        summary: 'Invalid',
        detail: 'Allocation must be between 0 and 100.',
      });
      return;
    }

    // Ratings are only required for program reps. Center reps editing a
    // draft don't fill ratings — that happens later when programs review.
    const isProgram = this.isProgramRep();
    if (isProgram && (!this.editComplementarityRating || !this.editEfficiencyRating)) {
      this.messageService.add({
        severity: 'warn',
        summary: 'Invalid',
        detail: 'Both Complementarity and Efficiency ratings are required.',
      });
      return;
    }

    this.actionLoading.set(true);
    this.mappingsService
      .updateAllocation(mapping.id, {
        allocationPercentage: pct,
        ...(isProgram
          ? {
              complementarityRating: this.editComplementarityRating!,
              efficiencyRating: this.editEfficiencyRating!,
            }
          : {}),
      })
      .subscribe({
        next: () => {
          this.closeEditDialog();
          this.messageService.add({
            severity: 'success',
            summary: 'Allocation Updated',
            detail: `Allocation set to ${pct}%.`,
          });
          this.reload.emit();
        },
        error: (err) => {
          this.messageService.add({
            severity: 'error',
            summary: 'Error',
            detail: err?.error?.message ?? 'Failed to update mapping.',
          });
          this.actionLoading.set(false);
        },
        complete: () => this.actionLoading.set(false),
      });
  }

  // -----------------------------------------------------------------------
  // Add Program dialog
  // -----------------------------------------------------------------------

  openAddDialog(): void {
    this.referenceData.loadPrograms();
    this.addProgramId = null;
    this.addPct = null;
    this.addDialogVisible = true;
  }

  closeAddDialog(): void {
    this.addDialogVisible = false;
  }

  submitAddProgram(): void {
    if (!this.addProgramId || this.addPct === null) return;

    this.actionLoading.set(true);
    this.mappingsService.addProgram(this.projectId(), this.addProgramId, this.addPct).subscribe({
      next: () => {
        this.addDialogVisible = false;
        this.messageService.add({
          severity: 'success',
          summary: 'Program Added',
          detail: 'The program has been added to the negotiation.',
        });
        this.reload.emit();
      },
      error: (err) => {
        this.messageService.add({
          severity: 'error',
          summary: 'Error',
          detail: err?.error?.message ?? 'Failed to add program.',
        });
      },
      complete: () => this.actionLoading.set(false),
    });
  }

  // -----------------------------------------------------------------------
  // Display helpers
  // -----------------------------------------------------------------------

  getStatusLabel(status: MappingStatus): string {
    const labels: Record<MappingStatus, string> = {
      draft: 'Draft',
      negotiating: 'Negotiating',
      agreed: 'Agreed',
      removed: 'Removed',
    };
    return labels[status] ?? status;
  }

  getStatusSeverity(
    status: MappingStatus,
  ): 'secondary' | 'warn' | 'success' | 'contrast' | 'danger' {
    const map: Record<MappingStatus, 'secondary' | 'warn' | 'success' | 'contrast' | 'danger'> = {
      draft: 'secondary',
      negotiating: 'warn',
      agreed: 'success',
      removed: 'danger',
    };
    return map[status] ?? 'secondary';
  }

  /**
   * Maps a rating value to a PrimeNG Tag severity.
   * high → success (green), medium → warn (amber), low → danger (red).
   * Null is guarded in the template so this path is rarely hit.
   */
  ratingSeverity(r: Rating | null): 'success' | 'warn' | 'danger' | 'info' {
    if (r === 'high') return 'success';
    if (r === 'medium') return 'warn';
    if (r === 'low') return 'danger';
    return 'info';
  }
}
