import {
  IsArray,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { EmailStatus } from '../enums/email-status.enum';

/**
 * Whitelisted sort fields for `GET /admin/emails`.
 *
 * Mapping to raw SQL columns is performed in the service layer — only
 * fields listed here are accepted by the validator. Untrusted strings
 * must never reach the QueryBuilder's `orderBy()`.
 *
 * Field names are the **raw DB column names** so the service can pass
 * them straight to `orderBy()` (CLAUDE.md: raw column names in
 * `orderBy`, camelCase property names in `where`).
 */
export const EMAIL_SORT_FIELDS = [
  'queued_at',
  'sent_at',
  'status',
  'attempts',
] as const;

export type EmailSortField = (typeof EMAIL_SORT_FIELDS)[number];

/**
 * Query parameters for the admin email list endpoint.
 *
 * Pagination, status filter, recipient filter, free-text search across
 * `subject`/`to_email`, queued-at date range, and a whitelisted
 * sort field/direction.
 *
 * Notes on the `status` filter:
 *  - Single value:        `?status=failed`
 *  - Multi-value (CSV):   `?status=queued,failed`
 *  - Multi-value (repeat): `?status=queued&status=failed`
 *
 * All three shapes are normalised to `EmailStatus[]` by the
 * `@Transform`. Each value is validated against the enum so unknown
 * statuses produce a 400 rather than a silently empty result.
 */
export class ListEmailsQueryDto {
  /** Page number (1-based). Defaults to 1. */
  @ApiPropertyOptional({ default: 1, minimum: 1, description: 'Page number' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  /** Page size. Defaults to 25, max 100 to bound payload size. */
  @ApiPropertyOptional({
    default: 25,
    minimum: 1,
    maximum: 100,
    description: 'Items per page',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 25;

  /**
   * Filter by one or more email statuses. Accepts a single value, a
   * CSV string, or a repeated query parameter — see class doc. Empty
   * / undefined means "no status filter".
   */
  @ApiPropertyOptional({
    description: 'Filter by status. Accepts repeated param or CSV string.',
    enum: EmailStatus,
    isArray: true,
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === null || value === '') return undefined;
    const arr = Array.isArray(value) ? value : String(value).split(',');
    return arr.map((v) => String(v).trim()).filter((v) => v.length > 0);
  })
  @IsArray()
  @IsEnum(EmailStatus, { each: true })
  status?: EmailStatus[];

  /**
   * Filter by one or more template keys (`emails.template_key`), e.g.
   * `center_update_digest`. Accepts a single value, a CSV string, or a
   * repeated query parameter — same shape as {@link status}. Validated as
   * free-form strings (not an enum) so newly-added templates filter without
   * a DTO change. Empty / undefined means "no template filter".
   */
  @ApiPropertyOptional({
    description: 'Filter by template key. Accepts repeated param or CSV string.',
    isArray: true,
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === null || value === '') return undefined;
    const arr = Array.isArray(value) ? value : String(value).split(',');
    return arr.map((v) => String(v).trim()).filter((v) => v.length > 0);
  })
  @IsArray()
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  templateKey?: string[];

  /**
   * Restrict to emails addressed to a specific user (by `users.id`).
   * Matches `emails.to_user_id` exactly — does NOT match by email
   * address, so historical rows sent to an address that has since
   * been registered are intentionally excluded.
   */
  @ApiPropertyOptional({
    description: 'Filter by recipient user id (matches to_user_id)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  toUserId?: number;

  /**
   * Free-text search applied to `subject` OR `to_email` with `LIKE
   * '%term%'`. Trimmed in the service so leading/trailing whitespace
   * doesn't surprise the user.
   */
  @ApiPropertyOptional({
    description: 'Search term applied to subject and to_email (LIKE, OR)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  /**
   * Inclusive lower bound for `queued_at`. ISO 8601 `YYYY-MM-DD`. The
   * service parses with `new Date()` and binds as a timestamp at
   * 00:00:00 of the supplied date.
   */
  @ApiPropertyOptional({
    description: 'Filter rows with queued_at on or after this ISO date',
    example: '2026-01-01',
  })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  /**
   * Inclusive upper bound for `queued_at`. ISO 8601 `YYYY-MM-DD`. The
   * service expands this to end-of-day (`23:59:59.999999`) before
   * binding so a single-day range (`dateFrom=dateTo`) returns rows
   * queued anywhere on that calendar day.
   */
  @ApiPropertyOptional({
    description: 'Filter rows with queued_at on or before this ISO date',
    example: '2026-12-31',
  })
  @IsOptional()
  @IsDateString()
  dateTo?: string;

  /**
   * Server-side sort field. Restricted to {@link EMAIL_SORT_FIELDS} so
   * untrusted input never reaches the SQL layer. Raw DB column names
   * (not entity properties) per the CLAUDE.md rule that `orderBy`
   * uses raw columns.
   */
  @ApiPropertyOptional({
    description: 'Field to sort by (raw DB column name)',
    enum: EMAIL_SORT_FIELDS,
    default: 'queued_at',
  })
  @IsOptional()
  @IsIn(EMAIL_SORT_FIELDS as unknown as string[])
  sortBy: EmailSortField = 'queued_at';

  /** Sort direction. */
  @ApiPropertyOptional({
    description: 'Sort direction',
    enum: ['ASC', 'DESC'],
    default: 'DESC',
  })
  @IsOptional()
  @IsIn(['ASC', 'DESC'])
  sortDir: 'ASC' | 'DESC' = 'DESC';
}
