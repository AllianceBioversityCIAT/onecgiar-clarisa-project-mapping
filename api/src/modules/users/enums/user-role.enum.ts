/**
 * Roles that can be assigned to a user by an administrator.
 *
 * - `admin`           – Full system access; can manage users, programs, and centers.
 * - `program_rep`     – Representative of a CGIAR research program.
 * - `center_rep`      – Representative of a CGIAR research center.
 * - `workflow_admin`  – System-office arbiter; full negotiation rights on every
 *                       project (counter-propose, agree, remove, add-program,
 *                       lock, reopen) without being scoped to a single center.
 *                       Cannot manage projects/users or run admin-only data
 *                       operations (CSV import, CLARISA sync).
 */
export enum UserRole {
  ADMIN = 'admin',
  PROGRAM_REP = 'program_rep',
  CENTER_REP = 'center_rep',
  WORKFLOW_ADMIN = 'workflow_admin',
}
