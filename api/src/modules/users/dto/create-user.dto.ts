import {
  IsEmail,
  IsString,
  IsOptional,
  IsEnum,
  IsBoolean,
  IsInt,
  IsArray,
  IsPositive,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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
 *  - `program_rep` must have a `programId` and must NOT have `centerIds`.
 *  - `center_rep`  must have `centerIds` (≥ 1) and must NOT have a `programId`.
 *  - `admin` / `workflow_admin` should have neither.
 *
 * Multi-center membership (task A-3 of the multi-center plan):
 *  - `centerIds` is the full ordered set of centers a center_rep belongs to.
 *  - The FIRST element is the primary center: the service writes
 *    `users.center_id = centerIds[0]` and that row gets `sort_order = 0`
 *    in the `user_centers` junction table.
 *  - Subsequent elements are stored in submission order with ascending
 *    `sort_order` (index 1 → sort_order 1, index 2 → sort_order 2, ...).
 *  - The DTO-level validators are permissive (everything optional); the
 *    "≥ 1 when role = center_rep" requirement is enforced in
 *    `UsersController` so the rule lives in one place across POST + PATCH.
 */
export class CreateUserDto {
  /** User email address. Must be globally unique. */
  @ApiProperty({
    example: 'jane.doe@cgiar.org',
    description: 'User email address (must be unique)',
  })
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(255, { message: 'email must be at most 255 characters' })
  email: string;

  /** User first name. */
  @ApiProperty({ example: 'Jane', description: 'User first name' })
  @IsString({ message: 'firstName must be a string' })
  @MaxLength(100, { message: 'firstName must be at most 100 characters' })
  firstName: string;

  /** User last name. */
  @ApiProperty({ example: 'Doe', description: 'User last name' })
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
  @ApiPropertyOptional({
    enum: UserRole,
    description: 'Initial role (null if omitted)',
  })
  @IsOptional()
  @IsEnum(UserRole, {
    message: `role must be one of: ${Object.values(UserRole).join(', ')}`,
  })
  role?: UserRole;

  /**
   * Program association — legacy single-value field.
   *
   * - When `role === PROGRAM_REP` and `programIds` is NOT provided, this
   *   field is REQUIRED (the `@ValidateIf` opens the `@IsInt` check).
   * - When `programIds` is provided this field is ignored — `programIds[0]`
   *   becomes the primary program.
   * - When `role` is anything else, validation of this field is skipped.
   *
   * Cross-field rules are enforced in the controller.
   */
  @ApiPropertyOptional({
    description:
      'Program ID (required for program_rep role when programIds is not provided)',
  })
  @ValidateIf(
    (o: CreateUserDto) =>
      o.role === UserRole.PROGRAM_REP && !o.programIds?.length,
  )
  @Type(() => Number)
  @IsInt({ message: 'programId must be a valid integer' })
  programId?: number;

  /**
   * Program memberships for a program_rep user (ordered).
   *
   * First element is the primary program (writes to `users.program_id` +
   * `user_programs.sort_order = 0`). Subsequent elements are stored in
   * submission order with ascending `sort_order`.
   *
   * When provided for a `program_rep`, `programIds` takes precedence over
   * the legacy `programId` field — `programId` is then derived as
   * `programIds[0]` by the service.
   *
   * DTO-level validators are permissive (array of positive ints when
   * present). The "must be non-empty when role = program_rep" rule and
   * the "must be absent for other roles" rule are enforced in
   * `UsersController.validateRoleConstraints`.
   */
  @ApiPropertyOptional({
    description:
      'Ordered list of program IDs (for program_rep role; first element is the primary program).',
    type: [Number],
    example: [3, 7],
  })
  @IsOptional()
  @IsArray({ message: 'programIds must be an array of integers' })
  @Type(() => Number)
  @IsInt({ each: true, message: 'programIds must contain integers only' })
  @IsPositive({
    each: true,
    message: 'programIds must contain positive integers only',
  })
  programIds?: number[];

  /**
   * Center memberships for a center_rep user (ordered).
   *
   * First element is the primary center (writes to `users.center_id` +
   * `user_centers.sort_order = 0`). Subsequent elements are stored in
   * submission order with ascending `sort_order`.
   *
   * DTO-level validators are permissive (array of positive ints when
   * present). The "must be non-empty when role = center_rep" rule and
   * the "must be absent for other roles" rule are enforced in
   * `UsersController.validateRoleConstraints` so the policy is shared
   * with `PATCH /users/:id`.
   */
  @ApiPropertyOptional({
    description:
      'Ordered list of center IDs (required for center_rep role, ≥ 1 entry; first element is the primary center).',
    type: [Number],
    example: [4, 11, 2],
  })
  @IsOptional()
  @IsArray({ message: 'centerIds must be an array of integers' })
  @Type(() => Number)
  @IsInt({ each: true, message: 'centerIds must contain integers only' })
  @IsPositive({
    each: true,
    message: 'centerIds must contain positive integers only',
  })
  centerIds?: number[];

  /**
   * Whether the account is active on creation. Defaults to `true` in the
   * service when omitted, which matches the column default.
   */
  @ApiPropertyOptional({
    description: 'Whether the account is active (default: true)',
    default: true,
  })
  @IsOptional()
  @IsBoolean({ message: 'isActive must be a boolean' })
  isActive?: boolean;
}
