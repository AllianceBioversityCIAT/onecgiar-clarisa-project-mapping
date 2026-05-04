/**
 * Actor role recorded on audit rows (`mapping_negotiations.actor_role` and
 * the unified `audit_events.actor_role`).
 *
 * Mirrors the DB enum on those columns. Distinct from `UserRole` because the
 * audit tables did not historically support `admin` and now add
 * `workflow_admin` — and because we never want to log a `program_rep` as a
 * `center_rep` (or vice versa) just because the latter acted with elevated
 * rights.
 *
 * `SYSTEM` is used by the unified audit log only — it represents internal
 * service-driven writes (CLARISA sync, scheduled jobs, CSV import driver
 * runs) where there is no human actor. It is not a valid value on
 * `mapping_negotiations.actor_role`; do not assign it there.
 */
export enum ActorRole {
  CENTER_REP = 'center_rep',
  PROGRAM_REP = 'program_rep',
  ADMIN = 'admin',
  WORKFLOW_ADMIN = 'workflow_admin',
  UNIT_ADMIN = 'unit_admin',
  SYSTEM = 'system',
}
