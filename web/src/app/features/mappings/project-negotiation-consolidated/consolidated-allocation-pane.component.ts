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
import { TocContributionComponent } from './toc-contribution/toc-contribution.component';

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
    TocContributionComponent,
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

                <!-- Action buttons — only shown when the round is unlocked -->
                @if (!isLocked()) {
                  <div class="program-row__actions">
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
                  </div>
                }
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

              <!-- TOC Contribution — program rep edits; everyone else read-only chips.
                   Hidden for draft / removed rows (handled inside the component). -->
              <app-toc-contribution
                [mapping]="row"
                [isLocked]="isLocked()"
                (saved)="reload.emit()"
              />
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
          <label class="counter-form__label">Justification</label>
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
  readonly canAddProgram = computed(
    () =>
      (this.isCenterRep() || this.isWorkflowAdmin()) &&
      !this.isLocked() &&
      this.activeMappingCount() < 3,
  );

  /**
   * Show the "max 3 reached" hint when the only thing blocking Add is the
   * cap — i.e. user has add rights and the project isn't locked.
   */
  readonly showMappingCapHint = computed(
    () =>
      (this.isCenterRep() || this.isWorkflowAdmin()) &&
      !this.isLocked() &&
      this.activeMappingCount() >= 3,
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
   * Center rep / workflow_admin: any non-locked row.
   * Program rep: only the row mapped to their own program.
   * Admin: read-only — never returns true.
   */
  canActOnRow(mapping: ConsolidatedMapping): boolean {
    if (this.isLocked()) return false;
    if (mapping.status === 'removed') return false;
    if (this.isCenterRep() || this.isWorkflowAdmin()) return true;
    const u = this.user();
    return !!u && u.role === 'program_rep' && u.programId === mapping.programId;
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
    return this.isCenterRep() || this.isWorkflowAdmin();
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
    if (this.isCenterRep() || this.isWorkflowAdmin()) return true;
    const u = this.user();
    return !!u && u.role === 'program_rep' && u.programId === mapping.programId;
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
