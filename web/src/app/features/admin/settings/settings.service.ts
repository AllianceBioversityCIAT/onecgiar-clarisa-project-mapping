import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { ApiService } from '../../../core/services/api.service';
import { SystemSettings, UpdateSettingsPayload } from './settings.model';

/**
 * SettingsService — thin wrapper around the /settings API endpoints.
 *
 * GET  /settings  — returns current system-wide settings (any authenticated user).
 * PATCH /settings — persists updated settings (admin only; 403 for other roles).
 */
@Injectable({ providedIn: 'root' })
export class SettingsService {
  private readonly api = inject(ApiService);

  /**
   * Fetches the current system settings.
   * Observable emits once and completes.
   */
  getSettings(): Observable<SystemSettings> {
    return this.api.get<SystemSettings>('/settings');
  }

  /**
   * Persists updated settings and returns the saved state.
   * The backend validates that deadlineDate is in the future when
   * deadlineEnabled is true; a 400 error is thrown otherwise.
   */
  updateSettings(dto: UpdateSettingsPayload): Observable<SystemSettings> {
    return this.api.patch<SystemSettings>('/settings', dto);
  }
}
