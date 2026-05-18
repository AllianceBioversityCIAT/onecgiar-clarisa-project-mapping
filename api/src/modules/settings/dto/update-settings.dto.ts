import { IsBoolean, IsDateString, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Request body for `PATCH /settings`.
 *
 * The cross-field rule "deadlineDate is required and must be a future
 * date when deadlineEnabled is true" is enforced at the service layer
 * (not via class-validator) so we can return a clear domain-level
 * `BadRequestException` message and compare dates as `YYYY-MM-DD`
 * strings to avoid timezone bugs.
 */
export class UpdateSettingsDto {
  /**
   * Toggle for outbound email notifications. The email module is not
   * yet built — this flag is stored only.
   */
  @ApiProperty({
    description: 'Whether outbound email notifications are enabled',
    example: false,
  })
  @IsBoolean()
  emailEnabled: boolean;

  /**
   * Toggle for the soft mapping-completion deadline. When `true`, the
   * service requires a valid future `deadlineDate`.
   */
  @ApiProperty({
    description: 'Whether the mapping-completion deadline is active',
    example: true,
  })
  @IsBoolean()
  deadlineEnabled: boolean;

  /**
   * Mapping-completion deadline in ISO 8601 date format (`YYYY-MM-DD`).
   *
   * Required and must be strictly in the future when `deadlineEnabled`
   * is `true`. When `deadlineEnabled` is `false`, this field is ignored
   * (coerced to `null` in the database update).
   */
  @ApiPropertyOptional({
    description:
      'Mapping deadline in YYYY-MM-DD. Required and must be a future date when deadlineEnabled is true.',
    example: '2026-12-31',
    nullable: true,
  })
  @IsOptional()
  @IsDateString(
    { strict: true, strictSeparator: true },
    { message: 'deadlineDate must be a valid ISO 8601 date (YYYY-MM-DD)' },
  )
  deadlineDate?: string | null;
}
