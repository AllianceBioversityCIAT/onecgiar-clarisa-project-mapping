import { Component, input, output, inject, signal, computed, effect, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';

// PrimeNG
import { MultiSelectModule } from 'primeng/multiselect';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { MessageService } from 'primeng/api';

import { AuthService } from '../../../../core/services/auth.service';
import { TocService } from '../../../../core/services/toc.service';
import { TocAow, TocLinks, TocOutcome, TocOutput } from '../../../../core/models/toc.model';
import { ConsolidatedMapping } from '../../models/mapping.model';

/**
 * TocContributionComponent — renders the TOC Contribution section inside
 * each mapping row on the consolidated negotiation page.
 *
 * Visibility rules:
 *  - Draft or removed mappings → hidden (return nothing from the template).
 *  - Locked project → read-only chip view for everyone.
 *  - Program rep (own mapping) or workflow_admin → editable multi-selects + Save.
 *  - All other roles → read-only chip view.
 *
 * Data-loading strategy:
 *  AOW list is fetched eagerly when the section first renders (not deferred
 *  to onShow) because the component is already lazy — it only renders for
 *  non-draft, non-removed mappings. Outputs and Outcomes are fetched once
 *  AOW IDs are known (either from saved links on mount, or from user selection).
 *  All three lists are cached by TocService for the component's injector
 *  lifetime so navigating back to the same page does not re-fetch.
 *
 * Agree gate:
 *  The parent (ConsolidatedAllocationPaneComponent) reads the `tocLinks`
 *  on the ConsolidatedMapping to decide whether to enable the Agree button.
 *  This component does NOT own the Agree button — it owns the Save button
 *  and emits `(saved)` with the updated TocLinks when a save succeeds.
 */
@Component({
  selector: 'app-toc-contribution',
  standalone: true,
  imports: [FormsModule, MultiSelectModule, ButtonModule, TagModule, TooltipModule],
  template: `
    <!-- Hidden for draft / removed mappings -->
    @if (isVisible()) {
      <div class="toc-section">
        <div class="toc-section__header">
          <span class="toc-section__title">
            <i class="pi pi-sitemap toc-section__icon"></i>
            TOC Contribution
          </span>
          @if (!canEdit()) {
            <span class="toc-section__hint">Program rep sets these links.</span>
          }
        </div>

        <!-- ----------------------------------------------------------------
             Editable mode — shown to program rep (own mapping) + workflow_admin
             when project is NOT locked.
             ---------------------------------------------------------------- -->
        @if (canEdit()) {
          <div class="toc-form">
            <!-- Areas of Work -->
            <div class="toc-form__field">
              <label class="toc-form__label">Areas of Work</label>
              @if (aowsLoading()) {
                <div class="toc-form__loading"><i class="pi pi-spin pi-spinner"></i> Loading…</div>
              } @else {
                <p-multiselect
                  [(ngModel)]="selectedAows"
                  [options]="aows()"
                  optionLabel="wpOfficialCode"
                  [filter]="true"
                  filterPlaceholder="Search Areas of Work…"
                  placeholder="Select Areas of Work"
                  appendTo="body"
                  styleClass="toc-form__select"
                  (onChange)="onAowChange()"
                >
                  <ng-template #option let-item>
                    <div class="toc-option">
                      <span class="toc-option__code">{{ item.wpOfficialCode }}</span>
                      <span class="toc-option__name">{{ item.name }}</span>
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
                >
                  <ng-template #option let-item>
                    <div class="toc-option">
                      <span class="toc-option__code">{{ item.nodeId }}</span>
                      <span class="toc-option__name">{{ item.title }}</span>
                    </div>
                  </ng-template>
                  <ng-template #selectedItems let-items>
                    @if (items?.length) {
                      <span
                        >{{ items.length }} Output{{ items.length > 1 ? 's' : '' }} selected</span
                      >
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

            <!-- Intermediate Outcomes -->
            <div class="toc-form__field">
              <label class="toc-form__label">Intermediate Outcomes</label>
              @if (outcomesLoading()) {
                <div class="toc-form__loading"><i class="pi pi-spin pi-spinner"></i> Loading…</div>
              } @else {
                <p-multiselect
                  [(ngModel)]="selectedOutcomes"
                  [options]="outcomes()"
                  optionLabel="title"
                  [filter]="true"
                  filterPlaceholder="Search Outcomes…"
                  [placeholder]="
                    selectedAows.length === 0
                      ? 'Select Areas of Work first'
                      : 'Select Intermediate Outcomes'
                  "
                  [disabled]="selectedAows.length === 0"
                  appendTo="body"
                  styleClass="toc-form__select"
                >
                  <ng-template #option let-item>
                    <div class="toc-option">
                      <span class="toc-option__code">{{ item.nodeId }}</span>
                      <span class="toc-option__name">{{ item.title }}</span>
                    </div>
                  </ng-template>
                  <ng-template #selectedItems let-items>
                    @if (items?.length) {
                      <span
                        >{{ items.length }} Outcome{{ items.length > 1 ? 's' : '' }} selected</span
                      >
                    } @else {
                      <span class="toc-form__placeholder">{{
                        selectedAows.length === 0
                          ? 'Select Areas of Work first'
                          : 'Select Intermediate Outcomes'
                      }}</span>
                    }
                  </ng-template>
                </p-multiselect>
              }
            </div>

            <div class="toc-form__footer">
              <p-button
                label="Save TOC Contribution"
                icon="pi pi-check"
                size="small"
                [loading]="saving()"
                [disabled]="isSaveDisabled()"
                (onClick)="save()"
              />
            </div>
          </div>
        } @else {
          <!-- ---------------------------------------------------------------
               Read-only chip view — center rep, admin, or locked project
               --------------------------------------------------------------- -->
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
                      <p-tag
                        [value]="aow.wpOfficialCode"
                        severity="info"
                        [pTooltip]="aow.name"
                        tooltipPosition="top"
                        styleClass="toc-chip"
                      />
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
                        [value]="out.nodeId"
                        severity="secondary"
                        [pTooltip]="out.title"
                        tooltipPosition="top"
                        styleClass="toc-chip"
                      />
                    }
                  </div>
                </div>
              }
              @if (mapping().tocLinks.outcomes.length > 0) {
                <div class="toc-chip-group">
                  <span class="toc-chip-group__label">Intermediate Outcomes</span>
                  <div class="toc-chip-group__chips">
                    @for (ioc of mapping().tocLinks.outcomes; track ioc.id) {
                      <p-tag
                        [value]="ioc.nodeId"
                        severity="warn"
                        [pTooltip]="ioc.title"
                        tooltipPosition="top"
                        styleClass="toc-chip"
                      />
                    }
                  </div>
                </div>
              }
            }
          </div>
        }
      </div>
    }
  `,
  styleUrl: './toc-contribution.component.scss',
})
export class TocContributionComponent implements OnInit {
  private readonly authService = inject(AuthService);
  private readonly tocService = inject(TocService);
  private readonly messageService = inject(MessageService);

  // -----------------------------------------------------------------------
  // Inputs / Outputs
  // -----------------------------------------------------------------------

  /** The mapping row this section belongs to. */
  readonly mapping = input.required<ConsolidatedMapping>();

  /** Whether the project round is locked. */
  readonly isLocked = input<boolean>(false);

  /**
   * Emits the updated TocLinks after a successful save so the parent can
   * update the ConsolidatedMapping signal without a full reload.
   */
  readonly saved = output<TocLinks>();

  // -----------------------------------------------------------------------
  // Derived visibility / role
  // -----------------------------------------------------------------------

  /**
   * The section is visible only for active (non-draft, non-removed) mappings.
   * Draft mappings are private to the center rep; removed ones are gone.
   */
  readonly isVisible = computed(() => {
    const s = this.mapping().status;
    return s !== 'draft' && s !== 'removed';
  });

  /**
   * Editable when:
   *  - Project is NOT locked.
   *  - AND the current user is the program rep for this mapping,
   *    OR the user is a workflow_admin.
   *
   * Everyone else (center_rep, admin, unit_admin, no-role) sees read-only chips.
   */
  readonly canEdit = computed((): boolean => {
    if (this.isLocked()) return false;
    if (this.authService.isWorkflowAdmin()) return true;
    const user = this.authService.currentUser();
    if (!user) return false;
    return user.role === 'program_rep' && user.programId === this.mapping().programId;
  });

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
  // Form state (plain properties — only read on Save)
  // -----------------------------------------------------------------------

  selectedAows: TocAow[] = [];
  selectedOutputs: TocOutput[] = [];
  selectedOutcomes: TocOutcome[] = [];

  readonly saving = signal(false);

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  constructor() {
    // When the mapping input changes (parent reloads data after a socket
    // ping), sync the form state back to the saved values.
    effect(() => {
      const m = this.mapping();
      if (!this.canEdit()) return;

      // Sync saved links into form state. AOW and dependent lists must be
      // available for this to be useful — if they haven't loaded yet the
      // ngOnInit fetch will call syncFormFromLinks() once lists arrive.
      this.syncFormFromLinks(m.tocLinks);
    });
  }

  ngOnInit(): void {
    if (!this.canEdit()) return; // read-only path needs no reference data

    this.loadAows();
  }

  // -----------------------------------------------------------------------
  // Data loading
  // -----------------------------------------------------------------------

  private async loadAows(): Promise<void> {
    this.aowsLoading.set(true);
    try {
      const aows = await this.tocService.getAows(this.mapping().programId);
      this.aows.set(aows);
      // Now that AOW list is available, sync saved links into the form.
      this.syncFormFromLinks(this.mapping().tocLinks);
      // Load dependent lists for any saved AOW selections.
      const savedAowIds = this.mapping().tocLinks.aows.map((a) => a.id);
      if (savedAowIds.length > 0) {
        await this.loadDependentLists(savedAowIds);
      }
    } finally {
      this.aowsLoading.set(false);
    }
  }

  /**
   * Called when the AOW selection changes in the multi-select.
   * Re-fetches outputs and outcomes for the new AOW set, and drops any
   * previously selected outputs/outcomes whose parent AOW was deselected.
   */
  async onAowChange(): Promise<void> {
    const aowIds = this.selectedAows.map((a) => a.id);

    if (aowIds.length === 0) {
      // No AOWs — clear dependent selections without fetching.
      const droppedOutputs = this.selectedOutputs.length;
      const droppedOutcomes = this.selectedOutcomes.length;
      this.outputs.set([]);
      this.outcomes.set([]);

      if (droppedOutputs > 0 || droppedOutcomes > 0) {
        this.selectedOutputs = [];
        this.selectedOutcomes = [];
        this.messageService.add({
          severity: 'info',
          summary: 'Selection cleared',
          detail:
            `${droppedOutputs + droppedOutcomes} output/outcome item(s) removed ` +
            'because their Areas of Work were deselected.',
        });
      }
      return;
    }

    await this.loadDependentLists(aowIds);
  }

  private async loadDependentLists(aowIds: number[]): Promise<void> {
    this.outputsLoading.set(true);
    this.outcomesLoading.set(true);

    const [outputs, outcomes] = await Promise.all([
      this.tocService.getOutputs(this.mapping().programId, aowIds),
      this.tocService.getOutcomes(this.mapping().programId, aowIds),
    ]);

    // Filter out any previously selected items whose AOW is no longer valid.
    const validOutputIds = new Set(outputs.map((o) => o.id));
    const validOutcomeIds = new Set(outcomes.map((o) => o.id));

    const prevOutputCount = this.selectedOutputs.length;
    const prevOutcomeCount = this.selectedOutcomes.length;

    this.selectedOutputs = this.selectedOutputs.filter((o) => validOutputIds.has(o.id));
    this.selectedOutcomes = this.selectedOutcomes.filter((o) => validOutcomeIds.has(o.id));

    const dropped =
      prevOutputCount -
      this.selectedOutputs.length +
      (prevOutcomeCount - this.selectedOutcomes.length);

    if (dropped > 0) {
      this.messageService.add({
        severity: 'info',
        summary: 'Selection updated',
        detail:
          `${dropped} output/outcome item(s) were removed because their ` +
          'Areas of Work are no longer selected.',
      });
    }

    this.outputs.set(outputs);
    this.outcomes.set(outcomes);
    this.outputsLoading.set(false);
    this.outcomesLoading.set(false);
  }

  /**
   * Matches saved link IDs against the loaded reference lists and sets the
   * form selection arrays. Safe to call before lists are loaded (will be
   * re-called once lists arrive).
   */
  private syncFormFromLinks(links: TocLinks): void {
    const aowIds = new Set(links.aows.map((a) => a.id));
    const outputIds = new Set(links.outputs.map((o) => o.id));
    const outcomeIds = new Set(links.outcomes.map((o) => o.id));

    this.selectedAows = this.aows().filter((a) => aowIds.has(a.id));
    this.selectedOutputs = this.outputs().filter((o) => outputIds.has(o.id));
    this.selectedOutcomes = this.outcomes().filter((o) => outcomeIds.has(o.id));
  }

  // -----------------------------------------------------------------------
  // Save
  // -----------------------------------------------------------------------

  /**
   * Save is disabled while:
   *  - No changes vs the last saved state (pristine check).
   *  - A save is already in flight.
   *  - Reference data is still loading.
   */
  isSaveDisabled(): boolean {
    if (this.saving()) return true;
    if (this.aowsLoading() || this.outputsLoading() || this.outcomesLoading()) return true;
    return this.isPristine();
  }

  /**
   * Compares current form selections against the last saved tocLinks to
   * detect unsaved changes.
   */
  private isPristine(): boolean {
    const saved = this.mapping().tocLinks;
    const savedAowIds = new Set(saved.aows.map((a) => a.id));
    const savedOutputIds = new Set(saved.outputs.map((o) => o.id));
    const savedOutcomeIds = new Set(saved.outcomes.map((o) => o.id));

    const selAowIds = new Set(this.selectedAows.map((a) => a.id));
    const selOutputIds = new Set(this.selectedOutputs.map((o) => o.id));
    const selOutcomeIds = new Set(this.selectedOutcomes.map((o) => o.id));

    if (savedAowIds.size !== selAowIds.size) return false;
    if (savedOutputIds.size !== selOutputIds.size) return false;
    if (savedOutcomeIds.size !== selOutcomeIds.size) return false;

    for (const id of savedAowIds) if (!selAowIds.has(id)) return false;
    for (const id of savedOutputIds) if (!selOutputIds.has(id)) return false;
    for (const id of savedOutcomeIds) if (!selOutcomeIds.has(id)) return false;

    return true;
  }

  async save(): Promise<void> {
    this.saving.set(true);
    try {
      const updatedLinks = await this.tocService.updateTocLinks(this.mapping().id, {
        aowIds: this.selectedAows.map((a) => a.id),
        outputIds: this.selectedOutputs.map((o) => o.id),
        outcomeIds: this.selectedOutcomes.map((o) => o.id),
      });

      this.messageService.add({
        severity: 'success',
        summary: 'TOC Contribution saved',
        detail: 'TOC contribution updated.',
      });

      // Emit to parent so it can update the mapping's tocLinks without
      // triggering a full consolidated reload.
      this.saved.emit(updatedLinks);
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
    } finally {
      this.saving.set(false);
    }
  }
}
