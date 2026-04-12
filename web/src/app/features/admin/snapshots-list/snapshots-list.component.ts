import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { TableModule } from 'primeng/table';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { SkeletonModule } from 'primeng/skeleton';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { ToastModule } from 'primeng/toast';
import { TextareaModule } from 'primeng/textarea';
import { MessageService } from 'primeng/api';

import { SnapshotsService } from './snapshots.service';
import { SnapshotListItem } from './snapshots.model';

/**
 * SnapshotsListComponent — admin page for viewing all published snapshots
 * and creating new ones.
 *
 * Loaded lazily under /admin/snapshots. Follows the same structure as
 * CentersListComponent, CountriesListComponent, and ProgramsListComponent.
 */
@Component({
  selector: 'app-snapshots-list',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    TableModule,
    InputTextModule,
    IconFieldModule,
    InputIconModule,
    SkeletonModule,
    TagModule,
    ButtonModule,
    DialogModule,
    ToastModule,
    TextareaModule,
  ],
  providers: [MessageService],
  templateUrl: './snapshots-list.component.html',
  styleUrl: './snapshots-list.component.scss',
})
export class SnapshotsListComponent implements OnInit {
  private readonly snapshotsService = inject(SnapshotsService);
  private readonly messageService = inject(MessageService);

  /** True while the initial list fetch is in flight. */
  readonly loading = signal(true);

  /** The list of snapshots returned by the API. */
  readonly snapshots = signal<SnapshotListItem[]>([]);

  /** Controls the create-snapshot dialog visibility. */
  readonly showCreateDialog = signal(false);

  /** True while the create API call is in flight (prevents double-submit). */
  readonly creating = signal(false);

  /** Bound to the Version Label input inside the create dialog. */
  readonly newVersionLabel = signal('');

  /** Bound to the Description textarea inside the create dialog. */
  readonly newDescription = signal('');

  /** Placeholder rows shown in the table while data loads. */
  readonly skeletonRows = Array(8).fill(null);

  ngOnInit(): void {
    this.loadSnapshots();
  }

  /**
   * Loads the full snapshot list from the API and stores it in the
   * `snapshots` signal. Resets `loading` when complete (success or error).
   */
  private loadSnapshots(): void {
    this.loading.set(true);
    this.snapshotsService.listSnapshots().subscribe({
      next: (data) => {
        this.snapshots.set(data);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.messageService.add({
          severity: 'error',
          summary: 'Error',
          detail: 'Failed to load snapshots. Please try again.',
        });
      },
    });
  }

  /**
   * Submits the create-snapshot form. On success, prepends the new snapshot
   * to the list and closes the dialog. Shows a toast on both success and error.
   */
  onCreate(): void {
    const label = this.newVersionLabel().trim();
    if (!label || this.creating()) return;

    this.creating.set(true);

    this.snapshotsService
      .createSnapshot({
        versionLabel: label,
        description: this.newDescription().trim() || undefined,
      })
      .subscribe({
        next: (created) => {
          // Prepend so the newest snapshot appears first without a full re-fetch
          this.snapshots.update((list) => [created, ...list]);
          this.messageService.add({
            severity: 'success',
            summary: 'Snapshot Created',
            detail: `Version "${created.versionLabel}" has been published.`,
          });
          this.closeDialog();
          this.creating.set(false);
        },
        error: () => {
          this.creating.set(false);
          this.messageService.add({
            severity: 'error',
            summary: 'Error',
            detail: 'Failed to create snapshot. Please try again.',
          });
        },
      });
  }

  /**
   * Closes the create dialog and resets all dialog-scoped form state.
   */
  closeDialog(): void {
    this.showCreateDialog.set(false);
    this.newVersionLabel.set('');
    this.newDescription.set('');
  }
}
