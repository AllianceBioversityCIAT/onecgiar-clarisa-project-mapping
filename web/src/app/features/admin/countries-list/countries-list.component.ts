import { Component, OnInit, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

// PrimeNG imports
import { TableModule } from 'primeng/table';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { SkeletonModule } from 'primeng/skeleton';

import { ReferenceDataService } from '../../../core/services/reference-data.service';
import { Country } from '../../../core/models/reference-data.model';

/**
 * CountriesListComponent — read-only table of CLARISA-synced countries.
 *
 * Displays all 248 countries with client-side search across name, ISO codes,
 * and region. Sortable columns, paginator at 20 rows per page.
 * No create/edit/delete — CLARISA is the source of truth.
 */
@Component({
  selector: 'app-countries-list',
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
  templateUrl: './countries-list.component.html',
  styleUrl: './countries-list.component.scss',
})
export class CountriesListComponent implements OnInit {
  private readonly refData = inject(ReferenceDataService);

  /** True while the initial data fetch is in progress. */
  readonly loading = signal(true);

  /** Client-side search text. */
  readonly searchText = signal('');

  /** Placeholder rows shown during initial load. */
  readonly skeletonRows = Array(8).fill(null);

  /** All countries from the reference data service. */
  readonly countries = this.refData.countries;

  /**
   * Filtered country list applying the text search across
   * name, ISO Alpha-2, ISO Alpha-3, and region fields.
   */
  readonly filteredCountries = computed<Country[]>(() => {
    const q = this.searchText().toLowerCase().trim();
    if (!q) return this.countries();
    return this.countries().filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.isoAlpha2.toLowerCase().includes(q) ||
        c.isoAlpha3.toLowerCase().includes(q) ||
        (c.region ?? '').toLowerCase().includes(q),
    );
  });

  async ngOnInit(): Promise<void> {
    await this.refData.loadCountries();
    this.loading.set(false);
  }
}
