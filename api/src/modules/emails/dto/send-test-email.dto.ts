import { IsInt, IsPositive } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Request body for `POST /admin/emails/test-send`.
 *
 * The endpoint is intentionally locked down: the caller picks the
 * recipient user and nothing else. Subject, body, body format, and
 * metadata are all assembled server-side from a fixed template. This
 * keeps the endpoint useful only for verifying the email pipeline and
 * prevents it from being repurposed as an arbitrary "send email"
 * surface.
 *
 * Validation:
 *  - `toUserId` is required and must be a positive integer. Existence
 *    of the user (and presence of an email on record) is verified at
 *    the service layer where a richer error can be returned.
 */
export class SendTestEmailDto {
  /**
   * Target recipient. Must reference an existing `users.id`. **Inactive
   * users are allowed by design** — admin should be able to verify the
   * pipeline against any account on file, even a deactivated one. The
   * service still rejects users with no email address on record.
   */
  @ApiProperty({
    description:
      'ID of the user to send the test email to. Must be a positive integer.',
    example: 42,
    minimum: 1,
  })
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  toUserId: number;
}
