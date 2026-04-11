/**
 * Reference data models for lookup entities: centers, programs, countries.
 * These are loaded once at startup and cached via signals in ReferenceDataService.
 */

export interface Center {
  id: number;
  clarisaId: number;
  code: string;
  name: string;
  acronym: string;
}

export interface Program {
  id: number;
  clarisaId: number;
  officialCode: string;
  name: string;
}

export interface Country {
  id: number;
  clarisaId: number;
  isoAlpha2: string;
  isoAlpha3: string;
  name: string;
  region: string;
}
