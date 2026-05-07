import { Transform, Type } from 'class-transformer';
import {
  IsDate,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { AuditEntityType } from '../entities/audit-event.entity';
import { ActorRole } from '../../mappings/enums/actor-role.enum';

/**
 * HTTP query DTO for `GET /audit`.
 *
 * Validated by the global `ValidationPipe` (whitelist + transform). Once
 * transformed, the resulting instance is structurally compatible with
 * `AuditQueryFilters` from `audit-record-input.ts`, so the controller can
 * pass it straight through to `AuditService.query()`.
 *
 * Defaults for `page`, `limit`, `sort`, and `direction` are intentionally
 * NOT applied here — the service already clamps and defaults them, and
 * keeping the DTO defaults-free means an absent query param round-trips
 * as `undefined` rather than a synthetic value.
 */
export class AuditQueryDto {
  /** 1-based page index. Service clamps to >= 1. */
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  /** Page size. Hard cap at 200 to mirror the service-level guard. */
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  /** Filter by polymorphic entity type. */
  @IsOptional()
  @IsEnum(AuditEntityType)
  entityType?: AuditEntityType;

  /** Filter by entity row ID. Only meaningful when `entityType` is also set. */
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  entityId?: number;

  /**
   * Action verb filter — accepts:
   *   - a single value:  `?action=project.metadata_update`
   *   - comma-separated: `?action=project.metadata_update,user.role_changed`
   *   - repeated param:  `?action=a&action=b` (Express delivers an array)
   *
   * Normalised to `string[] | undefined` after transform so the service can
   * always treat a populated value as a list. Empty strings are dropped.
   */
  @Transform(({ value }) => {
    if (Array.isArray(value)) {
      return value
        .map((v) => (typeof v === 'string' ? v.trim() : ''))
        .filter(Boolean);
    }
    if (typeof value === 'string') {
      return value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    return undefined;
  })
  @IsOptional()
  @IsString({ each: true })
  action?: string[];

  /** Filter by the user who performed the action. */
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  actorUserId?: number;

  /** Filter by the role the actor held at the time of the action. */
  @IsOptional()
  @IsEnum(ActorRole)
  actorRole?: ActorRole;

  /** Inclusive lower bound on `created_at`. ISO 8601 string in the URL. */
  @Type(() => Date)
  @IsOptional()
  @IsDate()
  from?: Date;

  /** Inclusive upper bound on `created_at`. ISO 8601 string in the URL. */
  @Type(() => Date)
  @IsOptional()
  @IsDate()
  to?: Date;

  /** Free-text LIKE search over `summary` and `justification`. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  /** Sort key. Service maps onto raw DB column names. */
  @IsOptional()
  @IsIn(['created_at', 'actor_user_id', 'action'])
  sort?: 'created_at' | 'actor_user_id' | 'action';

  /** Sort direction. */
  @IsOptional()
  @IsIn(['asc', 'desc'])
  direction?: 'asc' | 'desc';
}
