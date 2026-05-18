/**
 * Lifecycle status of an outbound email row in the `emails` queue table.
 *
 * The four states are intentionally minimal — they cover everything the
 * (future) cron worker and the admin Email Management UI need.
 *
 * - `queued`  – Initial state on `enqueue()`. The worker poll picks rows
 *               up with `status='queued' AND (next_attempt_at IS NULL
 *               OR next_attempt_at <= NOW())`.
 * - `sending` – Worker has leased the row (sets `locked_at` / `locked_by`)
 *               and is currently attempting delivery. Stale leases are
 *               released via `locked_at < NOW() - INTERVAL 5 MINUTE`
 *               back to `queued`.
 * - `sent`    – Terminal success. `sent_at` is set; `last_error` is null.
 * - `failed`  – Terminal failure after `attempts >= max_attempts`. The
 *               admin Retry endpoint moves it back to `queued`, clears
 *               `last_error`, and resets `next_attempt_at` — but
 *               intentionally does **not** reset `attempts` (guards
 *               against admin-triggered infinite-retry loops).
 *
 * Enum values match the MySQL ENUM declared in the
 * `1781000000000-AddEmailsTable` migration, verbatim and case-sensitive.
 */
export enum EmailStatus {
  QUEUED = 'queued',
  SENDING = 'sending',
  SENT = 'sent',
  FAILED = 'failed',
}
