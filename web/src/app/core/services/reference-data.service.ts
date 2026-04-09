import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from './api.service';
import { Center, Program, Country } from '../models/reference-data.model';

/**
 * ReferenceDataService — loads and caches lookup data (centers, programs, countries).
 *
 * Data is stored in signals so any component that injects this service
 * can bind to the signals reactively without manual subscriptions.
 * Each load method is idempotent: if data is already loaded it will not
 * issue a redundant API call.
 */
@Injectable({ providedIn: 'root' })
export class ReferenceDataService {
  private readonly api = inject(ApiService);

  /** All CGIAR centers available for project assignment. */
  readonly centers = signal<Center[]>([]);

  /** All CGIAR programs available for mapping. */
  readonly programs = signal<Program[]>([]);

  /** All countries available for project location tagging. */
  readonly countries = signal<Country[]>([]);

  // -----------------------------------------------------------------------
  // Individual loaders
  // -----------------------------------------------------------------------

  /** Fetches centers from the API and updates the centers signal. */
  async loadCenters(): Promise<void> {
    if (this.centers().length > 0) return; // already cached
    try {
      const data = await firstValueFrom(this.api.get<Center[]>('/api/centers'));
      this.centers.set(data);
    } catch {
      // Leave signal empty — callers handle missing data gracefully.
    }
  }

  /** Fetches programs from the API and updates the programs signal. */
  async loadPrograms(): Promise<void> {
    if (this.programs().length > 0) return;
    try {
      const data = await firstValueFrom(this.api.get<Program[]>('/api/programs'));
      this.programs.set(data);
    } catch {
      // Leave signal empty.
    }
  }

  /** Fetches countries from the API and updates the countries signal. */
  async loadCountries(): Promise<void> {
    if (this.countries().length > 0) return;
    try {
      const data = await firstValueFrom(this.api.get<Country[]>('/api/countries'));
      this.countries.set(data);
    } catch {
      // Leave signal empty.
    }
  }

  /**
   * Convenience method: loads all three reference datasets in parallel.
   * Suitable for calling in app initialisation or on the projects feature entry.
   */
  async loadAll(): Promise<void> {
    await Promise.all([
      this.loadCenters(),
      this.loadPrograms(),
      this.loadCountries(),
    ]);
  }
}
