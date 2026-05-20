import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';

import { TableLazyLoadEvent, TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { SkeletonModule } from 'primeng/skeleton';
import { TooltipModule } from 'primeng/tooltip';

import { Subject, Subscription, debounceTime, distinctUntilChanged } from 'rxjs';

import { TocService } from '../toc.service';
import { AowOption, OutcomeType, TocOutcome } from '../toc.model';
import { Program } from '../../../../core/models/reference-data.model';

/** Severity mapping for the outcomeType p-tag. */
const OUTCOME_TYPE_SEVERITY: Record<OutcomeType, 'info' | 'success'> = {
  intermediate: 'info',
  portfolio: 'success',
};

/** Human-readable labels for each outcome type. */
const OUTCOME_TYPE_LABEL: Record<OutcomeType, string> = {
  intermediate: 'Intermediate',
  portfolio: 'Portfolio',
};

/**
 * TocOutcomesComponent — Outcomes tab content.
 *
 * Displays a server-side paginated table of Outcomes. Accepts a cascading
 * AOW filter that reloads when the parent changes the selected program.
 * Description column is truncated at ~100 chars with a tooltip showing
 * the full text on hover.
 */
@Component({
  selector: 'app-toc-outcomes',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    DatePipe,
    TableModule,
    TagModule,
    ButtonModule,
    SelectModule,
    InputTextModule,
    IconFieldModule,
    InputIconModule,
    SkeletonModule,
    TooltipModule,
  ],
  templateUrl: './toc-outcomes.component.html',
  styleUrl: './toc-outcomes.component.scss',
})
export class TocOutcomesComponent implements OnInit, OnDestroy {
  private readonly tocService = inject(TocService);

  // ---------------------------------------------------------------------------
  // Inputs — provided by the parent TocComponent
  // ---------------------------------------------------------------------------

  /** Currently selected program. null means no program is chosen. */
  readonly selectedProgram = input<Program | null>(null);

  /**
   * Counter incremented by the parent after a successful sync to trigger
   * a reload of this tab's data.
   */
  readonly reloadTrigger = input<number>(0);

  // ---------------------------------------------------------------------------
  // Table state
  // ---------------------------------------------------------------------------

  readonly outcomes = signal<TocOutcome[]>([]);
  readonly total = signal(0);
  readonly loading = signal(false);

  private currentPage = 1;
  private currentPageSize = 25;

  // ---------------------------------------------------------------------------
  // Filter state
  // ---------------------------------------------------------------------------

  readonly searchText = signal('');

  /** Selected AOW id for cascading filter. null = all AOWs. */
  readonly selectedAowId = signal<number | null>(null);

  /** Options list for the AOW p-select — reloaded when program changes. */
  readonly aowOptions = signal<AowOption[]>([]);
  readonly aowsLoading = signal(false);

  // ---------------------------------------------------------------------------
  // Search debounce
  // ---------------------------------------------------------------------------

  private readonly searchSubject = new Subject<string>();
  private readonly subscriptions = new Subscription();

  // ---------------------------------------------------------------------------
  // Constructor — cascading effect
  // ---------------------------------------------------------------------------

  /** Tracks the last program id seen by the effect so we only react to real changes. */
  private prevProgramId: number | null = null;

