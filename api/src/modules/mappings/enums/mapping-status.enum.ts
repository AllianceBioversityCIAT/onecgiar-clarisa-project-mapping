/**
 * Lifecycle status of a project-to-program mapping.
 *
 * - `pending`  – Submitted by a program representative, awaiting center review.
 * - `approved` – Approved by the center representative.
 * - `rejected` – Rejected by the center representative (includes a reason).
 */
export enum MappingStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
}
