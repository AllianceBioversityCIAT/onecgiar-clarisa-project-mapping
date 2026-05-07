import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { ApiService } from '../../../core/services/api.service';
import {
  AuditEvent,
  AuditLogQueryFilters,
  AuditLogQueryResponse,
} from './audit-event.model';

/**
 * AuditLogService — HTTP client for the unified /audit REST endpoints.
 *
 * Provided at root so it can be injected anywhere (feature pages, tabs,
 * dialogs) without needing to be declared in a lazy-loaded module first.
 * The full audit-log admin page (Phase B.7) will import this service once
 * that feature is scaffolded.
 */
@Injectable({ providedIn: 'root' })
export class AuditLogService {
  private readonly api = inject(ApiService);

  /**
   * Queries the unified audit log.
   *
   * Converts the typed filter object into query-string parameters that the
   * API can consume:
   * - `action` arrays are joined as a comma-separated string.
   * - Date values are passed through as ISO strings (no conversion needed if
   *   callers already supply ISO; Date objects would need `.toISOString()`).
   * - Undefined/null values are omitted from the query string.
   *
   * @param filters Optional filter and pagination options.
   * @returns Observable of the paginated response envelope.
   */
  query(filters: AuditLogQueryFilters = {}): Observable<AuditLogQueryResponse> {
    const params = this.buildParams(filters);
    const qs = params.toString();
    const path = qs ? `/audit?${qs}` : '/audit';
    return this.api.get<AuditLogQueryResponse>(path);
  }

  /**
   * Fetches a single audit event by its string ID (BIGINT returned as string).
   *
   * @param id The event's `id` field from a previous query result.
   */
  getOne(id: string): Observable<AuditEvent> {
    return this.api.get<AuditEvent>(`/audit/${id}`);
  }

  /**
   * Fetches the list of distinct `action` values present in the audit log.
   * Useful for populating filter dropdowns without hard-coding every possible
   * action string in the client.
   */
  getActions(): Observable<string[]> {
    return this.api.get<string[]>('/audit/actions');
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Builds a URLSearchParams object from the given filter bag.
   * Only defined, non-null values are added; `action` arrays become a
   * comma-separated string so the API can split on its side.
   */
  private buildParams(filters: AuditLogQueryFilters): URLSearchParams {
    const params = new URLSearchParams();

    const set = (key: string, value: string | number | boolean | undefined | null): void => {
      if (value !== undefined && value !== null && value !== '') {
        params.set(key, String(value));
      }
    };

    set('page', filters.page);
    set('limit', filters.limit);
    set('entityType', filters.entityType);
    set('entityId', filters.entityId);
    set('actorUserId', filters.actorUserId);
    set('actorRole', filters.actorRole);
    set('from', filters.from);
    set('to', filters.to);
    set('search', filters.search);
    set('sort', filters.sort);
    set('direction', filters.direction);

    // action can be a single string or an array — normalise to CSV
    if (filters.action !== undefined && filters.action !== null) {
      const actionValue = Array.isArray(filters.action)
        ? filters.action.join(',')
        : filters.action;
      if (actionValue) {
        params.set('action', actionValue);
      }
    }

    return params;
  }
}
