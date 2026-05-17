import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EmailStatus } from '../enums/email-status.enum';

/**
 * Compact response row for `GET /admin/emails` (list endpoint).
 *
 * Intentionally **omits** `body` and `last_error` — both can be large
 * (MEDIUMTEXT and TEXT respectively) and serialising them for every
 * page of results bloats responses unnecessarily. They are returned
 * only on the per-row detail endpoint ({@link EmailDetailDto}).
 *
 * `toUserName` is projected from the joined `users` row (first +
 * last name) so the admin UI can render a friendly label without
 * doing a follow-up lookup. Null when the recipient has no FK
 * (`to_user_id IS NULL`) or when the recipient user was deleted.
 */
export class EmailListItemDto {
  /** Primary key. */
  @ApiProperty({ description: 'Email row id' })
  id: number;

  /**
   * FK to `users.id` of the recipient. Null when the email was sent
   * to an address with no registered user (e.g. invitation flows)
   * or when the recipient user has since been deleted.
   */
  @ApiPropertyOptional({ description: 'Recipient user id (nullable)' })
  toUserId: number | null;

  /** Denormalised recipient email address (always present). */
  @ApiProperty({ description: 'Recipient email address' })
  toEmail: string;

  /**
   * Display name of the recipient assembled from the joined user's
   * first + last name. Null when no FK or when the user was deleted.
   * Computed in the service — clients should not assemble it.
   */
  @ApiPropertyOptional({
    description: 'Recipient display name (first + last). Null when no user.',
  })
  toUserName: string | null;

  /** Subject line. */
  @ApiProperty({ description: 'Subject line' })
  subject: string;

  /** Current lifecycle status. */
  @ApiProperty({ enum: EmailStatus, description: 'Current status' })
  status: EmailStatus;

  /** Worker priority (lower = higher priority). */
  @ApiProperty({ description: 'Worker priority (lower = higher)' })
  priority: number;

  /** Number of attempts made by the worker so far. */
  @ApiProperty({ description: 'Attempts made by the worker so far' })
  attempts: number;

  /** Cap on attempts before terminal `failed`. */
  @ApiProperty({ description: 'Max attempts before terminal failure' })
  maxAttempts: number;

  /** When the row was queued. */
  @ApiProperty({ description: 'When the row was queued' })
  queuedAt: Date;

  /** When the row was successfully delivered, if it has been. */
  @ApiPropertyOptional({ description: 'Successful delivery timestamp' })
  sentAt: Date | null;

  /**
   * Earliest moment at which the worker may pick this row up. Null
   * means "immediately". Useful in the admin UI to surface that a
   * row is currently in exponential-backoff.
   */
  @ApiPropertyOptional({
    description: 'Earliest worker pickup time (null = immediately)',
  })
  nextAttemptAt: Date | null;

  /** Row creation timestamp. */
  @ApiProperty({ description: 'Row creation timestamp' })
  createdAt: Date;
}
