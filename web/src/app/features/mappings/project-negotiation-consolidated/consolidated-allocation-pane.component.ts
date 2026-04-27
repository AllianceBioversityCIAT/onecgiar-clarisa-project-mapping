import { Component, input, output, signal, computed, inject, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';

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
import { ConsolidatedMapping, ConsolidatedView, MappingStatus } from '../models/mapping.model';

/**
 * ConsolidatedAllocationPaneComponent — right pane of the consolidated negotiation view.
 *
 * Shows the per-program allocation table. Each row has inline action buttons:
 *  - Agree (all authorized users on that mapping)
 *  - Counter-Propose (opens a p-popover with % + message form)
 *  - Remove Program (center rep / admin only — opens a remove dialog)
 *
 * Separate from the action buttons, center rep / admin can also edit the raw
 * allocation % via the pencil inline-edit (direct PATCH, no message required).
 */
@Component({
  selector: 'app-consolidated-allocation-pane',
  standalone: true,
  imports: [
    FormsModule,
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

              <div class="program-row__bottom">
                @if (editingMappingId() === row.id) {
                  <div class="inline-edit">
                    <p-inputnumber
                      [(ngModel)]="editPct"
                      [min]="0"
                      [max]="100"
                      [step]="0.01"
                      [maxFractionDigits]="2"
                      styleClass="edit-input"
                    />
                    <p-button
                      icon="pi pi-check"
                      size="small"
                      severity="success"
                      [rounded]="true"
                      [text]="true"
                      [loading]="actionLoading()"
                      (onClick)="saveAllocation(row.id)"
                    />
                    <p-button
                      icon="pi pi-times"
                      size="small"
                      severity="secondary"
                      [rounded]="true"
                      [text]="true"
                      (onClick)="cancelEdit()"
                    />
                  </div>
                } @else {
                  <span class="program-row__pct">{{ row.allocationPercentage }}%</span>
                }

                <!-- Allocation-management actions (Agree / Counter-Propose
                     live on the relevant message in the Conversation pane). -->
                @if (!isLocked() && editingMappingId() !== row.id) {
                  <div class="program-row__actions">
                    @if (canEditRow(row)) {
                      <p-button
                        icon="pi pi-pencil"
                        size="small"
                        severity="secondary"
                        [text]="true"
                        [rounded]="true"
                        (onClick)="startEdit(row)"
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
          <div class="counter-form__btns">
            <p-button
              label="Save"
              icon="pi pi-check"
              size="small"
              [loading]="actionLoading()"
              [disabled]="counterPct === null"
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

  /** Generic action loading (add program, remove program, counter-propose). */
  readonly actionLoading = signal(false);

  /** Tracks which mapping is currently being agreed (shows spinner on that row). */
  readonly agreeLoadingId = signal<number | null>(null);

  /** ID of the mapping row currently being inline-edited (allocation %). */
  readonly editingMappingId = signal<number | null>(null);
  editPct: number | null = null;

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

  // -----------------------------------------------------------------------
  // Derived
  // -----------------------------------------------------------------------

  private readonly isCenterRep = this.authService.isCenterRep;
  private readonly isAdmin = this.authService.isAdmin;
  /** workflow_admin has the same cross-center negotiation rights as center_rep + admin. */
  private readonly isWorkflowAdmin = this.authService.isWorkflowAdmin;
  private readonly user = this.authService.currentUser;

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
   * Returns true when the current user can edit the raw allocation % for a row.
   * Same RBAC as canActOnRow — kept as a separate method for clarity.
   */
  canEditRow(mapping: ConsolidatedMapping): boolean {
    return this.canActOnRow(mapping);
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

    this.actionLoading.set(true);
    this.mappingsService
      .counterPropose(mapping.id, {
        proposedAllocation: pct,
        justification: this.counterMessage.trim(),
      })
      .subscribe({
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
  // Inline edit — allocation %
  // -----------------------------------------------------------------------

  startEdit(mapping: ConsolidatedMapping): void {
    this.editingMappingId.set(mapping.id);
    this.editPct = mapping.allocationPercentage;
  }

  cancelEdit(): void {
    this.editingMappingId.set(null);
    this.editPct = null;
  }

  saveAllocation(mappingId: number): void {
    const pct = this.editPct;
    if (pct === null || pct < 0 || pct > 100) {
      this.messageService.add({
        severity: 'warn',
        summary: 'Invalid',
        detail: 'Allocation must be between 0 and 100.',
      });
      return;
    }

    this.actionLoading.set(true);
    this.mappingsService.updateAllocation(mappingId, pct).subscribe({
      next: () => {
        this.editingMappingId.set(null);
        this.editPct = null;
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
          detail: err?.error?.message ?? 'Failed to update allocation.',
        });
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
}
