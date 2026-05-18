import {
  IsDate,
  IsEmail,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { EmailBodyFormat } from '../enums/email-body-format.enum';

/**
 * Internal-only DTO documenting the future `EmailsService.enqueue()`
 * signature. **Not exposed via any HTTP endpoint** in this slice — no
 * controller binds it, no Swagger annotations needed.
 *
 * The DTO exists so:
 *  1. Future callers (e.g. a mapping-event notifier, a deadline
 *     reminder cron, an invitation flow) have a single typed
 *     contract to import.
 *  2. The validators are declared once here rather than re-derived
 *     by every caller.
 *  3. The shape is reviewable as part of this slice so the next
 *     module that needs to send an email doesn't have to negotiate
 *     a contract from scratch.
 *
 * Defaults applied by `enqueue()` when fields are omitted:
 *  - `bodyFormat`     → `EmailBodyFormat.HTML`
 *  - `priority`       → `5`
 *  - `maxAttempts`    → `5`
 *  - `nextAttemptAt`  → `null` (pick up immediately)
 *  - `status`         → `EmailStatus.QUEUED` (set by `enqueue()`, not on this DTO)
 *  - `queuedAt`       → MySQL `CURRENT_TIMESTAMP(6)` default
 *
 * Cardinality:
 *  - `toEmail` is **required**. It is always denormalised from the
 *    caller-supplied value, never derived from `toUserId`, so the
 *    enqueuer can choose to email a user at an alternate address.
 *  - `toUserId` is **optional**. When supplied it must reference a
 *    real `users.id` (validated by the FK at insert time, not here).
 *  - `createdByUserId` is **optional**. Background jobs leave it
 *    null; user-triggered enqueues should set it for auditability.
 */
export class EnqueueEmailDto {
  /**
   * Optional FK to the recipient `users.id`. Validated only as an
   * `int` here; the FK constraint at the database layer rejects
   * unknown ids on insert.
   */
  @IsOptional()
  @IsInt()
  toUserId?: number;

  /**
   * Recipient email address (required). RFC-validated. The 320-char
   * upper bound matches the column width.
   */
  @IsEmail()
  @MaxLength(320)
  toEmail: string;

  /**
   * Subject line (required). Trimmed to the column width.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  subject: string;

  /**
   * Body content (required). Up to 16 MB (`MEDIUMTEXT`). Format hinted
   * by {@link bodyFormat}; defaults to HTML.
   */
  @IsString()
  @MinLength(1)
  body: string;

  /**
   * MIME hint for {@link body}. Defaults to `html` when omitted.
   */
  @IsOptional()
  @IsEnum(EmailBodyFormat)
  bodyFormat?: EmailBodyFormat;

  /**
   * Worker priority (lower = higher). Bounded to the TINYINT
   * UNSIGNED column range (0..255). Defaults to 5.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(255)
  priority?: number;

  /**
   * Cap on attempts before terminal `failed`. Defaults to 5. Set to
   * 1 for fire-and-forget non-critical notifications, set higher
   * for high-importance messages where the recipient's MX server
   * is known to be flaky.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(255)
  maxAttempts?: number;

  /**
   * Forward-compat hook for a future template engine. Callers that
   * don't yet use templates leave this null.
   */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  templateKey?: string;

  /**
   * Free-form structured payload. Anything JSON-serialisable is
   * accepted — `class-validator`'s `@IsObject` rejects scalars and
   * arrays so it must be a plain object. Defaults to null.
   */
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  /**
   * Optional FK to `users.id` of the enqueuer (user or service
   * account). Background jobs leave this undefined; user-triggered
   * enqueues should set it for auditability.
   */
  @IsOptional()
  @IsInt()
  createdByUserId?: number;

  /**
   * Schedule the worker to pick this row up no earlier than the
   * supplied timestamp. Omit (or pass `null`) for immediate pickup.
   * Useful for "send tomorrow at 09:00" reminder flows.
   */
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  nextAttemptAt?: Date;
}
