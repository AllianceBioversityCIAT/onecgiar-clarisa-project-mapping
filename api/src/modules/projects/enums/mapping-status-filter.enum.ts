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

/**
 * Attribute-flag values accepted alongside the lifecycle buckets in the
 * multi-select `mappingStatuses` filter. Each maps to one of the standalone
 * flag predicates (READY_TO_LOCK_SQL, PARTIALLY_ALLOCATED_SQL,
 * missingTocContributionSql, NEEDS_ASSISTANCE_SQL, and the strict
 * "actively negotiating" predicate). When supplied inside `mappingStatuses`
 * they OR with the selected lifecycle buckets and with each other; the
 * standalone boolean query params (`readyToLock`, `partiallyAllocated`, ...)
 * remain the AND variants.
 */
export enum MappingFlagFilter {
  NEGOTIATING = 'negotiating',
  READY_TO_LOCK = 'ready_to_lock',
  PARTIALLY_ALLOCATED = 'partially_allocated',
  MISSING_TOC = 'missing_toc',
  NEEDS_ASSISTANCE = 'needs_assistance',
}

/** Every value the multi-select `mappingStatuses` param accepts (buckets + flags). */
export const MAPPING_STATUSES_FILTER_VALUES: readonly string[] = [
  ...Object.values(MappingStatusFilter),
  ...Object.values(MappingFlagFilter),
];
