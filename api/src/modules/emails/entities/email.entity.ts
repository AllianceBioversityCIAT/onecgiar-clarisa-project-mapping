import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { EmailStatus } from '../enums/email-status.enum';
import { EmailBodyFormat } from '../enums/email-body-format.enum';

/**
 * Queue row for an outbound transactional email.
 *
 * Backs the admin **Email Management** module (list + detail + retry)
 * and the (not-yet-built) cron worker that will drain the queue.
 *
 * Design context — see the migration
 * `1781000000000-AddEmailsTable.ts` for the full rationale on column
 * widths, indexes, and FK behaviour. Key invariants relied on by this
 * service:
 *
 *  - `id` is `BIGINT UNSIGNED` (high-volume append-only) but maps to
 *    `number` in TypeScript. Node `number` safely handles values up
 *    to 2^53; we will be far below that for the lifetime of this app.
 *  - `to_email` is denormalised at enqueue time and survives the
 *    recipient user being renamed or deleted (FK is ON DELETE SET NULL).
 *  - `body` is `MEDIUMTEXT` — list endpoints MUST NOT project this
 *    column to keep response payloads small.
 *  - `attempts` is **not** reset by admin Retry. Only the cron worker
 *    increments it on send-failure. See `EmailsService.retry()`.
 *  - `locked_at` / `locked_by` are worker-lease columns — admin Retry
 *    clears them so a previously-leased row is re-eligible for pickup.
 *  - `queued_at`, `created_at`, `updated_at` use DATETIME(6); MySQL
 *    populates them via column defaults, TypeORM hydrates as `Date`.
 *  - `metadata` is `JSON` and intentionally typed `Record<string,
 *    unknown> | null` so callers don't have to cast — see
 *    `EnqueueEmailDto` for the contract.
 *
 * No `eager: true` relations: list queries explicitly `leftJoinAndSelect`
 * the recipient to project a display name; the detail query joins
 * both `toUser` and `createdByUser`. This keeps the hot-path worker
 * poll cheap (it only needs scalar columns).
 */
@Entity('emails')
export class Email {
  /**
   * Auto-increment primary key. Declared explicitly (not via
   * `BaseEntity`) because the underlying column is `BIGINT UNSIGNED`,
   * not `INT`, and because `created_at` / `updated_at` use DATETIME(6)
   * precision rather than `BaseEntity`'s default precision.
   */
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: number;

  // --- Recipient -----------------------------------------------------------

  /**
   * Optional FK to the recipient `users.id`. Nullable because emails
   * may be sent to addresses that don't correspond to a registered
   * user yet (e.g. invitation flows). ON DELETE SET NULL preserves
   * the audit trail when a user is deleted.
   */
  @ManyToOne(() => User, { nullable: true, eager: false })
  @JoinColumn({ name: 'to_user_id' })
  toUser: User | null;

  /** FK column for {@link toUser}. */
  @Column({ name: 'to_user_id', type: 'int', nullable: true })
  toUserId: number | null;

  /**
   * Recipient email address, denormalised at enqueue time. Stored
   * separately from the FK so the address that was actually delivered
   * to survives the recipient user being renamed or deactivated.
   * VARCHAR(320) per RFC 5321.
   */
  @Column({ name: 'to_email', type: 'varchar', length: 320 })
  toEmail: string;

  // --- Payload -------------------------------------------------------------

  /** Subject line. VARCHAR(500) gives ample headroom for prefixes. */
  @Column({ type: 'varchar', length: 500 })
  subject: string;

  /**
   * Body of the email. `MEDIUMTEXT` (16 MB ceiling) so HTML bodies
   * with inline tables or images cannot silently truncate. The
   * list endpoint MUST NOT select this column — `EmailListItemDto`
   * intentionally omits it.
   */
  @Column({ type: 'mediumtext' })
  body: string;

  /**
   * MIME format hint for {@link body}. Defaults to `html` — every
   * PRMS-issued email is HTML transactional content. A future plain
   * text fallback uses `text`.
   */
  @Column({
    name: 'body_format',
    type: 'enum',
    enum: EmailBodyFormat,
    default: EmailBodyFormat.HTML,
  })
  bodyFormat: EmailBodyFormat;

  // --- Worker state --------------------------------------------------------

  /**
   * Current lifecycle position. Drives both the worker poll
   * (`status='queued'`) and the admin filter UI.
   */
  @Column({
    type: 'enum',
    enum: EmailStatus,
    default: EmailStatus.QUEUED,
  })
  status: EmailStatus;

