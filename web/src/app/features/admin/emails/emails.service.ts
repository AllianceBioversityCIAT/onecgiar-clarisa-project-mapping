import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { ApiService } from '../../../core/services/api.service';
import { EmailDetail, EmailListQuery, EmailListResponse, TestSendResult } from './models/email.model';

/**
 * EmailsService — HTTP client for the /admin/emails REST endpoints.
 *
 * GET  /admin/emails         — paginated list with optional filters
 * GET  /admin/emails/:id     — full email detail including body
 * POST /admin/emails/:id/retry — resets a failed email back to queued
 */
@Injectable({ providedIn: 'root' })
export class EmailsService {
  private readonly api = inject(ApiService);

  /**
   * Fetches a paginated, filtered list of emails.
   * Query params are serialised to a URL search string; undefined/null
   * values are omitted so the backend uses its own defaults.
   */
  list(query: EmailListQuery = {}): Observable<EmailListResponse> {
    const params = this.buildParams(query);
    const qs = params.toString();
    const path = qs ? `/admin/emails?${qs}` : '/admin/emails';
    return this.api.get<EmailListResponse>(path);
  }

  /**
   * Fetches the full detail for a single email, including the body,
   * error details, lock state, and raw metadata.
   */
  findOne(id: number): Observable<EmailDetail> {
    return this.api.get<EmailDetail>(`/admin/emails/${id}`);
  }

  /**
   * Resets a failed email back to 'queued' so the next worker run
   * will attempt delivery again. The attempts counter is NOT reset by
   * the backend — this only changes the status.
   *
   * Returns the updated EmailDetail on success.
   * Throws 400 with { code: 'EMAIL_NOT_RETRIABLE' } if the email is not
   * in a failed state.
   */
  retry(id: number): Observable<EmailDetail> {
    return this.api.post<EmailDetail>(`/admin/emails/${id}/retry`);
  }

  /**
   * Enqueues a fixed-template test email addressed to the specified user.
   * Bypasses the emailEnabled toggle — useful for verifying the pipeline
   * independently of the global email flag.
   *
   * POST /admin/emails/test-send — admin only.
   * Returns the queued email's initial record (status is always 'queued').
   */
  sendTest(toUserId: number): Observable<TestSendResult> {
    return this.api.post<TestSendResult>('/admin/emails/test-send', { toUserId });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Converts a typed query object into URLSearchParams, skipping
   * undefined, null, and empty-string values.
   */
  private buildParams(query: EmailListQuery): URLSearchParams {
    const params = new URLSearchParams();

    const set = (key: string, value: string | number | undefined | null): void => {
      if (value !== undefined && value !== null && value !== '') {
        params.set(key, String(value));
      }
    };

    set('page', query.page);
    set('limit', query.limit);
    set('status', query.status);
    set('toUserId', query.toUserId);
    set('search', query.search);
    set('dateFrom', query.dateFrom);
    set('dateTo', query.dateTo);
    set('sortBy', query.sortBy);
    set('sortDir', query.sortDir);

    return params;
  }
}
