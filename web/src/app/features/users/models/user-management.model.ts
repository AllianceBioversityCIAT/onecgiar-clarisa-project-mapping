import { User } from '../../../core/models/user.model';

/**
 * Extends the base User with eagerly-loaded program and center relations.
 * These are returned by GET /api/users (admin endpoint).
 *
 * Multi-center support: `centerIds` and `centers` come from the base User
 * interface. The legacy `center` relation field is kept for backward
 * compatibility but may be null for multi-center reps — prefer `centers[0]`
 * for the primary center display.
 *
 * Multi-program support: `programIds` and `programs` come from the base User
 * interface. The legacy `program` relation field is kept for backward
 * compatibility — prefer `programs[0]` for the primary program display.
 */
export interface UserWithRelations extends User {
  program?: { id: number; name: string; officialCode: string } | null;
  center?: { id: number; name: string; acronym: string } | null;
}

/**
 * DTO for PATCH /api/users/:id — all fields are optional.
 * Only the fields supplied will be updated by the API.
 *
 * Multi-center: send `centerIds` (ordered array) instead of the legacy
 * `centerId`. The backend writes the first element as the primary center
 * (users.center_id) and atomically replaces the user_centers join rows.
 */
export interface UpdateUserDto {
  role?: User['role'];
  /** Integer FK to programs table; null clears the assignment. */
  programId?: number | null;
  /**
   * Ordered array of program IDs for program_rep users.
   * First element is the primary program. Pass null or omit to leave
   * memberships unchanged. Replaces the legacy `programId` field when provided.
   */
  programIds?: number[] | null;
  /**
   * Ordered array of center IDs for center_rep users.
   * First element is the primary center. Pass an empty array or omit to
   * clear all center assignments. Replaces the legacy `centerId` field.
   */
  centerIds?: number[];
  isActive?: boolean;
  /**
   * Pre-login only — backend accepts these only while `cognito_sub IS NULL`.
   * After first login Cognito overwrites names on every refresh, so the
   * server returns 400 if the admin tries to edit them post-login.
   */
  firstName?: string;
  lastName?: string;
}

/**
 * DTO for POST /api/users — creates a pre-provisioned user record with
 * cognito_sub = NULL. On first Cognito login the sub is backfilled by email.
 *
 * Multi-center: send `centerIds` (ordered array) for center_rep users.
 * First element becomes the primary center.
 */
export interface CreateUserDto {
  /** Must be unique; will be matched against Cognito email on first login. */
  email: string;
  firstName: string;
  lastName: string;
  /** Optional; admin can assign a role immediately or leave it blank. */
  role?: User['role'];
  /**
   * Required when role = 'program_rep' and programIds is not provided.
   * Kept for backward compatibility.
   */
  programId?: number;
  /**
   * Ordered array of program IDs; required when role = 'program_rep'.
   * First element is the primary program. Takes precedence over programId.
   */
  programIds?: number[];
  /**
   * Ordered array of center IDs; required when role = 'center_rep'.
   * First element is the primary center. Replaces the legacy `centerId`.
   */
  centerIds?: number[];
  /** Defaults to true when omitted. */
  isActive?: boolean;
}
