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
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { SkeletonModule } from 'primeng/skeleton';
import { TooltipModule } from 'primeng/tooltip';

import { Subject, Subscription, debounceTime, distinctUntilChanged } from 'rxjs';

import { TocService } from '../toc.service';
import { AowOption, TocOutput } from '../toc.model';
import { Program } from '../../../../core/models/reference-data.model';

/**
 * TocOutputsComponent — Outputs tab content.
 *
 * Structurally identical to TocOutcomesComponent, but uses the
 * /admin/toc/outputs endpoint and renders `typeOfOutput` as plain text
 * instead of a styled p-tag.
 */
@Component({
  selector: 'app-toc-outputs',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    DatePipe,
    TableModule,
    ButtonModule,
    SelectModule,
    InputTextModule,
    IconFieldModule,
    InputIconModule,
    SkeletonModule,
    TooltipModule,
  ],
  templateUrl: './toc-outputs.component.html',
  styleUrl: './toc-outputs.component.scss',
})
export class TocOutputsComponent implements OnInit, OnDestroy {
  private readonly tocService = inject(TocService);

  // ---------------------------------------------------------------------------
  // Inputs
  // ---------------------------------------------------------------------------

  readonly selectedProgram = input<Program | null>(null);
  readonly reloadTrigger = input<number>(0);

  // ---------------------------------------------------------------------------
  // Table state
  // ---------------------------------------------------------------------------

  readonly outputs = signal<TocOutput[]>([]);
  readonly total = signal(0);
  readonly loading = signal(false);

  private currentPage = 1;
  private currentPageSize = 25;

  // ---------------------------------------------------------------------------
  // Filter state
  // ---------------------------------------------------------------------------

  readonly searchText = signal('');
  readonly selectedAowId = signal<number | null>(null);
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
    /** React to program changes: clear AOW, reload options and table. */
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
        this.outputs.set([]);
        this.total.set(0);
      }
    });

    /** Sync reload trigger from parent after a successful sync. */
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

  loadData(): void {
    const program = this.selectedProgram();
    if (!program) return;

    this.loading.set(true);

    this.tocService
      .getOutputs({
        programId: program.id,
        aowId: this.selectedAowId() ?? undefined,
        page: this.currentPage,
        limit: this.currentPageSize,
        search: this.searchText().trim() || undefined,
      })
      .subscribe({
        next: (res) => {
          this.outputs.set(res.data);
          this.total.set(res.total);
          this.loading.set(false);
        },
        error: () => {
          this.loading.set(false);
        },
      });
  }

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

  aowLabel(output: TocOutput): string {
    if (!output.aow) return '—';
    const parts = [output.aow.acronym, output.aow.name].filter(Boolean);
    return parts.length ? parts.join(' — ') : '—';
  }

  truncate(text: string | null, maxLen = 100): string {
    if (!text) return '—';
    return text.length > maxLen ? text.slice(0, maxLen) + '…' : text;
  }
}
