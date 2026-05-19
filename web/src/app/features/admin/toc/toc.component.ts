import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  ViewChild,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import { TabsModule } from 'primeng/tabs';
import { SelectModule } from 'primeng/select';
import { ButtonModule } from 'primeng/button';
import { ToastModule } from 'primeng/toast';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { ConfirmationService, MessageService } from 'primeng/api';

import { TocService } from './toc.service';
import { TocAowsComponent } from './toc-aows/toc-aows.component';
import { TocOutcomesComponent } from './toc-outcomes/toc-outcomes.component';
import { TocOutputsComponent } from './toc-outputs/toc-outputs.component';
import { ReferenceDataService } from '../../../core/services/reference-data.service';
import { Program } from '../../../core/models/reference-data.model';

/**
 * TocComponent — /admin/toc shell page.
 *
 * Renders:
 *   - A page header with title and "Sync now" button.
 *   - A shared program p-select (required — required by all three tabs).
 *   - Three PrimeNG tabs: AOWs / Outcomes / Outputs.
 *
 * The selected program and a reload-trigger counter are passed down to each
 * tab as inputs. AOW-level cascading is handled inside the Outcomes and
 * Outputs tab components themselves via Angular effects.
 *
 * The Sync button opens a ConfirmationService dialog. On confirmation it calls
 * POST /admin/sync-toc and then increments `reloadTrigger` so the active tab
 * re-fetches its data.
 */
@Component({
  selector: 'app-toc',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    TabsModule,
    SelectModule,
    ButtonModule,
    ToastModule,
    ConfirmDialogModule,
    TocAowsComponent,
    TocOutcomesComponent,
    TocOutputsComponent,
  ],
  providers: [MessageService, ConfirmationService],
  templateUrl: './toc.component.html',
  styleUrl: './toc.component.scss',
})
export class TocComponent implements OnInit {
  private readonly tocService = inject(TocService);
  private readonly refData = inject(ReferenceDataService);
  private readonly messageService = inject(MessageService);
  private readonly confirmationService = inject(ConfirmationService);

  // ---------------------------------------------------------------------------
  // References to child tab components — used to call loadData() on AOWs tab
  // when the program changes (AOWs doesn't use an effect, it exposes loadData).
  // ---------------------------------------------------------------------------

  @ViewChild(TocAowsComponent) private aowsTab?: TocAowsComponent;

  // ---------------------------------------------------------------------------
  // Program dropdown
  // ---------------------------------------------------------------------------

  /** Programs loaded from the reference-data cache. */
  readonly programs = this.refData.programs;
  readonly programsLoading = signal(false);

  /** The currently selected program — passed to all three tab components. */
  readonly selectedProgram = signal<Program | null>(null);

  // ---------------------------------------------------------------------------
  // Active tab (0 = AOWs, 1 = Outcomes, 2 = Outputs)
  // ---------------------------------------------------------------------------

  readonly activeTab = signal<number>(0);

  // ---------------------------------------------------------------------------
  // Reload trigger — incremented after a successful sync so each mounted
  // tab component reacts and re-fetches its current page.
  // ---------------------------------------------------------------------------

  readonly reloadTrigger = signal(0);

  // ---------------------------------------------------------------------------
  // Sync state
  // ---------------------------------------------------------------------------

  readonly syncing = signal(false);

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async ngOnInit(): Promise<void> {
    // Load programs into the reference-data cache if not already loaded.
    this.programsLoading.set(true);
    await this.refData.loadPrograms();
    this.programsLoading.set(false);
  }

  // ---------------------------------------------------------------------------
  // Program selection
  // ---------------------------------------------------------------------------

  /**
   * Called when the user picks a different program.
   * Updates the shared signal; each tab component reacts via its own effect
   * (Outcomes, Outputs) or via a ViewChild call (AOWs).
   */
  onProgramChange(program: Program | null): void {
    this.selectedProgram.set(program);

    // The AOWs tab doesn't use a reactive effect for program changes (it
    // exposes loadData() directly). Call it here after the signal has
    // propagated so the input binding reflects the new program.
    // Use setTimeout(0) to let Angular flush the signal change first.
    setTimeout(() => {
      if (program) {
        this.aowsTab?.loadData();
      }
    }, 0);
  }

  // ---------------------------------------------------------------------------
  // Sync button
  // ---------------------------------------------------------------------------

  /** Opens the PrimeNG confirm dialog before running the sync. */
  confirmSync(): void {
    this.confirmationService.confirm({
      header: 'Sync TOC data?',
      message:
        'Syncing pulls data from the MEL TOC API for all 14 programs. This takes 30–60 seconds. Continue?',
      icon: 'pi pi-refresh',
      acceptLabel: 'Sync now',
      rejectLabel: 'Cancel',
      acceptButtonStyleClass: 'p-button-primary',
      accept: () => this.executeSync(),
    });
  }

  /** Calls POST /admin/sync-toc and handles success/error feedback. */
  private executeSync(): void {
    this.syncing.set(true);

    this.tocService.syncToc().subscribe({
      next: (result) => {
        this.syncing.set(false);

        const failNote = result.failed > 0 ? ` (${result.failed} failed)` : '';
        this.messageService.add({
          severity: result.failed > 0 ? 'warn' : 'success',
          summary: 'Sync complete',
          detail: `Synced ${result.synced} program${result.synced !== 1 ? 's' : ''}${failNote}.`,
          life: 6000,
        });

        // Increment the trigger so mounted tab components reload their data.
        this.reloadTrigger.update((n) => n + 1);
      },
      error: (err: unknown) => {
        this.syncing.set(false);
        this.messageService.add({
          severity: 'error',
          summary: 'Sync failed',
          detail: this.extractErrorMessage(err),
          life: 8000,
        });
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private extractErrorMessage(err: unknown): string {
    if (err && typeof err === 'object') {
      const httpErr = err as { error?: { message?: string | string[] } };
      if (httpErr.error?.message) {
        const msg = httpErr.error.message;
        return Array.isArray(msg) ? msg.join(' ') : msg;
      }
    }
    return 'An unexpected error occurred. Please try again.';
  }
}
