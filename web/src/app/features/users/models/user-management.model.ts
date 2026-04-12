import { User } from '../../../core/models/user.model';

/**
 * Extends the base User with eagerly-loaded program and center relations.
 * These are returned by GET /api/users (admin endpoint).
 */
export interface UserWithRelations extends User {
  program?: { id: number; name: string; officialCode: string } | null;
  center?: { id: number; name: string; acronym: string } | null;
}

/**
 * DTO for PATCH /api/users/:id — all fields are optional.
 * Only the fields supplied will be updated by the API.
 */
export interface UpdateUserDto {
  role?: User['role'];
  /** Integer FK to programs table; null clears the assignment. */
  programId?: number | null;
  /** Integer FK to centers table; null clears the assignment. */
  centerId?: number | null;
  isActive?: boolean;
}

/**
 * DTO for POST /api/users — creates a pre-provisioned user record with
 * cognito_sub = NULL. On first Cognito login the sub is backfilled by email.
 */
export interface CreateUserDto {
  /** Must be unique; will be matched against Cognito email on first login. */
  email: string;
  firstName: string;
  lastName: string;
  /** Optional; admin can assign a role immediately or leave it blank. */
  role?: User['role'];
  /** Required when role = 'program_rep'. */
  programId?: number;
  /** Required when role = 'center_rep'. */
  centerId?: number;
  /** Defaults to true when omitted. */
  isActive?: boolean;
}
