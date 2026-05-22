import { Component, inject, signal, computed, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { FileUploadModule, FileUpload, FileUploadHandlerEvent } from 'primeng/fileupload';
import { ButtonModule } from 'primeng/button';
import { ProgressBarModule } from 'primeng/progressbar';
import { TableModule } from 'primeng/table';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { MessageModule } from 'primeng/message';
import { TagModule } from 'primeng/tag';
import { AccordionModule } from 'primeng/accordion';

import { AdminImportsService } from './admin-imports.service';
import { BulkFileResult, BulkImportResponse, BulkUploadState } from './imports.model';

/**
 * AdminImportsComponent — the /admin/imports page.
 *
 * Renders a single multi-file drop zone (p-fileupload in advanced mode).
 * On upload the files are sent together to POST /admin/imports/bulk.
 * The backend detects each file's type, processes 4.1 before 4.3, and returns
 * per-file results and aggregate totals that are rendered in a results panel.
 *
 * The component is intentionally self-contained — no child components needed.
 */
@Component({
  selector: 'app-admin-imports',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    FileUploadModule,
    ButtonModule,
    ProgressBarModule,
    TableModule,
    InputTextModule,
    IconFieldModule,
    InputIconModule,
    MessageModule,
    TagModule,
    AccordionModule,
  ],
  templateUrl: './admin-imports.component.html',
  styleUrl: './admin-imports.component.scss',
})
export class AdminImportsComponent {
  private readonly importsService = inject(AdminImportsService);

  // ---------------------------------------------------------------------------
  // p-fileupload reference — needed for programmatic clear() calls
  // ---------------------------------------------------------------------------

  @ViewChild('fileUpload') fileUploadRef!: FileUpload;

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  /** Current lifecycle state for the bulk upload. */
  readonly uploadState = signal<BulkUploadState>({ status: 'idle' });

  /**
   * Per-file filter strings keyed by filename.
   * Each accordion tab gets its own filter so they don't interfere.
   */
  readonly errorFilters = signal<Record<string, string>>({});

  // ---------------------------------------------------------------------------
  // Derived signals
  // ---------------------------------------------------------------------------

  /** True while the HTTP request is in flight. */
  readonly isUploading = computed(() => this.uploadState().status === 'uploading');

  /** The full response once the request completed successfully. */
  readonly response = computed<BulkImportResponse | null>(() => {
    const s = this.uploadState();
    return s.status === 'done' ? s.response : null;
  });

  /** The server-level error message if the whole request was rejected. */
  readonly serverError = computed<string | null>(() => {
    const s = this.uploadState();
    return s.status === 'error' ? s.message : null;
  });

  /**
   * List of accordion panel values (tab indices) that should start expanded.
   *
   * We always expand the first file tab. When there is a file with errors we
   * also ensure that tab is in the list so the user sees it immediately.
   * The p-accordion receives this as its [value] binding with [multiple]="true".
   */
  readonly expandedPanels = computed<number[]>(() => {
    const r = this.response();
    if (!r || r.files.length === 0) return [];

    // Always expand the first file tab.
    const open = new Set<number>([0]);

    // Also expand the first tab that has errors (may be the same as index 0).
    const firstErrorIdx = r.files.findIndex((f) => f.errors.length > 0);
    if (firstErrorIdx >= 0) open.add(firstErrorIdx);

    return Array.from(open);
  });

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  /**
   * Called by p-fileupload's (uploadHandler) event in customUpload mode.
   * Sends all staged files to the bulk endpoint in a single POST.
   */
  onUploadHandler(event: FileUploadHandlerEvent): void {
    const files = event.files;
    if (!files || files.length === 0) return;

    // Transition to uploading immediately so the progress bar appears.
    this.uploadState.set({ status: 'uploading' });

    this.importsService.uploadBulk(Array.from(files)).subscribe({
      next: (response) => {
        this.uploadState.set({ status: 'done', response });
        // Clear staged files from the uploader widget.
        this.fileUploadRef?.clear();
      },
      error: (err) => {
        this.uploadState.set({ status: 'error', message: this.extractErrorMessage(err) });
        this.fileUploadRef?.clear();
      },
    });
  }

  /**
   * Resets the page back to the empty drop-zone state.
   * Triggered by the "Run again" button in the results panel.
   */
  reset(): void {
    this.uploadState.set({ status: 'idle' });
    this.errorFilters.set({});
    this.fileUploadRef?.clear();
  }

  /**
   * Returns the current filter string for the given filename's error table.
   * Called from the template for each accordion tab.
   */
  getErrorFilter(filename: string): string {
    return this.errorFilters()[filename] ?? '';
  }

  /**
   * Updates the filter string for a specific file's error table.
   * Called from the template's (input) binding inside each accordion tab.
   */
  setErrorFilter(filename: string, value: string): void {
    this.errorFilters.update((filters) => ({ ...filters, [filename]: value }));
  }

  // ---------------------------------------------------------------------------
  // Template helpers
  // ---------------------------------------------------------------------------

  /**
   * Returns the p-tag severity for a file's type badge.
   * - 4.1 / toc → success (green)  — primary data files
   * - 4.3 / signalling / country-* → info (blue)  — secondary data
   * - unknown → danger (red) — backend could not detect the type
   */
  typeBadgeSeverity(type: BulkFileResult['type']): 'success' | 'info' | 'warn' | 'danger' {
    if (type === '4.1' || type === 'toc') return 'success';
    if (type === 'country-benefit' || type === 'country-implementation') return 'warn';
    if (type === '4.3' || type === 'signalling') return 'info';
    return 'danger';
  }

  /**
   * Builds the inline summary shown in each accordion tab header.
   * Example: "12 created · 0 updated · 3 skipped · 1 error"
   */
  fileSummary(file: BulkFileResult): string {
    const errCount = file.errors.length;
    const errLabel = errCount === 1 ? 'error' : 'errors';
    return `${file.created} created · ${file.updated} updated · ${file.skipped} skipped · ${errCount} ${errLabel}`;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Extracts a human-readable message from an HTTP error response.
   * Falls back to a generic message if the body does not have a `message` field.
   */
  private extractErrorMessage(err: unknown): string {
    if (
      err !== null &&
      typeof err === 'object' &&
      'error' in err &&
      err.error !== null &&
      typeof err.error === 'object' &&
      'message' in err.error &&
      typeof (err.error as { message: unknown }).message === 'string'
    ) {
      return (err.error as { message: string }).message;
    }
    return 'The server rejected the upload. Check the files and try again.';
  }
}
