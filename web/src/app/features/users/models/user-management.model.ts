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