  constructor() {
    /**
     * React to program changes: clear the AOW selection, reload the AOW
     * dropdown options, and reload the outcomes table.
     */
    effect(() => {
      const program = this.selectedProgram();
      const newId = program?.id ?? null;
      if (newId === this.prevProgramId) return;
      this.prevProgramId = newId;

      this.selectedAowId.set(null);

      if (program) {
        this.loadAowOptions(program.id);
        this.currentPage = 1;
        this.loadData();
      } else {
        this.aowOptions.set([]);
        this.outcomes.set([]);
        this.total.set(0);
      }
    });

    /**
     * React to sync reload trigger from the parent shell.
     * The trigger starts at 0 (initial value); only reload when > 0
     * to avoid a redundant call on component init (the program effect
     * already fires first).
     */
    effect(() => {
      const trigger = this.reloadTrigger();
      if (trigger > 0 && this.selectedProgram()) {
        this.currentPage = 1;
        this.loadData();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  ngOnInit(): void {
    this.subscriptions.add(
      this.searchSubject.pipe(debounceTime(300), distinctUntilChanged()).subscribe(() => {
        this.currentPage = 1;
        this.loadData();
      }),
    );
  }

  ngOnDestroy(): void {
    this.subscriptions.unsubscribe();
  }

  // ---------------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------------

  /** Fetches one page of outcomes with current filter + pagination state. */
  loadData(): void {
    const program = this.selectedProgram();
    if (!program) return;

    this.loading.set(true);

    this.tocService
      .getOutcomes({
        programId: program.id,
        aowId: this.selectedAowId() ?? undefined,
        page: this.currentPage,
        limit: this.currentPageSize,
        search: this.searchText().trim() || undefined,
      })
      .subscribe({
        next: (res) => {
          this.outcomes.set(res.data);
          this.total.set(res.total);
          this.loading.set(false);
        },
        error: () => {
          this.loading.set(false);
        },
      });
  }

  /**
   * Loads the AOW dropdown options for the given programId.
   * Uses limit=100 (well above the per-program maximum) to get all in one call.
   */
  private loadAowOptions(programId: number): void {
    this.aowsLoading.set(true);
    this.tocService.loadAowOptions(programId).subscribe({
      next: (res) => {
        this.aowOptions.set(this.tocService.mapAowsToOptions(res.data));
        this.aowsLoading.set(false);
      },
      error: () => {
        this.aowOptions.set([]);
        this.aowsLoading.set(false);
      },
    });
  }

  // ---------------------------------------------------------------------------
  // PrimeNG lazy-load event
  // ---------------------------------------------------------------------------

  onLazyLoad(event: TableLazyLoadEvent): void {
    const first = event.first ?? 0;
    const rows = event.rows ?? 25;
    this.currentPage = Math.floor(first / rows) + 1;
    this.currentPageSize = rows;
    this.loadData();
  }

  // ---------------------------------------------------------------------------
  // Filter handlers
  // ---------------------------------------------------------------------------

  onSearchInput(value: string): void {
    this.searchText.set(value);
    this.searchSubject.next(value);
  }

  onAowChange(aowId: number | null): void {
    this.selectedAowId.set(aowId);
    this.currentPage = 1;
    this.loadData();
  }

  clearFilters(): void {
    this.searchText.set('');
    this.selectedAowId.set(null);
    this.currentPage = 1;
    this.loadData();
  }

  // ---------------------------------------------------------------------------
  // Display helpers
  // ---------------------------------------------------------------------------

  /** Returns the PrimeNG severity for the outcomeType badge. */
  outcomeSeverity(type: OutcomeType): 'info' | 'success' {
    return OUTCOME_TYPE_SEVERITY[type] ?? 'info';
  }

  /** Returns the human-readable label for the outcomeType badge. */
  outcomeLabel(type: OutcomeType): string {
    return OUTCOME_TYPE_LABEL[type] ?? type;
  }

  /** Renders the AOW column value. */
  aowLabel(outcome: TocOutcome): string {
    if (!outcome.aow) return '—';
    const parts = [outcome.aow.acronym, outcome.aow.name].filter(Boolean);
    return parts.length ? parts.join(' — ') : '—';
  }

  /**
   * Truncates a description to at most maxLen characters and appends
   * an ellipsis when truncated. The full text lives in the pTooltip.
   */
  truncate(text: string | null, maxLen = 100): string {
    if (!text) return '—';
    return text.length > maxLen ? text.slice(0, maxLen) + '…' : text;
  }
}
