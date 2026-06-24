import {
  IsBoolean,
  IsDateString,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
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
   * service requires a valid `deadlineDate` (any calendar date).
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
   * Required (any calendar date) when `deadlineEnabled` is `true`. When
   * `deadlineEnabled` is `false`, this field is ignored (coerced to `null`
   * in the database update).
   */
  @ApiPropertyOptional({
    description:
      'Mapping deadline in YYYY-MM-DD. Required when deadlineEnabled is true (any calendar date).',
    example: '2026-12-31',
    nullable: true,
  })
  @IsOptional()
  @IsDateString(
    { strict: true, strictSeparator: true },
    { message: 'deadlineDate must be a valid ISO 8601 date (YYYY-MM-DD)' },
  )
  deadlineDate?: string | null;

  /**
   * Toggle for the program mapping deadline. Independent of
   * `deadlineEnabled` (the center deadline). When `true`, the service
   * requires a valid `programDeadlineDate` (any calendar date).
   */
  @ApiProperty({
    description: 'Whether the program mapping deadline is active',
    example: true,
  })
  @IsBoolean()
  programDeadlineEnabled: boolean;

  /**
   * Program mapping deadline in ISO 8601 date format (`YYYY-MM-DD`).
   *
   * Required (any calendar date) when `programDeadlineEnabled` is `true`.
   * When it is `false`, this field is ignored (coerced to `null` in the
   * database update).
   */
  @ApiPropertyOptional({
    description:
      'Program mapping deadline in YYYY-MM-DD. Required when programDeadlineEnabled is true (any calendar date).',
    example: '2026-07-06',
    nullable: true,
  })
  @IsOptional()
  @IsDateString(
    { strict: true, strictSeparator: true },
    {
      message: 'programDeadlineDate must be a valid ISO 8601 date (YYYY-MM-DD)',
    },
  )
  programDeadlineDate?: string | null;

  /**
   * Master toggle for the "Notification of Updates" digest. When `true`,
   * the service requires `updateDigestIntervalDays`, `updateDigestWindowDays`
   * and `updateDigestEndDate` (validated at the service layer so the
   * messages are domain-level and dates compare as `YYYY-MM-DD` strings).
   */
  @ApiProperty({
    description: 'Whether the "Notification of Updates" digest is enabled',
    example: false,
  })
  @IsBoolean()
  updateDigestEnabled: boolean;

  /**
   * Minimum whole-days between digest sends (cadence throttle). Required
   * when `updateDigestEnabled` is `true`. 1–90.
   */
  @ApiPropertyOptional({
    description:
      'Minimum whole-days between digest sends. Required when updateDigestEnabled is true.',
    example: 2,
    minimum: 1,
    maximum: 90,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  updateDigestIntervalDays?: number;

  /**
   * Trailing window (in days) over which a project counts as "updated".
   * Required when `updateDigestEnabled` is `true`. 1–90.
   */
  @ApiPropertyOptional({
    description:
      'Trailing window (in days) for "updated" projects. Required when updateDigestEnabled is true.',
    example: 2,
    minimum: 1,
    maximum: 90,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  updateDigestWindowDays?: number;

  /**
   * Last date the digest sends, in ISO 8601 date format (`YYYY-MM-DD`).
   *
   * Required (any calendar date) when `updateDigestEnabled` is `true`. When
   * it is `false`, this field is ignored (coerced to `null` in the database
   * update).
   */
  @ApiPropertyOptional({
    description:
      'Last date the digest sends, in YYYY-MM-DD. Required when updateDigestEnabled is true.',
    example: '2026-09-30',
    nullable: true,
  })
  @IsOptional()
  @IsDateString(
    { strict: true, strictSeparator: true },
    {
      message: 'updateDigestEndDate must be a valid ISO 8601 date (YYYY-MM-DD)',
    },
  )
  updateDigestEndDate?: string | null;

  /**
   * Master toggle for the **program-side** "Notification of Updates" digest.
   * Independent of `updateDigestEnabled` (the center digest). When `true`,
   * the service requires `programUpdateDigestIntervalDays`,
   * `programUpdateDigestWindowDays` and `programUpdateDigestEndDate`
   * (validated at the service layer so the messages are domain-level and
   * dates compare as `YYYY-MM-DD` strings).
   */
  @ApiProperty({
    description:
      'Whether the program-side "Notification of Updates" digest is enabled',
    example: false,
  })
  @IsBoolean()
  programUpdateDigestEnabled: boolean;

  /**
   * Minimum whole-days between program digest sends (cadence throttle).
   * Required when `programUpdateDigestEnabled` is `true`. 1–90.
   */
  @ApiPropertyOptional({
    description:
      'Minimum whole-days between program digest sends. Required when programUpdateDigestEnabled is true.',
    example: 2,
    minimum: 1,
    maximum: 90,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  programUpdateDigestIntervalDays?: number;

  /**
   * Trailing window (in days) over which a project counts as "updated" for
   * the program digest. Required when `programUpdateDigestEnabled` is `true`.
   * 1–90.
   */
  @ApiPropertyOptional({
    description:
      'Trailing window (in days) for "updated" projects in the program digest. Required when programUpdateDigestEnabled is true.',
    example: 2,
    minimum: 1,
    maximum: 90,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  programUpdateDigestWindowDays?: number;

  /**
   * Last date the program digest sends, in ISO 8601 date format
   * (`YYYY-MM-DD`).
   *
   * Required (any calendar date) when `programUpdateDigestEnabled` is `true`.
   * When it is `false`, this field is ignored (coerced to `null` in the
   * database update).
   */
  @ApiPropertyOptional({
    description:
      'Last date the program digest sends, in YYYY-MM-DD. Required when programUpdateDigestEnabled is true.',
    example: '2026-09-30',
    nullable: true,
  })
  @IsOptional()
  @IsDateString(
    { strict: true, strictSeparator: true },
    {
      message:
        'programUpdateDigestEndDate must be a valid ISO 8601 date (YYYY-MM-DD)',
    },
  )
  programUpdateDigestEndDate?: string | null;
}
