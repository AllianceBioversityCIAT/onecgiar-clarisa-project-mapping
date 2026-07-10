import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';

import { ReferenceDataService } from '../../../core/services/reference-data.service';
import { ProjectsExportService } from '../../projects/services/projects-export.service';

/** Option shape for the center Select — null id means "all centers". */
interface CenterOption {
  label: string;
  id: number | null;
}

/**
 * AdminExportsComponent — admin-only data export hub (/admin/exports).
 *
 * Currently hosts one export: the full mapping negotiation history
 * (one Excel row per negotiation event across every mapping, including
 * removed ones). The admin picks a center — or "All centers" — and the
 * file streams down from `GET /projects/export/mapping-history`.
 */
@Component({
  selector: 'app-admin-exports',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, SelectModule, ToastModule],
  providers: [MessageService],
  templateUrl: './admin-exports.component.html',
  styleUrl: './admin-exports.component.scss',
})
export class AdminExportsComponent implements OnInit {
  private readonly refData = inject(ReferenceDataService);
  private readonly exportService = inject(ProjectsExportService);
  private readonly messageService = inject(MessageService);

  /** Center picked in the dropdown; null = all centers (the default). */
  readonly selectedCenterId = signal<number | null>(null);

  /** True while the mapping-history download is streaming. */
  readonly exporting = signal(false);

  /** "All centers" sentinel + one option per center, sorted by acronym. */
  readonly centerOptions = computed<CenterOption[]>(() => [
    { label: 'All centers', id: null },
    ...this.refData
      .centers()
      .map((c) => ({ label: `${c.acronym} — ${c.name}`, id: c.id }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  ]);

  async ngOnInit(): Promise<void> {
    await this.refData.loadCenters();
  }

  /** Triggers the mapping-history download for the selected center scope. */
  exportMappingHistory(): void {
    if (this.exporting()) return;
    this.exporting.set(true);

    this.exportService.exportMappingHistory(this.selectedCenterId()).subscribe({
      next: ({ filename }) => {
        this.exporting.set(false);
        this.messageService.add({
          severity: 'success',
          summary: 'Export ready',
          detail: `Downloaded ${filename}`,
        });
      },
      error: (err: Error) => {
        this.exporting.set(false);
        this.messageService.add({
          severity: 'error',
          summary: 'Export failed',
          detail: err.message,
        });
      },
    });
  }
}
