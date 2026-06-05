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
  /**
   * Project-level lock event. Emitted once per active mapping when the
   * center rep (or admin / workflow_admin) flips `projects.negotiation_locked`
   * to true. Mirrors the per-mapping REOPENED row pattern so the timeline
   * shows the lock transition on every active mapping's thread.
   * `proposed_allocation` captures the mapping's current % at lock time.
   */
  LOCKED = 'locked',
  /**
   * Center-side rating-only edit on a mapping. Emitted when an
   * allocation-edit call changes complementarity or efficiency ratings
   * without changing the percentage. Keeps the qualitative rating history
   * visible alongside allocation moves. `justification` is null;
   * `proposed_allocation` is null (no % change).
   */
  RATING_UPDATED = 'rating_updated',
  /**
   * Program-rep / workflow-admin set or replaced the TOC contribution
   * links (AOWs, Outputs, Intermediate Outcomes) attached to the
   * mapping. Emitted once per `PATCH /:id/toc-links` call regardless
   * of whether the new set differs from the prior one — the row set is
   * always replaced atomically. `justification` and
   * `proposed_allocation` are null; the link rows themselves are the
   * payload.
   */
  TOC_UPDATED = 'toc_updated',
  /**
   * Workflow admin's final, binding decision on a mapping's allocation,
   * overriding the negotiation. Emitted once per non-removed mapping by
   * `POST /mappings/projects/:projectId/final-decision`. Carries the
   * admin's chosen `proposed_allocation` and a shared `justification`.
   * The mapping moves to `admin_decision` status and the project is
   * locked in the same transaction.
   */
  ADMIN_DECISION = 'admin_decision',
}
