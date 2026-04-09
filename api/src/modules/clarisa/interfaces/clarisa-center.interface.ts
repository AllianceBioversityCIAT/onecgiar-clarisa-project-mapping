/**
 * Shape of a single center object returned by the CLARISA /api/centers endpoint.
 */
export interface ClarisaCenter {
  code: string;
  name: string;
  acronym: string;
  institutionId: number;
}
