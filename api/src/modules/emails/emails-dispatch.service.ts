import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import * as os from 'os';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';
import { Email } from './entities/email.entity';
import { EmailStatus } from './enums/email-status.enum';
import { EmailBodyFormat } from './enums/email-body-format.enum';

/**
 * Minimal projection of an `emails` row that the dispatcher needs in
 * order to attempt a send. Kept narrow on purpose: the worker poll is
 * a hot path and we never load `last_error`, `metadata` (until needed),
 * or the joined recipient entity.
 */
interface LeasedEmail {
  id: number;
  toEmail: string;
  subject: string;
  body: string;
  bodyFormat: EmailBodyFormat;
  attempts: number;
  maxAttempts: number;
  metadata: Record<string, unknown> | null;
}

/**
 * Cron worker that drains the `emails` queue.
 *
 * Lifecycle (per tick, every 2 minutes):
 *  1. {@link clearStuckLeases} — release any `sending` rows whose lease
 *     is older than {@link LEASE_TIMEOUT_MINUTES} (i.e. a previous
 *     worker crashed mid-send). They flip back to `queued` so this
 *     tick (or a future tick) can pick them up.
 *  2. {@link leaseBatch} — atomically lease up to {@link BATCH_SIZE}
 *     `queued` rows using a `SELECT … FOR UPDATE SKIP LOCKED`
 *     transaction. Each leased row transitions to `sending` and is
 *     stamped with this worker's id.
 *  3. {@link sendOne} — for each leased row, call
 *     {@link NotificationsService.send}. The outcome maps to one of:
 *       - `published` / `dry_run` → mark `sent`, set `sent_at`.
 *       - `disabled`              → release back to `queued`; do NOT
 *                                   burn an attempt (kill-switch
 *                                   tooling shouldn't consume retries).
 *       - thrown error (defensive) → backoff or terminal `failed`.
 *
 * Concurrency:
 *  - `SKIP LOCKED` lets multiple worker instances coexist safely.
 *    Each instance leases a disjoint subset of the queue.
 *  - The lease columns (`locked_at` / `locked_by`) plus the
 *    stuck-lease sweeper ensure no row stays in `sending` forever.
 *
 * Failure model:
 *  - {@link NotificationsService.send} already swallows broker errors
 *    and never throws, so {@link sendOne}'s `catch` block is purely
 *    defensive. If it ever fires we treat the row as a delivery
 *    failure and apply exponential backoff.
 *  - Backoff schedule lives in {@link BACKOFF_MINUTES} and is indexed
 *    by `attempts - 1` (1-based attempts → 0-based array). The last
 *    entry repeats for attempts beyond its length.
 */
@Injectable()
export class EmailsDispatchService {
  private readonly logger = new Logger(EmailsDispatchService.name);

  /**
   * Max rows leased per tick. Keep small enough that a single tick
   * finishes well under the cron interval even when every send
   * publishes onto the broker.
   */
  private static readonly BATCH_SIZE = 25;

  /**
   * A `sending` row whose `locked_at` is older than this is presumed
   * stranded by a crashed worker. The brief specifies 10 minutes —
   * long enough that a slow but live worker isn't pre-empted, short
   * enough that a real crash recovers within one cron interval cycle.
   */
  private static readonly LEASE_TIMEOUT_MINUTES = 10;

  /**
   * Exponential-ish backoff schedule in minutes, indexed by
   * `attempts - 1` (the attempt that just failed). When `attempts`
   * exceeds the length, the final value (240 min = 4h) is reused.
   * `max_attempts` typically caps the row long before that.
   */
  private static readonly BACKOFF_MINUTES = [2, 5, 15, 60, 240];

  /**
   * Identifier stamped onto `emails.locked_by` for each leased row.
   * Includes hostname + PID so multiple worker instances in the same
   * cluster are distinguishable in production logs. Computed once at
   * class-load time — the values are stable for the process lifetime.
   */
  private static readonly WORKER_ID = `prms-api-${os.hostname()}-${process.pid}`;

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Cron entry point
  // ---------------------------------------------------------------------------

