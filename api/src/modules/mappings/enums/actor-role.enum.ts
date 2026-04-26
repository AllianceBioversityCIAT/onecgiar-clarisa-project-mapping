/**
 * Actor role recorded on each `mapping_negotiations` audit row.
 *
 * Mirrors the DB enum on `mapping_negotiations.actor_role`. Distinct from
 * `UserRole` because the audit table did not historically support `admin`
 * and now adds `workflow_admin` — and because we never want to log a
 * `program_rep` as a `center_rep` (or vice versa) just because the latter
 * acted with elevated rights.
 */
export enum ActorRole {
  CENTER_REP = 'center_rep',
  PROGRAM_REP = 'program_rep',
  ADMIN = 'admin',
  WORKFLOW_ADMIN = 'workflow_admin',
}
