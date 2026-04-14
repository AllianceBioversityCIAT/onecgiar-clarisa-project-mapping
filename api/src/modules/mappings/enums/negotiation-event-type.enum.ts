/**
 * Types of events that can occur in a mapping negotiation thread.
 *
 * Each event is an immutable audit entry stored in the `mapping_negotiations` table.
 */
export enum NegotiationEventType {
  INITIATED = 'initiated',
  COUNTER_PROPOSED = 'counter_proposed',
  AGREED = 'agreed',
  REOPENED = 'reopened',
  REMOVED = 'removed',
}
