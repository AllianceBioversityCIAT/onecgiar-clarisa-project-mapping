/**
 * Nature of Funder taxonomy (app-level enum).
 *
 * Sourced from CGIAR PRMS 4.1 Project Info CSV. Values are stored
 * as plain strings in a `varchar(60)` column (no DB enum) so the
 * taxonomy can evolve without requiring a migration.
 */
export enum NatureOfFunder {
  GOVERNMENT_INSTITUTION = 'Government Institution',
  PRIVATE_SECTOR = 'Private Sector',
  FOUNDATION = 'Foundation',
  ACADEMIC_OR_RESEARCH_INSTITUTE = 'Academic or Research Institute',
  MULTI_FUNDER_PROGRAM = 'Multi-Funder Program',
  INTERNATIONAL_AND_REGIONAL_ORGANIZATIONS = 'International and Regional Organizations',
}
