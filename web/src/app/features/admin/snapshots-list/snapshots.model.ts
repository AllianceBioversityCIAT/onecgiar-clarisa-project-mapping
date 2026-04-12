/**
 * Represents a single published snapshot item as returned by the API list endpoint.
 * Contains aggregate data pre-computed by the backend (project count, total budget).
 */
export interface SnapshotListItem {
  id: number;
  versionLabel: string;
  description: string | null;
  publishedAt: string;
  publishedBy: { firstName: string; lastName: string };
  projectCount: number;
  totalBudget: number;
  isActive: boolean;
}

/**
 * Payload sent when an admin creates a new published snapshot.
 * versionLabel is required; description is optional.
 */
export interface CreateSnapshotRequest {
  versionLabel: string;
  description?: string;
}
