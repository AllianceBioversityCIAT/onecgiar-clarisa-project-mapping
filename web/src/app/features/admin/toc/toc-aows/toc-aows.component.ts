import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  inject,
  input,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';

import { TableLazyLoadEvent, TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { SkeletonModule } from 'primeng/skeleton';
import { MessageModule } from 'primeng/message';

import { Subject, Subscription, debounceTime, distinctUntilChanged } from 'rxjs';

import { TocService } from '../toc.service';
import { TocAow } from '../toc.model';
import { Program } from '../../../../core/models/reference-data.model';

/**
 * TocAowsComponent — AOWs tab content.
 *
 * Displays a server-side paginated table of Areas of Work filtered by the
 * selected program. Shows an empty-state prompt when no program is selected.
 * Receives the active program and a reload trigger from the parent shell.
 */
@Component({
  selector: 'app-toc-aows',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    DatePipe,
    TableModule,
    ButtonModule,
    InputTextModule,
    IconFieldModule,
    InputIconModule,
    SkeletonModule,
    MessageModule,
  ],
  templateUrl: './toc-aows.component.html',
  styleUrl: './toc-aows.component.scss',
})
export class TocAowsComponent implements OnInit, OnDestroy {
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

  readonly aows = signal<TocAow[]>([]);
  readonly total = signal(0);
  readonly loading = signal(false);

  /** Pagination state kept in sync with the lazy-load event. */
  private currentPage = 1;
  private currentPageSize = 25;

  // ---------------------------------------------------------------------------
  // Filter state
  // ---------------------------------------------------------------------------

  readonly searchText = signal('');

  // ---------------------------------------------------------------------------
  // Search debounce
  // ---------------------------------------------------------------------------

  private readonly searchSubject = new Subject<string>();
  private readonly subscriptions = new Subscription();

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  ngOnInit(): void {
    // Debounce free-text search to avoid an API call on every keystroke.
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

  /** Fetches one page of AOWs using current filter + pagination state. */
  loadData(): void {
    const program = this.selectedProgram();
    if (!program) return;

    this.loading.set(true);

    this.tocService
      .getAows({
        programId: program.id,
        page: this.currentPage,
        limit: this.currentPageSize,
        search: this.searchText().trim() || undefined,
      })
      .subscribe({
        next: (res) => {
          this.aows.set(res.data);
          this.total.set(res.total);
          this.loading.set(false);
        },
        error: () => {
          this.loading.set(false);
        },
      });
  }

  // ---------------------------------------------------------------------------
  // PrimeNG lazy-load event
  // ---------------------------------------------------------------------------

  /**
   * Called by p-table on every page change.
   * Converts the zero-based `first` offset to a 1-based page number.
   */
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

  /** Feeds the 300 ms debounce on each keystroke. */
  onSearchInput(value: string): void {
    this.searchText.set(value);
    this.searchSubject.next(value);
  }

  /** Resets search and reloads. */
  clearSearch(): void {
    this.searchText.set('');
    this.currentPage = 1;
    this.loadData();
  }

  // ---------------------------------------------------------------------------
  // Display helpers
  // ---------------------------------------------------------------------------

  /** Combines program officialCode and name for the Program column. */
  programLabel(aow: TocAow): string {
    return `${aow.program.officialCode} — ${aow.program.name}`;
  }
}
