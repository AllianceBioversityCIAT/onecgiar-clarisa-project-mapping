/**
 * Shape of a single initiative (program) object returned by the
 * CLARISA /api/initiatives endpoint.
 */
export interface ClarisaInitiative {
  id: number;
  official_code: string;
  name: string;
}