  /**
   * Worker priority. Lower numeric value = higher priority. The
   * worker sorts `ORDER BY priority ASC, queued_at ASC` so lower
   * priorities (e.g. 1 for security alerts) drain ahead of routine
   * notifications. Stored as `TINYINT UNSIGNED`, default 5.
   */
  @Column({ type: 'tinyint', unsigned: true, default: 5 })
  priority: number;

  /**
   * Number of delivery attempts the worker has made. Incremented by
   * the worker on every attempt (success OR failure). **Never reset
   * by admin Retry** — that is intentional and protects against an
   * admin re-queuing a row that fails repeatedly. INT UNSIGNED.
   */
  @Column({ type: 'int', unsigned: true, default: 0 })
  attempts: number;

  /**
   * Cap on retry attempts before the row enters terminal `failed`.
   * Default 5; per-enqueue overridable for high-priority workflows
   * that prefer to fail fast. INT UNSIGNED.
   */
  @Column({ name: 'max_attempts', type: 'int', unsigned: true, default: 5 })
  maxAttempts: number;

  /**
   * Last error message recorded by the worker. Cleared by
   * `EmailsService.retry()`. `TEXT` (no length cap in practice) so
   * we can store a full stack trace if needed.
   */
  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError: string | null;

  /**
   * Timestamp when the worker leased this row (`status='sending'`).
   * The worker poll releases stale leases when
   * `locked_at < NOW() - INTERVAL 5 MINUTE` so a crashed worker
   * doesn't strand its in-flight emails forever.
   */
  @Column({
    name: 'locked_at',
    type: 'datetime',
    precision: 6,
    nullable: true,
  })
  lockedAt: Date | null;

  /**
   * Free-form identifier of the worker instance holding the lease
   * (e.g. hostname:pid). VARCHAR(100). NULL when no lease is held.
   */
  @Column({ name: 'locked_by', type: 'varchar', length: 100, nullable: true })
  lockedBy: string | null;

  /**
   * Earliest moment at which the worker may pick this row up.
   * Drives exponential backoff: on retry, the worker sets this to
   * `NOW() + backoff(attempts)`. NULL means "available immediately".
   * Admin Retry resets this to `NOW()`.
   */
  @Column({
    name: 'next_attempt_at',
    type: 'datetime',
    precision: 6,
    nullable: true,
  })
  nextAttemptAt: Date | null;

  /**
   * Successful delivery timestamp. Set by the worker on first
   * successful send; never updated again.
   */
  @Column({
    name: 'sent_at',
    type: 'datetime',
    precision: 6,
    nullable: true,
  })
  sentAt: Date | null;

  /**
   * When the row was queued. Distinct from {@link createdAt} only in
   * very narrow scenarios (e.g. a future "schedule for later" flow
   * that inserts a row with a future `queued_at`); today both
   * columns are populated by `CURRENT_TIMESTAMP(6)` defaults and
   * coincide.
   */
  @Column({
    name: 'queued_at',
    type: 'datetime',
    precision: 6,
  })
  @Index('IDX_emails_queued_at')
  queuedAt: Date;

  // --- Provenance ----------------------------------------------------------

  /**
   * Optional FK to the `users.id` of the user (or service account)
   * that enqueued the row. NULL when enqueued by an unauthenticated
   * background job. ON DELETE SET NULL preserves the row.
   */
  @ManyToOne(() => User, { nullable: true, eager: false })
  @JoinColumn({ name: 'created_by_user_id' })
  createdByUser: User | null;

  /** FK column for {@link createdByUser}. */
  @Column({
    name: 'created_by_user_id',
    type: 'int',
    nullable: true,
  })
  createdByUserId: number | null;

  /**
   * Forward-compat hook for a future template engine. NULL in the
   * current slice; populated when a template renderer is added.
   */
  @Column({
    name: 'template_key',
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  templateKey: string | null;

  /**
   * Arbitrary structured payload from the enqueuer (e.g. the
   * mapping id and project code that motivated this notification).
   * Typed as `Record<string, unknown>` so callers can attach any
   * JSON-serialisable object without per-feature schema churn.
   */
  @Column({ type: 'json', nullable: true })
  metadata: Record<string, unknown> | null;

  // --- Timestamps ----------------------------------------------------------

  /**
   * Row creation timestamp. Set by the column default
   * (`CURRENT_TIMESTAMP(6)`); TypeORM hydrates as `Date`.
   */
  @CreateDateColumn({
    name: 'created_at',
    type: 'datetime',
    precision: 6,
  })
  createdAt: Date;

  /**
   * Row update timestamp. Maintained automatically by MySQL via
   * the column's `ON UPDATE CURRENT_TIMESTAMP(6)` clause — we
   * never assign to this from the service.
   */
  @UpdateDateColumn({
    name: 'updated_at',
    type: 'datetime',
    precision: 6,
  })
  updatedAt: Date;
}
