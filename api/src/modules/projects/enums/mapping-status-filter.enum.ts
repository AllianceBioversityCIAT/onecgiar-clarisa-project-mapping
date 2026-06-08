/**
 * Derived per-project negotiation classification used by the projects list
 * filter. This is not stored in the database — it is computed on the fly
 * from `projects.negotiation_locked` plus the status of each row's
 * `project_mappings` (excluding `removed` mappings).
 *
 * Mutually exclusive; evaluation order matters:
 *   1. `admin_decision` — has any mapping in `admin_decision` status (a
 *                         workflow-admin final decision; these are always
 *                         locked, so this is carved out ahead of `locked`)
 *   2. `locked`         — project.negotiation_locked = 1
 *   3. `in_negotiation` — unlocked AND has mapping in `negotiating` or `agreed`
 *   4. `draft`          — unlocked AND only `draft` mappings exist
 *   5. `none`           — unlocked AND no non-removed mappings at all
 */
export enum MappingStatusFilter {
  LOCKED = 'locked',
  IN_NEGOTIATION = 'in_negotiation',
  DRAFT = 'draft',
  NONE = 'none',
  ADMIN_DECISION = 'admin_decision',
}
