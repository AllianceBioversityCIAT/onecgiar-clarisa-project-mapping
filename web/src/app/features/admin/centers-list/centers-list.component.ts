import { Component, OnInit, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { TableModule } from 'primeng/table';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { SkeletonModule } from 'primeng/skeleton';

import { ReferenceDataService } from '../../../core/services/reference-data.service';
import { Center } from '../../../core/models/reference-data.model';

@Component({
  selector: 'app-centers-list',
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
  templateUrl: './centers-list.component.html',
  styleUrl: './centers-list.component.scss',
})
export class CentersListComponent implements OnInit {
  private readonly refData = inject(ReferenceDataService);

  readonly loading = signal(true);
  readonly searchText = signal('');
  readonly skeletonRows = Array(8).fill(null);
  readonly centers = this.refData.centers;

  readonly filteredCenters = computed<Center[]>(() => {
    const q = this.searchText().toLowerCase().trim();
    if (!q) return this.centers();
    return this.centers().filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.acronym.toLowerCase().includes(q) ||
        c.code.toLowerCase().includes(q) ||
        String(c.clarisaId).includes(q),
    );
  });

  async ngOnInit(): Promise<void> {
    await this.refData.loadCenters();
    this.loading.set(false);
  }
}
