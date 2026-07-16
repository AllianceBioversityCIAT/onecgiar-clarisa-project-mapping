import {
  Component,
  input,
  output,
  model,
  inject,
  signal,
  computed,
  effect,
  OnInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';

// PrimeNG
import { DialogModule } from 'primeng/dialog';
import { MultiSelectModule } from 'primeng/multiselect';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { MessageService } from 'primeng/api';

import { TocService } from '../../../../core/services/toc.service';
import { MappingsService } from '../../services/mappings.service';
import { TocAow, TocLinks, TocOutcome, TocOutput } from '../../../../core/models/toc.model';
import { ConsolidatedMapping } from '../../models/mapping.model';

/**
 * TocContributionComponent — wraps the TOC Contribution form inside a
 * `p-dialog` modal.  It replaces the previous inline-section design.
 *
 * Modes (controlled by the `mode` input):
 *  - 'agree'    — "Save & Agree" button chains PATCH /toc-links → POST /agree.
 *                 Emits `confirmed` on success so the parent can reload.
 *  - 'edit'     — "Save" button calls only PATCH /toc-links.
 *                 Emits `confirmed` on success.
 *  - 'readonly' — No form controls, no save button.  Chips only.
 *
 * Visibility is two-way via the `visible` model() signal.  The parent can
 * toggle it; the dialog's (onHide) also sets it to false when the user
 * clicks the X or the backdrop.
 *
 * Reference-data loading:
 *  AOWs are fetched lazily on `onShow` (not on component construction) so
 *  no network requests fire when the modal is closed.  TocService caches
 *  results per-program so re-opening is free.
 */
@Component({
  selector: 'app-toc-contribution-modal',
  standalone: true,
  imports: [FormsModule, DialogModule, MultiSelectModule, ButtonModule, TagModule, TooltipModule],
  template: `
    <p-dialog
      [header]="dialogHeader()"
      [(visible)]="visible"
      [modal]="true"
      [style]="{ width: '560px', maxWidth: '95vw' }"
      [closable]="true"
      [draggable]="false"
      [resizable]="false"
      appendTo="body"
      styleClass="toc-modal"
      (onShow)="onDialogShow()"
      (onHide)="onDialogHide()"
    >
      <!-- ----------------------------------------------------------------
           Read-only chip view — readonly mode OR no tocLinks at all
           ---------------------------------------------------------------- -->
      @if (mode() === 'readonly') {
        <div class="toc-readonly">
          @if (
            mapping().tocLinks.aows.length === 0 &&
            mapping().tocLinks.outputs.length === 0 &&
            mapping().tocLinks.outcomes.length === 0
          ) {
            <span class="toc-readonly__empty">No TOC contribution recorded yet.</span>
          } @else {
            @if (mapping().tocLinks.aows.length > 0) {
              <div class="toc-chip-group">
                <span class="toc-chip-group__label">Areas of Work</span>
                <div class="toc-chip-group__chips">
                  @for (aow of mapping().tocLinks.aows; track aow.id) {
                    <p-tag [value]="aow.name" severity="info" styleClass="toc-chip" />
                  }
                </div>
              </div>
            }
            @if (mapping().tocLinks.outputs.length > 0) {
              <div class="toc-chip-group">
                <span class="toc-chip-group__label">High-Level Outputs</span>
                <div class="toc-chip-group__chips">
                  @for (out of mapping().tocLinks.outputs; track out.id) {
                    <p-tag
                      [value]="out.title"
                      severity="secondary"
                      [pTooltip]="chipTooltip(out)"
                      tooltipPosition="top"
                      styleClass="toc-chip"
                    />
                  }
                </div>
              </div>
            }
            @if (mapping().tocLinks.outcomes.length > 0) {
              <div class="toc-chip-group">
                <span class="toc-chip-group__label">Outcomes</span>
                <div class="toc-chip-group__chips">
                  @for (ioc of mapping().tocLinks.outcomes; track ioc.id) {
                    <div class="toc-chip-row">
                      <p-tag
                        [value]="ioc.title"
                        severity="warn"
                        [pTooltip]="outcomeChipTooltip(ioc)"
                        tooltipPosition="top"
                        styleClass="toc-chip"
                      />
                      @if (ioc.aows && ioc.aows.length > 0) {
                        <span class="toc-aow-badges">
                          @for (aow of ioc.aows; track aow.id) {
                            <span class="toc-aow-badge">{{ aow.wpOfficialCode }}</span>
                          }
                        </span>
                      }
                    </div>
                  }
                </div>
              </div>
            }
          }
        </div>
      } @else {
        <!-- ----------------------------------------------------------------
             Editable form — 'agree' and 'edit' modes
             ---------------------------------------------------------------- -->
        <div class="toc-form">
          <p class="toc-form__hint">
            Select the Theory of Change nodes that this program contributes to through this project.
            At least one Output or Outcome is required to agree (Area of Work is optional).
          </p>

          <!-- Saved items the pickers can't display (TOC reference data
               changed since they were saved). They stay in the save
               payload so they are never silently lost. -->
          @if (unmatchedCount() > 0 && !aowsLoading() && !outputsLoading() && !outcomesLoading()) {
            <div class="toc-form__unmatched">
              <i class="pi pi-exclamation-triangle"></i>
              <span>
                {{ unmatchedCount() }} previously saved item{{ unmatchedCount() > 1 ? 's are' : ' is' }}
                not shown in the lists below (the Theory of Change data may have changed). They will
                be kept when you save.
              </span>
            </div>
          }

          <!-- Areas of Work -->
          <div class="toc-form__field">
            <label class="toc-form__label">Areas of Work</label>
            @if (aowsLoading()) {
              <div class="toc-form__loading"><i class="pi pi-spin pi-spinner"></i> Loading…</div>
            } @else {
              <p-multiselect
                [(ngModel)]="selectedAows"
                [options]="aows()"
                optionLabel="name"
                [filter]="true"
                filterPlaceholder="Search Areas of Work…"
                placeholder="Select Areas of Work"
                appendTo="body"
                styleClass="toc-form__select"
                panelStyleClass="toc-form__panel"
                (onChange)="onAowChange()"
              >
                <ng-template #item let-item>
                  <div class="toc-option">
                    <span class="toc-option__name">{{ item.acronym }} - {{ item.name }}</span>
                  </div>
                </ng-template>
                <ng-template #selectedItems let-items>
                  @if (items?.length) {
                    <span>{{ items.length }} AOW{{ items.length > 1 ? 's' : '' }} selected</span>
                  } @else {
                    <span class="toc-form__placeholder">Select Areas of Work</span>
                  }
                </ng-template>
              </p-multiselect>
            }
          </div>

          <!-- High-Level Outputs -->
          <div class="toc-form__field">
            <label class="toc-form__label">High-Level Outputs</label>
            @if (outputsLoading()) {
              <div class="toc-form__loading"><i class="pi pi-spin pi-spinner"></i> Loading…</div>
            } @else {
              <p-multiselect
                [(ngModel)]="selectedOutputs"
                [options]="outputs()"
                optionLabel="title"
                [filter]="true"
                filterPlaceholder="Search Outputs…"
                [placeholder]="
                  selectedAows.length === 0
                    ? 'Select Areas of Work first'
                    : 'Select High-Level Outputs'
                "
                [disabled]="selectedAows.length === 0"
                appendTo="body"
                styleClass="toc-form__select"
                panelStyleClass="toc-form__panel"
              >
                <ng-template #item let-item>
                  <div class="toc-option">
                    <span class="toc-option__name">{{ item.title }}</span>
                  </div>
                </ng-template>
                <ng-template #selectedItems let-items>
                  @if (items?.length) {
                    <span>{{ items.length }} Output{{ items.length > 1 ? 's' : '' }} selected</span>
                  } @else {
                    <span class="toc-form__placeholder">{{
                      selectedAows.length === 0
                        ? 'Select Areas of Work first'
                        : 'Select High-Level Outputs'
                    }}</span>
                  }
                </ng-template>
              </p-multiselect>
            }
          </div>

          <!-- Outcomes -->
          <div class="toc-form__field">
            <label class="toc-form__label">Outcomes</label>
            @if (outcomesLoading()) {
              <div class="toc-form__loading"><i class="pi pi-spin pi-spinner"></i> Loading…</div>
            } @else {
              <p-multiselect
                [(ngModel)]="selectedOutcomes"
                [options]="outcomes()"
                optionLabel="title"
                [filter]="true"
                filterPlaceholder="Search Outcomes…"
                placeholder="Select Outcomes"
                appendTo="body"
                styleClass="toc-form__select"
                panelStyleClass="toc-form__panel"
              >
                <ng-template #item let-item>
                  <div class="toc-option">
                    <span class="toc-option__name">{{ item.title }}</span>
                  </div>
                </ng-template>
                <ng-template #selectedItems let-items>
                  @if (items?.length) {
                    <span
                      >{{ items.length }} Outcome{{ items.length > 1 ? 's' : '' }} selected</span
                    >
                  } @else {
                    <span class="toc-form__placeholder">Select Outcomes</span>
                  }
                </ng-template>
              </p-multiselect>
            }
          </div>
        </div>
      }

      <!-- ----------------------------------------------------------------
           Footer buttons (hidden for readonly)
           ---------------------------------------------------------------- -->
      @if (mode() !== 'readonly') {
        <ng-template #footer>
          <p-button
            label="Cancel"
            severity="secondary"
            [outlined]="true"
            [disabled]="saving()"
            (onClick)="cancel()"
          />
          <p-button
            [label]="confirmLabel()"
            icon="pi pi-check"
            [loading]="saving()"
            [disabled]="isConfirmDisabled()"
            (onClick)="confirm()"
          />
        </ng-template>
      }
    </p-dialog>
  `,
  styleUrl: './toc-contribution.component.scss',
})
export class TocContributionModalComponent implements OnInit {
  private readonly tocService = inject(TocService);
  private readonly mappingsService = inject(MappingsService);
  private readonly messageService = inject(MessageService);

  // -----------------------------------------------------------------------
  // Inputs / Outputs
  // -----------------------------------------------------------------------

  /** The mapping this modal operates on. */
  readonly mapping = input.required<ConsolidatedMapping>();

  /**
   * Dialog visibility — two-way binding.  Parent sets to true to open;
   * dialog X / Cancel set it back to false.
   */
  readonly visible = model<boolean>(false);

  /**
   * Controls dialog behaviour:
   *  'agree'    — Save TOC links then call agree. Button label "Save & Agree".
   *  'edit'     — Save TOC links only. Button label "Save".
   *  'readonly' — No inputs, no footer buttons. Chips only.
   */
  readonly mode = input<'agree' | 'edit' | 'readonly'>('agree');

  /**
   * Emitted after chained save (and optional agree) succeeds.
   * Parent uses this to trigger a data reload.
   */
  readonly confirmed = output<void>();

  // -----------------------------------------------------------------------
  // Derived
  // -----------------------------------------------------------------------

  readonly dialogHeader = computed(() => {
    const m = this.mode();
    if (m === 'readonly') return 'TOC Contribution';
    if (m === 'edit') return 'Edit TOC Contribution';
    return 'TOC Contribution';
  });

  readonly confirmLabel = computed(() => (this.mode() === 'agree' ? 'Save & Agree' : 'Save'));

  // -----------------------------------------------------------------------
  // Reference data signals
  // -----------------------------------------------------------------------

  readonly aows = signal<TocAow[]>([]);
  readonly outputs = signal<TocOutput[]>([]);
  readonly outcomes = signal<TocOutcome[]>([]);

  readonly aowsLoading = signal(false);
  readonly outputsLoading = signal(false);
  readonly outcomesLoading = signal(false);

  // -----------------------------------------------------------------------
  // Readonly tooltip helpers
  // -----------------------------------------------------------------------

  /**
   * Tooltip for an output chip in readonly view: the parent AOW name resolved
   * from the saved tocLinks. Empty string when there is no parent AOW.
   */
  chipTooltip(item: { aowId: number | null }): string {
    if (item.aowId === null) return '';
    const aow = this.mapping().tocLinks.aows.find((a) => a.id === item.aowId);
    return aow?.name ?? '';
  }

  /**
   * Tooltip for an outcome chip in readonly view.
   * Uses the multi-AOW `aows` array when available (joined by ", ").
   * Falls back to the legacy single `aowId` lookup for older payloads.
   */
  outcomeChipTooltip(item: TocOutcome): string {
    if (item.aows && item.aows.length > 0) {
      return item.aows.map((a) => a.name).join(', ');
    }
    // Legacy fallback: resolve via single aowId from the saved tocLinks AOWs.
    if (item.aowId === null) return '';
    const aow = this.mapping().tocLinks.aows.find((a) => a.id === item.aowId);
    return aow?.name ?? '';
  }

  // -----------------------------------------------------------------------
  // Form state
  // -----------------------------------------------------------------------

  selectedAows: TocAow[] = [];
  selectedOutputs: TocOutput[] = [];
  selectedOutcomes: TocOutcome[] = [];

  readonly saving = signal(false);

  /**
   * The mapping's saved TOC links, fetched fresh from the API on every
   * dialog open. The parent's `mapping().tocLinks` snapshot can be stale
   * (old tab, missed socket ping) — and because PATCH /toc-links is a
   * full replace, saving from a stale snapshot silently reverts someone
   * else's update. Falls back to the snapshot if the fetch fails.
   */
  private savedLinks: TocLinks = { aows: [], outputs: [], outcomes: [] };

  /**
   * Saved links that could not be matched against the loaded reference
   * lists (e.g. the TOC re-sync changed an output's AOW linkage so the
   * picker no longer lists it). Previously these were silently dropped
   * from the restored selection and then permanently deleted by the
   * next full-replace save. They are now kept out of the visible
   * pickers but preserved in the save payload, with a banner telling
   * the user.
   */
  readonly unmatchedAows = signal<TocAow[]>([]);
  readonly unmatchedOutputs = signal<TocOutput[]>([]);
  readonly unmatchedOutcomes = signal<TocOutcome[]>([]);

  readonly unmatchedCount = computed(
    () =>
      this.unmatchedAows().length + this.unmatchedOutputs().length + this.unmatchedOutcomes().length,
  );

  /**
   * Monotonic token guarding async load chains. Incremented on every
   * dialog open/close and AOW change so continuations from a previous
   * open (or a superseded AOW change) detect they are stale and stop
   * writing state — the modal instance is shared across mappings, so a
   * stale chain could otherwise repopulate lists/selections for the
   * wrong mapping.
   */
  private loadSeq = 0;

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  ngOnInit(): void {
    // Nothing to pre-fetch — load lazily in onDialogShow() so we don't
    // pay the cost when the dialog is never opened.
  }

  // -----------------------------------------------------------------------
  // Dialog lifecycle hooks
  // -----------------------------------------------------------------------

  /**
   * Called when the dialog opens (PrimeNG onShow event).
   * Resets form state to the mapping's current saved tocLinks and
   * fetches reference data for the program (cached by TocService).
   */
  async onDialogShow(): Promise<void> {
    if (this.mode() === 'readonly') return; // no data needed

    const seq = ++this.loadSeq;

    // Reset selections to the saved state before loading reference data.
    this.selectedAows = [];
    this.selectedOutputs = [];
    this.selectedOutcomes = [];
    this.aows.set([]);
    this.outputs.set([]);
    this.outcomes.set([]);
    this.unmatchedAows.set([]);
    this.unmatchedOutputs.set([]);
    this.unmatchedOutcomes.set([]);

    // Refresh the saved link set from the API so we never restore (and
    // later re-save) a stale snapshot. Fall back to the parent's data
    // when the fetch fails — same behavior as before this guard.
    this.savedLinks = this.mapping().tocLinks;
    this.aowsLoading.set(true);
    try {
      const fresh = await firstValueFrom(this.mappingsService.getMapping(this.mapping().id));
      if (seq !== this.loadSeq) return;
      if (fresh.tocLinks) this.savedLinks = fresh.tocLinks;
    } catch {
      if (seq !== this.loadSeq) return;
      // Keep the snapshot fallback; reference loading proceeds normally.
    }

    await this.loadAows(seq);
  }

  /** Called when the dialog closes for any reason. */
  onDialogHide(): void {
    // visible is already set to false by p-dialog's two-way binding.
    // Reset saving guard so a re-open is clean. Bump the load token so
    // any in-flight load chain from this open stops writing state.
    this.loadSeq++;
    this.saving.set(false);
  }

  // -----------------------------------------------------------------------
  // Reference data loading
  // -----------------------------------------------------------------------

  private async loadAows(seq: number): Promise<void> {
    this.aowsLoading.set(true);
    try {
      const aows = await this.tocService.getAows(this.mapping().programId);
      if (seq !== this.loadSeq) return;
      this.aows.set(aows);
      // Restore saved AOW selections immediately.
      this.syncFormFromLinks(this.savedLinks);

      const savedAowIds = this.savedLinks.aows.map((a) => a.id);
      // Always pre-fetch outcomes (empty aowIds = all outcomes for the program).
      // Fetch outputs only when there are saved AOW selections.
      await this.loadDependentLists(savedAowIds, seq);
      if (seq !== this.loadSeq) return;
      this.syncFormFromLinks(this.savedLinks);
    } finally {
      // Only the owning chain may clear the flag — a stale chain
      // finishing late must not unblock Confirm while a newer chain
      // is still loading.
      if (seq === this.loadSeq) this.aowsLoading.set(false);
    }
  }

  /**
   * Called when the AOW multi-select changes.
   * Outputs are AOW-scoped: reload outputs only when AOWs are selected, clear
   * them when none are selected.
   * Outcomes are NOT AOW-gated: always reload all program outcomes so the user
   * can select them even with no AOW chosen. The backend omits the AOW filter
   * when aowIds is empty.
   */
  async onAowChange(): Promise<void> {
    const seq = ++this.loadSeq;
    const aowIds = this.selectedAows.map((a) => a.id);

    if (aowIds.length === 0) {
      // Clear outputs (AOW-scoped) and drop any selected outputs.
      const droppedOutputs = this.selectedOutputs.length;
      this.outputs.set([]);
      this.selectedOutputs = [];
      if (droppedOutputs > 0) {
        this.messageService.add({
          severity: 'info',
          summary: 'Selection cleared',
          detail: `${droppedOutputs} output item(s) removed because their Areas of Work were deselected.`,
        });
      }
      // Reload all program outcomes (no AOW filter).
      await this.loadOutcomes([], seq);
      return;
    }

    await this.loadDependentLists(aowIds, seq);
  }

  /**
   * Loads both outputs (AOW-scoped) and outcomes (all program outcomes when
   * aowIds is empty) in parallel, then prunes any stale selections.
   */
  private async loadDependentLists(aowIds: number[], seq: number): Promise<void> {
    this.outputsLoading.set(true);
    this.outcomesLoading.set(true);

    const fetchOutputs =
      aowIds.length > 0
        ? this.tocService.getOutputs(this.mapping().programId, aowIds)
        : Promise.resolve([] as TocOutput[]);

    const [outputs, outcomes] = await Promise.all([
      fetchOutputs,
      this.tocService.getOutcomes(this.mapping().programId, aowIds),
    ]);

    if (seq !== this.loadSeq) return;

    // Prune selections that are no longer valid under the new AOW set.
    const validOutputIds = new Set(outputs.map((o) => o.id));
    const validOutcomeIds = new Set(outcomes.map((o) => o.id));

    const prevOut = this.selectedOutputs.length;
    const prevIoc = this.selectedOutcomes.length;

    this.selectedOutputs = this.selectedOutputs.filter((o) => validOutputIds.has(o.id));
    this.selectedOutcomes = this.selectedOutcomes.filter((o) => validOutcomeIds.has(o.id));

    const dropped =
      prevOut - this.selectedOutputs.length + (prevIoc - this.selectedOutcomes.length);
    if (dropped > 0) {
      this.messageService.add({
        severity: 'info',
        summary: 'Selection updated',
        detail: `${dropped} output/outcome item(s) were removed because their Areas of Work are no longer selected.`,
      });
    }

    this.outputs.set(outputs);
    this.outcomes.set(outcomes);
    this.outputsLoading.set(false);
    this.outcomesLoading.set(false);
  }

  /** Reload only the outcomes list (used when AOW selection is cleared). */
  private async loadOutcomes(aowIds: number[], seq: number): Promise<void> {
    this.outcomesLoading.set(true);
    try {
      const outcomes = await this.tocService.getOutcomes(this.mapping().programId, aowIds);
      if (seq !== this.loadSeq) return;
      // Preserve any currently-selected outcomes that are still in the new list.
      const validOutcomeIds = new Set(outcomes.map((o) => o.id));
      this.selectedOutcomes = this.selectedOutcomes.filter((o) => validOutcomeIds.has(o.id));
      this.outcomes.set(outcomes);
    } finally {
      if (seq === this.loadSeq) this.outcomesLoading.set(false);
    }
  }

  /**
   * Restores form selections from saved tocLinks once the reference
   * lists are available. Safe to call when lists are empty (no-op).
   *
   * Saved links that don't exist in the loaded reference lists cannot be
   * shown in the pickers — they are collected into the `unmatched*`
   * signals instead of being silently discarded, so confirm() can keep
   * them in the (full-replace) save payload.
   */
  private syncFormFromLinks(links: TocLinks): void {
    const aowIds = new Set(links.aows.map((a) => a.id));
    const outputIds = new Set(links.outputs.map((o) => o.id));
    const outcomeIds = new Set(links.outcomes.map((o) => o.id));

    this.selectedAows = this.aows().filter((a) => aowIds.has(a.id));
    this.selectedOutputs = this.outputs().filter((o) => outputIds.has(o.id));
    this.selectedOutcomes = this.outcomes().filter((o) => outcomeIds.has(o.id));

    const loadedAowIds = new Set(this.aows().map((a) => a.id));
    const loadedOutputIds = new Set(this.outputs().map((o) => o.id));
    const loadedOutcomeIds = new Set(this.outcomes().map((o) => o.id));

    this.unmatchedAows.set(links.aows.filter((a) => !loadedAowIds.has(a.id)));
    this.unmatchedOutputs.set(links.outputs.filter((o) => !loadedOutputIds.has(o.id)));
    this.unmatchedOutcomes.set(links.outcomes.filter((o) => !loadedOutcomeIds.has(o.id)));
  }

  // -----------------------------------------------------------------------
  // Confirm / Cancel
  // -----------------------------------------------------------------------

  /**
   * Confirm button disabled when:
   *  - Currently saving.
   *  - Reference data still loading.
   *  - Neither an Output nor an Outcome is selected (AOW is optional client-side;
   *    the server enforces its own gate).
   */
  isConfirmDisabled(): boolean {
    if (this.saving()) return true;
    if (this.aowsLoading() || this.outputsLoading() || this.outcomesLoading()) return true;
    // Unmatched saved items count toward the minimum — they are part of
    // the payload even though the pickers can't display them.
    return (
      this.selectedOutputs.length + this.unmatchedOutputs().length === 0 &&
      this.selectedOutcomes.length + this.unmatchedOutcomes().length === 0
    );
  }

  cancel(): void {
    this.visible.set(false);
  }

  /**
   * Confirm handler. Chains PATCH /toc-links → POST /agree (mode='agree')
   * or only PATCH /toc-links (mode='edit'). Keeps the modal open on error
   * so the user can fix the problem without losing their selections.
   */
  async confirm(): Promise<void> {
    this.saving.set(true);
    try {
      // Step 1 — save TOC links. The PATCH is a full replace, so saved
      // items the pickers couldn't display (unmatched) are merged back
      // in — otherwise they would be silently deleted.
      await this.tocService.updateTocLinks(this.mapping().id, {
        aowIds: [
          ...this.selectedAows.map((a) => a.id),
          ...this.unmatchedAows().map((a) => a.id),
        ],
        outputIds: [
          ...this.selectedOutputs.map((o) => o.id),
          ...this.unmatchedOutputs().map((o) => o.id),
        ],
        outcomeIds: [
          ...this.selectedOutcomes.map((o) => o.id),
          ...this.unmatchedOutcomes().map((o) => o.id),
        ],
      });

      // Step 2 — agree (only in 'agree' mode).
      if (this.mode() === 'agree') {
        await this.mappingsService.agree(this.mapping().id).toPromise();
        this.messageService.add({
          severity: 'success',
          summary: 'Agreed',
          detail: 'TOC contribution saved and agreement submitted.',
        });
      } else {
        this.messageService.add({
          severity: 'success',
          summary: 'Saved',
          detail: 'TOC contribution updated.',
        });
      }

      this.visible.set(false);
      this.confirmed.emit();
    } catch (err: unknown) {
      const apiErr = err as { error?: { code?: string; message?: string } };
      const code = apiErr?.error?.code;

      if (code === 'TOC_LINKS_REQUIRED') {
        this.messageService.add({
          severity: 'warn',
          summary: 'TOC links required',
          detail: 'Please select at least one Area of Work and one Output or Outcome.',
        });
      } else {
        this.messageService.add({
          severity: 'error',
          summary: 'Error',
          detail: apiErr?.error?.message ?? 'Failed to save TOC contribution.',
        });
      }
      // Keep modal open — user can correct the issue without losing state.
    } finally {
      this.saving.set(false);
    }
  }
}
