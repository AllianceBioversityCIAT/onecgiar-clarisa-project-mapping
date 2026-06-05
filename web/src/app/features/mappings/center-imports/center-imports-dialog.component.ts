import { Component, inject, signal, input, output, model } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

// PrimeNG
import { DialogModule } from 'primeng/dialog';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { TableModule } from 'primeng/table';
import { TooltipModule } from 'primeng/tooltip';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { MessageModule } from 'primeng/message';
import { FileUploadModule, FileSelectEvent } from 'primeng/fileupload';
import { MessageService } from 'primeng/api';

import {
  CenterImportsService,
  ValidateImportResponse,
  PreviewCreate,
  PreviewUpdate,
  PreviewRemove,
} from './center-imports.service';

/** Dialog state machine steps. */
type ImportStep = 'choose' | 'upload' | 'preview';

/**
 * CenterImportsDialogComponent
 *
 * Three-step import wizard presented inside a PrimeNG p-dialog:
 *   Step "choose"  — pick import type (currently only Mappings)
 *   Step "upload"  — download template + upload file + validate
 *   Step "preview" — review validate response, confirm or cancel
 *
 * Emits (importCompleted) when commit() succeeds so the parent can
 * refresh its project list without the dialog needing a direct reference.
 */
@Component({
  selector: 'app-center-imports-dialog',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    DialogModule,
    ButtonModule,
    TagModule,
    TableModule,
    TooltipModule,
    ProgressSpinnerModule,
    MessageModule,
    FileUploadModule,
  ],
  template: `
    <p-dialog
      [(visible)]="visible"
      [modal]="true"
      [closable]="true"
      [draggable]="false"
      [resizable]="false"
      [style]="{ width: '720px', maxWidth: '95vw' }"
      [contentStyle]="{ 'max-height': '75vh', overflow: 'auto' }"
      header="Import Data"
      styleClass="import-dialog"
      (onHide)="onDialogHide()"
    >
      <!-- ===== STEP: CHOOSE ===== -->
      @if (step() === 'choose') {
        <div class="import-choose">
          <p class="import-choose__lead">Select the type of data you want to import.</p>

          <div class="import-choose__options">
            <!-- Mappings tile — the only option for now -->
            <button type="button" class="import-option-tile" (click)="selectMappings()">
              <span class="import-option-tile__icon">
                <i class="pi pi-sitemap"></i>
              </span>
              <span class="import-option-tile__body">
                <span class="import-option-tile__title">Import Mappings</span>
                <span class="import-option-tile__desc">
                  Bulk-create, update, or remove project-to-program mappings for your center using
                  an Excel file.
                </span>
              </span>
              <i class="pi pi-angle-right import-option-tile__arrow"></i>
            </button>
          </div>
        </div>
      }

      <!-- ===== STEP: UPLOAD ===== -->
      @if (step() === 'upload') {
        <div class="import-upload">
          <!-- Back link -->
          <button type="button" class="import-back-link" (click)="goToChoose()">
            <i class="pi pi-arrow-left"></i> Back
          </button>

          <!-- Section 1: How to prepare the file -->
          <div class="import-section">
            <h3 class="import-section__title"><i class="pi pi-info-circle"></i> Prepare your file</h3>
            <p class="import-section__desc">
              Use the <strong>Export</strong> button on the Projects page to download the
              projects list. Edit the program columns
              (<em>Program 1/2/3</em>, <em>Program %</em>, <em>Complementarity</em>,
              <em>Efficiency</em>) and the project fields
              (<em>Summary</em> — max 150 words, <em>Description</em>)
              for your center's projects, then upload the file below.
              Only include projects that belong to your center.
            </p>
          </div>

          <div class="import-section-divider"></div>

          <!-- Section 2: Upload file -->
          <div class="import-section">
            <h3 class="import-section__title"><i class="pi pi-upload"></i> Upload File</h3>
            <p class="import-section__desc">
              Select your completed Excel file (.xlsx). The file will be validated before any
              changes are applied.
            </p>

            @if (validateLoading()) {
              <!-- Validation spinner overlay -->
              <div class="import-spinner-wrap">
                <p-progressspinner strokeWidth="4" />
                <span class="import-spinner-wrap__label">Validating file…</span>
              </div>
            } @else {
              <p-fileupload
                mode="basic"
                accept=".xlsx"
                chooseLabel="Select file"
                [maxFileSize]="10485760"
                [auto]="false"
                (onSelect)="onFileSelect($event)"
                styleClass="import-fileupload"
              />
            }
          </div>
        </div>
      }

      <!-- ===== STEP: PREVIEW ===== -->
      @if (step() === 'preview') {
        <div class="import-preview">
          <!-- Back link -->
          <button type="button" class="import-back-link" (click)="goToUpload()">
            <i class="pi pi-arrow-left"></i> Back to upload
          </button>

          <!-- Summary chips -->
          <div class="import-summary-chips">
            <p-tag
              [value]="'Create: ' + (validateResponse()?.summary?.toCreate ?? 0)"
              severity="success"
              styleClass="import-chip"
            />
            <p-tag
              [value]="'Update: ' + (validateResponse()?.summary?.toUpdate ?? 0)"
              severity="info"
              styleClass="import-chip"
            />
            <p-tag
              [value]="'Remove: ' + (validateResponse()?.summary?.toRemove ?? 0)"
              severity="warn"
              styleClass="import-chip"
            />
            <p-tag
              [value]="'Errors: ' + (validateResponse()?.summary?.errors ?? 0)"
              severity="danger"
              styleClass="import-chip"
            />
            @if (validateResponse()?.summary?.skipped) {
              <p-tag
                [value]="'Skipped: ' + (validateResponse()?.summary?.skipped ?? 0)"
                severity="danger"
                styleClass="import-chip"
              />
            }
          </div>

          <!-- Errors section -->
          @if (validateResponse()?.errors?.length) {
            <div class="import-errors-banner">
              <div class="import-errors-banner__header">
                <i class="pi pi-times-circle"></i>
                {{ validateResponse()!.errors.length }} error(s) found — fix before importing
              </div>
              <ul class="import-errors-list">
                @for (err of validateResponse()!.errors; track err.row) {
                  <li>
                    Row {{ err.row }} —
                    <strong>{{ err.projectCode }}</strong>
                    /
                    <strong>{{ err.programCode }}</strong
                    >:
                    {{ err.message }}
                  </li>
                }
              </ul>
            </div>
          }

          <!-- Skipped projects (did not reach 100%) -->
          @if (validateResponse()?.skipped?.length) {
            <div class="import-errors-banner import-errors-banner--skipped">
              <div class="import-errors-banner__header">
                <i class="pi pi-exclamation-triangle"></i>
                {{ validateResponse()!.skipped.length }} project(s) skipped — allocations must total
                100% to import
              </div>
              <ul class="import-errors-list">
                @for (sk of validateResponse()!.skipped; track sk.row) {
                  <li>
                    <strong>{{ sk.projectCode }}</strong
                    >: {{ sk.message }}
                  </li>
                }
              </ul>
            </div>
          }

          <!-- Removals warning -->
          @if (validateResponse()?.preview?.toRemove?.length) {
            <p-message severity="warn" styleClass="import-remove-warning">
              <span>
                <strong>The following mappings will be REMOVED</strong> because they are not present
                in the uploaded file. Review carefully before confirming.
              </span>
            </p-message>

            <div class="import-table-section">
              <h4 class="import-table-section__title">
                Will be removed ({{ validateResponse()!.preview.toRemove.length }})
              </h4>
              <p-table
                [value]="validateResponse()!.preview.toRemove"
                [paginator]="validateResponse()!.preview.toRemove.length > 10"
                [rows]="10"
                styleClass="import-table"
                [scrollable]="true"
                scrollHeight="220px"
              >
                <ng-template pTemplate="header">
                  <tr>
                    <th>Project</th>
                    <th>Program</th>
                    <th style="text-align:right">Allocation %</th>
                  </tr>
                </ng-template>
                <ng-template pTemplate="body" let-row>
                  <tr class="import-table__remove-row">
                    <td>{{ row.projectCode }}</td>
                    <td>{{ row.programCode }}</td>
                    <td style="text-align:right">{{ row.currentAllocation }}%</td>
                  </tr>
                </ng-template>
              </p-table>
            </div>
          }

          <!-- Will be created -->
          @if (validateResponse()?.preview?.toCreate?.length) {
            <div class="import-table-section">
              <h4 class="import-table-section__title">
                Will be created ({{ validateResponse()!.preview.toCreate.length }})
              </h4>
              <p-table
                [value]="validateResponse()!.preview.toCreate"
                [paginator]="validateResponse()!.preview.toCreate.length > 10"
                [rows]="10"
                styleClass="import-table"
                [scrollable]="true"
                scrollHeight="220px"
              >
                <ng-template pTemplate="header">
                  <tr>
                    <th>Project</th>
                    <th>Program</th>
                    <th style="text-align:right">Allocation %</th>
                    <th>Complementarity</th>
                    <th>Efficiency</th>
                    <th>Justification</th>
                  </tr>
                </ng-template>
                <ng-template pTemplate="body" let-row>
                  <tr>
                    <td>{{ row.projectCode }}</td>
                    <td>{{ row.programCode }}</td>
                    <td style="text-align:right">{{ row.allocationPercentage }}%</td>
                    <td>{{ row.complementarityRating }}</td>
                    <td>{{ row.efficiencyRating }}</td>
                    <td>
                      <span
                        [pTooltip]="row.justification?.length > 80 ? row.justification : ''"
                        tooltipPosition="top"
                      >
                        {{ truncate(row.justification, 80) }}
                      </span>
                    </td>
                  </tr>
                </ng-template>
              </p-table>
            </div>
          }

          <!-- Will be updated -->
          @if (validateResponse()?.preview?.toUpdate?.length) {
            <div class="import-table-section">
              <h4 class="import-table-section__title">
                Will be updated ({{ validateResponse()!.preview.toUpdate.length }})
              </h4>
              <p-table
                [value]="validateResponse()!.preview.toUpdate"
                [paginator]="validateResponse()!.preview.toUpdate.length > 10"
                [rows]="10"
                styleClass="import-table"
                [scrollable]="true"
                scrollHeight="220px"
              >
                <ng-template pTemplate="header">
                  <tr>
                    <th>Project</th>
                    <th>Program</th>
                    <th style="text-align:right">Allocation</th>
                    <th>Complementarity</th>
                    <th>Efficiency</th>
                    <th>Justification</th>
                  </tr>
                </ng-template>
                <ng-template pTemplate="body" let-row>
                  <tr>
                    <td>{{ row.projectCode }}</td>
                    <td>{{ row.programCode }}</td>
                    <td style="text-align:right">
                      @if (row.currentAllocation !== row.newAllocation) {
                        <span class="import-alloc-changed">
                          {{ row.currentAllocation }}% → {{ row.newAllocation }}%
                        </span>
                      } @else {
                        {{ row.newAllocation }}%
                      }
                    </td>
                    <td>{{ row.complementarityRating }}</td>
                    <td>{{ row.efficiencyRating }}</td>
                    <td>
                      <span
                        [pTooltip]="row.justification?.length > 80 ? row.justification : ''"
                        tooltipPosition="top"
                      >
                        {{ truncate(row.justification, 80) }}
                      </span>
                    </td>
                  </tr>
                </ng-template>
              </p-table>
            </div>
          }

          <!-- Commit error -->
          @if (commitError()) {
            <p-message severity="error" styleClass="import-commit-error">
              <span>{{ commitError() }}</span>
            </p-message>
          }
        </div>
      }

      <!-- Dialog footer -->
      <ng-template pTemplate="footer">
        @if (step() === 'preview') {
          <p-button label="Cancel" severity="secondary" [outlined]="true" (onClick)="close()" />
          <p-button
            label="Confirm Import"
            icon="pi pi-check"
            [loading]="commitLoading()"
            [disabled]="!canCommit()"
            (onClick)="confirmImport()"
          />
        } @else {
          <p-button label="Close" severity="secondary" [outlined]="true" (onClick)="close()" />
        }
      </ng-template>
    </p-dialog>
  `,
  styles: [
    `
      /* ---- Choose step ---- */
      .import-choose__lead {
        color: #777;
        margin-bottom: 1.25rem;
      }

      .import-choose__options {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
      }

      .import-option-tile {
        display: flex;
        align-items: center;
        gap: 1rem;
        padding: 1rem 1.25rem;
        background: #faf9f9;
        border: 1.5px solid #e5e5e5;
        border-radius: 10px;
        cursor: pointer;
        text-align: left;
        width: 100%;
        transition:
          border-color 0.15s,
          background 0.15s;
      }

      .import-option-tile:hover {
        border-color: #5569dd;
        background: #f0f2fc;
      }

      .import-option-tile__icon {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 2.5rem;
        height: 2.5rem;
        border-radius: 8px;
        background: #e8ebfa;
        color: #5569dd;
        font-size: 1.2rem;
        flex-shrink: 0;
      }

      .import-option-tile__body {
        display: flex;
        flex-direction: column;
        flex: 1;
      }

      .import-option-tile__title {
        font-weight: 600;
        color: #333;
        font-size: 0.95rem;
      }

      .import-option-tile__desc {
        font-size: 0.82rem;
        color: #777;
        margin-top: 0.2rem;
      }

      .import-option-tile__arrow {
        color: #aaa;
        font-size: 1rem;
        flex-shrink: 0;
      }

      /* ---- Back link ---- */
      .import-back-link {
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        background: none;
        border: none;
        cursor: pointer;
        color: #5569dd;
        font-size: 0.85rem;
        padding: 0 0 1rem 0;
        font-family: Poppins, sans-serif;
      }

      .import-back-link:hover {
        color: #4454b8;
      }

      /* ---- Upload step ---- */
      .import-section {
        margin-bottom: 1.5rem;
      }

      .import-section__title {
        font-size: 0.95rem;
        font-weight: 600;
        color: #333;
        margin: 0 0 0.5rem 0;
        display: flex;
        align-items: center;
        gap: 0.4rem;
      }

      .import-section__desc {
        color: #777;
        font-size: 0.85rem;
        margin-bottom: 0.85rem;
      }

      .import-section-divider {
        border-top: 1px solid #eee;
        margin-bottom: 1.5rem;
      }

      .import-spinner-wrap {
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: 2rem 0;
        gap: 1rem;
      }

      .import-spinner-wrap__label {
        color: #777;
        font-size: 0.9rem;
      }

      /* ---- Preview step ---- */
      .import-summary-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
        margin-bottom: 1.25rem;
      }

      .import-errors-banner {
        background: #fef2f2;
        border: 1.5px solid #fca5a5;
        border-radius: 8px;
        padding: 1rem;
        margin-bottom: 1rem;
      }

      /* Skipped projects: amber, not red — non-blocking exclusion. */
      .import-errors-banner--skipped {
        background: #fffbeb;
        border-color: #fcd34d;
      }
      .import-errors-banner--skipped .import-errors-banner__header {
        color: #92400e;
      }
      .import-errors-banner--skipped .import-errors-list {
        color: #78350f;
      }

      .import-errors-banner__header {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        font-weight: 600;
        color: #b91c1c;
        margin-bottom: 0.5rem;
      }

      .import-errors-list {
        margin: 0;
        padding-left: 1.2rem;
        font-size: 0.85rem;
        color: #7f1d1d;
        line-height: 1.7;
      }

      .import-remove-warning {
        display: block;
        margin-bottom: 0.75rem;
      }

      .import-table-section {
        margin-bottom: 1.5rem;
      }

      .import-table-section__title {
        font-size: 0.9rem;
        font-weight: 600;
        color: #555;
        margin: 0 0 0.5rem 0;
      }

      .import-table__remove-row td {
        color: #b45309;
      }

      .import-alloc-changed {
        font-weight: 600;
        color: #5569dd;
      }

      .import-commit-error {
        display: block;
        margin-top: 1rem;
      }
    `,
  ],
})
export class CenterImportsDialogComponent {
  private readonly importsService = inject(CenterImportsService);
  private readonly messageService = inject(MessageService);

