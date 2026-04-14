/**
 * Lifecycle status of a project-to-program mapping in the negotiation workflow.
 *
 * - `draft`        – Center rep created the mapping but hasn't opened negotiation yet.
 * - `negotiating`  – Active back-and-forth between center and program.
 * - `agreed`       – Both center rep and program rep agreed on current terms.
 * - `locked`       – Center rep submitted the project round; mapping is frozen.
 * - `removed`      – Center rep excluded this program from the negotiation.
 */
export enum MappingStatus {
  DRAFT = 'draft',
  NEGOTIATING = 'negotiating',
  AGREED = 'agreed',
  LOCKED = 'locked',
  REMOVED = 'removed',
}
