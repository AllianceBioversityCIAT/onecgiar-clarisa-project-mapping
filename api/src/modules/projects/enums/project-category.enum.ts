/**
 * Project funding category (app-level enum).
 *
 * Distinguishes restricted funds (earmarked for a specific purpose)
 * from unrestricted funds (flexible use). Values match the labels
 * used in the 4.1 Project Info CSV.
 */
export enum ProjectCategory {
  RESTRICTED = 'Restricted',
  UNRESTRICTED = 'Unrestricted',
}
