import {
  IsEnum,
  IsOptional,
  IsBoolean,
  IsInt,
  IsArray,
  IsPositive,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { UserRole } from '../enums/user-role.enum';

/**
 * DTO for admin user updates (PATCH /users/:id).
 *
 * All fields are optional — only supplied fields are updated.
 * Cross-field validation enforces role-specific constraints:
 * - `program_rep` must have a programId, cannot have centerIds.
 * - `center_rep`  must have centerIds (≥ 1), cannot have a programId.
 * - `admin` / `workflow_admin` should have neither.
 *
 * `centerIds`:
 *  - First element is the primary center (writes to `users.center_id` +
 *    `user_centers.sort_order = 0`).
 *  - Submission order is preserved verbatim by the service — no implicit
 *    sorting. Index N → `sort_order = N`.
 *  - `null` means "clear all centers" — valid only when the role is
 *    changing away from `center_rep` (controller enforces this).
 */
export class UpdateUserDto {
  /** New role to assign. */
  @ApiPropertyOptional({
    enum: UserRole,
    description: 'New role to assign (nullable)',
  })
  @IsOptional()
  @IsEnum(UserRole, {
    message: `role must be one of: ${Object.values(UserRole).join(', ')}`,
  })
  role?: UserRole | null;

  /** Program association (required for program_rep, null for others). */
  @ApiPropertyOptional({
    description: 'Program ID (required for program_rep, null for others)',
  })
  @IsOptional()
  @ValidateIf((o) => o.programId !== null)
  @Type(() => Number)
  @IsInt({ message: 'programId must be a valid integer' })
  programId?: number | null;

  /**
   * Center memberships — ordered list (primary first), or `null` to clear.
   *
   * DTO-level validators are permissive; the controller enforces:
   *  - role = center_rep → must be a non-empty array
   *  - other roles      → must be omitted or null
   */
  @ApiPropertyOptional({
    description:
      'Ordered center IDs (required for center_rep, primary first; null to clear).',
    type: [Number],
    example: [4, 11, 2],
  })
  @IsOptional()
  @ValidateIf((o: UpdateUserDto) => o.centerIds !== null)
  @IsArray({ message: 'centerIds must be an array of integers' })
  @Type(() => Number)
  @IsInt({ each: true, message: 'centerIds must contain integers only' })
  @IsPositive({
    each: true,
    message: 'centerIds must contain positive integers only',
  })
  centerIds?: number[] | null;

  /** Whether the user account is active. */
  @ApiPropertyOptional({ description: 'Whether the user account is active' })
  @IsOptional()
  @IsBoolean({ message: 'isActive must be a boolean' })
  isActive?: boolean;

  /**
   * First name — editable by admin only while the user has not yet logged in
   * (i.e. `cognito_sub IS NULL`). After first login Cognito owns the field
   * and overwrites it on every refresh, so the service rejects edits then.
   */
  @ApiPropertyOptional({
    description:
      'First name (only editable before the user logs in for the first time).',
  })
  @IsOptional()
  @IsString({ message: 'firstName must be a string' })
  @MinLength(1, { message: 'firstName must not be empty' })
  @MaxLength(100, { message: 'firstName must be at most 100 characters' })
  firstName?: string;

  /**
   * Last name — same lifecycle as {@link firstName}: pre-login only.
   */
  @ApiPropertyOptional({
    description:
      'Last name (only editable before the user logs in for the first time).',
  })
  @IsOptional()
  @IsString({ message: 'lastName must be a string' })
  @MinLength(1, { message: 'lastName must not be empty' })
  @MaxLength(100, { message: 'lastName must be at most 100 characters' })
  lastName?: string;
}
