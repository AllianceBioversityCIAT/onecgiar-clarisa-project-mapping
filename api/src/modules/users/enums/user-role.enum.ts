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
 * - `unit_admin`      – PPU/PCU editor; can edit a whitelisted set of project
 *                       metadata fields on any project regardless of lock
 *                       state, and can trigger published-snapshot republishes.
 *                       Cannot touch mappings, negotiation, allocations, or
 *                       Anaplan-sourced fields, and cannot manage users.
 */
export enum UserRole {
  ADMIN = 'admin',
  PROGRAM_REP = 'program_rep',
  CENTER_REP = 'center_rep',
  WORKFLOW_ADMIN = 'workflow_admin',
  UNIT_ADMIN = 'unit_admin',
}
