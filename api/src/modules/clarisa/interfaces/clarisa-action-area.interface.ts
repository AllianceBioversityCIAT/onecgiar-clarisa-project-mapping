/**
 * Shape of a single action area object returned by the
 * CLARISA /api/action-areas endpoint.
 */
export interface ClarisaActionArea {
  id: number;
  name: string;
  description: string;
  color: string;
}
