/**
 * Shape of a single country object returned by the CLARISA /api/countries endpoint.
 */
export interface ClarisaCountry {
  code: number;
  isoAlpha2: string;
  isoAlpha3: string;
  name: string;
  regionDTO: {
    name: string;
  };
}
