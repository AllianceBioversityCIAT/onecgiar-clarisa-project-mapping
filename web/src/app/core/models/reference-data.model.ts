/**
 * Reference data models for lookup entities: centers, programs, countries.
 * These are loaded once at startup and cached via signals in ReferenceDataService.
 */

export interface Center {
  id: string;
  clarisaId: number;
  code: string;
  name: string;
  acronym: string;
}

export interface Program {
  id: string;
  clarisaId: number;
  officialCode: string;
  name: string;
}

export interface Country {
  id: string;
  clarisaId: number;
  isoAlpha2: string;
  isoAlpha3: string;
  name: string;
  region: string;
}