  /** Two-way bound visibility. Parent toggles this to open/close the dialog. */
  readonly visible = model<boolean>(false);

  /** Emitted after a successful commit so the parent can reload its data. */
  readonly importCompleted = output<void>();

  // -----------------------------------------------------------------------
  // Internal state signals
  // -----------------------------------------------------------------------

  readonly step = signal<ImportStep>('choose');
  readonly validateResponse = signal<ValidateImportResponse | null>(null);
  readonly validateLoading = signal(false);
  readonly commitLoading = signal(false);
  readonly commitError = signal<string | null>(null);

  /** Confirm is enabled when there are no errors AND the server returned a batchId. */
  readonly canCommit = () =>
    !this.commitLoading() &&
    (this.validateResponse()?.summary?.errors ?? 1) === 0 &&
    !!this.validateResponse()?.batchId;

  // -----------------------------------------------------------------------
  // Step navigation
  // -----------------------------------------------------------------------

  selectMappings(): void {
    this.step.set('upload');
  }

  goToChoose(): void {
    this.step.set('choose');
    this.validateResponse.set(null);
    this.commitError.set(null);
  }

  goToUpload(): void {
    this.step.set('upload');
    this.validateResponse.set(null);
    this.commitError.set(null);
  }

  /** Reset all state when dialog is hidden externally (X button / backdrop). */
  onDialogHide(): void {
    this.step.set('choose');
    this.validateResponse.set(null);
    this.commitError.set(null);
    this.validateLoading.set(false);
    this.commitLoading.set(false);
  }

