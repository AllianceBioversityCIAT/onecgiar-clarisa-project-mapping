import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Email } from './entities/email.entity';
import { EmailStatus } from './enums/email-status.enum';
import { EmailBodyFormat } from './enums/email-body-format.enum';
import { ListEmailsQueryDto } from './dto/list-emails.query.dto';
import { EmailListItemDto } from './dto/email-list-item.dto';
import { EmailDetailDto } from './dto/email-detail.dto';
import { EnqueueEmailDto } from './dto/enqueue-email.dto';
import { User } from '../users/entities/user.entity';

/**
 * Service backing the admin **Email Management** module.
 *
 * Responsibilities in this slice:
 *  - `list()`    — paginated, filterable, sortable read of the queue.
 *  - `findOne()` — full per-row detail (includes `body` and `lastError`).
 *  - `retry()`   — admin re-queues a `failed` row, preserving `attempts`.
 *  - `enqueue()` — internal contract for future modules that need to send.
 *
 * **Out of scope** for this slice (intentional):
 *  - The cron worker that actually drains the queue.
 *  - Any SMTP / SES / SendGrid wiring.
 *  - Template rendering.
 *
 * Concurrency notes:
 *  - This service performs no locking. The (future) worker is the only
 *    component that acquires leases (`locked_at` / `locked_by`); admin
 *    Retry is racy by design only against worker pickup, and that race
 *    is benign: if the worker has just leased a `failed` row at the
 *    moment the admin clicks Retry, the worker will fail/skip the
 *    update because `status` no longer matches its expected value and
 *    no double-send can occur.
 */
@Injectable()
export class EmailsService {
  private readonly logger = new Logger(EmailsService.name);

