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
 *  - Agree (all authorized users on that mapping; no body, no ratings — agree
 *    only confirms current terms)
 *  - Edit Ratings (center_rep / workflow_admin only; opens a p-dialog scoped to
 *    complementarity + efficiency. Allowed on any non-removed row including
 *    draft. Saves via updateAllocation with the unchanged % so the backend
 *    appends a RATING_UPDATED event without resetting agreement flags.)
 *  - Counter-Propose (opens a p-popover with % + justification form; no ratings.
 *    Hidden on draft rows — draft allocation is set via the create flow.)
 *  - Remove Program (center rep / workflow_admin on any row; program_rep on
 *    their own row to raise a removal request — opens a dialog requiring a
 *    justification)
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
      } @else if (showMappingCapHint()) {
        <span
          class="list-toolbar__hint"
          pTooltip="A project can have at most 3 program mappings. Remove an existing program to add a new one."
        >
          <i class="pi pi-info-circle"></i> Max 3 programs reached
        </span>
      }

      @if (canMakeFinalDecision()) {
        <p-button
          label="Final Decision"
          icon="pi pi-verified"
          size="small"
          severity="success"
          [outlined]="true"
          (onClick)="openFinalDecision()"
          pTooltip="Set the binding allocations and lock the project (workflow admin)"
          tooltipPosition="top"
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
                <!-- Needs Assistance flag — icon-only badge with tooltip. Shown on
                     non-agreed mappings only. Defensive: backend clears the flag at
                     agreement time, but we also suppress it in the agreed state to
                     avoid a brief blink. -->
                @if (row.needsAssistance && row.status !== 'agreed') {
                  <span
                    class="program-row__assist-badge"
                    role="img"
                    aria-label="Needs assistance"
                    [pTooltip]="
                      'Needs assistance: this mapping has been flagged for workflow-admin review' +
                      (row.flaggedAt
                        ? ' (flagged on ' +
                          (datePipe.transform(row.flaggedAt, 'MMM d, y, h:mm a') ?? '') +
                          ')'
                        : '.')
                    "
                    tooltipPosition="top"
                  >
                    <i class="pi pi-flag-fill"></i>
                  </span>
                }
              </div>

              <!-- Bottom row: allocation % on the left, action buttons on the right -->
              <div class="program-row__bottom">
                <span class="program-row__pct">{{ row.allocationPercentage }}%</span>

                <!-- Action buttons. Negotiation actions (ratings, counter,
                     remove) only show while unlocked; the TOC icons below
                     stay available even after lock since TOC information can
                     be provided at any time. -->
                <div class="program-row__actions">
                  @if (!isLocked()) {
                    <!-- Edit ratings — center side only. Opens the edit
                         dialog scoped to complementarity + efficiency.
                         Available on draft and during negotiation, since
                         ratings are a parallel center-side concern and do
                         not reset agreement flags. -->
                    @if (canEditRatings(row)) {
                      <p-button
                        icon="pi pi-pencil"
                        size="small"
                        severity="secondary"
                        [text]="true"
                        [rounded]="true"
                        (onClick)="openEditDialog(row)"
                        pTooltip="Edit ratings"
                        tooltipPosition="top"
                      />
                    }

                    <!-- Propose / Counter-propose allocation — opens the
                         popover (% + justification). On draft rows (typically
                         after a reopen) the label reads "Propose" since the
                         center is making the first offer of the round; on
                         negotiating / agreed rows it reads "Counter-Propose". -->
                    @if (canCounterProposeRow(row)) {
                      <p-button
                        icon="pi pi-reply"
                        size="small"
                        severity="secondary"
                        [text]="true"
                        [rounded]="true"
                        (onClick)="openCounterPopover($event, row)"
                        [pTooltip]="proposeLabel(row)"
                        tooltipPosition="top"
                      />
                    }

                    <!-- Trash is the entry point for both flows:
                         - program rep: opens "Request removal" dialog
                         - center side: opens "Remove" dialog
                         While a program-rep request is pending, the trash
                         is disabled for everyone — the center side resolves
                         it from the chat thread (Accept / Decline buttons
                         on the removal_requested card). -->
                    @if (canRemoveRow(row)) {
                      <p-button
                        icon="pi pi-trash"
                        size="small"
                        severity="danger"
                        [text]="true"
                        [rounded]="true"
                        [loading]="actionLoading()"
                        [disabled]="row.removalRequested"
                        (onClick)="confirmRemove(row)"
                        [pTooltip]="
                          row.removalRequested
                            ? 'Removal request pending — resolve it in the chat'
                            : isProgramRep()
                              ? 'Request removal'
                              : 'Remove Program'
                        "
                        tooltipPosition="top"
                      />
                    }
                  }

                  <!-- TOC contribution — edit (program rep) or view
                       (center-side roles). Both shown as a sitemap icon
                       matching the Programs pane header. The edit variant is
                       available whenever the mapping is active (including on
                       locked rounds). The view variant is only shown when TOC
                       links have been saved (nothing to display otherwise). -->
                  @if (canEditTocOnRow(row)) {
                    <p-button
                      icon="pi pi-share-alt"
                      size="small"
                      severity="secondary"
                      [text]="true"
                      [rounded]="true"
                      pTooltip="Edit TOC contribution"
                      tooltipPosition="top"
                      (onClick)="tocOpen.emit({ mapping: row, mode: 'edit' })"
                    />
                  } @else if (canViewTocOnRow(row)) {
                    <p-button
                      icon="pi pi-share-alt"
                      size="small"
                      severity="secondary"
                      [text]="true"
                      [rounded]="true"
                      pTooltip="View TOC contribution"
                      tooltipPosition="top"
                      (onClick)="tocOpen.emit({ mapping: row, mode: 'readonly' })"
                    />
                  }
                </div>
              </div>

              <!-- Pending removal banner — visible to all sides while a
                   program-rep request is unresolved. Tells the program rep
                   their request is in flight; tells the center side what
                   they need to act on. -->
              @if (row.removalRequested) {
                <div class="program-row__removal-banner">
                  <i class="pi pi-clock program-row__removal-icon"></i>
                  <div class="program-row__removal-text">
                    <span class="program-row__removal-title">
                      Removal requested by program rep
                    </span>
                    @if (row.removalJustification) {
                      <span class="program-row__removal-reason">
                        "{{ row.removalJustification }}"
                      </span>
                    }
                  </div>
                </div>
              }

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
          <p class="counter-form__heading">
            {{ proposeLabel(counterTarget()) }} — {{ counterTarget()!.programName }}
          </p>
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
          <label class="counter-form__label form-label--required">Justification</label>
          <textarea
            [(ngModel)]="counterMessage"
            rows="3"
            placeholder="Explain your proposal (min 10 chars)…"
            class="counter-form__textarea"
          ></textarea>

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
         Remove / Request-Removal dialog (copy adapts to actor role).
         For center side, this is "Remove Program" (immediate). For
         program rep, this is "Request removal" — submission posts a
         pending request that the center must accept.
         ---------------------------------------------------------------- -->
    @if (removeDialogVisible()) {
      <div class="remove-dialog-overlay" (click)="cancelRemove()">
        <div class="remove-dialog" (click)="$event.stopPropagation()">
          <h3 class="remove-dialog__title">
            <i class="pi pi-trash"></i>
            {{ isProgramRep() ? 'Request Removal' : 'Remove Program' }}
          </h3>
          <p class="remove-dialog__subtitle">
            @if (isProgramRep()) {
              Asking the center to remove
              <strong>{{ removingMapping()?.programName }}</strong> from this project. Please
              provide a justification — the center side will see your reason and accept or decline.
            } @else {
              Removing <strong>{{ removingMapping()?.programName }}</strong> from this project.
              Please provide a justification.
            }
          </p>
          <label class="form-label form-label--required">Justification</label>
          <textarea
            [(ngModel)]="removeJustification"
            rows="4"
            [placeholder]="
              isProgramRep()
                ? 'Reason for requesting removal…'
                : 'Reason for removing this program…'
            "
            class="remove-dialog__textarea"
          ></textarea>
          <div class="remove-dialog__btns">
            <p-button
              [label]="isProgramRep() ? 'Submit request' : 'Remove'"
              [icon]="isProgramRep() ? 'pi pi-send' : 'pi pi-trash'"
              [severity]="isProgramRep() ? 'warn' : 'danger'"
              [disabled]="removeJustification.trim().length < 10"
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
        <label class="form-label form-label--required">Program</label>
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

        <label class="form-label form-label--required">Initial Allocation (%)</label>
        <p-inputnumber
          [(ngModel)]="addPct"
          [min]="0"
          [max]="100"
          [step]="0.01"
          [maxFractionDigits]="2"
          placeholder="e.g. 25"
          styleClass="form-input"
        />

        <label class="form-label form-label--required">Complementarity Rating</label>
        <p-select
          [(ngModel)]="addComplementarityRating"
          [options]="ratingOptions"
          optionLabel="label"
          optionValue="value"
          placeholder="Select rating"
          appendTo="body"
          styleClass="form-select"
        />

        <label class="form-label form-label--required">Efficiency Rating</label>
        <p-select
          [(ngModel)]="addEfficiencyRating"
          [options]="ratingOptions"
          optionLabel="label"
          optionValue="value"
          placeholder="Select rating"
          appendTo="body"
          styleClass="form-select"
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
          [disabled]="
            !addProgramId || addPct === null || !addComplementarityRating || !addEfficiencyRating
          "
          [loading]="actionLoading()"
          (onClick)="submitAddProgram()"
        />
      </ng-template>
    </p-dialog>

    <!-- ----------------------------------------------------------------
         Edit Ratings dialog. Center-side only (admin is read-only and
         program reps never set ratings). Allocation changes use the
         separate Counter-Propose popover, since changing % resets
         agreement flags whereas ratings do not.
         ---------------------------------------------------------------- -->
    <p-dialog
      [header]="'Edit Ratings — ' + (editTarget()?.programName ?? '')"
      [(visible)]="editDialogVisible"
      [modal]="true"
      [style]="{ width: '440px' }"
      [closable]="true"
      (onHide)="closeEditDialog()"
      styleClass="edit-allocation-dialog"
    >
      <div class="edit-allocation-form">
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
          [disabled]="!editComplementarityRating || !editEfficiencyRating"
          [loading]="actionLoading()"
          (onClick)="submitEditDialog()"
        />
      </ng-template>
    </p-dialog>

    <!-- ----------------------------------------------------------------
         Final Decision dialog (workflow admin). The admin reviews the
         thread, sets a binding allocation for every active mapping, adds a
         justification, then saves — moving every mapping to "Admin
         Decision" and locking the project. Allocations must total 100%.
         ---------------------------------------------------------------- -->
    <p-dialog
      header="Final Decision"
      [(visible)]="finalDecisionVisible"
      [modal]="true"
      [style]="{ width: '560px' }"
      [closable]="true"
      (onHide)="cancelFinalDecision()"
      styleClass="final-decision-dialog"
    >
      <p class="final-decision__hint">
        Set the binding allocation for each program. Saving overrides the negotiation, marks every
        mapping <strong>Admin Decision</strong>, and locks the project. Allocations must total 100%.
      </p>

      @for (row of finalDecisionRows(); track row.mappingId) {
        <div class="final-decision-row">
          <span class="final-decision-row__program">
            {{ row.programName }}
            @if (row.previousStatus === 'agreed') {
              <span class="final-decision-row__badge">was Agreed</span>
            }
          </span>
          <p-inputnumber
            [ngModel]="row.allocation"
            (ngModelChange)="setFinalAllocation(row.mappingId, $event)"
            [min]="0"
            [max]="100"
            [step]="0.01"
            suffix="%"
            styleClass="final-decision-row__input"
          />
        </div>
      }

      <div
        class="final-decision-total"
        [class.final-decision-total--ok]="finalDecisionAt100()"
        [class.final-decision-total--bad]="!finalDecisionAt100()"
      >
        Total: <strong>{{ finalDecisionTotal() }}%</strong>
        @if (!finalDecisionAt100()) {
          <span> — must equal 100%</span>
        }
      </div>

      <label class="form-label form-label--required final-decision__just-label">
        Justification
      </label>
      <textarea
        [ngModel]="finalDecisionJustification()"
        (ngModelChange)="finalDecisionJustification.set($event)"
        rows="3"
        placeholder="Reason for this decision (min 10 characters)…"
        class="final-decision__textarea"
      ></textarea>

      <ng-template #footer>
        <p-button
          label="Cancel"
          severity="secondary"
          [outlined]="true"
          (onClick)="cancelFinalDecision()"
        />
        <p-button
          label="Save Final Decision"
          icon="pi pi-verified"
          severity="success"
          [disabled]="!finalDecisionAt100() || finalDecisionJustification().trim().length < 10"
          [loading]="actionLoading()"
          (onClick)="submitFinalDecision()"
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

  /** Emits when a row's TOC icon is clicked so the parent opens the shared modal. */
  readonly tocOpen = output<{ mapping: ConsolidatedMapping; mode: 'edit' | 'readonly' }>();

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
   * Edit Ratings dialog state. editTarget holds the row being edited;
   * fields are plain properties because they are only read on explicit
   * submit (no reactive chain needed). Center-side only — allocation
   * changes go through the separate Counter-Propose popover.
   */
  readonly editDialogVisible = signal(false);
  readonly editTarget = signal<ConsolidatedMapping | null>(null);
  editComplementarityRating: Rating | null = null;
  editEfficiencyRating: Rating | null = null;

  /** The mapping currently targeted by the counter-propose popover. */
  readonly counterTarget = signal<ConsolidatedMapping | null>(null);
  counterPct: number | null = null;
  counterMessage = '';

  /** Remove dialog state. Drives both "Remove" (center) and "Request removal"
   * (program rep) — same dialog, different copy + endpoint. */
  readonly removeDialogVisible = signal(false);
  readonly removingMapping = signal<ConsolidatedMapping | null>(null);
  removeJustification = '';

  /** Add Program dialog state. Both ratings required (center responsibility). */
  addDialogVisible = false;
  addProgramId: number | null = null;
  addPct: number | null = null;
  addComplementarityRating: Rating | null = null;
  addEfficiencyRating: Rating | null = null;

  // -----------------------------------------------------------------------
  // Derived
  // -----------------------------------------------------------------------

  private readonly isCenterRep = this.authService.isCenterRep;
  /** workflow_admin has the same cross-center negotiation rights as center_rep. */
  private readonly isWorkflowAdmin = this.authService.isWorkflowAdmin;
  protected readonly isProgramRep = this.authService.isProgramRep;
  private readonly user = this.authService.currentUser;

  /**
   * The program id this user is currently "acting as" — the active program
   * chosen via the header switcher for multi-program reps, or the primary
   * program (`user.programId`) when no override exists. All program-rep
   * permission gates below compare this against `mapping.programId` so a
   * rep who switches to a non-primary program retains full negotiation
   * rights on rows for that program. Mirrors the backend overlay performed
   * by `ActiveProgramInterceptor` on `req.user.programId`.
   */
  private readonly effectiveProgramId = this.authService.effectiveProgramId;

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

  /**
   * Active (non-removed) mapping count. A project is capped at 3 active
   * mappings — mirrors `MAX_ACTIVE_MAPPINGS_PER_PROJECT` on the API.
   */
  readonly activeMappingCount = computed(
    () => this.data().mappings.filter((m) => m.status !== 'removed').length,
  );

  /** Whether the current user can add a program. */
  // NOTE: the workflow admin is intentionally read-only on the negotiation
  // surface — their ONLY action is Final Decision (see canMakeFinalDecision).
  // All per-row / round actions below exclude workflow_admin.
  readonly canAddProgram = computed(
    () => this.isCenterRep() && !this.isLocked() && this.activeMappingCount() < 3,
  );

  /**
   * Show the "max 3 reached" hint when the only thing blocking Add is the
   * cap — i.e. user has add rights and the project isn't locked.
   */
  readonly showMappingCapHint = computed(
    () => this.isCenterRep() && !this.isLocked() && this.activeMappingCount() >= 3,
  );

  // -----------------------------------------------------------------------
  // Final Decision (workflow admin)
  // -----------------------------------------------------------------------

  /**
   * Workflow admin can impose a final decision on an unlocked project that
   * has at least one active mapping. This is the arbiter action that
   * overrides the negotiation and locks the round.
   */
  readonly canMakeFinalDecision = computed(
    () => this.isWorkflowAdmin() && !this.isLocked() && this.activeMappingCount() > 0,
  );

  readonly finalDecisionVisible = signal(false);
  readonly finalDecisionJustification = signal('');
  readonly finalDecisionRows = signal<
    {
      mappingId: number;
      programName: string;
      previousStatus: MappingStatus;
      allocation: number | null;
    }[]
  >([]);

  /** Sum of the editable rows' allocations. */
  readonly finalDecisionTotal = computed(
    () =>
      Math.round(
        this.finalDecisionRows().reduce((s, r) => s + (Number(r.allocation) || 0), 0) * 100,
      ) / 100,
  );

  readonly finalDecisionAt100 = computed(() => Math.abs(this.finalDecisionTotal() - 100) <= 0.01);

  openFinalDecision(): void {
    this.finalDecisionRows.set(
      this.activeMappings().map((m) => ({
        mappingId: m.id,
        programName: m.programName,
        previousStatus: m.status,
        allocation: Number(m.allocationPercentage),
      })),
    );
    this.finalDecisionJustification.set('');
    this.finalDecisionVisible.set(true);
  }

  setFinalAllocation(mappingId: number, value: number | null): void {
    this.finalDecisionRows.update((rows) =>
      rows.map((r) => (r.mappingId === mappingId ? { ...r, allocation: value } : r)),
    );
  }

  cancelFinalDecision(): void {
    this.finalDecisionVisible.set(false);
    this.finalDecisionRows.set([]);
    this.finalDecisionJustification.set('');
  }

  submitFinalDecision(): void {
    if (!this.finalDecisionAt100()) {
      this.messageService.add({
        severity: 'warn',
        summary: 'Not 100%',
        detail: `Allocations must total 100% (currently ${this.finalDecisionTotal()}%).`,
      });
      return;
    }
    const justification = this.finalDecisionJustification().trim();
    if (justification.length < 10) {
      this.messageService.add({
        severity: 'warn',
        summary: 'Justification required',
        detail: 'Please give a reason of at least 10 characters.',
      });
      return;
    }
    const decisions = this.finalDecisionRows().map((r) => ({
      mappingId: r.mappingId,
      allocationPercentage: Number(r.allocation),
    }));

    this.actionLoading.set(true);
    this.mappingsService
      .finalDecision(this.data().project.id, { decisions, justification })
      .subscribe({
        next: () => {
          this.actionLoading.set(false);
          this.cancelFinalDecision();
          this.messageService.add({
            severity: 'success',
            summary: 'Final decision saved',
            detail: 'Allocations set and the project is locked.',
          });
          this.reload.emit();
        },
        error: (err) => {
          this.actionLoading.set(false);
          this.messageService.add({
            severity: 'error',
            summary: 'Error',
            detail: err?.error?.message ?? 'Failed to save the final decision.',
          });
        },
      });
  }

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
   * Center rep / workflow_admin: any non-locked row.
   * Program rep: only the row mapped to their own program.
   * Admin: read-only — never returns true.
   */
  canActOnRow(mapping: ConsolidatedMapping): boolean {
    if (this.isLocked()) return false;
    if (mapping.status === 'removed') return false;
    // Workflow admin is read-only here — their only action is Final Decision.
    if (this.isWorkflowAdmin()) return false;
    if (this.isCenterRep()) return true;
    const u = this.user();
    return !!u && u.role === 'program_rep' && this.effectiveProgramId() === mapping.programId;
  }

  /**
   * Returns true when the current user can open the Edit Ratings dialog.
   * Ratings are a center-side responsibility — center_rep and workflow_admin
   * only. Available on any non-locked, non-removed row (incl. draft), since
   * ratings are a parallel concern from allocation and do not reset
   * agreement flags.
   */
  canEditRatings(mapping: ConsolidatedMapping): boolean {
    if (this.isLocked()) return false;
    if (mapping.status === 'removed') return false;
    // Workflow admin is read-only — only Final Decision.
    return this.isCenterRep();
  }

  /**
   * Returns true when the current user can open the Propose / Counter-Propose
   * popover. Allocation changes go through this path (popover with % +
   * justification). On draft rows the label reads "Propose" (pre-negotiation
   * edit after reopen); on negotiating / agreed rows it reads "Counter-Propose".
   */
  canCounterProposeRow(mapping: ConsolidatedMapping): boolean {
    return this.canActOnRow(mapping);
  }

  /**
   * Label shown on the popover header + row tooltip. Draft rows are
   * pre-negotiation (typically after a reopen) so the center is making
   * the first offer of the round — "Propose". Once the round is live the
   * same control becomes a "Counter-Propose".
   */
  proposeLabel(mapping: ConsolidatedMapping | null): string {
    return mapping?.status === 'draft' ? 'Propose' : 'Counter-Propose';
  }

  /**
   * Returns true when the current user can remove a program row.
   * Center rep / workflow_admin: any non-locked, non-removed row.
   * Program rep: only their own program's row, and they raise a *request*
   * (justification ≥ 10 chars enforced in the remove dialog).
   * Admin: read-only — never returns true.
   *
   * While a program-rep request is pending, the trash button is rendered
   * but disabled — the center side resolves the pending request from the
   * chat thread (Accept / Decline buttons on the removal_requested card),
   * not from this row, so we don't have two competing entry points.
   */
  canRemoveRow(mapping: ConsolidatedMapping): boolean {
    if (this.isLocked()) return false;
    if (mapping.status === 'removed') return false;
    // Workflow admin is read-only — only Final Decision.
    if (this.isWorkflowAdmin()) return false;
    if (this.isCenterRep()) return true;
    const u = this.user();
    return !!u && u.role === 'program_rep' && this.effectiveProgramId() === mapping.programId;
  }

  // -----------------------------------------------------------------------
  // TOC icon guards
  // -----------------------------------------------------------------------

  /**
   * Returns true when the edit-TOC sitemap icon should appear on a row.
   * Shown to program rep (for their own program) when the mapping is active
   * (not removed or draft). TOC information can be supplied at any time,
   * including after the round is locked, so lock state does not hide it.
   * Draft rows are excluded — there are no agreed terms to attach TOC data
   * to yet, and the Agree gate in the chat handles the mandatory-TOC path.
   */
  canEditTocOnRow(mapping: ConsolidatedMapping): boolean {
    if (mapping.status === 'removed' || mapping.status === 'draft') return false;
    // Workflow admin is read-only — only Final Decision (no TOC editing).
    const u = this.user();
    return !!u && u.role === 'program_rep' && this.effectiveProgramId() === mapping.programId;
  }

  /**
   * Returns true when the view-TOC sitemap icon should appear on a row.
   * Shown to center_rep, admin, and unit_admin when the mapping has at least
   * one saved AOW (nothing to display otherwise). Available even on locked
   * rounds since viewing is read-only.
   */
  canViewTocOnRow(mapping: ConsolidatedMapping): boolean {
    if (mapping.status === 'removed') return false;
    if (!mapping.tocLinks || mapping.tocLinks.aows.length === 0) return false;
    const u = this.user();
    if (!u) return false;
    return u.role === 'center_rep' || u.role === 'admin' || u.role === 'unit_admin';
  }

  // -----------------------------------------------------------------------
  // Action — Agree
  // -----------------------------------------------------------------------

  /**
   * Entry point for the Agree button on each mapping row. Agree no longer
   * collects ratings — ratings are a center-side responsibility set on
   * create + allocation edit only.
   */
  agreeMapping(mapping: ConsolidatedMapping): void {
    this.agreeLoadingId.set(mapping.id);
    this.mappingsService.agree(mapping.id).subscribe({
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
    // Show the popover anchored to the clicked button element.
    this.counterPopoverRef.show(event);
  }

  /**
   * Whether the Save button should be disabled. Both the counter-propose
   * endpoint and the draft updateAllocation path require a justification
   * of at least 10 characters; mirror that gate here so the user gets
   * immediate feedback.
   */
  isCounterSubmitDisabled(): boolean {
    if (this.counterPct === null) return true;
    if (this.counterMessage.trim().length < 10) return true;
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

    // Draft rows pre-negotiation (typically after reopen): the counter-propose
    // endpoint rejects draft, so route through updateAllocation which accepts
    // draft and appends a COUNTER_PROPOSED audit event with the justification
    // persisted on the row. Ratings are required by the backend for
    // center-side updateAllocation calls — carry over the row's current
    // ratings since draft ratings are set at create time.
    if (mapping.status === 'draft') {
      this.actionLoading.set(true);
      this.mappingsService
        .updateAllocation(mapping.id, {
          allocationPercentage: pct,
          complementarityRating: mapping.complementarityRating ?? undefined,
          efficiencyRating: mapping.efficiencyRating ?? undefined,
          justification: this.counterMessage.trim(),
        })
        .subscribe({
          next: () => {
            popover.hide();
            this.counterTarget.set(null);
            this.messageService.add({
              severity: 'success',
              summary: 'Proposal Updated',
              detail: `Allocation set to ${pct}%.`,
            });
            this.reload.emit();
          },
          error: (err) => {
            this.messageService.add({
              severity: 'error',
              summary: 'Error',
              detail: err?.error?.message ?? 'Failed to update allocation.',
            });
            this.actionLoading.set(false);
          },
          complete: () => this.actionLoading.set(false),
        });
      return;
    }

    const dto = {
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
  // Action — Remove Program / Request Removal / Decline Removal
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

  /**
   * Submits the remove dialog. Routes to the right endpoint based on role:
   * - program_rep → POST /mappings/:id/request-removal (raises a request).
   * - center side → POST /mappings/:id/remove (immediate removal; also
   *   accepts a pending request when one exists).
   *
   * The minimum-10-character rule mirrors the backend `RemoveMappingDto`
   * validator so the user gets the gate locally instead of round-tripping.
   */
  submitRemove(): void {
    const mapping = this.removingMapping();
    const reason = this.removeJustification.trim();
    if (!mapping || reason.length < 10) return;

    const isProgramRequest = this.isProgramRep();
    const request$ = isProgramRequest
      ? this.mappingsService.requestRemoval(mapping.id, reason)
      : this.mappingsService.removeProgram(mapping.id, reason);

    this.actionLoading.set(true);
    request$.subscribe({
      next: () => {
        this.removeDialogVisible.set(false);
        this.removingMapping.set(null);
        this.removeJustification = '';
        this.messageService.add({
          severity: 'info',
          summary: isProgramRequest ? 'Removal Requested' : 'Program Removed',
          detail: isProgramRequest
            ? `Request sent to the center for ${mapping.programName}.`
            : `${mapping.programName} has been removed from this project.`,
        });
        this.reload.emit();
      },
      error: (err) => {
        this.messageService.add({
          severity: 'error',
          summary: 'Error',
          detail:
            err?.error?.message ??
            (isProgramRequest ? 'Failed to submit removal request.' : 'Failed to remove program.'),
        });
        this.actionLoading.set(false);
      },
      complete: () => this.actionLoading.set(false),
    });
  }

  // -----------------------------------------------------------------------
  // Edit Ratings dialog — center side only
  // -----------------------------------------------------------------------

  /**
   * Opens the Edit Ratings dialog pre-populated from the given mapping row.
   * Null pre-fill means the user must pick a value before saving.
   */
  openEditDialog(mapping: ConsolidatedMapping): void {
    this.editTarget.set(mapping);
    this.editComplementarityRating = mapping.complementarityRating ?? null;
    this.editEfficiencyRating = mapping.efficiencyRating ?? null;
    this.editDialogVisible.set(true);
  }

  closeEditDialog(): void {
    this.editDialogVisible.set(false);
    this.editTarget.set(null);
    this.editComplementarityRating = null;
    this.editEfficiencyRating = null;
  }

  /**
   * Submits a ratings-only update. Sends the current allocation unchanged
   * so the backend takes the RATING_UPDATED path (no agreement reset, no
   * counter_proposed event).
   */
  submitEditDialog(): void {
    const mapping = this.editTarget();
    if (!mapping) return;

    if (!this.editComplementarityRating || !this.editEfficiencyRating) {
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
        allocationPercentage: mapping.allocationPercentage,
        complementarityRating: this.editComplementarityRating,
        efficiencyRating: this.editEfficiencyRating,
      })
      .subscribe({
        next: () => {
          this.closeEditDialog();
          this.messageService.add({
            severity: 'success',
            summary: 'Ratings Updated',
            detail: 'Complementarity and efficiency ratings saved.',
          });
          this.reload.emit();
        },
        error: (err) => {
          this.messageService.add({
            severity: 'error',
            summary: 'Error',
            detail: err?.error?.message ?? 'Failed to update ratings.',
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
    this.addComplementarityRating = null;
    this.addEfficiencyRating = null;
    this.addDialogVisible = true;
  }

  closeAddDialog(): void {
    this.addDialogVisible = false;
  }

  submitAddProgram(): void {
    if (
      !this.addProgramId ||
      this.addPct === null ||
      !this.addComplementarityRating ||
      !this.addEfficiencyRating
    ) {
      return;
    }

    this.actionLoading.set(true);
    this.mappingsService
      .addProgram(
        this.projectId(),
        this.addProgramId,
        this.addPct,
        this.addComplementarityRating,
        this.addEfficiencyRating,
      )
      .subscribe({
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
      admin_decision: 'Admin Decision',
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
      // Workflow admin's binding decision — green, like agreed.
      admin_decision: 'success',
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