  close(): void {
    this.visible.set(false);
  }

  // -----------------------------------------------------------------------
  // File select + validate
  // -----------------------------------------------------------------------

  onFileSelect(event: FileSelectEvent): void {
    const file = event.files?.[0];
    if (!file) return;

    this.validateLoading.set(true);
    this.commitError.set(null);

    this.importsService.validate(file).subscribe({
      next: (response) => {
        this.validateLoading.set(false);
        this.validateResponse.set(response);
        this.step.set('preview');
      },
      error: (err) => {
        this.validateLoading.set(false);
        const detail =
          err?.error?.message ?? 'Validation failed. Please check the file and try again.';
        this.messageService.add({
          severity: 'error',
          summary: 'Validation failed',
          detail,
        });
      },
    });
  }

  // -----------------------------------------------------------------------
  // Commit
  // -----------------------------------------------------------------------

  confirmImport(): void {
    const batchId = this.validateResponse()?.batchId;
    if (!batchId) return;

    this.commitLoading.set(true);
    this.commitError.set(null);

    this.importsService.commit(batchId).subscribe({
      next: (result) => {
        this.commitLoading.set(false);
        this.messageService.add({
          severity: 'success',
          summary: 'Import successful',
          detail: `Imported ${result.imported} mappings, removed ${result.removed}, across ${result.projectsAffected} projects.`,
          life: 6000,
        });
        this.visible.set(false);
        this.importCompleted.emit();
      },
      error: (err) => {
        this.commitLoading.set(false);
        const msg = err?.error?.message ?? 'Import failed. Please try again.';
        this.commitError.set(msg);
      },
    });
  }

  // -----------------------------------------------------------------------
  // Template helpers
  // -----------------------------------------------------------------------

  /** Truncates a string to maxLen chars, appending "…" if truncated. */
  truncate(value: string | null | undefined, maxLen: number): string {
    if (!value) return '';
    return value.length > maxLen ? value.substring(0, maxLen) + '…' : value;
  }
}
