import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { ApiService } from '../../../core/services/api.service';
import {
  EmailDetail,
  EmailListQuery,
  EmailListResponse,
  ProgramReminderRunResult,
  ProgramUpdateDigestRunResult,
  PurgeQueuedResult,
  ReminderRunResult,
  TestSendResult,
  UpdateDigestRunResult,
} from './models/email.model';

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
   * Hard-deletes all emails currently in 'queued' status.
   * Rows in 'sending', 'sent', or 'failed' are untouched.
   * Returns the count of deleted rows.
   *
   * DELETE /admin/emails/queued — admin only.
   */
  purgeQueued(): Observable<PurgeQueuedResult> {
    return this.api.delete<PurgeQueuedResult>('/admin/emails/queued');
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

  /**
   * Runs the mapping-reminder generation now, on demand, instead of waiting
   * for the daily 09:00 UTC cron. Runs in force mode — bypasses the weekly
   * (Monday-only) cadence — while still honouring the deadline gates, each
   * center's stop conditions, and the per-recipient/per-day idempotency
   * guard. Like the cron, it enqueues regardless of the global email toggle
   * (that toggle gates the dispatcher, not generation).
   *
   * POST /admin/emails/run-reminders — admin only.
   * Returns a summary describing what the run produced.
   */
  runReminders(): Observable<ReminderRunResult> {
    return this.api.post<ReminderRunResult>('/admin/emails/run-reminders');
  }

  /**
   * Runs the program mapping-reminder generation now, on demand, instead of
   * waiting for the daily 09:05 UTC cron. Honours the program-deadline gates,
   * each program's stop conditions (no mappings awaiting a response, no active
   * reps), and the per-recipient/per-day idempotency guard. The program
   * reminder runs on a daily cadence, so there is no force flag. Like the cron,
   * it enqueues regardless of the global email toggle.
   *
   * POST /admin/emails/run-program-reminders — admin only.
   */
  runProgramReminders(): Observable<ProgramReminderRunResult> {
    return this.api.post<ProgramReminderRunResult>('/admin/emails/run-program-reminders');
  }

  /**
   * Runs the update-digest generation now, on demand, instead of waiting
   * for the scheduled cron. Sends center reps a digest of projects in their
   * center that had negotiation activity or new chat within the configured
   * window. Honours the digest end-date gate and per-recipient/per-day
   * idempotency guard.
   *
   * POST /admin/emails/run-update-digest — admin only.
   * Returns a summary describing what the run produced.
   */
  runUpdateDigest(): Observable<UpdateDigestRunResult> {
    return this.api.post<UpdateDigestRunResult>('/admin/emails/run-update-digest');
  }

  /**
   * Runs the program update-digest generation now, on demand, instead of
   * waiting for the scheduled cron. Sends program reps a digest of projects
   * mapped to their program that had negotiation activity or new chat within
   * the configured window. Honours the digest end-date gate and
   * per-recipient/per-day idempotency guard.
   *
   * POST /admin/emails/run-program-update-digest — admin only.
   * Returns a summary describing what the run produced.
   */
  runProgramUpdateDigest(): Observable<ProgramUpdateDigestRunResult> {
    return this.api.post<ProgramUpdateDigestRunResult>('/admin/emails/run-program-update-digest');
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
    set('templateKey', query.templateKey);
    set('toUserId', query.toUserId);
    set('search', query.search);
    set('dateFrom', query.dateFrom);
    set('dateTo', query.dateTo);
    set('sortBy', query.sortBy);
    set('sortDir', query.sortDir);

    return params;
  }
}
