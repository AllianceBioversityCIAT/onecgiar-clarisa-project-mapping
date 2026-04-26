/**
 * Types of events that can occur in a mapping negotiation thread.
 *
 * Each event is an immutable audit entry stored in the `mapping_negotiations` table.
 *
 * - `flagged_for_assistance` — auto-emitted when a program rep submits a 2nd
 *   counter-proposal on the same mapping. Pairs with the `needs_assistance`
 *   boolean on `project_mappings` so the consolidated stream tells the story
 *   while the flag itself drives the workflow-admin queue/filtering.
 */
export enum NegotiationEventType {
  INITIATED = 'initiated',
  COUNTER_PROPOSED = 'counter_proposed',
  AGREED = 'agreed',
  REOPENED = 'reopened',
  REMOVED = 'removed',
  FLAGGED_FOR_ASSISTANCE = 'flagged_for_assistance',
}
