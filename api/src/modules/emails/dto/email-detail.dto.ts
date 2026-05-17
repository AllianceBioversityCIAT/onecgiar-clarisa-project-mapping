import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EmailStatus } from '../enums/email-status.enum';
import { EmailBodyFormat } from '../enums/email-body-format.enum';

/**
 * Full response for `GET /admin/emails/:id` and the post-action
 * payload of `POST /admin/emails/:id/retry`.
 *
 * Includes every column the admin Email Management detail page
 * surfaces: the same fields as {@link EmailListItemDto} plus the
 * payload itself (`body` / `bodyFormat`), the worker diagnostic
 * fields (`lastError`, `lockedAt`, `lockedBy`), and the provenance
 * fields (`createdByUserId` / `createdByUserName`, `templateKey`,
 * `metadata`).
 *
 * `createdByUserName` is projected from the joined enqueuer's
 * first + last name, the same way `toUserName` is projected on
 * the list endpoint. Null when the enqueuer FK is null (system /
 * background-job enqueue) or when the user was deleted.
 */
export class EmailDetailDto {
  // --- Identity / recipient (mirrors list item) ----------------------------

  @ApiProperty({ description: 'Email row id' })
  id: number;

  @ApiPropertyOptional({ description: 'Recipient user id (nullable)' })
  toUserId: number | null;

  @ApiProperty({ description: 'Recipient email address' })
  toEmail: string;

  @ApiPropertyOptional({
    description: 'Recipient display name (first + last). Null when no user.',
  })
  toUserName: string | null;

  // --- Payload -------------------------------------------------------------

  @ApiProperty({ description: 'Subject line' })
  subject: string;

  /**
   * Full email body. Can be up to 16 MB (MEDIUMTEXT). The admin UI
   * renders this either as raw HTML (sandboxed) or as plain text
   * depending on {@link bodyFormat}.
   */
  @ApiProperty({ description: 'Full email body (HTML or plain text)' })
  body: string;

  @ApiProperty({ enum: EmailBodyFormat, description: 'MIME format of body' })
  bodyFormat: EmailBodyFormat;

  // --- Worker state --------------------------------------------------------

  @ApiProperty({ enum: EmailStatus, description: 'Current status' })
  status: EmailStatus;

  @ApiProperty({ description: 'Worker priority (lower = higher)' })
  priority: number;

  @ApiProperty({ description: 'Attempts made by the worker so far' })
  attempts: number;

  @ApiProperty({ description: 'Max attempts before terminal failure' })
  maxAttempts: number;

  /**
   * Last error recorded by the worker. Cleared by admin Retry. Can
   * be large (full stack trace) so it is excluded from the list
   * response and only surfaced here.
   */
  @ApiPropertyOptional({ description: 'Last error recorded by the worker' })
  lastError: string | null;

  /**
   * When the worker leased this row (`status='sending'`). Cleared
   * by admin Retry. Useful for the admin UI to surface "currently
   * being attempted" vs "queued but not yet picked up".
   */
  @ApiPropertyOptional({ description: 'Worker lease timestamp' })
  lockedAt: Date | null;

  /**
   * Worker instance identifier holding the lease. Cleared by admin
   * Retry. Format is up to the worker (e.g. `hostname:pid`).
   */
  @ApiPropertyOptional({ description: 'Worker instance holding the lease' })
  lockedBy: string | null;

  @ApiPropertyOptional({
    description: 'Earliest worker pickup time (null = immediately)',
  })
  nextAttemptAt: Date | null;

  @ApiPropertyOptional({ description: 'Successful delivery timestamp' })
  sentAt: Date | null;

  @ApiProperty({ description: 'When the row was queued' })
  queuedAt: Date;

  // --- Provenance ----------------------------------------------------------

  @ApiPropertyOptional({
    description: 'User id of the enqueuer. Null for system/background enqueue.',
  })
  createdByUserId: number | null;

  @ApiPropertyOptional({
    description:
      'Display name of the enqueuer (first + last). Null when no user.',
  })
  createdByUserName: string | null;

  @ApiPropertyOptional({
    description: 'Forward-compat template key. Null in the current slice.',
  })
  templateKey: string | null;

  /**
   * Structured payload attached at enqueue time. Surface area is
   * intentionally open — callers attach whatever JSON-serialisable
   * context is useful for debugging.
   */
  @ApiPropertyOptional({
    description: 'Free-form metadata attached at enqueue time',
    type: 'object',
    additionalProperties: true,
  })
  metadata: Record<string, unknown> | null;

  // --- Timestamps ----------------------------------------------------------

  @ApiProperty({ description: 'Row creation timestamp' })
  createdAt: Date;

  @ApiProperty({ description: 'Row last-updated timestamp' })
  updatedAt: Date;
}