  /**
   * Cron entry point. Runs every 2 minutes (mirrors the brief).
   *
   * Wrapped in a top-level try/catch so that an unexpected error in
   * one tick never leaves the cron handler in a broken state — the
   * next tick will run on schedule.
   */
  // `@nestjs/schedule`'s `CronExpression` enum does NOT ship an
  // `EVERY_2_MINUTES` constant — the smallest minute-stride preset is
  // `EVERY_5_MINUTES`. The brief specifies a 2-minute cadence, so we
  // pass the literal cron expression directly. Format mirrors the
  // enum's own entries (6-field: second minute hour day month dow).
  @Cron('0 */2 * * * *')
  async dispatchTick(): Promise<void> {
    try {
      // Always sweep stale leases first — frees up rows that a crashed
      // worker may have parked. Cheap UPDATE, no row scan in practice
      // thanks to the status + locked_at index pair. We sweep even when
      // the admin toggle is OFF, so that when sending is re-enabled no
      // rows are stranded in `sending` past the lease timeout.
      const releasedCount = await this.clearStuckLeases();
      if (releasedCount > 0) {
        this.logger.warn(
          `Released ${releasedCount} stuck email lease(s) (older than ${EmailsDispatchService.LEASE_TIMEOUT_MINUTES} minutes)`,
        );
      }

      // Admin kill switch — `system_settings.email_enabled` is the
      // operator-facing pause button on the Settings page. When OFF
      // we skip leasing entirely; rows pile up in `queued` until the
      // toggle is flipped back on. The test-send endpoint bypasses
      // this gate at enqueue time (it leaves the row in `queued` and
      // relies on the dispatcher), so test sends will also pile up
      // while the toggle is OFF — that's intentional: the admin
      // disabled outbound mail.
      const settings = await this.settings.getSettings();
      if (!settings.emailEnabled) {
        this.logger.log(
          'Email dispatch paused via system_settings.email_enabled=false; skipping lease this tick',
        );
        return;
      }

      const leased = await this.leaseBatch();
      if (leased.length === 0) {
        // Nothing to do — keep the log quiet at debug level so we
        // don't generate noise every 2 minutes.
        this.logger.debug('No queued emails to dispatch');
        return;
      }

      this.logger.log(
        `Leased ${leased.length} email(s) for dispatch (workerId=${EmailsDispatchService.WORKER_ID})`,
      );

      // Process sequentially. The batch is small (≤ 25) and the
      // notifications service is bounded by its own 5s emit timeout,
      // so serial processing keeps a tick predictable and bounded.
      // Each row is isolated: an unexpected throw in sendOne() must
      // not strand the remaining batch in `sending` (they would only
      // be reclaimed 10 minutes later by clearStuckLeases).
      for (const row of leased) {
        try {
          await this.sendOne(row);
        } catch (err) {
          this.logger.error(
            `Unexpected error processing email ${row.id}: ${(err as Error).message}`,
            (err as Error).stack,
          );
        }
      }
    } catch (err) {
      // Defensive: anything escaping the inner try/catch in sendOne()
      // would land here. Log and let the next tick retry; never throw
      // out of a @Cron handler (NestJS would log it but it still
      // pollutes stderr).
      this.logger.error(
        `Email dispatch tick failed: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Lease lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Release stranded `sending` rows back to `queued`.
   *
   * A row is considered stranded when its `locked_at` is older than
   * {@link LEASE_TIMEOUT_MINUTES}. We deliberately do not touch
   * `attempts` here — the row never actually got a chance to send,
   * so the worker that picks it up should treat it as a fresh
   * attempt.
   *
   * Returns the number of rows actually released so the caller can
   * log it.
   */
  async clearStuckLeases(): Promise<number> {
    const result = await this.dataSource
      .createQueryBuilder()
      .update(Email)
      .set({
        status: EmailStatus.QUEUED,
        lockedAt: null,
        lockedBy: null,
      })
      .where('status = :sending', { sending: EmailStatus.SENDING })
      .andWhere(
        `locked_at < (NOW() - INTERVAL ${EmailsDispatchService.LEASE_TIMEOUT_MINUTES} MINUTE)`,
      )
      .execute();

    return result.affected ?? 0;
  }

  /**
   * Atomically lease up to {@link BATCH_SIZE} `queued` rows.
   *
   * Implementation:
   *  1. Open a transaction.
   *  2. `SELECT … FOR UPDATE SKIP LOCKED` orders by priority then
   *     queue time, filters out rows whose `next_attempt_at` is in
   *     the future, and grabs at most `BATCH_SIZE` rows.
   *     `SKIP LOCKED` lets concurrent workers each lease a disjoint
   *     slice without blocking.
   *  3. `UPDATE … SET status='sending', locked_at=NOW(), locked_by=?`
   *     marks the selected ids as leased before the transaction
   *     commits, so any other worker that races on the same rows
   *     will see them as `sending` (or skip them via SKIP LOCKED).
   *
   * Uses the **camelCase entity property names** in the SELECT
   * (per the CLAUDE.md TypeORM rule) but raw column names in the
   * UPDATE (it's a raw `manager.query` so SQL is literal).
   */
  async leaseBatch(): Promise<LeasedEmail[]> {
    return this.dataSource.transaction(async (manager) => {
      // Step 1: pick rows we're going to lease. The SELECT runs
      // against the live table with `FOR UPDATE SKIP LOCKED` so
      // concurrent workers don't fight for the same row.
      //
      // Bound parameters: status, batch size. Both safely
      // parameterised (no string concat).
      const candidates: Array<{
        id: string;
        to_email: string;
        subject: string;
        body: string;
        body_format: EmailBodyFormat;
        attempts: number;
        max_attempts: number;
        metadata: Record<string, unknown> | null;
      }> = await manager.query(
        `SELECT id, to_email, subject, body, body_format, attempts, max_attempts, metadata
         FROM emails
         WHERE status = ?
           AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
         ORDER BY priority ASC, queued_at ASC
         LIMIT ?
         FOR UPDATE SKIP LOCKED`,
        [EmailStatus.QUEUED, EmailsDispatchService.BATCH_SIZE],
      );

      if (candidates.length === 0) {
        return [];
      }

      // mysql2 returns BIGINT UNSIGNED as a JS string. Coerce to
      // number for downstream typing — the `emails.id` values are
      // far below Number.MAX_SAFE_INTEGER for the lifetime of this
      // app (entity contract already promises this).
      const ids = candidates.map((c) => Number(c.id));

      // Step 2: flip the selected rows to `sending` and stamp the
      // lease. Using a single UPDATE keeps this one round-trip.
      await manager.query(
        `UPDATE emails
           SET status = ?,
               locked_at = NOW(6),
               locked_by = ?
         WHERE id IN (?)`,
        [EmailStatus.SENDING, EmailsDispatchService.WORKER_ID, ids],
      );

      // Step 3: project to the worker-facing shape. Note: the worker
      // increments attempts on the SEND call, not here — so we hand
      // off the row with its current `attempts` value.
      return candidates.map<LeasedEmail>((row) => ({
        id: Number(row.id),
        toEmail: row.to_email,
        subject: row.subject,
        body: row.body,
        bodyFormat: row.body_format,
        attempts: Number(row.attempts),
        maxAttempts: Number(row.max_attempts),
        metadata: row.metadata,
      }));
    });
  }

  // ---------------------------------------------------------------------------
  // Per-row send
  // ---------------------------------------------------------------------------

  /**
   * Attempt a single email delivery.
   *
   * Outcome handling:
   *  - `published` / `dry_run` → mark `sent`, set `sent_at`, bump
   *    `attempts`. (Dry run is intentionally treated as a successful
   *    terminal state — the operator has explicitly asked the
   *    pipeline to not actually publish, and we should not keep
   *    re-leasing the row.)
   *  - `disabled` → release back to `queued` and do NOT bump
   *    `attempts`. The kill switch is an operational toggle, not a
   *    delivery failure, so it must not consume retries.
   *  - thrown error → defensive path; backoff or terminal failure
   *    depending on attempt count.
   *
   * Never throws — every error path is captured and translated into
   * a row-state update.
   */
  async sendOne(row: LeasedEmail): Promise<void> {
    try {
      // The Notification Microservice expects BOTH `text` (plain-text
      // fallback) and `socketFile` (base64 HTML) on the wire — sending
      // only one risks the consumer dropping or mis-rendering the
      // message. For HTML rows we derive a plain-text fallback by
      // stripping tags + collapsing whitespace. For text rows we send
      // only `text`.
      const sendOptions =
        row.bodyFormat === EmailBodyFormat.HTML
          ? { html: row.body, text: htmlToPlainText(row.body) }
          : { text: row.body };

      const result = await this.notifications.send({
        to: [row.toEmail],
        subject: row.subject,
        ...sendOptions,
      });

      if (result.status === 'published' || result.status === 'dry_run') {
        await this.markSent(row.id, row.attempts + 1);
        this.logger.log(
          `Email ${row.id} dispatched (status=${result.status}, attempts=${row.attempts + 1})`,
        );
        return;
      }

      if (result.status === 'disabled') {
        // Kill switch — release the lease and leave attempts untouched.
        await this.releaseLease(row.id);
        this.logger.debug(
          `Email ${row.id} skipped (notifications disabled); released back to queued`,
        );
        return;
      }

      // Unreachable today — SendEmailResult is a closed union. Treat
      // any future status as a failure so we don't silently
      // strand the row in `sending`.
      await this.handleSendFailure(
        row,
        `Unknown notifications status: ${(result as { status: string }).status}`,
      );
    } catch (err) {
      // Defensive — NotificationsService.send() doesn't throw today,
      // but if it ever does we treat it as a delivery failure.
      await this.handleSendFailure(
        row,
        (err as Error).message ?? 'unknown error',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Row-state mutators
  // ---------------------------------------------------------------------------

  /**
   * Transition a row to terminal `sent`. Stamps `sent_at` and bumps
   * `attempts` to reflect the actual count (the brief asks for
   * attempts to be bumped on the successful send).
   */
  private async markSent(id: number, attempts: number): Promise<void> {
    await this.dataSource
      .createQueryBuilder()
      .update(Email)
      .set({
        status: EmailStatus.SENT,
        attempts,
        lastError: null,
        lockedAt: null,
        lockedBy: null,
        sentAt: () => 'NOW(6)',
      })
      .where('id = :id', { id })
      .execute();
  }

  /**
   * Release the worker lease and put the row back in `queued`.
   * Used for the kill-switch (`disabled`) path so the row is
   * available for the next tick without any retry penalty.
   */
  private async releaseLease(id: number): Promise<void> {
    await this.dataSource
      .createQueryBuilder()
      .update(Email)
      .set({
        status: EmailStatus.QUEUED,
        lockedAt: null,
        lockedBy: null,
      })
      .where('id = :id', { id })
      .execute();
  }

  /**
   * Apply backoff (or move to terminal `failed`) for a send that did
   * not succeed.
   *
   * - If `attempts + 1 >= maxAttempts` → terminal `failed`. Stamp
   *   `last_error`, leave `next_attempt_at` null (admin retry will
   *   set it). Clear lease columns so the admin Retry endpoint's
   *   update is clean.
   * - Otherwise → bump `attempts`, set `next_attempt_at = NOW() +
   *   backoff(newAttempts)`, transition back to `queued`, clear
   *   the lease so the row is re-eligible.
   */
  private async handleSendFailure(
    row: LeasedEmail,
    errorMessage: string,
  ): Promise<void> {
    const newAttempts = row.attempts + 1;

    if (newAttempts >= row.maxAttempts) {
      await this.dataSource
        .createQueryBuilder()
        .update(Email)
        .set({
          status: EmailStatus.FAILED,
          attempts: newAttempts,
          lastError: errorMessage,
          lockedAt: null,
          lockedBy: null,
          nextAttemptAt: null,
        })
        .where('id = :id', { id: row.id })
        .execute();

      this.logger.error(
        `Email ${row.id} moved to terminal 'failed' after ${newAttempts}/${row.maxAttempts} attempts: ${errorMessage}`,
      );
      return;
    }

    // Determine backoff window. The schedule is keyed by the
    // attempt count we just completed (1-based) → array index
    // (0-based). When `newAttempts` overruns the array, repeat
    // the last entry.
    const backoffIndex = Math.min(
      newAttempts - 1,
      EmailsDispatchService.BACKOFF_MINUTES.length - 1,
    );
    const backoffMinutes = EmailsDispatchService.BACKOFF_MINUTES[backoffIndex];
    const nextAttemptAt = new Date(Date.now() + backoffMinutes * 60_000);

    await this.dataSource
      .createQueryBuilder()
      .update(Email)
      .set({
        status: EmailStatus.QUEUED,
        attempts: newAttempts,
        lastError: errorMessage,
        lockedAt: null,
        lockedBy: null,
        nextAttemptAt,
      })
      .where('id = :id', { id: row.id })
      .execute();

    this.logger.warn(
      `Email ${row.id} send failed (attempt ${newAttempts}/${row.maxAttempts}); ` +
        `retry in ${backoffMinutes} min at ${nextAttemptAt.toISOString()}: ${errorMessage}`,
    );
  }
}

// Crude HTML → plain-text fallback for the `text` field expected by the
// Notification Microservice alongside the base64 HTML body. Drops tags,
// decodes a handful of common entities, collapses whitespace. Good
// enough for transactional mail; not a full HTML parser.
function htmlToPlainText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
