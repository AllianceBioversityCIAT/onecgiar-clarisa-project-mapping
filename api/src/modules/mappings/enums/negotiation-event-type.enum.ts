/**
 * Types of events that can occur in a mapping negotiation thread.
 *
 * Each event is an immutable audit entry stored in the `mapping_negotiations` table.
 *
 * - `flagged_for_assistance` — auto-emitted when a program rep submits a 2nd
 *   counter-proposal on the same mapping. Pairs with the `needs_assistance`
 *   boolean on `project_mappings` so the consolidated stream tells the story
 *   while the flag itself drives the workflow-admin queue/filtering.
 * - `negotiation_started` — emitted when the center rep bulk-promotes draft
 *   mappings to `negotiating` via `POST /mappings/projects/:projectId/start-negotiation`.
 *   Marks the moment the round becomes visible to program reps after a
 *   reopen-as-draft cycle.
 */
export enum NegotiationEventType {
  INITIATED = 'initiated',
  COUNTER_PROPOSED = 'counter_proposed',
  AGREED = 'agreed',
  REOPENED = 'reopened',
  REMOVED = 'removed',
  FLAGGED_FOR_ASSISTANCE = 'flagged_for_assistance',
  NEGOTIATION_STARTED = 'negotiation_started',
  /**
   * Program rep asks the center to remove the program from this project.
   * Carries the program rep's justification. The mapping stays in its
   * current status (draft / negotiating) until the center accepts (which
   * emits a `removed` event) or declines (which emits `removal_declined`).
   */
  REMOVAL_REQUESTED = 'removal_requested',
  /**
   * Center side (admin / center_rep / workflow_admin) declines a pending
   * removal request. The pending flag is cleared and the mapping continues
   * negotiation as before. Optional reason from the decliner is stored in
   * the event's justification.
   */
  REMOVAL_DECLINED = 'removal_declined',
}
