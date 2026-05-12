/**
 * Derived per-project negotiation classification used by the projects list
 * filter. This is not stored in the database — it is computed on the fly
 * from `projects.negotiation_locked` plus the status of each row's
 * `project_mappings` (excluding `removed` mappings).
 *
 * Mutually exclusive; evaluation order matters:
 *   1. `locked`         — project.negotiation_locked = 1
 *   2. `in_negotiation` — unlocked AND has mapping in `negotiating` or `agreed`
 *   3. `draft`          — unlocked AND only `draft` mappings exist
 *   4. `none`           — unlocked AND no non-removed mappings at all
 */
export enum MappingStatusFilter {
  LOCKED = 'locked',
  IN_NEGOTIATION = 'in_negotiation',
  DRAFT = 'draft',
  NONE = 'none',
}