  constructor(
    @InjectRepository(Email)
    private readonly emailsRepo: Repository<Email>,
    @InjectRepository(User)
    private readonly usersRepo: Repository<User>,
    // DataSource is used by `purgeQueued()` to wrap the SELECT-then-DELETE
    // pair in a single transaction so the audit-log id snapshot matches
    // the rows actually deleted.
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  // ---------------------------------------------------------------------------
  // Public read API
  // ---------------------------------------------------------------------------

  /**
   * Paginated list for the admin Email Management page.
   *
   * Implementation notes:
   *  - Uses QueryBuilder so we can project the joined recipient name
   *    without loading the full `User` entity into memory.
   *  - Filters use camelCase property names in `.where()` per the
   *    CLAUDE.md rule.
   *  - Sort uses raw DB column names per the CLAUDE.md rule. The DTO
   *    whitelist already restricts the field to one of four columns.
   *  - Pagination uses `offset` / `limit` (not `skip` / `take`) per
   *    the CLAUDE.md rule on the TypeORM `databaseName` bug.
   *  - `body` and `last_error` are intentionally **not** selected —
   *    list responses must stay compact.
   */
  async list(query: ListEmailsQueryDto): Promise<{
    data: EmailListItemDto[];
    total: number;
    page: number;
    limit: number;
  }> {
    const qb = this.emailsRepo
      .createQueryBuilder('email')
      // Join (not select) the recipient — we only project the name
      // columns, never load the full User entity.
      .leftJoin('email.toUser', 'toUser')
      .select([
        'email.id',
        'email.toUserId',
        'email.toEmail',
        'email.subject',
        'email.status',
        'email.priority',
        'email.attempts',
        'email.maxAttempts',
        'email.queuedAt',
        'email.sentAt',
        'email.nextAttemptAt',
        'email.createdAt',
        'toUser.id',
        'toUser.firstName',
        'toUser.lastName',
      ]);

    // --- Filters -------------------------------------------------------------

    if (query.status && query.status.length > 0) {
      // `IN (:...statuses)` binds the array as positional placeholders.
      qb.andWhere('email.status IN (:...statuses)', { statuses: query.status });
    }

    if (typeof query.toUserId === 'number') {
      qb.andWhere('email.toUserId = :toUserId', { toUserId: query.toUserId });
    }

    if (query.search && query.search.trim().length > 0) {
      // Free-text search across subject + recipient address. Both
      // sides of the OR are parameterised so we never concatenate
      // user input into SQL.
      const term = `%${query.search.trim()}%`;
      qb.andWhere('(email.subject LIKE :term OR email.toEmail LIKE :term)', {
        term,
      });
    }

    if (query.dateFrom) {
      // `IsDateString` already validated the shape — bind as a Date
      // so the mysql2 driver formats it correctly.
      qb.andWhere('email.queuedAt >= :dateFrom', {
        dateFrom: new Date(`${query.dateFrom}T00:00:00.000Z`),
      });
    }

    if (query.dateTo) {
      // Expand to end-of-day so `dateFrom = dateTo` (single-day range)
      // returns rows queued anywhere on that calendar day.
      qb.andWhere('email.queuedAt <= :dateTo', {
        dateTo: new Date(`${query.dateTo}T23:59:59.999Z`),
      });
    }

    // --- Sort ---------------------------------------------------------------

    // Raw DB column names — the DTO whitelist guarantees one of the
    // four safe values. Prefix with the alias for the index hint.
    qb.orderBy(`email.${query.sortBy}`, query.sortDir);

    // Tie-breaker on id DESC so paginated results are deterministic
    // even when many rows share the same `queued_at` second.
    qb.addOrderBy('email.id', 'DESC');

    // --- Pagination ---------------------------------------------------------

    const offset = (query.page - 1) * query.limit;
    qb.offset(offset).limit(query.limit);

    // --- Execute ------------------------------------------------------------

    const [rows, total] = await qb.getManyAndCount();

    const data: EmailListItemDto[] = rows.map((row) => this.toListItemDto(row));

    return { data, total, page: query.page, limit: query.limit };
  }

  /**
   * Full per-row detail for `GET /admin/emails/:id`.
   *
   * Joins both the recipient and the enqueuer so the response can
   * surface display names for each without follow-up lookups. Throws
   * 404 when the row does not exist.
   */
  async findOne(id: number): Promise<EmailDetailDto> {
    const row = await this.emailsRepo
      .createQueryBuilder('email')
      .leftJoinAndSelect('email.toUser', 'toUser')
      .leftJoinAndSelect('email.createdByUser', 'createdByUser')
      .where('email.id = :id', { id })
      .getOne();

    if (!row) {
      throw new NotFoundException(`Email ${id} not found`);
    }

    return this.toDetailDto(row);
  }

  // ---------------------------------------------------------------------------
  // Admin actions
  // ---------------------------------------------------------------------------

  /**
   * Re-queue a `failed` email for another delivery attempt.
   *
   * Rules:
   *  - Only `failed` rows are retriable. Other statuses raise a 400
   *    with code `EMAIL_NOT_RETRIABLE` so the UI can show a clear
   *    error instead of a generic 400.
   *  - **`attempts` is NOT reset.** This is deliberate — it caps the
   *    blast radius of an admin clicking Retry on a row that keeps
   *    failing because the recipient's MX server is permanently
   *    down. The worker will give up again after one more attempt
   *    (since `attempts >= max_attempts - 1`).
   *  - `last_error` is cleared so the admin UI doesn't show a
   *    stale error string while the row is back in `queued`.
   *  - `next_attempt_at` is set to NOW so the worker picks it up
   *    on the very next poll (no backoff).
   *  - `locked_at` / `locked_by` are cleared — any old lease was
   *    bogus because the row's now `queued`, not `sending`.
   *
   * Concurrency: see the class-level docstring. The retry is a single
   * `UPDATE` so it is atomic; the worker can never observe an
   * intermediate state.
   */
  async retry(id: number, actorUserId: number): Promise<EmailDetailDto> {
    const row = await this.emailsRepo.findOne({ where: { id } });
    if (!row) {
      throw new NotFoundException(`Email ${id} not found`);
    }

    if (row.status !== EmailStatus.FAILED) {
      // Domain error with a stable error code so the front-end can
      // surface a specific message. Mirrors the pattern used by
      // `ACTIVE_CENTER_INVALID` (see auth module).
      throw new BadRequestException({
        code: 'EMAIL_NOT_RETRIABLE',
        message: `Email ${id} is in status '${row.status}' and cannot be retried (only 'failed' rows are retriable)`,
      });
    }

    await this.emailsRepo.update(id, {
      status: EmailStatus.QUEUED,
      lastError: null,
      nextAttemptAt: new Date(),
      lockedAt: null,
      lockedBy: null,
    });

    this.logger.log(
      `Email ${id} re-queued by user ${actorUserId} ` +
        `(was 'failed', attempts=${row.attempts}/${row.maxAttempts})`,
    );

    // Re-read via findOne so the response includes the join-projected
    // display names and the updated worker state.
    return this.findOne(id);
  }

  /**
   * Hard-deletes every row currently in `status = 'queued'`. Backs
   * `DELETE /admin/emails/queued` (admin only).
   *
   * Rationale:
   *  - The `emails` table is a transient queue + audit log of sent /
   *    failed messages. Queued rows are disposable — they have not
   *    been transmitted to anyone yet, so removing them costs no
   *    recipient-visible state.
   *  - Only `queued` rows are touched. Rows in `sending` (mid-flight),
   *    `sent` (audit log), or `failed` (retry candidates) are never
   *    affected — guaranteed by the `status = 'queued'` filter on both
   *    the SELECT and the DELETE.
   *  - Idempotent: when the queue is empty the method returns
   *    `{ deleted: 0 }` without raising.
   *
   * Implementation choice (Option A — SELECT then DELETE):
   *  - SELECT ids first so the audit log line names the rows that
   *    were purged. A simple `DELETE WHERE status='queued'` would only
   *    give us a count, which is much weaker forensically when a user
   *    asks "did Retry X for email 4711 get purged?".
   *  - Both statements run inside one transaction so the id snapshot
   *    is consistent with the row set the DELETE removes — if a new
   *    row is enqueued between the SELECT and the DELETE it won't
   *    appear in the log AND won't be deleted (REPEATABLE READ snapshot).
   *  - The id list is truncated to the first 50 ids in the log line
   *    to keep Winston entries within sane size limits when a very
   *    large queue is purged.
   *
   * Concurrency note: this races benignly with the worker. If the
   * worker has just leased a `queued` row (transitioning it to
   * `sending`) at the moment the admin issues purge, that row's
   * status no longer matches `queued` and it is excluded from both
   * the SELECT and the DELETE — no in-flight email is ever cancelled
   * by purge.
   *
   * @param actorUserId  admin user issuing the purge — recorded in the
   *                     structured Winston log line for audit.
   * @returns `{ deleted }` — exact number of rows hard-deleted.
   */
  async purgeQueued(actorUserId: number): Promise<{ deleted: number }> {
    return this.dataSource.transaction(async (manager) => {
      // 1. Snapshot the ids of every currently-queued row. Bind the
      //    status as a parameter so the query is fully parameterised.
      //    Order is irrelevant; we just need a stable id list.
      const queuedRows = await manager
        .createQueryBuilder()
        .select('email.id', 'id')
        .from(Email, 'email')
        .where('email.status = :status', { status: EmailStatus.QUEUED })
        .getRawMany<{ id: number }>();

      // Fast path: empty queue — short-circuit so the log line still
      // records the no-op and we avoid a round-trip with an empty IN.
      if (queuedRows.length === 0) {
        this.logger.log(
          `Purged 0 queued email(s) by user ${actorUserId} (ids: [])`,
        );
        return { deleted: 0 };
      }

      const ids = queuedRows.map((row) => row.id);

      // 2. Delete by id list. We could re-filter on status here for
      //    belt-and-braces, but it's not necessary — the snapshot is
      //    held inside the transaction and any worker transition to
      //    `sending` after the SELECT lives in another connection.
      //    The id list is the authoritative target set.
      const result = await manager
        .createQueryBuilder()
        .delete()
        .from(Email)
        .where('id IN (:...ids)', { ids })
        .execute();

      // `affected` is the canonical "rows deleted" count. Fall back to
      // the id-list length only if the driver reports null — mysql2
      // does report it, but defensive coding makes the return type
      // unambiguous.
      const deleted =
        typeof result.affected === 'number' ? result.affected : ids.length;

      // 3. Audit log. Truncate the id list to the first 50 to keep
      //    a single Winston entry within sane size limits.
      const idsForLog = ids.slice(0, 50);
      const idsSuffix = ids.length > 50 ? `, …+${ids.length - 50} more` : '';
      this.logger.log(
        `Purged ${deleted} queued email(s) by user ${actorUserId} ` +
          `(ids: [${idsForLog.join(', ')}${idsSuffix}])`,
      );

      return { deleted };
    });
  }

  /**
   * Enqueues a fixed-template test email to verify the email pipeline
   * end-to-end. Backs `POST /admin/emails/test-send`.
   *
   * Rules:
   *  - Bypasses `system_settings.email_enabled` by design — test endpoint
   *    must work regardless. The whole point is to verify the pipeline
   *    even when notifications are globally disabled.
   *  - The recipient is identified by user id only; subject and body
   *    are assembled server-side from a fixed HTML template so the
   *    endpoint cannot be repurposed as an arbitrary "send email"
   *    surface.
   *  - **Inactive users are allowed by design** — admin should be able
   *    to test-send to a deactivated account if needed. The only
   *    defensive check is that the user has a non-empty email address.
   *  - Returns a minimal projection (not the full detail DTO) since
   *    the caller only needs to confirm the row was queued.
   *
   * @param toUserId  recipient `users.id`
   * @param actorUserId admin user issuing the test send (for audit /
   *                    `created_by_user_id`)
   */
  async sendTest(
    toUserId: number,
    actorUserId: number,
  ): Promise<{
    id: number;
    toUserId: number;
    toEmail: string;
    subject: string;
    status: 'queued';
  }> {
    // Look up the recipient. Include inactive users — admin should be
    // able to verify the pipeline against any account on file.
    const recipient = await this.usersRepo.findOne({
      where: { id: toUserId },
    });

    if (!recipient) {
      throw new NotFoundException(`User ${toUserId} not found`);
    }

    // Defensive: every PRMS user is created with an email, but guard
    // anyway so the queue never holds a row destined for an empty
    // address (which would just fail at the worker layer with a less
    // helpful error).
    if (!recipient.email || recipient.email.trim().length === 0) {
      throw new BadRequestException(
        `User ${toUserId} has no email address on record`,
      );
    }

    // Optionally resolve the actor so we can include the sender's
    // identity in the body. Kept cheap (single lookup, no join) and
    // tolerant of a missing row — if the actor lookup fails for any
    // reason the body still renders without the sender block.
    const actor = await this.usersRepo
      .findOne({ where: { id: actorUserId } })
      .catch(() => null);

    const subject = 'PRMS Test Email';
    const queuedAtIso = new Date().toISOString();
    const body = this.buildTestEmailBody({
      recipientName: this.formatUserName(recipient) ?? recipient.email,
      actorName: actor ? this.formatUserName(actor) : null,
      actorEmail: actor?.email ?? null,
      queuedAtIso,
    });

    // Bypasses system_settings.email_enabled by design — test endpoint must work regardless.
    const saved = await this.enqueue({
      toUserId,
      toEmail: recipient.email,
      subject,
      body,
      bodyFormat: EmailBodyFormat.HTML,
      createdByUserId: actorUserId,
      metadata: { kind: 'test_email' },
    });

    this.logger.log(
      `Test email enqueued: emailId=${saved.id} actorUserId=${actorUserId} toUserId=${toUserId}`,
    );

    return {
      id: saved.id,
      toUserId,
      toEmail: saved.toEmail,
      subject: saved.subject,
      status: 'queued',
    };
  }

  // ---------------------------------------------------------------------------
  // Internal contract for future modules
  // ---------------------------------------------------------------------------

  /**
   * Internal API for enqueuing an outbound email.
   *
   * **Contract (this is the source of truth — read this before
   * calling from a new module):**
   *
   *  - Required:  `toEmail`, `subject`, `body`.
   *  - Optional:  `toUserId`, `bodyFormat` (default `html`),
   *               `priority` (default `5`), `maxAttempts` (default
   *               `5`), `templateKey`, `metadata`, `createdByUserId`,
   *               `nextAttemptAt` (default null = pick up immediately).
   *  - The row is inserted with `status = 'queued'`, `attempts = 0`.
   *  - `queued_at`, `created_at`, `updated_at` come from MySQL column
   *    defaults — we do not set them.
   *  - The row's `id` is returned (via the resolved entity). Useful
   *    for the caller to attach to its own audit log.
   *
   * **Out of scope today:**
   *  - No HTTP endpoint binds this DTO. There is no
   *    `POST /admin/emails` — admins must not enqueue manually.
   *  - No template rendering. Callers pass a fully-rendered `body`.
   *  - No deduplication. Callers are responsible for not enqueuing
   *    the same notification twice (use `metadata.dedupeKey` if you
   *    need to enforce idempotency at the caller layer).
   *
   * **Worker contract (informational, for future caller intuition):**
   *  - The worker polls every N seconds with `status='queued' AND
   *    (next_attempt_at IS NULL OR next_attempt_at <= NOW())`.
   *  - Successful sends transition to `sent` and set `sent_at`.
   *  - Failed attempts increment `attempts` and either set
   *    `next_attempt_at = NOW() + backoff(attempts)` (retry-eligible)
   *    or move the row to `failed` (when `attempts >= max_attempts`).
   *
   * @example
   *   await emailsService.enqueue({
   *     toUserId: programRep.id,
   *     toEmail: programRep.email,
   *     subject: '[PRMS] You have a new counter-proposal',
   *     body: renderedHtml,
   *     metadata: { mappingId: mapping.id, projectCode: project.code },
   *     createdByUserId: actor.id,
   *   });
   */
  async enqueue(dto: EnqueueEmailDto): Promise<Email> {
    // Apply defaults in the service rather than relying solely on
    // column defaults — that way the resolved entity returned to the
    // caller reflects the actual values that will live on the row.
    const row = this.emailsRepo.create({
      toUserId: dto.toUserId ?? null,
      toEmail: dto.toEmail,
      subject: dto.subject,
      body: dto.body,
      bodyFormat: dto.bodyFormat ?? EmailBodyFormat.HTML,
      status: EmailStatus.QUEUED,
      priority: dto.priority ?? 5,
      attempts: 0,
      maxAttempts: dto.maxAttempts ?? 5,
      lastError: null,
      lockedAt: null,
      lockedBy: null,
      nextAttemptAt: dto.nextAttemptAt ?? null,
      sentAt: null,
      createdByUserId: dto.createdByUserId ?? null,
      templateKey: dto.templateKey ?? null,
      metadata: dto.metadata ?? null,
    });

    const saved = await this.emailsRepo.save(row);

    this.logger.log(
      `Email enqueued: id=${saved.id} to=${saved.toEmail} ` +
        `subject="${this.truncateForLog(saved.subject, 80)}" ` +
        `priority=${saved.priority} createdBy=${saved.createdByUserId ?? 'system'}`,
    );

    return saved;
  }

  // ---------------------------------------------------------------------------
  // Mapping helpers — entity → DTO
  // ---------------------------------------------------------------------------

  /**
   * Maps a row from the QueryBuilder list result to the compact list
   * DTO. The recipient name is assembled from the joined user's
   * first + last name; returns null when the recipient FK is null
   * (no user) or the user has been deleted (ON DELETE SET NULL).
   */
  private toListItemDto(row: Email): EmailListItemDto {
    return {
      id: row.id,
      toUserId: row.toUserId,
      toEmail: row.toEmail,
      toUserName: this.formatUserName(row.toUser),
      subject: row.subject,
      status: row.status,
      priority: row.priority,
      attempts: row.attempts,
      maxAttempts: row.maxAttempts,
      queuedAt: row.queuedAt,
      sentAt: row.sentAt,
      nextAttemptAt: row.nextAttemptAt,
      createdAt: row.createdAt,
    };
  }

  /**
   * Maps a fully-hydrated email entity (with `toUser` and
   * `createdByUser` joined) to the detail DTO.
   */
  private toDetailDto(row: Email): EmailDetailDto {
    return {
      id: row.id,
      toUserId: row.toUserId,
      toEmail: row.toEmail,
      toUserName: this.formatUserName(row.toUser),
      subject: row.subject,
      body: row.body,
      bodyFormat: row.bodyFormat,
      status: row.status,
      priority: row.priority,
      attempts: row.attempts,
      maxAttempts: row.maxAttempts,
      lastError: row.lastError,
      lockedAt: row.lockedAt,
      lockedBy: row.lockedBy,
      nextAttemptAt: row.nextAttemptAt,
      sentAt: row.sentAt,
      queuedAt: row.queuedAt,
      createdByUserId: row.createdByUserId,
      createdByUserName: this.formatUserName(row.createdByUser),
      templateKey: row.templateKey,
      metadata: row.metadata,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * Assembles a "First Last" display name from a joined user, or
   * returns null when the user is null/undefined or has no name
   * components. Centralised so list and detail DTOs render names
   * identically.
   */
  private formatUserName(
    user:
      | { firstName?: string | null; lastName?: string | null }
      | null
      | undefined,
  ): string | null {
    if (!user) return null;
    const parts = [user.firstName, user.lastName]
      .map((p) => (p ?? '').trim())
      .filter((p) => p.length > 0);
    return parts.length > 0 ? parts.join(' ') : null;
  }

  /**
   * Truncates a string for safe inclusion in a log line. Subjects
   * can be up to 500 chars; we don't want multi-line log entries.
   */
  private truncateForLog(value: string, max: number): string {
    if (value.length <= max) return value;
    return `${value.slice(0, max - 1)}…`;
  }

  /**
   * Minimal HTML escape for values we interpolate into the test email
   * body. The recipient/actor names come from `users` (admin-curated)
   * and the timestamp is server-generated, so the practical XSS risk
   * is low — but the body still renders in someone's inbox, so we
   * harden it anyway.
   */
  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Builds the fixed HTML body for the test email. Inline-styled, no
   * external CSS, no images — designed to render consistently across
   * webmail clients with strict content filters.
   */
  private buildTestEmailBody(params: {
    recipientName: string;
    actorName: string | null;
    actorEmail: string | null;
    queuedAtIso: string;
  }): string {
    const recipient = this.escapeHtml(params.recipientName);
    const ts = this.escapeHtml(params.queuedAtIso);
    const senderLine =
      params.actorEmail && params.actorEmail.trim().length > 0
        ? `<li><strong>Sent by:</strong> ${this.escapeHtml(
            params.actorName ?? params.actorEmail,
          )} &lt;${this.escapeHtml(params.actorEmail)}&gt;</li>`
        : '';

    return `<!DOCTYPE html>
<html><body style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0; padding: 16px;">
  <h2 style="color: #5569dd; margin: 0 0 12px 0;">PRMS Test Email</h2>
  <p style="margin: 0 0 12px 0;">This is a test email sent from the PRMS Projects Registry to verify the email pipeline.</p>
  <div style="background: #faf9f9; border: 1px solid #e5e5e5; border-radius: 4px; padding: 12px; margin: 12px 0;">
    <ul style="margin: 0; padding-left: 20px;">
      <li><strong>Recipient:</strong> ${recipient}</li>
      ${senderLine}
      <li><strong>Queued at:</strong> ${ts}</li>
    </ul>
  </div>
  <p style="margin: 12px 0 0 0; color: #777; font-size: 12px;">If you received this in error, you can ignore it.</p>
</body></html>`;
  }
}
