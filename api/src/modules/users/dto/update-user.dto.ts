import {
  IsEnum,
  IsOptional,
  IsBoolean,
  IsInt,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';
import { UserRole } from '../enums/user-role.enum';

/**
 * DTO for admin user updates (PATCH /users/:id).
 *
 * All fields are optional — only supplied fields are updated.
 * Cross-field validation enforces role-specific constraints:
 * - program_rep must have programId, cannot have centerId
 * - center_rep must have centerId, cannot have programId
 * - admin should have neither programId nor centerId
 */
export class UpdateUserDto {
  /** New role to assign. */
  @IsOptional()
  @IsEnum(UserRole, {
    message: `role must be one of: ${Object.values(UserRole).join(', ')}`,
  })
  role?: UserRole | null;

  /** Program association (required for program_rep, null for others). */
  @IsOptional()
  @ValidateIf((o) => o.programId !== null)
  @Type(() => Number)
  @IsInt({ message: 'programId must be a valid integer' })
  programId?: number | null;

  /** Center association (required for center_rep, null for others). */
  @IsOptional()
  @ValidateIf((o) => o.centerId !== null)
  @Type(() => Number)
  @IsInt({ message: 'centerId must be a valid integer' })
  centerId?: number | null;

  /** Whether the user account is active. */
  @IsOptional()
  @IsBoolean({ message: 'isActive must be a boolean' })
  isActive?: boolean;
}
