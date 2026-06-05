/**
 * Lifecycle status of a project-to-program mapping in the negotiation workflow.
 *
 * Lock state lives at the project level (`projects.negotiation_locked`), not
 * the mapping. An agreed mapping on a locked project IS the "locked" state.
 *
 * - `draft`          – Center rep created the mapping but hasn't opened negotiation yet.
 * - `negotiating`    – Active back-and-forth between center and program.
 * - `agreed`         – Both center rep and program rep agreed on current terms.
 * - `removed`        – Program was excluded from the negotiation.
 * - `admin_decision` – Workflow admin imposed a final allocation, overriding
 *                      the negotiation. Terminal + agreed-equivalent: the
 *                      project is locked on the same action. Rendered green.
 */
export enum MappingStatus {
  DRAFT = 'draft',
  NEGOTIATING = 'negotiating',
  AGREED = 'agreed',
  REMOVED = 'removed',
  ADMIN_DECISION = 'admin_decision',
}
