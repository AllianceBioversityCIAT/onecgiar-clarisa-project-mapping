/**
 * EmailStatus — mirrors the backend EmailStatus enum.
 * queued   : waiting to be picked up by the worker
 * sending  : currently being sent (locked by a worker)
 * sent     : successfully delivered
 * failed   : all retry attempts exhausted
 */
export type EmailStatus = 'queued' | 'sending' | 'sent' | 'failed';

/**
 * EmailBodyFormat — controls how the body is rendered in the detail view.
 * html : body contains HTML mark-up; rendered via innerHTML + DomSanitizer
 * text : plain text; rendered in a <pre> block
 */
export type EmailBodyFormat = 'html' | 'text';

/**
 * EmailListItem — the shape of each row returned by GET /admin/emails.
 * Contains only the columns needed for the list table; the full body and
 * extended metadata live on EmailDetail.
 */
export interface EmailListItem {
  id: number;
  toUserId: number | null;
  toEmail: string;
  toUserName: string | null;
  subject: string;
  status: EmailStatus;
  priority: number;
  attempts: number;
  maxAttempts: number;
  queuedAt: string; // ISO timestamp
  sentAt: string | null; // ISO timestamp or null
  nextAttemptAt: string | null;
  createdAt: string;
}

/**
 * EmailDetail — full email object returned by GET /admin/emails/:id.
 * Extends the list fields with the body, error info, lock state, and metadata.
 */
export interface EmailDetail extends EmailListItem {
  body: string;
  bodyFormat: EmailBodyFormat;
  lastError: string | null;
  lockedAt: string | null;
  lockedBy: string | null;
  createdByUserId: number | null;
  createdByUserName: string | null;
  templateKey: string | null;
  metadata: Record<string, unknown> | null;
  updatedAt: string;
}

/**
 * EmailListQuery — typed query params accepted by GET /admin/emails.
 */
export interface EmailListQuery {
  page?: number;
  limit?: number;
  /** Comma-separated status values, e.g. "queued,failed" */
  status?: string;
  toUserId?: number;
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  sortBy?: 'queued_at' | 'sent_at' | 'status' | 'attempts';
  sortDir?: 'ASC' | 'DESC';
}

/**
 * EmailListResponse — the paginated envelope returned by GET /admin/emails.
 */
export interface EmailListResponse {
  data: EmailListItem[];
  total: number;
  page: number;
  limit: number;
}

/**
 * PurgeQueuedResult — shape returned by DELETE /admin/emails/queued.
 * Contains the count of hard-deleted rows that were in 'queued' status.
 */
export interface PurgeQueuedResult {
  deleted: number;
}

/**
 * TestSendResult — shape returned by POST /admin/emails/test-send.
 * The backend enqueues a fixed-template email and returns its initial state.
 * The worker is not yet wired up so status is always 'queued' on creation.
 */
export interface TestSendResult {
  id: number;
  toUserId: number;
  toEmail: string;
  subject: string;
  status: 'queued';
}

/**
 * ReminderRunResult — shape returned by POST /admin/emails/run-reminders.
 * Summarises what a manual (force) mapping-reminder run produced so the UI
 * can tell the admin exactly what happened — including why a run generated
 * nothing (e.g. the mapping deadline is not set).
 */
export interface ReminderRunResult {
  /** false when a global gate short-circuited the run (see shortCircuit) or it errored. */
  ran: boolean;
  /** Total reminder emails queued across all centers. */
  enqueued: number;
  /** Number of centers iterated (0 when a global gate fired first). */
  centersTotal: number;
  /** Centers that queued at least one reminder. */
  centersEnqueued: number;
  /** Centers skipped by a stop condition or already-reminded-today. */
  centersSkipped: number;
  /** Why the run produced nothing, when applicable; null on a normal run. */
  shortCircuit:
    | 'deadline_disabled'
    | 'deadline_passed'
    | 'weekly_cadence'
    | 'error'
    | null;
  /** Human-readable one-line summary, safe to show in a toast. */
  message: string;
}

/**
 * ProgramReminderRunResult — shape returned by
 * POST /admin/emails/run-program-reminders. Mirrors {@link ReminderRunResult}
 * but the per-iteration counts are scoped to programs rather than centers,
 * and the daily cadence means there is no `weekly_cadence` short-circuit.
 */
export interface ProgramReminderRunResult {
  /** false when a global gate short-circuited the run (see shortCircuit) or it errored. */
  ran: boolean;
  /** Total reminder emails queued across all programs. */
  enqueued: number;
  /** Number of programs iterated (0 when a global gate fired first). */
  programsTotal: number;
  /** Programs that queued at least one reminder. */
  programsEnqueued: number;
  /** Programs skipped by a stop condition or already-reminded-today. */
  programsSkipped: number;
  /** Why the run produced nothing, when applicable; null on a normal run. */
  shortCircuit: 'deadline_disabled' | 'deadline_passed' | 'error' | null;
  /** Human-readable one-line summary, safe to show in a toast. */
  message: string;
}
