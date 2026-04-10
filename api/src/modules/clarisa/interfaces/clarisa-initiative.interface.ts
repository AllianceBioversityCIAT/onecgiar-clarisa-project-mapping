/**
 * Shape of a single CGIAR entity returned by the
 * CLARISA /api/cgiar-entities?version=2 endpoint.
 *
 * Programs are filtered by entity_type: "Science programs",
 * "Accelerators", and "Scaling programs".
 */
export interface ClarisaCgiarEntity {
  code: string;
  name: string;
  compose_code: string;
  year: number;
  short_name: string | null;
  acronym: string | null;
  start_date: string;
  end_date: string;
  level: number;
  is_active: number;
  entity_type: {
    code: number;
    name: string;
  };
  portfolio: {
    code: number;
    name: string;
  };
}

/** @deprecated Use ClarisaCgiarEntity instead */
export type ClarisaInitiative = ClarisaCgiarEntity;
