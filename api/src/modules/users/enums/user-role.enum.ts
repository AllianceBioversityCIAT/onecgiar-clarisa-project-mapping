/**
 * Roles that can be assigned to a user by an administrator.
 *
 * - `admin`        – Full system access; can manage users, programs, and centers.
 * - `program_rep`  – Representative of a CGIAR research program.
 * - `center_rep`   – Representative of a CGIAR research center.
 */
export enum UserRole {
  ADMIN = 'admin',
  PROGRAM_REP = 'program_rep',
  CENTER_REP = 'center_rep',
}
