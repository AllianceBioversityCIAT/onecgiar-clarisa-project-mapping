import { Component, OnInit, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { TableModule } from 'primeng/table';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { SkeletonModule } from 'primeng/skeleton';

import { ReferenceDataService } from '../../../core/services/reference-data.service';
import { Program } from '../../../core/models/reference-data.model';

@Component({
  selector: 'app-programs-list',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    TableModule,
    InputTextModule,
    IconFieldModule,
    InputIconModule,
    SkeletonModule,
  ],
  templateUrl: './programs-list.component.html',
  styleUrl: './programs-list.component.scss',
})
export class ProgramsListComponent implements OnInit {
  private readonly refData = inject(ReferenceDataService);

  readonly loading = signal(true);
  readonly searchText = signal('');
  readonly skeletonRows = Array(8).fill(null);
  readonly programs = this.refData.programs;

  readonly filteredPrograms = computed<Program[]>(() => {
    const q = this.searchText().toLowerCase().trim();
    if (!q) return this.programs();
    return this.programs().filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.officialCode.toLowerCase().includes(q) ||
        String(p.clarisaId).includes(q),
    );
  });

  async ngOnInit(): Promise<void> {
    await this.refData.loadPrograms();
    this.loading.set(false);
  }
}
