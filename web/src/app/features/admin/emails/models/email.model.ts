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
