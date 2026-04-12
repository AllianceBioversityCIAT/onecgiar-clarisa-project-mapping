import {
  IsEmail,
  IsString,
  IsOptional,
  IsEnum,
  IsBoolean,
  IsInt,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';
import { UserRole } from '../enums/user-role.enum';

/**
 * DTO for admin user creation (POST /users).
 *
 * Admins can pre-provision users by email. The new record is persisted
 * with `cognitoSub = null`; on the user's first Cognito login the
 * `upsertFromCognito` flow matches them by email and backfills the
 * Cognito `sub` claim.
 *
 * Cross-field validation mirrors {@link UpdateUserDto}:
 *  - `program_rep` must have a `programId` and must NOT have a `centerId`.
 *  - `center_rep`  must have a `centerId`  and must NOT have a `programId`.
 *  - `admin` should have neither.
 *
 * The conditional `@ValidateIf` calls here enforce the "required when
 * role is X" half of those rules; the rest (mutual exclusion / admin
 * should have neither) is enforced in `UsersController.create`, in the
 * same pattern used by the existing `PATCH /users/:id` endpoint.
 */
export class CreateUserDto {
  /** User email address. Must be globally unique. */
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(255, { message: 'email must be at most 255 characters' })
  email: string;

  /** User first name. */
  @IsString({ message: 'firstName must be a string' })
  @MaxLength(100, { message: 'firstName must be at most 100 characters' })
  firstName: string;

  /** User last name. */
  @IsString({ message: 'lastName must be a string' })
  @MaxLength(100, { message: 'lastName must be at most 100 characters' })
  lastName: string;

  /**
   * Initial role for the new user.
   *
   * Optional — if omitted the user is created with `role = null` and an
   * admin can assign a role later via `PATCH /users/:id`. New users with
   * a null role cannot access any role-guarded endpoint.
   */
  @IsOptional()
  @IsEnum(UserRole, {
    message: `role must be one of: ${Object.values(UserRole).join(', ')}`,
  })
  role?: UserRole;

  /**
   * Program association.
   *
   * - When `role === PROGRAM_REP` this field is REQUIRED — the
   *   `@ValidateIf` opens the `@IsInt` check, which fails for
   *   `undefined`/`null` and therefore produces a 400 response.
   * - When `role` is anything else, validation of this field is skipped
   *   entirely (the `@ValidateIf` predicate is false), so the admin can
   *   safely omit it.
   *
   * Cross-field rules like "program_rep must NOT have a centerId" and
   * "admin must have neither" are enforced in the controller, matching
   * the existing `PATCH /users/:id` pattern.
   */
  @ValidateIf((o: CreateUserDto) => o.role === UserRole.PROGRAM_REP)
  @Type(() => Number)
  @IsInt({ message: 'programId must be a valid integer' })
  programId?: number;

  /**
   * Center association — required when `role === CENTER_REP`, skipped
   * entirely otherwise. Same `@ValidateIf` gating pattern as `programId`.
   */
  @ValidateIf((o: CreateUserDto) => o.role === UserRole.CENTER_REP)
  @Type(() => Number)
  @IsInt({ message: 'centerId must be a valid integer' })
  centerId?: number;

  /**
   * Whether the account is active on creation. Defaults to `true` in the
   * service when omitted, which matches the column default.
   */
  @IsOptional()
  @IsBoolean({ message: 'isActive must be a boolean' })
  isActive?: boolean;
}
